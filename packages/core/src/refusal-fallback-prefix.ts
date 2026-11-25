import { createHash } from 'node:crypto'
import { TURN_END_NOTE_CONTENT } from './turn-end-note.ts'

type Body = Record<string, unknown>

export function refusalBodyRecord(value: unknown): Body | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Body)
    : undefined
}

function withoutCacheControl(value: unknown): unknown {
  const record = refusalBodyRecord(value)
  if (!record) return value
  const { cache_control: _cache, ...rest } = record
  return rest
}

function isOwnNote(message: Body): boolean {
  if (message.role !== 'system') return false
  const config = refusalBodyRecord(message.output_config)
  return (
    (Object.keys(message).length === 3 &&
      Array.isArray(message.content) &&
      message.content.length === 0 &&
      config !== undefined &&
      Object.keys(config).length === 1 &&
      typeof config.effort === 'string') ||
    (Object.keys(message).length === 3 &&
      message.clear_at === 'next_user_message' &&
      message.content === TURN_END_NOTE_CONTENT)
  )
}

function plainText(block: unknown): block is { type: 'text'; text: string } {
  const record = refusalBodyRecord(block)
  return (
    record?.type === 'text' &&
    typeof record.text === 'string' &&
    Object.keys(record).length === 2
  )
}

function normalizeMessage(value: unknown): unknown {
  const message = refusalBodyRecord(withoutCacheControl(value))
  if (!message) return value
  if (isOwnNote(message)) return undefined
  const blocks =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
  if (!Array.isArray(blocks)) return message
  const content: unknown[] = []
  for (const raw of blocks) {
    const block = withoutCacheControl(raw)
    const record = refusalBodyRecord(block)
    if (
      (record?.type === 'thinking' && !record.signature) ||
      (record?.type === 'redacted_thinking' && !record.data) ||
      (plainText(block) && block.text.trim() === '')
    )
      continue
    const previous = content.at(-1)
    if (plainText(block) && plainText(previous)) {
      content[content.length - 1] = {
        type: 'text',
        text: previous.text + block.text,
      }
    } else if (
      record?.type === 'tool_result' &&
      Array.isArray(record.content)
    ) {
      content.push({
        ...record,
        content: record.content.map(withoutCacheControl),
      })
    } else content.push(block)
  }
  if (message.role === 'assistant' && content.length === 0) return undefined
  return { ...message, content }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    const record = refusalBodyRecord(entry)
    return record
      ? Object.fromEntries(
          Object.keys(record)
            .sort()
            .map((key) => [key, record[key]]),
        )
      : entry
  })
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function comparisonBody(body: Body) {
  const system = Array.isArray(body.system)
    ? body.system
        .filter((block: unknown) => {
          const record = refusalBodyRecord(block)
          return !(
            record?.type === 'text' &&
            typeof record.text === 'string' &&
            record.text.startsWith('x-anthropic-billing-header:')
          )
        })
        .map(withoutCacheControl)
    : body.system
  const tools = Array.isArray(body.tools)
    ? body.tools.map(withoutCacheControl)
    : body.tools
  const messages = Array.isArray(body.messages)
    ? body.messages
        .map(normalizeMessage)
        .filter((message) => message !== undefined)
        .map(canonical)
    : []
  return { fixed: digest(canonical({ system, tools })), messages }
}

export type RefusalFallbackEstimateBase = Readonly<{
  fixed: string
  messages: readonly string[]
  inputTokens: number
}>

// Retain only digests and measured usage after the response finishes.
export function refusalFallbackEstimateBase(
  body: Body,
  inputTokens: number,
): RefusalFallbackEstimateBase {
  const { fixed, messages } = comparisonBody(body)
  return { fixed, messages: messages.map(digest), inputTokens }
}

export function estimateRefusalFallbackInput(
  body: Body,
  bodyText: string,
  base: RefusalFallbackEstimateBase | undefined,
): number {
  if (base) {
    const { fixed, messages } = comparisonBody(body)
    if (
      fixed === base.fixed &&
      messages.length >= base.messages.length &&
      base.messages.every((hash, index) => {
        const message = messages[index]
        return message !== undefined && hash === digest(message)
      })
    ) {
      const suffix = messages.slice(base.messages.length)
      return base.inputTokens + Buffer.byteLength(`[${suffix.join(',')}]`) / 4
    }
  }
  return Buffer.byteLength(bodyText) / 4
}
