import { setTimeout as delay } from 'node:timers/promises'
import {
  CacheKeepManager,
  type CacheKeepPrewarmAttempt,
  CacheKeepSessionRegistry,
  type CacheKeepTarget,
  getDefaultCacheKeepRegistryDirectory,
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
} from '@cortexkit/anthropic-auth-core'
import type { Attempt, RequestScope } from '@cortexkit/common-auth/opencode2'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
} from './adapter'
import { CacheKeepStore, type CacheKeepStoreOptions } from './cachekeep-store'
import type { NativeSource, NativeSourceProvenance } from './source'

export interface NativeCacheKeepOptions {
  readonly now?: () => number
  readonly setIntervalImpl?: typeof globalThis.setInterval
  readonly clearIntervalImpl?: typeof globalThis.clearInterval
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
}

/**
 * Tracked sessions for one account storage, shared by every plugin instance in
 * the host process that uses that storage. OpenCode 2 creates one plugin
 * instance per directory and disposes it when it evicts the directory or a
 * plugin file changes, so the tracked sessions must outlive any one instance.
 */
interface SharedCacheKeep {
  readonly manager: CacheKeepManager
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
    directory:
      options.registryDirectory ||
      process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR ||
      getDefaultCacheKeepRegistryDirectory('opencode'),
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
      if (lease && !isCacheKeepHybridActive(storage)) {
        for (const session of manager.trackedSessions())
          manager.untrack(session.id)
        shared.persistence.clear()
      }
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
        if (!isCacheKeepHybridActive(snapshot.policyStorage)) {
          shared.persistence.clear()
          return
        }
        const now = options.now?.() ?? Date.now()
        let overdue = 0
        await shared.persistence.load(now, (entry) => {
          // Disposal may race startup. Leave the file for the next live lease.
          if (!leases.size || manager.trackedRequest(entry.id)) return undefined
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
            retained: { cacheExpiresAt: entry.cacheExpiresAt, nextPrewarmAt },
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
      registry.publish(manager.trackedSessions()).catch(() => {
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
  const send = async (
    target: CacheKeepTarget,
    warm: Request,
    deadline?: AbortSignal,
  ) => {
    const signal = deadline
      ? AbortSignal.any([abort.signal, deadline])
      : abort.signal
    signal.throwIfAborted()
    const body = JSON.parse(await warm.text()) as { model: string }
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
    const native = createNativeAnthropicAdapter({
      source: {
        ...source,
        // Background sends must not extend a user turn's billing or diagnostics
        // chain, nor register themselves as fresh live-session activity.
        onRequestPrepared: undefined,
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
          signal.throwIfAborted()
          const account = snapshot.accounts.find((row) => row.id === accountId)
          if (account?.type !== 'oauth' || !nativeAccountCanServe(account))
            throw new NativeAccountRefusal('account-unavailable')
          if (accountKey(account) !== target.oauthAccountIdentity)
            throw new NativeAccountRefusal('credential-changed')
          if (
            (target.isSubagent &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
            !isCacheKeepHybridActive(snapshot.policyStorage) ||
            !isCacheKeepActiveNow(
              snapshot.policyStorage,
              new Date(options.now?.() ?? Date.now()),
            )
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
          const account = snapshot.accounts.find(
            (row) => row.id === input.accountId,
          )
          signal.throwIfAborted()
          if (!account) throw new NativeAccountRefusal('account-unavailable')
          if (accountKey(account) !== target.oauthAccountIdentity)
            throw new NativeAccountRefusal('credential-changed')
          if (
            (target.isSubagent &&
              !isCacheKeepSubagentsEnabled(snapshot.policyStorage)) ||
            !isCacheKeepHybridActive(snapshot.policyStorage) ||
            !isCacheKeepActiveNow(
              snapshot.policyStorage,
              new Date(options.now?.() ?? Date.now()),
            )
          )
            throw new Error('CacheKeep policy changed before dispatch')
        },
      },
    })
    let attempt:
      | Attempt<NativeAnthropicAttemptData<NativeSourceProvenance>>
      | undefined
    let status: number | undefined
    let complete = false
    const cancel = () => native.forgetSession(scope.sessionID)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const snapshot = await runtime.read()
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
      const physical = await (options.fetch ?? fetch)(request)
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
      complete = true
      return new Response(bytes, { status, headers: response.headers })
    } catch (error) {
      const refusal = nativeAccountRefusal(error)
      if (refusal) throw refusal
      // The manager's transport headers contain only a correlation ID, so its
      // generic error scrubber cannot know the native send's credentials.
      throw new Error('Native CacheKeep was not completed')
    } finally {
      signal.removeEventListener('abort', cancel)
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
  }
  const adopting = owner.leases.size === 0
  owner.leases.set(lease.generation, lease)
  const ready = adopting ? owner.adopt() : (owner.loading ?? Promise.resolve())
  let cleanup: Promise<void> | undefined
  return {
    ready,
    async track(
      input: Parameters<NonNullable<NativeSource['onRequestPrepared']>>[0],
    ) {
      // These skips are normal (API-key routes, prewarms, subagents, policy
      // off) and keep any existing target, so they stay at debug and do no
      // per-request work beyond the log call.
      const skipped = (reason: string) => {
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
      const snapshot = await runtime.read()
      if (lease.stopped) return skipped('lease-stopped')
      if (!isCacheKeepHybridActive(snapshot.policyStorage)) {
        for (const session of manager.trackedSessions())
          manager.untrack(session.id)
        owner.persistence.clear()
        return skipped('hybrid-inactive')
      }
      let isSubagent = false
      try {
        isSubagent = (await options.isSubagent?.(input.sessionID)) ?? false
      } catch {
        // A missing host session record cannot justify background spending.
        return skipped('session-lookup-failed')
      }
      if (lease.stopped) return skipped('lease-stopped')
      if (isSubagent && !isCacheKeepSubagentsEnabled(snapshot.policyStorage))
        return skipped('subagents-disabled')
      const account = snapshot.accounts.find(
        (row) => row.id === input.accountId,
      )
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
      const result = manager.track({
        sessionId: input.sessionID,
        url: input.url,
        headers: new Headers(),
        bodyText: input.bodyText,
        storage: snapshot.policyStorage,
        cacheMode: 'hybrid',
        oauthAccountId: input.accountId,
        oauthAccountIdentity: accountKey(account),
        isSubagent,
      })
      await registry.publish(manager.trackedSessions())
      // Core records each refusal or eviction, including its reason and sizes.
      return result
    },
    registry,
    dispose() {
      if (cleanup) return cleanup
      lease.stopped = true
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
