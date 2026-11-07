import { afterEach, describe, expect, mock, spyOn } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import * as Core from '@cortexkit/anthropic-auth-core'
import {
  type AccountStorage,
  createNativePoolStore,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import type { getSidebarState } from '../sidebar-state'
import { rewriteRequestBody } from '../transform.ts'
import type { createMockClient } from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  refreshPoolMainElsewhere,
  replacePoolMainLogin,
  syntheticMainHostAuth,
  updatePoolRelay as updatePoolRelayWithCtx,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function useTempAccountFile(
  storage: AccountStorage,
  mainHostAuth: {
    access: string
    refresh: string
    expires: number
  } = syntheticMainHostAuth(),
) {
  return useTempAccountFileWithCtx(testContext, storage, mainHostAuth)
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}
function updatePoolRelay(
  patch: Parameters<
    ReturnType<
      typeof import('@cortexkit/anthropic-auth-core').createNativeAccountRuntime
    >['updateRelay']
  >[0],
) {
  return updatePoolRelayWithCtx(testContext, patch)
}
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  return waitForSidebarStateWithCtx(testContext, predicate)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}

describe('OAuth billing lineage', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('advances cc_prev_req from genuine HTTP relay response headers', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        refresh: {
          enabled: false,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: false,
          transport: 'http',
        },
      }),
    )
    const sentBillingHeaders: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(
              Response.json({
                oauth_account: { account_uuid: 'billing-relay-account' },
              }),
            )
          }
          if (url.startsWith('https://relay.example.test')) {
            const payload = JSON.parse(String(init?.body)) as { body?: string }
            const body = JSON.parse(String(payload.body)) as {
              system?: Array<{ text?: string }>
            }
            sentBillingHeaders.push(String(body.system?.[0]?.text ?? ''))
            return Promise.resolve(
              new Response('{}', {
                status: 200,
                headers: {
                  'request-id':
                    sentBillingHeaders.length === 1
                      ? 'req_011111111111111111111111'
                      : 'req_022222222222222222222222',
                },
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const messages = [
      {
        info: {
          id: 'msg_billing_relay',
          role: 'user',
          sessionID: 'ses_billing_relay',
        },
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]
    await plugin['experimental.chat.messages.transform']({}, { messages })
    const auth = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        }),
      { models: {} },
    )
    const send = async (affinity: string) => {
      const output = { headers: {} as Record<string, string> }
      await plugin['chat.headers'](
        {
          sessionID: 'ses_billing_relay',
          message: { id: 'msg_billing_relay' },
        },
        output,
      )
      return auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          ...output.headers,
          'x-session-affinity': affinity,
        },
        body: JSON.stringify({
          model: 'claude-opus-5',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    }

    expect((await send('billing-relay-first')).status).toBe(200)
    expect((await send('billing-relay-second')).status).toBe(200)
    const firstPromptId = sentBillingHeaders[0]?.match(
      /cc_prompt_id=([^;]+);/,
    )?.[1]
    expect(firstPromptId).toBeTruthy()
    expect(sentBillingHeaders[0]).not.toContain('cc_prev_req=')
    expect(sentBillingHeaders[1]).toContain(`cc_prompt_id=${firstPromptId};`)
    expect(sentBillingHeaders[1]).toContain(
      'cc_prev_req=req_011111111111111111111111;',
    )
  })
})

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('dumps direct Anthropic requests when relay is disabled', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-direct-dump-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          dump: { enabled: true },
          quota: {
            enabled: false,
            mainQuota: {
              five_hour: {
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: Date.now(),
              },
              seven_day: {
                usedPercent: 40,
                remainingPercent: 60,
                checkedAt: Date.now(),
              },
            },
            mainQuotaCheckedAt: Date.now(),
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          },
        }),
      )

      globalThis.fetch = mock(
        withNativeAdmission((_input: any, _init: any) =>
          Promise.resolve(
            new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
          ),
        ),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-direct-dump' },
        body: JSON.stringify({
          model: 'claude-fable-5',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      const files = await readdir(dumpDir)
      const bodyPath = files.find((file) => file.endsWith('.body.json'))
      const metaPath = files.find((file) => file.endsWith('.meta.json'))
      const requestPath = files.find((file) => file.endsWith('.request.json'))
      expect(bodyPath).toBeString()
      expect(metaPath).toBeString()
      expect(requestPath).toBeString()
      expect(files.some((file) => file.endsWith('.relay.json'))).toBe(false)

      const body = JSON.parse(await readFile(join(dumpDir, bodyPath!), 'utf8'))
      const meta = JSON.parse(await readFile(join(dumpDir, metaPath!), 'utf8'))
      const request = JSON.parse(
        await readFile(join(dumpDir, requestPath!), 'utf8'),
      )

      expect(body.model).toBe('claude-fable-5')
      expect(meta).toMatchObject({
        transport: 'direct',
        route: 'main',
        status: 200,
        session: 'ses-direct-dump',
      })
      expect(meta.files.relay).toBeUndefined()
      expect(request).toMatchObject({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages?beta=true',
      })
      expect(request.headers.authorization).toBe('[redacted]')
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  // A loopback server stands in for api.anthropic.com: the plugin's fetch
  // still sees the production URL (so the gzip host rule applies) and the
  // stand-in network forwards the exact bytes to the server.
  type GzipWireTrace = {
    serverPort: number
    stopped: boolean
    sends: Array<{
      send: number
      encoding: string | null
      requestId: string | null
      bodyBytes: number | null
      clientLocalPort: number | null
      requestBodyBytes?: number
      contentLength?: string | null
      replyStatus?: number
      status?: number
      error?: ReturnType<typeof gzipWireError>
      serverError?: ReturnType<typeof gzipWireError>
    }>
  }
  // Keep earlier fixtures' ports too: a later server can get a stopped
  // server's port while Bun still has a pooled connection to that address.
  const gzipWireTraces: GzipWireTrace[] = []

  function gzipWireError(error: unknown) {
    return error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          code: 'code' in error ? error.code : undefined,
        }
      : { message: String(error) }
  }

  async function gzipWireScenario(replies: Response[]) {
    await useTempAccountFile(
      createFallbackStorage({ quota: { enabled: false }, accounts: [] }),
    )
    const received: Array<{ headers: Headers; body: Uint8Array }> = []
    const trace: GzipWireTrace = { serverPort: 0, stopped: false, sends: [] }
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request, server) {
        // The fixture sends sequentially, so the current send owns this
        // request. The peer port is the fetch client's local loopback port.
        const attempt = trace.sends.at(-1)!
        attempt.clientLocalPort = server.requestIP(request)?.port ?? null
        attempt.contentLength = request.headers.get('content-length')
        try {
          const body = new Uint8Array(await request.arrayBuffer())
          attempt.requestBodyBytes = body.byteLength
          received.push({
            headers: new Headers(request.headers),
            body,
          })
          const reply =
            replies.shift() ??
            new Response('event: message_stop\ndata: {}\n\n', {
              status: 200,
              headers: { 'request-id': 'req_011CGzipOk00000000000001' },
            })
          attempt.replyStatus = reply.status
          return reply
        } catch (error) {
          attempt.serverError = gzipWireError(error)
          throw error
        }
      },
    })
    trace.serverPort = upstream.port!
    gzipWireTraces.push(trace)
    globalThis.fetch = mock(
      withNativeAdmission(async (input: any, init: any) => {
        const target = new URL(input instanceof Request ? input.url : input)
        const headers = new Headers(init?.headers)
        const attempt: GzipWireTrace['sends'][number] = {
          send: trace.sends.length + 1,
          encoding: headers.get('content-encoding'),
          requestId: headers.get('x-client-request-id'),
          bodyBytes:
            typeof init?.body === 'string'
              ? Buffer.byteLength(init.body)
              : init?.body instanceof Uint8Array
                ? init.body.byteLength
                : null,
          // Bun fetch exposes no client socket. Null means the request
          // never reached the handler (or requestIP could not resolve it).
          clientLocalPort: null,
        }
        trace.sends.push(attempt)
        try {
          const response = await Bun.fetch(
            `http://127.0.0.1:${upstream.port}${target.pathname}${target.search}`,
            init,
          )
          attempt.status = response.status
          return response
        } catch (error) {
          attempt.error = gzipWireError(error)
          throw error
        }
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const send = () =>
      result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-gzip-wire' },
        body: JSON.stringify({
          model: 'claude-sonnet-5-5',
          max_tokens: 32000,
          stream: true,
          messages: [{ role: 'user', content: `Review: ${'x'.repeat(9000)}` }],
        }),
      }) as Promise<Response>
    return {
      received,
      send,
      traceFailure: (error: unknown) =>
        console.error(
          '[gzip-wire failure]',
          JSON.stringify({
            error: gzipWireError(error),
            fixtures: gzipWireTraces,
          }),
        ),
      stop: () => {
        trace.stopped = true
        return upstream.stop(true)
      },
    }
  }

  test('sends a large OAuth body gzipped with cch=00000 and padding', async () => {
    const { received, send, stop, traceFailure } = await gzipWireScenario([])
    try {
      const response = await send()
      await response.text()
      expect(received).toHaveLength(1)
      const wire = received[0]!
      expect(wire.headers.get('content-encoding')).toBe('gzip')
      expect(wire.headers.get('x-claude-code-request-class')).toBe('main')
      const plain = new TextDecoder().decode(gunzipSync(wire.body))
      const trimmed = plain.trimEnd()
      expect(plain.slice(trimmed.length)).toMatch(/^\n[ \t]{0,256}$/)
      const parsed = JSON.parse(trimmed)
      expect(parsed.system[0].text).toContain(' cch=00000;')
      // The same body signed is what an uncompressed send would carry.
      const signed = await Core.signRequestBody(trimmed)
      expect(signed).not.toBe(trimmed)
    } catch (error) {
      traceFailure(error)
      throw error
    } finally {
      stop()
    }
  })

  test('resends a rejected gzipped body uncompressed once with the same request id', async () => {
    const { received, send, stop, traceFailure } = await gzipWireScenario([
      new Response('Bad Request', { status: 400 }),
    ])
    try {
      const response = await send()
      await response.text()
      expect(response.status).toBe(200)
      expect(received).toHaveLength(2)
      const [first, resend] = received
      expect(first?.headers.get('content-encoding')).toBe('gzip')
      expect(resend?.headers.get('content-encoding')).toBeNull()
      expect(resend?.headers.get('x-client-request-id')).toBe(
        first?.headers.get('x-client-request-id'),
      )
      expect(resend?.headers.get('x-stainless-retry-count')).toBe('0')
      const identity = new TextDecoder().decode(resend!.body)
      expect(Core.extractBillingHeaderCCH(identity)).not.toBe('00000')
      expect(await Core.signRequestBody(identity)).toBe(identity)
      expect(Core.resetBillingHeaderCCH(identity)).toBe(
        new TextDecoder().decode(gunzipSync(first!.body)).trimEnd(),
      )

      // Latched: the next request goes out uncompressed on the first try.
      const next = await send()
      await next.text()
      expect(received).toHaveLength(3)
      expect(received[2]?.headers.get('content-encoding')).toBeNull()
    } catch (error) {
      traceFailure(error)
      throw error
    } finally {
      stop()
    }
  })

  test('dumps final streamed usage while retaining opening counters', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-stream-dump-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          dump: { enabled: true },
          quota: { enabled: false },
        }),
      )
      const start = `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_stream_usage',
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation: {
              ephemeral_5m_input_tokens: 4,
              ephemeral_1h_input_tokens: 16,
            },
            output_tokens: 3,
          },
          diagnostics: null,
        },
      })}\n\n`
      const delta = `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1749 },
      })}\n\n`
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response(`${start}${delta}`, {
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          ),
        ),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      const response = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-stream-dump' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(await response.text()).toBe(`${start}${delta}`)

      const files = await readdir(dumpDir)
      const responsePath = files.find((file) => file.endsWith('.response.json'))
      expect(responsePath).toBeString()
      expect(
        JSON.parse(await readFile(join(dumpDir, responsePath!), 'utf8')),
      ).toEqual({
        status: 200,
        message_id: 'msg_stream_usage',
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 4,
            ephemeral_1h_input_tokens: 16,
          },
          output_tokens: 1749,
        },
        diagnostics: null,
        stop_reason: 'end_turn',
        stream_complete: true,
      })
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test.each(['url', 'request'] as const)(
    'fetch wrapper sets OAuth headers and prefixes tools for %s input',
    async (kind) => {
      await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      })

      let capturedHeaders: Headers | undefined
      let capturedBody: string | undefined

      globalThis.fetch = mock(
        withNativeAdmission((input: any, init: any) => {
          const url = extractUrl(input)
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
          capturedHeaders = init?.headers
          capturedBody = init?.body
          return Promise.resolve(new Response(null, { status: 200 }))
        }),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-my-access-token',
            refresh: 'refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      const body = JSON.stringify({
        tools: [{ name: 'bash', type: 'function' }],
        messages: [{ role: 'user', content: 'hello world test message' }],
        system: 'You are a helpful assistant.',
      })

      const requestInit = {
        method: 'POST',
        headers: {
          'x-session-affinity': `session-abc-${kind}`,
          'x-opencode-session-id': `session-abc-${kind}`,
          'x-opencode-parent-session-id': 'parent-abc',
        },
        body,
      }
      if (kind === 'request')
        await result.fetch(new Request(MESSAGES_URL, requestInit))
      else await result.fetch(MESSAGES_URL, requestInit)

      expect(capturedHeaders).toBeDefined()
      expect(capturedHeaders!.get('authorization')).toBe(
        'Bearer sk-ant-oat01-my-access-token',
      )
      expect(capturedHeaders!.get('x-api-key')).toBeNull()
      expect(capturedHeaders!.get('x-session-affinity')).toBeNull()
      expect(capturedHeaders!.get('x-opencode-session')).toBeNull()
      expect(capturedHeaders!.get('x-opencode-session-id')).toBeNull()
      expect(capturedHeaders!.get('x-opencode-parent-session-id')).toBeNull()
      expect(capturedHeaders!.get('anthropic-beta')).toContain(
        'oauth-2025-04-20',
      )

      const parsedBody = JSON.parse(capturedBody!)
      expect(parsedBody.tools[0].name).toBe('mcp_Bash')
      // Three-block layout: billing header, identity, rest
      expect(parsedBody.system).toHaveLength(3)
      expect(parsedBody.system[0].text).toContain('x-anthropic-billing-header')
      expect(parsedBody.system[1].text).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      )
      expect(parsedBody.system[2].text).toBe('You are a helpful assistant.')
      // User message is untouched
      expect(parsedBody.messages[0].content).toBe('hello world test message')
    },
  )

  test.each(['url', 'request'] as const)(
    'uses configured relay instead of uploading full body directly for %s input',
    async (kind) => {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          relay: {
            enabled: true,
            url: 'https://relay.example.test',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'http',
          },
        }),
        {
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        },
      )

      let capturedUrl: string | undefined
      let capturedBody: string | undefined
      let capturedHeaders: Headers | undefined
      globalThis.fetch = mock(
        withNativeAdmission((input: any, init: any) => {
          const url = extractUrl(input)
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
          capturedUrl = url
          capturedBody = init?.body
          capturedHeaders = new Headers(init?.headers)
          return Promise.resolve(
            new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
          )
        }),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth',
            access: 'sk-ant-oat01-my-access-token',
            refresh: 'refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      const requestInit = {
        method: 'POST',
        headers: {
          'x-session-affinity': `session-abc-${kind}`,
          'x-opencode-session-id': `session-abc-${kind}`,
          'x-opencode-parent-session-id': 'parent-abc',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hello' }],
          system: 'system',
        }),
      }
      if (kind === 'request')
        await result.fetch(new Request(MESSAGES_URL, requestInit))
      else await result.fetch(MESSAGES_URL, requestInit)

      expect(capturedUrl).toBe('https://relay.example.test/')
      expect(capturedHeaders?.get('x-relay-token')).toBe('relay-token')
      const payload = JSON.parse(capturedBody!)
      expect(payload).toMatchObject({
        mode: 'full_sync',
        affinity: `session-abc-${kind}`,
        upstream: {
          url: 'https://api.anthropic.com/v1/messages?beta=true',
        },
      })
      expect(payload.upstream.headers['x-session-affinity']).toBeUndefined()
      expect(payload.upstream.headers['x-opencode-session']).toBeUndefined()
      expect(payload.upstream.headers['x-opencode-session-id']).toBeUndefined()
      expect(
        payload.upstream.headers['x-opencode-parent-session-id'],
      ).toBeUndefined()
      expect(payload.body.length).toBeGreaterThan(0)
    },
  )

  test('reloads relay config from sidecar after plugin startup', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-my-access-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })

    let capturedUrl: string | undefined
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
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
        capturedUrl = url
        return Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await updatePoolRelay({
      enabled: true,
      url: 'https://relay.example.test',
      token: 'relay-token',
      fallbackToDirect: true,
      transport: 'http',
    })

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-abc' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        system: 'system',
      }),
    })

    expect(capturedUrl).toBe('https://relay.example.test/')
  })

  test('sidebar relay transport reflects current sidecar storage', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: true,
          transport: 'http',
        },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )

    globalThis.fetch = mock(
      withNativeAdmission(() =>
        Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        ),
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await updatePoolRelay({ transport: 'websocket' })

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: new Uint8Array([123, 125]),
    })

    const state = await waitForSidebarState(
      (value) => value.relay?.transport === 'websocket',
    )
    expect(state.relay).toEqual({ enabled: true, transport: 'websocket' })
  })

  test('a relay saved without a transport sends over HTTP and the sidebar shows HTTP', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: true,
        },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    expect((await readAccountStorage())?.relay?.transport).toBeUndefined()

    const sent: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            }),
          )
        sent.push(url)
        return Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    // A failed WebSocket attempt falls back to the HTTP relay, so the fetch
    // alone cannot show which transport was chosen. Record every socket.
    const sockets: string[] = []
    const OriginalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = class {
      constructor(url: string | URL) {
        sockets.push(String(url))
        throw new Error('this test permits no WebSocket relay connection')
      }
    } as unknown as typeof WebSocket
    try {
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'session-relay-default' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hello' }],
          system: 'system',
        }),
      })
    } finally {
      globalThis.WebSocket = OriginalWebSocket
    }

    expect(sockets).toEqual([])
    expect(sent).toEqual(['https://relay.example.test/'])
    const state = await waitForSidebarState((value) => value.relay !== null)
    expect(state.relay).toEqual({ enabled: true, transport: 'http' })
  })

  test('a relay saved with a wss URL and no transport keeps using WebSocket', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          token: 'relay-token',
          fallbackToDirect: true,
          transport: 'http',
        },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    // Migration accepts only http(s) relay URLs, so switch to a WebSocket URL
    // here and then delete the stored transport field, simulating a
    // configuration file edited by hand.
    await updatePoolRelay({
      url: 'wss://relay.example.test',
      transport: 'websocket',
    })
    const pool = testContext.migratedPool
    if (!pool) throw new Error('This test has no migrated pool')
    await createNativePoolStore({
      paths: pool.paths,
      quota: nativeQuotaCodec,
    }).updateSettings((settings) => {
      const { transport: _omitted, ...relay } = settings.relay as Record<
        string,
        unknown
      >
      settings.relay = relay
    })
    expect((await readAccountStorage())?.relay).toMatchObject({
      url: 'wss://relay.example.test',
    })
    expect((await readAccountStorage())?.relay?.transport).toBeUndefined()

    globalThis.fetch = mock(
      withNativeAdmission((input: any, init?: RequestInit) => {
        if (extractUrl(input).includes('/api/oauth/usage'))
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            }),
          )
        if (typeof init?.body === 'string') {
          const payload = JSON.parse(init.body)
          expect(JSON.parse(payload.body ?? init.body).thread).toBeUndefined()
        }
        return Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    // Record the WebSocket connection the relay opens; refusing it lets the
    // request finish over the relay's HTTP fallback.
    const sockets: string[] = []
    const OriginalWebSocket = globalThis.WebSocket
    globalThis.WebSocket = class {
      constructor(url: string | URL) {
        sockets.push(String(url))
        throw new Error('this test refuses the WebSocket relay connection')
      }
    } as unknown as typeof WebSocket
    try {
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'session-relay-wss' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hello' }],
          system: 'system',
        }),
      })
    } finally {
      globalThis.WebSocket = OriginalWebSocket
    }

    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toStartWith('wss://relay.example.test/ws?')
    const state = await waitForSidebarState((value) => value.relay !== null)
    expect(state.relay).toEqual({ enabled: true, transport: 'websocket' })
  })

  test('sidebar shows no relay when the relay token is missing', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        relay: {
          enabled: true,
          url: 'https://relay.example.test',
          fallbackToDirect: true,
          transport: 'http',
        },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    expect((await readAccountStorage())?.relay).toMatchObject({
      enabled: true,
      url: 'https://relay.example.test',
    })

    const sent: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage'))
          return Promise.resolve(
            Response.json({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            }),
          )
        sent.push(url)
        return Promise.resolve(
          new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-my-access-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const requestedAt = Date.now()
    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-relay-no-token' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
        system: 'system',
      }),
    })

    // Without a token the request goes direct, so the sidebar must not
    // claim a relay.
    expect(
      sent.some((url) => url.startsWith('https://relay.example.test')),
    ).toBe(false)
    const state = await waitForSidebarState(
      (value) => value.lastUpdated >= requestedAt,
    )
    expect(state.relay).toBeNull()
  })
})

describe('message threads wire', () => {
  const originalFetch = globalThis.fetch
  const restores: Array<() => void> = []
  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const restore of restores.splice(0)) restore()
  })
  test.each(['direct', 'http'] as const)(
    'create then continue survives local refresh and sends only new messages over %s',
    async (transport) => {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          claudeCache: { enabled: true, mode: 'hybrid' },
          quota: {
            enabled: false,
            checkIntervalMinutes: 5,
            minimumRemaining: {},
            failClosedOnUnknownQuota: false,
          },
          relay: {
            enabled: transport === 'http',
            url: 'https://relay.example.test',
            token: 'relay-token',
            transport: 'http',
            fallbackToDirect: false,
          },
        }),
      )
      const tracked = spyOn(Core.CacheKeepManager.prototype, 'track')
      restores.push(() => tracked.mockRestore())
      const sent: Array<{ body: any; text: string; headers: Headers }> = []
      let rejection: string | undefined
      let relayBody = ''
      const applyPatch = new Function(
        Core.WORKER_SCRIPT.replace(
          /export default[\s\S]*$/,
          'return applyPatchSet',
        ),
      )() as (base: string, patch: unknown) => string
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          const url = extractUrl(_input as string | URL | Request)
          if (
            (!url.includes('/v1/messages') &&
              !url.startsWith('https://relay.example.test')) ||
            !init?.body
          )
            return Promise.resolve(
              Response.json({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
            )
          const wireText =
            init.body instanceof Uint8Array
              ? gunzipSync(init.body).toString().trim()
              : String(init.body)
          const envelope = JSON.parse(wireText)
          const text =
            envelope.mode === 'patch'
              ? applyPatch(relayBody, envelope.patch)
              : typeof envelope.body === 'string'
                ? envelope.body
                : wireText
          if (envelope.mode) relayBody = text

          sent.push({
            body: JSON.parse(text),
            text,
            headers: new Headers(envelope.upstream?.headers ?? init?.headers),
          })
          if (rejection) {
            const code = rejection
            rejection = undefined
            return Promise.resolve(
              Response.json(
                {
                  type: 'error',
                  error: {
                    type:
                      code === 'thread_not_found'
                        ? 'not_found_error'
                        : 'invalid_request_error',
                    details: { error_code: code },
                  },
                },
                {
                  status: code === 'thread_not_found' ? 404 : 400,
                  headers: { 'request-id': 'req_thread_error' },
                },
              ),
            )
          }
          return Promise.resolve(
            new Response(
              [
                `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_thread_${sent.length}","content":[{"type":"text","text":"Answer"}]}}\n\n`,
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
              ].join(''),
              {
                headers: {
                  'content-type': 'text/event-stream',
                  'request-id': `req_thread_${sent.length}`,
                },
              },
            ),
          )
        }),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      const auth = await plugin.auth.loader(
        () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
        { models: {} },
      )
      const send = async (
        messages: unknown[],
        session = 'ses_message_thread',
        auxiliary = false,
        subagent = false,
      ) => {
        const response = await auth.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: {
            'x-session-affinity': session,
            'x-cortexkit-request-class': auxiliary ? 'auxiliary' : 'main',
            'x-client-request-id': 'thread-client',
            ...(subagent ? { 'x-parent-session-id': 'parent-session' } : {}),
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 32,
            stream: true,
            system: 'Stable instructions',
            tools: [{ name: 'read', input_schema: { type: 'object' } }],
            messages,
          }),
        })
        await response.text()
      }
      const first = {
        role: 'user',
        content: 'Original question for suffix pinning.',
      }
      await send([first])
      await refreshPoolMainElsewhere(testContext, {
        access: 'sk-ant-oat01-refreshed-thread-access',
        refresh: 'refreshed-thread-refresh',
        expires: Date.now() + 3_600_000,
      })
      await send([
        first,
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'Next question' },
      ])
      expect(sent).toHaveLength(2)
      expect(sent[1]?.headers.get('authorization')).not.toBe(
        sent[0]?.headers.get('authorization'),
      )
      expect(sent[1]?.body.messages).toHaveLength(1)
      expect(sent[0]?.body.thread).toEqual({ type: 'create' })
      expect(sent[1]?.body.thread).toEqual({
        type: 'continue',
        previous_message_id: 'msg_thread_1',
      })
      expect(sent[1]?.body.messages).toHaveLength(1)
      expect(JSON.stringify(sent[1]?.body.messages)).toContain('Next question')
      expect(JSON.stringify(sent[1]?.body.messages)).not.toContain(
        'Original question',
      )
      expect(sent[1]?.body.tools).toEqual(sent[0]?.body.tools)
      expect(sent[1]?.headers.get('anthropic-beta')).toBe(
        sent[0]?.headers.get('anthropic-beta'),
      )
      expect(sent[1]?.headers.get('anthropic-beta')?.split(',').at(-1)).toBe(
        Core.MESSAGE_THREADS_BETA,
      )
      const billing = sent.map(
        (request) => request.body.system[0].text.match(/cc_version=[^;]+/)?.[0],
      )
      expect(billing[1]).toBe(billing[0])
      expect(sent[1]?.text).toBe(
        await Core.signRequestBody(sent[1]?.text ?? ''),
      )
      expect(
        (sent[1]?.text.match(/"cache_control"/g) ?? []).length,
      ).toBeLessThanOrEqual(4)
      await plugin.event({
        event: {
          type: 'session.deleted',
          properties: { info: { id: 'ses_message_thread' } },
        },
      })
      await send([
        first,
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: 'After deletion' },
      ])
      expect(sent[2]?.body.thread).toEqual({ type: 'create' })
      const retained = tracked.mock.calls.at(-1)?.[0].bodyText
      expect(retained).toBeDefined()
      const full = JSON.parse(retained ?? '{}')
      expect(full.thread).toBeUndefined()
      expect(full.messages).toHaveLength(3)
      const warm = await Core.buildCacheKeepPrewarmBody(retained ?? '{}')
      expect(warm.ok).toBe(true)
      if (warm.ok) expect(JSON.parse(warm.bodyText).thread).toBeUndefined()
      for (const code of [
        'thread_not_found',
        'thread_fingerprint_mismatch',
        'thread_already_continued',
        'thread_continue_in_flight',
        'thread_unsupported_request',
        'unrelated',
      ]) {
        const session = `thread-error-${code}`
        await send([first], session)
        const history = [
          first,
          { role: 'assistant', content: 'Answer' },
          { role: 'user', content: `Following ${code}` },
        ]
        const before = sent.length
        rejection = code
        await send(history, session)
        expect(sent[before]?.body.thread.type, code).toBe('continue')
        expect(sent.length - before).toBe(code === 'unrelated' ? 1 : 2)
        if (code !== 'unrelated') {
          expect(sent[before + 1]?.body.thread).toEqual({ type: 'create' })
          expect(sent[before + 1]?.body.messages).toHaveLength(history.length)
          expect(sent[before + 1]?.headers.get('x-client-request-id')).toBe(
            sent[before]?.headers.get('x-client-request-id'),
          )
        }
        await send(history, session)
        expect(sent.at(-1)?.body.thread).toEqual({ type: 'create' })
      }
      await send([first], 'auxiliary-thread-exclusion', true)
      expect(sent.at(-1)?.body.thread).toBeUndefined()
      const sharedSession = 'subagent-shared-affinity'
      await send([first], sharedSession)
      const parentMessageId = `msg_thread_${sent.length}`
      await send([first], sharedSession, false, true)
      expect(sent.at(-1)?.body.thread).toBeUndefined()
      expect(sent.at(-1)?.headers.get('anthropic-beta')).not.toContain(
        Core.MESSAGE_THREADS_BETA,
      )
      await send(
        [
          first,
          { role: 'assistant', content: 'Answer' },
          { role: 'user', content: 'After subagent' },
        ],
        sharedSession,
      )
      expect(sent.at(-1)?.body.thread).toEqual({
        type: 'continue',
        previous_message_id: parentMessageId,
      })
      for (const change of ['replacement', 'account'] as const) {
        const session = `thread-${change}`
        await send([first], session)
        const credential = {
          access: `sk-ant-oat01-thread-${change}-access`,
          refresh: `thread-${change}-refresh`,
          expires: Date.now() + 3_600_000,
        }
        const accountIdentity = '22222222-3333-4444-8555-666666666666'
        if (change === 'account')
          testContext.poolLogins.push({
            ...credential,
            identity: accountIdentity,
          })
        await replacePoolMainLogin(testContext, credential, {
          sameAccount: change !== 'account',
          ...(change === 'account' ? { accountIdentity } : {}),
        })
        await send(
          [
            first,
            { role: 'assistant', content: 'Answer' },
            { role: 'user', content: 'After login replacement' },
          ],
          session,
        )
        expect(sent.at(-1)?.body.thread).toEqual({ type: 'create' })
      }
    },
  )
})

test('stateless OpenCode 1 HTTP relay handles an effort edit before a fixed-position billing cch', async () => {
  const body = (effort: string) =>
    JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 32,
      stream: true,
      system: 'Stable instructions',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Original prompt' }] },
        { role: 'system', content: [], output_config: { effort } },
        { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
      ],
    })
  const previous = await rewriteRequestBody(body('low'), {
    sessionId: 'stateless-relay-effort',
  })
  const next = await rewriteRequestBody(body('max'), {
    sessionId: 'stateless-relay-effort',
  })
  expect(JSON.parse(previous).thread).toBeUndefined()
  expect(JSON.parse(next).thread).toBeUndefined()
  expect(previous.indexOf('cch=')).toBe(next.indexOf('cch='))
  const applyPatchSet = new Function(
    Core.WORKER_SCRIPT.replace(
      /export default[\s\S]*$/,
      'return applyPatchSet',
    ),
  )() as (
    base: string,
    patch: ReturnType<typeof Core.createRelayPatch>,
  ) => unknown
  expect(
    applyPatchSet(previous, Core.createRelayPatch(previous, next)),
    `stateless cch offset ${previous.indexOf('cch=')}`,
  ).toBe(next)
})

describe('audit OC1 primary gates', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  test('audit primary gates: OC1 compaction requests remain stateless', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
      }),
    )
    let sent: Record<string, unknown> | undefined
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        if (typeof init?.body === 'string') sent = JSON.parse(init.body)
        return Promise.resolve(
          new Response(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const auth = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
      { models: {} },
    )
    const output = { headers: {} as Record<string, string> }
    await plugin['chat.headers'](
      {
        sessionID: 'compaction-session',
        agent: 'compaction',
        message: { id: 'summary-input' },
      },
      output,
    )
    const response = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        ...output.headers,
        'x-session-affinity': 'compaction-session',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        stream: true,
        messages: [{ role: 'user', content: 'Summarize the conversation' }],
      }),
    })
    await response.text()
    expect(sent).toBeDefined()
    expect(sent?.thread).toBeUndefined()
  })
})

describe('audit OC1 downstream refusal', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  test('audit downstream refusal: OC1 revokes an anchor after final tool validation', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false, mode: 'explicit' },
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
      }),
    )
    const sent: Array<Record<string, any>> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        if (typeof init?.body === 'string') sent.push(JSON.parse(init.body))
        if (sent.length > 1)
          return Promise.resolve(
            Response.json({
              id: 'msg_second',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-5',
              content: [],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          )
        const frame = (type: string, data: unknown) =>
          `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
        return Promise.resolve(
          new Response(
            frame('message_start', {
              type: 'message_start',
              message: { id: 'msg_refused', content: [] },
            }) +
              frame('content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: 'refused_call',
                  name: 'mcp_Search',
                  input: {},
                },
              }) +
              frame('content_block_stop', {
                type: 'content_block_stop',
                index: 0,
              }) +
              frame('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
              }) +
              frame('message_stop', { type: 'message_stop' }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const auth = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
      { models: {} },
    )
    const payload = {
      model: 'claude-sonnet-5',
      stream: false,
      tools: ['search', 'mcp_Search'].map((name) => ({
        name,
        input_schema: { type: 'object' },
      })),
      messages: [{ role: 'user', content: 'first' }],
    }
    const send = (body: unknown) =>
      auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'oc1-refused-reply' },
        body: JSON.stringify(body),
      })
    const response = await send(payload)
    await expect(response.text()).rejects.toThrow(
      'Response tool-name mapping could not be validated safely',
    )
    await (
      await send({
        ...payload,
        messages: [
          ...payload.messages,
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'refused_call',
                name: 'search',
                input: {},
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'refused_call',
                content: 'result',
              },
            ],
          },
        ],
      })
    ).text()
    expect(sent[1]?.thread).toEqual({ type: 'create' })
  })
})

describe('audit OC1 signing hot path', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  test('audit hot path: OC1 retains an unsigned full template and signs only the sent shape', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
        quota: {
          enabled: false,
          checkIntervalMinutes: 5,
          minimumRemaining: {},
          failClosedOnUnknownQuota: false,
        },
      }),
    )
    const track = spyOn(Core.CacheKeepManager.prototype, 'track')
    try {
      let wire = ''
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          if (typeof init?.body === 'string') wire = init.body
          return Promise.resolve(
            new Response(
              'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_hot","content":[]}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
            ),
          )
        }),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      const auth = await plugin.auth.loader(
        () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
        { models: {} },
      )
      await (
        await auth.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: { 'x-session-affinity': 'oc1-hot-path' },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            stream: true,
            messages: [{ role: 'user', content: 'Prepare one signed request' }],
          }),
        })
      ).text()
      const template =
        track.mock.calls.findLast(
          ([request]) => request.sessionId === 'oc1-hot-path',
        )?.[0].bodyText ?? ''
      expect(template).toContain('cch=00000;')
      expect(JSON.parse(template).thread).toBeUndefined()
      expect(JSON.parse(wire).thread).toEqual({ type: 'create' })
      expect(await Core.signRequestBody(wire)).toBe(wire)
    } finally {
      track.mockRestore()
    }
  })
})
