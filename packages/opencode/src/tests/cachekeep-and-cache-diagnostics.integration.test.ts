import { afterEach, beforeEach, describe, expect, mock } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  type CommandApplyRequest,
  type CommandApplyResult,
  getDumpDirectory,
  isDumpEnabled,
  type LogTestRecord,
  resetCache1hState,
  resetDumpState,
  setLogLevel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import { drainSidebarWrites } from '../sidebar-state'
import { getPluginTestHandles } from './plugin-test-handles'
import {
  applyMenuAction as applyMenuActionWithCtx,
  createMockClient,
  expectHandledCommandResponse,
} from './support/opencode1-client.ts'
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
function applyMenuAction(
  plugin: any,
  sessionId: string,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId'>,
): Promise<CommandApplyResult> {
  return applyMenuActionWithCtx(testContext, plugin, sessionId, request)
}

describe('auth.loader', () => {
  installLoaderSetup(testContext)

  test('cachekeep lists tracked sessions across OpenCode plugin instances', async () => {
    const nowHour = new Date().getHours()
    const startHour = (nowHour + 23) % 24
    const endHour = (nowHour + 1) % 24
    await useTempAccountFile(
      createFallbackStorage({
        routing: { mode: 'fallback-first' },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, startHour, endHour },
      }),
    )

    globalThis.fetch = mock(
      withNativeAdmission((input: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0.25 },
                seven_day: { utilization: 0.3 },
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(new Response(null, { status: 200 }))
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

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-1' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const secondPlugin = await getPlugin(createMockClient())
    const secondResult = await secondPlugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    await secondResult.fetch(MESSAGES_URL, {
      method: 'POST',
      headers: { 'x-session-affinity': 'session-2' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const registryDirectory =
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR
    if (!registryDirectory)
      throw new Error('missing cachekeep registry directory')
    for (let attempt = 0; attempt < 50; attempt++) {
      const entries = await readdir(registryDirectory).catch(() => [])
      if (entries.filter((entry) => entry.endsWith('.json')).length >= 2) break
      await Bun.sleep(10)
    }
    await expectHandledCommandResponse(
      plugin['command.execute.before']({
        command: 'claude',
        arguments: '',
        sessionID: 'session-1',
      }),
    )
    const promptCalls = (
      mockClient.session.promptAsync as unknown as {
        mock: { calls: Array<[{ body: { parts: Array<{ text: string }> } }]> }
      }
    ).mock.calls
    const latestCall = promptCalls.at(-1)?.[0]
    expect(latestCall?.body.parts[0]?.text).toContain('Tracked sessions: 2')
    expect(latestCall?.body.parts[0]?.text).toContain(
      'Sessions:\n- session-1\n- session-2',
    )
  })

  test('persistent claudeFast setting makes fetch wrapper request fast mode', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeFast: { enabled: true },
      }),
      {
        access: 'sk-ant-oat01-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )

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
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )

    await result.fetch(MESSAGES_URL, {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(capturedHeaders?.get('anthropic-beta')).toContain(
      'fast-mode-2026-02-01',
    )
    expect(JSON.parse(capturedBody!).speed).toBe('fast')
  })

  test.each(['claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-5'])(
    'persistent claudeFast setting skips unsupported %s',
    async (model) => {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          claudeFast: { enabled: true },
        }),
        {
          access: 'sk-ant-oat01-token',
          refresh: 'refresh',
          expires: Date.now() + 100000,
        },
      )

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
            access: 'sk-ant-oat01-token',
            refresh: 'refresh',
            expires: Date.now() + 100000,
          }),
        { models: {} },
      )

      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })

      expect(capturedHeaders?.get('anthropic-beta')).not.toContain(
        'fast-mode-2026-02-01',
      )
      expect(JSON.parse(capturedBody!).speed).toBeUndefined()
    },
  )

  test('/claude-cache on makes fetch wrapper set ttl on existing cache controls', async () => {
    await useTempAccountFile(createFallbackStorage({ accounts: [] }), {
      access: 'sk-ant-oat01-my-access-token',
      refresh: 'refresh',
      expires: Date.now() + 100000,
    })
    let capturedBody: string | undefined
    const mockClient = createMockClient()

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
        capturedBody = init?.body
        return Promise.resolve(new Response(null, { status: 200 }))
      }),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    expect(
      (
        await applyMenuAction(plugin, 'session-1', {
          sectionId: 'Cache',
          actionId: 'cache-on',
        })
      ).ok,
    ).toBe(true)

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

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello world test message' }],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('persistent claudeCache setting does not apply to subagent requests with parent session header', async () => {
    await useTempAccountFile(
      createFallbackStorage({ accounts: [], claudeCache: { enabled: true } }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
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
          capturedBody = String(init?.body)
          capturedHeaders = new Headers(init?.headers)
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
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

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-parent-session-id': 'parent-session' },
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello world test message' }],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.system[2].cache_control).toEqual({ type: 'ephemeral' })
    expect(capturedHeaders?.has('x-parent-session-id')).toBe(false)
  })

  test('persistent hybrid claudeCache mode rewrites cache controls for main session requests', async () => {
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
      }),
      {
        access: 'sk-ant-oat01-my-access-token',
        refresh: 'refresh',
        expires: Date.now() + 100000,
      },
    )
    let capturedBody: string | undefined
    const mockClient = createMockClient()

    globalThis.fetch = mock(
      withNativeAdmission(
        (input: string | URL | Request, init?: RequestInit) => {
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
          capturedBody = String(init?.body)
          return Promise.resolve(new Response(null, { status: 200 }))
        },
      ),
    ) as unknown as typeof fetch

    const plugin = await getPlugin(mockClient)
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

    await result.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'Cached block',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          { role: 'user', content: 'Magic Context history' },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'recent',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
          { role: 'user', content: 'follow up' },
        ],
      }),
    })

    const parsedBody = JSON.parse(capturedBody!)
    expect(parsedBody.cache_control).toBeUndefined()
    expect(parsedBody.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(parsedBody.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(parsedBody.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })
})

describe('cache diagnostics', () => {
  const originalFetch = globalThis.fetch
  const originalDateNow = Date.now

  const message = (
    id: string,
    diagnostics: unknown = { cache_miss_reason: null },
  ) => ({
    id,
    model: 'claude-opus-4-8',
    usage: {
      input_tokens: 101,
      cache_read_input_tokens: 75,
      cache_creation_input_tokens: 26,
      cache_creation: {
        ephemeral_5m_input_tokens: 20,
        ephemeral_1h_input_tokens: 6,
      },
    },
    diagnostics,
  })

  const sseResponse = (data: Record<string, unknown>, status = 200) =>
    new Response(
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: data })}\n\n` +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status },
    )

  const oauthLoader = () =>
    Promise.resolve({
      type: 'oauth' as const,
      access: 'sk-ant-oat01-main-access',
      refresh: 'main-refresh',
      expires: Date.now() + 100_000,
    })

  beforeEach(async () => {
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
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
      createFallbackStorage({ accounts: [], quota: { enabled: false } }),
    )
  })

  afterEach(async () => {
    __setLogTestSink(null)
    globalThis.fetch = originalFetch
    Date.now = originalDateNow
    testContext.pluginRuntimeOverrides = {}
    resetDumpState()
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION
    await drainSidebarWrites()
    restoreProcessTestFiles()
    // Clear testContext.tempConfigDir without deleting the account files used by plugins.
    // TestLifetime disposes those plugins and joins their work before removal.
    testContext.tempConfigDir = undefined
  })

  test('cache diagnostics binds the provider predecessor at request time', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    const delayedReleases = new Map<string, () => void>()
    const delayedResponse = (providerId: string) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          return new Promise<void>((resolve) => {
            delayedReleases.set(providerId, () => {
              const payload = message(providerId)
              controller.enqueue(
                new TextEncoder().encode(
                  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: payload })}\n\n` +
                    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
                ),
              )
              controller.close()
              resolve()
            })
          })
        },
      })
      return new Response(body, { status: 200 })
    }
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        const responsePlan = [
          ['ses-diag-A', 'provider-A'],
          ['ses-diag-B', 'provider-B'],
          ['ses-diag-A', 'provider-A-after'],
          ['ses-diag-B', 'provider-B-after'],
        ] as const
        const response = responsePlan[sentBodies.length - 1]
        if (!response) throw new Error('unexpected request')
        return Promise.resolve(
          sentBodies.length <= 2
            ? sseResponse(message(response[1]))
            : delayedResponse(response[1]),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin(
      createMockClient([
        { info: { id: 'msg_opencode_decoy', role: 'assistant' } },
      ]),
    )
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = (sessionId: string) => ({
      method: 'POST',
      headers: { 'x-session-affinity': sessionId },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    await (await result.fetch(MESSAGES_URL, request('ses-diag-A'))).text()
    await (await result.fetch(MESSAGES_URL, request('ses-diag-B'))).text()
    const delayedA = await result.fetch(MESSAGES_URL, request('ses-diag-A'))
    const delayedB = await result.fetch(MESSAGES_URL, request('ses-diag-B'))
    delayedReleases.get('provider-A-after')?.()
    await delayedA.text()
    delayedReleases.get('provider-B-after')?.()
    await delayedB.text()

    expect(sentBodies.map((body) => body.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
      { previous_message_id: 'provider-A' },
      { previous_message_id: 'provider-B' },
    ])
    const lines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      )
      .map((record) => JSON.parse(record.message.replace('MC-CACHE-DIAG ', '')))
    expect(lines).toHaveLength(4)
    expect(
      lines.find((line) => line.message_id === 'provider-A-after'),
    ).toMatchObject({
      previous_message_id: 'provider-A',
      ttl_sent: null,
      cache_read: 75,
      cache_creation: 26,
      input_tokens: 101,
      ephemeral_5m_tokens: 20,
      ephemeral_1h_tokens: 6,
      session_id: 'ses-diag-A',
      is_subagent: false,
      v: 2,
      source: 'turn',
      synthetic: false,
      account_id: 'main',
      betas_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    expect(
      lines.find((line) => line.message_id === 'provider-B-after'),
    ).toMatchObject({
      previous_message_id: 'provider-B',
      session_id: 'ses-diag-B',
    })
    setLogLevel('info')
  })

  test('cache diagnostics isolates missing affinity and strips the parent header', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const sentHeaders: Headers[] = []
    const records: LogTestRecord[] = []
    let requestNumber = 0
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        sentHeaders.push(new Headers(init.headers))
        requestNumber++
        return Promise.resolve(
          sseResponse(message(`provider-${requestNumber}`)),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    })
    await (
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-parent-session-id': 'parent-1' },
        body,
      })
    ).text()
    await (await result.fetch(MESSAGES_URL, { method: 'POST', body })).text()

    expect(sentBodies.map((entry) => entry.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
    ])
    expect(sentHeaders[0]?.has('x-parent-session-id')).toBe(false)
    const lines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      )
      .map((record) => JSON.parse(record.message.replace('MC-CACHE-DIAG ', '')))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      session_id: 'session-unknown',
      is_subagent: true,
    })
    expect(lines[1]).toMatchObject({
      session_id: 'session-unknown',
      is_subagent: false,
    })
    setLogLevel('info')
  })

  test('cache diagnostics emits the opt-in beta for normal and structured OAuth requests', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const betaHeaders: string[] = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        betaHeaders.push(new Headers(init.headers).get('anthropic-beta') ?? '')
        return Promise.resolve(
          sseResponse(message(`provider-${sentBodies.length}`)),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const mockClient = createMockClient()
    const plugin = await getPlugin(mockClient, testContext.tempConfigDir)
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    expect(
      (
        await applyMenuAction(plugin, 'session-cache-diagnostics', {
          sectionId: 'Diagnostics',
          actionId: 'logging-level',
          values: { level: 'debug' },
        })
      ).ok,
    ).toBe(true)
    for (const output_config of [
      undefined,
      { format: { type: 'json_schema' } },
    ]) {
      await (
        await result.fetch(MESSAGES_URL, {
          method: 'POST',
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
            ...(output_config ? { output_config } : {}),
          }),
        })
      ).text()
    }

    expect(sentBodies.map((body) => body.diagnostics)).toEqual([
      { previous_message_id: null },
      { previous_message_id: null },
    ])
    expect(
      betaHeaders.every((beta) => beta.includes('cache-diagnosis-2026-04-07')),
    ).toBe(true)
    const betaLines = records
      .filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG-BETAS '),
      )
      .map((record) =>
        JSON.parse(record.message.replace('MC-CACHE-DIAG-BETAS ', '')),
      )
    expect(betaLines).toHaveLength(2)
    expect(new Set(betaLines.map((line) => line.hash)).size).toBe(2)
    expect(
      records
        .filter(
          (record) =>
            record.channel === 'cache-diagnostics' &&
            record.message.startsWith('MC-CACHE-DIAG'),
        )
        .map((record) => record.level),
    ).toEqual(['debug', 'debug', 'debug', 'debug'])
    setLogLevel('info')
  })

  test('cache diagnostics observes non-streaming envelopes and carries their provider id forward', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        sentBodies.push(JSON.parse(String(init.body)))
        const id =
          sentBodies.length === 1 ? 'provider-json-A' : 'provider-json-B'
        return Promise.resolve(
          new Response(JSON.stringify(message(id)), { status: 200 }),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    await (await result.fetch(MESSAGES_URL, request)).text()

    expect(sentBodies[1]?.diagnostics).toEqual({
      previous_message_id: 'provider-json-A',
    })
    expect(
      records.filter(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.startsWith('MC-CACHE-DIAG '),
      ),
    ).toHaveLength(2)
    setLogLevel('info')
  })

  test('an OpenCode 1 prewarm preserves thinking block binding and carries its beta', async () => {
    let now = 1_000
    Date.now = mock(() => now) as unknown as typeof Date.now
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
        thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
      }),
    )
    const sent: Array<{ headers: Headers; body: Record<string, any> }> = []
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push({ headers: new Headers(init.headers), body })
        return Promise.resolve(
          body.max_tokens === 0
            ? Response.json(message('provider-thinking-warm'))
            : sseResponse(message('provider-thinking-live')),
        )
      }),
    ) as unknown as typeof fetch
    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    await (
      await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-thinking-binding-warm' },
        body: JSON.stringify({
          model: 'claude-fable-5-2',
          stream: true,
          thinking: { type: 'adaptive', display: 'summarized' },
          messages: [
            { role: 'user', content: 'first' },
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'reasoning',
                  signature: 'signature',
                },
                { type: 'text', text: 'answer' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
        }),
      })
    ).text()
    expect(sent).toHaveLength(1)
    const live = sent[0]!
    expect(live.body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    })
    now += 55 * 60_000
    await getPluginTestHandles(plugin).cacheKeepManager.tick()
    expect(sent).toHaveLength(2)
    const warm = sent[1]!
    expect(warm.body.max_tokens).toBe(0)
    expect(warm.body.thinking).toEqual(live.body.thinking)
    expect(warm.body.messages).toEqual(live.body.messages)
    expect(warm.headers.get('anthropic-beta')?.split(',')).toContain(
      'thinking-binding-controls-2026-08-01',
    )
  })

  test('cache diagnostics records cachekeep prewarms and carries their provider id forward', async () => {
    let now = 1_000
    const intervals: Array<{ callback: () => unknown; ms: number }> = []
    const sentBodies: Record<string, unknown>[] = []
    const records: LogTestRecord[] = []
    let prewarmStartedFlag = false
    let resolvePrewarmStarted: (() => void) | undefined
    const prewarmStarted = new Promise<void>((resolve) => {
      resolvePrewarmStarted = () => {
        prewarmStartedFlag = true
        resolve()
      }
    })
    Date.now = mock(() => now) as unknown as typeof Date.now
    testContext.pluginRuntimeOverrides = {
      setInterval: mock((callback: () => unknown, ms: number) => {
        intervals.push({ callback, ms })
        return { unref() {} } as unknown as ReturnType<typeof setInterval>
      }) as unknown as typeof setInterval,
      clearInterval: mock(() => {}) as unknown as typeof clearInterval,
    }
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        quota: { enabled: false },
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true, subagents: true },
      }),
    )
    let normalRequests = 0
    globalThis.fetch = mock(
      withNativeAdmission((_input: any, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        sentBodies.push(body)
        if (body.max_tokens === 0) {
          resolvePrewarmStarted?.()
          return Promise.resolve(
            new Response(JSON.stringify(message('provider-warm-B')), {
              status: 200,
            }),
          )
        }
        normalRequests++
        return Promise.resolve(
          sseResponse(
            message(
              normalRequests === 1 ? 'provider-real-A' : 'provider-real-C',
            ),
          ),
        )
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    setLogLevel('debug')
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-cachekeep' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 55 * 60_000
    const cacheKeepTick = intervals.at(-1)
    if (!cacheKeepTick) throw new Error('missing cachekeep interval')
    cacheKeepTick.callback()
    await Bun.sleep(20)
    await prewarmStarted
    expect(prewarmStartedFlag).toBe(true)
    for (
      let attempt = 0;
      attempt < 50 &&
      !records.some(
        (record) =>
          record.channel === 'cache-diagnostics' &&
          record.message.includes('provider-warm-B'),
      );
      attempt++
    ) {
      await Bun.sleep(10)
    }
    await (await result.fetch(MESSAGES_URL, request)).text()

    const prewarmBody = sentBodies.find((body) => body.max_tokens === 0)
    expect(prewarmBody?.diagnostics).toEqual({
      previous_message_id: 'provider-real-A',
    })
    expect(sentBodies.at(-1)?.diagnostics).toEqual({
      previous_message_id: 'provider-warm-B',
    })
    const prewarmRecord = records.find(
      (record) =>
        record.channel === 'cache-diagnostics' &&
        record.message.includes('provider-warm-B'),
    )
    expect(prewarmRecord).toBeDefined()
    expect(
      JSON.parse(prewarmRecord!.message.replace('MC-CACHE-DIAG ', '')),
    ).toMatchObject({
      is_subagent: false,
      ttl_sent: '1h',
      previous_message_id: 'provider-real-A',
      source: 'prewarm_cachekeep',
      synthetic: true,
      account_id: 'main',
      betas_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    setLogLevel('info')
  })

  test('cache diagnostics logs a short-gap previous-message canary but not unavailable', async () => {
    const records: LogTestRecord[] = []
    let now = 1_000
    Date.now = mock(() => now) as unknown as typeof Date.now
    const responses = [
      message('provider-canary-A'),
      message('provider-canary-B', {
        cache_miss_reason: { type: 'previous_message_not_found' },
      }),
      message('provider-canary-C', {
        cache_miss_reason: { type: 'unavailable' },
      }),
      message('provider-canary-D', {
        cache_miss_reason: { type: 'previous_message_not_found' },
      }),
    ]
    globalThis.fetch = mock(
      withNativeAdmission(() => {
        const response = responses.shift()
        if (!response) throw new Error('unexpected request')
        return Promise.resolve(sseResponse(response))
      }),
    ) as unknown as typeof fetch
    __setLogTestSink((record) => records.push(record))

    const plugin = await getPlugin()
    const result = await plugin.auth.loader(oauthLoader, { models: {} })
    const request = {
      method: 'POST',
      headers: { 'x-session-affinity': 'ses-canary' },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    }
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 299_999
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 300_000
    await (await result.fetch(MESSAGES_URL, request)).text()
    now += 300_000
    await (await result.fetch(MESSAGES_URL, request)).text()

    const warnings = records.filter(
      (record) =>
        record.level === 'warn' && record.channel === 'cache-diagnostics',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.payload).toMatchObject({
      message_id: 'provider-canary-B',
      previous_message_id: 'provider-canary-A',
    })
  })

  test('cache diagnostics stays disabled on API-key fallback while preserving its response artifact', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'cache-diagnostics-api-dump-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        bindPoolAccounts(
          createFallbackStorage({
            dump: { enabled: true },
            quota: {
              enabled: true,
              checkIntervalMinutes: 5,
              minimumRemaining: { five_hour: 10, seven_day: 20 },
              failClosedOnUnknownQuota: true,
              mainQuota: {
                checkedAt: Date.now(),
                five_hour: {
                  usedPercent: 100,
                  remainingPercent: 0,
                  checkedAt: Date.now(),
                },
                seven_day: {
                  usedPercent: 50,
                  remainingPercent: 50,
                  checkedAt: Date.now(),
                },
              },
              mainQuotaCheckedAt: Date.now(),
              mainQuotaToken: tokenFingerprint('sk-ant-oat01-main-access'),
            } as AccountStorage['quota'],
            accounts: [
              {
                id: 'kie-opus',
                type: 'api',
                apiKey: 'kie-key',
                baseURL: 'https://api.kie.ai/claude',
                authHeader: 'authorization-bearer',
              },
            ],
          }),
        ),
      )
      const records: LogTestRecord[] = []
      let sentBody: Record<string, unknown> | undefined
      let sentBeta = ''
      globalThis.fetch = mock(
        withNativeAdmission(
          (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            expect(extractUrl(input)).toBe(
              'https://api.kie.ai/claude/v1/messages?beta=true',
            )
            expect(new Headers(init?.headers).get('authorization')).toBe(
              'Bearer kie-key',
            )
            sentBody = JSON.parse(String(init?.body))
            sentBeta = new Headers(init?.headers).get('anthropic-beta') ?? ''
            return Promise.resolve(sseResponse(message('provider-api')))
          },
        ),
      ) as unknown as typeof fetch
      __setLogTestSink((record) => records.push(record))

      expect((await readAccountStorage())?.dump?.enabled).toBe(true)
      const plugin = await getPlugin()
      expect(isDumpEnabled()).toBe(true)
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      const response = await result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-api' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(response.status).toBe(200)
      await response.text()

      expect(sentBody).toBeDefined()
      expect(isDumpEnabled()).toBe(true)
      expect(getDumpDirectory()).toBe(dumpDir)
      expect(sentBody?.diagnostics).toBeUndefined()
      expect(sentBeta).not.toContain('cache-diagnosis-2026-04-07')
      expect(
        records.filter((record) => record.channel === 'cache-diagnostics'),
      ).toHaveLength(0)
      for (let attempt = 0; attempt < 50; attempt++) {
        if (
          (await readdir(dumpDir)).some((file) =>
            file.endsWith('.response.json'),
          )
        )
          break
        await Bun.sleep(10)
      }
      const responseFile = (await readdir(dumpDir)).find((file) =>
        file.endsWith('.response.json'),
      )
      expect(responseFile).toBeString()
      expect(
        JSON.parse(await readFile(join(dumpDir, responseFile!), 'utf8')),
      ).toMatchObject({
        status: 200,
        message_id: 'provider-api',
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

  test('cache diagnostics writes sanitized response artifacts for valid and malformed direct responses', async () => {
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(
      join(tmpdir(), 'cache-diagnostics-dump-test-'),
    )
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    try {
      await useTempAccountFile(
        createFallbackStorage({
          accounts: [],
          quota: { enabled: false },
          dump: { enabled: true },
        }),
      )
      const responses = [
        sseResponse({
          ...message('provider-dump'),
          content: [{ text: 'secret' }],
        }),
        new Response('not an envelope', { status: 503 }),
      ]
      globalThis.fetch = mock(
        withNativeAdmission(() => {
          const response = responses.shift()
          if (!response) throw new Error('unexpected request')
          return Promise.resolve(response)
        }),
      ) as unknown as typeof fetch

      const plugin = await getPlugin()
      const result = await plugin.auth.loader(oauthLoader, { models: {} })
      const request = {
        method: 'POST',
        headers: { 'x-session-affinity': 'ses-dump' },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      }
      await (await result.fetch(MESSAGES_URL, request)).text()
      await (await result.fetch(MESSAGES_URL, request)).text()

      let responseFiles: string[] = []
      for (let attempt = 0; attempt < 50; attempt++) {
        responseFiles = (await readdir(dumpDir)).filter((file) =>
          file.endsWith('.response.json'),
        )
        if (responseFiles.length === 2) break
        await Bun.sleep(10)
      }
      expect(responseFiles).toHaveLength(2)
      const artifacts = await Promise.all(
        responseFiles.map(async (file) =>
          JSON.parse(await readFile(join(dumpDir, file), 'utf8')),
        ),
      )
      expect(artifacts).toContainEqual(
        expect.objectContaining({
          status: 200,
          message_id: 'provider-dump',
          stream_complete: false,
        }),
      )
      expect(artifacts).toContainEqual({ status: 503, stream_complete: false })
      expect(JSON.stringify(artifacts)).not.toContain('secret')
    } finally {
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })
})
