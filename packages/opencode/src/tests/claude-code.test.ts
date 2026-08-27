import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  applyClaudeCodeHeaders,
  applyClaudeCodeMetadata,
  CLAUDE_CODE_FULL_AGENT_BETAS,
  type ClaudeCodeIdentity,
  getClaudeCodeIdentity,
  orderClaudeCodeBody,
  REQUIRED_BETAS,
  resetClaudeCodeIdentityCachesForTest,
  resolveClaudeCodeIdentity,
  selectClaudeCodeBetas,
} from '@cortexkit/anthropic-auth-core'

describe('Claude Code fingerprint helpers', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    resetClaudeCodeIdentityCachesForTest()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('compare-and-clear prevents a negative bootstrap from leaking a slot UUID', async () => {
    globalThis.fetch = mock((_input: any, init: RequestInit = {}) => {
      const authorization = new Headers(init.headers).get('authorization')
      return Promise.resolve(
        authorization?.includes('sk-ant-oat-isolation-seed')
          ? Response.json({ oauth_account: { account_uuid: 'uuid-isolation' } })
          : Response.json({}),
      )
    }) as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity(
      'sk-ant-oat-isolation-seed',
      undefined,
      'isolation-main',
    )
    expect(first.accountUuid).toBe('uuid-isolation')

    const second = await resolveClaudeCodeIdentity(
      'sk-ant-oat-isolation-next',
      undefined,
      'isolation-main',
    )
    // This assertion pins the production compare-and-clear against the seeded UUID.
    expect(second.accountUuid).toBeUndefined()

    // No reset runs between these resolves, so the slot device identity remains stable.
    expect(second.deviceId).toBe(first.deviceId)
  })

  test('explicit identity-cache reset clears a slot device identity', async () => {
    globalThis.fetch = mock((_input: any, init: RequestInit = {}) => {
      const authorization = new Headers(init.headers).get('authorization')
      return Promise.resolve(
        authorization?.includes('sk-ant-oat-isolation-reset-seed')
          ? Response.json({ oauth_account: { account_uuid: 'uuid-reset' } })
          : Response.json({}),
      )
    }) as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity(
      'sk-ant-oat-isolation-reset-seed',
      undefined,
      'isolation-reset-main',
    )
    expect(first.accountUuid).toBe('uuid-reset')

    resetClaudeCodeIdentityCachesForTest()

    const second = await resolveClaudeCodeIdentity(
      'sk-ant-oat-isolation-reset-next',
      undefined,
      'isolation-reset-main',
    )
    // This assertion pins the explicit test reset, not production UUID clearing.
    expect(second.deviceId).not.toBe(first.deviceId)
  })

  test('selects the live-captured full-agent beta set only for tool-bearing agent requests', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'system' }],
      tools: [{ name: 'mcp_Read', input_schema: { type: 'object' } }],
      thinking: { type: 'adaptive' },
      context_management: { edits: [] },
      output_config: { effort: 'high' },
      diagnostics: { enabled: true },
      stream: true,
    }

    expect(selectClaudeCodeBetas(body).split(',')).toEqual([
      ...CLAUDE_CODE_FULL_AGENT_BETAS,
    ])
    const fullBetas = selectClaudeCodeBetas(body).split(',')
    expect(fullBetas[0]).toBe('oauth-2025-04-20')
    expect(fullBetas).toContain('thinking-token-count-2026-05-13')
    expect(fullBetas).not.toContain('redact-thinking-2026-02-12')
    expect(fullBetas).toContain('claude-code-20250219')
    expect(fullBetas).not.toContain('context-1m-2025-08-07')
    expect(fullBetas).not.toContain('effort-2025-11-24')
  })

  test('selects structured-output betas without full-agent private betas', () => {
    const betas = selectClaudeCodeBetas({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'title' }],
      system: [{ type: 'text', text: 'system' }],
      tools: [],
      output_config: { format: { type: 'json_schema' } },
      stream: true,
    }).split(',')

    expect(betas).toContain('structured-outputs-2025-12-15')
    expect(betas).toContain('thinking-token-count-2026-05-13')
    expect(betas).not.toContain('redact-thinking-2026-02-12')
    expect(betas).not.toContain('claude-code-20250219')
    expect(betas).not.toContain('advanced-tool-use-2025-11-20')
    expect(betas).not.toContain('context-1m-2025-08-07')
    expect(betas).not.toContain('extended-cache-ttl-2025-04-11')
  })

  test('does not add full-agent-only betas for tool requests missing captured companion fields', () => {
    const betas = selectClaudeCodeBetas({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      system: [{ type: 'text', text: 'system' }],
      tools: [{ name: 'mcp_Read', input_schema: { type: 'object' } }],
      stream: true,
    }).split(',')

    expect(betas).toContain('thinking-token-count-2026-05-13')
    expect(betas).toContain('advanced-tool-use-2025-11-20')
    expect(betas).toContain('extended-cache-ttl-2025-04-11')
    expect(betas).not.toContain('claude-code-20250219')
    expect(betas).not.toContain('context-1m-2025-08-07')
    expect(betas).not.toContain('effort-2025-11-24')
    expect(betas).not.toContain('redact-thinking-2026-02-12')
  })

  test('does not add full-agent betas when request shape is unavailable', () => {
    const betas = selectClaudeCodeBetas(null).split(',')

    for (const beta of REQUIRED_BETAS) expect(betas).toContain(beta)
    expect(betas[0]).toBe('oauth-2025-04-20')
    expect(betas).toContain('thinking-token-count-2026-05-13')
    expect(betas).not.toContain('redact-thinking-2026-02-12')
    expect(betas).not.toContain('claude-code-20250219')
  })

  test('applies Claude Code headers and couples session id to metadata', () => {
    const identity: ClaudeCodeIdentity = {
      deviceId: 'a'.repeat(64),
      accountUuid: '11111111-2222-4333-8444-555555555555',
      sessionId: '66666666-7777-4888-9999-aaaaaaaaaaaa',
    }
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      messages: [],
      system: [],
      tools: [{ name: 'mcp_Read' }],
    }

    applyClaudeCodeMetadata(body, identity)
    const headers = applyClaudeCodeHeaders(
      new Headers({ 'anthropic-beta': 'custom-beta' }),
      'sk-ant-oat-test',
      { body, identity },
    )

    expect(headers.get('user-agent')).toBe('claude-cli/2.1.177 (external, cli)')
    expect(headers.get('x-claude-code-session-id')).toBe(identity.sessionId)
    expect(headers.get('x-stainless-package-version')).toBe('0.94.0')
    expect(headers.get('x-stainless-runtime-version')).toBe('v24.3.0')
    expect(headers.get('x-app')).toBe('cli')
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe(
      'true',
    )
    expect(headers.get('anthropic-beta')).toContain('custom-beta')

    const userId = JSON.parse(
      (body.metadata as { user_id: string }).user_id,
    ) as Record<string, string>
    expect(userId).toEqual({
      device_id: identity.deviceId,
      account_uuid: '11111111-2222-4333-8444-555555555555',
      session_id: identity.sessionId,
    })
  })

  test('shares the no-account identity between resolution and default headers', async () => {
    const accessToken = 'sk-ant-oat-no-account-identity-split'
    const fetchMock = mock(async () => new Response('stubbed', { status: 503 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const resolvedIdentity = await resolveClaudeCodeIdentity(
      accessToken,
      undefined,
      undefined,
    )
    const headers = applyClaudeCodeHeaders(new Headers(), accessToken)
    const defaultHeaderIdentity = getClaudeCodeIdentity(accessToken)

    expect(defaultHeaderIdentity.deviceId).toBe(resolvedIdentity.deviceId)
    expect(defaultHeaderIdentity.sessionId).toBe(resolvedIdentity.sessionId)
    expect(headers.get('x-claude-code-session-id')).toBe(
      resolvedIdentity.sessionId,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('clears a cached account UUID after negative bootstrap before compatibility fallback', async () => {
    const successfulToken = 'sk-ant-oat-negative-cache-success'
    const failedToken = 'sk-ant-oat-negative-cache-failure'
    globalThis.fetch = mock(async (_input, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization')
      if (token?.includes(successfulToken)) {
        return Response.json({
          oauth_account: { account_uuid: 'account-a' },
        })
      }
      return new Response('bootstrap unavailable', { status: 503 })
    }) as unknown as typeof fetch

    const successful = await resolveClaudeCodeIdentity(
      successfulToken,
      undefined,
      'main-slot',
    )
    expect(successful.accountUuid).toBe('account-a')

    const failed = await resolveClaudeCodeIdentity(
      failedToken,
      undefined,
      'main-slot',
    )
    expect(failed.accountUuid).toBeUndefined()

    const compatibility = await resolveClaudeCodeIdentity(
      'compatibility-token-after-failure',
      undefined,
      'main-slot',
    )
    expect(compatibility.accountUuid).toBeUndefined()
  })

  test('late negative bootstrap cannot clobber a newer stable-account identity', async () => {
    const tokenOld = 'sk-ant-oat-late-negative-old'
    const tokenA = 'sk-ant-oat-late-negative-a'
    const tokenB = 'sk-ant-oat-late-negative-b'
    let releaseA!: (response: Response) => void
    let markAStarted!: () => void
    const aStarted = new Promise<void>((resolve) => {
      markAStarted = resolve
    })
    globalThis.fetch = mock(async (_input, init?: RequestInit) => {
      const token = new Headers(init?.headers).get('authorization')
      if (token?.includes(tokenA)) {
        markAStarted()
        return await new Promise<Response>((resolve) => {
          releaseA = resolve
        })
      }
      if (token?.includes(tokenOld)) {
        return Response.json({
          oauth_account: { account_uuid: 'account-a' },
        })
      }
      if (token?.includes(tokenB)) {
        return Response.json({
          oauth_account: { account_uuid: 'account-b' },
        })
      }
      return new Response('unexpected bootstrap token', { status: 503 })
    }) as unknown as typeof fetch

    const initialIdentity = await resolveClaudeCodeIdentity(
      tokenOld,
      undefined,
      'main-slot',
    )
    expect(initialIdentity.accountUuid).toBe('account-a')
    const pendingA = resolveClaudeCodeIdentity(tokenA, undefined, 'main-slot')
    await aStarted
    const identityB = await resolveClaudeCodeIdentity(
      tokenB,
      undefined,
      'main-slot',
    )
    expect(identityB.accountUuid).toBe('account-b')

    releaseA(new Response('bootstrap unavailable', { status: 503 }))
    const identityA = await pendingA
    expect(identityA.accountUuid).toBeUndefined()

    const compatibility = await resolveClaudeCodeIdentity(
      'compatibility-token-after-late-failure',
      undefined,
      'main-slot',
    )
    expect(compatibility.accountUuid).toBe('account-b')
  })

  test('orders serialized body fields like captured Claude Code requests', () => {
    const ordered = orderClaudeCodeBody({
      stream: true,
      diagnostics: {},
      model: 'claude-sonnet-4-6',
      metadata: {},
      messages: [],
      max_tokens: 1024,
      system: [],
      tools: [],
      custom_tail: true,
    })

    expect(JSON.stringify(ordered)).toBe(
      '{"model":"claude-sonnet-4-6","messages":[],"system":[],"tools":[],"metadata":{},"max_tokens":1024,"diagnostics":{},"stream":true,"custom_tail":true}',
    )
  })
})

describe('Claude Code bootstrap identity lookup', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('matches the captured bootstrap request shape enough to resolve account UUID', async () => {
    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input.toString())
        expect(url.pathname).toBe('/api/claude_cli/bootstrap')
        expect(url.searchParams.get('entrypoint')).toBe('cli')
        expect(url.searchParams.get('model')).toBe('claude-sonnet-4-6')

        const headers = new Headers(init?.headers)
        expect(headers.get('user-agent')).toBe('claude-code/2.1.177')
        expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20')
        expect(headers.get('content-type')).toBe('application/json')

        return new Response(
          JSON.stringify({
            oauth_account: {
              account_uuid: '11111111-2222-4333-8444-555555555555',
            },
          }),
        )
      },
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const identity = await resolveClaudeCodeIdentity(
      'sk-ant-oat-test-bootstrap',
      'claude-sonnet-4-6',
      'bootstrap-account',
    )

    expect(identity.accountUuid).toBe('11111111-2222-4333-8444-555555555555')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not invent account UUID or metadata when bootstrap fails', async () => {
    const fetchMock = mock(async () => new Response('nope', { status: 503 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const identity = await resolveClaudeCodeIdentity(
      'sk-ant-oat-bootstrap-fails',
      undefined,
      'failed-account',
    )
    const body: Record<string, unknown> = {
      metadata: { user_id: 'stale-user-id', other: 'preserved' },
    }

    expect(identity.accountUuid).toBeUndefined()
    expect(applyClaudeCodeMetadata(body, identity)).toBe(false)
    expect(body.metadata).toEqual({ other: 'preserved' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('negative-caches failed bootstrap lookups briefly', async () => {
    const fetchMock = mock(async () => new Response('nope', { status: 503 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity(
      'sk-ant-oat-negative-cache',
      undefined,
      'negative-account',
    )
    const second = await resolveClaudeCodeIdentity(
      'sk-ant-oat-negative-cache-rotated',
      undefined,
      'negative-account',
    )

    expect(first.accountUuid).toBeUndefined()
    expect(second.accountUuid).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('does not reuse the previous main-slot account UUID after account replacement', async () => {
    const fetchMock = mock(async () => {
      const uuid =
        fetchMock.mock.calls.length === 1 ? 'main-account-a' : 'main-account-b'
      return new Response(
        JSON.stringify({ oauth_account: { account_uuid: uuid } }),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity(
      'sk-ant-oat-main-account-a',
      undefined,
      'stable-main-slot',
    )
    const second = await resolveClaudeCodeIdentity(
      'sk-ant-oat-main-account-b',
      undefined,
      'stable-main-slot',
    )

    expect(first.accountUuid).toBe('main-account-a')
    expect(second.accountUuid).toBe('main-account-b')
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('keeps device identity stable while refreshing bootstrap UUID per credential', async () => {
    const accountUuid = 'c7b3bc43-f4d8-48c6-a30f-7fd81a8db03f'
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ oauth_account: { account_uuid: accountUuid } }),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity(
      'sk-ant-oat-rotation-a',
      undefined,
      'uuid-account',
    )
    const second = await resolveClaudeCodeIdentity(
      'sk-ant-oat-rotation-b',
      undefined,
      'uuid-account',
    )

    expect(first.accountUuid).toBe(accountUuid)
    expect(second.accountUuid).toBe(accountUuid)
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('keeps device identity stable across rotated credentials for an explicit account identity', async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            oauth_account: {
              account_uuid: 'explicit-account-bootstrap',
            },
          }),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity(
      'sk-ant-oat-explicit-rotation-a',
      undefined,
      'account-a',
    )
    const second = await resolveClaudeCodeIdentity(
      'sk-ant-oat-explicit-rotation-b',
      undefined,
      'account-a',
    )

    expect(second.deviceId).toBe(first.deviceId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('never shares a device identity between distinct account identities', async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            oauth_account: { account_uuid: 'shared-bootstrap-uuid' },
          }),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity(
      'sk-ant-oat-distinct-a',
      undefined,
      'distinct-account-a',
    )
    const second = await resolveClaudeCodeIdentity(
      'sk-ant-oat-distinct-b',
      undefined,
      'distinct-account-b',
    )

    expect(second.deviceId).not.toBe(first.deviceId)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('adopts a legacy cached identity with no account identity', async () => {
    const legacy = getClaudeCodeIdentity('sk-ant-oat-legacy-token')
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            oauth_account: { account_uuid: 'legacy-bootstrap-uuid' },
          }),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const resolved = await resolveClaudeCodeIdentity(
      'sk-ant-oat-legacy-token',
      undefined,
      'legacy-account',
    )

    expect(resolved.deviceId).toBe(legacy.deviceId)
    expect(resolved.sessionId).toBe(legacy.sessionId)
    expect(resolved.accountUuid).toBe('legacy-bootstrap-uuid')
  })

  test('does not reuse an in-flight bootstrap from a rotated credential', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchMock = mock(async () => {
      await gate
      return new Response(
        JSON.stringify({
          oauth_account: { account_uuid: 'in-flight-bootstrap-uuid' },
        }),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const firstPromise = resolveClaudeCodeIdentity(
      'sk-ant-oat-in-flight-a',
      undefined,
      'in-flight-account',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const secondPromise = resolveClaudeCodeIdentity(
      'sk-ant-oat-in-flight-b',
      undefined,
      'in-flight-account',
    )
    release()
    const [first, second] = await Promise.all([firstPromise, secondPromise])

    expect(second.deviceId).toBe(first.deviceId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('keeps Claude Code metadata.user_id on the wire when account identity is missing', async () => {
    const accountUuid = 'missing-identity-bootstrap-uuid'
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ oauth_account: { account_uuid: accountUuid } }),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const identity = await resolveClaudeCodeIdentity(
      'sk-ant-oat-missing-id-wire',
      undefined,
      undefined,
    )
    const body: Record<string, unknown> = { metadata: { stale: true } }
    applyClaudeCodeMetadata(body, identity)
    const wireBody = JSON.parse(JSON.stringify(body)) as {
      metadata?: { user_id?: string }
    }

    expect(identity.accountIdentity).toBeUndefined()
    expect(typeof wireBody.metadata?.user_id).toBe('string')
    expect(wireBody.metadata?.user_id).toContain(accountUuid)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
