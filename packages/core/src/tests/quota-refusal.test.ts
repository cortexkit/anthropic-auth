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
    resetsAt: new Date(resetAt).toISOString(),
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
  ).toMatchObject({ resetAt, retryAfterSeconds: 900 })
  const earlier = quota()
  earlier.five_hour!.resetsAt = new Date(now + 600_000).toISOString()
  earlier.seven_day!.resetsAt = new Date(now + 600_000).toISOString()
  expect(
    quotaRefusalTiming({
      readings: [
        { quota: quota(), accountIdentity: 'current' },
        { quota: earlier, accountIdentity: 'current' },
      ],
      now,
    }),
  ).toMatchObject({ resetAt: now + 600_000, retryAfterSeconds: 600 })
})

test('refusal caps follow zero, fifteen and max without hiding the true reset', async () => {
  for (const [wait, ttl, expected] of [
    ['0', undefined, undefined],
    ['15', undefined, 900],
    ['max', undefined, 300],
    ['max', 3_600_000, 900],
  ] as const) {
    const timing = quotaRefusalTiming({
      readings: [{ quota: quota(), accountIdentity: 'current' }],
      storage: storage(wait),
      sessionTtlMs: ttl,
      now,
    })
    expect(timing).toMatchObject({ resetAt, retryAfterSeconds: expected })
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
    expect(body.error.message).toContain('The earliest reset is 12:00 UTC')
    if (wait === '0') {
      expect(body.error.type).toBe('FAILED_PRECONDITION')
      expect(body.error.message).not.toMatch(
        /429|500|502|503|504|524|retry|rate.?limit|overloaded|timeout/i,
      )
    } else
      expect(body.error.message).toContain(
        `Retrying every ${expected / 60} minutes.`,
      )
  }
})

test('capped retry text agrees with the header while retaining the actual later reset', async () => {
  const actualReset = now + 3 * 24 * 3_600_000
  const response = createQuotaRefusalResponse(
    'No account can serve this request.',
    {
      resetAt: actualReset,
      retryAfterSeconds: 900,
    },
    now,
  )
  expect(response.headers.get('retry-after')).toBe('900')
  const body = (await response.json()) as { error: { message: string } }
  expect(body.error.message).toContain('Retry in 15m 0s.')
  expect(body.error.message).not.toContain('4320m')
  expect(body.error.message).toContain(
    new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(actualReset),
  )
})

test('scoped refusal includes the matching scope and standard blockers', () => {
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
  ).toBe(resetAt)
})

test('an exhausted weekly window determines usable time despite an earlier five-hour reset', () => {
  const q = quota()
  q.seven_day!.resetsAt = new Date(now + 4 * 24 * 3_600_000).toISOString()
  expect(
    quotaRefusalTiming({
      readings: [{ quota: q, accountIdentity: 'current' }],
      now,
    }),
  ).toMatchObject({
    resetAt: now + 4 * 24 * 3_600_000,
    retryAfterSeconds: 900,
  })
})

test('the earlier usable account wins only after all its blockers reset', () => {
  const slow = quota()
  slow.seven_day!.resetsAt = new Date(now + 4 * 24 * 3_600_000).toISOString()
  const fast = quota(now, 'second')
  fast.five_hour!.resetsAt = new Date(now + 120_000).toISOString()
  fast.seven_day!.resetsAt = new Date(now + 600_000).toISOString()
  expect(
    quotaRefusalTiming({
      readings: [
        { quota: slow, accountIdentity: 'current' },
        { quota: fast, accountIdentity: 'second' },
      ],
      now,
    }),
  ).toMatchObject({ resetAt: now + 600_000, retryAfterSeconds: 600 })
  fast.seven_day!.resetsAt = undefined
  expect(
    quotaRefusalTiming({
      readings: [
        { quota: slow, accountIdentity: 'current' },
        { quota: fast, accountIdentity: 'second' },
      ],
      now,
    }).resetAt,
  ).toBe(now + 4 * 24 * 3_600_000)
})

test('healthy resets do not shorten per-account floors or requested model blockers', () => {
  const q = quota()
  q.five_hour!.remainingPercent = 10
  q.seven_day!.remainingPercent = 90
  q.seven_day!.resetsAt = new Date(now + 60_000).toISOString()
  q.scoped = [
    {
      id: 'fable',
      title: 'Fable',
      modelName: 'Fable',
      remainingPercent: 3,
      usedPercent: 97,
      checkedAt: now,
      resetsAt: new Date(now + 4 * 3_600_000).toISOString(),
    },
  ]
  const policy = storage('15')
  policy.killswitch = {
    enabled: true,
    main: { five_hour: 0, seven_day: 0, scoped: 0 },
    accounts: { work: { five_hour: 20, scoped: 5 } },
  }
  expect(
    quotaRefusalTiming({
      readings: [{ quota: q, accountIdentity: 'current', accountId: 'work' }],
      storage: policy,
      modelId: 'claude-fable-5',
      now,
    }).resetAt,
  ).toBe(now + 4 * 3_600_000)
  expect(
    quotaRefusalTiming({
      readings: [{ quota: q, accountIdentity: 'current', accountId: 'work' }],
      storage: policy,
      modelId: 'claude-opus-5',
      now,
    }).resetAt,
  ).toBe(resetAt)
  expect(
    quotaRefusalTiming({
      readings: [{ quota: q, accountIdentity: 'current', accountId: 'other' }],
      storage: policy,
      modelId: 'claude-opus-5',
      now,
    }).resetAt,
  ).toBeUndefined()
  policy.quota = {
    enabled: true,
    minimumRemaining: { five_hour: 15, seven_day: 0 },
  }
  expect(
    quotaRefusalTiming({
      readings: [{ quota: q, accountIdentity: 'current', accountId: 'other' }],
      storage: policy,
      modelId: 'claude-opus-5',
      now,
    }).resetAt,
  ).toBe(resetAt)
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

test('host retry cap names the limiting window and the real 26-hour reset for a complete pool', async () => {
  const actualReset = now + 26 * 3_600_000
  for (const limit of ['5-hour', 'weekly', 'Fable weekly']) {
    const q = quota()
    q.accountIdentity = 'private-account@example.com'
    q.five_hour!.remainingPercent = 90
    q.seven_day!.remainingPercent = 90
    const blocked =
      limit === '5-hour'
        ? q.five_hour!
        : limit === 'weekly'
          ? q.seven_day!
          : {
              id: 'fable',
              title: 'Fable',
              modelName: 'Fable',
              checkedAt: now,
              usedPercent: 100,
              remainingPercent: 0,
            }
    blocked.remainingPercent = 0
    Object.assign(blocked, { resetsAt: new Date(actualReset).toISOString() })
    if (limit === 'Fable weekly')
      q.scoped = [blocked as NonNullable<OAuthQuotaSnapshot['scoped']>[number]]
    const response = createStickyNoRouteResponse({
      routeQuotas: [q, q],
      routeIdentities: [
        'private-account@example.com',
        'private-account@example.com',
      ],
      storage: storage('max'),
      sessionId: 'long-reset',
      modelId: 'claude-fable-5',
      now,
    })
    expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(900)
    const { error } = (await response.json()) as { error: { message: string } }
    expect(error.message).toContain(`${limit} limit`)
    expect(error.message).toContain('12:00 UTC (in 26 h)')
    expect(error.message).toContain('Retrying every ')
    expect(error.message).not.toContain('private-account@example.com')
  }
  const timing = quotaRefusalTiming({
    readings: [{ quota: quota(), accountIdentity: 'current' }],
    storage: storage('max'),
    sessionTtlMs: 26 * 3_600_000,
    now,
  })
  expect(timing.retryAfterSeconds).toBe(900)
  const defensive = createQuotaRefusalResponse(
    'No route.',
    { resetAt: actualReset, retryAfterSeconds: 93_151, limitName: 'weekly' },
    now,
  )
  expect(defensive.headers.get('retry-after')).toBe('900')
})
