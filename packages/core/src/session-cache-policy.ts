import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type CacheTouchInput,
  type CacheWarmStoppedInput,
  isCacheWarmStopReason,
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
  pending: Array<{ send: () => void; responseTouch: boolean }>
}>()

function scheduleReport(send: () => void) {
  reportHandoffs.exit(() =>
    setTimeout(() => {
      try {
        send()
      } catch {}
    }, 0).unref?.(),
  )
}

function detachReport(
  send: () => void,
  responseTouch = false,
  background = false,
): boolean {
  if (background) {
    scheduleReport(send)
    return true
  }
  const handoff = reportHandoffs.getStore()
  if (handoff?.failed && responseTouch) return false
  if (handoff && !handoff.released)
    handoff.pending.push({ send, responseTouch })
  else scheduleReport(send)
  return true
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
      pending: [] as Array<{ send: () => void; responseTouch: boolean }>,
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
        for (const { send, responseTouch } of pending)
          if (!handoff.failed || !responseTouch) scheduleReport(send)
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
  detachReport(
    () => reportCacheTouch(sessionId, input),
    input.source === 'response',
    input.source === 'warm',
  )
}

/** Only in-memory terminal removals report stops; startup drops and closed lifetimes are silent. */
export type SessionCacheWarmStopReason =
  | CacheWarmStoppedInput['reason']
  | 'deadline-missed'

/**
 * llm-runner 0.8.56 admits deadline-missed. Remove this special case with
 * common-auth 0.51.0. In 0.50.0 the final billing wrapper still omits that
 * reason, but cache_warm_stopped forwards it unchanged.
 */
export function isSessionCacheWarmStopReason(
  value: unknown,
): value is SessionCacheWarmStopReason {
  return value === 'deadline-missed' || isCacheWarmStopReason(value)
}

export function reportSessionCacheWarmStopped(
  sessionId: string,
  input: Omit<CacheWarmStoppedInput, 'reason'> & {
    reason: SessionCacheWarmStopReason
  },
): boolean {
  // llm-runner 0.8.56 admits deadline-missed; remove this compatibility cast
  // when adopting common-auth 0.51.0, which includes the reason in its types.
  return detachReport(() =>
    reportCacheWarmStopped(sessionId, input as CacheWarmStoppedInput),
  )
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

function visitRequestCacheLifetimes(
  input: Record<string, unknown> | string,
  visit: (ttlMs: number) => void,
): void {
  let body: unknown = input
  if (typeof input === 'string') {
    try {
      body = JSON.parse(input)
    } catch {
      return
    }
  }
  if (!record(body)) return
  cacheHolders(body, (holder) => {
    for (const key of ['cache_control', 'cacheControl']) {
      const control = holder[key]
      if (!record(control) || control.type !== 'ephemeral') continue
      visit(
        control.ttl === '1h'
          ? PROMPT_CACHE_1H_TTL_MS
          : PROMPT_CACHE_DEFAULT_TTL_MS,
      )
    }
  })
}

/**
 * Cache-touch reports and our local activity, hold and keep-warm timing use the
 * longest sent lifetime: the cache is fully cold only after every prefix expires.
 * Billing reports use requestShortestCacheLifetimeMs instead.
 */
export function requestCacheLifetimeMs(
  input: Record<string, unknown> | string,
): number {
  let ttlMs = 0
  visitRequestCacheLifetimes(input, (lifetime) => {
    ttlMs = Math.max(ttlMs, lifetime)
  })
  return ttlMs
}

/** Billing reports use the shortest sent lifetime among the cache breakpoints. */
export function requestShortestCacheLifetimeMs(
  input: Record<string, unknown> | string,
): number {
  let ttlMs = Infinity
  visitRequestCacheLifetimes(input, (lifetime) => {
    ttlMs = Math.min(ttlMs, lifetime)
  })
  return ttlMs === Infinity ? 0 : ttlMs
}
