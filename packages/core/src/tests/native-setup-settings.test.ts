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
import { openSettings } from '@cortexkit/common-auth/settings'
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
import { readPeerLegacySettingsProtection } from '../settings-move-sources.ts'
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
      // The other host's real default store under this home, as setup wires it.
      readPeerLegacyProtection: (peer) =>
        readPeerLegacySettingsProtection({
          host: peer,
          home,
          env: {},
          platform: 'linux',
        }),
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
      test(`${host}: parsed file marker=${marked} invalid protection=${invalid} fills absent values at the host's level`, async () => {
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
        expect((await contents(f.paths.target)).dump_enabled).toEqual(
          host === 'opencode' ? true : { pi: true },
        )
        expect(outcome.differing).toEqual([])
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
    expect(outcome.skipped).toEqual(['dump_enabled', 'prime_enabled'])
    expect(outcome.differing).toEqual([
      { key: 'dump_enabled', legacy: true, file: false },
      { key: 'prime_enabled', legacy: true, file: false },
    ])
    expect(f.messages).toHaveLength(2)
    expect(
      f.messages.every((line) => line.includes('Setup skipped setting')),
    ).toBe(true)
    const file = await contents(f.paths.target)
    expect(file.dump_enabled).toBe(false)
    expect(file.prime_enabled).toEqual({ default: true, [host]: false })
    expect(file.refresh_interval_minutes).toEqual(
      host === 'pi' ? { opencode: 10, pi: 31 } : { pi: 10, default: 31 },
    )
    expect(f.writes).toEqual([])
  })

  for (const rung of [1, 2, 3]) {
    test(`${host}: marker without file on rung ${rung} ${rung !== 3 ? 'recreates and carried protection wins' : 'refuses and writes nothing'}`, async () => {
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
        // The peer's different set is carried at its own host level.
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
        expect(await readFile(f.paths.marker, 'utf8')).toBe('marker')
        return
      }
      if (rung === 2) {
        expect(result.outcome).toBe('saved')
        expect((await contents(f.paths.target)).killswitch_enabled).toEqual({
          default: false,
          [host === 'pi' ? 'opencode' : 'pi']: true,
        })
        return
      }
      // The peer has no applied copy and no legacy store, so it takes the
      // acting host's set.
      expect(result.outcome).toBe('saved')
      const file = await contents(f.paths.target)
      expect(file.dump_enabled).toEqual(
        host === 'opencode' ? true : { pi: true },
      )
      expect(file.killswitch_enabled).toBe(true)
      // The legacy wait "0" protects more than the carried "max", so it is
      // kept at this host's level rather than dropped for the carried set.
      expect(file.max_same_account_wait).toEqual({
        default: 'cache',
        [host]: 'off',
      })
      expect(file.quota_fail_closed_on_unknown_quota).toBe('on')
      expect(file.killswitch_account_floors).toEqual(
        copy.killswitch_account_floors,
      )
      expect(
        result.differing.filter((entry) => entry.key === 'killswitch_enabled'),
      ).toEqual([{ key: 'killswitch_enabled', legacy: false, file: true }])
      expect(await readFile(f.paths.marker, 'utf8')).toBe('marker')
    })
  }

  test(`${host}: marker without file recreates when the peer's copy holds the same set`, async () => {
    const f = await fixture(host, legacy)
    await writeFile(f.paths.marker, 'marker')
    const peer = host === 'pi' ? 'opencode' : 'pi'
    const own = legacySettingsProtection(legacy, host)
    for (const [copyHost, values] of [
      [host, own],
      // Same values; its local floors are tagged with the peer itself.
      [peer, legacySettingsProtection(legacy, peer)],
    ] as const)
      await writeSettingsProtectionCopy(f.paths.target, copyHost, {
        readAt: 1,
        values,
      })
    const result = await f.write()
    expect(result.outcome).toBe('saved')
    const file = await contents(f.paths.target)
    expect(file.killswitch_enabled).toBe(true)
    expect(file.max_same_account_wait).toBe('cache')
  })
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

// Floors a host stored while its killswitch was off held no account back.
// When the file has the killswitch on for any host, filling them would make
// them live: OpenCode writes the default level, which Pi inherits here.
test('setup does not fill floors or account rows stored with the killswitch off when the file has it on', async () => {
  const f = await fixture('opencode', {
    killswitch: {
      main: { five_hour: 50, seven_day: 50 },
      accounts: { 'row-1': { five_hour: 60 } },
    },
  })
  await writeFile(f.paths.target, '{ "killswitch_enabled": { "pi": true } }')
  const result = await f.write()
  expect(result.outcome).toBe('saved')
  const file = await contents(f.paths.target)
  expect(file).toEqual({ killswitch_enabled: { pi: true } })
  expect(result.skipped).toEqual(
    expect.arrayContaining([
      'killswitch_default_five_hour',
      'killswitch_default_seven_day',
      'killswitch_account_floors',
    ]),
  )
  const service = await openSettingsService({ file: f.paths.target })
  try {
    expect(service?.resolve('pi')).toMatchObject({
      killswitch_enabled: true,
      killswitch_default_five_hour: 5,
      killswitch_default_seven_day: 10,
    })
  } finally {
    await service?.dispose()
  }
})

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

test('Pi setup writes absent keys at level pi without changing OpenCode values', async () => {
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
    expect(result.skipped).toEqual([])
    expect(result.differing).toEqual([])
    expect(f.messages).toHaveLength(0)
    expect(f.writes).toEqual([])
    expect(await readFile(f.paths.target, 'utf8')).toContain(
      '// OpenCode settings',
    )
    expect(await contents(f.paths.target)).toMatchObject({
      unknown: 'keep',
      dump_enabled: { pi: true },
      killswitch_default_five_hour: { pi: 0 },
      killswitch_default_seven_day: { pi: 10 },
      killswitch_default_scoped: { pi: 0 },
    })
    expect(service.resolve('pi')).toMatchObject({
      killswitch_default_five_hour: 0,
      dump_enabled: true,
    })
    await service.refresh()
    expect(service.resolve('opencode')).toEqual(before)
  } finally {
    await service.dispose()
  }
})

test('setup floor appends retain a peer write made before the writer lock', async () => {
  const f = await fixture('pi', {
    killswitch: { accounts: { added: { five_hour: 7 } } },
  })
  const floor = (account: string) => ({
    account,
    host: 'opencode',
    five_hour: 25,
    seven_day: 35,
    scoped: 0,
  })
  await writeFile(
    f.paths.target,
    JSON.stringify({ killswitch_account_floors: [floor('before')] }),
  )
  const service = await openSettingsService({
    file: f.paths.target,
    dependencies: {
      open: (config) => {
        const handle = openSettings(settingsDefinition, config)
        return {
          ...handle,
          update: async (plan, context) => {
            await writeFile(
              f.paths.target,
              JSON.stringify({
                killswitch_account_floors: [
                  floor('before'),
                  floor('concurrent'),
                ],
              }),
            )
            return handle.update(plan, context)
          },
        }
      },
    },
  })
  try {
    expect((await f.write()).outcome).toBe('saved')
    expect((await contents(f.paths.target)).killswitch_account_floors).toEqual([
      floor('before'),
      floor('concurrent'),
      { account: 'added', host: 'pi', five_hour: 7, seven_day: 10, scoped: 0 },
    ])
  } finally {
    await service?.dispose()
  }
})

test('setup keeps stricter legacy protection at its own level over weaker default-level values', async () => {
  // An enabled killswitch with no stored floors protects at 5/10, and an
  // unset unknown-quota policy is Core's fail-closed default.
  const f = await fixture('pi', {
    killswitch: { enabled: true },
    routing: { maxSameAccountWait: '0' },
  })
  await writeFile(
    f.paths.target,
    JSON.stringify({
      killswitch_enabled: false,
      killswitch_default_five_hour: 1,
      // A value of Pi's own is never replaced, even when it is weaker.
      killswitch_default_seven_day: { default: 1, pi: 2 },
      max_same_account_wait: 'cache',
      quota_fail_closed_on_unknown_quota: 'off',
    }),
  )
  const result = await f.write()
  expect(result.outcome).toBe('saved')
  expect(await contents(f.paths.target)).toMatchObject({
    killswitch_enabled: { default: false, pi: true },
    killswitch_default_five_hour: { default: 1, pi: 5 },
    killswitch_default_seven_day: { default: 1, pi: 2 },
    max_same_account_wait: { default: 'cache', pi: 'off' },
    quota_fail_closed_on_unknown_quota: { default: 'off', pi: 'default' },
  })
  expect(f.writes).toEqual([])
})

test('a hand edit made after setup reads the file but before its writer lock survives', async () => {
  const f = await fixture('opencode', {
    quota: { minimumRemaining: { '5h': 10 } },
    dump: { enabled: true },
  })
  await writeFile(f.paths.target, '{}')
  const edited = { quota_minimum_remaining_five_hour: 50, dump_enabled: false }
  // Setup shares this service; its edit runs after the file changes.
  const service = await openSettingsService({
    file: f.paths.target,
    dependencies: {
      open: (config) => {
        const handle = openSettings(settingsDefinition, config)
        return {
          ...handle,
          update: async (plan, context) => {
            await writeFile(f.paths.target, JSON.stringify(edited))
            return handle.update(plan, context)
          },
        }
      },
    },
  })
  try {
    expect((await f.write()).outcome).toBe('saved')
    expect(await contents(f.paths.target)).toMatchObject(edited)
  } finally {
    await service?.dispose()
  }
})

for (const peer of [
  'stricter',
  'unreadable store',
  'unreadable copy',
] as const) {
  test(`setup recreating a missing file with a ${peer} Pi ${peer === 'stricter' ? "keeps Pi's own set" : 'refuses'}`, async () => {
    const f = await fixture('opencode', legacy)
    await writeFile(f.paths.marker, 'marker')
    const store = join(
      dirname(f.paths.defaults.pi.account),
      'anthropic-auth-pool.json',
    )
    await mkdir(dirname(store), { recursive: true })
    if (peer === 'stricter')
      await writeFile(
        store,
        JSON.stringify({
          killswitch: { enabled: true, main: { '5h': 50, '1w': 60 } },
        }),
      )
    if (peer === 'unreadable store') await writeFile(store, '{broken')
    // Pi's copy entry exists but is not a valid set, so its set is unknown;
    // Pi's legacy store would otherwise say it has none.
    if (peer === 'unreadable copy')
      await writeFile(
        `${f.paths.target}.applied.json`,
        JSON.stringify({ pi: { readAt: 1, values: { broken: true } } }),
      )
    const result = await f.write()
    if (peer !== 'stricter') {
      expect(result).toMatchObject({
        outcome: 'refused',
        reason: refusedSettingsRecreationText(f.paths.target),
      })
      await absent(f.paths.target)
      return
    }
    expect(result.outcome).toBe('saved')
    expect(await contents(f.paths.target)).toMatchObject({
      killswitch_default_five_hour: { default: 9, pi: 50 },
      killswitch_default_seven_day: { default: 21, pi: 60 },
    })
  })
}

// Setup's lease uses the file only once setup's own write commits: a file
// setup refused or failed to write must never become this host's applied copy.
test('a refused setup saves no applied copy from the file it never imported', async () => {
  const f = await fixture('opencode', {
    killswitch: { enabled: true, main: { five_hour: 61, seven_day: 61 } },
  })
  // Usable, but its duplicate keys make setup refuse before writing.
  await writeFile(
    f.paths.target,
    '{"killswitch_enabled":false,"dump_enabled":true,"dump_enabled":false}',
  )
  expect((await f.write()).outcome).toBe('refused')
  await absent(`${f.paths.target}.applied.json`)
})

test('a committed setup saves the applied copy of the generation it wrote', async () => {
  const f = await fixture('opencode', {
    killswitch: { enabled: true, main: { five_hour: 61, seven_day: 61 } },
  })
  await writeFile(f.paths.target, '{}')
  expect((await f.write()).outcome).toBe('saved')
  const copy = JSON.parse(
    await readFile(`${f.paths.target}.applied.json`, 'utf8'),
  )
  expect(Object.keys(copy)).toEqual(['opencode'])
  expect(copy.opencode.values).toMatchObject({
    killswitch_enabled: true,
    killswitch_default_five_hour: 61,
    killswitch_default_seven_day: 61,
  })
})

// OpenCode's setup leaves its new native store without the migrated values
// when the file already holds them, so the applied copy is all that keeps
// them until OpenCode imports the file itself.
test('a setup with nothing to write keeps the protection the file already held after the file is deleted', async () => {
  const f = await fixture('opencode', {
    killswitch: { enabled: true, main: { five_hour: 61, seven_day: 61 } },
  })
  const file = JSON.stringify({
    killswitch_enabled: true,
    killswitch_default_five_hour: 61,
    killswitch_default_seven_day: 61,
    killswitch_default_scoped: 0,
  })
  await writeFile(f.paths.target, file)
  expect((await f.write()).outcome).toBe('saved')
  // Setup had no edits to make, and wrote nothing to the legacy store.
  expect(await readFile(f.paths.target, 'utf8')).toBe(file)
  expect(f.writes).toEqual([])
  // The new native store holds no killswitch.
  await writeFile(f.paths.own.account, '{}')
  await rm(f.paths.target)
  // OpenCode starts before it has imported the file.
  const service = await openSettingsService({
    file: f.paths.target,
    host: 'opencode',
    protection: f.options.protection,
    adopted: () => false,
  })
  try {
    expect(service!.snapshot().status).toBe('missing')
    expect(service!.resolve('opencode')).toMatchObject({
      killswitch_enabled: true,
      killswitch_default_five_hour: 61,
      killswitch_default_seven_day: 61,
    })
  } finally {
    await service?.dispose()
  }
})
