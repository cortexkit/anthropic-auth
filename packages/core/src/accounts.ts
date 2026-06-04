import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { ClaudeOAuthRefreshError, refreshClaudeOAuthToken } from './auth.ts'
import {
  CACHE_1H_MODES,
  type Cache1hMode,
  CLAUDE_CODE_VERSION,
  DEFAULT_CACHE_1H_MODE,
} from './constants.ts'
import { log } from './logger.ts'

const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

export const ACCOUNT_FILE_NAME = 'anthropic-auth.json'
export const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

export type QuotaWindowName = 'five_hour' | 'seven_day'

export type OAuthAccount = {
  id: string
  label?: string
  type: 'oauth'
  access?: string
  refresh: string
  expires?: number
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: Partial<Record<QuotaWindowName, AccountQuotaWindow>>
}

export type AccountOperationError = {
  message: string
  checkedAt: number
  nextRetryAt?: number
  retryCount?: number
  tokenHash?: string
}

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
}

export type RoutingMode = 'main-first' | 'fallback-first'

export type AccountStorage = {
  version: 1
  main?: {
    type: 'opencode'
    provider: 'anthropic'
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
    mainQuota?: OAuthQuotaSnapshot
    mainQuotaCheckedAt?: number
    // Fingerprint of the access token that produced mainQuota. Used to avoid
    // seeding a different account's persisted quota after a main-account switch.
    mainQuotaToken?: string
    mainLastQuotaApiError?: AccountOperationError
  }
  claudeCache?: {
    enabled?: boolean
    mode?: Cache1hMode
  }
  dump?: {
    enabled?: boolean
  }
  claudeFast?: {
    enabled?: boolean
  }
  cacheKeep?: {
    enabled?: boolean
    startHour?: number
    endHour?: number
  }
  relay?: {
    enabled?: boolean
    url?: string
    token?: string
    fallbackToDirect?: boolean
    transport?: 'http' | 'websocket'
  }
  accounts: OAuthAccount[]
}

type OAuthUsageWindow = {
  utilization?: number
  resets_at?: string
}

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
}

export type OAuthQuotaSnapshot = Partial<
  Record<QuotaWindowName, AccountQuotaWindow>
>

export type AccountManagerOptions = {
  now?: () => number
  fetchImpl?: typeof fetch
  configPath?: string
  quotaManager?: import('./quota-manager.ts').QuotaManager
  // Invoked after a background quota pass persists at least one fallback storage
  // change (token refresh, quota update, or error recording), so consumers
  // (e.g. the OpenCode sidebar) can re-render without a request flowing through
  // the fetch handler.
  onFallbackStorageChanged?: () => void
}

export type AccountRefreshError = {
  accountId: string
  message: string
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
const BACKGROUND_TICK_MS = 60_000
const BACKGROUND_TICK_JITTER_MS = 60_000
const FALLBACK_REFRESH_LOCK_TTL_MS = 10 * 60_000
const FALLBACK_REFRESH_JOIN_WAIT_MS = 10_000
const FALLBACK_REFRESH_JOIN_POLL_MS = 100

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  )
}

export function getAccountStoragePath() {
  return (
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim() ||
    join(getConfigDir(), ACCOUNT_FILE_NAME)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAccount(value: unknown): OAuthAccount | null {
  if (!isRecord(value)) return null
  if (value.type !== 'oauth') return null
  if (typeof value.refresh !== 'string' || !value.refresh.trim()) return null

  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : randomUUID(),
    label: typeof value.label === 'string' ? value.label : undefined,
    type: 'oauth',
    access: typeof value.access === 'string' ? value.access : undefined,
    refresh: value.refresh,
    expires: typeof value.expires === 'number' ? value.expires : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : undefined,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : undefined,
    lastRefreshedAt:
      typeof value.lastRefreshedAt === 'number'
        ? value.lastRefreshedAt
        : undefined,
    lastRefreshError: normalizeOperationError(value.lastRefreshError),
    lastQuotaRefreshError: normalizeOperationError(value.lastQuotaRefreshError),
    quota: normalizeQuota(value.quota),
  }
}

function normalizeOperationError(
  value: unknown,
): AccountOperationError | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.message !== 'string') return undefined
  const checkedAt = Number(value.checkedAt)
  if (!Number.isFinite(checkedAt)) return undefined
  const nextRetryAt = Number(value.nextRetryAt)
  const retryCount = Number(value.retryCount)
  return {
    message: value.message,
    checkedAt,
    nextRetryAt: Number.isFinite(nextRetryAt) ? nextRetryAt : undefined,
    retryCount: Number.isFinite(retryCount) ? retryCount : undefined,
    tokenHash:
      typeof value.tokenHash === 'string' ? value.tokenHash : undefined,
  }
}

function normalizeQuota(value: unknown): OAuthAccount['quota'] {
  if (!isRecord(value)) return undefined
  const quota: OAuthAccount['quota'] = {}
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = value[key]
    if (!isRecord(window)) continue
    const usedPercent = Number(window.usedPercent)
    const remainingPercent = Number(window.remainingPercent)
    const checkedAt = Number(window.checkedAt)
    if (
      !Number.isFinite(usedPercent) ||
      !Number.isFinite(remainingPercent) ||
      !Number.isFinite(checkedAt)
    ) {
      continue
    }
    quota[key] = {
      usedPercent,
      remainingPercent,
      checkedAt,
      resetsAt:
        typeof window.resetsAt === 'string' ? window.resetsAt : undefined,
    }
  }
  return Object.keys(quota).length ? quota : undefined
}

function normalizeStorage(value: unknown): AccountStorage | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    routing: isRecord(value.routing) ? value.routing : undefined,
    fallbackOn: Array.isArray(value.fallbackOn)
      ? value.fallbackOn.filter((status) => Number.isInteger(status))
      : undefined,
    refresh: isRecord(value.refresh) ? value.refresh : undefined,
    quota: isRecord(value.quota) ? value.quota : undefined,
    claudeCache: isRecord(value.claudeCache) ? value.claudeCache : undefined,
    dump: isRecord(value.dump) ? value.dump : undefined,
    claudeFast: isRecord(value.claudeFast) ? value.claudeFast : undefined,
    cacheKeep: isRecord(value.cacheKeep) ? value.cacheKeep : undefined,
    relay: isRecord(value.relay) ? value.relay : undefined,
    accounts: value.accounts
      .map(normalizeAccount)
      .filter((account): account is OAuthAccount => account != null),
  }
}

export async function loadAccounts(path = getAccountStoragePath()) {
  try {
    const raw = await readFile(path, 'utf8')
    return normalizeStorage(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

async function loadExistingTopLevelFields(path: string) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function omitUndefinedTopLevel(value: AccountStorage) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

export async function saveAccounts(
  storage: AccountStorage,
  path = getAccountStoragePath(),
) {
  await mkdir(dirname(path), { recursive: true })
  const existing = await loadExistingTopLevelFields(path)
  const next = { ...existing, ...omitUndefinedTopLevel(storage) }
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(tempPath, path)
}

export async function acquireRefreshFileLock(options: {
  name: string
  ttlMs: number
  path?: string
  now?: () => number
  renew?: boolean
  renewIntervalMs?: number
}): Promise<{ release: () => Promise<void> } | null> {
  const accountPath = options.path ?? getAccountStoragePath()
  const lockPath = `${accountPath}.${options.name}.lock`
  const legacyOwnerPath = join(lockPath, 'owner.json')
  const ownerId = randomUUID()
  const now = options.now ?? Date.now
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

  if (!(await tryAcquire())) {
    try {
      const owner = await readOwner()
      if (Number(owner?.expiresAt) > now()) return null
    } catch {
      try {
        const current = await stat(lockPath)
        if (current.mtimeMs + options.ttlMs > Date.now()) return null
      } catch {
        return null
      }
    }
    await rm(lockPath, { recursive: true, force: true }).catch(() => {})
    if (!(await tryAcquire())) return null
  }

  scheduleRenewal()

  return {
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

export async function setCache1hPersistentEnabled(
  enabled: boolean,
  mode?: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled,
    mode: mode ?? getCache1hPersistentMode(storage),
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCache1hPersistentMode(
  mode: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled: storage.claudeCache?.enabled === true,
    mode,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isDumpPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.dump?.enabled === true
}

export async function setDumpPersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.dump = {
    ...(storage.dump ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isFastModePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeFast?.enabled === true
}

export async function setFastModePersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.claudeFast = {
    ...(storage.claudeFast ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentWindow(
  startHour: number,
  endHour: number,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.cacheKeep = {
    enabled: true,
    startHour,
    endHour,
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCacheKeepPersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
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

function normalizeThresholds(storage: AccountStorage | null) {
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

function refreshEnabled(storage: AccountStorage | null) {
  return storage?.refresh?.enabled !== false
}

function jitterMs(maxMs: number) {
  return Math.floor(Math.random() * Math.max(0, maxMs))
}

function refreshBeforeExpiryMs(storage: AccountStorage | null) {
  const minutes =
    storage?.refresh?.refreshBeforeExpiryMinutes ??
    DEFAULT_REFRESH_BEFORE_EXPIRY_MINUTES
  return Math.max(MIN_REFRESH_BEFORE_EXPIRY_MINUTES, minutes) * 60_000
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
  if (error instanceof ClaudeOAuthRefreshError) {
    return error.status === 429 || error.status >= 500
  }
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('fetch failed') ||
    ('code' in error &&
      (error.code === 'ECONNRESET' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'UND_ERR_CONNECT_TIMEOUT'))
  )
}

export function buildRefreshOperationError(input: {
  error: unknown
  now: number
  refreshToken: string
  previous?: AccountOperationError
}): AccountOperationError {
  const tokenHash = hashRefreshToken(input.refreshToken)
  const previousRetryCount =
    input.previous?.tokenHash === tokenHash
      ? (input.previous.retryCount ?? 0)
      : 0
  const retryCount = previousRetryCount + 1
  let delay: number
  if (
    input.error instanceof ClaudeOAuthRefreshError &&
    input.error.retryAfter
  ) {
    delay = input.error.retryAfter * 1000
  } else if (isTransientRefreshError(input.error)) {
    delay = Math.min(
      MAX_REFRESH_RETRY_DELAY_MS,
      MIN_REFRESH_RETRY_DELAY_MS * 2 ** Math.min(retryCount - 1, 6),
    )
  } else {
    delay = NON_TRANSIENT_REFRESH_RETRY_DELAY_MS
  }
  return {
    message: formatErrorMessage(input.error),
    checkedAt: input.now,
    nextRetryAt: input.now + delay,
    retryCount,
    tokenHash,
  }
}

export function refreshBackoffActive(
  error: AccountOperationError | undefined,
  refreshToken: string | undefined,
  now: number,
) {
  if (!error?.nextRetryAt || error.nextRetryAt <= now) return false
  if (!refreshToken) return true
  return error.tokenHash === hashRefreshToken(refreshToken)
}

export function formatRefreshBackoffMessage(
  error: AccountOperationError,
  now: number,
) {
  const seconds = Math.max(
    1,
    Math.ceil(((error.nextRetryAt ?? now) - now) / 1000),
  )
  return `Claude OAuth refresh is backed off for ${seconds}s after: ${error.message}`
}

export function buildQuotaOperationError(input: {
  error: unknown
  now: number
  previous?: AccountOperationError
}): AccountOperationError {
  const previousRetryCount = input.previous?.retryCount ?? 0
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

export function getPersistedMainQuota(storage: AccountStorage | null): {
  quota: OAuthQuotaSnapshot
  checkedAt: number
  tokenFingerprint?: string
} | null {
  if (!storage?.quota?.mainQuota || !storage.quota.mainQuotaCheckedAt)
    return null
  return {
    quota: storage.quota.mainQuota,
    checkedAt: storage.quota.mainQuotaCheckedAt,
    tokenFingerprint: storage.quota.mainQuotaToken,
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

export function quotaSnapshotPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
) {
  if (!quotaEnabled(storage)) return true
  const thresholds = normalizeThresholds(storage)
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    if (!window) return !failClosedOnUnknownQuota(storage)
    if (window.remainingPercent < thresholds[key]) return false
  }
  return true
}

export function getQuotaNextRefreshAt(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quotaEnabled(storage)) return now + getQuotaCheckIntervalMs(storage)

  const thresholds = normalizeThresholds(storage)
  const blockedResetTimes: number[] = []
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    if (!window) return now + getQuotaCheckIntervalMs(storage)
    if (window.remainingPercent >= thresholds[key]) continue
    const resetTime = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    if (!Number.isFinite(resetTime) || resetTime <= now) {
      return now + getQuotaCheckIntervalMs(storage)
    }
    blockedResetTimes.push(resetTime)
  }

  if (!blockedResetTimes.length) return now + getQuotaCheckIntervalMs(storage)
  return Math.min(...blockedResetTimes) + 60_000
}

function tokenNeedsRefresh(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  return (
    !account.access ||
    !account.expires ||
    account.expires - now <= refreshBeforeExpiryMs(storage)
  )
}

function quotaIsStale(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quotaEnabled(storage)) return false
  const maxAge = getQuotaCheckIntervalMs(storage)
  return (['five_hour', 'seven_day'] as const).some((key) => {
    const window = account.quota?.[key]
    return !window || now - window.checkedAt >= maxAge
  })
}

function cachedQuotaWindowStillRelevant(
  window: AccountQuotaWindow | undefined,
  now: number,
) {
  if (!window) return false
  if (!window.resetsAt) return true
  const resetTime = Date.parse(window.resetsAt)
  return !Number.isFinite(resetTime) || resetTime > now
}

function cachedQuotaSnapshotStillRelevant(
  quota: OAuthQuotaSnapshot | undefined,
  now: number,
) {
  return (['five_hour', 'seven_day'] as const).every((key) =>
    cachedQuotaWindowStillRelevant(quota?.[key], now),
  )
}

function isTransientQuotaError(error: unknown) {
  const message = formatErrorMessage(error)
  if (/Claude quota check failed: (429|5\d\d)\b/.test(message)) return true
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return (
    message.includes('fetch failed') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

function canUseCachedQuotaAfterRefreshError(
  account: OAuthAccount,
  storage: AccountStorage | null,
  error: unknown,
  now: number,
) {
  return (
    isTransientQuotaError(error) &&
    quotaSnapshotPassesPolicy(account.quota, storage) &&
    cachedQuotaSnapshotStillRelevant(account.quota, now)
  )
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

function mapUsageWindow(
  window: OAuthUsageWindow | undefined,
  checkedAt: number,
): AccountQuotaWindow | undefined {
  if (typeof window?.utilization !== 'number') return undefined
  const usedPercent = clampPercent(window.utilization)
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: window.resets_at,
    checkedAt,
  }
}

export async function fetchOAuthQuotaSnapshot(input: {
  accessToken: string
  fetchImpl?: typeof fetch
  now?: () => number
}) {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(QUOTA_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-code/${CLAUDE_CODE_VERSION}`,
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Claude quota check failed: ${response.status} — ${body}`)
  }

  const checkedAt = input.now?.() ?? Date.now()
  const usage = (await response.json()) as OAuthUsageResponse
  return {
    five_hour: mapUsageWindow(usage.five_hour, checkedAt),
    seven_day: mapUsageWindow(usage.seven_day, checkedAt),
  } satisfies OAuthQuotaSnapshot
}

function updateStoredAccount(storage: AccountStorage, account: OAuthAccount) {
  const index = storage.accounts.findIndex(
    (candidate) => candidate.id === account.id,
  )
  if (index >= 0) storage.accounts[index] = account
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function recordRefreshError(
  account: OAuthAccount,
  error: unknown,
  now: number,
) {
  account.lastRefreshError = buildRefreshOperationError({
    error,
    now,
    refreshToken: account.refresh,
    previous: account.lastRefreshError,
  })
}

function recordQuotaRefreshError(
  account: OAuthAccount,
  error: unknown,
  now: number,
) {
  account.lastQuotaRefreshError = buildQuotaOperationError({
    error,
    now,
    previous: account.lastQuotaRefreshError,
  })
  if (error instanceof ClaudeOAuthRefreshError) {
    recordRefreshError(account, error, now)
  }
}

function fallbackRefreshLockName(accountId: string) {
  return `fallback-oauth-refresh-${createHash('sha256')
    .update(accountId)
    .digest('hex')
    .slice(0, 16)}`
}

export class FallbackAccountManager {
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly configPath: string
  private readonly refreshPromises = new Map<string, Promise<OAuthAccount>>()
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private quotaTimer: ReturnType<typeof setInterval> | null = null
  readonly quotaManager: import('./quota-manager.ts').QuotaManager | null
  private readonly onFallbackStorageChanged: (() => void) | undefined

  constructor(options: AccountManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? fetch
    this.configPath = options.configPath ?? getAccountStoragePath()
    this.quotaManager = options.quotaManager ?? null
    this.onFallbackStorageChanged = options.onFallbackStorageChanged
  }

  /**
   * Seed QuotaManager from persisted account.quota if no cache entry exists
   * yet. Prevents unnecessary API calls when the on-disk snapshot is fresh.
   */
  private seedFallbackQuota(
    account: OAuthAccount,
    storage: AccountStorage,
  ): void {
    if (!this.quotaManager) return
    if (this.quotaManager.getFallback(account.id, account.access)) return
    if (!account.quota) return
    const checkedAt = Math.max(
      account.quota.five_hour?.checkedAt ?? 0,
      account.quota.seven_day?.checkedAt ?? 0,
    )
    if (checkedAt <= 0) return
    const checkInterval = getQuotaCheckIntervalMs(storage)
    this.quotaManager.setFallback(
      account.id,
      {
        quota: account.quota,
        refreshAfter: checkedAt + checkInterval,
        checkedAt,
      },
      account.access,
    )
  }

  async load() {
    return loadAccounts(this.configPath)
  }

  async save(storage: AccountStorage) {
    await saveAccounts(storage, this.configPath)
  }

  startBackgroundRefresh() {
    const run = async () => {
      await this.refreshDueAccounts()
      await this.refreshQuotaForDueAccounts()
    }
    void run().catch(() => {})
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void run().catch(() => {})
      }, BACKGROUND_TICK_MS + jitterMs(BACKGROUND_TICK_JITTER_MS))
      if ('unref' in this.refreshTimer) this.refreshTimer.unref()
    }
  }

  stopBackgroundRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.quotaTimer) clearInterval(this.quotaTimer)
    this.refreshTimer = null
    this.quotaTimer = null
  }

  async getUsableFallbackAccounts(existingStorage?: AccountStorage | null) {
    const storage =
      existingStorage !== undefined ? existingStorage : await this.load()
    if (!storage) return []
    const usable: OAuthAccount[] = []
    let changed = false

    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      try {
        let next = account
        if (tokenNeedsRefresh(next, storage, this.now())) {
          const refreshError = next.lastRefreshError
          if (
            refreshError &&
            refreshBackoffActive(refreshError, next.refresh, this.now())
          ) {
            throw new Error(
              formatRefreshBackoffMessage(refreshError, this.now()),
            )
          }
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        this.seedFallbackQuota(next, storage)
        const stale = this.quotaManager
          ? this.quotaManager.isFallbackStale(next.id, next.access)
          : quotaIsStale(next, storage, this.now())
        // Skip the request-time refresh when this account's quota API is
        // backed off (recent 429/5xx). Hitting it again would extend the
        // backoff; evaluate policy on the cached/seeded quota instead. Mirrors
        // the background refreshQuotaForDueAccounts() guard.
        if (
          stale &&
          !quotaBackoffActive(next.lastQuotaRefreshError, this.now())
        ) {
          next = await this.refreshAccountQuota(next, storage)
          changed = true
        }
        // Single source of truth: evaluate quota policy from the unified
        // QuotaManager cache (the same source as the staleness check above) so
        // an active-route refresh that updated only the cache is not ignored.
        if (
          this.accountPassesQuotaPolicy(this.quotaPolicyAccount(next), storage)
        )
          usable.push(next)
      } catch (error) {
        if (
          canUseCachedQuotaAfterRefreshError(
            account,
            storage,
            error,
            this.now(),
          )
        ) {
          log(
            '[refresh] fallback quota using cached quota after refresh error',
            {
              accountId: account.id,
              error: formatErrorMessage(error),
            },
          )
          usable.push(account)
        } else if (!failClosedOnUnknownQuota(storage)) {
          usable.push(account)
        }
      }
    }

    if (changed) await this.save(storage)
    return usable
  }

  async markUsed(account: OAuthAccount) {
    const storage = await this.load()
    if (!storage) return
    const stored = storage.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (!stored) return
    stored.lastUsed = this.now()
    await this.save(storage)
  }

  accountPassesQuotaPolicy(
    account: OAuthAccount,
    storage: AccountStorage | null,
  ) {
    return quotaSnapshotPassesPolicy(account.quota, storage)
  }

  /**
   * Return the account with its quota overlaid from the unified QuotaManager
   * cache (token-bound) when available, so quota-policy decisions use the same
   * source of truth as the staleness check. Falls back to the stored
   * account.quota when no manager is wired or the cache has no entry.
   */
  private quotaPolicyAccount(account: OAuthAccount): OAuthAccount {
    if (!this.quotaManager) return account
    const cached = this.quotaManager.getFallback(
      account.id,
      account.access,
    )?.quota
    return cached ? { ...account, quota: cached } : account
  }

  async refreshDueAccounts() {
    const storage = await this.load()
    if (!storage || !refreshEnabled(storage)) return
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      if (!tokenNeedsRefresh(account, storage, this.now())) continue
      if (
        refreshBackoffActive(
          account.lastRefreshError,
          account.refresh,
          this.now(),
        )
      ) {
        // Backoff skips are steady-state while a fallback account is waiting for
        // its next retry. Logging every background tick from every OpenCode
        // process creates noise without adding new diagnostic signal; the
        // failure/backoff itself is recorded when the refresh attempt fails and
        // shown by /claude-quota.
        continue
      }
      try {
        log('[refresh] fallback oauth background due', {
          accountId: account.id,
          expiresInMs: account.expires
            ? account.expires - this.now()
            : undefined,
        })
        await this.refreshAccount(account, storage)
        changed = true
      } catch (error) {
        log('[refresh] fallback oauth background failed', {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        })
        recordRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        // Background refresh must not break the plugin request path.
      }
    }
    if (changed) await this.save(storage)
  }

  async refreshQuotaForDueAccounts() {
    const storage = await this.load()
    if (!storage || !quotaEnabled(storage)) return
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      let next = account
      try {
        if (tokenNeedsRefresh(next, storage, this.now())) {
          if (
            refreshBackoffActive(
              next.lastRefreshError,
              next.refresh,
              this.now(),
            )
          ) {
            continue
          }
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        if (quotaBackoffActive(next.lastQuotaRefreshError, this.now())) {
          continue
        }
        this.seedFallbackQuota(next, storage)
        // Use QuotaManager staleness when available (shared cache);
        // fall back to per-account on-disk staleness otherwise.
        const stale = this.quotaManager
          ? this.quotaManager.isFallbackStale(next.id, next.access)
          : quotaIsStale(next, storage, this.now())
        if (!stale) continue
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        // Quota probes are advisory; failed probes fail closed at selection time.
      }
    }
    if (changed) {
      await this.save(storage)
      this.onFallbackStorageChanged?.()
    }
  }

  async refreshQuotaForAllAccounts(options: { force?: boolean } = {}) {
    const storage = await this.load()
    const errors: AccountRefreshError[] = []
    if (!storage || !quotaEnabled(storage)) return { storage, errors }
    const force = options.force ?? false
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      let next = account
      try {
        if (tokenNeedsRefresh(next, storage, this.now())) {
          const refreshError = next.lastRefreshError
          if (
            refreshError &&
            refreshBackoffActive(refreshError, next.refresh, this.now())
          ) {
            throw new Error(
              formatRefreshBackoffMessage(refreshError, this.now()),
            )
          }
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        // force (manual /claude-quota) bypasses the staleness skip to fetch
        // fresh numbers on demand. refreshAccountQuota still respects 429
        // backoff via QuotaManager.refreshFallback.
        if (!force && !quotaIsStale(next, storage, this.now())) {
          if (next.lastQuotaRefreshError) {
            next.lastQuotaRefreshError = undefined
            updateStoredAccount(storage, next)
            changed = true
          }
          continue
        }
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        errors.push({
          accountId: account.id,
          message: formatErrorMessage(error),
        })
      }
    }
    if (changed) await this.save(storage)
    return { storage, errors }
  }

  async refreshAccount(
    account: OAuthAccount,
    storage: AccountStorage,
    options: { force?: boolean } = {},
  ) {
    const existing = this.refreshPromises.get(account.id)
    if (existing) {
      const refreshed = await existing
      updateStoredAccount(storage, refreshed)
      return refreshed
    }

    const promise = this.refreshAccountNow(account, storage, options).finally(
      () => {
        this.refreshPromises.delete(account.id)
      },
    )
    this.refreshPromises.set(account.id, promise)
    const refreshed = await promise
    updateStoredAccount(storage, refreshed)
    return refreshed
  }

  private async waitForConcurrentFallbackRefresh(
    account: OAuthAccount,
    storage: AccountStorage,
    previous: OAuthAccount,
    options: { force?: boolean },
  ) {
    const deadline = Date.now() + FALLBACK_REFRESH_JOIN_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, FALLBACK_REFRESH_JOIN_POLL_MS),
      )
      const latestStorage = await this.load()
      const latestAccount = latestStorage?.accounts.find(
        (candidate) => candidate.id === account.id,
      )
      if (!latestAccount) continue

      const changed =
        latestAccount.access !== previous.access ||
        latestAccount.refresh !== previous.refresh ||
        (latestAccount.expires ?? 0) > (previous.expires ?? 0) + 60_000
      if (
        changed &&
        (options.force ||
          !tokenNeedsRefresh(latestAccount, latestStorage, this.now()))
      ) {
        updateStoredAccount(storage, latestAccount)
        log('[refresh] fallback oauth joined concurrent refresh', {
          accountId: latestAccount.id,
          expiresInMs: latestAccount.expires
            ? latestAccount.expires - this.now()
            : undefined,
        })
        return latestAccount
      }

      const refreshError = latestAccount.lastRefreshError
      if (
        refreshError &&
        refreshBackoffActive(refreshError, latestAccount.refresh, this.now())
      ) {
        updateStoredAccount(storage, latestAccount)
        throw new Error(formatRefreshBackoffMessage(refreshError, this.now()))
      }
    }
    return null
  }

  private async refreshAccountNow(
    account: OAuthAccount,
    storage: AccountStorage,
    options: { force?: boolean },
  ) {
    let latestStorage = await this.load()
    let latestAccount = latestStorage?.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (
      latestAccount &&
      !options.force &&
      !tokenNeedsRefresh(latestAccount, latestStorage, this.now())
    ) {
      updateStoredAccount(storage, latestAccount)
      return latestAccount
    }

    let sourceAccount = latestAccount ?? account
    const fileLock = await acquireRefreshFileLock({
      name: fallbackRefreshLockName(sourceAccount.id),
      ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
      path: this.configPath,
      now: this.now,
      renew: true,
    })
    if (!fileLock) {
      log('[refresh] fallback oauth refresh skipped file lock', {
        accountId: sourceAccount.id,
      })
      const concurrent = await this.waitForConcurrentFallbackRefresh(
        account,
        storage,
        sourceAccount,
        options,
      )
      if (concurrent) return concurrent
      throw new Error('Fallback OAuth refresh is already in progress')
    }

    try {
      latestStorage = await this.load()
      latestAccount = latestStorage?.accounts.find(
        (candidate) => candidate.id === account.id,
      )
      if (
        latestAccount &&
        !options.force &&
        !tokenNeedsRefresh(latestAccount, latestStorage, this.now())
      ) {
        updateStoredAccount(storage, latestAccount)
        return latestAccount
      }

      sourceAccount = latestAccount ?? sourceAccount
      const refreshToken = sourceAccount.refresh
      log('[refresh] fallback oauth refresh request start', {
        accountId: sourceAccount.id,
        force: options.force === true,
        expiresInMs: sourceAccount.expires
          ? sourceAccount.expires - this.now()
          : undefined,
      })
      const refreshed = await refreshClaudeOAuthToken({
        refreshToken,
        fetchImpl: this.fetchImpl,
        now: this.now,
      })
      sourceAccount.access = refreshed.access
      sourceAccount.refresh = refreshed.refresh
      sourceAccount.expires = refreshed.expires
      sourceAccount.lastRefreshedAt =
        refreshed.expires - refreshed.expiresIn * 1000
      sourceAccount.lastRefreshError = undefined
      updateStoredAccount(storage, sourceAccount)
      await this.save(storage)
      log('[refresh] fallback oauth refresh succeeded', {
        accountId: sourceAccount.id,
        expiresInMs: sourceAccount.expires
          ? sourceAccount.expires - this.now()
          : undefined,
      })
      return sourceAccount
    } finally {
      await fileLock.release()
    }
  }

  async refreshAccountQuota(account: OAuthAccount, storage: AccountStorage) {
    let target = account
    if (!target.access) {
      throw new Error(`Fallback account ${account.id} has no access token`)
    }
    // Unify on the shared QuotaManager when present: it adds inflight
    // deduplication and 429 backoff gating around the same quota API. Fall back
    // to a direct fetch only when no QuotaManager is wired (e.g. in isolation).
    const fetchSnapshot = (accessToken: string) =>
      this.quotaManager
        ? this.quotaManager.refreshFallback(target.id, accessToken)
        : fetchOAuthQuotaSnapshot({
            accessToken,
            fetchImpl: this.fetchImpl,
            now: this.now,
          })
    try {
      target.quota = await fetchSnapshot(target.access)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('Claude quota check failed: 401')) throw error
      target = await this.refreshAccount(account, storage, {
        force: true,
      })
      if (!target.access) throw error
      // 401 does not arm QuotaManager backoff, so this retry proceeds.
      target.quota = await fetchSnapshot(target.access)
    }
    target.lastQuotaRefreshError = undefined
    updateStoredAccount(storage, target)
    // Sync to shared QuotaManager so all consumers see the same cache. The
    // refreshFallback path already cached the snapshot; re-set here so
    // refreshAfter reflects this storage's check interval consistently.
    if (this.quotaManager && target.quota) {
      const now = this.now()
      this.quotaManager.setFallback(
        target.id,
        {
          quota: target.quota,
          refreshAfter: now + getQuotaCheckIntervalMs(storage),
          checkedAt: now,
        },
        target.access,
      )
    }
    return target
  }
}
