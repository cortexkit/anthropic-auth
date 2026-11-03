import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  CacheKeepManager,
  MessageThreadTracker,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
import {
  type AssistantMessage,
  type Context,
  getSupportedThinkingLevels,
  type Provider,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { buildAnthropicRequest } from '../convert.ts'
import cortexKitPiAnthropicAuth from '../index'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { getPiAccountStoragePath } from '../paths.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from './native-fixture.ts'

let tempDir: string | undefined
const originalFetch = globalThis.fetch

// Fable 5.1 is the family that carries mid-conversation effort markers, so it
// is the model that can observe what turn_start collected.
const fableModel = {
  id: 'claude-fable-5-1',
  name: 'Claude Fable 5.1',
  api: 'cortexkit-anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const messagesUrl = `${fableModel.baseUrl}/v1/messages`

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pi-native-index-'))
  const storagePath = join(tempDir, 'anthropic-auth.json')
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  await saveNativePiFixture({ version: 1, accounts: [] }, storagePath)
})

afterEach(async () => {
  await closePiNativeRuntime(getPiAccountStoragePath())
  globalThis.fetch = originalFetch
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

function mockPi() {
  const providers = new Map<
    string,
    {
      models?: Array<Record<string, unknown>>
      streamSimple?: (...args: any[]) => unknown
      stream?: (...args: any[]) => unknown
    }
  >()
  const events = new Map<string, (...args: any[]) => unknown>()

  const pi = {
    registerCommand: () => {},
    registerProvider: (
      name: string | Provider,
      config?: {
        models?: Array<Record<string, unknown>>
        streamSimple?: (...args: any[]) => unknown
        stream?: (...args: any[]) => unknown
      },
    ) => {
      if (typeof name === 'string') {
        if (config) providers.set(name, config)
      } else {
        providers.set(name.id, {
          models: name.getModels().map((model) => ({ ...model })),
          streamSimple: name.streamSimple,
          stream: name.stream,
        })
      }
    },
    on: (name: string, handler: (...args: any[]) => unknown) => {
      events.set(name, handler)
    },
  } as unknown as ExtensionAPI

  return { pi, providers, events }
}

describe('cortexKitPiAnthropicAuth provider registration', () => {
  test('exposes Claude Sonnet 5 in the Pi Anthropic catalog', async () => {
    const { pi, providers } = mockPi()

    await cortexKitPiAnthropicAuth(pi)

    const anthropic = providers.get('anthropic')
    expect(anthropic).toBeDefined()

    const sonnet5 = anthropic?.models?.find(
      (model) => model.id === 'claude-sonnet-5',
    )
    expect(sonnet5).toMatchObject({
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
  })

  test('exposes Claude Haiku 5.5 with adaptive efforts and the exact 100K price tier', async () => {
    const { pi, providers } = mockPi()
    await cortexKitPiAnthropicAuth(pi)
    const haiku55 = providers
      .get('anthropic')
      ?.models?.find((model) => model.id === 'claude-haiku-5-5')
    expect(haiku55).toMatchObject({
      id: 'claude-haiku-5-5',
      name: 'Claude Haiku 5.5',
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        xhigh: 'xhigh',
        max: 'max',
      },
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite: 0.125,
        tiers: [
          {
            inputTokensAbove: 100_000,
            input: 0.5,
            output: 2.5,
            cacheRead: 0.05,
            cacheWrite: 0.625,
          },
        ],
      },
    })
  })

  test('exposes Claude Sonnet 5.5 with native limits and prices', async () => {
    const { pi, providers } = mockPi()
    await cortexKitPiAnthropicAuth(pi)

    const sonnet55 = providers
      .get('anthropic')
      ?.models?.find((model) => model.id === 'claude-sonnet-5-5')
    expect(sonnet55).toMatchObject({
      id: 'claude-sonnet-5-5',
      name: 'Claude Sonnet 5.5',
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        xhigh: 'xhigh',
        max: 'max',
      },
      input: ['text', 'image'],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
  })

  test('exposes Claude Fable and Mythos 5.1 in the Pi Anthropic catalog', async () => {
    const { pi, providers } = mockPi()

    await cortexKitPiAnthropicAuth(pi)

    const models = providers.get('anthropic')?.models ?? []
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-fable-5-1',
          name: 'Claude Fable 5.1',
          reasoning: true,
          cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }),
        expect.objectContaining({
          id: 'claude-mythos-5-1',
          name: 'Claude Mythos 5.1',
          reasoning: true,
          cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }),
      ]),
    )
  })

  test('exposes Claude Opus 5.5 in the Pi Anthropic catalog', async () => {
    const { pi, providers } = mockPi()

    await cortexKitPiAnthropicAuth(pi)

    const opus55 = providers
      .get('anthropic')
      ?.models?.find((model) => model.id === 'claude-opus-5-5')
    expect(opus55).toMatchObject({
      id: 'claude-opus-5-5',
      name: 'Claude Opus 5.5',
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        xhigh: 'xhigh',
        max: 'max',
      },
      input: ['text', 'image'],
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
    // Opus 5.5 is adaptive-only: every offered level is an API effort.
    expect(
      getSupportedThinkingLevels(
        opus55 as unknown as Parameters<typeof getSupportedThinkingLevels>[0],
      ),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const { body } = await buildAnthropicRequest(
        'claude-opus-5-5',
        { messages: [], systemPrompt: '', tools: [] } as any,
        { reasoning: effort } as any,
        { enabled: false, mode: 'explicit' },
      )
      expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(body.output_config).toEqual({ effort })
    }
  })

  test('exposes Claude Opus 5 in the Pi Anthropic catalog', async () => {
    const { pi, providers } = mockPi()

    await cortexKitPiAnthropicAuth(pi)

    const opus5 = providers
      .get('anthropic')
      ?.models?.find((model) => model.id === 'claude-opus-5')
    expect(opus5).toMatchObject({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
  })
})

// Oh My Pi 18.x dropped SessionManager.buildContextEntries(); calling it threw
// on every turn, so no effort history was ever collected (issue #200). Only
// getSessionId/getBranch are assumed here — the accessors both hosts expose.
describe('cortexKitPiAnthropicAuth turn_start effort history', () => {
  test('carries transitions from a getBranch-only host into the request', async () => {
    if (!tempDir) throw new Error('Native index fixture is missing')
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

    const { pi, providers, events } = mockPi()
    await cortexKitPiAnthropicAuth(pi)

    // minimal -> low, then xhigh, with one assistant message between them.
    const branch = [
      { id: 't0', type: 'thinking_level_change', thinkingLevel: 'minimal' },
      { id: 'u1', type: 'message', message: { role: 'user' } },
      { id: 'a1', type: 'message', message: { role: 'assistant' } },
      { id: 't1', type: 'thinking_level_change', thinkingLevel: 'xhigh' },
      { id: 'u2', type: 'message', message: { role: 'user' } },
    ]
    const handler = events.get('turn_start')
    expect(handler).toBeDefined()
    await handler?.(
      { type: 'turn_start' },
      {
        sessionManager: {
          getSessionId: () => 'session-omp',
          getBranch: () => branch,
          getEntries: () => branch,
        },
      },
    )

    // Only the messages POST may be captured: if the stream path ever adds
    // another request (relay, quota, retry), this must fail loudly rather than
    // let the assertions below inspect that body instead.
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString()
        if (url.includes('/api/claude_cli/bootstrap')) {
          return new Response(
            JSON.stringify({
              oauth_account: { account_uuid: 'pi-turn-start-account' },
            }),
          )
        }
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method !== 'POST' || !url.startsWith(messagesUrl)) {
          throw new Error(`unexpected request: ${method} ${url}`)
        }
        expect(requestBody).toBeUndefined()
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

    const stream = providers.get('anthropic')?.streamSimple?.(
      fableModel,
      {
        systemPrompt: 'test',
        tools: [],
        messages: [
          { role: 'user', content: 'first', timestamp: 0 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'answer' }],
            timestamp: 0,
          },
          { role: 'user', content: 'second', timestamp: 0 },
        ],
      },
      { apiKey: 'sk-ant-oat-turn-start', sessionId: 'session-omp' },
    )
    for await (const _event of stream as AsyncIterable<unknown>) {
      // Drain the provider stream.
    }

    // The transitions the handler collected, as the request carries them: the
    // opening effort on the body and the later change as its own marker turn.
    expect(requestBody).toBeDefined()
    const sent = requestBody as { output_config: unknown; messages: unknown[] }
    expect(sent.output_config).toEqual({ effort: 'low' })
    expect(sent.messages[2]).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'xhigh' },
    })
  })

  test('degrades to no transitions when the host session shape is unreadable', async () => {
    const { pi, events } = mockPi()
    await cortexKitPiAnthropicAuth(pi)

    const handler = events.get('turn_start')
    expect(handler).toBeDefined()
    const ctx = {
      sessionManager: {
        getSessionId: () => 'session-broken',
        getBranch: () => {
          throw new TypeError('getBranch is not a function')
        },
      },
    }

    expect(await handler?.({ type: 'turn_start' }, ctx)).toBeUndefined()
  })
})

async function auditPiPrimaryHarness(suffix: string) {
  const runtime = await getPiNativeRuntime(getPiAccountStoragePath()).service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
    claudeCache: { enabled: false, mode: 'explicit' },
    cacheKeep: { enabled: false },
  }))
  const { pi, providers, events } = mockPi()
  await cortexKitPiAnthropicAuth(pi)
  const provider = providers.get('anthropic')
  if (!provider?.streamSimple) throw new Error('Missing registered Pi provider')
  const sessionId = `audit-pi-${suffix}`
  const context: Context = {
    systemPrompt: 'test',
    tools: [
      {
        name: 'read',
        description: 'Read a file',
        parameters: {
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Inspect the file' }],
        timestamp: 0,
      },
    ],
  }
  const turnContext = {
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      getEntries: () => [],
    },
  }
  const options: SimpleStreamOptions = {
    sessionId,
    onPayload: (payload) => payload,
    onResponse: () => {},
    onProviderStreamEvent: () => {},
  }
  const sent: Array<{ body: Record<string, any>; betas: string }> = []
  let reply: 'call_1' | 'call_2' | 'answer' = 'answer'
  const frame = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({
          oauth_account: { account_uuid: fixtureAccountIdentity('main') },
        })
      if (!url.includes('/v1/messages'))
        throw new Error('Unexpected primary-gate request')
      const text =
        init?.body instanceof Uint8Array
          ? gunzipSync(init.body).toString().trim()
          : String(init?.body)
      sent.push({
        body: JSON.parse(text),
        betas: new Headers(init?.headers).get('anthropic-beta') ?? '',
      })
      let output = frame('message_start', {
        type: 'message_start',
        message: {
          id: `msg_gate_${sent.length}`,
          model: fableModel.id,
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      })
      if (reply === 'answer') {
        output += frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        output += frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'answer' },
        })
      } else {
        output += frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: reply,
            name: 'Read',
            input: {},
          },
        })
        output += frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"file"}' },
        })
      }
      output += frame('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      })
      output += frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reply === 'answer' ? 'end_turn' : 'tool_use' },
        usage: { output_tokens: 1 },
      })
      output += frame('message_stop', { type: 'message_stop' })
      return new Response(output, {
        headers: {
          'content-type': 'text/event-stream',
          'request-id': `req_gate_${sent.length}`,
        },
      })
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  const contextFor = (sessionId: string) => ({
    ...turnContext,
    sessionManager: {
      ...turnContext.sessionManager,
      getSessionId: () => sessionId,
    },
  })
  const startFor = (id: string) =>
    events.get('turn_start')?.({ type: 'turn_start' }, contextFor(id))
  const settleFor = (id: string) =>
    events.get('agent_settled')?.({ type: 'agent_settled' }, contextFor(id))
  const start = () => startFor(sessionId)
  const settle = () => settleFor(sessionId)
  const send = async (
    history: Context,
    overrides: SimpleStreamOptions = options,
    raw = false,
    marked = true,
  ) => {
    const call = raw ? provider.stream : provider.streamSimple
    if (!call) throw new Error('Missing Pi stream entry point')
    const stream = (
      raw || !marked
        ? call(fableModel, history, overrides)
        : call(fableModel, history, overrides, 'agent-loop')
    ) as {
      result(): Promise<AssistantMessage>
    }
    const result = await stream.result()
    expect(result.stopReason).not.toBe('error')
    return result
  }
  return {
    context,
    options,
    sent,
    start,
    settle,
    startFor,
    settleFor,
    send,
    setReply: (value: typeof reply) => {
      reply = value
    },
  }
}

test('audit primary gates: explicitly marked Pi tool loop reuses the whole-turn lease', async () => {
  const h = await auditPiPrimaryHarness('tool-loop')
  await h.start()
  let history = h.context
  for (const id of ['call_1', 'call_2'] as const) {
    h.setReply(id)
    const reply = await h.send(history)
    expect(reply.stopReason).toBe('toolUse')
    history = {
      ...history,
      messages: [
        ...history.messages,
        reply,
        {
          role: 'toolResult',
          toolCallId: id,
          toolName: 'read',
          content: [{ type: 'text', text: `result ${id}` }],
          isError: false,
          timestamp: 1,
        },
      ],
    }
  }
  h.setReply('answer')
  await h.send(history)
  expect(h.sent.map((request) => request.body.thread?.type)).toEqual([
    'create',
    'continue',
    'continue',
  ])
  expect(h.sent[1]?.body.messages).toHaveLength(1)
  expect(h.sent[2]?.body.messages).toHaveLength(1)
})

test.each([
  'summary',
  'SDK warm',
  'missing callbacks',
  'raw call',
  'after settled',
])(
  'audit primary gates: Pi %s is stateless without disturbing the reply',
  async (kind) => {
    const h = await auditPiPrimaryHarness(kind)
    await h.start()
    const reply = await h.send(h.context)
    if (kind === 'after settled') await h.settle()
    const sideOptions: SimpleStreamOptions =
      kind === 'summary'
        ? { ...h.options, cacheRetention: 'none' }
        : kind === 'SDK warm'
          ? { ...h.options, maxTokens: 1 }
          : kind === 'missing callbacks'
            ? { sessionId: h.options.sessionId }
            : h.options
    await h.send(h.context, sideOptions, kind === 'raw call')
    expect(h.sent.at(-1)?.body.thread).toBeUndefined()
    expect(h.sent.at(-1)?.betas).not.toContain('message-threads-2026-08-12')
    if (kind === 'after settled') await h.start()
    await h.send({
      ...h.context,
      messages: [
        ...h.context.messages,
        reply,
        {
          role: 'user',
          content: [{ type: 'text', text: 'Next prompt' }],
          timestamp: 2,
        },
      ],
    })
    expect(h.sent.at(-1)?.body.thread).toEqual({
      type: 'continue',
      previous_message_id: 'msg_gate_1',
    })
  },
)

test('audit downstream refusal: Pi revokes a response aborted after raw EOF', async () => {
  const h = await auditPiPrimaryHarness('post-eof-abort')
  await h.start()
  const abort = new AbortController()
  const prepare = MessageThreadTracker.prototype.prepare
  let injected = false
  const spy = spyOn(
    MessageThreadTracker.prototype,
    'prepare',
  ).mockImplementation(function (this: MessageThreadTracker, input) {
    const prepared = prepare.call(this, input)
    if (input.session !== h.options.sessionId || injected) return prepared
    return {
      ...prepared,
      complete: (facts) => {
        prepared.complete(facts)
        injected = true
        abort.abort()
      },
    }
  })
  try {
    const aborted = await h.send(h.context, {
      ...h.options,
      signal: abort.signal,
    })
    expect(injected).toBe(true)
    expect(aborted.stopReason).toBe('aborted')
    const kept: AssistantMessage = {
      ...aborted,
      stopReason: 'stop',
      errorMessage: undefined,
    }
    await h.send({
      ...h.context,
      messages: [
        ...h.context.messages,
        kept,
        {
          role: 'user',
          content: [{ type: 'text', text: 'Next prompt' }],
          timestamp: 2,
        },
      ],
    })
    expect(h.sent.at(-1)?.body.thread).toEqual({ type: 'create' })
  } finally {
    spy.mockRestore()
  }
})

test('audit hot path: Pi retains an unsigned full template and signs only the sent shape', async () => {
  const track = spyOn(CacheKeepManager.prototype, 'track')
  try {
    const h = await auditPiPrimaryHarness('sign-once')
    await h.start()
    await h.send(h.context)
    const template =
      track.mock.calls.findLast(
        ([request]) => request.sessionId === h.options.sessionId,
      )?.[0].bodyText ?? ''
    expect(template).toContain('cch=00000;')
    expect(JSON.parse(template).thread).toBeUndefined()
    const wire = JSON.stringify(h.sent[0]?.body ?? {})
    expect(JSON.parse(wire).thread).toEqual({ type: 'create' })
    expect(await signRequestBody(wire)).toBe(wire)
  } finally {
    track.mockRestore()
  }
})

test('recheck user text: marked Pi string prompts keep three consecutive requests reusable', async () => {
  const h = await auditPiPrimaryHarness('user-string-history')
  let history: Context = {
    ...h.context,
    messages: [{ role: 'user', content: 'First prompt', timestamp: 0 }],
  }
  for (let turn = 0; turn < 3; turn++) {
    await h.start()
    const reply = await h.send(history)
    await h.settle()
    history = {
      ...history,
      messages: [
        ...history.messages,
        reply,
        { role: 'user', content: `Prompt ${turn + 2}`, timestamp: turn + 1 },
      ],
    }
  }
  expect(h.sent.map((request) => request.body.thread?.type)).toEqual([
    'create',
    'continue',
    'continue',
  ])
})

test.each(['another turn starts', 'another session settles'])(
  'recheck Pi leases: %s leaves the first session active',
  async (kind) => {
    const h = await auditPiPrimaryHarness(`concurrent-${kind}`)
    const firstId = h.options.sessionId
    if (!firstId) throw new Error('Missing session fixture')
    const secondId = `${firstId}-other`
    const secondOptions = { ...h.options, sessionId: secondId }
    let kept: AssistantMessage
    let previousId: string
    if (kind === 'another turn starts') {
      await h.startFor(firstId)
      kept = await h.send(h.context)
      previousId = 'msg_gate_1'
      await h.startFor(secondId)
      await h.send(h.context, secondOptions)
    } else {
      await h.startFor(secondId)
      await h.send(h.context, secondOptions)
      await h.startFor(firstId)
      kept = await h.send(h.context)
      previousId = 'msg_gate_2'
      await h.settleFor(secondId)
    }
    await h.send({
      ...h.context,
      messages: [
        ...h.context.messages,
        kept,
        { role: 'user', content: 'First session next', timestamp: 2 },
      ],
    })
    expect(h.sent.at(-1)?.body.thread).toEqual({
      type: 'continue',
      previous_message_id: previousId,
    })
    if (kind === 'another session settles') {
      await h.send(h.context, secondOptions)
      expect(h.sent.at(-1)?.body.thread).toBeUndefined()
    }
  },
)

test('recheck Pi origin: registered simplified side calls with callbacks remain direct', async () => {
  const h = await auditPiPrimaryHarness('unmarked-simplified-side-call')
  await h.start()
  const kept = await h.send(h.context)
  await h.send(h.context, h.options, false, false)
  expect(h.sent.at(-1)?.body.thread).toBeUndefined()
  expect(h.sent.at(-1)?.betas).not.toContain('message-threads-2026-08-12')
  await h.send({
    ...h.context,
    messages: [
      ...h.context.messages,
      kept,
      { role: 'user', content: 'Next primary prompt', timestamp: 2 },
    ],
  })
  expect(h.sent.at(-1)?.body.thread).toEqual({
    type: 'continue',
    previous_message_id: 'msg_gate_1',
  })
})
