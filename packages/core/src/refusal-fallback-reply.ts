import { refusalBodyRecord } from './refusal-fallback-prefix.ts'

type Block = Record<string, unknown>

/** Accumulate only forwarded assistant blocks, using Anthropic's tool IDs and names. */
export function captureRefusalFallbackReply(maxBytes: number) {
  const blocks = new Map<number, { block: Block; input?: string }>()
  let bytes = 0
  let overflow = false
  return {
    push(index: number, event: Block) {
      if (overflow) return
      const content = event.content_block ?? event.delta
      if (content !== undefined)
        bytes += Buffer.byteLength(JSON.stringify(content))
      if (bytes > maxBytes) {
        overflow = true
        blocks.clear()
        return
      }
      if (event.type === 'content_block_start') {
        const start = refusalBodyRecord(event.content_block)
        if (!start) return
        if (start.type === 'text') {
          blocks.set(index, { block: { type: 'text', text: start.text ?? '' } })
        } else if (start.type === 'thinking') {
          blocks.set(index, {
            block: {
              type: 'thinking',
              thinking: start.thinking ?? '',
              signature: start.signature ?? '',
            },
          })
        } else if (start.type === 'redacted_thinking') {
          blocks.set(index, {
            block: { type: 'redacted_thinking', data: start.data },
          })
        } else if (start.type === 'tool_use') {
          blocks.set(index, {
            block: {
              type: 'tool_use',
              id: start.id,
              name: start.name,
              input: start.input ?? {},
            },
          })
        }
        return
      }
      const entry = blocks.get(index)
      const delta = refusalBodyRecord(event.delta)
      if (!entry || !delta) return
      const { block } = entry
      if (
        block.type === 'text' &&
        delta.type === 'text_delta' &&
        typeof delta.text === 'string'
      )
        block.text = `${block.text}${delta.text}`
      if (block.type === 'thinking') {
        if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        )
          block.thinking = `${block.thinking}${delta.thinking}`
        if (
          delta.type === 'signature_delta' &&
          typeof delta.signature === 'string'
        )
          block.signature = `${block.signature}${delta.signature}`
      }
      if (
        block.type === 'tool_use' &&
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      )
        entry.input = (entry.input ?? '') + delta.partial_json
    },
    complete(): readonly Block[] | null {
      if (overflow) return null
      const reply: Block[] = []
      for (const { block, input } of blocks.values()) {
        if (input) {
          try {
            reply.push({ ...block, input: JSON.parse(input) })
          } catch {
            // There is no reliable tool input to compare against host history.
            return null
          }
        } else reply.push(block)
      }
      return reply
    },
    clear() {
      blocks.clear()
    },
  }
}
