import { fingerprintOf } from '@cortexkit/common-auth/store'

import {
  isNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
} from './pool-binding.ts'
import { tokenFingerprint } from './token-fingerprint.ts'

/**
 * The access-token fingerprint, expiry and last recorded refresh time identify
 * the captured credentials. No bearer material is stored.
 */
export interface NativeLocalCredentialVersion {
  readonly accessFingerprint: string
  readonly expires: number
  readonly lastRefreshedAt?: number
}

/**
 * Positive local account evidence belongs to its own binding, not merely to
 * the runtime entry containing it. Copying an entry must not transfer evidence
 * to another row, storage location, credential epoch or account identity.
 * This evidence does not establish freshness or eligibility to serve.
 */
export interface NativeLocalCredentialValidation {
  readonly binding: NativeLocalPoolBinding & { readonly identity: string }
  /** Common-auth's full SHA-256 of `oauth\0` followed by the refresh token. */
  readonly credentialFingerprint: string
  readonly version: NativeLocalCredentialVersion
}

/**
 * Core publishes this local input type so consumers do not need common-auth
 * declarations.
 */
export interface NativeLocalCredentialMaterial {
  readonly type: string
  readonly access?: string
  readonly refresh?: string
  readonly expires?: number
  readonly lastRefreshedAt?: number
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

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

/** Validate the closed, token-free proof schema; no defaults or I/O are used. */
export function isNativeLocalCredentialValidation(
  value: unknown,
): value is NativeLocalCredentialValidation {
  if (
    !record(value) ||
    !keys(value, ['binding', 'credentialFingerprint', 'version']) ||
    !isNativeLocalPoolBinding(value.binding) ||
    value.binding.identity === undefined ||
    typeof value.credentialFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.credentialFingerprint) ||
    !record(value.version) ||
    !keys(value.version, ['accessFingerprint', 'expires'], ['lastRefreshedAt'])
  )
    return false
  return (
    typeof value.version.accessFingerprint === 'string' &&
    /^[a-f0-9]{16}$/.test(value.version.accessFingerprint) &&
    timestamp(value.version.expires) &&
    value.version.expires > 0 &&
    (!Object.hasOwn(value.version, 'lastRefreshedAt') ||
      timestamp(value.version.lastRefreshedAt))
  )
}

/**
 * Match only the captured binding and exact OAuth material. Expired material
 * can still match evidence; serving freshness is a separate decision.
 */
export function nativeLocalCredentialValidationMatches(
  validation: unknown,
  binding: NativeLocalPoolBinding,
  material: NativeLocalCredentialMaterial | undefined,
): boolean {
  if (
    !isNativeLocalCredentialValidation(validation) ||
    !isNativeLocalPoolBinding(binding) ||
    binding.identity === undefined ||
    !record(material) ||
    material.type !== 'oauth' ||
    !token(material.access) ||
    !token(material.refresh) ||
    !timestamp(material.expires) ||
    material.expires <= 0 ||
    (Object.hasOwn(material, 'lastRefreshedAt') &&
      !timestamp(material.lastRefreshedAt))
  )
    return false
  return (
    validation.binding.storageId === binding.storageId &&
    validation.binding.rowId === binding.rowId &&
    validation.binding.credentialEpoch === binding.credentialEpoch &&
    validation.binding.identity === binding.identity &&
    validation.credentialFingerprint ===
      fingerprintOf({ type: 'oauth', refresh: material.refresh }) &&
    validation.version.accessFingerprint ===
      tokenFingerprint(material.access) &&
    validation.version.expires === material.expires &&
    // An absent stamp is not a zero stamp and must never acquire a default.
    Object.hasOwn(validation.version, 'lastRefreshedAt') ===
      Object.hasOwn(material, 'lastRefreshedAt') &&
    validation.version.lastRefreshedAt === material.lastRefreshedAt
  )
}
