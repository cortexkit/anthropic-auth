// Exact invalidReason and sanitizedBody functions from Core v2.13.1
// (git tag v2.13.1, packages/core/src/cachekeep-store.ts). Keep frozen for rollback tests.
import { createHash } from 'node:crypto'
import {
  CACHE_KEEP_MAX_BODY_BYTES,
  type SavedCacheKeepTarget,
} from '@cortexkit/anthropic-auth-core'

const RECORD_FORMAT_VERSION = 1
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
type DropReason = 'invalid' | 'format' | 'expired'

function sanitizedBody(text: string): string {
  const body = JSON.parse(text) as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Invalid restart body')
  let stripped = false
  // Only transport-like fields at the request root are credentials. A tool's
  // JSON schema or conversation content can legitimately name these fields;
  // changing those would change the cached prefix.
  for (const key of Object.keys(body)) {
    if (
      /^(authorization|x-api-key|cookie|set-cookie|headers|credentials|token|access[_-]?token|refresh[_-]?token)$/i.test(
        key,
      )
    ) {
      delete body[key]
      stripped = true
    }
  }
  return stripped ? JSON.stringify(body) : text
}

function invalidReason(
  value: SavedCacheKeepTarget,
  name: string,
  now: number,
): DropReason | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'invalid'
  if (value.v !== RECORD_FORMAT_VERSION) return 'format'
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    `${hash(value.id)}.json.gz` !== name ||
    typeof value.bodyText !== 'string' ||
    Buffer.byteLength(value.bodyText) > CACHE_KEEP_MAX_BODY_BYTES ||
    typeof value.url !== 'string' ||
    typeof value.oauthAccountIdentity !== 'string' ||
    !value.oauthAccountIdentity ||
    typeof value.isSubagent !== 'boolean' ||
    !Number.isFinite(value.cacheExpiresAt) ||
    !Number.isFinite(value.nextPrewarmAt)
  )
    return 'invalid'
  if (value.cacheExpiresAt <= now) return 'expired'
  const state = value.policyState
  if (
    state !== undefined &&
    (!state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      typeof state.ownerSessionId !== 'string' ||
      !state.ownerSessionId ||
      typeof state.planned !== 'boolean' ||
      typeof state.hasWarmed !== 'boolean' ||
      (state.needsRealRequest !== undefined &&
        typeof state.needsRealRequest !== 'boolean') ||
      !Number.isFinite(state.lastRealRequestAt) ||
      state.lastRealRequestAt > now ||
      (state.lastWarmAt !== undefined &&
        (!Number.isFinite(state.lastWarmAt) || state.lastWarmAt > now)) ||
      !Number.isSafeInteger(state.warmsSinceLastRealRequest) ||
      state.warmsSinceLastRealRequest < 0 ||
      !Number.isFinite(state.warmCostSoFar) ||
      state.warmCostSoFar < 0 ||
      (state.pendingWarmCost !== undefined &&
        (!Number.isFinite(state.pendingWarmCost) ||
          state.pendingWarmCost < 0)) ||
      [state.prefixTokens, state.inputTokens].some(
        (tokens) =>
          tokens !== undefined && (!Number.isFinite(tokens) || tokens < 0),
      ))
  )
    return 'invalid'
  // Malformed bodies and credential-bearing records are not replayable.
  if (sanitizedBody(value.bodyText) !== value.bodyText) return 'invalid'
}

export { invalidReason }
