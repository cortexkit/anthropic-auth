import { afterEach, describe, expect, mock, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import { openSettings } from '@cortexkit/common-auth/settings'
import { applyEdits, modify, parse } from 'jsonc-parser'
import { nativeAccountSettings } from '../../../core/src/native-account-view'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths'
import releaseSnapshots from './fixtures/settings-2.11.2.json'
import { settingsReaderOutputs } from './opencode2-settings-readers'
import { getPluginTestHandles } from './plugin-test-handles'
import { snapshotSettings } from './settings-snapshot-fixture'
import { observeSettings } from './settings-snapshot-observe'
import {
  applyMenuAction,
  createMockClient,
  openClaudeMenu,
} from './support/opencode1-client'
import { installLoaderSetup } from './support/opencode1-loader-setup'
import {
  bindPoolAccounts,
  createFallbackStorage,
  getPlugin,
  mainOnlyVault,
  readNativeSettings,
  syntheticMainHostAuth,
  syntheticMainIdentity,
  updatePoolSettings,
  useTempAccountFile,
  useUnmigratedAccountFile,
  useVaultAccountFile,
  withNativeAdmission,
} from './support/opencode1-pool-fixture'
import {
  readFeedEntries,
  waitForFeedEntries,
} from './support/opencode1-quota-feed'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context'
import { MESSAGES_URL } from './test-fetch'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)
const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture(
  mode: 'user-file' | 'legacy' | 'separate' = 'user-file',
  route: 'oauth' | 'api' = 'oauth',
) {
  const pool = ctx.migratedPool!
  const target = join(pool.root, 'anthropic-auth.jsonc')
  const saved = process.env.ANTHROPIC_AUTH_SETTINGS_FILE
  const level = process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  const liveLevel = core.getLogLevel()
  const feed = process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(pool.root, 'feed')
  if (mode !== 'separate') process.env.ANTHROPIC_AUTH_SETTINGS_FILE = target
  else delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  cleanups.push(() => {
    core.__setLogTestSink(null)
    core.setLogLevel(liveLevel)
    if (saved === undefined) delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
    else process.env.ANTHROPIC_AUTH_SETTINGS_FILE = saved
    if (level === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
    else process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = level
    if (feed === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
    else process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = feed
  })
  const protection = core.legacySettingsProtection(
    await readNativeSettings(ctx),
    'opencode',
    await core.readNativeEnrollmentMode('opencode'),
  )
  const put = (values: Record<string, unknown>) =>
    fs.writeFile(
      target,
      JSON.stringify({ schema_version: 1, ...protection, ...values }),
    )
  if (mode === 'user-file')
    await put({
      quota_enabled: 'off',
      quota_fail_closed_on_unknown_quota: 'off',
    })

  const { setSettingsFsForTest } = await import(
    new URL('fs.js', import.meta.resolve('@cortexkit/common-auth/settings'))
      .href
  )
  let io = 0
  const record = (path: string) => {
    if (path.startsWith(target)) io++
  }
  setSettingsFsForTest({
    readFile: (path: string, encoding: 'utf8') => {
      record(path)
      return fs.readFile(path, encoding)
    },
    lstat: (path: string) => {
      record(path)
      return fs.lstat(path)
    },
    realpath: (path: string) => {
      record(path)
      return fs.realpath(path)
    },
    open: (path: string, ...args: [string, number?]) => {
      record(path)
      return fs.open(path, ...args)
    },
  })
  cleanups.push(() => setSettingsFsForTest())
  const open = core.openSettingsService
  const start = core.startSettings
  const acquire = core.acquireNativeAccountRuntime
  const starts: core.StartedSettings[] = []
  const runtimes: core.NativeAccountRuntime[] = []
  let watch: (() => void) | undefined
  let closes = 0
  const startup = spyOn(core, 'startSettings').mockImplementation(
    async (options) => {
      const started = await start({
        ...options,
        start: {
          move: (options) =>
            core.runSettingsMoveAtStartup({
              ...options,
              ...(mode === 'legacy' && { fence: { registration: undefined } }),
            }),
          open: (options) =>
            open({
              ...options,
              dependencies: {
                readFile: async (path) => {
                  io++
                  return fs.readFile(path)
                },
                writeAppliedCopy: async () => {},
                open: (options) => {
                  const handle = openSettings<
                    typeof core.settingsDefinition.settings
                  >(core.settingsDefinition, options)
                  return {
                    ...handle,
                    watch: (callback) => {
                      watch = callback
                      return () => {
                        closes++
                        watch = undefined
                      }
                    },
                  }
                },
              },
            }),
        },
      })
      starts.push(started)
      return started
    },
  )
  const acquisition = spyOn(
    core,
    'acquireNativeAccountRuntime',
  ).mockImplementation((options) => {
    const runtime = acquire(options)
    runtimes.push(runtime)
    return runtime
  })
  cleanups.push(() => {
    startup.mockRestore()
    acquisition.mockRestore()
  })
  const sent: { body: Record<string, any>; headers: Headers }[] = []
  globalThis.fetch = mock(
    withNativeAdmission(
      ctx,
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(_input).includes('/api/oauth/usage'))
          return Response.json({
            five_hour: { utilization: 100 },
            seven_day: { utilization: 50 },
          })
        sent.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        })
        return Response.json(
          { id: 'msg-settings', content: [] },
          {
            status:
              route === 'api' && new Headers(init?.headers).has('authorization')
                ? 429
                : 200,
            headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.25' },
          },
        )
      },
    ),
  ) as unknown as typeof fetch
  const launch = async (directory?: string) => {
    const plugin = await getPlugin(ctx, createMockClient(), directory)
    const runtime = runtimes.at(-1)!
    const loader = await plugin.auth!.loader!(
      async () => ({
        type: 'oauth',
        ...((await core.readNativeEnrollmentMode('opencode')) === 'claustrum'
          ? core.custodyTombstoneOAuth('anthropic')
          : syntheticMainHostAuth()),
      }),
      { models: {} },
    )
    const request = async (model = 'claude-opus-5-5') => {
      const response = await loader.fetch!(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'hello',
                  cache_control: { type: 'ephemeral' },
                },
              ],
            },
          ],
        }),
      })
      await response.text()
      expect(response.status).toBe(200)
      return sent.at(-1)!
    }
    return { plugin, runtime, request }
  }
  return {
    pool,
    target,
    put,
    launch,
    starts,
    sent,
    io: () => io,
    closes: () => closes,
    async change(values: Record<string, unknown>) {
      await put(values)
      expect(watch).toBeDefined()
      watch!()
      await starts.at(-1)!.service!.refresh()
    },
  }
}

describe('OpenCode 1 settings service reads', () => {
  installLoaderSetup(ctx)

  test('a menu write refuses to recreate a missing explicit-target settings file when no Pi store is found', async () => {
    const f = await fixture()
    // Point the Pi store lookup at this test's folder, where no Pi store
    // exists. Under an explicit target a Pi with a private store could share
    // the file, so its protection is unknown and the write is refused.
    const saved = {
      HOME: process.env.HOME,
      PI_ANTHROPIC_AUTH_FILE: process.env.PI_ANTHROPIC_AUTH_FILE,
      PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE:
        process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE,
    }
    process.env.HOME = f.pool.root
    delete process.env.PI_ANTHROPIC_AUTH_FILE
    process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      f.pool.root,
      'pi-enrollment.json',
    )
    cleanups.push(() => {
      for (const [key, value] of Object.entries(saved))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    })
    await fs.rm(f.target)
    await core.writeSettingsMoveMarker(f.target)
    const instance = await f.launch(f.pool.root)
    const result = await instance.runtime.updateSettings((settings) => ({
      ...settings,
      dump: { enabled: true },
    }))
    expect(result.outcome).toBe('refused')
    await expect(fs.stat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('unmigrated model enumeration preserves the original refusal and host-only artifacts', async () => {
    await useUnmigratedAccountFile(
      ctx,
      createFallbackStorage({
        accounts: [],
        claustrum: { mode: 'claustrum' },
      }),
    )
    const root = ctx.tempConfigDir!
    const before = await fs.readdir(root)
    const contents = await Promise.all(
      before.map((name) => fs.readFile(join(root, name), 'utf8')),
    )
    const saved = process.env.ANTHROPIC_AUTH_SETTINGS_FILE
    process.env.ANTHROPIC_AUTH_SETTINGS_FILE = join(root, 'settings.jsonc')
    cleanups.push(() => {
      if (saved === undefined) delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
      else process.env.ANTHROPIC_AUTH_SETTINGS_FILE = saved
    })
    const network = mock(() => {
      throw new Error('A refused install must not use the network')
    })
    globalThis.fetch = network as unknown as typeof fetch
    const plugin = await getPlugin(ctx)
    expect(
      await plugin.provider!.models!(
        { models: {} },
        { auth: { type: 'oauth' } },
      ),
    ).toEqual({})
    const loader = await plugin.auth.loader(
      async () => core.custodyTombstoneOAuth('anthropic'),
      { models: {} },
    )
    await expect(
      loader.fetch(MESSAGES_URL, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
      }),
    ).rejects.toThrow(
      'Anthropic account migration is required. Stop OpenCode, LiteCode and Pi, then run npx @cortexkit/opencode-anthropic-auth setup',
    )
    await Promise.all(ctx.fallbackRefreshes)
    expect(network).not.toHaveBeenCalled()
    await plugin.dispose!()
    ctx.livePlugins.delete(plugin)
    // Refused hosts retain their ordinary holder/sidebar lifecycle. Settings
    // startup must not add files beyond the holder and sidebar files below.
    expect((await fs.readdir(root)).sort()).toEqual(
      [...before, 'anthropic-auth-holders.json', 'sidebar-state.json'].sort(),
    )
    expect(
      await Promise.all(
        before.map((name) => fs.readFile(join(root, name), 'utf8')),
      ),
    ).toEqual(contents)
  })

  test('move and first resolve finish at startup; a request does no settings filesystem work', async () => {
    const f = await fixture()
    await fs.rm(f.target)
    await updatePoolSettings(ctx, (settings) => ({
      ...settings,
      claudeFast: { enabled: true },
    }))
    const instance = await f.launch()
    expect(f.starts[0]?.mode).toBe('user-file')
    expect(parse(await fs.readFile(f.target, 'utf8')).claude_fast_enabled).toBe(
      true,
    )
    expect(
      (await instance.runtime.read()).policyStorage.claudeFast?.enabled,
    ).toBe(true)
    expect(f.io()).toBeGreaterThan(0)
    const before = f.io()
    await instance.request()
    expect(f.io()).toBe(before)
  })

  test('per-project instances retain one shared watch until the last lease closes', async () => {
    const f = await fixture()
    const a = await f.launch(join(f.pool.root, 'project-a'))
    const b = await f.launch(join(f.pool.root, 'project-b'))
    await a.plugin.dispose!()
    ctx.livePlugins.delete(a.plugin)
    expect(f.closes()).toBe(0)
    await f.change({ claude_fast_enabled: true, quota_enabled: 'off' })
    expect((await b.runtime.read()).policyStorage.claudeFast?.enabled).toBe(
      true,
    )
    await b.plugin.dispose!()
    ctx.livePlugins.delete(b.plugin)
    expect(f.closes()).toBe(1)
  })

  for (const mode of ['user-file', 'legacy', 'separate'] as const) {
    test(`policy snapshot uses the ${mode === 'user-file' ? 'user file' : 'legacy store'} in ${mode} mode`, async () => {
      await updatePoolSettings(ctx, (settings) => ({
        ...settings,
        claudeFast: { enabled: true },
      }))
      const f = await fixture(mode)
      await f.put({ claude_fast_enabled: false })
      if (mode === 'legacy') await fs.rm(f.target)
      const { runtime } = await f.launch()
      expect(f.starts[0]?.mode).toBe(mode)
      expect((await runtime.read()).policyStorage.claudeFast?.enabled).toBe(
        mode !== 'user-file',
      )
      if (mode === 'separate') expect(f.io()).toBe(0)
    })
  }

  for (const route of ['oauth', 'api'] as const) {
    test(`${route} requests take fast mode and cache mode from their model context, regardless of process latches`, async () => {
      if (route === 'api')
        await useTempAccountFile(
          ctx,
          createFallbackStorage({
            accounts: [
              {
                id: 'settings-api',
                type: 'api',
                apiKey: 'synthetic-settings-key',
                baseURL: 'https://paid.invalid',
                authHeader: 'x-api-key',
              },
            ],
          }),
        )
      const f = await fixture('user-file', route)
      await f.put({
        claude_cache_enabled: 'on',
        claude_cache_mode: {
          default: 'explicit',
          'claude-opus-5-5': 'automatic',
        },
        claude_fast_enabled: { default: false, 'claude-opus-5-5': true },
        quota_enabled: 'off',
      })
      const instance = await f.launch()
      core.setCache1hState({ enabled: false, mode: 'hybrid' })
      core.setFastModeEnabled(false)
      const opus = await instance.request('claude-opus-5-5[1m]')
      if (route === 'api')
        expect(opus.headers.get('x-api-key')).toBe('synthetic-settings-key')
      expect(opus.body.speed).toBe('fast')
      expect(opus.body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
      core.setCache1hState({ enabled: true, mode: 'automatic' })
      core.setFastModeEnabled(true)
      const other = await instance.request('claude-opus-4-8')
      expect(other.body.speed).toBeUndefined()
      expect(other.body.cache_control).toBeUndefined()
      expect(JSON.stringify(other.body.messages)).toContain('"ttl":"1h"')
      expect(
        (await instance.runtime.read('claude-opus-5-5-20261001[1m]'))
          .policyStorage.claudeFast?.enabled,
      ).toBe(true)
      expect(
        (await instance.runtime.read('unknown-model')).policyStorage.claudeFast
          ?.enabled,
      ).toBe(false)
    })
  }

  test('model cache on/off overrides defeat opposite process latches on successive requests', async () => {
    const f = await fixture()
    await f.put({
      claude_cache_enabled: { default: 'off', 'claude-opus-5-5': 'on' },
      claude_cache_mode: 'automatic',
      quota_enabled: 'off',
    })
    const instance = await f.launch()
    core.setCache1hState({ enabled: false, mode: 'explicit' })
    expect((await instance.request()).body.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    core.setCache1hState({ enabled: true, mode: 'automatic' })
    expect(
      (await instance.request('claude-opus-4-6')).body.cache_control,
    ).toBeUndefined()
  })

  test('hand edits change the dump latch, live log level and next request without restarting', async () => {
    const f = await fixture()
    const instance = await f.launch()
    const records: core.LogTestRecord[] = []
    core.__setLogTestSink((record) => records.push(record))
    expect(core.isDumpEnabled()).toBe(false)
    await f.change({
      dump_enabled: true,
      log_level: 'debug',
      claude_fast_enabled: true,
      claude_cache_enabled: 'on',
      claude_cache_mode: 'automatic',
      quota_enabled: 'off',
      quota_header_feed_enabled: true,
    })
    expect(core.isDumpEnabled()).toBe(true)
    expect(core.getLogLevel()).toBe('debug')
    expect(
      records.filter((record) => record.message === 'log level changed'),
    ).toHaveLength(1)
    const changed = await instance.request()
    expect(changed.body.speed).toBe('fast')
    expect(changed.body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(
      (await instance.runtime.read()).policyStorage.quotaHeaderFeed?.enabled,
    ).toBe(true)
    await f.change({
      dump_enabled: false,
      log_level: 'debug',
      quota_enabled: 'off',
    })
    expect(core.isDumpEnabled()).toBe(false)
    expect((await instance.request()).body.cache_control).toBeUndefined()
    expect(
      records.filter((record) => record.message === 'log level changed'),
    ).toHaveLength(1)
  })

  test('startup leaves the live log level alone when the environment overrides it', async () => {
    const f = await fixture()
    await f.put({ log_level: 'error' })
    process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = 'debug'
    core.setLogLevel('debug')
    await f.launch()
    expect(core.getLogLevel()).toBe('debug')
  })

  test('quota header feed enablement still requires a restart after a hand edit', async () => {
    const f = await fixture()
    const a = await f.launch()
    await f.change({ quota_header_feed_enabled: true, quota_enabled: 'off' })
    await a.request()
    expect(await readFeedEntries()).toEqual([])
    await a.plugin.dispose!()
    ctx.livePlugins.delete(a.plugin)
    const b = await f.launch()
    await b.request()
    const entries = await waitForFeedEntries(
      ctx,
      (entries) => entries.length > 0,
      'enabled feed after restart',
    )
    expect(entries.length).toBeGreaterThan(0)
  })

  for (const event of ['action', 'timer'] as const) {
    test(`a legacy instance notices a peer marker on the next ${event}, never on a request`, async () => {
      const f = await fixture('legacy')
      const ticks: (() => Promise<void>)[] = []
      const setTimeout = globalThis.setTimeout
      ctx.pluginRuntimeOverrides.setTimeout = ((
        callback: (...args: any[]) => void,
        delay?: number,
        ...args: any[]
      ) => {
        if (delay === 60_000) {
          ticks.push(callback as () => Promise<void>)
          return { unref() {} } as ReturnType<typeof setTimeout>
        }
        return setTimeout(callback, delay, ...args)
      }) as typeof setTimeout
      ctx.pluginRuntimeOverrides.clearTimeout =
        (() => {}) as typeof clearTimeout
      const instance = await f.launch(f.pool.root)
      expect(f.starts[0]?.mode).toBe('legacy')
      expect(ticks).toHaveLength(1)
      await f.put({ claude_fast_enabled: true, quota_enabled: 'off' })
      await core.writeSettingsMoveMarker(f.target)
      const before = f.io()
      expect(
        (await instance.runtime.read()).policyStorage.claudeFast?.enabled,
      ).not.toBe(true)
      expect(f.io()).toBe(before)
      if (event === 'action')
        await openClaudeMenu(instance.plugin, 'settings-action')
      else {
        await ticks[0]!()
      }
      expect(
        (await instance.runtime.read()).policyStorage.claudeFast?.enabled,
      ).toBe(true)
      expect(f.starts).toHaveLength(1)
    })
  }

  for (const custody of ['local', 'claustrum'] as const) {
    test(`a ${custody} user-file projection never reaches a legacy write, including account-order writes`, async () => {
      if (custody === 'claustrum') {
        const vault = mainOnlyVault()
        await useVaultAccountFile(
          ctx,
          createFallbackStorage({ accounts: [] }),
          vault,
        )
        ctx.pluginRuntimeOverrides.claustrumScopedConnect = async () => vault
      }
      await updatePoolSettings(ctx, (settings) => ({
        ...settings,
        claudeCache: { enabled: false },
        quota: { enabled: false, failClosedOnUnknownQuota: false },
      }))
      const before = await readNativeSettings(ctx)
      const f = await fixture()
      await f.put({
        claude_cache_enabled: 'on',
        quota_enabled: 'on',
        quota_fail_closed_on_unknown_quota: 'on',
      })
      const instance = await f.launch(f.pool.root)
      expect(
        (await instance.runtime.read()).policyStorage.claudeCache?.enabled,
      ).toBe('on')
      const order = ['settings-test-account']
      const ordered = await instance.runtime.updateSettings((settings) => ({
        ...settings,
        nativeAccountOrder: order,
      }))
      expect(ordered.outcome).toBe('saved')
      const result = await applyMenuAction(
        ctx,
        instance.plugin,
        'settings-write',
        {
          sectionId: 'Extras',
          actionId: 'fast-on',
        },
      )
      expect(result.ok).toBe(true)
      const stored = await readNativeSettings(ctx)
      expect(stored.nativeAccountOrder).toEqual(order)
      expect(stored.claudeCache).toEqual(before.claudeCache)
      expect(stored.quota).toEqual(before.quota)
      expect(JSON.stringify(stored)).not.toMatch(/"(?:default|on|off)"/)
    })
  }

  for (const mode of ['legacy', 'separate'] as const) {
    test(`${mode} menu writes preserve boolean legacy three-way fields without projected defaults`, async () => {
      await updatePoolSettings(ctx, (settings) => ({
        ...settings,
        claudeCache: { enabled: false },
        quota: { enabled: false, failClosedOnUnknownQuota: false },
      }))
      const before = await readNativeSettings(ctx)
      const f = await fixture(mode)
      const instance = await f.launch(f.pool.root)
      expect(
        (
          await applyMenuAction(ctx, instance.plugin, 'legacy-settings', {
            sectionId: 'Extras',
            actionId: 'fast-on',
          })
        ).ok,
      ).toBe(true)
      const stored = await readNativeSettings(ctx)
      expect(stored.claudeCache).toEqual(before.claudeCache)
      expect(stored.quota).toEqual(before.quota)
      expect(JSON.stringify(stored)).not.toMatch(/"(?:default|on|off)"/)
    })
  }

  for (const custody of ['local', 'claustrum'] as const) {
    for (const peer of ['absent', 'same'] as const) {
      for (const sample of ['explicit', 'absent'] as const) {
        test(`release byte snapshots in ${custody} custody with Pi ${peer}, three-way ${sample}`, async () => {
          if (custody === 'claustrum') {
            const vault = mainOnlyVault()
            await useVaultAccountFile(
              ctx,
              createFallbackStorage({ accounts: [] }),
              vault,
            )
            ctx.pluginRuntimeOverrides.claustrumScopedConnect = async () =>
              vault
          } else {
            await useTempAccountFile(
              ctx,
              bindPoolAccounts(createFallbackStorage({ accounts: [] })),
            )
          }
          const f = await fixture()
          await fs.rm(f.target)
          const paths =
            custody === 'local' ? f.pool.paths : nativeVaultPaths(f.pool.paths)
          const store = core.createNativePoolStore({
            paths,
            quota: nativeQuotaCodec,
          })
          await store.initialize()
          const values = nativeAccountSettings(
            snapshotSettings(sample === 'absent'),
          )
          await store.updateSettings((settings) => ({ ...settings, ...values }))
          const sourceBytes = await fs.readFile(paths.config, 'utf8')
          const legacy = core.createNativeAccountRuntime({
            paths: f.pool.paths,
            host: 'opencode',
          })
          const before = (await legacy.read()).policyStorage
          await legacy.close()
          // Use the default-source rule in a sandbox to include Pi without reading
          // either host's real default folder.
          const move = core.runSettingsMoveAtStartup
          const sandboxEnv: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: f.pool.root,
            XDG_CONFIG_HOME: join(f.pool.root, '.config'),
          }
          delete sandboxEnv.ANTHROPIC_AUTH_SETTINGS_FILE
          const settingsPaths = await core.resolveSettingsPaths('opencode', {
            env: sandboxEnv,
          })
          settingsPaths.defaults.opencode = settingsPaths.own
          if (peer === 'same') {
            const pi = settingsPaths.defaults.pi
            await fs.mkdir(join(pi.account, '..'), { recursive: true })
            await fs.writeFile(
              pi.account,
              JSON.stringify({ version: 1, accounts: [], ...values }),
            )
          }
          const mover = spyOn(
            core,
            'runSettingsMoveAtStartup',
          ).mockImplementation((options) =>
            move({
              ...options,
              env: sandboxEnv,
              paths: {
                ...settingsPaths,
                target: f.target,
                own: settingsPaths.own,
                separate: false,
              },
              ownPoolPaths: f.pool.paths,
            }),
          )
          cleanups.push(() => mover.mockRestore())
          const instance = await f.launch()
          expect(f.starts[0]?.mode).toBe('user-file')
          // Startup discovery publishes the vault primary pin in the background.
          // Its ready promise includes that write, so capture only after it settles.
          if (custody === 'claustrum')
            await getPluginTestHandles(instance.plugin).fallbackRefreshReady
          const after = (await instance.runtime.read()).policyStorage
          const storedBytes = await fs.readFile(paths.config, 'utf8')
          if (custody === 'claustrum') {
            const primary = (await instance.runtime.vault.read())?.rows.find(
              (row) => row.credentialId === 'oauth:anthropic',
            )
            expect(primary).toBeDefined()
            expect(primary?.accountIdentity).toBe(syntheticMainIdentity)
            const stored = JSON.parse(storedBytes)
            expect(stored.mainAccountId).toBe(primary!.routeId)
            expect(stored.claustrum).toEqual({
              primaryAccount: {
                credentialId: 'oauth:anthropic',
                accountId: syntheticMainIdentity,
              },
            })
            // Assert the pin above, then preserve the byte oracle for every other setting.
            const withoutPrimaryPin = (bytes: string) =>
              ['mainAccountId', 'claustrum'].reduce(
                (text, field) =>
                  applyEdits(text, modify(text, [field], undefined, {})),
                bytes,
              )
            expect(withoutPrimaryPin(storedBytes)).toBe(
              withoutPrimaryPin(sourceBytes),
            )
          } else {
            expect(storedBytes).toBe(sourceBytes)
          }
          for (const [phase, storage] of [
            ['before', before],
            ['after', after],
          ] as const) {
            settingsReaderOutputs(storage)
            const observed = await observeSettings(storage, 1)
            expect(JSON.stringify(observed), phase).toBe(
              JSON.stringify(releaseSnapshots[`oc1-${sample}`]),
            )
            expect(observed.logs.length).toBeGreaterThan(0)
            expect(observed.track.tracked).toBe(true)
            expect(observed.warms).toHaveLength(sample === 'explicit' ? 1 : 0)
          }
          await store.close()
        })
      }
    }
  }
})
