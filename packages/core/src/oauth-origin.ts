import {
  applyClaudeGatewayHeaders,
  type ClaudeGateway,
  claudeGatewayModelUrl,
  isClaudeGatewayUrl,
} from './gateway.ts'
import { copyStreamResponseTiming } from './stream-completion.ts'

/**
 * Where a Claude OAuth access token may be sent.
 *
 * A Claude sign-in (OAuth) access token is sent only to Anthropic's own HTTPS
 * API server, unless a caller explicitly allows one test-only loopback origin
 * (see `extraOrigin`). Hosts take the request URL from provider configuration,
 * and that configuration can come from a project file in a repository the
 * user opened, so the URL alone is not trusted: every OAuth send checks its
 * final URL here before the token leaves the process. API-key routes are not
 * checked here; they keep whatever base URL the user configured.
 *
 * Model requests may also go to the gateway the user named in their own
 * settings file (see gateway.ts). Only the model-request send passes that
 * gateway here; sign-in, refresh, usage and other sends never do, so they
 * stay limited to api.anthropic.com.
 */

export const ANTHROPIC_OAUTH_ORIGIN = 'https://api.anthropic.com'

/** Fixed refusal text. It never includes the refused URL or any credential. */
export const ANTHROPIC_OAUTH_ORIGIN_REFUSAL =
  'Claude OAuth requests can only go to https://api.anthropic.com. A provider baseURL that points elsewhere is not used for Claude sign-in accounts.'

/**
 * A Claude OAuth request was refused locally because its destination is not
 * Anthropic's API server. Nothing was sent, and another account cannot help,
 * so callers treat it as a terminal request error, not an account failure.
 */
export class AnthropicOAuthOriginError extends Error {
  readonly check = 'oauth_destination'

  constructor() {
    super(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
    this.name = 'AnthropicOAuthOriginError'
  }
}

export interface AnthropicOAuthOriginOptions {
  /**
   * One more exact origin (scheme, host and port) the caller accepts besides
   * Anthropic's. Hosts use it only for a test-only loopback server; it is
   * never derived from provider configuration.
   */
  readonly extraOrigin?: string
  /**
   * The user's gateway from their settings file, for model requests only.
   * A URL with its exact origin and under its path prefix is accepted. Never
   * derived from provider configuration or the environment.
   */
  readonly gateway?: ClaudeGateway
  /**
   * Builds the error thrown for a refused URL. `unparseable` means the value
   * is not a URL at all. Defaults to AnthropicOAuthOriginError for both.
   */
  readonly refusal?: (reason: 'unparseable' | 'destination') => Error
}

function sameOrigin(url: URL, origin: string): boolean {
  let allowed: URL
  try {
    allowed = new URL(origin)
  } catch {
    return false
  }
  // Compare the scheme too: a `blob:` URL reports its inner URL's origin.
  return url.protocol === allowed.protocol && url.origin === allowed.origin
}

/**
 * Returns the parsed URL when an OAuth token may be sent to it: HTTPS on
 * api.anthropic.com's default port (or the caller's extra origin, or inside
 * the caller's gateway), with no user name or password in the URL. Throws
 * otherwise.
 */
export function requireAnthropicOAuthOrigin(
  value: string,
  options: AnthropicOAuthOriginOptions = {},
): URL {
  const refuse = options.refusal ?? (() => new AnthropicOAuthOriginError())
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw refuse('unparseable')
  }
  if (url.username || url.password) throw refuse('destination')
  if (url.protocol === 'https:' && url.origin === ANTHROPIC_OAUTH_ORIGIN)
    return url
  if (options.extraOrigin && sameOrigin(url, options.extraOrigin)) return url
  if (options.gateway && isClaudeGatewayUrl(url, options.gateway)) return url
  throw refuse('destination')
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input)
}

/**
 * A fetch for OAuth sends. It checks each URL with
 * requireAnthropicOAuthOrigin before dispatch, always sets
 * `redirect: 'error'`, so an approved destination cannot forward the token
 * elsewhere with a redirect, and drops any `tls` option, so certificate
 * checks always apply. It calls the global fetch at call time, so test
 * stubs installed later still apply. Options are read on every call when
 * given as a function.
 */
export function createAnthropicOAuthFetch(
  options:
    | AnthropicOAuthOriginOptions
    | (() => AnthropicOAuthOriginOptions) = {},
): typeof fetch {
  const current = () => (typeof options === 'function' ? options() : options)
  return Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const signal =
        init?.signal !== undefined
          ? init.signal
          : input instanceof Request
            ? input.signal
            : undefined
      signal?.throwIfAborted()
      requireAnthropicOAuthOrigin(fetchInputUrl(input), current())
      const sentAt = performance.now()
      // Bun's `tls` option can turn certificate checks off, and a caller may
      // build it from the environment, which can come from a repository's
      // `.env`. An OAuth send always uses the default checks, so an on-path
      // attacker cannot take the token.
      const { tls: _tls, ...checked } = (init ?? {}) as RequestInit & {
        tls?: unknown
      }
      const response = await fetch(input, { ...checked, redirect: 'error' })
      return copyStreamResponseTiming(response, response, sentAt)
    },
    {
      preconnect: (...args: Parameters<typeof fetch.preconnect>) => {
        requireAnthropicOAuthOrigin(String(args[0]), current())
        return fetch.preconnect(...args)
      },
    },
  )
}

export interface ClaudeModelFetchOptions {
  /** Origin options for every send (test-only loopback, refusal wording). */
  readonly origin?:
    | AnthropicOAuthOriginOptions
    | (() => AnthropicOAuthOriginOptions)
  /**
   * The user's gateway, or undefined for none. A function is read on every
   * call, so a keep-warm or Prime send follows the current settings; a live
   * request passes the value it read once, so all its sends agree.
   */
  readonly gateway?:
    | ClaudeGateway
    | undefined
    | (() => ClaudeGateway | undefined)
}

/**
 * A fetch for Claude OAuth model requests (`POST /v1/messages`). Without a
 * gateway it is createAnthropicOAuthFetch. With one, a model request to
 * api.anthropic.com goes to the gateway instead, carrying the gateway
 * headers; only the URL and those headers change. Other URLs are not moved
 * and are checked without the gateway, so nothing but a model request can
 * reach it. Redirects are refused either way.
 */
export function createClaudeModelFetch(
  options: ClaudeModelFetchOptions = {},
): typeof fetch {
  const origin = () =>
    typeof options.origin === 'function'
      ? options.origin()
      : (options.origin ?? {})
  const gatewayNow = () =>
    typeof options.gateway === 'function' ? options.gateway() : options.gateway
  const direct = createAnthropicOAuthFetch(origin)
  return Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const gateway = gatewayNow()
      const url = fetchInputUrl(input)
      const target =
        gateway &&
        (init?.method ?? requestMethod(input)).toUpperCase() === 'POST'
          ? claudeGatewayModelUrl(url, gateway)
          : undefined
      if (!gateway || !target) return direct(input, init)
      const headers = applyClaudeGatewayHeaders(
        new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : {}),
        ),
        gateway,
      )
      const routed =
        input instanceof Request
          ? new Request(target.toString(), input)
          : target
      return createAnthropicOAuthFetch(() => ({ ...origin(), gateway }))(
        routed,
        { ...init, headers },
      )
    },
    { preconnect: direct.preconnect },
  )
}

function requestMethod(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.method : 'GET'
}
