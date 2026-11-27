import { randomUUID } from 'node:crypto'
import {
  type AccountStorage,
  type AnthropicBillingRequest,
  type ApiKeyAccount,
  applyAnthropicApiBaseUrl,
  applyClaudeCodeHeaders,
  applyClaudeCodeMetadata,
  applyClaudeGatewayHeaders,
  applyCustomHeaders,
  applyServerSideFallbackToBody,
  assertHostAuthorityStable,
  buildBillingHeaderValue,
  buildCacheDiagnosticsRecord,
  buildPrimeRequestBody,
  CACHE_DIAGNOSTICS_SESSION_LIMIT,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheDiagnosticsBetaTracker,
  CacheDiagnosticsTracker,
  type CacheKeepManager,
  type CacheKeepRealTurn,
  CacheKeepSessionRegistry,
  CLAUDE_CODE_ACCEPT_ENCODING,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  type ClaudeCodeIdentity,
  cacheDiagnosticsMessageId,
  claudeGatewayHeaderValues,
  claudeGatewayModelUrl,
  copyStreamResponseTiming,
  createAnthropicStreamCompletion,
  createDumpResponseObserver,
  createNativeVaultNoRouteResponse,
  createProviderErrorResponseScope,
  createQuotaRefusalResponse,
  createRoutingRelay,
  createServerSideFallbackStreamRewriter,
  createSseFramer,
  createStickyNoRouteResponse,
  currentCacheKeepRealTurn,
  DEFAULT_REFUSAL_FALLBACK_MODE,
  DEFAULT_SSE_MAX_FRAME_BYTES,
  type DumpHandle,
  decideStickyQuotaFailure,
  decodeSseFrame,
  dispatchRefusalFallback,
  dumpDirectRequest,
  dumpResponseArtifact,
  effectiveRelayStatus,
  effectiveRelayTransport,
  FAST_MODE_BETA,
  formatCacheDiagnosticsLogLine,
  getCache1hPersistentMode,
  getCacheDiagnosticsBetas,
  getCacheKeepRegistryDirectories,
  getClaudeCodeIdentityForVerifiedAccount,
  getFallbackReauthLabels,
  getMaxSameAccountWait,
  getQuotaCheckIntervalMs,
  getRequestGzipLatch,
  getRequestGzipLatchPath,
  getRoutingMode,
  getScopedQuotaWindowForModel,
  getThinkingPrefixMismatchBehavior,
  getWaitForReset,
  hasCacheDiagnosticsBeta,
  hostRetryHeaders,
  hostRetryResponse,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isKillswitchEnabled,
  isNativeTransientAccountError,
  isOAuthAccount,
  isPermanentRefreshError,
  isValidAnthropicRequestId,
  isValidApiBaseURL,
  joinRefusalFallbackStream,
  killswitchPassesPolicy,
  LEGACY_STATE_LAYOUT,
  localMessageThreadCredential,
  logger,
  logServedServerFallback,
  type MessageThreadRequest,
  MessageThreadTracker,
  mergeAnthropicBetas,
  NativeAccountRefusal,
  type NativeAccountSnapshot,
  type NativeAccountView,
  type NativeApiSubject,
  nativeAccountCanServe,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  observeAnthropicBillingResponse,
  orderClaudeCodeBody,
  PROMPT_CACHE_DEFAULT_TTL_MS,
  type ProviderAccountUuid,
  type ProviderErrorResponseScope,
  parseSseFrame,
  prepareMessageThreadRequest,
  protectFallbackCreditResponse,
  QuotaManager,
  type QuotaManagerOptions,
  type QuotaState,
  quotaBackoffActive,
  quotaExhaustionFromHeaders,
  quotaFieldSource,
  quotaRefusalTiming,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  RecoveryThinkingStore,
  type RefusalFallbackDispatchOptions,
  type RefusalFallbackMode,
  RefusalFallbackRoundEngine,
  type RefusalFallbackRoundEvent,
  type RefusalFallbackRoundInput,
  type RefusalFallbackRoundPlan,
  type RoutingChoice,
  raceWithSignal,
  readSessionCachePolicy,
  reportAnthropicBillingFailure,
  reportRoutingResponse,
  reportSessionCacheTouch,
  requestCacheLifetimeMs,
  requestShortestCacheLifetimeMs,
  resolveNativePoolPaths,
  routingCandidates,
  routingChoiceMatches,
  routingWarmCredential,
  runWithRequestSignal,
  SERVER_SIDE_FALLBACK_BETA,
  STICKY_ROUTING_MAIN_ACCOUNT_ID,
  StickyQuotaRetryCounter,
  type StickyRouteCandidate,
  StickySessionRouter,
  sanitizeClaudeCodeRequestBody,
  sendViaRelay,
  sendWithRequestGzip,
  sessionCacheActivity,
  setDumpEnabled,
  shouldFallbackStatus,
  signRequestBody,
  startRoutingWait,
  stickyQuotaBlockerInForce,
  stickyQuotaSnapshotIsFresh,
  stickyRetainRetryHeaders,
  stickyRetryAfterWithJitter,
  stickyRouteCandidateWeight,
  stickyRouteFamilyForModel,
  summarizeCacheTtl,
  warnClaudeGatewayRelayIgnored,
  withCacheKeepRealTurn,
  withoutFallbackCredit,
} from '@cortexkit/anthropic-auth-core'
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { PiCacheKeep } from './cachekeep.ts'
import {
  buildAnthropicRequest,
  fromClaudeCodeToolName,
  piThreadCacheSlot,
  sanitizeToolId,
  toClaudeCodeToolName,
} from './convert.ts'
import type { PiEffortTransition } from './effort-history.ts'
import {
  type PiForkEffortHint,
  PiForkRefusal,
  type PiForkReplyReport,
  piForkEffortHint,
  piForkEffortSnapshots,
  piForkHeadSession,
} from './forks.ts'
import { takePiLaneStart } from './lane-start.ts'
import {
  getPiNativeRuntime,
  type PiNativeAttempt,
  type PiNativeRuntime,
  peekPiNativeSnapshot,
  piAttemptAccessToken,
  piClaudeGatewayFromMemory,
  resolvePiSettingsFromMemory,
} from './native.ts'
import { getPiAccountStoragePath } from './paths.ts'
import { type PiPrimeSendOptions, registerPiPrimeSender } from './prime.ts'
import {
  markPiAccountHold,
  type PiQuotaWaitOptions,
  withPiQuotaWait,
} from './quota-wait.ts'
import {
  buildPiOAuthMessagesUrl,
  createPiOAuthModelFetch,
  fetchPiOAuth,
  fetchPiStreamResponse,
  requirePiOAuthOrigin,
} from './transport.ts'

const messageThreads = MessageThreadTracker.withTailPersistence('pi')
const replanPiRound = Symbol('replan Pi refusal round')
const refusalRounds = new Map<string, RefusalFallbackRoundEvent>()
const roundRoutes = new Map<
  string,
  {
    accountId: string
    credentialId: string
    requestedModel: string
    url: string
    storagePath: string
    routeId: string
  }
>()
const roundNotices = new Map<string, (message?: string) => void>()

export function piRefusalRoundStatus(sessionId: string | undefined) {
  const round = sessionId && refusalRounds.get(sessionId)
  if (!round) return undefined
  const { requestedModel, servingModel, category, stepsLeft } = round
  return `Claude safety fallback: ${requestedModel} → ${servingModel} (${category}; ${stepsLeft} steps left)`
}

function observePiRefusalRound(event: RefusalFallbackRoundEvent) {
  if (event.kind === 'round_ended') refusalRounds.delete(event.sessionId)
  else refusalRounds.set(event.sessionId, event)
  logger.info('refusal-fallback', event.kind, event)
  roundNotices.get(event.sessionId)?.(piRefusalRoundStatus(event.sessionId))
}

export function forgetPiRefusalAccount(accountId: string) {
  rounds.forgetAccount(accountId)
  for (const [sessionId, route] of roundRoutes)
    if (route.accountId === accountId) roundRoutes.delete(sessionId)
}

export function forgetPiRefusalRoute(storagePath: string, routeId?: string) {
  for (const route of roundRoutes.values()) {
    if (
      route.storagePath === storagePath &&
      (!routeId || route.routeId === routeId)
    )
      forgetPiRefusalAccount(route.accountId)
  }
}
const dumpResponseObservers = new WeakMap<
  Response,
  ReturnType<typeof createDumpResponseObserver>
>()
// The active turn ends when the agent settles. The previous response ID is
// kept between turns in the same session, but cleared on session shutdown.
const primarySessions = new Map<
  string,
  {
    storagePath: string
    turn?: { promptId?: string; synthetic?: boolean }
    previousRequestId?: string
    sent: number
    committed: number
    compacted?: boolean
  }
>()

const cacheDiagnostics = new CacheDiagnosticsTracker()
const cacheDiagnosticBetas = new CacheDiagnosticsBetaTracker()
const cacheDiagnosticsSessions = new Map<string, object>()
const cacheDiagnosticsObservers = new WeakMap<
  Response,
  (message: unknown) => Promise<void>
>()

function cacheDiagnosticsSession(sessionId: string): object {
  const session = cacheDiagnosticsSessions.get(sessionId) ?? {}
  cacheDiagnosticsSessions.delete(sessionId)
  cacheDiagnosticsSessions.set(sessionId, session)
  if (cacheDiagnosticsSessions.size > CACHE_DIAGNOSTICS_SESSION_LIMIT) {
    const oldest = cacheDiagnosticsSessions.keys().next().value
    if (oldest !== undefined) cacheDiagnosticsSessions.delete(oldest)
  }
  return session
}

export function beginPiPrimaryTurn(
  storagePath: string,
  sessionId?: string,
): void {
  if (!sessionId) return
  piCacheKeep.realTurn(sessionId, rounds.hasRound(sessionId))
  const previous = primarySessions.get(sessionId)
  const session =
    previous?.storagePath === storagePath
      ? previous
      : { storagePath, sent: 0, committed: 0 }
  // Pi fires turn_start for each tool iteration, not only for a human prompt.
  session.turn ??= {}
  primarySessions.delete(sessionId)
  primarySessions.set(sessionId, session)
  while (primarySessions.size > 128) {
    const oldest = primarySessions.keys().next().value
    if (oldest === undefined) break
    primarySessions.delete(oldest)
    roundRoutes.delete(oldest)
    roundNotices.delete(oldest)
    refusalRounds.delete(oldest)
  }
}

export function observePiUserPrompt(
  storagePath: string,
  sessionId: string,
  synthetic = false,
) {
  const session = primarySessions.get(sessionId)
  // A queued user message can start a new prompt before the agent settles.
  if (session?.storagePath === storagePath && session.turn)
    session.turn = { synthetic }
}

export function invalidatePiPrimaryModel(
  storagePath: string,
  sessionId: string,
) {
  const session = primarySessions.get(sessionId)
  if (session?.storagePath === storagePath) {
    session.sent += 1
    roundRoutes.delete(sessionId)
  }
}

export function observePiCompaction(sessionId: string) {
  const session = primarySessions.get(sessionId)
  if (session) {
    session.compacted = true
    session.sent += 1
  }
  roundRoutes.delete(sessionId)
}

export function endPiPrimaryTurn(
  storagePath: string,
  sessionId?: string,
  closed = false,
): void {
  if (!sessionId) return
  const session = primarySessions.get(sessionId)
  if (session?.storagePath === storagePath) {
    if (closed) primarySessions.delete(sessionId)
    else delete session.turn
  }
  piCacheKeep.endTurn(sessionId)
}

export function untrackPiCacheKeepTurn(sessionId?: string) {
  try {
    if (sessionId) piCacheKeep.requestTurn(sessionId)?.finish()
  } catch {}
}

function piPrimarySession(
  storagePath: string,
  options: SimpleStreamOptions | undefined,
  origin: 'agent-loop' | 'direct' | undefined,
) {
  // SDK summaries disable caching; SDK cache warms request exactly one token.
  if (
    origin !== 'agent-loop' ||
    !options?.sessionId ||
    options.cacheRetention === 'none' ||
    options.maxTokens === 1
  )
    return undefined
  const session = primarySessions.get(options.sessionId)
  return session?.storagePath === storagePath &&
    session.turn &&
    !session.turn.synthetic
    ? session
    : undefined
}

function piRoundSideRequest(
  options: SimpleStreamOptions | undefined,
  storagePath: string,
  origin: 'agent-loop' | 'direct' | undefined,
) {
  const sessionId = options?.sessionId
  return (
    !!sessionId &&
    primarySessions.get(sessionId)?.storagePath === storagePath &&
    !piPrimarySession(storagePath, options, origin)
  )
}

export function forgetPiMessageThread(
  sessionId: string,
  disposition: 'session_closed' | 'session_deleted' = 'session_deleted',
): void {
  messageThreads.forget(sessionId, disposition)
  cacheDiagnostics.forgetSession(sessionId)
  cacheDiagnosticsSessions.delete(sessionId)
  roundRoutes.delete(sessionId)
  roundNotices.get(sessionId)?.()
  roundNotices.delete(sessionId)
  refusalRounds.delete(sessionId)
  if (disposition === 'session_deleted') rounds.forgetSession(sessionId)
}

/** Dump label for a physical send that failed before any response arrived. */
const PHYSICAL_SEND_FAILED = 'physical send failed before a response'

let cacheKeepRegistry: CacheKeepSessionRegistry | undefined
let cacheKeepRegistryDirectory: string | undefined
const stickyRouters = new Map<string, StickySessionRouter>()
const stickyQuotaRetries = new StickyQuotaRetryCounter()

export function clearPiStickyQuotaRetries(
  storagePath: string,
  sessionId: string,
) {
  stickyQuotaRetries.clear(JSON.stringify([storagePath, sessionId]))
}
const quotaManagers = new Map<
  string,
  { identityKey: string; manager: QuotaManager }
>()
const PI_SERVICE_CACHE_LIMIT = 16
/**
 * Tests only: replaces the real-time wait between quota usage polls in quota
 * managers created after it is set. Unset, managers keep Core's real timer.
 */
let quotaCallPauseForTest: QuotaManagerOptions['pauseBetweenQuotaCalls']

/** Set or clear the test replacement for the wait between quota usage polls. */
export function __setPiQuotaCallPauseForTest(
  pause: QuotaManagerOptions['pauseBetweenQuotaCalls'],
) {
  quotaCallPauseForTest = pause
}

function setBoundedService<T>(map: Map<string, T>, key: string, value: T) {
  map.delete(key)
  map.set(key, value)
  while (map.size > PI_SERVICE_CACHE_LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function getPiRoutingServices(
  storagePath: string,
  snapshot: NativeAccountSnapshot,
) {
  const storage = snapshot.policyStorage
  const native = getPiNativeRuntime(storagePath)
  const identityKey = JSON.stringify(
    snapshot.accounts.map((account) => [
      account.id,
      account.accountIdentity,
      account.source,
      account.credentialId,
      account.binding?.rowId,
      account.binding?.credentialEpoch,
    ]),
  )
  const existing = quotaManagers.get(storagePath)
  let quotaManager =
    existing?.identityKey === identityKey ? existing.manager : undefined
  if (!quotaManager) {
    quotaManager = new QuotaManager({
      storage,
      pauseBetweenQuotaCalls: quotaCallPauseForTest,
      fetchQuotaSnapshot: async (request, dispatch) => {
        const id = request.kind === 'main' ? 'main' : request.accountId
        if (!id) throw new Error('Native quota request has no account identity')
        return (await native.service()).fetchQuota(
          id,
          fetchPiOAuth,
          undefined,
          dispatch,
          request.purpose,
        )
      },
    })
    setBoundedService(quotaManagers, storagePath, {
      identityKey,
      manager: quotaManager,
    })
  } else {
    quotaManager.updateStorage(storage)
  }
  const quotas = quotaManager
  const getUsableFallbackAccounts = async (
    current: AccountStorage,
    options: { modelId?: string } = {},
  ) => {
    const snapshot = await native.view()
    const accounts = new Map(
      snapshot.accounts.map((account) => [account.id, account]),
    )
    const usable: OAuthAccount[] = []
    for (const account of current.accounts) {
      const view = accounts.get(account.id)
      if (
        !isOAuthAccount(account) ||
        !nativeAccountCanServe(view) ||
        view?.type !== 'oauth'
      )
        continue
      if (
        isPermanentRefreshError(view.lastRefreshError) ||
        (view.source === 'local' &&
          (view.lastRefreshError?.nextRetryAt ?? 0) > Date.now())
      )
        continue
      const needsProbe =
        view.source !== 'vault' ||
        Boolean(current.quota?.minimumRemaining) ||
        isKillswitchEnabled(current)
      if (
        needsProbe &&
        quotas.isFallbackStale(
          account.id,
          undefined,
          options.modelId,
          account,
        ) &&
        !quotaBackoffActive(account.lastQuotaRefreshError, Date.now())
      ) {
        try {
          await quotas.refreshFallback(account.id, '', account, 'admission')
        } catch (error) {
          // A transient account error means another writer is still saving
          // this fallback. Rethrow it: swallowing it would leave the fallback
          // without a quota reading, which can exclude it below and send the
          // request through a different account. Other probe errors are
          // ignored.
          if (isNativeTransientAccountError(error)) throw error
        }
      }
      const quota =
        quotas.getFallback(account.id, account)?.quota ?? account.quota
      if (
        (!needsProbe || quotaSnapshotPassesPolicy(quota, current)) &&
        quotaSnapshotPassesModelScope(quota, options.modelId)
      )
        usable.push({ ...account, quota })
    }
    return usable
  }
  return { quotaManager, getUsableFallbackAccounts }
}

/** Exercise fallback eligibility without authorizing or sending a request. */
export const __getPiRoutingServicesForTest = getPiRoutingServices

async function getPiStickyRouter(storagePath: string) {
  const { path, vaultSeed } =
    await getPiNativeRuntime(storagePath).routingStorage()
  let router = stickyRouters.get(path)
  if (!router) {
    const runtime = await getPiNativeRuntime(storagePath).service()
    router = new StickySessionRouter({
      path,
      vaultSeed,
      onLockEvent: runtime.onLockEvent,
      relocationGuard: runtime.relocationGuard,
    })
    setBoundedService(stickyRouters, path, router)
  }
  router.setVaultSeed(vaultSeed)
  getPiNativeRuntime(storagePath).ownRoutingPublications(router)
  return router
}

export async function clearPiStickyRoutingSession(
  storagePath: string,
  sessionId: string,
) {
  sessionCacheActivity.forget(sessionId)
  clearPiStickyQuotaRetries(storagePath, sessionId)
  await (await getPiStickyRouter(storagePath)).clear(sessionId)
}

function getPiCacheKeepRegistry() {
  const paths = getCacheKeepRegistryDirectories('pi')
  const { directory } = paths
  if (!cacheKeepRegistry || cacheKeepRegistryDirectory !== directory) {
    cacheKeepRegistry = new CacheKeepSessionRegistry(paths)
    cacheKeepRegistryDirectory = directory
  }
  return cacheKeepRegistry
}

/**
 * Sets the Claude Code headers for a Pi OAuth request to Anthropic, with the
 * betas this body needs. Model requests and CacheKeep prewarms both call it:
 * a prewarm replays a model request's body, and Anthropic needs the same
 * betas to accept it (for example, the effort beta for the empty
 * `role: "system"` effort markers in a Fable 5.1/5.2 body). `leadingBetas` appends
 * adapter-requested feature betas without changing Core's model-beta selection.
 */
function applyPiOAuthRequestHeaders(
  headers: Headers,
  accessToken: string,
  options: {
    body: Record<string, unknown>
    identity: ClaudeCodeIdentity | undefined
    refusalFallbackMode: RefusalFallbackMode
    leadingBetas?: string[]
    requestClass?: 'main' | 'auxiliary'
  },
) {
  const { body } = options
  applyClaudeCodeHeaders(headers, accessToken, {
    body,
    identity: options.identity,
    extraBetas: options.leadingBetas,
    requestClass: options.requestClass,
    refusalFallbackMode: options.refusalFallbackMode,
  })
  // Pi runs on undici, whose default encoding order differs from Claude Code's.
  headers.set('accept-encoding', CLAUDE_CODE_ACCEPT_ENCODING)
  if (body.speed === 'fast')
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  return headers
}

function piBillingPayer(attempt: PiNativeAttempt) {
  return {
    credentialId:
      attempt.source === 'vault'
        ? attempt.receipt.credentialId
        : localMessageThreadCredential(attempt.admission.binding),
    accountId: attempt.accountIdentity,
  }
}

function piCredentialId(account: NativeAccountView | undefined) {
  return account?.source === 'vault'
    ? account.credentialId
    : account?.binding && localMessageThreadCredential(account.binding)
}

const nativePrewarmAttempts = new Map<
  number,
  {
    runtime: ReturnType<typeof getPiNativeRuntime>
    served: PiNativeAttempt
    reported: boolean
  }
>()
const piCacheKeep = new PiCacheKeep(
  {
    billingRequest(target, attempt) {
      const entry = nativePrewarmAttempts.get(attempt.id)
      if (!entry) return undefined
      return {
        ...piBillingPayer(entry.served),
        sessionId: target.policyState?.ownerSessionId ?? target.id,
        model: (JSON.parse(target.bodyText) as { model: string }).model,
        requestKind: 'keep_warm',
        chargeBasis: 'subscription_included',
        cache: {
          ttlMs: requestShortestCacheLifetimeMs(target.bodyText),
          warming: { on: true },
        },
      }
    },
    fetchImpl: fetchPiOAuth,
    // A keep-warm is a model request, so it follows the current gateway of
    // the target's own runtime.
    fetchForTarget: (target) => {
      const storagePath = target.accountStoragePath ?? getPiAccountStoragePath()
      const fetch = createPiOAuthModelFetch(
        () => piClaudeGatewayFromMemory(storagePath),
        getRequestGzipLatch(getRequestGzipLatchPath(storagePath)),
      )
      return fetch
    },
    loadStorage: async () => (await getPiNativeRuntime().view()).policyStorage,
    resolveSettings: resolvePiSettingsFromMemory,
    refusalFallbackMode: () =>
      getPiNativeRuntime().refusalFallbackMode() ??
      DEFAULT_REFUSAL_FALLBACK_MODE,
    onTrackedSessionsChanged: (sessions) =>
      getPiCacheKeepRegistry().publish(sessions),
    prepareHeaders: async (headers, target, attempt) => {
      const runtime = getPiNativeRuntime(
        target.accountStoragePath ?? getPiAccountStoragePath(),
      )
      requirePiOAuthOrigin(target.url, runtime.claudeGateway())
      const id = target.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID
      const current = await runtime.view()
      const body = JSON.parse(target.bodyText) as Record<string, unknown>
      const served = await runtime.authorize(
        id,
        attempt.signal,
        typeof body.model === 'string' ? body.model : undefined,
        'cachekeep',
      )
      if (
        !target.oauthAccountIdentity ||
        served.accountIdentity !== target.oauthAccountIdentity
      )
        throw new NativeAccountRefusal('credential-changed')
      const identity = getClaudeCodeIdentityForVerifiedAccount(
        id === STICKY_ROUTING_MAIN_ACCOUNT_ID
          ? (current.policyStorage.mainAccountId ?? id)
          : id,
        served.accountIdentity as ProviderAccountUuid,
      )
      headers.delete('anthropic-beta')
      applyPiOAuthRequestHeaders(headers, piAttemptAccessToken(served), {
        body,
        identity,
        leadingBetas: [CACHE_KEEP_EXTENDED_TTL_BETA],
        refusalFallbackMode:
          attempt.refusalFallbackMode ?? DEFAULT_REFUSAL_FALLBACK_MODE,
      })
      nativePrewarmAttempts.set(attempt.id, {
        runtime,
        served,
        reported: false,
      })
      return headers
    },
    retryOnUnauthorized: async ({ target, headers, attempt }) => {
      const entry = nativePrewarmAttempts.get(attempt.id)
      if (!entry) return undefined
      await entry.runtime.report(entry.served, 401, 'direct').catch(() => {
        logger.warn(
          'native-auth',
          'Pi CacheKeep auth-failure report unavailable',
        )
      })
      entry.reported = true
      const retryBody = JSON.parse(target.bodyText) as Record<string, unknown>
      const rotated = await entry.runtime
        .retry(
          target.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID,
          entry.served,
          attempt.signal,
          typeof retryBody.model === 'string' ? retryBody.model : undefined,
        )
        .catch(() => undefined)
      if (!rotated) return undefined
      const rotatedHeaders = new Headers(headers)
      rotatedHeaders.set(
        'authorization',
        `Bearer ${piAttemptAccessToken(rotated)}`,
      )
      nativePrewarmAttempts.set(attempt.id, {
        runtime: entry.runtime,
        served: rotated,
        reported: false,
      })
      return rotatedHeaders
    },
    onResponse: async ({ target, attempt, status, receivedAt, bodyText }) => {
      const entry = nativePrewarmAttempts.get(attempt.id)
      if (
        entry &&
        status >= 200 &&
        status < 300 &&
        !attempt.signal?.aborted &&
        cacheKeepManager.isCurrentTarget(target)
      )
        sessionCacheActivity.recordPrewarm(
          target.id,
          target.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID,
          receivedAt,
          requestCacheLifetimeMs(bodyText),
        )
      if (entry && status === 401 && !entry.reported)
        await entry.runtime.report(entry.served, status, 'direct').catch(() => {
          logger.warn(
            'native-auth',
            'Pi CacheKeep auth-failure report unavailable',
          )
        })
    },
    onComplete: ({ attempt }) => {
      nativePrewarmAttempts.delete(attempt.id)
    },
  },
  {
    storageId: async (storagePath) =>
      (
        await resolveNativePoolPaths(
          storagePath,
          undefined,
          LEGACY_STATE_LAYOUT,
        )
      ).storageId,
    read: (storagePath) => getPiNativeRuntime(storagePath).view(),
    routing: (storagePath) => {
      const snapshot = peekPiNativeSnapshot(storagePath)
      return {
        snapshot,
        router: snapshot?.routingPath
          ? stickyRouters.get(snapshot.routingPath)
          : undefined,
      }
    },
  },
)
const cacheKeepManager = piCacheKeep.manager
const thinkingStore = new RecoveryThinkingStore()
function createPiRefusalRounds() {
  return new RefusalFallbackRoundEngine(observePiRefusalRound, {
    thinkingStore,
    cacheKeep: cacheKeepManager,
  })
}
let rounds = createPiRefusalRounds()

export function startPiCacheKeepSession(
  storagePath: string,
  sessionId: string,
) {
  return piCacheKeep.startSession(storagePath, sessionId)
}

export async function stopPiCacheKeep() {
  await piCacheKeep.stop()
  await getPiCacheKeepRegistry().dispose()
  // Pi can exit before the store's delayed write runs. Save the digests before
  // a resumed session can replay a turn containing both models' thinking.
  await thinkingStore.close()
  // Pi may reload the extension in the same process. Discard its old rounds
  // without deleting the saved thinking of sessions the user can still resume.
  rounds = createPiRefusalRounds()
}

export async function getPiTrackedCacheKeepSessions() {
  return getPiCacheKeepRegistry().list(cacheKeepManager.trackedSessions())
}

/** Call prewarmNow directly to exercise its provider request without clock or timer mocks. */
export function __prewarmPiCacheKeepForTest(
  input: Parameters<CacheKeepManager['prewarmNow']>[0],
) {
  return cacheKeepManager.prewarmNow(input)
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'pause_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'toolUse'
    default:
      return 'error'
  }
}

function safeStopLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^[a-z0-9_]{1,40}$/.exec(value)?.[0] === value ? value : undefined
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

type AnthropicEvent = {
  type?: string
  index?: number
  content_block?: Record<string, unknown>
  delta?: Record<string, unknown>
  error?: Record<string, unknown>
  message?: { id?: string; usage?: Record<string, number> }
  usage?: Record<string, number>
}

type Block = (
  | TextContent
  | ThinkingContent
  | (ToolCall & { partialJson?: string })
) & {
  index?: number
}

type AnthropicStreamUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number }
}

function updateUsage(
  model: Model<Api>,
  output: AssistantMessage,
  usage?: AnthropicStreamUsage,
) {
  if (!usage) return
  output.usage.input = usage.input_tokens ?? output.usage.input
  output.usage.output = usage.output_tokens ?? output.usage.output
  output.usage.cacheRead =
    usage.cache_read_input_tokens ?? output.usage.cacheRead
  output.usage.cacheWrite =
    usage.cache_creation_input_tokens ?? output.usage.cacheWrite
  // Pi prices `cacheWrite1h` (a subset of `cacheWrite`) at the one-hour rate;
  // without it every cache write is priced as a five-minute write.
  const longWrite = usage.cache_creation?.ephemeral_1h_input_tokens
  if (typeof longWrite === 'number') output.usage.cacheWrite1h = longWrite
  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite
  calculateCost(model, output.usage)
}

export function buildExplicitBaseMessagesUrl(baseURL: string) {
  const url = new URL(baseURL)
  const basePath = url.pathname.replace(/\/$/, '')
  // A route can already name the messages resource rather than a base path.
  url.pathname = /\/v\d[^/]*\/messages$/.test(basePath)
    ? basePath
    : '/v1/messages'
  applyAnthropicApiBaseUrl(url, baseURL)
  url.searchParams.set('beta', 'true')
  return url
}

export function configureApiRouteHeaders(
  account: ApiKeyAccount,
  fastMode: boolean,
) {
  const headers = new Headers()
  headers.set('accept', 'application/json')
  headers.set('content-type', 'application/json')
  headers.set('anthropic-version', '2023-06-01')
  headers.set('anthropic-beta', mergeAnthropicBetas(null, []))
  if (account.authHeader === 'x-api-key') {
    headers.set('x-api-key', account.apiKey ?? '')
  } else {
    headers.set('authorization', `Bearer ${account.apiKey ?? ''}`)
  }
  if (fastMode) {
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  }
  applyCustomHeaders(headers)
  return headers
}

export async function* parseSse(
  response: Response,
  completion?: ReturnType<typeof createAnthropicStreamCompletion>,
): AsyncGenerator<AnthropicEvent> {
  if (!response.body) {
    completion?.end()
    return
  }
  const dumpObserver = dumpResponseObservers.get(response)
  let cacheDiagnosticsObserver = cacheDiagnosticsObservers.get(response)
  const reader = response.body.getReader()
  // Core's byte framer ends frames at blank lines with CRLF, LF or CR line
  // endings and keeps a multibyte character split across reads in one frame,
  // so each frame is decoded once, whole. A frame without its closing blank
  // line at end of stream is incomplete and dispatches nothing, as in
  // EventSource.
  const framer = createSseFramer()
  // Only the stream's first frame may drop a leading byte-order mark.
  let streamStart = true

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        completion?.end()
        break
      }
      completion?.push(value)
      for (const frame of framer.push(value)) {
        const data = parseSseFrame(decodeSseFrame(frame, { streamStart })).data
        streamStart = false
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data) as AnthropicEvent
        dumpObserver?.observe(event)
        if (event.type === 'message_start' && cacheDiagnosticsObserver) {
          const observe = cacheDiagnosticsObserver
          cacheDiagnosticsObserver = undefined
          void observe(event.message).catch(() => {})
        }
        yield event
      }
    }
  } catch (error) {
    dumpObserver?.fail()
    throw error
  } finally {
    // Only the lock is released when the consumer stops early: cancelling the
    // body on abandonment is the consumer's decision, not the parser's.
    reader.releaseLock()
    await dumpObserver?.finish()
  }
}

function observePiFallbackAttempt(
  response: Response,
  dump: DumpHandle | null,
  onComplete: (usage: Record<string, number>) => void | Promise<void>,
) {
  const observer = dump && createDumpResponseObserver(dump, response.status)
  const initialDump = dump
    ? dumpResponseArtifact(dump, {
        status: response.status,
        message: null,
        complete: false,
      })
    : undefined
  if (!response.ok || !response.body) return response
  const reader = response.body.getReader()
  const framer = createSseFramer()
  let stopReason: string | undefined
  let streamStart = true
  let failed = false
  let usage: Record<string, number> = {}
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (initialDump) await initialDump
          const next = await reader.read()
          if (next.done) {
            controller.close()
            reader.releaseLock()
            await observer?.finish()
            return
          }
          for (const frame of framer.push(next.value)) {
            const data = parseSseFrame(
              decodeSseFrame(frame, { streamStart }),
            ).data
            streamStart = false
            if (!data || data === '[DONE]') continue
            try {
              const event = JSON.parse(data) as AnthropicEvent
              if (event.type === 'message_start')
                usage = { ...event.message?.usage }
              if (event.type === 'message_delta')
                Object.assign(usage, event.usage)
              if (event.type === 'message_delta')
                stopReason = String(event.delta?.stop_reason ?? '')
              if (event.type === 'error') failed = true
              observer?.observe(event)
              if (event.type === 'message_stop') {
                if (
                  !failed &&
                  stopReason &&
                  mapStopReason(stopReason) !== 'error'
                )
                  await onComplete(usage)
                await observer?.finish()
              }
            } catch {
              failed = true
            }
          }
          controller.enqueue(next.value)
        } catch (error) {
          observer?.fail()
          await observer?.finish()
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason) {
        if (initialDump) await initialDump
        await observer?.finish()
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
        }
      },
    },
    { highWaterMark: 0 },
  )
  return copyStreamResponseTiming(
    response,
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  )
}

function buildPiPrimeBody(identity?: ClaudeCodeIdentity) {
  const prime = buildPrimeRequestBody()
  const body: Record<string, unknown> = {
    ...prime,
    system: [
      {
        type: 'text',
        text: buildBillingHeaderValue(
          prime.messages,
          undefined,
          CLAUDE_CODE_ENTRYPOINT,
        ),
      },
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: prime.system },
    ],
  }
  if (identity) applyClaudeCodeMetadata(body, identity)
  return {
    body,
    bodyText: JSON.stringify(orderClaudeCodeBody(body, { isOAuth: true })),
    toolNames: new Map<string, string>(),
    cacheTtlMs: 0,
  }
}

/** Prime uses the model transport without a conversation, thread or cache target. */
export function sendPiPrimeRequest(options: PiPrimeSendOptions) {
  return sendAnthropicRequest(
    {
      model: {
        id: buildPrimeRequestBody().model,
        name: 'Prime',
        api: 'anthropic-messages',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 1,
      },
      context: { messages: [] },
      storagePath: options.storagePath,
      oauthAccountId: options.accountId,
      streamOptions: { signal: options.signal },
      route: 'prime',
      prime: options,
    },
    { native: options.native, fetch: options.fetch },
  )
}

registerPiPrimeSender(sendPiPrimeRequest)

async function sendAnthropicRequest(
  ...args: Parameters<typeof sendAnthropicRequestAttempt>
): Promise<Response> {
  const [options, deps = {}] = args
  const forkHead = piForkHeadSession(options.streamOptions)
  const inherited = forkHead ? undefined : currentCacheKeepRealTurn()
  let turn = inherited
  try {
    if (
      !turn &&
      !forkHead &&
      !options.prime &&
      !piRoundSideRequest(
        options.streamOptions,
        options.storagePath,
        options.requestOrigin,
      ) &&
      options.streamOptions?.sessionId
    ) {
      const sessionId = options.streamOptions.sessionId
      const deferWarmExclusion = rounds.hasRound(sessionId)
      turn = deps.cacheKeep
        ? deps.cacheKeep.beginRealTurn(sessionId, { deferWarmExclusion })
        : piCacheKeep.requestTurn(sessionId, deferWarmExclusion)
    }
  } catch {}
  try {
    return await withCacheKeepRealTurn(turn, async () => {
      for (;;) {
        try {
          return await sendAnthropicRequestAttempt(...args)
        } catch (error) {
          if (error !== replanPiRound) throw error
        }
      }
    })
  } finally {
    if (!inherited) piCacheKeep.finishTurn(turn)
  }
}

async function sendAnthropicRequestAttempt(
  options: {
    model: Model<Api>
    context: Context
    streamOptions?: SimpleStreamOptions
    requestOrigin?: 'agent-loop' | 'direct'
    laneStart?: boolean
    apiAccount?: NativeAccountView
    storagePath: string
    oauthAccountId?: string
    routingChoice?: RoutingChoice
    routingRelay?: ReturnType<typeof createRoutingRelay>
    expectedAccountIdentity?: string
    route?: string
    effortTransitions?: readonly PiEffortTransition[]
    onResolvedToolNames?: (toolNames: ReadonlyMap<string, string>) => void
    onForkEffortApplied?: (effort: PiForkEffortHint | undefined) => void
    onThreadPrepared?: (fail: () => void) => void
    onCacheUsageRecorder?: (
      record: (usage?: Record<string, number>) => void,
    ) => void
    onServingModel?: (model: string | undefined) => void
    prime?: Pick<
      PiPrimeSendOptions,
      'checkAccount' | 'beforeSend' | 'onServed' | 'onDispatched'
    >
  },
  deps: {
    fetch?: typeof fetch
    cacheKeep?: CacheKeepManager
    native?: PiNativeRuntime
  } = {},
): Promise<Response> {
  // Relay callbacks may run outside the request's async context. Keep the
  // request-owned lease with the callback rather than looking it up later.
  const realTurn = currentCacheKeepRealTurn()
  options.onCacheUsageRecorder?.(() => {})
  options.onServingModel?.(undefined)
  assertHostAuthorityStable()
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const fetchResponse = async (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => {
    return fetchPiStreamResponse(input, init, fetchImpl)
  }
  const keep = deps.cacheKeep ?? cacheKeepManager
  const roundEngine = rounds
  const realSession = options.streamOptions?.sessionId
  const forkHead = piForkHeadSession(options.streamOptions)
  const primary =
    !options.prime && !forkHead
      ? piPrimarySession(
          options.storagePath,
          options.streamOptions,
          options.requestOrigin,
        )
      : undefined
  const turn =
    options.laneStart || primary?.turn?.synthetic ? undefined : primary?.turn
  if (primary && turn) {
    turn.promptId ??= randomUUID()
    primary.sent += 1
  }
  const lineage =
    primary && turn?.promptId
      ? {
          promptId: turn.promptId,
          previousRequestId: primary.previousRequestId,
          sequence: primary.sent,
        }
      : undefined
  const observeRequestId = (headers: Headers) => {
    if (
      !lineage ||
      !primary ||
      !realSession ||
      primarySessions.get(realSession) !== primary ||
      lineage.sequence < primary.committed
    )
      return
    const id = headers.get('request-id') ?? headers.get('x-request-id')
    if (!id || !isValidAnthropicRequestId(id)) return
    primary.committed = lineage.sequence
    primary.previousRequestId = id
  }
  const diagnosticsSession =
    realSession &&
    !options.apiAccount &&
    !options.prime &&
    !forkHead &&
    options.streamOptions?.maxTokens !== 1
      ? {
          id: realSession,
          token: cacheDiagnosticsSession(realSession),
          previous: cacheDiagnostics.previousFor(realSession),
        }
      : undefined
  if (!options.prime && !forkHead && realSession) {
    if ((options.apiAccount && !primary) || !options.storagePath) {
      try {
        realTurn?.finish()
      } catch {}
    }
  }
  const native = deps.native ?? getPiNativeRuntime(options.storagePath)
  let dumpHandle: DumpHandle | null = null
  // Capture the serving service while authorization is open. Shutdown rejects
  // new serving work immediately but drains writes for already-served attempts.
  const servingRuntime = await native.service()
  const snapshot = await native.view(
    options.streamOptions?.signal,
    options.model.id,
  )
  const storage = snapshot.policyStorage
  const mode = snapshot.refusalFallbackMode ?? DEFAULT_REFUSAL_FALLBACK_MODE
  setDumpEnabled(isDumpPersistentlyEnabled(storage))
  const routeId = options.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID
  const selected = snapshot.accounts.find((account) => account.id === routeId)
  let verifiedUuid = options.apiAccount ? undefined : selected?.accountIdentity
  if (
    options.expectedAccountIdentity &&
    verifiedUuid !== options.expectedAccountIdentity
  )
    throw new Error('The selected OAuth account changed while waiting.')
  if (!options.apiAccount && !verifiedUuid) {
    if (selected?.source === 'vault')
      throw new Error('Pi vault route identity is unasserted')
    // Validation can learn the UUID of an account that has no verified identity.
    // This lookup returns only that UUID; the model send authorizes the credential again.
    verifiedUuid = (
      await native.authorize(
        routeId,
        options.streamOptions?.signal,
        options.model.id,
        'serve',
        options.routingChoice,
      )
    ).accountIdentity
  }
  let nextAttempt: PiNativeAttempt | undefined
  let physicalModel = options.model.id
  const identity = verifiedUuid
    ? getClaudeCodeIdentityForVerifiedAccount(
        routeId === STICKY_ROUTING_MAIN_ACCOUNT_ID
          ? (storage.mainAccountId ?? routeId)
          : routeId,
        verifiedUuid as ProviderAccountUuid,
      )
    : undefined
  // Pi's per-request `cacheRetention: 'long'` asks for the provider's longest
  // retention (Anthropic's one-hour TTL), as Pi's own Anthropic provider
  // honours it; the account setting still enables it for all requests. Cache
  // activity below follows the final serialized body, since hooks can edit TTLs.
  const oneHourCache =
    isCache1hPersistentlyEnabled(storage) ||
    options.streamOptions?.cacheRetention === 'long'
  const forkBase = forkHead
    ? piForkEffortSnapshots.match(forkHead, options.context)
    : undefined
  const {
    body,
    bodyText: builtBodyText,
    toolNames,
    cacheTtlMs,
    ...built
  } = options.prime
    ? buildPiPrimeBody(identity)
    : await buildAnthropicRequest(
        options.model.id,
        options.context,
        options.streamOptions,
        {
          enabled: oneHourCache,
          mode: getCache1hPersistentMode(storage),
        },
        isFastModePersistentlyEnabled(storage),
        identity,
        {
          modelLimits: options.model,
          apiKey: !!options.apiAccount,
          apiKeyModelCompat: options.model
            .compat as Model<'anthropic-messages'>['compat'],
          laneStart: options.laneStart,
          deferSigning: true,
          billingLineage: lineage,
          ...(diagnosticsSession && {
            cacheDiagnosticsPreviousMessageId:
              diagnosticsSession.previous?.messageId ?? null,
          }),
          forkBaseMessageCount: forkBase?.messageCount,
          // API-key routes send no effort history, so no fork hint either.
          forkEffort: options.apiAccount
            ? undefined
            : piForkEffortHint(options.streamOptions),
          effortTransitions: options.apiAccount
            ? []
            : forkBase
              ? forkBase.transitions
              : options.effortTransitions,
          turnEndNote: storage.turnEndNote,
          thinkingPrefixMismatchBehavior: options.apiAccount
            ? 'account-default'
            : getThinkingPrefixMismatchBehavior(storage),
          ...(options.streamOptions?.onPayload && {
            onPayload: (payload: unknown) =>
              forkHead
                ? raceWithSignal(options.streamOptions?.signal, async () =>
                    options.streamOptions?.onPayload?.(payload, options.model),
                  )
                : options.streamOptions?.onPayload?.(payload, options.model),
          }),
        },
      )
  if (!options.prime && !forkHead && realSession && !options.apiAccount)
    piForkEffortSnapshots.record(
      realSession,
      options.context,
      options.effortTransitions,
    )
  const bodyMode = options.apiAccount ? 'off' : mode
  const sanitized = sanitizeClaudeCodeRequestBody(body, bodyMode)
  if (typeof body.model === 'string') physicalModel = body.model
  const serverSideFallbackSent =
    bodyMode === 'server' && applyServerSideFallbackToBody(body, true).enabled
  options.onResolvedToolNames?.(toolNames)
  options.onForkEffortApplied?.(
    'forkEffortApplied' in built ? built.forkEffortApplied : undefined,
  )
  const fastMode = body.speed === 'fast'
  const headers = options.apiAccount
    ? new Headers()
    : applyPiOAuthRequestHeaders(new Headers(), '', {
        body,
        identity,
        refusalFallbackMode: mode,
        ...(options.prime && { requestClass: 'auxiliary' }),
      })
  const sourceBodyText =
    sanitized || bodyMode === 'server'
      ? JSON.stringify(
          options.apiAccount
            ? body
            : orderClaudeCodeBody(body, { isOAuth: !!identity }),
        )
      : builtBodyText
  let bodyText = sourceBodyText
  let wireBodyText = sourceBodyText
  const relayAffinity = options.streamOptions?.sessionId ?? null
  const observeResponseHeaders = (
    attempt: PiNativeAttempt,
    responseHeaders: Headers,
    status: number,
    sentModel = physicalModel,
  ) => {
    native.observeQuotaHeaders(attempt, responseHeaders, servingRuntime)
    if (options.prime || !relayAffinity) return
    if (
      options.routingRelay &&
      !options.routingRelay.shouldReport(relayAffinity)
    )
      return
    const payer = piBillingPayer(attempt)
    reportRoutingResponse(
      relayAffinity,
      { accountIdentity: payer.accountId, credentialId: payer.credentialId },
      responseHeaders,
      status,
      sentModel,
      status < 400,
      async () =>
        selected?.accountIdentity === payer.accountId
          ? selected.quota
          : undefined,
    )
  }
  const billingInput = async (
    attempt?: PiNativeAttempt,
    apiSubject?: NativeApiSubject,
    sentBody = wireBodyText,
    sentModel = physicalModel,
    after?: () => Promise<void> | undefined,
  ): Promise<AnthropicBillingRequest | undefined> => {
    // Prime (the five-hour window starter) has no session transcript, and
    // Agent Runner bills a fork's answer itself from the answer's usage, so
    // neither request may emit a session billing report here.
    if (
      options.prime ||
      forkHead ||
      !relayAffinity ||
      (!attempt && !apiSubject)
    )
      return undefined
    const credentialId = attempt
      ? piBillingPayer(attempt).credentialId
      : apiSubject?.credentialFingerprint
    if (!credentialId) return undefined
    const ttlMs = requestShortestCacheLifetimeMs(
      await withoutFallbackCredit(sentBody),
    )
    const sessionId = relayAffinity
    return {
      ...(attempt ? piBillingPayer(attempt) : { credentialId }),
      sessionId,
      model: sentModel,
      requestKind: options.requestOrigin === 'direct' ? 'generate' : 'primary',
      chargeBasis: options.apiAccount ? 'metered_api' : 'subscription_included',
      ...(ttlMs > 0 ? { cache: { ttlMs } } : {}),
      // Only the accepted report waits for a round template publication;
      // the stream itself never waits.
      cacheWarmingAfter: after,
      cacheWarming: () => {
        if (options.apiAccount) return { on: false }
        if (!attempt || cacheTracking.get(attempt) !== 'settled')
          return undefined
        return keep.warming(sessionId)
      },
    }
  }
  let input = options.apiAccount
    ? new URL('https://api.anthropic.com/v1/messages')
    : buildPiOAuthMessagesUrl(options.model.baseUrl)
  // The user's gateway from their own settings file takes OAuth model
  // requests, Prime included. It is read once, so the relay, thread, gzip and
  // URL choices below agree. `input` stays the Anthropic URL for CacheKeep,
  // which applies the gateway current at each warm.
  const configuredGateway = options.apiAccount
    ? undefined
    : servingRuntime.getClaudeGateway?.()
  const gatewayUrl = configuredGateway
    ? claudeGatewayModelUrl(input, configuredGateway)
    : undefined
  const gateway = gatewayUrl ? configuredGateway : undefined
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: bodyText,
    signal: options.streamOptions?.signal,
    ...(!options.apiAccount && { redirect: 'error' as const }),
  }
  const cacheAccepted = new Set<PiNativeAttempt>()
  const cacheTracking = new Map<PiNativeAttempt, 'pending' | 'settled'>()
  const recordCacheAcceptance = (appliedTtl: number, at: number) => {
    const localTtl =
      readSessionCachePolicy(relayAffinity, true)?.ttl !== undefined
        ? appliedTtl
        : cacheTtlMs || PROMPT_CACHE_DEFAULT_TTL_MS
    if (relayAffinity) {
      sessionCacheActivity.record(relayAffinity, routeId, localTtl)
      reportSessionCacheTouch(relayAffinity, {
        at,
        ttlMs: appliedTtl,
        source: 'response',
      })
    }
    return localTtl
  }
  const trackAcceptedRequest = async (
    attempt: PiNativeAttempt,
    sentBody = wireBodyText,
    template = bodyText,
    isFresh = () => true,
    finalUsage?: Record<string, number>,
    prepare?: (bodyText: string) => Promise<string>,
  ) => {
    if (options.prime || options.apiAccount || init.signal?.aborted) return
    if (cacheAccepted.has(attempt)) return
    cacheAccepted.add(attempt)
    const at = Date.now()
    const cleanTemplate = prepare
      ? template
      : await withoutFallbackCredit(template)
    const cleanSentBody =
      template === sentBody
        ? cleanTemplate
        : await withoutFallbackCredit(sentBody)
    if (init.signal?.aborted || !isFresh()) return
    const appliedTtl = requestCacheLifetimeMs(cleanSentBody)
    if (forkHead) {
      sessionCacheActivity.record(forkHead, routeId, appliedTtl)
      return
    }
    const localTtl = recordCacheAcceptance(appliedTtl, at)
    const target: Parameters<CacheKeepManager['track']>[0] = {
      sessionId: relayAffinity,
      url: input.toString(),
      headers,
      bodyText: cleanTemplate,
      storage,
      cacheMode: isCacheKeepHybridActive(storage) ? 'hybrid' : 'disabled',
      ttlMs: localTtl,
      oauthAccountId: routeId,
      oauthAccountIdentity: verifiedUuid,
      accountStoragePath: options.storagePath,
    }
    const activeTurn = realTurn?.active ? realTurn : undefined
    let usageBody = cleanTemplate
    const prepareTemplate =
      prepare &&
      (async (text: string) => {
        usageBody = await prepare(text)
        return usageBody
      })
    const tracked = deps.cacheKeep
      ? (async () => {
          if (prepareTemplate)
            target.bodyText = await prepareTemplate(cleanTemplate)
          if (isFresh()) return activeTurn?.track(target) ?? keep.track(target)
        })()
      : piCacheKeep.trackAccepted(
          target,
          snapshot,
          activeTurn,
          isFresh,
          prepareTemplate,
        )
    cacheTracking.set(attempt, 'pending')
    void tracked.then(
      () => cacheTracking.set(attempt, 'settled'),
      () => {},
    )
    let latestUsage: Record<string, number> = finalUsage ?? {}
    if (finalUsage && relayAffinity) {
      await tracked.then(() => {
        if (isFresh())
          keep.recordAcceptedUsage(relayAffinity, usageBody, finalUsage)
      })
      return
    }
    options.onCacheUsageRecorder?.((usage) => {
      if (!usage || init.signal?.aborted || !relayAffinity) return
      const merged = { ...latestUsage, ...usage }
      latestUsage = merged
      void tracked.then(() =>
        keep.recordAcceptedUsage(relayAffinity, cleanTemplate, merged),
      )
    })
  }

  const reported = new Set<PiNativeAttempt>()
  let retried401 = false
  let forkCredential: string | undefined
  let lastTransport: 'direct' | 'relay' | undefined
  const used = new Set<PiNativeAttempt>()
  const report = async (
    attempt: PiNativeAttempt,
    status: number,
    source: 'direct' | 'relay_status_field',
  ) => {
    if (status !== 401 || reported.has(attempt)) return
    reported.add(attempt)
    await native.report(attempt, status, source).catch(() => {
      logger.warn('native-auth', 'Pi auth-failure report unavailable')
    })
  }
  const markServed = (attempt: PiNativeAttempt) => {
    options.prime?.onServed(attempt)
    if (used.has(attempt)) return
    used.add(attempt)
    native.usagePublications.publish(() =>
      native.markUsed(attempt, servingRuntime),
    )
  }
  const takeAttempt = async () => {
    const attempt =
      nextAttempt ??
      (await native.authorize(
        routeId,
        init.signal ?? undefined,
        targetPlan ? physicalModel : requestedModel,
        'serve',
        options.routingChoice,
      ))
    nextAttempt = undefined
    await options.prime?.checkAccount(attempt)
    if (attempt.accountIdentity !== verifiedUuid)
      throw new Error('Pi native OAuth route identity changed')
    if (
      forkHead &&
      options.routingChoice &&
      !routingChoiceMatches(options.routingChoice, {
        accountIdentity: attempt.accountIdentity,
        credentialId:
          attempt.source === 'vault' ? attempt.receipt.credentialId : 'local',
      })
    )
      throw new PiForkRefusal('account')
    if (forkHead) {
      const credential =
        attempt.source === 'vault'
          ? attempt.receipt.credentialId
          : localMessageThreadCredential(attempt.admission.binding)
      if (forkCredential && forkCredential !== credential)
        throw new PiForkRefusal('account')
      forkCredential = credential
    }
    return attempt
  }
  let relayConfig = options.apiAccount
    ? null
    : await (await native.service()).getRelayConfig()
  // A gateway takes the request instead of the relay, with no relay attempt
  // and no fallback to api.anthropic.com.
  if (gateway && relayConfig) {
    warnClaudeGatewayRelayIgnored(gateway)
    relayConfig = null
  }
  let threadRequest: MessageThreadRequest | undefined
  // A human prompt can replace the session's turn while a lane start is routing.
  const primaryRequest =
    !options.laneStart &&
    primary !== undefined &&
    primary ===
      piPrimarySession(
        options.storagePath,
        options.streamOptions,
        options.requestOrigin,
      )
  const sideRequest =
    !primaryRequest &&
    piRoundSideRequest(
      options.streamOptions,
      options.storagePath,
      options.requestOrigin,
    )
  const primaryThread =
    primaryRequest &&
    !options.apiAccount &&
    // Gateways may refuse the thread route: send full requests.
    !gateway &&
    typeof options.streamOptions?.onPayload === 'function' &&
    typeof options.streamOptions.onResponse === 'function' &&
    typeof options.streamOptions.onProviderStreamEvent === 'function' &&
    (!relayConfig ||
      effectiveRelayTransport(relayConfig.transport, relayConfig.url) !==
        'websocket')
  const requestedModel = options.model.id
  const currentMode = () => {
    try {
      return servingRuntime.getRefusalFallbackMode?.() ?? mode
    } catch {
      // A response can finish after its account runtime closes.
      return undefined
    }
  }
  const resolvedUrl = () => {
    try {
      const currentGateway = servingRuntime.getClaudeGateway?.()
      return (
        (currentGateway && claudeGatewayModelUrl(input, currentGateway)) ||
        input
      ).toString()
    } catch {
      return undefined
    }
  }
  const originUrl = (gatewayUrl ?? input).toString()
  const boundCredential = piCredentialId(selected)
  const accountMatches = (payer: ReturnType<typeof piBillingPayer>) => {
    const current = native.peek?.()
    if (!current) return false
    const account = current.accounts.find((row) => row.id === routeId)
    if (
      account?.accountIdentity !== payer.accountId ||
      piCredentialId(account) !== payer.credentialId
    ) {
      forgetPiRefusalAccount(payer.accountId)
      return false
    }
    return account?.type === 'oauth' && nativeAccountCanServe(account)
  }
  const targetAllowed = (
    model: string,
    view = native.peek?.() ?? snapshot,
    inheritRouting = false,
  ) => {
    const account = view.accounts.find((row) => row.id === routeId)
    const policyStorage =
      servingRuntime.resolveSettings?.(view.policyStorage, model) ??
      view.policyStorage
    return (
      account?.type === 'oauth' &&
      nativeAccountCanServe(account) &&
      killswitchPassesPolicy(
        account.quota,
        policyStorage,
        routeId === STICKY_ROUTING_MAIN_ACCOUNT_ID ? undefined : routeId,
        model,
      ) &&
      ((inheritRouting &&
        options.routingChoice &&
        routingChoiceMatches(options.routingChoice, account)) ||
        quotaSnapshotPassesPolicy(account.quota, policyStorage)) &&
      quotaSnapshotPassesModelScope(account.quota, model)
    )
  }
  const currentPrimary = (payer: ReturnType<typeof piBillingPayer>) =>
    !init.signal?.aborted &&
    !!realSession &&
    !!primary &&
    !!lineage &&
    primarySessions.get(realSession) === primary &&
    primary.sent === lineage.sequence &&
    options.model.id === requestedModel &&
    (!primary.turn || primary.turn === turn) &&
    accountMatches(payer)
  const isFresh = (payer: ReturnType<typeof piBillingPayer>) =>
    currentPrimary(payer) &&
    currentMode() === mode &&
    resolvedUrl() === originUrl

  // The SDK's one-token warm, Prime, and fork dispatches choose their own
  // model. None becomes a round request or advances a thread.
  const routedRequest =
    !primaryRequest &&
    !options.prime &&
    !forkHead &&
    !options.apiAccount &&
    !options.laneStart &&
    options.streamOptions?.maxTokens !== 1
  let roundPlan: RefusalFallbackRoundPlan | undefined
  if (realSession && (primaryRequest || routedRequest)) {
    await roundEngine.loadThinking(realSession)
    const route = roundRoutes.get(realSession)
    if (route && route.storagePath === options.storagePath) {
      const priorAccount = (native.peek?.() ?? snapshot).accounts.find(
        (row) => row.id === route.routeId,
      )
      if (
        priorAccount?.accountIdentity !== route.accountId ||
        piCredentialId(priorAccount) !== route.credentialId
      )
        forgetPiRefusalAccount(route.accountId)
    }
    const planInput: RefusalFallbackRoundInput = {
      sessionId: realSession,
      requestedModel,
      kind: primaryRequest
        ? 'primary'
        : options.requestOrigin === 'direct'
          ? 'generate'
          : 'summary',
      mode,
      bodyText: sourceBodyText,
      compacted: primaryRequest && primary.compacted,
      routeChanged:
        primaryRequest &&
        route?.requestedModel === requestedModel &&
        route.url !== originUrl,
      oauth:
        !options.apiAccount && verifiedUuid && boundCredential
          ? {
              accountId: verifiedUuid,
              credentialId: boundCredential,
              targetAllowed,
              cache: {
                url: input.toString(),
                accountId: routeId,
                accountIdentity: verifiedUuid,
              },
            }
          : undefined,
    }
    roundPlan = primaryRequest
      ? roundEngine.plan(planInput)
      : roundEngine.planRouted(planInput)
    bodyText = roundPlan.bodyText
    wireBodyText = bodyText
    init.body = bodyText
    if (roundPlan.kind !== 'source') physicalModel = roundPlan.servingModel
  }
  if (primaryRequest && realSession && roundPlan) {
    // A fallback step preserves the requested model's CacheKeep target even
    // when it ends the round. A source reply may still start a new round.
    piCacheKeep.preserveTurn(
      realTurn,
      roundPlan.kind === 'round'
        ? undefined
        : () => roundEngine.hasRound(realSession),
    )
    if (options.apiAccount) piCacheKeep.finishTurn(realTurn)
  } else if (
    roundPlan?.request ||
    (sideRequest &&
      (!options.laneStart || (realSession && refusalRounds.has(realSession))))
  )
    piCacheKeep.preserveTurn(realTurn)
  const roundRequest = roundPlan?.request
  const targetPlan = roundPlan?.kind === 'round' || roundPlan?.kind === 'routed'
  const engineOwnsTemplate = !!roundRequest && roundPlan?.kind !== 'routed'
  const trackOrdinary =
    !engineOwnsTemplate &&
    !targetPlan &&
    (!sideRequest ||
      (options.laneStart && !(realSession && refusalRounds.has(realSession))))
  let roundMarked = false
  const markRoundSent = (attempt?: PiNativeAttempt) => {
    if (roundMarked) return
    if (
      roundRequest &&
      attempt &&
      (piBillingPayer(attempt).credentialId !== boundCredential ||
        currentMode() !== mode ||
        resolvedUrl() !== originUrl)
    )
      throw replanPiRound
    if (roundRequest && !roundEngine.markSent(roundRequest)) throw replanPiRound
    if (primaryRequest) {
      if (roundPlan?.kind === 'round') realTurn?.allowWarms()
      else realTurn?.excludeWarms()
    }
    roundMarked = true
    if (primaryRequest && realSession) {
      delete primary.compacted
      if (attempt)
        roundRoutes.set(realSession, {
          ...piBillingPayer(attempt),
          requestedModel,
          url: originUrl,
          storagePath: options.storagePath,
          routeId,
        })
      else roundRoutes.delete(realSession)
    }
  }
  if (primaryThread) {
    nextAttempt = await takeAttempt()
    threadRequest = await prepareMessageThreadRequest(messageThreads, {
      session: relayAffinity ?? undefined,
      account: nextAttempt.accountIdentity,
      credential:
        nextAttempt.source === 'vault'
          ? nextAttempt.receipt.credentialId
          : localMessageThreadCredential(nextAttempt.admission.binding),
      bodyText,
      replyToolNames: toolNames,
      cacheSlot:
        roundPlan?.kind === 'source' && roundPlan.sourceCacheMarkerRestored
          ? undefined
          : piThreadCacheSlot,
      headers,
      signal: init.signal ?? undefined,
    })
    options.onThreadPrepared?.(threadRequest.fail)
    wireBodyText = threadRequest.bodyText
    init.body = wireBodyText
  } else if (!options.apiAccount) {
    wireBodyText = await signRequestBody(bodyText)
    init.body = wireBodyText
  }
  const clientStream =
    mode === 'client' &&
    (headers
      .get('anthropic-beta')
      ?.split(',')
      .includes(SERVER_SIDE_FALLBACK_BETA) ??
      false)
  const clientSource = clientStream && primaryRequest && !targetPlan
  const lifecycleFor = (attempt: PiNativeAttempt) =>
    roundRequest &&
    roundEngine.lifecycle(roundRequest, {
      isFresh: () => isFresh(piBillingPayer(attempt)),
      targetAllowed,
      projectReply: (blocks) =>
        blocks.map((block) =>
          block.type === 'tool_use'
            ? {
                ...block,
                ...(typeof block.name === 'string' && {
                  name: toClaudeCodeToolName(
                    fromClaudeCodeToolName(block.name, toolNames),
                  ),
                }),
                ...(typeof block.id === 'string' && {
                  id: sanitizeToolId(block.id),
                }),
              }
            : block,
        ),
      sentBodyText: () => wireBodyText,
      onRoundActivity(cacheTtlMs) {
        recordCacheAcceptance(cacheTtlMs, Date.now())
        if (relayAffinity && verifiedUuid)
          keep.recordRoundActivity(relayAffinity, {
            url: input.toString(),
            accountId: routeId,
            accountIdentity: verifiedUuid,
            requestedModel,
          })
      },
      async onCacheKeepTemplate(template, isCurrent) {
        if (!isCurrent() || !realSession) return
        const usage = Object.fromEntries(
          Object.entries(template.usage ?? {}).filter(
            (entry): entry is [string, number] => typeof entry[1] === 'number',
          ),
        )
        await trackAcceptedRequest(
          attempt,
          template.bodyText,
          template.bodyText,
          isCurrent,
          usage,
          signRequestBody,
        )
      },
    })
  const extraSender = (refusalRetry = false, relayedOrigin = false) => {
    let candidate: PiNativeAttempt | undefined
    let dump: DumpHandle | null = null
    let scope: ProviderErrorResponseScope | undefined
    let direct = false
    let upstreamStatus: number | undefined
    const authorize: RefusalFallbackDispatchOptions['authorize'] = async ({
      model,
      origin,
      signal,
    }) => {
      candidate = undefined
      try {
        if (refusalRetry && relayedOrigin && !relayConfig?.fallbackToDirect) {
          // Check the existing payer and target without obtaining credentials
          // for a direct request that the relay policy already forbids.
          const view = await native.view(signal, model)
          const account = view.accounts.find((row) => row.id === routeId)
          if (
            targetAllowed(model, view, true) &&
            account?.accountIdentity === origin.accountId &&
            piCredentialId(account) === origin.credentialId &&
            resolvedUrl() === origin.url
          )
            return { kind: 'defer', ...origin }
          return { kind: 'denied' }
        }
        // This is the same routed step. Reuse its account choice, but check
        // the retry model's protections separately on the final account view.
        const routingChoice = refusalRetry ? options.routingChoice : undefined
        const attempt = routingChoice
          ? await native.authorize(
              routeId,
              signal,
              model,
              'serve',
              routingChoice,
            )
          : await native.authorize(routeId, signal, model, 'serve')
        const currentRelay =
          refusalRetry && !gateway
            ? await servingRuntime.getRelayConfig()
            : null
        const view = await native.view(signal, model)
        const account = view.accounts.find((row) => row.id === routeId)
        const payer = piBillingPayer(attempt)
        if (
          !targetAllowed(model, view, refusalRetry) ||
          account?.accountIdentity !== payer.accountId ||
          piCredentialId(account) !== payer.credentialId
        )
          return { kind: 'denied' }
        const url = resolvedUrl()
        if (!url) return { kind: 'denied' }
        const binding = { ...payer, url }
        // Either read can veto direct transport. The account snapshot also
        // catches relay policy changes during the final quota read.
        const finalRelay = view.policyStorage.relay
        const finalRelayUsable = effectiveRelayStatus(finalRelay)
        if (
          refusalRetry &&
          (relayedOrigin
            ? !currentRelay?.fallbackToDirect ||
              !finalRelayUsable ||
              finalRelay?.fallbackToDirect === false
            : !gateway &&
              (currentRelay?.fallbackToDirect === false ||
                (finalRelayUsable && finalRelay?.fallbackToDirect === false)))
        )
          return { kind: 'defer', ...binding }
        candidate = attempt
        return {
          kind: 'authorized',
          ...binding,
          accessToken: piAttemptAccessToken(attempt),
        }
      } catch {
        return { kind: 'denied' }
      }
    }
    const send: RefusalFallbackDispatchOptions['send'] = async ({
      url,
      headers,
      body,
      bodyText,
      signal,
    }) => {
      const currentGateway = servingRuntime.getClaudeGateway?.()
      requirePiOAuthOrigin(url, currentGateway)
      signal.throwIfAborted()
      assertHostAuthorityStable()
      if (refusalRetry) realTurn?.allowWarms()
      else realTurn?.excludeWarms()
      if (!refusalRetry && relayedOrigin) {
        const config = relayConfig
        if (!config || !candidate) throw new Error('Relay is unavailable')
        const payer = piBillingPayer(candidate)
        const relayHeaders = new Headers(headers)
        relayHeaders.delete('content-length')
        relayHeaders.delete('content-encoding')
        return sendViaRelay({
          config,
          input: url,
          requireUpstreamUrl: (url) =>
            requirePiOAuthOrigin(url, currentGateway),
          init: { method: 'POST', signal },
          headers: relayHeaders,
          body: bodyText,
          affinity: relayAffinity,
          authorizeAttempt: async () => {
            if (!currentPrimary(payer) || resolvedUrl() !== url)
              throw new Error('Source resend is stale')
            assertHostAuthorityStable()
            return {
              headers: relayHeaders,
              onUpstreamStatus: (status) => {
                upstreamStatus = status
              },
            }
          },
          onDumpCreated: (handle) => {
            dump = handle
          },
          fallback: async () => {
            if (
              !config.fallbackToDirect ||
              !(await (await native.service()).getRelayConfig())
                ?.fallbackToDirect
            )
              throw new Error('Direct source resend is not allowed')
            const origin = { ...payer, url }
            const decision = await authorize({
              model: requestedModel,
              origin,
              wait: false,
              signal,
            })
            if (
              decision.kind !== 'authorized' ||
              decision.accountId !== payer.accountId ||
              decision.credentialId !== payer.credentialId ||
              decision.url !== url ||
              !currentPrimary(payer)
            )
              throw new Error('Direct source resend is not authorized')
            headers.set('authorization', `Bearer ${decision.accessToken}`)
            signal.throwIfAborted()
            assertHostAuthorityStable()
            return sendDirect()
          },
        })
      }
      return sendDirect()

      async function sendDirect() {
        direct = true
        const response = await fetchResponse(url, {
          method: 'POST',
          body,
          headers,
          signal,
          redirect: 'error',
        })
        scope = createProviderErrorResponseScope(
          [
            ...(candidate ? [piAttemptAccessToken(candidate)] : []),
            ...claudeGatewayHeaderValues(currentGateway),
          ],
          'event-stream',
        )
        dump = await dumpDirectRequest({
          affinity: relayAffinity,
          route: options.route ?? 'oauth',
          status: response.status,
          bodyText,
          url,
          method: 'POST',
          headers,
        })
        return response
      }
    }
    const observe = (
      guarded: Response,
      model: string,
      onComplete?: () => void,
    ) => {
      const safe = scope?.redactResponse(guarded) ?? guarded
      if (candidate && (direct || upstreamStatus !== undefined || safe.ok)) {
        observeResponseHeaders(candidate, safe.headers, safe.status, model)
        if (safe.ok) markServed(candidate)
        void report(
          candidate,
          safe.status,
          direct ? 'direct' : 'relay_status_field',
        )
      }
      return observePiFallbackAttempt(safe, dump, () => onComplete?.())
    }
    return { authorize, send, observe }
  }
  const dispatchClient = (
    response: Response,
    originAttempt: PiNativeAttempt,
    url: string,
    sentHeaders: Headers,
    sentBody: string,
    billing: NonNullable<Awaited<ReturnType<typeof billingInput>>>,
    originDump: DumpHandle | null,
    protectedOrigin?: { takeRefusalCredit: () => string | undefined },
    sourceScope?: ProviderErrorResponseScope,
    lifecycle?: ReturnType<typeof lifecycleFor>,
  ) => {
    const originHeaders = new Headers(sentHeaders)
    originHeaders.delete('content-length')
    const origin = {
      ...piBillingPayer(originAttempt),
      url,
      headers: originHeaders,
      bodyText: sentBody,
      fullBodyText: bodyText,
    }
    const extra = extraSender(true, protectedOrigin !== undefined)
    const fresh = () => isFresh(origin)
    const originalThread = threadRequest
    return dispatchRefusalFallback(response, {
      sourceModel: requestedModel,
      origin,
      billing,
      protectedOrigin,
      isFresh: fresh,
      lifecycle,
      signal: init.signal ?? undefined,
      authorize: extra.authorize,
      send: extra.send,
      onRetryCommitted: ({ model }) => options.onServingModel?.(model),
      observePhysicalResponse: (guarded, physical) => {
        if (!physical.refusalRetry) {
          const safe = sourceScope?.redactResponse(guarded) ?? guarded
          if (!protectedOrigin)
            observeResponseHeaders(originAttempt, safe.headers, safe.status)
          const observed = originalThread?.observe(safe) ?? safe
          return observePiFallbackAttempt(
            observed,
            originDump,
            async (usage) => {
              if (!fresh()) {
                originalThread?.fail()
                return
              }
              observeRequestId(safe.headers)
              if (!lifecycle && trackOrdinary)
                await trackAcceptedRequest(
                  originAttempt,
                  sentBody,
                  bodyText,
                  fresh,
                  usage,
                )
            },
          )
        }
        return extra.observe(guarded, physical.model, () => {
          if (fresh()) observeRequestId(guarded.headers)
        })
      },
    })
  }
  let physicalRound:
    | {
        attempt: PiNativeAttempt
        url: string
        headers: Headers
        lifecycle: ReturnType<typeof lifecycleFor>
      }
    | undefined
  let observedThreadResponse: Response | undefined
  const directFetch = async () => {
    let attempt: PiNativeAttempt | undefined
    let apiSubject: NativeApiSubject | undefined
    // The secret this physical send goes out with; a provider error may repeat it.
    let secret = ''
    if (options.apiAccount) {
      const credential = await (await native.service()).authorizeApi(
        options.apiAccount.id,
        init.signal ?? undefined,
      )
      apiSubject = credential.subject
      secret = credential.apiKey ?? ''
      input = buildExplicitBaseMessagesUrl(credential.baseURL)
      const authorized = configureApiRouteHeaders(
        {
          ...credential,
          id: options.apiAccount.id,
        },
        fastMode,
      )
      init.headers = authorized
    } else {
      attempt = await takeAttempt()
      secret = piAttemptAccessToken(attempt)
      headers.set('authorization', `Bearer ${secret}`)
    }
    lastTransport = 'direct'
    // The response scope of the latest physical send. Each send gets its own
    // before the request leaves, so a rejected 401 is already scrubbed when
    // it is reported, dumped or cancelled.
    const physical: { scope?: ProviderErrorResponseScope } = {}
    const send = async () => {
      await options.prime?.beforeSend()
      init.signal?.throwIfAborted()
      assertHostAuthorityStable()
      // Only the destination and the gateway's own headers change; the body
      // goes uncompressed, as Claude Code compresses only to
      // api.anthropic.com.
      if (gateway && gatewayUrl) {
        requirePiOAuthOrigin(gatewayUrl.toString(), gateway)
        const gatewayHeaders = applyClaudeGatewayHeaders(
          new Headers(headers),
          gateway,
        )
        return physicalFetch(gatewayUrl, { ...init, headers: gatewayHeaders })
      }
      // OAuth bodies go gzipped as Claude Code sends them; `bodyText` stays
      // the signed identity text for dumps and CacheKeep.
      if (options.apiAccount || typeof init.body !== 'string')
        return physicalFetch(input, init)
      return sendWithRequestGzip({
        url: input,
        body: init.body,
        headers,
        latch: getRequestGzipLatch(
          getRequestGzipLatchPath(options.storagePath),
        ),
        send: async (wireBody, wireHeaders) => {
          await options.prime?.beforeSend()
          init.signal?.throwIfAborted()
          assertHostAuthorityStable()
          return physicalFetch(input, {
            ...init,
            body: wireBody,
            headers: wireHeaders,
          })
        },
      })
    }
    const physicalFetch = async (destination: URL, request: RequestInit) => {
      const requestHeaders = new Headers(request.headers)
      const sentBody = wireBodyText
      const lifecycle = attempt && lifecycleFor(attempt)
      const billing = await billingInput(
        attempt,
        apiSubject,
        sentBody,
        physicalModel,
        lifecycle && (() => lifecycle.cacheKeepTemplateSettled),
      )
      const scope = createProviderErrorResponseScope(
        [secret, ...claudeGatewayHeaderValues(gateway)],
        'event-stream',
      )
      physical.scope = scope
      let raw: Response
      try {
        request.signal?.throwIfAborted()
        assertHostAuthorityStable()
        if (attempt)
          physicalRound = {
            attempt,
            url: destination.toString(),
            headers: requestHeaders,
            lifecycle,
          }
        markRoundSent(attempt)
        raw = await fetchResponse(destination, request)
        options.prime?.onDispatched?.()
      } catch (error) {
        if (error === replanPiRound) throw error
        if (billing) reportAnthropicBillingFailure(billing)
        throw error
      }
      if (clientSource && raw.ok && attempt && billing) {
        const handle = await dumpDirectRequest({
          affinity: relayAffinity,
          route: options.route ?? 'oauth',
          status: raw.status,
          bodyText: sentBody,
          url: destination.toString(),
          method: request.method,
          headers: requestHeaders,
        })
        const response = dispatchClient(
          raw,
          attempt,
          destination.toString(),
          requestHeaders,
          sentBody,
          billing,
          handle,
          undefined,
          scope,
          lifecycle,
        )
        observedThreadResponse = response
        return response
      }
      const guarded = scope.redactResponse(
        protectFallbackCreditResponse(raw, {
          requestHeaders,
          requestBodyText: sentBody,
          framing: 'event-stream',
        }),
      )
      const response = billing
        ? observeAnthropicBillingResponse(billing, guarded)
        : guarded
      if (attempt)
        observeResponseHeaders(attempt, response.headers, response.status)
      return response
    }
    let response: Response
    try {
      response = await send()
      if (attempt && response.status === 401) {
        // Report the rejected credential version before retrying, even if its replacement later succeeds.
        await report(attempt, response.status, 'direct')
        const rotated =
          !retried401 &&
          !init.signal?.aborted &&
          (!forkHead || attempt.source === 'vault')
            ? await native
                .retry(
                  routeId,
                  attempt,
                  init.signal ?? undefined,
                  targetPlan ? physicalModel : requestedModel,
                  options.routingChoice,
                )
                .catch(() => undefined)
            : undefined
        if (rotated) {
          if (
            forkHead &&
            options.routingChoice &&
            !routingChoiceMatches(options.routingChoice, {
              accountIdentity: rotated.accountIdentity,
              credentialId:
                rotated.source === 'vault'
                  ? rotated.receipt.credentialId
                  : 'local',
            })
          )
            throw new PiForkRefusal('account')
          retried401 = true
          await dumpDirectRequest({
            affinity: relayAffinity,
            route: options.route ?? 'oauth',
            status: response.status,
            bodyText: wireBodyText,
            url: input.toString(),
            method: init.method,
            headers,
          })
          // Retire the rejected send's credentials before cancelling its
          // body, since that cancellation may never settle.
          physical.scope?.dispose()
          await response.body?.cancel().catch(() => {})
          await options.prime?.checkAccount(rotated)
          attempt = rotated
          secret = piAttemptAccessToken(rotated)
          headers.set('authorization', `Bearer ${secret}`)
          response = await send()
        }
      }
      if (attempt) await report(attempt, response.status, 'direct')
      // The vault has been told about the 401 above. If the request was
      // cancelled after the 401 arrived (before or while the vault was asked
      // for a newer credential), end it as cancelled here.
      if (attempt && response.status === 401)
        await endIfCancelled(response, init.signal)
      dumpHandle =
        response === observedThreadResponse
          ? null
          : await dumpDirectRequest({
              affinity: relayAffinity,
              route:
                options.route ??
                (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
              status: response.status,
              bodyText: wireBodyText,
              url: input.toString(),
              method: init.method,
              headers: init.headers,
            })
    } catch (caught) {
      // No response leaves this send, so its credentials retire here.
      physical.scope?.dispose()
      if (caught === replanPiRound) throw caught
      const scope = createProviderErrorResponseScope(
        // A gateway error may echo the gateway's own header values.
        [secret, ...claudeGatewayHeaderValues(gateway)],
        'event-stream',
      )
      const error = scope.redactError(caught)
      scope.dispose()
      await dumpDirectRequest({
        affinity: relayAffinity,
        route:
          options.route ??
          (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
        // A fixed label: the error text can repeat provider output or a credential.
        error: PHYSICAL_SEND_FAILED,
        bodyText: wireBodyText,
        url: input.toString(),
        method: init.method,
        headers: init.headers,
      })
      throw error
    }
    if (apiSubject && response.ok) {
      const subject = apiSubject
      native.usagePublications.publish(() =>
        servingRuntime.publishApi(
          subject,
          { lastUsed: Date.now() },
          native.usagePublications.signal,
        ),
      )
    }
    if (attempt && response.ok) {
      if (!clientSource && trackOrdinary) await trackAcceptedRequest(attempt)
      markServed(attempt)
    }
    if (options.apiAccount && dumpHandle) {
      await dumpResponseArtifact(dumpHandle, {
        status: response.status,
        message: null,
        complete: false,
      })
      dumpResponseObservers.set(
        response,
        createDumpResponseObserver(dumpHandle, response.status),
      )
    }
    return response
  }
  if (options.apiAccount) return directFetch()

  let relay401Attempt: PiNativeAttempt | undefined
  let relayAttempt: PiNativeAttempt | undefined
  const relayReports: Promise<void>[] = []
  // The relay scrubs each physical relay attempt's responses and errors with
  // that attempt's own credentials and the relay token; a direct fallback is
  // scrubbed by directFetch.
  const sendRelayAttempt = async () => {
    let upstream: { attempt: PiNativeAttempt; status: number } | undefined
    let accepted: Promise<void> | undefined
    let clientRelay:
      | {
          attempt: PiNativeAttempt
          headers: Headers
          bodyText: string
          billing: NonNullable<Awaited<ReturnType<typeof billingInput>>>
          takeRefusalCredit: () => string | undefined
          lifecycle: ReturnType<typeof lifecycleFor>
        }
      | undefined
    const response = await sendViaRelay({
      config: relayConfig,
      input,
      init,
      headers,
      body: wireBodyText,
      fallback: directFetch,
      affinity: relayAffinity,
      // Some relay streams start before the provider answers. Report the
      // provider's actual status and headers, not that early placeholder.
      onResponseHeaders: (responseHeaders) => {
        observeRequestId(responseHeaders)
        if (upstream)
          observeResponseHeaders(
            upstream.attempt,
            responseHeaders,
            upstream.status,
          )
      },
      onDumpCreated: (handle) => {
        dumpHandle = handle
      },
      authorizeAttempt: async () => {
        const attempt = await takeAttempt()
        await options.prime?.beforeSend()
        init.signal?.throwIfAborted()
        assertHostAuthorityStable()
        relayAttempt = attempt
        lastTransport = 'relay'
        const authorizedHeaders = new Headers(headers)
        const sentBody = wireBodyText
        const access = piAttemptAccessToken(attempt)
        authorizedHeaders.set('authorization', `Bearer ${access}`)
        const lifecycle = lifecycleFor(attempt)
        const billing = await billingInput(
          attempt,
          undefined,
          sentBody,
          physicalModel,
          lifecycle && (() => lifecycle.cacheKeepTemplateSettled),
        )
        let credit: string | undefined
        if (clientSource && billing) {
          clientRelay = {
            attempt,
            headers: authorizedHeaders,
            bodyText: sentBody,
            billing,
            lifecycle,
            takeRefusalCredit: () => {
              const token = credit
              credit = undefined
              return token
            },
          }
        }
        physicalRound = {
          attempt,
          url: input.toString(),
          headers: authorizedHeaders,
          lifecycle,
        }
        markRoundSent(attempt)
        return {
          headers: authorizedHeaders,
          billing,
          ...(clientRelay && {
            onRefusalCredit: (value: string) => {
              credit = value
            },
          }),
          errorSecrets: [access],
          onUpstreamStatus: (status) => {
            upstream = { attempt, status }
            if (!clientSource && trackOrdinary && status >= 200 && status < 300)
              accepted = trackAcceptedRequest(attempt, sentBody)
            if (status === 401) {
              relay401Attempt = attempt
              // The relay can report an upstream 401 after returning the streaming response.
              relayReports.push(report(attempt, status, 'relay_status_field'))
            }
          },
        }
      },
    })
    await accepted
    if (!response.ok || lastTransport !== 'relay' || !clientRelay)
      return response
    const joined = dispatchClient(
      response,
      clientRelay.attempt,
      input.toString(),
      clientRelay.headers,
      clientRelay.bodyText,
      clientRelay.billing,
      dumpHandle,
      clientRelay,
      undefined,
      clientRelay.lifecycle,
    )
    observedThreadResponse = joined
    dumpHandle = null
    return joined
  }
  let response = await sendRelayAttempt()
  await Promise.all(relayReports)
  if (
    relay401Attempt &&
    response.status === 401 &&
    !retried401 &&
    (!forkHead || relay401Attempt.source === 'vault') &&
    !init.signal?.aborted
  ) {
    const rotated = await native
      .retry(
        routeId,
        relay401Attempt,
        init.signal ?? undefined,
        targetPlan ? physicalModel : requestedModel,
        options.routingChoice,
      )
      .catch(() => undefined)
    if (rotated) {
      retried401 = true
      await response.body?.cancel().catch(() => {})
      // Use the replacement credential only for the retried relay request.
      // A direct request after relay failure obtains its own authorization.
      nextAttempt = rotated
      relay401Attempt = undefined
      response = await sendRelayAttempt()
      await Promise.all(relayReports)
    }
  }
  // A relayed 401 is reported to the vault as soon as the relay returns it.
  // If the request was cancelled since, end it as cancelled here.
  if (relay401Attempt && response.status === 401)
    await endIfCancelled(response, init.signal)
  if (threadRequest) {
    response = await threadRequest.recover(response, async (createBody) => {
      wireBodyText = createBody
      init.body = createBody
      return sendRelayAttempt()
    })
  }
  let terminalResend = false
  if (targetPlan && roundRequest && physicalRound && response.status === 400) {
    const { attempt, url, headers, lifecycle } = physicalRound
    const payer = piBillingPayer(attempt)
    const extra = extraSender(false, lastTransport === 'relay')
    const sourceBilling = await billingInput(
      attempt,
      undefined,
      sourceBodyText,
      requestedModel,
      lifecycle && (() => lifecycle.cacheKeepTemplateSettled),
    )
    const resendHeaders = new Headers(headers)
    resendHeaders.delete('content-length')
    const resent = await roundEngine.handleTarget400(roundRequest, response, {
      sourceModel: requestedModel,
      origin: { ...payer, url, headers: resendHeaders },
      signal: init.signal ?? undefined,
      isCurrentPrimary: () => currentPrimary(payer),
      authorize: extra.authorize,
      send: extra.send,
      onResendFailure: () => {
        if (sourceBilling) reportAnthropicBillingFailure(sourceBilling)
      },
      observeResendResponse: (guarded, model) => {
        const observed = extra.observe(guarded, model)
        return sourceBilling
          ? observeAnthropicBillingResponse(sourceBilling, observed)
          : observed
      },
    })
    terminalResend = resent !== response
    if (terminalResend) {
      threadRequest?.fail()
      options.onThreadPrepared?.(() => {})
      dumpHandle = null
    }
    response = resent
  }
  if (threadRequest && response !== observedThreadResponse && !terminalResend)
    response = threadRequest.observe(response)
  if (lastTransport === 'direct') observeRequestId(response.headers)
  if (
    !terminalResend &&
    response.ok &&
    lastTransport === 'relay' &&
    relayAttempt
  ) {
    if (
      options.prime &&
      !/^req_[A-Za-z0-9_-]+$/.test(response.headers.get('request-id') ?? '')
    ) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Pi Prime relay response has no upstream provenance')
    }
    // HTTP relays forward the accepted status even without a request-id.
    // Optimistic WebSocket responses must wait for their real upstream status.
    if (
      !clientSource &&
      trackOrdinary &&
      response.headers.get('x-cortexkit-relay-optimistic') !== 'true'
    )
      await trackAcceptedRequest(relayAttempt)
    markServed(relayAttempt)
  }
  if (targetPlan && !terminalResend && response.ok)
    options.onServingModel?.(physicalModel)
  if (
    !terminalResend &&
    response.ok &&
    response !== observedThreadResponse &&
    clientStream &&
    (clientSource || targetPlan)
  )
    response = joinRefusalFallbackStream(response, {
      sourceModel: requestedModel,
      lifecycle: physicalRound?.lifecycle,
      isFresh: () =>
        currentMode() === mode &&
        !init.signal?.aborted &&
        (!primaryRequest ||
          (!!physicalRound && isFresh(piBillingPayer(physicalRound.attempt)))),
      signal: init.signal ?? undefined,
    })
  if (serverSideFallbackSent && response.ok && response.body) {
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: physicalModel,
      serverSideFallbackSent,
      maxPendingBytes: DEFAULT_SSE_MAX_FRAME_BYTES,
      onOutcome: (outcome) => {
        // Sticky routing can change the serving model without a fallback block.
        if (outcome.fallback) threadRequest?.fail('response_fallback')
        logServedServerFallback(relayAffinity, outcome)
      },
    })
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const rewritten = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          const output = rewriter.push(decoder.decode(chunk, { stream: true }))
          if (output) controller.enqueue(encoder.encode(output))
        },
        flush(controller) {
          const output = rewriter.push(decoder.decode()) + rewriter.flush()
          if (output) controller.enqueue(encoder.encode(output))
        },
      }),
    )
    response = copyStreamResponseTiming(
      response,
      new Response(rewritten, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  }
  if (dumpHandle) {
    await dumpResponseArtifact(dumpHandle, {
      status: response.status,
      message: null,
      complete: false,
    })
    dumpResponseObservers.set(
      response,
      createDumpResponseObserver(dumpHandle, response.status),
    )
  }
  if (diagnosticsSession && response.ok) {
    const previousMessageId = diagnosticsSession.previous?.messageId ?? null
    const payload = JSON.parse(wireBodyText) as {
      diagnostics?: { previous_message_id?: string | null }
      model?: unknown
    }
    // Thread recovery can replace the prepared body. Attribute the result only
    // if the actual send carried this diagnostic predecessor and beta.
    if (
      payload.diagnostics?.previous_message_id === previousMessageId &&
      hasCacheDiagnosticsBeta(headers)
    ) {
      const betas = getCacheDiagnosticsBetas(headers).catch(() => undefined)
      const ttlSent = summarizeCacheTtl(payload)
      const requestedModel =
        typeof payload.model === 'string' ? payload.model : undefined
      const current = () =>
        !init.signal?.aborted &&
        cacheDiagnosticsSessions.get(diagnosticsSession.id) ===
          diagnosticsSession.token
      cacheDiagnosticsObservers.set(response, async (message) => {
        if (!current()) return
        const receivedAt = Date.now()
        const messageId = cacheDiagnosticsMessageId(message)
        // Record the predecessor before yielding, even if debug logging is delayed or skipped.
        if (primaryRequest && messageId)
          cacheDiagnostics.capture(diagnosticsSession.id, messageId, receivedAt)
        const sent = await betas
        if (!sent || !current()) return
        const { record, canary } = buildCacheDiagnosticsRecord({
          request: {
            sessionId: diagnosticsSession.id,
            previousMessageId,
            previousMessageReceivedAt: diagnosticsSession.previous?.receivedAt,
            isSubagent: false,
            ttlSent,
          },
          source: options.laneStart ? 'start' : 'turn',
          accountId: routeId,
          synthetic: options.laneStart === true,
          betasHash: sent.betasHash,
          requestedModel,
          message,
          receivedAt,
        })
        if (!record) return
        logger.debug('cache-diagnostics', formatCacheDiagnosticsLogLine(record))
        const betaLine = cacheDiagnosticBetas.capture(
          sent.betasHash,
          sent.betas,
        )
        if (betaLine) logger.debug('cache-diagnostics', betaLine)
        if (canary)
          logger.warn(
            'cache-diagnostics',
            'short-gap previous_message_not_found',
            {
              message_id: canary.messageId,
              previous_message_id: canary.previousMessageId,
            },
          )
      })
    }
  }
  return response
}

/** Exercise one native send with isolated transport and scheduling in tests. */
export const __sendPiAnthropicRequestForTest = sendAnthropicRequest

/**
 * If the request's signal is aborted, cancels the response body and throws the
 * signal's abort error; otherwise does nothing. Call it before a rejected
 * response is handed to account routing. Routing treats a returned 401 as a
 * failure of the account and may move the session to another account (sticky
 * migration); a request the user cancelled must end as cancelled instead.
 */
async function endIfCancelled(
  response: Response,
  signal: AbortSignal | null | undefined,
) {
  if (!signal?.aborted) return
  await response.body?.cancel().catch(() => {})
  signal.throwIfAborted()
}

function quotaSnapshotIsExhausted(
  quota: Awaited<ReturnType<QuotaManager['refreshMain']>> | undefined,
) {
  // A deferred poll can return the cached quota. A header percentage rounded
  // to 100% is display evidence, not permission to switch to a paid route.
  return (['five_hour', 'seven_day'] as const).some(
    (key) =>
      quotaFieldSource(quota, key) !== 'headers' &&
      (quota?.[key]?.remainingPercent ?? 1) <= 0,
  )
}

export function primaryResponseAllowsApiFallback(preflight: Response | string) {
  return (
    preflight === 'rate_limit_error' ||
    (preflight instanceof Response && preflight.status === 429)
  )
}

/**
 * Bytes read while looking for a successful stream's first event. Comments
 * and heartbeats carry no event, so a stream of them alone must not keep the
 * inspection reading (and buffering) without end.
 */
const FIRST_EVENT_INSPECTION_BYTES = 65_536

/**
 * Classify a successful stream by its first event without a tee: the bytes
 * read are replayed in front of the rest of the body, so cancelling the
 * returned response cancels the provider body itself. `preflight` is
 * `rate_limit_error` for a streamed rate limit (the provider body is then
 * cancelled and only the bytes read are replayed), else the returned
 * response. A stream whose first event does not arrive within the budget, or
 * cannot be read, is returned unclassified.
 */
export async function firstStreamingError(
  response: Response,
): Promise<{ response: Response; preflight: Response | 'rate_limit_error' }> {
  if (!response.ok || !response.body) return { response, preflight: response }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  const framer = createSseFramer({
    maxFrameBytes: FIRST_EVENT_INSPECTION_BYTES,
  })
  let bytes = 0
  let rateLimited = false
  let decided = false
  // Only the stream's first frame may drop a leading byte-order mark.
  let streamStart = true
  try {
    while (!decided && bytes < FIRST_EVENT_INSPECTION_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      bytes += value.byteLength
      for (const frame of framer.push(value)) {
        const data = parseSseFrame(decodeSseFrame(frame, { streamStart })).data
        streamStart = false
        if (!data || data === '[DONE]') continue
        const event = JSON.parse(data) as AnthropicEvent
        // Anthropic reports a streamed rate limit as an `error` event whose
        // `error.type` is `rate_limit_error`; only that event is a rate limit.
        rateLimited =
          event.type === 'error' && event.error?.type === 'rate_limit_error'
        decided = true
        break
      }
    }
  } catch {
    // An unreadable body, an oversized first frame or a first event that is
    // not JSON is not treated as a rate limit: the response is returned for
    // the consumer to read, and an unreadable body fails that read too.
  }
  // The provider reader is released as soon as nothing will read it again:
  // at end of stream, after a read failure, or once a cancellation settles.
  const release = () => {
    try {
      reader.releaseLock()
    } catch {
      // Already released.
    }
  }
  const replay = (rest: boolean) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          if (!rest) controller.close()
        },
        async pull(controller) {
          let next: Awaited<ReturnType<typeof reader.read>>
          try {
            next = await reader.read()
          } catch (error) {
            release()
            throw error
          }
          if (next.done) {
            release()
            controller.close()
          } else controller.enqueue(next.value)
        },
        async cancel(reason) {
          if (!rest) return
          try {
            await reader.cancel(reason)
          } finally {
            release()
          }
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    )
  if (rateLimited) {
    // Routing replaces this response. Cancel the provider body and clear its
    // copied redaction material; retain the inspected error event for callers
    // that still return the replay response.
    await reader.cancel().catch(() => {})
    release()
    return { response: replay(false), preflight: 'rate_limit_error' }
  }
  const inspected = copyStreamResponseTiming(response, replay(true))
  const dumpObserver = dumpResponseObservers.get(response)
  if (dumpObserver) dumpResponseObservers.set(inspected, dumpObserver)
  const cacheDiagnosticsObserver = cacheDiagnosticsObservers.get(response)
  if (cacheDiagnosticsObserver)
    cacheDiagnosticsObservers.set(inspected, cacheDiagnosticsObserver)
  return { response: inspected, preflight: inspected }
}

// A local completion, not a provider response. Keep routing's quota-wait path
// able to hand it back without treating a skipped lane start as a refusal.
const skippedPaidLaneStart = new Response(null, { status: 204 })

async function executeWithFallback(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  requestOrigin?: 'agent-loop' | 'direct'
  laneStart?: boolean
  storagePath: string
  effortTransitions?: readonly PiEffortTransition[]
  onResolvedToolNames?: (toolNames: ReadonlyMap<string, string>) => void
  onForkEffortApplied?: (effort: PiForkEffortHint | undefined) => void
  onThreadPrepared?: (fail: () => void) => void
  onCapacityWait?: () => () => void
  routingRelay?: ReturnType<typeof createRoutingRelay>
  routingState?: {
    relay: ReturnType<typeof createRoutingRelay>
    advice?: Promise<RoutingChoice | undefined>
  }
}): Promise<Response> {
  const routingState = options.routingState ?? {
    relay: createRoutingRelay(),
    advice: undefined,
  }
  options = { ...options, routingRelay: routingState.relay }
  const native = getPiNativeRuntime(options.storagePath)
  let snapshot = await native.requestView(
    options.streamOptions?.signal,
    options.model.id,
  )
  let storage = snapshot.policyStorage
  const accountView = (id: string) =>
    snapshot.accounts.find((account) => account.id === id)
  const vaultAccountIdentities = () => {
    if (snapshot.mode !== 'claustrum') return undefined
    const identities = new Map<string, string>()
    for (const account of snapshot.accounts) {
      if (account.source === 'vault' && account.accountIdentity)
        identities.set(account.id, account.accountIdentity)
    }
    return identities
  }
  const nativeReady = (id: string) => {
    const account = accountView(id)
    return Boolean(
      account?.type === 'oauth' &&
        nativeAccountCanServe(account) &&
        !isPermanentRefreshError(account.lastRefreshError) &&
        (account.source !== 'local' ||
          (account.lastRefreshError?.nextRetryAt ?? 0) <= Date.now()),
    )
  }
  const primaryAvailable = () => nativeReady(STICKY_ROUTING_MAIN_ACCOUNT_ID)
  let { quotaManager, getUsableFallbackAccounts } = getPiRoutingServices(
    options.storagePath,
    snapshot,
  )
  let mainAccountId = accountView(
    STICKY_ROUTING_MAIN_ACCOUNT_ID,
  )?.accountIdentity
  quotaManager.seedMainFromStorage(storage, mainAccountId)
  quotaManager.seedFallbacksFromAccounts(
    (storage?.accounts ?? []).filter(isOAuthAccount),
  )

  type PiStickyRoute = {
    id: string
    quota?: OAuthQuotaSnapshot
    order: number
    account?: OAuthAccount
  }

  function quotaObservationIsFresh(
    quota: OAuthQuotaSnapshot | undefined,
    modelId: string,
  ): boolean {
    if (stickyQuotaSnapshotIsFresh(quota, storage, Date.now(), modelId))
      return true
    // A successful usage response without quota windows is not a failed poll.
    // Pi can serve that OAuth account without a known remaining capacity.
    if (
      !quota ||
      quota.five_hour ||
      quota.seven_day ||
      quota.source !== 'poll' ||
      quota.checkedAt === undefined
    )
      return false
    const age = getQuotaCheckIntervalMs(storage)
    const scopedWindow = getScopedQuotaWindowForModel(quota, modelId)
    return (
      Date.now() - quota.checkedAt < age &&
      (!scopedWindow || Date.now() - scopedWindow.checkedAt < age)
    )
  }

  async function refreshRoutingSnapshot() {
    snapshot = await native.view(
      options.streamOptions?.signal,
      options.model.id,
    )
    storage = snapshot.policyStorage
    mainAccountId = accountView(STICKY_ROUTING_MAIN_ACCOUNT_ID)?.accountIdentity
    ;({ quotaManager, getUsableFallbackAccounts } = getPiRoutingServices(
      options.storagePath,
      snapshot,
    ))
    quotaManager.seedMainFromStorage(storage, mainAccountId)
    quotaManager.seedFallbacksFromAccounts(
      storage.accounts.filter(isOAuthAccount),
    )
  }

  async function buildStickyRoutes(modelId: string) {
    await refreshRoutingSnapshot()
    const mainEntry = quotaManager.getMain(mainAccountId)
    let mainQuota = mainEntry?.quota
    if (
      primaryAvailable() &&
      !stickyQuotaSnapshotIsFresh(
        mainEntry?.quota,
        storage,
        Date.now(),
        modelId,
      )
    ) {
      try {
        mainQuota = await quotaManager.refreshMain(
          mainAccountId,
          '',
          undefined,
          'admission',
        )
      } catch {}
    }
    const usableFallbacks = await getUsableFallbackAccounts(storage, {
      modelId,
    })
    const usableById = new Map(
      usableFallbacks.map((account) => [account.id, account]),
    )
    const allRoutes: PiStickyRoute[] = []
    if (primaryAvailable()) {
      allRoutes.push({
        id: STICKY_ROUTING_MAIN_ACCOUNT_ID,
        quota: mainQuota,
        order: 0,
      })
    }
    for (const [index, configured] of (storage?.accounts ?? []).entries()) {
      if (!nativeAccountCanServe(configured) || !isOAuthAccount(configured))
        continue
      const account = usableById.get(configured.id) ?? configured
      if (!nativeReady(account.id)) continue
      let accountQuota =
        quotaManager.getFallback(account.id, account)?.quota ?? account.quota
      if (
        !stickyQuotaSnapshotIsFresh(accountQuota, storage, Date.now(), modelId)
      ) {
        try {
          accountQuota = await quotaManager.refreshFallback(
            account.id,
            '',
            account,
            'admission',
          )
        } catch {}
      }
      allRoutes.push({
        id: account.id,
        quota: accountQuota,
        order: index + 1,
        account,
      })
    }
    const retainAccountIds = new Set(
      allRoutes.flatMap((route) => {
        const refreshError =
          route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
            ? storage?.refresh?.mainLastRefreshError
            : route.account?.lastRefreshError
        if (isPermanentRefreshError(refreshError)) return []
        if (
          stickyQuotaSnapshotIsFresh(
            route.quota,
            storage,
            Date.now(),
            modelId,
          ) &&
          decideStickyQuotaFailure({
            quota: route.quota,
            modelId,
            sessionId: options.streamOptions?.sessionId,
            holdUntil: sessionCacheActivity.holdUntil(
              options.streamOptions?.sessionId,
              route.id,
              Date.now(),
              getMaxSameAccountWait(storage),
            ),
          }).action === 'migrate'
        ) {
          return []
        }
        if (
          isKillswitchEnabled(storage) &&
          !killswitchPassesPolicy(
            route.quota,
            storage,
            route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ? undefined : route.id,
            modelId,
          )
        ) {
          return []
        }
        return [route.id]
      }),
    )
    const usableIds = new Set(usableFallbacks.map((account) => account.id))
    const candidates: StickyRouteCandidate[] = allRoutes.flatMap((route) => {
      const quota = quotaSnapshotHasStandardWindows(route.quota)
        ? route.quota
        : undefined
      const accountId =
        route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ? undefined : route.id
      const quotaState: QuotaState = quota
        ? { kind: 'known', quota }
        : { kind: 'unknown' }
      const passesKillswitch =
        !isKillswitchEnabled(storage) ||
        killswitchPassesPolicy(
          quotaState.kind === 'known' ? quotaState.quota : undefined,
          storage,
          accountId,
          modelId,
        )
      const passes =
        passesKillswitch &&
        (quotaState.kind === 'unknown' ||
          (quotaSnapshotPassesPolicy(quotaState.quota, storage) &&
            quotaSnapshotPassesModelScope(quotaState.quota, modelId) &&
            (route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ||
              usableIds.has(route.id))))
      return passes
        ? [
            {
              accountId: route.id,
              quota: quotaState,
              order: route.order,
            },
          ]
        : []
    })
    return { allRoutes, candidates, retainAccountIds }
  }

  async function primaryQuotaRefreshConfirmsExhausted() {
    await refreshRoutingSnapshot()
    if (!primaryAvailable() || !mainAccountId) return false
    try {
      const quota = await quotaManager.refreshMain(mainAccountId, '')
      const entry = quotaManager.getMain(mainAccountId)
      return Boolean(
        entry &&
          entry.refreshAfter > Date.now() &&
          quotaSnapshotIsExhausted(quota),
      )
    } catch {
      return false
    }
  }

  async function primaryQuotaRefreshConfirmsModelScopeExhausted() {
    await refreshRoutingSnapshot()
    if (!primaryAvailable()) return false
    try {
      const quota = await quotaManager.refreshMain(mainAccountId, '')
      const entry = quotaManager.getMain(mainAccountId)
      return Boolean(
        entry &&
          entry.refreshAfter > Date.now() &&
          quotaSnapshotModelScopeIsExhausted(quota, options.model.id),
      )
    } catch {
      return false
    }
  }

  function primaryCachedModelScopeExhausted() {
    if (!primaryAvailable()) return false
    const entry = quotaManager.getMain(mainAccountId)
    return Boolean(
      entry &&
        quotaSnapshotModelScopeIsExhausted(entry.quota, options.model.id),
    )
  }

  function primaryFreshModelScopeExhausted() {
    if (!primaryAvailable()) return false
    const entry = quotaManager.getMain(mainAccountId)
    return Boolean(
      entry &&
        !quotaManager.isMainStale(options.model.id) &&
        quotaSnapshotModelScopeIsExhausted(entry.quota, options.model.id),
    )
  }

  const refusedOAuth = new Set<string>()
  async function tryFallbackAccounts(
    routeOptions: { includeApiRoutes?: boolean; apiOnly?: boolean } = {},
  ) {
    const usableOAuth = await getUsableFallbackAccounts(storage, {
      modelId: options.model.id,
    })
    const usableOAuthById = new Map(
      usableOAuth.map((account) => [account.id, account]),
    )
    const fallbackQuota = (account: OAuthAccount) =>
      quotaManager.getFallback(account.id, account)?.quota ?? account.quota
    const oauthRoute = (configured: OAuthAccount) => {
      if (routeOptions.apiOnly || !nativeReady(configured.id)) return undefined
      const account = usableOAuthById.get(configured.id) ?? configured
      const quota = fallbackQuota(account)
      if (
        (!usableOAuthById.has(account.id) &&
          quotaSnapshotHasStandardWindows(quota)) ||
        (isKillswitchEnabled(storage) &&
          !killswitchPassesPolicy(quota, storage, account.id, options.model.id))
      )
        return undefined
      return account
    }
    // Reorder only eligible OAuth accounts, leaving paid API-key routes in place.
    const oauth = storage.accounts.flatMap((account) => {
      if (!nativeAccountCanServe(account) || !isOAuthAccount(account)) return []
      const route = oauthRoute(account)
      return route ? [[account.id, route] as const] : []
    })
    const oauthSlots = new Set(oauth.map(([id]) => id))
    const remainingOAuth = oauth.map(([, route]) => route)
    let sawPaidLaneRoute = false
    for (const configured of storage.accounts) {
      if (!nativeAccountCanServe(configured)) continue
      let response: Response | undefined
      let accountSent: string | undefined
      if (isOAuthAccount(configured)) {
        if (!oauthSlots.has(configured.id)) continue
        const warm = refusedOAuth.size
          ? sessionCacheActivity.warmRetryAccount(
              options.streamOptions?.sessionId,
              remainingOAuth.filter(
                (account) =>
                  !refusedOAuth.has(account.id) &&
                  !stickyQuotaBlockerInForce({
                    quota: fallbackQuota(account),
                    modelId: options.model.id,
                  }),
              ),
              (account) => account.id,
            )
          : undefined
        const [account] = remainingOAuth.splice(
          warm ? remainingOAuth.indexOf(warm) : 0,
          1,
        )
        if (!account) continue
        accountSent = account.id
        response = await sendAnthropicRequest({
          ...options,
          oauthAccountId: account.id,
        })
      } else if (routeOptions.includeApiRoutes) {
        const account = accountView(configured.id)
        if (
          !nativeAccountCanServe(account) ||
          account?.type !== 'api' ||
          !isValidApiBaseURL(account.baseURL)
        )
          continue
        if (options.laneStart) {
          // A paid route can end a lane start only if no OAuth route serves it.
          sawPaidLaneRoute = true
          continue
        }
        response = await sendAnthropicRequest({
          ...options,
          apiAccount: account,
        })
      }
      if (!response) continue
      const inspected = await firstStreamingError(response)
      const preflight = inspected.preflight
      if (preflight instanceof Response && preflight.ok) return preflight
      if (
        preflight instanceof Response &&
        !shouldFallbackStatus(preflight.status, storage)
      )
        return preflight
      if (accountSent) refusedOAuth.add(accountSent)
      await inspected.response.body?.cancel().catch(() => {})
    }
    return sawPaidLaneRoute ? skippedPaidLaneStart : null
  }

  const routingMode = getRoutingMode(storage)
  const routingRelay = routingState.relay
  const routingSessionId = options.streamOptions?.sessionId
  if (piForkHeadSession(options.streamOptions) && routingSessionId) {
    const signal = options.streamOptions?.signal
    // The account comes only from the shared routing answer for the fork's
    // session, which names the head's account (whose cache the fork reads).
    // Bypass local session-account assignments so neither the head nor the
    // fork moves.
    const advice = await raceWithSignal(
      signal,
      () =>
        (routingState.advice ??= routingRelay.accountFor(
          routingSessionId,
          options.model.id,
          routingCandidates(snapshot.accounts),
          {
            capacityWait: 'wait',
            signal,
            onCapacityWait: options.onCapacityWait,
          },
        )),
    )
    signal?.throwIfAborted()
    if (!advice) throw new PiForkRefusal('routing')
    const account = snapshot.accounts.find((candidate) =>
      routingChoiceMatches(advice, candidate),
    )
    if (!account || !nativeReady(account.id) || advice.hold)
      throw new PiForkRefusal('account')
    try {
      const inspected = await raceWithSignal(signal, async () =>
        firstStreamingError(
          await sendAnthropicRequest({
            ...options,
            oauthAccountId: account.id,
            expectedAccountIdentity: account.accountIdentity,
            routingChoice: advice,
          }),
        ),
      )
      signal?.throwIfAborted()
      const response =
        inspected.preflight instanceof Response
          ? inspected.preflight
          : inspected.response
      if (inspected.preflight instanceof Response && response.ok)
        return response
      if (response.status === 429) {
        let quota: OAuthQuotaSnapshot | undefined = quotaExhaustionFromHeaders(
          response.headers,
          options.model.id,
        )
        if (Object.keys(quota).length === 0) {
          try {
            quota = await raceWithSignal(signal, () =>
              account.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                ? quotaManager.refreshMain(mainAccountId, '')
                : quotaManager.refreshFallback(
                    account.id,
                    '',
                    storage.accounts.find(
                      (candidate) =>
                        candidate.id === account.id &&
                        isOAuthAccount(candidate),
                    ) as OAuthAccount | undefined,
                  ),
            )
          } catch {
            quota = undefined
          }
        }
        signal?.throwIfAborted()
        const decision = decideStickyQuotaFailure({
          quota,
          modelId: options.model.id,
          responseHeaders: response.headers,
          unconfirmedRetry: {
            counter: stickyQuotaRetries,
            sessionId: JSON.stringify([options.storagePath, routingSessionId]),
            turnId: String(
              options.context.messages.findLast(
                (message) => message.role === 'user',
              )?.timestamp ?? routingSessionId,
            ),
            accountId: account.id,
          },
        })
        if (decision.action === 'retain') {
          return hostRetryResponse(
            new Response(response.body, {
              status: 429,
              headers: stickyRetainRetryHeaders(response.headers),
            }),
          )
        }
        void response.body?.cancel().catch(() => {})
        throw new PiForkRefusal('limit')
      }
      void response.body?.cancel().catch(() => {})
      throw new PiForkRefusal('failed')
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof PiForkRefusal) throw error
      throw new PiForkRefusal('failed')
    }
  }
  if (routingSessionId && !routingState.advice) {
    routingState.advice = (async () => {
      const router = await getPiStickyRouter(options.storagePath)
      const assignment = await router.readAssignment(routingSessionId)
      return routingRelay.accountFor(
        routingSessionId,
        options.model.id,
        routingCandidates(snapshot.accounts),
        {
          capacityWait: 'wait',
          signal: options.streamOptions?.signal,
          onCapacityWait: options.onCapacityWait,
          warmCredentialId: routingWarmCredential(
            snapshot.accounts,
            assignment,
          ),
        },
      )
    })()
  }
  const advice = await routingState.advice
  let advisedAccountId = advice
    ? snapshot.accounts.find(
        (account) =>
          routingChoiceMatches(advice, account) && nativeReady(account.id),
      )?.id
    : undefined
  if (advice && !advisedAccountId)
    routingRelay.override(routingSessionId ?? '', 'account unavailable')
  if (
    (routingMode === 'sticky-balanced' || advisedAccountId) &&
    options.streamOptions?.sessionId
  ) {
    const sessionId = options.streamOptions.sessionId
    const router = await getPiStickyRouter(options.storagePath)
    const initialInputBytes = Math.max(
      1,
      Buffer.byteLength(JSON.stringify(options.context)),
    )
    let routes = await buildStickyRoutes(options.model.id)
    if (
      advisedAccountId &&
      !routes.allRoutes.some((route) => route.id === advisedAccountId)
    ) {
      routingRelay.override(sessionId, 'account unavailable')
      advisedAccountId = undefined
    }
    const mainPermanentlyUnavailable = !primaryAvailable()
    const incompleteQuotaPool =
      (routes.allRoutes.length === 0 && !mainPermanentlyUnavailable) ||
      routes.allRoutes.some(
        (candidate) =>
          !quotaObservationIsFresh(candidate.quota, options.model.id),
      )
    let resolution = await router.resolve({
      sessionId,
      family: stickyRouteFamilyForModel(options.model.id),
      modelId: options.model.id,
      affinityModelId: options.model.id,
      // Keep an existing route after a temporary quota poll failure, but do not
      // choose a new balanced route until the account pool has current quota data.
      candidates: advisedAccountId
        ? routes.allRoutes
            .filter((route) => route.id === advisedAccountId)
            .map((route) => ({
              accountId: route.id,
              order: route.order,
              quota: route.quota ?? { kind: 'unknown' as const },
            }))
        : incompleteQuotaPool
          ? []
          : routes.candidates,
      retainAccountIds: advisedAccountId
        ? new Set([advisedAccountId])
        : routes.retainAccountIds,
      ...(advisedAccountId && { routingAccountId: advisedAccountId }),
      accountIdentities: vaultAccountIdentities(),
      storage,
      inputBytes: initialInputBytes,
    })
    if (resolution?.migrated)
      clearPiStickyQuotaRetries(options.storagePath, sessionId)
    if (!resolution && incompleteQuotaPool) {
      const error = new Error(
        'Sticky-balanced routing is waiting for current OAuth quota snapshots',
      )
      Object.assign(error, {
        code: 'ECONNRESET',
        syscall: 'sticky-routing',
      })
      throw error
    }
    const noRouteResponse = async () => {
      if (snapshot.mode === 'claustrum')
        return createNativeVaultNoRouteResponse({
          snapshot: await native.view(
            options.streamOptions?.signal,
            options.model.id,
          ),
          modelId: options.model.id,
          sticky: true,
          sessionId,
          waitForReset: getWaitForReset(storage) && !advice,
        })
      return createStickyNoRouteResponse({
        mainRefreshError: storage?.refresh?.mainLastRefreshError,
        fallbackReauthLabels: getFallbackReauthLabels(storage),
        routeQuotas: routes.allRoutes.flatMap((route) =>
          route.quota ? [route.quota] : [],
        ),
        routeIdentities: routes.allRoutes
          .filter((route) => route.quota)
          .map((route) => accountView(route.id)?.accountIdentity),
        routeAccountIds: routes.allRoutes
          .filter((route) => route.quota)
          .map((route) => route.id),
        storage,
        sessionId,
        modelId: options.model.id,
        waitForReset: getWaitForReset(storage) && !advice,
      })
    }
    if (!resolution) return noRouteResponse()
    let route = routes.allRoutes.find(
      (candidate) => candidate.id === resolution?.accountId,
    )
    if (resolution && route) {
      const sendRoute = (selected: PiStickyRoute) =>
        sendAnthropicRequest({
          ...options,
          oauthAccountId: selected.id,
          routingChoice:
            selected.id === advisedAccountId
              ? (advice ?? undefined)
              : undefined,
          route: `sticky:${selected.id}`,
        })
      const completeRoute = async (
        _selected: PiStickyRoute,
        response: Response,
        _markUsed = true,
      ) => hostRetryResponse(response)
      const heldAccountId = route.id
      const heldAccountIdentity = accountView(route.id)?.accountIdentity
      const holdResponse = (
        retryAfterSeconds: number,
        upstream?: Headers,
        routingHold = false,
      ) => {
        const headers = new Headers(upstream)
        headers.set('content-type', 'application/json')
        headers.set(
          'retry-after',
          String(
            routingHold
              ? retryAfterSeconds
              : stickyRetryAfterWithJitter(sessionId, retryAfterSeconds),
          ),
        )
        return markPiAccountHold(
          new Response(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'rate_limit_error',
                message:
                  'Sticky OAuth account quota resets shortly; retaining session affinity.',
              },
            }),
            { status: 429, headers: hostRetryHeaders(headers) },
          ),
          {
            accountId: heldAccountId,
            accountIdentity: heldAccountIdentity,
            resetAt: Date.now() + retryAfterSeconds * 1000,
            reason: routingHold ? 'routing_hold' : 'account_limit',
          },
        )
      }
      if (advisedAccountId && advice?.hold)
        return holdResponse(
          Math.ceil(advice.hold.retry_after_ms / 1000),
          undefined,
          true,
        )
      const proactiveQuotaDecision =
        !advisedAccountId &&
        stickyQuotaSnapshotIsFresh(
          route.quota,
          storage,
          Date.now(),
          options.model.id,
        )
          ? decideStickyQuotaFailure({
              quota: route.quota,
              modelId: options.model.id,
              sessionId,
              holdUntil: sessionCacheActivity.holdUntil(
                sessionId,
                route.id,
                Date.now(),
                getMaxSameAccountWait(storage),
              ),
            })
          : undefined
      if (proactiveQuotaDecision?.action === 'hold')
        return holdResponse(proactiveQuotaDecision.retryAfterSeconds)

      const { response, preflight } = await firstStreamingError(
        await sendRoute(route),
      )
      if (preflight instanceof Response && preflight.ok) {
        return completeRoute(route, preflight)
      }

      const permanentAuthFailure =
        preflight instanceof Response && preflight.status === 401

      let retainedResponse: Response | undefined
      let migrate =
        (preflight instanceof Response && preflight.status === 403) ||
        permanentAuthFailure
      if (primaryResponseAllowsApiFallback(preflight)) {
        const responseHeaders =
          preflight instanceof Response ? preflight.headers : response.headers
        let quota: OAuthQuotaSnapshot | undefined = quotaExhaustionFromHeaders(
          responseHeaders,
          options.model.id,
        )
        // Do not extend the usage endpoint's own rate limit when the refusal
        // already confirms exhaustion.
        if (Object.keys(quota).length === 0) {
          try {
            quota =
              route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                ? await quotaManager.refreshMain(mainAccountId, '')
                : await quotaManager.refreshFallback(
                    route.id,
                    '',
                    route.account,
                  )
          } catch {
            // Retain affinity when the quota probe itself is unavailable.
            quota = undefined
          }
        }
        const decision = decideStickyQuotaFailure({
          quota,
          modelId: options.model.id,
          responseHeaders,
          sessionId,
          unconfirmedRetry: {
            counter: stickyQuotaRetries,
            sessionId: JSON.stringify([options.storagePath, sessionId]),
            turnId: String(
              options.context.messages.findLast(
                (message) => message.role === 'user',
              )?.timestamp ?? sessionId,
            ),
            accountId: route.id,
          },
          holdUntil: sessionCacheActivity.holdUntil(
            sessionId,
            route.id,
            Date.now(),
            getMaxSameAccountWait(storage),
          ),
        })
        if (decision.action === 'hold') {
          void response.body?.cancel().catch(() => {})
          return holdResponse(decision.retryAfterSeconds, responseHeaders)
        }
        if (decision.action === 'retain') {
          const now = Date.now()
          const headers = stickyRetainRetryHeaders(responseHeaders, now)
          const delayMs = Number(headers.get('retry-after-ms'))
          retainedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
          startRoutingWait({
            sessionId,
            reason: 'rate_limited',
            delayMs,
            nextMs: now + delayMs,
            attempt: stickyQuotaRetries.attempt(
              JSON.stringify([options.storagePath, sessionId]),
            ),
          })
        }
        migrate = decision.action === 'migrate'
      }

      if (migrate) {
        // A cancelled request must not move the session's account.
        await endIfCancelled(
          preflight instanceof Response ? preflight : response,
          options.streamOptions?.signal,
        )
        const failedRouteId = route.id
        routes = await buildStickyRoutes(options.model.id)
        if (
          routes.candidates.some(
            (candidate) => candidate.accountId !== failedRouteId,
          )
        ) {
          if (preflight instanceof Response) {
            await preflight.body?.cancel().catch(() => {})
          } else {
            await response.body?.cancel().catch(() => {})
          }
          resolution = await router.resolve({
            sessionId,
            family: stickyRouteFamilyForModel(options.model.id),
            modelId: options.model.id,
            candidates: routes.candidates,
            retainAccountIds: routes.retainAccountIds,
            accountIdentities: vaultAccountIdentities(),
            storage,
            inputBytes: initialInputBytes,
            excludeAccountIds: new Set([failedRouteId]),
            preferWarmRetryAccount: true,
          })
          const migrated = routes.allRoutes.find(
            (candidate) => candidate.id === resolution?.accountId,
          )
          if (resolution && migrated) {
            clearPiStickyQuotaRetries(options.storagePath, sessionId)
            route = migrated
            return completeRoute(route, await sendRoute(route))
          }
        }
        if (
          !(advice && !advisedAccountId) &&
          primaryResponseAllowsApiFallback(preflight) &&
          (await primaryQuotaRefreshConfirmsExhausted())
        ) {
          if (preflight instanceof Response) {
            await preflight.body?.cancel().catch(() => {})
          } else {
            await response.body?.cancel().catch(() => {})
          }
          const apiFallback = await tryFallbackAccounts({
            includeApiRoutes: true,
            apiOnly: true,
          })
          if (apiFallback) {
            clearPiStickyQuotaRetries(options.storagePath, sessionId)
            return apiFallback
          }
          routes = await buildStickyRoutes(options.model.id)
        }
      }
      if (
        primaryResponseAllowsApiFallback(preflight) &&
        routes.candidates.every(
          (candidate) =>
            stickyRouteCandidateWeight({
              candidate,
              family: stickyRouteFamilyForModel(options.model.id),
              modelId: options.model.id,
              storage,
            }) === 0,
        ) &&
        routes.allRoutes.length > 0 &&
        routes.allRoutes.every((candidate) =>
          quotaObservationIsFresh(candidate.quota, options.model.id),
        )
      ) {
        void response.body?.cancel().catch(() => {})
        if (preflight instanceof Response)
          void preflight.body?.cancel().catch(() => {})
        return noRouteResponse()
      }
      return completeRoute(
        route,
        retainedResponse ??
          (preflight instanceof Response ? preflight : response),
      )
    }
  }

  const fallbackFirst = routingMode === 'fallback-first'
  if (fallbackFirst) {
    const fallback = await tryFallbackAccounts()
    if (fallback) return fallback
  } else if (
    primaryFreshModelScopeExhausted() ||
    (primaryCachedModelScopeExhausted() &&
      (await primaryQuotaRefreshConfirmsModelScopeExhausted()))
  ) {
    const fallback = await tryFallbackAccounts()
    if (fallback) return fallback
  }

  if (!primaryAvailable()) {
    if (!fallbackFirst) {
      const fallback = await tryFallbackAccounts()
      if (fallback) return fallback
    }
    if (snapshot.mode === 'claustrum')
      return createNativeVaultNoRouteResponse({
        snapshot: await native.view(
          options.streamOptions?.signal,
          options.model.id,
        ),
        modelId: options.model.id,
        sessionId: options.streamOptions?.sessionId,
        waitForReset: getWaitForReset(storage) && !advice,
      })
    return createStickyNoRouteResponse({
      routeQuotas: (storage?.accounts ?? [])
        .filter(isOAuthAccount)
        .flatMap((account) => (account.quota ? [account.quota] : [])),
      routeIdentities: (storage?.accounts ?? [])
        .filter(isOAuthAccount)
        .filter((account) => account.quota)
        .map((account) => accountView(account.id)?.accountIdentity),
      routeAccountIds: (storage?.accounts ?? [])
        .filter(isOAuthAccount)
        .filter((account) => account.quota)
        .map((account) => account.id),
      storage,
      sessionId: options.streamOptions?.sessionId,
      modelId: options.model.id,
      waitForReset: getWaitForReset(storage) && !advice,
    })
  }

  if (isKillswitchEnabled(storage)) {
    let mainQuota = quotaManager.getMain(mainAccountId)?.quota
    if (!mainQuota || quotaManager.isMainStale(options.model.id)) {
      try {
        mainQuota = await quotaManager.refreshMain(
          mainAccountId,
          '',
          undefined,
          'admission',
        )
      } catch {}
    }
    if (
      !killswitchPassesPolicy(mainQuota, storage, undefined, options.model.id)
    ) {
      if (!fallbackFirst) {
        const fallback = await tryFallbackAccounts()
        if (fallback) return fallback
      }
      const current = await native.view(
        options.streamOptions?.signal,
        options.model.id,
      )
      return createQuotaRefusalResponse(
        'Killswitch blocked all OAuth routes',
        quotaRefusalTiming({
          readings: current.accounts
            .filter(
              (account) =>
                account.type === 'oauth' && nativeAccountCanServe(account),
            )
            .map((account) => ({
              quota: account.quota,
              accountIdentity: account.accountIdentity,
              accountId: account.id,
            })),
          storage: current.policyStorage,
          modelId: options.model.id,
          sessionId: options.streamOptions?.sessionId,
          waitForReset: getWaitForReset(current.policyStorage) && !advice,
          sessionTtlMs: sessionCacheActivity.ttlMs(
            options.streamOptions?.sessionId,
          ),
        }),
      )
    }
  }

  const { response: primary, preflight: primaryPreflight } =
    await firstStreamingError(
      await sendAnthropicRequest({
        ...options,
        oauthAccountId: STICKY_ROUTING_MAIN_ACCOUNT_ID,
      }),
    )
  if (primaryPreflight instanceof Response) {
    if (!shouldFallbackStatus(primaryPreflight.status, storage))
      return primaryPreflight
  }
  refusedOAuth.add(STICKY_ROUTING_MAIN_ACCOUNT_ID)

  const primaryAllowsQuotaFallback =
    primaryResponseAllowsApiFallback(primaryPreflight)
  const allowApiFallback =
    primaryAllowsQuotaFallback && (await primaryQuotaRefreshConfirmsExhausted())
  const allowModelScopedOAuthFallback =
    primaryAllowsQuotaFallback &&
    (await primaryQuotaRefreshConfirmsModelScopeExhausted())

  if (!fallbackFirst || allowApiFallback || allowModelScopedOAuthFallback) {
    const fallback = await tryFallbackAccounts({
      includeApiRoutes: allowApiFallback,
    })
    if (fallback) {
      if (primaryPreflight instanceof Response) {
        await primaryPreflight.body?.cancel().catch(() => {})
      }
      return fallback
    }
  }

  return primaryPreflight instanceof Response ? primaryPreflight : primary
}

export const __executePiWithFallbackForTest = executeWithFallback

export function streamCortexKitAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  effortTransitions?: readonly PiEffortTransition[],
  wait?: PiQuotaWaitOptions,
  requestOrigin: 'agent-loop' | 'direct' = 'direct',
  lookupServingModelCost?: (id: string) => Model<Api>['cost'] | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  let turn: CacheKeepRealTurn | undefined
  const noticeSession = options?.sessionId
  if (
    noticeSession &&
    wait?.setWorkingMessage &&
    requestOrigin === 'agent-loop' &&
    options?.maxTokens !== 1 &&
    options?.cacheRetention !== 'none' &&
    !piForkHeadSession(options)
  ) {
    roundNotices.set(noticeSession, wait.setWorkingMessage)
    const notice = piRefusalRoundStatus(noticeSession)
    if (notice) wait.setWorkingMessage(notice)
  }
  try {
    if (
      options?.sessionId &&
      !piForkHeadSession(options) &&
      !piRoundSideRequest(options, getPiAccountStoragePath(), requestOrigin)
    )
      turn = piCacheKeep.requestTurn(
        options.sessionId,
        rounds.hasRound(options.sessionId),
      )
  } catch {}

  void withCacheKeepRealTurn(turn, async () => {
    const output = createOutput(model)
    let failThread: (() => void) | undefined
    stream.push({ type: 'start', partial: output })

    try {
      buildPiOAuthMessagesUrl(model.baseUrl)
      const storagePath = getPiAccountStoragePath()
      const laneStart =
        requestOrigin === 'agent-loop' &&
        !piForkHeadSession(options) &&
        takePiLaneStart(context.messages, options?.sessionId)
      if (laneStart && options?.sessionId)
        observePiUserPrompt(storagePath, options.sessionId, true)
      let toolNames: ReadonlyMap<string, string> = new Map()
      let recordCacheUsage:
        | ((usage?: Record<string, number>) => void)
        | undefined
      let servingModel: string | undefined
      const setWorkingMessage = wait?.setWorkingMessage
      const request = {
        model,
        context,
        streamOptions: options,
        requestOrigin,
        laneStart,
        storagePath,
        onCapacityWait: setWorkingMessage
          ? () => {
              setWorkingMessage(
                'Waiting for a free account slot (Esc to cancel)',
              )
              return () =>
                setWorkingMessage(piRefusalRoundStatus(noticeSession))
            }
          : undefined,
        onThreadPrepared: (fail: () => void) => {
          failThread = fail
        },
        onCacheUsageRecorder: (
          record: (usage?: Record<string, number>) => void,
        ) => {
          recordCacheUsage = record
        },
        onServingModel: (model: string | undefined) => {
          servingModel = model
        },
        effortTransitions,
        onResolvedToolNames: (names: ReadonlyMap<string, string>) => {
          toolNames = names
        },
        // The last request built is the one sent; report only what it carried.
        onForkEffortApplied: (effort: PiForkEffortHint | undefined) => {
          const reply = output as typeof output & PiForkReplyReport
          if (effort) reply.cortexkitFork = { effortApplied: effort }
          else delete reply.cortexkitFork
        },
      }
      const routingState: {
        relay: ReturnType<typeof createRoutingRelay>
        advice?: Promise<RoutingChoice | undefined>
      } = { relay: createRoutingRelay() }
      Object.assign(request, { routingState })
      const response = await runWithRequestSignal(options?.signal, () =>
        withPiQuotaWait({
          signal: options?.signal,
          sessionId: options?.sessionId,
          wait: wait && {
            ...wait,
            setWorkingMessage:
              setWorkingMessage &&
              ((message) =>
                setWorkingMessage(
                  message ?? piRefusalRoundStatus(noticeSession),
                )),
          },
          run: () => executeWithFallback(request),
          resume: async (hold) => {
            const native = getPiNativeRuntime(storagePath)
            const before = await native.requestView(options?.signal, model.id)
            if (
              hold &&
              (!hold.accountIdentity ||
                before.accounts.find((account) => account.id === hold.accountId)
                  ?.accountIdentity !== hold.accountIdentity)
            )
              throw new Error(
                'The selected OAuth account changed while waiting.',
              )
            const runtime = await native.service()
            let heldStillBlocked = false
            for (const account of before.accounts) {
              if (
                account.type !== 'oauth' ||
                !nativeAccountCanServe(account) ||
                (hold && account.id !== hold.accountId)
              )
                continue
              options?.signal?.throwIfAborted()
              try {
                const quota = await runtime.fetchQuota(
                  account.id,
                  fetchPiOAuth,
                  options?.signal,
                  undefined,
                  'admission',
                )
                if (
                  hold &&
                  !routingState.relay.admitted(
                    options?.sessionId ?? '',
                    account,
                  ) &&
                  decideStickyQuotaFailure({ quota, modelId: model.id })
                    .action === 'migrate'
                )
                  heldStillBlocked = true
              } catch (error) {
                if (options?.signal?.aborted) throw error
              }
            }
            options?.signal?.throwIfAborted()
            if (heldStillBlocked)
              throw new Error(
                'The selected OAuth account cannot serve this request.',
              )
            if (!hold) return executeWithFallback(request)
            const inspected = await firstStreamingError(
              await sendAnthropicRequest({
                ...request,
                oauthAccountId: hold.accountId,
                expectedAccountIdentity: hold.accountIdentity,
                routingRelay: routingState.relay,
                routingChoice: (await routingState.advice) ?? undefined,
              }),
            )
            if (inspected.preflight instanceof Response)
              return inspected.preflight
            void inspected.response.body?.cancel().catch(() => {})
            return new Response(null, { status: 429 })
          },
        }),
      )

      if (response === skippedPaidLaneStart) {
        options?.signal?.throwIfAborted()
        output.content.push({
          type: 'text',
          text: 'Lane start skipped on a paid route.',
        })
        output.stopReason = 'stop'
        stream.push({ type: 'done', reason: 'stop', message: output })
        stream.end()
        return
      }
      if (!response.ok) {
        throw new Error(
          `Anthropic request failed: HTTP ${response.status} ${await response.text()}`,
        )
      }

      const blocks = output.content as Block[]
      const completion = createAnthropicStreamCompletion(response)
      for await (const event of parseSse(response, completion)) {
        if (event.type === 'message_start') {
          // Keep the requested model in the transcript so Pi replays signed
          // thinking on the next turn, even when Anthropic serves a fallback model.
          output.responseId = event.message?.id
          recordCacheUsage?.(event.message?.usage)
          updateUsage(model, output, event.message?.usage)
        } else if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block?.type === 'text') {
            output.content.push({
              type: 'text',
              text: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'text_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (block?.type === 'thinking') {
            output.content.push({
              type: 'thinking',
              // The server fallback rewriter emits marker text in the start frame.
              thinking:
                typeof block.thinking === 'string' ? block.thinking : '',
              thinkingSignature: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'thinking_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (block?.type === 'redacted_thinking') {
            output.content.push({
              type: 'thinking',
              thinking: '[Reasoning redacted]',
              thinkingSignature: String(block.data ?? ''),
              redacted: true,
              index: event.index,
            } as Block)
            stream.push({
              type: 'thinking_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          } else if (block?.type === 'tool_use') {
            output.content.push({
              type: 'toolCall',
              id: String(block.id),
              name: fromClaudeCodeToolName(String(block.name), toolNames),
              arguments: {},
              partialJson: '',
              index: event.index,
            } as Block)
            stream.push({
              type: 'toolcall_start',
              contentIndex: output.content.length - 1,
              partial: output,
            })
          }
        } else if (event.type === 'content_block_delta') {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          )
          const block = blocks[contentIndex]
          if (!block || !event.delta) continue
          if (event.delta.type === 'text_delta' && block.type === 'text') {
            const delta = String(event.delta.text ?? '')
            block.text += delta
            stream.push({
              type: 'text_delta',
              contentIndex,
              delta,
              partial: output,
            })
          } else if (
            event.delta.type === 'thinking_delta' &&
            block.type === 'thinking'
          ) {
            const delta = String(event.delta.thinking ?? '')
            block.thinking += delta
            stream.push({
              type: 'thinking_delta',
              contentIndex,
              delta,
              partial: output,
            })
          } else if (
            event.delta.type === 'signature_delta' &&
            block.type === 'thinking'
          ) {
            block.thinkingSignature = `${block.thinkingSignature ?? ''}${String(event.delta.signature ?? '')}`
          } else if (
            event.delta.type === 'input_json_delta' &&
            block.type === 'toolCall'
          ) {
            const delta = String(event.delta.partial_json ?? '')
            block.partialJson = `${block.partialJson ?? ''}${delta}`
            try {
              block.arguments = JSON.parse(block.partialJson)
            } catch {}
            stream.push({
              type: 'toolcall_delta',
              contentIndex,
              delta,
              partial: output,
            })
          }
        } else if (event.type === 'content_block_stop') {
          const contentIndex = blocks.findIndex(
            (block) => block.index === event.index,
          )
          const block = blocks[contentIndex]
          if (!block) continue
          delete block.index
          if (block.type === 'text') {
            stream.push({
              type: 'text_end',
              contentIndex,
              content: block.text,
              partial: output,
            })
          } else if (block.type === 'thinking') {
            stream.push({
              type: 'thinking_end',
              contentIndex,
              content: block.thinking,
              partial: output,
            })
          } else if (block.type === 'toolCall') {
            try {
              block.arguments = JSON.parse(block.partialJson ?? '{}')
            } catch {}
            delete block.partialJson
            stream.push({
              type: 'toolcall_end',
              contentIndex,
              toolCall: block,
              partial: output,
            })
          }
        } else if (event.type === 'message_delta') {
          recordCacheUsage?.(event.usage)
          output.stopReason = mapStopReason(
            String(event.delta?.stop_reason ?? ''),
          )
          const servingCost =
            servingModel && lookupServingModelCost?.(servingModel)
          if (servingModel && !servingCost)
            logger.warn(
              'pi',
              'Serving model has no Pi prices; using requested model rates',
              {
                requestedModel: model.id,
                servingModel,
              },
            )
          updateUsage(
            servingCost ? { ...model, cost: servingCost } : model,
            output,
            event.usage,
          )
          if (output.stopReason === 'error' && !output.errorMessage) {
            const stopReason =
              safeStopLabel(event.delta?.stop_reason) ?? 'unknown'
            const details = event.delta?.stop_details
            const category =
              stopReason === 'refusal' &&
              details !== null &&
              typeof details === 'object' &&
              'type' in details &&
              details.type === 'refusal' &&
              'category' in details
                ? safeStopLabel(details.category)
                : undefined
            // Provider explanations can echo the prompt; expose only bounded labels.
            output.errorMessage =
              stopReason === 'refusal'
                ? `Claude refused this request (stop_reason: refusal${category ? `, category: ${category}` : ''}).`
                : `Claude ended this request with an unsupported stop reason (stop_reason: ${stopReason}).`
            logger.warn(
              'pi',
              'Anthropic response ended with an error stop reason',
              {
                stopReason,
                ...(category ? { category } : {}),
                model: model.id,
                sessionId: options?.sessionId,
              },
            )
            failThread?.()
          }
        } else if (event.type === 'error') {
          throw new Error(JSON.stringify(event))
        }
      }

      if (options?.signal?.aborted) throw new Error('Request was aborted')
      const incomplete = completion.finish()
      if (incomplete) {
        const observer = dumpResponseObservers.get(response)
        observer?.fail(incomplete.diagnostics)
        await observer?.finish()
        throw incomplete
      }
      if (output.errorMessage) throw new Error(output.errorMessage)
      for (const block of output.content as Block[]) delete block.index
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      })
      stream.end()
    } catch (error) {
      failThread?.()
      for (const block of output.content as Block[]) delete block.index
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage =
        output.stopReason === 'error' &&
        isNativeTransientAccountError(error) &&
        error.poolRead
          ? 'Anthropic account service unavailable while an update is in progress; retry the request'
          : error instanceof Error
            ? error.message
            : String(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    } finally {
      piCacheKeep.finishTurn(turn)
    }
  })

  return stream
}
