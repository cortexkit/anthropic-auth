import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  applyClaudeCodeHeaders,
  applyClaudeCodeMetadata,
  CLAUDE_CODE_FULL_AGENT_BETAS,
  type ClaudeCodeIdentity,
  orderClaudeCodeBody,
  REQUIRED_BETAS,
  resolveClaudeCodeIdentity,
  selectClaudeCodeBetas,
} from '@marcusrbrown/anthropic-auth-core'

describe('Claude Code fingerprint helpers', () => {
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

    expect(betas).not.toContain('advanced-tool-use-2025-11-20')
    expect(betas).not.toContain('context-1m-2025-08-07')
    expect(betas).not.toContain('effort-2025-11-24')
    expect(betas).not.toContain('extended-cache-ttl-2025-04-11')
  })

  test('does not add full-agent betas when request shape is unavailable', () => {
    const betas = selectClaudeCodeBetas(null).split(',')

    for (const beta of REQUIRED_BETAS) expect(betas).toContain(beta)
    expect(betas).not.toContain('advanced-tool-use-2025-11-20')
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

    expect(headers.get('user-agent')).toBe(
      'claude-cli/2.1.141 (external, sdk-cli)',
    )
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
        expect(url.searchParams.get('entrypoint')).toBe('sdk-cli')
        expect(url.searchParams.get('model')).toBe('claude-sonnet-4-6')

        const headers = new Headers(init?.headers)
        expect(headers.get('user-agent')).toBe('claude-code/2.1.141')
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
    )

    expect(identity.accountUuid).toBe('11111111-2222-4333-8444-555555555555')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not invent account UUID or metadata when bootstrap fails', async () => {
    const fetchMock = mock(async () => new Response('nope', { status: 503 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const identity = await resolveClaudeCodeIdentity(
      'sk-ant-oat-bootstrap-fails',
    )
    const body: Record<string, unknown> = {
      metadata: { user_id: 'stale-user-id', other: 'preserved' },
    }

    expect(identity.accountUuid).toBeUndefined()
    expect(applyClaudeCodeMetadata(body, identity)).toBe(false)
    expect(body.metadata).toEqual({ other: 'preserved' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('keeps identity stable across rotated access tokens for the same account UUID', async () => {
    const accountUuid = 'c7b3bc43-f4d8-48c6-a30f-7fd81a8db03f'
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ oauth_account: { account_uuid: accountUuid } }),
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const first = await resolveClaudeCodeIdentity('sk-ant-oat-rotation-a')
    const second = await resolveClaudeCodeIdentity('sk-ant-oat-rotation-b')

    expect(first.accountUuid).toBe(accountUuid)
    expect(second.accountUuid).toBe(accountUuid)
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.sessionId).toBe(first.sessionId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
