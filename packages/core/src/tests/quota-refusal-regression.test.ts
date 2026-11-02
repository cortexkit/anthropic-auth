import { expect, test } from 'bun:test'
import { killswitchRetryAfterSeconds } from '../accounts.ts'

test('unidentified stale resets cannot park a terminal refusal for days', () => {
  const now = Date.parse('2026-11-02T10:00:00Z')
  expect(
    killswitchRetryAfterSeconds(
      {
        five_hour: {
          remainingPercent: 0,
          usedPercent: 100,
          checkedAt: now - 3_600_000,
          resetsAt: new Date(now + 3 * 24 * 3_600_000).toISOString(),
        },
        seven_day: {
          remainingPercent: 0,
          usedPercent: 100,
          checkedAt: now - 3_600_000,
          resetsAt: new Date(now + 5 * 24 * 3_600_000).toISOString(),
        },
      },
      [],
      now,
    ),
  ).toBe(300)
})
