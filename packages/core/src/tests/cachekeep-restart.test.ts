import { afterEach, expect, spyOn, test } from 'bun:test'
import { CACHE_WARM_STOP_REASONS } from '@cortexkit/common-auth/routing-accessor'
import type { AccountStorage } from '../accounts.ts'
import {
  CACHE_KEEP_MAX_BODY_BYTES,
  CacheKeepManager,
  type CacheKeepTarget,
} from '../cachekeep.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  logger,
  setLogLevel,
} from '../logger.ts'
import type { SessionCachePolicy } from '../session-cache-policy.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const original = globals[key]
const managers: CacheKeepManager[] = []
const level = getLogLevel()
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop()
  await detached()
  if (original === undefined) delete globals[key]
  else globals[key] = original
  __setLogTestSink(null)
  setLogLevel(level)
})
const detached = () => new Promise((resolve) => setTimeout(resolve, 0))

function fixture(
  initial: SessionCachePolicy | null = { keep_warm: 'auto', ttl: 'long' },
  send?: typeof fetch,
  options: Partial<ConstructorParameters<typeof CacheKeepManager>[0]> = {},
) {
  let now = Date.parse('2026-05-18T10:00:00Z')
  let policy = initial
  const reports: { kind: string; reason?: string; at?: number }[] = []
  const logs: LogTestRecord[] = []
  const targets = new Map<string, CacheKeepTarget>()
  let sends = 0
  setLogLevel('info')
  __setLogTestSink((record) => logs.push(record))
  globals[key] = () => ({
    cache: () => policy,
    report: (payload: (typeof reports)[number]) => reports.push(payload),
  })
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    cacheKeep: { enabled: false },
  }
  const manager = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => storage,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as typeof clearInterval,
    setTimeoutImpl: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => {}) as typeof clearTimeout,
    onTargetChanged: (target) =>
      targets.set(target.id, target as CacheKeepTarget),
    fetchImpl:
      send ??
      Object.assign(
        async () => {
          sends++
          return Response.json({})
        },
        { preconnect: fetch.preconnect },
      ),
    ...options,
  })
  managers.push(manager)
  const bodyText = JSON.stringify({
    model: 'claude-opus-5-5',
    system: [
      {
        type: 'text',
        text: 'PRIVATE PREFIX',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
  })
  const input = {
    sessionId: 'ses_restart',
    bodyText,
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    storage,
    cacheMode: 'explicit',
    ttlMs: 3_600_000,
  }
  return {
    manager,
    input,
    reports,
    logs,
    targets,
    track: (extra: Partial<Parameters<CacheKeepManager['track']>[0]> = {}) =>
      manager.track({ ...input, ...extra }),
    advance: (ms: number) => {
      now += ms
    },
    setPolicy: (value: SessionCachePolicy | null) => {
      policy = value
    },
    get now() {
      return now
    },
    get sends() {
      return sends
    },
  }
}

test.each(['disabled', 'thread', 'body-budget'] as const)(
  'a refused real-turn %s replacement ends every session-owned target',
  async (reason) => {
    const f = fixture(null)
    Object.assign(f.input.storage, {
      cacheKeep: { enabled: true, always: true },
      claudeCache: { enabled: true, mode: 'hybrid' },
    })
    expect(f.track({ cacheMode: 'hybrid' }).tracked).toBe(true)
    expect(
      f.track({
        sessionId: 'source-prefix',
        ownerSessionId: f.input.sessionId,
        sourceWarm: true,
        cacheMode: 'hybrid',
      }).tracked,
    ).toBe(true)
    f.targets.get(f.input.sessionId)!.policyState!.hasWarmed = true
    const bodyText =
      reason === 'body-budget'
        ? 'x'.repeat(CACHE_KEEP_MAX_BODY_BYTES + 1)
        : reason === 'thread'
          ? JSON.stringify({
              ...JSON.parse(f.input.bodyText),
              thread: { id: 'server-thread' },
            })
          : f.input.bodyText
    const result = f.track({
      cacheMode: 'hybrid',
      bodyText,
      ...(reason === 'disabled' && {
        storage: { ...f.input.storage, cacheKeep: { enabled: false } },
      }),
    })
    expect(result.tracked).toBe(false)
    expect(f.manager.trackedCount()).toBe(0)
    await detached()
    expect(
      f.reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
    ).toEqual([
      { kind: 'cache_warm_stopped', at: f.now, reason: 'session-ended' },
    ])
    await f.manager.tick()
    expect(f.sends).toBe(0)
  },
)

test('an older real-turn abort neither clears a newer busy lease nor replaces its accepted prefix', async () => {
  const f = fixture({ ttl: 'long', keep_warm: 'always' })
  f.track()
  const older = f.manager.beginRealTurn(f.input.sessionId)
  const newer = f.manager.beginRealTurn(f.input.sessionId)
  older.finish()
  expect(newer.active).toBe(true)
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.sends).toBe(0)
  const bodyText = f.input.bodyText.replace(
    'PRIVATE PREFIX',
    'new accepted prefix',
  )
  expect(newer.track({ ...f.input, bodyText }).tracked).toBe(true)
  expect(older.track(f.input).tracked).toBe(false)
  older.finish()
  expect(f.manager.trackedRequest(f.input.sessionId)?.bodyText).toBe(bodyText)
  expect(newer.active).toBe(false)
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.sends).toBe(1)
})

test.each([false, true])(
  'an expired busy lease accepts a late response only without a newer turn (newer=%s)',
  async (newer) => {
    const timeouts = new Map<object, { callback: () => void; at: number }>()
    const f = fixture({ ttl: 'long', keep_warm: 'always' }, undefined, {
      setTimeoutImpl: ((callback: () => void, ms: number) => {
        const id = { unref() {} }
        timeouts.set(id, { callback, at: f.now + ms })
        return id
      }) as unknown as typeof setTimeout,
      clearTimeoutImpl: ((id: object) => {
        timeouts.delete(id)
      }) as unknown as typeof clearTimeout,
    })
    f.track()
    const turn = f.manager.beginRealTurn(f.input.sessionId)
    f.advance(3_600_001)
    for (const [id, timeout] of [...timeouts])
      if (timeout.at <= f.now) {
        timeouts.delete(id)
        timeout.callback()
      }
    expect(turn.active).toBe(false)
    if (newer) {
      const next = f.manager.beginRealTurn(f.input.sessionId)
      expect(
        next.track({
          ...f.input,
          bodyText: f.input.bodyText.replace('PRIVATE PREFIX', 'newer prefix'),
        }).tracked,
      ).toBe(true)
    }
    const result = turn.track({
      ...f.input,
      bodyText: f.input.bodyText.replace('PRIVATE PREFIX', 'late prefix'),
    })
    expect(result.tracked).toBe(!newer)
    if (newer)
      expect(result).toEqual({ tracked: false, reason: 'superseded real turn' })
    expect(f.manager.trackedRequest(f.input.sessionId)?.bodyText).toContain(
      newer ? 'newer prefix' : 'late prefix',
    )
    f.advance(3_570_000)
    await f.manager.tick()
    expect(f.sends).toBe(1)
  },
)

test('an abandoned response authority is freed after one cache lifetime of grace', () => {
  const timeouts = new Map<object, { callback: () => void; at: number }>()
  const f = fixture({ ttl: 'long', keep_warm: 'always' }, undefined, {
    setTimeoutImpl: ((callback: () => void, ms: number) => {
      const id = { unref() {} }
      timeouts.set(id, { callback, at: f.now + ms })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((id: object) => {
      timeouts.delete(id)
    }) as unknown as typeof clearTimeout,
  })
  f.track()
  const turn = f.manager.beginRealTurn(f.input.sessionId)
  const groups = Reflect.get(f.manager, 'realTurns') as Map<string, unknown>
  f.advance(3_600_001)
  for (const [id, timeout] of [...timeouts])
    if (timeout.at <= f.now) {
      timeouts.delete(id)
      timeout.callback()
    }
  expect(turn.active).toBe(false)
  expect(groups.size).toBe(1)
  f.advance(3_600_000)
  for (const [id, timeout] of [...timeouts])
    if (timeout.at <= f.now) {
      timeouts.delete(id)
      timeout.callback()
    }
  expect(groups.size).toBe(0)
  expect(turn.track(f.input)).toEqual({
    tracked: false,
    reason: 'real turn ended',
  })
})

test('an unfinished real-turn lease expires with its cache and cannot block future warming', async () => {
  const timeouts = new Map<object, { callback: () => void; at: number }>()
  const f = fixture({ ttl: 'long', keep_warm: 'always' }, undefined, {
    setTimeoutImpl: ((callback: () => void, ms: number) => {
      const id = { unref() {} }
      timeouts.set(id, { callback, at: f.now + ms })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((id: object) => {
      timeouts.delete(id)
    }) as unknown as typeof clearTimeout,
  })
  f.track()
  const abandoned = f.manager.beginRealTurn(f.input.sessionId)
  f.advance(3_600_001)
  for (const [id, timeout] of [...timeouts])
    if (timeout.at <= f.now) {
      timeouts.delete(id)
      timeout.callback()
    }
  expect(abandoned.active).toBe(false)
  await f.manager.tick()
  const next = f.manager.beginRealTurn(f.input.sessionId)
  expect(next.track(f.input).tracked).toBe(true)
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.sends).toBe(1)
})

test('an expiring real-turn lease cannot restart a paused scheduler', async () => {
  const timeouts = new Map<object, { callback: () => void; at: number }>()
  const f = fixture({ ttl: 'long', keep_warm: 'always' }, undefined, {
    setTimeoutImpl: ((callback: () => void, ms: number) => {
      const id = { unref() {} }
      timeouts.set(id, { callback, at: f.now + ms })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((id: object) => {
      timeouts.delete(id)
    }) as unknown as typeof clearTimeout,
  })
  f.track()
  f.manager.beginRealTurn(f.input.sessionId)
  f.manager.stop()
  f.advance(3_600_001)
  for (const [id, timeout] of [...timeouts])
    if (timeout.at <= f.now) {
      timeouts.delete(id)
      timeout.callback()
    }
  // The response-authority grace timer remains, but no warm timer is restarted.
  expect([...timeouts.values()].map(({ at }) => at)).toEqual([
    f.now + 3_599_999,
  ])
  expect(f.manager.trackedCount()).toBe(1)
  await detached()
  expect(f.reports).toEqual([])
})

test('pausing a real-turn lease is silent and a later finish cannot retire the retained target', async () => {
  const f = fixture({ ttl: 'long', keep_warm: 'always' })
  f.track()
  f.targets.get(f.input.sessionId)!.policyState!.hasWarmed = true
  const turn = f.manager.beginRealTurn(f.input.sessionId)
  turn.pause()
  turn.pause()
  turn.finish()
  expect(turn.active).toBe(false)
  expect(f.manager.trackedCount()).toBe(1)
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.sends).toBe(1)
  await detached()
  expect(f.reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual(
    [],
  )
})

test('a pruned warmed target does not lend its warm history to an unwarmed replacement', async () => {
  const f = fixture({ ttl: 'long', keep_warm: 'always' })
  f.track()
  f.targets.get(f.input.sessionId)!.policyState!.hasWarmed = true
  f.advance(3_600_001)
  expect(
    f.track({
      bodyText: f.input.bodyText.replace('PRIVATE PREFIX', 'new turn'),
    }).tracked,
  ).toBe(true)
  expect(f.targets.get(f.input.sessionId)?.policyState?.hasWarmed).toBe(false)
  f.manager.untrack(f.input.sessionId)
  await detached()
  expect(f.reports.filter(({ kind }) => kind === 'cache_warm_stopped')).toEqual(
    [{ kind: 'cache_warm_stopped', at: f.now, reason: 'deadline-missed' }],
  )
})

test('dispose aborts and drains a due-timer warm without reporting or settling its ambiguous reservation', async () => {
  const timers = new Map<object, { callback: () => unknown; at: number }>()
  let sent!: () => void
  const sending = new Promise<void>((resolve) => {
    sent = resolve
  })
  let releaseFetch: (() => void) | undefined
  let releaseComplete!: () => void
  const completing = new Promise<void>((resolve) => {
    releaseComplete = resolve
  })
  let signal: AbortSignal | undefined
  const f = fixture({ ttl: 'long', keep_warm: 'always' }, undefined, {
    setTimeoutImpl: ((callback: () => unknown, ms: number) => {
      const id = { unref() {} }
      timers.set(id, { callback, at: f.now + ms })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((id: object) => {
      timers.delete(id)
    }) as unknown as typeof clearTimeout,
    fetchImpl: ((_url, init) =>
      new Promise<Response>((resolve, reject) => {
        signal = init?.signal ?? undefined
        releaseFetch = () =>
          resolve(Response.json({ usage: { input_tokens: 0 } }))
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        )
        sent()
      })) as typeof fetch,
    onComplete: async () => {
      await completing
    },
  })
  f.track()
  f.manager.recordAcceptedUsage(f.input.sessionId, f.input.bodyText, {
    cache_read_input_tokens: 1000,
  })
  f.advance(3_300_000)
  const due = [...timers.values()].find(({ at }) => at === f.now)
  expect(due).toBeDefined()
  const tick = Promise.resolve(due!.callback())
  await sending
  const state = f.manager.trackedPolicyState(f.input.sessionId)!
  expect(state.pendingWarmCost).toBeGreaterThan(0)
  let disposed = false
  const disposal = Promise.resolve(f.manager.dispose()).then(() => {
    disposed = true
  })
  try {
    await detached()
    expect(signal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    releaseComplete()
    await disposal
    await tick
    expect(state.pendingWarmCost).toBeGreaterThan(0)
    expect(f.manager.trackedCount()).toBe(0)
    expect(
      f.reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
    ).toEqual([])
  } finally {
    releaseComplete()
    releaseFetch?.()
    await disposal
    await tick
  }
})

test.each(['loadStorage', 'prepareHeaders', 'reserveWarm'] as const)(
  'a tick paused while awaiting %s sends nothing, retries nothing and arms nothing',
  async (stage) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const timers = new Map<object, () => unknown>()
    const wait = async () => {
      entered.resolve()
      await release.promise
    }
    const f = fixture({ ttl: 'long', keep_warm: 'always' }, undefined, {
      loadStorage: async () => {
        if (stage === 'loadStorage') await wait()
        return f.input.storage
      },
      prepareHeaders: async (headers) => {
        if (stage === 'prepareHeaders') await wait()
        return headers
      },
      reserveWarm: async () => {
        if (stage === 'reserveWarm') await wait()
        return true
      },
      setTimeoutImpl: ((callback: () => unknown) => {
        const id = { unref() {} }
        timers.set(id, callback)
        return id
      }) as unknown as typeof setTimeout,
      clearTimeoutImpl: ((id: object) => {
        timers.delete(id)
      }) as unknown as typeof clearTimeout,
    })
    f.track()
    f.manager.recordAcceptedUsage(f.input.sessionId, f.input.bodyText, {
      cache_read_input_tokens: 1000,
    })
    f.advance(3_570_000)
    const tick = f.manager.tick()
    await entered.promise
    try {
      f.manager.stop()
      release.resolve()
      await tick
      expect(f.sends).toBe(0)
      expect(timers.size).toBe(0)
      expect(f.manager.trackedCount()).toBe(1)
      expect(
        f.manager.trackedPolicyState(f.input.sessionId)
          ?.warmsSinceLastRealRequest,
      ).toBe(stage === 'reserveWarm' ? 1 : 0)
      expect(
        f.reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
      ).toEqual([])
    } finally {
      release.resolve()
      await tick
    }
  },
)

test.each(['auto', 'hours', 'always'] as const)(
  'restart warms with saved %s policy while fresh policy is null',
  async (mode) => {
    const policy = {
      keep_warm: mode,
      ttl: 'long',
      ...(mode === 'hours' && {
        hours: { from: '09:00', to: '18:00', tz: 'UTC' },
      }),
    } as const
    const before = fixture(policy)
    before.track()
    before.manager.recordAcceptedUsage(
      before.input.sessionId,
      before.input.bodyText,
      { cache_read_input_tokens: 1000 },
    )
    const retained = structuredClone(
      before.targets.get(before.input.sessionId)!,
    )
    Object.assign(retained.policyState!, {
      warmsSinceLastRealRequest: 7,
      warmCostSoFar: 1000,
      pendingWarmCost: 200,
    })
    const after = fixture(null)
    expect(after.track({ retained })).toEqual({ tracked: true })
    expect(after.targets.get(after.input.sessionId)?.policyState).toMatchObject(
      { policy, warmsSinceLastRealRequest: 7, warmCostSoFar: 1200 },
    )
    after.advance(3_570_000)
    await after.manager.tick()
    expect(after.sends).toBe(1)
    expect(after.targets.get(after.input.sessionId)?.policyState).toMatchObject(
      { warmsSinceLastRealRequest: 8, warmCostSoFar: 1400 },
    )
  },
)

test('legacy planned restart uses bounded auto and logs its fallback once', async () => {
  const before = fixture()
  before.track()
  const retained = structuredClone(before.targets.get(before.input.sessionId)!)
  delete retained.policyState!.policy
  const after = fixture(null)
  expect(after.track({ retained }).tracked).toBe(true)
  after.advance(3_570_000)
  await after.manager.tick()
  expect(after.sends).toBe(1)
  expect(
    after.logs.filter(
      (row) => row.message === 'restored legacy planned policy as auto',
    ),
  ).toHaveLength(1)
})

test('legacy stop markers do not block a valid restored target', async () => {
  const before = fixture()
  before.track()
  const retained = structuredClone(before.targets.get(before.input.sessionId)!)
  Object.assign(retained.policyState!, { stopReported: true })
  const after = fixture(null)
  expect(after.track({ retained }).tracked).toBe(true)
  after.advance(3_570_000)
  await after.manager.tick()
  expect(after.sends).toBe(1)
})

test('an already expired restored record is rejected without a stop report', async () => {
  const before = fixture()
  before.track()
  const retained = structuredClone(before.targets.get(before.input.sessionId)!)
  retained.policyState!.hasWarmed = true
  const after = fixture(null)
  after.advance(3_600_001)
  expect(after.track({ retained }).tracked).toBe(false)
  await detached()
  expect(after.reports).toEqual([])
})

test('fresh off after restart stops even a restored session that never warmed', async () => {
  const before = fixture()
  before.track()
  const retained = structuredClone(before.targets.get(before.input.sessionId)!)
  const after = fixture(null)
  expect(after.track({ retained }).tracked).toBe(true)
  after.setPolicy({ keep_warm: 'off' })
  await after.manager.tick()
  await detached()
  expect(after.manager.trackedCount()).toBe(0)
  expect(after.sends).toBe(0)
  expect(after.reports).toContainEqual({
    kind: 'cache_warm_stopped',
    at: after.now,
    reason: 'unsupported',
  })
})

test('saved admitted cost at the auto cap stops and reports on restart', async () => {
  const before = fixture()
  before.track()
  before.manager.recordAcceptedUsage(
    before.input.sessionId,
    before.input.bodyText,
    { cache_read_input_tokens: 1000 },
  )
  const retained = structuredClone(before.targets.get(before.input.sessionId)!)
  Object.assign(retained.policyState!, {
    warmCostSoFar: 7600,
    pendingWarmCost: 200,
  })
  const after = fixture(null)
  expect(after.track({ retained })).toEqual({
    tracked: false,
    reason: 'cost-cap',
  })
  await detached()
  expect(after.sends).toBe(0)
  expect(after.reports).toContainEqual({
    kind: 'cache_warm_stopped',
    at: after.now,
    reason: 'cost-cap',
  })
})

test('a fresh policy replaces the restored snapshot without resetting cost or count', async () => {
  const before = fixture({ ttl: 'long', keep_warm: 'always' })
  before.track()
  const retained = structuredClone(before.targets.get(before.input.sessionId)!)
  Object.assign(retained.policyState!, {
    warmsSinceLastRealRequest: 23,
    warmCostSoFar: 1200,
  })
  const after = fixture(null)
  after.track({ retained })
  after.setPolicy({ ttl: 'long', keep_warm: 'auto' })
  await after.manager.tick()
  expect(after.targets.get(after.input.sessionId)?.policyState).toMatchObject({
    policy: { ttl: 'long', keep_warm: 'auto' },
    warmsSinceLastRealRequest: 23,
    warmCostSoFar: 1200,
  })
  after.advance(3_570_000)
  await after.manager.tick()
  expect(after.sends).toBe(1)
  expect(after.manager.trackedCount()).toBe(1)
})

test('a fresh real turn does not reuse a saved restore policy while the bridge is null', () => {
  const before = fixture()
  before.track()
  const retained = structuredClone(before.targets.get(before.input.sessionId)!)
  const after = fixture(null)
  after.track({ retained })
  expect(after.track()).toEqual({ tracked: false, reason: 'session-ended' })
  expect(after.manager.trackedCount()).toBe(0)
})

test.each(['always', 'hours'] as const)(
  'saved %s keeps its count cap while policy is null',
  async (mode) => {
    const before = fixture({
      keep_warm: mode,
      ttl: 'long',
      ...(mode === 'hours' && {
        hours: { from: '09:00', to: '18:00', tz: 'UTC' },
      }),
    })
    before.track()
    const retained = structuredClone(
      before.targets.get(before.input.sessionId)!,
    )
    retained.policyState!.warmsSinceLastRealRequest = 24
    const after = fixture(null)
    expect(after.track({ retained })).toEqual({
      tracked: false,
      reason: 'count-cap',
    })
    await detached()
    expect(after.reports).toContainEqual({
      kind: 'cache_warm_stopped',
      at: after.now,
      reason: 'count-cap',
    })
  },
)

test('a hanging due warm does not block another session and concurrency is capped at four', async () => {
  const gate = Promise.withResolvers<void>()
  const sent: string[] = []
  const f = fixture(
    undefined,
    Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        sent.push(String(init?.body))
        await gate.promise
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  )
  for (let i = 0; i < 5; i++)
    f.track({
      sessionId: `ses_${i}`,
      bodyText: f.input.bodyText.replace('PRIVATE PREFIX', `session ${i}`),
    })
  f.advance(3_570_000)
  const tick = f.manager.tick()
  await detached()
  const concurrent = sent.length
  gate.resolve()
  await tick
  expect(concurrent).toBe(4)
  expect(sent[1]).toContain('session 1')
  expect(sent).toHaveLength(5)
})

test('warm sends for the same session stay serialized', async () => {
  let sends = 0
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture(
    undefined,
    Object.assign(
      async () => {
        if (++sends === 1) await waiting
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  )
  f.track()
  f.advance(3_570_000)
  const first = f.manager.prewarmNow(f.input)
  const second = f.manager.prewarmNow(f.input)
  await detached()
  const concurrent = sends
  release()
  await Promise.all([first, second])
  expect(concurrent).toBe(1)
})

test.each([true, false])(
  'queued tick after immediate warm is a no-op (planned=%s)',
  async (planned) => {
    const gate = Promise.withResolvers<void>()
    let sends = 0
    const f = fixture(
      planned ? { keep_warm: 'always', ttl: 'long' } : null,
      Object.assign(
        async () => {
          sends++
          await gate.promise
          return Response.json({})
        },
        { preconnect: fetch.preconnect },
      ),
    )
    if (!planned)
      Object.assign(f.input.storage, {
        cacheKeep: { enabled: true, always: true },
        claudeCache: { enabled: true, mode: 'hybrid' },
      })
    expect(
      f.track({ cacheMode: planned ? 'explicit' : 'hybrid' }).tracked,
    ).toBe(true)
    f.advance(planned ? 3_570_000 : 3_300_000)
    const immediate = f.manager.prewarmNow(f.input)
    await detached()
    const tick = f.manager.tick()
    await detached()
    gate.resolve()
    await Promise.all([immediate, tick])
    await detached()
    expect(sends).toBe(1)
    expect(f.manager.trackedCount()).toBe(1)
    expect(
      f.targets.get(f.input.sessionId)?.policyState?.warmsSinceLastRealRequest,
    ).toBe(1)
    expect(
      f.reports.filter(({ kind }) => kind === 'cache_warm_stopped'),
    ).toHaveLength(0)
  },
)

test('ambiguous failures stay in the auto budget across successful retries without restart', async () => {
  let sends = 0
  const f = fixture(
    undefined,
    Object.assign(
      async () => {
        if (++sends === 1 || sends === 3)
          throw new Error('response lost after dispatch')
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  )
  f.track()
  f.manager.recordAcceptedUsage(f.input.sessionId, f.input.bodyText, {
    cache_read_input_tokens: 1000,
  })
  const state = f.targets.get(f.input.sessionId)!.policyState!
  // A rewrite costs 8,000 and each admitted read costs 200 micro-USD.
  state.warmCostSoFar = 6800
  f.advance(3_570_000)
  await f.manager.tick()
  f.advance(f.targets.get(f.input.sessionId)!.nextPrewarmAt - f.now)
  await f.manager.tick()
  f.advance(3_570_000)
  await f.manager.tick()
  f.advance(f.targets.get(f.input.sessionId)!.nextPrewarmAt - f.now)
  await f.manager.tick()
  expect(sends).toBe(4)
  expect(state.pendingWarmCost).toBe(400)
  expect(state.warmCostSoFar).toBe(7200)
  f.advance(3_570_000)
  await f.manager.tick()
  expect(sends).toBe(5)
  expect(f.manager.trackedCount()).toBe(0)
  await detached()
  expect(f.reports).toContainEqual({
    kind: 'cache_warm_stopped',
    at: f.now,
    reason: 'cost-cap',
  })
})

test.each(['policy', 'count'] as const)(
  'late dispatch decides %s before the retry deadline',
  async (cause) => {
    const f = fixture({ keep_warm: 'always', ttl: 'long' })
    f.track()
    const state = f.targets.get(f.input.sessionId)!.policyState!
    state.hasWarmed = true
    if (cause === 'count') state.warmsSinceLastRealRequest = 24
    else f.setPolicy({ keep_warm: 'off' })
    f.advance(3_596_000)
    await f.manager.tick()
    await detached()
    expect(f.reports).toContainEqual({
      kind: 'cache_warm_stopped',
      at: f.now,
      reason: cause === 'count' ? 'count-cap' : 'unsupported',
    })
    expect(f.sends).toBe(0)
  },
)

test('timing logger failure cannot turn a successful warm into a retry', async () => {
  const f = fixture()
  f.track()
  f.advance(3_570_000)
  const info = spyOn(logger, 'info').mockImplementation(() => {
    throw new Error('logger unavailable')
  })
  try {
    await f.manager.tick()
  } finally {
    info.mockRestore()
  }
  expect(f.targets.get(f.input.sessionId)?.policyState?.hasWarmed).toBe(true)
  expect(f.targets.get(f.input.sessionId)?.consecutiveFailures).toBe(0)
  expect(f.sends).toBe(1)
})

test('timing clock failure cannot turn a successful warm into a retry', async () => {
  let failClock = false
  const f = fixture(undefined, undefined, {
    now: () => {
      if (failClock) {
        failClock = false
        throw new Error('clock unavailable')
      }
      return f.now
    },
    onResponse: () => {
      failClock = true
    },
  })
  f.track()
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.targets.get(f.input.sessionId)?.policyState?.hasWarmed).toBe(true)
  expect(f.targets.get(f.input.sessionId)?.consecutiveFailures).toBe(0)
})

test('pausing leaves the record and stop deduplication untouched for a later terminal stop', async () => {
  const f = fixture()
  f.track()
  f.advance(3_570_000)
  await f.manager.tick()
  await detached()
  f.reports.length = 0
  const saved = structuredClone(f.targets.get(f.input.sessionId)!)
  f.manager.stop()
  await detached()
  expect(f.reports).toEqual([])
  expect(f.targets.get(f.input.sessionId)).toEqual(saved)
  f.setPolicy({ keep_warm: 'off' })
  await f.manager.tick()
  await detached()
  expect(f.reports).toEqual([
    { kind: 'cache_warm_stopped', at: f.now, reason: 'unsupported' },
  ])
})

test('disposing clears timers, status and slots without late warm reports or persistence callbacks', async () => {
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const timers = new Set<object>()
  const schedule = (() => {
    const timer = { unref() {} }
    timers.add(timer)
    return timer
  }) as unknown as typeof setInterval
  const cancel = ((timer: object) => {
    timers.delete(timer)
  }) as unknown as typeof clearInterval
  const callbacks = { changed: 0, removed: 0, writes: 0, published: 0 }
  const f = fixture(
    { ttl: 'long', keep_warm: 'always' },
    Object.assign(
      async () => {
        entered.resolve()
        await gate.promise
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
    {
      setIntervalImpl: schedule,
      clearIntervalImpl: cancel,
      setTimeoutImpl: schedule as unknown as typeof setTimeout,
      clearTimeoutImpl: cancel as unknown as typeof clearTimeout,
      onTargetChanged: () => {
        callbacks.changed++
      },
      onTargetRemoved: () => {
        callbacks.removed++
      },
      onTrackedSessionsChanged: () => {
        callbacks.published++
      },
      reserveWarm: async () => {
        callbacks.writes++
        return true
      },
    },
  )
  f.track()
  f.track({ sessionId: 'stopped-status' })
  f.manager.untrack('stopped-status')
  f.manager.recordWarmingOff('warming-off-status')
  f.advance(3_570_000)
  const tick = f.manager.tick()
  await entered.promise
  const before = { ...callbacks }
  try {
    expect(Reflect.get(f.manager, 'sessionWarms').size).toBe(1)
    f.manager.dispose()
    expect(timers.size).toBe(0)
    expect(f.manager.trackedCount()).toBe(0)
    expect(f.manager.registrySessions()).toEqual([])
    expect(f.manager.warming('warming-off-status')).toBeUndefined()
    expect(Reflect.get(f.manager, 'sessionWarms').size).toBe(0)
    expect(callbacks).toEqual(before)
  } finally {
    gate.resolve()
    await tick
  }
  await detached()
  expect(f.manager.trackedCount()).toBe(0)
  expect(f.manager.registrySessions()).toEqual([])
  expect(Reflect.get(f.manager, 'sessionWarms').size).toBe(0)
  expect(timers.size).toBe(0)
  expect(callbacks).toEqual(before)
  expect(f.reports).toEqual([])
})

test('a throwing reservation skips a local hours warm until ownership can be verified', async () => {
  let canVerify = false
  const f = fixture(null, undefined, {
    reserveWarm: async () => {
      if (!canVerify) throw new Error('Could not read session ownership')
      return true
    },
  })
  const hour = new Date(f.now).getHours()
  Object.assign(f.input.storage, {
    cacheKeep: { enabled: true, startHour: hour, endHour: (hour + 4) % 24 },
    claudeCache: { enabled: true, mode: 'hybrid' },
  })
  expect(f.track({ cacheMode: 'hybrid' }).tracked).toBe(true)
  const target = f.targets.get(f.input.sessionId)!
  f.advance(target.nextPrewarmAt - f.now)
  await f.manager.tick()
  expect(f.sends).toBe(0)
  expect(f.manager.trackedCount()).toBe(1)
  expect(target.consecutiveFailures).toBe(0)
  expect(target.policyState?.warmsSinceLastRealRequest).toBe(0)
  expect(target.policyState?.pendingWarmCost).toBeUndefined()

  canVerify = true
  f.advance(20_000)
  await f.manager.tick()
  expect(f.sends).toBe(1)
  expect(target.policyState?.warmsSinceLastRealRequest).toBe(1)
})

test('unplanned deadline misses remain reportable in both lifecycle and billing state', async () => {
  const f = fixture(null)
  Object.assign(f.input.storage, {
    cacheKeep: { enabled: true, always: true },
    claudeCache: { enabled: true, mode: 'hybrid' },
  })
  expect(f.track({ cacheMode: 'hybrid' }).tracked).toBe(true)
  f.targets.get(f.input.sessionId)!.policyState!.hasWarmed = true
  f.advance(3_570_001)
  await f.manager.tick()
  await detached()
  expect(f.reports).toEqual([
    { kind: 'cache_warm_stopped', at: f.now, reason: 'deadline-missed' },
  ])
  expect(f.manager.warming(f.input.sessionId)).toEqual({
    on: false,
    stopReason: 'deadline-missed',
  })
})

test('planned deadline-missed is retained in manager billing state', () => {
  const f = fixture()
  f.track()
  f.advance(3_600_001)
  f.manager.dropExpiredTargets()
  expect(f.manager.warming(f.input.sessionId)).toEqual({
    on: false,
    stopReason: 'deadline-missed',
  })
})

test('planned deadline miss logs retry-window-ended and reports deadline-missed on the wire', async () => {
  const f = fixture(
    undefined,
    Object.assign(
      async () => {
        f.advance(25_000)
        throw new DOMException('late', 'TimeoutError')
      },
      { preconnect: fetch.preconnect },
    ),
  )
  f.track()
  f.targets.get(f.input.sessionId)!.policyState!.hasWarmed = true
  f.advance(3_570_000)
  await f.manager.tick()
  await detached()
  expect(f.reports).toContainEqual({
    kind: 'cache_warm_stopped',
    at: f.now,
    reason: 'deadline-missed',
  })
  expect(f.manager.trackedCount()).toBe(0)
  expect(f.logs).toContainEqual(
    expect.objectContaining({
      message: 'stopped warming session',
      payload: expect.objectContaining({
        session: f.input.sessionId,
        reason: 'retry-window-ended',
        stage: 'retry',
      }),
    }),
  )
  expect(f.logs).toContainEqual(
    expect.objectContaining({
      message: 'prewarm timing',
      payload: expect.objectContaining({ headersMs: null, totalMs: 25_000 }),
    }),
  )
})

test('silent expiry prune logs the session, local reason and stage without content', async () => {
  const f = fixture()
  f.track()
  f.advance(3_600_001)
  f.manager.dropExpiredTargets()
  expect(f.logs).toContainEqual(
    expect.objectContaining({
      level: 'info',
      message: 'stopped warming session',
      payload: expect.objectContaining({
        session: f.input.sessionId,
        reason: 'retry-window-ended',
        stage: 'prune',
      }),
    }),
  )
  expect(JSON.stringify(f.logs)).not.toContain('PRIVATE PREFIX')
})

test('warm timing records response headers separately from response completion', async () => {
  const f = fixture(
    undefined,
    Object.assign(
      async () => {
        f.advance(120)
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                f.advance(80)
                controller.enqueue(new TextEncoder().encode('{}'))
                controller.close()
              }, 0)
            },
          }),
        )
      },
      { preconnect: fetch.preconnect },
    ),
  )
  f.track()
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.logs).toContainEqual(
    expect.objectContaining({
      message: 'prewarm timing',
      payload: expect.objectContaining({ headersMs: 120, totalMs: 200 }),
    }),
  )
})

test.each([
  ['cost-cap', 'cost-cap'],
  ['count-cap', 'count-cap'],
  ['deadline-missed', 'deadline-missed'],
  ['outside-hours', 'outside-hours'],
  ['session-ended', 'session-ended'],
  ['unsupported', 'unsupported'],
  ['schedule', 'outside-hours'],
  ['schedule-period-ended', 'outside-hours'],
  ['session-forgotten', 'session-ended'],
  ['stopped', 'session-ended'],
  ['retry-window-ended', 'deadline-missed'],
  ['retries-exhausted', 'deadline-missed'],
  ['expired', 'deadline-missed'],
  ['idle', 'cost-cap'],
  ['source-warm-idle-cap', 'cost-cap'],
  ...[
    'budget',
    'count',
    'evicted',
    'routing-moved',
    'account-changed',
    'credential-changed',
    'account-unavailable',
    'account-policy',
    'cachekeep-hybrid-inactive',
    'invalid-json',
    'no-breakpoints',
    'prewarm-validation-failed',
    'disabled',
    'policy-refused',
    'subagents-disabled',
  ].map((reason) => [reason, 'unsupported']),
])(
  'every reported stop reason is in the contract: %s -> %s',
  async (reason, expected) => {
    const f = fixture()
    f.track()
    f.advance(3_570_000)
    await f.manager.tick()
    Reflect.get(f.manager, 'removeTarget').call(
      f.manager,
      f.targets.get(f.input.sessionId),
      reason,
      f.now,
    )
    await detached()
    const stops = f.reports.filter(
      (report) => report.kind === 'cache_warm_stopped',
    )
    expect(stops).toHaveLength(1)
    expect(stops[0]!.reason).toBe(expected)
    expect(
      CACHE_WARM_STOP_REASONS.some((reason) => reason === stops[0]?.reason),
    ).toBe(true)
  },
)
