import {
  type SessionCachePolicy,
  type SessionCacheTtl,
  sessionCachePolicy,
} from '@cortexkit/common-auth/routing-accessor'
import {
  PROMPT_CACHE_1H_TTL_MS,
  PROMPT_CACHE_DEFAULT_TTL_MS,
} from './session-cache-activity.ts'

export type {
  SessionCachePolicy,
  SessionCacheTtl,
  SessionKeepWarmMode,
} from '@cortexkit/common-auth/routing-accessor'

/** API-key requests return no session cache policy, leaving host settings unchanged. */
export function readSessionCachePolicy(
  sessionId: string | null | undefined,
  isOAuth: boolean,
): SessionCachePolicy | null {
  return isOAuth && sessionId ? sessionCachePolicy(sessionId) : null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Visit protocol breakpoint sites, never arbitrary tool schemas or arguments. */
function cacheHolders(
  body: Record<string, unknown>,
  visit: (holder: Record<string, unknown>) => void,
): void {
  visit(body)
  for (const field of ['tools', 'system']) {
    const value = body[field]
    for (const item of Array.isArray(value) ? value : [value]) {
      if (record(item)) visit(item)
    }
  }
  if (!Array.isArray(body.messages)) return
  for (const message of body.messages) {
    if (!record(message)) continue
    visit(message)
    if (Array.isArray(message.content)) {
      for (const block of message.content) if (record(block)) visit(block)
    }
  }
}

/** Apply only a lifetime override; the host still chooses breakpoint placement. */
export function applySessionCacheTtl(
  body: Record<string, unknown>,
  ttl: SessionCacheTtl | undefined,
): void {
  if (ttl === undefined) return
  cacheHolders(body, (holder) => {
    if (ttl === 'none') {
      delete holder.cache_control
      delete holder.cacheControl
      return
    }
    const control = holder.cache_control ?? holder.cacheControl
    if (!record(control) || control.type !== 'ephemeral') return
    holder.cache_control = control
    delete holder.cacheControl
    if (ttl === 'long') control.ttl = '1h'
    else delete control.ttl
  })
}

/** The longest sent cache lifetime bounds when every cached prefix is gone. */
export function requestCacheLifetimeMs(
  input: Record<string, unknown> | string,
): number {
  let body: unknown = input
  if (typeof input === 'string') {
    try {
      body = JSON.parse(input)
    } catch {
      return 0
    }
  }
  if (!record(body)) return 0
  let ttlMs = 0
  cacheHolders(body, (holder) => {
    for (const key of ['cache_control', 'cacheControl']) {
      const control = holder[key]
      if (!record(control) || control.type !== 'ephemeral') continue
      ttlMs = Math.max(
        ttlMs,
        control.ttl === '1h'
          ? PROMPT_CACHE_1H_TTL_MS
          : PROMPT_CACHE_DEFAULT_TTL_MS,
      )
    }
  })
  return ttlMs
}
