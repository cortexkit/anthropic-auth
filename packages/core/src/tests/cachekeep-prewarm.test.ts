import { describe, expect, mock, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import {
  buildCacheKeepPrewarmBody,
  CacheKeepManager,
  isCacheKeepHybridActive,
} from '../cachekeep.ts'
import { signRequestBody } from '../cch.ts'
import {
  applyClaudeCodeHeaders,
  selectClaudeCodeBetas,
} from '../claude-code.ts'
import { withoutFallbackCredit } from '../fallback-credit.ts'
import { __setLogTestSink } from '../logger.ts'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback-usage.ts'

const hybridStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  accounts: [],
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: { enabled: true, always: true },
})

function sourceBody() {
  return JSON.stringify({
    model: 'claude-opus-5-5',
    max_tokens: 128_000,
    stream: true,
    fallbacks: 'default',
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.302; cc_entrypoint=cli; cch=abcde; cc_prompt_id=00000000-0000-4000-8000-000000000001;',
      },
      { type: 'text', text: 'identity' },
      {
        type: 'text',
        text: 'stable instructions',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    tools: [{ name: 'mcp_read', description: 'read' }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hello',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    ],
  })
}

describe('CacheKeep prewarm body', () => {
  test.each([
    ['client', false],
    ['off', false],
    ['server', true],
  ] as const)(
    '%s prewarm pairs opt-in %s with the fallback beta',
    async (refusalFallbackMode, optIn) => {
      const result = await buildCacheKeepPrewarmBody(sourceBody(), {
        refusalFallbackMode,
      })
      if (!result.ok) throw new Error(result.reason)
      const body = JSON.parse(result.bodyText)
      expect(Object.hasOwn(body, 'fallbacks')).toBe(optIn)
      expect(body.max_tokens).toBe(0)
      expect(result.bodyText).toBe(await signRequestBody(result.bodyText))
      const headers = applyClaudeCodeHeaders(new Headers(), 'test-token', {
        body,
        refusalFallbackMode,
        requestClass: 'auxiliary',
      })
      expect(headers.get('anthropic-beta')?.split(',')).toContain(
        'oauth-2025-04-20',
      )
      expect(
        headers
          .get('anthropic-beta')
          ?.split(',')
          .includes(SERVER_SIDE_FALLBACK_BETA),
      ).toBe(true)
    },
  )
  test('preserves thinking block binding with its beta', async () => {
    const body = JSON.parse(sourceBody())
    body.thinking = {
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    }
    const result = await buildCacheKeepPrewarmBody(JSON.stringify(body))
    if (!result.ok) throw new Error(result.reason)
    const warm = JSON.parse(result.bodyText)
    expect(warm.thinking).toEqual(body.thinking)
    expect(selectClaudeCodeBetas(warm, [], 'auxiliary').split(',')).toContain(
      'thinking-binding-controls-2026-08-01',
    )
  })

  test('an ordinary prewarm keeps the server-side fallback opt-in', async () => {
    const result = await buildCacheKeepPrewarmBody(sourceBody())
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const parsed = JSON.parse(result.bodyText)
    expect(parsed.model).toBe('claude-opus-5-5')
    expect(parsed.max_tokens).toBe(0)
    expect(parsed.fallbacks).toBe('default')
  })
})

describe('CacheKeepManager retained targets', () => {
  test('live tracking cannot retain a credit or replace the last safe template with one', async () => {
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
    })
    const request = {
      sessionId: 'ses_round',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    }
    const credited = await signRequestBody(
      JSON.stringify({
        ...JSON.parse(sourceBody()),
        fallback_credit_token: 'sentinel_template_credit_121cc',
      }),
    )
    const clean = await withoutFallbackCredit(credited)
    try {
      expect(manager.track({ ...request, bodyText: clean })).toEqual({
        tracked: true,
      })
      expect(manager.track({ ...request, bodyText: credited }).tracked).toBe(
        false,
      )
      expect(manager.trackedRequest(request.sessionId)?.bodyText).toBe(clean)
      const warm = await buildCacheKeepPrewarmBody(credited)
      expect(warm).toEqual(await buildCacheKeepPrewarmBody(clean))
    } finally {
      manager.stop()
    }
  })

  function trackAccepted(manager: CacheKeepManager) {
    return manager.track({
      sessionId: 'ses_round',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers({ authorization: 'Bearer token' }),
      bodyText: sourceBody(),
      storage: hybridStorage(),
      cacheMode: 'hybrid',
      oauthAccountId: 'main',
    })
  }

  test('hybrid off drops replay bodies and keeps only stopped cache metadata', async () => {
    const now = new Date('2026-05-18T10:00:00').getTime()
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch
    let storage = hybridStorage()
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(storage),
      fetchImpl,
      now: () => now,
    })
    expect(
      manager.track({
        sessionId: 'ses_round',
        url: 'https://api.anthropic.com/v1/messages?beta=true',
        headers: new Headers(),
        bodyText: sourceBody(),
        storage,
        cacheMode: 'hybrid',
      }),
    ).toEqual({ tracked: true })

    storage = {
      ...hybridStorage(),
      claudeCache: { enabled: true, mode: 'explicit' },
    }
    expect(isCacheKeepHybridActive(storage)).toBe(false)
    await manager.tick()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(manager.trackedSessions()).toEqual([])
    expect(manager.trackedRequest('ses_round')).toBeUndefined()
    expect(
      manager.registrySessions().map((session) => ({
        id: session.id,
        warmStopped: session.warmStopped,
      })),
    ).toEqual([
      { id: 'ses_round', warmStopped: { at: now, reason: 'disabled' } },
    ])
    manager.stop()
  })

  test('trackedRequest returns the live send for a session', () => {
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
    })
    expect(manager.trackedRequest('missing')).toBeUndefined()
    expect(trackAccepted(manager)).toEqual({ tracked: true })
    const live = manager.trackedRequest('ses_round')
    expect(live?.bodyText).toBe(sourceBody())
    expect(live?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(live?.oauthAccountId).toBe('main')
    expect(live?.isSubagent).toBe(false)
    manager.stop()
  })

  test('untrack removes a target without sending', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })
    expect(trackAccepted(manager)).toEqual({ tracked: true })
    expect(manager.untrack('ses_round')).toBe(true)
    expect(manager.untrack('ses_round')).toBe(false)

    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
    manager.stop()
  })

  test('a refused warm removes its target with a single warning', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const warnings: Array<{
      channel: string
      message: string
      payload?: Record<string, unknown>
    }> = []
    __setLogTestSink((record) => {
      if (record.level === 'warn') warnings.push(record)
    })
    try {
      const fetchImpl = mock(() =>
        Promise.resolve(new Response('{}', { status: 200 })),
      ) as unknown as typeof fetch
      const manager = new CacheKeepManager({
        loadStorage: () => Promise.resolve(hybridStorage()),
        fetchImpl,
        now: () => now,
        validatePrewarm: () => ({
          ok: false,
          reason: 'prefix-mismatch',
        }),
      })
      expect(trackAccepted(manager)).toEqual({ tracked: true })
      now += 55 * 60_000
      await manager.tick()
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(manager.trackedSessions()).toEqual([])
      const refusals = warnings.filter(
        (warning) => warning.message === 'stopped warming session',
      )
      expect(refusals).toHaveLength(1)
      expect(refusals[0]).toMatchObject({
        channel: 'cachekeep',
        payload: expect.objectContaining({ reason: 'prefix-mismatch' }),
      })
      manager.stop()
    } finally {
      __setLogTestSink(null)
    }
  })
})
