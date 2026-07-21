import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireRefreshFileLock,
  type OAuthQuotaSnapshot,
  QuotaManager,
  tokenFingerprint,
} from '@cortexkit/anthropic-auth-core'

function makeQuotaResponse(now: number) {
  return new Response(
    JSON.stringify({
      five_hour: {
        utilization: 25,
        resets_at: new Date(now + 3600_000).toISOString(),
      },
      seven_day: {
        utilization: 50,
      },
    }),
    { status: 200 },
  )
}

describe('QuotaManager', () => {
  let now: number
  let tempDir: string

  beforeEach(async () => {
    now = 1_000_000
    tempDir = await mkdtemp(join(tmpdir(), 'qm-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
      tempDir,
      'anthropic-auth.json',
    )
  })

  afterEach(async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    await rm(tempDir, { recursive: true, force: true })
  })

  function createQM(fetchImpl?: typeof fetch) {
    return new QuotaManager({
      storage: null,
      fetchImpl,
      now: () => now,
    })
  }

  describe('model-scoped staleness', () => {
    test('treats a stale matching Fable window as stale even when standard windows are fresh', () => {
      const qm = createQM()
      qm.seedFallbacksFromAccounts([
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'fallback-token',
          refresh: 'fallback-refresh',
          expires: now + 60_000,
          quota: {
            checkedAt: now,
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: now,
            },
            seven_day: {
              usedPercent: 0,
              remainingPercent: 100,
              checkedAt: now,
            },
            scoped: [
              {
                id: 'claude-weekly-scoped-fable',
                title: 'Fable only',
                modelName: 'Fable',
                usedPercent: 100,
                remainingPercent: 0,
                checkedAt: now - 6 * 60_000,
              },
            ],
          },
        },
      ])

      expect(qm.isFallbackStale('fallback-1', 'fallback-token')).toBe(false)
      expect(
        qm.isFallbackStale('fallback-1', 'fallback-token', 'claude-fable-5'),
      ).toBe(true)
    })
  })

  describe('cross-process quota locks', () => {
    test('fallback quota refresh does not call the API while another process holds the account lock', async () => {
      const lock = await acquireRefreshFileLock({
        name: 'opencode-fallback-quota-refresh-fallback-1',
        ttlMs: 30_000,
      })
      expect(lock).not.toBeNull()

      let fetchCalls = 0
      const fetchMock = mock(() => {
        fetchCalls++
        return Promise.resolve(makeQuotaResponse(now))
      }) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      await expect(
        qm.refreshFallback('fallback-1', 'fallback-token'),
      ).rejects.toThrow('Quota refresh is already in progress')
      expect(fetchCalls).toBe(0)

      await lock?.release()
    })
  })

  describe('backoff', () => {
    test('fallback refresh metadata distinguishes cached backoff from a network fetch', async () => {
      let fetchCalls = 0
      const fetchMock = mock(() => {
        fetchCalls += 1
        if (fetchCalls === 1) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        return Promise.resolve(makeQuotaResponse(now))
      }) as unknown as typeof fetch
      const qm = createQM(fetchMock)
      const cachedQuota = {
        five_hour: {
          usedPercent: 25,
          remainingPercent: 75,
          checkedAt: now,
        },
      }
      qm.setFallback(
        'fallback-1',
        { quota: cachedQuota, refreshAfter: now, checkedAt: now },
        'fallback-token',
      )

      await expect(
        qm.refreshFallback('fallback-1', 'fallback-token'),
      ).rejects.toThrow('429')
      const cached = await qm.refreshFallbackWithMetadata(
        'fallback-1',
        'fallback-token',
      )
      expect(cached).toEqual({ quota: cachedQuota, fetched: false })

      now += 61_000
      const fetched = await qm.refreshFallbackWithMetadata(
        'fallback-1',
        'fallback-token',
      )
      expect(fetched.fetched).toBe(true)
      expect(fetchCalls).toBe(2)
    })

    test('main refresh metadata also distinguishes cached backoff from a network fetch', async () => {
      let fetchCalls = 0
      const fetchMock = mock(() => {
        fetchCalls += 1
        if (fetchCalls === 1) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        return Promise.resolve(makeQuotaResponse(now))
      }) as unknown as typeof fetch
      const qm = createQM(fetchMock)
      const cachedQuota = {
        five_hour: {
          usedPercent: 25,
          remainingPercent: 75,
          checkedAt: now,
        },
      }
      qm.setMain('main-token', {
        quota: cachedQuota,
        refreshAfter: now,
        checkedAt: now,
      })

      await expect(qm.refreshMain('main-token')).rejects.toThrow('429')
      const cached = await qm.refreshMainWithMetadata('main-token')
      expect(cached).toEqual({ quota: cachedQuota, fetched: false })

      now += 61_000
      const fetched = await qm.refreshMainWithMetadata('main-token')
      expect(fetched.fetched).toBe(true)
      expect(fetchCalls).toBe(2)
    })

    test('first 429 backs off for 60s', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      try {
        await qm.refreshMain('token')
      } catch {}

      expect(qm.isBackedOff()).toBe(true)
      now += 59_000
      expect(qm.isBackedOff()).toBe(true)
      now += 2_000
      expect(qm.isBackedOff()).toBe(false)
    })

    test('fallback 429 does NOT back off main or fire onApiError', async () => {
      // Regression: backoff is scoped per route. A fallback account's quota
      // 429 must not suppress main quota checks nor persist as the main quota
      // API error (onApiError -> mainLastQuotaApiError).
      let apiErrorCount = 0
      const fetchMock = mock(() =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
      ) as unknown as typeof fetch
      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock,
        now: () => now,
        onApiError: () => {
          apiErrorCount++
        },
      })

      try {
        await qm.refreshFallback('fallback-1', 'fallback-token')
      } catch {}

      // Fallback account is backed off; main is not.
      expect(qm.isFallbackBackedOff('fallback-1')).toBe(true)
      expect(qm.isFallbackBackedOff('fallback-1', 'fallback-token')).toBe(true)
      expect(qm.isBackedOff()).toBe(false)
      // onApiError (persists mainLastQuotaApiError) must NOT have fired.
      expect(apiErrorCount).toBe(0)
      expect(qm.getLastApiError()).toBeUndefined()
      // A different fallback is unaffected.
      expect(qm.isFallbackBackedOff('fallback-2')).toBe(false)
    })

    test('fallback quota backoff is token-bound after re-login', async () => {
      // Same-label re-login changes the access token. A quota backoff recorded
      // for the old token must not block a fresh quota probe for the new token.
      const seenTokens: string[] = []
      const fetchMock = mock(
        (_: string | URL | Request, init?: RequestInit) => {
          const token = new Headers(init?.headers).get('authorization') ?? ''
          seenTokens.push(token)
          if (token === 'Bearer old-token') {
            return Promise.resolve(
              new Response('rate limited', { status: 429 }),
            )
          }
          return Promise.resolve(makeQuotaResponse(now))
        },
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      await expect(
        qm.refreshFallback('fallback-1', 'old-token'),
      ).rejects.toThrow('429')
      expect(qm.isFallbackBackedOff('fallback-1', 'old-token')).toBe(true)
      expect(qm.isFallbackBackedOff('fallback-1', 'new-token')).toBe(false)

      now += 1_100
      await expect(
        qm.refreshFallback('fallback-1', 'new-token'),
      ).resolves.toBeDefined()
      expect(seenTokens).toEqual(['Bearer old-token', 'Bearer new-token'])
    })

    test('main 429 does NOT back off a fallback account', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      try {
        await qm.refreshMain('main-token')
      } catch {}

      expect(qm.isBackedOff()).toBe(true)
      expect(qm.isFallbackBackedOff('fallback-1')).toBe(false)
    })

    test('401 does not arm backoff (auth error, caller retries)', async () => {
      // A 401 means the access token expired — the caller refreshes the token
      // and retries. Backing off here would block that retry and every other
      // account, so the quota API must NOT enter backoff on 401.
      const fetchMock = mock(() =>
        Promise.resolve(new Response('unauthorized', { status: 401 })),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      try {
        await qm.refreshMain('token')
      } catch {}

      expect(qm.isBackedOff()).toBe(false)
      expect(qm.getLastApiError()).toBeUndefined()
    })

    test('403 does not arm backoff (account/org policy error)', async () => {
      // A 403 from the quota endpoint means this OAuth account is not allowed to
      // use OAuth quota, not that the quota API is saturated.
      let apiErrorCount = 0
      const fetchMock = mock(() =>
        Promise.resolve(new Response('org policy', { status: 403 })),
      ) as unknown as typeof fetch
      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock,
        now: () => now,
        onApiError: () => {
          apiErrorCount++
        },
      })

      await expect(qm.refreshMain('token')).rejects.toThrow('403')
      expect(qm.isBackedOff()).toBe(false)
      expect(qm.getLastApiError()).toBeUndefined()
      expect(apiErrorCount).toBe(0)

      await expect(
        qm.refreshFallback('fallback-1', 'fallback-token'),
      ).rejects.toThrow('403')
      expect(qm.isFallbackBackedOff('fallback-1', 'fallback-token')).toBe(false)
    })

    test('repeated 429s escalate backoff exponentially', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      // First failure: 60s
      try {
        await qm.refreshMain('token')
      } catch {}
      expect(qm.isBackedOff()).toBe(true)

      now += 61_000
      expect(qm.isBackedOff()).toBe(false)

      // Second failure: 120s
      try {
        await qm.refreshMain('token')
      } catch {}
      now += 119_000
      expect(qm.isBackedOff()).toBe(true)
      now += 2_000
      expect(qm.isBackedOff()).toBe(false)
    })

    test('backoff caps at 15 minutes', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      // Trigger 8 failures to exceed cap
      for (let i = 0; i < 8; i++) {
        try {
          await qm.refreshMain('token')
        } catch {}
        now += 16 * 60_000
      }

      try {
        await qm.refreshMain('token')
      } catch {}
      now += 14 * 60_000
      expect(qm.isBackedOff()).toBe(true)
      now += 2 * 60_000
      expect(qm.isBackedOff()).toBe(false)
    })

    test('successful fetch resets backoff', async () => {
      let failNext = true
      const fetchMock = mock(() => {
        if (failNext) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        return Promise.resolve(makeQuotaResponse(now))
      }) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      try {
        await qm.refreshMain('token')
      } catch {}
      expect(qm.isBackedOff()).toBe(true)

      now += 61_000
      failNext = false
      await qm.refreshMain('token')
      expect(qm.isBackedOff()).toBe(false)

      // Next failure starts from 60s again (not escalated)
      failNext = true
      now += 1_100
      try {
        await qm.refreshMain('token')
      } catch {}
      now += 59_000
      expect(qm.isBackedOff()).toBe(true)
      now += 2_000
      expect(qm.isBackedOff()).toBe(false)
    })

    test('getLastApiError exposes backoff state', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      expect(qm.getLastApiError()).toBeUndefined()

      try {
        await qm.refreshMain('token')
      } catch {}

      const err = qm.getLastApiError()
      expect(err).toBeDefined()
      expect(err!.retryCount).toBe(1)
      expect(err!.nextRetryAt).toBeGreaterThan(now)
    })

    test('500 errors also trigger backoff', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response('internal error', { status: 500 })),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      try {
        await qm.refreshMain('token')
      } catch {}
      expect(qm.isBackedOff()).toBe(true)
    })

    test('returns cached quota during backoff', async () => {
      let failNext = false
      const fetchMock = mock(() => {
        if (failNext) {
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }
        return Promise.resolve(makeQuotaResponse(now))
      }) as unknown as typeof fetch
      const qm = createQM(fetchMock)

      const first = await qm.refreshMain('token')
      expect(first).toBeDefined()

      failNext = true
      now += 1_100
      try {
        await qm.refreshMain('token')
      } catch {}

      const cached = qm.getMain()
      expect(cached).not.toBeNull()
    })
  })

  describe('persistence', () => {
    test('seeds main quota from persisted storage', () => {
      const quota = {
        quotas: [],
        expires: new Date(2_000_000).toISOString(),
      }
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            mainQuota: quota as any,
            mainQuotaCheckedAt: 900_000,
          },
        },
        now: () => 1_000_000,
      })

      const main = qm.getMain()
      expect(main).not.toBeNull()
      expect(main!.checkedAt).toBe(900_000)
    })

    test('getMain(accessToken) drops a cached entry bound to a different token', () => {
      // Regression: the request path reads getMain() before refreshMain, so the
      // token-binding check must also apply on the cached read — otherwise a
      // stale previous-account quota is used for a new access token.
      const quota = {
        quotas: [],
        expires: new Date(2_000_000).toISOString(),
      }
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            mainQuota: quota as any,
            mainQuotaCheckedAt: 900_000,
            mainQuotaToken: tokenFingerprint('old-main-token'),
          },
        },
        now: () => 1_000_000,
      })

      // Tokenless read returns the cached entry (e.g. display paths).
      expect(qm.getMain()).not.toBeNull()
      // Matching token keeps the entry.
      expect(qm.getMain('old-main-token')).not.toBeNull()
      // Different token (account switch) drops the entry and returns null.
      expect(qm.getMain('new-main-token')).toBeNull()
      expect(qm.getMain()).toBeNull()
    })

    test('updateStorage seeds main quota written by another process', () => {
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            checkIntervalMinutes: 5,
          },
        },
        now: () => 1_000_000,
      })
      expect(qm.getMain('main-token')).toBeNull()

      qm.updateStorage({
        version: 1,
        accounts: [],
        quota: {
          checkIntervalMinutes: 5,
          mainQuota: {
            five_hour: {
              usedPercent: 12,
              remainingPercent: 88,
              checkedAt: 999_000,
            },
          },
          mainQuotaCheckedAt: 999_000,
          mainQuotaToken: tokenFingerprint('main-token'),
        },
      })
      qm.seedMainFromStorage(
        {
          version: 1,
          accounts: [],
          quota: {
            checkIntervalMinutes: 5,
            mainQuota: {
              five_hour: {
                usedPercent: 12,
                remainingPercent: 88,
                checkedAt: 999_000,
              },
            },
            mainQuotaCheckedAt: 999_000,
            mainQuotaToken: tokenFingerprint('main-token'),
          },
        },
        'main-token',
      )

      expect(qm.getMain('main-token')?.quota.five_hour?.usedPercent).toBe(12)
    })

    test('seedFallbacksFromAccounts token-binds persisted fallback quota', () => {
      // Regression: persisted fallback quota seeds must be tied to the access
      // token that produced them. Otherwise same-label re-login can reuse a
      // still-running plugin's old in-memory quota cache.
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: { checkIntervalMinutes: 5 },
        },
        now: () => 1_000_000,
      })

      qm.seedFallbacksFromAccounts([
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'old-fallback-token',
          refresh: 'refresh-token',
          expires: 2_000_000,
          quota: {
            five_hour: {
              usedPercent: 10,
              remainingPercent: 90,
              checkedAt: 900_000,
            },
            seven_day: {
              usedPercent: 20,
              remainingPercent: 80,
              checkedAt: 900_000,
            },
          },
        },
      ])

      expect(qm.getFallback('fallback-1', 'old-fallback-token')).not.toBeNull()
      expect(qm.getFallback('fallback-1', 'new-fallback-token')).toBeNull()
    })

    test('seedFallbacksFromAccounts updates older in-memory quota from disk', () => {
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: { checkIntervalMinutes: 5 },
        },
        now: () => 1_000_000,
      })
      qm.setFallback(
        'fallback-1',
        {
          quota: {
            five_hour: {
              usedPercent: 90,
              remainingPercent: 10,
              checkedAt: 900_000,
            },
          },
          refreshAfter: 900_000,
          checkedAt: 900_000,
        },
        'fallback-token',
      )

      qm.seedFallbacksFromAccounts([
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'fallback-token',
          refresh: 'refresh-token',
          expires: 2_000_000,
          quota: {
            five_hour: {
              usedPercent: 12,
              remainingPercent: 88,
              checkedAt: 999_000,
            },
          },
        },
      ])

      expect(qm.getFallback('fallback-1', 'fallback-token')?.checkedAt).toBe(
        999_000,
      )
      expect(
        qm.getFallback('fallback-1', 'fallback-token')?.quota.five_hour
          ?.usedPercent,
      ).toBe(12)
    })

    test('drops persisted main seed during backoff when the token changed', async () => {
      // Regression: a persisted seed must be bound to the account that produced
      // it. After a main-account switch (different access token), the seed must
      // not be served — even while the quota API is backed off.
      const quota = {
        quotas: [],
        expires: new Date(2_000_000).toISOString(),
      }
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            mainQuota: quota as any,
            mainQuotaCheckedAt: 900_000,
            mainQuotaToken: 'old-account-fingerprint',
            mainLastQuotaApiError: {
              message: 'Claude quota check failed: 429 — rate limited',
              checkedAt: 999_000,
              nextRetryAt: 1_030_000,
              retryCount: 1,
            },
          },
        },
        now: () => 1_000_000,
      })

      expect(qm.getMain()).not.toBeNull()
      expect(qm.isBackedOff()).toBe(true)

      // Different account token: seed is invalidated rather than returned.
      await expect(qm.refreshMain('different-account-token')).rejects.toThrow()
      expect(qm.getMain()).toBeNull()
    })

    test('keeps persisted main seed during backoff when the token matches', async () => {
      const quota = {
        quotas: [],
        expires: new Date(2_000_000).toISOString(),
      }
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            mainQuota: quota as any,
            mainQuotaCheckedAt: 900_000,
            mainQuotaToken: tokenFingerprint('same-account-token'),
            mainLastQuotaApiError: {
              message: 'Claude quota check failed: 429 — rate limited',
              checkedAt: 999_000,
              nextRetryAt: 1_030_000,
              retryCount: 1,
            },
          },
        },
        now: () => 1_000_000,
      })

      // Same account token: backed off, so the seed is returned (not refetched).
      const result = await qm.refreshMain('same-account-token')
      expect(result).toEqual(quota as any)
      expect(qm.getMain()).not.toBeNull()
    })

    test('calls onMainQuotaFetched after successful fetch', async () => {
      let callbackQuota: any = null
      const fetchMock = mock(() =>
        Promise.resolve(makeQuotaResponse(now)),
      ) as unknown as typeof fetch

      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock,
        now: () => now,
        onMainQuotaFetched: (quota, checkedAt) => {
          callbackQuota = { quota, checkedAt }
        },
      })

      await qm.refreshMain('token')
      expect(callbackQuota).not.toBeNull()
      expect(callbackQuota.checkedAt).toBe(now)
    })

    test('seeds backoff state from persisted storage', () => {
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            mainLastQuotaApiError: {
              message: 'Claude quota check failed: 429 — rate limited',
              checkedAt: now - 30_000,
              nextRetryAt: now + 30_000,
              retryCount: 1,
            },
          },
        },
        now: () => now,
      })

      expect(qm.isBackedOff()).toBe(true)
    })

    test('ignores expired persisted backoff', () => {
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            mainLastQuotaApiError: {
              message: 'old error',
              checkedAt: now - 120_000,
              nextRetryAt: now - 60_000,
              retryCount: 1,
            },
          },
        },
        now: () => now,
      })

      expect(qm.isBackedOff()).toBe(false)
    })

    test('calls onApiError callback on failure', async () => {
      let errorCallback: any = null
      const fetchMock = mock(() =>
        Promise.resolve(new Response('rate limited', { status: 429 })),
      ) as unknown as typeof fetch

      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock,
        now: () => now,
        onApiError: (error) => {
          errorCallback = error
        },
      })

      try {
        await qm.refreshMain('token')
      } catch {}

      expect(errorCallback).not.toBeNull()
      expect(errorCallback.retryCount).toBe(1)
      expect(errorCallback.nextRetryAt).toBeGreaterThan(now)
    })
  })

  describe('refreshMain dedup (token-keyed)', () => {
    test('concurrent different-token refreshMain: each gets its own quota', async () => {
      let callCount = 0
      const fetchMock = mock(async (_url: string, _init?: unknown) => {
        callCount++
        return new Response(
          JSON.stringify({
            five_hour: {
              utilization: callCount * 10,
              resets_at: new Date(now + 3600_000).toISOString(),
            },
            seven_day: {
              utilization: callCount * 10,
              resets_at: new Date(now + 86400_000).toISOString(),
            },
          }),
          { status: 200 },
        )
      })

      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock as unknown as typeof fetch,
        now: () => now,
      })

      const tokenA = 'access-token-aaaaaaaa'
      const tokenB = 'access-token-bbbbbbbb'

      expect(tokenFingerprint(tokenA)).not.toBe(tokenFingerprint(tokenB))

      const [quotaA, quotaB] = await Promise.all([
        qm.refreshMain(tokenA),
        qm.refreshMain(tokenB),
      ])

      expect(quotaA.five_hour).toBeDefined()
      expect(quotaB.five_hour).toBeDefined()
      // Two separate API calls — not deduped across different tokens
      expect(fetchMock).toHaveBeenCalledTimes(2)
      // Each token got its own distinct quota (callCount 1 vs 2)
      expect(quotaA.five_hour?.usedPercent).not.toBe(
        quotaB.five_hour?.usedPercent,
      )
    })

    test('same-token concurrent refreshMain deduplicates (one API call)', async () => {
      const fetchMock = mock(async () => {
        return new Response(
          JSON.stringify({
            five_hour: {
              utilization: 42,
              resets_at: new Date(now + 3600_000).toISOString(),
            },
            seven_day: {
              utilization: 42,
              resets_at: new Date(now + 86400_000).toISOString(),
            },
          }),
          { status: 200 },
        )
      })

      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock as unknown as typeof fetch,
        now: () => now,
      })

      const token = 'access-token-same'

      const [quota1, quota2] = await Promise.all([
        qm.refreshMain(token),
        qm.refreshMain(token),
      ])

      expect(quota1).toEqual(quota2)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('pre-fix failure proof: different tokens each trigger own fetch with correct quota', async () => {
      const fetchedTokens: string[] = []
      let callCount = 0
      const fetchMock = mock(
        async (_url: string, init?: { headers?: Record<string, string> }) => {
          callCount++
          const headers = (init?.headers ?? {}) as Record<string, string>
          const auth = headers.Authorization ?? ''
          const token = auth.replace('Bearer ', '')
          fetchedTokens.push(token)
          return new Response(
            JSON.stringify({
              five_hour: {
                utilization: callCount * 10,
                resets_at: new Date(now + 3600_000).toISOString(),
              },
              seven_day: {
                utilization: callCount * 10,
                resets_at: new Date(now + 86400_000).toISOString(),
              },
            }),
            { status: 200 },
          )
        },
      )

      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock as unknown as typeof fetch,
        now: () => now,
      })

      const tokenA = 'token-aaaa'
      const tokenB = 'token-bbbb'
      expect(tokenFingerprint(tokenA)).not.toBe(tokenFingerprint(tokenB))

      const [quotaA, quotaB] = await Promise.all([
        qm.refreshMain(tokenA),
        qm.refreshMain(tokenB),
      ])

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchedTokens.length).toBe(2)
      expect(fetchedTokens).toContain(tokenA)
      expect(fetchedTokens).toContain(tokenB)

      expect(quotaA.five_hour).toBeDefined()
      expect(quotaB.five_hour).toBeDefined()
      expect(quotaA.five_hour?.usedPercent).not.toBe(
        quotaB.five_hour?.usedPercent,
      )
    })
  })

  describe('header pushes', () => {
    function headerSnapshot(checkedAt = now): OAuthQuotaSnapshot {
      return {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt,
        },
        seven_day: {
          usedPercent: 40,
          remainingPercent: 60,
          checkedAt,
        },
        bindingWindow: 'five_hour',
        bindingWindowSource: 'headers',
        fallbackAdvised: true,
        source: 'headers',
        checkedAt,
      }
    }

    test('header push always replaces main five_hour and seven_day regardless of cached checkedAt', () => {
      const qm = createQM()
      qm.setMain('token', {
        quota: {
          five_hour: {
            usedPercent: 1,
            remainingPercent: 99,
            checkedAt: now + 10_000,
          },
          seven_day: {
            usedPercent: 2,
            remainingPercent: 98,
            checkedAt: now + 10_000,
          },
          checkedAt: now + 10_000,
        },
        checkedAt: now + 10_000,
        refreshAfter: now + 20_000,
      })

      const pushed = qm.pushMainFromHeaders('token', headerSnapshot())

      expect(pushed.quota.five_hour?.usedPercent).toBe(78)
      expect(pushed.quota.seven_day?.usedPercent).toBe(40)
    })

    test('header push preserves a non-empty scoped poll snapshot', () => {
      const qm = createQM()
      const scoped = [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 15,
          remainingPercent: 85,
          checkedAt: 100,
        },
      ]
      qm.setMain('token', {
        quota: { scoped, checkedAt: 100, source: 'poll' },
        checkedAt: 100,
        refreshAfter: 200,
      })

      expect(
        qm.pushMainFromHeaders('token', headerSnapshot()).quota.scoped,
      ).toEqual(scoped)
    })

    test('header push preserves present empty scoped array', () => {
      const qm = createQM()
      qm.setMain('token', {
        quota: { scoped: [], checkedAt: 100, source: 'poll' },
        checkedAt: 100,
        refreshAfter: 200,
      })

      const pushed = qm.pushMainFromHeaders('token', headerSnapshot())

      expect('scoped' in pushed.quota).toBe(true)
      expect(pushed.quota.scoped).toEqual([])
    })

    test('header push preserves extraUsage and poll bindingWindow', () => {
      const qm = createQM()
      const extraUsage = {
        used: { amountMinor: 10035, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        exhausted: true,
      }
      qm.setMain('token', {
        quota: {
          extraUsage,
          bindingWindow: 'claude-weekly-scoped-fable',
          bindingWindowSource: 'poll',
          checkedAt: 100,
          source: 'poll',
        },
        checkedAt: 100,
        refreshAfter: 200,
      })

      const pushed = qm.pushMainFromHeaders('token', headerSnapshot())

      expect(pushed.quota.extraUsage).toEqual(extraUsage)
      expect(pushed.quota.bindingWindow).toBe('claude-weekly-scoped-fable')
      expect(pushed.quota.bindingWindowSource).toBe('poll')
    })

    test('poll completion preserves newer header windows while adding scoped limits', async () => {
      let resolvePoll!: (response: Response) => void
      let markPollStarted!: () => void
      const pollStarted = new Promise<void>((resolve) => {
        markPollStarted = resolve
      })
      const fetchMock = mock(
        () =>
          new Promise<Response>((resolve) => {
            resolvePoll = resolve
            markPollStarted()
          }),
      ) as unknown as typeof fetch
      const qm = createQM(fetchMock)
      const refresh = qm.refreshMain('token')

      await pollStarted
      qm.pushMainFromHeaders('token', headerSnapshot(now + 1_000))
      resolvePoll(
        Response.json({
          five_hour: { utilization: 25 },
          seven_day: { utilization: 50 },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 15,
              scope: { model: { id: null, display_name: 'Fable' } },
            },
          ],
        }),
      )
      await refresh

      const quota = qm.getMain('token')?.quota
      expect(quota?.five_hour?.usedPercent).toBe(78)
      expect(quota?.seven_day?.usedPercent).toBe(40)
      expect(quota?.scoped?.[0]).toMatchObject({
        modelName: 'Fable',
        usedPercent: 15,
      })
    })

    test('fallback header push updates only the named account', () => {
      const qm = createQM()
      qm.setFallback('other', {
        quota: { checkedAt: 100 },
        checkedAt: 100,
        refreshAfter: 200,
      })

      qm.pushFallbackFromHeaders('target', 'target-token', headerSnapshot())

      expect(qm.getFallback('target')?.quota.five_hour?.usedPercent).toBe(78)
      expect(qm.getFallback('other')?.quota.checkedAt).toBe(100)
    })

    test('header push binds main and fallback entries to the supplied token fingerprint', () => {
      const qm = createQM()

      qm.pushMainFromHeaders('main-token', headerSnapshot())
      qm.pushFallbackFromHeaders('fallback', 'fallback-token', headerSnapshot())

      expect(qm.getMain('different-token')).toBeNull()
      expect(qm.getFallback('fallback', 'different-token')).toBeNull()
    })

    test('header checkedAt moves refreshAfter through getQuotaNextRefreshAt', () => {
      const qm = createQM()
      const pushed = qm.pushMainFromHeaders(
        'token',
        headerSnapshot(now + 5_000),
      )

      expect(pushed.checkedAt).toBe(now + 5_000)
      expect(pushed.refreshAfter).toBeGreaterThan(pushed.checkedAt)
    })

    test('partial header push stays due at the oldest preserved window staleness point', () => {
      const intervalMs = 5 * 60_000
      const qm = new QuotaManager({
        storage: { version: 1, accounts: [], quota: { enabled: true } },
        now: () => now,
      })
      qm.setMain('token', {
        quota: {
          seven_day: {
            usedPercent: 40,
            remainingPercent: 60,
            checkedAt: now - intervalMs + 1_000,
          },
          source: 'poll',
          checkedAt: now - intervalMs + 1_000,
        },
        checkedAt: now - intervalMs + 1_000,
        refreshAfter: now + 1_000,
      })

      const pushed = qm.pushMainFromHeaders('token', {
        five_hour: {
          usedPercent: 78,
          remainingPercent: 22,
          checkedAt: now,
        },
        source: 'headers',
        checkedAt: now,
      })

      expect(pushed.quota.seven_day?.checkedAt).toBe(now - intervalMs + 1_000)
      expect(pushed.refreshAfter).toBe(now + 1_000)
    })

    test('header pushes stay due at the oldest preserved scoped window staleness point', () => {
      const intervalMs = 5 * 60_000
      const qm = new QuotaManager({
        storage: { version: 1, accounts: [], quota: { enabled: true } },
        now: () => now,
      })
      qm.setMain('token', {
        quota: {
          scoped: [
            {
              id: 'claude-weekly-scoped-fable',
              title: 'Fable only',
              modelName: 'Fable',
              usedPercent: 70,
              remainingPercent: 30,
              checkedAt: now - intervalMs + 1_000,
            },
          ],
          source: 'poll',
          checkedAt: now - intervalMs + 1_000,
        },
        checkedAt: now - intervalMs + 1_000,
        refreshAfter: now + 1_000,
      })

      const pushed = qm.pushMainFromHeaders('token', headerSnapshot())

      expect(pushed.quota.scoped?.[0]?.checkedAt).toBe(now - intervalMs + 1_000)
      expect(pushed.refreshAfter).toBe(now + 1_000)
    })

    test('legacy unbound main quota is not merged into a newly bound header push', () => {
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          quota: {
            mainQuota: {
              scoped: [
                {
                  id: 'legacy-scope',
                  title: 'Legacy scope',
                  modelName: 'Legacy',
                  usedPercent: 90,
                  remainingPercent: 10,
                  checkedAt: now - 1_000,
                },
              ],
              source: 'poll',
              checkedAt: now - 1_000,
            },
            mainQuotaCheckedAt: now - 1_000,
          },
        },
        now: () => now,
      })

      const pushed = qm.pushMainFromHeaders('new-token', headerSnapshot())

      expect(pushed.quota.scoped).toBeUndefined()
      expect(pushed.quota.five_hour?.usedPercent).toBe(78)
    })
  })
})
