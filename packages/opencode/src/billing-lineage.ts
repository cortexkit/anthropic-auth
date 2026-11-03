import { randomUUID } from 'node:crypto'
import {
  isValidAnthropicRequestId,
  isValidBillingPromptId,
} from '@cortexkit/anthropic-auth-core'

export const BILLING_LINEAGE_REQUEST_HEADER = 'x-cortexkit-billing-lineage'

const MAX_TRACKED_PROMPTS = 4096
const MAX_TRACKED_REQUESTS = 4096
const MAX_TRACKED_SESSIONS = 1024
const BACKGROUND_AGENTS = new Set(['title', 'summary', 'compaction'])
const LANE_START_TEXT =
  '[lane start] — automated cache warm; no response needed.'
interface MessageLike {
  info?: {
    id?: unknown
    sessionID?: unknown
    sessionId?: unknown
    role?: unknown
    agent?: unknown
    synthetic?: unknown
    ignored?: unknown
  }
  parts?: Array<{
    type?: unknown
    text?: unknown
    synthetic?: unknown
    ignored?: unknown
    metadata?: Record<string, unknown>
  }>
}

export interface BillingLineageContext {
  sessionId: string
  messageId: string
  promptId: string
  previousRequestId?: string
  requestToken: string
  generation: number
  sequence: number
}

export interface BillingLineageTrackerOptions {
  createPromptId?: () => string
  createRequestToken?: () => string
  maxPrompts?: number
  maxRequests?: number
  maxSessions?: number
}

function messageSessionId(message: MessageLike): string | undefined {
  const candidate = message.info?.sessionID ?? message.info?.sessionId
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined
}

function isBackgroundMessage(message: MessageLike): boolean {
  if (
    message.info?.synthetic === true ||
    message.info?.ignored === true ||
    (typeof message.info?.agent === 'string' &&
      BACKGROUND_AGENTS.has(message.info.agent))
  ) {
    return true
  }
  for (const part of message.parts ?? []) {
    if (
      part.type === 'compaction' ||
      part.synthetic === true ||
      part.ignored === true
    )
      return true
    if (part.metadata?.compaction_continue === true) return true
    if (part.type === 'text' && part.text === LANE_START_TEXT) return true
  }
  return false
}

function trimOldest<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

export function extractAnthropicRequestId(
  headers: Headers,
): string | undefined {
  const requestId = headers.get('request-id') ?? headers.get('x-request-id')
  return requestId && isValidAnthropicRequestId(requestId)
    ? requestId
    : undefined
}

export class BillingLineageTracker {
  readonly #createPromptId: () => string
  readonly #createRequestToken: () => string
  readonly #maxPrompts: number
  readonly #maxRequests: number
  readonly #maxSessions: number
  readonly #prompts = new Map<string, string>()
  readonly #excludedMessages = new Map<string, true>()
  readonly #requests = new Map<string, BillingLineageContext>()
  readonly #previousRequestIds = new Map<string, string>()
  readonly #generations = new Map<string, number>()
  readonly #nextSequences = new Map<string, number>()
  readonly #committedSequences = new Map<string, number>()

  constructor(options: BillingLineageTrackerOptions = {}) {
    this.#createPromptId = options.createPromptId ?? randomUUID
    this.#createRequestToken = options.createRequestToken ?? randomUUID
    this.#maxPrompts = options.maxPrompts ?? MAX_TRACKED_PROMPTS
    this.#maxRequests = options.maxRequests ?? MAX_TRACKED_REQUESTS
    this.#maxSessions = options.maxSessions ?? MAX_TRACKED_SESSIONS
  }

  observeMessages(messages: MessageLike[]): void {
    let currentUser: MessageLike | undefined
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.info?.role === 'user') {
        currentUser = messages[index]
        break
      }
    }
    if (!currentUser) return

    const sessionId = messageSessionId(currentUser)
    const messageId = currentUser.info?.id
    if (!sessionId || typeof messageId !== 'string' || messageId.length === 0)
      return

    const key = this.#messageKey(sessionId, messageId)
    if (isBackgroundMessage(currentUser)) {
      this.#excludedMessages.delete(key)
      this.#excludedMessages.set(key, true)
      trimOldest(this.#excludedMessages, this.#maxPrompts)
      this.#prompts.delete(key)
      return
    }

    this.#excludedMessages.delete(key)
    const existing = this.#prompts.get(key)
    if (existing) {
      this.#prompts.delete(key)
      this.#prompts.set(key, existing)
      return
    }

    const promptId = this.#createPromptId()
    if (!isValidBillingPromptId(promptId)) return
    this.#prompts.set(key, promptId)
    trimOldest(this.#prompts, this.#maxPrompts)
  }

  markHeaders(input: {
    sessionId: string
    messageId: string
    agent?: string
    headers: Record<string, string>
  }): boolean {
    const key = this.#messageKey(input.sessionId, input.messageId)
    if (
      BACKGROUND_AGENTS.has(input.agent ?? '') ||
      this.#excludedMessages.has(key)
    )
      return false

    const promptId = this.#prompts.get(key)
    if (!promptId) return false

    const requestToken = this.#createRequestToken()
    if (!requestToken || /[\r\n]/.test(requestToken)) return false
    const context: BillingLineageContext = {
      sessionId: input.sessionId,
      messageId: input.messageId,
      promptId,
      requestToken,
      generation: this.#generations.get(input.sessionId) ?? 0,
      sequence: 0,
    }

    this.#requests.set(requestToken, context)
    trimOldest(this.#requests, this.#maxRequests)
    input.headers[BILLING_LINEAGE_REQUEST_HEADER] = requestToken
    return true
  }

  promptIdForHeader(value: string | null | undefined): string | undefined {
    return value ? this.#requests.get(value)?.promptId : undefined
  }

  resolveHeader(
    value: string | null | undefined,
  ): BillingLineageContext | undefined {
    if (!value) return undefined
    const context = this.#requests.get(value)
    if (!context) return undefined
    this.#requests.delete(value)
    this.#requests.set(value, context)
    const sequence = (this.#nextSequences.get(context.sessionId) ?? 0) + 1
    this.#nextSequences.delete(context.sessionId)
    this.#nextSequences.set(context.sessionId, sequence)
    trimOldest(this.#nextSequences, this.#maxSessions)
    const resolved: BillingLineageContext = {
      ...context,
      previousRequestId: this.#previousRequestIds.get(context.sessionId),
      sequence,
    }
    if (resolved.previousRequestId === undefined) {
      delete resolved.previousRequestId
    }
    return resolved
  }

  commit(
    context: BillingLineageContext | undefined,
    requestId: string | undefined,
  ): boolean {
    if (!context || !requestId || !isValidAnthropicRequestId(requestId))
      return false
    if ((this.#generations.get(context.sessionId) ?? 0) !== context.generation)
      return false
    const request = this.#requests.get(context.requestToken)
    if (
      !request ||
      request.sessionId !== context.sessionId ||
      request.messageId !== context.messageId ||
      request.promptId !== context.promptId ||
      request.generation !== context.generation
    ) {
      return false
    }
    if (
      this.#prompts.get(
        this.#messageKey(context.sessionId, context.messageId),
      ) !== context.promptId
    )
      return false
    if (
      context.sequence < (this.#committedSequences.get(context.sessionId) ?? 0)
    )
      return false

    this.#committedSequences.delete(context.sessionId)
    this.#committedSequences.set(context.sessionId, context.sequence)
    trimOldest(this.#committedSequences, this.#maxSessions)
    this.#previousRequestIds.delete(context.sessionId)
    this.#previousRequestIds.set(context.sessionId, requestId)
    trimOldest(this.#previousRequestIds, this.#maxSessions)
    return true
  }

  clearSession(sessionId: string): void {
    this.#generations.set(
      sessionId,
      (this.#generations.get(sessionId) ?? 0) + 1,
    )
    this.#previousRequestIds.delete(sessionId)
    this.#nextSequences.delete(sessionId)
    this.#committedSequences.delete(sessionId)
    const prefix = `${sessionId}\0`
    for (const key of this.#prompts.keys()) {
      if (key.startsWith(prefix)) this.#prompts.delete(key)
    }
    for (const key of this.#excludedMessages.keys()) {
      if (key.startsWith(prefix)) this.#excludedMessages.delete(key)
    }
    for (const [token, context] of this.#requests) {
      if (context.sessionId === sessionId) this.#requests.delete(token)
    }
    trimOldest(this.#generations, this.#maxSessions)
  }

  #messageKey(sessionId: string, messageId: string): string {
    return `${sessionId}\0${messageId}`
  }
}
