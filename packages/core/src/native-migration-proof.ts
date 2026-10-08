import { createHash } from 'node:crypto'
import { types } from 'node:util'
import type { PoolRow, StoredCredential } from '@cortexkit/common-auth/store'

export class NativeMigrationProofError extends Error {
  readonly code = 'prepared-proof-refused'
  constructor() {
    super('Native migration prepared proof is unavailable or changed')
    this.name = 'NativeMigrationProofError'
  }
}

/** Credential-derived digests belong only in the owner-only migration journal. */
export interface NativeMigrationRowProof {
  id: string
  credentialEpoch: number
  identity: string | null
  stamp: 'bound'
  credentialDigest: string
}

export interface NativeMigrationPreparedProof {
  version: 1
  rows: NativeMigrationRowProof[]
  runtimeDigest: string
}

function refuse(): never {
  throw new NativeMigrationProofError()
}

export function requireNativeMigrationDataObject(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    types.isProxy(value)
  )
    refuse()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) refuse()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') refuse()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse()
  }
}

/** Copy inert JSON before decoding; never invoke a getter, proxy trap or toJSON. */
export function captureNativeMigrationJson(value: unknown): unknown {
  const ancestors = new Set<object>()
  function copy(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item))
      refuse()
    const prototype = Object.getPrototypeOf(item)
    if (
      prototype !==
        (Array.isArray(item) ? Array.prototype : Object.prototype) &&
      !(prototype === null && !Array.isArray(item))
    )
      refuse()
    ancestors.add(item)
    try {
      const fields = new Map<string, unknown>()
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') refuse()
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse()
        fields.set(key, descriptor.value)
      }
      if (Array.isArray(item)) {
        const length = fields.get('length')
        if (typeof length !== 'number' || fields.size !== length + 1) refuse()
        return Array.from({ length }, (_, index) => {
          if (!fields.has(String(index))) refuse()
          return copy(fields.get(String(index)))
        })
      }
      const result: Record<string, unknown> = Object.create(null)
      for (const key of [...fields.keys()].sort())
        result[key] = copy(fields.get(key))
      return result
    } finally {
      ancestors.delete(item)
    }
  }
  return copy(value)
}

export function nativeMigrationCanonicalJson(value: unknown): string {
  return JSON.stringify(captureNativeMigrationJson(value))
}

export function nativeMigrationDigest(value: unknown): string {
  return createHash('sha256')
    .update(nativeMigrationCanonicalJson(value))
    .digest('hex')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalField(
  value: Record<string, unknown>,
  key: string,
  kind: 'string' | 'number',
): unknown[] {
  if (!Object.hasOwn(value, key)) return ['absent']
  if (typeof value[key] !== kind) refuse()
  return ['present', value[key]]
}

/** Fixed-order, complete public descriptor; absence is different from a value. */
export function nativeMigrationCredentialDigest(
  credential: StoredCredential,
): string {
  const value = captureNativeMigrationJson(credential)
  if (!record(value)) refuse()
  if (value.type === 'oauth' && typeof value.refresh === 'string') {
    if (
      Object.keys(value).some(
        (key) =>
          !['type', 'access', 'refresh', 'expires', 'lastRefreshedAt'].includes(
            key,
          ),
      )
    )
      refuse()
    return nativeMigrationDigest([
      'anthropic-prepared-credential-v1',
      'oauth',
      optionalField(value, 'access', 'string'),
      value.refresh,
      optionalField(value, 'expires', 'number'),
      optionalField(value, 'lastRefreshedAt', 'number'),
    ])
  }
  if (
    value.type === 'api' &&
    typeof value.apiKey === 'string' &&
    typeof value.baseURL === 'string'
  ) {
    if (
      Object.keys(value).some(
        (key) => !['type', 'apiKey', 'baseURL', 'authHeader'].includes(key),
      )
    )
      refuse()
    if (
      Object.hasOwn(value, 'authHeader') &&
      value.authHeader !== 'x-api-key' &&
      value.authHeader !== 'authorization-bearer'
    )
      refuse()
    return nativeMigrationDigest([
      'anthropic-prepared-credential-v1',
      'api',
      value.apiKey,
      value.baseURL,
      optionalField(value, 'authHeader', 'string'),
    ])
  }
  return refuse()
}

export function captureNativeMigrationPreparedProof(
  rows: readonly PoolRow[],
  runtimeProjection: unknown,
): NativeMigrationPreparedProof {
  // Public store rows may contain optional undefined fields; read only the exact
  // descriptor fields below, after rejecting executable row objects.
  if (
    types.isProxy(rows) ||
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype
  )
    refuse()
  const rowFields = Object.getOwnPropertyDescriptors(rows)
  if (Reflect.ownKeys(rowFields).length !== rows.length + 1) refuse()
  const proofs = Array.from({ length: rows.length }, (_, index) => {
    const descriptor = rowFields[String(index)]
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) refuse()
    const row: PoolRow = descriptor.value
    requireNativeMigrationDataObject(row)
    if (
      row.stamp !== 'bound' ||
      row.invalid ||
      row.torn ||
      row.unbound ||
      !row.credential ||
      typeof row.credentialEpoch !== 'number' ||
      !Number.isSafeInteger(row.credentialEpoch) ||
      row.credentialEpoch <= 0 ||
      typeof row.id !== 'string' ||
      !row.id ||
      (row.identity !== undefined &&
        (typeof row.identity !== 'string' || !row.identity))
    )
      refuse()
    return {
      id: row.id,
      credentialEpoch: row.credentialEpoch,
      identity: row.identity ?? null,
      stamp: 'bound' as const,
      credentialDigest: nativeMigrationCredentialDigest(row.credential),
    }
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (new Set(proofs.map((row) => row.id)).size !== proofs.length) refuse()
  return {
    version: 1,
    rows: proofs,
    runtimeDigest: nativeMigrationDigest(runtimeProjection),
  }
}

export function decodeNativeMigrationPreparedProof(
  input: unknown,
): NativeMigrationPreparedProof {
  const value = captureNativeMigrationJson(input)
  const digest = (item: unknown): item is string =>
    typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
  if (
    !record(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== 1 ||
    !Array.isArray(value.rows) ||
    !digest(value.runtimeDigest)
  )
    refuse()
  const rows: NativeMigrationRowProof[] = value.rows.map((item) => {
    if (
      !record(item) ||
      Object.keys(item).length !== 5 ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.credentialEpoch !== 'number' ||
      !Number.isSafeInteger(item.credentialEpoch) ||
      item.credentialEpoch <= 0 ||
      !(
        item.identity === null ||
        (typeof item.identity === 'string' && item.identity.length > 0)
      ) ||
      item.stamp !== 'bound' ||
      typeof item.credentialDigest !== 'string' ||
      !digest(item.credentialDigest)
    )
      refuse()
    return {
      id: item.id,
      credentialEpoch: item.credentialEpoch,
      identity: item.identity,
      stamp: 'bound',
      credentialDigest: item.credentialDigest,
    }
  })
  if (new Set(rows.map((row) => row.id)).size !== rows.length) refuse()
  return { version: 1, rows, runtimeDigest: value.runtimeDigest }
}

export function requireNativeMigrationPreparedProof(
  proof: NativeMigrationPreparedProof | null,
  rows: readonly PoolRow[],
  runtimeProjection: unknown,
): void {
  if (
    !proof ||
    nativeMigrationCanonicalJson(decodeNativeMigrationPreparedProof(proof)) !==
      nativeMigrationCanonicalJson(
        captureNativeMigrationPreparedProof(rows, runtimeProjection),
      )
  )
    refuse()
}
