import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'
import {
  type AccountStorage,
  createEmptyStorage,
  getKillswitchThresholdsForAccount,
} from '../accounts.ts'
import { CLAUDE_MODEL_CAPABILITIES } from '../model-capabilities.ts'
import {
  SETTINGS_INFER_MEMBERS,
  SETTINGS_INFERRED_FIELDS,
  settingsDefinition,
} from '../settings-definition.ts'
import { resolveSettingsRecord, settingsFileSets } from '../settings-record.ts'
import {
  mostRestrictiveSettingsProtection,
  openSettingsService,
  type SettingsServiceOptions,
  type SettingsValues,
} from '../settings-service.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  source = '{}',
  overrides: Partial<SettingsServiceOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'settings-record-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.jsonc')
  await writeFile(file, source)
  let reads = 0
  const service = await openSettingsService({
    file,
    ...overrides,
    dependencies: {
      readFile: async (path) => {
        reads++
        return readFile(path)
      },
      open: (options) => ({
        ...openSettings(settingsDefinition, options),
        watch: () => () => {},
      }),
    },
  })
  if (!service) throw new Error('Expected a user-file service')
  cleanup.push(() => service.dispose())
  return { file, service, reads: () => reads }
}

const defaults = {
  routing: { mode: 'main-first', maxSameAccountWait: '15' },
  fallbackOn: [401, 403, 429],
  refresh: {
    enabled: true,
    intervalMinutes: 10,
    refreshBeforeExpiryMinutes: 240,
  },
  quota: {
    enabled: 'default',
    checkIntervalMinutes: 5,
    refreshEveryNRequests: 0,
    minimumRemaining: { five_hour: 0, seven_day: 0, scoped: 0 },
    failClosedOnUnknownQuota: 'default',
    showToasts: false,
  },
  quotaHeaderFeed: { enabled: false },
  killswitch: {
    enabled: false,
    main: { five_hour: 5, seven_day: 10, scoped: 0 },
    accounts: {},
  },
  claudeCache: { enabled: 'default', mode: 'explicit' },
  cacheKeep: { enabled: false, always: false, subagents: false },
  dump: { enabled: false },
  prime: { enabled: false },
  claudeFast: { enabled: false },
  costZeroing: { enabled: true },
  logging: {},
  thinkingBinding: {},
  turnEndNote: { tools: ['board', 'ctx_reduce'] },
} satisfies Partial<AccountStorage>

// Independent expected records pin the public shape rather than round-tripping a converter.
const explicit = {
  routing: { mode: 'fallback-first', maxSameAccountWait: 'max' },
  fallbackOn: [502],
  refresh: {
    enabled: false,
    intervalMinutes: 12,
    refreshBeforeExpiryMinutes: 60,
  },
  quota: {
    enabled: 'off',
    checkIntervalMinutes: 8,
    refreshEveryNRequests: 7,
    minimumRemaining: { five_hour: 11, seven_day: 12, scoped: 13 },
    failClosedOnUnknownQuota: 'off',
    showToasts: true,
  },
  quotaHeaderFeed: { enabled: true },
  killswitch: {
    enabled: true,
    main: { five_hour: 21, seven_day: 22, scoped: 23 },
    accounts: { local: { five_hour: 31, seven_day: 32, scoped: 33 } },
  },
  claudeCache: { enabled: 'on', mode: 'hybrid' },
  cacheKeep: {
    enabled: true,
    always: true,
    startHour: 8,
    endHour: 18,
    subagents: true,
  },
  dump: { enabled: true },
  prime: { enabled: true },
  claudeFast: { enabled: true },
  costZeroing: { enabled: false },
  logging: { level: 'debug' },
  thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
  turnEndNote: { tools: ['custom'] },
} satisfies Partial<AccountStorage>

const fileValues = {
  routing_mode: 'fallback-first',
  max_same_account_wait: 'cache',
  fallback_on: [502],
  refresh_enabled: false,
  refresh_interval_minutes: 12,
  refresh_refresh_before_expiry_minutes: 60,
  quota_enabled: 'off',
  quota_check_interval_minutes: 8,
  quota_refresh_every_n_requests: 7,
  quota_minimum_remaining_five_hour: 11,
  quota_minimum_remaining_seven_day: 12,
  quota_minimum_remaining_scoped: 13,
  quota_fail_closed_on_unknown_quota: 'off',
  quota_show_toasts: true,
  quota_header_feed_enabled: true,
  killswitch_enabled: true,
  killswitch_default_five_hour: 21,
  killswitch_default_seven_day: 22,
  killswitch_default_scoped: 23,
  killswitch_account_floors: [
    {
      account: 'local',
      host: 'both',
      five_hour: 31,
      seven_day: 32,
      scoped: 33,
    },
  ],
  claude_cache_enabled: 'on',
  claude_cache_mode: 'hybrid',
  cache_keep_enabled: true,
  cache_keep_always: true,
  cache_keep_window: [{ start_hour: 8, end_hour: 18 }],
  cache_keep_subagents: true,
  dump_enabled: true,
  prime_enabled: true,
  claude_fast_enabled: true,
  cost_zeroing_enabled: false,
  log_level: 'debug',
  thinking_binding_prefix_mismatch_behavior: 'drop_block',
  turn_end_note_tools: ['custom'],
} satisfies SettingsValues

test("all declared defaults replace legacy moved settings in today's complete record shape", async () => {
  const { service } = await fixture()
  for (const host of ['opencode', 'pi'] as const) {
    const stored: AccountStorage = { ...createEmptyStorage(), ...explicit }
    expect(resolveSettingsRecord(stored, service.snapshot(), host)).toEqual({
      ...createEmptyStorage(),
      ...defaults,
    })
    expect(stored).toEqual({ ...createEmptyStorage(), ...explicit })
  }
})

test('every file setting projects into its corresponding legacy-shaped leaf', async () => {
  expect(Object.keys(fileValues).sort()).toEqual(
    Object.keys(settingsDefinition.settings).sort(),
  )
  const { service } = await fixture(JSON.stringify(fileValues))
  for (const host of ['opencode', 'pi'] as const)
    expect(resolveSettingsRecord({}, service.snapshot(), host)).toEqual(
      explicit,
    )
})

test('host levels apply to every setting except the account-floor list', async () => {
  const source = Object.fromEntries(
    Object.entries(fileValues).map(([key, value]) => [
      key,
      key === 'killswitch_account_floors'
        ? value
        : {
            default:
              settingsDefinition.settings[key as keyof SettingsValues].default,
            opencode: value,
          },
    ]),
  )
  const { service } = await fixture(JSON.stringify(source))
  expect(resolveSettingsRecord({}, service.snapshot(), 'opencode')).toEqual(
    explicit,
  )
  expect(resolveSettingsRecord({}, service.snapshot(), 'pi')).toEqual({
    ...defaults,
    killswitch: {
      ...defaults.killswitch,
      accounts: explicit.killswitch.accounts,
    },
  })
  await writeFile(
    service.file,
    JSON.stringify(source).replaceAll('"opencode":', '"pi":'),
  )
  await service.refresh()
  expect(resolveSettingsRecord({}, service.snapshot(), 'pi')).toEqual(explicit)
})

test('request models override exactly the five model settings and unknown models use no-model values', async () => {
  const row = CLAUDE_MODEL_CAPABILITIES[0]!
  const modelKeys = new Set<string>([
    'claude_cache_enabled',
    'claude_cache_mode',
    'claude_fast_enabled',
    'cache_keep_enabled',
    'thinking_binding_prefix_mismatch_behavior',
  ])
  expect(
    Object.entries(settingsDefinition.settings)
      .filter(
        ([, declaration]) =>
          'overrides' in declaration &&
          'model' in declaration.overrides &&
          declaration.overrides.model,
      )
      .map(([key]) => key)
      .sort(),
  ).toEqual([...modelKeys].sort())
  const source = Object.fromEntries(
    Object.entries(fileValues).map(([key, value]) => [
      key,
      modelKeys.has(key)
        ? {
            default:
              settingsDefinition.settings[key as keyof SettingsValues].default,
            [row.id]: value,
          }
        : settingsDefinition.settings[key as keyof SettingsValues].default,
    ]),
  )
  const { service } = await fixture(JSON.stringify(source))
  for (const host of ['opencode', 'pi'] as const) {
    const generation = service.snapshot()
    expect(resolveSettingsRecord({}, generation, host)).toEqual(defaults)
    expect(resolveSettingsRecord({}, generation, host, 'unknown')).toEqual(
      defaults,
    )
    expect(
      resolveSettingsRecord({}, generation, host, `${row.id}[1m]`),
    ).toEqual({
      ...defaults,
      claudeCache: explicit.claudeCache,
      cacheKeep: { ...defaults.cacheKeep, enabled: true },
      claudeFast: explicit.claudeFast,
      thinkingBinding: explicit.thinkingBinding,
    })
  }
})

for (const key of SETTINGS_INFERRED_FIELDS) {
  test(`${key} resolves to its infer member and leaves its record field absent`, async () => {
    const { service } = await fixture(
      JSON.stringify({ [key]: SETTINGS_INFER_MEMBERS[key] }),
    )
    expect(service.resolve('opencode')[key]).toBe(SETTINGS_INFER_MEMBERS[key])
    const record = resolveSettingsRecord(
      { ...createEmptyStorage(), ...explicit },
      service.snapshot(),
      'opencode',
    )
    if (key === 'log_level')
      expect(Object.hasOwn(record.logging!, 'level')).toBe(false)
    else
      expect(
        Object.hasOwn(record.thinkingBinding!, 'prefixMismatchBehavior'),
      ).toBe(false)
  })
}

for (const [file, record] of [
  ['off', '0'],
  ['15m', '15'],
  ['cache', 'max'],
] as const) {
  test(`max_same_account_wait ${file} projects as ${record}`, async () => {
    const { service } = await fixture(
      JSON.stringify({ max_same_account_wait: file }),
    )
    expect(
      resolveSettingsRecord(
        createEmptyStorage(),
        service.snapshot(),
        'opencode',
      ).routing?.maxSameAccountWait,
    ).toBe(record)
  })
}

test('account floors filter by host, preserve custody keys and use default floors for unmatched accounts', async () => {
  const { service } = await fixture(
    JSON.stringify({
      killswitch_default_five_hour: 14,
      killswitch_account_floors: [
        {
          account: 'same-local-id',
          host: 'opencode',
          five_hour: 1,
          seven_day: 2,
          scoped: 3,
        },
        {
          account: 'same-local-id',
          host: 'pi',
          five_hour: 4,
          seven_day: 5,
          scoped: 6,
        },
        {
          account: 'vault:credential~0123456789',
          host: 'both',
          five_hour: 7,
          seven_day: 8,
          scoped: 9,
        },
        {
          account: '__proto__',
          host: 'both',
          five_hour: 10,
          seven_day: 11,
          scoped: 12,
        },
      ],
    }),
  )
  for (const host of ['opencode', 'pi'] as const) {
    const local = resolveSettingsRecord(
      createEmptyStorage(),
      service.snapshot(),
      host,
    )
    const vault = resolveSettingsRecord(
      { ...createEmptyStorage(), claustrum: { mode: 'claustrum' } },
      service.snapshot(),
      host,
    )
    expect(vault.killswitch).toEqual(local.killswitch)
    expect(Object.keys(local.killswitch!.accounts!)).toEqual([
      'same-local-id',
      'vault:credential~0123456789',
      '__proto__',
    ])
    expect(getKillswitchThresholdsForAccount(local, 'same-local-id')).toEqual(
      host === 'opencode'
        ? { five_hour: 1, seven_day: 2, scoped: 3 }
        : { five_hour: 4, seven_day: 5, scoped: 6 },
    )
    expect(
      getKillswitchThresholdsForAccount(local, 'vault:credential~0123456789'),
    ).toEqual({ five_hour: 7, seven_day: 8, scoped: 9 })
    expect(getKillswitchThresholdsForAccount(local, 'unmatched')).toEqual({
      five_hour: 14,
      seven_day: 10,
      scoped: 0,
    })
  }
})

for (const choice of ['default', 'on', 'off'] as const) {
  test(`all three three-way fields stay ${choice} strings in user-file mode`, async () => {
    const { service } = await fixture(
      JSON.stringify({
        claude_cache_enabled: choice,
        quota_enabled: choice,
        quota_fail_closed_on_unknown_quota: choice,
      }),
    )
    const record = resolveSettingsRecord(
      createEmptyStorage(),
      service.snapshot(),
      'opencode',
    )
    expect(record.claudeCache?.enabled).toBe(choice)
    expect(record.quota?.enabled).toBe(choice)
    expect(record.quota?.failClosedOnUnknownQuota).toBe(choice)
  })
}

test('legacy mode and a separate install preserve booleans and absence without defaults', async () => {
  const separate = await openSettingsService({
    file: '/not-read/settings.jsonc',
    separateInstall: true,
    dependencies: {
      readFile: async () => {
        throw new Error("Must not read a separate install's user file")
      },
    },
  })
  expect(separate).toBeUndefined()
  for (const generation of [undefined, separate?.snapshot()]) {
    for (const value of [true, false, undefined]) {
      const stored =
        value === undefined
          ? createEmptyStorage()
          : {
              ...createEmptyStorage(),
              claudeCache: { enabled: value },
              quota: { enabled: value, failClosedOnUnknownQuota: value },
            }
      expect(resolveSettingsRecord(stored, generation, 'pi')).toEqual(stored)
      expect(resolveSettingsRecord(stored, generation, 'pi')).not.toBe(stored)
    }
  }
})

test('merging retains store-held policy, custody, refresh, quota, prime and relay state without aliasing', async () => {
  const { service } = await fixture(JSON.stringify(fileValues))
  const retained = {
    version: 1,
    accounts: [
      {
        id: 'row',
        type: 'api',
        apiKey: 'private-key',
        baseURL: 'https://api.example',
        addedAt: 1,
      },
    ],
    mainAccountId: 'row',
    nativeAccountOrder: ['row'],
    claustrum: { mode: 'claustrum', disabledAccountIdentities: ['other'] },
    relay: {
      enabled: true,
      url: 'https://relay.example',
      transport: 'websocket',
      token: 'private-token',
      generation: 2,
    },
    main: {
      type: 'opencode',
      provider: 'anthropic',
      profile: { accountIdentity: 'row' },
    },
    refresh: {
      mainRefreshLeaseId: 'lease',
      mainRefreshLeaseUntil: 123,
      mainRefreshLeaseTokenHash: 'hash',
      mainRefreshErrorClearedAt: 124,
    },
    quota: {
      mainQuota: { checkedAt: 125 },
      mainQuotaCheckedAt: 125,
      mainQuotaToken: 'fingerprint',
      mainQuotaErrorGeneration: 3,
      mainQuotaErrorClearedAt: 126,
    },
    prime: { main: { turns: 3 }, mainAuthLineageId: 'lineage' },
  }
  const record = resolveSettingsRecord(retained, service.snapshot(), 'opencode')
  expect(record).toEqual({
    ...retained,
    ...explicit,
    quota: { ...retained.quota, ...explicit.quota },
    refresh: { ...retained.refresh, ...explicit.refresh },
    prime: { ...retained.prime, ...explicit.prime },
  })
  expect(record.accounts).not.toBe(retained.accounts)
  expect(record.relay).not.toBe(retained.relay)
  const again = resolveSettingsRecord({}, service.snapshot(), 'opencode')
  expect(again).toEqual(explicit)
  expect(again.fallbackOn).not.toBe(service.resolve('opencode').fallback_on)
})

for (const rung of [1, 2, 3] as const) {
  test(`protection rung ${rung} supplies the whole applied set to policy and mutator records`, async () => {
    const applied = {
      ...mostRestrictiveSettingsProtection(),
      killswitch_default_five_hour: 44,
      max_same_account_wait: 'cache' as const,
    }
    const { service } = await fixture('{', {
      protection:
        rung === 1
          ? { readAppliedCopy: async () => applied }
          : rung === 2
            ? { readLegacyProtection: async () => applied }
            : {},
    })
    expect(service.snapshot().protection.opencode.rung).toBe(rung)
    const stored: AccountStorage = { ...createEmptyStorage(), ...explicit }
    const record = resolveSettingsRecord(stored, service.snapshot(), 'opencode')
    expect(record.killswitch).toEqual({
      enabled: true,
      main: { five_hour: rung === 3 ? 5 : 44, seven_day: 10, scoped: 0 },
      accounts: {},
    })
    expect(record.quota?.minimumRemaining).toEqual({
      five_hour: 0,
      seven_day: 0,
      scoped: 0,
    })
    expect(record.quota?.failClosedOnUnknownQuota).toBe('on')
    expect(record.routing?.maxSameAccountWait).toBe(rung === 3 ? '0' : 'max')
  })
}

test('file-level presence follows JSONC read semantics, not schema validity or declared defaults', async () => {
  const row = CLAUDE_MODEL_CAPABILITIES[0]!
  const { service, file, reads } = await fixture(`\uFEFF{
    // The last duplicate, not the first, decides which host has a level.
    "dump_enabled": { "default": true },
    "dump_enabled": { "pi": false, },
    "quota_check_interval_minutes": "invalid",
    "claude_fast_enabled": { "pi": true, "pi": false, "${row.id}": true, "not-a-model": false },
  }`)
  const generation = service.snapshot()
  expect(settingsFileSets(generation, 'dump_enabled', 'opencode')).toBe(false)
  expect(settingsFileSets(generation, 'dump_enabled', 'pi')).toBe(true)
  expect(
    settingsFileSets(generation, 'quota_check_interval_minutes', 'pi'),
  ).toBe(true)
  expect(settingsFileSets(generation, 'quota_enabled', 'pi')).toBe(false)
  expect(settingsFileSets(generation, 'claude_fast_enabled', 'opencode')).toBe(
    false,
  )
  expect(
    settingsFileSets(
      generation,
      'claude_fast_enabled',
      'opencode',
      `${row.id}[1m]`,
    ),
  ).toBe(true)
  expect(
    settingsFileSets(
      generation,
      'claude_fast_enabled',
      'opencode',
      'not-a-model',
    ),
  ).toBe(false)
  expect(
    resolveSettingsRecord(createEmptyStorage(), generation, 'pi').claudeFast
      ?.enabled,
  ).toBe(false)
  const readCount = reads()
  const bytes = await readFile(file, 'utf8')
  await writeFile(file, '{}')
  for (let i = 0; i < 3; i++) {
    expect(settingsFileSets(generation, 'dump_enabled', 'pi')).toBe(true)
    expect(
      resolveSettingsRecord(createEmptyStorage(), generation, 'pi').quota
        ?.checkIntervalMinutes,
    ).toBe(5)
  }
  expect(reads()).toBe(readCount)
  // Requests never read or rewrite the changed file; refresh publishes its new presence separately.
  expect(await readFile(file, 'utf8')).toBe('{}')
  expect(bytes.startsWith('\uFEFF')).toBe(true)
  await service.refresh()
  expect(settingsFileSets(service.snapshot(), 'dump_enabled', 'pi')).toBe(false)
  expect(settingsFileSets(generation, 'dump_enabled', 'pi')).toBe(true)
})

for (const source of [
  ' \t\r\n',
  '\uFEFF \t\r\n',
  '{"dump_enabled": true,',
  '\uFEFF\uFEFF{}',
  '[]',
]) {
  test(`empty or unparseable file has no explicit levels: ${JSON.stringify(source)}`, async () => {
    const { service } = await fixture(source)
    expect(service.snapshot().fileLevels).toEqual({})
  })
}
