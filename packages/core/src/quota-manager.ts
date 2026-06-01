/**
 * Unified quota cache and API gateway.
 *
 * Single source of truth for main + fallback quota state. All consumers
 * share one QuotaManager instance so they see the same in-memory cache.
 * Handles deduplication, rate-limiting (429 backoff), and staleness.
 */

import { createHash } from 'node:crypto'
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
  quotaBackoffActive,
} from './accounts.ts'

// Capture real setTimeout before tests can mock globalThis.setTimeout
const nativeSetTimeout = globalThis.setTimeout

/**
 * Stable, non-reversible fingerprint of an access token. Used to detect a
 * main-account switch so a different account's persisted/cached quota is never
 * reused. Not a secret — a truncated SHA-256, safe to persist alongside quota.
 */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuotaEntry = {
  quota: OAuthQuotaSnapshot
  refreshAfter: number // Unix ms — earliest next refresh
  checkedAt: number // when snapshot was fetched
}

export type QuotaManagerOptions = {
  storage: AccountStorage | null
  fetchImpl?: typeof fetch
  now?: () => number
  onMainQuotaFetched?: (
    quota: OAuthQuotaSnapshot,
    checkedAt: number,
    tokenFingerprint: string,
  ) => void
  onApiError?: (error: AccountOperationError) => void
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export class QuotaManager {
  // --- State ---
  private main: QuotaEntry | null = null
  private mainTokenFp: string | null = null
  private fallbacks = new Map<string, QuotaEntry>()
  // Fingerprint of the access token that produced each fallback cache entry, so
  // a re-login (credential change) for the same account id invalidates the
  // stale entry instead of being treated as fresh.
  private fallbackTokenFps = new Map<string, string>()

  // --- Inflight deduplication ---
  private inflightMain: Promise<OAuthQuotaSnapshot> | null = null
  private inflightFallbacks = new Map<string, Promise<OAuthQuotaSnapshot>>()

  // --- Rate-limiting (scoped per route so a fallback 429 never backs off the
  // main account or vice versa) ---
  private mainLastApiError: AccountOperationError | undefined = undefined
  private fallbackApiErrors = new Map<string, AccountOperationError>()

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

    // Seed main quota from persisted storage, bound to the token fingerprint
    // that produced it. refreshMain() drops this seed if the live token's
    // fingerprint differs (main-account switch), preventing stale wrong-account
    // quota from being served during backoff.
    const persisted = getPersistedMainQuota(opts.storage)
    if (persisted) {
      this.main = {
        quota: persisted.quota,
        refreshAfter: getQuotaNextRefreshAt(
          persisted.quota,
          opts.storage,
          persisted.checkedAt,
        ),
        checkedAt: persisted.checkedAt,
      }
      this.mainTokenFp = persisted.tokenFingerprint ?? null
    }

    // Seed backoff state from persisted storage
    const persistedError = opts.storage?.quota?.mainLastQuotaApiError
    if (persistedError && quotaBackoffActive(persistedError, this.now())) {
      this.mainLastApiError = persistedError
    }
  }

  // =========================================================================
  // Get (synchronous, from cache)
  // =========================================================================

  /**
   * Cached main quota entry. Pass the live access token to enforce token
   * binding: if the cached entry was produced by a different token (main
   * account switched), it is dropped and null is returned so the caller
   * refetches for the current account. Called without a token (e.g. for
   * display) it returns whatever is cached.
   */
  getMain(accessToken?: string): QuotaEntry | null {
    if (
      accessToken &&
      this.main &&
      this.mainTokenFp &&
      this.mainTokenFp !== tokenFingerprint(accessToken)
    ) {
      this.main = null
      this.mainTokenFp = null
    }
    return this.main
  }

  /**
   * Cached fallback quota entry. Pass the live access token to enforce token
   * binding: if the entry was produced by a different token (account re-login),
   * it is dropped and null is returned so the caller refetches.
   */
  getFallback(accountId: string, accessToken?: string): QuotaEntry | null {
    if (accessToken) {
      const fp = this.fallbackTokenFps.get(accountId)
      if (fp && fp !== tokenFingerprint(accessToken)) {
        this.fallbacks.delete(accountId)
        this.fallbackTokenFps.delete(accountId)
        return null
      }
    }
    return this.fallbacks.get(accountId) ?? null
  }

  getAllFallbacks(): Map<string, QuotaEntry> {
    return this.fallbacks
  }

  // =========================================================================
  // Set (manual inject — seeding from persisted account.quota on boot)
  // =========================================================================

  setMain(accessToken: string, entry: QuotaEntry): void {
    this.mainTokenFp = tokenFingerprint(accessToken)
    this.main = entry
  }

  setFallback(accountId: string, entry: QuotaEntry): void {
    this.fallbacks.set(accountId, entry)
  }

  // =========================================================================
  // Refresh (async, deduplicated, rate-limited)
  // =========================================================================

  async refreshMain(accessToken: string): Promise<OAuthQuotaSnapshot> {
    // If the main account/token changed, invalidate the cache (including a
    // persisted seed) BEFORE the backoff short-circuit so a different account's
    // stale quota is never returned while the quota API is backed off.
    const fp = tokenFingerprint(accessToken)
    if (this.mainTokenFp && this.mainTokenFp !== fp) {
      this.main = null
      this.mainTokenFp = null
    }

    // Deduplicate — return in-flight promise if already fetching
    if (this.inflightMain) return this.inflightMain

    // Rate-limit — if API recently 429'd, return stale or throw
    if (this.isBackedOff()) {
      if (this.main) return this.main.quota
      throw new Error('Quota API rate-limited — try again later')
    }

    this.inflightMain = this._fetchMain(accessToken)
    return this.inflightMain
  }

  async refreshFallback(
    accountId: string,
    accessToken: string,
  ): Promise<OAuthQuotaSnapshot> {
    // Deduplicate
    const inflight = this.inflightFallbacks.get(accountId)
    if (inflight) return inflight

    // Rate-limit — scoped to THIS fallback account only
    if (this.isFallbackBackedOff(accountId)) {
      const cached = this.fallbacks.get(accountId)
      if (cached) return cached.quota
      throw new Error('Quota API rate-limited — try again later')
    }

    const promise = this._fetchFallback(accountId, accessToken)
    this.inflightFallbacks.set(accountId, promise)
    return promise
  }

  async refreshAllFallbacks(accounts: OAuthAccount[]): Promise<void> {
    const now = this.now()

    for (const account of accounts) {
      if (account.enabled === false) continue
      if (!account.access) continue

      const cached = this.fallbacks.get(account.id)
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
    void this.refreshMain(accessToken).catch(() => {})
  }

  // =========================================================================
  // Staleness queries
  // =========================================================================

  isMainStale(): boolean {
    if (!this.main) return true
    return this.now() >= this.main.refreshAfter
  }

  isFallbackStale(accountId: string, accessToken?: string): boolean {
    // Token-aware: a credential change invalidates the entry (treated as stale).
    const entry = this.getFallback(accountId, accessToken)
    if (!entry) return true
    return this.now() >= entry.refreshAfter
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
  needsRefresh(requestCount: number): boolean {
    return this.isMainStale() || this.shouldRefreshOnRequestCount(requestCount)
  }

  // =========================================================================
  // Config
  // =========================================================================

  updateStorage(storage: AccountStorage | null): void {
    this.storage = storage
  }

  /**
   * Seed fallback cache entries from persisted account.quota data.
   * Only seeds accounts that don't already have a cache entry.
   * Prevents unnecessary API calls when persisted quota is still fresh.
   */
  seedFallbacksFromAccounts(accounts: OAuthAccount[]): void {
    const checkInterval = getQuotaCheckIntervalMs(this.storage)
    for (const account of accounts) {
      if (account.enabled === false) continue
      if (this.fallbacks.has(account.id)) continue
      if (!account.quota) continue
      const checkedAt = Math.max(
        account.quota.five_hour?.checkedAt ?? 0,
        account.quota.seven_day?.checkedAt ?? 0,
      )
      if (checkedAt <= 0) continue
      this.fallbacks.set(account.id, {
        quota: account.quota,
        refreshAfter: checkedAt + checkInterval,
        checkedAt,
      })
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
  isFallbackBackedOff(accountId: string): boolean {
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

  private async _fetchMain(accessToken: string): Promise<OAuthQuotaSnapshot> {
    return this._enqueueApiFetch(async () => {
      try {
        // Re-check backoff inside gate — may have been set by
        // a preceding queued call while we waited
        if (this.isBackedOff()) {
          if (this.main) return this.main.quota
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: 'opencode-main-quota-refresh',
          ttlMs: 30_000,
        })
        if (!fileLock) {
          if (this.main) return this.main.quota
          throw new Error('Quota refresh is already in progress')
        }
        try {
          const quota = await fetchOAuthQuotaSnapshot({
            accessToken,
            fetchImpl: this.fetchImpl,
            now: this.now,
          })
          const now = this.now()
          this.mainTokenFp = tokenFingerprint(accessToken)
          this.main = {
            quota,
            refreshAfter: getQuotaNextRefreshAt(quota, this.storage, now),
            checkedAt: now,
          }
          this.mainLastApiError = undefined
          this.onMainQuotaFetched?.(quota, now, this.mainTokenFp)
          return quota
        } catch (error) {
          this._handleMainFetchError(error)
          throw error
        } finally {
          await fileLock.release()
        }
      } finally {
        this.inflightMain = null
      }
    })
  }

  private async _fetchFallback(
    accountId: string,
    accessToken: string,
  ): Promise<OAuthQuotaSnapshot> {
    return this._enqueueApiFetch(async () => {
      try {
        // Re-check backoff inside gate — scoped to this fallback account
        if (this.isFallbackBackedOff(accountId)) {
          const cached = this.fallbacks.get(accountId)
          if (cached) return cached.quota
          throw new Error('Quota API rate-limited — try again later')
        }
        const quota = await fetchOAuthQuotaSnapshot({
          accessToken,
          fetchImpl: this.fetchImpl,
          now: this.now,
        })
        const now = this.now()
        this.fallbacks.set(accountId, {
          quota,
          refreshAfter: now + getQuotaCheckIntervalMs(this.storage),
          checkedAt: now,
        })
        this.fallbackTokenFps.set(accountId, tokenFingerprint(accessToken))
        this.fallbackApiErrors.delete(accountId)
        return quota
      } catch (error) {
        this._handleFallbackFetchError(accountId, error)
        throw error
      } finally {
        this.inflightFallbacks.delete(accountId)
      }
    })
  }

  // A 401 is an auth/token problem, not a rate limit. The caller refreshes the
  // token and retries; backing off the quota API here would block that retry,
  // so surface 401s without recording backoff state.
  private static isAuthError(error: unknown): boolean {
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
  private _handleFallbackFetchError(accountId: string, error: unknown): void {
    if (QuotaManager.isAuthError(error)) return
    this.fallbackApiErrors.set(
      accountId,
      buildQuotaOperationError({
        error,
        now: this.now(),
        previous: this.fallbackApiErrors.get(accountId),
      }),
    )
  }
}
