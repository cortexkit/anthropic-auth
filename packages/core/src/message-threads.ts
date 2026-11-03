import { createHash, type Hash } from 'node:crypto'
import { signRequestBody } from './cch.ts'
import { logger } from './logger.ts'
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
  replyFingerprint: string
}
export type MessageThreadDecision =
  | { type: 'create' }
  | { type: 'continue'; previousMessageId: string; deltaMessages: unknown[] }

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// Hosts may rename tools or trim text. Match replies by tool IDs, thinking
// signatures and the combined trimmed text digest; retain only hashes and IDs.
class ReplyFingerprint {
  private readonly open = new Map<
    number,
    { type: string; signature?: Hash; signatureLength: number }
  >()
  private readonly seen = new Set<number>()
  private readonly tools = new Map<number, string>()
  private readonly signatures = new Map<number, [string, string]>()
  private readonly text = createHash('sha256')
  private committedText = this.text.copy()
  private hasText = false
  private activeText: number | undefined
  private lastText = -1
  private invalid = false

  private appendText(value: string): void {
    const part = this.hasText ? value : value.trimStart()
    const visible = part.trimEnd()
    if (visible) {
      this.text.update(visible)
      this.committedText = this.text.copy()
      this.hasText = true
    }
    if (this.hasText) this.text.update(part.slice(visible.length))
  }

  start(index: unknown, block: unknown): void {
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      !isBody(block) ||
      typeof block.type !== 'string' ||
      this.seen.has(index)
    ) {
      this.invalid = true
      return
    }
    this.seen.add(index)
    const state: { type: string; signature?: Hash; signatureLength: number } = {
      type: block.type,
      signatureLength: 0,
    }
    if (block.type === 'text') {
      if (this.activeText !== undefined || index < this.lastText)
        this.invalid = true
      this.activeText = index
      this.lastText = index
      this.appendText(typeof block.text === 'string' ? block.text : '')
    }
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string') this.invalid = true
      else this.tools.set(index, block.id)
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      state.signature = createHash('sha256')
      const signature =
        block.type === 'redacted_thinking' ? block.data : block.signature
      if (typeof signature === 'string') {
        state.signature.update(signature)
        state.signatureLength += signature.length
      }
    }
    this.open.set(index, state)
  }

  delta(index: unknown, delta: unknown): void {
    const state = typeof index === 'number' ? this.open.get(index) : undefined
    if (!state || !isBody(delta)) {
      this.invalid = true
      return
    }
    if (delta.type === 'text_delta') {
      if (
        state.type !== 'text' ||
        this.activeText !== index ||
        typeof delta.text !== 'string'
      )
        this.invalid = true
      else this.appendText(delta.text)
    }
    if (delta.type === 'signature_delta') {
      if (!state.signature || typeof delta.signature !== 'string')
        this.invalid = true
      else {
        state.signature.update(delta.signature)
        state.signatureLength += delta.signature.length
      }
    }
  }

  stop(index: unknown): void {
    const state = typeof index === 'number' ? this.open.get(index) : undefined
    if (!state || typeof index !== 'number') {
      this.invalid = true
      return
    }
    this.open.delete(index)
    if (state.type === 'text') this.activeText = undefined
    if (state.signature) {
      if (!state.signatureLength) this.invalid = true
      this.signatures.set(index, [state.type, state.signature.digest('hex')])
    }
  }

  digest(): string | undefined {
    if (this.invalid || this.open.size) return undefined
    return hash({
      tools: [...this.tools].sort(([a], [b]) => a - b).map(([, id]) => id),
      signatures: [...this.signatures]
        .sort(([a], [b]) => a - b)
        .map(([, signature]) => signature),
      text: this.committedText.copy().digest('hex'),
    })
  }
}

function assistantReplyFingerprint(message: unknown): string | undefined {
  if (!isBody(message) || message.role !== 'assistant') return undefined
  const content =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
  if (!Array.isArray(content)) return undefined
  const reply = new ReplyFingerprint()
  for (const [index, block] of content.entries()) {
    reply.start(index, block)
    reply.stop(index)
  }
  return reply.digest()
}

// Cache placement is transport-local and may move as the history grows.
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  }
  return value
}

function isBody(value: unknown): value is Body {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function withoutOwnCache(value: unknown): unknown {
  if (!isBody(value)) return value
  const copy = { ...value }
  delete copy.cache_control
  return copy
}

function withoutContentCache(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    const copy = withoutOwnCache(block)
    if (isBody(copy) && copy.type === 'tool_result')
      copy.content = withoutContentCache(copy.content)
    return copy
  })
}

// OpenCode drops whitespace-only suffix blocks from its latest tool reply.
// Use that same form for every assistant history digest.
function withoutTrailingToolWhitespace(content: unknown[]): unknown[] {
  if (!content.some((block) => isBody(block) && block.type === 'tool_use'))
    return content
  let end = content.length
  while (end > 0) {
    const block = content[end - 1]
    if (
      !isBody(block) ||
      block.type !== 'text' ||
      typeof block.text !== 'string' ||
      block.text.trim()
    )
      break
    end--
  }
  return end === content.length ? content : content.slice(0, end)
}

function withoutMessageCache(message: unknown): unknown {
  if (!isBody(message)) return message
  let content = withoutContentCache(message.content)
  if (message.role === 'assistant' && Array.isArray(content))
    content = withoutTrailingToolWhitespace(content)
  // A user string and one text-only block represent the same message content.
  if (
    message.role === 'user' &&
    Array.isArray(content) &&
    content.length === 1
  ) {
    const block = content[0]
    if (
      isBody(block) &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      Object.keys(block).every((key) => key === 'type' || key === 'text')
    )
      content = block.text
  }
  return { ...message, content }
}

// Only protocol annotation holders count; tool arguments and schemas are data.
function contentCacheHolders(content: unknown): Body[] {
  if (!Array.isArray(content)) return []
  const holders: Body[] = []
  for (const block of content) {
    if (!isBody(block)) continue
    if (block.cache_control) holders.push(block)
    if (block.type === 'tool_result')
      holders.push(...contentCacheHolders(block.content))
  }
  return holders
}

function messageCacheHolders(messages: unknown): Body[] {
  if (!Array.isArray(messages)) return []
  return messages.flatMap((message) =>
    isBody(message) ? contentCacheHolders(message.content) : [],
  )
}

function fixedCacheHolders(body: Body): Body[] {
  return [body.system, body.tools].flatMap((items) =>
    Array.isArray(items)
      ? items.filter(
          (item): item is Body => isBody(item) && Boolean(item.cache_control),
        )
      : [],
  )
}

function fixedThreadFingerprint(input: MessageThreadInput): string {
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
    ].map((key) => [key, body[key]]),
  )
  return hash(
    canonicalValue({
      ...fixed,
      // Preserve fixed-field wire order and cache annotations in the digest.
      tools: JSON.stringify(body.tools),
      system: JSON.stringify(system),
      cache_control: JSON.stringify(body.cache_control),
      fallbacks: JSON.stringify(body.fallbacks),
      betas: input.betas,
    }),
  )
}

export function messageThreadSnapshot(
  input: MessageThreadInput,
  identity = hash([input.account, input.credential]),
  fingerprint = fixedThreadFingerprint(input),
): MessageThreadSnapshot {
  const messages = (
    Array.isArray(input.body.messages) ? input.body.messages : []
  ).map((message) => hash(canonicalValue(withoutMessageCache(message))))
  return { identity, fingerprint, messages, prefix: hash(messages) }
}

function canContinueFrom(
  anchor: MessageThreadAnchor | undefined,
  input: MessageThreadInput,
  identity: string | undefined,
  now: number,
): anchor is MessageThreadAnchor {
  if (
    !anchor ||
    !identity ||
    anchor.identity !== identity ||
    now < anchor.completedAt ||
    now - anchor.completedAt >= MAX_AGE_MS
  )
    return false
  const messages = Array.isArray(input.body.messages) ? input.body.messages : []
  return (
    messages.length >= anchor.messages.length + 2 &&
    messages[anchor.messages.length]?.role === 'assistant' &&
    !messages
      .slice(anchor.messages.length + 1)
      .some((message) => message?.role === 'assistant') &&
    assistantReplyFingerprint(messages[anchor.messages.length]) ===
      anchor.replyFingerprint
  )
}

/** Decide from immutable request facts; no session state or clock is read here. */
export function decideMessageThread(
  anchor: MessageThreadAnchor | undefined,
  input: MessageThreadInput,
  snapshot: MessageThreadSnapshot,
  now: number,
): MessageThreadDecision {
  if (
    !canContinueFrom(anchor, input, snapshot.identity, now) ||
    anchor.fingerprint !== snapshot.fingerprint ||
    hash(snapshot.messages.slice(0, anchor.messages.length)) !== anchor.prefix
  )
    return { type: 'create' }
  const messages = Array.isArray(input.body.messages) ? input.body.messages : []
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
  replyFingerprint?: string
  reply?: unknown
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

  // Late stream-failure callbacks must not retain the full request body.
  private failureFor(session: string, token: object): () => void {
    return () => {
      if (this.sessions.get(session)?.token === token) this.forget(session)
    }
  }

  prepare(input: MessageThreadInput): {
    decision: MessageThreadDecision
    body: Body
    complete: (facts: MessageThreadCompletion) => void
    fail: () => void
  } {
    const previous = this.sessions.get(input.session)
    const anchor = previous?.anchor
    const now = this.now()
    // Check session metadata and history shape before hashing request content.
    const identity =
      anchor &&
      now >= anchor.completedAt &&
      now - anchor.completedAt < MAX_AGE_MS
        ? hash([input.account, input.credential])
        : undefined
    let snapshot: MessageThreadSnapshot | undefined
    if (canContinueFrom(anchor, input, identity, now)) {
      const fingerprint = fixedThreadFingerprint(input)
      if (fingerprint === anchor.fingerprint)
        snapshot = messageThreadSnapshot(input, identity, fingerprint)
    }
    const decision: MessageThreadDecision = snapshot
      ? decideMessageThread(anchor, input, snapshot, now)
      : { type: 'create' }
    const token = {}
    this.forget(input.session)
    this.sessions.set(input.session, { token })
    this.prune()
    const fail = this.failureFor(input.session, token)
    let body: Body | undefined
    const outgoingBody = (): Body => {
      if (body) return body
      const full = input.body
      body = {
        ...full,
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
        placeContinueCache(body, full)
        Object.assign(body, {
          diagnostics: {
            ...(isBody(body.diagnostics) ? body.diagnostics : {}),
            previous_message_id: decision.previousMessageId,
          },
        })
      }
      return body
    }
    return {
      decision,
      get body() {
        return outgoingBody()
      },
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
          (Array.isArray(input.body.messages) &&
            input.body.messages.length > this.hashBudget)
        ) {
          fail()
          return
        }
        const replyFingerprint =
          facts.replyFingerprint ?? assistantReplyFingerprint(facts.reply)
        if (!replyFingerprint) {
          fail()
          return
        }
        const completedAt = this.now()
        // Compute a create request's history fingerprint after response completion.
        const completedSnapshot =
          snapshot ?? messageThreadSnapshot(input, identity)
        this.messageHashes += completedSnapshot.messages.length
        this.sessions.set(input.session, {
          token,
          anchor: {
            ...completedSnapshot,
            messageId: facts.messageId,
            completedAt,
            replyFingerprint,
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
  prepared: Pick<
    ReturnType<MessageThreadTracker['prepare']>,
    'complete' | 'fail'
  >,
): Response {
  if (!response.ok || !response.body) {
    prepared.fail()
    return response
  }
  const reader = response.body.getReader()
  const framer = createSseFramer()
  const facts: MessageThreadCompletion = { stopped: false }
  const reply = new ReplyFingerprint()
  let inspecting = true
  let streamStart = true
  const parse = (frame: Uint8Array) => {
    const data = parseSseFrame(decodeSseFrame(frame, { streamStart })).data
    streamStart = false
    if (!data || data === '[DONE]') return
    try {
      const event = JSON.parse(data)
      if (event.type === 'message_start') {
        if (typeof event.message?.id === 'string')
          facts.messageId = event.message.id
        if (Array.isArray(event.message?.content)) {
          for (const [index, block] of event.message.content.entries()) {
            reply.start(index, block)
            reply.stop(index)
          }
        }
      }
      if (event.type === 'content_block_start')
        reply.start(event.index, event.content_block)
      if (event.type === 'content_block_delta')
        reply.delta(event.index, event.delta)
      if (event.type === 'content_block_stop') reply.stop(event.index)
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
              if (inspecting) {
                facts.replyFingerprint = reply.digest()
                prepared.complete(facts)
              }
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
  // Fixed fields and the top-level automatic control keep their wire shape.
  const fixed = fixedCacheHolders(body)
  let remaining = Math.max(0, 4 - fixed.length - (body.cache_control ? 1 : 0))
  const messages = structuredClone(body.messages) as Array<Body>
  body.messages = messages
  const last = messages.findLast((message) => message.role !== 'system')
  const selected = new Set(contentCacheHolders(last?.content))
  const fullMessages = Array.isArray(full.messages)
    ? full.messages.filter(
        (message) => isBody(message) && message.role !== 'system',
      )
    : []
  const template =
    contentCacheHolders(last?.content).at(-1)?.cache_control ??
    messageCacheHolders(fullMessages).at(-1)?.cache_control
  if (last && remaining > 0 && template && typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content }]
  }
  const lastBlock = Array.isArray(last?.content)
    ? last.content.at(-1)
    : undefined
  const cacheableLastBlock = isBody(lastBlock) ? lastBlock : undefined
  const lastControl = cacheableLastBlock?.cache_control ?? template
  let reserved: Body | undefined
  // System turn controls are never cache targets; automatic caching stays top-level.
  if (cacheableLastBlock && lastControl && remaining > 0) {
    cacheableLastBlock.cache_control = lastControl
    reserved = cacheableLastBlock
    remaining--
  }
  for (const holder of messageCacheHolders(messages)) {
    if (holder === reserved) continue
    if (selected.has(holder) && remaining > 0) remaining--
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

async function readThreadError(response: Response): Promise<Body | undefined> {
  if (response.status !== 400 && response.status !== 404) return undefined
  const reader = response.clone().body?.getReader()
  if (!reader) return undefined
  let text = ''
  let remaining = 16_384
  const decoder = new TextDecoder()
  try {
    while (remaining > 0) {
      const chunk = await reader.read()
      if (chunk.done) break
      remaining -= chunk.value.byteLength
      if (remaining < 0) return undefined
      text += decoder.decode(chunk.value, { stream: true })
    }
    const body = JSON.parse(text)
    return isBody(body?.error) ? body.error : undefined
  } catch {
    return undefined
  } finally {
    void reader.cancel().catch(() => {})
  }
}

/** The HTTP protocol uses error.details.error_code, not the SDK's error.code. */
export async function isMessageThreadRejection(
  response: Response,
): Promise<boolean> {
  const error = await readThreadError(response)
  const code = isBody(error?.details) ? error.details.error_code : undefined
  return response.status === 404
    ? error?.type === 'not_found_error' && code === 'thread_not_found'
    : response.status === 400 &&
        error?.type === 'invalid_request_error' &&
        [
          'thread_fingerprint_mismatch',
          'thread_already_continued',
          'thread_continue_in_flight',
          'thread_unsupported_request',
        ].includes(code as string)
}

async function isThreadCreateRejection(response: Response): Promise<boolean> {
  if (response.status !== 400) return false
  const error = await readThreadError(response)
  const code = isBody(error?.details) ? error.details.error_code : undefined
  if (typeof code === 'string' && code.startsWith('thread_')) return true
  const message = typeof error?.message === 'string' ? error.message : ''
  return (
    message.includes(MESSAGE_THREADS_BETA) ||
    /(?:^|\W)thread\s*[:.]|["'`]thread["'`]|(?:field|parameter|property|argument|input)s?\s*[:=]?\s+thread\b|^\s*thread\s+(?:is|was)\b/i.test(
      message,
    )
  )
}

const disabledThreadAccounts = new Set<string>()

function removeThreadBeta(headers: Headers): void {
  const kept = (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta && beta !== MESSAGE_THREADS_BETA)
  if (kept.length) headers.set('anthropic-beta', kept.join(','))
  else headers.delete('anthropic-beta')
}

function disableThreadsForAccount(key: string): void {
  if (disabledThreadAccounts.has(key)) return
  disabledThreadAccounts.add(key)
  logger.warn(
    'message-threads',
    'Anthropic rejected message threads; using full stateless requests for this account until restart',
    { account: hash(key).slice(0, 12) },
  )
}

function ignoreThreadFailure(): void {}

// Recovery can replace the failure callback without retaining the prepared body.
function threadFailureState(initial: () => void) {
  const state = { current: initial }
  return {
    replace: (fail: () => void) => {
      state.current = fail
    },
    fail: () => state.current(),
  }
}

// Append to the existing template; only replacing a root field needs re-serialization.
function serializedCreate(text: string, full: () => Body): string {
  if (/"thread"\s*:/.test(text) && Object.hasOwn(full(), 'thread'))
    return JSON.stringify({ ...full(), thread: { type: 'create' } })
  const compactEnd = text.trimEnd()
  if (
    (!compactEnd.startsWith('{') && !compactEnd.trimStart().startsWith('{')) ||
    !compactEnd.endsWith('}')
  )
    throw new SyntaxError('Message request must be a JSON object')
  const prefix = compactEnd.slice(0, -1)
  return `${prefix}${prefix.trimEnd().endsWith('{') ? '' : ','}"thread":{"type":"create"}}${text.slice(compactEnd.length)}`
}

function serializedStateless(text: string, full: () => Body): string {
  if (!/"thread"\s*:/.test(text) || !Object.hasOwn(full(), 'thread'))
    return text
  const body = { ...full() }
  delete body.thread
  return JSON.stringify(body)
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
  const fullText = input.bodyText
  let full: Body | undefined
  const fullBody = () => (full ??= JSON.parse(fullText) as Body)
  const accountKey = input.account
  let threading = !disabledThreadAccounts.has(accountKey)
  const betas = threading ? messageThreadBetas(input.headers) : []
  const prepareForSession = (credential: string) =>
    tracker.prepare({
      account: input.account,
      credential,
      session: input.session ?? '',
      betas,
      get body() {
        return fullBody()
      },
    })
  if (!threading) {
    removeThreadBeta(input.headers)
    if (input.session) tracker.forget(input.session)
  }
  // Without a host session, create a thread but retain no continuation state.
  let prepared: ReturnType<MessageThreadTracker['prepare']> =
    threading && input.session
      ? prepareForSession(input.credential)
      : {
          decision: { type: 'create' },
          get body() {
            return threading
              ? { ...fullBody(), thread: { type: 'create' } }
              : fullBody()
          },
          complete: () => {},
          fail: ignoreThreadFailure,
        }
  const failure = threadFailureState(prepared.fail)
  const outgoing = threading
    ? prepared.decision.type === 'continue'
      ? JSON.stringify(prepared.body)
      : serializedCreate(fullText, fullBody)
    : serializedStateless(fullText, fullBody)
  let bodyText = await signRequestBody(outgoing)
  let recovered = false
  let credential = input.credential
  const mayResend = async (
    rejected: Response,
    authorize?: (
      rejected: Response,
    ) =>
      | Promise<boolean | { credential: string }>
      | boolean
      | { credential: string },
  ) => {
    const result = await authorize?.(rejected)
    if (result === false) return false
    if (result && typeof result === 'object') credential = result.credential
    return true
  }
  const latchStateless = () => {
    disableThreadsForAccount(accountKey)
    threading = false
    removeThreadBeta(input.headers)
  }
  const prepareStateless = async () => {
    prepared.fail()
    latchStateless()
    bodyText = await signRequestBody(serializedStateless(fullText, fullBody))
  }
  return {
    get bodyText() {
      return bodyText
    },
    fail: failure.fail,
    observe: (response: Response) => {
      if (
        !threading ||
        !input.session ||
        disabledThreadAccounts.has(accountKey)
      ) {
        prepared.fail()
        return response
      }
      return observeMessageThreadResponse(response, {
        fail: failure.fail,
        complete: (facts) => {
          if (input.signal?.aborted) prepared.fail()
          else prepared.complete(facts)
        },
      })
    },
    async recover(
      response: Response,
      send: (body: string) => Promise<Response>,
      beforeResend?: (
        rejected: Response,
      ) =>
        | Promise<boolean | { credential: string }>
        | boolean
        | { credential: string },
    ): Promise<Response> {
      // At most one create and one stateless resend for thread errors.
      // A separate gzip rejection may replay a request uncompressed once,
      // then turns gzip off until process restart.
      if (!threading || recovered) return response
      const rejectedCreate =
        prepared.decision.type === 'create' &&
        (await isThreadCreateRejection(response))
      const rejectedContinue =
        prepared.decision.type === 'continue' &&
        (await isMessageThreadRejection(response))
      if (!rejectedCreate && !rejectedContinue) return response
      recovered = true
      if (!(await mayResend(response, beforeResend))) {
        prepared.fail()
        if (rejectedCreate) latchStateless()
        return response
      }
      prepared.fail()
      void response.body?.cancel().catch(() => {})
      if (rejectedCreate || disabledThreadAccounts.has(accountKey)) {
        await prepareStateless()
        return send(bodyText)
      }
      if (input.session) {
        tracker.forget(input.session)
        prepared = prepareForSession(credential)
        failure.replace(prepared.fail)
      }
      bodyText = await signRequestBody(serializedCreate(fullText, fullBody))
      const created = await send(bodyText)
      // Only a rejected recovery create may add the final stateless attempt.
      if (await isThreadCreateRejection(created)) {
        if (!(await mayResend(created, beforeResend))) {
          prepared.fail()
          latchStateless()
          return created
        }
        void created.body?.cancel().catch(() => {})
        await prepareStateless()
        return send(bodyText)
      }
      return created
    },
  }
}
export type MessageThreadRequest = Awaited<
  ReturnType<typeof prepareMessageThreadRequest>
>
