import { afterEach, expect, spyOn, test } from 'bun:test'
import { CACHE_WARM_STOP_REASONS } from '@cortexkit/common-auth/routing-accessor'
import type { AccountStorage } from '../accounts.ts'
import { CacheKeepManager, type CacheKeepTarget } from '../cachekeep.ts'
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
      stops[0]?.reason === 'deadline-missed' ||
        CACHE_WARM_STOP_REASONS.some((reason) => reason === stops[0]?.reason),
    ).toBe(true)
  },
)
