import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  CacheKeepClaim,
  type CacheKeepManager,
  cacheKeepStoreDirectory,
  createEmptyStorage,
  type HolderLiveness,
  type NativeAccountSnapshot,
} from '@cortexkit/anthropic-auth-core'
import { PiCacheKeep } from '../cachekeep.ts'

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
  const create = (
    liveness?: HolderLiveness,
    send?: (init?: RequestInit) => Promise<Response>,
    managerOptions: Partial<
      ConstructorParameters<typeof CacheKeepManager>[0]
    > = {},
  ) => {
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
          if (send) return send(init)
          return new Response('{"usage":{"cache_read_input_tokens":100}}', {
            status: 200,
          })
        }) as typeof fetch,
        ...managerOptions,
      },
      {
        read: async () => snapshot,
        routing: () => ({ snapshot }),
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

async function restoredPlannedFixture(adopt = true) {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  const reports: { kind: string; reason?: string }[] = []
  globals[key] = () => ({
    cache: () => ({ ttl: 'long', keep_warm: 'always' }),
    report: (payload: (typeof reports)[number]) => reports.push(payload),
  })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
  const f = await fixture()
  const first = f.create()
  await first.process.startSession('pi-storage', 'session-S')
  await first.process.trackAccepted(f.input('session-S'), f.snapshot)
  await first.process.stop()
  const active = f.create()
  if (adopt) await active.process.startSession('pi-storage', 'session-S')
  return { ...f, active, reports }
}

test('a first Pi track saves its accepted target identity on the first change', async () => {
  const f = await fixture()
  const active = f.create()
  const store = await Reflect.get(active.process, 'store').call(
    active.process,
    'pi-storage',
  )
  const saving = spyOn(store, 'changed')
  try {
    expect(
      (await active.process.trackAccepted(f.input('session-S'), f.snapshot))
        ?.tracked,
    ).toBe(true)
    expect(saving.mock.calls).toHaveLength(1)
    expect(saving.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        oauthAccountIdentity: JSON.stringify([
          'local',
          'account-uuid',
          null,
          'pool',
          'row',
          1,
        ]),
      }),
    )
    await store.drain()
    const [name] = (await readdir(store.directory)).filter((file) =>
      file.endsWith('.json.gz'),
    )
    expect(
      JSON.parse(
        gunzipSync(await readFile(join(store.directory, name!))).toString(),
      ).oauthAccountIdentity,
    ).toBe(JSON.stringify(['local', 'account-uuid', null, 'pool', 'row', 1]))
  } finally {
    saving.mockRestore()
  }
})

test('a superseded Pi acceptance cannot relabel the newer account on disk', async () => {
  const f = await fixture()
  f.snapshot.accounts.push({
    ...f.snapshot.accounts[0]!,
    id: 'oauth-B',
    accountIdentity: 'account-B',
    binding: {
      kind: 'local',
      storageId: 'pool',
      rowId: 'row-B',
      credentialEpoch: 2,
    },
  })
  const active = f.create()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const claim = Reflect.get(active.process, 'claim').bind(active.process)
  let calls = 0
  const claiming = spyOn(
    active.process as unknown as {
      claim: (...args: unknown[]) => Promise<unknown>
    },
    'claim',
  ).mockImplementation(async (...args) => {
    if (++calls === 1) {
      entered.resolve()
      await release.promise
    }
    return claim(...args)
  })
  const older = active.process.requestTurn('session-S')
  const tracking = active.process.trackAccepted(
    f.input('session-S', 'older account prefix'),
    f.snapshot,
    older,
  )
  try {
    await entered.promise
    const newer = active.process.requestTurn('session-S')
    await active.process.trackAccepted(
      {
        ...f.input('session-S', 'newer account prefix'),
        oauthAccountId: 'oauth-B',
        oauthAccountIdentity: 'account-B',
      },
      f.snapshot,
      newer,
    )
    release.resolve()
    expect((await tracking)?.tracked).toBe(false)
    const store = await Reflect.get(active.process, 'stores').get('pi-storage')
    // A later warm reservation must preserve B's identity, not just its first save.
    const target = Reflect.get(active.process.manager, 'targets').get(
      'session-S',
    )
    expect(
      await Reflect.get(active.process.manager, 'options').reserveWarm(target),
    ).toBe(true)
    await store.drain()
    const [name] = (await readdir(store.directory)).filter((file) =>
      file.endsWith('.json.gz'),
    )
    const saved = JSON.parse(
      gunzipSync(await readFile(join(store.directory, name!))).toString(),
    )
    expect(saved.oauthAccountIdentity).toBe(
      JSON.stringify(['local', 'account-B', null, 'pool', 'row-B', 2]),
    )
    expect(saved.bodyText).toContain('newer account prefix')
    await active.process.stop()
    const reopened = f.create()
    await reopened.process.startSession('pi-storage', 'session-S')
    expect(
      reopened.process.manager.trackedRequest('session-S')
        ?.oauthAccountIdentity,
    ).toBe('account-B')
    expect(
      reopened.process.manager.trackedRequest('session-S')?.bodyText,
    ).toContain('newer account prefix')
  } finally {
    release.resolve()
    await tracking
    claiming.mockRestore()
  }
})

test('repeated unclaimed Pi turn starts release every busy lease before a later warm', async () => {
  const f = await fixture()
  const active = f.create()
  active.process.realTurn('session-S')
  active.process.realTurn('session-S')
  active.process.realTurn('session-S')
  active.process.endTurn('session-S')
  const input = f.input('session-S', 'later Anthropic prefix')
  input.bodyText = input.bodyText.replace('"ttl":"1h"', '"ttl":"5m"')
  await active.process.trackAccepted({ ...input, ttlMs: 300_000 }, f.snapshot)
  f.advance(60_000)
  await active.tick()
  expect(f.sends).toHaveLength(1)
  expect(JSON.stringify(f.sends[0]!.body)).toContain('later Anthropic prefix')
})

test('a continuing OAuth turn replaces a restored Pi prefix without stopping or unlinking it', async () => {
  const f = await restoredPlannedFixture()
  const store = await Reflect.get(f.active.process, 'stores').get('pi-storage')
  f.active.process.realTurn('session-S')
  await store.drain()
  expect(f.active.process.manager.trackedCount()).toBe(1)
  expect(f.active.process.manager.warming('session-S')).toEqual({ on: true })
  expect(
    (await readdir(store.directory)).filter((name) =>
      name.endsWith('.json.gz'),
    ),
  ).toHaveLength(1)
  await f.active.process.trackAccepted(
    f.input('session-S', 'continuing accepted prefix'),
    f.snapshot,
  )
  await store.drain()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual(
    [],
  )
  expect(
    f.active.process.manager.trackedRequest('session-S')?.bodyText,
  ).toContain('continuing accepted prefix')
  const [name] = (await readdir(store.directory)).filter((file) =>
    file.endsWith('.json.gz'),
  )
  expect(
    gunzipSync(await readFile(join(store.directory, name!))).toString(),
  ).toContain('continuing accepted prefix')
})

test.each([false, true])(
  'a real turn during Pi startup durably prevents adoption across the next restart (stopping=%s)',
  async (stopDuringLoad) => {
    const f = await restoredPlannedFixture(false)
    f.advance(3_300_000)
    const store = await Reflect.get(f.active.process, 'store').call(
      f.active.process,
      'pi-storage',
    )
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const load = store.load.bind(store)
    const loading = spyOn(store, 'load').mockImplementation(
      async (...args: unknown[]) => {
        entered.resolve()
        await release.promise
        return load(...args)
      },
    )
    const adoption = spyOn(f.active.process.manager, 'track')
    const starting = f.active.process.startSession('pi-storage', 'session-S')
    await entered.promise
    f.active.process.realTurn('session-S')
    const stopping = stopDuringLoad ? f.active.process.stop() : undefined
    release.resolve()
    await starting
    await stopping
    await f.active.tick()
    loading.mockRestore()
    const adopted = adoption.mock.calls.length
    adoption.mockRestore()
    expect(adopted).toBe(0)
    expect(f.active.process.manager.trackedCount()).toBe(0)
    expect(f.sends).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      f.reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
    ).toEqual([])
    await store.drain()
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.endsWith('.json.gz'),
      ),
    ).toEqual([])
    await f.active.process.stop()
    const reopened = f.create()
    await reopened.process.startSession('pi-storage', 'session-S')
    await reopened.tick()
    expect(reopened.process.manager.trackedCount()).toBe(0)
    expect(f.sends).toHaveLength(0)
  },
)

test.each([false, true])(
  'a refused model-specific Pi replacement retires the old prefix and its file (restored=%s)',
  async (restored) => {
    const key = Symbol.for('cortexkit.routing')
    const globals = globalThis as Record<symbol, unknown>
    const original = globals[key]
    const reports: { kind: string; reason?: string }[] = []
    globals[key] = () => ({
      cache: () => null,
      report: (payload: (typeof reports)[number]) => reports.push(payload),
    })
    cleanups.push(() => {
      if (original === undefined) delete globals[key]
      else globals[key] = original
    })
    const f = await fixture()
    const managerOptions = {
      resolveSettings: (
        storage: Parameters<
          NonNullable<
            ConstructorParameters<typeof CacheKeepManager>[0]['resolveSettings']
          >
        >[0],
        modelId?: string,
      ) =>
        modelId === 'claude-haiku-4-5'
          ? { ...storage, cacheKeep: { enabled: false } }
          : storage,
    }
    const first = f.create(undefined, undefined, managerOptions)
    await first.process.startSession('pi-storage', 'session-S')
    await first.process.trackAccepted(f.input('session-S'), f.snapshot)
    f.advance(55 * 60_000)
    await first.tick()
    expect(f.sends).toHaveLength(1)
    if (restored) await first.process.stop()
    const active = restored
      ? f.create(undefined, undefined, managerOptions)
      : first
    if (restored) await active.process.startSession('pi-storage', 'session-S')
    const next = f.input('session-S', 'accepted new model')
    next.bodyText = next.bodyText.replace(
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    )
    await active.process.trackAccepted(next, f.snapshot)
    const store = await Reflect.get(active.process, 'stores').get('pi-storage')
    await store.drain()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(active.process.manager.trackedCount()).toBe(0)
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.endsWith('.json.gz'),
      ),
    ).toEqual([])
    expect(reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual(
      [expect.objectContaining({ reason: 'session-ended' })],
    )
  },
)

test('Pi skips due warms during a real turn and its failed-turn finally ends the prefix', async () => {
  const f = await restoredPlannedFixture()
  f.active.process.realTurn('session-S')
  f.advance(3_300_000)
  await f.active.tick()
  expect(f.sends).toHaveLength(0)
  f.active.process.endTurn('session-S')
  expect(f.active.process.manager.trackedCount()).toBe(0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual(
    [expect.objectContaining({ reason: 'session-ended' })],
  )
})

test('terminal retirement during Pi shutdown drains the obsolete restart file', async () => {
  const f = await restoredPlannedFixture()
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  globals[key] = () => ({
    cache: () => null,
    report: (payload: (typeof f.reports)[number]) => f.reports.push(payload),
  })
  const store = await Reflect.get(f.active.process, 'stores').get('pi-storage')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const claim = Reflect.get(f.active.process, 'claim').bind(f.active.process)
  const claiming = spyOn(
    f.active.process as unknown as {
      claim: (...args: unknown[]) => Promise<unknown>
    },
    'claim',
  ).mockImplementation(async (...args) => {
    entered.resolve()
    await release.promise
    return claim(...args)
  })
  const tracking = f.active.process.trackAccepted(
    f.input('session-S', 'accepted during shutdown'),
    f.snapshot,
  )
  await entered.promise
  const stopping = f.active.process.stop()
  release.resolve()
  try {
    await Promise.all([tracking, stopping])
    await store.drain()
    expect(
      (await readdir(store.directory)).filter((name) =>
        name.endsWith('.json.gz'),
      ),
    ).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      f.reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
    ).toEqual([expect.objectContaining({ reason: 'session-ended' })])
  } finally {
    release.resolve()
    claiming.mockRestore()
  }
})

test('Pi shutdown aborts and joins Core due-timer warms before releasing their claim', async () => {
  const f = await fixture()
  const timers = new Map<object, { callback: () => unknown; at: number }>()
  const sent = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<void>()
  let signal: AbortSignal | undefined
  let releaseFetch: (() => void) | undefined
  const active = f.create(
    undefined,
    (init) =>
      new Promise<Response>((resolve, reject) => {
        signal = init?.signal ?? undefined
        releaseFetch = () => resolve(Response.json({}))
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
        sent.resolve()
      }),
    {
      setTimeoutImpl: ((callback: () => unknown, ms: number) => {
        const id = { unref() {} }
        timers.set(id, { callback, at: f.now() + ms })
        return id
      }) as unknown as typeof setTimeout,
      clearTimeoutImpl: ((id: object) => {
        timers.delete(id)
      }) as unknown as typeof clearTimeout,
      onComplete: async () => {
        await complete.promise
      },
    },
  )
  await active.process.startSession('pi-storage', 'session-S')
  const pricedInput = f.input('session-S')
  pricedInput.bodyText = pricedInput.bodyText.replace(
    'claude-sonnet-4-6',
    'claude-opus-5-5',
  )
  await active.process.trackAccepted(pricedInput, f.snapshot)
  active.process.manager.recordAcceptedUsage(
    'session-S',
    active.process.manager.trackedRequest('session-S')!.bodyText,
    { cache_read_input_tokens: 1000 },
  )
  const savedStore = await Reflect.get(active.process, 'stores').get(
    'pi-storage',
  )
  f.advance(55 * 60_000)
  const due = [...timers.values()].find(({ at }) => at === f.now())
  expect(due).toBeDefined()
  const tick = Promise.resolve(due!.callback())
  await sent.promise
  const pendingCost =
    active.process.manager.trackedPolicyState('session-S')?.pendingWarmCost
  let stopped = false
  const stopping = active.process.stop().then(() => {
    stopped = true
  })
  try {
    expect(pendingCost).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(signal?.aborted).toBe(true)
    expect(stopped).toBe(false)
    const claim = [
      ...(
        Reflect.get(active.process, 'sessions') as Map<
          string,
          { claim: CacheKeepClaim }
        >
      ).values(),
    ][0]!.claim
    expect(await claim.isCurrent()).toBe(true)
    complete.resolve()
    await stopping
    await tick
    expect(active.process.manager.trackedCount()).toBe(0)
    const store = await Reflect.get(active.process, 'stores').get('pi-storage')
    // Completed shutdown clears the store registry, not the durable prefix.
    expect(store).toBeUndefined()
    const [name] = (await readdir(savedStore.directory)).filter((name) =>
      name.endsWith('.json.gz'),
    )
    const saved = JSON.parse(
      gunzipSync(await readFile(join(savedStore.directory, name!))).toString(),
    )
    expect(saved.policyState.pendingWarmCost).toBeGreaterThan(0)
    expect(f.sends).toHaveLength(1)
  } finally {
    complete.resolve()
    releaseFetch?.()
    await stopping
    await tick
  }
})

test('a storage-less accepted Pi turn ends the restored target at its route decision', async () => {
  const f = await restoredPlannedFixture()
  await f.active.process.trackAccepted(
    { ...f.input('session-S'), accountStoragePath: undefined },
    f.snapshot,
  )
  expect(f.active.process.manager.trackedCount()).toBe(0)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(f.reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual(
    [expect.objectContaining({ reason: 'session-ended' })],
  )
})

test.each([false, true])(
  'Pi routing-moved stops an old-account warm (restored=%s)',
  async (restored) => {
    const f = await fixture()
    const window = { remainingPercent: 80, usedPercent: 20, checkedAt: f.now() }
    const quota = { five_hour: window, seven_day: window }
    f.snapshot.accounts[0]!.quota = quota
    f.snapshot.accounts.push({
      id: 'main',
      type: 'oauth',
      source: 'local',
      enabled: true,
      quota,
    })
    f.snapshot.policyStorage.routing = { mode: 'fallback-first' }
    const first = f.create()
    await first.process.startSession('pi-storage', 'session-S')
    await first.process.trackAccepted(f.input('session-S'), f.snapshot)
    if (restored) await first.process.stop()
    f.snapshot.policyStorage.routing.mode = 'main-first'
    const active = restored ? f.create() : first
    if (restored) await active.process.startSession('pi-storage', 'session-S')
    f.advance(55 * 60_000 + 30_000)
    await active.tick()
    expect(f.sends).toHaveLength(0)
    expect(
      active.process.manager.registrySessions()[0]?.warmStopped?.reason,
    ).toBe('routing-moved')
  },
)

test.each(['unchanged', 'unknown-reading'] as const)(
  'Pi routing peek keeps warming on A: %s',
  async (control) => {
    const f = await fixture()
    const window = { remainingPercent: 80, usedPercent: 20, checkedAt: f.now() }
    f.snapshot.accounts[0]!.quota = { five_hour: window, seven_day: window }
    f.snapshot.accounts.push({
      id: 'main',
      type: 'oauth',
      source: 'local',
      enabled: true,
    })
    f.snapshot.policyStorage.routing = {
      mode: control === 'unchanged' ? 'fallback-first' : 'main-first',
    }
    const active = f.create()
    await active.process.startSession('pi-storage', 'session-S')
    await active.process.trackAccepted(f.input('session-S'), f.snapshot)
    f.advance(55 * 60_000)
    await active.tick()
    expect(f.sends).toHaveLength(1)
    expect(f.sends[0]?.session).toBe('session-S')
    expect(
      active.process.manager.registrySessions()[0]?.warmStopped,
    ).toBeUndefined()
  },
)

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

test('Pi stop releases its tracked lifetime without deleting restart files', async () => {
  const f = await fixture()
  const active = f.create()
  await active.process.startSession('pi-storage', 'closed-session')
  await active.process.trackAccepted(f.input('closed-session'), f.snapshot)
  expect(active.process.manager.trackedCount()).toBe(1)
  await active.process.stop()
  expect(active.process.manager.trackedCount()).toBe(0)
  expect(active.process.manager.registrySessions()).toEqual([])
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith('.json.gz'),
  )
  expect(files).toHaveLength(1)
  const record = JSON.parse(
    gunzipSync(await readFile(join(directory, files[0]!))).toString(),
  )
  expect(record.id).toBe('closed-session')
  expect(record.policyState.stopReported).toBeUndefined()
})

test('a later Pi lifetime re-adopts the saved restart record after disposal', async () => {
  const f = await fixture()
  const active = f.create()
  await active.process.startSession('pi-storage', 'reopened-session')
  await active.process.trackAccepted(f.input('reopened-session'), f.snapshot)
  const previousState =
    active.process.manager.trackedPolicyState('reopened-session')
  await active.process.stop()
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const [name] = (await readdir(directory)).filter((name) =>
    name.endsWith('.json.gz'),
  )
  const path = join(directory, name!)
  const record = JSON.parse(gunzipSync(await readFile(path)).toString())
  // Another lifetime may update the saved prefix after the old claim is released.
  record.bodyText = record.bodyText.replace(
    'original prefix',
    'prefix from the next owner',
  )
  await writeFile(path, gzipSync(JSON.stringify(record)))
  f.advance(1000)
  await active.process.startSession('pi-storage', 'reopened-session')
  expect(
    active.process.manager.trackedRequest('reopened-session')?.bodyText,
  ).toContain('prefix from the next owner')
  expect(
    active.process.manager.trackedPolicyState('reopened-session'),
  ).not.toBe(previousState)
  expect(
    active.process.manager.trackedRequest('reopened-session')?.cacheExpiresAt,
  ).toBe(record.cacheExpiresAt)
  f.advance(55 * 60_000 - 1000)
  await active.tick()
  expect(f.sends).toHaveLength(1)
  expect(JSON.stringify(f.sends[0]?.body)).toContain(
    'prefix from the next owner',
  )
})

test('a Pi real turn on an ineligible account ends its restored planned prefix', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  let policy: { ttl: 'long'; keep_warm: 'always' } | null = {
    ttl: 'long',
    keep_warm: 'always',
  }
  const reports: { kind: string; reason?: string }[] = []
  globals[key] = () => ({
    cache: () => policy,
    report: (payload: (typeof reports)[number]) => reports.push(payload),
  })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
  const f = await fixture()
  const first = f.create()
  await first.process.startSession('pi-storage', 'session-S')
  await first.process.trackAccepted(f.input('session-S'), f.snapshot)
  await first.process.stop()
  policy = null
  const second = f.create()
  await second.process.startSession('pi-storage', 'session-S')
  expect(second.process.manager.trackedCount()).toBe(1)
  f.snapshot.accounts = []
  second.process.realTurn('session-S')
  await second.process.trackAccepted(
    f.input('session-S', 'new real prefix'),
    f.snapshot,
  )
  expect(second.process.manager.trackedCount()).toBe(0)
  await second.process.stop()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual([
    expect.objectContaining({ reason: 'session-ended' }),
  ])
  f.advance(3_300_000)
  await second.tick()
  expect(f.sends).toHaveLength(0)
})

test('Pi restores a 2.6 record without policyState and durably caps its new count', async () => {
  const f = await fixture()
  const first = f.create()
  await first.process.trackAccepted(f.input('legacy-pi'), f.snapshot)
  await first.process.stop()
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const [name] = (await readdir(directory)).filter((name) =>
    name.endsWith('.gz'),
  )
  const path = join(directory, name!)
  const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
  expect(saved.policyState).toBeDefined()
  saved.pluginVersion = '2.6.0'
  delete saved.policyState
  await writeFile(path, gzipSync(JSON.stringify(saved)))
  f.advance(60_000)
  const reserved: number[] = []
  const resumed = f.create(undefined, async () => {
    const persisted = JSON.parse(gunzipSync(await readFile(path)).toString())
    reserved.push(persisted.policyState.warmsSinceLastRealRequest)
    return Response.json({})
  })
  await resumed.process.startSession('pi-storage', 'legacy-pi')
  expect(resumed.process.manager.trackedPolicyState('legacy-pi')).toMatchObject(
    {
      planned: false,
      lastRealRequestAt: saved.lastTouchAt,
      warmsSinceLastRealRequest: 0,
      warmCostSoFar: 0,
      hasWarmed: false,
    },
  )
  for (let count = 1; count <= 25; count++) {
    f.advance(55 * 60_000)
    await resumed.tick()
    expect(f.sends).toHaveLength(Math.min(count, 24))
  }
  expect(reserved).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
  expect(f.sends[0]?.body.system).toEqual(JSON.parse(saved.bodyText).system)
  expect(resumed.process.manager.trackedCount()).toBe(0)
})

test('Pi still drops a restart record requiring a real request', async () => {
  const f = await fixture()
  const first = f.create()
  await first.process.trackAccepted(f.input('stopped-pi'), f.snapshot)
  await first.process.stop()
  const directory = cacheKeepStoreDirectory('shared-storage', f.root, 'pi')
  const [name] = (await readdir(directory)).filter((name) =>
    name.endsWith('.gz'),
  )
  const path = join(directory, name!)
  const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
  saved.policyState.needsRealRequest = true
  saved.policyState.warmsSinceLastRealRequest = 24
  await writeFile(path, gzipSync(JSON.stringify(saved)))
  const resumed = f.create()
  await resumed.process.startSession('pi-storage', 'stopped-pi')
  expect(resumed.process.manager.trackedCount()).toBe(0)
  expect(
    (await readdir(directory)).filter((name) => name.endsWith('.gz')),
  ).toEqual([])
  f.advance(55 * 60_000)
  await resumed.tick()
  expect(f.sends).toEqual([])
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
  const old = new CacheKeepClaim(directory, 'S', {
    liveness: { pidAlive: () => true, incarnation: async () => 'old-start' },
  })
  const next = new CacheKeepClaim(directory, 'S', {
    liveness: { pidAlive: () => true, incarnation: async () => 'new-start' },
  })
  expect(await old.acquire()).toBe(true)
  expect(await next.acquire()).toBe(true)
  await old.release()
  const contender = new CacheKeepClaim(directory, 'S', {
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
  const sweep = new CacheKeepClaim(directory, hash, {
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
  const sweep = new CacheKeepClaim(directory, hash, {
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

test.each([false, true])(
  'planned child warms override local off and preserve the 24-count across Pi restart (null policy: %s)',
  async (nullPolicy) => {
    const key = Symbol.for('cortexkit.routing')
    const globals = globalThis as Record<symbol, unknown>
    const original = globals[key]
    let policy: { ttl: 'long'; keep_warm: 'always' } | null = {
      ttl: 'long',
      keep_warm: 'always',
    }
    globals[key] = () => ({ cache: () => policy })
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
      f.advance(3_300_000)
      await first.tick()
    }
    expect(f.sends).toHaveLength(23)
    await first.process.stop()
    if (nullPolicy) policy = null
    const resumed = f.create()
    await resumed.process.startSession('pi-storage', 'planned-pi')
    f.advance(3_300_000)
    await resumed.tick()
    expect(f.sends).toHaveLength(24)
    f.advance(3_300_000)
    await resumed.tick()
    expect(f.sends).toHaveLength(24)
  },
)

test('ttl-only policy cannot restore a Pi child after the local subagent opt-out', async () => {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const original = globals[key]
  globals[key] = () => ({ cache: () => ({ ttl: 'long' }) })
  cleanups.push(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
  const f = await fixture()
  f.snapshot.policyStorage.cacheKeep = {
    enabled: true,
    always: true,
    subagents: true,
  }
  const first = f.create()
  await first.process.trackAccepted(
    { ...f.input('ttl-child'), isSubagent: true },
    f.snapshot,
  )
  await first.process.stop()
  f.snapshot.policyStorage.cacheKeep.subagents = false
  const resumed = f.create()
  await resumed.process.startSession('pi-storage', 'ttl-child')
  f.advance(3_300_000)
  await resumed.tick()
  expect(f.sends).toEqual([])
  expect(resumed.process.manager.trackedSessions()).toEqual([])
})

test.each(['replaced', 'retired'] as const)(
  'an old Pi 503 settlement cannot persist a %s generation',
  async (change) => {
    const f = await fixture()
    let entered!: () => void
    let finish!: (response: Response) => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<Response>((resolve) => {
      finish = resolve
    })
    const first = f.create(undefined, () => {
      entered()
      return held
    })
    await first.process.startSession('pi-storage', 'ses_settle')
    await first.process.trackAccepted(f.input('ses_settle'), f.snapshot)
    f.advance(55 * 60_000)
    const warming = first.tick()
    await started
    if (change === 'replaced')
      await first.process.trackAccepted(
        f.input('ses_settle', 'Newest Pi prefix'),
        f.snapshot,
      )
    else
      (
        first.process as unknown as { manager: CacheKeepManager }
      ).manager.untrack('ses_settle', 'session-forgotten')
    finish(Response.json({}, { status: 503 }))
    await warming
    await first.process.stop()
    const second = f.create()
    await second.process.startSession('pi-storage', 'ses_settle')
    const restored = (
      second.process as unknown as { manager: CacheKeepManager }
    ).manager.trackedRequest('ses_settle')
    if (change === 'replaced')
      expect(restored?.bodyText).toContain('Newest Pi prefix')
    else expect(restored).toBeUndefined()
    f.sends.length = 0
    f.advance(55 * 60_000)
    await second.tick()
    expect(f.sends).toHaveLength(change === 'replaced' ? 1 : 0)
    if (change === 'replaced')
      expect(JSON.stringify(f.sends[0]!.body)).toContain('Newest Pi prefix')
  },
)
