import { createHash } from 'node:crypto'
import {
  type AdaptiveEffort,
  applyMidConversationOutputConfig,
  defaultAdaptiveEffort,
  type MidConversationEffortTransition,
  normalizeAdaptiveEffort,
  supportsPerMessageEffort,
} from '@cortexkit/anthropic-auth-core'
import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai'

/** Unknown Pi options survive provider dispatch; only a distinct, named fork opts in. */
export function piForkHeadSession(
  options?: SimpleStreamOptions,
): string | undefined {
  const fork = (options as { cortexkitFork?: unknown } | undefined)
    ?.cortexkitFork
  if (!options?.sessionId || !fork || typeof fork !== 'object') return undefined
  const head = (fork as { headSessionId?: unknown }).headSessionId
  return typeof head === 'string' &&
    head.trim().length > 0 &&
    head !== options.sessionId
    ? head
    : undefined
}

/** Effort levels Agent Runner may ask a fork to answer at. It can only lower effort. */
export type PiForkEffortHint = 'low' | 'medium' | 'high'

/**
 * The fork's requested answer effort, or undefined when the request is not a
 * valid fork or the value is not one of the levels Agent Runner defines.
 */
export function piForkEffortHint(
  options?: SimpleStreamOptions,
): PiForkEffortHint | undefined {
  if (!piForkHeadSession(options)) return undefined
  const effort = (
    options as { cortexkitFork?: { effort?: unknown } } | undefined
  )?.cortexkitFork?.effort
  return effort === 'low' || effort === 'medium' || effort === 'high'
    ? effort
    : undefined
}

/** Set on a fork's reply only when its effort hint changed the request. */
export type PiForkReplyReport = {
  cortexkitFork?: { effortApplied: PiForkEffortHint }
}

const EFFORT_RANK: Record<AdaptiveEffort, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function topLevelEffort(body: Record<string, unknown>): AdaptiveEffort {
  return (
    normalizeAdaptiveEffort(
      isRecord(body.output_config) ? body.output_config.effort : undefined,
    ) ?? defaultAdaptiveEffort(body.model)
  )
}

/**
 * Apply the fork base's effort history to `body`, as a head request would, and
 * lower the effort of the fork's question (its last message) to `hint` when
 * that is safe. Returns the hint only when it changed the request.
 *
 * The hint becomes one more effort transition at the question's user turn, so
 * the model receives it exactly as a head's own mid-conversation effort change.
 * It applies only when it is lower than the effort in force at the question,
 * and only on models that accept a per-message effort without moving the
 * top-level effort. Every message before the question and the top-level effort
 * must come out identical to the request without the hint, because the fork
 * reads the head's prompt cache; otherwise the hint is dropped.
 *
 * Like the base history, this decides on Pi's own body before the host's
 * `onPayload` hook runs.
 */
export function applyPiForkEffort(
  body: Record<string, unknown>,
  transitions: readonly MidConversationEffortTransition[],
  hint?: PiForkEffortHint,
): PiForkEffortHint | undefined {
  if (!hint) {
    applyMidConversationOutputConfig(body, transitions)
    return undefined
  }
  // applyMidConversationOutputConfig replaces `messages` and `output_config`
  // rather than editing them, so shallow copies keep `body` untouched.
  const base = { ...body }
  const baseResult = applyMidConversationOutputConfig(base, transitions)
  const lowered = loweredQuestionEffort(
    base,
    body,
    transitions,
    baseResult,
    hint,
  )
  Object.assign(body, lowered ?? base)
  return lowered ? hint : undefined
}

function loweredQuestionEffort(
  base: Record<string, unknown>,
  original: Record<string, unknown>,
  transitions: readonly MidConversationEffortTransition[],
  baseResult: { applied: boolean },
  hint: PiForkEffortHint,
): Record<string, unknown> | undefined {
  if (!supportsPerMessageEffort(original) || !Array.isArray(base.messages))
    return undefined
  const baseMessages = base.messages as unknown[]
  const question = baseMessages.at(-1)
  const previous = baseMessages.at(-2)
  // A marker lands before the first user message after an assistant reply. If
  // the question is not that message, the marker would land earlier and change
  // bytes the head already cached.
  if (
    !isRecord(question) ||
    question.role !== 'user' ||
    !isRecord(previous) ||
    previous.role !== 'assistant'
  )
    return undefined

  const topLevel = topLevelEffort(base)
  let inForce = topLevel
  for (const message of baseMessages) {
    if (
      isRecord(message) &&
      message.role === 'system' &&
      isRecord(message.output_config)
    )
      inForce = normalizeAdaptiveEffort(message.output_config.effort) ?? inForce
  }
  if (EFFORT_RANK[hint] >= EFFORT_RANK[inForce]) return undefined

  const questionBoundary = baseMessages.filter(
    (message) => isRecord(message) && message.role === 'assistant',
  ).length
  // Start from the top-level effort the base request sends. Base transitions
  // only count when they changed that request; otherwise the top-level effort
  // was in force throughout.
  const lowered = { ...original }
  const result = applyMidConversationOutputConfig(lowered, [
    { afterAssistantMessages: 0, effort: topLevel },
    ...(baseResult.applied ? transitions : []),
    { afterAssistantMessages: questionBoundary, effort: hint },
  ])
  const messages = lowered.messages as unknown[]
  const marker = messages.at(-2)
  if (
    !result.applied ||
    messages.length !== baseMessages.length + 1 ||
    messages.at(-1) !== question ||
    !isRecord(marker) ||
    marker.role !== 'system' ||
    !isRecord(marker.output_config) ||
    marker.output_config.effort !== hint ||
    JSON.stringify(lowered.output_config) !==
      JSON.stringify(base.output_config) ||
    JSON.stringify(messages.slice(0, -2)) !==
      JSON.stringify(baseMessages.slice(0, -1))
  )
    return undefined
  return lowered
}

export class PiForkRefusal extends Error {
  constructor(kind: 'routing' | 'account' | 'limit' | 'failed' | 'base') {
    super(
      {
        routing: 'Shared routing has no admission for this fork request.',
        account: 'The admitted account cannot serve this fork request.',
        limit: 'The admitted account declined this fork request.',
        // Upstream errors and transport failures are not account problems.
        failed: 'The fork request failed before an answer arrived.',
        base: 'The retained head request is unavailable for this fork (fork_base_unavailable).',
      }[kind],
    )
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

function messageDigests(context: Context): string[] {
  return context.messages.map((message) =>
    createHash('sha256')
      .update(JSON.stringify(canonical(message)))
      .digest('hex'),
  )
}

type EffortSnapshot = {
  digests: string[]
  transitions: MidConversationEffortTransition[]
}

/** Retain provenance, not prompts: a later head turn must not reshape an older fork base. */
export class PiForkEffortSnapshots {
  private readonly sessions = new Map<string, EffortSnapshot[]>()

  record(
    sessionId: string,
    context: Context,
    transitions: readonly MidConversationEffortTransition[] = [],
  ) {
    const snapshots = this.sessions.get(sessionId) ?? []
    snapshots.push({
      digests: messageDigests(context),
      transitions: transitions.map((item) => ({ ...item })),
    })
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, snapshots.slice(-8))
    const oldest = this.sessions.keys().next().value
    if (this.sessions.size > 128 && oldest !== undefined)
      this.sessions.delete(oldest)
  }

  match(
    headSessionId: string,
    context: Context,
  ): {
    messageCount: number
    transitions: readonly MidConversationEffortTransition[]
  } {
    const digests = messageDigests(context)
    let snapshot: EffortSnapshot | undefined
    for (const candidate of this.sessions.get(headSessionId) ?? []) {
      if (
        (!snapshot || candidate.digests.length >= snapshot.digests.length) &&
        candidate.digests.length <= digests.length &&
        candidate.digests.every((digest, index) => digest === digests[index])
      )
        snapshot = candidate
    }
    if (!snapshot) throw new PiForkRefusal('base')
    return {
      messageCount: snapshot.digests.length,
      transitions: snapshot.transitions,
    }
  }

  forget(sessionId: string) {
    this.sessions.delete(sessionId)
  }
}

export const piForkEffortSnapshots = new PiForkEffortSnapshots()
