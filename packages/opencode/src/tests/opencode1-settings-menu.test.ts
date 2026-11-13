import { afterEach, expect, spyOn } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  openSettings,
  type SettingsRefusalCode,
} from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import * as commands from '../native-command'
import { applyMenuAction, openClaudeMenu } from './support/opencode1-client'
import {
  getPlugin,
  readNativeSettings,
  updatePoolSettings,
  useTempAccountFile,
} from './support/opencode1-pool-fixture'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)
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
  await useTempAccountFile(ctx, { version: 1, accounts: [] })
  const pool = ctx.migratedPool!
  const mode = options.mode ?? 'user-file'
  const keys = [
    'HOME',
    'XDG_CONFIG_HOME',
    'ANTHROPIC_AUTH_SETTINGS_FILE',
    'OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL',
  ]
  const savedEnv = new Map(keys.map((key) => [key, process.env[key]]))
  const oldDump = core.isDumpEnabled()
  const oldFast = core.isFastModeEnabled()
  const oldCache = {
    enabled: core.isCache1hEnabled(),
    mode: core.getCache1hMode(),
  }
  const oldLevel = core.getLogLevel()
  cleanups.push(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    core.setDumpEnabled(oldDump)
    core.setFastModeEnabled(oldFast)
    core.setCache1hState(oldCache)
    core.setLogLevel(oldLevel)
  })
  process.env.HOME = pool.root
  delete process.env.XDG_CONFIG_HOME
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  const file =
    mode === 'separate'
      ? core.getSettingsFilePath({ env: { HOME: pool.root } })
      : join(pool.root, 'anthropic-auth.jsonc')
  if (mode === 'separate') delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
  else process.env.ANTHROPIC_AUTH_SETTINGS_FILE = file
  await mkdir(dirname(file), { recursive: true })
  if (options.source !== null)
    await writeFile(file, options.source ?? commented)
  await updatePoolSettings(ctx, (settings) => ({
    ...settings,
    claudeCache: { enabled: false },
    quota: { enabled: false, failClosedOnUnknownQuota: false },
  }))
  const originalStore = await readFile(pool.paths.config, 'utf8')
  if (mode !== 'separate') {
    const service = await core.openSettingsService({
      file,
      host: 'opencode',
      dependencies: {
        writeAppliedCopy: async () => {},
        open: (config) => {
          const handle = openSettings<typeof core.settingsDefinition.settings>(
            core.settingsDefinition,
            config,
          )
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
    const startup = spyOn(core, 'startSettings').mockResolvedValue({
      mode,
      file,
      service,
    })
    cleanups.push(() => startup.mockRestore())
  }
  const acquire = core.acquireNativeAccountRuntime
  let runtime: core.NativeAccountRuntime | undefined
  const acquisition = spyOn(
    core,
    'acquireNativeAccountRuntime',
  ).mockImplementation((options) => {
    runtime = acquire(options)
    return runtime
  })
  const create = commands.createNativeCommand
  let native: commands.NativeCommandOptions | undefined
  const command = spyOn(commands, 'createNativeCommand').mockImplementation(
    (options) => {
      native = options
      return create(options)
    },
  )
  cleanups.push(() => {
    acquisition.mockRestore()
    command.mockRestore()
  })
  const plugin = await getPlugin(ctx, undefined, pool.root)
  const payload = await openClaudeMenu(plugin, 'settings-menu')
  if (!runtime || !native) throw new Error('Missing native menu callbacks')
  const menu = native
  return {
    file,
    pool,
    runtime,
    plugin,
    payload,
    originalStore,
    dispatch: menu.dispatch,
    apply: (action: MenuRequest['action'], values: unknown = {}) =>
      menu.dispatch(
        { action, values, sessionId: 'settings-menu' } as MenuRequest,
        {},
      ),
    status: (section: Parameters<typeof menu.readStatus>[0] = 'cache') =>
      menu.readStatus(section, { sessionId: 'settings-menu', notify() {} }),
    text: () => readFile(file, 'utf8'),
    saved: async () =>
      (await readNativeSettings(ctx)) as unknown as core.AccountStorage,
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
    file: {
      killswitch_enabled: true,
      killswitch_default_five_hour: 7,
      killswitch_default_seven_day: 12,
    },
    legacy: {
      killswitch: { enabled: true, main: { five_hour: 7, seven_day: 12 } },
    },
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

const latchActions = actions.filter(({ action }) =>
  ['cache-on', 'cache-mode', 'dump-on', 'fast-on', 'logging-level'].includes(
    action,
  ),
)

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
    test(`OC1 ${section} actions write only their ${mode} destination and preserve JSONC`, async () => {
      const f = await fixture({
        mode,
        source: mode === 'legacy' ? null : commented,
      })
      for (const { action, values, file, legacy } of actions) {
        if (!(section in legacy)) continue
        expect((await f.apply(action, values)).ok).toBe(true)
        if (mode === 'user-file') {
          expect(parse(await f.text())).toMatchObject(file)
          expect(await readFile(f.pool.paths.config, 'utf8')).toBe(
            f.originalStore,
          )
          expect(await f.text()).toContain('// keep the user comment')
          expect(await f.text()).toContain('// keep the tail')
          expect(parse(await f.text()).unknown).toEqual({ kept: 42 })
        } else {
          const stored = await f.saved()
          expect(stored).toMatchObject(legacy)
          expect(stored.quota).toEqual({
            enabled: false,
            failClosedOnUnknownQuota: false,
          })
          for (const value of [
            stored.claudeCache?.enabled,
            stored.quota?.enabled,
            stored.quota?.failClosedOnUnknownQuota,
          ])
            expect(typeof value).toBe('boolean')
          if (mode === 'separate') expect(await f.text()).toBe(commented)
          else
            expect(await readFile(f.file, 'utf8').catch(() => null)).toBeNull()
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
  test(`OC1 every settings action propagates ${outcome}`, async () => {
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
      else expect(applied.ok).toBe(true)
    }
  })
}

test('OC1 malformed JSONC refuses settings writes without changing latches or the live log level', async () => {
  const source = '{ // keep malformed user bytes\n "dump_enabled": '
  const f = await fixture({ source })
  core.setDumpEnabled(false)
  core.setFastModeEnabled(false)
  core.setCache1hState({ enabled: false, mode: 'explicit' })
  core.setLogLevel('warn')
  const reason = `Cannot write settings to "${f.file}": the settings file is malformed or contains duplicate keys. Edit the file to fix it before trying again.`
  for (const { action, values } of latchActions) {
    expect(await f.apply(action, values)).toEqual({ ok: false, text: reason })
    expect(core.isDumpEnabled()).toBe(false)
    expect(core.isFastModeEnabled()).toBe(false)
    expect(core.isCache1hEnabled()).toBe(false)
    expect(core.getCache1hMode()).toBe('explicit')
    expect(core.getLogLevel()).toBe('warn')
  }
  expect(await f.text()).toBe(source)
  expect(await readFile(f.pool.paths.config, 'utf8')).toBe(f.originalStore)
  expect(
    await applyMenuAction(ctx, f.plugin, 'settings-menu', {
      sectionId: 'Diagnostics',
      actionId: 'dump-on',
    }),
  ).toMatchObject({ ok: false, text: reason })
})

test('OC1 removed host leaf refuses the whole action instead of revealing a lower window', async () => {
  const source =
    '{ // preserve both windows\n "cache_keep_window": { "default": [{ "start_hour": 8, "end_hour": 18 }], "opencode": [{ "start_hour": 9, "end_hour": 17 }] } }'
  const f = await fixture({ source })
  expect(await f.apply('cachekeep-always')).toEqual({
    ok: false,
    text: `Cannot remove setting "cache_keep_window" from "${f.file}": a lower level would still supply a value. Edit the settings file to set the value you want.`,
  })
  expect(await f.text()).toBe(source)
})

test('OC1 rung 3 refuses recreation and leaves all latches unchanged', async () => {
  const f = await fixture({ source: null, unavailableProtection: true })
  core.setDumpEnabled(false)
  core.setFastModeEnabled(false)
  core.setCache1hState({ enabled: false, mode: 'explicit' })
  core.setLogLevel('warn')
  for (const { action, values } of latchActions) {
    expect(await f.apply(action, values)).toEqual({
      ok: false,
      text: `Cannot recreate settings file "${f.file}": protection settings are unknown. Edit the settings file to set them before trying again.`,
    })
    expect(core.isDumpEnabled()).toBe(false)
    expect(core.isFastModeEnabled()).toBe(false)
    expect(core.isCache1hEnabled()).toBe(false)
    expect(core.getCache1hMode()).toBe('explicit')
    expect(core.getLogLevel()).toBe('warn')
  }
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
  test(`OC1 displays the fixed reason for ${refusal}, without success text`, async () => {
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

test('OC1 a failed file write reports its fixed failure and leaves latches and bytes unchanged', async () => {
  const f = await fixture({ failWrite: true })
  core.setDumpEnabled(false)
  core.setFastModeEnabled(false)
  core.setCache1hState({ enabled: false, mode: 'explicit' })
  core.setLogLevel('warn')
  for (const { action, values } of latchActions) {
    expect(await f.apply(action, values)).toEqual({
      ok: false,
      text: `Could not write settings to "${f.file}": the settings file is unavailable. Check its folder and permissions before trying again.`,
    })
    expect(core.isDumpEnabled()).toBe(false)
    expect(core.isFastModeEnabled()).toBe(false)
    expect(core.isCache1hEnabled()).toBe(false)
    expect(core.getCache1hMode()).toBe('explicit')
    expect(core.getLogLevel()).toBe('warn')
  }
  expect(await f.text()).toBe(commented)
})

test('OC1 cache, dump and fast latches change only after the settings write commits', async () => {
  const f = await fixture()
  const update = f.runtime.updateSettings.bind(f.runtime)
  for (const action of ['cache-on', 'dump-on', 'fast-on'] as const) {
    core.setCache1hState({ enabled: false, mode: 'explicit' })
    core.setDumpEnabled(false)
    core.setFastModeEnabled(false)
    let release!: () => void
    let began!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      began = resolve
    })
    const write = spyOn(f.runtime, 'updateSettings').mockImplementation(
      async (mutate) => {
        began()
        await held
        return update(mutate)
      },
    )
    try {
      const pending = f.apply(action)
      await entered
      expect(core.isCache1hEnabled()).toBe(false)
      expect(core.isDumpEnabled()).toBe(false)
      expect(core.isFastModeEnabled()).toBe(false)
      release()
      expect((await pending).ok).toBe(true)
      const enabled =
        action === 'cache-on'
          ? core.isCache1hEnabled()
          : action === 'dump-on'
            ? core.isDumpEnabled()
            : core.isFastModeEnabled()
      expect(enabled).toBe(true)
    } finally {
      release()
      write.mockRestore()
    }
  }
})

test('OC1 status lists every no-model value, model row override and file diagnostic', async () => {
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
  const status = await f.status()
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
  for (const [key, definition] of Object.entries(
    core.settingsDefinition.settings,
  )) {
    expect(status).toContain(`${key}: `)
    if (key === 'prime_enabled')
      expect(status).toContain(
        `prime_enabled: ${JSON.stringify(definition.default)}`,
      )
  }
  expect(status).toContain('Invalid setting: prime_enabled')
  expect(status).toContain('Ignored model key: claude_cache_enabled.not-a-row')
  expect(status).toContain('Duplicate setting: dump_enabled')
})

test('OC1 status names a missing file and its recreation by a menu write', async () => {
  const f = await fixture({ source: null })
  const missing = await f.status('routing')
  expect(missing).toContain(`Settings file: ${f.file}`)
  expect(missing).toContain(
    'Settings file is missing; a menu write will recreate it.',
  )
  expect((await f.apply('dump-on')).ok).toBe(true)
  const recreated = await f.status('routing')
  expect(recreated).toContain('Settings file was recreated by a menu write.')
  expect(recreated).not.toContain('Settings file is missing;')
})

test('OC1 longest-wait menu choices write their canonical values', async () => {
  const f = await fixture()
  expect(JSON.stringify(f.payload)).toContain(
    'Longest wait on the same account',
  )
  const executor = core.createNativeMenuExecutor({
    host: 'opencode',
    dispatch: f.dispatch,
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
  test(`OC1 user-file ${section} actions never write projected three-way strings to the legacy store`, async () => {
    const f = await fixture({
      source:
        '{ // keep legacy settings untouched\n "schema_version": 1, "claude_cache_enabled": "off", "quota_enabled": "off", "quota_fail_closed_on_unknown_quota": false }',
    })
    expect((await f.runtime.read()).policyStorage.claudeCache?.enabled).toBe(
      'off',
    )
    for (const { action, values, legacy } of actions) {
      if (!(section in legacy)) continue
      expect((await f.apply(action, values)).ok).toBe(true)
      expect(await readFile(f.pool.paths.config, 'utf8')).toBe(f.originalStore)
      const stored = await f.saved()
      expect(stored.quota).toEqual({
        enabled: false,
        failClosedOnUnknownQuota: false,
      })
      expect(stored.claudeCache?.enabled).toBe(false)
    }
  })
}
