import { randomUUID } from 'node:crypto'

import {
  type AccountStorage,
  acquireRefreshFileLock,
  authorize,
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
  buildRefreshOperationError,
  CACHE_1H_COMMAND_NAME,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CLAUDE_CACHE_KEEP_COMMAND_NAME,
  CLAUDE_DUMP_COMMAND_NAME,
  CLAUDE_FAST_COMMAND_NAME,
  CLAUDE_QUOTAS_COMMAND_NAME,
  ClaudeOAuthRefreshError,
  exchange,
  executeCache1hCommand,
  executeCacheKeepCommand,
  executeDumpCommand,
  executeFastModeCommand,
  FallbackAccountManager,
  fetchOAuthQuotaSnapshot,
  formatRefreshBackoffMessage,
  getCache1hMode,
  getCache1hPersistentMode,
  getCacheKeepWindow,
  getQuotaCheckIntervalMs,
  getQuotaNextRefreshAt,
  getRelayConfig,
  hashRefreshToken,
  isCache1hEnabled,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isCacheKeepPersistentlyEnabled,
  isDumpPersistentlyEnabled,
  isFastModeEnabled,
  isFastModePersistentlyEnabled,
  isFastModeSupportedModel,
  loadAccounts,
  log,
  mergeAnthropicBetas,
  type OAuthQuotaSnapshot,
  parseCache1hCommandAction,
  parseCacheKeepCommandAction,
  parseDumpCommandAction,
  parseFastModeCommandAction,
  type QuotaAccountSummary,
  quotaSnapshotPassesPolicy,
  type RelayConfig,
  refreshBackoffActive,
  refreshClaudeOAuthToken,
  resolveClaudeCodeIdentity,
  saveAccounts,
  sendViaRelay,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCache1hState,
  setCacheKeepPersistentEnabled,
  setCacheKeepPersistentWindow,
  setDumpEnabled,
  setDumpPersistentEnabled,
  setFastModeEnabled,
  setFastModePersistentEnabled,
  shouldFallbackStatus,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode-ai/plugin'
import { resolvePromptContext } from './prompt-context.ts'
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

type MainQuotaCache = {
  accessToken: string
  refreshAfter: number
  quota: OAuthQuotaSnapshot
}

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

function throwHandledSentinel(): never {
  throw new Error(HANDLED_SENTINEL)
}

export const AnthropicAuthPlugin: Plugin = async (ctx) => {
  startEventLoopLagMonitor()
  const { client } = ctx
  const fallbackManager = new FallbackAccountManager()
  fallbackManager.startBackgroundRefresh()
  let latestRefreshMainAccessToken: (() => Promise<string>) | null = null
  const cacheKeepManager = new CacheKeepManager({
    loadStorage: () => loadAccounts(),
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
    log,
  })
  const initialCache1hStorage = await loadAccounts()
  const relayConfig: RelayConfig | null = getRelayConfig(initialCache1hStorage)
  setCache1hState({
    enabled: isCache1hPersistentlyEnabled(initialCache1hStorage),
    mode: getCache1hPersistentMode(initialCache1hStorage),
  })
  setDumpEnabled(isDumpPersistentlyEnabled(initialCache1hStorage))
  setFastModeEnabled(isFastModePersistentlyEnabled(initialCache1hStorage))
  let latestGetAuth:
    | (() => Promise<{
        type: string
        access?: string
        refresh?: string
        expires?: number
      }>)
    | null = null
  let mainBackgroundRefreshTimer: ReturnType<typeof setInterval> | null = null

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
    const storage = await loadAccounts()
    const error = storage?.refresh?.mainLastRefreshError
    if (!storage?.refresh || !error?.tokenHash) return
    const tokenHash = hashRefreshToken(refreshToken)
    if (error.tokenHash === tokenHash) return
    storage.refresh.mainLastRefreshError = undefined
    await saveAccounts(storage)
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
          accounts.push({
            name: 'OpenCode anthropic',
            role: 'main',
            quota: await fetchOAuthQuotaSnapshot({ accessToken: auth.access }),
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
        accounts.push({
          name: 'OpenCode anthropic',
          role: 'main',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const { storage, errors } =
      await fallbackManager.refreshQuotaForAllAccounts()
    accounts.push(
      ...buildFallbackQuotaSummaries(
        storage,
        new Map(errors.map((error) => [error.accountId, error.message])),
      ),
    )

    if (!latestGetAuth) {
      accounts.unshift({
        name: 'OpenCode anthropic',
        role: 'main',
        error: 'auth loader has not run yet; send a request first',
      })
    }

    return buildClaudeQuotaSummary({ accounts, refreshedAt: Date.now() })
  }

  async function executePersistentCache1hCommand(argumentsText: string) {
    const action = parseCache1hCommandAction(argumentsText)
    if (action.type === 'enable' || action.type === 'disable') {
      const enabled = action.type === 'enable'
      const storage = await setCache1hPersistentEnabled(enabled)
      const mode = getCache1hPersistentMode(storage)
      setCache1hState({ enabled, mode })
      return executeCache1hCommand({ argumentsText, enabled, mode })
    }

    if (action.type === 'mode') {
      const storage = await setCache1hPersistentMode(action.mode)
      const enabled = isCache1hPersistentlyEnabled(storage)
      setCache1hState({ enabled, mode: action.mode })
      return executeCache1hCommand({
        argumentsText,
        enabled,
        mode: action.mode,
      })
    }

    const storage = await loadAccounts()
    const enabled = isCache1hPersistentlyEnabled(storage)
    const mode = getCache1hPersistentMode(storage)
    setCache1hState({ enabled, mode })
    return executeCache1hCommand({ argumentsText, enabled, mode })
  }

  async function executePersistentCacheKeepCommand(argumentsText: string) {
    const action = parseCacheKeepCommandAction(argumentsText)
    let storage = await loadAccounts()
    if (action.type === 'window') {
      storage = await setCacheKeepPersistentWindow(
        action.startHour,
        action.endHour,
      )
    } else if (action.type === 'disable') {
      storage = await setCacheKeepPersistentEnabled(false)
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
      return executeDumpCommand({ argumentsText, enabled })
    }

    const storage = await loadAccounts()
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
      return executeFastModeCommand({ argumentsText, enabled })
    }

    const storage = await loadAccounts()
    const enabled = isFastModePersistentlyEnabled(storage)
    setFastModeEnabled(enabled)
    return executeFastModeCommand({ argumentsText, enabled })
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
      }
    },
    'command.execute.before': async (input: {
      command: string
      arguments: string
      sessionID: string
    }) => {
      if (input.command === CACHE_1H_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await executePersistentCache1hCommand(input.arguments),
        )
        throwHandledSentinel()
      }

      if (input.command === CLAUDE_CACHE_KEEP_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await executePersistentCacheKeepCommand(input.arguments),
        )
        throwHandledSentinel()
      }

      if (input.command === CLAUDE_QUOTAS_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await buildQuotaCommandSummary(),
        )
        throwHandledSentinel()
      }

      if (input.command === CLAUDE_DUMP_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await executePersistentDumpCommand(input.arguments),
        )
        throwHandledSentinel()
      }

      if (input.command === CLAUDE_FAST_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await executePersistentFastModeCommand(input.arguments),
        )
        throwHandledSentinel()
      }
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
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        latestGetAuth = getAuth
        const auth = await getAuth()
        if (auth.type === 'oauth') {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }
          }

          // Shared inflight refresh promise — prevents concurrent token refreshes
          // from racing against each other (and causing 401 cascades with token rotation)
          let refreshPromise: Promise<string> | null = null
          let mainQuotaCache: MainQuotaCache | null = null
          let mainQuotaRefreshPromise: Promise<OAuthQuotaSnapshot> | null = null
          let mainQuotaRetryAfter = 0

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
                  const storage: AccountStorage = (await loadAccounts()) ?? {
                    version: 1,
                    main: { type: 'opencode', provider: 'anthropic' },
                    accounts: [],
                  }
                  storage.refresh = storage.refresh ?? {}
                  update(storage)
                  await saveAccounts(storage)
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

                    const storage = await loadAccounts()
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
                    const latestLease = await loadAccounts()
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
                        (error instanceof ClaudeOAuthRefreshError &&
                          error.status >= 500))
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
                      error instanceof ClaudeOAuthRefreshError
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
                const storage = await loadAccounts()
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
                log('[refresh] opencode main oauth refresh failed', {
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
              trace?.mark('inspect_stream_first_event', {
                ms: roundMs(nowMs() - start),
                bytes,
                rateLimited: true,
              })
              return { response, rateLimited: true }
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

          async function sendWithAccessToken(
            input: string | URL | Request,
            init: RequestInit | undefined,
            accessToken: string,
            trace?: PerfTrace,
            route = 'unknown',
          ) {
            const start = nowMs()
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
              try {
                const parsedBody = JSON.parse(body) as { model?: unknown }
                if (typeof parsedBody.model === 'string') {
                  modelForIdentity = parsedBody.model
                }
              } catch {}
            }
            const identity = await resolveClaudeCodeIdentity(
              accessToken,
              modelForIdentity,
            )

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
              })
              try {
                setOAuthHeaders(requestHeaders, accessToken, {
                  body: JSON.parse(body),
                  identity,
                })
              } catch {
                setOAuthHeaders(requestHeaders, accessToken, { identity })
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
              !subagentRequest &&
              isCache1hEnabled() &&
              getCache1hMode() === 'hybrid'
            ) {
              const storage = await loadAccounts()
              const tracked = await cacheKeepManager.track({
                sessionId: relayAffinity,
                url: rewritten.url?.toString() ?? rewritten.input.toString(),
                headers: requestHeaders,
                bodyText: body,
                storage,
                cacheMode: 'hybrid',
              })
              if (tracked.tracked) {
                trace?.mark('cachekeep_track', { session: relayAffinity })
              }
            }

            const directFetch = () =>
              fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })

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

          async function refreshMainQuotaCache(
            accessToken: string,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            const now = Date.now()
            const quota = await fetchOAuthQuotaSnapshot({ accessToken })
            mainQuotaCache = {
              accessToken,
              refreshAfter: getQuotaNextRefreshAt(quota, storage, now),
              quota,
            }
            return quota
          }

          function refreshMainQuotaCacheInBackground(
            accessToken: string,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            const now = Date.now()
            if (mainQuotaRefreshPromise || now < mainQuotaRetryAfter) return
            mainQuotaRefreshPromise = refreshMainQuotaCache(
              accessToken,
              storage,
            )
              .catch((error) => {
                mainQuotaRetryAfter = now + getQuotaCheckIntervalMs(storage)
                throw error
              })
              .finally(() => {
                mainQuotaRefreshPromise = null
              })
            void mainQuotaRefreshPromise.catch(() => {})
          }

          async function getMainQuotaForRouting(
            accessToken: string,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            const now = Date.now()
            if (mainQuotaCache?.accessToken !== accessToken) {
              return await refreshMainQuotaCache(accessToken, storage)
            }
            if (now >= mainQuotaCache.refreshAfter) {
              refreshMainQuotaCacheInBackground(accessToken, storage)
            }
            return mainQuotaCache.quota
          }

          async function tryUsableFallbackAccounts(
            input: string | URL | Request,
            init: RequestInit | undefined,
            accounts: Awaited<
              ReturnType<FallbackAccountManager['getUsableFallbackAccounts']>
            >,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
            currentResponse?: Response,
            trace?: PerfTrace,
          ) {
            if (!accounts.length) return currentResponse ?? null

            await currentResponse?.body?.cancel().catch(() => {})
            let lastResponse: Response | null = currentResponse ?? null

            for (const [index, account] of accounts.entries()) {
              const access = account.access
              if (!access) continue
              let response = await sendWithAccessToken(
                input,
                init,
                access,
                trace,
                `fallback_${index}`,
              )
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
                return response
              }
              if (index < accounts.length - 1) {
                await response.body?.cancel().catch(() => {})
              }
            }

            return lastResponse
          }

          async function tryFallbackAccounts(
            input: string | URL | Request,
            init: RequestInit | undefined,
            mainResponse: Response,
            preselectedAccounts?: Awaited<
              ReturnType<FallbackAccountManager['getUsableFallbackAccounts']>
            >,
            trace?: PerfTrace,
            existingStorage?: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            if (!isReplayableRequest(input, init?.body)) return mainResponse

            const loadStart = nowMs()
            const storage = existingStorage ?? (await loadAccounts())
            trace?.mark('fallback_load_storage', {
              ms: roundMs(nowMs() - loadStart),
              cached: !!existingStorage,
            })
            let currentResponse = mainResponse
            let shouldFallback = shouldFallbackStatus(
              currentResponse.status,
              storage,
            )
            if (!shouldFallback) {
              const inspected = await inspectStreamingRateLimit(
                currentResponse,
                trace,
              )
              currentResponse = inspected.response
              shouldFallback = inspected.rateLimited
            }
            if (!shouldFallback) {
              return currentResponse
            }

            let accounts = preselectedAccounts
            if (!accounts) {
              const accountsStart = nowMs()
              accounts = await fallbackManager.getUsableFallbackAccounts()
              trace?.mark('fallback_get_accounts', {
                ms: roundMs(nowMs() - accountsStart),
                accounts: accounts.length,
              })
            }
            return (
              (await tryUsableFallbackAccounts(
                input,
                init,
                accounts,
                storage,
                currentResponse,
                trace,
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
                relayConfigured: relayConfig != null,
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
                  log(
                    '[refresh] opencode main oauth request skipped backoff',
                    {
                      nextRetryAt: mainRefreshError.nextRetryAt,
                      retryCount: mainRefreshError.retryCount,
                      expiresInMs: auth.expires
                        ? auth.expires - Date.now()
                        : undefined,
                    },
                  )
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
                    expiredAgoMs: auth.expires && auth.expires < Date.now()
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
              const loadStart = nowMs()
              const storage = await loadAccounts()
              trace.mark('load_storage', { ms: roundMs(nowMs() - loadStart) })
              let preselectedFallbackAccounts:
                | Awaited<
                    ReturnType<
                      FallbackAccountManager['getUsableFallbackAccounts']
                    >
                  >
                | undefined
              if (
                isReplayableRequest(input, init?.body) &&
                mainQuotaRoutingEnabled(storage)
              ) {
                try {
                  const quotaStart = nowMs()
                  const mainQuota = await getMainQuotaForRouting(
                    auth.access,
                    storage,
                  )
                  trace.mark('main_quota_for_routing', {
                    ms: roundMs(nowMs() - quotaStart),
                    passes: quotaSnapshotPassesPolicy(mainQuota, storage),
                  })
                  if (!quotaSnapshotPassesPolicy(mainQuota, storage)) {
                    const fallbackStart = nowMs()
                    preselectedFallbackAccounts =
                      await fallbackManager.getUsableFallbackAccounts()
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
                    )
                    if (fallbackResponse) {
                      trace.done('return_preselected_fallback', {
                        status: fallbackResponse.status,
                      })
                      return createStrippedStream(fallbackResponse)
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
              const mainResponse = await sendWithAccessToken(
                input,
                init,
                auth.access,
                trace,
                'main',
              )
              const response = await tryFallbackAccounts(
                input,
                init,
                mainResponse,
                preselectedFallbackAccounts,
                trace,
                storage,
              )

              trace.done('return_response', { status: response.status })
              return createStrippedStream(response)
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
