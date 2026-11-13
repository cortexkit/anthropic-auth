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
import type { NativeRuntimeSettingsOptions } from '../native-runtime-settings.ts'
import { nativeCacheKeepAlways } from '../native-settings.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import {
  invalidSettingsWriteText,
  refusedSettingsRecreationText,
  refusedSettingsWriteText,
  SETTINGS_WRITE_FAILURES,
  settingsDefinition,
} from '../settings-definition.ts'
import { resolveSettingsMode, type SettingsMode } from '../settings-mode.ts'
import {
  readSettingsProtectionCopy,
  writeSettingsProtectionCopy,
} from '../settings-protection-copy.ts'
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
    unavailableProtection?: boolean
    failCopy?: boolean
    settingsAuthority?: NativeRuntimeSettingsOptions['settingsAuthority']
    pauseLegacy?: () => Promise<void>
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
  const openModes: boolean[] = []
  let watchCallback: (() => void) | undefined
  const service = await openSettingsService({
    file,
    host: options.host ?? 'opencode',
    dependencies: {
      ...(options.failCopy
        ? {
            writeAppliedCopy: async () => {
              throw new Error('synthetic copy failure')
            },
          }
        : {}),
      open: (config) => {
        openModes.push(config.createMissing === true)
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
          watch: (callback) => {
            watchCallback = callback
            return () => {
              watchCallback = undefined
            }
          },
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
        options.unavailableProtection
          ? undefined
          : legacySettingsProtection(
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
      await options.pauseLegacy?.()
    },
    host: options.host ?? 'opencode',
    settingsService: service,
    settingsMode: () => options.mode ?? 'user-file',
    settingsAuthority: options.settingsAuthority,
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
  await runtime.prepareSettingsAction?.()
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
    openModes,
    service,
    notifyWatch: () => watchCallback?.(),
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

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} rung-2 menu recreation carries canonical complete protection before the unrelated edit`, async () => {
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    const f = await fixture(null, {
      host,
      legacy: {
        killswitch: {
          enabled: true,
          main: { '5h': 18, '1w': 28 },
          accounts: {
            local: { '5h': 31 },
            'vault:credential~0123456789': { '1w': 42 },
          },
        },
        quota: {
          minimumRemaining: { '5h': 12 },
          failClosedOnUnknownQuota: true,
        },
        routing: { maxSameAccountWait: '0' },
      },
    })
    expect(f.service.snapshot().protection[host].rung).toBe(2)
    const legacy = await f.saved()
    const result = await f.runtime.updateSettings((settings) => {
      settings.dump = { enabled: true }
    })
    expect(result.outcome).toBe('saved')
    const raw = parse(await f.text())
    expect(raw).toEqual({
      schema_version: 1,
      max_same_account_wait: 'off',
      quota_minimum_remaining_five_hour: 12,
      quota_minimum_remaining_seven_day: 0,
      quota_minimum_remaining_scoped: 0,
      quota_fail_closed_on_unknown_quota: 'on',
      killswitch_enabled: true,
      killswitch_default_five_hour: 18,
      killswitch_default_seven_day: 28,
      killswitch_default_scoped: 0,
      killswitch_account_floors: [
        { account: 'local', host, five_hour: 31, seven_day: 10, scoped: 0 },
        {
          account: 'vault:credential~0123456789',
          host: 'both',
          five_hour: 5,
          seven_day: 42,
          scoped: 0,
        },
      ],
      dump_enabled: true,
    })
    expect(Object.keys(raw).at(-1)).toBe('dump_enabled')
    expect(result.settings.killswitch).toEqual({
      enabled: true,
      main: { five_hour: 18, seven_day: 28, scoped: 0 },
      accounts: {
        local: { five_hour: 31, seven_day: 10, scoped: 0 },
        'vault:credential~0123456789': {
          five_hour: 5,
          seven_day: 42,
          scoped: 0,
        },
      },
    })
    expect(f.calls).toHaveLength(1)
    expect(f.openModes).toEqual([false, true])
    expect(await f.saved()).toEqual(legacy)
    expect(f.runtime.getSettingsStatus?.()).toMatchObject({
      file: { missing: false, recreated: true },
    })
    await f.service.refresh()
    const logs = records.filter((record) =>
      record.message.includes('was recreated'),
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]!.message).toContain('"killswitch_enabled":true')
    expect(logs[0]!.message).toContain('"killswitch_default_five_hour":18')
    expect(logs[0]!.message).toContain('"killswitch_account_floors":[')
  })
}

test('recreation replaces both hosts differing protection with the writer values, including only its account floors', async () => {
  const f = await fixture(
    JSON.stringify({
      killswitch_enabled: { default: false, pi: true },
      killswitch_default_five_hour: { default: 15, pi: 45 },
      quota_minimum_remaining_seven_day: { default: 17, pi: 47 },
      killswitch_account_floors: [
        {
          account: 'local',
          host: 'opencode',
          five_hour: 21,
          seven_day: 22,
          scoped: 0,
        },
        {
          account: 'local',
          host: 'pi',
          five_hour: 51,
          seven_day: 52,
          scoped: 0,
        },
        {
          account: 'vault:shared',
          host: 'opencode',
          five_hour: 23,
          seven_day: 24,
          scoped: 0,
        },
        {
          account: 'vault:shared',
          host: 'pi',
          five_hour: 53,
          seven_day: 54,
          scoped: 0,
        },
      ],
    }),
  )
  const peer = await openSettingsService({ file: f.file, host: 'pi' })
  if (!peer) throw new Error('Peer service unavailable')
  cleanup.push(() => peer.dispose())
  expect(peer.resolve('pi').killswitch_enabled).toBe(true)
  expect(f.service.resolve('opencode').killswitch_enabled).toBe(false)
  await rm(f.file)
  const result = await f.runtime.updateSettings((settings) => {
    settings.dump = { enabled: true }
  })
  expect(result.outcome).toBe('saved')
  for (const host of ['opencode', 'pi'] as const) {
    expect(peer.resolve(host)).toMatchObject({
      killswitch_enabled: false,
      killswitch_default_five_hour: 15,
      quota_minimum_remaining_seven_day: 17,
    })
  }
  expect(parse(await f.text()).killswitch_account_floors).toEqual([
    {
      account: 'local',
      host: 'opencode',
      five_hour: 21,
      seven_day: 22,
      scoped: 0,
    },
    {
      account: 'vault:shared',
      host: 'both',
      five_hour: 23,
      seven_day: 24,
      scoped: 0,
    },
  ])
})

test('rung-3 recreation refuses with the fixed text and commits neither file nor legacy changes', async () => {
  const f = await fixture(null, { unavailableProtection: true })
  expect(f.service.snapshot().protection.opencode.rung).toBe(3)
  const legacy = await f.saved()
  const result = await f.runtime.updateSettings((settings) => {
    settings.dump = { enabled: true }
    settings.nativeAccountOrder = ['b', 'a']
  })
  expect(result).toMatchObject({
    outcome: 'refused',
    reason: refusedSettingsRecreationText(f.file),
  })
  expect(f.calls).toHaveLength(0)
  expect(f.openModes).toEqual([false])
  await expect(f.text()).rejects.toThrow()
  expect(await f.saved()).toEqual(legacy)
})

test('a failed copy write never replaces the applied protection carried by a recreating menu write', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  const f = await fixture(
    '{"killswitch_enabled":true,"killswitch_default_five_hour":39}',
    {
      failCopy: true,
    },
  )
  const old = legacySettingsProtection({}, 'opencode')
  await writeSettingsProtectionCopy(f.file, 'opencode', {
    readAt: 1,
    values: old,
  })
  expect(
    (await readSettingsProtectionCopy(f.file, 'opencode'))?.killswitch_enabled,
  ).toBe(false)
  await rm(f.file)
  const result = await f.runtime.updateSettings((settings) => {
    settings.dump = { enabled: true }
  })
  expect(result.outcome).toBe('saved')
  expect(parse(await f.text())).toMatchObject({
    killswitch_enabled: true,
    killswitch_default_five_hour: 39,
    dump_enabled: true,
  })
  await f.runtime.close()
  await f.service.dispose()
  expect(await readSettingsProtectionCopy(f.file, 'opencode')).toEqual(old)
  expect(
    records.filter((record) =>
      record.message.includes('Could not save applied protection'),
    ),
  ).toHaveLength(1)
})

test('an account-floor menu edit during recreation retains untouched applied accounts', async () => {
  const f = await fixture(null, {
    legacy: {
      killswitch: {
        enabled: true,
        accounts: {
          'vault:changed': { five_hour: 20, seven_day: 30 },
          untouched: { five_hour: 40, seven_day: 50 },
        },
      },
    },
  })
  const result = await f.runtime.updateSettings((settings) => {
    const killswitch = settings.killswitch as {
      accounts: Record<string, unknown>
    }
    killswitch.accounts['vault:changed'] = { five_hour: 25, seven_day: 35 }
  })
  expect(result.outcome).toBe('saved')
  expect(parse(await f.text()).killswitch_account_floors).toEqual([
    {
      account: 'vault:changed',
      host: 'opencode',
      five_hour: 25,
      seven_day: 35,
      scoped: 0,
    },
    {
      account: 'vault:changed',
      host: 'pi',
      five_hour: 20,
      seven_day: 30,
      scoped: 0,
    },
    {
      account: 'untouched',
      host: 'opencode',
      five_hour: 40,
      seven_day: 50,
      scoped: 0,
    },
  ])
})

test('a recreating mixed menu write persists only the legacy record, never its three-way projection', async () => {
  const f = await fixture(null, {
    legacy: {
      claudeCache: { enabled: false },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
      nativeAccountOrder: ['a'],
    },
  })
  const legacy = await f.saved()
  const result = await f.runtime.updateSettings((settings) => {
    expect(settings.claudeCache).toMatchObject({ enabled: 'default' })
    expect(settings.quota).toMatchObject({
      enabled: 'default',
      failClosedOnUnknownQuota: 'off',
    })
    settings.nativeAccountOrder = ['b', 'a']
    settings.dump = { enabled: true }
  })
  expect(result.outcome).toBe('saved')
  expect(await f.saved()).toEqual({ ...legacy, nativeAccountOrder: ['b', 'a'] })
  expect(parse(await f.text()).quota_fail_closed_on_unknown_quota).toBe('off')
})

test('restart after deletion keeps user-file authority, defaults non-protection settings and reports missing once', async () => {
  const f = await fixture(
    '{"dump_enabled":true,"refresh_interval_minutes":33,"killswitch_enabled":true}',
    {
      legacy: { dump: { enabled: true }, refresh: { intervalMinutes: 33 } },
    },
  )
  await writeFile(`${f.file}.moved`, '{}')
  await f.runtime.close()
  await f.service.dispose()
  await rm(f.file)
  expect(await resolveSettingsMode({ target: f.file, separate: false })).toBe(
    'user-file',
  )
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  const service = await openSettingsService({
    file: f.file,
    host: 'opencode',
    protection: {
      readLegacyProtection: async () =>
        legacySettingsProtection({}, 'opencode'),
    },
  })
  if (!service) throw new Error('Restarted service unavailable')
  cleanup.push(() => service.dispose())
  expect(service.resolve('opencode')).toMatchObject({
    dump_enabled: false,
    refresh_interval_minutes: 10,
    killswitch_enabled: true,
  })
  expect(service.snapshot().protection.opencode.rung).toBe(1)
  expect(service.status()).toMatchObject({ missing: true, recreated: false })
  await service.refresh()
  const missing = records.filter((record) =>
    record.message.includes('Settings file is missing'),
  )
  expect(missing).toHaveLength(1)
  expect(missing[0]!.message).toContain('A menu write will recreate it.')
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

for (const noSources of [false, true]) {
  test(`60s authority timer observes a peer move with no watch event, no sources=${noSources}`, async () => {
    const ticks: {
      callback: () => Promise<void>
      delay: number
      cancelled: boolean
    }[] = []
    const f = await fixture(null, {
      mode: 'legacy',
      legacy: { dump: { enabled: false }, prime: { enabled: true } },
      settingsAuthority: {
        schedule: (callback, delay) => {
          const tick = { callback, delay, cancelled: false }
          ticks.push(tick)
          return () => {
            tick.cancelled = true
          }
        },
      },
    })
    expect(ticks).toHaveLength(1)
    expect(ticks[0]!.delay).toBe(60_000)
    const before = await f.saved()
    const { moveSettingsOnce } = await import('@cortexkit/common-auth/settings')
    const { createSettingsMoveSource } = await import(
      '../settings-move-source.ts'
    )
    const { mapSettingsMoveSources } = await import('../settings-move-map.ts')
    const { nativePoolStoreLocks } = await import('../pool-store.ts')
    const { writeSettingsMoveMarker } = await import('../settings-mode.ts')
    const moved = await moveSettingsOnce({
      definition: settingsDefinition,
      target: f.file,
      separateInstall: false,
      sources: noSources
        ? []
        : [
            createSettingsMoveSource({
              host: 'opencode',
              path: f.paths.config,
              locks: [...nativePoolStoreLocks(f.paths)],
            }),
          ],
      map: mapSettingsMoveSources,
      fence: async () => true,
      log: { info: () => {}, warn: () => {} },
    })
    expect(moved.outcome).toBe('moved')
    await writeSettingsMoveMarker(f.file)
    // The service fixture suppresses watch notifications, including file creation.
    expect(
      f.runtime.resolveSettings!({ version: 1, accounts: [], ...before }).prime,
    ).toEqual({ enabled: true })
    await ticks[0]!.callback()
    const resolved = f.runtime.resolveSettings!({
      version: 1,
      accounts: [],
      ...before,
    })
    expect(resolved.prime).toEqual({ enabled: !noSources })
    expect(await f.runtime.getSettingsPath()).toBe(f.file)
    expect(
      (
        await f.runtime.updateSettings((settings) => {
          settings.dump = { enabled: true }
        })
      ).outcome,
    ).toBe('saved')
    expect(await f.saved()).toEqual(before)
    const file = parse(await f.text())
    expect(file.dump_enabled).toBe(true)
    if (noSources)
      expect(Object.keys(file).sort()).toEqual([
        'dump_enabled',
        'schema_version',
      ])
    expect(ticks).toHaveLength(1)
    await rm(f.file)
    await rm(`${f.file}.moved`)
    await f.runtime.prepareSettingsAction?.()
    expect(await f.runtime.getSettingsPath()).toBe(f.file)
  })
}

test('malformed hand-made authority uses legacy protection only and refuses menu writes', async () => {
  const f = await fixture('{broken', {
    mode: 'legacy',
    legacy: {
      dump: { enabled: true },
      prime: { enabled: true },
      killswitch: { enabled: true, main: { '5h': 30, '1w': 40 } },
    },
  })
  await f.runtime.prepareSettingsAction?.()
  const resolved = f.runtime.resolveSettings!({
    version: 1,
    accounts: [],
    ...(await f.saved()),
  })
  expect(resolved.dump).toEqual({ enabled: false })
  expect(resolved.prime).toEqual({ enabled: false })
  expect(resolved.killswitch).toMatchObject({
    enabled: true,
    main: { five_hour: 30, seven_day: 40, scoped: 0 },
  })
  expect(
    (
      await f.runtime.updateSettings((settings) => {
        settings.dump = { enabled: true }
      })
    ).outcome,
  ).toBe('refused')
  expect((await f.saved()).dump).toEqual({ enabled: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

for (const first of ['writer', 'move'] as const) {
  test(`legacy ${first} wins the source locks; no write can land between the move read and publish`, async () => {
    const paused = deferred()
    const release = deferred()
    const checked = deferred()
    let writing = false
    let mutating = false
    const events: string[] = []
    const f = await fixture(null, {
      mode: 'legacy',
      legacy: { dump: { enabled: false } },
      pauseLegacy:
        first === 'writer'
          ? async () => {
              paused.resolve()
              await release.promise
            }
          : undefined,
      settingsAuthority: {
        options: {
          fs: {
            exists: async (path) => {
              const { lstat } = await import('node:fs/promises')
              const present = await lstat(path).then(
                () => true,
                (error) => {
                  if (error.code === 'ENOENT') return false
                  throw error
                },
              )
              if (writing && path.endsWith('.moved')) checked.resolve()
              return present
            },
          },
        },
      },
    })
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    const { moveSettingsOnce } = await import('@cortexkit/common-auth/settings')
    const { createSettingsMoveSource } = await import(
      '../settings-move-source.ts'
    )
    const { mapSettingsMoveSources } = await import('../settings-move-map.ts')
    const { nativePoolStoreLocks } = await import('../pool-store.ts')
    const { writeSettingsMoveMarker } = await import('../settings-mode.ts')
    const { setSettingsMoveStepHookForTest } = await import(
      new URL('move.js', import.meta.resolve('@cortexkit/common-auth/settings'))
        .href
    )
    cleanup.push(() => {
      setSettingsMoveStepHookForTest()
    })
    setSettingsMoveStepHookForTest(async (step: string) => {
      if (step !== 'before-publish') return
      expect(JSON.parse(await readFile(f.paths.config, 'utf8')).dump).toEqual({
        enabled: first === 'writer',
      })
      events.push('read')
      if (first === 'move') {
        paused.resolve()
        await release.promise
        expect(mutating).toBe(false)
      }
      events.push('publish')
    })
    const move = async () => {
      const result = await moveSettingsOnce({
        definition: settingsDefinition,
        target: f.file,
        separateInstall: false,
        sources: [
          createSettingsMoveSource({
            host: 'opencode',
            path: f.paths.config,
            locks: [...nativePoolStoreLocks(f.paths)],
          }),
        ],
        map: mapSettingsMoveSources,
        fence: async () => true,
        log: { info: () => {}, warn: () => {} },
      })
      expect(result.outcome).toBe('moved')
      await writeSettingsMoveMarker(f.file)
    }
    const write = () =>
      f.runtime.updateSettings((settings) => {
        mutating = true
        events.push('write')
        settings.dump = { enabled: true }
      })
    if (first === 'writer') {
      const writer = write()
      await paused.promise
      const mover = move()
      release.resolve()
      expect((await writer).outcome).toBe('updated')
      await mover
      expect(events).toEqual(['write', 'read', 'publish'])
    } else {
      const mover = move()
      await paused.promise
      writing = true
      const writer = write()
      await checked.promise
      expect(mutating).toBe(false)
      release.resolve()
      await mover
      expect((await writer).outcome).toBe('updated')
      expect(events).toEqual(['read', 'publish', 'write'])
    }
    await f.runtime.prepareSettingsAction?.()
    expect(parse(await f.text()).dump_enabled).toBe(first === 'writer')
    expect((await f.saved()).dump).toEqual({ enabled: true })
    expect(
      records.filter((record) => record.message.includes('were not imported')),
    ).toHaveLength(first === 'move' ? 1 : 0)
  })
}

test('every user-file watch callback checks authority even without a new resolved generation', async () => {
  let probes = 0
  let marked = false
  let scheduled = 0
  let cancelled = 0
  const f = await fixture(null, {
    mode: 'legacy',
    legacy: { prime: { enabled: true } },
    settingsAuthority: {
      options: {
        fs: {
          exists: async (path) => {
            probes++
            return marked && path.endsWith('.moved')
          },
        },
      },
      schedule: () => {
        scheduled++
        return () => {
          cancelled++
        }
      },
    },
  })
  const generation = f.service.snapshot().id
  const before = probes
  marked = true
  f.notifyWatch()
  expect(probes).toBeGreaterThan(before)
  await f.runtime.prepareSettingsAction?.()
  expect(f.service.snapshot().id).toBe(generation)
  expect(
    f.runtime.resolveSettings!({ version: 1, accounts: [] }).prime,
  ).toEqual({ enabled: false })
  expect(scheduled).toBe(1)
  expect(cancelled).toBe(1)
  await f.runtime.close()
  expect(cancelled).toBe(1)
})
