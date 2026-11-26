import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { AccountStorage } from '../accounts.ts'
import {
  CacheKeepManager,
  type CacheKeepTarget,
  type CacheKeepWarmReservation,
  isCacheKeepWarmWait,
} from '../cachekeep.ts'
import { CacheKeepClaim, CacheKeepStore } from '../cachekeep-store.ts'

const managers: CacheKeepManager[] = []
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop()
})

test('standalone always stops after 24 warms without a real request', async () => {
  let now = Date.parse('2026-05-18T10:00:00Z')
  let sends = 0
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }
  const manager = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => storage,
    fetchImpl: Object.assign(
      async () => {
        sends++
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  })
  managers.push(manager)
  manager.track({
    sessionId: 'ses_local_always',
    url: 'https://api.anthropic.com/v1/messages',
    bodyText: JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'Stable',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    }),
    headers: new Headers(),
    storage,
    cacheMode: 'hybrid',
  })
  for (let count = 0; count < 25; count++) {
    now += 55 * 60_000
    await manager.tick()
  }
  expect(sends).toBe(24)
  expect(manager.trackedCount()).toBe(0)
})

const routingKey = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const originalRouting = globals[routingKey]
afterEach(() => {
  if (originalRouting === undefined) delete globals[routingKey]
  else globals[routingKey] = originalRouting
})
type Policy = {
  ttl?: 'none' | 'short' | 'long'
  keep_warm?: 'off' | 'hours' | 'always' | 'auto'
  hours?: { from: string; to: string; tz: string }
}

function plannedFixture(
  options: Partial<ConstructorParameters<typeof CacheKeepManager>[0]> = {},
  initial: Policy = { ttl: 'short', keep_warm: 'always' },
) {
  let now = Date.parse('2026-05-18T10:00:00Z')
  let policy: Policy | null = initial
  let sends = 0
  const sentBodies: string[] = []
  let last: import('../cachekeep.ts').CacheKeepTarget | undefined
  let timerMs: number | undefined
  const timers = new Map<object, () => unknown>()
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    claudeCache: { enabled: false },
    cacheKeep: { enabled: false },
  }
  globals[routingKey] = () => ({ cache: () => policy })
  const manager = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => storage,
    setTimeoutImpl: ((callback: () => unknown, ms: number) => {
      timerMs = ms
      const id = { unref() {} }
      timers.set(id, callback)
      return id
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((id: object) => {
      timers.delete(id)
    }) as unknown as typeof clearTimeout,
    fetchImpl: Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        sentBodies.push(String(init?.body))
        sends++
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
    onTargetChanged: (target) => {
      last = target as import('../cachekeep.ts').CacheKeepTarget
    },
    ...options,
  })
  managers.push(manager)
  const bodyText = JSON.stringify({
    model: 'claude-opus-5-5',
    system: [
      {
        type: 'text',
        text: 'Stable',
        cache_control: {
          type: 'ephemeral',
          ...(initial.ttl === 'long' && { ttl: '1h' }),
        },
      },
    ],
  })
  const input = {
    sessionId: 'ses_planned',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    bodyText,
    storage,
    cacheMode: 'explicit',
    ttlMs: initial.ttl === 'long' ? 3_600_000 : 300_000,
  }
  return {
    manager,
    input,
    sentBodies,
    track: (extra: Partial<Parameters<CacheKeepManager['track']>[0]> = {}) =>
      manager.track({ ...input, ...extra }),
    advance(ms: number) {
      now += ms
    },
    setPolicy(value: Policy | null) {
      policy = value
    },
    get now() {
      return now
    },
    get sends() {
      return sends
    },
    get target() {
      return last!
    },
    get timerMs() {
      return timerMs
    },
    async due() {
      const callback = [...timers.values()][0]
      if (!callback) throw new Error('missing planned timer')
      await callback()
    },
  }
}

test.each([
  ['short', 150_000, 300_000],
  ['long', 3_300_000, 3_600_000],
] as const)(
  'planned %s uses a five-minute lead capped at half its lifetime',
  async (ttl, due, lifetime) => {
    const f = plannedFixture({}, { ttl, keep_warm: 'always' })
    expect(f.track().tracked).toBe(true)
    expect(f.timerMs).toBe(due)
    f.advance(due - 1)
    await f.manager.tick()
    expect(f.sends).toBe(0)
    f.advance(1)
    await f.due()
    expect(f.sends).toBe(1)
    expect(JSON.parse(f.sentBodies[0]!).system[0].cache_control).toEqual(
      ttl === 'long' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
    )
    expect(f.target.cacheExpiresAt).toBe(f.now + lifetime)
    expect(f.target.nextPrewarmAt).toBe(f.now + due)
  },
)

test('planned warms retry after 20, 40 and 60 seconds inside their five-minute lead', async () => {
  let attempts = 0
  const f = plannedFixture(
    {
      fetchImpl: Object.assign(
        async () => {
          if (++attempts < 4)
            throw new TypeError('synthetic temporary network failure')
          return Response.json({})
        },
        { preconnect: fetch.preconnect },
      ),
    },
    { ttl: 'long', keep_warm: 'always' },
  )
  f.track()
  const expiry = f.target.cacheExpiresAt
  f.advance(3_300_000)
  await f.manager.tick()
  expect(attempts).toBe(1)
  for (const delay of [20_000, 40_000, 60_000]) {
    const previous = attempts
    expect(f.target.nextPrewarmAt).toBe(f.now + delay)
    f.advance(delay - 1)
    await f.manager.tick()
    expect(attempts).toBe(previous)
    f.advance(1)
    await f.manager.tick()
    expect(attempts).toBe(previous + 1)
  }
  expect(f.now).toBe(expiry - 180_000)
  expect(f.manager.trackedCount()).toBe(1)
  expect(f.target.cacheExpiresAt).toBe(f.now + 3_600_000)
  expect(f.target.nextPrewarmAt).toBe(f.now + 3_300_000)
})

test('planned dispatch is refused inside the final safety margin', async () => {
  const f = plannedFixture()
  f.track()
  f.advance(295_000)
  await f.manager.tick()
  expect(f.sends).toBe(0)
  expect(f.manager.trackedCount()).toBe(0)
})

test.each(['off', 'none', 'missing', 'changed-ttl'] as const)(
  'fresh %s policy retires a previously captured prefix without replaying it',
  async (change) => {
    const f = plannedFixture()
    f.track()
    f.setPolicy(
      change === 'off'
        ? { keep_warm: 'off' }
        : change === 'none'
          ? { ttl: 'none', keep_warm: 'off' }
          : change === 'changed-ttl'
            ? { ttl: 'long', keep_warm: 'always' }
            : null,
    )
    f.advance(270_000)
    await f.manager.tick()
    expect(f.sends).toBe(0)
    expect(f.manager.trackedCount()).toBe(0)
  },
)

test('a policy changed during authorization cannot dispatch', async () => {
  const f = plannedFixture({
    prepareHeaders: (headers) => {
      f.setPolicy({ keep_warm: 'off' })
      return headers
    },
  })
  f.track()
  f.advance(270_000)
  await f.manager.tick()
  expect(f.sends).toBe(0)
  expect(f.manager.trackedCount()).toBe(0)
})

test('reservation finishes before dispatch and failures keep their slot without adding cost', async () => {
  const order: string[] = []
  const f = plannedFixture({
    reserveWarm: async (target) => {
      order.push(`saved:${target.policyState?.warmsSinceLastRealRequest}`)
      return true
    },
    fetchImpl: Object.assign(
      async () => {
        order.push('sent')
        return new Response('', { status: 503 })
      },
      { preconnect: fetch.preconnect },
    ),
  })
  f.track()
  f.advance(270_000)
  await f.manager.tick()
  expect(order).toEqual(['saved:1', 'sent'])
  expect(f.target.policyState).toMatchObject({
    warmsSinceLastRealRequest: 1,
    warmCostSoFar: 0,
    hasWarmed: false,
  })
})

test('failed durable reservation pauses dispatch and retries within expiry', async () => {
  let canWrite = false
  const f = plannedFixture({ reserveWarm: async () => canWrite })
  f.track()
  f.advance(270_000)
  await f.manager.tick()
  expect(f.sends).toBe(0)
  expect(f.manager.trackedCount()).toBe(1)
  canWrite = true
  f.advance(f.target.nextPrewarmAt - f.now)
  await f.manager.tick()
  expect(f.sends).toBe(1)
  expect(f.target.policyState?.warmsSinceLastRealRequest).toBe(1)
})

test('new real acceptance resets reserved count and cost but retains successful-warm history', async () => {
  const f = plannedFixture()
  f.track()
  f.advance(270_000)
  await f.manager.tick()
  expect(f.target.policyState).toMatchObject({
    warmsSinceLastRealRequest: 1,
    hasWarmed: true,
  })
  f.track()
  expect(f.target.policyState).toMatchObject({
    warmsSinceLastRealRequest: 0,
    warmCostSoFar: 0,
    hasWarmed: true,
    lastRealRequestAt: f.now,
  })
})

test.each(['hours', 'always'] as const)(
  'planned %s reserves number 24 and refuses number 25 after restart',
  async (mode) => {
    const f = plannedFixture(
      {},
      {
        ttl: 'short',
        keep_warm: mode,
        ...(mode === 'hours' && {
          hours: { from: '00:00', to: '23:59', tz: 'UTC' },
        }),
      },
    )
    f.track()
    const retained = {
      ...f.target,
      policyState: {
        ...f.target.policyState!,
        warmsSinceLastRealRequest: 23,
        hasWarmed: true,
      },
    }
    expect(f.track({ retained }).tracked).toBe(true)
    f.advance(270_000)
    await f.manager.tick()
    expect(f.sends).toBe(1)
    expect(f.manager.trackedCount()).toBe(0)
  },
)

test('known catalogue model always takes the priced auto path and stops before rewriting would be cheaper', async () => {
  const f = plannedFixture({}, { ttl: 'long', keep_warm: 'auto' })
  f.track()
  f.manager.recordAcceptedUsage('ses_planned', f.input.bodyText, {
    cache_read_input_tokens: 600,
    cache_creation_input_tokens: 400,
    input_tokens: 999_999,
  })
  expect(f.target.policyState?.prefixTokens).toBe(1000)
  for (let n = 0; n < 40; n++) {
    f.advance(3_570_000)
    await f.manager.tick()
  }
  // Opus's cache read costs 1/40 of a one-hour rewrite. Equality refuses warm 40.
  expect(f.sends).toBe(39)
  expect(f.manager.trackedCount()).toBe(0)
})

test.each([
  [false, 3_600_000],
  [true, 1_800_000],
] as const)(
  'unpriced auto uses the exact default idle boundary (subagent=%s)',
  async (isSubagent, idleMs) => {
    const f = plannedFixture({}, { ttl: 'short', keep_warm: 'auto' })
    const bodyText = f.input.bodyText.replace(
      'claude-opus-5-5',
      'claude-no-catalogue-facts',
    )
    f.track({ bodyText, isSubagent })
    f.manager.recordAcceptedUsage('ses_planned', bodyText, {
      cache_read_input_tokens: 1000,
    })
    const start = f.now
    while (f.now + 270_000 < start + idleMs) {
      f.advance(270_000)
      await f.manager.tick()
    }
    f.advance(start + idleMs - f.now)
    await f.manager.tick()
    expect(f.manager.trackedCount()).toBe(1)
    f.advance(1)
    await f.manager.tick()
    expect(f.manager.trackedCount()).toBe(0)
  },
)

test.each([
  ['10:02', '10:10', 'UTC', true],
  ['09:00', '10:02', 'UTC', false],
  ['23:00', '11:00', 'UTC', true],
  ['12:00', '13:00', 'Europe/Istanbul', false],
] as const)(
  'hours window %s-%s in %s checks due time as well as current time',
  async (from, to, tz, allowed) => {
    const f = plannedFixture(
      {},
      { ttl: 'short', keep_warm: 'hours', hours: { from, to, tz } },
    )
    expect(f.track().tracked).toBe(allowed)
    f.advance(150_000)
    await f.manager.tick()
    expect(f.sends).toBe(Number(allowed))
  },
)

test('restart metadata requiring a real request cannot reset a planned or local always count', () => {
  const f = plannedFixture()
  const retained = {
    cacheExpiresAt: f.now + 300_000,
    nextPrewarmAt: f.now + 270_000,
    ttlMs: 300_000,
    policyState: {
      ownerSessionId: f.input.sessionId,
      planned: false,
      lastRealRequestAt: f.now - 60_000,
      warmsSinceLastRealRequest: 24,
      warmCostSoFar: 0,
      hasWarmed: true,
      needsRealRequest: true,
    },
  }
  expect(f.track({ retained })).toEqual({
    tracked: false,
    reason: 'unsupported',
  })
  f.setPolicy(null)
  expect(
    f.track({
      retained,
      storage: {
        version: 1,
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
      },
    }),
  ).toEqual({ tracked: false, reason: 'unsupported' })
})

test.each([false, true])(
  'legacy restore starts a fresh 24-warm count using its last touch (planned=%s)',
  async (planned) => {
    const f = plannedFixture({}, { ttl: 'long', keep_warm: 'always' })
    if (!planned) {
      f.setPolicy(null)
      Object.assign(f.input.storage, {
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
      })
    }
    const lastTouchAt = f.now - 60_000
    const interval = 3_300_000
    expect(
      f.track({
        cacheMode: 'hybrid',
        retained: {
          cacheExpiresAt: lastTouchAt + 3_600_000,
          nextPrewarmAt: lastTouchAt + interval,
          ttlMs: 3_600_000,
          lastTouchAt,
          lastTouchKind: 'warm',
        },
      }),
    ).toEqual({ tracked: true })
    expect(f.target.policyState).toEqual({
      ownerSessionId: f.input.sessionId,
      planned,
      ...(planned && { policy: { ttl: 'long', keep_warm: 'always' } }),
      lastRealRequestAt: lastTouchAt,
      warmsSinceLastRealRequest: 0,
      warmCostSoFar: 0,
      hasWarmed: false,
    })
    for (let count = 1; count <= 24; count++) {
      f.advance(count === 1 ? interval - 60_000 : interval)
      await f.manager.tick()
      expect(f.sends).toBe(count)
    }
    f.advance(interval)
    await f.manager.tick()
    expect(f.sends).toBe(24)
    expect(f.manager.trackedCount()).toBe(0)
  },
)

test('legacy planned auto starts with zero admitted cost', async () => {
  const f = plannedFixture({}, { ttl: 'short', keep_warm: 'auto' })
  expect(
    f.track({
      retained: {
        cacheExpiresAt: f.now + 240_000,
        nextPrewarmAt: f.now + 210_000,
        ttlMs: 300_000,
        lastTouchAt: f.now - 60_000,
        lastTouchKind: 'response',
      },
    }),
  ).toEqual({ tracked: true })
  expect(f.target.policyState?.warmCostSoFar).toBe(0)
  f.advance(210_000)
  await f.manager.tick()
  expect(f.sends).toBe(1)
  expect(f.target.policyState).toMatchObject({
    planned: true,
    warmCostSoFar: 0,
    warmsSinceLastRealRequest: 1,
    hasWarmed: true,
  })
})

test('accepted round activity resets the warm budget and idle clock without touching the prefix', async () => {
  const f = plannedFixture({}, { ttl: 'long', keep_warm: 'auto' })
  const route = {
    url: f.input.url,
    accountId: 'first',
    accountIdentity: 'login',
    requestedModel: 'claude-opus-5-5',
  }
  f.track({
    oauthAccountId: route.accountId,
    oauthAccountIdentity: route.accountIdentity,
  })
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.sends).toBe(1)
  expect(f.target.policyState?.warmsSinceLastRealRequest).toBe(1)
  const original = structuredClone(f.target)
  f.advance(1_800_000)
  f.manager.recordRoundActivity(f.input.sessionId, route)
  expect(f.target).toMatchObject({
    bodyText: original.bodyText,
    lastTouchAt: original.lastTouchAt,
    cacheExpiresAt: original.cacheExpiresAt,
    nextPrewarmAt: original.nextPrewarmAt,
    policyState: {
      lastRealRequestAt: original.policyState!.lastRealRequestAt,
      warmsSinceLastRealRequest: 0,
      warmCostSoFar: 0,
    },
  })
  f.advance(1_770_000)
  await f.manager.tick()
  expect(f.sends).toBe(2)
  f.manager.recordRoundActivity(f.input.sessionId, {
    ...route,
    accountId: 'second',
  })
  expect(f.manager.trackedRequest(f.input.sessionId)).toBeUndefined()
  expect(f.manager.warming(f.input.sessionId)).toEqual({
    on: false,
    stopReason: 'unsupported',
  })
})

test('a late warm cannot advance the newer target after a real request replaces it', async () => {
  let release!: () => void
  let started!: () => void
  const beginning = new Promise<void>((resolve) => {
    started = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = plannedFixture({
    fetchImpl: Object.assign(
      async () => {
        started()
        await pending
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  })
  f.track()
  f.advance(270_000)
  const warming = f.manager.tick()
  await beginning
  f.track()
  const replacement = f.target
  release()
  await warming
  expect(f.target).toBe(replacement)
  expect(f.target.policyState).toMatchObject({
    warmsSinceLastRealRequest: 0,
    hasWarmed: false,
    lastRealRequestAt: f.now,
  })
})

test('an in-flight warm advances the kept prefix when a fallback step completes', async () => {
  const started = Promise.withResolvers<true>()
  const response = Promise.withResolvers<Response>()
  const f = plannedFixture({
    fetchImpl: Object.assign(
      async () => {
        started.resolve(true)
        return response.promise
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const route = {
    url: f.input.url,
    accountId: 'first',
    accountIdentity: 'login',
    requestedModel: 'claude-opus-5-5',
  }
  f.track({
    oauthAccountId: route.accountId,
    oauthAccountIdentity: route.accountIdentity,
  })
  f.advance(270_000)
  const warming = f.manager.tick()
  try {
    expect(await Promise.race([started.promise, warming])).toBe(true)
    f.manager.recordRoundActivity(f.input.sessionId, route)
  } finally {
    response.resolve(Response.json({}))
    await warming
  }
  expect(f.target).toMatchObject({
    lastTouchAt: f.now,
    lastTouchKind: 'warm',
    cacheExpiresAt: f.now + 300_000,
    nextPrewarmAt: f.now + 150_000,
    policyState: { warmsSinceLastRealRequest: 0, warmCostSoFar: 0 },
  })
})

test('round activity retires the kept prefix after a requested model switch', async () => {
  const f = plannedFixture()
  const route = {
    url: f.input.url,
    accountId: 'first',
    accountIdentity: 'login',
    requestedModel: 'claude-fable-5-2',
  }
  f.track({
    oauthAccountId: route.accountId,
    oauthAccountIdentity: route.accountIdentity,
  })
  f.manager.recordRoundActivity(f.input.sessionId, route)
  f.advance(270_000)
  await f.manager.tick()
  expect(f.manager.trackedRequest(f.input.sessionId)).toBeUndefined()
  expect(f.sends).toBe(0)
})

test('planned timeout is clipped to expiry minus safety and authorization cannot consume the margin', async () => {
  const deadlines: number[] = []
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    deadlines.push(ms)
    return new AbortController().signal
  })
  try {
    const f = plannedFixture({
      prepareHeaders: (headers) => {
        f.advance(25_000)
        return headers
      },
    })
    f.track()
    f.advance(270_000)
    await f.manager.tick()
    expect(deadlines).toEqual([25_000])
    expect(f.sends).toBe(0)
    expect(f.manager.trackedCount()).toBe(0)
  } finally {
    timeout.mockRestore()
  }
})

test('a restored hours target requiring a real request cannot acquire a planned baseline', async () => {
  const f = plannedFixture()
  f.setPolicy(null)
  const hour = new Date(f.now).getHours()
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, startHour: hour, endHour: (hour + 2) % 24 },
  }
  const retained = {
    cacheExpiresAt: f.now + 300_000,
    nextPrewarmAt: f.now + 270_000,
    ttlMs: 300_000,
    policyState: {
      ownerSessionId: f.input.sessionId,
      planned: false,
      lastRealRequestAt: f.now - 60_000,
      warmsSinceLastRealRequest: 24,
      warmCostSoFar: 0,
      hasWarmed: true,
      needsRealRequest: true,
    },
  }
  expect(f.track({ retained, storage, cacheMode: 'hybrid' }).tracked).toBe(true)
  f.setPolicy({ ttl: 'short', keep_warm: 'always' })
  f.advance(270_000)
  await f.manager.tick()
  expect(f.sends).toBe(0)
  expect(f.manager.trackedCount()).toBe(0)
  expect(f.track().tracked).toBe(true)
})

test('ttl only keeps local off instead of inventing planned auto', async () => {
  const f = plannedFixture({}, { ttl: 'long' })
  expect(f.track({ cacheMode: 'hybrid' }).tracked).toBe(false)
  f.advance(3_300_000)
  await f.manager.tick()
  expect(f.sends).toBe(0)
})

test('ttl only keeps local always cadence and its 24 reservation cap', async () => {
  const f = plannedFixture({}, { ttl: 'long' })
  Object.assign(f.input.storage, {
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  })
  expect(f.track({ cacheMode: 'hybrid' }).tracked).toBe(true)
  // Local one-hour targets now get a precise timer at the unchanged 55-minute due time.
  expect(f.timerMs).toBe(3_300_000)
  expect(f.target.nextPrewarmAt).toBe(f.now + 3_300_000)
  for (let n = 0; n < 25; n++) {
    f.advance(3_300_000)
    await f.manager.tick()
  }
  expect(f.sends).toBe(24)
  expect(f.manager.trackedCount()).toBe(0)
})

test('explicit auto selects the planned path despite local off', async () => {
  const f = plannedFixture({}, { ttl: 'short', keep_warm: 'auto' })
  expect(f.track().tracked).toBe(true)
  f.manager.recordAcceptedUsage(f.input.sessionId, f.input.bodyText, {
    cache_read_input_tokens: 1_000,
  })
  expect(f.timerMs).toBe(150_000)
  f.advance(150_000)
  await f.due()
  expect(f.sends).toBe(1)
  expect(f.target.policyState?.planned).toBe(true)
})

test('ttl-only short never stretches a replay to the local one-hour cadence', async () => {
  const f = plannedFixture({}, { ttl: 'short' })
  Object.assign(f.input.storage, {
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  })
  expect(f.track({ cacheMode: 'hybrid' }).tracked).toBe(true)
  expect(f.target.cacheExpiresAt).toBe(f.now + 300_000)
  expect(f.target.nextPrewarmAt).toBe(f.now + 3_300_000)
  f.advance(300_000)
  await f.manager.tick()
  expect(f.sends).toBe(0)
  expect(f.manager.trackedCount()).toBe(0)
})

test('auto keeps the real response pricing baseline and charges the admitted cost', async () => {
  const f = plannedFixture(
    {
      fetchImpl: Object.assign(
        async () =>
          Response.json({
            usage: {
              input_tokens: 900_000,
              cache_read_input_tokens: 9_999,
              cache_creation_input_tokens: 1,
            },
          }),
        { preconnect: fetch.preconnect },
      ),
    },
    { ttl: 'long', keep_warm: 'auto' },
  )
  expect(f.track().tracked).toBe(true)
  f.manager.recordAcceptedUsage('ses_planned', f.input.bodyText, {
    input_tokens: 123_456,
    cache_read_input_tokens: 1_000,
    cache_creation_input_tokens: 100,
  })
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.target.policyState).toMatchObject({
    prefixTokens: 1_100,
    inputTokens: 124_556,
    warmCostSoFar: 220,
  })
})

test('restoring an unresolved dispatch accounts for a successful warm before its coalesced flush', async () => {
  let reserved: import('../cachekeep.ts').CacheKeepTarget | undefined
  const f = plannedFixture(
    {
      reserveWarm: async (target) => {
        reserved = structuredClone(target)
        return true
      },
    },
    { ttl: 'long', keep_warm: 'auto' },
  )
  expect(f.track().tracked).toBe(true)
  f.manager.recordAcceptedUsage('ses_planned', f.input.bodyText, {
    cache_read_input_tokens: 1_000,
  })
  f.target.policyState!.warmCostSoFar = 7_600
  f.target.policyState!.warmsSinceLastRealRequest = 38
  f.advance(3_570_000)
  await f.manager.tick()
  expect(f.sends).toBe(1)
  expect(reserved).toBeDefined()
  const restored = plannedFixture({}, { ttl: 'long', keep_warm: 'auto' })
  restored.advance(f.now - restored.now)
  expect(reserved!.policyState).toMatchObject({
    warmCostSoFar: 7_600,
    pendingWarmCost: 200,
  })
  expect(
    restored.track({ retained: { ...reserved!, nextPrewarmAt: restored.now } })
      .tracked,
  ).toBe(false)
  await restored.manager.tick()
  expect(restored.sends).toBe(0)
})

test('a known failed warm clears its unresolved admitted cost durably without spending it', async () => {
  let settled: import('../cachekeep.ts').CacheKeepPolicyState | undefined
  const f = plannedFixture(
    {
      fetchImpl: Object.assign(async () => Response.json({}, { status: 503 }), {
        preconnect: fetch.preconnect,
      }),
      settleWarm: async (target) => {
        settled = structuredClone(target.policyState)
        return true
      },
    },
    { ttl: 'long', keep_warm: 'auto' },
  )
  f.track()
  f.manager.recordAcceptedUsage('ses_planned', f.input.bodyText, {
    cache_read_input_tokens: 1_000,
  })
  f.advance(3_570_000)
  await f.manager.tick()
  expect(settled).toMatchObject({
    warmCostSoFar: 0,
    warmsSinceLastRealRequest: 1,
  })
  expect(settled?.pendingWarmCost).toBeUndefined()
})

test.each(['ownership-unverified', 'not-owner'] as const)(
  'a refunded %s warm cannot leave a charged usage snapshot to drain',
  async (veto) => {
    const root = await mkdtemp(join(tmpdir(), 'cachekeep-refund-'))
    const store = new CacheKeepStore({
      root,
      storageId: 'refund',
      host: 'opencode1',
      pluginVersion: 'test',
      sessionClaims: true,
    })
    const peer = new CacheKeepStore({
      root,
      storageId: 'refund',
      host: 'opencode1',
      pluginVersion: 'test',
      sessionClaims: true,
    })
    const reserving = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let target!: Readonly<CacheKeepTarget>
    let outcome: CacheKeepWarmReservation | undefined
    let sends = 0
    const f = plannedFixture({
      onTargetChanged: (entry) => {
        if (target) store.changed(entry, veto === 'not-owner')
        target = entry
      },
      reserveWarm: async (entry) => {
        const reservation = store.reserveWarm(entry)
        if (veto === 'ownership-unverified') {
          reserving.resolve()
          saveUsage()
        }
        outcome = await reservation
        return outcome
      },
      settleWarm: (entry) => store.reserveWarm(entry),
    })
    function saveUsage() {
      expect(target.policyState?.warmsSinceLastRealRequest).toBe(24)
      expect(target.policyState?.pendingWarmCost).toBeGreaterThan(0)
      f.manager.recordAcceptedUsage(target.id, target.bodyText, {
        cache_read_input_tokens: 2000,
      })
    }
    let restoreAcquire: (() => void) | undefined
    let warming: Promise<unknown> | undefined
    try {
      expect(f.track().tracked).toBe(true)
      Object.assign(target.policyState!, {
        warmsSinceLastRealRequest: 23,
        prefixTokens: 1000,
        inputTokens: 1000,
      })
      if (veto === 'not-owner') {
        peer.changed({
          ...target,
          policyState: {
            ...target.policyState!,
            lastRealRequestAt: f.now - 1000,
          },
        })
        await peer.drain()
      }
      store.changed(target)
      await store.drain()
      expect(store.isCommitted(target.id)).toBe(veto === 'ownership-unverified')
      if (veto === 'not-owner') {
        const acquire = CacheKeepClaim.prototype.acquire
        // The first claim check must see the peer; the usage update queues
        // another acquisition that can succeed once the peer releases.
        const acquiring = spyOn(
          CacheKeepClaim.prototype,
          'acquire',
        ).mockImplementationOnce(async function (
          this: CacheKeepClaim,
          ...args
        ) {
          const owned = await acquire.apply(this, args)
          reserving.resolve()
          await resume.promise
          return owned
        })
        restoreAcquire = () => acquiring.mockRestore()
      }
      f.advance(150_000)
      const { signal } = new AbortController()
      warming = f.manager
        .reserveWarmDispatch(target, async () => sends++, signal)
        .catch((error: unknown) => error)
      if (veto === 'not-owner') {
        await Promise.race([reserving.promise, warming])
        saveUsage()
        f.manager.stop()
        await peer.releaseClaims(() => true)
        resume.resolve()
      }
      expect(isCacheKeepWarmWait(await warming)).toBe(true)
      // A caller can stop after the store refuses the reservation, before a tick republishes its state.
      f.manager.stop()
      expect(outcome).toBe(veto)
      expect(sends).toBe(0)
      expect(target.policyState?.warmsSinceLastRealRequest).toBe(23)
      await store.drain()
      const [file] = (await readdir(store.directory)).filter((name) =>
        name.endsWith('.json.gz'),
      )
      const saved = JSON.parse(
        gunzipSync(await readFile(join(store.directory, file!))).toString(),
      ).policyState
      expect(saved).toMatchObject({
        warmsSinceLastRealRequest: 23,
        prefixTokens: 2000,
      })
      expect(saved.pendingWarmCost).toBeUndefined()
    } finally {
      resume.resolve()
      await warming
      restoreAcquire?.()
      await store.drain()
      await store.releaseClaims(() => true)
      await peer.releaseClaims(() => true)
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('accepted JSON body and known usage persist together while duplicate observations stay quiet', () => {
  const states: Array<{ prefixTokens?: number; inputTokens?: number }> = []
  const f = plannedFixture(
    {
      onTargetChanged: (target) => {
        states.push({
          prefixTokens: target.policyState?.prefixTokens,
          inputTokens: target.policyState?.inputTokens,
        })
      },
    },
    { ttl: 'long', keep_warm: 'auto' },
  )
  const usage = {
    cache_read_input_tokens: 1_000,
    cache_creation_input_tokens: 100,
    input_tokens: 90_000,
  }
  expect(f.track({ acceptedUsage: usage }).tracked).toBe(true)
  expect(states).toEqual([{ prefixTokens: 1_100, inputTokens: 91_100 }])
  f.manager.recordAcceptedUsage('ses_planned', f.input.bodyText, usage)
  expect(states).toHaveLength(1)
  f.manager.recordAcceptedUsage('ses_planned', f.input.bodyText, {
    ...usage,
    cache_creation_input_tokens: 101,
  })
  expect(states).toEqual([
    { prefixTokens: 1_100, inputTokens: 91_100 },
    { prefixTokens: 1_101, inputTokens: 91_101 },
  ])
})
