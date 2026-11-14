import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveSettingsOnce, openSettings } from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import {
  createEmptyStorage,
  getKillswitchThresholdsForAccount,
  getQuotaMinimumRemainingThresholds,
  normalizeKillswitchThresholds,
} from '../accounts.ts'
import { settingsDefinition } from '../settings-definition.ts'
import { settingsProtectionStricter } from '../settings-host-import.ts'
import { mapSettingsMoveSources } from '../settings-move-map.ts'
import { createSettingsMoveSource } from '../settings-move-source.ts'
import type { SettingsHost } from '../settings-paths.ts'
import { legacySettingsProtection } from '../settings-protection-legacy.ts'
import { resolveSettingsRecord } from '../settings-record.ts'
import {
  openSettingsService,
  SETTINGS_PROTECTION_KEYS,
} from '../settings-service.ts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function move(
  stores: { host: SettingsHost; settings: Record<string, unknown> }[],
) {
  const root = await mkdtemp(join(tmpdir(), 'settings-move-map-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.jsonc')
  const messages: string[] = []
  const sources = await Promise.all(
    stores.map(async ({ host, settings }, index) => {
      const path = join(root, `${index}-${host}.json`)
      await writeFile(path, JSON.stringify(settings))
      return createSettingsMoveSource({
        path,
        host,
        locks: [],
        log: { warn: (message) => messages.push(message) },
      })
    }),
  )
  const result = await moveSettingsOnce({
    definition: settingsDefinition,
    target: file,
    separateInstall: false,
    sources,
    map: mapSettingsMoveSources,
    fence: () => true,
    log: { info: () => {}, warn: () => {} },
  })
  return { file, sources, result, messages }
}

async function resolve(file: string) {
  const service = await openSettingsService({
    file,
    dependencies: {
      open: (options) => ({
        ...openSettings(settingsDefinition, options),
        watch: () => () => {},
      }),
    },
  })
  if (!service) throw new Error('Expected a user-file settings service')
  cleanup.push(() => service.dispose())
  return {
    service,
    record: (host: SettingsHost) =>
      resolveSettingsRecord(createEmptyStorage(), service.snapshot(), host),
  }
}

test('two vault stores preserve every host floor and coalesce only identical completed vault entries', async () => {
  const opencode = {
    killswitch: {
      main: { five_hour: 40, seven_day: 12, scoped: 3 },
      accounts: {
        'vault:A': { five_hour: 11, seven_day: 22, scoped: 1 },
        'vault:B': { five_hour: 13, seven_day: 24, scoped: 2 },
        'vault:D': { '5h': 15, '1w': 26 },
      },
    },
    quota: { minimumRemaining: { five_hour: 31, seven_day: 7, scoped: 5 } },
  }
  const pi = {
    killswitch: {
      main: { five_hour: 6, seven_day: 42, scoped: 8 },
      accounts: {
        'vault:A': { five_hour: 21, seven_day: 12, scoped: 4 },
        'vault:C': { five_hour: 23, seven_day: 14, scoped: 6 },
        'vault:D': { five_hour: 15, seven_day: 26, scoped: 0 },
      },
    },
    quota: { minimumRemaining: { five_hour: 9, seven_day: 17, scoped: 2 } },
  }
  const f = await move([
    { host: 'opencode', settings: opencode },
    { host: 'pi', settings: pi },
  ])
  expect(f.result.outcome).toBe('moved')
  expect(parse(await readFile(f.file, 'utf8'))).toEqual({
    schema_version: 1,
    killswitch_default_five_hour: { default: 40, pi: 6 },
    killswitch_default_seven_day: { default: 12, pi: 42 },
    killswitch_default_scoped: { default: 3, pi: 8 },
    quota_minimum_remaining_five_hour: { default: 31, pi: 9 },
    quota_minimum_remaining_seven_day: { default: 7, pi: 17 },
    quota_minimum_remaining_scoped: { default: 5, pi: 2 },
    killswitch_account_floors: [
      {
        account: 'vault:A',
        host: 'opencode',
        five_hour: 11,
        seven_day: 22,
        scoped: 1,
      },
      {
        account: 'vault:B',
        host: 'opencode',
        five_hour: 13,
        seven_day: 24,
        scoped: 2,
      },
      {
        account: 'vault:D',
        host: 'both',
        five_hour: 15,
        seven_day: 26,
        scoped: 0,
      },
      {
        account: 'vault:A',
        host: 'pi',
        five_hour: 21,
        seven_day: 12,
        scoped: 4,
      },
      {
        account: 'vault:C',
        host: 'pi',
        five_hour: 23,
        seven_day: 14,
        scoped: 6,
      },
    ],
  })
  const resolved = await resolve(f.file)
  for (const [host, legacy] of [
    ['opencode', opencode],
    ['pi', pi],
  ] as const) {
    const before = Object.assign(createEmptyStorage(), legacy)
    const after = resolved.record(host)
    for (const account of [
      undefined,
      'vault:A',
      'vault:B',
      'vault:C',
      'vault:D',
      'vault:missing',
    ])
      expect(getKillswitchThresholdsForAccount(after, account)).toEqual(
        getKillswitchThresholdsForAccount(before, account),
      )
    expect(getQuotaMinimumRemainingThresholds(after)).toEqual(
      getQuotaMinimumRemainingThresholds(before),
    )
    expect(
      normalizeKillswitchThresholds(after.quota?.minimumRemaining),
    ).toEqual(normalizeKillswitchThresholds(before.quota.minimumRemaining))
    expect(resolved.service.snapshot().protection[host].rung).toBe(0)
    expect(resolved.service.snapshot().report).toEqual([])
  }
  expect(f.result.differing).toEqual([])
  for (const [index, source] of f.sources.entries())
    expect(await readFile(source.path, 'utf8')).toBe(
      JSON.stringify([opencode, pi][index]),
    )
})

test('threshold groups are completed before individual scalar keys are compared', async () => {
  const f = await move([
    {
      host: 'opencode',
      settings: {
        killswitch: { main: { five_hour: 19 } },
        quota: { minimumRemaining: { seven_day: 27 } },
      },
    },
    {
      host: 'pi',
      settings: {
        killswitch: { main: { seven_day: 29 } },
        quota: { minimumRemaining: { five_hour: 37 } },
      },
    },
  ])
  expect(f.result.outcome).toBe('moved')
  expect(parse(await readFile(f.file, 'utf8'))).toEqual({
    schema_version: 1,
    killswitch_default_five_hour: { default: 19, pi: 5 },
    killswitch_default_seven_day: { default: 10, pi: 29 },
    killswitch_default_scoped: 0,
    quota_minimum_remaining_five_hour: { default: 0, pi: 37 },
    quota_minimum_remaining_seven_day: { default: 27, pi: 0 },
    quota_minimum_remaining_scoped: 0,
  })
})

test('one-host values are inherited and disagreeing lists remain whole per schema key', async () => {
  const f = await move([
    {
      host: 'opencode',
      settings: {
        dump: { enabled: true },
        fallbackOn: [503, 429],
        turnEndNote: { tools: ['same'] },
        cacheKeep: { startHour: 0, endHour: 12 },
      },
    },
    {
      host: 'pi',
      settings: {
        prime: { enabled: true },
        fallbackOn: [429, 503],
        turnEndNote: { tools: ['same'] },
        cacheKeep: { startHour: 6, endHour: 20 },
      },
    },
  ])
  expect(f.result.outcome).toBe('moved')
  expect(parse(await readFile(f.file, 'utf8'))).toEqual({
    schema_version: 1,
    dump_enabled: true,
    prime_enabled: true,
    fallback_on: { default: [503, 429], pi: [429, 503] },
    turn_end_note_tools: ['same'],
    cache_keep_window: {
      default: [{ start_hour: 0, end_hour: 12 }],
      pi: [{ start_hour: 6, end_hour: 20 }],
    },
  })
  const { service } = await resolve(f.file)
  for (const host of ['opencode', 'pi'] as const)
    expect(service.resolve(host)).toMatchObject({
      dump_enabled: true,
      prime_enabled: true,
    })
})

test('local ids stay host-tagged even with identical floors and coexist with both modes vault entries', async () => {
  const f = await move([
    {
      host: 'opencode',
      settings: {
        killswitch: { accounts: { shared: {}, 'vault:own': { scoped: 3 } } },
      },
    },
    {
      host: 'pi',
      settings: {
        killswitch: { accounts: { shared: {}, 'vault:peer': { scoped: 4 } } },
      },
    },
  ])
  expect(f.result.outcome).toBe('moved')
  expect(
    parse(await readFile(f.file, 'utf8')).killswitch_account_floors,
  ).toEqual([
    {
      account: 'shared',
      host: 'opencode',
      five_hour: 5,
      seven_day: 10,
      scoped: 0,
    },
    {
      account: 'vault:own',
      host: 'opencode',
      five_hour: 5,
      seven_day: 10,
      scoped: 3,
    },
    { account: 'shared', host: 'pi', five_hour: 5, seven_day: 10, scoped: 0 },
    {
      account: 'vault:peer',
      host: 'pi',
      five_hour: 5,
      seven_day: 10,
      scoped: 4,
    },
  ])
  const { service } = await resolve(f.file)
  expect(service.snapshot().report).toEqual([])
  for (const host of ['opencode', 'pi'] as const)
    expect(service.snapshot().protection[host].rung).toBe(0)
})

for (const invalidHost of ['opencode', 'pi'] as const) {
  test(`${invalidHost} invalid scalar protection replacements remain explicit beside the peer valid values`, async () => {
    const f = await move(
      (['opencode', 'pi'] as const).map((host) => ({
        host,
        settings:
          host === invalidHost
            ? {
                killswitch: { enabled: null },
                quota: {
                  minimumRemaining: { five_hour: 101 },
                  failClosedOnUnknownQuota: 'bad',
                },
              }
            : {
                killswitch: { enabled: false },
                quota: {
                  minimumRemaining: { five_hour: 17 },
                  failClosedOnUnknownQuota: false,
                },
              },
      })),
    )
    expect(f.result.outcome).toBe('moved')
    const document = parse(await readFile(f.file, 'utf8'))
    expect(document.quota_minimum_remaining_five_hour).toEqual(
      invalidHost === 'opencode'
        ? { default: 0, pi: 17 }
        : { default: 17, pi: 0 },
    )
    expect(document.killswitch_enabled).toEqual(
      invalidHost === 'opencode'
        ? { default: true, pi: false }
        : { default: false, pi: true },
    )
    expect(document.quota_fail_closed_on_unknown_quota).toEqual(
      invalidHost === 'opencode'
        ? { default: 'on', pi: 'off' }
        : { default: 'off', pi: 'on' },
    )
    const { service } = await resolve(f.file)
    for (const host of ['opencode', 'pi'] as const) {
      expect(service.resolve(host)).toMatchObject({
        killswitch_enabled: host === invalidHost,
        quota_minimum_remaining_five_hour: host === invalidHost ? 0 : 17,
        quota_fail_closed_on_unknown_quota: host === invalidHost ? 'on' : 'off',
      })
      expect(service.snapshot().protection[host].rung).toBe(0)
    }
    expect(f.messages).toHaveLength(3)
  })

  test(`${invalidHost} invalid vault floors use the higher per-key replacement without changing valid entries or the peer`, async () => {
    const f = await move(
      (['opencode', 'pi'] as const).map((host) => ({
        host,
        settings: {
          killswitch: {
            main: { five_hour: 40, seven_day: 3, scoped: 12 },
            accounts: {
              'vault:A':
                host === invalidHost
                  ? { five_hour: 101, seven_day: 18 }
                  : { five_hour: 8, seven_day: 20, scoped: 2 },
              'vault:valid': { five_hour: 7, seven_day: 18 },
            },
          },
        },
      })),
    )
    expect(f.result.outcome).toBe('moved')
    const document = parse(await readFile(f.file, 'utf8'))
    const entries = document.killswitch_account_floors
    expect(
      entries.filter(
        (entry: { account: string }) => entry.account === 'vault:A',
      ),
    ).toEqual(
      (['opencode', 'pi'] as const).map((host) => ({
        account: 'vault:A',
        host,
        ...(host === invalidHost
          ? { five_hour: 40, seven_day: 10, scoped: 12 }
          : { five_hour: 8, seven_day: 20, scoped: 2 }),
      })),
    )
    expect(entries).toHaveLength(3)
    expect(entries).toContainEqual({
      account: 'vault:valid',
      host: 'both',
      five_hour: 7,
      seven_day: 18,
      scoped: 0,
    })
    const resolved = await resolve(f.file)
    for (const host of ['opencode', 'pi'] as const) {
      const after = resolved.record(host)
      expect(getKillswitchThresholdsForAccount(after, 'vault:A')).toEqual(
        host === invalidHost
          ? { five_hour: 40, seven_day: 10, scoped: 12 }
          : { five_hour: 8, seven_day: 20, scoped: 2 },
      )
      expect(getKillswitchThresholdsForAccount(after, 'vault:valid')).toEqual({
        five_hour: 7,
        seven_day: 18,
        scoped: 0,
      })
      expect(resolved.service.snapshot().protection[host].rung).toBe(0)
    }
    expect(f.messages).toHaveLength(1)
  })
}

// A host that stores no value for a protection key used its legacy reader's
// implicit default. The other host's weaker explicit value must not become
// that host's value through inheritance.
const implicitCases = [
  {
    name: 'killswitch on with no stored floors (5/10) beside floors 1/1',
    implicit: { killswitch: { enabled: true } },
    explicit: {
      killswitch: { enabled: true, main: { five_hour: 1, seven_day: 1 } },
    },
    keeps: {
      killswitch_enabled: true,
      killswitch_default_five_hour: 5,
      killswitch_default_seven_day: 10,
      killswitch_default_scoped: 0,
    },
    weaker: {
      killswitch_enabled: true,
      killswitch_default_five_hour: 1,
      killswitch_default_seven_day: 1,
      killswitch_default_scoped: 0,
    },
  },
  {
    name: "an unset same-account wait beside maxSameAccountWait 'max'",
    implicit: { dump: { enabled: true } },
    explicit: { routing: { maxSameAccountWait: 'max' } },
    keeps: { max_same_account_wait: '15m' },
    weaker: { max_same_account_wait: 'cache' },
  },
  {
    name: 'an unset unknown-quota policy beside failClosedOnUnknownQuota false',
    implicit: { dump: { enabled: true } },
    explicit: { quota: { failClosedOnUnknownQuota: false } },
    keeps: { quota_fail_closed_on_unknown_quota: 'default' },
    weaker: { quota_fail_closed_on_unknown_quota: 'off' },
  },
] as const

for (const scenario of implicitCases) {
  for (const explicitHost of ['opencode', 'pi'] as const) {
    test(`${scenario.name} stored by ${explicitHost}: each host keeps its own effective protection`, async () => {
      const implicitHost = explicitHost === 'opencode' ? 'pi' : 'opencode'
      const settings = {
        [explicitHost]: scenario.explicit,
        [implicitHost]: scenario.implicit,
      }
      const f = await move(
        (['opencode', 'pi'] as const).map((host) => ({
          host,
          settings: settings[host] as Record<string, unknown>,
        })),
      )
      expect(f.result.outcome).toBe('moved')
      const { service } = await resolve(f.file)
      expect(service.resolve(implicitHost)).toMatchObject(scenario.keeps)
      expect(service.resolve(explicitHost)).toMatchObject(scenario.weaker)
      // Every protection value of each host is at least what its own legacy
      // reader gave it before the move.
      for (const host of ['opencode', 'pi'] as const) {
        const legacy = legacySettingsProtection(
          settings[host] as Record<string, unknown>,
          host,
        )
        const resolved = service.resolve(host)
        for (const key of SETTINGS_PROTECTION_KEYS) {
          if (key === 'killswitch_account_floors') continue
          expect({
            key,
            weaker: settingsProtectionStricter(key, legacy[key], resolved[key]),
          }).toEqual({ key, weaker: false })
        }
      }
    })
  }
}

// A host whose killswitch was off held no account back, so its implicit
// floors 5/10 are no protection: carrying them would leave it on at 5/10,
// stricter than both sources.
for (const offHost of ['opencode', 'pi'] as const) {
  test(`a killswitch that was off on ${offHost} carries no implicit floors: both hosts end on at the other host's 1/1`, async () => {
    const onHost = offHost === 'opencode' ? 'pi' : 'opencode'
    const settings = {
      [onHost]: {
        killswitch: { enabled: true, main: { five_hour: 1, seven_day: 1 } },
      },
      [offHost]: { dump: { enabled: true } },
    }
    const f = await move(
      (['opencode', 'pi'] as const).map((host) => ({
        host,
        settings: settings[host] as Record<string, unknown>,
      })),
    )
    expect(f.result.outcome).toBe('moved')
    const { service } = await resolve(f.file)
    for (const host of ['opencode', 'pi'] as const)
      expect(service.resolve(host)).toMatchObject({
        killswitch_enabled: true,
        killswitch_default_five_hour: 1,
        killswitch_default_seven_day: 1,
      })
  })
}

// Floors a host stored while its killswitch was off held no account back.
// Once the other host's killswitch is on, the off host inherits that `on`, so
// its stored floors and account rows would become live protection; they are
// not carried. When every source is off they stay as stored (see the vault
// floor tests above).
for (const enabled of ['omitted', 'false'] as const) {
  test(`floors OpenCode stored with its killswitch ${enabled === 'omitted' ? 'unset' : 'off'} are not carried beside Pi's enabled killswitch`, async () => {
    const settings = {
      opencode: {
        killswitch: {
          ...(enabled === 'false' ? { enabled: false } : {}),
          main: { five_hour: 1, seven_day: 1 },
          accounts: { 'vault:A': { five_hour: 50, seven_day: 50 } },
        },
      },
      // Pi's killswitch is on at its implicit floors 5/10.
      pi: { killswitch: { enabled: true } },
    }
    const f = await move(
      (['opencode', 'pi'] as const).map((host) => ({
        host,
        settings: settings[host],
      })),
    )
    expect(f.result.outcome).toBe('moved')
    const document = parse(await readFile(f.file, 'utf8'))
    expect(document.killswitch_account_floors).toBeUndefined()
    const resolved = await resolve(f.file)
    const floors = {
      killswitch_default_five_hour: 5,
      killswitch_default_seven_day: 10,
    }
    expect(resolved.service.resolve('pi')).toMatchObject({
      killswitch_enabled: true,
      ...floors,
    })
    // OpenCode is on only if it inherits Pi's value, and then at Pi's floors,
    // never at the 1/1 it stored while off.
    expect(resolved.service.resolve('opencode')).toMatchObject({
      killswitch_enabled: enabled === 'omitted',
      ...floors,
    })
    for (const host of ['opencode', 'pi'] as const)
      expect(
        getKillswitchThresholdsForAccount(resolved.record(host), 'vault:A'),
      ).toEqual({ five_hour: 5, seven_day: 10, scoped: 0 })
  })
}

test('absent sources and absent account settings do not seed a list, while an explicit empty list is carried', () => {
  expect(
    mapSettingsMoveSources([
      { host: 'opencode', path: 'missing', present: false },
      { host: 'pi', path: 'empty', present: true, value: {} },
    ]),
  ).toEqual({ entries: [], unmapped: [] })
  expect(
    mapSettingsMoveSources([
      {
        host: 'pi',
        path: 'empty-accounts',
        present: true,
        value: { killswitch_account_floors: [] },
      },
    ]),
  ).toEqual({
    entries: [{ source: 0, setting: 'killswitch_account_floors', value: [] }],
    unmapped: [],
  })
})

test('a reversed host pair fails the move before publishing a Pi default or any notes', async () => {
  const f = await move([
    { host: 'pi', settings: { dump: { enabled: true } } },
    { host: 'opencode', settings: { dump: { enabled: false } } },
  ])
  expect(f.result.outcome).toBe('failed')
  expect(String(f.result.cause)).toContain(
    'Settings move sources must put OpenCode before Pi',
  )
  expect(await stat(f.file).catch(() => undefined)).toBeUndefined()
  for (const source of f.sources)
    expect(
      await stat(`${source.path}.MOVED_READPLEASE`).catch(() => undefined),
    ).toBeUndefined()
})

test('unsupported or duplicate source hosts are refused instead of creating account overlaps', () => {
  const source = {
    host: 'pi',
    path: 'legacy',
    present: true as const,
    value: {},
  }
  expect(() => mapSettingsMoveSources([source, source])).toThrow(
    'Duplicate settings move host: pi',
  )
  expect(() =>
    mapSettingsMoveSources([{ ...source, host: 'unknown' }]),
  ).toThrow('Unknown settings move host: unknown')
})
