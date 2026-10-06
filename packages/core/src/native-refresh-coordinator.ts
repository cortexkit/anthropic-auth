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
import {
  type NativeLocalCredentialValidation,
  type NativeLocalCredentialVersion,
  nativeLocalCredentialValidationMatches,
} from './native-credential-validation.ts'
import { nativeLockObserver } from './native-lock-observer.ts'
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
      reason: 'quota-ineligible' | 'account-disabled' | 'local-mode-unavailable'
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
  kind: PoolFailureKind | 'caller-hook' | 'validation'
  classification: 'transient' | 'invalid-grant' | 'permanent'
  status?: number
  retryAfter?: number
}

/**
 * Access can change while the refresh token and credential epoch stay the
 * same. These fields identify the exact stored OAuth version observed.
 */
export type NativeRefreshDispatchVersion = Partial<NativeLocalCredentialVersion>

/**
 * Identifies a captured pool row by storage, row id, credential epoch and
 * recorded account UUID, together with its full refresh-token fingerprint and
 * access fingerprint, expiry and optional refresh timestamp. Neither token is
 * included; access fingerprint and expiry may be absent before recovery.
 */
export interface NativeRefreshSubject {
  readonly binding: NativeLocalPoolBinding
  readonly credentialFingerprint: string
  readonly version: NativeRefreshDispatchVersion
}

export type NativeKnownCredentialSubject = NativeLocalCredentialValidation

/**
 * Records the runtime binding and error-reset timestamps/generation observed
 * for the captured pool row. Null means no binding or no reset value was
 * present; a recorded timestamp or generation of zero must remain distinct.
 */
export interface NativeRefreshContext {
  readonly subject: NativeRefreshSubject
  readonly runtimeBinding: NativeLocalPoolBinding | null
  readonly refreshErrorClearedAt: number | null
  readonly quotaErrorClearedAt: number | null
  readonly quotaErrorGeneration: number | null
}

export interface NativeRefreshPolicy {
  readonly restriction: NativeRefreshRestriction
  readonly context: NativeRefreshContext
}

export type NativeServingAdmission =
  | { status: 'proven'; validation: NativeLocalCredentialValidation }
  | { status: 'unproven' }
  | {
      status: 'blocked'
      reason:
        | 'quota-ineligible'
        | 'account-disabled'
        | 'local-mode-unavailable'
        | 'refresh-backoff'
        | 'invalid-grant'
        | 'validation-backoff'
    }

export interface NativeCommittedMaterial {
  readonly credentialFingerprint: string
  readonly version: NativeRefreshDispatchVersion
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
  /**
   * Runtime binding and error-reset values read before the provider exchange or
   * account lookup. Later serving checks must not replace these values: doing
   * so could let an older network result overwrite an intervening error reset.
   */
  context?: NativeRefreshContext
  bootstrap: NativeIdentityBootstrap
  handoff: NativeRefreshHandoff
}

/**
 * Observations contain no tokens or exceptions from the provider account lookup.
 * Only a successful account lookup reported by a persisted or
 * validation-observed event can support new validation evidence. An adopted
 * event merely records credentials already present on the requesting pool row;
 * it performs no account lookup. Failed events cannot create validation evidence.
 */
export type NativeRefreshObservation = ObservationBase &
  (
    | {
        status: 'persisted'
        identity?: string
        successorFingerprint: string
        successorVersion: NativeRefreshDispatchVersion
        committed: NativeCommittedMaterial
      }
    | {
        status: 'adopted'
        successorFingerprint: string
        successorVersion: NativeRefreshDispatchVersion
      }
    | {
        status: 'validation-observed'
        identity: string
        context: NativeRefreshContext
      }
    | { status: 'refused'; reason: string; consumed: boolean }
    | {
        status: 'identity-contradicted'
        expectedIdentity: string
        returnedIdentity: string
        successorFingerprint: string
        successorVersion: NativeRefreshDispatchVersion
        committed: NativeCommittedMaterial
      }
    | {
        status: 'failed'
        failure: NativeRefreshFailure
        persisted: boolean
        committed?: NativeCommittedMaterial
      }
  )

export interface NativeRefreshHooks {
  /**
   * Read native local-mode, account-disable, quota and refresh-error restrictions
   * for the captured row. Credential-bound errors apply only to the matching
   * full refresh-token fingerprint; absent account-validation evidence must not
   * prevent a refresh exchange. Echo the supplied row binding, refresh-token
   * fingerprint and access version. Include the observed runtime binding,
   * refreshErrorClearedAt, quotaErrorClearedAt and quotaErrorGeneration, using
   * null for absent values. Before each physical exchange the coordinator keeps
   * a new frozen copy after lock waits, outside pool-config/pool-state locks.
   * Do not read host credentials or mutate the store.
   */
  readRestrictions(subject: NativeRefreshSubject): Promise<NativeRefreshPolicy>
  /**
   * Read serving restrictions and validation evidence for the supplied row
   * binding, full refresh-token fingerprint and access version, without token
   * input or state writes. The binding has a recorded account UUID, but that
   * UUID alone does not establish that the presented credential was validated.
   * Returned evidence must match the credentials on the captured requesting row.
   */
  readAdmission(
    subject: NativeKnownCredentialSubject,
  ): Promise<NativeServingAdmission>
  /**
   * Acquire pool-config, pool-state, then native-runtime before saving refresh
   * errors or validation evidence. Re-read the observation's pool row and check
   * storage, row id, credential epoch, recorded UUID, full refresh-token
   * fingerprint, access fingerprint, expiry and lastRefreshedAt presence/value.
   *
   * credentialVersion names the credential captured before network work;
   * successorVersion names the observed replacement; committed names the
   * replacement actually saved before a later failure. A failed observation
   * without committed credentials must not infer a replacement from a newer row.
   *
   * Compare the runtime binding and error-reset timestamps/generation with
   * context. Changed reset values mean the older observation cannot overwrite
   * state cleared while its exchange or lookup was pending. Learned UUIDs belong
   * only to the row receiving the replacement. Clear obsolete credential-bound
   * errors only after confirming which replacement is stored. Failed account
   * lookups leave stored replacements without new validation evidence; observing
   * an already advanced row or a failed operation cannot create that evidence.
   *
   * Reconciliation completes before authorize returns. The shared config/state
   * locks are already released. A successful token exchange still holds the
   * refresh locks that prevent another exchange for this row and account.
   * Failed operations and checks of existing access without an exchange do not
   * guarantee those locks. Do not call store operations that acquire row locks
   * or wait for another caller of the same account's refresh job; either can
   * wait for the locks or reconciliation this callback must complete.
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
  intent: 'serve' | 'refresh'
  mode: 'local' | 'claustrum'
  binding: NativeLocalPoolBinding
  /** A 401's dispatched access token, used only for replacement adoption. */
  rejectedAccessToken?: string
  signal?: AbortSignal
}

export type NativeRefreshResult =
  | {
      status: 'usable'
      source: 'current' | 'validated' | 'rotated' | 'adopted'
      binding: NativeLocalPoolBinding
      /**
       * Token from the row addressed by request.binding.rowId whose validation
       * evidence was checked. A caller for another row with the same account UUID
       * may share recovery work, but must not receive the job owner's row token.
       */
      access: string
      expires: number
      subject: NativeKnownCredentialSubject
      validation: NativeLocalCredentialValidation
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
      failure: NativeRefreshFailure
      persisted: boolean
      reconciliationFailed: boolean
    }

type JobResult =
  | {
      status: 'completed'
      source: 'current' | 'validated' | 'rotated' | 'adopted'
      identity?: string
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
  if (kind === 'provider' && cause instanceof ClaudeOAuthRefreshError) {
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
    ...(Object.hasOwn(credential, 'lastRefreshedAt')
      ? { lastRefreshedAt: credential.lastRefreshedAt }
      : {}),
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
    a.expires === b.expires &&
    Object.hasOwn(a, 'lastRefreshedAt') ===
      Object.hasOwn(b, 'lastRefreshedAt') &&
    a.lastRefreshedAt === b.lastRefreshedAt
  )
}

function exhaustive(outcome: never): never {
  throw new Error(`Unsupported refresh outcome: ${String(outcome)}`)
}

function sameBinding(a: NativeLocalPoolBinding, b: NativeLocalPoolBinding) {
  return (
    isNativeLocalPoolBinding(a) &&
    isNativeLocalPoolBinding(b) &&
    a.storageId === b.storageId &&
    a.rowId === b.rowId &&
    a.credentialEpoch === b.credentialEpoch &&
    a.identity === b.identity
  )
}

function sameSubject(a: NativeRefreshSubject, b: NativeRefreshSubject) {
  return (
    sameBinding(a.binding, b.binding) &&
    a.credentialFingerprint === b.credentialFingerprint &&
    a.version.accessFingerprint === b.version.accessFingerprint &&
    a.version.expires === b.version.expires &&
    Object.hasOwn(a.version, 'lastRefreshedAt') ===
      Object.hasOwn(b.version, 'lastRefreshedAt') &&
    a.version.lastRefreshedAt === b.version.lastRefreshedAt
  )
}

function copySubject<T extends NativeRefreshSubject>(subject: T): T {
  return Object.freeze({
    ...subject,
    binding: Object.freeze({ ...subject.binding }),
    version: Object.freeze({ ...subject.version }),
  })
}

function subjectOf(
  binding: NativeLocalPoolBinding,
  row: PoolRow,
): NativeRefreshSubject {
  if (row.credential?.type !== 'oauth' || !row.fingerprint)
    throw new LocalRefreshRefusal('access-unavailable')
  return copySubject({
    binding,
    credentialFingerprint: row.fingerprint,
    version: dispatchVersion(row.credential),
  })
}

function committedOf(credential: StoredCredential): NativeCommittedMaterial {
  return Object.freeze({
    credentialFingerprint: fingerprintOf(credential),
    version: dispatchVersion(credential),
  })
}

function freezeContext(
  context: NativeRefreshContext,
  subject: NativeRefreshSubject,
): NativeRefreshContext {
  if (
    !sameSubject(context.subject, subject) ||
    (context.runtimeBinding !== null &&
      !isNativeLocalPoolBinding(context.runtimeBinding)) ||
    ![
      context.refreshErrorClearedAt,
      context.quotaErrorClearedAt,
      context.quotaErrorGeneration,
    ].every(
      (value) =>
        value === null || (Number.isSafeInteger(value) && Number(value) >= 0),
    )
  )
    throw new Error('Native policy context does not match the captured subject')
  // Copy only the supplied row/credential identifiers, observed runtime binding
  // and error-reset values. The hook cannot attach tokens to the observation or
  // change its captured reset values by later mutating its returned object.
  return Object.freeze({
    subject: copySubject(subject),
    runtimeBinding:
      context.runtimeBinding === null
        ? null
        : Object.freeze({ ...context.runtimeBinding }),
    refreshErrorClearedAt: context.refreshErrorClearedAt,
    quotaErrorClearedAt: context.quotaErrorClearedAt,
    quotaErrorGeneration: context.quotaErrorGeneration,
  })
}

/** Independent local machinery: construction performs no network or migration. */
export function createNativeRefreshCoordinator(
  options: NativeRefreshCoordinatorOptions,
) {
  const store = createNativePoolStore(options)
  const now = options.now ?? Date.now
  const provider = options.refreshToken ?? refreshClaudeOAuthToken
  const bootstrap = options.resolveIdentity ?? resolveClaudeCodeIdentity
  const onLockEvent = nativeLockObserver(options.onLockEvent)

  async function rowFor(binding: NativeLocalPoolBinding) {
    const read = await store.read()
    return read.status === 'ready'
      ? read.rows.find((row) => row.id === binding.rowId)
      : undefined
  }

  async function readPolicy(
    subject: NativeRefreshSubject,
  ): Promise<NativeRefreshPolicy> {
    let policy: NativeRefreshPolicy
    try {
      policy = await options.readRestrictions(subject)
    } catch (cause) {
      throw new Error('Native policy callback failed', { cause })
    }
    return Object.freeze({
      restriction: Object.freeze({ ...policy.restriction }),
      context: freezeContext(policy.context, subject),
    })
  }

  async function admit(
    request: NativeRefreshRequest,
    expected: NativeLocalPoolBinding,
    row: PoolRow | undefined,
    source: Extract<NativeRefreshResult, { status: 'usable' }>['source'],
    persisted: boolean,
  ): Promise<NativeRefreshResult> {
    const refuse = (reason: string): NativeRefreshResult => ({
      status: 'refused',
      reason,
      persisted,
    })
    if (
      !row ||
      !nativeLocalPoolBindingMatches(expected, options.paths, row) ||
      !row.enabled ||
      !row.candidate
    )
      return refuse('row-ineligible')
    if (expected.identity === undefined) return refuse('identity-unproven')
    const credential = row.credential
    if (
      credential?.type !== 'oauth' ||
      !credential.access ||
      typeof credential.expires !== 'number' ||
      credential.expires <= now()
    )
      return refuse('access-unavailable')
    if (credential.access === request.rejectedAccessToken)
      return refuse('rejected-access-unchanged')
    const subject: NativeKnownCredentialSubject = copySubject({
      binding: { ...expected, identity: expected.identity },
      credentialFingerprint: fingerprintOf(credential),
      version: {
        ...dispatchVersion(credential),
        accessFingerprint: tokenFingerprint(credential.access),
        expires: credential.expires,
      },
    })
    let admission: NativeServingAdmission
    try {
      admission = await options.readAdmission(subject)
    } catch (cause) {
      throw new Error('Native admission callback failed', { cause })
    }
    if (admission.status === 'blocked') return refuse(admission.reason)
    if (admission.status !== 'proven') return refuse('proof-missing')
    if (
      !nativeLocalCredentialValidationMatches(
        admission.validation,
        expected,
        credential,
      )
    )
      return refuse('proof-mismatch')
    if (request.signal?.aborted) return refuse('cancelled')
    if (credential.expires <= now()) return refuse('access-unavailable')
    // Return the token from the same requesting row whose binding, refresh-token
    // fingerprint and access version just matched the validation evidence. Do
    // not substitute a newer row after awaiting the admission hook.
    return Object.freeze({
      status: 'usable',
      source,
      binding: subject.binding,
      access: credential.access,
      expires: credential.expires,
      subject,
      validation: copySubject(admission.validation),
    })
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
        } catch (error) {
          await lock.release().catch(() => {})
          onLockEvent?.({
            type: 'released',
            name: spec.name,
            path: spec.path,
          })
          throw error
        }
        onLockEvent?.({
          type: 'acquired',
          name: spec.name,
          path: spec.path,
        })
        return lock
      }
      // The installed primitive's null result can mean refusals other than a
      // live holder. Contention diagnostics need a producer acquisition event;
      // guessing here would report ownership evidence the primitive never gave.
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
    let committed: NativeCommittedMaterial | undefined
    let context: NativeRefreshContext | undefined
    let held: RefreshFileLock | undefined
    let releasing: Promise<void> | undefined
    let removeAbortListener: (() => void) | undefined
    let aliasKey: string | undefined
    let reconciliationFailed = false

    function observation(): ObservationBase {
      return {
        binding,
        attempt,
        credentialFingerprint: fingerprint,
        credentialVersion,
        context,
        bootstrap: bootstrapStatus,
        handoff,
      }
    }

    async function reconcile(event: NativeRefreshObservation) {
      try {
        await options.reconcile(event)
      } catch (error) {
        reconciliationFailed = true
        throw new Error('Native reconciliation callback failed', {
          cause: error,
        })
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
            onLockEvent?.({
              type: 'released',
              name: spec.name,
              path: spec.path,
            })
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
        // Clear the previous attempt's UUID, refresh lineage, access version and
        // runtime context before awaiting another row read. If the next policy
        // read fails, its failed observation must not reuse earlier reset values.
        consumed = false
        let endpointCalled = false
        identity = undefined
        fingerprint = undefined
        credentialVersion = undefined
        committed = undefined
        context = undefined
        aliasKey = undefined
        bootstrapStatus = 'unavailable'
        handoff = 'not-needed'
        let captured: PoolRow | undefined
        const seen = await rowFor(binding)
        fingerprint = seen?.fingerprint
        credentialVersion =
          seen?.credential?.type === 'oauth'
            ? dispatchVersion(seen.credential)
            : undefined
        let policy: NativeRefreshPolicy | undefined
        const initialReason =
          !seen || !nativeLocalPoolBindingMatches(binding, options.paths, seen)
            ? 'binding-changed'
            : request.signal?.aborted
              ? 'cancelled'
              : !seen.candidate || !seen.enabled
                ? 'row-ineligible'
                : undefined
        if (initialReason) {
          await reconcile({
            ...observation(),
            status: 'refused',
            reason: initialReason,
            consumed: false,
          })
          return { status: 'refused', reason: initialReason, persisted: false }
        }
        if (!seen) throw new Error('Captured row unavailable')
        policy = await readPolicy(subjectOf(binding, seen))
        const policyReason = restrictionReason(
          policy.restriction,
          seen.fingerprint,
        )
        if (policyReason) {
          await reconcile({
            ...observation(),
            status: 'refused',
            reason: policyReason,
            consumed: false,
          })
          return { status: 'refused', reason: policyReason, persisted: false }
        }
        if (
          binding.identity !== undefined &&
          (request.intent === 'serve' ||
            request.rejectedAccessToken !== undefined) &&
          seen?.credential?.type === 'oauth' &&
          seen.credential.access &&
          seen.credential.access !== request.rejectedAccessToken &&
          (seen.credential.expires ?? 0) > now()
        ) {
          const admission = await admit(
            request,
            binding,
            seen,
            'adopted',
            false,
          )
          if (admission.status === 'usable') {
            // The adopted observation records credentials already present on the
            // requesting pool row. No account lookup was performed, so observing
            // that row cannot produce new validation evidence.
            await reconcile({
              ...observation(),
              status: 'adopted',
              successorFingerprint: fingerprintOf(seen.credential),
              successorVersion: dispatchVersion(seen.credential),
            })
          } else if (
            admission.status === 'refused' &&
            admission.reason === 'proof-missing'
          ) {
            // Check the captured access token against the UUID already recorded
            // on its pool row, outside store/publication locks and without
            // rewriting identity. Saving evidence must still match that row's
            // binding, refresh lineage, access fingerprint, expiry and timestamp.
            context = policy.context
            let validatedIdentity: string | undefined
            let validationFailure: NativeRefreshFailure | undefined
            try {
              validatedIdentity = (
                await bootstrap(seen.credential.access, undefined, undefined)
              ).accountUuid
              bootstrapStatus = validatedIdentity ? 'resolved' : 'unavailable'
              if (!validatedIdentity)
                validationFailure = {
                  kind: 'validation',
                  classification: 'transient',
                }
            } catch (caught) {
              bootstrapStatus = 'failed'
              validationFailure = {
                kind: 'validation',
                classification:
                  isTransientNetworkError(caught) ||
                  (caught instanceof ClaudeOAuthRefreshError &&
                    (caught.status === 429 || caught.status >= 500))
                    ? 'transient'
                    : 'permanent',
              }
            }
            if (validationFailure) {
              Object.freeze(validationFailure)
              try {
                await reconcile({
                  ...observation(),
                  status: 'failed',
                  failure: validationFailure,
                  persisted: false,
                })
              } catch {
                // Failure to save the account-lookup result must preserve the
                // lookup's failure classification, not report a refresh-endpoint
                // authentication failure instead.
              }
              return {
                status: 'failed',
                failure: validationFailure,
                persisted: false,
                reconciliationFailed,
              }
            }
            if (validatedIdentity !== binding.identity) {
              await reconcile({
                ...observation(),
                status: 'refused',
                reason: 'validation-contradicted',
                consumed: false,
              })
              return {
                status: 'refused',
                reason: 'validation-contradicted',
                persisted: false,
              }
            }
            await reconcile({
              ...observation(),
              status: 'validation-observed',
              identity: binding.identity,
              context,
            })
          } else return admission
          return {
            status: 'completed',
            source:
              admission.status === 'usable'
                ? request.rejectedAccessToken
                  ? 'adopted'
                  : 'current'
                : 'validated',
            identity: binding.identity,
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
              policy = await readPolicy(subjectOf(binding, row))
              context = policy.context
              const reason = request.signal?.aborted
                ? 'cancelled'
                : restrictionReason(policy.restriction, fingerprint)
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
                const returnedIdentity = (
                  await bootstrap(successor.access, undefined, undefined)
                ).accountUuid
                // An empty or whitespace-padded account UUID cannot identify a
                // shared account job. Treat the lookup as unavailable and still
                // save the replacement: the provider consumed the refresh token.
                identity =
                  typeof returnedIdentity === 'string' &&
                  returnedIdentity.length > 0 &&
                  returnedIdentity.trim() === returnedIdentity
                    ? returnedIdentity
                    : undefined
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
                return policy
                  ? restrictionReason(policy.restriction, row.fingerprint)
                  : undefined
              },
              onPersisted: async (_id, credential) => {
                persisted = true
                committed = committedOf(credential)
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
                    successorFingerprint: committed.credentialFingerprint,
                    successorVersion: committed.version,
                    committed,
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
              committed = committedOf(outcome.credential)
              await reconcile({
                ...observation(),
                status: 'identity-contradicted',
                expectedIdentity: outcome.expectedIdentity,
                returnedIdentity: outcome.returnedIdentity,
                successorFingerprint: committed.credentialFingerprint,
                successorVersion: committed.version,
                committed,
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
            committed = committedOf(error.committed)
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
          Object.freeze(failure)
          // Pass the failure observation to reconciliation only after the
          // store operation has released its locks.
          try {
            await reconcile({
              ...observation(),
              status: 'failed',
              failure,
              persisted,
              committed,
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
          return { status: 'failed', failure, persisted, reconciliationFailed }
        } finally {
          await releaseHandoff()
        }
      }
      throw new Error('Unreachable refresh attempt budget')
    } catch (caught) {
      const error = asError(caught)
      persisted ||=
        error instanceof PoolOperationError &&
        (error.committed !== undefined || error.phase === 'after-first-write')
      if (
        error instanceof PoolOperationError &&
        error.committed?.type === 'oauth'
      )
        committed = committedOf(error.committed)
      try {
        await reconcile({
          ...observation(),
          status: 'failed',
          failure: failureOf(error),
          persisted,
          committed,
        })
      } catch {
        /* If observation publication fails, do not return any credential as usable. */
      }
      return {
        status: 'failed',
        failure: failureOf(error),
        persisted,
        reconciliationFailed,
      }
    } finally {
      await releaseHandoff()
    }
  }

  async function authorize(
    request: NativeRefreshRequest,
  ): Promise<NativeRefreshResult> {
    if (request.mode !== 'local')
      return { status: 'refused', reason: 'custody-mode', persisted: false }
    if (request.intent !== 'serve' && request.intent !== 'refresh')
      return { status: 'refused', reason: 'invalid-intent', persisted: false }
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
    if (!job && request.intent === 'serve') {
      try {
        const current = await admit(
          request,
          request.binding,
          await rowFor(request.binding),
          'current',
          false,
        )
        if (
          current.status !== 'refused' ||
          ![
            'proof-missing',
            'identity-unproven',
            'access-unavailable',
            'rejected-access-unchanged',
          ].includes(current.reason)
        )
          return current
      } catch (caught) {
        return {
          status: 'failed',
          failure: failureOf(asError(caught)),
          persisted: false,
          reconciliationFailed: false,
        }
      }
      // While the admission hook was awaited, another caller may have started
      // recovery for the same storage, credential epoch and account UUID (or
      // unknown-identity row). Check for that job before starting duplicate work.
      job = jobs.get(key)
    }
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
    try {
      const expected =
        request.binding.identity === undefined && result.source === 'rotated'
          ? {
              ...request.binding,
              ...(result.identity ? { identity: result.identity } : {}),
            }
          : request.binding
      const row = await rowFor(request.binding)
      return await admit(
        request,
        expected,
        row,
        result.source,
        result.persisted,
      )
    } catch (error) {
      return {
        status: 'failed',
        failure: failureOf(asError(error)),
        persisted: result.persisted,
        reconciliationFailed: false,
      }
    }
  }

  return { authorize }
}
