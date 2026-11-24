import {
  defaultAdaptiveEffort,
  supportsPerMessageEffort,
} from './mid-conversation-output-config.ts'
import {
  type ClaudeRefusalFallbackRoute,
  resolveClaudeModelCapabilities,
  resolveClaudeModelTokenLimits,
} from './model-capabilities.ts'

/**
 * Choose a fallback for a refused Messages request without dispatching it.
 * Pass the original source model, the exact API category, the prepared source
 * body with all messages (not a thread continuation), and the refused attempt's
 * own input_tokens, cache_read_input_tokens and cache_creation_input_tokens
 * (not the joined stream's usage). Pass the model IDs that already received a
 * retry to exclude them from both phases.
 *
 * Try `unchanged` first. After a wrong-model rejection, call again with that
 * target excluded. Once no unchanged target fits, `folded` can choose one
 * retry without a `fallback_credit_token` if the body carries effort markers.
 * A choice gives the target's model ID and clamped max_tokens. The caller folds
 * the body for a folded choice and applies the returned values before sending.
 * No choice means there was no source/category row, no measured input usage,
 * no eligible target that fits, or no markers to justify a folded retry.
 */
export function selectRefusalFallbackTarget({
  sourceModel,
  category,
  body,
  refusedUsage,
  triedTargets,
  phase = 'unchanged',
}: {
  sourceModel: string
  category: unknown
  body: Readonly<Record<string, unknown>>
  refusedUsage?: Readonly<Record<string, unknown>> | null
  triedTargets?: ReadonlySet<string>
  phase?: 'unchanged' | 'folded'
}): RefusalFallbackTargetSelection {
  const route = getRefusalFallbackRoute(sourceModel, category)
  if (!route) return { kind: 'none', reason: 'no-row' }
  const inputTokens = measuredInputTokens(refusedUsage)
  if (inputTokens === undefined) return { kind: 'none', reason: 'no-usage' }
  if (phase === 'folded' && !hasEffortMarkers(body)) {
    return { kind: 'none', reason: 'no-effort-markers' }
  }

  for (const model of route.targets) {
    if (triedTargets?.has(model)) continue
    // The folded body will have no markers, so it is valid on every target.
    if (phase === 'unchanged' && !isRefusalFallbackBodyValid(model, body)) {
      continue
    }
    const maxTokens = fitRefusalFallbackTarget(model, body, inputTokens)
    if (maxTokens !== undefined) return { kind: 'target', model, maxTokens }
  }
  return { kind: 'none', reason: 'no-fitting-target' }
}

export type RefusalFallbackTargetSelection =
  | { kind: 'target'; model: string; maxTokens: number }
  | {
      kind: 'none'
      reason: 'no-row' | 'no-usage' | 'no-fitting-target' | 'no-effort-markers'
    }

export function getRefusalFallbackRoute(
  sourceModel: unknown,
  category: unknown,
): ClaudeRefusalFallbackRoute | undefined {
  return resolveClaudeModelCapabilities(sourceModel)?.refusalFallbacks?.find(
    (route) => route.category === category,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function effortMarkerConfig(message: unknown) {
  if (!isRecord(message) || !isRecord(message.output_config)) return undefined
  if (Object.hasOwn(message.output_config, 'effort'))
    return message.output_config
  return undefined
}

function hasEffortMarkers(body: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(body.messages) && body.messages.some(effortMarkerConfig)
}

/** Only per-message effort validity; window and budget fit are separate. */
export function isRefusalFallbackBodyValid(
  targetModel: string,
  body: Readonly<Record<string, unknown>>,
): boolean {
  return (
    !hasEffortMarkers(body) ||
    supportsPerMessageEffort({ model: targetModel, thinking: body.thinking })
  )
}

/** Fold per-message effort into the newest user turn without mutating the body. */
export function foldRefusalFallbackEffort(
  sourceModel: string,
  body: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const outputConfig = isRecord(body.output_config) ? body.output_config : {}
  const messages: readonly unknown[] | undefined = Array.isArray(body.messages)
    ? body.messages
    : undefined
  const folded: unknown[] = []
  let activeEffort: string | undefined
  let newestUserEffort: string | undefined
  let removed = false
  for (const message of messages ?? []) {
    if (!isRecord(message)) {
      folded.push(message)
      continue
    }
    const config = effortMarkerConfig(message)
    if (typeof config?.effort === 'string') activeEffort = config.effort
    if (message.role === 'user') newestUserEffort = activeEffort
    if (!config) {
      folded.push(message)
      continue
    }
    removed = true
    const { effort: _effort, ...otherConfig } = config
    if (Object.keys(otherConfig).length > 0) {
      folded.push({ ...message, output_config: otherConfig })
      continue
    }
    const { output_config: _config, ...otherMessage } = message
    // Drop empty system markers, but keep content and non-effort fields.
    if (
      otherMessage.role === 'system' &&
      Array.isArray(otherMessage.content) &&
      otherMessage.content.length === 0 &&
      Object.keys(otherMessage).length === 2
    ) {
      continue
    }
    folded.push(otherMessage)
  }
  const effort =
    newestUserEffort ??
    (typeof outputConfig.effort === 'string'
      ? outputConfig.effort
      : defaultAdaptiveEffort(sourceModel))
  return {
    ...body,
    ...(removed && { messages: folded }),
    output_config: { ...outputConfig, effort },
  }
}

function measuredInputTokens(
  usage: Readonly<Record<string, unknown>> | null | undefined,
) {
  let total: number | undefined
  for (const field of [
    'input_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ] as const) {
    const count = usage?.[field]
    if (count == null) continue
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      return undefined
    }
    total = (total ?? 0) + count
  }
  return total
}

/** Return clamped max_tokens if the measured or estimated input and budget fit. */
export function fitRefusalFallbackTarget(
  targetModel: string,
  body: Readonly<Record<string, unknown>>,
  inputTokens: number,
): number | undefined {
  const limits = resolveClaudeModelTokenLimits(targetModel)
  const requested = body.max_tokens
  if (
    !limits ||
    typeof requested !== 'number' ||
    !Number.isSafeInteger(requested) ||
    requested < 1 ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0
  ) {
    return undefined
  }
  const maxTokens = Math.min(requested, limits.maxOutputTokens)
  const budget = isRecord(body.thinking)
    ? body.thinking.budget_tokens
    : undefined
  if (typeof budget === 'number' && budget >= maxTokens) return undefined
  return inputTokens + maxTokens <= limits.contextWindow ? maxTokens : undefined
}
