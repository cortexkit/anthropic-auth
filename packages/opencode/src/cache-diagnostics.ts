import {
  setBounded,
  stickyRetryAfterWithJitter,
} from '@cortexkit/anthropic-auth-core'

export const CACHE_DIAGNOSTICS_BETA = 'cache-diagnosis-2026-04-07'
export const CACHE_DIAGNOSTICS_LOG_PREFIX = 'MC-CACHE-DIAG '
export const CACHE_DIAGNOSTICS_SESSION_LIMIT = 1_000
export const CACHE_DIAGNOSTICS_SHORT_GAP_MS = 5 * 60_000

export type CacheDiagnosticsState =
  | 'absent'
  | 'server_null'
  | 'pending'
  | 'populated'

export type CacheDiagnosticsSource = string

export const CACHE_DIAGNOSTICS_SOURCE_SYNTHETIC = {
  turn: false,
  prewarm_cachekeep: true,
} as const

export const CACHE_DIAGNOSTICS_BETAS_LIMIT = 1_000

export type CacheDiagnosticsRecord = {
  v: 2
  source: CacheDiagnosticsSource
  account_id: string
  synthetic: boolean
  betas_hash: string
  requested_model?: string
  session_id: string
  ts_ms_received: number
  model: string
  is_subagent: boolean
  ttl_sent: '1h' | '5m' | null
  cache_read: number
  cache_creation: number
  input_tokens: number
  ephemeral_5m_tokens: number
  ephemeral_1h_tokens: number
  message_id: string
  previous_message_id: string | null
  diag_state: CacheDiagnosticsState
  miss_reason?: string
  cache_missed_input_tokens?: number
}

export type CacheDiagnosticsRequestContext = {
  sessionId: string
  previousMessageId: string | null
  previousMessageReceivedAt?: number
  isSubagent: boolean
  ttlSent: '1h' | '5m' | null
}

type CapturedMessage = { messageId: string; receivedAt: number }

export class CacheDiagnosticsTracker {
  private readonly entries = new Map<string, CapturedMessage>()

  previousFor(sessionId: string): CapturedMessage | null {
    return this.entries.get(sessionId) ?? null
  }

  capture(sessionId: string, messageId: string, receivedAt: number): void {
    setBounded(
      this.entries,
      sessionId,
      { messageId, receivedAt },
      CACHE_DIAGNOSTICS_SESSION_LIMIT,
    )
  }
}

export class CacheDiagnosticsBetaTracker {
  private readonly hashes = new Map<string, true>()

  capture(hash: string, betas: string[]): string | null {
    if (this.hashes.has(hash)) return null
    setBounded(this.hashes, hash, true, CACHE_DIAGNOSTICS_BETAS_LIMIT)
    return `MC-CACHE-DIAG-BETAS ${JSON.stringify({
      hash,
      betas: [...betas].sort(),
    })}`
  }
}

export function copyCacheDiagnosticsContext<T>(
  contexts: WeakMap<Response, T>,
  source: Response,
  destination: Response,
): void {
  const context = contexts.get(source)
  if (context) contexts.set(destination, context)
}

export async function withStickyRetryAfter(
  response: Response,
  sessionId: string,
  retryAfterSeconds: number,
  streamingRateLimit: boolean,
  contexts: WeakMap<Response, unknown>,
) {
  const headers = new Headers(response.headers)
  headers.set(
    'retry-after',
    String(stickyRetryAfterWithJitter(sessionId, retryAfterSeconds)),
  )
  if (streamingRateLimit) {
    await response.body?.cancel().catch(() => {})
    headers.set('content-type', 'application/json')
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message:
            'Sticky OAuth account five-hour quota resets shortly; retaining session affinity.',
        },
      }),
      { status: 429, headers },
    )
  }
  const retriedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
  copyCacheDiagnosticsContext(contexts, response, retriedResponse)
  return retriedResponse
}

export function applyCacheDiagnosticsOptIn(
  body: Record<string, unknown>,
  previousMessageId: string | null,
): void {
  body.diagnostics = { previous_message_id: previousMessageId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isBreakpoint(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === 'ephemeral'
}

function appendBreakpoint(value: unknown, output: Array<'1h' | '5m'>) {
  if (!isBreakpoint(value)) return
  output.push(value.ttl === '1h' ? '1h' : '5m')
}

function appendArrayBreakpoints(value: unknown, output: Array<'1h' | '5m'>) {
  if (!Array.isArray(value)) return
  for (const entry of value) {
    if (isRecord(entry)) appendBreakpoint(entry.cache_control, output)
  }
}

export function summarizeCacheTtl(body: unknown): '1h' | '5m' | null {
  if (!isRecord(body)) return null
  const breakpoints: Array<'1h' | '5m'> = []
  appendBreakpoint(body.cache_control, breakpoints)
  appendArrayBreakpoints(body.system, breakpoints)
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isRecord(message))
        appendArrayBreakpoints(message.content, breakpoints)
    }
  }
  return breakpoints.at(-1) ?? null
}

function classifyDiagnostics(message: Record<string, unknown>): {
  state: CacheDiagnosticsState
  missReason?: string
  cacheMissedInputTokens?: number
} | null {
  if (!Object.hasOwn(message, 'diagnostics')) return { state: 'absent' }
  const diagnostics = message.diagnostics
  if (diagnostics === null) return { state: 'server_null' }
  if (!isRecord(diagnostics)) return null
  if (!Object.hasOwn(diagnostics, 'cache_miss_reason')) return null
  const reason = diagnostics.cache_miss_reason
  if (reason === null) return { state: 'pending' }
  if (!isRecord(reason) || typeof reason.type !== 'string' || !reason.type)
    return null
  const missed = reason.cache_missed_input_tokens
  if (missed !== undefined && typeof missed !== 'number') return null
  return {
    state: 'populated',
    missReason: reason.type,
    cacheMissedInputTokens: missed,
  }
}

function numericUsage(
  usage: Record<string, unknown>,
  key: string,
): number | null {
  const value = usage[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

export function buildCacheDiagnosticsRecord(input: {
  request: CacheDiagnosticsRequestContext
  source: CacheDiagnosticsSource
  accountId: string
  synthetic: boolean
  betasHash: string
  requestedModel?: string
  onWarning?: (message: string) => void
  message: unknown
  receivedAt: number
}): {
  record?: CacheDiagnosticsRecord
  messageId?: string
  canary?: { messageId: string; previousMessageId: string }
} {
  if (
    typeof input.source !== 'string' ||
    input.source.length === 0 ||
    typeof input.accountId !== 'string' ||
    input.accountId.length === 0 ||
    typeof input.synthetic !== 'boolean' ||
    typeof input.betasHash !== 'string' ||
    input.betasHash.length === 0
  )
    return {}
  const expectedSynthetic =
    CACHE_DIAGNOSTICS_SOURCE_SYNTHETIC[
      input.source as keyof typeof CACHE_DIAGNOSTICS_SOURCE_SYNTHETIC
    ]
  if (
    expectedSynthetic !== undefined &&
    expectedSynthetic !== input.synthetic
  ) {
    input.onWarning?.(
      `cache diagnostics source/synthetic mismatch: source=${input.source} expected=${expectedSynthetic} actual=${input.synthetic}`,
    )
  }
  const receivedAt = Math.trunc(input.receivedAt)
  if (!Number.isFinite(input.receivedAt) || receivedAt !== input.receivedAt)
    return {}
  if (!isRecord(input.message)) return {}
  const messageId = input.message.id
  const model = input.message.model
  const usage = input.message.usage
  if (typeof messageId !== 'string' || messageId.length === 0) return {}
  if (typeof model !== 'string' || model.length === 0 || !isRecord(usage))
    return {}
  const inputTokens = numericUsage(usage, 'input_tokens')
  const cacheRead = numericUsage(usage, 'cache_read_input_tokens')
  const cacheCreation = numericUsage(usage, 'cache_creation_input_tokens')
  const cacheCreationDetails = usage.cache_creation
  if (
    inputTokens === null ||
    cacheRead === null ||
    cacheCreation === null ||
    !isRecord(cacheCreationDetails)
  )
    return {}
  const ephemeral5m = numericUsage(
    cacheCreationDetails,
    'ephemeral_5m_input_tokens',
  )
  const ephemeral1h = numericUsage(
    cacheCreationDetails,
    'ephemeral_1h_input_tokens',
  )
  if (ephemeral5m === null || ephemeral1h === null) return {}
  const diagnostics = classifyDiagnostics(input.message)
  if (!diagnostics) return {}

  const record: CacheDiagnosticsRecord = {
    v: 2,
    source: input.source,
    account_id: input.accountId,
    synthetic: input.synthetic,
    betas_hash: input.betasHash,
    session_id: input.request.sessionId,
    ts_ms_received: receivedAt,
    model,
    is_subagent: input.request.isSubagent,
    ttl_sent: input.request.ttlSent,
    cache_read: cacheRead,
    cache_creation: cacheCreation,
    input_tokens: inputTokens,
    ephemeral_5m_tokens: ephemeral5m,
    ephemeral_1h_tokens: ephemeral1h,
    message_id: messageId,
    previous_message_id: input.request.previousMessageId,
    diag_state: diagnostics.state,
  }
  if (diagnostics.missReason !== undefined)
    record.miss_reason = diagnostics.missReason
  if (diagnostics.cacheMissedInputTokens !== undefined)
    record.cache_missed_input_tokens = diagnostics.cacheMissedInputTokens
  if (input.requestedModel !== undefined && input.requestedModel !== model)
    record.requested_model = input.requestedModel

  const canary =
    diagnostics.missReason === 'previous_message_not_found' &&
    input.request.previousMessageId !== null &&
    input.request.previousMessageReceivedAt !== undefined &&
    input.receivedAt - input.request.previousMessageReceivedAt <
      CACHE_DIAGNOSTICS_SHORT_GAP_MS &&
    input.receivedAt >= input.request.previousMessageReceivedAt
      ? {
          messageId,
          previousMessageId: input.request.previousMessageId,
        }
      : undefined
  return { record, messageId, ...(canary ? { canary } : {}) }
}

export function formatCacheDiagnosticsLogLine(
  record: CacheDiagnosticsRecord,
): string {
  return `${CACHE_DIAGNOSTICS_LOG_PREFIX}${JSON.stringify(record)}`
}
