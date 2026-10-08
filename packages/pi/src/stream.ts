import {
  type AccountStorage,
  type ApiKeyAccount,
  applyClaudeCodeHeaders,
  applyCustomHeaders,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  createStickyNoRouteResponse,
  decideStickyQuotaFailure,
  dumpDirectRequest,
  FAST_MODE_BETA,
  getCache1hPersistentMode,
  getClaudeCodeIdentityForVerifiedAccount,
  getDefaultCacheKeepRegistryDirectory,
  getFallbackReauthLabels,
  getQuotaCheckIntervalMs,
  getRoutingMode,
  getScopedQuotaWindowForModel,
  getThinkingPrefixMismatchBehavior,
  hasThinkingBindingControls,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isKillswitchEnabled,
  isOAuthAccount,
  isPermanentRefreshError,
  isValidApiBaseURL,
  killswitchPassesPolicy,
  logger,
  MID_CONVERSATION_OUTPUT_CONFIG_BETA,
  type MidConversationEffortTransition,
  mergeAnthropicBetas,
  type NativeAccountSnapshot,
  type NativeAccountView,
  type NativeApiSubject,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
  QuotaManager,
  type QuotaState,
  quotaBackoffActive,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
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
  usesMidConversationOutputConfig,
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
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai'
import { buildAnthropicRequest, fromClaudeCodeToolName } from './convert.ts'
import {
  getPiNativeRuntime,
  type PiNativeAttempt,
  piAttemptAccessToken,
} from './native.ts'
import { getPiAccountStoragePath } from './paths.ts'
import {
  buildPiOAuthMessagesUrl,
  fetchPiOAuth,
  requirePiOAuthOrigin,
} from './transport.ts'

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

let cacheKeepRegistry: CacheKeepSessionRegistry | undefined
let cacheKeepRegistryDirectory: string | undefined
const stickyRouters = new Map<string, StickySessionRouter>()
const quotaManagers = new Map<
  string,
  { identityKey: string; manager: QuotaManager }
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
      fetchQuotaSnapshot: async (request) => {
        const id = request.kind === 'main' ? 'main' : request.accountId
        if (!id) throw new Error('Native quota request has no account identity')
        return (await native.service()).fetchQuota(id, fetchPiOAuth)
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
      if (!isOAuthAccount(account) || !view?.enabled || view.type !== 'oauth')
        continue
      if (view.source === 'vault' && view.state !== 'active') continue
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
          await quotas.refreshFallback(account.id, '', account)
        } catch {}
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

async function getPiStickyRouter(storagePath: string) {
  const path = await getPiNativeRuntime(storagePath).routingPath()
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
  await (await getPiStickyRouter(storagePath)).clear(sessionId)
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

const nativePrewarmAttempts = new Map<
  number,
  {
    runtime: ReturnType<typeof getPiNativeRuntime>
    served: PiNativeAttempt
    reported: boolean
  }
>()
const cacheKeepManager = new CacheKeepManager({
  fetchImpl: fetchPiOAuth,
  loadStorage: async () => (await getPiNativeRuntime().view()).policyStorage,
  onTrackedSessionsChanged: (sessions) =>
    getPiCacheKeepRegistry().publish(sessions),
  prepareHeaders: async (headers, target, attempt) => {
    requirePiOAuthOrigin(target.url)
    const runtime = getPiNativeRuntime(
      target.accountStoragePath ?? getPiAccountStoragePath(),
    )
    const id = target.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID
    const current = await runtime.view()
    const body = JSON.parse(target.bodyText) as Record<string, unknown>
    const served = await runtime.authorize(
      id,
      attempt.signal,
      typeof body.model === 'string' ? body.model : undefined,
    )
    if (
      !target.oauthAccountIdentity ||
      served.accountIdentity !== target.oauthAccountIdentity
    )
      throw new Error('CacheKeep account identity changed')
    const identity = getClaudeCodeIdentityForVerifiedAccount(
      id === STICKY_ROUTING_MAIN_ACCOUNT_ID
        ? (current.policyStorage.mainAccountId ?? id)
        : id,
      served.accountIdentity as ProviderAccountUuid,
    )
    headers.delete('anthropic-beta')
    applyClaudeCodeHeaders(headers, piAttemptAccessToken(served), {
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
    nativePrewarmAttempts.set(attempt.id, { runtime, served, reported: false })
    return headers
  },
  retryOnUnauthorized: async ({ target, headers, attempt }) => {
    const entry = nativePrewarmAttempts.get(attempt.id)
    if (!entry) return undefined
    await entry.runtime.report(entry.served, 401, 'direct').catch(() => {
      logger.warn('native-auth', 'Pi CacheKeep auth-failure report unavailable')
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
  onResponse: async ({ attempt, status }) => {
    const entry = nativePrewarmAttempts.get(attempt.id)
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
})

export async function getPiTrackedCacheKeepSessions() {
  return getPiCacheKeepRegistry().list(cacheKeepManager.trackedSessions())
}

/** Exercise the real prewarm dispatch without wall-clock or timer mocks. */
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
  apiAccount?: NativeAccountView
  storagePath: string
  oauthAccountId?: string
  route?: string
  effortTransitions?: readonly MidConversationEffortTransition[]
  onResolvedTools?: (tools: Tool[]) => void
}): Promise<Response> {
  const native = getPiNativeRuntime(options.storagePath)
  const snapshot = await native.view()
  const storage = snapshot.policyStorage
  setDumpEnabled(isDumpPersistentlyEnabled(storage))
  const routeId = options.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID
  const selected = snapshot.accounts.find((account) => account.id === routeId)
  let verifiedUuid = options.apiAccount ? undefined : selected?.accountIdentity
  if (!options.apiAccount && !verifiedUuid) {
    if (selected?.source === 'vault')
      throw new Error('Pi vault route identity is unasserted')
    // The local service may learn a UUID by validating an unidentified row.
    // This lookup supplies identity only; dispatch still authorizes afresh.
    verifiedUuid = (
      await native.authorize(
        routeId,
        options.streamOptions?.signal,
        options.model.id,
      )
    ).accountIdentity
  }
  let nextAttempt: PiNativeAttempt | undefined
  const identity = verifiedUuid
    ? getClaudeCodeIdentityForVerifiedAccount(
        routeId === STICKY_ROUTING_MAIN_ACCOUNT_ID
          ? (storage.mainAccountId ?? routeId)
          : routeId,
        verifiedUuid as ProviderAccountUuid,
      )
    : undefined
  const { body, bodyText, hostTools } = await buildAnthropicRequest(
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
  options.onResolvedTools?.(hostTools)
  const fastMode = body.speed === 'fast'
  const headers = options.apiAccount
    ? new Headers()
    : applyClaudeCodeHeaders(new Headers(), '', {
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
      })
  if (!options.apiAccount && fastMode)
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  const relayAffinity = options.streamOptions?.sessionId ?? null
  let input = options.apiAccount
    ? new URL('https://api.anthropic.com/v1/messages')
    : buildPiOAuthMessagesUrl(options.model.baseUrl)
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: bodyText,
    signal: options.streamOptions?.signal,
    ...(!options.apiAccount && { redirect: 'error' as const }),
  }
  if (!options.apiAccount)
    await cacheKeepManager.track({
      sessionId: relayAffinity,
      url: input.toString(),
      headers,
      bodyText,
      storage,
      cacheMode: isCacheKeepHybridActive(storage) ? 'hybrid' : 'disabled',
      oauthAccountId: routeId,
      oauthAccountIdentity: verifiedUuid,
      accountStoragePath: options.storagePath,
    })

  const reported = new Set<PiNativeAttempt>()
  let retried401 = false
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
  const markUsed = async (attempt: PiNativeAttempt) => {
    if (used.has(attempt)) return
    used.add(attempt)
    await native.markUsed(attempt).catch(() => {
      logger.warn('native-auth', 'Pi account usage publication unavailable')
    })
  }
  const takeAttempt = async () => {
    const attempt =
      nextAttempt ??
      (await native.authorize(
        routeId,
        init.signal ?? undefined,
        options.model.id,
      ))
    nextAttempt = undefined
    if (attempt.accountIdentity !== verifiedUuid)
      throw new Error('Pi native OAuth route identity changed')
    return attempt
  }
  const directFetch = async () => {
    let attempt: PiNativeAttempt | undefined
    let apiSubject: NativeApiSubject | undefined
    if (options.apiAccount) {
      const credential = await (await native.service()).authorizeApi(
        options.apiAccount.id,
        init.signal ?? undefined,
      )
      apiSubject = credential.subject
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
      headers.set('authorization', `Bearer ${piAttemptAccessToken(attempt)}`)
    }
    lastTransport = 'direct'
    try {
      let response = await fetch(input, init)
      if (attempt && response.status === 401) {
        // Report the rejected credential version before retrying, even if its replacement later succeeds.
        await report(attempt, response.status, 'direct')
        const rotated =
          !retried401 && !init.signal?.aborted
            ? await native
                .retry(
                  routeId,
                  attempt,
                  init.signal ?? undefined,
                  options.model.id,
                )
                .catch(() => undefined)
            : undefined
        if (rotated) {
          retried401 = true
          await dumpDirectRequest({
            affinity: relayAffinity,
            route: options.route ?? 'oauth',
            status: response.status,
            bodyText,
            url: input.toString(),
            method: init.method,
            headers,
          })
          await response.body?.cancel().catch(() => {})
          attempt = rotated
          headers.set(
            'authorization',
            `Bearer ${piAttemptAccessToken(rotated)}`,
          )
          response = await fetch(input, init)
        }
      }
      if (attempt) {
        await report(attempt, response.status, 'direct')
        if (response.ok) await markUsed(attempt)
      }
      if (apiSubject && response.ok)
        await (await native.service())
          .publishApi(apiSubject, { lastUsed: Date.now() })
          .catch(() => {
            logger.warn(
              'native-auth',
              'Pi API account usage publication unavailable',
            )
          })
      await dumpDirectRequest({
        affinity: relayAffinity,
        route:
          options.route ??
          (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
        status: response.status,
        bodyText,
        url: input.toString(),
        method: init.method,
        headers: init.headers,
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
        headers: init.headers,
      })
      throw error
    }
  }
  if (options.apiAccount) return directFetch()

  let relay401Attempt: PiNativeAttempt | undefined
  let relayAttempt: PiNativeAttempt | undefined
  const relayReports: Promise<void>[] = []
  const sendRelayAttempt = async () =>
    sendViaRelay({
      config: await (await native.service()).getRelayConfig(),
      input,
      init,
      headers,
      body: bodyText,
      fallback: directFetch,
      affinity: relayAffinity,
      authorizeAttempt: async () => {
        const attempt = await takeAttempt()
        relayAttempt = attempt
        lastTransport = 'relay'
        const authorizedHeaders = new Headers(headers)
        authorizedHeaders.set(
          'authorization',
          `Bearer ${piAttemptAccessToken(attempt)}`,
        )
        return {
          headers: authorizedHeaders,
          onUpstreamStatus: (status) => {
            if (status === 401) {
              relay401Attempt = attempt
              // A WebSocket status may arrive after the response has been returned.
              relayReports.push(report(attempt, status, 'relay_status_field'))
            }
          },
        }
      },
    })
  let response = await sendRelayAttempt()
  await Promise.all(relayReports)
  if (
    relay401Attempt &&
    response.status === 401 &&
    !retried401 &&
    !init.signal?.aborted
  ) {
    const rotated = await native
      .retry(
        routeId,
        relay401Attempt,
        init.signal ?? undefined,
        options.model.id,
      )
      .catch(() => undefined)
    if (rotated) {
      retried401 = true
      await response.body?.cancel().catch(() => {})
      // Use the replacement credential for the next request attempt only. A
      // relay-to-direct fallback obtains a separate authorization.
      nextAttempt = rotated
      relay401Attempt = undefined
      response = await sendRelayAttempt()
      await Promise.all(relayReports)
    }
  }
  if (response.ok && lastTransport === 'relay' && relayAttempt)
    await markUsed(relayAttempt)
  return response
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
  storagePath: string
  effortTransitions?: readonly MidConversationEffortTransition[]
  onResolvedTools?: (tools: Tool[]) => void
}): Promise<Response> {
  const native = getPiNativeRuntime(options.storagePath)
  let snapshot = await native.view()
  let storage = snapshot.policyStorage
  const accountView = (id: string) =>
    snapshot.accounts.find((account) => account.id === id)
  const nativeReady = (id: string) => {
    const account = accountView(id)
    return Boolean(
      account?.type === 'oauth' &&
        account.enabled &&
        (account.source !== 'vault' || account.state === 'active') &&
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

  async function refreshRoutingSnapshot() {
    snapshot = await native.view()
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
        mainQuota = await quotaManager.refreshMain(mainAccountId, '')
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
      if (configured.enabled === false || !isOAuthAccount(configured)) continue
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

  async function tryFallbackAccounts(
    routeOptions: { includeApiRoutes?: boolean; apiOnly?: boolean } = {},
  ) {
    const usableOAuth = await getUsableFallbackAccounts(storage, {
      modelId: options.model.id,
    })
    const usableOAuthById = new Map(
      usableOAuth.map((account) => [account.id, account]),
    )
    for (const configured of storage.accounts) {
      if (configured.enabled === false) continue
      let response: Response | undefined
      if (isOAuthAccount(configured)) {
        if (routeOptions.apiOnly || !nativeReady(configured.id)) continue
        const account = usableOAuthById.get(configured.id) ?? configured
        const quota =
          quotaManager.getFallback(account.id, account)?.quota ?? account.quota
        if (
          !usableOAuthById.has(account.id) &&
          quotaSnapshotHasStandardWindows(quota)
        )
          continue
        if (
          isKillswitchEnabled(storage) &&
          !killswitchPassesPolicy(quota, storage, account.id, options.model.id)
        )
          continue
        response = await sendAnthropicRequest({
          ...options,
          oauthAccountId: account.id,
        })
      } else if (routeOptions.includeApiRoutes) {
        const account = accountView(configured.id)
        if (
          !account?.enabled ||
          account.type !== 'api' ||
          !isValidApiBaseURL(account.baseURL)
        )
          continue
        response = await sendAnthropicRequest({
          ...options,
          apiAccount: account,
        })
      }
      if (!response) continue
      const preflight = await firstStreamingError(response)
      if (preflight instanceof Response && preflight.ok) return preflight
      if (
        preflight instanceof Response &&
        !shouldFallbackStatus(preflight.status, storage)
      )
        return preflight
      await response.body?.cancel().catch(() => {})
    }
    return null
  }

  const routingMode = getRoutingMode(storage)
  if (routingMode === 'sticky-balanced' && options.streamOptions?.sessionId) {
    const sessionId = options.streamOptions.sessionId
    const router = await getPiStickyRouter(options.storagePath)
    const initialInputBytes = Math.max(
      1,
      Buffer.byteLength(JSON.stringify(options.context)),
    )
    let routes = await buildStickyRoutes(options.model.id)
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
          oauthAccountId: selected.id,
          route: `sticky:${selected.id}`,
        })
      const completeRoute = async (
        _selected: PiStickyRoute,
        response: Response,
        _markUsed = true,
      ) => response
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

      const response = await sendRoute(route)
      const preflight = await firstStreamingError(response)
      if (preflight instanceof Response && preflight.ok) {
        return completeRoute(route, preflight)
      }

      const permanentAuthFailure =
        preflight instanceof Response && preflight.status === 401

      let migrate =
        (preflight instanceof Response && preflight.status === 403) ||
        permanentAuthFailure
      if (primaryResponseAllowsApiFallback(preflight)) {
        let quota: OAuthQuotaSnapshot | undefined
        try {
          quota =
            route.id === STICKY_ROUTING_MAIN_ACCOUNT_ID
              ? await quotaManager.refreshMain(mainAccountId, '')
              : await quotaManager.refreshFallback(route.id, '', route.account)
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
        mainQuota = await quotaManager.refreshMain(mainAccountId, '')
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
      buildPiOAuthMessagesUrl(model.baseUrl)
      const storagePath = getPiAccountStoragePath()
      let hostTools: Tool[] = []
      const response = await executeWithFallback({
        model,
        context,
        streamOptions: options,
        storagePath,
        effortTransitions,
        onResolvedTools: (tools) => {
          hostTools = tools
        },
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
              name: fromClaudeCodeToolName(String(block.name), hostTools),
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
