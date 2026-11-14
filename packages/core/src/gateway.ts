import { customHeadersFromEntries } from './custom-headers.ts'
import { logger } from './logger.ts'

/**
 * The user's own gateway for Claude sign-in (OAuth) model requests.
 *
 * Claude OAuth tokens normally go only to https://api.anthropic.com (see
 * oauth-origin.ts). A user can name one gateway in their own settings file
 * (`gateway_url`, `gateway_headers`); model requests (`POST …/v1/messages`)
 * then go there instead. The value is read only from the user settings file:
 * never from a project file, a provider `baseURL` or an environment
 * variable, because those can come from a repository the user opened.
 *
 * Header values are secrets the user gave to their gateway. They are kept
 * only in memory, added to gateway requests, and never logged, dumped or
 * shown: Status shows header names only.
 */
export interface ClaudeGateway {
  /** Scheme, host and port, for example `https://gw.example.com`. */
  readonly origin: string
  /** Path prefix without a trailing slash, or `''` for none. */
  readonly pathPrefix: string
  /** Header names and values to add to every gateway request. */
  readonly headers: readonly (readonly [string, string])[]
}

/** What Status may show about a gateway: no header values. */
export interface ClaudeGatewayStatus {
  readonly origin: string
  readonly pathPrefix: string
  readonly headerNames: readonly string[]
}

export type ClaudeGatewayParse =
  | { readonly ok: true; readonly gateway: ClaudeGateway | undefined }
  | { readonly ok: false; readonly problem: 'gateway_url' | 'gateway_headers' }

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

function parseGatewayUrl(
  raw: string,
): { origin: string; pathPrefix: string } | undefined {
  // A query or fragment marker is refused even when empty: `new URL` drops
  // an empty `?` or `#`, so check the text before parsing it.
  if (raw.includes('?') || raw.includes('#')) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  } else if (url.protocol !== 'https:') return undefined
  if (!url.hostname) return undefined
  const pathPrefix = url.pathname.replace(/\/+$/, '')
  return { origin: url.origin, pathPrefix }
}

/**
 * Validates the two gateway settings together. An empty `gateway_url` means
 * no gateway; headers without a URL are still validated so a mistake shows
 * up before the URL is added. Any problem makes the whole gateway invalid.
 */
export function parseClaudeGateway(
  url: string,
  headers: Readonly<Record<string, string>>,
): ClaudeGatewayParse {
  let parsedHeaders: Headers
  try {
    parsedHeaders = customHeadersFromEntries(Object.entries(headers))
  } catch {
    return { ok: false, problem: 'gateway_headers' }
  }
  if (!url) return { ok: true, gateway: undefined }
  const destination = parseGatewayUrl(url)
  if (!destination) return { ok: false, problem: 'gateway_url' }
  return {
    ok: true,
    gateway: {
      ...destination,
      headers: [...parsedHeaders.entries()],
    },
  }
}

/** Status view of a gateway: origin, path prefix and header names only. */
export function claudeGatewayStatus(
  gateway: ClaudeGateway | undefined,
): ClaudeGatewayStatus | undefined {
  if (!gateway) return undefined
  return {
    origin: gateway.origin,
    pathPrefix: gateway.pathPrefix,
    headerNames: gateway.headers.map(([name]) => name),
  }
}

/**
 * True when `url` is inside the gateway: same scheme, host and port, and a
 * path equal to the prefix or below it.
 */
export function isClaudeGatewayUrl(url: URL, gateway: ClaudeGateway): boolean {
  let origin: URL
  try {
    origin = new URL(gateway.origin)
  } catch {
    return false
  }
  if (url.protocol !== origin.protocol || url.origin !== origin.origin)
    return false
  if (url.username || url.password) return false
  if (!gateway.pathPrefix) return true
  return (
    url.pathname === gateway.pathPrefix ||
    url.pathname.startsWith(`${gateway.pathPrefix}/`)
  )
}

const MODEL_REQUEST_PATH = '/v1/messages'
const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com'

function hasDotSegment(raw: string): boolean {
  // `new URL` resolves `.` and `..` (also written `%2e`) silently, so the
  // original text is checked before parsing.
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(raw)?.[1] ?? ''
  return path.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))
}

/**
 * Where a model request goes through the gateway, or undefined when `url` is
 * not a model request the gateway takes. A model request URL is a URL on
 * `https://api.anthropic.com`, or inside the gateway, whose path ends in
 * `/v1/messages` once repeated slashes are collapsed; a provider base URL can
 * add a path in front of it. It always goes to `<gateway prefix>/v1/messages`
 * with its query (`?beta=true`) kept. A path with `.` or `..` segments, other
 * Anthropic endpoints and other hosts are left alone, so the OAuth
 * destination check still decides them without the gateway.
 */
export function claudeGatewayModelUrl(
  url: string | URL,
  gateway: ClaudeGateway,
): URL | undefined {
  if (typeof url === 'string' && hasDotSegment(url)) return undefined
  let source: URL
  try {
    source = new URL(String(url))
  } catch {
    return undefined
  }
  if (source.username || source.password) return undefined
  const path = source.pathname.replace(/\/{2,}/g, '/')
  if (!path.endsWith(MODEL_REQUEST_PATH)) return undefined
  const direct =
    source.protocol === 'https:' && source.origin === ANTHROPIC_API_ORIGIN
  if (!direct && !isClaudeGatewayUrl(source, gateway)) return undefined
  const target = new URL(gateway.origin)
  target.pathname = `${gateway.pathPrefix}${MODEL_REQUEST_PATH}`
  target.search = source.search
  return target
}

/** Adds the gateway headers to a request's headers. */
export function applyClaudeGatewayHeaders(
  headers: Headers,
  gateway: ClaudeGateway,
): Headers {
  for (const [name, value] of gateway.headers) headers.set(name, value)
  return headers
}

// Every gateway header name and value ever configured in this process. The
// sets never shrink, so a dump or error read just after a settings change
// still hides an earlier header's value. Request dumps redact the names;
// provider-error redaction replaces the values wherever they appear.
const secretHeaderNames = new Set<string>()
const secretHeaderValues = new Set<string>()

/** Records a gateway's header names and values as secrets. */
export function rememberClaudeGatewaySecrets(
  gateway: ClaudeGateway | undefined,
): void {
  for (const [name, value] of gateway?.headers ?? []) {
    secretHeaderNames.add(name.toLowerCase())
    if (value) secretHeaderValues.add(value)
  }
}

/** True for a configured gateway header name; its value must not be dumped. */
export function isClaudeGatewaySecretHeader(name: string): boolean {
  return secretHeaderNames.has(name.toLowerCase())
}

/**
 * Every gateway header value configured in this process, for provider-error
 * redaction of sends that cannot tell which gateway they used.
 */
export function claudeGatewaySecretValues(): string[] {
  return [...secretHeaderValues]
}

/** The header values one gateway send carries, for provider-error redaction. */
export function claudeGatewayHeaderValues(
  gateway: ClaudeGateway | undefined,
): string[] {
  return (gateway?.headers ?? []).map(([, value]) => value).filter(Boolean)
}

const warnedRelayIgnored = new Set<string>()

/**
 * Logs once per gateway destination that the configured relay is not used: the
 * gateway takes model requests, and nothing falls back to the relay or to
 * api.anthropic.com.
 */
export function warnClaudeGatewayRelayIgnored(gateway: ClaudeGateway): void {
  const key = `${gateway.origin}${gateway.pathPrefix}`
  if (warnedRelayIgnored.has(key)) return
  warnedRelayIgnored.add(key)
  logger.warn(
    'gateway',
    'a relay is configured, but Claude OAuth model requests use the gateway from the settings file; the relay is not used for them',
  )
}
