import { afterEach, beforeEach, describe, expect, mock } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  type LogTestRecord,
  resetCache1hState,
  resetDumpState,
  setLogLevel,
  TRAILING_ASSISTANT_HISTORY_MESSAGE,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { EFFORT_MARKER_PREFIX } from '../effort-history'
import { LANE_START_REQUEST_HEADER, LANE_START_TEXT } from '../lane-start'
import { drainSidebarWrites, getSidebarState } from '../sidebar-state'
import {
  createMockClient,
  expectHandledCommandResponse,
} from './support/opencode1-client.ts'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  readAccountStorage as readAccountStorageWithCtx,
  restoreProcessTestFiles,
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
function getPlugin(
  client?: ReturnType<typeof createMockClient>,
  directory?: string,
  runtimeOverrides: PluginRuntimeOverrides = {},
): any {
  return getPluginWithCtx(testContext, client, directory, runtimeOverrides)
}
function readAccountStorage(): Promise<AccountStorage | null> {
  return readAccountStorageWithCtx(testContext)
}

describe('OpenCode 1 service_tier shaping', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test.each(['oauth', 'api fallback'] as const)(
    'service_tier follows the OpenCode 1 %s route',
    async (route) => {
      await useTempAccountFile(
        createFallbackStorage({
          fallbackOn: [429],
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
          accounts: [
            {
              id: 'service-tier-api',
              type: 'api',
              apiKey: 'synthetic-service-tier-key',
              baseURL: 'https://paid.invalid',
              authHeader: 'x-api-key',
            },
          ],
        }),
      )
      const sent: Array<{ headers: Headers; body: Record<string, unknown> }> =
        []
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: string | URL | Request, init?: RequestInit) => {
            const url = extractUrl(input)
            if (url.includes('/claude_cli/bootstrap'))
              return Promise.resolve(
                Response.json({
                  oauth_account: { account_uuid: 'service-tier-account' },
                }),
              )
            if (url.includes('/api/oauth/usage'))
              return Promise.resolve(
                Response.json({
                  five_hour: { utilization: 100 },
                  seven_day: { utilization: 50 },
                }),
              )
            if (url.includes('/v1/messages')) {
              const headers = new Headers(init?.headers)
              sent.push({ headers, body: JSON.parse(String(init?.body)) })
              return Promise.resolve(
                new Response('{}', {
                  status:
                    route === 'api fallback' && headers.has('authorization')
                      ? 429
                      : 200,
                }),
              )
            }
            throw new Error(`Unexpected service-tier fixture request: ${url}`)
          },
        ),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      try {
        const auth = await plugin.auth.loader(
          () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
          { models: {} },
        )
        const response = await auth.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            max_tokens: 64,
            service_tier: route === 'oauth' ? 'auto' : 'standard_only',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        })
        expect(response.status).toBe(200)
        expect(sent).toHaveLength(route === 'oauth' ? 1 : 2)
        expect(sent[0]?.headers.get('authorization')).toBe(
          'Bearer sk-ant-oat01-main-access',
        )
        expect(sent[0]?.body).not.toHaveProperty('service_tier')
        if (route === 'api fallback') {
          expect(sent[1]?.headers.get('x-api-key')).toBe(
            'synthetic-service-tier-key',
          )
          expect(sent[1]?.body.service_tier).toBe('standard_only')
        }
      } finally {
        await plugin.dispose?.()
      }
    },
  )
})

describe('Fable 5.1 request-scoped effort history', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    __setLogTestSink(null)
  })

  test('preserves effort boundaries when OpenCode lowers multiple assistant records into one message', async () => {
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
        thinkingBinding: { prefixMismatchBehavior: 'error' },
      }),
    )
    let sentBody: Record<string, any> | undefined
    let sentHeaders: Headers | undefined
    const sentBillingHeaders: string[] = []
    const upstreamRequestIds = [
      'req_011111111111111111111111',
      'req_022222222222222222222222',
      'req_033333333333333333333333',
    ]
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(
              Response.json({
                oauth_account: { account_uuid: 'effort-account' },
              }),
            )
          }
          if (url.includes('/v1/messages')) {
            sentBody = JSON.parse(String(init?.body))
            sentHeaders = new Headers(init?.headers)
            sentBillingHeaders.push(String(sentBody?.system?.[0]?.text ?? ''))
            return Promise.resolve(
              new Response('{}', {
                status: 200,
                headers: {
                  'request-id':
                    upstreamRequestIds[sentBillingHeaders.length - 1] ??
                    'req_099999999999999999999999',
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
          id: 'msg_effort_low',
          role: 'user',
          sessionID: 'ses_effort',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'low',
          },
        },
        parts: [{ type: 'text', text: 'first' }],
      },
      {
        info: {
          id: 'msg_effort_step_1',
          role: 'assistant',
          sessionID: 'ses_effort',
        },
        parts: [],
      },
      {
        info: {
          id: 'msg_effort_step_2',
          role: 'assistant',
          sessionID: 'ses_effort',
        },
        parts: [],
      },
      {
        info: {
          id: 'msg_effort_high',
          role: 'user',
          sessionID: 'ses_effort',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'high',
          },
        },
        parts: [{ type: 'text', text: 'second' }],
      },
      {
        info: {
          id: 'msg_effort_current',
          role: 'user',
          sessionID: 'ses_effort',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'high',
          },
        },
        parts: [{ type: 'text', text: 'current' }],
      },
    ]
    await plugin['experimental.chat.messages.transform']({}, { messages })
    const loweredUserContent = (index: number) =>
      messages[index]?.parts
        .filter((part) => part.type === 'text')
        .map((part) => ({ type: 'text', text: part.text }))
    const output = { headers: {} as Record<string, string> }
    await plugin['chat.headers'](
      { sessionID: 'ses_effort', message: { id: 'msg_effort_current' } },
      output,
    )

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
    const loweredRequestBody = JSON.stringify({
      model: 'claude-fable-5-1',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'trace', signature: 'sig' },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'user', content: loweredUserContent(3) },
        { role: 'user', content: loweredUserContent(4) },
      ],
    })
    const send = (headers: Record<string, string>) =>
      auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          ...headers,
          'x-session-affinity': 'ses_effort',
        },
        body: loweredRequestBody,
      })
    expect((await send(output.headers)).status).toBe(200)
    const firstPromptId = sentBillingHeaders[0]?.match(
      /cc_prompt_id=([^;]+);/,
    )?.[1]
    expect(firstPromptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(sentBillingHeaders[0]).not.toContain('cc_prev_req=')

    const retryOutput = { headers: {} as Record<string, string> }
    await plugin['chat.headers'](
      { sessionID: 'ses_effort', message: { id: 'msg_effort_current' } },
      retryOutput,
    )
    expect(retryOutput.headers['x-cortexkit-effort-plan']).toBe(
      output.headers['x-cortexkit-effort-plan'],
    )
    expect((await send(retryOutput.headers)).status).toBe(200)
    expect(sentBillingHeaders[1]).toContain(`cc_prompt_id=${firstPromptId};`)
    expect(sentBillingHeaders[1]).toContain(
      'cc_prev_req=req_011111111111111111111111;',
    )

    expect(sentBody?.output_config).toEqual({ effort: 'low' })
    expect(sentBody?.messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'trace', signature: 'sig' },
          { type: 'text', text: 'answer' },
        ],
      },
      {
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'current' }],
      },
    ])
    expect(sentBody?.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'error',
    })
    expect(sentHeaders?.get('anthropic-beta')).toContain(
      'per-turn-control-2026-07-01',
    )
    expect(sentHeaders?.get('anthropic-beta')).toContain(
      'thinking-binding-controls-2026-08-01',
    )
    expect(
      [...(sentHeaders?.keys() ?? [])].some((header) =>
        header.startsWith('x-cortexkit-effort'),
      ),
    ).toBe(false)
    expect(sentHeaders?.has('x-cortexkit-billing-lineage')).toBe(false)

    const prefixTrimmedResponse = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        ...retryOutput.headers,
        'x-session-affinity': 'ses_effort',
      },
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: loweredUserContent(4) }],
      }),
    })
    expect(prefixTrimmedResponse.status).toBe(200)
    expect(sentBody?.output_config).toEqual({ effort: 'high' })
    expect(sentBody?.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'current' }],
      },
    ])
  })

  test('fails locally when request-correlated effort markers cannot be validated', async () => {
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
      }),
    )
    let messagesCalled = false
    globalThis.fetch = mock(
      withNativeAdmission((input: string | URL | Request) => {
        const url = extractUrl(input)
        if (url.includes('/claude_cli/bootstrap')) {
          return Promise.resolve(
            Response.json({
              oauth_account: { account_uuid: 'effort-account' },
            }),
          )
        }
        if (url.includes('/v1/messages')) messagesCalled = true
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin()
    const markedMessages = [
      {
        info: {
          id: 'msg_marked_low',
          role: 'user',
          sessionID: 'ses_effort_invalid',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'low',
          },
        },
        parts: [{ type: 'text', text: 'low effort' }],
      },
      {
        info: {
          id: 'msg_marked_assistant',
          role: 'assistant',
          sessionID: 'ses_effort_invalid',
        },
        parts: [],
      },
      {
        info: {
          id: 'msg_marked_high',
          role: 'user',
          sessionID: 'ses_effort_invalid',
          model: {
            providerID: 'anthropic',
            modelID: 'claude-fable-5-1',
            variant: 'high',
          },
        },
        parts: [{ type: 'text', text: 'high effort' }],
      },
    ]
    await plugin['experimental.chat.messages.transform'](
      {},
      { messages: markedMessages },
    )
    const internalTexts = markedMessages[2]?.parts.flatMap((part) =>
      typeof part.text === 'string' ? [part.text] : [],
    )
    const transitionMarker = internalTexts?.find((text) =>
      text.startsWith(EFFORT_MARKER_PREFIX),
    )
    const anchorMarker = internalTexts?.find((text) =>
      text.includes('cortexkit-internal-effort-anchor'),
    )
    expect(transitionMarker).toBeString()
    expect(anchorMarker).toBeString()
    const correlatedHeaders = { headers: {} as Record<string, string> }
    await plugin['chat.headers'](
      {
        sessionID: 'ses_effort_invalid',
        message: { id: 'msg_marked_high' },
      },
      correlatedHeaders,
    )
    const effortPlanHeader =
      correlatedHeaders.headers['x-cortexkit-effort-plan']
    expect(effortPlanHeader).toBeString()

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
    const send = (
      sessionId: string,
      internal: Array<string | undefined>,
      includeEffortPlan = true,
    ) =>
      auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-session-affinity': sessionId,
          ...(includeEffortPlan && effortPlanHeader
            ? { 'x-cortexkit-effort-plan': effortPlanHeader }
            : {}),
        },
        body: JSON.stringify({
          model: 'claude-fable-5-1',
          output_config: { effort: 'high' },
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'correlation failure' },
                ...internal.map((text) => ({ type: 'text', text })),
              ],
            },
          ],
        }),
      })

    const missingRequestPlan = await send(
      'ses_effort_missing_request_plan',
      [transitionMarker],
      false,
    )
    expect(missingRequestPlan.status).toBe(400)
    expect((await missingRequestPlan.json()).error.message).toBe(
      'Missing or invalid internal per-message effort request plan',
    )

    const refusalLogs: LogTestRecord[] = []
    __setLogTestSink((record) => refusalLogs.push(record))
    const missingAllMarkers = await send('ses_effort_missing_all', [])
    expect(missingAllMarkers.status).toBe(400)
    expect((await missingAllMarkers.json()).error.message).toBe(
      'Per-message effort marker correlation failed: expected 1, found 0',
    )
    const missingAllLog = refusalLogs.find(
      (record) => record.payload?.check === 'missing_all_markers',
    )
    expect(missingAllLog).toMatchObject({
      level: 'warn',
      channel: 'effort-history',
      message: 'refused uncorrelated per-message effort request',
      payload: {
        markerCount: 1,
        resolvedPlan: true,
        plannedBoundaryId: 'msg_marked_high',
        retainedUserMessageCount: 1,
        lastUserTextBlockCount: 1,
        expectedAnchorHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
    expect(JSON.stringify(missingAllLog)).not.toContain('correlation failure')

    const duplicateTransition = await send('ses_effort_duplicate_transition', [
      transitionMarker,
      transitionMarker,
      anchorMarker,
    ])
    expect(duplicateTransition.status).toBe(400)
    expect((await duplicateTransition.json()).error.message).toBe(
      'Per-message effort marker correlation failed: expected 1, found 2',
    )

    const misplacedAnchor = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-session-affinity': 'ses_effort_misplaced_anchor',
        ...(effortPlanHeader
          ? { 'x-cortexkit-effort-plan': effortPlanHeader }
          : {}),
      },
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        output_config: { effort: 'high' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'correlation failure' },
              { type: 'text', text: transitionMarker },
              { type: 'text', text: anchorMarker },
            ],
          },
          { role: 'user', content: 'unexpected boundary' },
        ],
      }),
    })
    expect(misplacedAnchor.status).toBe(400)
    expect((await misplacedAnchor.json()).error.message).toBe(
      'Missing or invalid internal per-message effort anchor placement',
    )
    expect(refusalLogs).toContainEqual({
      level: 'warn',
      channel: 'effort-history',
      message: 'refused uncorrelated per-message effort request',
      payload: expect.objectContaining({
        check: 'anchor_placement',
        anchorBoundaryId: 'msg_marked_high',
        plannedBoundaryId: 'msg_marked_high',
        lastUserMessageId: null,
        anchorMessageIndex: 0,
        lastUserMessageIndex: 1,
        anchorsFound: 1,
        markerCount: 1,
        validToolContinuationSuffix: false,
        expectedAnchorHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        foundAnchorHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        anchorMatchesExpected: true,
      }),
    })
    expect(JSON.stringify(refusalLogs)).not.toContain(anchorMarker)
    expect(JSON.stringify(refusalLogs)).not.toContain(transitionMarker)
    expect(messagesCalled).toBe(false)
  })
})

describe('meaningful trailing assistant history', () => {
  const originalFetch = globalThis.fetch
  afterEach(async () => {
    globalThis.fetch = originalFetch
    __setLogTestSink(null)
    await drainSidebarWrites()
  })

  const trailingAssistantBody = () =>
    JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'earlier question' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'completed private answer' }],
        },
      ],
    })

  async function expectLocalRefusal(response: Response) {
    expect(response.status).toBe(400)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: TRAILING_ASSISTANT_HISTORY_MESSAGE,
      },
    })
  }

  test('OAuth route refuses locally without model dispatch or fallback', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        fallbackOn: [400, 429],
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
      }),
    )
    const modelDispatches: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/claude_cli/bootstrap')) {
            return Promise.resolve(
              Response.json({
                oauth_account: { account_uuid: 'trailing-account' },
              }),
            )
          }
          if (url.includes('/v1/messages')) {
            const authorization = new Headers(init?.headers).get(
              'authorization',
            )
            modelDispatches.push(authorization ?? '')
            // An actual provider 400 remains eligible under the explicit policy,
            // even when its error body matches the plugin's local refusal.
            if (authorization === 'Bearer sk-ant-oat01-main-access') {
              return Promise.resolve(
                Response.json(
                  {
                    type: 'error',
                    error: {
                      type: 'invalid_request_error',
                      message: TRAILING_ASSISTANT_HISTORY_MESSAGE,
                    },
                  },
                  { status: 400 },
                ),
              )
            }
            return Promise.resolve(new Response('{}', { status: 200 }))
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))

    const plugin = await getPlugin()
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

    const fallbackUseBefore = (await readAccountStorage())?.accounts.find(
      (account) => account.id === 'fallback-1',
    )?.lastUsed
    await expectLocalRefusal(
      await auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_trailing_oauth' },
        body: trailingAssistantBody(),
      }),
    )
    expect(modelDispatches).toEqual([])
    expect(
      (await readAccountStorage())?.accounts.find(
        (account) => account.id === 'fallback-1',
      )?.lastUsed,
    ).toBe(fallbackUseBefore)
    await drainSidebarWrites()
    expect((await getSidebarState()).activeId).not.toBe('fallback-1')
    expect(logs).toContainEqual({
      level: 'warn',
      channel: 'transform',
      message: 'refused request ending on assistant history',
      payload: expect.objectContaining({
        check: 'meaningful_trailing_assistant',
        trailingMessageIndex: 1,
      }),
    })
    expect(JSON.stringify(logs)).not.toContain('completed private answer')

    // Control: the same fixture does fall back when the model is reached, so
    // the refusal above stayed local because of the history check.
    const control = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_trailing_oauth' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'new question' }],
      }),
    })
    expect(control.status).toBe(200)
    expect(modelDispatches).toEqual([
      'Bearer sk-ant-oat01-main-access',
      'Bearer sk-ant-oat01-fallback-access',
    ])
    await drainSidebarWrites()
    expect((await getSidebarState()).activeId).toBe('fallback-1')
    await plugin.dispose?.()
    expect(
      (await readAccountStorage())?.accounts.find(
        (account) => account.id === 'fallback-1',
      )?.lastUsed,
    ).toBeGreaterThan(0)
  })

  test('API-key route refuses locally without model dispatch', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        fallbackOn: [400, 429],
        routing: { mode: 'fallback-first' },
        refresh: {
          enabled: false,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 30,
        },
        accounts: [
          {
            id: 'api-trailing',
            type: 'api',
            apiKey: 'api-trailing-key',
            baseURL: 'https://api.example.test',
            authHeader: 'x-api-key',
          },
        ],
        quota: { enabled: false } as AccountStorage['quota'],
      }),
    )
    const modelDispatches: string[] = []
    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
          const url = extractUrl(input)
          if (url.includes('/v1/messages')) {
            const headers = new Headers(init?.headers)
            modelDispatches.push(
              headers.get('x-api-key') ?? headers.get('authorization') ?? '',
            )
            // The upstream five-hour utilization header proves 100% usage.
            // Paid API-key fallback requires confirmed OAuth exhaustion;
            // selecting fallback-first alone does not permit paid requests.
            return Promise.resolve(
              new Response('{}', {
                status: 200,
                headers:
                  headers.get('authorization') ===
                  'Bearer sk-ant-oat01-main-access'
                    ? {
                        'anthropic-ratelimit-unified-representative-claim':
                          'five_hour',
                        'anthropic-ratelimit-unified-5h-utilization': '1',
                        'anthropic-ratelimit-unified-5h-reset': '1784246400',
                        'anthropic-ratelimit-unified-7d-utilization': '0.4',
                        'anthropic-ratelimit-unified-7d-reset': '1784628000',
                      }
                    : undefined,
              }),
            )
          }
          return Promise.resolve(new Response('{}', { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))

    const plugin = await getPlugin()
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
    const userEndedBody = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'new question' }],
    })

    // Warm-up: main serves this request and reports its quota as exhausted.
    await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_trailing_api' },
      body: userEndedBody,
    })
    expect(modelDispatches).toEqual(['Bearer sk-ant-oat01-main-access'])
    modelDispatches.length = 0
    await drainSidebarWrites()
    expect((await getSidebarState()).activeId).toBe('main')

    await expectLocalRefusal(
      await auth.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses_trailing_api' },
        body: trailingAssistantBody(),
      }),
    )
    expect(modelDispatches).toEqual([])
    // The API-key route must return its local 400, not throw. A throw would
    // make routing try main and set sidebar activeId to 'main' instead of the
    // API-key account id asserted below.
    await drainSidebarWrites()
    expect(await getSidebarState()).toMatchObject({
      activeId: 'api-trailing',
      route: 'fallback-first',
    })
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        channel: 'transform',
        message: 'refused request ending on assistant history',
      }),
    )
    expect(JSON.stringify(logs)).not.toContain('completed private answer')

    // Control: a user-ended request in the same state reaches the API-key
    // account, so only the history check kept the refused request local.
    const control = await auth.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses_trailing_api' },
      body: userEndedBody,
    })
    expect(control.status).toBe(200)
    expect(modelDispatches).toEqual(['api-trailing-key'])
  })
})

describe('claude-start integration', () => {
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    testContext.pluginRuntimeOverrides = {
      setInterval: mock(
        () => ({ unref() {} }) as unknown as ReturnType<typeof setInterval>,
      ) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
    resetCache1hState()
    resetDumpState()
    setLogLevel('info')
    process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
      }),
    )
  })

  afterEach(async () => {
    __setLogTestSink(null)
    globalThis.fetch = originalFetch
    testContext.pluginRuntimeOverrides = {}
    resetDumpState()
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await drainSidebarWrites()
    restoreProcessTestFiles()
    // Clear testContext.tempConfigDir without deleting the account files used by plugins.
    // TestLifetime disposes those plugins and joins their work before removal.
    testContext.tempConfigDir = undefined
  })

  test('claude-start request shapes only its correlated OAuth turn and emits diagnostics', async () => {
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        sent.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        })
        return Promise.resolve(
          new Response(
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: 'provider-start',
                model: 'claude-opus-4-8',
                usage: {
                  input_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 1,
                  cache_creation: {
                    ephemeral_5m_input_tokens: 0,
                    ephemeral_1h_input_tokens: 1,
                  },
                },
                diagnostics: { cache_miss_reason: null },
              },
            })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
            { status: 200 },
          ),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const client = createMockClient()
    const plugin = await getPlugin(client)
    // Diagnostics records emit at debug level; enable it after plugin
    // load so boot-time level application cannot reset it.
    setLogLevel('debug')
    const headers: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-start' },
      {
        message: { id: 'msg-start' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin['chat.headers'](
      { sessionID: 'ses-start', message: { id: 'msg-start' } },
      { headers },
    )
    expect(headers).toEqual({ [LANE_START_REQUEST_HEADER]: '1' })

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await (
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-start', ...headers },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          max_tokens: 99,
          thinking: { type: 'enabled', budget_tokens: 10 },
          messages: [{ role: 'user', content: 'start' }],
        }),
      })
    ).text()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toMatchObject({ max_tokens: 1, stream: true })
    expect(sent[0]?.body.thinking).toBeUndefined()
    expect(sent[0]?.headers.has(LANE_START_REQUEST_HEADER)).toBe(false)
    const record = records.find(
      (entry) =>
        entry.channel === 'cache-diagnostics' &&
        entry.message.includes('provider-start'),
    )
    expect(record).toBeDefined()
    expect(
      JSON.parse(record!.message.replace('MC-CACHE-DIAG ', '')),
    ).toMatchObject({
      v: 2,
      source: 'start',
      synthetic: true,
      account_id: 'main',
      session_id: 'ses-start',
    })

    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'ses-start',
      }),
    )
    const latest = (
      client.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls.at(-1)?.[0]
    expect(latest?.body.parts[0]?.text).toContain('ses-start')
    setLogLevel('info')
  })

  test('claude-start concurrency does not shape an interleaved real turn', async () => {
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        sent.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        })
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const startHeaders: Record<string, string> = {}
    const realHeaders: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-race' },
      {
        message: { id: 'msg-start' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin['chat.headers'](
      { sessionID: 'ses-race', message: { id: 'msg-start' } },
      { headers: startHeaders },
    )
    await plugin['chat.headers'](
      { sessionID: 'ses-race', message: { id: 'msg-real' } },
      { headers: realHeaders },
    )
    expect(realHeaders).toEqual({})

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const request = (headers: Record<string, string>, maxTokens: number) =>
      result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-race', ...headers },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          max_tokens: maxTokens,
          thinking: { type: 'enabled', budget_tokens: 10 },
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
    await Promise.all([request(startHeaders, 99), request(realHeaders, 77)])

    expect(sent.map((entry) => entry.body.max_tokens).sort()).toEqual([1, 77])
    expect(
      sent.find((entry) => entry.body.max_tokens === 77)?.body.thinking,
    ).toEqual({
      type: 'enabled',
      budget_tokens: 10,
    })
    expect(
      sent.every((entry) => !entry.headers.has(LANE_START_REQUEST_HEADER)),
    ).toBe(true)
  })

  test('claude-start tags direct dumps', async () => {
    const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-start-dump-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          dump: { enabled: true },
        }),
      )
      globalThis.fetch = mock(
        withNativeAdmission(() =>
          Promise.resolve(
            new Response('event: message_stop\ndata: {}\n\n', { status: 200 }),
          ),
        ),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      const headers: Record<string, string> = {}
      await plugin['chat.message'](
        { sessionID: 'ses-start-dump' },
        {
          message: { id: 'msg-start-dump' },
          parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
        },
      )
      await plugin['chat.headers'](
        { sessionID: 'ses-start-dump', message: { id: 'msg-start-dump' } },
        { headers },
      )
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-start-dump', ...headers },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'start' }],
        }),
      })
      expect(
        (await readdir(dumpDir)).some((file) => file.includes('-start-')),
      ).toBe(true)
    } finally {
      if (previousDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('claude-start keeps a fallback-first API-key send ordinary', async () => {
    const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-api-start-dump-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'api-start',
              type: 'api',
              apiKey: 'api-start-key',
              baseURL: 'https://api.example.test',
              authHeader: 'x-api-key',
            },
          ],
          quota: { enabled: false },
          dump: { enabled: true },
        }),
      )
      const sent: Array<{ body: Record<string, unknown>; headers: Headers }> =
        []
      globalThis.fetch = mock(
        withNativeAdmission((_input: unknown, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          sent.push({ body: JSON.parse(String(init?.body)), headers })
          return Promise.resolve(
            new Response('{}', {
              status: 200,
              headers:
                headers.get('authorization') ===
                'Bearer sk-ant-oat01-main-access'
                  ? {
                      'anthropic-ratelimit-unified-representative-claim':
                        'five_hour',
                      'anthropic-ratelimit-unified-5h-utilization': '1',
                      'anthropic-ratelimit-unified-5h-reset': '1784246400',
                      'anthropic-ratelimit-unified-7d-utilization': '0.4',
                      'anthropic-ratelimit-unified-7d-reset': '1784628000',
                    }
                  : undefined,
            }),
          )
        }),
      ) as unknown as typeof fetch
      const plugin = await getPlugin()
      const result = await plugin.auth.loader(
        () =>
          Promise.resolve({
            type: 'oauth' as const,
            access: 'sk-ant-oat01-main-access',
            refresh: 'main-refresh',
            expires: Date.now() + 100_000,
          }),
        { models: {} },
      )
      const body = (maxTokens: number) =>
        JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          max_tokens: maxTokens,
          thinking: { type: 'enabled', budget_tokens: 10 },
          messages: [{ role: 'user', content: 'start' }],
        })
      await result.fetch(MESSAGES_URL, { method: 'POST', body: body(50) })
      const headers: Record<string, string> = {}
      await plugin['chat.message'](
        { sessionID: 'ses-api-start' },
        {
          message: { id: 'msg-api-start' },
          parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
        },
      )
      await plugin['chat.headers'](
        { sessionID: 'ses-api-start', message: { id: 'msg-api-start' } },
        { headers },
      )
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-api-start', ...headers },
        body: body(99),
      })

      const apiSend = sent.find(
        (entry) => entry.headers.get('x-api-key') === 'api-start-key',
      )
      expect(apiSend?.body).toMatchObject({ max_tokens: 99 })
      expect(apiSend?.body.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 10,
      })
      expect(apiSend?.headers.has(LANE_START_REQUEST_HEADER)).toBe(false)
      const metadata = await Promise.all(
        (await readdir(dumpDir))
          .filter((file) => file.endsWith('.meta.json'))
          .map(
            async (file) =>
              JSON.parse(await readFile(join(dumpDir, file), 'utf8')) as {
                tag?: string
              },
          ),
      )
      expect(metadata.some((entry) => entry.tag === 'start')).toBe(false)
    } finally {
      if (previousDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('claude-start shapes the OAuth fallback after an API-key failure', async () => {
    await useTempAccountFile(
      bindPoolAccounts(
        createFallbackStorage({
          routing: { mode: 'fallback-first' },
          accounts: [
            {
              id: 'api-fails',
              type: 'api',
              apiKey: 'api-fails-key',
              baseURL: 'https://api.example.test',
              authHeader: 'x-api-key',
            },
            {
              id: 'fallback-1',
              type: 'oauth',
              access: 'sk-ant-oat01-fallback-access',
              refresh: 'fallback-refresh',
              expires: Date.now() + 5 * 60 * 60 * 1000,
              quota: {
                five_hour: {
                  usedPercent: 25,
                  remainingPercent: 75,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 30,
                  remainingPercent: 70,
                  checkedAt: Date.now(),
                },
              },
            },
          ],
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
      ),
    )
    const sent: Array<{ body: Record<string, unknown>; headers: Headers }> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        sent.push({ body, headers })
        if (headers.get('x-api-key') === 'api-fails-key') {
          return Promise.resolve(new Response('{}', { status: 429 }))
        }
        return Promise.resolve(
          new Response('{}', {
            status: 200,
            headers:
              headers.get('authorization') === 'Bearer sk-ant-oat01-main-access'
                ? {
                    'anthropic-ratelimit-unified-representative-claim':
                      'five_hour',
                    'anthropic-ratelimit-unified-5h-utilization': '1',
                    'anthropic-ratelimit-unified-5h-reset': '1784246400',
                    'anthropic-ratelimit-unified-7d-utilization': '0.4',
                    'anthropic-ratelimit-unified-7d-reset': '1784628000',
                  }
                : undefined,
          }),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      max_tokens: 99,
      thinking: { type: 'enabled', budget_tokens: 10 },
      messages: [{ role: 'user', content: 'start' }],
    })
    const headers: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-api-then-oauth' },
      {
        message: { id: 'msg-api-then-oauth' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin['chat.headers'](
      {
        sessionID: 'ses-api-then-oauth',
        message: { id: 'msg-api-then-oauth' },
      },
      { headers },
    )
    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-api-then-oauth', ...headers },
      body,
    })

    const apiSend = sent.find(
      (entry) => entry.headers.get('x-api-key') === 'api-fails-key',
    )
    const oauthSend = sent.find(
      (entry) =>
        entry.headers.get('authorization') ===
        'Bearer sk-ant-oat01-fallback-access',
    )
    expect(apiSend?.body).toMatchObject({ max_tokens: 99 })
    expect(apiSend?.body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 10,
    })
    expect(oauthSend?.body).toMatchObject({ max_tokens: 1, stream: true })
    expect(oauthSend?.body.thinking).toBeUndefined()
  })

  test('claude-start clears the one-shot header before non-OAuth passthrough and session reuse', async () => {
    const seenHeaders: Headers[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: unknown, init?: RequestInit) => {
        seenHeaders.push(new Headers(init?.headers))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const headers: Record<string, string> = {}
    await plugin['chat.message'](
      { sessionID: 'ses-deleted' },
      {
        message: { id: 'reused-message' },
        parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
      },
    )
    await plugin.event({
      event: {
        type: 'session.deleted',
        properties: { sessionID: 'ses-deleted' },
      },
    })
    await plugin['chat.headers'](
      { sessionID: 'ses-deleted', message: { id: 'reused-message' } },
      { headers },
    )
    expect(headers).toEqual({})

    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth' as const,
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100_000,
        }),
      { models: {} },
    )
    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { [LANE_START_REQUEST_HEADER]: '1' },
      body: JSON.stringify({ max_tokens: 99, thinking: { type: 'enabled' } }),
    })
    expect(seenHeaders[0]?.has(LANE_START_REQUEST_HEADER)).toBe(false)
  })
})
