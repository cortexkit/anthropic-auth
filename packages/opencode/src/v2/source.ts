import {
  type AnthropicBillingWarming,
  type ClaudeGateway,
  createExhaustedNoRouteResponse,
  createNativeUsagePublisher,
  createNativeVaultNoRouteResponse,
  createQuotaRefusalResponse,
  decideStickyQuotaFailure,
  effectiveRelayTransport,
  getClaudeCodeIdentityForVerifiedAccount,
  getMaxSameAccountWait,
  getQuotaCheckIntervalMs,
  getRoutingMode,
  getScopedQuotaWindowForModel,
  getWaitForReset,
  isDumpPersistentlyEnabled,
  isQuotaBearingHeaderFrame,
  localMessageThreadCredential,
  logger,
  MAX_HOST_RETRY_MS,
  mergeHeaderQuotaForPersistence,
  type NativeAccountPolicy,
  type NativeAccountRefusalReason,
  type NativeAccountRuntime,
  type NativeAccountSnapshot,
  type NativeAccountView,
  type NativeApiSubject,
  type NativeCustodyReceipt,
  type NativeLocalCredentialValidation as NativeKnownCredentialSubject,
  type NativePoolPaths,
  type NativeQuotaObservation,
  NativeVaultNoAccountError,
  NativeVaultQuotaPolicyError,
  nativeAccountCanServe,
  nativeLocalAccountRefusal,
  nativeLocalQuotaLineage,
  nativePollQuotaGenerallyExhausted,
  normalizeQuotaHeaders,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
  peekRoutingAccount,
  quotaExhaustionFromHeaders,
  quotaRefusalDetails,
  quotaRefusalTiming,
  quotaSnapshotCheckedAt,
  quotaSnapshotHasStandardWindows,
  RELAY_PROXY_REFUSAL,
  readNativeAccountsForRequest,
  readSessionCachePolicy,
  readThreeWayBoolean,
  relayProxyApplies,
  remapModelId,
  reportSessionCacheTouch,
  requestCacheLifetimeMs,
  requestSignal,
  type StickyQuotaBlocker,
  StickyQuotaRetryCounter,
  StickySessionRouter,
  sessionCacheActivity,
  setDumpEnabled,
  shouldFallbackStatus,
  startRoutingWait,
  stickyQuotaBlockerInForce,
  stickyQuotaSnapshotIsFresh,
  stickyRetainRetryHeaders,
  stickyRetryAfterWithJitter,
  stickyRouteFamilyForModel,
  warnClaudeGatewayRelayIgnored,
  warnRelayProxyRefused,
} from '@cortexkit/anthropic-auth-core'
import {
  type ChooseAccountInput,
  type ChooseAccountResult,
  type HeaderEdits,
  MAX_TERMINAL_HOLD_MS,
  type RequestScope,
  type RetryHold,
} from '@cortexkit/common-auth/opencode2'
import { extractAnthropicRequestId } from '../billing-lineage'
import {
  createRoutingRelay,
  routingCandidates,
  routingChoiceMatches,
  routingWarmCredential,
} from '../routing-relay'
import {
  type NativeAnthropicAttemptContext,
  type NativeAnthropicAuthorization,
  type NativeAnthropicBodyOptions,
  type NativeAnthropicRequestContext,
  type NativeAnthropicResponseContext,
  type NativeAnthropicResponseOptions,
  type NativeAnthropicSource,
  NativeAnthropicTransportRefusal,
} from './adapter'

/**
 * Identifies the account and credential version that served a send, so a
 * later 401 or quota reading is recorded against that exact version. It never
 * holds OAuth tokens, API keys or the private vault authorization receipt.
 */
export type NativeSourceProvenance =
  | { readonly kind: 'local'; readonly subject: NativeKnownCredentialSubject }
  | {
      readonly kind: 'vault'
      readonly credentialId: string
      readonly recordVersion: number
    }
  | { readonly kind: 'api'; readonly subject: NativeApiSubject }

type Authorization = NativeAnthropicAuthorization<NativeSourceProvenance>
type OnAccountRefusal = (reason: NativeAccountRefusalReason) => void
type State = {
  readonly scope: RequestScope
  readonly active: AbortController
  readonly account: NativeAccountView
  readonly snapshot?: NativeAccountSnapshot
  readonly receipt?: NativeCustodyReceipt
  readonly access?: string
  readonly retry: boolean
  readonly relayFallback: boolean
  quota?: OAuthQuotaSnapshot
  responseHeaders?: Headers
  exhaustionReported?: boolean
}
type Retry = {
  readonly scope: RequestScope
  readonly reason: string
  readonly accountId: string
  readonly account: NativeAccountView
  readonly direct?: boolean
  readonly auth?: Authorization
  readonly retry: boolean
}

// Only the general OAuth windows can authorize paid API fallback. A model's
// scoped exhaustion alone must not open a paid route.
const quotaSnapshotIsExhausted = (quota: OAuthQuotaSnapshot | undefined) =>
  (['five_hour', 'seven_day'] as const).some(
    (window) => (quota?.[window]?.remainingPercent ?? 1) <= 0,
  )

// Match common-auth: the ten retry labels are 2 through 11, inclusive.
const HOST_RETRY_LIMIT = 10

const remainingHostRetries = (input: ChooseAccountInput) =>
  HOST_RETRY_LIMIT + 2 - (input.hostAttempt ?? 2)

function resetFitsRetryBudget(input: ChooseAccountInput, delayMs: number) {
  return Math.ceil(delayMs / MAX_HOST_RETRY_MS) <= remainingHostRetries(input)
}

// Only this source may authorize the installer to bypass the ordinary cap.
const terminalPoolHolds = new WeakSet<RetryHold>()

export function isTerminalPoolHold(
  choice: ChooseAccountResult,
): choice is RetryHold {
  return (
    typeof choice === 'object' &&
    'hold' in choice &&
    terminalPoolHolds.has(choice)
  )
}

/**
 * An unconfirmed 429 gets at most two short same-account retries per turn.
 * Confirmed exhaustion holds only when every blocking reset, including jitter,
 * fits within the session's cache and wait budget. The common-auth retry installer
 * keeps the refused account and routing pin and replaces the host wait with the hold.
 *
 * `servable` holds the accounts that can serve this model right now. A
 * refused account outside it would be refused again by `authorizeAccount`
 * when the held retry runs, so it moves instead of waiting. That covers a
 * model-scoped window at zero and a configured quota floor or killswitch.
 *
 * `grant` learns of each hold for confirmed exhaustion: the account and when its
 * blocking reset, including jitter, ends. Request-phase selection keeps serving
 * that account until then instead of excluding it as exhausted.
 */
function stickyHold(
  input: ChooseAccountInput,
  snapshot: NativeAccountSnapshot,
  servable: readonly NativeAccountView[],
  modelID: string,
  counter: StickyQuotaRetryCounter,
  turnId: string,
  grant: (accountId: string, untilMs: number) => void,
  refusalFor: (account: NativeAccountView) => Headers | undefined,
): RetryHold | undefined {
  const refused = input.rerouteFrom
  if (
    input.phase !== 'retry' ||
    refused?.limit.status !== 429 ||
    getRoutingMode(snapshot.policyStorage) !== 'sticky-balanced'
  )
    return undefined
  const account = servable.find((row) => row.id === refused.accountId)
  // Only a current reading can show when the blocking windows reset.
  if (!account) return undefined
  const responseHeaders = refusalFor(account)
  const decision = decideStickyQuotaFailure({
    quota:
      responseHeaders ||
      stickyQuotaSnapshotIsFresh(
        account.quota,
        snapshot.policyStorage,
        Date.now(),
        modelID,
      )
        ? account.quota
        : undefined,
    modelId: modelID,
    responseHeaders,
    sessionId: input.sessionID,
    unconfirmedRetry: {
      counter,
      sessionId: input.sessionID,
      turnId,
      accountId: account.id,
    },
    holdUntil: sessionCacheActivity.holdUntil(
      input.sessionID,
      account.id,
      Date.now(),
      getMaxSameAccountWait(snapshot.policyStorage),
    ),
  })
  if (decision.action === 'retain') {
    const result = {
      hold: {
        delayMs: Number(
          stickyRetainRetryHeaders(responseHeaders ?? new Headers()).get(
            'retry-after-ms',
          ),
        ),
      },
    }
    startRoutingWait({
      sessionId: input.sessionID,
      reason: 'rate_limited',
      delayMs: result.hold.delayMs,
      nextMs: Date.now() + result.hold.delayMs,
      attempt: counter.attempt(input.sessionID),
    })
    return result
  }
  if (decision.action !== 'hold') return undefined
  const resetWithJitterMs =
    stickyRetryAfterWithJitter(input.sessionID, decision.retryAfterSeconds) *
    1000
  if (!resetFitsRetryBudget(input, resetWithJitterMs)) return undefined
  grant(account.id, Date.now() + resetWithJitterMs)
  const result = {
    hold: {
      // OpenCode 2 caps each wait; under "max", retries recheck the original cache expiry.
      delayMs: Math.min(MAX_HOST_RETRY_MS, resetWithJitterMs),
    },
  }
  startRoutingWait({
    sessionId: input.sessionID,
    reason: 'account_limit',
    delayMs: result.hold.delayMs,
    nextMs: Date.now() + result.hold.delayMs,
  })
  return result
}

export type NativeCacheRequestPrepared = Parameters<
  NonNullable<NativeSource['onRequestPrepared']>
>[0] & {
  readonly admission?: {
    readonly snapshot: NativeAccountSnapshot
    readonly account: NativeAccountView
  }
}

export interface NativeSourceOptions {
  readonly runtime: NativeAccountRuntime
  readonly paths: NativePoolPaths
  readonly requestOptions: (
    scope: NativeAnthropicRequestContext<NativeSourceProvenance>,
    snapshot: NativeAccountSnapshot,
  ) => NativeAnthropicBodyOptions
  readonly responseOptions?: (
    scope: NativeAnthropicResponseContext<NativeSourceProvenance>,
  ) => NativeAnthropicResponseOptions
  readonly onRequestId?: (
    scope: NativeAnthropicResponseContext<NativeSourceProvenance>,
    requestId: string,
  ) => void
  readonly onForgetSession?: (sessionID: string) => void
  readonly onOwnedRequest?: () => void
  readonly beginRealTurn?: NativeSource['beginRealTurn']
  readonly onRequestPrepared?: (
    input: NativeCacheRequestPrepared,
  ) => Promise<void> | void
  readonly onResponseHeaders?: (
    input: NativeAnthropicResponseContext<NativeSourceProvenance>,
  ) => void
  readonly onAttemptEnd?: NativeSource['onAttemptEnd']
  readonly onCacheUsage?: (
    sessionID: string,
    bodyText: string,
    usage: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    },
  ) => void
  readonly onCacheResponse?: (input: {
    attemptId: string
    acceptedAt?: number
    ttlMs?: number
    acceptedUsage?: Record<string, number>
  }) => void
  /**
   * Keep-warm state for a model request's billing report, read from memory
   * once its response finishes; `undefined` leaves the state out.
   */
  readonly billingWarming?: (input: {
    sessionID: string
    route: string
  }) => AnthropicBillingWarming | undefined
  readonly fetch?: typeof fetch
  /** Resolve a host model alias to the upstream ID before request-local policy. */
  readonly resolveModelId?: (scope: RequestScope) => Promise<string>
}

export interface NativeSource
  extends NativeAnthropicSource<OAuthQuotaSnapshot, NativeSourceProvenance> {
  /** Background sends can stop retrying terminal refusals without changing live routing. */
  readonly authorizeAccount: (
    scope: RequestScope,
    accountId: string,
    onRefusal?: OnAccountRefusal,
  ) => Promise<Authorization | undefined>
  readonly requestOptions?: (
    input: NativeAnthropicRequestContext<NativeSourceProvenance>,
    onRefusal?: OnAccountRefusal,
  ) => Promise<NativeAnthropicBodyOptions> | NativeAnthropicBodyOptions
  readonly admitRequest?: (
    input: NativeAnthropicAttemptContext<NativeSourceProvenance>,
    onRefusal?: OnAccountRefusal,
  ) => Promise<void> | void
  readonly close: () => Promise<void>
  readonly drainRoutingPublications: () => Promise<void>
  readonly resetRouting: (sessionID: string) => Promise<void>
  /** The account that served the session's latest authorization, if any. */
  readonly servedAccount: (sessionID: string) => string | undefined
  readonly peekAccount?: (
    sessionId: string,
    modelId: string | undefined,
    snapshot: NativeAccountSnapshot,
  ) => string | undefined
  readonly recordPrime: (
    provenance: NativeSourceProvenance,
    usage: { inputTokens?: number; outputTokens?: number },
  ) => Promise<boolean>
}

/** The native account service supplies fresh credentials; existing quota and routing rules choose each OpenCode 2 request's route. */
export function createNativeAnthropicSource(
  options: NativeSourceOptions,
): NativeSource {
  const { runtime } = options
  const usagePublications = createNativeUsagePublisher('native-auth')
  const routingRelay = createRoutingRelay(async (subject) => {
    const snapshot = await runtime.read()
    return snapshot.accounts.find(
      (row) =>
        row.accountIdentity === subject.accountIdentity &&
        (!subject.credentialId || row.credentialId === subject.credentialId),
    )?.quota
  })
  const servedTurns = new Set<string>()
  const stickyQuotaRetries = new StickyQuotaRetryCounter()
  // The latest same-account hold granted for confirmed exhaustion, by session:
  // the held account and when its reset, with jitter, ends. Entries leave with
  // forgetSession, which also bounds the map.
  const grantedHolds = new Map<string, { accountId: string; untilMs: number }>()
  const turnIds = new Map<string, string>()
  // Vault mode keeps session affinity in its own file, named by the snapshot,
  // so vault sessions never read or write the local account's routing state.
  // Local mode uses the destination from the runtime's existing authority read.
  const routers = new Map<string, StickySessionRouter>()
  const routerFor = (snapshot: NativeAccountSnapshot) => {
    const path = snapshot.routingPath
    if (!path) throw new Error('Native routing storage is unavailable')
    let router = routers.get(path)
    if (!router) {
      router = new StickySessionRouter({
        path,
        vaultSeed: snapshot.routingSeed,
        onLockEvent: runtime.onLockEvent,
        relocationGuard: runtime.relocationGuard,
        localRecoveryPath:
          snapshot.mode === 'local' ? snapshot.routingRecoveryPath : undefined,
      })
      routers.set(path, router)
    }
    router.setVaultSeed(snapshot.routingSeed)
    return router
  }
  const states = new WeakMap<NativeSourceProvenance, State>()
  const cacheAttempts = new Map<
    string,
    {
      sessionID: string
      accountId: string
      signal?: AbortSignal
      cacheTtlMs: number
      ttlOverridden: boolean
      bodyText: string
      accepted?: boolean
      finalWire?: { ttlMs: number }
      usage?: Record<string, number>
      sessionSignal?: AbortSignal
      ended?: boolean
      handedOff?: boolean
    }
  >()
  const wireRequests = new Map<
    string,
    { attemptId: string; sessionID: string }
  >()
  const retries = new Map<string, Retry>()
  const refusalHeaders = new Map<
    string,
    { sessionID: string; headers: Headers; receivedAt: number }
  >()
  const recoveries = new Map<string, Retry[]>()
  const sessions = new Map<string, AbortController>()
  // The account behind each session's latest authorization, for the sidebar.
  // Entries leave with forgetSession, which also bounds `sessions`.
  const servedBy = new Map<string, string>()
  // Keep token-free identity snapshots after attempt teardown: an interrupted
  // body has already ended when the host asks whether the reply may continue.
  const servedAccounts = new Map<
    string,
    { scope: RequestScope; account: NativeAccountView }
  >()
  const reported = new WeakSet<NativeCustodyReceipt>()
  let closed = false
  const boundRetries = () => {
    while (retries.size > 512) {
      const first = retries.keys().next()
      if (!first.done) retries.delete(first.value)
    }
  }

  // Mirror the resolved switch, whether supplied by the user file or the
  // current custody store, so Core's prewarms and adapter dumps agree.
  const syncDumpEnabled = (snapshot: NativeAccountSnapshot) => {
    try {
      setDumpEnabled(isDumpPersistentlyEnabled(snapshot.policyStorage))
    } catch {}
  }
  const readDumpEnabled = async (): Promise<boolean> => {
    try {
      const snapshot = await runtime.read()
      syncDumpEnabled(snapshot)
      return isDumpPersistentlyEnabled(snapshot.policyStorage)
    } catch {
      return false
    }
  }

  const retryScope = (scope: RequestScope): RequestScope => ({
    providerID: scope.providerID,
    sessionID: scope.sessionID,
    kind: scope.kind,
    modelID: scope.modelID,
    agent: scope.agent,
  })
  const key = (scope: RequestScope, accountId: string) =>
    JSON.stringify([
      scope.providerID,
      scope.sessionID,
      scope.kind,
      scope.modelID,
      scope.agent,
      accountId,
    ])
  const controller = (scope: RequestScope) => {
    if (closed) throw new Error('Native Anthropic source is closed')
    let current = sessions.get(scope.sessionID)
    if (!current) {
      current = new AbortController()
      sessions.set(scope.sessionID, current)
      while (sessions.size > 512) {
        const first = sessions.keys().next()
        if (!first.done) source.forgetSession?.(first.value)
      }
    }
    const signal = requestSignal()
    return signal
      ? {
          signal: AbortSignal.any([current.signal, signal]),
          abort: current.abort.bind(current),
        }
      : current
  }
  const eligible = (
    account: NativeAccountView,
    snapshot: NativeAccountSnapshot,
    modelID: string,
    sessionID = '',
  ) =>
    nativeAccountCanServe(account) &&
    (account.type === 'api' ||
      routingRelay.policy(sessionID, account, snapshot, remapModelId(modelID))
        .status === 'allowed')

  const refusalInForce = (
    scope: RequestScope,
    account: NativeAccountView,
    modelID: string,
    now: number,
  ) => {
    const refusalKey = key({ ...scope, modelID }, account.id)
    const refusal = refusalHeaders.get(refusalKey)
    if (!refusal || !account.quota) return refusal?.headers
    const rejected = quotaExhaustionFromHeaders(
      refusal.headers,
      modelID,
      refusal.receivedAt,
    )
    const scoped = rejected.scoped?.[0]
    let headers: Headers | undefined
    // A refusal without a reset can outlive the turn that saw it. Only a later
    // reading of the same window can show that the refusal no longer applies.
    for (const [suffix, refused, current] of [
      ['5h', rejected.five_hour, account.quota.five_hour],
      ['7d', rejected.seven_day, account.quota.seven_day],
      [
        scoped?.id,
        scoped,
        getScopedQuotaWindowForModel(account.quota, modelID),
      ],
    ] as const) {
      if (
        !suffix ||
        !refused ||
        refused.resetsAt ||
        !current ||
        !(current.checkedAt > refusal.receivedAt) ||
        !Number.isFinite(current.remainingPercent) ||
        current.remainingPercent <= 0
      )
        continue
      headers ??= new Headers(refusal.headers)
      headers.delete(`anthropic-ratelimit-unified-${suffix}-status`)
      headers.delete(`anthropic-ratelimit-unified-${suffix}-utilization`)
    }
    if (!headers) return refusal.headers
    if (
      stickyQuotaBlockerInForce({
        quota: undefined,
        responseHeaders: headers,
        modelId: modelID,
        now,
      })
    ) {
      refusal.headers = headers
      return headers
    }
    refusalHeaders.delete(refusalKey)
    return undefined
  }

  /**
   * Confirmed exhaustion that keeps `account` from serving this request until
   * a reset, read from the same evidence a sticky hold decision uses: the raw
   * headers of this scope's latest 429 from the account, and its stored
   * reading when those headers exist or the reading is fresh. Undefined while
   * a hold this session was granted for the account has not yet ended.
   */
  const exhaustionInForce = (
    scope: RequestScope,
    account: NativeAccountView,
    snapshot: NativeAccountSnapshot,
    modelID: string,
    ignoreGrantedHold = false,
  ) => {
    const now = Date.now()
    const held = grantedHolds.get(scope.sessionID)
    if (
      !ignoreGrantedHold &&
      held?.accountId === account.id &&
      now < held.untilMs
    )
      return undefined
    const responseHeaders = refusalInForce(scope, account, modelID, now)
    return stickyQuotaBlockerInForce({
      quota:
        responseHeaders ||
        stickyQuotaSnapshotIsFresh(
          account.quota,
          snapshot.policyStorage,
          now,
          modelID,
        )
          ? account.quota
          : undefined,
      responseHeaders,
      modelId: modelID,
      now,
    })
  }
  const poolDecision = (
    input: ChooseAccountInput,
    snapshot: NativeAccountSnapshot,
    oauth: readonly NativeAccountView[],
    modelID: string,
    advice: unknown,
  ) => {
    if (
      advice ||
      input.phase !== 'retry' ||
      input.rerouteFrom?.limit.status !== 429 ||
      getMaxSameAccountWait(snapshot.policyStorage) === '0' ||
      snapshot.accounts.some(
        (row) => row.enabled && row.state === 'needs_reauth',
      )
    )
      return undefined
    const exhausted: StickyQuotaBlocker[] = []
    for (const row of oauth) {
      // While a hold we granted is running, exhaustionInForce treats the held
      // account as usable so the session stays on it. This account has just
      // been refused again, so that hold is over: judge it by its quota.
      const blocked = exhaustionInForce(
        input,
        row,
        snapshot,
        modelID,
        row.id === input.rerouteFrom.accountId,
      )
      if (!blocked) return undefined
      exhausted.push(blocked)
    }
    const index = oauth.findIndex(
      (row) => row.id === input.rerouteFrom?.accountId,
    )
    if (index < 0) return undefined
    const blocked = exhausted[index]
    if (!blocked) return undefined
    if (blocked.resetAt === undefined) return { exhausted }
    const delayToReset =
      stickyRetryAfterWithJitter(
        input.sessionID,
        Math.max(1, Math.ceil((blocked.resetAt - Date.now()) / 1000)),
      ) * 1000
    return {
      exhausted,
      delayMs: resetFitsRetryBudget(input, delayToReset)
        ? Math.min(MAX_HOST_RETRY_MS, delayToReset)
        : undefined,
    }
  }
  const oauthPool = async (
    input: RequestScope,
    snapshot: NativeAccountSnapshot,
    modelID: string,
    active: { signal: AbortSignal },
  ) => {
    const oauth: NativeAccountView[] = []
    const policies = new Map<string, NativeAccountPolicy>()
    for (const account of snapshot.accounts) {
      if (account.type !== 'oauth') continue
      const policy = routingRelay.policy(
        input.sessionID,
        account,
        snapshot,
        modelID,
      )
      policies.set(account.id, policy)
      if (policy.status !== 'allowed') continue
      if (account.source === 'local') {
        // Do not count a local credential whose refresh cannot serve a request.
        const admission = await runtime.authorizeLocal(account.id, {
          signal: active.signal,
          policy: (row, view) =>
            routingRelay.policy(input.sessionID, row, view, modelID),
        })
        active.signal.throwIfAborted()
        if (admission.status !== 'usable') continue
      }
      oauth.push(account)
    }
    return { oauth, policies }
  }
  const paidFallback = async (
    input: ChooseAccountInput,
    snapshot: NativeAccountSnapshot,
    active: { signal: AbortSignal },
  ) => {
    // Only general subscription exhaustion opens the pay-per-token route.
    const main = snapshot.accounts.find(
      (account) => account.id === 'main' && account.type === 'oauth',
    )
    if (!main) return undefined
    let quota = main.quota
    if (
      input.rerouteFrom?.limit.status === 429 ||
      !stickyQuotaSnapshotIsFresh(quota, snapshot.policyStorage)
    ) {
      try {
        quota = await runtime.fetchQuota('main', options.fetch, active.signal)
      } catch {
        return undefined
      }
    }
    active.signal.throwIfAborted()
    if (!quotaSnapshotIsExhausted(quota)) return undefined
    return snapshot.accounts.find(
      (account) =>
        account.type === 'api' &&
        nativeAccountCanServe(account) &&
        account.id !== input.rerouteFrom?.accountId,
    )?.id
  }
  const terminalPoolDecision = async (
    input: ChooseAccountInput,
    snapshot: NativeAccountSnapshot,
    modelID: string,
    advice: unknown,
    active: { signal: AbortSignal },
  ) => {
    if (
      advice ||
      input.phase !== 'retry' ||
      input.rerouteFrom?.limit.status !== 429 ||
      !(remainingHostRetries(input) >= 1) ||
      !getWaitForReset(snapshot.policyStorage) ||
      snapshot.accounts.some(
        (row) => row.enabled && row.state === 'needs_reauth',
      )
    )
      return undefined
    // Include accounts blocked by a quota floor: they can be the first to
    // recover, but an unknown or stale blocker cannot justify a long wait.
    const eligible = snapshot.accounts.filter(
      (row) => row.type === 'oauth' && nativeAccountCanServe(row),
    )
    if (!eligible.some((row) => row.id === input.rerouteFrom?.accountId))
      return undefined
    const now = Date.now()
    const timing = quotaRefusalTiming({
      readings: eligible.map(({ quota, accountIdentity, id }) => ({
        quota,
        accountIdentity,
        accountId: id,
      })),
      storage: snapshot.policyStorage,
      modelId: modelID,
      sessionId: input.sessionID,
      waitForReset: true,
      now,
    })
    if (
      timing.resetWaitMs === undefined ||
      timing.resetAt === undefined ||
      timing.resetAt - now > MAX_TERMINAL_HOLD_MS ||
      (snapshot.mode !== 'claustrum' &&
        snapshot.accounts.some(
          (row) => row.type === 'api' && nativeAccountCanServe(row),
        ) &&
        (await paidFallback(input, snapshot, active)))
    )
      return undefined
    const delayMs = Math.min(timing.resetWaitMs, MAX_TERMINAL_HOLD_MS)
    return {
      timing: { ...timing, resetWaitMs: delayMs },
      target: now + delayMs,
    }
  }
  const sameAccount = (
    account: NativeAccountView,
    expected: NativeAccountView,
  ) =>
    account.source === expected.source &&
    account.accountIdentity === expected.accountIdentity &&
    account.credentialId === expected.credentialId
  const recordServed = (scope: RequestScope, account: NativeAccountView) => {
    servedBy.set(scope.sessionID, account.id)
    const servedKey = key(scope, account.id)
    servedAccounts.delete(servedKey)
    servedAccounts.set(servedKey, { scope: retryScope(scope), account })
    if (servedAccounts.size > 512) {
      const oldest = servedAccounts.keys().next().value
      if (oldest !== undefined) servedAccounts.delete(oldest)
    }
  }
  const admitted = async (
    accountId: string,
    modelID: string,
    route: 'oauth' | 'api',
    active: AbortController,
    onRefusal?: (reason: NativeAccountRefusalReason) => void,
    sessionID = '',
  ) => {
    const current = await runtime.read(modelID)
    syncDumpEnabled(current)
    active.signal.throwIfAborted()
    assertTransport(current, route === 'oauth' ? gateway() : undefined)
    const account = current.accounts.find((row) => row.id === accountId)
    if (
      !account ||
      account.type !== route ||
      !eligible(account, current, modelID, sessionID)
    ) {
      onRefusal?.(
        !account || !nativeAccountCanServe(account)
          ? 'account-unavailable'
          : 'account-policy',
      )
      return false
    }
    if (route === 'api') {
      const main = current.accounts.find(
        (row) => row.id === 'main' && row.type === 'oauth',
      )
      if (
        !(
          !!main &&
          stickyQuotaSnapshotIsFresh(main.quota, current.policyStorage) &&
          quotaSnapshotIsExhausted(main.quota)
        )
      )
        return false
    }
    return { snapshot: current, account }
  }

  // The user's gateway from their own settings file, read from memory.
  const gateway = () => runtime.getClaudeGateway?.()
  // Callers always pass the gateway the send would use, never a default:
  // `undefined` means no gateway (for example an API-key route), and must not
  // be replaced by a fresh read of the settings.
  const assertTransport = (
    snapshot: NativeAccountSnapshot,
    current: ClaudeGateway | undefined,
  ) => {
    const selected = snapshot.policyStorage.relay
    // With a gateway, a WebSocket relay does not refuse here: dispatchFor
    // hands the adapter the WebSocket relay's dispatch, and the adapter sends
    // a gateway-routed model request to the gateway and refuses any other
    // request itself, once its URL is known. Without a gateway (an API-key
    // route always passes none) the refusal happens here.
    if (
      !current &&
      selected?.enabled === true &&
      effectiveRelayTransport(selected.transport, selected.url) === 'websocket'
    )
      throw new NativeAnthropicTransportRefusal()
  }
  const dispatchFor = async (
    snapshot: NativeAccountSnapshot,
    direct: boolean,
    route: 'oauth' | 'api',
  ) => {
    // The gateway is read once per authorization; the adapter uses this
    // value for the send. The URL is not known yet, so the dispatch below is
    // the one a request the gateway does not take uses (the relay, or the
    // WebSocket relay's refusal); the adapter sends only a gateway-routed
    // model request directly to the gateway instead.
    const current = route === 'oauth' ? gateway() : undefined
    assertTransport(snapshot, current)
    const gatewayField = current ? { gateway: current } : {}
    if (current && snapshot.policyStorage.relay?.enabled === true)
      warnClaudeGatewayRelayIgnored(current)
    const selected = snapshot.policyStorage.relay
    // Decided before the direct case: a queued direct retry must still meet
    // the WebSocket relay's refusal for any request the gateway does not take.
    if (
      current &&
      selected?.enabled === true &&
      effectiveRelayTransport(selected.transport, selected.url) === 'websocket'
    )
      return {
        dispatch: { kind: 'websocket-relay' as const },
        relayFallback: false,
        ...gatewayField,
      }
    if (direct || selected?.enabled !== true)
      return {
        dispatch: { kind: 'direct' as const },
        relayFallback: false,
        ...gatewayField,
      }
    // Account and status data exclude the relay secret. Obtain it through the
    // private transport accessor immediately before preparing the send.
    const relay = await runtime.getRelayConfig()
    if (!relay)
      throw new Error(
        'request refused: native HTTP relay configuration is unavailable',
      )
    if (relay.transport !== 'http') {
      if (current)
        return {
          dispatch: { kind: 'websocket-relay' as const },
          relayFallback: false,
          ...gatewayField,
        }
      throw new NativeAnthropicTransportRefusal()
    }
    if (relayProxyApplies(relay.url)) {
      // Nothing is sent to the relay. Like a relay that cannot be reached,
      // this goes direct when fallbackToDirect allows it and fails otherwise.
      warnRelayProxyRefused()
      if (!relay.fallbackToDirect) throw new Error(RELAY_PROXY_REFUSAL)
      return {
        dispatch: { kind: 'direct' as const },
        relayFallback: false,
        ...gatewayField,
      }
    }
    return {
      dispatch: {
        kind: 'http-relay' as const,
        url: relay.url,
        token: relay.token,
      },
      relayFallback: relay.fallbackToDirect,
      ...gatewayField,
    }
  }

  async function publish(
    provenance: NativeSourceProvenance,
    state: State,
    patch: { quota?: OAuthQuotaSnapshot; lastUsed?: number },
  ): Promise<boolean> {
    if (provenance.kind === 'local') {
      const kept = await runtime.publishLocal(
        provenance.subject,
        patch,
        usagePublications.signal,
      )
      if (!kept && patch.quota)
        logger.warn('quota', 'Quota publication discarded')
      return kept
    }
    if (provenance.kind === 'vault' && state.receipt)
      await runtime.vault.publish(
        state.receipt,
        patch,
        usagePublications.signal,
      )
    else if (provenance.kind === 'api' && patch.lastUsed !== undefined)
      await runtime.publishApi(
        provenance.subject,
        { lastUsed: patch.lastUsed },
        usagePublications.signal,
      )
    return true
  }

  /**
   * Local header readings are saved by a detached, lock-taking write. Hold the
   * reading in the runtime's shared quota observations first, bound to the
   * serving credential's lineage and account UUID, so a later account choice
   * in this process routes by it while that save waits. A refused save drops
   * it again; a later reading for the same account replaces it.
   */
  function holdLocalReading(
    provenance: NativeSourceProvenance,
    state: State,
    quota: OAuthQuotaSnapshot,
  ) {
    if (provenance.kind !== 'local') return undefined
    const binding = provenance.subject.binding
    const checkedAt = quotaSnapshotCheckedAt(quota)
    const observation: NativeQuotaObservation = {
      lineage: nativeLocalQuotaLineage(binding),
      accountUuid: binding.identity,
      entry: { quota, checkedAt, refreshAfter: checkedAt },
      generalExhausted: nativePollQuotaGenerallyExhausted(quota),
      routeBeforeSave: true,
    }
    return runtime.quotaObservations.hold(state.account.id, observation)
      ? observation
      : undefined
  }

  function reportRateLimit(
    input: NativeAnthropicAttemptContext<NativeSourceProvenance>,
    state: State,
  ) {
    if (state.exhaustionReported) return
    state.exhaustionReported = true
    routingRelay.report(
      input.sessionID,
      {
        accountIdentity: state.account.accountIdentity,
        credentialId:
          input.provenance.kind === 'vault'
            ? input.provenance.credentialId
            : state.account.credentialId,
      },
      state.responseHeaders ?? new Headers(),
      429,
      state.scope.modelID,
      false,
    )
  }

  const source: NativeSource = {
    billingRequest(input) {
      if (input.agent === 'prime') return undefined
      const state = states.get(input.provenance)
      if (!state) return undefined
      const provenance = input.provenance
      return {
        sessionId: input.sessionID,
        credentialId:
          provenance.kind === 'vault'
            ? provenance.credentialId
            : provenance.kind === 'local'
              ? localMessageThreadCredential(provenance.subject.binding)
              : provenance.subject.credentialFingerprint,
        accountId: state.account.accountIdentity,
        model: state.scope.modelID,
        requestKind: input.agent === 'cachekeep' ? 'keep_warm' : input.kind,
        chargeBasis:
          input.route === 'api' ? 'metered_api' : 'subscription_included',
        ...(input.agent !== 'cachekeep' &&
          options.billingWarming && {
            cacheWarming: () =>
              options.billingWarming?.({
                sessionID: input.sessionID,
                route: input.route,
              }),
          }),
      }
    },
    beginRealTurn: options.beginRealTurn,
    async chooseAccount(
      input: ChooseAccountInput,
    ): Promise<ChooseAccountResult> {
      // Credential maintenance and quota readings may occur without selecting
      // an account. Returning undefined must not consume a pending retry,
      // queue an account choice, or create, move or delete a session pin.
      const active = controller(input)
      options.onOwnedRequest?.()
      const modelID = remapModelId(
        (await options.resolveModelId?.(input)) ?? input.modelID,
      )
      let snapshot = await runtime.read(modelID)
      syncDumpEnabled(snapshot)
      active.signal.throwIfAborted()
      // Account selection rejects a WebSocket relay before any OAuth token
      // refresh or retrieval starts.
      assertTransport(snapshot, gateway())
      if (snapshot.mode === 'claustrum') {
        snapshot = await readNativeAccountsForRequest(runtime, active.signal)
        snapshot = {
          ...snapshot,
          policyStorage:
            runtime.resolveSettings?.(snapshot.policyStorage, modelID) ??
            snapshot.policyStorage,
        }
        active.signal.throwIfAborted()
      }
      if (readThreeWayBoolean(snapshot.policyStorage.quota?.enabled, true)) {
        let refreshed = false
        for (const account of snapshot.accounts) {
          if (!nativeAccountCanServe(account) || account.type !== 'oauth')
            continue
          const fresh = quotaSnapshotHasStandardWindows(account.quota)
            ? stickyQuotaSnapshotIsFresh(
                account.quota,
                snapshot.policyStorage,
                Date.now(),
                modelID,
              )
            : Date.now() - quotaSnapshotCheckedAt(account.quota) <
              getQuotaCheckIntervalMs(snapshot.policyStorage)
          if (fresh) continue
          try {
            // Admission: for a vault account the runtime may answer from its
            // cached insula reading (the vault daemon's quota monitor), then
            // polls on a miss; it never refreshes that cache here.
            await runtime.fetchQuota(
              account.id,
              options.fetch,
              active.signal,
              undefined,
              'admission',
            )
            refreshed = true
          } catch {
            active.signal.throwIfAborted()
          }
        }
        if (refreshed) snapshot = await runtime.read(modelID)
        active.signal.throwIfAborted()
      }
      if (
        input.rerouteFrom &&
        /^(vault-newer|local-newer|relay-direct):/.test(
          input.rerouteFrom.limit.reason,
        )
      )
        return undefined
      if (input.phase === 'request') servedTurns.delete(input.sessionID)
      const assignment = await routerFor(snapshot).readAssignment(
        input.sessionID,
      )
      active.signal.throwIfAborted()
      const advice = await routingRelay.accountFor(
        input.sessionID,
        modelID,
        routingCandidates(snapshot.accounts),
        {
          capacityWait: 'wait',
          signal: active.signal,
          warmCredentialId: routingWarmCredential(
            snapshot.accounts,
            assignment,
          ),
        },
      )
      active.signal.throwIfAborted()
      if (advice) {
        snapshot = await runtime.read(modelID)
        active.signal.throwIfAborted()
        assertTransport(snapshot, gateway())
      }
      const { oauth, policies } = await oauthPool(
        input,
        snapshot,
        modelID,
        active,
      )
      const lastRefuser = input.rerouteFrom?.accountId
      const excluded = input.phase === 'retry' ? input.excluded : undefined
      const previouslyRefused = (account: NativeAccountView) =>
        excluded?.includes(account.id)
      const blockerFor = (account: NativeAccountView) =>
        exhaustionInForce(
          input,
          account,
          snapshot,
          modelID,
          input.phase === 'retry',
        )
      if (advice) {
        const account = oauth.find((row) => routingChoiceMatches(advice, row))
        const candidates = oauth.map((row, order) => ({
          accountId: row.id,
          order,
          quota: row.quota ?? { kind: 'unknown' as const },
        }))
        const supportedHold =
          !advice.hold ||
          (input.phase === 'retry' && lastRefuser === account?.id)
        const acceptsRoutingPick = (pick: NativeAccountView) => {
          if (pick.id === lastRefuser) return false
          if (input.phase !== 'retry') return true
          if (blockerFor(pick)) return false
          return (
            !previouslyRefused(pick) ||
            !oauth.some(
              (row) =>
                row.id !== lastRefuser &&
                !previouslyRefused(row) &&
                !blockerFor(row),
            )
          )
        }
        if (
          account &&
          supportedHold &&
          (advice.hold || acceptsRoutingPick(account))
        ) {
          const selected = await routerFor(snapshot).resolve({
            sessionId: input.sessionID,
            family: stickyRouteFamilyForModel(modelID),
            modelId: modelID,
            affinityModelId: input.modelID,
            candidates: candidates.filter(
              (row) => row.accountId === account.id,
            ),
            retainAccountIds: new Set([account.id]),
            ...(snapshot.mode === 'claustrum'
              ? {
                  accountIdentities: new Map([[account.id, advice.account_id]]),
                }
              : {}),
            storage: snapshot.policyStorage,
            inputBytes: 1,
            preserveOnNoCandidate: true,
            routingAccountId: account.id,
          })
          active.signal.throwIfAborted()
          if (selected?.migrated) stickyQuotaRetries.clear(input.sessionID)
          if (selected) {
            if (advice.hold) {
              startRoutingWait({
                sessionId: input.sessionID,
                reason: 'routing_hold',
                delayMs: advice.hold.retry_after_ms,
                nextMs: Date.now() + advice.hold.retry_after_ms,
              })
              return { hold: { delayMs: advice.hold.retry_after_ms } }
            }
            return selected.accountId
          }
        }
        // OpenCode 2 can hold only when retrying the same refused account.
        routingRelay.override(
          input.sessionID,
          !supportedHold
            ? 'hold requires the same refused retry account'
            : 'unknown account, credential or account policy',
        )
        // Discard quota exemptions before making our own subscription choice.
        oauth.splice(
          0,
          oauth.length,
          ...oauth.filter(
            (account) =>
              routingRelay.policy(input.sessionID, account, snapshot, modelID)
                .status === 'allowed',
          ),
        )
      }
      // A refusal from a held account ends its hold unless this probe grants
      // another one.
      if (
        input.rerouteFrom &&
        grantedHolds.get(input.sessionID)?.accountId ===
          input.rerouteFrom.accountId
      )
        grantedHolds.delete(input.sessionID)
      const terminal = await terminalPoolDecision(
        input,
        snapshot,
        modelID,
        advice,
        active,
      )
      if (terminal) {
        const hold: RetryHold = {
          hold: {
            kind: 'terminal',
            delayMs: terminal.timing.resetWaitMs,
            target: terminal.target,
          },
        }
        terminalPoolHolds.add(hold)
        startRoutingWait({
          sessionId: input.sessionID,
          reason: 'account_free',
          delayMs: hold.hold.delayMs,
          nextMs: terminal.target,
        })
        return hold
      }
      const hold = stickyHold(
        input,
        snapshot,
        oauth,
        modelID,
        stickyQuotaRetries,
        turnIds.get(input.sessionID) ?? input.kind,
        (accountId, untilMs) =>
          grantedHolds.set(input.sessionID, { accountId, untilMs }),
        (account) => refusalInForce(input, account, modelID, Date.now()),
      )
      if (hold) return hold
      // After considering holds, leave out the last refuser and any account
      // with confirmed exhaustion. Retry on an untried account first; only
      // revisit an earlier refuser if no untried account can serve.
      const exhausted: StickyQuotaBlocker[] = []
      const usable = oauth.filter((account) => {
        if (account.id === lastRefuser) return false
        const blocked = blockerFor(account)
        if (blocked) exhausted.push(blocked)
        return !blocked
      })
      const untried = excluded
        ? usable.filter((row) => !previouslyRefused(row))
        : usable
      const routes = untried.length ? untried : usable
      // As in the vault refusal, a sign-in failure takes precedence over quota.
      const quotaExplainsRefusal =
        exhausted.length > 0 &&
        !snapshot.accounts.some(
          (account) =>
            account.type === 'oauth' &&
            account.enabled &&
            account.state === 'needs_reauth',
        )
      const exhaustedRefusal = () =>
        createExhaustedNoRouteResponse({
          exhausted,
          storage: snapshot.policyStorage,
          sessionId: input.sessionID,
        })
      const refusal = async (response: Response) => {
        const details = quotaRefusalDetails(response)
        if (details)
          response = createQuotaRefusalResponse(
            details.reason,
            details.timing,
            Date.now(),
            { retry: 'manual' },
          )
        return await NativeVaultQuotaPolicyError.fromResponse(response)
      }
      // The sticky deadline decides when to move, not when to stop a turn
      // whose entire eligible pool is exhausted. With no alternate route,
      // let the host recheck the refused account in bounded gaps.
      const poolHold = (): RetryHold | undefined => {
        const delayMs = poolDecision(
          input,
          snapshot,
          oauth,
          modelID,
          advice,
        )?.delayMs
        if (delayMs === undefined) return undefined
        startRoutingWait({
          sessionId: input.sessionID,
          reason: 'account_free',
          delayMs,
          nextMs: Date.now() + delayMs,
        })
        return { hold: { delayMs } }
      }
      if (getRoutingMode(snapshot.policyStorage) === 'sticky-balanced') {
        const candidates = routes.map((account, order) => ({
          accountId: account.id,
          order,
          quota: account.quota ?? { kind: 'unknown' as const },
        }))
        const selected = await routerFor(snapshot).resolve({
          sessionId: input.sessionID,
          family: stickyRouteFamilyForModel(modelID),
          modelId: modelID,
          affinityModelId: input.modelID,
          candidates,
          retainAccountIds: new Set(routes.map((account) => account.id)),
          // Vault routes are bound to the verified account UUID they served,
          // so a route whose UUID changed (a replaced vault default) is
          // re-placed instead of keeping another account's session pin. List
          // every vault account with a UUID, even ones quota excludes from
          // `candidates`. Local routes omit the map and keep their old pins.
          ...(snapshot.mode === 'claustrum'
            ? {
                accountIdentities: new Map(
                  snapshot.accounts.flatMap((account) =>
                    account.accountIdentity
                      ? [[account.id, account.accountIdentity] as const]
                      : [],
                  ),
                ),
              }
            : {}),
          storage: snapshot.policyStorage,
          inputBytes: 1,
          preferredAccountId: input.previousAccountId,
          // A refusal leaves the host in charge; it must not clear its route.
          preserveOnNoCandidate: true,
        })
        active.signal.throwIfAborted()
        if (selected) {
          if (
            selected.migrated ||
            (input.rerouteFrom &&
              selected.accountId !== input.rerouteFrom.accountId)
          )
            stickyQuotaRetries.clear(input.sessionID)
          return selected.accountId
        }
      } else {
        const mode = getRoutingMode(snapshot.policyStorage)
        const ordered =
          mode === 'fallback-first'
            ? [
                ...routes.filter((account) => account.id !== 'main'),
                ...routes.filter((account) => account.id === 'main'),
              ]
            : [
                ...routes.filter((account) => account.id === 'main'),
                ...routes.filter((account) => account.id !== 'main'),
              ]
        if (ordered[0]) return ordered[0].id
      }
      if (snapshot.mode === 'claustrum') {
        const holdForPool = poolHold()
        if (holdForPool) return holdForPool
        let response: Response
        try {
          response = createNativeVaultNoRouteResponse({
            snapshot,
            sessionId: input.sessionID,
            modelId: modelID,
            policies,
            sticky:
              getRoutingMode(snapshot.policyStorage) === 'sticky-balanced',
          })
        } catch (error) {
          // The vault refusal finds no quota policy at work when the accounts
          // left out are confirmed exhausted yet not below a quota floor.
          if (!(error instanceof NativeVaultNoAccountError)) throw error
          if (!quotaExplainsRefusal) throw error
          response = exhaustedRefusal()
        }
        throw await refusal(response)
      }
      if (advice) return undefined
      const api = await paidFallback(input, snapshot, active)
      if (api) return api
      const holdForPool = poolHold()
      if (holdForPool) return holdForPool
      // Local mode explains a pool that is out of quota as the vault does.
      if (quotaExplainsRefusal) throw await refusal(exhaustedRefusal())
      return undefined
    },
    dropChoice() {
      // Account choices retain no authorization. Session routing pins outlive
      // an unused choice; same-account recoveries have their own release hook.
    },
    async retrySameAccount(input) {
      if (input.continuation === 'interrupted-read') {
        const served = servedAccounts.get(key(input, input.accountId))
        if (!served) return undefined
        const active = controller(input)
        const modelID = remapModelId(
          (await options.resolveModelId?.(input)) ?? input.modelID,
        )
        const snapshot = await runtime.read(modelID)
        active.signal.throwIfAborted()
        assertTransport(snapshot, gateway())
        const account = snapshot.accounts.find(
          (row) => row.id === input.accountId,
        )
        return account &&
          sameAccount(account, served.account) &&
          eligible(account, snapshot, modelID, input.sessionID)
          ? { accountId: input.accountId }
          : undefined
      }
      const reason = input.limit?.reason
      const retry = reason ? retries.get(reason) : undefined
      if (
        !retry ||
        key(retry.scope, retry.accountId) !== key(input, input.accountId)
      )
        return undefined
      // Remove the prepared retry now, so a retry this call declines or fails
      // on can never be handed to a later request.
      retries.delete(retry.reason)
      const active = controller(input)
      const modelID = remapModelId(
        (await options.resolveModelId?.(input)) ?? input.modelID,
      )
      const snapshot = await runtime.read(modelID)
      active.signal.throwIfAborted()
      assertTransport(snapshot, gateway())
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
      if (
        !account ||
        !sameAccount(account, retry.account) ||
        !eligible(account, snapshot, modelID, input.sessionID)
      )
        return undefined
      const queueKey = key(input, input.accountId)
      const queue = recoveries.get(queueKey) ?? []
      queue.push(retry)
      recoveries.set(queueKey, queue)
      return { accountId: input.accountId }
    },
    dropSameAccountRetry(input) {
      if (!input.limit) return
      const queueKey = key(input, input.accountId)
      const queue = recoveries.get(queueKey)
      const index =
        queue?.findIndex((retry) => retry.reason === input.limit?.reason) ?? -1
      if (index !== -1) queue?.splice(index, 1)
      if (queue?.length === 0) recoveries.delete(queueKey)
    },
    async authorizeAccount(scope, accountId, onRefusal) {
      const active = controller(scope)
      const modelID = remapModelId(
        (await options.resolveModelId?.(scope)) ?? scope.modelID,
      )
      const snapshot = await runtime.read(modelID)
      syncDumpEnabled(snapshot)
      active.signal.throwIfAborted()
      assertTransport(snapshot, gateway())
      const account = snapshot.accounts.find((row) => row.id === accountId)
      if (!account || !eligible(account, snapshot, modelID, scope.sessionID)) {
        onRefusal?.(
          !account || !nativeAccountCanServe(account)
            ? 'account-unavailable'
            : 'account-policy',
        )
        return undefined
      }
      const queueKey = key(scope, accountId)
      const queue = recoveries.get(queueKey)
      const choice = queue?.shift()
      if (queue?.length === 0) recoveries.delete(queueKey)
      if (choice && !sameAccount(account, choice.account)) return undefined
      const {
        dispatch,
        relayFallback,
        gateway: sendGateway,
      } = await dispatchFor(snapshot, choice?.direct === true, account.type)
      const gatewayField = sendGateway ? { gateway: sendGateway } : {}
      active.signal.throwIfAborted()
      if (choice?.auth) {
        if (
          !(await admitted(
            accountId,
            modelID,
            choice.auth.route,
            active,
            onRefusal,
            scope.sessionID,
          ))
        )
          return undefined
        const served = states.get(choice.auth.provenance)
        if (
          served?.receipt?.expiresAtMs !== undefined &&
          served.receipt.expiresAtMs !== null &&
          served.receipt.expiresAtMs < Date.now() + 300_000
        )
          return undefined
        if (served)
          states.set(choice.auth.provenance, {
            ...served,
            scope: { ...scope, modelID },
            account,
            active,
            relayFallback,
          })
        recordServed(scope, account)
        if (choice.auth.route === 'api') return { ...choice.auth, dispatch }
        const { gateway: _earlier, ...auth } = choice.auth
        return { ...auth, dispatch, ...gatewayField }
      }
      const common = {
        scope: { ...scope, modelID },
        active,
        account,
        retry: choice?.retry ?? false,
        relayFallback,
        quota: account.quota,
      }
      if (account.type === 'api') {
        const main = snapshot.accounts.find(
          (row) => row.id === 'main' && row.type === 'oauth',
        )
        if (
          !main ||
          !stickyQuotaSnapshotIsFresh(main.quota, snapshot.policyStorage) ||
          !quotaSnapshotIsExhausted(main.quota)
        )
          return undefined
        const material = await runtime.authorizeApi(accountId, active.signal)
        active.signal.throwIfAborted()
        if (
          !(await admitted(
            accountId,
            modelID,
            'api',
            active,
            undefined,
            scope.sessionID,
          ))
        )
          return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'api',
          subject: material.subject,
        }
        states.set(provenance, common)
        recordServed(scope, account)
        const headers: HeaderEdits =
          material.authHeader === 'authorization-bearer'
            ? { authorization: `Bearer ${material.apiKey}` }
            : { 'x-api-key': material.apiKey }
        return {
          route: 'api',
          headers,
          baseURL: material.baseURL,
          provenance,
          dispatch,
        }
      }
      if (account.source === 'vault') {
        const receipt = await runtime.authorizeVault(accountId, active.signal)
        active.signal.throwIfAborted()
        if (
          choice &&
          (receipt.credentialId !== choice.account.credentialId ||
            receipt.assertedAccountIdentity !== choice.account.accountIdentity)
        )
          return undefined
        if (
          !(await admitted(
            accountId,
            modelID,
            'oauth',
            active,
            onRefusal,
            scope.sessionID,
          ))
        )
          return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'vault',
          credentialId: receipt.credentialId,
          recordVersion: receipt.recordVersion,
        }
        states.set(provenance, { ...common, receipt })
        const identity = receipt.assertedAccountIdentity
        if (!identity) {
          onRefusal?.('account-unavailable')
          return undefined
        }
        recordServed(scope, account)
        return {
          route: 'oauth',
          accessToken: receipt.accessToken,
          credentialId: receipt.credentialId,
          provenance,
          dispatch,
          ...gatewayField,
          identity: getClaudeCodeIdentityForVerifiedAccount(
            identity,
            identity as ProviderAccountUuid,
          ),
        }
      }
      const material = await runtime.authorizeLocal(accountId, {
        signal: active.signal,
        policy: (row, view) =>
          routingRelay.policy(scope.sessionID, row, view, modelID),
      })
      active.signal.throwIfAborted()
      if (material.status !== 'usable') {
        const refusal = nativeLocalAccountRefusal(material)
        if (refusal) onRefusal?.(refusal.reason)
        return undefined
      }
      if (
        !(await admitted(
          accountId,
          modelID,
          'oauth',
          active,
          onRefusal,
          scope.sessionID,
        ))
      )
        return undefined
      const provenance: NativeSourceProvenance = {
        kind: 'local',
        subject: material.subject,
      }
      states.set(provenance, { ...common, access: material.access })
      recordServed(scope, account)
      const identity = material.subject.binding.identity
      return {
        route: 'oauth',
        accessToken: material.access,
        credentialId: localMessageThreadCredential(material.subject.binding),
        provenance,
        dispatch,
        ...gatewayField,
        identity: getClaudeCodeIdentityForVerifiedAccount(
          identity,
          identity as ProviderAccountUuid,
        ),
      }
    },
    async requestOptions(input, onRefusal) {
      const active = controller(input)
      const snapshot = await runtime.read(input.modelID)
      syncDumpEnabled(snapshot)
      active.signal.throwIfAborted()
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
      if (
        !account ||
        !eligible(account, snapshot, input.modelID, input.sessionID)
      ) {
        onRefusal?.(
          !account || !nativeAccountCanServe(account)
            ? 'account-unavailable'
            : 'account-policy',
        )
        throw new Error(
          'request refused: native account is ineligible for this model',
        )
      }
      const bodyOptions = options.requestOptions(input, snapshot)
      const turnId = bodyOptions.billingLineage?.promptId
      if (turnId && turnIds.get(input.sessionID) !== turnId) {
        stickyQuotaRetries.clear(input.sessionID)
        turnIds.set(input.sessionID, turnId)
      }
      const state = states.get(input.provenance)
      if (state)
        states.set(input.provenance, {
          ...state,
          scope: { ...state.scope, modelID: input.modelID },
        })
      return bodyOptions
    },
    async admitRequest(input, onRefusal) {
      const state = states.get(input.provenance)
      const admission =
        state &&
        (await admitted(
          input.accountId,
          input.modelID,
          input.route,
          state.active,
          onRefusal,
          input.sessionID,
        ))
      if (!state || !admission)
        throw new Error(
          'request refused: native account policy changed before dispatch',
        )
      states.set(input.provenance, {
        ...state,
        snapshot: admission.snapshot,
        account: admission.account,
        scope: { ...state.scope, modelID: input.modelID },
      })
    },
    isDumpEnabled: () => readDumpEnabled(),
    onRequestPrepared: (input) => {
      if (
        input.route === 'oauth' &&
        input.agent !== 'prime' &&
        input.agent !== 'cachekeep' &&
        !input.signal?.aborted
      ) {
        cacheAttempts.set(input.attemptId, {
          sessionID: input.sessionID,
          accountId: input.accountId,
          signal: input.signal,
          cacheTtlMs: requestCacheLifetimeMs(input.bodyText),
          ttlOverridden:
            readSessionCachePolicy(input.sessionID, true)?.ttl !== undefined,
          bodyText: input.bodyText,
          sessionSignal: states.get(input.provenance)?.active.signal,
        })
        if (cacheAttempts.size > 4096) {
          const oldest = cacheAttempts.keys().next().value
          if (oldest !== undefined) cacheAttempts.delete(oldest)
        }
      }
      const state = states.get(input.provenance)
      return options.onRequestPrepared?.({
        ...input,
        ...(state?.snapshot && {
          admission: { snapshot: state.snapshot, account: state.account },
        }),
      })
    },
    onFinalRequestPrepared(input) {
      const cached = cacheAttempts.get(input.attemptId)
      if (!cached) return
      if (input.requestId) {
        wireRequests.set(input.requestId, {
          attemptId: input.attemptId,
          sessionID: cached.sessionID,
        })
        if (wireRequests.size > 4096) {
          const oldest = wireRequests.keys().next().value
          if (oldest !== undefined) wireRequests.delete(oldest)
        }
      }
      cached.finalWire = { ttlMs: input.ttlMs }
    },
    onResponseHandedToHost(request, accepted) {
      const requestId = request.headers.get('x-client-request-id')
      if (!requestId) return
      const wire = wireRequests.get(requestId)
      if (!wire) return
      const { attemptId } = wire
      wireRequests.delete(requestId)
      const cached = cacheAttempts.get(attemptId)
      if (!cached) return
      cached.handedOff = true
      cached.accepted = Boolean(
        accepted &&
          cached.finalWire &&
          !cached.signal?.aborted &&
          !cached.sessionSignal?.aborted,
      )
      options.onCacheResponse?.({
        attemptId,
        acceptedUsage: cached.usage,
        ...(cached.accepted && accepted && { acceptedAt: accepted.at }),
        ttlMs:
          cached.finalWire?.ttlMs === 0 && !cached.ttlOverridden
            ? undefined
            : cached.finalWire?.ttlMs,
      })
      if (cached.accepted && accepted && cached.finalWire) {
        sessionCacheActivity.record(
          cached.sessionID,
          cached.accountId,
          cached.finalWire.ttlMs === 0 && !cached.ttlOverridden
            ? undefined
            : cached.finalWire.ttlMs,
          accepted.at,
        )
        if (cached.usage)
          options.onCacheUsage?.(
            cached.sessionID,
            cached.bodyText,
            cached.usage,
          )
        reportSessionCacheTouch(cached.sessionID, {
          at: accepted.at,
          ttlMs: cached.finalWire.ttlMs,
          source: 'response',
        })
      }
      if (cached.ended) cacheAttempts.delete(attemptId)
    },
    async quotaStopMessage(input) {
      const state = states.get(input.provenance)
      if (!state || state.active.signal.aborted || input.route !== 'oauth')
        return undefined
      const modelID = state.scope.modelID
      const snapshot = await runtime.read(modelID)
      const assignment = await routerFor(snapshot).readAssignment(
        input.sessionID,
      )
      const advice = await routingRelay.accountFor(
        input.sessionID,
        modelID,
        routingCandidates(snapshot.accounts),
        {
          // This probe only decides the text of an existing 429 response.
          capacityWait: { maxInRequestMs: 0 },
          signal: state.active.signal,
          warmCredentialId: routingWarmCredential(
            snapshot.accounts,
            assignment,
          ),
        },
      )
      const retry: ChooseAccountInput = {
        ...input,
        modelID,
        phase: 'retry',
        hostAttempt: input.hostAttempt + 1,
        rerouteFrom: {
          accountId: input.accountId,
          limit: { status: 429, reason: 'provider-429' },
        },
      }
      const terminal = await terminalPoolDecision(
        retry,
        snapshot,
        modelID,
        advice,
        state.active,
      )
      if (terminal) {
        const waiting = createQuotaRefusalResponse(
          'No Claude account can take this request until a quota window resets.',
          terminal.timing,
        )
        const body = (await waiting.json()) as { error: { message: string } }
        return body.error.message
      }
      const { oauth } = await oauthPool(input, snapshot, modelID, state.active)
      const decision = poolDecision(retry, snapshot, oauth, modelID, advice)
      if (!decision || decision.delayMs !== undefined) return undefined
      if (
        snapshot.mode !== 'claustrum' &&
        snapshot.accounts.some(
          (row) => row.type === 'api' && nativeAccountCanServe(row),
        ) &&
        (await paidFallback(retry, snapshot, state.active))
      )
        return undefined
      const refusal = createExhaustedNoRouteResponse({
        exhausted: decision.exhausted,
        storage: snapshot.policyStorage,
        sessionId: input.sessionID,
      })
      const details = quotaRefusalDetails(refusal)
      if (!details) return undefined
      const manual = createQuotaRefusalResponse(
        details.reason,
        details.timing,
        Date.now(),
        { retry: 'manual' },
      )
      const body = (await manual.json()) as { error: { message: string } }
      return body.error.message
    },
    responseOptions(input) {
      const cached = cacheAttempts.get(input.attemptId)
      const active = states.get(input.provenance)?.active.signal
      if (cached && active) cached.sessionSignal = active
      const configured = options.responseOptions?.({
        ...input,
        modelID: states.get(input.provenance)?.scope.modelID ?? input.modelID,
      })
      const usage = (message: unknown) => {
        if (
          !cached ||
          cached.signal?.aborted ||
          cached.sessionSignal?.aborted ||
          !message ||
          typeof message !== 'object'
        )
          return
        const value = (message as { usage?: unknown }).usage
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        cached.usage = { ...cached.usage, ...value }
        if (cached.accepted)
          options.onCacheUsage?.(
            cached.sessionID,
            cached.bodyText,
            cached.usage,
          )
      }
      return {
        ...configured,
        onMessageStart: (message) => {
          configured?.onMessageStart?.(message)
          usage(message)
        },
        onMessageResponse: (message) => {
          configured?.onMessageResponse?.(message)
          usage(message)
        },
        onMessageDelta: (delta) => {
          configured?.onMessageDelta?.(delta)
          usage(delta)
        },
      }
    },
    quotaFromHeaders(headers, input) {
      const receivedAt = Date.now()
      options.onResponseHeaders?.(input)
      const state = states.get(input.provenance)
      const cacheAttempt = cacheAttempts.get(input.attemptId)
      if (state) {
        if (
          input.route === 'oauth' &&
          input.status >= 200 &&
          input.status < 300 &&
          !state.active.signal.aborted &&
          cacheAttempt?.sessionID === input.sessionID &&
          cacheAttempt.accountId === input.accountId &&
          !cacheAttempt.signal?.aborted
        )
          // Without a TTL override, unmarked local requests keep their legacy
          // five-minute sticky-account hold before quota routing may switch the
          // session to another account. Runner reports use the actual wire TTL.
          sessionCacheActivity.record(
            input.sessionID,
            input.accountId,
            (cacheAttempt.finalWire?.ttlMs ?? cacheAttempt.cacheTtlMs) === 0 &&
              !cacheAttempt.ttlOverridden
              ? undefined
              : (cacheAttempt.finalWire?.ttlMs ?? cacheAttempt.cacheTtlMs),
          )
        const refusalKey = key(
          { ...input, modelID: state.scope.modelID },
          input.accountId,
        )
        if (input.status === 429) {
          refusalHeaders.delete(refusalKey)
          refusalHeaders.set(refusalKey, {
            sessionID: input.sessionID,
            headers,
            receivedAt,
          })
          if (refusalHeaders.size > 512) {
            const oldest = refusalHeaders.keys().next().value
            if (oldest !== undefined) refusalHeaders.delete(oldest)
          }
        } else refusalHeaders.delete(refusalKey)
        state.responseHeaders = headers
        if (input.reportRouting !== false) {
          const served = input.status < 400 && !servedTurns.has(input.sessionID)
          if (served) servedTurns.add(input.sessionID)
          if (input.status === 429) reportRateLimit(input, state)
          else
            routingRelay.report(
              input.sessionID,
              {
                accountIdentity: state.account.accountIdentity,
                credentialId:
                  input.provenance.kind === 'vault'
                    ? input.provenance.credentialId
                    : state.account.credentialId,
              },
              headers,
              input.status,
              state.scope.modelID,
              served,
            )
        }
      }
      const requestId = extractAnthropicRequestId(headers)
      if (requestId) options.onRequestId?.(input, requestId)
      if (
        !state ||
        input.route !== 'oauth' ||
        !isQuotaBearingHeaderFrame(headers)
      )
        return undefined
      const identity =
        input.provenance.kind === 'local'
          ? input.provenance.subject.binding.identity
          : state.receipt?.assertedAccountIdentity
      const incoming = {
        ...normalizeQuotaHeaders(headers, receivedAt),
        ...(identity ? { accountIdentity: identity } : {}),
      }
      const quota = mergeHeaderQuotaForPersistence(state.quota, incoming)
      state.quota = quota
      const held = holdLocalReading(input.provenance, state, quota)
      // Publish these headers with the provenance of the send that observed
      // them. The runtime's account and authority fences decide whether to
      // keep the observation. The write is started, not awaited:
      // streaming and attempt completion never wait on file locks. A refused
      // observation is logged and dropped, never a failure of the request.
      const accountId = state.account.id
      const forget = () => {
        if (held) runtime.quotaObservations.forget(accountId, held)
      }
      void usagePublications.observe(
        publish(input.provenance, state, { quota }).then(
          (kept) => {
            if (!kept) forget()
          },
          (error: unknown) => {
            forget()
            throw error
          },
        ),
      )
      return incoming
    },
    async limitFromResponse(input) {
      const state = states.get(input.provenance)
      if (!state) return undefined
      if (input.status === 401 && state.receipt) {
        if (!reported.has(state.receipt)) {
          reported.add(state.receipt)
          await runtime.vault.reportFailure(
            state.receipt,
            401,
            input.dispatch === 'http-relay' ? 'relay_status_field' : 'direct',
          )
        }
        if (state.retry || state.active.signal.aborted) return undefined
        const active = state.active
        const result = await runtime.vault.prepareRetry(
          state.receipt,
          active.signal,
        )
        active.signal.throwIfAborted()
        if (!result.retry) return undefined
        const receipt = result.receipt
        const identity = receipt.assertedAccountIdentity
        if (!identity) return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'vault',
          credentialId: receipt.credentialId,
          recordVersion: receipt.recordVersion,
        }
        states.set(provenance, { ...state, receipt, retry: true })
        const reason = `vault-newer:${input.attemptId}`
        retries.set(reason, {
          scope: retryScope(input),
          reason,
          accountId: input.accountId,
          account: state.account,
          retry: true,
          auth: {
            route: 'oauth',
            accessToken: receipt.accessToken,
            credentialId: receipt.credentialId,
            provenance,
            identity: getClaudeCodeIdentityForVerifiedAccount(
              identity,
              identity as ProviderAccountUuid,
            ),
          },
        })
        boundRetries()
        return { reason, status: 401 }
      }
      if (
        input.status === 401 &&
        input.provenance.kind === 'local' &&
        state.access &&
        !state.retry
      ) {
        if (state.active.signal.aborted) return undefined
        const active = state.active
        const result = await runtime.authorizeLocal(input.accountId, {
          rejectedAccessToken: state.access,
          signal: active.signal,
          policy: (account, snapshot) =>
            routingRelay.policy(
              input.sessionID,
              account,
              snapshot,
              state.scope.modelID,
            ),
        })
        active.signal.throwIfAborted()
        if (result.status !== 'usable' || result.access === state.access)
          return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'local',
          subject: result.subject,
        }
        states.set(provenance, { ...state, access: result.access, retry: true })
        const identity = result.subject.binding.identity
        const reason = `local-newer:${input.attemptId}`
        retries.set(reason, {
          scope: retryScope(input),
          reason,
          accountId: input.accountId,
          account: state.account,
          retry: true,
          auth: {
            route: 'oauth',
            accessToken: result.access,
            credentialId: localMessageThreadCredential(result.subject.binding),
            provenance,
            identity: getClaudeCodeIdentityForVerifiedAccount(
              identity,
              identity as ProviderAccountUuid,
            ),
          },
        })
        boundRetries()
        return { reason, status: 401 }
      }
      const snapshot = await runtime.read()
      if (shouldFallbackStatus(input.status, snapshot.policyStorage))
        return { reason: `provider-${input.status}`, status: input.status }
      return undefined
    },
    limitFromRelayFailure(input) {
      const state = states.get(input.provenance)
      if (
        !state?.relayFallback ||
        state.active.signal.aborted ||
        !(input.status === 401 || input.status >= 500)
      )
        return undefined
      const reason = `relay-direct:${input.attemptId}`
      retries.set(reason, {
        scope: retryScope(input),
        reason,
        accountId: input.accountId,
        account: state.account,
        direct: true,
        retry: false,
      })
      boundRetries()
      return { reason }
    },
    limitFromStreamError(input) {
      const state = states.get(input.provenance)
      if (state && input.errorType === 'rate_limit_error')
        reportRateLimit(input, state)
      return input.errorType === 'rate_limit_error'
        ? { reason: 'provider-rate-limit', status: 429 }
        : undefined
    },
    limitFromHostError(error, input) {
      const state = states.get(input.provenance)
      if (
        input.dispatch === 'http-relay' &&
        state?.relayFallback &&
        !state.active.signal.aborted &&
        error.status === undefined
      ) {
        const reason = `relay-direct:${input.attemptId}`
        retries.set(reason, {
          scope: retryScope(input),
          reason,
          accountId: input.accountId,
          account: state.account,
          direct: true,
          retry: false,
        })
        boundRetries()
        return { reason }
      }
      return undefined
    },
    async onAttemptEnd(input, outcome) {
      const cached = cacheAttempts.get(input.attemptId)
      if (cached) cached.ended = true
      if (cached?.handedOff || outcome.status === undefined)
        cacheAttempts.delete(input.attemptId)
      await options.onAttemptEnd?.(input, outcome)
      const state = states.get(input.provenance)
      if (!state) return
      try {
        if (
          outcome.status === 401 &&
          state.receipt &&
          !reported.has(state.receipt)
        ) {
          reported.add(state.receipt)
          await runtime.vault.reportFailure(
            state.receipt,
            401,
            input.dispatch === 'http-relay' ? 'relay_status_field' : 'direct',
          )
        }
        if (!outcome.localRefusal && outcome.status !== undefined)
          usagePublications.publish(() =>
            publish(input.provenance, state, { lastUsed: Date.now() }),
          )
      } finally {
        states.delete(input.provenance)
      }
    },
    forgetTurn(sessionID) {
      stickyQuotaRetries.clear(sessionID)
      turnIds.delete(sessionID)
    },
    forgetSession(sessionID) {
      for (const [requestId, wire] of wireRequests)
        if (wire.sessionID === sessionID) wireRequests.delete(requestId)
      source.forgetTurn?.(sessionID)
      for (const [attemptId, attempt] of cacheAttempts)
        if (attempt.sessionID === sessionID) cacheAttempts.delete(attemptId)
      sessionCacheActivity.forget(sessionID)
      for (const [key, value] of refusalHeaders)
        if (value.sessionID === sessionID) refusalHeaders.delete(key)
      servedTurns.delete(sessionID)
      grantedHolds.delete(sessionID)
      sessions.get(sessionID)?.abort()
      sessions.delete(sessionID)
      servedBy.delete(sessionID)
      for (const [servedKey, served] of servedAccounts)
        if (served.scope.sessionID === sessionID)
          servedAccounts.delete(servedKey)
      for (const [reason, retry] of retries)
        if (retry.scope.sessionID === sessionID) retries.delete(reason)
      for (const [queueKey, queue] of recoveries)
        if (queue[0]?.scope.sessionID === sessionID) recoveries.delete(queueKey)
      options.onForgetSession?.(sessionID)
    },
    peekAccount: (sessionId, modelId, snapshot) =>
      peekRoutingAccount({
        snapshot,
        router: snapshot.routingPath
          ? routers.get(snapshot.routingPath)
          : undefined,
        sessionId,
        modelId: modelId ? remapModelId(modelId) : undefined,
      }),
    servedAccount: (sessionID) => servedBy.get(sessionID),
    resetRouting: async (sessionID) => {
      source.forgetTurn?.(sessionID)
      await routerFor(await runtime.read()).clear(sessionID)
    },
    async recordPrime(provenance, usage) {
      const state = states.get(provenance)
      if (!state || state.active.signal.aborted) return false
      if (provenance.kind === 'local')
        return runtime.incrementPrimeUsage(
          state.account.id,
          provenance.subject,
          usage,
        )
      if (provenance.kind === 'vault' && state.receipt)
        return runtime.incrementPrimeUsage(
          state.account.id,
          state.receipt,
          usage,
        )
      return false
    },
    drainRoutingPublications: () =>
      Promise.all([
        runtime.drainRoutingPublications(),
        ...[...routers.values()].map((router) => router.drain()),
      ]).then(() => {}),
    close() {
      wireRequests.clear()
      cacheAttempts.clear()
      closed = true
      for (const active of sessions.values()) active.abort()
      sessions.clear()
      servedAccounts.clear()
      recoveries.clear()
      retries.clear()
      return Promise.all([
        usagePublications.close(),
        source.drainRoutingPublications(),
      ]).then(() => {})
    },
  }
  return source
}
