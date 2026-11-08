import { expect, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import { CacheKeepManager } from '../cachekeep.ts'

const bodyText = JSON.stringify({
  model: 'claude-haiku-4-5',
  max_tokens: 128,
  system: [
    {
      type: 'text',
      text: 'stable prompt',
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [{ role: 'user', content: 'warm' }],
})

const target = {
  sessionId: 'immediate-test',
  url: 'https://api.anthropic.com/v1/messages',
  headers: new Headers(),
  bodyText,
}

const storage: AccountStorage = {
  version: 1,
  accounts: [],
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: { enabled: true, always: true },
}

test('CacheKeep immediate replay binds the tracked generation and reserves its count', async () => {
  let sends = 0
  const current: boolean[] = []
  const manager = new CacheKeepManager({
    loadStorage: async () => storage,
    fetchImpl: (async () => {
      sends++
      return Response.json({})
    }) as unknown as typeof fetch,
    onResponse: ({ target }) => {
      current.push(manager.isCurrentTarget(target))
    },
  })
  try {
    expect(manager.track({ ...target, storage, cacheMode: 'hybrid' })).toEqual({
      tracked: true,
    })
    const state = manager.trackedPolicyState(target.sessionId)
    expect(await manager.prewarmNow(target)).toEqual({
      ok: true,
      ttlMs: 300_000,
    })
    expect(manager.trackedPolicyState(target.sessionId)).toBe(state)
    expect(state?.warmsSinceLastRealRequest).toBe(1)
    expect(state?.hasWarmed).toBe(true)
    expect(sends).toBe(1)
    expect(current).toEqual([true])
  } finally {
    manager.stop()
  }
})

test('CacheKeep standalone immediate responses update only their own generation', async () => {
  const responses = [
    Promise.withResolvers<Response>(),
    Promise.withResolvers<Response>(),
  ]
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  let sends = 0
  const current: boolean[] = []
  const manager = new CacheKeepManager({
    loadStorage: async () => null,
    fetchImpl: (async () => {
      const index = sends++
      started[index]!.resolve()
      return responses[index]!.promise
    }) as unknown as typeof fetch,
    onResponse: ({ target }) => {
      current.push(manager.isCurrentTarget(target))
    },
  })
  const first = manager.prewarmNow(target)
  await started[0]!.promise
  const second = manager.prewarmNow(target)
  await started[1]!.promise
  try {
    responses[1]!.resolve(Response.json({}))
    expect(await second).toEqual({ ok: true, ttlMs: 300_000 })
    responses[0]!.resolve(Response.json({}))
    expect(await first).toEqual({ ok: true, ttlMs: 300_000 })
    expect(current).toEqual([true, false])
  } finally {
    responses.forEach((response) => {
      response.resolve(Response.json({}))
    })
    await Promise.all([first, second])
    manager.stop()
  }
})

test.each(['request', 'untrack', 'stop'] as const)(
  'CacheKeep %s invalidates an in-flight standalone immediate generation',
  async (change) => {
    const response = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    const current: boolean[] = []
    const manager = new CacheKeepManager({
      loadStorage: async () => storage,
      fetchImpl: (async () => {
        started.resolve()
        return response.promise
      }) as unknown as typeof fetch,
      onResponse: ({ target }) => {
        current.push(manager.isCurrentTarget(target))
      },
    })
    const warm = manager.prewarmNow(target)
    await started.promise
    try {
      if (change === 'request')
        manager.track({ ...target, storage, cacheMode: 'hybrid' })
      else if (change === 'untrack') manager.untrack(target.sessionId)
      else manager.stop()
      response.resolve(Response.json({}))
      expect(await warm).toEqual({ ok: true, ttlMs: 300_000 })
      expect(current).toEqual([false])
    } finally {
      response.resolve(Response.json({}))
      await warm
      manager.stop()
    }
  },
)

test('CacheKeep retries an in-flight 401 once with a new scoped receipt before reporting', async () => {
  const sent: string[] = []
  const reported: Array<{ status: number; version: number }> = []
  let servedVersion = 1
  const manager = new CacheKeepManager({
    loadStorage: async () => null,
    prepareHeaders: async (headers) => {
      headers.set('authorization', 'Bearer scoped-v1')
      return headers
    },
    retryOnUnauthorized: async ({ headers }) => {
      servedVersion = 2
      const rotated = new Headers(headers)
      rotated.set('authorization', 'Bearer scoped-v2')
      return rotated
    },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      sent.push(authorization)
      return new Response(
        authorization === 'Bearer scoped-v1' ? 'old token' : 'ok',
        {
          status: authorization === 'Bearer scoped-v1' ? 401 : 200,
        },
      )
    }) as typeof fetch,
    onResponse: ({ status }) => {
      reported.push({ status, version: servedVersion })
    },
  })
  try {
    expect(
      await manager.prewarmNow({
        sessionId: 'rotation-test',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText,
      }),
    ).toMatchObject({ ok: true })
    expect(sent).toEqual(['Bearer scoped-v1', 'Bearer scoped-v2'])
    expect(reported).toEqual([{ status: 200, version: 2 }])
  } finally {
    manager.stop()
  }
})

test('CacheKeep reports a genuine second 401 against the final receipt without a third send', async () => {
  const sent: string[] = []
  const reported: number[] = []
  let version = 1
  const manager = new CacheKeepManager({
    loadStorage: async () => null,
    prepareHeaders: (headers) => {
      headers.set('authorization', 'Bearer scoped-v1')
      return headers
    },
    retryOnUnauthorized: ({ headers }) => {
      version = 2
      const rotated = new Headers(headers)
      rotated.set('authorization', 'Bearer scoped-v2')
      return rotated
    },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return new Response('still rejected', { status: 401 })
    }) as typeof fetch,
    onResponse: ({ status }) => {
      if (status === 401) reported.push(version)
    },
  })
  try {
    expect(
      await manager.prewarmNow({
        sessionId: 'still-rejected',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText,
      }),
    ).toMatchObject({ ok: false, status: 401 })
    expect(sent).toEqual(['Bearer scoped-v1', 'Bearer scoped-v2'])
    expect(reported).toEqual([2])
  } finally {
    manager.stop()
  }
})
