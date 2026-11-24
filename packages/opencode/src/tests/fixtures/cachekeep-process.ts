import { join } from 'node:path'
import {
  type AccountStorage,
  CACHE_KEEP_PREWARM_LEAD_MS,
  CacheKeepManager,
  type NativeAccountRuntime,
  type NativeAccountSnapshot,
  type NativeAccountView,
} from '@cortexkit/anthropic-auth-core'
import {
  adoptCacheKeepRestart,
  cacheKeepRestartCredential,
} from '../../cachekeep-restart.ts'
import { createNativeCacheKeep } from '../../v2/cachekeep.ts'
import type { CacheKeepStore } from '../../v2/cachekeep-store.ts'
import type { NativeSource } from '../../v2/source.ts'

export type Host = 'opencode1' | 'opencode2'
export const SESSION = 'ses_shared_restart'
const credentialId = 'synthetic-credential'
const account: NativeAccountView = {
  id: 'main',
  type: 'oauth',
  source: 'vault',
  enabled: true,
  state: 'active',
  accountIdentity: 'synthetic-identity',
  credentialId,
}
const storage: AccountStorage = {
  version: 1,
  accounts: [],
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: { enabled: true, always: true },
}
const read = async () =>
  ({ accounts: [account], policyStorage: storage }) as NativeAccountSnapshot
const bodyText = JSON.stringify({
  model: 'claude-sonnet-4-6',
  max_tokens: 8,
  system: [
    {
      type: 'text',
      text: 'Shared prefix',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ],
  messages: [{ role: 'user', content: 'Hello' }],
})

export async function openKeeper(
  host: Host,
  storageId: string,
  root: string,
  now: () => number,
) {
  let sent = 0
  const fetchImpl = Object.assign(
    async () => {
      sent++
      return Response.json({ usage: { cache_read_input_tokens: 1500 } })
    },
    { preconnect: fetch.preconnect },
  )
  const url = 'https://api.anthropic.com/v1/messages'
  if (host === 'opencode1') {
    const identity = cacheKeepRestartCredential(
      'vault',
      account.accountIdentity,
      account.credentialId,
    )
    const manager = new CacheKeepManager({
      now,
      loadStorage: async () => storage,
      onTargetChanged: (target) => lease.changed(target),
      onTargetRemoved: (id) => lease.removed(id),
      reserveWarm: (target) => lease.reserve(target),
      settleWarm: (target) => lease.settle(target),
      fetchImpl,
    })
    const lease = adoptCacheKeepRestart(storageId, {
      manager,
      read,
      allowUrl: () => true,
      now,
    })
    await lease.restore()
    return {
      manager,
      sent: () => sent,
      prepare: async (prompt = 'Hello') =>
        manager.track({
          sessionId: SESSION,
          url,
          headers: new Headers(),
          bodyText: bodyText.replace('Hello', prompt),
          storage,
          cacheMode: 'hybrid',
          oauthAccountId: account.id,
          hostMetadata: { restartCredential: identity },
        }),
      dispose: lease.dispose,
      forget: () => lease.forget(SESSION, true),
    }
  }
  const source: Pick<NativeSource, 'chooseAccount' | 'authorizeAccount'> = {
    chooseAccount: () => account.id,
    authorizeAccount: async () => ({
      route: 'oauth',
      accessToken: 'sk-ant-oat01-synthetic',
      credentialId,
      provenance: { kind: 'vault', credentialId, recordVersion: 1 },
    }),
  }
  const keeper = createNativeCacheKeep({
    now,
    storageId,
    persistence: { root, now },
    registryDirectory: join(root, `registry-${process.pid}`),
    fetch: fetchImpl,
    runtime: { read } as NativeAccountRuntime,
    source: source as NativeSource,
  })
  await keeper.ready
  const key = Symbol.for('cortexkit.anthropic-auth.opencode2.cachekeep.v3')
  const copies = (
    (globalThis as Record<symbol, unknown>)[key] as Map<
      string,
      Map<symbol, { manager: CacheKeepManager; persistence: CacheKeepStore }>
    >
  ).get(storageId)
  const owner = copies?.values().next().value
  if (!owner) throw new Error('OpenCode 2 did not start a keep-warm owner')
  return {
    manager: owner.manager,
    sent: () => sent,
    async prepare(prompt = 'Hello') {
      const attemptId = 'synthetic-attempt'
      await keeper.track({
        attemptId,
        sessionID: SESSION,
        kind: 'primary',
        agent: 'build',
        route: 'oauth',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-6',
        transport: 'http',
        dispatch: 'direct',
        url,
        bodyText: bodyText.replace('Hello', prompt),
        accountId: account.id,
        provenance: { kind: 'vault', credentialId, recordVersion: 1 },
      })
      return keeper.onResponseHeaders({ attemptId, status: 200 })
    },
    dispose: keeper.dispose,
    forget: () => {
      keeper.forgetSession(SESSION)
      keeper.sessionDeleted(SESSION)
    },
  }
}

if (import.meta.main) {
  const [host, storageId, root, startAt, action] = process.argv.slice(2) as [
    Host,
    string,
    string,
    string,
    string?,
  ]
  let now = Number(startAt)
  const keeper = await openKeeper(host, storageId, root, () => now)
  if (action === 'turn') {
    const result = await keeper.prepare('A new real turn')
    if (!result?.tracked) throw new Error('Real turn was not tracked')
    now += 60 * 60_000 - CACHE_KEEP_PREWARM_LEAD_MS + 1
  }
  const tracked = keeper.manager.trackedCount()
  await keeper.manager.tick()
  process.send?.({ tracked, sent: keeper.sent() })
  const finish = await Bun.stdin.text()
  if (finish === 'delete') keeper.forget()
  if (finish === 'untrack') keeper.manager.untrack(SESSION)
  await keeper.dispose()
}
