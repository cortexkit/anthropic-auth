import { createHash } from 'node:crypto'
import {
  type CacheKeepDecision,
  decideCacheKeep,
} from '@cortexkit/common-auth/cachekeep'
import type { CacheWarmStopReason } from '@cortexkit/common-auth/routing-accessor'
import type { AccountStorage } from './accounts.ts'
import {
  type CacheKeepFailure,
  type CacheKeepFailureStage,
  CacheKeepPrewarmError,
  classifyCacheKeepFailure,
} from './cachekeep-failure.ts'
import type {
  CacheKeepStopReason,
  CacheKeepTrackedSession,
} from './cachekeep-registry.ts'
import { signRequestBody, stripBillingLineageFromBody } from './cch.ts'
import { orderClaudeCodeBody } from './claude-code.ts'
import { dumpDirectRequest, dumpResponseArtifact } from './dump.ts'
import { logger } from './logger.ts'
import { getClaudeModelCatalogue } from './model-capabilities.ts'
import { CLAUDE_OPUS_5_5_PRICING } from './models.ts'
import {
  NativeAccountRefusal,
  type NativeAccountRefusalReason,
  nativeAccountRefusal,
} from './native-account-refusal.ts'
import {
  createProviderErrorResponseScope,
  type ProviderErrorSummary,
  summarizePrewarmProviderError,
} from './provider-error.ts'
import { stripServerFallbackUsageMarkers } from './server-fallback-usage.ts'
import {
  readSessionCachePolicy,
  reportSessionCacheTouch,
  reportSessionCacheWarmStopped,
  requestCacheLifetimeMs,
} from './session-cache-policy.ts'

export const CLAUDE_CACHE_KEEP_COMMAND_NAME = 'claude-cachekeep'
export const CACHE_KEEP_TTL_MS = 60 * 60_000
export const CACHE_KEEP_PREWARM_LEAD_MS = 5 * 60_000

function replayPrewarmLeadMs(ttlMs: number, planned: boolean): number {
  if (!planned && ttlMs === CACHE_KEEP_TTL_MS) return CACHE_KEEP_PREWARM_LEAD_MS
  // Match decideCacheKeep's lead for short replays: the legacy five-minute
  // lead would otherwise make a five-minute source due at capture.
  return Math.min(30_000, ttlMs / 2)
}
export const CACHE_KEEP_TICK_MS = 60_000
export const CACHE_KEEP_EXTENDED_TTL_BETA = 'extended-cache-ttl-2025-04-11'
export const CACHE_KEEP_MAX_TARGETS = 32
export const CACHE_KEEP_MAX_BODY_BYTES = 64 * 1024 * 1024
export const CACHE_KEEP_PREWARM_TIMEOUT_MS = 30_000
export const CACHE_KEEP_RETRY_BASE_MS = 60_000
export const CACHE_KEEP_RETRY_MAX_MS = 15 * 60_000
export const CACHE_KEEP_RETRY_JITTER_MAX_MS = 30_000
// Cap transient backoff at 20, 40, then 60 seconds so several minute-tick
// attempts fit in the unchanged five-minute lead; reserve the request timeout
// plus five seconds before expiry, and never send after that last-start deadline.
export const CACHE_KEEP_TRANSIENT_RETRY_STEP_MS = 20_000
export const CACHE_KEEP_TRANSIENT_RETRY_MAX_MS = 60_000
export const CACHE_KEEP_EXPIRY_SAFETY_MS = 5_000
const STATUS_TITLE = '## Claude Cache Keep Status'
const ENABLED_TITLE = '## Claude Cache Keep Enabled'
const DISABLED_TITLE = '## Claude Cache Keep Disabled'
const USAGE_TITLE = '## Claude Cache Keep Usage'
const USAGE =
  'Usage: `/claude-cachekeep`, `/claude-cachekeep always`, `/claude-cachekeep off`, or `/claude-cachekeep HH-HH`.'

export type CacheKeepWindow = {
  startHour: number
  endHour: number
}

export type CacheKeepCommandAction =
  | { type: 'status' }
  | { type: 'disable' }
  | { type: 'always' }
  | { type: 'window'; startHour: number; endHour: number }
  | { type: 'usage' }
  | { type: 'subagents'; enabled: boolean }

export type CacheKeepStatus = {
  enabled: boolean
  always?: boolean
  window?: CacheKeepWindow
  trackedSessions?: number
  trackedSessionDetails?: CacheKeepTrackedSession[]
  nextPrewarmAt?: number
  hybridActive?: boolean
}

function padHour(hour: number) {
  return String(hour).padStart(2, '0')
}

export function parseCacheKeepCommandAction(
  input: string,
): CacheKeepCommandAction {
  const trimmed = input.trim()
  if (!trimmed) return { type: 'status' }
  if (trimmed === 'off') return { type: 'disable' }
  if (trimmed === 'always') return { type: 'always' }
  if (trimmed === 'subagents on') return { type: 'subagents', enabled: true }
  if (trimmed === 'subagents off') return { type: 'subagents', enabled: false }

  const match = /^(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  if (!match) return { type: 'usage' }
  const startHour = Number(match[1])
  const endHour = Number(match[2])
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return { type: 'usage' }
  }

  return { type: 'window', startHour, endHour }
}

export function getCacheKeepWindow(
  storage: AccountStorage | null,
): CacheKeepWindow | undefined {
  const startHour = Number(storage?.cacheKeep?.startHour)
  const endHour = Number(storage?.cacheKeep?.endHour)
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return undefined
  }
  return { startHour, endHour }
}

export function isCacheKeepAlways(storage: AccountStorage | null) {
  return (
    storage?.cacheKeep?.enabled === true && storage.cacheKeep.always === true
  )
}

export function isCacheKeepPersistentlyEnabled(storage: AccountStorage | null) {
  return (
    storage?.cacheKeep?.enabled === true &&
    (isCacheKeepAlways(storage) || !!getCacheKeepWindow(storage))
  )
}

export function isCacheKeepHybridActive(storage: AccountStorage | null) {
  return (
    isCacheKeepPersistentlyEnabled(storage) &&
    storage?.claudeCache?.enabled === true &&
    storage.claudeCache.mode === 'hybrid'
  )
}

export function isWithinCacheKeepWindow(
  window: CacheKeepWindow | undefined,
  now = new Date(),
) {
  if (!window) return false
  const hour = now.getHours()
  if (window.startHour < window.endHour) {
    return hour >= window.startHour && hour < window.endHour
  }
  return hour >= window.startHour || hour < window.endHour
}

export function isCacheKeepActiveNow(
  storage: AccountStorage | null,
  now = new Date(),
) {
  if (storage?.cacheKeep?.enabled !== true) return false
  return (
    isCacheKeepAlways(storage) ||
    isWithinCacheKeepWindow(getCacheKeepWindow(storage), now)
  )
}

export function localDayKey(now = new Date()) {
  return `${now.getFullYear()}-${padHour(now.getMonth() + 1)}-${padHour(now.getDate())}`
}

function localWindowKey(window: CacheKeepWindow | undefined, now = new Date()) {
  if (
    window &&
    window.startHour > window.endHour &&
    now.getHours() < window.endHour
  ) {
    const previous = new Date(now)
    previous.setDate(previous.getDate() - 1)
    return localDayKey(previous)
  }
  return localDayKey(now)
}

function cacheKeepPeriodKey(
  storage: AccountStorage | null,
  window: CacheKeepWindow | undefined,
  now = new Date(),
) {
  return isCacheKeepAlways(storage) ? 'always' : localWindowKey(window, now)
}

export function buildCacheKeepStatusSummary(status: CacheKeepStatus) {
  const schedule = status.always
    ? 'always (while this process is running)'
    : status.window
      ? `${padHour(status.window.startHour)}-${padHour(status.window.endHour)}`
      : 'not configured'
  const lines = [
    `Cache keep: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Schedule: ${schedule}`,
    'Mode requirement: `/claude-cache mode hybrid` must be active.',
  ]
  if (typeof status.hybridActive === 'boolean') {
    lines.push(`Hybrid active: ${status.hybridActive ? 'yes' : 'no'}`)
  }
  if (typeof status.trackedSessions === 'number') {
    lines.push(`Tracked sessions: ${status.trackedSessions}`)
  }
  if (status.trackedSessionDetails?.length) {
    lines.push('Sessions:')
    for (const session of status.trackedSessionDetails) {
      lines.push(`- ${session.id}`)
    }
  }
  if (status.nextPrewarmAt) {
    lines.push(
      `Next prewarm: ${new Date(status.nextPrewarmAt).toLocaleString()}`,
    )
  }
  return lines.join('\n')
}

export function executeCacheKeepCommand(input: {
  argumentsText: string
  enabled?: boolean
  always?: boolean
  window?: CacheKeepWindow
  trackedSessions?: number
  trackedSessionDetails?: CacheKeepTrackedSession[]
  nextPrewarmAt?: number
  hybridActive?: boolean
}) {
  const action = parseCacheKeepCommandAction(input.argumentsText)
  const status = {
    enabled: input.enabled ?? false,
    always: input.always,
    window: input.window,
    trackedSessions: input.trackedSessions,
    trackedSessionDetails: input.trackedSessionDetails,
    nextPrewarmAt: input.nextPrewarmAt,
    hybridActive: input.hybridActive,
  }

  if (action.type === 'status') {
    return [STATUS_TITLE, '', buildCacheKeepStatusSummary(status)].join('\n')
  }

  if (action.type === 'disable') {
    return [
      DISABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({ ...status, enabled: false }),
    ].join('\n')
  }

  if (action.type === 'always') {
    return [
      ENABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({
        ...status,
        enabled: true,
        always: true,
        window: undefined,
      }),
    ].join('\n')
  }

  if (action.type === 'window') {
    return [
      ENABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({
        ...status,
        enabled: true,
        always: false,
        window: { startHour: action.startHour, endHour: action.endHour },
      }),
    ].join('\n')
  }

  if (action.type === 'subagents') {
    return [
      STATUS_TITLE,
      '',
      buildCacheKeepStatusSummary(status),
      '',
      `Subagent tracking: ${action.enabled ? 'enabled' : 'disabled'}`,
    ].join('\n')
  }

  return [USAGE_TITLE, '', USAGE, '', buildCacheKeepStatusSummary(status)].join(
    '\n',
  )
}

function hasExplicitCacheControl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasExplicitCacheControl)
  const record = value as Record<string, unknown>
  const cacheControl = record.cache_control
  if (
    cacheControl &&
    typeof cacheControl === 'object' &&
    (cacheControl as Record<string, unknown>).type === 'ephemeral'
  ) {
    return true
  }
  return Object.values(record).some(hasExplicitCacheControl)
}

export async function buildCacheKeepPrewarmBody(
  bodyText: string,
  options: { stripServerFallback?: boolean } = {},
): Promise<{ ok: true; bodyText: string } | { ok: false; reason: string }> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'body is not valid JSON' }
  }

  if (isRecord(body.thread) && body.thread.type === 'continue')
    return {
      ok: false,
      reason: 'a thread continuation is not a full cache prefix',
    }

  if (!hasExplicitCacheControl(body)) {
    return { ok: false, reason: 'body has no explicit cache breakpoints' }
  }

  const warm = structuredClone(body) as Record<string, unknown>
  stripServerFallbackUsageMarkers(warm)
  delete warm.thread
  stripBillingLineageFromBody(warm)
  warm.max_tokens = 0
  delete warm.stream
  if (options.stripServerFallback === true) {
    // A source warm carrying the server-side fallback opt-in can be
    // sticky-routed to a fallback model instead of the source model whose
    // cache it should extend. The warm re-derives its betas from its own
    // body, so dropping the opt-in here also drops the server-fallback
    // beta from its headers. Ordinary prewarms keep the opt-in: while the
    // fallback model serves the live turns, the prewarm should warm that
    // same cache.
    delete warm.fallbacks
  }

  const thinking = warm.thinking as Record<string, unknown> | undefined
  if (thinking?.type === 'enabled') delete warm.thinking

  const outputConfig = warm.output_config as Record<string, unknown> | undefined
  if (outputConfig?.format) delete warm.output_config

  const toolChoice = warm.tool_choice as Record<string, unknown> | undefined
  if (toolChoice?.type === 'tool' || toolChoice?.type === 'any') {
    delete warm.tool_choice
  }

  const signedBodyText = await signRequestBody(
    JSON.stringify(orderClaudeCodeBody(warm, { isOAuth: true })),
  )
  return { ok: true, bodyText: signedBodyText }
}

export type CacheKeepPolicyState = {
  ownerSessionId: string
  planned: boolean
  lastRealRequestAt: number
  lastWarmAt?: number
  warmsSinceLastRealRequest: number
  /** Micro-USD: per-million-token catalogue rate multiplied by prefix tokens. */
  warmCostSoFar: number
  /** Admitted cost durably reserved for dispatches whose result is not saved yet. */
  pendingWarmCost?: number
  prefixTokens?: number
  inputTokens?: number
  hasWarmed: boolean
  /** A restored local hours-window record lacks the accepted real-request baseline. */
  needsRealRequest?: boolean
}

export type CacheKeepTarget = {
  id: string
  url: string
  headers: Record<string, string>
  bodyText: string
  bodyBytes: number
  cacheExpiresAt: number
  nextPrewarmAt: number
  consecutiveFailures: number
  dayKey: string
  oauthAccountId?: string
  oauthAccountIdentity?: string
  accountStoragePath?: string
  isSubagent: boolean
  policyState?: CacheKeepPolicyState
  /**
   * A recovery-round warm for the original (source) model, tracked under a
   * key that cannot collide with the session's live target. It follows the
   * same send, auth, retry and logging path; the caller stops it through
   * untrack() when the round ends or its prefix becomes unusable.
   */
  sourceWarm?: boolean
} & Pick<CacheKeepTrackedSession, 'ttlMs' | 'lastTouchAt' | 'lastTouchKind'>

type AcceptedCacheUsage = {
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  input_tokens?: number
}

function updateAcceptedUsage(
  target: CacheKeepTarget,
  bodyText: string,
  usage: AcceptedCacheUsage,
): boolean {
  const state = target.policyState
  if (
    !state ||
    target.bodyText !== bodyText ||
    (usage.cache_read_input_tokens === undefined &&
      usage.cache_creation_input_tokens === undefined)
  )
    return false
  const read = usage.cache_read_input_tokens ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  const uncached = usage.input_tokens ?? 0
  if (![read, write, uncached].every((n) => Number.isFinite(n) && n >= 0))
    return false
  const prefix = read + write
  const input = prefix + uncached
  if (state.prefixTokens === prefix && state.inputTokens === input) return false
  state.prefixTokens = prefix
  state.inputTokens = input
  return true
}

function sessionMetadata(target: CacheKeepTarget): CacheKeepTrackedSession {
  return {
    id: target.id,
    cacheExpiresAt: target.cacheExpiresAt,
    nextPrewarmAt: target.nextPrewarmAt,
    ...(target.ttlMs !== undefined && { ttlMs: target.ttlMs }),
    ...(target.lastTouchAt !== undefined && {
      lastTouchAt: target.lastTouchAt,
    }),
    ...(target.lastTouchKind !== undefined && {
      lastTouchKind: target.lastTouchKind,
    }),
  }
}

function stopReason(reason: string): CacheKeepStopReason {
  switch (reason) {
    case 'budget':
    case 'count':
      return 'evicted'
    case 'schedule-period-ended':
      return 'schedule'
    case 'retry-window-ended':
      return 'retries-exhausted'
    case 'cachekeep-hybrid-inactive':
      return 'disabled'
    case 'source-warm-idle-cap':
      return 'cost-cap'
    default:
      return 'policy-refused'
  }
}

function reportStopReason(reason: string): CacheWarmStopReason {
  switch (reason) {
    case 'cost-cap':
    case 'count-cap':
    case 'outside-hours':
    case 'session-ended':
    case 'unsupported':
    case 'evicted':
    case 'stopped':
    case 'account-changed':
    case 'expired':
    case 'idle':
      return reason
    case 'budget':
    case 'count':
      return 'evicted'
    case 'schedule':
    case 'schedule-period-ended':
      return 'outside-hours'
    case 'session-forgotten':
      return 'session-ended'
    case 'retry-window-ended':
      return 'expired'
    case 'source-warm-idle-cap':
      return 'cost-cap'
    case 'credential-changed':
    case 'account-unavailable':
      return 'account-changed'
    default:
      return 'unsupported'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const BILLING_HEADER_BLOCK_PREFIX = 'x-anthropic-billing-header:'

function isBillingHeaderBlock(block: unknown): boolean {
  return (
    isRecord(block) &&
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.startsWith(BILLING_HEADER_BLOCK_PREFIX)
  )
}

function normalizePrefixValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePrefixValue)
  if (!isRecord(value)) return value
  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizePrefixValue(value[key])
  }
  return normalized
}

/**
 * Fingerprint of the cacheable prefix of a request body: tools, system
 * blocks, and messages up to the last cache breakpoint. The billing header
 * block is excluded because its signature is re-signed on every send, and
 * everything past the last breakpoint (output limits, stream flags,
 * thinking config) never affects the stored cache entry. Two bodies with
 * the same fingerprint warm the same cache entry.
 */
export function cacheWarmCacheablePrefixFingerprint(
  bodyText: string,
): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  if (!isRecord(body)) return undefined
  const messages = Array.isArray(body.messages) ? body.messages : []
  let lastBreakpoint = -1
  messages.forEach((message, index) => {
    if (hasExplicitCacheControl(message)) lastBreakpoint = index
  })
  const system = Array.isArray(body.system)
    ? body.system.filter((block) => !isBillingHeaderBlock(block))
    : (body.system ?? null)
  const prefix = normalizePrefixValue({
    tools: body.tools ?? null,
    system,
    messages: messages.slice(0, lastBreakpoint + 1),
  })
  return createHash('sha256').update(JSON.stringify(prefix)).digest('hex')
}

/**
 * How many warms one idle recovery round may send before stopping: each
 * warm pays a cache read, and the idle warms stay worth it while the reads
 * sent since the last user turn cost less than one 1-hour rewrite, so the
 * round stops after floor((1-hour write rate - read rate) / read rate)
 * warms. Rates come from the source model's own catalogue pricing; models
 * without catalogue facts (Opus 5) use the nearest sibling with 1-hour
 * pricing.
 */
export function cacheKeepSourceWarmIdleCap(modelId: string): number {
  let pricing: { cacheRead: number; cacheWrite1h: number }
  try {
    pricing = getClaudeModelCatalogue(modelId).pricing
  } catch {
    pricing = CLAUDE_OPUS_5_5_PRICING
  }
  if (!Number.isFinite(pricing.cacheRead) || pricing.cacheRead <= 0) return 1
  return Math.max(
    1,
    Math.floor((pricing.cacheWrite1h - pricing.cacheRead) / pricing.cacheRead),
  )
}

export type CacheKeepPrewarmAttempt = {
  id: number
  /** One deadline covers credential authorization and the HTTP attempt. */
  signal?: AbortSignal
}

function cacheKeepRetryDelayMs(targetId: string, failureCount: number) {
  const exponential = Math.min(
    CACHE_KEEP_RETRY_MAX_MS,
    CACHE_KEEP_RETRY_BASE_MS * 2 ** Math.min(Math.max(failureCount - 1, 0), 8),
  )
  let hash = 2_166_136_261
  for (const character of `${targetId}:${failureCount}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  const jitter =
    (hash >>> 0) %
    (Math.min(CACHE_KEEP_RETRY_JITTER_MAX_MS, exponential / 4) + 1)
  return exponential + jitter
}

/**
 * Credentials one prewarm send actually carried: the whole authorization
 * value, its token without the `Bearer` scheme, and any x-api-key. Read from
 * the headers handed to that send, so a rotated replay is scrubbed with its
 * own credential rather than an earlier or later one.
 */
function cacheKeepSentCredentials(headers: Headers): string[] {
  const credentials: string[] = []
  const authorization = headers.get('authorization')
  if (authorization) {
    credentials.push(authorization)
    const token = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim()
    if (token) credentials.push(token)
  }
  const apiKey = headers.get('x-api-key')
  if (apiKey) credentials.push(apiKey)
  return credentials
}

export type CacheKeepPrewarmResult =
  | {
      ok: true
      refused?: false
      ttlMs?: number
      usage?: {
        input_tokens?: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    }
  | {
      ok: false
      refused?: false
      reason: string
      refusal?: NativeAccountRefusalReason
      status?: number
      transient?: true
      provider_error?: ProviderErrorSummary['provider_error']
      stage?: CacheKeepFailure['stage']
      class?: CacheKeepFailure['class']
    }
  | {
      /** The warm was refused before any send; the target is removed. */
      ok: false
      refused: true
      reason: string
      status?: undefined
      transient?: undefined
      provider_error?: undefined
    }

export type CacheKeepPrewarmValidation =
  | { ok: true }
  | { ok: false; reason: string }

// common-auth/cachekeep's default maxIdleWarmMs and maxSubagentIdleMs.
const PLANNED_UNPRICED_MAIN_IDLE_MS = 60 * 60_000
const PLANNED_UNPRICED_SUBAGENT_IDLE_MS = 30 * 60_000

export class CacheKeepWarmRefusal extends Error {
  constructor(readonly reason: CacheWarmStopReason) {
    super('CacheKeep policy refused')
  }
}

export class CacheKeepManager {
  private readonly targets = new Map<string, CacheKeepTarget>()
  // Standalone warms are not retained targets. Their object identity fences
  // callbacks when a real request, newer warm or explicit stop supersedes them.
  private readonly immediateTargets = new Map<string, CacheKeepTarget>()
  // Only the body-free public projection survives when warming stops.
  private readonly stoppedSessions = new Map<string, CacheKeepTrackedSession>()
  private timer: ReturnType<typeof setInterval> | null = null
  private dueTimer: ReturnType<typeof setTimeout> | null = null
  private tickPromise: Promise<void> | null = null
  private nextPrewarmAttemptId = 0
  private readonly reportedStops = new WeakSet<CacheKeepPolicyState>()
  private readonly admittedWarmCosts = new WeakMap<
    CacheKeepPolicyState,
    number
  >()

  constructor(
    private readonly options: {
      loadStorage: () => Promise<AccountStorage | null>
      fetchImpl?: typeof fetch
      now?: () => number
      prewarmTimeoutMs?: number
      setIntervalImpl?: typeof globalThis.setInterval
      clearIntervalImpl?: typeof globalThis.clearInterval
      setTimeoutImpl?: typeof globalThis.setTimeout
      clearTimeoutImpl?: typeof globalThis.clearTimeout
      prepareHeaders?: (
        headers: Headers,
        target: CacheKeepTarget,
        attempt: CacheKeepPrewarmAttempt,
      ) => Promise<Headers | undefined> | Headers | undefined
      /** Optionally reauthorize a replayable prewarm after a genuine 401.
       * Return headers only for a verified newer version of the same account;
       * onResponse observes only the final physical attempt. */
      retryOnUnauthorized?: (input: {
        target: CacheKeepTarget
        headers: Headers
        bodyText: string
        attempt: CacheKeepPrewarmAttempt
      }) => Promise<Headers | undefined> | Headers | undefined
      onTrackedSessionsChanged?: (
        sessions: readonly CacheKeepTrackedSession[],
      ) => Promise<void> | void
      /** Hosts may mirror targets without delaying a live request on storage I/O. */
      onTargetChanged?: (target: Readonly<CacheKeepTarget>) => void
      onTargetRemoved?: (id: string) => void
      /** Persistent hosts must commit the reservation before any physical send. */
      reserveWarm?: (target: Readonly<CacheKeepTarget>) => Promise<boolean>
      /** Persist a known failed dispatch so restore need not charge its cost. */
      settleWarm?: (target: Readonly<CacheKeepTarget>) => Promise<boolean>
      /** Native hosts authorize asynchronously inside fetchImpl and reserve there. */
      deferWarmReservation?: boolean
      /** A native host may rewrite the final physical warm after fetchImpl starts. */
      responseTtlMs?: (response: Response) => number | undefined
      prepareBody?: (
        bodyText: string,
        target: CacheKeepTarget,
      ) => string | Promise<string>
      /**
       * Veto a prewarm after its body is built but before anything is
       * sent. A refusal removes the target without sending. Throwing also
       * refuses, so a failing check can never send a mismatched warm.
       */
      validatePrewarm?: (input: {
        target: CacheKeepTarget
        warmBodyText: string
      }) => CacheKeepPrewarmValidation | Promise<CacheKeepPrewarmValidation>
      onResponse?: (input: {
        target: CacheKeepTarget
        bodyText: string
        status: number
        data: unknown
        receivedAt: number
        attempt: CacheKeepPrewarmAttempt
      }) => void | Promise<void>
      onComplete?: (input: {
        target: CacheKeepTarget
        attempt: CacheKeepPrewarmAttempt
      }) => void | Promise<void>
    },
  ) {}

  start() {
    if (this.timer) return
    logger.debug('cachekeep', 'started')
    this.timer = (this.options.setIntervalImpl ?? globalThis.setInterval)(
      () => {
        // The caught value can carry provider or peer text, so only the fixed
        // stage name is logged.
        void this.tick().catch(() => {
          logger.warn('cachekeep', 'tick failed')
        })
      },
      CACHE_KEEP_TICK_MS,
    )
    if ('unref' in this.timer) this.timer.unref()
    this.scheduleDueTimer()
  }

  stop() {
    this.immediateTargets.clear()
    const now = this.options.now?.() ?? Date.now()
    for (const target of this.targets.values())
      this.reportStop(target, 'stopped', now)
    if (this.dueTimer) {
      ;(this.options.clearTimeoutImpl ?? clearTimeout)(this.dueTimer)
      this.dueTimer = null
    }
    if (!this.timer) return
    logger.debug('cachekeep', 'stopped')
    const clearIntervalImpl =
      this.options.clearIntervalImpl ?? globalThis.clearInterval
    clearIntervalImpl(this.timer)
    this.timer = null
  }

  stats(
    window?: CacheKeepWindow,
    now = this.options.now?.() ?? Date.now(),
    always = false,
  ) {
    const today = always ? 'always' : localWindowKey(window, new Date(now))
    const targets = [...this.targets.values()].filter(
      (target) => target.dayKey === today,
    )
    const nextPrewarmAt = targets.length
      ? Math.min(...targets.map((target) => target.nextPrewarmAt))
      : undefined
    return { trackedSessions: targets.length, nextPrewarmAt }
  }

  trackedSessions(): CacheKeepTrackedSession[] {
    return [...this.targets.values()]
      .map((target) => ({
        id: target.id,
        cacheExpiresAt: target.cacheExpiresAt,
        nextPrewarmAt: target.nextPrewarmAt,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  registrySessions(): CacheKeepTrackedSession[] {
    const now = this.options.now?.() ?? Date.now()
    for (const [id, session] of this.stoppedSessions)
      if (session.cacheExpiresAt <= now) this.stoppedSessions.delete(id)
    return [
      ...this.stoppedSessions.values(),
      ...[...this.targets.values()].map(sessionMetadata),
    ].sort((left, right) => left.id.localeCompare(right.id))
  }

  trackedOAuthRoute(
    sessionId: string,
  ): { oauthAccountId?: string } | undefined {
    const target = this.targets.get(sessionId)
    return target ? { oauthAccountId: target.oauthAccountId } : undefined
  }

  /**
   * The last request actually sent for a session, as tracked live: the
   * exact signed bytes, destination, and account they went out on. A copy
   * of the headers; the body string itself is shared, never re-serialized.
   */
  trackedRequest(id: string):
    | {
        bodyText: string
        url: string
        headers: Record<string, string>
        oauthAccountId?: string
        oauthAccountIdentity?: string
        isSubagent: boolean
        cacheExpiresAt: number
      }
    | undefined {
    const target = this.targets.get(id)
    if (!target) return undefined
    return {
      bodyText: target.bodyText,
      url: target.url,
      headers: { ...target.headers },
      ...(target.oauthAccountId !== undefined && {
        oauthAccountId: target.oauthAccountId,
      }),
      ...(target.oauthAccountIdentity !== undefined && {
        oauthAccountIdentity: target.oauthAccountIdentity,
      }),
      isSubagent: target.isSubagent,
      cacheExpiresAt: target.cacheExpiresAt,
    }
  }

  /**
   * Stop warming a session without logging: the caller owns the reason
   * (a finished recovery round, a model change, a cleared session) and
   * logs it where the decision is made. Returns whether a target existed.
   */
  untrack(
    id: string,
    reason: CacheKeepStopReason = 'session-forgotten',
  ): boolean {
    this.immediateTargets.delete(id)
    const target = this.targets.get(id)
    if (!target) return false
    this.reportStop(target, reason, this.options.now?.() ?? Date.now())
    this.retainStopped(target, reason, this.options.now?.() ?? Date.now())
    this.targets.delete(id)
    this.options.onTargetRemoved?.(id)
    this.publishTrackedSessions()
    return true
  }

  trackedCount(): number {
    return this.targets.size
  }

  isCurrentTarget(target: Readonly<CacheKeepTarget>): boolean {
    const current = this.targets.get(target.id)
    return current
      ? current.policyState === target.policyState
      : this.immediateTargets.get(target.id) === target
  }

  /**
   * The tracked policy state keeps the same object identity across warm
   * updates; each newly accepted real request gets a new one.
   */
  trackedPolicyState(id: string): Readonly<CacheKeepPolicyState> | undefined {
    return this.targets.get(id)?.policyState
  }

  hasPlannedTarget(id: string): boolean {
    return this.targets.get(id)?.policyState?.planned === true
  }

  updateSubagent(id: string, isSubagent: boolean): void {
    const target = this.targets.get(id)
    if (!target || target.isSubagent === isSubagent) return
    target.isSubagent = isSubagent
    this.options.onTargetChanged?.(target)
    this.scheduleDueTimer()
  }

  /** An old response cannot price or reset a newer captured request. */
  recordAcceptedUsage(id: string, bodyText: string, usage: AcceptedCacheUsage) {
    const target = this.targets.get(id)
    if (!target || !updateAcceptedUsage(target, bodyText, usage)) return
    this.options.onTargetChanged?.(target)
    this.scheduleDueTimer()
  }

  private costs(target: CacheKeepTarget) {
    const state = target.policyState
    if (state?.prefixTokens === undefined) return undefined
    let model: string
    try {
      model = JSON.parse(target.bodyText).model
    } catch {
      return undefined
    }
    if (typeof model !== 'string') return undefined
    let catalogue: ReturnType<typeof getClaudeModelCatalogue>
    try {
      catalogue = getClaudeModelCatalogue(model)
    } catch {
      return undefined
    }
    if (!catalogue) return undefined
    const prices =
      catalogue.longContext &&
      (state.inputTokens ?? 0) > catalogue.longContext.inputTokensAbove
        ? catalogue.longContext.pricing
        : catalogue.pricing
    const read = prices.cacheRead
    const write =
      target.ttlMs === 3_600_000 ? prices.cacheWrite1h : prices.cacheWrite5m
    if (![read, write].every((price) => Number.isFinite(price) && price >= 0))
      return undefined
    return {
      nextWarmCost: read * state.prefixTokens,
      rewriteCost: write * state.prefixTokens,
      warmCostSoFar: state.warmCostSoFar,
    }
  }

  private policyDecision(
    target: CacheKeepTarget,
    now: number,
    ownReservation = false,
  ): CacheKeepDecision | undefined {
    const state = target.policyState
    if (!state) return undefined
    const policy = readSessionCachePolicy(state.ownerSessionId, true)
    if (!policy && state.planned)
      return { action: 'stop', reason: 'session-ended' }
    if (!policy) return undefined
    if (policy.ttl === 'none' || policy.keep_warm === 'off')
      return { action: 'stop', reason: 'unsupported' }
    if (
      policy.ttl &&
      (policy.ttl === 'long' ? 3_600_000 : 300_000) !== target.ttlMs
    )
      return { action: 'stop', reason: 'unsupported' }
    if (policy.keep_warm === undefined)
      return state.planned
        ? { action: 'stop', reason: 'session-ended' }
        : undefined
    if (state.needsRealRequest) return { action: 'stop', reason: 'unsupported' }
    state.planned = true
    const mode = policy.keep_warm
    const plan =
      mode === 'hours'
        ? policy.hours && { mode, hours: policy.hours }
        : { mode }
    if (!plan) return { action: 'stop', reason: 'unsupported' }
    const costs = this.costs(target)
    if (
      mode === 'auto' &&
      !costs &&
      state.lastRealRequestAt <
        now -
          (target.isSubagent
            ? PLANNED_UNPRICED_SUBAGENT_IDLE_MS
            : PLANNED_UNPRICED_MAIN_IDLE_MS)
    )
      return { action: 'stop', reason: 'idle' }
    return decideCacheKeep({
      ...plan,
      now,
      ttlMs: target.ttlMs ?? 0,
      lastRealRequestAt: state.lastRealRequestAt,
      lastWarmAt: state.lastWarmAt,
      warmsSinceLastRealRequest:
        state.warmsSinceLastRealRequest - Number(ownReservation),
      ...costs,
    })
  }

  private countDecision(
    target: CacheKeepTarget,
  ): CacheKeepDecision | undefined {
    const state = target.policyState
    if (!state || state.needsRealRequest)
      return { action: 'stop', reason: 'unsupported' }
    const result = decideCacheKeep({
      mode: 'always',
      now: state.lastRealRequestAt,
      ttlMs: CACHE_KEEP_TTL_MS,
      lastRealRequestAt: state.lastRealRequestAt,
      warmsSinceLastRealRequest: state.warmsSinceLastRealRequest,
    })
    return result.action === 'stop' && result.reason === 'count-cap'
      ? result
      : undefined
  }

  /** Called at the physical boundary, after authorization and before fetch. */
  async reserveWarmDispatch(target: Readonly<CacheKeepTarget>): Promise<void> {
    const current = this.targets.get(target.id)
    if (!current || !this.isCurrentTarget(target))
      throw new CacheKeepWarmRefusal('stopped')
    const state = current.policyState
    const storage = await this.options.loadStorage()
    if (!this.isCurrentTarget(target)) throw new CacheKeepWarmRefusal('stopped')
    const now = this.options.now?.() ?? Date.now()
    const decision =
      this.policyDecision(current, now) ??
      (isCacheKeepAlways(storage) ? this.countDecision(current) : undefined)
    if (decision?.action === 'stop')
      throw new CacheKeepWarmRefusal(decision.reason)
    if (decision?.action === 'wait') throw new CacheKeepWarmRefusal('stopped')
    const admittedCost = this.costs(current)?.nextWarmCost ?? 0
    const pendingCost = state?.pendingWarmCost
    if (state) {
      state.warmsSinceLastRealRequest++
      state.pendingWarmCost = (pendingCost ?? 0) + admittedCost
    }
    // Process-only keepers have no restart replay. Persistent hosts must prove
    // the new count is stored before sending; a failed attempt keeps its slot.
    if (this.options.reserveWarm) {
      let committed = false
      try {
        committed = await this.options.reserveWarm(current)
      } catch {}
      if (!committed && (state?.planned || isCacheKeepAlways(storage))) {
        if (state) {
          state.warmsSinceLastRealRequest--
          state.pendingWarmCost = pendingCost
        }
        throw new CacheKeepPrewarmError('authorization', undefined)
      }
    }
    if (state) this.admittedWarmCosts.set(state, admittedCost)
    if (!this.isCurrentTarget(target)) throw new CacheKeepWarmRefusal('stopped')
    const fresh = this.policyDecision(
      current,
      this.options.now?.() ?? Date.now(),
      true,
    )
    if (fresh?.action === 'stop') throw new CacheKeepWarmRefusal(fresh.reason)
    if (fresh?.action === 'wait') throw new CacheKeepWarmRefusal('stopped')
  }

  private scheduleDueTimer() {
    if (this.dueTimer)
      (this.options.clearTimeoutImpl ?? clearTimeout)(this.dueTimer)
    this.dueTimer = null
    let due = Infinity
    // Restored or near-expiry caches may not survive the next interval tick.
    for (const target of this.targets.values())
      due = Math.min(due, target.nextPrewarmAt)
    if (!Number.isFinite(due)) return
    this.dueTimer = (this.options.setTimeoutImpl ?? setTimeout)(
      () => {
        this.dueTimer = null
        return this.tick().catch(() => logger.warn('cachekeep', 'tick failed'))
      },
      Math.max(1, due - (this.options.now?.() ?? Date.now())),
    )
    this.dueTimer.unref?.()
  }

  /**
   * Drop targets whose cache has already expired, without sending or
   * publishing anything. Returns the earliest expiry among the targets that
   * remain, or undefined when none remain.
   */
  dropExpiredTargets(
    now = this.options.now?.() ?? Date.now(),
  ): number | undefined {
    this.pruneTargets(now)
    let earliest: number | undefined
    for (const target of this.targets.values())
      earliest = Math.min(
        earliest ?? target.cacheExpiresAt,
        target.cacheExpiresAt,
      )
    return earliest
  }

  private publishTrackedSessions() {
    const callback = this.options.onTrackedSessionsChanged
    if (!callback) return
    try {
      // Host callback failures may echo arbitrary text; log the stage only.
      void Promise.resolve(callback(this.registrySessions())).catch(() => {
        logger.warn('cachekeep', 'failed to publish tracked sessions')
      })
    } catch {
      logger.warn('cachekeep', 'failed to publish tracked sessions')
    }
  }

  private totalBodyBytes() {
    return [...this.targets.values()].reduce(
      (sum, target) => sum + target.bodyBytes,
      0,
    )
  }

  private removeTarget(
    target: CacheKeepTarget,
    reason: string,
    now: number,
    details: Record<string, unknown> = {},
  ) {
    if (this.targets.get(target.id) !== target) return
    this.reportStop(target, reason, now)
    if (now < target.cacheExpiresAt)
      logger[reason === 'count-cap' ? 'debug' : 'warn'](
        'cachekeep',
        'stopped warming session',
        {
          session: target.id,
          reason,
          bodyBytes: target.bodyBytes,
          totalBodyBytes: this.totalBodyBytes(),
          budgetBytes: CACHE_KEEP_MAX_BODY_BYTES,
          targets: this.targets.size,
          maxTargets: CACHE_KEEP_MAX_TARGETS,
          cacheExpiresAt: target.cacheExpiresAt,
          nextPrewarmAt: target.nextPrewarmAt,
          ...details,
        },
      )
    this.retainStopped(target, stopReason(reason), now)
    this.targets.delete(target.id)
    this.options.onTargetRemoved?.(target.id)
  }

  private retainStopped(
    target: CacheKeepTarget,
    reason: CacheKeepStopReason,
    now: number,
  ) {
    if (now >= target.cacheExpiresAt) return
    this.stoppedSessions.set(target.id, {
      ...sessionMetadata(target),
      warmStopped: { at: now, reason },
    })
  }

  private reportStop(target: CacheKeepTarget, reason: string, at: number) {
    const state = target.policyState
    // Source warms are a different model's prefix, not evidence about the
    // active session cache. The shared report has no target-attribution field.
    if (target.sourceWarm || !state?.hasWarmed || this.reportedStops.has(state))
      return
    if (
      reportSessionCacheWarmStopped(state.ownerSessionId, {
        at,
        reason: reportStopReason(reason),
      })
    )
      this.reportedStops.add(state)
  }

  private evictOldestTarget(now: number, reason: 'budget' | 'count') {
    const oldest = this.targets.values().next().value
    if (!oldest) return
    // Map order follows user turns, not prewarms. Preserve sessions about to
    // be warmed when a less urgent candidate (even the new session) can go.
    const target =
      [...this.targets.values()].find(
        (candidate) => candidate.nextPrewarmAt > now + 60_000,
      ) ?? oldest
    this.removeTarget(target, reason, now, {
      detail: 'evicted by cachekeep limits',
      ...(target !== oldest && { selection: 'imminent-protected' }),
    })
  }

  private pruneTargets(now: number, today?: string) {
    for (const [id, target] of this.targets) {
      if (today && !target.policyState?.planned && target.dayKey !== today) {
        this.removeTarget(target, 'schedule-period-ended', now)
        continue
      }
      if (now >= target.cacheExpiresAt) {
        this.reportStop(
          target,
          target.policyState?.planned ? 'cost-cap' : 'expired',
          now,
        )
        this.targets.delete(id)
        this.options.onTargetRemoved?.(id)
      }
    }
    while (this.targets.size > CACHE_KEEP_MAX_TARGETS)
      this.evictOldestTarget(now, 'count')
    while (this.totalBodyBytes() > CACHE_KEEP_MAX_BODY_BYTES) {
      const before = this.targets.size
      this.evictOldestTarget(now, 'budget')
      if (this.targets.size === before) break
    }
  }

  track(input: {
    sessionId?: string | null
    url: string
    headers: Headers
    bodyText: string
    storage: AccountStorage | null
    cacheMode: string
    oauthAccountId?: string
    oauthAccountIdentity?: string
    accountStoragePath?: string
    isSubagent?: boolean
    sourceWarm?: boolean
    /** Source targets use a synthetic id but belong to a real host session. */
    ownerSessionId?: string
    acceptedAt?: number
    acceptedUsage?: AcceptedCacheUsage
    ttlMs?: number
    /** Restore only the remaining lifetime, never grant a restarted cache a new hour. */
    retained?: Pick<
      CacheKeepTarget,
      | 'cacheExpiresAt'
      | 'nextPrewarmAt'
      | 'ttlMs'
      | 'lastTouchAt'
      | 'lastTouchKind'
      | 'policyState'
    >
  }): { tracked: true } | { tracked: false; reason: string } {
    const now = this.options.now?.() ?? Date.now()
    const acceptedAt = input.acceptedAt ?? input.retained?.lastTouchAt ?? now
    if (input.retained && input.retained.cacheExpiresAt <= now)
      return { tracked: false, reason: 'cache expired' }
    // Measured only once the policy checks pass: track() runs on every live
    // request, and most requests are excluded before the body matters.
    let bodyBytes: number | undefined
    const refuse = (reason: string, reasonCode: string) => {
      // Policy exclusions leave any existing target intact. Only a body that
      // cannot fit in the budget warrants a warning rather than debug detail.
      if (reasonCode === 'body-budget')
        logger.warn('cachekeep', 'tracking skipped', {
          session: input.sessionId ?? null,
          reason: reasonCode,
          detail: reason,
          bodyBytes,
          totalBodyBytes: this.totalBodyBytes(),
          budgetBytes: CACHE_KEEP_MAX_BODY_BYTES,
          targets: this.targets.size,
          maxTargets: CACHE_KEEP_MAX_TARGETS,
          cacheExpiresAt: input.sessionId
            ? this.targets.get(input.sessionId)?.cacheExpiresAt
            : undefined,
        })
      else
        logger.debug('cachekeep', 'tracking skipped', {
          session: input.sessionId ?? null,
          reason: reasonCode,
        })
      return { tracked: false as const, reason }
    }
    if (!input.sessionId) return refuse('missing session id', 'missing-session')
    this.immediateTargets.delete(input.sessionId)
    let previous = this.targets.get(input.sessionId)
    if (
      previous &&
      (previous.oauthAccountId !== input.oauthAccountId ||
        previous.oauthAccountIdentity !== input.oauthAccountIdentity)
    ) {
      this.removeTarget(previous, 'account-changed', now)
      previous = undefined
    }
    const ownerSessionId =
      input.ownerSessionId ??
      input.retained?.policyState?.ownerSessionId ??
      input.sessionId
    const policy = readSessionCachePolicy(ownerSessionId, true)
    const planned = policy?.keep_warm !== undefined
    const retire = (reason: CacheWarmStopReason) => {
      if (previous) this.removeTarget(previous, reason, now)
      return refuse(reason, reason)
    }
    if (
      input.retained &&
      (planned || isCacheKeepAlways(input.storage)) &&
      input.retained.policyState?.needsRealRequest
    )
      return retire('unsupported')
    if (
      !policy &&
      (input.retained?.policyState?.planned || previous?.policyState?.planned)
    )
      return retire('session-ended')
    if (policy?.ttl === 'none' || policy?.keep_warm === 'off')
      return retire('unsupported')
    if (!planned && !isCacheKeepPersistentlyEnabled(input.storage)) {
      return refuse('cachekeep disabled', 'disabled')
    }
    if (!planned && input.cacheMode !== 'hybrid') {
      return refuse('cache mode is not hybrid', 'not-hybrid')
    }
    bodyBytes = Buffer.byteLength(input.bodyText, 'utf8')
    if (bodyBytes > CACHE_KEEP_MAX_BODY_BYTES) {
      if (planned) return retire('evicted')
      return refuse('body exceeds cachekeep memory budget', 'body-budget')
    }
    if (input.bodyText.includes('"thread"')) {
      try {
        const body = JSON.parse(input.bodyText)
        if (body.thread) {
          if (planned) return retire('unsupported')
          return refuse(
            'thread wire bodies are not full stateless cache prefixes',
            'message-thread-wire-body',
          )
        }
      } catch {}
    }
    const window = getCacheKeepWindow(input.storage)
    const appliedTtlMs = requestCacheLifetimeMs(input.bodyText)
    const replayTtlMs = planned || input.sourceWarm ? appliedTtlMs : input.ttlMs
    if (planned && appliedTtlMs === 0) return retire('unsupported')
    if (!planned && !isCacheKeepActiveNow(input.storage, new Date(now))) {
      return refuse('outside configured schedule', 'outside-schedule')
    }
    if (
      input.sourceWarm &&
      previous?.sourceWarm &&
      previous.bodyText === input.bodyText &&
      previous.oauthAccountIdentity === input.oauthAccountIdentity &&
      previous.policyState?.lastRealRequestAt === acceptedAt
    ) {
      const decision = this.policyDecision(previous, now)
      if (decision?.action === 'stop') return retire(decision.reason)
      if (decision?.action === 'wait')
        previous.nextPrewarmAt = Math.max(
          previous.nextPrewarmAt,
          decision.until,
        )
      this.scheduleDueTimer()
      return { tracked: true }
    }

    const today = cacheKeepPeriodKey(input.storage, window, new Date(now))
    this.pruneTargets(now, today)
    if (this.targets.has(input.sessionId)) this.targets.delete(input.sessionId)
    this.stoppedSessions.delete(input.sessionId)

    const headers: Record<string, string> = {}
    input.headers.forEach((value, key) => {
      headers[key] = value
    })

    this.targets.set(input.sessionId, {
      id: input.sessionId,
      url: input.url,
      headers,
      bodyText: input.bodyText,
      bodyBytes,
      // Restoring a replay prefix is not evidence of a newly accepted response.
      ...(input.retained
        ? {
            ttlMs: input.retained.ttlMs,
            lastTouchAt: input.retained.lastTouchAt,
            lastTouchKind: input.retained.lastTouchKind,
          }
        : input.sourceWarm
          ? { ttlMs: replayTtlMs }
          : {
              ttlMs: input.ttlMs ?? CACHE_KEEP_TTL_MS,
              lastTouchAt: acceptedAt,
              lastTouchKind: 'response' as const,
            }),
      cacheExpiresAt:
        input.retained?.cacheExpiresAt ??
        acceptedAt + (replayTtlMs ?? CACHE_KEEP_TTL_MS),
      nextPrewarmAt:
        input.retained?.nextPrewarmAt ??
        (planned || input.sourceWarm
          ? acceptedAt +
            (replayTtlMs ?? CACHE_KEEP_TTL_MS) -
            replayPrewarmLeadMs(replayTtlMs ?? CACHE_KEEP_TTL_MS, planned)
          : acceptedAt +
            (policy?.ttl
              ? CACHE_KEEP_TTL_MS
              : (replayTtlMs ?? CACHE_KEEP_TTL_MS)) -
            CACHE_KEEP_PREWARM_LEAD_MS),
      consecutiveFailures: 0,
      dayKey: today,
      oauthAccountId: input.oauthAccountId,
      oauthAccountIdentity: input.oauthAccountIdentity,
      accountStoragePath: input.accountStoragePath,
      isSubagent: input.isSubagent ?? false,
      // Every 2.7 writer saves policyState for tracked targets. Its absence means
      // an older record: start its count here using the same state as a new target.
      // onTargetChanged and reserveWarm persist that state before the first send.
      policyState: input.retained?.policyState
        ? {
            ...input.retained.policyState,
            warmCostSoFar:
              input.retained.policyState.warmCostSoFar +
              (input.retained.policyState.pendingWarmCost ?? 0),
            pendingWarmCost: undefined,
          }
        : {
            ownerSessionId,
            planned,
            lastRealRequestAt: acceptedAt,
            warmsSinceLastRealRequest: 0,
            warmCostSoFar: 0,
            hasWarmed: input.retained
              ? false
              : (previous?.policyState?.hasWarmed ?? false),
          },
      ...(input.sourceWarm === true && { sourceWarm: true }),
    })
    this.pruneTargets(now, today)
    this.publishTrackedSessions()
    const target = this.targets.get(input.sessionId)
    if (!target)
      return { tracked: false, reason: 'evicted by cachekeep limits' }
    if (input.acceptedUsage)
      updateAcceptedUsage(target, input.bodyText, input.acceptedUsage)
    if (planned) {
      target.ttlMs = appliedTtlMs
      if (!input.retained) target.cacheExpiresAt = acceptedAt + appliedTtlMs
      const decision = this.policyDecision(target, now)
      if (decision?.action === 'stop') {
        this.removeTarget(target, decision.reason, now)
        return { tracked: false, reason: decision.reason }
      }
      if (decision?.action === 'wait') target.nextPrewarmAt = decision.until
    }
    this.options.onTargetChanged?.(target)
    this.start()
    this.scheduleDueTimer()
    return { tracked: true }
  }

  async prewarmNow(input: {
    sessionId: string
    url: string
    headers: Headers
    bodyText: string
    oauthAccountId?: string
    oauthAccountIdentity?: string
    accountStoragePath?: string
    isSubagent?: boolean
  }): Promise<CacheKeepPrewarmResult> {
    const current = this.targets.get(input.sessionId)
    if (
      current &&
      (current.bodyText !== input.bodyText ||
        current.url !== input.url ||
        current.oauthAccountId !== input.oauthAccountId ||
        current.oauthAccountIdentity !== input.oauthAccountIdentity)
    )
      return { ok: false, refused: true, reason: 'stopped' }
    const headers: Record<string, string> = {}
    input.headers.forEach((value, key) => {
      headers[key] = value
    })
    const target: CacheKeepTarget = {
      id: input.sessionId,
      url: input.url,
      bodyText: input.bodyText,
      bodyBytes: Buffer.byteLength(input.bodyText, 'utf8'),
      cacheExpiresAt: this.options.now?.() ?? Date.now(),
      nextPrewarmAt: this.options.now?.() ?? Date.now(),
      consecutiveFailures: 0,
      dayKey: '',
      oauthAccountId: input.oauthAccountId,
      oauthAccountIdentity: input.oauthAccountIdentity,
      accountStoragePath: input.accountStoragePath,
      isSubagent: input.isSubagent ?? false,
      // Share the tracked request's warm count, admitted cost and state object.
      // Replacing that state for a later request invalidates this replay.
      ...current,
      headers,
    }
    if (!current) this.immediateTargets.set(target.id, target)
    try {
      let acceptedAt: number | undefined
      const result = await this.sendPrewarm(target, (receivedAt) => {
        acceptedAt = receivedAt
      })
      if (result.ok && current && this.isCurrentTarget(target)) {
        this.acceptWarm(
          current,
          result,
          acceptedAt ?? this.options.now?.() ?? Date.now(),
        )
        this.scheduleDueTimer()
      }
      return result
    } finally {
      if (this.immediateTargets.get(target.id) === target)
        this.immediateTargets.delete(target.id)
    }
  }

  tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise
    let run: Promise<void>
    run = this.runTick().finally(() => {
      if (this.tickPromise === run) this.tickPromise = null
      this.scheduleDueTimer()
    })
    this.tickPromise = run
    return run
  }

  private async runTick() {
    const storage = await this.options.loadStorage()
    const window = getCacheKeepWindow(storage)
    const now = this.options.now?.() ?? Date.now()
    const today = cacheKeepPeriodKey(storage, window, new Date(now))
    if (isCacheKeepAlways(storage)) {
      for (const target of this.targets.values()) target.dayKey = 'always'
    }

    this.pruneTargets(now, today)
    if (!this.targets.size) {
      this.publishTrackedSessions()
      if (!this.stoppedSessions.size) this.stop()
      return
    }

    logger.debug('cachekeep', 'fired', { targets: this.targets.size })
    // Prewarms are sequential, so serve the least remaining retry window first.
    const targets = [...this.targets.values()].sort(
      (a, b) => this.lastPrewarmStart(a) - this.lastPrewarmStart(b),
    )
    for (const target of targets) {
      // An earlier prewarm's await can let a real request replace or retire
      // this target; only the current one is decided and sent.
      if (this.targets.get(target.id) !== target) continue
      const attemptAt = this.options.now?.() ?? Date.now()
      const decision = this.policyDecision(target, attemptAt)
      if (decision?.action === 'stop') {
        this.removeTarget(target, decision.reason, attemptAt)
        continue
      }
      if (decision?.action === 'wait') {
        target.nextPrewarmAt = Math.max(target.nextPrewarmAt, decision.until)
        continue
      }
      if (!target.policyState?.planned) {
        if (!isCacheKeepHybridActive(storage)) {
          this.removeTarget(target, 'cachekeep-hybrid-inactive', attemptAt)
          continue
        }
        if (!isCacheKeepActiveNow(storage, new Date(attemptAt))) {
          this.removeTarget(target, 'schedule-period-ended', attemptAt)
          continue
        }
        if (isCacheKeepAlways(storage)) {
          const count = this.countDecision(target)
          if (count?.action === 'stop') {
            this.removeTarget(target, count.reason, attemptAt)
            continue
          }
        }
      }
      if (target.nextPrewarmAt > attemptAt) continue
      if (attemptAt > this.lastPrewarmStart(target)) {
        this.removeTarget(
          target,
          target.policyState?.planned ? 'cost-cap' : 'retry-window-ended',
          attemptAt,
        )
        continue
      }
      try {
        await this.prewarm(target, attemptAt)
      } catch (error) {
        logger.warn('cachekeep', 'prewarm failed', {
          session: target.id,
          ...classifyCacheKeepFailure(error, 'send'),
          transient: true,
          ...summarizePrewarmProviderError({ failure: 'transport' }),
        })
        this.scheduleRetry(target, true)
      } finally {
        if (this.targets.get(target.id) === target)
          this.options.onTargetChanged?.(target)
      }
    }
    this.publishTrackedSessions()
  }

  private lastPrewarmStart(target: CacheKeepTarget) {
    return (
      target.cacheExpiresAt -
      (target.policyState?.planned || target.sourceWarm
        ? 0
        : (this.options.prewarmTimeoutMs ?? CACHE_KEEP_PREWARM_TIMEOUT_MS)) -
      CACHE_KEEP_EXPIRY_SAFETY_MS
    )
  }

  private scheduleRetry(target: CacheKeepTarget, transient: boolean) {
    const now = this.options.now?.() ?? Date.now()
    const deadline = this.lastPrewarmStart(target)
    if (now >= deadline) {
      this.removeTarget(
        target,
        target.policyState?.planned ? 'cost-cap' : 'retry-window-ended',
        now,
      )
      return
    }
    target.consecutiveFailures += 1
    const backoff = cacheKeepRetryDelayMs(target.id, target.consecutiveFailures)
    const delay = transient
      ? Math.min(
          backoff,
          CACHE_KEEP_TRANSIENT_RETRY_STEP_MS * target.consecutiveFailures,
          CACHE_KEEP_TRANSIENT_RETRY_MAX_MS,
        )
      : backoff
    target.nextPrewarmAt = Math.min(now + delay, deadline)
  }

  private async sendPrewarm(
    target: CacheKeepTarget,
    onAccepted?: (receivedAt: number) => void,
  ): Promise<CacheKeepPrewarmResult> {
    const remaining =
      target.cacheExpiresAt -
      (this.options.now?.() ?? Date.now()) -
      CACHE_KEEP_EXPIRY_SAFETY_MS
    const timeout = Math.min(
      this.options.prewarmTimeoutMs ?? CACHE_KEEP_PREWARM_TIMEOUT_MS,
      target.policyState?.planned || target.sourceWarm ? remaining : Infinity,
    )
    if (timeout <= 0) return { ok: false, refused: true, reason: 'cost-cap' }
    const attempt = {
      id: ++this.nextPrewarmAttemptId,
      signal: AbortSignal.timeout(timeout),
    }
    let stage: CacheKeepFailureStage = 'authorization'
    let responseStatus: number | undefined
    try {
      let bodyText = target.bodyText
      if (this.options.prepareBody) {
        try {
          bodyText = await this.options.prepareBody(bodyText, target)
        } catch {
          logger.warn('cachekeep', 'prepare body failed', {
            session: target.id,
          })
        }
      }
      const preparedTarget = { ...target, bodyText }
      const prewarm = await buildCacheKeepPrewarmBody(bodyText, {
        stripServerFallback: target.sourceWarm === true,
      })
      if (!prewarm.ok) return prewarm

      if (this.options.validatePrewarm) {
        let verdict: CacheKeepPrewarmValidation | undefined
        try {
          verdict = await this.options.validatePrewarm({
            target,
            warmBodyText: prewarm.bodyText,
          })
        } catch {
          verdict = undefined
        }
        if (!verdict?.ok) {
          // Refused before any send: never dispatch a warm the keeper no
          // longer trusts. The failure branch below removes the target and
          // logs the single warning with the session id and reason code.
          return {
            ok: false,
            refused: true as const,
            reason:
              verdict && !verdict.ok
                ? verdict.reason
                : 'prewarm-validation-failed',
          }
        }
      }

      const fetchImpl = this.options.fetchImpl ?? fetch
      const prewarmTarget = { ...preparedTarget, bodyText: prewarm.bodyText }
      let headers = this.options.prepareHeaders
        ? await this.options.prepareHeaders(
            new Headers(target.headers),
            prewarmTarget,
            attempt,
          )
        : new Headers(target.headers)
      if (!headers) {
        const summary = summarizePrewarmProviderError({
          failure: 'credential_unavailable',
        })
        return {
          ok: false,
          ...summary,
          reason: summary.provider_error.message,
          transient: true,
          ...classifyCacheKeepFailure(undefined, 'authorization'),
        }
      }
      headers.delete('content-length')
      headers.delete('transfer-encoding')
      stage = 'send'
      let response: Response
      // Every physical send gets its own response scope holding exactly the
      // credentials that send carried. Provider bodies are scrubbed before
      // callbacks or dumps read them; transport exceptions retain only closed
      // diagnostics. The scope retires when the error body is read or cancelled;
      // a successful body is passed through untouched.
      const send = async (attemptHeaders: Headers): Promise<Response> => {
        if (!this.isCurrentTarget(target))
          throw new CacheKeepWarmRefusal('stopped')
        if (this.targets.has(target.id) || target.policyState) {
          if (!this.options.deferWarmReservation)
            await this.reserveWarmDispatch(target)
        }
        attempt.signal.throwIfAborted()
        const scope = createProviderErrorResponseScope(
          cacheKeepSentCredentials(attemptHeaders),
          'http',
        )
        try {
          const sent = await fetchImpl(target.url, {
            method: 'POST',
            headers: attemptHeaders,
            body: prewarm.bodyText,
            signal: attempt.signal,
          })
          if (!sent.ok && this.isCurrentTarget(target) && target.policyState) {
            const state = target.policyState
            const cost = this.admittedWarmCosts.get(state) ?? 0
            target.policyState.pendingWarmCost =
              Math.max(0, (target.policyState.pendingWarmCost ?? 0) - cost) ||
              undefined
            this.admittedWarmCosts.delete(state)
            await this.options.settleWarm?.(target)
          }
          return scope.redactResponse(sent)
        } catch (error) {
          if (nativeAccountRefusal(error)) {
            scope.dispose()
            throw error
          }
          scope.dispose()
          throw new CacheKeepPrewarmError('send', error)
        }
      }
      response = await send(headers)
      if (
        response.status === 401 &&
        !attempt.signal?.aborted &&
        this.options.retryOnUnauthorized
      ) {
        let rotatedHeaders: Headers | undefined
        try {
          rotatedHeaders = await this.options.retryOnUnauthorized({
            target: prewarmTarget,
            headers,
            bodyText: prewarm.bodyText,
            attempt,
          })
        } catch (error) {
          if (error instanceof NativeAccountRefusal) {
            await response.body?.cancel().catch(() => {})
            throw error
          }
          // A failed credential lookup cannot justify replay. Observe and
          // report the original 401 against its actual send-time receipt.
        }
        if (rotatedHeaders && !attempt.signal?.aborted) {
          rotatedHeaders.delete('content-length')
          rotatedHeaders.delete('transfer-encoding')
          await response.body?.cancel().catch(() => {})
          headers = rotatedHeaders
          response = await send(headers)
        }
      }
      stage = 'response'
      responseStatus = response.status
      const receivedAt = this.options.now?.() ?? Date.now()
      const raw = await response.text()
      attempt.signal.throwIfAborted()
      let data: unknown = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {}
      const summary = response.ok
        ? undefined
        : summarizePrewarmProviderError({ status: response.status, body: raw })
      try {
        await this.options.onResponse?.({
          target,
          bodyText: prewarm.bodyText,
          status: response.status,
          data,
          receivedAt,
          attempt,
        })
      } catch {}
      try {
        const dumpHandle = await dumpDirectRequest({
          affinity: target.id,
          route: 'cachekeep',
          status: response.status,
          bodyText: prewarm.bodyText,
          url: target.url,
          method: 'POST',
          headers,
          tag: 'cachekeep',
        })
        await dumpResponseArtifact(dumpHandle, {
          status: response.status,
          message: data,
          ...(summary && { provider_error: summary.provider_error }),
        })
      } catch {
        logger.debug('cachekeep', 'dump failed', { session: target.id })
      }
      if (summary) {
        return {
          ok: false,
          ...summary,
          reason: summary.provider_error.message,
          ...classifyCacheKeepFailure(undefined, 'response', response.status),
        }
      }
      const objectData =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : null
      const usage = objectData?.usage as
        | {
            input_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
          }
        | undefined
      onAccepted?.(receivedAt)
      return {
        ok: true,
        ttlMs:
          this.options.responseTtlMs?.(response) ??
          requestCacheLifetimeMs(prewarm.bodyText),
        ...(usage && { usage }),
      }
    } catch (error) {
      if (error instanceof CacheKeepWarmRefusal)
        return { ok: false, refused: true, reason: error.reason }
      const failure = classifyCacheKeepFailure(error, stage, responseStatus)
      const refusal = nativeAccountRefusal(error)
      if (refusal)
        return {
          ok: false,
          reason: refusal.reason,
          refusal: refusal.reason,
          ...failure,
        }
      const summary = summarizePrewarmProviderError({ failure: 'transport' })
      return {
        ok: false,
        ...summary,
        ...failure,
        reason: summary.provider_error.message,
        transient: true,
      }
    } finally {
      try {
        await this.options.onComplete?.({ target, attempt })
      } catch {}
    }
  }

  private async prewarm(target: CacheKeepTarget, now: number) {
    let acceptedAt: number | undefined
    const result = await this.sendPrewarm(target, (receivedAt) => {
      acceptedAt = receivedAt
    })
    if (!result.ok) {
      if (result.refused === true) {
        this.removeTarget(target, result.reason, now, {
          detail: 'prewarm refused before send',
        })
        return
      }
      if (result.refusal) {
        this.removeTarget(target, result.refusal, now, {
          stage: result.stage,
          class: result.class,
        })
      } else if (result.status == null && !result.transient) {
        this.removeTarget(
          target,
          result.reason === 'body is not valid JSON'
            ? 'invalid-json'
            : 'no-breakpoints',
          now,
          { detail: result.reason },
        )
      } else {
        logger.warn('cachekeep', 'prewarm failed', {
          session: target.id,
          status: result.status,
          stage: result.stage,
          class: result.class,
          ...(result.transient && { transient: true }),
          ...(result.provider_error && {
            provider_error: result.provider_error,
          }),
        })
        this.scheduleRetry(
          target,
          result.transient === true ||
            result.status === 408 ||
            result.status === 429 ||
            (result.status !== undefined && result.status >= 500),
        )
      }
      return
    }

    if (this.targets.get(target.id) !== target) return
    acceptedAt ??= this.options.now?.() ?? Date.now()
    this.acceptWarm(target, result, acceptedAt)
  }

  private acceptWarm(
    target: CacheKeepTarget,
    result: Extract<CacheKeepPrewarmResult, { ok: true }>,
    acceptedAt: number,
  ) {
    const state = target.policyState
    if (state) {
      state.hasWarmed = true
      state.lastWarmAt = acceptedAt
      const cost = this.admittedWarmCosts.get(state) ?? 0
      state.warmCostSoFar += cost
      state.pendingWarmCost =
        Math.max(0, (state.pendingWarmCost ?? 0) - cost) || undefined
      this.admittedWarmCosts.delete(state)
      this.reportedStops.delete(state)
      if (!target.sourceWarm)
        reportSessionCacheTouch(state.ownerSessionId, {
          at: acceptedAt,
          ttlMs: result.ttlMs ?? requestCacheLifetimeMs(target.bodyText),
          source: 'warm',
        })
    }
    target.ttlMs =
      state?.planned || target.sourceWarm ? target.ttlMs : CACHE_KEEP_TTL_MS
    target.lastTouchAt = acceptedAt
    target.lastTouchKind = 'warm'
    target.cacheExpiresAt = acceptedAt + (target.ttlMs ?? CACHE_KEEP_TTL_MS)
    target.nextPrewarmAt =
      state?.planned || target.sourceWarm
        ? target.cacheExpiresAt -
          replayPrewarmLeadMs(
            target.ttlMs ?? CACHE_KEEP_TTL_MS,
            state?.planned === true,
          )
        : (readSessionCachePolicy(state?.ownerSessionId ?? target.id, true)?.ttl
            ? acceptedAt + CACHE_KEEP_TTL_MS
            : target.cacheExpiresAt) - CACHE_KEEP_PREWARM_LEAD_MS
    target.consecutiveFailures = 0
    logger.debug('cachekeep', 'prewarm succeeded', {
      session: target.id,
      ...(result.usage && { usage: result.usage }),
    })
    const decision = this.policyDecision(target, acceptedAt)
    if (decision?.action === 'stop')
      this.removeTarget(target, decision.reason, acceptedAt)
  }
}
