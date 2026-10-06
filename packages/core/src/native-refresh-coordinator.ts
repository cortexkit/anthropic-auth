import { createHash } from 'node:crypto'

import {
  acquireRefreshFileLock,
  LockContentionError,
  type RefreshFileLock,
} from '@cortexkit/common-auth/fs'
import {
  fingerprintOf,
  POOL_LOCK_DEFAULTS,
  type PoolFailureKind,
  type PoolLockSpec,
  PoolOperationError,
  type PoolRow,
  type RefreshOutcome,
  type StoredCredential,
} from '@cortexkit/common-auth/store'

import { ClaudeOAuthRefreshError, refreshClaudeOAuthToken } from './auth.ts'
import { resolveClaudeCodeIdentity } from './claude-code.ts'
import { isTransientNetworkError } from './network-errors.ts'
import {
  isNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
  nativeLocalPoolBindingMatches,
  nativeLocalRefreshJobKey,
} from './pool-binding.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import {
  createNativePoolStore,
  type NativePoolStoreOptions,
} from './pool-store.ts'
import { tokenFingerprint } from './token-fingerprint.ts'

/**
 * Jobs distinguish credential replacements. This lock must still serialize
 * all refreshes for the same account.
 */
export function nativeAccountProviderLock(
  paths: NativePoolPaths,
  identity: string,
): PoolLockSpec {
  const key = createHash('sha256')
    .update(JSON.stringify([paths.storageId, identity]))
    .digest('hex')
  return {
    path: paths.state,
    name: `native-account-provider-${key}`,
    ...POOL_LOCK_DEFAULTS,
  }
}

export type NativeRefreshRestriction =
  | { status: 'allowed' }
  | {
      status: 'blocked'
      reason:
        | 'quota-ineligible'
        | 'account-disabled'
        | 'local-mode-unavailable'
        | 'identity-unproven'
    }
  | {
      status: 'blocked'
      reason: 'refresh-backoff' | 'invalid-grant'
      /**
       * Identifies the stored credential through fingerprintOf; never put a
       * bearer token or an access-token hash here.
       */
      credentialFingerprint: string
    }

export type NativeIdentityBootstrap = 'resolved' | 'unavailable' | 'failed'
export type NativeRefreshHandoff =
  | 'not-needed'
  | 'acquired'
  | 'skipped-contention'
  | 'skipped-loss'
  | 'skipped-cancelled'

export interface NativeRefreshFailure {
  kind: PoolFailureKind | 'caller-hook'
  classification: 'transient' | 'invalid-grant' | 'permanent'
  status?: number
  retryAfter?: number
}

/**
 * Access can change while the refresh token and credential epoch stay the
 * same. These fields identify the exact stored OAuth version observed.
 */
export interface NativeRefreshDispatchVersion {
  readonly accessFingerprint?: string
  readonly expires?: number
  readonly lastRefreshedAt?: number
}

interface ObservationBase {
  /**
   * Identifies the row, credential version and account before refresh. Compare
   * this binding with current store state before writing an observation.
   */
  binding: NativeLocalPoolBinding
  attempt: number
  credentialFingerprint?: string
  credentialVersion?: NativeRefreshDispatchVersion
  bootstrap: NativeIdentityBootstrap
  handoff: NativeRefreshHandoff
}

/** Token-free observations. In particular bootstrap exceptions are never forwarded. */
export type NativeRefreshObservation = ObservationBase &
  (
    | {
        status: 'persisted'
        identity?: string
        successorFingerprint: string
        successorVersion: NativeRefreshDispatchVersion
      }
    | {
        status: 'adopted'
        successorFingerprint: string
        successorVersion: NativeRefreshDispatchVersion
      }
    | { status: 'refused'; reason: string; consumed: boolean }
    | {
        status: 'identity-contradicted'
        expectedIdentity: string
        returnedIdentity: string
        successorFingerprint: string
        successorVersion: NativeRefreshDispatchVersion
      }
    | {
        status: 'failed'
        failure: NativeRefreshFailure
        persisted: boolean
        committedVersion?: NativeRefreshDispatchVersion
      }
  )

export interface NativeRefreshHooks {
  /**
   * Read current local-mode, account-disable, quota and refresh-error
   * restrictions from native state. Apply token-bound errors only to their
   * matching credential fingerprint. Also report when a previously persisted
   * successor still lacks account validation. Do not read host credentials or
   * mutate the store. This callback runs outside shared store locks.
   * Before exchange, capture the native error-clear markers for that
   * observation. Do not replace them when later policy reads return newer state.
   */
  readRestrictions(
    binding: NativeLocalPoolBinding,
  ): Promise<NativeRefreshRestriction>
  /**
   * Write credential-related refresh errors and validation state only while
   * holding pool-config, pool-state, then native-runtime locks. Re-read the
   * selected row and check its account/epoch, refresh fingerprint, and the
   * error-clear markers captured before the exchange. Check access fingerprint,
   * expiry and lastRefreshedAt too: credentialVersion identifies the credential
   * captured before the exchange; successorVersion identifies the pool
   * credential after a successful exchange or a concurrently completed
   * rotation; committedVersion identifies a replacement saved before a later
   * failure. Match the appropriate version before applying an observation. If
   * that version is unavailable or a clear marker changed, do not update
   * credential-related state. Newly learned identities apply only to the row
   * that received them. Clear stale token errors only after confirming the
   * replacement is saved or adopting a current credential from the pool. A
   * quarantined or unvalidated credential must not serve. Keep a saved
   * successor unvalidated if account checks failed. Reconciliation finishes
   * before refresh returns, outside shared store locks; ordinary row/provider
   * locks remain held. Do not re-enter row operations or wait for callers
   * joining this job.
   */
  reconcile(observation: NativeRefreshObservation): Promise<void>
}

export interface NativeRefreshCoordinatorOptions
  extends NativePoolStoreOptions,
    NativeRefreshHooks {
  refreshToken?: typeof refreshClaudeOAuthToken
  resolveIdentity?: typeof resolveClaudeCodeIdentity
}

export interface NativeRefreshRequest {
  mode: 'local' | 'claustrum'
  binding: NativeLocalPoolBinding
  /** A 401's dispatched access token, used only for replacement adoption. */
  rejectedAccessToken?: string
  signal?: AbortSignal
}

export type NativeRefreshResult =
  | {
      status: 'usable'
      source: 'rotated' | 'adopted'
      binding: NativeLocalPoolBinding
      /**
       * Read from the requesting row after the job completes. An alias must
       * not receive the credential refreshed for a different row.
       */
      access: string
      expires: number
    }
  | { status: 'refused'; reason: string; persisted: boolean }
  | {
      status: 'identity-contradicted'
      expectedIdentity: string
      returnedIdentity: string
      persisted: true
    }
  | {
      status: 'failed'
      error: Error
      persisted: boolean
      reconciliationFailed: boolean
    }

type JobResult =
  | {
      status: 'completed'
      source: 'rotated' | 'adopted'
      identity?: string
      proven: boolean
      persisted: boolean
    }
  | Exclude<NativeRefreshResult, { status: 'usable' }>

interface Job {
  keys: Set<string>
  promise: Promise<JobResult>
}

// Shared by every platform/coordinator instance in this process. Deletion is
// compare-and-delete: an old job can never dispose a successor registration.
const jobs = new Map<string, Job>()

function unregister(job: Job, key: string) {
  if (jobs.get(key) === job) jobs.delete(key)
  job.keys.delete(key)
}

function failureOf(error: Error): NativeRefreshFailure {
  const cause = error instanceof PoolOperationError ? error.cause : error
  const kind = error instanceof PoolOperationError ? error.kind : 'caller-hook'
  if (cause instanceof ClaudeOAuthRefreshError) {
    const invalidGrant = /\binvalid_grant\b/.test(cause.body)
    return {
      kind,
      classification: invalidGrant
        ? 'invalid-grant'
        : cause.status === 429 || cause.status >= 500
          ? 'transient'
          : 'permanent',
      status: cause.status,
      ...(cause.retryAfter !== undefined
        ? { retryAfter: cause.retryAfter }
        : {}),
    }
  }
  return {
    kind,
    classification:
      kind === 'provider' && isTransientNetworkError(cause)
        ? 'transient'
        : 'permanent',
  }
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('Native refresh callback failed', { cause: error })
}

function dispatchVersion(
  credential: StoredCredential,
): NativeRefreshDispatchVersion {
  if (credential.type !== 'oauth')
    throw new Error('Local refresh requires an OAuth credential')
  return Object.freeze({
    accessFingerprint: credential.access
      ? tokenFingerprint(credential.access)
      : undefined,
    expires: credential.expires,
    lastRefreshedAt: credential.lastRefreshedAt,
  })
}

class LocalRefreshRefusal extends Error {
  constructor(readonly reason: string) {
    super('Local refresh policy refused the exchange')
  }
}

function restrictionReason(
  restriction: NativeRefreshRestriction,
  fingerprint?: string,
) {
  if (restriction.status === 'allowed') return undefined
  if (
    restriction.reason !== 'refresh-backoff' &&
    restriction.reason !== 'invalid-grant'
  )
    return restriction.reason
  return restriction.credentialFingerprint === fingerprint
    ? restriction.reason
    : undefined
}

function sameDispatch(left: PoolRow, right: PoolRow): boolean {
  const a = left.credential
  const b = right.credential
  return (
    a?.type === 'oauth' &&
    b?.type === 'oauth' &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires
  )
}

function exhaustive(outcome: never): never {
  throw new Error(`Unsupported refresh outcome: ${String(outcome)}`)
}

/** Independent local machinery: construction performs no network or migration. */
export function createNativeRefreshCoordinator(
  options: NativeRefreshCoordinatorOptions,
) {
  const store = createNativePoolStore(options)
  const now = options.now ?? Date.now
  const provider = options.refreshToken ?? refreshClaudeOAuthToken
  const bootstrap = options.resolveIdentity ?? resolveClaudeCodeIdentity

  async function rowFor(binding: NativeLocalPoolBinding) {
    const read = await store.read()
    return read.status === 'ready'
      ? read.rows.find((row) => row.id === binding.rowId)
      : undefined
  }

  async function handoffLock(identity: string): Promise<RefreshFileLock> {
    const spec = nativeAccountProviderLock(options.paths, identity)
    const started = performance.now()
    for (;;) {
      const lock = await acquireRefreshFileLock({
        name: spec.name,
        path: spec.path,
        ttlMs: POOL_LOCK_DEFAULTS.ttlMs,
        renew: true,
        now,
        onStep: options.onLockStep
          ? (step) => options.onLockStep?.(spec, step)
          : undefined,
      })
      if (lock) {
        try {
          await lock.assertOwned()
          options.onLockEvent?.({
            type: 'acquired',
            name: spec.name,
            path: spec.path,
          })
          return lock
        } catch (error) {
          await lock.release().catch(() => {})
          try {
            options.onLockEvent?.({
              type: 'released',
              name: spec.name,
              path: spec.path,
            })
          } catch {
            /* Ignore observer failures; notification callbacks must not decide
             * whether the lock owner can refresh a token. */
          }
          throw error
        }
      }
      const remaining =
        POOL_LOCK_DEFAULTS.timeoutMs - (performance.now() - started)
      if (remaining <= 0)
        throw new LockContentionError({
          target: spec.path,
          name: spec.name,
          timeoutMs: POOL_LOCK_DEFAULTS.timeoutMs,
        })
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POOL_LOCK_DEFAULTS.retryMs, remaining)),
      )
    }
  }

  async function run(
    job: Job,
    request: NativeRefreshRequest,
  ): Promise<JobResult> {
    const binding = request.binding
    let attempt = 0
    let consumed = false
    let persisted = false
    let identity: string | undefined
    let bootstrapStatus: NativeIdentityBootstrap = 'unavailable'
    let handoff: NativeRefreshHandoff = 'not-needed'
    let fingerprint: string | undefined
    let credentialVersion: NativeRefreshDispatchVersion | undefined
    let committedVersion: NativeRefreshDispatchVersion | undefined
    let held: RefreshFileLock | undefined
    let releasing: Promise<void> | undefined
    let removeAbortListener: (() => void) | undefined
    let aliasKey: string | undefined
    let reconciliationFailed = false

    function identityProven() {
      return bootstrapStatus === 'resolved'
    }

    function observation(): ObservationBase {
      return {
        binding,
        attempt,
        credentialFingerprint: fingerprint,
        credentialVersion,
        bootstrap: bootstrapStatus,
        handoff,
      }
    }

    async function reconcile(event: NativeRefreshObservation) {
      try {
        await options.reconcile(event)
      } catch (error) {
        reconciliationFailed = true
        throw error
      }
    }

    async function releaseHandoff() {
      const lock = held
      held = undefined
      removeAbortListener?.()
      removeAbortListener = undefined
      if (lock) {
        releasing = (async () => {
          await lock.release().catch(() => {})
          if (identity) {
            const spec = nativeAccountProviderLock(options.paths, identity)
            try {
              options.onLockEvent?.({
                type: 'released',
                name: spec.name,
                path: spec.path,
              })
            } catch {
              /* A failed lock-event notification must not discard a replacement
               * credential after the refresh token was consumed. */
            }
          }
        })()
      }
      await releasing
    }

    async function skipLostHandoff() {
      handoff = 'skipped-loss'
      if (aliasKey) unregister(job, aliasKey)
      await releaseHandoff()
    }

    try {
      for (attempt = 1; attempt <= 3; attempt++) {
        consumed = false
        let endpointCalled = false
        bootstrapStatus = 'unavailable'
        handoff = 'not-needed'
        const restriction = await options.readRestrictions(binding)
        let captured: PoolRow | undefined
        const seen = await rowFor(binding)
        fingerprint = seen?.fingerprint
        credentialVersion =
          seen?.credential?.type === 'oauth'
            ? dispatchVersion(seen.credential)
            : undefined
        const initialReason =
          !seen || !nativeLocalPoolBindingMatches(binding, options.paths, seen)
            ? 'binding-changed'
            : request.signal?.aborted
              ? 'cancelled'
              : !seen.candidate || !seen.enabled
                ? 'row-ineligible'
                : restrictionReason(restriction, seen.fingerprint)
        if (initialReason) {
          await reconcile({
            ...observation(),
            status: 'refused',
            reason: initialReason,
            consumed: false,
          })
          return { status: 'refused', reason: initialReason, persisted: false }
        }
        if (
          binding.identity !== undefined &&
          request.rejectedAccessToken !== undefined &&
          seen?.credential?.type === 'oauth' &&
          seen.credential.access &&
          seen.credential.access !== request.rejectedAccessToken &&
          (seen.credential.expires ?? 0) > now()
        ) {
          await reconcile({
            ...observation(),
            status: 'adopted',
            successorFingerprint: fingerprintOf(seen.credential),
            successorVersion: dispatchVersion(seen.credential),
          })
          return {
            status: 'completed',
            source: 'adopted',
            identity: binding.identity,
            proven: true,
            persisted: false,
          }
        }

        try {
          const outcome: RefreshOutcome = await store.refresh(
            binding.rowId,
            async (credential, row) => {
              captured = row
              fingerprint = row.fingerprint
              credentialVersion = dispatchVersion(credential)
              // This read is outside pool locks. Recheck policy after file-lock waits.
              const currentRestriction = await options.readRestrictions(binding)
              const reason = request.signal?.aborted
                ? 'cancelled'
                : restrictionReason(currentRestriction, fingerprint)
              if (reason) throw new LocalRefreshRefusal(reason)
              endpointCalled = true
              const successor = await provider({
                refreshToken: credential.refresh,
                maxRetries: 0,
                now,
              })
              // From here on cancellation/bootstrap/handoff failures must not
              // reject the callback: the refresh token has already been consumed.
              consumed = true
              try {
                identity = (
                  await bootstrap(successor.access, undefined, undefined)
                ).accountUuid
                bootstrapStatus = identity ? 'resolved' : 'unavailable'
              } catch {
                bootstrapStatus = 'failed'
              }
              if (binding.identity === undefined && identity) {
                aliasKey = nativeLocalRefreshJobKey({ ...binding, identity })
                if (!jobs.has(aliasKey)) {
                  jobs.set(aliasKey, job)
                  job.keys.add(aliasKey)
                }
                if (request.signal?.aborted) {
                  handoff = 'skipped-cancelled'
                  unregister(job, aliasKey)
                } else {
                  try {
                    held = await handoffLock(identity)
                    handoff = 'acquired'
                    const owned = held
                    const onAbort = () => {
                      if (held !== owned) return
                      handoff = 'skipped-cancelled'
                      if (aliasKey) unregister(job, aliasKey)
                      void releaseHandoff()
                    }
                    request.signal?.addEventListener('abort', onAbort, {
                      once: true,
                    })
                    removeAbortListener = () =>
                      request.signal?.removeEventListener('abort', onAbort)
                    if (request.signal?.aborted) onAbort()
                    void owned
                      .whenLost()
                      .then(async () => {
                        // A delayed loss callback for an old handoff lock must
                        // not release its replacement or remove a job key
                        // registered to a newer job.
                        if (held === owned) await skipLostHandoff()
                      })
                      .catch(() => {})
                    if (held === owned) await owned.assertOwned()
                  } catch (error) {
                    handoff =
                      error instanceof LockContentionError
                        ? 'skipped-contention'
                        : 'skipped-loss'
                    unregister(job, aliasKey)
                    await releaseHandoff()
                  }
                }
              }
              return {
                access: successor.access,
                refresh: successor.refresh,
                expires: successor.expires,
                ...(identity ? { identity } : {}),
              }
            },
            {
              ...(binding.identity !== undefined
                ? {
                    providerLock: nativeAccountProviderLock(
                      options.paths,
                      binding.identity,
                    ),
                  }
                : {}),
              refuse: async (row) => {
                if (!nativeLocalPoolBindingMatches(binding, options.paths, row))
                  return 'binding-changed'
                if (captured && !sameDispatch(captured, row))
                  return 'dispatch-changed'
                if (held) {
                  try {
                    await held.assertOwned()
                  } catch {
                    await skipLostHandoff()
                  }
                }
                // Commit eligibility is not serving eligibility. Disabling a
                // duplicate or cancelling the caller cannot undo an exchange.
                if (consumed) return undefined
                if (request.signal?.aborted) return 'cancelled'
                if (!row.candidate || !row.enabled) return 'row-ineligible'
                return restrictionReason(restriction, row.fingerprint)
              },
              onPersisted: async (_id, credential) => {
                persisted = true
                committedVersion = dispatchVersion(credential)
                try {
                  if (held) {
                    try {
                      await held.assertOwned()
                    } catch {
                      await skipLostHandoff()
                    }
                  }
                  await reconcile({
                    ...observation(),
                    status: 'persisted',
                    identity,
                    successorFingerprint: fingerprintOf(credential),
                    successorVersion: committedVersion,
                  })
                } finally {
                  await releaseHandoff()
                }
              },
            },
          )
          switch (outcome.status) {
            case 'rotated':
              return {
                status: 'completed',
                source: 'rotated',
                identity: outcome.identity,
                proven: identityProven(),
                persisted: true,
              }
            case 'refused':
              await reconcile({
                ...observation(),
                status: 'refused',
                reason: outcome.reason,
                consumed,
              })
              return {
                status: 'refused',
                reason: outcome.reason,
                persisted: false,
              }
            case 'identity-contradicted':
              persisted = true
              committedVersion = dispatchVersion(outcome.credential)
              await reconcile({
                ...observation(),
                status: 'identity-contradicted',
                expectedIdentity: outcome.expectedIdentity,
                returnedIdentity: outcome.returnedIdentity,
                successorFingerprint: fingerprintOf(outcome.credential),
                successorVersion: committedVersion,
              })
              return {
                status: 'identity-contradicted',
                expectedIdentity: outcome.expectedIdentity,
                returnedIdentity: outcome.returnedIdentity,
                persisted: true,
              }
            default:
              return exhaustive(outcome)
          }
        } catch (caught) {
          const error = asError(caught)
          persisted ||=
            error instanceof PoolOperationError &&
            (error.committed !== undefined ||
              error.phase === 'after-first-write')
          if (
            error instanceof PoolOperationError &&
            error.committed?.type === 'oauth'
          )
            committedVersion = dispatchVersion(error.committed)
          if (
            !endpointCalled &&
            error instanceof PoolOperationError &&
            error.cause instanceof LocalRefreshRefusal
          ) {
            await reconcile({
              ...observation(),
              status: 'refused',
              reason: error.cause.reason,
              consumed: false,
            })
            return {
              status: 'refused',
              reason: error.cause.reason,
              persisted: false,
            }
          }
          const failure = failureOf(error)
          if (!endpointCalled && failure.kind === 'provider') {
            failure.kind = 'caller-hook'
            failure.classification = 'permanent'
          }
          // Pass the failure observation to reconciliation only after the
          // store operation has released its locks.
          try {
            await reconcile({
              ...observation(),
              status: 'failed',
              failure,
              persisted,
              committedVersion,
            })
          } catch {
            /* If reconciliation fails, preserve the original error classification
             * and whether the replacement credential was already persisted. */
          }
          if (
            endpointCalled &&
            !consumed &&
            !persisted &&
            !reconciliationFailed &&
            !request.signal?.aborted &&
            failure.kind === 'provider' &&
            failure.classification === 'transient' &&
            failure.status !== 429 &&
            attempt < 3
          ) {
            await releaseHandoff()
            if (aliasKey) unregister(job, aliasKey)
            continue
          }
          return { status: 'failed', error, persisted, reconciliationFailed }
        } finally {
          await releaseHandoff()
        }
      }
      throw new Error('Unreachable refresh attempt budget')
    } catch (caught) {
      const error = asError(caught)
      try {
        await reconcile({
          ...observation(),
          status: 'failed',
          failure: failureOf(error),
          persisted,
          committedVersion,
        })
      } catch {
        /* If observation publication fails, do not return any credential as usable. */
      }
      return { status: 'failed', error, persisted, reconciliationFailed }
    } finally {
      await releaseHandoff()
    }
  }

  async function refresh(
    request: NativeRefreshRequest,
  ): Promise<NativeRefreshResult> {
    if (request.mode !== 'local')
      return { status: 'refused', reason: 'custody-mode', persisted: false }
    if (
      !isNativeLocalPoolBinding(request.binding) ||
      request.binding.storageId !== options.paths.storageId
    )
      return { status: 'refused', reason: 'binding-changed', persisted: false }
    // Copy the request and binding before asynchronous work so caller
    // mutations cannot change the job's inputs.
    request = { ...request, binding: Object.freeze({ ...request.binding }) }
    if (request.signal?.aborted)
      return { status: 'refused', reason: 'cancelled', persisted: false }
    const key = nativeLocalRefreshJobKey(request.binding)
    let job = jobs.get(key)
    if (!job) {
      job = {
        keys: new Set([key]),
        promise: Promise.resolve({
          status: 'refused',
          reason: 'initializing',
          persisted: false,
        }),
      }
      jobs.set(key, job)
      const owner = job
      job.promise = run(owner, request).finally(() => {
        for (const ownedKey of owner.keys) unregister(owner, ownedKey)
      })
    }
    const result = await job.promise
    if (request.signal?.aborted)
      return {
        status: 'refused',
        reason: 'cancelled',
        persisted: result.persisted,
      }
    if (result.status !== 'completed') return result
    if (!result.proven)
      return {
        status: 'refused',
        reason: 'identity-unproven',
        persisted: result.persisted,
      }
    try {
      const expected =
        request.binding.identity === undefined && result.source === 'rotated'
          ? {
              ...request.binding,
              ...(result.identity ? { identity: result.identity } : {}),
            }
          : request.binding
      const restriction = await options.readRestrictions(expected)
      const row = await rowFor(request.binding)
      if (
        !row ||
        !nativeLocalPoolBindingMatches(expected, options.paths, row) ||
        !row.enabled ||
        !row.candidate
      )
        return {
          status: 'refused',
          reason: 'row-ineligible',
          persisted: result.persisted,
        }
      const reason = restrictionReason(restriction, row.fingerprint)
      if (reason)
        return { status: 'refused', reason, persisted: result.persisted }
      const credential = row.credential
      if (
        credential?.type !== 'oauth' ||
        !credential.access ||
        typeof credential.expires !== 'number' ||
        credential.expires <= now()
      )
        return {
          status: 'refused',
          reason: 'access-unavailable',
          persisted: result.persisted,
        }
      if (credential.access === request.rejectedAccessToken)
        return {
          status: 'refused',
          reason: 'rejected-access-unchanged',
          persisted: result.persisted,
        }
      return {
        status: 'usable',
        source: result.source,
        binding: Object.freeze(expected),
        access: credential.access,
        expires: credential.expires,
      }
    } catch (error) {
      return {
        status: 'failed',
        error: asError(error),
        persisted: result.persisted,
        reconciliationFailed: false,
      }
    }
  }

  return { refresh }
}
