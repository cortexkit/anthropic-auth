import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type AnthropicBillingWarming,
  type CacheKeepFailureStage,
  CacheKeepManager,
  type CacheKeepPrewarmAttempt,
  CacheKeepPrewarmError,
  type CacheKeepRealTurn,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  CacheKeepWarmRefusal,
  claudeGatewayModelUrl,
  currentCacheKeepRealTurn,
  getCacheKeepRegistryDirectories,
  isCacheKeepActiveNow,
  isCacheKeepHybridActive,
  isCacheKeepSubagentsEnabled,
  isCacheKeepWarmWait,
  localMessageThreadCredential,
  logger,
  NativeAccountRefusal,
  type NativeAccountRefusalReason,
  type NativeAccountRuntime,
  type NativeAccountView,
  nativeAccountCanServe,
  nativeAccountRefusal,
  RecoveryThinkingStore,
  type RefusalFallbackCacheRoute,
  RefusalFallbackRoundEngine,
  readSessionCachePolicy,
  requestCacheLifetimeMs,
  sessionCacheActivity,
} from '@cortexkit/anthropic-auth-core'
import type { Attempt, RequestScope } from '@cortexkit/common-auth/opencode2'
import { createRefusalRoundNotices } from '../refusal-round-notices'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
} from './adapter'
import { CacheKeepStore, type CacheKeepStoreOptions } from './cachekeep-store'
import type {
  NativeCacheRequestPrepared,
  NativeSource,
  NativeSourceProvenance,
} from './source'

const warmResponseLifetimes = new WeakMap<Response, number>()

export interface NativeCacheKeepOptions {
  readonly now?: () => number
  readonly setIntervalImpl?: typeof globalThis.setInterval
  readonly clearIntervalImpl?: typeof globalThis.clearInterval
  readonly setTimeoutImpl?: typeof globalThis.setTimeout
  readonly clearTimeoutImpl?: typeof globalThis.clearTimeout
  readonly delayImpl?: typeof delay
  readonly registryDirectory?: string
  /** Filesystem seam for tests; this is not a user setting. */
  readonly persistence?: Omit<CacheKeepStoreOptions, 'storageId'>
}

// Token refreshes preserve this identity; replacing a local row or a vault
// credential does not. Never warm a previous login's prefix on its replacement.
function accountKey(account: NativeAccountView) {
  return JSON.stringify([
    account.source,
    account.accountIdentity,
    account.credentialId,
    account.binding?.storageId,
    account.binding?.rowId,
    account.binding?.credentialEpoch,
  ])
}

function missingAccountReason(
  identity: string | undefined,
  accounts: readonly NativeAccountView[],
): 'foreign-identity' | 'account-gone' {
  if (!identity) return 'foreign-identity'
  try {
    const key = JSON.parse(identity)
    if (!Array.isArray(key)) return 'foreign-identity'
    const [source, , credentialId, storageId, rowId] = key
    if (
      source === 'local' &&
      typeof storageId === 'string' &&
      typeof rowId === 'string'
    )
      return accounts.some(
        (row) =>
          row.binding?.storageId === storageId && row.binding.rowId === rowId,
      )
        ? 'foreign-identity'
        : 'account-gone'
    if (source === 'vault' && typeof credentialId === 'string')
      return accounts.some((row) => row.credentialId === credentialId)
        ? 'foreign-identity'
        : 'account-gone'
  } catch {
    // A malformed identity must not be matched to a different login.
  }
  return 'foreign-identity'
}

type CacheKeepPolicyStorage = Awaited<
  ReturnType<NativeAccountRuntime['read']>
>['policyStorage']

/**
 * One plugin instance's lease on a shared CacheKeep. Prewarms run through the
 * newest live lease, so each send reads policy and authorization from a plugin
 * instance that OpenCode has not disposed.
 */
interface CacheKeepLease {
  readonly generation: number
  readonly runtime: NativeAccountRuntime
  stopped: boolean
  readonly loadStorage: () => Promise<CacheKeepPolicyStorage>
  readonly send: (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
    onResponseHeaders?: () => void,
  ) => Promise<Response>
  /** Sends this lease started; its disposal waits for them to settle. */
  readonly inflight: Set<Promise<unknown>>
  readonly read: NativeAccountRuntime['read']
  readonly subagent?: (sessionID: string) => boolean | undefined
}

/**
 * Tracked sessions for one account storage, shared by directories using the
 * same plugin module. OpenCode replaces each directory's activation separately,
 * so different modules can be live at the same time.
 */
interface SharedCacheKeep {
  readonly manager: CacheKeepManager
  readonly rounds: RefusalFallbackRoundEngine
  readonly roundNotices: ReturnType<typeof createRefusalRoundNotices>
  readonly roundRoutes: Map<string, RefusalFallbackCacheRoute>
  readonly roundRuntime: () => NativeAccountRuntime | undefined
  readonly registry: CacheKeepSessionRegistry
  readonly persistence: CacheKeepStore
  loading?: Promise<void>
  // Forget and deletion must not let a scan already in progress revive a session.
  removedDuringRestore?: Set<string>
  readonly prepared: Map<
    number,
    {
      target: CacheKeepTarget
      attempt: CacheKeepPrewarmAttempt
      lease: CacheKeepLease
    }
  >
  /** Live leases by generation, in the order they were taken. */
  readonly leases: Map<number, CacheKeepLease>
  unwatchClaimAvailable?: () => void
  nextGeneration: number
  /** The scheduler pass in progress, so the last release can wait for it. */
  ticking?: Promise<void>
  /** Called after the last lease is released. */
  readonly retain: () => void | Promise<void>
  /** Called when a lease is taken; resumes warming any retained sessions. */
  readonly adopt: () => Promise<void>
  hybridDisabled?: boolean
  localCleanup?: Promise<void>
}

function discardLocalTargets(
  shared: SharedCacheKeep,
  now: (() => number) | undefined,
  disabled: boolean,
) {
  if (!disabled) {
    shared.hybridDisabled = false
    return
  }
  const controlled = (id: string) =>
    readSessionCachePolicy(id, true)?.keep_warm !== undefined
  for (const session of shared.manager.trackedSessions()) {
    if (!controlled(session.id) && !shared.manager.hasPlannedTarget(session.id))
      shared.manager.untrack(session.id, 'disabled')
  }
  if (shared.hybridDisabled) return
  shared.hybridDisabled = true
  const persistence = shared.persistence
  // Sweep only records we can claim. Another server may still be warming its
  // sessions, and a saved session with an explicit policy can stay on disk.
  shared.localCleanup = (shared.localCleanup ?? Promise.resolve())
    .then(async () => {
      await persistence.drain()
      await persistence.load(
        now?.() ?? Date.now(),
        (entry) =>
          entry.policyState?.planned ||
          controlled(entry.policyState?.ownerSessionId ?? entry.id)
            ? undefined
            : 'invalid',
        undefined,
        () => !!shared.hybridDisabled,
        'sweep',
      )
    })
    .catch(() => logger.warn('cachekeep', 'local restart cleanup failed'))
}

// Different modules coordinate through the restart claims, not through one
// another's schedulers. Older installers must not find and reuse these keepers.
const cacheKeepModule = Symbol()
const SHARED_CACHE_KEEPS = Symbol.for(
  'cortexkit.anthropic-auth.opencode2.cachekeep.v3',
)

function sharedCacheKeeps() {
  const scope = globalThis as typeof globalThis & {
    [SHARED_CACHE_KEEPS]?: Map<string, Map<symbol, SharedCacheKeep>>
  }
  scope[SHARED_CACHE_KEEPS] ??= new Map()
  return scope[SHARED_CACHE_KEEPS]
}

const sessionHash = (id: string) =>
  createHash('sha256').update(id).digest('hex')

function createSharedCacheKeep(
  storageId: string,
  options: NativeCacheKeepOptions,
): SharedCacheKeep {
  const prepared: SharedCacheKeep['prepared'] = new Map()
  const leases: SharedCacheKeep['leases'] = new Map()
  const restored = new Set<string>()
  const restoreAfterTurn = new Map<string, Set<string>>()
  let lastRestoredSend = 0
  let retaining: Promise<void> | undefined
  const persistence = new CacheKeepStore({
    storageId,
    now: options.now,
    ...options.persistence,
    sessionClaims: true,
    restoreNewestFirst: true,
    onClaimLost(id) {
      restored.delete(id)
      manager.releaseTarget(id)
    },
  })
  const registry = new CacheKeepSessionRegistry({
    ...getCacheKeepRegistryDirectories('opencode', options.registryDirectory),
    now: options.now,
  })
  const newestLease = () => {
    let newest: CacheKeepLease | undefined
    for (const lease of leases.values()) newest = lease
    return newest
  }
  const schedule = options.setIntervalImpl ?? globalThis.setInterval
  const manager: CacheKeepManager = new CacheKeepManager({
    loadStorage: async () => {
      const lease = newestLease()
      const storage = lease ? await lease.loadStorage() : null
      if (lease && !lease.stopped)
        discardLocalTargets(
          shared,
          options.now,
          !isCacheKeepHybridActive(storage),
        )
      return storage
    },
    now: options.now,
    // Return the tick's promise from the timer callback, so an injected timer
    // can await the scheduled pass; the last release also waits for it.
    setIntervalImpl: ((_callback: unknown, ms: number | undefined) =>
      schedule(() => {
        const pass = manager.tick()
        shared.ticking = pass.catch(() => {
          logger.warn('cachekeep', 'tick failed')
        })
        return shared.ticking
      }, ms)) as typeof globalThis.setInterval,
    clearIntervalImpl: options.clearIntervalImpl,
    setTimeoutImpl: options.setTimeoutImpl,
    clearTimeoutImpl: options.clearTimeoutImpl,
    reserveWarm: (target) =>
      target.sourceWarm
        ? Promise.resolve(true)
        : shared.persistence.reserveWarm(target),
    settleWarm: (target) =>
      target.sourceWarm
        ? Promise.resolve(true)
        : manager.isCurrentTarget(target)
          ? shared.persistence.reserveWarm(target)
          : Promise.resolve(false),
    deferWarmReservation: true,
    responseTtlMs: (response) => warmResponseLifetimes.get(response),
    onTargetChanged: (target) => {
      if (!target.sourceWarm)
        shared.persistence.changed(target, !manager.isRestoredTarget(target))
    },
    onTargetRemoved: (id, target) => {
      restored.delete(id)
      if (!target.sourceWarm) shared.persistence.removed(target)
    },
    onRealTurnsSettled: (id) => {
      const deferred = restoreAfterTurn.get(id)
      restoreAfterTurn.delete(id)
      if (
        deferred &&
        leases.size &&
        [...deferred].some((targetId) => !manager.trackedRequest(targetId))
      )
        void shared.adopt()
    },
    // While no instance is live the sessions are only retained, not warmed,
    // so the shared session list for the status menu shows none of them.
    onTrackedSessionsChanged: (sessions) =>
      registry.publish(leases.size === 0 ? [] : sessions),
    prepareHeaders(_headers, target, attempt) {
      // Bind each prewarm to the newest live instance when it is prepared, so
      // it never authorizes through an instance OpenCode already disposed.
      const lease = newestLease()
      if (!lease) return undefined
      prepared.set(attempt.id, { target, attempt, lease })
      return new Headers({ 'x-native-cachekeep-attempt': String(attempt.id) })
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input as Request, init)
      const id = Number(request.headers.get('x-native-cachekeep-attempt'))
      const entry = prepared.get(id)
      prepared.delete(id)
      if (!entry || entry.lease.stopped)
        throw new Error('CacheKeep attempt is unavailable')
      // Even if a busy scheduler first runs after several targets became due,
      // restored sessions must not all hit the provider together.
      if (restored.delete(entry.target.id)) {
        const now = options.now?.() ?? Date.now()
        const startAt = Math.max(now, lastRestoredSend + 3000)
        lastRestoredSend = startAt
        await (options.delayImpl ?? delay)(
          Math.max(0, startAt - now),
          undefined,
          {
            signal: entry.attempt.signal,
          },
        )
      }
      const sending = entry.lease.send(
        entry.target,
        request as Request,
        entry.attempt.signal,
        entry.attempt.onResponseHeaders,
      )
      const settled = sending.then(
        () => {},
        () => {},
      )
      entry.lease.inflight.add(settled)
      void settled.then(() => entry.lease.inflight.delete(settled))
      return sending
    }) as typeof fetch,
    onComplete: ({ attempt }) => {
      prepared.delete(attempt.id)
    },
  })
  // If there is no usable restart store, keep the in-memory targets across
  // directory eviction. They cannot warm without a live lease.
  let expiry: ReturnType<typeof setTimeout> | undefined
  const thinkingStore = new RecoveryThinkingStore()
  const roundNotices = createRefusalRoundNotices()
  let retainedUntil = 0
  const stopExpiry = () => {
    if (expiry !== undefined) clearTimeout(expiry)
    expiry = undefined
  }
  const dropExpired = () => {
    stopExpiry()
    if (leases.size > 0) return
    const now = options.now?.() ?? Date.now()
    const earliest =
      manager.dropExpiredTargets() ??
      (retainedUntil > now ? retainedUntil : undefined)
    if (earliest === undefined) {
      const shareds = sharedCacheKeeps()
      const copies = shareds.get(storageId)
      if (copies?.get(cacheKeepModule) === shared) {
        copies.delete(cacheKeepModule)
        if (!copies.size) shareds.delete(storageId)
        void thinkingStore.close()
      }
      return
    }
    expiry = setTimeout(dropExpired, Math.max(0, earliest - now))
    if (typeof expiry === 'object' && 'unref' in expiry) expiry.unref()
  }
  const shared: SharedCacheKeep = {
    manager,
    // A reload keeps the round engine with the manager that warms its sessions.
    rounds: new RefusalFallbackRoundEngine(roundNotices.observe, {
      thinkingStore,
      cacheKeep: manager,
      now: options.now,
    }),
    roundNotices,
    roundRoutes: new Map(),
    roundRuntime: () => newestLease()?.runtime,
    registry,
    persistence,
    prepared,
    leases,
    nextGeneration: 0,
    retain() {
      manager.stop()
      manager.abortWarms()
      prepared.clear()
      const loading = shared.loading
      const retainingTargets = (async () => {
        await manager.drain()
        await loading
        await shared.localCleanup
        await shared.persistence.drain()
        if (leases.size === 0 && !shared.persistence.isMemoryOnly) {
          // Once the claim is released, only the disk record is authoritative:
          // another server may spend its budget, replace it, or delete it.
          const retained = new Set<string>()
          for (const { id, cacheExpiresAt } of manager.trackedSessions()) {
            if (!shared.persistence.isCommitted(id)) {
              retained.add(sessionHash(id))
              continue
            }
            retainedUntil = Math.max(retainedUntil, cacheExpiresAt)
            manager.releaseTarget(id)
            restored.delete(id)
          }
          await shared.persistence.releaseClaims((hash) => !retained.has(hash))
        }
        dropExpired()
      })().finally(() => {
        if (retaining === retainingTargets) retaining = undefined
      })
      retaining = retainingTargets
      return retainingTargets
    },
    async adopt() {
      const retained = retaining
      const previousScan = shared.loading
      shared.removedDuringRestore ??= new Set<string>()
      const removed = shared.removedDuringRestore
      // A directory's previous activation may have just released sessions.
      // Queue a new scan even if this keeper already has other live leases.
      const loading = (async () => {
        await previousScan
        await retained
        stopExpiry()
        retainedUntil = 0
        const lease = newestLease()
        if (!lease) return
        const snapshot = await lease.read()
        const now = options.now?.() ?? Date.now()
        let overdue = 0
        await shared.persistence.load(
          now,
          (entry, acceptedAt) => {
            // Disposal may race startup. Leave the file for the next live lease.
            if (
              !leases.size ||
              removed.has(sessionHash(entry.id)) ||
              manager.trackedRequest(entry.id)
            )
              return undefined
            // A failed foreground turn can retire both its own target and
            // targets it owns. Retry after whichever turn prevents adoption.
            const ownerId = entry.policyState?.ownerSessionId ?? entry.id
            const turnId = manager.hasRealTurn(entry.id) ? entry.id : ownerId
            if (manager.hasRealTurn(turnId)) {
              const deferred = restoreAfterTurn.get(turnId) ?? new Set<string>()
              deferred.add(entry.id)
              restoreAfterTurn.set(turnId, deferred)
              return undefined
            }
            if (entry.cacheExpiresAt <= now) return 'expired'
            if (
              !isCacheKeepHybridActive(snapshot.policyStorage) &&
              !entry.policyState?.planned &&
              readSessionCachePolicy(
                entry.policyState?.ownerSessionId ?? entry.id,
                true,
              )?.keep_warm === undefined
            )
              return 'invalid'
            const account = snapshot.accounts.find(
              (row) => accountKey(row) === entry.oauthAccountIdentity,
            )
            if (!account)
              return missingAccountReason(
                entry.oauthAccountIdentity,
                snapshot.accounts,
              )
            if (account.type !== 'oauth' || !nativeAccountCanServe(account))
              return 'account-gone'
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
            // Saved sessions can fill spare capacity, but are not new user
            // turns. Leave overflow on disk for another lease to pick up.
            if (!manager.hasRoomForRestore(entry.bodyText)) return undefined
            const nextPrewarmAt =
              entry.nextPrewarmAt <= now
                ? now + overdue++ * 3000
                : entry.nextPrewarmAt
            const result = manager.track({
              sessionId: entry.id,
              url: entry.url,
              headers: new Headers(),
              bodyText: entry.bodyText,
              storage: snapshot.policyStorage,
              cacheMode: 'hybrid',
              oauthAccountId: account.id,
              oauthAccountIdentity: entry.oauthAccountIdentity,
              isSubagent: entry.isSubagent,
              acceptedAt,
              retained: {
                cacheExpiresAt: entry.cacheExpiresAt,
                nextPrewarmAt,
                ttlMs: entry.ttlMs,
                lastTouchAt: entry.lastTouchAt,
                lastTouchKind: entry.lastTouchKind,
                policyState: entry.policyState,
              },
            })
            if (result.tracked) restored.add(entry.id)
            return result.tracked ? true : 'invalid'
          },
          undefined,
          (hash) =>
            leases.size > 0 &&
            !removed.has(hash) &&
            !manager
              .trackedSessions()
              .some(({ id }) => sessionHash(id) === hash),
        )
      })()
        .catch(() => {
          logger.warn('cachekeep', 'failed to restore tracked sessions')
        })
        .finally(() => {
          if (shared.loading === loading) {
            shared.loading = undefined
            shared.removedDuringRestore = undefined
          }
        })
      shared.loading = loading
      await loading
      if (!leases.size) return
      // A session whose cache expired while no instance was live has nothing
      // left to keep warm; drop it rather than prewarm it.
      if (manager.dropExpiredTargets() === undefined) return
      manager.start()
      registry.publish(manager.registrySessions()).catch(() => {
        logger.warn('cachekeep', 'failed to publish tracked sessions')
      })
    },
  }
  return shared
}

/**
 * Keep admitted hybrid-cache prefixes warm using fresh native authorization for
 * each send. Instances of this module using the same storage share one keeper
 * until the last lease closes. Other modules can adopt its saved sessions once
 * it releases their claims and while their caches are still live.
 */
export function createNativeCacheKeep(
  options: NativeCacheKeepOptions & {
    runtime: NativeAccountRuntime
    source: NativeSource
    /** Identity of the account storage; instances that share it share sessions. */
    storageId: string
    fetch?: typeof fetch
    isSubagent?: (sessionID: string) => Promise<boolean>
    subagent?: (sessionID: string) => boolean | undefined
  },
) {
  const { runtime, source } = options
  const abort = new AbortController()
  const shareds = sharedCacheKeeps()
  let copies = shareds.get(options.storageId)
  if (!copies) {
    copies = new Map()
    shareds.set(options.storageId, copies)
  }
  const owner =
    copies.get(cacheKeepModule) ??
    createSharedCacheKeep(options.storageId, options)
  copies.set(cacheKeepModule, owner)
  const { manager, registry } = owner
  const realTurns = new Set<CacheKeepRealTurn>()
  const beginRealTurn = (input: RequestScope) => {
    if (
      lease.stopped ||
      input.kind !== 'primary' ||
      input.agent === 'cachekeep' ||
      input.agent === 'prime'
    )
      return undefined
    owner.persistence.realTurn(input.sessionID, false)
    try {
      for (const turn of realTurns) if (!turn.active) realTurns.delete(turn)
      const turn = manager.beginRealTurn(input.sessionID)
      realTurns.add(turn)
      return turn
    } catch {}
    return undefined
  }
  const acceptedStates = new Map<
    string,
    NonNullable<CacheKeepTarget['policyState']>
  >()
  const resolvedParent = async (sessionID: string, isSubagent: boolean) => {
    const state = acceptedStates.get(sessionID)
    const current = () =>
      !lease.stopped &&
      state !== undefined &&
      manager.trackedPolicyState(sessionID) === state
    if (!current()) return
    if (!isSubagent) {
      manager.updateSubagent(sessionID, false)
      return
    }
    const latestLease = () => [...owner.leases.values()].at(-1)
    const active = latestLease()
    const storage = await active?.loadStorage()
    // A session-parent lookup can finish after the tracked policy state, the
    // settings or the lease have changed. Retire the target only if that same
    // policy state is still current under the newest live lease.
    if (!current() || !active || latestLease() !== active) return
    if (
      storage &&
      readSessionCachePolicy(sessionID, true)?.keep_warm === undefined &&
      !isCacheKeepSubagentsEnabled(storage)
    ) {
      manager.untrack(sessionID, 'policy-refused')
      acceptedStates.delete(sessionID)
    } else manager.updateSubagent(sessionID, isSubagent)
  }
  // Unanswered attempts are not warm targets: replacing a target or reserving
  // budget before Anthropic accepts the request would evict useful prefixes.
  const pending = new Map<
    string,
    {
      sessionID: string
      signal?: AbortSignal
      onAbort: () => void
      turn?: CacheKeepRealTurn
      target?: Parameters<CacheKeepManager['track']>[0]
    }
  >()
  const takeAttempt = (attemptId: string) => {
    const entry = pending.get(attemptId)
    pending.delete(attemptId)
    entry?.signal?.removeEventListener('abort', entry.onAbort)
    return entry
  }
  const discardAttempt = (attemptId: string) => {
    const entry = takeAttempt(attemptId)
    try {
      if (lease.stopped) entry?.turn?.pause()
      else entry?.turn?.finish()
    } catch {}
    return entry?.target
  }
  const send = async (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
    onResponseHeaders?: () => void,
  ) => {
    const signal = deadline
      ? AbortSignal.any([abort.signal, deadline])
      : abort.signal
    if (signal.aborted)
      throw new CacheKeepPrewarmError('authorization', signal.reason)
    const warmBodyText = await warm.text()
    let dispatchStorage: CacheKeepPolicyStorage | undefined
    const body = JSON.parse(warmBodyText) as { model: string }
    const boundAccount = (account: NativeAccountView) =>
      target.sourceWarm
        ? (account.binding
            ? localMessageThreadCredential(account.binding)
            : account.credentialId) === target.oauthAccountIdentity
        : accountKey(account) === target.oauthAccountIdentity
    const scope: RequestScope = {
      providerID: 'anthropic',
      modelID: body.model,
      sessionID: `oc2-cachekeep:${target.id}`,
      agent: 'cachekeep',
      kind: 'generate',
    }
    const refuse = (reason: NativeAccountRefusalReason) => {
      throw new NativeAccountRefusal(reason)
    }
    let actualWarmTtl = requestCacheLifetimeMs(warmBodyText)
    const native = createNativeAnthropicAdapter({
      cacheKeepHeaders: target.headers['anthropic-beta']
        ? new Headers(target.headers)
        : undefined,
      source: {
        ...source,
        quotaFromHeaders(headers, input) {
          return source.quotaFromHeaders?.(headers, {
            ...input,
            reportRouting: false,
          })
        },
        billingRequest(input) {
          const billing = source.billingRequest?.(input)
          return billing
            ? {
                ...billing,
                sessionId: target.policyState?.ownerSessionId ?? target.id,
                requestKind: 'keep_warm',
                cache: { warming: { on: true } },
              }
            : undefined
        },
        // Background sends must not extend a user turn's billing or diagnostics
        // chain or replace its live CacheKeep target. Successful prewarms only
        // update the target session's last cache refresh time below.
        onRequestPrepared: undefined,
        onFinalRequestPrepared: ({ ttlMs }) => {
          actualWarmTtl = ttlMs
        },
        responseOptions: undefined,
        async requestOptions(input) {
          const policy = await source.requestOptions?.(input, refuse)
          return {
            ...policy,
            laneStart: false,
            billingLineage: undefined,
            cacheDiagnosticsPreviousMessageId: undefined,
          }
        },
        async authorizeAccount(input, accountId) {
          const snapshot = await runtime.read()
          dispatchStorage = snapshot.policyStorage
          signal.throwIfAborted()
          const account = snapshot.accounts.find((row) => row.id === accountId)
          if (account?.type !== 'oauth' || !nativeAccountCanServe(account))
            throw new NativeAccountRefusal('account-unavailable')
          if (!boundAccount(account))
            throw new NativeAccountRefusal('credential-changed')
          if (
            !target.policyState?.planned &&
            ((target.isSubagent &&
              readSessionCachePolicy(
                target.policyState?.ownerSessionId ?? target.id,
                true,
              )?.keep_warm === undefined &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
              !isCacheKeepHybridActive(snapshot.policyStorage) ||
              !isCacheKeepActiveNow(
                snapshot.policyStorage,
                new Date(options.now?.() ?? Date.now()),
              ))
          )
            return undefined
          const authorized = await source.authorizeAccount(
            input,
            accountId,
            refuse,
          )
          if (
            authorized?.provenance.kind === 'local' &&
            !boundAccount({
              ...account,
              binding: authorized.provenance.subject.binding,
              accountIdentity: authorized.provenance.subject.binding.identity,
            })
          )
            throw new NativeAccountRefusal('credential-changed')
          if (
            authorized?.provenance.kind === 'vault' &&
            authorized.provenance.credentialId !== account.credentialId
          )
            throw new NativeAccountRefusal('credential-changed')
          return authorized
        },
        async admitRequest(input) {
          await source.admitRequest?.(input, refuse)
          const snapshot = await runtime.read()
          dispatchStorage = snapshot.policyStorage
          const account = snapshot.accounts.find(
            (row) => row.id === input.accountId,
          )
          signal.throwIfAborted()
          if (!account) throw new NativeAccountRefusal('account-unavailable')
          if (!boundAccount(account))
            throw new NativeAccountRefusal('credential-changed')
          if (
            !target.policyState?.planned &&
            ((target.isSubagent &&
              readSessionCachePolicy(
                target.policyState?.ownerSessionId ?? target.id,
                true,
              )?.keep_warm === undefined &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
              !isCacheKeepHybridActive(snapshot.policyStorage) ||
              !isCacheKeepActiveNow(
                snapshot.policyStorage,
                new Date(options.now?.() ?? Date.now()),
              ))
          )
            throw new Error('CacheKeep policy changed before dispatch')
        },
      },
    })
    let attempt:
      | Attempt<NativeAnthropicAttemptData<NativeSourceProvenance>>
      | undefined
    let status: number | undefined
    let stage: CacheKeepFailureStage = 'authorization'
    let complete = false
    const cancel = () => native.forgetSession(scope.sessionID)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const snapshot = await runtime.read()
      dispatchStorage = snapshot.policyStorage
      const sessionId = target.policyState?.ownerSessionId ?? target.id
      const sessionBody = manager.trackedRequest(sessionId)?.bodyText
      const modelId =
        sessionBody && !target.sourceWarm
          ? (JSON.parse(sessionBody) as { model?: string }).model
          : body.model
      const routed = manager.trackedRequest(target.id)
        ? source.peekAccount?.(sessionId, modelId, snapshot)
        : undefined
      if (routed !== undefined && routed !== (target.oauthAccountId ?? 'main'))
        throw new CacheKeepWarmRefusal('routing-moved')
      const accountId = snapshot.accounts.find(
        (account) =>
          boundAccount(account) &&
          (!target.sourceWarm || account.id === target.oauthAccountId),
      )?.id
      if (!accountId)
        throw new NativeAccountRefusal(
          snapshot.accounts.some(
            (account) => account.id === target.oauthAccountId,
          )
            ? 'credential-changed'
            : 'account-unavailable',
        )
      const authorized = await native.adapter.accountHeaders({
        ...scope,
        accountId,
      })
      if (
        !('headers' in authorized) ||
        typeof authorized.headers !== 'object' ||
        authorized.headers === null ||
        typeof authorized.attempt !== 'object' ||
        authorized.attempt === null ||
        authorized.attempt.route !== 'oauth'
      )
        throw new Error('CacheKeep authorization refused')
      attempt = {
        ...scope,
        accountId,
        attemptId: crypto.randomUUID(),
        transport: 'http',
        data: authorized.attempt,
      }
      const baseUrl =
        target.sourceWarm &&
        typeof target.hostMetadata?.sourceBaseUrl === 'string'
          ? target.hostMetadata.sourceBaseUrl
          : target.url
      const gateway = runtime.getClaudeGateway?.()
      if (
        target.sourceWarm &&
        ((gateway && claudeGatewayModelUrl(baseUrl, gateway)?.toString()) ||
          baseUrl) !== target.url
      )
        throw new CacheKeepWarmRefusal('routing-moved')
      const request = await native.adapter.rewriteRequest?.({
        ...scope,
        accountId,
        attempt,
        request: new Request(baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: warmBodyText,
          signal,
        }),
      })
      if (!request) throw new Error('CacheKeep rewrite refused')
      signal.throwIfAborted()
      const ownerSession = target.policyState?.ownerSessionId ?? target.id
      const explicit =
        target.policyState?.planned === true ||
        readSessionCachePolicy(ownerSession, true)?.keep_warm !== undefined
      const parent = explicit ? undefined : options.subagent?.(ownerSession)
      if (!explicit && options.subagent && parent === undefined)
        throw new CacheKeepPrewarmError('authorization', undefined)
      if (parent && !isCacheKeepSubagentsEnabled(dispatchStorage))
        throw new CacheKeepWarmRefusal('subagents-disabled')
      const physical = await manager.reserveWarmDispatch(
        target,
        () => {
          const tracked = manager.trackedRequest(target.id)
          if (
            target.sourceWarmCurrent &&
            (!tracked || !target.sourceWarmCurrent(tracked.bodyText))
          )
            throw new CacheKeepWarmRefusal('routing-moved')
          stage = 'send'
          return (options.fetch ?? fetch)(request)
        },
        signal,
      )
      try {
        onResponseHeaders?.()
      } catch {}
      stage = 'response'
      status = physical.status
      const response = await native.adapter.rewriteResponse?.({
        ...scope,
        accountId,
        attempt,
        request,
        response: physical,
      })
      if (!response) throw new Error('CacheKeep response rewrite refused')
      status = response.status
      native.adapter.quotaFromHeaders?.(
        response.headers,
        response.status,
        attempt,
      )
      if (!response.ok)
        await native.adapter.limitFromResponse?.({
          status,
          headers: response.headers,
          body: () => response.clone().text(),
          attempt,
        })
      const bytes = await response.arrayBuffer()
      if (
        response.ok &&
        !signal.aborted &&
        !target.sourceWarm &&
        manager.isCurrentTarget(target)
      )
        sessionCacheActivity.recordPrewarm(
          target.id,
          accountId,
          options.now?.() ?? Date.now(),
          actualWarmTtl,
        )
      complete = true
      const completed = new Response(bytes, {
        status,
        headers: response.headers,
      })
      warmResponseLifetimes.set(completed, actualWarmTtl)
      return completed
    } catch (error) {
      if (error instanceof CacheKeepWarmRefusal || isCacheKeepWarmWait(error))
        throw error
      const refusal = nativeAccountRefusal(error)
      if (refusal) throw refusal
      // The native credentials are unavailable to the manager's error scrubber;
      // retain closed diagnostics, never the native error or its message.
      throw new CacheKeepPrewarmError(stage, error, status)
    } finally {
      signal.removeEventListener('abort', cancel)
      if (attempt?.data && stage === 'authorization')
        native.discardUnsentBilling(attempt.data)
      try {
        if (attempt)
          await native.adapter.onAttemptEnd?.(attempt, {
            status,
            outputStarted: false,
            ...(complete ? {} : { error: { reason: 'cancelled' as const } }),
          })
      } finally {
        native.dispose()
        source.forgetSession?.(scope.sessionID)
      }
    }
  }
  const lease: CacheKeepLease = {
    runtime,
    generation: owner.nextGeneration++,
    stopped: false,
    loadStorage: async () => (await runtime.read()).policyStorage,
    send,
    inflight: new Set(),
    read: () => runtime.read(),
    subagent: options.subagent,
  }
  owner.leases.set(lease.generation, lease)
  if (owner.leases.size === 1)
    owner.unwatchClaimAvailable = owner.persistence.onClaimAvailable(() => {
      if (owner.leases.size) void owner.adopt()
    })
  const ready = owner.adopt().then(() => {
    if (!lease.stopped)
      for (const session of manager.trackedSessions())
        options.subagent?.(session.id)
  })
  let cleanup: Promise<void> | undefined
  return {
    ready,
    rounds: owner.rounds,
    roundNotices: owner.roundNotices,
    roundRoutes: owner.roundRoutes,
    roundRuntime: owner.roundRuntime,
    forgetRoundAccount(accountId: string) {
      owner.rounds.forgetAccount(accountId)
      for (const [sessionID, route] of owner.roundRoutes)
        if (route.accountId === accountId) owner.roundRoutes.delete(sessionID)
    },
    retireRoundTemplate: (sessionID: string) => manager.untrack(sessionID),
    beginRealTurn,
    async track(input: NativeCacheRequestPrepared) {
      let turn =
        input.kind === 'primary' &&
        input.agent !== 'cachekeep' &&
        input.agent !== 'prime' &&
        !input.isCurrent
          ? currentCacheKeepRealTurn()
          : undefined
      try {
        turn ??=
          !lease.stopped && !input.isCurrent ? beginRealTurn(input) : undefined
      } catch {}
      // An accepted real request replaces the session's replay target; other
      // endings retire it. Background work never owns a real request's lease.
      const skipped = (reason: string) => {
        try {
          if (lease.stopped) turn?.pause()
          else turn?.finish()
        } catch {}
        discardAttempt(input.attemptId)
        logger.debug('cachekeep', 'tracking skipped', {
          session: input.sessionID,
          reason,
        })
      }
      if (lease.stopped || input.isCurrent?.() === false)
        return skipped('lease-stopped')
      if (input.route !== 'oauth') return skipped('not-oauth')
      if (input.agent === 'cachekeep' || input.agent === 'prime')
        return skipped('background-agent')
      if (input.kind !== 'primary') return skipped('not-primary')
      if (input.signal?.aborted) return skipped('attempt-ended')
      const previous = takeAttempt(input.attemptId)
      try {
        if (previous?.turn !== turn) previous?.turn?.finish()
      } catch {}
      const entry: NonNullable<ReturnType<typeof pending.get>> = {
        sessionID: input.sessionID,
        signal: input.signal,
        onAbort: () => discardAttempt(input.attemptId),
        turn,
      }
      pending.set(input.attemptId, entry)
      input.signal?.addEventListener('abort', entry.onAbort, { once: true })
      const snapshot = input.admission?.snapshot ?? (await runtime.read())
      if (lease.stopped) return skipped('lease-stopped')
      const policy = readSessionCachePolicy(input.sessionID, true)
      const hybridActive = isCacheKeepHybridActive(snapshot.policyStorage)
      // A target this call stops keeps its stop as the session's warming record.
      const hadTarget =
        !hybridActive &&
        manager.trackedSessions().some(({ id }) => id === input.sessionID)
      discardLocalTargets(owner, options.now, !hybridActive)
      if (!hybridActive) {
        if (policy?.keep_warm === undefined) {
          if (!hadTarget) manager.recordWarmingOff(input.sessionID)
          return skipped('hybrid-inactive')
        }
      }
      let isSubagent = false
      try {
        isSubagent = options.subagent
          ? (options.subagent(input.sessionID) ?? false)
          : ((await options.isSubagent?.(input.sessionID)) ?? false)
      } catch {
        // A missing host session record cannot justify background spending.
        return skipped('session-lookup-failed')
      }
      if (lease.stopped) return skipped('lease-stopped')
      if (
        policy?.keep_warm === undefined &&
        isSubagent &&
        !isCacheKeepSubagentsEnabled(snapshot.policyStorage)
      ) {
        manager.recordWarmingOff(input.sessionID)
        return skipped('subagents-disabled')
      }
      const account =
        input.admission?.account ??
        snapshot.accounts.find((row) => row.id === input.accountId)
      if (!account?.accountIdentity) return skipped('account-identity-missing')
      if (
        input.provenance.kind === 'local' &&
        JSON.stringify(account.binding) !==
          JSON.stringify(input.provenance.subject.binding)
      )
        return skipped('local-binding-changed')
      if (
        input.provenance.kind === 'vault' &&
        account.credentialId !== input.provenance.credentialId
      )
        return skipped('vault-credential-changed')
      if (
        pending.get(input.attemptId) !== entry ||
        input.isCurrent?.() === false
      )
        return skipped('attempt-ended')
      entry.target = {
        sessionId: input.sessionID,
        url: input.url,
        headers: new Headers(input.sourceHeaders),
        bodyText: input.bodyText,
        storage: snapshot.policyStorage,
        cacheMode: 'hybrid',
        oauthAccountId: input.accountId,
        oauthAccountIdentity: accountKey(account),
        isSubagent,
        ttlMs:
          requestCacheLifetimeMs(input.bodyText) ||
          (readSessionCachePolicy(input.sessionID, true)?.ttl !== undefined
            ? 0
            : undefined),
      }
    },
    onResponseHeaders(input: {
      attemptId: string
      status: number
      acceptedAt?: number
      ttlMs?: number
      acceptedUsage?: Parameters<CacheKeepManager['recordAcceptedUsage']>[2]
    }) {
      const entry = takeAttempt(input.attemptId)
      const target = entry?.target
      try {
        if (
          !lease.stopped &&
          input.status >= 200 &&
          input.status < 300 &&
          target
        ) {
          const sessionID = target.sessionId
          if (!sessionID) return
          const parent = options.subagent?.(sessionID)
          if (parent !== undefined) target.isSubagent = parent
          if (
            target.isSubagent &&
            readSessionCachePolicy(sessionID, true)?.keep_warm === undefined &&
            !isCacheKeepSubagentsEnabled(target.storage)
          ) {
            if (entry?.turn) entry.turn.finish()
            else if (!manager.untrack(sessionID, 'policy-refused'))
              manager.recordWarmingOff(sessionID)
            return
          }
          const result = (
            entry?.turn
              ? entry.turn.track.bind(entry.turn)
              : manager.track.bind(manager)
          )({
            ...target,
            acceptedUsage: input.acceptedUsage,
            ...(input.acceptedAt !== undefined && {
              acceptedAt: input.acceptedAt,
            }),
            ...(input.ttlMs !== undefined && { ttlMs: input.ttlMs }),
          })
          if (result.tracked) {
            // A predecessor may become the sender after this lease is disposed.
            // Update every live lease's subagent information without waiting for lookup.
            for (const current of owner.leases.values())
              current.subagent?.(sessionID)
            acceptedStates.delete(sessionID)
            const state = manager.trackedPolicyState(sessionID)
            if (state) acceptedStates.set(sessionID, state)
            if (acceptedStates.size > 4096) {
              const oldest = acceptedStates.keys().next().value
              if (oldest !== undefined) acceptedStates.delete(oldest)
            }
          }
          if (result.tracked)
            registry.publish(manager.registrySessions()).catch(() => {
              logger.warn('cachekeep', 'failed to publish tracked sessions')
            })
          return result
        }
      } finally {
        try {
          if (lease.stopped) entry?.turn?.pause()
          else entry?.turn?.finish()
        } catch {}
      }
    },
    discardAttempt(attemptId: string) {
      discardAttempt(attemptId)
    },
    /** Keep-warm state for an OAuth billing report, from memory only. */
    warming(input: {
      sessionID: string
      route: string
    }): AnthropicBillingWarming | undefined {
      if (input.route !== 'oauth') return { on: false as const }
      return lease.stopped ? undefined : manager.warming(input.sessionID)
    },
    recordAcceptedUsage(
      sessionID: string,
      bodyText: string,
      usage: Parameters<CacheKeepManager['recordAcceptedUsage']>[2],
    ) {
      if (!lease.stopped)
        manager.recordAcceptedUsage(sessionID, bodyText, usage)
    },
    resolvedParent,
    forgetSession(sessionID: string) {
      acceptedStates.delete(sessionID)
      owner.removedDuringRestore?.add(sessionHash(sessionID))
      manager.untrack(sessionID)
      for (const [attemptId, entry] of pending)
        if (entry.sessionID === sessionID) discardAttempt(attemptId)
    },
    sessionDeleted(sessionID: string) {
      owner.rounds.forgetSession(sessionID)
      owner.roundNotices.forget(sessionID)
      owner.roundRoutes.delete(sessionID)
      // Local routing cleanup also runs on eviction and shutdown. Only the host
      // deletion event can invalidate a record belonging to another server.
      const current =
        shareds.get(options.storageId)?.get(cacheKeepModule) ?? owner
      current.removedDuringRestore?.add(sessionHash(sessionID))
      current.persistence.removed(sessionID, 'deleted')
    },
    registry,
    dispose() {
      if (cleanup) return cleanup
      lease.stopped = true
      for (const turn of realTurns) {
        try {
          turn.pause()
        } catch {}
      }
      realTurns.clear()
      for (const attemptId of pending.keys()) takeAttempt(attemptId)
      abort.abort()
      for (const [id, entry] of owner.prepared)
        if (entry.lease === lease) owner.prepared.delete(id)
      // Only this instance's own lease is released. A predecessor disposed
      // after its successor started leaves the successor's sessions and timer
      // alone; the timer stops only when no instance holds a lease.
      const last =
        owner.leases.delete(lease.generation) && owner.leases.size === 0
      if (last) {
        owner.unwatchClaimAvailable?.()
        owner.unwatchClaimAvailable = undefined
      }
      const ticking = last ? owner.ticking : undefined
      const retaining = last ? owner.retain() : undefined
      cleanup = (async () => {
        try {
          // Join a scheduler pass already in progress. With no lease left it
          // cannot authorize or send anything more.
          if (last) {
            await retaining
            await ticking
          }
          await ready
          // Sends this instance started use its runtime, which the caller
          // closes after disposal; wait for them to observe the abort.
          await Promise.all(lease.inflight)
          await owner.persistence.drain()
        } finally {
          // Retained sessions are not being warmed, so withdraw them from the
          // shared session list unless another instance adopted them already.
          if (last && owner.leases.size === 0) await registry.dispose()
        }
      })()
      return cleanup
    },
  }
}
