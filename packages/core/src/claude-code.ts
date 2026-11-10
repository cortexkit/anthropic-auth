import { randomBytes, randomUUID } from 'node:crypto'
import { extractBillingPromptId } from './cch.ts'
import {
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CODE_VERSION,
  FAST_MODE_BETA,
  USER_AGENT,
} from './constants.ts'
import {
  CLAUDE_CODE_DEFAULT_BETAS,
  CLAUDE_CODE_FULL_AGENT_BETAS,
  resolveClaudeModelCapabilities,
  TURN_END_NOTE_BETA,
} from './model-capabilities.ts'
import { THINKING_BINDING_CONTROLS_BETA } from './thinking-binding.ts'

export type ProviderAccountUuid = string & {
  readonly __providerAccountUuid: unique symbol
}

export type ClaudeCodeIdentity = {
  deviceId: string
  accountIdentity?: string
  accountUuid?: ProviderAccountUuid
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

function clearCachedAccountUuid(
  key: string,
  identity: ClaudeCodeIdentity,
): ClaudeCodeIdentity {
  if (!identity.accountUuid) return identity
  if (identityCache.get(key) !== identity) {
    return { ...identity, accountUuid: undefined }
  }
  const cleared = { ...identity, accountUuid: undefined }
  setBounded(identityCache, key, cleared)
  return cleared
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
const bootstrapFetches = new Map<string, Promise<ProviderAccountUuid | null>>()
const bootstrapResults = new Map<
  string,
  { accountUuid: ProviderAccountUuid | null; expiresAt: number }
>()

export function resetClaudeCodeIdentityCachesForTest() {
  identityCache.clear()
  bootstrapFetches.clear()
  bootstrapResults.clear()
}

function compatibilityCacheKey(accessToken: string) {
  return `compat:${accessToken || 'anonymous'}`
}

function explicitCacheKey(accountIdentity: string) {
  return `identity:${accountIdentity}`
}

function accountCacheKey(accountUuid: string, accountIdentity: string) {
  return `account:${accountUuid}:${accountIdentity}`
}

function adoptCachedIdentity(
  cached: ClaudeCodeIdentity | undefined,
  accountIdentity: string,
  accountUuid?: ProviderAccountUuid,
) {
  if (!cached) return undefined
  if (
    cached.accountIdentity !== undefined &&
    cached.accountIdentity !== accountIdentity
  ) {
    return undefined
  }
  if (
    accountUuid !== undefined &&
    cached.accountUuid !== undefined &&
    cached.accountUuid !== accountUuid
  ) {
    return undefined
  }
  if (
    cached.accountIdentity === accountIdentity &&
    (accountUuid === undefined || cached.accountUuid === accountUuid)
  ) {
    return cached
  }
  return {
    ...cached,
    accountIdentity,
    ...(accountUuid !== undefined && { accountUuid }),
  }
}

function cacheAccountIdentity(
  identity: ClaudeCodeIdentity,
  accountIdentity: string,
  accountUuid: ProviderAccountUuid,
) {
  setBounded(identityCache, explicitCacheKey(accountIdentity), identity)
  setBounded(
    identityCache,
    accountCacheKey(accountUuid, accountIdentity),
    identity,
  )
}

async function fetchClaudeCodeAccountUuid(
  accessToken: string,
  model?: string,
): Promise<ProviderAccountUuid | null> {
  if (!accessToken.startsWith('sk-ant-oat')) return null
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const url = new URL('https://api.anthropic.com/api/claude_cli/bootstrap')
    url.searchParams.set('entrypoint', CLAUDE_CODE_ENTRYPOINT)
    if (model) url.searchParams.set('model', model)

    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
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
    return typeof accountUuid === 'string' && accountUuid
      ? (accountUuid as ProviderAccountUuid)
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Use the identity already verified by the credential custodian, without an
 * additional bootstrap request carrying a previously authorized token. */
export function getClaudeCodeIdentityForVerifiedAccount(
  accountIdentity: string,
  accountUuid: ProviderAccountUuid,
): ClaudeCodeIdentity {
  if (!accountIdentity.trim() || !accountUuid.trim()) {
    throw new Error('A verified provider account identity is required')
  }
  const base =
    identityCache.get(accountCacheKey(accountUuid, accountIdentity)) ??
    getClaudeCodeIdentity(explicitCacheKey(accountIdentity))
  const identity = { ...base, accountIdentity, accountUuid }
  cacheAccountIdentity(identity, accountIdentity, accountUuid)
  return identity
}

export async function resolveClaudeCodeIdentity(
  accessToken: string,
  model: string | undefined,
  accountIdentity: string | undefined,
): Promise<ClaudeCodeIdentity> {
  const stableAccountIdentity = accountIdentity?.trim() || undefined
  const cacheKey = stableAccountIdentity
    ? explicitCacheKey(stableAccountIdentity)
    : compatibilityCacheKey(accessToken)
  let identity: ClaudeCodeIdentity
  if (stableAccountIdentity) {
    const cachedIdentity = adoptCachedIdentity(
      identityCache.get(cacheKey) ?? identityCache.get(accessToken),
      stableAccountIdentity,
    )
    identity = cachedIdentity ?? getClaudeCodeIdentity(cacheKey)
    identity = adoptCachedIdentity(identity, stableAccountIdentity) ?? identity
    setBounded(identityCache, cacheKey, identity)
  } else {
    identity =
      identityCache.get(cacheKey) ??
      identityCache.get(accessToken) ??
      getClaudeCodeIdentity(cacheKey)
    setBounded(identityCache, cacheKey, identity)
    setBounded(identityCache, accessToken, identity)
  }

  if (!accessToken.startsWith('sk-ant-oat')) {
    return clearCachedAccountUuid(cacheKey, identity)
  }

  const now = Date.now()
  // A slot-stable identity survives account replacement; bootstrap is the
  // account lookup that must be repeated for each credential presented to it.
  const bootstrapKey = `${cacheKey}:${accessToken}`
  const cachedResult = bootstrapResults.get(bootstrapKey)
  if (cachedResult && cachedResult.expiresAt > now) {
    if (!cachedResult.accountUuid) {
      identity = clearCachedAccountUuid(cacheKey, identity)
      return identity
    }
    if (!stableAccountIdentity) {
      if (identity.accountUuid === cachedResult.accountUuid) return identity
      identity = { ...identity, accountUuid: cachedResult.accountUuid }
      setBounded(identityCache, bootstrapKey, identity)
      return identity
    }
    const cachedAccountIdentity = adoptCachedIdentity(
      identityCache.get(
        accountCacheKey(cachedResult.accountUuid, stableAccountIdentity),
      ) ?? identityCache.get(`account:${cachedResult.accountUuid}`),
      stableAccountIdentity,
      cachedResult.accountUuid,
    )
    if (cachedAccountIdentity) {
      identity = cachedAccountIdentity
      cacheAccountIdentity(
        identity,
        stableAccountIdentity,
        cachedResult.accountUuid,
      )
      return identity
    }
    if (identity.accountUuid === cachedResult.accountUuid) return identity
    identity = {
      ...identity,
      accountIdentity: stableAccountIdentity,
      accountUuid: cachedResult.accountUuid,
    }
    cacheAccountIdentity(
      identity,
      stableAccountIdentity,
      cachedResult.accountUuid,
    )
    return identity
  }

  let fetchPromise = bootstrapFetches.get(bootstrapKey)
  if (!fetchPromise) {
    fetchPromise = fetchClaudeCodeAccountUuid(accessToken, model)
    setBounded(bootstrapFetches, bootstrapKey, fetchPromise)
  }

  const accountUuid = await fetchPromise.finally(() => {
    if (bootstrapFetches.get(bootstrapKey) === fetchPromise) {
      bootstrapFetches.delete(bootstrapKey)
    }
  })
  setBounded(bootstrapResults, bootstrapKey, {
    accountUuid,
    expiresAt:
      now +
      (accountUuid
        ? BOOTSTRAP_IDENTITY_CACHE_TTL_MS
        : BOOTSTRAP_IDENTITY_NEGATIVE_TTL_MS),
  })
  if (!accountUuid) {
    identity = clearCachedAccountUuid(cacheKey, identity)
    return identity
  }
  if (!stableAccountIdentity) {
    identity = { ...identity, accountUuid }
    setBounded(identityCache, bootstrapKey, identity)
    return identity
  }

  const cachedAccountIdentity = adoptCachedIdentity(
    identityCache.get(accountCacheKey(accountUuid, stableAccountIdentity)) ??
      identityCache.get(`account:${accountUuid}`),
    stableAccountIdentity,
    accountUuid,
  )
  if (cachedAccountIdentity) {
    identity = cachedAccountIdentity
    cacheAccountIdentity(identity, stableAccountIdentity, accountUuid)
    return identity
  }

  identity = {
    ...identity,
    accountIdentity: stableAccountIdentity,
    accountUuid,
  }
  cacheAccountIdentity(identity, stableAccountIdentity, accountUuid)
  return identity
}

/**
 * The access value is not a Claude OAuth access token, so Claude cannot
 * identify its account. Asking again will not help; only a new sign-in
 * replaces it. The message never includes the rejected value.
 */
export class ClaudeUnsupportedAccessError extends Error {
  readonly code = 'unsupported-access'

  constructor() {
    super(
      'Claude OAuth access credential is not supported; sign in to this account again',
    )
    this.name = 'ClaudeUnsupportedAccessError'
  }
}

/**
 * Account lookup for credentials that must belong to a Claude account.
 * Unlike resolveClaudeCodeIdentity, which returns an identity without an
 * account UUID for any other access value, this rejects such a value with
 * ClaudeUnsupportedAccessError before any network request.
 */
export async function resolveClaudeCodeAccountIdentity(
  accessToken: string,
  model: string | undefined,
  accountIdentity: string | undefined,
): Promise<ClaudeCodeIdentity> {
  if (typeof accessToken !== 'string' || !accessToken.startsWith('sk-ant-oat'))
    throw new ClaudeUnsupportedAccessError()
  return resolveClaudeCodeIdentity(accessToken, model, accountIdentity)
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

// The per-model beta lists live in the capability table in
// model-capabilities.ts; this is the list for a model without a row.
export { CLAUDE_CODE_FULL_AGENT_BETAS }

function hasStructuredOutput(body: Record<string, unknown>) {
  const outputConfig = body.output_config as Record<string, unknown> | undefined
  const format = outputConfig?.format as Record<string, unknown> | undefined
  return format?.type === 'json_schema'
}

function isQuotaProbe(body: Record<string, unknown>) {
  return (
    body.max_tokens === 1 &&
    !body.stream &&
    !body.thinking &&
    (!Array.isArray(body.tools) || body.tools.length === 0) &&
    !hasStructuredOutput(body)
  )
}

export function selectClaudeCodeBetas(
  body?: Record<string, unknown> | null,
  extraBetas: string[] = [],
  requestClass: ClaudeCodeRequestClass = 'main',
) {
  // Each model's lists already carry its per-turn control beta and Claude
  // Code's ordering for that model (see model-capabilities.ts).
  const lists =
    (body && resolveClaudeModelCapabilities(body.model)?.claudeCodeBetas) ||
    CLAUDE_CODE_DEFAULT_BETAS
  // A conversation turn uses the main list even without tools or companion
  // fields. Only auxiliary one-token probes use the smaller quota list.
  const selected: string[] =
    requestClass === 'main'
      ? [...lists.main]
      : body && isQuotaProbe(body)
        ? [...lists.quota]
        : [...lists.title]

  if (
    Array.isArray(body?.messages) &&
    body.messages.some(
      (message) =>
        isRecord(message) && message.clear_at === 'next_user_message',
    ) &&
    !selected.includes(TURN_END_NOTE_BETA)
  )
    selected.push(TURN_END_NOTE_BETA)

  // Auxiliary cache warms can replay the same binding controls as a real turn.
  if (isRecord(body?.thinking) && 'block_binding' in body.thinking)
    selected.push(THINKING_BINDING_CONTROLS_BETA)

  if (body && hasStructuredOutput(body)) {
    const index = selected.indexOf('cache-diagnosis-2026-04-07')
    selected.splice(
      index < 0 ? selected.length : index,
      0,
      'structured-outputs-2025-12-15',
    )
  }
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

export type ClaudeCodeRequestClass = 'main' | 'auxiliary'

export function applyClaudeCodeHeaders(
  headers: Headers,
  accessToken: string,
  options: {
    body?: Record<string, unknown> | null
    identity?: ClaudeCodeIdentity
    extraBetas?: string[]
    /**
     * Claude Code's `x-claude-code-request-class`: `main` for a conversation
     * turn, `auxiliary` for background requests such as title generation.
     */
    requestClass?: ClaudeCodeRequestClass
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
  headers.set(
    'anthropic-beta',
    selectClaudeCodeBetas(options.body, extraBetas, options.requestClass),
  )
  headers.set('anthropic-dangerous-direct-browser-access', 'true')
  headers.set('anthropic-version', '2023-06-01')
  headers.set('x-app', 'cli')
  headers.set('x-client-request-id', randomUUID())
  headers.set('x-claude-code-session-id', identity.sessionId)
  headers.set('x-claude-code-request-class', options.requestClass ?? 'main')
  // Claude Code repeats the billing block's cc_prompt_id in this header; a
  // request without one (a background or reused body) sends neither.
  const promptId = extractBillingPromptId(options.body)
  if (promptId) headers.set('x-claude-code-prompt-id', promptId)
  else headers.delete('x-claude-code-prompt-id')
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
  options: { isOAuth?: boolean } = {},
): T {
  const ordered: Record<string, unknown> = {}
  for (const key of BODY_FIELD_ORDER) {
    if (Object.hasOwn(body, key)) ordered[key] = body[key]
  }
  for (const [key, value] of Object.entries(body)) {
    // Claude Code does not select a service tier on subscription requests.
    if (options.isOAuth && key === 'service_tier') continue
    if (!Object.hasOwn(ordered, key)) ordered[key] = value
  }
  return ordered as T
}

export function claudeCodeEntrypoint() {
  return CLAUDE_CODE_ENTRYPOINT
}
