import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  createNativePoolStore,
  type LogTestRecord,
  resetBillingHeaderCCH,
  resetDumpState,
  resolveNativePoolPaths,
  sessionCacheActivity,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/compat'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import {
  closePiNativeRuntime,
  getPiNativeRuntime,
  type PiNativeRuntime,
} from '../native.ts'
import { getPiAccountStoragePath } from '../paths.ts'
import {
  beginPiPrimaryTurn,
  buildExplicitBaseMessagesUrl,
  clearPiStickyQuotaRetries,
  configureApiRouteHeaders,
  endPiPrimaryTurn,
  forgetPiMessageThread,
  parseSse,
  primaryResponseAllowsApiFallback,
  streamCortexKitAnthropic,
} from '../stream.ts'
import { normalizeContext } from '../transcript.ts'
import {
  fixtureAccountIdentity,
  readNativePiFixture,
  saveNativePiFixture as saveNativePiStorage,
} from './native-fixture.ts'

let tempDir: string | undefined
const nativeStoragePaths = new Set<string>()

async function saveNativePiFixture(
  ...args: Parameters<typeof saveNativePiStorage>
) {
  // Some cases create several stores or restore their environment before teardown.
  nativeStoragePaths.add(args[1] ?? getPiAccountStoragePath())
  await saveNativePiStorage(...args)
}

const originalFetch = globalThis.fetch
const originalNow = Date.now
const routingKey = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const originalRouting = globals[routingKey]
const anthropicModel = {
  id: 'claude-fable-5',
  name: 'Claude Fable 5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} as any
const anthropicContext = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
} as any

describe('Pi shared routing relay', () => {
  async function fixture(mode = 'normal', retry401 = false) {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-routing-relay-'))
    const storagePath = join(tempDir, 'accounts.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    const now = Date.now()
    const quota = (remaining: number) => ({
      checkedAt: now,
      five_hour: {
        usedPercent: 100 - remaining,
        remainingPercent: remaining,
        checkedAt: now,
      },
      seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: now },
    })
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        routing: { mode: 'sticky-balanced' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 20, seven_day: 20 },
          failClosedOnUnknownQuota: true,
          mainQuota: quota(100),
        },
        killswitch: { enabled: true, main: { five_hour: 20 } },
        accounts: [
          {
            id: 'fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: now + 3_600_000,
            quota:
              mode === 'unknown quota'
                ? undefined
                : quota(mode === 'floor' ? 10 : 80),
          },
        ],
      },
      storagePath,
    )
    if (mode === 'signed out') {
      const runtime = await getPiNativeRuntime(storagePath).service()
      const read = runtime.read.bind(runtime)
      // The vault keeps the route in its roster while its credential needs sign-in.
      runtime.read = async () => {
        const snapshot = await read()
        return {
          ...snapshot,
          accounts: snapshot.accounts.map((account) =>
            account.id === 'fallback'
              ? {
                  ...account,
                  source: 'vault' as const,
                  credentialId: 'fallback-vault',
                  state: 'needs_reauth',
                }
              : account,
          ),
        }
      }
      expect(
        (await runtime.read()).accounts.find(
          (account) => account.id === 'fallback',
        ),
      ).toMatchObject({ source: 'vault', state: 'needs_reauth' })
      expect(
        core
          .routingCandidates((await runtime.read()).accounts)
          .map((account) => account.id),
      ).toEqual(['main'])
    }
    const sends: string[] = []
    const bodies: string[] = []
    globalThis.fetch = mock(async (input: any, init: any) => {
      const url = input instanceof Request ? input.url : String(input)
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({
          oauth_account: {
            account_uuid: fixtureAccountIdentity(
              authorization.includes('fallback') ? 'fallback' : 'main',
            ),
          },
        })
      if (url.includes('/oauth/token'))
        return Response.json({
          access_token: 'sk-ant-oat01-fallback-renewed',
          refresh_token: 'fallback-renewed',
          expires_in: 3600,
        })
      if (url.includes('/api/oauth/usage')) return Response.json({})
      if (!url.includes('/v1/messages'))
        throw new Error(`Unexpected URL ${url}`)
      sends.push(authorization)
      bodies.push(
        new Headers(init?.headers).get('content-encoding') === 'gzip'
          ? gunzipSync(init.body).toString()
          : String(init.body),
      )
      if (retry401 && sends.length === 1)
        return new Response('{}', { status: 401 })
      return new Response(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch
    const send = (wait?: Parameters<typeof streamCortexKitAnthropic>[4]) =>
      streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        {
          sessionId: 'ses_pi_routing_relay',
          apiKey: 'sk-ant-oat01-main-access',
        },
        undefined,
        wait,
      )
    return { send, sends, bodies }
  }

  test.each([
    'account_limit_exhausted',
    'account_selection_refused',
    'account_selection_final',
  ])('routing refusal %s stops Pi without host auto-retry', async (code) => {
    const f = await fixture()
    let asks = 0
    globals[routingKey] = () => ({
      accountFor: async () => {
        asks++
        return { refused: { code, retry_after_secs: 17 } }
      },
    })
    const result = await f.send().result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBe(
      code === 'account_selection_final'
        ? 'Shared routing refused an account for this request.'
        : 'Shared routing has no account for this request right now.',
    )
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(asks).toBe(1)
    expect(f.sends).toEqual([])
  })

  test.each(['floor', 'unknown quota'])(
    'routing quota trust serves Pi advice despite %s',
    async (mode) => {
      const f = await fixture(mode)
      let asks = 0
      globals[routingKey] = () => ({
        accountFor: async () => {
          asks++
          return {
            account_id: fixtureAccountIdentity('fallback'),
            credential_id: 'local',
          }
        },
      })
      expect((await f.send().result()).stopReason).toBe('stop')
      expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
      expect(asks).toBe(1)
    },
  )

  test('Pi asks once per turn, not on its physical credential retry', async () => {
    const f = await fixture('normal', true)
    let asks = 0
    globals[routingKey] = () => ({
      accountFor: async () => {
        asks++
        return {
          account_id: fixtureAccountIdentity('fallback'),
          credential_id: 'local',
        }
      },
    })
    expect((await f.send().result()).stopReason).toBe('stop')
    expect(asks).toBe(1)
    expect(f.sends).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer sk-ant-oat01-fallback-renewed',
    ])
    expect((await f.send().result()).stopReason).toBe('stop')
    expect(asks).toBe(2)
  })

  test('Pi honours a capped routing hold without asking again after its wait', async () => {
    const f = await fixture('floor')
    let asks = 0
    let delay = 0
    globals[routingKey] = () => ({
      accountFor: async () => {
        asks++
        return {
          account_id: fixtureAccountIdentity('fallback'),
          credential_id: 'local',
          hold: { retry_after_ms: 9_000_000 },
        }
      },
    })
    const stream = f.send({
      setTimeout: ((callback: () => void, ms: number) => {
        delay = ms
        expect(f.sends).toEqual([])
        queueMicrotask(callback)
        return 1
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as unknown as typeof clearTimeout,
    })
    expect((await stream.result()).stopReason).toBe('stop')
    expect(delay).toBe(900_000)
    expect(asks).toBe(1)
    expect(f.sends).toEqual(['Bearer sk-ant-oat01-fallback-access'])
  })

  test('a signed-out routing pick is replaced by our own Pi subscription', async () => {
    const f = await fixture('signed out')
    const reports: any[] = []
    globals[routingKey] = () => ({
      accountFor: async () => ({
        account_id: fixtureAccountIdentity('fallback'),
        credential_id: 'local',
      }),
      report: (report: unknown) => reports.push(report),
    })
    expect((await f.send().result()).stopReason).toBe('stop')
    expect(f.sends).toEqual(['Bearer sk-ant-oat01-main-access'])
    expect(
      reports.some((report) => report.outcome === 'credential_refused'),
    ).toBe(false)
  })

  test('no accessor and undefined advice leave Pi request bytes and choice unchanged', async () => {
    const f = await fixture()
    delete globals[routingKey]
    expect((await f.send().result()).stopReason).toBe('stop')
    globals[routingKey] = () => ({ accountFor: async () => undefined })
    expect((await f.send().result()).stopReason).toBe('stop')
    expect(f.sends).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-main-access',
    ])
    expect(f.bodies[1]).toBe(f.bodies[0])
  })
})

test('Pi OAuth sends the Claude Code accept-encoding on the wire', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pi-wire-encoding-'))
  const storagePath = join(tempDir, 'accounts.json')
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture(
    {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [],
      quota: { enabled: false },
    },
    storagePath,
  )
  const encoding: { wire: string | null; explicit: string | null } = {
    wire: null,
    explicit: null,
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      encoding.wire = request.headers.get('accept-encoding')
      return new Response('data: {"type":"message_stop"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes('/api/claude_cli/bootstrap'))
      return Response.json({
        oauth_account: { account_uuid: 'pi-wire-encoding' },
      })
    encoding.explicit = new Headers(init?.headers).get('accept-encoding')
    return originalFetch(`${server.url}v1/messages`, init)
  }) as typeof fetch
  try {
    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      sessionId: 'ses_pi_wire_encoding',
      apiKey: 'sk-ant-oat-wire-encoding',
    })
    expect((await stream.result()).stopReason).toBe('stop')
    expect(encoding.explicit).toBe(core.CLAUDE_CODE_ACCEPT_ENCODING)
    expect(encoding.wire).toBe(core.CLAUDE_CODE_ACCEPT_ENCODING)
  } finally {
    await server.stop(true)
  }
})

test.each(['success', 'provider error', 'malformed'])(
  'streamed reply dumps keep only text edge counts (%s)',
  async (outcome) => {
    const error = outcome !== 'success'
    tempDir = await mkdtemp(join(tmpdir(), 'pi-dump-edges-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    const dumpDir = join(tempDir, 'dumps')
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await saveNativePiFixture(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [],
          dump: { enabled: true },
          quota: { enabled: false },
        },
        storagePath,
      )
      const events = [
        { type: 'message_start', message: { id: 'msg_pi_edges', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '\n\nHello ' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'tool_edges',
            name: 'Read',
            input: {},
          },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'text_delta', text: 'World\n' },
        },
        { type: 'content_block_stop', index: 2 },
        ...(outcome === 'provider error'
          ? [{ type: 'error', error: { type: 'api_error', message: 'failed' } }]
          : [
              { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
              { type: 'message_stop' },
            ]),
      ]
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        if (input.toString().includes('/api/claude_cli/bootstrap'))
          return new Response(
            JSON.stringify({ oauth_account: { account_uuid: 'pi-dump-uuid' } }),
          )
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
            (outcome === 'malformed' ? 'data: malformed\n\n' : ''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }) as unknown as typeof fetch
      const stream = streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        { apiKey: 'sk-ant-oat-pi-dump', sessionId: 'ses_pi_dump_edges' },
      )
      const result = await stream.result()
      expect(result.stopReason).toBe(error ? 'error' : 'stop')
      const files = await readdir(dumpDir)
      const path = files.find((name) => name.endsWith('.response.json'))
      expect(path).toBeString()
      const text = await readFile(join(dumpDir, path!), 'utf8')
      expect(JSON.parse(text).stream_complete).toBe(!error)
      if (error) expect(JSON.parse(text)).not.toHaveProperty('reply_text_edges')
      else
        expect(JSON.parse(text).reply_text_edges).toEqual([
          { index: 0, leading: 2, trailing: 1, chars: 8 },
          { index: 2, leading: 0, trailing: 1, chars: 6 },
        ])
      expect(text).not.toContain('Hello')
      expect(text).not.toContain('World')
    } finally {
      resetDumpState()
      if (originalDumpDir === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
    }
  },
)

afterEach(async () => {
  // Close each fixture's native runtime before replacing fetch or deleting
  // fixtures. A runtime left open keeps polling the vault into later test files.
  await Promise.all([...nativeStoragePaths].map(closePiNativeRuntime))
  nativeStoragePaths.clear()
  __setLogTestSink(null)
  globalThis.fetch = originalFetch
  if (originalRouting === undefined) delete globals[routingKey]
  else globals[routingKey] = originalRouting
  Date.now = originalNow
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('stream fixture native runtime lifetime', () => {
  const polls = new Map<ReturnType<typeof setInterval>, () => void>()
  const retired: PiNativeRuntime[] = []
  const schedule = ((callback: () => void) => {
    const timer = { unref() {} } as ReturnType<typeof setInterval>
    polls.set(timer, callback)
    return timer
  }) as typeof setInterval
  const cancel = ((timer: ReturnType<typeof setInterval>) => {
    polls.delete(timer)
  }) as typeof clearInterval

  test('stream fixture owns every store even after the selected path changes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-stream-lifetime-'))
    for (const name of ['first', 'second']) {
      const storagePath = join(tempDir, name, 'anthropic-auth.json')
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      await saveNativePiFixture({ version: 1, accounts: [] }, storagePath)
      const native = getPiNativeRuntime(storagePath, {
        vaultPoll: {
          intervalMs: 2000,
          setInterval: schedule,
          clearInterval: cancel,
        },
      })
      retired.push(native)
      await native.service()
    }
    expect(polls.size).toBe(2)
  })

  // A separate body observes the real afterEach boundary, with every poll held rather than timed.
  test('stream fixture teardown cancels held vault polls before the next body', async () => {
    try {
      expect(retired).toHaveLength(2)
      expect(polls.size).toBe(0)
      for (const native of retired)
        await expect(native.service()).rejects.toThrow(
          'Pi native authentication is closed',
        )
    } finally {
      await Promise.all(retired.map((native) => native.close()))
    }
  })
})

test.each([
  'empty',
  'bodyless',
  'partial',
  'unterminated stop',
  'partial with billing',
])(
  'Pi incomplete 200 is retryable and never an empty stop: %s',
  async (scenario) => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-incomplete-'))
    const storagePath = join(tempDir, 'accounts.json')
    const dumpDir = join(tempDir, 'dumps')
    const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    const billingReports: Record<string, unknown>[] = []
    if (scenario === 'partial with billing')
      globals[routingKey] = () => ({
        report: (payload: Record<string, unknown>) => {
          if (payload.kind === 'billing') billingReports.push(payload)
        },
      })
    try {
      await saveNativePiFixture(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [],
          dump: { enabled: true },
          quota: { enabled: false },
        },
        storagePath,
      )
      const ending = scenario === 'partial with billing' ? '\r\n' : '\n'
      const frame = (event: unknown) =>
        `data: ${JSON.stringify(event)}${ending}${ending}`
      const body = scenario.startsWith('partial')
        ? frame({
            type: 'message_start',
            message: {
              id: 'msg_partial',
              content: [],
              usage: { input_tokens: 12, output_tokens: 0 },
            },
          }) +
          frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
        : scenario === 'unterminated stop'
          ? 'data: {"type":"message_stop"}\n'
          : ''
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        if (input.toString().includes('/api/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: { account_uuid: 'pi-incomplete' },
          })
        return new Response(scenario === 'bodyless' ? null : body, {
          headers: {
            'request-id': 'req_incomplete_pi',
            'cf-ray': '1234567890abcdef-LHR',
            'content-type': 'text/event-stream',
            'content-encoding': 'identity',
            'content-length': String(Buffer.byteLength(body)),
            'x-private': 'private prompt must not be retained',
          },
        })
      }) as unknown as typeof fetch
      const stream = streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        {
          sessionId: `ses_incomplete_${scenario}`,
          apiKey: 'sk-ant-oat-incomplete',
        },
      )
      const emitted = []
      for await (const event of stream) emitted.push(event)
      const result = await stream.result()
      expect(result.stopReason).toBe('error')
      if (scenario.startsWith('partial'))
        expect(result.responseId).toBe('msg_partial')
      expect(result.errorMessage).toContain('ECONNRESET')
      expect(isRetryableAssistantError(result)).toBe(true)
      expect(emitted.some((event) => event.type === 'done')).toBe(false)
      const file = (await readdir(dumpDir)).find((name) =>
        name.endsWith('.response.json'),
      )!
      const summary = JSON.parse(await readFile(join(dumpDir, file), 'utf8'))
      expect(summary.stream_complete).toBe(false)
      expect(summary.incomplete_stream).toEqual({
        response_headers: {
          'request-id': 'req_incomplete_pi',
          'cf-ray': '1234567890abcdef-LHR',
          'content-type': 'text/event-stream',
          'content-encoding': 'identity',
          'content-length': String(Buffer.byteLength(body)),
        },
        response_bytes: Buffer.byteLength(body),
        sse_events: scenario.startsWith('partial') ? 2 : 0,
        send_to_headers_ms: expect.any(Number),
        timing_source: 'physical_fetch',
        headers_to_eof_ms: expect.any(Number),
      })
      const warnings = records.filter(
        (record) =>
          record.level === 'warn' &&
          record.message === 'Anthropic connection closed before message_stop',
      )
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.payload).toEqual(summary.incomplete_stream)
      expect(JSON.stringify([summary, warnings])).not.toContain(
        'private prompt',
      )
      if (scenario === 'partial with billing') {
        await Bun.sleep(10)
        expect(billingReports).toHaveLength(1)
        expect(billingReports[0]).toMatchObject({
          outcome: 'cut',
          status: 200,
          provider_request_id: 'req_incomplete_pi',
          provider_response_id: 'msg_partial',
          usage: { input: 12 },
        })
        expect(billingReports[0]?.usage).not.toHaveProperty('output')
      }
    } finally {
      resetDumpState()
      if (previousDumpDir === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
    }
  },
)

describe('Pi stream stop reasons', () => {
  const refusal = 'Claude refused this request (stop_reason: refusal).'
  const cases = [
    {
      name: 'refusal without category',
      reason: 'refusal',
      details: undefined,
      errorMessage: refusal,
      loggedReason: 'refusal',
      category: undefined,
    },
    {
      name: 'refusal with category',
      reason: 'refusal',
      details: { type: 'refusal', category: 'cyber' },
      errorMessage:
        'Claude refused this request (stop_reason: refusal, category: cyber).',
      loggedReason: 'refusal',
      category: 'cyber',
    },
    {
      name: 'refusal with unsafe category',
      reason: 'refusal',
      details: { type: 'refusal', category: 'private prompt\ntext' },
      errorMessage: refusal,
      loggedReason: 'refusal',
      category: undefined,
    },
    {
      name: 'refusal with trailing newline in category',
      reason: 'refusal',
      details: { type: 'refusal', category: 'cyber\n' },
      errorMessage: refusal,
      loggedReason: 'refusal',
      category: undefined,
    },
    {
      name: 'refusal with oversized category',
      reason: 'refusal',
      details: { type: 'refusal', category: 'a'.repeat(41) },
      errorMessage: refusal,
      loggedReason: 'refusal',
      category: undefined,
    },
    {
      name: 'refusal with null category',
      reason: 'refusal',
      details: { type: 'refusal', category: null },
      errorMessage: refusal,
      loggedReason: 'refusal',
      category: undefined,
    },
    {
      name: 'unknown stop reason',
      reason: 'new_stop_reason',
      details: undefined,
      errorMessage:
        'Claude ended this request with an unsupported stop reason (stop_reason: new_stop_reason).',
      loggedReason: 'new_stop_reason',
      category: undefined,
    },
    {
      name: 'unsafe stop reason',
      reason: 'private prompt\ntext',
      details: undefined,
      errorMessage:
        'Claude ended this request with an unsupported stop reason (stop_reason: unknown).',
      loggedReason: 'unknown',
      category: undefined,
    },
  ]

  for (const fixture of cases) {
    test(`${fixture.name} emits a safe error event`, async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'pi-stop-reason-'))
      const storagePath = join(tempDir, 'anthropic-auth.json')
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      await saveNativePiFixture(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [],
        },
        storagePath,
      )
      const records: LogTestRecord[] = []
      __setLogTestSink((record) => records.push(record))
      const delta = {
        stop_reason: fixture.reason,
        stop_details: fixture.details && {
          ...fixture.details,
          explanation: 'private prompt echoed by provider explanation',
        },
      }
      const events = [
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 3,
              output_tokens: 0,
              cache_read_input_tokens: 11,
              cache_creation_input_tokens: 13,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'private prompt in model text' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta, usage: { output_tokens: 7 } },
        // A repeated delta must not produce a second warning for one response.
        { type: 'message_delta', delta, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ]
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        if (input.toString().includes('/api/claude_cli/bootstrap'))
          return new Response(
            JSON.stringify({ oauth_account: { account_uuid: 'pi-stop-uuid' } }),
          )
        return new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }) as unknown as typeof fetch

      const stream = streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        {
          apiKey: 'sk-ant-oat-pi-stop',
          sessionId: 'ses_pi_stop_reason',
        },
      )
      const emitted = []
      for await (const event of stream) emitted.push(event)
      const result = await stream.result()

      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toBe(fixture.errorMessage)
      expect(emitted.at(-1)).toEqual({
        type: 'error',
        reason: 'error',
        error: result,
      })
      expect(emitted.some((event) => event.type === 'done')).toBe(false)
      expect(result.usage).toMatchObject({
        input: 3,
        output: 7,
        cacheRead: 11,
        cacheWrite: 13,
        totalTokens: 34,
      })
      expect(records.filter((record) => record.level === 'warn')).toEqual([
        {
          level: 'warn',
          channel: 'pi',
          message: 'Anthropic response ended with an error stop reason',
          payload: {
            stopReason: fixture.loggedReason,
            ...(fixture.category ? { category: fixture.category } : {}),
            model: 'claude-fable-5',
            sessionId: 'ses_pi_stop_reason',
          },
        },
      ])
      expect(JSON.stringify(records)).not.toContain('private prompt')
    })
  }

  test.each(['refusal', 'new_stop_reason', 'end_turn'])(
    '%s response preserves thread anchor safety',
    async (stopReason) => {
      tempDir = await mkdtemp(join(tmpdir(), 'pi-stop-thread-'))
      const storagePath = join(tempDir, 'anthropic-auth.json')
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      await saveNativePiFixture(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [],
        },
        storagePath,
      )
      const runtime = await getPiNativeRuntime(storagePath).service()
      await runtime.updateSettings((settings) => ({
        ...settings,
        quota: { enabled: false },
        claudeCache: { enabled: false, mode: 'explicit' },
        cacheKeep: { enabled: false },
      }))
      const sent: Array<{
        thread?: { type: string }
        messages: unknown[]
      }> = []
      globalThis.fetch = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (input.toString().includes('/api/claude_cli/bootstrap'))
            return Response.json({
              oauth_account: { account_uuid: fixtureAccountIdentity('main') },
            })
          const body =
            init?.body instanceof Uint8Array
              ? gunzipSync(init.body).toString().trim()
              : String(init?.body)
          sent.push(JSON.parse(body))
          return new Response(
            [
              { type: 'message_start', message: { id: `msg_${sent.length}` } },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'answer' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: {
                  stop_reason: sent.length === 1 ? stopReason : 'end_turn',
                },
              },
              { type: 'message_stop' },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(''),
            { headers: { 'content-type': 'text/event-stream' } },
          )
        },
      ) as unknown as typeof fetch
      const sessionId = `ses_pi_stop_thread_${stopReason}`
      const options = {
        sessionId,
        onPayload: (payload: unknown) => payload,
        onResponse: () => {},
        onProviderStreamEvent: () => {},
      }
      const send = (context: typeof anthropicContext) =>
        streamCortexKitAnthropic(
          anthropicModel,
          context,
          options,
          undefined,
          undefined,
          'agent-loop',
        ).result()
      beginPiPrimaryTurn(storagePath, sessionId)
      try {
        const result = await send(anthropicContext)
        expect(result.stopReason).toBe(
          stopReason === 'end_turn' ? 'stop' : 'error',
        )
        // Retaining a failed reply as successful history must not let the next
        // request continue the failed thread.
        const kept = { ...result, stopReason: 'stop', errorMessage: undefined }
        const next = await send({
          ...anthropicContext,
          messages: [
            ...anthropicContext.messages,
            kept,
            { role: 'user', content: 'Next prompt', timestamp: 2 },
          ],
        })
        expect(next.stopReason).toBe('stop')
        expect(sent[0]?.thread).toEqual({ type: 'create' })
        expect(sent[1]?.thread?.type).toBe(
          stopReason === 'end_turn' ? 'continue' : 'create',
        )
        expect(sent[1]?.messages).toHaveLength(
          stopReason === 'end_turn' ? 1 : 3,
        )
      } finally {
        endPiPrimaryTurn(storagePath, sessionId)
        forgetPiMessageThread(sessionId)
      }
    },
  )
})

describe('Pi API fallback routing helpers', () => {
  test('keeps the admitted native main identity without recreating legacy storage', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-main-identity-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
      },
      storagePath,
    )
    const before = (await readNativePiFixture(storagePath)).mainAccountId
    expect(before).toEqual(expect.any(String))

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/api/claude_cli/bootstrap')) {
        return new Response(
          JSON.stringify({
            oauth_account: { account_uuid: 'pi-main-bootstrap-uuid' },
          }),
        )
      }
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat-pi-main',
      sessionId: 'ses_pi_main_identity',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect((await stream.result()).stopReason).toBe('stop')
    expect((await readNativePiFixture(storagePath)).mainAccountId).toBe(before)
    await expect(readFile(storagePath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  /**
   * Save a Pi relay with the given URL, remove its stored transport (as in a
   * configuration saved before the field existed or edited by hand), send one
   * request and return the relay fetches and WebSocket connection attempts.
   */
  async function sendWithoutStoredTransport(
    url: string,
    transport: 'http' | 'websocket',
  ) {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-relay-default-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
        relay: {
          enabled: true,
          url,
          token: 'synthetic-pi-relay-token',
          fallbackToDirect: false,
          transport,
        },
      },
      storagePath,
    )
    await createNativePoolStore({
      paths: await resolveNativePoolPaths(storagePath),
      quota: nativeQuotaCodec,
    }).updateSettings((settings) => {
      const { transport: _omitted, ...relay } = settings.relay as Record<
        string,
        unknown
      >
      settings.relay = relay
    })
    expect((await readNativePiFixture(storagePath)).relay?.transport).toBe(
      undefined,
    )

    const sent: string[] = []
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const requested = input.toString()
      if (requested.includes('/api/claude_cli/bootstrap'))
        return new Response(
          JSON.stringify({
            oauth_account: { account_uuid: 'pi-relay-default-account' },
          }),
        )
      sent.push(requested)
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    // A failed WebSocket attempt falls back to the HTTP relay, so the fetch
    // alone cannot show which transport was chosen. Record every socket and
    // refuse it, letting the request finish over HTTP.
    const sockets: string[] = []
    const OriginalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = class {
      constructor(socketUrl: string | URL) {
        sockets.push(String(socketUrl))
        throw new Error('this test refuses WebSocket relay connections')
      }
    } as unknown as typeof WebSocket
    try {
      const result = await streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        { apiKey: 'sk-ant-oat-pi-relay', sessionId: 'ses_pi_relay_default' },
      ).result()
      return { result, sent, sockets }
    } finally {
      globalThis.WebSocket = OriginalWebSocket
    }
  }

  test('a relay saved with an https URL and no transport sends over HTTP', async () => {
    const { result, sent, sockets } = await sendWithoutStoredTransport(
      'https://relay.invalid',
      'http',
    )
    expect(sockets).toEqual([])
    expect(result.stopReason).toBe('stop')
    expect(sent).toEqual(['https://relay.invalid'])
  })

  test('a relay saved with a wss URL and no transport keeps using WebSocket', async () => {
    const { sockets } = await sendWithoutStoredTransport(
      'wss://relay.invalid',
      'websocket',
    )
    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toStartWith('wss://relay.invalid/ws?')
  })

  test('runner turn notes reach the signed Pi OAuth stream request using the Pi session', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-runner-note-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        turnEndNote: { tools: [] },
        accounts: [],
      },
      storagePath,
    )
    const reports: unknown[] = []
    globals[routingKey] = (sessionId: string) => {
      expect(sessionId).toBe('ses_pi_runner_note')
      return {
        turn_notes: () => [
          { after_tool_use_id: 'runner-call', text: 'Runner reminder' },
        ],
        report: (payload: unknown) => reports.push(payload),
      }
    }
    let bodyText = ''
    let headers = new Headers()
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (input.toString().includes('/api/claude_cli/bootstrap'))
          return new Response(
            JSON.stringify({
              oauth_account: { account_uuid: 'pi-runner-note-account' },
            }),
          )
        headers = new Headers(init?.headers)
        bodyText =
          headers.get('content-encoding') === 'gzip'
            ? gunzipSync(init?.body as Uint8Array).toString()
            : String(init?.body)
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        )
      },
    ) as unknown as typeof fetch
    const stream = streamCortexKitAnthropic(
      { ...anthropicModel, id: 'claude-opus-5-5' },
      {
        tools: [],
        messages: [
          { role: 'user', content: 'Question', timestamp: 0 },
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'runner-call',
                name: 'board',
                arguments: {},
              },
            ],
            timestamp: 0,
          },
          {
            role: 'toolResult',
            toolCallId: 'runner-call',
            toolName: 'board',
            content: [{ type: 'text', text: 'Done' }],
            isError: false,
            timestamp: 0,
          },
        ],
      } as any,
      { apiKey: 'sk-ant-oat-pi-runner-note', sessionId: 'ses_pi_runner_note' },
    )
    for await (const _event of stream) {
      /* Drain the provider stream. */
    }
    const body = JSON.parse(bodyText)
    expect(body.messages.at(-1)).toEqual({
      role: 'system',
      clear_at: 'next_user_message',
      content: 'Runner reminder',
    })
    expect(await signRequestBody(bodyText)).toBe(bodyText)
    expect(headers.get('anthropic-beta')?.split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
    expect(reports).toContainEqual({
      kind: 'turn_notes_supported',
      model: 'claude-opus-5-5',
      supported: true,
    })
  })

  test('native turnEndNote settings reach the signed Pi OAuth request and its beta', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-turn-end-note-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        turnEndNote: { tools: ['my_cleanup'] },
        accounts: [],
      },
      storagePath,
    )
    let bodyText = ''
    let headers = new Headers()
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (input.toString().includes('/api/claude_cli/bootstrap'))
          return new Response(
            JSON.stringify({
              oauth_account: { account_uuid: 'pi-note-account' },
            }),
          )
        bodyText = String(init?.body)
        headers = new Headers(init?.headers)
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        )
      },
    ) as unknown as typeof fetch
    const stream = streamCortexKitAnthropic(
      { ...anthropicModel, id: 'claude-opus-5-5' },
      {
        tools: [],
        messages: [
          { role: 'user', content: 'Question', timestamp: 0 },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'A'.repeat(350) },
              { type: 'toolCall', id: 'a', name: 'my_cleanup', arguments: {} },
            ],
            timestamp: 0,
          },
          {
            role: 'toolResult',
            toolCallId: 'a',
            content: [{ type: 'text', text: 'Done' }],
            isError: false,
            timestamp: 0,
          },
        ],
      } as any,
      { apiKey: 'sk-ant-oat-pi-note', sessionId: 'ses_pi_note' },
    )
    for await (const _event of stream) {
      /* Drain the provider stream. */
    }
    const body = JSON.parse(bodyText)
    expect(body.messages.at(-1)).toEqual({
      role: 'system',
      clear_at: 'next_user_message',
      content:
        'Your reply above has already reached the user. The tool call after it was housekeeping and changed nothing they need to know. Do not repeat, summarize or rewrite that reply. If no new work remains, end the turn without restating anything.',
    })
    expect(await signRequestBody(bodyText)).toBe(bodyText)
    expect(headers.get('anthropic-beta')?.split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
  })

  test('sends Fable 5.1 thinking binding controls after compacted signed history', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-fable-51-binding-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
        accounts: [],
      },
      storagePath,
    )

    let requestHeaders: Headers | undefined
    let requestBody: Record<string, any> | undefined
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString()
        if (url.includes('/api/claude_cli/bootstrap')) {
          return new Response(
            JSON.stringify({
              oauth_account: { account_uuid: 'pi-fable-51-account' },
            }),
          )
        }
        requestHeaders = new Headers(init?.headers)
        requestBody = JSON.parse(String(init?.body))
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { status: 200 },
        )
      },
    ) as unknown as typeof fetch

    const context = {
      systemPrompt: 'test',
      tools: [],
      messages: [
        { role: 'user', content: 'compaction summary', timestamp: 0 },
        {
          role: 'assistant',
          provider: 'anthropic',
          api: 'cortexkit-anthropic-messages',
          model: 'claude-fable-5-1',
          content: [
            {
              type: 'thinking',
              thinking: 'reasoning',
              thinkingSignature: 'signature',
            },
            { type: 'toolCall', id: 'tool_1', name: 'Bash', arguments: {} },
          ],
          timestamp: 0,
        },
        {
          role: 'toolResult',
          toolCallId: 'tool_1',
          content: [{ type: 'text', text: 'result' }],
          isError: false,
          timestamp: 0,
        },
        { role: 'user', content: 'continue', timestamp: 0 },
      ],
    } as any
    const stream = streamCortexKitAnthropic(
      { ...anthropicModel, id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
      context,
      { apiKey: 'sk-ant-oat-pi-fable-51', sessionId: 'ses_pi_fable_51' },
      [
        { afterAssistantMessages: 0, effort: 'low' },
        { afterAssistantMessages: 1, effort: 'high' },
      ],
    )
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(requestBody?.thinking?.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    })
    expect(requestBody?.output_config).toEqual({ effort: 'low' })
    expect(requestBody?.messages[2]).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    expect(requestHeaders?.get('anthropic-beta')).toContain(
      'thinking-binding-controls-2026-08-01',
    )
    expect(requestHeaders?.get('anthropic-beta')).toContain(
      'per-turn-control-2026-07-01',
    )
    expect(requestHeaders?.get('anthropic-beta')?.split(',')).not.toContain(
      'mid-conversation-output-config-2026-07-01',
    )
  })

  test('sends a large OAuth body gzipped and resends a rejected one uncompressed once', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-request-gzip-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
      },
      storagePath,
    )
    // A loopback server stands in for api.anthropic.com and records the
    // exact bytes; the first answer is a proxy-style 400 (no request id).
    const received: Array<{ headers: Headers; body: Uint8Array }> = []
    const replies = [new Response('Bad Request', { status: 400 })]
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        received.push({
          headers: new Headers(request.headers),
          body: new Uint8Array(await request.arrayBuffer()),
        })
        return (
          replies.shift() ??
          new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            {
              status: 200,
              headers: { 'request-id': 'req_011CPiGzipOk000000000001' },
            },
          )
        )
      },
    })
    try {
      globalThis.fetch = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input)
          if (url.pathname.includes('/api/claude_cli/bootstrap'))
            return new Response(
              JSON.stringify({
                oauth_account: { account_uuid: 'pi-gzip-account' },
              }),
            )
          return Bun.fetch(
            `http://127.0.0.1:${upstream.port}${url.pathname}${url.search}`,
            init,
          )
        },
      ) as unknown as typeof fetch
      const context = {
        systemPrompt: 'test',
        tools: [],
        messages: [
          {
            role: 'user',
            content: `Review: ${'x'.repeat(9000)}`,
            timestamp: 0,
          },
        ],
      } as any
      const result = await streamCortexKitAnthropic(anthropicModel, context, {
        apiKey: 'sk-ant-oat-pi-gzip',
        sessionId: 'ses_pi_gzip',
      }).result()
      expect(result.stopReason).toBe('stop')
      expect(received).toHaveLength(2)
      const [first, resend] = received
      expect(first?.headers.get('content-encoding')).toBe('gzip')
      const plain = new TextDecoder().decode(gunzipSync(first!.body))
      expect(plain.trimEnd()).toContain(' cch=00000;')
      expect(plain.slice(plain.trimEnd().length)).toMatch(/^\n[ \t]{0,256}$/)
      expect(resend?.headers.get('content-encoding')).toBeNull()
      expect(resend?.headers.get('x-client-request-id')).toBe(
        first?.headers.get('x-client-request-id'),
      )
      const identity = new TextDecoder().decode(resend!.body)
      expect(await signRequestBody(identity)).toBe(identity)
      expect(resetBillingHeaderCCH(identity)).toBe(plain.trimEnd())
    } finally {
      upstream.stop(true)
    }
  })

  test('sends Opus 5.5 effort changes as system markers with the per-turn control beta', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-opus-55-effort-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
      },
      storagePath,
    )

    const requests: { headers: Headers; body: Record<string, any> }[] = []
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString()
        if (url.includes('/api/claude_cli/bootstrap')) {
          return new Response(
            JSON.stringify({
              oauth_account: { account_uuid: 'pi-opus-55-account' },
            }),
          )
        }
        requests.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        })
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { status: 200 },
        )
      },
    ) as unknown as typeof fetch

    const context = {
      systemPrompt: 'test',
      tools: [],
      messages: [
        { role: 'user', content: 'first', timestamp: 0 },
        {
          role: 'assistant',
          provider: 'anthropic',
          api: 'cortexkit-anthropic-messages',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'first answer' }],
          timestamp: 0,
        },
        { role: 'user', content: 'second', timestamp: 0 },
      ],
    } as any
    const model = {
      ...anthropicModel,
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
    }
    const drain = async (
      transitions: { afterAssistantMessages: number; effort: 'low' | 'high' }[],
    ) => {
      const stream = streamCortexKitAnthropic(
        model,
        context,
        {
          apiKey: 'sk-ant-oat-pi-opus-55',
          sessionId: 'ses_pi_opus_55',
          reasoning: 'high',
        } as any,
        transitions,
      )
      for await (const _event of stream) {
        // Drain the provider stream.
      }
    }

    await drain([
      { afterAssistantMessages: 0, effort: 'low' },
      { afterAssistantMessages: 1, effort: 'high' },
    ])
    await drain([{ afterAssistantMessages: 0, effort: 'high' }])

    const [changed, steady] = requests
    expect(changed?.body.output_config).toEqual({ effort: 'low' })
    expect(changed?.body.messages[2]).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    // Without an effort change the body keeps the host's effort and has no
    // system marker; only the beta list differs from an ineligible model.
    expect(steady?.body.output_config).toEqual({ effort: 'high' })
    expect(
      steady?.body.messages.some(
        (message: { role?: string }) => message.role === 'system',
      ),
    ).toBe(false)
    for (const request of [changed, steady]) {
      const betas = request?.headers.get('anthropic-beta')?.split(',')
      expect(betas).toContain('per-turn-control-2026-07-01')
      expect(betas).not.toContain('mid-conversation-output-config-2026-07-01')
    }
  })

  test('preserves provider base path when building /v1/messages URL', () => {
    const url = buildExplicitBaseMessagesUrl('https://api.kie.ai/claude')

    expect(url.toString()).toBe(
      'https://api.kie.ai/claude/v1/messages?beta=true',
    )
  })

  test('does not duplicate a trailing version segment in provider base paths', () => {
    expect(
      buildExplicitBaseMessagesUrl(
        'https://proxy.example.test/anthropic/v1',
      ).toString(),
    ).toBe('https://proxy.example.test/anthropic/v1/messages?beta=true')
    expect(
      buildExplicitBaseMessagesUrl(
        'https://proxy.example.test/anthropic/v2',
      ).toString(),
    ).toBe('https://proxy.example.test/anthropic/v2/messages?beta=true')
    expect(
      buildExplicitBaseMessagesUrl(
        'https://proxy.example.test/anthropic/v1/messages',
      ).toString(),
    ).toBe('https://proxy.example.test/anthropic/v1/messages?beta=true')
  })

  test('uses bearer auth by default for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'kie-opus',
        type: 'api',
        apiKey: 'kie-key',
        baseURL: 'https://api.kie.ai/claude',
        authHeader: 'authorization-bearer',
      },
      false,
    )

    expect(headers.get('authorization')).toBe('Bearer kie-key')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('only allows API fallback for direct primary quota exhaustion evidence', () => {
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 429 })),
    ).toBe(true)
    expect(primaryResponseAllowsApiFallback('rate_limit_error')).toBe(true)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 403 })),
    ).toBe(false)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 401 })),
    ).toBe(false)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 200 })),
    ).toBe(false)
  })

  test('supports x-api-key auth mode for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'provider-route',
        type: 'api',
        apiKey: 'provider-key',
        baseURL: 'https://provider.example/anthropic',
        authHeader: 'x-api-key',
      },
      true,
    )

    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBe('provider-key')
    expect(headers.get('anthropic-beta')).toContain('fast-mode-2026-02-01')
  })

  test('sticky-balanced sends the main route when the quota source returns an empty snapshot', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-empty-quota-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    await saveNativePiFixture(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        if (url.includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat01-main-access',
      sessionId: 'ses_pi_empty_quota',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual(['Bearer sk-ant-oat01-main-access'])
  })

  test('fallback-first admits an OAuth fallback whose quota is unknown', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-fallback-unknown-quota-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    const expires = Date.now() + 5 * 60 * 60_000
    await saveNativePiFixture(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires,
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        if (url.includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat01-main-access',
      sessionId: 'ses_pi_fallback_unknown_quota',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-unknown-fallback-access',
    ])
  })

  test('main-first blocks an unknown main quota when the killswitch is fail-closed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-killswitch-unknown-quota-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
        killswitch: {
          enabled: true,
          main: { five_hour: 5, seven_day: 10 },
        },
        routing: { mode: 'main-first' },
        accounts: [],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        if (url.includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch

    const events = []
    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat01-main-access',
      sessionId: 'ses_pi_killswitch_unknown_quota',
    })
    for await (const event of stream) events.push(event)

    expect(authorizations).toEqual([])
    expect(events.some((event) => event.type === 'error')).toBe(true)
  })

  test('applies safe ANTHROPIC_CUSTOM_HEADERS to API fallback routes', () => {
    const previous = process.env.ANTHROPIC_CUSTOM_HEADERS
    process.env.ANTHROPIC_CUSTOM_HEADERS = JSON.stringify({
      'x-provider-api-key': 'provider-key',
    })
    try {
      const headers = configureApiRouteHeaders(
        {
          id: 'provider-route',
          type: 'api',
          apiKey: 'provider-key',
          baseURL: 'https://provider.example/anthropic',
          authHeader: 'x-api-key',
        },
        false,
      )

      expect(headers.get('x-provider-api-key')).toBe('provider-key')
      expect(headers.get('anthropic-version')).toBe('2023-06-01')
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_CUSTOM_HEADERS
      } else {
        process.env.ANTHROPIC_CUSTOM_HEADERS = previous
      }
    }
  })

  test('does not let custom headers replace API route authentication or protocol headers', () => {
    const previous = process.env.ANTHROPIC_CUSTOM_HEADERS
    process.env.ANTHROPIC_CUSTOM_HEADERS = JSON.stringify({
      authorization: 'Bearer overridden',
      'anthropic-beta': 'overridden-beta',
      'x-safe-header': 'must-not-partially-apply',
    })
    try {
      const headers = configureApiRouteHeaders(
        {
          id: 'provider-route',
          type: 'api',
          apiKey: 'provider-key',
          baseURL: 'https://provider.example/anthropic',
          authHeader: 'authorization-bearer',
        },
        true,
      )

      expect(headers.get('authorization')).toBe('Bearer provider-key')
      expect(headers.get('anthropic-beta')).toContain('fast-mode-2026-02-01')
      expect(headers.get('x-safe-header')).toBeNull()
    } finally {
      if (previous === undefined) {
        delete process.env.ANTHROPIC_CUSTOM_HEADERS
      } else {
        process.env.ANTHROPIC_CUSTOM_HEADERS = previous
      }
    }
  })

  const checkStickyQuotaReread = async (
    confirmed: boolean,
    retryBudget = false,
    reporting?:
      | 'windows'
      | 'scoped'
      | 'unconfirmed'
      | 'no-accessor'
      | 'throw'
      | 'reject'
      | 'pending',
  ) => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-weekly-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (remaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 100 - remaining,
        remainingPercent: remaining,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - remaining,
        remainingPercent: remaining,
        checkedAt,
      },
    })
    await saveNativePiFixture(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        quota: {
          enabled: true,
          mainQuota: { ...quota(0), accountIdentity: 'main-account' },
          mainQuotaCheckedAt: checkedAt,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'full',
            type: 'oauth',
            access: 'sk-ant-oat01-full-access',
            refresh: 'full-refresh',
            expires: checkedAt + 8 * 60 * 60_000,
            quota: {
              ...quota(100),
              ...(reporting === 'scoped' && {
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 20,
                    remainingPercent: 80,
                    checkedAt,
                  },
                ],
              }),
            },
          },
          {
            id: 'room',
            type: 'oauth',
            access: 'sk-ant-oat01-room-access',
            refresh: 'room-refresh',
            expires: checkedAt + 8 * 60 * 60_000,
            quota: quota(10),
          },
        ],
      },
      storagePath,
    )
    const authorizations: string[] = []
    const usageRequests: string[] = []
    const reports: Record<string, unknown>[] = []
    const sessions: string[] = []
    if (reporting) {
      delete globals[routingKey]
      if (reporting !== 'no-accessor')
        globals[routingKey] = (sessionId: string) => {
          sessions.push(sessionId)
          if (reporting === 'throw') throw new Error('routing unavailable')
          return {
            report: (payload: Record<string, unknown>) => {
              if (reporting === 'reject')
                return Promise.reject(new Error('routing unavailable'))
              if (reporting === 'pending') return new Promise(() => {})
              reports.push(payload)
            },
          }
        }
    }
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString()
        if (url.includes('/api/oauth/usage')) {
          usageRequests.push(url)
          return Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 10 },
          })
        }
        if (!url.includes('/v1/messages')) return Response.json({})
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (retryBudget || authorization.includes('full-access'))
          return Response.json(
            { error: { type: 'rate_limit_error' } },
            {
              status: 429,
              headers:
                reporting && reporting !== 'unconfirmed'
                  ? {
                      'retry-after': retryBudget ? '93151' : '432000',
                      ...(reporting === 'scoped'
                        ? {
                            'anthropic-ratelimit-unified-7d_fable-status':
                              'rejected',
                            'anthropic-ratelimit-unified-7d_fable-reset':
                              '2000000000',
                          }
                        : {
                            'anthropic-ratelimit-unified-5h-status': 'rejected',
                            'anthropic-ratelimit-unified-5h-reset':
                              '2000000000',
                            'anthropic-ratelimit-unified-7d-utilization': '1',
                            'anthropic-ratelimit-unified-7d-reset':
                              '2000000100',
                          }),
                    }
                  : {
                      'retry-after': retryBudget ? '93151' : '432000',
                      'anthropic-ratelimit-unified-7d-utilization': confirmed
                        ? '1.0'
                        : '',
                      'anthropic-ratelimit-unified-7d-reset': String(
                        Math.floor(Date.now() / 1000) + 432000,
                      ),
                    },
            },
          )
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          {
            headers: {
              'Anthropic-RateLimit-Unified-5h-Utilization': '0.2',
              'anthropic-ratelimit-future-field': 'raw',
              'x-private': 'never reported',
            },
          },
        )
      },
    ) as unknown as typeof fetch
    if (retryBudget) {
      let now = checkedAt
      Date.now = mock(() => now)
      let pluginWaits = 0
      const send = async (sessionId: string, timestamp: number) => {
        now += 10_000
        const start = authorizations.length
        const stream = streamCortexKitAnthropic(
          anthropicModel,
          {
            ...anthropicContext,
            messages: [{ role: 'user', content: 'hello', timestamp }],
          },
          { apiKey: 'sk-ant-oat01-main-access', sessionId },
          undefined,
          {
            setTimeout: (() => {
              pluginWaits++
              throw new Error('Unconfirmed 429 must use the host retry')
            }) as unknown as typeof setTimeout,
          },
        )
        for await (const _event of stream) {
          /* Drain the failed host attempt. */
        }
        expect((await stream.result()).stopReason).toBe('error')
        return authorizations.slice(start)
      }
      const initial = (await send('pi-budget', 1))[0]
      if (!initial) throw new Error('Initial request did not reach an account')
      expect(await send('pi-budget', 1)).toEqual([initial])
      const other = (await send('pi-other-budget', 1))[0]
      if (!other)
        throw new Error('Independent session did not reach an account')
      expect(await send('pi-budget', 2)).toEqual([initial])
      expect(await send('pi-budget', 2)).toEqual([initial])
      const moved = await send('pi-budget', 2)
      expect(moved).toHaveLength(2)
      expect(moved[0]).toBe(initial)
      expect(moved[1]).not.toBe(initial)
      const replacement = moved[1]
      if (!replacement)
        throw new Error('Third refusal did not move to an account')
      expect(await send('pi-budget', 2)).toEqual([replacement])
      expect(await send('pi-budget', 2)).toEqual([replacement])
      expect(await send('pi-budget', 2)).toEqual([replacement, initial])
      expect(await send('pi-other-budget', 1)).toEqual([other])
      expect(await send('pi-other-budget', 1)).toHaveLength(2)
      clearPiStickyQuotaRetries(storagePath, 'pi-budget')
      expect(await send('pi-budget', 2)).toEqual([initial])
      expect(pluginWaits).toBe(0)
      if (reporting) {
        await Bun.sleep(10)
        return { reports, sessions }
      }
      return
    }
    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat01-main-access',
      sessionId: 'pi-weekly-headers',
    })
    for await (const _event of stream) {
      /* Drain the provider stream. */
    }
    if (confirmed) {
      expect((await stream.result()).errorMessage).toBeUndefined()
      expect(authorizations).toEqual([
        'Bearer sk-ant-oat01-full-access',
        'Bearer sk-ant-oat01-room-access',
      ])
    } else {
      expect((await stream.result()).stopReason).toBe('error')
      expect(authorizations).toEqual(['Bearer sk-ant-oat01-full-access'])
    }
    expect(usageRequests).toHaveLength(confirmed ? 0 : 1)
    if (reporting) {
      await Bun.sleep(10)
      return { reports, sessions }
    }
  }

  test('Pi routing reports both confirmed 429 windows with resets and successful raw headers', async () => {
    const result = (await checkStickyQuotaReread(true, false, 'windows'))!
    const reports = result.reports.filter(
      (row) => row.outcome === 'served' || row.outcome === 'exhausted',
    )
    const credential = result.reports.find(
      (row) => row.kind === 'billing' && row.outcome === 'failed',
    )?.credential_id
    expect(credential).toEqual(expect.any(String))
    expect(
      result.sessions.every((session) => session === 'pi-weekly-headers'),
    ).toBe(true)
    expect(reports).toEqual([
      {
        account_id: fixtureAccountIdentity('full'),
        credential_id: credential,
        outcome: 'exhausted',
        window: '5h',
        resets_at: 2_000_000_000_000,
      },
      {
        account_id: fixtureAccountIdentity('full'),
        credential_id: credential,
        outcome: 'exhausted',
        window: '7d',
        resets_at: 2_000_000_100_000,
      },
      {
        account_id: fixtureAccountIdentity('room'),
        credential_id: expect.any(String),
        outcome: 'served',
        headers: {
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-future-field': 'raw',
        },
      },
    ])
  })

  test('Pi routing reports a scoped Fable 429 with the stored poll pool', async () => {
    const result = (await checkStickyQuotaReread(true, false, 'scoped'))!
    expect(result.reports.filter((row) => row.outcome === 'exhausted')).toEqual(
      [
        {
          account_id: fixtureAccountIdentity('full'),
          credential_id: expect.any(String),
          outcome: 'exhausted',
          window: '7d',
          pool: 'fable',
          resets_at: 2_000_000_000_000,
        },
      ],
    )
  })

  test('Pi routing sends no limit report for a 429 without confirming headers', async () => {
    const result = (await checkStickyQuotaReread(false, false, 'unconfirmed'))!
    expect(
      result.reports.filter(
        (row) => row.outcome === 'served' || row.outcome === 'exhausted',
      ),
    ).toEqual([])
    expect(result.reports.filter((row) => row.kind === 'wait')).toEqual([
      {
        kind: 'wait',
        phase: 'start',
        wait_id: expect.any(String),
        reason: 'rate_limited',
        attempt: 1,
        message: 'Waiting before retrying the current account.',
      },
    ])
  })

  test('Pi reports both host-owned unconfirmed retries without claiming their resume time', async () => {
    const result = (await checkStickyQuotaReread(false, true, 'unconfirmed'))!
    expect(
      result.reports.filter((row) => row.kind === 'wait').slice(0, 2),
    ).toEqual(
      [1, 2].map((attempt) => ({
        kind: 'wait',
        phase: 'start',
        wait_id: expect.any(String),
        reason: 'rate_limited',
        attempt,
        message: 'Waiting before retrying the current account.',
      })),
    )
  })

  test.each(['no-accessor', 'throw', 'reject', 'pending'] as const)(
    'Pi routing %s cannot affect confirmed 429 failover',
    async (mode) => {
      const result = (await checkStickyQuotaReread(true, false, mode))!
      expect(result.reports).toEqual([])
    },
  )

  test('sticky-balanced Pi weekly 429 headers skip the usage endpoint and still migrate', async () => {
    await checkStickyQuotaReread(true)
  })

  test('sticky-balanced Pi 429 without confirming headers re-reads the usage endpoint exactly once', async () => {
    await checkStickyQuotaReread(false)
  })

  test('sticky-balanced Pi retries unconfirmed 429s twice per turn and account without a plugin wait', async () => {
    await checkStickyQuotaReread(false, true)
  })

  for (const maxSameAccountWait of ['15', 'max'] as const) {
    for (const window of ['5h', '7d', 'model-scoped'] as const) {
      test(`sticky-balanced holds the assigned Pi account for a cache-bound ${window} reset with ${maxSameAccountWait} wait and moves for a far reset`, async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-hold-'))
        const storagePath = join(tempDir, 'anthropic-auth.json')
        const routingPath = join(tempDir, 'sticky-routes.json')
        process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
        process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = routingPath
        const checkedAt = Date.now()
        const quota = (remaining: number) => ({
          checkedAt,
          five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt },
          seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt },
          scoped: [
            {
              id: 'claude-weekly-scoped-fable',
              title: 'Fable only',
              modelName: 'Fable',
              usedPercent: 100 - remaining,
              remainingPercent: remaining,
              resetsAt: new Date(
                checkedAt + 4 * 24 * 60 * 60_000,
              ).toISOString(),
              checkedAt,
            },
          ],
        })
        await saveNativePiFixture(
          {
            version: 1,
            mainAccountId: 'main-account',
            main: { type: 'opencode', provider: 'anthropic' },
            fallbackOn: [401, 403, 429],
            quota: {
              enabled: true,
              checkIntervalMinutes: 5,
              minimumRemaining: { five_hour: 1, seven_day: 1 },
              failClosedOnUnknownQuota: true,
              mainQuota: { ...quota(0), accountIdentity: 'main-account' },
              mainQuotaCheckedAt: checkedAt,
            },
            routing: { mode: 'sticky-balanced', maxSameAccountWait },
            claudeCache: { enabled: true, mode: 'explicit' },
            accounts: [
              {
                id: 'yiyi',
                type: 'oauth',
                access: 'sk-ant-oat01-scarce-access',
                refresh: 'scarce-refresh',
                expires: checkedAt + 5 * 60 * 60_000,
                quota: quota(13),
              },
              {
                id: 'ufuk2',
                type: 'oauth',
                access: 'sk-ant-oat01-abundant-access',
                refresh: 'abundant-refresh',
                expires: checkedAt + 5 * 60 * 60_000,
                quota: quota(98),
              },
            ],
          },
          storagePath,
        )

        let useLongReset = false
        const authorizations: string[] = []
        globalThis.fetch = mock(
          (input: string | URL | Request, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : input.toString()
            const authorization =
              new Headers(init?.headers).get('authorization') ?? ''
            const abundant =
              authorization === 'Bearer sk-ant-oat01-abundant-access'
            if (url.includes('/api/oauth/usage')) {
              const reset = new Date(
                checkedAt +
                  (useLongReset
                    ? 120
                    : maxSameAccountWait === 'max'
                      ? 30
                      : 10) *
                    60_000,
              ).toISOString()
              return Promise.resolve(
                new Response(
                  JSON.stringify({
                    five_hour: {
                      utilization: abundant && window === '5h' ? 100 : 0,
                      resets_at: reset,
                    },
                    seven_day: {
                      utilization: abundant && window === '7d' ? 100 : 0,
                      resets_at: reset,
                    },
                    limits: [
                      {
                        kind: 'weekly_scoped',
                        group: 'weekly',
                        percent:
                          authorization === 'Bearer sk-ant-oat01-main-access' ||
                          (abundant && window === 'model-scoped')
                            ? 100
                            : abundant
                              ? 2
                              : 87,
                        resets_at: reset,
                        scope: { model: { display_name: 'Fable' } },
                      },
                    ],
                  }),
                  { status: 200 },
                ),
              )
            }
            if (!url.includes('/v1/messages'))
              return Promise.resolve(new Response('{}'))
            authorizations.push(authorization)
            return Promise.resolve(
              new Response(
                abundant
                  ? 'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"quota"}}\n\n'
                  : [
                      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
                      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
                      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                    ].join(''),
                { status: 200 },
              ),
            )
          },
        ) as unknown as typeof fetch

        const wait = {
          setTimeout: ((callback: () => void) => {
            queueMicrotask(callback)
            return 1
          }) as unknown as typeof setTimeout,
          clearTimeout: (() => {}) as unknown as typeof clearTimeout,
        }
        const send = () =>
          streamCortexKitAnthropic(
            anthropicModel,
            anthropicContext,
            {
              apiKey: 'sk-ant-oat01-main-access',
              sessionId: 'ses_pi_sticky_hold',
            },
            undefined,
            wait,
          )
        for (let request = 0; request < 2; request++) {
          const events = []
          const stream = send()
          for await (const event of stream) events.push(event)
          const error = events.find((event) => event.type === 'error')
          expect(error?.error.errorMessage).toContain('HTTP 412')
          expect(error?.error.errorMessage).toContain(
            'The selected OAuth account cannot serve this request.',
          )
          await getPiNativeRuntime(storagePath).drainRoutingPublications()
          expect(
            Object.values(
              JSON.parse(await readFile(routingPath, 'utf8')).assignments,
            ),
          ).toMatchObject([{ accountId: 'ufuk2' }])
        }
        expect(authorizations).toEqual(['Bearer sk-ant-oat01-abundant-access'])

        useLongReset = true
        const recheck = send()
        for await (const _event of recheck) {
          /* Refresh the quota after the bounded wait. */
        }
        const moved = send()
        for await (const _event of moved) {
          // Drain the successful retry so its final result is available.
        }
        expect((await moved.result()).errorMessage).toBeUndefined()
        expect(authorizations).toEqual([
          'Bearer sk-ant-oat01-abundant-access',
          'Bearer sk-ant-oat01-scarce-access',
        ])
        await getPiNativeRuntime(storagePath).drainRoutingPublications()
        expect(
          Object.values(
            JSON.parse(await readFile(routingPath, 'utf8')).assignments,
          ),
        ).toMatchObject([{ accountId: 'yiyi' }])
      })
    }
  }

  test('sticky-balanced keeps repeated Pi session requests on the quota-selected account', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-routing-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - fableRemaining,
        remainingPercent: Math.max(40, fableRemaining),
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await saveNativePiFixture(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 240,
        },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: { ...quota(0), accountIdentity: 'main-account' },
          mainQuotaCheckedAt: checkedAt,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'yiyi',
            type: 'oauth',
            access: 'sk-ant-oat01-scarce-access',
            refresh: 'scarce-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(13),
          },
          {
            id: 'ufuk2',
            type: 'oauth',
            access: 'sk-ant-oat01-abundant-access',
            refresh: 'abundant-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(98),
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (url.includes('/oauth/token')) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'invalid_grant' }), {
              status: 400,
            }),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (authorization === 'Bearer sk-ant-oat01-main-access') {
          return Promise.resolve(new Response('unauthorized', { status: 401 }))
        }
        return Promise.resolve(
          new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    for (let request = 0; request < 2; request++) {
      const stream = streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        {
          apiKey: 'sk-ant-oat01-main-access',
          sessionId: 'ses_pi_sticky',
        },
      )
      for await (const _event of stream) {
        // Drain the provider stream.
      }
    }

    const switchedOpus = streamCortexKitAnthropic(
      { ...anthropicModel, id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      anthropicContext,
      {
        apiKey: 'sk-ant-oat01-main-access',
        sessionId: 'ses_pi_sticky',
      },
    )
    for await (const _event of switchedOpus) {
      // Drain the provider stream.
    }

    const directOpus = streamCortexKitAnthropic(
      { ...anthropicModel, id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      anthropicContext,
      {
        apiKey: 'sk-ant-oat01-main-access',
        sessionId: 'ses_pi_direct_opus',
      },
    )
    for await (const _event of directOpus) {
      // Drain the provider stream.
    }
    expect((await directOpus.result()).errorMessage).toBeUndefined()

    // The main account’s invalid_grant prevents its reuse. The next Opus
    // session must select the usable fallback instead of sending the rejected
    // main credential again.
    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-abundant-access',
      'Bearer sk-ant-oat01-abundant-access',
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-abundant-access',
      'Bearer sk-ant-oat01-abundant-access',
    ])
  })

  for (const knownBeforeSend of [true, false]) {
    test(`host retry cap rechecks a 26-hour Pi pool once without another model request (known before send=${knownBeforeSend})`, async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'pi-long-pool-reset-'))
      const storagePath = join(tempDir, 'anthropic-auth.json')
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
        tempDir,
        'sticky-routes.json',
      )
      const checkedAt = Date.now()
      const resetsAt = new Date(checkedAt + 26 * 3_600_000).toISOString()
      const quota = {
        checkedAt,
        five_hour: { remainingPercent: 100, usedPercent: 0, checkedAt },
        seven_day: {
          remainingPercent: knownBeforeSend ? 0 : 90,
          usedPercent: knownBeforeSend ? 100 : 10,
          checkedAt,
          resetsAt,
        },
      }
      await saveNativePiFixture(
        {
          version: 1,
          mainAccountId: 'main-account',
          main: { type: 'opencode', provider: 'anthropic' },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 1, seven_day: 1 },
            mainQuota: { ...quota, accountIdentity: 'main-account' },
            mainQuotaCheckedAt: checkedAt,
          },
          routing: { mode: 'sticky-balanced', maxSameAccountWait: 'max' },
          accounts: [],
        },
        storagePath,
      )
      let messageRequests = 0
      globalThis.fetch = mock((input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.includes('/v1/messages')) {
          messageRequests++
          return Promise.resolve(
            Response.json(
              {
                error: {
                  type: 'rate_limit_error',
                  message: 'Synthetic upstream text must not be shown',
                },
              },
              {
                status: 429,
                headers: {
                  'retry-after': '93151',
                  'retry-after-ms': '93151000',
                  'anthropic-ratelimit-unified-7d-utilization': '1',
                  'anthropic-ratelimit-unified-7d-reset': String(
                    Date.parse(resetsAt) / 1000,
                  ),
                },
              },
            ),
          )
        }
        return Promise.resolve(
          Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 100, resets_at: resetsAt },
          }),
        )
      }) as unknown as typeof fetch
      const sessionId = 'pi-26-hour-pool'
      sessionCacheActivity.record(sessionId, 'main', 26 * 3_600_000, checkedAt)
      const delays: number[] = []
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const stream = streamCortexKitAnthropic(
            anthropicModel,
            anthropicContext,
            { apiKey: 'sk-ant-oat01-main-access', sessionId },
            undefined,
            {
              setTimeout: ((callback: () => void, delay: number) => {
                delays.push(delay)
                queueMicrotask(callback)
                return 1
              }) as unknown as typeof setTimeout,
              clearTimeout: (() => {}) as unknown as typeof clearTimeout,
            },
          )
          for await (const _event of stream) {
            /* Drain the local refusal. */
          }
          const result = await stream.result()
          expect(result.errorMessage).toContain('weekly limit')
          expect(result.errorMessage).toContain('UTC (in 26 h)')
          expect(result.errorMessage).toContain(
            'Send the message again after that.',
          )
          expect(isRetryableAssistantError(result)).toBe(false)
          expect(messageRequests).toBe(knownBeforeSend ? 0 : 1)
          expect(result.errorMessage).not.toContain('Synthetic upstream text')
        }
        expect(delays).toEqual([900_000, 900_000])
      } finally {
        sessionCacheActivity.forget(sessionId)
      }
    })
  }

  test('sticky-balanced reports main re-login when no fallback can serve the requested model', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-no-route-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await saveNativePiFixture(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 240,
          mainLastRefreshError: {
            message: 'invalid_grant',
            checkedAt,
            status: 400,
            permanent: true,
          },
        },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: { ...quota(88), accountIdentity: 'main-account' },
          mainQuotaCheckedAt: checkedAt,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'fallback-a',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-a-access',
            refresh: 'fallback-a-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
          {
            id: 'fallback-b',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-b-access',
            refresh: 'fallback-b-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
        ],
      },
      storagePath,
    )

    let messageRequests = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/v1/messages')) messageRequests += 1
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const events = []
    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat01-main-access',
      sessionId: 'ses_pi_sticky_no_fable_route',
    })
    for await (const event of stream) events.push(event)

    const error = events.find((event) => event.type === 'error')
    expect(error?.error.errorMessage).toContain('HTTP 401')
    expect(error?.error.errorMessage).toContain(
      'Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable for Fable.',
    )
    expect(messageRequests).toBe(0)
  })

  test('sticky-balanced preserves the strict API fallback gate after OAuth exhaustion', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-api-routing-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
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
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
      ],
    })
    await saveNativePiFixture(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: { ...quota(0), accountIdentity: 'main-account' },
          mainQuotaCheckedAt: checkedAt,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'oauth-fallback',
            type: 'oauth',
            access: 'sk-ant-oat01-fallback-access',
            refresh: 'fallback-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(100),
          },
          {
            id: 'api-fallback',
            type: 'api',
            baseURL: 'https://provider.example/anthropic',
            authHeader: 'authorization-bearer',
            apiKey: 'api-key',
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 100 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 100,
                    scope: { model: { display_name: 'Fable' } },
                  },
                ],
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (authorization === 'Bearer sk-ant-oat01-fallback-access') {
          return Promise.resolve(new Response('exhausted', { status: 429 }))
        }
        return Promise.resolve(
          new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat01-main-access',
      sessionId: 'ses_pi_sticky_api',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual([
      'Bearer sk-ant-oat01-fallback-access',
      'Bearer api-key',
    ])
  })

  test('releases early-abandoned SSE readers without cancelling the stream', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"message_start"}\n\n'),
        )
      },
      cancel() {
        cancelled = true
      },
    })

    const events = parseSse(new Response(body))
    const first = await events.next()
    expect(first.value?.type).toBe('message_start')

    await events.return(undefined)

    expect(cancelled).toBe(false)
  })
})

describe('Pi Anthropic stream content blocks', () => {
  test('preserves redacted thinking for same-model replay', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-redacted-thinking-'))
    process.env.PI_ANTHROPIC_AUTH_FILE = join(tempDir, 'anthropic-auth.json')
    await saveNativePiFixture(
      { version: 1, accounts: [] },
      process.env.PI_ANTHROPIC_AUTH_FILE,
    )

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (!url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque-redacted-data"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const events: any[] = []
    const providerStream = streamCortexKitAnthropic(
      anthropicModel,
      anthropicContext,
      {
        apiKey: 'sk-ant-oat01-main-access',
        sessionId: 'ses_pi_redacted_thinking',
      },
    )
    for await (const event of providerStream) events.push(event)

    expect(events.map((event) => event.type)).toContain('thinking_start')
    expect(events.map((event) => event.type)).toContain('thinking_end')
    const done = events.find((event) => event.type === 'done')
    expect(done?.message.content).toEqual([
      {
        type: 'thinking',
        thinking: '[Reasoning redacted]',
        thinkingSignature: 'opaque-redacted-data',
        redacted: true,
      },
    ])
  })
})

test('Pi 0.86 normalized transcript maps a returned Claude Code tool name back to the callable host tool', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pi-transcript-tool-roundtrip-'))
  const storagePath = join(tempDir, 'anthropic-auth.json')
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture(
    { version: 1, accounts: [], quota: { enabled: false } },
    storagePath,
  )
  const normalized = normalizeContext({
    systemPrompt: 'You may run the bash tool.',
    tools: [
      {
        name: 'bash',
        description: 'Run shell commands',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ],
    messages: [
      { role: 'user', content: 'Run echo probe-ok', timestamp: Date.now() },
    ],
  } as any)
  expect((normalized as { tools?: unknown }).tools).toBeUndefined()
  let sentTools: Array<{ name: string }> | undefined
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/claude_cli/bootstrap')) {
        return Response.json({
          oauth_account: { account_uuid: 'pi-tool-account' },
        })
      }
      const body = JSON.parse(String(init?.body)) as {
        tools?: Array<{ name: string }>
      }
      sentTools = body.tools
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_tool","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_probe","name":"Bash","input":{}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo probe-ok\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  ) as unknown as typeof fetch
  const result = await streamCortexKitAnthropic(
    anthropicModel,
    normalized as any,
    {
      apiKey: 'sk-ant-oat-pi-tool',
      sessionId: 'ses_pi_tool_roundtrip',
    },
  ).result()
  expect(sentTools?.map((tool) => tool.name)).toContain('Bash')
  expect(result.content).toContainEqual(
    expect.objectContaining({
      type: 'toolCall',
      id: 'toolu_probe',
      name: 'bash',
      arguments: { command: 'echo probe-ok' },
    }),
  )
})

test.each([false, true])(
  'maps response tool names only through the exact request snapshot (hook removes Bash: %s)',
  async (removeBash) => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-tool-name-snapshot-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      { version: 1, accounts: [], quota: { enabled: false } },
      storagePath,
    )
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    })
    // `write` is removed by a later system entry, so the request snapshot holds
    // read, bash and the mixed-case custom tool only.
    const context = normalizeContext({
      messages: [
        { role: 'user', content: 'inspect', timestamp: 0 },
        {
          role: 'system',
          content: '',
          toolsRemoved: [tool('write')],
          toolsAdded: [tool('myCustomHTTPTool')],
          timestamp: 1,
        },
      ],
      tools: [tool('read'), tool('bash'), tool('write')],
    } as any)
    let requestBody: any
    const wireCalls = [
      ['Read', 'call_read'],
      ['Bash', 'call_bash'],
      ['myCustomHTTPTool', 'call_custom'],
      // Not in the snapshot: neither may be case-folded onto a host tool.
      ['Write', 'call_removed'],
      ['MYCUSTOMHTTPTOOL', 'call_casefold'],
    ] as const
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      ...wireCalls.flatMap(([name, id], index) => [
        `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`,
      ]),
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/api/claude_cli/bootstrap')) {
          return Response.json({
            oauth_account: { account_uuid: 'tool-name-test' },
          })
        }
        requestBody = JSON.parse(String(init?.body))
        return new Response(frames, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    ) as unknown as typeof fetch

    const result = await streamCortexKitAnthropic(
      anthropicModel,
      context as any,
      {
        apiKey: 'sk-ant-oat-tool-name',
        sessionId: 'ses_tool_name_snapshot',
        ...(removeBash && {
          onPayload: (payload: unknown) => {
            const body = payload as { tools: Array<{ name: string }> }
            body.tools = body.tools.filter((tool) => tool.name !== 'Bash')
          },
        }),
      },
    ).result()

    expect(requestBody.tools.map((tool: any) => tool.name)).toEqual([
      'Read',
      ...(!removeBash ? ['Bash'] : []),
      'myCustomHTTPTool',
    ])
    expect(
      result.content
        .filter((part: any) => part.type === 'toolCall')
        .map((call: any) => [call.name, call.id]),
    ).toEqual([
      ['read', 'call_read'],
      [removeBash ? 'Bash' : 'bash', 'call_bash'],
      ['myCustomHTTPTool', 'call_custom'],
      ['Write', 'call_removed'],
      ['MYCUSTOMHTTPTOOL', 'call_casefold'],
    ])
  },
)

// Pi's provider contract: a provider calls `options.onPayload` before sending
// and uses any replacement it returns. Hosts rely on it to place their own
// cache breakpoints; without the call a host's request layout silently never
// reaches the provider.
describe('Pi onPayload hook', () => {
  async function capture(
    onPayload?: (payload: unknown, model: unknown) => unknown,
  ): Promise<string> {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = await mkdtemp(join(tmpdir(), 'pi-on-payload-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      { version: 1, accounts: [], quota: { enabled: false } },
      storagePath,
    )
    let sent = ''
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/api/claude_cli/bootstrap')) {
          return Response.json({
            oauth_account: { account_uuid: 'pi-on-payload-account' },
          })
        }
        sent = String(init?.body)
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      },
    ) as unknown as typeof fetch
    const context = normalizeContext({
      systemPrompt: 'test',
      tools: [],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'host view' },
            { type: 'text', text: 'host input' },
          ],
          timestamp: 0,
        },
      ],
    } as any)
    const result = await streamCortexKitAnthropic(
      anthropicModel,
      context as any,
      {
        apiKey: 'sk-ant-oat-pi-on-payload',
        sessionId: 'ses_pi_on_payload',
        ...(onPayload ? { onPayload } : {}),
      } as any,
    ).result()
    if (result.stopReason === 'error') throw new Error(result.errorMessage)
    return sent
  }

  test('Pi OAuth strips service_tier added by the payload hook before signing', async () => {
    const sent = await capture((payload) => ({
      ...(payload as Record<string, unknown>),
      service_tier: 'auto',
    }))
    expect(JSON.parse(sent)).not.toHaveProperty('service_tier')
    expect(await signRequestBody(resetBillingHeaderCCH(sent))).toBe(sent)
  })

  test('sends the payload the hook returns, signed after the hook', async () => {
    const seen: Array<{ payload: Record<string, any>; model: unknown }> = []
    const sent = await capture((payload, model) => {
      seen.push({ payload: structuredClone(payload as object), model })
      // A host breakpoint on its own block, only on the returned replacement.
      const body = structuredClone(payload) as Record<string, any>
      body.stream = false
      const user = body.messages.find((message: any) => message.role === 'user')
      const view = user.content.find((block: any) => block.text === 'host view')
      view.cache_control = { type: 'ephemeral', ttl: '1h' }
      return body
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.model).toBe(anthropicModel)
    // The hook sees the provider's own breakpoints already placed.
    expect(JSON.stringify(seen[0]?.payload)).toContain('cache_control')
    const body = JSON.parse(sent)
    expect(body.stream).toBe(true)
    const user = body.messages.find((message: any) => message.role === 'user')
    expect(
      user.content.find((block: any) => block.text === 'host view')
        ?.cache_control,
    ).toEqual({ type: 'ephemeral', ttl: '1h' })
    // Signed over the replaced body: re-signing the sent body reproduces it.
    expect(await signRequestBody(resetBillingHeaderCCH(sent))).toBe(sent)
  })

  test('adopts an async replacement and forces SSE before signing', async () => {
    const sent = await capture(async (payload) => {
      await Promise.resolve()
      const body = structuredClone(payload) as Record<string, any>
      body.stream = false
      body.messages[0].content.push({ type: 'text', text: 'async replacement' })
      return body
    })
    const body = JSON.parse(sent)
    expect(body.stream).toBe(true)
    expect(body.messages[0].content.at(-1).text).toBe('async replacement')
    expect(await signRequestBody(resetBillingHeaderCCH(sent))).toBe(sent)
  })

  test('signs in-place edits when the hook returns undefined', async () => {
    const sent = await capture((payload) => {
      const body = payload as Record<string, any>
      body.messages[0].content.push({ type: 'text', text: 'in-place edit' })
      return undefined
    })
    expect(JSON.parse(sent).messages[0].content.at(-1).text).toBe(
      'in-place edit',
    )
    expect(await signRequestBody(resetBillingHeaderCCH(sent))).toBe(sent)
  })

  test('refuses a hook replacement with more than four breakpoints before sending', async () => {
    let sentAny = false
    await expect(
      capture((payload) => {
        const body = structuredClone(payload) as Record<string, any>
        for (const message of body.messages)
          for (const block of message.content)
            block.cache_control = { type: 'ephemeral' }
        body.cache_control = { type: 'ephemeral' }
        body.system = [
          ...(body.system ?? []),
          { type: 'text', text: 'host', cache_control: { type: 'ephemeral' } },
        ]
        sentAny = true
        return body
      }),
    ).rejects.toThrow(/at most 4 cache breakpoints/u)
    expect(sentAny).toBe(true)
  })

  test('keeps the provider payload when the hook returns nothing', async () => {
    // Each request carries its own session metadata and signature, so compare
    // the bodies without them.
    const stable = (sent: string) =>
      JSON.stringify({
        ...JSON.parse(resetBillingHeaderCCH(sent)),
        metadata: undefined,
      })
    const withoutHook = await capture()
    const withVoidHook = await capture(() => undefined)
    expect(stable(withVoidHook)).toBe(stable(withoutHook))
  })

  test("keeps a user message's text parts as separate blocks", async () => {
    const body = JSON.parse(await capture())
    const user = body.messages.find((message: any) => message.role === 'user')
    const texts = user.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
    expect(texts).toContain('host view')
    expect(texts).toContain('host input')
    expect(texts.join('')).not.toContain('host view\nhost input')
  })
})

describe("Pi cacheRetention 'long'", () => {
  test('requests the one-hour TTL even when the account setting is off', async () => {
    const send = async (cacheRetention?: string) => {
      tempDir = await mkdtemp(join(tmpdir(), 'pi-cache-retention-'))
      const storagePath = join(tempDir, 'anthropic-auth.json')
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      await saveNativePiFixture(
        { version: 1, accounts: [], quota: { enabled: false } },
        storagePath,
      )
      let sent: any
      globalThis.fetch = mock(
        async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).includes('/api/claude_cli/bootstrap')) {
            return Response.json({
              oauth_account: { account_uuid: 'pi-cache-retention' },
            })
          }
          sent = JSON.parse(String(init?.body))
          return new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        },
      ) as unknown as typeof fetch
      await streamCortexKitAnthropic(
        anthropicModel,
        normalizeContext({
          systemPrompt: 'test',
          tools: [],
          messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
        } as any) as any,
        {
          apiKey: 'sk-ant-oat-cache-retention',
          sessionId: 'ses_cache_retention',
          ...(cacheRetention ? { cacheRetention } : {}),
        } as any,
      ).result()
      await rm(tempDir, { recursive: true, force: true })
      tempDir = undefined
      const ttls = new Set<unknown>()
      JSON.stringify(sent, (key, value) => {
        if (key === 'cache_control') ttls.add(value.ttl)
        return value
      })
      return [...ttls]
    }
    // Sticky routing keeps the session on its account for the cache lifetime
    // the request actually asked for.
    const heldFor = () => {
      const now = Date.now()
      return (
        (sessionCacheActivity.holdUntil(
          'ses_cache_retention',
          'main',
          now,
          'max',
        ) ?? now) - now
      )
    }
    try {
      expect(await send()).toEqual([undefined])
      expect(heldFor()).toBeLessThanOrEqual(5 * 60_000)
      expect(await send('short')).toEqual([undefined])
      expect(heldFor()).toBeLessThanOrEqual(5 * 60_000)
      expect(await send('long')).toEqual(['1h'])
      expect(heldFor()).toBeGreaterThan(55 * 60_000)
    } finally {
      sessionCacheActivity.forget('ses_cache_retention')
    }
  })
})

describe('Pi final-payload cache activity', () => {
  const sessionId = 'ses_final_payload_activity'
  afterEach(() => sessionCacheActivity.forget(sessionId))

  async function send(options: {
    long?: boolean
    persistent?: boolean
    mode?: 'explicit' | 'hybrid' | 'automatic'
    edit?: (body: any) => unknown
    outcome?: 'failed' | 'cancelled'
  }) {
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
    tempDir = await mkdtemp(join(tmpdir(), 'pi-final-cache-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        quota: { enabled: false },
        claudeCache: {
          enabled: options.persistent ?? false,
          mode: options.mode ?? 'explicit',
        },
      },
      storagePath,
    )
    const controller = new AbortController()
    let sent: any
    let requests = 0
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/api/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: { account_uuid: 'pi-final-cache-account' },
          })
        requests += 1
        sent = JSON.parse(String(init?.body))
        if (options.outcome === 'failed')
          return Response.json(
            { error: { type: 'invalid_request_error', message: 'rejected' } },
            { status: 400 },
          )
        if (options.outcome === 'cancelled') controller.abort()
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      },
    ) as unknown as typeof fetch
    const started = Date.now()
    const result = await streamCortexKitAnthropic(
      anthropicModel,
      normalizeContext({
        ...anthropicContext,
        tools: [
          {
            name: 'bash',
            description: 'shell',
            parameters: {
              type: 'object',
              properties: {
                data: {
                  type: 'object',
                  default: { cache_control: { type: 'ephemeral', ttl: '1h' } },
                },
              },
            },
          },
        ],
      } as any) as any,
      {
        apiKey: 'sk-ant-oat-final-cache',
        sessionId,
        signal: controller.signal,
        cacheRetention: options.long ? 'long' : 'short',
        ...(options.edit ? { onPayload: options.edit } : {}),
      },
    ).result()
    return { result, sent, requests, started, finished: Date.now() }
  }

  test.each([
    {
      name: 'long without persistent caching',
      long: true,
      ttl: 3_600_000,
      writtenTtls: ['1h', '1h', '1h', '1h'],
    },
    {
      name: 'persistent explicit',
      persistent: true,
      mode: 'explicit' as const,
      ttl: 3_600_000,
      writtenTtls: ['1h', '1h', '1h', '1h'],
    },
    {
      name: 'persistent hybrid',
      persistent: true,
      mode: 'hybrid' as const,
      ttl: 3_600_000,
      writtenTtls: ['1h', '1h', '1h', '1h'],
    },
    {
      name: 'persistent automatic',
      persistent: true,
      mode: 'automatic' as const,
      ttl: 3_600_000,
      writtenTtls: ['1h'],
    },
    {
      name: 'hook upgrades a breakpoint',
      edit: (body: any) => {
        body.tools[0].cache_control.ttl = '1h'
      },
      ttl: 3_600_000,
      writtenTtls: [undefined, '1h', undefined, undefined],
    },
    {
      name: 'hook removes persistent automatic retention',
      persistent: true,
      mode: 'automatic' as const,
      edit: (body: any) => {
        delete body.cache_control
      },
      ttl: 300_000,
      writtenTtls: [],
    },
    {
      name: 'mixed TTLs keep the longest written TTL',
      long: true,
      edit: (body: any) => {
        delete body.tools[0].cache_control.ttl
      },
      ttl: 3_600_000,
      writtenTtls: ['1h', undefined, '1h', '1h'],
    },
    {
      name: 'nested tool data is not a breakpoint',
      ttl: 300_000,
      writtenTtls: [undefined, undefined, undefined, undefined],
    },
    {
      name: 'hook serializes a different TTL',
      edit: (body: any) => {
        const tool = body.tools[0]
        tool.toJSON = () => ({
          ...tool,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        })
      },
      ttl: 3_600_000,
      writtenTtls: [undefined, '1h', undefined, undefined],
    },
  ])(
    'records the final serialized TTL and hold bound: $name',
    async (options) => {
      const { result, sent, requests, started, finished } = await send(options)
      expect(result.stopReason).toBe('stop')
      expect(requests).toBe(1)
      expect(
        sent.tools[0].input_schema.properties.data.default.cache_control.ttl,
      ).toBe('1h')
      const controls = [
        sent.cache_control,
        ...sent.system.map((block: any) => block.cache_control),
        ...sent.tools.map((tool: any) => tool.cache_control),
        ...sent.messages.flatMap((message: any) => [
          message.cache_control,
          ...(Array.isArray(message.content)
            ? message.content.map((block: any) => block.cache_control)
            : []),
        ]),
      ]
      expect(controls.filter(Boolean).map((control) => control.ttl)).toEqual([
        ...options.writtenTtls,
      ])
      expect(sessionCacheActivity.ttlMs(sessionId)).toBe(options.ttl)
      const hold = sessionCacheActivity.holdUntil(
        sessionId,
        'main',
        finished,
        'max',
      )!
      expect(hold).toBeGreaterThanOrEqual(started + options.ttl)
      expect(hold).toBeLessThanOrEqual(finished + options.ttl)
      expect(
        sessionCacheActivity.holdUntil(
          sessionId,
          'another-account',
          finished,
          'max',
        ),
      ).toBeUndefined()
    },
  )

  test('a later accepted short request replaces the earlier one-hour lifetime', async () => {
    expect((await send({ long: true })).result.stopReason).toBe('stop')
    expect(sessionCacheActivity.ttlMs(sessionId)).toBe(3_600_000)
    const { result, started, finished } = await send({})
    expect(result.stopReason).toBe('stop')
    expect(sessionCacheActivity.ttlMs(sessionId)).toBe(300_000)
    const hold = sessionCacheActivity.holdUntil(
      sessionId,
      'main',
      finished,
      'max',
    )!
    expect(hold).toBeGreaterThanOrEqual(started + 300_000)
    expect(hold).toBeLessThanOrEqual(finished + 300_000)
  })

  test.each(['failed', 'cancelled'] as const)(
    'does not refresh cache activity for a %s request',
    async (outcome) => {
      const acceptedAt = Date.now() - 60_000
      sessionCacheActivity.record(sessionId, 'main', 300_000, acceptedAt)
      const { result, requests } = await send({ long: true, outcome })
      expect(requests).toBe(1)
      expect(result.stopReason).toBe(outcome === 'failed' ? 'error' : 'aborted')
      expect(sessionCacheActivity.ttlMs(sessionId)).toBe(300_000)
      expect(
        sessionCacheActivity.holdUntil(sessionId, 'main', Date.now(), 'max'),
      ).toBe(acceptedAt + 300_000)
    },
  )
})
