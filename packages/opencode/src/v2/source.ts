import {
  createNativeUsagePublisher,
  createNativeVaultNoRouteResponse,
  decideStickyQuotaFailure,
  effectiveRelayTransport,
  getClaudeCodeIdentityForVerifiedAccount,
  getQuotaCheckIntervalMs,
  getRoutingMode,
  isDumpPersistentlyEnabled,
  isQuotaBearingHeaderFrame,
  logger,
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
  NativeVaultQuotaPolicyError,
  nativeAccountCanServe,
  nativeAccountPolicy,
  nativeLocalAccountRefusal,
  nativeLocalQuotaLineage,
  nativePollQuotaGenerallyExhausted,
  normalizeQuotaHeaders,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
  quotaSnapshotCheckedAt,
  quotaSnapshotHasStandardWindows,
  readNativeAccountsForRequest,
  remapModelId,
  requestSignal,
  StickySessionRouter,
  setDumpEnabled,
  shouldFallbackStatus,
  stickyQuotaSnapshotIsFresh,
  stickyRetryAfterWithJitter,
  stickyRouteFamilyForModel,
} from '@cortexkit/anthropic-auth-core'
import type {
  ChooseAccountInput,
  ChooseAccountResult,
  HeaderEdits,
  RequestScope,
  RetryHold,
} from '@cortexkit/common-auth/opencode2'
import { extractAnthropicRequestId } from '../billing-lineage'
import {
  createRoutingRelay,
  routingChoiceMatches,
  routingReserveAllows,
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

/**
 * Sticky-balanced sessions wait on their own account, as OpenCode 1 and Pi
 * do, when a 429 refused it and every exhausted quota window blocking the
 * model has a known reset within 15 minutes. The wait is that reset plus the
 * session's deterministic jitter. The installer then keeps the refused account
 * and its routing pin and replaces the host's retry wait with this delay.
 *
 * `servable` holds the accounts that can serve this model right now. A
 * refused account outside it would be refused again by `authorizeAccount`
 * when the held retry runs, so it moves instead of waiting. That covers a
 * model-scoped window at zero and a configured quota floor or killswitch.
 */
function stickyHold(
  input: ChooseAccountInput,
  snapshot: NativeAccountSnapshot,
  servable: readonly NativeAccountView[],
  modelID: string,
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
  if (
    !account ||
    !stickyQuotaSnapshotIsFresh(
      account.quota,
      snapshot.policyStorage,
      Date.now(),
      modelID,
    )
  )
    return undefined
  const decision = decideStickyQuotaFailure({
    quota: account.quota,
    modelId: modelID,
  })
  if (decision.action !== 'hold') return undefined
  return {
    hold: {
      delayMs:
        stickyRetryAfterWithJitter(
          input.sessionID,
          decision.retryAfterSeconds,
        ) * 1000,
    },
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
  readonly onRequestPrepared?: NativeSource['onRequestPrepared']
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
  const retries = new Map<string, Retry>()
  const recoveries = new Map<string, Retry[]>()
  const sessions = new Map<string, AbortController>()
  // The account behind each session's latest authorization, for the sidebar.
  // Entries leave with forgetSession, which also bounds `sessions`.
  const servedBy = new Map<string, string>()
  const reported = new WeakSet<NativeCustodyReceipt>()
  let closed = false
  const boundRetries = () => {
    while (retries.size > 512) {
      const first = retries.keys().next()
      if (!first.done) retries.delete(first.value)
    }
  }

  // Mirror the current custody mode's persisted dump switch into this
  // process's Core dump flag, so Core's manager (CacheKeep prewarms) and the
  // adapter's settings-gated dumps agree. The switch lives in the snapshot's
  // policy storage for the current mode, local or vault, exactly where the
  // OpenCode 2 menu writes it (`write('dump', { enabled })`).
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
  ) =>
    nativeAccountCanServe(account) &&
    (account.type === 'api' ||
      nativeAccountPolicy(account, snapshot, remapModelId(modelID)).status ===
        'allowed')
  const sameAccount = (
    account: NativeAccountView,
    expected: NativeAccountView,
  ) =>
    account.source === expected.source &&
    account.accountIdentity === expected.accountIdentity &&
    account.credentialId === expected.credentialId
  const admitted = async (
    accountId: string,
    modelID: string,
    route: 'oauth' | 'api',
    active: AbortController,
    onRefusal?: (reason: NativeAccountRefusalReason) => void,
  ) => {
    const current = await runtime.read()
    syncDumpEnabled(current)
    active.signal.throwIfAborted()
    assertTransport(current)
    const account = current.accounts.find((row) => row.id === accountId)
    if (
      !account ||
      account.type !== route ||
      !eligible(account, current, modelID)
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
      return (
        !!main &&
        stickyQuotaSnapshotIsFresh(main.quota, current.policyStorage) &&
        quotaSnapshotIsExhausted(main.quota)
      )
    }
    return true
  }

  const assertTransport = (snapshot: NativeAccountSnapshot) => {
    const selected = snapshot.policyStorage.relay
    if (
      selected?.enabled === true &&
      effectiveRelayTransport(selected.transport, selected.url) === 'websocket'
    )
      throw new NativeAnthropicTransportRefusal()
  }
  const dispatchFor = async (
    snapshot: NativeAccountSnapshot,
    direct: boolean,
  ) => {
    assertTransport(snapshot)
    if (direct || snapshot.policyStorage.relay?.enabled !== true)
      return { dispatch: { kind: 'direct' as const }, relayFallback: false }
    // Account and status data exclude the relay secret. Obtain it through the
    // private transport accessor immediately before preparing the send.
    const relay = await runtime.getRelayConfig()
    if (!relay)
      throw new Error(
        'request refused: native HTTP relay configuration is unavailable',
      )
    if (relay.transport !== 'http') throw new NativeAnthropicTransportRefusal()
    return {
      dispatch: {
        kind: 'http-relay' as const,
        url: relay.url,
        token: relay.token,
      },
      relayFallback: relay.fallbackToDirect,
    }
  }

  async function publish(
    provenance: NativeSourceProvenance,
    state: State,
    patch: { quota?: OAuthQuotaSnapshot; lastUsed?: number },
  ): Promise<boolean> {
    if (provenance.kind === 'local') {
      const kept = await runtime.publishLocal(provenance.subject, patch)
      if (!kept && patch.quota)
        logger.warn('quota', 'Quota publication discarded')
      return kept
    }
    if (provenance.kind === 'vault' && state.receipt)
      await runtime.vault.publish(state.receipt, patch)
    else if (provenance.kind === 'api' && patch.lastUsed !== undefined)
      await runtime.publishApi(provenance.subject, { lastUsed: patch.lastUsed })
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
    async chooseAccount(
      input: ChooseAccountInput,
    ): Promise<ChooseAccountResult> {
      // Credential maintenance and quota readings may occur without selecting
      // an account. Returning undefined must not consume a pending retry,
      // queue an account choice, or create, move or delete a session pin.
      const active = controller(input)
      options.onOwnedRequest?.()
      let snapshot = await runtime.read()
      syncDumpEnabled(snapshot)
      active.signal.throwIfAborted()
      // Account selection rejects a WebSocket relay before any OAuth token
      // refresh or retrieval starts.
      assertTransport(snapshot)
      const modelID = remapModelId(
        (await options.resolveModelId?.(input)) ?? input.modelID,
      )
      active.signal.throwIfAborted()
      if (snapshot.mode === 'claustrum') {
        snapshot = await readNativeAccountsForRequest(runtime, active.signal)
        active.signal.throwIfAborted()
      }
      if (snapshot.policyStorage.quota?.enabled !== false) {
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
        if (refreshed) snapshot = await runtime.read()
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
      const advice = await routingRelay.accountFor(
        input.sessionID,
        modelID,
        snapshot.accounts.filter(
          (row) =>
            row.type === 'oauth' &&
            nativeAccountCanServe(row) &&
            nativeAccountPolicy(row, snapshot, modelID).status === 'allowed',
        ),
      )
      active.signal.throwIfAborted()
      if (advice) {
        snapshot = await runtime.read()
        active.signal.throwIfAborted()
        assertTransport(snapshot)
      }
      const oauth: NativeAccountView[] = []
      const policies = new Map<string, NativeAccountPolicy>()
      for (const account of snapshot.accounts) {
        if (account.type !== 'oauth') continue
        const policy = nativeAccountPolicy(account, snapshot, modelID)
        policies.set(account.id, policy)
        if (policy.status !== 'allowed') continue
        if (account.source === 'local') {
          // Skip a local account whose token refresh failed, so it is not
          // selected. Check usability without keeping its token; the send
          // obtains a fresh credential itself.
          const admission = await runtime.authorizeLocal(account.id, {
            signal: active.signal,
            policy: (row, view) => nativeAccountPolicy(row, view, modelID),
          })
          active.signal.throwIfAborted()
          if (admission.status !== 'usable') continue
        }
        oauth.push(account)
      }
      if (advice) {
        const account = oauth.find((row) => routingChoiceMatches(advice, row))
        const candidates = oauth.map((row, order) => ({
          accountId: row.id,
          order,
          quota: row.quota ?? { kind: 'unknown' as const },
        }))
        const supportedHold =
          !advice.hold ||
          (input.phase === 'retry' &&
            input.rerouteFrom?.accountId === account?.id)
        if (
          account &&
          supportedHold &&
          (advice.hold || account.id !== input.rerouteFrom?.accountId) &&
          routingReserveAllows(
            account.id,
            candidates,
            snapshot.policyStorage,
            modelID,
          )
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
          })
          active.signal.throwIfAborted()
          if (selected)
            return advice.hold
              ? { hold: { delayMs: advice.hold.retry_after_ms } }
              : selected.accountId
        }
        // Unlike OpenCode 1's 429, the host hold can only retain a refused retry account.
        routingRelay.override(
          input.sessionID,
          !supportedHold
            ? 'hold requires the same refused retry account'
            : 'unknown account, credential, account policy or Fable reserve',
        )
      }
      const hold = stickyHold(input, snapshot, oauth, modelID)
      if (hold) return hold
      const withoutRejected = oauth.filter(
        (account) => account.id !== input.rerouteFrom?.accountId,
      )
      if (getRoutingMode(snapshot.policyStorage) === 'sticky-balanced') {
        const candidates = withoutRejected.map((account, order) => ({
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
          retainAccountIds: new Set(
            withoutRejected.map((account) => account.id),
          ),
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
        if (selected) return selected.accountId
      } else {
        const mode = getRoutingMode(snapshot.policyStorage)
        const ordered =
          mode === 'fallback-first'
            ? [
                ...withoutRejected.filter((account) => account.id !== 'main'),
                ...withoutRejected.filter((account) => account.id === 'main'),
              ]
            : [
                ...withoutRejected.filter((account) => account.id === 'main'),
                ...withoutRejected.filter((account) => account.id !== 'main'),
              ]
        if (ordered[0]) return ordered[0].id
      }
      if (snapshot.mode === 'claustrum')
        throw await NativeVaultQuotaPolicyError.fromResponse(
          createNativeVaultNoRouteResponse({
            snapshot,
            modelId: modelID,
            policies,
            sticky:
              getRoutingMode(snapshot.policyStorage) === 'sticky-balanced',
          }),
        )
      // Fall back to a pay-per-token API key account only when the primary
      // Claude subscription account ('main') has run out: a recent usage
      // reading for main's current account and credential version must show
      // its five-hour or seven-day subscription limit at zero. A limit on one
      // model only, or a 401, never moves a request onto paid API billing.
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
    },
    dropChoice() {
      // Account choices retain no authorization. Session routing pins outlive
      // an unused choice; same-account recoveries have their own release hook.
    },
    async retrySameAccount(input) {
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
      const snapshot = await runtime.read()
      active.signal.throwIfAborted()
      assertTransport(snapshot)
      const modelID = remapModelId(
        (await options.resolveModelId?.(input)) ?? input.modelID,
      )
      active.signal.throwIfAborted()
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
      if (
        !account ||
        !sameAccount(account, retry.account) ||
        !eligible(account, snapshot, modelID)
      )
        return undefined
      const queueKey = key(input, input.accountId)
      const queue = recoveries.get(queueKey) ?? []
      queue.push(retry)
      recoveries.set(queueKey, queue)
      return { accountId: input.accountId }
    },
    dropSameAccountRetry(input) {
      const queueKey = key(input, input.accountId)
      const queue = recoveries.get(queueKey)
      const index =
        queue?.findIndex(
          (retry) => !input.limit || retry.reason === input.limit.reason,
        ) ?? -1
      if (index !== -1) queue?.splice(index, 1)
      if (queue?.length === 0) recoveries.delete(queueKey)
    },
    async authorizeAccount(scope, accountId, onRefusal) {
      const active = controller(scope)
      const snapshot = await runtime.read()
      syncDumpEnabled(snapshot)
      active.signal.throwIfAborted()
      assertTransport(snapshot)
      const modelID = remapModelId(
        (await options.resolveModelId?.(scope)) ?? scope.modelID,
      )
      active.signal.throwIfAborted()
      const account = snapshot.accounts.find((row) => row.id === accountId)
      if (!account || !eligible(account, snapshot, modelID)) {
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
      const { dispatch, relayFallback } = await dispatchFor(
        snapshot,
        choice?.direct === true,
      )
      active.signal.throwIfAborted()
      if (choice?.auth) {
        if (
          !(await admitted(
            accountId,
            modelID,
            choice.auth.route,
            active,
            onRefusal,
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
        servedBy.set(scope.sessionID, accountId)
        return { ...choice.auth, dispatch }
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
        if (!(await admitted(accountId, modelID, 'api', active)))
          return undefined
        const provenance: NativeSourceProvenance = {
          kind: 'api',
          subject: material.subject,
        }
        states.set(provenance, common)
        servedBy.set(scope.sessionID, accountId)
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
        if (!(await admitted(accountId, modelID, 'oauth', active, onRefusal)))
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
        servedBy.set(scope.sessionID, accountId)
        return {
          route: 'oauth',
          accessToken: receipt.accessToken,
          provenance,
          dispatch,
          identity: getClaudeCodeIdentityForVerifiedAccount(
            identity,
            identity as ProviderAccountUuid,
          ),
        }
      }
      const material = await runtime.authorizeLocal(accountId, {
        signal: active.signal,
        policy: (row, view) => nativeAccountPolicy(row, view, modelID),
      })
      active.signal.throwIfAborted()
      if (material.status !== 'usable') {
        const refusal = nativeLocalAccountRefusal(material)
        if (refusal) onRefusal?.(refusal.reason)
        return undefined
      }
      if (!(await admitted(accountId, modelID, 'oauth', active, onRefusal)))
        return undefined
      const provenance: NativeSourceProvenance = {
        kind: 'local',
        subject: material.subject,
      }
      states.set(provenance, { ...common, access: material.access })
      servedBy.set(scope.sessionID, accountId)
      const identity = material.subject.binding.identity
      return {
        route: 'oauth',
        accessToken: material.access,
        provenance,
        dispatch,
        identity: getClaudeCodeIdentityForVerifiedAccount(
          identity,
          identity as ProviderAccountUuid,
        ),
      }
    },
    async requestOptions(input, onRefusal) {
      const active = controller(input)
      const snapshot = await runtime.read()
      syncDumpEnabled(snapshot)
      active.signal.throwIfAborted()
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
      if (!account || !eligible(account, snapshot, input.modelID)) {
        onRefusal?.(
          !account || !nativeAccountCanServe(account)
            ? 'account-unavailable'
            : 'account-policy',
        )
        throw new Error(
          'request refused: native account is ineligible for this model',
        )
      }
      const state = states.get(input.provenance)
      if (state)
        states.set(input.provenance, {
          ...state,
          scope: { ...state.scope, modelID: input.modelID },
        })
      return options.requestOptions(input, snapshot)
    },
    async admitRequest(input, onRefusal) {
      const state = states.get(input.provenance)
      if (
        !state ||
        !(await admitted(
          input.accountId,
          input.modelID,
          input.route,
          state.active,
          onRefusal,
        ))
      )
        throw new Error(
          'request refused: native account policy changed before dispatch',
        )
      states.set(input.provenance, {
        ...state,
        scope: { ...state.scope, modelID: input.modelID },
      })
    },
    isDumpEnabled: () => readDumpEnabled(),
    onRequestPrepared: (input) => options.onRequestPrepared?.(input),
    responseOptions(input) {
      return options.responseOptions?.({
        ...input,
        modelID: states.get(input.provenance)?.scope.modelID ?? input.modelID,
      })
    },
    quotaFromHeaders(headers, input) {
      const state = states.get(input.provenance)
      if (state) {
        state.responseHeaders = headers
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
        ...normalizeQuotaHeaders(headers),
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
            nativeAccountPolicy(account, snapshot, state.scope.modelID),
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
    forgetSession(sessionID) {
      servedTurns.delete(sessionID)
      sessions.get(sessionID)?.abort()
      sessions.delete(sessionID)
      servedBy.delete(sessionID)
      for (const [reason, retry] of retries)
        if (retry.scope.sessionID === sessionID) retries.delete(reason)
      for (const [queueKey, queue] of recoveries)
        if (queue[0]?.scope.sessionID === sessionID) recoveries.delete(queueKey)
      options.onForgetSession?.(sessionID)
    },
    servedAccount: (sessionID) => servedBy.get(sessionID),
    resetRouting: async (sessionID) =>
      routerFor(await runtime.read()).clear(sessionID),
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
      closed = true
      for (const active of sessions.values()) active.abort()
      sessions.clear()
      recoveries.clear()
      retries.clear()
      return Promise.all([
        usagePublications.drain(),
        source.drainRoutingPublications(),
      ]).then(() => {})
    },
  }
  return source
}
