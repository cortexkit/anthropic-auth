import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStickyNoRouteResponse,
  decideStickyQuotaFailure,
  getStickyRoutingStatePath,
  type OAuthQuotaSnapshot,
  type StickyRouteCandidate,
  StickySessionRouter,
  stickyQuotaSnapshotIsFresh,
  stickyRetryAfterWithJitter,
  stickyRouteCandidateWeight,
} from '@cortexkit/anthropic-auth-core'

const NOW = Date.parse('2026-07-18T08:00:00Z')
const directories: string[] = []
type KnownStickyRouteCandidate = Omit<StickyRouteCandidate, 'quota'> & {
  quota: OAuthQuotaSnapshot
}

async function statePath() {
  const directory = await mkdtemp(join(tmpdir(), 'sticky-routing-test-'))
  directories.push(directory)
  return getStickyRoutingStatePath(join(directory, 'anthropic-auth.json'))
}

function candidate(input: {
  accountId: string
  order: number
  fiveHour: number
  sevenDay: number
  fable: number
  resetHours?: number
}): KnownStickyRouteCandidate {
  const checkedAt = NOW - 1_000
  const resetsAt = new Date(
    NOW + (input.resetHours ?? 96) * 60 * 60_000,
  ).toISOString()
  return {
    accountId: input.accountId,
    order: input.order,
    quota: {
      checkedAt,
      five_hour: {
        usedPercent: 100 - input.fiveHour,
        remainingPercent: input.fiveHour,
        resetsAt: new Date(NOW + 3 * 60 * 60_000).toISOString(),
        checkedAt,
      },
      seven_day: {
        usedPercent: 100 - input.sevenDay,
        remainingPercent: input.sevenDay,
        resetsAt,
        checkedAt,
      },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100 - input.fable,
          remainingPercent: input.fable,
          resetsAt,
          checkedAt,
        },
      ],
    },
  }
}

const storage = {
  version: 1 as const,
  quota: {
    enabled: true,
    minimumRemaining: { five_hour: 1, seven_day: 1 },
    failClosedOnUnknownQuota: true,
  },
  accounts: [],
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('sticky-balanced session routing', () => {
  test('reports a permanent main auth failure when no fallback route is eligible', async () => {
    const exhausted = candidate({
      accountId: 'fallback',
      order: 1,
      fiveHour: 100,
      sevenDay: 100,
      fable: 0,
    })
    const response = createStickyNoRouteResponse({
      mainRefreshError: {
        message: 'invalid_grant',
        checkedAt: NOW,
        status: 400,
        permanent: true,
      },
      routeQuotas: [exhausted.quota],
      modelId: 'claude-fable-5',
      now: NOW,
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message:
          'Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable for Fable.',
      },
    })
  })

  test('reports fallback accounts that require re-login when no route is eligible', async () => {
    const exhausted = candidate({
      accountId: 'main',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 0,
    })
    const response = createStickyNoRouteResponse({
      fallbackReauthLabels: ['ufuk2', 'yiyi'],
      routeQuotas: [exhausted.quota],
      modelId: 'claude-fable-5',
      now: NOW,
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message:
          'No OAuth account is currently routable for Fable. Fallback Claude OAuth accounts require re-login: ufuk2, yiyi.',
      },
    })
  })

  test('returns a scoped quota block when every sticky route is exhausted', async () => {
    const exhausted = candidate({
      accountId: 'main',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 0,
    })
    const response = createStickyNoRouteResponse({
      routeQuotas: [exhausted.quota],
      modelId: 'claude-fable-5',
      now: NOW,
    })

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBe(96 * 60 * 60 + 60)
    expect(await response.json()).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message:
          'Fable weekly limit reached, no routable OAuth accounts. Retry in 5761m 0s.',
      },
    })
  })

  test('weights Fable accounts by spendable quota and time to reset', () => {
    const scarce = candidate({
      accountId: 'yiyi',
      order: 1,
      fiveHour: 97,
      sevenDay: 51,
      fable: 13,
      resetHours: 132,
    })
    const abundant = candidate({
      accountId: 'ufuk2',
      order: 2,
      fiveHour: 100,
      sevenDay: 99,
      fable: 98,
      resetHours: 91,
    })
    const scarceWeight = stickyRouteCandidateWeight({
      candidate: scarce,
      family: 'fable',
      modelId: 'claude-fable-5',
      storage,
      now: NOW,
    })
    const abundantWeight = stickyRouteCandidateWeight({
      candidate: abundant,
      family: 'fable',
      modelId: 'claude-fable-5',
      storage,
      now: NOW,
    })

    expect(abundantWeight).toBeGreaterThan(scarceWeight * 10)
  })

  test('refreshes sticky quota snapshots even when general quota gating is disabled', () => {
    const stale = candidate({
      accountId: 'main',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    }).quota
    stale.five_hour!.checkedAt = NOW - 6 * 60_000
    stale.seven_day!.checkedAt = NOW - 6 * 60_000

    expect(
      stickyQuotaSnapshotIsFresh(
        stale,
        {
          ...storage,
          quota: { ...storage.quota, enabled: false, checkIntervalMinutes: 5 },
        },
        NOW,
      ),
    ).toBe(false)

    const staleScoped = candidate({
      accountId: 'main',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 0,
    }).quota
    staleScoped.scoped![0]!.checkedAt = NOW - 6 * 60_000
    expect(
      stickyQuotaSnapshotIsFresh(staleScoped, storage, NOW, 'claude-fable-5'),
    ).toBe(false)
  })

  test('distributes cold Fable sessions proportionally instead of draining account order', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const scarce = candidate({
      accountId: 'yiyi',
      order: 0,
      fiveHour: 97,
      sevenDay: 51,
      fable: 13,
      resetHours: 132,
    })
    const abundant = candidate({
      accountId: 'ufuk2',
      order: 1,
      fiveHour: 100,
      sevenDay: 99,
      fable: 98,
      resetHours: 91,
    })
    const counts = { yiyi: 0, ufuk2: 0 }

    for (let index = 0; index < 12; index++) {
      const resolution = await router.resolve({
        sessionId: `cold-session-${index}`,
        family: 'fable',
        modelId: 'claude-fable-5',
        candidates: [scarce, abundant],
        retainAccountIds: new Set(['yiyi', 'ufuk2']),
        storage,
        inputBytes: 1_000_000,
      })
      counts[resolution!.accountId as keyof typeof counts] += 1
    }

    expect(counts).toEqual({ yiyi: 1, ufuk2: 11 })
  })

  test('seeds an existing cachekeep session from its current OAuth route', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const scarce = candidate({
      accountId: 'existing-route',
      order: 0,
      fiveHour: 90,
      sevenDay: 40,
      fable: 10,
    })
    const abundant = candidate({
      accountId: 'quota-winner',
      order: 1,
      fiveHour: 100,
      sevenDay: 99,
      fable: 98,
    })

    const resolution = await router.resolve({
      sessionId: 'already-warm-session',
      family: 'fable',
      modelId: 'claude-fable-5',
      candidates: [scarce, abundant],
      retainAccountIds: new Set(['existing-route', 'quota-winner']),
      preferredAccountId: 'existing-route',
      storage,
      inputBytes: 1_000_000,
    })

    expect(resolution?.accountId).toBe('existing-route')
  })

  test('does not seed a cold session onto an ineligible preferred account', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const exhausted = candidate({
      accountId: 'old-cache-route',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 0,
    })
    const healthy = candidate({
      accountId: 'healthy-route',
      order: 1,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    })
    const resolution = await router.resolve({
      sessionId: 'expired-cache-seed',
      family: 'fable',
      modelId: 'claude-fable-5',
      candidates: [exhausted, healthy],
      retainAccountIds: new Set(['old-cache-route', 'healthy-route']),
      preferredAccountId: 'old-cache-route',
      storage,
      inputBytes: 1_000,
    })
    expect(resolution?.accountId).toBe('healthy-route')
  })

  test('persists an assignment and keeps it sticky when weights change', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const scarce = candidate({
      accountId: 'scarce',
      order: 0,
      fiveHour: 90,
      sevenDay: 40,
      fable: 10,
    })
    const abundant = candidate({
      accountId: 'abundant',
      order: 1,
      fiveHour: 100,
      sevenDay: 99,
      fable: 98,
    })
    const first = await router.resolve({
      sessionId: 'session-1',
      family: 'fable',
      modelId: 'claude-fable-5',
      candidates: [scarce, abundant],
      retainAccountIds: new Set(['scarce', 'abundant']),
      storage,
      inputBytes: 1_000_000,
    })
    expect(first?.accountId).toBe('abundant')
    expect(first?.created).toBe(true)
    const persisted = await readFile(path, 'utf8')
    expect(persisted).not.toContain('session-1')
    expect(persisted).toContain('abundant')

    const reloaded = new StickySessionRouter({ path, now: () => NOW + 1_000 })
    const second = await reloaded.resolve({
      sessionId: 'session-1',
      family: 'fable',
      modelId: 'claude-fable-5',
      candidates: [
        candidate({
          accountId: 'scarce',
          order: 0,
          fiveHour: 100,
          sevenDay: 100,
          fable: 100,
        }),
        candidate({
          accountId: 'abundant',
          order: 1,
          fiveHour: 10,
          sevenDay: 10,
          fable: 10,
        }),
      ],
      retainAccountIds: new Set(['scarce', 'abundant']),
      storage,
      inputBytes: 10,
    })
    expect(second?.accountId).toBe('abundant')
    expect(second?.created).toBe(false)
    expect(second?.migrated).toBe(false)
  })

  test('does not reserve a direct Opus session from stale Fable exhaustion', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const staleDepleted = candidate({
      accountId: 'stale-depleted',
      order: 0,
      fiveHour: 100,
      sevenDay: 40,
      fable: 0,
    })
    staleDepleted.quota.scoped![0]!.checkedAt = NOW - 6 * 60_000
    const healthy = candidate({
      accountId: 'healthy',
      order: 1,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    })
    const result = await router.resolve({
      sessionId: 'opus-stale-fable-session',
      family: 'opus',
      modelId: 'claude-opus-4-8',
      candidates: [staleDepleted, healthy],
      retainAccountIds: new Set(['stale-depleted', 'healthy']),
      storage,
      inputBytes: 10_000,
    })
    expect(result?.accountId).toBe('healthy')
  })

  test('uses known Fable-depleted accounts first for direct Opus sessions', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const depleted = candidate({
      accountId: 'main',
      order: 0,
      fiveHour: 100,
      sevenDay: 40,
      fable: 0,
    })
    const fableRich = candidate({
      accountId: 'ufuk2',
      order: 1,
      fiveHour: 100,
      sevenDay: 99,
      fable: 98,
    })
    const result = await router.resolve({
      sessionId: 'opus-session',
      family: 'opus',
      modelId: 'claude-opus-4-8',
      candidates: [depleted, fableRich],
      retainAccountIds: new Set(['main', 'ufuk2']),
      storage,
      inputBytes: 10_000,
    })
    expect(result?.accountId).toBe('main')
  })

  test('expires an inactive assignment even while the router process stays alive', async () => {
    const path = await statePath()
    let now = NOW
    const router = new StickySessionRouter({
      path,
      now: () => now,
      assignmentTtlMs: 1_000,
    })
    const available = candidate({
      accountId: 'main',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    })
    const input = {
      sessionId: 'expired-session',
      family: 'fable' as const,
      modelId: 'claude-fable-5',
      candidates: [available],
      retainAccountIds: new Set(['main']),
      storage,
      inputBytes: 1_000,
    }
    const first = await router.resolve(input)
    now += 2_000
    const second = await router.resolve(input)

    expect(first?.created).toBe(true)
    expect(second?.created).toBe(true)
    expect(second?.assignment.assignedAt).toBe(now)
  })

  test('serializes concurrent first assignment across router instances', async () => {
    const path = await statePath()
    const left = new StickySessionRouter({ path })
    const right = new StickySessionRouter({ path })
    const candidates = [
      candidate({
        accountId: 'a',
        order: 0,
        fiveHour: 100,
        sevenDay: 100,
        fable: 100,
      }),
      candidate({
        accountId: 'b',
        order: 1,
        fiveHour: 100,
        sevenDay: 100,
        fable: 100,
      }),
    ]
    const request = (router: StickySessionRouter) =>
      router.resolve({
        sessionId: 'shared-session',
        family: 'fable',
        modelId: 'claude-fable-5',
        candidates,
        retainAccountIds: new Set(['a', 'b']),
        storage,
        inputBytes: 1_000,
      })
    const [first, second] = await Promise.all([request(left), request(right)])
    expect(first?.accountId).toBe(second?.accountId)
  })

  test('observes assignment resets written by another router process', async () => {
    const path = await statePath()
    const left = new StickySessionRouter({ path, now: () => NOW })
    const right = new StickySessionRouter({ path, now: () => NOW + 1 })
    const available = candidate({
      accountId: 'main',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    })
    const input = {
      sessionId: 'cross-process-reset',
      family: 'fable' as const,
      modelId: 'claude-fable-5',
      candidates: [available],
      retainAccountIds: new Set(['main']),
      storage,
      inputBytes: 1_000,
    }
    await left.resolve(input)
    expect((await right.resolve(input))?.created).toBe(false)
    await left.clear(input.sessionId)
    expect((await right.resolve(input))?.created).toBe(true)
  })

  test('migrates atomically when the assigned account is explicitly excluded', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const candidates = [
      candidate({
        accountId: 'a',
        order: 0,
        fiveHour: 100,
        sevenDay: 100,
        fable: 100,
      }),
      candidate({
        accountId: 'b',
        order: 1,
        fiveHour: 100,
        sevenDay: 100,
        fable: 100,
      }),
    ]
    const first = await router.resolve({
      sessionId: 'migrating-session',
      family: 'fable',
      modelId: 'claude-fable-5',
      candidates,
      retainAccountIds: new Set(['a', 'b']),
      storage,
      inputBytes: 1_000,
    })
    const second = await router.resolve({
      sessionId: 'migrating-session',
      family: 'fable',
      modelId: 'claude-fable-5',
      candidates,
      retainAccountIds: new Set(['a', 'b']),
      excludeAccountIds: new Set([first!.accountId]),
      storage,
      inputBytes: 1_000,
    })
    expect(second?.accountId).not.toBe(first?.accountId)
    expect(second?.migrated).toBe(true)
  })

  test('migrates for model-scoped, weekly, and long five-hour exhaustion', () => {
    const base = candidate({
      accountId: 'candidate',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    }).quota
    expect(
      decideStickyQuotaFailure({
        quota: {
          ...base,
          scoped: [{ ...base.scoped![0]!, remainingPercent: 0 }],
        },
        modelId: 'claude-fable-5',
        now: NOW,
      }),
    ).toMatchObject({ action: 'migrate', reason: 'model-scoped' })
    expect(
      decideStickyQuotaFailure({
        quota: {
          ...base,
          seven_day: { ...base.seven_day!, remainingPercent: 0 },
        },
        modelId: 'claude-opus-4-8',
        now: NOW,
      }),
    ).toMatchObject({ action: 'migrate', reason: 'seven-day' })
    expect(
      decideStickyQuotaFailure({
        quota: {
          ...base,
          five_hour: {
            ...base.five_hour!,
            remainingPercent: 0,
            resetsAt: new Date(NOW + 16 * 60_000).toISOString(),
          },
        },
        modelId: 'claude-opus-4-8',
        now: NOW,
      }),
    ).toMatchObject({ action: 'migrate', reason: 'five-hour' })
  })

  test('adds bounded deterministic retry jitter per session', () => {
    const first = stickyRetryAfterWithJitter('session-a', 840)
    expect(first).toBe(stickyRetryAfterWithJitter('session-a', 840))
    expect(first).toBeGreaterThanOrEqual(840)
    expect(first).toBeLessThanOrEqual(860)
  })

  test('holds a five-hour exhausted route when reset is within fifteen minutes', () => {
    const decision = decideStickyQuotaFailure({
      quota: {
        five_hour: {
          usedPercent: 100,
          remainingPercent: 0,
          resetsAt: new Date(NOW + 14 * 60_000).toISOString(),
          checkedAt: NOW,
        },
        seven_day: {
          usedPercent: 10,
          remainingPercent: 90,
          checkedAt: NOW,
        },
      },
      modelId: 'claude-fable-5',
      now: NOW,
    })
    expect(decision).toEqual({
      action: 'hold',
      reason: 'five-hour-short-reset',
      retryAfterSeconds: 14 * 60,
    })
  })

  test('keeps an unknown quota as a retained route instead of treating it as absent', () => {
    expect(
      decideStickyQuotaFailure({
        quota: { kind: 'unknown' },
        modelId: 'claude-opus-5',
        now: NOW,
      }),
    ).toEqual({ action: 'retain', reason: 'unknown' })
  })

  test('excludes an unknown-quota candidate from cold weighted selection when a known candidate exists', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const known = candidate({
      accountId: 'known',
      order: 1,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    })
    const resolution = await router.resolve({
      sessionId: 'unknown-quota-cold-selection',
      family: 'fable',
      modelId: 'claude-fable-5',
      candidates: [
        { accountId: 'unknown', quota: { kind: 'unknown' }, order: 0 },
        known,
      ],
      retainAccountIds: new Set(['unknown', 'known']),
      storage,
      inputBytes: 1_000,
    })

    expect(resolution?.accountId).toBe('known')
  })

  test('router-level escape degrades to ordered selection when every candidate quota is unknown', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const resolution = await router.resolve({
      sessionId: 'all-unknown-quota-selection',
      family: 'general',
      candidates: [
        { accountId: 'later', quota: { kind: 'unknown' }, order: 1 },
        { accountId: 'first', quota: { kind: 'unknown' }, order: 0 },
      ],
      retainAccountIds: new Set(['later', 'first']),
      storage,
      inputBytes: 1_000,
    })

    expect(resolution?.accountId).toBe('first')
  })

  test('does not escape to an exhausted candidate when every known quota is exhausted', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const resolution = await router.resolve({
      sessionId: 'all-exhausted-quota-selection',
      family: 'general',
      candidates: [
        candidate({
          accountId: 'first',
          order: 0,
          fiveHour: 0,
          sevenDay: 0,
          fable: 0,
        }),
        candidate({
          accountId: 'later',
          order: 1,
          fiveHour: 0,
          sevenDay: 0,
          fable: 0,
        }),
      ],
      retainAccountIds: new Set(['first', 'later']),
      storage,
      inputBytes: 1_000,
    })

    expect(resolution).toBeNull()
  })

  test('router-level pending bytes reset when an unknown quota becomes known', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const unknown = {
      accountId: 'a',
      quota: { kind: 'unknown' as const },
      order: 0,
    }
    const knownA = candidate({
      accountId: 'a',
      order: 0,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    })
    const knownB = candidate({
      accountId: 'b',
      order: 1,
      fiveHour: 100,
      sevenDay: 100,
      fable: 100,
    })

    await router.resolve({
      sessionId: 'unknown-pending-bytes',
      family: 'general',
      candidates: [unknown],
      retainAccountIds: new Set(['a']),
      storage,
      inputBytes: 100_000,
    })
    const resolution = await router.resolve({
      sessionId: 'known-after-unknown',
      family: 'general',
      candidates: [knownA, knownB],
      retainAccountIds: new Set(['a', 'b']),
      storage,
      inputBytes: 1,
    })

    expect(resolution?.accountId).toBe('a')
  })

  test('keeps an excluded route out of a new assignment', async () => {
    const path = await statePath()
    const router = new StickySessionRouter({ path, now: () => NOW })
    const input = {
      sessionId: 'restricted-unknown-identity',
      family: 'general',
      candidates: [
        {
          accountId: 'unknown-identity',
          quota: candidate({
            accountId: 'unknown-identity',
            order: 0,
            fiveHour: 100,
            sevenDay: 100,
            fable: 100,
          }).quota,
          order: 0,
        },
      ],
      storage,
      inputBytes: 1_000,
    } as const
    await router.resolve({
      ...input,
      retainAccountIds: new Set(['unknown-identity']),
    })
    const resolution = await router.resolve({
      ...input,
      retainAccountIds: new Set(),
      excludeAccountIds: new Set(['unknown-identity']),
    })

    expect(resolution).toBeNull()
  })
})
