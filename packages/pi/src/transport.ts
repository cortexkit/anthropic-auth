import {
  type PerformanceEntry,
  PerformanceObserver,
  type PerformanceResourceTiming,
} from 'node:perf_hooks'
import {
  type AnthropicOAuthOriginOptions,
  copyStreamResponseTiming,
  createAnthropicOAuthFetch,
  type IncompleteStreamDiagnostics,
  requireAnthropicOAuthOrigin,
} from '@cortexkit/anthropic-auth-core'

// Pi keeps its own refusal wording; Core supplies the origin rule itself.
const PI_OAUTH_ORIGIN: AnthropicOAuthOriginOptions = {
  refusal: (reason) =>
    new Error(
      reason === 'unparseable'
        ? 'Native OAuth requires the official Anthropic HTTPS origin'
        : 'Native OAuth requires the official Anthropic HTTPS origin without URL userinfo',
    ),
}

/** Model base URLs and remembered cache-warm URLs must send OAuth tokens only to Anthropic’s HTTPS server. */
export function requirePiOAuthOrigin(value: string): URL {
  return requireAnthropicOAuthOrigin(value, PI_OAUTH_ORIGIN)
}

export function buildPiOAuthMessagesUrl(baseUrl: string): URL {
  return new URL('/v1/messages?beta=true', requirePiOAuthOrigin(baseUrl))
}

/** Reject redirects rather than letting an approved OAuth destination forward the request. */
export const fetchPiOAuth: typeof fetch =
  createAnthropicOAuthFetch(PI_OAUTH_ORIGIN)

export async function fetchPiStreamResponse(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  fetchImpl = globalThis.fetch,
) {
  const sentAt = performance.now()
  let invokedUntil = Infinity
  const url = input instanceof Request ? input.url : String(input)
  let sizes:
    | Pick<
        IncompleteStreamDiagnostics,
        'encoded_body_bytes' | 'decoded_body_bytes'
      >
    | undefined
  const collect = (entries: PerformanceEntry[]) => {
    const entry = entries.find(
      (entry) =>
        entry.name === url &&
        entry.startTime >= sentAt &&
        entry.startTime <= invokedUntil &&
        (entry as PerformanceResourceTiming).initiatorType === 'fetch',
    ) as PerformanceResourceTiming | undefined
    if (!entry) return
    sizes = {
      encoded_body_bytes: entry.encodedBodySize,
      decoded_body_bytes: entry.decodedBodySize,
    }
    observer?.disconnect()
  }
  // Observers have private queues, so concurrent warms cannot consume each
  // other's timing. Leave the runtime's bounded global timeline untouched.
  const observer = process.versions.bun
    ? undefined
    : new PerformanceObserver((list) => collect(list.getEntries()))
  observer?.observe({ type: 'resource' })
  const settle = () => {
    if (observer) collect(observer.takeRecords())
    observer?.disconnect()
  }
  try {
    // Resource startTime is recorded synchronously inside this physical fetch,
    // not while awaiting headers; another same-URL send has a different window.
    let pending: Promise<Response>
    try {
      pending = fetchImpl(input, init)
    } finally {
      invokedUntil = performance.now()
    }
    const response = await pending
    copyStreamResponseTiming(
      response,
      response,
      sentAt,
      'physical_fetch',
      () => sizes,
    )
    if (!observer || !response.body) {
      settle()
      return response
    }
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            // Undici publishes resource timing after resolving the final read.
            // Let that end-of-body task run before closing the observed stream.
            await new Promise<void>((resolve) => setImmediate(resolve))
            settle()
            reader.releaseLock()
            controller.close()
          } else controller.enqueue(value)
        } catch (error) {
          settle()
          reader.releaseLock()
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          settle()
          reader.releaseLock()
        }
      },
    })
    return copyStreamResponseTiming(
      response,
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    )
  } catch (error) {
    settle()
    throw error
  }
}
