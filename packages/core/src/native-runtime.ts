import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { withLock } from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'

import type {
  AccountOperationError,
  OAuthAccountProfile,
  PrimeUsageCounters,
} from './accounts.ts'
import { quotaSnapshotCheckedAt } from './accounts.ts'
import { parseJsonRedacted } from './json.ts'
import {
  isNativeLocalCredentialValidation,
  type NativeLocalCredentialValidation,
  nativeLocalCredentialValidationMatches,
} from './native-credential-validation.ts'
import {
  fromNativeQuotaMap,
  type NativeQuotaMap,
  nativeQuotaCodec,
} from './native-quota-codec.ts'
import type {
  NativeRefreshContext,
  NativeRefreshObservation,
} from './native-refresh-coordinator.ts'
import {
  isNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
  nativeLocalPoolBindingMatches,
} from './pool-binding.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from './pool-store.ts'

/** Identifies the vault credential and Claude account that supplied an observation. This binding contains no access token. */
export interface NativeCustodyRuntimeBinding {
  kind: 'custody'
  storageId: string
  routeId: string
  credentialId: string
  accountIdentity: string
  recordVersion: number
}

export type NativeRuntimeBinding =
  | NativeLocalPoolBinding
  | NativeCustodyRuntimeBinding

/**
 * A failed account check is recorded against the exact credentials it used.
 * This lets a retry delay apply only to those credentials, without treating
 * the failure as evidence that the account check succeeded.
 */
export interface NativeLocalValidationRetry {
  readonly subject: Pick<
    NativeLocalCredentialValidation,
    'binding' | 'credentialFingerprint' | 'version'
  >
  readonly checkedAt: number
  readonly nextRetryAt: number
}

/**
 * Match refresh failures using fingerprintOf({ type: 'oauth', refresh }),
 * the full refresh-credential fingerprint. The legacy tokenHash hashes the raw refresh token, and
 * refreshTokenFingerprint is a short hash; neither is an alias for this value.
 * Errors without the explicit full fingerprint preserve error-reset timestamps
 * but cannot restrict a credential.
 */
export interface NativeLocalRefreshError extends AccountOperationError {
  credentialFingerprint?: string
}

/**
 * Per-account retry errors, profiles, quota-priming usage and observation
 * identifiers stored separately from credentials. Vault quota is stored here;
 * local quota stays in the pool.
 */
export interface NativeRuntimeEntry {
  binding: NativeRuntimeBinding
  credentialValidation?: NativeLocalCredentialValidation
  validationRetry?: NativeLocalValidationRetry
  lastUsed?: number
  lastRefreshedAt?: number
  lastRefreshError?: NativeLocalRefreshError
  refreshErrorClearedAt?: number
  refreshLeaseId?: string
  refreshLeaseUntil?: number
  refreshLeaseTokenHash?: string
  lastQuotaRefreshError?: AccountOperationError
  quotaErrorGeneration?: number
  quotaErrorClearedAt?: number
  quota?: NativeQuotaMap
  quotaCheckedAt?: number
  quotaToken?: string
  profile?: OAuthAccountProfile
  /** No supported writer supplies profileToken, so its value cannot safely be interpreted as an identifier. */
  profileToken?: never
  prime?: PrimeUsageCounters
  authLineageId?: string
  primeAuthLineageRefreshTokenFingerprint?: string
}

export interface NativeRuntimeState {
  version: 1
  storageId: string
  accounts: Record<string, NativeRuntimeEntry>
  relay?: { token: string }
}

export type NativeRuntimeRead =
  | { status: 'missing' }
  | { status: 'ready'; state: NativeRuntimeState }

export class NativeRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'invalid-runtime'
      | 'unsafe-runtime'
      | 'runtime-io'
      | 'runtime-conflict'
      | 'publication-refused',
  ) {
    super(
      {
        'invalid-runtime': 'Anthropic runtime state is invalid',
        'unsafe-runtime':
          'Anthropic runtime file is not owner-only regular storage',
        'runtime-io': 'Anthropic runtime storage is unavailable',
        'runtime-conflict':
          'Anthropic runtime observation is older than persisted state',
        'publication-refused': 'Anthropic runtime publication was refused',
      }[code],
    )
    this.name = 'NativeRuntimeError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  )
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function counter(value: unknown): value is number {
  return time(value) && Number.isSafeInteger(value)
}

function optional(
  value: Record<string, unknown>,
  key: string,
  check: (entry: unknown) => boolean,
): boolean {
  return !Object.hasOwn(value, key) || check(value[key])
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function tokenFingerprintValue(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value)
}

function accountUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
}

function binding(value: unknown): value is NativeRuntimeBinding {
  return (
    isNativeLocalPoolBinding(value) ||
    (record(value) &&
      keys(value, [
        'kind',
        'storageId',
        'routeId',
        'credentialId',
        'accountIdentity',
        'recordVersion',
      ]) &&
      value.kind === 'custody' &&
      digest(value.storageId) &&
      text(value.routeId) &&
      text(value.credentialId) &&
      text(value.accountIdentity) &&
      counter(value.recordVersion))
  )
}

function operationError(
  value: unknown,
  extraKeys: readonly string[] = [],
): value is AccountOperationError {
  return (
    record(value) &&
    keys(
      value,
      ['message', 'checkedAt'],
      [
        'nextRetryAt',
        'retryCount',
        'accountIdentity',
        'tokenHash',
        'refreshTokenFingerprint',
        'status',
        'permanent',
        ...extraKeys,
      ],
    ) &&
    typeof value.message === 'string' &&
    time(value.checkedAt) &&
    optional(value, 'nextRetryAt', time) &&
    optional(value, 'retryCount', counter) &&
    optional(value, 'accountIdentity', text) &&
    optional(value, 'tokenHash', digest) &&
    optional(value, 'refreshTokenFingerprint', tokenFingerprintValue) &&
    optional(
      value,
      'status',
      (entry) => counter(entry) && entry >= 100 && entry <= 599,
    ) &&
    optional(value, 'permanent', (entry) => typeof entry === 'boolean')
  )
}

function localRefreshError(value: unknown): value is NativeLocalRefreshError {
  return (
    operationError(value, ['credentialFingerprint']) &&
    record(value) &&
    optional(value, 'credentialFingerprint', digest)
  )
}

function localValidationRetry(
  value: unknown,
  observedBinding: NativeRuntimeBinding,
): value is NativeLocalValidationRetry {
  return (
    record(value) &&
    keys(value, ['subject', 'checkedAt', 'nextRetryAt']) &&
    observedBinding.kind === 'local' &&
    observedBinding.identity !== undefined &&
    // This validator checks credential fields, not whether an account check succeeded.
    isNativeLocalCredentialValidation(value.subject) &&
    value.subject.binding.storageId === observedBinding.storageId &&
    value.subject.binding.rowId === observedBinding.rowId &&
    value.subject.binding.credentialEpoch === observedBinding.credentialEpoch &&
    value.subject.binding.identity === observedBinding.identity &&
    counter(value.checkedAt) &&
    counter(value.nextRetryAt) &&
    value.nextRetryAt >= value.checkedAt
  )
}

function profile(value: unknown): value is OAuthAccountProfile {
  return (
    record(value) &&
    keys(
      value,
      ['tier', 'orgType', 'checkedAt'],
      ['accountIdentity', 'providerAccountUuid', 'tokenFingerprint'],
    ) &&
    text(value.tier) &&
    text(value.orgType) &&
    time(value.checkedAt) &&
    optional(value, 'accountIdentity', text) &&
    optional(value, 'providerAccountUuid', text) &&
    optional(value, 'tokenFingerprint', tokenFingerprintValue)
  )
}

function prime(value: unknown): value is PrimeUsageCounters {
  return (
    record(value) &&
    keys(value, ['count', 'inputTokens', 'outputTokens', 'since']) &&
    counter(value.count) &&
    counter(value.inputTokens) &&
    counter(value.outputTokens) &&
    time(value.since)
  )
}

const entryKeys: readonly string[] = [
  'credentialValidation',
  'validationRetry',
  'lastUsed',
  'lastRefreshedAt',
  'lastRefreshError',
  'refreshErrorClearedAt',
  'refreshLeaseId',
  'refreshLeaseUntil',
  'refreshLeaseTokenHash',
  'lastQuotaRefreshError',
  'quotaErrorGeneration',
  'quotaErrorClearedAt',
  'quota',
  'quotaCheckedAt',
  'quotaToken',
  'profile',
  'profileToken',
  'prime',
  'authLineageId',
  'primeAuthLineageRefreshTokenFingerprint',
]

function entry(
  value: unknown,
  id: string,
  storageId: string,
): value is NativeRuntimeEntry {
  if (
    !record(value) ||
    !keys(value, ['binding'], entryKeys) ||
    !binding(value.binding) ||
    value.binding.storageId !== storageId ||
    (value.binding.kind === 'local'
      ? value.binding.rowId
      : value.binding.routeId) !== id
  )
    return false
  const observedBinding = value.binding
  if (
    !optional(value, 'validationRetry', (retry) =>
      localValidationRetry(retry, observedBinding),
    )
  )
    return false
  if (Object.hasOwn(value, 'credentialValidation')) {
    const proof = value.credentialValidation
    // A carried proof must not survive rebinding, even if token bytes repeat.
    if (
      observedBinding.kind !== 'local' ||
      observedBinding.identity === undefined ||
      !isNativeLocalCredentialValidation(proof) ||
      proof.binding.storageId !== observedBinding.storageId ||
      proof.binding.rowId !== observedBinding.rowId ||
      proof.binding.credentialEpoch !== observedBinding.credentialEpoch ||
      proof.binding.identity !== observedBinding.identity
    )
      return false
  }
  for (const key of [
    'lastUsed',
    'lastRefreshedAt',
    'refreshErrorClearedAt',
    'refreshLeaseUntil',
    'quotaErrorClearedAt',
    'quotaCheckedAt',
  ]) {
    if (!optional(value, key, time)) return false
  }
  for (const key of ['refreshLeaseId', 'authLineageId']) {
    if (!optional(value, key, text)) return false
  }
  if (
    Object.hasOwn(value, 'profileToken') ||
    !optional(value, 'refreshLeaseTokenHash', digest) ||
    !optional(
      value,
      'primeAuthLineageRefreshTokenFingerprint',
      tokenFingerprintValue,
    ) ||
    !optional(value, 'quotaToken', (token) =>
      observedBinding.kind === 'local'
        ? tokenFingerprintValue(token)
        : accountUuid(token) && token === observedBinding.accountIdentity,
    ) ||
    !optional(value, 'quotaErrorGeneration', counter) ||
    !optional(value, 'profile', profile) ||
    !optional(value, 'prime', prime) ||
    !optional(
      value,
      'lastRefreshError',
      observedBinding.kind === 'local' ? localRefreshError : operationError,
    ) ||
    !optional(value, 'lastQuotaRefreshError', operationError)
  )
    return false
  const identity =
    value.binding.kind === 'local'
      ? value.binding.identity
      : value.binding.accountIdentity
  for (const observation of [
    value.profile,
    value.lastRefreshError,
    value.lastQuotaRefreshError,
  ]) {
    if (
      record(observation) &&
      ((observation.accountIdentity !== undefined &&
        observation.accountIdentity !== identity) ||
        (observation.providerAccountUuid !== undefined &&
          observation.providerAccountUuid !== identity))
    )
      return false
  }
  if (Object.hasOwn(value, 'quota')) {
    if (value.binding.kind !== 'custody') return false
    try {
      if (fromNativeQuotaMap(value.quota).accountIdentity !== identity)
        return false
    } catch {
      return false
    }
  }
  // Reject errors observed at or before the clear so a read cannot restore cleared backoff.
  const errorFences: Array<[string, string]> = [
    ['lastRefreshError', 'refreshErrorClearedAt'],
    ['lastQuotaRefreshError', 'quotaErrorClearedAt'],
  ]
  for (const [errorKey, clearKey] of errorFences) {
    const error = value[errorKey]
    const clear = value[clearKey]
    const checkError =
      errorKey === 'lastRefreshError' && observedBinding.kind === 'local'
        ? localRefreshError
        : operationError
    if (checkError(error) && time(clear) && error.checkedAt <= clear)
      return false
  }
  return true
}

/** Validate structure and internal identifier consistency. The publisher separately checks these identifiers against the current pool or vault roster. */
export function decodeNativeRuntime(
  value: unknown,
  storageId: string,
): NativeRuntimeState {
  if (
    !record(value) ||
    !keys(value, ['version', 'storageId', 'accounts'], ['relay']) ||
    value.version !== 1 ||
    !digest(storageId) ||
    value.storageId !== storageId ||
    !record(value.accounts) ||
    !optional(
      value,
      'relay',
      (entry) =>
        record(entry) &&
        keys(entry, ['token']) &&
        typeof entry.token === 'string',
    )
  )
    throw new NativeRuntimeError('invalid-runtime')
  const accounts: Record<string, NativeRuntimeEntry> = Object.create(null)
  for (const [id, item] of Object.entries(value.accounts)) {
    if (!text(id) || !entry(item, id, storageId))
      throw new NativeRuntimeError('invalid-runtime')
    accounts[id] = structuredClone(item)
  }
  return {
    version: 1,
    storageId,
    accounts,
    ...(record(value.relay) && typeof value.relay.token === 'string'
      ? { relay: { token: value.relay.token } }
      : {}),
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function checkPath(path: string): void {
  if (!isAbsolute(path)) throw new NativeRuntimeError('unsafe-runtime')
}

export async function readNativeRuntime(
  path: string,
  storageId: string,
): Promise<NativeRuntimeRead> {
  checkPath(path)
  if (!digest(storageId)) throw new NativeRuntimeError('invalid-runtime')
  try {
    const info = await lstat(path)
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      (typeof process.geteuid === 'function' && info.uid !== process.geteuid())
    )
      throw new NativeRuntimeError('unsafe-runtime')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await file.stat()
      if (
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        !opened.isFile() ||
        (opened.mode & 0o777) !== 0o600 ||
        (typeof process.geteuid === 'function' &&
          opened.uid !== process.geteuid())
      )
        throw new NativeRuntimeError('unsafe-runtime')
      let contents: string
      try {
        contents = new TextDecoder('utf-8', { fatal: true }).decode(
          await file.readFile(),
        )
      } catch (error) {
        if (error instanceof TypeError)
          throw new NativeRuntimeError('invalid-runtime')
        throw error
      }
      return {
        status: 'ready',
        state: decodeNativeRuntime(parseJsonRedacted(contents), storageId),
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (missing(error)) return { status: 'missing' }
    if (error instanceof NativeRuntimeError) throw error
    if (error instanceof SyntaxError)
      throw new NativeRuntimeError('invalid-runtime')
    throw new NativeRuntimeError('runtime-io')
  }
}

export interface NativeRuntimeWriteHooks {
  /** Verify that the observed account still matches the current pool record or vault roster and that the caller still owns the locks protecting those records. */
  beforeRename?: () => Promise<void>
  /** Runs after the new file replaces the old one. Failure does not undo that replacement. */
  afterRename?: () => Promise<void>
}

/** This writer alone uses `<leaf>.native-runtime.<UUID v4>.partial`. */
export function isNativeRuntimeStagingName(
  path: string,
  name: string,
): boolean {
  const prefix = `${basename(path)}.native-runtime.`
  return (
    name === basename(name) &&
    name.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.partial$/.test(
      name.slice(prefix.length),
    )
  )
}

interface FirstIdentityPublication {
  readonly predecessor: NativeLocalPoolBinding
  readonly context: NativeRefreshContext
  readonly proof: NativeLocalCredentialValidation
}

function sameLocalBinding(
  a: NativeLocalPoolBinding,
  b: NativeLocalPoolBinding,
) {
  return (
    a.storageId === b.storageId &&
    a.rowId === b.rowId &&
    a.credentialEpoch === b.credentialEpoch &&
    a.identity === b.identity
  )
}

function assertTransitions(
  previous: NativeRuntimeState,
  next: NativeRuntimeState,
  firstIdentity?: FirstIdentityPublication,
): void {
  let authorized = false
  for (const [id, incoming] of Object.entries(next.accounts)) {
    const old = previous.accounts[id]
    if (!old) continue
    if (old.binding.kind !== incoming.binding.kind) continue
    if (old.binding.kind === 'local' && incoming.binding.kind === 'local') {
      if (incoming.binding.credentialEpoch < old.binding.credentialEpoch)
        throw new NativeRuntimeError('runtime-conflict')
      if (incoming.binding.credentialEpoch > old.binding.credentialEpoch)
        continue
      if (old.binding.identity !== incoming.binding.identity) {
        if (
          !firstIdentity ||
          authorized ||
          id !== firstIdentity.predecessor.rowId ||
          old.binding.identity !== undefined ||
          !sameLocalBinding(old.binding, firstIdentity.predecessor) ||
          !sameLocalBinding(incoming.binding, firstIdentity.proof.binding)
        )
          throw new NativeRuntimeError('runtime-conflict')
        authorized = true
        // Adding the first account UUID still runs the checks below that preserve
        // error-reset timestamps and reject errors older than a concurrent reset.
      }
    } else if (
      old.binding.kind === 'custody' &&
      incoming.binding.kind === 'custody'
    ) {
      if (
        old.binding.credentialId !== incoming.binding.credentialId ||
        old.binding.accountIdentity !== incoming.binding.accountIdentity
      )
        continue
      if (incoming.binding.recordVersion < old.binding.recordVersion)
        throw new NativeRuntimeError('runtime-conflict')
    }
    const fenceKeys: Array<
      'quotaErrorGeneration' | 'quotaErrorClearedAt' | 'refreshErrorClearedAt'
    > = ['quotaErrorGeneration', 'quotaErrorClearedAt', 'refreshErrorClearedAt']
    for (const key of fenceKeys) {
      const older = old[key]
      const newer = incoming[key]
      if (older !== undefined && (newer === undefined || newer < older))
        throw new NativeRuntimeError('runtime-conflict')
    }
    if (
      old.profile &&
      incoming.profile &&
      incoming.profile.checkedAt < old.profile.checkedAt
    )
      throw new NativeRuntimeError('runtime-conflict')
    if (
      old.quota &&
      incoming.quota &&
      quotaSnapshotCheckedAt(fromNativeQuotaMap(incoming.quota)) <
        quotaSnapshotCheckedAt(fromNativeQuotaMap(old.quota))
    )
      throw new NativeRuntimeError('runtime-conflict')
    for (const [errorKey, clearKey] of [
      ['lastRefreshError', 'refreshErrorClearedAt'],
      ['lastQuotaRefreshError', 'quotaErrorClearedAt'],
    ] as const) {
      const older = old[errorKey]
      const newer = incoming[errorKey]
      const clear = incoming[clearKey]
      const checkError =
        errorKey === 'lastRefreshError' && incoming.binding.kind === 'local'
          ? localRefreshError
          : operationError
      if (
        checkError(older) &&
        (!checkError(newer)
          ? !time(clear) || clear < older.checkedAt
          : newer.checkedAt < older.checkedAt)
      )
        throw new NativeRuntimeError('runtime-conflict')
    }
  }
  if (firstIdentity && !authorized)
    throw new NativeRuntimeError('publication-refused')
}

/**
 * This file has its own update lock. Account publishers also hold the locks
 * protecting the pool and, for vault accounts, the roster. They verify those
 * locks immediately before replacement. A process paused beyond a lock expiry
 * can overlap a new owner even with normal renewal.
 */
export async function updateNativeRuntime(
  path: string,
  storageId: string,
  change: (
    current: NativeRuntimeState,
  ) => NativeRuntimeState | Promise<NativeRuntimeState>,
  hooks: NativeRuntimeWriteHooks = {},
): Promise<NativeRuntimeState> {
  return writeNativeRuntime(path, storageId, change, hooks)
}

// Both publication paths use the same lock, strict decoder and atomic replacement.
// Only the dedicated publisher supplies checked pool/runtime evidence authorizing
// the first account UUID change; a generic write has no such authorization.
async function writeNativeRuntime(
  path: string,
  storageId: string,
  change: (
    current: NativeRuntimeState,
  ) => NativeRuntimeState | Promise<NativeRuntimeState>,
  hooks: NativeRuntimeWriteHooks,
  firstIdentity?: FirstIdentityPublication,
): Promise<NativeRuntimeState> {
  checkPath(path)
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    return await withLock(
      path,
      { name: 'native-runtime', ttlMs: 10_000, timeoutMs: 15_000, renew: true },
      async (lock) => {
        const read = await readNativeRuntime(path, storageId)
        const current: NativeRuntimeState =
          read.status === 'ready'
            ? read.state
            : { version: 1, storageId, accounts: {} }
        const next = decodeNativeRuntime(
          await change(structuredClone(current)),
          storageId,
        )
        assertTransitions(current, next, firstIdentity)
        const bytes = `${JSON.stringify(next, null, 2)}\n`
        const stage = join(
          dirname(path),
          `${basename(path)}.native-runtime.${randomUUID()}.partial`,
        )
        let ownsStage = false
        try {
          const file = await open(stage, 'wx', 0o600)
          ownsStage = true
          try {
            await file.writeFile(bytes, 'utf8')
            await file.sync()
          } finally {
            await file.close()
          }
          try {
            await hooks.beforeRename?.()
          } catch {
            throw new NativeRuntimeError('publication-refused')
          }
          await lock.assertOwned()
          await rename(stage, path)
          ownsStage = false
          try {
            await hooks.afterRename?.()
          } catch {
            throw new NativeRuntimeError('publication-refused')
          }
          return next
        } finally {
          if (ownsStage) await rm(stage, { force: true })
        }
      },
    )
  } catch (error) {
    if (error instanceof NativeRuntimeError) throw error
    throw new NativeRuntimeError('runtime-io')
  }
}

function dispatchVersion(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    keys(value, [], ['accessFingerprint', 'expires', 'lastRefreshedAt']) &&
    optional(
      value,
      'accessFingerprint',
      (item) => item === undefined || tokenFingerprintValue(item),
    ) &&
    optional(value, 'expires', (item) => item === undefined || counter(item)) &&
    optional(value, 'lastRefreshedAt', counter)
  )
}

function sameVersion(a: Record<string, unknown>, b: Record<string, unknown>) {
  return ['accessFingerprint', 'expires', 'lastRefreshedAt'].every(
    (key) =>
      Object.hasOwn(a, key) === Object.hasOwn(b, key) && a[key] === b[key],
  )
}

function captureFirstIdentity(
  paths: NativePoolPaths,
  observation: NativeRefreshObservation,
): FirstIdentityPublication {
  const refuse = () => new NativeRuntimeError('publication-refused')
  // Copy before the first lock wait. Never fill missing evidence from a later row.
  const event = structuredClone(observation)
  const context = event.context
  if (
    !['persisted', 'validation-observed'].includes(event.status) ||
    event.bootstrap !== 'resolved' ||
    !('identity' in event) ||
    !accountUuid(event.identity) ||
    !isNativeLocalPoolBinding(event.binding) ||
    event.binding.storageId !== paths.storageId ||
    (event.binding.identity !== undefined &&
      event.binding.identity !== event.identity) ||
    !digest(event.credentialFingerprint) ||
    !dispatchVersion(event.credentialVersion) ||
    !context ||
    !record(context.subject) ||
    !isNativeLocalPoolBinding(context.subject.binding) ||
    !sameLocalBinding(context.subject.binding, event.binding) ||
    context.subject.credentialFingerprint !== event.credentialFingerprint ||
    !dispatchVersion(context.subject.version) ||
    !sameVersion(context.subject.version, event.credentialVersion) ||
    !isNativeLocalPoolBinding(context.runtimeBinding) ||
    context.runtimeBinding.identity !== undefined ||
    !sameLocalBinding(context.runtimeBinding, {
      ...event.binding,
      identity: undefined,
    }) ||
    ![
      context.refreshErrorClearedAt,
      context.quotaErrorClearedAt,
      context.quotaErrorGeneration,
    ].every((value) => value === null || counter(value))
  )
    throw refuse()
  const destination = { ...context.runtimeBinding, identity: event.identity }
  let proof: unknown
  if (event.status === 'persisted') {
    proof = {
      binding: destination,
      credentialFingerprint: event.successorFingerprint,
      version: event.successorVersion,
    }
    if (
      !isNativeLocalCredentialValidation(proof) ||
      !record(event.committed) ||
      !keys(event.committed, ['credentialFingerprint', 'version']) ||
      event.committed.credentialFingerprint !== proof.credentialFingerprint ||
      !dispatchVersion(event.committed.version) ||
      !sameVersion(event.committed.version, { ...proof.version })
    )
      throw refuse()
  } else if (event.status === 'validation-observed') {
    if (event.binding.identity !== event.identity) throw refuse()
    proof = {
      binding: destination,
      credentialFingerprint: event.credentialFingerprint,
      version: event.credentialVersion,
    }
  }
  if (!isNativeLocalCredentialValidation(proof)) throw refuse()
  return { predecessor: context.runtimeBinding, context, proof }
}

function firstIdentityEntry(
  old: NativeRuntimeEntry | undefined,
  publication: FirstIdentityPublication,
): NativeRuntimeEntry {
  const { predecessor, context, proof } = publication
  if (
    old?.binding.kind !== 'local' ||
    !sameLocalBinding(old.binding, predecessor) ||
    (old.refreshErrorClearedAt ?? null) !== context.refreshErrorClearedAt ||
    (old.quotaErrorClearedAt ?? null) !== context.quotaErrorClearedAt ||
    (old.quotaErrorGeneration ?? null) !== context.quotaErrorGeneration
  )
    throw new NativeRuntimeError('publication-refused')
  const floor = (
    marker: number | undefined,
    error: AccountOperationError | undefined,
  ) => {
    const value =
      marker === undefined
        ? error?.checkedAt
        : Math.max(marker, error?.checkedAt ?? marker)
    // Runtime error times can be fractional, but coordinator reset timestamps
    // must be nonnegative safe integers. Refuse an unrepresentable reset floor
    // rather than rounding it into a different error-clear boundary.
    if (value !== undefined && !counter(value))
      throw new NativeRuntimeError('publication-refused')
    return value
  }
  const refreshErrorClearedAt = floor(
    old.refreshErrorClearedAt,
    old.lastRefreshError,
  )
  const quotaErrorClearedAt = floor(
    old.quotaErrorClearedAt,
    old.lastQuotaRefreshError,
  )
  // The old profile, usage and errors have not been proven to belong to this
  // account. Retain only evidence for the newly checked credentials and the
  // reset timestamps/generation that prevent older results from restoring them.
  return {
    binding: proof.binding,
    credentialValidation: proof,
    ...(refreshErrorClearedAt !== undefined ? { refreshErrorClearedAt } : {}),
    ...(quotaErrorClearedAt !== undefined ? { quotaErrorClearedAt } : {}),
    ...(old.quotaErrorGeneration !== undefined
      ? { quotaErrorGeneration: old.quotaErrorGeneration }
      : {}),
  }
}

/**
 * Core-internal reconciliation of a successfully checked first local UUID.
 * Matching a response to an account disabled after dispatch does not give that
 * account permission to make another model request; admission checks still apply.
 * No caller mutator or publication callback can widen this transition.
 */
export async function publishNativeLocalFirstIdentity(
  paths: NativePoolPaths,
  observation: NativeRefreshObservation,
): Promise<NativeRuntimeState> {
  try {
    paths = { ...paths }
    const publication = captureFirstIdentity(paths, observation)
    const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
    const [config, state] = nativePoolStoreLocks(paths)
    const checkPool = async () => {
      const read = await store.read()
      const row =
        read.status === 'ready'
          ? read.rows.find((row) => row.id === publication.proof.binding.rowId)
          : undefined
      if (
        !row ||
        !nativeLocalPoolBindingMatches(publication.proof.binding, paths, row) ||
        !nativeLocalCredentialValidationMatches(
          publication.proof,
          publication.proof.binding,
          row.credential,
        )
      )
        throw new NativeRuntimeError('publication-refused')
    }
    return await withLock(
      config.path,
      { ...POOL_LOCK_DEFAULTS, name: config.name },
      async (configLease) =>
        withLock(
          state.path,
          { ...POOL_LOCK_DEFAULTS, name: state.name },
          async (stateLease) => {
            await checkPool()
            return writeNativeRuntime(
              paths.runtime,
              paths.storageId,
              (current) => {
                const id = publication.predecessor.rowId
                current.accounts[id] = firstIdentityEntry(
                  current.accounts[id],
                  publication,
                )
                return current
              },
              {
                beforeRename: async () => {
                  // Strict reads do not take row locks, repair storage or schedule pulls.
                  // Keep both pool leases through the writer's runtime assertion/rename.
                  await checkPool()
                  await configLease.assertOwned()
                  await stateLease.assertOwned()
                },
              },
              publication,
            )
          },
        ),
    )
  } catch (error) {
    if (error instanceof NativeRuntimeError) throw error
    // Pool/lease/parser exceptions can contain paths or input; do not relay them.
    throw new NativeRuntimeError('publication-refused')
  }
}
