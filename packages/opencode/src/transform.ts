import { createHash } from 'node:crypto'
import {
  applyClaudeCodeHeaders,
  applyClaudeCodeMetadata,
  applyRunnerTurnNotes,
  applySessionCacheTtl,
  applyThinkingBindingControls,
  applyTurnEndNotes,
  assertNotCustodyTombstone,
  type BillingLineageFields,
  buildBillingHeaderValue,
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
  type ClaudeCodeRequestClass,
  countUserPrompts,
  createSseFramer,
  FAST_MODE_BETA,
  isClaudeFableOrMythos5Model,
  isClaudeHaiku55Model,
  isClaudeOpus5Model,
  isClaudeOpus55Model,
  isClaudeSonnet5Model,
  isClaudeSonnet55Model,
  isFastModeSupportedModel,
  isOpenAIReasoningSignature,
  mergeAnthropicBetas,
  OPENCODE_IDENTITY_PREFIX,
  orderClaudeCodeBody,
  PARAGRAPH_REMOVAL_ANCHORS,
  parseSseFrame,
  REQUIRED_BETAS,
  readSessionCachePolicy,
  remapRequestBodyModel,
  resolveClaudeModelCapabilities,
  SseFrameTooLargeError,
  selectClaudeCodeBetas,
  signRequestBody,
  stripEmptyTrailingAssistantMessages,
  TEXT_REPLACEMENTS,
  type ThinkingPrefixMismatchBehavior,
  TOOL_PREFIX,
  TrailingAssistantHistoryError,
} from '@cortexkit/anthropic-auth-core'
import {
  applyEdits,
  type Edit,
  type Node,
  type ParseError,
  parseTree,
} from 'jsonc-parser'
import {
  applyCacheDiagnosticsOptIn,
  CACHE_DIAGNOSTICS_BETA,
} from './cache-diagnostics'
import {
  applyOpenCodeEffortMarkers,
  EffortMarkerCorrelationError,
  type OpenCodeEffortMarkerPlan,
} from './effort-history'
import { makeByteBoundedMemo } from './sanitize-memo'
import {
  applyServerSideFallbackToBody,
  createServerSideFallbackStreamRewriter,
  SERVER_SIDE_FALLBACK_BETA,
  type ServerSideFallbackOutcome,
} from './server-fallback'

export const NON_STREAMING_DIAGNOSTICS_MAX_BYTES = 8 * 1024 * 1024
/**
 * This plugin prefixes names with mcp_ and uppercases their first character.
 * Tool definitions, outgoing history and response reverse maps must agree.
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

/** Request-local response spellings; null marks a spelling shared by multiple tools. */
export type ToolNameMap = ReadonlyMap<string, string | null> & {
  readonly declaredHostNames: ReadonlySet<string>
  readonly hazardousWireNames: ReadonlySet<string>
}

class UnsafeToolNameResponseError extends Error {
  readonly retryable = false
  readonly isRetryable = false

  constructor() {
    super('Response tool-name mapping could not be validated safely')
    this.name = 'UnsafeToolNameResponseError'
  }
}

function requireSafePassthrough(toolNameMap: ToolNameMap | undefined): void {
  if (toolNameMap?.hazardousWireNames.size)
    throw new UnsafeToolNameResponseError()
}

export function normalizeToolNameResponseError(
  error: unknown,
  toolNameMap?: ToolNameMap,
): unknown {
  // A provider-error reader may hit its SSE frame limit before names can be
  // restored. If sent names also identify different host tools, exposing an
  // unmapped response would let the host select the wrong tool.
  return error instanceof SseFrameTooLargeError &&
    toolNameMap?.hazardousWireNames.size
    ? new UnsafeToolNameResponseError()
    : error
}

export async function cancelUnsafeToolNameResponse(
  reader: {
    cancel(reason?: unknown): Promise<void>
    readonly closed: Promise<void>
    releaseLock(): void
  },
  error: unknown,
): Promise<void> {
  try {
    // Source cancellation hooks may never settle; observe their rejection
    // immediately, but join only the logically closed reader.
    void reader.cancel(error).catch(() => {})
  } catch {}
  try {
    await Promise.allSettled([reader.closed])
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
}

function responseToolNames(tools: unknown): ToolNameMap {
  const names = new Set<string>()
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (isRecord(tool) && typeof tool.name === 'string' && tool.name) {
        names.add(tool.name)
      }
    }
  }
  const aliases = new Map<string, string | null>()
  const add = (
    map: Map<string, string | null>,
    alias: string,
    name: string,
  ) => {
    map.set(alias, map.has(alias) && map.get(alias) !== name ? null : name)
  }
  const wireNames = new Map<string, string | null>()
  for (const name of names) {
    // A guessed suffix like Search can mean aft_search only if no other
    // declared tool, such as ctx_search, shares that suffix.
    const parts = name.split('_')
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join('_')
      if (!suffix) continue
      for (const variant of new Set([
        suffix,
        unprefixName(suffix),
        suffix.charAt(0).toUpperCase() + suffix.slice(1),
      ])) {
        add(aliases, variant, name)
        add(aliases, `${TOOL_PREFIX}${variant}`, name)
      }
    }
    add(wireNames, prefixName(name), name)
  }
  // Anthropic sees the emitted wire names, so they outrank original host
  // spellings as well as inferred suffixes, including ambiguous wire names.
  for (const name of names) aliases.set(name, name)
  for (const [wire, name] of wireNames) aliases.set(wire, name)
  return Object.assign(aliases, {
    declaredHostNames: names,
    hazardousWireNames: new Set(
      [...wireNames.keys()].filter((wire) => names.has(wire)),
    ),
  })
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
    requestClass?: ClaudeCodeRequestClass
  } = {},
): Headers {
  // This is the shared boundary where an access value becomes a bearer header.
  assertNotCustodyTombstone(accessToken, 'anthropic')
  return applyClaudeCodeHeaders(headers, accessToken, {
    ...options,
    extraBetas: [
      ...(options.body?.fallbacks === 'default'
        ? [SERVER_SIDE_FALLBACK_BETA]
        : []),
    ],
  })
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

  const toolChoice = parsed.tool_choice
  if (
    isRecord(toolChoice) &&
    toolChoice.type === 'tool' &&
    typeof toolChoice.name === 'string'
  ) {
    parsed.tool_choice = { ...toolChoice, name: prefixName(toolChoice.name) }
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
 * Use the map supplied to onToolNameMap by rewriteRequestBody for this response's request.
 * Unmatched or ambiguous names stay unchanged for the host to handle.
 */
export function stripToolPrefix(
  text: string,
  toolNameMap?: ToolNameMap,
): string {
  return applyEdits(text, toolNameEdits(text, toolNameMap, false))
}

function jsonMember(node: Node | undefined, key: string): Node | undefined {
  if (node?.type !== 'object') return undefined
  const matches = node.children?.filter(
    (property) => property.children?.[0]?.value === key,
  )
  // The host uses JSON.parse, so only the last property with this key routes a call.
  return matches?.at(-1)?.children?.[1]
}

function toolNameEdits(
  text: string,
  toolNameMap: ToolNameMap | undefined,
  event: boolean,
  routeAllowed = true,
): Edit[] {
  if (!toolNameMap?.size) return []
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const errors: ParseError[] = []
  let root: Node | undefined
  try {
    root = parseTree(text.slice(bom), errors, {
      disallowComments: true,
      allowTrailingComma: false,
    })
  } catch {
    requireSafePassthrough(toolNameMap)
    return []
  }
  if (errors.length || root?.type !== 'object') {
    requireSafePassthrough(toolNameMap)
    return []
  }
  const type = jsonMember(root, 'type')?.value
  let blocks: Node[]
  if (event) {
    routeAllowed &&= type === 'content_block_start'
    const block = jsonMember(root, 'content_block')
    blocks = block ? [block] : []
  } else {
    routeAllowed &&= type === undefined || type === 'message'
    const content = jsonMember(root, 'content')
    blocks = content?.type === 'array' ? (content.children ?? []) : []
  }
  const edits: Edit[] = []
  for (const block of blocks) {
    if (jsonMember(block, 'type')?.value !== 'tool_use') continue
    const name = jsonMember(block, 'name')
    if (name?.type !== 'string') continue
    const realName = toolNameMap.get(name.value)
    if (
      toolNameMap.hazardousWireNames.has(name.value) &&
      (!routeAllowed || realName === null)
    ) {
      throw new UnsafeToolNameResponseError()
    }
    if (!routeAllowed) continue
    if (realName && realName !== name.value) {
      edits.push({
        offset: bom + name.offset,
        length: name.length,
        content: JSON.stringify(realName),
      })
    }
  }
  return edits
}

function rewriteToolNameFrame(frame: string, toolNameMap: ToolNameMap): string {
  const bom = frame.charCodeAt(0) === 0xfeff ? 1 : 0
  const event = parseSseFrame(frame.slice(bom))
  if (event.data === undefined) return frame
  const edits = toolNameEdits(
    event.data,
    toolNameMap,
    true,
    event.event === undefined || event.event === 'content_block_start',
  )
  if (!edits.length) return frame
  // SSE joins data lines with newlines. Map JSON token offsets back to their
  // original lines so comments, IDs, whitespace and line endings stay intact.
  const spans: { dataOffset: number; frameOffset: number; length: number }[] =
    []
  let dataOffset = 0
  for (const line of frame.slice(bom).matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)) {
    const value = /^data(?:: ?(.*))?$/.exec(line[1] ?? '')
    if (!value) continue
    const length = value[1]?.length ?? 0
    spans.push({
      dataOffset,
      frameOffset: bom + (line.index ?? 0) + value[0].length - length,
      length,
    })
    dataOffset += length + 1
  }
  const frameEdits: Edit[] = []
  for (const edit of edits) {
    const span = spans.find(
      (span) =>
        edit.offset >= span.dataOffset &&
        edit.offset + edit.length <= span.dataOffset + span.length,
    )
    if (!span) {
      requireSafePassthrough(toolNameMap)
      return frame
    }
    frameEdits.push({
      ...edit,
      offset: span.frameOffset + edit.offset - span.dataOffset,
    })
  }
  return applyEdits(frame, frameEdits)
}

function createToolNameRewriter(
  toolNameMap: ToolNameMap | undefined,
  jsonMode: boolean,
) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const framer = createSseFramer({
    maxFrameBytes: NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
  })
  let pending = ''
  let pendingBytes = 0
  let disabled = !toolNameMap?.size
  return {
    pendingLength: () => pending.length,
    push(text: string, flush = false): string {
      if (disabled || !toolNameMap) return text
      const combined = pending + text
      if (jsonMode) {
        pendingBytes += encoder.encode(text).byteLength
        if (pendingBytes > NON_STREAMING_DIAGNOSTICS_MAX_BYTES) {
          // Bound retained data. Passthrough is safe only when an unrewritten
          // wire name cannot select a different declared host tool.
          disabled = true
          pending = ''
          requireSafePassthrough(toolNameMap)
          return combined
        }
        pending = flush ? '' : combined
        return flush ? stripToolPrefix(combined, toolNameMap) : ''
      }
      let frames: Uint8Array[]
      try {
        frames = framer.push(encoder.encode(text))
      } catch (error) {
        if (!(error instanceof SseFrameTooLargeError)) throw error
        // The framer drops an oversized frame on failure. Keep its original
        // bytes only when passthrough cannot invoke another declared tool.
        disabled = true
        pending = ''
        requireSafePassthrough(toolNameMap)
        return combined
      }
      const decoded = frames.map((frame) => decoder.decode(frame))
      pending = combined.slice(
        decoded.reduce((length, frame) => length + frame.length, 0),
      )
      if (flush) {
        const tail = framer.finish()
        if (tail) decoded.push(decoder.decode(tail))
        pending = ''
      }
      return decoded
        .map((frame) => rewriteToolNameFrame(frame, toolNameMap))
        .join('')
    },
  }
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
function parseBaseUrl(raw: string | undefined): URL | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const baseUrl = new URL(value)
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

function resolveBaseUrl(): URL | null {
  return parseBaseUrl(process.env.ANTHROPIC_BASE_URL)
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 * Returns the modified input and URL (if applicable).
 */
export function rewriteUrl(
  input: FetchInput,
  options: { baseURL?: string } = {},
): {
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

  const baseUrl = options.baseURL
    ? parseBaseUrl(options.baseURL)
    : resolveBaseUrl()
  if (baseUrl) {
    const basePath = baseUrl.pathname.replace(/\/$/, '')
    const inputPath = requestUrl.pathname
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host

    const alreadyUnderBase =
      inputPath === basePath ||
      (basePath !== '' && inputPath.startsWith(`${basePath}/`))
    if (!alreadyUnderBase) {
      const baseEndsInVersion = /\/v\d[^/]*$/.test(basePath)
      if (inputPath === '/messages') {
        requestUrl.pathname = baseEndsInVersion
          ? `${basePath}/messages`
          : `${basePath}/v1/messages`
      } else if (inputPath === '/v1/messages' && baseEndsInVersion) {
        requestUrl.pathname = `${basePath}/messages`
      } else {
        requestUrl.pathname = `${basePath}${inputPath}`
      }
    } else if (inputPath === `${basePath}/messages`) {
      // Repair only the exact SDK form under a non-versioned base. Do not
      // rewrite sibling resources or explicit /v2 (and later) proxy paths.
      if (!/\/v\d[^/]*$/.test(basePath)) {
        requestUrl.pathname = `${basePath}/v1/messages`
      }
    }
  }

  if (
    requestUrl.pathname.endsWith('/v1/messages') &&
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
function _sanitizeSystemText(text: string): string {
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

const SANITIZE_MEMO_MAX_BYTES = 8 * 1024 * 1024

/** Memo on by default; OPENCODE_ANTHROPIC_AUTH_MEMO=0 disables (baseline). */
function sanitizeMemoEnabled(): boolean {
  return process.env.OPENCODE_ANTHROPIC_AUTH_MEMO !== '0'
}

const sanitizeSystemMemo = makeByteBoundedMemo(_sanitizeSystemText, {
  maxBytes: SANITIZE_MEMO_MAX_BYTES,
  enabled: sanitizeMemoEnabled,
})

/**
 * Sanitize a system-prompt block. Memoised: the prompt is stable within a
 * session, so the paragraph-filter + regex pass is skipped on cache hits.
 */
export function sanitizeSystemText(text: string): string {
  return sanitizeSystemMemo.call(text)
}

export function getSanitizeMemoStats() {
  return sanitizeSystemMemo.stats()
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

export type HybridMessageCacheAnchor = {
  fingerprint: string
  messageIndex: number
  messageCount: number
}

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

function normalizeCacheFingerprintValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeCacheFingerprintValue)
  }
  if (!isRecord(value)) return value

  const normalized: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (key === 'cache_control' || key === 'cacheControl') continue
    normalized[key] = normalizeCacheFingerprintValue(value[key])
  }
  return normalized
}

function cacheAnchorMessageFingerprint(message: unknown) {
  if (!isRecord(message)) return undefined
  const content = normalizeContentToArray(message.content)
  if (!content?.length) return undefined
  const normalized = normalizeCacheFingerprintValue({
    ...message,
    content,
  })
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function messageHasWireCacheAnchor(message: unknown) {
  if (!isRecord(message)) return false
  const content = normalizeContentToArray(message.content)
  return Boolean(
    content?.some(
      (block) =>
        isRecord(block) && getCacheControl(block)?.type === 'ephemeral',
    ),
  )
}

export function extractLatestHybridMessageCacheAnchor(
  bodyText: string,
): HybridMessageCacheAnchor | undefined {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    if (!Array.isArray(parsed.messages)) return undefined

    for (let index = parsed.messages.length - 1; index > 1; index--) {
      const message = parsed.messages[index]
      if (
        !isRecord(message) ||
        message.role !== 'user' ||
        !messageHasWireCacheAnchor(message)
      ) {
        continue
      }
      const fingerprint = cacheAnchorMessageFingerprint(message)
      if (!fingerprint) return undefined
      return {
        fingerprint,
        messageIndex: index,
        messageCount: parsed.messages.length,
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Fingerprints of every user message carrying a wire cache anchor, in
 * history order. A recovery-round source warm stays valid while the kept
 * request's earliest anchored message is still among them: compaction or a
 * history edit drops or rewrites that message, while later turns only append
 * after it. Membership (not position) is compared so an extra bridge anchor
 * on a longer history does not count as a prefix change.
 */
export function hybridUserMessageCacheAnchorFingerprints(
  bodyText: string,
): string[] {
  try {
    const parsed = JSON.parse(bodyText) as Record<string, unknown>
    if (!Array.isArray(parsed.messages)) return []
    const fingerprints: string[] = []
    for (const message of parsed.messages) {
      if (
        !isRecord(message) ||
        message.role !== 'user' ||
        !messageHasWireCacheAnchor(message)
      ) {
        continue
      }
      const fingerprint = cacheAnchorMessageFingerprint(message)
      if (fingerprint) fingerprints.push(fingerprint)
    }
    return fingerprints
  } catch {
    return []
  }
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
  walkCacheControlTargets(parsed, (target) =>
    updateCacheControlTtl(target, cache1hEnabled),
  )
}

function walkCacheControlTargets(
  parsed: Record<string, unknown>,
  visitor: (target: unknown) => void,
) {
  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) visitor(tool)
  }

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

function isCacheableContentBlock(block: unknown) {
  return (
    isRecord(block) &&
    block.type !== 'thinking' &&
    block.type !== 'redacted_thinking'
  )
}

function getCacheableContentBlocks(message: Record<string, unknown>) {
  // cache_control is only valid on content blocks, never on the message
  // object itself. A message with no cacheable content block (empty content,
  // or only thinking/redacted_thinking blocks) must be skipped entirely;
  // attaching cache_control to the message triggers Anthropic's
  // "messages.N.cache_control: Extra inputs are not permitted" 400.
  const content = normalizeContentToArray(message.content)
  if (!content?.length) return undefined

  const cacheableBlocks = content.filter(isCacheableContentBlock)
  if (!cacheableBlocks.length) return undefined

  return { content, cacheableBlocks }
}

function setSplitPrefixMessageCacheAnchors(message: unknown) {
  if (!isRecord(message)) return false
  const cacheableContent = getCacheableContentBlocks(message)
  if (!cacheableContent || cacheableContent.cacheableBlocks.length < 2) {
    return false
  }

  const [base, image, history] = cacheableContent.content
  // Magic Context's optional mural adds an image to the stable prefix. Anchor
  // its end and the adjacent history text, whose contents may be any delta or
  // placeholder. Require the complete wire layout rather than scanning past a
  // missing block into a live turn or inspecting the image payload.
  const hasMuralPrefix =
    message.role === 'user' &&
    isRecord(base) &&
    base.type === 'text' &&
    typeof base.text === 'string' &&
    isRecord(image) &&
    image.type === 'image' &&
    isRecord(history) &&
    history.type === 'text' &&
    typeof history.text === 'string' &&
    /<memory-mural>[\s\S]*?<\/memory-mural>/.test(base.text)
  const anchors = hasMuralPrefix
    ? [image, history]
    : cacheableContent.cacheableBlocks.slice(0, 2)

  // Only materialize the normalized content array once we know we will anchor.
  message.content = cacheableContent.content
  for (const block of anchors) setWireCacheControl(block, true)
  return true
}

function setMessageCacheAnchor(message: unknown) {
  if (!isRecord(message)) return false
  const cacheableContent = getCacheableContentBlocks(message)
  if (!cacheableContent) return false

  const lastCacheableBlock =
    cacheableContent.cacheableBlocks[
      cacheableContent.cacheableBlocks.length - 1
    ]

  // Only materialize the normalized content array once we know we will anchor.
  message.content = cacheableContent.content
  return setWireCacheControl(lastCacheableBlock, true)
}

function messageContentBlockCount(message: unknown) {
  if (!isRecord(message)) return 0
  const content = message.content
  if (Array.isArray(content)) return content.length
  if (content == null) return 0
  // A turn-end note has string content: it consumes one lookback block, even
  // though hybrid anchors are placed on user boundaries, never on the note.
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

function findStandbyHybridAnchor(
  messages: unknown[],
  userAnchors: Array<{ index: number; blockPosition: number }>,
  latest: { index: number; blockPosition: number },
  standbyAnchor: HybridMessageCacheAnchor | undefined,
) {
  if (!standbyAnchor) return undefined

  const candidates: Array<{ index: number; blockPosition: number }> = []
  const hinted = userAnchors.find(
    (anchor) =>
      anchor.index === standbyAnchor.messageIndex &&
      anchor.index > 1 &&
      anchor.index < latest.index,
  )
  if (hinted) candidates.push(hinted)
  for (const anchor of [...userAnchors].reverse()) {
    if (
      anchor.index <= 1 ||
      anchor.index >= latest.index ||
      anchor.index === hinted?.index
    ) {
      continue
    }
    candidates.push(anchor)
  }

  for (const anchor of candidates) {
    if (
      cacheAnchorMessageFingerprint(messages[anchor.index]) ===
      standbyAnchor.fingerprint
    ) {
      return anchor
    }
  }
  return undefined
}

function selectHybridMessageAnchors(
  messages: unknown[],
  standbyAnchor?: HybridMessageCacheAnchor,
) {
  const userAnchors = findUserCacheAnchors(messages)
  const latest = [...userAnchors].reverse().find((anchor) => anchor.index > 1)
  if (!latest) {
    return {
      latest: undefined,
      bridge: undefined,
      standbyAnchorMatched: false,
      standbyBridgeApplied: false,
    }
  }

  const standby = findStandbyHybridAnchor(
    messages,
    userAnchors,
    latest,
    standbyAnchor,
  )
  const standbyDistanceBlocks = standby
    ? latest.blockPosition - standby.blockPosition + 1
    : undefined
  const standbyBridge =
    standby &&
    standbyDistanceBlocks != null &&
    standbyDistanceBlocks > ANTHROPIC_CACHE_LOOKBACK_BLOCKS
      ? standby
      : undefined

  const previous = [...userAnchors]
    .reverse()
    .find((anchor) => anchor.index < latest.index)
  const distanceFromPrevious = previous
    ? latest.blockPosition - previous.blockPosition + 1
    : 0
  const lookbackBridge =
    previous &&
    previous.index > 1 &&
    distanceFromPrevious > ANTHROPIC_CACHE_LOOKBACK_BLOCKS
      ? previous
      : undefined

  return {
    latest,
    bridge: standbyBridge ?? lookbackBridge,
    standbyAnchorMatched: Boolean(standby),
    standbyDistanceBlocks,
    standbyBridgeApplied: Boolean(standbyBridge),
  }
}

function systemBlockText(block: unknown) {
  return isRecord(block) && typeof block.text === 'string' ? block.text : ''
}

function coalesceHybridSystemTail(parsed: Record<string, unknown>) {
  if (!Array.isArray(parsed.system)) return

  const system = parsed.system
  let prefixCount = 0
  if (
    systemBlockText(system[prefixCount]).startsWith(
      'x-anthropic-billing-header:',
    )
  ) {
    prefixCount++
  }
  if (systemBlockText(system[prefixCount]) === CLAUDE_CODE_IDENTITY) {
    prefixCount++
  }

  // Preserve the primary OpenCode/system prompt block, but canonicalize all
  // subsequent plugin-added instruction blocks into one block before placing the
  // hybrid system cache anchor. OpenCode normally does this in request prep, but
  // skips it if a hook changes the first system entry. Without this downstream
  // normalization, byte-identical system text can flip between merged/split block
  // layouts and move the cache_control breakpoint.
  const tailStart = prefixCount + 1
  if (tailStart >= system.length - 1) return

  const firstTail = system[tailStart]
  if (!isRecord(firstTail)) return

  const mergedTail = system.slice(tailStart).map(systemBlockText).join('\n')
  system.splice(tailStart, system.length - tailStart, {
    ...firstTail,
    type: 'text',
    text: mergedTail,
  })
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

function applyHybridCache1h(
  parsed: Record<string, unknown>,
  standbyAnchor?: HybridMessageCacheAnchor,
) {
  removeAllCacheControls(parsed)
  coalesceHybridSystemTail(parsed)

  if (!Array.isArray(parsed.messages)) {
    setHybridSystemAnchor(parsed)
    return {
      standbyAnchorMatched: false,
      standbyBridgeApplied: false,
    }
  }

  const {
    latest,
    bridge,
    standbyAnchorMatched,
    standbyDistanceBlocks,
    standbyBridgeApplied,
  } = selectHybridMessageAnchors(parsed.messages, standbyAnchor)

  // Hybrid has only four Anthropic cache slots. Keep the system fallback in
  // normal turns, but spend that slot on a previous user/tool-result boundary
  // when a tool-heavy step exceeds Anthropic's 20-block lookback or when a
  // model-specific standby cache (Opus during healthy Fable turns) must bridge
  // from its last known tail to the current request.
  if (!bridge) setHybridSystemAnchor(parsed)

  // OpenCode can merge Magic Context's base context, history and current user
  // into one message. Cache the two context boundaries, not the current user
  // text, which changes each turn.
  if (!setSplitPrefixMessageCacheAnchors(parsed.messages[0])) {
    setMessageCacheAnchor(parsed.messages[0])
    setMessageCacheAnchor(parsed.messages[1])
  }
  if (bridge) setMessageCacheAnchor(parsed.messages[bridge.index])
  if (latest) setMessageCacheAnchor(parsed.messages[latest.index])

  return {
    standbyAnchorMatched,
    standbyDistanceBlocks,
    standbyBridgeApplied,
    ...(standbyBridgeApplied && bridge
      ? { standbyBridgeMessageIndex: bridge.index }
      : {}),
  }
}

function stripNonAnthropicThinkingBlocks(parsed: Record<string, unknown>) {
  if (!Array.isArray(parsed.messages)) return 0

  let removed = 0
  parsed.messages = parsed.messages.filter((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return true
    if (message.role !== 'assistant') return true

    const filtered = message.content.filter((block) => {
      if (!isRecord(block) || block.type !== 'thinking') return true
      if (!isOpenAIReasoningSignature(block.signature)) return true
      removed += 1
      return false
    })

    if (filtered.length === message.content.length) return true
    message.content = filtered
    return filtered.length > 0
  })

  return removed
}

function removeUnsupportedForcedToolChoice(parsed: Record<string, unknown>) {
  const toolChoice = parsed.tool_choice
  if (
    isRecord(toolChoice) &&
    (toolChoice.type === 'any' || toolChoice.type === 'tool')
  ) {
    delete parsed.tool_choice
  }
}

function normalizeFableMythosRequest(
  parsed: Record<string, unknown>,
): { replacedExisting: boolean } | null {
  if (!isClaudeFableOrMythos5Model(parsed.model)) return null
  const hadThinking = Object.hasOwn(parsed, 'thinking')
  parsed.thinking = { ...CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING }
  if (resolveClaudeModelCapabilities(parsed.model)?.rejectsForcedToolChoice) {
    removeUnsupportedForcedToolChoice(parsed)
  }
  return { replacedExisting: hadThinking }
}

/**
 * Sonnet 5 accepts disabled thinking, but Sonnet 5.5 instead requires the
 * bare between_tools mode for an explicit opt-out (at effort high or below).
 * Neither model returns readable thinking by default. Request summaries so
 * the host can display adaptive reasoning.
 */
function normalizeSonnet5FamilyRequest(parsed: Record<string, unknown>): {
  replacedExisting: boolean
  display: 'summarized' | 'disabled' | 'between_tools'
} | null {
  if (isClaudeSonnet55Model(parsed.model)) {
    removeUnsupportedForcedToolChoice(parsed)
    const hadThinking = Object.hasOwn(parsed, 'thinking')
    const thinking = parsed.thinking
    if (
      isRecord(thinking) &&
      (thinking.type === 'disabled' || thinking.type === 'between_tools')
    ) {
      // Sonnet 5.5 rejects `disabled`. Convert either opt-out to bare
      // `between_tools`, which rejects display and block_binding fields,
      // and cap unsupported xhigh/max effort at high.
      parsed.thinking = { type: 'between_tools' }
      const outputConfig = parsed.output_config
      if (
        isRecord(outputConfig) &&
        (outputConfig.effort === 'xhigh' || outputConfig.effort === 'max')
      ) {
        outputConfig.effort = 'high'
      }
      return { replacedExisting: hadThinking, display: 'between_tools' }
    }
    parsed.thinking = { ...CLAUDE_SONNET_5_5_ADAPTIVE_THINKING }
    return { replacedExisting: hadThinking, display: 'summarized' }
  }
  if (!isClaudeSonnet5Model(parsed.model)) return null
  const hadThinking = Object.hasOwn(parsed, 'thinking')
  const thinking = parsed.thinking
  if (isRecord(thinking) && thinking.type === 'disabled') {
    parsed.thinking = { type: 'disabled' }
    return { replacedExisting: hadThinking, display: 'disabled' }
  }
  parsed.thinking = { ...CLAUDE_SONNET_5_ADAPTIVE_THINKING }
  return { replacedExisting: hadThinking, display: 'summarized' }
}

/**
 * Opus 5 mirrors Sonnet 5: adaptive thinking on by default with
 * `display: "omitted"`, so the synthesized request must inject a summarized
 * shape to be visible. Unlike Fable/Mythos (which reject a disable), Opus 5
 * accepts `{type:"disabled"}` — but only at effort `high` or below; pairing
 * `disabled` with `output_config.effort` of `xhigh` or `max` 400s server-side
 * per request. The user's intent to disable thinking wins over their effort
 * setting, so when both are present we rewrite `effort` down to `high` to
 * satisfy the API contract. When thinking is enabled (or absent), the effort
 * value is left untouched — only the disable pair is constrained.
 */
function normalizeOpus5Request(
  parsed: Record<string, unknown>,
): { replacedExisting: boolean; display: 'summarized' | 'disabled' } | null {
  if (isClaudeOpus55Model(parsed.model)) {
    // Opus 5.5 rejects forced tool choice, including OpenCode's
    // `required` setting for its StructuredOutput tool.
    removeUnsupportedForcedToolChoice(parsed)
    // Opus 5.5 has adaptive thinking ALWAYS ON: setting `type: "disabled"` or manual
    // `budget_tokens` returns a 400 invalid_request_error. Rewrite to adaptive summarized.
    const hadThinking = Object.hasOwn(parsed, 'thinking')
    parsed.thinking = { ...CLAUDE_OPUS_5_5_ADAPTIVE_THINKING }
    return { replacedExisting: hadThinking, display: 'summarized' }
  }
  if (!isClaudeOpus5Model(parsed.model)) return null
  const hadThinking = Object.hasOwn(parsed, 'thinking')
  const thinking = parsed.thinking
  if (isRecord(thinking) && thinking.type === 'disabled') {
    parsed.thinking = { type: 'disabled' }
    const outputConfig = parsed.output_config
    if (isRecord(outputConfig) && outputConfig.effort === 'xhigh') {
      outputConfig.effort = 'high'
    } else if (isRecord(outputConfig) && outputConfig.effort === 'max') {
      outputConfig.effort = 'high'
    }
    return { replacedExisting: hadThinking, display: 'disabled' }
  }
  parsed.thinking = { ...CLAUDE_OPUS_5_ADAPTIVE_THINKING }
  return { replacedExisting: hadThinking, display: 'summarized' }
}

/** Haiku 5.5 accepts forced tool choice, but not manual thinking or sampling overrides. */
function normalizeHaiku55Request(
  parsed: Record<string, unknown>,
): { replacedExisting: boolean; display: 'summarized' | 'disabled' } | null {
  if (!isClaudeHaiku55Model(parsed.model)) return null
  delete parsed.temperature
  delete parsed.top_p
  delete parsed.top_k
  const hadThinking = Object.hasOwn(parsed, 'thinking')
  if (isRecord(parsed.thinking) && parsed.thinking.type === 'disabled') {
    parsed.thinking = { type: 'disabled' }
    const outputConfig = parsed.output_config
    // Keep thinking disabled, but lower xhigh/max effort to high because
    // Haiku rejects those effort levels when thinking is disabled.
    if (
      isRecord(outputConfig) &&
      (outputConfig.effort === 'xhigh' || outputConfig.effort === 'max')
    ) {
      outputConfig.effort = 'high'
    }
    return { replacedExisting: hadThinking, display: 'disabled' }
  }
  parsed.thinking = { ...CLAUDE_HAIKU_5_5_ADAPTIVE_THINKING }
  return { replacedExisting: hadThinking, display: 'summarized' }
}

function applyCache1hStrategy(
  parsed: Record<string, unknown>,
  options: {
    enabled: boolean
    mode: Cache1hMode
    hybridStandbyAnchor?: HybridMessageCacheAnchor
  },
) {
  if (!options.enabled) {
    applyCache1hTtl(parsed, false)
    delete parsed.cache_control
    delete parsed.cacheControl
    return {}
  }

  if (options.mode === 'automatic') {
    applyAutomaticCache1h(parsed)
    return {}
  }

  if (options.mode === 'hybrid') {
    return applyHybridCache1h(parsed, options.hybridStandbyAnchor)
  }

  applyCache1hTtl(parsed, true)
  delete parsed.cacheControl
  const marked: Record<string, unknown>[] = []
  walkCacheControlTargets(parsed, (target) => {
    if (isRecord(target) && getCacheControl(target)) marked.push(target)
  })
  if (isRecord(parsed.cache_control)) {
    updateCacheControlTtl(parsed, true)
    marked.push(parsed)
  }
  // Later breakpoints also cover earlier prefixes, so retain the last four
  // when a host supplies more markers than Anthropic accepts.
  for (const target of marked.slice(0, -4)) removeCacheControl(target)
  return {}
}

/**
 * Anthropic can classify whitespace-only text after the latest assistant
 * tool_use as assistant prefill on a later tool continuation, even when the
 * request ends with a user tool_result message. Preserve older turns and
 * meaningful text to avoid unnecessary prompt-cache churn.
 */
function stripLatestAssistantToolUseTrailingWhitespace(
  parsed: Record<string, unknown>,
) {
  if (!Array.isArray(parsed.messages)) return 0

  for (let index = parsed.messages.length - 1; index >= 0; index--) {
    const message = parsed.messages[index]
    if (!isRecord(message) || message.role !== 'assistant') continue
    if (!Array.isArray(message.content)) return 0
    if (
      !message.content.some(
        (block) => isRecord(block) && block.type === 'tool_use',
      )
    ) {
      return 0
    }

    let removedBlocks = 0
    while (message.content.length) {
      const block = message.content[message.content.length - 1]
      if (
        !isRecord(block) ||
        block.type !== 'text' ||
        typeof block.text !== 'string' ||
        !Object.keys(block).every(
          (key) => key === 'type' || key === 'text' || key === 'cache_control',
        ) ||
        block.text.trim()
      ) {
        break
      }
      message.content.pop()
      removedBlocks++
    }
    return removedBlocks
  }

  return 0
}

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 */
type RewritePerfCallback = (
  stage: string,
  data?: Record<string, unknown>,
) => void

export const CC_VERSION_SUFFIX_SESSION_LIMIT = 1_000
const firstUserTextTracker = new ClaudeCodeFirstUserTextTracker(
  CC_VERSION_SUFFIX_SESSION_LIMIT,
)

export function resetPinnedFirstUserTextsForTest() {
  firstUserTextTracker.clear()
}

export function hasPinnedFirstUserTextForTest(sessionId: string) {
  return firstUserTextTracker.has(sessionId)
}

function firstUserTextForSession(
  sessionId: string,
  messages: Parameters<typeof buildBillingHeaderValue>[0],
  laneStart: boolean,
): string {
  return firstUserTextTracker.resolve(sessionId, messages, !laneStart)
}

function rewriteNowMs() {
  return performance.now()
}

function rewriteRoundMs(value: number) {
  return Math.round(value * 10) / 10
}

function countRewriteShape(parsed: Record<string, unknown>) {
  let messageCount = 0
  let contentBlockCount = 0
  let toolUseCount = 0
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  messageCount = messages.length
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    contentBlockCount += content.length
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'tool_use'
      ) {
        toolUseCount++
      }
    }
  }
  return {
    messageCount,
    contentBlockCount,
    toolDefinitionCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    toolUseCount,
    systemBlockCount: Array.isArray(parsed.system) ? parsed.system.length : 0,
  }
}

export async function rewriteRequestBody(
  body: string,
  options: {
    cache1hEnabled?: boolean
    cache1hMode?: Cache1hMode
    fastModeEnabled?: boolean
    /** Leave the billing signature placeholder for the transport to finalize. */
    deferSigning?: boolean
    identity?: ClaudeCodeIdentity
    sessionId?: string
    /** Raw model id supplied by the host, not the wire body model. */
    modelId?: string
    /** Whether this request uses OAuth. */
    isOAuth?: boolean
    thinkingPrefixMismatchBehavior?: ThinkingPrefixMismatchBehavior
    midConversationEffortEnabled?: boolean
    midConversationEffortPlan?: string
    midConversationEffortResolvedPlan?: OpenCodeEffortMarkerPlan
    // Every recorded plan version for the resolved plan's user message.
    midConversationEffortPlanVersions?: readonly OpenCodeEffortMarkerPlan[]
    turnEndNoteEnabled?: boolean
    turnEndNote?: { tools: string[] }
    perf?: RewritePerfCallback
    hybridStandbyAnchor?: HybridMessageCacheAnchor
    serverSideFallbackEnabled?: boolean
    modelRemapEnabled?: boolean
    laneStart?: boolean
    billingLineage?: BillingLineageFields
    cacheDiagnosticsPreviousMessageId?: string | null
    onToolNameMap?: (map: ToolNameMap) => void
  } = {},
): Promise<string> {
  try {
    const parseStart = rewriteNowMs()
    const parsed = JSON.parse(body)
    options.perf?.('parse', {
      ms: rewriteRoundMs(rewriteNowMs() - parseStart),
      inputBytes: body.length,
      ...countRewriteShape(parsed),
    })

    const trailingStart = rewriteNowMs()
    const messagesBeforeStrip = Array.isArray(parsed.messages)
      ? parsed.messages.length
      : undefined
    stripEmptyTrailingAssistantMessages(parsed.messages)
    const removedWhitespaceBlocks =
      stripLatestAssistantToolUseTrailingWhitespace(parsed)
    const messagesAfterStrip = Array.isArray(parsed.messages)
      ? parsed.messages.length
      : undefined
    options.perf?.('strip_trailing_assistant', {
      ms: rewriteRoundMs(rewriteNowMs() - trailingStart),
      removedMessages:
        typeof messagesBeforeStrip === 'number' &&
        typeof messagesAfterStrip === 'number'
          ? messagesBeforeStrip - messagesAfterStrip
          : undefined,
      removedWhitespaceBlocks,
    })

    const modelNormalizeStart = rewriteNowMs()
    const removedNonAnthropicThinking = stripNonAnthropicThinkingBlocks(parsed)
    const serverSideFallback = applyServerSideFallbackToBody(
      parsed,
      options.serverSideFallbackEnabled === true,
    )
    const fableMythosThinking = normalizeFableMythosRequest(parsed)
    const sonnet5Thinking = normalizeSonnet5FamilyRequest(parsed)
    const opus5Thinking = normalizeOpus5Request(parsed)
    const haiku55Thinking = normalizeHaiku55Request(parsed)
    options.perf?.('model_normalize', {
      ms: rewriteRoundMs(rewriteNowMs() - modelNormalizeStart),
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      fableMythosThinkingDisplay: fableMythosThinking
        ? 'summarized'
        : undefined,
      replacedFableMythosThinking:
        fableMythosThinking?.replacedExisting ?? false,
      sonnet5ThinkingDisplay: sonnet5Thinking?.display,
      replacedSonnet5Thinking: sonnet5Thinking?.replacedExisting ?? false,
      opus5ThinkingDisplay: opus5Thinking?.display,
      replacedOpus5Thinking: opus5Thinking?.replacedExisting ?? false,
      haiku55ThinkingDisplay: haiku55Thinking?.display,
      replacedHaiku55Thinking: haiku55Thinking?.replacedExisting ?? false,
      removedNonAnthropicThinking,
      serverSideFallbackEnabled: serverSideFallback.enabled,
      serverFallbackMarkersRestored: serverSideFallback.restoredMarkers,
      serverFallbackMarkersDropped: serverSideFallback.droppedMarkers,
      hasOutputConfig: Object.hasOwn(parsed, 'output_config'),
    })

    if (options.laneStart === true) {
      parsed.max_tokens = 1
      delete parsed.thinking
    }

    applyOpenCodeEffortMarkers(
      parsed,
      options.midConversationEffortEnabled === true,
      options.midConversationEffortPlan,
      options.midConversationEffortResolvedPlan,
      options.midConversationEffortPlanVersions,
    )
    applyThinkingBindingControls(
      parsed,
      options.thinkingPrefixMismatchBehavior ?? 'account-default',
    )
    if (options.turnEndNoteEnabled) {
      // History still carries host tool names here, before mcp_ wire prefixing.
      applyTurnEndNotes(parsed, { tools: options.turnEndNote?.tools })
    }
    applyRunnerTurnNotes(parsed, {
      sessionId: options.sessionId,
      modelId: options.modelId ?? '',
      isOAuth: options.isOAuth === true,
    })

    const billingStart = rewriteNowMs()
    const billingHeader =
      Array.isArray(parsed.messages) &&
      parsed.messages.some(
        (message: { role?: string }) => message.role === 'user',
      )
        ? buildBillingHeaderValue(
            parsed.messages,
            undefined,
            CLAUDE_CODE_ENTRYPOINT,
            options.sessionId
              ? firstUserTextForSession(
                  options.sessionId,
                  parsed.messages,
                  options.laneStart === true,
                )
              : undefined,
            options.billingLineage?.promptId
              ? {
                  ...options.billingLineage,
                  promptIndex:
                    options.billingLineage.promptIndex ??
                    countUserPrompts(parsed.messages),
                }
              : options.billingLineage,
          )
        : null
    options.perf?.('billing_header', {
      ms: rewriteRoundMs(rewriteNowMs() - billingStart),
      hasBillingHeader: Boolean(billingHeader),
    })

    // Sanitize system prompt and prepend Claude Code identity
    const identityStart = rewriteNowMs()
    parsed.system = prependClaudeCodeIdentity(parsed.system)
    options.perf?.('system_identity', {
      ms: rewriteRoundMs(rewriteNowMs() - identityStart),
      systemBlockCount: Array.isArray(parsed.system) ? parsed.system.length : 0,
    })

    // Prepend the billing header as a separate system block so the
    // final layout is: [billing header, identity, ...rest]
    if (billingHeader && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: 'text', text: billingHeader })
    }

    const cacheStart = rewriteNowMs()
    const cachePolicy = readSessionCachePolicy(
      options.sessionId,
      options.isOAuth === true,
    )
    const cacheEnabled =
      cachePolicy?.ttl !== undefined
        ? cachePolicy.ttl !== 'none'
        : (options.cache1hEnabled ?? false)
    const cachePlacement = applyCache1hStrategy(parsed, {
      enabled: cacheEnabled,
      mode: options.cache1hMode ?? 'explicit',
      hybridStandbyAnchor: options.hybridStandbyAnchor,
    })
    applySessionCacheTtl(parsed, cachePolicy?.ttl)
    options.perf?.('cache_strategy', {
      ms: rewriteRoundMs(rewriteNowMs() - cacheStart),
      enabled: cacheEnabled,
      mode: options.cache1hMode ?? 'explicit',
      ...cachePlacement,
    })

    if (options.fastModeEnabled && isFastModeSupportedModel(parsed.model)) {
      parsed.speed = 'fast'
    } else if (parsed.speed === 'fast') {
      delete parsed.speed
    }

    if (
      options.cacheDiagnosticsPreviousMessageId !== undefined &&
      selectClaudeCodeBetas(parsed).split(',').includes(CACHE_DIAGNOSTICS_BETA)
    ) {
      applyCacheDiagnosticsOptIn(
        parsed,
        options.cacheDiagnosticsPreviousMessageId,
      )
    }

    const metadataStart = rewriteNowMs()
    if (options.identity) applyClaudeCodeMetadata(parsed, options.identity)
    options.perf?.('metadata', {
      ms: rewriteRoundMs(rewriteNowMs() - metadataStart),
      hasAccountUuid: Boolean(options.identity?.accountUuid),
    })

    const prefixStart = rewriteNowMs()
    if (options.modelRemapEnabled === true) remapRequestBodyModel(parsed)
    const toolNameMap = responseToolNames(parsed.tools)
    const prefixed = prefixToolNames(parsed)
    options.perf?.('prefix_tools_stringify', {
      ms: rewriteRoundMs(rewriteNowMs() - prefixStart),
      outputBytesBeforeSign: prefixed.length,
      ...countRewriteShape(parsed),
    })

    const signStart = rewriteNowMs()
    const signed = options.deferSigning
      ? prefixed
      : await signRequestBody(prefixed)
    options.perf?.('cch_sign', {
      ms: rewriteRoundMs(rewriteNowMs() - signStart),
      outputBytes: signed.length,
      deferred: options.deferSigning === true,
    })

    options.onToolNameMap?.(toolNameMap)
    return signed
  } catch (error) {
    if (
      error instanceof EffortMarkerCorrelationError ||
      error instanceof TrailingAssistantHistoryError
    ) {
      throw error
    }
    return body
  }
}

type SseEventSummary = {
  event?: string
  type?: string
  index?: number
  contentBlockType?: string
  deltaType?: string
  stopReason?: string
  rawBytes: number
  dataBytes: number
  textDeltaBytes?: number
  thinkingDeltaBytes?: number
  inputJsonDeltaBytes?: number
  signatureDeltaBytes?: number
  redactedThinkingBytes?: number
  message?: Record<string, unknown>
  usage?: Record<string, unknown>
}

type SseDiagnosticState = {
  pending: string
  pendingOverflowCount: number
  disabled: boolean
  events: number
  parseErrors: number
  eventCounts: Record<string, number>
  typeCounts: Record<string, number>
  deltaTypeCounts: Record<string, number>
  contentBlockTypeCounts: Record<string, number>
  textDeltaBytes: number
  thinkingDeltaBytes: number
  inputJsonDeltaBytes: number
  signatureDeltaBytes: number
  redactedThinkingBytes: number
  last?: SseEventSummary
}

const sseDiagnosticEncoder = new TextEncoder()

function createSseDiagnosticState(): SseDiagnosticState {
  return {
    pending: '',
    pendingOverflowCount: 0,
    disabled: false,
    events: 0,
    parseErrors: 0,
    eventCounts: {},
    typeCounts: {},
    deltaTypeCounts: {},
    contentBlockTypeCounts: {},
    textDeltaBytes: 0,
    thinkingDeltaBytes: 0,
    inputJsonDeltaBytes: 0,
    signatureDeltaBytes: 0,
    redactedThinkingBytes: 0,
  }
}

function incrementCount(
  counts: Record<string, number>,
  key: string | undefined,
) {
  if (!key) return
  counts[key] = (counts[key] ?? 0) + 1
}

function stringBytes(value: string) {
  return sseDiagnosticEncoder.encode(value).byteLength
}

function asDiagnosticRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'number' ? value : undefined
}

function summarizeSseEvent(
  rawEvent: string,
  onParsedEvent?: (event: Record<string, unknown>) => void,
): SseEventSummary | null {
  if (!rawEvent.trim()) return null

  let eventName: string | undefined
  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }

  const dataText = dataLines.join('\n')
  const summary: SseEventSummary = {
    event: eventName,
    rawBytes: stringBytes(rawEvent),
    dataBytes: stringBytes(dataText),
  }

  if (!dataText || dataText === '[DONE]') {
    summary.type = dataText === '[DONE]' ? 'done' : undefined
    summary.event ??= summary.type
    return summary
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(dataText)
  } catch {
    return summary
  }

  const data = asDiagnosticRecord(parsed)
  if (data && onParsedEvent) {
    try {
      onParsedEvent(data)
    } catch {}
  }
  const delta = asDiagnosticRecord(data?.delta)
  const contentBlock = asDiagnosticRecord(data?.content_block)
  const message = asDiagnosticRecord(data?.message)
  const usage =
    asDiagnosticRecord(data?.usage) ?? asDiagnosticRecord(message?.usage)

  summary.type = stringField(data, 'type')
  summary.event ??= summary.type
  summary.index = numberField(data, 'index')
  summary.contentBlockType = stringField(contentBlock, 'type')
  summary.deltaType = stringField(delta, 'type')
  summary.stopReason =
    stringField(delta, 'stop_reason') ?? stringField(data, 'stop_reason')

  if (summary.deltaType === 'text_delta') {
    summary.textDeltaBytes = stringBytes(stringField(delta, 'text') ?? '')
  }
  if (summary.deltaType === 'thinking_delta') {
    summary.thinkingDeltaBytes = stringBytes(
      stringField(delta, 'thinking') ?? '',
    )
  }
  if (summary.deltaType === 'input_json_delta') {
    summary.inputJsonDeltaBytes = stringBytes(
      stringField(delta, 'partial_json') ?? '',
    )
  }
  if (summary.deltaType === 'signature_delta') {
    summary.signatureDeltaBytes = stringBytes(
      stringField(delta, 'signature') ?? '',
    )
  }
  if (summary.contentBlockType === 'redacted_thinking') {
    summary.redactedThinkingBytes = stringBytes(
      stringField(contentBlock, 'data') ?? '',
    )
  }
  if (usage) {
    summary.usage = usage
    summary.stopReason ??= stringField(message, 'stop_reason')
  }
  if (summary.type === 'message_start' && message) summary.message = message

  return summary
}

function findSseBoundary(value: string) {
  const lf = value.indexOf('\n\n')
  const crlf = value.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

function updateSseDiagnostics(
  state: SseDiagnosticState,
  text: string,
  maxPendingBytes: number,
  onEvent?: (summary: SseEventSummary) => void,
  onParsedEvent?: (event: Record<string, unknown>) => void,
) {
  if (!text || state.disabled) return
  state.pending += text

  while (true) {
    const boundary = findSseBoundary(state.pending)
    if (!boundary) break

    const rawEvent = state.pending.slice(0, boundary.index)
    state.pending = state.pending.slice(boundary.index + boundary.length)
    const summary = summarizeSseEvent(rawEvent, onParsedEvent)
    if (!summary) continue

    state.events++
    incrementCount(state.eventCounts, summary.event ?? 'unknown')
    incrementCount(state.typeCounts, summary.type)
    incrementCount(state.deltaTypeCounts, summary.deltaType)
    incrementCount(state.contentBlockTypeCounts, summary.contentBlockType)
    state.textDeltaBytes += summary.textDeltaBytes ?? 0
    state.thinkingDeltaBytes += summary.thinkingDeltaBytes ?? 0
    state.inputJsonDeltaBytes += summary.inputJsonDeltaBytes ?? 0
    state.signatureDeltaBytes += summary.signatureDeltaBytes ?? 0
    state.redactedThinkingBytes += summary.redactedThinkingBytes ?? 0
    state.last = summary
    onEvent?.(summary)
    if (summary.dataBytes > 0 && !summary.type && !summary.event) {
      state.parseErrors++
    }
  }

  if (sseDiagnosticEncoder.encode(state.pending).byteLength > maxPendingBytes) {
    state.pending = ''
    state.disabled = true
    state.pendingOverflowCount++
  }
}

type SseErrorState = {
  pending: string
  disabled: boolean
  resyncCarry: string
}

type SseFinishState = {
  pending: string
  completed: boolean
  disabled: boolean
  resyncCarry: string
}

type SseFinishUpdate =
  | { type: 'content-filter' }
  | { type: 'complete'; finishReason: string }

function createSseFinishState(): SseFinishState {
  return { pending: '', completed: false, disabled: false, resyncCarry: '' }
}

function updateSseFinishState(
  state: SseFinishState,
  text: string,
  maxPendingBytes: number,
): SseFinishUpdate | null {
  if (!text || state.completed) return null
  if (state.disabled) {
    const window = state.resyncCarry + text
    const boundary = findSseBoundary(window)
    if (!boundary) {
      state.resyncCarry = window.slice(-3)
      return null
    }
    state.disabled = false
    state.resyncCarry = ''
    text = window.slice(boundary.index + boundary.length)
    if (!text) return null
  }
  state.pending += text
  let update: SseFinishUpdate | null = null

  while (true) {
    const boundary = findSseBoundary(state.pending)
    if (!boundary) break
    const rawEvent = state.pending.slice(0, boundary.index)
    state.pending = state.pending.slice(boundary.index + boundary.length)
    const summary = summarizeSseEvent(rawEvent)
    if (summary?.type !== 'message_delta' || !summary.stopReason) continue
    state.completed = true
    update ??=
      summary.stopReason === 'refusal'
        ? { type: 'content-filter' }
        : { type: 'complete', finishReason: summary.stopReason }
  }
  if (new TextEncoder().encode(state.pending).byteLength > maxPendingBytes) {
    const tail = state.pending
    state.pending = ''
    state.disabled = true
    state.resyncCarry = tail.slice(-3)
  }
  return update
}

type SseLaneStartFinishRewriteState = {
  pending: string
  disabled: boolean
}

function createSseLaneStartFinishRewriteState(): SseLaneStartFinishRewriteState {
  return { pending: '', disabled: false }
}

function rewriteLaneStartFinishEvent(rawEvent: string) {
  const summary = summarizeSseEvent(rawEvent)
  if (
    summary?.type !== 'message_delta' ||
    summary.stopReason !== 'max_tokens'
  ) {
    return rawEvent
  }
  return rawEvent.replace(/("stop_reason"\s*:\s*)"max_tokens"/, '$1"end_turn"')
}

function updateSseLaneStartFinishRewriteState(
  state: SseLaneStartFinishRewriteState,
  text: string,
  maxPendingBytes: number,
  flush = false,
) {
  if (!text && !flush) return ''
  if (state.disabled) return text
  if (
    new TextEncoder().encode(state.pending + text).byteLength > maxPendingBytes
  ) {
    const passthrough = state.pending + text
    state.pending = ''
    state.disabled = true
    return passthrough
  }
  state.pending += text
  let rewritten = ''
  while (true) {
    const boundary = findSseBoundary(state.pending)
    if (!boundary) break
    const rawEvent = state.pending.slice(0, boundary.index)
    const separator = state.pending.slice(
      boundary.index,
      boundary.index + boundary.length,
    )
    state.pending = state.pending.slice(boundary.index + boundary.length)
    rewritten += rewriteLaneStartFinishEvent(rawEvent)
    rewritten += separator
  }
  if (flush && state.pending) {
    rewritten += rewriteLaneStartFinishEvent(state.pending)
    state.pending = ''
  }
  return rewritten
}

type RetryableAnthropicStreamError = Error & {
  code: 'ECONNRESET'
  syscall: 'anthropic-sse'
  providerErrorType?: string
}

function createSseErrorState(): SseErrorState {
  return { pending: '', disabled: false, resyncCarry: '' }
}

function isRetryableAnthropicStreamError(
  errorType: string | undefined,
  message: string,
) {
  const normalizedType = errorType?.toLowerCase()
  const normalizedMessage = message.toLowerCase()
  return (
    normalizedType === 'api_error' ||
    normalizedType === 'overloaded_error' ||
    normalizedType === 'server_error' ||
    normalizedType === 'internal_server_error' ||
    normalizedMessage.includes('internal server error') ||
    normalizedMessage.includes('server overloaded')
  )
}

function retryableAnthropicStreamError(
  errorType: string | undefined,
  message: string,
): RetryableAnthropicStreamError {
  const detail = errorType ? `${errorType}: ${message}` : message
  const error = new Error(
    `Anthropic stream error: ${detail}`,
  ) as RetryableAnthropicStreamError
  error.code = 'ECONNRESET'
  error.syscall = 'anthropic-sse'
  if (errorType) error.providerErrorType = errorType
  return error
}

function retryableFableContentFilterError(
  model: unknown,
): RetryableAnthropicStreamError {
  const label = isClaudeOpus5Model(model) ? 'Opus 5' : 'Fable'
  const error = new Error(
    `${label} response was blocked by the provider content filter; retrying with Opus 4.8`,
  ) as RetryableAnthropicStreamError
  error.code = 'ECONNRESET'
  error.syscall = 'anthropic-sse'
  error.providerErrorType = 'refusal'
  return error
}

function retryableAnthropicStreamErrorFromRawEvent(
  rawEvent: string,
): RetryableAnthropicStreamError | null {
  if (!rawEvent.includes('error')) return null

  let eventName: string | undefined
  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }

  const dataText = dataLines.join('\n')
  if (!dataText || dataText === '[DONE]') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(dataText)
  } catch {
    return null
  }

  const data = asDiagnosticRecord(parsed)
  if (eventName !== 'error' && stringField(data, 'type') !== 'error') {
    return null
  }

  const error = asDiagnosticRecord(data?.error)
  const errorType =
    stringField(error, 'type') ?? stringField(error, 'code') ?? undefined
  const message =
    stringField(error, 'message') ??
    stringField(data, 'message') ??
    errorType ??
    'Anthropic stream error'

  if (!isRetryableAnthropicStreamError(errorType, message)) return null
  return retryableAnthropicStreamError(errorType, message)
}

type RelayUpstreamStatus = {
  status: number
  source: 'relay_status_field' | 'relay_message_parse'
}

function relayUpstreamStatusFromRawEvent(
  rawEvent: string,
): RelayUpstreamStatus | undefined {
  if (!rawEvent.includes('relay_upstream_error')) return undefined

  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }
  if (!dataLines.length) return undefined

  try {
    const data = asDiagnosticRecord(JSON.parse(dataLines.join('\n')))
    const error = asDiagnosticRecord(data?.error)
    if (stringField(error, 'type') !== 'relay_upstream_error') return undefined
    const status = error?.status
    if (typeof status === 'number' && Number.isInteger(status))
      return { status, source: 'relay_status_field' }
    const message = stringField(error, 'message')
    const match = message?.match(/HTTP\s+(\d{3})\b/i)
    return match
      ? { status: Number(match[1]), source: 'relay_message_parse' }
      : undefined
  } catch {
    return undefined
  }
}

function updateSseErrorState(
  state: SseErrorState,
  text: string,
  maxPendingBytes: number,
  onRelayUpstreamError?: (status: RelayUpstreamStatus) => void,
): RetryableAnthropicStreamError | null {
  if (!text) return null
  if (state.disabled) {
    const window = state.resyncCarry + text
    const boundary = findSseBoundary(window)
    if (!boundary) {
      state.resyncCarry = window.slice(-3)
      return null
    }
    state.disabled = false
    state.resyncCarry = ''
    text = window.slice(boundary.index + boundary.length)
    if (!text) return null
  }
  state.pending += text
  let retryable: RetryableAnthropicStreamError | null = null

  while (true) {
    const boundary = findSseBoundary(state.pending)
    if (!boundary) break

    const rawEvent = state.pending.slice(0, boundary.index)
    state.pending = state.pending.slice(boundary.index + boundary.length)
    const relayStatus = relayUpstreamStatusFromRawEvent(rawEvent)
    if (relayStatus !== undefined) onRelayUpstreamError?.(relayStatus)
    const error = retryableAnthropicStreamErrorFromRawEvent(rawEvent)
    retryable ??= error
  }

  if (new TextEncoder().encode(state.pending).byteLength > maxPendingBytes) {
    const tail = state.pending
    state.pending = ''
    state.disabled = true
    state.resyncCarry = tail.slice(-3)
  }
  return retryable
}

function sseDiagnosticStats(state: SseDiagnosticState) {
  return {
    sseEvents: state.events,
    ssePendingChars: state.pending.length,
    ssePendingOverflowCount: state.pendingOverflowCount,
    sseParseErrors: state.parseErrors,
    sseEventCounts: { ...state.eventCounts },
    sseTypeCounts: { ...state.typeCounts },
    sseDeltaTypeCounts: { ...state.deltaTypeCounts },
    sseContentBlockTypeCounts: { ...state.contentBlockTypeCounts },
    sseTextDeltaBytes: state.textDeltaBytes,
    sseThinkingDeltaBytes: state.thinkingDeltaBytes,
    sseInputJsonDeltaBytes: state.inputJsonDeltaBytes,
    sseSignatureDeltaBytes: state.signatureDeltaBytes,
    sseRedactedThinkingBytes: state.redactedThinkingBytes,
    sseLastEvent: state.last ? { ...state.last } : undefined,
  }
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export function createStrippedStream(
  response: Response,
  options: {
    toolNameMap?: ToolNameMap
    onToolNameRefusal?: () => void
    onResponseFailure?: () => void
    perf?: RewritePerfCallback
    onContentFilter?: (context?: {
      completedToolUse: boolean
    }) => boolean | undefined
    onComplete?: (finishReason: string) => void
    contentFilterModel?: unknown
    serverSideFallbackModel?: string
    onServerSideFallbackOutcome?: (outcome: ServerSideFallbackOutcome) => void
    onMessageStart?: (message: Record<string, unknown>) => void
    onMessageDelta?: (delta: {
      usage?: Record<string, unknown>
      stopReason?: string
    }) => void
    onMessageResponse?: (message: Record<string, unknown>) => void
    onSseEvent?: (event: Record<string, unknown>) => void
    onRelayUpstreamError?: (status: RelayUpstreamStatus) => void
    onStreamEnd?: () => void | Promise<void>
    responseMode?: 'json'
    laneStart?: boolean
    laneStartOAuthServed?: boolean
  } = {},
): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const encoder = new TextEncoder()
  const jsonMode = options.responseMode === 'json'
  const toolNames = createToolNameRewriter(options.toolNameMap, jsonMode)
  let decodeAtStart = true
  let preamble = ''
  let chunkCount = 0
  let pullCount = 0
  let inputBytes = 0
  let outputBytes = 0
  let rewriteMs = 0
  let firstPullLogged = false
  let readerReleased = false
  let lastProgressAt = rewriteNowMs()
  const streamStart = rewriteNowMs()
  const sseDiagnostics =
    options.perf ||
    options.onMessageStart ||
    options.onMessageDelta ||
    options.onSseEvent
      ? createSseDiagnosticState()
      : undefined
  let responseText = ''
  let responseTextBytes = 0
  let responseTextOverflowed = false
  const observe = (callback: (() => void) | undefined) => {
    if (!callback) return
    try {
      callback()
    } catch {}
  }
  const sseErrors = createSseErrorState()
  const sseFinish =
    options.onContentFilter || options.onComplete
      ? createSseFinishState()
      : undefined
  const laneStartFinish =
    options.laneStart && options.laneStartOAuthServed !== false
      ? createSseLaneStartFinishRewriteState()
      : undefined
  let contentFilterInvoked = false
  let contentFilterHandled = false
  const invokeContentFilter = (completedToolUse = false) => {
    if (!options.onContentFilter) return false
    if (!contentFilterInvoked) {
      contentFilterInvoked = true
      contentFilterHandled =
        options.onContentFilter({ completedToolUse }) !== false
    }
    return contentFilterHandled
  }
  const serverSideFallback = options.serverSideFallbackModel
    ? createServerSideFallbackStreamRewriter({
        requestedModel: options.serverSideFallbackModel,
        maxPendingBytes: NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
        onOutcome: options.onServerSideFallbackOutcome,
        onRefusalAfterToolUse: options.onContentFilter
          ? () => invokeContentFilter(true)
          : undefined,
      })
    : undefined

  const updateFinish = (text: string) => {
    if (!sseFinish) return null
    const update = updateSseFinishState(
      sseFinish,
      text,
      NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
    )
    if (update?.type === 'content-filter' && options.onContentFilter) {
      return invokeContentFilter()
        ? retryableFableContentFilterError(options.contentFilterModel)
        : null
    }
    if (update?.type === 'complete') options.onComplete?.(update.finishReason)
    return null
  }
  const rewriteLaneStartFinish = (text: string, flush = false) =>
    laneStartFinish
      ? updateSseLaneStartFinishRewriteState(
          laneStartFinish,
          text,
          NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
          flush,
        )
      : text

  const releaseReader = () => {
    if (readerReleased) return
    readerReleased = true
    reader.releaseLock()
  }
  const cancelReader = async (reason: unknown) => {
    try {
      await reader.cancel(reason)
    } catch {
      // The stream may already be closed by the provider.
    } finally {
      releaseReader()
    }
  }
  const streamStats = (extra: Record<string, unknown> = {}) => ({
    chunks: chunkCount,
    pulls: pullCount,
    inputBytes,
    outputBytes,
    pendingChars: toolNames.pendingLength(),
    sseErrorPending: sseErrors.pending.length,
    sseFinishPending: sseFinish?.pending.length ?? 0,
    sseFinishDisabled: sseFinish?.disabled ?? false,
    serverFallbackPending: serverSideFallback?.pendingLength() ?? 0,
    rewriteMs: rewriteRoundMs(rewriteMs),
    totalMs: rewriteRoundMs(rewriteNowMs() - streamStart),
    ...(sseDiagnostics ? sseDiagnosticStats(sseDiagnostics) : {}),
    ...extra,
  })
  const logProgress = (stage: string, extra: Record<string, unknown> = {}) => {
    options.perf?.(stage, streamStats(extra))
  }

  options.perf?.('stream_tool_prefix_wrapper_created', {
    status: response.status,
    hasBody: true,
  })

  const stream = new ReadableStream({
    async pull(controller) {
      pullCount++
      if (!firstPullLogged) {
        firstPullLogged = true
        logProgress('stream_tool_prefix_first_pull')
      }

      while (true) {
        const readStart = rewriteNowMs()
        try {
          const { done, value } = await reader.read()
          const readMs = rewriteRoundMs(rewriteNowMs() - readStart)
          if (done) {
            const finalDecoded = decoder.decode()
            if (sseDiagnostics && !jsonMode)
              updateSseDiagnostics(
                sseDiagnostics,
                finalDecoded,
                NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
                (summary) => {
                  const message = summary.message
                  if (summary.type === 'message_start' && message)
                    observe(() => options.onMessageStart?.(message))
                  if (
                    summary.type === 'message_delta' &&
                    (summary.usage || summary.stopReason)
                  )
                    observe(() =>
                      options.onMessageDelta?.({
                        ...(summary.usage ? { usage: summary.usage } : {}),
                        ...(summary.stopReason
                          ? { stopReason: summary.stopReason }
                          : {}),
                      }),
                    )
                },
                options.onSseEvent,
              )
            if (jsonMode) {
              const finalBytes = encoder.encode(finalDecoded).byteLength
              if (
                responseTextBytes + finalBytes <=
                NON_STREAMING_DIAGNOSTICS_MAX_BYTES
              ) {
                responseText += finalDecoded
                responseTextBytes += finalBytes
              } else {
                responseTextOverflowed = true
              }
            }
            if (jsonMode && !responseTextOverflowed) {
              try {
                const message = JSON.parse(responseText)
                if (
                  message &&
                  typeof message === 'object' &&
                  !Array.isArray(message)
                )
                  observe(() => options.onMessageResponse?.(message))
              } catch {}
            }
            const rewriteStart = rewriteNowMs()
            const serverRewritten = serverSideFallback
              ? serverSideFallback.push(finalDecoded) +
                serverSideFallback.flush()
              : finalDecoded
            const laneStartRewritten = rewriteLaneStartFinish(
              serverRewritten,
              true,
            )
            const retryableStreamError = jsonMode
              ? updateFinish(laneStartRewritten)
              : (updateSseErrorState(
                  sseErrors,
                  finalDecoded,
                  NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
                  options.onRelayUpstreamError,
                ) ?? updateFinish(laneStartRewritten))
            if (retryableStreamError) {
              // The provider's message stays out of logs; its type is enough.
              logProgress('stream_tool_prefix_retryable_error', {
                providerErrorType: retryableStreamError.providerErrorType,
              })
              await cancelReader(retryableStreamError)
              throw retryableStreamError
            }
            const flushed = toolNames.push(laneStartRewritten, true)
            rewriteMs += rewriteNowMs() - rewriteStart
            if (flushed || preamble) {
              const encoded = encoder.encode(preamble + flushed)
              preamble = ''
              outputBytes += encoded.byteLength
              controller.enqueue(encoded)
            }
            logProgress('stream_tool_prefix_rewrite', { readMs })
            releaseReader()
            if (options.onStreamEnd) {
              try {
                await options.onStreamEnd()
              } catch {}
            }
            controller.close()
            return
          }

          chunkCount++
          inputBytes += value.byteLength
          let decoded = decoder.decode(value, { stream: true })
          if (decodeAtStart && decoded) {
            decodeAtStart = false
            if (decoded.charCodeAt(0) === 0xfeff) {
              // Observers keep the decoder's former BOM-free view; only the
              // returned bytes retain the provider's original BOM.
              preamble = decoded[0] ?? ''
              decoded = decoded.slice(1)
            }
          }
          if (jsonMode) {
            const decodedBytes = value.byteLength
            if (
              responseTextBytes + decodedBytes <=
              NON_STREAMING_DIAGNOSTICS_MAX_BYTES
            ) {
              responseText += decoded
              responseTextBytes += decodedBytes
            } else {
              responseTextOverflowed = true
            }
          }
          if (sseDiagnostics && !jsonMode)
            updateSseDiagnostics(
              sseDiagnostics,
              decoded,
              NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
              (summary) => {
                const message = summary.message
                if (summary.type === 'message_start' && message)
                  observe(() => options.onMessageStart?.(message))
                if (
                  summary.type === 'message_delta' &&
                  (summary.usage || summary.stopReason)
                )
                  observe(() =>
                    options.onMessageDelta?.({
                      ...(summary.usage ? { usage: summary.usage } : {}),
                      ...(summary.stopReason
                        ? { stopReason: summary.stopReason }
                        : {}),
                    }),
                  )
              },
              options.onSseEvent,
            )
          const rewriteStart = rewriteNowMs()
          const serverRewritten = serverSideFallback
            ? serverSideFallback.push(decoded)
            : decoded
          const laneStartRewritten = rewriteLaneStartFinish(serverRewritten)
          const retryableStreamError = jsonMode
            ? updateFinish(laneStartRewritten)
            : (updateSseErrorState(
                sseErrors,
                decoded,
                NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
                options.onRelayUpstreamError,
              ) ?? updateFinish(laneStartRewritten))
          if (retryableStreamError) {
            logProgress('stream_tool_prefix_retryable_error', {
              providerErrorType: retryableStreamError.providerErrorType,
              readMs,
              lastChunkBytes: value.byteLength,
            })
            releaseReader()
            throw retryableStreamError
          }
          const rewritten = toolNames.push(laneStartRewritten)
          rewriteMs += rewriteNowMs() - rewriteStart
          if (rewritten) {
            const encoded = encoder.encode(preamble + rewritten)
            preamble = ''
            outputBytes += encoded.byteLength
            controller.enqueue(encoded)
          }

          const now = rewriteNowMs()
          if (
            chunkCount === 1 ||
            chunkCount % 25 === 0 ||
            now - lastProgressAt > 5000
          ) {
            lastProgressAt = now
            logProgress('stream_tool_prefix_progress', {
              readMs,
              lastChunkBytes: value.byteLength,
            })
          }
          if (rewritten) return
        } catch (caught) {
          observe(options.onResponseFailure)
          const error = normalizeToolNameResponseError(
            caught,
            options.toolNameMap,
          )
          // Only the stage is logged: the error text can repeat provider output.
          logProgress('stream_tool_prefix_error')
          if (error instanceof UnsafeToolNameResponseError) {
            await cancelUnsafeToolNameResponse(reader, error)
            readerReleased = true
            observe(options.onToolNameRefusal)
          } else {
            releaseReader()
          }
          throw error
        }
      }
    },
    async cancel(reason) {
      observe(options.onResponseFailure)
      logProgress('stream_tool_prefix_cancel')
      try {
        await reader.cancel(reason)
      } finally {
        releaseReader()
      }
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
