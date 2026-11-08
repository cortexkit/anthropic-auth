import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type CacheTouchInput,
  type CacheWarmStoppedInput,
  reportCacheTouch,
  reportCacheWarmStopped,
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

const reportHandoffs = new AsyncLocalStorage<{
  released: boolean
  failed: boolean
  pending: Array<() => void>
}>()

function detachReport(send: () => void) {
  const handoff = reportHandoffs.getStore()
  if (handoff?.failed) return
  if (handoff && !handoff.released) handoff.pending.push(send)
  else setTimeout(send, 0).unref?.()
}

/**
 * Admitting a real response can retire an older warmed target before body
 * inspection finishes. Buffer both report kinds until the outer host callback
 * settles; later background callbacks still send without awaiting the bridge.
 */
export function withSessionCacheReportHandoff<Args extends unknown[], T>(
  work: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  return (...args) => {
    const handoff = {
      released: false,
      failed: false,
      pending: [] as Array<() => void>,
    }
    return reportHandoffs.run(handoff, async () => {
      try {
        return await work(...args)
      } catch (error) {
        handoff.failed = true
        throw error
      } finally {
        handoff.released = true
        const pending = handoff.pending.splice(0)
        if (!handoff.failed)
          for (const send of pending) setTimeout(send, 0).unref?.()
      }
    })
  }
}

/**
 * Queue at host hand-off or after a completed background warm. Thalamus's
 * routing report bridge, not auth, resends its newest failed touch.
 */
export function reportSessionCacheTouch(
  sessionId: string,
  input: CacheTouchInput,
): void {
  detachReport(() => reportCacheTouch(sessionId, input))
}

/** Stops describe actual warming, not a refusal to start warming. */
export function reportSessionCacheWarmStopped(
  sessionId: string,
  input: CacheWarmStoppedInput,
): void {
  detachReport(() => reportCacheWarmStopped(sessionId, input))
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
