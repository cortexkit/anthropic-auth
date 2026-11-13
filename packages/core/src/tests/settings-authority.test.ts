import { expect, test } from 'bun:test'
import {
  differingLegacySettings,
  holdsMovedSettings,
} from '../settings-authority.ts'
import { settingsDefinition } from '../settings-definition.ts'
import type { SettingsValues } from '../settings-service.ts'

const defaults = Object.fromEntries(
  Object.entries(settingsDefinition.settings).map(([key, value]) => [
    key,
    value.default,
  ]),
) as unknown as SettingsValues

test('not-imported diagnostics require an explicitly held moved field, including alias floors and window hours', () => {
  for (const stored of [
    {},
    { accounts: [] },
    { nativeAccountOrder: ['a'] },
    { relay: { enabled: true } },
  ])
    expect(holdsMovedSettings(stored)).toBe(false)
  for (const stored of [
    { dump: { enabled: false } },
    { killswitch: { main: { '5h': 20 } } },
    { cacheKeep: { startHour: 10 } },
    { quota: { minimumRemaining: { scoped: 2 } } },
  ])
    expect(holdsMovedSettings(stored)).toBe(true)
})

test('later starts compare only explicit keys against no-model values', () => {
  expect(differingLegacySettings({}, defaults, 'pi')).toEqual([])
  expect(
    differingLegacySettings({ dump_enabled: false }, defaults, 'opencode'),
  ).toEqual([])
  expect(
    differingLegacySettings(
      { dump_enabled: true, prime_enabled: false },
      defaults,
      'pi',
    ),
  ).toEqual(['dump_enabled'])
})

test('account-floor comparisons ignore list order, the peer host and both-versus-own tagging', () => {
  const a = {
    account: 'vault:a',
    host: 'opencode' as const,
    five_hour: 10,
    seven_day: 20,
    scoped: 0,
  }
  const b = { ...a, account: 'b' }
  const resolved = {
    ...defaults,
    killswitch_account_floors: [
      { ...b, account: 'peer', host: 'pi' as const, five_hour: 80 },
      { ...b, host: 'both' as const },
      { ...a, host: 'both' as const },
    ],
  }
  expect(
    differingLegacySettings(
      { killswitch_account_floors: [a] },
      resolved,
      'opencode',
    ),
  ).toEqual([])
  expect(
    differingLegacySettings(
      { killswitch_account_floors: [b, a] },
      resolved,
      'opencode',
    ),
  ).toEqual([])
  expect(
    differingLegacySettings(
      { killswitch_account_floors: [{ ...a, five_hour: 30 }] },
      resolved,
      'opencode',
    ),
  ).toEqual(['killswitch_account_floors'])
})
