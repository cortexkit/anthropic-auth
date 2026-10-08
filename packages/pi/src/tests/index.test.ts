import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import cortexKitPiAnthropicAuth from '../index'
import { closePiNativeRuntime } from '../native.ts'
import { getPiAccountStoragePath } from '../paths.ts'
import { saveNativePiFixture } from './native-fixture.ts'

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
  closePiNativeRuntime(getPiAccountStoragePath())
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
      },
    ) => {
      if (typeof name === 'string') {
        if (config) providers.set(name, config)
      } else {
        providers.set(name.id, {
          models: name.getModels().map((model) => ({ ...model })),
          streamSimple: name.streamSimple,
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
      input: ['text', 'image'],
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
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
