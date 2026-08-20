import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  buildCacheKeepPrewarmBody,
  CACHE_KEEP_MAX_BODY_BYTES,
  CACHE_KEEP_MAX_TARGETS,
  CacheKeepManager,
  executeCacheKeepCommand,
  parseCacheKeepCommandAction,
  resetDumpState,
  setDumpEnabled,
} from '@cortexkit/anthropic-auth-core'

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
    expect(parseCacheKeepCommandAction('always')).toEqual({ type: 'always' })
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

  test('parses subagents on/off', () => {
    expect(parseCacheKeepCommandAction('subagents on')).toEqual({
      type: 'subagents',
      enabled: true,
    })
    expect(parseCacheKeepCommandAction('subagents off')).toEqual({
      type: 'subagents',
      enabled: false,
    })
  })

  test('renders hybrid requirement and tracked sessions', () => {
    const summary = executeCacheKeepCommand({
      argumentsText: '09-23',
      trackedSessions: 2,
      trackedSessionDetails: [
        {
          id: 'ses_alpha',
          cacheExpiresAt: 2_000,
          nextPrewarmAt: 1_000,
        },
        {
          id: 'ses_beta',
          cacheExpiresAt: 3_000,
          nextPrewarmAt: 2_000,
        },
      ],
      hybridActive: true,
    })
    expect(summary).toContain('Claude Cache Keep Enabled')
    expect(summary).toContain('Schedule: 09-23')
    expect(summary).toContain('Hybrid active: yes')
    expect(summary).toContain('Tracked sessions: 2')
    expect(summary).toContain('Sessions:\n- ses_alpha\n- ses_beta')
  })

  test('renders the always schedule explicitly', () => {
    const summary = executeCacheKeepCommand({
      argumentsText: 'always',
      always: true,
      hybridActive: true,
    })
    expect(summary).toContain('Claude Cache Keep Enabled')
    expect(summary).toContain(
      'Schedule: always (while this process is running)',
    )
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
          text: 'x-anthropic-billing-header: cc_version=2.1.177.3bf; cc_entrypoint=cli; cch=abcde;',
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
  test('writes cachekeep-tagged prewarm request and response artifacts', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'cachekeep-dump-test-'))
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    setDumpEnabled(true)
    try {
      const manager = new CacheKeepManager({
        loadStorage: () => Promise.resolve(hybridStorage()),
        fetchImpl: mock(
          async () => new Response('malformed', { status: 429 }),
        ) as unknown as typeof fetch,
      })
      await manager.prewarmNow({
        sessionId: 'ses_dump',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText: JSON.stringify({
          system: [
            {
              type: 'text',
              text: 'stable',
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      const files = await readdir(dumpDir)
      expect(files.some((file) => file.includes('-prewarm-cachekeep-'))).toBe(
        true,
      )
      const metadataPath = files.find((file) => file.endsWith('.meta.json'))
      expect(metadataPath).toBeDefined()
      const metadata = JSON.parse(
        await readFile(join(dumpDir, metadataPath!), 'utf8'),
      )
      expect(metadata.tag).toBe('cachekeep')
      const responsePath = files.find((file) => file.endsWith('.response.json'))
      expect(responsePath).toBeDefined()
      expect(
        JSON.parse(await readFile(join(dumpDir, responsePath!), 'utf8')),
      ).toEqual({ status: 429 })
    } finally {
      resetDumpState()
      if (originalDumpDir === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('prepares the tracked body and observes the exact sent body', async () => {
    const sent: string[] = []
    const observed: unknown[] = []
    const body = JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 100,
      stream: true,
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl: mock(async (_input, init) => {
        sent.push(String(init?.body))
        return new Response(
          JSON.stringify({
            usage: {
              input_tokens: 2,
              cache_creation_input_tokens: 1,
              cache_read_input_tokens: 3,
              cache_creation: {
                ephemeral_5m_input_tokens: 4,
                ephemeral_1h_input_tokens: 5,
              },
            },
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
      prepareBody: (value) => value.replace('hello', 'prepared'),
      onResponse: (input) => {
        observed.push(input)
      },
    })
    const result = await manager.prewarmNow({
      sessionId: 'ses_prepare',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText: body,
    })
    expect(result.ok).toBe(true)
    expect(sent[0]).toContain('prepared')
    expect(observed).toHaveLength(1)
    expect(sent[0]).toBeDefined()
    expect((observed[0] as { bodyText: string }).bodyText).toBe(sent[0]!)
    expect(
      (observed[0] as { data: { usage: { cache_creation: unknown } } }).data
        .usage.cache_creation,
    ).toEqual({ ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 })
  })

  test('observer errors do not break malformed responses or scheduling', async () => {
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl: mock(
        async () => new Response('not-json', { status: 429 }),
      ) as unknown as typeof fetch,
      onResponse: () => {
        throw new Error('observer failure')
      },
    })
    const result = await manager.prewarmNow({
      sessionId: 'ses_observer',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(result).toMatchObject({ ok: false, status: 429 })
  })

  test('tracks hybrid sessions and prewarms five minutes before expiry', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const calls: Array<{ url: string; body: string }> = []
    const publishedSessions: Array<
      Array<{ id: string; cacheExpiresAt: number; nextPrewarmAt: number }>
    > = []
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
      onTrackedSessionsChanged: (sessions) => {
        publishedSessions.push(sessions.map((session) => ({ ...session })))
      },
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
    expect(publishedSessions.at(-1)?.map((session) => session.id)).toEqual([
      'ses_1',
    ])

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
    expect(publishedSessions.at(-1)?.[0]?.cacheExpiresAt).toBe(
      now + 60 * 60_000,
    )
    manager.stop()
  })

  test('always mode keeps targets alive and prewarms across local midnight', async () => {
    let now = new Date('2026-05-18T23:58:00').getTime()
    const windowStorage: AccountStorage = {
      ...hybridStorage(),
      cacheKeep: { enabled: true, startHour: 23, endHour: 1 },
    }
    const alwaysStorage: AccountStorage = {
      ...hybridStorage(),
      cacheKeep: { enabled: true, always: true },
    }
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(alwaysStorage),
      fetchImpl,
      now: () => now,
    })
    const tracked = await manager.track({
      sessionId: 'ses_midnight',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers({ authorization: 'Bearer token' }),
      bodyText: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 100,
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      }),
      storage: windowStorage,
      cacheMode: 'hybrid',
    })
    expect(tracked).toEqual({ tracked: true })

    now += 55 * 60_000
    await manager.tick()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(manager.trackedSessions().map((session) => session.id)).toEqual([
      'ses_midnight',
    ])
    manager.stop()
  })

  test('prewarms immediately without requiring cachekeep enablement or its window', async () => {
    let sentBody = ''
    let seenAccountId: string | undefined
    const fetchImpl = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        sentBody = String(init?.body)
        return Promise.resolve(
          new Response(
            JSON.stringify({ usage: { cache_read_input_tokens: 123 } }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(null),
      fetchImpl,
      prepareHeaders: (headers, target) => {
        seenAccountId = target.oauthAccountId
        headers.set('authorization', 'Bearer fresh')
        return headers
      },
    })

    const result = await manager.prewarmNow({
      sessionId: 'ses_fable',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers({ authorization: 'Bearer stale' }),
      bodyText: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 128_000,
        stream: true,
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      }),
      oauthAccountId: 'fallback-account',
    })

    expect(result).toEqual({
      ok: true,
      usage: { cache_read_input_tokens: 123 },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(seenAccountId).toBe('fallback-account')
    expect(JSON.parse(sentBody).model).toBe('claude-fable-5')
    expect(JSON.parse(sentBody).max_tokens).toBe(0)
  })

  test('bounds immediate prewarm requests so final Fable recovery cannot hang', async () => {
    const fetchImpl = mock(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          )
        }),
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(null),
      fetchImpl,
      prewarmTimeoutMs: 5,
    })

    const result = await manager.prewarmNow({
      sessionId: 'ses_timeout',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers(),
      bodyText: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected prewarm to fail')
    expect(result.transient).toBe(true)
    expect(result.reason).toContain('timed out')
  })

  test('passes OAuth account identity to prewarm header refresh', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    let seenAccountId: string | undefined
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
      prepareHeaders: (headers, target) => {
        seenAccountId = target.oauthAccountId
        return headers
      },
    })

    await manager.track({
      sessionId: 'ses_1',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers({ authorization: 'Bearer fallback' }),
      bodyText: JSON.stringify({
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      }),
      storage: hybridStorage(),
      cacheMode: 'hybrid',
      oauthAccountId: 'fallback-account',
    })
    expect(manager.trackedOAuthRoute('ses_1')).toEqual({
      oauthAccountId: 'fallback-account',
    })
    expect(manager.trackedOAuthRoute('missing')).toBeUndefined()

    now += 55 * 60_000
    await manager.tick()
    expect(seenAccountId).toBe('fallback-account')
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

  test('bounds tracked sessions and rejects bodies over the memory budget', async () => {
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      now: () => new Date('2026-05-18T10:00:00').getTime(),
    })
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })

    for (let index = 0; index < CACHE_KEEP_MAX_TARGETS + 5; index++) {
      await manager.track({
        sessionId: `ses_${index}`,
        url: 'https://api.anthropic.com/v1/messages?beta=true',
        headers: new Headers(),
        bodyText: body,
        storage: hybridStorage(),
        cacheMode: 'hybrid',
      })
    }
    expect(manager.trackedCount()).toBe(CACHE_KEEP_MAX_TARGETS)

    const tooLarge = await manager.track({
      sessionId: 'too-large',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers(),
      bodyText: 'x'.repeat(CACHE_KEEP_MAX_BODY_BYTES + 1),
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })
    expect(tooLarge).toEqual({
      tracked: false,
      reason: 'body exceeds cachekeep memory budget',
    })
    manager.stop()
  })

  test('reads usage from prewarm response and logs cost', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const fetchImpl = mock(
      (_input: string | URL | Request, _init?: RequestInit) => {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              usage: {
                input_tokens: 5000,
                cache_creation_input_tokens: 3000,
                cache_read_input_tokens: 0,
              },
            }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })

    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await manager.track({
      sessionId: 'ses_cost',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers(),
      bodyText: body,
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })

    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    manager.stop()
  })

  test('handles prewarm response without usage gracefully', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const fetchImpl = mock(
      (_input: string | URL | Request, _init?: RequestInit) => {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }),
        )
      },
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })

    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await manager.track({
      sessionId: 'ses_no_usage',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers(),
      bodyText: body,
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })

    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    manager.stop()
  })

  test('handles prewarm json parse failure gracefully', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const fetchImpl = mock(
      (_input: string | URL | Request, _init?: RequestInit) => {
        return Promise.resolve(new Response('not json', { status: 200 }))
      },
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })

    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await manager.track({
      sessionId: 'ses_bad_json',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers(),
      bodyText: body,
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })

    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    manager.stop()
  })

  test('backs off failed prewarms and drops targets once the last successful cache expires', async () => {
    const trackedAt = new Date('2026-05-18T10:00:00').getTime()
    let now = trackedAt
    const fetchImpl = mock(
      (_input: string | URL | Request, _init?: RequestInit) => {
        return Promise.resolve(new Response('rate limited', { status: 429 }))
      },
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })

    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await manager.track({
      sessionId: 'ses_fail',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers(),
      bodyText: body,
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })

    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(manager.trackedSessions()[0]?.cacheExpiresAt).toBe(
      trackedAt + 60 * 60_000,
    )

    // The retry is delayed rather than paid on every scheduler tick.
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Once the cache created by the last successful request has expired, another
    // max_tokens:0 request would be a paid cold cache write and must not be sent.
    now = trackedAt + 60 * 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(manager.trackedCount()).toBe(0)
    manager.stop()
  })

  test('coalesces overlapping scheduler ticks into one prewarm attempt', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const fetchStarted = Promise.withResolvers<void>()
    const fetchCanFinish = Promise.withResolvers<Response>()
    const fetchImpl = mock(() => {
      fetchStarted.resolve()
      return fetchCanFinish.promise
    }) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })
    await manager.track({
      sessionId: 'ses_overlap',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers(),
      bodyText: body,
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })

    now += 55 * 60_000
    const firstTick = manager.tick()
    await fetchStarted.promise
    const overlappingTick = manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    fetchCanFinish.resolve(new Response('{}', { status: 200 }))
    await Promise.all([firstTick, overlappingTick])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    manager.stop()
  })

  test('contains thrown prewarm errors and continues with later targets', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const attempts: string[] = []
    let publishCount = 0
    const timeout = new Error('The operation timed out.')
    timeout.name = 'TimeoutError'
    const fetchImpl = mock((input: string | URL | Request) => {
      const url = String(input)
      attempts.push(url)
      if (url.endsWith('/A')) throw timeout
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
      onTrackedSessionsChanged: () => {
        publishCount++
      },
    })
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })

    for (const id of ['A', 'B', 'C']) {
      await manager.track({
        sessionId: `ses_${id}`,
        url: `https://api.anthropic.com/v1/messages/${id}`,
        headers: new Headers(),
        bodyText: body,
        storage: hybridStorage(),
        cacheMode: 'hybrid',
      })
    }

    const publishedBeforeTick = publishCount
    now += 55 * 60_000
    await manager.tick()

    expect(attempts).toEqual([
      'https://api.anthropic.com/v1/messages/A',
      'https://api.anthropic.com/v1/messages/B',
      'https://api.anthropic.com/v1/messages/C',
    ])
    expect(manager.trackedSessions().map((session) => session.id)).toEqual([
      'ses_A',
      'ses_B',
      'ses_C',
    ])
    expect(
      manager.trackedSessions().find((session) => session.id === 'ses_A')
        ?.cacheExpiresAt,
    ).toBe(now + 5 * 60_000)
    expect(publishCount).toBeGreaterThan(publishedBeforeTick)

    attempts.length = 0
    now += 60_000
    await manager.tick()
    expect(attempts).toEqual([])
    manager.stop()
  })

  test('deletes a tracked target when its prewarm body is unbuildable', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
    })

    await manager.track({
      sessionId: 'ses_unbuildable',
      url: 'https://api.anthropic.com/v1/messages/unbuildable',
      headers: new Headers(),
      bodyText: JSON.stringify({
        messages: [{ role: 'user', content: 'hello' }],
      }),
      storage: hybridStorage(),
      cacheMode: 'hybrid',
    })

    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(manager.trackedCount()).toBe(0)
    manager.stop()
  })
})
