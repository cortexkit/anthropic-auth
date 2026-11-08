import { afterEach, expect, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import { CacheKeepManager } from '../cachekeep.ts'
import { NativeAccountRefusal } from '../native-account-refusal.ts'
import {
  reportSessionCacheTouch,
  reportSessionCacheWarmStopped,
  withSessionCacheReportHandoff,
} from '../session-cache-policy.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as unknown as Record<symbol, unknown>
const original = globals[key]
const managers: CacheKeepManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop()
  await detached()
  if (original === undefined) delete globals[key]
  else globals[key] = original
})
const detached = () => new Promise((resolve) => setTimeout(resolve, 0))

test('successful active warm reports its sent lifetime detached from the keeper', async () => {
  let now = 1_800_000_000_000
  const reports: unknown[] = []
  globals[key] = () => ({
    cache: () => ({ ttl: 'long', keep_warm: 'always' }),
    report: (payload: unknown) => {
      reports.push(payload)
      return new Promise(() => {})
    },
  })
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    cacheKeep: { enabled: false },
  }
  const manager = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => storage,
    fetchImpl: Object.assign(async () => Response.json({}), {
      preconnect: fetch.preconnect,
    }),
  })
  managers.push(manager)
  expect(
    manager.track({
      sessionId: 'ses_report',
      url: 'https://api.anthropic.com/v1/messages',
      bodyText: JSON.stringify({
        model: 'claude-opus-5-5',
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
      cacheMode: 'explicit',
      ttlMs: 3_600_000,
    }).tracked,
  ).toBe(true)
  now += 3_570_000
  await manager.tick()
  expect(reports).toEqual([])
  await detached()
  expect(reports).toEqual([
    { kind: 'cache_touch', at: now, ttl_ms: 3_600_000, source: 'warm' },
  ])
})

function fixture({
  source = false,
  fail = false,
  send,
}: {
  source?: boolean
  fail?: boolean
  send?: () => Promise<Response>
} = {}) {
  let now = Date.parse('2026-05-18T10:00:00Z')
  let policy = { ttl: 'long', keep_warm: 'always' } as Record<string, unknown>
  const reports: Record<string, unknown>[] = []
  globals[key] = () => ({
    cache: () => policy,
    report: (payload: Record<string, unknown>) => {
      reports.push(payload)
    },
  })
  const storage: AccountStorage = {
    version: 1,
    accounts: [],
    cacheKeep: { enabled: false },
  }
  const manager = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => storage,
    fetchImpl: Object.assign(
      async () =>
        send ? send() : Response.json({}, { status: fail ? 500 : 200 }),
      { preconnect: fetch.preconnect },
    ),
  })
  managers.push(manager)
  const input = {
    sessionId: 'ses_report',
    ownerSessionId: 'ses_report',
    oauthAccountId: 'main',
    oauthAccountIdentity: 'original',
    url: 'https://api.anthropic.com/v1/messages',
    bodyText: JSON.stringify({
      model: 'claude-opus-5-5',
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
    cacheMode: 'explicit',
    ttlMs: 3_600_000,
    ...(source && { sourceWarm: true }),
  }
  expect(manager.track(input).tracked).toBe(true)
  return {
    manager,
    reports,
    input,
    get now() {
      return now
    },
    setPolicy(value: Record<string, unknown>) {
      policy = value
    },
    async warm() {
      now += 3_570_000
      await manager.tick()
      await detached()
    },
    advance(ms: number) {
      now += ms
    },
  }
}

test.each([
  'off',
  'none',
  'session-ended',
  'stopped',
  'expired',
  'account-changed',
  'outside-hours',
])(
  'warm retirement reports exact %s lifecycle reason only once',
  async (reason) => {
    const f = fixture()
    await f.warm()
    expect(f.reports).toHaveLength(1)
    if (reason === 'off') {
      f.setPolicy({ ttl: 'long', keep_warm: 'off' })
      await f.manager.tick()
    } else if (reason === 'none') {
      f.setPolicy({ ttl: 'none', keep_warm: 'off' })
      await f.manager.tick()
    } else if (reason === 'session-ended') f.manager.untrack('ses_report')
    else if (reason === 'stopped') f.manager.stop()
    else if (reason === 'expired') {
      f.advance(3_600_000)
      await f.manager.tick()
    } else if (reason === 'account-changed')
      f.manager.track({ ...f.input, oauthAccountIdentity: 'replacement' })
    else {
      f.setPolicy({
        ttl: 'long',
        keep_warm: 'hours',
        hours: { from: '01:00', to: '02:00', tz: 'UTC' },
      })
      await f.manager.tick()
    }
    await detached()
    expect(f.reports[1]).toEqual({
      kind: 'cache_warm_stopped',
      at: f.now,
      reason: reason === 'off' || reason === 'none' ? 'unsupported' : reason,
    })
    f.manager.untrack('ses_report')
    await detached()
    expect(f.reports).toHaveLength(2)
  },
)

test.each([{ source: true }, { fail: true }])(
  'source and failed warms produce no active-cache report (%j)',
  async (options) => {
    const f = fixture(options)
    await f.warm()
    f.manager.untrack('ses_report')
    await detached()
    expect(f.reports).toEqual([])
  },
)

test('a captured but never warmed session has no stopped report', async () => {
  const f = fixture()
  f.manager.untrack('ses_report')
  await detached()
  expect(f.reports).toEqual([])
})

test.each(['hours', 'always'])(
  '%s count retirement says count-cap, never idle',
  async (mode) => {
    const f = fixture()
    f.setPolicy({
      ttl: 'long',
      keep_warm: mode,
      ...(mode === 'hours' && {
        hours: { from: '00:00', to: '23:59', tz: 'UTC' },
      }),
    })
    for (let n = 0; n < 24; n++) await f.warm()
    expect(
      f.reports.filter((report) => report.kind === 'cache_touch'),
    ).toHaveLength(24)
    expect(f.reports.at(-1)).toEqual({
      kind: 'cache_warm_stopped',
      at: f.now,
      reason: 'count-cap',
    })
  },
)

test('priced auto retires with cost-cap at equality', async () => {
  const f = fixture()
  f.setPolicy({ ttl: 'long', keep_warm: 'auto' })
  f.manager.recordAcceptedUsage('ses_report', f.input.bodyText, {
    cache_read_input_tokens: 1_000,
  })
  for (let n = 0; n < 39; n++) await f.warm()
  expect(
    f.reports.filter((report) => report.kind === 'cache_touch'),
  ).toHaveLength(39)
  expect(f.reports.at(-1)).toEqual({
    kind: 'cache_warm_stopped',
    at: f.now,
    reason: 'cost-cap',
  })
})

test('unpriced auto idle retirement is idle, not a 24-count stop', async () => {
  const f = fixture()
  f.setPolicy({ ttl: 'long', keep_warm: 'auto' })
  await f.warm()
  await f.warm()
  expect(f.reports).toEqual([
    {
      kind: 'cache_touch',
      at: f.now - 3_570_000,
      ttl_ms: 3_600_000,
      source: 'warm',
    },
    { kind: 'cache_warm_stopped', at: f.now, reason: 'idle' },
  ])
})

test('target-budget retirement reports evicted after an actual warm', async () => {
  const f = fixture()
  await f.warm()
  for (let n = 0; n < 32; n++)
    f.manager.track({ ...f.input, sessionId: `other-${n}` })
  await detached()
  expect(f.reports.at(-1)).toEqual({
    kind: 'cache_warm_stopped',
    at: f.now,
    reason: 'evicted',
  })
})

test.each([0, 300_000, 3_600_000])(
  'response touch uses exact applied %i lifetime and is not awaited',
  async (ttlMs) => {
    const reports: unknown[] = []
    globals[key] = () => ({
      report: (payload: unknown) => {
        reports.push(payload)
        return new Promise(() => {})
      },
    })
    reportSessionCacheTouch('ses_response', {
      at: 42,
      ttlMs,
      source: 'response',
    })
    expect(reports).toEqual([])
    await detached()
    expect(reports).toEqual([
      { kind: 'cache_touch', at: 42, ttl_ms: ttlMs, source: 'response' },
    ])
  },
)

test('throwing and absent report accessors do not escape the detached boundary', async () => {
  let reached = 0
  globals[key] = () => {
    reached++
    throw new Error('synthetic accessor failure')
  }
  reportSessionCacheTouch('ses_response', {
    at: 42,
    ttlMs: 0,
    source: 'response',
  })
  await detached()
  globals[key] = () => ({
    report: () => {
      reached++
      throw new Error('synthetic report failure')
    },
  })
  reportSessionCacheTouch('ses_response', {
    at: 42,
    ttlMs: 0,
    source: 'response',
  })
  await detached()
  delete globals[key]
  reportSessionCacheTouch('ses_response', {
    at: 42,
    ttlMs: 0,
    source: 'response',
  })
  await detached()
  expect(reached).toBe(2)
})

test('newest-touch redelivery belongs to the bridge, not an auth retry timer', async () => {
  const delivered: unknown[] = []
  let offline = true
  let pending: Record<string, unknown> | undefined
  let calls = 0
  // This fixture models the runner bridge contract: an ordinary report retries
  // only the newest unsent cache touch before sending its own payload.
  const bridge = {
    report(payload: Record<string, unknown>) {
      calls++
      if (payload.kind === 'cache_touch') pending = payload
      if (offline)
        return Promise.reject(new Error('synthetic disconnected bridge'))
      if (pending) {
        delivered.push(pending)
        pending = undefined
      }
      if (payload.kind !== 'cache_touch') delivered.push(payload)
    },
  }
  globals[key] = () => bridge
  reportSessionCacheTouch('ses_response', {
    at: 1,
    ttlMs: 300_000,
    source: 'response',
  })
  await detached()
  reportSessionCacheTouch('ses_response', {
    at: 2,
    ttlMs: 3_600_000,
    source: 'warm',
  })
  await detached()
  await detached()
  expect(calls).toBe(2)
  offline = false
  bridge.report({ kind: 'usage' })
  expect(delivered).toEqual([
    { kind: 'cache_touch', at: 2, ttl_ms: 3_600_000, source: 'warm' },
    { kind: 'usage' },
  ])
})

test('both report kinds wait for the outer response handoff, not just a timer tick', async () => {
  const reports: unknown[] = []
  let handedOff = false
  globals[key] = () => ({
    report: (payload: unknown) => {
      expect(handedOff).toBe(true)
      reports.push(payload)
      return new Promise(() => {})
    },
  })
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const respond = withSessionCacheReportHandoff(async () => {
    reportSessionCacheTouch('ses_response', {
      at: 42,
      ttlMs: 0,
      source: 'response',
    })
    reportSessionCacheWarmStopped('ses_response', {
      at: 42,
      reason: 'unsupported',
    })
    await pending
    return Response.json({ accepted: true })
  })
  const response = respond()
  await detached()
  expect(reports).toEqual([])
  release()
  expect((await response).status).toBe(200)
  handedOff = true
  expect(reports).toEqual([])
  await detached()
  expect(reports).toEqual([
    { kind: 'cache_touch', at: 42, ttl_ms: 0, source: 'response' },
    { kind: 'cache_warm_stopped', at: 42, reason: 'unsupported' },
  ])
})

test('a stale in-flight warm cannot report a touch for a replaced real request', async () => {
  let dispatched!: () => void
  let complete!: (response: Response) => void
  const sent = new Promise<void>((resolve) => {
    dispatched = resolve
  })
  const reply = new Promise<Response>((resolve) => {
    complete = resolve
  })
  const f = fixture({
    send: () => {
      dispatched()
      return reply
    },
  })
  const warming = f.warm()
  await sent
  f.manager.track({
    ...f.input,
    bodyText: f.input.bodyText.replace('Stable', 'New prefix'),
  })
  complete(Response.json({}))
  await warming
  expect(f.reports).toEqual([])
})

test('a failed host handoff discards queued and late response touches', async () => {
  const reports: unknown[] = []
  globals[key] = () => ({
    report: (payload: unknown) => {
      reports.push(payload)
    },
  })
  let late!: () => void
  const pending = new Promise<void>((resolve) => {
    late = resolve
  })
  const respond = withSessionCacheReportHandoff(async () => {
    reportSessionCacheTouch('ses_response', {
      at: 42,
      ttlMs: 300_000,
      source: 'response',
    })
    void pending.then(() =>
      reportSessionCacheTouch('ses_response', {
        at: 43,
        ttlMs: 300_000,
        source: 'response',
      }),
    )
    throw new Error('synthetic response handoff failed')
  })
  await expect(respond()).rejects.toThrow('synthetic response handoff failed')
  late()
  await detached()
  expect(reports).toEqual([])
})

test.each([
  'credential-changed',
  'account-unavailable',
  'account-policy',
] as const)(
  'native %s refusal maps to the exact shared stop reason',
  async (reason) => {
    let refused = false
    const f = fixture({
      send: async () => {
        if (refused) throw new NativeAccountRefusal(reason)
        return Response.json({})
      },
    })
    await f.warm()
    refused = true
    await f.warm()
    expect(f.reports.at(-1)).toEqual({
      kind: 'cache_warm_stopped',
      at: f.now,
      reason: reason === 'account-policy' ? 'unsupported' : 'account-changed',
    })
  },
)
