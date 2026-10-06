import {
  isNativeLocalCredentialValidation,
  type NativeLocalCredentialValidation,
} from './native-credential-validation.ts'
import type {
  NativeRefreshHooks,
  NativeRefreshRestriction,
  NativeRefreshSubject,
} from './native-refresh-coordinator.ts'
import {
  type NativeRuntimeEntry,
  NativeRuntimeError,
  readNativeRuntime,
} from './native-runtime.ts'
import {
  isNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
} from './pool-binding.ts'
import type { NativePoolPaths } from './pool-paths.ts'

/** Host adapters supply mode, account and quota policy for local OAuth authorization and refresh. */
export type NativeLocalExternalPolicy = Exclude<
  NativeRefreshRestriction,
  { credentialFingerprint: string }
>

export interface NativeLocalRuntimeReadersOptions {
  paths: NativePoolPaths
  /**
   * Decide whether local OAuth mode, the account and quota allow the operation
   * without I/O. Credential-validation evidence is checked separately.
   */
  externalPolicy: (subject: NativeRefreshSubject) => NativeLocalExternalPolicy
  /** Return the current time to evaluate stored retry deadlines; tests can supply a fixed clock. */
  now?: () => number
}

function sameBinding(a: NativeLocalPoolBinding, b: NativeLocalPoolBinding) {
  return (
    a.kind === b.kind &&
    a.storageId === b.storageId &&
    a.rowId === b.rowId &&
    a.credentialEpoch === b.credentialEpoch &&
    a.identity === b.identity
  )
}

/**
 * Require the same account, refresh credential, access fingerprint and expiry.
 * A missing lastRefreshedAt must remain distinct from a recorded zero.
 */
function sameCredential(
  a: NativeLocalCredentialValidation,
  b: NativeLocalCredentialValidation,
) {
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

function refreshRestriction(
  entry: NativeRuntimeEntry | undefined,
  subject: NativeRefreshSubject,
  now: number,
): NativeRefreshRestriction {
  const error = entry?.lastRefreshError
  if (
    entry?.binding.kind === 'local' &&
    sameBinding(entry.binding, subject.binding) &&
    error?.credentialFingerprint === subject.credentialFingerprint
  ) {
    if (error.permanent === true)
      return {
        status: 'blocked',
        reason: 'invalid-grant',
        credentialFingerprint: subject.credentialFingerprint,
      }
    if (error.nextRetryAt !== undefined && error.nextRetryAt > now)
      return {
        status: 'blocked',
        reason: 'refresh-backoff',
        credentialFingerprint: subject.credentialFingerprint,
      }
  }
  return { status: 'allowed' }
}

/**
 * Provide restriction and validation reads for NativeRefreshCoordinator without
 * retrieving credentials or writing files. Host adapters separately provide
 * runtime publication and account selection.
 */
export function createNativeLocalRuntimeReaders(
  options: NativeLocalRuntimeReadersOptions,
): Pick<NativeRefreshHooks, 'readRestrictions' | 'readAdmission'> {
  const { paths, externalPolicy } = options
  const now = options.now ?? Date.now
  if (typeof externalPolicy !== 'function')
    throw new TypeError('Native local external policy gate is required')

  function policy(subject: NativeRefreshSubject): NativeLocalExternalPolicy {
    const gate = externalPolicy(subject)
    if (gate?.status === 'allowed' && Object.keys(gate).length === 1)
      return { status: 'allowed' }
    if (
      gate?.status === 'blocked' &&
      Object.keys(gate).length === 2 &&
      [
        'quota-ineligible',
        'account-disabled',
        'local-mode-unavailable',
      ].includes(gate.reason)
    )
      return { status: 'blocked', reason: gate.reason }
    throw new TypeError('Native local external policy result is invalid')
  }

  async function readEntry(subject: NativeRefreshSubject) {
    if (!isNativeLocalPoolBinding(subject.binding))
      throw new NativeRuntimeError('invalid-runtime')
    const read = await readNativeRuntime(paths.runtime, paths.storageId)
    const entry =
      read.status === 'ready'
        ? read.state.accounts[subject.binding.rowId]
        : undefined
    // Vault-managed bindings are not local OAuth bindings.
    if (entry && entry.binding.kind !== 'local')
      throw new NativeRuntimeError('invalid-runtime')
    return entry
  }

  return {
    async readRestrictions(subject) {
      const entry = await readEntry(subject)
      const gate = policy(subject)
      return {
        restriction:
          gate.status === 'blocked'
            ? gate
            : refreshRestriction(entry, subject, now()),
        context: {
          subject,
          runtimeBinding:
            entry?.binding.kind === 'local' ? entry.binding : null,
          refreshErrorClearedAt: entry?.refreshErrorClearedAt ?? null,
          quotaErrorClearedAt: entry?.quotaErrorClearedAt ?? null,
          quotaErrorGeneration: entry?.quotaErrorGeneration ?? null,
        },
      }
    },
    async readAdmission(subject) {
      const entry = await readEntry(subject)
      const gate = policy(subject)
      if (gate.status === 'blocked') return gate
      const time = now()
      const restriction = refreshRestriction(entry, subject, time)
      if (restriction.status === 'blocked')
        return { status: 'blocked', reason: restriction.reason }
      if (!isNativeLocalCredentialValidation(subject))
        throw new NativeRuntimeError('invalid-runtime')
      const proof = entry?.credentialValidation
      if (proof && sameCredential(proof, subject))
        return { status: 'proven', validation: proof }
      const retry = entry?.validationRetry
      // An identity-lookup retry deadline blocks unproven, unexpired access,
      // but must not prevent exchanging an expired token for fresh access.
      if (
        retry &&
        subject.version.expires > time &&
        retry.nextRetryAt > time &&
        sameCredential(retry.subject, subject)
      )
        return { status: 'blocked', reason: 'validation-backoff' }
      return { status: 'unproven' }
    },
  }
}
