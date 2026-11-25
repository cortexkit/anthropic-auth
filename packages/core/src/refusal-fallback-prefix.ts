import { createHash } from 'node:crypto'
import { isServerFallbackUsageMarker } from './server-fallback-usage.ts'
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

function normalizeMessage(value: unknown, mergeText = true): unknown {
  const message = refusalBodyRecord(withoutCacheControl(value))
  if (!message) return value
  if (isOwnNote(message)) return undefined
  const blocks =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content
  if (!Array.isArray(blocks)) return message
  const filtered: unknown[] = []
  for (const raw of blocks) {
    const block = withoutCacheControl(raw)
    const record = refusalBodyRecord(block)
    if (
      isServerFallbackUsageMarker(block) ||
      (record?.type === 'thinking' &&
        (typeof record.signature !== 'string' || !record.signature)) ||
      (record?.type === 'redacted_thinking' &&
        (typeof record.data !== 'string' || !record.data)) ||
      (record?.type === 'text' &&
        typeof record.text === 'string' &&
        record.text.trim() === '')
    )
      continue
    if (record?.type === 'tool_result' && Array.isArray(record.content)) {
      filtered.push({
        ...record,
        content: record.content.map(withoutCacheControl),
      })
    } else if (
      record?.type === 'tool_use' &&
      typeof record.input === 'string'
    ) {
      try {
        filtered.push({ ...record, input: JSON.parse(record.input) })
      } catch {
        filtered.push(block)
      }
    } else filtered.push(block)
  }
  if (message.role === 'assistant' && filtered.length === 0) return undefined
  const content: unknown[] = []
  for (const block of filtered) {
    const previous = content.at(-1)
    if (mergeText && plainText(block) && plainText(previous)) {
      content[content.length - 1] = {
        type: 'text',
        text: previous.text + block.text,
      }
    } else content.push(block)
  }
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

function normalizedMessages(body: Body, mergeText: boolean) {
  return Array.isArray(body.messages)
    ? body.messages
        .map((message: unknown) => normalizeMessage(message, mergeText))
        .filter((message) => message !== undefined)
    : []
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
  const messages = normalizedMessages(body, true).map(canonical)
  return { fixed: digest(canonical({ system, tools })), messages }
}

export type RefusalFallbackPrefix = Readonly<{
  fixed: string
  messages: readonly string[]
  deferredUser?: Readonly<{ header: string; blocks: readonly string[] }>
}>

export type RefusalFallbackEstimateBase = RefusalFallbackPrefix &
  Readonly<{
    inputTokens: number
  }>

/** Keep comparison digests, not a second copy of the conversation. */
export function refusalFallbackPrefix(body: Body): RefusalFallbackPrefix {
  const { fixed, messages } = comparisonBody(body)
  return { fixed, messages: messages.map(digest) }
}

function finalUser(body: Body) {
  const last = refusalBodyRecord(normalizedMessages(body, false).at(-1))
  if (last?.role !== 'user' || !Array.isArray(last.content)) return
  const { content, ...header } = last
  return { content, header }
}

export function refusalFallbackDeferredPrefix(
  body: Body,
): RefusalFallbackPrefix {
  const base = refusalFallbackPrefix(body)
  const user = finalUser(body)
  return user?.content.length
    ? {
        ...base,
        deferredUser: {
          header: digest(canonical(user.header)),
          blocks: user.content.map((block) => digest(canonical(block))),
        },
      }
    : base
}

export function refusalFallbackCheckpoint(
  base: RefusalFallbackPrefix,
  reply: readonly Body[] | undefined,
): RefusalFallbackPrefix {
  const message =
    reply && normalizeMessage({ role: 'assistant', content: reply })
  return message === undefined
    ? base
    : {
        fixed: base.fixed,
        messages: [...base.messages, digest(canonical(message))],
      }
}

export function refusalFallbackEstimateBase(
  body: Body,
  inputTokens: number,
): RefusalFallbackEstimateBase {
  return { ...refusalFallbackPrefix(body), inputTokens }
}

function extendsPrefix(
  { fixed, messages }: ReturnType<typeof comparisonBody>,
  base: RefusalFallbackPrefix,
) {
  return (
    fixed === base.fixed &&
    messages.length >= base.messages.length &&
    base.messages.every((hash, index) => {
      const message = messages[index]
      return message !== undefined && hash === digest(message)
    })
  )
}

function appendedMessages(
  body: Body,
  comparison: ReturnType<typeof comparisonBody>,
  base: RefusalFallbackPrefix,
) {
  if (extendsPrefix(comparison, base))
    return comparison.messages.slice(base.messages.length)
  const { deferredUser } = base
  if (
    !deferredUser ||
    comparison.fixed !== base.fixed ||
    comparison.messages.length !== base.messages.length ||
    !base.messages.slice(0, -1).every((hash, index) => {
      const message = comparison.messages[index]
      return message !== undefined && hash === digest(message)
    })
  )
    return undefined

  // OpenCode 1 merges consecutive user messages when it drops a refused turn
  // (see effort-history.ts). The old blocks must still be the exact prefix.
  const user = finalUser(body)
  if (
    !user ||
    digest(canonical(user.header)) !== deferredUser.header ||
    user.content.length <= deferredUser.blocks.length ||
    !deferredUser.blocks.every(
      (hash, index) => hash === digest(canonical(user.content[index])),
    )
  )
    return undefined

  return [
    canonical({
      ...user.header,
      content: user.content.slice(deferredUser.blocks.length),
    }),
  ]
}

export function extendsRefusalFallbackPrefix(
  body: Body,
  base: RefusalFallbackPrefix,
): boolean {
  return appendedMessages(body, comparisonBody(body), base) !== undefined
}

export function estimateRefusalFallbackInput(
  body: Body,
  bodyText: string,
  base: RefusalFallbackEstimateBase | undefined,
): number {
  if (base) {
    const suffix = appendedMessages(body, comparisonBody(body), base)
    if (suffix !== undefined) {
      return base.inputTokens + Buffer.byteLength(`[${suffix.join(',')}]`) / 4
    }
  }
  return Buffer.byteLength(bodyText) / 4
}
