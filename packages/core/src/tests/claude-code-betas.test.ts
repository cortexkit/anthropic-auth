import { expect, test } from 'bun:test'
import {
  applyClaudeCodeHeaders,
  selectClaudeCodeBetas,
} from '../claude-code.ts'

// Literal beta lists from recorded interactive Claude Code 2.1.302 requests,
// not computed by the selector under test. They include display-updates while
// our bodies keep summarized thinking so that thinking text still streams.
const MAIN =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01,thinking-display-updates-2026-08-18,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const OPUS48_MAIN =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01,thinking-display-updates-2026-08-18,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const HAIKU55_MAIN =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,thinking-binding-controls-2026-08-01,thinking-display-updates-2026-08-18,extended-cache-ttl-2025-04-11,cache-diagnosis-2026-04-07'
const TITLE =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,mid-conversation-system-clear-at-2026-08-21,effort-2025-11-24,structured-outputs-2025-12-15,cache-diagnosis-2026-04-07'
const QUOTA =
  'oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05'

for (const [model, expected] of [
  ['claude-sonnet-5-5', MAIN],
  ['claude-opus-5-5', MAIN],
  ['claude-fable-5-1', MAIN],
  ['claude-haiku-5-5', HAIKU55_MAIN],
  ['claude-opus-4-8', OPUS48_MAIN],
] as const) {
  test(`${model} main betas match the capture without changing the body`, () => {
    const body = {
      model,
      max_tokens: 16,
      thinking: { type: 'adaptive', display: 'summarized' },
      messages: [{ role: 'user', content: 'ok' }],
    }
    const before = JSON.stringify(body)
    const headers = applyClaudeCodeHeaders(new Headers(), 'test-token', {
      body,
    })
    expect(headers.get('anthropic-beta')).toBe(expected)
    expect(headers.get('x-claude-code-request-class')).toBe('main')
    expect(JSON.stringify(body)).toBe(before)
    expect('block_binding' in body.thinking).toBe(false)
  })
}

test('Haiku 5.5 auxiliary structured title betas match the capture', () => {
  const body = {
    model: 'claude-haiku-5-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'title' }],
    output_config: { format: { type: 'json_schema' } },
  }
  const before = JSON.stringify(body)
  const headers = applyClaudeCodeHeaders(new Headers(), 'test-token', {
    body,
    requestClass: 'auxiliary',
  })
  expect(headers.get('anthropic-beta')).toBe(TITLE)
  expect(headers.get('x-claude-code-request-class')).toBe('auxiliary')
  expect(JSON.stringify(body)).toBe(before)
})

test('Haiku 4.5 auxiliary one-token quota betas match the capture', () => {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [{ role: 'user', content: '0' }],
    metadata: { user_id: 'test' },
  }
  const before = JSON.stringify(body)
  const headers = applyClaudeCodeHeaders(new Headers(), 'test-token', {
    body,
    requestClass: 'auxiliary',
  })
  expect(headers.get('anthropic-beta')).toBe(QUOTA)
  expect(headers.get('x-claude-code-request-class')).toBe('auxiliary')
  expect(JSON.stringify(body)).toBe(before)
  expect(selectClaudeCodeBetas(body)).toBe(OPUS48_MAIN)
})

test('auxiliary summaries use title betas without requesting structured output', () => {
  expect(
    selectClaudeCodeBetas({ model: 'claude-haiku-5-5' }, [], 'auxiliary'),
  ).toBe(TITLE.replace(',structured-outputs-2025-12-15', ''))
  expect(
    selectClaudeCodeBetas(
      {
        model: 'claude-haiku-5-5',
        max_tokens: 1,
        stream: true,
      },
      [],
      'auxiliary',
    ),
  ).toBe(TITLE.replace(',structured-outputs-2025-12-15', ''))
})

test('auxiliary thinking block binding carries its beta without changing ordinary betas', () => {
  const body = {
    model: 'claude-fable-5-2',
    max_tokens: 0,
    thinking: { type: 'adaptive', display: 'summarized' },
    messages: [{ role: 'user', content: 'keep warm' }],
  }
  const ordinaryBetas = TITLE.replace(',structured-outputs-2025-12-15', '')
  expect(selectClaudeCodeBetas(body, [], 'auxiliary')).toBe(ordinaryBetas)

  for (const behavior of ['error', 'drop_block']) {
    const boundBody = {
      ...body,
      thinking: {
        ...body.thinking,
        block_binding: { prefix_mismatch_behavior: behavior },
      },
    }
    const before = JSON.stringify(boundBody)
    expect(selectClaudeCodeBetas(boundBody, [], 'auxiliary')).toBe(
      `${ordinaryBetas},thinking-binding-controls-2026-08-01`,
    )
    expect(JSON.stringify(boundBody)).toBe(before)
    expect(
      selectClaudeCodeBetas(boundBody)
        .split(',')
        .filter((beta) => beta === 'thinking-binding-controls-2026-08-01'),
    ).toHaveLength(1)
  }
})

test('main feature betas retain their positions without changing binding fields', () => {
  const body = {
    model: 'claude-opus-4-8',
    speed: 'fast',
    output_config: { format: { type: 'json_schema' } },
  }
  const before = JSON.stringify(body)
  const betas = selectClaudeCodeBetas(body, [
    'context-1m-2025-08-07',
    'server-side-fallback-2026-07-01',
  ])
  expect(betas).toBe(
    OPUS48_MAIN.replace(
      ',cache-diagnosis-2026-04-07',
      ',structured-outputs-2025-12-15,cache-diagnosis-2026-04-07',
    ) +
      ',fast-mode-2026-02-01,context-1m-2025-08-07,server-side-fallback-2026-07-01',
  )
  expect(JSON.stringify(body)).toBe(before)
})
