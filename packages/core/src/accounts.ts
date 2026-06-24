import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { parseRetryAfterHeader, refreshClaudeOAuthToken } from './auth.ts'
import {
  CACHE_1H_MODES,
  type Cache1hMode,
  CLAUDE_CODE_VERSION,
  DEFAULT_CACHE_1H_MODE,
} from './constants.ts'
import { type LogLevel, log, logger } from './logger.ts'

const setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
const clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

export const ACCOUNT_FILE_NAME = 'anthropic-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'anthropic-auth-state.json'
export const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

export type QuotaWindowName = 'five_hour' | 'seven_day'

export type AccountBase = {
  id: string
  label?: string
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
}

export type OAuthAccount = AccountBase & {
  type: 'oauth'
  access?: string
  refresh: string
  expires?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: Partial<Record<QuotaWindowName, AccountQuotaWindow>>
}

export type ApiKeyAccount = AccountBase & {
  type: 'api'
  apiKey?: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type FallbackAccount = OAuthAccount | ApiKeyAccount

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
  tokenHash?: string
}

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
}

export type RoutingMode = 'main-first' | 'fallback-first'

export type KillswitchThresholds = Partial<
  Record<QuotaWindowName | '5h' | '1w', number>
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
    /** Opt-in OpenCode TUI toast after quota refresh. Default: false. */
    showToasts?: boolean
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
  logging?: {
    level?: LogLevel
  }
  claudeFast?: {
    enabled?: boolean
  }
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
    startHour?: number
    endHour?: number
    subagents?: boolean
  }
  relay?: {
    enabled?: boolean
    url?: string
    token?: string
    fallbackToDirect?: boolean
    transport?: 'http' | 'websocket'
  }
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
    | 'refresh'
    | 'expires'
    | 'lastUsed'
    | 'lastRefreshedAt'
    | 'lastRefreshError'
    | 'lastQuotaRefreshError'
    | 'quota'
  > &
    Pick<ApiKeyAccount, 'apiKey' | 'lastUsed'>
>

export type AccountRuntimeState = {
  version: 1
  main?: {
    quota?: OAuthQuotaSnapshot
    quotaCheckedAt?: number
    quotaToken?: string
    lastQuotaApiError?: AccountOperationError
    lastRefreshError?: AccountOperationError
    refreshLeaseId?: string
    refreshLeaseUntil?: number
    refreshLeaseTokenHash?: string
  }
  accounts?: Record<string, AccountRuntimeEntry>
}

export type AccountStateSaveScope = {
  mainQuota?: boolean
  mainRefresh?: boolean
  accounts?: true | string[]
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

export function getAccountStatePath(configPath = getAccountStoragePath()) {
  const explicit = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE?.trim()
  if (explicit) return explicit
  return configPath.endsWith(ACCOUNT_FILE_NAME)
    ? join(dirname(configPath), ACCOUNT_STATE_FILE_NAME)
    : `${configPath}.state.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAccountBase(value: Record<string, unknown>): AccountBase {
  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : randomUUID(),
    label: typeof value.label === 'string' ? value.label : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : undefined,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : undefined,
  }
}

function normalizeAccount(value: unknown): FallbackAccount | null {
  if (!isRecord(value)) return null
  if (value.type === 'api') {
    const baseURL =
      typeof value.baseURL === 'string' ? value.baseURL.trim() : ''
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
    if (!isValidApiBaseURL(baseURL)) return null
    const authHeader =
      value.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer'
    return {
      ...normalizeAccountBase(value),
      type: 'api',
      apiKey: apiKey || undefined,
      baseURL,
      authHeader,
    }
  }

  if (value.type !== 'oauth') return null
  if (typeof value.refresh !== 'string' || !value.refresh.trim()) return null

  return {
    ...normalizeAccountBase(value),
    type: 'oauth',
    access: typeof value.access === 'string' ? value.access : undefined,
    refresh: value.refresh,
    expires: typeof value.expires === 'number' ? value.expires : undefined,
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

// Fresh empty storage shell — main OpenCode OAuth account, no fallback
// accounts. Returns a new object each call so mutating callers don't alias.
export function createEmptyStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
  }
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
    costZeroing: isRecord(value.costZeroing) ? value.costZeroing : undefined,
    cacheKeep: isRecord(value.cacheKeep) ? value.cacheKeep : undefined,
    relay: isRecord(value.relay) ? value.relay : undefined,
    logging: isRecord(value.logging) ? value.logging : undefined,
    killswitch: isRecord(value.killswitch) ? value.killswitch : undefined,
    accounts: value.accounts
      .map(normalizeAccount)
      .filter((account): account is FallbackAccount => account != null),
  }
}

async function readJsonIfPresent(path: string): Promise<{
  exists: boolean
  value: unknown
}> {
  try {
    return { exists: true, value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, value: null }
    }
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(
      `account store at ${path} is corrupt or unreadable (${cause}) — fix or remove it`,
    )
  }
}

function objectWithDefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function mergeConfigAndState(
  configValue: unknown,
  stateValue: unknown,
): unknown {
  if (!isRecord(configValue)) return configValue
  const state = isRecord(stateValue) ? stateValue : {}
  const mainState = isRecord(state.main) ? state.main : undefined
  const stateAccounts = isRecord(state.accounts) ? state.accounts : {}

  const quotaConfig = isRecord(configValue.quota) ? configValue.quota : {}
  const refreshConfig = isRecord(configValue.refresh) ? configValue.refresh : {}
  const mainQuotaSource = mainState ?? quotaConfig
  const mainRefreshSource = mainState ?? refreshConfig

  const accounts = Array.isArray(configValue.accounts)
    ? configValue.accounts.map((account) => {
        if (!isRecord(account)) return account
        const stateAccount: Record<string, unknown> =
          typeof account.id === 'string' && isRecord(stateAccounts[account.id])
            ? (stateAccounts[account.id] as Record<string, unknown>)
            : {}
        return { ...account, ...stateAccount }
      })
    : []

  return {
    ...configValue,
    refresh: objectWithDefinedEntries({
      ...refreshConfig,
      mainLastRefreshError: mainRefreshSource.lastRefreshError,
      mainRefreshLeaseId: mainRefreshSource.refreshLeaseId,
      mainRefreshLeaseUntil: mainRefreshSource.refreshLeaseUntil,
      mainRefreshLeaseTokenHash: mainRefreshSource.refreshLeaseTokenHash,
    }),
    quota: objectWithDefinedEntries({
      ...quotaConfig,
      mainQuota: mainQuotaSource.quota,
      mainQuotaCheckedAt: mainQuotaSource.quotaCheckedAt,
      mainQuotaToken: mainQuotaSource.quotaToken,
      mainLastQuotaApiError: mainQuotaSource.lastQuotaApiError,
    }),
    accounts,
  }
}

export async function loadAccounts(path = getAccountStoragePath()) {
  const config = await readJsonIfPresent(path)
  const state = await readJsonIfPresent(getAccountStatePath(path))
  // Runtime-only flows (main-OAuth refresh with no fallback accounts) write the
  // state file but never the config file, so the store is absent only when
  // neither exists. Synthesize an empty config to merge state into otherwise.
  if (!config.exists && !state.exists) return null
  const configValue = config.exists ? config.value : createEmptyStorage()
  return normalizeStorage(mergeConfigAndState(configValue, state.value))
}

async function loadExistingTopLevelFields(path: string) {
  const existing = await readJsonIfPresent(path)
  return isRecord(existing.value) ? existing.value : {}
}

function omitUndefinedTopLevel(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function accountConfig(account: FallbackAccount) {
  return objectWithDefinedEntries({
    id: account.id,
    label: account.label,
    type: account.type,
    enabled: account.enabled,
    addedAt: account.addedAt,
    baseURL: account.type === 'api' ? account.baseURL : undefined,
    authHeader: account.type === 'api' ? account.authHeader : undefined,
  })
}

function accountRuntimeState(account: FallbackAccount) {
  if (account.type === 'api') {
    return objectWithDefinedEntries({
      apiKey: account.apiKey,
      lastUsed: account.lastUsed,
    })
  }
  return objectWithDefinedEntries({
    access: account.access,
    refresh: account.refresh,
    expires: account.expires,
    lastUsed: account.lastUsed,
    lastRefreshedAt: account.lastRefreshedAt,
    lastRefreshError: account.lastRefreshError,
    lastQuotaRefreshError: account.lastQuotaRefreshError,
    quota: account.quota,
  })
}

function quotaSnapshotCheckedAt(quota: OAuthQuotaSnapshot | undefined) {
  return Math.max(
    quota?.five_hour?.checkedAt ?? 0,
    quota?.seven_day?.checkedAt ?? 0,
  )
}

function mergeAccountRuntimeState(
  existing: unknown,
  incoming: AccountRuntimeEntry,
): AccountRuntimeEntry {
  if (!isRecord(existing)) return incoming
  const existingEntry = existing as AccountRuntimeEntry
  const existingQuotaCheckedAt = quotaSnapshotCheckedAt(existingEntry.quota)
  const incomingQuotaCheckedAt = quotaSnapshotCheckedAt(incoming.quota)
  if (existingQuotaCheckedAt > incomingQuotaCheckedAt) {
    const tokenChanged = Boolean(
      existingEntry.access &&
        incoming.access &&
        existingEntry.access !== incoming.access,
    )
    const existingRefreshAt = existingEntry.lastRefreshedAt ?? 0
    const incomingRefreshAt = incoming.lastRefreshedAt ?? 0
    if (tokenChanged && incomingRefreshAt <= existingRefreshAt) {
      const merged: AccountRuntimeEntry = { ...existingEntry }
      if (
        typeof incoming.lastUsed === 'number' &&
        (!(typeof existingEntry.lastUsed === 'number') ||
          incoming.lastUsed > existingEntry.lastUsed)
      ) {
        merged.lastUsed = incoming.lastUsed
      }
      return merged
    }
    return {
      ...existingEntry,
      ...incoming,
      quota: existingEntry.quota,
      lastQuotaRefreshError: existingEntry.lastQuotaRefreshError,
    }
  }
  const merged: AccountRuntimeEntry = { ...existingEntry, ...incoming }
  if (!('lastQuotaRefreshError' in incoming)) {
    delete merged.lastQuotaRefreshError
  }
  if (!('lastRefreshError' in incoming)) {
    delete merged.lastRefreshError
  }
  return merged
}

function configFromStorage(storage: AccountStorage): Record<string, unknown> {
  const refresh = storage.refresh
    ? objectWithDefinedEntries({
        enabled: storage.refresh.enabled,
        intervalMinutes: storage.refresh.intervalMinutes,
        refreshBeforeExpiryMinutes: storage.refresh.refreshBeforeExpiryMinutes,
      })
    : undefined
  const quota = storage.quota
    ? objectWithDefinedEntries({
        enabled: storage.quota.enabled,
        checkIntervalMinutes: storage.quota.checkIntervalMinutes,
        refreshEveryNRequests: storage.quota.refreshEveryNRequests,
        minimumRemaining: storage.quota.minimumRemaining,
        failClosedOnUnknownQuota: storage.quota.failClosedOnUnknownQuota,
        showToasts: storage.quota.showToasts,
      })
    : undefined

  return omitUndefinedTopLevel({
    version: 1,
    main: storage.main,
    routing: storage.routing,
    fallbackOn: storage.fallbackOn,
    refresh,
    quota,
    claudeCache: storage.claudeCache,
    dump: storage.dump,
    logging: storage.logging,
    claudeFast: storage.claudeFast,
    costZeroing: storage.costZeroing,
    cacheKeep: storage.cacheKeep,
    relay: storage.relay,
    killswitch: storage.killswitch,
    accounts: storage.accounts.map(accountConfig),
  })
}

// ---------------------------------------------------------------------------
// In-process save mutex — serializes all account-store writes so concurrent
// read-modify-write callers (background timers that call saveAccountState with
// different section flags) don't lose each other's updates (#9).
// ---------------------------------------------------------------------------
let saveChain: Promise<void> = Promise.resolve()

function enqueueSave<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    saveChain = saveChain.then(
      () => fn().then(resolve, reject),
      () => fn().then(resolve, reject),
    )
  })
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

export function saveAccounts(
  storage: AccountStorage,
  path = getAccountStoragePath(),
): Promise<void> {
  const resolvedPath = path
  return enqueueSave(() => saveAccountsLocked(storage, resolvedPath))
}

async function saveAccountsLocked(storage: AccountStorage, path: string) {
  const existing = await loadExistingTopLevelFields(path)
  const nextConfig = { ...existing, ...configFromStorage(storage) }
  await writeJsonAtomic(path, nextConfig)
  await saveAccountStateUnlocked(storage, path, {
    mainQuota: true,
    mainRefresh: true,
    accounts: true,
  })
}

function applyMainQuotaStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  const existingCheckedAt =
    typeof state.main.quotaCheckedAt === 'number'
      ? state.main.quotaCheckedAt
      : quotaSnapshotCheckedAt(state.main.quota)
  const incomingCheckedAt =
    typeof storage.quota?.mainQuotaCheckedAt === 'number'
      ? storage.quota.mainQuotaCheckedAt
      : quotaSnapshotCheckedAt(storage.quota?.mainQuota)
  if (existingCheckedAt > incomingCheckedAt) return

  state.main.quota = storage.quota?.mainQuota
  state.main.quotaCheckedAt = storage.quota?.mainQuotaCheckedAt
  state.main.quotaToken = storage.quota?.mainQuotaToken
  state.main.lastQuotaApiError = storage.quota?.mainLastQuotaApiError
}

function applyMainRefreshStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  state.main.lastRefreshError = storage.refresh?.mainLastRefreshError
  state.main.refreshLeaseId = storage.refresh?.mainRefreshLeaseId
  state.main.refreshLeaseUntil = storage.refresh?.mainRefreshLeaseUntil
  state.main.refreshLeaseTokenHash = storage.refresh?.mainRefreshLeaseTokenHash
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)]),
  )
}

export function saveAccountState(
  storage: AccountStorage,
  path = getAccountStoragePath(),
  scope: AccountStateSaveScope = {
    mainQuota: true,
    mainRefresh: true,
    accounts: true,
  },
): Promise<void> {
  const resolvedPath = path
  return enqueueSave(() =>
    saveAccountStateUnlocked(storage, resolvedPath, scope),
  )
}

async function saveAccountStateUnlocked(
  storage: AccountStorage,
  path: string,
  scope: AccountStateSaveScope,
) {
  const statePath = getAccountStatePath(path)
  const existing = (await readJsonIfPresent(statePath)).value
  const next: AccountRuntimeState = isRecord(existing)
    ? ({ ...existing, version: 1 } as AccountRuntimeState)
    : { version: 1 }

  if (scope.mainQuota) applyMainQuotaStatePatch(next, storage)
  if (scope.mainRefresh) applyMainRefreshStatePatch(next, storage)

  if (scope.accounts) {
    const ids = scope.accounts === true ? null : new Set(scope.accounts)
    next.accounts = { ...(isRecord(next.accounts) ? next.accounts : {}) }
    for (const account of storage.accounts) {
      if (ids && !ids.has(account.id)) continue
      next.accounts[account.id] = mergeAccountRuntimeState(
        next.accounts[account.id],
        accountRuntimeState(account),
      )
    }
    if (ids) {
      for (const id of ids) {
        if (!storage.accounts.some((account) => account.id === id)) {
          delete next.accounts[id]
        }
      }
    }
  }

  await writeJsonAtomic(statePath, pruneUndefined(next))
}

export async function acquireRefreshFileLock(options: {
  name: string
  ttlMs: number
  path?: string
  now?: () => number
  renew?: boolean
  renewIntervalMs?: number
  onStep?: (
    step:
      | 'stale-marker-stat'
      | 'stale-marker-claimed'
      | 'stale-lock-confirmed'
      | 'eviction-marker-acquired',
  ) => void | Promise<void>
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
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
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
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
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
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
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
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
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
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
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
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
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
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isCacheKeepSubagentsEnabled(storage: AccountStorage | null) {
  return storage?.cacheKeep?.subagents === true
}

export async function setCacheKeepSubagentsEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.cacheKeep = {
    ...(storage.cacheKeep ?? {}),
    subagents: enabled,
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
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isFinite(status)) {
    return status === 429 || status >= 500
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
  const retryAfterFromError = (input.error as { retryAfter?: unknown })
    .retryAfter
  let delay: number
  if (typeof retryAfterFromError === 'number' && retryAfterFromError > 0) {
    delay = retryAfterFromError * 1000
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

export function getPersistedLogLevel(
  storage: AccountStorage | null,
): LogLevel | undefined {
  return storage?.logging?.level
}

export async function setLogLevelPersistent(
  level: LogLevel,
  path = getAccountStoragePath(),
) {
  const { setLogLevel } = await import('./logger.ts')
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.logging = {
    ...(storage.logging ?? {}),
    level,
  }
  await saveAccounts(storage, path)
  setLogLevel(level)
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
    if (!Number.isFinite(window.remainingPercent)) {
      return !failClosedOnUnknownQuota(storage)
    }
    if (window.remainingPercent < thresholds[key]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Killswitch — hard-block requests when remaining quota drops below per-account
// thresholds, even if the API would still accept them.
// ---------------------------------------------------------------------------

export const DEFAULT_KILLSWITCH_THRESHOLDS: Record<QuotaWindowName, number> = {
  five_hour: 5,
  seven_day: 10,
}

function normalizeKillswitchThresholds(
  thresholds: KillswitchThresholds | undefined,
): Record<QuotaWindowName, number> {
  const fiveHour = thresholds?.five_hour ?? thresholds?.['5h']
  const sevenDay = thresholds?.seven_day ?? thresholds?.['1w']
  return {
    five_hour:
      typeof fiveHour === 'number' && Number.isFinite(fiveHour)
        ? fiveHour
        : DEFAULT_KILLSWITCH_THRESHOLDS.five_hour,
    seven_day:
      typeof sevenDay === 'number' && Number.isFinite(sevenDay)
        ? sevenDay
        : DEFAULT_KILLSWITCH_THRESHOLDS.seven_day,
  }
}

export function isKillswitchEnabled(storage: AccountStorage | null) {
  return storage?.killswitch?.enabled === true
}

function getKillswitchThresholdsForAccount(
  storage: AccountStorage | null,
  accountId?: string,
): Record<QuotaWindowName, number> {
  if (!storage?.killswitch) return DEFAULT_KILLSWITCH_THRESHOLDS
  if (accountId && storage.killswitch.accounts?.[accountId]) {
    return normalizeKillswitchThresholds(storage.killswitch.accounts[accountId])
  }
  return normalizeKillswitchThresholds(storage.killswitch.main)
}

/**
 * Returns true if the account's quota is above its killswitch threshold.
 * When killswitch is disabled, always returns true.
 */
export function killswitchPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  accountId?: string,
) {
  if (!isKillswitchEnabled(storage)) return true
  const thresholds = getKillswitchThresholdsForAccount(storage, accountId)
  let sawUnknownWindow = false
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    // Defer the unknown-window decision: a quota snapshot can legally carry
    // only one window, and a present window below its threshold must still
    // block even if the other window is missing.
    if (!window) {
      sawUnknownWindow = true
      continue
    }
    if (!Number.isFinite(window.remainingPercent)) {
      sawUnknownWindow = true
      continue
    }
    if (window.remainingPercent < thresholds[key]) return false
  }
  if (sawUnknownWindow) return !failClosedOnUnknownQuota(storage)
  return true
}

/**
 * Find the earliest reset time across all accounts' quota windows.
 * Returns seconds from `now` until that reset, or 300 as a fallback.
 */
export function killswitchRetryAfterSeconds(
  mainQuota: OAuthQuotaSnapshot | undefined,
  fallbackAccounts: Array<{ quota?: OAuthQuotaSnapshot }>,
  now: number,
): number {
  const resetTimes: number[] = []
  const allQuotas = [mainQuota, ...fallbackAccounts.map((a) => a.quota)]
  for (const quota of allQuotas) {
    for (const key of ['five_hour', 'seven_day'] as const) {
      const resetStr = quota?.[key]?.resetsAt
      if (!resetStr) continue
      const resetTime = Date.parse(resetStr)
      if (Number.isFinite(resetTime) && resetTime > now) {
        resetTimes.push(resetTime)
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

export async function setKillswitchPersistent(
  config: KillswitchConfig,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  storage.killswitch = config
  await saveAccounts(storage, path)
  return storage
}

export async function removeAccountPersistent(
  id: string,
  path = getAccountStoragePath(),
): Promise<boolean> {
  const storage = await loadAccounts(path)
  if (!storage) return false
  const existed = removeAccount(storage, id)
  if (existed) await saveAccounts(storage, path)
  return existed
}

export async function reorderAccountsPersistent(
  orderedIds: string[],
  path = getAccountStoragePath(),
) {
  const storage = await loadAccounts(path)
  if (!storage) return
  reorderAccounts(storage, orderedIds)
  await saveAccounts(storage, path)
}

export async function setAccountEnabledPersistent(
  id: string,
  enabled: boolean,
  path = getAccountStoragePath(),
): Promise<boolean> {
  const storage = await loadAccounts(path)
  if (!storage) return false
  const found = setAccountEnabled(storage, id, enabled)
  if (found) await saveAccounts(storage, path)
  return found
}

export async function addAccountPersistent(
  account: FallbackAccount,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? createEmptyStorage()
  upsertAccount(storage, account)
  await saveAccounts(storage, path)
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

function quotaSnapshotIsFresh(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quotaEnabled(storage)) return true
  const maxAge = getQuotaCheckIntervalMs(storage)
  return (['five_hour', 'seven_day'] as const).every((key) => {
    const window = quota?.[key]
    return Boolean(window && now - window.checkedAt < maxAge)
  })
}

function quotaIsStale(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  return !quotaSnapshotIsFresh(account.quota, storage, now)
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
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 429 || status >= 500) return true
  }

  const formattedMessage = formatErrorMessage(error)
  if (/Claude quota check failed: (429|5\d\d)\b/.test(formattedMessage)) {
    return true
  }
  if (formattedMessage.includes('Quota refresh is already in progress')) {
    return true
  }

  if (!(error instanceof Error)) return false
  const message = error.message
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
  if (!Number.isFinite(window.utilization)) return undefined
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
  const usage = (await response.json()) as OAuthUsageResponse
  return {
    five_hour: mapUsageWindow(usage.five_hour, checkedAt),
    seven_day: mapUsageWindow(usage.seven_day, checkedAt),
  } satisfies OAuthQuotaSnapshot
}

function updateStoredAccount(
  storage: AccountStorage,
  account: FallbackAccount,
) {
  const index = storage.accounts.findIndex(
    (candidate) => candidate.id === account.id,
  )
  if (index >= 0) storage.accounts[index] = account
}

export function upsertAccount(
  storage: AccountStorage,
  account: FallbackAccount,
) {
  const index = storage.accounts.findIndex(
    (candidate) =>
      candidate.id === account.id ||
      (account.label && candidate.label === account.label),
  )
  if (index >= 0) {
    storage.accounts[index] = {
      ...storage.accounts[index],
      ...account,
      addedAt: storage.accounts[index]?.addedAt ?? account.addedAt,
      ...(account.type === 'oauth' && {
        quota: account.quota,
        lastRefreshedAt: account.lastRefreshedAt,
        lastRefreshError: account.lastRefreshError,
        lastQuotaRefreshError: account.lastQuotaRefreshError,
      }),
    }
    return
  }
  storage.accounts.push(account)
}

export function removeAccount(storage: AccountStorage, id: string): boolean {
  const index = storage.accounts.findIndex((c) => c.id === id)
  if (index < 0) return false
  storage.accounts.splice(index, 1)
  return true
}

export function reorderAccounts(storage: AccountStorage, orderedIds: string[]) {
  const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
  const known = storage.accounts.filter((a) => orderMap.has(a.id))
  const unknown = storage.accounts.filter((a) => !orderMap.has(a.id))
  known.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
  storage.accounts = [...known, ...unknown]
}

export function setAccountEnabled(
  storage: AccountStorage,
  id: string,
  enabled: boolean,
): boolean {
  const account = storage.accounts.find((c) => c.id === id)
  if (!account) return false
  account.enabled = enabled
  return true
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
  if ((error as { isRefreshError?: boolean }).isRefreshError) {
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
    if (!account.quota) return
    const checkedAt = Math.max(
      account.quota.five_hour?.checkedAt ?? 0,
      account.quota.seven_day?.checkedAt ?? 0,
    )
    if (checkedAt <= 0) return
    const existing = this.quotaManager.getFallback(account.id, account.access)
    if (existing && existing.checkedAt >= checkedAt) return
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

  async save(storage: AccountStorage, accountIds?: string[]) {
    await saveAccountState(storage, this.configPath, {
      accounts: accountIds ?? true,
    })
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
      if (account.enabled === false || !isOAuthAccount(account)) continue
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

  async markUsed(account: FallbackAccount) {
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
      if (account.enabled === false || !isOAuthAccount(account)) continue
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
        logger.warn('refresh', 'fallback oauth background failed', {
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
      if (account.enabled === false || !isOAuthAccount(account)) continue
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
      if (account.enabled === false || !isOAuthAccount(account)) continue
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
  ): Promise<OAuthAccount> {
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
  ): Promise<OAuthAccount | null> {
    const deadline = Date.now() + FALLBACK_REFRESH_JOIN_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, FALLBACK_REFRESH_JOIN_POLL_MS),
      )
      const latestStorage = await this.load()
      const latestAccount = latestStorage?.accounts.find(
        (candidate): candidate is OAuthAccount =>
          candidate.id === account.id && isOAuthAccount(candidate),
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
  ): Promise<OAuthAccount> {
    let latestStorage = await this.load()
    let latestAccount = latestStorage?.accounts.find(
      (candidate): candidate is OAuthAccount =>
        candidate.id === account.id && isOAuthAccount(candidate),
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
        (candidate): candidate is OAuthAccount =>
          candidate.id === account.id && isOAuthAccount(candidate),
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
    const fetchStartedAt = this.now()
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

    const latestStorage = await this.load()
    const latestAccount = latestStorage?.accounts.find(
      (candidate): candidate is OAuthAccount =>
        candidate.id === target.id && isOAuthAccount(candidate),
    )
    if (
      latestStorage &&
      latestAccount &&
      latestAccount.access !== target.access
    ) {
      this.seedFallbackQuota(latestAccount, latestStorage)
      updateStoredAccount(storage, latestAccount)
      return latestAccount
    }
    if (
      latestStorage &&
      latestAccount?.access === target.access &&
      latestAccount.quota &&
      quotaSnapshotCheckedAt(latestAccount.quota) >= fetchStartedAt &&
      quotaSnapshotIsFresh(latestAccount.quota, latestStorage, this.now())
    ) {
      this.seedFallbackQuota(latestAccount, latestStorage)
      updateStoredAccount(storage, latestAccount)
      return latestAccount
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
