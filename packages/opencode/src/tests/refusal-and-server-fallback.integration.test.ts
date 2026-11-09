import { describe, expect, mock } from 'bun:test'
import {
  type AccountStorage,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import {
  drainNotifications,
  resetNotificationsForTest,
} from '../rpc/notifications'
import {
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
} from '../server-fallback'
import type { getSidebarState } from '../sidebar-state'
import { getPluginTestHandles } from './plugin-test-handles'
import { createMockClient } from './support/opencode1-client.ts'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  waitForMockCall,
  waitForSidebarState as waitForSidebarStateWithCtx,
} from './support/opencode1-state-observers.ts'
import type { PluginRuntimeOverrides } from './support/opencode1-test-context.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
  recordedCondition as recordedConditionWithCtx,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function recordedCondition() {
  return recordedConditionWithCtx(testContext)
}
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
function waitForSidebarState(
  predicate: (state: Awaited<ReturnType<typeof getSidebarState>>) => boolean,
) {
  return waitForSidebarStateWithCtx(testContext, predicate)
}

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('normalizes a server fallback response even when no session-affinity header is available', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(createFallbackStorage({ accounts: [] }))
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
  })

  const assertServerFallbackTransitions = async (modelId: string) => {
    const label = modelId === 'claude-fable-5-2' ? 'Fable 5.2' : 'Fable 5.1'
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false } as AccountStorage['quota'],
      }),
    )
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

    const latestUserMessageId = 'msg_000000000100AAAAAAAAAAAAAA'
    const latestAssistantMessageId = 'msg_000000000200BBBBBBBBBBBBBB'
    const mockClient = createMockClient([
      {
        info: {
          id: latestUserMessageId,
          role: 'user',
          agent: 'Alfonso - CTO',
          model: {
            providerID: 'anthropic',
            modelID: modelId,
            variant: 'xhigh',
          },
        },
      },
      {
        info: {
          id: latestAssistantMessageId,
          role: 'assistant',
          agent: 'Alfonso - CTO',
          providerID: 'anthropic',
          modelID: modelId,
          variant: 'xhigh',
        },
      },
    ])
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

    const fallbackResponse = await result.fetch(MESSAGES_URL, request)
    const fallbackResponseText = await fallbackResponse.text()
    expect(fallbackResponseText).toContain('fallback answer')
    expect(fallbackResponseText).not.toContain('"type":"fallback","from"')
    expect(fallbackResponseText).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]?.fallbacks).toBe('default')
    expect(requestBetas[0]?.split(',')).toContain(SERVER_SIDE_FALLBACK_BETA)
    const switched = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_server_fallback' &&
            recovery.mode === 'server',
        ),
      ),
    )
    expect(switched.fableRecoveries?.[0]).toMatchObject({
      requestedModelId: modelId,
      targetModelId: 'claude-opus-5',
      remaining: 0,
    })
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            finish: 'tool-calls',
            time: { completed: Date.now() },
          },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            finish: 'stop',
            time: { completed: Date.now() },
          },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_server_fallback',
          status: { type: 'idle' },
        },
      },
    })
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback' },
      },
    })
    await waitForMockCall(mockClient.session.promptAsync)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_server_fallback' },
        body: expect.objectContaining({
          noReply: true,
          parts: [
            expect.objectContaining({
              text: expect.stringContaining(
                `Anthropic safety fallback active: ${label} → Opus 5`,
              ),
            }),
          ],
        }),
      }),
    )

    // Model the real host: the first ignored notice becomes the newest user
    // message. A second notice must have a distinct ordered ID, registered
    // before promptAsync emits its user-message event.
    const firstNotice = mockClient.session.promptAsync.mock.calls[0]?.[0] as {
      body: { messageID: string }
    }
    const originalMessages = await mockClient.session.messages!()
    mockClient.session.messages = mock(async () => ({
      data: [
        ...originalMessages.data,
        { info: { id: firstNotice.body.messageID, role: 'user' } },
      ],
    }))
    const noticeWasTrackedAtDispatch: boolean[] = []
    mockClient.session.promptAsync.mockImplementation(
      async (input: unknown) => {
        const notice = input as {
          path: { id: string }
          body: { messageID: string }
        }
        noticeWasTrackedAtDispatch.push(
          typeof notice.body.messageID === 'string' &&
            getPluginTestHandles(plugin).isDesktopNoticeMessage(
              notice.path.id,
              notice.body.messageID,
            ),
        )
        await plugin.event?.({
          event: {
            type: 'message.updated',
            properties: {
              info: {
                id: notice.body.messageID,
                sessionID: notice.path.id,
                role: 'user',
              },
            },
          },
        })
      },
    )

    const restoredResponse = await result.fetch(MESSAGES_URL, request)
    // OpenCode can publish the assistant-completed event before the wrapped
    // response emits its final fallback outcome. The idle event must flush a notice
    // queued after that completion event without requiring a later session update.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestAssistantMessageId,
            sessionID: 'ses_server_fallback',
            role: 'assistant',
            time: { completed: Date.now() },
          },
        },
      },
    })
    await expect(restoredResponse.text()).resolves.toContain('source answer')
    const restored = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_server_fallback' &&
            recovery.mode === 'fable',
        ),
      ),
    )
    expect(restored.fableRecoveries?.[0]?.requestedModelId).toBe(modelId)
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback' },
      },
    })
    await waitForMockCall({
      mock: {
        get calls() {
          return mockClient.session.promptAsync.mock.calls.slice(1)
        },
      },
    })
    expect(mockClient.session.promptAsync.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: expect.stringContaining(`Returning to ${label}`),
            }),
          ],
        }),
      }),
    )

    const secondNotice = mockClient.session.promptAsync.mock.calls[1]?.[0] as {
      body: { messageID: string }
    }
    expect(noticeWasTrackedAtDispatch).toEqual([true])
    expect(secondNotice.body.messageID > firstNotice.body.messageID).toBe(true)
    expect(secondNotice.body.messageID < latestAssistantMessageId).toBe(true)

    // The host history still contains only notice 1. Notice 2's own event must
    // leave the idle lease intact, and local allocation must avoid reusing its
    // ID even before session.messages catches up. No new idle event is sent.
    modelRequest = 0
    const thirdTransition = await result.fetch(MESSAGES_URL, request)
    await thirdTransition.text()
    await waitForMockCall({
      mock: {
        get calls() {
          return mockClient.session.promptAsync.mock.calls.slice(2)
        },
      },
    })
    const thirdNotice = mockClient.session.promptAsync.mock.calls[2]?.[0] as {
      body: { messageID: string }
    }
    expect(thirdNotice.body.messageID > secondNotice.body.messageID).toBe(true)
    expect(thirdNotice.body.messageID < latestAssistantMessageId).toBe(true)
    expect(noticeWasTrackedAtDispatch).toEqual([true, true])

    // A rapid fallback cycle can replace the pending switch notice while its
    // asynchronous prompt-context lookup is still in flight. The stale send
    // must stand down and the active flush must continue with the replacement.
    mockClient.session.promptAsync.mockClear()
    modelRequest = 0
    const immediateMessages = mockClient.session.messages
    let releasePromptContext: (() => void) | undefined
    let messageLookups = 0
    mockClient.session.messages = mock(() => {
      messageLookups++
      if (messageLookups > 1) {
        return immediateMessages?.() ?? Promise.resolve({ data: [] })
      }
      return new Promise<{ data: unknown[] }>((resolve) => {
        releasePromptContext = () => {
          void Promise.resolve(immediateMessages?.()).then((response) =>
            resolve(response ?? { data: [] }),
          )
        }
      })
    })
    const overtakenRequest = {
      ...request,
      headers: { 'x-session-affinity': 'ses_server_fallback_overtaken' },
    }
    const overtakenFallback = await result.fetch(MESSAGES_URL, overtakenRequest)
    await overtakenFallback.text()
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestUserMessageId,
            sessionID: 'ses_server_fallback_overtaken',
            role: 'user',
          },
        },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_server_fallback_overtaken' },
      },
    })
    for (let attempt = 0; attempt < 100 && !releasePromptContext; attempt++) {
      await Bun.sleep(1)
    }
    expect(releasePromptContext).toBeDefined()

    const overtakenRestoration = await result.fetch(
      MESSAGES_URL,
      overtakenRequest,
    )
    await overtakenRestoration.text()
    releasePromptContext?.()
    await waitForMockCall(mockClient.session.promptAsync)

    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          parts: [
            expect.objectContaining({
              text: expect.stringContaining(`Returning to ${label}`),
            }),
          ],
        }),
      }),
    )
    // Missing ordering context must retain the notice, never send a host-minted
    // user ID. Once the host exposes a safe boundary, the same notice can drain.
    mockClient.session.promptAsync.mockClear()
    mockClient.session.messages = mock(async () => ({ data: [] }))
    modelRequest = 0
    const unplaced = await result.fetch(MESSAGES_URL, {
      ...request,
      headers: { 'x-session-affinity': 'ses_notice_unplaced' },
    })
    await unplaced.text()
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_notice_unplaced' },
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(mockClient.session.messages).toHaveBeenCalled()
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_notice_unplaced' },
      },
    })
    await waitForMockCall(mockClient.session.promptAsync)
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
  }
  test.each(['claude-fable-5-1', 'claude-fable-5-2'])(
    'uses Anthropic server-side fallback for %s and reports transitions',
    assertServerFallbackTransitions,
  )

  test('downgrades a filtered Fable session for ten completed Opus responses without source warms', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: false },
      }),
    )
    const normalModels: string[] = []
    let firstFable = true
    const recorded = recordedCondition()
    const successfulSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const refusalSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_filtered"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
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
                limits: [],
              }),
              { status: 200 },
            ),
          )
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(body.max_tokens).not.toBe(0)
        normalModels.push(String(body.model))
        recorded.changed()
        if (body.model === 'claude-fable-5' && firstFable) {
          firstFable = false
          return Promise.resolve(new Response(refusalSse, { status: 200 }))
        }
        return Promise.resolve(new Response(successfulSse, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const latestUserMessageId = 'msg_000000000100AAAAAAAAAAAAAA'
    const latestAssistantMessageId = 'msg_000000000200BBBBBBBBBBBBBB'
    let releaseStaleIdleStatus:
      | ((statuses: Record<string, { type: string }>) => void)
      | undefined
    let noticeStatusChecks = 0
    const mockClient = createMockClient(
      [
        {
          info: {
            id: latestUserMessageId,
            role: 'user',
            agent: 'Alfonso - CTO',
            model: {
              providerID: 'anthropic',
              modelID: 'claude-fable-5',
              variant: 'xhigh',
            },
          },
        },
        {
          info: {
            id: latestAssistantMessageId,
            role: 'assistant',
            agent: 'Alfonso - CTO',
            providerID: 'anthropic',
            modelID: 'claude-fable-5',
            variant: 'xhigh',
          },
        },
      ],
      () => {
        noticeStatusChecks++
        if (noticeStatusChecks === 1) {
          return new Promise<Record<string, { type: string }>>((resolve) => {
            releaseStaleIdleStatus = resolve
            recorded.changed()
          })
        }
        return {}
      },
    )
    // Record each notice the plugin sends so the test can wait for it.
    mockClient.session.promptAsync = mock((_input: unknown) => {
      queueMicrotask(recorded.changed)
      return Promise.resolve()
    })
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
      headers: { 'x-session-affinity': 'ses_fable_filter' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'same session input' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    const reader = filtered.body!.getReader()
    let caught: unknown
    try {
      while (!(await reader.read()).done) {}
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).toBe('ECONNRESET')
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    const switchedState = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_fable_filter' &&
            recovery.mode === 'opus',
        ),
      ),
    )
    expect(
      switchedState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.remaining,
    ).toBe(10)

    // The switch notice is deliberately held until the first successful Opus
    // response proves that OpenCode's internal retry has completed.
    const firstOpus = await result.fetch(MESSAGES_URL, request)
    await firstOpus.text()

    // Seed the user-message identity that produced the upcoming idle event.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: latestUserMessageId,
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })

    // Reproduce the host race: an idle probe starts, then a new
    // prompt marks the session busy before the asynchronous status response
    // arrives with its now-stale idle snapshot. The notice must remain queued;
    // otherwise OpenCode can adopt that ignored user message as the active retry
    // parent and dispatch an extra provider request.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(() => releaseStaleIdleStatus !== undefined)
    expect(releaseStaleIdleStatus).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_fable_filter',
          status: { type: 'busy' },
        },
      },
    })
    releaseStaleIdleStatus?.({})
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()

    // Also cover the later race window: status was idle, but a new prompt starts
    // while the notification path is resolving message history for placement.
    const immediateMessages = mockClient.session.messages
    let releasePromptContext: (() => void) | undefined
    mockClient.session.messages = mock(
      () =>
        new Promise<{ data: unknown[] }>((resolve) => {
          releasePromptContext = () => {
            void Promise.resolve(immediateMessages?.()).then((response) =>
              resolve(response ?? { data: [] }),
            )
          }
          recorded.changed()
        }),
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(() => releasePromptContext !== undefined)
    expect(releasePromptContext).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_fable_filter',
          status: { type: 'busy' },
        },
      },
    })
    releasePromptContext?.()
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages

    // OpenCode can publish the new user message before its busy status update.
    // That earlier event must also revoke the idle-delivery lease.
    let releaseUserMessagePromptContext: (() => void) | undefined
    mockClient.session.messages = mock(
      () =>
        new Promise<{ data: unknown[] }>((resolve) => {
          releaseUserMessagePromptContext = () => {
            void Promise.resolve(immediateMessages?.()).then((response) =>
              resolve(response ?? { data: [] }),
            )
          }
          recorded.changed()
        }),
    )
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(() => releaseUserMessagePromptContext !== undefined)
    expect(releaseUserMessagePromptContext).toBeDefined()
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_new_user',
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    releaseUserMessagePromptContext?.()
    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    mockClient.session.messages = immediateMessages

    // A later authoritative idle signal retries the still-queued notice.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_new_user',
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.updated',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await recorded.until(
      () => mockClient.session.promptAsync.mock.calls.length > 0,
    )
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(1)
    expect(mockClient.session.promptAsync.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_fable_filter' },
        body: expect.objectContaining({
          messageID: expect.any(String),
          noReply: true,
          agent: 'Alfonso - CTO',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5',
          },
          variant: 'xhigh',
          parts: [
            expect.objectContaining({
              type: 'text',
              ignored: true,
              text: expect.stringContaining('Switched to Opus 4.8'),
            }),
          ],
        }),
      }),
    )
    const switchNotificationRequest = mockClient.session.promptAsync.mock
      .calls[0]?.[0] as { body: { messageID?: string } } | undefined
    const switchNotificationMessageId =
      switchNotificationRequest?.body.messageID
    expect(switchNotificationMessageId! > latestUserMessageId).toBe(true)
    expect(switchNotificationMessageId! < latestAssistantMessageId).toBe(true)
    expect(normalModels).toHaveLength(2)

    for (let turn = 1; turn < 10; turn++) {
      const response = await result.fetch(MESSAGES_URL, request)
      await response.text()
    }

    expect(normalModels).toEqual([
      'claude-fable-5',
      ...Array.from({ length: 10 }, () => 'claude-opus-4-8'),
    ])
    const restoredState = await waitForSidebarState((state) =>
      Boolean(
        state.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_fable_filter' &&
            recovery.mode === 'fable' &&
            recovery.remaining === 0,
        ),
      ),
    )
    expect(
      restoredState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.mode,
    ).toBe('fable')

    // Queue the return-to-Fable notice at the tenth completed Opus response.
    // Delivery must not depend on a source-cache prewarm request.
    await plugin.event?.({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    await plugin.event?.({
      event: {
        type: 'session.updated',
        properties: { sessionID: 'ses_fable_filter' },
      },
    })
    // The ignored switch notice is itself stored as a user message. Its event
    // must not revoke the real user's idle-delivery lease for a newer notice.
    await plugin.event?.({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: switchNotificationMessageId,
            sessionID: 'ses_fable_filter',
            role: 'user',
          },
        },
      },
    })
    const restored = await result.fetch(MESSAGES_URL, request)
    await restored.text()
    expect(normalModels.at(-1)).toBe('claude-fable-5')

    await recorded.until(
      () => mockClient.session.promptAsync.mock.calls.length > 1,
    )
    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(2)
    expect(mockClient.session.promptAsync.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        path: { id: 'ses_fable_filter' },
        body: expect.objectContaining({
          messageID: expect.any(String),
          noReply: true,
          parts: [
            expect.objectContaining({
              type: 'text',
              ignored: true,
              text: expect.stringContaining('Returning to Fable 5'),
            }),
          ],
        }),
      }),
    )
    expect(normalModels).toHaveLength(12)
    expect(
      restoredState.fableRecoveries?.find(
        (recovery) => recovery.sessionId === 'ses_fable_filter',
      )?.remaining,
    ).toBe(0)
  })

  test('server mode — refusal with no server-side handoff downgrades to Opus (wedge regression)', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
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

    // First request hits the refusal — onContentFilter fires, stream rejects.
    // The second request must carry the downgraded Opus model.
    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const second = await result.fetch(MESSAGES_URL, request)
    await second.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
  })

  test('server mode — absorbed server-side fallback does NOT activate client-side downgrade', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
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
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'safe answer' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }),
      frame('message_stop', { type: 'message_stop' }),
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
        models.push(String(body.model))
        return Promise.resolve(new Response(fallbackSse, { status: 200 }))
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
      headers: { 'x-session-affinity': 'ses_no_double' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const first = await result.fetch(MESSAGES_URL, request)
    await first.text()
    const second = await result.fetch(MESSAGES_URL, request)
    await second.text()

    // Both requests stayed on Fable — no client-side downgrade triggered.
    expect(models).toEqual(['claude-fable-5', 'claude-fable-5'])
  })

  test('server mode — downgraded Opus request does not carry server-side fallback opt-in', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )
    const models: string[] = []
    const bodies: Array<Record<string, unknown>> = []
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
        models.push(String(body.model))
        bodies.push(body)
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
      headers: { 'x-session-affinity': 'ses_no_optin' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    // First request hits the refusal. onContentFilter fires
    // causing the stream to reject with a ContentFilterError.
    const filtered = await result.fetch(MESSAGES_URL, request)
    await expect(filtered.text()).rejects.toThrow()
    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()

    expect(models).toEqual(['claude-fable-5', 'claude-opus-4-8'])
    // The Opus request must NOT carry the server-side fallback opt-in.
    expect(bodies[1]?.fallbacks).toBeUndefined()
  })

  test('uses the sidebar instead of promptAsync when the matching TUI is connected', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
    )
    resetNotificationsForTest()
    drainNotifications(0, 'ses_tui_fable')
    const refusal =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        if (extractUrl(input).includes('/api/oauth/usage')) {
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
        return Promise.resolve(new Response(refusal, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const mockClient = createMockClient()
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
    const response = await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_tui_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    try {
      await response.text()
    } catch {}
    await plugin.event?.({
      event: {
        type: 'session.status',
        properties: {
          sessionID: 'ses_tui_fable',
          status: { type: 'idle' },
        },
      },
    })

    await Bun.sleep(10)
    expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
    const state = await waitForSidebarState((candidate) =>
      Boolean(
        candidate.fableRecoveries?.some(
          (recovery) =>
            recovery.sessionId === 'ses_tui_fable' &&
            recovery.mode === 'opus' &&
            recovery.remaining === 10,
        ),
      ),
    )
    expect(state.fableRecoveries).toHaveLength(1)
  })

  test('migrates recovery to an available OAuth account without warming the source', async () => {
    const now = Date.now()
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          claudeCache: { enabled: true, mode: 'hybrid' },
          cacheKeep: { enabled: false },
          quota: {
            enabled: true,
            checkIntervalMinutes: 5,
            minimumRemaining: { five_hour: 10, seven_day: 20 },
            failClosedOnUnknownQuota: true,
            mainQuota: {
              five_hour: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: now,
              },
              seven_day: {
                usedPercent: 0,
                remainingPercent: 100,
                checkedAt: now,
              },
              checkedAt: now,
              scoped: [
                {
                  id: 'claude-weekly-scoped-fable',
                  title: 'Fable only',
                  modelName: 'Fable',
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: now,
                },
              ],
            },
            mainQuotaCheckedAt: now,
            mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
          } as AccountStorage['quota'],
          accounts: [
            {
              id: 'fable-fallback',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: now + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                seven_day: {
                  usedPercent: 0,
                  remainingPercent: 100,
                  checkedAt: now,
                },
                scoped: [
                  {
                    id: 'claude-weekly-scoped-fable',
                    title: 'Fable only',
                    modelName: 'Fable',
                    usedPercent: 25,
                    remainingPercent: 75,
                    checkedAt: now,
                  },
                ],
              },
            },
          ],
        }),
      ),
    )
    const calls: Array<{ model: string; auth: string; warm: boolean }> = []
    let firstFable = true
    const success =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    const refusal =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
          const body = JSON.parse(String(init?.body)) as {
            model: string
            max_tokens?: number
          }
          const auth = new Headers(init?.headers).get('authorization') ?? ''
          calls.push({
            model: body.model,
            auth,
            warm: body.max_tokens === 0,
          })
          if (body.model === 'claude-fable-5' && firstFable) {
            firstFable = false
            return Promise.resolve(new Response(refusal, { status: 200 }))
          }
          return Promise.resolve(new Response(success, { status: 200 }))
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
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_account_bound_fable' },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 100,
        system: [{ type: 'text', text: 'stable system' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }

    const filtered = await result.fetch(MESSAGES_URL, request)
    const filteredReader = filtered.body!.getReader()
    try {
      while (!(await filteredReader.read()).done) {}
    } catch {}

    const opus = await result.fetch(MESSAGES_URL, request)
    await opus.text()

    expect(calls).toEqual([
      {
        model: 'claude-fable-5',
        auth: 'Bearer sk-ant-oat01-fallback-access',
        warm: false,
      },
      {
        model: 'claude-opus-4-8',
        auth: 'Bearer sk-ant-oat01-main-access',
        warm: false,
      },
    ])
  })
})
