import type { OAuthAccountProfile } from './accounts.ts'

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

export const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function fetchOAuthAccountProfile(input: {
  accessToken: string
  accountIdentity?: string
  fetchImpl?: typeof fetch
  now?: () => number
  signal?: AbortSignal
}): Promise<OAuthAccountProfile> {
  const response = await (input.fetchImpl ?? fetch)(PROFILE_URL, {
    method: 'GET',
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
    },
  })
  if (!response.ok) {
    throw new Error(`Claude profile check failed: ${response.status}`)
  }
  const value = (await response.json()) as {
    organization?: {
      organization_type?: unknown
      rate_limit_tier?: unknown
    }
  }
  const tier = value.organization?.rate_limit_tier
  const orgType = value.organization?.organization_type
  if (
    typeof tier !== 'string' ||
    tier.trim() === '' ||
    typeof orgType !== 'string' ||
    orgType.trim() === ''
  ) {
    throw new Error('Claude profile response is missing account metadata')
  }
  return {
    tier,
    orgType,
    checkedAt: input.now?.() ?? Date.now(),
    ...(input.accountIdentity !== undefined && {
      accountIdentity: input.accountIdentity,
    }),
  }
}

export function oauthProfileMatchesIdentity(
  profile: OAuthAccountProfile | undefined,
  accountIdentity: string | undefined,
) {
  if (!profile) return false
  if (accountIdentity === undefined) return true
  return (
    profile.accountIdentity === undefined ||
    profile.accountIdentity === accountIdentity
  )
}

export function oauthProfileIsFresh(
  profile: OAuthAccountProfile | undefined,
  now = Date.now(),
) {
  return Boolean(
    profile &&
      Number.isFinite(profile.checkedAt) &&
      now >= profile.checkedAt &&
      now - profile.checkedAt < PROFILE_TTL_MS,
  )
}

export function formatOAuthAccountTier(
  profile: OAuthAccountProfile | undefined,
): string | undefined {
  const match = profile?.tier.match(/^default_claude_max_(\d+)x$/)
  if (!match) return undefined
  const label = `Max ${match[1]}x`
  return profile?.orgType === 'claude_team' ? `Team · ${label}` : label
}
