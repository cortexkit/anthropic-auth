import {
  type AccountStorage,
  getQuotaNextRefreshAt,
  type OAuthQuotaSnapshot,
  quotaSnapshotCheckedAt,
} from './accounts.ts'
import { logger } from './logger.ts'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from './native-quota-codec.ts'
import { createNativeUsagePublisher } from './native-usage-publication.ts'
import type { NativeLocalPoolBinding } from './pool-binding.ts'
import type { QuotaEntry } from './quota-manager.ts'

export type NativeQuotaObservation = {
  lineage: string
  accountUuid: string
  entry: QuotaEntry
  generalExhausted: boolean
  quotaErrorClearedAt?: number
  /**
   * Set on a response-header reading from a host that routes on native
   * snapshots (OpenCode 2). The snapshot overlay then applies it while its
   * detached save is still pending, as it does for poll readings. Header
   * readings without it stay host-owned: OpenCode 1 applies its own routing
   * and display rules to them.
   */
  routeBeforeSave?: boolean
}

export function nativePollQuotaGenerallyExhausted(
  quota: OAuthQuotaSnapshot,
): boolean {
  return (['five_hour', 'seven_day'] as const).some(
    (key) => (quota[key]?.remainingPercent ?? 1) <= 0,
  )
}

export function nativeLocalQuotaLineage(
  binding: NativeLocalPoolBinding & { readonly identity: string },
): string
export function nativeLocalQuotaLineage(
  binding: NativeLocalPoolBinding | undefined,
): string | undefined
export function nativeLocalQuotaLineage(
  binding: NativeLocalPoolBinding | undefined,
) {
  return binding?.identity
    ? JSON.stringify([
        binding.storageId,
        binding.rowId,
        binding.credentialEpoch,
        binding.identity,
      ])
    : undefined
}

/** Shared by header receipt, poll completion, routing and display; contains no credentials. */
export class NativeQuotaObservations extends Map<
  string,
  NativeQuotaObservation
> {
  private readonly publications = createNativeUsagePublisher('quota')

  override set(accountId: string, observation: NativeQuotaObservation): this {
    this.delete(accountId)
    if (this.size >= 1000) {
      const oldest = this.keys().next().value
      if (oldest !== undefined) this.delete(oldest)
    }
    return super.set(accountId, observation)
  }

  quota(
    lineage: string | undefined,
    accountUuid: string | undefined,
    committed: OAuthQuotaSnapshot | undefined,
    storage: AccountStorage,
    now = Date.now(),
  ): { quota: OAuthQuotaSnapshot; clearAt?: number } | undefined {
    if (!lineage || !accountUuid) return undefined
    let result = committed
    let clearAt: number | undefined
    let matched = false
    for (const observation of this.values()) {
      // Headers retain host-owned admission and display rules unless the
      // host asked for them to route before their save lands; otherwise
      // only polls replace the quota exposed by native snapshots before
      // publication.
      if (
        observation.entry.quota.source === 'headers' &&
        observation.routeBeforeSave !== true
      )
        continue
      if (
        observation.lineage !== lineage ||
        observation.accountUuid !== accountUuid ||
        getQuotaNextRefreshAt(
          observation.entry.quota,
          storage,
          observation.entry.checkedAt,
        ) <= now
      )
        continue
      matched = true
      result = fromNativeQuotaMap(
        nativeQuotaCodec.merge(
          result ? toNativeQuotaMap(result) : undefined,
          toNativeQuotaMap(observation.entry.quota),
        ),
      )
      clearAt = Math.max(clearAt ?? 0, observation.quotaErrorClearedAt ?? 0)
    }
    return matched && result ? { quota: result, clearAt } : undefined
  }

  publish(
    accountId: string,
    observation: NativeQuotaObservation,
    write: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<void> {
    const previous = this.get(accountId)
    if (
      !previous ||
      previous.lineage !== observation.lineage ||
      quotaSnapshotCheckedAt(previous.entry.quota) <=
        quotaSnapshotCheckedAt(observation.entry.quota)
    )
      this.set(accountId, observation)
    return this.publications.observe(
      Promise.resolve().then(async () => {
        let kept = false
        let cancelled = false
        try {
          const current = this.get(accountId)
          if (
            current &&
            current.lineage === observation.lineage &&
            quotaSnapshotCheckedAt(current.entry.quota) >
              quotaSnapshotCheckedAt(observation.entry.quota)
          )
            return
          kept = await write(this.publications.signal)
        } catch (error) {
          if (
            this.publications.signal.aborted &&
            error === this.publications.signal.reason
          ) {
            cancelled = true
            throw error
          }
          // A quota bookkeeping failure must not reject a successful poll.
        } finally {
          if (!kept) {
            if (this.get(accountId) === observation) this.delete(accountId)
            if (!cancelled) logger.warn('quota', 'Quota publication discarded')
          }
        }
      }),
    )
  }

  /**
   * Registers a response-header reading before its detached save starts, so
   * routing in this process sees it while the save waits on file locks. A
   * reading older than the one already held for the same credential lineage
   * is not registered, so an older reading never replaces a newer one.
   */
  hold(accountId: string, observation: NativeQuotaObservation): boolean {
    const current = this.get(accountId)
    if (
      current &&
      current.lineage === observation.lineage &&
      quotaSnapshotCheckedAt(current.entry.quota) >
        quotaSnapshotCheckedAt(observation.entry.quota)
    )
      return false
    this.set(accountId, observation)
    return true
  }

  /** Forgets a held reading whose save was refused, unless a later reading already replaced it. */
  forget(accountId: string, observation: NativeQuotaObservation): void {
    if (this.get(accountId) === observation) this.delete(accountId)
  }

  /** Preserve failed-poll persistence while making its lock wait cancellable at shutdown. */
  publishFailure<T>(write: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const pending = write(this.publications.signal)
    void this.publications.observe(pending)
    return pending
  }

  drain(): Promise<void> {
    return this.publications.drain()
  }
}
