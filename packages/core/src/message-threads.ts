import { createHash } from 'node:crypto'
import { signRequestBody } from './cch.ts'
import { createSseFramer, decodeSseFrame, parseSseFrame } from './sse.ts'

export const MESSAGE_THREADS_BETA = 'message-threads-2026-08-12'
const MAX_AGE_MS = 5 * 60_000
const MAX_SESSIONS = 2048
// Bound digest storage too: session count alone does not bound long histories.
const MAX_MESSAGE_HASHES = 131_072

type Body = Record<string, unknown>
export interface MessageThreadInput {
  body: Body
  betas: string[]
  account: string
  credential: string
  session: string
}
export interface MessageThreadSnapshot {
  identity: string
  fingerprint: string
  messages: string[]
  prefix: string
}
export interface MessageThreadAnchor extends MessageThreadSnapshot {
  messageId: string
  completedAt: number
}
export type MessageThreadDecision =
  | { type: 'create' }
  | { type: 'continue'; previousMessageId: string; deltaMessages: unknown[] }

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// Cache placement is transport-local and may move as the history grows.
function stripped(value: unknown, canonical = true): unknown {
  if (Array.isArray(value))
    return value.map((item) => stripped(item, canonical))
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(
      ([key]) => key !== 'cache_control',
    )
    if (canonical) entries.sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(
      entries.map(([key, item]) => [key, stripped(item, canonical)]),
    )
  }
  return value
}

export function messageThreadSnapshot(
  input: MessageThreadInput,
): MessageThreadSnapshot {
  const { body } = input
  const system = Array.isArray(body.system)
    ? body.system.filter(
        (block) =>
          !(
            typeof block?.text === 'string' &&
            block.text.startsWith('x-anthropic-billing-header:')
          ),
      )
    : body.system
  const fixed = Object.fromEntries(
    [
      'model',
      'thinking',
      'output_config',
      'tool_choice',
      'context_management',
      'tools',
    ].map((key) => [key, body[key]]),
  )
  const messages = (Array.isArray(body.messages) ? body.messages : []).map(
    (message) => hash(stripped(message)),
  )
  return {
    identity: hash([input.account, input.credential]),
    fingerprint: hash(
      stripped({
        ...fixed,
        system,
        fallbacks: Object.hasOwn(body, 'fallbacks'),
        betas: input.betas,
      }),
    ),
    messages,
    prefix: hash(messages),
  }
}

/** Decide from immutable request facts; no session state or clock is read here. */
export function decideMessageThread(
  anchor: MessageThreadAnchor | undefined,
  input: MessageThreadInput,
  snapshot: MessageThreadSnapshot,
  now: number,
): MessageThreadDecision {
  const messages = Array.isArray(input.body.messages) ? input.body.messages : []
  if (
    !anchor ||
    anchor.identity !== snapshot.identity ||
    anchor.fingerprint !== snapshot.fingerprint ||
    now < anchor.completedAt ||
    now - anchor.completedAt >= MAX_AGE_MS ||
    messages.length < anchor.messages.length + 2 ||
    messages[anchor.messages.length]?.role !== 'assistant' ||
    messages[anchor.messages.length + 1]?.role === 'assistant' ||
    hash(snapshot.messages.slice(0, anchor.messages.length)) !== anchor.prefix
  )
    return { type: 'create' }
  return {
    type: 'continue',
    previousMessageId: anchor.messageId,
    deltaMessages: messages.slice(anchor.messages.length + 1),
  }
}

export interface MessageThreadCompletion {
  messageId?: string
  stopReason?: string | null
  stopped: boolean
  refusal?: boolean
  fallback?: boolean
  rewritten?: boolean
}

export class MessageThreadTracker {
  private readonly sessions = new Map<
    string,
    { token: object; anchor?: MessageThreadAnchor }
  >()

  private messageHashes = 0

  constructor(
    private readonly capacity = MAX_SESSIONS,
    private readonly now = Date.now,
    private readonly hashBudget = MAX_MESSAGE_HASHES,
  ) {}

  forget(session: string): void {
    this.messageHashes -=
      this.sessions.get(session)?.anchor?.messages.length ?? 0
    this.sessions.delete(session)
  }

  private prune(): void {
    while (
      this.sessions.size > this.capacity ||
      this.messageHashes > this.hashBudget
    ) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.forget(oldest)
    }
  }

  prepare(input: MessageThreadInput): {
    decision: MessageThreadDecision
    body: Body
    complete: (facts: MessageThreadCompletion) => void
    fail: () => void
  } {
    const snapshot = messageThreadSnapshot(input)
    const previous = this.sessions.get(input.session)
    const decision = decideMessageThread(
      previous?.anchor,
      input,
      snapshot,
      this.now(),
    )
    const token = {}
    this.forget(input.session)
    this.sessions.set(input.session, { token })
    this.prune()
    const fail = () => {
      if (this.sessions.get(input.session)?.token === token)
        this.forget(input.session)
    }
    const body: Body = {
      ...input.body,
      thread:
        decision.type === 'create'
          ? { type: 'create' }
          : {
              type: 'continue',
              previous_message_id: decision.previousMessageId,
            },
    }
    if (decision.type === 'continue') {
      Object.assign(body, { messages: decision.deltaMessages })
      placeContinueCache(body, input.body)
      if (body.diagnostics && typeof body.diagnostics === 'object') {
        Object.assign(body, {
          diagnostics: {
            ...body.diagnostics,
            previous_message_id: decision.previousMessageId,
          },
        })
      }
    }
    return {
      decision,
      body,
      fail,
      complete: (facts) => {
        const current = this.sessions.get(input.session)
        if (current?.token !== token || current.anchor) return
        if (
          !facts.messageId ||
          !facts.stopped ||
          !facts.stopReason ||
          facts.stopReason === 'refusal' ||
          facts.refusal ||
          facts.fallback ||
          facts.rewritten ||
          snapshot.messages.length > this.hashBudget
        ) {
          fail()
          return
        }
        this.messageHashes += snapshot.messages.length
        this.sessions.set(input.session, {
          token,
          anchor: {
            ...snapshot,
            messageId: facts.messageId,
            completedAt: this.now(),
          },
        })
        this.prune()
      },
    }
  }
}

/** Observe without teeing or buffering the response; cancellation cannot publish an anchor. */
export function observeMessageThreadResponse(
  response: Response,
  prepared: ReturnType<MessageThreadTracker['prepare']>,
): Response {
  if (!response.ok || !response.body) {
    prepared.fail()
    return response
  }
  const reader = response.body.getReader()
  const framer = createSseFramer()
  const facts: MessageThreadCompletion = { stopped: false }
  let inspecting = true
  let streamStart = true
  const parse = (frame: Uint8Array) => {
    const data = parseSseFrame(decodeSseFrame(frame, { streamStart })).data
    streamStart = false
    if (!data || data === '[DONE]') return
    try {
      const event = JSON.parse(data)
      if (event.type === 'message_start') facts.messageId = event.message?.id
      const stop = event.delta?.stop_reason ?? event.message?.stop_reason
      if (typeof stop === 'string') facts.stopReason = stop
      if (stop === 'refusal' || event.content_block?.type === 'refusal')
        facts.refusal = true
      if (
        event.content_block?.type === 'fallback' ||
        [event.usage, event.message?.usage].some((usage) =>
          usage?.iterations?.some(
            (iteration: { type?: string }) =>
              iteration.type === 'fallback_message',
          ),
        )
      )
        facts.fallback = true
      if (event.type === 'message_stop') facts.stopped = true
      if (event.type === 'error') facts.rewritten = true
    } catch {
      facts.rewritten = true
    }
  }
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read()
            if (chunk.done) {
              // An unterminated EOF tail is not a completed SSE event.
              if (inspecting && framer.finish()) facts.rewritten = true
              if (inspecting) prepared.complete(facts)
              controller.close()
              return
            }
            if (inspecting) {
              try {
                for (const frame of framer.push(chunk.value)) parse(frame)
              } catch {
                inspecting = false
                prepared.fail()
              }
            }
            controller.enqueue(chunk.value)
          } catch (error) {
            prepared.fail()
            controller.error(error)
          }
        },
        cancel(reason) {
          prepared.fail()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}

function placeContinueCache(body: Body, full: Body): void {
  const holders = (value: unknown): Body[] => {
    const result: Body[] = []
    const visit = (item: unknown) => {
      if (!item || typeof item !== 'object') return
      if (Array.isArray(item)) {
        for (const child of item) visit(child)
        return
      }
      const record = item as Body
      if (record.cache_control) result.push(record)
      for (const [key, child] of Object.entries(record)) {
        if (key !== 'cache_control') visit(child)
      }
    }
    visit(value)
    return result
  }

  // Fixed fields keep their exact wire shape, including existing breakpoints.
  const fixed = [...holders(body.system), ...holders(body.tools)]
  let remaining = Math.max(0, 4 - fixed.length)
  const messages = structuredClone(body.messages) as Array<{
    content?: unknown
  }>
  body.messages = messages
  delete body.cache_control
  const template =
    full.cache_control ??
    [...holders(full.messages), ...fixed][0]?.cache_control
  const last = messages.at(-1)
  if (last && remaining > 0 && template && typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content }]
  }
  const lastBlock = Array.isArray(last?.content)
    ? last.content.at(-1)
    : undefined
  const cacheableLastBlock =
    lastBlock && typeof lastBlock === 'object' ? (lastBlock as Body) : undefined
  const lastControl =
    full.cache_control ?? cacheableLastBlock?.cache_control ?? template
  let reserved: Body | undefined
  // Automatic caching belongs on the last delta block, within the remaining budget.
  if (cacheableLastBlock && lastControl && remaining > 0) {
    cacheableLastBlock.cache_control = lastControl
    reserved = cacheableLastBlock
    remaining--
  }
  for (const holder of holders(messages)) {
    if (holder === reserved) continue
    if (remaining > 0) remaining--
    else delete holder.cache_control
  }
}

export function messageThreadBetas(headers: Headers): string[] {
  const betas = (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta && beta !== MESSAGE_THREADS_BETA)
  betas.push(MESSAGE_THREADS_BETA)
  headers.set('anthropic-beta', betas.join(','))
  return betas
}

/** The HTTP protocol uses error.details.error_code, not the SDK's error.code. */
export async function isMessageThreadRejection(
  response: Response,
): Promise<boolean> {
  if (response.status !== 400 && response.status !== 404) return false
  const reader = response.clone().body?.getReader()
  if (!reader) return false
  let text = ''
  let remaining = 16_384
  const decoder = new TextDecoder()
  try {
    while (remaining > 0) {
      const chunk = await reader.read()
      if (chunk.done) break
      remaining -= chunk.value.byteLength
      if (remaining < 0) return false
      text += decoder.decode(chunk.value, { stream: true })
    }
    const error = JSON.parse(text).error
    const code = error?.details?.error_code
    return response.status === 404
      ? error?.type === 'not_found_error' && code === 'thread_not_found'
      : error?.type === 'invalid_request_error' &&
          [
            'thread_fingerprint_mismatch',
            'thread_already_continued',
            'thread_continue_in_flight',
            'thread_unsupported_request',
          ].includes(code)
  } catch {
    return false
  } finally {
    void reader.cancel().catch(() => {})
  }
}

export async function prepareMessageThreadRequest(
  tracker: MessageThreadTracker,
  input: Omit<MessageThreadInput, 'body' | 'betas' | 'session'> & {
    session?: string
    bodyText: string
    headers: Headers
    signal?: AbortSignal
  },
) {
  const full = JSON.parse(input.bodyText) as Body
  const betas = messageThreadBetas(input.headers)
  // Without a host session, create a thread but retain no continuation state.
  const prepared: ReturnType<MessageThreadTracker['prepare']> = input.session
    ? tracker.prepare({ ...input, session: input.session, body: full, betas })
    : {
        decision: { type: 'create' },
        body: { ...full, thread: { type: 'create' } },
        complete: () => {},
        fail: () => {},
      }
  let bodyText = await signRequestBody(JSON.stringify(prepared.body))
  let recovered = false
  return {
    get bodyText() {
      return bodyText
    },
    fail: prepared.fail,
    observe: (response: Response) =>
      observeMessageThreadResponse(response, {
        ...prepared,
        complete: (facts) => {
          if (input.signal?.aborted) prepared.fail()
          else prepared.complete(facts)
        },
      }),
    async recover(
      response: Response,
      send: (body: string) => Promise<Response>,
    ): Promise<Response> {
      if (
        recovered ||
        prepared.decision.type !== 'continue' ||
        !(await isMessageThreadRejection(response))
      )
        return response
      recovered = true
      prepared.fail()
      void response.body?.cancel().catch(() => {})
      bodyText = await signRequestBody(
        JSON.stringify({ ...full, thread: { type: 'create' } }),
      )
      return send(bodyText)
    },
  }
}
export type MessageThreadRequest = Awaited<
  ReturnType<typeof prepareMessageThreadRequest>
>
