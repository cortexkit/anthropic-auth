import { randomUUID } from 'node:crypto'
import { LANE_START_TEXT } from '@cortexkit/anthropic-auth-core'
import type { Message } from '@earendil-works/pi-ai'

type LaneUserMessage = Extract<Message, { role: 'user' }> & {
  cortexkitLaneStart?: true
}

const marker = `${LANE_START_TEXT}\n[cortexkit lane start: `
const uuidLength = 36
const laneStartMaxAgeMs = 24 * 60 * 60 * 1000
const sessions = new Map<
  string,
  {
    pending: Map<string, number>
    ready?: { timestamp: number; deliveredAt: number }
  }
>()

export function queuePiLaneStart(sessionId: string): string {
  const state = sessions.get(sessionId) ?? {
    pending: new Map<string, number>(),
  }
  const nonce = randomUUID()
  const now = Date.now()
  state.pending.set(nonce, now)
  sessions.set(sessionId, state)
  // A host can still deliver a queued nonce or dispatch a delivered lane start.
  for (const [id, entry] of sessions) {
    for (const [pending, issuedAt] of entry.pending) {
      if (now - issuedAt >= laneStartMaxAgeMs) entry.pending.delete(pending)
    }
    if (entry.ready && now - entry.ready.deliveredAt >= laneStartMaxAgeMs)
      delete entry.ready
    if (!entry.pending.size && !entry.ready) sessions.delete(id)
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
  if (message.role !== 'user' || !sessionId) return
  const state = sessions.get(sessionId)
  if (!state?.pending.size) return
  const pending = state.pending
  const delivered = new Set<string>()
  const clean = (text: string) => {
    let from = 0
    let result = ''
    let start = text.indexOf(marker)
    while (start !== -1) {
      const nonceStart = start + marker.length
      const end = nonceStart + uuidLength
      if (text[end] === ']') {
        const nonce = text.slice(nonceStart, end)
        if (pending.has(nonce)) {
          delivered.add(nonce)
          result += text.slice(from, start) + LANE_START_TEXT
          from = end + 1
        }
      }
      start = text.indexOf(marker, nonceStart)
    }
    return result + text.slice(from)
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
  const { content } = message
  const text =
    typeof content === 'string'
      ? content
      : content.length === 1 && content[0]?.type === 'text'
        ? content[0].text
        : undefined
  // A message carrying anything besides the lane text is a normal user turn.
  if (text === LANE_START_TEXT) {
    ;(message as LaneUserMessage).cortexkitLaneStart = true
    state.ready = { timestamp: message.timestamp, deliveredAt: Date.now() }
  } else if (!pending.size && !state.ready) {
    sessions.delete(sessionId)
  }
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
  if (!sessionId) return false
  // Dispatch also sees the raw marker on hosts that did not deliver message_start.
  for (const message of messages) stripPiLaneStartNonce(message, sessionId)
  const state = sessions.get(sessionId)
  if (!state?.ready) return false
  const { timestamp, deliveredAt } = state.ready
  delete state.ready
  if (!state.pending.size) sessions.delete(sessionId)
  if (Date.now() - deliveredAt >= laneStartMaxAgeMs) return false
  const tail = messages.findLast((message) => message.role !== 'system')
  return !!tail && tail.timestamp === timestamp && isPiLaneStartMessage(tail)
}
