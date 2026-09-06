import * as core from '@cortexkit/anthropic-auth-core'

type Lock = { release: () => Promise<void> }

type LiveCacheCredential = {
  credentialId: string
  recordVersion: number
  access: string
  refresh: string
  expiresAt: number
  state: 'usable' | 'revoked' | 'reauth' | 'timeout'
}

type LiveRoute = {
  id: string
  label?: string
  type: string
  enabled?: boolean
  local?: unknown
  claustrumHandle?: string
}

function retainLock(
  acquire: (fn: () => Promise<void>) => Promise<unknown>,
): Promise<Lock> {
  return new Promise((resolve, reject) => {
    void acquire(async () => {
      await new Promise<void>((done) =>
        resolve({ release: async () => done() }),
      )
    }).catch(reject)
  })
}

export function createLiveCustodyDeps(input: {
  storagePath: string
  cache: {
    get: (handle: string, minTtlMs?: number) => Promise<LiveCacheCredential>
  }
  latestGetAuth: () => Promise<unknown>
  now: number | (() => number)
  fallbackManager?: Pick<core.FallbackAccountManager, 'withAccountRefreshLock'>
  storage?: core.AccountStorage | null
}) {
  const inputNow = input.now
  const now = typeof inputNow === 'function' ? inputNow : () => inputNow
  const fallbackManager = input.fallbackManager
  const manifestPath = core.resolveCustodyHandlesPath(
    input.storage?.claustrum,
    process.env,
  )
  const manifestReader = new core.CustodyHandleManifestReader({
    path: manifestPath,
    provider: 'anthropic',
    serve: 'anthropic-auth',
  })

  return {
    hostAuth: { get: input.latestGetAuth },
    manifestPath,
    async readBindings(routes: LiveRoute[]) {
      const result = await manifestReader.read()
      const manifest = result.status === 'ready' ? result.manifest : undefined
      return routes.flatMap((route) => {
        const resolution = core.resolveCustodyHandle({
          account: {
            id: route.id,
            label: route.label,
            type: 'oauth',
            refresh: '',
            claustrumHandle: route.claustrumHandle,
          },
          manifest,
        })
        if (
          resolution.status !== 'resolved' ||
          resolution.source !== 'manifest'
        )
          return []
        return [
          {
            accountId: route.id,
            label: route.label ?? route.id,
            handle: resolution.handle,
            credentialId: resolution.credentialId,
          },
        ]
      })
    },
    cache: {
      get: (handle: string, options: { minTtlMs: number }) =>
        input.cache.get(handle, options.minTtlMs),
    },
    async preflightInput(
      main: Pick<LiveRoute, 'id' | 'label' | 'enabled'>,
      fallbacks: LiveRoute[],
    ) {
      const storage =
        input.storage ?? (await core.loadAccounts(input.storagePath))
      return {
        now: now(),
        storage,
        main,
        fallbacks,
        hostAuth: { get: input.latestGetAuth },
        bindings: await this.readBindings([
          { ...main, type: 'oauth' },
          ...fallbacks,
        ]),
        cache: this.cache,
      }
    },
    locks: {
      storagePath: input.storagePath,
      manifestPath,
      acquireTransition: ({ name, path }: { name: string; path: string }) =>
        core.acquireRefreshFileLock({
          name,
          path,
          ttlMs: 5 * 60_000,
          now,
          renew: true,
        }),
      acquireManifest: ({ path }: { path: string }) =>
        retainLock((fn) => core.withCustodyManifestLock(path, fn)),
      acquireRefresh: ({ name, path }: { name: string; path: string }) =>
        name === 'main-refresh' || !fallbackManager
          ? core.acquireRefreshFileLock({
              name,
              path,
              ttlMs: 5 * 60_000,
              now,
              renew: true,
            })
          : retainLock((fn) =>
              fallbackManager.withAccountRefreshLock(
                name.replace(/-refresh$/, ''),
                fn,
              ),
            ),
      withFallbackRefreshLock: <T>(accountId: string, fn: () => Promise<T>) => {
        if (fallbackManager)
          return fallbackManager.withAccountRefreshLock(accountId, fn)
        return fn()
      },
    },
  }
}
