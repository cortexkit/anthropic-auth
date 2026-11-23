import {
  PER_TURN_CONTROL_BETA,
  pinsEffortOnEveryRequest,
  resolveClaudeModelCapabilities,
} from './model-capabilities.ts'

/**
 * The beta for sending effort changes in empty `role: "system"` messages.
 */
export { PER_TURN_CONTROL_BETA }

export type AdaptiveEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type MidConversationEffortTransition = {
  /** Number of assistant messages preceding the user boundary for this effort. */
  afterAssistantMessages: number
  effort: AdaptiveEffort
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeAdaptiveEffort(
  value: unknown,
): AdaptiveEffort | undefined {
  if (value === 'minimal') return 'low'
  if (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value
  }
  return undefined
}

/**
 * Whether the model requires adaptive thinking for per-message effort.
 * The per-turn control beta header can be sent even when thinking is off.
 */
export function usesPerTurnControl(model: unknown): boolean {
  return (
    resolveClaudeModelCapabilities(model)?.effortMarkers ===
    'with-adaptive-thinking'
  )
}

/**
 * Whether the model's Claude Code main beta list includes `PER_TURN_CONTROL_BETA`.
 * Sending the beta does not by itself make a request eligible for effort markers.
 */
export function sendsPerTurnControlBeta(model: unknown): boolean {
  return (
    resolveClaudeModelCapabilities(model)?.claudeCodeBetas.main.includes(
      PER_TURN_CONTROL_BETA,
    ) ?? false
  )
}

/**
 * Whether a request may move effort changes into empty system messages.
 *
 * Check thinking only when the model requires adaptive thinking for markers.
 * Anthropic rejects a differing per-message effort on Sonnet 5.5 without
 * up-front thinking (`between_tools`) and on Haiku 5.5 with disabled thinking.
 */
export function supportsPerMessageEffort(
  body: Record<string, unknown>,
): boolean {
  if (pinsEffortOnEveryRequest(body.model)) return true
  return (
    usesPerTurnControl(body.model) &&
    isRecord(body.thinking) &&
    body.thinking.type === 'adaptive'
  )
}

/**
 * The effort Anthropic applies when a request sets no `output_config.effort`:
 * the capability row's default (`medium` on Opus 5.5 and Haiku 5.5), and
 * `high` on models without a row.
 * A history entry without a recognized effort level uses this value.
 */
export function defaultAdaptiveEffort(model: unknown): AdaptiveEffort {
  return resolveClaudeModelCapabilities(model)?.efforts.default ?? 'high'
}

function compactTransitions(
  transitions: readonly MidConversationEffortTransition[],
) {
  const compacted: MidConversationEffortTransition[] = []
  for (const transition of transitions) {
    if (
      !Number.isSafeInteger(transition.afterAssistantMessages) ||
      transition.afterAssistantMessages < 0 ||
      !normalizeAdaptiveEffort(transition.effort)
    ) {
      continue
    }
    const normalized = {
      afterAssistantMessages: transition.afterAssistantMessages,
      effort: transition.effort,
    }
    const previous = compacted.at(-1)
    if (
      previous &&
      previous.afterAssistantMessages === normalized.afterAssistantMessages
    ) {
      previous.effort = normalized.effort
      continue
    }
    if (previous?.effort === normalized.effort) continue
    compacted.push(normalized)
  }
  return compacted
}

export function applyMidConversationOutputConfig(
  body: Record<string, unknown>,
  transitions: readonly MidConversationEffortTransition[],
): { applied: boolean; inserted: number } {
  if (!supportsPerMessageEffort(body) || !Array.isArray(body.messages)) {
    return { applied: false, inserted: 0 }
  }

  const compacted = compactTransitions(transitions)
  // Only `always` rows pin top-level effort on requests without an effort change.
  const pinsEveryRequest = pinsEffortOnEveryRequest(body.model)
  if (!pinsEveryRequest && compacted.length < 2) {
    return { applied: false, inserted: 0 }
  }
  const currentOutputConfig = isRecord(body.output_config)
    ? body.output_config
    : {}
  const baseline =
    compacted[0]?.effort ??
    normalizeAdaptiveEffort(currentOutputConfig.effort) ??
    defaultAdaptiveEffort(body.model)
  const pinnedOutputConfig = { ...currentOutputConfig, effort: baseline }
  if (pinsEveryRequest) body.output_config = pinnedOutputConfig

  if (compacted.length < 2) return { applied: true, inserted: 0 }

  const messages = body.messages as unknown[]
  const transitionsByBoundary = new Map<number, AdaptiveEffort>()
  for (const transition of compacted.slice(1)) {
    transitionsByBoundary.set(
      transition.afterAssistantMessages,
      transition.effort,
    )
  }

  let assistantMessages = 0
  let activeEffort = baseline
  let inserted = 0
  const rewritten: unknown[] = []
  for (const message of messages) {
    if (
      isRecord(message) &&
      message.role === 'user' &&
      transitionsByBoundary.has(assistantMessages)
    ) {
      const effort = transitionsByBoundary.get(assistantMessages)
      if (effort && effort !== activeEffort) {
        rewritten.push({
          role: 'system',
          content: [],
          output_config: { effort },
        })
        activeEffort = effort
        inserted++
      }
    }
    rewritten.push(message)
    if (isRecord(message) && message.role === 'assistant') assistantMessages++
  }

  // Without an inserted marker the top-level effort is the only effort in
  // force, so the other models keep the host's value rather than an earlier one.
  if (!pinsEveryRequest && inserted === 0) {
    return { applied: false, inserted: 0 }
  }
  body.output_config = pinnedOutputConfig
  body.messages = rewritten
  return { applied: true, inserted }
}
