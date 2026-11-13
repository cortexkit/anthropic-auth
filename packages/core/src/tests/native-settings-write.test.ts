import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openSettings,
  SettingsRefusal,
  type SettingsRefusalCode,
} from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import { createNativeAccountRuntime } from '../native-account-runtime.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { nativeCacheKeepAlways } from '../native-settings.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import {
  invalidSettingsWriteText,
  refusedSettingsWriteText,
  SETTINGS_WRITE_FAILURES,
  settingsDefinition,
} from '../settings-definition.ts'
import type { SettingsMode } from '../settings-mode.ts'
import { legacySettingsProtection } from '../settings-protection-legacy.ts'
import { openSettingsService } from '../settings-service.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  __setLogTestSink(null)
  setLogLevel('info')
})

async function fixture(
  source: string | null = '{}',
  options: {
    host?: 'opencode' | 'pi'
    mode?: SettingsMode
    refusal?: SettingsRefusalCode
    legacy?: Record<string, unknown>
    windowDefault?: { start_hour: number; end_hour: number }[]
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'native-settings-write-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.jsonc')
  if (source !== null) await writeFile(file, source)
  const paths = await resolveNativePoolPaths(join(root, 'accounts.json'))
  await initializeNativeTestAuthority(paths)
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  cleanup.push(() => store.close())
  await store.initialize()
  if (options.legacy)
    await store.updateSettings((settings) => ({
      ...settings,
      ...options.legacy,
    }))
  const calls: unknown[] = []
  const service = await openSettingsService({
    file,
    host: options.host ?? 'opencode',
    dependencies: {
      open: (config) => {
        const handle = openSettings(
          {
            ...settingsDefinition,
            settings: {
              ...settingsDefinition.settings,
              cache_keep_window: {
                ...settingsDefinition.settings.cache_keep_window,
                default:
                  options.windowDefault ??
                  settingsDefinition.settings.cache_keep_window.default,
              },
            },
          },
          config,
        )
        return {
          ...handle,
          watch: () => () => {},
          update: async (edits, context) => {
            calls.push({ edits, context })
            if (options.refusal)
              throw new SettingsRefusal(
                options.refusal,
                'dependency-private-file-contents',
              )
            return handle.update(edits, context)
          },
        }
      },
    },
    protection: {
      readLegacyProtection: async () =>
        legacySettingsProtection(
          options.legacy ?? {},
          options.host ?? 'opencode',
        ),
    },
  })
  if (!service) throw new Error('Settings service unavailable')
  cleanup.push(() => service.dispose())
  let failStore = false
  const runtime = createNativeAccountRuntime({
    paths,
    beforePoolWrite: async () => {
      if (failStore) throw new Error('synthetic store failure')
    },
    host: options.host ?? 'opencode',
    settingsService: service,
    settingsMode: () => options.mode ?? 'user-file',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          root,
          'enrollment.json',
        ),
        PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          root,
          'pi-enrollment.json',
        ),
      },
    },
  })
  cleanup.push(() => runtime.close())
  return {
    root,
    file,
    paths,
    failStore: () => {
      failStore = true
    },
    runtime,
    store,
    calls,
    service,
    text: () => readFile(file, 'utf8'),
    saved: async () => {
      const read = await store.readSettings()
      if (read.status !== 'ready') throw new Error('Store unavailable')
      return read.settings
    },
  }
}

test('menu writes only cache_keep_subagents and preserves real JSONC comments, order and unknown keys', async () => {
  const source =
    '{\n  // user comment\n  "schema_version": 1,\n  "unknown": { "keep": 42 },\n  "dump_enabled": false // keep the tail\n}\n'
  const f = await fixture(source)
  const result = await f.runtime.updateSettings((settings) => {
    settings.cacheKeep = { ...(settings.cacheKeep as object), subagents: true }
  })
  expect(result.outcome).toBe('saved')
  expect(result.settings.cacheKeep).toMatchObject({ subagents: true })
  const text = await f.text()
  expect(text).toContain('// user comment')
  expect(text).toContain('// keep the tail')
  expect(Object.keys(parse(text))).toEqual([
    'schema_version',
    'unknown',
    'dump_enabled',
    'cache_keep_subagents',
  ])
  expect(parse(text).unknown).toEqual({ keep: 42 })
  expect(f.calls).toEqual([
    {
      edits: [{ setting: 'cache_keep_subagents', value: true }],
      context: { host: 'opencode' },
    },
  ])
  expect(await f.runtime.getSettingsPath()).toBe(f.file)
})

test('flat writes use the deciding host entry or override default, never a model entry, in one edit', async () => {
  const f = await fixture(
    `{
    // settings order matters
    "claude_fast_enabled": {"default": false, "pi": true, "claude-opus-5-5": true},
    "claude_cache_mode": {"default":"explicit", "claude-opus-5-5":"hybrid"},
    "untouched": 7
  }`,
    { host: 'pi' },
  )
  const result = await f.runtime.updateSettings((settings) => {
    expect(settings.claudeFast).toMatchObject({ enabled: true })
    expect(settings.claudeCache).toMatchObject({ mode: 'explicit' })
    settings.claudeFast = { enabled: false }
    settings.claudeCache = {
      ...(settings.claudeCache as object),
      mode: 'automatic',
    }
  })
  expect(result.outcome).toBe('saved')
  expect(f.calls).toHaveLength(1)
  expect(parse(await f.text())).toEqual({
    claude_fast_enabled: { default: false, pi: false, 'claude-opus-5-5': true },
    claude_cache_mode: { default: 'automatic', 'claude-opus-5-5': 'hybrid' },
    untouched: 7,
  })
  expect(await f.text()).toContain('// settings order matters')
})

for (const [choice, expected] of [
  ['0', 'off'],
  ['15', '15m'],
  ['max', 'cache'],
] as const) {
  test(`same-account menu choice ${choice} writes ${expected}`, async () => {
    const f = await fixture('{"max_same_account_wait":"off"}')
    await f.runtime.updateSettings((settings) => {
      settings.routing = {
        ...(settings.routing as object),
        maxSameAccountWait: choice,
      }
    })
    expect(parse(await f.text()).max_same_account_wait).toBe(expected)
    expect(f.calls).toHaveLength(choice === '0' ? 0 : 1)
  })
}

for (const [key, section] of [
  ['claude_cache_enabled', 'claudeCache'],
  ['quota_enabled', 'quota'],
] as const) {
  for (const [value, writes] of [
    ['on', 0],
    ['default', 1],
  ] as const) {
    test(`${section} boolean true over ${value} makes ${writes} writes`, async () => {
      const f = await fixture(JSON.stringify({ [key]: value }))
      const result = await f.runtime.updateSettings((settings) => {
        settings[section] = { ...(settings[section] as object), enabled: true }
      })
      expect(result.outcome).toBe('saved')
      expect(f.calls).toHaveLength(writes)
      expect(parse(await f.text())[key]).toBe('on')
    })
  }
}

test('partial Pi main thresholds complete scoped with zero before comparison and write only changed scalars', async () => {
  const f = await fixture(
    '{"killswitch_default_scoped":{"default":4,"pi":8}}',
    { host: 'pi' },
  )
  const result = await f.runtime.updateSettings((settings) => {
    expect(settings.killswitch).toMatchObject({
      main: { five_hour: 5, seven_day: 10, scoped: 8 },
    })
    settings.killswitch = {
      ...(settings.killswitch as object),
      main: { five_hour: 3, seven_day: 8 },
    }
  })
  expect(result.outcome).toBe('saved')
  expect(result.settings.killswitch).toMatchObject({
    main: { five_hour: 3, seven_day: 8, scoped: 0 },
  })
  expect(parse(await f.text())).toEqual({
    killswitch_default_scoped: { default: 4, pi: 0 },
    killswitch_default_five_hour: 3,
    killswitch_default_seven_day: 8,
  })
  expect(f.calls).toHaveLength(1)
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} account floor edits split both and preserve every other host and mode in the list`, async () => {
    const both = {
      account: 'vault:shared',
      host: 'both',
      five_hour: 20,
      seven_day: 30,
      scoped: 4,
    }
    const own = {
      account: 'local',
      host,
      five_hour: 11,
      seven_day: 22,
      scoped: 3,
    }
    const otherHost = host === 'pi' ? 'opencode' : 'pi'
    const others = [
      {
        account: 'local',
        host: otherHost,
        five_hour: 40,
        seven_day: 50,
        scoped: 6,
      },
      {
        account: 'vault:other-mode',
        host,
        five_hour: 7,
        seven_day: 8,
        scoped: 9,
      },
    ]
    const f = await fixture(
      `{
      // outside list stays
      "killswitch_account_floors": [
        // inside list is replaced
        ${[both, own, ...others].map((entry) => JSON.stringify(entry)).join(',\n')}
      ],
      "untouched": {"value":42} // outside tail stays
    }`,
      { host },
    )
    const result = await f.runtime.updateSettings((settings) => {
      const killswitch = settings.killswitch as {
        accounts: Record<string, unknown>
      }
      expect(killswitch.accounts['vault:shared']).toEqual({
        five_hour: 20,
        seven_day: 30,
        scoped: 4,
      })
      killswitch.accounts['vault:shared'] = { five_hour: 5, seven_day: 6 }
      killswitch.accounts.local = { five_hour: 1, seven_day: 2 }
      killswitch.accounts.new = { five_hour: 3, seven_day: 4 }
    })
    expect(result.outcome).toBe('saved')
    const text = await f.text()
    expect(text).toContain('// outside list stays')
    expect(text).toContain('// outside tail stays')
    expect(text).not.toContain('// inside list is replaced')
    const saved = parse(text)
    expect(saved.untouched).toEqual({ value: 42 })
    expect(saved.killswitch_account_floors).toEqual([
      ...(['opencode', 'pi'] as const).map((target) =>
        target === host
          ? {
              account: both.account,
              host,
              five_hour: 5,
              seven_day: 6,
              scoped: 0,
            }
          : { ...both, host: target },
      ),
      { account: 'local', host, five_hour: 1, seven_day: 2, scoped: 0 },
      ...others,
      { account: 'new', host, five_hour: 3, seven_day: 4, scoped: 0 },
    ])
    expect(f.calls).toHaveLength(1)
    expect(result.settings.killswitch).toMatchObject({
      accounts: {
        'vault:shared': { five_hour: 5, seven_day: 6, scoped: 0 },
        local: { five_hour: 1, seven_day: 2, scoped: 0 },
        new: { five_hour: 3, seven_day: 4, scoped: 0 },
      },
    })
  })

  test(`${host} removing account floors splits both before removing only the acting host`, async () => {
    const both = {
      account: 'shared',
      host: 'both',
      five_hour: 12,
      seven_day: 13,
      scoped: 14,
    }
    const own = {
      account: 'local',
      host,
      five_hour: 2,
      seven_day: 3,
      scoped: 4,
    }
    const f = await fixture(
      JSON.stringify({ killswitch_account_floors: [both, own] }),
      { host },
    )
    const result = await f.runtime.updateSettings((settings) => {
      const killswitch = settings.killswitch as {
        accounts: Record<string, unknown>
      }
      delete killswitch.accounts.shared
      delete killswitch.accounts.local
    })
    expect(result.outcome).toBe('saved')
    expect(parse(await f.text()).killswitch_account_floors).toEqual([
      { ...both, host: host === 'pi' ? 'opencode' : 'pi' },
    ])
    expect(result.settings.killswitch).toMatchObject({ accounts: {} })
  })
}

for (const [source, expected, writes] of [
  ['{"dump_enabled":true,"untouched":4}', { untouched: 4 }, 1],
  ['{"dump_enabled":{"pi":true},"untouched":4}', { untouched: 4 }, 1],
  [
    '{"dump_enabled":{"default":true,"opencode":false},"untouched":4}',
    { dump_enabled: { opencode: false }, untouched: 4 },
    1,
  ],
  [
    '{"dump_enabled":{"opencode":true},"untouched":4}',
    { dump_enabled: { opencode: true }, untouched: 4 },
    0,
  ],
  ['{"untouched":4}', { untouched: 4 }, 0],
] as const) {
  test(`Pi removes a leaf only where the user file gives it a value: ${source}`, async () => {
    const f = await fixture(source, { host: 'pi' })
    const result = await f.runtime.updateSettings((settings) => {
      delete settings.dump
    })
    expect(result.outcome).toBe('saved')
    expect(parse(await f.text())).toEqual(expected)
    expect(f.calls).toHaveLength(writes)
  })
}

test('removing a leaf after the file disappeared during save grace writes nothing', async () => {
  const f = await fixture('{"dump_enabled":{"default":false,"opencode":true}}')
  await rm(f.file)
  const result = await f.runtime.updateSettings((settings) => {
    delete settings.dump
  })
  expect(result.outcome).toBe('saved')
  expect(f.calls).toHaveLength(0)
  await expect(f.text()).rejects.toThrow()
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} removing a host leaf with a top-level fallback refuses the whole file and store transaction`, async () => {
    const source = `{\n // keep all bytes\n "dump_enabled":{"default":false,"${host}":true}}`
    const f = await fixture(source, {
      host,
      legacy: { nativeAccountOrder: ['a'] },
    })
    const stored = await f.saved()
    const result = await f.runtime.updateSettings((settings) => {
      delete settings.dump
      settings.prime = { enabled: true }
      settings.nativeAccountOrder = ['b', 'a']
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: refusedSettingsWriteText('dump_enabled', f.file),
    })
    expect(await f.text()).toBe(source)
    expect(await f.saved()).toEqual(stored)
    expect(f.calls).toHaveLength(0)
  })
}

test('nativeCacheKeepAlways deletes the deciding window, not the other host window', async () => {
  const f = await fixture(
    '{"cache_keep_window":{"opencode":[{"start_hour":1,"end_hour":2}],"pi":[{"start_hour":3,"end_hour":4}]}}',
  )
  const result = await f.runtime.updateSettings(nativeCacheKeepAlways)
  expect(result.outcome).toBe('saved')
  expect(parse(await f.text())).toEqual({
    cache_keep_window: { pi: [{ start_hour: 3, end_hour: 4 }] },
    cache_keep_enabled: true,
    cache_keep_always: true,
  })
})

test('nativeCacheKeepAlways with no file window saves even when the declared default supplies a window', async () => {
  const f = await fixture('{}', {
    windowDefault: [{ start_hour: 5, end_hour: 6 }],
  })
  const result = await f.runtime.updateSettings((settings) => {
    expect(settings.cacheKeep).toMatchObject({ startHour: 5, endHour: 6 })
    return nativeCacheKeepAlways(settings)
  })
  expect(result.outcome).toBe('saved')
  expect(parse(await f.text())).toEqual({
    cache_keep_enabled: true,
    cache_keep_always: true,
  })
  expect(f.calls).toHaveLength(1)
})

test('an invalid setting elsewhere does not prevent an account list write and stays unchanged', async () => {
  const source =
    '{\n // keep invalid for the user\n "refresh_interval_minutes":"bad", "unknown":42}'
  const f = await fixture(source)
  const result = await f.runtime.updateSettings((settings) => {
    const killswitch = settings.killswitch as {
      accounts: Record<string, unknown>
    }
    killswitch.accounts.new = { five_hour: 3, seven_day: 4 }
  })
  expect(result.outcome).toBe('saved')
  expect(parse(await f.text())).toEqual({
    refresh_interval_minutes: 'bad',
    unknown: 42,
    killswitch_account_floors: [
      {
        account: 'new',
        host: 'opencode',
        five_hour: 3,
        seven_day: 4,
        scoped: 0,
      },
    ],
  })
  expect(await f.text()).toContain('// keep invalid for the user')
})

const validFloor = {
  account: 'other',
  host: 'pi',
  five_hour: 7,
  seven_day: 8,
  scoped: 9,
}
for (const [label, entries] of [
  ['out of range', [{ ...validFloor, five_hour: 101 }]],
  [
    'missing key',
    [{ account: 'other', host: 'pi', five_hour: 7, seven_day: 8 }],
  ],
  ['unknown key', [{ ...validFloor, extra: 1 }]],
  ['legacy alias', [{ ...validFloor, '5h': 7 }]],
  ['overlap both first', [{ ...validFloor, host: 'both' }, validFloor]],
  ['overlap both last', [validFloor, { ...validFloor, host: 'both' }]],
  ['duplicate host', [validFloor, validFloor]],
] as const) {
  test(`an account edit refuses the entire transaction when another entry has ${label}`, async () => {
    const source = JSON.stringify({ killswitch_account_floors: entries })
    const f = await fixture(source, { legacy: { nativeAccountOrder: ['a'] } })
    const stored = await f.saved()
    const result = await f.runtime.updateSettings((settings) => {
      const killswitch = settings.killswitch as {
        accounts: Record<string, unknown>
      }
      killswitch.accounts.new = { five_hour: 3, seven_day: 4 }
      settings.prime = { enabled: true }
      settings.nativeAccountOrder = ['b', 'a']
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: invalidSettingsWriteText('killswitch_account_floors', f.file),
    })
    expect(await f.text()).toBe(source)
    expect(await f.saved()).toEqual(stored)
    expect(f.calls).toHaveLength(0)
  })
}

test('the mutator gets applied ladder protection and returning it unchanged creates no missing file', async () => {
  const f = await fixture(
    '{"killswitch_enabled":true,"killswitch_default_scoped":7}',
  )
  await rm(f.file)
  await f.service.refresh()
  const result = await f.runtime.updateSettings((settings) => settings)
  expect(result.outcome).toBe('saved')
  expect(result.settings.killswitch).toMatchObject({
    enabled: true,
    main: { five_hour: 5, seven_day: 10, scoped: 7 },
  })
  expect(f.calls).toHaveLength(0)
  await expect(f.text()).rejects.toThrow()
})

for (const mode of ['legacy', 'separate'] as const) {
  test(`${mode} menu writes only the legacy record, never a settings projection`, async () => {
    const f = await fixture(null, {
      mode,
      legacy: {
        claudeCache: { enabled: false },
        quota: { enabled: false, failClosedOnUnknownQuota: true },
        unknown: 3,
      },
    })
    const result = await f.runtime.updateSettings((settings) => {
      expect(settings).toMatchObject({
        claudeCache: { enabled: false },
        quota: { enabled: false, failClosedOnUnknownQuota: true },
        unknown: 3,
      })
      expect(settings.killswitch).toBeUndefined()
      settings.dump = { enabled: true }
    })
    expect(result.outcome).toBe('updated')
    expect(await f.saved()).toMatchObject({
      claudeCache: { enabled: false },
      quota: { enabled: false, failClosedOnUnknownQuota: true },
      dump: { enabled: true },
    })
    expect(f.calls).toHaveLength(0)
  })
}

for (const authority of ['file', 'marker'] as const) {
  test(`legacy menu rechecks ${authority} existence before selecting the write target`, async () => {
    const f = await fixture(null, {
      mode: 'legacy',
      legacy: { quota: { enabled: false } },
    })
    if (authority === 'file') await writeFile(f.file, '{"dump_enabled":false}')
    else await writeFile(`${f.file}.moved`, '{}')
    const result = await f.runtime.updateSettings((settings) => {
      settings.dump = { enabled: true }
    })
    expect(result.outcome).toBe('saved')
    expect(parse(await f.text()).dump_enabled).toBe(true)
    expect((await f.saved()).dump).toBeUndefined()
    expect(await f.runtime.getSettingsPath()).toBe(f.file)
  })
}

test('store-only and mixed menu changes never write projected three-way strings to legacy storage', async () => {
  const f = await fixture(
    '{"claude_cache_enabled":"off","quota_enabled":"off","quota_fail_closed_on_unknown_quota":"off"}',
    {
      legacy: {
        claudeCache: { enabled: true },
        quota: { enabled: true, failClosedOnUnknownQuota: true },
        nativeAccountOrder: ['a'],
      },
    },
  )
  const before = await f.saved()
  await f.runtime.updateSettings((settings) => {
    expect(settings.claudeCache).toMatchObject({ enabled: 'off' })
    expect(settings.quota).toMatchObject({
      enabled: 'off',
      failClosedOnUnknownQuota: 'off',
    })
    settings.nativeAccountOrder = ['b', 'a']
  })
  expect(f.calls).toHaveLength(0)
  expect(await f.saved()).toEqual({ ...before, nativeAccountOrder: ['b', 'a'] })
  await f.runtime.updateSettings((settings) => {
    settings.nativeAccountOrder = ['a', 'b']
    settings.dump = { enabled: true }
  })
  const saved = await f.saved()
  expect(saved).toEqual({ ...before, nativeAccountOrder: ['a', 'b'] })
  expect(parse(await f.text()).nativeAccountOrder).toBeUndefined()
  expect(parse(await f.text()).dump_enabled).toBe(true)
  expect(f.calls).toHaveLength(1)
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} a mixed account-floor write never persists the effective record to the legacy store`, async () => {
    const f = await fixture(
      '{"claude_cache_enabled":"off","quota_enabled":"on","quota_fail_closed_on_unknown_quota":"off"}',
      {
        host,
        legacy: {
          nativeAccountOrder: ['a'],
          claudeCache: { enabled: true, mode: 'explicit' },
          quota: { enabled: false, failClosedOnUnknownQuota: true },
          killswitch: { enabled: false, accounts: { old: { five_hour: 50 } } },
          cacheKeep: { enabled: false, startHour: 1, endHour: 2 },
        },
      },
    )
    const legacy = await f.saved()
    const result = await f.runtime.updateSettings((settings) => {
      expect(settings.claudeCache).toMatchObject({ enabled: 'off' })
      expect(settings.quota).toMatchObject({
        enabled: 'on',
        failClosedOnUnknownQuota: 'off',
      })
      const killswitch = settings.killswitch as {
        accounts: Record<string, unknown>
      }
      killswitch.accounts.new = { five_hour: 1, seven_day: 2 }
      settings.nativeAccountOrder = ['b', 'a']
    })
    expect(result.outcome).toBe('saved')
    expect(await f.saved()).toEqual({
      ...legacy,
      nativeAccountOrder: ['b', 'a'],
    })
    expect(parse(await f.text()).killswitch_account_floors).toEqual([
      { account: 'new', host, five_hour: 1, seven_day: 2, scoped: 0 },
    ])
  })
}

test('a refused mixed edit changes neither file nor legacy store', async () => {
  const f = await fixture('{}', {
    refusal: 'settings-busy',
    legacy: { nativeAccountOrder: ['a'] },
  })
  const before = await f.saved()
  const result = await f.runtime.updateSettings((settings) => {
    settings.nativeAccountOrder = ['b', 'a']
    settings.dump = { enabled: true }
  })
  expect(result.outcome).toBe('failed')
  expect(await f.saved()).toEqual(before)
  expect(await f.text()).toBe('{}')
})

test('a store failure after a mixed file commit returns failed and keeps the committed file', async () => {
  const f = await fixture('{}', { legacy: { nativeAccountOrder: ['a'] } })
  f.failStore()
  const result = await f.runtime.updateSettings((settings) => {
    settings.nativeAccountOrder = ['b', 'a']
    settings.dump = { enabled: true }
  })
  expect(result).toMatchObject({
    outcome: 'failed',
    reason: SETTINGS_WRITE_FAILURES['settings-unavailable'].text(f.file),
  })
  expect(result.settings.dump).toEqual({ enabled: true })
  expect((await f.saved()).nativeAccountOrder).toEqual(['a'])
  expect(parse(await f.text()).dump_enabled).toBe(true)
})

test('a no-op on an initially missing file saves without any edit or creation', async () => {
  const f = await fixture(null)
  expect((await f.runtime.updateSettings((settings) => settings)).outcome).toBe(
    'saved',
  )
  expect(f.calls).toHaveLength(0)
  await expect(f.text()).rejects.toThrow()
})

for (const source of [
  '{"dump_enabled":',
  '{"dump_enabled":false,"dump_enabled":true}',
]) {
  test(`malformed or duplicate JSONC refuses a real menu edit without changing bytes: ${source}`, async () => {
    const f = await fixture(source)
    const result = await f.runtime.updateSettings((settings) => {
      settings.prime = { enabled: true }
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      reason: SETTINGS_WRITE_FAILURES['settings-unparseable'].text(f.file),
    })
    expect(await f.text()).toBe(source)
  })
}

for (const source of ['{"dump_enabled":', '{"unknown":{"same":1,"same":2}}']) {
  for (const action of ['account', 'remove', 'store'] as const) {
    test(`malformed or duplicate JSONC refuses ${action} writes before either destination changes: ${source}`, async () => {
      const f = await fixture(source, { legacy: { nativeAccountOrder: ['a'] } })
      const stored = await f.saved()
      const result = await f.runtime.updateSettings((settings) => {
        if (action === 'account') {
          const killswitch = settings.killswitch as {
            accounts: Record<string, unknown>
          }
          killswitch.accounts.new = { five_hour: 1, seven_day: 2 }
        } else if (action === 'remove') delete settings.dump
        else settings.nativeAccountOrder = ['b', 'a']
      })
      expect(result).toMatchObject({
        outcome: 'refused',
        reason: SETTINGS_WRITE_FAILURES['settings-unparseable'].text(f.file),
      })
      expect(await f.text()).toBe(source)
      expect(await f.saved()).toEqual(stored)
      expect(f.calls).toHaveLength(0)
    })
  }
}

for (const field of ['mainAccountId', 'claustrum', 'relay']) {
  test(`user-file mutator cannot change activation field ${field}`, async () => {
    const f = await fixture()
    await expect(
      f.runtime.updateSettings((settings) => {
        settings[field] =
          field === 'mainAccountId'
            ? 'other'
            : field === 'claustrum'
              ? { mode: 'claustrum' }
              : { enabled: true }
      }),
    ).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
    expect(await f.text()).toBe('{}')
  })
}

for (const code of Object.keys(
  SETTINGS_WRITE_FAILURES,
) as SettingsRefusalCode[]) {
  test(`handle refusal ${code} returns its fixed outcome and reason without applying a live log level`, async () => {
    const f = await fixture('{}', { refusal: code })
    setLogLevel('info')
    const result = await f.runtime.setLoggingLevel('trace')
    const failure = SETTINGS_WRITE_FAILURES[code]
    expect(result).toMatchObject({
      outcome: failure.outcome,
      reason: failure.text(f.file),
    })
    expect(JSON.stringify(result)).not.toContain(
      'dependency-private-file-contents',
    )
    expect(getLogLevel()).toBe('info')
    expect(await f.text()).toBe('{}')
  })
}

test('successful user-file killswitch and log-level changes retain their committed logs once', async () => {
  const f = await fixture()
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  f.runtime.applySettingsEffects?.()
  await f.runtime.updateSettings((settings) => {
    settings.killswitch = { ...(settings.killswitch as object), enabled: true }
  })
  expect((await f.runtime.setLoggingLevel('debug')).outcome).toBe('saved')
  expect(getLogLevel()).toBe('debug')
  expect(
    logs.filter((row) => row.message === 'killswitch changed'),
  ).toHaveLength(1)
  expect(
    logs.filter((row) => row.message === 'log level changed'),
  ).toHaveLength(1)
  setLogLevel('info')
  expect((await f.runtime.setLoggingLevel('debug')).outcome).toBe('saved')
  expect(getLogLevel()).toBe('debug')
  expect(f.calls).toHaveLength(2)
})

test('removing a user-file log level restores info, while an unrelated edit leaves an unchanged live level alone', async () => {
  const f = await fixture('{"log_level":"debug"}')
  f.runtime.applySettingsEffects?.()
  expect(getLogLevel()).toBe('debug')
  const result = await f.runtime.updateSettings((settings) => {
    delete settings.logging
  })
  expect(result.outcome).toBe('saved')
  expect(getLogLevel()).toBe('info')
  setLogLevel('trace')
  await f.runtime.updateSettings((settings) => {
    settings.prime = { enabled: true }
  })
  expect(getLogLevel()).toBe('trace')
})
