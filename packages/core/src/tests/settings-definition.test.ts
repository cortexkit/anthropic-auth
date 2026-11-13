import { afterAll, describe, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  openSettings,
  SETTINGS_REFUSAL_CODES,
  settingsJsonSchema,
} from '@cortexkit/common-auth/settings'
import {
  type AccountSettingsReaderInput,
  type AccountStorage,
  createEmptyStorage,
  getCache1hPersistentMode,
  getKillswitchConfig,
  getKillswitchThresholdsForAccount,
  getPersistedLogLevel,
  getQuotaCheckIntervalMs,
  getQuotaMinimumRemainingThresholds,
  getQuotaRefreshEveryNRequests,
  getRefreshBeforeExpiryMs,
  getRefreshIntervalMs,
  isCache1hPersistentlyEnabled,
  isCacheKeepSubagentsEnabled,
  isCostZeroingEnabled,
  isDumpPersistentlyEnabled,
  isFastModePersistentlyEnabled,
  isKillswitchEnabled,
  isPrimePersistentlyEnabled,
  normalizeKillswitchThresholds,
  quotaSnapshotPassesPolicy,
  shouldFallbackStatus,
} from '../accounts.ts'
import {
  getCacheKeepWindow,
  isCacheKeepAlways,
  isCacheKeepPersistentlyEnabled,
} from '../cachekeep.ts'
import { getMaxSameAccountWait, getRoutingMode } from '../routing.ts'
import {
  malformedSettingsText,
  refusedSettingsRecreationText,
  refusedSettingsWriteText,
  SETTINGS_DEFAULT_READERS,
  SETTINGS_INFER_MEMBERS,
  SETTINGS_INFERRED_FIELDS,
  SETTINGS_THREE_WAY_READERS,
  SETTINGS_WRITE_FAILURES,
  type SettingsKey,
  settingsDefinition,
} from '../settings-definition.ts'
import { getThinkingPrefixMismatchBehavior } from '../thinking-binding.ts'
import { applyTurnEndNotes } from '../turn-end-note.ts'

const directory = await mkdtemp(join(tmpdir(), 'anthropic-settings-schema-'))
afterAll(() => rm(directory, { recursive: true, force: true }))
let sequence = 0

async function fixture(values: Record<string, unknown> = {}) {
  const file = join(directory, `${sequence++}.jsonc`)
  await writeFile(file, JSON.stringify({ schema_version: 1, ...values }))
  const handle = openSettings(settingsDefinition, {
    file,
    separateInstall: false,
    log: { warn() {}, info() {} },
  })
  await handle.read()
  return handle
}

test('all shared settings are flat, user-only and have exactly the allowed overrides', () => {
  expect(Object.keys(settingsDefinition.settings).sort()).toEqual(
    [
      'routing_mode',
      'max_same_account_wait',
      'fallback_on',
      'refresh_enabled',
      'refresh_interval_minutes',
      'refresh_refresh_before_expiry_minutes',
      'quota_enabled',
      'quota_check_interval_minutes',
      'quota_refresh_every_n_requests',
      'quota_minimum_remaining_five_hour',
      'quota_minimum_remaining_seven_day',
      'quota_minimum_remaining_scoped',
      'quota_fail_closed_on_unknown_quota',
      'quota_show_toasts',
      'quota_header_feed_enabled',
      'killswitch_enabled',
      'killswitch_default_five_hour',
      'killswitch_default_seven_day',
      'killswitch_default_scoped',
      'killswitch_account_floors',
      'claude_cache_enabled',
      'claude_cache_mode',
      'cache_keep_enabled',
      'cache_keep_always',
      'cache_keep_window',
      'cache_keep_subagents',
      'dump_enabled',
      'prime_enabled',
      'claude_fast_enabled',
      'cost_zeroing_enabled',
      'log_level',
      'thinking_binding_prefix_mismatch_behavior',
      'turn_end_note_tools',
    ].sort(),
  )
  const modelKeys = [
    'claude_cache_enabled',
    'claude_cache_mode',
    'claude_fast_enabled',
    'cache_keep_enabled',
    'thinking_binding_prefix_mismatch_behavior',
  ]
  for (const [key, declaration] of Object.entries(
    settingsDefinition.settings,
  )) {
    expect(key).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(key).not.toMatch(/sidebar|relay/)
    expect(declaration.hosts).toBe('both')
    expect(declaration.project).toBe('user-only')
    expect<unknown>(
      'overrides' in declaration ? declaration.overrides : undefined,
    ).toEqual(
      key === 'killswitch_account_floors'
        ? undefined
        : modelKeys.includes(key)
          ? { host: true, model: true }
          : { host: true },
    )
  }
})

const floorDefaults = {
  killswitch_default_five_hour: 5,
  killswitch_default_seven_day: 10,
  killswitch_default_scoped: 0,
  quota_minimum_remaining_five_hour: 0,
  quota_minimum_remaining_seven_day: 0,
  quota_minimum_remaining_scoped: 0,
} as const

describe('scalar floors', () => {
  for (const [key, expected] of Object.entries(floorDefaults)) {
    test(`${key} resolves its default when the file does not set it`, async () => {
      const handle = await fixture()
      expect(await handle.get(key as SettingsKey, { host: 'opencode' })).toBe(
        expected,
      )
      expect(handle.report()).toEqual([])
    })
    for (const value of [-0.1, 100.1]) {
      test(`${key} reports the out-of-range value ${value}`, async () => {
        const handle = await fixture({ [key]: value })
        expect(handle.report()).toEqual(
          expect.arrayContaining([expect.objectContaining({ keyPath: [key] })]),
        )
        expect(await handle.get(key as SettingsKey, { host: 'opencode' })).toBe(
          expected,
        )
      })
    }
  }
})

const accountFloor = {
  account: 'local-account-id',
  host: 'both',
  five_hour: 5,
  seven_day: 10,
  scoped: 0,
}
const { scoped: _scoped, ...missingKey } = accountFloor
const invalidEntries = {
  alias: { ...accountFloor, '5h': 5 },
  unknown: { ...accountFloor, extra: true },
  missing: missingKey,
  host: { ...accountFloor, host: 'other' },
  negative: { ...accountFloor, five_hour: -1 },
  over100: { ...accountFloor, scoped: 101 },
}
for (const [name, entry] of Object.entries(invalidEntries)) {
  test(`account floors report an entry with ${name}`, async () => {
    const handle = await fixture({ killswitch_account_floors: [entry] })
    expect(handle.report()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyPath: expect.arrayContaining(['killswitch_account_floors']),
          reason: ['alias', 'unknown'].includes(name)
            ? 'unknown-key'
            : 'invalid-value',
        }),
      ]),
    )
  })
}

test('account floors accept complete entries and percentage boundaries', async () => {
  const entries = (['opencode', 'pi', 'both'] as const).map((host) => ({
    ...accountFloor,
    host,
    five_hour: 0,
    seven_day: 100,
    scoped: 0.5,
  }))
  const handle = await fixture({ killswitch_account_floors: entries })
  expect(handle.report()).toEqual([])
  expect(
    await handle.get('killswitch_account_floors', { host: 'opencode' }),
  ).toEqual(entries)
})

test('the published schema has not drifted from the declaration', async () => {
  const shipped = JSON.parse(
    await readFile(
      new URL('../../schema/anthropic-auth.schema.json', import.meta.url),
      'utf8',
    ),
  )
  expect(shipped).toEqual(settingsJsonSchema(settingsDefinition))
  expect(Object.keys(shipped.properties).sort()).toEqual(
    [
      '$schema',
      'schema_version',
      ...Object.keys(settingsDefinition.settings),
    ].sort(),
  )
})

test('Core pack dry-run includes the published schema', async () => {
  // A writable staging directory lets pack run on read-only build checkouts.
  const staged = join(directory, 'pack')
  await mkdir(staged)
  const core = new URL('../..', import.meta.url)
  for (const entry of ['package.json', 'dist', 'schema']) {
    await cp(new URL(entry, core), join(staged, entry), { recursive: true })
  }
  const packed = Bun.spawnSync([process.execPath, 'pm', 'pack', '--dry-run'], {
    cwd: staged,
  })
  const output = packed.stdout.toString() + packed.stderr.toString()
  expect(packed.exitCode, output).toBe(0)
  expect(output).toContain('schema/anthropic-auth.schema.json')
})

const expectedFailures = {
  'settings-unparseable': ['refused', 'malformed or contains duplicate keys'],
  'settings-newer-version': ['refused', 'newer settings version'],
  'settings-invalid-value': ['refused', 'requested setting value is invalid'],
  'settings-busy': ['failed', 'settings file is busy'],
  'settings-unavailable': ['failed', 'settings file is unavailable'],
} as const
test('every dependency refusal code has a fixed outcome and text', () => {
  expect(Object.keys(SETTINGS_WRITE_FAILURES).sort()).toEqual(
    [...SETTINGS_REFUSAL_CODES].sort(),
  )
})
for (const code of SETTINGS_REFUSAL_CODES) {
  test(`${code} maps to the documented failure without exposing dependency text`, () => {
    const mapping = SETTINGS_WRITE_FAILURES[code]
    expect(mapping.outcome).toBe(expectedFailures[code][0])
    const text = mapping.text(join(directory, 'resolved.jsonc'))
    expect(text).toContain(resolve(directory, 'resolved.jsonc'))
    expect(text).toContain(expectedFailures[code][1])
    expect(text).not.toContain('sk-ant-')
  })
}

test('malformed, removed-leaf and rung-3 refusal texts name the resolved file', () => {
  const file = join(directory, 'folder', '..', 'settings.jsonc')
  expect(malformedSettingsText(file)).toContain(resolve(file))
  expect(refusedSettingsWriteText('quota_enabled', file)).toBe(
    `Cannot remove setting "quota_enabled" from "${resolve(file)}": a lower level would still supply a value. Edit the settings file to set the value you want.`,
  )
  expect(refusedSettingsRecreationText(file)).toBe(
    `Cannot recreate settings file "${resolve(file)}": protection settings are unknown. Edit the settings file to set them before trying again.`,
  )
})

// These three readers are private to OpenCode's plugin. Execute their source
// predicates instead of copying their defaults into the expected values.
const openCodeSource = await readFile(
  new URL('../../../opencode/src/index.ts', import.meta.url),
  'utf8',
)
function hostPredicate(pattern: RegExp, name: string, storage: AccountStorage) {
  const expression = openCodeSource.match(pattern)?.[1]
  expect(expression, `reader ${name} must still exist`).toBeDefined()
  return new Function(
    'storage',
    `return (${expression?.replaceAll('initialStorage', 'storage')})`,
  )(storage) as boolean
}
function readTurnEndTools(storage: AccountStorage) {
  const tools: string[] = []
  applyTurnEndNotes(
    { model: 'claude-opus-5-5', messages: [] },
    {
      tools: storage.turnEndNote?.tools,
      mapToolName: (name) => {
        tools.push(name)
        return name
      },
    },
  )
  return tools
}

const defaultReaders = {
  routing_mode: getRoutingMode,
  max_same_account_wait: (s: AccountStorage) =>
    ({ '0': 'off', '15': '15m', max: 'cache' })[getMaxSameAccountWait(s)],
  fallback_on: (s: AccountStorage) =>
    Array.from({ length: 500 }, (_, index) => index + 100).filter((status) =>
      shouldFallbackStatus(status, s),
    ),
  refresh_enabled: (s: AccountStorage) =>
    hostPredicate(
      /function mainRefreshEnabled\([\s\S]*?return ([^\n]+)/,
      'mainRefreshEnabled',
      s,
    ),
  refresh_interval_minutes: (s: AccountStorage) =>
    getRefreshIntervalMs(s) / 60_000,
  refresh_refresh_before_expiry_minutes: (s: AccountStorage) =>
    getRefreshBeforeExpiryMs(s) / 60_000,
  quota_check_interval_minutes: (s: AccountStorage) =>
    getQuotaCheckIntervalMs(s) / 60_000,
  quota_refresh_every_n_requests: getQuotaRefreshEveryNRequests,
  quota_minimum_remaining_five_hour: (s: AccountStorage) =>
    getQuotaMinimumRemainingThresholds(s).five_hour,
  quota_minimum_remaining_seven_day: (s: AccountStorage) =>
    getQuotaMinimumRemainingThresholds(s).seven_day,
  quota_minimum_remaining_scoped: (s: AccountStorage) =>
    normalizeKillswitchThresholds(s.quota?.minimumRemaining).scoped,
  quota_show_toasts: (s: AccountStorage) =>
    !hostPredicate(
      /function showQuotaToastFromCache\(\) \{\s*if \(([^\n]+)\) return/,
      'showQuotaToastFromCache',
      s,
    ),
  quota_header_feed_enabled: (s: AccountStorage) =>
    hostPredicate(
      /const quotaHeaderFeedRegistry =\s*(initialStorage[\s\S]*?)\s*\? new QuotaHeaderFeedRegistry/,
      'quotaHeaderFeedRegistry',
      s,
    ),
  killswitch_enabled: isKillswitchEnabled,
  killswitch_default_five_hour: (s: AccountStorage) =>
    getKillswitchThresholdsForAccount(s).five_hour,
  killswitch_default_seven_day: (s: AccountStorage) =>
    getKillswitchThresholdsForAccount(s).seven_day,
  killswitch_default_scoped: (s: AccountStorage) =>
    getKillswitchThresholdsForAccount(s).scoped,
  killswitch_account_floors: (s: AccountStorage) =>
    Object.entries(getKillswitchConfig(s).accounts ?? {}).map(
      ([account, thresholds]) => ({
        account,
        host: 'opencode',
        ...normalizeKillswitchThresholds(thresholds),
      }),
    ),
  claude_cache_mode: getCache1hPersistentMode,
  cache_keep_enabled: isCacheKeepPersistentlyEnabled,
  cache_keep_always: isCacheKeepAlways,
  cache_keep_window: (s: AccountStorage) => {
    const window = getCacheKeepWindow(s)
    return window
      ? [{ start_hour: window.startHour, end_hour: window.endHour }]
      : []
  },
  cache_keep_subagents: isCacheKeepSubagentsEnabled,
  dump_enabled: isDumpPersistentlyEnabled,
  prime_enabled: isPrimePersistentlyEnabled,
  claude_fast_enabled: isFastModePersistentlyEnabled,
  cost_zeroing_enabled: isCostZeroingEnabled,
  log_level: (s: AccountStorage) => getPersistedLogLevel(s) ?? 'default',
  thinking_binding_prefix_mismatch_behavior: getThinkingPrefixMismatchBehavior,
  turn_end_note_tools: readTurnEndTools,
} satisfies Record<
  Exclude<SettingsKey, keyof typeof SETTINGS_THREE_WAY_READERS>,
  (storage: AccountStorage) => unknown
>

test('the default-reader inventory covers exactly the declaration', () => {
  expect(Object.keys(SETTINGS_DEFAULT_READERS).sort()).toEqual(
    Object.keys(settingsDefinition.settings).sort(),
  )
  expect(
    [
      ...Object.keys(defaultReaders),
      ...Object.keys(SETTINGS_THREE_WAY_READERS),
    ].sort(),
  ).toEqual(Object.keys(settingsDefinition.settings).sort())
})
for (const [key, reader] of Object.entries(defaultReaders)) {
  test(`${key} default equals ${SETTINGS_DEFAULT_READERS[key as SettingsKey]} on an empty store`, async () => {
    const empty = createEmptyStorage()
    const handle = await fixture()
    expect<unknown>(
      await handle.get(key as SettingsKey, { host: 'opencode' }),
    ).toEqual(reader(empty))
  })
}

for (const key of Object.keys(
  SETTINGS_THREE_WAY_READERS,
) as (keyof typeof SETTINGS_THREE_WAY_READERS)[]) {
  for (const value of ['default', 'on', 'off'] as const) {
    test(`${key} accepts the three-way member ${value}`, async () => {
      const handle = await fixture({ [key]: value })
      expect(await handle.get(key, { host: 'opencode' })).toBe(value)
      expect(handle.report()).toEqual([])
    })
  }
  test(`${key} reports a legacy boolean in the user file`, async () => {
    const handle = await fixture({ [key]: true })
    expect(handle.report()).toContainEqual(
      expect.objectContaining({ keyPath: [key], reason: 'invalid-value' }),
    )
  })
  test(`${key} resolves to default and preserves its named Core reader's absence output`, async () => {
    const handle = await fixture()
    const value = await handle.get(key, { host: 'opencode' })
    expect(value).toBe('default')
    const empty = createEmptyStorage()
    const decoded: AccountSettingsReaderInput = createEmptyStorage()
    if (key === 'claude_cache_enabled') {
      decoded.claudeCache = { enabled: value }
      expect(isCache1hPersistentlyEnabled(decoded)).toBe(
        isCache1hPersistentlyEnabled(empty),
      )
    } else {
      decoded.quota =
        key === 'quota_enabled'
          ? { enabled: value }
          : { failClosedOnUnknownQuota: value }
      expect(quotaSnapshotPassesPolicy(undefined, decoded)).toBe(
        quotaSnapshotPassesPolicy(undefined, empty),
      )
    }
  })
}

for (const key of SETTINGS_INFERRED_FIELDS) {
  test(`${key} resolves to its explicit infer member`, async () => {
    const member = SETTINGS_INFER_MEMBERS[key]
    const handle = await fixture()
    expect(await handle.get(key as SettingsKey, { host: 'opencode' })).toBe(
      member,
    )
    expect(settingsDefinition.settings[key].default).toBe(member)
  })
}
