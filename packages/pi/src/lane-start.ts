import { randomUUID } from 'node:crypto'
import { LANE_START_TEXT } from '@cortexkit/anthropic-auth-core'
import type { Message } from '@earendil-works/pi-ai'

type LaneUserMessage = Extract<Message, { role: 'user' }> & {
  cortexkitLaneStart?: true
}

const marker = `${LANE_START_TEXT}\n[cortexkit lane start: `
const uuidLength = 36
const pendingMaxAgeMs = 24 * 60 * 60 * 1000
const sessions = new Map<
  string,
  { pending: Map<string, number>; ready?: number }
>()

export function queuePiLaneStart(sessionId: string): string {
  const state = sessions.get(sessionId) ?? {
    pending: new Map<string, number>(),
  }
  const nonce = randomUUID()
  const now = Date.now()
  state.pending.set(nonce, now)
  sessions.delete(sessionId)
  sessions.set(sessionId, state)
  // The host may still deliver a queued nonce; only age out abandoned ones.
  for (const [id, entry] of sessions) {
    for (const [pending, issuedAt] of entry.pending) {
      if (now - issuedAt >= pendingMaxAgeMs) entry.pending.delete(pending)
    }
    if (
      !entry.pending.size &&
      (entry.ready === undefined || sessions.size > 128)
    )
      sessions.delete(id)
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
