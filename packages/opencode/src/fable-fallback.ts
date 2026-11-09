import {
  type ClaudeRefusalRecoveryFamily,
  resolveClaudeModelCapabilities,
} from '@cortexkit/anthropic-auth-core'

export const FABLE_FALLBACK_MODEL_ID = 'claude-opus-4-8'
export const FABLE_FALLBACK_TURNS = 10

/**
 * CacheKeep target key for one recovery round's source-model warm. The
 * `source-warm:` prefix keeps it out of the session's live target keyspace,
 * and the family suffix keeps concurrent rounds for different source models
 * in the same session on their own targets.
 */
export const SOURCE_WARM_TARGET_PREFIX = 'source-warm:'

export function sourceWarmTargetId(
  sessionId: string,
  family: RecoverableRefusalFamily,
): string {
  return `${SOURCE_WARM_TARGET_PREFIX}${sessionId}:${family}`
}

export function parseSourceWarmTargetId(
  id: string,
): { sessionId: string; family: RecoverableRefusalFamily } | null {
  if (!id.startsWith(SOURCE_WARM_TARGET_PREFIX)) return null
  const rest = id.slice(SOURCE_WARM_TARGET_PREFIX.length)
  const separator = rest.lastIndexOf(':')
  if (separator <= 0) return null
  const sessionId = rest.slice(0, separator)
  const family = rest.slice(separator + 1)
  if (
    family !== 'fable-5' &&
    family !== 'fable-5-1' &&
    family !== 'fable-5-2' &&
    family !== 'opus-5' &&
    family !== 'opus-5-5'
  ) {
    return null
  }
  return { sessionId, family }
}

export function sourceWarmRecoveryKey(
  sessionId: string,
  family: RecoverableRefusalFamily,
): string {
  return `${sessionId}\0${family}`
}

/**
 * The source request a recovery round keeps alive: the exact signed bytes
 * the plugin sent to the source model (normally the refused request), bound
 * to the OAuth account that sent it. In memory only; a restart drops it
 * along with the process-local round state.
 */
export type FableSourceWarmInit = {
  bodyText: string
  oauthAccountId: string
  accountIdentity?: string
  sentAt: number
  model: string
  firstAnchorFingerprint?: string
  lastUserTurnKey?: string
  url: string
  headers: Record<string, string>
  subagent?: boolean
}

export type FableSourceWarmKeep = FableSourceWarmInit & {
  warmsSinceUserTurn: number
}

export type FableStandbyCacheAnchor = {
  fingerprint: string
  messageIndex: number
  messageCount: number
  oauthAccountId: string
}

const MAX_TRACKED_RECOVERIES = 128
const RECOVERY_TTL_MS = 24 * 60 * 60_000

export type FableFallbackPlan = {
  sessionId: string
  recoveryKey: string
  requestedModel: string
  effectiveModel: string
  bodyText: string
  downgraded: boolean
  cycle?: number
  cacheAccountId?: string
  standbyCacheAnchor?: FableStandbyCacheAnchor
  requestSequence?: number
  completed?: boolean
}

type FableFallbackState = {
  model: string
  remaining: number
  reRefusals: number
  sourceSuccesses: number
  cycle: number
  cacheAccountId?: string
  standbyCacheAnchor?: FableStandbyCacheAnchor
  sourceWarm?: FableSourceWarmKeep
  nextRequestSequence: number
  standbyAnchorSequence: number
  updatedAt: number
}

/**
 * Models whose content-filter refusal we recover from by downgrading to Opus 4.8
 * for a bounded window: capability rows with a `refusalRecoveryFamily` (Fable 5,
 * Fable 5.1, Fable 5.2, Opus 5 and Opus 5.5). Each has a separate source family because
 * recovery state must not cross-contaminate distinct requested models. All use
 * Anthropic's `claude-opus-4-8` fallback for the same classifier refusal shape
 * and recovery period. Mythos has no classifiers and Sonnet 5 is not flagged —
 * both stay outside this gate.
 */
export type RecoverableRefusalFamily = ClaudeRefusalRecoveryFamily

export function recoverableRefusalFamily(
  model: unknown,
): RecoverableRefusalFamily | null {
  return resolveClaudeModelCapabilities(model)?.refusalRecoveryFamily ?? null
}

export function isRecoverableRefusalModel(model: unknown): model is string {
  return recoverableRefusalFamily(model) !== null
}

function fallbackRecoveryKey(sessionId: string, model: string) {
  const family = recoverableRefusalFamily(model)
  return family ? `${sessionId}\0${family}` : null
}

function parseBody(bodyText: string) {
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>
    return typeof body.model === 'string' ? { body, model: body.model } : null
  } catch {
    return null
  }
}

export class FableFallbackManager {
  private readonly recoveries = new Map<string, FableFallbackState>()
  private readonly selectedModels = new Map<string, string>()
  private nextCycle = 1

  constructor(private readonly now: () => number = Date.now) {}

  private prune() {
    const now = this.now()
    for (const [recoveryKey, state] of this.recoveries) {
      if (now - state.updatedAt >= RECOVERY_TTL_MS) {
        this.recoveries.delete(recoveryKey)
      }
    }
    while (this.recoveries.size > MAX_TRACKED_RECOVERIES) {
      const oldest = this.recoveries.keys().next().value
      if (typeof oldest !== 'string') break
      this.recoveries.delete(oldest)
    }
  }

  clearSession(sessionId: string) {
    this.selectedModels.delete(sessionId)
    for (const key of this.recoveries.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.recoveries.delete(key)
    }
  }

  resetForModelChange(sessionId: string, model: string) {
    const previous = this.selectedModels.get(sessionId)
    const changed = previous !== undefined && previous !== model
    if (changed) this.clearSession(sessionId)
    this.selectedModels.delete(sessionId)
    this.selectedModels.set(sessionId, model)
    while (this.selectedModels.size > MAX_TRACKED_RECOVERIES) {
      const oldest = this.selectedModels.keys().next().value
      if (oldest === undefined) break
      this.selectedModels.delete(oldest)
    }
    return changed
  }

  plan(
    sessionId: string | null | undefined,
    bodyText: unknown,
  ): FableFallbackPlan | null {
    if (!sessionId || typeof bodyText !== 'string') return null
    this.prune()
    // Source probes and other source families are session activity too. In
    // particular, an exhausted round must not age out during a long source run.
    for (const [key, recovery] of [...this.recoveries]) {
      if (!key.startsWith(`${sessionId}\0`)) continue
      recovery.updatedAt = this.now()
      this.recoveries.delete(key)
      this.recoveries.set(key, recovery)
    }
    const parsed = parseBody(bodyText)
    if (!parsed || !isRecoverableRefusalModel(parsed.model)) return null
    const recoveryKey = fallbackRecoveryKey(sessionId, parsed.model)
    if (!recoveryKey) return null
    const state = this.recoveries.get(recoveryKey)
    if (state) state.nextRequestSequence++
    if (!state || state.remaining <= 0) {
      return {
        sessionId,
        recoveryKey,
        requestedModel: parsed.model,
        effectiveModel: parsed.model,
        bodyText,
        downgraded: false,
        cycle: state?.cycle,
        standbyCacheAnchor: state?.standbyCacheAnchor,
      }
    }

    state.updatedAt = this.now()
    this.recoveries.delete(recoveryKey)
    this.recoveries.set(recoveryKey, state)
    parsed.body.model = FABLE_FALLBACK_MODEL_ID
    return {
      sessionId,
      recoveryKey,
      requestedModel: state.model,
      effectiveModel: FABLE_FALLBACK_MODEL_ID,
      bodyText: JSON.stringify(parsed.body),
      downgraded: true,
      cycle: state.cycle,
      cacheAccountId: state.cacheAccountId,
      standbyCacheAnchor: state.standbyCacheAnchor,
      requestSequence: state.nextRequestSequence,
    }
  }

  recoveryAccount(plan: FableFallbackPlan) {
    if (plan.cycle === undefined) return plan.cacheAccountId
    const state = this.recoveries.get(plan.recoveryKey)
    return state?.cycle === plan.cycle
      ? state.cacheAccountId
      : plan.cacheAccountId
  }

  bindRecoveryAccount(plan: FableFallbackPlan, oauthAccountId: string) {
    if (!plan.downgraded || plan.cycle === undefined) return false
    const state = this.recoveries.get(plan.recoveryKey)
    if (!state || state.cycle !== plan.cycle) return false
    if (state.cacheAccountId === oauthAccountId) return false
    state.cacheAccountId = oauthAccountId
    state.standbyCacheAnchor = undefined
    state.standbyAnchorSequence = 0
    // The kept source body was authorized for the previous account; a warm
    // must never go to another one, so the round re-keeps its source on its
    // next refusal instead of warming a stale prefix elsewhere.
    state.sourceWarm = undefined
    state.updatedAt = this.now()
    plan.cacheAccountId = oauthAccountId
    plan.standbyCacheAnchor = undefined
    return true
  }

  activate(
    plan: FableFallbackPlan,
    cacheAccountId?: string,
    sourceWarm?: FableSourceWarmInit,
  ): number {
    if (plan.downgraded || !isRecoverableRefusalModel(plan.requestedModel)) {
      return this.remaining(plan)
    }
    const previous = this.recoveries.get(plan.recoveryKey)
    const reRefusals =
      previous && previous.sourceSuccesses < FABLE_FALLBACK_TURNS
        ? previous.reRefusals + 1
        : 0
    const state: FableFallbackState = {
      model: plan.requestedModel,
      remaining: FABLE_FALLBACK_TURNS * 2 ** Math.min(reRefusals, 2),
      reRefusals,
      sourceSuccesses: 0,
      cycle: this.nextCycle++,
      cacheAccountId,
      standbyCacheAnchor: plan.standbyCacheAnchor,
      sourceWarm: sourceWarm
        ? { ...sourceWarm, warmsSinceUserTurn: 0 }
        : undefined,
      nextRequestSequence: 0,
      standbyAnchorSequence: 0,
      updatedAt: this.now(),
    }
    this.recoveries.delete(plan.recoveryKey)
    this.recoveries.set(plan.recoveryKey, state)
    this.prune()
    return state.remaining
  }

  /** The source warm kept for one recovery round, if any. */
  sourceWarmFor(recoveryKey: string): FableSourceWarmKeep | undefined {
    return this.recoveries.get(recoveryKey)?.sourceWarm
  }

  sourceWarmForTarget(targetId: string): FableSourceWarmKeep | undefined {
    const parsed = parseSourceWarmTargetId(targetId)
    if (!parsed) return undefined
    return this.sourceWarmFor(
      sourceWarmRecoveryKey(parsed.sessionId, parsed.family),
    )
  }

  hasSourceWarmForSession(sessionId: string): boolean {
    for (const key of this.recoveries.keys()) {
      if (
        key.startsWith(`${sessionId}\0`) &&
        this.recoveries.get(key)?.sourceWarm
      ) {
        return true
      }
    }
    return false
  }

  sourceWarmsForSession(
    sessionId: string,
  ): Array<{ recoveryKey: string; warm: FableSourceWarmKeep }> {
    const warms: Array<{ recoveryKey: string; warm: FableSourceWarmKeep }> = []
    for (const [key, state] of this.recoveries) {
      if (key.startsWith(`${sessionId}\0`) && state.sourceWarm) {
        warms.push({ recoveryKey: key, warm: state.sourceWarm })
      }
    }
    return warms
  }

  /** Drop one round's kept source request without touching its backoff. */
  dropSourceWarm(recoveryKey: string): boolean {
    const state = this.recoveries.get(recoveryKey)
    if (!state?.sourceWarm) return false
    state.sourceWarm = undefined
    state.updatedAt = this.now()
    return true
  }

  dropSourceWarmForTarget(targetId: string): boolean {
    const parsed = parseSourceWarmTargetId(targetId)
    if (!parsed) return false
    return this.dropSourceWarm(
      sourceWarmRecoveryKey(parsed.sessionId, parsed.family),
    )
  }

  /** Count one dispatched source warm; returns the new idle total. */
  noteSourceWarmSent(recoveryKey: string): number | undefined {
    const warm = this.recoveries.get(recoveryKey)?.sourceWarm
    if (!warm) return undefined
    warm.warmsSinceUserTurn++
    return warm.warmsSinceUserTurn
  }

  noteSourceWarmSentForTarget(targetId: string): number | undefined {
    const parsed = parseSourceWarmTargetId(targetId)
    if (!parsed) return undefined
    return this.noteSourceWarmSent(
      sourceWarmRecoveryKey(parsed.sessionId, parsed.family),
    )
  }

  /**
   * A new user turn resets the idle warm count for every warm in the
   * session. A turn key seen for the first time is recorded without
   * counting as a reset.
   */
  noteSourceWarmUserTurn(sessionId: string, turnKey: string): boolean {
    let reset = false
    for (const [key, state] of this.recoveries) {
      const warm = key.startsWith(`${sessionId}\0`)
        ? state.sourceWarm
        : undefined
      if (!warm) continue
      if (warm.lastUserTurnKey === undefined) {
        warm.lastUserTurnKey = turnKey
        continue
      }
      if (warm.lastUserTurnKey !== turnKey) {
        warm.lastUserTurnKey = turnKey
        warm.warmsSinceUserTurn = 0
        reset = true
      }
    }
    return reset
  }

  completeSource(plan: FableFallbackPlan, servedBySource = true): boolean {
    if (plan.downgraded || plan.cycle == null || plan.completed) return false
    plan.completed = true
    const state = this.recoveries.get(plan.recoveryKey)
    if (!state || state.cycle !== plan.cycle || state.remaining > 0)
      return false
    if (!servedBySource) {
      state.sourceSuccesses = 0
      return false
    }
    state.sourceSuccesses = Math.min(
      state.sourceSuccesses + 1,
      FABLE_FALLBACK_TURNS,
    )
    state.updatedAt = this.now()
    // The source serves again: the round is over and its kept prefix can go.
    state.sourceWarm = undefined
    return true
  }

  complete(
    plan: FableFallbackPlan,
    standbyCacheAnchor?: FableStandbyCacheAnchor,
  ): { counted: boolean; remaining: number } {
    if (!plan.downgraded || plan.cycle == null || plan.completed) {
      return { counted: false, remaining: this.remaining(plan) }
    }
    plan.completed = true
    const state = this.recoveries.get(plan.recoveryKey)
    if (!state || state.cycle !== plan.cycle || state.remaining <= 0) {
      return { counted: false, remaining: state?.remaining ?? 0 }
    }

    state.remaining--
    if (
      standbyCacheAnchor &&
      (!state.cacheAccountId ||
        standbyCacheAnchor.oauthAccountId === state.cacheAccountId) &&
      plan.requestSequence != null &&
      plan.requestSequence >= state.standbyAnchorSequence
    ) {
      state.standbyCacheAnchor = standbyCacheAnchor
      state.standbyAnchorSequence = plan.requestSequence
    }
    state.updatedAt = this.now()
    // Retain refusal history and the Opus cache boundary across source probes.
    // A few successful source responses do not yet clear the refusal backoff.
    this.recoveries.delete(plan.recoveryKey)
    this.recoveries.set(plan.recoveryKey, state)
    return { counted: true, remaining: state.remaining }
  }

  remaining(plan: FableFallbackPlan): number {
    this.prune()
    return this.recoveries.get(plan.recoveryKey)?.remaining ?? 0
  }
}
