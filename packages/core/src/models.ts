import {
  type ClaudeModelCapabilities,
  getClaudeModelCapabilities,
  getClaudeModelCatalogue,
  normalizeAnthropicModelId,
  resolveClaudeModelCapabilities,
} from './model-capabilities.ts'

// Model facts live in the capability table in model-capabilities.ts. The
// constants and checks below are read from it and kept for existing callers.

export { normalizeAnthropicModelId }

export const CLAUDE_FABLE_5_MODEL_ID = 'claude-fable-5'
export const CLAUDE_MYTHOS_5_MODEL_ID = 'claude-mythos-5'
export const CLAUDE_FABLE_5_1_MODEL_ID = 'claude-fable-5-1'
export const CLAUDE_FABLE_5_2_MODEL_ID = 'claude-fable-5-2'
export const CLAUDE_MYTHOS_5_1_MODEL_ID = 'claude-mythos-5-1'
export const CLAUDE_MYTHOS_5_2_MODEL_ID = 'claude-mythos-5-2'

/**
 * Haiku 4.5 model identifier used by `/claude-prime` to start each OAuth
 * account's five-hour quota window with a minimal request. Usage is measured
 * from response accounting. Kept distinct from the Fable/Mythos pricing block
 * above so per-million-token cost estimation does not conflate families.
 */
export const CLAUDE_HAIKU_4_5_MODEL_ID = 'claude-haiku-4-5'

/**
 * Per-million-token USD pricing for Haiku 4.5. Used to project the cumulative
 * cost of prime requests from persisted usage counters — never persisted on
 * disk; derive at display time so future pricing revisions land in one place.
 */
export const CLAUDE_HAIKU_4_5_PRICING = {
  input: 1,
  output: 5,
} as const

export const CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS = [
  CLAUDE_FABLE_5_1_MODEL_ID,
  CLAUDE_MYTHOS_5_1_MODEL_ID,
] as const

export const CLAUDE_FABLE_MYTHOS_5_MODEL_IDS = [
  CLAUDE_FABLE_5_MODEL_ID,
  CLAUDE_MYTHOS_5_MODEL_ID,
  ...CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS,
  CLAUDE_FABLE_5_2_MODEL_ID,
  CLAUDE_MYTHOS_5_2_MODEL_ID,
] as const

export type ClaudeFableMythos5ModelId =
  (typeof CLAUDE_FABLE_MYTHOS_5_MODEL_IDS)[number]

export const CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING = {
  type: 'adaptive',
  display: 'summarized',
} as const

const FABLE_5_CATALOGUE = getClaudeModelCatalogue(CLAUDE_FABLE_5_MODEL_ID)
const FABLE_5_1_CATALOGUE = getClaudeModelCatalogue(CLAUDE_FABLE_5_1_MODEL_ID)
const FABLE_5_2_CATALOGUE = getClaudeModelCatalogue(CLAUDE_FABLE_5_2_MODEL_ID)
const MYTHOS_5_2_CATALOGUE = getClaudeModelCatalogue(CLAUDE_MYTHOS_5_2_MODEL_ID)

export const CLAUDE_FABLE_MYTHOS_5_PRICING = FABLE_5_CATALOGUE.pricing
export const CLAUDE_FABLE_MYTHOS_5_1_PRICING = FABLE_5_1_CATALOGUE.pricing
export const CLAUDE_FABLE_5_2_PRICING = FABLE_5_2_CATALOGUE.pricing
export const CLAUDE_FABLE_5_2_RELEASE_DATE = FABLE_5_2_CATALOGUE.releaseDate
export const CLAUDE_MYTHOS_5_2_PRICING = MYTHOS_5_2_CATALOGUE.pricing
export const CLAUDE_MYTHOS_5_2_RELEASE_DATE = MYTHOS_5_2_CATALOGUE.releaseDate

export const CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW =
  FABLE_5_CATALOGUE.contextWindow
export const CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS =
  FABLE_5_CATALOGUE.maxOutputTokens
export const CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE = FABLE_5_CATALOGUE.releaseDate
export const CLAUDE_FABLE_MYTHOS_5_1_RELEASE_DATE =
  FABLE_5_1_CATALOGUE.releaseDate

function isFableOrMythosRow(row: ClaudeModelCapabilities | undefined) {
  return row?.family === 'fable' || row?.family === 'mythos'
}

/** Name and availability of each Fable and Mythos id, from the capability table. */
export const CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS = Object.fromEntries(
  CLAUDE_FABLE_MYTHOS_5_MODEL_IDS.map((id) => {
    const row = getClaudeModelCapabilities(id)
    return [
      id,
      { id, name: row.name, ...(row.limited && { limited: true }) },
    ] as const
  }),
) as Record<
  ClaudeFableMythos5ModelId,
  { id: ClaudeFableMythos5ModelId; name: string; limited?: boolean }
>

export const CLAUDE_FABLE_MYTHOS_5_1_MODEL_SPECS = {
  [CLAUDE_FABLE_5_1_MODEL_ID]:
    CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS[CLAUDE_FABLE_5_1_MODEL_ID],
  [CLAUDE_MYTHOS_5_1_MODEL_ID]:
    CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS[CLAUDE_MYTHOS_5_1_MODEL_ID],
} satisfies Record<
  (typeof CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS)[number],
  { id: string; name: string; limited?: boolean }
>

/** The capability-table id a request model resolves to, if any. */
function resolvedModelId(model: unknown): string | undefined {
  return resolveClaudeModelCapabilities(model)?.id
}

/**
 * Any Fable or Mythos row. An unknown id that extends a known Fable or Mythos
 * id with `-` (for example `claude-fable-5-5`) resolves to the shorter row.
 */
export function isClaudeFableOrMythos5Model(model: unknown) {
  return isFableOrMythosRow(resolveClaudeModelCapabilities(model))
}

export function isClaudeFableOrMythos51Model(model: unknown) {
  const id = resolvedModelId(model)
  return (CLAUDE_FABLE_MYTHOS_5_1_MODEL_IDS as readonly unknown[]).includes(id)
}

export function isClaudeFable51Model(model: unknown) {
  return resolvedModelId(model) === CLAUDE_FABLE_5_1_MODEL_ID
}

export function getClaudeFableMythos5ReleaseDate(model: unknown) {
  const row = resolveClaudeModelCapabilities(model)
  return (
    (isFableOrMythosRow(row) && row?.catalogue?.releaseDate) ||
    CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE
  )
}

export const CLAUDE_SONNET_5_MODEL_ID = 'claude-sonnet-5'

/**
 * Sonnet 5 enables adaptive thinking by default but ships `display: "omitted"`,
 * so the `thinking` field returns empty and the user sees nothing. Injecting
 * this makes the adaptive thinking summary visible. Reuses the Fable/Mythos
 * shape because the API contract is identical.
 */
export const CLAUDE_SONNET_5_ADAPTIVE_THINKING =
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING

export function isClaudeSonnet5Model(model: unknown) {
  return resolvedModelId(model) === CLAUDE_SONNET_5_MODEL_ID
}

export const CLAUDE_SONNET_5_5_MODEL_ID = 'claude-sonnet-5-5'
const SONNET_5_5_CATALOGUE = getClaudeModelCatalogue(CLAUDE_SONNET_5_5_MODEL_ID)
export const CLAUDE_SONNET_5_5_RELEASE_DATE = SONNET_5_5_CATALOGUE.releaseDate
export const CLAUDE_SONNET_5_5_CONTEXT_WINDOW =
  SONNET_5_5_CATALOGUE.contextWindow
export const CLAUDE_SONNET_5_5_MAX_OUTPUT_TOKENS =
  SONNET_5_5_CATALOGUE.maxOutputTokens

export const CLAUDE_SONNET_5_5_PRICING = SONNET_5_5_CATALOGUE.pricing

export const CLAUDE_SONNET_5_5_ADAPTIVE_THINKING =
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING

export function isClaudeSonnet55Model(model: unknown) {
  return resolvedModelId(model) === CLAUDE_SONNET_5_5_MODEL_ID
}

export const CLAUDE_HAIKU_5_5_MODEL_ID = 'claude-haiku-5-5'
const HAIKU_5_5_CATALOGUE = getClaudeModelCatalogue(CLAUDE_HAIKU_5_5_MODEL_ID)
const HAIKU_5_5_LONG_CONTEXT = HAIKU_5_5_CATALOGUE.longContext
if (!HAIKU_5_5_LONG_CONTEXT) {
  throw new Error('Haiku 5.5 capability row lacks long-context pricing')
}
export const CLAUDE_HAIKU_5_5_RELEASE_DATE = HAIKU_5_5_CATALOGUE.releaseDate
export const CLAUDE_HAIKU_5_5_CONTEXT_WINDOW = HAIKU_5_5_CATALOGUE.contextWindow
export const CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS =
  HAIKU_5_5_CATALOGUE.maxOutputTokens
export const CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD =
  HAIKU_5_5_LONG_CONTEXT.inputTokensAbove

export const CLAUDE_HAIKU_5_5_PRICING = HAIKU_5_5_CATALOGUE.pricing

/** Haiku 5.5's higher rates apply to every token in requests with more than 100K input tokens, including cached input. */
export const CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING =
  HAIKU_5_5_LONG_CONTEXT.pricing

export const CLAUDE_HAIKU_5_5_ADAPTIVE_THINKING =
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING

export function isClaudeHaiku55Model(model: unknown) {
  return resolvedModelId(model) === CLAUDE_HAIKU_5_5_MODEL_ID
}

export const CLAUDE_OPUS_5_MODEL_ID = 'claude-opus-5'

/**
 * Opus 5 has the same adaptive-thinking-by-default + `display: "omitted"`
 * shape as Sonnet 5, so the injected thinking must also be summarized to be
 * visible. Kept as its own constant per the PR #100 lesson — hook callers
 * should reference the per-family name (`CLAUDE_OPUS_5_ADAPTIVE_THINKING`,
 * not the Fable/Mythos alias) so a future divergence between the families
 * only changes this re-export, not every call site.
 */
export const CLAUDE_OPUS_5_ADAPTIVE_THINKING =
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING

export function isClaudeOpus5Model(model: unknown) {
  return resolvedModelId(model) === CLAUDE_OPUS_5_MODEL_ID
}

export const CLAUDE_OPUS_5_5_MODEL_ID = 'claude-opus-5-5'
const OPUS_5_5_CATALOGUE = getClaudeModelCatalogue(CLAUDE_OPUS_5_5_MODEL_ID)
export const CLAUDE_OPUS_5_5_RELEASE_DATE = OPUS_5_5_CATALOGUE.releaseDate
export const CLAUDE_OPUS_5_5_CONTEXT_WINDOW = OPUS_5_5_CATALOGUE.contextWindow
export const CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS =
  OPUS_5_5_CATALOGUE.maxOutputTokens

export const CLAUDE_OPUS_5_5_PRICING = OPUS_5_5_CATALOGUE.pricing

export const CLAUDE_OPUS_5_5_ADAPTIVE_THINKING =
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING

export function isClaudeOpus55Model(model: unknown) {
  return resolvedModelId(model) === CLAUDE_OPUS_5_5_MODEL_ID
}

export function isClaudeOpus5FamilyModel(model: unknown) {
  return isClaudeOpus5Model(model) || isClaudeOpus55Model(model)
}

export function isOpenAIReasoningSignature(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.startsWith('gAAAA')) return true
  if (!value.startsWith('{')) return false

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return (
      parsed.type === 'reasoning' &&
      typeof parsed.id === 'string' &&
      parsed.id.startsWith('rs_') &&
      typeof parsed.encrypted_content === 'string' &&
      parsed.encrypted_content.startsWith('gAAAA')
    )
  } catch {
    return false
  }
}
