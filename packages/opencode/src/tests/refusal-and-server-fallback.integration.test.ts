import { describe, expect, mock, spyOn } from 'bun:test'
import {
  type AccountStorage,
  logger,
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
} from '@cortexkit/anthropic-auth-core'
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
})
