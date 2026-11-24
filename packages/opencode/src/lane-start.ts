import { LANE_START_TEXT } from '@cortexkit/anthropic-auth-core'
import { resolvePromptContext } from './prompt-context'

export { LANE_START_TEXT }
export const LANE_START_REQUEST_HEADER = 'x-cortexkit-lane-start'

const MAX_PENDING_MESSAGE_IDS = 1_000

type PluginSessionClient = {
  promptAsync?: (request: unknown) => Promise<unknown> | unknown
}

function isLaneStartPart(part: unknown) {
  if (!part || typeof part !== 'object') return false
  const record = part as Record<string, unknown>
  return (
    record.type === 'text' &&
    record.text === LANE_START_TEXT &&
    record.synthetic === true
  )
}

export async function fireLaneStart(
  client: unknown,
  sessionId: string,
): Promise<void> {
  const session = (client as { session?: PluginSessionClient } | null)?.session
  if (typeof session?.promptAsync !== 'function') {
    throw new Error(
      'OpenCode plugin client does not support session.promptAsync',
    )
  }

  const promptContext = await resolvePromptContext(client, sessionId)
  const body: Record<string, unknown> = {
    noReply: false,
    parts: [{ type: 'text', text: LANE_START_TEXT, synthetic: true }],
  }
  if (promptContext?.agent) body.agent = promptContext.agent
  if (promptContext?.model) body.model = promptContext.model
  if (promptContext?.variant) body.variant = promptContext.variant

  await Promise.resolve(session.promptAsync({ path: { id: sessionId }, body }))
}

export class LaneStartTracker {
  #pending = new Map<string, string>()

  observeSyntheticMessage(input: {
    sessionId: string
    messageId: string
    parts: unknown[]
  }): boolean {
    if (!input.parts.some(isLaneStartPart)) return false
    const key = `${input.sessionId}\u0000${input.messageId}`
    if (
      !this.#pending.has(key) &&
      this.#pending.size >= MAX_PENDING_MESSAGE_IDS
    ) {
      const oldest = this.#pending.keys().next().value
      if (oldest !== undefined) this.#pending.delete(oldest)
    }
    this.#pending.set(key, input.sessionId)
    return true
  }

  markHeaders(input: {
    sessionId: string
    messageId: string
    headers: Record<string, string>
  }): boolean {
    const key = `${input.sessionId}\u0000${input.messageId}`
    if (!this.#pending.has(key)) return false
    this.#pending.delete(key)
    input.headers[LANE_START_REQUEST_HEADER] = '1'
    return true
  }

  clearSession(sessionId: string): void {
    for (const [key, pendingSessionId] of this.#pending) {
      if (pendingSessionId === sessionId) this.#pending.delete(key)
    }
  }
}
