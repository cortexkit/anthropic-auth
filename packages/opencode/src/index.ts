import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NativeRefreshFailure } from '@cortexkit/anthropic-auth-core'
import {
  type AccountCommandStatusProjection,
  type AccountStorage,
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  type ApiKeyAccount,
  acquireNativeAccountRuntime,
  applyCustomHeaders,
  assertNotCustodyTombstone,
  authorize,
  buildAccountList,
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
  buildPrimeRequestBody,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_HAIKU_5_5_CONTEXT_WINDOW,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING,
  CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
  CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_HAIKU_5_5_MODEL_ID,
  CLAUDE_HAIKU_5_5_PRICING,
  CLAUDE_HAIKU_5_5_RELEASE_DATE,
  CLAUDE_OPUS_5_5_CONTEXT_WINDOW,
  CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_OPUS_5_5_MODEL_ID,
  CLAUDE_OPUS_5_5_PRICING,
  CLAUDE_OPUS_5_5_RELEASE_DATE,
  CLAUDE_SONNET_5_5_CONTEXT_WINDOW,
  CLAUDE_SONNET_5_5_MAX_OUTPUT_TOKENS,
  CLAUDE_SONNET_5_5_MODEL_ID,
  CLAUDE_SONNET_5_5_PRICING,
  CLAUDE_SONNET_5_5_RELEASE_DATE,
  CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
  type CustodyStatusState,
  cacheKeepSourceWarmIdleCap,
  cacheWarmCacheablePrefixFingerprint,
  computeXxhash64Hex,
  configuredAnthropicOAuthAccountCount,
  createEmptyStorage,
  createNativeUsagePublisher,
  createNativeVaultNoRouteResponse,
  createProviderErrorResponseScope,
  createSseFramer,
  createStickyNoRouteResponse,
  custodyTombstoneOAuth,
  type DumpHandle,
  decideOpenCodeStateLayoutOnce,
  decideStickyQuotaFailure,
  decodeSseFrame,
  detectClaustrumConnection,
  dumpDirectRequest,
  dumpResponseArtifact,
  effectiveRelayStatus,
  exchange,
  executeAccountCommand,
  executeCache1hCommand,
  executeCacheKeepCommand,
  executeDumpCommand,
  executeFastModeCommand,
  executeKillswitchCommand,
  executeLaneStartCommand,
  executeLoggingCommand,
  executePrimeCommand,
  executeRoutingCommand,
  FALLBACK_BACKGROUND_TICK_MS,
  fallbackAccountUuidForLineage,
  formatEnrollmentStatus,
  formatNativeAccountState,
  formatOAuthAccountTier,
  formatQuotaBackoffMessage,
  formatRefreshBackoffMessage,
  getAccountStoragePath,
  getCache1hMode,
  getCache1hPersistentMode,
  getCacheKeepWindow,
  getClaudeCodeIdentityForVerifiedAccount,
  getClaudeModelCatalogue,
  getClaustrumMode,
  getDefaultCacheKeepRegistryDirectory,
  getFallbackReauthLabels,
  getHostClaustrumEnrollmentPaths,
  getKillswitchConfig,
  getPersistedLogLevel,
  getQuotaCheckIntervalMs,
  getQuotaNextRefreshAt,
  getRequestGzipLatch,
  getRequestGzipLatchPath,
  getRoutingMode,
  getScopedQuotaWindowForModel,
  getThinkingPrefixMismatchBehavior,
  type IdentityState,
  inspectNativeHostAuthEntry,
  isApiKeyAccount,
  isCache1hEnabled,
  isCache1hPersistentlyEnabled,
  isCacheKeepAlways,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isCacheKeepSubagentsEnabled,
  isClaudeFableOrMythos51Model,
  isClaudeOpus5Model,
  isClaudeOpus55Model,
  isCostZeroingEnabled,
  isCustodyTombstoneOAuth,
  isDumpPersistentlyEnabled,
  isFastModeEnabled,
  isFastModePersistentlyEnabled,
  isFastModeSupportedModel,
  isKillswitchEnabled,
  isNativeTransientAccountError,
  isOAuthAccount,
  isPermanentRefreshError,
  isPrimePersistentlyEnabled,
  isQuotaBearingHeaderFrame,
  isValidApiBaseURL,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  log,
  logger,
  mergeAnthropicBetas,
  mergeHeaderQuotaForPersistence,
  NativeAccountRefusal,
  type NativeAccountRuntimeOptions,
  type NativeAccountSnapshot,
  type NativeAccountView,
  type NativeCustodyClient,
  NativeCustodyError,
  type NativeCustodyReceipt,
  type NativeLocalCredentialValidation as NativeKnownCredentialSubject,
  type NativeMenuDispatch,
  type NativeQuotaObservation,
  NativeRuntimeError,
  type NativeUiOptions,
  NativeVaultNoAccountError,
  nativeAccountCanServe,
  nativeAccountPolicy,
  nativeAccountRefusal,
  nativeLocalAccountRefusal,
  nativeLocalQuotaLineage,
  nativeMigrationAuthorityPhase,
  normalizeQuotaHeaders,
  type OAuthAccount,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  oauthProfileIsFresh,
  oauthProfileMatchesIdentity,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  PrimeManager,
  type PrimeManagerOptions,
  type PrimeRefreshResult,
  type PrimeSendResult,
  type ProviderAccountUuid,
  type ProviderErrorResponseScope,
  parseAccountCommandAction,
  parseCache1hCommandAction,
  parseCacheKeepCommandAction,
  parseDumpCommandAction,
  parseFastModeCommandAction,
  parseLaneStartCommandAction,
  parseLoggingCommandAction,
  parsePrimeCommandAction,
  parseRoutingCommandAction,
  parseSseFrame,
  QUOTA_HEADER_FEED_SCHEMA_VERSION,
  type QuotaAccountSummary,
  type QuotaEntry,
  type QuotaHeaderFeedPublishEntry,
  QuotaHeaderFeedRegistry,
  QuotaManager,
  type QuotaManagerOptions,
  type QuotaReadingPurpose,
  type QuotaState,
  quotaExhaustionFromHeaders,
  quotaSnapshotCheckedAt,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  readClaustrumEnrollmentStatus,
  readNativeAccountsForRequest,
  readNativeEnrollmentMode,
  readNativeHostAuthKind,
  readNativeMigrationJournal,
  refreshBackoffActive,
  remapRequestBodyModel,
  resetClaustrumEnrollmentState,
  resolveClaudeModelCapabilities,
  resolveNativePoolPaths,
  STICKY_ROUTING_MAIN_ACCOUNT_ID,
  type StickyRouteCandidate,
  StickySessionRouter,
  sendViaRelay,
  sendWithRequestGzip,
  setCache1hState,
  setDumpEnabled,
  setFastModeEnabled,
  setLogLevel,
  shouldFallbackStatus,
  snapshotHasServableLocalOAuth,
  stateRefusalPublicMessage,
  stickyQuotaSnapshotIsFresh,
  stickyRouteFamilyForModel,
  TrailingAssistantHistoryError,
  tokenFingerprint,
  withAbortableFetch,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks, Plugin } from '@opencode-ai/plugin'
import type { Model as ProviderModelV2 } from '@opencode-ai/sdk/v2'
import {
  BILLING_LINEAGE_REQUEST_HEADER,
  BillingLineageTracker,
  extractAnthropicRequestId,
} from './billing-lineage.ts'
import {
  applyCacheDiagnosticsOptIn,
  buildCacheDiagnosticsRecord,
  CACHE_DIAGNOSTICS_BETA,
  CacheDiagnosticsBetaTracker,
  type CacheDiagnosticsRequestContext,
  type CacheDiagnosticsSource,
  CacheDiagnosticsTracker,
  copyCacheDiagnosticsContext,
  formatCacheDiagnosticsLogLine,
  summarizeCacheTtl,
  withStickyRetryAfter,
} from './cache-diagnostics.ts'
import {
  custodyStateFor,
  fallbackCustodyDimensions,
  isFallbackAccountVaultServed,
  mainCustodyDimension,
} from './custody-dimensions.ts'
import {
  CustodyStateMismatchError,
  reconcileCustodyStartup,
} from './custody-mode.ts'
import {
  EFFORT_PLAN_REQUEST_HEADER,
  EffortMarkerCorrelationError,
  markOpenCodeEffortTransitions,
  OpenCodeEffortPlanTracker,
} from './effort-history.ts'
import {
  FableFallbackManager,
  type FableFallbackPlan,
  type FableStandbyCacheAnchor,
  isRecoverableRefusalModel,
  parseSourceWarmTargetId,
  recoverableRefusalFamily,
  sourceWarmTargetId,
} from './fable-fallback.ts'
import {
  fireLaneStart,
  LANE_START_REQUEST_HEADER,
  LaneStartTracker,
} from './lane-start.ts'
import { createNativeCommand } from './native-command.js'
import {
  fetchOAuth,
  isAllowedOAuthDestination,
  requireOAuthDestination,
} from './oauth-destination.ts'
import { pluginTestHandles } from './plugin-test-handles.ts'
import { adoptPrimeManager } from './prime-manager-registry.ts'
import { resolvePromptContext } from './prompt-context.ts'
import { logFallbackQuotaPreflightWarning } from './quota-preflight.ts'
import {
  isAuxiliaryAgent,
  REQUEST_CLASS_REQUEST_HEADER,
  takeRequestClassHeader,
} from './request-class.ts'
import {
  formatKillswitchBlockMessage,
  resolveScopedDrivenBlock,
} from './request-policy.ts'
import {
  createRoutingRelay,
  routingChoiceMatches,
  routingReserveAllows,
} from './routing-relay.ts'
import {
  drainNotifications,
  isTuiConnected,
  missedTuiPickup,
  pushNotification,
  pushNotificationAwaitingPickup,
} from './rpc/notifications.ts'
import {
  type AccountDialogKnobs,
  type ApplyRequest,
  type ApplyResult,
  COMMAND_MODAL_NAMES,
  type CommandModalName,
  type OpenDialogPayload,
} from './rpc/protocol.ts'
import { getRpcDir } from './rpc/rpc-dir.ts'
import { startRpcServer } from './rpc/rpc-server.ts'
import {
  adoptRpcServer,
  type RpcServerAdoption,
} from './rpc/server-registry.ts'
import {
  resolveContentFilterFallbackMode,
  type ServerSideFallbackOutcome,
} from './server-fallback.ts'
import { getOpenCodeAuthPath } from './setup/paths.ts'
import {
  getInitialSidebarRoutingTestHooks,
  getSidebarState,
  getSidebarStateFile,
  type SidebarState,
  setSidebarState,
} from './sidebar-state.ts'
import {
  addFastModeBetaHeader,
  cancelUnsafeToolNameResponse,
  createStrippedStream,
  extractLatestHybridMessageCacheAnchor,
  hybridUserMessageCacheAnchorFingerprints,
  isInsecure,
  mergeHeaders,
  normalizeToolNameResponseError,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
  type ToolNameMap,
} from './transform.ts'

/** Dump label for a physical send that failed before any response arrived. */
const PHYSICAL_SEND_FAILED = 'physical send failed before a response'

const HANDLED_SENTINEL = '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__'
const HTTP_SERVER_RESPONSE_TYPE_ID = '~effect/http/HttpServerResponse'
const HTTP_COOKIES_TYPE_ID = '~effect/http/Cookies'
const HTTP_BODY_TYPE_ID = '~effect/http/HttpBody'
const ERROR_REPORTER_IGNORE = '~effect/ErrorReporter/ignore'
const PRIME_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

const localInvalidRequestResponses = new WeakSet<Response>()

function localInvalidRequestResponse(message: string): Response {
  const response = new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message,
      },
    }),
    {
      status: 400,
      headers: { 'content-type': 'application/json' },
    },
  )
  localInvalidRequestResponses.add(response)
  return response
}

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

// Selecting another account cannot repair a locally refused request.
// Provider-generated 400 responses still follow the configured fallbackOn list.
function shouldFallbackResponse(
  response: Response,
  storage: AccountStorage | null,
): boolean {
  return (
    (response.status !== 400 || !localInvalidRequestResponses.has(response)) &&
    shouldFallbackStatus(response.status, storage)
  )
}

function effortMarkerFailureResponse(
  error: EffortMarkerCorrelationError,
): Response {
  logger.warn(
    'effort-history',
    'refused uncorrelated per-message effort request',
    {
      check: error.check,
      ...error.details,
    },
  )
  return localInvalidRequestResponse(error.message)
}

// A request whose history ends on a meaningful assistant message is answered
// locally with a terminal 400 so the client shows the error instead of
// retrying, falling back to another account, or reaching the model.
function trailingAssistantHistoryFailureResponse(
  error: TrailingAssistantHistoryError,
): Response {
  logger.warn('transform', 'refused request ending on assistant history', {
    check: error.check,
    ...error.details,
  })
  return localInvalidRequestResponse(error.message)
}
const MAIN_AUTH_REFRESH_TICK_MS = 60_000
const MAIN_AUTH_REFRESH_TICK_JITTER_MS = 60_000
const MIN_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES = 240
const DEFAULT_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES =
  MIN_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES
const SIDEBAR_ROUTING_FRESH_MS = 10 * 60 * 1000

function hasEnabledOAuthAccount(
  storage: AccountStorage | null,
  activeId: string,
) {
  return (storage?.accounts ?? []).some(
    (account) =>
      account.id === activeId &&
      nativeAccountCanServe(account) &&
      isOAuthAccount(account),
  )
}

function deriveSidebarRouting(storage: AccountStorage | null): SidebarRouting {
  const firstFallback = (storage?.accounts ?? []).find(
    (account): account is OAuthAccount =>
      nativeAccountCanServe(account) && isOAuthAccount(account),
  )
  if (getRoutingMode(storage) === 'fallback-first' && firstFallback) {
    return { activeId: firstFallback.id, route: 'fallback-first' }
  }
  return { activeId: 'main', route: 'main' }
}

// `activeId` is optional on the state so a state without an active account
// carries no key at all; callers here always get one back.
type SidebarRouting = { activeId: string | undefined; route: string }

function validateSidebarRouting(
  routing: SidebarRouting | undefined,
  storage: AccountStorage | null,
): SidebarRouting {
  if (
    routing?.activeId === 'main' ||
    (routing?.activeId && hasEnabledOAuthAccount(storage, routing.activeId))
  ) {
    return { activeId: routing.activeId, route: routing.route }
  }
  return deriveSidebarRouting(storage)
}

function resolveLoadedSidebarRouting(
  existing: SidebarState,
  freshStorage: AccountStorage | null,
  fallbackRouting?: SidebarRouting,
): SidebarRouting {
  const existingAge = Date.now() - existing.lastUpdated
  if (
    !existing.activeId ||
    existingAge < 0 ||
    existingAge > SIDEBAR_ROUTING_FRESH_MS
  ) {
    return validateSidebarRouting(fallbackRouting, freshStorage)
  }

  return validateSidebarRouting(
    { activeId: existing.activeId, route: existing.route },
    freshStorage,
  )
}

async function resolveFreshSidebarRouting(
  existing: SidebarState,
  loadFreshStorage: () => Promise<AccountStorage | null>,
  fallbackRouting?: SidebarRouting,
): Promise<{
  activeId: string | undefined
  route: string
  freshStorage: AccountStorage | null
}> {
  let freshStorage: AccountStorage | null
  try {
    freshStorage = await loadFreshStorage()
  } catch (error) {
    logger.warn('sidebar', 'account storage reload failed; routing preserved', {
      message: error instanceof Error ? error.message : String(error),
    })
    const preservedRouting = existing.activeId
      ? { activeId: existing.activeId, route: existing.route }
      : (fallbackRouting ?? { activeId: 'main', route: 'main' })
    return { ...preservedRouting, freshStorage: null }
  }

  return {
    ...resolveLoadedSidebarRouting(existing, freshStorage, fallbackRouting),
    freshStorage,
  }
}

async function resolveInitialSidebarRouting(
  loadStorage: () => Promise<AccountStorage | null>,
): Promise<{
  activeId: string | undefined
  route: string
  freshStorage: AccountStorage | null
}> {
  await getInitialSidebarRoutingTestHooks()?.beforeStorageLoad?.()
  let freshStorage: AccountStorage | null
  try {
    freshStorage = await loadStorage()
  } catch {
    return { activeId: 'main', route: 'main', freshStorage: null }
  } finally {
    await getInitialSidebarRoutingTestHooks()?.afterStorageLoad?.()
  }

  await getInitialSidebarRoutingTestHooks()?.beforeSidebarRead?.()
  const existing = await getSidebarState()
  return {
    ...resolveLoadedSidebarRouting(existing, freshStorage),
    freshStorage,
  }
}

type NotificationRequest = {
  path: { id: string }
  body: {
    messageID?: string
    noReply: boolean
    parts: Array<{ type: 'text'; text: string; ignored: true }>
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }
}

type PluginSessionClient = {
  messages?: (input: {
    path: { id: string }
  }) =>
    | Promise<{ data?: unknown[] } | unknown[]>
    | { data?: unknown[] }
    | unknown[]
  prompt?: (input: NotificationRequest) => Promise<unknown> | unknown
  promptAsync?: (input: NotificationRequest) => Promise<unknown>
  status?: () => Promise<unknown> | unknown
}

const DESKTOP_NOTICE_PROBE_LIMIT = 4
const DESKTOP_NOTICE_PROBE_DELAY_MS = 25

type PerfTrace = {
  requestId: string
  start: number
  last: number
  mark: (stage: string, data?: Record<string, unknown>) => void
  done: (stage: string, data?: Record<string, unknown>) => void
}

let nextPerfRequestId = 1
let eventLoopLagMonitorStarted = false

function perfLoggingEnabled() {
  return process.env.OPENCODE_ANTHROPIC_AUTH_PERF === '1'
}

function nowMs() {
  return performance.now()
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10
}

function jitterMs(maxMs: number) {
  return Math.floor(Math.random() * Math.max(0, maxMs))
}

function fetchInputUrl(input: string | URL | Request) {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function fetchMethod(
  input: string | URL | Request,
  init: RequestInit | undefined,
) {
  return init?.method ?? (input instanceof Request ? input.method : undefined)
}

async function fetchBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<RequestInit['body']> {
  if (init?.body !== undefined) return init.body
  if (!(input instanceof Request) || input.body === null) return undefined
  try {
    return await input.clone().text()
  } catch {
    return undefined
  }
}

function startEventLoopLagMonitor() {
  if (
    eventLoopLagMonitorStarted ||
    process.env.NODE_ENV === 'test' ||
    !perfLoggingEnabled()
  ) {
    return
  }
  eventLoopLagMonitorStarted = true
  const intervalMs = 100
  const thresholdMs = 250
  let expected = nowMs() + intervalMs
  setInterval(() => {
    const current = nowMs()
    const lag = current - expected
    expected = current + intervalMs
    if (lag < thresholdMs) return
    log('[perf] opencode event_loop_lag', {
      lagMs: roundMs(lag),
      thresholdMs,
    })
  }, intervalMs).unref?.()
}

function createPerfTrace(data?: Record<string, unknown>): PerfTrace {
  const start = nowMs()
  const trace: PerfTrace = {
    requestId: String(nextPerfRequestId++),
    start,
    last: start,
    mark(stage, stageData) {
      const current = nowMs()
      if (perfLoggingEnabled()) {
        log('[perf] opencode request stage', {
          requestId: trace.requestId,
          stage,
          deltaMs: roundMs(current - trace.last),
          totalMs: roundMs(current - trace.start),
          ...stageData,
        })
      }
      trace.last = current
    },
    done(stage, stageData) {
      const current = nowMs()
      if (perfLoggingEnabled()) {
        log('[perf] opencode request done', {
          requestId: trace.requestId,
          stage,
          deltaMs: roundMs(current - trace.last),
          totalMs: roundMs(current - trace.start),
          ...stageData,
        })
      }
      trace.last = current
    },
  }
  if (perfLoggingEnabled()) {
    log('[perf] opencode request start', {
      requestId: trace.requestId,
      ...data,
    })
  }
  return trace
}

function notificationMessageIdBeforeAssistant(
  latestAssistantMessageId: string,
  latestUserMessageId?: string,
) {
  const match = /^msg_([0-9a-fA-F]{12})/.exec(latestAssistantMessageId)
  if (!match) return undefined
  const encoded = BigInt(`0x${match[1]}`)
  if (encoded <= 0n) return undefined
  const previous = (encoded - 1n).toString(16).padStart(12, '0')
  const candidate = `msg_${previous}${'z'.repeat(14)}`
  // A previous ignored notice is itself a user message. Extend that lower
  // bound rather than falling back to a host-assigned (post-assistant) ID.
  const ordered =
    latestUserMessageId && candidate <= latestUserMessageId
      ? `${latestUserMessageId}z`
      : candidate
  // Bound repeated suffix growth and fail closed for incompatible host IDs.
  if (ordered.length > 128 || ordered >= latestAssistantMessageId) {
    return undefined
  }
  return ordered
}

async function sendIgnoredMessage(
  ctx: Parameters<Plugin>[0],
  sessionId: string,
  text: string,
  options: {
    noReply?: boolean
    beforeActiveAssistant?: boolean
    canSend?: () => boolean
    onPreparedMessageId?: (messageId: string) => void
    latestPreparedMessageId?: () => string | undefined
  } = {},
): Promise<boolean> {
  const session = ctx.client.session as PluginSessionClient | undefined
  const promptContext = await resolvePromptContext(ctx.client, sessionId)
  const request: NotificationRequest = {
    path: { id: sessionId },
    body: {
      noReply: options.noReply ?? true,
      parts: [{ type: 'text', text, ignored: true }],
    },
  }
  if (options.beforeActiveAssistant) {
    const preparedId = options.latestPreparedMessageId?.()
    const userId = promptContext?.latestUserMessageId
    const lowerBound =
      preparedId && (!userId || preparedId > userId) ? preparedId : userId
    const messageID = promptContext?.latestAssistantMessageId
      ? notificationMessageIdBeforeAssistant(
          promptContext.latestAssistantMessageId,
          lowerBound,
        )
      : undefined
    // Never let the host mint a newer user ID for a desktop notice: it can
    // become pending work. Retain the notice for a later safe boundary instead.
    if (!messageID) return false
    request.body.messageID = messageID
  }
  if (promptContext?.agent) request.body.agent = promptContext.agent
  if (promptContext?.model) request.body.model = promptContext.model
  if (promptContext?.variant) request.body.variant = promptContext.variant

  // Resolving the active prompt context crosses the OpenCode process boundary.
  // A new user prompt can start while that request is in flight, so re-check the
  // caller's delivery lease immediately before inserting the ignored message.
  if (options.canSend && !options.canSend()) return false
  if (request.body.messageID) {
    options.onPreparedMessageId?.(request.body.messageID)
  }

  if (typeof session?.promptAsync === 'function') {
    await session.promptAsync(request)
    return true
  }

  if (typeof session?.prompt === 'function') {
    await Promise.resolve(session.prompt(request))
    return true
  }

  throw new Error(
    'OpenCode session prompt API is unavailable for ignored replies.',
  )
}

function cleanAbort(): never {
  // OpenCode has no return value that says "this slash command was handled"
  // in command.execute.before, so the plugin throws. Older hosts only see an
  // Error. OpenCode 1.17+ recognises the fields below as Effect's empty HTTP
  // response (status 204, body tag `Empty`) and answers the command with no
  // content; the reporter-ignore marker keeps Effect's error reporter from
  // logging the handled command as a plugin failure.
  // The fields are set while the error is built rather than assigned
  // afterwards, because Effect's typing of the global Error makes the
  // reporter-ignore marker read-only.
  const sentinel = Object.assign(new Error(HANDLED_SENTINEL), {
    [HTTP_SERVER_RESPONSE_TYPE_ID]: HTTP_SERVER_RESPONSE_TYPE_ID,
    [ERROR_REPORTER_IGNORE]: true,
    status: 204,
    statusText: undefined,
    headers: {},
    cookies: {
      [HTTP_COOKIES_TYPE_ID]: HTTP_COOKIES_TYPE_ID,
      cookies: {},
    },
    body: { [HTTP_BODY_TYPE_ID]: HTTP_BODY_TYPE_ID, _tag: 'Empty' },
  })
  throw sentinel
}

function shouldInjectParallelToolPrompt(input: {
  sessionID?: string
  model?: { providerID?: string; api?: { npm?: string } }
}) {
  if (input.sessionID == null) return false
  const model = input.model
  return (
    model?.providerID === 'anthropic' ||
    model?.api?.npm === '@ai-sdk/anthropic' ||
    model?.api?.npm === '@ai-sdk/google-vertex/anthropic'
  )
}

function appendParallelToolPrompt(system: string[]) {
  if (system.some((entry) => entry.includes('<use_parallel_tool_calls>'))) {
    return false
  }
  system.push(PARALLEL_TOOL_CALLS_SYSTEM_PROMPT)
  return true
}

const ZERO_MODEL_COST = {
  input: 0,
  output: 0,
  cache: { read: 0, write: 0 },
}

type FableRequestContext = {
  plan: FableFallbackPlan
  oauthAccountId?: string
  serverFallback?: boolean
  opusCacheAnchor?: FableStandbyCacheAnchor
  standbyBridgeLogged?: boolean
  subagent?: boolean
}

type StickyOAuthRoute = {
  id: string
  access?: string
  quota?: OAuthQuotaSnapshot
  identity: IdentityState
  order: number
  account?: OAuthAccount
  scoped?: boolean
}

type MainQuotaIdentityBinding = {
  quotaKey: string | undefined
  providerAccountUuid?: ProviderAccountUuid
  generation: number
  routingLineage?: string
}

type MainQuotaIdentityResolution = MainQuotaIdentityBinding & {
  providerAccountUuid: ProviderAccountUuid | undefined
  stale: boolean
  state: CustodyStatusState
}

const HEADER_ROUTING_OBSERVATION_LIMIT = 1000

type HeaderRoutingObservation = NativeQuotaObservation

type ServedQuotaHeaders = {
  accountId: 'main' | string
  accessToken: string
  authLineageId?: string
  anthropicAccountUuid?: ProviderAccountUuid | null
  mainQuotaIdentity?: MainQuotaIdentityBinding
  localSubject?: NativeKnownCredentialSubject
  scopedAttempt?: NativeCustodyReceipt
}

function asProviderAccountUuid(
  value: string | null | undefined,
): ProviderAccountUuid | undefined {
  return value as ProviderAccountUuid | undefined
}

/**
 * Compose the recovery-window notice text for the requested model. Fable 5 and
 * Opus 5 follow the same Anthropic-recommended fallback (Opus 4.8) for the
 * same reason (cyber safety classifiers returning `stop_reason: "refusal"`),
 * so the message structure is shared; only the model name moves.
 */
function buildSwitchedToOpusNotice(modelId: string, remaining: number): string {
  const label = fallbackModelLabel(modelId)
  return `${label} content filter detected. Switched to Opus 4.8 for a ${remaining}-response recovery window before trying ${label} again.`
}

function buildRestoredNotice(modelId: string): string {
  const label = fallbackModelLabel(modelId)
  return `${label} recovery window complete. Returning to ${label}.`
}

function fallbackModelLabel(modelId: string): string {
  if (isClaudeOpus55Model(modelId)) return 'Opus 5.5'
  if (isClaudeOpus5Model(modelId)) return 'Opus 5'
  if (isClaudeFableOrMythos51Model(modelId)) {
    if (modelId.startsWith('claude-mythos-5-1')) return 'Mythos 5.1'
    if (modelId.startsWith('claude-fable-5-1')) return 'Fable 5.1'
  }
  if (modelId === 'claude-fable-5' || modelId.startsWith('claude-fable-5-'))
    return 'Fable 5'
  if (modelId === 'claude-opus-4-8' || modelId.startsWith('claude-opus-4-8-')) {
    return 'Opus 4.8'
  }
  return modelId
}

function buildServerFallbackNotice(
  requestedModelId: string,
  targetModelId: string,
): string {
  return `Anthropic safety fallback active: ${fallbackModelLabel(requestedModelId)} → ${fallbackModelLabel(targetModelId)}. Follow-up requests may remain on the fallback model for about one hour.`
}

function buildServerRestoredNotice(requestedModelId: string): string {
  return `Anthropic safety fallback ended. Returning to ${fallbackModelLabel(requestedModelId)}.`
}

type AnthropicProviderModel = {
  id?: string
  name?: string
  api?: { id?: string; [key: string]: unknown }
  cost?: unknown
  limit?: { context?: number; output?: number; [key: string]: unknown }
  capabilities?: Record<string, unknown>
  release_date?: string
  [key: string]: unknown
}

function haiku55ModelCost(): ProviderModelV2['cost'] {
  return {
    input: CLAUDE_HAIKU_5_5_PRICING.input,
    output: CLAUDE_HAIKU_5_5_PRICING.output,
    cache: {
      read: CLAUDE_HAIKU_5_5_PRICING.cacheRead,
      write: CLAUDE_HAIKU_5_5_PRICING.cacheWrite5m,
    },
    tiers: [
      {
        tier: {
          type: 'context',
          size: CLAUDE_HAIKU_5_5_LONG_CONTEXT_THRESHOLD,
        },
        input: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.input,
        output: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.output,
        cache: {
          read: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.cacheRead,
          write: CLAUDE_HAIKU_5_5_LONG_CONTEXT_PRICING.cacheWrite5m,
        },
      },
    ],
  }
}

function addNativeClaudeModels<
  T extends Record<string, AnthropicProviderModel>,
>(models: T) {
  const base =
    models['claude-opus-4-8'] ??
    models['claude-opus-4-5'] ??
    Object.values(models)[0]
  if (!base) return models

  return {
    ...models,
    ...Object.fromEntries(
      Object.values(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS).map((spec) => {
        const catalogue = getClaudeModelCatalogue(spec.id)
        const pricing = catalogue.pricing
        return [
          spec.id,
          {
            ...base,
            id: spec.id,
            name: spec.name,
            api: base.api ? { ...base.api, id: spec.id } : undefined,
            cost: {
              input: pricing.input,
              output: pricing.output,
              cache: {
                read: pricing.cacheRead,
                write: pricing.cacheWrite5m,
              },
            },
            limit: {
              ...(base.limit ?? {}),
              context: catalogue.contextWindow,
              output: catalogue.maxOutputTokens,
            },
            capabilities: {
              ...(base.capabilities ?? {}),
              reasoning: true,
              attachment: true,
              toolcall: true,
            },
            release_date: catalogue.releaseDate,
          },
        ]
      }),
    ),
    ...(models[CLAUDE_HAIKU_5_5_MODEL_ID]
      ? {}
      : {
          [CLAUDE_HAIKU_5_5_MODEL_ID]: {
            ...base,
            id: CLAUDE_HAIKU_5_5_MODEL_ID,
            name: 'Claude Haiku 5.5',
            api: base.api
              ? { ...base.api, id: CLAUDE_HAIKU_5_5_MODEL_ID }
              : undefined,
            cost: haiku55ModelCost(),
            limit: {
              ...(base.limit ?? {}),
              context: CLAUDE_HAIKU_5_5_CONTEXT_WINDOW,
              output: CLAUDE_HAIKU_5_5_MAX_OUTPUT_TOKENS,
            },
            capabilities: {
              ...(base.capabilities ?? {}),
              reasoning: true,
              attachment: true,
              toolcall: true,
            },
            release_date: CLAUDE_HAIKU_5_5_RELEASE_DATE,
            variants: createNativeAdaptiveEffortVariants(),
          },
        }),
    ...(models[CLAUDE_SONNET_5_5_MODEL_ID]
      ? {}
      : {
          [CLAUDE_SONNET_5_5_MODEL_ID]: {
            ...base,
            id: CLAUDE_SONNET_5_5_MODEL_ID,
            name: 'Claude Sonnet 5.5',
            api: base.api
              ? { ...base.api, id: CLAUDE_SONNET_5_5_MODEL_ID }
              : undefined,
            cost: {
              input: CLAUDE_SONNET_5_5_PRICING.input,
              output: CLAUDE_SONNET_5_5_PRICING.output,
              cache: {
                read: CLAUDE_SONNET_5_5_PRICING.cacheRead,
                write: CLAUDE_SONNET_5_5_PRICING.cacheWrite5m,
              },
            },
            limit: {
              ...(base.limit ?? {}),
              context: CLAUDE_SONNET_5_5_CONTEXT_WINDOW,
              output: CLAUDE_SONNET_5_5_MAX_OUTPUT_TOKENS,
            },
            capabilities: {
              ...(base.capabilities ?? {}),
              reasoning: true,
              attachment: true,
              toolcall: true,
            },
            release_date: CLAUDE_SONNET_5_5_RELEASE_DATE,
            variants: createNativeAdaptiveEffortVariants(),
          },
        }),
    ...(models[CLAUDE_OPUS_5_5_MODEL_ID]
      ? {}
      : {
          [CLAUDE_OPUS_5_5_MODEL_ID]: {
            ...base,
            id: CLAUDE_OPUS_5_5_MODEL_ID,
            name: 'Claude Opus 5.5',
            api: base.api
              ? { ...base.api, id: CLAUDE_OPUS_5_5_MODEL_ID }
              : undefined,
            cost: {
              input: CLAUDE_OPUS_5_5_PRICING.input,
              output: CLAUDE_OPUS_5_5_PRICING.output,
              cache: {
                read: CLAUDE_OPUS_5_5_PRICING.cacheRead,
                write: CLAUDE_OPUS_5_5_PRICING.cacheWrite5m,
              },
            },
            limit: {
              ...(base.limit ?? {}),
              context: CLAUDE_OPUS_5_5_CONTEXT_WINDOW,
              output: CLAUDE_OPUS_5_5_MAX_OUTPUT_TOKENS,
            },
            capabilities: {
              ...(base.capabilities ?? {}),
              reasoning: true,
              attachment: true,
              toolcall: true,
            },
            release_date: CLAUDE_OPUS_5_5_RELEASE_DATE,
            variants: createNativeAdaptiveEffortVariants(),
          },
        }),
  } as T
}

const CLAUDE_NATIVE_ADAPTIVE_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

function createNativeAdaptiveEffortVariants(
  efforts: readonly string[] = CLAUDE_NATIVE_ADAPTIVE_EFFORTS,
) {
  return Object.fromEntries(
    efforts.map((effort) => [
      effort,
      {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort,
      },
    ]),
  )
}

function applyNativeAdaptiveEffortVariants<
  T extends Record<string, AnthropicProviderModel>,
>(models: T) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => {
      const modelId = model.api?.id ?? model.id ?? id
      const efforts = resolveClaudeModelCapabilities(modelId)?.efforts.variants
      return [
        id,
        efforts
          ? { ...model, variants: createNativeAdaptiveEffortVariants(efforts) }
          : model,
      ]
    }),
  ) as T
}

function zeroModelCosts<T extends Record<string, AnthropicProviderModel>>(
  models: T,
) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => [
      id,
      { ...model, cost: ZERO_MODEL_COST },
    ]),
  ) as T
}

/**
 * How long /claude waits for an OpenCode 1 TUI to take its menu when that
 * session's TUI has not polled recently. The plugin's TUI part polls every
 * 500 ms while a session is open, so a TUI that has just started or just opened
 * the session answers well within this. No answer means no TUI took the menu
 * in time: the TUI part is not loaded, or not showing this session.
 */
const CLAUDE_MENU_TUI_PICKUP_MS = 2_000

/**
 * The plugin's own `name@version`, read once from its package.json, which sits
 * one directory above both src/index.ts and the bundled dist/index.js. When
 * the file is missing or belongs to another package, the name is used alone.
 */
const OPENCODE_PACKAGE_NAME = '@cortexkit/opencode-anthropic-auth'
let pluginPackageEntry: string | undefined
function readPluginPackageEntry(): string {
  if (pluginPackageEntry !== undefined) return pluginPackageEntry
  pluginPackageEntry = OPENCODE_PACKAGE_NAME
  try {
    const manifest = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
        'utf8',
      ),
    ) as { name?: unknown; version?: unknown }
    if (
      manifest.name === OPENCODE_PACKAGE_NAME &&
      typeof manifest.version === 'string' &&
      manifest.version.trim()
    )
      pluginPackageEntry = `${OPENCODE_PACKAGE_NAME}@${manifest.version.trim()}`
  } catch {
    // Keep the bare package name.
  }
  return pluginPackageEntry
}

/**
 * Leads the text reply the first time /claude finds no TUI in a session.
 * OpenCode 1 loads a plugin's terminal UI only from tui.json/tui.jsonc,
 * separately from opencode.json, so a plugin added by editing opencode.json
 * alone has a working server side and no menu; docs/sidebar.md describes the
 * entry. OpenCode Desktop cannot load TUI plugins at all, so the text has to
 * be true there too. Not exported: this module keeps its plugin as its only
 * export, because OpenCode 1 loads the exports of a plugin's entry module as
 * plugins.
 */
function claudeMenuNoTuiNotice(): string {
  return [
    "The Claude menu opens in OpenCode's terminal window when the plugin's TUI part is loaded.",
    `In the terminal, add "${readPluginPackageEntry()}" to the plugin list in tui.json (or rerun setup), then restart OpenCode.`,
    'In OpenCode Desktop, use the text menu below.',
  ].join('\n')
}

/**
 * OpenCode Desktop starts its server with OPENCODE_CLIENT=desktop, and the
 * plugin runs in that server process. Desktop cannot load TUI plugins, so
 * /claude there answers in text at once, without waiting for a TUI.
 */
function isOpenCodeDesktop(): boolean {
  return process.env.OPENCODE_CLIENT === 'desktop'
}

type PluginRuntimeOverrides = Partial<{
  authorize: typeof authorize
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  scopedRosterPollIntervalMs: number
  claustrumScopedConnect: () => Promise<NativeCustodyClient>
  nativeLocal: NativeAccountRuntimeOptions['local']
  cacheKeepAggregateRefreshIntervalMs: number
  /** Replaces the real-time wait between physical quota usage calls. */
  quotaCallPause: QuotaManagerOptions['pauseBetweenQuotaCalls']
  /** How long /claude waits for a TUI to take its menu; see CLAUDE_MENU_TUI_PICKUP_MS. */
  tuiPickupTimeoutMs: number
}>

function getConfiguredClaustrumConnectionFile(): string | undefined {
  const configured =
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE?.trim() ||
    process.env.CLAUSTRUM_SUBC_CONNECTION?.trim()
  return configured || undefined
}

const anthropicAuthPlugin = async (
  ctx: Parameters<Plugin>[0],
  runtimeOverrides: PluginRuntimeOverrides = {},
) => {
  const runtimeTimers = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    ...runtimeOverrides,
  }
  const authorizeImpl = runtimeOverrides.authorize ?? authorize
  startEventLoopLagMonitor()
  const { client } = ctx
  const profileFetch = globalThis.fetch
  const accountStoragePath = getAccountStoragePath()
  const requestGzipLatch = getRequestGzipLatch(
    getRequestGzipLatchPath(accountStoragePath),
  )

  // -- OAuth add-flow pending state (Add account modal) --------------------
  interface OAuthPendingEntry {
    state: string
    verifier: string
    redirectUri: string
    createdAt: number
  }
  const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000 // 10 minutes
  const OAUTH_PENDING_CAP = 50
  const oauthPending = new Map<string, OAuthPendingEntry>()

  function cleanupExpiredOAuthPending() {
    const now = Date.now()
    for (const [sessionId, entry] of oauthPending) {
      if (now - entry.createdAt > OAUTH_PENDING_TTL_MS) {
        oauthPending.delete(sessionId)
      }
    }
  }

  function storeOAuthPending(
    sessionId: string,
    entry: OAuthPendingEntry,
  ): void {
    cleanupExpiredOAuthPending()
    if (oauthPending.size >= OAUTH_PENDING_CAP) {
      let oldestSession = ''
      let oldestTime = Infinity
      for (const [sid, e] of oauthPending) {
        if (e.createdAt < oldestTime) {
          oldestTime = e.createdAt
          oldestSession = sid
        }
      }
      if (oldestSession) oauthPending.delete(oldestSession)
    }
    oauthPending.set(sessionId, entry)
  }

  function takeOAuthPending(sessionId: string): OAuthPendingEntry | undefined {
    cleanupExpiredOAuthPending()
    const entry = oauthPending.get(sessionId)
    if (!entry) return undefined
    if (Date.now() - entry.createdAt > OAUTH_PENDING_TTL_MS) {
      oauthPending.delete(sessionId)
      return undefined
    }
    return entry
  }

  // Decide where this process keeps the account state before any pool path
  // is resolved: the config folder, or the state folder once it has moved
  // there. The decision also records that this process uses those files, so
  // a later version never moves them while it runs. It is made once per
  // process; a re-initialised plugin gets the same answer without a lock.
  let stateLayout: Awaited<ReturnType<typeof decideOpenCodeStateLayoutOnce>>
  try {
    stateLayout = await decideOpenCodeStateLayoutOnce({
      role: 'opencode1',
      onLockEvent: runtimeOverrides.nativeLocal?.onLockEvent,
    })
  } catch (error) {
    // The refusal names no folder on screen; the log line names them.
    const message = stateRefusalPublicMessage(error)
    if (message) throw new Error(message, { cause: error })
    throw error
  }
  const nativePaths = await resolveNativePoolPaths(
    accountStoragePath,
    undefined,
    stateLayout.layout,
  )
  const holderRegistration =
    stateLayout.kind === 'state-home' ? undefined : stateLayout.registration
  const nativeAccounts = acquireNativeAccountRuntime({
    paths: nativePaths,
    host: 'opencode',
    local: runtimeOverrides.nativeLocal,
    vault: runtimeOverrides.claustrumScopedConnect
      ? { connect: runtimeOverrides.claustrumScopedConnect }
      : undefined,
  })
  // Header and poll readings share the native account/epoch-fenced overlay.
  const headerRoutingObservations = nativeAccounts.quotaObservations
  let headerRoutingPolicyStorage: AccountStorage | null = null
  function localHeaderRoutingLineage(binding: NativeAccountView['binding']) {
    return nativeLocalQuotaLineage(binding)
  }
  function headerRoutingLineage(
    subject: NativeKnownCredentialSubject | undefined,
    receipt?: NativeCustodyReceipt,
  ) {
    return subject
      ? localHeaderRoutingLineage(subject.binding)
      : receipt
        ? JSON.stringify([
            receipt.credentialId,
            receipt.accountIdentity,
            receipt.recordVersion,
          ])
        : undefined
  }
  function currentHeaderRoutingObservation(
    accountId: string,
    lineage: string | undefined,
    accountUuid: string | undefined,
    storage: AccountStorage | null = headerRoutingPolicyStorage,
  ) {
    const observation = headerRoutingObservations.get(accountId)
    if (
      !observation ||
      !lineage ||
      observation.lineage !== lineage ||
      observation.accountUuid !== accountUuid ||
      getQuotaNextRefreshAt(
        observation.entry.quota,
        storage,
        observation.entry.checkedAt,
      ) <= Date.now()
    )
      return undefined
    return observation
  }
  function routingQuotaEntry(
    accountId: string,
    lineage: string | undefined,
    accountUuid: string | undefined,
    committed: QuotaEntry | null | undefined,
    storage: AccountStorage | null = headerRoutingPolicyStorage,
  ) {
    const observation = currentHeaderRoutingObservation(
      accountId,
      lineage,
      accountUuid,
      storage,
    )
    if (!observation) return committed
    if (!committed)
      return {
        ...observation.entry,
        refreshAfter: getQuotaNextRefreshAt(
          observation.entry.quota,
          storage,
          observation.entry.checkedAt,
        ),
      }
    const quota =
      observation.entry.quota.source !== 'headers' &&
      quotaSnapshotCheckedAt(committed.quota) >
        quotaSnapshotCheckedAt(observation.entry.quota)
        ? committed.quota
        : mergeHeaderQuotaForPersistence(
            committed.quota,
            observation.entry.quota,
          )
    return {
      ...observation.entry,
      quota,
      refreshAfter: getQuotaNextRefreshAt(
        quota,
        storage,
        quotaSnapshotCheckedAt(quota),
      ),
    }
  }
  function routingAccountQuota(
    account: NativeAccountView,
    storage: AccountStorage,
    receipt?: NativeCustodyReceipt,
  ) {
    if (!headerRoutingObservations.has(account.id)) return account.quota
    const lineage = account.binding
      ? localHeaderRoutingLineage(account.binding)
      : headerRoutingLineage(undefined, receipt)
    const checkedAt = quotaSnapshotCheckedAt(account.quota)
    return routingQuotaEntry(
      account.id,
      lineage,
      account.accountIdentity,
      account.quota
        ? {
            quota: account.quota,
            checkedAt,
            refreshAfter: getQuotaNextRefreshAt(
              account.quota,
              storage,
              checkedAt,
            ),
          }
        : null,
      storage,
    )?.quota
  }
  let mainQuotaCredentialEpoch:
    | { rowId: string; credentialEpoch: number }
    | undefined
  // The AccountStorage-shaped projection supplies quota, settings, and account
  // metadata to routing and display code. It contains no OAuth access/refresh
  // tokens or API keys; credential material comes only from native authorization.
  async function loadAccounts(
    path = accountStoragePath,
  ): Promise<AccountStorage | null> {
    if (path !== accountStoragePath)
      throw new Error('Native account storage mismatch')
    const snapshot = await nativeAccounts.read()
    headerRoutingPolicyStorage = snapshot.policyStorage
    if (!mainQuotaCredentialEpoch) {
      const binding = snapshot.accounts.find(
        (account) => account.id === 'main',
      )?.binding
      if (binding)
        mainQuotaCredentialEpoch = {
          rowId: binding.rowId,
          credentialEpoch: binding.credentialEpoch,
        }
    }
    if (snapshot.mode !== 'claustrum') return snapshot.policyStorage
    const primary = snapshot.accounts.find(
      (account) => account.id === 'main' && account.source === 'vault',
    )
    const primaryUuid = asProviderAccountUuid(primary?.accountIdentity)
    // Enrollment, not account settings, selects vault custody, so an enrolled
    // host routes over the vault account pool even before its first roster
    // discovery has listed any account. Derive the pool marker from the
    // native mode, not legacy config. This is routing metadata only; each
    // physical send obtains a fresh vault credential.
    return {
      ...snapshot.policyStorage,
      claustrum: {
        ...snapshot.policyStorage.claustrum,
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount:
          primary?.credentialId && primaryUuid
            ? {
                credentialId: primary.credentialId,
                accountId: primaryUuid,
                state: primary.state ?? 'cold',
                enabled: primary.enabled,
              }
            : undefined,
      },
    }
  }
  async function updateNativeSection(
    section:
      | 'claudeCache'
      | 'cacheKeep'
      | 'dump'
      | 'claudeFast'
      | 'logging'
      | 'prime'
      | 'routing'
      | 'killswitch',
    patch: Record<string, unknown>,
  ) {
    await nativeAccounts.updateSettings((settings) =>
      mergeNativeSettingsSection(settings, section, patch),
    )
    return loadAccounts()
  }
  // Turning the cache on or off also records the effective strategy, as the
  // standalone cache command always did: a pool without a stored mode is
  // saved as { enabled, mode: 'explicit' } instead of leaving mode implicit.
  const setCache1hPersistentEnabled = async (enabled: boolean) => {
    await nativeAccounts.updateSettings((settings) => ({
      ...settings,
      claudeCache: {
        ...plainSettingsSection(settings.claudeCache),
        enabled,
        mode: getCache1hPersistentMode({
          ...settings,
          version: 1,
          accounts: [],
        }),
      },
    }))
    return loadAccounts()
  }
  const setCache1hPersistentMode = (
    mode: NonNullable<AccountStorage['claudeCache']>['mode'],
  ) => updateNativeSection('claudeCache', { mode })
  const setCacheKeepPersistentEnabled = (enabled: boolean) =>
    updateNativeSection('cacheKeep', { enabled })
  // An always-on schedule has no hour bounds. Leaving a previous window's
  // startHour/endHour behind would revive that window as soon as anything
  // reads the hours without first checking `always`.
  const setCacheKeepPersistentAlways = async () => {
    await nativeAccounts.updateSettings(nativeCacheKeepAlways)
    return loadAccounts()
  }
  const setCacheKeepPersistentWindow = (startHour: number, endHour: number) =>
    updateNativeSection('cacheKeep', {
      enabled: true,
      always: false,
      startHour,
      endHour,
    })
  const setCacheKeepSubagentsEnabled = (subagents: boolean) =>
    updateNativeSection('cacheKeep', { subagents })
  const setDumpPersistentEnabled = (enabled: boolean) =>
    updateNativeSection('dump', { enabled })
  const setFastModePersistentEnabled = (enabled: boolean) =>
    updateNativeSection('claudeFast', { enabled })
  // Stores the level, then aligns this process's live logger level with it.
  const setLogLevelPersistent = async (
    level: NonNullable<NonNullable<AccountStorage['logging']>['level']>,
  ) => {
    await nativeAccounts.setLoggingLevel(level)
    return loadAccounts()
  }
  const setPrimePersistentEnabled = (
    enabled: boolean,
    _path = accountStoragePath,
  ) => updateNativeSection('prime', { enabled })
  const setRoutingMode = (
    mode: NonNullable<AccountStorage['routing']>['mode'],
    _path = accountStoragePath,
  ) => updateNativeSection('routing', { mode })
  const setKillswitchPersistent = (
    killswitch: NonNullable<AccountStorage['killswitch']>,
  ) => updateNativeSection('killswitch', killswitch)
  const setAccountEnabledPersistent = (
    routeId: string,
    enabled: boolean,
    _path = accountStoragePath,
  ) => nativeAccounts.setEnabled(routeId, enabled)
  const removeAccountPersistent = (
    routeId: string,
    _path = accountStoragePath,
  ) => nativeAccounts.remove(routeId)
  const reorderAccountsPersistent = (
    routeIds: string[],
    _path = accountStoragePath,
    movedRouteId?: string,
  ) => nativeAccounts.reorder(routeIds, movedRouteId)

  let initialStorage: AccountStorage | null = null
  try {
    initialStorage = await loadAccounts()
  } catch {}
  function isScopedCustodyActive(
    storage: AccountStorage | null | undefined,
  ): boolean {
    return Boolean(
      storage &&
        getClaustrumMode(storage) === 'claustrum' &&
        storage.claustrum?.scopedRoster === true,
    )
  }
  function getOpenCodeScopedRuntime(
    storagePath = accountStoragePath,
    _ctxDirectory = ctx.directory,
  ) {
    if (storagePath !== accountStoragePath)
      throw new Error('Native vault storage mismatch')
    return nativeAccounts.vault
  }
  const usagePublications = createNativeUsagePublisher('native-auth')
  const dispatchWork = new Set<Promise<unknown>>()
  async function trackDispatch<T>(work: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(work)
    dispatchWork.add(pending)
    try {
      return await pending
    } finally {
      dispatchWork.delete(pending)
    }
  }
  async function drainDispatchWork() {
    while (dispatchWork.size) await Promise.allSettled([...dispatchWork])
  }
  async function closeOpenCodeScopedRuntime(
    _storagePath = accountStoragePath,
  ): Promise<void> {
    vaultWatch?.close()
    // Aborting the caller does not cancel a version-fenced 401 report.
    // Finish dispatch cleanup before closing the custody client it uses.
    await drainDispatchWork()
    await usagePublications.drain()
    await nativeAccounts.drainQuotaPublications()
    await Promise.all(
      [...stickySessionRouters.values()].map((router) => router.drain()),
    )
    await nativeAccounts.drainRoutingPublications()
    await nativeAccounts.close()
  }

  function assertNativeEnvironment() {
    if (process.env.OPENCODE_AUTH_CONTENT !== undefined)
      throw new Error(
        'Native OAuth cannot serve while OPENCODE_AUTH_CONTENT is set',
      )
  }
  type NativeOAuthAuthorization = {
    accessToken: string
    expires?: number
    accountIdentity?: string
    localSubject?: NativeKnownCredentialSubject
    localSource?: 'current' | 'validated' | 'rotated' | 'adopted'
    scopedAttempt?: NativeCustodyReceipt
  }
  function nativeWireIdentity(accountIdentity: string | undefined) {
    const accountUuid = asProviderAccountUuid(accountIdentity)
    if (!accountUuid)
      throw new Error(
        'Native wire identity requires an admitted provider account',
      )
    // Credential checks already verified the Anthropic account UUID. Use it
    // for both the device identity cache key and the request's account metadata,
    // without another bootstrap request carrying an earlier access token.
    return getClaudeCodeIdentityForVerifiedAccount(accountUuid, accountUuid)
  }
  class NativeModelPolicyError extends Error {
    constructor(
      readonly account: NativeAccountView,
      readonly checkIntervalMs: number,
    ) {
      super(
        'OAuth account cannot serve the requested model under current quota policy',
      )
    }
  }
  class NativeUnsupportedCredentialError extends Error {
    constructor() {
      super(
        'Native OAuth requires a Claude Pro/Max credential. An API key belongs in OpenCode stock Anthropic authentication.',
      )
    }
  }
  class NativeCredentialUnavailableError extends Error {
    constructor(
      readonly account: NativeAccountView,
      status: string,
      readonly tokenRefreshFailed = false,
      readonly failure?: NativeRefreshFailure,
    ) {
      super(
        failure?.kind === 'provider' && failure.status !== undefined
          ? `Claude OAuth refresh failed: ${failure.status} — ${failure.classification === 'invalid-grant' ? 'invalid_grant' : 'OAuth operation failed'}`
          : `Native OAuth authorization refused: ${status}`,
      )
    }
  }
  async function authorizeOAuth(
    routeId: string,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
    modelId?: string,
    intent: 'serve' | 'refresh' | 'last-main' | 'cachekeep' = 'serve',
    accountSnapshot?: NativeAccountSnapshot,
  ): Promise<NativeOAuthAuthorization> {
    assertNativeEnvironment()
    signal?.throwIfAborted()
    const snapshot = accountSnapshot ?? (await nativeAccounts.read())
    const account = snapshot.accounts.find(
      (candidate) => candidate.id === routeId,
    )
    if (
      intent === 'cachekeep' &&
      (account?.type !== 'oauth' || !nativeAccountCanServe(account))
    )
      throw new NativeAccountRefusal('account-unavailable')
    if (account?.state === 'unsupported-access')
      throw new NativeUnsupportedCredentialError()
    if (account?.source === 'vault' && !nativeAccountCanServe(account))
      throw new NativeCredentialUnavailableError(account, 'not-active')
    if (account?.type !== 'oauth' || !nativeAccountCanServe(account)) {
      throw new Error('Native OAuth account is unavailable')
    }
    const checkModelPolicy = (
      view: NativeAccountView,
      storage: AccountStorage,
      receipt?: NativeCustodyReceipt,
    ) => {
      const quota = routingAccountQuota(view, storage, receipt)
      // Ordered routing can try main after eligible fallbacks are exhausted.
      // A cached scoped limit must not remove that final provider attempt;
      // explicit killswitch limits still block it before dispatch.
      const lastMainAttempt =
        intent === 'last-main' &&
        routeId === 'main' &&
        getRoutingMode(storage) !== 'sticky-balanced'
      if (
        modelId &&
        ((isKillswitchEnabled(storage) &&
          !killswitchPassesPolicy(
            quota,
            storage,
            routeId === 'main' ? undefined : routeId,
            modelId,
          )) ||
          (!lastMainAttempt && !quotaSnapshotPassesModelScope(quota, modelId)))
      )
        throw intent === 'cachekeep'
          ? new NativeAccountRefusal('account-policy')
          : new NativeModelPolicyError(view, getQuotaCheckIntervalMs(storage))
    }
    checkModelPolicy(account, snapshot.policyStorage)
    let result: NativeOAuthAuthorization
    if (account.source === 'vault') {
      const receipt = await nativeAccounts
        .authorizeVault(routeId, signal)
        .catch((error) => {
          signal?.throwIfAborted()
          if (intent === 'cachekeep') {
            const refusal = nativeAccountRefusal(error)
            if (refusal) throw refusal
          }
          if (
            error instanceof NativeCustodyError &&
            ['not-active', 'route-declined', 'route-unavailable'].includes(
              error.code,
            )
          )
            throw new NativeCredentialUnavailableError(account, error.code)
          throw error
        })
      result = {
        accessToken: receipt.accessToken,
        expires: receipt.expiresAtMs ?? undefined,
        accountIdentity: receipt.accountIdentity,
        scopedAttempt: receipt,
      }
    } else {
      const authorization = await nativeAccounts.authorizeLocal(routeId, {
        signal,
        rejectedAccessToken,
        intent: rejectedAccessToken
          ? 'refresh'
          : intent === 'last-main' || intent === 'cachekeep'
            ? 'serve'
            : intent,
      })
      if (authorization.status !== 'usable') {
        if (intent === 'cachekeep') {
          const refusal = nativeLocalAccountRefusal(authorization)
          if (refusal) throw refusal
        }
        throw new NativeCredentialUnavailableError(
          account,
          authorization.status,
          authorization.status === 'failed' &&
            authorization.failure.kind === 'provider',
          authorization.status === 'failed' ? authorization.failure : undefined,
        )
      }
      result = {
        accessToken: authorization.access,
        expires: authorization.expires,
        accountIdentity: authorization.binding.identity,
        localSubject: authorization.subject,
        localSource: authorization.source,
      }
    }
    // Concurrent requests can share token refresh while using different models.
    // After authorization waits, recheck that the account is still enabled and
    // that this request's model quota and killswitch rules still permit sending.
    const current = await nativeAccounts.read()
    const selected = current.accounts.find(
      (candidate) => candidate.id === routeId,
    )
    if (signal?.aborted) throw signal.reason ?? new Error('Request aborted')
    if (
      !selected ||
      !nativeAccountCanServe(selected) ||
      selected.source !== account.source ||
      selected.accountIdentity !== result.accountIdentity
    )
      throw intent === 'cachekeep'
        ? new NativeAccountRefusal('credential-changed')
        : new Error('Native OAuth account changed before dispatch')
    if (
      result.localSubject &&
      (!selected.binding ||
        selected.binding.storageId !== result.localSubject.binding.storageId ||
        selected.binding.rowId !== result.localSubject.binding.rowId ||
        selected.binding.credentialEpoch !==
          result.localSubject.binding.credentialEpoch ||
        selected.binding.identity !== result.localSubject.binding.identity)
    )
      throw intent === 'cachekeep'
        ? new NativeAccountRefusal('credential-changed')
        : new Error('Native local account binding changed before dispatch')
    if (
      result.scopedAttempt &&
      selected.credentialId !== result.scopedAttempt.credentialId
    )
      throw intent === 'cachekeep'
        ? new NativeAccountRefusal('credential-changed')
        : new Error('Native vault credential binding changed before dispatch')
    checkModelPolicy(selected, current.policyStorage, result.scopedAttempt)
    return result
  }

  async function resetNativeBackoff(routeId: string, signal?: AbortSignal) {
    const snapshot = await nativeAccounts.read()
    const account = snapshot.accounts.find(
      (candidate) => candidate.id === routeId,
    )
    if (account?.type !== 'oauth')
      throw new Error('Native OAuth account is unavailable')
    const fence =
      account.source === 'vault'
        ? await nativeAccounts.authorizeVault(routeId, signal)
        : await nativeAccounts.captureLocalSubject(routeId)
    if (!(await nativeAccounts.resetBackoff(routeId, fence)))
      throw new Error('Native reset fence changed')
  }
  const nativeLocalRefreshFailures = new WeakMap<Response, unknown>()
  const reportedVault401 = new WeakSet<NativeCustodyReceipt>()
  async function reportVault401(
    receipt: NativeCustodyReceipt,
    source: 'direct' | 'relay_status_field',
  ) {
    if (reportedVault401.has(receipt)) return
    reportedVault401.add(receipt)
    await trackDispatch(() =>
      nativeAccounts.vault.reportFailure(receipt, 401, source),
    ).catch(() => {
      logger.warn('claustrum', 'native auth-failure report unavailable')
    })
  }
  // Re-authorize after a 401 before anything is reported. When the vault admits
  // a strictly newer version of the same credential and account, the served
  // version is obsolete: the caller replays once and reports only the receipt
  // whose response is final. A refusal leaves the served receipt final.
  async function prepareVaultRetry(
    receipt: NativeCustodyReceipt,
    site: 'model' | 'model-relay' | 'cachekeep' | 'prime',
    signal?: AbortSignal,
  ) {
    const result = await nativeAccounts.vault.prepareRetry(
      receipt,
      signal,
      site,
    )
    return result.retry ? result.receipt : undefined
  }

  const fallbackMode = resolveContentFilterFallbackMode(
    process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE,
  )
  const fableFallbackManager = new FableFallbackManager()
  // Send-time metadata per recovery round, keyed by recovery key. The kept
  // source body itself is never copied here: when a refusal starts the
  // round, the keep takes the exact signed bytes from CacheKeep's live
  // target for the session, which already holds the last body actually
  // sent. If that target is absent (CacheKeep off, not hybrid), there is
  // nothing to warm.
  const pendingSourceMeta = new Map<
    string,
    { accountIdentity?: string; sentAt: number }
  >()
  // Stop every source warm in a session for good and drop the CacheKeep
  // targets with it. The manager already forgot the kept prefixes (session
  // clear, model change); this mirrors that into CacheKeep's machinery.
  function dropSessionSourceWarms(sessionId: string) {
    for (const { recoveryKey } of fableFallbackManager.sourceWarmsForSession(
      sessionId,
    )) {
      fableFallbackManager.dropSourceWarm(recoveryKey)
    }
    for (const target of cacheKeepManager.trackedSessions()) {
      const parsed = parseSourceWarmTargetId(target.id)
      if (parsed && parsed.sessionId === sessionId)
        cacheKeepManager.untrack(target.id)
    }
    for (const key of [...pendingSourceMeta.keys()]) {
      if (key.startsWith(`${sessionId}\0`)) pendingSourceMeta.delete(key)
    }
  }
  const laneStartTracker = new LaneStartTracker()
  const effortPlanTracker = new OpenCodeEffortPlanTracker()
  const billingLineageTracker = new BillingLineageTracker()
  const serverFallbackTargets = new Map<string, string>()
  const pendingDesktopNotices = new Map<string, string[]>()
  const pendingRecoveryDesktopNotices = new Map<string, string>()
  const desktopNoticeFlushes = new Map<string, Promise<void>>()
  const desktopNoticeSafeSessions = new Set<string>()
  const desktopNoticeLatestUserMessages = new Map<string, string>()
  const desktopNoticeIdleUserMessages = new Map<string, string>()
  const desktopNoticeMessageIds = new Map<string, Set<string>>()
  const desktopNoticeProbes = new Map<string, number>()
  // Session-to-account assignments live in separate files for local and vault
  // accounts. A local host uses the committed migration destination; an enrolled
  // host uses only the vault routing file the native runtime names, so vault
  // routing never opens or rewrites the local file. The runtime's mode is read
  // per use because enrollment can change while the plugin runs.
  const stickySessionRouters = new Map<string, StickySessionRouter>()
  const routingRelay = createRoutingRelay(async (subject) => {
    const snapshot = await nativeAccounts.read()
    return snapshot.accounts.find(
      (row) =>
        row.accountIdentity === subject.accountIdentity &&
        (!subject.credentialId || row.credentialId === subject.credentialId),
    )?.quota
  })
  const routingServedTurns = new WeakSet<PerfTrace>()
  const routingStreamLimits = new WeakMap<Response, () => void>()
  async function currentStickyRouting(): Promise<{
    router: StickySessionRouter
    accountIdentities?: ReadonlyMap<string, string>
  }> {
    const snapshot = await nativeAccounts.read()
    const path = snapshot.routingPath
    if (!path)
      throw new Error(
        snapshot.mode === 'claustrum'
          ? 'Vault routing storage is unavailable'
          : 'Native routing storage is unavailable',
      )
    // Vault pins are bound to the verified account UUID behind each route, so
    // a route whose vault account was replaced (such as a new default account
    // under the same credential) loses its pins and quota preference, while
    // other accounts keep theirs. Local routing passes no map and keeps its
    // assignments unchanged.
    let accountIdentities: Map<string, string> | undefined
    if (snapshot.mode === 'claustrum') {
      accountIdentities = new Map()
      for (const account of snapshot.accounts)
        if (account.source === 'vault' && account.accountIdentity)
          accountIdentities.set(account.id, account.accountIdentity)
    }
    let router = stickySessionRouters.get(path)
    if (!router) {
      router = new StickySessionRouter({
        path,
        vaultSeed: snapshot.routingSeed,
        onLockEvent: nativeAccounts.onLockEvent,
        relocationGuard: nativeAccounts.relocationGuard,
        localRecoveryPath:
          snapshot.mode === 'local' ? snapshot.routingRecoveryPath : undefined,
      })
      stickySessionRouters.set(path, router)
    }
    router.setVaultSeed(snapshot.routingSeed)
    return { router, ...(accountIdentities && { accountIdentities }) }
  }
  // The runtime stores quota readings for the account and tokens used to fetch
  // them. QuotaManager caches those readings and when they were checked.
  // A failed poll supplies no exhaustion evidence and cannot prove that a
  // rejected refresh token became usable, so it must not clear refresh errors.
  const quotaManager = new QuotaManager({
    storage: initialStorage,
    pauseBetweenQuotaCalls: runtimeOverrides.quotaCallPause,
    fetchQuotaSnapshot: (request, dispatch) => {
      assertNativeEnvironment()
      const routeId = request.kind === 'main' ? 'main' : request.accountId
      if (!routeId) throw new Error('Quota request has no account identity')
      return nativeAccounts.fetchQuota(
        routeId,
        undefined,
        undefined,
        dispatch,
        request.purpose,
      )
    },
  })
  function quotaSnapshotIsExhausted(
    quota: OAuthQuotaSnapshot | null | undefined,
  ) {
    return (['five_hour', 'seven_day'] as const).some(
      (key) => (quota?.[key]?.remainingPercent ?? 1) <= 0,
    )
  }
  // Account-wide provider waits precede token acquisition in ordered routing.
  // Model-scoped readings retain their separate last-main policy; permanent
  // authentication failures and sticky allocation keep their own error paths.
  function mainProviderQuotaRestriction(
    storage: AccountStorage | null,
    accountUuid: string | undefined,
    headerExhaustionProven = false,
  ) {
    if (
      !storage ||
      storage.quota?.enabled === false ||
      !accountUuid ||
      getRoutingMode(storage) === 'sticky-balanced' ||
      isPermanentRefreshError(storage.refresh?.mainLastRefreshError)
    )
      return undefined
    const now = Date.now()
    const error = storage.quota?.mainLastQuotaApiError
    if (
      error &&
      error.accountIdentity === accountUuid &&
      error.nextRetryAt !== undefined &&
      error.nextRetryAt > now
    ) {
      return {
        message: formatQuotaBackoffMessage(error, now),
        retryAfter: Math.max(1, Math.ceil((error.nextRetryAt - now) / 1000)),
      }
    }
    const quota = storage.quota?.mainQuota
    // Header percentages are rounded for display and cannot alone prove
    // exhaustion. Leave them to normal request and routing policy.
    const checkedAt = quotaSnapshotCheckedAt(quota)
    if (
      quota?.accountIdentity !== accountUuid ||
      (quota.source === 'headers' && !headerExhaustionProven) ||
      !quotaSnapshotIsExhausted(quota) ||
      checkedAt <= 0 ||
      checkedAt > now ||
      getQuotaNextRefreshAt(quota, storage, checkedAt) <= now
    )
      return undefined
    const resetTimes = (['five_hour', 'seven_day'] as const).flatMap((key) => {
      const window = quota[key]
      const reset = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
      return window &&
        window.remainingPercent <= 0 &&
        Number.isFinite(reset) &&
        reset > now
        ? [reset]
        : []
    })
    return {
      message: 'Claude OAuth quota is exhausted for this account.',
      retryAfter: Math.max(
        1,
        Math.ceil(
          ((resetTimes.length
            ? Math.max(...resetTimes)
            : now + getQuotaCheckIntervalMs(storage)) -
            now) /
            1000,
        ),
      ),
    }
  }
  async function reconcileMainQuotaAccountIdentity(
    accessToken: string,
    quotaKey: string | undefined,
    providerAccountUuid?: ProviderAccountUuid,
  ): Promise<void> {
    if (
      mainQuotaIdentityAccessToken === accessToken &&
      mainQuotaAccountId === quotaKey
    )
      return
    const providerIdentityChanged =
      mainProviderAccountUuid !== undefined &&
      providerAccountUuid !== undefined &&
      mainProviderAccountUuid !== providerAccountUuid
    mainQuotaIdentityAccessToken = accessToken
    mainQuotaAccountId = quotaKey
    quotaManager.setMainQuotaAccountIdentity(
      quotaKey,
      true,
      providerIdentityChanged,
    )
  }

  async function resolveMainQuotaAccountIdentity(
    accessToken: string,
    _model?: string,
    credentialAccountUuid?: string,
    credentialRecordVersion?: number,
  ): Promise<MainQuotaIdentityResolution> {
    const resolutionKey = accessToken
    const inFlight = mainQuotaIdentityResolutions.get(resolutionKey)
    if (inFlight) {
      const resolved = await inFlight.promise
      return credentialRecordVersion === inFlight.recordVersion
        ? resolved
        : { ...resolved, stale: true }
    }

    const resolution = (async () => {
      const resolutionGeneration = ++mainQuotaIdentityResolutionGeneration
      const mainSlotQuotaKey = mainAccountId

      const currentSnapshot = await nativeAccounts.read()
      const currentStorage = currentSnapshot.policyStorage
      const nativePrimaryIdentity = currentSnapshot.accounts.find(
        (account) => account.id === 'main',
      )?.accountIdentity
      const identity = nativeWireIdentity(
        credentialAccountUuid ?? nativePrimaryIdentity,
      )
      const scopedCustodyActive = currentSnapshot.mode === 'claustrum'
      const rosterPrimaryAccountId = scopedCustodyActive
        ? currentStorage?.claustrum?.primaryAccount?.accountId
        : undefined
      // A scoped receipt may only bind quota to the account it was served
      // for. If the roster primary or the custody mode changed after the
      // receipt was issued, the receipt's quota must not land on the new
      // account: fail closed without touching the global main identity.
      if (
        (credentialAccountUuid !== undefined &&
          credentialAccountUuid !== nativePrimaryIdentity) ||
        (scopedCustodyActive && credentialAccountUuid === undefined)
      ) {
        return {
          quotaKey: undefined,
          providerAccountUuid: undefined,
          generation: quotaManager.getMainQuotaIdentityGeneration(),
          stale: true,
          state: 'on-identity-mismatch' as const,
        }
      }
      // Scoped custody binds main runtime state to the roster's primary
      // account id: core's state fence drops any main quota keyed otherwise,
      // so a slot-keyed quota would never persist. Outside scoped custody,
      // non-oat adapters keep their local slot for quota fencing; it is not a
      // provider identity and must never reach a provider-facing field.
      const quotaKey =
        nativePrimaryIdentity ?? rosterPrimaryAccountId ?? mainSlotQuotaKey
      const persistedProviderAccountUuid =
        currentStorage?.main?.profile?.providerAccountUuid ??
        (currentStorage?.main?.profile?.accountIdentity as
          | ProviderAccountUuid
          | undefined)
      const claimedProviderAccountUuid =
        asProviderAccountUuid(credentialAccountUuid) ??
        asProviderAccountUuid(identity.accountUuid)
      const providerAccountUuid = credentialAccountUuid
        ? claimedProviderAccountUuid
        : accessToken.startsWith('sk-ant-oat')
          ? (claimedProviderAccountUuid ??
            asProviderAccountUuid(persistedProviderAccountUuid))
          : undefined
      const state: CustodyStatusState =
        getClaustrumMode(currentStorage) !== 'claustrum'
          ? 'na'
          : persistedProviderAccountUuid === undefined ||
              claimedProviderAccountUuid === undefined
            ? 'unknown-identity'
            : persistedProviderAccountUuid !== undefined &&
                claimedProviderAccountUuid !== undefined &&
                persistedProviderAccountUuid !== claimedProviderAccountUuid
              ? 'on-identity-mismatch'
              : 'on-vault-served'
      if (resolutionGeneration !== mainQuotaIdentityResolutionGeneration) {
        const identityChanged =
          mainQuotaIdentityAccessToken !== accessToken ||
          mainQuotaAccountId !== quotaKey
        return {
          quotaKey,
          providerAccountUuid,
          generation: quotaManager.getMainQuotaIdentityGeneration(),
          stale: identityChanged,
          state,
        }
      }
      await reconcileMainQuotaAccountIdentity(
        accessToken,
        quotaKey,
        providerAccountUuid,
      )
      if (
        accessToken.startsWith('sk-ant-oat') &&
        providerAccountUuid === undefined
      ) {
        quotaManager.clearMain()
      }
      mainProviderAccountUuid = providerAccountUuid
      if (accessToken.startsWith('sk-ant-oat')) {
        mainServedAccessToken = accessToken
      }
      return {
        quotaKey,
        providerAccountUuid,
        generation: quotaManager.getMainQuotaIdentityGeneration(),
        stale: false,
        state,
      }
    })()
    mainQuotaIdentityResolutions.set(resolutionKey, {
      promise: resolution,
      recordVersion: credentialRecordVersion,
    })
    try {
      return await resolution
    } finally {
      if (
        mainQuotaIdentityResolutions.get(resolutionKey)?.promise === resolution
      ) {
        mainQuotaIdentityResolutions.delete(resolutionKey)
      }
    }
  }

  const quotaHeaderFeedRegistry =
    initialStorage?.quotaHeaderFeed?.enabled === true
      ? new QuotaHeaderFeedRegistry()
      : null
  // Profiles fetched by this plugin instance, keyed by route and account
  // identity. A failed network request is not repeated for that account this
  // boot, and a fetched profile is reused until it goes stale, even if saving
  // it is slow or fails. Expired pending attempts and pre-request refusals
  // can retry.
  interface ProfileHydration {
    /** The sidebar route whose credentials produced this profile. */
    accountId: string
    /** Settles when the profile response arrives or the attempt fails, never on the save. */
    fetched: Promise<void>
    /**
     * The display bound the attempt started under. Once it has expired, a
     * later display does not wait on the same attempt again.
     */
    deadline?: AbortSignal
    /** True once the profile response arrived or the attempt failed. */
    settled?: boolean
    /** A dispatched request rejected; suppress repeats for that account this boot. */
    failed?: boolean
    /** Storage row and login epoch; identity discovery and token refresh leave these unchanged. */
    lineage?: string
    profile?: OAuthAccountProfile
    persistence?: 'pending' | 'saved' | 'refused' | 'failed'
    isCurrent?: () => Promise<boolean>
  }
  const profileHydrations = new Map<string, ProfileHydration>()
  // A completed fresh check prevents repeat requests for the same account,
  // even when a new login invalidates the credentials used by that check.
  // Keep this suppression separate from the attempt's displayable profile.
  const checkedProfiles = new Map<string, OAuthAccountProfile>()
  // Saving a fetched profile continues after the display has used it. Dispose
  // aborts unfinished profile requests and waits for these saves, so an
  // instance never leaves a metadata write running after it is torn down.
  const profilePublications = new Set<Promise<unknown>>()
  const profileHydrationShutdown = new AbortController()
  let bootProfileHydrationStarted = false

  function profileHydrationKey(id: string, accountIdentity?: string) {
    return JSON.stringify([id, accountIdentity ?? null])
  }

  function profileHydrationLineage(account: NativeAccountView) {
    const binding = account.binding
    if (account.source !== 'local' || !binding) return undefined
    return JSON.stringify([
      binding.storageId,
      binding.rowId,
      binding.credentialEpoch,
    ])
  }

  function canIdentifyProfileHydration(
    hydration: ProfileHydration,
    account: NativeAccountView,
  ) {
    // Learning an identity leaves the storage row and login epoch unchanged;
    // a replacement login changes the epoch. Only a matching row and epoch
    // link an initially unidentified request to the now-identified account.
    // Vault routes already have an identity before requesting a profile.
    return (
      hydration.lineage !== undefined &&
      hydration.lineage === profileHydrationLineage(account) &&
      (!hydration.profile ||
        hydration.profile.accountIdentity === account.accountIdentity)
    )
  }

  /** A fetched tier requires current credentials; a storage failure alone does not hide it. */
  async function displayableProfile(
    hydration: ProfileHydration | undefined,
    now: number,
  ) {
    if (
      !hydration?.profile ||
      !oauthProfileIsFresh(hydration.profile, now) ||
      !(await hydration.isCurrent?.())
    )
      return undefined
    return hydration.persistence === 'refused' ? undefined : hydration.profile
  }

  function failedProfileHydrationsForStorage(storage: AccountStorage | null) {
    if (!storage) return []
    const displayedAccounts = new Set([
      ...(storage.main ? ['main'] : []),
      ...(storage.accounts ?? [])
        .filter(
          (account) =>
            isOAuthAccount(account) &&
            (account.enabled !== false ||
              Boolean(account.claustrumScopedCredentialId)),
        )
        .map((account) => account.id),
    ])
    return [...new Set(profileHydrations.values())].filter(
      (hydration) =>
        hydration.persistence === 'failed' &&
        hydration.profile !== undefined &&
        displayedAccounts.has(hydration.accountId),
    )
  }

  async function overlayCurrentHydratedProfile(
    storage: AccountStorage,
    hydration: ProfileHydration,
    current: Awaited<ReturnType<typeof nativeAccounts.read>>,
    profile: OAuthAccountProfile,
  ) {
    // A failed save may still supply a sidebar tier, but only if the reloaded
    // account has the same identity and current credentials that fetched it.
    // Local accounts also match their pool row and credential epoch; vault
    // accounts are checked against their current record version.
    const accountId = hydration.accountId
    const account = current.accounts.find(
      (candidate) => candidate.id === accountId,
    )
    const sameLineage =
      account?.source === 'local'
        ? canIdentifyProfileHydration(hydration, account)
        : account?.source === 'vault' &&
          account.accountIdentity === profile.accountIdentity
    if (
      account?.type !== 'oauth' ||
      !nativeAccountCanServe(account) ||
      account.accountIdentity !== profile.accountIdentity ||
      !sameLineage ||
      (await displayableProfile(hydration, Date.now())) !== profile
    )
      return storage

    if (accountId === 'main')
      return storage.main
        ? { ...storage, main: { ...storage.main, profile } }
        : storage
    const stored = storage.accounts?.find(
      (candidate) => candidate.id === accountId,
    )
    if (!stored || !isOAuthAccount(stored)) return storage
    return {
      ...storage,
      accounts: storage.accounts.map((candidate) =>
        candidate.id === accountId && isOAuthAccount(candidate)
          ? { ...candidate, profile }
          : candidate,
      ),
    }
  }

  async function overlayFailedHydratedProfiles(
    storage: AccountStorage | null,
    currentSnapshot?: Awaited<ReturnType<typeof nativeAccounts.read>>,
    candidates = failedProfileHydrationsForStorage(storage),
  ) {
    if (!storage || candidates.length === 0) return storage

    const displayable: Array<{
      hydration: ProfileHydration
      profile: OAuthAccountProfile
    }> = []
    for (const hydration of candidates) {
      const profile = await displayableProfile(hydration, Date.now())
      if (profile) displayable.push({ hydration, profile })
    }
    if (!displayable.length) return storage

    const current = currentSnapshot ?? (await nativeAccounts.read())
    let displayStorage = storage
    for (const candidate of displayable)
      displayStorage = await overlayCurrentHydratedProfile(
        displayStorage,
        candidate.hydration,
        current,
        candidate.profile,
      )
    return displayStorage
  }

  function startProfileHydration(
    account: NativeAccountView,
    key: string,
    signal?: AbortSignal,
  ): ProfileHydration {
    assertNativeEnvironment()
    let requested = false
    const transport: typeof fetch = Object.assign(
      (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        requested = true
        return profileFetch(input, init)
      },
      { preconnect: profileFetch.preconnect },
    )
    const hydration: ProfileHydration = {
      accountId: account.id,
      fetched: Promise.resolve(),
      lineage: profileHydrationLineage(account),
      ...(signal && { deadline: signal }),
    }
    hydration.fetched = nativeAccounts
      .fetchProfileForDisplay(
        account.id,
        transport,
        AbortSignal.any([
          profileHydrationShutdown.signal,
          ...(signal ? [signal] : []),
        ]),
      )
      .then(
        ({ profile, persisted, isCurrent }) => {
          hydration.settled = true
          if (profile.accountIdentity !== undefined)
            checkedProfiles.set(
              profileHydrationKey(account.id, profile.accountIdentity),
              profile,
            )
          // Keep a profile only for the account it was read for. A route
          // whose identity was not yet known accepts the identity this read
          // reports; the display checks it against the route again later.
          if (
            account.accountIdentity === undefined ||
            profile.accountIdentity === account.accountIdentity
          ) {
            hydration.profile = profile
            hydration.isCurrent = isCurrent
            hydration.persistence = 'pending'
          }
          const saving = persisted.then(async (outcome) => {
            hydration.persistence = outcome
            if (outcome === 'failed')
              logger.warn('quota', 'failed to persist account profile', {
                account: account.id,
              })
            else if (outcome === 'refused')
              logger.debug('quota', 'refused account profile publication', {
                account: account.id,
              })
            if (
              (outcome === 'saved' || outcome === 'failed') &&
              !profileHydrationShutdown.signal.aborted
            ) {
              const displayableFailure =
                outcome === 'failed' &&
                (await displayableProfile(hydration, Date.now()))
              if (outcome === 'saved' || displayableFailure) {
                // Refresh after saving a profile or after a current fetched
                // profile's save fails so the sidebar can include its tier.
                try {
                  const current = await nativeAccounts.read()
                  if (!profileHydrationShutdown.signal.aborted)
                    await writeSidebarState(
                      current.policyStorage,
                      {
                        ...lastSidebarRouting,
                        routingAuthoritative: false,
                      },
                      current,
                    )
                } catch {
                  logger.debug(
                    'quota',
                    'failed to publish account profile to sidebar',
                    {
                      account: account.id,
                    },
                  )
                }
              }
            }
          })
          profilePublications.add(saving)
          void saving.then(() => profilePublications.delete(saving))
        },
        (error: unknown) => {
          hydration.settled = true
          hydration.failed = requested
          logger.debug('quota', 'failed to hydrate account profile', {
            account: account.id,
            error: error instanceof Error ? error.message : String(error),
          })
          if (!requested && profileHydrations.get(key) === hydration)
            profileHydrations.delete(key)
        },
      )
    profilePublications.add(hydration.fetched)
    void hydration.fetched.then(() =>
      profilePublications.delete(hydration.fetched),
    )
    return hydration
  }

  /**
   * Wait for an attempt's profile response, but no longer than this display's
   * `signal` or the bound the attempt itself started under.
   */
  function waitForProfile(
    hydration: ProfileHydration,
    signal?: AbortSignal,
  ): Promise<void> {
    const bounds = [signal, hydration.deadline].filter(
      (bound): bound is AbortSignal => bound !== undefined,
    )
    if (!bounds.length) return hydration.fetched
    const bound = AbortSignal.any(bounds)
    if (bound.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        bound.removeEventListener('abort', finish)
        resolve()
      }
      bound.addEventListener('abort', finish, { once: true })
      void hydration.fetched.then(finish)
    })
  }

  function storedProfileIsFresh(account: NativeAccountView, now: number) {
    return (
      oauthProfileIsFresh(account.profile, now) &&
      oauthProfileMatchesIdentity(account.profile, account.accountIdentity)
    )
  }

  /**
   * Read native account metadata for the account and quota displays, first
   * fetching missing or stale OAuth profiles. Waiting stops when `signal`
   * aborts; a failed fetch or a refused save leaves the stored profile in
   * place, and the display never waits for a fetched profile to be saved.
   */
  async function readNativeSnapshotForDisplay(
    signal?: AbortSignal,
  ): Promise<NativeAccountSnapshot> {
    const snapshot = await nativeAccounts.read()
    if (process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION === '1')
      return snapshot
    const now = Date.now()
    const waits: Promise<void>[] = []
    // Attempts made for routes whose account identity was not yet known.
    const unidentified = new Map<string, ProfileHydration>()
    for (const account of snapshot.accounts) {
      if (
        account.type !== 'oauth' ||
        !nativeAccountCanServe(account) ||
        storedProfileIsFresh(account, now)
      )
        continue
      const key = profileHydrationKey(account.id, account.accountIdentity)
      let hydration = profileHydrations.get(key)
      if (
        hydration &&
        account.accountIdentity === undefined &&
        (hydration.lineage === undefined ||
          hydration.lineage !== profileHydrationLineage(account))
      )
        hydration = undefined
      if (!hydration && account.accountIdentity !== undefined) {
        // A profile attempt for a route whose account was not yet known
        // first authorizes the route, and that records the account identity.
        // A display that starts while such an attempt is still in flight
        // therefore sees the route as identified. Join only if the same
        // storage row and login epoch remain, not just the same route ID.
        const earlier = profileHydrations.get(profileHydrationKey(account.id))
        if (earlier && canIdentifyProfileHydration(earlier, account)) {
          hydration = earlier
          unidentified.set(account.id, earlier)
        }
      }
      if (hydration?.failed) continue
      if (!hydration && oauthProfileIsFresh(checkedProfiles.get(key), now))
        continue
      if (
        !hydration ||
        (!hydration.profile &&
          (hydration.deadline?.aborted || hydration.settled)) ||
        (hydration.profile && !oauthProfileIsFresh(hydration.profile, now))
      ) {
        if (signal?.aborted || profileHydrationShutdown.signal.aborted) continue
        hydration = startProfileHydration(account, key, signal)
        profileHydrations.set(key, hydration)
      }
      if (account.accountIdentity === undefined)
        unidentified.set(account.id, hydration)
      waits.push(waitForProfile(hydration, signal))
    }
    if (!waits.length) return snapshot
    await Promise.all(waits)
    // An account can be replaced or signed in again while profiles load.
    // Reread the accounts and attach each fetched profile only to the route
    // that still has the identity the profile was read for.
    const current = await nativeAccounts.read()
    const later = Date.now()
    for (const account of current.accounts) {
      if (account.type !== 'oauth' || !nativeAccountCanServe(account)) continue
      const key = profileHydrationKey(account.id, account.accountIdentity)
      // Authorizing a route records its account identity, so a route that
      // was unidentified when its attempt began is usually identified now.
      // File the attempt under the identified route as well; otherwise the
      // next display would repeat the request or miss the profile.
      const earlier = unidentified.get(account.id)
      if (
        earlier &&
        account.accountIdentity !== undefined &&
        !profileHydrations.has(key) &&
        canIdentifyProfileHydration(earlier, account)
      )
        profileHydrations.set(key, earlier)
      if (storedProfileIsFresh(account, later)) continue
      const profile = await displayableProfile(
        profileHydrations.get(key),
        later,
      )
      if (!profile || profile.accountIdentity !== account.accountIdentity)
        continue
      account.profile = profile
      if (account.id === 'main') {
        if (current.policyStorage.main)
          current.policyStorage.main.profile = profile
      } else {
        for (const stored of current.policyStorage.accounts)
          if (stored.id === account.id && isOAuthAccount(stored))
            stored.profile = profile
      }
    }
    return current
  }

  async function ensureProfilesForQuotaDisplay(
    storage: AccountStorage,
    _mainAccessToken?: string,
    signal?: AbortSignal,
    _mainProviderAccountUuid?: ProviderAccountUuid,
  ): Promise<AccountStorage> {
    if (process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION === '1')
      return storage
    return (await readNativeSnapshotForDisplay(signal)).policyStorage
  }

  const warnedQuotaNormalizeErrors = new Set<string>()

  async function persistPushedQuota(
    served: ServedQuotaHeaders,
    entry: QuotaEntry,
    previousEntry: QuotaEntry | null | undefined,
  ): Promise<QuotaEntry | null> {
    const snapshot = await nativeAccounts.read()
    const account = snapshot.accounts.find(
      (candidate) => candidate.id === served.accountId,
    )
    if (
      !account ||
      !served.anthropicAccountUuid ||
      account.accountIdentity !== served.anthropicAccountUuid
    )
      return null
    const quota = {
      ...mergeHeaderQuotaForPersistence(account.quota, entry.quota),
      accountIdentity: account.accountIdentity,
    }
    const persisted = served.scopedAttempt
      ? await nativeAccounts.vault.publish(served.scopedAttempt, { quota })
      : served.localSubject
        ? await nativeAccounts.publishLocal(served.localSubject, { quota })
        : false
    if (!persisted) {
      if (served.accountId === 'main') {
        if (
          quotaManager.getMain(served.mainQuotaIdentity?.quotaKey) ===
          previousEntry
        )
          quotaManager.clearMain()
      } else if (
        quotaManager.getAllFallbacks().get(served.accountId) === previousEntry
      ) {
        quotaManager.clearFallback(served.accountId)
      }
      logger.debug('quota', 'native quota publication refused', {
        accountId: served.accountId,
      })
      logger.warn('quota', 'Quota publication discarded')
      return null
    }
    // Read the store's merged accepted view, including its queued quota, rather
    // than replaying the pre-submission copy and losing fields already visible.
    const currentSnapshot = await nativeAccounts.read()
    const current = currentSnapshot.accounts.find(
      (candidate) => candidate.id === served.accountId,
    )
    if (
      !current?.quota ||
      current.accountIdentity !== served.anthropicAccountUuid ||
      current.source !== account.source
    )
      return null
    if (
      served.localSubject &&
      current.binding?.credentialEpoch !==
        served.localSubject.binding.credentialEpoch
    )
      return null
    if (
      served.scopedAttempt &&
      current.credentialId !== served.scopedAttempt.credentialId
    )
      return null
    return {
      ...entry,
      quota: current.quota,
      refreshAfter: getQuotaNextRefreshAt(
        current.quota,
        currentSnapshot.policyStorage,
        entry.checkedAt,
      ),
    }
  }

  function logPersistFailure(error: unknown) {
    logger.warn('quota', 'failed to persist harvested response quota', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  function warnQuotaNormalizeOnce(error: unknown) {
    const name = error instanceof Error ? error.name : typeof error
    const message = error instanceof Error ? error.message : String(error)
    const shape = `${name}:${message}`
    if (warnedQuotaNormalizeErrors.has(shape)) return
    warnedQuotaNormalizeErrors.add(shape)
    logger.warn('quota', 'failed to normalize response quota headers', {
      error: message,
    })
  }

  function getCredentialId(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const direct = record.credential_id
    if (typeof direct === 'string' && direct && direct !== 'main') return direct
    const vault = record.vault
    if (vault && typeof vault === 'object') {
      const nested = (vault as Record<string, unknown>).credential_id
      if (typeof nested === 'string' && nested && nested !== 'main')
        return nested
    }
    return undefined
  }

  async function publishQuotaHeaderFeed(
    served: ServedQuotaHeaders,
    entry: QuotaEntry,
  ): Promise<void> {
    if (!quotaHeaderFeedRegistry) return
    if (served.accountId === 'main' && !served.mainQuotaIdentity?.quotaKey) {
      // An unresolved main account must not overwrite verified account-bound quota.
      return
    }
    const storage =
      (await loadAccounts(accountStoragePath)) ?? createEmptyStorage()
    const mainAuth = await latestGetAuth?.()
    const mainOAuthConfigured = mainAuth?.type === 'oauth'
    const account =
      served.accountId === 'main'
        ? storage.main
        : storage.accounts.find(
            (candidate) => candidate.id === served.accountId,
          )
    const credentialId = getCredentialId(account)
    const configuredAccountCount = configuredAnthropicOAuthAccountCount({
      storage,
      mainOAuthConfigured,
    })
    const observedAtMs = entry.checkedAt
    const quota = {
      five_hour: entry.quota.five_hour,
      seven_day: entry.quota.seven_day,
      bindingWindow: entry.quota.bindingWindow,
      fallbackAdvised: entry.quota.fallbackAdvised,
      scoped: entry.quota.scoped,
      extraUsage: entry.quota.extraUsage,
      fieldSources: entry.quota.fieldSources,
    }
    const accountKey =
      credentialId ??
      (served.accountId === 'main'
        ? (served.mainQuotaIdentity?.quotaKey ?? 'main')
        : served.accountId)
    const feedEntry: QuotaHeaderFeedPublishEntry = credentialId
      ? {
          identity_source: 'credential_id',
          credential_id: credentialId,
          schema_version: QUOTA_HEADER_FEED_SCHEMA_VERSION,
          provider: 'anthropic',
          configured_account_count: configuredAccountCount,
          observed_at_ms: observedAtMs,
          anthropic_account_uuid: served.anthropicAccountUuid ?? null,
          quota,
          accountKey,
        }
      : served.accountId === 'main' && served.mainQuotaIdentity?.quotaKey
        ? {
            identity_source: 'account_ref',
            account_ref: served.mainQuotaIdentity.quotaKey,
            schema_version: QUOTA_HEADER_FEED_SCHEMA_VERSION,
            provider: 'anthropic',
            configured_account_count: configuredAccountCount,
            observed_at_ms: observedAtMs,
            anthropic_account_uuid: served.anthropicAccountUuid ?? null,
            quota,
            accountKey,
          }
        : served.accountId === 'main'
          ? {
              identity_source: 'none',
              schema_version: QUOTA_HEADER_FEED_SCHEMA_VERSION,
              provider: 'anthropic',
              configured_account_count: configuredAccountCount,
              observed_at_ms: observedAtMs,
              anthropic_account_uuid: served.anthropicAccountUuid ?? null,
              quota,
              accountKey,
            }
          : {
              identity_source: 'account_ref',
              account_ref: served.accountId,
              schema_version: QUOTA_HEADER_FEED_SCHEMA_VERSION,
              provider: 'anthropic',
              configured_account_count: configuredAccountCount,
              observed_at_ms: observedAtMs,
              anthropic_account_uuid: served.anthropicAccountUuid ?? null,
              quota,
              accountKey,
            }
    await quotaHeaderFeedRegistry.publish(feedEntry)
  }

  function logQuotaHeaderFeedFailure(error: unknown) {
    logger.debug('quota', 'failed to publish quota header feed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  function harvestQuotaHeaders(
    headers: Headers,
    served: ServedQuotaHeaders,
  ): void {
    try {
      if (!isQuotaBearingHeaderFrame(headers)) {
        logger.trace('quota', 'skipped non-quota response headers', {
          account: served.accountId,
        })
        return
      }
      const incoming = normalizeQuotaHeaders(headers)
      const mainQuotaIdentity =
        served.accountId === 'main' ? served.mainQuotaIdentity : undefined
      if (served.accountId === 'main') {
        if (
          !mainQuotaIdentity ||
          quotaManager.getMainQuotaIdentityGeneration() !==
            mainQuotaIdentity.generation
        ) {
          logger.trace('quota', 'discarded stale main quota headers', {
            boundIdentity: mainQuotaIdentity?.quotaKey,
            currentGeneration: quotaManager.getMainQuotaIdentityGeneration(),
          })
          return
        }
      }
      const previousEntry =
        served.accountId === 'main'
          ? quotaManager.getMain(mainQuotaIdentity?.quotaKey)
          : quotaManager.getAllFallbacks().get(served.accountId)
      const checkedAt = incoming.checkedAt ?? Date.now()
      const lineage = headerRoutingLineage(
        served.localSubject,
        served.scopedAttempt,
      )
      const observation: HeaderRoutingObservation | undefined =
        lineage && served.anthropicAccountUuid
          ? {
              lineage,
              accountUuid: served.anthropicAccountUuid,
              entry: {
                quota: {
                  ...incoming,
                  accountIdentity: served.anthropicAccountUuid,
                },
                checkedAt,
                refreshAfter: checkedAt,
              },
              generalExhausted: (['five_hour', 'seven_day'] as const).some(
                (key) => {
                  const raw = headers.get(
                    key === 'five_hour'
                      ? 'anthropic-ratelimit-unified-5h-utilization'
                      : 'anthropic-ratelimit-unified-7d-utilization',
                  )
                  return (
                    incoming[key] !== undefined &&
                    raw !== null &&
                    Number.isFinite(Number(raw)) &&
                    Number(raw) >= 1
                  )
                },
              ),
            }
          : undefined
      if (observation) {
        headerRoutingObservations.delete(served.accountId)
        if (
          headerRoutingObservations.size >= HEADER_ROUTING_OBSERVATION_LIMIT
        ) {
          const oldest = headerRoutingObservations.keys().next().value
          if (oldest !== undefined) headerRoutingObservations.delete(oldest)
        }
        headerRoutingObservations.set(served.accountId, observation)
      }
      void (async () => {
        let committed = false
        try {
          let persistedEntry: QuotaEntry | null
          try {
            persistedEntry = await persistPushedQuota(
              served,
              { quota: incoming, checkedAt, refreshAfter: checkedAt },
              previousEntry,
            )
          } catch (error) {
            logPersistFailure(error)
            return
          }
          if (persistedEntry === null) return
          if (
            served.accountId === 'main' &&
            quotaManager.getMainQuotaIdentityGeneration() !==
              mainQuotaIdentity?.generation
          )
            return
          // Store acceptance fences the row, credential epoch and identity:
          // only accepted readings reach cache, sidebar or feed. Acceptance
          // need not mean the shared pool write has reached disk yet.
          const entry = persistedEntry
          if (
            observation &&
            headerRoutingObservations.get(served.accountId) === observation
          ) {
            observation.entry = entry
            committed = true
          }
          if (served.accountId === 'main')
            quotaManager.setMain(mainQuotaIdentity?.quotaKey, entry)
          else
            quotaManager.setFallback(served.accountId, entry, {
              authLineageId: served.authLineageId,
            })
          void refreshSidebarQuota().catch(() => {})
          await publishQuotaHeaderFeed(served, entry)
          logger.debug('quota', 'harvested response quota', {
            account: served.accountId,
            fiveHourPercent: entry.quota.five_hour?.usedPercent,
            sevenDayPercent: entry.quota.seven_day?.usedPercent,
            source: 'headers',
          })
        } finally {
          if (
            !committed &&
            observation &&
            headerRoutingObservations.get(served.accountId) === observation
          ) {
            headerRoutingObservations.delete(served.accountId)
            logger.debug('quota', 'discarded pending response quota', {
              accountId: served.accountId,
            })
          }
        }
      })().catch(logQuotaHeaderFeedFailure)
      logger.trace('quota', 'response quota awaiting publication', {
        account: served.accountId,
      })
    } catch (error) {
      warnQuotaNormalizeOnce(error)
    }
  }

  let fallbackQuotaRefreshQueue: Promise<void> = Promise.resolve()
  // `purpose` tells the vault runtime whether this sweep is the background
  // tick or a request's admission. That decides how it uses insula (the
  // vault daemon's quota monitor) instead of a usage GET; see
  // NativeVaultQuotaPurpose. Explicit refreshes leave it unset and always
  // poll Anthropic.
  function refreshFallbackQuotas(
    force = false,
    requiredByPolicy = false,
    modelId?: string,
    purpose?: QuotaReadingPurpose,
  ) {
    // Startup and request preflight can both observe missing quota before
    // either poll finishes. Serialize the read/check/poll sequence so the
    // next sweep sees the preceding result. Explicit refresh still polls.
    const operation = fallbackQuotaRefreshQueue.then(() =>
      pollFallbackQuotas(force, requiredByPolicy, modelId, purpose),
    )
    fallbackQuotaRefreshQueue = operation.then(
      () => {},
      () => {},
    )
    return operation
  }
  async function pollFallbackQuotas(
    force: boolean,
    requiredByPolicy: boolean,
    modelId?: string,
    purpose?: QuotaReadingPurpose,
  ) {
    const snapshot = await nativeAccounts.read()
    const unavailable = new Set<string>()
    if (
      !force &&
      !requiredByPolicy &&
      snapshot.policyStorage.quota?.enabled === false
    )
      return unavailable
    for (const account of snapshot.accounts) {
      if (account.id === 'main' || account.type !== 'oauth') continue
      if (!nativeAccountCanServe(account)) {
        if (requiredByPolicy) unavailable.add(account.id)
        continue
      }
      if (
        !force &&
        getQuotaNextRefreshAt(
          account.quota,
          snapshot.policyStorage,
          quotaSnapshotCheckedAt(account.quota),
        ) > Date.now() &&
        (!modelId ||
          stickyQuotaSnapshotIsFresh(
            account.quota,
            snapshot.policyStorage,
            Date.now(),
            modelId,
          ))
      )
        continue
      try {
        const reading = await quotaManager.refreshFallback(
          account.id,
          '',
          snapshot.policyStorage.accounts.find(
            (candidate) =>
              candidate.id === account.id && isOAuthAccount(candidate),
          ) as OAuthAccount | undefined,
          force ? undefined : purpose,
        )
        if (!reading) {
          unavailable.add(account.id)
          logger.debug(
            'quota',
            'fallback quota preflight returned no reading',
            { accountId: account.id, requiredByPolicy },
          )
        }
      } catch (error) {
        // A local account that another writer is still saving is the account
        // routing chose: fail the request retryably instead of routing it
        // past that account.
        if (requiredByPolicy && isNativeTransientAccountError(error))
          throw error
        // A refused account read need not persist a quota error. Keep that
        // missing reading visible to admission without poisoning token state.
        unavailable.add(account.id)
        logFallbackQuotaPreflightWarning(account.id, requiredByPolicy, error)
      }
    }
    // Poll readings are visible in memory; publication and sidebar I/O must
    // not delay the active request's route.
    void refreshSidebarQuota().catch(() => {})
    return unavailable
  }
  const fallbackManager = {
    refreshQuotaForDueAccounts: async () => {
      await refreshFallbackQuotas()
    },
    refreshQuotaForAllAccounts: async (_options?: { force?: boolean }) => {
      await refreshFallbackQuotas(true)
    },
    refreshAccount: async (
      account: OAuthAccount,
      _storage: AccountStorage,
      options?: { force?: boolean },
    ) => {
      const credential = await authorizeOAuth(
        account.id,
        undefined,
        options?.force ? account.access : undefined,
      )
      return {
        ...account,
        access: credential.accessToken,
        expires: credential.expires,
      }
    },
    refreshAccountQuota: async (
      account: OAuthAccount,
      _storage: AccountStorage,
    ) => {
      assertNativeEnvironment()
      const quota = await nativeAccounts.fetchQuota(account.id)
      return { account: { ...account, quota }, fetched: true }
    },
    getUsableFallbackAccounts: async (
      storage: AccountStorage | null | undefined,
      options?: { modelId?: string },
    ) => {
      storage = storage ?? null
      const usable: OAuthAccount[] = []
      const currentAccounts = storage?.accounts.some(
        (account) =>
          isOAuthAccount(account) && headerRoutingObservations.has(account.id),
      )
        ? (await nativeAccounts.read()).accounts
        : []
      for (const account of storage?.accounts ?? []) {
        if (!isOAuthAccount(account) || !nativeAccountCanServe(account))
          continue
        const currentAccount = currentAccounts.find(
          (view) => view.id === account.id,
        )
        const committedQuota =
          quotaManager.getFallback(
            account.id,
            currentAccount?.binding
              ? { authLineageId: JSON.stringify(currentAccount.binding) }
              : account,
          )?.quota ??
          currentAccount?.quota ??
          account.quota
        const quota =
          currentAccount && storage
            ? routingAccountQuota(
                { ...currentAccount, quota: committedQuota },
                storage,
              )
            : committedQuota
        if (
          !quotaSnapshotPassesPolicy(quota, storage) ||
          !quotaSnapshotPassesModelScope(quota, options?.modelId) ||
          (isKillswitchEnabled(storage) &&
            !killswitchPassesPolicy(
              quota,
              storage,
              account.id,
              options?.modelId,
            ))
        )
          continue
        if (isScopedCustodyActive(storage)) {
          // Collect vault candidates using roster and quota metadata only.
          // Authorize them at dispatch, outside the local-account catch below,
          // so vault access and integrity failures reject the request instead
          // of silently removing a candidate.
          if (isFallbackAccountVaultServed(account.id, storage))
            usable.push(account)
          continue
        }
        try {
          const credential = await authorizeOAuth(
            account.id,
            undefined,
            undefined,
            options?.modelId,
          )
          usable.push({
            ...account,
            access: credential.accessToken,
            expires: credential.expires,
          })
        } catch (error) {
          // A fallback that another writer is still saving cannot be skipped:
          // skipping it would send this request through a different account.
          if (isNativeTransientAccountError(error)) throw error
          // Do not use credentials that failed authorization. A failed or
          // missing quota reading also cannot prove the account's general
          // limits are exhausted and therefore cannot permit paid fallback.
        }
      }
      return usable
    },
  }
  async function refreshNativeFallbacks() {
    assertNativeEnvironment()
    const snapshot = await nativeAccounts.read()
    if (
      snapshot.mode === 'local' &&
      snapshot.policyStorage.refresh?.enabled !== false
    ) {
      for (const account of snapshot.accounts) {
        if (
          account.id === 'main' ||
          account.type !== 'oauth' ||
          !nativeAccountCanServe(account)
        )
          continue
        try {
          const credential = await authorizeOAuth(account.id)
          // Proactive refresh must honor an existing account backoff even when
          // the still-valid access token enters the refresh-before-expiry window.
          if (
            refreshBackoffActive(
              account.lastRefreshError,
              account.accountIdentity,
              Date.now(),
              undefined,
            )
          )
            continue
          if (
            credential.localSource !== 'rotated' &&
            credential.localSource !== 'adopted' &&
            (!credential.expires ||
              credential.expires - Date.now() <=
                mainRefreshBeforeExpiryMs(snapshot.policyStorage))
          ) {
            await authorizeOAuth(
              account.id,
              undefined,
              undefined,
              undefined,
              'refresh',
            )
          }
        } catch {
          // The runtime records whether refresh failed temporarily or the
          // provider rejected the refresh token with invalid_grant. A subsequent
          // quota poll cannot repair that rejected token or clear its error.
        }
      }
    }
    await refreshFallbackQuotas(false, false, undefined, 'background')
  }
  const canStartNativeServices =
    initialStorage !== null && process.env.OPENCODE_AUTH_CONTENT === undefined
  let knownVaultFallbacks = new Set<string>()
  async function refreshDiscoveredVaultFallbacks() {
    const snapshot = await nativeAccounts.read()
    const current = new Set(
      snapshot.accounts
        .filter(
          (account) =>
            account.id !== 'main' &&
            account.source === 'vault' &&
            account.type === 'oauth' &&
            nativeAccountCanServe(account),
        )
        .map((account) => account.id),
    )
    const discovered = [...current].some((id) => !knownVaultFallbacks.has(id))
    knownVaultFallbacks = current
    // Discovery and request preflight share the due sweep, so an arriving
    // account gets its first reading without duplicating an in-flight poll.
    if (discovered)
      await refreshFallbackQuotas(false, false, undefined, 'background')
    await refreshSidebarQuota()
  }
  const vaultWatch =
    canStartNativeServices && isScopedCustodyActive(initialStorage)
      ? nativeAccounts.vault.watch({
          intervalMs: runtimeOverrides.scopedRosterPollIntervalMs ?? 2000,
          shouldRefresh: () => process.env.OPENCODE_AUTH_CONTENT === undefined,
          onRefresh: refreshDiscoveredVaultFallbacks,
          setInterval: runtimeTimers.setInterval,
          clearInterval: runtimeTimers.clearInterval,
        })
      : undefined
  const fallbackRefreshReady = canStartNativeServices
    ? (vaultWatch
        ? vaultWatch.ready.then(() => refreshNativeFallbacks())
        : refreshNativeFallbacks()
      ).catch(() => {})
    : Promise.resolve()
  const fallbackRefreshTimer = canStartNativeServices
    ? runtimeTimers.setInterval(() => {
        void refreshNativeFallbacks().catch(() => {})
      }, FALLBACK_BACKGROUND_TICK_MS +
        jitterMs(MAIN_AUTH_REFRESH_TICK_JITTER_MS))
    : null
  fallbackRefreshTimer?.unref?.()
  const fallbackCustodyStateFor = (
    accountId: string,
    storage: AccountStorage | null,
  ): Exclude<CustodyStatusState, 'na'> => {
    const state = custodyStateFor({ id: accountId, role: 'fallback' }, storage)
    return state === 'na' ? 'off' : state
  }
  const cacheDiagnosticsTracker = new CacheDiagnosticsTracker()
  const cacheDiagnosticsBetaTracker = new CacheDiagnosticsBetaTracker()
  type CacheDiagnosticsResponse = {
    request?: CacheDiagnosticsRequestContext
    trackSessionId?: string
    source: CacheDiagnosticsSource
    accountId: string
    synthetic: boolean
    betasHash: string
    betas: string[]
    requestedModel?: string
    dump: DumpHandle | null
    status: number
    streaming: boolean
    dumpWrite: Promise<void>
    messageStart?: Record<string, unknown>
    // Response inspection copies this metadata when it replaces the Response.
    toolNameMap?: ToolNameMap
  }
  const cacheDiagnosticsResponses = new WeakMap<
    Response,
    CacheDiagnosticsResponse
  >()
  const cacheKeepDiagnosticsRequests = new Map<
    string,
    CacheDiagnosticsRequestContext & {
      accountId: string
      synthetic: boolean
      betasHash?: string
      betas?: string[]
      requestedModel?: string
    }
  >()

  async function getCacheDiagnosticsBetas(headers: Headers) {
    const betas = (headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim())
      .filter(Boolean)
      .sort()
    return {
      betas,
      betasHash: await computeXxhash64Hex(betas.join(',')),
    }
  }

  function observeCacheDiagnosticsMessage(input: {
    source: CacheDiagnosticsSource
    accountId: string
    synthetic: boolean
    betasHash: string
    betas: string[]
    requestedModel?: string
    request?: CacheDiagnosticsRequestContext
    trackSessionId?: string
    status: number
    message: unknown
    receivedAt: number
    dump?: DumpHandle | null
    dumpWrite?: Promise<void>
  }) {
    try {
      if (!input.request) return
      const observed = buildCacheDiagnosticsRecord({
        request: input.request,
        source: input.source,
        accountId: input.accountId,
        synthetic: input.synthetic,
        betasHash: input.betasHash,
        requestedModel: input.requestedModel,
        onWarning: (message) => logger.warn('cache-diagnostics', message),
        message: input.message,
        receivedAt: input.receivedAt,
      })
      if (!observed.record || !observed.messageId) {
        logger.debug('cache-diagnostics', 'skipped invalid response envelope', {
          status: input.status,
        })
        return
      }
      logger.debug(
        'cache-diagnostics',
        formatCacheDiagnosticsLogLine(observed.record),
      )
      const betaLine = cacheDiagnosticsBetaTracker.capture(
        input.betasHash,
        input.betas,
      )
      if (betaLine) logger.debug('cache-diagnostics', betaLine)
      if (observed.canary) {
        logger.warn(
          'cache-diagnostics',
          'short-gap previous_message_not_found',
          {
            message_id: observed.canary.messageId,
            previous_message_id: observed.canary.previousMessageId,
          },
        )
      }
      if (input.trackSessionId) {
        cacheDiagnosticsTracker.capture(
          input.trackSessionId,
          observed.messageId,
          input.receivedAt,
        )
      }
    } catch (error) {
      logger.debug('cache-diagnostics', 'response observation failed', {
        status: input.status,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function observeCacheDiagnosticsResponse(
    response: Response,
    message: unknown,
    complete = true,
  ) {
    const context = cacheDiagnosticsResponses.get(response)
    if (!context) return
    if (
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      !complete
    ) {
      context.messageStart = message as Record<string, unknown>
    }
    context.dumpWrite = context.dumpWrite
      .then(() =>
        dumpResponseArtifact(context.dump, {
          status: context.status,
          message,
          complete,
        }),
      )
      .catch(() => {})
    observeCacheDiagnosticsMessage({
      ...context,
      message,
      receivedAt: Date.now(),
    })
  }

  function observeCacheDiagnosticsDelta(
    response: Response,
    delta: { usage?: Record<string, unknown>; stopReason?: string },
  ) {
    const context = cacheDiagnosticsResponses.get(response)
    if (!context) return
    const start = context.messageStart ?? {}
    const startUsage =
      start.usage &&
      typeof start.usage === 'object' &&
      !Array.isArray(start.usage)
        ? (start.usage as Record<string, unknown>)
        : {}
    const message = {
      ...start,
      ...(delta.usage ? { usage: { ...startUsage, ...delta.usage } } : {}),
      ...(delta.stopReason ? { stop_reason: delta.stopReason } : {}),
    }
    context.dumpWrite = context.dumpWrite
      .then(() =>
        dumpResponseArtifact(context.dump, {
          status: context.status,
          message,
          complete: true,
        }),
      )
      .catch(() => {})
  }

  function attachCacheDiagnosticsResponse(
    response: Response,
    input: Omit<CacheDiagnosticsResponse, 'dumpWrite'>,
  ) {
    const dumpWrite = Promise.resolve(
      dumpResponseArtifact(input.dump, {
        status: input.status,
        message: null,
        complete: false,
      }),
    ).catch(() => {})
    cacheDiagnosticsResponses.set(response, { ...input, dumpWrite })
  }

  let latestGetActivation:
    | (() => Promise<{ type: string; active: boolean }>)
    | null = null
  // OpenCode's own reader for this host's Anthropic login, captured from the
  // first auth.loader call. The vault login method prefers it to reading
  // OpenCode's auth file itself.
  let latestHostGetAuth: (() => Promise<unknown>) | null = null

  function isRealHostLogin(value: unknown): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      mainCustodyDimension(
        value as Parameters<typeof mainCustodyDimension>[0],
      ) === 'R'
    )
  }

  /** The native placeholder, field for field; a look-alike is a different login. */
  function isExactNativePlaceholder(auth: unknown) {
    const placeholder = custodyTombstoneOAuth('anthropic')
    if (!auth || typeof auth !== 'object') return false
    const value = auth as Record<string, unknown>
    return (
      value.type === placeholder.type &&
      value.access === placeholder.access &&
      value.refresh === placeholder.refresh &&
      value.expires === placeholder.expires
    )
  }

  /**
   * What OpenCode's login store holds for Anthropic: 'absent' or the kind of
   * login. Uses OpenCode's reader when a loader call supplied one; otherwise
   * reads OpenCode's auth file without changing it. Anything that cannot be
   * read or recognized with certainty throws, so callers refuse rather than
   * treat the slot as empty.
   */
  async function hostAnthropicLoginKind(): Promise<
    ReturnType<typeof inspectNativeHostAuthEntry>['kind']
  > {
    if (latestHostGetAuth) {
      // OpenCode's reader returns the Anthropic entry itself; undefined means
      // there is none, while null or a malformed entry is refused.
      const entry = await latestHostGetAuth()
      return inspectNativeHostAuthEntry(
        'opencode',
        entry === undefined ? {} : { anthropic: entry },
      ).kind
    }
    if (process.env.OPENCODE_AUTH_CONTENT !== undefined)
      throw new Error(
        'OpenCode logins cannot be checked while OPENCODE_AUTH_CONTENT is set',
      )
    return readNativeHostAuthKind('opencode', getOpenCodeAuthPath())
  }

  /**
   * The vault login only writes the native placeholder into an empty
   * Anthropic slot, and only while this host is enrolled with the vault.
   */
  async function requireVaultLoginAllowed() {
    if ((await readNativeEnrollmentMode('opencode')) !== 'claustrum')
      throw new Error(
        'This host is not connected to the credential vault; run setup to connect it first',
      )
    if ((await hostAnthropicLoginKind()) !== 'absent')
      throw new Error(
        'OpenCode already holds an Anthropic login; remove it before choosing the vault login',
      )
  }
  const vaultLoginMethod = {
    label: 'Claude via credential vault',
    type: 'oauth' as const,
    authorize: async () => {
      await requireVaultLoginAllowed()
      return {
        url: '',
        instructions:
          'Claude requests use the credential vault this host is connected to. OpenCode stores only a placeholder, never a credential.',
        method: 'auto' as const,
        callback: async () => {
          // The slot or enrollment may have changed while OpenCode waited.
          await requireVaultLoginAllowed()
          const placeholder = custodyTombstoneOAuth('anthropic')
          return {
            type: 'success' as const,
            access: placeholder.access,
            refresh: placeholder.refresh,
            expires: placeholder.expires,
          }
        },
      }
    },
  }
  const cacheKeepRegistry = new CacheKeepSessionRegistry({
    directory:
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR ||
      getDefaultCacheKeepRegistryDirectory('opencode'),
  })
  let aggregateCacheKeepSessions: ReturnType<
    CacheKeepManager['trackedSessions']
  > = []
  const cacheKeepScopedAttempts = new Map<number, NativeOAuthAuthorization>()
  const cacheKeepManager = new CacheKeepManager({
    loadStorage: () => loadAccounts(accountStoragePath),
    // Prewarms carry an OAuth bearer: recheck the destination, no redirects.
    fetchImpl: fetchOAuth,
    setIntervalImpl: runtimeTimers.setInterval,
    clearIntervalImpl: runtimeTimers.clearInterval,
    onTrackedSessionsChanged: async (sessions) => {
      await cacheKeepRegistry.publish(sessions)
      aggregateCacheKeepSessions = await cacheKeepRegistry.list(sessions)
    },
    prepareBody: (bodyText, target) => {
      if (
        !new Headers(target.headers)
          .get('anthropic-beta')
          ?.split(',')
          .map((beta) => beta.trim())
          .includes(CACHE_DIAGNOSTICS_BETA)
      ) {
        return bodyText
      }
      try {
        const body = JSON.parse(bodyText) as Record<string, unknown>
        const previous = cacheDiagnosticsTracker.previousFor(target.id)
        const previousMessageId = previous?.messageId ?? null
        applyCacheDiagnosticsOptIn(body, previousMessageId)
        cacheKeepDiagnosticsRequests.set(target.id, {
          sessionId: target.id,
          previousMessageId,
          ...(previous
            ? { previousMessageReceivedAt: previous.receivedAt }
            : {}),
          isSubagent: target.isSubagent,
          ttlSent: summarizeCacheTtl(body),
          accountId: target.oauthAccountId ?? 'main',
          synthetic: true,
          requestedModel:
            typeof body.model === 'string' ? body.model : undefined,
        })
        return JSON.stringify(body)
      } catch {
        return bodyText
      }
    },
    onResponse: async ({
      target,
      bodyText,
      status,
      data,
      receivedAt,
      attempt,
    }) => {
      const authorization = cacheKeepScopedAttempts.get(attempt.id)
      if (status === 401 && authorization?.scopedAttempt) {
        await reportVault401(authorization.scopedAttempt, 'direct')
      }
      // A successful source warm counts toward the round's idle cap.
      if (target.sourceWarm && status >= 200 && status < 300) {
        fableFallbackManager.noteSourceWarmSentForTarget(target.id)
      }
      const prepared = cacheKeepDiagnosticsRequests.get(target.id)
      if (!prepared?.betasHash || !prepared.betas) {
        cacheKeepDiagnosticsRequests.delete(target.id)
        return
      }
      try {
        const sentBody = JSON.parse(bodyText)
        const diagnostics =
          sentBody && typeof sentBody === 'object' && !Array.isArray(sentBody)
            ? (sentBody as { diagnostics?: unknown }).diagnostics
            : undefined
        const previousMessageId =
          diagnostics &&
          typeof diagnostics === 'object' &&
          !Array.isArray(diagnostics) &&
          (diagnostics as { previous_message_id?: unknown })
            .previous_message_id === prepared.previousMessageId
            ? prepared.previousMessageId
            : undefined
        if (previousMessageId === undefined) return
        observeCacheDiagnosticsMessage({
          source: 'prewarm_cachekeep',
          accountId: prepared.accountId,
          synthetic: prepared.synthetic,
          betasHash: prepared.betasHash,
          betas: prepared.betas,
          requestedModel: prepared.requestedModel,
          request: {
            ...prepared,
            previousMessageId,
            ttlSent: summarizeCacheTtl(sentBody),
          },
          trackSessionId: target.id,
          status,
          message: data,
          receivedAt,
        })
      } catch {
      } finally {
        cacheKeepDiagnosticsRequests.delete(target.id)
      }
    },
    onComplete: ({ attempt }) => {
      cacheKeepScopedAttempts.delete(attempt.id)
    },
    retryOnUnauthorized: async ({ target, headers, attempt }) => {
      const served = cacheKeepScopedAttempts.get(attempt.id)
      if (!served) return undefined
      let modelId: string | undefined
      try {
        const body = JSON.parse(target.bodyText)
        if (typeof body.model === 'string') modelId = body.model
      } catch {}
      if (
        served.scopedAttempt &&
        !(await prepareVaultRetry(
          served.scopedAttempt,
          'cachekeep',
          attempt.signal,
        ))
      )
        return undefined
      const current = await authorizeOAuth(
        target.oauthAccountId ?? 'main',
        attempt.signal,
        served.scopedAttempt ? undefined : served.accessToken,
        modelId,
        'cachekeep',
      )
      if (
        current.accountIdentity !== served.accountIdentity ||
        Boolean(current.scopedAttempt) !== Boolean(served.scopedAttempt)
      )
        return undefined
      if (
        served.scopedAttempt &&
        (!current.scopedAttempt ||
          current.scopedAttempt.credentialId !==
            served.scopedAttempt.credentialId ||
          current.scopedAttempt.recordVersion <=
            served.scopedAttempt.recordVersion)
      )
        return undefined
      if (!served.scopedAttempt && current.accessToken === served.accessToken)
        return undefined
      const rotatedHeaders = new Headers(headers)
      rotatedHeaders.set('authorization', `Bearer ${current.accessToken}`)
      cacheKeepScopedAttempts.set(attempt.id, current)
      return rotatedHeaders
    },
    prepareHeaders: async (headers, target, attempt) => {
      // A remembered URL gets the same destination rule as a live request;
      // refuse it before any credential is authorized for the prewarm.
      if (!isAllowedOAuthDestination(target.url)) return undefined
      const accountId = target.oauthAccountId ?? 'main'
      let modelId: string | undefined
      try {
        const body = JSON.parse(target.bodyText)
        if (typeof body.model === 'string') modelId = body.model
      } catch {}
      const credential = await authorizeOAuth(
        accountId,
        attempt.signal,
        undefined,
        modelId,
        'cachekeep',
      )
      if (
        target.oauthAccountIdentity &&
        credential.accountIdentity !== target.oauthAccountIdentity
      )
        throw new NativeAccountRefusal('credential-changed')
      const accessToken = credential.accessToken
      cacheKeepScopedAttempts.set(attempt.id, credential)
      try {
        const parsedBody = JSON.parse(target.bodyText) as Record<
          string,
          unknown
        >
        const identity = nativeWireIdentity(credential.accountIdentity)
        headers.delete('anthropic-beta')
        setOAuthHeaders(headers, accessToken, {
          body: parsedBody,
          identity,
        })
        headers.set(
          'anthropic-beta',
          mergeAnthropicBetas(headers.get('anthropic-beta'), [
            CACHE_KEEP_EXTENDED_TTL_BETA,
          ]),
        )
        if (parsedBody.speed === 'fast') addFastModeBetaHeader(headers)
        const prepared = cacheKeepDiagnosticsRequests.get(target.id)
        if (prepared) {
          const { betas, betasHash } = await getCacheDiagnosticsBetas(headers)
          prepared.betas = betas
          prepared.betasHash = betasHash
        }
      } catch {
        setOAuthHeaders(headers, accessToken)
      }

      const finalCredential = await authorizeOAuth(
        accountId,
        attempt.signal,
        undefined,
        modelId,
        'cachekeep',
      )
      if (
        finalCredential.accountIdentity !== credential.accountIdentity ||
        Boolean(finalCredential.scopedAttempt) !==
          Boolean(credential.scopedAttempt)
      )
        throw new NativeAccountRefusal('credential-changed')
      headers.set('authorization', `Bearer ${finalCredential.accessToken}`)
      cacheKeepScopedAttempts.set(attempt.id, finalCredential)
      if (target.sourceWarm) {
        // The warm must still belong to the account the source request was
        // sent on. The same-account re-authorization above already fenced
        // this dispatch; this fences the round: a replaced account or a
        // rotated credential stops the warm for good instead of warming
        // another account's cache.
        const kept = fableFallbackManager.sourceWarmForTarget(target.id)
        if (
          !kept ||
          kept.oauthAccountId !== target.oauthAccountId ||
          (kept.accountIdentity !== undefined &&
            finalCredential.accountIdentity !== kept.accountIdentity)
        ) {
          fableFallbackManager.dropSourceWarmForTarget(target.id)
          cacheKeepManager.untrack(target.id)
          logger.warn(
            'cachekeep',
            'source warm refused: bound account changed',
            {
              session: target.id,
              reason: 'source-warm-account-changed',
            },
          )
          return undefined
        }
      }
      return headers
    },
    validatePrewarm: ({ target, warmBodyText }) => {
      if (!target.sourceWarm) return { ok: true as const }
      const kept = fableFallbackManager.sourceWarmForTarget(target.id)
      if (!kept) {
        // The round ended (or never kept a source) while the target lived
        // on: nothing is left to warm.
        cacheKeepManager.untrack(target.id)
        return { ok: false, reason: 'source-round-ended' }
      }
      if (kept.warmsSinceUserTurn >= cacheKeepSourceWarmIdleCap(kept.model)) {
        // Idle for the whole economic life of the warm: stop for good. A
        // new user turn before the cap resets the count instead.
        fableFallbackManager.dropSourceWarmForTarget(target.id)
        return { ok: false, reason: 'source-warm-idle-cap' }
      }
      const warmFingerprint = cacheWarmCacheablePrefixFingerprint(warmBodyText)
      const keptFingerprint = cacheWarmCacheablePrefixFingerprint(kept.bodyText)
      if (
        !warmFingerprint ||
        !keptFingerprint ||
        warmFingerprint !== keptFingerprint
      ) {
        // The kept prefix no longer matches what the warm would refresh
        // (compaction, history edit, or a corrupted keep): refuse it rather
        // than writing a cache entry the return cannot read.
        fableFallbackManager.dropSourceWarmForTarget(target.id)
        return { ok: false, reason: 'source-prefix-mismatch' }
      }
      return { ok: true as const }
    },
  })

  // Track one recovery round's kept source prefix as a second CacheKeep
  // target. It reuses the live prewarm path (same lead, same auth, same
  // retry and logging), keyed so it cannot collide with the session's live
  // target. A round that ends before expiry sends nothing: the target is
  // removed on the round's end and the tick only fires at the lead.
  async function syncSourceWarmTarget(plan: FableFallbackPlan) {
    const family = recoverableRefusalFamily(plan.requestedModel)
    if (!family) return
    const targetId = sourceWarmTargetId(plan.sessionId, family)
    const kept = fableFallbackManager.sourceWarmFor(plan.recoveryKey)
    if (!kept) {
      cacheKeepManager.untrack(targetId)
      return
    }
    let storage: AccountStorage | null
    try {
      storage = await loadAccounts()
    } catch {
      return
    }
    const tracked = cacheKeepManager.track({
      sessionId: targetId,
      url: kept.url,
      headers: new Headers(kept.headers),
      bodyText: kept.bodyText,
      storage,
      cacheMode: 'hybrid',
      oauthAccountId: kept.oauthAccountId,
      ...(kept.accountIdentity !== undefined && {
        oauthAccountIdentity: kept.accountIdentity,
      }),
      isSubagent: kept.subagent ?? false,
      sourceWarm: true,
    })
    if (!tracked.tracked) {
      // CacheKeep policy (disabled, non-hybrid, off-schedule, subagents)
      // refused the warm: forget the prefix with the target.
      fableFallbackManager.dropSourceWarm(plan.recoveryKey)
    }
  }

  // Prime sends a minimal Haiku request after the account's quota reset to
  // start its next five-hour usage window. One shared manager and an atomic
  // claim file prevent different projects or processes firing for the same reset.

  // OpenCode stores an empty OAuth marker to enable this provider, not a token
  // that can authenticate requests. Prime and CacheKeep must still validate
  // the current local credentials or freshly authorize them through the vault.
  async function getCurrentMainCredential(signal?: AbortSignal): Promise<{
    accessToken: string
    credentialAccountId?: ProviderAccountUuid
    scopedAttempt?: NativeCustodyReceipt
    localSubject?: NativeKnownCredentialSubject
  }> {
    if (!latestGetActivation || !(await latestGetActivation()).active)
      throw new Error('Native main OAuth activation is not available')
    const credential = await authorizeOAuth('main', signal)
    return {
      ...credential,
      credentialAccountId: asProviderAccountUuid(credential.accountIdentity),
    }
  }

  async function refreshPrimeMainQuota(): Promise<PrimeRefreshResult> {
    const credential = await getCurrentMainCredential()
    const resolution = await resolveMainQuotaAccountIdentity(
      credential.accessToken,
      undefined,
      credential.credentialAccountId,
    )
    if (resolution.stale && credential.credentialAccountId !== undefined) {
      throw new Error('Main account identity changed before the prime refresh')
    }
    // The usage poll independently validates local credentials or obtains vault
    // authorization. Report a 401 against the tokens used for that actual poll,
    // not the tokens obtained above to resolve the main account's identity.
    const result = await quotaManager.refreshMainWithMetadata(
      mainQuotaAccountId,
      credential.accessToken,
    )
    return { quota: result.quota, fresh: result.fetched }
  }

  async function refreshPrimeFallbackQuota(
    accountId: string,
  ): Promise<PrimeRefreshResult> {
    assertNativeEnvironment()
    const storage = await loadAccounts(accountStoragePath)
    const account = storage?.accounts.find(
      (candidate): candidate is OAuthAccount =>
        candidate.id === accountId &&
        nativeAccountCanServe(candidate) &&
        isOAuthAccount(candidate),
    )
    if (!account || !storage) {
      throw new Error(`prime: OAuth account ${accountId} is unavailable`)
    }
    // This poll stores current quota for the account and tokens used to fetch it.
    // Prime uses that reading to decide whether to start the next window;
    // sendPrime sends the minimal Haiku request without repeating this poll.
    const refreshed = await fallbackManager.refreshAccountQuota(
      account,
      storage,
    )

    return {
      quota: refreshed.account.quota ?? {},
      fresh: refreshed.fetched,
    }
  }

  const primePhysicalAttempts = new Map<string, NativeOAuthAuthorization>()
  async function sendPrime(
    accountId: 'main' | string,
  ): Promise<PrimeSendResult> {
    const start = performance.now()
    let accessToken: string | undefined
    let resolvedModel: string | undefined
    let scopedAttempt: NativeCustodyReceipt | undefined
    // Token sent on the latest Prime network attempt, kept for error redaction.
    let primeSecret = ''
    // The response scope of the latest physical Prime send.
    let physicalScope: ProviderErrorResponseScope | undefined
    try {
      // The manager already checked current quota. Validate the account and
      // tokens for this Haiku send without another quota poll. An upstream 401
      // may retry once with newer credentials for the same account.
      if (
        accountId === 'main' &&
        (!latestGetActivation || !(await latestGetActivation()).active)
      )
        throw new Error('Native main OAuth activation is not available')
      // Route through rewriteUrl so the request inherits the canonical
      // ?beta=true query param like every other direct Anthropic call in
      // this codebase. The URL is rendered back to a string here because the
      // surrounding fetch wrapper and test mocks expect a string input.
      // ANTHROPIC_BASE_URL can still move it, so check the destination before
      // any token is authorized for it.
      const primeRequest = rewriteUrl(PRIME_MESSAGES_URL, { baseURL: '' })
      const primeUrl =
        primeRequest.url?.toString() ?? primeRequest.input.toString()
      requireOAuthDestination(primeUrl)
      const initialAuthorization = await authorizeOAuth(
        accountId,
        undefined,
        undefined,
        CLAUDE_HAIKU_4_5_MODEL_ID,
      )
      accessToken = initialAuthorization.accessToken
      scopedAttempt = initialAuthorization.scopedAttempt
      resolvedModel = CLAUDE_HAIKU_4_5_MODEL_ID

      if (!accessToken) {
        return { ok: false, error: 'prime: no access token available' }
      }

      const primeBody = buildPrimeRequestBody()
      const identity = nativeWireIdentity(initialAuthorization.accountIdentity)
      const body = await rewriteRequestBody(JSON.stringify(primeBody), {
        identity,
      })
      const headers = new Headers({
        'content-type': 'application/json',
      })
      setOAuthHeaders(headers, accessToken, {
        body: JSON.parse(body),
        identity,
        // Claude Code marks its own quota-check request as auxiliary.
        requestClass: 'auxiliary',
      })
      headers.delete('content-length')
      headers.delete('transfer-encoding')
      const signal = AbortSignal.timeout(30_000)
      const primeInit = { method: 'POST', headers, body, signal }
      let physicalAuthorization = await authorizeOAuth(
        accountId,
        signal,
        undefined,
        resolvedModel,
      )
      if (
        physicalAuthorization.accountIdentity !==
          initialAuthorization.accountIdentity ||
        Boolean(physicalAuthorization.scopedAttempt) !==
          Boolean(initialAuthorization.scopedAttempt)
      )
        throw new Error('Prime credential authority changed before dispatch')
      scopedAttempt = physicalAuthorization.scopedAttempt
      primeSecret = physicalAuthorization.accessToken
      headers.set('authorization', `Bearer ${primeSecret}`)
      // Each Prime network attempt gets a redaction scope holding its
      // sent token before dispatch. Redact a rejected 401 before retry
      // handling; cancellation clears the copied token before cancelling
      // the underlying connection. Prime uses a non-streaming HTTP body.
      const sendPhysical = async () => {
        const scope = createProviderErrorResponseScope([primeSecret], 'http')
        physicalScope = scope
        return scope.redactResponse(await fetchOAuth(primeUrl, primeInit))
      }
      let response = await sendPhysical()
      if (response.status === 401 && scopedAttempt && !signal.aborted) {
        let current: NativeCustodyReceipt | undefined
        try {
          current = await prepareVaultRetry(scopedAttempt, 'prime', signal)
        } catch {
          // The first 401 belongs to the original physical attempt unless
          // the vault confirms a newer version of this same account.
        }
        if (current) {
          physicalScope?.dispose()
          await response.body?.cancel().catch(() => {})
          logger.info(
            'claustrum',
            'retrying Prime after scoped credential rotation',
            {
              accountId,
              previousVersion: scopedAttempt.recordVersion,
              newVersion: current.recordVersion,
            },
          )
          physicalAuthorization = await authorizeOAuth(
            accountId,
            signal,
            undefined,
            resolvedModel,
          )
          const successor = physicalAuthorization.scopedAttempt
          if (
            !successor ||
            successor.credentialId !== scopedAttempt.credentialId ||
            successor.accountIdentity !== scopedAttempt.accountIdentity ||
            successor.recordVersion <= scopedAttempt.recordVersion
          )
            throw new Error('Prime vault retry lost its strict newer receipt')
          scopedAttempt = successor
          primeSecret = successor.accessToken
          headers.set('authorization', `Bearer ${primeSecret}`)
          response = await sendPhysical()
        }
      }
      if (
        response.status === 401 &&
        !physicalAuthorization.scopedAttempt &&
        !signal.aborted
      ) {
        const rejectedAccess = physicalAuthorization.accessToken
        const replacement = await authorizeOAuth(
          accountId,
          signal,
          rejectedAccess,
          resolvedModel,
        ).catch(() => undefined)
        if (
          replacement &&
          replacement.accessToken !== rejectedAccess &&
          replacement.accountIdentity ===
            initialAuthorization.accountIdentity &&
          !replacement.scopedAttempt
        ) {
          physicalScope?.dispose()
          await response.body?.cancel().catch(() => {})
          physicalAuthorization = await authorizeOAuth(
            accountId,
            signal,
            undefined,
            resolvedModel,
          )
          if (
            physicalAuthorization.scopedAttempt ||
            physicalAuthorization.accountIdentity !==
              initialAuthorization.accountIdentity
          )
            throw new Error('Prime local authority changed before retry')
          primeSecret = physicalAuthorization.accessToken
          headers.set('authorization', `Bearer ${primeSecret}`)
          response = await sendPhysical()
        }
      }
      const ms = Math.round(performance.now() - start)
      if (!response.ok) {
        // Prime reports this text as its failure reason. The final send's
        // scope scrubs its token, including JSON-escaped spellings, and
        // replaces an oversized body with a fixed message.
        let reason: string
        try {
          reason =
            (await response.text().catch(() => '')) || `HTTP ${response.status}`
        } finally {
          physicalScope?.dispose()
        }
        if (response.status === 401 && scopedAttempt) {
          await reportVault401(scopedAttempt, 'direct')
        }
        return { ok: false, status: response.status, ms, error: reason }
      }
      const data = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null
      const usageRaw = data?.usage as
        | { input_tokens?: number; output_tokens?: number }
        | undefined
      const usage =
        usageRaw &&
        (Number.isFinite(usageRaw.input_tokens) ||
          Number.isFinite(usageRaw.output_tokens))
          ? {
              inputTokens: Number.isFinite(usageRaw.input_tokens)
                ? usageRaw.input_tokens
                : undefined,
              outputTokens: Number.isFinite(usageRaw.output_tokens)
                ? usageRaw.output_tokens
                : undefined,
            }
          : undefined
      primePhysicalAttempts.set(accountId, physicalAuthorization)
      return { ok: true, status: response.status, ms, ...(usage && { usage }) }
    } catch (caught) {
      // No response will clear this attempt's copied token; clear it here.
      physicalScope?.dispose()
      const scope = createProviderErrorResponseScope([primeSecret], 'http')
      const error = scope.redactError(caught)
      scope.dispose()
      return {
        ok: false,
        ...(caught instanceof NativeCredentialUnavailableError &&
          caught.tokenRefreshFailed && { reason: 'token-refresh' as const }),
        ms: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const primeManagerOptions: PrimeManagerOptions = {
    storagePath: accountStoragePath,
    loadStorage: () => loadAccounts(accountStoragePath),
    getAccountFingerprint: async (accountId) => {
      if (
        accountId === 'main' &&
        (!latestGetActivation || !(await latestGetActivation()).active)
      )
        return undefined
      const credential = await authorizeOAuth(accountId)
      const fence = credential.scopedAttempt ?? credential.localSubject
      if (!fence) return undefined
      const authLineageId = await nativeAccounts.getOrCreateAuthLineage(
        accountId,
        fence,
      )
      return authLineageId ? tokenFingerprint(authLineageId) : undefined
    },
    refreshQuota: async (accountId) => {
      if (accountId === 'main') return refreshPrimeMainQuota()
      return refreshPrimeFallbackQuota(accountId)
    },
    sendPrime,
    recordSuccess: async (accountId, usage) => {
      const credential = primePhysicalAttempts.get(accountId)
      primePhysicalAttempts.delete(accountId)
      const fence = credential?.scopedAttempt ?? credential?.localSubject
      if (
        !fence ||
        !(await nativeAccounts.incrementPrimeUsage(accountId, fence, usage))
      ) {
        throw new Error(
          'Prime usage publication lost its native credential fence',
        )
      }
      const current = (await nativeAccounts.read()).accounts.find(
        (account) => account.id === accountId,
      )?.prime
      if (!current)
        throw new Error(
          'Prime usage counters are unavailable after publication',
        )
      return current
    },
    setIntervalImpl: runtimeTimers.setInterval,
    clearIntervalImpl: runtimeTimers.clearInterval,
    setTimeoutImpl: runtimeTimers.setTimeout,
    clearTimeoutImpl: runtimeTimers.clearTimeout,
  }
  const primeManagerAdoption = adoptPrimeManager(
    accountStoragePath,
    () => new PrimeManager(primeManagerOptions),
    {
      slot: ctx.directory ?? 'default',
      rebind: (manager) => manager.updateOptions(primeManagerOptions),
    },
  )
  const primeManager: PrimeManager = primeManagerAdoption.manager
  if (isPrimePersistentlyEnabled(initialStorage)) {
    primeManager.start()
  }

  async function getAllTrackedCacheKeepSessions() {
    aggregateCacheKeepSessions = await cacheKeepRegistry.list(
      cacheKeepManager.trackedSessions(),
    )
    return aggregateCacheKeepSessions
  }

  // Keep the cross-process aggregate fresh on every instance: per-request
  // sidebar writes use the in-memory view, and without this an idle instance
  // would clobber a sibling's tracked-session count with a stale zero.
  const cacheKeepAggregateRefreshIntervalMs =
    runtimeOverrides.cacheKeepAggregateRefreshIntervalMs ?? 10_000
  const cacheKeepAggregateRefreshTimer =
    cacheKeepAggregateRefreshIntervalMs > 0
      ? runtimeTimers.setInterval(() => {
          void getAllTrackedCacheKeepSessions().catch(() => {})
        }, cacheKeepAggregateRefreshIntervalMs)
      : undefined
  ;(
    cacheKeepAggregateRefreshTimer as { unref?: () => void } | undefined
  )?.unref?.()

  setCache1hState({
    enabled: isCache1hPersistentlyEnabled(initialStorage),
    mode: getCache1hPersistentMode(initialStorage),
  })
  setDumpEnabled(isDumpPersistentlyEnabled(initialStorage))
  setFastModeEnabled(isFastModePersistentlyEnabled(initialStorage))
  if (!process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL) {
    setLogLevel(getPersistedLogLevel(initialStorage) ?? 'info')
  }

  let rpcServerAdoption: RpcServerAdoption | null = null
  const dispose: NonNullable<Hooks['dispose']> = async () => {
    holderRegistration?.close()
    profileHydrationShutdown.abort()
    while (profilePublications.size) await Promise.all([...profilePublications])
    try {
      await closeOpenCodeScopedRuntime(accountStoragePath)
    } catch (error) {
      logger.warn('claustrum', 'failed to close scoped runtime', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      quotaManager.close()
    } catch {}
    try {
      await quotaHeaderFeedRegistry?.dispose()
    } catch (error) {
      logger.warn('quota-header-feed', 'failed to dispose', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // Per-instance background services must be torn down before the RPC
    // guard so a disposed instance never leaves its timer running for the
    // rest of the process. Each step is isolated: one failure cannot skip
    // the others.
    try {
      if (mainBackgroundRefreshTimer) {
        runtimeTimers.clearInterval(mainBackgroundRefreshTimer)
        mainBackgroundRefreshTimer = null
      }
    } catch (error) {
      logger.warn('main-background', 'failed to stop', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      if (fallbackRefreshTimer)
        runtimeTimers.clearInterval(fallbackRefreshTimer)
    } catch (error) {
      logger.warn('fallback-background', 'failed to stop', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      if (cacheKeepAggregateRefreshTimer !== undefined) {
        runtimeTimers.clearInterval(cacheKeepAggregateRefreshTimer)
      }
    } catch (error) {
      logger.warn('cachekeep', 'failed to stop aggregate refresh', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      cacheKeepManager.stop()
    } catch (error) {
      logger.warn('cachekeep', 'failed to stop', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      primeManagerAdoption.release()
    } catch (error) {
      logger.warn('prime', 'failed to release slot', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (!rpcServerAdoption) return
    try {
      await rpcServerAdoption.release()
    } catch (error) {
      logger.warn('rpc', 'failed to stop', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Remembers the last explicit routing decision so quota-only sidebar refreshes
  // (background main/fallback quota landing) do not reset the active account.
  let lastSidebarRouting: { activeId: string | undefined; route: string } = {
    activeId: 'main',
    route: 'main',
  }
  const sidebarStateFile = getSidebarStateFile()
  const fableRecoveryNotices = new Map<
    string,
    NonNullable<SidebarState['fableRecoveries']>[number]
  >()

  interface SidebarStateInput {
    activeId?: string
    route: string
    mainAccessToken?: string
    mainRefreshToken?: string
    routingAuthoritative?: boolean
    skipFallbackQuotaSeed?: boolean
  }

  function buildSidebarState(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
    options: SidebarStateInput,
  ): SidebarState {
    quotaManager.updateStorage(storage)
    quotaManager.seedMainFromStorage(storage, mainQuotaAccountId)
    if (!options.skipFallbackQuotaSeed) {
      quotaManager.seedFallbacksFromAccounts(
        (storage?.accounts ?? []).filter(isOAuthAccount),
      )
    }
    const mainEntry = quotaManager.getMain(mainQuotaAccountId)
    const lastApiError = quotaManager.getLastApiError()
    const mainRefreshError = storage?.refresh?.mainLastRefreshError
    const primary = storage?.claustrum?.primaryAccount
    const mainStateLine =
      isScopedCustodyActive(storage) && !nativeAccountCanServe(primary)
        ? formatNativeAccountState({
            source: 'vault',
            enabled: primary?.enabled,
            state: primary?.state,
          })
        : undefined
    return {
      main: {
        quota: mainEntry?.quota ?? null,
        enabled: primary?.enabled,
        tierLabel: formatOAuthAccountTier(storage?.main?.profile),
        quotaBackedOff: quotaManager.isBackedOff(),
        quotaBackoffUntil: lastApiError?.nextRetryAt,
        refreshBackedOff: mainRefreshError
          ? refreshBackoffActive(
              mainRefreshError,
              mainAccountId ?? storage?.mainAccountId,
              Date.now(),
              options.mainRefreshToken
                ? tokenFingerprint(options.mainRefreshToken)
                : undefined,
            )
          : false,
        refreshBackoffUntil: mainRefreshError?.nextRetryAt,
        stateLine: mainStateLine,
        quotaDated: Boolean(mainStateLine),
      },
      fallbacks: (storage?.accounts ?? [])
        .filter(
          (account): account is OAuthAccount =>
            isOAuthAccount(account) &&
            (account.enabled !== false ||
              Boolean(account.claustrumScopedCredentialId)),
        )
        .map((account) => {
          const vaultServed = isFallbackAccountVaultServed(account.id, storage)
          const custodyState = fallbackCustodyStateFor(account.id, storage)
          const stateLine =
            account.claustrumScopedCredentialId && !vaultServed
              ? formatNativeAccountState({
                  source: 'vault',
                  enabled: account.enabled !== false,
                  state: account.claustrumScopedState,
                })
              : undefined
          return {
            id: account.id,
            label: account.label,
            tierLabel: formatOAuthAccountTier(account.profile),
            // Native account reads verify the quota's current account binding.
            // Local and vault projections both omit bearer material, so an
            // empty access field must not hide their verified quota readings.
            quota: options.skipFallbackQuotaSeed
              ? null
              : (quotaManager.getFallback(account.id, account)?.quota ??
                account.quota ??
                null),
            // A fallback with a permanently-dead refresh token (400 invalid_grant)
            // is dropped by getUsableFallbackAccounts and silently degrades to
            // main — surface it as "needs re-login". Only flag truly-dead tokens
            // whose backoff is still active, not transient (429/5xx) backoff.
            needsReauth:
              account.lastRefreshError != null &&
              refreshBackoffActive(
                account.lastRefreshError,
                account.id,
                Date.now(),
                tokenFingerprint(account.refresh),
              ) &&
              isPermanentRefreshError(account.lastRefreshError),
            vaultReauth: custodyState === 'on-vault-reauth',
            vaultServed,
            custodyState,
            enabled: account.enabled !== false,
            stateLine,
            quotaDated: Boolean(stateLine),
          }
        }),
      activeId: options.activeId,
      route: options.route,
      // Same transport rule as request dispatch, and no relay unless requests
      // can actually use it (enabled, with a URL and a stored token).
      relay: effectiveRelayStatus(storage?.relay),
      fastMode: isFastModeEnabled(),
      cacheKeep: {
        enabled: isCacheKeepHybridActive(storage),
        window: isCacheKeepAlways(storage)
          ? 'always'
          : storage?.cacheKeep?.startHour != null &&
              storage?.cacheKeep?.endHour != null
            ? `${storage.cacheKeep.startHour}-${storage.cacheKeep.endHour}`
            : undefined,
        trackedSessions: aggregateCacheKeepSessions.length,
      },
      // Prime section is omitted from the wire when the feature is disabled
      // so the sidebar reads a clean `prime === undefined` and the expanded
      // view renders nothing (declutter rule). Enabled writes include
      // per-account status (next-due / last-primed / cumulative usage).
      prime: isPrimePersistentlyEnabled(storage)
        ? {
            enabled: true,
            accounts: primeManager.stats(storage),
          }
        : undefined,
      fableRecoveries:
        fableRecoveryNotices.size > 0
          ? [...fableRecoveryNotices.values()]
          : undefined,
      lastUpdated: Date.now(),
    }
  }

  function writeSidebarState(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
    options: SidebarStateInput,
    currentSnapshot?: Awaited<ReturnType<typeof nativeAccounts.read>>,
  ) {
    const routingAuthoritative = options.routingAuthoritative !== false
    if (routingAuthoritative) {
      lastSidebarRouting = { activeId: options.activeId, route: options.route }
    }

    function write(state: SidebarState) {
      return setSidebarState(state, sidebarStateFile, {
        routingAuthoritative,
        resolvePreservedRouting: routingAuthoritative
          ? undefined
          : async (current) => {
              const preservedRouting = await resolveFreshSidebarRouting(
                current,
                () => loadAccounts(accountStoragePath),
                { activeId: state.activeId, route: state.route },
              )
              const displayStorage = await overlayFailedHydratedProfiles(
                preservedRouting.freshStorage,
                currentSnapshot,
              )
              return {
                activeId: preservedRouting.activeId,
                route: preservedRouting.route,
                state: buildSidebarState(displayStorage, {
                  ...options,
                  activeId: preservedRouting.activeId,
                  route: preservedRouting.route,
                }),
              }
            },
        onRoutingResolved: routingAuthoritative
          ? undefined
          : (routing) => {
              lastSidebarRouting = routing
            },
      }).catch((error) =>
        logger.warn('sidebar', 'state write failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }

    if (routingAuthoritative) {
      const candidates = failedProfileHydrationsForStorage(storage)
      if (candidates.length > 0) {
        return overlayFailedHydratedProfiles(
          storage,
          currentSnapshot,
          candidates,
        )
          .then((displayStorage) =>
            write(buildSidebarState(displayStorage, options)),
          )
          .catch(() => {
            logger.debug(
              'quota',
              'failed to recheck account profile for sidebar',
            )
            return write(buildSidebarState(storage, options))
          })
      }
    }
    return write(buildSidebarState(storage, options))
  }

  async function resolveSidebarQuotaAccess() {
    // Read saved account quota and profile data without requesting an OAuth
    // token. Acquiring credentials can refresh main merely to redraw the sidebar.
    const storage = await loadAccounts(accountStoragePath)
    return { storage, access: undefined }
  }

  // Quota timers do not choose the model request's account. Reuse the last
  // routing decision so a display-only write cannot select main instead.
  async function refreshSidebarQuota() {
    // Rebuild the cross-process CacheKeep aggregate first: sibling plugin
    // instances (other project directories) may track sessions this instance
    // never sees, and their writes must not be clobbered with a stale zero.
    await getAllTrackedCacheKeepSessions().catch(() => {})
    const { storage, access } = await resolveSidebarQuotaAccess()
    writeSidebarState(storage, {
      activeId: lastSidebarRouting.activeId,
      route: lastSidebarRouting.route,
      mainAccessToken: access,
      mainRefreshToken: undefined,
      routingAuthoritative: false,
    })
  }

  function scheduleSidebarMainQuotaRefresh(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
    accessToken: string | undefined,
    mainQuotaIdentity?: MainQuotaIdentityBinding,
  ) {
    if (!accessToken) return
    if (storage?.quota?.enabled !== true) return
    const quotaKey = mainQuotaIdentity?.quotaKey ?? mainQuotaAccountId
    if (quotaManager.getMain(quotaKey)) return
    if (sidebarMainQuotaRefreshInFlight) return

    sidebarMainQuotaRefreshInFlight = true
    void quotaManager
      .refreshMain(quotaKey, accessToken, mainQuotaIdentity?.generation)
      .then(() => refreshSidebarQuota())
      .catch(() => {})
      .finally(() => {
        sidebarMainQuotaRefreshInFlight = false
      })
  }

  let latestGetAuth:
    | (() => Promise<{
        type: string
        access?: string
        refresh?: string
        expires?: number
      }>)
    | null = null
  let custodyStartupMismatchVerdict: string | undefined
  let mainAccountId: string | undefined
  let mainQuotaAccountId: string | undefined
  let mainServedAccessToken: string | undefined
  let mainProviderAccountUuid: ProviderAccountUuid | undefined
  let mainQuotaIdentityAccessToken: string | undefined
  let mainQuotaIdentityResolutionGeneration = 0
  const mainQuotaIdentityResolutions = new Map<
    string,
    {
      promise: Promise<MainQuotaIdentityResolution>
      recordVersion?: number
    }
  >()
  let sidebarMainQuotaRefreshInFlight = false
  let mainBackgroundRefreshTimer: ReturnType<typeof setInterval> | null = null
  // Per-process counter of replayable model requests. Drives the every-N
  // quota refresh cadence (quota.refreshEveryNRequests) for the active route.
  let sessionRequestCount = 0

  function mainRefreshBeforeExpiryMs(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
  ) {
    const minutes =
      storage?.refresh?.refreshBeforeExpiryMinutes ??
      DEFAULT_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES
    return Math.max(MIN_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES, minutes) * 60_000
  }

  function mainRefreshEnabled(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
  ) {
    return storage?.refresh?.enabled !== false
  }

  async function buildQuotaCommandSummary(refresh = false) {
    const errors = new Map<string, string>()
    if (refresh) {
      // Only the explicit refresh action polls usage. Opening the menu reads
      // saved account metadata and cannot start credential recovery or a poll.
      if (latestGetActivation && (await latestGetActivation()).active) {
        try {
          await nativeAccounts.fetchQuota('main')
        } catch {
          errors.set('main', 'Native primary usage refresh unavailable')
        }
      }
      await refreshFallbackQuotas(true)
    }
    const snapshot = await readNativeSnapshotForDisplay(
      AbortSignal.timeout(3_000),
    )
    quotaManager.updateStorage(snapshot.policyStorage)
    quotaManager.seedMainFromStorage(snapshot.policyStorage, mainQuotaAccountId)
    quotaManager.seedFallbacksFromAccounts(
      snapshot.policyStorage.accounts.filter(isOAuthAccount),
    )
    const accounts: QuotaAccountSummary[] = []
    const main = snapshot.accounts.find(
      (account) => account.id === 'main' && account.type === 'oauth',
    )
    if (main)
      accounts.push({
        name: main.label ?? 'OpenCode anthropic',
        role: 'main',
        quota: main.quota,
        tierLabel: formatOAuthAccountTier(main.profile),
        error: errors.get('main') ?? main.lastQuotaRefreshError?.message,
      })
    accounts.push(
      ...buildFallbackQuotaSummaries(snapshot.policyStorage, errors),
    )
    const checkedAt = Math.max(
      0,
      ...snapshot.accounts.map((account) =>
        quotaSnapshotCheckedAt(account.quota),
      ),
    )
    return buildClaudeQuotaSummary({
      accounts,
      refreshedAt: checkedAt || undefined,
    })
  }

  async function refreshSidebarAfterMutation(
    updatedStorage: AccountStorage | null,
  ) {
    await getAllTrackedCacheKeepSessions().catch(() => {})
    await writeSidebarState(updatedStorage, {
      activeId: lastSidebarRouting.activeId,
      route: lastSidebarRouting.route,
      routingAuthoritative: false,
    })
  }

  function publishFableRecoveryNotice(
    notice: Omit<
      NonNullable<SidebarState['fableRecoveries']>[number],
      'changedAt'
    >,
    storage: AccountStorage | null,
    auth: { access?: string; refresh?: string },
    desktopText?: string,
  ) {
    fableRecoveryNotices.delete(notice.sessionId)
    fableRecoveryNotices.set(notice.sessionId, {
      ...notice,
      changedAt: Date.now(),
    })
    if (fableRecoveryNotices.size > 128) {
      const oldest = fableRecoveryNotices.keys().next().value
      if (oldest) fableRecoveryNotices.delete(oldest)
    }
    void writeSidebarState(storage, {
      activeId: lastSidebarRouting.activeId,
      route: lastSidebarRouting.route,
      mainAccessToken: auth.access,
      mainRefreshToken: auth.refresh,
      routingAuthoritative: false,
    })

    if (desktopText) queueDesktopNotice(notice.sessionId, desktopText)
  }

  function trackDesktopNoticeMessageId(sessionId: string, messageId: string) {
    const messageIds =
      desktopNoticeMessageIds.get(sessionId) ?? new Set<string>()
    messageIds.delete(messageId)
    messageIds.add(messageId)
    while (messageIds.size > 4) {
      const oldest = messageIds.values().next().value
      if (typeof oldest !== 'string') break
      messageIds.delete(oldest)
    }
    desktopNoticeMessageIds.delete(sessionId)
    desktopNoticeMessageIds.set(sessionId, messageIds)
    while (desktopNoticeMessageIds.size > 128) {
      const oldestSession = desktopNoticeMessageIds.keys().next().value
      if (typeof oldestSession !== 'string') break
      desktopNoticeMessageIds.delete(oldestSession)
    }
  }

  function isDesktopNoticeMessage(sessionId: string, messageId?: string) {
    return (
      typeof messageId === 'string' &&
      desktopNoticeMessageIds.get(sessionId)?.has(messageId) === true
    )
  }

  function queueDesktopNotice(sessionId: string, text: string) {
    if (isTuiConnected(sessionId)) return
    // OpenCode's prompt endpoints run revert cleanup before honoring noReply.
    // OpenCode awaits event handlers before it evaluates the loop exit condition.
    // Escape the post-idle session update, then probe outside that critical section.
    // A later transition supersedes any notice that could not be delivered while
    // the session was busy. Sending a stale "switched" notice immediately before
    // a current "returning" notice is both noisy and can make the first ignored
    // message interfere with delivery of the second.
    pendingDesktopNotices.delete(sessionId)
    pendingDesktopNotices.set(sessionId, [text])
    while (pendingDesktopNotices.size > 128) {
      const oldest = pendingDesktopNotices.keys().next().value
      if (oldest) pendingDesktopNotices.delete(oldest)
      else break
    }
    if (desktopNoticeSafeSessions.has(sessionId)) {
      scheduleDesktopNoticeProbe(sessionId)
    }
  }

  function scheduleDesktopNoticeProbe(sessionId: string, attempt = 0) {
    if (
      !pendingDesktopNotices.has(sessionId) ||
      desktopNoticeProbes.has(sessionId)
    ) {
      return
    }
    desktopNoticeProbes.set(sessionId, attempt)
    const run = () => {
      if (desktopNoticeProbes.get(sessionId) !== attempt) return
      desktopNoticeProbes.delete(sessionId)
      void flushDesktopNoticesIfIdle(sessionId, attempt)
    }
    if (attempt === 0) {
      setImmediate(run)
    } else {
      setTimeout(run, DESKTOP_NOTICE_PROBE_DELAY_MS * attempt)
    }
  }

  function rearmDesktopNoticeProbe(sessionId: string, attempt: number) {
    if (attempt + 1 < DESKTOP_NOTICE_PROBE_LIMIT) {
      scheduleDesktopNoticeProbe(sessionId, attempt + 1)
    }
  }

  async function flushDesktopNoticesIfIdle(sessionId: string, attempt: number) {
    if (
      !desktopNoticeSafeSessions.has(sessionId) ||
      !pendingDesktopNotices.has(sessionId)
    ) {
      return
    }
    const session = ctx.client.session as PluginSessionClient | undefined
    if (typeof session?.status === 'function') {
      try {
        const response = await Promise.resolve(session.status())
        const responseRecord =
          response !== null && typeof response === 'object'
            ? (response as Record<string, unknown>)
            : undefined
        const data =
          responseRecord && Object.hasOwn(responseRecord, 'data')
            ? responseRecord.data
            : responseRecord
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          rearmDesktopNoticeProbe(sessionId, attempt)
          return
        }
        const status = (data as Record<string, unknown>)[sessionId]
        // OpenCode 1.17 and 1.18 omit idle sessions from this map.
        if (
          status !== undefined &&
          (!status ||
            typeof status !== 'object' ||
            (status as { type?: unknown }).type !== 'idle')
        ) {
          rearmDesktopNoticeProbe(sessionId, attempt)
          return
        }
      } catch {
        rearmDesktopNoticeProbe(sessionId, attempt)
        return
      }
    }
    // The status request is asynchronous. A new prompt can mark the session busy
    // while that request is in flight, even if its response still reflects the
    // preceding idle state. Never let that stale snapshot authorize insertion of
    // an ignored user message into the active run: OpenCode can adopt it as the
    // retry parent and dispatch the provider request again.
    if (!desktopNoticeSafeSessions.has(sessionId)) return
    await flushDesktopNotices(sessionId)
  }

  function flushDesktopNotices(sessionId: string): Promise<void> {
    const active = desktopNoticeFlushes.get(sessionId)
    if (active) return active

    const flush = (async () => {
      while (true) {
        const queue = pendingDesktopNotices.get(sessionId)
        const text = queue?.[0]
        if (!text) {
          pendingDesktopNotices.delete(sessionId)
          return
        }
        try {
          const isCurrentNotice = () =>
            pendingDesktopNotices.get(sessionId) === queue && queue[0] === text
          const sent = await sendIgnoredMessage(ctx, sessionId, text, {
            noReply: true,
            beforeActiveAssistant: true,
            canSend: () =>
              desktopNoticeSafeSessions.has(sessionId) && isCurrentNotice(),
            onPreparedMessageId: (messageId) =>
              trackDesktopNoticeMessageId(sessionId, messageId),
            latestPreparedMessageId: () =>
              [...(desktopNoticeMessageIds.get(sessionId) ?? [])].at(-1),
          })
          if (!sent) {
            if (
              desktopNoticeSafeSessions.has(sessionId) &&
              !isCurrentNotice()
            ) {
              continue
            }
            return
          }
          if (isCurrentNotice()) queue.shift()
        } catch (error) {
          logger.warn('fable-fallback', 'Desktop notification failed', {
            session: sessionId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    })()
    desktopNoticeFlushes.set(sessionId, flush)
    void flush.finally(() => {
      if (desktopNoticeFlushes.get(sessionId) === flush) {
        desktopNoticeFlushes.delete(sessionId)
      }
    })
    return flush
  }

  function observeServerFallbackOutcome(
    plan: FableFallbackPlan,
    outcome: ServerSideFallbackOutcome,
    storage: AccountStorage | null,
    auth: { access?: string; refresh?: string },
  ) {
    if (outcome.fallback && outcome.targetModel) {
      const previousTarget = serverFallbackTargets.get(plan.recoveryKey)
      serverFallbackTargets.delete(plan.recoveryKey)
      serverFallbackTargets.set(plan.recoveryKey, outcome.targetModel)
      while (serverFallbackTargets.size > 128) {
        const oldest = serverFallbackTargets.keys().next().value
        if (oldest) serverFallbackTargets.delete(oldest)
        else break
      }
      const visibleNotice = fableRecoveryNotices.get(plan.sessionId)
      if (
        previousTarget === outcome.targetModel &&
        visibleNotice?.mode === 'server' &&
        recoverableRefusalFamily(visibleNotice.requestedModelId) ===
          recoverableRefusalFamily(plan.requestedModel) &&
        visibleNotice.targetModelId === outcome.targetModel
      ) {
        return
      }
      logger.info(
        'fable-fallback',
        'Anthropic server-side safety fallback active',
        {
          session: plan.sessionId,
          requestedModel: plan.requestedModel,
          targetModel: outcome.targetModel,
          handoff: outcome.handoff,
        },
      )
      publishFableRecoveryNotice(
        {
          sessionId: plan.sessionId,
          mode: 'server',
          remaining: 0,
          requestedModelId: plan.requestedModel,
          targetModelId: outcome.targetModel,
        },
        storage,
        auth,
        buildServerFallbackNotice(plan.requestedModel, outcome.targetModel),
      )
      return
    }

    if (
      outcome.stopReason === 'refusal' ||
      !serverFallbackTargets.delete(plan.recoveryKey)
    ) {
      return
    }
    logger.info(
      'fable-fallback',
      'Anthropic server-side safety fallback ended',
      {
        session: plan.sessionId,
        requestedModel: plan.requestedModel,
      },
    )
    publishFableRecoveryNotice(
      {
        sessionId: plan.sessionId,
        mode: 'fable',
        remaining: 0,
        requestedModelId: plan.requestedModel,
      },
      storage,
      auth,
      buildServerRestoredNotice(plan.requestedModel),
    )
  }

  function clearFableRecoveryNotice(
    sessionId: string | null | undefined,
    storage: AccountStorage | null,
    auth: { access?: string; refresh?: string },
  ) {
    if (!sessionId) return
    for (const recoveryKey of serverFallbackTargets.keys()) {
      if (recoveryKey.startsWith(`${sessionId}\0`)) {
        serverFallbackTargets.delete(recoveryKey)
      }
    }
    if (!fableRecoveryNotices.delete(sessionId)) return
    void writeSidebarState(storage, {
      activeId: lastSidebarRouting.activeId,
      route: lastSidebarRouting.route,
      mainAccessToken: auth.access,
      mainRefreshToken: auth.refresh,
      routingAuthoritative: false,
    })
  }

  async function executePersistentCache1hCommand(argumentsText: string) {
    const action = parseCache1hCommandAction(argumentsText)
    if (action.type === 'enable' || action.type === 'disable') {
      const enabled = action.type === 'enable'
      const storage = await setCache1hPersistentEnabled(enabled)
      const mode = getCache1hPersistentMode(storage)
      setCache1hState({ enabled, mode })
      logger.info('commands', 'cache enabled changed', { enabled })
      return executeCache1hCommand({
        argumentsText,
        enabled,
        mode,
        settingsPath: await nativeAccounts.getSettingsPath(),
      })
    }

    if (action.type === 'mode') {
      const storage = await setCache1hPersistentMode(action.mode)
      const enabled = isCache1hPersistentlyEnabled(storage)
      setCache1hState({ enabled, mode: action.mode })
      logger.info('commands', 'cache mode changed', { mode: action.mode })
      return executeCache1hCommand({
        argumentsText,
        enabled,
        mode: action.mode,
        settingsPath: await nativeAccounts.getSettingsPath(),
      })
    }

    const storage = await loadAccounts(accountStoragePath)
    const enabled = isCache1hPersistentlyEnabled(storage)
    const mode = getCache1hPersistentMode(storage)
    setCache1hState({ enabled, mode })
    return executeCache1hCommand({ argumentsText, enabled, mode })
  }

  async function executePersistentCacheKeepCommand(argumentsText: string) {
    const action = parseCacheKeepCommandAction(argumentsText)
    let storage = await loadAccounts(accountStoragePath)
    if (action.type === 'window') {
      storage = await setCacheKeepPersistentWindow(
        action.startHour,
        action.endHour,
      )
      logger.info('commands', 'cachekeep schedule changed', {
        schedule: `${action.startHour}-${action.endHour}`,
      })
    } else if (action.type === 'always') {
      storage = await setCacheKeepPersistentAlways()
      logger.info('commands', 'cachekeep schedule changed', {
        schedule: 'always',
      })
    } else if (action.type === 'disable') {
      storage = await setCacheKeepPersistentEnabled(false)
      logger.info('commands', 'cachekeep enabled changed', { enabled: false })
    } else if (action.type === 'subagents') {
      storage = await setCacheKeepSubagentsEnabled(action.enabled)
      logger.info('commands', 'cachekeep subagents changed', {
        subagents: action.enabled,
      })
    }

    const window = getCacheKeepWindow(storage)
    const trackedSessionDetails = await getAllTrackedCacheKeepSessions()
    const nextPrewarmAt = trackedSessionDetails.length
      ? Math.min(
          ...trackedSessionDetails.map((session) => session.nextPrewarmAt),
        )
      : undefined
    return executeCacheKeepCommand({
      argumentsText,
      enabled: isCacheKeepPersistentlyEnabled(storage),
      always: isCacheKeepAlways(storage),
      window,
      hybridActive: isCacheKeepHybridActive(storage),
      trackedSessions: trackedSessionDetails.length,
      trackedSessionDetails,
      nextPrewarmAt,
    })
  }

  async function executePersistentDumpCommand(argumentsText: string) {
    const action = parseDumpCommandAction(argumentsText)
    if (action.type === 'enable' || action.type === 'disable') {
      const enabled = action.type === 'enable'
      await setDumpPersistentEnabled(enabled)
      setDumpEnabled(enabled)
      logger.info('commands', 'dump changed', { enabled })
      return executeDumpCommand({
        argumentsText,
        enabled,
        settingsPath: await nativeAccounts.getSettingsPath(),
      })
    }

    const storage = await loadAccounts(accountStoragePath)
    const enabled = isDumpPersistentlyEnabled(storage)
    setDumpEnabled(enabled)
    return executeDumpCommand({ argumentsText, enabled })
  }

  async function executePersistentFastModeCommand(argumentsText: string) {
    const action = parseFastModeCommandAction(argumentsText)
    if (action.type === 'enable' || action.type === 'disable') {
      const enabled = action.type === 'enable'
      await setFastModePersistentEnabled(enabled)
      setFastModeEnabled(enabled)
      logger.info('commands', 'fast mode changed', { enabled })
      return executeFastModeCommand({
        argumentsText,
        enabled,
        settingsPath: await nativeAccounts.getSettingsPath(),
      })
    }

    const storage = await loadAccounts(accountStoragePath)
    const enabled = isFastModePersistentlyEnabled(storage)
    setFastModeEnabled(enabled)
    return executeFastModeCommand({ argumentsText, enabled })
  }

  async function executePersistentStartCommand(
    argumentsText: string,
    sessionId?: string,
  ) {
    const action = parseLaneStartCommandAction(argumentsText)
    if (action.type === 'fire') {
      if (!sessionId) {
        return '## Claude Start Failed\n\n- OpenCode did not provide a session ID.'
      }
      try {
        await fireLaneStart(ctx.client, sessionId)
        return executeLaneStartCommand({ argumentsText }).text
      } catch (error) {
        return `## Claude Start Failed\n\n- ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return executeLaneStartCommand({ argumentsText }).text
  }

  async function executePersistentRoutingCommand(
    argumentsText: string,
    sessionId?: string,
  ) {
    const action = parseRoutingCommandAction(argumentsText)
    if (action.type === 'mode') {
      await setRoutingMode(action.mode, accountStoragePath)
      logger.info('commands', 'routing mode changed', { mode: action.mode })
      return executeRoutingCommand({ argumentsText, mode: action.mode })
    }

    if (action.type === 'reset' && sessionId) {
      await (await currentStickyRouting()).router.clear(sessionId)
      logger.info('commands', 'sticky routing assignment reset')
    }

    const storage = await loadAccounts(accountStoragePath)
    return executeRoutingCommand({
      argumentsText,
      mode: getRoutingMode(storage),
    })
  }

  async function executePersistentLoggingCommand(argumentsText: string) {
    const action = parseLoggingCommandAction(argumentsText)
    if (action.type === 'level') {
      // The native runtime stores the level, applies it to this process's
      // logger and logs a live level change.
      await setLogLevelPersistent(action.level)
      return executeLoggingCommand({
        argumentsText,
        level: action.level,
        settingsPath: await nativeAccounts.getSettingsPath(),
      })
    }

    const storage = await loadAccounts(accountStoragePath)
    const level = getPersistedLogLevel(storage) ?? 'info'
    return executeLoggingCommand({
      argumentsText,
      level,
      settingsPath: await nativeAccounts.getSettingsPath(),
    })
  }

  async function executePersistentPrimeCommand(argumentsText: string) {
    const action = parsePrimeCommandAction(argumentsText)
    const previous = isPrimePersistentlyEnabled(
      await loadAccounts(accountStoragePath),
    )
    let enabled = previous
    if (action.type === 'enable') {
      enabled = true
      if (!previous) {
        await setPrimePersistentEnabled(true, accountStoragePath)
        primeManager.start()
        logger.info('commands', 'prime changed', { enabled: true })
      }
    } else if (action.type === 'disable') {
      enabled = false
      if (previous) {
        await setPrimePersistentEnabled(false, accountStoragePath)
        primeManager.stop()
        logger.info('commands', 'prime changed', { enabled: false })
      }
    }

    // After toggling quota priming, update its sidebar status immediately.
    // Read storage again so the display uses the newly saved enabled flag.
    if (action.type === 'enable' || action.type === 'disable') {
      const reloaded = await loadAccounts(accountStoragePath)
      if (reloaded && latestGetAuth) {
        try {
          const cmdAuth = await latestGetAuth().catch(() => undefined)
          await writeSidebarState(reloaded, {
            activeId: lastSidebarRouting.activeId,
            route: lastSidebarRouting.route,
            mainAccessToken: cmdAuth?.access,
            routingAuthoritative: false,
          })
        } catch (error) {
          logger.warn('sidebar', 'prime-toggle sidebar write failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    const storage = await loadAccounts(accountStoragePath)
    return executePrimeCommand({
      argumentsText,
      enabled,
      accounts: primeManager.stats(storage),
    }).text
  }

  async function executePersistentAccountCommand(
    argumentsText: string,
    sessionId?: string,
    checkedAction?: ReturnType<typeof parseAccountCommandAction>,
  ) {
    const action = checkedAction ?? parseAccountCommandAction(argumentsText)

    // -- add-apikey --------------------------------------------------------
    if (action.type === 'add-apikey') {
      if (!action.apiKey) {
        const accounts = buildAccountList(
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage(),
        )
        return { text: 'API key is required', accounts }
      }
      const label = action.label?.trim() || undefined
      const now = Date.now()
      const resolvedBaseURL =
        action.baseURL?.trim() || 'https://api.kie.ai/claude'
      if (!isValidApiBaseURL(resolvedBaseURL)) {
        const accounts = buildAccountList(
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage(),
        )
        return {
          text: 'Invalid base URL. Must be an http(s) URL without embedded credentials.',
          accounts,
        }
      }
      const resolvedAuthHeader = action.authHeader ?? 'authorization-bearer'

      const account: ApiKeyAccount = {
        id: label || randomUUID(),
        label: label || undefined,
        type: 'api' as const,
        apiKey: action.apiKey,
        baseURL: resolvedBaseURL,
        authHeader: resolvedAuthHeader,
        enabled: true,
        addedAt: now,
        lastUsed: now,
      }
      await nativeAccounts.addApi({
        routeId: account.id,
        apiKey: action.apiKey,
        label: account.label,
        baseURL: resolvedBaseURL,
        authHeader: resolvedAuthHeader,
      })
      // addApi logs only a newly saved account. Do not emit a second
      // account-added event from this command adapter.

      const updatedStorage = await loadAccounts(accountStoragePath)
      await refreshSidebarAfterMutation(updatedStorage)
      const accounts = buildAccountList(
        updatedStorage ?? { version: 1, accounts: [] },
      )
      return {
        text: `API key account "${account.label ?? account.id}" added.`,
        accounts,
      }
    }

    // -- add-oauth-start ---------------------------------------------------
    if (action.type === 'add-oauth-start') {
      if (
        (await readNativeEnrollmentMode('opencode', process.env)) !== 'local'
      ) {
        throw new Error('Disconnect from the vault first.')
      }
      const authResult = await authorizeImpl('max')
      const entry: OAuthPendingEntry = {
        state: authResult.state,
        verifier: authResult.verifier,
        redirectUri: authResult.redirectUri,
        createdAt: Date.now(),
      }
      const key = sessionId ?? 'default'
      storeOAuthPending(key, entry)
      return {
        text: `Open this URL in your browser:\n${authResult.url}`,
        knobs: { oauthUrl: authResult.url },
        accounts: buildAccountList(
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage(),
        ),
      }
    }

    // -- add-oauth-finish --------------------------------------------------
    if (action.type === 'add-oauth-finish') {
      const key = sessionId ?? 'default'
      const pending = takeOAuthPending(key)
      if (!pending) {
        const accounts = buildAccountList(
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage(),
        )
        return {
          text: 'OAuth session expired. Please start again.',
          accounts,
        }
      }

      try {
        const result = await exchange(
          action.code,
          pending.verifier,
          pending.redirectUri,
          pending.state,
        )

        if (result.type === 'failed') {
          const accounts = buildAccountList(
            (await loadAccounts(accountStoragePath)) ?? createEmptyStorage(),
          )
          return {
            text: 'OAuth authentication failed. Please check the code and try again.',
            accounts,
          }
        }

        const now = Date.now()
        // OAuth accounts have no natural key, so the id stays a UUID even when a
        // label is given (label collisions must not collide ids). The label is
        // optional — a blank one keeps the UUID-name fallback in the UI.
        const account: OAuthAccount = {
          id: randomUUID(),
          type: 'oauth' as const,
          authLineageId: randomUUID(),
          label: action.label || undefined,
          access: result.access,
          refresh: result.refresh,
          expires: result.expires,
          enabled: true,
          addedAt: now,
          lastUsed: now,
          lastRefreshedAt: now,
        }
        assertNativeEnvironment()
        await nativeAccounts.loginOAuth({
          routeId: account.id,
          label: account.label,
          credential: {
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
          },
        })
        // loginOAuth logs the saved account addition. This command adapter
        // must not emit a duplicate event.

        const updatedStorage = await loadAccounts(accountStoragePath)
        await refreshSidebarAfterMutation(updatedStorage)
        const accounts = buildAccountList(
          updatedStorage ?? createEmptyStorage(),
        )
        return { text: `OAuth account added.`, accounts }
      } catch {
        const accounts = buildAccountList(
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage(),
        )
        return {
          text: 'OAuth exchange failed due to a network error. Please try again.',
          accounts,
        }
      } finally {
        oauthPending.delete(key)
      }
    }

    // -- existing flows ----------------------------------------------------
    let storage = await loadAccounts(accountStoragePath)
    if (action.type === 'status' && storage) {
      let mainAccessToken: string | undefined
      if (latestGetAuth) {
        try {
          const auth = await latestGetAuth()
          if (auth.type === 'oauth')
            mainAccessToken = mainServedAccessToken ?? auth.access
        } catch {}
      }
      storage = await ensureProfilesForQuotaDisplay(
        storage,
        mainAccessToken,
        AbortSignal.timeout(3_000),
        mainProviderAccountUuid,
      )
    }
    const statusProjection =
      action.type === 'status'
        ? ((await buildAccountDialogProjection(
            storage,
          )) satisfies AccountCommandStatusProjection)
        : undefined
    const result = await executeAccountCommand({
      argumentsText,
      storage: storage ?? { version: 1, accounts: [] },
      path: accountStoragePath,
      claustrum:
        action.type === 'status' && !statusProjection
          ? await detectClaustrumConnection(
              getConfiguredClaustrumConnectionFile(),
            )
          : undefined,
      statusProjection,
      transition: async (mode) => ({
        text:
          mode === 'claustrum'
            ? 'Run `npx @cortexkit/opencode-anthropic-auth setup` to enroll and activate scoped custody safely while OpenCode is stopped.'
            : 'Local exit requires replacing the OpenCode auth tombstone with a verified local OAuth login while OpenCode is stopped. Do not change custody mode alone.',
      }),
      resetEnrollment: async () => {
        const reset = await resetClaustrumEnrollmentState(
          getHostClaustrumEnrollmentPaths('opencode'),
          CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
        )
        switch (reset) {
          case 'reset':
            return {
              text: 'Terminal Claustrum enrollment state cleared. Run setup to enroll OpenCode again.',
            }
          case 'idle':
            return {
              text: 'No Claustrum enrollment state to reset. Run setup to enroll OpenCode.',
            }
          case 'refused-pending':
            return {
              // A pending state may hold a request the vault already stored
              // under this secret, so the menu keeps refusing and points at
              // setup, which replays the same secret and resumes that request.
              text: 'An enrollment request may still be in progress. Quit OpenCode and run setup again; it picks up the same request.',
            }
          case 'refused-approved':
            return {
              text: 'Claustrum enrollment is already approved. Revoke it in Claustrum before removing local enrollment state.',
            }
          case 'busy':
            return {
              text: 'Another process is updating Claustrum enrollment; retry shortly.',
            }
        }
      },
    })

    // These persistence helpers call the native account runtime, which logs
    // committed changes. Command parsing must not log attempted mutations.
    if (result.updated) {
      if (
        result.updated.action === 'enable' ||
        result.updated.action === 'disable'
      ) {
        await setAccountEnabledPersistent(
          result.updated.id,
          result.updated.action === 'enable',
          accountStoragePath,
        )
      } else if (result.updated.action === 'remove') {
        await removeAccountPersistent(result.updated.id, accountStoragePath)
      } else if (result.updated.action === 'reorder') {
        await reorderAccountsPersistent(
          result.updated.newOrder ?? result.updated.previousOrder ?? [],
          accountStoragePath,
          result.updated.id,
        )
      } else if (result.updated.action === 'reset-backoff') {
        await resetNativeBackoff('main')
        quotaManager.clearMainBackoff()
        logger.info('commands', 'native main refresh and quota backoff cleared')
      }

      const updatedStorage = await loadAccounts(accountStoragePath)
      if (latestGetAuth) {
        try {
          const auth = await latestGetAuth()
          writeSidebarState(updatedStorage, {
            activeId: lastSidebarRouting.activeId,
            route: lastSidebarRouting.route,
            mainAccessToken: auth.access,
            mainRefreshToken: auth.refresh,
            routingAuthoritative: false,
          })
        } catch {
          // auth not yet available — sidebar will refresh on next request
        }
      }
    }

    const updatedStorage = await loadAccounts(accountStoragePath)
    const accounts = buildAccountList(
      updatedStorage ?? { version: 1, accounts: [] },
    )
    return { text: result.text, accounts, statusProjection }
  }

  async function buildAccountDialogProjection(
    storageOverride?: Awaited<ReturnType<typeof loadAccounts>>,
  ): Promise<AccountDialogKnobs> {
    const storage = storageOverride ?? (await loadAccounts(accountStoragePath))
    const accountStorage = storage ?? createEmptyStorage()
    const accounts = buildAccountList(accountStorage).map((account) => {
      const stored = accountStorage.accounts.find(
        (candidate) => candidate.id === account.id,
      )
      const claustrumGate =
        account.role === 'main'
          ? ('na' as const)
          : stored &&
              isOAuthAccount(stored) &&
              isFallbackAccountVaultServed(stored.id, accountStorage)
            ? ('on' as const)
            : ('off' as const)
      const custodyState = custodyStateFor(account, storage)
      return {
        id: account.id,
        label: account.label,
        role: account.role,
        enabled: account.enabled,
        quotaPercent: account.quotaPercent,
        ...(account.tierLabel && { tierLabel: account.tierLabel }),
        claustrumGate,
        custodyState,
        vaultServed: custodyState === 'on-vault-served',
        vaultReauth: custodyState === 'on-vault-reauth',
      }
    })
    const detection = await detectClaustrumConnection(
      getConfiguredClaustrumConnectionFile(),
    )
    const custodyMode = getClaustrumMode(accountStorage)
    const claustrumEnrollment =
      custodyMode === 'claustrum'
        ? await readClaustrumEnrollmentStatus(
            getHostClaustrumEnrollmentPaths('opencode'),
            CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
          )
        : undefined
    return {
      accounts,
      claustrumDetection: detection.status,
      custodyMode,
      ...(claustrumEnrollment && { claustrumEnrollment }),
    }
  }

  async function buildDialogPayload(
    command: CommandModalName,
    args: string,
    sessionId?: string,
  ): Promise<OpenDialogPayload> {
    if (command === 'claude-quota')
      return { command, text: await buildQuotaCommandSummary(), knobs: {} }
    if (command === 'claude-start') {
      const text = await executePersistentStartCommand(args, sessionId)
      return {
        command,
        text,
        knobs: {},
      }
    }
    if (command === 'claude-logging') {
      const text = await executePersistentLoggingCommand(args)
      const storage = await loadAccounts(accountStoragePath)
      return {
        command,
        text,
        knobs: { level: getPersistedLogLevel(storage) ?? 'info' },
      }
    }
    if (command === 'claude-account') {
      const result = await executePersistentAccountCommand(args, sessionId)
      const accountProjection =
        result.statusProjection ?? (await buildAccountDialogProjection())
      const knobs: Record<string, unknown> = {
        accounts: accountProjection.accounts,
        claustrumDetection: accountProjection.claustrumDetection,
        custodyMode: accountProjection.custodyMode,
        custodyModeKnown: true,
        ...(accountProjection.claustrumEnrollment && {
          enrollmentStatus: formatEnrollmentStatus(
            accountProjection.claustrumEnrollment,
            accountProjection.accounts.some(
              (account) => account.role === 'main' && account.vaultServed,
            ),
          ).join('\n'),
        }),
      }
      if ('knobs' in result && result.knobs) {
        Object.assign(knobs, result.knobs)
      }
      return {
        command,
        text: custodyStartupMismatchVerdict
          ? `${result.text}\n\n- Custody startup mismatch: ${custodyStartupMismatchVerdict}`
          : result.text,
        knobs,
      }
    }
    if (command === 'claude-routing') {
      const text = await executePersistentRoutingCommand(args, sessionId)
      const storage = await loadAccounts(accountStoragePath)
      return { command, text, knobs: { mode: getRoutingMode(storage) } }
    }
    if (command === 'claude-fast') {
      const text = await executePersistentFastModeCommand(args)
      const storage = await loadAccounts(accountStoragePath)
      return {
        command,
        text,
        knobs: { enabled: isFastModePersistentlyEnabled(storage) },
      }
    }
    if (command === 'claude-dump') {
      const text = await executePersistentDumpCommand(args)
      const storage = await loadAccounts(accountStoragePath)
      return {
        command,
        text,
        knobs: { enabled: isDumpPersistentlyEnabled(storage) },
      }
    }
    if (command === 'claude-cache') {
      const text = await executePersistentCache1hCommand(args)
      const storage = await loadAccounts(accountStoragePath)
      return {
        command,
        text,
        knobs: {
          enabled: isCache1hPersistentlyEnabled(storage),
          mode: getCache1hPersistentMode(storage),
        },
      }
    }
    if (command === 'claude-cachekeep') {
      const text = await executePersistentCacheKeepCommand(args)
      const storage = await loadAccounts(accountStoragePath)
      return { command, text, knobs: { window: getCacheKeepWindow(storage) } }
    }
    if (command === 'claude-prime') {
      const text = await executePersistentPrimeCommand(args)
      const storage = await loadAccounts(accountStoragePath)
      const enabled = isPrimePersistentlyEnabled(storage)
      return {
        command,
        text,
        knobs: {
          enabled,
          accounts: primeManager.stats(storage),
        },
      }
    }
    if (command !== 'claude-killswitch') {
      const unhandledCommand: never = command
      throw new Error(`Unhandled command modal: ${unhandledCommand}`)
    }

    const storage = await loadAccounts()
    const config = getKillswitchConfig(storage)
    const accountIds = (storage?.accounts ?? [])
      .filter((a) => a.enabled !== false)
      .map((a) => a.id)
    const result = executeKillswitchCommand({
      argumentsText: args,
      config,
      accountIds,
    })
    if (result.updatedConfig) {
      // This persistence call logs only committed setting changes. Keep
      // logging out of the parser so a failed write produces no change event.
      await setKillswitchPersistent(result.updatedConfig)
    }
    return {
      command,
      text: result.text,
      knobs: { config: getKillswitchConfig(await loadAccounts()), accountIds },
    }
  }

  async function applyCommand(_request: ApplyRequest): Promise<ApplyResult> {
    // Old dialog requests return guidance instead of changing accounts or
    // settings. The /claude menu requires confirmation and checks which
    // actions are allowed without an interactive UI before dispatching them.
    return { text: 'Open /claude to manage native Claude settings.', knobs: {} }
  }

  const dispatchNative: NativeMenuDispatch = async (request, options) => {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new Error('Menu action aborted')
    let text: string
    switch (request.action) {
      case 'enable':
      case 'disable':
        await nativeAccounts.setEnabled(
          request.values.id,
          request.action === 'enable',
        )
        text = `Account ${request.values.id} ${request.action}d.`
        break
      case 'remove':
        await nativeAccounts.remove(request.values.id)
        text = `Account ${request.values.id} removed.`
        break
      case 'move-up':
      case 'move-down': {
        const order = (await nativeAccounts.read()).accounts
          .filter((account) => account.id !== 'main')
          .map((account) => account.id)
        const index = order.indexOf(request.values.id)
        if (index < 0) throw new Error('Native account not found')
        const target = index + (request.action === 'move-up' ? -1 : 1)
        if (target >= 0 && target < order.length) {
          const neighbor = order[target]
          if (neighbor === undefined)
            throw new Error('Native account order changed')
          order[target] = request.values.id
          order[index] = neighbor
          await nativeAccounts.reorder(order, request.values.id)
        }
        text = 'Native account order updated.'
        break
      }
      case 'add-apikey':
        // Use this plugin's established API-route defaults when values are
        // omitted: route id = the label, or a random UUID without one; base URL
        // = https://api.kie.ai/claude; auth header = authorization-bearer.
        // The generic native addApi would instead use a random UUID and
        // https://api.anthropic.com with no auth header set.
        text = (
          await executePersistentAccountCommand('', request.sessionId, {
            type: 'add-apikey',
            apiKey: request.values.apiKey,
            label: request.values.label ?? undefined,
            baseURL: request.values.baseURL ?? undefined,
            authHeader: request.values.authHeader ?? undefined,
          })
        ).text
        break
      case 'add-oauth-start':
        text = (
          await executePersistentAccountCommand('', request.sessionId, {
            type: 'add-oauth-start',
          })
        ).text
        break
      case 'add-oauth-finish':
        text = (
          await executePersistentAccountCommand('', request.sessionId, {
            type: 'add-oauth-finish',
            ...request.values,
          })
        ).text
        break
      case 'reset-backoff': {
        await resetNativeBackoff('main', options.signal)
        quotaManager.clearMainBackoff()
        text =
          'Native main refresh and quota backoff cleared; credential validation and quarantine are unchanged.'
        break
      }
      case 'enrollment-reset':
        text = (await executePersistentAccountCommand('enrollment-reset')).text
        break
      case 'quota-refresh':
        text = await buildQuotaCommandSummary(true)
        break
      case 'routing-mode':
        text = await executePersistentRoutingCommand(request.values.mode)
        break
      case 'routing-reset':
        text = await executePersistentRoutingCommand('reset', request.sessionId)
        break
      case 'cache-on':
      case 'cache-off':
        text = await executePersistentCache1hCommand(
          request.action === 'cache-on' ? 'on' : 'off',
        )
        break
      case 'cache-mode':
        text = await executePersistentCache1hCommand(
          `mode ${request.values.mode}`,
        )
        break
      case 'cachekeep-always':
        text = await executePersistentCacheKeepCommand('always')
        break
      case 'cachekeep-off':
        text = await executePersistentCacheKeepCommand('off')
        break
      case 'cachekeep-window':
        text = await executePersistentCacheKeepCommand(
          `${request.values.startHour}-${request.values.endHour}`,
        )
        break
      case 'cachekeep-subagents':
        text = await executePersistentCacheKeepCommand(
          `subagents ${request.values.enabled}`,
        )
        break
      case 'dump-on':
      case 'dump-off':
        text = await executePersistentDumpCommand(
          request.action === 'dump-on' ? 'on' : 'off',
        )
        break
      case 'fast-on':
      case 'fast-off':
        text = await executePersistentFastModeCommand(
          request.action === 'fast-on' ? 'on' : 'off',
        )
        break
      case 'prime-on':
      case 'prime-off':
        text = await executePersistentPrimeCommand(
          request.action === 'prime-on' ? 'on' : 'off',
        )
        break
      case 'logging-level':
        text = await executePersistentLoggingCommand(request.values.level)
        break
      case 'killswitch-on':
      case 'killswitch-off':
      case 'killswitch-set': {
        const snapshot = await nativeAccounts.read()
        const accountIds = snapshot.accounts
          .filter((account) => account.id !== 'main')
          .map((account) => account.id)
        await nativeAccounts.updateSettings((settings) => {
          const config = getKillswitchConfig({
            ...settings,
            version: 1,
            accounts: [],
          })
          if (request.action !== 'killswitch-set') {
            const result = executeKillswitchCommand({
              argumentsText: request.action === 'killswitch-on' ? 'on' : 'off',
              config,
              accountIds,
            })
            return { ...settings, killswitch: result.updatedConfig ?? config }
          }
          const accounts = { ...config.accounts }
          const updated: NonNullable<AccountStorage['killswitch']> = {
            ...config,
            enabled: true,
            accounts,
          }
          for (const entry of request.values.entries) {
            const thresholds = {
              five_hour: entry.fh,
              seven_day: entry.sd,
              ...(entry.scoped === undefined ? {} : { scoped: entry.scoped }),
            }
            if (entry.account === 'main' || entry.account === 'all')
              updated.main = thresholds
            if (entry.account === 'all') {
              for (const id of accountIds) accounts[id] = thresholds
            } else if (entry.account !== 'main')
              accounts[entry.account] = thresholds
          }
          return { ...settings, killswitch: updated }
        })
        text = 'Native killswitch policy updated.'
        break
      }
      case 'start-fire':
        text = await executePersistentStartCommand('', request.sessionId)
        break
      default: {
        const unsupported: never = request
        throw new Error(`Unsupported native menu action: ${unsupported}`)
      }
    }
    // Account and setting changes are committed before this display update.
    // A held sidebar writer must not delay the menu's action result.
    void refreshSidebarAfterMutation(await loadAccounts()).catch(() => {})
    return {
      ok: true,
      text: text
        .split('\n')
        .filter((line) => !line.includes('/claude-'))
        .join('\n'),
    }
  }

  const readNativeStatus: NativeUiOptions['readStatus'] = async (
    command,
    invocation,
  ) => {
    if (command === 'account') {
      const snapshot = await readNativeSnapshotForDisplay(
        AbortSignal.timeout(3_000),
      )
      const enrollment =
        snapshot.mode === 'claustrum'
          ? await readClaustrumEnrollmentStatus(
              getHostClaustrumEnrollmentPaths('opencode'),
              CLAUSTRUM_OPENCODE_ENROLLMENT_NAME,
            )
          : undefined
      return [
        `Custody mode: ${snapshot.mode}`,
        ...(enrollment
          ? formatEnrollmentStatus(
              enrollment,
              snapshot.accounts.some(
                (account) =>
                  account.id === 'main' &&
                  account.source === 'vault' &&
                  nativeAccountCanServe(account),
              ),
            )
          : []),
        ...snapshot.accounts.map(
          (account) =>
            `${account.label ?? account.id} [${account.id === 'main' ? 'main' : 'fallback'}] ${account.enabled ? 'enabled' : 'disabled'} — ${account.source}${account.state ? ` (${formatNativeAccountState(account)})` : ''}${formatOAuthAccountTier(account.profile) ? ` — ${formatOAuthAccountTier(account.profile)}` : ''}`,
        ),
      ].join('\n')
    }
    const modalNames = {
      account: 'claude-account',
      quota: 'claude-quota',
      routing: 'claude-routing',
      killswitch: 'claude-killswitch',
      cache: 'claude-cache',
      cachekeep: 'claude-cachekeep',
      dump: 'claude-dump',
      logging: 'claude-logging',
      fast: 'claude-fast',
      prime: 'claude-prime',
    } satisfies Record<
      Parameters<NativeUiOptions['readStatus']>[0],
      CommandModalName
    >
    const payload = await buildDialogPayload(
      modalNames[command],
      '',
      invocation.sessionId,
    )
    return payload.text
      .split('\n')
      .filter((line) => !line.includes('/claude-'))
      .join('\n')
  }
  const nativeCommands = new Map<
    string,
    { interactive: boolean; command: ReturnType<typeof createNativeCommand> }
  >()
  function getNativeCommand(sessionId: string) {
    const interactive = isTuiConnected(sessionId)
    let entry = nativeCommands.get(sessionId)
    if (!entry || entry.interactive !== interactive) {
      entry = {
        interactive,
        command: createNativeCommand({
          host: 'opencode',
          dispatch: dispatchNative,
          readStatus: readNativeStatus,
          readAccounts: () => nativeAccounts.read(),
          readSeparateHostLoginNotice: async () => {
            if ((await readNativeEnrollmentMode('opencode')) !== 'local')
              return false
            const snapshot = await nativeAccounts.read()
            const phase = nativeMigrationAuthorityPhase(
              await readNativeMigrationJournal(nativePaths),
            )
            return (
              snapshot.mode === 'local' &&
              (phase === 'committed' || phase === 'retired') &&
              snapshotHasServableLocalOAuth(snapshot) &&
              isRealHostLogin(await latestHostGetAuth?.())
            )
          },
          interactive,
        }),
      }
      nativeCommands.set(sessionId, entry)
    }
    return entry.command
  }

  function quotaBar(pct: number, width = 10): string {
    const filled = Math.max(0, Math.min(Math.round((pct / 100) * width), width))
    return '█'.repeat(filled) + '░'.repeat(width - filled)
  }

  function quotaLine(label: string, pct: number): string {
    return `${label}  ${quotaBar(pct)}  ${String(Math.round(pct)).padStart(3)}%`
  }

  function formatResetIn(resetsAt: string | undefined): string {
    if (!resetsAt) return ''
    const ts = new Date(resetsAt).getTime()
    if (Number.isNaN(ts)) return ''
    const ms = ts - Date.now()
    if (ms <= 0) return 'resets now'
    const mins = Math.floor(ms / 60_000)
    if (mins < 1) return 'resets <1m'
    if (mins < 60) return `resets ${mins}m`
    const hrs = Math.floor(mins / 60)
    const rm = mins % 60
    return rm > 0 ? `resets ${hrs}h${rm}m` : `resets ${hrs}h`
  }

  function showQuotaToast(
    quota: OAuthQuotaSnapshot | null,
    fallbacks?: Array<{
      id: string
      label?: string
      quota?: OAuthQuotaSnapshot
    }>,
    activeAccountId?: string,
  ) {
    const sections: string[] = []
    let globalMaxUsed = 0

    // Main account
    if (quota) {
      const fh = quota.five_hour
      const sd = quota.seven_day
      if (fh || sd) {
        const mainActive = activeAccountId === 'main'
        const status = mainActive ? 'active' : 'idle'
        const reset = formatResetIn(fh?.resetsAt)
        const lines: string[] = [
          `main · ${status}${reset ? ` (${reset})` : ''}`,
        ]
        if (fh) {
          lines.push(quotaLine('5h', fh.usedPercent))
          globalMaxUsed = Math.max(globalMaxUsed, fh.usedPercent)
        }
        if (sd) {
          lines.push(quotaLine('7d', sd.usedPercent))
          globalMaxUsed = Math.max(globalMaxUsed, sd.usedPercent)
        }
        sections.push(lines.join('\n'))
      }
    }

    // Fallback accounts
    if (fallbacks?.length) {
      for (const fb of fallbacks) {
        const q = fb.quota
        if (!q) continue
        const fh = q.five_hour
        const sd = q.seven_day
        if (!fh && !sd) continue
        const name = fb.label || 'alt'
        const fbActive = activeAccountId === fb.id
        const status = fbActive ? 'active' : 'idle'
        const fbReset = formatResetIn(fh?.resetsAt)
        const lines: string[] = [
          `${name} · ${status}${fbReset ? ` (${fbReset})` : ''}`,
        ]
        if (fh) {
          lines.push(quotaLine('5h', fh.usedPercent))
          globalMaxUsed = Math.max(globalMaxUsed, fh.usedPercent)
        }
        if (sd) {
          lines.push(quotaLine('7d', sd.usedPercent))
          globalMaxUsed = Math.max(globalMaxUsed, sd.usedPercent)
        }
        sections.push(lines.join('\n'))
      }
    }

    if (!sections.length) return
    const message = sections.join('\n\n')
    const variant =
      globalMaxUsed >= 90 ? 'error' : globalMaxUsed >= 70 ? 'warning' : 'info'

    // biome-ignore lint/suspicious/noExplicitAny: SDK client.tui type not exposed to server plugins
    void (client.tui as any)
      ?.showToast?.({
        body: {
          title: 'Claude Quota',
          message,
          variant,
          duration: variant === 'error' ? 8000 : 5000,
        },
      })
      ?.catch?.(() => {})
  }

  if (ctx.directory) {
    const rpcDir = getRpcDir(ctx.directory)
    try {
      rpcServerAdoption = await adoptRpcServer(rpcDir, () =>
        startRpcServer({
          dir: rpcDir,
          drain: drainNotifications,
          apply: applyCommand,
          applyMenu: (request) =>
            getNativeCommand(request.sessionId ?? '').apply(request),
        }),
      )
    } catch {
      logger.warn('rpc', 'native menu server unavailable')
    }
  }

  const plugin = {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: { info?: unknown }[] },
    ) => {
      const messages = output.messages as Parameters<
        typeof markOpenCodeEffortTransitions
      >[0]
      billingLineageTracker.observeMessages(messages)
      const plan = markOpenCodeEffortTransitions(messages)
      if (plan) {
        effortPlanTracker.record(plan)
        return
      }
      const currentUser = messages.findLast(
        (message) => message.info?.role === 'user',
      )
      const sessionId = currentUser?.info?.sessionID
      const messageId = currentUser?.info?.id
      if (typeof sessionId === 'string' && typeof messageId === 'string') {
        effortPlanTracker.clear(sessionId, messageId)
      }
    },
    'chat.message': async (
      {
        sessionID,
      }: {
        sessionID: string
      },
      output: { message: { id: string }; parts: unknown[] },
    ) => {
      laneStartTracker.observeSyntheticMessage({
        sessionId: sessionID,
        messageId: output.message.id,
        parts: output.parts,
      })
    },
    'chat.headers': async (
      {
        sessionID,
        agent,
        message,
      }: {
        sessionID: string
        agent?: string
        message: { id: string }
      },
      output: { headers: Record<string, string> },
    ) => {
      if (isAuxiliaryAgent(agent))
        output.headers[REQUEST_CLASS_REQUEST_HEADER] = 'auxiliary'
      laneStartTracker.markHeaders({
        sessionId: sessionID,
        messageId: message.id,
        headers: output.headers,
      })
      effortPlanTracker.markHeaders({
        sessionId: sessionID,
        messageId: message.id,
        headers: output.headers,
      })
      billingLineageTracker.markHeaders({
        sessionId: sessionID,
        messageId: message.id,
        headers: output.headers,
      })
    },
    event: async ({ event }: { event: unknown }) => {
      const value = event as unknown as {
        type?: string
        properties?: {
          sessionID?: string
          info?: {
            id?: string
            sessionID?: string
            role?: string
          }
          status?: { type?: string }
          messageID?: string
        }
      }
      const info = value.properties?.info
      const sessionId =
        value.properties?.sessionID ?? info?.sessionID ?? info?.id
      if (!sessionId) return

      if (
        value.type === 'message.updated' &&
        info?.role === 'user' &&
        !isDesktopNoticeMessage(sessionId, info.id)
      ) {
        if (typeof info.id === 'string') {
          desktopNoticeLatestUserMessages.set(sessionId, info.id)
          if (
            desktopNoticeSafeSessions.has(sessionId) &&
            desktopNoticeIdleUserMessages.get(sessionId) !== info.id
          ) {
            // A new user message can precede OpenCode's busy status event. Revoke
            // the idle-delivery lease immediately so an ignored notice cannot
            // become the active request parent and duplicate a provider turn.
            // Repeated updates for the user message that produced the current
            // idle event are harmless and must not suppress delivery forever.
            desktopNoticeSafeSessions.delete(sessionId)
          }
        } else {
          desktopNoticeSafeSessions.delete(sessionId)
        }
      }

      if (
        value.type === 'session.status' &&
        value.properties?.status?.type !== 'idle'
      ) {
        desktopNoticeSafeSessions.delete(sessionId)
      }

      if (value.type === 'session.idle') {
        const latestUserMessageId =
          desktopNoticeLatestUserMessages.get(sessionId)
        if (latestUserMessageId) {
          desktopNoticeIdleUserMessages.set(sessionId, latestUserMessageId)
        } else {
          desktopNoticeIdleUserMessages.delete(sessionId)
        }
        // Defer the prompt until after this event handler returns, then verify the
        // live status map is still idle. OpenCode 1.18 no longer guarantees a
        // session.updated event after session.idle, so that event cannot be used
        // as the release signal.
        desktopNoticeSafeSessions.add(sessionId)
        while (desktopNoticeSafeSessions.size > 128) {
          const oldest = desktopNoticeSafeSessions.values().next().value
          if (oldest) desktopNoticeSafeSessions.delete(oldest)
          else break
        }
        scheduleDesktopNoticeProbe(sessionId)
      }

      if (
        value.type === 'session.deleted' ||
        value.type === 'message.removed'
      ) {
        billingLineageTracker.clearSession(sessionId)
      }

      if (value.type === 'session.deleted') {
        fableFallbackManager.clearSession(sessionId)
        dropSessionSourceWarms(sessionId)
        nativeCommands.delete(sessionId)
        oauthPending.delete(sessionId)
        laneStartTracker.clearSession(sessionId)
        fableRecoveryNotices.delete(sessionId)
        pendingDesktopNotices.delete(sessionId)
        desktopNoticeSafeSessions.delete(sessionId)
        desktopNoticeLatestUserMessages.delete(sessionId)
        desktopNoticeIdleUserMessages.delete(sessionId)
        desktopNoticeMessageIds.delete(sessionId)
        for (const recoveryKey of pendingRecoveryDesktopNotices.keys()) {
          if (recoveryKey.startsWith(`${sessionId}\0`)) {
            pendingRecoveryDesktopNotices.delete(recoveryKey)
          }
        }
        desktopNoticeProbes.delete(sessionId)
      }
    },
    config: async (config: { command?: Record<string, unknown> }) => {
      const commands = { ...(config.command ?? {}) }
      // Retire only commands owned by this plugin; unrelated user commands stay.
      for (const command of COMMAND_MODAL_NAMES) delete commands[command]
      config.command = {
        ...commands,
        claude: {
          template: 'claude',
          description:
            'Manage Claude accounts, quotas, routing, and cache settings.',
        },
      }
    },
    'experimental.chat.system.transform': async (
      input: {
        sessionID?: string
        model?: { providerID?: string; api?: { npm?: string } }
      },
      output: { system: string[] },
    ) => {
      if (!shouldInjectParallelToolPrompt(input)) return
      appendParallelToolPrompt(output.system)
    },
    provider: {
      id: 'anthropic',
      async models(
        provider: { models: Record<string, AnthropicProviderModel> },
        context: { auth?: { type?: string } },
      ) {
        const models = applyNativeAdaptiveEffortVariants(
          addNativeClaudeModels(provider.models),
        )
        // Zero OAuth model costs by default (quota-based, not per-token billed).
        // Opt out via persisted config costZeroing.enabled=false to show real costs.
        // initialStorage is nullable (no config file yet) → default to enabled.
        if (
          context.auth?.type !== 'oauth' ||
          !isCostZeroingEnabled(initialStorage ?? {})
        )
          return models
        return zeroModelCosts(models)
      },
    },
    'command.execute.before': async (input: {
      command: string
      arguments: string
      sessionID: string
    }) => {
      if (input.command !== 'claude') return
      const payload = await getNativeCommand(input.sessionID).open(
        input.sessionID,
      )
      // A TUI that polled this session within the last few seconds is running
      // (possibly busy); queue the menu for it and never fall back to text.
      // OpenCode Desktop has no TUI to wait for, and a session whose last wait
      // found none (with no poll since) is not waited on again: both get the
      // text menu at once. Otherwise give a TUI that has just started or just
      // opened the session a short time to take the menu. If no TUI takes it
      // in time, reply in the chat, which OpenCode shows without the plugin's
      // TUI part, and say how to load that part, once per session.
      let pickedUp = isTuiConnected(input.sessionID)
      let notice = false
      if (pickedUp) pushNotification(payload, input.sessionID)
      else if (!isOpenCodeDesktop() && !missedTuiPickup(input.sessionID)) {
        pickedUp = await pushNotificationAwaitingPickup(
          payload,
          input.sessionID,
          {
            timeoutMs:
              runtimeOverrides.tuiPickupTimeoutMs ?? CLAUDE_MENU_TUI_PICKUP_MS,
            setTimeout: runtimeTimers.setTimeout,
            clearTimeout: runtimeTimers.clearTimeout,
          },
        )
        notice = !pickedUp
      }
      if (!pickedUp) {
        const text = [
          ...(notice ? [claudeMenuNoTuiNotice(), ''] : []),
          payload.menu.title,
          ...payload.menu.sections.flatMap((section) => [
            `\n## ${section.title}`,
            ...section.lines,
            ...section.items.map(
              (item) =>
                `${item.label}${item.detail ? ` — ${item.detail}` : ''}`,
            ),
          ]),
        ].join('\n')
        await sendIgnoredMessage(ctx, input.sessionID, text)
      }
      cleanAbort()
    },
    auth: {
      provider: 'anthropic',
      async loader(
        hostGetAuth: () => Promise<{
          type: string
          access?: string
          refresh?: string
          expires?: number
        }>,
        _provider: { models: Record<string, { cost: unknown }> },
      ) {
        latestGetActivation = async () => {
          const current = await hostGetAuth()
          return {
            type: current.type,
            active: isCustodyTombstoneOAuth(current, 'anthropic'),
          }
        }
        latestHostGetAuth = hostGetAuth
        const activation = await hostGetAuth()
        // Stock API-key authentication is not owned by the OAuth vault path.
        if (activation.type !== 'oauth') return {}
        // Enrollment and account availability can change while OpenCode is
        // running. Always install the Anthropic request handler; it rechecks
        // enrollment, the host marker and roster before authorizing each send.
        const startupMode = await readNativeEnrollmentMode('opencode').catch(
          () => undefined,
        )
        if (
          !bootProfileHydrationStarted &&
          isCustodyTombstoneOAuth(activation, 'anthropic') &&
          process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION !== '1'
        ) {
          // Show native account tiers before the first model request, without
          // making provider initialization wait for profile network or storage.
          bootProfileHydrationStarted = true
          const hydration = readNativeSnapshotForDisplay(
            profileHydrationShutdown.signal,
          )
            .then((snapshot) => {
              if (!profileHydrationShutdown.signal.aborted)
                return writeSidebarState(snapshot.policyStorage, {
                  ...lastSidebarRouting,
                  routingAuthoritative: false,
                })
            })
            .catch(() => {
              if (!profileHydrationShutdown.signal.aborted)
                logger.debug(
                  'quota',
                  'startup account profile hydration failed',
                )
            })
          profilePublications.add(hydration)
          void hydration.then(() => profilePublications.delete(hydration))
        }
        function requireNativeActivation(
          currentActivation: unknown,
          separateLocalLogin = false,
        ) {
          if (
            !isCustodyTombstoneOAuth(currentActivation, 'anthropic') &&
            !(separateLocalLogin && isRealHostLogin(currentActivation))
          )
            throw new Error(
              'Native OAuth requires inert OpenCode activation; run offline setup',
            )
        }
        async function requireCurrentNativeActivation(
          separateLocalLogin: boolean,
        ) {
          // Native authorization checks pool authority and the selected account
          // before dispatch. This fence only rechecks the host slot and custody;
          // the separate local login never supplies credential material.
          requireNativeActivation(
            await hostGetAuth(),
            separateLocalLogin &&
              (await readNativeEnrollmentMode('opencode')) === 'local',
          )
        }
        const getAuth = async (
          modelId?: string,
          signal?: AbortSignal,
          deferCredential = false,
        ) => {
          const currentActivation = await hostGetAuth()
          if (currentActivation.type !== 'oauth')
            return {
              type: currentActivation.type,
              access: '',
              expires: 0,
              refresh: undefined,
              nativeAccountIdentity: undefined,
              nativeRoutingLineage: undefined,
              nativeLocalSource: undefined,
              nativeScopedAttempt: undefined,
              modelDenied: false,
              credentialUnavailable: false,
              credentialFailure: undefined,
              deferred: false,
            }
          const mode = await readNativeEnrollmentMode('opencode')
          if (
            mode === 'claustrum' &&
            !isExactNativePlaceholder(currentActivation)
          )
            throw new Error(
              'This host uses the credential vault, but OpenCode holds a separate Anthropic login. Remove it and choose the vault login, or disconnect from the vault.',
            )
          assertNativeEnvironment()
          const primarySnapshot = await readNativeAccountsForRequest(
            nativeAccounts,
            signal,
          )
          const authority =
            mode === 'claustrum'
              ? 'committed'
              : nativeMigrationAuthorityPhase(
                  await readNativeMigrationJournal(nativePaths),
                )
          const localOAuthServable =
            snapshotHasServableLocalOAuth(primarySnapshot)
          requireNativeActivation(
            currentActivation,
            mode === 'local' &&
              (authority === 'committed' || authority === 'retired') &&
              localOAuthServable,
          )
          if (
            mode === 'claustrum' &&
            !primarySnapshot.accounts.some(
              (account) =>
                account.type === 'oauth' && nativeAccountCanServe(account),
            )
          )
            throw new NativeVaultNoAccountError()
          const dimensions = fallbackCustodyDimensions(
            primarySnapshot.policyStorage,
          )
          try {
            reconcileCustodyStartup({
              mode: mode === 'claustrum' ? 'C' : 'L',
              main: mainCustodyDimension(currentActivation),
              fallbacks: mode === 'claustrum' ? 'T' : dimensions.fallbacks,
              evidence: 'V',
              authority,
              localOAuthServable,
            })
            custodyStartupMismatchVerdict = undefined
          } catch (error) {
            if (error instanceof CustodyStateMismatchError)
              custodyStartupMismatchVerdict = error.verdict
            throw error
          }
          headerRoutingPolicyStorage = primarySnapshot.policyStorage
          const primaryAccount = primarySnapshot.accounts.find(
            (account) => account.id === 'main',
          )
          const primaryBinding = primaryAccount?.binding
          const primaryRoutingQuota = primaryAccount
            ? routingAccountQuota(primaryAccount, primarySnapshot.policyStorage)
            : undefined
          const primaryRoutingStorage =
            primaryRoutingQuota && primaryRoutingQuota !== primaryAccount?.quota
              ? {
                  ...primarySnapshot.policyStorage,
                  quota: {
                    ...primarySnapshot.policyStorage.quota,
                    mainQuota: primaryRoutingQuota,
                  },
                }
              : primarySnapshot.policyStorage
          const primaryObservation = currentHeaderRoutingObservation(
            'main',
            localHeaderRoutingLineage(primaryBinding),
            primaryAccount?.accountIdentity,
            primarySnapshot.policyStorage,
          )
          const primaryHeaderExhaustionProven = Boolean(
            primaryBinding &&
              primaryObservation?.lineage ===
                localHeaderRoutingLineage(primaryBinding) &&
              primaryObservation?.generalExhausted === true,
          )
          if (
            primaryAccount &&
            primaryBinding &&
            (!mainQuotaCredentialEpoch ||
              primaryBinding.rowId !== mainQuotaCredentialEpoch.rowId ||
              primaryBinding.credentialEpoch >
                mainQuotaCredentialEpoch.credentialEpoch)
          ) {
            // An explicit replacement clears persisted quota, even when the
            // verified account UUID stays the same. Clear the matching cache
            // and fence old polls too; ordinary token refresh keeps its epoch.
            quotaManager.clearMain()
            quotaManager.setMainQuotaAccountIdentity(
              primaryAccount.accountIdentity,
            )
            mainQuotaCredentialEpoch = {
              rowId: primaryBinding.rowId,
              credentialEpoch: primaryBinding.credentialEpoch,
            }
          }
          if (
            deferCredential &&
            (getRoutingMode(primarySnapshot.policyStorage) ===
              'fallback-first' ||
              mainProviderQuotaRestriction(
                primaryRoutingStorage,
                primaryAccount?.accountIdentity,
                primaryHeaderExhaustionProven,
              ))
          ) {
            const primary = primarySnapshot.accounts.find(
              (account) => account.id === 'main',
            )
            signal?.throwIfAborted()
            return {
              type: 'oauth',
              access: '',
              expires: 0,
              refresh: undefined,
              nativeAccountIdentity: primary?.accountIdentity,
              nativeRoutingLineage: primary?.binding
                ? localHeaderRoutingLineage(primary.binding)
                : undefined,
              nativeLocalSource: undefined,
              nativeScopedAttempt: undefined,
              modelDenied: false,
              credentialUnavailable: false,
              credentialFailure: undefined,
              deferred: true,
            }
          }
          let credential: NativeOAuthAuthorization | undefined
          let denied: NativeAccountView | undefined
          let unavailable: NativeAccountView | undefined
          let credentialFailure: NativeCredentialUnavailableError | undefined
          try {
            credential = await authorizeOAuth(
              'main',
              signal,
              undefined,
              modelId,
              'serve',
              primarySnapshot,
            )
          } catch (error) {
            if (error instanceof NativeUnsupportedCredentialError) throw error
            // Main is still being saved by another writer: retry the request
            // rather than treat main as unavailable and route elsewhere.
            if (isNativeTransientAccountError(error)) throw error
            if (error instanceof NativeModelPolicyError) {
              denied = error.account
              // Recheck a stale limit for this model before moving the request
              // to another account. A neutral usage poll grants no permission
              // to send the model; authorization checks the new reading again.
              const scopedWindow = getScopedQuotaWindowForModel(
                denied.quota,
                modelId,
              )
              const scopedStale =
                scopedWindow !== undefined &&
                (!Number.isFinite(scopedWindow.checkedAt) ||
                  (scopedWindow.checkedAt ?? 0) + error.checkIntervalMs <=
                    Date.now())
              if (
                scopedStale ||
                (!quotaSnapshotHasStandardWindows(denied.quota) &&
                  !quotaSnapshotModelScopeIsExhausted(denied.quota, modelId))
              ) {
                try {
                  await nativeAccounts.fetchQuota('main', undefined, signal)
                  credential = await authorizeOAuth(
                    'main',
                    signal,
                    undefined,
                    modelId,
                  )
                  denied = undefined
                } catch (retryError) {
                  if (isNativeTransientAccountError(retryError))
                    throw retryError
                  if (retryError instanceof NativeModelPolicyError)
                    denied = retryError.account
                  else if (
                    retryError instanceof NativeCredentialUnavailableError
                  ) {
                    unavailable = retryError.account
                    credentialFailure = retryError
                  }
                }
              }
            } else if (error instanceof NativeCredentialUnavailableError) {
              unavailable = error.account
              credentialFailure = error
            }
          }
          signal?.throwIfAborted()
          return {
            type: 'oauth',
            access: credential?.accessToken ?? '',
            expires: credential?.expires ?? 0,
            refresh: undefined,
            nativeRoutingLineage:
              headerRoutingLineage(
                credential?.localSubject,
                credential?.scopedAttempt,
              ) ??
              (primaryAccount?.binding
                ? localHeaderRoutingLineage(primaryAccount.binding)
                : undefined),
            nativeAccountIdentity:
              credential?.accountIdentity ??
              denied?.accountIdentity ??
              unavailable?.accountIdentity,
            modelDenied: Boolean(denied),
            credentialUnavailable: Boolean(unavailable),
            credentialFailure,
            deferred: false,
            nativeLocalSource: credential?.localSource,
            nativeScopedAttempt: credential?.scopedAttempt,
          }
        }
        latestGetAuth = getAuth
        const auth: {
          type: string
          access: string
          refresh?: string
          expires: number
        } = { type: 'oauth', access: '', expires: 0 }
        if (auth.type === 'oauth') {
          const initialSnapshot = await nativeAccounts
            .read()
            .catch(() => undefined)
          const initialMain = initialSnapshot?.accounts.find(
            (account) => account.id === 'main',
          )
          mainAccountId =
            initialMain?.binding?.rowId ?? initialMain?.accountIdentity
          mainQuotaAccountId ??= initialMain?.accountIdentity ?? mainAccountId
          if (auth.access) {
            await resolveMainQuotaAccountIdentity(auth.access)
          }
          async function refreshMainAccessToken(
            rejectedAccess?: string,
            modelId?: string,
            signal?: AbortSignal,
          ) {
            const separateLocalLogin = isRealHostLogin(await hostGetAuth())
            // Recheck host admission before and after awaiting native credentials.
            await requireCurrentNativeActivation(separateLocalLogin)
            signal?.throwIfAborted()
            const credential = await authorizeOAuth(
              'main',
              signal,
              rejectedAccess,
              modelId,
              'refresh',
            )
            await requireCurrentNativeActivation(separateLocalLogin)
            signal?.throwIfAborted()
            return credential.accessToken
          }

          function startMainBackgroundRefresh() {
            if (mainBackgroundRefreshTimer)
              runtimeTimers.clearInterval(mainBackgroundRefreshTimer)
            const run = async () => {
              try {
                const storage = await loadAccounts(accountStoragePath)
                if (!mainRefreshEnabled(storage)) return
                const latestAuth = await getAuth()
                if (latestAuth.type !== 'oauth') return
                if (
                  latestAuth.nativeLocalSource === 'rotated' ||
                  latestAuth.nativeLocalSource === 'adopted'
                )
                  return
                if (
                  latestAuth.expires &&
                  latestAuth.expires - Date.now() >
                    mainRefreshBeforeExpiryMs(storage)
                )
                  return
                await refreshMainAccessToken()
              } catch {
                logger.warn(
                  'refresh',
                  'native main OAuth background refresh unavailable',
                )
              }
            }
            mainBackgroundRefreshTimer = runtimeTimers.setInterval(() => {
              void run()
            }, MAIN_AUTH_REFRESH_TICK_MS +
              jitterMs(MAIN_AUTH_REFRESH_TICK_JITTER_MS))
            mainBackgroundRefreshTimer.unref?.()
          }

          if (startupMode === 'local') startMainBackgroundRefresh()
          quotaManager.seedFallbacksFromAccounts(
            (initialStorage?.accounts ?? []).filter(isOAuthAccount),
          )
          const initialSidebarRouting = await resolveInitialSidebarRouting(() =>
            loadAccounts(accountStoragePath),
          ).catch(() => ({
            freshStorage: null,
            activeId: undefined,
            route: 'main' as const,
          }))
          await writeSidebarState(initialSidebarRouting.freshStorage, {
            activeId: initialSidebarRouting.activeId,
            route: initialSidebarRouting.route,
            mainAccessToken: auth.access,
            routingAuthoritative: false,
          })

          function isReplayableRequest(
            input: string | URL | Request,
            body: RequestInit['body'] | null | undefined,
          ) {
            if (input instanceof Request && input.body) return false
            return body == null || typeof body === 'string'
          }

          function parseRequestModel(
            body: RequestInit['body'] | null | undefined,
          ) {
            if (typeof body !== 'string') return undefined
            try {
              const parsed = JSON.parse(body) as { model?: unknown }
              return typeof parsed.model === 'string' ? parsed.model : undefined
            } catch {
              return undefined
            }
          }

          function isSubagentRequest(headers: Headers) {
            return headers.has('x-parent-session-id')
          }

          /**
           * A streamed rate limit is an `error` event whose `error.type` is
           * `rate_limit_error`. Parsing the event's JSON also reads escaped
           * spellings; reply text that merely mentions rate limits is not one.
           */
          function isStreamingRateLimitEvent(data: string) {
            let parsed: unknown
            try {
              parsed = JSON.parse(data)
            } catch {
              return false
            }
            if (typeof parsed !== 'object' || parsed === null) return false
            const error: unknown = Reflect.get(parsed, 'error')
            return (
              Reflect.get(parsed, 'type') === 'error' &&
              typeof error === 'object' &&
              error !== null &&
              Reflect.get(error, 'type') === 'rate_limit_error'
            )
          }

          function mainQuotaRoutingEnabled(
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            return storage?.quota?.enabled === true
          }

          async function inspectStreamingRateLimit(
            response: Response,
            trace?: PerfTrace,
          ) {
            if (!response.body || response.status !== 200) {
              trace?.mark('inspect_stream_skip', { status: response.status })
              return { response, rateLimited: false }
            }
            if (
              response.headers.get('x-cortexkit-relay-optimistic') === 'true'
            ) {
              trace?.mark('inspect_stream_skip', {
                status: response.status,
                reason: 'optimistic_relay',
              })
              return { response, rateLimited: false }
            }

            const start = nowMs()
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let bytes = 0
            // Classify the first event, skipping comments and heartbeats that
            // carry no data. The shared framer handles CRLF, LF and CR line
            // endings and frames split across reads.
            const framer = createSseFramer({ maxFrameBytes: 65_536 })
            let rateLimited = false
            let decided = false
            // Only the stream's first frame may drop a leading byte-order mark.
            let streamStart = true
            while (!decided && bytes < 65_536) {
              const { done, value } = await reader
                .read()
                .catch(async (caught: unknown) => {
                  const error = normalizeToolNameResponseError(
                    caught,
                    cacheDiagnosticsResponses.get(response)?.toolNameMap,
                  )
                  if (error !== caught)
                    await cancelUnsafeToolNameResponse(reader, error)
                  throw error
                })
              if (done) break
              chunks.push(value)
              bytes += value.byteLength
              let frames: Uint8Array[]
              try {
                frames = framer.push(value)
              } catch {
                // The first frame exceeded the 64 KiB inspection limit; leave
                // the response unclassified rather than read further.
                break
              }
              for (const frame of frames) {
                const event = parseSseFrame(
                  decodeSseFrame(frame, { streamStart }),
                )
                streamStart = false
                if (event.data === undefined) continue
                rateLimited = isStreamingRateLimitEvent(event.data)
                decided = true
                break
              }
            }

            if (rateLimited) {
              routingStreamLimits.get(response)?.()
              routingStreamLimits.delete(response)
              await reader.cancel().catch(() => {})
              try {
                reader.releaseLock()
              } catch {}
              const stream = new ReadableStream({
                start(controller) {
                  for (const chunk of chunks) controller.enqueue(chunk)
                  controller.close()
                },
              })
              trace?.mark('inspect_stream_first_event', {
                ms: roundMs(nowMs() - start),
                bytes,
                rateLimited: true,
              })
              const inspectedResponse = new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              })
              copyCacheDiagnosticsContext(
                cacheDiagnosticsResponses,
                response,
                inspectedResponse,
              )
              return {
                response: inspectedResponse,
                rateLimited: true,
              }
            }

            const stream = new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk)
              },
              async pull(controller) {
                const { done, value } = await reader.read()
                if (done) {
                  controller.close()
                  return
                }
                controller.enqueue(value)
              },
              cancel(reason) {
                return reader.cancel(reason)
              },
            })

            trace?.mark('inspect_stream_first_event', {
              ms: roundMs(nowMs() - start),
              bytes,
              rateLimited: false,
            })
            const inspectedResponse = new Response(stream, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
            copyCacheDiagnosticsContext(
              cacheDiagnosticsResponses,
              response,
              inspectedResponse,
            )
            return {
              response: inspectedResponse,
              rateLimited: false,
            }
          }

          function configureApiRouteHeaders(
            headers: Headers,
            account: ApiKeyAccount,
          ) {
            headers.delete('authorization')
            headers.delete('x-api-key')
            if (account.authHeader === 'x-api-key') {
              headers.set('x-api-key', account.apiKey ?? '')
            } else {
              headers.set('Authorization', `Bearer ${account.apiKey ?? ''}`)
            }
            headers.set('Content-Type', 'application/json')
            applyCustomHeaders(headers)
          }

          async function authorizePaidFallback(
            routeId: string,
            accessToken: string | undefined,
            identity: MainQuotaIdentityBinding | undefined,
            signal?: AbortSignal,
          ) {
            assertNativeEnvironment()
            if (!accessToken) {
              const general = routingMainQuotaEntry(identity)
              if (
                !identity?.providerAccountUuid ||
                !general ||
                general.refreshAfter <= Date.now() ||
                !quotaSnapshotIsExhausted(general.quota)
              ) {
                throw new Error(
                  'API fallback requires fresh general primary OAuth exhaustion',
                )
              }
              // This primary authorization validates the existing general-quota
              // gate for an API route. It does not permit the denied Claude model.
              const primary = await authorizeOAuth('main', signal)
              if (
                primary.accountIdentity !== identity.providerAccountUuid ||
                (identity.routingLineage &&
                  headerRoutingLineage(
                    primary.localSubject,
                    primary.scopedAttempt,
                  ) !== identity.routingLineage)
              )
                throw new Error('Primary identity changed before API fallback')
              accessToken = primary.accessToken
            }
            const credential = await nativeAccounts.authorizeApi(
              routeId,
              signal,
            )
            // Recheck the primary account's fresh quota after obtaining the
            // API credential. Only account-wide OAuth exhaustion permits API
            // fallback; model-only limits, auth errors or an unknown account
            // do not justify using a paid API route.
            const currentPrimary = (await nativeAccounts.read()).accounts.find(
              (row) => row.id === 'main',
            )
            if (
              currentPrimary?.binding &&
              localHeaderRoutingLineage(currentPrimary.binding) !==
                identity?.routingLineage
            )
              throw new Error('Primary identity changed before API fallback')
            if (!mainQuotaEntryIsFreshExhausted(accessToken, identity))
              throw new Error(
                'API fallback requires fresh general primary OAuth exhaustion',
              )
            return credential
          }
          async function sendWithApiAccount(
            input: string | URL | Request,
            init: RequestInit | undefined,
            account: ApiKeyAccount,
            trace?: PerfTrace,
            route = 'api_fallback',
            currentStorage?: Awaited<ReturnType<typeof loadAccounts>>,
            fableRequest?: FableRequestContext,
            mainAccessToken?: string,
            mainQuotaIdentity?: MainQuotaIdentityBinding,
          ) {
            void currentStorage
            if (fableRequest) {
              fableRequest.oauthAccountId = undefined
              fableRequest.opusCacheAnchor = undefined
            }
            const start = nowMs()
            const requestHeaders = mergeHeaders(input, init)
            const directAffinity =
              requestHeaders.get('x-session-affinity') ||
              requestHeaders.get('x-opencode-session')
            const subagentRequest = isSubagentRequest(requestHeaders)
            const effortPlanHeader =
              requestHeaders.get(EFFORT_PLAN_REQUEST_HEADER) ?? undefined
            const resolvedEffortPlan =
              effortPlanTracker.resolveHeader(effortPlanHeader)
            const effortPlanVersions = resolvedEffortPlan
              ? effortPlanTracker.versionsFor(
                  resolvedEffortPlan.sessionId,
                  resolvedEffortPlan.messageId,
                )
              : undefined
            requestHeaders.delete('x-parent-session-id')
            requestHeaders.delete('x-session-affinity')
            requestHeaders.delete('x-opencode-session')
            requestHeaders.delete('x-opencode-session-id')
            requestHeaders.delete('x-opencode-parent-session-id')
            requestHeaders.delete(EFFORT_PLAN_REQUEST_HEADER)
            requestHeaders.delete(BILLING_LINEAGE_REQUEST_HEADER)
            // The API-key route sends no Claude Code headers; drop the marker.
            requestHeaders.delete(REQUEST_CLASS_REQUEST_HEADER)
            let body = await fetchBody(input, init)
            let streaming = false
            let dump: DumpHandle | null = null
            let toolNameMap: ToolNameMap | undefined

            const originalBytes =
              typeof body === 'string' ? body.length : undefined
            if (body && typeof body === 'string') {
              const rewriteStart = nowMs()
              const fastModeRequested = (() => {
                if (!isFastModeEnabled()) return false
                try {
                  return isFastModeSupportedModel(JSON.parse(body).model)
                } catch {
                  return false
                }
              })()
              try {
                body = await rewriteRequestBody(body, {
                  onToolNameMap: (map) => {
                    toolNameMap = map
                  },
                  cache1hEnabled: !subagentRequest && isCache1hEnabled(),
                  cache1hMode: getCache1hMode(),
                  fastModeEnabled: fastModeRequested,
                  sessionId: directAffinity || undefined,
                  midConversationEffortEnabled: false,
                  midConversationEffortPlan: effortPlanHeader,
                  midConversationEffortResolvedPlan: resolvedEffortPlan,
                  midConversationEffortPlanVersions: effortPlanVersions,
                  modelRemapEnabled: true,
                  perf: (stage, data) =>
                    trace?.mark(`rewrite_body_${stage}`, { route, ...data }),
                })
              } catch (error) {
                if (error instanceof EffortMarkerCorrelationError) {
                  return effortMarkerFailureResponse(error)
                }
                if (error instanceof TrailingAssistantHistoryError) {
                  return trailingAssistantHistoryFailureResponse(error)
                }
                throw error
              }
              configureApiRouteHeaders(requestHeaders, account)
              requestHeaders.set(
                'anthropic-beta',
                mergeAnthropicBetas(requestHeaders.get('anthropic-beta'), []),
              )
              if (fastModeRequested) addFastModeBetaHeader(requestHeaders)
              try {
                streaming = JSON.parse(body).stream === true
              } catch {}
              trace?.mark('rewrite_body', {
                route,
                ms: roundMs(nowMs() - rewriteStart),
                originalBytes,
                rewrittenBytes: body.length,
                cacheEnabled: !subagentRequest && isCache1hEnabled(),
                cacheMode: getCache1hMode(),
                fastModeEnabled: fastModeRequested,
                subagent: subagentRequest,
              })
            } else {
              configureApiRouteHeaders(requestHeaders, account)
            }

            const cacheDiagnosticsBetas =
              await getCacheDiagnosticsBetas(requestHeaders)
            const apiCredential = await authorizePaidFallback(
              account.id,
              mainAccessToken,
              mainQuotaIdentity,
              init?.signal ?? undefined,
            )
            account = { ...account, ...apiCredential }
            configureApiRouteHeaders(requestHeaders, account)
            const rewritten = rewriteUrl(input, { baseURL: account.baseURL })
            const sendStart = nowMs()
            // Keep the sent API key only to redact provider errors. Clear that
            // copy when the body ends, is cancelled or fails; clear it immediately
            // when a successful non-streaming body bypasses redaction. The request's
            // stream flag selects the pipeline, never the response's content type.
            const scope = createProviderErrorResponseScope(
              [account.apiKey ?? ''],
              streaming ? 'event-stream' : 'http',
            )
            let response: Response
            try {
              // Redact the sent API key before response dumps, diagnostics or routing.
              response = scope.redactResponse(
                await fetch(rewritten.input, {
                  ...init,
                  body,
                  headers: requestHeaders,
                  ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                }),
              )
            } catch (caught) {
              const error = scope.redactError(caught)
              scope.dispose()
              if (typeof body === 'string') {
                await dumpDirectRequest({
                  affinity: directAffinity,
                  route,
                  // A fixed label: the error text can repeat provider output or a credential.
                  error: PHYSICAL_SEND_FAILED,
                  bodyText: body,
                  url:
                    rewritten.url?.toString() ?? fetchInputUrl(rewritten.input),
                  method: fetchMethod(input, init),
                  headers: requestHeaders,
                })
              }
              throw error
            }
            if (typeof body === 'string') {
              dump = await dumpDirectRequest({
                affinity: directAffinity,
                route,
                status: response.status,
                bodyText: body,
                url:
                  rewritten.url?.toString() ?? fetchInputUrl(rewritten.input),
                method: fetchMethod(input, init),
                headers: requestHeaders,
              })
            }
            attachCacheDiagnosticsResponse(response, {
              source: 'turn',
              toolNameMap,
              accountId: account.id,
              synthetic: false,
              ...cacheDiagnosticsBetas,
              requestedModel: parseRequestModel(body),
              dump,
              status: response.status,
              streaming,
            })
            trace?.mark('send_headers_received', {
              route,
              ms: roundMs(nowMs() - sendStart),
              status: response.status,
              relayConfigured: false,
              totalSendWithAccessMs: roundMs(nowMs() - start),
              baseURL: account.baseURL,
            })
            if (response.ok)
              usagePublications.publish(() =>
                nativeAccounts.publishApi(apiCredential.subject, {
                  lastUsed: Date.now(),
                }),
              )
            return response
          }

          async function sendWithAccessToken(
            input: string | URL | Request,
            init: RequestInit | undefined,
            accessToken: string,
            trace?: PerfTrace,
            route = 'unknown',
            currentStorage?: Awaited<ReturnType<typeof loadAccounts>>,
            oauthAccountId = 'main',
            fallbackAuthLineageId?: string,
            fableRequest?: FableRequestContext,
            laneStartRequest = false,
            mainQuotaIdentity?: MainQuotaIdentityResolution,
            scopedAttempt?: NativeCustodyReceipt,
          ) {
            assertNotCustodyTombstone(accessToken, 'anthropic')
            // The URL comes from the host's provider configuration, which a
            // project file in an opened repository can set. Refuse any
            // destination other than Anthropic before authorizing a token,
            // with a local 400 that no fallback account or retry repeats.
            const rewritten = rewriteUrl(input)
            if (
              !isAllowedOAuthDestination(
                rewritten.url?.toString() ?? fetchInputUrl(rewritten.input),
              )
            ) {
              logger.warn(
                'oauth-destination',
                'refused a Claude OAuth request to a non-Anthropic origin; nothing was sent',
                { route },
              )
              return localInvalidRequestResponse(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
            }
            // A request admitted with the placeholder cannot switch to a
            // separate login while native authorization or refresh is waiting.
            const separateLocalLogin = isRealHostLogin(await hostGetAuth())
            const start = nowMs()
            let requestStorage = currentStorage
            const getRequestStorage = async () => {
              requestStorage ??= await loadAccounts(accountStoragePath)
              return requestStorage
            }
            const requestHeaders = mergeHeaders(input, init)
            const relayAffinity =
              requestHeaders.get('x-session-affinity') ||
              requestHeaders.get('x-opencode-session')
            const subagentRequest = isSubagentRequest(requestHeaders)
            const effortPlanHeader =
              requestHeaders.get(EFFORT_PLAN_REQUEST_HEADER) ?? undefined
            const resolvedEffortPlan =
              effortPlanTracker.resolveHeader(effortPlanHeader)
            const effortPlanVersions = resolvedEffortPlan
              ? effortPlanTracker.versionsFor(
                  resolvedEffortPlan.sessionId,
                  resolvedEffortPlan.messageId,
                )
              : undefined
            const billingLineageHeader =
              requestHeaders.get(BILLING_LINEAGE_REQUEST_HEADER) ?? undefined
            const resolvedBillingLineage =
              billingLineageTracker.resolveHeader(billingLineageHeader)
            const activeBillingLineage =
              !subagentRequest && !laneStartRequest
                ? resolvedBillingLineage
                : undefined
            requestHeaders.delete('x-parent-session-id')
            requestHeaders.delete('x-session-affinity')
            requestHeaders.delete('x-opencode-session')
            requestHeaders.delete('x-opencode-session-id')
            requestHeaders.delete('x-opencode-parent-session-id')
            requestHeaders.delete(EFFORT_PLAN_REQUEST_HEADER)
            requestHeaders.delete(BILLING_LINEAGE_REQUEST_HEADER)
            const requestClass = takeRequestClassHeader(requestHeaders)
            let body = await fetchBody(input, init)
            const previousDiagnosticsMessage = relayAffinity
              ? cacheDiagnosticsTracker.previousFor(relayAffinity)
              : null
            const cacheDiagnosticsPreviousMessageId =
              previousDiagnosticsMessage?.messageId ?? null
            let cacheDiagnosticsRequest:
              | CacheDiagnosticsRequestContext
              | undefined
            let streaming = false
            let directDump: DumpHandle | null = null
            let relayDump: DumpHandle | null = null
            let toolNameMap: ToolNameMap | undefined
            let modelForIdentity: string | undefined
            if (body && typeof body === 'string') {
              const modelParseStart = nowMs()
              try {
                const parsedBody = JSON.parse(body) as { model?: unknown }
                if (typeof parsedBody.model === 'string') {
                  modelForIdentity = parsedBody.model
                }
              } catch {}
              trace?.mark('model_parse_for_identity', {
                route,
                ms: roundMs(nowMs() - modelParseStart),
                bodyBytes: body.length,
              })
            }
            let nativeAuthorization = await authorizeOAuth(
              oauthAccountId,
              init?.signal ?? undefined,
              undefined,
              modelForIdentity,
              oauthAccountId === 'main' ? 'last-main' : 'serve',
            )
            accessToken = nativeAuthorization.accessToken
            if (
              oauthAccountId === 'main' &&
              mainQuotaIdentity?.providerAccountUuid &&
              nativeAuthorization.accountIdentity !==
                mainQuotaIdentity.providerAccountUuid
            ) {
              throw new Error(
                'Main account identity changed after request routing',
              )
            }
            scopedAttempt = nativeAuthorization.scopedAttempt
            const identityStart = nowMs()
            const identity = nativeWireIdentity(
              nativeAuthorization.accountIdentity,
            )
            trace?.mark('resolve_claude_code_identity', {
              route,
              ms: roundMs(nowMs() - identityStart),
              hasAccountUuid: Boolean(identity.accountUuid),
            })

            const originalBytes =
              typeof body === 'string' ? body.length : undefined
            if (body && typeof body === 'string') {
              const rewriteStart = nowMs()
              const fastModeRequested = (() => {
                if (!isFastModeEnabled()) return false
                try {
                  return isFastModeSupportedModel(JSON.parse(body).model)
                } catch {
                  return false
                }
              })()
              const cacheEnabled = !subagentRequest && isCache1hEnabled()
              const cacheMode = getCache1hMode()
              const standbyCacheAnchor =
                fableRequest?.plan.downgraded &&
                fableRequest.plan.standbyCacheAnchor?.oauthAccountId ===
                  oauthAccountId
                  ? fableRequest.plan.standbyCacheAnchor
                  : undefined
              try {
                body = await rewriteRequestBody(body, {
                  onToolNameMap: (map) => {
                    toolNameMap = map
                  },
                  cache1hEnabled: cacheEnabled,
                  cache1hMode: cacheMode,
                  fastModeEnabled: fastModeRequested,
                  identity,
                  sessionId: relayAffinity || undefined,
                  thinkingPrefixMismatchBehavior:
                    getThinkingPrefixMismatchBehavior(
                      await getRequestStorage(),
                    ),
                  midConversationEffortEnabled: true,
                  turnEndNoteEnabled: true,
                  turnEndNote: (await getRequestStorage())?.turnEndNote,
                  midConversationEffortPlan: effortPlanHeader,
                  midConversationEffortResolvedPlan: resolvedEffortPlan,
                  midConversationEffortPlanVersions: effortPlanVersions,
                  hybridStandbyAnchor: standbyCacheAnchor,
                  serverSideFallbackEnabled: fallbackMode === 'server',
                  laneStart: laneStartRequest,
                  billingLineage: activeBillingLineage,
                  cacheDiagnosticsPreviousMessageId,
                  perf: (stage, data) => {
                    trace?.mark(`rewrite_body_${stage}`, { route, ...data })
                    if (
                      stage === 'cache_strategy' &&
                      data?.standbyBridgeApplied === true &&
                      fableRequest &&
                      !fableRequest.standbyBridgeLogged
                    ) {
                      fableRequest.standbyBridgeLogged = true
                      logger.info(
                        'fable-fallback',
                        'restored standby Opus cache bridge',
                        {
                          session: fableRequest.plan.sessionId,
                          distanceBlocks: data?.standbyDistanceBlocks,
                        },
                      )
                    }
                  },
                })
              } catch (error) {
                if (error instanceof EffortMarkerCorrelationError) {
                  return effortMarkerFailureResponse(error)
                }
                if (error instanceof TrailingAssistantHistoryError) {
                  return trailingAssistantHistoryFailureResponse(error)
                }
                throw error
              }
              if (
                fableRequest?.plan.downgraded &&
                cacheEnabled &&
                cacheMode === 'hybrid'
              ) {
                const anchor = extractLatestHybridMessageCacheAnchor(body)
                fableRequest.opusCacheAnchor = anchor
                  ? { ...anchor, oauthAccountId }
                  : undefined
              }
              const headerBodyParseStart = nowMs()
              try {
                const finalBody = JSON.parse(body) as Record<string, unknown>
                setOAuthHeaders(requestHeaders, accessToken, {
                  body: finalBody,
                  identity,
                  requestClass,
                })
                const diagnostics = finalBody.diagnostics
                const sentPreviousMessageId =
                  diagnostics &&
                  typeof diagnostics === 'object' &&
                  !Array.isArray(diagnostics) &&
                  (diagnostics as { previous_message_id?: unknown })
                    .previous_message_id === cacheDiagnosticsPreviousMessageId
                    ? cacheDiagnosticsPreviousMessageId
                    : undefined
                if (
                  sentPreviousMessageId !== undefined &&
                  requestHeaders
                    .get('anthropic-beta')
                    ?.split(',')
                    .map((beta) => beta.trim())
                    .includes(CACHE_DIAGNOSTICS_BETA)
                ) {
                  cacheDiagnosticsRequest = {
                    sessionId: relayAffinity ?? 'session-unknown',
                    previousMessageId: sentPreviousMessageId,
                    ...(previousDiagnosticsMessage
                      ? {
                          previousMessageReceivedAt:
                            previousDiagnosticsMessage.receivedAt,
                        }
                      : {}),
                    isSubagent: subagentRequest,
                    ttlSent: summarizeCacheTtl(finalBody),
                  }
                }
                streaming = finalBody.stream === true
                trace?.mark('set_oauth_headers_body_parse', {
                  route,
                  ms: roundMs(nowMs() - headerBodyParseStart),
                  bodyBytes: body.length,
                  parsed: true,
                })
              } catch {
                setOAuthHeaders(requestHeaders, accessToken, {
                  identity,
                  requestClass,
                })
                trace?.mark('set_oauth_headers_body_parse', {
                  route,
                  ms: roundMs(nowMs() - headerBodyParseStart),
                  bodyBytes: body.length,
                  parsed: false,
                })
              }
              if (fastModeRequested) addFastModeBetaHeader(requestHeaders)
              trace?.mark('rewrite_body', {
                route,
                ms: roundMs(nowMs() - rewriteStart),
                originalBytes,
                rewrittenBytes: body.length,
                cacheEnabled: !subagentRequest && isCache1hEnabled(),
                cacheMode: getCache1hMode(),
                fastModeEnabled: fastModeRequested,
                subagent: subagentRequest,
              })
            }

            const cacheDiagnosticsBetas =
              await getCacheDiagnosticsBetas(requestHeaders)
            if (fableRequest) fableRequest.oauthAccountId = oauthAccountId
            if (fableRequest) fableRequest.subagent = subagentRequest
            if (typeof body === 'string') {
              const storage = await getRequestStorage()
              if (
                isCache1hEnabled() &&
                getCache1hMode() === 'hybrid' &&
                (!subagentRequest || isCacheKeepSubagentsEnabled(storage))
              ) {
                const cacheKeepStart = nowMs()
                const tracked = cacheKeepManager.track({
                  sessionId: relayAffinity,
                  url: rewritten.url?.toString() ?? rewritten.input.toString(),
                  headers: requestHeaders,
                  bodyText: body,
                  storage,
                  cacheMode: 'hybrid',
                  oauthAccountId,
                  oauthAccountIdentity: nativeAuthorization?.accountIdentity,
                  isSubagent: subagentRequest,
                })
                trace?.mark('cachekeep_track', {
                  session: relayAffinity,
                  ms: roundMs(nowMs() - cacheKeepStart),
                  tracked: tracked.tracked,
                  reason: tracked.tracked ? undefined : tracked.reason,
                  bodyBytes: body.length,
                })
                // Remember a refusal-prone source send's account identity
                // and time. The keep itself takes the exact signed bytes
                // from CacheKeep's live target for the session, so only
                // this small metadata is stored per round.
                if (
                  relayAffinity &&
                  fableRequest &&
                  !fableRequest.plan.downgraded &&
                  tracked.tracked
                ) {
                  pendingSourceMeta.set(fableRequest.plan.recoveryKey, {
                    ...(nativeAuthorization.accountIdentity !== undefined && {
                      accountIdentity: nativeAuthorization.accountIdentity,
                    }),
                    sentAt: Date.now(),
                  })
                  while (pendingSourceMeta.size > 128) {
                    const oldest = pendingSourceMeta.keys().next().value
                    if (oldest === undefined) break
                    pendingSourceMeta.delete(oldest)
                  }
                }
              }
              // Source-warm maintenance runs for every sent request, even
              // when hybrid caching is off: turning CacheKeep or hybrid mode
              // off stops the warm for good.
              if (
                relayAffinity &&
                !subagentRequest &&
                fableFallbackManager.hasSourceWarmForSession(relayAffinity)
              ) {
                if (
                  activeBillingLineage &&
                  activeBillingLineage.sessionId === relayAffinity
                ) {
                  fableFallbackManager.noteSourceWarmUserTurn(
                    relayAffinity,
                    activeBillingLineage.promptId,
                  )
                }
                if (
                  !isCacheKeepPersistentlyEnabled(storage) ||
                  !isCache1hEnabled() ||
                  getCache1hMode() !== 'hybrid'
                ) {
                  dropSessionSourceWarms(relayAffinity)
                } else {
                  const currentAnchors =
                    hybridUserMessageCacheAnchorFingerprints(body)
                  const trackedIds = new Set(
                    cacheKeepManager.trackedSessions().map((s) => s.id),
                  )
                  for (const {
                    recoveryKey,
                    warm,
                  } of fableFallbackManager.sourceWarmsForSession(
                    relayAffinity,
                  )) {
                    const family = recoverableRefusalFamily(warm.model)
                    const targetId = family
                      ? sourceWarmTargetId(relayAffinity, family)
                      : undefined
                    if (
                      targetId !== undefined &&
                      !trackedIds.has(targetId) &&
                      // The CacheKeep track for a new keep lands just after the
                      // refusal is observed; a keep younger than that track
                      // flight may not be tracked yet.
                      Date.now() - warm.sentAt > 30_000
                    ) {
                      // The target expired or was evicted without a warm ever
                      // firing: the kept prefix outlived its cache entry.
                      fableFallbackManager.dropSourceWarm(recoveryKey)
                      continue
                    }
                    if (
                      warm.oauthAccountId !== 'main' &&
                      !storage?.accounts.some(
                        (account) =>
                          account.id === warm.oauthAccountId &&
                          nativeAccountCanServe(account),
                      )
                    ) {
                      fableFallbackManager.dropSourceWarm(recoveryKey)
                      if (targetId !== undefined)
                        cacheKeepManager.untrack(targetId)
                      logger.info(
                        'fable-fallback',
                        'source warm stopped: bound account unavailable',
                        {
                          session: relayAffinity,
                          reason: 'account-unavailable',
                        },
                      )
                      continue
                    }
                    // A new user turn whose history no longer starts with
                    // the kept prefix (compaction, history edit) makes the
                    // source cache unusable. Each user message that carries a
                    // cache breakpoint has a content fingerprint; histories
                    // only append after the kept prefix's earliest one, so
                    // checking that it is still present is the whole test.
                    if (
                      warm.firstAnchorFingerprint !== undefined &&
                      !currentAnchors.includes(warm.firstAnchorFingerprint)
                    ) {
                      fableFallbackManager.dropSourceWarm(recoveryKey)
                      if (targetId !== undefined)
                        cacheKeepManager.untrack(targetId)
                      logger.warn(
                        'fable-fallback',
                        'source warm stopped: history no longer starts with the kept prefix',
                        {
                          session: relayAffinity,
                          reason: 'source-prefix-changed',
                        },
                      )
                    }
                  }
                }
              }
            }

            const requestAuthority = nativeAuthorization
            let retryFromVault: NativeCustodyReceipt | undefined
            const authorizePhysical = async (rejectedAccessToken?: string) => {
              // Every physical attempt rechecks host admission, including retries.
              await requireCurrentNativeActivation(separateLocalLogin)
              init?.signal?.throwIfAborted()
              const current = await authorizeOAuth(
                oauthAccountId,
                init?.signal ?? undefined,
                rejectedAccessToken,
                modelForIdentity,
                oauthAccountId === 'main' ? 'last-main' : 'serve',
              )
              await requireCurrentNativeActivation(separateLocalLogin)
              init?.signal?.throwIfAborted()
              if (
                current.accountIdentity !== requestAuthority.accountIdentity ||
                Boolean(current.scopedAttempt) !==
                  Boolean(requestAuthority.scopedAttempt)
              ) {
                throw new Error(
                  'Native credential authority changed during the request',
                )
              }
              if (
                retryFromVault &&
                (!current.scopedAttempt ||
                  current.scopedAttempt.credentialId !==
                    retryFromVault.credentialId ||
                  current.scopedAttempt.accountIdentity !==
                    retryFromVault.accountIdentity ||
                  current.scopedAttempt.recordVersion <=
                    retryFromVault.recordVersion)
              ) {
                throw new Error(
                  'Native vault retry has no strict newer same-account receipt',
                )
              }
              return current
            }
            let usedDirectFetch = false
            let directAttempt = scopedAttempt

            const directFetch = async () => {
              usedDirectFetch = true
              // Validate current local credentials or obtain new vault
              // authorization before every direct send, including relay rescue.
              // Tokens checked earlier may have expired or been revoked.
              nativeAuthorization = await authorizePhysical()
              directAttempt = nativeAuthorization.scopedAttempt
              requestHeaders.set(
                'authorization',
                `Bearer ${nativeAuthorization.accessToken}`,
              )
              served = {
                ...served,
                accessToken: nativeAuthorization.accessToken,
                anthropicAccountUuid: asProviderAccountUuid(
                  nativeAuthorization.accountIdentity,
                ),
                localSubject: nativeAuthorization.localSubject,
                scopedAttempt: nativeAuthorization.scopedAttempt,
              }
              // Keep the sent token only to redact provider errors before dumps,
              // diagnostics, routing or host reads. Clear that copy when the
              // response finishes, errors or is cancelled.
              const scope = createProviderErrorResponseScope(
                [nativeAuthorization.accessToken],
                streaming ? 'event-stream' : 'http',
              )
              try {
                const physicalSend = (
                  wireBody: RequestInit['body'],
                  wireHeaders: Headers,
                ) =>
                  // fetchOAuth rechecks the destination and refuses redirects.
                  fetchOAuth(rewritten.input, {
                    ...init,
                    body: wireBody,
                    headers: wireHeaders,
                    ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                  })
                // Claude Code gzips large bodies on the wire. `body` stays the
                // signed uncompressed text: request dumps, CacheKeep prewarm
                // replays and the relay's direct fallback all reuse it.
                const response = scope.redactResponse(
                  typeof body === 'string'
                    ? await sendWithRequestGzip({
                        url:
                          rewritten.url?.toString() ??
                          fetchInputUrl(rewritten.input),
                        body,
                        headers: requestHeaders,
                        latch: requestGzipLatch,
                        send: physicalSend,
                      })
                    : await physicalSend(body, requestHeaders),
                )
                if (typeof body === 'string') {
                  directDump = await dumpDirectRequest({
                    affinity: relayAffinity,
                    route,
                    status: response.status,
                    bodyText: body,
                    url:
                      rewritten.url?.toString() ??
                      fetchInputUrl(rewritten.input),
                    method: fetchMethod(input, init),
                    headers: requestHeaders,
                    tag: laneStartRequest ? 'start' : undefined,
                  })
                }
                return response
              } catch (caught) {
                const error = scope.redactError(caught)
                scope.dispose()
                if (typeof body === 'string') {
                  await dumpDirectRequest({
                    affinity: relayAffinity,
                    route,
                    // A fixed label: the error text can repeat provider output or a credential.
                    error: PHYSICAL_SEND_FAILED,
                    bodyText: body,
                    url:
                      rewritten.url?.toString() ??
                      fetchInputUrl(rewritten.input),
                    method: fetchMethod(input, init),
                    headers: requestHeaders,
                    tag: laneStartRequest ? 'start' : undefined,
                  })
                }
                throw error
              }
            }

            const requestStorageForIdentity = await getRequestStorage()
            let relayConfig: Awaited<
              ReturnType<typeof nativeAccounts.getRelayConfig>
            >
            try {
              relayConfig = await nativeAccounts.getRelayConfig()
            } catch (error) {
              if (
                error instanceof NativeRuntimeError &&
                error.code === 'relay-inconsistent'
              )
                return localInvalidRequestResponse(error.message)
              throw error
            }
            const persistedFallbackAccount =
              oauthAccountId === 'main'
                ? undefined
                : requestStorageForIdentity?.accounts.find(
                    (account): account is OAuthAccount =>
                      account.id === oauthAccountId && isOAuthAccount(account),
                  )
            const persistedFallbackAccountUuid = fallbackAccountUuidForLineage(
              persistedFallbackAccount,
              fallbackAuthLineageId,
            )
            let served = {
              accountId: oauthAccountId,
              accessToken,
              authLineageId: fallbackAuthLineageId,
              anthropicAccountUuid:
                asProviderAccountUuid(scopedAttempt?.accountIdentity) ??
                (oauthAccountId === 'main'
                  ? mainQuotaIdentity?.providerAccountUuid
                  : (asProviderAccountUuid(identity.accountUuid) ??
                    asProviderAccountUuid(persistedFallbackAccountUuid))),
              localSubject: nativeAuthorization.localSubject,
              scopedAttempt: nativeAuthorization.scopedAttempt,
              ...(oauthAccountId === 'main' && mainQuotaIdentity
                ? { mainQuotaIdentity }
                : {}),
            }
            const sendStart = nowMs()
            let relay401Attempt: NativeCustodyReceipt | undefined
            // Set once this dispatch has made its final retry decision. Before
            // that, a relayed upstream 401 is only recorded: the dispatch may
            // still replay on a newer version, which makes this one obsolete.
            let relayReturned = false
            let routingHeaders: Headers | undefined
            const reportScoped401 = reportVault401
            // The relay scrubs each physical relay attempt's responses and
            // errors with that attempt's own credentials and the relay token;
            // a direct fallback is scrubbed by directFetch.
            const sendOnce = () =>
              sendViaRelay({
                config: relayConfig,
                input: rewritten.input,
                // The envelope's upstream.url carries the bearer to that URL.
                requireUpstreamUrl: requireOAuthDestination,
                init,
                headers: requestHeaders,
                body,
                fallback: directFetch,
                affinity: relayAffinity,
                optimisticResponse: relayConfig?.transport === 'websocket',
                authorizeAttempt: async () => {
                  const nextAuthorization = await authorizePhysical()
                  const nextAttempt = nextAuthorization.scopedAttempt
                  nativeAuthorization = nextAuthorization
                  served = {
                    ...served,
                    accessToken: nextAuthorization.accessToken,
                    anthropicAccountUuid: asProviderAccountUuid(
                      nextAuthorization.accountIdentity,
                    ),
                    localSubject: nextAuthorization.localSubject,
                    scopedAttempt: nextAttempt,
                  }
                  const relayHeaders = new Headers(requestHeaders)
                  relayHeaders.set(
                    'authorization',
                    `Bearer ${nextAuthorization.accessToken}`,
                  )
                  return {
                    headers: relayHeaders,
                    errorSecrets: [nextAuthorization.accessToken],
                    onUpstreamStatus: (status: number) => {
                      if (status !== 401 || !nextAttempt) return
                      relay401Attempt = nextAttempt
                      // A WebSocket can deliver a real upstream 401 after its
                      // optimistic response was handed to the host. Report
                      // then the exact version used for this send, never a
                      // newer version obtained after the rejection.
                      if (relayReturned)
                        void reportScoped401(nextAttempt, 'relay_status_field')
                    },
                  }
                },
                onResponseHeaders: (headers) => {
                  routingHeaders = headers
                  harvestQuotaHeaders(headers, served)
                  billingLineageTracker.commit(
                    activeBillingLineage,
                    extractAnthropicRequestId(headers),
                  )
                },
                onDumpCreated: (handle) => {
                  relayDump = handle
                },
                dumpTag: laneStartRequest ? 'start' : undefined,
              })
            return trackDispatch(async () => {
              let response = await sendOnce()
              if (
                !usedDirectFetch &&
                relay401Attempt &&
                response.status === 401 &&
                typeof body === 'string' &&
                (fetchMethod(input, init) ?? '').toUpperCase() === 'POST' &&
                !init?.signal?.aborted
              ) {
                let rotated: NativeCustodyReceipt | undefined
                try {
                  rotated = await prepareVaultRetry(
                    relay401Attempt,
                    'model-relay',
                    init?.signal ?? undefined,
                  )
                } catch {
                  // Keep the 401 and report the exact relay-served record below.
                }
                if (rotated) {
                  await response.body?.cancel().catch(() => {})
                  logger.info(
                    'claustrum',
                    'retrying after scoped credential rotation',
                    {
                      accountId: oauthAccountId,
                      previousVersion: relay401Attempt.recordVersion,
                      newVersion: rotated.recordVersion,
                      transport: 'relay',
                    },
                  )
                  retryFromVault = relay401Attempt
                  relay401Attempt = undefined
                  // sendOnce obtains its own fresh receipt for this HTTP retry.
                  response = await sendOnce()
                }
              }
              if (
                usedDirectFetch &&
                directAttempt &&
                response.status === 401 &&
                typeof body === 'string' &&
                (fetchMethod(input, init) ?? '').toUpperCase() === 'POST' &&
                !init?.signal?.aborted
              ) {
                let rotated: NativeCustodyReceipt | undefined
                try {
                  rotated = await prepareVaultRetry(
                    directAttempt,
                    'model',
                    init?.signal ?? undefined,
                  )
                } catch {
                  // Preserve the genuine 401 if no replacement can be verified.
                }
                if (rotated) {
                  await response.body?.cancel().catch(() => {})
                  logger.info(
                    'claustrum',
                    'retrying after scoped credential rotation',
                    {
                      accountId: oauthAccountId,
                      previousVersion: directAttempt.recordVersion,
                      newVersion: rotated.recordVersion,
                      transport: 'direct',
                    },
                  )

                  retryFromVault = directAttempt
                  // Transport failures on the new attempt must propagate. They
                  // are not evidence that the new record's token was rejected.
                  response = await directFetch()
                }
              }
              if (
                response.status === 401 &&
                !nativeAuthorization.scopedAttempt &&
                typeof body === 'string' &&
                (fetchMethod(input, init) ?? '').toUpperCase() === 'POST' &&
                !init?.signal?.aborted
              ) {
                const rejectedAccess = nativeAuthorization.accessToken
                let replacement: NativeOAuthAuthorization | undefined
                try {
                  replacement = await authorizePhysical(rejectedAccess)
                } catch (error) {
                  nativeLocalRefreshFailures.set(response, error)
                }
                if (replacement && replacement.accessToken !== rejectedAccess) {
                  await response.body?.cancel().catch(() => {})
                  response = usedDirectFetch
                    ? await directFetch()
                    : await sendOnce()
                }
              }
              trace?.mark('send_headers_received', {
                route,
                ms: roundMs(nowMs() - sendStart),
                status: response.status,
                relayConfigured: relayConfig != null,
                totalSendWithAccessMs: roundMs(nowMs() - start),
              })

              if (usedDirectFetch) {
                harvestQuotaHeaders(response.headers, served)
                billingLineageTracker.commit(
                  activeBillingLineage,
                  extractAnthropicRequestId(response.headers),
                )
              }
              if (relayAffinity && !laneStartRequest) {
                const headers = usedDirectFetch
                  ? response.headers
                  : (routingHeaders ?? response.headers)
                // All retries for one client request reuse its trace, so report served only once.
                const servedTurn =
                  response.status < 400 &&
                  (!trace || !routingServedTurns.has(trace))
                if (servedTurn && trace) routingServedTurns.add(trace)
                const subject = {
                  accountIdentity: nativeAuthorization.accountIdentity,
                  credentialId: nativeAuthorization.scopedAttempt?.credentialId,
                }
                routingRelay.report(
                  relayAffinity,
                  subject,
                  headers,
                  response.status,
                  modelForIdentity,
                  servedTurn,
                )
                if (response.status === 200) {
                  // Keep the upstream headers before sticky retries replace the
                  // response's status or Retry-After for the host.
                  routingStreamLimits.set(response, () =>
                    routingRelay.report(
                      relayAffinity,
                      subject,
                      headers,
                      429,
                      modelForIdentity,
                      false,
                    ),
                  )
                }
              }
              attachCacheDiagnosticsResponse(response, {
                source: laneStartRequest ? 'start' : 'turn',
                toolNameMap,
                accountId: oauthAccountId,
                synthetic: laneStartRequest,
                ...cacheDiagnosticsBetas,
                requestedModel: parseRequestModel(body),
                request: cacheDiagnosticsRequest,
                trackSessionId: relayAffinity ?? undefined,
                dump: usedDirectFetch ? directDump : relayDump,
                status: response.status,
                streaming,
              })
              if (usedDirectFetch && directAttempt && response.status === 401) {
                await reportScoped401(directAttempt, 'direct')
              }
              relayReturned = true
              if (!usedDirectFetch && relay401Attempt) {
                await reportScoped401(relay401Attempt, 'relay_status_field')
              }
              // The vault has been told about the 401 above. If the request was
              // cancelled after the 401 arrived (before or while the vault was
              // asked for a newer credential), end it as cancelled here.
              if (response.status === 401)
                await endIfCancelled(response, init?.signal)
              if (response.ok) {
                usagePublications.publish(async () => {
                  if (served.scopedAttempt)
                    await nativeAccounts.vault.publish(served.scopedAttempt, {
                      lastUsed: Date.now(),
                    })
                  else if (served.localSubject)
                    await nativeAccounts.publishLocal(served.localSubject, {
                      lastUsed: Date.now(),
                    })
                })
              }
              return response
            })
          }

          function getFallbackQuota(account: {
            id: string
            access?: string
            quota?: OAuthQuotaSnapshot
            authLineageId?: string
          }): OAuthQuotaSnapshot | undefined {
            // Cached entries are scoped to stable account ids; token rotation
            // must not discard an otherwise valid account-level observation.
            return (
              quotaManager.getFallback(account.id, account)?.quota ??
              account.quota
            )
          }

          function responseShowsMainQuotaExhausted(
            response: Response,
            streamingRateLimited: boolean,
          ) {
            return response.status === 429 || streamingRateLimited
          }

          function routingMainQuotaEntry(
            identity?: MainQuotaIdentityBinding,
            storage: AccountStorage | null = headerRoutingPolicyStorage,
          ) {
            return routingQuotaEntry(
              'main',
              identity?.routingLineage,
              identity?.providerAccountUuid,
              quotaManager.getMain(identity?.quotaKey ?? mainQuotaAccountId),
              storage,
            )
          }
          function mainQuotaEntryIsFreshExhausted(
            accessToken?: string,
            mainQuotaIdentity?: MainQuotaIdentityBinding,
          ) {
            if (!accessToken && !mainQuotaIdentity?.providerAccountUuid)
              return false
            const entry = routingMainQuotaEntry(mainQuotaIdentity)
            // Native metadata can establish account-owned exhaustion before
            // primary credential authorization. The API send still validates
            // that credential and rechecks this quota before dispatch.
            return Boolean(
              entry &&
                (accessToken ||
                  entry.quota.accountIdentity ===
                    mainQuotaIdentity?.providerAccountUuid) &&
                entry.refreshAfter > Date.now() &&
                quotaSnapshotIsExhausted(entry.quota) &&
                (entry.quota.source !== 'headers' ||
                  currentHeaderRoutingObservation(
                    'main',
                    mainQuotaIdentity?.routingLineage,
                    mainQuotaIdentity?.providerAccountUuid,
                  )?.generalExhausted === true ||
                  (['five_hour', 'seven_day'] as const).some(
                    (key) =>
                      entry.quota.fieldSources?.[key] === 'poll' &&
                      (entry.quota[key]?.remainingPercent ?? 1) <= 0,
                  )),
            )
          }

          async function refreshMainQuotaConfirmsExhausted(
            accessToken?: string,
            mainQuotaIdentity?: MainQuotaIdentityBinding,
          ) {
            if (!accessToken) return false
            try {
              await quotaManager.refreshMain(
                mainQuotaIdentity?.quotaKey ?? mainQuotaAccountId,
                accessToken,
                mainQuotaIdentity?.generation,
              )
              return mainQuotaEntryIsFreshExhausted(
                accessToken,
                mainQuotaIdentity,
              )
            } catch {
              return false
            }
          }

          // All fallback-selection paths apply killswitch policy after finding
          // usable accounts; softer quota routing cannot bypass a killswitch.
          async function getRoutableFallbackAccounts(
            storageArg: Awaited<ReturnType<typeof loadAccounts>>,
            options: { includeApiRoutes?: boolean; modelId?: string } = {},
          ): Promise<Array<OAuthAccount | ApiKeyAccount>> {
            // Ordered eligibility needs current quota even when hard-limit
            // enforcement (the killswitch) is off. The serialized sweep reuses
            // fresh readings without waiting for their persistence to disk.
            const requiredByPolicy = isKillswitchEnabled(storageArg)
            const unavailable = await refreshFallbackQuotas(
              false,
              requiredByPolicy,
              options.modelId,
              'admission',
            )
            // Polling can also bind a newly discovered account UUID. Filter
            // the fresh native overlay, not the request's earlier account view.
            storageArg = await loadAccounts(accountStoragePath)
            if (requiredByPolicy) {
              if (storageArg && unavailable.size)
                storageArg = {
                  ...storageArg,
                  accounts: storageArg.accounts.filter(
                    (account) =>
                      !unavailable.has(account.id) ||
                      killswitchPassesPolicy(
                        undefined,
                        storageArg,
                        account.id,
                        options.modelId,
                      ),
                  ),
                }
            }
            const usableOAuth = await fallbackManager.getUsableFallbackAccounts(
              storageArg,
              { modelId: options.modelId },
            )
            const usableOAuthById = new Map(
              usableOAuth.map((account) => [account.id, account]),
            )
            const usable: Array<OAuthAccount | ApiKeyAccount> = []
            for (const account of storageArg?.accounts ?? []) {
              if (storageArg && isOAuthAccount(account)) {
                if (isScopedCustodyActive(storageArg)) {
                  const usableAccount = usableOAuthById.get(account.id)
                  if (usableAccount) usable.push(usableAccount)
                  continue
                }
                if (getClaustrumMode(storageArg) !== 'local') continue
                const usableAccount = usableOAuthById.get(account.id)
                if (usableAccount) {
                  usable.push(usableAccount)
                } else if (
                  account.access &&
                  (!account.expires || account.expires > Date.now()) &&
                  !isPermanentRefreshError(account.lastRefreshError) &&
                  !refreshBackoffActive(
                    account.lastRefreshError,
                    account.id,
                    Date.now(),
                    tokenFingerprint(account.refresh),
                  ) &&
                  storageArg?.quota?.failClosedOnUnknownQuota !== true &&
                  !quotaSnapshotHasStandardWindows(getFallbackQuota(account))
                ) {
                  usable.push(account)
                }
                continue
              }
              if (
                options.includeApiRoutes === true &&
                isApiKeyAccount(account) &&
                nativeAccountCanServe(account) &&
                isValidApiBaseURL(account.baseURL)
              ) {
                usable.push(account)
              }
            }
            if (!isKillswitchEnabled(storageArg)) return usable
            return usable.filter((account) =>
              isOAuthAccount(account)
                ? killswitchPassesPolicy(
                    getFallbackQuota(account),
                    storageArg,
                    account.id,
                    options.modelId,
                  )
                : true,
            )
          }

          async function buildStickyOAuthRoutes(input: {
            storage: AccountStorage | null
            mainAccessToken: string
            mainRefreshToken?: string
            mainPolicyDenied?: boolean
            requestedModelId?: string
            mainQuotaIdentity?: MainQuotaIdentityBinding
          }) {
            const mainQuotaIdentity = input.mainQuotaIdentity?.quotaKey
            const mainEntry = quotaManager.getMain(mainQuotaIdentity)
            let mainQuota = mainEntry?.quota
            if (
              !stickyQuotaSnapshotIsFresh(
                mainEntry?.quota,
                input.storage,
                Date.now(),
                input.requestedModelId,
              )
            ) {
              try {
                mainQuota = await quotaManager.refreshMain(
                  mainQuotaIdentity,
                  input.mainAccessToken,
                  input.mainQuotaIdentity?.generation,
                  'admission',
                )
              } catch {}
            }
            const usableFallbacks =
              await fallbackManager.getUsableFallbackAccounts(input.storage, {
                modelId: input.requestedModelId,
              })
            const latestStorage =
              (await loadAccounts(accountStoragePath)) ?? input.storage
            const allRoutes: StickyOAuthRoute[] = []
            const isScoped = isScopedCustodyActive(latestStorage)
            if (isScoped) {
              const primary = latestStorage?.claustrum?.primaryAccount
              const primaryAvailable =
                primary !== undefined &&
                nativeAccountCanServe(primary) &&
                !latestStorage?.claustrum?.disabledAccountIdentities?.includes(
                  primary.accountId,
                )
              if (primaryAvailable) {
                allRoutes.push({
                  id: STICKY_ROUTING_MAIN_ACCOUNT_ID,
                  access: '',
                  quota: mainQuota,
                  identity: primary
                    ? { kind: 'known', accountId: primary.accountId }
                    : { kind: 'unknown' },
                  order: 0,
                  scoped: true,
                })
              }
            } else if (
              (input.mainAccessToken || input.mainPolicyDenied) &&
              !isPermanentRefreshError(
                latestStorage?.refresh?.mainLastRefreshError,
              )
            ) {
              allRoutes.push({
                id: STICKY_ROUTING_MAIN_ACCOUNT_ID,
                access: input.mainAccessToken,
                quota: mainQuota,
                identity: mainQuotaIdentity
                  ? { kind: 'known', accountId: mainQuotaIdentity }
                  : { kind: 'unknown' },
                order: 0,
              })
            }
            if (isScoped) {
              for (const [index, stored] of (
                latestStorage?.accounts ?? []
              ).entries()) {
                if (!nativeAccountCanServe(stored) || !isOAuthAccount(stored))
                  continue
                if (stored.claustrumScopedCredentialId) {
                  let accountQuota = getFallbackQuota(stored)
                  if (
                    !stickyQuotaSnapshotIsFresh(
                      accountQuota,
                      latestStorage,
                      Date.now(),
                      input.requestedModelId,
                    )
                  ) {
                    try {
                      accountQuota = await quotaManager.refreshFallback(
                        stored.id,
                        '',
                        stored,
                      )
                    } catch {}
                  }
                  allRoutes.push({
                    id: stored.id,
                    access: '',
                    quota: accountQuota,
                    identity: { kind: 'known', accountId: stored.id },
                    order: index + 1,
                    account: stored,
                    scoped: true,
                  })
                }
              }
            } else {
              const usableFallbacksById = new Map(
                usableFallbacks.map((candidate) => [candidate.id, candidate]),
              )
              for (const [index, stored] of (
                latestStorage?.accounts ?? []
              ).entries()) {
                if (!nativeAccountCanServe(stored) || !isOAuthAccount(stored))
                  continue
                const account = usableFallbacksById.get(stored.id) ?? stored
                // Retain temporarily unavailable account metadata so sticky
                // sessions can keep their account assignment. Only IDs with
                // separately authorized credentials can serve requests;
                // these empty access fields cannot supply a bearer token.
                if (isPermanentRefreshError(account.lastRefreshError)) continue
                let accountQuota = getFallbackQuota(account)
                if (
                  !stickyQuotaSnapshotIsFresh(
                    accountQuota,
                    latestStorage,
                    Date.now(),
                    input.requestedModelId,
                  )
                ) {
                  try {
                    accountQuota = await quotaManager.refreshFallback(
                      account.id,
                      account.access ?? '',
                      account,
                    )
                  } catch {}
                }
                allRoutes.push({
                  id: account.id,
                  access: account.access ?? '',
                  quota: accountQuota,
                  identity: { kind: 'known', accountId: account.id },
                  order: index + 1,
                  account,
                })
              }
            }

            const usableIds = new Set(
              usableFallbacks.map((account) => account.id),
            )
            const retainAccountIds = new Set(
              allRoutes.flatMap((route) => {
                const refreshError =
                  route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                    ? latestStorage?.refresh?.mainLastRefreshError
                    : route.account?.lastRefreshError
                const sidecarRefreshError = !route.scoped
                const accountIdentity =
                  route.identity.kind === 'known'
                    ? route.identity.accountId
                    : undefined
                if (
                  sidecarRefreshError &&
                  isPermanentRefreshError(refreshError)
                )
                  return []
                if (
                  sidecarRefreshError &&
                  refreshBackoffActive(
                    refreshError,
                    accountIdentity,
                    Date.now(),
                    route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                      ? input.mainRefreshToken
                        ? tokenFingerprint(input.mainRefreshToken)
                        : undefined
                      : route.account?.refresh
                        ? tokenFingerprint(route.account.refresh)
                        : undefined,
                  ) &&
                  (route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ||
                    !usableIds.has(route.id))
                )
                  return []
                if (
                  stickyQuotaSnapshotIsFresh(
                    route.quota,
                    latestStorage,
                    Date.now(),
                    input.requestedModelId,
                  ) &&
                  decideStickyQuotaFailure({
                    quota: route.quota,
                    modelId: input.requestedModelId,
                  }).action === 'migrate'
                ) {
                  return []
                }
                if (
                  isKillswitchEnabled(latestStorage) &&
                  !killswitchPassesPolicy(
                    route.quota,
                    latestStorage,
                    route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                      ? undefined
                      : route.id,
                    input.requestedModelId,
                  )
                ) {
                  return []
                }
                return [route.id]
              }),
            )
            const candidates: StickyRouteCandidate[] = allRoutes.flatMap(
              (route) => {
                const refreshError =
                  route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                    ? latestStorage?.refresh?.mainLastRefreshError
                    : route.account?.lastRefreshError
                const sidecarRefreshError = !route.scoped
                const accountIdentity =
                  route.identity.kind === 'known'
                    ? route.identity.accountId
                    : undefined
                if (
                  (sidecarRefreshError &&
                    isPermanentRefreshError(refreshError)) ||
                  (sidecarRefreshError &&
                    refreshBackoffActive(
                      refreshError,
                      accountIdentity,
                      Date.now(),
                      route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                        ? input.mainRefreshToken
                          ? tokenFingerprint(input.mainRefreshToken)
                          : undefined
                        : route.account?.refresh
                          ? tokenFingerprint(route.account.refresh)
                          : undefined,
                    ) &&
                    (route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ||
                      !usableIds.has(route.id)))
                )
                  return []
                const accountId =
                  route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                    ? undefined
                    : route.id
                const quota = quotaSnapshotHasStandardWindows(route.quota)
                  ? route.quota
                  : undefined
                const quotaState: QuotaState = quota
                  ? { kind: 'known', quota }
                  : { kind: 'unknown' }
                const passesKillswitch =
                  !isKillswitchEnabled(latestStorage) ||
                  killswitchPassesPolicy(
                    quotaState.kind === 'known' ? quotaState.quota : undefined,
                    latestStorage,
                    accountId,
                    input.requestedModelId,
                  )
                const passes =
                  passesKillswitch &&
                  quotaSnapshotPassesPolicy(
                    quotaState.kind === 'known' ? quotaState.quota : undefined,
                    latestStorage,
                  ) &&
                  (quotaState.kind === 'unknown' ||
                    (quotaSnapshotPassesModelScope(
                      quotaState.quota,
                      input.requestedModelId,
                    ) &&
                      (route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID ||
                        usableIds.has(route.id) ||
                        Boolean(route.scoped))))
                return passes
                  ? [
                      {
                        accountId: route.id,
                        quota: quotaState,
                        order: route.order,
                      },
                    ]
                  : []
              },
            )
            return {
              storage: latestStorage,
              allRoutes,
              candidates,
              retainAccountIds,
            }
          }

          const responseRouteKinds = new WeakMap<Response, 'oauth' | 'api'>()

          async function tryUsableFallbackAccounts(
            input: string | URL | Request,
            init: RequestInit | undefined,
            accounts: Array<OAuthAccount | ApiKeyAccount>,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
            currentResponse?: Response,
            trace?: PerfTrace,
            options?: {
              returnLastOnExhausted?: boolean
              mainAccessToken?: string
              mainQuotaIdentity?: MainQuotaIdentityBinding
              onSuccess?: (account: {
                id: string
                access?: string
              }) => void | Promise<void>
              fableRequest?: FableRequestContext
              laneStartRequest?: boolean
            },
          ) {
            if (!accounts.length) return currentResponse ?? null

            const returnLastOnExhausted = options?.returnLastOnExhausted ?? true
            let lastResponse: Response | null = currentResponse ?? null
            let canceledCurrentResponse = false
            const cancelCurrentResponse = async () => {
              if (canceledCurrentResponse) return
              canceledCurrentResponse = true
              await currentResponse?.body?.cancel().catch(() => {})
            }

            for (const [index, account] of accounts.entries()) {
              let response: Response
              if (isApiKeyAccount(account)) {
                await cancelCurrentResponse()
                response = await sendWithApiAccount(
                  input,
                  init,
                  account,
                  trace,
                  `api_fallback_${index}`,
                  storage,
                  options?.fableRequest,
                  options?.mainAccessToken,
                  options?.mainQuotaIdentity,
                )
              } else if (
                isScopedCustodyActive(storage) &&
                account.claustrumScopedCredentialId
              ) {
                let credential: NativeOAuthAuthorization
                try {
                  credential = await authorizeOAuth(
                    account.id,
                    init?.signal ?? undefined,
                    undefined,
                    parseRequestModel(await fetchBody(input, init)),
                  )
                } catch (error) {
                  if (error instanceof NativeModelPolicyError) continue
                  throw error
                }
                const scopedAttempt = credential.scopedAttempt
                if (!scopedAttempt)
                  throw new Error(
                    'Native vault fallback credential is unavailable',
                  )
                await cancelCurrentResponse()
                response = await sendWithAccessToken(
                  input,
                  init,
                  scopedAttempt.accessToken,
                  trace,
                  `fallback_${index}`,
                  storage,
                  account.id,
                  account.authLineageId,
                  options?.fableRequest,
                  options?.laneStartRequest,
                  undefined,
                  scopedAttempt,
                )
              } else if (
                getClaustrumMode(storage) === 'local' &&
                account.access
              ) {
                await cancelCurrentResponse()
                response = await sendWithAccessToken(
                  input,
                  init,
                  account.access,
                  trace,
                  `fallback_${index}`,
                  storage,
                  account.id,
                  account.authLineageId,
                  options?.fableRequest,
                  options?.laneStartRequest,
                )
              } else continue
              lastResponse = response
              let fallbackAgain = shouldFallbackResponse(response, storage)
              if (!fallbackAgain) {
                const inspected = await inspectStreamingRateLimit(
                  response,
                  trace,
                )
                response = inspected.response
                lastResponse = response
                fallbackAgain = inspected.rateLimited
              }
              if (!fallbackAgain) {
                responseRouteKinds.set(
                  response,
                  isApiKeyAccount(account) ? 'api' : 'oauth',
                )

                await options?.onSuccess?.(account)
                // Active-route every-N refresh: this fallback just served the
                // request, so keep its quota fresh on the same cadence as main.
                // Non-blocking; only the served account, never idle fallbacks.
                if (
                  isOAuthAccount(account) &&
                  mainQuotaRoutingEnabled(storage) &&
                  quotaManager.shouldRefreshOnRequestCount(sessionRequestCount)
                ) {
                  if (isScopedCustodyActive(storage) || account.access) {
                    void quotaManager
                      .refreshFallback(
                        account.id,
                        isScopedCustodyActive(storage)
                          ? ''
                          : (account.access ?? ''),
                        account,
                      )
                      .then(() => options?.onSuccess?.(account))
                      .catch(() => {})
                  }
                }
                return response
              }
              if (index < accounts.length - 1 || !returnLastOnExhausted) {
                await response.body?.cancel().catch(() => {})
              }
            }

            return returnLastOnExhausted ? lastResponse : null
          }

          async function tryFallbackAccounts(
            input: string | URL | Request,
            init: RequestInit | undefined,
            mainResponse: Response,
            preselectedAccounts?: Array<OAuthAccount | ApiKeyAccount>,
            trace?: PerfTrace,
            existingStorage?: Awaited<ReturnType<typeof loadAccounts>>,
            mainAccessToken?: string,
            onFallbackSuccess?: (account: {
              id: string
              access?: string
            }) => void | Promise<void>,
            modelId?: string,
            fableRequest?: FableRequestContext,
            laneStartRequest = false,
            mainQuotaIdentity?: MainQuotaIdentityBinding,
          ) {
            if (!isReplayableRequest(input, init?.body)) return mainResponse

            const loadStart = nowMs()
            const storage =
              existingStorage ?? (await loadAccounts(accountStoragePath))
            trace?.mark('fallback_load_storage', {
              ms: roundMs(nowMs() - loadStart),
              cached: !!existingStorage,
            })
            const hasPotentialFallbackRoute = (storage?.accounts ?? []).some(
              (account) =>
                nativeAccountCanServe(account) &&
                (isOAuthAccount(account) ||
                  (isApiKeyAccount(account) &&
                    isValidApiBaseURL(account.baseURL))),
            )
            if (!hasPotentialFallbackRoute) return mainResponse

            let currentResponse = mainResponse
            let shouldFallback = shouldFallbackResponse(
              currentResponse,
              storage,
            )
            let mainQuotaExhaustedByResponse = responseShowsMainQuotaExhausted(
              currentResponse,
              false,
            )
            if (!shouldFallback) {
              const inspected = await inspectStreamingRateLimit(
                currentResponse,
                trace,
              )
              currentResponse = inspected.response
              shouldFallback = inspected.rateLimited
              mainQuotaExhaustedByResponse = responseShowsMainQuotaExhausted(
                currentResponse,
                inspected.rateLimited,
              )
            }
            if (!shouldFallback) {
              return currentResponse
            }
            let includeApiRoutes = false
            if (preselectedAccounts) {
              includeApiRoutes = preselectedAccounts.some(isApiKeyAccount)
            } else if (mainQuotaExhaustedByResponse) {
              includeApiRoutes = await refreshMainQuotaConfirmsExhausted(
                mainAccessToken,
                mainQuotaIdentity,
              )
            }

            let accounts = preselectedAccounts
            if (!accounts) {
              const accountsStart = nowMs()
              accounts = await getRoutableFallbackAccounts(storage, {
                includeApiRoutes,
                modelId,
              })
              trace?.mark('fallback_get_accounts', {
                ms: roundMs(nowMs() - accountsStart),
                accounts: accounts.length,
              })
            }
            if (isKillswitchEnabled(storage)) {
              const before = accounts.length
              accounts = accounts.filter((a) =>
                isOAuthAccount(a)
                  ? // Prefer the fresh QuotaManager cache (updated by the eager
                    // killswitch refresh) over the request-start storage snapshot,
                    // matching the other killswitch fallback filters.
                    killswitchPassesPolicy(
                      getFallbackQuota(a),
                      storage,
                      a.id,
                      modelId,
                    )
                  : true,
              )
              if (accounts.length < before) {
                log('[killswitch] filtered fallbacks', {
                  before,
                  after: accounts.length,
                })
              }
            }
            return (
              (await tryUsableFallbackAccounts(
                input,
                init,
                accounts,
                storage,
                currentResponse,
                trace,
                {
                  onSuccess: onFallbackSuccess,
                  mainAccessToken,
                  mainQuotaIdentity,
                  fableRequest,
                  laneStartRequest,
                },
              )) ?? currentResponse
            )
          }

          return withAbortableFetch({
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              if (input instanceof Request && init?.signal === undefined)
                init = { ...init, signal: input.signal }
              const incomingHeaders = mergeHeaders(input, init)
              const laneStartRequest =
                incomingHeaders.get(LANE_START_REQUEST_HEADER) === '1'
              incomingHeaders.delete(LANE_START_REQUEST_HEADER)
              init = { ...init, headers: incomingHeaders }
              const sessionId =
                incomingHeaders.get('x-session-affinity') ||
                incomingHeaders.get('x-opencode-session')
              const requestModel = parseRequestModel(init?.body)
              // Match sticky routing's original requested-model affinity, not
              // the effective model chosen by recovery or a subagent's model.
              const recoveryModelChanged = Boolean(
                sessionId &&
                  requestModel &&
                  !isSubagentRequest(incomingHeaders) &&
                  fableFallbackManager.resetForModelChange(
                    sessionId,
                    requestModel,
                  ),
              )
              if (recoveryModelChanged && sessionId) {
                for (const key of pendingRecoveryDesktopNotices.keys()) {
                  if (key.startsWith(`${sessionId}\0`))
                    pendingRecoveryDesktopNotices.delete(key)
                }
                pendingDesktopNotices.delete(sessionId)
                // A new selected model cannot reuse the previous model's
                // kept source prefix.
                dropSessionSourceWarms(sessionId)
              }
              const fablePlan = fableFallbackManager.plan(sessionId, init?.body)
              const serverFallbackModel =
                fallbackMode === 'server' &&
                isRecoverableRefusalModel(
                  fablePlan?.effectiveModel ?? requestModel,
                )
                  ? (fablePlan?.effectiveModel ?? requestModel)
                  : undefined
              const fableRequest: FableRequestContext | undefined = fablePlan
                ? { plan: fablePlan }
                : undefined
              if (fablePlan?.downgraded) {
                init = { ...init, body: fablePlan.bodyText }
              }

              const initialBody = init?.body
              const trace = createPerfTrace({
                bodyBytes:
                  typeof initialBody === 'string'
                    ? initialBody.length
                    : undefined,
              })
              const wrapResponse = (response: Response) => {
                const diagnosticsContext =
                  cacheDiagnosticsResponses.get(response)
                return createStrippedStream(response, {
                  toolNameMap: diagnosticsContext?.toolNameMap,
                  perf: (stage, data) => trace.mark(stage, data),
                  laneStart: laneStartRequest,
                  laneStartOAuthServed:
                    responseRouteKinds.get(response) !== 'api',
                  ...(diagnosticsContext
                    ? diagnosticsContext.streaming
                      ? {
                          onMessageStart: (message) =>
                            observeCacheDiagnosticsResponse(
                              response,
                              message,
                              false,
                            ),
                          onMessageDelta: (delta) =>
                            observeCacheDiagnosticsDelta(response, delta),
                          onStreamEnd: () => diagnosticsContext.dumpWrite,
                        }
                      : {
                          onMessageResponse: (message) =>
                            observeCacheDiagnosticsResponse(response, message),
                          onStreamEnd: () => diagnosticsContext.dumpWrite,
                          responseMode: 'json' as const,
                        }
                    : {}),
                  contentFilterModel: fablePlan?.requestedModel,
                  ...(!fablePlan?.downgraded && fablePlan
                    ? {
                        onContentFilter: (context) => {
                          if (!fableRequest?.oauthAccountId) {
                            logger.debug(
                              'fable-fallback',
                              'content filter recovery unavailable for non-OAuth route',
                              { session: fablePlan.sessionId },
                            )
                            return false
                          }
                          // Keep the source prefix from CacheKeep's live
                          // target for the session: the exact signed bytes
                          // just sent (normally the refused request itself),
                          // never rebuilt from a 4.8 request. The live target
                          // is required to be this round's source-model send
                          // for this session and account; anything else (a
                          // 4.8 request, another round's probe) cannot become
                          // a warm. Without a live target (CacheKeep off or
                          // not hybrid) there is nothing to warm.
                          const pending = pendingSourceMeta.get(
                            fablePlan.recoveryKey,
                          )
                          pendingSourceMeta.delete(fablePlan.recoveryKey)
                          const live = cacheKeepManager.trackedRequest(
                            fablePlan.sessionId,
                          )
                          let liveModel: string | undefined
                          if (live) {
                            try {
                              const parsed = JSON.parse(live.bodyText) as {
                                model?: unknown
                              }
                              if (typeof parsed.model === 'string')
                                liveModel = parsed.model
                            } catch {}
                          }
                          const liveFamily = liveModel
                            ? recoverableRefusalFamily(liveModel)
                            : null
                          const requestedFamily = recoverableRefusalFamily(
                            fablePlan.requestedModel,
                          )
                          const liveAccountId = live?.oauthAccountId
                          const keep =
                            pending &&
                            live &&
                            liveAccountId !== undefined &&
                            liveFamily !== null &&
                            liveFamily === requestedFamily &&
                            liveAccountId === fableRequest.oauthAccountId
                              ? {
                                  bodyText: live.bodyText,
                                  oauthAccountId: liveAccountId,
                                  ...(pending.accountIdentity !== undefined && {
                                    accountIdentity: pending.accountIdentity,
                                  }),
                                  sentAt: pending.sentAt,
                                  model: fablePlan.requestedModel,
                                  firstAnchorFingerprint:
                                    hybridUserMessageCacheAnchorFingerprints(
                                      live.bodyText,
                                    )[0],
                                  url: live.url,
                                  headers: live.headers,
                                  ...(fableRequest.subagent && {
                                    subagent: true,
                                  }),
                                }
                              : undefined
                          const remaining = fableFallbackManager.activate(
                            fablePlan,
                            fableRequest.oauthAccountId,
                            keep,
                          )
                          void syncSourceWarmTarget(fablePlan).catch(() => {
                            logger.warn(
                              'fable-fallback',
                              'source warm sync failed',
                              {
                                session: fablePlan.sessionId,
                              },
                            )
                          })
                          pendingRecoveryDesktopNotices.delete(
                            fablePlan.recoveryKey,
                          )
                          pendingRecoveryDesktopNotices.set(
                            fablePlan.recoveryKey,
                            buildSwitchedToOpusNotice(
                              fablePlan.requestedModel,
                              remaining,
                            ),
                          )
                          while (pendingRecoveryDesktopNotices.size > 128) {
                            const oldest = pendingRecoveryDesktopNotices
                              .keys()
                              .next().value
                            if (oldest)
                              pendingRecoveryDesktopNotices.delete(oldest)
                            else break
                          }
                          serverFallbackTargets.delete(fablePlan.recoveryKey)
                          logger.info(
                            'fable-fallback',
                            'content filter detected; switching session to Opus 4.8',
                            {
                              session: fablePlan.sessionId,
                              requestedModel: fablePlan.requestedModel,
                              completedToolUse:
                                context?.completedToolUse === true,
                              remaining,
                            },
                          )
                          publishFableRecoveryNotice(
                            {
                              sessionId: fablePlan.sessionId,
                              mode: 'opus',
                              remaining,
                              requestedModelId: fablePlan.requestedModel,
                            },
                            storage,
                            auth,
                          )
                        },
                      }
                    : {}),
                  ...(fablePlan && fableRequest
                    ? {
                        onComplete: (finishReason: string) => {
                          if (!fablePlan.downgraded) {
                            const ended = fableFallbackManager.completeSource(
                              fablePlan,
                              !fableRequest.serverFallback,
                            )
                            if (ended) {
                              // The source serves again: the round (and its
                              // warm) is over.
                              const family = recoverableRefusalFamily(
                                fablePlan.requestedModel,
                              )
                              if (family)
                                cacheKeepManager.untrack(
                                  sourceWarmTargetId(
                                    fablePlan.sessionId,
                                    family,
                                  ),
                                )
                            }
                            return
                          }
                          const completed = fableFallbackManager.complete(
                            fablePlan,
                            fableRequest.opusCacheAnchor,
                          )
                          if (!completed.counted) return
                          const recoveryDesktopText =
                            pendingRecoveryDesktopNotices.get(
                              fablePlan.recoveryKey,
                            )
                          if (recoveryDesktopText) {
                            pendingRecoveryDesktopNotices.delete(
                              fablePlan.recoveryKey,
                            )
                            // Ignore any transient idle event emitted between the
                            // refused source response and OpenCode's Opus retry.
                            // Queue only after that retry has completed successfully.
                            desktopNoticeSafeSessions.delete(
                              fablePlan.sessionId,
                            )
                            queueDesktopNotice(
                              fablePlan.sessionId,
                              recoveryDesktopText,
                            )
                          }
                          logger.info(
                            'fable-fallback',
                            'Opus 4.8 turn completed',
                            {
                              session: fablePlan.sessionId,
                              requestedModel: fablePlan.requestedModel,
                              finishReason,
                              remaining: completed.remaining,
                            },
                          )
                          publishFableRecoveryNotice(
                            {
                              sessionId: fablePlan.sessionId,
                              mode: 'opus',
                              remaining: completed.remaining,
                              requestedModelId: fablePlan.requestedModel,
                            },
                            storage,
                            auth,
                          )
                          if (completed.remaining === 0) {
                            publishFableRecoveryNotice(
                              {
                                sessionId: fablePlan.sessionId,
                                mode: 'fable',
                                remaining: 0,
                                requestedModelId: fablePlan.requestedModel,
                              },
                              storage,
                              auth,
                              buildRestoredNotice(fablePlan.requestedModel),
                            )
                          }
                        },
                      }
                    : {}),
                  ...(serverFallbackModel
                    ? {
                        serverSideFallbackModel: serverFallbackModel,
                        ...(fablePlan
                          ? {
                              onServerSideFallbackOutcome: (
                                outcome: ServerSideFallbackOutcome,
                              ) => {
                                if (fableRequest)
                                  fableRequest.serverFallback = outcome.fallback
                                observeServerFallbackOutcome(
                                  fablePlan,
                                  outcome,
                                  storage,
                                  auth,
                                )
                              },
                            }
                          : {}),
                      }
                    : {}),
                })
              }
              const authStart = nowMs()
              const credentialModelId =
                fablePlan?.effectiveModel ??
                parseRequestModel(await fetchBody(input, init))
              const auth = await getAuth(
                credentialModelId,
                init?.signal ?? undefined,
                true,
              )
              trace.mark('get_auth', {
                ms: roundMs(nowMs() - authStart),
                authType: auth.type,
                hasAccess: Boolean(auth.access),
              })
              if (auth.type !== 'oauth') {
                const rewritten = rewriteUrl(input)
                const passthroughHeaders = mergeHeaders(input, init)
                applyCustomHeaders(passthroughHeaders)
                let passthroughBody = await fetchBody(input, init)
                if (typeof passthroughBody === 'string') {
                  try {
                    const parsed = JSON.parse(passthroughBody)
                    if (remapRequestBodyModel(parsed)) {
                      passthroughBody = JSON.stringify(parsed)
                    }
                  } catch {}
                }
                init?.signal?.throwIfAborted()
                const response = await fetch(rewritten.input, {
                  ...init,
                  body: passthroughBody,
                  headers: passthroughHeaders,
                })
                trace.done('non_oauth_passthrough', { status: response.status })
                return response
              }
              const storage = await loadAccounts()
              const requestMainProviderUuid: ProviderAccountUuid | undefined =
                asProviderAccountUuid(auth.nativeAccountIdentity)
              const requestMainScopedAttempt = auth.nativeScopedAttempt
              let requestMainQuotaIdentity:
                | MainQuotaIdentityResolution
                | undefined
              if (auth.access) {
                const resolution = await resolveMainQuotaAccountIdentity(
                  auth.access,
                  parseRequestModel(init?.body),
                  requestMainProviderUuid,
                  requestMainScopedAttempt?.recordVersion,
                )
                if (resolution.stale) {
                  throw new Error(
                    'Main OAuth identity changed while resolving request credentials',
                  )
                }
                requestMainQuotaIdentity = {
                  ...resolution,
                  routingLineage: auth.nativeRoutingLineage,
                }
                if (requestMainProviderUuid) {
                  mainServedAccessToken = auth.access
                  mainProviderAccountUuid = resolution.providerAccountUuid
                }
              } else if (
                (auth.modelDenied ||
                  auth.credentialUnavailable ||
                  auth.deferred) &&
                requestMainProviderUuid
              ) {
                // A known account keeps its quota in the routing inventory
                // even when model policy or credential backoff blocks serving.
                // This metadata does not authorize a model request.
                // An API fallback still requires its separate primary-account
                // credential check and fresh account-wide exhaustion proof.
                await reconcileMainQuotaAccountIdentity(
                  '',
                  requestMainProviderUuid,
                  requestMainProviderUuid,
                )
                requestMainQuotaIdentity = {
                  quotaKey: requestMainProviderUuid,
                  providerAccountUuid: requestMainProviderUuid,
                  generation: quotaManager.getMainQuotaIdentityGeneration(),
                  routingLineage: auth.nativeRoutingLineage,
                  stale: false,
                  state: isScopedCustodyActive(storage) ? 'on-cold' : 'na',
                }
              }

              const loadStart = nowMs()
              trace.mark('load_storage', { ms: roundMs(nowMs() - loadStart) })
              quotaManager.updateStorage(storage)
              quotaManager.seedMainFromStorage(storage, mainQuotaAccountId)
              quotaManager.seedFallbacksFromAccounts(
                (storage?.accounts ?? []).filter(isOAuthAccount),
              )
              const visibleRecovery = sessionId
                ? fableRecoveryNotices.get(sessionId)
                : undefined
              if (
                recoveryModelChanged ||
                !fablePlan ||
                (fallbackMode === 'server' &&
                  visibleRecovery?.requestedModelId &&
                  recoverableRefusalFamily(visibleRecovery.requestedModelId) !==
                    recoverableRefusalFamily(fablePlan.requestedModel))
              ) {
                clearFableRecoveryNotice(sessionId, storage, auth)
              }
              const replayableRequest = isReplayableRequest(input, init?.body)
              const requestModelId =
                parseRequestModel(init?.body) ?? credentialModelId
              const mainRoutingEntry = routingMainQuotaEntry(
                requestMainQuotaIdentity,
                storage,
              )
              const currentMainObservation = currentHeaderRoutingObservation(
                'main',
                requestMainQuotaIdentity?.routingLineage,
                requestMainProviderUuid,
                storage,
              )
              const providerRestriction = auth.deferred
                ? mainProviderQuotaRestriction(
                    mainRoutingEntry && storage
                      ? {
                          ...storage,
                          accounts: storage?.accounts ?? [],
                          quota: {
                            ...storage?.quota,
                            mainQuota: mainRoutingEntry.quota,
                          },
                        }
                      : storage,
                    requestMainProviderUuid,
                    currentMainObservation?.lineage ===
                      requestMainQuotaIdentity?.routingLineage &&
                      currentMainObservation?.generalExhausted === true,
                  )
                : undefined
              if (providerRestriction) {
                // A provider-issued wait applies before primary token acquisition.
                // Available fallbacks may serve; a blocked primary must not refresh
                // or obtain a bearer merely to discover the same restriction again.
                const fallbackAccounts = replayableRequest
                  ? await getRoutableFallbackAccounts(storage, {
                      includeApiRoutes: mainQuotaEntryIsFreshExhausted(
                        undefined,
                        requestMainQuotaIdentity,
                      ),
                      modelId: requestModelId,
                    })
                  : []
                const response = await tryUsableFallbackAccounts(
                  input,
                  init,
                  fallbackAccounts,
                  storage,
                  undefined,
                  trace,
                  {
                    onSuccess: (account) =>
                      writeCurrentSidebarState(account.id, 'fallback'),
                    mainQuotaIdentity: requestMainQuotaIdentity,
                    fableRequest,
                    laneStartRequest,
                  },
                )
                if (response) return wrapResponse(response)
                return new Response(
                  JSON.stringify({
                    type: 'error',
                    error: {
                      type: 'rate_limit_error',
                      message: providerRestriction.message,
                    },
                  }),
                  {
                    status: 429,
                    headers: {
                      'content-type': 'application/json',
                      'retry-after': String(providerRestriction.retryAfter),
                    },
                  },
                )
              }
              const modelDeniedResponse = async () => {
                if (isScopedCustodyActive(storage))
                  return createNativeVaultNoRouteResponse({
                    snapshot: await nativeAccounts.read(),
                    modelId: credentialModelId,
                    sticky: getRoutingMode(storage) === 'sticky-balanced',
                  })
                const retryAfter = killswitchRetryAfterSeconds(
                  quotaManager.getMain(requestMainQuotaIdentity?.quotaKey)
                    ?.quota,
                  (storage?.accounts ?? []).filter(isOAuthAccount),
                  Date.now(),
                  credentialModelId,
                )
                return new Response(
                  JSON.stringify({
                    type: 'error',
                    error: {
                      type: 'rate_limit_error',
                      message:
                        'No enabled OAuth route can serve the requested model under current quota policy.',
                    },
                  }),
                  {
                    status: 429,
                    headers: {
                      'content-type': 'application/json',
                      'retry-after': String(retryAfter),
                    },
                  },
                )
              }
              // Count every replayable request up front — before the
              // fallback-first early return — so the every-N refresh cadence
              // (quota.refreshEveryNRequests) advances for main and the active
              // fallback route on all paths, including successful fallback-first.
              if (replayableRequest) sessionRequestCount++
              if (
                replayableRequest &&
                auth.access &&
                (!auth.expires || auth.expires > Date.now())
              ) {
                scheduleSidebarMainQuotaRefresh(
                  storage,
                  auth.access,
                  requestMainQuotaIdentity,
                )
              }
              async function writeCurrentSidebarState(
                activeId: string | undefined,
                route: string,
              ) {
                let sidebarStorage = storage
                let skipFallbackQuotaSeed = false
                if (
                  (storage?.accounts ?? []).some(
                    (account) => isOAuthAccount(account) && account.quota,
                  )
                ) {
                  try {
                    const currentStorage =
                      await loadAccounts(accountStoragePath)
                    if (currentStorage) sidebarStorage = currentStorage
                    else skipFallbackQuotaSeed = true
                  } catch {
                    // An unverifiable snapshot must not seed spend-affecting state.
                    skipFallbackQuotaSeed = true
                  }
                }
                // State construction reconciles quota caches synchronously; only
                // the display-only file write is detached from the response path.
                void writeSidebarState(sidebarStorage, {
                  activeId,
                  route,
                  mainAccessToken: auth.access,
                  skipFallbackQuotaSeed,
                })
              }
              let preselectedFallbackAccounts:
                | Array<OAuthAccount | ApiKeyAccount>
                | undefined

              if (
                replayableRequest &&
                sessionId &&
                getRoutingMode(storage) === 'sticky-balanced'
              ) {
                const routingModelId =
                  fablePlan?.effectiveModel ?? requestModelId
                const family = stickyRouteFamilyForModel(routingModelId)
                const trackedRoute =
                  cacheKeepManager.trackedOAuthRoute(sessionId)
                const preferredAccountId =
                  fablePlan?.cacheAccountId ??
                  (trackedRoute
                    ? (trackedRoute.oauthAccountId ??
                      STICKY_ROUTING_MAIN_ACCOUNT_ID)
                    : undefined)
                let stickyRouteSelected = false
                try {
                  let stickyRoutes = await buildStickyOAuthRoutes({
                    storage,
                    mainAccessToken: auth.access,
                    mainRefreshToken: auth.refresh,
                    mainPolicyDenied:
                      auth.modelDenied || auth.credentialUnavailable,
                    requestedModelId: routingModelId,
                    mainQuotaIdentity: requestMainQuotaIdentity,
                  })
                  const snapshot = await nativeAccounts.read()
                  const advice = await routingRelay.accountFor(
                    sessionId,
                    routingModelId ?? '',
                    snapshot.accounts.filter(
                      (row) =>
                        nativeAccountCanServe(row) &&
                        nativeAccountPolicy(row, snapshot, routingModelId)
                          .status === 'allowed' &&
                        stickyRoutes.candidates.some(
                          (candidate) => candidate.accountId === row.id,
                        ),
                    ),
                  )
                  let advisedAccountId: string | undefined
                  if (advice) {
                    const snapshot = await nativeAccounts.read()
                    const account = snapshot.accounts.find((row) =>
                      routingChoiceMatches(advice, row),
                    )
                    if (
                      account &&
                      nativeAccountCanServe(account) &&
                      nativeAccountPolicy(account, snapshot, routingModelId)
                        .status === 'allowed' &&
                      stickyRoutes.candidates.some(
                        (row) => row.accountId === account.id,
                      ) &&
                      routingReserveAllows(
                        account.id,
                        stickyRoutes.candidates,
                        stickyRoutes.storage,
                        routingModelId ?? '',
                      )
                    ) {
                      advisedAccountId = account.id
                    } else {
                      routingRelay.override(
                        sessionId,
                        'unknown account, credential, account policy or Fable reserve',
                      )
                    }
                  }
                  const resolveRoute = async (
                    excludeAccountIds?: Set<string>,
                  ) => {
                    const routing = await currentStickyRouting()
                    // Use shared routing advice only for the first choice;
                    // retries after quota exhaustion make their own account choice.
                    const advised = !excludeAccountIds && advisedAccountId
                    return routing.router.resolve({
                      sessionId,
                      family,
                      modelId: routingModelId,
                      affinityModelId: requestModel,
                      candidates: advised
                        ? stickyRoutes.candidates.filter(
                            (row) => row.accountId === advised,
                          )
                        : stickyRoutes.candidates,
                      retainAccountIds: advised
                        ? new Set([advised])
                        : stickyRoutes.retainAccountIds,
                      storage: stickyRoutes.storage,
                      inputBytes:
                        typeof init?.body === 'string'
                          ? Buffer.byteLength(init.body)
                          : 1,
                      preferredAccountId,
                      excludeAccountIds,
                      ...(advised && { preserveOnNoCandidate: true }),
                      ...(routing.accountIdentities && {
                        accountIdentities: routing.accountIdentities,
                      }),
                    })
                  }
                  const mainPermanentlyUnavailable = isPermanentRefreshError(
                    stickyRoutes.storage?.refresh?.mainLastRefreshError,
                  )
                  const incompleteQuotaPool =
                    (stickyRoutes.allRoutes.length === 0 &&
                      !mainPermanentlyUnavailable) ||
                    stickyRoutes.allRoutes.some(
                      (candidate) =>
                        !candidate.quota ||
                        !stickyQuotaSnapshotIsFresh(
                          candidate.quota,
                          stickyRoutes.storage,
                          Date.now(),
                          routingModelId,
                        ),
                    )
                  let resolution = await resolveRoute()
                  if (advisedAccountId && !resolution) {
                    routingRelay.override(
                      sessionId,
                      'advised account is not selectable',
                    )
                    advisedAccountId = undefined
                    resolution = await resolveRoute()
                  }
                  if (
                    advisedAccountId &&
                    resolution?.accountId === advisedAccountId &&
                    advice?.hold
                  ) {
                    return new Response(
                      JSON.stringify({
                        type: 'error',
                        error: {
                          type: 'rate_limit_error',
                          message:
                            'Shared routing requested a wait; retaining session affinity.',
                        },
                      }),
                      {
                        status: 429,
                        headers: {
                          'content-type': 'application/json',
                          'retry-after': String(
                            Math.ceil(advice.hold.retry_after_ms / 1000),
                          ),
                        },
                      },
                    )
                  }
                  if (!resolution && incompleteQuotaPool) {
                    if (auth.modelDenied) return modelDeniedResponse()
                    throw new Error(
                      'Sticky-balanced routing is waiting for current OAuth quota snapshots',
                    )
                  }
                  if (!resolution) {
                    if (auth.modelDenied) return modelDeniedResponse()
                    if (isScopedCustodyActive(storage))
                      return createNativeVaultNoRouteResponse({
                        snapshot: await nativeAccounts.read(),
                        modelId: routingModelId,
                        sticky: true,
                      })
                    const response = createStickyNoRouteResponse({
                      mainRefreshError:
                        stickyRoutes.storage?.refresh?.mainLastRefreshError,
                      fallbackReauthLabels: getFallbackReauthLabels(
                        stickyRoutes.storage,
                      ),
                      routeQuotas: stickyRoutes.allRoutes.flatMap((route) =>
                        route.quota ? [route.quota] : [],
                      ),
                      modelId: routingModelId,
                    })
                    trace.done('return_sticky_no_route', {
                      status: response.status,
                    })
                    return response
                  }
                  let route = stickyRoutes.allRoutes.find(
                    (candidate) => candidate.id === resolution?.accountId,
                  )
                  if (resolution && route) {
                    stickyRouteSelected = true
                    if (
                      fablePlan?.downgraded &&
                      fableFallbackManager.bindRecoveryAccount(
                        fablePlan,
                        route.id,
                      )
                    ) {
                      // The kept source body was bound to the previous
                      // account; the round re-keeps it on its next refusal.
                      const family = recoverableRefusalFamily(
                        fablePlan.requestedModel,
                      )
                      if (family)
                        cacheKeepManager.untrack(
                          sourceWarmTargetId(fablePlan.sessionId, family),
                        )
                      logger.info(
                        'fable-fallback',
                        'rebound recovery to migrated sticky account',
                        { accountId: route.id },
                      )
                    }
                    const sendRoute = async (selected: StickyOAuthRoute) => {
                      if (selected.scoped) {
                        const credential = await authorizeOAuth(
                          selected.id,
                          init?.signal ?? undefined,
                          undefined,
                          routingModelId,
                        )
                        const scopedAttempt = credential.scopedAttempt
                        if (!scopedAttempt)
                          throw new Error(
                            'Native vault sticky credential is unavailable',
                          )
                        return sendWithAccessToken(
                          input,
                          init,
                          scopedAttempt.accessToken,
                          trace,
                          `sticky:${selected.id}`,
                          stickyRoutes.storage,
                          selected.id,
                          selected.account?.authLineageId,
                          fableRequest,
                          laneStartRequest,
                          selected.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                            ? requestMainQuotaIdentity
                            : undefined,
                          scopedAttempt,
                        )
                      }
                      return sendWithAccessToken(
                        input,
                        init,
                        selected.access ?? '',
                        trace,
                        `sticky:${selected.id}`,
                        stickyRoutes.storage,
                        selected.id,
                        selected.account?.authLineageId,
                        fableRequest,
                        laneStartRequest,
                        selected.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                          ? requestMainQuotaIdentity
                          : undefined,
                      )
                    }
                    const completeRoute = async (
                      selected: StickyOAuthRoute,
                      response: Response,
                      _markUsed = true,
                    ) => {
                      await writeCurrentSidebarState(
                        selected.id,
                        'sticky-balanced',
                      )
                      trace.done('return_sticky_balanced', {
                        status: response.status,
                        accountId: selected.id,
                        created: resolution?.created,
                        migrated: resolution?.migrated,
                      })
                      return wrapResponse(response)
                    }
                    const inspectResponse = async (response: Response) => {
                      let inspectedResponse = response
                      let routeFailure = shouldFallbackResponse(
                        response,
                        stickyRoutes.storage,
                      )
                      let streamingRateLimit = false
                      if (!routeFailure) {
                        const inspected = await inspectStreamingRateLimit(
                          response,
                          trace,
                        )
                        inspectedResponse = inspected.response
                        streamingRateLimit = inspected.rateLimited
                        routeFailure = inspected.rateLimited
                      }
                      return {
                        response: inspectedResponse,
                        routeFailure,
                        streamingRateLimit,
                      }
                    }

                    const proactiveQuotaDecision = stickyQuotaSnapshotIsFresh(
                      route.quota,
                      stickyRoutes.storage,
                      Date.now(),
                      routingModelId,
                    )
                      ? decideStickyQuotaFailure({
                          quota: route.quota,
                          modelId: routingModelId,
                        })
                      : undefined
                    if (proactiveQuotaDecision?.action === 'hold') {
                      return completeRoute(
                        route,
                        await withStickyRetryAfter(
                          new Response(
                            JSON.stringify({
                              type: 'error',
                              error: {
                                type: 'rate_limit_error',
                                message:
                                  'Sticky OAuth account quota resets shortly; retaining session affinity.',
                              },
                            }),
                            {
                              status: 429,
                              headers: { 'content-type': 'application/json' },
                            },
                          ),
                          sessionId,
                          proactiveQuotaDecision.retryAfterSeconds,
                          false,
                          cacheDiagnosticsResponses,
                        ),
                        false,
                      )
                    }

                    const inspected = await inspectResponse(
                      await sendRoute(route),
                    )
                    let permanentAuthFailure = false
                    if (!inspected.routeFailure) {
                      return completeRoute(route, inspected.response)
                    }

                    if (inspected.response.status === 401) {
                      const failure = nativeLocalRefreshFailures.get(
                        inspected.response,
                      )
                      if (failure) {
                        const latest = await loadAccounts(accountStoragePath)
                        const failedRouteId = route.id
                        const refreshError =
                          route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                            ? latest?.refresh?.mainLastRefreshError
                            : latest?.accounts.find(
                                (account): account is OAuthAccount =>
                                  account.id === failedRouteId &&
                                  isOAuthAccount(account),
                              )?.lastRefreshError
                        // This request already retried after token rejection;
                        // do not rotate again. Temporary refresh or network
                        // failure keeps the current account. Switch only after
                        // the runtime confirms its credentials are permanently invalid.
                        if (!isPermanentRefreshError(refreshError))
                          throw failure
                      }
                      permanentAuthFailure = true
                    }

                    let migrate =
                      inspected.response.status === 403 || permanentAuthFailure
                    if (
                      inspected.response.status === 429 ||
                      inspected.streamingRateLimit
                    ) {
                      let quota: OAuthQuotaSnapshot | undefined =
                        quotaExhaustionFromHeaders(
                          inspected.response.headers,
                          routingModelId,
                        )
                      // Do not extend the usage endpoint's own rate limit when
                      // the refusal already confirms exhaustion.
                      if (Object.keys(quota).length === 0) {
                        try {
                          quota =
                            route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                              ? await quotaManager.refreshMain(
                                  requestMainQuotaIdentity?.quotaKey,
                                  route.access ?? '',
                                  requestMainQuotaIdentity?.generation,
                                )
                              : await quotaManager.refreshFallback(
                                  route.id,
                                  route.access ?? '',
                                  route.account,
                                )
                        } catch {
                          // An unavailable probe leaves exhaustion unconfirmed.
                          quota = undefined
                        }
                      }
                      const decision = decideStickyQuotaFailure({
                        quota,
                        modelId: routingModelId,
                        responseHeaders: inspected.response.headers,
                      })
                      trace.mark('sticky_quota_failure', {
                        accountId: route.id,
                        action: decision.action,
                        reason: decision.reason,
                      })
                      if (decision.action === 'hold') {
                        return completeRoute(
                          route,
                          await withStickyRetryAfter(
                            inspected.response,
                            sessionId,
                            decision.retryAfterSeconds,
                            inspected.streamingRateLimit,
                            cacheDiagnosticsResponses,
                          ),
                        )
                      }
                      if (decision.action === 'retain') {
                        return completeRoute(
                          route,
                          await withStickyRetryAfter(
                            inspected.response,
                            sessionId,
                            60,
                            inspected.streamingRateLimit,
                            cacheDiagnosticsResponses,
                            true,
                          ),
                        )
                      }
                      migrate = decision.action === 'migrate'
                    }

                    if (migrate) {
                      // A cancelled request must not move the session's account.
                      await endIfCancelled(inspected.response, init?.signal)
                      const failedRouteId = route.id
                      stickyRoutes = await buildStickyOAuthRoutes({
                        storage: stickyRoutes.storage,
                        mainAccessToken: auth.access,
                        mainRefreshToken: auth.refresh,
                        mainPolicyDenied:
                          auth.modelDenied || auth.credentialUnavailable,
                        requestedModelId: routingModelId,
                        mainQuotaIdentity: requestMainQuotaIdentity,
                      })
                      const alternatives = stickyRoutes.candidates.filter(
                        (candidate) => candidate.accountId !== failedRouteId,
                      )
                      if (alternatives.length > 0) {
                        await inspected.response.body?.cancel().catch(() => {})
                        resolution = await resolveRoute(
                          new Set([failedRouteId]),
                        )
                        const migratedRoute = stickyRoutes.allRoutes.find(
                          (candidate) => candidate.id === resolution?.accountId,
                        )
                        if (resolution && migratedRoute) {
                          route = migratedRoute
                          if (
                            fablePlan?.downgraded &&
                            fableFallbackManager.bindRecoveryAccount(
                              fablePlan,
                              route.id,
                            )
                          ) {
                            const family = recoverableRefusalFamily(
                              fablePlan.requestedModel,
                            )
                            if (family)
                              cacheKeepManager.untrack(
                                sourceWarmTargetId(fablePlan.sessionId, family),
                              )
                          }
                          return completeRoute(route, await sendRoute(route))
                        }
                      } else if (
                        (inspected.response.status === 429 ||
                          inspected.streamingRateLimit) &&
                        mainQuotaEntryIsFreshExhausted(
                          auth.access,
                          requestMainQuotaIdentity,
                        )
                      ) {
                        const apiAccounts = (
                          await getRoutableFallbackAccounts(
                            stickyRoutes.storage,
                            {
                              includeApiRoutes: true,
                              modelId: routingModelId,
                            },
                          )
                        ).filter(isApiKeyAccount)
                        if (apiAccounts.length > 0) {
                          const apiResponse = await tryUsableFallbackAccounts(
                            input,
                            init,
                            apiAccounts,
                            stickyRoutes.storage,
                            inspected.response,
                            trace,
                            {
                              onSuccess: (account) =>
                                writeCurrentSidebarState(
                                  account.id,
                                  'sticky-balanced',
                                ),
                              mainAccessToken: auth.access,
                              mainQuotaIdentity: requestMainQuotaIdentity,
                              fableRequest,
                              laneStartRequest,
                            },
                          )
                          if (apiResponse) {
                            trace.done('return_sticky_api_fallback', {
                              status: apiResponse.status,
                            })
                            return wrapResponse(apiResponse)
                          }
                        }
                      }
                    }
                    return completeRoute(route, inspected.response)
                  }
                } catch (error) {
                  trace.mark('sticky_balanced_error', {
                    error:
                      error instanceof Error ? error.message : String(error),
                  })
                  if (
                    stickyRouteSelected ||
                    isNativeTransientAccountError(error)
                  )
                    throw error
                  const retryable =
                    error instanceof Error ? error : new Error(String(error))
                  Object.assign(retryable, {
                    code: 'ECONNRESET',
                    syscall: 'sticky-routing',
                  })
                  throw retryable
                }
              }

              if (
                replayableRequest &&
                getRoutingMode(storage) === 'fallback-first'
              ) {
                try {
                  const fallbackStart = nowMs()
                  preselectedFallbackAccounts =
                    await getRoutableFallbackAccounts(storage, {
                      includeApiRoutes: mainQuotaEntryIsFreshExhausted(
                        auth.access,
                        requestMainQuotaIdentity,
                      ),
                      modelId: requestModelId,
                    })
                  trace.mark('fallback_first_get_accounts', {
                    ms: roundMs(nowMs() - fallbackStart),
                    accounts: preselectedFallbackAccounts.length,
                  })
                  const fallbackResponse = await tryUsableFallbackAccounts(
                    input,
                    init,
                    preselectedFallbackAccounts,
                    storage,
                    undefined,
                    trace,
                    {
                      returnLastOnExhausted: false,
                      mainAccessToken: auth.access,
                      mainQuotaIdentity: requestMainQuotaIdentity,
                      onSuccess: (account) =>
                        writeCurrentSidebarState(account.id, 'fallback-first'),
                      fableRequest,
                      laneStartRequest,
                    },
                  )
                  if (fallbackResponse) {
                    trace.done('return_fallback_first', {
                      status: fallbackResponse.status,
                    })
                    return wrapResponse(fallbackResponse)
                  }
                  preselectedFallbackAccounts = undefined
                } catch (error) {
                  trace.mark('fallback_first_error', {
                    error:
                      error instanceof Error ? error.message : String(error),
                  })
                  // A fallback still being saved by another writer must not
                  // be replaced by main for this request.
                  if (isNativeTransientAccountError(error)) throw error
                }
              }

              // Fallback-first reached main only after its fallback attempts.
              // Resolve current access now; absence from the earlier metadata
              // view is not evidence that the stored token needs refreshing.
              if (auth.deferred) {
                Object.assign(
                  auth,
                  await getAuth(credentialModelId, init?.signal ?? undefined),
                )
                if (auth.access) {
                  const resolution = await resolveMainQuotaAccountIdentity(
                    auth.access,
                    credentialModelId,
                    auth.nativeAccountIdentity,
                    auth.nativeScopedAttempt?.recordVersion,
                  )
                  if (resolution.stale)
                    throw new Error(
                      'Main OAuth identity changed while resolving request credentials',
                    )
                  requestMainQuotaIdentity = {
                    ...resolution,
                    routingLineage: auth.nativeRoutingLineage,
                  }
                  mainServedAccessToken = auth.access
                  mainProviderAccountUuid = resolution.providerAccountUuid
                }
              }
              if (
                !auth.modelDenied &&
                (!auth.access || !auth.expires || auth.expires < Date.now())
              ) {
                if (isScopedCustodyActive(storage)) {
                  try {
                    const credential = await authorizeOAuth(
                      'main',
                      init?.signal ?? undefined,
                      undefined,
                      credentialModelId,
                    )
                    const scopedAttempt = credential.scopedAttempt
                    if (!scopedAttempt)
                      throw new Error(
                        'Native vault main credential is unavailable',
                      )
                    mainServedAccessToken = scopedAttempt.accessToken
                    const response = await sendWithAccessToken(
                      input,
                      init,
                      scopedAttempt.accessToken,
                      trace,
                      'main',
                      storage,
                      'main',
                      undefined,
                      fableRequest,
                      laneStartRequest,
                      requestMainQuotaIdentity,
                      scopedAttempt,
                    )
                    return wrapResponse(response)
                  } catch (error) {
                    const fallbackAccounts = replayableRequest
                      ? await getRoutableFallbackAccounts(storage, {
                          modelId: requestModelId,
                        })
                      : []
                    const fallbackResponse = await tryUsableFallbackAccounts(
                      input,
                      init,
                      fallbackAccounts,
                      storage,
                      undefined,
                      trace,
                      {
                        onSuccess: (account) =>
                          writeCurrentSidebarState(account.id, 'fallback'),
                        mainAccessToken: auth.access,
                        mainQuotaIdentity: requestMainQuotaIdentity,
                        fableRequest,
                        laneStartRequest,
                      },
                    )
                    if (fallbackResponse) return wrapResponse(fallbackResponse)
                    if (error instanceof NativeCredentialUnavailableError)
                      throw new NativeVaultNoAccountError()
                    throw error
                  }
                }
                // Report the refresh failure that happened in this request,
                // rather than replacing it with its newly recorded backoff.
                // Later requests still check the persisted retry deadline.
                if (auth.credentialFailure?.tokenRefreshFailed)
                  throw auth.credentialFailure
                // Check backoff before attempting refresh — avoids noisy
                // per-request retries during prolonged rate limits
                const refreshStorage = await loadAccounts()
                const mainRefreshError =
                  refreshStorage?.refresh?.mainLastRefreshError
                if (
                  mainRefreshError &&
                  refreshBackoffActive(
                    mainRefreshError,
                    auth.nativeAccountIdentity ??
                      mainAccountId ??
                      refreshStorage?.mainAccountId,
                    Date.now(),
                    auth.refresh ? tokenFingerprint(auth.refresh) : undefined,
                  )
                ) {
                  log('[refresh] opencode main oauth request skipped backoff', {
                    nextRetryAt: mainRefreshError.nextRetryAt,
                    retryCount: mainRefreshError.retryCount,
                    expiresInMs: auth.expires
                      ? auth.expires - Date.now()
                      : undefined,
                  })
                  throw new Error(
                    formatRefreshBackoffMessage(mainRefreshError, Date.now()),
                  )
                }
                log(
                  '[refresh] opencode main oauth refresh required for request',
                  {
                    hasAccess: Boolean(auth.access),
                    expiresInMs: auth.expires
                      ? auth.expires - Date.now()
                      : undefined,
                    expiredAgoMs:
                      auth.expires && auth.expires < Date.now()
                        ? Date.now() - auth.expires
                        : undefined,
                  },
                )
                const refreshStart = nowMs()
                auth.access = await refreshMainAccessToken(
                  undefined,
                  credentialModelId,
                  init?.signal ?? undefined,
                )
                trace.mark('refresh_main_access', {
                  ms: roundMs(nowMs() - refreshStart),
                })
              }

              if (!auth.access && !auth.modelDenied) {
                trace.done('missing_access_error')
                throw new Error('OAuth access token is missing after refresh')
              }
              /** Show quota toast from current QuotaManager state. */
              function showQuotaToastFromCache() {
                if (storage?.quota?.showToasts !== true) return
                const mainEntry = quotaManager.getMain(
                  requestMainQuotaIdentity?.quotaKey,
                )
                if (!mainEntry) return
                // Prefer the shared QuotaManager cache for fallback quota so the
                // toast matches the sidebar and reflects background refreshes
                // rather than the request-start storage snapshot.
                const fallbacks = (storage?.accounts ?? [])
                  .filter(
                    (a): a is OAuthAccount =>
                      a.enabled !== false && isOAuthAccount(a),
                  )
                  .map((a) => ({
                    ...a,
                    // Account ids scope quota observations across token rotation.
                    quota: quotaManager.getFallback(a.id, a)?.quota ?? a.quota,
                  }))
                const mainPassesPolicy = quotaSnapshotPassesPolicy(
                  mainEntry.quota,
                  storage,
                )
                let activeId: string | undefined
                if (mainPassesPolicy) {
                  activeId = 'main'
                } else {
                  // Mirror routing: the active account is the first fallback that
                  // actually passes quota policy; if none do, routing falls
                  // through to main, so label main — never a failing fallback.
                  activeId =
                    fallbacks.find((f) =>
                      quotaSnapshotPassesPolicy(f.quota, storage),
                    )?.id ?? 'main'
                }
                showQuotaToast(mainEntry.quota, fallbacks, activeId)
              }

              if (replayableRequest && mainQuotaRoutingEnabled(storage)) {
                try {
                  const quotaStart = nowMs()
                  // Identity-aware read prevents routing with a previous main
                  // account's quota after a slot switch.
                  let routingQuotaEntry = routingMainQuotaEntry(
                    requestMainQuotaIdentity,
                    storage,
                  )
                  let routingQuota = routingQuotaEntry?.quota
                  if (!routingQuota) {
                    routingQuota = await quotaManager.refreshMain(
                      requestMainQuotaIdentity?.quotaKey,
                      auth.access,
                      requestMainQuotaIdentity?.generation,
                      'admission',
                    )
                    routingQuotaEntry = routingMainQuotaEntry(
                      requestMainQuotaIdentity,
                      storage,
                    )
                    showQuotaToastFromCache()
                  } else if (
                    quotaManager.needsRefresh(
                      sessionRequestCount,
                      requestModelId,
                    )
                  ) {
                    if (
                      quotaSnapshotIsExhausted(routingQuota) ||
                      quotaSnapshotModelScopeIsExhausted(
                        routingQuota,
                        requestModelId,
                      )
                    ) {
                      // A stale exhausted snapshot is not strong enough evidence
                      // to spend API-key credits or skip the main account for a
                      // model-scoped quota. Re-check synchronously; if the quota API
                      // is backed off and only stale data is returned, the route gate
                      // below still refuses API-key routes because the entry is not
                      // fresh.
                      routingQuota = await quotaManager.refreshMain(
                        requestMainQuotaIdentity?.quotaKey,
                        auth.access,
                        requestMainQuotaIdentity?.generation,
                      )
                      routingQuotaEntry = routingMainQuotaEntry(
                        requestMainQuotaIdentity,
                        storage,
                      )
                    } else {
                      // Stale OR every-N request boundary — background refresh,
                      // return current snapshot to avoid blocking. Refresh the
                      // sidebar and show the toast once the new main quota lands.
                      void quotaManager
                        .refreshMain(
                          requestMainQuotaIdentity?.quotaKey,
                          auth.access,
                          requestMainQuotaIdentity?.generation,
                        )
                        .then(() => {
                          void refreshSidebarQuota().catch(() => {})
                          showQuotaToastFromCache()
                        })
                        .catch(() => {})
                    }
                  }
                  // Update the sidebar every replayable request so fallback
                  // quota refreshed by the background timer is reflected too.
                  writeSidebarState(storage, {
                    activeId: 'main',
                    route: 'main',
                    mainAccessToken: auth.access,
                  })
                  const routingQuotaPasses =
                    quotaSnapshotPassesPolicy(routingQuota, storage) &&
                    quotaSnapshotPassesModelScope(routingQuota, requestModelId)
                  trace.mark('main_quota_for_routing', {
                    ms: roundMs(nowMs() - quotaStart),
                    passes: routingQuotaPasses,
                    model: requestModelId,
                    modelScopedExhausted: quotaSnapshotModelScopeIsExhausted(
                      routingQuota,
                      requestModelId,
                    ),
                  })
                  if (!routingQuotaPasses) {
                    const fallbackStart = nowMs()
                    preselectedFallbackAccounts =
                      await getRoutableFallbackAccounts(storage, {
                        includeApiRoutes: Boolean(
                          routingQuotaEntry &&
                            routingQuotaEntry.refreshAfter > Date.now() &&
                            quotaSnapshotIsExhausted(routingQuotaEntry.quota),
                        ),
                        modelId: requestModelId,
                      })
                    trace.mark('preselect_fallback_accounts', {
                      ms: roundMs(nowMs() - fallbackStart),
                      accounts: preselectedFallbackAccounts.length,
                    })
                    const fallbackResponse = await tryUsableFallbackAccounts(
                      input,
                      init,
                      preselectedFallbackAccounts,
                      storage,
                      undefined,
                      trace,
                      {
                        onSuccess: (account) =>
                          writeCurrentSidebarState(account.id, 'fallback'),
                        mainAccessToken: auth.access,
                        mainQuotaIdentity: requestMainQuotaIdentity,
                        fableRequest,
                        laneStartRequest,
                      },
                    )
                    if (fallbackResponse) {
                      trace.done('return_preselected_fallback', {
                        status: fallbackResponse.status,
                      })
                      return wrapResponse(fallbackResponse)
                    }
                  }
                } catch (error) {
                  trace.mark('main_quota_for_routing_error', {
                    error:
                      error instanceof Error ? error.message : String(error),
                  })
                  // A fallback still being saved by another writer must not
                  // be replaced by main for this request.
                  if (isNativeTransientAccountError(error)) throw error
                  // Main quota checks should optimize routing, not break requests.
                }
              }

              let mainQuota = routingMainQuotaEntry(
                requestMainQuotaIdentity,
                storage,
              )?.quota
              if (
                storage?.quota?.failClosedOnUnknownQuota &&
                (mainQuota === undefined ||
                  (auth.access.startsWith('sk-ant-oat') &&
                    requestMainQuotaIdentity?.providerAccountUuid ===
                      undefined)) &&
                quotaManager.isBackedOff()
              ) {
                const lastError = quotaManager.getLastApiError()
                const msg = lastError
                  ? formatQuotaBackoffMessage(lastError, Date.now())
                  : 'Quota API unavailable'
                log('[quota] blocked: quota API backed off (failClosed)', {
                  nextRetryAt: lastError?.nextRetryAt,
                  retryCount: lastError?.retryCount,
                })
                return new Response(
                  JSON.stringify({
                    type: 'error',
                    error: { type: 'rate_limit_error', message: msg },
                  }),
                  {
                    status: 429,
                    headers: {
                      'content-type': 'application/json',
                      'retry-after': String(
                        lastError?.nextRetryAt
                          ? Math.max(
                              1,
                              Math.ceil(
                                (lastError.nextRetryAt - Date.now()) / 1000,
                              ),
                            )
                          : 60,
                      ),
                    },
                  },
                )
              }
              // Killswitch — eagerly refresh quota so it can evaluate
              if (isKillswitchEnabled(storage)) {
                const needsRefresh = quotaManager.needsRefresh(
                  sessionRequestCount,
                  requestModelId,
                )
                if (needsRefresh) {
                  try {
                    await Promise.all([
                      quotaManager.refreshMain(
                        requestMainQuotaIdentity?.quotaKey,
                        auth.access,
                        requestMainQuotaIdentity?.generation,
                      ),
                      // Fallback-first may have just polled these accounts.
                      // Keep those fresh readings rather than polling twice.
                      refreshFallbackQuotas(
                        false,
                        true,
                        undefined,
                        'admission',
                      ),
                    ])
                  } catch (error) {
                    log('[quota] killswitch refresh failed', {
                      error:
                        error instanceof Error ? error.message : String(error),
                      backedOff: quotaManager.isBackedOff(),
                    })
                  }
                }
                // Re-read after the eager refresh so the killswitch evaluates
                // against fresh quota. The initial read above is null on the
                // first request, before the refresh populates the cache.
                mainQuota = routingMainQuotaEntry(
                  requestMainQuotaIdentity,
                  storage,
                )?.quota
              }

              if (
                isKillswitchEnabled(storage) &&
                // No `mainQuota &&` guard: when main quota is unknown (eager
                // refresh failed on the first request) killswitchPassesPolicy
                // returns false under failClosedOnUnknownQuota, so the killswitch
                // must still block / reroute instead of falling through to main.
                // accountId stays undefined for main; the optional trailing
                // modelId adds the per-model scoped check.
                !killswitchPassesPolicy(
                  mainQuota,
                  storage,
                  undefined,
                  requestModelId,
                )
              ) {
                // Main is killswitch-killed. Decide where to route from the SAME
                // set routing will actually use — usable fallbacks that also
                // pass the killswitch policy. Deriving the 429 decision from this
                // single source of truth means an account that passes the quota
                // check but is dropped by routing (expired/un-refreshable token,
                // refresh backoff, below routing threshold) cannot suppress the
                // 429 and let the request fall through to the killed main. A
                // non-replayable body cannot use a fallback at all, so it has no
                // survivors by definition.
                const canReplayToFallback = isReplayableRequest(
                  input,
                  init?.body,
                )
                const survivingFallbacks = canReplayToFallback
                  ? await getRoutableFallbackAccounts(storage, {
                      includeApiRoutes: mainQuotaEntryIsFreshExhausted(
                        auth.access,
                      ),
                      modelId: requestModelId,
                    })
                  : []

                if (survivingFallbacks.length > 0) {
                  log('[route] skipping main (killswitch), trying fallbacks')
                  const fallbackResponse = await tryUsableFallbackAccounts(
                    input,
                    init,
                    survivingFallbacks,
                    storage,
                    undefined,
                    trace,
                    {
                      // Correct the sidebar's active account — the routing
                      // writeback above optimistically set it to 'main', which
                      // is wrong once the killswitch hands off to a fallback.
                      onSuccess: (account) =>
                        writeCurrentSidebarState(account.id, 'fallback'),
                      mainAccessToken: auth.access,
                      mainQuotaIdentity: requestMainQuotaIdentity,
                      laneStartRequest,
                    },
                  )
                  // The killswitch is a HARD block: it must never fall through to
                  // the killed main. tryUsableFallbackAccounts returns the last
                  // upstream error on exhaustion (returnLastOnExhausted defaults
                  // to true), so a transient fallback failure surfaces that real
                  // error rather than being retried on the killswitched main.
                  if (fallbackResponse) {
                    trace.done('return_killswitch_fallback', {
                      status: fallbackResponse.status,
                    })
                    return wrapResponse(fallbackResponse)
                  }
                }
                // Nowhere to route (no surviving fallback, or none produced a
                // response): hard-block instead of using the killed main.
                const now = Date.now()
                const fallbackAccounts = (storage?.accounts ?? [])
                  .filter(
                    (a): a is OAuthAccount =>
                      nativeAccountCanServe(a) && isOAuthAccount(a),
                  )
                  .map((a) => ({ ...a, quota: getFallbackQuota(a) }))
                // Decide whether the block is scoped-driven (request's
                // model matches a scoped window that is at/below the scoped
                // threshold) vs a whole-account 5h/7d-driven block. A
                // healthy model-specific window + 5h/7d breach is NOT scoped-driven.
                const scoped = resolveScopedDrivenBlock({
                  mainQuota,
                  requestModelId,
                  storage,
                })
                const retryAfter = killswitchRetryAfterSeconds(
                  mainQuota,
                  fallbackAccounts,
                  now,
                  scoped.isScopedDriven ? scoped.modelId : undefined,
                )
                const message = formatKillswitchBlockMessage({
                  retryAfterSeconds: retryAfter,
                  ...(scoped.isScopedDriven && { modelName: scoped.modelName }),
                })
                return new Response(
                  JSON.stringify({
                    type: 'error',
                    error: {
                      type: 'rate_limit_error',
                      message,
                    },
                  }),
                  {
                    status: 429,
                    headers: {
                      'content-type': 'application/json',
                      'retry-after': String(retryAfter),
                    },
                  },
                )
              }

              if (auth.modelDenied) {
                const fallbackAccounts = replayableRequest
                  ? await getRoutableFallbackAccounts(storage, {
                      modelId: credentialModelId,
                    })
                  : []
                const response = await tryUsableFallbackAccounts(
                  input,
                  init,
                  fallbackAccounts,
                  storage,
                  undefined,
                  trace,
                  {
                    onSuccess: (account) =>
                      writeCurrentSidebarState(account.id, 'fallback'),
                    fableRequest,
                    laneStartRequest,
                    mainAccessToken: auth.access,
                    mainQuotaIdentity: requestMainQuotaIdentity,
                  },
                )
                if (response) return wrapResponse(response)
                const lastMainAttempt =
                  getRoutingMode(storage) !== 'sticky-balanced' &&
                  quotaSnapshotModelScopeIsExhausted(
                    mainQuota,
                    credentialModelId,
                  ) &&
                  quotaSnapshotPassesPolicy(mainQuota, storage) &&
                  killswitchPassesPolicy(
                    mainQuota,
                    storage,
                    undefined,
                    credentialModelId,
                  )
                if (!lastMainAttempt)
                  return wrapResponse(await modelDeniedResponse())
                return wrapResponse(
                  await sendWithAccessToken(
                    input,
                    init,
                    '',
                    trace,
                    'main',
                    storage,
                    'main',
                    undefined,
                    fableRequest,
                    laneStartRequest,
                    requestMainQuotaIdentity,
                  ),
                )
              }
              const mainResponse = await sendWithAccessToken(
                input,
                init,
                auth.access,
                trace,
                'main',
                storage,
                'main',
                undefined,
                fableRequest,
                laneStartRequest,
                requestMainQuotaIdentity,
                requestMainScopedAttempt,
              )
              let fallbackServed = false
              const response = await tryFallbackAccounts(
                input,
                init,
                mainResponse,
                preselectedFallbackAccounts,
                trace,
                storage,
                auth.access,
                (account) => {
                  fallbackServed = true
                  return writeCurrentSidebarState(account.id, 'fallback')
                },
                requestModelId,
                fableRequest,
                laneStartRequest,
                requestMainQuotaIdentity,
              )
              if (!fallbackServed)
                await writeCurrentSidebarState('main', 'main')

              trace.done('return_response', { status: response.status })
              return wrapResponse(response)
            },
          })
        }

        return {}
      },
      // Offered only while this host holds a vault enrollment token; the
      // method itself rechecks vault authority and the empty slot.
      get methods() {
        return [
          ...(existsSync(getHostClaustrumEnrollmentPaths('opencode').tokenPath)
            ? [vaultLoginMethod]
            : []),
          {
            label: 'Claude Pro/Max',
            type: 'oauth',
            authorize: async () => {
              // Enrollment alone decides whether this host signs in locally;
              // check it before the browser sign-in starts. Saving the new
              // login is refused again by the native runtime if the host
              // enrolls while the user is signing in.
              if (
                (await readNativeEnrollmentMode('opencode', process.env)) !==
                'local'
              ) {
                throw new Error('Disconnect from the vault first.')
              }
              // Local sign-in saves into the migrated local account pool;
              // reading it refuses before the browser flow when offline
              // migration has not run.
              await nativeAccounts.read()
              if (process.env.OPENCODE_AUTH_CONTENT !== undefined) {
                throw new Error(
                  'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set',
                )
              }
              const result = await authorizeImpl('max')
              return {
                url: result.url,
                instructions: 'Paste the authorization code here:',
                method: 'code',
                callback: async (code: string) => {
                  const exchanged = await exchange(
                    code,
                    result.verifier,
                    result.redirectUri,
                    result.state,
                  )
                  if (exchanged.type === 'failed') return exchanged
                  assertNativeEnvironment()
                  await nativeAccounts.loginOAuth({
                    routeId: 'main',
                    replace: true,
                    credential: {
                      access: exchanged.access,
                      refresh: exchanged.refresh,
                      expires: exchanged.expires,
                    },
                  })
                  const activation = custodyTombstoneOAuth('anthropic')
                  return {
                    type: 'success' as const,
                    access: activation.access,
                    refresh: activation.refresh,
                    expires: activation.expires,
                  }
                },
              }
            },
          },
          {
            label: 'Create an API Key',
            type: 'oauth',
            authorize: async () => {
              const result = await authorize('console')
              return {
                url: result.url,
                instructions: 'Paste the authorization code here:',
                method: 'code',
                callback: async (code: string) => {
                  const credentials = await exchange(
                    code,
                    result.verifier,
                    result.redirectUri,
                    result.state,
                  )
                  if (credentials.type === 'failed') return credentials
                  const apiKey = await fetchOAuth(
                    `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                    {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        authorization: `Bearer ${credentials.access}`,
                      },
                    },
                  ).then((r) => r.json() as Promise<{ raw_key: string }>)
                  return { type: 'success' as const, key: apiKey.raw_key }
                },
              }
            },
          },
          {
            provider: 'anthropic',
            label: 'Manually enter API Key',
            type: 'api',
          },
        ]
      },
    },
    dispose,
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
  pluginTestHandles?.set(plugin, {
    drainDispatchWork,
    primeManager,
    quotaManager,
    cacheKeepManager,
    fableFallbackManager,
    resolveMainQuotaIdentity: resolveMainQuotaAccountIdentity,
    resolveSidebarQuotaAccess,
    refreshSidebarQuota,
    fallbackRefreshReady,
    get scopedRuntime() {
      return getOpenCodeScopedRuntime(accountStoragePath, ctx.directory)
    },
    notificationMessageIdBeforeAssistant,
    trackDesktopNoticeMessageId,
    isDesktopNoticeMessage,
  })
  return plugin
}

export const AnthropicAuthPlugin: Plugin = anthropicAuthPlugin

import {
  mergeNativeSettingsSection,
  nativeCacheKeepAlways,
  nativeSettingsRecord as plainSettingsSection,
} from '@cortexkit/anthropic-auth-core'
