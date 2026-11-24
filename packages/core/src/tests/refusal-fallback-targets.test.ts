import { describe, expect, test } from 'bun:test'
import { applyMidConversationOutputConfig } from '../mid-conversation-output-config.ts'
import {
  CLAUDE_MODEL_CAPABILITIES,
  resolveClaudeModelTokenLimits,
} from '../model-capabilities.ts'
import {
  fitRefusalFallbackTarget,
  foldRefusalFallbackEffort,
  getRefusalFallbackRoute,
  isRefusalFallbackBodyValid,
  selectRefusalFallbackTarget,
} from '../refusal-fallback-targets.ts'

const opus48 = 'claude-opus-4-8'
const opus5 = 'claude-opus-5'
const opus55 = 'claude-opus-5-5'
const fable52 = 'claude-fable-5-2'
const fable = ['claude-fable-5', 'claude-fable-5-1', fable52]

const expectedRoutes = {
  ...Object.fromEntries(
    fable.map(
      (id) => [id, { bio: [opus5, opus48], cyber: [opus48, opus5] }] as const,
    ),
  ),
  [opus5]: { bio: [opus48], cyber: [opus48] },
  [opus55]: { bio: [opus48, opus5], cyber: [opus48, opus5] },
}

test('only the seeded source models and exact categories have cited routes', () => {
  const actualRoutes = Object.fromEntries(
    CLAUDE_MODEL_CAPABILITIES.flatMap(({ id, refusalFallbacks }) => {
      if (!refusalFallbacks) return []
      return [
        [
          id,
          Object.fromEntries(
            refusalFallbacks.map(({ category, targets }) => [
              category,
              targets,
            ]),
          ),
        ] as const,
      ]
    }),
  )
  expect(actualRoutes).toEqual(expectedRoutes)
  for (const [id, categories] of Object.entries(expectedRoutes)) {
    for (const [category, targets] of Object.entries(categories)) {
      const route = getRefusalFallbackRoute(id, category)
      expect(route?.targets).toEqual(targets)
      expect(route?.source).toContain('head capture 24 Nov 2026')
      expect(route?.source).toContain('allowed_fallback_models (23 Nov 2026)')
    }
  }
  expect(getRefusalFallbackRoute(fable52, 'bio')?.source).toContain(
    'https://www.anthropic.com/news/improving-fable-5-s-biology-safeguards',
  )
  expect(getRefusalFallbackRoute(opus5, 'cyber')?.source).toContain(
    'https://www.anthropic.com/news/claude-opus-5',
  )
  expect(
    getRefusalFallbackRoute(`${fable52}-20261109[1m]`, 'bio')?.targets,
  ).toEqual([opus5, opus48])
})

test.each([
  ...fable,
  opus48,
  opus5,
  opus55,
  'claude-sonnet-5',
  'claude-sonnet-5-5',
])('%s has a one-million-token window and a 128k output cap', (model) => {
  expect(resolveClaudeModelTokenLimits(model)).toMatchObject({
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
  })
})

const user = (content: string) => ({ role: 'user', content })
const marker = (effort: string) => ({
  role: 'system',
  content: [],
  output_config: { effort },
})

describe('effort markers', () => {
  const body = { messages: [marker('high'), user('next')] }

  test.each([opus48, 'claude-sonnet-5', 'unknown'])(
    '%s rejects markers, even with adaptive thinking',
    (model) => {
      expect(
        isRefusalFallbackBodyValid(model, {
          ...body,
          thinking: { type: 'adaptive' },
        }),
      ).toBe(false)
      expect(
        isRefusalFallbackBodyValid(model, {
          ...body,
          messages: [user('next')],
          output_config: { effort: 'high' },
        }),
      ).toBe(true)
    },
  )

  test.each([opus5, opus55])(
    '%s accepts markers only with adaptive thinking',
    (model) => {
      for (const type of ['disabled', 'enabled', 'between_tools', undefined]) {
        expect(
          isRefusalFallbackBodyValid(model, {
            ...body,
            thinking: type ? { type } : undefined,
          }),
        ).toBe(false)
      }
      expect(
        isRefusalFallbackBodyValid(model, {
          ...body,
          thinking: { type: 'adaptive' },
        }),
      ).toBe(true)
    },
  )

  test('an always model accepts markers in any mode regardless of other thinking capabilities', () => {
    expect(
      isRefusalFallbackBodyValid(fable52, {
        ...body,
        thinking: { type: 'disabled' },
      }),
    ).toBe(true)
    expect(isRefusalFallbackBodyValid(fable52, body)).toBe(true)
  })

  test('folds markers from the source shaper and ignores a marker after the newest user message', () => {
    const note = { role: 'system', content: 'turn note', clear_at: 'turn_end' }
    const messages = [
      user('first'),
      { role: 'assistant', content: 'answer' },
      note,
      user('second'),
    ]
    const request = {
      model: fable52,
      messages: [...messages] as unknown[],
      output_config: { format: { type: 'json_schema' } },
    }
    expect(
      applyMidConversationOutputConfig(request, [
        { afterAssistantMessages: 0, effort: 'low' },
        { afterAssistantMessages: 1, effort: 'high' },
      ]).inserted,
    ).toBe(1)
    request.messages.unshift(marker('medium'))
    request.messages.push(marker('max'))
    const original = structuredClone(request)

    const folded = foldRefusalFallbackEffort(fable52, request)
    expect(folded).toEqual({
      ...request,
      messages,
      output_config: { effort: 'high', format: { type: 'json_schema' } },
    })
    expect(isRefusalFallbackBodyValid(opus48, folded)).toBe(true)
    expect(request).toEqual(original)
  })

  test('folding preserves non-effort fields and includes a marker on the newest user message', () => {
    const format = { type: 'json_schema' }
    const next = { ...user('next'), output_config: { effort: 'low', format } }
    const previous = {
      role: 'system',
      content: 'keep this note',
      output_config: { effort: 'high' },
    }
    expect(
      foldRefusalFallbackEffort(fable52, { messages: [previous, next] }),
    ).toEqual({
      messages: [
        { role: 'system', content: 'keep this note' },
        { ...user('next'), output_config: { format } },
      ],
      output_config: { effort: 'low' },
    })
  })

  test('falls back to the top-level effort, then the provided source model default', () => {
    const request = { model: opus48, messages: [user('first'), marker('max')] }
    expect(
      foldRefusalFallbackEffort(fable52, {
        ...request,
        output_config: { effort: 'low' },
      }),
    ).toMatchObject({
      messages: [user('first')],
      output_config: { effort: 'low' },
    })
    expect(foldRefusalFallbackEffort(fable52, request)).toMatchObject({
      messages: [user('first')],
      output_config: { effort: 'medium' },
    })
  })
})

describe('fallback target selection', () => {
  const base = {
    sourceModel: fable52,
    category: 'cyber',
    body: { max_tokens: 200_000 },
    refusedUsage: {
      input_tokens: 10_000,
      cache_read_input_tokens: 600_000,
      cache_creation_input_tokens: 30_000,
    },
  }

  test('chooses Opus 4.8 in row order on a 640k conversation and clamps output', () => {
    expect(selectRefusalFallbackTarget(base)).toEqual({
      kind: 'target',
      model: opus48,
      maxTokens: 128_000,
    })
    expect(selectRefusalFallbackTarget({ ...base, category: 'bio' })).toEqual({
      kind: 'target',
      model: opus5,
      maxTokens: 128_000,
    })
  })

  test('skips the first target when it cannot accept adaptive effort markers', () => {
    expect(
      selectRefusalFallbackTarget({
        ...base,
        body: {
          ...base.body,
          thinking: { type: 'adaptive' },
          messages: [marker('high'), user('next')],
        },
      }),
    ).toEqual({ kind: 'target', model: opus5, maxTokens: 128_000 })
  })

  test('advances to the next unchanged target after a wrong-model rejection', () => {
    expect(
      selectRefusalFallbackTarget({ ...base, triedTargets: new Set([opus48]) }),
    ).toEqual({
      kind: 'target',
      model: opus5,
      maxTokens: 128_000,
    })
    expect(
      selectRefusalFallbackTarget({
        ...base,
        triedTargets: new Set([opus48, opus5]),
      }),
    ).toEqual({
      kind: 'none',
      reason: 'no-fitting-target',
    })
  })

  test('folded phase picks the first fitting target not already tried', () => {
    const request = {
      ...base,
      body: {
        ...base.body,
        messages: [marker('high'), user('next')],
        thinking: { type: 'enabled' },
      },
    }
    expect(selectRefusalFallbackTarget(request)).toEqual({
      kind: 'none',
      reason: 'no-fitting-target',
    })
    expect(
      selectRefusalFallbackTarget({ ...request, phase: 'folded' }),
    ).toEqual({ kind: 'target', model: opus48, maxTokens: 128_000 })
    expect(
      selectRefusalFallbackTarget({
        ...request,
        phase: 'folded',
        category: 'bio',
      }),
    ).toEqual({ kind: 'target', model: opus5, maxTokens: 128_000 })
    expect(
      selectRefusalFallbackTarget({
        ...request,
        phase: 'folded',
        category: 'bio',
        triedTargets: new Set([opus5]),
      }),
    ).toEqual({ kind: 'target', model: opus48, maxTokens: 128_000 })
    expect(
      selectRefusalFallbackTarget({
        ...request,
        phase: 'folded',
        triedTargets: new Set([opus48, opus5]),
      }),
    ).toEqual({ kind: 'none', reason: 'no-fitting-target' })
  })

  test('allows the Opus 5 folded retry on Opus 4.8 but never folds without markers', () => {
    const request = { ...base, sourceModel: opus5 }
    expect(
      selectRefusalFallbackTarget({ ...request, phase: 'folded' }),
    ).toEqual({ kind: 'none', reason: 'no-effort-markers' })
    expect(
      selectRefusalFallbackTarget({
        ...request,
        body: { ...request.body, messages: [marker('high'), user('next')] },
        phase: 'folded',
      }),
    ).toEqual({ kind: 'target', model: opus48, maxTokens: 128_000 })
  })

  test('compares thinking budget to the clamp in both phases', () => {
    const request = { ...base, sourceModel: opus5 }
    for (const phase of ['unchanged', 'folded'] as const) {
      expect(
        selectRefusalFallbackTarget({
          ...request,
          body: {
            ...request.body,
            ...(phase === 'folded' && {
              messages: [marker('high'), user('next')],
            }),
            thinking: { budget_tokens: 128_000 },
          },
          phase,
        }),
      ).toEqual({ kind: 'none', reason: 'no-fitting-target' })
    }
    expect(
      fitRefusalFallbackTarget(
        opus48,
        { max_tokens: 1000, thinking: { budget_tokens: 999 } },
        999_000,
      ),
    ).toBe(1000)
  })

  test('uses all three measured input counters and fits at the exact boundary', () => {
    const atBoundary = {
      input_tokens: 10_000,
      cache_read_input_tokens: 820_000,
      cache_creation_input_tokens: 42_000,
    }
    expect(
      selectRefusalFallbackTarget({ ...base, refusedUsage: atBoundary }),
    ).toEqual({
      kind: 'target',
      model: opus48,
      maxTokens: 128_000,
    })
    expect(
      selectRefusalFallbackTarget({
        ...base,
        refusedUsage: { ...atBoundary, cache_creation_input_tokens: 42_001 },
      }),
    ).toEqual({
      kind: 'none',
      reason: 'no-fitting-target',
    })
  })

  test('selects nothing without refused input usage', () => {
    for (const refusedUsage of [undefined, null, {}, { output_tokens: 50 }]) {
      expect(selectRefusalFallbackTarget({ ...base, refusedUsage })).toEqual({
        kind: 'none',
        reason: 'no-usage',
      })
    }
    expect(
      selectRefusalFallbackTarget({
        ...base,
        refusedUsage: { input_tokens: 0 },
      }).kind,
    ).toBe('target')
  })

  test('selects nothing for missing, unknown or unseeded categories and sources', () => {
    for (const category of [
      undefined,
      'reasoning_extraction',
      'biology',
      'cybersecurity',
      'Cyber',
      'unknown',
      '__proto__',
    ]) {
      expect(selectRefusalFallbackTarget({ ...base, category })).toEqual({
        kind: 'none',
        reason: 'no-row',
      })
    }
    for (const sourceModel of [
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      opus48,
      'unknown',
    ]) {
      expect(selectRefusalFallbackTarget({ ...base, sourceModel })).toEqual({
        kind: 'none',
        reason: 'no-row',
      })
    }
  })
})
