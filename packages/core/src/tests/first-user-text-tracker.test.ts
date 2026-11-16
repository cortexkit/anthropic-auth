import { expect, test } from 'bun:test'
import { ClaudeCodeFirstUserTextTracker } from '../cch.ts'

test('a read-only first-user text peek neither pins a session nor refreshes its LRU position', () => {
  const tracker = new ClaudeCodeFirstUserTextTracker(2)
  expect(tracker.peek('missing')).toBeUndefined()
  expect(tracker.has('missing')).toBe(false)
  tracker.resolve('head', [{ role: 'user', content: 'Head first question' }])
  tracker.resolve('other', [{ role: 'user', content: 'Other first question' }])
  expect(tracker.peek('head')).toBe('Head first question')
  tracker.resolve('new', [{ role: 'user', content: 'New first question' }])
  expect(tracker.has('head')).toBe(false)
  expect(tracker.has('other')).toBe(true)
})
