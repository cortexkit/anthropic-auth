import {
  type OpenPoolStoreOptions,
  openPoolStore,
} from '@cortexkit/common-auth/store'

import type { NativePoolPaths } from './pool-paths.ts'

interface NativeQuotaCodec {
  validate(value: unknown): boolean
  merge(stored: unknown | undefined, observation: unknown): unknown
}

export interface NativePoolStoreOptions
  extends Pick<
    OpenPoolStoreOptions,
    'now' | 'onStep' | 'hold' | 'logger' | 'onLockEvent' | 'onLockStep'
  > {
  paths: NativePoolPaths
  quota: NativeQuotaCodec
}

/**
 * Pool and native-runtime writers share these locks when they reconcile an
 * account binding. The new namespace has no legacy credential writer.
 */
export function nativePoolStoreLocks(paths: NativePoolPaths) {
  return [
    { path: paths.config, name: 'pool-config' },
    { path: paths.state, name: 'pool-state' },
  ] as const
}

/**
 * Internal storage machinery, not a startup or migration authorization. Native
 * dispatch also requires the offline migration's committed authority journal.
 */
export function createNativePoolStore(options: NativePoolStoreOptions) {
  return openPoolStore({
    provider: 'anthropic',
    configPath: options.paths.config,
    statePath: options.paths.state,
    storeLocks: nativePoolStoreLocks(options.paths),
    requireCredentialStamps: true,
    quota: options.quota,
    now: options.now,
    onStep: options.onStep,
    hold: options.hold,
    logger: options.logger,
    onLockEvent: options.onLockEvent,
    onLockStep: options.onLockStep,
  })
}
