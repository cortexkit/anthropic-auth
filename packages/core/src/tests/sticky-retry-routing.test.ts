import { expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OAuthQuotaSnapshot } from '../accounts.ts'
import { sessionCacheActivity } from '../session-cache-activity.ts'
import { StickySessionRouter } from '../sticky-routing.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const lifetimes = createTestLifetimeSuite()
const now = 1_800_000_000_000
const modelId = 'claude-fable-5-2'
const quota = (
  remainingPercent: number,
  checkedAt = now,
): OAuthQuotaSnapshot => {
  const window = {
    remainingPercent,
    checkedAt,
    usedPercent: 100 - remainingPercent,
  }
  return { source: 'poll', five_hour: window, seven_day: window }
}

async function retryFixture(sessionId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'sticky-retry-'))
  const router = new StickySessionRouter({
    path: join(directory, 'routing.json'),
    now: () => now,
  })
  lifetimes.deferCleanup(async () => {
    sessionCacheActivity.forget(sessionId)
    await router.drain()
    await rm(directory, { recursive: true, force: true })
  })
  const candidates = [
    { accountId: 'refused', order: 0, quota: quota(90) },
    { accountId: 'cold', order: 1, quota: quota(90) },
    { accountId: 'warm', order: 2, quota: quota(20) },
  ]
  const input = {
    sessionId,
    family: 'fable' as const,
    modelId,
    candidates,
    retainAccountIds: new Set(
      candidates.map((candidate) => candidate.accountId),
    ),
    storage: null,
    inputBytes: 1,
  }
  expect(
    (await router.resolve({ ...input, routingAccountId: 'refused' }))
      ?.accountId,
  ).toBe('refused')
  sessionCacheActivity.record(sessionId, 'warm', 300_000, now)
  return {
    router,
    retry: {
      ...input,
      excludeAccountIds: new Set(['refused']),
      preferWarmRetryAccount: true,
    },
  }
}

lifetimes.test(
  'a retry prefers the warm account when routing repeats the refused account',
  async () => {
    const { router, retry } = await retryFixture('repeated-advice')
    expect(
      (await router.resolve({ ...retry, routingAccountId: 'refused' }))
        ?.accountId,
    ).toBe('warm')
  },
)

lifetimes.test(
  'absent or unverified advice does not suppress the usable warm account',
  async () => {
    const { router, retry } = await retryFixture('unavailable-advice')
    expect(
      (await router.resolve({ ...retry, routingAccountId: 'not-in-pool' }))
        ?.accountId,
    ).toBe('warm')
    expect(
      (
        await router.resolve({
          ...retry,
          routingAccountId: 'cold',
          accountIdentities: new Map([['warm', 'warm-uuid']]),
        })
      )?.accountId,
    ).toBe('warm')
  },
)

lifetimes.test(
  'admitted routing advice wins over a warm and retained retry pin',
  async () => {
    const { router, retry } = await retryFixture('admitted-advice')
    expect((await router.resolve(retry))?.accountId).toBe('warm')
    expect(
      (await router.resolve({ ...retry, routingAccountId: 'cold' }))?.accountId,
    ).toBe('cold')
  },
)

lifetimes.test(
  'a retry never prefers a warm account that is exhausted, stale or at the quota floor',
  async () => {
    for (const [reason, blockedQuota] of [
      ['exhausted', quota(0)],
      ['stale', quota(90, now - 86_400_000)],
      ['floor', quota(10)],
    ] as const) {
      const { router, retry } = await retryFixture(`warm-${reason}`)
      expect(
        (
          await router.resolve({
            ...retry,
            routingAccountId: 'refused',
            storage: {
              version: 1,
              accounts: [],
              quota: { minimumRemaining: { five_hour: 10, seven_day: 10 } },
            },
            candidates: retry.candidates.map((candidate) =>
              candidate.accountId === 'warm'
                ? { ...candidate, quota: blockedQuota }
                : candidate,
            ),
          })
        )?.accountId,
      ).toBe('cold')
    }
  },
)
