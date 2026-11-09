import { describe, expect, test } from 'bun:test'
import * as models from '../models'

import {
  CLAUDE_FABLE_5_1_MODEL_ID,
  CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS,
  CLAUDE_FABLE_MYTHOS_5_1_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_1_PRICING,
  CLAUDE_FABLE_MYTHOS_5_1_RELEASE_DATE,
  CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE,
  CLAUDE_MYTHOS_5_1_MODEL_ID,
  CLAUDE_OPUS_5_5_ADAPTIVE_THINKING,
  CLAUDE_OPUS_5_5_CONTEXT_WINDOW,
  CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_PRICING,
  CLAUDE_OPUS_5_ADAPTIVE_THINKING,
  CLAUDE_OPUS_5_MODEL_ID,
  CLAUDE_SONNET_5_5_ADAPTIVE_THINKING,
  CLAUDE_SONNET_5_5_CONTEXT_WINDOW,
  CLAUDE_SONNET_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_SONNET_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_PRICING,
  CLAUDE_SONNET_5_5_RELEASE_DATE,
  getClaudeFableMythos5ReleaseDate,
  isClaudeFable51Model,
  isClaudeFableOrMythos5Model,
  isClaudeOpus5FamilyModel,
  isClaudeOpus5Model,
  isClaudeOpus55Model,
  isClaudeSonnet5Model,
  isClaudeSonnet55Model,
  normalizeAnthropicModelId,
} from '../models'

test('Fable 5.2 has independent pricing, registration and release date aliases', () => {
  expect(models.CLAUDE_FABLE_5_2_MODEL_ID).toBe('claude-fable-5-2')
  expect(models.CLAUDE_FABLE_5_2_PRICING).toEqual({
    input: 8,
    output: 40,
    cacheRead: 0.2,
    cacheWrite5m: 10,
    cacheWrite1h: 16,
  })
  expect(models.CLAUDE_FABLE_5_2_PRICING).not.toBe(
    models.CLAUDE_FABLE_MYTHOS_5_1_PRICING,
  )
  expect(models.CLAUDE_FABLE_5_2_RELEASE_DATE).toBe('2026-11-09')
  expect(models.CLAUDE_FABLE_MYTHOS_5_MODEL_IDS).toContain('claude-fable-5-2')
  expect(
    models.getClaudeFableMythos5ReleaseDate('claude-fable-5-2-20261109[1m]'),
  ).toBe('2026-11-09')
  expect(models.isClaudeFable51Model('claude-fable-5-2')).toBe(false)
})

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
    expect(CLAUDE_FABLE_MYTHOS_5_1_RELEASE_DATE).toBe('2026-09-01')
    expect(CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE).toBe('2026-06-09')
    expect(getClaudeFableMythos5ReleaseDate('claude-fable-5-1')).toBe(
      '2026-09-01',
    )
    expect(getClaudeFableMythos5ReleaseDate('claude-mythos-5')).toBe(
      '2026-06-09',
    )
    expect(normalizeAnthropicModelId('claude-fable-5-1[1m]')).toBe(
      'claude-fable-5-1',
    )
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
      'claude-fable-5[1m]',
      'claude-mythos-5-1[1m]',
    ]) {
      expect(isClaudeFableOrMythos5Model(model)).toBe(true)
    }
  })
})

describe('isClaudeFable51Model', () => {
  test('matches exact and dated Fable 5.1 ids only', () => {
    expect(isClaudeFable51Model('claude-fable-5-1')).toBe(true)
    expect(isClaudeFable51Model('claude-fable-5-1-20260830')).toBe(true)
    expect(isClaudeFable51Model('claude-fable-5-1[1m]')).toBe(true)
    expect(isClaudeFable51Model('claude-mythos-5-1')).toBe(false)
    expect(isClaudeFable51Model('claude-fable-5')).toBe(false)
    expect(isClaudeFable51Model('claude-mythos-5')).toBe(false)
    expect(isClaudeFable51Model('claude-fable-5-1x')).toBe(false)
    expect(isClaudeFable51Model(42)).toBe(false)
  })
})

describe('isClaudeSonnet5Model', () => {
  test('matches the bare claude-sonnet-5 id', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5')).toBe(true)
    expect(isClaudeSonnet5Model('claude-sonnet-5[1m]')).toBe(true)
  })

  test('matches a dated claude-sonnet-5 snapshot', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5-20260630')).toBe(true)
  })

  test('does not match claude-sonnet-4-6', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-4-6')).toBe(false)
  })

  test('does not match Sonnet 5.5 despite sharing the Sonnet 5 prefix', () => {
    expect(isClaudeSonnet5Model('claude-sonnet-5-5')).toBe(false)
    expect(isClaudeSonnet5Model('claude-sonnet-5-5[1m]')).toBe(false)
    expect(isClaudeSonnet5Model('claude-sonnet-5-5-20260928')).toBe(false)
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

describe('Claude Sonnet 5.5 model', () => {
  test('uses Anthropic model metadata and actual API prices', () => {
    expect(CLAUDE_SONNET_5_5_MODEL_ID).toBe('claude-sonnet-5-5')
    expect(CLAUDE_SONNET_5_5_RELEASE_DATE).toBe('2026-09-28')
    expect(CLAUDE_SONNET_5_5_CONTEXT_WINDOW).toBe(1_000_000)
    expect(CLAUDE_SONNET_5_5_MAX_OUTPUT_TOKENS).toBe(128_000)
    expect(CLAUDE_SONNET_5_5_PRICING).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite5m: 2.5,
      cacheWrite1h: 4,
    })
    expect(CLAUDE_SONNET_5_5_ADAPTIVE_THINKING).toEqual({
      type: 'adaptive',
      display: 'summarized',
    })
  })

  test('recognizes exact, context-qualified, and dated model IDs only', () => {
    for (const model of [
      'claude-sonnet-5-5',
      'claude-sonnet-5-5[1m]',
      'claude-sonnet-5-5-20260928',
    ]) {
      expect(isClaudeSonnet55Model(model)).toBe(true)
      expect(isClaudeSonnet5Model(model)).toBe(false)
    }
    for (const model of [
      'claude-sonnet-5',
      'claude-sonnet-5-20260630',
      'claude-opus-5-5',
      'claude-sonnet-5-50',
      null,
    ]) {
      expect(isClaudeSonnet55Model(model)).toBe(false)
    }
  })
})

describe('isClaudeOpus5Model', () => {
  test('exposes the bare id constant', () => {
    expect(CLAUDE_OPUS_5_MODEL_ID).toBe('claude-opus-5')
  })

  test('matches the bare claude-opus-5 id', () => {
    expect(isClaudeOpus5Model('claude-opus-5')).toBe(true)
    expect(isClaudeOpus5Model('claude-opus-5[1m]')).toBe(true)
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

  test('does not match claude-opus-5-5 (isolated models)', () => {
    expect(isClaudeOpus5Model('claude-opus-5-5')).toBe(false)
    expect(isClaudeOpus5Model('claude-opus-5-5-20260918')).toBe(false)
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

describe('Claude Opus 5.5 model', () => {
  test('exposes Opus 5.5 model specifications and pricing', () => {
    expect(CLAUDE_OPUS_5_5_MODEL_ID).toBe('claude-opus-5-5')
    expect(CLAUDE_OPUS_5_5_CONTEXT_WINDOW).toBe(1_000_000)
    expect(CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS).toBe(128_000)
    expect(CLAUDE_OPUS_5_5_PRICING).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
    })
    expect(CLAUDE_OPUS_5_5_ADAPTIVE_THINKING).toEqual({
      type: 'adaptive',
      display: 'summarized',
    })
  })

  test('matches the bare claude-opus-5-5 id', () => {
    expect(isClaudeOpus55Model('claude-opus-5-5')).toBe(true)
    expect(isClaudeOpus55Model('claude-opus-5-5[1m]')).toBe(true)
  })

  test('matches a dated claude-opus-5-5 snapshot', () => {
    expect(isClaudeOpus55Model('claude-opus-5-5-20260918')).toBe(true)
  })

  test('does not match claude-opus-5 or older models', () => {
    expect(isClaudeOpus55Model('claude-opus-5')).toBe(false)
    expect(isClaudeOpus55Model('claude-opus-5-20260701')).toBe(false)
    expect(isClaudeOpus55Model('claude-opus-4-8')).toBe(false)
    expect(isClaudeOpus55Model('claude-sonnet-5')).toBe(false)
  })

  test('isClaudeOpus5FamilyModel matches both Opus 5 and Opus 5.5', () => {
    expect(isClaudeOpus5FamilyModel('claude-opus-5')).toBe(true)
    expect(isClaudeOpus5FamilyModel('claude-opus-5-5')).toBe(true)
    expect(isClaudeOpus5FamilyModel('claude-opus-5-5-20260918')).toBe(true)
    expect(isClaudeOpus5FamilyModel('claude-opus-4-8')).toBe(false)
  })
})
