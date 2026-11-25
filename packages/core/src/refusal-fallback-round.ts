import { applyEdits, modify } from 'jsonc-parser'
import {
  type ClaudeRefusalRecoveryFamily,
  resolveClaudeModelCapabilities,
  resolveClaudeModelTokenLimits,
} from './model-capabilities.ts'
import {
  type RefusalFallbackDispatchLifecycle,
  type RefusalFallbackResendOptions,
  resendRefusalFallbackSource,
} from './refusal-fallback-dispatch.ts'
import {
  estimateRefusalFallbackInput,
  type RefusalFallbackEstimateBase,
  refusalBodyRecord,
  refusalFallbackEstimateBase,
} from './refusal-fallback-prefix.ts'
import {
  fitRefusalFallbackTarget,
  foldRefusalFallbackEffort,
  isRefusalFallbackBodyValid,
  measuredInputTokens,
  selectRefusalFallbackTarget,
} from './refusal-fallback-targets.ts'
import type { RefusalFallbackMode } from './settings-definition.ts'

declare const requestHandle: unique symbol
export type RefusalFallbackRoundRequest = { readonly [requestHandle]: true }

export type RefusalFallbackRoundEnd =
  | 'count'
  | 'compaction'
  | 'account'
  | 'route'
  | 'quota'
  | 'model'
  | 'mode'
  | 'target-400'
  | 'window'
  | 'budget'

type RoundInfo = Readonly<{
  sessionId: string
  requestedModel: string
  servingModel: string
  category: string
  stepsLeft: number
}>

export type RefusalFallbackRoundEvent = RoundInfo &
  (
    | { kind: 'round_started' | 'step_served' }
    | { kind: 'round_ended'; reason: RefusalFallbackRoundEnd }
  )

export type RefusalFallbackRoundInput = {
  sessionId: string
  requestedModel: string
  kind: string
  mode: RefusalFallbackMode
  /** Full source-transformed JSON before thread preparation; headers stay with the host. */
  bodyText: string
  /** The final route chosen for the source; omit for ineligible and non-OAuth routes. */
  oauth?: {
    accountId: string
    targetAllowed: (model: string) => boolean
  }
  /** Result of comparing the host's normalized history with the round checkpoint. */
  compacted?: boolean
  /** Apply thinking policy before swapping. Source filtering is confined to the latest mixed turn. */
  filterBody?: (
    bodyText: string,
    route: { kind: 'source' } | { kind: 'target'; round: symbol },
  ) => string
}

export type RefusalFallbackRoundPlan =
  | Readonly<{
      kind: 'source'
      bodyText: string
      request?: RefusalFallbackRoundRequest
    }>
  | Readonly<{
      kind: 'round' | 'routed'
      bodyText: string
      servingModel: string
      folded: boolean
      request: RefusalFallbackRoundRequest
    }>

type Round = Omit<RoundInfo, 'stepsLeft'> & {
  identity: symbol
  accountId: string
  mode: 'client'
  stepsLeft: number
  folded: boolean
  base?: RefusalFallbackEstimateBase
}

type FamilyState = {
  level: number
  clean: number
  recent: boolean
  round?: Round
}

type Session = {
  model: string
  latest?: symbol
  families: Map<ClaudeRefusalRecoveryFamily, FamilyState>
}

type Request = {
  kind: 'source' | 'round' | 'routed'
  sessionId: string
  session: Session
  family: FamilyState
  accountId: string
  round?: Round
  sourceBodyText: string
  baseBodyText: string
  identity: symbol
  folded: boolean
  phase: 'planned' | 'sent' | 'refusal' | 'finished'
  category?: string
  handling400?: boolean
}

function parse(bodyText: string) {
  try {
    return refusalBodyRecord(JSON.parse(bodyText))
  } catch {
    return undefined
  }
}

function base(text: string, usage?: Readonly<Record<string, unknown>>) {
  const body = parse(text)
  const tokens = measuredInputTokens(usage)
  return body && tokens !== undefined
    ? refusalFallbackEstimateBase(body, tokens)
    : undefined
}

function update(text: string, field: string, value: unknown) {
  return applyEdits(text, modify(text, [field], value, {}))
}

function fitFailure(
  model: string,
  body: Record<string, unknown>,
): 'window' | 'budget' {
  const limits = resolveClaudeModelTokenLimits(model)
  const budget = refusalBodyRecord(body.thinking)?.budget_tokens
  return limits &&
    typeof body.max_tokens === 'number' &&
    typeof budget === 'number' &&
    budget >= Math.min(body.max_tokens, limits.maxOutputTokens)
    ? 'budget'
    : 'window'
}

function earlyEnd(
  round: Round,
  { mode, oauth, compacted }: RefusalFallbackRoundInput,
): RefusalFallbackRoundEnd | undefined {
  if (mode !== round.mode) return 'mode'
  if (!oauth) return 'route'
  if (oauth.accountId !== round.accountId) return 'account'
  if (!oauth.targetAllowed(round.servingModel)) return 'quota'
  if (compacted) return 'compaction'
}

function sourceBound(input: RefusalFallbackRoundInput): string {
  return (
    input.filterBody?.(input.bodyText, { kind: 'source' }) ?? input.bodyText
  )
}

/** Process-local client round state. The host owns routing, headers, threads and transport. */
export class RefusalFallbackRoundEngine {
  readonly #sessions = new Map<string, Session>()
  readonly #requests = new WeakMap<RefusalFallbackRoundRequest, Request>()

  constructor(
    private readonly observe?: (event: RefusalFallbackRoundEvent) => void,
  ) {}

  forgetSession(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }

  #emit(
    round: Round,
    kind: 'round_started' | 'step_served' | 'round_ended',
    reason?: RefusalFallbackRoundEnd,
  ) {
    const { sessionId, requestedModel, servingModel, category, stepsLeft } =
      round
    const info = {
      sessionId,
      requestedModel,
      servingModel,
      category,
      stepsLeft,
    }
    try {
      if (kind === 'round_ended') {
        if (reason) this.observe?.({ ...info, kind, reason })
      } else this.observe?.({ ...info, kind })
    } catch {
      // An observer must not affect request routing or accounting.
    }
  }

  #end(family: FamilyState, round: Round, reason: RefusalFallbackRoundEnd) {
    if (family.round !== round) return
    family.round = undefined
    this.#emit(round, 'round_ended', reason)
  }

  #handle(
    request: Omit<Request, 'identity' | 'phase'>,
  ): RefusalFallbackRoundRequest {
    const handle = Object.freeze({}) as RefusalFallbackRoundRequest
    this.#requests.set(handle, {
      ...request,
      identity: Symbol(),
      phase: 'planned',
    })
    return handle
  }

  /** Call after source routing, source transform and source headers; then thread and sign the plan. */
  plan(input: RefusalFallbackRoundInput): RefusalFallbackRoundPlan {
    const unchanged = { kind: 'source', bodyText: input.bodyText } as const
    if (input.kind !== 'primary') return unchanged
    const { requestedModel, sessionId, oauth } = input
    let session = this.#sessions.get(sessionId)
    let endedForModel = false
    if (session && session.model !== requestedModel) {
      this.#sessions.delete(sessionId)
      for (const family of session.families.values()) {
        if (family.round) {
          endedForModel = true
          this.#end(family, family.round, 'model')
        }
      }
      session = undefined
    }
    const familyId =
      resolveClaudeModelCapabilities(requestedModel)?.refusalRecoveryFamily
    if (!familyId)
      return endedForModel
        ? { kind: 'source', bodyText: sourceBound(input) }
        : unchanged
    const existing = session?.families.get(familyId)
    const round = existing?.round
    if (session && existing && round) {
      const reason = earlyEnd(round, input)
      if (reason) this.#end(existing, round, reason)
      else if (oauth) {
        const target = this.#planTarget(
          input,
          session,
          existing,
          round,
          oauth,
          'round',
        )
        if (typeof target !== 'string') return target
        if (target !== 'source') this.#end(existing, round, target)
      }
    }
    if (input.mode !== 'client' || !oauth) {
      return round || endedForModel
        ? { kind: 'source', bodyText: sourceBound(input) }
        : unchanged
    }
    const bodyText = sourceBound(input)
    if (!session) {
      session = { model: requestedModel, families: new Map() }
      this.#sessions.set(sessionId, session)
    }
    const family = existing ?? { clean: 0, level: 0, recent: false }
    session.families.set(familyId, family)
    return {
      kind: 'source',
      bodyText,
      request: this.#handle({
        kind: 'source',
        sessionId,
        session,
        family,
        accountId: oauth.accountId,
        sourceBodyText: bodyText,
        baseBodyText: bodyText,
        folded: false,
      }),
    }
  }

  /** Explicit non-primary routing. It must not create or advance a message-thread anchor. */
  planRouted(input: RefusalFallbackRoundInput): RefusalFallbackRoundPlan {
    const unchanged = { kind: 'source', bodyText: input.bodyText } as const
    const { kind, mode, requestedModel, oauth } = input
    if (
      !oauth ||
      mode !== 'client' ||
      ['primary', 'keep-warm', 'cachekeep', 'prime'].includes(kind)
    )
      return unchanged
    const session = this.#sessions.get(input.sessionId)
    if (session?.model !== requestedModel) return unchanged
    const familyId =
      resolveClaudeModelCapabilities(requestedModel)?.refusalRecoveryFamily
    const family = familyId && session.families.get(familyId)
    const round = family?.round
    if (
      family &&
      round &&
      round.accountId === oauth.accountId &&
      oauth.targetAllowed(round.servingModel)
    ) {
      const plan = this.#planTarget(
        input,
        session,
        family,
        round,
        oauth,
        'routed',
      )
      if (typeof plan !== 'string') return plan
    }
    return { kind: 'source', bodyText: sourceBound(input) }
  }

  #planTarget(
    input: RefusalFallbackRoundInput,
    session: Session,
    family: FamilyState,
    round: Round,
    oauth: NonNullable<RefusalFallbackRoundInput['oauth']>,
    kind: 'round' | 'routed',
  ): RefusalFallbackRoundPlan | 'window' | 'budget' | 'source' {
    const servingModel = round.servingModel
    const baseBodyText =
      input.filterBody?.(input.bodyText, {
        kind: 'target',
        round: round.identity,
      }) ?? input.bodyText
    const prepared = parse(baseBodyText)
    if (!prepared) return 'window'
    let folded = round.folded
    if (!folded && !isRefusalFallbackBodyValid(servingModel, prepared)) {
      if (kind === 'routed') return 'source'
      folded = true
    }
    const body = folded
      ? foldRefusalFallbackEffort(input.requestedModel, prepared)
      : prepared
    const inputTokens = estimateRefusalFallbackInput(
      prepared,
      baseBodyText,
      round.base,
    )
    const maxTokens = fitRefusalFallbackTarget(servingModel, body, inputTokens)
    if (maxTokens === undefined) return fitFailure(servingModel, body)
    let bodyText = folded ? JSON.stringify(body) : baseBodyText
    bodyText = update(bodyText, 'model', servingModel)
    bodyText = update(bodyText, 'max_tokens', maxTokens)
    bodyText = update(bodyText, 'fallbacks', undefined)
    bodyText = update(bodyText, 'fallback_credit_token', undefined)
    const sourceBodyText = sourceBound(input)
    return {
      kind,
      bodyText,
      servingModel,
      folded,
      request: this.#handle({
        kind,
        session,
        family,
        round,
        sessionId: input.sessionId,
        accountId: oauth.accountId,
        sourceBodyText,
        baseBodyText,
        folded,
      }),
    }
  }

  /** Call once immediately before the initial physical send. Replan if it returns false. */
  markSent(handle: RefusalFallbackRoundRequest): boolean {
    const request = this.#requests.get(handle)
    if (
      request?.phase !== 'planned' ||
      this.#sessions.get(request.sessionId) !== request.session ||
      request.family.round !== request.round ||
      (request.round?.folded && !request.folded)
    )
      return false
    request.phase = 'sent'
    if (request.kind !== 'routed') {
      request.session.latest = request.identity
      if (request.round && request.folded) request.round.folded = true
    }
    return true
  }

  #isNewestPrimary(request: Request) {
    return (
      this.#sessions.get(request.sessionId) === request.session &&
      request.session.latest === request.identity
    )
  }

  #isCurrentPrimary(request: Request) {
    return (
      this.#isNewestPrimary(request) && request.family.round === request.round
    )
  }

  #start(
    request: Request,
    category: string,
    target: { model: string; folded: boolean },
    inputBase: RefusalFallbackEstimateBase | undefined,
    retry: boolean,
  ) {
    const { family, session, sessionId, accountId } = request
    family.level = family.recent ? Math.min(family.level + 1, 2) : 0
    family.clean = 0
    family.recent = true
    const round: Round = {
      identity: Symbol(),
      sessionId,
      requestedModel: session.model,
      servingModel: target.model,
      category,
      accountId,
      mode: 'client',
      stepsLeft: 10 * 2 ** family.level - (retry ? 1 : 0),
      folded: target.folded,
      base: inputBase,
    }
    family.round = round
    this.#emit(round, 'round_started')
    if (retry) this.#emit(round, 'step_served')
  }

  /** Pass to dispatch for source plans, or to the protected join for round plans. */
  lifecycle(
    handle: RefusalFallbackRoundRequest,
    {
      isFresh,
      targetAllowed,
    }: { isFresh: () => boolean; targetAllowed: (model: string) => boolean },
  ): RefusalFallbackDispatchLifecycle | undefined {
    const request = this.#requests.get(handle)
    if (!request || request.kind === 'routed') return undefined
    const fresh = () => this.#isCurrentPrimary(request) && isFresh()
    return {
      onCompleted: (completion) => {
        if (request.phase !== 'sent' || !fresh()) return
        request.phase = 'finished'
        if (request.round) {
          const round = request.round
          round.base = base(request.baseBodyText, completion.usage)
          round.stepsLeft--
          this.#emit(round, 'step_served')
          if (round.stepsLeft === 0) this.#end(request.family, round, 'count')
        } else if (++request.family.clean >= 10) {
          request.family.level = 0
          request.family.recent = false
        }
      },
      ...(request.kind === 'source' && {
        onRefusal: (refusal) => {
          if (request.phase !== 'sent' || !fresh()) return
          request.phase = 'refusal'
          request.family.clean = 0
          request.category = refusal.category
          if (!refusal.releasedTool || !refusal.category) return
          request.phase = 'finished'
          const body = parse(request.baseBodyText)
          if (!body) return
          const choice = {
            sourceModel:
              typeof body.model === 'string'
                ? body.model
                : request.session.model,
            category: refusal.category,
            body,
            refusedUsage: refusal.usage,
          }
          let target = selectRefusalFallbackTarget(choice)
          const folded =
            target.kind === 'none' && target.reason === 'no-fitting-target'
          if (folded)
            target = selectRefusalFallbackTarget({ ...choice, phase: 'folded' })
          if (
            target.kind === 'target' &&
            targetAllowed(target.model) &&
            fresh()
          )
            this.#start(
              request,
              refusal.category,
              { model: target.model, folded },
              base(request.baseBodyText, refusal.usage),
              false,
            )
        },
        onRetryCompleted: (completion, target) => {
          if (request.phase !== 'refusal' || !request.category || !fresh())
            return
          request.phase = 'finished'
          this.#start(
            request,
            request.category,
            target,
            base(request.baseBodyText, completion.usage),
            true,
          )
        },
      }),
    }
  }

  /** Call on the final response after ordinary thread recovery, before host consumption. */
  async handleTarget400(
    handle: RefusalFallbackRoundRequest,
    response: Response,
    options: RefusalFallbackResendOptions & {
      /** Check that this is still the newest primary and its model and account match; ignore mode. */
      isCurrentPrimary: () => boolean
    },
  ): Promise<Response> {
    const request = this.#requests.get(handle)
    if (
      !request?.round ||
      request.phase !== 'sent' ||
      response.status !== 400 ||
      request.handling400 ||
      options.origin.accountId !== request.accountId
    )
      return response
    const round = request.round
    const isNewest = () =>
      request.kind === 'routed' ||
      (this.#isNewestPrimary(request) && options.isCurrentPrimary())
    const isCurrent = () =>
      request.phase === 'sent' &&
      isNewest() &&
      (request.kind === 'routed' || request.family.round === round)
    if (!isCurrent() || options.signal?.aborted) return response
    request.handling400 = true
    return resendRefusalFallbackSource(
      response,
      request.sourceBodyText,
      options,
      isCurrent,
      () => {
        request.phase = 'finished'
        if (request.kind === 'round')
          this.#end(request.family, round, 'target-400')
      },
      isNewest,
    )
  }
}
