import {
  createFallbackResponseHold,
  FallbackCreditResponseTooLargeError,
} from './fallback-credit.ts'
import { captureRefusalFallbackReply } from './refusal-fallback-reply.ts'
import { createRecoveryThinkingObserver } from './refusal-fallback-thinking.ts'
import {
  createSseFramer,
  DEFAULT_SSE_MAX_FRAME_BYTES,
  isTerminatedSseFrame,
  parseSseFrame,
  type SseEvent,
  SseFrameTooLargeError,
} from './sse.ts'
import {
  copyStreamResponseTiming,
  incompleteAnthropicStreamError,
} from './stream-completion.ts'

type Payload = Record<string, unknown>

type Frame = SseEvent & {
  bytes: Uint8Array
  payload?: Payload
  type?: string
}

export type RefusalFallbackPrefillBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

export type RefusalFallbackStreamRefusal = {
  category?: string
  creditToken?: string
  usage?: Readonly<Payload>
  hasHostContent: boolean
  hasPrefillClaim: boolean
  /** Null when the visible content was too large to retain for an exact prefill. */
  prefillBlocks?: readonly RefusalFallbackPrefillBlock[] | null
}

export type RefusalFallbackStreamRetry =
  | {
      kind: 'retry'
      response: Response
      onCommitted?: () => void
      onCompleted?: (completion: RefusalFallbackCompletion) => void
      onThinkingDigest?: (digest: string) => void
      onFinished?: () => void
    }
  | { kind: 'none'; reason: string }
  | { kind: 'defer' }

export type RefusalFallbackCompletion = {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage?: Readonly<Payload>
  /** Joined host-visible reply, in wire order. Null if it could not be compared safely. */
  reply?: readonly Payload[] | null
}

export type RefusalFallbackCompletedRefusal = {
  category?: string
  usage?: Readonly<Payload>
  releasedTool: boolean
  reply?: RefusalFallbackCompletion['reply']
}

export type RefusalFallbackLifecycle = {
  onCompleted?: (completion: RefusalFallbackCompletion) => void
  onRefusal?: (refusal: RefusalFallbackCompletedRefusal) => void
  onDeferredRefusal?: (refusal: RefusalFallbackCompletedRefusal) => void
  captureReply?: boolean
  onThinkingDigest?: (digest: string) => void
}

type HeartbeatClock = {
  now: () => number
  schedule: (callback: () => void, delayMs: number) => () => void
}

export type RefusalFallbackStreamOptions = {
  sourceModel: string
  isFresh: () => boolean
  takeSourceRefusalCredit?: () => string | undefined
  retry?: (
    refusal: RefusalFallbackStreamRefusal,
    signal: AbortSignal,
  ) => RefusalFallbackStreamRetry | Promise<RefusalFallbackStreamRetry>
  lifecycle?: RefusalFallbackLifecycle
  signal?: AbortSignal
  maxPendingBytes?: number
  /** Test clock for the fixed 30-second keep-alive. */
  clock?: HeartbeatClock
}

const encoder = new TextEncoder()
const ping = encoder.encode('event: ping\ndata: {"type":"ping"}\n\n')
const heartbeatMs = 30_000
const terminalKey = 'refused-terminal'
const realClock: HeartbeatClock = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
}

function record(value: unknown): Payload | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Payload
}

function parse(bytes: Uint8Array): Frame {
  const sse = parseSseFrame(bytes)
  let payload: Payload | undefined
  if (sse.data) {
    try {
      payload = record(JSON.parse(sse.data))
    } catch {
      // Non-JSON frames cannot carry a block or certify a message stop.
    }
  }
  return {
    ...sse,
    bytes,
    payload,
    type:
      typeof payload?.type === 'string'
        ? payload.type
        : payload || sse.event === 'ping' || sse.event === 'error'
          ? sse.event
          : undefined,
  }
}

function encode(payload: Payload, sse?: SseEvent): Uint8Array {
  const event = sse ? sse.event : payload.type
  return encoder.encode(
    `${event ? `event: ${event}\n` : ''}${sse?.id === undefined ? '' : `id: ${sse.id}\n`}${sse?.retry === undefined ? '' : `retry: ${sse.retry}\n`}data: ${JSON.stringify(payload)}\n\n`,
  )
}

function indexed(frame: Frame, index: number): Uint8Array {
  return frame.payload && frame.payload.index !== index
    ? encode({ ...frame.payload, index }, frame)
    : frame.bytes
}

function mergedUsage(start?: Payload, end?: Payload): Payload | undefined {
  if (!start && !end) return undefined
  const startCache = record(start?.cache_creation)
  const endCache = record(end?.cache_creation)
  return {
    ...start,
    ...end,
    ...((startCache || endCache) && {
      cache_creation: { ...startCache, ...endCache },
    }),
  }
}

function joinedUsage(start?: Payload, end?: Payload): Payload {
  const usage = mergedUsage(start, end)
  return {
    ...usage,
    input_tokens: usage?.input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 0,
      ...record(usage?.cache_creation),
    },
  }
}

async function* readFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes: number,
): AsyncGenerator<Frame> {
  const framer = createSseFramer({ maxFrameBytes: maxBytes })
  const reader = body.getReader()
  let eof = false
  let first = true
  const cancel = () => void reader.cancel().catch(() => {})
  const decode = (bytes: Uint8Array) => {
    if (first) {
      first = false
      // The retry's first frame can be an upstream ping, not a message_start.
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        bytes = bytes.subarray(3)
    }
    return parse(bytes)
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      for (const bytes of framer.push(next.value)) yield decode(bytes)
    }
    eof = true
    const tail = framer.finish()
    if (tail && isTerminatedSseFrame(tail)) yield decode(tail)
  } catch (error) {
    if (error instanceof SseFrameTooLargeError)
      throw new FallbackCreditResponseTooLargeError('frame', maxBytes)
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!eof) cancel()
    reader.releaseLock()
  }
}

type Block =
  | { kind: 'visible'; hostIndex: number }
  | { kind: 'tool_use' | 'refusal' }

function createAttempt(maxBytes: number, holdChanged: () => void) {
  const hold = createFallbackResponseHold<Uint8Array>(maxBytes)
  const blocks = new Map<number, Block>()
  let startUsage: Payload | undefined
  let releasedTool = false
  let started = false
  let refusalBlock = false
  let completed = false
  let completion: RefusalFallbackCompletion | undefined
  return {
    hold,
    blocks,
    get startUsage() {
      return startUsage
    },
    rememberStart(frame: Frame) {
      started = true
      startUsage = record(record(frame.payload?.message)?.usage)
    },
    rememberRefusalBlock() {
      refusalBlock = true
    },
    rememberDelta(frame: Frame) {
      const reason = record(frame.payload?.delta)?.stop_reason
      if (reason == null) return
      completion =
        reason === 'end_turn' ||
        reason === 'tool_use' ||
        reason === 'max_tokens'
          ? {
              stopReason: reason,
              usage: mergedUsage(startUsage, record(frame.payload?.usage)),
            }
          : undefined
    },
    takeCompletion() {
      if (!started || refusalBlock || completed) return undefined
      completed = true
      return completion
    },
    invalidateCompletion() {
      completed = true
    },
    get canReportRefusal() {
      return started && !completed
    },
    get releasedTool() {
      return releasedTool
    },
    recordReleasedTool() {
      releasedTool = true
    },
    withhold(key: string | number, frame: Frame) {
      // SSE frames may be views into a much larger input chunk.
      hold.hold(key, frame.bytes.slice(), frame.bytes.byteLength)
      holdChanged()
    },
    dropTools() {
      for (const [index, block] of blocks) {
        if (block.kind !== 'tool_use') continue
        blocks.delete(index)
        hold.discard(index)
      }
    },
    clear() {
      blocks.clear()
      hold.clear()
      holdChanged()
    },
  }
}

type Attempt = ReturnType<typeof createAttempt>

function createPrefillCapture(maxBytes: number) {
  const blocks = new Map<
    number,
    { block: RefusalFallbackPrefillBlock; closed: boolean }
  >()
  let bytes = 0
  let overflow = false
  let incomplete = false
  return {
    markIncomplete() {
      incomplete = true
    },
    push(index: number, frame: Frame) {
      if (overflow) return
      if (frame.type === 'content_block_start') {
        const start = record(frame.payload?.content_block)
        let block: RefusalFallbackPrefillBlock | undefined
        if (start?.type === 'text' && typeof start.text === 'string') {
          block = { type: 'text', text: start.text }
        } else if (start?.type === 'thinking') {
          block = {
            type: 'thinking',
            thinking: typeof start.thinking === 'string' ? start.thinking : '',
            signature:
              typeof start.signature === 'string' ? start.signature : '',
          }
        } else if (
          start?.type === 'redacted_thinking' &&
          typeof start.data === 'string' &&
          start.data
        ) {
          block = { type: 'redacted_thinking', data: start.data }
        }
        if (!block) {
          incomplete = true
          return
        }
        blocks.set(index, { block, closed: false })
      } else {
        const entry = blocks.get(index)
        if (!entry) return
        const { block } = entry
        if (frame.type === 'content_block_stop') entry.closed = true
        const delta = record(frame.payload?.delta)
        if (
          block.type === 'text' &&
          delta?.type === 'text_delta' &&
          typeof delta.text === 'string'
        ) {
          block.text += delta.text
        } else if (block.type === 'thinking') {
          if (
            delta?.type === 'thinking_delta' &&
            typeof delta.thinking === 'string'
          )
            block.thinking += delta.thinking
          if (
            delta?.type === 'signature_delta' &&
            typeof delta.signature === 'string'
          )
            block.signature += delta.signature
        }
      }
      // Count framing too, so a large number of tiny blocks is also bounded.
      bytes += frame.bytes.byteLength
      if (bytes > maxBytes) {
        overflow = true
        blocks.clear()
      }
    },
    complete() {
      if (overflow || incomplete) return null
      const content: RefusalFallbackPrefillBlock[] = []
      for (const { block, closed } of blocks.values()) {
        // The join closes visible text even if Anthropic refused mid-block.
        // Thinking must have arrived signed and closed from Anthropic.
        if (
          block.type !== 'text' &&
          (!closed || (block.type === 'thinking' && !block.signature))
        )
          return null
        content.push(block)
      }
      return content
    },
    clear() {
      blocks.clear()
    },
  }
}

/**
 * Join one eligible client-mode Messages SSE response to at most one retry.
 * Pass protected physical responses (see protectFallbackCreditResponse), after
 * installing per-attempt billing/observation and before host stream parsing.
 * HTTP errors from the original request pass through untouched. For a response
 * already sent to a fallback model (a later step of a recovery round started by
 * an earlier refusal), or one routed there, omit `retry`: the same holds apply
 * without another send.
 * `sourceModel` is the host-requested ID, even if a target served this response.
 *
 * `isFresh` must be synchronous and cheap. It guards action at the refusal,
 * entering the retry callback, and the retry's first host-visible content. The
 * callback still owns the check immediately before each physical dispatch.
 * `takeSourceRefusalCredit` retrieves and clears the one private credit captured
 * by the source response's `onRefusalCredit`; it is never read from SSE data.
 *
 * The callback receives the refusal's `category`, private `creditToken`, source
 * attempt `usage`, and `hasHostContent` (whether source content reached the host).
 * `hasPrefillClaim` means the provider indicated that a credited retry can
 * include preceding assistant content. The callback picks the target, checks
 * authorization and admission for each send, and builds the retry body. Use
 * the supplied abort signal for all sends and reads. The source's terminal
 * frames stay held during the callback. Return `retry` with a protected SSE
 * response, or `none` with a reason if no retry can supply an answer.
 *
 * No retry, a stale result, or a retry failure before visible content releases
 * the original refusal blocks and terminal frames once. The first visible retry
 * block or complete non-refusal terminal pair commits the join; the retry's
 * message_start and the source refusal are dropped. Subsequent retry errors
 * belong to the host stream, not to another attempt. A refusal on a current
 * request can end as tool_use if the host received a complete tool call; the
 * refusal blocks and stop_details are omitted in that case. Host abort or
 * body cancellation cancels the active read/send without replaying a refusal.
 */
export function joinRefusalFallbackStream(
  response: Response,
  options: RefusalFallbackStreamOptions,
): Response {
  const sourceBody = response.body
  if (!response.ok || !sourceBody) return response
  const { isFresh, retry, signal, clock = realClock } = options
  const maxBytes = Math.min(
    options.maxPendingBytes ?? DEFAULT_SSE_MAX_FRAME_BYTES,
    DEFAULT_SSE_MAX_FRAME_BYTES,
  )
  const abort = new AbortController()
  const openHost = new Set<number>()
  let nextHostIndex = 0
  let sourceHasContent = false
  let retryAttempt: Attempt | undefined
  let controller: ReadableStreamDefaultController<Uint8Array>
  let demand: (() => void) | undefined
  let resume: (() => void) | undefined
  let stopTimer: (() => void) | undefined
  let started = false
  let finished = false
  let lastByte = 0

  const source = createAttempt(maxBytes, updateHeartbeat)
  const reply = options.lifecycle?.captureReply
    ? captureRefusalFallbackReply(DEFAULT_SSE_MAX_FRAME_BYTES)
    : undefined
  function observeThinking(callback: ((digest: string) => void) | undefined) {
    return (
      callback &&
      createRecoveryThinkingObserver((digest) => notify(callback, digest))
    )
  }
  let provenance = observeThinking(options.lifecycle?.onThinkingDigest)
  const prefill =
    retry && options.takeSourceRefusalCredit
      ? createPrefillCapture(maxBytes)
      : undefined

  function notify<T>(callback: ((event: T) => void) | undefined, event: T) {
    try {
      callback?.(event)
    } catch {
      // A lifecycle observer cannot interrupt the answer.
    }
  }

  function complete(
    attempt: Attempt,
    callback: RefusalFallbackLifecycle['onCompleted'],
  ) {
    if (!callback || abort.signal.aborted || !isFresh()) return
    const completion = attempt.takeCompletion()
    if (completion)
      notify(callback, {
        ...completion,
        ...(reply && { reply: reply.complete() }),
      })
  }

  function updateHeartbeat() {
    stopTimer?.()
    stopTimer = undefined
    if (!demand || (!source.hold.bytes && !retryAttempt?.hold.bytes)) return
    stopTimer = clock.schedule(
      () => emit([ping.slice()]),
      Math.max(0, heartbeatMs - (clock.now() - lastByte)),
    )
  }

  function emit(frames: Uint8Array[]) {
    if (!frames.length) return
    controller.enqueue(frames.length === 1 ? frames[0] : Buffer.concat(frames))
    lastByte = clock.now()
    const resolve = demand
    demand = undefined
    updateHeartbeat()
    resolve?.()
  }

  async function waitForDemand() {
    if (!demand && !finished) {
      await new Promise<void>((resolve) => {
        resume = resolve
      })
    }
    abort.signal.throwIfAborted()
  }

  function closeOpen(output: Uint8Array[]) {
    for (const index of openHost) {
      output.push(encode({ type: 'content_block_stop', index }))
      provenance?.close(index)
    }
    openHost.clear()
  }

  function capture(index: number, frame: Frame) {
    if (!frame.payload) return
    reply?.push(index, frame.payload)
    provenance?.push(frame.payload, index)
  }

  function releaseBlock(
    attempt: Attempt,
    upstreamIndex: number,
    output: Uint8Array[],
  ) {
    closeOpen(output)
    const index = nextHostIndex++
    let stopped = false
    for (const bytes of attempt.hold.release(upstreamIndex)) {
      const frame = parse(bytes)
      capture(index, frame)
      output.push(indexed(frame, index))
      stopped = frame.type === 'content_block_stop'
    }
    if (!stopped) output.push(encode({ type: 'content_block_stop', index }))
    attempt.blocks.delete(upstreamIndex)
  }

  function terminal(
    attempt: Attempt,
    frame: Frame,
    output: Uint8Array[],
    { repair = false, joined = false } = {},
  ) {
    const payload = frame.payload
    const delta = record(payload?.delta)
    if (typeof delta?.stop_reason === 'string') {
      closeOpen(output)
      attempt.dropTools()
      for (const [index, block] of attempt.blocks)
        if (block.kind === 'refusal' && !repair)
          releaseBlock(attempt, index, output)
      for (const [index, block] of attempt.blocks) {
        if (block.kind === 'refusal') attempt.hold.discard(index)
      }
      attempt.blocks.clear()
    }
    if (repair && delta) {
      const { stop_details: _details, ...rest } = delta
      output.push(
        encode(
          {
            ...payload,
            delta: { ...rest, stop_reason: 'tool_use' },
            ...(joined && {
              usage: joinedUsage(attempt.startUsage, record(payload?.usage)),
            }),
          },
          frame,
        ),
      )
    } else if (joined && payload) {
      output.push(
        encode(
          {
            ...payload,
            usage: joinedUsage(attempt.startUsage, record(payload.usage)),
          },
          frame,
        ),
      )
    } else output.push(frame.bytes)
  }

  function forwardBlock(
    attempt: Attempt,
    frame: Frame,
    beforeContent: () => Uint8Array[],
  ) {
    const upstreamIndex = frame.payload?.index
    if (
      typeof upstreamIndex !== 'number' ||
      !Number.isSafeInteger(upstreamIndex) ||
      upstreamIndex < 0
    )
      return
    const block = attempt.blocks.get(upstreamIndex)
    if (frame.type === 'content_block_start') {
      if (block) return
      const type = record(frame.payload?.content_block)?.type
      if (type === 'tool_use' || type === 'refusal') {
        if (type === 'refusal') attempt.rememberRefusalBlock()
        attempt.blocks.set(upstreamIndex, { kind: type })
        attempt.withhold(upstreamIndex, frame)
        return
      }
      const output = beforeContent()
      const hostIndex = nextHostIndex++
      attempt.blocks.set(upstreamIndex, { kind: 'visible', hostIndex })
      openHost.add(hostIndex)
      if (attempt === source && !source.releasedTool)
        prefill?.push(hostIndex, frame)
      capture(hostIndex, frame)
      output.push(indexed(frame, hostIndex))
      emit(output)
    } else if (block?.kind === 'tool_use' || block?.kind === 'refusal') {
      attempt.withhold(upstreamIndex, frame)
      if (frame.type === 'content_block_stop' && block.kind === 'tool_use') {
        const output = beforeContent()
        releaseBlock(attempt, upstreamIndex, output)
        attempt.recordReleasedTool()
        if (attempt === source) prefill?.clear()
        emit(output)
      }
    } else if (block?.kind === 'visible') {
      if (frame.type === 'content_block_stop')
        attempt.blocks.delete(upstreamIndex)
      if (!openHost.has(block.hostIndex)) return
      if (frame.type === 'content_block_stop') openHost.delete(block.hostIndex)
      if (attempt === source && !source.releasedTool)
        prefill?.push(block.hostIndex, frame)
      capture(block.hostIndex, frame)
      emit([indexed(frame, block.hostIndex)])
    }
  }

  const beforeSourceContent = (): Uint8Array[] => {
    sourceHasContent = true
    return []
  }

  async function runRetry(
    refusal: RefusalFallbackStreamRefusal,
  ): Promise<boolean | 'defer'> {
    if (!retry) return false
    const retryAbort = new AbortController()
    const retrySignal = AbortSignal.any([abort.signal, retryAbort.signal])
    let committed = false
    let pendingTerminal: Frame | undefined
    let onCommitted: (() => void) | undefined
    let onFinished: (() => void) | undefined
    const stale = new Error('Stale fallback response')
    const beforeContent = () => {
      const output: Uint8Array[] = []
      if (!committed) {
        if (!isFresh()) throw stale
        committed = true
        try {
          onCommitted?.()
        } catch {
          // A host observer cannot interrupt a committed answer.
        }
        closeOpen(output)
        source.clear()
      }
      return output
    }
    try {
      const result = await retry(refusal, retrySignal)
      if (result.kind === 'none') return false
      if (result.kind === 'defer') return 'defer'
      const { response: target } = result
      onCommitted = result.onCommitted
      onFinished = result.onFinished
      if (!target.ok || retrySignal.aborted || !target.body) {
        void target.body?.cancel().catch(() => {})
        return false
      }
      if (result.onThinkingDigest)
        provenance = observeThinking(result.onThinkingDigest)
      const attempt = createAttempt(maxBytes, updateHeartbeat)
      retryAttempt = attempt
      for await (const frame of readFrames(
        target.body,
        retrySignal,
        maxBytes,
      )) {
        await waitForDemand()
        if (frame.type === 'message_start') attempt.rememberStart(frame)
        else if (frame.type === 'ping')
          emit([committed ? frame.bytes : ping.slice()])
        else if (frame.type === 'error' || frame.event === 'error') {
          if (committed) emit([frame.bytes])
          break
        } else if (frame.type === 'message_delta') {
          if (result.onCompleted) attempt.rememberDelta(frame)
          const reason = record(frame.payload?.delta)?.stop_reason
          if (!committed) {
            if (reason === 'refusal') return false
            if (typeof reason === 'string' && reason)
              pendingTerminal = { ...frame, bytes: frame.bytes.slice() }
            continue
          }
          const output: Uint8Array[] = []
          terminal(attempt, frame, output, {
            repair: reason === 'refusal' && attempt.releasedTool && isFresh(),
            joined: true,
          })
          emit(output)
        } else if (frame.type === 'message_stop') {
          const output: Uint8Array[] = pendingTerminal ? beforeContent() : []
          if (pendingTerminal)
            terminal(attempt, pendingTerminal, output, { joined: true })
          if (committed) {
            complete(attempt, result.onCompleted)
            output.push(frame.bytes)
            emit(output)
          }
          break
        } else if (
          frame.type === 'content_block_start' ||
          frame.type === 'content_block_delta' ||
          frame.type === 'content_block_stop'
        )
          forwardBlock(attempt, frame, beforeContent)
        else if (committed) emit([frame.bytes])
      }
      return committed
    } catch (error) {
      if (committed || abort.signal.aborted) throw error
      return false
    } finally {
      if (!committed) retryAbort.abort()
      provenance?.finish()
      provenance = undefined
      notify(onFinished, undefined)
      retryAttempt?.clear()
      retryAttempt = undefined
    }
  }

  async function run(sourceBody: ReadableStream<Uint8Array>) {
    const frames = readFrames(sourceBody, abort.signal, maxBytes)
    for await (const frame of frames) {
      await waitForDemand()
      if (frame.type === 'message_start') {
        source.rememberStart(frame)
        const message = record(frame.payload?.message)
        // Inline blocks reach the host but aren't captured by the block events.
        if (Array.isArray(message?.content) && message.content.length > 0) {
          sourceHasContent = true
          prefill?.markIncomplete()
        }
        emit([
          message && message.model !== options.sourceModel
            ? encode(
                {
                  ...frame.payload,
                  message: { ...message, model: options.sourceModel },
                },
                frame,
              )
            : frame.bytes,
        ])
      } else if (frame.type === 'message_delta') {
        if (options.lifecycle?.onCompleted) source.rememberDelta(frame)
        const delta = record(frame.payload?.delta)
        if (delta?.stop_reason !== 'refusal') {
          const output = beforeSourceContent()
          terminal(source, frame, output)
          emit(output)
          continue
        }
        const freshAtRefusal = isFresh()
        source.withhold(terminalKey, frame)
        source.dropTools()
        // Consume the source terminal pair so the physical attempt stays complete
        // and the original frames are available if the retry does not commit.
        let sawStop = false
        for (;;) {
          const next = await frames.next()
          if (next.done) break
          await waitForDemand()
          if (next.value.type === 'ping') emit([next.value.bytes])
          else if (next.value.type === 'error' || next.value.event === 'error')
            throw incompleteAnthropicStreamError()
          else if (next.value.type === 'message_stop') {
            source.withhold(terminalKey, next.value)
            sawStop = true
            break
          }
        }
        await frames.return(undefined)
        await waitForDemand()
        const fresh = freshAtRefusal && isFresh()
        const details = record(delta.stop_details)
        const refusal = {
          category:
            details?.type === 'refusal' && typeof details.category === 'string'
              ? details.category
              : undefined,
          usage: mergedUsage(source.startUsage, record(frame.payload?.usage)),
        }
        if (fresh && sawStop && source.canReportRefusal)
          notify(options.lifecycle?.onRefusal, {
            ...refusal,
            releasedTool: source.releasedTool,
            ...(reply && source.releasedTool && { reply: reply.complete() }),
          })
        const creditToken = options.takeSourceRefusalCredit?.()
        const hasPrefillClaim = details?.fallback_has_prefill_claim === true
        const prefillBlocks =
          fresh && creditToken && hasPrefillClaim
            ? prefill?.complete()
            : undefined
        prefill?.clear()
        if (sawStop && fresh && !source.releasedTool && retry) {
          const result = await runRetry({
            ...refusal,
            creditToken,
            hasHostContent: sourceHasContent,
            hasPrefillClaim,
            ...(prefillBlocks !== undefined && { prefillBlocks }),
          })
          if (result === true) return
          if (result === 'defer' && source.canReportRefusal && isFresh())
            notify(options.lifecycle?.onDeferredRefusal, {
              ...refusal,
              releasedTool: false,
            })
        }
        await waitForDemand()
        const output = beforeSourceContent()
        const [, ...stops] = source.hold.release(terminalKey)
        terminal(source, frame, output, {
          repair: fresh && source.releasedTool,
        })
        for (const stop of stops) output.push(stop)
        emit(output)
        return
      } else if (
        frame.type === 'content_block_start' ||
        frame.type === 'content_block_delta' ||
        frame.type === 'content_block_stop'
      )
        forwardBlock(source, frame, beforeSourceContent)
      else {
        if (frame.type === 'error' || frame.event === 'error')
          source.invalidateCompletion()
        if (frame.type === 'message_stop') {
          complete(source, options.lifecycle?.onCompleted)
          source.clear()
        }
        emit([frame.bytes])
      }
    }
  }

  const onAbort = () => {
    abort.abort(signal?.reason)
    if (!started) void sourceBody.cancel().catch(() => {})
    finish(() => controller.error(abort.signal.reason))
  }
  function finish(end?: () => void) {
    if (finished) return
    finished = true
    signal?.removeEventListener('abort', onAbort)
    stopTimer?.()
    stopTimer = undefined
    const resolve = demand
    demand = undefined
    source.clear()
    prefill?.clear()
    reply?.clear()
    provenance?.finish()
    retryAttempt?.clear()
    end?.()
    resolve?.()
    resume?.()
    resume = undefined
  }

  const body = new ReadableStream<Uint8Array>(
    {
      start(output) {
        controller = output
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      },
      pull() {
        return new Promise<void>((resolve) => {
          demand = resolve
          if (!started) {
            started = true
            lastByte = clock.now()
            void run(sourceBody).then(
              () => finish(() => controller.close()),
              (error) => finish(() => controller.error(error)),
            )
          }
          resume?.()
          resume = undefined
          updateHeartbeat()
        })
      },
      cancel(reason) {
        abort.abort(reason)
        if (!started) void sourceBody.cancel().catch(() => {})
        finish()
      },
    },
    { highWaterMark: 0 },
  )
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return copyStreamResponseTiming(
    response,
    new Response(body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  )
}
