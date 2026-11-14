import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  openSettings,
  type SettingsRefusalCode,
} from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import { listNativeMenuActions } from '../../../core/src/native-menu-model'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { initializeNativeTestAuthority } from '../../../core/src/tests/native-authority-fixture'
import { createNativeMenuCapabilities } from '../v2/menu'
import type { NativeSource } from '../v2/source'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

const commented =
  '{\n  // keep the user comment\n  "schema_version": 1,\n  "unknown": { "kept": 42 } // keep the tail\n}\n'
type MenuRequest = Parameters<core.NativeMenuDispatch>[0]

async function fixture(
  options: {
    mode?: 'user-file' | 'legacy' | 'separate'
    source?: string | null
    failWrite?: boolean
    unavailableProtection?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'oc2-settings-menu-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const env = { HOME: root }
  const file = core.getSettingsFilePath({ env })
  await mkdir(dirname(file), { recursive: true })
  if (options.source !== null)
    await writeFile(file, options.source ?? commented)
  const paths = await core.resolveNativePoolPaths(join(root, 'accounts.json'))
  await initializeNativeTestAuthority(paths)
  const store = core.createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.initialize()
  cleanups.push(() => store.close())
  const mode = options.mode ?? 'user-file'
  if (mode !== 'user-file')
    await store.updateSettings((settings) => ({
      ...settings,
      claudeCache: { enabled: false },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
    }))
  const originalStore = await readFile(paths.config, 'utf8')
  const service =
    mode === 'separate'
      ? undefined
      : await core.openSettingsService({
          file,
          host: 'opencode',
          // These menu tests are about a host that uses the file.
          adopted: () => true,
          dependencies: {
            writeAppliedCopy: async () => {},
            open: (config) => {
              const handle = openSettings<
                typeof core.settingsDefinition.settings
              >(core.settingsDefinition, config)
              return {
                ...handle,
                watch: () => () => {},
                update: async (edits, context) => {
                  if (options.failWrite) throw new Error('private detail')
                  return handle.update(edits, context)
                },
              }
            },
          },
          protection: {
            readLegacyProtection: async () =>
              options.unavailableProtection
                ? undefined
                : core.legacySettingsProtection({}, 'opencode'),
            readPeerLegacyProtection: async (host) =>
              options.unavailableProtection
                ? undefined
                : core.legacySettingsProtection({}, host),
          },
        })
  if (service) cleanups.push(() => service.dispose())
  const beforeLevel = core.getLogLevel()
  const beforeDump = core.isDumpEnabled()
  cleanups.push(() => {
    core.setLogLevel(beforeLevel)
    core.setDumpEnabled(beforeDump)
  })
  const runtime = core.createNativeAccountRuntime({
    paths,
    host: 'opencode',
    settingsService: service,
    settingsMode: () => mode,
    vault: {
      env: {
        ...env,
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          root,
          'enrollment',
        ),
      },
    },
  })
  cleanups.push(() => runtime.close())
  const menu = createNativeMenuCapabilities({
    runtime,
    source: {} as NativeSource,
    start: async () => {},
  })
  cleanups.push(() => menu.close())
  return {
    file,
    paths,
    runtime,
    menu,
    service,
    store,
    originalStore,
    apply: (action: MenuRequest['action'], values: unknown = {}) =>
      menu.dispatch(
        {
          action,
          values,
          sessionId: 'settings-menu',
        } as MenuRequest,
        {},
      ),
    text: () => readFile(file, 'utf8'),
    saved: async () => {
      const result = await store.readSettings()
      if (result.status !== 'ready') throw new Error('Store unavailable')
      return result.settings
    },
  }
}

const actions: {
  action: MenuRequest['action']
  values?: unknown
  file: Record<string, unknown>
  legacy: Record<string, unknown>
}[] = [
  {
    action: 'routing-mode',
    values: { mode: 'sticky-balanced' },
    file: { routing_mode: 'sticky-balanced' },
    legacy: { routing: { mode: 'sticky-balanced' } },
  },
  ...([0, 15, 'max'] as const).map((value, index) => ({
    action: 'routing-max-same-account-wait' as const,
    values: { maxSameAccountWait: value },
    file: { max_same_account_wait: ['off', '15m', 'cache'][index] },
    legacy: { routing: { maxSameAccountWait: value } },
  })),
  {
    action: 'killswitch-on',
    file: { killswitch_enabled: true },
    legacy: { killswitch: { enabled: true } },
  },
  {
    action: 'killswitch-off',
    file: { killswitch_enabled: false },
    legacy: { killswitch: { enabled: false } },
  },
  {
    action: 'killswitch-set',
    values: { entries: [{ account: 'main', fh: 7, sd: 12 }] },
    file: { killswitch_default_five_hour: 7, killswitch_default_seven_day: 12 },
    legacy: { killswitch: { main: { five_hour: 7, seven_day: 12 } } },
  },
  {
    action: 'cache-on',
    file: { claude_cache_enabled: 'on' },
    legacy: { claudeCache: { enabled: true } },
  },
  {
    action: 'cache-off',
    file: { claude_cache_enabled: 'off' },
    legacy: { claudeCache: { enabled: false } },
  },
  {
    action: 'cache-mode',
    values: { mode: 'hybrid' },
    file: { claude_cache_mode: 'hybrid' },
    legacy: { claudeCache: { mode: 'hybrid' } },
  },
  {
    action: 'cachekeep-window',
    values: { startHour: 9, endHour: 17 },
    file: {
      cache_keep_enabled: true,
      cache_keep_window: [{ start_hour: 9, end_hour: 17 }],
    },
    legacy: {
      cacheKeep: { enabled: true, always: false, startHour: 9, endHour: 17 },
    },
  },
  {
    action: 'cachekeep-always',
    file: { cache_keep_enabled: true, cache_keep_always: true },
    legacy: { cacheKeep: { enabled: true, always: true } },
  },
  {
    action: 'cachekeep-off',
    file: { cache_keep_enabled: false },
    legacy: { cacheKeep: { enabled: false } },
  },
  {
    action: 'cachekeep-subagents',
    values: { enabled: 'on' },
    file: { cache_keep_subagents: true },
    legacy: { cacheKeep: { subagents: true } },
  },
  {
    action: 'dump-on',
    file: { dump_enabled: true },
    legacy: { dump: { enabled: true } },
  },
  {
    action: 'dump-off',
    file: { dump_enabled: false },
    legacy: { dump: { enabled: false } },
  },
  {
    action: 'logging-level',
    values: { level: 'debug' },
    file: { log_level: 'debug' },
    legacy: { logging: { level: 'debug' } },
  },
  {
    action: 'fast-on',
    file: { claude_fast_enabled: true },
    legacy: { claudeFast: { enabled: true } },
  },
  {
    action: 'fast-off',
    file: { claude_fast_enabled: false },
    legacy: { claudeFast: { enabled: false } },
  },
  {
    action: 'prime-on',
    file: { prime_enabled: true },
    legacy: { prime: { enabled: true } },
  },
  {
    action: 'prime-off',
    file: { prime_enabled: false },
    legacy: { prime: { enabled: false } },
  },
]

for (const mode of ['user-file', 'legacy', 'separate'] as const) {
  for (const section of [
    'routing',
    'killswitch',
    'claudeCache',
    'cacheKeep',
    'dump',
    'logging',
    'claudeFast',
    'prime',
  ]) {
    test(`OC2 ${section} actions write only their ${mode} destination, preserve JSONC and never project into legacy storage`, async () => {
      const f = await fixture({
        mode,
        source: mode === 'legacy' ? null : commented,
      })
      for (const { action, values, file, legacy } of actions) {
        if (!(section in legacy)) continue
        expect(await f.apply(action, values)).toEqual({
          ok: true,
          text: 'Native Claude settings updated.',
        })
        if (mode === 'user-file') {
          expect(parse(await f.text())).toMatchObject(file)
          expect(await readFile(f.paths.config, 'utf8')).toBe(f.originalStore)
        } else {
          expect(await f.saved()).toMatchObject(legacy)
          if (mode === 'separate') expect(await f.text()).toBe(commented)
          else
            expect(await readFile(f.file, 'utf8').catch(() => null)).toBeNull()
          const saved = (await f.saved()) as unknown as core.AccountStorage
          expect(saved.quota).toEqual({
            enabled: false,
            failClosedOnUnknownQuota: false,
          })
          for (const value of [
            saved.claudeCache?.enabled,
            saved.quota?.enabled,
            saved.quota?.failClosedOnUnknownQuota,
          ])
            expect(typeof value).toBe('boolean')
        }
        if (mode === 'user-file') {
          const text = await f.text()
          expect(text).toContain('// keep the user comment')
          expect(text).toContain('// keep the tail')
          expect(parse(text).unknown).toEqual({ kept: 42 })
        }
      }
    })
  }
}

for (const outcome of [
  'saved',
  'updated',
  'unchanged',
  'refused',
  'failed',
] as const) {
  test(`OC2 every settings action treats ${outcome} as ${outcome === 'refused' || outcome === 'failed' ? 'failure' : 'success'}`, async () => {
    const f = await fixture()
    const result = { settings: {}, outcome, reason: 'Fixed settings failure.' }
    const update = spyOn(f.runtime, 'updateSettings').mockResolvedValue(result)
    const logging = spyOn(f.runtime, 'setLoggingLevel').mockResolvedValue(
      result,
    )
    cleanups.push(() => {
      update.mockRestore()
      logging.mockRestore()
    })
    for (const { action, values } of actions) {
      const applied = await f.apply(action, values)
      if (outcome === 'refused' || outcome === 'failed')
        expect(applied).toEqual({ ok: false, text: 'Fixed settings failure.' })
      else
        expect(applied).toEqual({
          ok: true,
          text: 'Native Claude settings updated.',
        })
    }
  })
}

test('OC2 malformed JSONC refuses a write and leaves the dump and live log level unchanged', async () => {
  const source = '{ // keep malformed user bytes\n "dump_enabled": '
  const f = await fixture({ source })
  core.setDumpEnabled(false)
  core.setLogLevel('warn')
  const reason = `Cannot write settings to "${f.file}": the settings file is malformed or contains duplicate keys. Edit the file to fix it before trying again.`
  expect(await f.apply('dump-on')).toEqual({ ok: false, text: reason })
  expect(core.isDumpEnabled()).toBe(false)
  expect(await f.apply('logging-level', { level: 'debug' })).toEqual({
    ok: false,
    text: reason,
  })
  expect(core.getLogLevel()).toBe('warn')
  expect(await f.text()).toBe(source)
})

test('OC2 removing a host window refuses rather than revealing the lower window', async () => {
  const source =
    '{ // preserve both windows\n "cache_keep_window": { "default": [{ "start_hour": 8, "end_hour": 18 }], "opencode": [{ "start_hour": 9, "end_hour": 17 }] } }'
  const f = await fixture({ source })
  expect(await f.apply('cachekeep-always')).toEqual({
    ok: false,
    text: `Cannot remove setting "cache_keep_window" from "${f.file}": a lower level would still supply a value. Edit the settings file to set the value you want.`,
  })
  expect(await f.text()).toBe(source)
})

test('OC2 rung 3 refuses file recreation without success text', async () => {
  const f = await fixture({ source: null, unavailableProtection: true })
  expect(await f.apply('dump-on')).toEqual({
    ok: false,
    text: `Cannot recreate settings file "${f.file}": protection settings are unknown. Edit the settings file to set them before trying again.`,
  })
  expect(await readFile(f.file, 'utf8').catch(() => null)).toBeNull()
})

const refusals: [SettingsRefusalCode, (file: string) => string][] = [
  [
    'settings-unparseable',
    (file) =>
      `Cannot write settings to "${file}": the settings file is malformed or contains duplicate keys. Edit the file to fix it before trying again.`,
  ],
  [
    'settings-newer-version',
    (file) =>
      `Cannot write settings to "${file}": the file uses a newer settings version. Update the plugin or edit the settings file before trying again.`,
  ],
  [
    'settings-invalid-value',
    (file) =>
      `Cannot write settings to "${file}": the requested setting value is invalid. Edit the settings file to set a valid value.`,
  ],
  [
    'settings-busy',
    (file) =>
      `Could not write settings to "${file}": the settings file is busy. Try again after the other settings write finishes.`,
  ],
  [
    'settings-unavailable',
    (file) =>
      `Could not write settings to "${file}": the settings file is unavailable. Check its folder and permissions before trying again.`,
  ],
]
for (const [refusal, reason] of refusals) {
  test(`OC2 displays the fixed reason for ${refusal} without dependency details or success text`, async () => {
    const f = await fixture()
    const failure = core.SETTINGS_WRITE_FAILURES[refusal]
    const update = spyOn(f.runtime, 'updateSettings').mockResolvedValue({
      settings: {},
      outcome: failure.outcome,
      reason: failure.text(f.file),
    })
    cleanups.push(() => update.mockRestore())
    expect(await f.apply('dump-on')).toEqual({
      ok: false,
      text: reason(f.file),
    })
    expect(await f.text()).toBe(commented)
  })
}

test('OC2 a failed file write displays its fixed failure and leaves bytes unchanged', async () => {
  const f = await fixture({ failWrite: true })
  expect(await f.apply('dump-on')).toEqual({
    ok: false,
    text: `Could not write settings to "${f.file}": the settings file is unavailable. Check its folder and permissions before trying again.`,
  })
  expect(await f.text()).toBe(commented)
})

test('OC2 status uses every no-model value and lists model row values and file diagnostics', async () => {
  const f = await fixture({
    source: `{
    // user diagnostics
    "schema_version": 1,
    "claude_cache_enabled": { "default": "off", "claude-opus-5-5": "on", "not-a-row": "on" },
    "claude_cache_mode": { "default": "explicit", "claude-opus-5-5": "hybrid" },
    "claude_fast_enabled": { "default": false, "claude-opus-5-5": true },
    "cache_keep_enabled": { "default": false, "claude-opus-5-5": true },
    "thinking_binding_prefix_mismatch_behavior": { "default": "drop_block", "claude-opus-5-5": "error" },
    "prime_enabled": "invalid",
    "dump_enabled": false,
    "dump_enabled": true
  }`,
  })
  const status = await f.menu.readStatus('cache')
  expect(status).toContain(`Settings file: ${f.file}`)
  expect(status).toContain('Settings (no model):')
  expect(status).toContain('claude_cache_enabled: "off"')
  expect(status).toContain('claude_cache_enabled [claude-opus-5-5]: "on"')
  expect(status).toContain('claude_cache_mode [claude-opus-5-5]: "hybrid"')
  expect(status).toContain('claude_fast_enabled [claude-opus-5-5]: true')
  expect(status).toContain('cache_keep_enabled [claude-opus-5-5]: true')
  expect(status).toContain(
    'thinking_binding_prefix_mismatch_behavior [claude-opus-5-5]: "error"',
  )
  for (const [key, value] of Object.entries(core.settingsDefinition.settings)) {
    expect(status).toContain(`${key}: `)
    if (key === 'prime_enabled')
      expect(status).toContain(
        `prime_enabled: ${JSON.stringify(value.default)}`,
      )
  }
  expect(status).toContain('Invalid setting: prime_enabled')
  expect(status).toContain('Ignored model key: claude_cache_enabled.not-a-row')
  expect(status).toContain('Duplicate setting: dump_enabled')
})

test('OC2 status names a missing file and its recreation by a menu write', async () => {
  const f = await fixture({ source: null })
  const missing = await f.menu.readStatus('routing')
  expect(missing).toContain(`Settings file: ${f.file}`)
  expect(missing).toContain(
    "Settings file is missing; a menu change recreates it when both hosts' protection can be read.",
  )
  expect(await f.apply('dump-on')).toEqual({
    ok: true,
    text: 'Native Claude settings updated.',
  })
  const recreated = await f.menu.readStatus('routing')
  expect(recreated).toContain('Settings file was recreated by a menu write.')
  expect(recreated).not.toContain('Settings file is missing;')
})

test('OC2 longest-wait menu label and string choices write the canonical file values', async () => {
  const f = await fixture()
  expect(
    listNativeMenuActions('opencode').find(
      (action) => action.id === 'routing-max-same-account-wait',
    ),
  ).toMatchObject({ label: 'Longest wait on the same account' })
  const executor = core.createNativeMenuExecutor({
    host: 'opencode',
    dispatch: f.menu.dispatch,
  })
  for (const [choice, expected] of [
    ['0', 'off'],
    ['15', '15m'],
    ['max', 'cache'],
  ] as const) {
    expect(
      await executor.execute(
        {
          action: 'routing-max-same-account-wait',
          values: { maxSameAccountWait: choice },
        },
        { interactive: true, custodyMode: 'local' },
      ),
    ).toMatchObject({ status: 'executed', ok: true })
    expect(parse(await f.text()).max_same_account_wait).toBe(expected)
  }
})

test('OC2 changing subagents writes no other cache_keep leaf', async () => {
  const f = await fixture()
  expect((await f.apply('cachekeep-subagents', { enabled: 'on' })).ok).toBe(
    true,
  )
  expect(
    Object.keys(parse(await f.text())).filter((key) =>
      key.startsWith('cache_keep_'),
    ),
  ).toEqual(['cache_keep_subagents'])
})
