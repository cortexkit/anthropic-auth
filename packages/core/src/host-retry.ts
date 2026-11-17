/** Ordinary host retries recheck availability periodically. */
export const MAX_HOST_RETRY_MS = 15 * 60_000

// Only locally constructed, fully evidenced pool refusals may bypass the cap.
// An upstream Retry-After or a routing hold cannot opt itself into a long wait.
const resetWaits = new WeakMap<Response, number>()

export function markResetWaitResponse(
  response: Response,
  delayMs: number,
): Response {
  resetWaits.set(response, delayMs)
  return response
}

export function resetWaitDelayMs(response: Response): number | undefined {
  return resetWaits.get(response)
}

export function clampHostRetryMs(delayMs: number): number {
  return Math.max(
    0,
    Math.min(MAX_HOST_RETRY_MS, Number.isNaN(delayMs) ? 0 : delayMs),
  )
}

/** Keep quota reset headers intact: they are evidence, not instructions to the host. */
export function hostRetryHeaders(upstream: Headers, now = Date.now()): Headers {
  const headers = new Headers(upstream)
  for (const name of ['retry-after', 'retry-after-ms']) {
    const value = headers.get(name)
    if (value === null) continue
    const numeric = value.trim() ? Number(value) : NaN
    const delayMs =
      name === 'retry-after-ms'
        ? numeric
        : Number.isNaN(numeric)
          ? Date.parse(value) - now
          : numeric * 1000
    if (Number.isNaN(delayMs)) {
      headers.delete(name)
      continue
    }
    const capped = clampHostRetryMs(delayMs)
    if (capped !== delayMs)
      headers.set(
        name,
        String(name === 'retry-after-ms' ? capped : capped / 1000),
      )
  }
  return headers
}

export function hostRetryResponse(
  response: Response,
  now = Date.now(),
): Response {
  if (resetWaits.has(response)) return response
  const headers = hostRetryHeaders(response.headers, now)
  if (
    ['retry-after', 'retry-after-ms'].every(
      (name) => headers.get(name) === response.headers.get(name),
    )
  )
    return response
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
