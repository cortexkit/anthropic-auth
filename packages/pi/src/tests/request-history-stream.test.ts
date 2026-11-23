import { afterEach, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TRAILING_ASSISTANT_HISTORY_MESSAGE } from '@cortexkit/anthropic-auth-core'
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from '@earendil-works/pi-ai'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import {
  __sendPiAnthropicRequestForTest,
  streamCortexKitAnthropic,
} from '../stream.ts'
import { saveNativePiFixture } from './native-fixture.ts'

const originalFetch = globalThis.fetch
const originalPath = process.env.PI_ANTHROPIC_AUTH_FILE
let directory: string | undefined
let currentStoragePath: string | undefined

async function cleanupFixture() {
  // An unclosed runtime keeps polling for vault accounts after its test ends.
  // Stop it before another test's fake vault receives those background reads.
  if (currentStoragePath) await closePiNativeRuntime(currentStoragePath)
  currentStoragePath = undefined
  globalThis.fetch = originalFetch
  if (originalPath === undefined) delete process.env.PI_ANTHROPIC_AUTH_FILE
  else process.env.PI_ANTHROPIC_AUTH_FILE = originalPath
  const finished = directory
  directory = undefined
  if (finished) await rm(finished, { recursive: true, force: true })
}

afterEach(cleanupFixture)

const model: Model<Api> = {
  id: 'claude-opus-5-5',
  name: 'Opus',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const assistant: AssistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Synthetic completed answer.' }],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: model.id,
  stopReason: 'stop',
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
}

for (const apiKey of ['sk-ant-oat-fixture-history', 'fixture-api-key']) {
  test.each([false, true])(
    `Pi refuses meaningful assistant history locally (${apiKey}, empty user=%s)`,
    async (emptyUser) => {
      directory = await mkdtemp(join(tmpdir(), 'pi-history-boundary-'))
      const storagePath = join(directory, 'anthropic-auth.json')
      currentStoragePath = storagePath
      process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      await saveNativePiFixture(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [],
          fallbackOn: [400, 429],
          quota: {
            enabled: false,
            checkIntervalMinutes: 5,
            minimumRemaining: {},
            failClosedOnUnknownQuota: false,
          },
        },
        storagePath,
      )

      let dispatches = 0
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.includes('/api/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: { account_uuid: 'pi-history-account' },
          })
        if (url.includes('/v1/messages')) {
          dispatches++
          return new Response(
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          )
        }
        throw new Error('Unexpected fixture network dispatch')
      }) as unknown as typeof fetch

      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Synthetic original question.',
            timestamp: 0,
          },
          assistant,
          ...(emptyUser
            ? [{ role: 'user' as const, content: '', timestamp: 2 }]
            : []),
        ],
        tools: [],
      }
      const stream = streamCortexKitAnthropic(model, context, { apiKey })
      const events = []
      for await (const event of stream) events.push(event)
      const result = await stream.result()
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toBe(TRAILING_ASSISTANT_HISTORY_MESSAGE)
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1)
      expect(events.some((event) => event.type === 'done')).toBe(false)
      expect(dispatches).toBe(0)

      const control = streamCortexKitAnthropic(
        model,
        {
          ...context,
          messages: [
            ...context.messages,
            { role: 'user', content: 'New valid question.', timestamp: 3 },
          ],
        },
        { apiKey },
      )
      for await (const _event of control) {
        /* Drain the control stream. */
      }
      expect((await control.result()).stopReason).toBe('stop')
      expect(dispatches).toBe(1)
    },
  )
}

test('Pi model-switch stream omits old thinking and keeps the effort change between users', async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-model-switch-history-'))
  const storagePath = join(directory, 'anthropic-auth.json')
  currentStoragePath = storagePath
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
  const sent: Array<Record<string, any>> = []
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({
          oauth_account: { account_uuid: 'pi-model-switch-account' },
        })
      if (url.includes('/v1/messages')) {
        sent.push(JSON.parse(String(init?.body)))
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_switch","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      throw new Error(`Unexpected fixture network dispatch: ${url}`)
    },
  ) as unknown as typeof fetch
  const stream = streamCortexKitAnthropic(
    model,
    {
      messages: [
        { role: 'user', content: 'Original question', timestamp: 0 },
        {
          ...assistant,
          model: 'claude-sonnet-4-20250514',
          content: [
            {
              type: 'thinking',
              thinking: 'Private old-model reasoning never to replay',
              thinkingSignature: 'old-signature',
            },
          ],
        },
        { role: 'user', content: 'Continue at low effort', timestamp: 2 },
      ],
      tools: [],
    },
    { apiKey: 'sk-ant-oat-fixture-switch', reasoning: 'low' },
    [
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'low' },
    ],
  )
  for await (const _event of stream) {
    /* Drain the model-switch stream. */
  }
  expect((await stream.result()).stopReason).toBe('stop')
  expect(sent).toHaveLength(1)
  expect(JSON.stringify(sent)).not.toContain('Private old-model reasoning')
  expect(JSON.stringify(sent)).not.toContain('old-signature')
  expect(sent[0]?.output_config).toEqual({ effort: 'high' })
  expect(sent[0]?.messages).toEqual([
    { role: 'user', content: 'Original question' },
    { role: 'system', content: [], output_config: { effort: 'low' } },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Continue at low effort',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ])
})

test('Pi API-key requests preserve the host prompt and tools without Claude Code shaping', async () => {
  const previous = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  }
  directory = await mkdtemp(join(tmpdir(), 'pi-api-thread-exclusion-'))
  const storagePath = join(directory, 'accounts.json')
  currentStoragePath = storagePath
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          id: 'api-thread',
          type: 'api',
          apiKey: 'synthetic-api-thread-key',
          baseURL: 'https://paid.invalid/proxy/v2',
        },
      ],
    },
    storagePath,
    { primary: false },
  )
  try {
    const runtime = await getPiNativeRuntime(storagePath).service()
    const apiAccount = (await runtime.read()).accounts.find(
      (account) => account.id === 'api-thread',
    )
    if (!apiAccount) throw new Error('Missing API account fixture')
    process.env.ANTHROPIC_BASE_URL = 'https://unused-paid.invalid'
    // The Opus alias is itself a Claude ID, so remapping it a second time
    // would match the generic override and lose the Opus-specific choice.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-paid-opus-alias'
    process.env.ANTHROPIC_MODEL = 'paid-generic-alias'
    let sent: RequestInit | undefined
    let url: string | undefined
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      sent = init
      url = String(input)
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch
    await (
      await __sendPiAnthropicRequestForTest(
        {
          model,
          context: {
            systemPrompt: 'Keep the Pi system prompt.',
            messages: [
              { role: 'user', content: 'Hello', timestamp: 0 },
              {
                ...assistant,
                content: [
                  {
                    type: 'thinking',
                    thinking: '\u2060',
                    thinkingSignature:
                      'cortexkit-server-fallback-v1:claude-fable-5-1|claude-opus-5-5',
                  },
                  {
                    type: 'toolCall',
                    id: 'call_read',
                    name: 'read',
                    arguments: {},
                  },
                ],
                stopReason: 'toolUse',
              },
              {
                role: 'toolResult',
                toolCallId: 'call_read',
                toolName: 'read',
                content: [{ type: 'text', text: 'Result' }],
                isError: false,
                timestamp: 2,
              },
            ],
            tools: [
              {
                name: 'read',
                description: 'Read data',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
          apiAccount,
          storagePath,
          streamOptions: {
            sessionId: 'pi-api-thread',
            onPayload: (payload) => ({
              ...(payload as Record<string, unknown>),
              service_tier: 'standard_only',
              fallbacks: 'default',
            }),
          },
        },
        { fetch: fetchImpl },
      )
    ).text()
    const body = JSON.parse(String(sent?.body))
    expect(body.system).toEqual([
      { type: 'text', text: 'Keep the Pi system prompt.' },
    ])
    expect(body.tools).toMatchObject([{ name: 'read' }])
    expect(body.messages).toEqual([
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_read', name: 'read', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_read',
            content: 'Result',
            is_error: false,
          },
        ],
      },
    ])
    expect(body.model).toBe('claude-paid-opus-alias')
    expect(body.thread).toBeUndefined()
    expect(body.fallbacks).toBeUndefined()
    expect(body.service_tier).toBe('standard_only')
    expect(url).toBe('https://paid.invalid/proxy/v2/messages?beta=true')
    const headers = new Headers(sent?.headers)
    expect(headers.get('authorization')).toBe('Bearer synthetic-api-thread-key')
    expect(headers.get('anthropic-beta')).not.toContain('message-threads-')
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await closePiNativeRuntime(storagePath)
  }
})

test('Pi history fixture cleanup stops its native vault poll', async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-history-poll-cleanup-'))
  const storagePath = join(directory, 'anthropic-auth.json')
  currentStoragePath = storagePath
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture({ version: 1, accounts: [] }, storagePath)
  const polls = new Set<object>()
  const native = getPiNativeRuntime(storagePath, {
    vaultPoll: {
      intervalMs: 2000,
      setInterval: (() => {
        const timer = { unref() {} }
        polls.add(timer)
        return timer
      }) as unknown as typeof setInterval,
      clearInterval: ((timer: object) => {
        polls.delete(timer)
      }) as unknown as typeof clearInterval,
    },
  })
  await native.service()
  expect(polls.size).toBe(1)
  await cleanupFixture()
  expect(polls.size).toBe(0)
})
