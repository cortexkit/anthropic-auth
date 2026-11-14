import { setTimeout as delay } from 'node:timers/promises'
import {
  type AnthropicBillingWarming,
  type CacheKeepFailureStage,
  CacheKeepManager,
  type CacheKeepPrewarmAttempt,
  CacheKeepPrewarmError,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  CacheKeepWarmRefusal,
  getCacheKeepRegistryDirectories,
  isCacheKeepActiveNow,
  isCacheKeepHybridActive,
  isCacheKeepSubagentsEnabled,
  logger,
  NativeAccountRefusal,
  type NativeAccountRefusalReason,
  type NativeAccountRuntime,
  type NativeAccountView,
  nativeAccountCanServe,
  nativeAccountRefusal,
  readSessionCachePolicy,
  requestCacheLifetimeMs,
  sessionCacheActivity,
} from '@cortexkit/anthropic-auth-core'
import type { Attempt, RequestScope } from '@cortexkit/common-auth/opencode2'
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
  stopped: boolean
  readonly loadStorage: () => Promise<CacheKeepPolicyStorage>
  readonly send: (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
  ) => Promise<Response>
  /** Sends this lease started; its disposal waits for them to settle. */
  readonly inflight: Set<Promise<unknown>>
  readonly read: NativeAccountRuntime['read']
  readonly subagent?: (sessionID: string) => boolean | undefined
}

/**
 * Tracked sessions for one account storage, shared by every plugin instance in
 * the host process that uses that storage. OpenCode 2 creates one plugin
 * instance per directory and disposes it when it evicts the directory or a
 * plugin file changes, so the tracked sessions must outlive any one instance.
 */
interface SharedCacheKeep {
  readonly manager: Omit<
    CacheKeepManager,
    | 'registrySessions'
    | 'reserveWarmDispatch'
    | 'isCurrentTarget'
    | 'recordAcceptedUsage'
    | 'hasPlannedTarget'
    | 'updateSubagent'
    | 'trackedPolicyState'
    | 'warming'
    | 'recordWarmingOff'
  > &
    Partial<
      Pick<
        CacheKeepManager,
        | 'registrySessions'
        | 'reserveWarmDispatch'
        | 'isCurrentTarget'
        | 'recordAcceptedUsage'
        | 'hasPlannedTarget'
        | 'updateSubagent'
        | 'trackedPolicyState'
        | 'warming'
        | 'recordWarmingOff'
      >
    >
  readonly registry: CacheKeepSessionRegistry
  persistence: CacheKeepStore
  readonly persistenceFollowsOwner?: true
  legacyPersistence?: CacheKeepStore
  loading?: Promise<void>
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
  nextGeneration: number
  /** The scheduler pass in progress, so the last release can wait for it. */
  ticking?: Promise<void>
  /** Called after the last lease is released. */
  readonly retain: () => void
  /** Called when a lease is taken; resumes warming any retained sessions. */
  readonly adopt: () => Promise<void>
  hybridDisabled?: boolean
  localCleanup?: Promise<void>
  plannedUnsupportedLogged?: boolean
}

function discardLocalTargets(
  shared: SharedCacheKeep,
  now: number,
  disabled: boolean,
) {
  if (!disabled) {
    shared.hybridDisabled = false
    return
  }
  const controlled = (id: string) =>
    readSessionCachePolicy(id, true)?.keep_warm !== undefined
  let hasRunnerTargets = false
  for (const session of shared.manager.trackedSessions()) {
    if (controlled(session.id) || shared.manager.hasPlannedTarget?.(session.id))
      hasRunnerTargets = true
    else shared.manager.untrack(session.id, 'disabled')
  }
  if (shared.hybridDisabled) return
  shared.hybridDisabled = true
  const persistence = shared.persistence
  // Inspect saved as well as live targets before a whole-store clear: a saved
  // session with explicit keep_warm may not have been restored into memory yet.
  shared.localCleanup = (shared.localCleanup ?? Promise.resolve())
    .then(async () => {
      await persistence.drain()
      await persistence.load(now, (entry) => {
        if (!shared.hybridDisabled) return undefined
        if (
          entry.policyState?.planned ||
          controlled(entry.policyState?.ownerSessionId ?? entry.id)
        ) {
          hasRunnerTargets = true
          return undefined
        }
        persistence.removed(entry.id)
        return 'invalid'
      })
      // A response may admit a runner target while the disk sweep awaits I/O.
      const liveRunner = shared.manager
        .trackedSessions()
        .some(
          (session) =>
            controlled(session.id) ||
            shared.manager.hasPlannedTarget?.(session.id),
        )
      if (!hasRunnerTargets && !liveRunner && shared.hybridDisabled)
        persistence.clear()
    })
    .catch(() => logger.warn('cachekeep', 'local restart cleanup failed'))
}

// Kept on globalThis rather than in a module variable, so a plugin reload that
// imports this module again still finds the sessions the previous copy
// tracked. The version suffix keeps a future, differently shaped entry apart.
const SHARED_CACHE_KEEPS = Symbol.for(
  'cortexkit.anthropic-auth.opencode2.cachekeep.v2',
)

function sharedCacheKeeps(): Map<string, SharedCacheKeep> {
  const scope = globalThis as typeof globalThis & {
    [SHARED_CACHE_KEEPS]?: Map<string, SharedCacheKeep>
  }
  scope[SHARED_CACHE_KEEPS] ??= new Map()
  return scope[SHARED_CACHE_KEEPS]
}

function createSharedCacheKeep(
  storageId: string,
  options: NativeCacheKeepOptions,
  persistence: CacheKeepStore,
): SharedCacheKeep {
  const prepared: SharedCacheKeep['prepared'] = new Map()
  const leases: SharedCacheKeep['leases'] = new Map()
  const restored = new Set<string>()
  let lastRestoredSend = 0
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
      if (lease)
        discardLocalTargets(
          shared,
          options.now?.() ?? Date.now(),
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
    reserveWarm: (target) => shared.persistence.reserveWarm(target),
    settleWarm: (target) =>
      manager.isCurrentTarget(target)
        ? shared.persistence.reserveWarm(target)
        : Promise.resolve(false),
    deferWarmReservation: true,
    responseTtlMs: (response) => warmResponseLifetimes.get(response),
    onTargetChanged: (target) => shared.persistence.changed(target),
    onTargetRemoved: (id) => {
      restored.delete(id)
      shared.persistence.removed(id)
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
        await delay(
          Math.max(0, lastRestoredSend + 3000 - Date.now()),
          undefined,
          {
            signal: entry.attempt.signal,
          },
        )
        lastRestoredSend = Date.now()
      }
      const sending = entry.lease.send(
        entry.target,
        request as Request,
        entry.attempt.signal,
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
  // OpenCode 2 disposes an evicted directory's instance before anything boots
  // that directory again, so the last release must not drop the sessions: a
  // new instance for this storage may adopt them while their cache is alive.
  // The bodies also survive a server restart in private temporary storage.
  // There is no timer sending prewarms, runtime or credential until adoption.
  // A single timer deletes each body when its cache expires.
  let expiry: ReturnType<typeof setTimeout> | undefined
  const stopExpiry = () => {
    if (expiry !== undefined) clearTimeout(expiry)
    expiry = undefined
  }
  const dropExpired = () => {
    stopExpiry()
    if (leases.size > 0) return
    const earliest = manager.dropExpiredTargets()
    if (earliest === undefined) {
      const shareds = sharedCacheKeeps()
      if (shareds.get(storageId) === shared) shareds.delete(storageId)
      return
    }
    const now = options.now?.() ?? Date.now()
    expiry = setTimeout(dropExpired, Math.max(0, earliest - now))
    if (typeof expiry === 'object' && 'unref' in expiry) expiry.unref()
  }
  const shared: SharedCacheKeep = {
    manager,
    registry,
    persistence,
    persistenceFollowsOwner: true,
    prepared,
    leases,
    nextGeneration: 0,
    retain() {
      manager.stop()
      prepared.clear()
      dropExpired()
    },
    async adopt() {
      stopExpiry()
      shared.loading ??= (async () => {
        const lease = newestLease()
        if (!lease) return
        const snapshot = await lease.read()
        const now = options.now?.() ?? Date.now()
        let overdue = 0
        await shared.persistence.load(now, (entry) => {
          // Disposal may race startup. Leave the file for the next live lease.
          if (!leases.size || manager.trackedRequest(entry.id)) return undefined
          if (
            !isCacheKeepHybridActive(snapshot.policyStorage) &&
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
            readSessionCachePolicy(
              entry.policyState?.ownerSessionId ?? entry.id,
              true,
            )?.keep_warm === undefined &&
            !isCacheKeepSubagentsEnabled(snapshot.policyStorage)
          )
            return 'invalid'
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
        })
      })().catch(() => {
        logger.warn('cachekeep', 'failed to restore tracked sessions')
      })
      await shared.loading
      if (!leases.size) return
      // A session whose cache expired while no instance was live has nothing
      // left to keep warm; drop it rather than prewarm it.
      if (manager.dropExpiredTargets() === undefined) return
      manager.start()
      registry
        .publish(manager.registrySessions?.() ?? manager.trackedSessions())
        .catch(() => {
          logger.warn('cachekeep', 'failed to publish tracked sessions')
        })
    },
  }
  return shared
}

/**
 * Keep admitted hybrid-cache prefixes warm using fresh native authorization for
 * each send. Instances for the same account storage share one set of tracked
 * sessions: a later instance takes over sending for sessions an earlier one
 * tracked, and the timer stops only when the last instance is disposed. The
 * sessions themselves outlive the last instance until their cache expires, so
 * an instance that boots for the same storage in that time adopts them.
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
  const previous = shareds.get(options.storageId)
  const persistence = new CacheKeepStore(
    { storageId: options.storageId, ...options.persistence },
    previous?.persistence,
  )
  // Reloads keep the older manager, registry and timers, publishing only the
  // fields they support. The registry's new data-directory location and its
  // ttlMs, lastTouchAt, lastTouchKind and warmStopped fields take effect after
  // a server restart, not when a plugin copy is reloaded.
  const owner =
    previous ?? createSharedCacheKeep(options.storageId, options, persistence)
  if (previous && !previous.persistenceFollowsOwner) {
    // Older copies captured their first store in the manager callbacks. Keep
    // those callbacks following the current writer across subsequent reloads.
    owner.legacyPersistence ??= owner.persistence
    const legacy = owner.legacyPersistence
    legacy.changed = (target) => persistence.changed(target)
    legacy.removed = (id) => persistence.removed(id)
    legacy.clear = () => persistence.clear()
    legacy.load = (now, accept) => persistence.load(now, accept)
  }
  owner.persistence = persistence
  shareds.set(options.storageId, owner)
  const { manager, registry } = owner
  const acceptedStates = new Map<
    string,
    NonNullable<CacheKeepTarget['policyState']>
  >()
  const resolvedParent = async (sessionID: string, isSubagent: boolean) => {
    const state = acceptedStates.get(sessionID)
    const current = () =>
      !lease.stopped &&
      state !== undefined &&
      manager.trackedPolicyState?.(sessionID) === state
    if (!current()) return
    if (!isSubagent) {
      manager.updateSubagent?.(sessionID, false)
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
    } else manager.updateSubagent?.(sessionID, isSubagent)
  }
  // Unanswered attempts are not warm targets: replacing a target or reserving
  // budget before Anthropic accepts the request would evict useful prefixes.
  const pending = new Map<
    string,
    {
      sessionID: string
      signal?: AbortSignal
      onAbort: () => void
      target?: Parameters<CacheKeepManager['track']>[0]
    }
  >()
  const discardAttempt = (attemptId: string) => {
    const entry = pending.get(attemptId)
    pending.delete(attemptId)
    entry?.signal?.removeEventListener('abort', entry.onAbort)
    return entry?.target
  }
  const send = async (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
  ) => {
    const signal = deadline
      ? AbortSignal.any([abort.signal, deadline])
      : abort.signal
    if (signal.aborted)
      throw new CacheKeepPrewarmError('authorization', signal.reason)
    const warmBodyText = await warm.text()
    let dispatchStorage: CacheKeepPolicyStorage | undefined
    if (
      !manager.reserveWarmDispatch &&
      (target.policyState?.planned ||
        readSessionCachePolicy(
          target.policyState?.ownerSessionId ?? target.id,
          true,
        )?.keep_warm !== undefined)
    ) {
      if (!owner.plannedUnsupportedLogged) {
        owner.plannedUnsupportedLogged = true
        logger.debug(
          'cachekeep',
          'planned warming requires a server restart after an older owner reload',
        )
      }
      throw new CacheKeepWarmRefusal('unsupported')
    }
    const body = JSON.parse(warmBodyText) as { model: string }
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
          if (accountKey(account) !== target.oauthAccountIdentity)
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
            accountKey({
              ...account,
              binding: authorized.provenance.subject.binding,
              accountIdentity: authorized.provenance.subject.binding.identity,
            }) !== target.oauthAccountIdentity
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
          if (accountKey(account) !== target.oauthAccountIdentity)
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
      const modelId = sessionBody
        ? (JSON.parse(sessionBody) as { model?: string }).model
        : body.model
      const routed = manager.trackedRequest(target.id)
        ? source.peekAccount?.(sessionId, modelId, snapshot)
        : undefined
      if (routed !== undefined && routed !== (target.oauthAccountId ?? 'main'))
        throw new CacheKeepWarmRefusal('routing-moved')
      const accountId = snapshot.accounts.find(
        (account) => accountKey(account) === target.oauthAccountIdentity,
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
      const request = await native.adapter.rewriteRequest?.({
        ...scope,
        accountId,
        attempt,
        request: new Request(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }),
      })
      if (!request) throw new Error('CacheKeep rewrite refused')
      signal.throwIfAborted()
      const ownerSession = target.policyState?.ownerSessionId ?? target.id
      const explicit =
        readSessionCachePolicy(ownerSession, true)?.keep_warm !== undefined
      const parent = explicit ? undefined : options.subagent?.(ownerSession)
      if (!explicit && options.subagent && parent === undefined)
        throw new CacheKeepPrewarmError('authorization', undefined)
      if (parent && !isCacheKeepSubagentsEnabled(dispatchStorage))
        throw new CacheKeepWarmRefusal('subagents-disabled')
      await manager.reserveWarmDispatch?.(target)
      signal.throwIfAborted()
      stage = 'send'
      const physical = await (options.fetch ?? fetch)(request)
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
        (manager.isCurrentTarget?.(target) ?? true)
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
      if (error instanceof CacheKeepWarmRefusal) throw error
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
    generation: owner.nextGeneration++,
    stopped: false,
    loadStorage: async () => (await runtime.read()).policyStorage,
    send,
    inflight: new Set(),
    read: () => runtime.read(),
    subagent: options.subagent,
  }
  const adopting = owner.leases.size === 0
  owner.leases.set(lease.generation, lease)
  const ready = (
    adopting ? owner.adopt() : (owner.loading ?? Promise.resolve())
  ).then(() => {
    if (!lease.stopped)
      for (const session of manager.trackedSessions())
        options.subagent?.(session.id)
  })
  let cleanup: Promise<void> | undefined
  return {
    ready,
    async track(input: NativeCacheRequestPrepared) {
      // These skips are normal (API-key routes, prewarms, subagents, policy
      // off) and keep any existing target, so they stay at debug and do no
      // per-request work beyond the log call.
      const skipped = (reason: string) => {
        discardAttempt(input.attemptId)
        logger.debug('cachekeep', 'tracking skipped', {
          session: input.sessionID,
          reason,
        })
      }
      if (lease.stopped) return skipped('lease-stopped')
      if (input.route !== 'oauth') return skipped('not-oauth')
      if (input.agent === 'cachekeep' || input.agent === 'prime')
        return skipped('background-agent')
      if (input.kind !== 'primary') return skipped('not-primary')
      if (input.signal?.aborted) return skipped('attempt-ended')
      discardAttempt(input.attemptId)
      const entry: NonNullable<ReturnType<typeof pending.get>> = {
        sessionID: input.sessionID,
        signal: input.signal,
        onAbort: () => discardAttempt(input.attemptId),
      }
      pending.set(input.attemptId, entry)
      input.signal?.addEventListener('abort', entry.onAbort, { once: true })
      const snapshot = input.admission?.snapshot ?? (await runtime.read())
      if (lease.stopped) return skipped('lease-stopped')
      const policy = readSessionCachePolicy(input.sessionID, true)
      if (policy?.keep_warm !== undefined && !manager.reserveWarmDispatch) {
        if (!owner.plannedUnsupportedLogged) {
          owner.plannedUnsupportedLogged = true
          logger.debug(
            'cachekeep',
            'planned warming requires a server restart after an older owner reload',
          )
        }
        return skipped('planned-owner-requires-restart')
      }
      const hybridActive = isCacheKeepHybridActive(snapshot.policyStorage)
      // A target this call stops keeps its stop as the session's warming record.
      const hadTarget =
        !hybridActive &&
        manager.trackedSessions().some(({ id }) => id === input.sessionID)
      discardLocalTargets(owner, options.now?.() ?? Date.now(), !hybridActive)
      if (!hybridActive) {
        if (policy?.keep_warm === undefined) {
          if (!hadTarget) manager.recordWarmingOff?.(input.sessionID)
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
        manager.recordWarmingOff?.(input.sessionID)
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
      if (pending.get(input.attemptId) !== entry)
        return skipped('attempt-ended')
      entry.target = {
        sessionId: input.sessionID,
        url: input.url,
        headers: new Headers(),
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
      const target = discardAttempt(input.attemptId)
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
          if (!manager.untrack(sessionID, 'policy-refused'))
            manager.recordWarmingOff?.(sessionID)
          return
        }
        const result = manager.track({
          ...target,
          acceptedUsage: input.acceptedUsage,
          ...(input.acceptedAt !== undefined && {
            acceptedAt: input.acceptedAt,
          }),
          ...(input.ttlMs !== undefined && { ttlMs: input.ttlMs }),
        })
        if (result.tracked) {
          // A predecessor may become the sender after this lease is disposed.
          // Prime every live lease's parent facts without waiting for lookup.
          for (const current of owner.leases.values())
            current.subagent?.(sessionID)
          acceptedStates.delete(sessionID)
          const state = manager.trackedPolicyState?.(sessionID)
          if (state) acceptedStates.set(sessionID, state)
          if (acceptedStates.size > 4096) {
            const oldest = acceptedStates.keys().next().value
            if (oldest !== undefined) acceptedStates.delete(oldest)
          }
        }
        if (result.tracked)
          registry
            .publish(manager.registrySessions?.() ?? manager.trackedSessions())
            .catch(() => {
              logger.warn('cachekeep', 'failed to publish tracked sessions')
            })
        return result
      }
    },
    discardAttempt(attemptId: string) {
      discardAttempt(attemptId)
    },
    /**
     * Keep-warm state for a model request's billing report, from memory only.
     * API-key routes are never warmed; an older shared manager without the
     * reader leaves the state undecided.
     */
    warming(input: {
      sessionID: string
      route: string
    }): AnthropicBillingWarming | undefined {
      if (input.route !== 'oauth') return { on: false as const }
      return manager.warming?.(input.sessionID)
    },
    recordAcceptedUsage(
      sessionID: string,
      bodyText: string,
      usage: Parameters<CacheKeepManager['recordAcceptedUsage']>[2],
    ) {
      manager.recordAcceptedUsage?.(sessionID, bodyText, usage)
    },
    resolvedParent,
    forgetSession(sessionID: string) {
      acceptedStates.delete(sessionID)
      manager.untrack(sessionID)
      for (const [attemptId, entry] of pending)
        if (entry.sessionID === sessionID) discardAttempt(attemptId)
    },
    registry,
    dispose() {
      if (cleanup) return cleanup
      lease.stopped = true
      for (const attemptId of pending.keys()) discardAttempt(attemptId)
      abort.abort()
      for (const [id, entry] of owner.prepared)
        if (entry.lease === lease) owner.prepared.delete(id)
      // Only this instance's own lease is released. A predecessor disposed
      // after its successor started leaves the successor's sessions and timer
      // alone; the timer stops only when no instance holds a lease.
      const last =
        owner.leases.delete(lease.generation) && owner.leases.size === 0
      if (last) owner.retain()
      cleanup = (async () => {
        try {
          // Join a scheduler pass already in progress. With no lease left it
          // cannot authorize or send anything more.
          if (last) await owner.ticking
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
