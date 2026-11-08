import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CacheKeepManager,
  sessionCacheActivity,
} from '@cortexkit/anthropic-auth-core'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import {
  sendPiPrimeRequest,
  startPiCacheKeepSession,
  stopPiCacheKeep,
  streamCortexKitAnthropic,
} from '../stream.ts'
import { normalizeContext } from '../transcript.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from './native-fixture.ts'

const routingKey = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const previousRouting = globals[routingKey]
const originalFetch = globalThis.fetch
const cleanups: Array<() => void | Promise<void>> = []
const detached = () => new Promise((resolve) => setTimeout(resolve, 0))
afterEach(async () => {
  await stopPiCacheKeep()
  await detached()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  globalThis.fetch = originalFetch
  if (previousRouting === undefined) delete globals[routingKey]
  else globals[routingKey] = previousRouting
})
const model = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 200_000,
  maxTokens: 128,
} as any
const context = () =>
  normalizeContext({
    systemPrompt: 'Stable',
    tools: [],
    messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
  } as any) as any
function accepted() {
  return new Response(
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_pi_report","usage":{"input_tokens":90000,"cache_read_input_tokens":7,"cache_creation_input_tokens":3,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"cache_creation_input_tokens":4,"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_pi_report',
      },
    },
  )
}
async function fixture(api = false, keepWarm = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-cache-reports-'))
  const storagePath = join(directory, 'anthropic-auth.json')
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const envKeys = [
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_CODING_AGENT_DIR',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  ]
  const previousEnv = envKeys.map((key) => [key, process.env[key]] as const)
  cleanups.push(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  const checkedAt = Date.now()
  const quota = (remainingPercent: number) => ({
    checkedAt,
    five_hour: {
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      checkedAt,
    },
    seven_day: {
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      checkedAt,
    },
  })
  await saveNativePiFixture(
    {
      version: 1,
      mainAccountId: 'main-account',
      main: { type: 'opencode', provider: 'anthropic' },
      fallbackOn: [401, 403, 429],
      accounts: api
        ? [
            {
              id: 'oauth-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'synthetic-refresh',
              expires: checkedAt + 3_600_000,
              quota: quota(100),
            },
            {
              id: 'paid',
              type: 'api',
              baseURL: 'https://provider.example/anthropic',
              apiKey: 'synthetic-paid-key',
            },
          ]
        : [],
      routing: { mode: 'sticky-balanced' },
      quota: {
        enabled: true,
        checkIntervalMinutes: 5,
        minimumRemaining: { five_hour: 1, seven_day: 1 },
        failClosedOnUnknownQuota: true,
        mainQuota: { ...quota(api ? 0 : 100), accountIdentity: 'main-account' },
        mainQuotaCheckedAt: checkedAt,
      },
      claudeCache: { enabled: true, mode: 'hybrid' },
      cacheKeep: { enabled: keepWarm, always: true },
    },
    storagePath,
  )
  cleanups.push(() => closePiNativeRuntime(storagePath))
  await startPiCacheKeepSession(storagePath, 'ses_pi_reports')
  return { storagePath }
}

test.each([
  { ttl: 'none', ttlMs: 0 },
  { ttl: 'short', ttlMs: 300_000 },
  { ttl: 'long', ttlMs: 3_600_000 },
])(
  'Pi accepted OAuth reports exact applied lifetime with local warming off (%j)',
  async ({ ttl, ttlMs }) => {
    await fixture()
    const reports: Record<string, unknown>[] = []
    let streamCreated = false
    globals[routingKey] = () => ({
      cache: () => ({ ttl, keep_warm: 'off' }),
      report: (payload: Record<string, unknown>) => {
        if (
          payload.kind !== 'cache_touch' &&
          payload.kind !== 'cache_warm_stopped'
        )
          return
        expect(streamCreated).toBe(true)
        reports.push(payload)
        return new Promise(() => {})
      },
    })
    globalThis.fetch = mock(async (input: any) => {
      if (String(input).includes('/api/claude_cli/bootstrap'))
        return Response.json({
          oauth_account: { account_uuid: fixtureAccountIdentity('main') },
        })
      return accepted()
    }) as unknown as typeof fetch
    const usage = spyOn(CacheKeepManager.prototype, 'recordAcceptedUsage')
    cleanups.push(() => usage.mockRestore())
    const before = Date.now()
    const stream = streamCortexKitAnthropic(model, context(), {
      apiKey: 'sk-ant-oat01-main-access',
      sessionId: 'ses_pi_reports',
    })
    streamCreated = true
    const result = await stream.result()
    expect(result.errorMessage).toBeUndefined()
    expect(result.stopReason).toBe('stop')
    await stopPiCacheKeep()
    await detached()
    expect(reports).toEqual([
      {
        kind: 'cache_touch',
        at: expect.any(Number),
        ttl_ms: ttlMs,
        source: 'response',
      },
    ])
    expect(reports[0]!.at as number).toBeGreaterThanOrEqual(before)
    expect(reports[0]!.at as number).toBeLessThanOrEqual(Date.now())
    expect(usage).toHaveBeenCalledWith('ses_pi_reports', expect.any(String), {
      input_tokens: 90000,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      output_tokens: 0,
    })
    expect(usage).toHaveBeenCalledWith('ses_pi_reports', expect.any(String), {
      input_tokens: 90000,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 4,
      output_tokens: 1,
    })
  },
)

test('Pi API-key acceptance has no runner cache report', async () => {
  await fixture(true)
  const reports: unknown[] = []
  globals[routingKey] = () => ({
    cache: () => ({ ttl: 'long', keep_warm: 'always' }),
    report: (payload: Record<string, unknown>) => {
      if (
        payload.kind === 'cache_touch' ||
        payload.kind === 'cache_warm_stopped'
      )
        reports.push(payload)
    },
  })
  const authorizations: string[] = []
  globalThis.fetch = mock(async (input: any, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/api/claude_cli/bootstrap'))
      return Response.json({
        oauth_account: { account_uuid: fixtureAccountIdentity('main') },
      })
    if (url.includes('/api/oauth/usage'))
      return Response.json({
        five_hour: { utilization: 100 },
        seven_day: { utilization: 100 },
      })
    if (!url.includes('/v1/messages')) return Response.json({})
    const authorization = new Headers(init?.headers).get('authorization') ?? ''
    authorizations.push(authorization)
    return authorization === 'Bearer synthetic-paid-key'
      ? accepted()
      : Response.json({ error: { type: 'rate_limit_error' } }, { status: 429 })
  }) as unknown as typeof fetch
  const result = await streamCortexKitAnthropic(model, context(), {
    apiKey: 'sk-ant-oat01-main-access',
    sessionId: 'ses_pi_api_report',
  }).result()
  expect(result.errorMessage).toBeUndefined()
  expect(result.stopReason).toBe('stop')
  expect(authorizations.at(-1)).toBe('Bearer synthetic-paid-key')
  await detached()
  expect(reports).toEqual([])
})

test('Pi Prime is stateless and emits no session cache report', async () => {
  const f = await fixture()
  const reports: unknown[] = []
  globals[routingKey] = () => ({
    report: (payload: Record<string, unknown>) => {
      if (
        payload.kind === 'cache_touch' ||
        payload.kind === 'cache_warm_stopped'
      )
        reports.push(payload)
    },
  })
  globalThis.fetch = mock(async (input: any) =>
    String(input).includes('/api/claude_cli/bootstrap')
      ? Response.json({
          oauth_account: { account_uuid: fixtureAccountIdentity('main') },
        })
      : accepted(),
  ) as unknown as typeof fetch
  const response = await sendPiPrimeRequest({
    native: getPiNativeRuntime(f.storagePath),
    storagePath: f.storagePath,
    accountId: 'main',
    signal: new AbortController().signal,
    beforeSend: async () => {},
    onServed: () => {},
  })
  expect(response.status).toBe(200)
  await response.text()
  await detached()
  expect(reports).toEqual([])
})

test('Pi unmarked no-policy response retains its legacy hold and keeper lifetime while reporting zero', async () => {
  await fixture(false, true)
  const reports: unknown[] = []
  globals[routingKey] = () => ({
    report: (payload: Record<string, unknown>) => {
      if (payload.kind === 'cache_touch') reports.push(payload)
    },
  })
  globalThis.fetch = mock(async (input: any) =>
    String(input).includes('/api/claude_cli/bootstrap')
      ? Response.json({
          oauth_account: { account_uuid: fixtureAccountIdentity('main') },
        })
      : accepted(),
  ) as unknown as typeof fetch
  const originalTrack = CacheKeepManager.prototype.track
  let kept: ReturnType<CacheKeepManager['trackedRequest']>
  const track = spyOn(CacheKeepManager.prototype, 'track').mockImplementation(
    function (this: CacheKeepManager, input) {
      const result = originalTrack.call(this, input)
      if (input.sessionId === 'ses_pi_reports')
        kept = this.trackedRequest(input.sessionId)
      return result
    },
  )
  cleanups.push(() => track.mockRestore())
  const before = Date.now()
  const result = await streamCortexKitAnthropic(model, context(), {
    apiKey: 'sk-ant-oat01-main-access',
    sessionId: 'ses_pi_reports',
    onPayload: (payload) => {
      const strip = (value: any) => {
        if (!value || typeof value !== 'object') return
        delete value.cache_control
        delete value.cacheControl
        for (const child of Object.values(value)) strip(child)
      }
      strip(payload)
    },
  }).result()
  expect(result.errorMessage).toBeUndefined()
  await detached()
  expect(reports).toEqual([
    {
      kind: 'cache_touch',
      at: expect.any(Number),
      ttl_ms: 0,
      source: 'response',
    },
  ])
  expect(
    sessionCacheActivity.holdUntil('ses_pi_reports', 'main', before, 'max'),
  ).toBeGreaterThanOrEqual(before + 300_000)
  expect(kept?.cacheExpiresAt).toBeGreaterThanOrEqual(before + 300_000)
})
