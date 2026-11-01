import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseRetryAfterHeader } from './auth.ts'
import type { ProviderAccountUuid } from './claude-code.ts'
import { assertNotCustodyTombstone } from './claustrum.ts'
import {
  CACHE_1H_MODES,
  type Cache1hMode,
  CLAUDE_CODE_VERSION,
  DEFAULT_CACHE_1H_MODE,
} from './constants.ts'
import type { LogLevel } from './logger.ts'
import { isTransientNetworkError } from './network-errors.ts'
import { auxiliaryRequestSignal, raceWithSignal } from './request-abort.ts'

export type { ProviderAccountUuid } from './claude-code.ts'

const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

export const ACCOUNT_FILE_NAME = 'anthropic-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'anthropic-auth-state.json'
export const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

export type QuotaWindowName = 'five_hour' | 'seven_day'
export const QUOTA_FIELD_NAMES = [
  'five_hour',
  'seven_day',
  'scoped',
  'extraUsage',
  'bindingWindow',
  'fallbackAdvised',
] as const
export type QuotaFieldName = (typeof QUOTA_FIELD_NAMES)[number]
export type QuotaFieldSource = 'poll' | 'headers'
export type QuotaFieldSources = Partial<
  Record<QuotaFieldName, QuotaFieldSource>
>

export type AccountBase = {
  id: string
  label?: string
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
}

export type OAuthAccount = AccountBase & {
  type: 'oauth'
  authLineageId?: string
  // Persisted under this name on both fallback accounts and the main profile because the
  // quota feed schema owns the anthropicAccountUuid key; only the branded type and the
  // request-scoped identity variables use the provider-neutral providerAccountUuid name.
  anthropicAccountUuid?: ProviderAccountUuid
  /** Non-secret scoped identity; never a capability handle or bearer token. */
  claustrumScopedCredentialId?: string
  claustrumScopedState?: string
  access?: string
  refresh: string
  expires?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: OAuthQuotaSnapshot
  profile?: OAuthAccountProfile
  /**
   * Per-fallback cumulative prime counters. Lives in the runtime-state file
   * (scoped under `accounts[id].prime`) and never in `anthropic-auth.json`.
   */
  prime?: PrimeUsageCounters
}

export function hasNoLocalCredential(account: {
  access?: unknown
  refresh?: unknown
}): boolean {
  return (
    account.access == null &&
    (account.refresh == null || account.refresh === '')
  )
}

export type ApiKeyAccount = AccountBase & {
  type: 'api'
  apiKey?: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type FallbackAccount = OAuthAccount | ApiKeyAccount

export type ClaustrumMode = 'local' | 'claustrum'

export type ClaustrumConfig = {
  mode?: ClaustrumMode
  /** Set by authoritative scoped discovery, not an authentication toggle. */
  scopedRoster?: true
  /** Producer inventory cursor committed with the roster; never a bearer. */
  rosterView?: string
  /** Authoritative, non-secret primary identity from scoped discovery. */
  primaryAccount?: {
    credentialId: string
    accountId: ProviderAccountUuid
    state: string
    enabled?: boolean
  }
  /** Preserve explicit exclusions when a vaulted account disappears and returns. */
  disabledAccountIdentities?: string[]
}

export function isOAuthAccount(
  account: FallbackAccount,
): account is OAuthAccount {
  return account.type === 'oauth'
}

export function isApiKeyAccount(
  account: FallbackAccount,
): account is ApiKeyAccount {
  return account.type === 'api'
}

export function isValidApiBaseURL(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

export type AccountOperationError = {
  message: string
  checkedAt: number
  nextRetryAt?: number
  retryCount?: number
  accountIdentity?: string
  tokenHash?: string
  /** Fingerprint of the refresh token that produced this error. */
  refreshTokenFingerprint?: string
  /**
   * HTTP status of the underlying refresh/quota failure, when known. Lets
   * consumers distinguish a permanently-dead token (400 invalid_grant →
   * re-login) from a transient failure (429/5xx → recovers) without a delay
   * heuristic. Absent on errors persisted before this field existed.
   */
  status?: number
  /**
   * Explicit dead-token discriminator, set at construction. True ONLY when the
   * refresh endpoint returned 400 invalid_grant (token is genuinely dead →
   * re-login). False for transient failures AND for retry-exhausted/network
   * errors that get a long backoff but are NOT dead — so they are not nagged
   * for re-login. Absent on errors persisted before this field existed (those
   * fall back to status / the 24h-delay heuristic).
   */
  permanent?: boolean
}

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
}

export type AccountScopedQuotaWindow = AccountQuotaWindow & {
  id: string
  title: string
  modelId?: string
  modelName: string
}

export type QuotaMoney = {
  amountMinor: number
  currency: string
  exponent: number
}

export type OAuthExtraUsageSnapshot = {
  used: QuotaMoney
  limit: QuotaMoney
  utilizationPercent?: number
  severity?: string
  exhausted: boolean
}

export type OAuthAccountProfile = {
  tier: string
  orgType: string
  checkedAt: number
  /** Stable account identity; tokenFingerprint remains loadable for legacy state. */
  accountIdentity?: string
  providerAccountUuid?: ProviderAccountUuid
  tokenFingerprint?: string
}

export type OAuthQuotaSnapshot = Partial<
  Record<QuotaWindowName, AccountQuotaWindow>
> & {
  /** Stable main/fallback account identity; access tokens are fetch credentials only. */
  accountIdentity?: string
  scoped?: AccountScopedQuotaWindow[]
  extraUsage?: OAuthExtraUsageSnapshot
  bindingWindow?: string
  bindingWindowSource?: 'poll' | 'headers'
  fieldSources?: QuotaFieldSources
  fallbackAdvised?: boolean
  source?: 'poll' | 'headers'
  // Top-level freshness stamp for the whole snapshot. mergeAccountRuntimeState
  // uses this when the snapshot has no per-window checkedAt (e.g. a windowless
  // empty-scoped snapshot) — without it, a windowless refresh gets read as
  // checkedAt=0 and treated as stale, so an old per-window quota resurrects
  // instead of being overwritten.
  checkedAt?: number
}

export type PrimeUsageCounters = {
  count: number
  inputTokens: number
  outputTokens: number
  since: number
}

export type PrimeUsageDelta = {
  inputTokens?: number
  outputTokens?: number
}

export type PrimeRuntimeState = {
  enabled?: boolean
  mainAuthLineageId?: string
  mainAuthLineageRefreshTokenFingerprint?: string
  /**
   * Main account prime counters. Persisted only on the main side of the
   * runtime-state file — `configFromStorage()` never writes them to the config
   * file so they cannot leak into `anthropic-auth.json`.
   */
  main?: PrimeUsageCounters
}

export type RoutingMode = 'main-first' | 'fallback-first' | 'sticky-balanced'

export type KillswitchThresholds = Partial<
  Record<QuotaWindowName | '5h' | '1w' | 'scoped', number>
>

export type KillswitchConfig = {
  enabled?: boolean
  /** Thresholds for the main OAuth account (remaining % below which the account is killed). */
  main?: KillswitchThresholds
  /** Per-account overrides keyed by account ID. Accounts without an entry use the `main` thresholds. */
  accounts?: Record<string, KillswitchThresholds>
}

export type AccountStorage = {
  version: 1
  mainAccountId?: string
  main?: {
    type: 'opencode'
    provider: 'anthropic'
    profile?: OAuthAccountProfile
  }
  routing?: {
    mode?: RoutingMode
  }
  fallbackOn?: number[]
  refresh?: {
    enabled?: boolean
    intervalMinutes?: number
    refreshBeforeExpiryMinutes?: number
    mainLastRefreshError?: AccountOperationError
    mainRefreshErrorClearedAt?: number
    mainRefreshLeaseId?: string
    mainRefreshLeaseUntil?: number
    mainRefreshLeaseTokenHash?: string
  }
  quota?: {
    enabled?: boolean
    checkIntervalMinutes?: number
    refreshEveryNRequests?: number
    minimumRemaining?: Partial<Record<QuotaWindowName | '5h' | '1w', number>>
    failClosedOnUnknownQuota?: boolean
    /** Opt-in OpenCode TUI toast after quota refresh. Default: false. */
    showToasts?: boolean
    mainQuota?: OAuthQuotaSnapshot
    mainQuotaCheckedAt?: number
    // Fingerprint of the access token that produced mainQuota. Used to avoid
    // seeding a different account's persisted quota after a main-account switch.
    mainQuotaToken?: string
    mainLastQuotaApiError?: AccountOperationError
    // Monotonic transition marker. Unlike an absent error, a newer marker is an
    // affirmative cross-process clear that stale writers must not resurrect.
    mainQuotaErrorGeneration?: number
    // Observation time for the clear; rejects errors observed before it even
    // when a separate process allocated an equal or higher generation.
    mainQuotaErrorClearedAt?: number
  }
  quotaHeaderFeed?: {
    enabled?: boolean
  }
  claudeCache?: {
    enabled?: boolean
    mode?: Cache1hMode
  }
  dump?: {
    enabled?: boolean
  }
  logging?: {
    level?: LogLevel
  }
  claudeFast?: {
    enabled?: boolean
  }
  thinkingBinding?: {
    prefixMismatchBehavior?: 'account-default' | 'error' | 'drop_block'
  }
  /**
   * Tool names (as the host names them) whose calls after a long reply get a
   * system note telling the model not to repeat that reply. Unset means the
   * `board` and `ctx_reduce` tools; an empty list turns the note off.
   */
  turnEndNote?: { tools: string[] }
  /**
   * Zero out Anthropic OAuth model costs in the provider hook. Default: enabled
   * (OAuth usage is quota-based, not per-token billed, so costs show as $0).
   * Set `enabled: false` to opt out and display the provider's real model costs.
   */
  costZeroing?: {
    enabled?: boolean
  }
  cacheKeep?: {
    enabled?: boolean
    always?: boolean
    startHour?: number
    endHour?: number
    subagents?: boolean
  }
  /**
   * Opt-in flag and runtime metadata for `/claude-prime`. The `enabled` flag
   * belongs on the config side; counters and main lineage bindings live in the
   * state file and must never appear in `anthropic-auth.json`. See
   * `configFromStorage()` for the write-side filter.
   */
  prime?: PrimeRuntimeState
  relay?: {
    enabled?: boolean
    url?: string
    token?: string
    /**
     * Whether a private relay token is stored. Native account snapshots set
     * this instead of `token`, which they never include.
     */
    tokenConfigured?: boolean
    fallbackToDirect?: boolean
    /** When missing, inferred from `url`; see `effectiveRelayTransport`. */
    transport?: 'http' | 'websocket'
  }
  claustrum?: ClaustrumConfig
  killswitch?: KillswitchConfig
  accounts: FallbackAccount[]
}

/**
 * Whether Anthropic OAuth model costs should be zeroed in the provider hook.
 * Defaults to enabled; only an explicit `costZeroing.enabled === false` opts out
 * (to display the provider's real model costs).
 */
export function isCostZeroingEnabled(
  storage: Pick<AccountStorage, 'costZeroing'>,
): boolean {
  return storage.costZeroing?.enabled !== false
}

export type AccountRuntimeEntry = Partial<
  Pick<
    OAuthAccount,
    | 'access'
    | 'authLineageId'
    | 'anthropicAccountUuid'
    | 'claustrumScopedCredentialId'
    | 'claustrumScopedState'
    | 'refresh'
    | 'expires'
    | 'lastUsed'
    | 'lastRefreshedAt'
    | 'lastRefreshError'
    | 'lastQuotaRefreshError'
    | 'quota'
    | 'profile'
    | 'prime'
  > &
    Pick<ApiKeyAccount, 'apiKey' | 'lastUsed'>
>

export type AccountRuntimeState = {
  version: 1
  main?: {
    scopedAccountIdentity?: string
    profile?: OAuthAccountProfile
    profileToken?: string
    quota?: OAuthQuotaSnapshot
    quotaCheckedAt?: number
    quotaToken?: string
    lastQuotaApiError?: AccountOperationError
    quotaErrorGeneration?: number
    quotaErrorClearedAt?: number
    lastRefreshError?: AccountOperationError
    refreshErrorClearedAt?: number
    refreshLeaseId?: string
    refreshLeaseUntil?: number
    refreshLeaseTokenHash?: string
    prime?: PrimeUsageCounters
    primeAuthLineageId?: string
    primeAuthLineageRefreshTokenFingerprint?: string
  }
  accounts?: Record<string, AccountRuntimeEntry>
}

export type AccountStateSaveScope = {
  mainProfile?: boolean
  mainQuota?: boolean
  mainRefresh?: boolean
  mainPrime?: boolean
  accounts?: true | string[]
}

type OAuthUsageWindow = {
  utilization?: number
  resets_at?: string | null
}

type OAuthUsageLimit = {
  kind?: string
  group?: string
  percent?: number
  resets_at?: string | null
  is_active?: boolean
  scope?: {
    model?: {
      id?: string | null
      display_name?: string | null
    } | null
    surface?: unknown
  } | null
}

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
  limits?: OAuthUsageLimit[]
  extra_usage?: {
    is_enabled?: boolean
    monthly_limit?: number | null
    used_credits?: number | null
    utilization?: number | null
  } | null
  spend?: {
    severity?: string | null
    limit?: {
      amount_minor?: number
      currency?: string
      exponent?: number
    } | null
  } | null
}

const DEFAULT_FALLBACK_ON = [401, 403, 429]
const MIN_REFRESH_BEFORE_EXPIRY_MINUTES = 240
const DEFAULT_REFRESH_BEFORE_EXPIRY_MINUTES = MIN_REFRESH_BEFORE_EXPIRY_MINUTES
const DEFAULT_REFRESH_INTERVAL_MINUTES = 10
const MIN_REFRESH_RETRY_DELAY_MS = 5 * 60_000
const MAX_REFRESH_RETRY_DELAY_MS = 60 * 60_000
const NON_TRANSIENT_REFRESH_RETRY_DELAY_MS = 24 * 60 * 60_000
const MIN_QUOTA_RETRY_DELAY_MS = 60_000
const MAX_QUOTA_RETRY_DELAY_MS = 15 * 60_000
const NON_TRANSIENT_QUOTA_RETRY_DELAY_MS = 5 * 60_000
const DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES = 5
const DEFAULT_MINIMUM_REMAINING: Record<QuotaWindowName, number> = {
  five_hour: 0,
  seven_day: 0,
}
const DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA = true
export const FALLBACK_BACKGROUND_TICK_MS = 60_000

/** OpenCode's config folder, as OpenCode itself resolves it. */
export function getOpenCodeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (env.OPENCODE_CONFIG_DIR?.trim()) {
    return env.OPENCODE_CONFIG_DIR.trim()
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
}

export function getAccountStoragePath() {
  return (
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim() ||
    join(getOpenCodeConfigDir(), ACCOUNT_FILE_NAME)
  )
}

export function getAccountStatePath(configPath = getAccountStoragePath()) {
  const explicit = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE?.trim()
  if (explicit) return explicit
  return configPath.endsWith(ACCOUNT_FILE_NAME)
    ? join(dirname(configPath), ACCOUNT_STATE_FILE_NAME)
    : `${configPath}.state.json`
}

// Fresh empty storage shell — main OpenCode OAuth account, no fallback
// accounts. Returns a new object each call so mutating callers don't alias.
export function createEmptyStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
  }
}

// A clear is a monotonic tombstone; older or absent writes must not reopen backoff.
export function mergeMainQuotaErrorClearedAt(
  existing: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined || !Number.isFinite(incoming)) return existing
  if (existing === undefined || !Number.isFinite(existing)) return incoming
  return Math.max(existing, incoming)
}

export function mergeMainRefreshErrorClearedAt(
  existing: number | undefined,
  incoming: number | undefined,
): number | undefined {
  if (incoming === undefined || !Number.isFinite(incoming)) return existing
  if (existing === undefined || !Number.isFinite(existing)) return incoming
  return Math.max(existing, incoming)
}

/** Returns the latest timestamp carried by any quota snapshot window. */
export function quotaSnapshotCheckedAt(quota: OAuthQuotaSnapshot | undefined) {
  return Math.max(
    quota?.five_hour?.checkedAt ?? 0,
    quota?.seven_day?.checkedAt ?? 0,
    ...(quota?.scoped?.map((window) => window.checkedAt) ?? []),
    quota?.checkedAt ?? 0,
  )
}

function quotaSourcePrecedence(quota: OAuthQuotaSnapshot | undefined) {
  if (quota?.source === 'poll') return 2
  if (quota?.source === 'headers') return 1
  return 0
}

function mergeHeaderScopedQuota(
  existing: OAuthQuotaSnapshot,
  incoming: OAuthQuotaSnapshot,
) {
  if (!('scoped' in existing)) return incoming.scoped
  if (!Array.isArray(existing.scoped) || existing.scoped.length === 0) {
    return existing.scoped
  }
  if (!Array.isArray(incoming.scoped) || incoming.scoped.length === 0) {
    return existing.scoped
  }
  const merged = new Map(incoming.scoped.map((window) => [window.id, window]))
  for (const window of existing.scoped) {
    const candidate = merged.get(window.id)
    if (!candidate || window.checkedAt >= candidate.checkedAt) {
      merged.set(window.id, window)
    }
  }
  return [...merged.values()]
}

function mergeHeaderOwnedWindow(
  existingSnapshot: OAuthQuotaSnapshot,
  incomingSnapshot: OAuthQuotaSnapshot,
  key: QuotaWindowName,
) {
  const existing = existingSnapshot[key]
  const incoming = incomingSnapshot[key]
  if (!incoming) return existing
  // A successful poll can remove the session limit. Older headers must not
  // resurrect a window that the provider no longer reports for this account.
  if (
    key === 'five_hour' &&
    quotaSnapshotOmitsFiveHour(existingSnapshot) &&
    incoming.checkedAt <= (existingSnapshot.checkedAt ?? 0)
  )
    return undefined
  if (!existing) return incoming
  if (incoming.checkedAt > existing.checkedAt) return incoming
  if (incoming.checkedAt < existing.checkedAt) return existing
  return quotaSourcePrecedence(existingSnapshot) >
    quotaSourcePrecedence(incomingSnapshot)
    ? existing
    : incoming
}

export function quotaFieldSource(
  snapshot: OAuthQuotaSnapshot | undefined,
  field: QuotaFieldName,
): QuotaFieldSource | undefined {
  if (!snapshot || snapshot[field] === undefined) return undefined
  return (
    snapshot.fieldSources?.[field] ??
    (snapshot.source === 'poll' || snapshot.source === 'headers'
      ? snapshot.source
      : undefined)
  )
}

function fieldSourcesForMergedQuota(
  existing: OAuthQuotaSnapshot,
  incoming: OAuthQuotaSnapshot,
  merged: OAuthQuotaSnapshot,
): QuotaFieldSources | undefined {
  const fieldSources: QuotaFieldSources = {}
  for (const field of QUOTA_FIELD_NAMES) {
    if (merged[field] === undefined) continue
    if (field === 'scoped' || field === 'extraUsage') {
      fieldSources[field] = 'poll'
      continue
    }
    if (
      field === 'bindingWindow' &&
      existing.bindingWindowSource === 'poll' &&
      existing.bindingWindow === merged.bindingWindow
    ) {
      fieldSources[field] = 'poll'
      continue
    }
    if (
      field === 'fallbackAdvised' &&
      incoming.fieldSources?.fallbackAdvised === undefined
    ) {
      const source = quotaFieldSource(existing, field)
      if (source) fieldSources[field] = source
      continue
    }
    const source =
      incoming[field] === merged[field]
        ? quotaFieldSource(incoming, field)
        : existing[field] === merged[field]
          ? quotaFieldSource(existing, field)
          : (quotaFieldSource(existing, field) ??
            quotaFieldSource(incoming, field))
    if (source) fieldSources[field] = source
  }
  // The existing provenance field can describe a poll-owned absence too.
  if (!merged.five_hour && quotaSnapshotOmitsFiveHour(existing))
    fieldSources.five_hour = 'poll'
  return Object.keys(fieldSources).length > 0 ? fieldSources : undefined
}

export function mergeHeaderQuotaForPersistence(
  existing: OAuthQuotaSnapshot | undefined,
  incoming: OAuthQuotaSnapshot,
) {
  if (!existing || incoming.source !== 'headers') return incoming
  const preservePollBinding = existing.bindingWindowSource === 'poll'
  const merged = {
    ...existing,
    ...incoming,
    five_hour: mergeHeaderOwnedWindow(existing, incoming, 'five_hour'),
    seven_day: mergeHeaderOwnedWindow(existing, incoming, 'seven_day'),
    scoped: mergeHeaderScopedQuota(existing, incoming),
    extraUsage: existing.extraUsage ?? incoming.extraUsage,
    fallbackAdvised:
      incoming.fieldSources?.fallbackAdvised !== undefined
        ? incoming.fallbackAdvised
        : (existing.fallbackAdvised ?? incoming.fallbackAdvised),
    bindingWindow: preservePollBinding
      ? existing.bindingWindow
      : (incoming.bindingWindow ?? existing.bindingWindow),
    bindingWindowSource: preservePollBinding
      ? 'poll'
      : (incoming.bindingWindowSource ?? existing.bindingWindowSource),
    // Keep the successful poll's absence evidence and original clock so later
    // merges can distinguish older polls from newer observations.
    ...(quotaSnapshotOmitsFiveHour(existing) && {
      checkedAt: existing.checkedAt,
    }),
  } satisfies OAuthQuotaSnapshot
  const fieldSources = fieldSourcesForMergedQuota(existing, incoming, merged)
  return {
    ...merged,
    ...(fieldSources && { fieldSources }),
  }
}

export function getClaustrumMode(
  storage: AccountStorage | null,
): ClaustrumMode {
  return storage?.claustrum?.mode === 'claustrum' ? 'claustrum' : 'local'
}

export async function acquireRefreshFileLock(options: {
  name: string
  ttlMs: number
  path?: string
  renew?: boolean
  renewIntervalMs?: number
  onStep?: (
    step:
      | 'stale-marker-stat'
      | 'stale-marker-claimed'
      | 'stale-lock-confirmed'
      | 'eviction-marker-acquired',
  ) => void | Promise<void>
}): Promise<{
  release: () => Promise<void>
  assertOwned: () => Promise<void>
} | null> {
  const accountPath = options.path ?? getAccountStoragePath()
  const lockPath = `${accountPath}.${options.name}.lock`
  const legacyOwnerPath = join(lockPath, 'owner.json')
  const ownerId = randomUUID()
  const now = Date.now
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let released = false

  async function readOwner() {
    try {
      return JSON.parse(await readFile(lockPath, 'utf8'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EISDIR') throw error
      return JSON.parse(await readFile(legacyOwnerPath, 'utf8'))
    }
  }

  async function writeOwner() {
    await writeFile(
      lockPath,
      `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  async function tryAcquire() {
    try {
      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerId, expiresAt: now() + options.ttlMs })}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      )
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'EISDIR') return false
      throw error
    }
  }

  function scheduleRenewal() {
    if (!options.renew || released) return
    const intervalMs =
      options.renewIntervalMs ?? Math.max(1_000, Math.floor(options.ttlMs / 3))
    renewTimer = setRefreshLockRenewalTimeout(() => {
      void (async () => {
        try {
          const owner = await readOwner()
          const currentNow = now()
          if (
            released ||
            owner?.ownerId !== ownerId ||
            Number(owner?.expiresAt) <= currentNow
          ) {
            return
          }
          await writeOwner()
          scheduleRenewal()
        } catch {
          // If renewal fails, contenders will wait until the last written expiry.
        }
      })()
    }, intervalMs)
    if ('unref' in renewTimer) renewTimer.unref()
  }

  let acquired = await tryAcquire()
  if (!acquired) {
    const evictPath = `${lockPath}.evicting`
    const evictOwnerPath = join(evictPath, 'owner.json')
    const evictOwnerId = randomUUID()
    const EVICT_TTL = 5_000
    const MAX_STEAL_ATTEMPTS = 8

    async function backoff() {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.floor(Math.random() * 4)),
      )
    }

    async function lockIsLive() {
      try {
        const currentOwner = await readOwner()
        return Number(currentOwner?.expiresAt) > now()
      } catch {
        try {
          const current = await stat(lockPath)
          return current.mtimeMs + options.ttlMs > now()
        } catch {
          // Lock doesn't exist — safe to acquire.
          return false
        }
      }
    }

    async function ownsEvictionMarker() {
      try {
        const owner = JSON.parse(await readFile(evictOwnerPath, 'utf8'))
        return owner?.ownerId === evictOwnerId
      } catch {
        return false
      }
    }

    async function tryAcquireEvictionMarker() {
      await mkdir(evictPath)
      try {
        await writeFile(
          evictOwnerPath,
          `${JSON.stringify({ ownerId: evictOwnerId, createdAt: now() })}\n`,
          { encoding: 'utf8', mode: 0o600, flag: 'wx' },
        )
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        // Another contender can rename the marker directory between mkdir and
        // this exclusive create. Darwin/Bun reports that lost-parent race as
        // either ENOENT or EINVAL; both mean this contender lost the marker.
        if (code === 'ENOENT' || code === 'EINVAL') return false
        await releaseEvictionMarker()
        throw error
      }
      await options.onStep?.('eviction-marker-acquired')
      return true
    }

    async function releaseEvictionMarker() {
      if (await ownsEvictionMarker()) {
        await rm(evictPath, { recursive: true, force: true }).catch(() => {})
      }
    }

    for (let attempt = 0; attempt < MAX_STEAL_ATTEMPTS; attempt++) {
      acquired = await tryAcquire()
      if (acquired) break
      if (await lockIsLive()) return null

      try {
        if (!(await tryAcquireEvictionMarker())) {
          await backoff()
          continue
        }
      } catch (evictError) {
        const code = (evictError as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw evictError

        let evictStat: Awaited<ReturnType<typeof stat>>
        try {
          evictStat = await stat(evictPath)
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') {
            await backoff()
            continue
          }
          throw statError
        }
        if (evictStat.mtimeMs + EVICT_TTL > now()) return null

        await options.onStep?.('stale-marker-stat')
        const claimedPath = `${evictPath}.${randomUUID()}`
        try {
          await rename(evictPath, claimedPath)
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') {
            await backoff()
            continue
          }
          throw renameError
        }
        await options.onStep?.('stale-marker-claimed')
        await rm(claimedPath, { recursive: true, force: true }).catch(() => {})
        await backoff()
        continue
      }

      try {
        if (await lockIsLive()) return null
        if (!(await ownsEvictionMarker())) return null
        await options.onStep?.('stale-lock-confirmed')
        if (!(await ownsEvictionMarker())) return null
        await rm(lockPath, { recursive: true, force: true }).catch(() => {})
        if (!(await ownsEvictionMarker())) return null
        acquired = await tryAcquire()
        if (!acquired) return null
        if (!(await ownsEvictionMarker())) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {})
          acquired = false
          return null
        }
        break
      } finally {
        await releaseEvictionMarker()
      }
    }
  }

  if (!acquired) return null

  scheduleRenewal()

  return {
    assertOwned: async () => {
      const owner = await readOwner().catch(() => undefined)
      if (released || owner?.ownerId !== ownerId) {
        throw new Error('Account file lock ownership was lost')
      }
    },
    release: async () => {
      released = true
      if (renewTimer) {
        clearRefreshLockRenewalTimeout(renewTimer)
        renewTimer = null
      }
      try {
        const owner = await readOwner()
        if (owner?.ownerId !== ownerId) return
      } catch {
        return
      }
      await rm(lockPath, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export function isCache1hPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeCache?.enabled === true
}

function normalizeCache1hMode(value: unknown): Cache1hMode {
  return typeof value === 'string' &&
    CACHE_1H_MODES.includes(value as Cache1hMode)
    ? (value as Cache1hMode)
    : DEFAULT_CACHE_1H_MODE
}

export function getCache1hPersistentMode(
  storage: AccountStorage | null,
): Cache1hMode {
  return normalizeCache1hMode(storage?.claudeCache?.mode)
}

export function isDumpPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.dump?.enabled === true
}

export function isFastModePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeFast?.enabled === true
}

export function isCacheKeepSubagentsEnabled(storage: AccountStorage | null) {
  return storage?.cacheKeep?.subagents === true
}

export function isPrimePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.prime?.enabled === true
}

function getFallbackStatuses(storage: AccountStorage | null) {
  return storage?.fallbackOn?.length ? storage.fallbackOn : DEFAULT_FALLBACK_ON
}

export function shouldFallbackStatus(
  status: number,
  storage: AccountStorage | null,
) {
  return getFallbackStatuses(storage).includes(status)
}

export function getQuotaMinimumRemainingThresholds(
  storage: AccountStorage | null,
) {
  const configured = storage?.quota?.minimumRemaining || {}
  return {
    five_hour:
      configured.five_hour ??
      configured['5h'] ??
      DEFAULT_MINIMUM_REMAINING.five_hour,
    seven_day:
      configured.seven_day ??
      configured['1w'] ??
      DEFAULT_MINIMUM_REMAINING.seven_day,
  }
}

function quotaEnabled(storage: AccountStorage | null) {
  return storage?.quota?.enabled !== false
}

function refreshBeforeExpiryMs(storage: AccountStorage | null) {
  const minutes =
    storage?.refresh?.refreshBeforeExpiryMinutes ??
    DEFAULT_REFRESH_BEFORE_EXPIRY_MINUTES
  return Math.max(MIN_REFRESH_BEFORE_EXPIRY_MINUTES, minutes) * 60_000
}

export function getRefreshBeforeExpiryMs(storage: AccountStorage | null) {
  return refreshBeforeExpiryMs(storage)
}

export function getRefreshIntervalMs(storage: AccountStorage | null) {
  const minutes =
    storage?.refresh?.intervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES
  return Math.max(1, minutes) * 60_000
}

export function hashRefreshToken(refreshToken: string) {
  return createHash('sha256').update(refreshToken).digest('hex')
}

function isTransientRefreshError(error: unknown) {
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isFinite(status)) {
    return status === 429 || status >= 500
  }
  return isTransientNetworkError(error)
}

export function buildRefreshOperationError(input: {
  error: unknown
  now: number
  accountIdentity: string | undefined
  refreshTokenFingerprint?: string
  previous?: AccountOperationError
}): AccountOperationError {
  const previousRetryCount =
    input.previous?.accountIdentity === input.accountIdentity &&
    input.previous?.refreshTokenFingerprint === input.refreshTokenFingerprint
      ? (input.previous?.retryCount ?? 0)
      : 0
  const retryCount = previousRetryCount + 1
  const retryAfterFromError = (input.error as { retryAfter?: unknown })
    .retryAfter
  let delay: number
  if (typeof retryAfterFromError === 'number' && retryAfterFromError > 0) {
    delay = retryAfterFromError * 1000
  } else if (isTransientNetworkError(input.error)) {
    delay = MIN_REFRESH_RETRY_DELAY_MS
  } else if (isTransientRefreshError(input.error)) {
    delay = Math.min(
      MAX_REFRESH_RETRY_DELAY_MS,
      MIN_REFRESH_RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 6),
    )
  } else {
    delay = NON_TRANSIENT_REFRESH_RETRY_DELAY_MS
  }
  const statusFromError = (input.error as { status?: unknown }).status
  const status =
    typeof statusFromError === 'number' && Number.isFinite(statusFromError)
      ? statusFromError
      : undefined
  const message = formatErrorMessage(input.error)
  // A token is permanently dead ONLY on 400 invalid_grant. The OAuth spec allows
  // other 400s (invalid_client / invalid_request / unsupported_grant_type) that
  // re-login does NOT fix — those must stay permanent=false so they are not
  // falsely flagged "needs re-login". Network failures use a fixed five-minute
  // retry interval so connectivity recovery cannot inherit an hour-long backoff.
  // ClaudeOAuthRefreshError carries the raw
  // OAuth body, and its message embeds it (`...: 400 — <body>`), so check both.
  const body =
    typeof (input.error as { body?: unknown }).body === 'string'
      ? (input.error as { body: string }).body
      : ''
  const isInvalidGrant =
    body.includes('invalid_grant') || message.includes('invalid_grant')
  return {
    message,
    checkedAt: input.now,
    nextRetryAt: input.now + delay,
    retryCount,
    accountIdentity: input.accountIdentity,
    refreshTokenFingerprint: input.refreshTokenFingerprint,
    status,
    permanent: status === 400 && isInvalidGrant,
  }
}

/**
 * True when a refresh error means the token is permanently dead and the account
 * needs a re-login (vs a transient failure that recovers).
 *
 * Precedence:
 *  1. the explicit `permanent` flag (set at construction from 400 invalid_grant)
 *     — the authoritative signal; correctly classifies a retry-exhausted/network
 *     error (long backoff, but NOT dead) as non-permanent;
 *  2. else the captured HTTP `status` — 400 (for errors built before `permanent`
 *     existed but after `status`);
 *  3. else the legacy 24h-delay heuristic — back-compat ONLY for errors persisted
 *     before either field existed (e.g. an operator's already-dead token: no
 *     status, ~24h backoff). It still flags those until the next refresh restamps
 *     the error with the explicit field.
 */
export function isPermanentRefreshError(
  error: AccountOperationError | undefined,
): boolean {
  if (!error) return false
  if (typeof error.permanent === 'boolean') return error.permanent
  if (typeof error.status === 'number') return error.status === 400
  if (isTransientNetworkError(error)) return false
  if (typeof error.nextRetryAt === 'number') {
    return (
      error.nextRetryAt - error.checkedAt >=
      NON_TRANSIENT_REFRESH_RETRY_DELAY_MS
    )
  }
  return false
}

function effectiveRefreshRetryAt(error: AccountOperationError) {
  const persistedRetryAt = error.nextRetryAt
  if (!persistedRetryAt || !isTransientNetworkError(error)) {
    return persistedRetryAt
  }
  return Math.min(
    persistedRetryAt,
    error.checkedAt + MIN_REFRESH_RETRY_DELAY_MS,
  )
}

export function refreshBackoffActive(
  error: AccountOperationError | undefined,
  accountIdentity: string | undefined,
  now: number,
  currentRefreshTokenFingerprint: string | undefined,
) {
  if (!error) return false
  const retryAt = effectiveRefreshRetryAt(error)
  if (!retryAt || retryAt <= now) return false
  if (
    error.refreshTokenFingerprint &&
    currentRefreshTokenFingerprint &&
    error.refreshTokenFingerprint !== currentRefreshTokenFingerprint
  ) {
    return false
  }
  if (!error.accountIdentity) return true
  if (!accountIdentity) return true
  return error.accountIdentity === accountIdentity
}

export function formatRefreshBackoffMessage(
  error: AccountOperationError,
  now: number,
) {
  const seconds = Math.max(
    1,
    Math.ceil(((effectiveRefreshRetryAt(error) ?? now) - now) / 1000),
  )
  return `Claude OAuth refresh is backed off for ${seconds}s after: ${error.message}`
}

export function getFallbackReauthLabels(
  storage: AccountStorage | null | undefined,
): string[] {
  if (!storage) return []
  return storage.accounts
    .filter(
      (account): account is OAuthAccount =>
        account.enabled !== false &&
        isOAuthAccount(account) &&
        isPermanentRefreshError(account.lastRefreshError),
    )
    .map((account) => account.label?.trim() || account.id)
}

export function isQuotaPolicyAuthError(error: unknown) {
  const status = (error as { status?: unknown }).status
  if (status === 403) return true
  return /Claude quota check failed: 403\b/.test(formatErrorMessage(error))
}

export function buildQuotaOperationError(input: {
  error: unknown
  now: number
  accountIdentity?: string
  previous?: AccountOperationError
}): AccountOperationError {
  const previousRetryCount =
    input.previous?.accountIdentity === input.accountIdentity
      ? (input.previous?.retryCount ?? 0)
      : 0
  const retryCount = previousRetryCount + 1
  const delay = isTransientQuotaError(input.error)
    ? Math.min(
        MAX_QUOTA_RETRY_DELAY_MS,
        MIN_QUOTA_RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 6),
      )
    : NON_TRANSIENT_QUOTA_RETRY_DELAY_MS
  return {
    message: formatErrorMessage(input.error),
    checkedAt: input.now,
    nextRetryAt: input.now + delay,
    retryCount,
    ...(input.accountIdentity !== undefined && {
      accountIdentity: input.accountIdentity,
    }),
  }
}

export function quotaBackoffActive(
  error: AccountOperationError | undefined,
  now: number,
): boolean {
  if (!error?.nextRetryAt || error.nextRetryAt <= now) return false
  return true
}

export function formatQuotaBackoffMessage(
  error: AccountOperationError,
  now: number,
): string {
  const seconds = Math.max(
    1,
    Math.ceil(((error.nextRetryAt ?? now) - now) / 1000),
  )
  return `Quota API backed off for ${seconds}s after: ${error.message}`
}

export function getQuotaCheckIntervalMs(storage: AccountStorage | null) {
  const minutes =
    storage?.quota?.checkIntervalMinutes ?? DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES
  return Math.max(1, minutes) * 60_000
}

export function getPersistedLogLevel(
  storage: AccountStorage | null,
): LogLevel | undefined {
  return storage?.logging?.level
}

export function getPersistedMainQuota(storage: AccountStorage | null): {
  quota: OAuthQuotaSnapshot
  checkedAt: number
  tokenFingerprint?: string
  accountIdentity?: string
} | null {
  const quota = storage?.quota?.mainQuota
  if (!quota) return null
  return {
    quota,
    checkedAt: quotaSnapshotCheckedAt(quota),
    tokenFingerprint: storage.quota?.mainQuotaToken,
    accountIdentity: quota.accountIdentity,
  }
}

/**
 * How often (in requests) to force a quota refresh, independent of the timer.
 * Returns 0 when disabled (default).
 */
export function getQuotaRefreshEveryNRequests(
  storage: AccountStorage | null,
): number {
  const n = storage?.quota?.refreshEveryNRequests
  return typeof n === 'number' && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0
}

function failClosedOnUnknownQuota(storage: AccountStorage | null) {
  return (
    storage?.quota?.failClosedOnUnknownQuota ??
    DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA
  )
}

function normalizeScopedQuotaModel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function scopedQuotaModelKey(model: unknown): string | null {
  if (typeof model !== 'string') return null
  const normalized = normalizeScopedQuotaModel(model)
  if (normalized.includes('fable')) return 'fable'
  if (normalized.includes('mythos')) return 'mythos'
  return normalized
}

export function getScopedQuotaWindowForModel(
  quota: OAuthQuotaSnapshot | undefined,
  model: unknown,
): AccountScopedQuotaWindow | undefined {
  const key = scopedQuotaModelKey(model)
  if (!key) return undefined
  return quota?.scoped?.find((window) => {
    const haystack = [window.modelId, window.modelName, window.title]
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeScopedQuotaModel)
      .join(' ')
    return haystack.includes(key)
  })
}

export function quotaSnapshotModelScopeIsExhausted(
  quota: OAuthQuotaSnapshot | undefined,
  model: unknown,
) {
  const window = getScopedQuotaWindowForModel(quota, model)
  return Boolean(
    window &&
      Number.isFinite(window.remainingPercent) &&
      window.remainingPercent <= 0,
  )
}

export function quotaSnapshotPassesModelScope(
  quota: OAuthQuotaSnapshot | undefined,
  model: unknown,
) {
  return !quotaSnapshotModelScopeIsExhausted(quota, model)
}

export function quotaSnapshotPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
) {
  if (!quotaEnabled(storage)) return true
  const thresholds = getQuotaMinimumRemainingThresholds(storage)
  let sawUnknownWindow = false
  for (const key of ['five_hour', 'seven_day'] as const) {
    if (key === 'five_hour' && quotaSnapshotOmitsFiveHour(quota)) continue
    const window = quota?.[key]
    if (!window || !Number.isFinite(window.remainingPercent)) {
      sawUnknownWindow = true
      continue
    }
    if (window.remainingPercent < thresholds[key]) return false
  }
  return !sawUnknownWindow || !failClosedOnUnknownQuota(storage)
}

/** A poll's omitted session window is evidence, unlike a partial header harvest. */
export function quotaSnapshotOmitsFiveHour(
  quota: OAuthQuotaSnapshot | undefined,
): quota is OAuthQuotaSnapshot & {
  checkedAt: number
  five_hour?: undefined
  seven_day: AccountQuotaWindow
} {
  return Boolean(
    (quota?.source === 'poll' || quota?.fieldSources?.five_hour === 'poll') &&
      quota &&
      !quota.five_hour &&
      quota.seven_day &&
      Number.isFinite(quota.checkedAt) &&
      (quota.checkedAt ?? 0) > 0,
  )
}

export function quotaSnapshotHasStandardWindows(
  quota: OAuthQuotaSnapshot | undefined,
): quota is OAuthQuotaSnapshot {
  return Boolean(
    quota?.seven_day && (quota.five_hour || quotaSnapshotOmitsFiveHour(quota)),
  )
}

// ---------------------------------------------------------------------------
// Killswitch — hard-block requests when remaining quota drops below per-account
// thresholds, even if the API would still accept them.
// ---------------------------------------------------------------------------

export const DEFAULT_KILLSWITCH_THRESHOLDS: Record<
  QuotaWindowName | 'scoped',
  number
> = {
  five_hour: 5,
  seven_day: 10,
  scoped: 0,
}

export function normalizeKillswitchThresholds(
  thresholds: KillswitchThresholds | undefined,
): Record<QuotaWindowName | 'scoped', number> {
  const fiveHour = thresholds?.five_hour ?? thresholds?.['5h']
  const sevenDay = thresholds?.seven_day ?? thresholds?.['1w']
  const scoped = thresholds?.scoped
  return {
    five_hour:
      typeof fiveHour === 'number' && Number.isFinite(fiveHour)
        ? fiveHour
        : DEFAULT_KILLSWITCH_THRESHOLDS.five_hour,
    seven_day:
      typeof sevenDay === 'number' && Number.isFinite(sevenDay)
        ? sevenDay
        : DEFAULT_KILLSWITCH_THRESHOLDS.seven_day,
    scoped:
      typeof scoped === 'number' && Number.isFinite(scoped)
        ? scoped
        : DEFAULT_KILLSWITCH_THRESHOLDS.scoped,
  }
}

export function isKillswitchEnabled(storage: AccountStorage | null) {
  return storage?.killswitch?.enabled === true
}

export function getKillswitchThresholdsForAccount(
  storage: AccountStorage | null,
  accountId?: string,
): Record<QuotaWindowName | 'scoped', number> {
  if (!storage?.killswitch) return DEFAULT_KILLSWITCH_THRESHOLDS
  if (accountId && storage.killswitch.accounts?.[accountId]) {
    return normalizeKillswitchThresholds(storage.killswitch.accounts[accountId])
  }
  return normalizeKillswitchThresholds(storage.killswitch.main)
}

/**
 * Returns true if the account's quota is above its killswitch threshold.
 * When killswitch is disabled, always returns true.
 *
 * When `modelId` is provided, the per-account `scoped` threshold is also
 * evaluated against the quota window matching that model — additive to the
 * 5h/7d check. A model with no matching scoped window is unaffected.
 */
export function killswitchPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  accountId?: string,
  modelId?: string,
) {
  if (!isKillswitchEnabled(storage)) return true
  const thresholds = getKillswitchThresholdsForAccount(storage, accountId)
  let sawUnknownWindow = false
  for (const key of ['five_hour', 'seven_day'] as const) {
    if (key === 'five_hour' && quotaSnapshotOmitsFiveHour(quota)) continue
    const window = quota?.[key]
    // Each configured floor needs its own reading. A present window below
    // its floor blocks even when the other window has no enabled floor.
    if (!window || !Number.isFinite(window.remainingPercent)) {
      // A user floor requires a reading that proves the account meets it.
      // Unknown-quota fail-open cannot override an enabled account floor.
      if (thresholds[key] > 0) return false
      sawUnknownWindow = true
      continue
    }
    if (window.remainingPercent < thresholds[key]) return false
  }
  // Scoped check is additive to the 5h/7d evaluation above and is an
  // INDEPENDENT block reason — it must run before the unknown-window
  // fail-closed decision, so an exhausted scoped window blocks even when
  // 5h/7d is missing/non-finite (the latter only changes the fall-through
  // for accounts that did not already block on scoped). A missing scoped
  // window (no carve-out for this model) is not "unknown quota" — only a
  // PRESENT window at/below threshold blocks. The comparison is inclusive
  // (`<=`) so the default 0 fires at exhaustion.
  if (modelId) {
    // An explicit empty scope list proves there is no model carve-out;
    // absent scope metadata cannot prove a configured model floor is met.
    if (thresholds.scoped > 0 && quota?.scoped === undefined) return false
    const scopedWindow = getScopedQuotaWindowForModel(quota, modelId)
    if (
      scopedWindow &&
      ((!Number.isFinite(scopedWindow.remainingPercent) &&
        thresholds.scoped > 0) ||
        scopedWindow.remainingPercent <= thresholds.scoped)
    ) {
      return false
    }
  }
  if (sawUnknownWindow) return !failClosedOnUnknownQuota(storage)
  return true
}

/**
 * Find the earliest reset time across all accounts' quota windows.
 * Returns seconds from `now` until that reset, or 300 as a fallback.
 *
 * When `scopedModelId` is provided, ONLY the matched scoped window's
 * `resetsAt` is considered — the 5h/7d resets are intentionally ignored
 * so the retry hint reflects the weekly reset, not the sooner 5h reset
 * (which would cause a retry-storm against a block that won't clear for
 * days). With `scopedModelId` undefined, the 5h/7d behavior is unchanged.
 */
export function killswitchRetryAfterSeconds(
  mainQuota: OAuthQuotaSnapshot | undefined,
  fallbackAccounts: Array<{ quota?: OAuthQuotaSnapshot }>,
  now: number,
  scopedModelId?: string,
): number {
  const resetTimes: number[] = []
  const allQuotas = [mainQuota, ...fallbackAccounts.map((a) => a.quota)]
  for (const quota of allQuotas) {
    if (scopedModelId) {
      const scopedWindow = getScopedQuotaWindowForModel(quota, scopedModelId)
      const resetStr = scopedWindow?.resetsAt
      if (!resetStr) continue
      const resetTime = Date.parse(resetStr)
      if (Number.isFinite(resetTime) && resetTime > now) {
        resetTimes.push(resetTime)
      }
    } else {
      for (const key of ['five_hour', 'seven_day'] as const) {
        const resetStr = quota?.[key]?.resetsAt
        if (!resetStr) continue
        const resetTime = Date.parse(resetStr)
        if (Number.isFinite(resetTime) && resetTime > now) {
          resetTimes.push(resetTime)
        }
      }
    }
  }
  if (!resetTimes.length) return 300
  return Math.max(1, Math.ceil((Math.min(...resetTimes) - now) / 1000)) + 60
}

export function getKillswitchConfig(
  storage: AccountStorage | null,
): KillswitchConfig {
  return storage?.killswitch ?? { enabled: false }
}

export function getQuotaNextRefreshAt(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  const intervalMs = getQuotaCheckIntervalMs(storage)
  if (!quotaEnabled(storage)) return now + intervalMs

  const windowFreshnessDeadline = Math.min(
    ...[
      ...(['five_hour', 'seven_day'] as const).map(
        (key) => quota?.[key]?.checkedAt,
      ),
      ...(quota?.scoped ?? []).map((window) => window.checkedAt),
    ]
      .filter((checkedAt): checkedAt is number => Number.isFinite(checkedAt))
      .map((checkedAt) => checkedAt + intervalMs),
  )
  const capAtOldestWindow = (candidate: number) =>
    Number.isFinite(windowFreshnessDeadline)
      ? Math.min(candidate, windowFreshnessDeadline)
      : candidate

  const thresholds = getQuotaMinimumRemainingThresholds(storage)
  const blockedResetTimes: number[] = []
  for (const key of ['five_hour', 'seven_day'] as const) {
    if (key === 'five_hour' && quotaSnapshotOmitsFiveHour(quota)) continue
    const window = quota?.[key]
    if (!window) return capAtOldestWindow(now + intervalMs)
    if (window.remainingPercent >= thresholds[key]) continue
    const resetTime = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    if (!Number.isFinite(resetTime) || resetTime <= now) {
      return capAtOldestWindow(now + intervalMs)
    }
    blockedResetTimes.push(resetTime)
  }

  if (!blockedResetTimes.length) return capAtOldestWindow(now + intervalMs)
  return capAtOldestWindow(Math.min(...blockedResetTimes) + 60_000)
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function slugForQuotaIdentity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function mapScopedWeeklyLimits(
  limits: OAuthUsageLimit[] | undefined,
  checkedAt: number,
): AccountScopedQuotaWindow[] {
  if (!Array.isArray(limits)) return []
  const seen = new Set<string>()
  const scoped: AccountScopedQuotaWindow[] = []
  for (const limit of limits) {
    if (limit?.kind !== 'weekly_scoped' || limit.group !== 'weekly') continue
    if (typeof limit.percent !== 'number' || !Number.isFinite(limit.percent)) {
      continue
    }
    const modelName = nonEmptyString(limit.scope?.model?.display_name)
    if (!modelName) continue
    const identity = nonEmptyString(limit.scope?.model?.id) ?? modelName
    const slug = slugForQuotaIdentity(identity)
    if (!slug) continue
    const id = `claude-weekly-scoped-${slug}`
    if (seen.has(id)) continue
    seen.add(id)

    const usedPercent = clampPercent(limit.percent)
    const modelId = nonEmptyString(limit.scope?.model?.id)
    scoped.push({
      id,
      title: `${modelName} only`,
      ...(modelId && { modelId }),
      modelName,
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: limit.resets_at ?? undefined,
      checkedAt,
    })
  }
  return scoped
}

function mapExtraUsage(
  usage: OAuthUsageResponse,
): OAuthExtraUsageSnapshot | undefined {
  if (usage.extra_usage?.is_enabled !== true) return undefined
  const usedAmount = usage.extra_usage.used_credits
  const limitAmount = usage.extra_usage.monthly_limit
  if (
    typeof usedAmount !== 'number' ||
    !Number.isFinite(usedAmount) ||
    typeof limitAmount !== 'number' ||
    !Number.isFinite(limitAmount)
  ) {
    return undefined
  }
  const rawCurrency = usage.spend?.limit?.currency
  const currency = rawCurrency == null ? 'USD' : nonEmptyString(rawCurrency)
  const rawExponent = usage.spend?.limit?.exponent
  const moneyExponent = rawExponent == null ? 2 : rawExponent
  if (
    !currency ||
    !/^[A-Za-z]{3}$/.test(currency) ||
    !Number.isInteger(moneyExponent) ||
    moneyExponent < 0 ||
    moneyExponent > 20
  ) {
    return undefined
  }
  return {
    used: { amountMinor: usedAmount, currency, exponent: moneyExponent },
    limit: { amountMinor: limitAmount, currency, exponent: moneyExponent },
    ...(typeof usage.extra_usage.utilization === 'number' &&
      Number.isFinite(usage.extra_usage.utilization) && {
        utilizationPercent: usage.extra_usage.utilization,
      }),
    ...(nonEmptyString(usage.spend?.severity) && {
      severity: nonEmptyString(usage.spend?.severity),
    }),
    exhausted: usedAmount >= limitAmount,
  }
}

function mapBindingWindow(limits: OAuthUsageLimit[] | undefined) {
  if (!Array.isArray(limits)) return undefined
  const active = limits.find((limit) => limit?.is_active === true)
  if (!active) return undefined
  if (active.kind === 'session') return 'five_hour'
  if (active.kind === 'weekly_all') return 'seven_day'
  if (active.kind !== 'weekly_scoped' || active.group !== 'weekly') {
    return undefined
  }
  const modelName = nonEmptyString(active.scope?.model?.display_name)
  if (!modelName) return undefined
  const identity = nonEmptyString(active.scope?.model?.id) ?? modelName
  const slug = slugForQuotaIdentity(identity)
  return slug ? `claude-weekly-scoped-${slug}` : undefined
}

function mapUsageWindow(
  window: OAuthUsageWindow | undefined,
  checkedAt: number,
): AccountQuotaWindow | undefined {
  if (typeof window?.utilization !== 'number') return undefined
  if (!Number.isFinite(window.utilization)) return undefined
  const usedPercent = clampPercent(window.utilization)
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: window.resets_at ?? undefined,
    checkedAt,
  }
}

export async function fetchOAuthQuotaSnapshot(input: {
  accessToken: string
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<OAuthQuotaSnapshot> {
  assertNotCustodyTombstone(input.accessToken, 'anthropic')
  const fetchImpl = input.fetchImpl ?? fetch
  const signal = auxiliaryRequestSignal()
  const response = await raceWithSignal(signal, () =>
    fetchImpl(QUOTA_URL, {
      method: 'GET',
      signal,
      // The bearer is an OAuth token; never let a redirect carry it elsewhere.
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${CLAUDE_CODE_VERSION}`,
      },
    }),
  )

  if (!response.ok) {
    const body = await raceWithSignal(signal, () => response.text()).catch(
      () => '',
    )
    const error = Object.assign(
      new Error(`Claude quota check failed: ${response.status} — ${body}`),
      {
        status: response.status,
        retryAfter: parseRetryAfterHeader(response.headers.get('Retry-After')),
      },
    )
    throw error
  }

  const checkedAt = input.now?.() ?? Date.now()
  const usage = (await raceWithSignal(signal, () =>
    response.json(),
  )) as OAuthUsageResponse
  const bindingWindow = mapBindingWindow(usage.limits)
  const snapshot = {
    five_hour: mapUsageWindow(usage.five_hour, checkedAt),
    seven_day: mapUsageWindow(usage.seven_day, checkedAt),
    scoped: mapScopedWeeklyLimits(usage.limits, checkedAt),
    extraUsage: mapExtraUsage(usage),
    ...(bindingWindow && {
      bindingWindow,
      bindingWindowSource: 'poll' as const,
    }),
    source: 'poll',
    checkedAt,
  } satisfies OAuthQuotaSnapshot
  const fieldSources: QuotaFieldSources = {
    ...(snapshot.five_hour && { five_hour: 'poll' }),
    ...(snapshot.seven_day && { seven_day: 'poll' }),
    ...(snapshot.scoped && { scoped: 'poll' }),
    ...(snapshot.extraUsage && { extraUsage: 'poll' }),
    ...(snapshot.bindingWindow && { bindingWindow: 'poll' }),
  }
  return {
    ...snapshot,
    ...(Object.keys(fieldSources).length > 0 && { fieldSources }),
  }
}

export function fallbackAccountUuidForLineage(
  account: OAuthAccount | undefined,
  authLineageId?: string,
): string | null {
  if (!account || account.authLineageId !== authLineageId) return null
  return account.anthropicAccountUuid ?? null
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isTransientQuotaError(error: unknown) {
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 429 || status >= 500) return true
  }
  const formattedMessage = formatErrorMessage(error)
  if (/Claude quota check failed: (429|5\d\d)\b/.test(formattedMessage))
    return true
  if (formattedMessage.includes('Quota refresh is already in progress'))
    return true
  return isTransientNetworkError(error)
}
