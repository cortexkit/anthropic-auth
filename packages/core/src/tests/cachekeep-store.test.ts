import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CacheKeepClaim,
  CacheKeepStore,
  legacyCacheKeepStoreDirectory,
} from '../cachekeep-store.ts'
import { withNativeLock } from '../native-lock-observer.ts'

const session = 'session'
const key = createHash('sha256').update(session).digest('hex')

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const makeStore = (onClaimLost?: (id: string) => void) =>
    new CacheKeepStore({
      root,
      storageId: 'test',
      pluginVersion: 'test',
      sessionClaims: true,
      onClaimLost,
    })
  const store = makeStore()
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
  return { root, store, makeStore, target, claims }
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

test('a real turn claims again after a peer took over and released a restore-only claim', async () => {
  const { root, store: seed, makeStore, target, claims } = await storeFixture()
  const lost: string[] = []
  const restoring = makeStore((id) => lost.push(id))
  const peer = new CacheKeepClaim(claims, session)
  try {
    seed.changed(target)
    await seed.drain()
    await seed.releaseClaims(() => true)
    const restored: string[] = []
    await restoring.load(Date.now(), (entry) => {
      restored.push(entry.id)
      return true
    })
    expect(restored).toEqual([session])
    expect(await peer.acquire()).toBe(true)
    await peer.release()

    restoring.changed({ ...target, bodyText: '{"model":"next"}' })
    await restoring.drain()
    expect(lost).toEqual([])
    expect(restoring.isCommitted(session)).toBe(true)
    expect(await peer.acquire()).toBe(false)
  } finally {
    await peer.release()
    await restoring.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
})

for (const deletion of ['owner', 'non-owner'] as const) {
  test(`a pending real turn cannot resurrect a record deleted by the ${deletion}`, async () => {
    const {
      root,
      store: owner,
      makeStore,
      target,
      claims,
    } = await storeFixture()
    const lost: string[] = []
    const contender = makeStore((id) => lost.push(id))
    try {
      const lastRealRequestAt = Date.now() - 1000
      const beforeDeletion = {
        ...target,
        lastTouchAt: lastRealRequestAt,
        policyState: {
          ownerSessionId: session,
          planned: false,
          lastRealRequestAt,
          warmsSinceLastRealRequest: 0,
          warmCostSoFar: 0,
          hasWarmed: false,
        },
      }
      owner.changed(beforeDeletion)
      await owner.drain()
      contender.changed(beforeDeletion)
      await contender.drain()
      expect(owner.isCommitted(session)).toBe(true)
      expect(contender.isCommitted(session)).toBe(false)
      const deleting = deletion === 'owner' ? owner : makeStore()
      deleting.removed(session, 'deleted')
      await deleting.drain()
      if (deleting !== owner) await owner.reserveWarm(beforeDeletion)
      expect(await readdir(claims)).not.toContain(`${key}.claim.json`)
      expect(await readdir(owner.directory)).not.toContain(`${key}.json.gz`)

      // A later cache touch must not make the older accepted body new again.
      expect(
        await contender.reserveWarm({
          ...beforeDeletion,
          lastTouchAt: Date.now() + 1000,
          lastTouchKind: 'warm',
        }),
      ).toBe('not-owner')
      expect(lost).toEqual([session])
      expect(await readdir(claims)).not.toContain(`${key}.claim.json`)
      const tombstone = `${key}.deleted`
      expect(await readdir(owner.directory)).toEqual([tombstone])
      expect((await stat(join(owner.directory, tombstone))).mode & 0o777).toBe(
        0o600,
      )

      contender.changed({ ...target, lastTouchAt: Date.now() + 1000 })
      await contender.drain()
      expect(contender.isCommitted(session)).toBe(true)
    } finally {
      await contender.releaseClaims(() => true)
      await owner.releaseClaims(() => true)
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('a deletion delayed by the claim lock is retried', async () => {
  const { root, store, target, claims } = await storeFixture()
  store.changed(target)
  await store.drain()
  const unlock = await holdClaimLock(claims)
  try {
    store.removed(session, 'deleted')
    // Hold until the first attempt times out, then allow the retry to commit.
    await store.drain()
    expect(await readdir(store.directory)).toContain(`${key}.json.gz`)
    await unlock()
    for (
      let remaining = 20;
      remaining && (await readdir(store.directory)).includes(`${key}.json.gz`);
      remaining--
    )
      await delay(100)
    expect(await readdir(store.directory)).toEqual([`${key}.deleted`])
  } finally {
    await unlock()
    await store.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
}, 8000)

test('restart cleanup sweeps deletion tombstones only after 24 hours', async () => {
  const { root, store, makeStore } = await storeFixture()
  try {
    store.removed(session, 'deleted')
    await store.drain()
    const sweeper = makeStore()
    const sweep = () =>
      sweeper.load(
        Date.now(),
        () => {
          throw new Error('Tombstones are not restart records')
        },
        undefined,
        undefined,
        'sweep',
      )
    const tombstone = `${key}.deleted`
    const at = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await sweep()
    expect(await readdir(store.directory)).toEqual([tombstone])
    await utimes(join(store.directory, tombstone), at, at)
    await sweep()
    expect(await readdir(store.directory)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a deletion tombstone does not block unrelated OpenCode 2 legacy migration', async () => {
  const { root, store, makeStore, target } = await storeFixture()
  const other = 'other-session'
  try {
    store.changed(target)
    store.changed({ ...target, id: other })
    await store.drain()
    await store.releaseClaims(() => true)
    const legacy = legacyCacheKeepStoreDirectory('test', root)
    await mkdir(legacy, { mode: 0o700 })
    for (const name of await readdir(store.directory))
      await rename(join(store.directory, name), join(legacy, name))
    store.removed(session, 'deleted')
    await store.drain()

    const restored: string[] = []
    const loading = makeStore()
    await loading.load(Date.now(), (entry) => {
      restored.push(entry.id)
      return true
    })
    await loading.releaseClaims(() => true)
    expect(restored).toEqual([other])
    expect(await readdir(legacy)).toEqual([])
    expect(await readdir(store.directory)).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
