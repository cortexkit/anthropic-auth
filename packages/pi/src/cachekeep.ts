import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CacheKeepManager,
  CacheKeepStore,
  type CacheKeepStoreOptions,
  type CacheKeepTarget,
  type HolderLiveness,
  isCacheKeepSubagentsEnabled,
  logger,
  type NativeAccountSnapshot,
  type NativeAccountView,
  nativeAccountCanServe,
  readSessionCachePolicy,
} from '@cortexkit/anthropic-auth-core'
import { version as pluginVersion } from '../package.json'
import { PiCacheKeepClaim } from './cachekeep-claim.ts'

type TrackInput = Parameters<CacheKeepManager['track']>[0]
type ManagerOptions = ConstructorParameters<typeof CacheKeepManager>[0]
type Session = {
  storagePath: string
  claim: PiCacheKeepClaim
  store: CacheKeepStore
  identity?: string
}

function accountKey(account: NativeAccountView) {
  // Token refresh keeps this key; replacing a login changes its credential epoch.
  return JSON.stringify([
    account.source,
    account.accountIdentity,
    account.credentialId,
    account.binding?.storageId,
    account.binding?.rowId,
    account.binding?.credentialEpoch,
  ])
}

/** One Pi process owns only the sessions its lifecycle actually opened. */
export class PiCacheKeep {
  readonly manager: CacheKeepManager
  private readonly stores = new Map<string, Promise<CacheKeepStore>>()
  private readonly sessions = new Map<string, Session>()
  private readonly claims = new Map<string, Promise<Session | undefined>>()
  private readonly starts = new Map<string, Promise<void>>()
  private readonly restored = new Map<string, number>()
  private readonly tracking = new Set<Promise<unknown>>()
  private stopping = false
  private ticking?: Promise<void>
  private cleaning?: Promise<void>
  private cleanupTimer?: ReturnType<typeof setInterval>
  private readonly schedule: typeof setInterval
  private readonly cancel: typeof clearInterval

  constructor(
    managerOptions: ManagerOptions,
    private readonly options: {
      storageId: (storagePath: string) => Promise<string>
      read: (storagePath: string) => Promise<NativeAccountSnapshot>
      persistence?: Partial<Pick<CacheKeepStoreOptions, 'root' | 'ownerOnly'>>
      liveness?: HolderLiveness
      restoreDelay?: (ms: number, signal?: AbortSignal) => Promise<void>
    },
  ) {
    this.managerOptionsNow = managerOptions.now
    const schedule = managerOptions.setIntervalImpl ?? setInterval
    this.schedule = schedule
    this.cancel = managerOptions.clearIntervalImpl ?? clearInterval
    const persistWarm = async (target: Readonly<CacheKeepTarget>) => {
      const session = this.sessions.get(target.id)
      if (this.stopping || !session?.identity) return false
      return session.store.reserveWarm({
        ...target,
        oauthAccountIdentity: session.identity,
      })
    }
    this.manager = new CacheKeepManager({
      ...managerOptions,
      setIntervalImpl: ((_callback: unknown, ms?: number) =>
        schedule(() => {
          this.ticking = this.manager
            .tick()
            .catch(() => logger.warn('cachekeep', 'tick failed'))
          return this.ticking
        }, ms)) as typeof setInterval,
      onTargetChanged: (target) => {
        const session = this.sessions.get(target.id)
        if (session?.identity)
          session.store.changed({
            ...target,
            oauthAccountIdentity: session.identity,
          })
        managerOptions.onTargetChanged?.(target)
      },
      reserveWarm: persistWarm,
      settleWarm: (target) =>
        this.manager.isCurrentTarget(target)
          ? persistWarm(target)
          : Promise.resolve(false),
      onTargetRemoved: (id) => {
        this.restored.delete(id)
        if (!this.stopping) this.sessions.get(id)?.store.removed(id)
        managerOptions.onTargetRemoved?.(id)
      },
      prepareHeaders: async (headers, target, attempt) => {
        // Delay the actual first send, not just its due time: minute ticks can
        // coalesce all overdue sessions after many Pi processes restart.
        const stagger = this.restored.get(target.id)
        this.restored.delete(target.id)
        if (stagger !== undefined) {
          if (this.options.restoreDelay)
            await this.options.restoreDelay(stagger, attempt.signal)
          else await delay(stagger, undefined, { signal: attempt.signal })
          if (target.cacheExpiresAt <= this.now()) return undefined
        }
        if (this.stopping && this.manager.trackedRequest(target.id))
          return undefined
        const session = this.sessions.get(target.id)
        // One-off prewarmNow probes are not restart targets and have no claim.
        if (session?.identity) {
          const snapshot = await this.options.read(session.storagePath)
          const account = snapshot.accounts.find(
            (row) => accountKey(row) === session.identity,
          )
          if (!account || !nativeAccountCanServe(account)) return undefined
        } else if (this.manager.trackedRequest(target.id)) return undefined
        return managerOptions.prepareHeaders
          ? managerOptions.prepareHeaders(headers, target, attempt)
          : headers
      },
    })
  }

  private store(storagePath: string) {
    let store = this.stores.get(storagePath)
    if (!store) {
      store = this.options.storageId(storagePath).then(
        (storageId) =>
          new CacheKeepStore({
            storageId,
            host: 'pi',
            pluginVersion,
            ...this.options.persistence,
            now: () => this.now(),
          }),
      )
      this.stores.set(storagePath, store)
    }
    return store
  }

  private now() {
    return this.managerOptionsNow?.() ?? Date.now()
  }
  private managerOptionsNow?: () => number

  private claim(storagePath: string, sessionId: string) {
    const existing = this.claims.get(sessionId)
    if (existing) return existing
    let claiming: Promise<Session | undefined>
    claiming = (async () => {
      const store = await this.store(storagePath)
      const claim = new PiCacheKeepClaim(store.directory, sessionId, {
        ownerOnly: this.options.persistence?.ownerOnly,
        liveness: this.options.liveness,
      })
      if (!(await claim.acquire())) return undefined
      const session: Session = { storagePath, claim, store }
      this.sessions.set(sessionId, session)
      return session
    })()
      .catch(() => {
        logger.warn(
          'cachekeep',
          'session claim unavailable; not warming session',
        )
        return undefined
      })
      .finally(() => {
        if (
          !this.sessions.has(sessionId) &&
          this.claims.get(sessionId) === claiming
        )
          this.claims.delete(sessionId)
      })
    this.claims.set(sessionId, claiming)
    return claiming
  }

  private async access(
    store: CacheKeepStore,
    hash: string,
    restoreOwn = false,
  ) {
    for (const [id, owned] of this.sessions) {
      if (
        owned.store === store &&
        createHash('sha256').update(id).digest('hex') === hash
      )
        // The manager expires local targets. Cleanup must not race its queued
        // writes; only the initial restore reads a locally claimed record.
        return restoreOwn && !this.manager.trackedRequest(id)
          ? async () => {}
          : undefined
    }
    const cleanup = new PiCacheKeepClaim(store.directory, hash, {
      ...this.options.persistence,
      liveness: this.options.liveness,
      sessionHash: true,
    })
    if (!(await cleanup.acquire())) return undefined
    return () => cleanup.release()
  }

  private startCleanup() {
    if (this.cleanupTimer || this.stopping) return
    // Unresumed sessions have no manager target or timer. Sweep their expired
    // files without adopting them, and never touch another live owner's files.
    this.cleanupTimer = this.schedule(() => {
      this.cleaning ??= (async () => {
        for (const store of this.stores.values()) {
          const current = await store
          await current.load(
            this.now(),
            () => undefined,
            (hash) => this.access(current, hash),
          )
        }
      })()
        .catch(() => logger.warn('cachekeep', 'restart cleanup failed'))
        .finally(() => {
          this.cleaning = undefined
        })
      return this.cleaning
    }, 60_000)
    this.cleanupTimer.unref?.()
  }

  startSession(storagePath: string, sessionId: string) {
    const existing = this.starts.get(sessionId)
    if (existing) return existing
    this.stopping = false
    let completed = false
    let starting: Promise<void>
    starting = (async () => {
      const session = await this.claim(storagePath, sessionId)
      // Even a non-owner may clean up expired records, but cannot restore one.
      const store = await this.store(storagePath)
      const snapshot = session
        ? await this.options.read(storagePath)
        : undefined
      const now = this.now()
      await store.load(
        now,
        (entry) => {
          if (
            !session ||
            entry.id !== sessionId ||
            this.stopping ||
            this.manager.trackedRequest(entry.id)
          )
            return undefined
          if (!snapshot) return 'invalid'
          const account = snapshot.accounts.find(
            (row) => accountKey(row) === entry.oauthAccountIdentity,
          )
          if (!account) return 'foreign-identity'
          if (account.type !== 'oauth' || !nativeAccountCanServe(account))
            return 'account-gone'
          if (
            entry.isSubagent &&
            readSessionCachePolicy(
              entry.policyState?.ownerSessionId ?? entry.id,
              true,
            )?.keep_warm === undefined &&
            !isCacheKeepSubagentsEnabled(snapshot.policyStorage)
          )
            return 'invalid'
          session.identity = accountKey(account)
          const result = this.manager.track({
            sessionId,
            url: entry.url,
            headers: new Headers(),
            bodyText: entry.bodyText,
            storage: snapshot.policyStorage,
            cacheMode: 'hybrid',
            oauthAccountId: account.id,
            oauthAccountIdentity: account.accountIdentity,
            accountStoragePath: storagePath,
            isSubagent: entry.isSubagent,
            retained: {
              ...entry,
              nextPrewarmAt: Math.max(now, entry.nextPrewarmAt),
            },
          })
          if (result.tracked && entry.nextPrewarmAt <= now)
            this.restored.set(entry.id, 1000 + Math.floor(Math.random() * 2000))
          return result.tracked ? true : 'invalid'
        },
        (hash) => this.access(store, hash, true),
      )
      this.startCleanup()
      completed = !!session
    })()
      .catch(() =>
        logger.warn('cachekeep', 'failed to restore tracked session'),
      )
      .finally(() => {
        if (!completed && this.starts.get(sessionId) === starting)
          this.starts.delete(sessionId)
      })
    this.starts.set(sessionId, starting)
    return starting
  }

  trackAccepted(input: TrackInput, snapshot: NativeAccountSnapshot) {
    if (this.stopping || !input.sessionId || !input.accountStoragePath)
      return Promise.resolve()
    const sessionId = input.sessionId
    const storagePath = input.accountStoragePath
    const acceptedAt = this.now()
    const tracking = (async () => {
      const session = await this.claim(storagePath, sessionId)
      if (!session) return
      const account =
        snapshot.accounts.find((row) => row.id === input.oauthAccountId) ??
        snapshot.accounts.find(
          (row) => row.accountIdentity === input.oauthAccountIdentity,
        )
      if (
        account?.type !== 'oauth' ||
        !nativeAccountCanServe(account) ||
        account.accountIdentity !== input.oauthAccountIdentity
      )
        return
      session.identity = accountKey(account)
      // Claim I/O may finish after the response, or even during shutdown. Keep
      // that accepted body, but never grant the cache the time spent waiting.
      const result = this.manager.track({
        ...input,
        acceptedAt,
      })
      if (result.tracked) this.restored.delete(sessionId)
      if (this.stopping) this.manager.stop()
      return result
    })().catch(() =>
      logger.warn('cachekeep', 'accepted response tracking failed'),
    )
    this.tracking.add(tracking)
    void tracking.then(() => this.tracking.delete(tracking))
    return tracking
  }

  async stop() {
    this.stopping = true
    if (this.cleanupTimer) this.cancel(this.cleanupTimer)
    this.cleanupTimer = undefined
    this.manager.stop()
    await Promise.all(this.starts.values())
    await Promise.all(this.claims.values())
    await Promise.all(this.tracking)
    this.manager.stop()
    await this.ticking
    await this.cleaning
    // Drain before releasing claims so a successor can never read an older body.
    for (const store of this.stores.values()) await (await store).drain()
    for (const session of this.manager.trackedSessions())
      this.manager.untrack(session.id)
    for (const session of this.sessions.values()) await session.claim.release()
    this.sessions.clear()
    this.claims.clear()
    this.starts.clear()
    this.stores.clear()
    this.restored.clear()
  }
}
