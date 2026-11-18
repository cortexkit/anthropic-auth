import {
  acquireRefreshFileLock,
  PrivateFileError,
  type RefreshFileLock,
} from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS, type PoolLoad } from '@cortexkit/common-auth/store'
import {
  type NativeLockEvent,
  nativeLockObserver,
} from './native-lock-observer.ts'

import {
  type NativePoolStorePaths,
  nativePoolStoreLocks,
} from './pool-store.ts'

const TRANSIENT_ACCOUNT_MESSAGE =
  'Anthropic account update in progress; retry the request'

// Errors this module constructed. A host recognizes the error by this brand
// rather than by its prototype chain, so a caught value whose prototype or
// properties were forged (for example a provider error object) is never
// mistaken for it.
const transientAccountErrors = new WeakSet<object>()

/**
 * An account update prevented a request from reading or authorizing the account
 * within its short wait budget. The shared write or refresh may still finish.
 *
 * The request should be retried. `code: 'ECONNRESET'` is how this package
 * marks an error retryable for its hosts. A host must surface it rather than
 * route the request to a different account, because that account was not the
 * one routing selected. The message is fixed and names no account.
 */
export class NativeTransientAccountError extends Error {
  declare readonly code: 'ECONNRESET'
  declare readonly syscall: 'native-account-update'
  declare readonly poolRead?: true

  constructor(operation?: 'pool-read') {
    super(TRANSIENT_ACCOUNT_MESSAGE)
    const fixed = {
      name: 'NativeTransientAccountError',
      message: TRANSIENT_ACCOUNT_MESSAGE,
      code: 'ECONNRESET',
      syscall: 'native-account-update',
      ...(operation === 'pool-read' && { poolRead: true }),
    }
    for (const [key, value] of Object.entries(fixed))
      Object.defineProperty(this, key, {
        value,
        enumerable: key === 'code' || key === 'syscall',
        writable: false,
        configurable: false,
      })
    transientAccountErrors.add(this)
  }
}

/** True only for an error Core itself constructed as NativeTransientAccountError. */
export function isNativeTransientAccountError(
  value: unknown,
): value is NativeTransientAccountError {
  return (
    typeof value === 'object' &&
    value !== null &&
    transientAccountErrors.has(value)
  )
}

export async function readNativePool(
  read: Promise<PoolLoad>,
): Promise<PoolLoad> {
  const result = await readNativePoolSettings(read)
  if (
    result.status === 'error' &&
    result.kind === 'snapshot-contended' &&
    result.retryable
  )
    throw new NativeTransientAccountError('pool-read')
  return result
}

export async function readNativePoolSettings<T>(read: Promise<T>): Promise<T> {
  try {
    return await read
  } catch (error) {
    // Only the Windows read errors associated with an atomic replace qualify.
    // Access denied and other policy or I/O failures must still surface intact.
    if (
      error instanceof PrivateFileError &&
      error.stage === 'read' &&
      error.reason === 'io-error' &&
      (error.win32Code === 32 || error.win32Code === 303)
    )
      throw new NativeTransientAccountError('pool-read')
    throw error
  }
}

/**
 * Bound the rare wait for a pool write. Once this budget expires, the
 * request fails retryably instead of waiting indefinitely or changing accounts.
 */
const NATIVE_POOL_WRITE_JOIN_BUDGET_MS = 2_000

/**
 * Wait until no writer holds the pool's store locks, then let them go.
 *
 * Takes the config lock and then the state lock, in the order every pool
 * writer takes them, and releases both (state first) as soon as both are
 * held, without doing anything while holding them. A writer holds both locks
 * across its state-file and config-file writes, so once both have been
 * acquired the earlier write has finished. A writer can start again after
 * release, so the caller rereads the pool and checks for another partially
 * saved row.
 *
 * Returns 'deadline' when the locks could not be taken within the total
 * budget. Each wait between attempts ends early when any of `signals`
 * aborts; `check` is then called after the leases are released and is
 * expected to throw the caller's cancellation error. `check` runs before
 * every attempt too, so a cancelled caller never takes a lock. All pool
 * leases use wall time, independently of logical observation timestamps.
 */
export async function joinNativePoolWrite(
  paths: NativePoolStorePaths,
  signals: readonly AbortSignal[],
  check: () => void,
  onLockEvent?: (event: NativeLockEvent) => void,
): Promise<'joined' | 'deadline'> {
  const observer = nativeLockObserver(onLockEvent)
  // Wall-clock adjustments must not change the total wait budget.
  const started = performance.now()
  const remaining = () =>
    NATIVE_POOL_WRITE_JOIN_BUDGET_MS - (performance.now() - started)
  const held: RefreshFileLock[] = []
  let outcome: 'joined' | 'deadline' = 'joined'
  let failure: { error: unknown } | undefined
  try {
    for (const lock of nativePoolStoreLocks(paths)) {
      for (;;) {
        check()
        // Never start an acquisition once the budget is spent, including the
        // second lock's first attempt.
        if (remaining() <= 0) {
          outcome = 'deadline'
          break
        }
        observer?.({ type: 'acquiring', path: lock.path, name: lock.name })
        const lease = await acquireRefreshFileLock({
          path: lock.path,
          name: lock.name,
          ttlMs: POOL_LOCK_DEFAULTS.ttlMs,
          renew: false,
        })
        if (lease) {
          held.push(lease)
          observer?.({ type: 'acquired', path: lock.path, name: lock.name })
        }
        // An acquisition that finished after the budget ran out does not
        // count: a writer that released that late is reported as too slow.
        if (remaining() <= 0) {
          outcome = 'deadline'
          break
        }
        if (lease) break
        await pause(Math.min(POOL_LOCK_DEFAULTS.retryMs, remaining()), signals)
      }
      if (outcome === 'deadline') break
    }
  } catch (error) {
    failure = { error }
  }
  // Release each lease on its own, newest first, even if an earlier release
  // fails, so a failed release never leaves the other lock held.
  let releaseFailure: { error: unknown } | undefined
  for (const lease of held.reverse()) {
    const [released] = await Promise.allSettled([lease.release()])
    if (released.status === 'rejected')
      releaseFailure ??= { error: released.reason }
  }
  if (failure) throw failure.error
  if (releaseFailure) throw releaseFailure.error
  // A cancellation that arrived while the last lease was being taken is
  // reported now that nothing is held.
  check()
  return outcome
}

/**
 * Resolve after `ms`, or as soon as any signal aborts. Listeners are added
 * per signal and removed on wake, so no combined signal is needed and
 * nothing outlives the wait.
 */
function pause(ms: number, signals: readonly AbortSignal[]): Promise<void> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve()
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      for (const signal of signals) signal.removeEventListener('abort', wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    for (const signal of signals)
      signal.addEventListener('abort', wake, { once: true })
  })
}
