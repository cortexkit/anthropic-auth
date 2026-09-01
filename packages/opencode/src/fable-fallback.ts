import {
  CLAUDE_FABLE_5_1_MODEL_ID,
  CLAUDE_FABLE_5_MODEL_ID,
  isClaudeOpus5Model,
} from '@cortexkit/anthropic-auth-core'

export const FABLE_FALLBACK_MODEL_ID = 'claude-opus-4-8'
export const FABLE_FALLBACK_TURNS = 10

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
  cycle: number
  cacheAccountId?: string
  standbyCacheAnchor?: FableStandbyCacheAnchor
  nextRequestSequence: number
  standbyAnchorSequence: number
  updatedAt: number
}

/**
 * Models whose content-filter refusal we recover from by downgrading to Opus 4.8
 * for a short window. Fable 5, Fable 5.1, and Opus 5 each have a separate
 * source family because recovery state must not cross-contaminate distinct
 * requested models. All three use Anthropic's `claude-opus-4-8` fallback for
 * the same classifier refusal shape and recovery period. Mythos has no
 * classifiers and Sonnet 5 is not flagged — both stay outside this gate.
 */
export type RecoverableRefusalFamily = 'fable-5' | 'fable-5-1' | 'opus-5'

export function recoverableRefusalFamily(
  model: unknown,
): RecoverableRefusalFamily | null {
  if (typeof model !== 'string') return null
  if (isClaudeOpus5Model(model)) return 'opus-5'
  if (
    model === CLAUDE_FABLE_5_1_MODEL_ID ||
    model.startsWith(`${CLAUDE_FABLE_5_1_MODEL_ID}-`)
  ) {
    return 'fable-5-1'
  }
  if (
    model === CLAUDE_FABLE_5_MODEL_ID ||
    model.startsWith(`${CLAUDE_FABLE_5_MODEL_ID}-`)
  ) {
    return 'fable-5'
  }
  return null
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

  plan(
    sessionId: string | null | undefined,
    bodyText: unknown,
  ): FableFallbackPlan | null {
    if (!sessionId || typeof bodyText !== 'string') return null
    const parsed = parseBody(bodyText)
    if (!parsed || !isRecoverableRefusalModel(parsed.model)) return null
    const recoveryKey = fallbackRecoveryKey(sessionId, parsed.model)
    if (!recoveryKey) return null

    this.prune()
    const state = this.recoveries.get(recoveryKey)
    if (!state || state.remaining <= 0) {
      return {
        sessionId,
        recoveryKey,
        requestedModel: parsed.model,
        effectiveModel: parsed.model,
        bodyText,
        downgraded: false,
        standbyCacheAnchor: state?.standbyCacheAnchor,
      }
    }

    state.updatedAt = this.now()
    state.nextRequestSequence++
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
    state.updatedAt = this.now()
    plan.cacheAccountId = oauthAccountId
    plan.standbyCacheAnchor = undefined
    return true
  }

  activate(plan: FableFallbackPlan, cacheAccountId?: string): number {
    if (plan.downgraded || !isRecoverableRefusalModel(plan.requestedModel)) {
      return this.remaining(plan)
    }
    const state: FableFallbackState = {
      model: plan.requestedModel,
      remaining: FABLE_FALLBACK_TURNS,
      cycle: this.nextCycle++,
      cacheAccountId,
      standbyCacheAnchor: plan.standbyCacheAnchor,
      nextRequestSequence: 0,
      standbyAnchorSequence: 0,
      updatedAt: this.now(),
    }
    this.recoveries.delete(plan.recoveryKey)
    this.recoveries.set(plan.recoveryKey, state)
    this.prune()
    return state.remaining
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
    // Retain the zero-remaining state so a later refusal can bridge back
    // to this model-specific Opus cache boundary without continuously warming
    // Opus while the original model is healthy.
    this.recoveries.delete(plan.recoveryKey)
    this.recoveries.set(plan.recoveryKey, state)
    return { counted: true, remaining: state.remaining }
  }

  remaining(plan: FableFallbackPlan): number {
    this.prune()
    return this.recoveries.get(plan.recoveryKey)?.remaining ?? 0
  }
}
