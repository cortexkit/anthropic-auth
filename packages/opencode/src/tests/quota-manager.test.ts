import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { QuotaManager } from '@cortexkit/anthropic-auth-core'

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

  beforeEach(() => {
    now = 1_000_000
  })

  function createQM(fetchImpl?: typeof fetch) {
    return new QuotaManager({
      storage: null,
      fetchImpl,
      now: () => now,
    })
  }

  describe('backoff', () => {
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
})
