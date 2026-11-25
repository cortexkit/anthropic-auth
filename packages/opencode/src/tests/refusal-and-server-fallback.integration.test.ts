import { describe, expect, mock, spyOn } from 'bun:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import {
  type AccountStorage,
  CACHE_DIAGNOSTICS_BETA,
  cacheKeepStoreDirectory,
  hasValidRequestBodySignature,
  logger,
  MESSAGE_THREADS_BETA,
  RecoveryThinkingStore,
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
} from '@cortexkit/anthropic-auth-core'
import {
  RECOVERY_FAMILY,
  refusalThinkingReply,
  SOURCE_MODEL,
  TARGET_DIGEST,
  TARGET_SIGNATURE,
} from './fixtures/refusal-thinking'
import { getPluginTestHandles } from './plugin-test-handles'
import { createMockClient } from './support/opencode1-client.ts'
import {
  installLoaderSetup,
  setUserRefusalFallbackMode,
} from './support/opencode1-loader-setup.ts'
import {
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  getBodyLifetime,
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
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('normalizes a server fallback response without session affinity, ignoring the removed OpenCode 1 switch', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    await setUserRefusalFallbackMode(testContext, 'server')
    const previous = process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE = 'legacy'
    getBodyLifetime(testContext).deferCleanup(() => {
      if (previous === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
      else process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE = previous
    })
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 1,
          iterations: [
            {
              type: 'message',
              model: 'claude-fable-5',
              input_tokens: 1,
              output_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 1,
              output_tokens: 1,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')
    let sentBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (!extractUrl(input).includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          sentBody = JSON.parse(String(init?.body))
          return Promise.resolve(new Response(fallbackSse, { status: 200 }))
        },
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
    const info = spyOn(logger, 'info').mockImplementation(() => {})
    try {
      const response = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-fable-5',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      const responseText = await response.text()

      expect(sentBody?.fallbacks).toBe('default')
      expect(responseText).not.toContain('"type":"fallback","from"')
      expect(responseText).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
      const records = info.mock.calls.filter(
        ([channel]) => channel === 'server-fallback',
      )
      expect(records.map(([, , payload]) => payload)).toEqual([
        expect.objectContaining({
          session: null,
          servedModel: 'claude-opus-5',
        }),
      ])
    } finally {
      info.mockRestore()
    }
  })

  const assertServerFallbackTransitions = async (modelId: string) => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false } as AccountStorage['quota'],
      }),
    )
    await setUserRefusalFallbackMode(testContext, 'server')
    const requestBodies: Array<Record<string, unknown>> = []
    const requestBetas: string[] = []
    let modelRequest = 0
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const fallbackSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_fallback', model: 'claude-opus-5' },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: modelId },
          to: { model: 'claude-opus-5' },
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'fallback answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 2,
          iterations: [
            {
              type: 'message',
              model: modelId,
              input_tokens: 100,
              output_tokens: 0,
            },
            {
              type: 'fallback_message',
              model: 'claude-opus-5',
              input_tokens: 100,
              output_tokens: 2,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')
    const restoredSse = [
      frame('message_start', {
        type: 'message_start',
        message: { id: 'msg_restored', model: modelId },
      }),
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'source answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 2,
          iterations: [
            {
              type: 'message',
              model: modelId,
              input_tokens: 100,
              output_tokens: 2,
            },
          ],
        },
      }),
      frame('message_stop', { type: 'message_stop' }),
    ].join('')

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          if (!extractUrl(input).includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          requestBodies.push(JSON.parse(String(init?.body)))
          requestBetas.push(
            new Headers(init?.headers).get('anthropic-beta') ?? '',
          )
          modelRequest++
          return Promise.resolve(
            new Response(modelRequest === 1 ? fallbackSse : restoredSse, {
              status: 200,
            }),
          )
        },
      ),
    ) as unknown as typeof fetch

    const mockClient = createMockClient([])
    const plugin = await getPlugin(mockClient)
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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_server_fallback' },
      body: JSON.stringify({
        model: modelId,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const info = spyOn(logger, 'info').mockImplementation(() => {})
    try {
      const fallbackResponse = await result.fetch(MESSAGES_URL, request)
      const fallbackResponseText = await fallbackResponse.text()
      expect(fallbackResponseText).toContain('fallback answer')
      expect(fallbackResponseText).not.toContain('"type":"fallback","from"')
      expect(fallbackResponseText).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
      expect(requestBodies).toHaveLength(1)
      expect(requestBodies[0]?.fallbacks).toBe('default')
      expect(requestBetas[0]?.split(',')).toContain(SERVER_SIDE_FALLBACK_BETA)

      const nextResponse = await result.fetch(MESSAGES_URL, request)
      await expect(nextResponse.text()).resolves.toContain('source answer')
      expect(requestBodies.map((body) => body.model)).toEqual([
        modelId,
        modelId,
      ])
      expect(requestBodies[1]?.fallbacks).toBe('default')
      expect(
        info.mock.calls.filter(([channel]) => channel === 'server-fallback'),
      ).toHaveLength(1)
      await plugin.event?.({
        event: {
          type: 'session.idle',
          properties: { sessionID: 'ses_server_fallback' },
        },
      })
      expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  }
  test.each(['claude-fable-5-1', 'claude-fable-5-2'])(
    'uses server-side fallback for %s without creating a recovery round or notice',
    assertServerFallbackTransitions,
  )

  test.each(['server', 'off', 'client'] as const)(
    '%s mode passes an unabsorbed refusal through without an OpenCode recovery round',
    async (mode) => {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          claudeCache: { enabled: false },
          cacheKeep: { enabled: false },
        }),
      )
      await setUserRefusalFallbackMode(testContext, mode)
      const bodies: Record<string, unknown>[] = []
      const models: string[] = []
      let firstFable = true
      const refusalSse = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('')
      const successSse = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join('')

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
          if (!url.includes('/v1/messages')) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          if (body.max_tokens === 0) {
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          bodies.push(body)
          models.push(String(body.model))
          if (body.model === 'claude-fable-5' && firstFable) {
            firstFable = false
            return Promise.resolve(new Response(refusalSse, { status: 200 }))
          }
          return Promise.resolve(new Response(successSse, { status: 200 }))
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
      const request = {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_wedge' },
        body: JSON.stringify({
          model: 'claude-fable-5',
          max_tokens: 128_000,
          stream: true,
          system: [{ type: 'text', text: 'stable system' }],
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }

      const filtered = await result.fetch(MESSAGES_URL, request)
      await expect(filtered.text()).resolves.toContain(
        '"stop_reason":"refusal"',
      )
      expect(models).toEqual(['claude-fable-5'])
      const second = await result.fetch(MESSAGES_URL, request)
      await second.text()
      expect(models).toEqual(['claude-fable-5', 'claude-fable-5'])
      expect(bodies.map((body) => body.fallbacks)).toEqual(
        mode === 'server' ? ['default', 'default'] : [undefined, undefined],
      )
    },
  )

  test('OpenCode 1 saves pending recovery thinking before plugin disposal returns', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    )
    await setUserRefusalFallbackMode(testContext, 'client')
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) =>
          extractUrl(input).includes('/v1/messages')
            ? refusalThinkingReply(JSON.parse(String(init?.body)).model)
            : Response.json({}),
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const host = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
      { models: {} },
    )
    const sessionID = 'ses_oc1_thinking_shutdown'
    const joined = await host.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': sessionID },
      body: JSON.stringify({
        model: SOURCE_MODEL,
        max_tokens: 256,
        stream: true,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    })
    expect(await joined.text()).toContain(TARGET_SIGNATURE)
    await plugin.dispose()
    testContext.livePlugins.delete(plugin)

    const restarted = new RecoveryThinkingStore()
    await restarted.loadSession(sessionID)
    expect(restarted.peek(sessionID, RECOVERY_FAMILY)?.has(TARGET_DIGEST)).toBe(
      true,
    )
  })

  test('client retry 429 ends the host stream with the original refusal after two sends', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    )
    await setUserRefusalFallbackMode(testContext, 'client')
    const credit = 'credit_only_for_this_retry_987'
    const sends: Array<{ body: string; headers: Headers }> = []
    const refusal = [
      {
        type: 'message_start',
        message: {
          id: 'msg_source',
          model: 'claude-fable-5-2',
          usage: { input_tokens: 12 },
        },
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'refusal',
          stop_details: {
            type: 'refusal',
            category: 'cyber',
            fallback_credit_token: credit,
          },
        },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join('')
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage'))
            return Response.json({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            })
          if (!url.includes('/v1/messages')) return Response.json({})
          const body = String(init?.body)
          if (JSON.parse(body).max_tokens === 0) return Response.json({})
          sends.push({ body, headers: new Headers(init?.headers) })
          return sends.length === 1
            ? new Response(refusal, {
                headers: {
                  'content-type': 'text/event-stream',
                  'anthropic-ratelimit-unified-5h-utilization': '0',
                  'anthropic-ratelimit-unified-7d-utilization': '0',
                },
              })
            : Response.json(
                {
                  type: 'error',
                  error: {
                    type: 'rate_limit_error',
                    message: `Rejected ${credit}`,
                  },
                },
                { status: 429 },
              )
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const host = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
      { models: {} },
    )
    const response: Response = await host.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_client_retry_429' },
      body: JSON.stringify({
        model: 'claude-fable-5-2',
        max_tokens: 128_000,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text.match(/"stop_reason":"refusal"/g)).toHaveLength(1)
    expect(text.match(/"type":"message_stop"/g)).toHaveLength(1)
    expect(text).not.toContain('event: error')
    expect(text).not.toContain(credit)
    expect(sends).toHaveLength(2)
    const [source, retry] = sends
    expect(JSON.parse(source!.body)).not.toHaveProperty('fallback_credit_token')
    expect(JSON.parse(retry!.body)).toMatchObject({
      model: 'claude-opus-4-8',
      fallback_credit_token: credit,
    })
    expect(await hasValidRequestBodySignature(retry!.body)).toBe(true)
    const sourceHeaders = new Headers(source!.headers)
    sourceHeaders.delete('authorization')
    const retryHeaders = new Headers(retry!.headers)
    retryHeaders.delete('authorization')
    expect([...retryHeaders]).toEqual([...sourceHeaders])
  })

  test('a newer primary makes the older refusal stand without a retry', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
    await setUserRefusalFallbackMode(testContext, 'client')
    const older =
      Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const encoder = new TextEncoder()
    const frame = (type: string, fields = {}) =>
      encoder.encode(`data: ${JSON.stringify({ type, ...fields })}\n\n`)
    const sends: string[] = []
    const headers = {
      'content-type': 'text/event-stream',
      'anthropic-ratelimit-unified-5h-utilization': '0',
      'anthropic-ratelimit-unified-7d-utilization': '0',
    }
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/api/oauth/usage'))
            return Response.json({
              five_hour: { utilization: 0 },
              seven_day: { utilization: 0 },
            })
          if (!url.includes('/v1/messages')) return Response.json({})
          const { model, max_tokens } = JSON.parse(String(init?.body))
          if (max_tokens === 0) return Response.json({})
          sends.push(model)
          const deferred = sends.length === 1
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  frame('message_start', {
                    message: {
                      id: deferred ? 'msg_older' : 'msg_newer',
                      model,
                      usage: { input_tokens: 3 },
                    },
                  }),
                )
                if (deferred) older.resolve(controller)
                else {
                  controller.enqueue(
                    frame('message_delta', {
                      delta: { stop_reason: 'end_turn' },
                    }),
                  )
                  controller.enqueue(frame('message_stop'))
                  controller.close()
                }
              },
            }),
            { headers },
          )
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const host = await plugin.auth.loader(
      () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
      { models: {} },
    )
    const send = (text: string): Promise<Response> =>
      host.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_client_stale' },
        body: JSON.stringify({
          model: 'claude-fable-5-2',
          max_tokens: 100,
          stream: true,
          messages: [{ role: 'user', content: text }],
        }),
      })
    const previous = await send('older')
    const controller = await older.promise
    let newer: string
    try {
      newer = await (await send('newer')).text()
    } finally {
      controller.enqueue(
        frame('message_delta', {
          delta: {
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'cyber',
              fallback_credit_token: 'older_refusal_credit_951',
            },
          },
        }),
      )
      controller.enqueue(frame('message_stop'))
      controller.close()
    }
    expect(newer).toContain('"stop_reason":"end_turn"')
    expect(await previous.text()).toContain('"stop_reason":"refusal"')
    expect(sends).toEqual(['claude-fable-5-2', 'claude-fable-5-2'])
  })

  const exerciseRoundWarm = async (
    restart: 'valid' | 'unsupported' | false,
  ) => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
        dump: { enabled: true },
      }),
    )
    const dumpDir = join(testContext.tempConfigDir!, 'round-dumps')
    const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    getBodyLifetime(testContext).deferCleanup(() => {
      if (previousDumpDir === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
    })
    const source = 'claude-fable-5-2'
    const target = 'claude-opus-5'
    const credit = 'round-test-credit-never-replayed'
    const sends: Array<{
      text: string
      body: Record<string, unknown>
      headers: Headers
    }> = []
    let now = Date.now()
    let refuse = false
    let rejectTarget = false
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (!url.includes('/v1/messages')) return Response.json({})
          const text = String(init?.body)
          const body = JSON.parse(text)
          sends.push({ text, body, headers: new Headers(init?.headers) })
          const usage = { input_tokens: 12, cache_read_input_tokens: 300 }
          if (body.max_tokens === 0)
            return Response.json({
              id: 'msg_warm',
              model: body.model,
              usage,
              content: [],
              stop_reason: 'end_turn',
            })
          if (body.model === target && rejectTarget)
            return Response.json(
              { error: { message: 'rejected target' } },
              { status: 400 },
            )
          const refused = body.model === source && refuse
          if (refused) refuse = false
          const events = [
            {
              type: 'message_start',
              message: { id: `msg_${sends.length}`, model: body.model, usage },
            },
            ...(!refused
              ? [
                  {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: 'answer' },
                  },
                  { type: 'content_block_stop', index: 0 },
                ]
              : []),
            {
              type: 'message_delta',
              delta: refused
                ? {
                    stop_reason: 'refusal',
                    stop_details: {
                      type: 'refusal',
                      category: 'bio',
                      fallback_credit_token: credit,
                    },
                  }
                : { stop_reason: 'end_turn' },
              usage: { output_tokens: 2 },
            },
            { type: 'message_stop' },
          ]
          return new Response(
            events
              .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
              .join(''),
            {
              headers: {
                'content-type': 'text/event-stream',
                'anthropic-ratelimit-unified-5h-utilization': '0',
                'anthropic-ratelimit-unified-7d-utilization': '0',
              },
            },
          )
        },
      ),
    ) as unknown as typeof fetch
    const plugin = await getPlugin(undefined, undefined, { now: () => now })
    const independent = await getPlugin()
    const auth = () =>
      Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() })
    const host = await plugin.auth.loader(auth, { models: {} })
    const other = await independent.auth.loader(auth, { models: {} })
    const sessionId = 'ses_round_source_warm'
    const first = [{ role: 'user', content: 'the clean cached prefix' }]
    const append = (history: typeof first, content: string) => [
      ...history,
      { role: 'assistant', content: 'answer' },
      { role: 'user', content },
    ]
    const request = async (which: typeof host, messages: typeof first) =>
      (
        await which.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: { 'x-session-affinity': sessionId },
          body: JSON.stringify({
            model: source,
            stream: true,
            max_tokens: 256,
            messages,
          }),
        })
      ).text() as Promise<string>
    await request(host, first)
    const second = append(first, 'the refused turn, not kept')
    refuse = true
    expect(await request(host, second)).not.toContain('"stop_reason":"refusal"')
    expect(sends.slice(0, 3).map(({ body }) => body.model)).toEqual([
      source,
      source,
      target,
    ])
    const third = append(second, 'the next primary')
    await request(other, third)
    expect(sends.at(-1)?.body.model).toBe(source)
    await request(host, third)
    const round = sends.at(-1)!
    expect(round.body.model).toBe(target)
    expect(round.body.thread).toEqual({ type: 'create' })
    const stableHeaders = (headers: Headers) =>
      [...headers].filter(([name]) => name !== 'x-client-request-id')
    expect(stableHeaders(round.headers)).toEqual(
      stableHeaders(sends[1]!.headers),
    )
    expect(round.text).not.toContain(credit)

    const keeper = getPluginTestHandles(plugin).cacheKeepManager
    await Promise.resolve()
    const warmId = `source-warm:${sessionId}:fable-5-2`
    const kept = keeper.trackedRequest(warmId)
    expect(kept?.bodyText).toContain('the clean cached prefix')
    expect(kept?.bodyText).not.toContain('the refused turn')
    now += 55 * 60_000
    await keeper.tick()
    const warm = sends.find(
      ({ body }) => body.max_tokens === 0 && body.model === source,
    )
    expect(warm?.body).toMatchObject({ max_tokens: 0 })
    expect(warm?.body).not.toHaveProperty('thread')
    expect(warm?.body).not.toHaveProperty('fallbacks')
    expect(warm?.text).not.toContain(credit)

    if (restart) {
      const modelBetas = (headers: Headers) =>
        headers
          .get('anthropic-beta')!
          .split(',')
          .filter((beta) => beta !== MESSAGE_THREADS_BETA)
      const liveWarm = sends.find(
        ({ body }) => body.max_tokens === 0 && body.model === target,
      )
      expect(modelBetas(liveWarm!.headers)).toEqual(
        modelBetas(round.headers).filter(
          (beta) => beta !== CACHE_DIAGNOSTICS_BETA,
        ),
      )
      await plugin.dispose()
      testContext.livePlugins.delete(plugin)
      await independent.dispose()
      testContext.livePlugins.delete(independent)
      const disk = cacheKeepStoreDirectory(
        process.env.OPENCODE_ANTHROPIC_AUTH_FILE!,
        undefined,
        'opencode1',
      )
      const entries = (await readdir(disk)).filter((name) =>
        name.endsWith('.json.gz'),
      )
      expect(entries).toHaveLength(1)
      const path = join(disk, entries[0]!)
      const saved = JSON.parse(gunzipSync(await readFile(path)).toString())
      if (restart === 'unsupported') {
        await writeFile(
          path,
          gzipSync(
            JSON.stringify({
              ...saved,
              refusalSourceModel: 'claude-sonnet-4-6',
            }),
          ),
        )
      }
      const debug = spyOn(logger, 'debug')
      getBodyLifetime(testContext).deferCleanup(() => debug.mockRestore())
      const restarted = await getPlugin(undefined, undefined, {
        now: () => now,
      })
      await restarted.auth.loader(auth, { models: {} })
      const handles = getPluginTestHandles(restarted)
      await handles.drainDispatchWork()
      now = saved.nextPrewarmAt + 1
      const before = sends.length
      await handles.cacheKeepManager.tick()
      const restored = sends.slice(before)
      if (restart === 'unsupported') {
        expect(restored).toBeEmpty()
        expect(await readdir(disk)).not.toContain(entries[0]!)
        expect(
          debug.mock.calls.filter(
            ([, message]) => message === 'restart record dropped',
          ),
        ).toEqual([
          [
            'cachekeep',
            'restart record dropped',
            { file: entries[0], reason: 'invalid' },
          ],
        ])
        return
      }
      expect(restored).toHaveLength(1)
      expect(restored[0]!.body).toMatchObject({ model: target, max_tokens: 0 })
      expect(modelBetas(restored[0]!.headers)).toEqual(
        modelBetas(liveWarm!.headers),
      )
      expect(await hasValidRequestBodySignature(restored[0]!.text)).toBe(true)
      expect(saved.refusalSourceModel).toBe(source)
      expect(saved).not.toHaveProperty('headers')
      return
    }

    rejectTarget = true
    const before400 = sends.length
    expect(
      await request(host, append(third, 'upstream rejects the round target')),
    ).toContain('answer')
    expect(sends.slice(before400).map(({ body }) => body.model)).toEqual([
      target,
      source,
    ])
    expect(sends.at(-1)?.body).not.toHaveProperty('thread')
    expect(keeper.trackedRequest(warmId)).toBeUndefined()
    await request(host, append(third, 'source after the round'))
    expect(sends.at(-1)?.body).toMatchObject({
      model: source,
      thread: { type: 'create' },
    })
    const dumpBodies = await Promise.all(
      (await readdir(dumpDir))
        .filter((name) => name.endsWith('.body.json'))
        .map((name) => readFile(join(dumpDir, name), 'utf8')),
    )
    expect(dumpBodies).toContain(round.text)
    expect(dumpBodies.join('\n')).not.toContain(credit)
    for (const { text } of sends)
      expect(await hasValidRequestBodySignature(text)).toBe(true)
  }

  test('OpenCode 1 warms the last clean source and serves a signed round only in its own plugin instance', () =>
    exerciseRoundWarm(false))
  test('OpenCode 1 restart replays the live refusal-round warm headers', () =>
    exerciseRoundWarm('valid'))
  test('OpenCode 1 restart drops an unsupported refusal source without sending it', () =>
    exerciseRoundWarm('unsupported'))
})
