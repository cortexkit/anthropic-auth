import { expect, test } from 'bun:test'
import { SessionCacheActivity } from '../session-cache-activity.ts'
import { decideStickyQuotaFailure } from '../sticky-routing.ts'

test('cache activity is bounded by the last accepted response, account and wait setting', () => {
  const activity = new SessionCacheActivity()
  activity.record('session', 'account', 3_600_000, 1000)
  expect(activity.holdUntil('session', 'account', 2000, 'max')).toBe(3_601_000)
  expect(activity.holdUntil('session', 'account', 2000)).toBe(902_000)
  expect(activity.holdUntil('session', 'account', 2000, '0')).toBe(2000)
  expect(activity.holdUntil('session', 'other', 2000)).toBeUndefined()
  expect(activity.holdUntil('missing', 'account', 2000)).toBeUndefined()
  // Looking up a bound does not warm the cache or extend its lifetime.
  expect(activity.holdUntil('session', 'account', 3_602_000)).toBe(3_601_000)
  activity.forget('session')
  expect(activity.holdUntil('session', 'account')).toBeUndefined()
})

test('evicts the least recently accepted session and refreshes existing entries', () => {
  const activity = new SessionCacheActivity(2)
  activity.record('first', 'account', 300_000, 1000)
  activity.record('second', 'account', 300_000, 2000)
  activity.record('first', 'new-account', 3_600_000, 3000)
  activity.record('third', 'account', 300_000, 4000)
  expect(activity.holdUntil('first', 'new-account', 5000, 'max')).toBe(
    3_603_000,
  )
  expect(activity.holdUntil('second', 'account', 5000)).toBeUndefined()
  expect(activity.holdUntil('third', 'account', 5000)).toBe(304_000)
})

test('unknown TTL uses the five-minute default', () => {
  const activity = new SessionCacheActivity()
  activity.record('session', 'account', undefined, 1000)
  expect(activity.holdUntil('session', 'account', 2000, 'max')).toBe(301_000)
})

test('a successful prewarm ten minutes ago protects a turn accepted seventy minutes ago', () => {
  const now = Date.parse('2026-11-02T10:00:00Z')
  const activity = new SessionCacheActivity()
  activity.record('warm-session', 'account', 3_600_000, now - 70 * 60_000)
  activity.recordPrewarm('warm-session', 'account', now - 10 * 60_000)
  expect(
    decideStickyQuotaFailure({
      quota: {
        five_hour: {
          remainingPercent: 0,
          usedPercent: 100,
          checkedAt: now,
          resetsAt: new Date(now + 10 * 60_000).toISOString(),
        },
      },
      sessionId: 'warm-session',
      now,
      holdUntil: activity.holdUntil('warm-session', 'account', now),
    }).action,
  ).toBe('hold')
})

test('a restored prewarm can establish activity but cannot replace a different-account turn', () => {
  const activity = new SessionCacheActivity()
  activity.recordPrewarm('restored', 'account', 1000)
  expect(activity.holdUntil('restored', 'account', 2000, 'max')).toBe(3_601_000)
  activity.record('restored', 'new-account', 300_000, 3000)
  activity.recordPrewarm('restored', 'account', 4000)
  expect(activity.holdUntil('restored', 'account', 5000, 'max')).toBeUndefined()
  expect(activity.holdUntil('restored', 'new-account', 5000, 'max')).toBe(
    303_000,
  )
})
