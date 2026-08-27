import {
  type ApiKeyAccount,
  applyClaudeCodeHeaders,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  createStickyNoRouteResponse,
  decideStickyQuotaFailure,
  dumpDirectRequest,
  FAST_MODE_BETA,
  FallbackAccountManager,
  getCache1hPersistentMode,
  getDefaultCacheKeepRegistryDirectory,
  getFallbackReauthLabels,
  getOrCreateMainAccountId,
  getRelayConfig,
  getRoutingMode,
  getStickyRoutingStatePath,
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
  mergeAnthropicBetas,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
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

import { buildAnthropicRequest, fromClaudeCodeToolName } from './convert.ts'
import { getPiAccountStoragePath } from './paths.ts'

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
    quotaManager = new QuotaManager({ storage })
    fallbackManager = new FallbackAccountManager({
      configPath: storagePath,
      quotaManager,
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

const cacheKeepManager = new CacheKeepManager({
  loadStorage: () => loadAccounts(getPiAccountStoragePath()),
  onTrackedSessionsChanged: (sessions) =>
    getPiCacheKeepRegistry().publish(sessions),
  prepareHeaders: async (headers, target) => {
    const authorization = headers.get('authorization') ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    const accessToken = match?.[1]
    if (!accessToken) return headers
    try {
      const body = JSON.parse(target.bodyText) as Record<string, unknown>
      const storagePath = getPiAccountStoragePath()
      await ensurePiMainAccountId(storagePath)
      const storage = await loadAccounts(storagePath)
      const identity = await resolveClaudeCodeIdentity(
        accessToken,
        typeof body.model === 'string' ? body.model : undefined,
        target.oauthAccountId ?? storage?.mainAccountId,
      )
      headers.delete('anthropic-beta')
      applyClaudeCodeHeaders(headers, accessToken, { body, identity })
      headers.set(
        'anthropic-beta',
        mergeAnthropicBetas(headers.get('anthropic-beta'), [
          CACHE_KEEP_EXTENDED_TTL_BETA,
        ]),
      )
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
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/messages`
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
}): Promise<Response> {
  await ensurePiMainAccountId(options.storagePath)
  const storage = await loadAccounts(options.storagePath)
  setDumpEnabled(isDumpPersistentlyEnabled(storage))
  const accountIdentity =
    options.oauthAccountId === STICKY_ROUTING_MAIN_ACCOUNT_ID
      ? storage?.mainAccountId
      : options.oauthAccountId
  const identity = options.accessToken
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
  )
  const fastMode = body.speed === 'fast'
  const headers = options.apiAccount
    ? configureApiRouteHeaders(options.apiAccount, fastMode)
    : applyClaudeCodeHeaders(new Headers(), options.accessToken ?? '', {
        body,
        identity,
      })
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
    cacheMode: isCacheKeepHybridActive(storage) ? 'hybrid' : 'disabled',
    oauthAccountId: options.oauthAccountId,
  })

  const directFetch = async () => {
    try {
      const response = await fetch(input, init)
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
}): Promise<Response> {
  await ensurePiMainAccountId(options.storagePath)
  const storage = await loadAccounts(options.storagePath)
  const { quotaManager, fallbackManager: manager } = getPiRoutingServices(
    options.storagePath,
    storage,
  )
  const mainAccountId = storage?.mainAccountId
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

  async function buildStickyRoutes(modelId: string) {
    const mainEntry = quotaManager.getMain(mainAccountId)
    let mainQuota = mainEntry?.quota
    if (
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
          options.primaryAccessToken,
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
    if (!isPermanentRefreshError(storage?.refresh?.mainLastRefreshError)) {
      allRoutes.push({
        id: STICKY_ROUTING_MAIN_ACCOUNT_ID,
        access: options.primaryAccessToken,
        quota: mainQuota,
        order: 0,
      })
    }
    for (const [index, configured] of (storage?.accounts ?? []).entries()) {
      if (configured.enabled === false || !isOAuthAccount(configured)) continue
      const account = usableById.get(configured.id) ?? configured
      if (!account.access || isPermanentRefreshError(account.lastRefreshError))
        continue
      let accountQuota =
        quotaManager.getFallback(account.id, account)?.quota ?? account.quota
      if (
        !stickyQuotaSnapshotIsFresh(accountQuota, storage, Date.now(), modelId)
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
    try {
      const quota = await quotaManager.refreshMain(
        mainAccountId,
        options.primaryAccessToken,
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
    try {
      const quota = await quotaManager.refreshMain(
        mainAccountId,
        options.primaryAccessToken,
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
    const entry = quotaManager.getMain(mainAccountId)
    return Boolean(
      entry &&
        quotaSnapshotModelScopeIsExhausted(entry.quota, options.model.id),
    )
  }

  function primaryFreshModelScopeExhausted() {
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
      let response: Response | null = null
      let account: OAuthAccount | ApiKeyAccount | undefined = isOAuthAccount(
        configured,
      )
        ? usableOAuthById.get(configured.id)
        : configured
      if (!account) {
        if (
          !isOAuthAccount(configured) ||
          !configured.access ||
          (configured.expires !== undefined &&
            configured.expires <= Date.now()) ||
          isPermanentRefreshError(configured.lastRefreshError) ||
          refreshBackoffActive(
            configured.lastRefreshError,
            configured.id,
            Date.now(),
          )
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
        if (routeOptions.apiOnly === true || !account.access) continue
        response = await sendAnthropicRequest({
          ...options,
          accessToken: account.access,
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
    const mainPermanentlyUnavailable = isPermanentRefreshError(
      storage?.refresh?.mainLastRefreshError,
    )
    const incompleteQuotaPool =
      (routes.allRoutes.length === 0 && !mainPermanentlyUnavailable) ||
      routes.allRoutes.some(
        (candidate) =>
          !candidate.quota ||
          !stickyQuotaSnapshotIsFresh(
            candidate.quota,
            storage,
            Date.now(),
            options.model.id,
          ),
      )
    let resolution = await router.resolve({
      sessionId,
      family: stickyRouteFamilyForModel(options.model.id),
      modelId: options.model.id,
      candidates: routes.candidates,
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
        mainRefreshError: storage?.refresh?.mainLastRefreshError,
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
        route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
      if (
        preflight instanceof Response &&
        preflight.status === 401 &&
        route.account &&
        storage
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

  if (isKillswitchEnabled(storage)) {
    let mainQuota = quotaManager.getMain(mainAccountId)?.quota
    if (!mainQuota || quotaManager.isMainStale(options.model.id)) {
      try {
        mainQuota = await quotaManager.refreshMain(
          mainAccountId,
          options.primaryAccessToken,
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
    accessToken: options.primaryAccessToken,
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
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()

  void (async () => {
    const output = createOutput(model)
    stream.push({ type: 'start', partial: output })

    try {
      const accessToken = options?.apiKey ?? ''
      if (!accessToken) throw new Error('Missing Anthropic OAuth access token')

      const storagePath = getPiAccountStoragePath()
      const response = await executeWithFallback({
        model,
        context,
        streamOptions: options,
        primaryAccessToken: accessToken,
        storagePath,
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
              name: fromClaudeCodeToolName(String(block.name), context.tools),
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
