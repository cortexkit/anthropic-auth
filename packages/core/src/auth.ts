import {
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants.ts'
import { generatePKCE } from './pkce.ts'

type CallbackParams = {
  code: string
  state: string
}

function parseRetryAfterHeader(value: string | undefined | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds)
  const date = Date.parse(value)
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000)
    return delta > 0 ? delta : undefined
  }
  return undefined
}

export class ClaudeOAuthRefreshError extends Error {
  /** Parsed Retry-After value in seconds, if the server provided one. */
  public readonly retryAfter: number | undefined

  constructor(
    public readonly status: number,
    public readonly body: string,
    retryAfterHeader?: string | null,
  ) {
    super(`Claude OAuth refresh failed: ${status} — ${body}`)
    this.name = 'ClaudeOAuthRefreshError'
    this.retryAfter = parseRetryAfterHeader(retryAfterHeader ?? undefined)
  }
}

export type ClaudeOAuthRefreshResult = {
  access: string
  refresh: string
  expires: number
  expiresIn: number
}

function isTransientNetworkError(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return (
    error.message.includes('fetch failed') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  )
}

export async function refreshClaudeOAuthToken(input: {
  refreshToken: string
  fetchImpl?: typeof fetch
  now?: () => number
  maxRetries?: number
  baseDelayMs?: number
}): Promise<ClaudeOAuthRefreshResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  const maxRetries = input.maxRetries ?? 2
  const baseDelayMs = input.baseDelayMs ?? 500

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }

      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: input.refreshToken,
          client_id: CLIENT_ID,
        }),
      })

      if (!response.ok) {
        if (response.status >= 500 && attempt < maxRetries) {
          await response.body?.cancel().catch(() => {})
          continue
        }
        const body = await response.text().catch(() => '')
        throw new ClaudeOAuthRefreshError(
          response.status,
          body,
          response.headers.get('retry-after'),
        )
      }

      const json = (await response.json()) as {
        access_token: string
        refresh_token?: string
        expires_in: number
      }
      const refreshedAt = input.now?.() ?? Date.now()

      return {
        access: json.access_token,
        refresh: json.refresh_token ?? input.refreshToken,
        expires: refreshedAt + json.expires_in * 1000,
        expiresIn: json.expires_in,
      }
    } catch (error) {
      if (error instanceof ClaudeOAuthRefreshError) throw error
      if (attempt < maxRetries && isTransientNetworkError(error)) continue
      throw error
    }
  }

  throw new Error('Token refresh exhausted all retries')
}

export type AuthorizationResult = {
  url: string
  redirectUri: string
  state: string
  verifier: string
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, '')
}

function parseCallbackInput(input: string) {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) {
      return { code, state }
    }
  } catch {
    // Fall through to legacy/manual formats.
  }

  const hashSplits = trimmed.split('#')
  if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
    return { code: hashSplits[0], state: hashSplits[1] }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) {
    return { code, state }
  }

  return null
}

async function exchangeCode(
  callback: CallbackParams,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })

  if (!result.ok) {
    return {
      type: 'failed',
    }
  }

  const json = (await result.json()) as {
    refresh_token: string
    access_token: string
    expires_in: number
  }

  return {
    type: 'success',
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1000,
  }
}

export async function authorize(
  mode: 'max' | 'console',
): Promise<AuthorizationResult> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URLS[mode], import.meta.url)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CODE_CALLBACK_URL)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  }
}

export type ExchangeResult =
  | { type: 'success'; refresh: string; access: string; expires: number }
  | { type: 'failed' }

export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<ExchangeResult> {
  const callback = parseCallbackInput(input)
  if (!callback) {
    return {
      type: 'failed',
    }
  }

  if (expectedState && callback.state !== expectedState) {
    return {
      type: 'failed',
    }
  }

  return exchangeCode(callback, verifier, redirectUri)
}
