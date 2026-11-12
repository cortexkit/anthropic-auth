import { logger } from './logger.ts'
import {
  createSseFramer,
  decodeSseFrame,
  isTerminatedSseFrame,
  parseSseFrame,
} from './sse.ts'

export interface IncompleteStreamDiagnostics {
  response_headers: Record<string, string>
  response_bytes: number
  encoded_body_bytes?: number
  decoded_body_bytes?: number
  sse_events: number
  send_to_headers_ms?: number
  /**
   * For credential_scope, send_to_headers_ms starts at credential preparation and
   * includes host scheduling and gzip time: an upper bound, not network latency.
   */
  timing_source?: 'physical_fetch' | 'credential_scope'
  headers_to_eof_ms: number
}

const timings = new WeakMap<
  Response,
  {
    sent: number
    headers: number
    contentLength?: string
    source: 'physical_fetch' | 'credential_scope'
    bodySizes?: () =>
      | Pick<
          IncompleteStreamDiagnostics,
          'encoded_body_bytes' | 'decoded_body_bytes'
        >
      | undefined
  }
>()

/** Preserve physical-send timing across wrappers without reading or cloning the body. */
export function copyStreamResponseTiming(
  source: Response,
  target: Response,
  sent?: number,
  timingSource: 'physical_fetch' | 'credential_scope' = 'physical_fetch',
  bodySizes?: () =>
    | Pick<
        IncompleteStreamDiagnostics,
        'encoded_body_bytes' | 'decoded_body_bytes'
      >
    | undefined,
) {
  const timing = timings.get(source)
  if (timing) timings.set(target, timing)
  else if (sent !== undefined)
    timings.set(target, {
      sent,
      headers: performance.now(),
      contentLength: responseHeaders(target.headers)['content-length'],
      source: timingSource,
      bodySizes,
    })
  return target
}

function responseHeaders(
  headers: Pick<Headers, 'get'>,
): Record<string, string> {
  const result: Record<string, string> = {}
  const rules = {
    'request-id': /^req_[A-Za-z0-9_-]{1,128}$/,
    'cf-ray': /^[a-fA-F0-9]{16,32}(?:-[A-Z]{3})?$/,
    'content-type':
      /^(?:text\/event-stream|application\/json|text\/plain)(?:;\s*charset=utf-8)?$/i,
    'content-encoding': /^(?:gzip|br|deflate|identity)$/,
    'content-length': /^\d{1,16}$/,
  }
  for (const [name, rule] of Object.entries(rules)) {
    const value = headers.get(name)
    if (value !== null && rule.test(value)) result[name] = value
  }
  return result
}

function bodyByteCounts(input?: {
  encoded_body_bytes?: number
  decoded_body_bytes?: number
}) {
  const { encoded_body_bytes, decoded_body_bytes } = input ?? {}
  return typeof encoded_body_bytes === 'number' &&
    Number.isSafeInteger(encoded_body_bytes) &&
    encoded_body_bytes >= 0 &&
    typeof decoded_body_bytes === 'number' &&
    Number.isSafeInteger(decoded_body_bytes) &&
    decoded_body_bytes >= 0
    ? { encoded_body_bytes, decoded_body_bytes }
    : {}
}

export function safeIncompleteStreamDiagnostics(
  input: IncompleteStreamDiagnostics,
): IncompleteStreamDiagnostics {
  const count = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0
  return {
    response_headers: responseHeaders({
      get: (name) => input.response_headers[name] ?? null,
    }),
    response_bytes: count(input.response_bytes),
    ...bodyByteCounts(input),
    sse_events: count(input.sse_events),
    ...(input.send_to_headers_ms !== undefined
      ? { send_to_headers_ms: count(input.send_to_headers_ms) }
      : {}),
    ...(input.timing_source === 'physical_fetch' ||
    input.timing_source === 'credential_scope'
      ? { timing_source: input.timing_source }
      : {}),
    headers_to_eof_ms: count(input.headers_to_eof_ms),
  }
}

/** EOF requires a complete message_stop or an explicit protocol error. */
export function createAnthropicStreamCompletion(response: Response) {
  const framer = createSseFramer()
  const timing = timings.get(response)
  const headers = responseHeaders(response.headers)
  const contentLength = timing?.contentLength
  // Body-rewriting wrappers remove Content-Length; keep only its validated original count.
  if (contentLength !== undefined) headers['content-length'] = contentLength
  const headersAt = timing?.headers ?? performance.now()
  let bytes = 0
  let events = 0
  let stopped = false
  let failed = false
  let streamStart = true
  let eofAt: number | undefined
  const inspect = (frame: Uint8Array) => {
    const data = parseSseFrame(decodeSseFrame(frame, { streamStart })).data
    streamStart = false
    if (!data || data === '[DONE]') return
    events++
    try {
      const event = JSON.parse(data)
      if (event?.type === 'message_stop') stopped = true
      // An explicit error event already ends the stream as a failure the caller
      // reports, so finish() must not add an incomplete-stream error on top.
      if (event?.type === 'error') failed = true
    } catch {
      // Invalid data cannot certify a completed Anthropic response.
    }
  }
  const end = () => {
    if (eofAt !== undefined) return
    eofAt = performance.now()
    const tail = framer.finish()
    // A final CR blank line is complete even though the framer waits for a possible LF.
    if (tail && isTerminatedSseFrame(tail)) inspect(tail)
  }
  return {
    end,
    push(chunk: Uint8Array) {
      bytes += chunk.byteLength
      for (const frame of framer.push(chunk)) inspect(frame)
    },
    finish():
      | (Error & { code: string; diagnostics: IncompleteStreamDiagnostics })
      | undefined {
      end()
      if (stopped || failed) return undefined
      const diagnostics: IncompleteStreamDiagnostics = {
        response_headers: headers,
        response_bytes: bytes,
        ...bodyByteCounts(timing?.bodySizes?.()),
        sse_events: events,
        ...(timing
          ? {
              send_to_headers_ms: Math.max(
                0,
                Math.round(timing.headers - timing.sent),
              ),
              timing_source: timing.source,
            }
          : {}),
        headers_to_eof_ms: Math.max(
          0,
          Math.round((eofAt ?? performance.now()) - headersAt),
        ),
      }
      logger.warn('stream', 'Anthropic connection closed before message_stop', {
        ...diagnostics,
      })
      return Object.assign(
        new Error(
          'Anthropic connection reset: stream ended before message_stop (ECONNRESET)',
        ),
        { code: 'ECONNRESET', syscall: 'anthropic-sse', diagnostics },
      )
    },
  }
}

/** Validate passthrough API streams without rewriting tool names or response bytes. */
export function guardAnthropicStreamResponse(
  response: Response,
  onIncomplete?: (
    diagnostics: IncompleteStreamDiagnostics,
  ) => void | Promise<void>,
): Response {
  if (!response.ok) return response
  const completion = createAnthropicStreamCompletion(response)
  const reader = response.body?.getReader()
  return copyStreamResponseTiming(
    response,
    new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const chunk = await reader?.read()
              if (!chunk || chunk.done) {
                completion.end()
                const error = completion.finish()
                reader?.releaseLock()
                if (error) {
                  await onIncomplete?.(error.diagnostics)
                  controller.error(error)
                } else controller.close()
                return
              }
              completion.push(chunk.value)
              controller.enqueue(chunk.value)
            } catch (error) {
              controller.error(error)
              await reader?.cancel(error).catch(() => {})
              reader?.releaseLock()
            }
          },
          async cancel(reason) {
            try {
              await reader?.cancel(reason)
            } finally {
              reader?.releaseLock()
            }
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    ),
  )
}
