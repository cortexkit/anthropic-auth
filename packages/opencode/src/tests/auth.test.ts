import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  authorize,
  CLIENT_ID,
  ClaudeOAuthRefreshError,
  CODE_CALLBACK_URL,
  exchange,
  OAUTH_SCOPES,
  refreshClaudeOAuthToken,
} from '@cortexkit/anthropic-auth-core'

const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout
  mock.restore()
})

describe('authorize', () => {
  test('returns the hosted callback URL for max mode', async () => {
    const result = await authorize('max')

    expect(result.url).toBeString()
    expect(result.redirectUri).toBe(CODE_CALLBACK_URL)
    expect(result.verifier).toBeString()

    const url = new URL(result.url)
    expect(url.origin).toBe('https://claude.ai')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('returns the hosted callback URL for console mode', async () => {
    const result = await authorize('console')

    const url = new URL(result.url)
    expect(url.origin).toBe('https://platform.claude.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
  })

  test('sets required OAuth query params', async () => {
    const result = await authorize('max')
    const url = new URL(result.url)

    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe(CODE_CALLBACK_URL)
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPES.join(' '))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(result.state)
  })

  test('does not use localhost', async () => {
    const result = await authorize('max')
    expect(result.redirectUri).not.toContain('localhost')
    expect(result.url).not.toContain('localhost')
  })
})

describe('exchange', () => {
  test('accepts code#state format', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    const result = await exchange(
      'mycode#mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    expect(result.type).toBe('success')
    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
    expect(body.redirect_uri).toBe(CODE_CALLBACK_URL)
  })

  test('accepts a full callback URL', async () => {
    let capturedBody: string | undefined

    spyOn(globalThis, 'fetch').mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedBody = init?.body as string
      return Promise.resolve(
        new Response(
          JSON.stringify({
            refresh_token: 'r',
            access_token: 'a',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as typeof fetch)

    await exchange(
      'https://platform.claude.com/oauth/code/callback?code=mycode&state=mystate',
      'myverifier',
      CODE_CALLBACK_URL,
      'mystate',
    )

    const body = JSON.parse(capturedBody!)
    expect(body.code).toBe('mycode')
    expect(body.state).toBe('mystate')
  })

  test('returns failed on invalid callback input', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'not-a-callback',
      'verifier',
      CODE_CALLBACK_URL,
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('returns failed on state mismatch', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(null))) as unknown as typeof fetch)

    const result = await exchange(
      'code#wrong',
      'verifier',
      CODE_CALLBACK_URL,
      'expected',
    )
    expect(result.type).toBe('failed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('refreshClaudeOAuthToken', () => {
  test('uses Anthropic platform JSON refresh path and preserves omitted refresh rotations', async () => {
    let capturedUrl: string | undefined
    let capturedBody: string | undefined
    let capturedHeaders: Headers | undefined

    const result = await refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      now: () => 1_000,
      fetchImpl: mock((input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input)
        capturedBody = String(init?.body)
        capturedHeaders = new Headers(init?.headers)
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'new-access', expires_in: 3600 }),
            { status: 200 },
          ),
        )
      }) as unknown as typeof fetch,
    })

    expect(capturedUrl).toBe('https://platform.claude.com/v1/oauth/token')
    expect(capturedHeaders?.get('content-type')).toBe('application/json')
    const body = JSON.parse(capturedBody ?? '{}')
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('old-refresh')
    expect(body.client_id).toBe(CLIENT_ID)
    expect(result).toEqual({
      access: 'new-access',
      refresh: 'old-refresh',
      expires: 3_601_000,
      expiresIn: 3600,
    })
  })

  test('retries transient OAuth refresh failures in the shared helper', async () => {
    let calls = 0
    const setTimeoutMock = mock((handler: () => unknown) => {
      handler()
      return 0
    })
    // @ts-expect-error — mock override for testing
    globalThis.setTimeout = setTimeoutMock

    const result = await refreshClaudeOAuthToken({
      refreshToken: 'old-refresh',
      baseDelayMs: 25,
      fetchImpl: mock(() => {
        calls += 1
        if (calls === 1) {
          return Promise.resolve(new Response('temporary', { status: 500 }))
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }) as unknown as typeof fetch,
    })

    expect(calls).toBe(2)
    expect(setTimeoutMock).toHaveBeenCalledWith(expect.any(Function), 25)
    expect(result.refresh).toBe('new-refresh')
  })

  test('does not retry OAuth refresh rate limits or invalid grants', async () => {
    for (const status of [400, 429]) {
      let calls = 0
      await expect(
        refreshClaudeOAuthToken({
          refreshToken: 'old-refresh',
          fetchImpl: mock(() => {
            calls += 1
            return Promise.resolve(
              new Response(
                status === 400
                  ? JSON.stringify({ error: 'invalid_grant' })
                  : JSON.stringify({
                      error: {
                        type: 'rate_limit_error',
                        message: 'Rate limited',
                      },
                    }),
                { status },
              ),
            )
          }) as unknown as typeof fetch,
        }),
      ).rejects.toThrow(`Claude OAuth refresh failed: ${status}`)
      expect(calls).toBe(1)
    }
  })
})

describe('ClaudeOAuthRefreshError', () => {
  test('captures Retry-After header as seconds', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', '60')
    expect(error.retryAfter).toBe(60)
  })

  test('captures Retry-After header as HTTP date', () => {
    const futureDate = new Date(Date.now() + 120_000).toUTCString()
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', futureDate)
    expect(error.retryAfter).toBeGreaterThan(0)
    expect(error.retryAfter).toBeLessThanOrEqual(121)
  })

  test('retryAfter is undefined when header missing', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited')
    expect(error.retryAfter).toBeUndefined()
  })

  test('retryAfter is undefined for non-parseable values', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', 'garbage')
    expect(error.retryAfter).toBeUndefined()
  })
})
