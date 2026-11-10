import { describe, expect, mock, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import {
  buildCacheKeepPrewarmBody,
  CacheKeepManager,
  type CacheKeepPrewarmValidation,
  cacheKeepSourceWarmIdleCap,
  cacheWarmCacheablePrefixFingerprint,
  isCacheKeepHybridActive,
} from '../cachekeep.ts'
import { selectClaudeCodeBetas } from '../claude-code.ts'
import { __setLogTestSink } from '../logger.ts'

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

describe('cachekeep source-warm prewarm body', () => {
  test('ordinary and source warms preserve thinking block binding with its beta', async () => {
    const body = JSON.parse(sourceBody())
    body.thinking = {
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    }
    for (const stripServerFallback of [false, true]) {
      const result = await buildCacheKeepPrewarmBody(JSON.stringify(body), {
        stripServerFallback,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.reason)
      const warm = JSON.parse(result.bodyText)
      expect(warm.thinking).toEqual(body.thinking)
      expect(selectClaudeCodeBetas(warm, [], 'auxiliary').split(',')).toContain(
        'thinking-binding-controls-2026-08-01',
      )
    }
  })

  test('drops the server-side fallback opt-in for a source warm so it cannot be sticky-routed away', async () => {
    const result = await buildCacheKeepPrewarmBody(sourceBody(), {
      stripServerFallback: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const parsed = JSON.parse(result.bodyText)
    expect(parsed.model).toBe('claude-opus-5-5')
    expect(parsed.max_tokens).toBe(0)
    expect(parsed.fallbacks).toBeUndefined()
    expect('fallbacks' in parsed).toBe(false)
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

describe('cacheWarmCacheablePrefixFingerprint', () => {
  test('matches the built warm body despite billing, signature and limit changes', async () => {
    const kept = cacheWarmCacheablePrefixFingerprint(sourceBody())
    expect(kept).toBeDefined()
    const warm = await buildCacheKeepPrewarmBody(sourceBody())
    if (!warm.ok) throw new Error(warm.reason)
    expect(cacheWarmCacheablePrefixFingerprint(warm.bodyText)).toBe(kept)
  })

  test('ignores the billing header block and content past the last breakpoint', () => {
    const base = JSON.parse(sourceBody()) as Record<string, unknown>
    const billing = (base.system as Array<Record<string, unknown>>)[0]!
    billing.text += ' cc_prev_req=req_abc;'
    const trailing = {
      ...(base as object),
      messages: [
        ...((base.messages as unknown[]) ?? []),
        { role: 'user', content: 'a later turn without a breakpoint' },
      ],
    }
    expect(cacheWarmCacheablePrefixFingerprint(JSON.stringify(trailing))).toBe(
      cacheWarmCacheablePrefixFingerprint(sourceBody()),
    )
  })

  test('changes when tools, system or cached messages change', () => {
    const kept = cacheWarmCacheablePrefixFingerprint(sourceBody())
    const mutate = (
      change: (body: Record<string, unknown>) => void,
    ): string | undefined => {
      const body = JSON.parse(sourceBody()) as Record<string, unknown>
      change(body)
      return cacheWarmCacheablePrefixFingerprint(JSON.stringify(body))
    }
    expect(
      mutate((body) => {
        ;(body.tools as Array<Record<string, unknown>>)[0]!.name = 'mcp_other'
      }),
    ).not.toBe(kept)
    expect(
      mutate((body) => {
        ;(
          (body.system as Array<Record<string, unknown>>)[2] as Record<
            string,
            unknown
          >
        ).text = 'edited instructions'
      }),
    ).not.toBe(kept)
    expect(
      mutate((body) => {
        ;(
          (
            (body.messages as Array<Record<string, unknown>>)[0]!
              .content as Array<Record<string, unknown>>
          )[0] as Record<string, unknown>
        ).text = 'edited user text'
      }),
    ).not.toBe(kept)
  })

  test('returns undefined for bodies that are not JSON objects', () => {
    expect(cacheWarmCacheablePrefixFingerprint('not json')).toBeUndefined()
    expect(cacheWarmCacheablePrefixFingerprint('42')).toBeUndefined()
  })
})

describe('cacheKeepSourceWarmIdleCap', () => {
  test('derives about 39 warms for a 1-hour Opus 5.5 cache', () => {
    expect(cacheKeepSourceWarmIdleCap('claude-opus-5-5')).toBe(39)
  })

  test('derives the cap from the source model pricing', () => {
    expect(cacheKeepSourceWarmIdleCap('claude-fable-5-1')).toBe(79)
    expect(cacheKeepSourceWarmIdleCap('claude-fable-5')).toBe(19)
  })

  test('falls back to sibling 1-hour pricing without catalogue facts', () => {
    expect(cacheKeepSourceWarmIdleCap('claude-opus-5')).toBe(39)
    expect(cacheKeepSourceWarmIdleCap('unknown-model')).toBe(39)
  })
})

describe('CacheKeepManager source-warm targets', () => {
  function trackSourceWarm(manager: CacheKeepManager) {
    return manager.track({
      sessionId: 'source-warm:ses_round:fable-5',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      headers: new Headers({ authorization: 'Bearer token' }),
      bodyText: sourceBody(),
      storage: hybridStorage(),
      cacheMode: 'hybrid',
      oauthAccountId: 'main',
      sourceWarm: true,
    })
  }

  test('tracks a source warm alongside the live session target', () => {
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
    })
    const body = sourceBody()
    expect(
      manager.track({
        sessionId: 'ses_round',
        url: 'https://api.anthropic.com/v1/messages?beta=true',
        headers: new Headers({ authorization: 'Bearer token' }),
        bodyText: body.replace('claude-opus-5-5', 'claude-opus-4-8'),
        storage: hybridStorage(),
        cacheMode: 'hybrid',
        oauthAccountId: 'main',
      }),
    ).toEqual({ tracked: true })
    expect(trackSourceWarm(manager)).toEqual({ tracked: true })
    expect(
      manager
        .trackedSessions()
        .map((session) => session.id)
        .sort(),
    ).toEqual(['ses_round', 'source-warm:ses_round:fable-5'])
    manager.stop()
  })

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
    expect(trackSourceWarm(manager)).toEqual({ tracked: true })
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
      manager.trackedRequest('source-warm:ses_round:fable-5'),
    ).toBeUndefined()
    expect(
      manager.registrySessions().map((session) => ({
        id: session.id,
        warmStopped: session.warmStopped,
      })),
    ).toEqual([
      { id: 'ses_round', warmStopped: { at: now, reason: 'disabled' } },
      {
        id: 'source-warm:ses_round:fable-5',
        warmStopped: { at: now, reason: 'disabled' },
      },
    ])
    manager.stop()
  })

  test('trackedRequest returns the live send for a session', () => {
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
    })
    expect(manager.trackedRequest('missing')).toBeUndefined()
    expect(trackSourceWarm(manager)).toEqual({ tracked: true })
    const live = manager.trackedRequest('source-warm:ses_round:fable-5')
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
    expect(trackSourceWarm(manager)).toEqual({ tracked: true })
    expect(manager.untrack('source-warm:ses_round:fable-5')).toBe(true)
    expect(manager.untrack('source-warm:ses_round:fable-5')).toBe(false)

    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
    manager.stop()
  })

  test('refuses a warm whose prefix no longer matches the kept source', async () => {
    let now = new Date('2026-05-18T10:00:00').getTime()
    const sent: string[] = []
    const fetchImpl = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        sent.push(String(init?.body))
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    ) as unknown as typeof fetch
    // The keeper's pristine copy; the test tampers with it below.
    let kept = sourceBody()
    const validatePrewarm = ({
      warmBodyText,
    }: {
      warmBodyText: string
    }): CacheKeepPrewarmValidation => {
      const warmFingerprint = cacheWarmCacheablePrefixFingerprint(warmBodyText)
      const keptFingerprint = cacheWarmCacheablePrefixFingerprint(kept)
      if (
        !warmFingerprint ||
        !keptFingerprint ||
        warmFingerprint !== keptFingerprint
      )
        return { ok: false, reason: 'source-prefix-mismatch' }
      return { ok: true }
    }
    const manager = new CacheKeepManager({
      loadStorage: () => Promise.resolve(hybridStorage()),
      fetchImpl,
      now: () => now,
      validatePrewarm,
    })
    expect(trackSourceWarm(manager)).toEqual({ tracked: true })

    // Untouched keep: the warm goes out once, then per its lifetime again.
    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(sent[0]!).max_tokens).toBe(0)

    // Tamper with the kept source after tracking: the next warm is refused
    // and nothing is sent. The tick lands on the next due time, before the
    // extended expiry, so only the validator can stop the send.
    kept = kept.replace('hello', 'tampered history')
    now += 55 * 60_000
    await manager.tick()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(manager.trackedSessions()).toEqual([])
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
          reason: 'source-prefix-mismatch',
        }),
      })
      expect(trackSourceWarm(manager)).toEqual({ tracked: true })
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
        payload: expect.objectContaining({ reason: 'source-prefix-mismatch' }),
      })
      manager.stop()
    } finally {
      __setLogTestSink(null)
    }
  })
})
