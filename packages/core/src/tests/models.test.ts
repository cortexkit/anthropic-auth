import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_FABLE_5_1_MODEL_ID,
  CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS,
  CLAUDE_FABLE_MYTHOS_5_1_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_1_PRICING,
  CLAUDE_MYTHOS_5_1_MODEL_ID,
  CLAUDE_OPUS_5_ADAPTIVE_THINKING,
  CLAUDE_OPUS_5_MODEL_ID,
  isClaudeFableOrMythos5Model,
  isClaudeOpus5Model,
  isClaudeSonnet5Model,
} from '../models'

describe('Claude Fable/Mythos 5.1 models', () => {
  test('exposes both 5.1 model ids and complete specs', () => {
    expect(CLAUDE_FABLE_5_1_MODEL_ID).toBe('claude-fable-5-1')
    expect(CLAUDE_MYTHOS_5_1_MODEL_ID).toBe('claude-mythos-5-1')
    expect(CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS).toEqual([
      CLAUDE_FABLE_5_1_MODEL_ID,
      CLAUDE_MYTHOS_5_1_MODEL_ID,
    ])
    expect(CLAUDE_FABLE_MYTHOS_5_1_MODEL_SPECS).toMatchObject({
      [CLAUDE_FABLE_5_1_MODEL_ID]: {
        id: CLAUDE_FABLE_5_1_MODEL_ID,
        name: 'Claude Fable 5.1',
      },
      [CLAUDE_MYTHOS_5_1_MODEL_ID]: {
        id: CLAUDE_MYTHOS_5_1_MODEL_ID,
        name: 'Claude Mythos 5.1',
        limited: true,
      },
    })
    expect(CLAUDE_FABLE_MYTHOS_5_1_PRICING).toEqual({
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
    })
  })

  test('normalizes exact ids and dated snapshots as Fable/Mythos 5 models', () => {
    for (const model of [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-fable-5-20260608',
      'claude-mythos-5-20260608',
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5-1-20260701',
      'claude-mythos-5-1-20260701',
    ]) {
      expect(isClaudeFableOrMythos5Model(model)).toBe(true)
    }
  })
})

describe('isClaudeSonnet5Model', () => {
  test('matches the bare claude-sonnet-5 id', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5')).toBe(true)
  })

  test('matches a dated claude-sonnet-5 snapshot', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5-20260630')).toBe(true)
  })

  test('does not match claude-sonnet-4-6', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-4-6')).toBe(false)
  })

  test('does not match the Fable/Mythos ids', () => {
    expect(isClaudeSonnet5Model('claude-fable-5')).toBe(false)
    expect(isClaudeSonnet5Model('claude-mythos-5')).toBe(false)
  })

  test('does not match a non-dash prefix collision', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5x')).toBe(false)
  })

  test('does not match non-string input', () => {
    expect(isClaudeSonnet5Model(undefined)).toBe(false)
    expect(isClaudeSonnet5Model(42)).toBe(false)
  })
})

describe('isClaudeOpus5Model', () => {
  test('exposes the bare id constant', () => {
    expect(CLAUDE_OPUS_5_MODEL_ID).toBe('claude-opus-5')
  })

  test('matches the bare claude-opus-5 id', () => {
    expect(isClaudeOpus5Model('claude-opus-5')).toBe(true)
  })

  test('matches the catalog claude-opus-5-fast variant', () => {
    expect(isClaudeOpus5Model('claude-opus-5-fast')).toBe(true)
  })

  test('matches a dated claude-opus-5 snapshot', () => {
    expect(isClaudeOpus5Model('claude-opus-5-20260701')).toBe(true)
  })

  test('matches the dated fast snapshot', () => {
    expect(isClaudeOpus5Model('claude-opus-5-fast-20260701')).toBe(true)
  })

  test('does not match claude-opus-4-8', () => {
    expect(isClaudeOpus5Model('claude-opus-4-8')).toBe(false)
  })

  test('does not match a non-dash prefix collision', () => {
    expect(isClaudeOpus5Model('claude-opus-5x')).toBe(false)
  })

  test('does not match the Fable/Mythos ids', () => {
    expect(isClaudeOpus5Model('claude-fable-5')).toBe(false)
    expect(isClaudeOpus5Model('claude-mythos-5')).toBe(false)
  })

  test('does not match Sonnet 5', () => {
    expect(isClaudeOpus5Model('claude-sonnet-5')).toBe(false)
  })

  test('does not match non-string input', () => {
    expect(isClaudeOpus5Model(undefined)).toBe(false)
    expect(isClaudeOpus5Model(42)).toBe(false)
    expect(isClaudeOpus5Model(null)).toBe(false)
    expect(isClaudeOpus5Model({})).toBe(false)
  })
})

describe('CLAUDE_OPUS_5_ADAPTIVE_THINKING', () => {
  test('matches the shared adaptive+summarized shape (alias of Fable/Mythos)', () => {
    expect(CLAUDE_OPUS_5_ADAPTIVE_THINKING).toEqual({
      type: 'adaptive',
      display: 'summarized',
    })
  })
})
