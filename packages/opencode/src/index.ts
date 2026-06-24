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
  buildRefreshOperationError,
  CACHE_1H_COMMAND_NAME,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CLAUDE_ACCOUNT_COMMAND_NAME,
  CLAUDE_CACHE_KEEP_COMMAND_NAME,
  CLAUDE_DUMP_COMMAND_NAME,
  CLAUDE_FABLE_MYTHOS_5_CONTEXT_WINDOW,
  CLAUDE_FABLE_MYTHOS_5_MAX_OUTPUT_TOKENS,
  CLAUDE_FABLE_MYTHOS_5_MODEL_SPECS,
  CLAUDE_FABLE_MYTHOS_5_PRICING,
  CLAUDE_FABLE_MYTHOS_5_RELEASE_DATE,
  CLAUDE_FAST_COMMAND_NAME,
  CLAUDE_LOGGING_COMMAND_NAME,
  CLAUDE_QUOTAS_COMMAND_NAME,
  CLAUDE_ROUTING_COMMAND_NAME,
  createEmptyStorage,
  dumpDirectRequest,
  exchange,
  executeAccountCommand,
  executeCache1hCommand,
  executeCacheKeepCommand,
  executeDumpCommand,
  executeFastModeCommand,
  executeKillswitchCommand,
  executeLoggingCommand,
  executeRoutingCommand,
  FallbackAccountManager,
  formatQuotaBackoffMessage,
  formatRefreshBackoffMessage,
  getAccountStoragePath,
  getCache1hMode,
  getCache1hPersistentMode,
  getCacheKeepWindow,
  getKillswitchConfig,
  getPersistedLogLevel,
  getPersistedMainQuota,
  getQuotaNextRefreshAt,
  getRelayConfig,
  getRoutingMode,
  hashRefreshToken,
  isApiKeyAccount,
  isCache1hEnabled,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isCacheKeepSubagentsEnabled,
  isCostZeroingEnabled,
  isDumpPersistentlyEnabled,
  isFastModeEnabled,
  isFastModePersistentlyEnabled,
  isFastModeSupportedModel,
  isKillswitchEnabled,
  isOAuthAccount,
  isValidApiBaseURL,
  KILLSWITCH_COMMAND_NAME,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  loadAccounts,
  log,
  logger,
  mergeAnthropicBetas,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  PARALLEL_TOOL_CALLS_SYSTEM_PROMPT,
  parseAccountCommandAction,
  parseCache1hCommandAction,
  parseCacheKeepCommandAction,
  parseDumpCommandAction,
  parseFastModeCommandAction,
  parseLoggingCommandAction,
  parseRoutingCommandAction,
  type QuotaAccountSummary,
  QuotaManager,
  quotaSnapshotPassesPolicy,
  refreshBackoffActive,
  refreshClaudeOAuthToken,
  removeAccountPersistent,
  reorderAccountsPersistent,
  resolveClaudeCodeIdentity,
  saveAccountState,
  sendViaRelay,
  setAccountEnabledPersistent,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCache1hState,
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
  setRoutingMode,
  shouldFallbackStatus,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode-ai/plugin'
import { resolvePromptContext } from './prompt-context.ts'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
} from './rpc/notifications.ts'
import type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  OpenDialogPayload,
} from './rpc/protocol.ts'
import { getRpcDir } from './rpc/rpc-dir.ts'
import { type RpcServerHandle, startRpcServer } from './rpc/rpc-server.ts'
import {
  getSidebarStateFile,
  type SidebarState,
  setSidebarState,
} from './sidebar-state.ts'
import {
  addFastModeBetaHeader,
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const HANDLED_SENTINEL = '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__'
const MAIN_AUTH_REFRESH_TICK_MS = 60_000
const MAIN_AUTH_REFRESH_TICK_JITTER_MS = 60_000
const CONCURRENT_MAIN_REFRESH_WAIT_MS = 5_000
const CONCURRENT_MAIN_REFRESH_POLL_BASE_MS = 200
const MIN_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES = 240
const DEFAULT_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES =
  MIN_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES

type NotificationRequest = {
  path: { id: string }
  body: {
    noReply: true
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
}

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

async function sendIgnoredMessage(
  ctx: Parameters<Plugin>[0],
  sessionId: string,
  text: string,
) {
  const session = ctx.client.session as PluginSessionClient | undefined
  const promptContext = await resolvePromptContext(ctx.client, sessionId)
  const request: NotificationRequest = {
    path: { id: sessionId },
    body: {
      noReply: true,
      parts: [{ type: 'text', text, ignored: true }],
    },
  }
  if (promptContext?.agent) request.body.agent = promptContext.agent
  if (promptContext?.model) request.body.model = promptContext.model
  if (promptContext?.variant) request.body.variant = promptContext.variant

  if (typeof session?.promptAsync === 'function') {
    await session.promptAsync(request)
    return
  }

  if (typeof session?.prompt === 'function') {
    await Promise.resolve(session.prompt(request))
    return
  }

  throw new Error(
    'OpenCode session prompt API is unavailable for ignored replies.',
  )
}

function _throwHandledSentinel(): never {
  throw new Error(HANDLED_SENTINEL)
}

function cleanAbort(): never {
  throw new Error(HANDLED_SENTINEL)
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

export const AnthropicAuthPlugin: Plugin = async (ctx) => {
  startEventLoopLagMonitor()
  const { client } = ctx
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
  const quotaManager = new QuotaManager({
    storage: initialStorage,
    onMainQuotaFetched: async (
      quota,
      checkedAt,
      tokenFingerprint,
      fetchStartedAt,
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
          quotaManager.seedMainFromStorage(storage)
          return
        }
        storage.quota = storage.quota ?? {}
        storage.quota.mainQuota = quota
        storage.quota.mainQuotaCheckedAt = checkedAt
        storage.quota.mainQuotaToken = tokenFingerprint
        storage.quota.mainLastQuotaApiError = undefined
        await saveAccountState(storage, accountStoragePath, { mainQuota: true })
      } catch (error) {
        logger.warn('quota', 'failed to persist main quota', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    onApiError: async (error) => {
      try {
        const storage =
          (await loadAccounts(accountStoragePath)) ?? createEmptyStorage()
        storage.quota = storage.quota ?? {}
        storage.quota.mainLastQuotaApiError = error
        await saveAccountState(storage, accountStoragePath, { mainQuota: true })
      } catch (e) {
        logger.warn('quota', 'failed to persist backoff state', {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    },
  })
  const fallbackManager = new FallbackAccountManager({
    quotaManager,
    onFallbackStorageChanged: () => {
      void refreshSidebarQuota().catch(() => {})
    },
  })
  fallbackManager.startBackgroundRefresh()
  let latestRefreshMainAccessToken: (() => Promise<string>) | null = null
  const cacheKeepManager = new CacheKeepManager({
    loadStorage: () => loadAccounts(accountStoragePath),
    prepareHeaders: async (headers, target) => {
      if (!latestGetAuth) return headers
      const auth = await latestGetAuth()
      if (auth.type !== 'oauth') return headers
      if (!auth.access || (auth.expires && auth.expires < Date.now())) {
        if (!latestRefreshMainAccessToken) return headers
        auth.access = await latestRefreshMainAccessToken()
      }
      if (!auth.access) return headers
      try {
        const parsedBody = JSON.parse(target.bodyText) as Record<
          string,
          unknown
        >
        const identity = await resolveClaudeCodeIdentity(
          auth.access,
          typeof parsedBody.model === 'string' ? parsedBody.model : undefined,
        )
        headers.delete('anthropic-beta')
        setOAuthHeaders(headers, auth.access, {
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
      } catch {
        setOAuthHeaders(headers, auth.access)
      }
      return headers
    },
  })
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

  function writeSidebarState(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
    options: {
      activeId?: string
      route: string
      mainAccessToken?: string
      mainRefreshToken?: string
    },
  ) {
    lastSidebarRouting = { activeId: options.activeId, route: options.route }
    quotaManager.updateStorage(storage)
    quotaManager.seedMainFromStorage(storage, options.mainAccessToken)
    quotaManager.seedFallbacksFromAccounts(
      (storage?.accounts ?? []).filter(isOAuthAccount),
    )
    const mainEntry = quotaManager.getMain(options.mainAccessToken)
    const lastApiError = quotaManager.getLastApiError()
    const mainRefreshError = storage?.refresh?.mainLastRefreshError
    const state: SidebarState = {
      main: {
        quota: mainEntry?.quota ?? null,
        quotaBackedOff: quotaManager.isBackedOff(),
        quotaBackoffUntil: lastApiError?.nextRetryAt,
        refreshBackedOff: mainRefreshError
          ? refreshBackoffActive(
              mainRefreshError,
              options.mainRefreshToken,
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
          // Token-aware read: if a fallback account was re-logged with the same
          // id/label, an old in-memory quota snapshot must not be shown as the
          // new account's quota.
          quota: account.access
            ? (quotaManager.getFallback(account.id, account.access)?.quota ??
              null)
            : null,
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
        window:
          storage?.cacheKeep?.startHour != null &&
          storage?.cacheKeep?.endHour != null
            ? `${storage.cacheKeep.startHour}-${storage.cacheKeep.endHour}`
            : undefined,
        trackedSessions: cacheKeepManager.trackedCount(),
      },
      lastUpdated: Date.now(),
    }
    return setSidebarState(state, sidebarStateFile).catch((error) =>
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
    let refresh: string | undefined
    if (latestGetAuth) {
      try {
        const auth = await latestGetAuth()
        access = auth.access
        refresh = auth.refresh
      } catch {
        // best-effort
      }
    }
    writeSidebarState(storage, {
      activeId: lastSidebarRouting.activeId,
      route: lastSidebarRouting.route,
      mainAccessToken: access,
      mainRefreshToken: refresh,
    })
  }

  function scheduleSidebarMainQuotaRefresh(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
    accessToken: string | undefined,
  ) {
    if (!accessToken) return
    if (storage?.quota?.enabled !== true) return
    if (quotaManager.getMain(accessToken)) return
    if (sidebarMainQuotaRefreshInFlight) return

    sidebarMainQuotaRefreshInFlight = true
    void quotaManager
      .refreshMain(accessToken)
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

  async function clearStaleMainRefreshError(refreshToken?: string) {
    if (!refreshToken) return
    const storage = await loadAccounts(accountStoragePath)
    const error = storage?.refresh?.mainLastRefreshError
    if (!storage?.refresh || !error?.tokenHash) return
    const tokenHash = hashRefreshToken(refreshToken)
    if (error.tokenHash === tokenHash) return
    // Don't clear backoff if the error is still within its retry window —
    // a new token (from another process) doesn't mean the rate limit is gone.
    if (error.nextRetryAt && error.nextRetryAt > Date.now()) {
      log(
        '[refresh] opencode main oauth keeping backoff despite token rotation',
        {
          nextRetryAt: error.nextRetryAt,
          retryCount: error.retryCount,
          remainingMs: error.nextRetryAt - Date.now(),
        },
      )
      return
    }
    storage.refresh.mainLastRefreshError = undefined
    await saveAccountState(storage, accountStoragePath, { mainRefresh: true })
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
    if (latestGetAuth) {
      try {
        const auth = await latestGetAuth()
        if (auth.type === 'oauth' && auth.access) {
          // /claude-quota is a manual action: force a real fetch instead of
          // returning the cache. refreshMain still respects 429 backoff — it
          // returns the last cached snapshot when the API is backed off.
          const quota = await quotaManager.refreshMain(auth.access)
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
    const errorMap = new Map(errors.map((e) => [e.accountId, e.message]))
    accounts.push(...buildFallbackQuotaSummaries(storage, errorMap))

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
        writeSidebarState(updatedStorage, {
          activeId: lastSidebarRouting.activeId,
          route: lastSidebarRouting.route,
          mainAccessToken: auth.access,
          mainRefreshToken: auth.refresh,
        })
      } catch {
        // auth not yet available — sidebar will refresh on next request
      }
    }
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
      logger.info('commands', 'cachekeep enabled changed', { enabled: true })
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
    const stats = cacheKeepManager.stats(window)
    return executeCacheKeepCommand({
      argumentsText,
      enabled: isCacheKeepPersistentlyEnabled(storage),
      window,
      hybridActive: isCacheKeepHybridActive(storage),
      trackedSessions: stats.trackedSessions,
      nextPrewarmAt: stats.nextPrewarmAt,
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

  async function executePersistentRoutingCommand(argumentsText: string) {
    const action = parseRoutingCommandAction(argumentsText)
    if (action.type === 'mode') {
      await setRoutingMode(action.mode)
      logger.info('commands', 'routing mode changed', { mode: action.mode })
      return executeRoutingCommand({ argumentsText, mode: action.mode })
    }

    const storage = await loadAccounts()
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
        const account: OAuthAccount = {
          id: randomUUID(),
          type: 'oauth' as const,
          access: result.access,
          refresh: result.refresh,
          expires: result.expires,
          enabled: true,
          addedAt: now,
          lastUsed: now,
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
    const storage = await loadAccounts(accountStoragePath)
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
            mainRefreshToken: auth.refresh,
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
      const text = await executePersistentRoutingCommand(args)
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
            'Keep hybrid Claude cache warm for recently used sessions during a local time window.',
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
            'Show or change Claude account routing between main-first and fallback-first.',
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
        const models = addFableMythos5Models(provider.models)
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
      const modalCommands: CommandModalName[] = [
        'claude-account',
        'claude-cache',
        'claude-cachekeep',
        'claude-quota',
        'claude-dump',
        'claude-fast',
        'claude-routing',
        'claude-killswitch',
        'claude-logging',
      ]
      if (!modalCommands.includes(input.command as CommandModalName)) return
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
          activeId: 'main',
          route: 'main',
          mainAccessToken: cmdAuth?.access,
          mainRefreshToken: cmdAuth?.refresh,
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
          // Shared inflight refresh promise — prevents concurrent token refreshes
          // from racing against each other (and causing 401 cascades with token rotation)
          let refreshPromise: Promise<string> | null = null

          async function refreshMainAccessToken() {
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
                      setTimeout(
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
                      await new Promise((resolve) => setTimeout(resolve, delay))
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
                            freshAuth.refresh,
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
                        freshAuth.refresh,
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
                            refreshToken: failedRefreshToken,
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
              })().finally(() => {
                refreshPromise = null
              })
            }

            return refreshPromise
          }

          latestRefreshMainAccessToken = refreshMainAccessToken

          function startMainBackgroundRefresh() {
            if (mainBackgroundRefreshTimer) {
              clearInterval(mainBackgroundRefreshTimer)
              mainBackgroundRefreshTimer = null
            }

            const run = async () => {
              try {
                const storage = await loadAccounts(accountStoragePath)
                if (!mainRefreshEnabled(storage)) return
                const latestAuth = await getAuth()
                if (latestAuth.type !== 'oauth') return
                await clearStaleMainRefreshError(latestAuth.refresh)
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
                  latestAuth.refresh &&
                  refreshBackoffActive(
                    storage?.refresh?.mainLastRefreshError,
                    latestAuth.refresh,
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

            mainBackgroundRefreshTimer = setInterval(() => {
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
          writeSidebarState(initialStorage, {
            activeId: 'main',
            route: 'main',
            mainAccessToken: auth.access,
            mainRefreshToken: auth.refresh,
          })

          function isReplayableRequest(
            input: string | URL | Request,
            body: RequestInit['body'] | null | undefined,
          ) {
            if (input instanceof Request && input.body) return false
            return body == null || typeof body === 'string'
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
              return {
                response: new Response(stream, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                }),
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
            return {
              response: new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }),
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
          ) {
            void currentStorage
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
              await dumpDirectRequest({
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
              body = await rewriteRequestBody(body, {
                cache1hEnabled: !subagentRequest && isCache1hEnabled(),
                cache1hMode: getCache1hMode(),
                fastModeEnabled: fastModeRequested,
                identity,
                perf: (stage, data) =>
                  trace?.mark(`rewrite_body_${stage}`, { route, ...data }),
              })
              const headerBodyParseStart = nowMs()
              try {
                setOAuthHeaders(requestHeaders, accessToken, {
                  body: JSON.parse(body),
                  identity,
                })
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

            const rewritten = rewriteUrl(input)
            if (
              route === 'main' &&
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

            const directFetch = async () => {
              try {
                const response = await fetch(rewritten.input, {
                  ...init,
                  body,
                  headers: requestHeaders,
                  ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
                })
                if (typeof body === 'string') {
                  await dumpDirectRequest({
                    affinity: relayAffinity,
                    route,
                    status: response.status,
                    bodyText: body,
                    url:
                      rewritten.url?.toString() ??
                      fetchInputUrl(rewritten.input),
                    method: fetchMethod(input, init),
                    headers: requestHeaders,
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
                  })
                }
                throw error
              }
            }

            const relayConfig = getRelayConfig(await getRequestStorage())
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
            })
            trace?.mark('send_headers_received', {
              route,
              ms: roundMs(nowMs() - sendStart),
              status: response.status,
              relayConfigured: relayConfig != null,
              totalSendWithAccessMs: roundMs(nowMs() - start),
            })

            return response
          }

          function getFallbackQuota(account: {
            id: string
            access?: string
            quota?: OAuthQuotaSnapshot
          }): OAuthQuotaSnapshot | undefined {
            // Token-aware read: a cached entry bound to a different access token
            // (account re-login) is dropped so a stale snapshot is never used.
            return (
              quotaManager.getFallback(account.id, account.access)?.quota ??
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
            return Object.values(quota ?? {}).some(
              (window) => window && window.remainingPercent <= 0,
            )
          }

          function responseShowsMainQuotaExhausted(
            response: Response,
            streamingRateLimited: boolean,
          ) {
            return response.status === 429 || streamingRateLimited
          }

          function mainQuotaEntryIsFreshExhausted(accessToken?: string) {
            if (!accessToken) return false
            const entry = quotaManager.getMain(accessToken)
            return Boolean(
              entry &&
                entry.refreshAfter > Date.now() &&
                quotaSnapshotIsExhausted(entry.quota),
            )
          }

          async function refreshMainQuotaConfirmsExhausted(
            accessToken?: string,
          ) {
            if (!accessToken) return false
            try {
              await quotaManager.refreshMain(accessToken)
              return mainQuotaEntryIsFreshExhausted(accessToken)
            } catch {
              return false
            }
          }

          async function getRoutableFallbackAccounts(
            storageArg: Awaited<ReturnType<typeof loadAccounts>>,
            options: { includeApiRoutes?: boolean } = {},
          ): Promise<Array<OAuthAccount | ApiKeyAccount>> {
            const usableOAuth =
              await fallbackManager.getUsableFallbackAccounts(storageArg)
            const usableOAuthById = new Map(
              usableOAuth.map((account) => [account.id, account]),
            )
            const usable: Array<OAuthAccount | ApiKeyAccount> = []
            for (const account of storageArg?.accounts ?? []) {
              if (isOAuthAccount(account)) {
                const usableAccount = usableOAuthById.get(account.id)
                if (usableAccount) usable.push(usableAccount)
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
                  )
                : true,
            )
          }

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
                    .refreshFallback(account.id, account.access)
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
            }) => void,
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
              includeApiRoutes =
                await refreshMainQuotaConfirmsExhausted(mainAccessToken)
            }

            let accounts = preselectedAccounts
            if (!accounts) {
              const accountsStart = nowMs()
              accounts = await getRoutableFallbackAccounts(storage, {
                includeApiRoutes,
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
                    killswitchPassesPolicy(getFallbackQuota(a), storage, a.id)
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
                { onSuccess: onFallbackSuccess },
              )) ?? currentResponse
            )
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const initialBody = init?.body
              const trace = createPerfTrace({
                bodyBytes:
                  typeof initialBody === 'string'
                    ? initialBody.length
                    : undefined,
              })
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
              await clearStaleMainRefreshError(auth.refresh)
              const loadStart = nowMs()
              const storage = await loadAccounts()
              trace.mark('load_storage', { ms: roundMs(nowMs() - loadStart) })
              quotaManager.updateStorage(storage)
              quotaManager.seedMainFromStorage(storage, auth.access)
              quotaManager.seedFallbacksFromAccounts(
                (storage?.accounts ?? []).filter(isOAuthAccount),
              )
              const replayableRequest = isReplayableRequest(input, init?.body)
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
                scheduleSidebarMainQuotaRefresh(storage, auth.access)
              }
              const writeCurrentSidebarState = (
                activeId: string | undefined,
                route: string,
              ) =>
                writeSidebarState(storage, {
                  activeId,
                  route,
                  mainAccessToken: auth.access,
                  mainRefreshToken: auth.refresh,
                })
              let preselectedFallbackAccounts:
                | Array<OAuthAccount | ApiKeyAccount>
                | undefined

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
                      ),
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
                    },
                  )
                  if (fallbackResponse) {
                    trace.done('return_fallback_first', {
                      status: fallbackResponse.status,
                    })
                    return createStrippedStream(fallbackResponse, {
                      perf: (stage, data) => trace.mark(stage, data),
                    })
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
                  auth.refresh &&
                  mainRefreshError &&
                  refreshBackoffActive(
                    mainRefreshError,
                    auth.refresh,
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
                const mainEntry = quotaManager.getMain()
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
                    // Token-aware read so a cached snapshot bound to a previous
                    // access token (account re-login) is never shown.
                    quota:
                      quotaManager.getFallback(a.id, a.access)?.quota ??
                      a.quota,
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
                  // Token-aware read: getMain(auth.access) drops a cached entry
                  // bound to a different access token (main-account switch) so
                  // routing never uses the previous account's quota.
                  let routingQuotaEntry = quotaManager.getMain(auth.access)
                  let routingQuota = routingQuotaEntry?.quota
                  if (!routingQuota) {
                    routingQuota = await quotaManager.refreshMain(auth.access)
                    routingQuotaEntry = quotaManager.getMain(auth.access)
                    showQuotaToastFromCache()
                  } else if (quotaManager.needsRefresh(sessionRequestCount)) {
                    if (quotaSnapshotIsExhausted(routingQuota)) {
                      // A stale exhausted snapshot is not strong enough evidence
                      // to spend API-key credits. Re-check synchronously; if the
                      // quota API is backed off and only stale data is returned,
                      // the API route gate below still refuses it because the
                      // entry is not fresh.
                      routingQuota = await quotaManager.refreshMain(auth.access)
                      routingQuotaEntry = quotaManager.getMain(auth.access)
                    } else {
                      // Stale OR every-N request boundary — background refresh,
                      // return current snapshot to avoid blocking. Refresh the
                      // sidebar and show the toast once the new main quota lands.
                      void quotaManager
                        .refreshMain(auth.access)
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
                    mainRefreshToken: auth.refresh,
                  })
                  trace.mark('main_quota_for_routing', {
                    ms: roundMs(nowMs() - quotaStart),
                    passes: quotaSnapshotPassesPolicy(routingQuota, storage),
                  })
                  if (!quotaSnapshotPassesPolicy(routingQuota, storage)) {
                    const fallbackStart = nowMs()
                    preselectedFallbackAccounts =
                      await getRoutableFallbackAccounts(storage, {
                        includeApiRoutes: Boolean(
                          routingQuotaEntry &&
                            routingQuotaEntry.refreshAfter > Date.now() &&
                            quotaSnapshotIsExhausted(routingQuotaEntry.quota),
                        ),
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
                      },
                    )
                    if (fallbackResponse) {
                      trace.done('return_preselected_fallback', {
                        status: fallbackResponse.status,
                      })
                      return createStrippedStream(fallbackResponse, {
                        perf: (stage, data) => trace.mark(stage, data),
                      })
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

              // Fail-closed: if failClosedOnUnknownQuota is set, quota API is backed off,
              // and we have no cached quota, block the request. Token-aware read
              // so a previous account's cached quota can't satisfy this check
              // (and feed the killswitch eval below) after a main-account switch.
              let mainQuota = quotaManager.getMain(auth.access)?.quota
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
                const needsRefresh =
                  quotaManager.needsRefresh(sessionRequestCount)
                if (needsRefresh) {
                  try {
                    const fallbackAccts = (storage?.accounts ?? []).filter(
                      (a): a is OAuthAccount =>
                        a.enabled !== false &&
                        isOAuthAccount(a) &&
                        Boolean(a.access),
                    )
                    await Promise.all([
                      quotaManager.refreshMain(auth.access),
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
                mainQuota = quotaManager.getMain(auth.access)?.quota
              }

              if (
                isKillswitchEnabled(storage) &&
                // No `mainQuota &&` guard: when main quota is unknown (eager
                // refresh failed on the first request) killswitchPassesPolicy
                // returns false under failClosedOnUnknownQuota, so the killswitch
                // must still block / reroute instead of falling through to main.
                !killswitchPassesPolicy(mainQuota, storage)
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
                    return createStrippedStream(fallbackResponse, {
                      perf: (stage, data) => trace.mark(stage, data),
                    })
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
                const retryAfter = killswitchRetryAfterSeconds(
                  mainQuota,
                  fallbackAccounts,
                  now,
                )
                return new Response(
                  JSON.stringify({
                    type: 'error',
                    error: {
                      type: 'rate_limit_error',
                      message: `Killswitch: no routable accounts. Retry in ${Math.floor(retryAfter / 60)}m ${retryAfter % 60}s.`,
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
                  writeCurrentSidebarState(account.id, 'fallback')
                },
              )
              if (!fallbackServed) writeCurrentSidebarState('main', 'main')

              trace.done('return_response', { status: response.status })
              return createStrippedStream(response, {
                perf: (stage, data) => trace.mark(stage, data),
              })
            },
          }
        }

        return {}
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
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}
