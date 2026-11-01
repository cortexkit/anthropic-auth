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
 * api.anthropic.com's default port (or the caller's extra origin), with no
 * user name or password in the URL. Throws otherwise.
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
  throw refuse('destination')
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input)
}

/**
 * A fetch for OAuth sends. It checks each URL with
 * requireAnthropicOAuthOrigin before dispatch and always sets
 * `redirect: 'error'`, so an approved destination cannot forward the token
 * elsewhere with a redirect. It calls the global fetch at call time, so test
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
      return fetch(input, { ...init, redirect: 'error' })
    },
    {
      preconnect: (...args: Parameters<typeof fetch.preconnect>) => {
        requireAnthropicOAuthOrigin(String(args[0]), current())
        return fetch.preconnect(...args)
      },
    },
  )
}
