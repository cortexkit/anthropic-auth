import { describe, expect, test } from 'bun:test'
import {
  applyThinkingBindingControls,
  getThinkingPrefixMismatchBehavior,
  hasReplayableThinkingBlocks,
  hasThinkingBindingControls,
} from '../thinking-binding.ts'

const bodyWith = (model: string, block?: Record<string, unknown>) => ({
  model,
  thinking: { type: 'adaptive', display: 'summarized' } as {
    type: string
    display: string
    block_binding?: { prefix_mismatch_behavior: string }
  },
  messages: [
    { role: 'user', content: 'summary' },
    ...(block
      ? [
          {
            role: 'assistant',
            content: [block, { type: 'text', text: 'answer' }],
          },
          { role: 'user', content: 'continue' },
        ]
      : []),
  ],
})

describe('Fable 5.1 thinking binding controls', () => {
  test('does nothing when no replayable thinking block exists', () => {
    const body = bodyWith('claude-fable-5-1')

    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
    expect(hasThinkingBindingControls(body)).toBe(false)
  })

  test('leaves replay behavior to the account by default', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'signature',
    })

    expect(hasReplayableThinkingBlocks(body)).toBe(true)
    expect(applyThinkingBindingControls(body, 'account-default')).toBe(false)
    expect(body.thinking.block_binding).toBeUndefined()
    expect(hasThinkingBindingControls(body)).toBe(false)
  })

  test('adds an explicit drop_block override for signed history', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'signature',
    })

    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(true)
    expect(body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'drop_block',
    })
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('adds an explicit error override for prefix-mismatch testing', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'thinking',
      thinking: 'reasoning',
      signature: 'signature',
    })

    expect(applyThinkingBindingControls(body, 'error')).toBe(true)
    expect(body.thinking.block_binding).toEqual({
      prefix_mismatch_behavior: 'error',
    })
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('recognizes redacted Fable 5.1 thinking history', () => {
    const body = bodyWith('claude-fable-5-1', {
      type: 'redacted_thinking',
      data: 'redacted-payload',
    })

    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(true)
    expect(hasThinkingBindingControls(body)).toBe(true)
  })

  test('does not apply Fable prefix controls to Mythos 5.1 or older models', () => {
    for (const model of ['claude-mythos-5-1', 'claude-fable-5']) {
      const body = bodyWith(model, {
        type: 'thinking',
        thinking: 'reasoning',
        signature: 'signature',
      })
      expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
      expect(hasThinkingBindingControls(body)).toBe(false)
    }
  })

  test('reads only explicit persisted behavior values', () => {
    expect(getThinkingPrefixMismatchBehavior({})).toBe('account-default')
    expect(
      getThinkingPrefixMismatchBehavior({
        thinkingBinding: { prefixMismatchBehavior: 'error' },
      }),
    ).toBe('error')
    expect(
      getThinkingPrefixMismatchBehavior({
        thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
      }),
    ).toBe('drop_block')
    expect(
      getThinkingPrefixMismatchBehavior({
        thinkingBinding: { prefixMismatchBehavior: 'invalid' as never },
      }),
    ).toBe('account-default')
  })
})

describe('Sonnet 5.5 thinking binding controls', () => {
  test('only explicit behavior with replayed thinking on adaptive requests adds the control', () => {
    for (const block of [
      { type: 'thinking', thinking: '', signature: 'signed' },
      { type: 'redacted_thinking', data: 'redacted-payload' },
    ]) {
      const body = bodyWith('claude-sonnet-5-5[1m]', block)
      expect(applyThinkingBindingControls(body, 'account-default')).toBe(false)
      expect(body.thinking.block_binding).toBeUndefined()
      expect(applyThinkingBindingControls(body, 'drop_block')).toBe(true)
      expect(body.thinking.block_binding).toEqual({
        prefix_mismatch_behavior: 'drop_block',
      })
    }
  })

  test('never puts block_binding on between_tools', () => {
    const body = bodyWith('claude-sonnet-5-5', {
      type: 'thinking',
      thinking: '',
      signature: 'signed',
    })
    body.thinking.type = 'between_tools'
    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
    expect(body.thinking.block_binding).toBeUndefined()
  })

  test('does not apply Sonnet 5.5 controls to Sonnet 5', () => {
    const body = bodyWith('claude-sonnet-5', {
      type: 'thinking',
      thinking: '',
      signature: 'signed',
    })
    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
  })
})

test('Opus 5.5 uses the same explicit adaptive-thinking prefix control', () => {
  const body = bodyWith('claude-opus-5-5', {
    type: 'redacted_thinking',
    data: 'redacted-payload',
  })
  expect(applyThinkingBindingControls(body, 'error')).toBe(true)
  expect(body.thinking.block_binding).toEqual({
    prefix_mismatch_behavior: 'error',
  })
})

describe('Haiku 5.5 thinking binding controls', () => {
  test.each(['error', 'drop_block'] as const)(
    'adds %s only for replayed signed or redacted thinking',
    (behavior) => {
      for (const block of [
        { type: 'thinking', thinking: 'reason', signature: 'signed' },
        { type: 'redacted_thinking', data: 'redacted' },
      ]) {
        const body = bodyWith('claude-haiku-5-5[1m]', block)
        expect(applyThinkingBindingControls(body, behavior)).toBe(true)
        expect(body.thinking.block_binding).toEqual({
          prefix_mismatch_behavior: behavior,
        })
        expect(hasThinkingBindingControls(body)).toBe(true)
      }
    },
  )
  test('account-default leaves Haiku replay bytes unchanged', () => {
    const body = bodyWith('claude-haiku-5-5', {
      type: 'thinking',
      signature: 'signed',
      thinking: 'reason',
    })
    const before = JSON.stringify(body)
    expect(applyThinkingBindingControls(body)).toBe(false)
    expect(JSON.stringify(body)).toBe(before)
  })
  test('first Haiku turns receive no prefix control', () => {
    const body = bodyWith('claude-haiku-5-5')
    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
    expect(hasThinkingBindingControls(body)).toBe(false)
  })
  test('disabled Haiku thinking receives no unsupported block_binding field', () => {
    const body = bodyWith('claude-haiku-5-5', {
      type: 'thinking',
      signature: 'signed',
      thinking: 'reason',
    })
    body.thinking.type = 'disabled'
    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
    expect(hasThinkingBindingControls(body)).toBe(false)
  })
  test('Haiku 4.5 remains outside the prefix-control family', () => {
    const body = bodyWith('claude-haiku-4-5', {
      type: 'thinking',
      signature: 'signed',
      thinking: 'reason',
    })
    expect(applyThinkingBindingControls(body, 'drop_block')).toBe(false)
    expect(hasThinkingBindingControls(body)).toBe(false)
  })
})
