import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyOpenCodeEffortMarkers,
  encodeOpenCodeEffortPlan,
  markOpenCodeEffortTransitions,
} from '../effort-history'
import {
  isRecoverableRefusalModel,
  recoverableRefusalFamily,
} from '../fable-fallback'
import { applyServerSideFallbackToBody } from '../server-fallback'
import { rewriteRequestBody } from '../transform'
import { createNativeClaudeModelRules } from '../v2/models'

// Every model-dependent decision OpenCode makes on top of Core, rendered for a
// fixed set of model ids. The snapshot file was generated from the code before
// these decisions moved into Core's model capability table, so any difference
// here is a behaviour change, not a refactor. Regenerate it only for an
// intended change:
//   WRITE_MODEL_CAPABILITY_SNAPSHOT=1 bun test opencode-model-capabilities-snapshot
const SNAPSHOT_PATH = join(
  import.meta.dir,
  'fixtures',
  'opencode-model-capabilities-snapshot.json',
)

/** Known ids, their context-window and dated spellings, and unknown ids. */
const PROBE_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-fable-5-1',
  'claude-mythos-5-1',
  'claude-fable-5-2',
  'claude-fable-5-2-20261109[1m]',
  'claude-mythos-5-2',
  'claude-mythos-5-2-20261109[1m]',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5[1m]',
  'claude-fable-5-1[1m]',
  'claude-fable-5-1-20260901',
  'claude-opus-5-fast',
  'claude-opus-5-5[1m]',
  'claude-sonnet-5-5-20260928',
  'claude-haiku-5-5-20261007',
  'claude-haiku-5-5-fast',
  'claude-fable-5-5',
  'claude-fable-5-5[1m]',
  'claude-mythos-5-5',
  'claude-fable-6',
  'claude-opus-5x',
  'claude-opus-4-8',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const

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

function outline(messages: unknown) {
  if (!Array.isArray(messages)) return null
  return messages.map((message) => {
    const record = message as Record<string, unknown>
    if (record.role !== 'system') return record.role
    return {
      role: 'system',
      clear_at: record.clear_at ?? null,
      output_config: record.output_config ?? null,
    }
  })
}

const REQUEST_SHAPES: Record<string, Record<string, unknown>> = {
  plain: {},
  adaptiveForcedTool: {
    thinking: { type: 'adaptive', display: 'summarized' },
    tool_choice: { type: 'any' },
    output_config: { effort: 'max' },
  },
  disabledXhigh: {
    thinking: { type: 'disabled' },
    tool_choice: { type: 'tool', name: 'board' },
    output_config: { effort: 'xhigh' },
    temperature: 0.5,
  },
  betweenToolsMax: {
    thinking: { type: 'between_tools' },
    output_config: { effort: 'max' },
  },
  budget: { thinking: { type: 'enabled', budget_tokens: 4096 } },
}

async function renderRewrite(model: string) {
  const rendered: Record<string, unknown> = {}
  for (const [name, shape] of Object.entries(REQUEST_SHAPES)) {
    const body = {
      model,
      max_tokens: 32_000,
      messages: history(),
      tools: [
        {
          name: 'board',
          description: 'Board',
          input_schema: { type: 'object' },
        },
      ],
      ...structuredClone(shape),
    }
    const rewritten = JSON.parse(
      await rewriteRequestBody(JSON.stringify(body), {
        serverSideFallbackEnabled: true,
        thinkingPrefixMismatchBehavior: 'drop_block',
        turnEndNoteEnabled: true,
      }),
    ) as Record<string, unknown>
    rendered[name] = {
      model: rewritten.model,
      thinking: rewritten.thinking ?? null,
      tool_choice: rewritten.tool_choice ?? null,
      output_config: rewritten.output_config ?? null,
      fallbacks: rewritten.fallbacks ?? null,
      temperature: rewritten.temperature ?? null,
      messages: outline(rewritten.messages),
    }
  }
  return rendered
}

const user = (id: string, modelID: string, variant?: string) => ({
  info: {
    id,
    role: 'user',
    sessionID: 'ses_snapshot',
    model: { providerID: 'anthropic', modelID, variant },
  },
  parts: [{ type: 'text', text: id }] as Array<Record<string, unknown>>,
})

const assistant = (id: string) => ({
  info: { id, role: 'assistant', sessionID: 'ses_snapshot' },
  parts: [] as Array<Record<string, unknown>>,
})

function renderEffortMarkers(model: string) {
  const rendered: Record<string, unknown> = {}
  const scenarios = {
    // A single user turn has no effort transition, so no marker is inserted;
    // these cases record whether that turn's effort is still written to the
    // request's top-level `output_config`.
    single: [user('msg_1', model, 'low')],
    single_default: [user('msg_1', model)],
    change: [
      user('msg_1', model, 'low'),
      assistant('msg_2'),
      user('msg_3', model, 'max'),
    ],
  }
  for (const [name, messages] of Object.entries(scenarios)) {
    const plan = markOpenCodeEffortTransitions(messages)
    const body: Record<string, unknown> = {
      model,
      thinking: { type: 'adaptive', display: 'summarized' },
      messages: messages.map((message) =>
        message.info.role === 'user'
          ? {
              role: 'user',
              content: message.parts.map((part) => ({
                type: 'text',
                text: part.text,
              })),
            }
          : { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      ),
    }
    let result: unknown
    try {
      result = applyOpenCodeEffortMarkers(
        body,
        true,
        plan ? encodeOpenCodeEffortPlan(plan) : undefined,
        plan ?? undefined,
      )
    } catch (error) {
      result = { error: (error as Error).message }
    }
    rendered[name] = {
      plan: plan
        ? { baseline: plan.baseline, markerCount: plan.markerCount }
        : null,
      result,
      output_config: body.output_config ?? null,
      messages: outline(body.messages),
    }
  }
  return rendered
}

function renderNativeVariants(model: string) {
  const candidate = {
    id: `anthropic/${model}`,
    modelID: model,
    variants: [{ id: 'custom' }] as Array<{ id: string }>,
  }
  const editor = {
    list: () => [candidate],
    update: (
      _provider: string,
      _id: string,
      mutate: (model: typeof candidate) => void,
    ) => mutate(candidate),
  }
  const rules = createNativeClaudeModelRules()
  rules.install({
    model: {
      transform: (apply: (value: typeof editor) => void) => apply(editor),
    },
  } as never)
  return candidate.variants.map((variant) => variant.id)
}

async function renderModel(model: string) {
  const fallbackBody: Record<string, unknown> = { model, messages: [] }
  const fallback = applyServerSideFallbackToBody(fallbackBody, true)
  const notRequested: Record<string, unknown> = {
    model,
    messages: [],
    fallbacks: 'default',
  }
  applyServerSideFallbackToBody(notRequested, false)
  return {
    recoverableRefusalFamily: recoverableRefusalFamily(model),
    isRecoverableRefusalModel: isRecoverableRefusalModel(model),
    serverSideFallback: {
      enabled: fallback.enabled,
      fallbacks: fallbackBody.fallbacks ?? null,
      notRequestedFallbacks: notRequested.fallbacks ?? null,
    },
    nativeVariants: renderNativeVariants(model),
    rewrite: await renderRewrite(model),
    effortMarkers: renderEffortMarkers(model),
  }
}

test('OpenCode model-dependent request decisions match the recorded snapshot', async () => {
  const models: Record<string, unknown> = {}
  for (const model of PROBE_MODELS) models[model] = await renderModel(model)
  const rendered = JSON.parse(JSON.stringify({ models }))
  if (process.env.WRITE_MODEL_CAPABILITY_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(rendered, null, 2)}\n`)
  }
  const recorded = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
  expect(rendered).toEqual(recorded)
})
