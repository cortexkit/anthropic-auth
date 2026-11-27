import type { MaxSameAccountWait } from './routing.ts'

export const PROMPT_CACHE_DEFAULT_TTL_MS = 5 * 60_000
export const PROMPT_CACHE_1H_TTL_MS = 60 * 60_000

type Activity = {
  accountId: string
  expiresAt: number
  ttlMs: number
}

/** Process-local cache lifetime evidence; failures and waits never extend it. */
export class SessionCacheActivity {
  private readonly entries = new Map<string, Activity>()

  constructor(private readonly maxSessions = 4096) {}

  record(
    sessionId: string,
    accountId: string,
    ttlMs: number | undefined,
    lastAcceptedAt = Date.now(),
  ) {
    if (ttlMs === 0) {
      this.forget(sessionId)
      return
    }
    const lifetimeMs =
      ttlMs && Number.isFinite(ttlMs) && ttlMs > 0
        ? ttlMs
        : PROMPT_CACHE_DEFAULT_TTL_MS
    this.remember(sessionId, {
      accountId,
      expiresAt: lastAcceptedAt + lifetimeMs,
      ttlMs: lifetimeMs,
    })
  }

  private remember(sessionId: string, activity: Activity) {
    this.entries.delete(sessionId)
    this.entries.set(sessionId, activity)
    if (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  holdUntil(
    sessionId: string | null | undefined,
    accountId: string,
    now = Date.now(),
    maxWait: MaxSameAccountWait = '15',
  ): number | undefined {
    if (!sessionId) return undefined
    const activity = this.entries.get(sessionId)
    if (!activity || activity.accountId !== accountId) return undefined
    return Math.min(
      activity.expiresAt,
      maxWait === 'max' ? Infinity : now + Number(maxWait) * 60_000,
    )
  }

  /** Prefer the last accepted account only while its cache can still be warm. */
  warmRetryAccount<T>(
    sessionId: string | null | undefined,
    candidates: readonly T[],
    accountId: (candidate: T) => string,
    now = Date.now(),
  ): T | undefined {
    if (!sessionId) return undefined
    const activity = this.entries.get(sessionId)
    if (!activity || activity.expiresAt <= now) return undefined
    return candidates.find(
      (candidate) => accountId(candidate) === activity.accountId,
    )
  }

  /** Restore only an unexpired cache for a session without newer in-process evidence. */
  seedFromRestore(
    sessionId: string,
    accountId: string,
    restored: { lastAcceptedAt: number; ttlMs: number; cacheExpiresAt: number },
    now = Date.now(),
  ) {
    const { lastAcceptedAt, ttlMs, cacheExpiresAt } = restored
    const expiresAt = Math.min(lastAcceptedAt + ttlMs, cacheExpiresAt)
    if (
      this.entries.has(sessionId) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      expiresAt <= now
    )
      return
    this.remember(sessionId, { accountId, expiresAt, ttlMs })
  }

  /** A late keep-warm send must not replace a newer turn on a different account. */
  recordPrewarm(
    sessionId: string,
    accountId: string,
    acceptedAt = Date.now(),
    ttlMs = PROMPT_CACHE_1H_TTL_MS,
  ) {
    const activity = this.entries.get(sessionId)
    if (activity && activity.accountId !== accountId) return
    this.record(sessionId, accountId, ttlMs, acceptedAt)
  }

  forget(sessionId: string) {
    this.entries.delete(sessionId)
  }

  ttlMs(sessionId: string | null | undefined): number {
    return (
      (sessionId && this.entries.get(sessionId)?.ttlMs) ||
      PROMPT_CACHE_DEFAULT_TTL_MS
    )
  }
}

export const sessionCacheActivity = new SessionCacheActivity()
