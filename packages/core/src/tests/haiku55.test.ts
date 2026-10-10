import { expect, test } from 'bun:test'
import { isFastModeSupportedModel } from '../constants.ts'
import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_HAIKU_4_5_PRICING,
  CLAUDE_HAIKU_5_5_ADAPTIVE_THINKING,
  CLAUDE_HAIKU_5_5_CONTEXT_WINDOW,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
  CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_HAIKU_5_5_PRICING,
  CLAUDE_HAIKU_5_5_RELEASE_DATE,
  isClaudeHaiku55Model,
} from '../models.ts'

test('Haiku 5.5 publishes its own limits and does not replace the Prime model', () => {
  expect(CLAUDE_HAIKU_5_5_MODEL_ID).toBe('claude-haiku-5-5')
  expect(CLAUDE_HAIKU_5_5_RELEASE_DATE).toBe('2026-10-07')
  expect(CLAUDE_HAIKU_5_5_CONTEXT_WINDOW).toBe(1_000_000)
  expect(CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS).toBe(128_000)
  expect(CLAUDE_HAIKU_5_5_ADAPTIVE_THINKING).toEqual({
    type: 'adaptive',
    display: 'summarized',
  })
  expect(CLAUDE_HAIKU_4_5_MODEL_ID).toBe('claude-haiku-4-5')
  expect(CLAUDE_HAIKU_4_5_PRICING).toEqual({ input: 1, output: 5 })
})

test.each([
  'claude-haiku-5-5',
  'claude-haiku-5-5[1m]',
  'claude-haiku-5-5-20261007',
  'claude-haiku-5-5-20261007[1m]',
])('Haiku 5.5 identifies %s without enabling fast mode', (model) => {
  expect(isClaudeHaiku55Model(model)).toBe(true)
  expect(isFastModeSupportedModel(model)).toBe(false)
})

test.each([
  'claude-haiku-4-5',
  'claude-haiku-5',
  'claude-haiku-5-50',
  'claude-haiku-5-5-other',
  'claude-sonnet-5-5',
  undefined,
  5,
])('Haiku 5.5 rejects the neighboring model %s', (model) =>
  expect(isClaudeHaiku55Model(model)).toBe(false),
)

test('Haiku 5.5 publishes both rate sets and the exact 100K threshold', () => {
  expect(CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD).toBe(100_000)
  expect(CLAUDE_HAIKU_5_5_PRICING).toEqual({
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
  })
  expect(CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING).toEqual({
    input: 0.5,
    output: 2.5,
    cacheRead: 0.05,
    cacheWrite5m: 0.625,
    cacheWrite1h: 1,
  })
})
