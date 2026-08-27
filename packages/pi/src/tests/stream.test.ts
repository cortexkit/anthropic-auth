import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccounts, saveAccounts } from '@cortexkit/anthropic-auth-core'

import {
  buildExplicitBaseMessagesUrl,
  configureApiRouteHeaders,
  parseSse,
  primaryResponseAllowsApiFallback,
  streamCortexKitAnthropic,
} from '../stream.ts'

let tempDir: string | undefined
const originalFetch = globalThis.fetch
const anthropicModel = {
  id: 'claude-fable-5',
  name: 'Claude Fable 5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
} as any
const anthropicContext = {
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  tools: [],
} as any

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  delete process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('Pi API fallback routing helpers', () => {
  test('mints the main account identity when Pi storage omits it', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-main-identity-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveAccounts(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
      },
      storagePath,
    )
    expect((await loadAccounts(storagePath))?.mainAccountId).toBeUndefined()

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = input.toString()
      if (url.includes('/api/claude_cli/bootstrap')) {
        return new Response(
          JSON.stringify({
            oauth_account: { account_uuid: 'pi-main-bootstrap-uuid' },
          }),
        )
      }
      return new Response(
        [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'sk-ant-oat-pi-main',
      sessionId: 'ses_pi_main_identity',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect((await loadAccounts(storagePath))?.mainAccountId).toEqual(
      expect.any(String),
    )
  })

  test('preserves provider base path when building /v1/messages URL', () => {
    const url = buildExplicitBaseMessagesUrl('https://api.kie.ai/claude')

    expect(url.toString()).toBe(
      'https://api.kie.ai/claude/v1/messages?beta=true',
    )
  })

  test('uses bearer auth by default for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'kie-opus',
        type: 'api',
        apiKey: 'kie-key',
        baseURL: 'https://api.kie.ai/claude',
        authHeader: 'authorization-bearer',
      },
      false,
    )

    expect(headers.get('authorization')).toBe('Bearer kie-key')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('only allows API fallback for direct primary quota exhaustion evidence', () => {
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 429 })),
    ).toBe(true)
    expect(primaryResponseAllowsApiFallback('rate_limit_error')).toBe(true)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 403 })),
    ).toBe(false)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 401 })),
    ).toBe(false)
    expect(
      primaryResponseAllowsApiFallback(new Response(null, { status: 200 })),
    ).toBe(false)
  })

  test('supports x-api-key auth mode for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'provider-route',
        type: 'api',
        apiKey: 'provider-key',
        baseURL: 'https://provider.example/anthropic',
        authHeader: 'x-api-key',
      },
      true,
    )

    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBe('provider-key')
    expect(headers.get('anthropic-beta')).toContain('fast-mode-2026-02-01')
  })

  test('sticky-balanced sends the main route when the quota source returns an empty snapshot', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-empty-quota-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    await saveAccounts(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        if (url.includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_empty_quota',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual(['Bearer main-access'])
  })

  test('fallback-first admits an OAuth fallback whose quota is unknown', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-fallback-unknown-quota-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    const expires = Date.now() + 5 * 60 * 60_000
    await saveAccounts(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
        routing: { mode: 'fallback-first' },
        accounts: [
          {
            id: 'unknown-fallback',
            type: 'oauth',
            access: 'unknown-fallback-access',
            refresh: 'unknown-fallback-refresh',
            expires,
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        if (url.includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_fallback_unknown_quota',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual(['Bearer unknown-fallback-access'])
  })

  test('main-first blocks an unknown main quota when the killswitch is fail-closed', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-killswitch-unknown-quota-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveAccounts(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
        },
        killswitch: {
          enabled: true,
          main: { five_hour: 5, seven_day: 10 },
        },
        routing: { mode: 'main-first' },
        accounts: [],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.reject(new Error('quota source unavailable'))
        }
        if (url.includes('/v1/messages')) {
          authorizations.push(
            new Headers(init?.headers).get('authorization') ?? '',
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch

    const events = []
    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_killswitch_unknown_quota',
    })
    for await (const event of stream) events.push(event)

    expect(authorizations).toEqual([])
    expect(events.some((event) => event.type === 'error')).toBe(true)
  })

  test('sticky-balanced keeps repeated Pi session requests on the quota-selected account', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-routing-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - fableRemaining,
        remainingPercent: Math.max(40, fableRemaining),
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await saveAccounts(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 240,
        },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: { ...quota(0), accountIdentity: 'main-account' },
          mainQuotaCheckedAt: checkedAt,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'yiyi',
            type: 'oauth',
            access: 'scarce-access',
            refresh: 'scarce-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(13),
          },
          {
            id: 'ufuk2',
            type: 'oauth',
            access: 'abundant-access',
            refresh: 'abundant-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(98),
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (authorization === 'Bearer main-access') {
          return Promise.resolve(new Response('unauthorized', { status: 401 }))
        }
        return Promise.resolve(
          new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    for (let request = 0; request < 2; request++) {
      const stream = streamCortexKitAnthropic(
        anthropicModel,
        anthropicContext,
        {
          apiKey: 'main-access',
          sessionId: 'ses_pi_sticky',
        },
      )
      for await (const _event of stream) {
        // Drain the provider stream.
      }
    }

    const directOpus = streamCortexKitAnthropic(
      { ...anthropicModel, id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      anthropicContext,
      {
        apiKey: 'main-access',
        sessionId: 'ses_pi_direct_opus',
      },
    )
    for await (const _event of directOpus) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual([
      'Bearer abundant-access',
      'Bearer abundant-access',
      'Bearer main-access',
      'Bearer abundant-access',
    ])
  })

  test('sticky-balanced reports main re-login when no fallback can serve the requested model', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-no-route-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (fableRemaining: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt,
      },
      seven_day: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - fableRemaining,
          remainingPercent: fableRemaining,
          resetsAt: new Date(checkedAt + 4 * 24 * 60 * 60_000).toISOString(),
          checkedAt,
        },
      ],
    })
    await saveAccounts(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        refresh: {
          enabled: true,
          intervalMinutes: 10,
          refreshBeforeExpiryMinutes: 240,
          mainLastRefreshError: {
            message: 'invalid_grant',
            checkedAt,
            status: 400,
            permanent: true,
          },
        },
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: { ...quota(88), accountIdentity: 'main-account' },
          mainQuotaCheckedAt: checkedAt,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'fallback-a',
            type: 'oauth',
            access: 'fallback-a-access',
            refresh: 'fallback-a-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
          {
            id: 'fallback-b',
            type: 'oauth',
            access: 'fallback-b-access',
            refresh: 'fallback-b-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(0),
          },
        ],
      },
      storagePath,
    )

    let messageRequests = 0
    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('/v1/messages')) messageRequests += 1
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    const events = []
    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_sticky_no_fable_route',
    })
    for await (const event of stream) events.push(event)

    const error = events.find((event) => event.type === 'error')
    expect(error?.error.errorMessage).toContain('HTTP 401')
    expect(error?.error.errorMessage).toContain(
      'Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable for Fable.',
    )
    expect(messageRequests).toBe(0)
  })

  test('sticky-balanced preserves the strict API fallback gate after OAuth exhaustion', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-sticky-api-routing-'))
    const storagePath = join(tempDir, 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
      tempDir,
      'sticky-routes.json',
    )
    const checkedAt = Date.now()
    const quota = (remainingPercent: number) => ({
      checkedAt,
      five_hour: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - remainingPercent,
          remainingPercent,
          checkedAt,
        },
      ],
    })
    await saveAccounts(
      {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        fallbackOn: [401, 403, 429],
        quota: {
          enabled: true,
          checkIntervalMinutes: 5,
          minimumRemaining: { five_hour: 1, seven_day: 1 },
          failClosedOnUnknownQuota: true,
          mainQuota: { ...quota(0), accountIdentity: 'main-account' },
          mainQuotaCheckedAt: checkedAt,
        },
        routing: { mode: 'sticky-balanced' },
        accounts: [
          {
            id: 'oauth-fallback',
            type: 'oauth',
            access: 'fallback-access',
            refresh: 'fallback-refresh',
            expires: checkedAt + 5 * 60 * 60_000,
            quota: quota(100),
          },
          {
            id: 'api-fallback',
            type: 'api',
            baseURL: 'https://provider.example/anthropic',
            authHeader: 'authorization-bearer',
            apiKey: 'api-key',
          },
        ],
      },
      storagePath,
    )

    const authorizations: string[] = []
    globalThis.fetch = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 100 },
                seven_day: { utilization: 100 },
                limits: [
                  {
                    kind: 'weekly_scoped',
                    group: 'weekly',
                    percent: 100,
                    scope: { model: { display_name: 'Fable' } },
                  },
                ],
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        authorizations.push(authorization)
        if (authorization === 'Bearer fallback-access') {
          return Promise.resolve(new Response('exhausted', { status: 429 }))
        }
        return Promise.resolve(
          new Response(
            [
              'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
              'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ].join(''),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const stream = streamCortexKitAnthropic(anthropicModel, anthropicContext, {
      apiKey: 'main-access',
      sessionId: 'ses_pi_sticky_api',
    })
    for await (const _event of stream) {
      // Drain the provider stream.
    }

    expect(authorizations).toEqual(['Bearer fallback-access', 'Bearer api-key'])
  })

  test('releases early-abandoned SSE readers without cancelling the stream', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"message_start"}\n\n'),
        )
      },
      cancel() {
        cancelled = true
      },
    })

    const events = parseSse(new Response(body))
    const first = await events.next()
    expect(first.value?.type).toBe('message_start')

    await events.return(undefined)

    expect(cancelled).toBe(false)
  })
})

describe('Pi Anthropic stream content blocks', () => {
  test('preserves redacted thinking for same-model replay', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pi-redacted-thinking-'))
    process.env.PI_ANTHROPIC_AUTH_FILE = join(tempDir, 'anthropic-auth.json')

    globalThis.fetch = mock((input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (!url.includes('/v1/messages')) {
        return Promise.resolve(new Response('{}', { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque-redacted-data"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(''),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const events: any[] = []
    const providerStream = streamCortexKitAnthropic(
      anthropicModel,
      anthropicContext,
      {
        apiKey: 'main-access',
        sessionId: 'ses_pi_redacted_thinking',
      },
    )
    for await (const event of providerStream) events.push(event)

    expect(events.map((event) => event.type)).toContain('thinking_start')
    expect(events.map((event) => event.type)).toContain('thinking_end')
    const done = events.find((event) => event.type === 'done')
    expect(done?.message.content).toEqual([
      {
        type: 'thinking',
        thinking: '[Reasoning redacted]',
        thinkingSignature: 'opaque-redacted-data',
        redacted: true,
      },
    ])
  })
})
