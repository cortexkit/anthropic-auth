import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import type { AccountStorage } from './accounts.ts'
import { dumpRelayRequest } from './dump.ts'
import { parseJsonRedacted } from './json.ts'
import { relayLog } from './logger.ts'
import {
  createProviderErrorResponseScope,
  createProviderErrorStreamScope,
  PROVIDER_ERROR_MAX_BODY_BYTES,
  type ProviderErrorResponseScope,
  ProviderErrorSourceOversizedError,
  type ProviderErrorStreamScope,
  type ProviderResponseMode,
} from './provider-error.ts'
import { raceWithSignal } from './request-abort.ts'
import { SseFrameTooLargeError } from './sse.ts'

export type RelayConfig = {
  enabled: boolean
  url: string
  token: string
  fallbackToDirect: boolean
  transport: 'http' | 'websocket'
}

/** A relay URL whose scheme names a WebSocket endpoint (`ws://` or `wss://`). */
const WEBSOCKET_RELAY_URL = /^wss?:\/\//i

/**
 * The transport a stored relay configuration selects. A stored `http` or
 * `websocket` value always wins. Without one (missing or unrecognized), the
 * URL decides: a `ws://` or `wss://` URL selects WebSocket, so hand-edited
 * WebSocket configurations keep working; any other URL selects HTTP, the
 * documented default. Request dispatch and the relay status shown to users
 * both call this, so they cannot report different transports.
 */
export function effectiveRelayTransport(
  stored: unknown,
  url: unknown,
): RelayConfig['transport'] {
  if (stored === 'http' || stored === 'websocket') return stored
  return typeof url === 'string' && WEBSOCKET_RELAY_URL.test(url.trim())
    ? 'websocket'
    : 'http'
}

/**
 * Secret-free relay status for displays such as the OpenCode sidebar: the
 * transport requests will use, or null when requests cannot use the relay
 * because it is disabled, has no URL or has no token. Native account
 * snapshots never carry the private token; they set `tokenConfigured` to say
 * whether one is stored.
 */
export function effectiveRelayStatus(
  relay: AccountStorage['relay'] | undefined,
): { enabled: true; transport: RelayConfig['transport'] } | null {
  if (relay?.enabled !== true) return null
  if (typeof relay.url !== 'string' || !relay.url.trim()) return null
  const hasToken =
    relay.tokenConfigured === true ||
    (typeof relay.token === 'string' && relay.token.trim() !== '')
  if (!hasToken) return null
  return {
    enabled: true,
    transport: effectiveRelayTransport(relay.transport, relay.url),
  }
}

export type RelayPatch = {
  start: number
  deleteCount: number
  insert: string
}

type RelayPatchSet = RelayPatch | RelayPatch[]

type RelaySessionState = {
  hash: string
  revision: number
  body: string
  updatedAt: number
}

type RelayPayload = {
  protocol: 1 | 2
  type: 'request'
  id?: string
  affinity: string
  upstream: {
    url: string
    method: string
    headers: Record<string, string>
  }
  next_hash: string
  mode: 'full_sync' | 'patch'
  revision: number
  body?: string
  base_hash?: string
  patch?: RelayPatchSet
}

type RelayResponseStart = {
  type: 'response_start'
  id?: string
  status: number
  statusText?: string
  headers?: Record<string, string>
}

type RelayChunk = { type: 'chunk'; id?: string; base64: string }
type RelayDone = {
  type: 'done'
  id?: string
  upstreamChunks?: number
  upstreamBytes?: number
  frames?: number
  frameBytes?: number
}
type RelayKeepalive = { type: 'keepalive' }
type RelayReady = {
  protocol: 2
  type: 'ready'
  state: { hash: string; revision: number } | null
}
type RelayAccepted = {
  protocol: 2
  type: 'accepted'
  id: string
  hash: string
  revision: number
}
type RelayErrorMessage = {
  type: 'error'
  id?: string
  status?: number
  message?: string
}
type RelayControlMessage =
  | RelayReady
  | RelayAccepted
  | RelayResponseStart
  | RelayChunk
  | RelayDone
  | RelayKeepalive
  | RelayErrorMessage

type RelaySendResult = {
  response: Response
  payload: RelayPayload
  transport: 'http' | 'websocket'
  protocol: 1 | 2
  usedRelay: boolean
}

export type RelayAttemptAuthorization = {
  headers: Headers
  /** Called only for a genuine upstream response, never optimistic/transport status. */
  onUpstreamStatus?: (status: number) => void
  /**
   * Additional exact credentials this physical attempt sends upstream, used
   * only to scrub provider error material echoed back for this attempt. The
   * credentials in the outgoing `authorization` and `x-api-key` headers are
   * always scrubbed as well; this list can only add to them.
   */
  errorSecrets?: readonly string[]
}
export type AuthorizeRelayAttempt = () => Promise<RelayAttemptAuthorization>

class RelayAuthorizationError extends Error {
  constructor(readonly failure: unknown) {
    super('Relay request authorization failed')
  }
}

/**
 * Credentials carried by the standard Anthropic credential headers: the whole
 * `authorization` value, its credential without the scheme, and `x-api-key`.
 */
function protocolHeaderSecrets(headers: Record<string, string>): string[] {
  const secrets: string[] = []
  const authorization = headers.authorization?.trim()
  if (authorization) {
    secrets.push(authorization)
    const credential = /^\S+\s+(\S.*)$/.exec(authorization)?.[1]
    if (credential) secrets.push(credential)
  }
  const apiKey = headers['x-api-key']?.trim()
  if (apiKey) secrets.push(apiKey)
  return secrets
}

/**
 * One physical relay attempt: the authorization it sent (if any) and the
 * redaction scope holding exactly that attempt's credentials plus the relay
 * token. Scopes are never shared between attempts, and no credential from an
 * earlier attempt is remembered.
 */
type PhysicalAttempt<Scope> = {
  authorization?: RelayAttemptAuthorization
  scope: Scope
}

async function authorizePhysicalAttempt<Scope>(
  config: RelayConfig,
  payload: RelayPayload,
  authorize: AuthorizeRelayAttempt | undefined,
  createScope: (secrets: readonly string[]) => Scope,
): Promise<PhysicalAttempt<Scope>> {
  try {
    const authorization = authorize ? await authorize() : undefined
    if (authorization)
      payload.upstream = {
        ...payload.upstream,
        headers: jsonHeaders(authorization.headers),
      }
    // The serialized headers are what the attempt actually sends, so their
    // credentials are always included; errorSecrets only adds to them.
    return {
      authorization,
      scope: createScope([
        config.token,
        ...protocolHeaderSecrets(payload.upstream.headers),
        ...(authorization?.errorSecrets ?? []),
      ]),
    }
  } catch (error) {
    throw new RelayAuthorizationError(error)
  }
}

/** Peer-supplied numbers are logged only when they really are finite numbers. */
function logNumber(value: unknown): number | 'unknown' {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown'
}

/**
 * An event stream only when the request body is a JSON object whose `stream`
 * is the boolean true. Anything else, including a body that is not valid
 * JSON, is a plain HTTP response. A parse failure is neither thrown nor
 * logged, and the request is still sent exactly as before.
 */
function requestResponseMode(bodyText: string): ProviderResponseMode {
  let parsed: unknown
  try {
    parsed = parseJsonRedacted(bodyText)
  } catch {
    return 'http'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return 'http'
  return 'stream' in parsed && parsed.stream === true ? 'event-stream' : 'http'
}

class RelayStateMismatchError extends Error {}

/**
 * The upstream already answered, but the relay forwarded a status, status
 * text or header that no Response can carry. The upstream request has run,
 * so neither the HTTP relay nor a direct request may send it again.
 */
class RelayResponseMetadataError extends Error {}

const RELAY_RESPONSE_METADATA_MESSAGE =
  'relay websocket response_start metadata is invalid'

/** Statuses whose Response must have a null body (Fetch standard). */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([
  101, 103, 204, 205, 304,
])

class RelayWebSocketConnectionResetError extends Error {
  readonly code = 'ECONNRESET'
  readonly syscall = 'websocket'
  readonly closeCode?: number
  readonly closeReason?: string
  readonly wasClean?: boolean

  constructor(message: string, event?: CloseEvent) {
    super(message)
    this.name = 'RelayWebSocketConnectionResetError'
    this.closeCode = event?.code
    this.closeReason = event?.reason
    this.wasClean = event?.wasClean
  }
}

const sessionState = new Map<string, RelaySessionState>()
const websocketSessions = new Map<string, PersistentRelaySession>()
const loggedRelayConfigMessages = new Set<string>()
const RELAY_SESSION_STATE_TTL_MS = 2 * 60 * 60_000
const RELAY_WEBSOCKET_IDLE_TTL_MS = 30 * 60_000
const MAX_RELAY_SESSION_STATES = 128
const MAX_RELAY_WEBSOCKET_SESSIONS = 32
let nextRequestId = 0

function createRequestId() {
  nextRequestId += 1
  return `req_${Date.now().toString(36)}_${nextRequestId.toString(36)}`
}

function logRelayConfigOnce(message: string): void {
  if (loggedRelayConfigMessages.has(message)) return
  loggedRelayConfigMessages.add(message)
  relayLog(message)
}

export function getRelayConfig(
  storage: AccountStorage | null,
): RelayConfig | null {
  const relay = storage?.relay
  if (!relay) {
    logRelayConfigOnce('disabled: no relay config found')
    return null
  }
  if (relay.enabled !== true) {
    logRelayConfigOnce('disabled: relay.enabled is not true')
    return null
  }
  if (!relay.url?.trim() || !relay.token?.trim()) {
    logRelayConfigOnce('disabled: missing relay url or token')
    return null
  }
  const transport = effectiveRelayTransport(relay.transport, relay.url)
  logRelayConfigOnce(
    `configured transport=${transport} protocol=${transport === 'websocket' ? 2 : 1} url=${relay.url.trim()} fallbackToDirect=${relay.fallbackToDirect !== false}`,
  )
  return {
    enabled: true,
    url: relay.url.trim(),
    token: relay.token.trim(),
    fallbackToDirect: relay.fallbackToDirect !== false,
    transport,
  }
}

export function generateRelayToken() {
  return randomBytes(32).toString('base64url')
}

export function hashBody(body: string) {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}

export function createStringPatch(previous: string, next: string): RelayPatch {
  let start = 0
  const maxPrefix = Math.min(previous.length, next.length)
  while (
    start < maxPrefix &&
    previous.charCodeAt(start) === next.charCodeAt(start)
  ) {
    start++
  }

  let previousEnd = previous.length
  let nextEnd = next.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd--
    nextEnd--
  }

  return {
    start,
    deleteCount: previousEnd - start,
    insert: next.slice(start, nextEnd),
  }
}

function isNoopPatch(patch: RelayPatch) {
  return patch.deleteCount === 0 && patch.insert.length === 0
}

function findCchTokenRange(body: string) {
  const match = body.match(/\bcch=([0-9a-f]{5});/)
  const token = match?.[1]
  if (!token || match.index == null) return null
  const start = match.index + 'cch='.length
  return { start, end: start + token.length, token }
}

function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
) {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`
}

function createRelayPatch(previous: string, next: string): RelayPatchSet {
  const previousCch = findCchTokenRange(previous)
  const nextCch = findCchTokenRange(next)

  if (
    previousCch &&
    nextCch &&
    previousCch.start === nextCch.start &&
    previousCch.end - previousCch.start === nextCch.end - nextCch.start &&
    previousCch.token !== nextCch.token
  ) {
    const cchPatch = {
      start: previousCch.start,
      deleteCount: previousCch.end - previousCch.start,
      insert: nextCch.token,
    }
    const previousWithNextCch = replaceRange(
      previous,
      previousCch.start,
      previousCch.end,
      nextCch.token,
    )
    const tailPatch = createStringPatch(previousWithNextCch, next)
    return isNoopPatch(tailPatch) ? cchPatch : [cchPatch, tailPatch]
  }

  return createStringPatch(previous, next)
}

function isRelayableAnthropicRequest(
  input: string | URL | Request,
  body: unknown,
) {
  if (typeof body !== 'string') return false
  try {
    const url =
      input instanceof Request ? new URL(input.url) : new URL(input.toString())
    return url.pathname === '/v1/messages' || url.pathname === '/messages'
  } catch {
    return false
  }
}

function jsonHeaders(headers: Headers) {
  const result: Record<string, string> = {}
  for (const [key, value] of headers.entries()) {
    if (key === 'x-session-affinity' || key === 'x-opencode-session') continue
    result[key] = value
  }
  return result
}

async function postRelay(
  config: RelayConfig,
  payload: RelayPayload,
  signal?: AbortSignal | null,
): Promise<Response> {
  signal?.throwIfAborted()
  const stringifyStart = perfNowMs()
  const body = JSON.stringify(payload)
  relayPerfLog('http_payload_stringify', {
    session: shortAffinity(payload.affinity),
    ms: formatMs(perfNowMs() - stringifyStart),
    relayBytes: body.length,
    mode: payload.mode,
  })
  return fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-token': config.token,
    },
    body,
    signal: signal ?? undefined,
  })
}

function shortAffinity(affinity: string) {
  return affinity.length > 12 ? `${affinity.slice(0, 12)}…` : affinity
}

function perfNowMs() {
  return performance.now()
}

function formatMs(value: number) {
  return Math.round(value * 10) / 10
}

function relayPerfLoggingEnabled() {
  return process.env.OPENCODE_ANTHROPIC_AUTH_PERF === '1'
}

function relayPerfLog(stage: string, data: Record<string, unknown>) {
  if (!relayPerfLoggingEnabled()) return
  relayLog(`[perf] relay ${stage} ${JSON.stringify(data)}`)
}

function createRelayPayload(options: {
  input: string | URL | Request
  init: RequestInit | undefined
  headers: Headers
  bodyText: string
  affinity: string
  previous: RelaySessionState | undefined
  nextHash: string
}): RelayPayload {
  const { input, init, headers, bodyText, affinity, previous, nextHash } =
    options
  const rewrittenUrl = input instanceof Request ? input.url : input.toString()
  const basePayload = {
    protocol: 1 as const,
    type: 'request' as const,
    affinity,
    upstream: {
      url: rewrittenUrl,
      method:
        init?.method || (input instanceof Request ? input.method : 'POST'),
      headers: jsonHeaders(headers),
    },
    next_hash: nextHash,
  }

  return previous
    ? {
        ...basePayload,
        mode: 'patch',
        base_hash: previous.hash,
        revision: previous.revision + 1,
        patch: createRelayPatch(previous.body, bodyText),
      }
    : {
        ...basePayload,
        mode: 'full_sync',
        revision: 1,
        body: bodyText,
      }
}

function createFullSyncPayload(
  payload: RelayPayload,
  bodyText: string,
): RelayPayload {
  return {
    protocol: payload.protocol,
    type: 'request',
    affinity: payload.affinity,
    upstream: payload.upstream,
    next_hash: payload.next_hash,
    mode: 'full_sync',
    revision: 1,
    body: bodyText,
  }
}

function updateLocalRelayState(
  affinity: string,
  bodyText: string,
  nextHash: string,
  revision: number,
) {
  const now = Date.now()
  sessionState.delete(affinity)
  sessionState.set(affinity, {
    body: bodyText,
    hash: nextHash,
    revision,
    updatedAt: now,
  })
  cleanupRelaySessionCaches(now)
}

/**
 * POST one physical attempt. Its response is scrubbed by that attempt's own
 * response scope before any status check, fallback decision or host reader
 * sees it, and a rejected POST is scrubbed with the same live scope before
 * the scope is retired. `mode` is the request's protocol, so the scope does
 * not have to trust the response's content type.
 */
async function postRelayAttempt(
  config: RelayConfig,
  payload: RelayPayload,
  signal: AbortSignal | null | undefined,
  authorizeAttempt: AuthorizeRelayAttempt | undefined,
  mode: ProviderResponseMode,
) {
  const { authorization, scope } = await authorizePhysicalAttempt(
    config,
    payload,
    authorizeAttempt,
    (secrets) => createProviderErrorResponseScope(secrets, mode),
  )
  let raw: Response
  try {
    raw = await postRelay(config, payload, signal)
  } catch (error) {
    const safe = scope.redactError(error)
    scope.dispose()
    throw safe
  }
  try {
    return { authorization, scope, response: scope.redactResponse(raw) }
  } catch (error) {
    // Never hand the unscrubbed response on; the scope accepted nothing.
    scope.dispose()
    await raw.body?.cancel().catch(() => {})
    throw error
  }
}

/** Retire an attempt that will not be returned, then release its body. */
async function discardRelayAttempt(attempt: {
  scope: ProviderErrorResponseScope
  response: Response
}) {
  attempt.scope.dispose()
  await attempt.response.body?.cancel().catch(() => {})
}

async function sendRelayHttp(options: {
  config: RelayConfig
  payload: RelayPayload
  bodyText: string
  requestMode: () => ProviderResponseMode
  fallback: () => Promise<Response>
  signal?: AbortSignal | null
  authorizeAttempt?: AuthorizeRelayAttempt
}): Promise<RelaySendResult> {
  const {
    config,
    payload,
    bodyText,
    requestMode,
    fallback,
    signal,
    authorizeAttempt,
  } = options
  // Fixed before the first POST and kept for the 409 full-sync retry.
  const mode = requestMode()
  let actualPayload = payload
  let attempt = await postRelayAttempt(
    config,
    actualPayload,
    signal,
    authorizeAttempt,
    mode,
  )
  if (attempt.response.status === 409 && actualPayload.mode === 'patch') {
    relayLog(
      `state mismatch from relay session=${shortAffinity(actualPayload.affinity)}; retrying full_sync`,
    )
    await discardRelayAttempt(attempt)
    actualPayload = createFullSyncPayload(actualPayload, bodyText)
    attempt = await postRelayAttempt(
      config,
      actualPayload,
      signal,
      authorizeAttempt,
      mode,
    )
  }
  const { response, authorization } = attempt
  // Old workers already forward Anthropic request IDs. Without upstream
  // provenance a relay's own 401 must never invalidate an OAuth credential.
  const upstreamProvenance = /^req_[A-Za-z0-9_-]+$/.test(
    response.headers.get('request-id') ?? '',
  )
  if (response.status === 401 && !upstreamProvenance) {
    // The relay rejected its own credentials, not the Claude account. Never
    // let an account router interpret this as a permanent upstream OAuth 401.
    await discardRelayAttempt(attempt)
    if (config.fallbackToDirect) {
      relayLog(
        `relay authentication rejected; falling back direct session=${shortAffinity(actualPayload.affinity)}`,
      )
      return {
        response: await fallback(),
        payload: actualPayload,
        transport: 'http',
        protocol: actualPayload.protocol,
        usedRelay: false,
      }
    }
    return {
      response: Response.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message:
              'Relay authentication failed before Anthropic received the request',
          },
        },
        { status: 502 },
      ),
      payload: actualPayload,
      transport: 'http',
      protocol: actualPayload.protocol,
      usedRelay: false,
    }
  }
  if (upstreamProvenance) {
    try {
      authorization?.onUpstreamStatus?.(response.status)
    } catch {}
  }
  if (!response.ok && response.status >= 500 && config.fallbackToDirect) {
    relayLog(
      `relay returned ${response.status}; falling back direct session=${shortAffinity(actualPayload.affinity)}`,
    )
    await discardRelayAttempt(attempt)
    return {
      response: await fallback(),
      payload: actualPayload,
      transport: 'http',
      protocol: actualPayload.protocol,
      usedRelay: false,
    }
  }
  return {
    response,
    payload: actualPayload,
    transport: 'http',
    protocol: actualPayload.protocol,
    usedRelay: true,
  }
}

function toWebSocketUrl(url: string, token: string) {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:'
  parsed.pathname = '/ws'
  parsed.searchParams.set('token', token)
  return parsed.toString()
}

function decodeRelayChunk(base64: string) {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

function toBinaryChunk(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  throw new TypeError(
    'relay websocket binary frame must be an ArrayBuffer or byte view',
  )
}

function parseRelayControlMessage(data: string): RelayControlMessage {
  return JSON.parse(data) as RelayControlMessage
}

function formatCloseEvent(event: Event) {
  const close = event as Partial<CloseEvent>
  const parts = [
    `code=${close.code ?? 'unknown'}`,
    `wasClean=${close.wasClean ?? 'unknown'}`,
  ]
  // Peer-supplied close reasons can echo credentials. Keep only protocol metadata.
  return parts.join(' ')
}

function relayControlErrorMessage(
  message: Extract<RelayControlMessage, { type: 'error' }>,
) {
  const detail = message.message || 'relay websocket error'
  return message.status
    ? `relay websocket error ${message.status}: ${detail}`
    : detail
}

type RelayTimerImplementations = {
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
}

/**
 * Redaction for one physical WebSocket attempt, built from that attempt's
 * exact credentials. The stream scope scrubs event-stream bytes and errors.
 * The response scope, created for the request's protocol, is used for every
 * non-optimistic response except a successful one to a streaming request,
 * which the stream scope handles; so a successful non-streaming body stays
 * untouched whatever its content type, and error bodies (which are not SSE
 * frames) are scrubbed. An optimistic response is always an event stream,
 * so there the response scope only scrubs the status line and headers of a
 * non-2xx `response_start` before `onResponseHeaders` sees them. When
 * unused it is retired.
 */
type WebSocketAttemptScopes = {
  stream: ProviderErrorStreamScope
  response: ProviderErrorResponseScope
}

function createWebSocketAttemptScopes(
  secrets: readonly string[],
  responseMode: ProviderResponseMode,
): WebSocketAttemptScopes {
  return {
    stream: createProviderErrorStreamScope(secrets),
    response: createProviderErrorResponseScope(secrets, responseMode),
  }
}

function disposeWebSocketAttemptScopes(scopes: WebSocketAttemptScopes) {
  scopes.stream.dispose()
  scopes.response.dispose()
}

type PendingWebSocketRequest = {
  abortCleanup?: () => void
  payload: RelayPayload
  bodyText: string
  resolve: (response: Response) => void
  reject: (error: unknown) => void
  streamController?: ReadableStreamDefaultController<Uint8Array>
  streamDone: boolean
  accepted: boolean
  responseStarted: boolean
  timeout?: ReturnType<typeof setTimeout>
  resolveDone: () => void
  rejectDone: (error: unknown) => void
  sentAt: number
  optimisticResponse: boolean
  acceptedAt?: number
  responseStartedAt?: number
  streamChunkCount: number
  /**
   * Raw upstream bytes received, counted before redaction. A partial frame
   * held by the scope still counts, and so do bytes a relay sent before its
   * `response_start`, so the retry guard never replays an attempt that has
   * already produced upstream bytes.
   */
  streamByteCount: number
  retryAttempts: number
  retryingBeforeResponse: boolean
  onResponseHeaders?: (headers: Headers) => void
  stagedResponseHeaders?: Headers
  authorizeAttempt?: AuthorizeRelayAttempt
  authorization?: RelayAttemptAuthorization
  /** Current physical attempt's stream scope; cleared when it is retired. */
  scope?: ProviderErrorStreamScope
  /** Current attempt's response scope until its response_start is handled. */
  responseScope?: ProviderErrorResponseScope
  /** Request protocol for response scopes; always an event stream when optimistic. */
  responseMode: ProviderResponseMode
  /** True when the body is a raw upstream body read through a response scope. */
  rawBody: boolean
  /**
   * For a raw non-2xx body: the response scope that wraps the host's body,
   * and the raw bytes received for it so far.
   */
  errorBody?: { scope: ProviderErrorResponseScope; bytes: number }
  /** Set once the host cancelled or the request ended; no attempt may follow. */
  retired: boolean
  responseHeadersDelivered: boolean
}

class PersistentRelaySession {
  private socket?: WebSocket
  private connecting?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private pending?: PendingWebSocketRequest
  private serverState: { hash: string; revision: number } | null | undefined
  private lastUsedAt = Date.now()

  constructor(
    private readonly config: RelayConfig,
    private readonly affinity: string,
    private readonly timers: RelayTimerImplementations,
  ) {}

  touch(now = Date.now()) {
    this.lastUsedAt = now
  }

  canEvict(now = Date.now()) {
    return (
      !this.pending &&
      !this.connecting &&
      now - this.lastUsedAt > RELAY_WEBSOCKET_IDLE_TTL_MS
    )
  }

  dispose() {
    if (this.pending) this.retireAttempt(this.pending)
    this.socket?.close()
    this.socket = undefined
    this.serverState = undefined
    this.connecting = undefined
  }

  send(
    payload: RelayPayload,
    bodyText: string,
    optimisticResponse: boolean,
    onResponseHeaders: ((headers: Headers) => void) | undefined,
    authorizeAttempt: AuthorizeRelayAttempt | undefined,
    responseMode: ProviderResponseMode,
    signal?: AbortSignal | null,
  ): Promise<RelaySendResult> {
    signal?.throwIfAborted()
    this.touch()
    const enqueuedAt = perfNowMs()
    const start = this.queue
      .catch(() => {})
      .then(() =>
        raceWithSignal(signal, () =>
          this.startQueued(
            payload,
            bodyText,
            enqueuedAt,
            optimisticResponse,
            onResponseHeaders,
            authorizeAttempt,
            responseMode,
            signal,
          ),
        ),
      )
    const result = start.then(async ({ response, getPayload }) => ({
      response: await response,
      payload: getPayload(),
      transport: 'websocket' as const,
      protocol: 2 as const,
      usedRelay: true,
    }))
    this.queue = start.then(
      ({ done }) => done.catch(() => {}),
      () => {},
    )
    return raceWithSignal(signal, () => result)
  }

  private async startQueued(
    payload: RelayPayload,
    bodyText: string,
    enqueuedAt: number,
    optimisticResponse: boolean,
    onResponseHeaders: ((headers: Headers) => void) | undefined,
    authorizeAttempt: AuthorizeRelayAttempt | undefined,
    responseMode: ProviderResponseMode,
    signal?: AbortSignal | null,
  ) {
    signal?.throwIfAborted()
    const createScopes = (secrets: readonly string[]) =>
      createWebSocketAttemptScopes(secrets, responseMode)
    const connectStart = perfNowMs()
    await this.ensureConnected()
    signal?.throwIfAborted()
    const connectedAt = perfNowMs()
    const localState = sessionState.get(this.affinity)
    const serverHash = this.serverState?.hash
    const requestPayload: RelayPayload = {
      ...payload,
      protocol: 2,
      id: createRequestId(),
    }

    if (
      requestPayload.mode === 'patch' &&
      (!serverHash || serverHash !== requestPayload.base_hash)
    ) {
      requestPayload.mode = 'full_sync'
      requestPayload.revision = (this.serverState?.revision ?? 0) + 1
      delete requestPayload.base_hash
      delete requestPayload.patch
      requestPayload.body = bodyText
    }
    if (requestPayload.mode === 'patch' && localState) {
      requestPayload.patch = createRelayPatch(localState.body, bodyText)
    }

    relayLog(
      `perf websocket send_start session=${shortAffinity(this.affinity)} request=${requestPayload.id} mode=${requestPayload.mode} queueMs=${formatMs(connectedAt - enqueuedAt)} connectMs=${formatMs(connectedAt - connectStart)} bodyBytes=${bodyText.length} relayBytes=${JSON.stringify(requestPayload).length}`,
    )

    const firstAttempt = await authorizePhysicalAttempt(
      this.config,
      requestPayload,
      authorizeAttempt,
      createScopes,
    )
    if (signal?.aborted) {
      disposeWebSocketAttemptScopes(firstAttempt.scope)
      signal.throwIfAborted()
    }
    let activePayload = requestPayload
    const first = this.sendPayload(
      requestPayload,
      bodyText,
      optimisticResponse,
      onResponseHeaders,
      authorizeAttempt,
      firstAttempt,
      responseMode,
      signal,
    )
    void first.done.catch(() => {})
    let activeDone = first.done
    const response = first.response.catch(async (error) => {
      if (
        !(error instanceof RelayStateMismatchError) ||
        requestPayload.mode !== 'patch'
      ) {
        throw error
      }
      const fullSync = createFullSyncPayload(requestPayload, bodyText)
      fullSync.protocol = 2
      fullSync.id = createRequestId()
      fullSync.revision = (this.serverState?.revision ?? 0) + 1
      const retryAttempt = await authorizePhysicalAttempt(
        this.config,
        fullSync,
        authorizeAttempt,
        createScopes,
      )
      if (signal?.aborted) {
        disposeWebSocketAttemptScopes(retryAttempt.scope)
        signal.throwIfAborted()
      }
      activePayload = fullSync
      const retry = this.sendPayload(
        fullSync,
        bodyText,
        optimisticResponse,
        onResponseHeaders,
        authorizeAttempt,
        retryAttempt,
        responseMode,
        signal,
      )
      void retry.done.catch(() => {})
      activeDone = retry.done
      return retry.response
    })
    const done = response.then(
      () => activeDone,
      () => activeDone.catch(() => {}),
    )
    // Cancellation can happen before the queued caller receives the request handle.
    void done.catch(() => {})
    return { response, done, getPayload: () => activePayload }
  }

  private async ensureConnected() {
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.serverState !== undefined
    )
      return
    if (this.connecting) return await this.connecting

    this.connecting = new Promise<void>((resolve, reject) => {
      const url = toWebSocketUrl(this.config.url, this.config.token)
      const parsed = new URL(url)
      parsed.searchParams.set('affinity', this.affinity)
      const socket = new WebSocket(parsed.toString())
      // Node defaults to Blob frames, which cannot enter the synchronous byte pipeline.
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      this.serverState = undefined

      const timeout = this.timers.setTimeout(() => {
        socket.close()
        reject(new Error('relay websocket ready timed out'))
      }, 15_000)

      socket.addEventListener('message', (event) => {
        try {
          if (typeof event.data !== 'string') {
            this.handleBinaryChunk(event.data)
            return
          }
          const message = parseRelayControlMessage(event.data)
          if (message.type === 'ready') {
            this.timers.clearTimeout(timeout)
            this.serverState = message.state
            resolve()
            return
          }
          this.handleMessage(message)
        } catch (error) {
          this.timers.clearTimeout(timeout)
          reject(error)
          this.failPending(error)
          socket.close()
        }
      })

      socket.addEventListener('error', () => {
        this.timers.clearTimeout(timeout)
        const error = new RelayWebSocketConnectionResetError(
          'relay websocket error',
        )
        reject(error)
        this.failPending(error)
      })

      socket.addEventListener('close', (event) => {
        this.timers.clearTimeout(timeout)
        if (this.socket === socket) {
          this.socket = undefined
          this.serverState = undefined
          this.connecting = undefined
        }
        // A socket that was already replaced (a retry, or a request that
        // ended early) has no say over the request now in flight.
        if (this.socket !== undefined) return
        if (this.pending) {
          if (this.pending.retryingBeforeResponse) return
          // Any upstream bytes forbid replay, even when the relay sent them
          // before response_start. Report that close as an already-started response.
          const closedAfterResponseStart =
            this.pending.responseStartedAt != null ||
            this.pending.streamByteCount > 0
          const reason = closedAfterResponseStart
            ? 'closed after response_start before stream bytes'
            : 'closed before response'
          if (this.retryPendingBeforeResponse(this.pending, reason, event))
            return
          const error = closedAfterResponseStart
            ? new RelayWebSocketConnectionResetError(
                'relay websocket closed during response stream',
                event,
              )
            : new Error('relay websocket closed before response')
          relayLog(
            `websocket ${closedAfterResponseStart ? 'closed during response stream' : 'closed before response without retry'} session=${shortAffinity(this.affinity)} request=${this.pending.payload.id} chunks=${this.pending.streamChunkCount} bytes=${this.pending.streamByteCount} ${formatCloseEvent(event)}`,
          )
          this.failPending(error)
        }
      })
    }).finally(() => {
      this.connecting = undefined
    })

    await this.connecting
  }

  private sendPayload(
    payload: RelayPayload,
    bodyText: string,
    optimisticResponse: boolean,
    onResponseHeaders: ((headers: Headers) => void) | undefined,
    authorizeAttempt: AuthorizeRelayAttempt | undefined,
    attempt: PhysicalAttempt<WebSocketAttemptScopes>,
    responseMode: ProviderResponseMode,
    signal?: AbortSignal | null,
  ) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      disposeWebSocketAttemptScopes(attempt.scope)
      throw new Error('relay websocket is not connected')
    }
    const sentAt = perfNowMs()

    let resolveDone!: () => void
    let rejectDone!: (error: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    const response = new Promise<Response>((resolve, reject) => {
      const pending: PendingWebSocketRequest = {
        payload,
        bodyText,
        resolve,
        reject,
        streamDone: false,
        accepted: false,
        responseStarted: false,
        resolveDone,
        rejectDone,
        sentAt,
        optimisticResponse,
        streamChunkCount: 0,
        streamByteCount: 0,
        retryAttempts: 0,
        retryingBeforeResponse: false,
        onResponseHeaders,
        authorizeAttempt,
        authorization: attempt.authorization,
        scope: attempt.scope.stream,
        responseScope: attempt.scope.response,
        responseMode,
        rawBody: false,
        retired: false,
        stagedResponseHeaders: undefined,
        responseHeadersDelivered: false,
      }
      this.pending = pending
      if (signal) {
        const abort = () => {
          if (this.pending !== pending) return
          // Keep the caller's timeout reason unchanged when failing the request.
          this.failPending(signal.reason, false)
          const socket = this.socket
          this.socket = undefined
          this.serverState = undefined
          this.connecting = undefined
          socket?.close()
        }
        pending.abortCleanup = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
      }
      this.resetPendingTimeout(pending)
      socket.send(JSON.stringify(payload))
      if (optimisticResponse) {
        this.resolvePendingResponse(pending, 200, 'OK', {
          'content-type': 'text/event-stream',
          'x-cortexkit-relay-optimistic': 'true',
        })
      }
    })
    return { response, done }
  }

  private resetPendingTimeout(pending: PendingWebSocketRequest) {
    this.timers.clearTimeout(pending.timeout)
    pending.timeout = this.timers.setTimeout(() => {
      if (this.pending !== pending) return
      if (this.retryPendingBeforeResponse(pending, 'response timed out')) return
      this.failPending(new Error('relay websocket response timed out'))
      this.socket?.close()
    }, 45_000)
  }

  private retryPendingBeforeResponse(
    pending: PendingWebSocketRequest,
    reason: string,
    closeEvent?: Event,
  ) {
    // Upstream bytes mean the upstream request has run. A replay would send it
    // again, and on an optimistic stream it would append a second attempt's
    // bytes to the first's, so bytes forbid a retry even when a relay sent
    // them before its response_start.
    if (pending.streamByteCount > 0) return false
    if (pending.streamDone) return false
    // A non-optimistic response has already handed the host its real status,
    // headers and a body bound to this attempt's credentials. A replay could
    // not change that status, and its body would be scrubbed with the wrong
    // attempt's credentials, so it ends here. An optimistic response carries
    // only the synthetic status, so it may still retry before any byte.
    if (!pending.optimisticResponse && pending.responseStarted) return false
    // A cancelled request gets no further physical attempt.
    if (pending.retired) return false
    if (pending.retryAttempts >= 1) return false

    pending.retryAttempts += 1
    pending.retryingBeforeResponse = true
    this.timers.clearTimeout(pending.timeout)
    const attempt = pending.retryAttempts
    const originalId = pending.payload.id
    relayLog(
      `websocket ${reason}; reconnecting and retrying full_sync session=${shortAffinity(this.affinity)} request=${originalId} retry=${attempt} chunks=${pending.streamChunkCount} bytes=${pending.streamByteCount}${closeEvent ? ` ${formatCloseEvent(closeEvent)}` : ''}`,
    )

    this.socket?.close()
    this.socket = undefined
    this.serverState = undefined
    this.connecting = undefined

    void (async () => {
      try {
        await this.ensureConnected()
        if (this.pending !== pending) return
        if (pending.retired) return this.endCancelledRetry(pending)
        const retryPayload = createFullSyncPayload(
          pending.payload,
          pending.bodyText,
        )
        retryPayload.protocol = 2
        retryPayload.id = createRequestId()
        retryPayload.revision = (this.serverState?.revision ?? 0) + 1

        const retryAttempt = await authorizePhysicalAttempt(
          this.config,
          retryPayload,
          pending.authorizeAttempt,
          (secrets) =>
            createWebSocketAttemptScopes(secrets, pending.responseMode),
        )
        if (this.pending !== pending || pending.streamDone || pending.retired) {
          disposeWebSocketAttemptScopes(retryAttempt.scope)
          if (this.pending === pending && pending.retired)
            this.endCancelledRetry(pending)
          return
        }
        // The new physical attempt replaces the old one's credentials before
        // anything is sent on its behalf.
        this.installAttempt(pending, retryAttempt)
        pending.payload = retryPayload
        pending.accepted = false
        pending.acceptedAt = undefined
        pending.responseStartedAt = undefined
        pending.stagedResponseHeaders = undefined
        pending.responseHeadersDelivered = false
        pending.sentAt = perfNowMs()
        pending.retryingBeforeResponse = false

        const socket = this.socket
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error('relay websocket is not connected')
        }
        this.resetPendingTimeout(pending)
        relayLog(
          `perf websocket retry_send session=${shortAffinity(this.affinity)} request=${retryPayload.id} previous=${originalId} mode=full_sync retry=${attempt} bodyBytes=${pending.bodyText.length} relayBytes=${JSON.stringify(retryPayload).length}`,
        )
        socket.send(JSON.stringify(retryPayload))
      } catch (error) {
        pending.retryingBeforeResponse = false
        if (this.pending !== pending) return
        // An authorization failure is the host's own error, passed on as is.
        if (error instanceof RelayAuthorizationError)
          this.failPending(error.failure, false)
        else this.failPending(error)
      }
    })()

    return true
  }

  /**
   * The host cancelled while a retry was reconnecting or being authorized:
   * end the request instead of sending an attempt nobody will read.
   */
  private endCancelledRetry(pending: PendingWebSocketRequest) {
    pending.retryingBeforeResponse = false
    this.failPending(new Error('relay websocket response was cancelled'), false)
  }

  /** Replace the current attempt's credentials with a new attempt's. */
  private installAttempt(
    pending: PendingWebSocketRequest,
    attempt: PhysicalAttempt<WebSocketAttemptScopes>,
  ) {
    pending.scope?.dispose()
    pending.responseScope?.dispose()
    pending.authorization = attempt.authorization
    pending.scope = attempt.scope.stream
    // An optimistic retry keeps its response scope too: the new attempt's
    // response_start headers still need it.
    pending.responseScope = attempt.scope.response
  }

  /**
   * Drop the attempt's credentials: its scopes and the authorization holding
   * the headers it sent. Byte counters and the retry guard are kept.
   */
  private retireAttempt(pending: PendingWebSocketRequest) {
    pending.retired = true
    pending.abortCleanup?.()
    pending.abortCleanup = undefined
    pending.scope?.dispose()
    pending.scope = undefined
    pending.responseScope?.dispose()
    pending.responseScope = undefined
    // The response handed to the host still owns its error-body redactor.
    // Reading or cancelling that body retires it; drop only this reference.
    pending.errorBody = undefined
    pending.authorization = undefined
  }

  /** Remove credential echoes using the current attempt's redaction scope. */
  private redactAttemptError(pending: PendingWebSocketRequest, error: unknown) {
    // Without a live scope the error cannot be checked, so none of it is kept.
    return pending.scope
      ? pending.scope.redactError(error)
      : new Error('relay websocket request ended')
  }

  private enqueueStreamChunk(
    pending: PendingWebSocketRequest,
    chunk: Uint8Array,
  ) {
    this.deliverResponseHeaders(pending)
    pending.streamChunkCount += 1
    pending.streamByteCount += chunk.byteLength
    this.forwardStreamBytes(pending, chunk)
  }

  /**
   * Every byte for the host, upstream or synthesized, passes through the
   * current attempt's scope before it is enqueued. A raw body is enqueued
   * as is because its response scope scrubs it when the host reads it.
   */
  private forwardStreamBytes(
    pending: PendingWebSocketRequest,
    bytes: Uint8Array,
  ) {
    const controller = pending.streamController
    const scope = pending.scope
    // No stream yet (bytes before response_start) or the attempt is retired.
    if (!controller || !scope) return
    if (pending.rawBody) {
      const errorBody = pending.errorBody
      if (errorBody) {
        // Counted before enqueue, so no more than the bound is ever queued.
        errorBody.bytes += bytes.byteLength
        if (errorBody.bytes > PROVIDER_ERROR_MAX_BODY_BYTES) {
          this.endOversizedErrorBody(pending, controller, errorBody.scope)
          return
        }
      }
      controller.enqueue(bytes)
      return
    }
    let output: Uint8Array[]
    try {
      output = scope.push(bytes)
    } catch (error) {
      // The scope has already cleared its credentials. The frame-limit error
      // contains only a fixed message and byte counts, so it is safe to keep.
      // Other failures become generic errors: their text can no longer be
      // checked against the credentials that this attempt sent.
      this.failPending(error, !(error instanceof SseFrameTooLargeError))
      this.socket?.close()
      return
    }
    for (const chunk of output) controller.enqueue(chunk)
  }

  /**
   * A non-2xx body grew past the bound its response scope accepts. Erroring
   * the source drops every byte already queued, and the source-oversized
   * error makes the scope's body emit only its fixed oversized message,
   * which needs no credentials, so the scope retires now instead of when
   * the host reads or drops the response. The status and headers the host
   * already holds stay as they are. The request ends without a replay, and
   * the socket closes so the relay stops sending the rest of the body.
   */
  private endOversizedErrorBody(
    pending: PendingWebSocketRequest,
    controller: ReadableStreamDefaultController<Uint8Array>,
    responseScope: ProviderErrorResponseScope,
  ) {
    controller.error(new ProviderErrorSourceOversizedError())
    responseScope.dispose()
    relayLog(
      `websocket error body exceeded the redaction bound; ending request session=${shortAffinity(this.affinity)} request=${pending.payload.id} chunks=${pending.streamChunkCount} bytes=${pending.streamByteCount}`,
    )
    this.timers.clearTimeout(pending.timeout)
    pending.streamDone = true
    this.retireAttempt(pending)
    pending.authorizeAttempt = undefined
    pending.onResponseHeaders = undefined
    pending.resolveDone()
    if (this.pending === pending) this.pending = undefined
    // Detach the socket before closing it, so the next queued request opens
    // a new connection instead of reusing one that is closing.
    const socket = this.socket
    this.socket = undefined
    this.serverState = undefined
    this.connecting = undefined
    socket?.close()
  }

  private deliverResponseHeaders(pending: PendingWebSocketRequest) {
    if (
      pending.responseHeadersDelivered ||
      pending.stagedResponseHeaders == null
    )
      return
    pending.responseHeadersDelivered = true
    try {
      pending.onResponseHeaders?.(pending.stagedResponseHeaders)
    } catch {}
  }

  private handleBinaryChunk(data: unknown) {
    const pending = this.pending
    if (!pending?.responseStarted) return
    this.enqueueStreamChunk(pending, toBinaryChunk(data))
  }

  /**
   * Hand the host its response: the synthetic optimistic one, or the real
   * one from a non-optimistic response_start. The Response is built before
   * the request is marked as started, because its constructor rejects a
   * status, status text or header that the relay forwarded but no Response
   * can carry; the request then fails instead of never being answered.
   */
  private resolvePendingResponse(
    pending: PendingWebSocketRequest,
    status: number,
    statusText?: string,
    headers?: Record<string, string>,
  ) {
    if (pending.responseStarted) return
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    // A null-body status gets no stream (some runtimes refuse to build such a
    // Response with one); bytes a relay still sends for it are dropped.
    const stream = NULL_BODY_STATUSES.has(status)
      ? null
      : new ReadableStream<Uint8Array>({
          start: (streamController) => {
            controller = streamController
          },
          cancel: () => {
            this.retireAttempt(pending)
            this.socket?.close()
          },
        })
    let response: Response
    try {
      response = new Response(stream, { status, statusText, headers })
    } catch {
      this.failInvalidResponseStart()
      return
    }
    pending.responseStarted = true
    pending.streamController = controller
    // Resolving the optimistic placeholder must not clear responseScope.
    // The real response_start still needs it to scrub error headers.
    if (pending.optimisticResponse) {
      pending.resolve(response)
      return
    }
    const responseScope = pending.responseScope
    pending.responseScope = undefined
    // The request's protocol decides the pipeline, never the response's
    // content type. A successful response to a streaming request goes
    // through the stream scope; everything else goes through the response
    // scope, which leaves a successful non-streaming body untouched and
    // scrubs error responses.
    const streamed = response.ok && pending.responseMode === 'event-stream'
    if (streamed || !responseScope) {
      responseScope?.dispose()
      // The scope is gone once the attempt was retired (cancelled or ended);
      // then non-2xx headers cannot be checked, so onResponseHeaders gets none.
      if (headers && response.ok)
        pending.stagedResponseHeaders = new Headers(response.headers)
      pending.resolve(response)
      return
    }
    // Remove echoed credentials from error bodies using the request's mode.
    pending.rawBody = true
    let scrubbed: Response
    try {
      scrubbed = responseScope.redactResponse(response)
    } catch (error) {
      // Never hand the unscrubbed response on.
      pending.responseStarted = false
      this.failPending(error)
      this.socket?.close()
      return
    }
    // onResponseHeaders sees exactly the headers the host's response carries:
    // untouched on success, scrubbed by this attempt's scope otherwise.
    if (headers) pending.stagedResponseHeaders = new Headers(scrubbed.headers)
    if (!response.ok && stream)
      pending.errorBody = { scope: responseScope, bytes: 0 }
    pending.resolve(scrubbed)
  }

  /**
   * An optimistic response has already gone out, so a real response_start
   * only supplies the headers for onResponseHeaders. A success's headers are
   * kept exactly; a non-2xx response's status line and headers go through
   * this attempt's response scope, as a non-optimistic error response's do.
   * Returns false when the metadata cannot form a Response and the request
   * has been failed.
   */
  private stageOptimisticResponseHeaders(
    pending: PendingWebSocketRequest,
    message: RelayResponseStart,
  ) {
    const responseScope = pending.responseScope
    pending.responseScope = undefined
    let upstream: Response
    try {
      upstream = new Response(null, {
        status: message.status,
        statusText: message.statusText,
        headers: message.headers,
      })
    } catch {
      responseScope?.dispose()
      this.failInvalidResponseStart()
      return false
    }
    if (!message.headers) {
      responseScope?.dispose()
      return true
    }
    if (upstream.ok) {
      responseScope?.dispose()
      pending.stagedResponseHeaders = new Headers(upstream.headers)
      return true
    }
    // The scope is gone once the attempt was retired (cancelled or ended);
    // then non-2xx headers cannot be checked, so onResponseHeaders gets none.
    if (!responseScope) return true
    try {
      pending.stagedResponseHeaders = new Headers(
        responseScope.redactResponse(upstream).headers,
      )
    } catch {
      // If redactResponse throws, the scope retires itself and the headers
      // are withheld.
    }
    return true
  }

  /**
   * End the request with a fixed error: the rejected metadata may echo
   * credentials, and the upstream has already answered, so nothing may
   * resend it.
   */
  private failInvalidResponseStart() {
    this.failPending(
      new RelayResponseMetadataError(RELAY_RESPONSE_METADATA_MESSAGE),
      false,
    )
    this.socket?.close()
  }

  private handleMessage(message: RelayControlMessage) {
    if (message.type === 'keepalive') {
      if (this.pending) this.resetPendingTimeout(this.pending)
      return
    }
    const pending = this.pending
    if (!pending) return
    if ('id' in message && message.id && message.id !== pending.payload.id)
      return

    if (message.type === 'accepted') {
      const acceptedAt = perfNowMs()
      pending.accepted = true
      pending.acceptedAt = acceptedAt
      relayLog(
        `perf websocket accepted session=${shortAffinity(this.affinity)} request=${pending.payload.id} sentMs=${formatMs(acceptedAt - pending.sentAt)} mode=${pending.payload.mode}`,
      )
      this.serverState = { hash: message.hash, revision: message.revision }
      updateLocalRelayState(
        this.affinity,
        pending.bodyText,
        message.hash,
        message.revision,
      )
      this.resetPendingTimeout(pending)
      return
    }
    if (message.type === 'response_start') {
      if (pending.responseStartedAt != null) return
      const responseStartedAt = perfNowMs()
      pending.responseStartedAt = responseStartedAt
      try {
        pending.authorization?.onUpstreamStatus?.(message.status)
      } catch {}
      relayLog(
        `perf websocket response_start session=${shortAffinity(this.affinity)} request=${pending.payload.id} sentMs=${formatMs(responseStartedAt - pending.sentAt)} upstreamMs=${pending.acceptedAt == null ? 'unknown' : formatMs(responseStartedAt - pending.acceptedAt)} status=${logNumber(message.status)}`,
      )
      this.timers.clearTimeout(pending.timeout)
      if (!pending.optimisticResponse) {
        this.resolvePendingResponse(
          pending,
          message.status,
          message.statusText,
          message.headers,
        )
        return
      }
      if (!this.stageOptimisticResponseHeaders(pending, message)) return
      if (message.status >= 400) {
        this.deliverResponseHeaders(pending)
        this.forwardStreamBytes(
          pending,
          new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'relay_upstream_error', message: `Relay upstream returned HTTP ${message.status}` } })}\n\n`,
          ),
        )
        this.finishPending()
      }
      return
    }
    if (message.type === 'chunk') {
      this.enqueueStreamChunk(pending, decodeRelayChunk(message.base64))
      return
    }
    if (message.type === 'done') {
      this.finishPending(message)
      return
    }
    if (message.type === 'error') {
      // If an optimistic response is already streaming (responseStartedAt is
      // set), the pending promise was already resolved — calling failPending
      // would reject a settled promise and leave the stream hanging. Instead,
      // inject an SSE error event and close cleanly.
      if (pending.optimisticResponse && pending.responseStartedAt != null) {
        relayLog(
          `websocket relay error during optimistic response session=${shortAffinity(this.affinity)} request=${pending.payload.id} status=${Number.isFinite(message.status) ? message.status : 'unknown'} code=relay_stream_error chunks=${pending.streamChunkCount} bytes=${pending.streamByteCount}`,
        )
        this.deliverResponseHeaders(pending)
        this.forwardStreamBytes(
          pending,
          new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'relay_error', message: message.message || 'relay error' } })}\n\n`,
          ),
        )
        this.finishPending()
        this.socket?.close()
        return
      }
      // The peer's message is never logged or kept: a fixed stage names the
      // retry, and the state-mismatch error carries no peer text.
      if (
        message.status === 409 &&
        this.retryPendingBeforeResponse(pending, 'state mismatch')
      ) {
        return
      }
      const error =
        message.status === 409
          ? new RelayStateMismatchError('state mismatch')
          : new Error(relayControlErrorMessage(message))
      this.failPending(error)
    }
  }

  private finishPending(done?: RelayDone) {
    const pending = this.pending
    if (!pending) return
    const finishedAt = perfNowMs()
    const workerStats =
      done && 'frames' in done
        ? ` upstreamChunks=${logNumber(done.upstreamChunks)} upstreamBytes=${logNumber(done.upstreamBytes)} frames=${logNumber(done.frames)} frameBytes=${logNumber(done.frameBytes)}`
        : ''
    relayLog(
      `perf websocket done session=${shortAffinity(this.affinity)} request=${pending.payload.id} sentMs=${formatMs(finishedAt - pending.sentAt)} streamMs=${pending.responseStartedAt == null ? 'unknown' : formatMs(finishedAt - pending.responseStartedAt)} chunks=${pending.streamChunkCount} bytes=${pending.streamByteCount}${workerStats}`,
    )
    this.timers.clearTimeout(pending.timeout)
    try {
      if (!pending.streamDone) {
        this.deliverResponseHeaders(pending)
        pending.streamDone = true
        // An unterminated last frame is still scrubbed before delivery.
        const tail = pending.rawBody ? [] : (pending.scope?.finish() ?? [])
        for (const chunk of tail) pending.streamController?.enqueue(chunk)
        pending.streamController?.close()
      }
    } finally {
      this.retireAttempt(pending)
      pending.authorizeAttempt = undefined
      pending.onResponseHeaders = undefined
    }
    pending.resolveDone()
    this.pending = undefined
  }

  /**
   * End the request with an error scrubbed by the current attempt's live
   * credentials, then retire them. Callers pass `redact = false` only for
   * errors that hold no provider text: the error the host's own
   * `authorizeAttempt` threw (returned to the host unchanged), and errors
   * this class builds from fixed messages.
   */
  private failPending(error: unknown, redact = true) {
    const pending = this.pending
    if (!pending) return
    const safe = redact ? this.redactAttemptError(pending, error) : error
    this.timers.clearTimeout(pending.timeout)
    this.pending = undefined
    this.retireAttempt(pending)
    pending.authorizeAttempt = undefined
    pending.onResponseHeaders = undefined
    if (pending.responseStarted) {
      pending.streamController?.error(safe)
    } else {
      pending.reject(safe)
    }
    pending.rejectDone(safe)
  }
}

function cleanupRelaySessionCaches(now = Date.now()) {
  for (const [affinity, state] of sessionState) {
    if (now - state.updatedAt > RELAY_SESSION_STATE_TTL_MS) {
      sessionState.delete(affinity)
    }
  }
  while (sessionState.size > MAX_RELAY_SESSION_STATES) {
    const oldest = sessionState.keys().next().value
    if (oldest === undefined) break
    sessionState.delete(oldest)
  }

  for (const [affinity, session] of websocketSessions) {
    if (session.canEvict(now)) {
      session.dispose()
      websocketSessions.delete(affinity)
    }
  }
  while (websocketSessions.size > MAX_RELAY_WEBSOCKET_SESSIONS) {
    let evicted = false
    for (const [affinity, session] of websocketSessions) {
      if (!session.canEvict(now)) continue
      session.dispose()
      websocketSessions.delete(affinity)
      evicted = true
      break
    }
    if (!evicted) break
  }
}

function getPersistentRelaySession(
  config: RelayConfig,
  affinity: string,
  timers: RelayTimerImplementations,
) {
  cleanupRelaySessionCaches()
  const existing = websocketSessions.get(affinity)
  if (existing) {
    existing.touch()
    return existing
  }
  const session = new PersistentRelaySession(config, affinity, timers)
  websocketSessions.set(affinity, session)
  cleanupRelaySessionCaches()
  return session
}

export async function sendViaRelay(options: {
  config: RelayConfig | null
  input: string | URL | Request
  init: RequestInit | undefined
  headers: Headers
  body: RequestInit['body'] | null | undefined
  fallback: () => Promise<Response>
  affinity?: string | null
  /**
   * Resolve a WebSocket send with a synthetic 200 event stream before the
   * upstream answers. Honoured only for streaming requests (body `stream` is
   * true); any other request waits for the real response on the same
   * WebSocket transport.
   */
  optimisticResponse?: boolean
  /** Fresh authorization for every physical relay attempt, including internal retries. */
  authorizeAttempt?: AuthorizeRelayAttempt
  /**
   * Observes genuine upstream headers once per delivered response. WebSocket
   * retries before downstream bytes replace staged headers, so the callback
   * receives only the final accepted response; duplicate response_start frames
   * within an attempt are ignored.
   */
  onResponseHeaders?: (headers: Headers) => void
  dumpTag?: import('./dump.ts').DumpTag
  onDumpCreated?: (handle: import('./dump.ts').DumpHandle) => void
  setTimeoutImpl?: typeof globalThis.setTimeout
  clearTimeoutImpl?: typeof globalThis.clearTimeout
  /**
   * Checks the URL the relay will forward to (the envelope's upstream.url)
   * and throws to refuse it. Runs before anything is sent, relay or direct;
   * its error reaches the caller unchanged and never triggers a fallback.
   */
  requireUpstreamUrl?: (url: string) => unknown
}): Promise<Response> {
  const {
    config,
    input,
    init,
    headers,
    body,
    fallback,
    affinity: explicitAffinity,
    optimisticResponse,
    authorizeAttempt,
    onResponseHeaders,
    dumpTag,
    onDumpCreated,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    requireUpstreamUrl,
  } = options
  requireUpstreamUrl?.(input instanceof Request ? input.url : input.toString())
  if (!config || !isRelayableAnthropicRequest(input, body)) return fallback()

  const affinity =
    explicitAffinity ||
    headers.get('x-session-affinity') ||
    headers.get('x-opencode-session')
  if (!affinity) {
    relayLog('skipping relay: missing x-session-affinity header')
    return fallback()
  }

  const bodyText = body as string
  const hashStart = perfNowMs()
  const nextHash = hashBody(bodyText)
  relayPerfLog('hash_body', {
    session: shortAffinity(affinity),
    ms: formatMs(perfNowMs() - hashStart),
    bodyBytes: bodyText.length,
  })
  const previous = sessionState.get(affinity)
  const payloadStart = perfNowMs()
  const payload = createRelayPayload({
    input,
    init,
    headers,
    bodyText,
    affinity,
    previous,
    nextHash,
  })
  relayPerfLog('create_payload', {
    session: shortAffinity(affinity),
    ms: formatMs(perfNowMs() - payloadStart),
    mode: payload.mode,
    bodyBytes: bodyText.length,
    previousBytes: previous?.body.length,
  })
  // The request's protocol, decoded at most once per send, and only once a
  // relay transport is chosen.
  let responseMode: ProviderResponseMode | undefined
  const requestMode = () => {
    responseMode ??= requestResponseMode(bodyText)
    return responseMode
  }
  // The direct fallback runs at most once per request. Once it has started,
  // its request may already have reached Anthropic (a connection can reset
  // after the body was sent), so its failure goes to the caller instead of
  // sending the same request again.
  let directFallbackStarted = false
  const directFallback = () => {
    directFallbackStarted = true
    return fallback()
  }
  try {
    let result: RelaySendResult
    const sendStart = perfNowMs()
    if (config.transport === 'websocket') {
      try {
        const session = getPersistentRelaySession(config, affinity, {
          setTimeout: setTimeoutImpl,
          clearTimeout: clearTimeoutImpl,
        })
        // Only a streaming request can be answered with a synthetic event
        // stream; a non-streaming one waits for the real status and body.
        const optimistic =
          optimisticResponse === true && requestMode() === 'event-stream'
        result = await session.send(
          payload,
          bodyText,
          optimistic,
          onResponseHeaders,
          authorizeAttempt,
          requestMode(),
          init?.signal,
        )
      } catch (error) {
        init?.signal?.throwIfAborted()
        if (
          error instanceof RelayAuthorizationError ||
          error instanceof RelayResponseMetadataError
        )
          throw error
        relayLog(
          `websocket relay failed session=${shortAffinity(affinity)}; trying http relay code=relay_transport_error`,
        )
        result = await sendRelayHttp({
          config,
          payload,
          bodyText,
          requestMode,
          fallback: directFallback,
          signal: init?.signal,
          authorizeAttempt,
        })
      }
    } else {
      result = await sendRelayHttp({
        config,
        payload,
        bodyText,
        requestMode,
        fallback: directFallback,
        signal: init?.signal,
        authorizeAttempt,
      })
    }

    relayPerfLog('send', {
      session: shortAffinity(affinity),
      ms: formatMs(perfNowMs() - sendStart),
      transport: result.transport,
      protocol: result.protocol,
      mode: result.payload.mode,
      status: result.response.status,
      usedRelay: result.usedRelay,
    })

    if (!result.usedRelay) return result.response

    if (result.transport === 'http') {
      try {
        onResponseHeaders?.(result.response.headers)
      } catch {}
    }

    if (result.transport === 'http') {
      updateLocalRelayState(
        affinity,
        bodyText,
        result.payload.next_hash,
        result.payload.revision,
      )
    }

    const payloadStringifyStart = perfNowMs()
    const actualPayloadBytes = JSON.stringify(result.payload).length
    relayPerfLog('payload_stringify', {
      session: shortAffinity(affinity),
      ms: formatMs(perfNowMs() - payloadStringifyStart),
      relayBytes: actualPayloadBytes,
    })
    relayLog(
      `used relay transport=${result.transport} protocol=${result.protocol} mode=${result.payload.mode} status=${result.response.status} session=${shortAffinity(affinity)} bodyBytes=${bodyText.length} relayBytes=${actualPayloadBytes}`,
    )
    const dumpStart = perfNowMs()
    const dumpHandle = await dumpRelayRequest({
      affinity,
      transport: result.transport,
      protocol: result.protocol,
      mode: result.payload.mode,
      status: result.response.status,
      bodyText,
      previousBodyText: previous?.body,
      payload: result.payload,
      relayBytes: actualPayloadBytes,
      tag: dumpTag,
    })
    try {
      if (dumpHandle) onDumpCreated?.(dumpHandle)
    } catch {}
    relayPerfLog('dump', {
      session: shortAffinity(affinity),
      ms: formatMs(perfNowMs() - dumpStart),
      enabled: true,
    })
    return result.response
  } catch (error) {
    init?.signal?.throwIfAborted()
    if (error instanceof RelayAuthorizationError) throw error.failure
    // The upstream already answered this request; a direct fallback would
    // send it a second time.
    if (error instanceof RelayResponseMetadataError) throw error
    if (directFallbackStarted) {
      relayLog(
        `direct fallback failed session=${shortAffinity(affinity)}; not sending it again code=relay_transport_error`,
      )
      throw error
    }
    if (!config.fallbackToDirect) {
      relayLog(
        `relay failed session=${shortAffinity(affinity)} and fallbackToDirect=false code=relay_transport_error`,
      )
      throw error
    }
    relayLog(
      `relay failed; falling back direct session=${shortAffinity(affinity)} code=relay_transport_error`,
    )
    return fallback()
  }
}

export const WORKER_SCRIPT = `
async function hashBody(body) {
  const bytes = new TextEncoder().encode(body)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return 'sha256:' + hex
}

function applyPatch(base, patch) {
  return base.slice(0, patch.start) + patch.insert + base.slice(patch.start + patch.deleteCount)
}

function applyPatchSet(base, patch) {
  if (!Array.isArray(patch)) return applyPatch(base, patch)
  if (patch.length === 0) return base

  let result = ''
  let cursor = 0
  for (const item of patch) {
    if (item.start < cursor) return { error: 'overlapping patch', status: 400 }
    result += base.slice(cursor, item.start)
    result += item.insert
    cursor = item.start + item.deleteCount
  }
  return result + base.slice(cursor)
}

async function readState(env, affinity) {
  const raw = await env.RELAY_STATE.get('session:' + affinity)
  return raw ? JSON.parse(raw) : null
}

async function writeState(env, affinity, state) {
  await env.RELAY_STATE.put('session:' + affinity, JSON.stringify(state), { expirationTtl: 86400 })
}

async function resolveBody(env, payload) {
  if (payload.mode === 'full_sync') return payload.body
  if (payload.mode === 'patch') {
    const state = await readState(env, payload.affinity)
    if (!state || state.hash !== payload.base_hash) {
      return { error: 'state mismatch', status: 409 }
    }
    return applyPatchSet(state.body, payload.patch)
  }
  return { error: 'unknown mode', status: 400 }
}

async function prepareUpstream(env, payload) {
  if ((payload.protocol !== 1 && payload.protocol !== 2) || payload.type !== 'request' || !payload.affinity || !payload.upstream?.url || !payload.next_hash) {
    return { error: 'invalid payload', status: 400 }
  }

  const body = await resolveBody(env, payload)
  if (body && typeof body === 'object' && 'error' in body) return body

  if (typeof body !== 'string' || (await hashBody(body)) !== payload.next_hash) {
    return { error: 'hash mismatch', status: 409 }
  }

  const stateWrite = writeState(env, payload.affinity, { body, hash: payload.next_hash, revision: payload.revision }).catch(() => {})
  console.log(JSON.stringify({
    relay: 'opencode-anthropic-auth',
    transport: 'relay',
    mode: payload.mode,
    revision: payload.revision,
    affinity: String(payload.affinity).slice(0, 12),
    bodyBytes: body.length,
  }))

  return { body, stateWrite }
}

function resolveBodyFromState(state, payload) {
  if (payload.mode === 'full_sync') return payload.body
  if (payload.mode === 'patch') {
    if (!state || state.hash !== payload.base_hash) {
      return { error: 'state mismatch', status: 409 }
    }
    return applyPatchSet(state.body, payload.patch)
  }
  return { error: 'unknown mode', status: 400 }
}

function deferWorkerTask(task) {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(task)
}

const WEBSOCKET_STREAM_FLUSH_BYTES = 1024
const WEBSOCKET_STREAM_FLUSH_MS = 20

function createWebSocketStreamCoalescer(socket, options = {}) {
  const flushBytes = options.flushBytes || WEBSOCKET_STREAM_FLUSH_BYTES
  const flushMs = options.flushMs ?? WEBSOCKET_STREAM_FLUSH_MS
  let chunks = []
  let byteLength = 0
  let flushTimer = null
  const stats = {
    upstreamChunks: 0,
    upstreamBytes: 0,
    frames: 0,
    frameBytes: 0,
  }

  const clearFlushTimer = () => {
    if (flushTimer === null) return
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const mergeChunks = () => {
    if (chunks.length === 1) return chunks[0]
    const frame = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      frame.set(chunk, offset)
      offset += chunk.byteLength
    }
    return frame
  }

  const flush = () => {
    clearFlushTimer()
    if (byteLength === 0) return
    const frame = mergeChunks()
    chunks = []
    byteLength = 0
    socket.send(frame)
    stats.frames += 1
    stats.frameBytes += frame.byteLength
  }

  const scheduleFlush = () => {
    if (flushTimer !== null) return
    flushTimer = setTimeout(flush, flushMs)
  }

  return {
    push(value) {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      if (chunk.byteLength === 0) return
      stats.upstreamChunks += 1
      stats.upstreamBytes += chunk.byteLength
      chunks.push(chunk)
      byteLength += chunk.byteLength
      if (byteLength >= flushBytes) flush()
      else scheduleFlush()
    },
    flush,
    stats() {
      return { ...stats, pendingBytes: byteLength }
    },
  }
}

function checkpointWebSocketState(env, payload, body, nextState) {
  return deferWorkerTask(async () => {
    try {
      if ((await hashBody(body)) !== payload.next_hash) {
        throw new Error('hash mismatch')
      }
      await writeState(env, payload.affinity, nextState)
    } catch {
      console.log(JSON.stringify({
        relay: 'opencode-anthropic-auth',
        transport: 'websocket',
        event: 'checkpoint_write_failed',
        affinity: String(payload.affinity).slice(0, 12),
        code: 'checkpoint_write_error',
      }))
    }
  })
}

async function prepareWebSocketUpstream(env, state, payload) {
  if (payload.protocol !== 2 || payload.type !== 'request' || !payload.id || !payload.affinity || !payload.upstream?.url || !payload.next_hash) {
    return { error: 'invalid payload', status: 400 }
  }

  const body = resolveBodyFromState(state, payload)
  if (body && typeof body === 'object' && 'error' in body) return body
  if (typeof body !== 'string') return { error: 'invalid body', status: 400 }
  if ((await hashBody(body)) !== payload.next_hash) {
    return { error: 'hash mismatch', status: 409 }
  }

  const nextState = { body, hash: payload.next_hash, revision: payload.revision }
  const checkpoint = checkpointWebSocketState(env, payload, body, nextState)
  const logAccepted = () => console.log(JSON.stringify({
    relay: 'opencode-anthropic-auth',
    transport: 'websocket',
    mode: payload.mode,
    revision: payload.revision,
    affinity: String(payload.affinity).slice(0, 12),
    bodyBytes: body.length,
  }))

  return { body, state: nextState, checkpoint, logAccepted }
}

function headersToObject(headers) {
  const result = {}
  for (const [key, value] of headers.entries()) result[key] = value
  return result
}

async function handleRelayPayload(env, payload) {
  const prepared = await prepareUpstream(env, payload)
  if (prepared.error) return prepared
  const upstream = await fetch(payload.upstream.url, {
    method: payload.upstream.method || 'POST',
    headers: payload.upstream.headers,
    body: prepared.body,
  })
  return { upstream, stateWrite: prepared.stateWrite }
}

async function handleWebSocket(socket, env, ctx, payload, getState, setState) {
  const heartbeat = setInterval(() => {
    try {
      socket.send(JSON.stringify({ protocol: 2, type: 'keepalive' }))
    } catch {
      clearInterval(heartbeat)
    }
  }, 15000)
  let streamCoalescer = null
  try {
    const result = await prepareWebSocketUpstream(env, getState(), payload)
    if (result.error) {
      socket.send(JSON.stringify({ protocol: 2, type: 'error', id: payload.id, status: result.status, message: result.error }))
      return
    }

    setState(result.state)
    socket.send(JSON.stringify({ protocol: 2, type: 'accepted', id: payload.id, hash: result.state.hash, revision: result.state.revision }))
    ctx?.waitUntil?.(deferWorkerTask(result.logAccepted))

    const upstreamPromise = fetch(payload.upstream.url, {
      method: payload.upstream.method || 'POST',
      headers: payload.upstream.headers,
      body: result.body,
    })
    ctx?.waitUntil?.(result.checkpoint)
    const upstream = await upstreamPromise
    socket.send(JSON.stringify({
      protocol: 2,
      type: 'response_start',
      id: payload.id,
      status: upstream.status,
      statusText: upstream.statusText,
      headers: headersToObject(upstream.headers),
    }))

    const reader = upstream.body?.getReader()
    if (reader) {
      streamCoalescer = createWebSocketStreamCoalescer(socket)
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        streamCoalescer.push(value)
      }
      streamCoalescer.flush()
    }
    const stats = streamCoalescer?.stats?.() || {}
    socket.send(JSON.stringify({ protocol: 2, type: 'done', id: payload.id, ...stats }))
  } catch (error) {
    try {
      streamCoalescer?.flush?.()
    } catch {}
    socket.send(JSON.stringify({ protocol: 2, type: 'error', id: payload.id, status: 500, message: error instanceof Error ? error.message : String(error) }))
  } finally {
    clearInterval(heartbeat)
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const url = new URL(request.url)
      const token = url.searchParams.get('token')
      const affinity = url.searchParams.get('affinity')
      if (token !== env.RELAY_TOKEN) return new Response('unauthorized', { status: 401 })
      if (!affinity) return new Response('missing affinity', { status: 400 })
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      server.binaryType = 'arraybuffer'
      let state = null
      let ready = false
      server.accept()
      const loadState = readState(env, affinity).then((loadedState) => {
        state = loadedState
        ready = true
        server.send(JSON.stringify({
          protocol: 2,
          type: 'ready',
          state: state ? { hash: state.hash, revision: state.revision } : null,
        }))
      }).catch((error) => {
        server.send(JSON.stringify({ protocol: 2, type: 'error', status: 500, message: error instanceof Error ? error.message : String(error) }))
        server.close(1011, 'state load failed')
      })
      ctx?.waitUntil?.(loadState)
      if (!ctx?.waitUntil) void loadState
      let busy = false
      server.addEventListener('message', (event) => {
        if (!ready) {
          server.send(JSON.stringify({ protocol: 2, type: 'error', status: 425, message: 'relay state is not ready' }))
          return
        }
        if (busy) {
          server.send(JSON.stringify({ protocol: 2, type: 'error', status: 429, message: 'request already in flight' }))
          return
        }
        let payload
        try {
          payload = JSON.parse(event.data)
        } catch {
          server.send(JSON.stringify({ protocol: 2, type: 'error', status: 400, message: 'invalid JSON payload' }))
          return
        }
        payload.affinity = affinity
        busy = true
        const run = handleWebSocket(server, env, ctx, payload, () => state, (nextState) => { state = nextState }).finally(() => { busy = false })
        ctx?.waitUntil?.(run)
        if (!ctx?.waitUntil) void run
      })
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method === 'GET') {
      return Response.json({ status: 'ok', transports: ['http', 'websocket'] })
    }
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (request.headers.get('x-relay-token') !== env.RELAY_TOKEN) {
      return new Response('unauthorized', { status: 401 })
    }

    try {
      const payload = await request.json()
      const result = await handleRelayPayload(env, payload)
      if (result.error) return Response.json({ error: result.error }, { status: result.status })

      if (result.stateWrite) ctx.waitUntil(result.stateWrite)

      const upstream = result.upstream
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      })
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'internal relay error' },
        { status: 502 },
      )
    }
  },
}
`
