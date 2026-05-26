import type {
  Context,
  ImageContent,
  Message,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import {
  applyClaudeCodeMetadata,
  buildBillingHeaderValue,
  type Cache1hMode,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  type ClaudeCodeIdentity,
  isFastModeSupportedModel,
  orderClaudeCodeBody,
  signRequestBody,
} from '@marcusrbrown/anthropic-auth-core'

const CLAUDE_CODE_TOOLS = new Map(
  [
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Grep',
    'Glob',
    'AskUserQuestion',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
  ].map((name) => [name.toLowerCase(), name]),
)

export type AnthropicRequestBody = {
  model: string
  max_tokens: number
  stream: true
  system?: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  thinking?: { type: 'enabled'; budget_tokens: number }
  cache_control?: { type: 'ephemeral' }
  speed?: 'fast'
}

function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, '\uFFFD')
}

function sanitizeToolId(id: string): string {
  if (!id) return 'tool_call_unknown'
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!sanitized) return 'tool_call_unknown'
  return sanitized.slice(0, 256)
}

function toClaudeCodeToolName(name: string): string {
  return CLAUDE_CODE_TOOLS.get(name.toLowerCase()) ?? name
}

export function fromClaudeCodeToolName(name: string, tools?: Tool[]): string {
  const lower = name.toLowerCase()
  return tools?.find((tool) => tool.name.toLowerCase() === lower)?.name ?? name
}

function convertTextAndImages(
  content: Array<TextContent | ImageContent>,
): string | Array<Record<string, unknown>> {
  if (!content.some((item) => item.type === 'image')) {
    return content
      .filter((item): item is TextContent => item.type === 'text')
      .map((item) => sanitize(item.text))
      .join('\n')
  }

  const blocks = content
    .map((item) => {
      if (item.type === 'text') {
        return { type: 'text', text: sanitize(item.text) }
      }
      if (!item.data) return null
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: item.mimeType,
          data: item.data,
        },
      }
    })
    .filter((block): block is NonNullable<typeof block> => block !== null)

  if (!blocks.some((block) => block.type === 'text')) {
    blocks.unshift({ type: 'text', text: '(see attached image)' })
  }

  return blocks
}

function convertMessages(
  messages: Message[],
): AnthropicRequestBody['messages'] {
  const result: AnthropicRequestBody['messages'] = []

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (message.content.trim()) {
          result.push({ role: 'user', content: sanitize(message.content) })
        }
      } else {
        result.push({
          role: 'user',
          content: convertTextAndImages(
            message.content as Array<TextContent | ImageContent>,
          ),
        })
      }
      continue
    }

    if (message.role === 'assistant') {
      const blocks: Array<Record<string, unknown>> = []
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) {
          blocks.push({ type: 'text', text: sanitize(block.text) })
        } else if (block.type === 'thinking' && block.thinking.trim()) {
          const thinking = block as ThinkingContent
          if (thinking.thinkingSignature) {
            blocks.push({
              type: 'thinking',
              thinking: sanitize(thinking.thinking),
              signature: thinking.thinkingSignature,
            })
          } else {
            blocks.push({ type: 'text', text: sanitize(thinking.thinking) })
          }
        } else if (block.type === 'toolCall') {
          blocks.push({
            type: 'tool_use',
            id: sanitizeToolId(block.id),
            name: toClaudeCodeToolName(block.name),
            input: block.arguments,
          })
        }
      }
      if (blocks.length) result.push({ role: 'assistant', content: blocks })
      continue
    }

    if (message.role === 'toolResult') {
      const toolResult = message as ToolResultMessage
      const toolResults: Array<Record<string, unknown>> = []
      const firstContent = convertTextAndImages(toolResult.content)
      const firstContentArr = Array.isArray(firstContent)
        ? firstContent
        : [{ type: 'text', text: firstContent }]
      if (toolResult.isError && firstContentArr.length === 0) {
        firstContentArr.push({ type: 'text', text: 'Error' })
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: sanitizeToolId(toolResult.toolCallId),
        content: firstContentArr,
        is_error: toolResult.isError,
      })

      let nextIndex = index + 1
      while (
        nextIndex < messages.length &&
        messages[nextIndex]?.role === 'toolResult'
      ) {
        const next = messages[nextIndex] as ToolResultMessage
        const nextContent = convertTextAndImages(next.content)
        const nextContentArr = Array.isArray(nextContent)
          ? nextContent
          : [{ type: 'text', text: nextContent }]
        if (next.isError && nextContentArr.length === 0) {
          nextContentArr.push({ type: 'text', text: 'Error' })
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: sanitizeToolId(next.toolCallId),
          content: nextContentArr,
          is_error: next.isError,
        })
        nextIndex += 1
      }
      index = nextIndex - 1
      result.push({ role: 'user', content: toolResults })
    }
  }

  return result
}

function convertTools(
  tools: Tool[] | undefined,
): AnthropicRequestBody['tools'] {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    name: toClaudeCodeToolName(tool.name),
    description: tool.description,
    input_schema: {
      type: 'object',
      properties:
        (tool.parameters as { properties?: unknown }).properties ?? {},
      required: (tool.parameters as { required?: unknown }).required ?? [],
    },
  }))
}

function addEphemeralCacheControl(body: AnthropicRequestBody): void {
  const lastTool = body.tools?.at(-1)
  if (lastTool) lastTool.cache_control = { type: 'ephemeral' }

  const lastSystem = body.system?.at(-1)
  if (lastSystem) lastSystem.cache_control = { type: 'ephemeral' }

  for (let index = body.messages.length - 1; index >= 0; index--) {
    const message = body.messages[index]
    if (message?.role !== 'user') continue
    const content = message.content
    if (Array.isArray(content)) {
      const lastBlock = content.at(-1)
      if (lastBlock && typeof lastBlock === 'object') {
        lastBlock.cache_control = { type: 'ephemeral' }
      }
    }
    break
  }
}

function applyCacheMode(
  body: AnthropicRequestBody,
  enabled: boolean,
  mode: Cache1hMode,
): void {
  if (!enabled) return
  if (mode === 'automatic') {
    body.cache_control = { type: 'ephemeral' }
    return
  }

  const addTtl = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) addTtl(item)
      return
    }
    const record = value as Record<string, unknown>
    const cacheControl = record.cache_control
    if (cacheControl && typeof cacheControl === 'object') {
      ;(cacheControl as Record<string, unknown>).ttl = '1h'
    }
    for (const child of Object.values(record)) addTtl(child)
  }

  if (mode === 'hybrid') body.cache_control = { type: 'ephemeral' }
  addTtl(body)
}

export async function buildAnthropicRequest(
  modelId: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cache: { enabled: boolean; mode: Cache1hMode },
  fastModeEnabled = false,
  identity?: ClaudeCodeIdentity,
): Promise<{ body: AnthropicRequestBody; bodyText: string }> {
  const messages = convertMessages(context.messages)
  const system = [
    {
      type: 'text',
      text: buildBillingHeaderValue(
        messages,
        undefined,
        CLAUDE_CODE_ENTRYPOINT,
      ),
    },
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
  ]
  if (context.systemPrompt?.trim()) {
    system.push({ type: 'text', text: sanitize(context.systemPrompt) })
  }

  const body: AnthropicRequestBody = {
    model: modelId,
    max_tokens: options?.maxTokens ?? 16_384,
    stream: true,
    system,
    messages,
  }

  const tools = convertTools(context.tools)
  if (tools?.length) body.tools = tools

  if (fastModeEnabled && isFastModeSupportedModel(modelId)) {
    body.speed = 'fast'
  }

  if (options?.reasoning) {
    const budgets: Record<string, number> = {
      minimal: 1024,
      low: 4096,
      medium: 10_240,
      high: 20_480,
      xhigh: 32_000,
    }
    body.thinking = {
      type: 'enabled',
      budget_tokens:
        (
          options.thinkingBudgets as
            | Record<string, number | undefined>
            | undefined
        )?.[options.reasoning] ??
        budgets[options.reasoning] ??
        10_240,
    }
  }

  addEphemeralCacheControl(body)
  applyCacheMode(body, cache.enabled, cache.mode)
  if (identity) applyClaudeCodeMetadata(body, identity)

  const unsigned = JSON.stringify(orderClaudeCodeBody(body))
  const bodyText = await signRequestBody(unsigned)
  return { body, bodyText }
}
