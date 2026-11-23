import {
  applyCacheDiagnosticsOptIn,
  applyClaudeCodeMetadata,
  applyRunnerPlanNotes,
  applyRunnerTurnNotes,
  applySessionCacheTtl,
  applyThinkingBindingControls,
  applyTurnEndNotes,
  assertNoMeaningfulTrailingAssistant,
  type BillingLineageFields,
  buildBillingHeaderValue,
  CACHE_DIAGNOSTICS_BETA,
  type Cache1hMode,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING,
  CLAUDE_HAIKU_5_5_ADAPTIVE_THINKING,
  CLAUDE_OPUS_5_5_ADAPTIVE_THINKING,
  CLAUDE_OPUS_5_ADAPTIVE_THINKING,
  CLAUDE_SONNET_5_5_ADAPTIVE_THINKING,
  CLAUDE_SONNET_5_ADAPTIVE_THINKING,
  ClaudeCodeFirstUserTextTracker,
  type ClaudeCodeIdentity,
  countUserPrompts,
  isClaudeFableOrMythos5Model,
  isClaudeHaiku55Model,
  isClaudeOpus5Model,
  isClaudeOpus55Model,
  isClaudeSonnet5Model,
  isClaudeSonnet55Model,
  isFastModeSupportedModel,
  isOpenAIReasoningSignature,
  orderClaudeCodeBody,
  prepareApiKeyRequestBody,
  readSessionCachePolicy,
  requestCacheLifetimeMs,
  selectClaudeCodeBetas,
  signRequestBody,
  stripEmptyTrailingAssistantMessages,
  type ThinkingPrefixMismatchBehavior,
} from '@cortexkit/anthropic-auth-core'
import type {
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai'
import type { PiEffortTransition } from './effort-history.ts'
import {
  applyPiForkEffort,
  type PiForkEffortHint,
  PiForkRefusal,
  piForkHeadSession,
} from './forks.ts'
import { isPiLaneStartMessage, stripPiLaneStartNonce } from './lane-start.ts'
import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  normalizeContext,
} from './transcript.ts'

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
    | {
        type: 'adaptive'
        display: 'summarized'
        block_binding?: {
          prefix_mismatch_behavior: Exclude<
            ThinkingPrefixMismatchBehavior,
            'account-default'
          >
        }
      }
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

/**
 * Snapshot the wire name sent for each host tool in one request.
 *
 * Claude Code aliases are case-insensitive, so two host tools can collapse onto
 * one wire name; that request fails before dispatch rather than letting the
 * response decoder pick either tool.
 */
export function createClaudeCodeToolNameMap(
  tools: readonly Tool[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const tool of tools) {
    const wireName = toClaudeCodeToolName(tool.name)
    const existing = names.get(wireName)
    if (existing !== undefined) {
      throw new Error(
        `Anthropic tool name collision: "${existing}" and "${tool.name}" both map to "${wireName}"`,
      )
    }
    names.set(wireName, tool.name)
  }
  return names
}

/**
 * Map a response tool name back through the exact snapshot sent with the
 * request. Unknown names stay unknown instead of being case-folded onto an
 * executable host tool.
 */
export function fromClaudeCodeToolName(
  name: string,
  requestedToolNames: ReadonlyMap<string, string>,
): string {
  return requestedToolNames.get(name) ?? name
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
  visibleReplies: WeakMap<object, string>,
  droppedAssistants: WeakSet<object>,
  mapToolName = toClaudeCodeToolName,
  userTimestamps?: WeakMap<object, number>,
): AnthropicRequestBody['messages'] {
  const result: AnthropicRequestBody['messages'] = []
  // Effort history counts source assistant turns, including ones with nothing
  // safe to replay. Keep their boundaries until effort markers are placed;
  // buildAnthropicRequest removes these placeholders before any wire output.
  const appendDroppedAssistant = () => {
    const placeholder = { role: 'assistant', content: [] }
    droppedAssistants.add(placeholder)
    result.push(placeholder)
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    if (message.role === 'user') {
      let content: AnthropicRequestBody['messages'][number]['content']
      if (typeof message.content === 'string') {
        if (!message.content.trim()) continue
        content = sanitize(message.content)
      } else {
        const parts = message.content as Array<TextContent | ImageContent>
        // A text-only user message with several parts keeps them as separate
        // blocks, as Pi's own Anthropic provider sends them, so a host's block
        // boundaries (and the cache breakpoints it places between them) survive.
        const blocks = parts.some((item) => item.type === 'image')
          ? []
          : parts
              .filter((item): item is TextContent => item.type === 'text')
              .map((item) => ({ type: 'text', text: sanitize(item.text) }))
              .filter((block) => block.text.trim())
        content = blocks.length > 1 ? blocks : convertTextAndImages(parts)
      }
      const converted = { role: 'user', content }
      result.push(converted)
      userTimestamps?.set(converted, message.timestamp)
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
        appendDroppedAssistant()
        continue
      }

      const blocks: Array<Record<string, unknown>> = []
      let visibleText = ''
      for (const block of message.content) {
        if (block.type === 'text' && block.text.trim()) {
          const text = sanitize(block.text)
          blocks.push({ type: 'text', text })
          visibleText += text
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

          // Replay reasoning only with a signature from the same Anthropic
          // API/model. Anthropic refuses reasoning replayed as ordinary text.
          if (hasSignature && !signatureBelongsToTarget) continue

          if (thinking.redacted) {
            if (hasSignature) {
              blocks.push({
                type: 'redacted_thinking',
                data: signature,
              })
            }
            continue
          }

          if (!hasSignature) continue

          // A signature authenticates the exact bytes. Sanitizing malformed
          // thinking would invalidate it, and sending lone surrogates is invalid.
          if (hasLoneSurrogate(thinking.thinking)) continue
          blocks.push({
            type: 'thinking',
            thinking: thinking.thinking,
            signature,
          })
        } else if (block.type === 'toolCall') {
          blocks.push({
            type: 'tool_use',
            id: sanitizeToolId(block.id),
            name: mapToolName(block.name),
            input: block.arguments,
          })
        }
      }
      if (blocks.length) {
        const converted = { role: 'assistant', content: blocks }
        result.push(converted)
        // Only actual text is a visible reply. Use the exact outgoing strings so
        // later requests make the same decision about adding a turn-end note.
        visibleReplies.set(converted, visibleText)
      } else {
        appendDroppedAssistant()
      }
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
  mapToolName: (name: string) => string,
): AnthropicRequestBody['tools'] {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    // Names are checked for collisions by createClaudeCodeToolNameMap first.
    name: mapToolName(tool.name),
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
    if (typeof content === 'string') {
      message.content = [{ type: 'text', text: content }]
    }
    if (Array.isArray(message.content)) {
      const lastBlock = message.content.at(-1)
      if (lastBlock && typeof lastBlock === 'object') {
        lastBlock.cache_control = { type: 'ephemeral' }
      }
    }
    break
  }
}

/**
 * Paid API-key requests get exactly the cache markers Pi's own Anthropic
 * provider would place: the system prompt, the last tool and the last message.
 */
function applyPiApiKeyCache(
  body: AnthropicRequestBody,
  options: SimpleStreamOptions | undefined,
  compat: Model<'anthropic-messages'>['compat'],
): void {
  // Same resolution as Pi's own provider (resolveCacheRetention): the
  // environment can only ask for long retention, and no caching needs the
  // explicit cacheRetention option. Paid requests stay as Pi would send them.
  const retention =
    options?.cacheRetention ??
    ((options?.env?.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION) ===
    'long'
      ? 'long'
      : 'short')
  if (retention === 'none') return
  const control = {
    type: 'ephemeral',
    ...(retention === 'long' && compat?.supportsLongCacheRetention !== false
      ? { ttl: '1h' }
      : {}),
  }
  const system = body.system?.at(-1)
  if (system) system.cache_control = control
  const tool = body.tools?.at(-1)
  if (tool && compat?.supportsCacheControlOnTools !== false)
    tool.cache_control = control

  const last = body.messages.at(-1)
  if (last?.role !== 'user' && last?.role !== 'system') return
  if (typeof last.content === 'string') {
    last.content = [
      { type: 'text', text: last.content, cache_control: control },
    ]
  } else if (Array.isArray(last.content)) {
    const block = last.content.at(-1)
    if (
      [
        'text',
        'image',
        'tool_result',
        'tool_addition',
        'tool_removal',
      ].includes(block?.type)
    )
      block.cache_control = control
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

function applyForkCacheBridge(
  body: AnthropicRequestBody,
  baseIndex: number,
): void {
  if (baseIndex < 0) return
  const base = body.messages[baseIndex]
  const blocks = body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string'
        ? [message]
        : [],
  ) as Record<string, unknown>[]
  const baseBlock = Array.isArray(base?.content)
    ? (base.content.at(-1) as Record<string, unknown> | undefined)
    : undefined
  if (!baseBlock || baseBlock.cache_control) return
  const newest: Record<string, unknown> | undefined = body.cache_control
    ? (body as unknown as Record<string, unknown>)
    : blocks.findLast((block) => block.cache_control)
  const newestPosition =
    newest === body ? blocks.length - 1 : blocks.indexOf(newest ?? {})
  // Both the new and retained boundaries count toward the 20-block window.
  if (!newest || newestPosition - blocks.indexOf(baseBlock) < 20) return
  const control = newest.cache_control as Record<string, unknown>
  const holders: Record<string, unknown>[] = []
  walkCacheControlHolders(body, (holder) => holders.push(holder))
  const ttl = (holder: Record<string, unknown>) =>
    (holder.cache_control as Record<string, unknown>)?.ttl === '1h'
      ? 3_600_000
      : 300_000
  const basePosition = blocks.indexOf(baseBlock)
  // Tools and system precede messages on the wire. Never insert a long-lived
  // marker after a short-lived one, including markers a payload hook supplied.
  if (
    holders.some((holder) => {
      if (holder === body) return false
      const index = blocks.indexOf(holder)
      return index < 0 || index < basePosition
        ? ttl(holder) < ttl(newest)
        : ttl(holder) > ttl(newest)
    })
  )
    return
  const systemAnchor = body.system?.findLast((block) => block.cache_control)
  const removable =
    holders.find(
      (holder) =>
        holder !== systemAnchor && holder !== newest && blocks.includes(holder),
    ) ?? holders.find((holder) => body.tools?.includes(holder))
  if (holders.length >= 4 && !removable) return
  // Drop the oldest ordinary message marker (normally the prompt paragraph),
  // or the tool marker if none exists. The protected system anchor still covers
  // the fixed prefix; preserving the frozen base outranks those extra anchors.
  if (holders.length >= 4 && removable) delete removable.cache_control
  baseBlock.cache_control = { ...control }
}

/** Find the previous boundary when the latest one's lookback cannot reach it. */
function hybridLookbackBridge(messages: unknown[]) {
  let position = 0
  let previous: { message: Record<string, unknown>; end: number } | undefined
  let latest: typeof previous
  for (const value of messages) {
    if (!value || typeof value !== 'object') continue
    const message = value as Record<string, unknown>
    const content = message.content
    // A system note inserted after a reply uses string content and consumes
    // one lookback block, though only user messages can be bridge anchors.
    const blocks = Array.isArray(content)
      ? content.length
      : content == null
        ? 0
        : 1
    position += blocks
    if (message.role === 'user' && blocks > 0) {
      previous = latest
      latest = { message, end: position }
    }
  }
  // Pi has no fixed marker at the tail of its first user message. Count both
  // boundaries in Anthropic's lookback, even when the earlier one is first.
  return previous && latest && latest.end - previous.end + 1 > 20
    ? previous.message
    : undefined
}

function applyHybridCacheBridge(body: AnthropicRequestBody) {
  const system = body.system?.findLast((block) => block.cache_control)
  if (!system) return
  const bridge = hybridLookbackBridge(body.messages)
  if (!bridge) return
  if (typeof bridge.content === 'string')
    bridge.content = [{ type: 'text', text: bridge.content }]
  if (!Array.isArray(bridge.content)) return
  const block = bridge.content.findLast(
    (value) =>
      value &&
      typeof value === 'object' &&
      value.type !== 'thinking' &&
      value.type !== 'redacted_thinking',
  )
  if (!block) return
  block.cache_control = system.cache_control
  delete system.cache_control
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
 * - `automatic`: the top-level control alone.
 * - `hybrid`: the four block breakpoints, with the system slot
 *   available for a lookback bridge on an ordinary request.
 * - `explicit`: the same four breakpoints, TTL only.
 */
function applyCacheMode(
  body: AnthropicRequestBody,
  long: boolean,
  mode: Cache1hMode,
): void {
  if (mode === 'automatic') {
    walkCacheControlHolders(body, (holder) => {
      delete holder.cache_control
    })
    body.cache_control = { type: 'ephemeral', ...(long && { ttl: '1h' }) }
    return
  }

  if (long) applySessionCacheTtl(body, 'long')
}

/** Let a full request after a thread reuse its last full-request cache boundary. */
export function piThreadCacheSlot(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (body.cache_control) return undefined
  const system = Array.isArray(body.system)
    ? body.system.findLast(
        (block) => block && typeof block === 'object' && block.cache_control,
      )
    : undefined
  if (system) return system
  if (!Array.isArray(body.messages)) return undefined
  const bridge = hybridLookbackBridge(body.messages)
  return Array.isArray(bridge?.content)
    ? bridge.content.findLast(
        (block) => block && typeof block === 'object' && block.cache_control,
      )
    : undefined
}

export async function buildAnthropicRequest(
  modelId: string,
  context: Context,
  options: SimpleStreamOptions | undefined,
  cache: { enabled: boolean; mode: Cache1hMode },
  fastModeEnabled = false,
  identity?: ClaudeCodeIdentity,
  controls: {
    /** Convert Pi's typed context without adding Claude Code wire shaping. */
    apiKey?: boolean
    apiKeyModelCompat?: Model<'anthropic-messages'>['compat']
    laneStart?: boolean
    billingLineage?: BillingLineageFields
    effortTransitions?: readonly PiEffortTransition[]
    forkBaseMessageCount?: number
    /** A fork's lower answer effort, applied to its question turn only. */
    forkEffort?: PiForkEffortHint
    /** Leave the billing signature placeholder for the transport to finalize. */
    deferSigning?: boolean
    cacheDiagnosticsPreviousMessageId?: string | null
    thinkingPrefixMismatchBehavior?: ThinkingPrefixMismatchBehavior
    turnEndNote?: { tools: string[] }
    /**
     * Pi's `options.onPayload`, bound to the dispatched model. Pi's provider
     * contract: call it before sending and send any replacement it returns. It
     * sees the body with this provider's cache breakpoints placed and runs
     * before signing, so the billing signature covers what is sent.
     */
    onPayload?: (body: AnthropicRequestBody) => unknown | Promise<unknown>
  } = {},
): Promise<{
  body: AnthropicRequestBody
  bodyText: string
  toolNames: ReadonlyMap<string, string>
  cacheTtlMs: number
  /** Set only when `controls.forkEffort` changed the request. */
  forkEffortApplied?: PiForkEffortHint
}> {
  const apiKey = controls.apiKey === true
  for (const message of context.messages)
    stripPiLaneStartNonce(message, options?.sessionId)
  const mapToolName = apiKey ? (name: string) => name : toClaudeCodeToolName
  const forkBase =
    controls.forkBaseMessageCount === undefined
      ? undefined
      : collapseSystemMessages(
          normalizeContext({
            ...context,
            systemPrompt: systemPromptText(context.systemPrompt),
            messages: context.messages.slice(0, controls.forkBaseMessageCount),
          }),
        )
  // Pi 0.86 passes a normalized transcript to providers, and later system
  // messages can change the prompt, its named sections and the tool set. Resolve
  // them through the local replay port; raw host prompts (including ordered OMP
  // blocks) still enter through normalization.
  const transcript = collapseSystemMessages(
    normalizeContext({
      ...context,
      systemPrompt: systemPromptText(context.systemPrompt),
    }),
  )
  context = {
    messages: transcript.messages,
    systemPrompt: getCurrentSystemPrompt(transcript.messages),
    tools: getCurrentTools(transcript.messages),
  }
  // Conversion can discard opaque or incomplete blocks. Check context.messages
  // first so those losses cannot hide a meaningful final assistant turn. Check
  // the Anthropic messages again after conversion removes empty user messages.
  assertNoMeaningfulTrailingAssistant(context.messages)
  const visibleReplies = new WeakMap<object, string>()
  const droppedAssistants = new WeakSet<object>()
  // Keep timestamps off the wire. Message identity survives dropped empty
  // users, prepended documentation and inserted effort or turn-note messages.
  const userTimestamps = new WeakMap<object, number>()
  const messages = convertMessages(
    context.messages,
    modelId,
    visibleReplies,
    droppedAssistants,
    mapToolName,
    userTimestamps,
  )
  stripEmptyTrailingAssistantMessages(messages)
  const baseLastMessage = forkBase
    ? messages
        .slice(
          0,
          convertMessages(
            forkBase.messages,
            modelId,
            new WeakMap(),
            new WeakSet(),
          ).length,
        )
        .findLast((message) => !droppedAssistants.has(message))
    : undefined
  // The head's final user block was an array so it could carry its cache
  // marker. Keep that block shape when it is no longer the fork's newest user.
  if (baseLastMessage && typeof baseLastMessage.content === 'string')
    baseLastMessage.content = [{ type: 'text', text: baseLastMessage.content }]
  const forkHead = piForkHeadSession(options)
  const forkFirstUserText = forkHead
    ? firstUserTextTracker.peek(forkHead)
    : undefined
  if (forkHead && forkFirstUserText === undefined)
    throw new PiForkRefusal('base')
  const system = apiKey
    ? []
    : [
        {
          type: 'text',
          text: buildBillingHeaderValue(
            messages,
            undefined,
            CLAUDE_CODE_ENTRYPOINT,
            options?.sessionId
              ? forkHead
                ? forkFirstUserText
                : firstUserTextTracker.resolve(options.sessionId, messages)
              : undefined,
            identity && !forkHead && controls.billingLineage?.promptId
              ? {
                  ...controls.billingLineage,
                  promptIndex:
                    countUserPrompts(messages) -
                    context.messages.filter(isPiLaneStartMessage).length,
                }
              : undefined,
          ),
        },
        { type: 'text', text: CLAUDE_CODE_IDENTITY },
      ]
  const systemPrompt = systemPromptText(context.systemPrompt)
  if (apiKey) {
    if (systemPrompt.trim())
      system.push({ type: 'text', text: sanitize(systemPrompt) })
  } else if (systemPrompt.trim()) {
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

  let body: AnthropicRequestBody = {
    model: modelId,
    max_tokens: options?.maxTokens ?? 16_384,
    stream: true,
    ...(system.length ? { system } : {}),
    messages,
  }

  const declaredToolNames = apiKey
    ? new Map<string, string>()
    : createClaudeCodeToolNameMap(context.tools ?? [])
  const tools = convertTools(context.tools, mapToolName)
  if (tools?.length) body.tools = tools

  if (!apiKey && fastModeEnabled && isFastModeSupportedModel(modelId)) {
    body.speed = 'fast'
  }

  const isFableOrMythos5 = isClaudeFableOrMythos5Model(modelId)
  const isSonnet5 = isClaudeSonnet5Model(modelId)
  const isSonnet55 = isClaudeSonnet55Model(modelId)
  const isHaiku55 = isClaudeHaiku55Model(modelId)
  const isOpus5 = isClaudeOpus5Model(modelId)
  const isOpus55 = isClaudeOpus55Model(modelId)
  // Request summaries so the host can display adaptive reasoning.
  // Pi's typed options cannot express the disabled-thinking setting;
  // OpenCode handles it by transforming the raw request body. Separate model
  // constants let each model's thinking configuration change independently.
  if (isFableOrMythos5) {
    body.thinking = { ...CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING }
  } else if (isHaiku55) {
    body.thinking = { ...CLAUDE_HAIKU_5_5_ADAPTIVE_THINKING }
  } else if (isSonnet55) {
    body.thinking = { ...CLAUDE_SONNET_5_5_ADAPTIVE_THINKING }
  } else if (isSonnet5) {
    body.thinking = { ...CLAUDE_SONNET_5_ADAPTIVE_THINKING }
  } else if (isOpus55) {
    body.thinking = { ...CLAUDE_OPUS_5_5_ADAPTIVE_THINKING }
  } else if (isOpus5) {
    body.thinking = { ...CLAUDE_OPUS_5_ADAPTIVE_THINKING }
  }

  if (options?.reasoning) {
    if ((isSonnet55 || isHaiku55) && options.reasoning === 'minimal') {
      throw new Error(
        `${isHaiku55 ? 'Claude Haiku 5.5' : 'Claude Sonnet 5.5'} does not support minimal effort`,
      )
    }
    if (
      isFableOrMythos5 ||
      isSonnet5 ||
      isSonnet55 ||
      isHaiku55 ||
      isOpus5 ||
      isOpus55
    ) {
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

  const forkEffortApplied = apiKey
    ? undefined
    : applyPiForkEffort(
        body,
        controls.effortTransitions ?? [],
        controls.forkEffort,
        baseLastMessage,
      )
  body.messages = body.messages.filter(
    (message) => !droppedAssistants.has(message),
  )
  if (identity) {
    applyTurnEndNotes(body, {
      tools: controls.turnEndNote?.tools,
      mapToolName: toClaudeCodeToolName,
      visibleText: (message) => visibleReplies.get(message) ?? '',
    })
  }
  applyRunnerTurnNotes(body, {
    sessionId: options?.sessionId,
    modelId,
    isOAuth: !!identity,
  })
  applyRunnerPlanNotes(body, {
    // A fork's own handle returns the notes from its retained base request.
    sessionId: options?.sessionId,
    modelId,
    isOAuth: !!identity && !apiKey,
    userTimestamps,
  })
  const cachePolicy = apiKey
    ? undefined
    : readSessionCachePolicy(options?.sessionId, !!identity)
  if (apiKey) {
    applyPiApiKeyCache(body, options, controls.apiKeyModelCompat)
  } else {
    addEphemeralCacheControl(body)
    applyCacheMode(
      body,
      cachePolicy?.ttl === 'long' ||
        (cachePolicy?.ttl === undefined && cache.enabled),
      cache.mode,
    )
    if (
      cache.mode === 'hybrid' &&
      cachePolicy?.ttl !== 'none' &&
      !forkHead &&
      !forkBase
    )
      applyHybridCacheBridge(body)
  }
  if (identity) {
    applyThinkingBindingControls(
      body,
      controls.thinkingPrefixMismatchBehavior ?? 'account-default',
    )
    applyClaudeCodeMetadata(body, identity)
  }

  const baseBoundary = baseLastMessage
    ? body.messages.indexOf(baseLastMessage)
    : -1
  const replaced = controls.onPayload
    ? await controls.onPayload(body)
    : undefined
  if (replaced !== undefined)
    body = { ...(replaced as AnthropicRequestBody), stream: true }
  if (controls.laneStart) {
    body.max_tokens = 1
    delete body.thinking
  }
  if (apiKey) prepareApiKeyRequestBody(body)
  else applySessionCacheTtl(body, cachePolicy?.ttl)
  if (!apiKey && baseBoundary >= 0) applyForkCacheBridge(body, baseBoundary)
  // As in Pi's native adapter, replacements must still request SSE. Hooks own
  // the validity of their other edits and must not add a fifth cache breakpoint:
  // the provider's existing layout may already use Anthropic's four slots.
  let breakpoints = 0
  walkCacheControlHolders(body, () => {
    breakpoints += 1
  })
  if (breakpoints > 4)
    throw new Error(
      `Anthropic accepts at most 4 cache breakpoints; the onPayload hook left ${breakpoints}`,
    )
  if (
    controls.cacheDiagnosticsPreviousMessageId !== undefined &&
    selectClaudeCodeBetas(body).split(',').includes(CACHE_DIAGNOSTICS_BETA)
  )
    applyCacheDiagnosticsOptIn(body, controls.cacheDiagnosticsPreviousMessageId)
  const unsigned = JSON.stringify(
    apiKey ? body : orderClaudeCodeBody(body, { isOAuth: !!identity }),
  )
  const bodyText =
    apiKey || controls.deferSigning ? unsigned : await signRequestBody(unsigned)
  // Translate only known host/wire pairs that survived the hook and JSON
  // serialization. Hook-added or renamed tools must not acquire an alias, and
  // response decoding must never change outgoing names or signed history.
  const sentBody = JSON.parse(bodyText) as AnthropicRequestBody
  const sentNames = new Set(sentBody.tools?.map((tool) => tool.name))
  const toolNames = new Map(
    [...declaredToolNames].filter(([wireName]) => sentNames.has(wireName)),
  )
  // Sticky routing uses the longest TTL actually sent to bound how long a
  // session waits on its account. Include hook edits, not the account setting;
  // a cache_control key inside tool data is not a cache breakpoint.
  const cacheTtlMs = requestCacheLifetimeMs(sentBody)
  return {
    body,
    bodyText,
    toolNames,
    cacheTtlMs,
    ...(forkEffortApplied && { forkEffortApplied }),
  }
}
