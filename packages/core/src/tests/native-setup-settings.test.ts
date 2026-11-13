import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import { splitNativeMigrationSettings } from '../native-migration-source.ts'
import {
  type NativeSetupSettingsOptions,
  writeNativeSetupSettings,
} from '../native-setup-settings.ts'
import {
  malformedSettingsText,
  refusedSettingsRecreationText,
  settingsDefinition,
} from '../settings-definition.ts'
import { resolveSettingsPaths, type SettingsHost } from '../settings-paths.ts'
import { writeSettingsProtectionCopy } from '../settings-protection-copy.ts'
import { legacySettingsProtection } from '../settings-protection-legacy.ts'
import { resolveSettingsRecord } from '../settings-record.ts'
import { openSettingsService } from '../settings-service.ts'

const folders: string[] = []
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true })
})

const legacy = {
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
    minimumRemaining: { '5h': 17, '1w': 19 },
    failClosedOnUnknownQuota: true,
    showToasts: true,
  },
  quotaHeaderFeed: { enabled: true },
  killswitch: {
    enabled: true,
    main: { '5h': 9, '1w': 21 },
    accounts: { 'row-42': { '5h': 7, '1w': 18 } },
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
}

async function fixture(
  host: SettingsHost = 'opencode',
  settings: Record<string, unknown> = { dump: { enabled: true } },
) {
  const home = await mkdtemp(join(tmpdir(), 'native-setup-settings-'))
  folders.push(home)
  const paths = await resolveSettingsPaths(host, {
    home,
    env: {},
    platform: 'linux',
  })
  await mkdir(dirname(paths.own.account), { recursive: true })
  await mkdir(dirname(paths.target), { recursive: true })
  await writeFile(paths.own.account, JSON.stringify(settings))
  const writes: Record<string, unknown>[] = []
  const messages: string[] = []
  const options: NativeSetupSettingsOptions = {
    host,
    settings,
    source: paths.own.account,
    paths,
    writeLegacySettings: async (value) => {
      writes.push(structuredClone(value))
    },
    protection: {
      readLegacyProtection: async () =>
        legacySettingsProtection(
          JSON.parse(await readFile(paths.own.account, 'utf8')),
          host,
        ),
    },
    log: {
      warn: (message) => {
        messages.push(message)
      },
    },
  }
  return {
    home,
    paths,
    writes,
    messages,
    options,
    write: () => writeNativeSetupSettings(options),
  }
}

async function contents(path: string) {
  return parse(await readFile(path, 'utf8'))
}
async function absent(path: string) {
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

for (const host of ['opencode', 'pi'] as const) {
  test(`${host}: no marker or file writes only raw legacy settings, never moves or leaves notes`, async () => {
    const f = await fixture(host, legacy)
    const before = await readFile(f.paths.own.account, 'utf8')
    expect(await f.write()).toEqual({
      target: 'legacy-store',
      outcome: 'saved',
      skipped: [],
      differing: [],
    })
    expect(f.writes).toEqual([legacy])
    expect(await readFile(f.paths.own.account, 'utf8')).toBe(before)
    await absent(f.paths.target)
    await absent(f.paths.marker)
    await absent(`${f.paths.target}.applied.json`)
    expect(await readdir(dirname(f.paths.own.account))).toEqual([
      'anthropic-auth.json',
    ])
  })

  for (const marked of [false, true]) {
    for (const invalid of [false, true]) {
      test(`${host}: parsed file marker=${marked} invalid protection=${invalid} ${host === 'pi' ? 'reports absent Pi values' : 'fills absent values'}`, async () => {
        const f = await fixture(host)
        const text = `// outside comment\n{ "unknown": 19, ${invalid ? '"killswitch_enabled": "invalid",' : ''} }\n`
        await writeFile(f.paths.target, text)
        if (marked) await writeFile(f.paths.marker, 'existing-marker')
        let markerBeforeEdit = false
        const outcome = await writeNativeSetupSettings({
          ...f.options,
          authority: {
            fs: {
              writeMarker: async (path, bytes) => {
                markerBeforeEdit =
                  (await readFile(f.paths.target, 'utf8')) === text
                await writeFile(path, bytes)
              },
            },
          },
        })
        expect(outcome.outcome).toBe('saved')
        expect(f.writes).toEqual([])
        expect((await contents(f.paths.target)).dump_enabled).toBe(
          host === 'opencode' ? true : undefined,
        )
        if (host === 'pi')
          expect(outcome.differing).toEqual([
            {
              key: 'dump_enabled',
              legacy: true,
              file: false,
              note: "Pi's value was not imported because the settings file had no Pi entry for it.",
            },
          ])
        expect((await contents(f.paths.target)).unknown).toBe(19)
        expect(await readFile(f.paths.target, 'utf8')).toContain(
          '// outside comment',
        )
        if (!marked) {
          expect(markerBeforeEdit).toBe(true)
          expect((await contents(f.paths.marker)).version).toBe(1)
        } else
          expect(await readFile(f.paths.marker, 'utf8')).toBe('existing-marker')
      })
    }
    for (const text of [
      '{',
      '{ "dump_enabled": true, "dump_enabled": false }',
    ]) {
      test(`${host}: malformed or duplicate file marker=${marked} refuses all destinations: ${text}`, async () => {
        const f = await fixture(host)
        await writeFile(f.paths.target, text)
        if (marked) await writeFile(f.paths.marker, 'marker')
        expect(await f.write()).toMatchObject({
          target: 'user-file',
          outcome: 'refused',
          reason: malformedSettingsText(f.paths.target),
        })
        expect(await readFile(f.paths.target, 'utf8')).toBe(text)
        expect(f.writes).toEqual([])
        if (!marked) await absent(f.paths.marker)
      })
    }
  }

  test(`${host}: existing top-level and host values win and differing imports are named once`, async () => {
    const f = await fixture(host, {
      dump: { enabled: true },
      prime: { enabled: true },
      refresh: { intervalMinutes: 31 },
    })
    await writeFile(
      f.paths.target,
      `{
      // retained
      "dump_enabled": false,
      "prime_enabled": { "default": true, "${host}": false },
      "refresh_interval_minutes": { "${host === 'pi' ? 'opencode' : 'pi'}": 10 }
    }`,
    )
    const outcome = await f.write()
    expect(outcome.skipped).toEqual(
      host === 'pi'
        ? ['refresh_interval_minutes', 'dump_enabled', 'prime_enabled']
        : ['dump_enabled', 'prime_enabled'],
    )
    expect(outcome.differing).toEqual([
      ...(host === 'pi'
        ? [
            {
              key: 'refresh_interval_minutes' as const,
              legacy: 31,
              file: 10,
              note: "Pi's value was not imported because the settings file had no Pi entry for it.",
            },
          ]
        : []),
      { key: 'dump_enabled', legacy: true, file: false },
      { key: 'prime_enabled', legacy: true, file: false },
    ])
    expect(f.messages).toHaveLength(host === 'pi' ? 3 : 2)
    expect(
      f.messages.every((line) => line.includes('Setup skipped setting')),
    ).toBe(true)
    const file = await contents(f.paths.target)
    expect(file.dump_enabled).toBe(false)
    expect(file.prime_enabled).toEqual({ default: true, [host]: false })
    expect(file.refresh_interval_minutes).toEqual(
      host === 'pi' ? { opencode: 10 } : { pi: 10, default: 31 },
    )
    expect(f.writes).toEqual([])
  })

  for (const rung of [1, 2, 3]) {
    test(`${host}: marker without file recreates on rung ${rung}, carried protection wins`, async () => {
      const f = await fixture(host, {
        ...legacy,
        killswitch: { enabled: false },
        routing: { maxSameAccountWait: '0' },
      })
      await writeFile(f.paths.marker, 'marker')
      const copy = legacySettingsProtection(legacy, host)
      if (rung === 1)
        await writeSettingsProtectionCopy(f.paths.target, host, {
          readAt: 1,
          values: copy,
        })
      else {
        // A set belonging only to the peer must not recover the acting host.
        await writeSettingsProtectionCopy(
          f.paths.target,
          host === 'pi' ? 'opencode' : 'pi',
          { readAt: 1, values: copy },
        )
        if (rung === 3) await writeFile(f.paths.own.account, '{')
      }
      const result = await f.write()
      expect(f.writes).toEqual([])
      if (rung === 3) {
        expect(result).toMatchObject({
          outcome: 'refused',
          reason: refusedSettingsRecreationText(f.paths.target),
        })
        await absent(f.paths.target)
      } else {
        expect(result.outcome).toBe('saved')
        const file = await contents(f.paths.target)
        expect(file.dump_enabled).toBe(host === 'opencode' ? true : undefined)
        expect(file.killswitch_enabled).toBe(rung === 1)
        expect(file.max_same_account_wait).toBe(rung === 1 ? 'cache' : 'off')
        expect(file.quota_fail_closed_on_unknown_quota).toBe('on')
        if (rung === 1) {
          expect(file.killswitch_account_floors).toEqual(
            copy.killswitch_account_floors,
          )
          expect(
            result.differing.filter(
              (entry) => entry.key === 'killswitch_enabled',
            ),
          ).toEqual([{ key: 'killswitch_enabled', legacy: false, file: true }])
        }
        expect(await readFile(f.paths.marker, 'utf8')).toBe('marker')
      }
    })
  }
}

test('setup writes every explicitly held moved field in schema form without store-held data', async () => {
  const f = await fixture('opencode', {
    ...legacy,
    relay: { enabled: false, generation: 3 },
    mainAccountId: 'private',
    nativeAccountOrder: ['private'],
  })
  await writeFile(f.paths.target, '// keep\n{ "unknown": "keep" }')
  expect((await f.write()).outcome).toBe('saved')
  const file = await contents(f.paths.target)
  expect(
    Object.keys(file)
      .filter((key) => key !== 'unknown')
      .sort(),
  ).toEqual(Object.keys(settingsDefinition.settings).sort())
  expect(file).toMatchObject({
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
    quota_minimum_remaining_scoped: 0,
    quota_fail_closed_on_unknown_quota: 'on',
    quota_show_toasts: true,
    quota_header_feed_enabled: true,
    killswitch_enabled: true,
    killswitch_default_five_hour: 9,
    killswitch_default_seven_day: 21,
    killswitch_default_scoped: 0,
    killswitch_account_floors: [
      {
        account: 'row-42',
        host: 'opencode',
        five_hour: 7,
        seven_day: 18,
        scoped: 0,
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
    unknown: 'keep',
  })
  expect(f.writes).toEqual([])
})

const floor = (
  account: string,
  host: 'opencode' | 'pi' | 'both',
  amount = 5,
) => ({ account, host, five_hour: amount, seven_day: 10, scoped: 0 })

test('OpenCode then Pi appends missing host floors without overlap and preserves existing values and order', async () => {
  const f = await fixture('opencode', {
    killswitch: { accounts: { same: { five_hour: 9 } } },
  })
  await writeFile(f.paths.target, '{}')
  expect((await f.write()).outcome).toBe('saved')
  const first = (await contents(f.paths.target)).killswitch_account_floors
  expect(first).toEqual([floor('same', 'opencode', 9)])
  const pi = {
    ...f.options,
    host: 'pi' as const,
    settings: {
      killswitch: {
        accounts: { same: { five_hour: 11 }, extra: { five_hour: 13 } },
      },
    },
  }
  expect((await writeNativeSetupSettings(pi)).outcome).toBe('saved')
  const appended = (await contents(f.paths.target)).killswitch_account_floors
  expect(appended).toEqual([
    ...first,
    floor('same', 'pi', 11),
    floor('extra', 'pi', 13),
  ])
  const bytes = await readFile(f.paths.target, 'utf8')
  expect((await writeNativeSetupSettings(pi)).differing).toEqual([])
  expect(await readFile(f.paths.target, 'utf8')).toBe(bytes)
})

for (const tag of ['both', 'pi'] as const) {
  test(`an existing ${tag} floor is never changed, retagged or overlapped`, async () => {
    const f = await fixture('pi', {
      killswitch: {
        accounts: { same: { five_hour: 9 }, extra: { five_hour: 13 } },
      },
    })
    const existing = [
      floor('unrelated', 'pi', 17),
      floor('same', tag, 2),
      floor('peer', 'opencode', 23),
    ]
    await writeFile(
      f.paths.target,
      `// outside\n{ "killswitch_account_floors": ${JSON.stringify(existing)} }`,
    )
    const result = await f.write()
    expect(result.differing).toEqual([
      {
        key: 'killswitch_account_floors',
        account: 'same',
        legacy: { five_hour: 9, seven_day: 10, scoped: 0 },
        file: { five_hour: 2, seven_day: 10, scoped: 0 },
      },
    ])
    expect((await contents(f.paths.target)).killswitch_account_floors).toEqual([
      ...existing,
      floor('extra', 'pi', 13),
    ])
    expect(f.messages).toHaveLength(1)
    expect(await readFile(f.paths.target, 'utf8')).toContain('// outside')
  })
}

test('invalid existing floor lists refuse appends rather than normalizing existing entries', async () => {
  const f = await fixture('pi', {
    killswitch: { accounts: { missing: { five_hour: 9 } } },
  })
  const text = JSON.stringify({
    killswitch_account_floors: [floor('same', 'both'), floor('same', 'pi')],
  })
  await writeFile(f.paths.target, text)
  expect((await f.write()).outcome).toBe('refused')
  expect(await readFile(f.paths.target, 'utf8')).toBe(text)
  expect(f.writes).toEqual([])
})

test('split keeps relay/custody/ordering fields out of the deferred moved settings', () => {
  const held = {
    relay: { enabled: true, token: 'private', generation: 4 },
    mainAccountId: 'main',
    nativeAccountOrder: ['main'],
    claustrum: { enabled: true },
  }
  const split = splitNativeMigrationSettings({ ...legacy, ...held })
  expect(split.moved).toEqual(legacy)
  expect(split.retained).toEqual(held)
})

test('a projected settings record can never reach a legacy setup store writer', async () => {
  const f = await fixture()
  await writeFile(
    f.paths.target,
    '{ "quota_enabled": "off", "claude_cache_enabled": "off" }',
  )
  const service = await openSettingsService({
    file: f.paths.target,
    host: 'opencode',
  })
  if (!service) throw new Error('no service')
  const projected = resolveSettingsRecord({}, service.snapshot(), 'opencode')
  await service.dispose()
  await rm(f.paths.target)
  expect(
    (await writeNativeSetupSettings({ ...f.options, settings: projected }))
      .outcome,
  ).toBe('failed')
  expect(f.writes).toEqual([])
  await absent(f.paths.target)
})

test('a marker write failure never falls back to the legacy store or edits the user file', async () => {
  const f = await fixture()
  await writeFile(f.paths.target, '{}')
  const result = await writeNativeSetupSettings({
    ...f.options,
    authority: {
      fs: {
        writeMarker: async () => {
          throw new Error('private')
        },
      },
    },
  })
  expect(result.outcome).toBe('failed')
  expect(result.reason).not.toContain('private')
  expect(await readFile(f.paths.target, 'utf8')).toBe('{}')
  expect(f.writes).toEqual([])
})

for (const text of ['', '\uFEFF \n']) {
  test(`a parsed empty settings file accepts setup floors (BOM=${Boolean(text)})`, async () => {
    const f = await fixture('pi', {
      killswitch: { accounts: { new: { five_hour: 8 } } },
    })
    await writeFile(f.paths.target, text)
    expect((await f.write()).outcome).toBe('saved')
    expect((await contents(f.paths.target)).killswitch_account_floors).toEqual([
      floor('new', 'pi', 8),
    ])
    expect(f.writes).toEqual([])
  })
}

test('recreation compares only imported account floors, ignoring host tags and extra carried accounts', async () => {
  const f = await fixture('pi', {
    killswitch: {
      accounts: { 'vault:shared': { five_hour: 8 }, missing: { five_hour: 4 } },
    },
  })
  await writeFile(f.paths.marker, 'marker')
  const carried = legacySettingsProtection(
    {
      killswitch: {
        accounts: {
          'vault:shared': { five_hour: 8 },
          extra: { five_hour: 12 },
        },
      },
    },
    'pi',
    'claustrum',
  )
  await writeSettingsProtectionCopy(f.paths.target, 'pi', {
    readAt: 1,
    values: carried,
  })
  const result = await f.write()
  expect(result.outcome).toBe('saved')
  expect(result.differing).toEqual([
    {
      key: 'killswitch_account_floors',
      account: 'missing',
      legacy: { five_hour: 4, seven_day: 10, scoped: 0 },
      file: undefined,
    },
  ])
  expect((await contents(f.paths.target)).killswitch_account_floors).toEqual([
    floor('vault:shared', 'both', 8),
    floor('extra', 'pi', 12),
  ])
  expect(f.messages).toHaveLength(1)
})

test('a separate install keeps legacy writes even with a malformed shared file and marker', async () => {
  const f = await fixture('pi', legacy)
  await writeFile(f.paths.target, '{')
  await writeFile(f.paths.marker, 'marker')
  expect(
    await writeNativeSetupSettings({
      ...f.options,
      paths: { ...f.paths, separate: true },
    }),
  ).toMatchObject({ target: 'legacy-store', outcome: 'saved' })
  expect(f.writes).toEqual([legacy])
  expect(await readFile(f.paths.target, 'utf8')).toBe('{')
})

test('Pi setup reports absent protection and dump keys without changing OpenCode values', async () => {
  const f = await fixture('pi', {
    killswitch: { main: { five_hour: 0 } },
    dump: { enabled: true },
  })
  const text = '// OpenCode settings\n{ "unknown": "keep" }\n'
  await writeFile(f.paths.target, text)
  const service = await openSettingsService({
    file: f.paths.target,
    host: 'opencode',
  })
  if (!service) throw new Error('no service')
  try {
    const before = service.resolve('opencode')
    expect(before.killswitch_default_five_hour).toBe(5)
    expect(before.dump_enabled).toBe(false)
    const result = await f.write()
    await service.refresh()
    expect(service.resolve('opencode').killswitch_default_five_hour).toBe(5)
    expect(service.resolve('opencode').dump_enabled).toBe(false)
    expect(result.outcome).toBe('saved')
    expect(result.skipped.sort()).toEqual([
      'dump_enabled',
      'killswitch_default_five_hour',
      'killswitch_default_scoped',
      'killswitch_default_seven_day',
    ])
    expect(
      result.differing.find(
        (entry) => entry.key === 'killswitch_default_five_hour',
      ),
    ).toEqual({
      key: 'killswitch_default_five_hour',
      legacy: 0,
      file: 5,
      note: "Pi's value was not imported because the settings file had no Pi entry for it.",
    })
    expect(
      result.differing.find((entry) => entry.key === 'dump_enabled'),
    ).toEqual({
      key: 'dump_enabled',
      legacy: true,
      file: false,
      note: "Pi's value was not imported because the settings file had no Pi entry for it.",
    })
    // Even a legacy value equal to the schema default must be reported if skipped.
    expect(
      result.differing.find(
        (entry) => entry.key === 'killswitch_default_scoped',
      ),
    ).toMatchObject({
      legacy: 0,
      file: 0,
      note: "Pi's value was not imported because the settings file had no Pi entry for it.",
    })
    expect(f.messages).toHaveLength(4)
    expect(f.writes).toEqual([])
    expect(await readFile(f.paths.target, 'utf8')).toBe(text)
    await service.refresh()
    expect(service.resolve('opencode')).toEqual(before)
  } finally {
    await service.dispose()
  }
})
