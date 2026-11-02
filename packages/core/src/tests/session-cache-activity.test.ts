import { expect, test } from 'bun:test'
import { SessionCacheActivity } from '../session-cache-activity.ts'

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
