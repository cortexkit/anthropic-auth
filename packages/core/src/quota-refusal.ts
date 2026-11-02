import type { quotaRefusalTiming } from './accounts.ts'

const details = new WeakMap<
  Response,
  { reason: string; timing: ReturnType<typeof quotaRefusalTiming> }
>()

export const quotaRefusalDetails = (response: Response) => details.get(response)

export function createQuotaRefusalResponse(
  reason: string,
  timing: ReturnType<typeof quotaRefusalTiming>,
  _now?: number,
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
  const seconds = timing.retryAfterSeconds
  const retry =
    seconds === undefined
      ? ''
      : ` Retry in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`
  const response = new Response(
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
  details.set(response, { reason, timing })
  return response
}
