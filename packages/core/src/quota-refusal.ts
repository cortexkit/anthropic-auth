import type { quotaRefusalTiming } from './accounts.ts'

export function createQuotaRefusalResponse(
  reason: string,
  timing: ReturnType<typeof quotaRefusalTiming>,
  now = Date.now(),
): Response {
  const reset =
    timing.resetAt === undefined
      ? 'Reset time is unknown.'
      : `Reset at ${new Intl.DateTimeFormat('en-US', {
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
        }).format(timing.resetAt)}.`
  const seconds =
    timing.resetAt === undefined
      ? 300
      : Math.max(1, Math.ceil((timing.resetAt - now) / 1000))
  const retry =
    timing.retryAfterSeconds === undefined
      ? ''
      : ` Retry in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type:
          timing.retryAfterSeconds === undefined
            ? 'FAILED_PRECONDITION'
            : 'rate_limit_error',
        message: `${reason}${retry} ${reset}`,
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
}
