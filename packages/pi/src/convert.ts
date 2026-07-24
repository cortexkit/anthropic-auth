import {
  applyClaudeCodeMetadata,
  buildBillingHeaderValue,
  type Cache1hMode,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING,
  CLAUDE_OPUS_5_ADAPTIVE_THINKING,
  CLAUDE_SONNET_5_ADAPTIVE_THINKING,
  type ClaudeCodeIdentity,
  isClaudeFableOrMythos5Model,
  isClaudeOpus5Model,
  isClaudeSonnet5Model,
  isFastModeSupportedModel,
  isOpenAIReasoningSignature,
  orderClaudeCodeBody,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
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
  thinking?:
    | { type: 'enabled'; budget_tokens: number }
    | { type: 'adaptive'; display: 'summarized' }
  output_config?: { effort: string }
  cache_control?: { type: 'ephemeral' }
  speed?: 'fast'
}

function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, '\uFFFD')
}

/**
 * Detect lone (unpaired) UTF-16 surrogates. With the `u` flag the character
 * class only matches surrogates that are NOT part of a valid pair, since valid
 * pairs are folded into a single astral code point. Anthropic rejects payloads
 * containing lone surrogates (invalid UTF-8).
 */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDFFF]/u.test(text)
}

/**
 * Sanitize a tool-call ID to match Anthropic's `^[a-zA-Z0-9_-]+$` pattern.
 * Cross-provider IDs (e.g. OpenAI Codex `call_xxx|fc_xxx`) contain characters
 * Anthropic rejects. Deterministic — same input always yields the same output.
 */
function sanitizeToolId(id: string): string {
  if (!id) return 'tool_call_unknown'
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned.length > 256 ? cleaned.slice(0, 256) : cleaned
}

function toClaudeCodeToolName(name: string): string {
  return CLAUDE_CODE_TOOLS.get(name.toLowerCase()) ?? name
}

export function fromClaudeCodeToolName(name: string, tools?: Tool[]): string {
  const lower = name.toLowerCase()
  return tools?.find((tool) => tool.name.toLowerCase() === lower)?.name ?? name
}

function getAssistantToolCallIds(message: Message | undefined): Set<string> {
  const ids = new Set<string>()
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
    return ids
  }

  for (const block of message.content) {
    if (block.type === 'toolCall') ids.add(sanitizeToolId(block.id))
  }
  return ids
}

function getImmediateToolResultIds(
  messages: Message[],
  assistantIndex: number,
): Set<string> {
  const ids = new Set<string>()
  let index = assistantIndex + 1
  while (messages[index]?.role === 'toolResult') {
    ids.add(sanitizeToolId((messages[index] as ToolResultMessage).toolCallId))
    index += 1
  }
  return ids
}

function assistantToolCallsHaveImmediateResults(
  messages: Message[],
  assistantIndex: number,
): boolean {
  const toolCallIds = getAssistantToolCallIds(messages[assistantIndex])
  if (toolCallIds.size === 0) return true

  const resultIds = getImmediateToolResultIds(messages, assistantIndex)
  for (const id of toolCallIds) {
    if (!resultIds.has(id)) return false
  }
  return true
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
      const toolCallIds = getAssistantToolCallIds(message)
      if (
        toolCallIds.size > 0 &&
        !assistantToolCallsHaveImmediateResults(messages, index)
      ) {
        // Anthropic requires every tool_use block to be followed immediately by
        // a matching tool_result message. Interrupted Pi runs can leave an
        // aborted assistant message with a partial toolCall and no result; drop
        // that incomplete assistant turn from the replayed history.
        continue
      }

      const blocks: Array<Record<string, unknown>> = []
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) {
          blocks.push({ type: 'text', text: sanitize(block.text) })
        } else if (block.type === 'thinking' && block.thinking.trim()) {
          const thinking = block as ThinkingContent
          if (isOpenAIReasoningSignature(thinking.thinkingSignature)) {
            // OpenAI reasoningEncryptedContent is also opaque encrypted state,
            // but it is not an Anthropic thinking signature. Sending it as
            // `thinking.signature` makes Anthropic reject the request.
            continue
          }
          if (
            thinking.thinkingSignature &&
            !hasLoneSurrogate(thinking.thinking)
          ) {
            // Signed thinking blocks must be sent back verbatim — the signature
            // is computed over the original text. Sanitizing would alter it and
            // Anthropic rejects the block as "modified". Anthropic-origin
            // thinking is valid UTF-8, so this is the normal path.
            blocks.push({
              type: 'thinking',
              thinking: thinking.thinking,
              signature: thinking.thinkingSignature,
            })
          } else {
            // Either unsigned, or signed-but-contains a lone surrogate. In the
            // latter case we cannot keep the signature: sanitizing breaks it and
            // sending the raw lone surrogate is an invalid-UTF8 400. Drop the
            // signature and downgrade to sanitized text.
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
      const previous = messages[index - 1]
      if (
        previous?.role !== 'assistant' ||
        !assistantToolCallsHaveImmediateResults(messages, index - 1)
      ) {
        while (messages[index + 1]?.role === 'toolResult') index += 1
        continue
      }

      const expectedToolCallIds = getAssistantToolCallIds(previous)
      const appendToolResult = (toolResult: ToolResultMessage) => {
        const toolUseId = sanitizeToolId(toolResult.toolCallId)
        if (!expectedToolCallIds.delete(toolUseId)) return
        let content = convertTextAndImages(toolResult.content)
        // Anthropic rejects tool_result with is_error=true but empty content
        if (
          toolResult.isError &&
          (!content || (Array.isArray(content) && content.length === 0))
        ) {
          content = [{ type: 'text', text: 'Error' }]
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: content,
          is_error: toolResult.isError,
        })
      }

      const toolResult = message as ToolResultMessage
      const toolResults: Array<Record<string, unknown>> = []
      appendToolResult(toolResult)

      let nextIndex = index + 1
      while (
        nextIndex < messages.length &&
        messages[nextIndex]?.role === 'toolResult'
      ) {
        appendToolResult(messages[nextIndex] as ToolResultMessage)
        nextIndex += 1
      }
      index = nextIndex - 1
      if (toolResults.length)
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
  // Strip trailing assistant messages — Anthropic rejects prefill on some models
  while (
    messages.length &&
    messages[messages.length - 1]?.role === 'assistant'
  ) {
    messages.pop()
  }
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

  const isFableOrMythos5 = isClaudeFableOrMythos5Model(modelId)
  const isSonnet5 = isClaudeSonnet5Model(modelId)
  const isOpus5 = isClaudeOpus5Model(modelId)
  // Sonnet 5 and Opus 5 share Fable/Mythos's adaptive-summarized contract: make
  // adaptive thinking visible (display defaults to "omitted") and map reasoning
  // to output_config effort. Pi's typed options cannot express
  // thinking-disabled, so there is no disable case here (see transform.ts for
  // the raw-body path). Each model refs its own per-family constant —
  // families can diverge, so the constant rather than a shared alias keeps
  // the call sites explicit.
  if (isFableOrMythos5) {
    body.thinking = { ...CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING }
  } else if (isSonnet5) {
    body.thinking = { ...CLAUDE_SONNET_5_ADAPTIVE_THINKING }
  } else if (isOpus5) {
    body.thinking = { ...CLAUDE_OPUS_5_ADAPTIVE_THINKING }
  }

  if (options?.reasoning) {
    if (isFableOrMythos5 || isSonnet5 || isOpus5) {
      body.output_config = { effort: options.reasoning }
    } else {
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
  }

  addEphemeralCacheControl(body)
  applyCacheMode(body, cache.enabled, cache.mode)
  if (identity) applyClaudeCodeMetadata(body, identity)

  const unsigned = JSON.stringify(orderClaudeCodeBody(body))
  const bodyText = await signRequestBody(unsigned)
  return { body, bodyText }
}
