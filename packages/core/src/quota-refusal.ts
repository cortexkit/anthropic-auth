import type { quotaRefusalTiming } from './accounts.ts'
import { clampHostRetryMs, markResetWaitResponse } from './host-retry.ts'

const details = new WeakMap<
  Response,
  { reason: string; timing: ReturnType<typeof quotaRefusalTiming> }
>()

export const quotaRefusalDetails = (response: Response) => details.get(response)

// Whole minutes only: a capped wait can be a few seconds short of a minute boundary.
function retryMinutes(seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60))
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

export function createQuotaRefusalResponse(
  reason: string,
  timing: ReturnType<typeof quotaRefusalTiming>,
  now = Date.now(),
  options: { retry?: 'automatic' | 'manual' } = {},
): Response {
  const resetWaitMs =
    options.retry !== 'manual' ? timing.resetWaitMs : undefined
  timing = {
    ...timing,
    retryAfterSeconds:
      resetWaitMs !== undefined
        ? resetWaitMs / 1000
        : timing.retryAfterSeconds === undefined
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
  const room = timing.limitName
    ? `No Claude account has room for this request (${timing.limitName} limit or your quota floor). `
    : ''
  const manualAction = resetTime
    ? `The earliest reset is ${resetTime} UTC (in ${duration}). Send the message again after ${resetTime} UTC.`
    : 'Reset time is unknown. Check account availability before sending the message again.'
  const message =
    options.retry === 'manual' || seconds === undefined
      ? `${room}This turn has stopped. ${manualAction} ${reason}`
      : resetWaitMs !== undefined && resetTime
        ? `${room}The earliest reset is ${resetTime} UTC (in ${duration}). Waiting until the reset before retrying. ${reason}`
        : timing.limitName && resetTime
          ? `${room}The earliest reset is ${resetTime} UTC (in ${duration}). Retrying every ${retryMinutes(seconds)}. ${reason}`
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
  return resetWaitMs === undefined
    ? response
    : markResetWaitResponse(response, resetWaitMs)
}
