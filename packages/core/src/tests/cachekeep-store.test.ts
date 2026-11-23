import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CacheKeepClaim, CacheKeepStore } from '../cachekeep-store.ts'
import { withNativeLock } from '../native-lock-observer.ts'

const session = 'session'
const key = createHash('sha256').update(session).digest('hex')

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const store = new CacheKeepStore({
    root,
    storageId: 'test',
    pluginVersion: 'test',
    sessionClaims: true,
  })
  const now = Date.now()
  const target = {
    id: session,
    bodyText: '{}',
    url: 'https://api.anthropic.com/v1/messages',
    cacheExpiresAt: now + 60_000,
    nextPrewarmAt: now,
    oauthAccountIdentity: 'account',
    isSubagent: false,
    bodyBytes: 2,
    headers: {},
    consecutiveFailures: 0,
    dayKey: 'test',
  }
  const claims = `${store.directory}.claims`
  return { root, store, target, claims }
}

async function holdClaimLock(directory: string) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const holding = withNativeLock(
    join(directory, `${key}.claim.json`),
    { name: 'cachekeep-session', ttlMs: 10_000, timeoutMs: 2000, renew: true },
    async () => {
      entered.resolve()
      await released.promise
    },
  )
  await Promise.race([entered.promise, holding])
  return async () => {
    released.resolve()
    await holding
  }
}

test('clear removes records and claims owned by the calling store', async () => {
  const { root, store, target, claims } = await storeFixture()
  try {
    store.changed(target)
    await store.drain()
    expect(await readdir(store.directory)).toContain(`${key}.json.gz`)
    expect(await readdir(claims)).toContain(`${key}.claim.json`)
    store.clear()
    await store.drain()
    expect(await readdir(store.directory)).toEqual([])
    expect(await readdir(claims)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a warm reservation reopens a claim after the initial lock times out', async () => {
  const { root, store, target, claims } = await storeFixture()
  const setup = new CacheKeepClaim(claims, session)
  expect(await setup.acquire()).toBe(true)
  await setup.release()
  const unlock = await holdClaimLock(claims)
  try {
    store.changed(target)
    await store.drain()
    expect(await readdir(store.directory)).toEqual([])
    await unlock()
    expect(await store.reserveWarm(target)).toBe(true)
    expect(await readdir(store.directory)).toContain(`${key}.json.gz`)
  } finally {
    await unlock()
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed release can be retried while the original claimant is alive', async () => {
  const { root, store, target, claims } = await storeFixture()
  store.changed(target)
  await store.drain()
  const contender = new CacheKeepClaim(claims, session)
  const unlock = await holdClaimLock(claims)
  try {
    await store.releaseClaims(() => true)
    expect(await readdir(claims)).toContain(`${key}.claim.json`)
    await unlock()
    await store.releaseClaims(() => true)
    expect(await contender.acquire()).toBe(true)
  } finally {
    await unlock()
    await contender.release()
    await rm(root, { recursive: true, force: true })
  }
})

test('a session claim stops waiting on a stranded live sweep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const sweep = new CacheKeepClaim(root, session, { purpose: 'sweep' })
  const claimant = new CacheKeepClaim(root, session)
  const deadline = new AbortController()
  let waiting: Promise<boolean> | undefined
  try {
    expect(await sweep.acquire()).toBe(true)
    waiting = claimant.acquire()
    expect(
      await Promise.race([
        waiting,
        delay(3500, 'still waiting', { signal: deadline.signal }),
      ]),
    ).toBe(false)
    expect(await sweep.isCurrent()).toBe(true)
  } finally {
    deadline.abort()
    await sweep.release()
    await waiting
    await claimant.release()
    await rm(root, { recursive: true, force: true })
  }
})

test('a forward wall-clock step during publication does not prevent claiming a live session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const realNow = Date.now
  let offset = 0
  const claim = new CacheKeepClaim(root, 'session', {
    liveness: {
      pidAlive: (pid) => pid === process.pid,
      incarnation: async () => {
        // Step the wall clock while the process is reading its own identity.
        offset = 30_000
        return 'live-process'
      },
    },
  })
  try {
    Date.now = () => realNow() + offset
    expect(await claim.acquire()).toBe(true)
    expect(await claim.isCurrent()).toBe(true)
  } finally {
    Date.now = realNow
    try {
      await claim.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('a forward wall-clock step cannot displace a live claim without an incarnation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const realNow = Date.now
  const liveness = {
    pidAlive: (pid: number) => pid === process.pid,
    incarnation: async () => null,
    uptime: () => 60,
  }
  const holder = new CacheKeepClaim(root, 'session', { liveness })
  const contender = new CacheKeepClaim(root, 'session', { liveness })
  try {
    expect(await holder.acquire()).toBe(true)
    expect(await contender.acquire()).toBe(false)
    // Correct a wall clock that was ten minutes slow shortly after boot.
    Date.now = () => realNow() + 10 * 60_000
    expect(await holder.isCurrent()).toBe(true)
    expect(await contender.acquire()).toBe(false)
    expect(await holder.isCurrent()).toBe(true)
  } finally {
    Date.now = realNow
    try {
      await contender.release()
      await holder.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
