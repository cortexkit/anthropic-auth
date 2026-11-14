import {
  type AnthropicOAuthOriginOptions,
  type ClaudeGateway,
  createAnthropicOAuthFetch,
  createClaudeModelFetch,
  logger,
  requireAnthropicOAuthOrigin,
} from '@cortexkit/anthropic-auth-core'

/**
 * Test-only escape hatch for the OAuth destination rule.
 *
 * End-to-end suites run a real OpenCode process against a local mock of the
 * Anthropic API, so they need OAuth sends to reach a loopback server. Test
 * code sets the server's exact origin (for example `http://127.0.0.1:43123`)
 * on `globalThis` under this symbol, from a test preload or a test-only
 * plugin loaded before this one; it is then allowed in addition to
 * api.anthropic.com. Only an `http://` or `https://` origin on 127.0.0.1,
 * [::1] or localhost, with an explicit port and no user name, password, path,
 * query or fragment, is accepted; any other value is ignored, so OAuth stays
 * limited to api.anthropic.com.
 *
 * It is deliberately not an environment variable: OpenCode started from
 * source loads a `.env` file from the working directory, so an opened
 * repository could set one. Only code already running in the process can set
 * this symbol. ANTHROPIC_BASE_URL never widens the rule. It is not a user
 * setting and is deliberately left out of the public documentation.
 */
export const TEST_OAUTH_LOOPBACK_ORIGIN_KEY = Symbol.for(
  'cortexkit.anthropic-auth.test-oauth-loopback-origin',
)

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

let warnedValue: string | undefined

/** The accepted loopback origin from TEST_OAUTH_LOOPBACK_ORIGIN_KEY, if any. */
export function testOAuthLoopbackOrigin(): string | undefined {
  const raw = (globalThis as Record<symbol, unknown>)[
    TEST_OAUTH_LOOPBACK_ORIGIN_KEY
  ]
  if (typeof raw !== 'string' || !raw) return undefined
  const accepted = parseLoopbackOrigin(raw)
  // Warn once per distinct value so the hatch is never silently active.
  if (warnedValue !== raw) {
    warnedValue = raw
    if (accepted)
      logger.warn(
        'oauth-destination',
        'test-only loopback origin is allowed for Claude OAuth requests',
      )
    else
      logger.warn(
        'oauth-destination',
        'ignored an invalid test-only loopback origin; Claude OAuth requests stay limited to https://api.anthropic.com',
      )
  }
  return accepted
}

function parseLoopbackOrigin(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined
  // An explicit port only: `url.port` is empty when none (or the default) is given.
  if (!url.port) return undefined
  // The value must be the bare origin; a path, even "/", is refused.
  if (raw !== url.origin) return undefined
  return url.origin
}

function originOptions(gateway?: ClaudeGateway): AnthropicOAuthOriginOptions {
  const extraOrigin = testOAuthLoopbackOrigin()
  return {
    ...(extraOrigin ? { extraOrigin } : {}),
    ...(gateway ? { gateway } : {}),
  }
}

/**
 * Throws AnthropicOAuthOriginError unless an OAuth token may be sent to
 * `url`. Call it with the final URL, after rewriteUrl has applied any
 * ANTHROPIC_BASE_URL or provider baseURL, so neither can redirect a token.
 *
 * ANTHROPIC_BASE_URL is not trusted either. OpenCode's release binaries are
 * built with Bun's `.env` autoloading turned off, but OpenCode started with
 * `bun run` (from source) loads a `.env` file from the working directory, so
 * an opened repository could set the variable. An OAuth token therefore goes
 * only to api.anthropic.com whatever the variable says.
 *
 * Pass `gateway` only for a model request: it is the user's gateway from
 * their own settings file (NativeAccountRuntime.getClaudeGateway), never a
 * value taken from provider configuration or the environment.
 */
export function requireOAuthDestination(
  url: string,
  gateway?: ClaudeGateway,
): URL {
  return requireAnthropicOAuthOrigin(url, originOptions(gateway))
}

/** True when an OAuth token may be sent to `url`. */
export function isAllowedOAuthDestination(
  url: string,
  gateway?: ClaudeGateway,
): boolean {
  try {
    requireOAuthDestination(url, gateway)
    return true
  } catch {
    return false
  }
}

/**
 * Fetch for OAuth sends: rechecks the destination on every call and refuses
 * redirects.
 */
export const fetchOAuth: typeof fetch = createAnthropicOAuthFetch(originOptions)

/**
 * Fetch for OAuth model requests: like fetchOAuth, but a model request goes
 * to the user's gateway with its headers when one is set. See
 * createClaudeModelFetch.
 */
export function fetchOAuthModel(
  gateway: ClaudeGateway | undefined | (() => ClaudeGateway | undefined),
): typeof fetch {
  return createClaudeModelFetch({ origin: () => originOptions(), gateway })
}
