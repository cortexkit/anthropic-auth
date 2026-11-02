import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  createNativePoolStore,
  resetBillingHeaderCCH,
  resolveNativePoolPaths,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { getPiNativeRuntime } from '../native.ts'
import {
  buildExplicitBaseMessagesUrl,
  configureApiRouteHeaders,
  parseSse,
  primaryResponseAllowsApiFallback,
  streamCortexKitAnthropic,
} from '../stream.ts'
import { normalizeContext } from '../transcript.ts'
import { readNativePiFixture, saveNativePiFixture } from './native-fixture.ts'

let tempDir: string | undefined
const originalFetch = globalThis.fetch
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

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
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

  const checkStickyQuotaReread = async (confirmed: boolean) => {
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
            quota: quota(100),
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
        if (authorization.includes('full-access'))
          return Response.json(
            { error: { type: 'rate_limit_error' } },
            {
              status: 429,
              headers: {
                'retry-after': '432000',
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
        )
      },
    ) as unknown as typeof fetch
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
  }

  test('sticky-balanced Pi weekly 429 headers skip the usage endpoint and still migrate', async () => {
    await checkStickyQuotaReread(true)
  })

  test('sticky-balanced Pi 429 without confirming headers re-reads the usage endpoint exactly once', async () => {
    await checkStickyQuotaReread(false)
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

  test('sends the payload the hook returns, signed after the hook', async () => {
    const seen: Array<{ payload: Record<string, any>; model: unknown }> = []
    const sent = await capture((payload, model) => {
      seen.push({ payload: structuredClone(payload as object), model })
      // A host breakpoint on its own block, only on the returned replacement.
      const body = structuredClone(payload) as Record<string, any>
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
    const user = body.messages.find((message: any) => message.role === 'user')
    expect(
      user.content.find((block: any) => block.text === 'host view')
        ?.cache_control,
    ).toEqual({ type: 'ephemeral', ttl: '1h' })
    // Signed over the replaced body: re-signing the sent body reproduces it.
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
