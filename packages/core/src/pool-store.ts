import {
  type OpenPoolStoreOptions,
  openPoolStore,
} from '@cortexkit/common-auth/store'

import {
  type NativeLockEvent,
  nativeLockObserver,
} from './native-lock-observer.ts'
import {
  nativeVaultFileAbsent,
  readNativeVaultLegacySettings,
} from './native-vault-seed.ts'
import type { NativePoolPaths } from './pool-paths.ts'

export type { NativeLockEvent } from './native-lock-observer.ts'

interface NativeQuotaCodec {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

export type NativePoolStorePaths = Pick<NativePoolPaths, 'config' | 'state'> & {
  legacySeedConfig?: string
}

export interface NativePoolStoreOptions
  extends Pick<
    OpenPoolStoreOptions,
    'now' | 'onStep' | 'hold' | 'logger' | 'onLockStep'
  > {
  paths: NativePoolStorePaths
  quota: NativeQuotaCodec
  onLockEvent?: (event: NativeLockEvent) => void
}

/**
 * These locks serialize pool transactions, including credential changes and
 * quota publication. Runtime bookkeeping has its own lock and binding checks.
 * Legacy sidecar writers use different files and locks.
 */
export function nativePoolStoreLocks(paths: NativePoolStorePaths) {
  return [
    { path: paths.config, name: 'pool-config' },
    { path: paths.state, name: 'pool-state' },
  ] as const
}

type DrainableStore = { close(): Promise<void> }

/**
 * Stores opened in this process, by state file, held weakly so a store that
 * is dropped without being closed is not kept alive. A state layout move
 * closes those of its dataset first, which commits their queued quota
 * readings under the store locks before any byte is copied.
 */
const openStores = new Map<string, Set<WeakRef<DrainableStore>>>()

function trackStore<T extends DrainableStore & { dispose(): Promise<void> }>(
  statePath: string,
  store: T,
): T {
  let refs = openStores.get(statePath)
  if (!refs) {
    refs = new Set()
    openStores.set(statePath, refs)
  }
  for (const ref of refs) if (!ref.deref()) refs.delete(ref)
  let tracked: T
  const forget = () => {
    for (const candidate of refs)
      if (candidate.deref() === tracked) refs.delete(candidate)
  }
  tracked = {
    ...store,
    close: async () => {
      forget()
      await store.close()
    },
    dispose: async () => {
      forget()
      await store.dispose()
    },
  }
  refs.add(new WeakRef(tracked))
  return tracked
}

/**
 * Close every store this process opened on one of `statePaths`. Closing
 * drains the store's coalesced quota writes (bounded by common-auth's drain
 * time) and makes later quota readings on it refuse. Returns how many were
 * closed; a failed close rejects.
 */
export async function drainNativePoolStores(
  statePaths: readonly string[],
): Promise<number> {
  let closed = 0
  for (const path of new Set(statePaths)) {
    const refs = openStores.get(path)
    if (!refs) continue
    for (const ref of [...refs]) {
      const store = ref.deref()
      refs.delete(ref)
      if (!store) continue
      await store.close()
      closed++
    }
    if (refs.size === 0) openStores.delete(path)
  }
  return closed
}

/**
 * Storage machinery only. Callers must separately establish local migration
 * authority or vault enrollment authority before using these files.
 */
export function createNativePoolStore(options: NativePoolStoreOptions) {
  return trackStore(options.paths.state, openNativePoolStore(options))
}

function openNativePoolStore(options: NativePoolStoreOptions) {
  const store = openPoolStore({
    provider: 'anthropic',
    configPath: options.paths.config,
    statePath: options.paths.state,
    storeLocks: nativePoolStoreLocks(options.paths),
    requireCredentialStamps: true,
    coalesceQuota: true,
    quota: options.quota,
    now: options.now,
    onStep: options.onStep,
    hold: options.hold,
    logger: options.logger,
    onLockEvent: nativeLockObserver(options.onLockEvent),
    onLockStep: options.onLockStep,
  })
  const legacyConfig = options.paths.legacySeedConfig
  if (!legacyConfig) return store
  return {
    ...store,
    updateSettings: ((mutator, callOptions) =>
      store.updateSettings(async (draft) => {
        // The config/state file locks are held while creating vault settings.
        // Write legacy preferences together with the discovered default account's
        // route and UUID; any existing settings file prevents later imports.
        if (await nativeVaultFileAbsent(options.paths.config))
          Object.assign(
            draft,
            await readNativeVaultLegacySettings(legacyConfig),
          )
        return mutator(draft)
      }, callOptions)) satisfies typeof store.updateSettings,
  }
}
