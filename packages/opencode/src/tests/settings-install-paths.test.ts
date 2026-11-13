import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { AnthropicAuthPlugin } from '../index'
import {
  getTuiPreferencesFile,
  readTuiPreferencesFile,
  resolveAnthropicAuthPrefs,
} from '../tui-preferences'
import { setupAnthropicAuth } from '../v2/setup'
import { settingsReaderOutputs } from './opencode2-settings-readers'
import { createMockClient } from './support/opencode1-client'
import { disabledPluginRuntimeOverrides } from './support/opencode1-pool-fixture'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function put(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 })
}

function context() {
  const registration = { dispose: async () => {} }
  return {
    session: { get: async () => ({}), hook: async () => registration },
    model: { transform: async () => registration },
    provider: { transform: async () => registration },
    integration: { transform: async () => registration },
    rpc: {
      register: async () => ({
        ...registration,
        events: { emit: async () => {} },
      }),
    },
    command: { transform: async () => registration },
    event: { subscribe: async function* () {} },
  } as unknown as Plugin.Context
}

type Override = 'account' | 'state' | 'config' | 'config-xdg' | 'pi' | 'none'

async function fixture(override: Override, named = false) {
  core.resetStateLayoutDecisionsForTests()
  core.resetProcessStateLayoutsForTests()
  const original = { ...process.env }
  const records: core.LogTestRecord[] = []
  core.__setLogTestSink((record) => records.push(record))
  const level = core.getLogLevel()
  const dump = core.isDumpEnabled()
  const fast = core.isFastModeEnabled()
  const cache = {
    enabled: core.isCache1hEnabled(),
    mode: core.getCache1hMode(),
  }
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'oc-settings-paths-')),
  )
  cleanups.push(async () => {
    core.__setLogTestSink(null)
    core.resetStateLayoutDecisionsForTests()
    core.resetProcessStateLayoutsForTests()
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
    core.setLogLevel(level)
    core.setDumpEnabled(dump)
    core.setFastModeEnabled(fast)
    core.setCache1hState(cache)
    await fs.rm(root, { recursive: true, force: true })
  })
  for (const key of [
    'ANTHROPIC_AUTH_SETTINGS_FILE',
    'OPENCODE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'OPENCODE_ANTHROPIC_AUTH_FILE',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_AGENT_DIR',
    'PI_CODING_AGENT_DIR',
    'OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL',
  ])
    delete process.env[key]
  Object.assign(process.env, {
    HOME: root,
    USERPROFILE: root,
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, '.config'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'oc-enrollment',
    ),
    PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(root, 'pi-enrollment'),
    OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(root, 'rpc'),
    OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(root, 'registry'),
    OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: join(
      root,
      'sidebar-state.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR: join(root, 'feed'),
  })
  if (override === 'account')
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
      root,
      'private',
      'anthropic-auth.json',
    )
  if (override === 'state')
    process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
      root,
      'private-state.json',
    )
  if (override === 'config' || override === 'config-xdg')
    process.env.OPENCODE_CONFIG_DIR = join(root, 'private-config')
  if (override === 'config') delete process.env.XDG_CONFIG_HOME
  if (override === 'pi')
    process.env.PI_ANTHROPIC_AUTH_FILE = join(
      root,
      'private-pi',
      'anthropic-auth.json',
    )
  if (named)
    process.env.ANTHROPIC_AUTH_SETTINGS_FILE = join(
      root,
      'named',
      'settings.jsonc',
    )
  const stores = core.getSettingsStorePaths('opencode')
  const paths = await core.resolveNativePoolPaths(
    stores.account,
    stores.state,
    { kind: 'legacy' },
  )
  await put(paths.legacyConfig, { version: 1, accounts: [] })
  await put(paths.legacyState, { version: 1, accounts: {} })
  await core.runNativeMigration({
    paths,
    host: 'opencode',
    env: process.env,
    hostAuthPath: join(root, 'auth.json'),
    routingSourcePath: join(root, 'old-routing.json'),
    routingDestinationPath: join(root, 'routing.json'),
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  const store = core.createNativePoolStore({ paths, quota: nativeQuotaCodec })
  await store.initialize()
  cleanups.push(() => store.close())
  await store.updateSettings(() => ({
    refresh: { enabled: false, intervalMinutes: 12 },
    claudeFast: { enabled: true },
  }))
  const file = core.getSettingsFilePath()
  let runtime: core.NativeAccountRuntime | undefined
  let services = 0
  const acquire = core.acquireNativeAccountRuntime
  const acquisition = spyOn(
    core,
    'acquireNativeAccountRuntime',
  ).mockImplementation((options) => {
    runtime = acquire(options)
    return runtime
  })
  const open = core.openSettingsService
  const opening = spyOn(core, 'openSettingsService').mockImplementation(
    (options) => {
      services++
      return open({
        ...options,
        dependencies: { writeAppliedCopy: async () => {} },
      })
    },
  )
  cleanups.push(() => {
    acquisition.mockRestore()
    opening.mockRestore()
  })
  const start = async (host: 1 | 2) => {
    if (host === 1) {
      const create = AnthropicAuthPlugin as unknown as (
        input: unknown,
        overrides: unknown,
      ) => Promise<{ dispose(): Promise<void> }>
      const plugin = await create(
        { client: createMockClient(), directory: root },
        disabledPluginRuntimeOverrides(),
      )
      cleanups.push(() => plugin.dispose!())
    } else {
      const dispose = await setupAnthropicAuth(context(), {
        paths,
        cacheKeep: {
          registryDirectory: join(root, 'registry'),
          persistence: { root },
        },
      })
      cleanups.push(dispose)
    }
    if (!runtime) throw new Error('Host did not acquire its settings runtime')
    return runtime
  }
  return { root, paths, store, file, start, records, services: () => services }
}

for (const host of [1, 2] as const) {
  for (const override of [
    'account',
    'state',
    'config',
    'config-xdg',
  ] as const) {
    test(`OC${host} ${override} override stays separate, with legacy reads/writes and no defaults or user-file watch`, async () => {
      const f = await fixture(override)
      await put(f.file, {
        refresh_enabled: true,
        claude_fast_enabled: false,
        prime_enabled: true,
      })
      const bytes = await fs.readFile(f.file, 'utf8')
      const legacy = core.createNativeAccountRuntime({
        paths: f.paths,
        host: 'opencode',
      })
      const before = settingsReaderOutputs((await legacy.read()).policyStorage)
      await legacy.close()
      const read = fs.readFile
      const reads: string[] = []
      const reading = spyOn(fs, 'readFile').mockImplementation(((
        ...args: Parameters<typeof read>
      ) => {
        reads.push(String(args[0]))
        return read(...args)
      }) as typeof read)
      cleanups.push(() => reading.mockRestore())
      const runtime = await f.start(host)
      expect(f.services()).toBe(0)
      expect(reads).not.toContain(f.file)
      const policy = (await runtime.read()).policyStorage
      expect(settingsReaderOutputs(policy)).toBe(before)
      expect(policy.prime).toBeUndefined()
      expect(
        (
          await runtime.updateSettings((settings) => ({
            ...settings,
            refresh: {
              ...(settings as core.AccountStorage).refresh,
              intervalMinutes: 37,
            },
          }))
        ).outcome,
      ).toBe('updated')
      const stored = await f.store.readSettings()
      expect(
        stored.status === 'ready' &&
          (stored.settings as Partial<core.AccountStorage>).refresh
            ?.intervalMinutes,
      ).toBe(37)
      expect(await fs.readFile(f.file, 'utf8')).toBe(bytes)
      expect(await fs.exists(`${f.file}.moved`)).toBe(false)
      expect(await fs.exists(`${f.paths.config}.MOVED_READPLEASE`)).toBe(false)
    })
  }

  for (const override of ['none', 'account'] as const) {
    test(`OC${host} absolute settings target with ${override} override moves only its resolved store`, async () => {
      const f = await fixture(override, true)
      const before = await fs.readFile(f.paths.config, 'utf8')
      const other = join(f.root, '.pi', 'agent', 'anthropic-auth.json')
      await put(other, { version: 1, accounts: [], refresh: { enabled: true } })
      if (override === 'account') {
        const defaults = core.getDefaultSettingsStorePaths('opencode')
        const stale = await core.resolveNativePoolPaths(
          defaults.account,
          defaults.state,
          { kind: 'legacy' },
        )
        await put(stale.config, {
          version: 1,
          storageId: 'stale-default',
          refresh: { enabled: true },
        })
      }
      const read = fs.readFile
      const reads: string[] = []
      const reading = spyOn(fs, 'readFile').mockImplementation(((
        ...args: Parameters<typeof read>
      ) => {
        reads.push(String(args[0]))
        return read(...args)
      }) as typeof read)
      cleanups.push(() => reading.mockRestore())
      const runtime = await f.start(host)
      expect(reads).not.toContain(other)
      expect(f.services()).toBe(1)
      expect(await runtime.getSettingsPath(), JSON.stringify(f.records)).toBe(
        f.file,
      )
      expect((await runtime.read()).policyStorage.refresh?.enabled).toBe(false)
      expect((await runtime.read()).policyStorage.claudeFast?.enabled).toBe(
        true,
      )
      expect(await fs.exists(`${f.file}.moved`)).toBe(true)
      expect(await fs.readFile(f.paths.config, 'utf8')).toBe(before)
      expect(await fs.exists(`${f.paths.config}.MOVED_READPLEASE`)).toBe(true)
      expect(await fs.exists(`${other}.MOVED_READPLEASE`)).toBe(false)
    })
  }

  test(`OC${host} ignores Pi path overrides and leaves sidebar preferences outside the move`, async () => {
    const f = await fixture('pi')
    const sidebar = join(f.root, '.config', 'opencode', 'tui-preferences.jsonc')
    const custom = join(f.root, 'custom-tui.jsonc')
    await put(sidebar, {
      'anthropic-auth': {
        header: { label: 'Shared sidebar' },
        sections: { quota: false },
      },
    })
    await put(custom, {
      'anthropic-auth': {
        header: { label: 'Override sidebar' },
        startCollapsed: true,
      },
    })
    const bytes = await fs.readFile(sidebar, 'utf8')
    const customBytes = await fs.readFile(custom, 'utf8')
    delete process.env.OPENCODE_TUI_PREFERENCES_FILE
    expect(getTuiPreferencesFile()).toBe(sidebar)
    expect(
      resolveAnthropicAuthPrefs(await readTuiPreferencesFile()).header.label,
    ).toBe('Shared sidebar')
    process.env.OPENCODE_TUI_PREFERENCES_FILE = custom
    expect(getTuiPreferencesFile()).toBe(custom)
    const runtime = await f.start(host)
    expect(f.services()).toBe(1)
    expect(await runtime.getSettingsPath(), JSON.stringify(f.records)).toBe(
      f.file,
    )
    expect(await fs.exists(`${f.file}.moved`)).toBe(true)
    const prefs = resolveAnthropicAuthPrefs(await readTuiPreferencesFile())
    expect(prefs.header.label).toBe('Override sidebar')
    expect(prefs.startCollapsed).toBe(true)
    expect(await fs.readFile(sidebar, 'utf8')).toBe(bytes)
    expect(await fs.readFile(custom, 'utf8')).toBe(customBytes)
    for (const path of [sidebar, custom])
      expect(await fs.exists(`${path}.MOVED_READPLEASE`)).toBe(false)
  })
}
