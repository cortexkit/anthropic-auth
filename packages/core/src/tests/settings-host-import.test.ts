import { expect, test } from 'bun:test'

import { planSettingsHostImport } from '../settings-host-import.ts'
import { legacySettingsProtection } from '../settings-protection-legacy.ts'
import type { SettingsProtectionValues } from '../settings-service.ts'

const base = legacySettingsProtection({}, 'pi')
const floor = (
  account: string,
  host: 'opencode' | 'pi',
  five_hour: number,
) => ({
  account,
  host,
  five_hour,
  seven_day: base.killswitch_default_seven_day,
  scoped: base.killswitch_default_scoped,
})

test('only keys where the legacy store protects more, and the file sets no value for the host, are imported at its level', () => {
  const legacy: SettingsProtectionValues = {
    ...base,
    killswitch_enabled: true,
    killswitch_default_five_hour: 40,
    quota_minimum_remaining_seven_day: 30,
    quota_fail_closed_on_unknown_quota: 'on',
    max_same_account_wait: 'off',
  }
  const resolved: SettingsProtectionValues = {
    ...base,
    killswitch_enabled: false,
    killswitch_default_five_hour: 10,
    quota_minimum_remaining_seven_day: 50,
    quota_fail_closed_on_unknown_quota: 'off',
    max_same_account_wait: 'cache',
  }
  const plan = planSettingsHostImport({
    host: 'pi',
    legacy,
    resolved,
    // The user set Pi's own five-hour threshold in the file: it is kept.
    fileLevels: { killswitch_default_five_hour: ['default', 'pi'] },
  })
  expect(plan.keys).toEqual([
    'max_same_account_wait',
    'quota_fail_closed_on_unknown_quota',
    'killswitch_enabled',
  ])
  expect(plan.edits).toEqual([
    { setting: 'max_same_account_wait', level: 'pi', value: 'off' },
    { setting: 'quota_fail_closed_on_unknown_quota', level: 'pi', value: 'on' },
    { setting: 'killswitch_enabled', level: 'pi', value: true },
  ])
})

test('a legacy account floor is imported only for an account the file gives the host no floor for', () => {
  const resolved: SettingsProtectionValues = {
    ...base,
    killswitch_account_floors: [
      floor('covered', 'pi', 1),
      floor('other', 'opencode', 1),
    ],
  }
  const plan = planSettingsHostImport({
    host: 'pi',
    legacy: {
      ...base,
      killswitch_account_floors: [
        floor('covered', 'pi', 90),
        floor('other', 'pi', 90),
        floor('loose', 'pi', base.killswitch_default_five_hour),
      ],
    },
    resolved,
    fileLevels: {},
  })
  expect(plan.keys).toEqual(['killswitch_account_floors'])
  expect(plan.edits).toEqual([
    {
      setting: 'killswitch_account_floors',
      value: [...resolved.killswitch_account_floors, floor('other', 'pi', 90)],
    },
  ])
})

test('a legacy set that protects no more than the file needs no import', () => {
  expect(
    planSettingsHostImport({
      host: 'opencode',
      legacy: legacySettingsProtection({}, 'opencode'),
      resolved: legacySettingsProtection({}, 'opencode'),
      fileLevels: {},
    }),
  ).toEqual({ keys: [], edits: [] })
})
