import { randomUUID } from 'node:crypto'
import {
  type AccountStorage,
  type ApiKeyAccount,
  acquireRefreshFileLock,
  addAccountPersistent,
  authorize,
  buildAccountList,
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
  buildPrimeRequestBody,
  buildRefreshOperationError,
  CACHE_1H_COMMAND_NAME,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  CLAUDE_ACCOUNT_COMMAND_NAME,
  CLAUDE_CACHE_KEEP_COMMAND_NAME,
  CLAUDE_DUMP_COMMAND_NAME,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
  CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE,
  CLAUDE_FAST_COMMAND_NAME,
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_LOGGING_COMMAND_NAME,
  CLAUDE_PRIME_COMMAND_NAME,
  CLAUDE_QUOTAS_COMMAND_NAME,
  CLAUDE_ROUTING_COMMAND_NAME,
  CLAUDE_START_COMMAND_NAME,
  computeXxhash64Hex,
  configuredAnthropicOAuthAccountCount,
  createEmptyStorage,
  createStickyNoRouteResponse,
  type DumpHandle,
  decideStickyQuotaFailure,
  dumpDirectRequest,
  dumpResponseArtifact,
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
  FallbackAccountManager,
  fetchOAuthAccountProfile,
  formatOAuthAccountTier,
  formatQuotaBackoffMessage,
  formatRefreshBackoffMessage,
  getAccountStoragePath,
  getCache1hMode,
  getCache1hPersistentMode,
  getCacheKeepWindow,
  getDefaultCacheKeepRegistryDirectory,
  getFallbackReauthLabels,
  getKillswitchConfig,
  getOrCreateMainAccountId,
  getOrCreatePrimeAuthLineageId,
  getPersistedLogLevel,
  getPersistedMainQuota,
  getQuotaNextRefreshAt,
  getRelayConfig,
  getRoutingMode,
  getStickyRoutingStatePath,
  hashRefreshToken,
  type IdentityState,
  incrementPrimeUsagePersistent,
  isApiKeyAccount,
  isCache1hEnabled,
  isCache1hPersistentlyEnabled,
  isCacheKeepAlways,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isCacheKeepSubagentsEnabled,
  isClaudeOpus5Model,
  isCostZeroingEnabled,
  isDumpPersistentlyEnabled,
  isFastModeEnabled,
  isFastModePersistentlyEnabled,
  isFastModeSupportedModel,
  isKillswitchEnabled,
  isOAuthAccount,
  isPermanentRefreshError,
  isPrimePersistentlyEnabled,
  isQuotaBearingHeaderFrame,
  isValidApiBaseURL,
  KILLSWITCH_COMMAND_NAME,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  loadAccounts,
  log,
  logger,
  mergeAnthropicBetas,
  mergeHeaderQuotaForPersistence,
  mergeMainQuotaErrorClearedAt,
  normalizeQuotaHeaders,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  oauthProfileIsFresh,
  oauthProfileMatchesIdentity,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  PrimeManager,
  type PrimeManagerOptions,
  type PrimeRefreshResult,
  type PrimeSendResult,
  parseAccountCommandAction,
  parseCache1hCommandAction,
  parseCacheKeepCommandAction,
  parseDumpCommandAction,
  parseFastModeCommandAction,
  parseLaneStartCommandAction,
  parseLoggingCommandAction,
  parsePrimeCommandAction,
  parseRoutingCommandAction,
  QUOTA_HEADER_FEED_SCHEMA_VERSION,
  type QuotaAccountSummary,
  type QuotaEntry,
  type QuotaHeaderFeedEntry,
  QuotaHeaderFeedRegistry,
  QuotaManager,
  type QuotaState,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  refreshBackoffActive,
  refreshClaudeOAuthToken,
  removeAccountPersistent,
  reorderAccountsPersistent,
  resolveClaudeCodeIdentity,
  STICKY_ROUTING_MAIN_ACCOUNT_ID,
  type StickyRouteCandidate,
  StickySessionRouter,
  saveAccountState,
  saveOAuthProfileState,
  sendViaRelay,
  setAccountEnabledPersistent,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCache1hState,
  setCacheKeepPersistentAlways,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setCacheKeepSubagentsEnabled,
  setDumpEnabled,
  setDumpPersistentEnabled,
  setFastModeEnabled,
  setFastModePersistentEnabled,
  setKillswitchPersistent,
  setLogLevel,
  setLogLevelPersistent,
  setPrimePersistentEnabled,
  setRoutingMode,
  shouldFallbackStatus,
  stickyQuotaSnapshotIsFresh,
  stickyRouteFamilyForModel,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode-ai/plugin'

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
  FableFallbackManager,
  type FableFallbackPlan,
  type FableStandbyCacheAnchor,
  isRecoverableRefusalModel,
  recoverableRefusalFamily,
} from './fable-fallback.ts'
import {
  fireLaneStart,
  LANE_START_REQUEST_HEADER,
  LaneStartTracker,
} from './lane-start.ts'
import { adoptPrimeManager } from './prime-manager-registry.ts'
import { resolvePromptContext } from './prompt-context.ts'
import {
  formatKillswitchBlockMessage,
  resolveScopedDrivenBlock,
} from './request-policy.ts'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
} from './rpc/notifications.ts'
import {
  type ApplyRequest,
  type ApplyResult,
  COMMAND_MODAL_NAMES,
  type CommandModalName,
  type OpenDialogPayload,
} from './rpc/protocol.ts'
import { getRpcDir } from './rpc/rpc-dir.ts'
import { type RpcServerHandle, startRpcServer } from './rpc/rpc-server.ts'
import {
  resolveContentFilterFallbackMode,
  type ServerSideFallbackOutcome,
} from './server-fallback.ts'
import {
  getInitialSidebarRoutingTestHooks,
  getSidebarState,
  getSidebarStateFile,
  type SidebarState,
  setSidebarState,
} from './sidebar-state.ts'
import {
  addFastModeBetaHeader,
  createStrippedStream,
  extractLatestHybridMessageCacheAnchor,
  isInsecure,
  mergeHeaders,
  prepareFableCacheWarmSource,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const HANDLED_SENTINEL = '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__'
const HTTP_SERVER_RESPONSE_TYPE_ID = '~effect/http/HttpServerResponse'
const HTTP_COOKIES_TYPE_ID = '~effect/http/Cookies'
const HTTP_BODY_TYPE_ID = '~effect/http/HttpBody'
const ERROR_REPORTER_IGNORE = '~effect/ErrorReporter/ignore'
const PRIME_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const MAIN_AUTH_REFRESH_TICK_MS = 60_000
const MAIN_AUTH_REFRESH_TICK_JITTER_MS = 60_000
const CONCURRENT_MAIN_REFRESH_WAIT_MS = 5_000
const CONCURRENT_MAIN_REFRESH_POLL_BASE_MS = 200
const MIN_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES = 240
const DEFAULT_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES =
  MIN_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES
const SIDEBAR_ROUTING_FRESH_MS = 10 * 60 * 1000
// OpenCode creates one plugin instance per project, but those instances share
// the same host OAuth credential and account sidecar within a server process.
const mainAccessRefreshesByStoragePath = new Map<string, Promise<string>>()

function hasEnabledOAuthAccount(
  storage: AccountStorage | null,
  activeId: string,
) {
  return (storage?.accounts ?? []).some(
    (account) =>
      account.id === activeId &&
      account.enabled !== false &&
      isOAuthAccount(account),
  )
}

function deriveSidebarRouting(
  storage: AccountStorage | null,
): Pick<SidebarState, 'activeId' | 'route'> {
  const firstFallback = (storage?.accounts ?? []).find(
    (account): account is OAuthAccount =>
      account.enabled !== false && isOAuthAccount(account),
  )
  if (getRoutingMode(storage) === 'fallback-first' && firstFallback) {
    return { activeId: firstFallback.id, route: 'fallback-first' }
  }
  return { activeId: 'main', route: 'main' }
}

function validateSidebarRouting(
  routing: Pick<SidebarState, 'activeId' | 'route'> | undefined,
  storage: AccountStorage | null,
): Pick<SidebarState, 'activeId' | 'route'> {
  if (
    routing?.activeId === 'main' ||
    (routing?.activeId && hasEnabledOAuthAccount(storage, routing.activeId))
  ) {
    return routing
  }
  return deriveSidebarRouting(storage)
}

function resolveLoadedSidebarRouting(
  existing: SidebarState,
  freshStorage: AccountStorage | null,
  fallbackRouting?: Pick<SidebarState, 'activeId' | 'route'>,
): Pick<SidebarState, 'activeId' | 'route'> {
  const existingAge = Date.now() - existing.lastUpdated
  if (
    !existing.activeId ||
    existingAge < 0 ||
    existingAge > SIDEBAR_ROUTING_FRESH_MS
  ) {
    return validateSidebarRouting(fallbackRouting, freshStorage)
  }

  return validateSidebarRouting(existing, freshStorage)
}

async function resolveFreshSidebarRouting(
  existing: SidebarState,
  loadFreshStorage: () => Promise<AccountStorage | null>,
  fallbackRouting?: Pick<SidebarState, 'activeId' | 'route'>,
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
  accountStoragePath: string,
): Promise<{
  activeId: string | undefined
  route: string
  freshStorage: AccountStorage | null
}> {
  await getInitialSidebarRoutingTestHooks()?.beforeStorageLoad?.()
  let freshStorage: AccountStorage | null
  try {
    freshStorage = await loadAccounts(accountStoragePath)
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

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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
  if (latestUserMessageId && candidate <= latestUserMessageId) return undefined
  return candidate
}

async function sendIgnoredMessage(
  ctx: Parameters<Plugin>[0],
  sessionId: string,
  text: string,
  options: {
    noReply?: boolean
    beforeActiveAssistant?: boolean
    canSend?: () => boolean
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
    const messageID = promptContext?.latestAssistantMessageId
      ? notificationMessageIdBeforeAssistant(
          promptContext.latestAssistantMessageId,
          promptContext.latestUserMessageId,
        )
      : undefined
    if (messageID) request.body.messageID = messageID
  }
  if (promptContext?.agent) request.body.agent = promptContext.agent
  if (promptContext?.model) request.body.model = promptContext.model
  if (promptContext?.variant) request.body.variant = promptContext.variant

  // Resolving the active prompt context crosses the OpenCode process boundary.
  // A new user prompt can start while that request is in flight, so re-check the
  // caller's delivery lease immediately before inserting the ignored message.
  if (options.canSend && !options.canSend()) return false

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
  // OpenCode currently has no handled/cancel return contract for
  // command.execute.before. Throw an Error for legacy hosts, but duck-type an
  // Effect HttpServerResponse.empty({ status: 204 }) so OpenCode 1.17+ treats
  // handled slash commands as a clean no-content response instead of logging a
  // plugin error.
  const sentinel = new Error(HANDLED_SENTINEL) as Error &
    Record<string, unknown>
  sentinel[HTTP_SERVER_RESPONSE_TYPE_ID] = HTTP_SERVER_RESPONSE_TYPE_ID
  sentinel[ERROR_REPORTER_IGNORE] = true
  sentinel.status = 204
  sentinel.statusText = undefined
  sentinel.headers = {}
  sentinel.cookies = {
    [HTTP_COOKIES_TYPE_ID]: HTTP_COOKIES_TYPE_ID,
    cookies: {},
  }
  sentinel.body = { [HTTP_BODY_TYPE_ID]: HTTP_BODY_TYPE_ID, _tag: 'Empty' }
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

type FableWarmTarget = {
  url: string
  headers: Headers
  bodyText: string
  oauthAccountId: string
}

type FableRequestContext = {
  plan: FableFallbackPlan
  warmTarget?: FableWarmTarget
  opusCacheAnchor?: FableStandbyCacheAnchor
  standbyBridgeLogged?: boolean
}

type StickyOAuthRoute = {
  id: string
  access: string
  quota?: OAuthQuotaSnapshot
  identity: IdentityState
  order: number
  account?: OAuthAccount
}

type MainQuotaIdentityBinding = {
  accountIdentity: string | undefined
  generation: number
}

type MainQuotaIdentityResolution = MainQuotaIdentityBinding & {
  stale: boolean
}

const FABLE_SWITCHED_TO_OPUS_NOTICE =
  'Fable content filter detected. Switched to Opus 4.8 for a 10-response recovery window while keeping the Fable cache warm.'
const FABLE_RESTORED_NOTICE =
  'Fable recovery window complete. Returning to Fable 5.'

/**
 * Compose the recovery-window notice text for the requested model. Fable 5 and
 * Opus 5 follow the same Anthropic-recommended fallback (Opus 4.8) for the
 * same reason (cyber safety classifiers returning `stop_reason: "refusal"`),
 * so the message structure is shared; only the model name moves.
 */
function buildSwitchedToOpusNotice(modelId: string): string {
  if (isClaudeOpus5Model(modelId)) {
    return 'Opus 5 content filter detected. Switched to Opus 4.8 for a 10-response recovery window while keeping the Opus 5 cache warm.'
  }
  return FABLE_SWITCHED_TO_OPUS_NOTICE
}

function buildRestoredNotice(modelId: string): string {
  if (isClaudeOpus5Model(modelId)) {
    return 'Opus 5 recovery window complete. Returning to Opus 5.'
  }
  return FABLE_RESTORED_NOTICE
}

function fallbackModelLabel(modelId: string): string {
  if (isClaudeOpus5Model(modelId)) return 'Opus 5'
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

function addFableMythos5Models<
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
      Object.values(CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS).map((spec) => [
        spec.id,
        {
          ...base,
          id: spec.id,
          name: spec.name,
          api: base.api ? { ...base.api, id: spec.id } : undefined,
          cost: {
            input: CLAUDE_FABLE_MYTHOS_5_PRICING.input,
            output: CLAUDE_FABLE_MYTHOS_5_PRICING.output,
            cache: {
              read: CLAUDE_FABLE_MYTHOS_5_PRICING.cacheRead,
              write: CLAUDE_FABLE_MYTHOS_5_PRICING.cacheWrite5m,
            },
          },
          limit: {
            ...(base.limit ?? {}),
            context: CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
            output: CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
          },
          capabilities: {
            ...(base.capabilities ?? {}),
            reasoning: true,
            attachment: true,
            toolcall: true,
          },
          release_date: CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE,
        },
      ]),
    ),
  } as T
}

const CLAUDE_OPUS_5_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

function createClaudeOpus5Variants() {
  return Object.fromEntries(
    CLAUDE_OPUS_5_EFFORTS.map((effort) => [
      effort,
      {
        thinking: { type: 'adaptive', display: 'summarized' },
        effort,
      },
    ]),
  )
}

function applyClaudeOpus5Variants<
  T extends Record<string, AnthropicProviderModel>,
>(models: T) {
  return Object.fromEntries(
    Object.entries(models).map(([id, model]) => {
      const modelId = model.api?.id ?? model.id ?? id
      return [
        id,
        isClaudeOpus5Model(modelId)
          ? { ...model, variants: createClaudeOpus5Variants() }
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

type PluginRuntimeTimerOverrides = Partial<{
  setTimeout: typeof globalThis.setTimeout
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
}>

const anthropicAuthPlugin = async (
  ctx: Parameters<Plugin>[0],
  timerOverrides: PluginRuntimeTimerOverrides = {},
) => {
  const runtimeTimers = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    ...timerOverrides,
  }
  startEventLoopLagMonitor()
  const { client } = ctx
  const profileFetch = globalThis.fetch
  const accountStoragePath = getAccountStoragePath()

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

  let initialStorage: AccountStorage | null
  try {
    initialStorage = await loadAccounts(accountStoragePath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load account store: ${message}`, {
      cause: error instanceof Error ? error : undefined,
    })
  }
  const fallbackMode = resolveContentFilterFallbackMode(
    process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE,
  )
  const fableFallbackManager = new FableFallbackManager()
  const laneStartTracker = new LaneStartTracker()
  const serverFallbackTargets = new Map<string, string>()
  const pendingDesktopNotices = new Map<string, string[]>()
  const pendingRecoveryDesktopNotices = new Map<string, string>()
  const desktopNoticeFlushes = new Map<string, Promise<void>>()
  const desktopNoticeSafeSessions = new Set<string>()
  const desktopNoticeProbes = new Map<string, number>()
  const stickySessionRouter = new StickySessionRouter({
    path:
      process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE ||
      getStickyRoutingStatePath(accountStoragePath),
  })
  const quotaManager = new QuotaManager({
    storage: initialStorage,
    onMainQuotaFetched: async (
      quota,
      checkedAt,
      tokenFingerprint,
      fetchStartedAt,
      quotaErrorGeneration,
      quotaErrorClearedAt,
    ) => {
      try {
        const storage =
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage()
        const persisted = getPersistedMainQuota(storage)
        if (
          persisted &&
          persisted.checkedAt >= fetchStartedAt &&
          getQuotaNextRefreshAt(persisted.quota, storage, persisted.checkedAt) >
            Date.now()
        ) {
          quotaManager.seedMainFromStorage(storage, mainQuotaAccountId)
          return
        }
        storage.quota = storage.quota ?? {}
        storage.quota.mainQuota = quota
        storage.quota.mainQuotaCheckedAt = checkedAt
        storage.quota.mainQuotaToken = tokenFingerprint
        storage.quota.mainLastQuotaApiError = undefined
        storage.quota.mainQuotaErrorGeneration = quotaErrorGeneration
        storage.quota.mainQuotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
          storage.quota.mainQuotaErrorClearedAt,
          quotaErrorClearedAt,
        )
        await saveAccountState(storage, accountStoragePath, { mainQuota: true })
      } catch (error) {
        logger.warn('quota', 'failed to persist main quota', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    onApiError: async (error, quotaErrorGeneration) => {
      try {
        const storage =
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage()
        storage.quota = storage.quota ?? {}
        storage.quota.mainLastQuotaApiError = error
        storage.quota.mainQuotaErrorGeneration = quotaErrorGeneration
        await saveAccountState(storage, accountStoragePath, { mainQuota: true })
      } catch (e) {
        logger.warn('quota', 'failed to persist backoff state', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },
  })

  async function reconcileMainQuotaAccountIdentity(
    accessToken: string,
    accountIdentity: string | undefined,
  ): Promise<void> {
    if (
      mainQuotaIdentityAccessToken === accessToken &&
      mainQuotaAccountId === accountIdentity
    ) {
      return
    }

    mainQuotaIdentityAccessToken = accessToken
    mainQuotaAccountId = accountIdentity
    const clearedGeneration = quotaManager.setMainQuotaAccountIdentity(
      accountIdentity,
      accessToken.startsWith('sk-ant-oat'),
    )
    if (accountIdentity === undefined) return

    const storage = await loadAccounts(accountStoragePath)
    const persistedError = storage?.quota?.mainLastQuotaApiError
    if (
      !storage ||
      !persistedError ||
      persistedError.accountIdentity === accountIdentity ||
      (!accessToken.startsWith('sk-ant-oat') &&
        persistedError.accountIdentity === undefined)
    ) {
      return
    }

    storage.quota = storage.quota ?? {}
    storage.quota.mainLastQuotaApiError = undefined
    storage.quota.mainQuotaErrorGeneration = Math.max(
      storage.quota.mainQuotaErrorGeneration ?? 0,
      clearedGeneration ?? quotaManager.getMainQuotaErrorGeneration(),
    )
    storage.quota.mainQuotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
      storage.quota.mainQuotaErrorClearedAt,
      quotaManager.getMainQuotaErrorClearedAt() ?? Date.now(),
    )
    await saveAccountState(storage, accountStoragePath, { mainQuota: true })
  }

  async function resolveMainQuotaAccountIdentity(
    accessToken: string,
    model?: string,
  ): Promise<MainQuotaIdentityResolution> {
    const inFlight = mainQuotaIdentityResolutions.get(accessToken)
    if (inFlight) return inFlight

    const resolution = (async () => {
      const resolutionGeneration = ++mainQuotaIdentityResolutionGeneration
      const identity = await resolveClaudeCodeIdentity(
        accessToken,
        model,
        mainAccountId,
      )
      // Adapters that do not use Claude's OAuth token format cannot be bootstrapped;
      // keep the slot identity only for that compatibility path. Claude OAuth
      // credentials use the oat prefix and stay unknown when bootstrap fails.
      const quotaIdentity =
        identity.accountUuid ??
        (!accessToken.startsWith('sk-ant-oat') ? mainAccountId : undefined)
      if (resolutionGeneration !== mainQuotaIdentityResolutionGeneration) {
        const identityChanged =
          mainQuotaIdentityAccessToken !== accessToken ||
          mainQuotaAccountId !== quotaIdentity
        return {
          accountIdentity: quotaIdentity,
          generation: quotaManager.getMainQuotaIdentityGeneration(),
          stale: identityChanged,
        }
      }
      await reconcileMainQuotaAccountIdentity(accessToken, quotaIdentity)
      return {
        accountIdentity: quotaIdentity,
        generation: quotaManager.getMainQuotaIdentityGeneration(),
        stale: false,
      }
    })()
    mainQuotaIdentityResolutions.set(accessToken, resolution)
    try {
      return await resolution
    } finally {
      if (mainQuotaIdentityResolutions.get(accessToken) === resolution) {
        mainQuotaIdentityResolutions.delete(accessToken)
      }
    }
  }

  const quotaHeaderFeedRegistry =
    initialStorage?.quotaHeaderFeed?.enabled === true
      ? new QuotaHeaderFeedRegistry()
      : null
  const profileHydrationAttempts = new Map<
    string,
    Promise<Awaited<ReturnType<typeof fetchOAuthAccountProfile>> | undefined>
  >()

  async function hydrateProfileOnce(
    accountId: string,
    accountIdentity: string | undefined,
    accessToken: string,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return undefined
    const attemptKey = `${accountIdentity ?? accountId}`
    let attempt = profileHydrationAttempts.get(attemptKey)
    if (!attempt) {
      const fetchAttempt = fetchOAuthAccountProfile({
        accessToken,
        accountIdentity,
        fetchImpl: profileFetch,
        signal,
      })
        .catch((error) => {
          logger.debug('quota', 'failed to hydrate account profile', {
            account: accountId,
            error: error instanceof Error ? error.message : String(error),
          })
          return undefined
        })
        .finally(() => {
          if (profileHydrationAttempts.get(attemptKey) === fetchAttempt) {
            profileHydrationAttempts.delete(attemptKey)
          }
        })
      attempt = fetchAttempt
      profileHydrationAttempts.set(attemptKey, attempt)
    }
    if (!signal) return attempt
    return new Promise<Awaited<typeof attempt>>((resolve) => {
      let settled = false
      const finish = (profile: Awaited<typeof attempt>) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(profile)
      }
      const onAbort = () => finish(undefined)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      void attempt.then(finish)
    })
  }

  async function persistProfileStateBestEffort(input: {
    accountId: 'main' | string
    accountIdentity?: string
    accessToken: string
    profile: OAuthAccount['profile']
  }): Promise<boolean | undefined> {
    try {
      return await saveOAuthProfileState(
        {
          accountId: input.accountId,
          profile: input.profile,
          accountIdentity: input.accountIdentity,
        },
        accountStoragePath,
      )
    } catch (error) {
      logger.debug('quota', 'failed to persist account profile', {
        account: input.accountId,
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  async function ensureProfilesForQuotaDisplay(
    storage: AccountStorage,
    mainAccessToken?: string,
    signal?: AbortSignal,
  ): Promise<AccountStorage> {
    if (process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION === '1') {
      return storage
    }
    const now = Date.now()
    const mainIdentity = mainQuotaAccountId
    if (
      mainAccessToken &&
      storage.main?.profile &&
      !oauthProfileMatchesIdentity(storage.main.profile, mainIdentity)
    ) {
      storage.main.profile = undefined
      void persistProfileStateBestEffort({
        accountId: 'main',
        accountIdentity: mainIdentity,
        accessToken: mainAccessToken,
        profile: undefined,
      }).catch(() => {})
    }
    if (
      mainAccessToken &&
      storage.main?.profile &&
      mainIdentity !== undefined &&
      storage.main.profile.accountIdentity === undefined
    ) {
      storage.main.profile = {
        ...storage.main.profile,
        accountIdentity: mainIdentity,
      }
      void persistProfileStateBestEffort({
        accountId: 'main',
        accountIdentity: mainIdentity,
        accessToken: mainAccessToken,
        profile: storage.main.profile,
      }).catch(() => {})
    }
    if (mainAccessToken && !oauthProfileIsFresh(storage.main?.profile, now)) {
      const profile = await hydrateProfileOnce(
        'main',
        mainIdentity,
        mainAccessToken,
        signal,
      )
      if (profile) {
        storage.main = {
          type: 'opencode',
          provider: 'anthropic',
          profile,
        }
        void persistProfileStateBestEffort({
          accountId: 'main',
          accountIdentity: mainIdentity,
          accessToken: mainAccessToken,
          profile,
        }).catch(() => {})
      }
    }

    for (const account of storage.accounts) {
      if (signal?.aborted) break
      if (!isOAuthAccount(account) || !account.access) continue
      const accessToken = account.access
      if (
        account.profile &&
        !oauthProfileMatchesIdentity(account.profile, account.id)
      ) {
        account.profile = undefined
        void persistProfileStateBestEffort({
          accountId: account.id,
          accountIdentity: account.id,
          accessToken,
          profile: undefined,
        }).catch(() => {})
      }
      if (account.profile && account.profile.accountIdentity === undefined) {
        account.profile = { ...account.profile, accountIdentity: account.id }
        void persistProfileStateBestEffort({
          accountId: account.id,
          accountIdentity: account.id,
          accessToken,
          profile: account.profile,
        }).catch(() => {})
      }
      if (oauthProfileIsFresh(account.profile, now)) continue
      const profile = await hydrateProfileOnce(
        account.id,
        account.id,
        accessToken,
        signal,
      )
      if (profile) {
        account.profile = profile
        void persistProfileStateBestEffort({
          accountId: account.id,
          accountIdentity: account.id,
          accessToken,
          profile,
        }).catch(() => {})
      }
    }
    return storage
  }

  const warnedQuotaNormalizeErrors = new Set<string>()

  async function persistPushedQuota(
    served: {
      accountId: 'main' | string
      accessToken: string
      authLineageId?: string
      mainQuotaIdentity?: MainQuotaIdentityBinding
    },
    entry: QuotaEntry,
  ): Promise<QuotaEntry | null> {
    const storage =
      (await loadAccounts(accountStoragePath)) ?? createEmptyStorage()
    if (served.accountId === 'main') {
      const accountIdentity = served.mainQuotaIdentity?.accountIdentity
      if (!accountIdentity || entry.quota.accountIdentity !== accountIdentity) {
        logger.trace(
          'quota',
          'skipped quota persistence without verified main account identity',
        )
        return null
      }
      storage.quota = storage.quota ?? {}
      storage.quota.mainQuota = {
        ...entry.quota,
        accountIdentity,
      }
      storage.quota.mainQuotaCheckedAt = entry.checkedAt
      await saveAccountState(storage, accountStoragePath, { mainQuota: true })
      const reloaded = await loadAccounts(accountStoragePath)
      const persistedQuota = reloaded?.quota?.mainQuota
      const persistedQuotaBelongsToRequest = Boolean(
        persistedQuota && persistedQuota.accountIdentity === accountIdentity,
      )
      const mergedQuota = persistedQuotaBelongsToRequest
        ? mergeHeaderQuotaForPersistence(persistedQuota, entry.quota)
        : entry.quota
      return persistedQuota
        ? {
            ...entry,
            quota: mergedQuota,
            checkedAt: persistedQuotaBelongsToRequest
              ? (reloaded.quota?.mainQuotaCheckedAt ?? entry.checkedAt)
              : entry.checkedAt,
          }
        : entry
    }
    const account = storage.accounts.find(
      (candidate): candidate is OAuthAccount =>
        candidate.id === served.accountId && isOAuthAccount(candidate),
    )
    if (!account) return null
    // A lineage mismatch is a confirmed replacement; two absent markers remain
    // legacy-compatible, while one-sided absence is too ambiguous to persist.
    if (account.authLineageId !== served.authLineageId) {
      logger.trace(
        'quota',
        'skipped stale fallback quota persistence after lineage change',
        {
          accountId: served.accountId,
          storedLineage: account.authLineageId,
          servedLineage: served.authLineageId,
        },
      )
      // The persistence fence is authoritative; discard the optimistic cache
      // write unless a newer replacement observation already won the race.
      if (quotaManager.getAllFallbacks().get(served.accountId) === entry) {
        quotaManager.clearFallback(served.accountId)
      }
      return null
    }
    account.quota = {
      ...entry.quota,
      accountIdentity: account.id,
    }
    await saveAccountState(storage, accountStoragePath, {
      accounts: [served.accountId],
    })
    return entry
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
    served: {
      accountId: 'main' | string
      accessToken: string
      mainQuotaIdentity?: MainQuotaIdentityBinding
    },
    entry: QuotaEntry,
  ): Promise<void> {
    if (!quotaHeaderFeedRegistry) return
    if (
      served.accountId === 'main' &&
      !served.mainQuotaIdentity?.accountIdentity
    ) {
      // Observed-at staleness exposes silence; an unknown key must not replace verified data.
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
    }
    const accountKey =
      credentialId ??
      (served.accountId === 'main'
        ? (served.mainQuotaIdentity?.accountIdentity ?? 'main')
        : served.accountId)
    const feedEntry: QuotaHeaderFeedEntry & { accountKey: string } =
      credentialId
        ? {
            identity_source: 'credential_id',
            credential_id: credentialId,
            schema_version: QUOTA_HEADER_FEED_SCHEMA_VERSION,
            provider: 'anthropic',
            configured_account_count: configuredAccountCount,
            observed_at_ms: observedAtMs,
            quota,
            accountKey,
          }
        : served.accountId === 'main' &&
            served.mainQuotaIdentity?.accountIdentity
          ? {
              identity_source: 'account_ref',
              account_ref: served.mainQuotaIdentity.accountIdentity,
              schema_version: QUOTA_HEADER_FEED_SCHEMA_VERSION,
              provider: 'anthropic',
              configured_account_count: configuredAccountCount,
              observed_at_ms: observedAtMs,
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
    served: {
      accountId: 'main' | string
      accessToken: string
      authLineageId?: string
      mainQuotaIdentity?: MainQuotaIdentityBinding
    },
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
            boundIdentity: mainQuotaIdentity?.accountIdentity,
            currentGeneration: quotaManager.getMainQuotaIdentityGeneration(),
          })
          return
        }
      }
      const entry =
        served.accountId === 'main'
          ? quotaManager.pushMainFromHeaders(
              mainQuotaIdentity?.accountIdentity,
              incoming,
            )
          : quotaManager.pushFallbackFromHeaders(served.accountId, incoming, {
              authLineageId: served.authLineageId,
            })
      if (!entry) return
      void (async () => {
        let feedEntry = entry
        try {
          const persistedEntry = await persistPushedQuota(served, entry)
          if (persistedEntry === null) return
          feedEntry = persistedEntry
        } catch (error) {
          logPersistFailure(error)
        }
        void refreshSidebarQuota().catch(() => {})
        await publishQuotaHeaderFeed(served, feedEntry)
      })().catch(logQuotaHeaderFeedFailure)
      logger.debug('quota', 'harvested response quota', {
        account: served.accountId,
        fiveHourPercent: entry.quota.five_hour?.usedPercent,
        sevenDayPercent: entry.quota.seven_day?.usedPercent,
        source: 'headers',
      })
    } catch (error) {
      warnQuotaNormalizeOnce(error)
    }
  }

  const fallbackManager = new FallbackAccountManager({
    quotaManager,
    setIntervalImpl: runtimeTimers.setInterval,
    clearIntervalImpl: runtimeTimers.clearInterval,
    onFallbackStorageChanged: () => {
      void refreshSidebarQuota().catch(() => {})
    },
  })
  fallbackManager.startBackgroundRefresh()
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

  let latestRefreshMainAccessToken: (() => Promise<string>) | null = null
  const cacheKeepRegistry = new CacheKeepSessionRegistry({
    directory:
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR ||
      getDefaultCacheKeepRegistryDirectory('opencode'),
  })
  let aggregateCacheKeepSessions: ReturnType<
    CacheKeepManager['trackedSessions']
  > = []
  const cacheKeepManager = new CacheKeepManager({
    loadStorage: () => loadAccounts(accountStoragePath),
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
    onResponse: ({ target, bodyText, status, data, receivedAt }) => {
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
    prepareHeaders: async (headers, target) => {
      let accessToken: string | undefined
      const accountId = target.oauthAccountId
      if (accountId && accountId !== 'main') {
        const storage = await loadAccounts(accountStoragePath)
        const account = storage?.accounts.find(
          (candidate): candidate is OAuthAccount =>
            candidate.id === accountId &&
            candidate.enabled !== false &&
            isOAuthAccount(candidate),
        )
        if (!account || !storage) {
          throw new Error(
            `OAuth account ${accountId} is unavailable for cache prewarm`,
          )
        }
        let current = account
        try {
          current = await fallbackManager.refreshAccount(account, storage)
        } catch (error) {
          logger.warn('cachekeep', 'fallback token refresh failed', {
            accountId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        accessToken = current.access
        if (!accessToken) {
          throw new Error(
            `OAuth account ${accountId} has no access token for cache prewarm`,
          )
        }
      } else {
        if (!latestGetAuth) return headers
        const auth = await latestGetAuth()
        if (auth.type !== 'oauth') return headers
        if (!auth.access || (auth.expires && auth.expires < Date.now())) {
          if (!latestRefreshMainAccessToken) return headers
          auth.access = await latestRefreshMainAccessToken()
        }
        accessToken = auth.access
      }
      if (!accessToken) return headers
      try {
        const parsedBody = JSON.parse(target.bodyText) as Record<
          string,
          unknown
        >
        const identity = await resolveClaudeCodeIdentity(
          accessToken,
          typeof parsedBody.model === 'string' ? parsedBody.model : undefined,
          accountId === 'main' ? mainAccountId : accountId,
        )
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
      return headers
    },
  })

  const recoveryWarmChains = new Map<string, Promise<void>>()

  // -- /claude-prime manager: direct OAuth request to start each account's
  // five-hour quota window ~60s after reset, exactly once across concurrent
  // OpenCode processes via atomic marker claim. In-process manager mirrors the
  // cacheKeep singleton shape; cross-process exclusivity is the marker's job.

  // Obtain a CURRENT main access token via the existing refresh path
  // (M2). If the cached auth has no access or the token is expired, refresh
  // first; only fail when the refresh path itself fails. Returns the live
  // token so the fresh-check and the fire path use the same value.
  async function getCurrentMainAccessToken(): Promise<string> {
    if (!latestGetAuth) {
      throw new Error('prime: main auth loader is not available')
    }
    const auth = await latestGetAuth()
    if (auth.type !== 'oauth') {
      throw new Error('prime: main account is not an OAuth account')
    }
    if (auth.access && (!auth.expires || auth.expires > Date.now())) {
      return auth.access
    }
    if (!latestRefreshMainAccessToken) {
      throw new Error('prime: main token refresh unavailable')
    }
    try {
      return await latestRefreshMainAccessToken()
    } catch (error) {
      if (error instanceof Error) {
        ;(
          error as Error & { isPrimeTokenRefresh?: boolean }
        ).isPrimeTokenRefresh = true
      }
      throw error
    }
  }

  async function refreshPrimeMainQuota(): Promise<PrimeRefreshResult> {
    const accessToken = await getCurrentMainAccessToken()
    await resolveMainQuotaAccountIdentity(accessToken)
    const result = await quotaManager.refreshMainWithMetadata(
      mainQuotaAccountId,
      accessToken,
    )
    return { quota: result.quota, fresh: result.fetched }
  }

  async function refreshPrimeFallbackQuota(
    accountId: string,
  ): Promise<PrimeRefreshResult> {
    const storage = await loadAccounts(accountStoragePath)
    const account = storage?.accounts.find(
      (candidate): candidate is OAuthAccount =>
        candidate.id === accountId &&
        candidate.enabled !== false &&
        isOAuthAccount(candidate),
    )
    if (!account || !storage) {
      throw new Error(`prime: OAuth account ${accountId} is unavailable`)
    }
    // Reuse the same fallback-manager refresh path used by the
    // background quota refresh — it persists the refreshed quota to the
    // state file (M1 persist requirement) and is the SINGLE usage-API
    // call per tick for fallback fresh-checks. The redundant
    // `quotaManager.refreshFallback` call was collapsed (R2).
    const refreshed = await fallbackManager.refreshAccountQuota(
      account,
      storage,
    )
    await fallbackManager.save(storage, [accountId])
    if (!refreshed.account.access) {
      throw new Error(`prime: OAuth account ${accountId} has no access token`)
    }
    return {
      quota: refreshed.account.quota ?? {},
      fresh: refreshed.fetched,
    }
  }

  async function sendPrime(
    accountId: 'main' | string,
  ): Promise<PrimeSendResult> {
    const start = performance.now()
    let accessToken: string | undefined
    let resolvedModel: string | undefined
    try {
      if (accountId === 'main') {
        // Use the same refresh path the fresh-check uses, so a missing or
        // expired access token is refreshed BEFORE the request — not used
        // as-is. The previous early-return-on-!auth.access made the
        // refresh arm unreachable (M2).
        try {
          accessToken = await getCurrentMainAccessToken()
        } catch (error) {
          const isTokenRefresh =
            error instanceof Error &&
            (error as Error & { isPrimeTokenRefresh?: boolean })
              .isPrimeTokenRefresh === true
          return {
            ok: false,
            ...(isTokenRefresh && { reason: 'token-refresh' as const }),
            error: error instanceof Error ? error.message : String(error),
          }
        }
        resolvedModel = CLAUDE_HAIKU_4_5_MODEL_ID
      } else {
        const storage = await loadAccounts(accountStoragePath)
        const account = storage?.accounts.find(
          (candidate): candidate is OAuthAccount =>
            candidate.id === accountId &&
            candidate.enabled !== false &&
            isOAuthAccount(candidate),
        )
        if (!account || !storage) {
          return {
            ok: false,
            error: `prime: OAuth account ${accountId} is unavailable`,
          }
        }
        let current = account
        try {
          // R2: the fire path refreshes ONLY the token, not the quota.
          // The fresh-check already performed the single usage-API
          // call and persisted the result; the fire path reuses the
          // in-memory quota via the headers / URL contract. This keeps
          // the cycle at exactly one quota API call per account.
          current = await fallbackManager.refreshAccount(account, storage)
        } catch (error) {
          return {
            ok: false,
            reason: 'token-refresh',
            error: error instanceof Error ? error.message : String(error),
          }
        }
        accessToken = current.access
        resolvedModel = CLAUDE_HAIKU_4_5_MODEL_ID
      }

      if (!accessToken) {
        return { ok: false, error: 'prime: no access token available' }
      }

      const primeBody = buildPrimeRequestBody()
      const identity = await resolveClaudeCodeIdentity(
        accessToken,
        resolvedModel,
        accountId === 'main' ? mainAccountId : accountId,
      )
      const body = await rewriteRequestBody(JSON.stringify(primeBody), {
        identity,
      })
      const headers = new Headers({
        'content-type': 'application/json',
      })
      setOAuthHeaders(headers, accessToken, {
        body: JSON.parse(body),
        identity,
      })
      headers.delete('content-length')
      headers.delete('transfer-encoding')
      // Route through rewriteUrl so the request inherits the canonical
      // ?beta=true query param and ANTHROPIC_BASE_URL overrides like every
      // other direct Anthropic call in this codebase. The URL is rendered
      // back to a string here because the surrounding fetch wrapper and
      // test mocks expect a string input.
      const primeRequest = rewriteUrl(PRIME_MESSAGES_URL, { baseURL: '' })
      const primeUrl =
        primeRequest.url?.toString() ?? primeRequest.input.toString()
      const response = await fetch(primeUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
      })
      const ms = Math.round(performance.now() - start)
      if (!response.ok) {
        const reason =
          (await response.text().catch(() => '')) || `HTTP ${response.status}`
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
      return { ok: true, status: response.status, ms, ...(usage && { usage }) }
    } catch (error) {
      return {
        ok: false,
        ms: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const primeManagerOptions: PrimeManagerOptions = {
    storagePath: accountStoragePath,
    loadStorage: () => loadAccounts(accountStoragePath),
    getAccountFingerprint: async (accountId) => {
      const authLineageId = await getOrCreatePrimeAuthLineageId(
        accountId,
        accountStoragePath,
      )
      return authLineageId ? tokenFingerprint(authLineageId) : undefined
    },
    refreshQuota: async (accountId) => {
      if (accountId === 'main') return refreshPrimeMainQuota()
      return refreshPrimeFallbackQuota(accountId)
    },
    sendPrime,
    recordSuccess: (accountId, usage) =>
      incrementPrimeUsagePersistent(accountId, usage, accountStoragePath),
  }
  const primeManager: PrimeManager = adoptPrimeManager(
    accountStoragePath,
    () => new PrimeManager(primeManagerOptions),
    {
      slot: ctx.directory ?? 'default',
      rebind: (manager) => manager.updateOptions(primeManagerOptions),
    },
  )
  if (isPrimePersistentlyEnabled(initialStorage)) {
    primeManager.start()
  }

  function warmRecoverySourceAfterOpus(context: FableRequestContext) {
    const sessionId = context.plan.sessionId
    const modelLabel = isClaudeOpus5Model(context.plan.requestedModel)
      ? 'Opus 5'
      : 'Fable'
    const run = async () => {
      const target = context.warmTarget
      if (!target) {
        logger.debug('fable-fallback', 'cache warm skipped', {
          session: sessionId,
          reason: 'Opus response was not served by an OAuth route',
        })
        return
      }
      const source = prepareFableCacheWarmSource(
        target.bodyText,
        context.plan.requestedModel,
      )
      if (!source.ok) {
        logger.warn('fable-fallback', 'cache warm skipped', {
          session: sessionId,
          reason: source.reason,
        })
        return
      }

      try {
        const result = await cacheKeepManager.prewarmNow({
          sessionId,
          url: target.url,
          headers: target.headers,
          bodyText: source.bodyText,
          oauthAccountId:
            fableFallbackManager.recoveryAccount(context.plan) ??
            target.oauthAccountId,
        })
        if (result.ok) {
          logger.debug('fable-fallback', `${modelLabel} cache warmed`, {
            session: sessionId,
            remaining: fableFallbackManager.remaining(context.plan),
            ...(result.usage && { usage: result.usage }),
          })
          return
        }
        logger.warn('fable-fallback', `${modelLabel} cache warm skipped`, {
          session: sessionId,
          status: result.status,
          reason: result.reason,
        })
      } catch (error) {
        logger.warn('fable-fallback', `${modelLabel} cache warm failed`, {
          session: sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const { recoveryKey } = context.plan
    const previous = recoveryWarmChains.get(recoveryKey) ?? Promise.resolve()
    const current = previous.then(run, run)
    recoveryWarmChains.set(recoveryKey, current)
    void current.finally(() => {
      if (recoveryWarmChains.get(recoveryKey) === current) {
        recoveryWarmChains.delete(recoveryKey)
      }
    })
    return current
  }

  async function getAllTrackedCacheKeepSessions() {
    aggregateCacheKeepSessions = await cacheKeepRegistry.list(
      cacheKeepManager.trackedSessions(),
    )
    return aggregateCacheKeepSessions
  }

  setCache1hState({
    enabled: isCache1hPersistentlyEnabled(initialStorage),
    mode: getCache1hPersistentMode(initialStorage),
  })
  setDumpEnabled(isDumpPersistentlyEnabled(initialStorage))
  setFastModeEnabled(isFastModePersistentlyEnabled(initialStorage))
  if (!process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL) {
    setLogLevel(getPersistedLogLevel(initialStorage) ?? 'info')
  }

  let rpcServer: RpcServerHandle | null = null
  if (ctx.directory) {
    const rpcGlobal = globalThis as {
      __anthropicAuthRpcServer?: RpcServerHandle
    }
    if (rpcGlobal.__anthropicAuthRpcServer) {
      await rpcGlobal.__anthropicAuthRpcServer.stop().catch(() => {})
      rpcGlobal.__anthropicAuthRpcServer = undefined
    }
    try {
      rpcServer = await startRpcServer({
        dir: getRpcDir(ctx.directory),
        drain: drainNotifications,
        apply: applyCommand,
      })
      rpcGlobal.__anthropicAuthRpcServer = rpcServer
    } catch (error) {
      logger.warn('rpc', 'failed to start', {
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
    routingAuthoritative?: boolean
    useHydratedProfiles?: boolean
    skipFallbackQuotaSeed?: boolean
  }

  function mergeHydratedProfilesForSidebar(
    latest: Awaited<ReturnType<typeof loadAccounts>>,
    hydrated: Awaited<ReturnType<typeof loadAccounts>>,
    mainAccessToken?: string,
  ) {
    if (!latest || !hydrated) return latest
    const merged: AccountStorage = {
      ...latest,
      accounts: latest.accounts.map((account) => {
        const hydratedAccount = hydrated.accounts.find(
          (candidate) => candidate.id === account.id,
        )
        if (
          !isOAuthAccount(account) ||
          !hydratedAccount ||
          !isOAuthAccount(hydratedAccount) ||
          !account.access ||
          hydratedAccount.access !== account.access
        ) {
          return account
        }
        return { ...account, profile: hydratedAccount.profile }
      }),
    }
    const latestMainProfile = latest.main?.profile
    const mainState = latest.main ?? hydrated.main
    if (
      mainAccessToken &&
      mainState &&
      (!latestMainProfile ||
        oauthProfileMatchesIdentity(latestMainProfile, mainAccountId))
    ) {
      merged.main = {
        ...mainState,
        profile: hydrated.main?.profile,
      }
    }
    return merged
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
    return {
      main: {
        quota: mainEntry?.quota ?? null,
        tierLabel: formatOAuthAccountTier(storage?.main?.profile),
        quotaBackedOff: quotaManager.isBackedOff(),
        quotaBackoffUntil: lastApiError?.nextRetryAt,
        refreshBackedOff: mainRefreshError
          ? refreshBackoffActive(
              mainRefreshError,
              mainAccountId ?? storage?.mainAccountId,
              Date.now(),
            )
          : false,
        refreshBackoffUntil: mainRefreshError?.nextRetryAt,
      },
      fallbacks: (storage?.accounts ?? [])
        .filter(
          (account): account is OAuthAccount =>
            account.enabled !== false && isOAuthAccount(account),
        )
        .map((account) => ({
          id: account.id,
          label: account.label,
          tierLabel: formatOAuthAccountTier(account.profile),
          // Token-aware read: if a fallback account was re-logged with the same
          // id/label, an old in-memory quota snapshot must not be shown as the
          // new account's quota.
          quota: options.skipFallbackQuotaSeed
            ? null
            : account.access
              ? (quotaManager.getFallback(account.id, account)?.quota ?? null)
              : null,
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
            ) &&
            isPermanentRefreshError(account.lastRefreshError),
          enabled: account.enabled !== false,
        })),
      activeId: options.activeId,
      route: options.route,
      relay: (() => {
        const currentRelayConfig = getRelayConfig(storage)
        return currentRelayConfig
          ? {
              enabled: true,
              transport: currentRelayConfig.transport ?? 'http',
            }
          : null
      })(),
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
  ) {
    const routingAuthoritative = options.routingAuthoritative !== false
    if (routingAuthoritative) {
      lastSidebarRouting = { activeId: options.activeId, route: options.route }
    }
    const state = buildSidebarState(storage, options)
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
            const displayStorage = options.useHydratedProfiles
              ? mergeHydratedProfilesForSidebar(
                  preservedRouting.freshStorage,
                  storage,
                  options.mainAccessToken,
                )
              : preservedRouting.freshStorage
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

  // Re-write the sidebar using the LAST known routing decision, refreshing only
  // the quota numbers. Used by async quota refreshes (main + background fallback)
  // so they never clobber the active account back to 'main'.
  async function refreshSidebarQuota() {
    const storage = await loadAccounts(accountStoragePath)
    let access: string | undefined
    if (latestGetAuth) {
      try {
        const auth = await latestGetAuth()
        access = auth.access
      } catch {
        // best-effort
      }
    }
    writeSidebarState(storage, {
      activeId: lastSidebarRouting.activeId,
      route: lastSidebarRouting.route,
      mainAccessToken: access,
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
    const accountIdentity =
      mainQuotaIdentity?.accountIdentity ?? mainQuotaAccountId
    if (quotaManager.getMain(accountIdentity)) return
    if (sidebarMainQuotaRefreshInFlight) return

    sidebarMainQuotaRefreshInFlight = true
    void quotaManager
      .refreshMain(accountIdentity, accessToken, mainQuotaIdentity?.generation)
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
  let mainAccountId: string | undefined
  let mainQuotaAccountId: string | undefined
  let mainQuotaIdentityAccessToken: string | undefined
  let mainQuotaIdentityResolutionGeneration = 0
  const mainQuotaIdentityResolutions = new Map<
    string,
    Promise<MainQuotaIdentityResolution>
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

  async function clearStaleMainRefreshError(accountIdentity?: string) {
    if (!accountIdentity) return
    const storage = await loadAccounts(accountStoragePath)
    const error = storage?.refresh?.mainLastRefreshError
    if (!storage?.refresh || !error) return
    if (!error.accountIdentity || error.accountIdentity === accountIdentity)
      return
    storage.refresh.mainLastRefreshError = undefined
    if (!mainQuotaIdentityAccessToken?.startsWith('sk-ant-oat')) {
      const quotaError = storage.quota?.mainLastQuotaApiError
      if (quotaError && quotaError.accountIdentity !== mainQuotaAccountId) {
        const clearedGeneration = quotaManager.clearMainBackoff()
        storage.quota = storage.quota ?? {}
        storage.quota.mainLastQuotaApiError = undefined
        storage.quota.mainQuotaErrorGeneration = Math.max(
          storage.quota.mainQuotaErrorGeneration ?? 0,
          clearedGeneration ?? quotaManager.getMainQuotaErrorGeneration(),
        )
        storage.quota.mainQuotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
          storage.quota.mainQuotaErrorClearedAt,
          quotaManager.getMainQuotaErrorClearedAt() ?? Date.now(),
        )
      }
    }
    await saveAccountState(storage, accountStoragePath, {
      mainRefresh: true,
      ...(!mainQuotaIdentityAccessToken?.startsWith('sk-ant-oat') && {
        mainQuota: true,
      }),
    })
    log(
      '[refresh] opencode main oauth cleared stale backoff after token rotation',
      {
        previousCheckedAt: error.checkedAt,
        previousNextRetryAt: error.nextRetryAt,
        previousRetryCount: error.retryCount,
      },
    )
  }

  async function buildQuotaCommandSummary() {
    const accounts: QuotaAccountSummary[] = []
    let mainAccessToken: string | undefined
    if (latestGetAuth) {
      try {
        const auth = await latestGetAuth()
        if (auth.type === 'oauth' && auth.access) {
          mainAccessToken = auth.access
          await resolveMainQuotaAccountIdentity(auth.access)
          // /claude-quota is a manual action: force a real fetch instead of
          // returning the cache. refreshMain still respects 429 backoff — it
          // returns the last cached snapshot when the API is backed off.
          const quota = await quotaManager.refreshMain(
            mainQuotaAccountId,
            auth.access,
          )
          accounts.push({
            name: 'OpenCode anthropic',
            role: 'main',
            quota,
          })
        } else if (auth.type === 'oauth') {
          accounts.push({
            name: 'OpenCode anthropic',
            role: 'main',
            error:
              'missing access token; send a request first or reconnect auth',
          })
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        accounts.push({
          name: 'OpenCode anthropic',
          role: 'main',
          error: msg.includes('429')
            ? 'Usage API rate limited — try again in a moment'
            : msg,
        })
      }
    }

    // Force a real fallback refresh and PERSIST it to anthropic-auth.json.
    // refreshQuotaForAllAccounts({ force: true }) bypasses the staleness skip,
    // routes through the unified QuotaManager path (429 backoff respected
    // per-account), saves refreshed snapshots, and clears stale errors.
    const { storage, errors } =
      await fallbackManager.refreshQuotaForAllAccounts({ force: true })
    const displayStorage = await ensureProfilesForQuotaDisplay(
      storage ?? createEmptyStorage(),
      mainAccessToken,
      AbortSignal.timeout(3_000),
    )
    const mainSummary = accounts.find((account) => account.role === 'main')
    if (mainSummary) {
      mainSummary.tierLabel = formatOAuthAccountTier(
        displayStorage.main?.profile,
      )
    }
    const errorMap = new Map(errors.map((e) => [e.accountId, e.message]))
    accounts.push(...buildFallbackQuotaSummaries(displayStorage, errorMap))

    if (!latestGetAuth) {
      accounts.unshift({
        name: 'OpenCode anthropic',
        role: 'main',
        error: 'auth loader has not run yet; send a request first',
      })
    }

    return buildClaudeQuotaSummary({ accounts, refreshedAt: Date.now() })
  }

  async function refreshSidebarAfterMutation(
    updatedStorage: AccountStorage | null,
  ) {
    if (latestGetAuth) {
      try {
        const auth = await latestGetAuth()
        await writeSidebarState(updatedStorage, {
          activeId: lastSidebarRouting.activeId,
          route: lastSidebarRouting.route,
          mainAccessToken: auth.access,
          routingAuthoritative: false,
        })
      } catch {
        // auth not yet available — sidebar will refresh on next request
      }
    }
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
      routingAuthoritative: false,
    })

    if (desktopText) queueDesktopNotice(notice.sessionId, desktopText)
  }

  function queueDesktopNotice(sessionId: string, text: string) {
    if (isTuiConnected(sessionId)) return
    // OpenCode's prompt endpoints run revert cleanup before honoring noReply.
    // OpenCode awaits event handlers before it evaluates the loop exit condition.
    // Escape the post-idle session update, then probe outside that critical section.
    const queue = pendingDesktopNotices.get(sessionId) ?? []
    queue.push(text)
    if (queue.length > 4) queue.splice(0, queue.length - 4)
    pendingDesktopNotices.delete(sessionId)
    pendingDesktopNotices.set(sessionId, queue)
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
          const sent = await sendIgnoredMessage(ctx, sessionId, text, {
            noReply: true,
            beforeActiveAssistant: true,
            canSend: () => desktopNoticeSafeSessions.has(sessionId),
          })
          if (!sent) return
          queue.shift()
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
      return executeCache1hCommand({ argumentsText, enabled, mode })
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
      return executeDumpCommand({ argumentsText, enabled })
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
      return executeFastModeCommand({ argumentsText, enabled })
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
      await stickySessionRouter.clear(sessionId)
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
      await setLogLevelPersistent(action.level)
      logger.info('commands', 'log level changed', { level: action.level })
      return executeLoggingCommand({ argumentsText, level: action.level })
    }

    const storage = await loadAccounts(accountStoragePath)
    const level = getPersistedLogLevel(storage) ?? 'info'
    return executeLoggingCommand({ argumentsText, level })
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

    // Publish the new prime section to the sidebar file (M7) so the
    // expanded Prime row appears on `on` and disappears on `off` without
    // waiting for the next quota refresh path. The post-mutation storage
    // IS authoritative; we re-read it so the section payload reflects
    // the freshly persisted flag.
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
  ) {
    const action = parseAccountCommandAction(argumentsText)

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
      await addAccountPersistent(account, accountStoragePath)
      logger.info('commands', 'account added', {
        id: account.id,
        label: account.label,
        type: 'apikey',
      })

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
      const authResult = await authorize('max')
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
        await addAccountPersistent(account, accountStoragePath)
        logger.info('commands', 'account added', {
          id: account.id,
          label: account.label,
          type: 'oauth',
        })

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
          if (auth.type === 'oauth') mainAccessToken = auth.access
        } catch {}
      }
      storage = await ensureProfilesForQuotaDisplay(
        storage,
        mainAccessToken,
        AbortSignal.timeout(3_000),
      )
    }
    const result = executeAccountCommand({
      argumentsText,
      storage: storage ?? { version: 1, accounts: [] },
    })

    if (result.updated) {
      if (
        result.updated.action === 'enable' ||
        result.updated.action === 'disable'
      ) {
        const enabled = result.updated.action === 'enable'
        await setAccountEnabledPersistent(
          result.updated.id,
          enabled,
          accountStoragePath,
        )
        const updatedId = result.updated.id
        const account = storage?.accounts.find((a) => a.id === updatedId)
        logger.info('commands', `account ${result.updated.action}d`, {
          id: updatedId,
          label: account?.label,
          enabled,
        })
      } else if (result.updated.action === 'remove') {
        await removeAccountPersistent(result.updated.id, accountStoragePath)
        const updatedId = result.updated.id
        const account = storage?.accounts.find((a) => a.id === updatedId)
        logger.info('commands', 'account removed', {
          id: updatedId,
          label: account?.label,
        })
      } else if (result.updated.action === 'reorder') {
        await reorderAccountsPersistent(
          result.updated.newOrder ?? result.updated.previousOrder ?? [],
          accountStoragePath,
        )
        const updatedId = result.updated.id
        const account = storage?.accounts.find((a) => a.id === updatedId)
        logger.info('commands', 'account reordered', {
          id: updatedId,
          label: account?.label,
        })
      }

      const updatedStorage = await loadAccounts(accountStoragePath)
      if (latestGetAuth) {
        try {
          const auth = await latestGetAuth()
          writeSidebarState(updatedStorage, {
            activeId: lastSidebarRouting.activeId,
            route: lastSidebarRouting.route,
            mainAccessToken: auth.access,
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
    return { text: result.text, accounts }
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
      const knobs: Record<string, unknown> = {
        accounts: result.accounts,
      }
      if ('knobs' in result && result.knobs) {
        Object.assign(knobs, result.knobs)
      }
      return {
        command,
        text: result.text,
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
      await setKillswitchPersistent(result.updatedConfig)
      if (config.enabled !== result.updatedConfig.enabled) {
        logger.info('commands', 'killswitch changed', {
          enabled: result.updatedConfig.enabled === true,
        })
      }
      if (
        JSON.stringify(config.main) !==
          JSON.stringify(result.updatedConfig.main) ||
        JSON.stringify(config.accounts) !==
          JSON.stringify(result.updatedConfig.accounts)
      ) {
        logger.info('commands', 'killswitch thresholds changed', {
          thresholds:
            result.updatedConfig.main ?? result.updatedConfig.accounts,
        })
      }
    }
    return {
      command,
      text: result.text,
      knobs: { config: getKillswitchConfig(await loadAccounts()), accountIds },
    }
  }

  async function applyCommand(request: ApplyRequest): Promise<ApplyResult> {
    const payload = await buildDialogPayload(
      request.command,
      request.arguments,
      request.sessionId,
    )
    return { text: payload.text, knobs: payload.knobs }
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

  return {
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
        message,
      }: {
        sessionID: string
        message: { id: string }
      },
      output: { headers: Record<string, string> },
    ) => {
      laneStartTracker.markHeaders({
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
          }
          status?: { type?: string }
        }
      }
      const info = value.properties?.info
      const sessionId =
        value.properties?.sessionID ?? info?.sessionID ?? info?.id
      if (!sessionId) return

      if (
        value.type === 'session.status' &&
        value.properties?.status?.type !== 'idle'
      ) {
        desktopNoticeSafeSessions.delete(sessionId)
      }

      if (value.type === 'session.idle') {
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

      if (value.type === 'session.deleted') {
        laneStartTracker.clearSession(sessionId)
        fableRecoveryNotices.delete(sessionId)
        pendingDesktopNotices.delete(sessionId)
        desktopNoticeSafeSessions.delete(sessionId)
        for (const recoveryKey of pendingRecoveryDesktopNotices.keys()) {
          if (recoveryKey.startsWith(`${sessionId}\0`)) {
            pendingRecoveryDesktopNotices.delete(recoveryKey)
          }
        }
        desktopNoticeProbes.delete(sessionId)
      }
    },
    config: async (config: { command?: Record<string, unknown> }) => {
      config.command = {
        ...(config.command ?? {}),
        [CACHE_1H_COMMAND_NAME]: {
          template: CACHE_1H_COMMAND_NAME,
          description:
            'Show or toggle 1-hour Anthropic ephemeral prompt cache TTL.',
        },
        [CLAUDE_ACCOUNT_COMMAND_NAME]: {
          template: CLAUDE_ACCOUNT_COMMAND_NAME,
          description:
            'Manage fallback accounts — list, enable/disable, reorder, remove, or add (API key or OAuth).',
        },
        [CLAUDE_CACHE_KEEP_COMMAND_NAME]: {
          template: CLAUDE_CACHE_KEEP_COMMAND_NAME,
          description:
            'Keep hybrid Claude cache warm always or during a local time window.',
        },
        [CLAUDE_PRIME_COMMAND_NAME]: {
          template: CLAUDE_PRIME_COMMAND_NAME,
          description:
            "Start each OAuth account's five-hour quota window after reset.",
        },
        [CLAUDE_START_COMMAND_NAME]: {
          template: CLAUDE_START_COMMAND_NAME,
          description:
            'Send a billed one-token synthetic turn to warm and renew the current Claude session cache.',
        },

        [CLAUDE_QUOTAS_COMMAND_NAME]: {
          template: CLAUDE_QUOTAS_COMMAND_NAME,
          description:
            'Show current Claude OAuth quota usage for all accounts.',
        },
        [CLAUDE_DUMP_COMMAND_NAME]: {
          template: CLAUDE_DUMP_COMMAND_NAME,
          description:
            'Show or toggle Anthropic request dump capture for debugging.',
        },
        [CLAUDE_FAST_COMMAND_NAME]: {
          template: CLAUDE_FAST_COMMAND_NAME,
          description:
            'Show or toggle Anthropic fast mode for supported Opus models.',
        },
        [CLAUDE_LOGGING_COMMAND_NAME]: {
          template: CLAUDE_LOGGING_COMMAND_NAME,
          description:
            'Show or set the plugin log level (error, warn, info, debug, trace).',
        },
        [CLAUDE_ROUTING_COMMAND_NAME]: {
          template: CLAUDE_ROUTING_COMMAND_NAME,
          description:
            'Show or change Claude account routing: main-first, fallback-first, or sticky-balanced.',
        },
        [KILLSWITCH_COMMAND_NAME]: {
          template: KILLSWITCH_COMMAND_NAME,
          description:
            'Manage killswitch — hard-block requests when quota drops below per-account thresholds.',
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
        const models = applyClaudeOpus5Variants(
          addFableMythos5Models(provider.models),
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
      if (!COMMAND_MODAL_NAMES.includes(input.command as CommandModalName))
        return
      const command = input.command as CommandModalName
      const payload = await buildDialogPayload(
        command,
        input.arguments,
        input.sessionID,
      )
      if (command === 'claude-quota') {
        const cmdStorage = await loadAccounts()
        const cmdAuth = latestGetAuth
          ? await latestGetAuth().catch(() => undefined)
          : undefined
        writeSidebarState(cmdStorage, {
          activeId: lastSidebarRouting.activeId,
          route: lastSidebarRouting.route,
          mainAccessToken: cmdAuth?.access,
          routingAuthoritative: false,
        })
      }
      if (isTuiConnected(input.sessionID)) {
        pushNotification(payload, input.sessionID)
      } else {
        await sendIgnoredMessage(ctx, input.sessionID, payload.text)
      }
      cleanAbort()
    },
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<{
          type: string
          access?: string
          refresh?: string
          expires?: number
        }>,
        _provider: { models: Record<string, { cost: unknown }> },
      ) {
        latestGetAuth = getAuth
        const auth = await getAuth()
        if (auth.type === 'oauth') {
          mainAccountId = await getOrCreateMainAccountId(accountStoragePath)
          if (auth.access) {
            await resolveMainQuotaAccountIdentity(auth.access)
          }
          async function refreshMainAccessToken(rejectedAccess?: string) {
            if (rejectedAccess) {
              const currentAuth = await getAuth()
              if (
                currentAuth.type === 'oauth' &&
                currentAuth.access &&
                currentAuth.access !== rejectedAccess &&
                (!currentAuth.expires || currentAuth.expires > Date.now())
              ) {
                log(
                  '[refresh] opencode main oauth reused concurrently rotated access token',
                  {
                    expiresInMs: currentAuth.expires
                      ? currentAuth.expires - Date.now()
                      : undefined,
                  },
                )
                return currentAuth.access
              }
            }

            let refreshPromise =
              mainAccessRefreshesByStoragePath.get(accountStoragePath)
            if (!refreshPromise) {
              refreshPromise = (async () => {
                const maxRetries = 2
                const baseDelayMs = 500
                let leaseId: string | null = null
                let leaseTokenHash: string | null = null
                let releaseFileLock: (() => Promise<void>) | null = null

                async function updateMainRefreshState(
                  update: (storage: AccountStorage) => void,
                ) {
                  const storage: AccountStorage =
                    (await loadAccounts(accountStoragePath)) ??
                    createEmptyStorage()
                  storage.refresh = storage.refresh ?? {}
                  update(storage)
                  await saveAccountState(storage, accountStoragePath, {
                    mainRefresh: true,
                  })
                }

                async function waitForConcurrentMainRefresh(previous: {
                  access?: string
                  refresh?: string
                  expires?: number
                }) {
                  const deadline = Date.now() + CONCURRENT_MAIN_REFRESH_WAIT_MS
                  while (Date.now() < deadline) {
                    await new Promise((resolve) =>
                      runtimeTimers.setTimeout(
                        resolve,
                        CONCURRENT_MAIN_REFRESH_POLL_BASE_MS +
                          jitterMs(CONCURRENT_MAIN_REFRESH_POLL_BASE_MS),
                      ),
                    )
                    const latest = await getAuth()
                    if (latest.type !== 'oauth' || !latest.access) continue
                    const changed =
                      latest.access !== previous.access ||
                      latest.refresh !== previous.refresh ||
                      (latest.expires ?? 0) > (previous.expires ?? 0) + 60_000
                    if (
                      changed &&
                      (!latest.expires || latest.expires > Date.now())
                    ) {
                      log(
                        '[refresh] opencode main oauth joined concurrent refresh',
                        {
                          expiresInMs: latest.expires
                            ? latest.expires - Date.now()
                            : undefined,
                        },
                      )
                      return latest.access
                    }
                  }
                  return null
                }

                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                  let freshAuth: Awaited<ReturnType<typeof getAuth>> | null =
                    null
                  try {
                    if (attempt > 0) {
                      const delay = baseDelayMs * 2 ** (attempt - 1)
                      await new Promise((resolve) =>
                        runtimeTimers.setTimeout(resolve, delay),
                      )
                    }

                    // Re-read auth to get the latest refresh token.
                    // The outer `auth` snapshot may be stale if tokens
                    // were rotated since the fetch() call was made.
                    freshAuth = await getAuth()

                    if (!freshAuth.refresh) {
                      throw new Error(
                        'Token refresh failed: missing refresh token',
                      )
                    }

                    const storage = await loadAccounts(accountStoragePath)
                    const refreshTokenHash = hashRefreshToken(freshAuth.refresh)
                    const mainError = storage?.refresh?.mainLastRefreshError
                    log('[refresh] opencode main oauth refresh check', {
                      attempt,
                      expiresInMs: freshAuth.expires
                        ? freshAuth.expires - Date.now()
                        : undefined,
                      hasBackoff: Boolean(mainError),
                      backoffActive: mainError
                        ? refreshBackoffActive(
                            mainError,
                            mainAccountId ?? storage?.mainAccountId,
                            Date.now(),
                          )
                        : false,
                      retryCount: mainError?.retryCount,
                      nextRetryAt: mainError?.nextRetryAt,
                    })
                    if (
                      mainError &&
                      refreshBackoffActive(
                        mainError,
                        mainAccountId ?? storage?.mainAccountId,
                        Date.now(),
                      )
                    ) {
                      log(
                        '[refresh] opencode main oauth refresh skipped backoff',
                        {
                          nextRetryAt: mainError.nextRetryAt,
                          retryCount: mainError.retryCount,
                        },
                      )
                      throw new Error(
                        formatRefreshBackoffMessage(mainError, Date.now()),
                      )
                    }
                    if (
                      storage?.refresh?.mainRefreshLeaseUntil &&
                      storage.refresh.mainRefreshLeaseUntil > Date.now() &&
                      storage.refresh.mainRefreshLeaseTokenHash ===
                        refreshTokenHash
                    ) {
                      log(
                        '[refresh] opencode main oauth refresh skipped lease',
                        {
                          leaseUntil: storage.refresh.mainRefreshLeaseUntil,
                        },
                      )
                      const concurrentAccess =
                        await waitForConcurrentMainRefresh(freshAuth)
                      if (concurrentAccess) return concurrentAccess
                      throw new Error(
                        'Claude OAuth refresh is already in progress',
                      )
                    }

                    const fileLock = await acquireRefreshFileLock({
                      name: 'opencode-main-oauth-refresh',
                      ttlMs: 2 * 60_000,
                      renew: true,
                    })
                    if (!fileLock) {
                      log(
                        '[refresh] opencode main oauth refresh skipped file lock',
                      )
                      const concurrentAccess =
                        await waitForConcurrentMainRefresh(freshAuth)
                      if (concurrentAccess) return concurrentAccess
                      throw new Error(
                        'Claude OAuth refresh is already in progress',
                      )
                    }
                    releaseFileLock = fileLock.release

                    leaseId = randomUUID()
                    leaseTokenHash = refreshTokenHash
                    await updateMainRefreshState((nextStorage) => {
                      nextStorage.refresh = nextStorage.refresh ?? {}
                      nextStorage.refresh.mainRefreshLeaseId =
                        leaseId ?? undefined
                      nextStorage.refresh.mainRefreshLeaseUntil =
                        Date.now() + 2 * 60_000
                      nextStorage.refresh.mainRefreshLeaseTokenHash =
                        refreshTokenHash
                    })
                    const latestLease = await loadAccounts(accountStoragePath)
                    log(
                      '[refresh] opencode main oauth refresh lease acquired',
                      {
                        attempt,
                        leaseUntil: Date.now() + 2 * 60_000,
                      },
                    )
                    if (
                      latestLease?.refresh?.mainRefreshLeaseId !== leaseId ||
                      latestLease.refresh.mainRefreshLeaseTokenHash !==
                        refreshTokenHash
                    ) {
                      throw new Error(
                        'Claude OAuth refresh is already in progress',
                      )
                    }

                    log('[refresh] opencode main oauth refresh request start', {
                      attempt,
                    })
                    const refreshed = await refreshClaudeOAuthToken({
                      refreshToken: freshAuth.refresh,
                      // Main OpenCode OAuth already has request-path retry,
                      // persisted backoff, and cross-process serialization here.
                      // Keep the shared helper single-shot in this path so the
                      // two retry layers cannot multiply endpoint pressure.
                      maxRetries: 0,
                    })

                    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
                    await (client as any).auth.set({
                      path: {
                        id: 'anthropic',
                      },
                      body: {
                        type: 'oauth',
                        refresh: refreshed.refresh,
                        access: refreshed.access,
                        expires: refreshed.expires,
                      },
                    })

                    await updateMainRefreshState((storage) => {
                      if (!storage?.refresh) return
                      storage.refresh.mainLastRefreshError = undefined
                      if (storage.refresh.mainRefreshLeaseId === leaseId) {
                        storage.refresh.mainRefreshLeaseId = undefined
                        storage.refresh.mainRefreshLeaseUntil = undefined
                        storage.refresh.mainRefreshLeaseTokenHash = undefined
                      }
                    })

                    log('[refresh] opencode main oauth refresh succeeded', {
                      attempt,
                      expiresInMs: refreshed.expires - Date.now(),
                    })
                    return refreshed.access
                  } catch (error) {
                    const isNetworkError =
                      error instanceof Error &&
                      (error.message.includes('fetch failed') ||
                        ('code' in error &&
                          (error.code === 'ECONNRESET' ||
                            error.code === 'ECONNREFUSED' ||
                            error.code === 'ETIMEDOUT' ||
                            error.code === 'UND_ERR_CONNECT_TIMEOUT')))

                    if (
                      attempt < maxRetries &&
                      (isNetworkError ||
                        (() => {
                          const s = (error as { status?: number }).status
                          return typeof s === 'number' && s >= 500
                        })())
                    ) {
                      continue
                    }

                    log(
                      '[refresh] opencode main oauth refresh attempt failed',
                      {
                        attempt,
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                        transient: isNetworkError,
                      },
                    )

                    const failedRefreshToken = freshAuth?.refresh
                    if (
                      failedRefreshToken &&
                      (error as { isRefreshError?: boolean }).isRefreshError
                    ) {
                      await updateMainRefreshState((storage) => {
                        storage.refresh = storage.refresh ?? {}
                        storage.refresh.mainLastRefreshError =
                          buildRefreshOperationError({
                            error,
                            now: Date.now(),
                            accountIdentity:
                              mainAccountId ?? storage.mainAccountId,
                            previous: storage.refresh.mainLastRefreshError,
                          })
                      })
                    }

                    throw error
                  } finally {
                    if (leaseId) {
                      await updateMainRefreshState((storage) => {
                        if (!storage?.refresh) return
                        if (
                          storage.refresh.mainRefreshLeaseId === leaseId &&
                          storage.refresh.mainRefreshLeaseTokenHash ===
                            leaseTokenHash
                        ) {
                          storage.refresh.mainRefreshLeaseId = undefined
                          storage.refresh.mainRefreshLeaseUntil = undefined
                          storage.refresh.mainRefreshLeaseTokenHash = undefined
                        }
                      }).catch(() => {})
                    }
                    await releaseFileLock?.().catch(() => {})
                  }
                }
                // Unreachable — each iteration either returns or throws.
                // Kept as a TypeScript exhaustiveness guard.
                throw new Error('Token refresh exhausted all retries')
              })()
              mainAccessRefreshesByStoragePath.set(
                accountStoragePath,
                refreshPromise,
              )
            }
            try {
              return await refreshPromise
            } finally {
              if (
                mainAccessRefreshesByStoragePath.get(accountStoragePath) ===
                refreshPromise
              ) {
                mainAccessRefreshesByStoragePath.delete(accountStoragePath)
              }
            }
          }

          latestRefreshMainAccessToken = refreshMainAccessToken

          function startMainBackgroundRefresh() {
            if (mainBackgroundRefreshTimer) {
              runtimeTimers.clearInterval(mainBackgroundRefreshTimer)
              mainBackgroundRefreshTimer = null
            }

            const run = async () => {
              try {
                const storage = await loadAccounts(accountStoragePath)
                if (!mainRefreshEnabled(storage)) return
                const latestAuth = await getAuth()
                if (latestAuth.type !== 'oauth') return
                await clearStaleMainRefreshError(
                  mainAccountId ?? storage?.mainAccountId,
                )
                if (!latestAuth.expires) return
                const expiresInMs = latestAuth.expires - Date.now()
                const refreshBeforeMs = mainRefreshBeforeExpiryMs(storage)
                if (expiresInMs > refreshBeforeMs) {
                  return
                }
                log('[refresh] opencode main oauth background due', {
                  expiresInMs,
                  refreshBeforeMs,
                })
                if (
                  refreshBackoffActive(
                    storage?.refresh?.mainLastRefreshError,
                    mainAccountId ?? storage?.mainAccountId,
                    Date.now(),
                  )
                ) {
                  log(
                    '[refresh] opencode main oauth background skipped backoff',
                    {
                      nextRetryAt:
                        storage?.refresh?.mainLastRefreshError?.nextRetryAt,
                      retryCount:
                        storage?.refresh?.mainLastRefreshError?.retryCount,
                      expiresInMs,
                    },
                  )
                  return
                }
                if (
                  latestAuth.refresh &&
                  storage?.refresh?.mainRefreshLeaseUntil &&
                  storage.refresh.mainRefreshLeaseUntil > Date.now() &&
                  storage.refresh.mainRefreshLeaseTokenHash ===
                    hashRefreshToken(latestAuth.refresh)
                ) {
                  return
                }

                await refreshMainAccessToken()
                const refreshedAuth = await getAuth()
                log('[refresh] opencode main oauth refreshed in background', {
                  newExpiresInMs: refreshedAuth.expires
                    ? refreshedAuth.expires - Date.now()
                    : undefined,
                })
              } catch (error) {
                logger.warn('refresh', 'opencode main oauth refresh failed', {
                  message:
                    error instanceof Error ? error.message : String(error),
                })
              }
            }

            mainBackgroundRefreshTimer = runtimeTimers.setInterval(() => {
              void run()
            }, MAIN_AUTH_REFRESH_TICK_MS +
              jitterMs(MAIN_AUTH_REFRESH_TICK_JITTER_MS))
            if ('unref' in mainBackgroundRefreshTimer) {
              mainBackgroundRefreshTimer.unref()
            }
          }

          startMainBackgroundRefresh()
          quotaManager.seedFallbacksFromAccounts(
            (initialStorage?.accounts ?? []).filter(isOAuthAccount),
          )
          const initialSidebarRouting =
            await resolveInitialSidebarRouting(accountStoragePath)
          await writeSidebarState(initialSidebarRouting.freshStorage, {
            activeId: initialSidebarRouting.activeId,
            route: initialSidebarRouting.route,
            mainAccessToken: auth.access,
            routingAuthoritative: false,
          })
          if (
            process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION !==
            '1'
          ) {
            void ensureProfilesForQuotaDisplay(
              initialStorage ?? createEmptyStorage(),
              auth.access,
            )
              .then((displayStorage) => {
                writeSidebarState(displayStorage, {
                  activeId: 'main',
                  route: 'main',
                  mainAccessToken: auth.access,
                  routingAuthoritative: false,
                  useHydratedProfiles: true,
                })
              })
              .catch(() => {})
          }

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

          function isStreamingRateLimitText(text: string) {
            return (
              text.includes('rate_limit_error') ||
              /exceed your account'?s rate limit/i.test(text)
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
            const decoder = new TextDecoder()
            let text = ''
            let bytes = 0

            while (!text.includes('\n\n') && text.length < 65_536) {
              const { done, value } = await reader.read()
              if (done) break
              chunks.push(value)
              bytes += value.byteLength
              text += decoder.decode(value, { stream: true })
              if (isStreamingRateLimitText(text)) break
            }

            if (isStreamingRateLimitText(text)) {
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
          }

          async function sendWithApiAccount(
            input: string | URL | Request,
            init: RequestInit | undefined,
            account: ApiKeyAccount,
            trace?: PerfTrace,
            route = 'api_fallback',
            currentStorage?: Awaited<ReturnType<typeof loadAccounts>>,
            fableRequest?: FableRequestContext,
          ) {
            void currentStorage
            if (fableRequest?.plan.downgraded) {
              fableRequest.warmTarget = undefined
              fableRequest.opusCacheAnchor = undefined
            }
            const start = nowMs()
            const requestHeaders = mergeHeaders(input, init)
            const directAffinity =
              requestHeaders.get('x-session-affinity') ||
              requestHeaders.get('x-opencode-session')
            const subagentRequest = isSubagentRequest(requestHeaders)
            requestHeaders.delete('x-parent-session-id')
            requestHeaders.delete('x-session-affinity')
            requestHeaders.delete('x-opencode-session')
            let body = init?.body
            let streaming = false
            let dump: DumpHandle | null = null

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
              body = await rewriteRequestBody(body, {
                cache1hEnabled: !subagentRequest && isCache1hEnabled(),
                cache1hMode: getCache1hMode(),
                fastModeEnabled: fastModeRequested,
                perf: (stage, data) =>
                  trace?.mark(`rewrite_body_${stage}`, { route, ...data }),
              })
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
            const rewritten = rewriteUrl(input, { baseURL: account.baseURL })
            const sendStart = nowMs()
            let response: Response
            try {
              response = await fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })
            } catch (error) {
              if (typeof body === 'string') {
                await dumpDirectRequest({
                  affinity: directAffinity,
                  route,
                  error: errorText(error),
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
            mainQuotaIdentity?: MainQuotaIdentityBinding,
          ) {
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
            requestHeaders.delete('x-parent-session-id')
            requestHeaders.delete('x-session-affinity')
            requestHeaders.delete('x-opencode-session')
            let body = init?.body
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
            const identityStart = nowMs()
            const identity = await resolveClaudeCodeIdentity(
              accessToken,
              modelForIdentity,
              oauthAccountId === 'main' ? mainAccountId : oauthAccountId,
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
              body = await rewriteRequestBody(body, {
                cache1hEnabled: cacheEnabled,
                cache1hMode: cacheMode,
                fastModeEnabled: fastModeRequested,
                identity,
                hybridStandbyAnchor: standbyCacheAnchor,
                serverSideFallbackEnabled: fallbackMode === 'server',
                laneStart: laneStartRequest,
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
                setOAuthHeaders(requestHeaders, accessToken, { identity })
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
            const rewritten = rewriteUrl(input)
            if (fableRequest && typeof body === 'string') {
              fableRequest.warmTarget = {
                url: rewritten.url?.toString() ?? rewritten.input.toString(),
                headers: new Headers(requestHeaders),
                bodyText: body,
                oauthAccountId,
              }
            }
            if (
              typeof body === 'string' &&
              isCache1hEnabled() &&
              getCache1hMode() === 'hybrid'
            ) {
              const storage = await getRequestStorage()
              if (!subagentRequest || isCacheKeepSubagentsEnabled(storage)) {
                const cacheKeepStart = nowMs()
                const tracked = cacheKeepManager.track({
                  sessionId: relayAffinity,
                  url: rewritten.url?.toString() ?? rewritten.input.toString(),
                  headers: requestHeaders,
                  bodyText: body,
                  storage,
                  cacheMode: 'hybrid',
                  oauthAccountId,
                  isSubagent: subagentRequest,
                })
                trace?.mark('cachekeep_track', {
                  session: relayAffinity,
                  ms: roundMs(nowMs() - cacheKeepStart),
                  tracked: tracked.tracked,
                  reason: tracked.tracked ? undefined : tracked.reason,
                  bodyBytes: body.length,
                })
              }
            }

            let usedDirectFetch = false
            const directFetch = async () => {
              usedDirectFetch = true
              try {
                const response = await fetch(rewritten.input, {
                  ...init,
                  body,
                  headers: requestHeaders,
                  ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                })
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
              } catch (error) {
                if (typeof body === 'string') {
                  await dumpDirectRequest({
                    affinity: relayAffinity,
                    route,
                    error: errorText(error),
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

            const relayConfig = getRelayConfig(await getRequestStorage())
            const served = {
              accountId: oauthAccountId,
              accessToken,
              authLineageId: fallbackAuthLineageId,
              ...(oauthAccountId === 'main' && mainQuotaIdentity
                ? { mainQuotaIdentity }
                : {}),
            }
            const sendStart = nowMs()
            const response = await sendViaRelay({
              config: relayConfig,
              input: rewritten.input,
              init,
              headers: requestHeaders,
              body,
              fallback: directFetch,
              affinity: relayAffinity,
              optimisticResponse: relayConfig?.transport === 'websocket',
              onResponseHeaders: (headers) =>
                harvestQuotaHeaders(headers, served),
              onDumpCreated: (handle) => {
                relayDump = handle
              },
              dumpTag: laneStartRequest ? 'start' : undefined,
            })
            trace?.mark('send_headers_received', {
              route,
              ms: roundMs(nowMs() - sendStart),
              status: response.status,
              relayConfigured: relayConfig != null,
              totalSendWithAccessMs: roundMs(nowMs() - start),
            })

            if (usedDirectFetch) harvestQuotaHeaders(response.headers, served)
            attachCacheDiagnosticsResponse(response, {
              source: laneStartRequest ? 'start' : 'turn',
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
            return response
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

          // The fallbacks routing may actually send to: usable accounts that
          // also pass the killswitch policy. Every fallback-selection path
          // (fallback-first, soft-quota skip-main, the killswitch gate, reactive
          // retries) must go through this so the killswitch is a hard block on
          // ALL routes — a killswitch-killed account must never serve a request,
          // even if it still passes the softer routing quota policy.
          function quotaSnapshotIsExhausted(
            quota: OAuthQuotaSnapshot | null | undefined,
          ) {
            return (['five_hour', 'seven_day'] as const).some(
              (key) => (quota?.[key]?.remainingPercent ?? 1) <= 0,
            )
          }

          function responseShowsMainQuotaExhausted(
            response: Response,
            streamingRateLimited: boolean,
          ) {
            return response.status === 429 || streamingRateLimited
          }

          function mainQuotaEntryIsFreshExhausted(
            accessToken?: string,
            mainQuotaIdentity?: MainQuotaIdentityBinding,
          ) {
            if (!accessToken) return false
            const entry = quotaManager.getMain(
              mainQuotaIdentity?.accountIdentity ?? mainQuotaAccountId,
            )
            // A genuine response header is live routing evidence like a 429, but
            // it gets no exemption from the shared freshness and token gates.
            return Boolean(
              entry &&
                entry.refreshAfter > Date.now() &&
                quotaSnapshotIsExhausted(entry.quota),
            )
          }

          async function refreshMainQuotaConfirmsExhausted(
            accessToken?: string,
            mainQuotaIdentity?: MainQuotaIdentityBinding,
          ) {
            if (!accessToken) return false
            try {
              await quotaManager.refreshMain(
                mainQuotaIdentity?.accountIdentity ?? mainQuotaAccountId,
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

          async function getRoutableFallbackAccounts(
            storageArg: Awaited<ReturnType<typeof loadAccounts>>,
            options: { includeApiRoutes?: boolean; modelId?: string } = {},
          ): Promise<Array<OAuthAccount | ApiKeyAccount>> {
            const usableOAuth = await fallbackManager.getUsableFallbackAccounts(
              storageArg,
              { modelId: options.modelId },
            )
            const usableOAuthById = new Map(
              usableOAuth.map((account) => [account.id, account]),
            )
            const usable: Array<OAuthAccount | ApiKeyAccount> = []
            for (const account of storageArg?.accounts ?? []) {
              if (isOAuthAccount(account)) {
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
                account.enabled !== false &&
                account.apiKey &&
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
            requestedModelId?: string
            mainQuotaIdentity?: MainQuotaIdentityBinding
          }) {
            const mainQuotaIdentity = input.mainQuotaIdentity?.accountIdentity
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
                )
              } catch {}
            }
            const usableFallbacks =
              await fallbackManager.getUsableFallbackAccounts(input.storage, {
                modelId: input.requestedModelId,
              })
            const latestStorage =
              (await loadAccounts(accountStoragePath)) ?? input.storage
            const usableById = new Map(
              usableFallbacks.map((account) => [account.id, account]),
            )
            const allRoutes: StickyOAuthRoute[] = []
            if (
              !isPermanentRefreshError(
                latestStorage?.refresh?.mainLastRefreshError,
              )
            ) {
              allRoutes.push({
                id: STICKY_ROUTING_MAIN_ACCOUNT_ID,
                access: input.mainAccessToken,
                quota: mainQuota,
                identity: mainAccountId
                  ? { kind: 'known', accountId: mainAccountId }
                  : { kind: 'unknown' },
                order: 0,
              })
            }
            for (const [index, stored] of (
              latestStorage?.accounts ?? []
            ).entries()) {
              if (stored.enabled === false || !isOAuthAccount(stored)) continue
              const account = usableById.get(stored.id) ?? stored
              if (
                !account.access ||
                isPermanentRefreshError(account.lastRefreshError)
              )
                continue
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
                    account.access,
                    account,
                  )
                } catch {}
              }
              allRoutes.push({
                id: account.id,
                access: account.access,
                quota: accountQuota,
                identity: { kind: 'known', accountId: account.id },
                order: index + 1,
                account,
              })
            }

            const retainAccountIds = new Set(
              allRoutes.flatMap((route) => {
                const refreshError =
                  route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                    ? latestStorage?.refresh?.mainLastRefreshError
                    : route.account?.lastRefreshError
                const accountIdentity =
                  route.identity.kind === 'known'
                    ? route.identity.accountId
                    : undefined
                if (isPermanentRefreshError(refreshError)) return []
                if (
                  refreshBackoffActive(
                    refreshError,
                    accountIdentity,
                    Date.now(),
                  )
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
            const usableIds = new Set(
              usableFallbacks.map((account) => account.id),
            )
            const candidates: StickyRouteCandidate[] = allRoutes.flatMap(
              (route) => {
                const refreshError =
                  route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                    ? latestStorage?.refresh?.mainLastRefreshError
                    : route.account?.lastRefreshError
                const accountIdentity =
                  route.identity.kind === 'known'
                    ? route.identity.accountId
                    : undefined
                if (
                  isPermanentRefreshError(refreshError) ||
                  refreshBackoffActive(
                    refreshError,
                    accountIdentity,
                    Date.now(),
                  )
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
            await currentResponse?.body?.cancel().catch(() => {})
            let lastResponse: Response | null = currentResponse ?? null

            for (const [index, account] of accounts.entries()) {
              let response: Response
              if (isApiKeyAccount(account)) {
                if (!account.apiKey) continue
                response = await sendWithApiAccount(
                  input,
                  init,
                  account,
                  trace,
                  `api_fallback_${index}`,
                  storage,
                  options?.fableRequest,
                )
              } else {
                const access = account.access
                if (!access) continue
                response = await sendWithAccessToken(
                  input,
                  init,
                  access,
                  trace,
                  `fallback_${index}`,
                  storage,
                  account.id,
                  account.authLineageId,
                  options?.fableRequest,
                  options?.laneStartRequest,
                )
              }
              lastResponse = response
              let fallbackAgain = shouldFallbackStatus(response.status, storage)
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
                await fallbackManager.markUsed(account)
                await options?.onSuccess?.(account)
                // Active-route every-N refresh: this fallback just served the
                // request, so keep its quota fresh on the same cadence as main.
                // Non-blocking; only the served account, never idle fallbacks.
                if (
                  isOAuthAccount(account) &&
                  account.access &&
                  quotaManager.shouldRefreshOnRequestCount(sessionRequestCount)
                ) {
                  void quotaManager
                    .refreshFallback(account.id, account.access, account)
                    .then(() => options?.onSuccess?.(account))
                    .catch(() => {})
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
                account.enabled !== false &&
                (isOAuthAccount(account) ||
                  (isApiKeyAccount(account) &&
                    Boolean(account.apiKey) &&
                    isValidApiBaseURL(account.baseURL))),
            )
            if (!hasPotentialFallbackRoute) return mainResponse

            let currentResponse = mainResponse
            let shouldFallback = shouldFallbackStatus(
              currentResponse.status,
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
                  fableRequest,
                  laneStartRequest,
                },
              )) ?? currentResponse
            )
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const incomingHeaders = mergeHeaders(input, init)
              const laneStartRequest =
                incomingHeaders.get(LANE_START_REQUEST_HEADER) === '1'
              incomingHeaders.delete(LANE_START_REQUEST_HEADER)
              init = { ...init, headers: incomingHeaders }
              const sessionId =
                incomingHeaders.get('x-session-affinity') ||
                incomingHeaders.get('x-opencode-session')
              const requestModel = parseRequestModel(init?.body)
              let fablePlan = fableFallbackManager.plan(sessionId, init?.body)
              if (fablePlan && !fablePlan.downgraded) {
                const finalWarm = recoveryWarmChains.get(fablePlan.recoveryKey)
                if (finalWarm) {
                  await finalWarm
                  fablePlan = fableFallbackManager.plan(sessionId, init?.body)
                }
              }
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
                          if (!fableRequest?.warmTarget) {
                            logger.debug(
                              'fable-fallback',
                              'content filter recovery unavailable for non-OAuth route',
                              { session: fablePlan.sessionId },
                            )
                            return false
                          }
                          const remaining = fableFallbackManager.activate(
                            fablePlan,
                            fableRequest.warmTarget.oauthAccountId,
                          )
                          pendingRecoveryDesktopNotices.delete(
                            fablePlan.recoveryKey,
                          )
                          pendingRecoveryDesktopNotices.set(
                            fablePlan.recoveryKey,
                            buildSwitchedToOpusNotice(fablePlan.requestedModel),
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
                  ...(fablePlan?.downgraded && fableRequest
                    ? {
                        onComplete: (finishReason: string) => {
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
                          const warm = warmRecoverySourceAfterOpus(fableRequest)
                          if (completed.remaining === 0) {
                            const notifyRestored = () => {
                              if (
                                fableFallbackManager.remaining(fablePlan) !== 0
                              )
                                return
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
                            void warm.then(notifyRestored, notifyRestored)
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
                              ) =>
                                observeServerFallbackOutcome(
                                  fablePlan,
                                  outcome,
                                  storage,
                                  auth,
                                ),
                            }
                          : {}),
                      }
                    : {}),
                })
              }
              const authStart = nowMs()
              const auth = await getAuth()
              trace.mark('get_auth', {
                ms: roundMs(nowMs() - authStart),
                authType: auth.type,
                hasAccess: Boolean(auth.access),
              })
              if (auth.type !== 'oauth') {
                const response = await fetch(input, init)
                trace.done('non_oauth_passthrough', { status: response.status })
                return response
              }
              let requestMainQuotaIdentity: MainQuotaIdentityBinding | undefined
              if (auth.access) {
                const resolution = await resolveMainQuotaAccountIdentity(
                  auth.access,
                  parseRequestModel(init?.body),
                )
                if (resolution.stale) {
                  throw new Error(
                    'Main OAuth identity changed while resolving request credentials',
                  )
                }
                requestMainQuotaIdentity = resolution
              }
              await clearStaleMainRefreshError(mainAccountId)
              const loadStart = nowMs()
              const storage = await loadAccounts()
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
                !fablePlan ||
                (fallbackMode === 'server' &&
                  visibleRecovery?.requestedModelId &&
                  recoverableRefusalFamily(visibleRecovery.requestedModelId) !==
                    recoverableRefusalFamily(fablePlan.requestedModel))
              ) {
                clearFableRecoveryNotice(sessionId, storage, auth)
              }
              const replayableRequest = isReplayableRequest(input, init?.body)
              const requestModelId = parseRequestModel(init?.body)
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
              const writeCurrentSidebarState = async (
                activeId: string | undefined,
                route: string,
              ) => {
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
                getRoutingMode(storage) === 'sticky-balanced' &&
                auth.access
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
                    requestedModelId: routingModelId,
                    mainQuotaIdentity: requestMainQuotaIdentity,
                  })
                  const resolveRoute = (excludeAccountIds?: Set<string>) =>
                    stickySessionRouter.resolve({
                      sessionId,
                      family,
                      modelId: routingModelId,
                      candidates: stickyRoutes.candidates,
                      retainAccountIds: stickyRoutes.retainAccountIds,
                      storage: stickyRoutes.storage,
                      inputBytes:
                        typeof init?.body === 'string'
                          ? Buffer.byteLength(init.body)
                          : 1,
                      preferredAccountId,
                      excludeAccountIds,
                    })
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
                  if (!resolution && incompleteQuotaPool) {
                    throw new Error(
                      'Sticky-balanced routing is waiting for current OAuth quota snapshots',
                    )
                  }
                  if (!resolution) {
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
                      logger.info(
                        'fable-fallback',
                        'rebound recovery to migrated sticky account',
                        { accountId: route.id },
                      )
                    }
                    const sendRoute = (selected: StickyOAuthRoute) =>
                      sendWithAccessToken(
                        input,
                        init,
                        selected.access,
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
                    const completeRoute = async (
                      selected: StickyOAuthRoute,
                      response: Response,
                      markUsed = true,
                    ) => {
                      if (markUsed && selected.account) {
                        await fallbackManager.markUsed(selected.account)
                      }
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
                      let routeFailure = shouldFallbackStatus(
                        response.status,
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
                                  'Sticky OAuth account five-hour quota resets shortly; retaining session affinity.',
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

                    let inspected = await inspectResponse(
                      await sendRoute(route),
                    )
                    let permanentAuthFailure = false
                    if (!inspected.routeFailure) {
                      return completeRoute(route, inspected.response)
                    }

                    if (inspected.response.status === 401) {
                      const authRouteId = route.id
                      try {
                        if (authRouteId === STICKY_ROUTING_MAIN_ACCOUNT_ID) {
                          auth.access = await refreshMainAccessToken(
                            route.access,
                          )
                          route = { ...route, access: auth.access }
                        } else if (route.account && stickyRoutes.storage) {
                          const refreshed =
                            await fallbackManager.refreshAccount(
                              route.account,
                              stickyRoutes.storage,
                              { force: true },
                            )
                          if (refreshed.access) {
                            route = {
                              ...route,
                              access: refreshed.access,
                              account: refreshed,
                            }
                          }
                        }
                        await inspected.response.body?.cancel().catch(() => {})
                        inspected = await inspectResponse(
                          await sendRoute(route),
                        )
                        if (!inspected.routeFailure) {
                          return completeRoute(route, inspected.response)
                        }
                        permanentAuthFailure = inspected.response.status === 401
                      } catch (error) {
                        const latest = await loadAccounts(accountStoragePath)
                        const refreshError =
                          authRouteId === STICKY_ROUTING_MAIN_ACCOUNT_ID
                            ? latest?.refresh?.mainLastRefreshError
                            : latest?.accounts.find(
                                (account): account is OAuthAccount =>
                                  account.id === authRouteId &&
                                  isOAuthAccount(account),
                              )?.lastRefreshError
                        if (!isPermanentRefreshError(refreshError)) throw error
                        permanentAuthFailure = true
                      }
                    }

                    let migrate =
                      inspected.response.status === 403 || permanentAuthFailure
                    if (
                      inspected.response.status === 429 ||
                      inspected.streamingRateLimit
                    ) {
                      let quota: OAuthQuotaSnapshot | undefined
                      try {
                        quota =
                          route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
                            ? await quotaManager.refreshMain(
                                requestMainQuotaIdentity?.accountIdentity,
                                route.access,
                                requestMainQuotaIdentity?.generation,
                              )
                            : await quotaManager.refreshFallback(
                                route.id,
                                route.access,
                                route.account,
                              )
                      } catch {
                        // A model 429 plus a failed quota probe is not enough to
                        // break session affinity. Migrate only from fresh quota.
                        quota = undefined
                      }
                      const decision = decideStickyQuotaFailure({
                        quota,
                        modelId: routingModelId,
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
                      migrate = decision.action === 'migrate'
                    }

                    if (migrate) {
                      const failedRouteId = route.id
                      stickyRoutes = await buildStickyOAuthRoutes({
                        storage: stickyRoutes.storage,
                        mainAccessToken: auth.access,
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
                          if (fablePlan?.downgraded) {
                            fableFallbackManager.bindRecoveryAccount(
                              fablePlan,
                              route.id,
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
                  if (stickyRouteSelected) throw error
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
                }
              }

              if (!auth.access || !auth.expires || auth.expires < Date.now()) {
                // Check backoff before attempting refresh — avoids noisy
                // per-request retries during prolonged rate limits
                const refreshStorage = await loadAccounts()
                const mainRefreshError =
                  refreshStorage?.refresh?.mainLastRefreshError
                if (
                  mainRefreshError &&
                  refreshBackoffActive(
                    mainRefreshError,
                    mainAccountId ?? refreshStorage?.mainAccountId,
                    Date.now(),
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
                auth.access = await refreshMainAccessToken()
                trace.mark('refresh_main_access', {
                  ms: roundMs(nowMs() - refreshStart),
                })
              }

              if (!auth.access) {
                trace.done('missing_access_error')
                throw new Error('OAuth access token is missing after refresh')
              }
              /** Show quota toast from current QuotaManager state. */
              function showQuotaToastFromCache() {
                if (storage?.quota?.showToasts !== true) return
                const mainEntry = quotaManager.getMain(
                  requestMainQuotaIdentity?.accountIdentity,
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
                  let routingQuotaEntry = quotaManager.getMain(
                    requestMainQuotaIdentity?.accountIdentity,
                  )
                  let routingQuota = routingQuotaEntry?.quota
                  if (!routingQuota) {
                    routingQuota = await quotaManager.refreshMain(
                      requestMainQuotaIdentity?.accountIdentity,
                      auth.access,
                      requestMainQuotaIdentity?.generation,
                    )
                    routingQuotaEntry = quotaManager.getMain(
                      requestMainQuotaIdentity?.accountIdentity,
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
                        requestMainQuotaIdentity?.accountIdentity,
                        auth.access,
                        requestMainQuotaIdentity?.generation,
                      )
                      routingQuotaEntry = quotaManager.getMain(
                        requestMainQuotaIdentity?.accountIdentity,
                      )
                    } else {
                      // Stale OR every-N request boundary — background refresh,
                      // return current snapshot to avoid blocking. Refresh the
                      // sidebar and show the toast once the new main quota lands.
                      void quotaManager
                        .refreshMain(
                          requestMainQuotaIdentity?.accountIdentity,
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
                  // Main quota checks should optimize routing, not break requests.
                }
              }

              let mainQuota = quotaManager.getMain(
                requestMainQuotaIdentity?.accountIdentity,
              )?.quota
              if (
                storage?.quota?.failClosedOnUnknownQuota &&
                !mainQuota &&
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
                    const fallbackAccts = (storage?.accounts ?? []).filter(
                      (a): a is OAuthAccount =>
                        a.enabled !== false &&
                        isOAuthAccount(a) &&
                        Boolean(a.access),
                    )
                    await Promise.all([
                      quotaManager.refreshMain(
                        requestMainQuotaIdentity?.accountIdentity,
                        auth.access,
                        requestMainQuotaIdentity?.generation,
                      ),
                      quotaManager.refreshAllFallbacks(fallbackAccts),
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
                mainQuota = quotaManager.getMain(
                  requestMainQuotaIdentity?.accountIdentity,
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
                      a.enabled !== false && isOAuthAccount(a),
                  )
                  .map((a) => ({ ...a, quota: getFallbackQuota(a) }))
                // Decide whether the block is scoped-driven (request's
                // model matches a scoped window that is at/below the scoped
                // threshold) vs a whole-account 5h/7d-driven block. A
                // healthy Fable window + 5h/7d breach is NOT scoped-driven.
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
          }
        }

        return {}
      },
      dispose: async () => {
        await quotaHeaderFeedRegistry?.dispose()
      },
      methods: [
        {
          label: 'Claude Pro/Max',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                return exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
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
                const apiKey = await fetch(
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
      ],
    },
    __primeManager: primeManager,
    __quotaManager: quotaManager,
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}

export const AnthropicAuthPlugin: Plugin = anthropicAuthPlugin
