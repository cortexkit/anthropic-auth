export const CLAUDE_FABLE_5_MODEL_ID = 'claude-fable-5'
export const CLAUDE_MYTHOS_5_MODEL_ID = 'claude-mythos-5'

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

export const CLAUDE_FABLE_MYTHOS_5_MODEL_IDS = [
  CLAUDE_FABLE_5_MODEL_ID,
  CLAUDE_MYTHOS_5_MODEL_ID,
] as const

export type ClaudeFableMythos5ModelId =
  (typeof CLAUDE_FABLE_MYTHOS_5_MODEL_IDS)[number]

export const CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING = {
  type: 'adaptive',
  display: 'summarized',
} as const

export const CLAUDE_FABLE_MYTHOS_5_PRICING = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
} as const

export const CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW = 1_000_000
export const CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS = 128_000
export const CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE = '2026-06-09'

export const CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS: Record<
  ClaudeFableMythos5ModelId,
  { id: ClaudeFableMythos5ModelId; name: string; limited?: boolean }
> = {
  [CLAUDE_FABLE_5_MODEL_ID]: {
    id: CLAUDE_FABLE_5_MODEL_ID,
    name: 'Claude Fable 5',
  },
  [CLAUDE_MYTHOS_5_MODEL_ID]: {
    id: CLAUDE_MYTHOS_5_MODEL_ID,
    name: 'Claude Mythos 5',
    limited: true,
  },
}

export function isClaudeFableOrMythos5Model(model: unknown) {
  return (
    typeof model === 'string' &&
    CLAUDE_FABLE_MYTHOS_5_MODEL_IDS.some(
      (id) => model === id || model.startsWith(`${id}-`),
    )
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
  return (
    typeof model === 'string' &&
    (model === CLAUDE_SONNET_5_MODEL_ID ||
      model.startsWith(`${CLAUDE_SONNET_5_MODEL_ID}-`))
  )
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
  return (
    typeof model === 'string' &&
    (model === CLAUDE_OPUS_5_MODEL_ID ||
      model.startsWith(`${CLAUDE_OPUS_5_MODEL_ID}-`))
  )
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
