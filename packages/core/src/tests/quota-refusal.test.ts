import { expect, test } from 'bun:test'
import {
  type AccountStorage,
  type OAuthQuotaSnapshot,
  quotaRefusalTiming,
} from '../accounts.ts'
import { createQuotaRefusalResponse } from '../quota-refusal.ts'
import { createStickyNoRouteResponse } from '../sticky-routing.ts'

const now = Date.parse('2026-11-02T10:00:00Z')
const resetAt = now + 2 * 3_600_000
const quota = (
  checkedAt = now,
  accountIdentity = 'current',
): OAuthQuotaSnapshot => ({
  accountIdentity,
  five_hour: {
    remainingPercent: 0,
    usedPercent: 100,
    checkedAt,
    resetsAt: new Date(resetAt).toISOString(),
  },
  seven_day: {
    remainingPercent: 0,
    usedPercent: 100,
    checkedAt,
    resetsAt: new Date(resetAt + 3_600_000).toISOString(),
  },
})
const storage = (maxSameAccountWait: '0' | '15' | 'max'): AccountStorage => ({
  version: 1,
  accounts: [],
  routing: { maxSameAccountWait },
})

test('only fresh current-identity scope-covered resets feed the terminal scan', () => {
  for (const reading of [
    { quota: quota(now - 3_600_000), accountIdentity: 'current' },
    { quota: quota(), accountIdentity: undefined },
    { quota: quota(now, 'previous'), accountIdentity: 'current' },
    { quota: { ...quota(), seven_day: undefined }, accountIdentity: 'current' },
  ]) {
    expect(quotaRefusalTiming({ readings: [reading], now })).toEqual({
      resetAt: undefined,
      retryAfterSeconds: 300,
    })
  }
  expect(
    quotaRefusalTiming({
      readings: [{ quota: quota(), accountIdentity: 'current' }],
      now,
    }),
  ).toEqual({ resetAt, retryAfterSeconds: 900 })
  const earlier = quota()
  earlier.five_hour!.resetsAt = new Date(now + 600_000).toISOString()
  expect(
    quotaRefusalTiming({
      readings: [
        { quota: quota(), accountIdentity: 'current' },
        { quota: earlier, accountIdentity: 'current' },
      ],
      now,
    }),
  ).toEqual({ resetAt: now + 600_000, retryAfterSeconds: 600 })
})

test('refusal caps follow zero, fifteen and max without hiding the true reset', async () => {
  for (const [wait, ttl, expected] of [
    ['0', undefined, undefined],
    ['15', undefined, 900],
    ['max', undefined, 300],
    ['max', 3_600_000, 3600],
  ] as const) {
    const timing = quotaRefusalTiming({
      readings: [{ quota: quota(), accountIdentity: 'current' }],
      storage: storage(wait),
      sessionTtlMs: ttl,
      now,
    })
    expect(timing).toEqual({ resetAt, retryAfterSeconds: expected })
    const response = createQuotaRefusalResponse(
      'No OAuth account currently satisfies sticky-balanced quota policy.',
      timing,
      now,
    )
    expect(response.status).toBe(wait === '0' ? 412 : 429)
    expect(response.headers.get('retry-after')).toBe(
      expected === undefined ? null : String(expected),
    )
    const body = (await response.json()) as {
      error: { type: string; message: string }
    }
    expect(body.error.message).toContain('Reset at ')
    expect(body.error.message).toContain(
      new Intl.DateTimeFormat('en-US', {
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(resetAt),
    )
    if (wait === '0') {
      expect(body.error.type).toBe('FAILED_PRECONDITION')
      expect(body.error.message).not.toMatch(
        /429|500|502|503|504|524|retry|rate.?limit|overloaded|timeout/i,
      )
    } else expect(body.error.message).toContain('Retry in 120m 0s.')
  }
})

test('scoped refusal scans only the fresh matching model window', () => {
  const q = quota()
  q.scoped = [
    {
      id: 'fable',
      title: 'Fable',
      modelName: 'Fable',
      remainingPercent: 0,
      usedPercent: 100,
      checkedAt: now,
      resetsAt: new Date(resetAt + 3_600_000).toISOString(),
    },
  ]
  expect(
    quotaRefusalTiming({
      readings: [{ quota: q, accountIdentity: 'current' }],
      scopedModelId: 'claude-fable-5',
      now,
    }).resetAt,
  ).toBe(resetAt + 3_600_000)
  expect(
    quotaRefusalTiming({
      readings: [{ quota: q, accountIdentity: 'current' }],
      scopedModelId: 'claude-opus-5',
      now,
    }).resetAt,
  ).toBeUndefined()
})

test('zero wait does not change re-login precedence', () => {
  expect(
    createStickyNoRouteResponse({
      routeQuotas: [quota()],
      routeIdentities: ['current'],
      storage: storage('0'),
      fallbackReauthLabels: ['work'],
      now,
    }).status,
  ).toBe(401)
})
