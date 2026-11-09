import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { selectClaudeCodeBetas } from '../claude-code.ts'
import { isFastModeSupportedModel } from '../constants.ts'
import {
  applyMidConversationOutputConfig,
  defaultAdaptiveEffort,
  type MidConversationEffortTransition,
  sendsPerTurnControlBeta,
  supportsPerMessageEffort,
  usesPerTurnControl,
} from '../mid-conversation-output-config.ts'
import * as models from '../models.ts'
import { nativeQuotaModelScope } from '../native-quota-codec.ts'
import { stickyRouteFamilyForModel } from '../sticky-routing.ts'
import { applyThinkingBindingControls } from '../thinking-binding.ts'
import { applyTurnEndNotes, supportsTurnEndNote } from '../turn-end-note.ts'

// Every model-dependent decision in Core, rendered for a fixed set of model ids
// on fixed request bodies. The snapshot file was generated from the code before
// these decisions moved into one capability table, so any difference here is a
// behaviour change, not a refactor. Regenerate it only for an intended change:
//   WRITE_MODEL_CAPABILITY_SNAPSHOT=1 bun test model-capabilities-snapshot
const SNAPSHOT_PATH = join(
  import.meta.dir,
  'fixtures',
  'model-capabilities-snapshot.json',
)

/**
 * Exact ids the plugin special-cases, their context-window, dated and fast
 * spellings, and ids it does not know, including plausible future ids, so the
 * snapshot also records how an unknown model falls through.
 */
const PROBE_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5-2',
  'claude-fable-5-2-20261109[1m]',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5[1m]',
  'claude-fable-5-1[1m]',
  'claude-fable-5-1-20260901',
  'claude-mythos-5-1[1m]',
  'claude-opus-5[1m]',
  'claude-opus-5-fast',
  'claude-opus-5-20260701',
  'claude-opus-5-5[1m]',
  'claude-opus-5-5-20260918',
  'claude-sonnet-5[1m]',
  'claude-sonnet-5-5[1m]',
  'claude-sonnet-5-5-20260928',
  'claude-haiku-5-5[1m]',
  'claude-haiku-5-5-20261007',
  'claude-haiku-5-5-fast',
  'claude-fable-5-5',
  'claude-fable-5-5[1m]',
  'claude-fable-5-5-20261101',
  'claude-mythos-5-5',
  'claude-fable-5-1x',
  'claude-fable-6',
  'claude-fable',
  'claude-opus-5x',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-5-5x',
  'claude-haiku-4-5',
  'gpt-5',
] as const

const THINKING_SHAPES = {
  adaptive: { type: 'adaptive', display: 'summarized' },
  disabled: { type: 'disabled' },
  between_tools: { type: 'between_tools' },
  absent: undefined,
} as const

function history() {
  return [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'text', text: 'A'.repeat(400) },
        { type: 'tool_use', id: 'toolu_1', name: 'board', input: {} },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]
}

function body(
  model: string,
  thinking: keyof typeof THINKING_SHAPES,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const shape = THINKING_SHAPES[thinking]
  return {
    model,
    messages: history(),
    max_tokens: 32_000,
    ...(shape && { thinking: { ...shape } }),
    ...extra,
  }
}

/** Message shape without text bodies, so the snapshot stays readable. */
function outline(messages: unknown) {
  if (!Array.isArray(messages)) return null
  return messages.map((message) => {
    const record = message as Record<string, unknown>
    if (record.role !== 'system') return record.role
    return {
      role: 'system',
      clear_at: record.clear_at ?? null,
      output_config: record.output_config ?? null,
      text: typeof record.content === 'string',
    }
  })
}

const TRANSITIONS: Record<string, MidConversationEffortTransition[]> = {
  none: [],
  single: [{ afterAssistantMessages: 0, effort: 'low' }],
  change: [
    { afterAssistantMessages: 0, effort: 'low' },
    { afterAssistantMessages: 2, effort: 'max' },
  ],
}

function renderPredicates(model: string) {
  const predicates: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(models)) {
    if (typeof value === 'function' && /^is[A-Z]/.test(name)) {
      predicates[name] = (value as (model: unknown) => unknown)(model)
    }
  }
  return predicates
}

function renderBetas(model: string) {
  const messages = history()
  const note = [
    ...messages,
    { role: 'system', clear_at: 'next_user_message', content: 'note' },
  ]
  const structured = { format: { type: 'json_schema', schema: {} } }
  return {
    main: selectClaudeCodeBetas({ model, messages }, [], 'main'),
    mainWithNoteStructuredFastAndExtra: selectClaudeCodeBetas(
      {
        model,
        messages: note,
        output_config: structured,
        speed: 'fast',
      },
      ['extra-beta-2026-01-01', 'oauth-2025-04-20'],
      'main',
    ),
    title: selectClaudeCodeBetas(
      { model, messages, max_tokens: 512 },
      [],
      'auxiliary',
    ),
    titleStructured: selectClaudeCodeBetas(
      { model, messages, max_tokens: 512, output_config: structured },
      [],
      'auxiliary',
    ),
    quota: selectClaudeCodeBetas(
      { model, messages, max_tokens: 1 },
      [],
      'auxiliary',
    ),
    quotaWithNote: selectClaudeCodeBetas(
      { model, messages: note, max_tokens: 1 },
      [],
      'auxiliary',
    ),
  }
}

function renderEffort(model: string) {
  const perMessage: Record<string, boolean> = {}
  for (const thinking of Object.keys(THINKING_SHAPES)) {
    perMessage[thinking] = supportsPerMessageEffort(
      body(model, thinking as keyof typeof THINKING_SHAPES),
    )
  }
  const midConversation: Record<string, unknown> = {}
  for (const thinking of ['adaptive', 'absent'] as const) {
    for (const [name, transitions] of Object.entries(TRANSITIONS)) {
      for (const [configName, outputConfig] of Object.entries({
        noConfig: undefined,
        xhigh: { effort: 'xhigh' },
      })) {
        const request = body(
          model,
          thinking,
          outputConfig ? { output_config: { ...outputConfig } } : {},
        )
        const result = applyMidConversationOutputConfig(request, transitions)
        midConversation[`${thinking}/${name}/${configName}`] = {
          result,
          output_config: request.output_config ?? null,
          messages: outline(request.messages),
        }
      }
    }
  }
  return {
    sendsPerTurnControlBeta: sendsPerTurnControlBeta(model),
    usesPerTurnControl: usesPerTurnControl(model),
    defaultAdaptiveEffort: defaultAdaptiveEffort(model),
    supportsPerMessageEffort: perMessage,
    midConversation,
  }
}

function renderTurnEndNote(model: string) {
  const request = body(model, 'adaptive')
  const inserted = applyTurnEndNotes(request)
  return {
    supportsTurnEndNote: supportsTurnEndNote(model),
    inserted,
    messages: outline(request.messages),
  }
}

function renderThinkingBinding(model: string) {
  const rendered: Record<string, unknown> = {}
  for (const behavior of ['account-default', 'error', 'drop_block'] as const) {
    for (const thinking of Object.keys(THINKING_SHAPES)) {
      const request = body(model, thinking as keyof typeof THINKING_SHAPES)
      const applied = applyThinkingBindingControls(request, behavior)
      rendered[`${behavior}/${thinking}`] = {
        applied,
        thinking: request.thinking ?? null,
      }
    }
  }
  const withoutReplayable = {
    model,
    thinking: { ...THINKING_SHAPES.adaptive },
    messages: [{ role: 'user', content: 'only' }],
  }
  rendered.withoutReplayableThinking = applyThinkingBindingControls(
    withoutReplayable,
    'error',
  )
  return rendered
}

function renderModel(model: string) {
  return {
    normalized: models.normalizeAnthropicModelId(model),
    predicates: renderPredicates(model),
    fableMythosReleaseDate: models.getClaudeFableMythos5ReleaseDate(model),
    fastMode: isFastModeSupportedModel(model),
    stickyRouteFamily: stickyRouteFamilyForModel(model),
    nativeQuotaScope: nativeQuotaModelScope(model),
    betas: renderBetas(model),
    effort: renderEffort(model),
    turnEndNote: renderTurnEndNote(model),
    thinkingBinding: renderThinkingBinding(model),
  }
}

/** Every exported constant of the model catalogue (ids, pricing, limits, dates). */
function renderCatalogue() {
  const catalogue: Record<string, unknown> = {}
  for (const name of Object.keys(models).sort()) {
    const value = (models as Record<string, unknown>)[name]
    if (/^CLAUDE_[A-Z0-9_]+$/.test(name) && typeof value !== 'function') {
      catalogue[name] = value
    }
  }
  return catalogue
}

function render() {
  return JSON.parse(
    JSON.stringify({
      catalogue: renderCatalogue(),
      models: Object.fromEntries(
        PROBE_MODELS.map((model) => [model, renderModel(model)]),
      ),
    }),
  )
}

test('model-dependent request decisions match the recorded snapshot', () => {
  const rendered = render()
  if (process.env.WRITE_MODEL_CAPABILITY_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(rendered, null, 2)}\n`)
  }
  const recorded = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  expect(rendered).toEqual(recorded)
})
