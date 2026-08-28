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
  mergeMainQuotaErrorClearedAt,
  quotaBackoffActive,
  quotaSnapshotCheckedAt,
} from './accounts.ts'
import { logger } from './logger.ts'
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
  // Receipt/observation time; current headers expose no authoritative server
  // ordering field, so cross-response ordering is intentionally last-write-wins.
  checkedAt: number
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
    quotaErrorGeneration: number,
    quotaErrorClearedAt: number | undefined,
  ) => void
  onApiError?: (
    error: AccountOperationError,
    quotaErrorGeneration: number,
  ) => void
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
  private mainQuotaIdentityKnown = false
  private mainQuotaIdentityStrict = false
  private mainGeneration = 0
  private mainQuotaErrorGeneration = 0
  private mainQuotaErrorClearedAt: number | undefined
  private fallbacks = new Map<string, QuotaEntry>()
  private fallbackAuthLineages = new Map<string, string | undefined>()
  private fallbackGenerations = new Map<string, number>()

  // --- Inflight deduplication ---
  private inflightMain: Promise<QuotaRefreshResult> | null = null
  private inflightMainAccountId: string | undefined
  private inflightFallbacks = new Map<string, Promise<QuotaRefreshResult>>()

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

    this.seedMainFromStorage(opts.storage, opts.storage?.mainAccountId)
    this.seedMainBackoffFromStorage(opts.storage)
  }

  // =========================================================================
  // Get (synchronous, from cache)
  // =========================================================================

  /**
   * Cached main quota entry, scoped to the account behind the main credential.
   * An unresolved identity keeps a retained cache unverified rather than exposing it.
   */
  getMain(mainAccountId?: string): QuotaEntry | null {
    if (this.mainAccountId !== mainAccountId) return null
    if (
      this.mainQuotaIdentityKnown &&
      this.mainQuotaIdentityStrict &&
      (mainAccountId === undefined ||
        this.main?.quota.accountIdentity !== mainAccountId)
    ) {
      return null
    }
    return this.main
  }

  /**
   * Cached fallback quota entry, scoped to the configured account id.
   */
  getFallback(
    accountId: string,
    account?: Pick<OAuthAccount, 'authLineageId'>,
  ): QuotaEntry | null {
    this.bindFallbackLineage(accountId, account)
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

  /** Bind quota state to the account behind the current main credential. */
  setMainQuotaAccountIdentity(
    accountIdentity: string | undefined,
    strict = true,
  ): number | undefined {
    const previousIdentityKnown = this.mainQuotaIdentityKnown
    const previousAccountIdentity = this.mainAccountId
    const changed =
      !previousIdentityKnown ||
      this.mainAccountId !== accountIdentity ||
      this.mainQuotaIdentityStrict !== strict
    this.mainQuotaIdentityKnown = true
    this.mainQuotaIdentityStrict = strict
    if (!changed) return undefined

    this.mainGeneration += 1
    this.mainAccountId = accountIdentity
    if (
      accountIdentity !== undefined &&
      this.main?.quota.accountIdentity !== accountIdentity
    ) {
      this.main = null
    }
    if (
      accountIdentity !== undefined &&
      this.mainLastApiError &&
      (this.mainLastApiError.accountIdentity !== undefined
        ? this.mainLastApiError.accountIdentity !== accountIdentity
        : previousIdentityKnown &&
          previousAccountIdentity !== undefined &&
          previousAccountIdentity !== accountIdentity)
    ) {
      this.mainLastApiError = undefined
      this.mainQuotaErrorGeneration += 1
      this.mainQuotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
        this.mainQuotaErrorClearedAt,
        this.now(),
      )
      return this.mainQuotaErrorGeneration
    }
    return undefined
  }

  setFallback(
    accountId: string,
    entry: QuotaEntry,
    account: Pick<OAuthAccount, 'authLineageId'> | undefined,
  ): void {
    this.bindFallbackLineage(accountId, account)
    this.fallbacks.set(accountId, entry)
  }

  clearFallback(accountId: string): void {
    this.fallbackGenerations.set(
      accountId,
      (this.fallbackGenerations.get(accountId) ?? 0) + 1,
    )
    this.fallbacks.delete(accountId)
    this.fallbackApiErrors.delete(accountId)
    this.inflightFallbacks.delete(QuotaManager.fallbackInflightKey(accountId))
  }

  pushMainFromHeaders(
    mainAccountId: string | undefined,
    incoming: OAuthQuotaSnapshot,
  ): QuotaEntry {
    const checkedAt = incoming.checkedAt ?? this.now()
    const quota = mergeHeaderQuotaSnapshot(
      this.mainAccountId === mainAccountId &&
        (!this.mainQuotaIdentityKnown ||
          !this.mainQuotaIdentityStrict ||
          this.main?.quota.accountIdentity === mainAccountId)
        ? this.main?.quota
        : undefined,
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
    incoming: OAuthQuotaSnapshot,
    account: Pick<OAuthAccount, 'authLineageId'> | undefined,
  ): QuotaEntry | null {
    if (!this.acceptFallbackQuotaObservation(accountId, account)) return null
    const checkedAt = incoming.checkedAt ?? this.now()
    const quota = mergeHeaderQuotaSnapshot(
      this.fallbacks.get(accountId)?.quota,
      {
        ...incoming,
        accountIdentity: accountId,
      },
    )
    const entry = {
      quota,
      checkedAt,
      refreshAfter: getQuotaNextRefreshAt(quota, this.storage, checkedAt),
    }
    this.fallbacks.set(accountId, entry)
    return entry
  }

  // =========================================================================
  // Refresh (async, deduplicated, rate-limited)
  // =========================================================================

  async refreshMain(
    mainAccountIdOrAccessToken: string | undefined,
    accessToken?: string,
    expectedIdentityGeneration?: number,
  ): Promise<OAuthQuotaSnapshot> {
    const mainAccountId = mainAccountIdOrAccessToken
    const credential = accessToken ?? mainAccountIdOrAccessToken
    if (!credential) throw new Error('Main OAuth access token is unavailable')
    return (
      await this.refreshMainWithMetadata(
        mainAccountId,
        credential,
        expectedIdentityGeneration,
      )
    ).quota
  }

  async refreshMainWithMetadata(
    mainAccountIdOrAccessToken: string | undefined,
    accessToken?: string,
    expectedIdentityGeneration?: number,
  ): Promise<QuotaRefreshResult> {
    const effectiveAccountId = mainAccountIdOrAccessToken
    const credential = accessToken ?? mainAccountIdOrAccessToken
    if (!credential) throw new Error('Main OAuth access token is unavailable')
    if (
      expectedIdentityGeneration !== undefined &&
      (this.mainGeneration !== expectedIdentityGeneration ||
        this.mainAccountId !== effectiveAccountId)
    ) {
      throw new Error('Main quota identity changed before refresh')
    }
    if (this.mainAccountId !== effectiveAccountId) {
      this.main = null
      this.mainAccountId = effectiveAccountId
      if (this.mainQuotaIdentityKnown) this.mainGeneration += 1
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
    const generation = this.mainGeneration
    this.inflightMain = this._fetchMain(
      effectiveAccountId,
      credential,
      generation,
    )
    return this.inflightMain
  }

  async refreshFallback(
    accountId: string,
    accessToken: string,
    account: Pick<OAuthAccount, 'authLineageId'> | undefined,
  ): Promise<OAuthQuotaSnapshot> {
    return (
      await this.refreshFallbackWithMetadata(accountId, accessToken, account)
    ).quota
  }

  async refreshFallbackWithMetadata(
    accountId: string,
    accessToken: string,
    account: Pick<OAuthAccount, 'authLineageId'> | undefined,
  ): Promise<QuotaRefreshResult> {
    this.bindFallbackLineage(accountId, account)
    const inflightKey = QuotaManager.fallbackInflightKey(accountId)
    const inflight = this.inflightFallbacks.get(inflightKey)
    if (inflight) return inflight

    // Rate-limit — scoped to THIS fallback account only
    if (this.isFallbackBackedOff(accountId)) {
      const cached = this.getFallback(accountId)
      if (cached) return { quota: cached.quota, fetched: false }
      throw new Error('Quota API rate-limited — try again later')
    }

    const generation = this.fallbackGenerations.get(accountId) ?? 0
    const promise = this._fetchFallback(
      accountId,
      accessToken,
      generation,
      account,
    )
    this.inflightFallbacks.set(inflightKey, promise)
    void promise.then(
      () => {
        if (this.inflightFallbacks.get(inflightKey) === promise) {
          this.inflightFallbacks.delete(inflightKey)
        }
      },
      () => {
        if (this.inflightFallbacks.get(inflightKey) === promise) {
          this.inflightFallbacks.delete(inflightKey)
        }
      },
    )
    return promise
  }

  async refreshAllFallbacks(accounts: OAuthAccount[]): Promise<void> {
    const now = this.now()

    for (const account of accounts) {
      if (account.enabled === false) continue
      if (!account.access) continue

      this.bindFallbackLineage(account.id, account)
      const cached = this.getFallback(account.id)
      if (cached && now < cached.refreshAfter) continue

      try {
        await this.refreshFallback(account.id, account.access, account)
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
    void this.refreshMain(this.mainAccountId, accessToken).catch(() => {})
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
    if (
      this.mainQuotaIdentityKnown &&
      this.mainQuotaIdentityStrict &&
      (this.mainAccountId === undefined ||
        this.main.quota.accountIdentity !== this.mainAccountId)
    ) {
      return true
    }
    return (
      this.now() >= this.main.refreshAfter ||
      this.scopedWindowIsStale(this.main, modelId)
    )
  }

  isFallbackStale(
    accountId: string,
    _accessToken?: string,
    modelId?: string,
    account?: Pick<OAuthAccount, 'authLineageId'>,
  ): boolean {
    // Keep the unused slot to avoid breaking internal callers that pass modelId
    // third; cached quota is scoped to stable account identity.
    const entry = this.getFallback(accountId, account)
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
    this.seedMainFromStorage(
      storage,
      this.mainQuotaIdentityKnown ? this.mainAccountId : storage?.mainAccountId,
    )
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

    const entry: QuotaEntry = {
      quota: {
        ...persisted.quota,
        ...((!this.mainQuotaIdentityKnown || !this.mainQuotaIdentityStrict) &&
          mainAccountId !== undefined &&
          persisted.accountIdentity === undefined && {
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
    const current =
      this.main &&
      this.mainAccountId === mainAccountId &&
      (!this.mainQuotaIdentityKnown ||
        !this.mainQuotaIdentityStrict ||
        this.main.quota.accountIdentity === mainAccountId)
        ? this.main
        : undefined
    if (
      current &&
      current.checkedAt >= entry.checkedAt &&
      current.quota.source === 'headers' &&
      entry.quota.source === 'poll'
    ) {
      const mergedQuota = mergeHeaderQuotaSnapshot(entry.quota, current.quota)
      this.main = {
        quota: mergedQuota,
        refreshAfter: getQuotaNextRefreshAt(
          mergedQuota,
          storage,
          current.checkedAt,
        ),
        checkedAt: current.checkedAt,
      }
      return
    }
    if (
      this.main &&
      this.mainAccountId === mainAccountId &&
      this.main.checkedAt >= entry.checkedAt
    ) {
      return
    }

    this.main = entry
    if (mainAccountId !== undefined) this.mainAccountId = mainAccountId
  }

  private seedMainBackoffFromStorage(storage: AccountStorage | null): void {
    const persistedError = storage?.quota?.mainLastQuotaApiError
    const persistedIdentity = persistedError?.accountIdentity
    const persistedGeneration =
      typeof storage?.quota?.mainQuotaErrorGeneration === 'number' &&
      Number.isSafeInteger(storage.quota.mainQuotaErrorGeneration) &&
      storage.quota.mainQuotaErrorGeneration >= 0
        ? storage.quota.mainQuotaErrorGeneration
        : undefined
    const persistedClearedAt =
      typeof storage?.quota?.mainQuotaErrorClearedAt === 'number' &&
      Number.isFinite(storage.quota.mainQuotaErrorClearedAt) &&
      storage.quota.mainQuotaErrorClearedAt >= 0
        ? storage.quota.mainQuotaErrorClearedAt
        : undefined
    if (
      persistedClearedAt !== undefined &&
      (this.mainQuotaErrorClearedAt === undefined ||
        persistedClearedAt > this.mainQuotaErrorClearedAt)
    ) {
      this.mainQuotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
        this.mainQuotaErrorClearedAt,
        persistedClearedAt,
      )
      if (
        (!persistedError ||
          (typeof persistedError.checkedAt === 'number' &&
            persistedError.checkedAt <= persistedClearedAt)) &&
        (this.mainLastApiError?.checkedAt === undefined ||
          this.mainLastApiError.checkedAt <= persistedClearedAt)
      ) {
        this.mainLastApiError = undefined
      }
    }
    if (
      persistedGeneration !== undefined &&
      persistedGeneration > this.mainQuotaErrorGeneration
    ) {
      this.mainQuotaErrorGeneration = persistedGeneration
      if (
        !persistedError &&
        (this.mainLastApiError?.checkedAt === undefined ||
          this.mainQuotaErrorClearedAt === undefined ||
          this.mainLastApiError.checkedAt <= this.mainQuotaErrorClearedAt)
      ) {
        this.mainLastApiError = undefined
      }
    }
    if (
      persistedError &&
      (!this.mainQuotaIdentityKnown ||
        persistedIdentity === undefined ||
        persistedIdentity === this.mainAccountId) &&
      (this.mainQuotaErrorClearedAt === undefined ||
        typeof persistedError.checkedAt !== 'number' ||
        persistedError.checkedAt > this.mainQuotaErrorClearedAt) &&
      (this.mainLastApiError?.checkedAt === undefined ||
        persistedError.checkedAt >= this.mainLastApiError.checkedAt) &&
      quotaBackoffActive(persistedError, this.now())
    ) {
      this.mainLastApiError = persistedError
      if (persistedGeneration !== undefined) {
        this.mainQuotaErrorGeneration = persistedGeneration
      }
      return
    }
    if (
      this.mainAccountId !== undefined &&
      this.mainLastApiError?.accountIdentity !== undefined &&
      this.mainLastApiError.accountIdentity !== this.mainAccountId
    ) {
      this.mainLastApiError = undefined
    }
  }

  /**
   * Seed fallback cache entries from persisted account.quota data.
   * Updates older in-memory entries so a fresh quota write from another plugin
   * process prevents redundant checks and stale sidebar writes.
   */
  seedFallbacksFromAccounts(accounts: OAuthAccount[]): void {
    const checkInterval = getQuotaCheckIntervalMs(this.storage)
    const configuredIds = new Set(accounts.map((account) => account.id))
    for (const accountId of this.fallbackAuthLineages.keys()) {
      if (!configuredIds.has(accountId)) {
        this.clearFallback(accountId)
        this.fallbackAuthLineages.delete(accountId)
      }
    }
    for (const account of accounts) {
      const lineageChanged = this.bindFallbackLineage(account.id, account)
      if (lineageChanged) continue
      if (account.enabled === false) continue
      if (!account.quota) continue
      const checkedAt = quotaSnapshotCheckedAt(account.quota)
      if (checkedAt <= 0) continue
      const existing = this.getFallback(account.id)
      if (existing && existing.checkedAt >= checkedAt) continue
      this.setFallback(
        account.id,
        {
          quota: { ...account.quota, accountIdentity: account.id },
          refreshAfter: checkedAt + checkInterval,
          checkedAt,
        },
        account,
      )
    }
  }

  /**
   * Whether the MAIN quota API is currently in backoff. Scoped to the main
   * account — a fallback account's 429 never reports here.
   */
  isBackedOff(): boolean {
    // Unlike cached numbers above, restrictions stay active while identity is
    // ambiguous; only a confirmed account change may release an inherited guard.
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

  getMainQuotaErrorGeneration(): number {
    return this.mainQuotaErrorGeneration
  }

  getMainQuotaIdentityGeneration(): number {
    return this.mainGeneration
  }

  getMainQuotaErrorClearedAt(): number | undefined {
    return this.mainQuotaErrorClearedAt
  }

  clearMainBackoff(): number | undefined {
    if (!this.mainLastApiError) return undefined
    this.mainLastApiError = undefined
    this.mainQuotaErrorGeneration += 1
    this.mainQuotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
      this.mainQuotaErrorClearedAt,
      this.now(),
    )
    return this.mainQuotaErrorGeneration
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

  private bindFallbackLineage(
    accountId: string,
    account: Pick<OAuthAccount, 'authLineageId'> | undefined,
  ): boolean {
    if (!account) return false

    const hadLineage = this.fallbackAuthLineages.has(accountId)
    const previousLineage = this.fallbackAuthLineages.get(accountId)
    const lineageChanged =
      hadLineage &&
      account.authLineageId !== undefined &&
      previousLineage !== account.authLineageId
    if (lineageChanged) this.clearFallback(accountId)
    this.fallbackAuthLineages.set(accountId, account.authLineageId)
    return lineageChanged
  }

  private acceptFallbackQuotaObservation(
    accountId: string,
    account: Pick<OAuthAccount, 'authLineageId'> | undefined,
  ): boolean {
    const hasLineage = this.fallbackAuthLineages.has(accountId)
    const currentLineage = this.fallbackAuthLineages.get(accountId)
    const observedLineage = account?.authLineageId
    if (hasLineage && currentLineage !== observedLineage) {
      logger.trace(
        'quota',
        'skipped stale fallback quota observation after lineage change',
        {
          accountId,
          storedLineage: currentLineage,
          servedLineage: observedLineage,
        },
      )
      return false
    }
    if (!hasLineage) this.fallbackAuthLineages.set(accountId, observedLineage)
    return true
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
    generation: number,
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
        if (
          this.mainQuotaIdentityKnown &&
          this.mainQuotaIdentityStrict &&
          this.mainGeneration !== generation
        ) {
          return {
            quota: { accountIdentity: mainAccountId },
            fetched: false,
          }
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
          if (
            this.mainQuotaIdentityKnown &&
            this.mainQuotaIdentityStrict &&
            this.mainGeneration !== generation
          ) {
            return {
              quota: {
                ...quota,
                ...(mainAccountId !== undefined && {
                  accountIdentity: mainAccountId,
                }),
              },
              fetched: true,
            }
          }
          const completedQuota = mergePollCompletionWithNewerHeaders(
            this.mainAccountId === mainAccountId &&
              (!this.mainQuotaIdentityKnown ||
                !this.mainQuotaIdentityStrict ||
                this.main?.quota.accountIdentity === mainAccountId)
              ? this.main?.quota
              : undefined,
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
          if (this.mainLastApiError) {
            this.mainLastApiError = undefined
            this.mainQuotaErrorGeneration += 1
            this.mainQuotaErrorClearedAt = mergeMainQuotaErrorClearedAt(
              this.mainQuotaErrorClearedAt,
              now,
            )
          }
          this.onMainQuotaFetched?.(
            completedQuota,
            now,
            tokenFingerprint(accessToken),
            fetchStartedAt,
            this.mainQuotaErrorGeneration,
            this.mainQuotaErrorClearedAt,
          )
          return { quota: completedQuota, fetched: true }
        } catch (error) {
          this._handleMainFetchError(error, generation)
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
    generation: number,
    account: Pick<OAuthAccount, 'authLineageId'> | undefined,
  ): Promise<QuotaRefreshResult> {
    return this._enqueueApiFetch(async () => {
      try {
        if ((this.fallbackGenerations.get(accountId) ?? 0) !== generation) {
          return { quota: { accountIdentity: accountId }, fetched: false }
        }
        // Re-check backoff inside gate — scoped to this fallback account
        if (this.isFallbackBackedOff(accountId)) {
          const cached = this.getFallback(accountId, account)
          if (cached) return { quota: cached.quota, fetched: false }
          throw new Error('Quota API rate-limited — try again later')
        }
        const fileLock = await acquireRefreshFileLock({
          name: QuotaManager.quotaLockName(accountId),
          ttlMs: 30_000,
        })
        if (!fileLock) {
          const cached = this.getFallback(accountId, account)
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
          if ((this.fallbackGenerations.get(accountId) ?? 0) !== generation) {
            return {
              quota: { ...quota, accountIdentity: accountId },
              fetched: true,
            }
          }
          const completedQuota = mergePollCompletionWithNewerHeaders(
            this.getFallback(accountId, account)?.quota,
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
            account,
          )
          this.fallbackApiErrors.delete(accountId)
          return { quota: completedQuota, fetched: true }
        } finally {
          await fileLock.release()
        }
      } catch (error) {
        this._handleFallbackFetchError(accountId, error, generation)
        throw error
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
  private _handleMainFetchError(error: unknown, generation: number): void {
    if (this.mainGeneration !== generation) return
    if (
      this.mainQuotaIdentityKnown &&
      this.mainQuotaIdentityStrict &&
      this.mainAccountId === undefined
    ) {
      return
    }
    if (QuotaManager.isAuthError(error)) return
    this.mainLastApiError = buildQuotaOperationError({
      error,
      now: this.now(),
      accountIdentity: this.mainAccountId,
      previous: this.mainLastApiError,
    })
    this.mainQuotaErrorGeneration += 1
    this.onApiError?.(this.mainLastApiError, this.mainQuotaErrorGeneration)
  }

  /**
   * Fallback quota failure: arms backoff for THIS account only. Never touches
   * main backoff state and never calls onApiError (which persists the main
   * quota error) — the per-account error is recorded by the caller via the
   * account's lastQuotaRefreshError.
   */
  private _handleFallbackFetchError(
    accountId: string,
    error: unknown,
    generation: number,
  ): void {
    if ((this.fallbackGenerations.get(accountId) ?? 0) !== generation) return
    if (QuotaManager.isAuthError(error)) return
    const previous = this.fallbackApiErrors.get(accountId)
    this.fallbackApiErrors.set(
      accountId,
      buildQuotaOperationError({
        error,
        now: this.now(),
        previous,
        accountIdentity: accountId,
      }),
    )
  }
}
