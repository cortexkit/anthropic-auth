import { NativeAccountRefusal } from './native-account-refusal.ts'
import {
  NativeCustodyError,
  type NativeCustodyErrorCode,
} from './native-custody.ts'

export type CacheKeepFailureStage = 'authorization' | 'send' | 'response'

const ERROR_NAMES = ['AbortError', 'TimeoutError', 'TypeError'] as const
const NETWORK_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_INVALID_ARG',
  'UND_ERR_INVALID_RETURN_VALUE',
  'UND_ERR_ABORTED',
  'UND_ERR_CLIENT_DESTROYED',
  'UND_ERR_CLIENT_CLOSED',
  'UND_ERR_SOCKET',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_INFO',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE',
  'UND_ERR_PRX_TLS',
] as const
const CUSTODY_CODES = [
  'closed',
  'not-enrolled',
  'invalid-token',
  'unavailable',
  'identity-changed',
  'identity-unasserted',
  'insufficient-validity',
  'invalid-material',
  'not-active',
  'route-unavailable',
  'route-declined',
  'no-receipt',
  'unsafe-file',
  'invalid-state',
  'wrong-consumer',
  'roster-busy',
  'host-slot-login',
  'host-slot-placeholder',
  'placeholder-refresh',
  'invalid-order',
] as const satisfies readonly NativeCustodyErrorCode[]
const REFUSAL_CODES = [
  'account-policy',
  'account-unavailable',
  'credential-changed',
] as const

export type CacheKeepFailureClass =
  | (typeof ERROR_NAMES)[number]
  | (typeof NETWORK_CODES)[number]
  | (typeof CUSTODY_CODES)[number]
  | (typeof REFUSAL_CODES)[number]
  | number
  | 'unknown'

export type CacheKeepFailure = {
  stage: CacheKeepFailureStage
  class: CacheKeepFailureClass
}

function allowed<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function httpFailure(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599 &&
    (value < 200 || value >= 300)
  )
}

/** Copy only closed codes, never an exception's message, stack, cause or provider text. */
export function classifyCacheKeepFailure(
  error: unknown,
  stage: CacheKeepFailureStage,
  status?: number,
): CacheKeepFailure {
  const unknown: CacheKeepFailure = { stage, class: 'unknown' }
  try {
    if (httpFailure(status)) return { stage: 'response', class: status }
    if (error instanceof CacheKeepPrewarmError) {
      const originalStage = error.stage
      const safeStage =
        originalStage === 'authorization' || originalStage === 'response'
          ? originalStage
          : 'send'
      const value = error.class
      return {
        stage: safeStage,
        class:
          httpFailure(value) ||
          allowed(ERROR_NAMES, value) ||
          allowed(NETWORK_CODES, value) ||
          allowed(CUSTODY_CODES, value) ||
          allowed(REFUSAL_CODES, value)
            ? value
            : 'unknown',
      }
    }
    if (error instanceof NativeAccountRefusal) {
      const reason = error.reason
      if (allowed(REFUSAL_CODES, reason))
        return { stage: 'authorization', class: reason }
    }
    if (error instanceof NativeCustodyError) {
      const code = error.code
      if (allowed(CUSTODY_CODES, code))
        return { stage: 'authorization', class: code }
    }
    if (typeof error !== 'object' || error === null) return unknown
    const fields = error as {
      name?: unknown
      code?: unknown
      cause?: { code?: unknown }
    }
    const name = fields.name
    if (name === 'AbortError' || name === 'TimeoutError')
      return { stage, class: name }
    // Node fetch wraps socket failures in TypeError; its immediate cause can
    // supply a more useful closed network code without copying the cause.
    const code = fields.code
    if (allowed(NETWORK_CODES, code)) return { stage, class: code }
    const causeCode = fields.cause?.code
    if (allowed(NETWORK_CODES, causeCode)) return { stage, class: causeCode }
    if (allowed(ERROR_NAMES, name)) return { stage, class: name }
  } catch {}
  return unknown
}

/** A host boundary that retains diagnostics but no native credential-bearing error. */
export class CacheKeepPrewarmError extends Error implements CacheKeepFailure {
  readonly stage: CacheKeepFailureStage
  readonly class: CacheKeepFailureClass

  constructor(stage: CacheKeepFailureStage, error: unknown, status?: number) {
    super('CacheKeep prewarm failed')
    this.name = 'CacheKeepPrewarmError'
    const failure = classifyCacheKeepFailure(error, stage, status)
    this.stage = failure.stage
    this.class = failure.class
  }
}
