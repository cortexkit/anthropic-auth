import { describe, expect, test } from 'bun:test'
import { selectClaudeCodeBetas } from '../claude-code.ts'
import {
  applyMidConversationOutputConfig,
  defaultAdaptiveEffort,
  normalizeAdaptiveEffort,
  PER_TURN_CONTROL_BETA,
  sendsPerTurnControlBeta,
  supportsPerMessageEffort,
  usesPerTurnControl,
} from '../mid-conversation-output-config.ts'

function body(model = 'claude-fable-5-1') {
  return {
    model,
    output_config: { effort: 'max', format: { type: 'json_schema' } },
    messages: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'third' },
    ],
  } as Record<string, unknown>
}

describe('Fable 5.1 mid-conversation output configuration', () => {
  test('anchors top-level effort to the earliest retained turn and inserts later changes', () => {
    const request = body()

    expect(
      applyMidConversationOutputConfig(request, [
        { afterAssistantMessages: 0, effort: 'low' },
        { afterAssistantMessages: 1, effort: 'high' },
        { afterAssistantMessages: 2, effort: 'max' },
      ]),
    ).toEqual({ applied: true, inserted: 2 })

    expect(request.output_config).toEqual({
      effort: 'low',
      format: { type: 'json_schema' },
    })
    expect(request.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
      {
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'two' },
      {
        role: 'system',
        content: [],
        output_config: { effort: 'max' },
      },
      { role: 'user', content: 'third' },
    ])
  })

  test('keeps a stable top-level effort when the history has no change', () => {
    const request = body()

    expect(
      applyMidConversationOutputConfig(request, [
        { afterAssistantMessages: 0, effort: 'medium' },
        { afterAssistantMessages: 1, effort: 'medium' },
        { afterAssistantMessages: 2, effort: 'medium' },
      ]),
    ).toEqual({ applied: true, inserted: 0 })
    expect(request.output_config).toMatchObject({ effort: 'medium' })
    expect((request.messages as unknown[]).length).toBe(5)
  })

  test('uses the latest effort selected before the same user boundary', () => {
    const request = body()

    applyMidConversationOutputConfig(request, [
      { afterAssistantMessages: 0, effort: 'low' },
      { afterAssistantMessages: 1, effort: 'medium' },
      { afterAssistantMessages: 1, effort: 'high' },
    ])

    expect(request.output_config).toMatchObject({ effort: 'low' })
    expect(request.messages).toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    expect(request.messages).not.toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'medium' },
    })
  })

  test('does not add Fable 5.1 controls to other models', () => {
    for (const model of [
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-8',
    ]) {
      const request = body(model)
      const before = structuredClone(request)
      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
        ]),
      ).toEqual({ applied: false, inserted: 0 })
      expect(request).toEqual(before)
      expect(sendsPerTurnControlBeta(model)).toBe(false)
    }
  })

  test('carries Fable 5.1 effort changes under per-turn control without obsolete betas', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-fable-5-1[1m]',
      'claude-fable-5-1-20260918',
    ]) {
      const request = body(model)
      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
          { afterAssistantMessages: 1, effort: 'high' },
        ]),
      ).toEqual({ applied: true, inserted: 1 })
      expect(request.messages).toContainEqual({
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      })
      expect(request.output_config).toMatchObject({ effort: 'low' })
      const betas = selectClaudeCodeBetas(request).split(',')
      expect(betas).toContain(PER_TURN_CONTROL_BETA)
      expect(betas).not.toContain('mid-conversation-output-config-2026-07-01')
      expect(betas).not.toContain('mid-conversation-system-2026-04-07')
    }
  })

  test('normalizes host effort names', () => {
    expect(normalizeAdaptiveEffort('minimal')).toBe('low')
    expect(normalizeAdaptiveEffort('xhigh')).toBe('xhigh')
    expect(normalizeAdaptiveEffort('off')).toBeUndefined()
    expect(normalizeAdaptiveEffort('unknown')).toBeUndefined()
  })
})

const PER_TURN_CONTROL_MODELS = [
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-opus-5-5[1m]',
  'claude-opus-5-5-20260918',
  'claude-sonnet-5-5',
  'claude-sonnet-5-5[1m]',
  'claude-haiku-5-5',
  'claude-haiku-5-5-20261007[1m]',
] as const

function adaptiveBody(model: string) {
  return {
    ...body(model),
    thinking: { type: 'adaptive', display: 'summarized' },
  } as Record<string, unknown>
}

describe('per-message effort beyond Fable 5.1', () => {
  for (const model of PER_TURN_CONTROL_MODELS) {
    test(`${model} keeps top-level effort at the earliest value and inserts system markers`, () => {
      const request = adaptiveBody(model)

      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
          { afterAssistantMessages: 1, effort: 'high' },
          { afterAssistantMessages: 2, effort: 'max' },
        ]),
      ).toEqual({ applied: true, inserted: 2 })
      expect(request.output_config).toEqual({
        effort: 'low',
        format: { type: 'json_schema' },
      })
      expect(request.messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'one' },
        { role: 'system', content: [], output_config: { effort: 'high' } },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'two' },
        { role: 'system', content: [], output_config: { effort: 'max' } },
        { role: 'user', content: 'third' },
      ])
    })

    test(`${model} leaves a request without an effort change byte-identical`, () => {
      for (const transitions of [
        [],
        [{ afterAssistantMessages: 0, effort: 'medium' as const }],
        [
          { afterAssistantMessages: 0, effort: 'medium' as const },
          { afterAssistantMessages: 2, effort: 'medium' as const },
        ],
      ]) {
        const request = adaptiveBody(model)
        const before = JSON.stringify(request)
        expect(applyMidConversationOutputConfig(request, transitions)).toEqual({
          applied: false,
          inserted: 0,
        })
        expect(JSON.stringify(request)).toBe(before)
      }
    })

    test(`${model} carries the per-turn control beta without obsolete betas`, () => {
      const request = adaptiveBody(model)
      expect(supportsPerMessageEffort(request)).toBe(true)
      expect(usesPerTurnControl(model)).toBe(true)
      const betas = selectClaudeCodeBetas(request).split(',')
      expect(betas).toContain(PER_TURN_CONTROL_BETA)
      expect(betas).not.toContain('mid-conversation-output-config-2026-07-01')
      expect(betas).not.toContain('mid-conversation-system-2026-04-07')
    })
  }

  test('uses no markers on models that require adaptive thinking when it is off', () => {
    for (const [model, thinking] of [
      ['claude-sonnet-5-5', { type: 'between_tools' }],
      ['claude-opus-5-5', undefined],
      ['claude-opus-5', { type: 'disabled' }],
      ['claude-haiku-5-5', { type: 'disabled' }],
      ['claude-haiku-5-5', undefined],
    ] as const) {
      const request = body(model)
      if (thinking) request.thinking = { ...thinking }
      const before = JSON.stringify(request)
      expect(supportsPerMessageEffort(request)).toBe(false)
      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
          { afterAssistantMessages: 1, effort: 'high' },
        ]),
      ).toEqual({ applied: false, inserted: 0 })
      expect(JSON.stringify(request)).toBe(before)
      // The beta follows the model, as in Claude Code, whatever the thinking mode.
      expect(selectClaudeCodeBetas(request).split(',')).toContain(
        PER_TURN_CONTROL_BETA,
      )
    }
  })

  test('keeps Fable 5.1 eligible without inspecting thinking', () => {
    const request = body()
    expect(supportsPerMessageEffort(request)).toBe(true)
    expect(usesPerTurnControl(request.model)).toBe(false)
    expect(sendsPerTurnControlBeta(request.model)).toBe(true)
    expect(selectClaudeCodeBetas(request).split(',')).toContain(
      PER_TURN_CONTROL_BETA,
    )
  })

  test.each(['claude-mythos-5-1', 'claude-mythos-5-2'])(
    '%s pins the baseline and inserts changes without inspecting thinking',
    (model) => {
      const request = body(model)
      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
        ]),
      ).toEqual({ applied: true, inserted: 0 })
      expect(request.output_config).toMatchObject({ effort: 'low' })
      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
          { afterAssistantMessages: 1, effort: 'high' },
        ]),
      ).toEqual({ applied: true, inserted: 1 })
      expect(request.output_config).toMatchObject({ effort: 'low' })
      expect(request.messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'one' },
        { role: 'system', content: [], output_config: { effort: 'high' } },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'third' },
      ])
    },
  )

  test('leaves Fable 5 and Mythos 5 requests unchanged, headers included', () => {
    for (const model of ['claude-fable-5', 'claude-mythos-5']) {
      const request = adaptiveBody(model)
      const before = JSON.stringify(request)
      const betasBefore = selectClaudeCodeBetas({
        ...structuredClone(request),
        model: 'claude-opus-4-8',
      })
      expect(supportsPerMessageEffort(request)).toBe(false)
      expect(
        applyMidConversationOutputConfig(request, [
          { afterAssistantMessages: 0, effort: 'low' },
          { afterAssistantMessages: 1, effort: 'high' },
        ]),
      ).toEqual({ applied: false, inserted: 0 })
      expect(JSON.stringify(request)).toBe(before)
      expect(selectClaudeCodeBetas(request)).toBe(betasBefore)
    }
  })

  test('does not treat other model families as per-turn control models', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-mythos-5-1',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-haiku-4-5',
      42,
    ]) {
      expect(usesPerTurnControl(model)).toBe(false)
    }
    expect(PER_TURN_CONTROL_BETA).toBe('per-turn-control-2026-07-01')
  })

  test('falls back to each model default effort', () => {
    expect(defaultAdaptiveEffort('claude-opus-5-5')).toBe('medium')
    expect(defaultAdaptiveEffort('claude-opus-5-5[1m]')).toBe('medium')
    expect(defaultAdaptiveEffort('claude-haiku-5-5')).toBe('medium')
    expect(defaultAdaptiveEffort('claude-sonnet-5-5')).toBe('high')
    expect(defaultAdaptiveEffort('claude-opus-5')).toBe('high')
    expect(defaultAdaptiveEffort('claude-fable-5-1')).toBe('high')
    expect(defaultAdaptiveEffort(undefined)).toBe('high')
  })
})
