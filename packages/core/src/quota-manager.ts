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
  private mainTokenFp: string | null = null
  private fallbacks = new Map<string, QuotaEntry>()
  // Fingerprint of the access token that produced each fallback cache entry, so
  // a re-login (credential change) for the same account id invalidates the
  // stale entry instead of being treated as fresh.
  private fallbackTokenFps = new Map<string, string>()

  // --- Inflight deduplication ---
  private inflightMain: Promise<QuotaRefreshResult> | null = null
  private inflightMainFp: string | null = null
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

    // Seed main quota from persisted storage, bound to the token fingerprint
    // that produced it. refreshMain() drops this seed if the live token's
    // fingerprint differs (main-account switch), preventing stale wrong-account
    // quota from being served during backoff.
    this.seedMainFromStorage(opts.storage)
    this.seedMainBackoffFromStorage(opts.storage)
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
    const entry = this.fallbacks.get(accountId) ?? null
    if (!accessToken || !entry) return entry

    const fp = this.fallbackTokenFps.get(accountId)
    if (fp !== tokenFingerprint(accessToken)) {
      this.fallbacks.delete(accountId)
      this.fallbackTokenFps.delete(accountId)
      return null
    }
    return entry
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

  setFallback(
    accountId: string,
    entry: QuotaEntry,
    accessToken?: string,
  ): void {
    this.fallbacks.set(accountId, entry)
    if (accessToken) {
      this.fallbackTokenFps.set(accountId, tokenFingerprint(accessToken))
    } else {
      this.fallbackTokenFps.delete(accountId)
    }
  }

  pushMainFromHeaders(
    accessToken: string,
    incoming: OAuthQuotaSnapshot,
  ): QuotaEntry {
    const checkedAt = incoming.checkedAt ?? this.now()
    const accessTokenFp = tokenFingerprint(accessToken)
    const quota = mergeHeaderQuotaSnapshot(
      this.mainTokenFp === accessTokenFp ? this.main?.quota : undefined,
      incoming,
    )
    const entry = {
      quota,
      checkedAt,
      refreshAfter: getQuotaNextRefreshAt(quota, this.storage, checkedAt),
    }
    this.setMain(accessToken, entry)
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
      incoming,
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

  async refreshMain(accessToken: string): Promise<OAuthQuotaSnapshot> {
    return (await this.refreshMainWithMetadata(accessToken)).quota
  }

  async refreshMainWithMetadata(
    accessToken: string,
  ): Promise<QuotaRefreshResult> {
    // If the main account/token changed, invalidate the cache (including a
    // persisted seed) BEFORE the backoff short-circuit so a different account's
    // stale quota is never returned while the quota API is backed off.
    const fp = tokenFingerprint(accessToken)
    if (this.mainTokenFp && this.mainTokenFp !== fp) {
      this.main = null
      this.mainTokenFp = null
    }

    // Deduplicate — return in-flight promise only if same token fingerprint
    if (this.inflightMain && this.inflightMainFp === fp)
      return this.inflightMain

    // Rate-limit — if API recently 429'd, return stale or throw
    if (this.isBackedOff()) {
      if (this.main) return { quota: this.main.quota, fetched: false }
      throw new Error('Quota API rate-limited — try again later')
    }

    this.inflightMainFp = fp
    this.inflightMain = this._fetchMain(accessToken)
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
    // Deduplicate per account+token so a same-label re-login never joins a
    // quota probe that was started with the previous credentials.
    const inflightKey = QuotaManager.fallbackInflightKey(accountId, accessToken)
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
    void this.refreshMain(accessToken).catch(() => {})
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
    this.seedMainFromStorage(storage)
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
    accessToken?: string,
  ): void {
    const persisted = getPersistedMainQuota(storage)
    if (!persisted) return

    const accessTokenFp = accessToken ? tokenFingerprint(accessToken) : null
    if (
      accessTokenFp &&
      persisted.tokenFingerprint &&
      persisted.tokenFingerprint !== accessTokenFp
    ) {
      return
    }

    const entry: QuotaEntry = {
      quota: persisted.quota,
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
      (!accessTokenFp ||
        !this.mainTokenFp ||
        this.mainTokenFp === accessTokenFp)
    ) {
      return
    }

    this.main = entry
    this.mainTokenFp = persisted.tokenFingerprint ?? null
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
      const checkedAt = Math.max(
        account.quota.five_hour?.checkedAt ?? 0,
        account.quota.seven_day?.checkedAt ?? 0,
      )
      if (checkedAt <= 0) continue
      const existing = this.getFallback(account.id, account.access)
      if (existing && existing.checkedAt >= checkedAt) continue
      this.setFallback(
        account.id,
        {
          quota: account.quota,
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

  private static fallbackInflightKey(
    accountId: string,
    accessToken: string,
  ): string {
    return JSON.stringify([accountId, tokenFingerprint(accessToken)])
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

  private async _fetchMain(accessToken: string): Promise<QuotaRefreshResult> {
    const thisFetchFp = tokenFingerprint(accessToken)
    return this._enqueueApiFetch(async () => {
      try {
        // Re-check backoff inside gate — may have been set by
        // a preceding queued call while we waited
        if (this.isBackedOff()) {
          if (this.main) return { quota: this.main.quota, fetched: false }
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: 'opencode-main-quota-refresh',
          ttlMs: 30_000,
        })
        if (!fileLock) {
          const cached = this.main
          if (cached && this.now() < cached.refreshAfter) {
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
            this.mainTokenFp === thisFetchFp ? this.main?.quota : undefined,
            quota,
          )
          this.mainTokenFp = tokenFingerprint(accessToken)
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
            this.mainTokenFp,
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
        if (this.inflightMainFp === thisFetchFp) {
          this.inflightMain = null
          this.inflightMainFp = null
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
          const cached = this.getFallback(accountId, accessToken)
          if (cached) return { quota: cached.quota, fetched: false }
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: QuotaManager.quotaLockName(accountId),
          ttlMs: 30_000,
        })
        if (!fileLock) {
          const cached = this.getFallback(accountId, accessToken)
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
            this.getFallback(accountId, accessToken)?.quota,
            quota,
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
          QuotaManager.fallbackInflightKey(accountId, accessToken),
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
