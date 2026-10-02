export const TRAILING_ASSISTANT_HISTORY_MESSAGE =
  'Cannot send this request: the history ends on an assistant turn. ' +
  'Send a new message to continue; assistant content will not be discarded ' +
  'to replay the previous question.'

/** Shape-only details keep conversation content out of errors and logs. */
export class TrailingAssistantHistoryError extends Error {
  readonly check = 'meaningful_trailing_assistant'

  constructor(
    readonly details: {
      messageCount: number
      trailingMessageIndex: number
      emptyMessagesAfter: number
      contentShape: 'string' | 'array' | 'missing' | 'other'
      contentBlockCount?: number
      contentBlockTypes?: string[]
    },
  ) {
    super(TRAILING_ASSISTANT_HISTORY_MESSAGE)
    this.name = 'TrailingAssistantHistoryError'
  }
}

const REPORTED_BLOCK_TYPES = new Set([
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'server_tool_use',
  'image',
  'document',
])
const EMPTY_TEXT_BLOCK_KEYS = new Set(['type', 'text', 'cache_control'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProvablyEmptyContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  return content.every(
    (block) =>
      isRecord(block) &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim() === '' &&
      Object.keys(block).every((key) => EMPTY_TEXT_BLOCK_KEYS.has(key)),
  )
}

function describeContent(content: unknown) {
  if (Array.isArray(content)) {
    return {
      contentShape: 'array' as const,
      contentBlockCount: content.length,
      // Do not copy arbitrary type strings from request bodies into diagnostics.
      contentBlockTypes: content.map((block) =>
        isRecord(block) &&
        typeof block.type === 'string' &&
        REPORTED_BLOCK_TYPES.has(block.type)
          ? block.type
          : 'other',
      ),
    }
  }
  if (typeof content === 'string') return { contentShape: 'string' as const }
  if (content === undefined) return { contentShape: 'missing' as const }
  return { contentShape: 'other' as const }
}

/**
 * Refuse meaningful or unknown assistant trailers without mutating history.
 * Converters can use this before lowering so dropped opaque or incomplete
 * blocks cannot hide a missing user boundary. Return the empty-trailer count.
 * Ordinary user-ended requests inspect only the final element.
 */
export function assertNoMeaningfulTrailingAssistant(
  messages: readonly unknown[],
): number {
  let end = messages.length
  while (end > 0) {
    const last = messages[end - 1]
    if (!isRecord(last) || last.role !== 'assistant') break
    if (!isProvablyEmptyContent(last.content)) {
      throw new TrailingAssistantHistoryError({
        messageCount: messages.length,
        trailingMessageIndex: end - 1,
        emptyMessagesAfter: messages.length - end,
        ...describeContent(last.content),
      })
    }
    end--
  }
  return messages.length - end
}

/**
 * Remove only provably empty trailers from an owned wire-message array. The
 * wire does not distinguish a completed answer from a partial prefill, so
 * deleting meaningful content could replay the previous question.
 */
export function stripEmptyTrailingAssistantMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0
  const removed = assertNoMeaningfulTrailingAssistant(messages)
  if (removed) messages.length -= removed
  return removed
}
