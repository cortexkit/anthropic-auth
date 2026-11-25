import { signRequestBody } from './cch.ts'
import { SERVER_SIDE_FALLBACK_BETA } from './server-fallback-usage.ts'
import {
  createSseFramer,
  DEFAULT_SSE_MAX_FRAME_BYTES,
  decodeSseFrame,
  isTerminatedSseFrame,
  parseSseFrame,
  SseFrameTooLargeError,
} from './sse.ts'
import { copyStreamResponseTiming } from './stream-completion.ts'

const CREDIT_FIELD = 'fallback_credit_token'
export const FALLBACK_CREDIT_PLACEHOLDER =
  'cortexkit-redacted-fallback-credit-token'

function mayHaveCredit(text: string) {
  return text.includes(CREDIT_FIELD) || text.includes('\\u')
}

function creditRequestBody(text: string): Record<string, unknown> | undefined {
  if (!mayHaveCredit(text)) return undefined
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('Invalid fallback-credit request body')
  }
  if (body && typeof body === 'object' && Object.hasOwn(body, CREDIT_FIELD))
    return body as Record<string, unknown>
}

export function hasFallbackCreditInRequest(bodyText: string): boolean {
  return creditRequestBody(bodyText) !== undefined
}

/** A reusable or outbound observer view, not a substitute for the physical retry. */
export async function withoutFallbackCredit(bodyText: string): Promise<string> {
  const body = creditRequestBody(bodyText)
  if (!body) return bodyText
  delete body[CREDIT_FIELD]
  return signRequestBody(JSON.stringify(body))
}

export class FallbackCreditResponseTooLargeError extends Error {
  readonly code = 'FALLBACK_CREDIT_RESPONSE_TOO_LARGE'

  constructor(
    readonly bound: 'frame' | 'held' | 'body',
    readonly maxBytes: number,
  ) {
    super(`Fallback response exceeded its ${bound} limit of ${maxBytes} bytes`)
    this.name = 'FallbackCreditResponseTooLargeError'
  }
}

function checkedLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new TypeError(
      'Fallback response byte limit must be a positive integer',
    )
  return limit
}

/** One hold per response, shared by tool blocks, refusal blocks and terminal frames. */
export function createFallbackResponseHold<T>(
  maxBytes = DEFAULT_SSE_MAX_FRAME_BYTES,
) {
  maxBytes = Math.min(checkedLimit(maxBytes), DEFAULT_SSE_MAX_FRAME_BYTES)
  const groups = new Map<string | number, { frames: T[]; bytes: number }>()
  let bytes = 0
  let failed = false
  const clear = () => {
    groups.clear()
    bytes = 0
  }
  const release = (key: string | number): T[] => {
    const group = groups.get(key)
    if (!group) return []
    groups.delete(key)
    bytes -= group.bytes
    return group.frames
  }
  return {
    get bytes() {
      return bytes
    },
    hold(key: string | number, frame: T, byteLength: number) {
      checkedLimit(byteLength)
      if (failed || byteLength > maxBytes - bytes) {
        failed = true
        clear()
        throw new FallbackCreditResponseTooLargeError('held', maxBytes)
      }
      let group = groups.get(key)
      if (!group) {
        group = { frames: [], bytes: 0 }
        groups.set(key, group)
      }
      group.frames.push(frame)
      group.bytes += byteLength
      bytes += byteLength
    },
    release,
    discard(key: string | number) {
      release(key)
    },
    clear,
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function genuineCredit(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== FALLBACK_CREDIT_PLACEHOLDER
  )
}

function redactText(text: string, credits: ReadonlySet<string>): string {
  if (text === FALLBACK_CREDIT_PLACEHOLDER) return text
  for (const credit of credits) {
    text = text.replaceAll(credit, FALLBACK_CREDIT_PLACEHOLDER)
    const escaped = JSON.stringify(credit).slice(1, -1)
    if (escaped !== credit)
      text = text.replaceAll(escaped, FALLBACK_CREDIT_PLACEHOLDER)
  }
  return text
}

/** Find even a duplicate property overwritten before JSON.parse returns. */
function collectCreditStrings(text: string, add: (value: string) => void) {
  if (!mayHaveCredit(text)) return
  const strings = /"(?:[^"\\]|\\.)*"/g
  const valueAtColon = /\s*:\s*("(?:[^"\\]|\\.)*")/y
  for (const match of text.matchAll(strings)) {
    if (!mayHaveCredit(match[0]) || JSON.parse(match[0]) !== CREDIT_FIELD)
      continue
    valueAtColon.lastIndex = match.index + match[0].length
    const value = valueAtColon.exec(text)?.[1]
    if (value !== undefined) {
      const credit: unknown = JSON.parse(value)
      if (genuineCredit(credit)) add(credit)
    }
  }
}

/** JSON text must already have parsed successfully. Preserve clean bytes exactly. */
function redactJson(text: string, credits: ReadonlySet<string>): string {
  if (!mayHaveCredit(text) && credits.size === 0) return text
  let changed = redactText(text, credits) !== text
  const clean: unknown = JSON.parse(text, (key, value: unknown) => {
    if (key === CREDIT_FIELD) {
      changed = true
      return FALLBACK_CREDIT_PLACEHOLDER
    }
    if (typeof value === 'string') {
      const scrubbed = redactText(value, credits)
      changed ||= scrubbed !== value
      return scrubbed
    }
    if (typeof value === 'number' && credits.has(String(value))) {
      changed = true
      return FALLBACK_CREDIT_PLACEHOLDER
    }
    const object = record(value)
    if (object)
      for (const name of Object.keys(object)) {
        const scrubbed = redactText(name, credits)
        if (name === scrubbed) continue
        changed = true
        Object.defineProperty(object, scrubbed, {
          value: object[name],
          enumerable: true,
          configurable: true,
          writable: true,
        })
        delete object[name]
      }
    return value
  })
  return changed ? JSON.stringify(clean) : text
}

/** Keep the credit field in opt-in dumps, but mask it and its known echoes. */
export function fallbackCreditRequestDumpView(bodyText: string) {
  const body = creditRequestBody(bodyText)
  if (!body) return undefined
  const credits = new Set<string>()
  collectCreditStrings(bodyText, (credit) => credits.add(credit))
  return {
    bodyText: redactJson(bodyText, credits),
    text: (text: string | undefined) =>
      text === undefined ? undefined : redactText(text, credits),
    json: (text: string) => redactJson(text, credits),
  }
}

type ResponseOptions = {
  requestHeaders: Pick<Headers, 'get'>
  requestBodyText?: string
  /** The request's expected framing, when available. */
  framing?: 'event-stream' | 'http'
  maxPendingBytes?: number
  /** Delivers only a refusal's credit to the internal retry, never to host observers. */
  onRefusalCredit?: (credit: string) => void
}

const encoder = new TextEncoder()
const UNREADABLE_RESPONSE = JSON.stringify({
  type: 'error',
  error: { message: 'Unreadable fallback response body' },
})

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Protect the physical response before billing, dumps or host observers see it.
 * Inspect whole SSE frames (never a raw overflow or EOF tail) and keep the
 * original bytes of complete, clean frames, including their line endings.
 */
export function protectFallbackCreditResponse(
  response: Response,
  options: ResponseOptions,
): Response {
  const request = creditRequestBody(options.requestBodyText ?? '')
  const sentCredit = request?.[CREDIT_FIELD]
  const betas = options.requestHeaders.get('anthropic-beta')?.split(',')
  if (
    !request &&
    !betas?.some((beta) => beta.trim() === SERVER_SIDE_FALLBACK_BETA)
  )
    return response
  if (!response.body && !genuineCredit(sentCredit)) return response

  const maxBytes = Math.min(
    checkedLimit(options.maxPendingBytes ?? DEFAULT_SSE_MAX_FRAME_BYTES),
    DEFAULT_SSE_MAX_FRAME_BYTES,
  )
  const credits = new Set<string>()
  let secretBytes = 0
  const add = (credit: string) => {
    if (credits.has(credit)) return
    secretBytes += Buffer.byteLength(credit)
    if (secretBytes > maxBytes)
      throw new FallbackCreditResponseTooLargeError('body', maxBytes)
    credits.add(credit)
  }
  if (genuineCredit(sentCredit)) add(sentCredit)

  const headers = new Headers(response.headers)
  for (const [name, value] of headers)
    headers.set(name, redactText(value, credits))
  const statusText = redactText(response.statusText, credits)
  if (!response.body)
    return copyStreamResponseTiming(
      response,
      new Response(null, { status: response.status, statusText, headers }),
    )
  headers.delete('content-length')
  const contentType = headers.get('content-type') ?? ''
  const sse =
    /text\/event-stream/i.test(contentType) ||
    (response.ok &&
      options.framing === 'event-stream' &&
      !/\bjson\b/i.test(contentType))
  const framer = sse ? createSseFramer({ maxFrameBytes: maxBytes }) : undefined
  let streamStart = true
  let captured = false
  const rewriteFrame = (frame: Uint8Array): Uint8Array | undefined => {
    const text = decodeSseFrame(frame, { streamStart })
    streamStart = false
    const { data, event, id, retry } = parseSseFrame(text)
    if (data === undefined || data === '[DONE]' || data === '') {
      const clean = redactText(text, credits)
      return clean === text ? frame : encoder.encode(clean)
    }
    const parsed = parseJson(data)
    if (parsed !== undefined) {
      collectCreditStrings(data, add)
      const payload = record(parsed)
      const delta = record(payload?.delta)
      const credit = record(delta?.stop_details)?.[CREDIT_FIELD]
      if (
        !captured &&
        payload?.type === 'message_delta' &&
        delta?.stop_reason === 'refusal' &&
        genuineCredit(credit)
      ) {
        captured = true
        options.onRefusalCredit?.(credit)
      }
    } else if (event !== 'error') {
      // A malformed data line cannot be inspected for a credit field.
      return undefined
    }
    const safeData =
      parsed === undefined ? UNREADABLE_RESPONSE : redactJson(data, credits)
    if (safeData === data && redactText(text, credits) === text) return frame
    const safeEvent =
      event === undefined ? '' : `event: ${redactText(event, credits)}\n`
    const safeId = id === undefined ? '' : `id: ${redactText(id, credits)}\n`
    const safeRetry =
      retry === undefined ||
      redactText(String(retry), credits) !== String(retry)
        ? ''
        : `retry: ${retry}\n`
    return encoder.encode(
      `${safeEvent}${safeId}${safeRetry}${safeData
        .split('\n')
        .map((line) => `data: ${line}\n`)
        .join('')}\n`,
    )
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bodyBytes = 0
  const reset = () => {
    credits.clear()
    chunks.length = 0
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            if (framer) {
              let emitted = false
              for (const frame of framer.push(next.value)) {
                const clean = rewriteFrame(frame)
                if (clean) {
                  controller.enqueue(clean)
                  emitted = true
                }
              }
              if (emitted) return
            } else {
              bodyBytes += next.value.byteLength
              if (bodyBytes > maxBytes)
                throw new FallbackCreditResponseTooLargeError('body', maxBytes)
              chunks.push(next.value)
            }
          }
          if (framer) {
            const tail = framer.finish()
            // A blank line ending in CR at EOF is only resolved by finish().
            const clean =
              tail && isTerminatedSseFrame(tail) && rewriteFrame(tail)
            if (clean) controller.enqueue(clean)
          } else if (bodyBytes !== 0) {
            const bytes = new Uint8Array(bodyBytes)
            let offset = 0
            for (const chunk of chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            const text = new TextDecoder().decode(bytes)
            if (parseJson(text) === undefined)
              controller.enqueue(encoder.encode(UNREADABLE_RESPONSE))
            else {
              collectCreditStrings(text, add)
              const clean = redactJson(text, credits)
              controller.enqueue(clean === text ? bytes : encoder.encode(clean))
            }
          }
          reset()
          controller.close()
          reader.releaseLock()
        } catch (error) {
          reset()
          const safe =
            error instanceof SseFrameTooLargeError
              ? new FallbackCreditResponseTooLargeError('frame', maxBytes)
              : error instanceof FallbackCreditResponseTooLargeError
                ? error
                : new Error('Could not read fallback response')
          controller.error(safe)
          void reader.cancel(safe).catch(() => {})
          reader.releaseLock()
        }
      },
      async cancel() {
        reset()
        try {
          await reader.cancel()
        } finally {
          reader.releaseLock()
        }
      },
    },
    { highWaterMark: 0 },
  )
  return copyStreamResponseTiming(
    response,
    new Response(body, {
      status: response.status,
      statusText,
      headers,
    }),
  )
}
