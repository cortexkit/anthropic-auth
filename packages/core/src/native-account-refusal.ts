import { NativeCustodyError } from './native-custody.ts'
import type { NativeRefreshResult } from './native-refresh-coordinator.ts'

export function nativeValidationRetryAt(
  result: NativeRefreshResult,
): number | undefined {
  return result.status === 'refused' || result.status === 'failed'
    ? result.validationRetryAt
    : undefined
}

export function formatNativeValidationBackoffMessage(time: string): string {
  return `Claude couldn't confirm which account this login belongs to. It will check again at ${time}. To check now, use Reset account backoff in /claude.`
}

export type NativeAccountRefusalReason =
  | 'account-policy'
  | 'account-unavailable'
  | 'credential-changed'

/** A closed, credential-free refusal that retrying a background send cannot fix. */
export class NativeAccountRefusal extends Error {
  readonly reason: NativeAccountRefusalReason

  constructor(reason: NativeAccountRefusalReason) {
    const safe =
      reason === 'account-policy' || reason === 'credential-changed'
        ? reason
        : 'account-unavailable'
    super(`Native account refused: ${safe}`)
    this.name = 'NativeAccountRefusal'
    this.reason = safe
  }
}

/** Unknown failures and vault outages retain the caller's existing retry policy. */
export function nativeAccountRefusal(
  error: unknown,
): NativeAccountRefusal | undefined {
  if (error instanceof NativeAccountRefusal) return error
  if (!(error instanceof NativeCustodyError)) return undefined
  switch (error.code) {
    case 'closed':
    case 'unavailable':
    case 'roster-busy':
    case 'insufficient-validity':
      return undefined
    case 'identity-changed':
      return new NativeAccountRefusal('credential-changed')
    case 'not-enrolled':
    case 'invalid-token':
    case 'identity-unasserted':
    case 'invalid-material':
    case 'not-active':
    case 'route-unavailable':
    case 'route-declined':
    case 'no-receipt':
    case 'unsafe-file':
    case 'invalid-state':
    case 'wrong-consumer':
    case 'host-slot-login':
    case 'host-slot-placeholder':
    case 'placeholder-refresh':
    case 'invalid-order':
      return new NativeAccountRefusal('account-unavailable')
    default:
      return undefined
  }
}

/** Refresh/validation backoff and failed I/O are not permanent account refusals. */
export function nativeLocalAccountRefusal(
  result: NativeRefreshResult,
): NativeAccountRefusal | undefined {
  if (result.status === 'identity-contradicted')
    return new NativeAccountRefusal('credential-changed')
  if (result.status === 'failed')
    return !result.reconciliationFailed &&
      (result.failure.classification === 'invalid-grant' ||
        (result.failure.kind === 'provider' &&
          result.failure.classification === 'permanent' &&
          result.failure.status !== undefined &&
          result.failure.status >= 400 &&
          result.failure.status < 500 &&
          result.failure.status !== 408 &&
          result.failure.status !== 429))
      ? new NativeAccountRefusal('account-unavailable')
      : undefined
  if (result.status !== 'refused') return undefined
  switch (result.reason) {
    case 'quota-ineligible':
      return new NativeAccountRefusal('account-policy')
    case 'binding-changed':
    case 'validation-contradicted':
      return new NativeAccountRefusal('credential-changed')
    case 'account-disabled':
    case 'local-mode-unavailable':
    case 'custody-mode':
    case 'row-ineligible':
    case 'unsupported-access':
    case 'invalid-grant':
      return new NativeAccountRefusal('account-unavailable')
    default:
      return undefined
  }
}
