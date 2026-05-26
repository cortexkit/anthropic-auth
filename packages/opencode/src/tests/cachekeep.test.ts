import { describe, expect, mock, test } from 'bun:test'
import {
  type AccountStorage,
  buildCacheKeepPrewarmBody,
  CacheKeepManager,
  executeCacheKeepCommand,
  parseCacheKeepCommandAction,
} from '@marcusrbrown/anthropic-auth-core'

const hybridStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  accounts: [],
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: { enabled: true, startHour: 9, endHour: 23 },
})

describe('claude-cachekeep command', () => {
  test('parses status, off, and hour ranges', () => {
    expect(parseCacheKeepCommandAction('')).toEqual({ type: 'status' })
    expect(parseCacheKeepCommandAction('off')).toEqual({ type: 'disable' })
    expect(parseCacheKeepCommandAction('09-23')).toEqual({
      type: 'window',
      startHour: 9,
      endHour: 23,
    })
    expect(parseCacheKeepCommandAction('23-09')).toEqual({
      type: 'window',
      startHour: 23,
      endHour: 9,
    })
    expect(parseCacheKeepCommandAction('24-09')).toEqual({ type: 'usage' })
    expect(parseCacheKeepCommandAction('9-9')).toEqual({ type: 'usage' })
  })

  test('renders hybrid requirement and tracked sessions', () => {
    const summary = executeCacheKeepCommand({
      argumentsText: '09-23',
      trackedSessions: 2,
      hybridActive: true,
    })
    expect(summary).toContain('Claude Cache Keep Enabled')
    expect(summary).toContain('Window: 09-23')
    expect(summary).toContain('Hybrid active: yes')
    expect(summary).toContain('Tracked sessions: 2')
  })
})

describe('cachekeep prewarm body', () => {
  test('makes rewritten hybrid request prewarm-safe', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 64_000,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      output_config: { format: { type: 'json_schema' } },
      tool_choice: { type: 'any' },
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.141.67b; cc_entrypoint=sdk-cli; cch=abcde;',
        },
        { type: 'text', text: 'identity' },
        {
          type: 'text',
          text: 'stable',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })

    const result = await buildCacheKeepPrewarmBody(body)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const parsed = JSON.parse(result.bodyText)
    expect(parsed.max_tokens).toBe(0)
    expect(parsed.stream).toBeUndefined()
    expect(parsed.thinking).toBeUndefined()
    expect(parsed.output_config).toBeUndefined()
    expect(parsed.tool_choice).toBeUndefined()
    expect(parsed.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.bodyText).not.toContain('cch=abcde;')
    expect(result.bodyText).toMatch(/cch=[0-9a-f]{5};/)
  })
})

describe('CacheKeepManager', () => {
  test('tracks hybrid sessions and prewarms five minutes before expiry', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const calls: Array<{ url: string; body: string }> = []
    const fetchImpl = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), body: String(init?.body) })
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })

    const body = JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 100,
      stream: true,
      system: [
        {
          type: 'text',
          text: 'stable',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(
      await manager.track({
        sessionId: 'ses_1',
        url: 'https://api.anthropic.com/v1/messages?beta=true',
        headers: new Headers({ authorization: 'Bearer token' }),
        bodyText: body,
        storage: hybridStorage(),
        cacheMode: 'hybrid',
      }),
    ).toEqual({ tracked: true })

    now += 54 * 60_000
    await manager.tick()
    expect(fetchImpl).not.toHaveBeenCalled()

    now += 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(calls[0]?.url).toBe(
      'https://api.anthropic.com/v1/messages?beta=true',
    )
    expect(JSON.parse(calls[0]!.body).max_tokens).toBe(0)
    manager.stop()
  })

  test('lets callers refresh headers before prewarm fetch', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    let seenAuthorization = ''
    const fetchImpl = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        seenAuthorization =
          new Headers(init?.headers).get('authorization') ?? ''
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
      prepareHeaders: (headers) => {
        headers.set('authorization', 'Bearer fresh')
        return headers
      },
    })

    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await manager.track({
      sessionId: 'ses_1',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers({ authorization: 'Bearer stale' }),
      bodyText: body,
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })

    now += 55 * 60_000
    await manager.tick()
    expect(seenAuthorization).toBe('Bearer fresh')
    manager.stop()
  })

  test('only tracks when cache mode is hybrid and configured window is active', async () => {
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      now: () => new Date('2026-05-18T08:00:00').getTime(),
    })
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(
      (
        await manager.track({
          sessionId: 'ses_1',
          url: 'https://api.anthropic.com/v1/messages?beta=true',
          headers: new Headers(),
          bodyText: body,
          storage: hybridStorage(),
          cacheMode: 'hybrid',
        })
      ).tracked,
    ).toBe(false)

    const inside = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      now: () => new Date('2026-05-18T10:00:00').getTime(),
    })
    expect(
      (
        await inside.track({
          sessionId: 'ses_1',
          url: 'https://api.anthropic.com/v1/messages?beta=true',
          headers: new Headers(),
          bodyText: body,
          storage: hybridStorage(),
          cacheMode: 'explicit',
        })
      ).tracked,
    ).toBe(false)
    manager.stop()
    inside.stop()
  })
})
