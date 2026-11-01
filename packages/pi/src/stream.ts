import {
  type AccountStorage,
  type ApiKeyAccount,
  applyClaudeCodeHeaders,
  applyCustomHeaders,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  CacheKeepSessionRegistry,
  type ClaudeCodeIdentity,
  createNativeVaultNoRouteResponse,
  createProviderErrorResponseScope,
  createSseFramer,
  createStickyNoRouteResponse,
  decideStickyQuotaFailure,
  decodeSseFrame,
  dumpDirectRequest,
  FAST_MODE_BETA,
  getCache1hPersistentMode,
  getClaudeCodeIdentityForVerifiedAccount,
  getDefaultCacheKeepRegistryDirectory,
  getFallbackReauthLabels,
  getQuotaCheckIntervalMs,
  getRequestGzipLatch,
  getRequestGzipLatchPath,
  getRoutingMode,
  getScopedQuotaWindowForModel,
  getThinkingPrefixMismatchBehavior,
  isCache1hPersistentlyEnabled,
  isCacheKeepHybridActive,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isKillswitchEnabled,
  isNativeTransientAccountError,
  isOAuthAccount,
  isPermanentRefreshError,
  isValidApiBaseURL,
  killswitchPassesPolicy,
  logger,
  type MidConversationEffortTransition,
  mergeAnthropicBetas,
  NativeAccountRefusal,
  type NativeAccountSnapshot,
  type NativeAccountView,
  type NativeApiSubject,
  nativeAccountCanServe,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type ProviderAccountUuid,
  type ProviderErrorResponseScope,
  parseSseFrame,
  QuotaManager,
  type QuotaManagerOptions,
  type QuotaState,
  quotaBackoffActive,
  quotaExhaustionFromHeaders,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  runWithRequestSignal,
  STICKY_ROUTING_MAIN_ACCOUNT_ID,
  type StickyRouteCandidate,
  StickySessionRouter,
  sendViaRelay,
  sendWithRequestGzip,
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

/** Dump label for a physical send that failed before any response arrived. */
const PHYSICAL_SEND_FAILED = 'physical send failed before a response'

let cacheKeepRegistry: CacheKeepSessionRegistry | undefined
let cacheKeepRegistryDirectory: string | undefined
const stickyRouters = new Map<string, StickySessionRouter>()
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

/**
 * Sets the Claude Code headers for a Pi OAuth request to Anthropic, with the
 * betas this body needs. Model requests and CacheKeep prewarms both call it:
 * a prewarm replays a model request's body, and Anthropic needs the same
 * betas to accept it (for example, the effort beta for the empty
 * `role: "system"` effort markers in a Fable 5.1 body). `leadingBetas` appends
 * adapter-requested feature betas without changing Core's model-beta selection.
 */
function applyPiOAuthRequestHeaders(
  headers: Headers,
  accessToken: string,
  options: {
    body: Record<string, unknown>
    identity: ClaudeCodeIdentity | undefined
    leadingBetas?: string[]
  },
) {
  const { body } = options
  applyClaudeCodeHeaders(headers, accessToken, {
    body,
    identity: options.identity,
    extraBetas: options.leadingBetas,
  })
  if (body.speed === 'fast')
    headers.set(
      'anthropic-beta',
      mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
    )
  return headers
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
    })
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
      if (done) break
      for (const frame of framer.push(value)) {
        const data = parseSseFrame(decodeSseFrame(frame, { streamStart })).data
        streamStart = false
        if (!data || data === '[DONE]') continue
        yield JSON.parse(data) as AnthropicEvent
      }
    }
  } finally {
    // Only the lock is released when the consumer stops early: cancelling the
    // body on abandonment is the consumer's decision, not the parser's.
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
  // Capture the serving service while authorization is open. Shutdown rejects
  // new serving work immediately but drains writes for already-served attempts.
  const servingRuntime = await native.service()
  const snapshot = await native.view()
  const storage = snapshot.policyStorage
  setDumpEnabled(isDumpPersistentlyEnabled(storage))
  const routeId = options.oauthAccountId ?? STICKY_ROUTING_MAIN_ACCOUNT_ID
  const selected = snapshot.accounts.find((account) => account.id === routeId)
  let verifiedUuid = options.apiAccount ? undefined : selected?.accountIdentity
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
      turnEndNote: storage.turnEndNote,
      thinkingPrefixMismatchBehavior: options.apiAccount
        ? 'account-default'
        : getThinkingPrefixMismatchBehavior(storage),
    },
  )
  options.onResolvedTools?.(hostTools)
  const fastMode = body.speed === 'fast'
  const headers = options.apiAccount
    ? new Headers()
    : applyPiOAuthRequestHeaders(new Headers(), '', { body, identity })
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
  const markServed = (attempt: PiNativeAttempt) => {
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
      const scope = createProviderErrorResponseScope([secret], 'event-stream')
      physical.scope = scope
      // OAuth bodies go gzipped as Claude Code sends them; `bodyText` stays
      // the signed identity text for dumps and CacheKeep.
      if (options.apiAccount || typeof init.body !== 'string')
        return scope.redactResponse(await fetch(input, init))
      return scope.redactResponse(
        await sendWithRequestGzip({
          url: input,
          body: init.body,
          headers,
          latch: getRequestGzipLatch(
            getRequestGzipLatchPath(options.storagePath),
          ),
          send: (wireBody, wireHeaders) =>
            fetch(input, { ...init, body: wireBody, headers: wireHeaders }),
        }),
      )
    }
    let response: Response
    try {
      response = await send()
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
          // Retire the rejected send's credentials before cancelling its
          // body, since that cancellation may never settle.
          physical.scope?.dispose()
          await response.body?.cancel().catch(() => {})
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
    } catch (caught) {
      // No response leaves this send, so its credentials retire here.
      physical.scope?.dispose()
      const scope = createProviderErrorResponseScope([secret], 'event-stream')
      const error = scope.redactError(caught)
      scope.dispose()
      await dumpDirectRequest({
        affinity: relayAffinity,
        route:
          options.route ??
          (options.apiAccount ? `api:${options.apiAccount.id}` : 'oauth'),
        // A fixed label: the error text can repeat provider output or a credential.
        error: PHYSICAL_SEND_FAILED,
        bodyText,
        url: input.toString(),
        method: init.method,
        headers: init.headers,
      })
      throw error
    }
    if (apiSubject && response.ok) {
      const subject = apiSubject
      native.usagePublications.publish(() =>
        servingRuntime.publishApi(subject, { lastUsed: Date.now() }),
      )
    }
    if (attempt && response.ok) markServed(attempt)
    return response
  }
  if (options.apiAccount) return directFetch()

  let relay401Attempt: PiNativeAttempt | undefined
  let relayAttempt: PiNativeAttempt | undefined
  const relayReports: Promise<void>[] = []
  // The relay scrubs each physical relay attempt's responses and errors with
  // that attempt's own credentials and the relay token; a direct fallback is
  // scrubbed by directFetch.
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
        const access = piAttemptAccessToken(attempt)
        authorizedHeaders.set('authorization', `Bearer ${access}`)
        return {
          headers: authorizedHeaders,
          errorSecrets: [access],
          onUpstreamStatus: (status) => {
            if (status === 401) {
              relay401Attempt = attempt
              // The relay can report an upstream 401 after returning the streaming response.
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
  if (response.ok && lastTransport === 'relay' && relayAttempt)
    markServed(relayAttempt)
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
  const inspected = replay(true)
  return { response: inspected, preflight: inspected }
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
  let snapshot = await native.requestView(options.streamOptions?.signal)
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
      if (!nativeAccountCanServe(configured)) continue
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
          !nativeAccountCanServe(account) ||
          account?.type !== 'api' ||
          !isValidApiBaseURL(account.baseURL)
        )
          continue
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
      await inspected.response.body?.cancel().catch(() => {})
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
      // Keep an existing route after a temporary quota poll failure, but do not
      // choose a new balanced route until the account pool has current quota data.
      candidates: incompleteQuotaPool ? [] : routes.candidates,
      retainAccountIds: routes.retainAccountIds,
      accountIdentities: vaultAccountIdentities(),
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
      if (snapshot.mode === 'claustrum')
        return createNativeVaultNoRouteResponse({
          snapshot: await native.view(),
          modelId: options.model.id,
          sticky: true,
        })
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
                  'Sticky OAuth account quota resets shortly; retaining session affinity.',
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

      const { response, preflight } = await firstStreamingError(
        await sendRoute(route),
      )
      if (preflight instanceof Response && preflight.ok) {
        return completeRoute(route, preflight)
      }

      const permanentAuthFailure =
        preflight instanceof Response && preflight.status === 401

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
                    'Sticky OAuth account quota resets shortly; retaining session affinity.',
                },
              }),
              { status: 429, headers },
            ),
          )
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
    if (snapshot.mode === 'claustrum')
      return createNativeVaultNoRouteResponse({
        snapshot: await native.view(),
        modelId: options.model.id,
      })
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
      const response = await runWithRequestSignal(options?.signal, () =>
        executeWithFallback({
          model,
          context,
          streamOptions: options,
          storagePath,
          effortTransitions,
          onResolvedTools: (tools) => {
            hostTools = tools
          },
        }),
      )

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
