import type { AdaptiveEffort } from './mid-conversation-output-config.ts'

/**
 * One row per Claude model that this plugin treats differently from an
 * unknown model. Every per-model decision in Core (family checks, effort
 * handling, Claude Code betas, turn-end notes, thinking-binding controls) and
 * the per-model facts OpenCode and Pi read (catalogue entries, fallback
 * eligibility) come from this table, so adding a model is one new row.
 *
 * Ids stay exact. A request model resolves to a row only when it equals the
 * row's id (after removing OpenCode's `[1m]` context-window qualifier) or
 * extends it as the row's `idSuffixes` allows; when several rows match, the
 * longest id wins. A model that matches no row gets the defaults described on
 * each field.
 */

/** Per-turn control beta Claude Code sends on the models whose rows list it. */
export const PER_TURN_CONTROL_BETA = 'per-turn-control-2026-07-01'

/** Beta that allows turn-scoped system messages (`clear_at`). */
export const TURN_END_NOTE_BETA = 'mid-conversation-system-clear-at-2026-08-21'

const CLAUDE_CODE_BETA = 'claude-code-20250219'
const PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'

// The lists follow Claude Code 2.1.302's main, title and quota requests.
// Advisor and fallback-credit betas require features these requests do not use.
// The display-updates beta does not change the body: summarized thinking still
// streams text, unlike Claude Code's `thinking.display: "updates"`.
export const CLAUDE_CODE_FULL_AGENT_BETAS = [
  CLAUDE_CODE_BETA,
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  PROMPT_CACHING_SCOPE_BETA,
  'mid-conversation-tool-changes-2026-07-01',
  'advanced-tool-use-2025-11-20',
  TURN_END_NOTE_BETA,
  'effort-2025-11-24',
  'thinking-binding-controls-2026-08-01',
  'thinking-display-updates-2026-08-18',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

const CLAUDE_CODE_TITLE_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  PROMPT_CACHING_SCOPE_BETA,
  'mid-conversation-tool-changes-2026-07-01',
  TURN_END_NOTE_BETA,
  'effort-2025-11-24',
  'cache-diagnosis-2026-04-07',
] as const

const CLAUDE_CODE_QUOTA_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  PROMPT_CACHING_SCOPE_BETA,
] as const

/**
 * Claude Code's `anthropic-beta` list for each request class, before the
 * body-dependent additions (turn-end note, structured outputs, fast mode and
 * caller-supplied betas). `main` is a conversation turn; `title` is any other
 * auxiliary request; `quota` is a one-token auxiliary probe.
 */
export type ClaudeCodeBetaLists = {
  main: readonly string[]
  title: readonly string[]
  quota: readonly string[]
}

/** The lists for a model without its own row. */
export const CLAUDE_CODE_DEFAULT_BETAS: ClaudeCodeBetaLists = {
  main: CLAUDE_CODE_FULL_AGENT_BETAS,
  title: CLAUDE_CODE_TITLE_BETAS,
  quota: CLAUDE_CODE_QUOTA_BETAS,
}

/**
 * The default lists adjusted the way Claude Code 2.1.302 adjusts them per
 * model. `claudeCodeBetaAfterCachingScope` moves claude-code-20250219 from
 * first place to directly after the prompt-caching scope beta (Haiku 5.5).
 * `perTurnControl` inserts the per-turn control beta directly after the
 * prompt-caching scope beta, or after claude-code-20250219 where that follows
 * it. A row whose capture differs in another way can list its betas literally.
 */
function claudeCodeBetaLists(options: {
  perTurnControl: boolean
  claudeCodeBetaAfterCachingScope?: boolean
}): ClaudeCodeBetaLists {
  const adjust = (list: readonly string[]) => {
    const selected = [...list]
    if (options.claudeCodeBetaAfterCachingScope) {
      const codeIndex = selected.indexOf(CLAUDE_CODE_BETA)
      if (codeIndex >= 0) {
        selected.splice(codeIndex, 1)
        selected.splice(
          selected.indexOf(PROMPT_CACHING_SCOPE_BETA) + 1,
          0,
          CLAUDE_CODE_BETA,
        )
      }
    }
    if (options.perTurnControl) {
      let index = selected.indexOf(PROMPT_CACHING_SCOPE_BETA)
      if (index >= 0 && selected[index + 1] === CLAUDE_CODE_BETA) index += 1
      if (index >= 0) selected.splice(index + 1, 0, PER_TURN_CONTROL_BETA)
      else selected.push(PER_TURN_CONTROL_BETA)
    }
    return selected
  }
  return {
    main: adjust(CLAUDE_CODE_FULL_AGENT_BETAS),
    title: adjust(CLAUDE_CODE_TITLE_BETAS),
    quota: adjust(CLAUDE_CODE_QUOTA_BETAS),
  }
}

export type ClaudeModelFamily = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku'

/** Per-million-token USD prices. */
export type ClaudeModelPricing = {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

/**
 * Catalogue facts for a model the plugin registers itself in OpenCode and Pi,
 * rather than taking from the host's own model list.
 */
export type ClaudeModelCatalogue = {
  releaseDate: string
  contextWindow: number
  maxOutputTokens: number
  pricing: ClaudeModelPricing
  /** Higher prices for every token of a request above `inputTokensAbove` input tokens. */
  longContext?: { inputTokensAbove: number; pricing: ClaudeModelPricing }
}

/** Source-model keys for content-filter recovery to Opus 4.8 in OpenCode. */
export type ClaudeRefusalRecoveryFamily =
  | 'fable-5'
  | 'fable-5-1'
  | 'fable-5-2'
  | 'opus-5'
  | 'opus-5-5'

export type ClaudeModelCapabilities = {
  /** Exact Anthropic model id. */
  id: string
  /** Display name in host model pickers. */
  name: string
  family: ClaudeModelFamily
  /**
   * Longer ids that also resolve to this row: `any` accepts the id followed by
   * `-` and anything (a date, `-fast`); `dated` accepts only `-YYYYMMDD`.
   */
  idSuffixes: 'any' | 'dated'
  /** Shown as limited availability. */
  limited?: true
  /** Absent when the model comes from the host's own catalogue. */
  catalogue?: ClaudeModelCatalogue
  /**
   * Thinking settings the API accepts. OpenCode's transform.ts and Pi's
   * convert.ts still normalize thinking with per-family code; a test checks
   * that OpenCode's result agrees with this list.
   */
  thinkingModes: readonly ('adaptive' | 'disabled' | 'between_tools')[]
  /** The API rejects `tool_choice` of type `any` or `tool`, so it is removed. */
  rejectsForcedToolChoice: boolean
  efforts: {
    /**
     * Efforts offered as host model variants with adaptive thinking. Absent:
     * the host's own variants are left alone. Unknown models: absent.
     */
    variants?: readonly AdaptiveEffort[]
    /** Anthropic's effort when a request sets none. Unknown models: `high`. */
    default: AdaptiveEffort
  }
  /**
   * When effort changes may be sent as empty `role: "system"` messages:
   * `always` (and top-level effort is then pinned on every request),
   * `with-adaptive-thinking` (only when the request's thinking is adaptive),
   * or `none`. Unknown models: `none`.
   */
  effortMarkers: 'none' | 'with-adaptive-thinking' | 'always'
  /** Turn-end notes may be inserted. Unknown models: no. */
  turnEndNote: boolean
  /** `thinking.block_binding` may be set. Unknown models: no. */
  thinkingBindingControls: boolean
  /** Unknown models: `CLAUDE_CODE_DEFAULT_BETAS`. */
  claudeCodeBetas: ClaudeCodeBetaLists
  /** OpenCode may ask Anthropic for its server-side safety fallback. */
  serverSideFallback: boolean
  /** OpenCode recovers from a content-filter refusal on Opus 4.8 under this key. */
  refusalRecoveryFamily?: ClaudeRefusalRecoveryFamily
  /**
   * Model-scoped weekly quota this model draws from. Quota matching in
   * accounts.ts and native-quota-codec.ts still matches the substrings
   * `fable`/`mythos`; a test checks that they agree with this field.
   */
  scopedQuota?: 'fable' | 'mythos'
  /**
   * Fast mode (`speed: "fast"`) is offered. `isFastModeSupportedModel` also
   * keeps its older prefix rule for ids outside this table.
   */
  fastMode: boolean
}

const ALL_ADAPTIVE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const FABLE_MYTHOS_5_CATALOGUE: ClaudeModelCatalogue = {
  releaseDate: '2026-06-09',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  pricing: {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
  },
}

const FABLE_MYTHOS_5_1_CATALOGUE: ClaudeModelCatalogue = {
  releaseDate: '2026-09-01',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  pricing: {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
  },
}

const FABLE_5_2_CATALOGUE: ClaudeModelCatalogue = {
  releaseDate: '2026-11-09',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  pricing: {
    input: 8,
    output: 40,
    // Anthropic's Claude Fable 5.2 model page lists cache reads at $0.20/M.
    cacheRead: 0.2,
    cacheWrite5m: 10,
    cacheWrite1h: 16,
  },
}

export const CLAUDE_MODEL_CAPABILITIES: readonly ClaudeModelCapabilities[] = [
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    family: 'fable',
    idSuffixes: 'any',
    catalogue: FABLE_MYTHOS_5_CATALOGUE,
    thinkingModes: ['adaptive'],
    rejectsForcedToolChoice: false,
    efforts: { default: 'high' },
    effortMarkers: 'none',
    turnEndNote: false,
    thinkingBindingControls: false,
    claudeCodeBetas: CLAUDE_CODE_DEFAULT_BETAS,
    serverSideFallback: true,
    refusalRecoveryFamily: 'fable-5',
    scopedQuota: 'fable',
    fastMode: false,
  },
  {
    id: 'claude-mythos-5',
    name: 'Claude Mythos 5',
    family: 'mythos',
    idSuffixes: 'any',
    limited: true,
    catalogue: FABLE_MYTHOS_5_CATALOGUE,
    thinkingModes: ['adaptive'],
    rejectsForcedToolChoice: false,
    efforts: { default: 'high' },
    effortMarkers: 'none',
    turnEndNote: false,
    thinkingBindingControls: false,
    claudeCodeBetas: CLAUDE_CODE_DEFAULT_BETAS,
    serverSideFallback: false,
    scopedQuota: 'mythos',
    fastMode: false,
  },
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    family: 'fable',
    idSuffixes: 'any',
    catalogue: FABLE_MYTHOS_5_1_CATALOGUE,
    thinkingModes: ['adaptive'],
    rejectsForcedToolChoice: true,
    efforts: { variants: ALL_ADAPTIVE_EFFORTS, default: 'high' },
    effortMarkers: 'always',
    turnEndNote: true,
    thinkingBindingControls: true,
    claudeCodeBetas: claudeCodeBetaLists({ perTurnControl: true }),
    serverSideFallback: true,
    refusalRecoveryFamily: 'fable-5-1',
    scopedQuota: 'fable',
    fastMode: false,
  },
  {
    id: 'claude-mythos-5-1',
    name: 'Claude Mythos 5.1',
    family: 'mythos',
    idSuffixes: 'any',
    limited: true,
    catalogue: FABLE_MYTHOS_5_1_CATALOGUE,
    thinkingModes: ['adaptive'],
    rejectsForcedToolChoice: true,
    efforts: { default: 'high' },
    effortMarkers: 'none',
    turnEndNote: false,
    thinkingBindingControls: false,
    claudeCodeBetas: CLAUDE_CODE_DEFAULT_BETAS,
    serverSideFallback: false,
    scopedQuota: 'mythos',
    fastMode: false,
  },
  {
    id: 'claude-fable-5-2',
    name: 'Claude Fable 5.2',
    family: 'fable',
    idSuffixes: 'any',
    catalogue: FABLE_5_2_CATALOGUE,
    thinkingModes: ['adaptive'],
    rejectsForcedToolChoice: true,
    efforts: { variants: ALL_ADAPTIVE_EFFORTS, default: 'medium' },
    effortMarkers: 'always',
    turnEndNote: true,
    thinkingBindingControls: true,
    claudeCodeBetas: claudeCodeBetaLists({ perTurnControl: true }),
    serverSideFallback: true,
    refusalRecoveryFamily: 'fable-5-2',
    scopedQuota: 'fable',
    // Claude Code's runtime capability list for 5.2 lacks fast_mode today, so
    // we don't send speed: fast until a real request proves subscription accounts accept it.
    fastMode: false,
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    family: 'opus',
    idSuffixes: 'any',
    // Disabled thinking is accepted only at effort high or below.
    thinkingModes: ['adaptive', 'disabled'],
    rejectsForcedToolChoice: false,
    efforts: { variants: ALL_ADAPTIVE_EFFORTS, default: 'high' },
    effortMarkers: 'none',
    turnEndNote: false,
    thinkingBindingControls: false,
    claudeCodeBetas: CLAUDE_CODE_DEFAULT_BETAS,
    serverSideFallback: true,
    refusalRecoveryFamily: 'opus-5',
    fastMode: true,
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    family: 'opus',
    idSuffixes: 'any',
    catalogue: {
      releaseDate: '2026-09-18',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: {
        input: 4,
        output: 20,
        cacheRead: 0.2,
        cacheWrite5m: 5,
        cacheWrite1h: 8,
      },
    },
    thinkingModes: ['adaptive'],
    rejectsForcedToolChoice: true,
    efforts: { variants: ALL_ADAPTIVE_EFFORTS, default: 'medium' },
    effortMarkers: 'with-adaptive-thinking',
    turnEndNote: true,
    thinkingBindingControls: true,
    claudeCodeBetas: claudeCodeBetaLists({ perTurnControl: true }),
    serverSideFallback: true,
    refusalRecoveryFamily: 'opus-5-5',
    fastMode: true,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    family: 'sonnet',
    idSuffixes: 'any',
    thinkingModes: ['adaptive', 'disabled'],
    rejectsForcedToolChoice: false,
    efforts: { default: 'high' },
    effortMarkers: 'none',
    turnEndNote: false,
    thinkingBindingControls: false,
    claudeCodeBetas: CLAUDE_CODE_DEFAULT_BETAS,
    serverSideFallback: false,
    fastMode: false,
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    family: 'sonnet',
    idSuffixes: 'any',
    catalogue: {
      releaseDate: '2026-09-28',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: {
        input: 2,
        output: 10,
        cacheRead: 0.2,
        cacheWrite5m: 2.5,
        cacheWrite1h: 4,
      },
    },
    // The opt-out is bare `between_tools`, at effort high or below; the API
    // rejects `disabled`, and rejects a differing per-message effort there.
    thinkingModes: ['adaptive', 'between_tools'],
    rejectsForcedToolChoice: true,
    efforts: { variants: ALL_ADAPTIVE_EFFORTS, default: 'high' },
    effortMarkers: 'with-adaptive-thinking',
    turnEndNote: true,
    thinkingBindingControls: true,
    claudeCodeBetas: claudeCodeBetaLists({ perTurnControl: true }),
    serverSideFallback: false,
    fastMode: false,
  },
  {
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    family: 'haiku',
    idSuffixes: 'dated',
    catalogue: {
      releaseDate: '2026-10-07',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: {
        input: 0.1,
        output: 0.5,
        cacheRead: 0.01,
        cacheWrite5m: 0.125,
        cacheWrite1h: 0.2,
      },
      longContext: {
        inputTokensAbove: 100_000,
        pricing: {
          input: 0.5,
          output: 2.5,
          cacheRead: 0.05,
          cacheWrite5m: 0.625,
          cacheWrite1h: 1,
        },
      },
    },
    // Disabled thinking is accepted only at effort high or below.
    thinkingModes: ['adaptive', 'disabled'],
    rejectsForcedToolChoice: false,
    efforts: { variants: ALL_ADAPTIVE_EFFORTS, default: 'medium' },
    effortMarkers: 'none',
    turnEndNote: true,
    thinkingBindingControls: true,
    claudeCodeBetas: claudeCodeBetaLists({
      perTurnControl: true,
      claudeCodeBetaAfterCachingScope: true,
    }),
    serverSideFallback: false,
    fastMode: false,
  },
]

/** Remove OpenCode's context-window qualifier before model-family checks. */
export function normalizeAnthropicModelId(model: string): string {
  return model.endsWith('[1m]') ? model.slice(0, -4) : model
}

function matchesRow(row: ClaudeModelCapabilities, normalized: string) {
  if (normalized === row.id) return true
  if (!normalized.startsWith(`${row.id}-`)) return false
  if (row.idSuffixes === 'any') return true
  return /^\d{8}$/.test(normalized.slice(row.id.length + 1))
}

/**
 * The row for a request model, or `undefined` for a model this plugin does
 * not special-case. See the table's description for how ids match.
 */
export function resolveClaudeModelCapabilities(
  model: unknown,
): ClaudeModelCapabilities | undefined {
  if (typeof model !== 'string') return undefined
  const normalized = normalizeAnthropicModelId(model)
  let resolved: ClaudeModelCapabilities | undefined
  for (const row of CLAUDE_MODEL_CAPABILITIES) {
    if (!matchesRow(row, normalized)) continue
    if (!resolved || row.id.length > resolved.id.length) resolved = row
  }
  return resolved
}

/** The row for an exact model id; throws when the table has no such row. */
export function getClaudeModelCapabilities(
  id: string,
): ClaudeModelCapabilities {
  const row = CLAUDE_MODEL_CAPABILITIES.find((entry) => entry.id === id)
  if (!row) throw new Error(`No model capability row for ${id}`)
  return row
}

/** Catalogue facts for an exact model id; throws when the row has none. */
export function getClaudeModelCatalogue(id: string): ClaudeModelCatalogue {
  const catalogue = getClaudeModelCapabilities(id).catalogue
  if (!catalogue) throw new Error(`No catalogue facts for ${id}`)
  return catalogue
}

/**
 * Whether effort is pinned in top-level `output_config` on every request,
 * even one without an effort change.
 */
export function pinsEffortOnEveryRequest(model: unknown): boolean {
  return resolveClaudeModelCapabilities(model)?.effortMarkers === 'always'
}
