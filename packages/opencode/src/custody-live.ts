import { readFile, rm, writeFile } from 'node:fs/promises'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  type ClaustrumTakeoverPlan,
  type CustodySidecarSnapshot,
  commitClaustrumMode,
  OPENCODE_MAIN_OAUTH_REFRESH_LOCK,
  reconcileCustodyStartup,
} from './custody-mode.ts'

type Lock = { release: () => Promise<void> }

type LiveCacheCredential = {
  credentialId: string
  recordVersion: number
  access: string
  refresh: string
  expiresAt: number
  state: 'usable' | 'revoked' | 'reauth' | 'timeout'
}

type RawCacheCredential = core.ClaustrumCredential | LiveCacheCredential

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

type ManifestLease = {
  assertLease: () => Promise<void>
  nonce: string
}

function retainManifestLock(
  path: string,
  setLease: (lease: ManifestLease | undefined) => void,
): Promise<Lock> {
  return new Promise((resolve, reject) => {
    void core
      .withCustodyManifestLock(path, async (assertLease, nonce) => {
        await new Promise<void>((done) => {
          setLease({ assertLease, nonce })
          resolve({
            release: async () => {
              setLease(undefined)
              done()
            },
          })
        })
      })
      .catch(reject)
  })
}

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function restoreBytes(path: string, bytes: Uint8Array | null) {
  if (bytes === null) {
    await rm(path, { force: true })
    return
  }
  await writeFile(path, bytes, { mode: 0o600 })
}

export function createLiveCustodyDeps(input: {
  storagePath: string
  cache: {
    get: (handle: string, minTtlMs?: number) => Promise<RawCacheCredential>
  }
  latestGetAuth: () => Promise<unknown>
  now: number | (() => number)
  fallbackManager?: Pick<core.FallbackAccountManager, 'withAccountRefreshLock'>
  storage?: core.AccountStorage | null
  writeManifestEntryLocked?: typeof core.writeCustodyHandleManifestEntryLocked
}) {
  const inputNow = input.now
  const now = typeof inputNow === 'function' ? inputNow : () => inputNow
  const fallbackManager = input.fallbackManager
  let storagePromise: Promise<core.AccountStorage | null> | undefined
  let manifestPath = core.resolveCustodyHandlesPath(
    input.storage?.claustrum,
    process.env,
  )
  let manifestReader: core.CustodyHandleManifestReader | undefined
  let manifestLease: ManifestLease | undefined
  const credentialIdsByHandle = new Map<string, string>()
  const loadStorage = () =>
    (storagePromise ??= Promise.resolve(
      input.storage ?? core.loadAccounts(input.storagePath),
    ))
  const loadManifestReader = async () => {
    const storage = await loadStorage()
    const path = core.resolveCustodyHandlesPath(storage?.claustrum, process.env)
    if (!manifestReader || path !== manifestPath) {
      manifestPath = path
      manifestReader = new core.CustodyHandleManifestReader({
        path,
        provider: 'anthropic',
        serve: 'anthropic-auth',
      })
    }
    return manifestReader
  }
  const getCredential = async (handle: string, minTtlMs: number) => {
    const credential = await input.cache.get(handle, minTtlMs)
    if ('state' in credential) return credential
    let payload: { access_token?: unknown; refresh_token?: unknown } = {}
    try {
      payload = JSON.parse(credential.payload)
    } catch {}
    return {
      credentialId: credentialIdsByHandle.get(handle) ?? '',
      recordVersion: credential.recordVersion,
      access:
        typeof payload.access_token === 'string' ? payload.access_token : '',
      refresh:
        typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
      expiresAt: credential.expiresAtMs ?? 0,
      state: 'usable' as const,
    }
  }

  return {
    hostAuth: { get: input.latestGetAuth },
    get manifestPath() {
      return manifestPath
    },
    async readBindings(routes: LiveRoute[]) {
      const result = await (await loadManifestReader()).read()
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
        if (resolution.status !== 'resolved') return []
        const credentialId =
          resolution.source === 'manifest'
            ? resolution.credentialId
            : core.custodyCredentialId(route.label ?? route.id)
        credentialIdsByHandle.set(resolution.handle, credentialId)
        return [
          {
            accountId: route.id,
            label: route.label ?? route.id,
            handle: resolution.handle,
            credentialId,
            source: resolution.source,
          },
        ]
      })
    },
    cache: {
      get: (handle: string, options: { minTtlMs: number }) =>
        getCredential(handle, options.minTtlMs),
    },
    async preflightInput(
      main: Pick<LiveRoute, 'id' | 'label' | 'enabled'>,
      fallbacks: LiveRoute[],
    ) {
      const storage = await loadStorage()
      return {
        now: now(),
        storage,
        main,
        fallbacks: fallbacks.map((fallback) => ({
          ...fallback,
          local: fallback.local ?? fallback,
        })),
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
      get manifestPath() {
        return manifestPath
      },
      acquireTransition: ({ name, path }: { name: string; path: string }) =>
        core.acquireRefreshFileLock({
          name,
          path,
          ttlMs: 5 * 60_000,
          now,
          renew: true,
        }),
      acquireManifest: ({ path }: { path: string }) =>
        retainManifestLock(path, (lease) => {
          manifestLease = lease
        }),
      acquireRefresh: ({ name, path }: { name: string; path: string }) =>
        name === OPENCODE_MAIN_OAUTH_REFRESH_LOCK || !fallbackManager
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
    takeoverDeps(plan: ClaustrumTakeoverPlan) {
      const readStrictBindings = async (plan: ClaustrumTakeoverPlan) => {
        const reader = new core.CustodyHandleManifestReader({
          path: manifestPath,
          provider: 'anthropic',
          serve: 'anthropic-auth',
        })
        const result = await reader.read()
        const manifest = result.status === 'ready' ? result.manifest : undefined
        return plan.accounts.map((account) => {
          const resolution = core.resolveCustodyHandle({
            account: {
              id: account.id,
              label: account.label,
              type: 'oauth',
              refresh: '',
            },
            manifest,
          })
          return resolution.status === 'resolved' &&
            resolution.source === 'manifest' &&
            resolution.handle === account.handle &&
            resolution.credentialId === account.credentialId
            ? resolution
            : undefined
        })
      }
      const verify = async (
        plan: ClaustrumTakeoverPlan,
        persistedMode: boolean,
      ) => {
        const storage = await core.loadAccounts(input.storagePath)
        if (!storage) return false
        const mainAuth = await input.latestGetAuth()
        if (!core.isCustodyTombstoneOAuth(mainAuth, 'anthropic')) return false
        const bindings = await readStrictBindings(plan)
        if (bindings.some((binding) => !binding)) return false
        for (const account of plan.accounts) {
          const credential = await getCredential(
            account.handle,
            core.getRefreshBeforeExpiryMs(storage) + 30 * 60_000,
          )
          if (
            credential.state !== 'usable' ||
            credential.credentialId !== account.credentialId ||
            credential.recordVersion < account.recordVersion ||
            credential.expiresAt <
              now() + core.getRefreshBeforeExpiryMs(storage) + 30 * 60_000
          )
            return false
          if (account.id === 'main') continue
          const fallback = storage.accounts.find(
            (candidate) => candidate.id === account.id,
          )
          if (!fallback || !core.isCustodyTombstoneOAuth(fallback, 'anthropic'))
            return false
        }
        if (
          reconcileCustodyStartup({
            mode: 'C',
            main: 'T',
            fallbacks: 'T',
            evidence: 'V',
          }).verdict !== 'CLAUSTRUM_SERVE'
        )
          return false
        if (!persistedMode) return true
        if (core.getClaustrumMode(storage) !== 'claustrum') return false
        return plan.accounts.every((account, index) => {
          const route =
            account.id === 'main'
              ? ({
                  id: 'main',
                  label: account.label,
                  type: 'oauth',
                  refresh: core.custodyTombstoneKey('anthropic'),
                  enabled: true,
                } as core.OAuthAccount)
              : storage.accounts.find(
                  (candidate) => candidate.id === account.id,
                )
          return Boolean(
            route &&
              core.isOAuthAccountVaultOwned(storage, route, bindings[index]),
          )
        })
      }
      return {
        locks: {
          ...this.locks,
          fallbackAccountIds: plan.accounts
            .filter((account) => account.id !== 'main')
            .map((account) => account.id),
        },
        getLocalAuth: async (accountId: string) => {
          if (accountId === 'main') return input.latestGetAuth()
          return (await core.loadAccounts(input.storagePath))?.accounts.find(
            (account) => account.id === accountId,
          )
        },
        isCommitted: (plan: ClaustrumTakeoverPlan) => verify(plan, true),
        snapshotSidecars: async (): Promise<CustodySidecarSnapshot> => ({
          config: await readBytes(input.storagePath),
          state: await readBytes(core.getAccountStatePath(input.storagePath)),
          manifest: await readBytes(manifestPath),
        }),
        writeManifestBindings: async (plan: ClaustrumTakeoverPlan) => {
          if (!manifestLease)
            throw new Error('custody manifest lock is not held')
          for (const account of plan.accounts) {
            // Main is installed by the operator so this process never rewrites the host-authoritative binding.
            if (account.id === 'main' || account.bindingPersisted) continue
            const result = await (
              input.writeManifestEntryLocked ??
              core.writeCustodyHandleManifestEntryLocked
            )(
              {
                path: manifestPath,
                entry: {
                  label: account.label,
                  handle: account.handle,
                  credentialId: account.credentialId,
                },
              },
              manifestLease.assertLease,
              manifestLease.nonce,
            )
            if (result.status !== 'written' && result.status !== 'unchanged')
              throw new Error('custody manifest write refused')
          }
        },
        writeSidecarAccount: async (
          account: ClaustrumTakeoverPlan['accounts'][number],
        ) => {
          const storage = await core.loadAccounts(input.storagePath)
          const fallback = storage?.accounts.find(
            (candidate): candidate is core.OAuthAccount =>
              candidate.id === account.id && core.isOAuthAccount(candidate),
          )
          if (!storage || !fallback) throw new Error('fallback missing')
          // Empty access prevents accidental local serving even though refresh alone defines the recognise-set.
          fallback.access = ''
          fallback.refresh = core.custodyTombstoneKey('anthropic')
          fallback.expires = 0
          await core.saveAccountState(storage, input.storagePath, {
            accounts: [account.id],
          })
        },
        verifyTarget: (plan: ClaustrumTakeoverPlan) => verify(plan, false),
        verifyCommitted: (plan: ClaustrumTakeoverPlan) => verify(plan, true),
        restoreSidecars: async (snapshot: CustodySidecarSnapshot) => {
          await restoreBytes(input.storagePath, snapshot.config)
          await restoreBytes(
            core.getAccountStatePath(input.storagePath),
            snapshot.state,
          )
          if (snapshot.manifest !== undefined)
            await restoreBytes(manifestPath, snapshot.manifest)
        },
        verifyRollback: async (snapshot: CustodySidecarSnapshot) =>
          Buffer.from((await readBytes(input.storagePath)) ?? []).equals(
            Buffer.from(snapshot.config ?? []),
          ) &&
          Buffer.from(
            (await readBytes(core.getAccountStatePath(input.storagePath))) ??
              [],
          ).equals(Buffer.from(snapshot.state ?? [])) &&
          (snapshot.manifest === undefined ||
            Buffer.from((await readBytes(manifestPath)) ?? []).equals(
              Buffer.from(snapshot.manifest ?? []),
            )),
        setMode: (_mode: 'claustrum') => commitClaustrumMode(input.storagePath),
      }
    },
  }
}
