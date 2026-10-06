import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { withLock } from '@cortexkit/common-auth/fs'

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
} from './native-credential-validation.ts'
import {
  fromNativeQuotaMap,
  type NativeQuotaMap,
} from './native-quota-codec.ts'
import {
  isNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
} from './pool-binding.ts'

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
 * Per-account retry errors, profiles, quota-priming usage and observation
 * identifiers stored separately from credentials. Vault quota is stored here;
 * local quota stays in the pool.
 */
export interface NativeRuntimeEntry {
  binding: NativeRuntimeBinding
  credentialValidation?: NativeLocalCredentialValidation
  lastUsed?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
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

function operationError(value: unknown): value is AccountOperationError {
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
    !optional(value, 'lastRefreshError', operationError) ||
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
    if (operationError(error) && time(clear) && error.checkedAt <= clear)
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

function assertTransitions(
  previous: NativeRuntimeState,
  next: NativeRuntimeState,
): void {
  for (const [id, incoming] of Object.entries(next.accounts)) {
    const old = previous.accounts[id]
    if (!old) continue
    if (old.binding.kind !== incoming.binding.kind) continue
    if (old.binding.kind === 'local' && incoming.binding.kind === 'local') {
      if (incoming.binding.credentialEpoch < old.binding.credentialEpoch)
        throw new NativeRuntimeError('runtime-conflict')
      if (incoming.binding.credentialEpoch > old.binding.credentialEpoch)
        continue
      if (old.binding.identity !== incoming.binding.identity)
        throw new NativeRuntimeError('runtime-conflict')
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
    for (const [older, newer, clear] of [
      [
        old.lastRefreshError,
        incoming.lastRefreshError,
        incoming.refreshErrorClearedAt,
      ],
      [
        old.lastQuotaRefreshError,
        incoming.lastQuotaRefreshError,
        incoming.quotaErrorClearedAt,
      ],
    ]) {
      if (
        operationError(older) &&
        (!operationError(newer)
          ? !time(clear) || clear < older.checkedAt
          : newer.checkedAt < older.checkedAt)
      )
        throw new NativeRuntimeError('runtime-conflict')
    }
  }
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
        assertTransitions(current, next)
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
