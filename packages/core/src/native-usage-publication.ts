import { types } from 'node:util'
import { logger } from './logger.ts'
import { transientNetworkErrorCode } from './network-errors.ts'

/**
 * Custody, ownership and integrity refusals need an ERROR diagnostic; ordinary
 * storage failures need a WARN. Neither may revoke an already-served reply.
 * The error classes are not public runtime exports, so match name and code.
 */
export function usagePublicationRefusalIsFatal(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'NativeCustodyError') return true
  if (error.name !== 'NativeRuntimeError') return false
  const code: unknown = Reflect.get(error, 'code')
  return (
    code === 'publication-refused' ||
    code === 'unsafe-runtime' ||
    code === 'invalid-runtime'
  )
}

const names = new Set([
  'Error',
  'TypeError',
  'AbortError',
  'NativeCustodyError',
  'NativeRuntimeError',
  'NativeAccountReadError',
  'LockContentionError',
])
const codes = new Set([
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
  'publication-refused',
  'unsafe-runtime',
  'invalid-runtime',
  'runtime-io',
  'runtime-conflict',
  'EIO',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/** Return only allowlisted classes and codes, never the exception text. */
export function classifySafeErrorForLog(error: unknown) {
  let name = 'unknown'
  let code = 'unknown'
  try {
    if (error instanceof Error && names.has(error.name)) name = error.name
    if (!error || typeof error !== 'object' || types.isProxy(error))
      return { name, code }
    const field = (key: string) =>
      Object.getOwnPropertyDescriptor(error, key)?.value
    const value = field('code')
    if (typeof value === 'string' && codes.has(value)) code = value
    else {
      const status = field('status')
      if (
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
      )
        code = `HTTP_${status}`
      else {
        code =
          transientNetworkErrorCode({
            code: value,
            message: field('message'),
          }) ?? 'unknown'
      }
    }
  } catch {
    // Arbitrary thrown objects may have hostile getters; omit them entirely.
  }
  return { name, code }
}

function logPublicationFailure(channel: string, error: unknown): void {
  let level: 'error' | 'warn' = 'warn'
  try {
    if (usagePublicationRefusalIsFatal(error)) level = 'error'
  } catch {
    // An arbitrary thrown object may have getters that throw. Do not inspect
    // it further or let diagnostic extraction reject the detached task.
  }
  logger[level](
    channel,
    'Account usage publication unavailable',
    classifySafeErrorForLog(error),
  )
}

// Bookkeeping must not hold shutdown behind another process's 10–15s lease.
// Only lock acquisition is cancelled; acquired writes and accepted store queues drain.
const ADVISORY_SHUTDOWN_GRACE_MS = 1_000

/** Own advisory writes for one host instance and join them before runtime close. */
export function createNativeUsagePublisher(channel: string) {
  const pending = new Set<Promise<void>>()
  const shutdown = new AbortController()
  let draining: Promise<void> | undefined
  let dropped = 0
  const observe = (write: Promise<unknown>): Promise<void> => {
    const work = write.then(
      () => {},
      (error: unknown) => {
        if (shutdown.signal.aborted && error === shutdown.signal.reason)
          dropped++
        else logPublicationFailure(channel, error)
      },
    )
    pending.add(work)
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    )
    return work
  }
  return {
    signal: shutdown.signal,
    // Header writes start at receipt; disposal, not attempt end, joins them.
    observe,
    publish(write: (signal: AbortSignal) => Promise<unknown>): void {
      // A new event-loop turn gives the host its response before bookkeeping
      // starts, including when the writer does synchronous work before await.
      void observe(
        new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
          write(shutdown.signal),
        ),
      )
    },
    drain(): Promise<void> {
      if (draining) return draining
      draining = (async () => {
        const timer = setTimeout(
          () => shutdown.abort(),
          ADVISORY_SHUTDOWN_GRACE_MS,
        )
        try {
          while (pending.size) await Promise.allSettled([...pending])
        } finally {
          clearTimeout(timer)
          if (dropped) {
            logger.debug(
              channel,
              'Account usage publications dropped at shutdown',
              { count: dropped },
            )
            dropped = 0
          }
        }
      })().finally(() => {
        draining = undefined
      })
      return draining
    },
  }
}
