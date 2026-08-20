import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import type { AccountStorage } from './accounts.ts'
import { dumpRelayRequest } from './dump.ts'
import { relayLog } from './logger.ts'

export type RelayConfig = {
  enabled: boolean
  url: string
  token: string
  fallbackToDirect: boolean
  transport: 'http' | 'websocket'
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

class RelayStateMismatchError extends Error {}

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
  const transport = relay.transport === 'http' ? 'http' : 'websocket'
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

async function sendRelayHttp(options: {
  config: RelayConfig
  payload: RelayPayload
  bodyText: string
  fallback: () => Promise<Response>
  signal?: AbortSignal | null
}): Promise<RelaySendResult> {
  const { config, payload, bodyText, fallback, signal } = options
  let actualPayload = payload
  let response = await postRelay(config, actualPayload, signal)
  if (response.status === 409 && actualPayload.mode === 'patch') {
    relayLog(
      `state mismatch from relay session=${shortAffinity(actualPayload.affinity)}; retrying full_sync`,
    )
    await response.body?.cancel().catch(() => {})
    actualPayload = createFullSyncPayload(actualPayload, bodyText)
    response = await postRelay(config, actualPayload, signal)
  }
  if (!response.ok && response.status >= 500 && config.fallbackToDirect) {
    relayLog(
      `relay returned ${response.status}; falling back direct session=${shortAffinity(actualPayload.affinity)}`,
    )
    await response.body?.cancel().catch(() => {})
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
  return new Uint8Array(Buffer.from(String(data)))
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
  if (close.reason) parts.push(`reason=${JSON.stringify(close.reason)}`)
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

type PendingWebSocketRequest = {
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
  streamByteCount: number
  retryAttempts: number
  retryingBeforeResponse: boolean
  onResponseHeaders?: (headers: Headers) => void
  stagedResponseHeaders?: Headers
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
    this.socket?.close()
    this.socket = undefined
    this.serverState = undefined
    this.connecting = undefined
  }

  send(
    payload: RelayPayload,
    bodyText: string,
    optimisticResponse = false,
    onResponseHeaders?: (headers: Headers) => void,
  ): Promise<RelaySendResult> {
    this.touch()
    const enqueuedAt = perfNowMs()
    const start = this.queue
      .catch(() => {})
      .then(() =>
        this.startQueued(
          payload,
          bodyText,
          enqueuedAt,
          optimisticResponse,
          onResponseHeaders,
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
    return result
  }

  private async startQueued(
    payload: RelayPayload,
    bodyText: string,
    enqueuedAt: number,
    optimisticResponse: boolean,
    onResponseHeaders?: (headers: Headers) => void,
  ) {
    const connectStart = perfNowMs()
    await this.ensureConnected()
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

    let activePayload = requestPayload
    const first = this.sendPayload(
      requestPayload,
      bodyText,
      optimisticResponse,
      onResponseHeaders,
    )
    void first.done.catch(() => {})
    let activeDone = first.done
    const response = first.response.catch((error) => {
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
      activePayload = fullSync
      const retry = this.sendPayload(
        fullSync,
        bodyText,
        optimisticResponse,
        onResponseHeaders,
      )
      void retry.done.catch(() => {})
      activeDone = retry.done
      return retry.response
    })
    const done = response.then(
      () => activeDone,
      () => activeDone.catch(() => {}),
    )
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
        if (this.pending) {
          if (this.pending.retryingBeforeResponse) return
          const closedAfterResponseStart =
            this.pending.responseStartedAt != null
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
    onResponseHeaders?: (headers: Headers) => void,
  ) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
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
        stagedResponseHeaders: undefined,
        responseHeadersDelivered: false,
      }
      this.pending = pending
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
    if (pending.responseStartedAt != null && pending.streamByteCount > 0)
      return false
    if (pending.streamDone) return false
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
        const retryPayload = createFullSyncPayload(
          pending.payload,
          pending.bodyText,
        )
        retryPayload.protocol = 2
        retryPayload.id = createRequestId()
        retryPayload.revision = (this.serverState?.revision ?? 0) + 1

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
        if (this.pending === pending) this.failPending(error)
      }
    })()

    return true
  }

  private enqueueStreamChunk(
    pending: PendingWebSocketRequest,
    chunk: Uint8Array,
  ) {
    this.deliverResponseHeaders(pending)
    pending.streamChunkCount += 1
    pending.streamByteCount += chunk.byteLength
    pending.streamController?.enqueue(chunk)
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

  private resolvePendingResponse(
    pending: PendingWebSocketRequest,
    status: number,
    statusText?: string,
    headers?: Record<string, string>,
  ) {
    if (pending.responseStarted) return
    pending.responseStarted = true
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        pending.streamController = controller
      },
      cancel: () => {
        this.socket?.close()
      },
    })
    pending.resolve(
      new Response(stream, {
        status,
        statusText,
        headers,
      }),
    )
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
      relayLog(
        `perf websocket response_start session=${shortAffinity(this.affinity)} request=${pending.payload.id} sentMs=${formatMs(responseStartedAt - pending.sentAt)} upstreamMs=${pending.acceptedAt == null ? 'unknown' : formatMs(responseStartedAt - pending.acceptedAt)} status=${message.status}`,
      )
      clearTimeout(pending.timeout)
      if (message.headers)
        pending.stagedResponseHeaders = new Headers(message.headers)
      this.resolvePendingResponse(
        pending,
        message.status,
        message.statusText,
        message.headers,
      )
      if (pending.optimisticResponse && message.status >= 400) {
        this.deliverResponseHeaders(pending)
        pending.streamController?.enqueue(
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
          `websocket relay error during optimistic response session=${shortAffinity(this.affinity)} request=${pending.payload.id} status=${message.status} message=${message.message || 'unknown'} chunks=${pending.streamChunkCount} bytes=${pending.streamByteCount}`,
        )
        this.deliverResponseHeaders(pending)
        pending.streamController?.enqueue(
          new TextEncoder().encode(
            `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'relay_error', message: message.message || 'relay error' } })}\n\n`,
          ),
        )
        this.finishPending()
        this.socket?.close()
        return
      }
      if (
        message.status === 409 &&
        this.retryPendingBeforeResponse(
          pending,
          message.message || 'state mismatch',
        )
      ) {
        return
      }
      const error =
        message.status === 409
          ? new RelayStateMismatchError(message.message || 'state mismatch')
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
        ? ` upstreamChunks=${done.upstreamChunks ?? 'unknown'} upstreamBytes=${done.upstreamBytes ?? 'unknown'} frames=${done.frames} frameBytes=${done.frameBytes ?? 'unknown'}`
        : ''
    relayLog(
      `perf websocket done session=${shortAffinity(this.affinity)} request=${pending.payload.id} sentMs=${formatMs(finishedAt - pending.sentAt)} streamMs=${pending.responseStartedAt == null ? 'unknown' : formatMs(finishedAt - pending.responseStartedAt)} chunks=${pending.streamChunkCount} bytes=${pending.streamByteCount}${workerStats}`,
    )
    this.timers.clearTimeout(pending.timeout)
    if (!pending.streamDone) {
      this.deliverResponseHeaders(pending)
      pending.streamDone = true
      pending.streamController?.close()
    }
    pending.resolveDone()
    this.pending = undefined
  }

  private failPending(error: unknown) {
    const pending = this.pending
    if (!pending) return
    this.timers.clearTimeout(pending.timeout)
    this.pending = undefined
    if (pending.responseStarted) {
      pending.streamController?.error(error)
    } else {
      pending.reject(error)
    }
    pending.rejectDone(error)
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
  optimisticResponse?: boolean
  /**
   * Observes genuine upstream headers once per delivered response. WebSocket
   * retries before downstream bytes replace staged headers, so the callback
   * receives only the final accepted response; duplicate response_start frames
   * within an attempt are ignored.
   */
  onResponseHeaders?: (headers: Headers) => void
  onDumpCreated?: (handle: { responsePath: string; tag?: 'cachekeep' }) => void
  setTimeoutImpl?: typeof globalThis.setTimeout
  clearTimeoutImpl?: typeof globalThis.clearTimeout
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
    onResponseHeaders,
    onDumpCreated,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = options
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
  try {
    let result: RelaySendResult
    const sendStart = perfNowMs()
    if (config.transport === 'websocket') {
      try {
        const session = getPersistentRelaySession(config, affinity, {
          setTimeout: setTimeoutImpl,
          clearTimeout: clearTimeoutImpl,
        })
        result = await session.send(
          payload,
          bodyText,
          optimisticResponse === true,
          onResponseHeaders,
        )
      } catch (error) {
        relayLog(
          `websocket relay failed session=${shortAffinity(affinity)}; trying http relay: ${error instanceof Error ? error.message : String(error)}`,
        )
        result = await sendRelayHttp({
          config,
          payload,
          bodyText,
          fallback,
          signal: init?.signal,
        })
      }
    } else {
      result = await sendRelayHttp({
        config,
        payload,
        bodyText,
        fallback,
        signal: init?.signal,
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
    if (!config.fallbackToDirect) {
      relayLog(
        `relay failed session=${shortAffinity(affinity)} and fallbackToDirect=false: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
    relayLog(
      `relay failed; falling back direct session=${shortAffinity(affinity)}: ${error instanceof Error ? error.message : String(error)}`,
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
    } catch (error) {
      console.log(JSON.stringify({
        relay: 'opencode-anthropic-auth',
        transport: 'websocket',
        event: 'checkpoint_write_failed',
        affinity: String(payload.affinity).slice(0, 12),
        message: error instanceof Error ? error.message : String(error),
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
