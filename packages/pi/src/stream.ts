import {
  type ApiKeyAccount,
  applyClaudeCodeHeaders,
  applyCustomHeaders,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  type ClaustrumScopedAttempt,
  ClaustrumScopedRuntime,
  type ClaustrumScopedRuntimeOptions,
  connectClaustrumScopedClient,
  createStickyNoRouteResponse,
  decideStickyQuotaFailure,
  dumpDirectRequest,
  FAST_MODE_BETA,
  FallbackAccountManager,
  fetchOAuthQuotaSnapshot,
  getCache1hPersistentMode,
  getClaudeCodeIdentityForVerifiedAccount,
  getClaustrumMode,
  getDefaultCacheKeepRegistryDirectory,
  getFallbackReauthLabels,
  getHostClaustrumEnrollmentPaths,
  getOrCreateMainAccountId,
  getQuotaCheckIntervalMs,
  getRelayConfig,
  getRoutingMode,
  getScopedQuotaWindowForModel,
  getStickyRoutingStatePath,
  getThinkingPrefixMismatchBehavior,
  hasThinkingBindingControls,
  isApiKeyAccount,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isKillswitchEnabled,
  isOAuthAccount,
  isPermanentRefreshError,
  isValidApiBaseURL,
  killswitchPassesPolicy,
  loadAccounts,
  logger,
  MID_CONVERSATION_OUTPUT_CONFIG_BETA,
  type MidConversationEffortTransition,
  mergeAnthropicBetas,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
  QuotaManager,
  type QuotaState,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  refreshBackoffActive,
  resolveClaudeCodeIdentity,
  STICKY_ROUTING_MAIN_ACCOUNT_ID,
  type StickyRouteCandidate,
  StickySessionRouter,
  sendViaRelay,
  setDumpEnabled,
  shouldFallbackStatus,
  stickyQuotaSnapshotIsFresh,
  stickyRetryAfterWithJitter,
  stickyRouteFamilyForModel,
  THINKING_BINDING_CONTROLS_BETA,
  tokenFingerprint,
  usesMidConversationOutputConfig,
} from '@cortexkit/anthropic-auth-core'
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentTools,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai'

import { buildAnthropicRequest, fromClaudeCodeToolName } from './convert.ts'
import { requirePiEnrollment } from './custody.ts'
import {
  getPiAccountStoragePath,
  getPiClaustrumConnectionOptions,
} from './paths.ts'

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

let cacheKeepRegistry: CacheKeepSessionRegistry | undefined
let cacheKeepRegistryDirectory: string | undefined
const stickyRouters = new Map<string, StickySessionRouter>()
const quotaManagers = new Map<string, QuotaManager>()
const fallbackManagers = new Map<string, FallbackAccountManager>()
const mainAccountIdInitializations = new Map<
  string,
  Promise<string | undefined>
>()
const PI_SERVICE_CACHE_LIMIT = 16
const scopedRuntimes = new Map<string, ClaustrumScopedRuntime>()

export function getPiScopedRuntime(
  storagePath = getPiAccountStoragePath(),
  overrides: Partial<
    Pick<
      ClaustrumScopedRuntimeOptions,
      'connect' | 'pollIntervalMs' | 'setTimeoutImpl' | 'clearTimeoutImpl'
    >
  > = {},
): ClaustrumScopedRuntime {
  const existing = scopedRuntimes.get(storagePath)
  if (existing) return existing
  let warned = false
  const { connect, ...runtimeOverrides } = overrides
  const runtime = new ClaustrumScopedRuntime({
    storagePath,
    tokenPath: getHostClaustrumEnrollmentPaths('pi').tokenPath,
    connect: async () => {
      await requirePiEnrollment()
      return connect
        ? connect()
        : connectClaustrumScopedClient(
            getPiClaustrumConnectionOptions(storagePath),
          )
    },
    onRoster: () => {
      warned = false
    },
    onError: () => {
      if (!warned)
        logger.warn('claustrum', 'Pi scoped credential service unavailable')
      warned = true
    },
    ...runtimeOverrides,
  })
  while (scopedRuntimes.size >= PI_SERVICE_CACHE_LIMIT) {
    const oldest = scopedRuntimes.keys().next().value
    if (oldest === undefined) break
    scopedRuntimes.get(oldest)?.close()
    scopedRuntimes.delete(oldest)
  }
  scopedRuntimes.set(storagePath, runtime)
  return runtime
}

export function closePiScopedRuntime(
  storagePath = getPiAccountStoragePath(),
): void {
  scopedRuntimes.get(storagePath)?.close()
  scopedRuntimes.delete(storagePath)
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

function ensurePiMainAccountId(storagePath: string) {
  let initialization = mainAccountIdInitializations.get(storagePath)
  if (!initialization) {
    initialization = getOrCreateMainAccountId(storagePath).catch((error) => {
      if (mainAccountIdInitializations.get(storagePath) === initialization) {
        mainAccountIdInitializations.delete(storagePath)
      }
      throw error
    })
    setBoundedService(mainAccountIdInitializations, storagePath, initialization)
  }
  return initialization
}

function getPiRoutingServices(
  storagePath: string,
  storage: Awaited<ReturnType<typeof loadAccounts>>,
) {
  let quotaManager = quotaManagers.get(storagePath)
  let fallbackManager = fallbackManagers.get(storagePath)
  if (!quotaManager || !fallbackManager) {
    quotaManager = new QuotaManager({
      storage,
      fetchQuotaSnapshot: async (request) => {
        const current = await loadAccounts(storagePath)
        if (getClaustrumMode(current) === 'claustrum') {
          const id = request.kind === 'main' ? 'main' : request.accountId
          if (!id)
            throw new Error('Claustrum quota request has no account identity')
          return getPiScopedRuntime(storagePath).fetchQuota(id)
        }
        if (!request.accessToken)
          throw new Error('Missing local OAuth quota credential')
        return fetchOAuthQuotaSnapshot({ accessToken: request.accessToken })
      },
    })
    fallbackManager = new FallbackAccountManager({
      configPath: storagePath,
      quotaManager,
      isFallbackAccountVaultEnabled: (_id, current) =>
        getClaustrumMode(current) === 'claustrum',
      isFallbackAccountVaultServed: (id, current) => {
        const account = current.accounts.find(
          (candidate) => candidate.id === id,
        )
        return (
          getClaustrumMode(current) === 'claustrum' &&
          Boolean(
            account &&
              isOAuthAccount(account) &&
              account.claustrumScopedCredentialId &&
              account.claustrumScopedState === 'active',
          )
        )
      },
      resolveFallbackAccessToken: (account, current) =>
        getClaustrumMode(current) === 'claustrum'
          ? undefined
          : account.access
            ? { token: account.access, source: 'sidecar' }
            : undefined,
    })
    setBoundedService(quotaManagers, storagePath, quotaManager)
    setBoundedService(fallbackManagers, storagePath, fallbackManager)
  } else {
    quotaManager.updateStorage(storage)
  }
  return { quotaManager, fallbackManager }
}

function getPiStickyRouter(storagePath: string) {
  const path =
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE ||
    getStickyRoutingStatePath(storagePath)
  let router = stickyRouters.get(path)
  if (!router) {
    router = new StickySessionRouter({ path })
    setBoundedService(stickyRouters, path, router)
  }
  return router
}

export async function clearPiStickyRoutingSession(
  storagePath: string,
  sessionId: string,
) {
  await getPiStickyRouter(storagePath).clear(sessionId)
}

function getPiCacheKeepRegistry() {
  const directory =
    process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR ||
    getDefaultCacheKeepRegistryDirectory('pi')
  if (!cacheKeepRegistry || cacheKeepRegistryDirectory !== directory) {
    cacheKeepRegistry = new CacheKeepSessionRegistry({ directory })
    cacheKeepRegistryDirectory = directory
  }
  return cacheKeepRegistry
}

const scopedPrewarmAttempts = new Map<
  number,
  { runtime: ClaustrumScopedRuntime; receipt: ClaustrumScopedAttempt }
>()
const cacheKeepManager = new CacheKeepManager({
  loadStorage: () => loadAccounts(getPiAccountStoragePath()),
  onTrackedSessionsChanged: (sessions) =>
    getPiCacheKeepRegistry().publish(sessions),
  prepareHeaders: async (headers, target, attempt) => {
    const storagePath = target.accountStoragePath ?? getPiAccountStoragePath()
    const current = await loadAccounts(storagePath)
    if (target.accountStoragePath && !current) return undefined
    if (getClaustrumMode(current) === 'claustrum') {
      const runtime = getPiScopedRuntime(storagePath)
      const id = target.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID
      const receipt = await runtime.authorize(id, attempt.signal)
      if (
        !target.oauthAccountIdentity ||
        receipt.accountId !== target.oauthAccountIdentity
      ) {
        throw new Error('CacheKeep account identity changed')
      }
      const body = JSON.parse(target.bodyText) as Record<string, unknown>
      const identity = getClaudeCodeIdentityForVerifiedAccount(
        id === STICKY_ROUTING_MAIN_ACCOUNT_ID
          ? (current?.mainAccountId ?? id)
          : id,
        receipt.accountId as ProviderAccountUuid,
      )
      headers.delete('anthropic-beta')
      applyClaudeCodeHeaders(headers, receipt.accessToken, {
        body,
        identity,
        extraBetas: [
          CACHE_KEEP_EXTENDED_TTL_BETA,
          ...(hasThinkingBindingControls(body)
            ? [THINKING_BINDING_CONTROLS_BETA]
            : []),
        ],
      })
      if (body.speed === 'fast')
        headers.set(
          'anthropic-beta',
          mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
        )
      scopedPrewarmAttempts.set(attempt.id, { runtime, receipt })
      return headers
    }
    const authorization = headers.get('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    const accessToken = match?.[1]
    if (!accessToken) return undefined
    try {
      const body = JSON.parse(target.bodyText) as Record<string, unknown>
      await ensurePiMainAccountId(storagePath)
      const storage = await loadAccounts(storagePath)
      const identity = await resolveClaudeCodeIdentity(
        accessToken,
        typeof body.model === 'string' ? body.model : undefined,
        target.oauthAccountId ?? storage?.mainAccountId,
      )
      headers.delete('anthropic-beta')
      applyClaudeCodeHeaders(headers, accessToken, {
        body,
        identity,
        extraBetas: [
          CACHE_KEEP_EXTENDED_TTL_BETA,
          ...(hasThinkingBindingControls(body)
            ? [THINKING_BINDING_CONTROLS_BETA]
            : []),
        ],
      })
      if (body.speed === 'fast') {
        headers.set(
          'anthropic-beta',
          mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
        )
      }
    } catch {
      applyClaudeCodeHeaders(headers, accessToken)
    }
    return headers
  },
  onResponse: async ({ attempt, status }) => {
    const entry = scopedPrewarmAttempts.get(attempt.id)
    if (entry)
      await entry.runtime.reportFailure(entry.receipt, status, 'direct')
  },
  onComplete: ({ attempt }) => {
    scopedPrewarmAttempts.delete(attempt.id)
  },
})

export async function getPiTrackedCacheKeepSessions() {
  return getPiCacheKeepRegistry().list(cacheKeepManager.trackedSessions())
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
  message?: { usage?: Record<string, number> }
  usage?: Record<string, number>
}

type Block = (
  | TextContent
  | ThinkingContent
  | (ToolCall & { partialJson?: string })
) & {
  index?: number
}

function updateUsage(
  model: Model<Api>,
  output: AssistantMessage,
  usage?: Record<string, number>,
) {
  if (!usage) return
  output.usage.input = usage.input_tokens ?? output.usage.input
  output.usage.output = usage.output_tokens ?? output.usage.output
  output.usage.cacheRead =
    usage.cache_read_input_tokens ?? output.usage.cacheRead
  output.usage.cacheWrite =
    usage.cache_creation_input_tokens ?? output.usage.cacheWrite
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
  if (/\/v\d[^/]*\/messages$/.test(basePath)) {
    url.pathname = basePath
  } else if (/\/v\d[^/]*$/.test(basePath)) {
    url.pathname = `${basePath}/messages`
  } else {
    url.pathname = `${basePath}/v1/messages`
  }
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
): AsyncGenerator<AnthropicEvent> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          yield JSON.parse(data) as AnthropicEvent
        }
      }
    }
  } finally {
    // Do not cancel the reader on early abandon. `firstStreamingError()` peeks
    // the first SSE event from a `response.clone()` and then abandons this
    // generator; cancelling the cloned (tee'd) reader tears down the shared
    // underlying body, so the real `parseSse(response)` that streams the reply
    // reads zero events and the assistant message comes back empty. Releasing
    // the lock is enough — the abandoned clone branch is garbage-collected.
    reader.releaseLock()
  }
}

async function sendAnthropicRequest(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  accessToken?: string
  apiAccount?: ApiKeyAccount
  storagePath: string
  oauthAccountId?: string
  route?: string
  effortTransitions?: readonly MidConversationEffortTransition[]
}): Promise<Response> {
  await ensurePiMainAccountId(options.storagePath)
  const storage = await loadAccounts(options.storagePath)
  setDumpEnabled(isDumpPersistentlyEnabled(storage))
  const accountIdentity =
    options.oauthAccountId === STICKY_ROUTING_MAIN_ACCOUNT_ID
      ? storage?.mainAccountId
      : options.oauthAccountId
  const scoped =
    !options.apiAccount && getClaustrumMode(storage) === 'claustrum'
      ? getPiScopedRuntime(options.storagePath)
      : undefined
  const routeId = options.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID
  const roster = scoped
    ? (scoped.snapshot() ?? (await scoped.refresh()))
    : undefined
  const verifiedUuid =
    routeId === STICKY_ROUTING_MAIN_ACCOUNT_ID
      ? roster?.primary?.accountId
      : roster?.accounts.find((account) => account.id === routeId)
          ?.anthropicAccountUuid
  if (scoped && !verifiedUuid)
    throw new Error('Claustrum route has no verified provider identity')
  const identity =
    scoped && verifiedUuid
      ? getClaudeCodeIdentityForVerifiedAccount(
          accountIdentity ?? routeId,
          verifiedUuid as ProviderAccountUuid,
        )
      : options.accessToken
        ? await resolveClaudeCodeIdentity(
            options.accessToken,
            options.model.id,
            accountIdentity,
          )
        : undefined
  const { body, bodyText } = await buildAnthropicRequest(
    options.model.id,
    options.context,
    options.streamOptions,
    {
      enabled: isCache1hPersistentlyEnabled(storage),
      mode: getCache1hPersistentMode(storage),
    },
    isFastModePersistentlyEnabled(storage),
    identity,
    {
      effortTransitions: options.apiAccount ? [] : options.effortTransitions,
      thinkingPrefixMismatchBehavior: options.apiAccount
        ? 'account-default'
        : getThinkingPrefixMismatchBehavior(storage),
    },
  )
  const fastMode = body.speed === 'fast'
  const headers = options.apiAccount
    ? configureApiRouteHeaders(options.apiAccount, fastMode)
    : applyClaudeCodeHeaders(
        new Headers(),
        scoped ? '' : (options.accessToken ?? ''),
        {
          body,
          identity,
          extraBetas: [
            ...(hasThinkingBindingControls(body)
              ? [THINKING_BINDING_CONTROLS_BETA]
              : []),
            ...(usesMidConversationOutputConfig(body)
              ? [MID_CONVERSATION_OUTPUT_CONFIG_BETA]
              : []),
          ],
        },
      )
  if (!options.apiAccount && fastMode) {
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  }
  const relayAffinity = options.streamOptions?.sessionId ?? null

  const input = options.apiAccount
    ? buildExplicitBaseMessagesUrl(options.apiAccount.baseURL)
    : new URL('/v1/messages?beta=true', options.model.baseUrl)
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: bodyText,
    signal: options.streamOptions?.signal,
  }

  await cacheKeepManager.track({
    sessionId: relayAffinity,
    url: input.toString(),
    headers,
    bodyText,
    storage,
    cacheMode:
      !options.apiAccount && isCacheKeepHybridActive(storage)
        ? 'hybrid'
        : 'disabled',
    oauthAccountId: options.oauthAccountId,
    oauthAccountIdentity: verifiedUuid ?? identity?.accountUuid,
    accountStoragePath: options.storagePath,
  })

  const report = async (
    attempt: ClaustrumScopedAttempt,
    status: number,
    source: 'direct' | 'relay_status_field',
  ) => {
    if (!scoped || status !== 401) return
    await scoped.reportFailure(attempt, status, source).catch(() => {
      logger.warn('claustrum', 'Pi scoped auth-failure report unavailable')
    })
  }
  const directFetch = async () => {
    // Every physical attempt, including relay-to-direct fallback, is authorized.
    const attempt = scoped
      ? await scoped.authorize(routeId, options.streamOptions?.signal)
      : undefined
    if (attempt) headers.set('authorization', `Bearer ${attempt.accessToken}`)
    try {
      const response = await fetch(input, init)
      if (attempt) await report(attempt, response.status, 'direct')
      await dumpDirectRequest({
        affinity: relayAffinity,
        route:
          options.route ??
          (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
        status: response.status,
        bodyText,
        url: input.toString(),
        method: init.method,
        headers,
      })
      return response
    } catch (error) {
      await dumpDirectRequest({
        affinity: relayAffinity,
        route:
          options.route ??
          (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
        error: errorText(error),
        bodyText,
        url: input.toString(),
        method: init.method,
        headers,
      })
      throw error
    }
  }

  if (options.apiAccount) return directFetch()

  return sendViaRelay({
    config: getRelayConfig(storage),
    input,
    init,
    headers,
    body: bodyText,
    fallback: directFetch,
    affinity: relayAffinity,
    authorizeAttempt: scoped
      ? async () => {
          const attempt = await scoped.authorize(
            routeId,
            options.streamOptions?.signal,
          )
          const authorizedHeaders = new Headers(headers)
          authorizedHeaders.set(
            'authorization',
            `Bearer ${attempt.accessToken}`,
          )
          return {
            headers: authorizedHeaders,
            onUpstreamStatus: (status) => {
              void report(attempt, status, 'relay_status_field')
            },
          }
        }
      : undefined,
  })
}

function quotaSnapshotIsExhausted(
  quota: Awaited<ReturnType<QuotaManager['refreshMain']>> | undefined,
) {
  return (['five_hour', 'seven_day'] as const).some(
    (key) => (quota?.[key]?.remainingPercent ?? 1) <= 0,
  )
}

export function primaryResponseAllowsApiFallback(preflight: Response | string) {
  return (
    preflight === 'rate_limit_error' ||
    (preflight instanceof Response && preflight.status === 429)
  )
}

async function firstStreamingError(
  response: Response,
): Promise<Response | string> {
  if (!response.ok) return response
  const clone = response.clone()
  try {
    for await (const event of parseSse(clone as unknown as Response)) {
      if (
        event.type === 'error' &&
        typeof event.delta?.type === 'string' &&
        event.delta.type === 'rate_limit_error'
      ) {
        return 'rate_limit_error'
      }
      return response
    }
  } catch {
    return response
  }
  return response
}

async function executeWithFallback(options: {
  model: Model<Api>
  context: Context
  streamOptions?: SimpleStreamOptions
  primaryAccessToken: string
  storagePath: string
  effortTransitions?: readonly MidConversationEffortTransition[]
}): Promise<Response> {
  await ensurePiMainAccountId(options.storagePath)
  let storage = await loadAccounts(options.storagePath)
  const scoped =
    getClaustrumMode(storage) === 'claustrum'
      ? getPiScopedRuntime(options.storagePath)
      : undefined
  let roster = scoped ? await scoped.refresh() : undefined
  if (scoped && !roster)
    throw new Error('Claustrum custody changed during request preparation')
  if (roster) storage = roster.storage
  const primaryCredential = scoped ? '' : options.primaryAccessToken
  const scopedReady = (account: OAuthAccount) =>
    Boolean(
      scoped &&
        account.enabled !== false &&
        account.claustrumScopedCredentialId &&
        account.claustrumScopedState === 'active',
    )
  const primaryAvailable = () =>
    !scoped ||
    (roster?.primary?.state === 'active' &&
      !storage?.claustrum?.disabledAccountIdentities?.includes(
        roster.primary.accountId,
      ))
  const { quotaManager, fallbackManager: manager } = getPiRoutingServices(
    options.storagePath,
    storage,
  )
  let mainAccountId = scoped
    ? roster?.primary?.accountId
    : storage?.mainAccountId
  quotaManager.seedMainFromStorage(storage, mainAccountId)
  quotaManager.seedFallbacksFromAccounts(
    (storage?.accounts ?? []).filter(isOAuthAccount),
  )

  type PiStickyRoute = {
    id: string
    access: string
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
    // A successful windowless usage response is not the same as a failed
    // probe. Pi intentionally admits the former as unknown-capacity OAuth.
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

  async function buildStickyRoutes(modelId: string) {
    if (scoped) {
      roster = await scoped.refresh()
      if (!roster) throw new Error('Claustrum custody changed during routing')
      storage = roster.storage
      mainAccountId = roster.primary?.accountId
      quotaManager.updateStorage(storage)
      quotaManager.seedMainFromStorage(storage, mainAccountId)
      quotaManager.seedFallbacksFromAccounts(
        storage.accounts.filter(isOAuthAccount),
      )
    }
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
          primaryCredential,
        )
      } catch {}
    }
    const usableFallbacks = await manager.getUsableFallbackAccounts(storage, {
      modelId,
    })
    const usableById = new Map(
      usableFallbacks.map((account) => [account.id, account]),
    )
    const allRoutes: PiStickyRoute[] = []
    if (
      primaryAvailable() &&
      (scoped ||
        !isPermanentRefreshError(storage?.refresh?.mainLastRefreshError))
    ) {
      allRoutes.push({
        id: STICKY_ROUTING_MAIN_ACCOUNT_ID,
        access: primaryCredential,
        quota: mainQuota,
        order: 0,
      })
    }
    for (const [index, configured] of (storage?.accounts ?? []).entries()) {
      if (configured.enabled === false || !isOAuthAccount(configured)) continue
      const account = usableById.get(configured.id) ?? configured
      if (
        scoped
          ? !scopedReady(account)
          : !account.access || isPermanentRefreshError(account.lastRefreshError)
      )
        continue
      let accountQuota =
        quotaManager.getFallback(account.id, account)?.quota ?? account.quota
      if (
        !stickyQuotaSnapshotIsFresh(accountQuota, storage, Date.now(), modelId)
      ) {
        try {
          accountQuota = await quotaManager.refreshFallback(
            account.id,
            scoped ? '' : (account.access ?? ''),
            account,
          )
        } catch {}
      }
      allRoutes.push({
        id: account.id,
        access: scoped ? '' : (account.access ?? ''),
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
        if (!scoped && isPermanentRefreshError(refreshError)) return []
        if (
          stickyQuotaSnapshotIsFresh(
            route.quota,
            storage,
            Date.now(),
            modelId,
          ) &&
          decideStickyQuotaFailure({ quota: route.quota, modelId }).action ===
            'migrate'
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
    if (!primaryAvailable()) return false
    try {
      const quota = await quotaManager.refreshMain(
        mainAccountId,
        primaryCredential,
      )
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
    if (!primaryAvailable()) return false
    try {
      const quota = await quotaManager.refreshMain(
        mainAccountId,
        primaryCredential,
      )
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

  async function tryFallbackAccounts(
    routeOptions: { includeApiRoutes?: boolean; apiOnly?: boolean } = {},
  ) {
    const usableOAuth = await manager.getUsableFallbackAccounts(storage, {
      modelId: options.model.id,
    })
    const usableOAuthById = new Map(
      usableOAuth.map((account) => [account.id, account]),
    )
    for (const configured of storage?.accounts ?? []) {
      if (configured.enabled === false) continue
      let response: Response | null = null
      let account: OAuthAccount | ApiKeyAccount | undefined = isOAuthAccount(
        configured,
      )
        ? usableOAuthById.get(configured.id)
        : configured
      if (!account) {
        if (
          !isOAuthAccount(configured) ||
          (scoped
            ? !scopedReady(configured)
            : !configured.access ||
              (configured.expires !== undefined &&
                configured.expires <= Date.now()) ||
              isPermanentRefreshError(configured.lastRefreshError) ||
              refreshBackoffActive(
                configured.lastRefreshError,
                configured.id,
                Date.now(),
                tokenFingerprint(configured.refresh),
              ))
        )
          continue
        account = configured
        const quota =
          quotaManager.getFallback(configured.id, configured)?.quota ??
          configured.quota
        if (quotaSnapshotHasStandardWindows(quota)) continue
        if (
          isKillswitchEnabled(storage) &&
          !killswitchPassesPolicy(
            quota,
            storage,
            configured.id,
            options.model.id,
          )
        )
          continue
      } else if (
        isOAuthAccount(account) &&
        isKillswitchEnabled(storage) &&
        !killswitchPassesPolicy(
          quotaManager.getFallback(account.id, account)?.quota ?? account.quota,
          storage,
          account.id,
          options.model.id,
        )
      ) {
        continue
      }

      if (isOAuthAccount(account)) {
        if (
          routeOptions.apiOnly === true ||
          (scoped ? !scopedReady(account) : !account.access)
        )
          continue
        response = await sendAnthropicRequest({
          ...options,
          accessToken: scoped ? undefined : account.access,
          oauthAccountId: account.id,
        })
      } else if (
        routeOptions.includeApiRoutes === true &&
        isApiKeyAccount(account) &&
        account.enabled !== false &&
        account.apiKey &&
        isValidApiBaseURL(account.baseURL)
      ) {
        response = await sendAnthropicRequest({
          ...options,
          apiAccount: account,
        })
      }
      if (!response) continue

      const preflight = await firstStreamingError(response)
      if (preflight instanceof Response && preflight.ok) {
        await manager.markUsed(account)
        return preflight
      }
      if (
        preflight instanceof Response &&
        !shouldFallbackStatus(preflight.status, storage)
      ) {
        return preflight
      }
      await response.body?.cancel().catch(() => {})
    }
    return null
  }

  const routingMode = getRoutingMode(storage)
  if (routingMode === 'sticky-balanced' && options.streamOptions?.sessionId) {
    const sessionId = options.streamOptions.sessionId
    const router = getPiStickyRouter(options.storagePath)
    const initialInputBytes = Math.max(
      1,
      Buffer.byteLength(JSON.stringify(options.context)),
    )
    let routes = await buildStickyRoutes(options.model.id)
    const mainPermanentlyUnavailable = scoped
      ? !primaryAvailable()
      : isPermanentRefreshError(storage?.refresh?.mainLastRefreshError)
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
      // Existing affinity can survive a transient probe failure, but an
      // incomplete pool cannot create a new balanced assignment.
      candidates: incompleteQuotaPool ? [] : routes.candidates,
      retainAccountIds: routes.retainAccountIds,
      storage,
      inputBytes: initialInputBytes,
    })
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
    if (!resolution) {
      return createStickyNoRouteResponse({
        mainRefreshError: scoped
          ? undefined
          : storage?.refresh?.mainLastRefreshError,
        fallbackReauthLabels: getFallbackReauthLabels(storage),
        routeQuotas: routes.allRoutes.flatMap((route) =>
          route.quota ? [route.quota] : [],
        ),
        modelId: options.model.id,
      })
    }
    let route = routes.allRoutes.find(
      (candidate) => candidate.id === resolution?.accountId,
    )
    if (resolution && route) {
      const sendRoute = (selected: PiStickyRoute) =>
        sendAnthropicRequest({
          ...options,
          accessToken: selected.access,
          oauthAccountId: selected.id,
          route: `sticky:${selected.id}`,
        })
      const completeRoute = async (
        selected: PiStickyRoute,
        response: Response,
        markUsed = true,
      ) => {
        if (markUsed && selected.account)
          await manager.markUsed(selected.account)
        return response
      }
      const proactiveQuotaDecision = stickyQuotaSnapshotIsFresh(
        route.quota,
        storage,
        Date.now(),
        options.model.id,
      )
        ? decideStickyQuotaFailure({
            quota: route.quota,
            modelId: options.model.id,
          })
        : undefined
      if (proactiveQuotaDecision?.action === 'hold') {
        return completeRoute(
          route,
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
              headers: {
                'content-type': 'application/json',
                'retry-after': String(
                  stickyRetryAfterWithJitter(
                    sessionId,
                    proactiveQuotaDecision.retryAfterSeconds,
                  ),
                ),
              },
            },
          ),
          false,
        )
      }

      let response = await sendRoute(route)
      let preflight = await firstStreamingError(response)
      if (preflight instanceof Response && preflight.ok) {
        return completeRoute(route, preflight)
      }

      let permanentAuthFailure =
        preflight instanceof Response &&
        preflight.status === 401 &&
        (Boolean(scoped) || route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID)
      if (
        preflight instanceof Response &&
        preflight.status === 401 &&
        route.account &&
        storage &&
        !scoped
      ) {
        const authRouteId = route.id
        try {
          const refreshed = await manager.refreshAccount(
            route.account,
            storage,
            {
              force: true,
            },
          )
          if (refreshed.access) {
            route = { ...route, access: refreshed.access, account: refreshed }
          }
          await preflight.body?.cancel().catch(() => {})
          response = await sendRoute(route)
          preflight = await firstStreamingError(response)
          if (preflight instanceof Response && preflight.ok) {
            return completeRoute(route, preflight)
          }
          permanentAuthFailure =
            preflight instanceof Response && preflight.status === 401
        } catch (error) {
          const latest = await loadAccounts(options.storagePath)
          const refreshError = latest?.accounts.find(
            (account): account is OAuthAccount =>
              account.id === authRouteId && isOAuthAccount(account),
          )?.lastRefreshError
          if (!isPermanentRefreshError(refreshError)) throw error
          permanentAuthFailure = true
        }
      }

      let migrate =
        (preflight instanceof Response && preflight.status === 403) ||
        permanentAuthFailure
      if (primaryResponseAllowsApiFallback(preflight)) {
        let quota: OAuthQuotaSnapshot | undefined
        try {
          quota =
            route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
              ? await quotaManager.refreshMain(mainAccountId, route.access)
              : await quotaManager.refreshFallback(
                  route.id,
                  route.access,
                  route.account,
                )
        } catch {
          // Retain affinity when the quota probe itself is unavailable.
          quota = undefined
        }
        const decision = decideStickyQuotaFailure({
          quota,
          modelId: options.model.id,
        })
        if (decision.action === 'hold') {
          const headers = new Headers(
            preflight instanceof Response
              ? preflight.headers
              : response.headers,
          )
          headers.set(
            'retry-after',
            String(
              stickyRetryAfterWithJitter(sessionId, decision.retryAfterSeconds),
            ),
          )
          if (preflight instanceof Response) {
            return completeRoute(
              route,
              new Response(preflight.body, {
                status: preflight.status,
                statusText: preflight.statusText,
                headers,
              }),
            )
          }
          await response.body?.cancel().catch(() => {})
          headers.set('content-type', 'application/json')
          return completeRoute(
            route,
            new Response(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'rate_limit_error',
                  message:
                    'Sticky OAuth account five-hour quota resets shortly; retaining session affinity.',
                },
              }),
              { status: 429, headers },
            ),
          )
        }
        migrate = decision.action === 'migrate'
      }

      if (migrate) {
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
            storage,
            inputBytes: initialInputBytes,
            excludeAccountIds: new Set([failedRouteId]),
          })
          const migrated = routes.allRoutes.find(
            (candidate) => candidate.id === resolution?.accountId,
          )
          if (resolution && migrated) {
            route = migrated
            return completeRoute(route, await sendRoute(route))
          }
        }
        if (
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
          if (apiFallback) return apiFallback
        }
      }
      return completeRoute(
        route,
        preflight instanceof Response ? preflight : response,
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
    return createStickyNoRouteResponse({
      routeQuotas: (storage?.accounts ?? [])
        .filter(isOAuthAccount)
        .flatMap((account) => (account.quota ? [account.quota] : [])),
      modelId: options.model.id,
    })
  }

  if (isKillswitchEnabled(storage)) {
    let mainQuota = quotaManager.getMain(mainAccountId)?.quota
    if (!mainQuota || quotaManager.isMainStale(options.model.id)) {
      try {
        mainQuota = await quotaManager.refreshMain(
          mainAccountId,
          primaryCredential,
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
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: 'Killswitch blocked all OAuth routes',
          },
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '60',
          },
        },
      )
    }
  }

  const primary = await sendAnthropicRequest({
    ...options,
    accessToken: primaryCredential,
    oauthAccountId: STICKY_ROUTING_MAIN_ACCOUNT_ID,
  })
  const primaryPreflight = await firstStreamingError(primary)
  if (primaryPreflight instanceof Response) {
    if (!shouldFallbackStatus(primaryPreflight.status, storage))
      return primaryPreflight
  }

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

export function streamCortexKitAnthropic(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  effortTransitions?: readonly MidConversationEffortTransition[],
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output = createOutput(model)
    stream.push({ type: 'start', partial: output })

    try {
      const accessToken = options?.apiKey ?? ''
      const storagePath = getPiAccountStoragePath()
      if (
        !accessToken &&
        getClaustrumMode(await loadAccounts(storagePath)) !== 'claustrum'
      )
        throw new Error('Missing Anthropic OAuth access token')
      const tools = getCurrentTools(
        collapseSystemMessages(normalizeContext(context)).messages,
      )
      const response = await executeWithFallback({
        model,
        context,
        streamOptions: options,
        primaryAccessToken: accessToken,
        storagePath,
        effortTransitions,
      })

      if (!response.ok) {
        throw new Error(
          `Anthropic request failed: HTTP ${response.status} ${await response.text()}`,
        )
      }

      const blocks = output.content as Block[]
      for await (const event of parseSse(response)) {
        if (event.type === 'message_start') {
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
              thinking: '',
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
              name: fromClaudeCodeToolName(String(block.name), tools),
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
          output.stopReason = mapStopReason(
            String(event.delta?.stop_reason ?? ''),
          )
          updateUsage(model, output, event.usage)
        } else if (event.type === 'error') {
          throw new Error(JSON.stringify(event))
        }
      }

      if (options?.signal?.aborted) throw new Error('Request was aborted')
      for (const block of output.content as Block[]) delete block.index
      stream.push({
        type: 'done',
        reason: output.stopReason as 'stop' | 'length' | 'toolUse',
        message: output,
      })
      stream.end()
    } catch (error) {
      for (const block of output.content as Block[]) delete block.index
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage =
        error instanceof Error ? error.message : String(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    }
  })()

  return stream
}
