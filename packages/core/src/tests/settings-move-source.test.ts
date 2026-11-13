import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveSettingsOnce } from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import {
  createEmptyStorage,
  getQuotaMinimumRemainingThresholds,
} from '../accounts.ts'
import { settingsDefinition } from '../settings-definition.ts'
import { mapSettingsMoveSources } from '../settings-move-map.ts'
import {
  createSettingsMoveSource,
  readSettingsMoveSource,
  SETTINGS_MOVE_PATHS,
} from '../settings-move-source.ts'
import type { SettingsHost } from '../settings-paths.ts'

let sourceId = 0
const folders: string[] = []
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  )
})

function source(host: SettingsHost = 'opencode') {
  const messages: string[] = []
  const options = {
    host,
    path: `legacy-source-${sourceId++}.json`,
    log: {
      warn: (message: string) => {
        messages.push(message)
      },
    },
    locks: [],
  }
  return { messages, options, read: createSettingsMoveSource(options).read }
}

test('the closed move map names every schema key and only explicitly held user settings move', () => {
  expect(Object.keys(SETTINGS_MOVE_PATHS).sort()).toEqual(
    Object.keys(settingsDefinition.settings).sort(),
  )
  const fixture = {
    routing: { mode: 'fallback-first', maxSameAccountWait: 'max' },
    fallbackOn: [418, 503],
    refresh: {
      enabled: false,
      intervalMinutes: 3,
      refreshBeforeExpiryMinutes: 99,
    },
    quota: {
      enabled: false,
      checkIntervalMinutes: 7,
      refreshEveryNRequests: 8,
      minimumRemaining: { five_hour: 17, seven_day: 19, scoped: 4 },
      failClosedOnUnknownQuota: true,
      showToasts: true,
    },
    quotaHeaderFeed: { enabled: true },
    killswitch: {
      enabled: true,
      main: { five_hour: 9, seven_day: 21, scoped: 3 },
      accounts: { 'local-row-42': { five_hour: 7, seven_day: 18, scoped: 2 } },
    },
    claudeCache: { enabled: true, mode: 'automatic' },
    cacheKeep: {
      enabled: true,
      always: true,
      startHour: 5,
      endHour: 9,
      subagents: true,
    },
    dump: { enabled: true },
    prime: { enabled: true },
    claudeFast: { enabled: true },
    costZeroing: { enabled: false },
    logging: { level: 'debug' },
    thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
    turnEndNote: { tools: ['custom'] },
    relay: {
      enabled: true,
      url: 'https://example.test',
      transport: 'http',
      token: 'private',
      generation: 9,
    },
    sidebar: { enabled: true },
    mainAccountId: 'local-row-42',
    nativeAccountOrder: ['local-row-42'],
    accounts: [
      {
        id: 'local-row-42',
        email: 'private@example.test',
        accountIdentity: 'identity',
      },
    ],
    claustrum: { enabled: true },
    quotaReadings: {},
    primeCount: 4,
  }
  const reader = source()
  expect(reader.read(JSON.stringify(fixture))).toEqual({
    routing_mode: 'fallback-first',
    max_same_account_wait: 'cache',
    fallback_on: [418, 503],
    refresh_enabled: false,
    refresh_interval_minutes: 3,
    refresh_refresh_before_expiry_minutes: 99,
    quota_enabled: 'off',
    quota_check_interval_minutes: 7,
    quota_refresh_every_n_requests: 8,
    quota_minimum_remaining_five_hour: 17,
    quota_minimum_remaining_seven_day: 19,
    quota_minimum_remaining_scoped: 4,
    quota_fail_closed_on_unknown_quota: 'on',
    quota_show_toasts: true,
    quota_header_feed_enabled: true,
    killswitch_enabled: true,
    killswitch_default_five_hour: 9,
    killswitch_default_seven_day: 21,
    killswitch_default_scoped: 3,
    killswitch_account_floors: [
      {
        account: 'local-row-42',
        host: 'opencode',
        five_hour: 7,
        seven_day: 18,
        scoped: 2,
      },
    ],
    claude_cache_enabled: 'on',
    claude_cache_mode: 'automatic',
    cache_keep_enabled: true,
    cache_keep_always: true,
    cache_keep_window: [{ start_hour: 5, end_hour: 9 }],
    cache_keep_subagents: true,
    dump_enabled: true,
    prime_enabled: true,
    claude_fast_enabled: true,
    cost_zeroing_enabled: false,
    log_level: 'debug',
    thinking_binding_prefix_mismatch_behavior: 'drop_block',
    turn_end_note_tools: ['custom'],
  })
  expect(reader.messages).toEqual([])
})

test('empty sections and store-held fields never seed defaults', () => {
  const reader = source()
  expect(
    reader.read(
      JSON.stringify({
        version: 1,
        routing: {},
        quota: {},
        killswitch: {},
        claudeCache: {},
        cacheKeep: {},
        refresh: {},
        logging: {},
        turnEndNote: {},
        relay: { enabled: true },
        mainAccountId: 'A',
        nativeAccountOrder: ['A'],
        accounts: [],
        claustrum: {},
      }),
    ),
  ).toEqual({})
  expect(reader.messages).toEqual([])
})

for (const [legacy, expected] of [
  ['0', 'off'],
  [0, 'off'],
  ['15', '15m'],
  [15, '15m'],
  ['max', 'cache'],
] as const) {
  test(`same-account wait ${legacy} (${typeof legacy}) becomes ${expected}`, () => {
    expect(
      source().read(
        JSON.stringify({ routing: { maxSameAccountWait: legacy } }),
      ),
    ).toEqual({ max_same_account_wait: expected })
  })
}

for (const enabled of [true, false]) {
  test(`all three-way booleans translate stored ${enabled} without seeding absent booleans`, () => {
    expect(
      source().read(
        JSON.stringify({
          claudeCache: { enabled },
          quota: { enabled, failClosedOnUnknownQuota: enabled },
        }),
      ),
    ).toEqual({
      claude_cache_enabled: enabled ? 'on' : 'off',
      quota_enabled: enabled ? 'on' : 'off',
      quota_fail_closed_on_unknown_quota: enabled ? 'on' : 'off',
    })
  })
}

test('partial threshold groups write all declared scalar defaults and preserve quota reader outputs', () => {
  const legacy = createEmptyStorage()
  legacy.quota = { minimumRemaining: { five_hour: 31 } }
  const moved = readSettingsMoveSource(
    JSON.stringify({ ...legacy, killswitch: { main: { seven_day: 27 } } }),
    source().options,
  )
  expect(moved).toEqual({
    quota_minimum_remaining_five_hour: 31,
    quota_minimum_remaining_seven_day: 0,
    quota_minimum_remaining_scoped: 0,
    killswitch_default_five_hour: 5,
    killswitch_default_seven_day: 27,
    killswitch_default_scoped: 0,
  })
  const after = createEmptyStorage()
  after.quota = {
    minimumRemaining: {
      five_hour: moved.quota_minimum_remaining_five_hour,
      seven_day: moved.quota_minimum_remaining_seven_day,
      scoped: moved.quota_minimum_remaining_scoped,
    },
  }
  expect(getQuotaMinimumRemainingThresholds(legacy)).toEqual({
    five_hour: 31,
    seven_day: 0,
  })
  expect(getQuotaMinimumRemainingThresholds(after)).toEqual(
    getQuotaMinimumRemainingThresholds(legacy),
  )
})

test('threshold aliases translate and canonical keys win with one record per object', () => {
  const reader = source()
  const text = JSON.stringify({
    killswitch: { main: { '5h': 99, five_hour: 8, '1w': 98, seven_day: 17 } },
    quota: { minimumRemaining: { '5h': 21, '1w': 33 } },
  })
  expect(reader.read(text)).toEqual({
    killswitch_default_five_hour: 8,
    killswitch_default_seven_day: 17,
    killswitch_default_scoped: 0,
    quota_minimum_remaining_five_hour: 21,
    quota_minimum_remaining_seven_day: 33,
    quota_minimum_remaining_scoped: 0,
  })
  reader.read(text)
  expect(reader.messages).toHaveLength(1)
  expect(reader.messages[0]).toContain(
    'killswitch.main holds threshold aliases beside canonical keys; canonical keys win',
  )
})

test('one invalid non-protection field and one invalid quota threshold do not throw or discard valid fields', () => {
  const reader = source()
  const text = JSON.stringify({
    refresh: { intervalMinutes: -1, enabled: false },
    quota: { minimumRemaining: { five_hour: 101, seven_day: 26 } },
    dump: { enabled: true },
  })
  const result = reader.read(text)
  expect(result).toEqual({
    refresh_enabled: false,
    dump_enabled: true,
    quota_minimum_remaining_five_hour: 0,
    quota_minimum_remaining_seven_day: 26,
    quota_minimum_remaining_scoped: 0,
  })
  reader.read(text)
  expect(reader.messages).toHaveLength(2)
  expect(
    reader.messages.filter((message) =>
      message.includes('refresh.intervalMinutes is invalid; omitted'),
    ),
  ).toHaveLength(1)
  expect(
    reader.messages.filter((message) =>
      message.includes(
        'quota.minimumRemaining.five_hour is invalid; replaced with protection value 0',
      ),
    ),
  ).toHaveLength(1)
})

test('invalid scalar protection fields use rung-three values, not ordinary defaults', () => {
  const reader = source()
  expect(
    reader.read(
      JSON.stringify({
        routing: { maxSameAccountWait: 'forever' },
        killswitch: {
          enabled: null,
          main: { five_hour: -1, seven_day: 33, scoped: 'bad', extra: 9 },
        },
        quota: { failClosedOnUnknownQuota: 1 },
      }),
    ),
  ).toEqual({
    max_same_account_wait: 'off',
    killswitch_enabled: true,
    quota_fail_closed_on_unknown_quota: 'on',
    killswitch_default_five_hour: 5,
    killswitch_default_seven_day: 33,
    killswitch_default_scoped: 0,
  })
  expect(reader.messages).toHaveLength(6)
  expect(
    reader.messages.some((message) =>
      message.includes('killswitch.main.extra is unknown; omitted'),
    ),
  ).toBe(true)
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} account floors keep exact local and vault keys, complete valid entries and replace only invalid entries`, () => {
    const reader = source(host)
    const text = JSON.stringify({
      killswitch: {
        main: { five_hour: 40, seven_day: 3, scoped: 12 },
        accounts: {
          'local-row': { '5h': 7, '1w': 18 },
          'vault:credential~0123456789': { scoped: 2 },
          'bad-range': { five_hour: 101, seven_day: 18 },
          'bad-type': null,
          'bad-key': { five_hour: 30, unexpected: 40 },
          canonical: { '5h': 'ignored', five_hour: 17, '1w': 23 },
        },
      },
      accounts: [
        {
          id: 'local-row',
          email: 'do-not-rekey@example.test',
          accountIdentity: 'do-not-rekey',
        },
      ],
    })
    const result = reader.read(text) as Record<string, unknown>
    expect(result.killswitch_account_floors).toEqual([
      { account: 'local-row', host, five_hour: 7, seven_day: 18, scoped: 0 },
      {
        account: 'vault:credential~0123456789',
        host,
        five_hour: 5,
        seven_day: 10,
        scoped: 2,
      },
      { account: 'bad-range', host, five_hour: 40, seven_day: 10, scoped: 12 },
      { account: 'bad-type', host, five_hour: 40, seven_day: 10, scoped: 12 },
      { account: 'bad-key', host, five_hour: 40, seven_day: 10, scoped: 12 },
      { account: 'canonical', host, five_hour: 17, seven_day: 23, scoped: 0 },
    ])
    reader.read(text)
    expect(reader.messages).toHaveLength(4)
    expect(
      reader.messages.filter((message) =>
        message.includes('is invalid; replaced with protection floors'),
      ),
    ).toHaveLength(3)
  })
}

test('a non-map accounts value moves no entry and invalid main cannot lower account replacement floors', () => {
  const reader = source()
  expect(reader.read(JSON.stringify({ killswitch: { accounts: [] } }))).toEqual(
    { killswitch_account_floors: [] },
  )
  expect(reader.messages).toHaveLength(1)
  expect(
    source().read(
      JSON.stringify({ killswitch: { main: null, accounts: { A: false } } }),
    ),
  ).toEqual({
    killswitch_default_five_hour: 5,
    killswitch_default_seven_day: 10,
    killswitch_default_scoped: 0,
    killswitch_account_floors: [
      {
        account: 'A',
        host: 'opencode',
        five_hour: 5,
        seven_day: 10,
        scoped: 0,
      },
    ],
  })
})

test('unknown group threshold keys are logged once without discarding the valid keys', () => {
  const reader = source()
  const text = JSON.stringify({
    quota: { minimumRemaining: { typo: 8, five_hour: 14 } },
  })
  expect(reader.read(text)).toEqual({
    quota_minimum_remaining_five_hour: 14,
    quota_minimum_remaining_seven_day: 0,
    quota_minimum_remaining_scoped: 0,
  })
  reader.read(text)
  expect(reader.messages).toHaveLength(1)
  expect(reader.messages[0]).toContain(
    'quota.minimumRemaining.typo is unknown; omitted',
  )
})

for (const value of [null, true, false, 0, 'invalid', []]) {
  test(`invalid section ${JSON.stringify(value)} is handled as invalid fields, never an unreadable source`, () => {
    const reader = source()
    expect(() =>
      reader.read(JSON.stringify({ quota: value, refresh: value })),
    ).not.toThrow()
    expect(
      reader.read(JSON.stringify({ quota: value, refresh: value })),
    ).toEqual({
      quota_minimum_remaining_five_hour: 0,
      quota_minimum_remaining_seven_day: 0,
      quota_minimum_remaining_scoped: 0,
      quota_fail_closed_on_unknown_quota: 'on',
    })
  })
}

test('invalid non-protection domains are omitted independently', () => {
  const reader = source()
  expect(
    reader.read(
      JSON.stringify({
        fallbackOn: [401, 2.5],
        routing: { mode: 'unknown' },
        refresh: {
          enabled: 1,
          intervalMinutes: '5',
          refreshBeforeExpiryMinutes: -2,
        },
        quota: {
          enabled: 'invalid',
          checkIntervalMinutes: -1,
          refreshEveryNRequests: null,
          showToasts: 'yes',
        },
        claudeCache: { enabled: 1, mode: 'unknown' },
        cacheKeep: { enabled: 'yes', always: 0, subagents: null },
        quotaHeaderFeed: { enabled: 1 },
        dump: { enabled: 'yes' },
        prime: { enabled: 0 },
        claudeFast: { enabled: 1 },
        costZeroing: { enabled: null },
        logging: { level: 'unknown' },
        thinkingBinding: { prefixMismatchBehavior: 'unknown' },
        turnEndNote: { tools: [2] },
      }),
    ),
  ).toEqual({})
  expect(reader.messages).toHaveLength(22)
})

test('window hours use the legacy numeric domain, but require a complete pair', () => {
  expect(
    source().read(
      JSON.stringify({ cacheKeep: { startHour: 24.5, endHour: 30 } }),
    ),
  ).toEqual({ cache_keep_window: [{ start_hour: 24.5, end_hour: 30 }] })
  for (const cacheKeep of [
    { startHour: 3 },
    { endHour: 5 },
    { startHour: -1, endHour: 5 },
    { startHour: 0, endHour: null },
  ]) {
    const reader = source()
    expect(
      reader.read(JSON.stringify({ cacheKeep, dump: { enabled: true } })),
    ).toEqual({ dump_enabled: true })
    expect(reader.messages).toHaveLength(1)
  }
})

test('only syntax errors throw; parseable non-map roots are invalid values', () => {
  const reader = source()
  expect(() => reader.read('{')).toThrow()
  for (const text of ['null', '[]', 'true', '42', '"text"'])
    expect(reader.read(text)).toEqual({})
  expect(reader.messages).toHaveLength(1)
})

test('the common-auth move publishes valid remaining fields and protection replacements from the read callback', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'settings-move-source-'))
  folders.push(folder)
  const path = join(folder, 'legacy.json')
  const target = join(folder, 'settings.jsonc')
  const text = JSON.stringify({
    refresh: { intervalMinutes: 'bad' },
    quota: { minimumRemaining: { five_hour: 101, seven_day: 26 } },
    dump: { enabled: true },
  })
  await writeFile(path, text)
  const reader = source()
  const result = await moveSettingsOnce({
    definition: settingsDefinition,
    target,
    separateInstall: false,
    sources: [createSettingsMoveSource({ ...reader.options, path })],
    fence: () => true,
    log: { info: () => {}, warn: () => {} },
    map: mapSettingsMoveSources,
  })
  expect(result.outcome).toBe('moved')
  expect(parse(await readFile(target, 'utf8'))).toEqual({
    schema_version: 1,
    dump_enabled: true,
    quota_minimum_remaining_five_hour: 0,
    quota_minimum_remaining_seven_day: 26,
    quota_minimum_remaining_scoped: 0,
  })
  expect(reader.messages).toHaveLength(2)
  expect(await readFile(path, 'utf8')).toBe(text)
})
