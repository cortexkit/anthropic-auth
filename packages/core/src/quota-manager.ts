/**
 * Unified quota cache and API gateway.
 *
 * Single source of truth for main + fallback quota state. All consumers
 * share one QuotaManager instance so they see the same in-memory cache.
 * Handles deduplication, rate-limiting (429 backoff), and staleness.
 */

import type {
  AccountOperationError,
  AccountStorage,
  OAuthAccount,
  OAuthQuotaSnapshot,
} from './accounts.ts'
import {
  acquireRefreshFileLock,
  buildQuotaOperationError,
  fetchOAuthQuotaSnapshot,
  getPersistedMainQuota,
  getQuotaCheckIntervalMs,
  getQuotaNextRefreshAt,
  getQuotaRefreshEveryNRequests,
  getScopedQuotaWindowForModel,
  isQuotaPolicyAuthError,
  quotaBackoffActive,
  quotaSnapshotCheckedAt,
} from './accounts.ts'
import { mergeHeaderQuotaSnapshot } from './quota-headers.ts'

export { tokenFingerprint } from './token-fingerprint.ts'

import { tokenFingerprint } from './token-fingerprint.ts'

// Capture real setTimeout before tests can mock globalThis.setTimeout
const nativeSetTimeout = globalThis.setTimeout

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuotaEntry = {
  quota: OAuthQuotaSnapshot
  refreshAfter: number // Unix ms — earliest next refresh
  checkedAt: number // when snapshot was fetched
}

export type QuotaRefreshResult = {
  quota: OAuthQuotaSnapshot
  /** False when backoff or a cross-process lock served the existing cache. */
  fetched: boolean
}

export type QuotaManagerOptions = {
  storage: AccountStorage | null
  fetchImpl?: typeof fetch
  now?: () => number
  onMainQuotaFetched?: (
    quota: OAuthQuotaSnapshot,
    checkedAt: number,
    tokenFingerprint: string,
    fetchStartedAt: number,
  ) => void
  onApiError?: (error: AccountOperationError) => void
}

function mergePollCompletionWithNewerHeaders(
  current: OAuthQuotaSnapshot | undefined,
  polled: OAuthQuotaSnapshot,
): OAuthQuotaSnapshot {
  if (current?.source !== 'headers') return polled
  const fiveHourIsNewer = Boolean(
    current.five_hour &&
      current.five_hour.checkedAt > (polled.five_hour?.checkedAt ?? 0),
  )
  const sevenDayIsNewer = Boolean(
    current.seven_day &&
      current.seven_day.checkedAt > (polled.seven_day?.checkedAt ?? 0),
  )
  if (!fiveHourIsNewer && !sevenDayIsNewer) return polled

  return mergeHeaderQuotaSnapshot(polled, {
    ...(fiveHourIsNewer && { five_hour: current.five_hour }),
    ...(sevenDayIsNewer && { seven_day: current.seven_day }),
    fallbackAdvised: current.fallbackAdvised,
    ...(current.bindingWindowSource === 'headers' && {
      bindingWindow: current.bindingWindow,
      bindingWindowSource: current.bindingWindowSource,
    }),
    source: 'headers',
    checkedAt: Math.max(
      fiveHourIsNewer ? (current.five_hour?.checkedAt ?? 0) : 0,
      sevenDayIsNewer ? (current.seven_day?.checkedAt ?? 0) : 0,
    ),
  })
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class QuotaManager {
  // --- State ---
  private main: QuotaEntry | null = null
  private mainAccountId: string | undefined
  private fallbacks = new Map<string, QuotaEntry>()

  // --- Inflight deduplication ---
  private inflightMain: Promise<QuotaRefreshResult> | null = null
  private inflightMainAccountId: string | undefined
  private inflightFallbacks = new Map<string, Promise<QuotaRefreshResult>>()

  // --- Rate-limiting (scoped per route so a fallback 429 never backs off the
  // main account or vice versa) ---
  private mainLastApiError: AccountOperationError | undefined = undefined
  private fallbackApiErrors = new Map<string, AccountOperationError>()
  private fallbackErrorTokenFps = new Map<string, string>()

  // --- Serial API gate (prevents concurrent quota API calls) ---
  private apiGate: Promise<unknown> = Promise.resolve()
  private lastApiCallAt = 0

  // --- Config ---
  private storage: AccountStorage | null
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly onMainQuotaFetched: QuotaManagerOptions['onMainQuotaFetched']
  private readonly onApiError: QuotaManagerOptions['onApiError']

  constructor(opts: QuotaManagerOptions) {
    this.storage = opts.storage
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.now = opts.now ?? Date.now
    this.onMainQuotaFetched = opts.onMainQuotaFetched
    this.onApiError = opts.onApiError

    this.seedMainFromStorage(opts.storage, opts.storage?.mainAccountId)
    this.seedMainBackoffFromStorage(opts.storage)
  }

  // =========================================================================
  // Get (synchronous, from cache)
  // =========================================================================

  /**
   * Cached main quota entry, scoped to the stable main account identity.
   */
  getMain(mainAccountId?: string): QuotaEntry | null {
    if (this.mainAccountId !== mainAccountId) return null
    return this.main
  }

  /**
   * Cached fallback quota entry, scoped to the configured account id.
   */
  getFallback(accountId: string, accessToken?: string): QuotaEntry | null {
    void accessToken
    return this.fallbacks.get(accountId) ?? null
  }

  getAllFallbacks(): Map<string, QuotaEntry> {
    return this.fallbacks
  }

  // =========================================================================
  // Set (manual inject — seeding from persisted account.quota on boot)
  // =========================================================================

  setMain(mainAccountId: string | undefined, entry: QuotaEntry): void {
    this.mainAccountId = mainAccountId
    this.main = entry
  }

  setFallback(
    accountId: string,
    entry: QuotaEntry,
    accessToken?: string,
  ): void {
    void accessToken
    this.fallbacks.set(accountId, entry)
  }

  pushMainFromHeaders(
    mainAccountId: string | undefined,
    incomingOrAccessToken: OAuthQuotaSnapshot | string,
    legacyIncoming?: OAuthQuotaSnapshot,
  ): QuotaEntry {
    const incoming =
      legacyIncoming ?? (incomingOrAccessToken as OAuthQuotaSnapshot)
    if (legacyIncoming) void incomingOrAccessToken
    const checkedAt = incoming.checkedAt ?? this.now()
    const quota = mergeHeaderQuotaSnapshot(
      this.mainAccountId === mainAccountId ? this.main?.quota : undefined,
      {
        ...incoming,
        ...(mainAccountId !== undefined && { accountIdentity: mainAccountId }),
      },
    )
    const entry = {
      quota,
      checkedAt,
      refreshAfter: getQuotaNextRefreshAt(quota, this.storage, checkedAt),
    }
    this.setMain(mainAccountId, entry)
    return entry
  }

  pushFallbackFromHeaders(
    accountId: string,
    accessToken: string,
    incoming: OAuthQuotaSnapshot,
  ): QuotaEntry {
    const checkedAt = incoming.checkedAt ?? this.now()
    const quota = mergeHeaderQuotaSnapshot(
      this.getFallback(accountId, accessToken)?.quota,
      { ...incoming, accountIdentity: accountId },
    )
    const entry = {
      quota,
      checkedAt,
      refreshAfter: getQuotaNextRefreshAt(quota, this.storage, checkedAt),
    }
    this.setFallback(accountId, entry, accessToken)
    return entry
  }

  // =========================================================================
  // Refresh (async, deduplicated, rate-limited)
  // =========================================================================

  async refreshMain(
    mainAccountIdOrAccessToken: string | undefined,
    accessToken?: string,
  ): Promise<OAuthQuotaSnapshot> {
    const legacy = accessToken === undefined
    const mainAccountId = legacy
      ? mainAccountIdOrAccessToken
      : mainAccountIdOrAccessToken
    const credential = accessToken ?? mainAccountIdOrAccessToken
    if (!credential) throw new Error('Main OAuth access token is unavailable')
    return (
      await this.refreshMainWithMetadata(mainAccountId, credential, legacy)
    ).quota
  }

  async refreshMainWithMetadata(
    mainAccountIdOrAccessToken: string | undefined,
    accessToken?: string,
    _legacy = false,
  ): Promise<QuotaRefreshResult> {
    const effectiveAccountId = mainAccountIdOrAccessToken
    const credential = accessToken ?? mainAccountIdOrAccessToken
    if (!credential) throw new Error('Main OAuth access token is unavailable')
    if (this.mainAccountId !== effectiveAccountId) {
      this.main = null
      this.mainAccountId = effectiveAccountId
    }

    if (this.inflightMain && this.inflightMainAccountId === effectiveAccountId)
      return this.inflightMain

    // Rate-limit — if API recently 429'd, return stale or throw
    if (this.isBackedOff()) {
      if (this.main && this.mainAccountId === effectiveAccountId) {
        return { quota: this.main.quota, fetched: false }
      }
      throw new Error('Quota API rate-limited — try again later')
    }

    this.inflightMainAccountId = effectiveAccountId
    this.inflightMain = this._fetchMain(effectiveAccountId, credential)
    return this.inflightMain
  }

  async refreshFallback(
    accountId: string,
    accessToken: string,
  ): Promise<OAuthQuotaSnapshot> {
    return (await this.refreshFallbackWithMetadata(accountId, accessToken))
      .quota
  }

  async refreshFallbackWithMetadata(
    accountId: string,
    accessToken: string,
  ): Promise<QuotaRefreshResult> {
    const inflightKey = QuotaManager.fallbackInflightKey(accountId)
    const inflight = this.inflightFallbacks.get(inflightKey)
    if (inflight) return inflight

    // Rate-limit — scoped to THIS fallback account only
    if (this.isFallbackBackedOff(accountId, accessToken)) {
      const cached = this.getFallback(accountId, accessToken)
      if (cached) return { quota: cached.quota, fetched: false }
      throw new Error('Quota API rate-limited — try again later')
    }

    const promise = this._fetchFallback(accountId, accessToken)
    this.inflightFallbacks.set(inflightKey, promise)
    return promise
  }

  async refreshAllFallbacks(accounts: OAuthAccount[]): Promise<void> {
    const now = this.now()

    for (const account of accounts) {
      if (account.enabled === false) continue
      if (!account.access) continue

      const cached = this.getFallback(account.id, account.access)
      if (cached && now < cached.refreshAfter) continue

      try {
        await this.refreshFallback(account.id, account.access)
      } catch {
        // Best-effort — keep stale cache entry if fetch fails
      }
    }
  }

  /**
   * Fire-and-forget refresh. Does not await, swallows errors.
   */
  refreshMainInBackground(accessToken: string): void {
    if (this.inflightMain) return
    if (this.isBackedOff()) return
    void this.refreshMain(undefined, accessToken).catch(() => {})
  }

  // =========================================================================
  // Staleness queries
  // =========================================================================

  private scopedWindowIsStale(entry: QuotaEntry, modelId?: string) {
    const scoped = getScopedQuotaWindowForModel(entry.quota, modelId)
    return Boolean(
      scoped &&
        this.now() - scoped.checkedAt >= getQuotaCheckIntervalMs(this.storage),
    )
  }

  isMainStale(modelId?: string): boolean {
    if (!this.main) return true
    return (
      this.now() >= this.main.refreshAfter ||
      this.scopedWindowIsStale(this.main, modelId)
    )
  }

  isFallbackStale(
    accountId: string,
    accessToken?: string,
    modelId?: string,
  ): boolean {
    // Token-aware: a credential change invalidates the entry (treated as stale).
    const entry = this.getFallback(accountId, accessToken)
    if (!entry) return true
    return (
      this.now() >= entry.refreshAfter ||
      this.scopedWindowIsStale(entry, modelId)
    )
  }

  shouldRefreshOnRequestCount(requestCount: number): boolean {
    const everyN = getQuotaRefreshEveryNRequests(this.storage)
    if (everyN <= 0) return false
    return requestCount > 0 && requestCount % everyN === 0
  }

  /**
   * Combined check: should a refresh happen right now?
   * True if main is stale by time OR triggered by request count.
   */
  needsRefresh(requestCount: number, modelId?: string): boolean {
    return (
      this.isMainStale(modelId) ||
      this.shouldRefreshOnRequestCount(requestCount)
    )
  }

  // =========================================================================
  // Config
  // =========================================================================

  updateStorage(storage: AccountStorage | null): void {
    this.storage = storage
    this.seedMainFromStorage(storage, storage?.mainAccountId)
    this.seedMainBackoffFromStorage(storage)
  }

  /**
   * Seed/update the main quota cache from persisted state. This is deliberately
   * callable after every disk load so another plugin process's fresh quota write
   * can stop this process from showing "checking…" or making a redundant quota
   * API call.
   */
  seedMainFromStorage(
    storage: AccountStorage | null,
    mainAccountId?: string,
  ): void {
    const persisted = getPersistedMainQuota(storage)
    if (!persisted) return

    if (
      mainAccountId === undefined &&
      persisted.accountIdentity !== undefined
    ) {
      this.main = null
      this.mainAccountId = undefined
      return
    }
    if (
      mainAccountId !== undefined &&
      persisted.accountIdentity !== undefined &&
      persisted.accountIdentity !== mainAccountId
    ) {
      this.main = null
      this.mainAccountId = mainAccountId
      return
    }

    const entry: QuotaEntry = {
      quota: {
        ...persisted.quota,
        ...(mainAccountId !== undefined && {
          accountIdentity: mainAccountId,
        }),
      },
      refreshAfter: getQuotaNextRefreshAt(
        persisted.quota,
        storage,
        persisted.checkedAt,
      ),
      checkedAt: persisted.checkedAt,
    }
    if (
      this.main &&
      this.main.checkedAt >= entry.checkedAt &&
      this.mainAccountId === mainAccountId
    ) {
      return
    }

    this.main = entry
    this.mainAccountId = mainAccountId
  }

  private seedMainBackoffFromStorage(storage: AccountStorage | null): void {
    const persistedError = storage?.quota?.mainLastQuotaApiError
    this.mainLastApiError =
      persistedError && quotaBackoffActive(persistedError, this.now())
        ? persistedError
        : undefined
  }

  /**
   * Seed fallback cache entries from persisted account.quota data.
   * Updates older in-memory entries so a fresh quota write from another plugin
   * process prevents redundant checks and stale sidebar writes.
   */
  seedFallbacksFromAccounts(accounts: OAuthAccount[]): void {
    const checkInterval = getQuotaCheckIntervalMs(this.storage)
    for (const account of accounts) {
      if (account.enabled === false) continue
      if (!account.quota) continue
      const checkedAt = quotaSnapshotCheckedAt(account.quota)
      if (checkedAt <= 0) continue
      const existing = this.getFallback(account.id, account.access)
      if (existing && existing.checkedAt >= checkedAt) continue
      this.setFallback(
        account.id,
        {
          quota: { ...account.quota, accountIdentity: account.id },
          refreshAfter: checkedAt + checkInterval,
          checkedAt,
        },
        account.access,
      )
    }
  }

  /**
   * Whether the MAIN quota API is currently in backoff. Scoped to the main
   * account — a fallback account's 429 never reports here.
   */
  isBackedOff(): boolean {
    return quotaBackoffActive(this.mainLastApiError, this.now())
  }

  /**
   * Whether a specific fallback account's quota API is in backoff.
   */
  isFallbackBackedOff(accountId: string, accessToken?: string): boolean {
    if (accessToken) {
      const errorFp = this.fallbackErrorTokenFps.get(accountId)
      if (errorFp !== tokenFingerprint(accessToken)) return false
    }
    return quotaBackoffActive(this.fallbackApiErrors.get(accountId), this.now())
  }

  getLastApiError(): AccountOperationError | undefined {
    return this.mainLastApiError
  }

  // =========================================================================
  // Private
  // =========================================================================

  /** Minimum gap between consecutive quota API calls (ms). */
  private static readonly API_CALL_GAP_MS = 1_000

  private static fallbackInflightKey(accountId: string): string {
    return accountId
  }

  private static quotaLockName(accountId: string): string {
    const safeId = accountId.replace(/[^a-zA-Z0-9._-]+/g, '-')
    return `opencode-fallback-quota-refresh-${safeId || 'account'}`
  }

  /**
   * Serialize API calls through a shared gate so only one
   * quota API request runs at a time, with a minimum gap
   * between calls. Prevents concurrent and rapid-fire calls
   * from triggering Anthropic's rate limits.
   */
  private _enqueueApiFetch<T>(fn: () => Promise<T>): Promise<T> {
    const gatedFn = async (): Promise<T> => {
      // Wait until minimum gap since last API call
      const elapsed = this.now() - this.lastApiCallAt
      if (elapsed < QuotaManager.API_CALL_GAP_MS) {
        await new Promise<void>((r) => {
          const id = nativeSetTimeout(r, QuotaManager.API_CALL_GAP_MS - elapsed)
          if (typeof id === 'object' && 'unref' in id) id.unref()
        })
      }
      this.lastApiCallAt = this.now()
      return fn()
    }
    const queued = this.apiGate.then(gatedFn, gatedFn)
    this.apiGate = queued.catch(() => {})
    return queued
  }

  private async _fetchMain(
    mainAccountId: string | undefined,
    accessToken: string,
  ): Promise<QuotaRefreshResult> {
    return this._enqueueApiFetch(async () => {
      try {
        // Re-check backoff inside gate — may have been set by
        // a preceding queued call while we waited
        if (this.isBackedOff()) {
          if (this.main && this.mainAccountId === mainAccountId) {
            return { quota: this.main.quota, fetched: false }
          }
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: 'opencode-main-quota-refresh',
          ttlMs: 30_000,
        })
        if (!fileLock) {
          const cached = this.main
          if (
            cached &&
            this.mainAccountId === mainAccountId &&
            this.now() < cached.refreshAfter
          ) {
            return { quota: cached.quota, fetched: false }
          }
          throw new Error('Quota refresh is already in progress')
        }
        try {
          const fetchStartedAt = this.now()
          const quota = await fetchOAuthQuotaSnapshot({
            accessToken,
            fetchImpl: this.fetchImpl,
            now: this.now,
          })
          const now = this.now()
          const completedQuota = mergePollCompletionWithNewerHeaders(
            this.mainAccountId === mainAccountId ? this.main?.quota : undefined,
            {
              ...quota,
              ...(mainAccountId !== undefined && {
                accountIdentity: mainAccountId,
              }),
            },
          )
          this.mainAccountId = mainAccountId
          this.main = {
            quota: completedQuota,
            refreshAfter: getQuotaNextRefreshAt(
              completedQuota,
              this.storage,
              now,
            ),
            checkedAt: completedQuota.checkedAt ?? now,
          }
          this.mainLastApiError = undefined
          this.onMainQuotaFetched?.(
            completedQuota,
            now,
            tokenFingerprint(accessToken),
            fetchStartedAt,
          )
          return { quota: completedQuota, fetched: true }
        } catch (error) {
          this._handleMainFetchError(error)
          throw error
        } finally {
          await fileLock.release()
        }
      } finally {
        if (this.inflightMainAccountId === mainAccountId) {
          this.inflightMain = null
          this.inflightMainAccountId = undefined
        }
      }
    })
  }

  private async _fetchFallback(
    accountId: string,
    accessToken: string,
  ): Promise<QuotaRefreshResult> {
    return this._enqueueApiFetch(async () => {
      try {
        // Re-check backoff inside gate — scoped to this fallback account
        if (this.isFallbackBackedOff(accountId, accessToken)) {
          const cached = this.getFallback(accountId)
          if (cached) return { quota: cached.quota, fetched: false }
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: QuotaManager.quotaLockName(accountId),
          ttlMs: 30_000,
        })
        if (!fileLock) {
          const cached = this.getFallback(accountId)
          if (cached && this.now() < cached.refreshAfter) {
            return { quota: cached.quota, fetched: false }
          }
          throw new Error('Quota refresh is already in progress')
        }
        try {
          const quota = await fetchOAuthQuotaSnapshot({
            accessToken,
            fetchImpl: this.fetchImpl,
            now: this.now,
          })
          const now = this.now()
          const completedQuota = mergePollCompletionWithNewerHeaders(
            this.getFallback(accountId)?.quota,
            { ...quota, accountIdentity: accountId },
          )
          this.setFallback(
            accountId,
            {
              quota: completedQuota,
              refreshAfter: getQuotaNextRefreshAt(
                completedQuota,
                this.storage,
                now,
              ),
              checkedAt: completedQuota.checkedAt ?? now,
            },
            accessToken,
          )
          this.fallbackApiErrors.delete(accountId)
          this.fallbackErrorTokenFps.delete(accountId)
          return { quota: completedQuota, fetched: true }
        } finally {
          await fileLock.release()
        }
      } catch (error) {
        this._handleFallbackFetchError(accountId, accessToken, error)
        throw error
      } finally {
        this.inflightFallbacks.delete(
          QuotaManager.fallbackInflightKey(accountId),
        )
      }
    })
  }

  // A 401 is an auth/token problem and a 403 is an account/org policy problem,
  // not quota endpoint saturation. Surface both without recording quota backoff
  // so callers can refresh, re-auth, or try another account immediately.
  private static isAuthError(error: unknown): boolean {
    const status = (error as { status?: unknown }).status
    if (status === 401 || isQuotaPolicyAuthError(error)) return true
    const message = error instanceof Error ? error.message : String(error)
    return /quota check failed: 401\b/.test(message)
  }

  /** Main quota failure: arms main-only backoff and persists via onApiError. */
  private _handleMainFetchError(error: unknown): void {
    if (QuotaManager.isAuthError(error)) return
    this.mainLastApiError = buildQuotaOperationError({
      error,
      now: this.now(),
      previous: this.mainLastApiError,
    })
    this.onApiError?.(this.mainLastApiError)
  }

  /**
   * Fallback quota failure: arms backoff for THIS account only. Never touches
   * main backoff state and never calls onApiError (which persists the main
   * quota error) — the per-account error is recorded by the caller via the
   * account's lastQuotaRefreshError.
   */
  private _handleFallbackFetchError(
    accountId: string,
    accessToken: string,
    error: unknown,
  ): void {
    if (QuotaManager.isAuthError(error)) return
    const tokenFp = tokenFingerprint(accessToken)
    const previous =
      this.fallbackErrorTokenFps.get(accountId) === tokenFp
        ? this.fallbackApiErrors.get(accountId)
        : undefined
    this.fallbackApiErrors.set(
      accountId,
      buildQuotaOperationError({
        error,
        now: this.now(),
        previous,
      }),
    )
    this.fallbackErrorTokenFps.set(accountId, tokenFp)
  }
}
