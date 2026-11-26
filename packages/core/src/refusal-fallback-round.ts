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
  refusalFallbackDeferredPrefix,
  refusalFallbackPrefix,
} from './refusal-fallback-prefix.ts'
import { restoreRefusalFallbackReturnMarker } from './refusal-fallback-return-marker.ts'
import type {
  RefusalFallbackCompletedRefusal,
  RefusalFallbackCompletion,
} from './refusal-fallback-stream.ts'
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
import { PROMPT_CACHE_DEFAULT_TTL_MS } from './session-cache-activity.ts'
import { requestCacheLifetimeMs } from './session-cache-policy.ts'
import type { RefusalFallbackMode } from './settings-definition.ts'

declare const requestHandle: unique symbol
export type RefusalFallbackRoundRequest = { readonly [requestHandle]: true }

export type RefusalFallbackRoundEnd =
  | 'count'
  | 'idle'
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
    /** Stable credential binding, not the rotating OAuth bearer. */
    credentialId?: string
    targetAllowed: (model: string) => boolean
    /** Route binding for the host's ordinary CacheKeep record. */
    cache?: { url: string; accountId: string; accountIdentity: string }
  }
  /** The host's transport route changed without necessarily changing its cache binding. */
  routeChanged?: boolean
  /** Result of comparing the host's normalized history with the round checkpoint. */
  compacted?: boolean
  /**
   * Optional host adjustment before Core's thinking filter. Core removes recorded
   * target thinking after source thinking in every turn, preserving a nonempty
   * message. Fallback requests keep the thinking recorded in the live round.
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
  idleClock: { at: number; ttlMs: number }
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
  cache?: NonNullable<RefusalFallbackRoundInput['oauth']>['cache']
  credentialId?: string
  identity: symbol
  folded: boolean
  phase: 'planned' | 'sent' | 'refusal' | 'finished'
  returning?: symbol
  category?: string
  handling400?: boolean
  publishTemplate?: (
    bodyText: string,
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
  { mode, oauth, routeChanged, compacted }: RefusalFallbackRoundInput,
): RefusalFallbackRoundEnd | undefined {
  if (mode !== round.mode) return 'mode'
  if (!oauth || routeChanged) return 'route'
  if (
    oauth.accountId !== round.accountId ||
    oauth.credentialId !== round.credentialId
  )
    return 'account'
  if (compacted) return 'compaction'
}

export type RefusalFallbackRoundEngineOptions = {
  thinkingStore?: RecoveryThinkingStore
  cacheKeep?: CacheKeepManager
  now?: () => number
}

export type RefusalFallbackCacheKeepTemplate = Readonly<{
  bodyText: string
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
   * Receives an accepted requested-model body before thread handling. The host
   * signs it and checks `isCurrent` before tracking it with CacheKeep.
   */
  onCacheKeepTemplate?: (
    template: RefusalFallbackCacheKeepTemplate,
    isCurrent: () => boolean,
  ) => void | Promise<void>
  /** The final physical body, including after message-thread recovery. */
  sentBodyText?: () => string | undefined
  /** An accepted fallback step renews the warm budget, not the replay prefix. */
  onRoundActivity?: (
    cacheTtlMs: number,
    requestedModel: string,
  ) => void | Promise<void>
}

/** Process-local client round state. The host owns routing, headers, threads and transport. */
export class RefusalFallbackRoundEngine {
  readonly #sessions = new Map<string, Session>()
  readonly #sessionLifetimes = new Map<string, object>()
  readonly #requests = new WeakMap<RefusalFallbackRoundRequest, Request>()
  readonly #thinking: RecoveryThinkingStore
  readonly #cacheKeep: CacheKeepManager | undefined
  readonly #now: () => number

  constructor(
    private readonly observe?: (event: RefusalFallbackRoundEvent) => void,
    options: RefusalFallbackRoundEngineOptions = {},
  ) {
    this.#thinking =
      options.thinkingStore ?? new RecoveryThinkingStore({ persist: false })
    this.#cacheKeep = options.cacheKeep
    this.#now = options.now ?? Date.now
  }

  loadThinking(sessionId: string): Promise<void> {
    return this.#thinking.loadSession(sessionId)
  }

  /** The next primary may be a fallback step; planning still checks its route and prefix. */
  hasRound(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId)
    return (
      session !== undefined &&
      [...session.families.values()].some((family) => family.round)
    )
  }

  forgetSession(sessionId: string): void {
    this.#sessions.delete(sessionId)
    this.#sessionLifetimes.delete(sessionId)
    this.#thinking.forgetSession(sessionId)
  }

  /** Call on sign-out or credential replacement, including with the same account UUID. */
  forgetAccount(accountId: string): void {
    for (const session of this.#sessions.values())
      if (session.accountId === accountId) session.latest = undefined
  }

  #filter(
    input: RefusalFallbackRoundInput,
    familyId?: ClaudeRefusalRecoveryFamily,
    round?: symbol,
    onRecordedThinking?: () => void,
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
    if (
      !body ||
      !stripRecoveryRoundThinking(body, digests, round, onRecordedThinking)
    )
      return text
    return update(text, 'messages', body.messages)
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
    this.#emit(round, 'round_ended', reason)
  }

  #restoreReturnMarker(
    sessionId: string,
    body: Record<string, unknown>,
    cache: Request['cache'],
  ): boolean {
    if (!cache) return false
    // If the host hasn't finished tracking the accepted prefix, return without a marker.
    const target = this.#cacheKeep?.trackedRequest(sessionId)
    if (
      !target ||
      target.cacheExpiresAt <= this.#now() ||
      target.url !== cache.url ||
      target.oauthAccountId !== cache.accountId ||
      target.oauthAccountIdentity !== cache.accountIdentity
    )
      return false
    const accepted = parse(target.bodyText)
    return Boolean(
      accepted &&
        accepted.model === body.model &&
        restoreRefusalFallbackReturnMarker(body, accepted),
    )
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
        ? { kind: 'source', bodyText: this.#filter(input) }
        : unchanged
    const existing = session?.families.get(familyId)
    const round = existing?.round
    if (session && existing && round) {
      const { idleClock } = round
      const reason =
        earlyEnd(round, input) ??
        (this.#now() - idleClock.at > idleClock.ttlMs ? 'idle' : undefined)
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
    let returning = session?.returning
    // After a restart only a recorded digest in the request identifies the
    // round, even if the block is kept. A round that left no digest is unknown.
    const inferReturn = !this.#sessionLifetimes.has(sessionId)
    let bodyText = this.#filter(
      input,
      familyId,
      undefined,
      inferReturn
        ? () => {
            returning ??= Symbol()
          }
        : undefined,
    )
    if (input.mode !== 'client' || !oauth) {
      if (session) session.returning = undefined
      if (inferReturn && returning) this.#sessionLifetimes.set(sessionId, {})
    }
    if (input.mode === 'server' || !oauth) return { kind: 'source', bodyText }
    const parsed = returning && !input.compacted ? parse(bodyText) : undefined
    const sourceCacheMarkerRestored = Boolean(
      parsed && this.#restoreReturnMarker(sessionId, parsed, oauth.cache),
    )
    if (sourceCacheMarkerRestored) bodyText = JSON.stringify(parsed)
    const source = {
      kind: 'source' as const,
      bodyText,
      ...(sourceCacheMarkerRestored && {
        sourceCacheMarkerRestored: true as const,
      }),
    }
    if (input.mode !== 'client') return source
    if (!session) {
      const lifetime = this.#sessionLifetimes.get(sessionId) ?? {}
      this.#sessionLifetimes.set(sessionId, lifetime)
      session = {
        model: requestedModel,
        lifetime,
        families: new Map(),
        returning,
      }
      this.#sessions.set(sessionId, session)
    }
    const family = existing ?? { clean: 0, level: 0, recent: false }
    session.families.set(familyId, family)
    return {
      ...source,
      request: this.#handle({
        kind: 'source',
        sessionId,
        session,
        family,
        familyId,
        accountId: oauth.accountId,
        credentialId: oauth.credentialId,
        cache: oauth.cache,
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
        cache: oauth.cache,
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
    step: Pick<Round, 'base' | 'checkpoint' | 'idleClock'>,
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
    try {
      this.#cacheKeep?.untrackIfModelChanged(sessionId, round.requestedModel)
    } catch {
      // CacheKeep bookkeeping must not interrupt the response.
    }
    this.#emit(round, 'round_started')
    if (retry) this.#emit(round, 'step_served')
  }

  #step(
    request: Request,
    { usage, reply }: Pick<RefusalFallbackCompletion, 'usage' | 'reply'>,
    projectReply: RefusalFallbackRoundLifecycleOptions['projectReply'],
    deferred = false,
  ): Pick<Round, 'base' | 'checkpoint'> {
    const body = parse(request.baseBodyText)
    if (!body) return { checkpoint: null }
    const prefix = deferred
      ? refusalFallbackDeferredPrefix(body)
      : refusalFallbackPrefix(body)
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

  #sourceCompleted(request: Request) {
    if (++request.family.clean >= 10) {
      request.family.level = 0
      request.family.recent = false
    }
  }

  /** Pass to dispatch for source plans, or to the protected join for round plans. */
  lifecycle(
    handle: RefusalFallbackRoundRequest,
    {
      isFresh,
      targetAllowed,
      projectReply,
      onCacheKeepTemplate,
      sentBodyText,
      onRoundActivity,
    }: RefusalFallbackRoundLifecycleOptions,
  ): RefusalFallbackDispatchLifecycle | undefined {
    const request = this.#requests.get(handle)
    if (!request || request.kind === 'routed') return undefined
    const fresh = () => this.#isCurrentPrimary(request) && isFresh()
    const templateIsCurrent = () => this.#isNewestPrimary(request) && isFresh()
    const publication =
      (onCacheKeepTemplate || onRoundActivity) && Promise.withResolvers<void>()
    const publish = (
      bodyText: string,
      usage?: RefusalFallbackCompletion['usage'],
    ) => {
      if (!publication) return
      const current = () => templateIsCurrent() && !request.family.round
      if (!onCacheKeepTemplate || !current()) {
        publication.resolve()
        return
      }
      try {
        const body = parse(bodyText)
        if (!body || refusalBodyRecord(body.thread)?.type === 'continue') {
          publication.resolve()
          return
        }
        if (body.thread !== undefined)
          bodyText = update(bodyText, 'thread', undefined)
        if (body.fallback_credit_token !== undefined)
          bodyText = update(bodyText, 'fallback_credit_token', undefined)
        void Promise.resolve(
          onCacheKeepTemplate({ bodyText, usage }, current),
        ).then(publication.resolve, publication.resolve)
      } catch {
        // Transport-side CacheKeep bookkeeping cannot interrupt the response.
        publication.resolve()
      }
    }
    const clockFrom = (cacheTtlMs: number) => ({
      at: this.#now(),
      ttlMs: cacheTtlMs || PROMPT_CACHE_DEFAULT_TTL_MS,
    })
    const wireCacheTtl = () =>
      requestCacheLifetimeMs(sentBodyText?.() ?? request.templateBodyText)
    const recordRoundActivity = (cacheTtlMs: number) => {
      try {
        void Promise.resolve(
          onRoundActivity?.(cacheTtlMs, request.session.model),
        ).then(
          () => publication?.resolve(),
          () => publication?.resolve(),
        )
      } catch {
        publication?.resolve()
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
    let refusalClock: Round['idleClock'] | undefined
    if (onCacheKeepTemplate) request.publishTemplate = publish
    const startOnNextRequest = (refusal: RefusalFallbackCompletedRefusal) => {
      if (
        request.phase !== 'refusal' ||
        !refusal.category ||
        !refusalClock ||
        !fresh()
      )
        return
      request.phase = 'finished'
      const body = parse(request.baseBodyText)
      if (!body) return
      const choice = {
        sourceModel:
          typeof body.model === 'string' ? body.model : request.session.model,
        category: refusal.category,
        body,
        refusedUsage: refusal.usage,
      }
      let target = selectRefusalFallbackTarget(choice)
      const folded =
        target.kind === 'none' && target.reason === 'no-fitting-target'
      if (folded)
        target = selectRefusalFallbackTarget({ ...choice, phase: 'folded' })
      if (target.kind === 'target' && targetAllowed(target.model) && fresh()) {
        this.#start(
          request,
          refusal.category,
          { model: target.model, folded },
          {
            ...this.#step(
              request,
              refusal,
              projectReply,
              !refusal.releasedTool,
            ),
            idleClock: refusalClock,
          },
          false,
        )
        publication?.resolve()
      }
    }
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
          const cacheTtlMs = wireCacheTtl()
          Object.assign(round, this.#step(request, completion, projectReply))
          round.idleClock = clockFrom(cacheTtlMs)
          recordRoundActivity(cacheTtlMs)
          round.stepsLeft--
          this.#emit(round, 'step_served')
          if (round.stepsLeft === 0) {
            this.#end(request.family, round, 'count')
          }
          return
        }
        request.session.returning = undefined
        this.#sourceCompleted(request)
        publish(request.templateBodyText, completion.usage)
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
          refusalClock = clockFrom(wireCacheTtl())
          request.session.returning = undefined
          request.phase = 'refusal'
          request.family.clean = 0
          request.category = refusal.category
          if (refusal.releasedTool) startOnNextRequest(refusal)
        },
        // A host may omit a refused assistant turn from its next request.
        onDeferredRefusal: startOnNextRequest,
        onRetryCompleted: (completion, target) => {
          if (request.phase !== 'refusal' || !request.category || !fresh())
            return
          request.phase = 'finished'
          const cacheTtlMs = target.cacheTtlMs ?? wireCacheTtl()
          this.#start(
            request,
            request.category,
            target,
            {
              ...this.#step(request, completion, projectReply),
              idleClock: clockFrom(cacheTtlMs),
            },
            true,
          )
          recordRoundActivity(cacheTtlMs)
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
      if (
        body &&
        this.#restoreReturnMarker(request.sessionId, body, request.cache)
      )
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
            this.#sourceCompleted(request)
            request.publishTemplate?.(bodyText, completion.usage)
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
