import type { Host } from './refusal-hosts'

type Part = {
  type: string
  text?: string
  thinking?: string
  thinkingSignature?: string
  metadata?: { anthropic?: { signature?: string } }
  native?: { signature?: string }
  callID?: string
  id?: string
  toolCallId?: string
  tool?: { id?: string }
}

type Tokens = {
  input: number
  output: number
  cache: { read: number; write: number }
}
type PiUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
type OcMessage = {
  parts?: Part[]
  info: { role?: string; tokens: Tokens; finish?: string }
}
type Oc2Row = { type: string; data: string }
type Oc2Message = {
  content: Part[]
  tokens: Tokens
  finish?: string
  rawFinish?: string
}
type PiEntry = {
  type: string
  message?: {
    role: string
    content: Part[]
    usage: PiUsage
    stopReason: string
  }
}
type ProjectedPart = {
  type: string
  text?: string
  signature?: string
  id?: string
  error?: boolean
}

function hostParts(parts: Part[]) {
  return parts.flatMap<ProjectedPart>((part) => {
    switch (part.type) {
      case 'text':
        return [{ type: 'text', text: part.text }]
      case 'thinking':
      case 'reasoning':
        return [
          {
            type: 'thinking',
            text: part.text ?? part.thinking,
            signature:
              part.metadata?.anthropic?.signature ??
              part.native?.signature ??
              part.thinkingSignature ??
              '',
          },
        ]
      case 'tool':
      case 'toolCall':
      case 'tool-call':
      case 'tool_use':
        return [
          {
            type: 'tool_use',
            id: part.callID ?? part.toolCallId ?? part.tool?.id ?? part.id,
          },
        ]
      case 'step-start':
      case 'step-finish':
        return []
      default:
        return [{ type: part.type }]
    }
  })
}

function tokens(usage: Tokens | undefined) {
  if (!usage) return undefined
  return [usage.input, usage.output, usage.cache?.read, usage.cache?.write]
}

/** Read the versioned host records, without deriving usage from the mock. */
export function assistantSteps(host: Host, stored: unknown[]) {
  switch (host) {
    case 'oc1':
      return (stored as OcMessage[]).flatMap(({ info, parts }) =>
        info.role === 'assistant'
          ? [
              {
                parts: hostParts(parts ?? []),
                usage: tokens(info.tokens),
                finish: info.finish,
              },
            ]
          : [],
      )
    case 'oc2':
      return (stored as Oc2Row[]).flatMap(({ type, data }) => {
        if (type !== 'assistant') return []
        const message: Oc2Message = JSON.parse(data)
        return [
          {
            parts: hostParts(message.content),
            usage: tokens(message.tokens),
            finish: message.rawFinish ?? message.finish,
          },
        ]
      })
    case 'pi':
      return (stored as PiEntry[]).flatMap(({ type, message }) => {
        if (type !== 'message' || message?.role !== 'assistant') return []
        const { input, output, cacheRead, cacheWrite } = message.usage
        return [
          {
            parts: hostParts(message.content),
            usage: [input, output, cacheRead, cacheWrite],
            finish: message.stopReason,
          },
        ]
      })
  }
}

export type WirePart = {
  type: string
  text?: string
  thinking?: string
  signature?: string
  id?: string
  tool_use_id?: string
  is_error?: boolean
}
type WireMessage = { role: string; content: string | WirePart[] }

export function partsOnWire(body: Record<string, unknown>) {
  const messages = body.messages as WireMessage[]
  return messages.flatMap(({ role, content }) =>
    (typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : content
    ).map((part) => ({ role, part })),
  )
}

export function wireHistory(body: Record<string, unknown>) {
  return partsOnWire(body).flatMap<ProjectedPart>(({ role, part }) => {
    switch (part.type) {
      case 'thinking':
        return [
          { type: 'thinking', text: part.thinking, signature: part.signature },
        ]
      case 'text':
        return role === 'assistant' ? [{ type: 'text', text: part.text }] : []
      case 'tool_use':
        return [{ type: 'tool_use', id: part.id }]
      case 'tool_result':
        return [
          {
            type: 'tool_result',
            id: part.tool_use_id,
            error: part.is_error ?? false,
          },
        ]
      default:
        return []
    }
  })
}
