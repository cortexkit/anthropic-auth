import { expect, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import { nativeAccountSettings } from '../native-account-view.ts'
import { validateNativeMigrationSettings } from '../native-migration-source.ts'
import { getMaxSameAccountWait } from '../routing.ts'

test('same-account wait defaults to fifteen minutes and survives the policy settings projection', () => {
  expect(getMaxSameAccountWait(null)).toBe('15')
  for (const maxSameAccountWait of ['0', '15', 'max'] as const) {
    const settings = {
      routing: { mode: 'sticky-balanced', maxSameAccountWait },
    }
    validateNativeMigrationSettings(settings)
    const projected = nativeAccountSettings(settings)
    expect(projected.routing).toEqual(settings.routing)
    expect(getMaxSameAccountWait(projected as AccountStorage)).toBe(
      maxSameAccountWait,
    )
  }
  expect(
    getMaxSameAccountWait({
      routing: { maxSameAccountWait: 'invalid' },
    } as unknown as AccountStorage),
  ).toBe('15')
})
