import {
  createQuotaRefusalResponse,
  quotaRefusalDetails,
} from '@cortexkit/anthropic-auth-core'

export type PiQuotaWaitOptions = {
  now?: () => number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  setWorkingMessage?: (message?: string) => void
}

export type PiAccountHold = {
  accountId: string
  accountIdentity?: string
  resetAt: number
}

const holds = new WeakMap<Response, PiAccountHold>()

export function markPiAccountHold(response: Response, hold: PiAccountHold) {
  holds.set(response, hold)
  return response
}

async function waitForReset(
  delayMs: number,
  resetAt: number | undefined,
  signal: AbortSignal | undefined,
  options: PiQuotaWaitOptions,
) {
  signal?.throwIfAborted()
  const set = options.setTimeout ?? globalThis.setTimeout
  const clear = options.clearTimeout ?? globalThis.clearTimeout
  const when = resetAt ?? (options.now?.() ?? Date.now()) + delayMs
  const time = new Date(when).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  try {
    options.setWorkingMessage?.(
      `Waiting for the account to reset at ${time} · Esc to cancel`,
    )
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clear(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const timer = set(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, delayMs)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  } finally {
    options.setWorkingMessage?.()
  }
}

/** Own one bounded wait inside a Pi stream, rather than asking Pi's text-based retry loop. */
export async function withPiQuotaWait(input: {
  run: () => Promise<Response>
  resume: (hold: PiAccountHold | undefined) => Promise<Response>
  signal?: AbortSignal
  wait?: PiQuotaWaitOptions
}) {
  const response = await input.run()
  const hold = holds.get(response)
  const refusal = quotaRefusalDetails(response)
  const delay = Number(response.headers.get('retry-after')) * 1000
  if (
    (!hold && !refusal) ||
    !response.headers.has('retry-after') ||
    !Number.isFinite(delay) ||
    delay <= 0
  )
    return response
  const options = input.wait ?? {}
  void response.body?.cancel().catch(() => {})
  input.signal?.throwIfAborted()
  // An unknown reset's retry hint is not evidence that waiting can help this request.
  if (!hold && refusal && refusal.timing.resetAt === undefined)
    return createQuotaRefusalResponse(refusal.reason, {
      resetAt: undefined,
      retryAfterSeconds: undefined,
    })
  await waitForReset(
    delay,
    hold?.resetAt ?? refusal?.timing.resetAt,
    input.signal,
    options,
  )
  input.signal?.throwIfAborted()
  let next: Response | undefined
  try {
    next = await input.resume(hold)
    if (next.ok || next.status === 401) return next
  } catch (error) {
    if (input.signal?.aborted) throw error
  }
  const latest = next && quotaRefusalDetails(next)
  void next?.body?.cancel().catch(() => {})
  // Do not leak a rate-limit code or retry guidance into Pi's final error classifier.
  return createQuotaRefusalResponse(
    latest?.reason ??
      refusal?.reason ??
      'The selected OAuth account cannot serve this request. Open /claude to review account availability.',
    {
      resetAt:
        latest?.timing.resetAt ?? refusal?.timing.resetAt ?? hold?.resetAt,
      retryAfterSeconds: undefined,
    },
    options.now?.() ?? Date.now(),
  )
}
