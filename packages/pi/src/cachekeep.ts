import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  CacheKeepClaim,
  CacheKeepManager,
  type CacheKeepRealTurn,
  CacheKeepStore,
  type CacheKeepStoreOptions,
  type CacheKeepTarget,
  cacheKeepRestartTarget,
  currentCacheKeepRealTurn,
  type HolderLiveness,
  isCacheKeepSubagentsEnabled,
  logger,
  type NativeAccountSnapshot,
  type NativeAccountView,
  nativeAccountCanServe,
  peekRoutingAccount,
  readSessionCachePolicy,
  remapModelId,
  type StickySessionRouter,
} from '@cortexkit/anthropic-auth-core'
import { version as pluginVersion } from '../package.json'

type TrackInput = Parameters<CacheKeepManager['track']>[0]
type ManagerOptions = ConstructorParameters<typeof CacheKeepManager>[0]
type Session = {
  storagePath: string
  claim: CacheKeepClaim
  store: CacheKeepStore
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

export { accountKey as piCacheKeepAccountKey }

/** One Pi process owns only the sessions its lifecycle actually opened. */
export class PiCacheKeep {
  // A current request outranks restart data that is still being read in the background.
  private readonly realTurns = new Set<string>()
  private readonly turnStarts = new Map<
    string,
    { turn: CacheKeepRealTurn; claimed: boolean }
  >()
  private readonly pendingTurns = new Set<CacheKeepRealTurn>()
  private readonly preservedTurns = new WeakSet<CacheKeepRealTurn>()
  readonly manager: CacheKeepManager
  private readonly stores = new Map<string, Promise<CacheKeepStore>>()
  private readonly sessions = new Map<string, Session>()
  private readonly claims = new Map<string, Promise<Session | undefined>>()
  private readonly starts = new Map<string, Promise<void>>()
  private readonly restored = new Map<string, number>()
  private readonly tracking = new Set<Promise<unknown>>()
  private stopping = false
  private cleaning?: Promise<void>
  private cleanupTimer?: ReturnType<typeof setInterval>
  private readonly schedule: typeof setInterval
  private readonly cancel: typeof clearInterval

  constructor(
    managerOptions: ManagerOptions,
    private readonly options: {
      storageId: (storagePath: string) => Promise<string>
      read: (storagePath: string) => Promise<NativeAccountSnapshot>
      routing?: (storagePath: string) => {
        snapshot: NativeAccountSnapshot | undefined
        router?: StickySessionRouter
      }
      persistence?: Partial<Pick<CacheKeepStoreOptions, 'root' | 'ownerOnly'>>
      liveness?: HolderLiveness
      restoreDelay?: (ms: number, signal?: AbortSignal) => Promise<void>
    },
  ) {
    this.managerOptionsNow = managerOptions.now
    const schedule = managerOptions.setIntervalImpl ?? setInterval
    this.schedule = schedule
    this.cancel = managerOptions.clearIntervalImpl ?? clearInterval
    const persisted = (target: Readonly<CacheKeepTarget>) => {
      const entry = cacheKeepRestartTarget(target)
      const identity = target.sourceWarm
        ? entry?.oauthAccountIdentity
        : target.hostMetadata?.accountIdentity
      return entry && typeof identity === 'string'
        ? { ...entry, oauthAccountIdentity: identity }
        : undefined
    }
    const persistWarm = async (target: Readonly<CacheKeepTarget>) => {
      const entry = persisted(target)
      if (!cacheKeepRestartTarget(target)) return true
      const session = entry && this.sessions.get(entry.id)
      if (this.stopping || !session || !entry) return 'not-owner' as const
      return session.store.reserveWarm(entry)
    }
    this.manager = new CacheKeepManager({
      ...managerOptions,
      peekRoutingAccount: (target, route) => {
        // Core checks the source route, not the live template's target model.
        if (target.sourceWarm) return undefined
        const session = this.sessions.get(route.sessionId)
        const routing = this.options.routing?.(
          session?.storagePath ?? target.accountStoragePath ?? '',
        )
        return routing
          ? peekRoutingAccount({
              ...routing,
              ...route,
              modelId: route.modelId ? remapModelId(route.modelId) : undefined,
            })
          : managerOptions.peekRoutingAccount?.(target, route)
      },
      onTargetChanged: (target) => {
        const entry = persisted(target)
        const session = entry && this.sessions.get(entry.id)
        if (session && entry) session.store.changed(entry)
        managerOptions.onTargetChanged?.(target)
      },
      reserveWarm: persistWarm,
      settleWarm: (target) =>
        this.manager.isCurrentTarget(target)
          ? persistWarm(target)
          : Promise.resolve(false),
      onTargetRemoved: (id, target) => {
        this.restored.delete(id)
        const entry = cacheKeepRestartTarget(target)
        if (entry)
          this.sessions.get(entry.id)?.store.removed(persisted(target) ?? entry)
        managerOptions.onTargetRemoved?.(id, target)
      },
      prepareHeaders: async (headers, target, attempt, isTargetCurrent) => {
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
        attempt.signal?.throwIfAborted()
        if (this.stopping && this.manager.trackedRequest(target.id))
          return undefined
        const session = this.sessions.get(target.id)
        const identity = target.hostMetadata?.accountIdentity
        // One-off prewarmNow probes are not restart targets and have no claim.
        if (session && typeof identity === 'string') {
          const snapshot = await this.options.read(session.storagePath)
          const account = snapshot.accounts.find(
            (row) => accountKey(row) === identity,
          )
          if (!account || !nativeAccountCanServe(account)) return undefined
        } else if (!target.sourceWarm && this.manager.trackedRequest(target.id))
          return undefined
        return managerOptions.prepareHeaders
          ? managerOptions.prepareHeaders(
              headers,
              target,
              attempt,
              isTargetCurrent,
            )
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
            externalClaim: (id) => {
              const session = this.sessions.get(id)
              return session?.storagePath === storagePath
                ? session.claim
                : undefined
            },
            onClaimLost: (id) => this.dropClaimTarget(id),
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

  private dropClaimTarget(sessionId: string) {
    this.sessions.delete(sessionId)
    this.claims.delete(sessionId)
    this.starts.delete(sessionId)
    this.restored.delete(sessionId)
    this.manager.releaseTarget(sessionId)
    this.manager.releaseSourceWarm(sessionId)
  }

  private claim(
    storagePath: string,
    sessionId: string,
    realTurn = false,
  ): Promise<Session | undefined> {
    const existing = this.claims.get(sessionId)
    if (existing) {
      if (!realTurn) return existing
      return existing
        .then(async (session) => {
          if (!session) return this.claim(storagePath, sessionId, true)
          if (await session.claim.promote()) return session
          if (this.claims.get(sessionId) !== existing)
            return this.claim(storagePath, sessionId, true)
          if (session.claim.wasDeleted) {
            this.dropClaimTarget(sessionId)
            return undefined
          }
          // A peer may already have released the claim it took from this restore.
          this.sessions.delete(sessionId)
          this.claims.delete(sessionId)
          const acquired = await this.claim(storagePath, sessionId, true)
          if (!acquired && !this.claims.has(sessionId))
            this.dropClaimTarget(sessionId)
          return acquired
        })
        .catch(() => {
          logger.warn(
            'cachekeep',
            'session claim unavailable; not warming session',
          )
          return undefined
        })
    }
    let claiming: Promise<Session | undefined>
    claiming = (async () => {
      const store = await this.store(storagePath)
      const claim = new CacheKeepClaim(store.directory, sessionId, {
        ownerOnly: this.options.persistence?.ownerOnly,
        liveness: this.options.liveness,
      })
      if (!(await claim.acquire(!realTurn))) return undefined
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
          ? Object.assign(async () => {}, {
              canRemove: async () =>
                (await owned.claim.isCurrent()) &&
                !this.manager.trackedRequest(id),
              withCurrent: (action: () => Promise<void>) =>
                owned.claim.withCurrent(async (assertOwned) => {
                  if (this.manager.trackedRequest(id)) return
                  await assertOwned()
                  await action()
                }),
            })
          : undefined
    }
    const cleanup = new CacheKeepClaim(store.directory, hash, {
      ...this.options.persistence,
      liveness: this.options.liveness,
      sessionHash: true,
    })
    if (!(await cleanup.acquire())) return undefined
    const canRemove = async () =>
      (await cleanup.isCurrent()) &&
      !this.stopping &&
      ![...this.claims.keys()].some(
        (id) => createHash('sha256').update(id).digest('hex') === hash,
      ) &&
      ![...this.sessions.keys()].some(
        (id) => createHash('sha256').update(id).digest('hex') === hash,
      )
    if (!(await canRemove())) {
      await cleanup.releaseEventually()
      return undefined
    }
    return Object.assign(() => cleanup.releaseEventually(), { canRemove })
  }

  private startCleanup() {
    if (this.cleanupTimer || this.stopping) return
    // Unresumed sessions have no manager target or timer. Sweep their expired
    // files without adopting them, and never touch another live owner's files.
    this.cleanupTimer = this.schedule(() => {
      this.cleaning ??= (async () => {
        for (const store of this.stores.values()) {
          const current = await store
          const now = this.now()
          await current.load(
            now,
            (entry) => (entry.cacheExpiresAt <= now ? 'expired' : undefined),
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
          if (this.manager.trackedRequest(entry?.id)) return undefined
          if (this.realTurns.has(entry.id)) return 'invalid'
          if (this.stopping) return undefined
          if (entry.cacheExpiresAt <= now) return 'expired'
          if (!session || entry.id !== sessionId) return undefined
          if (!snapshot) return 'invalid'
          const account = snapshot.accounts.find(
            (row) => accountKey(row) === entry.oauthAccountIdentity,
          )
          if (!account) return 'foreign-identity'
          if (account.type !== 'oauth' || !nativeAccountCanServe(account))
            return 'account-gone'
          if (entry.refusalSourceModel !== undefined) return 'invalid'
          if (
            entry.isSubagent &&
            !entry.policyState?.planned &&
            readSessionCachePolicy(
              entry.policyState?.ownerSessionId ?? entry.id,
              true,
            )?.keep_warm === undefined &&
            !isCacheKeepSubagentsEnabled(snapshot.policyStorage)
          )
            return 'invalid'
          const result = this.manager.track({
            sessionId,
            url: entry.url,
            headers: new Headers(),
            bodyText: entry.bodyText,
            storage: snapshot.policyStorage,
            cacheMode: 'hybrid',
            oauthAccountId: account.id,
            oauthAccountIdentity: account.accountIdentity,
            hostMetadata: {
              accountIdentity: accountKey(account),
            },
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
      if (!this.stopping && this.manager.trackedCount()) this.manager.start()
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

  realTurn(sessionId: string) {
    this.realTurns.add(sessionId)
    const session = this.sessions.get(sessionId)
    if (session && !this.stopping) {
      // Shutdown must join a detached promotion before releasing its token;
      // otherwise the promotion could reopen a claim for a stopped keeper.
      const promoting = this.claim(session.storagePath, sessionId, true)
      this.tracking.add(promoting)
      void promoting.then(() => this.tracking.delete(promoting))
    }
    try {
      const previous = this.turnStarts.get(sessionId)
      if (previous && !previous.claimed) this.finishTurn(previous.turn)
      const turn = this.manager.beginRealTurn(sessionId)
      this.turnStarts.set(sessionId, { turn, claimed: false })
      return turn
    } catch {
      return undefined
    }
  }

  requestTurn(sessionId: string) {
    const pending = this.turnStarts.get(sessionId)
    if (pending && !pending.claimed && pending.turn.active) {
      pending.claimed = true
      return pending.turn
    }
    const turn = this.realTurn(sessionId)
    const entry = this.turnStarts.get(sessionId)
    if (entry) entry.claimed = true
    return turn
  }

  endTurn(sessionId: string) {
    const pending = this.turnStarts.get(sessionId)
    this.turnStarts.delete(sessionId)
    try {
      if (pending && !pending.claimed) this.finishTurn(pending.turn)
    } catch {}
  }

  finishTurn(turn: CacheKeepRealTurn | undefined) {
    try {
      if (turn && !this.pendingTurns.has(turn)) {
        if (this.preservedTurns.has(turn)) turn.pause()
        else turn.finish()
      }
    } catch {}
  }

  preserveTurn(turn: CacheKeepRealTurn | undefined) {
    if (turn) this.preservedTurns.add(turn)
  }

  trackAccepted(
    input: TrackInput,
    snapshot: NativeAccountSnapshot,
    requestTurn?: CacheKeepRealTurn,
    isFresh: () => boolean = () => true,
    prepare?: (bodyText: string) => Promise<string>,
  ) {
    let turn = requestTurn ?? currentCacheKeepRealTurn()
    try {
      turn ??= input.sessionId ? this.requestTurn(input.sessionId) : undefined
    } catch {}
    if (this.stopping || !input.sessionId || !input.accountStoragePath) {
      try {
        turn?.finish()
      } catch {}
      return Promise.resolve()
    }
    const sessionId = input.sessionId
    const storagePath = input.accountStoragePath
    const acceptedAt = this.now()
    if (turn) this.pendingTurns.add(turn)
    const tracking = (async () => {
      const bodyText = prepare ? await prepare(input.bodyText) : input.bodyText
      if (!isFresh()) return
      const session = await this.claim(storagePath, sessionId, true)
      if (!session || !isFresh()) return
      const account =
        snapshot.accounts.find((row) => row.id === input.oauthAccountId) ??
        snapshot.accounts.find(
          (row) => row.accountIdentity === input.oauthAccountIdentity,
        )
      if (
        account?.type !== 'oauth' ||
        !nativeAccountCanServe(account) ||
        account.accountIdentity !== input.oauthAccountIdentity
      ) {
        return
      }
      // Claim I/O may finish after the response, or even during shutdown. Keep
      // that accepted body, but never grant the cache the time spent waiting.
      const result = turn?.track({
        ...input,
        bodyText,
        acceptedAt,
        hostMetadata: {
          ...input.hostMetadata,
          accountIdentity: accountKey(account),
        },
      })
      if (result?.tracked) this.restored.delete(sessionId)
      if (this.stopping) this.manager.stop()
      return result
    })()
      .finally(() => {
        if (turn) this.pendingTurns.delete(turn)
        this.finishTurn(turn)
      })
      .catch(() =>
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
    this.manager.abortWarms()
    await Promise.all(this.starts.values())
    await Promise.all(this.claims.values())
    await Promise.all(this.tracking)
    this.manager.stop()
    await this.manager.drain()
    await this.cleaning
    // Drain before releasing claims so a successor can never read an older body.
    for (const store of this.stores.values()) await (await store).drain()
    for (const session of this.sessions.values())
      await session.claim.releaseEventually()
    await this.manager.dispose()
    this.realTurns.clear()
    this.turnStarts.clear()
    this.pendingTurns.clear()
    this.sessions.clear()
    this.claims.clear()
    this.starts.clear()
    this.stores.clear()
    this.restored.clear()
  }
}
