import { randomUUID } from 'node:crypto'
import { LANE_START_TEXT } from '@cortexkit/anthropic-auth-core'
import type { Message } from '@earendil-works/pi-ai'

type LaneUserMessage = Extract<Message, { role: 'user' }> & {
  cortexkitLaneStart?: true
}

const marker = `${LANE_START_TEXT}\n[cortexkit lane start: `
const sessions = new Map<string, { pending: Set<string>; ready?: number }>()

export function queuePiLaneStart(sessionId: string): string {
  const state = sessions.get(sessionId) ?? { pending: new Set<string>() }
  const nonce = randomUUID()
  state.pending.add(nonce)
  sessions.delete(sessionId)
  sessions.set(sessionId, state)
  if (sessions.size > 128) {
    const oldest = sessions.keys().next().value
    if (oldest !== undefined) sessions.delete(oldest)
  }
  return `${marker}${nonce}]`
}

export function forgetPiLaneStarts(sessionId: string): void {
  sessions.delete(sessionId)
}

/** Pi rebuilds queued user messages from text; remove the token before the delivered message is saved. */
export function stripPiLaneStartNonce(
  message: Message,
  sessionId?: string,
): void {
  if (message.role !== 'user') return
  const state = sessionId ? sessions.get(sessionId) : undefined
  if (!state?.pending.size) return
  const pending = state.pending
  const delivered = new Set<string>()
  const clean = (text: string) => {
    if (!text.startsWith(marker) || !text.endsWith(']')) return text
    const nonce = text.slice(marker.length, -1)
    if (!pending.has(nonce)) return text
    delivered.add(nonce)
    return LANE_START_TEXT
  }
  if (typeof message.content === 'string') {
    message.content = clean(message.content)
  } else {
    for (const block of message.content)
      if (block.type === 'text') block.text = clean(block.text)
  }
  if (!delivered.size) return
  // Consume after scanning so a repeated block in this delivery is also clean.
  for (const nonce of delivered) pending.delete(nonce)
  ;(message as LaneUserMessage).cortexkitLaneStart = true
  state.ready = message.timestamp
}

export function isPiLaneStartMessage(message: Message): boolean {
  return (
    message.role === 'user' &&
    (message as LaneUserMessage).cortexkitLaneStart === true
  )
}

export function takePiLaneStart(
  messages: Message[],
  sessionId?: string,
): boolean {
  // Dispatch also sees the raw marker on hosts that did not deliver message_start.
  for (const message of messages) stripPiLaneStartNonce(message, sessionId)
  const state = sessionId ? sessions.get(sessionId) : undefined
  if (!state || state.ready === undefined) return false
  const tail = messages.findLast((message) => message.role !== 'system')
  const ready = state.ready
  delete state.ready
  return !!tail && tail.timestamp === ready && isPiLaneStartMessage(tail)
}
