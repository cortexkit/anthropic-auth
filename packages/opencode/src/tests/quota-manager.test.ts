import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
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

  test('reload keeps a newer in-memory backoff than a persisted clear', () => {
    const localError = {
      message: 'newer local quota error',
      checkedAt: 2_000,
      nextRetryAt: 2_000_000,
      retryCount: 1,
      accountIdentity: 'account-a',
    }
    const qm = new QuotaManager({
      storage: {
        quota: {
          mainLastQuotaApiError: localError,
          mainQuotaErrorGeneration: 1,
          mainQuotaErrorClearedAt: 1_000,
        },
      } as AccountStorage,
      now: () => now,
    })

    qm.updateStorage({
      quota: {
        mainLastQuotaApiError: undefined,
        mainQuotaErrorGeneration: 2,
        mainQuotaErrorClearedAt: 1_500,
      },
    } as AccountStorage)

    expect(qm.isBackedOff()).toBe(true)
    expect(qm.getLastApiError()?.checkedAt).toBe(2_000)
  })

  test('reload clear marker cannot clear a newer error at the same generation', () => {
    const localError = {
      message: 'newer local quota error',
      checkedAt: 2_000,
      nextRetryAt: 2_000_000,
      retryCount: 1,
      accountIdentity: 'account-a',
    }
    const qm = new QuotaManager({
      storage: {
        quota: {
          mainLastQuotaApiError: localError,
          mainQuotaErrorGeneration: 2,
          mainQuotaErrorClearedAt: 1_000,
        },
      } as AccountStorage,
      now: () => now,
    })

    qm.updateStorage({
      quota: {
        mainLastQuotaApiError: undefined,
        mainQuotaErrorGeneration: 2,
        mainQuotaErrorClearedAt: 1_500,
      },
    } as AccountStorage)

    expect(qm.isBackedOff()).toBe(true)
    expect(qm.getLastApiError()?.checkedAt).toBe(2_000)
  })

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
    test('a confirmed main retarget cannot return the previous account cache on lock collision', async () => {
      const lock = await acquireRefreshFileLock({
        name: 'opencode-main-quota-refresh',
        ttlMs: 30_000,
      })
      expect(lock).not.toBeNull()

      const qm = createQM()
      qm.setMain('account-a', {
        quota: { accountIdentity: 'account-a', checkedAt: now },
        refreshAfter: now + 60_000,
        checkedAt: now,
      })
      qm.setMainQuotaAccountIdentity('account-b')

      await expect(
        qm.refreshMain('account-b', 'account-b-token'),
      ).rejects.toThrow('Quota refresh is already in progress')
      expect(qm.getMain('account-b')).toBeNull()

      await lock?.release()
    })

    test('a request-bound refresh cannot retarget after the main identity changes', async () => {
      let apiCalls = 0
      const qm = createQM((async () => {
        apiCalls += 1
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch)
      qm.setMainQuotaAccountIdentity('account-a')
      const requestGeneration = qm.getMainQuotaIdentityGeneration()
      qm.setMainQuotaAccountIdentity('account-b')

      await expect(
        qm.refreshMain('account-a', 'account-a-token', requestGeneration),
      ).rejects.toThrow('Main quota identity changed before refresh')
      expect(apiCalls).toBe(0)
      expect(qm.getMain('account-b')).toBeNull()
    })

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
        qm.refreshFallback('fallback-1', 'fallback-token', undefined),
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
        {
          quota: cachedQuota,
          refreshAfter: now,
          checkedAt: now,
        },
        undefined,
      )

      await expect(
        qm.refreshFallback('fallback-1', 'fallback-token', undefined),
      ).rejects.toThrow('429')
      const cached = await qm.refreshFallbackWithMetadata(
        'fallback-1',
        'fallback-token',
        undefined,
      )
      expect(cached).toEqual({ quota: cachedQuota, fetched: false })

      now += 61_000
      const fetched = await qm.refreshFallbackWithMetadata(
        'fallback-1',
        'fallback-token',
        undefined,
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
      qm.setMain('main-account', {
        quota: cachedQuota,
        refreshAfter: now,
        checkedAt: now,
      })

      await expect(
        qm.refreshMain('main-account', 'main-token'),
      ).rejects.toThrow('429')
      const cached = await qm.refreshMainWithMetadata(
        'main-account',
        'main-token',
      )
      expect(cached).toEqual({ quota: cachedQuota, fetched: false })

      now += 61_000
      const fetched = await qm.refreshMainWithMetadata(
        'main-account',
        'main-token',
      )
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

    test('legacy main quota backoff survives ordinary access-token rotation', async () => {
      const fetchMock = mock(() => {
        throw new Error('quota fetch should be blocked by backoff')
      }) as unknown as typeof fetch
      const storage: import('@cortexkit/anthropic-auth-core').AccountStorage = {
        version: 1,
        mainAccountId: 'main-account',
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
        quota: {
          mainLastQuotaApiError: {
            message: 'legacy quota failure',
            checkedAt: now - 1_000,
            nextRetryAt: now + 60_000,
            retryCount: 1,
          },
        },
      }
      const qm = new QuotaManager({
        storage,
        fetchImpl: fetchMock,
        now: () => now,
      })

      expect(qm.isBackedOff()).toBe(true)
      await expect(
        qm.refreshMain('main-account', 'rotated-access-token'),
      ).rejects.toThrow('rate-limited')
      expect(fetchMock).not.toHaveBeenCalled()
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
        await qm.refreshFallback('fallback-1', 'fallback-token', undefined)
      } catch {}

      // Fallback account is backed off; main is not.
      expect(qm.isFallbackBackedOff('fallback-1')).toBe(true)
      expect(qm.isFallbackBackedOff('fallback-1')).toBe(true)
      expect(qm.isBackedOff()).toBe(false)
      // onApiError (persists mainLastQuotaApiError) must NOT have fired.
      expect(apiErrorCount).toBe(0)
      expect(qm.getLastApiError()).toBeUndefined()
      // A different fallback is unaffected.
      expect(qm.isFallbackBackedOff('fallback-2')).toBe(false)
    })

    test('fallback quota backoff survives access-token rotation', async () => {
      // A rotated token still belongs to the same account, so its quota backoff
      // remains active until the account-level retry window expires.
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
        qm.refreshFallback('fallback-1', 'old-token', undefined),
      ).rejects.toThrow('429')
      expect(qm.isFallbackBackedOff('fallback-1')).toBe(true)

      now += 1_100
      await expect(
        qm.refreshFallback('fallback-1', 'new-token', undefined),
      ).rejects.toThrow('rate-limited')
      expect(seenTokens).toEqual(['Bearer old-token'])
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
        qm.refreshFallback('fallback-1', 'fallback-token', undefined),
      ).rejects.toThrow('403')
      expect(qm.isFallbackBackedOff('fallback-1')).toBe(false)
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

      const first = await qm.refreshMain('main-account', 'token')
      expect(first).toBeDefined()

      failNext = true
      now += 1_100
      try {
        await qm.refreshMain('main-account', 'token')
      } catch {}

      const cached = qm.getMain('main-account')
      expect(cached).not.toBeNull()
    })
  })

  test('authoritative fallback lineage rebind clears the old cache', () => {
    const qm = createQM()
    const accountA = {
      id: 'fallback-1',
      type: 'oauth' as const,
      access: 'fallback-a',
      refresh: 'refresh-a',
      expires: now + 60_000,
      authLineageId: 'lineage-a',
      quota: {
        checkedAt: now,
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
      },
    }
    const accountB = {
      ...accountA,
      access: 'fallback-b',
      authLineageId: 'lineage-b',
      quota: {
        checkedAt: now,
        five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: now },
      },
    }

    qm.seedFallbacksFromAccounts([accountA])
    qm.seedFallbacksFromAccounts([accountB])
    qm.seedFallbacksFromAccounts([accountB])

    expect(
      qm.getFallback('fallback-1', accountB)?.quota.five_hour?.usedPercent,
    ).toBe(20)
  })

  test('stale fallback observation is discarded without rebinding the cache', () => {
    const qm = createQM()
    const accountA = {
      id: 'fallback-1',
      type: 'oauth' as const,
      access: 'fallback-a',
      refresh: 'refresh-a',
      expires: now + 60_000,
      authLineageId: 'lineage-a',
      quota: {
        checkedAt: now,
        five_hour: { usedPercent: 10, remainingPercent: 90, checkedAt: now },
      },
    }
    const accountB = {
      ...accountA,
      access: 'fallback-b',
      authLineageId: 'lineage-b',
      quota: {
        checkedAt: now,
        five_hour: { usedPercent: 20, remainingPercent: 80, checkedAt: now },
      },
    }

    qm.seedFallbacksFromAccounts([accountA])
    qm.seedFallbacksFromAccounts([accountB])
    qm.seedFallbacksFromAccounts([accountB])

    expect(
      qm.pushFallbackFromHeaders(
        'fallback-1',
        {
          five_hour: {
            usedPercent: 95,
            remainingPercent: 5,
            checkedAt: now + 1,
          },
          checkedAt: now + 1,
        },
        accountA,
      ),
    ).toBeNull()
    expect(
      qm.getFallback('fallback-1', accountB)?.quota.five_hour?.usedPercent,
    ).toBe(20)
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

    test('getMain(mainAccountId) rejects a cached entry from a different identity', () => {
      const quota = {
        quotas: [],
        expires: new Date(2_000_000).toISOString(),
      }
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          mainAccountId: 'main-a',
          quota: {
            mainQuota: { ...(quota as any), accountIdentity: 'main-a' },
            mainQuotaCheckedAt: 900_000,
          },
        },
        now: () => 1_000_000,
      })

      expect(qm.getMain('main-a')).not.toBeNull()
      expect(qm.getMain('main-b')).toBeNull()
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

    test('seedFallbacksFromAccounts binds persisted fallback quota to account id across token rotation', () => {
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

      expect(qm.getFallback('fallback-1')).not.toBeNull()
      qm.seedFallbacksFromAccounts([
        {
          id: 'fallback-1',
          type: 'oauth',
          access: 'new-fallback-token',
          refresh: 'refresh-token',
          expires: 2_000_000,
        },
      ])
      expect(
        qm.getFallback('fallback-1')?.quota.five_hour?.remainingPercent,
      ).toBe(90)
    })

    test('credential replacement clears fallback quota and quota backoff for the labelled slot', async () => {
      const qm = createQM(
        mock(() =>
          Promise.resolve(new Response('rate limited', { status: 429 })),
        ) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'old-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])

      await expect(
        qm.refreshFallback('work', 'old-access', {
          authLineageId: 'old-login',
        }),
      ).rejects.toThrow('429')
      expect(qm.isFallbackBackedOff('work')).toBe(true)

      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'replacement-login',
          access: 'replacement-access',
          refresh: 'replacement-refresh',
          expires: now + 60_000,
        },
      ])

      expect(qm.getFallback('work')).toBeNull()
      expect(qm.isFallbackBackedOff('work')).toBe(false)
    })

    test('legacy fallback re-login clears quota and quota backoff', async () => {
      const qm = createQM(
        mock(() =>
          Promise.resolve(new Response('rate limited', { status: 429 })),
        ) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          access: 'legacy-access',
          refresh: 'legacy-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])
      await expect(
        qm.refreshFallback('work', 'legacy-access', undefined),
      ).rejects.toThrow('429')

      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'replacement-login',
          access: 'replacement-access',
          refresh: 'replacement-refresh',
          expires: now + 60_000,
        },
      ])

      expect(qm.getFallback('work')).toBeNull()
      expect(qm.isFallbackBackedOff('work')).toBe(false)
    })

    test('legacy fallback re-login starts a new quota poll', async () => {
      let fetchCalls = 0
      let releaseOldPoll!: () => void
      let markOldPollEntered!: () => void
      const oldPollEntered = new Promise<void>((resolve) => {
        markOldPollEntered = resolve
      })
      const oldPoll = new Promise<Response>((resolve) => {
        releaseOldPoll = () => resolve(makeQuotaResponse(now))
      })
      const qm = createQM(
        mock(() => {
          fetchCalls += 1
          if (fetchCalls === 1) {
            markOldPollEntered()
            return oldPoll
          }
          return Promise.resolve(makeQuotaResponse(now))
        }) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          access: 'legacy-access',
          refresh: 'legacy-refresh',
          expires: now + 60_000,
        },
      ])

      const priorPoll = qm.refreshFallback('work', 'legacy-access', undefined)
      await oldPollEntered
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'replacement-login',
          access: 'replacement-access',
          refresh: 'replacement-refresh',
          expires: now + 60_000,
        },
      ])
      const replacementPoll = qm.refreshFallback('work', 'replacement-access', {
        authLineageId: 'replacement-login',
      })
      releaseOldPoll()

      await priorPoll
      await replacementPoll
      expect(fetchCalls).toBe(2)
    })

    test('credential replacement does not reseed a persisted prior-login quota', () => {
      const qm = createQM()
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'old-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])

      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'replacement-login',
          access: 'replacement-access',
          refresh: 'replacement-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])

      expect(qm.getFallback('work')).toBeNull()
    })

    test('credential replacement starts a new fallback poll instead of joining the prior login', async () => {
      let fetchCalls = 0
      let releaseOldPoll!: () => void
      let markOldPollEntered!: () => void
      const oldPollEntered = new Promise<void>((resolve) => {
        markOldPollEntered = resolve
      })
      const oldPoll = new Promise<Response>((resolve) => {
        releaseOldPoll = () =>
          resolve(
            new Response(
              JSON.stringify({
                five_hour: {
                  utilization: 90,
                  resets_at: new Date(now + 3600_000).toISOString(),
                },
              }),
              { status: 200 },
            ),
          )
      })
      const fetchMock = mock(() => {
        fetchCalls += 1
        if (fetchCalls === 1) {
          markOldPollEntered()
          return oldPoll
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              five_hour: {
                utilization: 10,
                resets_at: new Date(now + 3600_000).toISOString(),
              },
            }),
            { status: 200 },
          ),
        )
      }) as unknown as typeof fetch
      const qm = createQM(fetchMock)
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'old-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
        },
      ])

      const priorPoll = qm.refreshFallback('work', 'old-access', {
        authLineageId: 'old-login',
      })
      await oldPollEntered
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'replacement-login',
          access: 'replacement-access',
          refresh: 'replacement-refresh',
          expires: now + 60_000,
        },
      ])
      const replacementPoll = qm.refreshFallback('work', 'replacement-access', {
        authLineageId: 'replacement-login',
      })
      now += 1_000
      releaseOldPoll()

      await priorPoll
      const replacement = await replacementPoll
      expect(fetchCalls).toBe(2)
      expect(replacement.five_hour?.remainingPercent).toBe(90)
      expect(qm.getFallback('work')?.quota.five_hour?.remainingPercent).toBe(90)
    })

    test('replacement-lineage refresh does not join an unseeded prior-login poll', async () => {
      let fetchCalls = 0
      let releaseOldPoll!: () => void
      let markOldPollEntered!: () => void
      const oldPollEntered = new Promise<void>((resolve) => {
        markOldPollEntered = resolve
      })
      const oldPoll = new Promise<Response>((resolve) => {
        releaseOldPoll = () => resolve(makeQuotaResponse(now))
      })
      const fetchMock = mock(() => {
        fetchCalls += 1
        if (fetchCalls === 1) {
          markOldPollEntered()
          return oldPoll
        }
        return Promise.resolve(makeQuotaResponse(now))
      }) as unknown as typeof fetch
      const qm = createQM(fetchMock)
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'old-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
        },
      ])

      const priorPoll = qm.refreshFallback('work', 'old-access', {
        authLineageId: 'old-login',
      })
      await oldPollEntered
      const replacementPoll = qm.refreshFallback('work', 'replacement-access', {
        authLineageId: 'replacement-login',
      })
      now += 1_000
      releaseOldPoll()

      await priorPoll
      await replacementPoll
      expect(fetchCalls).toBe(2)
    })

    test('replacement-lineage refresh clears prior-login quota backoff before reading it', async () => {
      let fetchCalls = 0
      const qm = createQM(
        mock(() => {
          fetchCalls += 1
          if (fetchCalls === 1) {
            return Promise.resolve(
              new Response('rate limited', { status: 429 }),
            )
          }
          return Promise.resolve(makeQuotaResponse(now))
        }) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'old-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])

      await expect(
        qm.refreshFallback('work', 'old-access', {
          authLineageId: 'old-login',
        }),
      ).rejects.toThrow('429')
      now += 1_000

      const replacement = await qm.refreshFallbackWithMetadata(
        'work',
        'replacement-access',
        { authLineageId: 'replacement-login' },
      )

      expect(replacement.fetched).toBe(true)
      expect(qm.isFallbackBackedOff('work')).toBe(false)
      expect(fetchCalls).toBe(2)
    })

    test('ordinary lineage-preserving rotation retains fallback quota and backoff', async () => {
      let fetchCalls = 0
      const qm = createQM(
        mock(() => {
          fetchCalls += 1
          return Promise.resolve(new Response('rate limited', { status: 429 }))
        }) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'stable-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])

      await expect(
        qm.refreshFallback('work', 'old-access', {
          authLineageId: 'stable-login',
        }),
      ).rejects.toThrow('429')
      now += 1_000

      const rotated = await qm.refreshFallbackWithMetadata(
        'work',
        'rotated-access',
        { authLineageId: 'stable-login' },
      )

      expect(rotated).toMatchObject({ fetched: false })
      expect(rotated.quota.five_hour?.remainingPercent).toBe(75)
      expect(qm.isFallbackBackedOff('work')).toBe(true)
      expect(fetchCalls).toBe(1)
    })

    test('ordinary lineage-preserving rotation retains an in-flight fallback poll', async () => {
      let fetchCalls = 0
      let releasePoll!: () => void
      let markPollEntered!: () => void
      const pollEntered = new Promise<void>((resolve) => {
        markPollEntered = resolve
      })
      const delayedResponse = new Promise<Response>((resolve) => {
        releasePoll = () => resolve(makeQuotaResponse(now))
      })
      const qm = createQM(
        mock(() => {
          fetchCalls += 1
          markPollEntered()
          return delayedResponse
        }) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'stable-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
        },
      ])

      const priorPoll = qm.refreshFallback('work', 'old-access', {
        authLineageId: 'stable-login',
      })
      await pollEntered
      const rotatedPoll = qm.refreshFallback('work', 'rotated-access', {
        authLineageId: 'stable-login',
      })
      releasePoll()

      expect(await rotatedPoll).toEqual(await priorPoll)
      expect(fetchCalls).toBe(1)
    })

    test('replacement under a new fallback id removes the departed slot cache', () => {
      const qm = createQM()
      qm.seedFallbacksFromAccounts([
        {
          id: 'old-plugin-id',
          type: 'oauth',
          authLineageId: 'old-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])

      qm.seedFallbacksFromAccounts([
        {
          id: 'new-plugin-id',
          type: 'oauth',
          authLineageId: 'replacement-login',
          access: 'replacement-access',
          refresh: 'replacement-refresh',
          expires: now + 60_000,
        },
      ])

      expect(qm.getFallback('old-plugin-id')).toBeNull()
    })

    test('ordinary fallback token rotation preserves quota and quota backoff', async () => {
      const qm = createQM(
        mock(() =>
          Promise.resolve(new Response('rate limited', { status: 429 })),
        ) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'stable-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              checkedAt: now,
            },
          },
        },
      ])
      await expect(
        qm.refreshFallback('work', 'old-access', {
          authLineageId: 'stable-login',
        }),
      ).rejects.toThrow('429')

      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'stable-login',
          access: 'rotated-access',
          refresh: 'rotated-refresh',
          expires: now + 60_000,
        },
      ])

      expect(qm.getFallback('work')?.quota.five_hour?.remainingPercent).toBe(75)
      expect(qm.isFallbackBackedOff('work')).toBe(true)
    })

    test('ordinary fallback token rotation preserves an in-flight quota poll', async () => {
      let fetchCalls = 0
      let releasePoll!: () => void
      let markPollEntered!: () => void
      const pollEntered = new Promise<void>((resolve) => {
        markPollEntered = resolve
      })
      const delayedResponse = new Promise<Response>((resolve) => {
        releasePoll = () => resolve(makeQuotaResponse(now))
      })
      const qm = createQM(
        mock(() => {
          fetchCalls += 1
          markPollEntered()
          return delayedResponse
        }) as unknown as typeof fetch,
      )
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'stable-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
        },
      ])

      const priorPoll = qm.refreshFallback('work', 'old-access', {
        authLineageId: 'stable-login',
      })
      await pollEntered
      qm.seedFallbacksFromAccounts([
        {
          id: 'work',
          type: 'oauth',
          authLineageId: 'stable-login',
          access: 'rotated-access',
          refresh: 'rotated-refresh',
          expires: now + 60_000,
        },
      ])
      const rotatedPoll = qm.refreshFallback('work', 'rotated-access', {
        authLineageId: 'stable-login',
      })
      releasePoll()

      expect(await rotatedPoll).toEqual(await priorPoll)
      expect(fetchCalls).toBe(1)
    })

    test('seedFallbacksFromAccounts preserves freshness for scoped-only quota', () => {
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
          id: 'scoped-only',
          type: 'oauth',
          access: 'fallback-token',
          refresh: 'refresh-token',
          expires: 2_000_000,
          quota: {
            scoped: [
              {
                id: 'claude-weekly-scoped-fable',
                title: 'Fable only',
                modelName: 'Fable',
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt: 999_000,
              },
            ],
          },
        },
      ])

      expect(qm.getFallback('scoped-only')?.checkedAt).toBe(999_000)
      expect(
        qm.isFallbackStale('scoped-only', 'fallback-token', 'claude-fable-5'),
      ).toBe(false)
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
        undefined,
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

      expect(qm.getFallback('fallback-1')?.checkedAt).toBe(999_000)
      expect(qm.getFallback('fallback-1')?.quota.five_hour?.usedPercent).toBe(
        12,
      )
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

    test('keeps persisted main seed during backoff when the identity matches', async () => {
      const quota = {
        quotas: [],
        expires: new Date(2_000_000).toISOString(),
      }
      const qm = new QuotaManager({
        storage: {
          version: 1,
          accounts: [],
          mainAccountId: 'main-a',
          quota: {
            mainQuota: { ...(quota as any), accountIdentity: 'main-a' },
            mainQuotaCheckedAt: 900_000,
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

      // Same account identity: backed off, so the seed is returned (not refetched).
      const result = await qm.refreshMain('main-a', 'rotated-access-token')
      expect(result).toEqual({ ...(quota as any), accountIdentity: 'main-a' })
      expect(qm.getMain('main-a')).not.toBeNull()
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

  describe('refreshMain dedup (identity-keyed)', () => {
    test('rotated access tokens under one main identity share one in-flight fetch', async () => {
      let fetchCalls = 0
      const fetchMock = mock(async () => {
        fetchCalls++
        return makeQuotaResponse(now)
      }) as unknown as typeof fetch
      const qm = new QuotaManager({
        storage: null,
        fetchImpl: fetchMock,
        now: () => now,
      })

      const [quotaA, quotaB] = await Promise.all([
        qm.refreshMain('main-account', 'access-token-a'),
        qm.refreshMain('main-account', 'access-token-b'),
      ])

      expect(quotaA).toEqual(quotaB)
      expect(fetchCalls).toBe(1)
    })

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

  describe('main identity cache seeding', () => {
    const persistedQuota = {
      five_hour: {
        usedPercent: 25,
        remainingPercent: 75,
        checkedAt: 900_000,
      },
      checkedAt: 900_000,
    }

    test('does not share a cached entry with a different main identity', () => {
      const storage = {
        version: 1 as const,
        accounts: [],
        mainAccountId: 'main-a',
        quota: {
          mainQuota: { ...persistedQuota, accountIdentity: 'main-a' },
          mainQuotaCheckedAt: 900_000,
        },
      }
      const qm = new QuotaManager({ storage, now: () => now })

      expect(qm.getMain('main-a')).not.toBeNull()
      expect(qm.getMain('main-b')).toBeNull()
    })

    test('adopts legacy persisted quota without an account identity', () => {
      const storage = {
        version: 1 as const,
        accounts: [],
        mainAccountId: 'main-a',
        quota: {
          mainQuota: persistedQuota,
          mainQuotaCheckedAt: 900_000,
        },
      }
      const qm = new QuotaManager({ storage, now: () => now })

      expect(qm.getMain('main-a')).not.toBeNull()
      expect(qm.getMain('main-a')?.quota.accountIdentity).toBe('main-a')
    })

    test('missing main identity leaves quota unknown without changing credentials', () => {
      const storage = {
        version: 1 as const,
        mainAccountId: 'main-a',
        main: { type: 'opencode' as const, provider: 'anthropic' as const },
        accounts: [
          {
            id: 'fallback-a',
            type: 'oauth' as const,
            access: 'fallback-access',
            refresh: 'fallback-refresh',
          },
        ],
        quota: {
          mainQuota: { ...persistedQuota, accountIdentity: 'main-a' },
          mainQuotaCheckedAt: 900_000,
        },
      }
      const qm = new QuotaManager({ storage, now: () => now })

      qm.seedMainFromStorage(storage, undefined)

      expect(qm.getMain()).toBeNull()
      expect(storage.accounts[0]?.access).toBe('fallback-access')
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

      const pushed = qm.pushMainFromHeaders('main-account', headerSnapshot())

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

    test('header push never introduces poll-owned scoped data', () => {
      const qm = createQM()
      const incoming = {
        ...headerSnapshot(),
        scoped: [
          {
            id: 'header-scope',
            title: 'Header scope',
            modelName: 'Fable',
            usedPercent: 1,
            remainingPercent: 99,
            checkedAt: now,
          },
        ],
        extraUsage: {
          used: { amountMinor: 1, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 100, currency: 'USD', exponent: 2 },
          exhausted: false,
        },
      } as OAuthQuotaSnapshot

      const pushed = qm.pushMainFromHeaders('token', incoming)

      expect('scoped' in pushed.quota).toBe(false)
      expect(pushed.quota.scoped).toBeUndefined()
      expect('extraUsage' in pushed.quota).toBe(false)
      expect(pushed.quota.extraUsage).toBeUndefined()
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

    test('cache seeding restores poll-owned fields before a newer header harvest', () => {
      const qm = createQM()
      const scoped = [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 55,
          remainingPercent: 45,
          checkedAt: 100,
        },
      ]
      const extraUsage = {
        used: { amountMinor: 1261, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        utilizationPercent: 12.61,
        severity: 'normal',
        exhausted: false,
      }
      qm.setMain('main-account', {
        quota: {
          ...headerSnapshot(200),
          bindingWindow: 'claude-weekly-scoped-fable',
          bindingWindowSource: 'poll',
        },
        checkedAt: 200,
        refreshAfter: 300,
      })

      qm.seedMainFromStorage(
        {
          version: 1,
          mainAccountId: 'main-account',
          accounts: [],
          quota: {
            mainQuota: {
              source: 'poll',
              checkedAt: 100,
              scoped,
              extraUsage,
              bindingWindow: 'claude-weekly-scoped-fable',
              bindingWindowSource: 'poll',
            },
            mainQuotaCheckedAt: 100,
          },
        },
        'main-account',
      )

      const pushed = qm.pushMainFromHeaders('main-account', headerSnapshot(300))

      expect(pushed.quota.scoped).toEqual(scoped)
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
      qm.setFallback(
        'other',
        {
          quota: { checkedAt: 100 },
          checkedAt: 100,
          refreshAfter: 200,
        },
        undefined,
      )

      qm.pushFallbackFromHeaders('target', headerSnapshot(), undefined)

      expect(qm.getFallback('target')?.quota.five_hour?.usedPercent).toBe(78)
      expect(qm.getFallback('other')?.quota.checkedAt).toBe(100)
    })

    test('clears a header cache written before its first seed when the login lineage changes', () => {
      const qm = createQM()

      qm.pushFallbackFromHeaders('fallback', headerSnapshot(), {
        authLineageId: 'first-login',
      })
      qm.seedFallbacksFromAccounts([
        {
          id: 'fallback',
          type: 'oauth',
          authLineageId: 'replacement-login',
          access: 'replacement-access',
          refresh: 'replacement-refresh',
          expires: now + 60_000,
        },
      ])

      expect(qm.getFallback('fallback')).toBeNull()
    })

    test('replacement-lineage header push discards the stale observation', () => {
      const qm = createQM()
      qm.seedFallbacksFromAccounts([
        {
          id: 'fallback',
          type: 'oauth',
          authLineageId: 'old-login',
          access: 'old-access',
          refresh: 'old-refresh',
          expires: now + 60_000,
          quota: {
            scoped: [
              {
                id: 'old-login-scope',
                title: 'Old login scope',
                modelName: 'Old login',
                usedPercent: 90,
                remainingPercent: 10,
                checkedAt: now,
              },
            ],
            source: 'poll',
            checkedAt: now,
          },
        },
      ])

      const pushed = qm.pushFallbackFromHeaders('fallback', headerSnapshot(), {
        authLineageId: 'replacement-login',
      })

      expect(pushed).toBeNull()
      expect(qm.getFallback('fallback')?.quota.scoped).toEqual([
        expect.objectContaining({ id: 'old-login-scope' }),
      ])
    })

    test('header push binds main to account identity and fallback to account id', () => {
      const qm = createQM()

      qm.pushMainFromHeaders('main-account', headerSnapshot())
      qm.pushFallbackFromHeaders('fallback', headerSnapshot(), undefined)

      expect(qm.getMain('different-account')).toBeNull()
      expect(qm.getFallback('fallback')).not.toBeNull()
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
