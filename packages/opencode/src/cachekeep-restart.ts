import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type CacheKeepManager,
  CacheKeepStore,
  type CacheKeepTarget,
  CacheKeepWarmRefusal,
  isCacheKeepSubagentsEnabled,
  localMessageThreadCredential,
  logger,
  type NativeAccountSnapshot,
  nativeAccountCanServe,
  readSessionCachePolicy,
} from '@cortexkit/anthropic-auth-core'
import { version as pluginVersion } from '../package.json'

const RESTORE_SPACING_MS = 3000
const SLOT = Symbol.for('cortexkit.anthropic-auth.opencode1.cachekeep-restore')

type Lease = {
  manager: CacheKeepManager
  read: () => Promise<NativeAccountSnapshot>
  allowUrl: (url: string) => boolean
  now: () => number
}

type Shared = {
  store: CacheKeepStore
  leases: Set<Lease>
  owners: Map<string, Lease>
  restored: Set<string>
  skippedDuringLoad: Set<string>
  loading?: Promise<void>
  closing: number
  lastRestoredSend: number
}

function stores(): Map<string, Shared> {
  const scope = globalThis as typeof globalThis & {
    [SLOT]?: Map<string, Shared>
  }
  scope[SLOT] ??= new Map()
  return scope[SLOT]
}

const sessionHash = (id: string) =>
  createHash('sha256').update(id).digest('hex')

/** The restart credential key survives token refresh, but not a replaced login. */
export function cacheKeepRestartCredential(
  source: 'local' | 'vault',
  identity: string | undefined,
  credential: string | undefined,
): string | undefined {
  return identity && credential
    ? JSON.stringify([source, identity, credential])
    : undefined
}

function restore(shared: Shared): Promise<void> {
  shared.loading ??= (async () => {
    const lease = shared.leases.values().next().value
    if (!lease) return
    // A fresh installation has nothing to restore. Avoid starting the account
    // runtime just to discover that it has never saved a warm.
    const stat = await lstat(shared.store.directory).catch(() => undefined)
    if (!stat?.isDirectory()) return
    const snapshot = await lease.read()
    const accounts = new Map(
      snapshot.accounts
        .filter(
          (account) =>
            account.type === 'oauth' && nativeAccountCanServe(account),
        )
        .map(
          (account) =>
            [
              cacheKeepRestartCredential(
                account.source,
                account.accountIdentity,
                account.binding
                  ? localMessageThreadCredential(account.binding)
                  : account.credentialId,
              ),
              account,
            ] as const,
        ),
    )
    const now = lease.now()
    let overdue = 0
    const mayRestore = (hash: string) =>
      shared.leases.has(lease) &&
      !shared.owners.has(hash) &&
      !shared.skippedDuringLoad.has(hash)

    await shared.store.load(
      now,
      (entry) => {
        const hash = sessionHash(entry.id)
        if (!mayRestore(hash)) return undefined
        if (entry.cacheExpiresAt <= lease.now()) return 'expired'
        if (!lease.allowUrl(entry.url)) return 'invalid'
        const account = accounts.get(entry.oauthAccountIdentity)
        if (!account) return 'account-gone'
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

        const tracked = lease.manager.track({
          sessionId: entry.id,
          url: entry.url,
          headers: new Headers(),
          bodyText: entry.bodyText,
          storage: snapshot.policyStorage,
          cacheMode: 'hybrid',
          oauthAccountId: account.id,
          oauthAccountIdentity: account.accountIdentity,
          hostMetadata: { restartCredential: entry.oauthAccountIdentity },
          isSubagent: entry.isSubagent,
          retained: {
            cacheExpiresAt: entry.cacheExpiresAt,
            nextPrewarmAt:
              entry.nextPrewarmAt <= now
                ? now + overdue++ * RESTORE_SPACING_MS
                : entry.nextPrewarmAt,
            ttlMs: entry.ttlMs,
            lastTouchAt: entry.lastTouchAt,
            lastTouchKind: entry.lastTouchKind,
            policyState: entry.policyState,
          },
        })
        if (tracked.tracked) shared.restored.add(hash)
        return tracked.tracked ? true : 'invalid'
      },
      undefined,
      mayRestore,
    )
  })()
    .catch(() => {
      logger.warn('cachekeep', 'failed to restore tracked sessions')
    })
    .finally(() => {
      shared.loading = undefined
      shared.skippedDuringLoad.clear()
    })
  return shared.loading
}

/** One writer and one owner per session, even when OpenCode opens several projects. */
export function adoptCacheKeepRestart(storageId: string, lease: Lease) {
  const slots = stores()
  const shared: Shared = slots.get(storageId) ?? {
    store: new CacheKeepStore({
      storageId,
      pluginVersion,
      host: 'opencode1',
      now: lease.now,
    }),
    leases: new Set<Lease>(),
    owners: new Map(),
    restored: new Set<string>(),
    skippedDuringLoad: new Set<string>(),
    closing: 0,
    lastRestoredSend: 0,
  }
  slots.set(storageId, shared)
  shared.leases.add(lease)

  const active = () => shared.leases.has(lease)
  const persisted = (target: Readonly<CacheKeepTarget>) => {
    const credential = target.hostMetadata?.restartCredential
    return !target.sourceWarm && typeof credential === 'string'
      ? { ...target, oauthAccountIdentity: credential }
      : undefined
  }
  const reserve = (target: Readonly<CacheKeepTarget>) => {
    const entry = persisted(target)
    if (!entry) return Promise.resolve(true)
    if (!active() || shared.owners.get(sessionHash(target.id)) !== lease)
      return Promise.resolve(false)
    return shared.store.reserveWarm(entry)
  }

  return {
    active,
    restore: () => restore(shared),
    changed(target: Readonly<CacheKeepTarget>) {
      const entry = persisted(target)
      if (!entry || !active()) return
      const hash = sessionHash(target.id)
      const previous = shared.owners.get(hash)
      if (previous !== lease) {
        shared.owners.set(hash, lease)
        shared.restored.delete(hash)
        previous?.manager.releaseTarget(target.id)
      }
      shared.store.changed(entry)
    },
    removed(id: string) {
      const hash = sessionHash(id)
      if (shared.owners.get(hash) !== lease) return
      shared.owners.delete(hash)
      shared.restored.delete(hash)
      shared.store.removed(id)
    },
    forget(id: string) {
      const hash = sessionHash(id)
      if (shared.loading) shared.skippedDuringLoad.add(hash)
      const owner = shared.owners.get(hash)
      if (owner?.manager.untrack(id)) return
      if (owner || shared.loading) {
        shared.owners.delete(hash)
        shared.restored.delete(hash)
        shared.store.removed(id)
      }
    },
    reserve,
    settle: (target: Readonly<CacheKeepTarget>) =>
      lease.manager.isCurrentTarget(target)
        ? reserve(target)
        : Promise.resolve(false),
    async stagger(target: Readonly<CacheKeepTarget>, signal?: AbortSignal) {
      if (!shared.restored.delete(sessionHash(target.id))) return
      // A late scheduler pass can make several restored targets due at once.
      const now = lease.now()
      const sendAt = Math.max(now, shared.lastRestoredSend + RESTORE_SPACING_MS)
      shared.lastRestoredSend = sendAt
      if (sendAt > now) await delay(sendAt - now, undefined, { signal })
      if (target.cacheExpiresAt <= lease.now())
        throw new CacheKeepWarmRefusal('expired')
    },
    async dispose() {
      if (!shared.leases.delete(lease)) return
      shared.closing++
      try {
        await lease.manager.dispose()
        await shared.loading
        let released = false
        for (const [hash, owner] of shared.owners) {
          if (owner !== lease) continue
          shared.owners.delete(hash)
          shared.restored.delete(hash)
          released = true
        }
        await shared.store.drain()
        if (released && shared.leases.size > 0) await restore(shared)
      } finally {
        shared.closing--
        if (shared.leases.size === 0 && shared.closing === 0)
          slots.delete(storageId)
      }
    },
  }
}
