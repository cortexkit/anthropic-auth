import {
  applyClaudeCodeHeaders,
  applyClaudeCodeMetadata,
  buildBillingHeaderValue,
  type Cache1hMode,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  type ClaudeCodeIdentity,
  FAST_MODE_BETA,
  isFastModeSupportedModel,
  mergeAnthropicBetas,
  OPENCODE_IDENTITY_PREFIX,
  orderClaudeCodeBody,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  signRequestBody,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
} from '@cortexkit/anthropic-auth-core'

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Reverse prefixName: strip TOOL_PREFIX and restore the original leading case.
 */
function unprefixName(name: string): string {
  // StructuredOutput is still used as StructuredOutput
  if (name === 'StructuredOutput') {
    return name
  }
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

export type FetchInput = string | URL | Request

/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string]
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    }
  }

  return headers
}

/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get('anthropic-beta') || ''
  const incomingBetasList = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(',')
}

export function addFastModeBetaHeader(headers: Headers): Headers {
  headers.set(
    'anthropic-beta',
    mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
  )
  return headers
}

/**
 * Set OAuth-required headers on the request: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 */
export function setOAuthHeaders(
  headers: Headers,
  accessToken: string,
  options: {
    body?: Record<string, unknown> | null
    identity?: ClaudeCodeIdentity
  } = {},
): Headers {
  return applyClaudeCodeHeaders(headers, accessToken, options)
}

/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export function prefixToolNames(parsed: Record<string, unknown>): string {
  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(
      (tool: { name?: string; [k: string]: unknown }) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }),
    )
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(
      (msg: {
        content?: Array<{
          type: string
          name?: string
          [k: string]: unknown
        }>
        [k: string]: unknown
      }) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === 'tool_use' && block.name) {
              return { ...block, name: prefixName(block.name) }
            }
            return block
          })
        }
        return msg
      },
    )
  }

  return JSON.stringify(orderClaudeCodeBody(parsed))
}

/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name: string) => `"name": "${unprefixName(name)}"`,
  )
}

function splitToolPrefixRewriteBuffer(buffer: string, flush = false) {
  if (flush) return { ready: stripToolPrefix(buffer), pending: '' }

  let keepFrom = buffer.length
  const marker = '"name"'
  const partialMarkerStart = Math.max(0, buffer.length - marker.length + 1)
  for (let index = partialMarkerStart; index < buffer.length; index++) {
    if (marker.startsWith(buffer.slice(index))) {
      keepFrom = Math.min(keepFrom, index)
      break
    }
  }

  const lastName = buffer.lastIndexOf(marker)
  if (lastName !== -1) {
    const tail = buffer.slice(lastName)
    if (/^"name"\s*(?::\s*(?:"[^"]*)?)?$/.test(tail)) {
      keepFrom = Math.min(keepFrom, lastName)
    }
  }

  if (keepFrom < buffer.length) {
    return {
      ready: stripToolPrefix(buffer.slice(0, keepFrom)),
      pending: buffer.slice(keepFrom),
    }
  }

  return { ready: stripToolPrefix(buffer), pending: '' }
}

/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set.
 */
export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === '1' || raw === 'true'
}

/**
 * Parse ANTHROPIC_BASE_URL from the environment.
 * Returns a valid HTTP(S) URL or null if unset/invalid.
 */
function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const baseUrl = new URL(raw)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 * Returns the modified input and URL (if applicable).
 */
export function rewriteUrl(input: FetchInput): {
  input: FetchInput
  url: URL | null
} {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }

  if (!requestUrl) return { input, url: null }

  const originalHref = requestUrl.href

  const baseUrl = resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
  }

  if (
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }

  if (requestUrl.href === originalHref) {
    return { input, url: requestUrl }
  }

  const newInput =
    input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl
  return { input: newInput, url: requestUrl }
}

/**
 * Sanitize OpenCode-branded strings from the system prompt text.
 *
 * 1. Removes the OPENCODE_IDENTITY paragraph.
 * 2. Removes any paragraph (text between blank lines) that contains
 *    one of the PARAGRAPH_REMOVAL_ANCHORS — typically URLs that
 *    identify OpenCode-specific content.
 * 3. Applies TEXT_REPLACEMENTS for inline occurrences of "OpenCode"
 *    inside paragraphs we want to keep.
 *
 * This approach is resilient to upstream rewording of the OpenCode
 * prompt — as long as the anchor strings (URLs, etc.) still appear
 * somewhere in the paragraph, the removal works.
 */
export function sanitizeSystemText(text: string): string {
  // Split into paragraphs (separated by one or more blank lines)
  const paragraphs = text.split(/\n\n+/)

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) {
      // If the paragraph contains the identity, drop it entirely
      return false
    }

    // Remove paragraphs containing any removal anchor
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }

    return true
  })

  let result = filtered.join('\n\n')

  // Apply inline text replacements
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement)
  }

  return result.trim()
}

type SystemBlock = { type: string; text: string; [k: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }

  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    const type = typeof system.type === 'string' ? system.type : 'text'
    const text = typeof system.text === 'string' ? system.text : ''
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === 'string') {
      return { type: 'text', text: sanitizeSystemText(item) }
    }

    if (
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      return {
        ...item,
        type: 'text',
        text: sanitizeSystemText(item.text),
      }
    }

    return { type: 'text', text: String(item) }
  })

  // Idempotency: don't double-prepend if first block already has the identity
  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized
  }

  return [identityBlock, ...sanitized]
}

type CacheControl = { type: string; ttl?: string; [k: string]: unknown }
const CACHE_1H_CONTROL = { type: 'ephemeral', ttl: '1h' } as const
const ANTHROPIC_CACHE_LOOKBACK_BLOCKS = 20

function getCacheControl(value: Record<string, unknown>) {
  if (isRecord(value.cache_control)) return value.cache_control
  if (isRecord(value.cacheControl)) return value.cacheControl
  return null
}

function setWireCacheControl(value: unknown, withTtl: boolean) {
  if (!isRecord(value)) return false
  delete value.cacheControl
  value.cache_control = withTtl
    ? { ...CACHE_1H_CONTROL }
    : { type: 'ephemeral' }
  return true
}

function removeCacheControl(value: unknown) {
  if (!isRecord(value)) return
  delete value.cache_control
  delete value.cacheControl
}

function normalizeContentToArray(content: unknown) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return null
}

function updateCacheControlTtl(value: unknown, cache1hEnabled: boolean) {
  if (!isRecord(value)) return
  const cacheControl = getCacheControl(value) as CacheControl | null
  if (cacheControl?.type !== 'ephemeral') return

  if (cache1hEnabled) {
    cacheControl.ttl = '1h'
  } else {
    delete cacheControl.ttl
  }
}

function applyCache1hTtl(
  parsed: Record<string, unknown>,
  cache1hEnabled: boolean,
) {
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system)
      updateCacheControlTtl(block, cache1hEnabled)
  } else {
    updateCacheControlTtl(parsed.system, cache1hEnabled)
  }

  if (!Array.isArray(parsed.messages)) return

  for (const message of parsed.messages) {
    updateCacheControlTtl(message, cache1hEnabled)
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const block of message.content) {
        updateCacheControlTtl(block, cache1hEnabled)
      }
    }
  }
}

function walkCacheControlTargets(
  parsed: Record<string, unknown>,
  visitor: (target: unknown) => void,
) {
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) visitor(block)
  } else {
    visitor(parsed.system)
  }

  if (!Array.isArray(parsed.messages)) return

  for (const message of parsed.messages) {
    visitor(message)
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const block of message.content) visitor(block)
    }
  }
}

function removeAllCacheControls(parsed: Record<string, unknown>) {
  removeCacheControl(parsed)
  walkCacheControlTargets(parsed, removeCacheControl)
}

function applyAutomaticCache1h(parsed: Record<string, unknown>) {
  removeAllCacheControls(parsed)
  parsed.cache_control = { ...CACHE_1H_CONTROL }
}

function setMessageCacheAnchor(message: unknown) {
  if (!isRecord(message)) return false

  const content = normalizeContentToArray(message.content)
  if (!content?.length) return setWireCacheControl(message, true)

  message.content = content
  const lastCacheableBlock = [...content]
    .reverse()
    .find((block) => isRecord(block) && block.type !== 'thinking')
  return setWireCacheControl(lastCacheableBlock ?? message, true)
}

function messageContentBlockCount(message: unknown) {
  if (!isRecord(message)) return 0
  const content = message.content
  if (Array.isArray(content)) return content.length
  if (content == null) return 0
  return 1
}

function findUserCacheAnchors(messages: unknown[]) {
  const anchors: Array<{ index: number; blockPosition: number }> = []
  let blockPosition = 0

  messages.forEach((message, index) => {
    const blockCount = messageContentBlockCount(message)
    if (isRecord(message) && message.role === 'user' && blockCount > 0) {
      anchors.push({ index, blockPosition: blockPosition + blockCount - 1 })
    }
    blockPosition += blockCount
  })

  return anchors
}

function selectHybridMessageAnchors(messages: unknown[]) {
  const userAnchors = findUserCacheAnchors(messages)
  const latest = [...userAnchors].reverse().find((anchor) => anchor.index > 1)
  if (!latest) return { latest: undefined, bridge: undefined }

  const previous = [...userAnchors]
    .reverse()
    .find((anchor) => anchor.index < latest.index)
  const distanceFromPrevious = previous
    ? latest.blockPosition - previous.blockPosition + 1
    : 0
  const bridge =
    previous &&
    previous.index > 1 &&
    distanceFromPrevious > ANTHROPIC_CACHE_LOOKBACK_BLOCKS
      ? previous
      : undefined

  return { latest, bridge }
}

function setHybridSystemAnchor(parsed: Record<string, unknown>) {
  if (Array.isArray(parsed.system)) {
    const identityIndex = parsed.system.findIndex(
      (block) => isRecord(block) && block.text === CLAUDE_CODE_IDENTITY,
    )
    const cacheableSystemBlocks = parsed.system
      .slice(identityIndex >= 0 ? identityIndex + 1 : 0)
      .filter(isRecord)
    const lastSystemBlock =
      cacheableSystemBlocks[cacheableSystemBlocks.length - 1]
    setWireCacheControl(lastSystemBlock, true)
  } else {
    setWireCacheControl(parsed.system, true)
  }
}

function applyHybridCache1h(parsed: Record<string, unknown>) {
  removeAllCacheControls(parsed)

  if (!Array.isArray(parsed.messages)) {
    setHybridSystemAnchor(parsed)
    return
  }

  const { latest, bridge } = selectHybridMessageAnchors(parsed.messages)

  // Hybrid has only four Anthropic cache slots. Keep the system fallback in
  // normal turns, but spend that slot on the previous user/tool-result boundary
  // when a tool-heavy step pushes the latest user boundary outside Anthropic's
  // 20-block lookback window.
  if (!bridge) setHybridSystemAnchor(parsed)

  setMessageCacheAnchor(parsed.messages[0])
  setMessageCacheAnchor(parsed.messages[1])
  if (bridge) setMessageCacheAnchor(parsed.messages[bridge.index])
  if (latest) setMessageCacheAnchor(parsed.messages[latest.index])
}

function applyCache1hStrategy(
  parsed: Record<string, unknown>,
  options: { enabled: boolean; mode: Cache1hMode },
) {
  if (!options.enabled) {
    applyCache1hTtl(parsed, false)
    delete parsed.cache_control
    delete parsed.cacheControl
    return
  }

  if (options.mode === 'automatic') {
    applyAutomaticCache1h(parsed)
    return
  }

  if (options.mode === 'hybrid') {
    applyHybridCache1h(parsed)
    return
  }

  applyCache1hTtl(parsed, true)
  delete parsed.cacheControl
}

/**
 * Strip trailing assistant messages. Anthropic rejects assistant-message
 * prefill on Claude Code OAuth models with: "This model does not support
 * assistant message prefill. The conversation must end with a user message."
 * A resumed/compacted session can end on an assistant turn (e.g. after a
 * failed tool round); pop those before signing.
 */
function stripTrailingAssistantMessages(parsed: Record<string, unknown>) {
  if (!Array.isArray(parsed.messages)) return
  while (parsed.messages.length) {
    const last = parsed.messages[parsed.messages.length - 1]
    if (!isRecord(last) || last.role !== 'assistant') break
    parsed.messages.pop()
  }
}

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 */
export async function rewriteRequestBody(
  body: string,
  options: {
    cache1hEnabled?: boolean
    cache1hMode?: Cache1hMode
    fastModeEnabled?: boolean
    identity?: ClaudeCodeIdentity
  } = {},
): Promise<string> {
  try {
    const parsed = JSON.parse(body)
    stripTrailingAssistantMessages(parsed)
    const billingHeader =
      Array.isArray(parsed.messages) &&
      parsed.messages.some(
        (message: { role?: string }) => message.role === 'user',
      )
        ? buildBillingHeaderValue(
            parsed.messages,
            undefined,
            CLAUDE_CODE_ENTRYPOINT,
          )
        : null

    // Sanitize system prompt and prepend Claude Code identity
    parsed.system = prependClaudeCodeIdentity(parsed.system)

    // Prepend the billing header as a separate system block so the
    // final layout is: [billing header, identity, ...rest]
    if (billingHeader && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: 'text', text: billingHeader })
    }

    applyCache1hStrategy(parsed, {
      enabled: options.cache1hEnabled ?? false,
      mode: options.cache1hMode ?? 'explicit',
    })

    if (options.fastModeEnabled && isFastModeSupportedModel(parsed.model)) {
      parsed.speed = 'fast'
    } else if (parsed.speed === 'fast') {
      delete parsed.speed
    }

    if (options.identity) applyClaudeCodeMetadata(parsed, options.identity)

    return await signRequestBody(prefixToolNames(parsed))
  } catch {
    return body
  }
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export function createStrippedStream(response: Response): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        const flushed = splitToolPrefixRewriteBuffer(
          `${pending}${decoder.decode()}`,
          true,
        )
        if (flushed.ready) controller.enqueue(encoder.encode(flushed.ready))
        controller.close()
        return
      }

      const text = pending + decoder.decode(value, { stream: true })
      const rewritten = splitToolPrefixRewriteBuffer(text)
      pending = rewritten.pending
      if (rewritten.ready) controller.enqueue(encoder.encode(rewritten.ready))
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
