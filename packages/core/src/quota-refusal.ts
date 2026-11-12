import type { quotaRefusalTiming } from './accounts.ts'
import { clampHostRetryMs } from './host-retry.ts'

const details = new WeakMap<
  Response,
  { reason: string; timing: ReturnType<typeof quotaRefusalTiming> }
>()

export const quotaRefusalDetails = (response: Response) => details.get(response)

export function createQuotaRefusalResponse(
  reason: string,
  timing: ReturnType<typeof quotaRefusalTiming>,
  now = Date.now(),
  options: { retry?: 'automatic' | 'manual' } = {},
): Response {
  timing = {
    ...timing,
    retryAfterSeconds:
      timing.retryAfterSeconds === undefined
        ? undefined
        : clampHostRetryMs(timing.retryAfterSeconds * 1000) / 1000,
  }
  const reset =
    timing.resetAt === undefined
      ? 'Reset time is unknown.'
      : `Reset at ${new Intl.DateTimeFormat('en-US', {
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
          timeZone: 'UTC',
        }).format(timing.resetAt)}.`
  const seconds = timing.retryAfterSeconds
  const retry =
    seconds === undefined
      ? ''
      : ` Retry in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`
  const resetTime =
    timing.resetAt === undefined
      ? undefined
      : new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC',
          hour12: false,
        }).format(timing.resetAt)
  const remaining =
    timing.resetAt === undefined ? 0 : Math.max(0, timing.resetAt - now)
  const duration =
    remaining >= 3_600_000
      ? `${Math.ceil(remaining / 3_600_000)} h`
      : `${Math.ceil(remaining / 60_000)} min`
  const message =
    timing.limitName && resetTime
      ? `All Claude accounts are at a usage limit (${timing.limitName} limit). The earliest reset is ${resetTime} UTC (in ${duration}). ${seconds === undefined || options.retry === 'manual' ? 'Send the message again after that.' : `Retrying every ${seconds / 60} minutes.`} ${reason}`
      : `${reason}${retry} ${reset}`
  const response = new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type:
          timing.retryAfterSeconds === undefined
            ? 'FAILED_PRECONDITION'
            : 'rate_limit_error',
        message,
      },
    }),
    {
      status: timing.retryAfterSeconds === undefined ? 412 : 429,
      headers: {
        'content-type': 'application/json',
        ...(timing.retryAfterSeconds === undefined
          ? {}
          : { 'retry-after': String(timing.retryAfterSeconds) }),
      },
    },
  )
  details.set(response, { reason, timing })
  return response
}
