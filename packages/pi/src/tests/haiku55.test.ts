import { expect, test } from 'bun:test'
import {
  CLAUDE_HAIKU_5_5_CONTEXT_WINDOW,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
  CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_HAIKU_5_5_PRICING,
  hasThinkingBindingControls,
  saveAccounts,
  THINKING_BINDING_CONTROLS_BETA,
} from '@cortexkit/anthropic-auth-core'
import {
  type AssistantMessage,
  type Context,
  calculateCost,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai'
import { buildAnthropicRequest } from '../convert.ts'
import { getPiAccountStoragePath } from '../paths.ts'
import { streamCortexKitAnthropic } from '../stream.ts'
import { trackPiTestBody } from './setup.ts'

const context: Context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
}
const cache = { enabled: false, mode: 'hybrid' as const }

test.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
  'Pi Haiku 5.5 uses native %s effort without manual budgets or fast mode',
  async (reasoning) => {
    const { body } = await buildAnthropicRequest(
      'claude-haiku-5-5',
      context,
      { reasoning },
      cache,
      true,
    )
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: reasoning })
    expect(body.thinking).not.toHaveProperty('budget_tokens')
    expect(body.speed).toBeUndefined()
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('top_k')
  },
)

test('Pi Haiku 5.5 defaults to adaptive thinking without inventing an effort override', async () => {
  const { body } = await buildAnthropicRequest(
    'claude-haiku-5-5',
    context,
    undefined,
    cache,
  )
  expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  expect(body.output_config).toBeUndefined()
})

test('Pi Haiku 5.5 refuses unsupported minimal effort', async () => {
  await expect(
    buildAnthropicRequest(
      'claude-haiku-5-5',
      context,
      { reasoning: 'minimal' },
      cache,
    ),
  ).rejects.toThrow('Claude Haiku 5.5 does not support minimal effort')
})

test('Pi Haiku 4.5 keeps the older manual-thinking contract', async () => {
  const { body } = await buildAnthropicRequest(
    'claude-haiku-4-5',
    context,
    { reasoning: 'low' },
    cache,
  )
  expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
  expect(body.output_config).toBeUndefined()
})

const pricedModel: Model<'cortexkit-anthropic-messages'> = {
  id: CLAUDE_HAIKU_5_5_MODEL_ID,
  name: 'Claude Haiku 5.5',
  api: 'cortexkit-anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: CLAUDE_HAIKU_5_5_CONTEXT_WINDOW,
  maxTokens: CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS,
  cost: {
    input: CLAUDE_HAIKU_5_5_PRICING.input,
    output: CLAUDE_HAIKU_5_5_PRICING.output,
    cacheRead: CLAUDE_HAIKU_5_5_PRICING.cacheRead,
    cacheWrite: CLAUDE_HAIKU_5_5_PRICING.cacheWrite5m,
    tiers: [
      {
        inputTokensAbove: CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
        input: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.input,
        output: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.output,
        cacheRead: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.cacheRead,
        cacheWrite: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.cacheWrite5m,
      },
    ],
  },
}

test.each([100_000, 100_001])(
  'Pi real accounting selects the whole-request rate at %s cache-inclusive input tokens',
  (inputTotal) => {
    const usage: Usage = {
      input: inputTotal - 1000,
      output: 20,
      cacheRead: 500,
      cacheWrite: 500,
      cacheWrite1h: 250,
      totalTokens: inputTotal + 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
    const cost = calculateCost(pricedModel, usage)
    const rates =
      inputTotal === 100_000
        ? CLAUDE_HAIKU_5_5_PRICING
        : CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING
    expect(cost.input).toBeCloseTo(
      ((inputTotal - 1000) * rates.input) / 1_000_000,
      12,
    )
    expect(cost.output).toBeCloseTo((20 * rates.output) / 1_000_000, 12)
    expect(cost.cacheRead).toBeCloseTo((500 * rates.cacheRead) / 1_000_000, 12)
    expect(cost.cacheWrite).toBeCloseTo(
      (250 * rates.cacheWrite5m + 250 * rates.cacheWrite1h) / 1_000_000,
      12,
    )
    expect(cost.total).toBeCloseTo(
      cost.input + cost.output + cost.cacheRead + cost.cacheWrite,
      12,
    )
  },
)

function history(redacted: boolean): Context {
  const assistant: AssistantMessage = {
    role: 'assistant',
    api: 'cortexkit-anthropic-messages',
    provider: 'anthropic',
    model: CLAUDE_HAIKU_5_5_MODEL_ID,
    content: [
      {
        type: 'thinking',
        thinking: 'reason',
        thinkingSignature: 'signed-or-redacted',
        redacted,
      },
      { type: 'text', text: 'answer' },
    ],
    stopReason: 'stop',
    timestamp: 0,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
  return {
    messages: [
      { role: 'user', content: 'earlier synthetic turn', timestamp: 0 },
      assistant,
      { role: 'user', content: 'continue', timestamp: 1 },
    ],
    tools: [],
  }
}
const syntheticIdentity = {
  deviceId: 'd'.repeat(64),
  sessionId: 'synthetic-haiku-binding',
}

test.each(['error', 'drop_block'] as const)(
  'Pi Haiku replay receives %s for signed and redacted thinking',
  async (behavior) => {
    for (const redacted of [false, true]) {
      const { body } = await buildAnthropicRequest(
        CLAUDE_HAIKU_5_5_MODEL_ID,
        history(redacted),
        undefined,
        cache,
        false,
        syntheticIdentity,
        { thinkingPrefixMismatchBehavior: behavior },
      )
      expect(body.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
        block_binding: { prefix_mismatch_behavior: behavior },
      })
      expect(hasThinkingBindingControls(body)).toBe(true)
    }
  },
)

test('Pi Haiku first turns, account-default replay and API-key replay receive no binding opt-in', async () => {
  const requests = [
    await buildAnthropicRequest(
      CLAUDE_HAIKU_5_5_MODEL_ID,
      context,
      undefined,
      cache,
      false,
      syntheticIdentity,
      { thinkingPrefixMismatchBehavior: 'drop_block' },
    ),
    await buildAnthropicRequest(
      CLAUDE_HAIKU_5_5_MODEL_ID,
      history(false),
      undefined,
      cache,
      false,
      syntheticIdentity,
    ),
    await buildAnthropicRequest(
      CLAUDE_HAIKU_5_5_MODEL_ID,
      history(false),
      undefined,
      cache,
      false,
      undefined,
      { thinkingPrefixMismatchBehavior: 'drop_block' },
    ),
  ]
  for (const { body } of requests) {
    expect(body.thinking).not.toHaveProperty('block_binding')
    expect(hasThinkingBindingControls(body)).toBe(false)
  }
})

test('Pi Haiku physical OAuth dispatch carries its prefix control and beta together', () =>
  trackPiTestBody(
    (async () => {
      await saveAccounts(
        {
          version: 1,
          main: { type: 'opencode', provider: 'anthropic' },
          accounts: [],
          thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
        },
        getPiAccountStoragePath(),
      )
      const originalFetch = globalThis.fetch
      let capturedBody: Record<string, unknown> | undefined
      let capturedHeaders: Headers | undefined
      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.includes('/api/claude_cli/bootstrap'))
          return Response.json({
            oauth_account: { account_uuid: 'synthetic-haiku-account' },
          })
        if (url.endsWith('/api/oauth/usage'))
          return Response.json({
            five_hour: {
              utilization: 0,
              resets_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
            seven_day: {
              utilization: 0,
              resets_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            },
          })
        if (!url.includes('/v1/messages'))
          throw new Error('Unexpected transport in isolated Haiku stream test')
        capturedBody = JSON.parse(String(init?.body))
        capturedHeaders = new Headers(init?.headers)
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"claude-haiku-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      globalThis.fetch = Object.assign(fakeFetch, {
        preconnect: (..._args: Parameters<typeof originalFetch.preconnect>) => {
          throw new Error('Preconnect is forbidden in isolated stream tests')
        },
      })
      try {
        const stream = streamCortexKitAnthropic(pricedModel, history(false), {
          apiKey: 'sk-ant-oat-synthetic-haiku',
          sessionId: 'synthetic-haiku-dispatch',
        })
        for await (const event of stream) {
          expect(event.type).not.toBe('error')
        }
        expect(capturedBody).toMatchObject({
          thinking: {
            type: 'adaptive',
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
          },
        })
        expect(capturedHeaders?.get('anthropic-beta')?.split(',')).toContain(
          THINKING_BINDING_CONTROLS_BETA,
        )
      } finally {
        globalThis.fetch = originalFetch
      }
    })(),
  ))
