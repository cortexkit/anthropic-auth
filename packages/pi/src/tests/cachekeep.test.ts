import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cacheKeepStoreDirectory,
  createEmptyStorage,
  type HolderLiveness,
  type NativeAccountSnapshot,
} from '@cortexkit/anthropic-auth-core'
import { PiCacheKeep } from '../cachekeep.ts'
import { PiCacheKeepClaim } from '../cachekeep-claim.ts'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-cachekeep-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let now = Date.now()
  const snapshot: NativeAccountSnapshot = {
    mode: 'local',
    settings: {},
    accounts: [
      {
        id: 'oauth',
        source: 'local',
        type: 'oauth',
        enabled: true,
        accountIdentity: 'account-uuid',
        binding: {
          kind: 'local',
          storageId: 'pool',
          rowId: 'row',
          credentialEpoch: 1,
        },
      },
    ],
    policyStorage: {
      ...createEmptyStorage(),
      cacheKeep: { enabled: true, always: true },
      claudeCache: { enabled: true, mode: 'hybrid' },
    },
  }
  const sends: Array<{ session: string; body: Record<string, unknown> }> = []
  const delays: number[] = []
  const create = (liveness?: HolderLiveness) => {
    const timers = new Map<object, () => unknown>()
    const process = new PiCacheKeep(
      {
        now: () => now,
        loadStorage: async () => snapshot.policyStorage,
        setIntervalImpl: ((callback: () => unknown) => {
          const timer = { unref() {} }
          timers.set(timer, callback)
          return timer
        }) as unknown as typeof setInterval,
        clearIntervalImpl: ((timer: object) => {
          timers.delete(timer)
        }) as unknown as typeof clearInterval,
        prepareHeaders: (headers, target) => {
          headers.set('x-session', target.id)
          headers.set('authorization', 'Bearer current-credential')
          return headers
        },
        fetchImpl: (async (_url, init) => {
          sends.push({
            session: new Headers(init?.headers).get('x-session')!,
            body: JSON.parse(String(init?.body)),
          })
          return new Response('{"usage":{"cache_read_input_tokens":100}}', {
            status: 200,
          })
        }) as typeof fetch,
      },
      {
        read: async () => snapshot,
        storageId: async () => 'shared-storage',
        persistence: { root },
        liveness,
        restoreDelay: async (ms) => {
          delays.push(ms)
        },
      },
    )
    cleanups.push(() => process.stop())
    return {
      process,
      tick: async () => {
        for (const callback of [...timers.values()]) await callback()
      },
    }
  }
  const input = (sessionId: string, content = 'original prefix') => ({
    sessionId,
    accountStoragePath: 'pi-storage',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    bodyText: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      system: [
        {
          type: 'text',
          text: content,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    }),
    storage: snapshot.policyStorage,
    cacheMode: 'hybrid',
    oauthAccountId: 'oauth',
    oauthAccountIdentity: 'account-uuid',
  })
  return {
    root,
    snapshot,
    create,
    input,
    sends,
    delays,
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('a fresh Pi process restores its idle session and warms without a request', async () => {
  const f = await fixture()
  const first = f.create()
  await first.process.startSession('pi-storage', 'session-S')
  await first.process.trackAccepted(f.input('session-S'), f.snapshot)
  await first.process.stop()

  f.advance(55 * 60_000)
  const second = f.create()
  await second.process.startSession('pi-storage', 'session-S')
  expect(second.process.manager.trackedSessions()).toHaveLength(1)
  expect(second.process.manager.registrySessions()[0]?.lastTouchKind).toBe(
    'response',
  )
  f.advance(30_000)
  await second.tick()
  expect(f.sends).toHaveLength(1)
  expect(f.sends[0]?.session).toBe('session-S')
  expect(f.sends[0]?.body.max_tokens).toBe(0)
  expect(f.delays).toHaveLength(1)
  expect(f.delays[0]).toBeGreaterThanOrEqual(1000)
  expect(f.delays[0]).toBeLessThan(3000)
})

test('two live Pi processes cannot restore or track the same session', async () => {
  const f = await fixture()
  const seed = f.create()
  await seed.process.trackAccepted(f.input('session-S'), f.snapshot)
  await seed.process.stop()
  f.advance(55 * 60_000)
  const one = f.create()
  const two = f.create()
  await Promise.all([
    one.process.startSession('pi-storage', 'session-S'),
    two.process.startSession('pi-storage', 'session-S'),
  ])
  const nonOwner = one.process.manager.trackedCount() ? two : one
  await nonOwner.process.trackAccepted(
    f.input('session-S', 'another accepted body'),
    f.snapshot,
  )
  expect(
    one.process.manager.trackedCount() + two.process.manager.trackedCount(),
  ).toBe(1)
  f.advance(30_000)
  await Promise.all([one.tick(), two.tick()])
  expect(f.sends).toHaveLength(1)
})

test('opening another Pi session leaves unresumed records untouched until expiry', async () => {
  const f = await fixture()
  const seed = f.create()
  await seed.process.trackAccepted(f.input('session-A'), f.snapshot)
  await seed.process.stop()
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const [file] = (await readdir(directory)).filter((name) =>
    name.endsWith('.gz'),
  )
  const original = await readFile(join(directory, file!))
  const other = f.create()
  await other.process.startSession('pi-storage', 'session-B')
  expect(other.process.manager.trackedCount()).toBe(0)
  expect(await readFile(join(directory, file!))).toEqual(original)
  expect(f.sends).toEqual([])
  f.advance(61 * 60_000)
  await other.tick()
  expect(
    (await readdir(directory)).filter((name) => name.endsWith('.gz')),
  ).toEqual([])
})

test.each([
  'changed-login',
  'disabled-account',
  'foreign-account',
  'expired',
] as const)('Pi drops %s restart records', async (reason) => {
  const f = await fixture()
  const seed = f.create()
  await seed.process.trackAccepted(f.input('session-S'), f.snapshot)
  await seed.process.stop()
  if (reason === 'changed-login')
    f.snapshot.accounts[0]!.binding = {
      ...f.snapshot.accounts[0]!.binding!,
      credentialEpoch: 2,
    }
  if (reason === 'disabled-account') f.snapshot.accounts[0]!.enabled = false
  if (reason === 'foreign-account')
    f.snapshot.accounts[0]!.accountIdentity = 'foreign-uuid'
  if (reason === 'expired') f.advance(61 * 60_000)
  const next = f.create()
  await next.process.startSession('pi-storage', 'session-S')
  expect(next.process.manager.trackedCount()).toBe(0)
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  expect(
    (await readdir(directory)).filter((name) => name.endsWith('.gz')),
  ).toEqual([])
})

test('Pi drains the latest accepted body on shutdown and removes stopped targets', async () => {
  const f = await fixture()
  const first = f.create()
  await first.process.trackAccepted(f.input('session-S'), f.snapshot)
  await first.process.trackAccepted(
    f.input('session-S', 'latest prefix'),
    f.snapshot,
  )
  await first.process.stop()
  const second = f.create()
  await second.process.startSession('pi-storage', 'session-S')
  expect(
    second.process.manager.trackedRequest('session-S')?.bodyText,
  ).toContain('latest prefix')
  second.process.manager.untrack('session-S')
  await second.process.stop()
  const third = f.create()
  await third.process.startSession('pi-storage', 'session-S')
  expect(third.process.manager.trackedCount()).toBe(0)
})

test('a reused pid cannot hold a Pi session and an old release cannot remove its successor claim', async () => {
  const f = await fixture()
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const old = new PiCacheKeepClaim(directory, 'S', {
    liveness: { pidAlive: () => true, incarnation: async () => 'old-start' },
  })
  const next = new PiCacheKeepClaim(directory, 'S', {
    liveness: { pidAlive: () => true, incarnation: async () => 'new-start' },
  })
  expect(await old.acquire()).toBe(true)
  expect(await next.acquire()).toBe(true)
  await old.release()
  const contender = new PiCacheKeepClaim(directory, 'S', {
    liveness: { pidAlive: () => true, incarnation: async () => 'new-start' },
  })
  expect(await contender.acquire()).toBe(false)
  await next.release()
  expect(await contender.acquire()).toBe(true)
  await contender.release()
})

test('a Pi owner waits out a sweep and restores without another turn or request', async () => {
  const f = await fixture()
  const seed = f.create()
  await seed.process.trackAccepted(f.input('session-S'), f.snapshot)
  await seed.process.stop()
  f.advance(55 * 60_000)
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const hash = createHash('sha256').update('session-S').digest('hex')
  const sweep = new PiCacheKeepClaim(directory, hash, {
    sessionHash: true,
    liveness: { pidAlive: () => true, incarnation: async () => 'same-start' },
  })
  expect(await sweep.acquire()).toBe(true)
  let observed = () => {}
  const sawSweep = new Promise<void>((resolve) => {
    observed = resolve
  })
  const owner = f.create({
    pidAlive: () => true,
    incarnation: async () => {
      observed()
      return 'same-start'
    },
  })
  const starting = owner.process.startSession('pi-storage', 'session-S')
  try {
    await sawSweep
    expect(owner.process.manager.trackedCount()).toBe(0)
  } finally {
    await sweep.release()
  }
  await starting
  expect(owner.process.manager.trackedCount()).toBe(1)
  await owner.tick()
  expect(f.sends).toHaveLength(1)
})

test('a failed live-owner claim is retried on the next Pi session event', async () => {
  const f = await fixture()
  const first = f.create()
  await first.process.trackAccepted(f.input('session-S'), f.snapshot)
  const next = f.create()
  await next.process.startSession('pi-storage', 'session-S')
  expect(next.process.manager.trackedCount()).toBe(0)
  await first.process.stop()
  await next.process.startSession('pi-storage', 'session-S')
  expect(next.process.manager.trackedCount()).toBe(1)
  f.advance(55 * 60_000)
  await next.tick()
  expect(f.sends).toHaveLength(1)
})

test('shutdown saves an accepted body queued before a sweep releases its claim', async () => {
  const f = await fixture()
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const hash = createHash('sha256').update('session-S').digest('hex')
  const sweep = new PiCacheKeepClaim(directory, hash, {
    sessionHash: true,
    liveness: { pidAlive: () => true, incarnation: async () => 'same-start' },
  })
  expect(await sweep.acquire()).toBe(true)
  let observed = () => {}
  const sawSweep = new Promise<void>((resolve) => {
    observed = resolve
  })
  const first = f.create({
    pidAlive: () => true,
    incarnation: async () => {
      observed()
      return 'same-start'
    },
  })
  const acceptedAt = f.now()
  const tracking = first.process.trackAccepted(
    f.input('session-S', 'queued accepted body'),
    f.snapshot,
  )
  const stopping = first.process.stop()
  try {
    await sawSweep
    f.advance(10_000)
  } finally {
    await sweep.release()
  }
  await Promise.all([tracking, stopping])
  const next = f.create()
  await next.process.startSession('pi-storage', 'session-S')
  const target = next.process.manager.trackedRequest('session-S')
  expect(target?.bodyText).toContain('queued accepted body')
  expect(target?.cacheExpiresAt).toBe(acceptedAt + 3_600_000)
  expect(next.process.manager.registrySessions()[0]?.lastTouchAt).toBe(
    acceptedAt,
  )
})

test('planned child warms override local off and preserve the 24-count across Pi restart', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  globals[key] = () => ({ cache: () => ({ ttl: 'long', keep_warm: 'always' }) })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
  const f = await fixture()
  f.snapshot.policyStorage.cacheKeep = { enabled: false, subagents: false }
  f.snapshot.policyStorage.claudeCache = { enabled: false }
  const first = f.create()
  await first.process.trackAccepted(
    { ...f.input('planned-pi'), isSubagent: true },
    f.snapshot,
  )
  for (let n = 0; n < 23; n++) {
    f.advance(3_570_000)
    await first.tick()
  }
  expect(f.sends).toHaveLength(23)
  await first.process.stop()
  const resumed = f.create()
  await resumed.process.startSession('pi-storage', 'planned-pi')
  f.advance(3_570_000)
  await resumed.tick()
  expect(f.sends).toHaveLength(24)
  f.advance(3_570_000)
  await resumed.tick()
  expect(f.sends).toHaveLength(24)
})
