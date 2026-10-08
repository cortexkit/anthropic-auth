const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'

/** Model base URLs and remembered cache-warm URLs must send OAuth tokens only to Anthropic’s HTTPS server. */
export function requirePiOAuthOrigin(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Native OAuth requires the official Anthropic HTTPS origin')
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== ANTHROPIC_ORIGIN ||
    url.username ||
    url.password
  )
    throw new Error(
      'Native OAuth requires the official Anthropic HTTPS origin without URL userinfo',
    )
  return url
}

export function buildPiOAuthMessagesUrl(baseUrl: string): URL {
  return new URL('/v1/messages?beta=true', requirePiOAuthOrigin(baseUrl))
}

/** Reject redirects rather than letting an approved OAuth destination forward the request. */
export const fetchPiOAuth: typeof fetch = Object.assign(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requirePiOAuthOrigin(input instanceof Request ? input.url : String(input))
    return fetch(input, { ...init, redirect: 'error' })
  },
  {
    preconnect: (...args: Parameters<typeof fetch.preconnect>) => {
      requirePiOAuthOrigin(String(args[0]))
      return fetch.preconnect(...args)
    },
  },
)
