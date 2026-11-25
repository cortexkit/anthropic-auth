import { applyEdits, modify } from 'jsonc-parser'
import type { CacheKeepManager } from './cachekeep.ts'
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
  extendsRefusalFallbackPrefix,
  type RefusalFallbackEstimateBase,
  type RefusalFallbackPrefix,
  refusalBodyRecord,
  refusalFallbackCheckpoint,
  refusalFallbackPrefix,
} from './refusal-fallback-prefix.ts'
import type { RefusalFallbackCompletion } from './refusal-fallback-stream.ts'
import {
  fitRefusalFallbackTarget,
  foldRefusalFallbackEffort,
  isRefusalFallbackBodyValid,
  measuredInputTokens,
  selectRefusalFallbackTarget,
} from './refusal-fallback-targets.ts'
import {
  RecoveryThinkingStore,
  stripRecoveryRoundThinking,
} from './refusal-fallback-thinking.ts'
import {
  type RefusalFallbackCacheRoute,
  RefusalFallbackSourceWarm,
  type RefusalFallbackSourceWarmInput,
} from './refusal-fallback-warm.ts'
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
    /** Stable credential binding, not the rotating OAuth bearer. Required for source warming. */
    credentialId?: string
    targetAllowed: (model: string) => boolean
    sourceWarm?: RefusalFallbackSourceWarmInput
  }
  /** Result of comparing the host's normalized history with the round checkpoint. */
  compacted?: boolean
  /**
   * Optional host adjustment before Core's thinking filter. Core removes recorded
   * target thinking after source thinking in every turn, preserving a nonempty
   * message. Target routes exempt the live round's digests.
   */
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
      /** This marker takes precedence over a thread-tail cache marker. */
      sourceCacheMarkerRestored?: true
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
  credentialId?: string
  mode: 'client'
  stepsLeft: number
  folded: boolean
  base?: RefusalFallbackEstimateBase
  checkpoint: RefusalFallbackPrefix | null
  releaseThinking: () => void
}

type FamilyState = {
  level: number
  clean: number
  recent: boolean
  round?: Round
}

type Session = {
  model: string
  lifetime: object
  latest?: symbol
  accountId?: string
  returning?: symbol
  families: Map<ClaudeRefusalRecoveryFamily, FamilyState>
}

type Request = {
  kind: 'source' | 'round' | 'routed'
  sessionId: string
  session: Session
  family: FamilyState
  familyId: ClaudeRefusalRecoveryFamily
  accountId: string
  round?: Round
  sourceBodyText: string
  baseBodyText: string
  templateBodyText: string
  cacheRoute?: RefusalFallbackCacheRoute
  sourceWarm?: RefusalFallbackSourceWarmInput
  credentialId?: string
  identity: symbol
  folded: boolean
  phase: 'planned' | 'sent' | 'refusal' | 'finished'
  returning?: symbol
  category?: string
  handling400?: boolean
  publishTemplate?: (
    bodyText: string,
    servingModel: string,
    usage?: RefusalFallbackCompletion['usage'],
  ) => void
}

function parse(bodyText: string) {
  try {
    return refusalBodyRecord(JSON.parse(bodyText))
  } catch {
    return undefined
  }
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
  if (
    oauth.accountId !== round.accountId ||
    oauth.credentialId !== round.credentialId
  )
    return 'account'
  if (compacted) return 'compaction'
}

function cacheRoute(
  input: RefusalFallbackRoundInput,
): RefusalFallbackCacheRoute | undefined {
  const { oauth, mode, requestedModel } = input
  if (!oauth?.credentialId || !oauth.sourceWarm) return undefined
  return {
    accountId: oauth.accountId,
    credentialId: oauth.credentialId,
    url: oauth.sourceWarm.url,
    mode,
    requestedModel,
  }
}

export type RefusalFallbackRoundEngineOptions = {
  thinkingStore?: RecoveryThinkingStore
  cacheKeep?: CacheKeepManager
  now?: () => number
}

export type RefusalFallbackCacheKeepTemplate = Readonly<{
  bodyText: string
  servingModel: string
  usage?: RefusalFallbackCompletion['usage']
}>

export type RefusalFallbackRoundLifecycleOptions = {
  isFresh: () => boolean
  targetAllowed: (model: string) => boolean
  /**
   * Map the reply's tool IDs and names back to the form the host sends on the
   * wire (for example OpenCode's `mcp_` prefix), when the host renames them on
   * replay, so the recorded history matches what the next request carries.
   */
  projectReply?: (
    blocks: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[]
  /**
   * Receives the body keep-warm should resend for this session (the accepted
   * request before thread handling). The host computes its billing signature,
   * then checks `isCurrent` before tracking it with CacheKeep. `null` removes
   * only the session's current keep-warm body, not a separate source-model warm.
   */
  onCacheKeepTemplate?: (
    template: RefusalFallbackCacheKeepTemplate | null,
    isCurrent: () => boolean,
  ) => void | Promise<void>
}

/** Process-local client round state. The host owns routing, headers, threads and transport. */
export class RefusalFallbackRoundEngine {
  readonly #sessions = new Map<string, Session>()
  readonly #sessionLifetimes = new Map<string, object>()
  readonly #requests = new WeakMap<RefusalFallbackRoundRequest, Request>()
  readonly #thinking: RecoveryThinkingStore
  readonly #cacheKeep: CacheKeepManager | undefined
  readonly #warm: RefusalFallbackSourceWarm | undefined

  constructor(
    private readonly observe?: (event: RefusalFallbackRoundEvent) => void,
    options: RefusalFallbackRoundEngineOptions = {},
  ) {
    this.#thinking =
      options.thinkingStore ?? new RecoveryThinkingStore({ persist: false })
    this.#cacheKeep = options.cacheKeep
    if (options.cacheKeep)
      this.#warm = new RefusalFallbackSourceWarm(
        options.cacheKeep,
        options.now ?? Date.now,
      )
  }

  loadThinking(sessionId: string): Promise<void> {
    return this.#thinking.loadSession(sessionId)
  }

  forgetSession(sessionId: string): void {
    this.#sessions.delete(sessionId)
    this.#sessionLifetimes.delete(sessionId)
    this.#thinking.forgetSession(sessionId)
    this.#warm?.forgetSession(sessionId)
  }

  /** Call on sign-out or credential replacement, including with the same account UUID. */
  forgetAccount(accountId: string): void {
    this.#warm?.forgetAccount(accountId)
    for (const session of this.#sessions.values())
      if (session.accountId === accountId) session.latest = undefined
  }

  #filter(
    input: RefusalFallbackRoundInput,
    familyId?: ClaudeRefusalRecoveryFamily,
    round?: symbol,
  ): string {
    const text =
      input.filterBody?.(
        input.bodyText,
        round ? { kind: 'target', round } : { kind: 'source' },
      ) ?? input.bodyText
    if (!familyId) return text
    const digests = this.#thinking.peek(input.sessionId, familyId)
    if (!digests?.size) return text
    const body = parse(text)
    return body && stripRecoveryRoundThinking(body, digests, round)
      ? update(text, 'messages', body.messages)
      : text
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
    round.releaseThinking()
    const session = this.#sessions.get(round.sessionId)
    if (session) session.returning = round.identity
    const template = this.#cacheKeep?.trackedRequest(round.sessionId)
    if (template && parse(template.bodyText)?.model === round.servingModel)
      this.#cacheKeep?.releaseTarget(round.sessionId)
    if (reason === 'compaction') this.#warm?.forgetSession(round.sessionId)
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
    const route = cacheRoute(input)
    this.#warm?.checkPlan(sessionId, route)
    if (input.compacted) this.#warm?.forgetSession(sessionId)
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
        ? { kind: 'source', bodyText: this.#filter(input) }
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
          familyId,
          round,
          oauth,
          'round',
        )
        if (typeof target !== 'string') return target
        if (target !== 'source') this.#end(existing, round, target)
      }
    }
    let bodyText = this.#filter(input, familyId)
    if (input.mode !== 'client' || !oauth) return { kind: 'source', bodyText }
    const parsed = parse(bodyText)
    const returning = session?.returning
    const sourceCacheMarkerRestored = Boolean(
      returning && parsed && this.#warm?.restoreReturnMarker(sessionId, parsed),
    )
    if (sourceCacheMarkerRestored) bodyText = JSON.stringify(parsed)
    this.#warm?.checkSourceHistory(sessionId, parsed)
    if (!session) {
      const lifetime = this.#sessionLifetimes.get(sessionId) ?? {}
      this.#sessionLifetimes.set(sessionId, lifetime)
      session = { model: requestedModel, lifetime, families: new Map() }
      this.#sessions.set(sessionId, session)
    }
    const family = existing ?? { clean: 0, level: 0, recent: false }
    session.families.set(familyId, family)
    return {
      kind: 'source',
      bodyText,
      ...(sourceCacheMarkerRestored && { sourceCacheMarkerRestored: true }),
      request: this.#handle({
        kind: 'source',
        sessionId,
        session,
        family,
        familyId,
        accountId: oauth.accountId,
        credentialId: oauth.credentialId,
        cacheRoute: route,
        sourceWarm: oauth.sourceWarm,
        returning,
        sourceBodyText: bodyText,
        baseBodyText: bodyText,
        templateBodyText: bodyText,
        folded: false,
      }),
    }
  }

  /** Explicit non-primary routing. It must not create or advance a message-thread anchor. */
  planRouted(input: RefusalFallbackRoundInput): RefusalFallbackRoundPlan {
    const unchanged = { kind: 'source', bodyText: input.bodyText } as const
    const { kind, mode, requestedModel, oauth } = input
    if (['primary', 'keep-warm', 'cachekeep', 'prime'].includes(kind))
      return unchanged
    const familyId =
      resolveClaudeModelCapabilities(requestedModel)?.refusalRecoveryFamily
    const source = () => ({
      kind: 'source' as const,
      bodyText: this.#filter(input, familyId),
    })
    if (!oauth || mode !== 'client' || !familyId) return source()
    const session = this.#sessions.get(input.sessionId)
    if (session?.model !== requestedModel) return source()
    const family = session.families.get(familyId)
    const round = family?.round
    if (
      family &&
      round &&
      round.accountId === oauth.accountId &&
      round.credentialId === oauth.credentialId &&
      oauth.targetAllowed(round.servingModel)
    ) {
      const plan = this.#planTarget(
        input,
        session,
        family,
        familyId,
        round,
        oauth,
        'routed',
      )
      if (typeof plan !== 'string') return plan
    }
    return source()
  }

  #planTarget(
    input: RefusalFallbackRoundInput,
    session: Session,
    family: FamilyState,
    familyId: ClaudeRefusalRecoveryFamily,
    round: Round,
    oauth: NonNullable<RefusalFallbackRoundInput['oauth']>,
    kind: 'round' | 'routed',
  ):
    | RefusalFallbackRoundPlan
    | 'window'
    | 'budget'
    | 'compaction'
    | 'quota'
    | 'source' {
    const servingModel = round.servingModel
    const baseBodyText = this.#filter(input, familyId, round.identity)
    const prepared = parse(baseBodyText)
    if (!prepared) return 'window'
    if (
      kind === 'round' &&
      (!round.checkpoint ||
        !extendsRefusalFallbackPrefix(prepared, round.checkpoint))
    )
      return 'compaction'
    if (kind === 'round' && !oauth.targetAllowed(servingModel)) return 'quota'
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
    const sourceBodyText = this.#filter(input, familyId)
    return {
      kind,
      bodyText,
      servingModel,
      folded,
      request: this.#handle({
        kind,
        session,
        family,
        familyId,
        round,
        sessionId: input.sessionId,
        accountId: oauth.accountId,
        credentialId: oauth.credentialId,
        cacheRoute: cacheRoute(input),
        sourceWarm: oauth.sourceWarm,
        sourceBodyText,
        baseBodyText,
        templateBodyText: bodyText,
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
      (request.kind === 'source' &&
        request.returning !== request.session.returning) ||
      (request.round?.folded && !request.folded)
    )
      return false
    request.phase = 'sent'
    if (request.kind !== 'routed') {
      request.session.latest = request.identity
      request.session.accountId = request.accountId
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
    step: Pick<Round, 'base' | 'checkpoint'>,
    retry: boolean,
  ) {
    const { family, session, sessionId, accountId } = request
    family.level = family.recent ? Math.min(family.level + 1, 2) : 0
    family.clean = 0
    family.recent = true
    const round: Round = {
      identity: request.identity,
      sessionId,
      requestedModel: session.model,
      servingModel: target.model,
      category,
      accountId,
      credentialId: request.credentialId,
      mode: 'client',
      stepsLeft: 10 * 2 ** family.level - (retry ? 1 : 0),
      folded: target.folded,
      releaseThinking: this.#thinking.retainSession(sessionId),
      ...step,
    }
    family.round = round
    this.#emit(round, 'round_started')
    if (retry) this.#emit(round, 'step_served')
    const refused = this.#warm && parse(request.baseBodyText)
    if (refused)
      this.#warm?.register(
        sessionId,
        refused,
        () =>
          this.#sessions.get(sessionId) === session &&
          (family.round === round || session.returning === round.identity),
      )
  }

  #step(
    request: Request,
    { usage, reply }: Pick<RefusalFallbackCompletion, 'usage' | 'reply'>,
    projectReply: RefusalFallbackRoundLifecycleOptions['projectReply'],
  ): Pick<Round, 'base' | 'checkpoint'> {
    const body = parse(request.baseBodyText)
    if (!body) return { checkpoint: null }
    const prefix = refusalFallbackPrefix(body)
    const inputTokens = measuredInputTokens(usage)
    const base =
      inputTokens === undefined ? undefined : { ...prefix, inputTokens }
    try {
      return {
        base,
        checkpoint:
          reply === null
            ? null
            : refusalFallbackCheckpoint(
                prefix,
                reply && projectReply ? projectReply(reply) : reply,
              ),
      }
    } catch {
      return { base, checkpoint: null }
    }
  }

  #sourceCompleted(
    request: Request,
    bodyText: string,
    completion: RefusalFallbackCompletion,
  ) {
    if (++request.family.clean >= 10) {
      request.family.level = 0
      request.family.recent = false
    }
    const usage = completion.usage
    this.#warm?.completeSource(
      request.sessionId,
      request.familyId,
      request.cacheRoute,
      request.sourceWarm,
      bodyText,
      parse(bodyText),
      usage && {
        input_tokens:
          typeof usage.input_tokens === 'number'
            ? usage.input_tokens
            : undefined,
        cache_read_input_tokens:
          typeof usage.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens
            : undefined,
        cache_creation_input_tokens:
          typeof usage.cache_creation_input_tokens === 'number'
            ? usage.cache_creation_input_tokens
            : undefined,
      },
    )
  }

  /** Pass to dispatch for source plans, or to the protected join for round plans. */
  lifecycle(
    handle: RefusalFallbackRoundRequest,
    {
      isFresh,
      targetAllowed,
      projectReply,
      onCacheKeepTemplate,
    }: RefusalFallbackRoundLifecycleOptions,
  ): RefusalFallbackDispatchLifecycle | undefined {
    const request = this.#requests.get(handle)
    if (!request || request.kind === 'routed') return undefined
    const fresh = () => this.#isCurrentPrimary(request) && isFresh()
    const templateIsCurrent = () => this.#isNewestPrimary(request) && isFresh()
    const publication = onCacheKeepTemplate && Promise.withResolvers<void>()
    const publish = (
      bodyText: string | null,
      servingModel: string,
      usage?: RefusalFallbackCompletion['usage'],
    ) => {
      if (!onCacheKeepTemplate || !publication) return
      const liveRound =
        servingModel !== request.session.model && bodyText !== null
          ? request.family.round
          : undefined
      const current = () =>
        templateIsCurrent() &&
        (!liveRound || request.family.round === liveRound)
      if (!current()) {
        publication.resolve()
        return
      }
      try {
        let pending: void | Promise<void>
        if (bodyText === null) pending = onCacheKeepTemplate(null, current)
        else {
          const body = parse(bodyText)
          if (!body || refusalBodyRecord(body.thread)?.type === 'continue') {
            publication.resolve()
            return
          }
          if (body.thread !== undefined)
            bodyText = update(bodyText, 'thread', undefined)
          if (body.fallback_credit_token !== undefined)
            bodyText = update(bodyText, 'fallback_credit_token', undefined)
          pending = onCacheKeepTemplate(
            { bodyText, servingModel, usage },
            current,
          )
        }
        void Promise.resolve(pending).then(
          publication.resolve,
          publication.resolve,
        )
      } catch {
        // Transport-side CacheKeep bookkeeping cannot interrupt the response.
        publication.resolve()
      }
    }
    const sessionStillExists = () =>
      this.#sessionLifetimes.get(request.sessionId) === request.session.lifetime
    const record = (digest: string, round: symbol) => {
      // Staleness does not discard thinking received by the host, but deletion
      // must not recreate a forgotten session.
      if (!sessionStillExists()) return
      this.#thinking.record(request.sessionId, request.familyId, digest, round)
    }
    let releaseRetryThinking: (() => void) | undefined
    if (onCacheKeepTemplate) request.publishTemplate = publish
    return {
      captureReply: true,
      cacheKeepTemplateSettled: publication?.promise,
      ...(request.round && {
        onThinkingDigest: (digest) =>
          record(digest, request.round?.identity ?? request.identity),
      }),
      onCompleted: (completion) => {
        if (request.phase !== 'sent' || !fresh()) {
          publication?.resolve()
          return
        }
        request.phase = 'finished'
        if (request.round) {
          const round = request.round
          Object.assign(round, this.#step(request, completion, projectReply))
          round.stepsLeft--
          this.#emit(round, 'step_served')
          if (round.stepsLeft === 0) {
            this.#end(request.family, round, 'count')
            publication?.resolve()
            return
          }
        } else {
          request.session.returning = undefined
          this.#sourceCompleted(request, request.templateBodyText, completion)
        }
        publish(
          request.templateBodyText,
          request.round?.servingModel ?? request.session.model,
          completion.usage,
        )
      },
      ...(request.kind === 'source' && {
        onRetryThinkingDigest: (digest) => {
          if (!sessionStillExists()) return
          releaseRetryThinking ??= this.#thinking.retainSession(
            request.sessionId,
          )
          record(digest, request.identity)
        },
        onRetryFinished: () => {
          releaseRetryThinking?.()
          releaseRetryThinking = undefined
        },
        onRefusal: (refusal) => {
          if (request.phase !== 'sent' || !fresh()) return
          request.session.returning = undefined
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
          ) {
            this.#start(
              request,
              refusal.category,
              { model: target.model, folded },
              this.#step(request, refusal, projectReply),
              false,
            )
            publish(null, target.model)
          }
        },
        onRetryCompleted: (completion, target) => {
          if (request.phase !== 'refusal' || !request.category || !fresh())
            return
          request.phase = 'finished'
          this.#start(
            request,
            request.category,
            target,
            this.#step(request, completion, projectReply),
            true,
          )
          if (target.bodyText)
            publish(target.bodyText, target.model, completion.usage)
        },
      }),
    }
  }

  /** Call on the final response after ordinary thread recovery, before host consumption. */
  async handleTarget400(
    handle: RefusalFallbackRoundRequest,
    response: Response,
    options: RefusalFallbackResendOptions & {
      /**
       * Whether this is still the session's newest primary request, with the
       * same requested model and account. It must not compare the
       * refusal_fallback mode: a mode change doesn't cancel this resend.
       */
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
    let sourceBodyText = request.sourceBodyText
    if (request.kind === 'round') {
      const body = parse(sourceBodyText)
      if (body && this.#warm?.restoreReturnMarker(request.sessionId, body))
        sourceBodyText = JSON.stringify(body)
    }
    return resendRefusalFallbackSource(
      response,
      sourceBodyText,
      options,
      isCurrent,
      () => {
        request.phase = 'finished'
        if (request.kind === 'round')
          this.#end(request.family, round, 'target-400')
      },
      isNewest,
      request.kind === 'round'
        ? (completion, bodyText) => {
            if (!isNewest()) return
            this.#sourceCompleted(request, bodyText, completion)
            request.publishTemplate?.(
              bodyText,
              request.session.model,
              completion.usage,
            )
          }
        : undefined,
      request.kind === 'round'
        ? () => {
            if (isNewest() && request.session.returning === round.identity)
              request.session.returning = undefined
          }
        : undefined,
    )
  }
}
