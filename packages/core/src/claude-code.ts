import { randomBytes, randomUUID } from 'node:crypto'
import {
  CLAUDE_CODE_BUILD_HASH,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CODE_VERSION,
  FAST_MODE_BETA,
  USER_AGENT,
} from './constants.ts'

export type ClaudeCodeIdentity = {
  deviceId: string
  accountUuid?: string
  sessionId: string
}

const IDENTITY_CACHE_LIMIT = 1_000
const identityCache = new Map<string, ClaudeCodeIdentity>()

export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit = IDENTITY_CACHE_LIMIT,
) {
  if (!map.has(key) && map.size >= limit) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

export function getClaudeCodeIdentity(seed: string): ClaudeCodeIdentity {
  const cacheKey = seed || 'anonymous'
  const cached = identityCache.get(cacheKey)
  if (cached) return cached

  const identity: ClaudeCodeIdentity = {
    deviceId: randomBytes(32).toString('hex'),
    sessionId: randomUUID(),
  }
  setBounded(identityCache, cacheKey, identity)
  return identity
}

const BOOTSTRAP_IDENTITY_CACHE_TTL_MS = 24 * 60 * 60_000
const BOOTSTRAP_IDENTITY_NEGATIVE_TTL_MS = 5 * 60_000
const bootstrapFetches = new Map<string, Promise<string | null>>()
const bootstrapResults = new Map<
  string,
  { accountUuid: string | null; expiresAt: number }
>()

async function fetchClaudeCodeAccountUuid(accessToken: string, model?: string) {
  if (!accessToken.startsWith('sk-ant-oat')) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const url = new URL('https://api.anthropic.com/api/claude_cli/bootstrap')
    url.searchParams.set('entrypoint', CLAUDE_CODE_ENTRYPOINT)
    if (model) url.searchParams.set('model', model)

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': `claude-code/${CLAUDE_CODE_VERSION}`,
      },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data = (await response.json().catch(() => null)) as {
      oauth_account?: { account_uuid?: unknown }
    } | null
    const accountUuid = data?.oauth_account?.account_uuid
    return typeof accountUuid === 'string' && accountUuid ? accountUuid : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function resolveClaudeCodeIdentity(
  accessToken: string,
  model?: string,
): Promise<ClaudeCodeIdentity> {
  const identity = getClaudeCodeIdentity(accessToken)
  if (!accessToken.startsWith('sk-ant-oat')) return identity

  const now = Date.now()
  const cachedResult = bootstrapResults.get(accessToken)
  if (cachedResult && cachedResult.expiresAt > now) {
    if (!cachedResult.accountUuid) return identity
    const accountCacheKey = `account:${cachedResult.accountUuid}`
    const accountIdentity = identityCache.get(accountCacheKey)
    if (accountIdentity) {
      setBounded(identityCache, accessToken, accountIdentity)
      return accountIdentity
    }
  }

  let fetchPromise = bootstrapFetches.get(accessToken)
  if (!fetchPromise) {
    fetchPromise = fetchClaudeCodeAccountUuid(accessToken, model)
    bootstrapFetches.set(accessToken, fetchPromise)
  }

  const accountUuid = await fetchPromise.finally(() => {
    bootstrapFetches.delete(accessToken)
  })
  setBounded(bootstrapResults, accessToken, {
    accountUuid,
    expiresAt:
      now +
      (accountUuid
        ? BOOTSTRAP_IDENTITY_CACHE_TTL_MS
        : BOOTSTRAP_IDENTITY_NEGATIVE_TTL_MS),
  })
  if (!accountUuid) return identity

  const accountCacheKey = `account:${accountUuid}`
  const accountIdentity = identityCache.get(accountCacheKey)
  if (accountIdentity) {
    setBounded(identityCache, accessToken, accountIdentity)
    return accountIdentity
  }

  identity.accountUuid = accountUuid
  setBounded(identityCache, accountCacheKey, identity)
  return identity
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function buildClaudeCodeMetadataUserId(
  identity: ClaudeCodeIdentity,
): string | null {
  if (!identity.accountUuid) return null
  return JSON.stringify({
    device_id: identity.deviceId,
    account_uuid: identity.accountUuid,
    session_id: identity.sessionId,
  })
}

export function applyClaudeCodeMetadata(
  body: Record<string, unknown>,
  identity: ClaudeCodeIdentity,
) {
  const userId = buildClaudeCodeMetadataUserId(identity)
  if (!userId) {
    if (isRecord(body.metadata)) delete body.metadata.user_id
    return false
  }

  if (!isRecord(body.metadata)) body.metadata = {}
  const metadata = body.metadata
  if (isRecord(metadata)) metadata.user_id = userId
  return true
}

export const CLAUDE_CODE_FULL_AGENT_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'claude-code-20250219',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

const CLAUDE_CODE_STRUCTURED_OUTPUT_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advisor-tool-2026-03-01',
  'structured-outputs-2025-12-15',
  'cache-diagnosis-2026-04-07',
] as const

const CLAUDE_CODE_BASE_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'advisor-tool-2026-03-01',
  'advanced-tool-use-2025-11-20',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

function hasStructuredOutput(body: Record<string, unknown>) {
  const outputConfig = body.output_config as Record<string, unknown> | undefined
  const format = outputConfig?.format as Record<string, unknown> | undefined
  return format?.type === 'json_schema'
}

function hasFullAgentShape(body: Record<string, unknown>) {
  return (
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    Array.isArray(body.system) &&
    isRecord(body.thinking) &&
    isRecord(body.context_management) &&
    isRecord(body.output_config) &&
    isRecord(body.diagnostics)
  )
}

export function selectClaudeCodeBetas(
  body?: Record<string, unknown> | null,
  extraBetas: string[] = [],
) {
  const selected: string[] = body
    ? hasFullAgentShape(body)
      ? [...CLAUDE_CODE_FULL_AGENT_BETAS]
      : hasStructuredOutput(body)
        ? [...CLAUDE_CODE_STRUCTURED_OUTPUT_BETAS]
        : [...CLAUDE_CODE_BASE_BETAS]
    : [...CLAUDE_CODE_BASE_BETAS]

  if (body?.speed === 'fast') selected.push(FAST_MODE_BETA)
  for (const beta of extraBetas) {
    const trimmed = beta.trim()
    if (trimmed) selected.push(trimmed)
  }
  return [...new Set(selected)].join(',')
}

function stainlessOS() {
  switch (process.platform) {
    case 'darwin':
      return 'MacOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'freebsd':
      return 'FreeBSD'
    default:
      return 'Unknown'
  }
}

function stainlessArch() {
  switch (process.arch) {
    case 'arm64':
      return 'arm64'
    case 'x64':
      return 'x64'
    case 'ia32':
      return 'x32'
    default:
      return process.arch
  }
}

export function applyClaudeCodeHeaders(
  headers: Headers,
  accessToken: string,
  options: {
    body?: Record<string, unknown> | null
    identity?: ClaudeCodeIdentity
    extraBetas?: string[]
  } = {},
): Headers {
  const identity = options.identity ?? getClaudeCodeIdentity(accessToken)
  const incomingBetas = (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((beta) => beta.trim())
    .filter(Boolean)
  const extraBetas = [...incomingBetas, ...(options.extraBetas ?? [])]

  headers.set('accept', 'application/json')
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('content-type', 'application/json')
  headers.set('user-agent', USER_AGENT)
  headers.set('anthropic-beta', selectClaudeCodeBetas(options.body, extraBetas))
  headers.set('anthropic-dangerous-direct-browser-access', 'true')
  headers.set('anthropic-version', '2023-06-01')
  headers.set('x-app', 'cli')
  headers.set('x-client-request-id', randomUUID())
  headers.set('x-claude-code-session-id', identity.sessionId)
  headers.set('x-stainless-arch', stainlessArch())
  headers.set('x-stainless-lang', 'js')
  headers.set('x-stainless-os', stainlessOS())
  headers.set(
    'x-stainless-package-version',
    CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  )
  headers.set('x-stainless-retry-count', '0')
  headers.set('x-stainless-runtime', 'node')
  headers.set(
    'x-stainless-runtime-version',
    CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  )
  headers.set('x-stainless-timeout', '600')
  headers.delete('x-api-key')
  return headers
}

const BODY_FIELD_ORDER = [
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'metadata',
  'max_tokens',
  'temperature',
  'thinking',
  'context_management',
  'output_config',
  'diagnostics',
  'stream',
  'speed',
]

export function orderClaudeCodeBody<T extends Record<string, unknown>>(
  body: T,
): T {
  const ordered: Record<string, unknown> = {}
  for (const key of BODY_FIELD_ORDER) {
    if (Object.hasOwn(body, key)) ordered[key] = body[key]
  }
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value
  }
  return ordered as T
}

export function claudeCodeBuildHash() {
  return CLAUDE_CODE_BUILD_HASH
}

export function claudeCodeEntrypoint() {
  return CLAUDE_CODE_ENTRYPOINT
}
