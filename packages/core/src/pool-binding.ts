import { createHash } from 'node:crypto'

import type { NativePoolPaths } from './pool-paths.ts'

export interface NativeLocalPoolBinding {
  readonly kind: 'local'
  readonly storageId: string
  readonly rowId: string
  readonly credentialEpoch: number
  readonly identity?: string
}

interface BindingSourceRow {
  id: string
  identity?: string
  credentialEpoch?: number
  candidate: boolean
  stamp?: string
  invalid?: string
  torn?: boolean
  unbound?: boolean
}

export class NativePoolBindingError extends Error {
  constructor() {
    super('Anthropic account binding is unavailable or changed')
    this.name = 'NativePoolBindingError'
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isNativeLocalPoolBinding(
  value: unknown,
): value is NativeLocalPoolBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record: Record<string, unknown> = value as Record<string, unknown>
  return (
    record.kind === 'local' &&
    typeof record.storageId === 'string' &&
    /^[a-f0-9]{64}$/.test(record.storageId) &&
    nonempty(record.rowId) &&
    validEpoch(record.credentialEpoch) &&
    (record.identity === undefined || nonempty(record.identity)) &&
    ['kind', 'storageId', 'rowId', 'credentialEpoch'].every((key) =>
      Object.hasOwn(record, key),
    ) &&
    (record.identity === undefined || Object.hasOwn(record, 'identity')) &&
    Object.keys(record).every((key) =>
      ['kind', 'storageId', 'rowId', 'credentialEpoch', 'identity'].includes(
        key,
      ),
    )
  )
}

function coherent(row: BindingSourceRow): boolean {
  return (
    row.stamp === 'bound' &&
    !row.invalid &&
    !row.torn &&
    !row.unbound &&
    nonempty(row.id) &&
    validEpoch(row.credentialEpoch) &&
    (row.identity === undefined || nonempty(row.identity))
  )
}

/** Capture the selected row before asynchronous work, never the newest primary afterward. */
export function captureNativeLocalPoolBinding(
  paths: NativePoolPaths,
  row: BindingSourceRow,
): NativeLocalPoolBinding {
  const credentialEpoch = row.credentialEpoch
  if (!row.candidate || !coherent(row) || !validEpoch(credentialEpoch))
    throw new NativePoolBindingError()
  const binding: NativeLocalPoolBinding = {
    kind: 'local',
    storageId: paths.storageId,
    rowId: row.id,
    credentialEpoch,
    ...(row.identity !== undefined ? { identity: row.identity } : {}),
  }
  if (!isNativeLocalPoolBinding(binding)) throw new NativePoolBindingError()
  return Object.freeze(binding)
}

/**
 * A response still belongs to an account disabled after dispatch. Matching
 * this snapshot does not make that account eligible for a new request.
 */
export function nativeLocalPoolBindingMatches(
  binding: NativeLocalPoolBinding,
  paths: NativePoolPaths,
  row: BindingSourceRow,
): boolean {
  return (
    isNativeLocalPoolBinding(binding) &&
    coherent(row) &&
    binding.storageId === paths.storageId &&
    binding.rowId === row.id &&
    binding.credentialEpoch === row.credentialEpoch &&
    binding.identity === row.identity
  )
}

/** Unknown row ids and proven account identities occupy different refresh namespaces. */
export function nativeLocalRefreshJobKey(
  binding: NativeLocalPoolBinding,
): string {
  if (!isNativeLocalPoolBinding(binding)) throw new NativePoolBindingError()
  return createHash('sha256')
    .update(
      JSON.stringify([
        'anthropic-local-refresh',
        binding.storageId,
        binding.credentialEpoch,
        binding.identity === undefined
          ? ['row', binding.rowId]
          : ['account', binding.identity],
      ]),
    )
    .digest('hex')
}
