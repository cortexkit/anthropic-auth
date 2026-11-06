import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import {
  CACHE_KEEP_MAX_BODY_BYTES,
  CACHE_KEEP_MAX_TARGETS,
  CACHE_KEEP_PREWARM_LEAD_MS,
  CACHE_KEEP_TTL_MS,
  CacheKeepManager,
} from '../cachekeep.ts'
import type { CacheKeepTrackedSession } from '../cachekeep-registry.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import { NativeAccountRefusal } from '../native-account-refusal.ts'
import { NativeCustodyError } from '../native-custody.ts'

const storage: AccountStorage = {
  version: 1,
  accounts: [],
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: { enabled: true, always: true },
}
const body = JSON.stringify({
  system: [
    { type: 'text', text: 'PRIVATE', cache_control: { type: 'ephemeral' } },
  ],
})
let now: number
let logs: LogTestRecord[]
let level: ReturnType<typeof getLogLevel>
const managers: CacheKeepManager[] = []

beforeEach(() => {
  now = new Date('2026-05-18T10:00:00').getTime()
  logs = []
  level = getLogLevel()
  setLogLevel('info')
  __setLogTestSink((record) => logs.push(record))
})
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop()
  __setLogTestSink(null)
  setLogLevel(level)
})

function fixture(
  options: Partial<ConstructorParameters<typeof CacheKeepManager>[0]> = {},
) {
  const manager = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => storage,
    fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
    ...options,
  })
  managers.push(manager)
  const track = (id: string, bodyText = body, settings = storage) =>
    manager.track({
      sessionId: id,
      bodyText,
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      storage: settings,
      cacheMode: 'hybrid',
    })
  return { manager, track }
}

test('stopped registry entries survive without a body until cache expiry, then disappear', async () => {
  let published: readonly CacheKeepTrackedSession[] = []
  const { manager, track } = fixture({
    onTrackedSessionsChanged: (sessions) => {
      published = sessions
    },
  })
  track('stopped')
  const expiry = now + CACHE_KEEP_TTL_MS
  now += 1000
  manager.untrack('stopped')
  expect(manager.trackedRequest('stopped')).toBeUndefined()
  expect(manager.trackedCount()).toBe(0)
  expect(published).toEqual([
    {
      id: 'stopped',
      cacheExpiresAt: expiry,
      nextPrewarmAt: expiry - CACHE_KEEP_PREWARM_LEAD_MS,
      ttlMs: CACHE_KEEP_TTL_MS,
      lastTouchAt: now - 1000,
      lastTouchKind: 'response',
      warmStopped: { at: now, reason: 'session-forgotten' },
    },
  ])
  now = expiry - 1
  await manager.tick()
  expect(published).toHaveLength(1)
  now = expiry
  await manager.tick()
  expect(published).toEqual([])
})

test('registry facts use accepted response TTL and successful warm receipt time', async () => {
  const { manager } = fixture({
    onResponse: () => {
      now += 5000
    },
    fetchImpl: Object.assign(
      async () => {
        now += 100
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  })
  const accepted = now
  manager.track({
    sessionId: 'facts',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    bodyText: body,
    storage,
    cacheMode: 'hybrid',
    ttlMs: 300_000,
  })
  expect(manager.registrySessions()[0]).toMatchObject({
    ttlMs: 300_000,
    lastTouchAt: accepted,
    lastTouchKind: 'response',
    cacheExpiresAt: accepted + 300_000,
  })
  await manager.tick()
  expect(manager.registrySessions()[0]).toMatchObject({
    ttlMs: 3_600_000,
    lastTouchAt: accepted + 100,
    lastTouchKind: 'warm',
    cacheExpiresAt: accepted + 100 + 3_600_000,
  })
  expect(manager.registrySessions()[0]?.warmStopped).toBeUndefined()
})

test.each(['prepareHeaders', 'fetchImpl'] as const)(
  'a typed account refusal from %s removes the target with one closed warning',
  async (stage) => {
    let calls = 0
    const refuse = () => {
      calls++
      throw new NativeAccountRefusal('account-policy')
    }
    const f = fixture(
      stage === 'prepareHeaders'
        ? { prepareHeaders: refuse }
        : {
            fetchImpl: Object.assign(refuse, { preconnect: fetch.preconnect }),
          },
    )
    f.track('ses_policy')
    now += CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS
    await f.manager.tick()
    warning('ses_policy', 'account-policy', Buffer.byteLength(body))
    expect(f.manager.trackedCount()).toBe(0)
    now += 2 * 60_000
    await f.manager.tick()
    expect(calls).toBe(1)
    expect(logs).toHaveLength(1)
  },
)

test('transient prewarm retries get a third attempt before expiry and a later success keeps the target warm', async () => {
  let calls = 0
  const { manager, track } = fixture({
    fetchImpl: Object.assign(
      async () => {
        if (++calls < 3)
          throw new TypeError('synthetic temporary network failure')
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  })
  track('ses_retry')
  const expiry = now + CACHE_KEEP_TTL_MS
  expect(manager.trackedSessions()[0]?.nextPrewarmAt).toBe(expiry - 5 * 60_000)
  now = expiry - 5 * 60_000
  await manager.tick()
  for (let minute = 1; minute <= 4; minute++) {
    now = expiry - (5 - minute) * 60_000
    await manager.tick()
  }
  expect(calls).toBe(3)
  expect(manager.trackedSessions()[0]?.cacheExpiresAt).toBe(
    expiry - 3 * 60_000 + CACHE_KEEP_TTL_MS,
  )
  now = expiry + 60_000
  await manager.tick()
  expect(manager.trackedCount()).toBe(1)
  expect(calls).toBe(3)
})

test('a retry is bounded by the last safe start and is not scheduled once its request cannot fit', async () => {
  let calls = 0
  const { manager, track } = fixture({
    fetchImpl: Object.assign(
      async () => {
        calls++
        throw new TypeError('synthetic temporary network failure')
      },
      { preconnect: fetch.preconnect },
    ),
  })
  track('ses_deadline')
  const expiry = now + CACHE_KEEP_TTL_MS
  now = expiry - 45_000
  await manager.tick()
  // Thirty seconds for the request and five seconds of safety leave ten
  // seconds for a final retry, rather than the usual twenty-second delay.
  expect(manager.trackedSessions()[0]?.nextPrewarmAt).toBe(expiry - 35_000)
  now = expiry - 35_000
  await manager.tick()
  expect(calls).toBe(2)
  expect(manager.trackedCount()).toBe(0)
  now = expiry - 1
  await manager.tick()
  expect(calls).toBe(2)
})

test('a due attempt cannot start when less than its timeout and safety margin remain', async () => {
  let calls = 0
  const { manager, track } = fixture({
    prewarmTimeoutMs: 45_000,
    fetchImpl: Object.assign(
      async () => {
        calls++
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  })
  track('ses_late_tick')
  now += CACHE_KEEP_TTL_MS - 49_000
  await manager.tick()
  expect(calls).toBe(0)
  expect(manager.trackedCount()).toBe(0)
})

test('retry scheduling uses completion time rather than the tick start', async () => {
  const { manager, track } = fixture({
    fetchImpl: Object.assign(
      async () => {
        now += 30_000
        throw new TypeError('synthetic slow failure')
      },
      { preconnect: fetch.preconnect },
    ),
  })
  track('ses_slow_failure')
  now += CACHE_KEEP_TTL_MS - 60_000
  await manager.tick()
  expect(manager.trackedCount()).toBe(0)
})

test.each([
  [
    'abort',
    'send',
    'AbortError',
    () => {
      throw new DOMException('SECRET credential in abort', 'AbortError')
    },
  ],
  [
    'timeout',
    'send',
    'TimeoutError',
    () => {
      throw new DOMException('SECRET credential in timeout', 'TimeoutError')
    },
  ],
  [
    'socket reset',
    'send',
    'ECONNRESET',
    () => {
      throw Object.assign(new Error('SECRET socket credential'), {
        code: 'ECONNRESET',
      })
    },
  ],
  [
    'vault outage',
    'authorization',
    'unavailable',
    () => {
      const error = new NativeCustodyError('unavailable')
      error.message = 'SECRET vault credential'
      throw error
    },
  ],
  [
    'HTTP 500',
    'response',
    500,
    () =>
      Response.json(
        { error: { type: 'api_error', message: 'SECRET provider body' } },
        { status: 500 },
      ),
  ],
  [
    'response read',
    'response',
    'TypeError',
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('SECRET response credential'))
          },
        }),
      ),
  ],
] as const)(
  'prewarm warning classifies %s without copying messages or provider text',
  async (_name, stage, failureClass, fail) => {
    const fetchImpl = Object.assign(async () => fail() as Response, {
      preconnect: fetch.preconnect,
    })
    const { manager, track } = fixture(
      stage === 'authorization'
        ? {
            prepareHeaders: () => {
              fail()
              return new Headers()
            },
          }
        : { fetchImpl },
    )
    track('ses_diagnostic')
    now += CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS
    await manager.tick()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      level: 'warn',
      message: 'prewarm failed',
      payload: { stage, class: failureClass },
    })
    expect(JSON.stringify(logs)).not.toContain('SECRET')
  },
)

test.each(['prepareHeaders', 'fetchImpl'] as const)(
  'an unreachable vault in %s is retried without dropping the target',
  async (stage) => {
    let authorizations = 0
    let sends = 0
    const unreachable = () => {
      authorizations++
      throw new NativeCustodyError('unavailable')
    }
    const f = fixture({
      ...(stage === 'prepareHeaders'
        ? {
            prepareHeaders: unreachable,
            fetchImpl: Object.assign(
              async () => {
                sends++
                return Response.json({})
              },
              { preconnect: fetch.preconnect },
            ),
          }
        : {
            fetchImpl: Object.assign(unreachable, {
              preconnect: fetch.preconnect,
            }),
          }),
    })
    f.track('ses_outage')
    now += CACHE_KEEP_TTL_MS - CACHE_KEEP_PREWARM_LEAD_MS
    await f.manager.tick()
    expect(f.manager.trackedCount()).toBe(1)
    expect(authorizations).toBe(1)
    now = f.manager.trackedSessions()[0]!.nextPrewarmAt
    await f.manager.tick()
    expect(authorizations).toBe(2)
    expect(sends).toBe(0)
    expect(f.manager.trackedCount()).toBe(1)
    expect(logs).toHaveLength(2)
    for (const log of logs)
      expect(log).toMatchObject({
        message: 'prewarm failed',
        payload: { provider_error: { reason: 'transport' } },
      })
  },
)

function warning(session: string, reason: string, bodyBytes: number) {
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatchObject({
    level: 'warn',
    channel: 'cachekeep',
    payload: {
      session,
      reason,
      bodyBytes,
      budgetBytes: 67_108_864,
      targets: expect.any(Number),
      maxTargets: 32,
    },
  })
  expect(JSON.stringify(logs)).not.toContain('PRIVATE')
  expect(JSON.stringify(logs)).not.toContain('bodyText')
}

test('budget eviction counts real UTF-8 bodies near 64 MiB and evicts user LRU', () => {
  expect(CACHE_KEEP_MAX_BODY_BYTES).toBe(64 * 1024 * 1024)
  const { manager, track } = fixture()
  const large = 'é'.repeat(16 * 1024 * 1024)
  expect(track('first', large).tracked).toBe(true)
  now++
  expect(track('second', large).tracked).toBe(true)
  expect(manager.trackedCount()).toBe(2)
  expect(logs).toEqual([])
  // Refreshing first makes second least recently used, despite insertion age.
  now++
  track('first', large)
  now++
  track('new', 'x')
  warning('second', 'budget', 32 * 1024 * 1024)
  expect(logs[0]?.payload).toMatchObject({
    totalBodyBytes: 67_108_865,
    targets: 3,
    cacheExpiresAt: now - 2 + CACHE_KEEP_TTL_MS,
  })
  expect(manager.trackedSessions().map((s) => s.id)).toEqual(['first', 'new'])
})

test('count eviction warns once with expiry and capacity numbers', () => {
  const { manager, track } = fixture()
  for (let i = 0; i <= CACHE_KEEP_MAX_TARGETS; i++) track(`s${i}`)
  warning('s0', 'count', Buffer.byteLength(body))
  expect(logs[0]?.payload).toMatchObject({
    targets: 33,
    totalBodyBytes: 33 * Buffer.byteLength(body),
    cacheExpiresAt: now + CACHE_KEEP_TTL_MS,
  })
  expect(manager.trackedCount()).toBe(32)
})

test('target mirrors observe eviction, explicit removal and expiry', () => {
  const removed: string[] = []
  const changed: string[] = []
  const { manager, track } = fixture({
    onTargetChanged: (target) => {
      changed.push(target.id)
    },
    onTargetRemoved: (id) => {
      removed.push(id)
    },
  })
  for (let i = 0; i <= CACHE_KEEP_MAX_TARGETS; i++) track(`s${i}`)
  expect(removed).toEqual(['s0'])
  expect(changed).toHaveLength(33)
  manager.untrack('s1')
  expect(removed).toEqual(['s0', 's1'])
  now += CACHE_KEEP_TTL_MS
  expect(manager.dropExpiredTargets()).toBeUndefined()
  expect(removed).toHaveLength(33)
})

test('restoring a target preserves its remaining lifetime and uses the usual memory budget', () => {
  const removed: string[] = []
  const { manager, track } = fixture({
    onTargetRemoved: (id) => {
      removed.push(id)
    },
  })
  track('old', 'x'.repeat(CACHE_KEEP_MAX_BODY_BYTES))
  const cacheExpiresAt = now + 60_000
  const nextPrewarmAt = now - 60_000
  expect(
    manager.track({
      sessionId: 'restored',
      bodyText: body,
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      storage,
      cacheMode: 'hybrid',
      retained: { cacheExpiresAt, nextPrewarmAt },
    }).tracked,
  ).toBe(true)
  expect(removed).toEqual(['old'])
  expect(manager.trackedSessions()).toEqual([
    { id: 'restored', cacheExpiresAt, nextPrewarmAt },
  ])
})

test('imminent prewarm protection can evict the new session instead of the oldest', () => {
  const { manager, track } = fixture()
  track('due', 'x'.repeat(32 * 1024 * 1024))
  now += 54 * 60_000
  const result = track('new', 'x'.repeat(32 * 1024 * 1024 + 1))
  warning('new', 'budget', 32 * 1024 * 1024 + 1)
  expect(logs[0]?.payload).toMatchObject({
    selection: 'imminent-protected',
    cacheExpiresAt: now + CACHE_KEEP_TTL_MS,
  })
  expect(result.tracked).toBe(false)
  expect(manager.trackedSessions().map((s) => s.id)).toEqual(['due'])
})

test('count protection chooses the oldest non-imminent session', () => {
  const { manager, track } = fixture()
  track('due')
  now += 54 * 60_000
  for (let i = 0; i < CACHE_KEEP_MAX_TARGETS; i++) track(`new${i}`)
  warning('new0', 'count', Buffer.byteLength(body))
  expect(logs[0]?.payload?.selection).toBe('imminent-protected')
  expect(manager.trackedSessions().some((s) => s.id === 'due')).toBe(true)
})

test('successful prewarms do not refresh user LRU order', async () => {
  const { manager, track } = fixture()
  track('s0')
  now += 2 * 60_000
  for (let i = 1; i < CACHE_KEEP_MAX_TARGETS; i++) track(`s${i}`)
  now += 53 * 60_000
  await manager.tick()
  // Only s0 was warmed. It must remain older than the later user turns.
  track('new')
  warning('s0', 'count', Buffer.byteLength(body))
  expect(logs[0]?.payload?.selection).toBeUndefined()
})

test.each([
  ['invalid-json', 'PRIVATE{'],
  ['no-breakpoints', '{"system":"PRIVATE"}'],
])(
  'skipped prewarm warns once for %s with live expiry',
  async (reason, text) => {
    const { manager, track } = fixture()
    track('skipped', text)
    now += 55 * 60_000
    await manager.tick()
    await manager.tick()
    warning('skipped', reason, Buffer.byteLength(text))
    expect(logs[0]?.payload?.cacheExpiresAt).toBe(now + 5 * 60_000)
    expect(manager.trackedCount()).toBe(0)
  },
)

test('schedule period changes warn when pruning a still-live session', () => {
  const { track } = fixture()
  const scheduled: AccountStorage = {
    ...storage,
    cacheKeep: { enabled: true, startHour: 9, endHour: 17 },
  }
  track('scheduled', body, scheduled)
  now += 60_000
  track('always', body)
  warning('scheduled', 'schedule-period-ended', Buffer.byteLength(body))
})

test('expiry pruning is not a live removal and emits no warning', () => {
  const { manager, track } = fixture()
  track('expired')
  now += CACHE_KEEP_TTL_MS
  manager.dropExpiredTargets()
  expect(manager.trackedCount()).toBe(0)
  expect(logs).toEqual([])
})

test.each([
  ['missing-session', 'missing session id'],
  ['disabled', 'cachekeep disabled'],
  ['not-hybrid', 'cache mode is not hybrid'],
  ['body-budget', 'body exceeds cachekeep memory budget'],
  ['outside-schedule', 'outside configured schedule'],
])('tracking refusal reports %s and the returned reason', (code, reason) => {
  setLogLevel('debug')
  const { manager } = fixture()
  const text = code === 'body-budget' ? 'é'.repeat(34 * 1024 * 1024) : body
  const result = manager.track({
    sessionId: code === 'missing-session' ? undefined : 'refused',
    bodyText: text,
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    cacheMode: code === 'not-hybrid' ? 'explicit' : 'hybrid',
    storage:
      code === 'disabled'
        ? { ...storage, cacheKeep: { enabled: false } }
        : code === 'outside-schedule'
          ? {
              ...storage,
              cacheKeep: { enabled: true, startHour: 12, endHour: 13 },
            }
          : storage,
  })
  expect(result).toEqual({ tracked: false, reason })
  expect(logs).toHaveLength(1)
  // Only the over-budget refusal is a warning, with the sizes that explain
  // it; normal policy exclusions are a short debug line.
  expect(logs[0]).toMatchObject(
    code === 'body-budget'
      ? {
          level: 'warn',
          payload: {
            session: 'refused',
            reason: code,
            detail: reason,
            bodyBytes: Buffer.byteLength(text),
            budgetBytes: 67_108_864,
            targets: 0,
          },
        }
      : {
          level: 'debug',
          payload: {
            session: code === 'missing-session' ? null : 'refused',
            reason: code,
          },
        },
  )
  expect(JSON.stringify(logs)).not.toContain('PRIVATE')
})
