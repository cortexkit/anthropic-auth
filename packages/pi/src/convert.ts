import {
  applyClaudeCodeMetadata,
  applyMidConversationOutputConfig,
  applyThinkingBindingControls,
  buildBillingHeaderValue,
  type Cache1hMode,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING,
  CLAUDE_OPUS_5_ADAPTIVE_THINKING,
  CLAUDE_SONNET_5_ADAPTIVE_THINKING,
  ClaudeCodeFirstUserTextTracker,
  type ClaudeCodeIdentity,
  isClaudeFableOrMythos5Model,
  isClaudeOpus5Model,
  isClaudeSonnet5Model,
  isFastModeSupportedModel,
  isOpenAIReasoningSignature,
  type MidConversationEffortTransition,
  orderClaudeCodeBody,
  signRequestBody,
  type ThinkingPrefixMismatchBehavior,
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
import * as piAi from '@earendil-works/pi-ai'

/**
 * What `streamSimple` is handed, across pi versions.
 *
 * pi < 0.86 passes a raw `Context`: `systemPrompt` and `tools` populated, no
 * `role: 'system'` messages. pi >= 0.86 passes a normalized `TranscriptContext`
 * (`{ messages }` only): the prompt and the tool declarations are folded into a
 * leading system message (`content` + `toolsAdded`), and later system messages
 * may carry `toolsAdded` / `toolsRemoved` / `sections` deltas. Reading
 * `context.systemPrompt` / `context.tools` on that shape yields `undefined` for
 * both, so the request goes out with no host prompt and no tools — HTTP 200 and
 * a reply from a bare model that says it has no bash tool.
 */
export type RequestContext = {
  messages: Message[]
  systemPrompt?: unknown
  tools?: Tool[]
}

export type ResolvedRequestContext = {
  systemPrompt: unknown
  tools: Tool[]
  messages: Message[]
}

type TranscriptSystemMessage = {
  role: 'system'
  content?: unknown
  toolsAdded?: Tool[]
  toolsRemoved?: { name: string }[]
}

function isTranscriptSystemMessage(
  message: unknown,
): message is TranscriptSystemMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { role?: unknown }).role === 'system'
  )
}

/**
 * Resolve the host prompt, tool list, and message list from either context shape.
 *
 * On pi >= 0.86 the transcript helpers exported by pi-ai (`collapseSystemMessages`,
 * `getCurrentSystemPrompt`, `getCurrentTools`) replay every system message into
 * the current prompt and tool set; they are the same functions pi's built-in
 * providers use, so `sections` patches and tool removals resolve identically.
 * They are reached through the namespace import and a `typeof` check rather
 * than named imports: on pi-ai < 0.86 the exports do not exist, and a missing
 * named export fails the whole extension at load.
 *
 * If a transcript carries system messages but the helpers are absent (only
 * reachable in tests pinned to an older pi-ai), a minimal replay keeps the
 * prompt and tools rather than dropping them: system text concatenated in
 * order, `toolsRemoved` then `toolsAdded` applied per message.
 *
 * The raw `Context` fields win when there is no system message, so pi < 0.86
 * is unchanged.
 */
/**
 * The pi-ai transcript helpers, as an optional set. Production reads them off
 * the `@earendil-works/pi-ai` namespace, which pi's extension loader aliases to
 * the host's own bundled pi-ai — so their presence tracks the running pi, not
 * this package's lockfile. Tests pass a stub (or `{}`) to pin which branch runs.
 */
export type TranscriptHelpers = {
  collapseSystemMessages?: (context: { messages: Message[] }) => {
    messages: Message[]
  }
  getCurrentSystemPrompt?: (messages: readonly { role: string }[]) => string
  getCurrentTools?: (messages: readonly { role: string }[]) => Tool[]
}

export function resolveRequestContext(
  context: RequestContext,
  helpers: TranscriptHelpers = piAi as unknown as TranscriptHelpers,
): ResolvedRequestContext {
  const hasSystemMessages = context.messages.some(isTranscriptSystemMessage)
  if (!hasSystemMessages) {
    return {
      systemPrompt: context.systemPrompt,
      tools: context.tools ?? [],
      messages: context.messages,
    }
  }

  if (
    typeof helpers.collapseSystemMessages === 'function' &&
    typeof helpers.getCurrentSystemPrompt === 'function' &&
    typeof helpers.getCurrentTools === 'function'
  ) {
    const transcript = helpers.collapseSystemMessages({
      messages: context.messages,
    })
    return {
      systemPrompt: helpers.getCurrentSystemPrompt(transcript.messages),
      tools: helpers.getCurrentTools(transcript.messages),
      messages: transcript.messages.filter(
        (message) => !isTranscriptSystemMessage(message),
      ),
    }
  }

  const parts: string[] = []
  const tools = new Map<string, Tool>()
  for (const message of context.messages as unknown[]) {
    if (!isTranscriptSystemMessage(message)) continue
    const text = systemPromptText(message.content)
    if (text.length > 0) parts.push(text)
    for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name)
    for (const added of message.toolsAdded ?? []) tools.set(added.name, added)
  }
  return {
    systemPrompt: parts.join('\n\n'),
    tools: [...tools.values()],
    messages: context.messages.filter(
      (message) => !isTranscriptSystemMessage(message),
    ),
  }
}

// Anchor identifying Pi's documentation paragraph — the only part of the prompt
// that Anthropic currently rejects in system[]. Unknown prompt shapes take the
// service-preserving fallback below instead of returning the full prompt there.
const PI_DOCS_ANCHOR = 'Pi documentation'
const firstUserTextTracker = new ClaudeCodeFirstUserTextTracker()
const ANTHROPIC_REPLAY_APIS = new Set([
  'anthropic-messages',
  'cortexkit-anthropic-messages',
])

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
  cache_control?: { type: 'ephemeral'; ttl?: '1h' }
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
  targetModelId: string,
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
        } else if (block.type === 'thinking') {
          const thinking = block as ThinkingContent
          const signature = thinking.thinkingSignature
          const hasSignature =
            typeof signature === 'string' && signature.trim().length > 0
          const signatureBelongsToTarget =
            message.provider === 'anthropic' &&
            ANTHROPIC_REPLAY_APIS.has(message.api) &&
            message.model === targetModelId &&
            !isOpenAIReasoningSignature(signature)

          // Match Pi's built-in origin check: only replay signatures from the
          // same Anthropic API/model. Preserve visible foreign reasoning as
          // ordinary text, but drop opaque redacted/OpenAI encrypted state.
          if (hasSignature && !signatureBelongsToTarget) {
            if (
              !thinking.redacted &&
              !isOpenAIReasoningSignature(signature) &&
              thinking.thinking.trim()
            ) {
              blocks.push({ type: 'text', text: sanitize(thinking.thinking) })
            }
            continue
          }

          if (thinking.redacted) {
            if (hasSignature) {
              blocks.push({
                type: 'redacted_thinking',
                data: signature,
              })
            }
            continue
          }

          if (!hasSignature) {
            // Anthropic rejects unsigned thinking blocks. Preserve readable
            // output from interrupted streams as ordinary assistant text.
            if (thinking.thinking.trim()) {
              blocks.push({
                type: 'text',
                text: sanitize(thinking.thinking),
              })
            }
            continue
          }

          if (hasLoneSurrogate(thinking.thinking)) {
            // Signature authenticates the thinking bytes exactly. Sanitizing the
            // text would invalidate it, so downgrade malformed signed thinking
            // to plain text and omit the signature instead.
            if (thinking.thinking.trim()) {
              blocks.push({
                type: 'text',
                text: sanitize(thinking.thinking),
              })
            }
          } else {
            blocks.push({
              type: 'thinking',
              thinking: thinking.thinking,
              signature,
            })
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

/**
 * Flatten a host system prompt to text.
 *
 * Pi types `Context.systemPrompt` as `string`, but Oh My Pi 18.x types it as
 * `string[]` — "ordered system prompt blocks" — and hands that array to the
 * provider unflattened, where `.trim()` is not a function and no request was
 * ever built (issue #201).
 *
 * Blocks join on a blank line, which is how the host's own providers flatten
 * them (`normalizeSystemPrompts(prompt).join('\n\n')`), so the paragraph split
 * below classifies the same text on either host. The host asks providers to
 * preserve its entries as distinct blocks, and that is deliberately not done
 * here: an unrecognized prompt shape is carried in messages[] precisely because
 * placing the host prompt in top-level system[] is the request shape Anthropic
 * rejects with 400 "You're out of extra usage" (see splitPiSystemPrompt).
 * Joining loses no text and no paragraph boundary; re-emitting the entries as
 * system[] blocks would reintroduce that rejection.
 *
 * Only a `{ type: 'text', text }` block is read. The host declares strings, so
 * that branch is for the next drift in this same field: returning '' there
 * would silently ship requests with no host prompt at all, which is worse than
 * the crash this replaces. `type` is checked rather than reading any object's
 * `text` field, so a tool, image, or other structured block never has its
 * metadata flattened into the prompt.
 */
function systemPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''

  const parts: string[] = []
  for (const block of prompt) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    const record = block as { type?: unknown; text?: unknown } | null
    if (record?.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text)
    }
  }
  return parts.join('\n\n')
}

function splitPiSystemPrompt(prompt: string): {
  systemText?: string
  messageText: string
} {
  const sanitized = sanitize(prompt)
  const paragraphs = sanitized.split(/\n\n+/)
  const docs = paragraphs.filter((paragraph) =>
    paragraph.includes(PI_DOCS_ANCHOR),
  )

  // If Pi changes the heading or prompt layout, fail away from the request shape
  // known to trigger billing rejection: carry the complete host prompt in the
  // first user message until the new shape can be classified precisely.
  if (docs.length === 0) return { messageText: sanitized }

  const keep = paragraphs.filter(
    (paragraph) => !paragraph.includes(PI_DOCS_ANCHOR),
  )
  return {
    ...(keep.length ? { systemText: keep.join('\n\n') } : {}),
    messageText: docs.join('\n\n'),
  }
}

function prependCachedPromptBlock(
  messages: AnthropicRequestBody['messages'],
  text: string,
): void {
  const firstUser = messages.find((message) => message.role === 'user')
  if (!firstUser) return

  const promptBlock = {
    type: 'text',
    text,
    cache_control: { type: 'ephemeral' as const },
  }
  if (typeof firstUser.content === 'string') {
    firstUser.content = [promptBlock, { type: 'text', text: firstUser.content }]
    return
  }
  if (Array.isArray(firstUser.content)) {
    firstUser.content.unshift(promptBlock)
  }
}

/**
 * Visit every object that can legitimately hold an Anthropic cache breakpoint:
 * the request root, each `system[]` block, each tool, and each message with its
 * content blocks — exactly where addEphemeralCacheControl and
 * prependCachedPromptBlock place them.
 *
 * Deliberately not a deep walk. A tool's `input_schema` and a replayed
 * `tool_use.input` are arbitrary caller data, so a nested field named
 * `cache_control` there is a tool parameter or argument, not a breakpoint:
 * deleting it or writing `ttl` into it would corrupt the tool contract.
 */
function walkCacheControlHolders(
  body: AnthropicRequestBody,
  visit: (holder: Record<string, unknown>) => void,
): void {
  const holders: unknown[] = [body]
  if (body.system) holders.push(...body.system)
  if (body.tools) holders.push(...body.tools)
  for (const message of body.messages) {
    holders.push(message)
    if (Array.isArray(message.content)) holders.push(...message.content)
  }

  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue
    const record = holder as Record<string, unknown>
    const cacheControl = record.cache_control
    if (cacheControl && typeof cacheControl === 'object') visit(record)
  }
}

/**
 * Anthropic accepts at most four cache breakpoints per request. This provider
 * composes its own body and has already placed exactly four
 * (addEphemeralCacheControl's last tool, last system block and last user block,
 * plus the cached prompt block on the first user message), so the top-level
 * control this used to add on top of them made five cache_control sites in one
 * body — the shape behind "A maximum of 4 blocks with cache_control may be
 * provided. Found 5." on a request that never reached the model (issue #201).
 *
 * Each mode now places its own breakpoints and nothing else, as the OpenCode
 * rewrite path does (`applyAutomaticCache1h` / `applyHybridCache1h` both clear
 * every breakpoint first):
 * - `automatic`: the top-level control alone, at 1h.
 * - `hybrid`: the four block breakpoints extended to 1h, no top-level control.
 *   That is the placement OpenCode's hybrid anchors reconstruct by hand and
 *   this converter emits natively.
 * - `explicit`: the same four breakpoints, TTL only.
 */
function applyCacheMode(
  body: AnthropicRequestBody,
  enabled: boolean,
  mode: Cache1hMode,
): void {
  if (!enabled) return

  if (mode === 'automatic') {
    walkCacheControlHolders(body, (holder) => {
      delete holder.cache_control
    })
    body.cache_control = { type: 'ephemeral', ttl: '1h' }
    return
  }

  walkCacheControlHolders(body, (holder) => {
    ;(holder.cache_control as Record<string, unknown>).ttl = '1h'
  })
}

export async function buildAnthropicRequest(
  modelId: string,
  context: Context | RequestContext,
  options: SimpleStreamOptions | undefined,
  cache: { enabled: boolean; mode: Cache1hMode },
  fastModeEnabled = false,
  identity?: ClaudeCodeIdentity,
  controls: {
    effortTransitions?: readonly MidConversationEffortTransition[]
    thinkingPrefixMismatchBehavior?: ThinkingPrefixMismatchBehavior
  } = {},
): Promise<{ body: AnthropicRequestBody; bodyText: string }> {
  const request = resolveRequestContext(context)
  const messages = convertMessages(request.messages, modelId)
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
        options?.sessionId
          ? firstUserTextTracker.resolve(options.sessionId, messages)
          : undefined,
      ),
    },
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
  ]
  const systemPrompt = systemPromptText(request.systemPrompt)
  if (systemPrompt.trim()) {
    // Pi's prompt cannot sit whole in the top-level system[] array: two lines of
    // its documentation paragraph (the docs/*.md enumeration and the "follow .md
    // cross-references" instruction) are each independently sufficient to make
    // Anthropic reject the request with 400 "You're out of extra usage". Entry
    // count and payload size are ruled out — 2697 bytes of neutral filler in the
    // same position is accepted, and the same text is accepted inside messages[].
    //
    // For the recognized Pi prompt, keep the identity, tool contract, and
    // guidelines in system[], where they carry system weight and survive context
    // compaction, and carry only the documentation paragraph in messages[]. An
    // unknown future prompt shape is moved whole rather than risking this 400.
    //
    // It goes in as its own content block ahead of the user's text, not merged
    // into it and not as a separate message. A cache prefix matches contiguously
    // from the start of the request, so a block boundary here lets the prefix end
    // before the user's words: a new conversation with a different first message
    // still reads the paragraph from cache instead of re-writing ~1.1k tokens.
    // A role: "system" message cannot be used at messages[0] — Anthropic rejects
    // that — and placing one after the first user message puts it behind content
    // that varies, which defeats the caching.
    //
    // cache_control is set explicitly because addEphemeralCacheControl's
    // message-level breakpoint only fires for array content on the *last* user
    // message, which is not this one after the first turn.
    const prompt = splitPiSystemPrompt(systemPrompt)
    if (prompt.systemText) {
      system.push({ type: 'text', text: prompt.systemText })
    }
    prependCachedPromptBlock(messages, prompt.messageText)
  }

  const body: AnthropicRequestBody = {
    model: modelId,
    max_tokens: options?.maxTokens ?? 16_384,
    stream: true,
    system,
    messages,
  }

  const tools = convertTools(request.tools)
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

  applyMidConversationOutputConfig(body, controls.effortTransitions ?? [])
  addEphemeralCacheControl(body)
  applyCacheMode(body, cache.enabled, cache.mode)
  if (identity) {
    applyThinkingBindingControls(
      body,
      controls.thinkingPrefixMismatchBehavior ?? 'account-default',
    )
    applyClaudeCodeMetadata(body, identity)
  }

  const unsigned = JSON.stringify(orderClaudeCodeBody(body))
  const bodyText = await signRequestBody(unsigned)
  return { body, bodyText }
}
