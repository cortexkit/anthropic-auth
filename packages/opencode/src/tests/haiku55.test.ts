import { expect, test } from 'bun:test'
import {
  THINKING_BINDING_CONTROLS_BETA,
  TrailingAssistantHistoryError,
} from '@cortexkit/anthropic-auth-core'
import { rewriteRequestBody, setOAuthHeaders } from '../transform.ts'

async function rewrite(
  fields: Record<string, unknown> = {},
  controls: NonNullable<Parameters<typeof rewriteRequestBody>[1]> = {},
) {
  return JSON.parse(
    await rewriteRequestBody(
      JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 2048,
        messages: [{ role: 'user', content: 'hello' }],
        ...fields,
      }),
      { fastModeEnabled: true, serverSideFallbackEnabled: true, ...controls },
    ),
  )
}

test.each([
  undefined,
  { type: 'enabled', budget_tokens: 4096 },
  { type: 'adaptive' },
])(
  'Haiku 5.5 normalizes thinking %j to summarized adaptive without sampling',
  async (thinking) => {
    const body = await rewrite({
      thinking,
      temperature: 0.7,
      top_p: 1,
      top_k: 32,
      speed: 'fast',
      fallbacks: 'default',
    })
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.top_k).toBeUndefined()
    expect(body.speed).toBeUndefined()
    expect(body.fallbacks).toBeUndefined()
  },
)

test.each(['low', 'medium', 'high'])(
  'Haiku 5.5 preserves valid disabled thinking at %s',
  async (effort) => {
    const body = await rewrite({
      thinking: { type: 'disabled', display: 'summarized' },
      output_config: { effort },
    })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toEqual({ effort })
  },
)

test.each(['xhigh', 'max'])(
  'Haiku 5.5 disabled thinking takes priority over unsupported %s effort',
  async (effort) => {
    const body = await rewrite({
      thinking: { type: 'disabled' },
      output_config: { effort },
    })
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toEqual({ effort: 'high' })
    const enabled = await rewrite({ output_config: { effort } })
    expect(enabled.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    })
    expect(enabled.output_config).toEqual({ effort })
  },
)

test.each([{ type: 'any' }, { type: 'tool', name: 'Read' }])(
  'Haiku 5.5 preserves forced tool choice %j and normal tool prefixing',
  async (choice) => {
    const body = await rewrite({
      tool_choice: choice,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    })
    expect(body.tool_choice).toEqual(
      choice.type === 'tool' ? { type: 'tool', name: 'mcp_Read' } : choice,
    )
    expect(body.tools[0].name).toBe('mcp_Read')
  },
)

test.each(['claude-haiku-5-5[1m]', 'claude-haiku-5-5-20261007'])(
  'Haiku 5.5 recognizes %s during outgoing-body normalization',
  async (model) => {
    const body = await rewrite({
      model,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      top_k: 1,
    })
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.top_k).toBeUndefined()
  },
)

test('Haiku 4.5 retains its manual thinking and sampling contract', async () => {
  const body = await rewrite({
    model: 'claude-haiku-4-5',
    thinking: { type: 'enabled', budget_tokens: 1024 },
    temperature: 0.7,
    top_p: 0.9,
    top_k: 16,
  })
  expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  expect(body.temperature).toBe(0.7)
  expect(body.top_p).toBe(0.9)
  expect(body.top_k).toBe(16)
})

test('Haiku 5.5 refuses meaningful assistant prefill before rewriting history', async () => {
  await expect(
    rewrite({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'prior answer' },
      ],
    }),
  ).rejects.toBeInstanceOf(TrailingAssistantHistoryError)
})

const replayedMessages = [
  { role: 'user', content: 'synthetic earlier turn' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'reason', signature: 'signed' },
      { type: 'text', text: 'answer' },
    ],
  },
  { role: 'user', content: 'continue' },
]

test.each(['error', 'drop_block'] as const)(
  'OpenCode Haiku replay receives configured %s control and matching beta',
  async (behavior) => {
    const body = await rewrite(
      { messages: replayedMessages },
      { thinkingPrefixMismatchBehavior: behavior },
    )
    expect(body.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: behavior },
    })
    const headers = setOAuthHeaders(new Headers(), 'synthetic-access-token', {
      body,
    })
    expect(headers.get('anthropic-beta')?.split(',')).toContain(
      THINKING_BINDING_CONTROLS_BETA,
    )
  },
)

test('OpenCode Haiku first turns, account-default replay and disabled thinking do not opt in', async () => {
  const bodies = [
    await rewrite({}, { thinkingPrefixMismatchBehavior: 'drop_block' }),
    await rewrite(
      { messages: replayedMessages },
      { thinkingPrefixMismatchBehavior: 'account-default' },
    ),
    await rewrite(
      { messages: replayedMessages, thinking: { type: 'disabled' } },
      { thinkingPrefixMismatchBehavior: 'drop_block' },
    ),
  ]
  for (const body of bodies) {
    expect(body.thinking).not.toHaveProperty('block_binding')
    const headers = setOAuthHeaders(new Headers(), 'synthetic-access-token', {
      body,
    })
    expect(headers.get('anthropic-beta')?.split(',')).not.toContain(
      THINKING_BINDING_CONTROLS_BETA,
    )
  }
})
