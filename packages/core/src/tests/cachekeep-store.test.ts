import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync } from 'node:zlib'
import {
  CacheKeepClaim,
  CacheKeepStore,
  legacyCacheKeepStoreDirectory,
} from '../cachekeep-store.ts'
import { withNativeLock } from '../native-lock-observer.ts'

const session = 'session'
const key = createHash('sha256').update(session).digest('hex')

function acceptedPolicy(time: number) {
  return {
    ownerSessionId: session,
    planned: false,
    lastRealRequestAt: time,
    warmsSinceLastRealRequest: 0,
    warmCostSoFar: 0,
    hasWarmed: false,
  }
}

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-claim-'))
  const makeStore = (onClaimLost?: (id: string) => void, now?: () => number) =>
    new CacheKeepStore({
      root,
      storageId: 'test',
      pluginVersion: 'test',
      sessionClaims: true,
      onClaimLost,
      now,
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

test('a scan restores a record committed and released after the scan began', async () => {
  const { root, store, makeStore, target } = await storeFixture()
  const start = Date.now()
  let now = start
  const scanning = makeStore(undefined, () => now)
  const restored: string[] = []
  try {
    store.changed({ ...target, policyState: acceptedPolicy(start) })
    await store.drain()
    await scanning.load(
      start,
      (entry) => {
        restored.push(entry.bodyText)
        return true
      },
      undefined,
      async () => {
        if (now === start) {
          now += 10_000
          store.changed({
            ...target,
            bodyText: '{"system":"newer"}',
            policyState: acceptedPolicy(now),
          })
          await store.drain()
          await store.releaseClaims(() => true)
        }
        return true
      },
    )
    expect(restored).toEqual(['{"system":"newer"}'])
    expect(await readdir(store.directory)).toEqual([`${key}.json.gz`])
  } finally {
    await scanning.releaseClaims(() => true)
    await store.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['lastRealRequestAt', 'lastWarmAt'] as const)(
  'restart validation tolerates small skew in %s but rejects a clock jump',
  async (field) => {
    const { root, store, makeStore, target } = await storeFixture()
    const now = Date.now()
    const scanning = makeStore(undefined, () => now)
    const restored: string[] = []
    try {
      for (const skew of [50, 30_000]) {
        store.changed({
          ...target,
          policyState: { ...acceptedPolicy(now), [field]: now + skew },
        })
        await store.drain()
        await store.releaseClaims(() => true)
        await scanning.load(now, (entry) => {
          restored.push(entry.id)
          return true
        })
        await scanning.releaseClaims(() => true)
      }
      expect(restored).toEqual([session])
      expect(await readdir(store.directory)).toEqual([])
    } finally {
      await store.releaseClaims(() => true)
      await scanning.releaseClaims(() => true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('a pending real claim cannot replace a newer peer commit', async () => {
  const { root, store, makeStore, target, claims } = await storeFixture()
  const now = Date.now()
  const lost: string[] = []
  const contender = makeStore((id) => lost.push(id))
  const older = {
    ...target,
    bodyText: '{"system":"older accepted body"}',
    policyState: acceptedPolicy(now - 2000),
  }
  const path = join(store.directory, `${key}.json.gz`)
  try {
    store.changed({ ...target, policyState: acceptedPolicy(now - 3000) })
    await store.drain()
    contender.changed(older)
    await contender.drain()
    expect(contender.isCommitted(session)).toBe(false)

    const newer = '{"system":"newer accepted body"}'
    store.changed({
      ...target,
      bodyText: newer,
      policyState: acceptedPolicy(now - 1000),
    })
    await store.drain()
    await store.releaseClaims(() => true)
    const saved = await readFile(path)
    expect(JSON.parse(gunzipSync(saved).toString()).bodyText).toBe(newer)

    expect(await contender.reserveWarm(older)).toBe('not-owner')
    expect(lost).toEqual([session])
    expect(await readFile(path)).toEqual(saved)
    expect(await readdir(claims)).not.toContain(`${key}.claim.json`)
  } finally {
    await contender.releaseClaims(() => true)
    await store.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['open', 'readFile', 'close'] as const)(
  'a transient restart record %s failure leaves the file for another scan',
  async (stage) => {
    const { root, store, makeStore, target, claims } = await storeFixture()
    const scanning = makeStore()
    const path = join(store.directory, `${key}.json.gz`)
    const restored: string[] = []
    const scan = () =>
      scanning.load(Date.now(), (entry) => {
        restored.push(entry.id)
        return true
      })
    const originalOpen = fs.open
    const failure = Object.assign(new Error('Temporary read failure'), {
      code: 'EIO',
    })
    try {
      store.changed(target)
      await store.drain()
      await store.releaseClaims(() => true)
      const saved = await readFile(path)
      let failed = false
      const opening = spyOn(fs, 'open').mockImplementation(
        async (filePath, ...args) => {
          if (filePath !== path || failed)
            return originalOpen(filePath, ...args)
          failed = true
          if (stage === 'open') throw failure
          const file = await originalOpen(filePath, ...args)
          if (stage === 'readFile')
            file.readFile = async () => {
              throw failure
            }
          else {
            const close = file.close.bind(file)
            file.close = async () => {
              await close()
              throw failure
            }
          }
          return file
        },
      )
      try {
        await scan()
      } finally {
        opening.mockRestore()
      }
      expect(failed).toBe(true)
      expect(restored).toEqual([])
      expect(await readdir(store.directory)).toContain(`${key}.json.gz`)
      expect(await readFile(path)).toEqual(saved)
      expect(await readdir(claims)).not.toContain(`${key}.claim.json`)
      await scan()
      expect(restored).toEqual([session])
    } finally {
      await scanning.releaseClaims(() => true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('a superseded warm reservation cannot verify a peer-owned claim', async () => {
  const { root, store, makeStore, target } = await storeFixture()
  const contender = makeStore()
  const accepted = { ...target, policyState: acceptedPolicy(Date.now()) }
  try {
    store.changed(accepted)
    await store.drain()
    contender.changed(accepted)
    await contender.drain()

    const reservation = contender.reserveWarm(accepted)
    contender.changed(
      {
        ...accepted,
        policyState: { ...accepted.policyState, prefixTokens: 1000 },
      },
      false,
    )
    expect(await reservation).toBe('ownership-unverified')
    expect(store.isCommitted(session)).toBe(true)
    expect(contender.isCommitted(session)).toBe(false)
  } finally {
    await contender.drain()
    await contender.releaseClaims(() => true)
    await store.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
})

test('a restart scan directory read failure cannot authorize a warm', async () => {
  const { root, store, makeStore, target } = await storeFixture()
  const contender = makeStore()
  try {
    store.changed(target)
    await store.drain()
    const enumerate = fs.readdir
    const reading = spyOn(fs, 'readdir').mockImplementation(((
      path,
      ...args
    ) => {
      if (path === contender.directory)
        throw new Error('Temporary readdir failure')
      return Reflect.apply(enumerate, fs, [path, ...args])
    }) as typeof fs.readdir)
    try {
      await contender.load(Date.now(), () => true)
    } finally {
      reading.mockRestore()
    }
    expect(contender.isMemoryOnly).toBe(false)
    expect(await contender.reserveWarm(target)).toBe('ownership-unverified')
  } finally {
    await store.releaseClaims(() => true)
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

test('a second claim lock timeout keeps the real turn available for the next reservation', async () => {
  const { root, makeStore, target, claims } = await storeFixture()
  const lost: string[] = []
  const store = makeStore((id) => lost.push(id))
  const setup = new CacheKeepClaim(claims, session)
  expect(await setup.acquire()).toBe(true)
  await setup.release()
  const unlock = await holdClaimLock(claims)
  try {
    store.changed(target)
    await store.drain()
    expect(await readdir(store.directory)).toEqual([])
    expect(await store.reserveWarm(target)).toBe('ownership-unverified')
    expect(lost).toEqual([])
    expect(await readdir(store.directory)).toEqual([])
    await unlock()
    expect(await store.reserveWarm(target)).toBe(true)
    expect(store.isCommitted(session)).toBe(true)
  } finally {
    await unlock()
    await store.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
}, 8000)

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

test('an unsafe deletion tombstone skips restore without erasing the record', async () => {
  const { root, store, makeStore, target } = await storeFixture()
  const restoring = makeStore()
  const path = join(store.directory, `${key}.json.gz`)
  const tombstone = join(store.directory, `${key}.deleted`)
  const restored: string[] = []
  const load = () =>
    restoring.load(Date.now(), (entry) => {
      restored.push(entry.id)
      return true
    })
  try {
    store.changed(target)
    await store.drain()
    await store.releaseClaims(() => true)
    const bytes = await readFile(path)
    await mkdir(tombstone, { mode: 0o700 })

    await load()
    expect(restored).toEqual([])
    expect(await readdir(store.directory)).toContain(`${key}.json.gz`)
    expect(await readFile(path)).toEqual(bytes)

    await rm(tombstone, { recursive: true })
    await load()
    expect(restored).toEqual([session])
  } finally {
    await restoring.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
})

test('a deletion still blocks an older accepted record when its file mtime is wrong', async () => {
  const { root, store, makeStore, target, claims } = await storeFixture()
  const restoring = makeStore()
  const restored: string[] = []
  try {
    const acceptedAt = Date.now() - 1000
    store.changed({ ...target, lastTouchAt: acceptedAt })
    await store.drain()
    await store.releaseClaims(() => true)
    const path = join(store.directory, `${key}.json.gz`)
    const saved = await readFile(path)
    store.removed(session, 'deleted')
    await store.drain()
    const tombstone = join(store.directory, `${key}.deleted`)
    const beforeAcceptance = new Date(acceptedAt - 1000)
    await utimes(tombstone, beforeAcceptance, beforeAcceptance)
    await writeFile(path, saved, { mode: 0o600 })

    await restoring.load(Date.now(), (entry) => {
      restored.push(entry.id)
      return true
    })
    expect(restored).toEqual([])
    expect(await readdir(store.directory)).toEqual([`${key}.deleted`])
    expect(await readdir(claims)).not.toContain(`${key}.claim.json`)
  } finally {
    await restoring.releaseClaims(() => true)
    await rm(root, { recursive: true, force: true })
  }
})

test('restart cleanup sweeps deletion tombstones only after 24 hours', async () => {
  const { root, makeStore } = await storeFixture()
  const deletedAt = Date.now()
  let now = deletedAt
  const store = makeStore(undefined, () => now)
  try {
    store.removed(session, 'deleted')
    await store.drain()
    const sweeper = makeStore(undefined, () => now)
    const sweep = () =>
      sweeper.load(
        now,
        () => {
          throw new Error('Tombstones are not restart records')
        },
        undefined,
        undefined,
        'sweep',
      )
    const tombstone = `${key}.deleted`
    await sweep()
    expect(await readdir(store.directory)).toEqual([tombstone])
    expect(
      JSON.parse(await readFile(join(store.directory, tombstone), 'utf8')),
    ).toEqual({ deletedAt })
    now += 25 * 60 * 60 * 1000
    await sweep()
    expect(await readdir(store.directory)).toEqual([])

    // Older writers left the deletion time in the filesystem metadata only.
    const legacy = join(store.directory, tombstone)
    await writeFile(legacy, '{}', { mode: 0o600 })
    await utimes(legacy, new Date(now), new Date(now))
    await sweep()
    expect(await readdir(store.directory)).toEqual([tombstone])
    await utimes(legacy, new Date(deletedAt), new Date(deletedAt))
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
