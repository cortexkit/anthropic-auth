import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import { placeholderSecret } from '@cortexkit/common-auth/opencode2'
import { openSettings } from '@cortexkit/common-auth/settings'
import type { Plugin } from '@opencode/plugin'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths'
import { createNativeMenuCapabilities } from '../v2/menu'
import { setupAnthropicAuth } from '../v2/setup'
import * as sourceFactory from '../v2/source'
import {
  nondefaultSettings,
  settingsReaderOutputs,
} from './opencode2-settings-readers'

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

type TestHook = (draft: any) => unknown

function context(
  onInstall?: () => void,
  hooks = new Map<string, TestHook[]>(),
) {
  const registration = { dispose: async () => {} }
  return {
    session: {
      get: async () => ({}),
      hook: async (name: string, callback: TestHook) => {
        hooks.set(name, [...(hooks.get(name) ?? []), callback])
        return registration
      },
    },
    model: { transform: async () => registration },
    provider: { transform: async () => registration },
    integration: {
      transform: async () => {
        onInstall?.()
        return registration
      },
    },
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

async function put(file: string, value: unknown) {
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 })
}

async function fixture(
  mode: 'local' | 'claustrum' = 'local',
  separate = false,
) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'opencode2-settings-')),
  )
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
      root,
      'oc-enrollment',
    ),
    PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(root, 'pi-enrollment'),
  }
  if (separate)
    env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
      root,
      'private',
      'anthropic-auth.json',
    )
  const defaults = core.getSettingsStorePaths('opencode', { env })
  const paths = await core.resolveNativePoolPaths(
    defaults.account,
    defaults.state,
    { kind: 'legacy' },
  )
  await put(paths.legacyConfig, { version: 1, accounts: [] })
  await put(paths.legacyState, { version: 1, accounts: {} })
  await core.runNativeMigration({
    paths,
    host: 'opencode',
    env,
    hostAuthPath: join(root, 'auth.json'),
    routingSourcePath: join(root, 'old-routing.json'),
    routingDestinationPath: join(root, 'routing.json'),
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  if (mode === 'claustrum')
    await put(env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE!, {
      token: '01'.repeat(32),
      token_generation: 1,
    })
  const store = core.createNativePoolStore({
    paths: mode === 'local' ? paths : nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  cleanups.push(() => store.close())
  const target = core.getSettingsFilePath({ env })
  const { setSettingsFsForTest } = await import(
    new URL('fs.js', import.meta.resolve('@cortexkit/common-auth/settings'))
      .href
  )
  const initialLevel = core.getLogLevel()
  const initialDump = core.isDumpEnabled()
  const override = process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  cleanups.push(() => {
    core.__setLogTestSink(null)
    core.setLogLevel(initialLevel)
    core.setDumpEnabled(initialDump)
    if (override === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
    else process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = override
  })
  const opened: core.SettingsService[] = []
  let watch: (() => void) | undefined
  let watchCloses = 0
  let settingsIO = 0
  const recordIO = (path: string) => {
    if (path.startsWith(target)) settingsIO++
  }
  setSettingsFsForTest({
    readFile: (path: string, encoding: 'utf8') => {
      recordIO(path)
      return fs.readFile(path, encoding)
    },
    lstat: (path: string) => {
      recordIO(path)
      return fs.lstat(path)
    },
    realpath: (path: string) => {
      recordIO(path)
      return fs.realpath(path)
    },
    open: (path: string, ...args: [string, number?]) => {
      recordIO(path)
      return fs.open(path, ...args)
    },
  })
  cleanups.push(() => setSettingsFsForTest())
  const open = core.openSettingsService
  const openService = async (options: core.SettingsServiceOptions) => {
    if (options.host !== 'opencode') return open(options)
    const service = await open({
      ...options,
      dependencies: {
        readFile: async (path) => {
          settingsIO++
          return fs.readFile(path)
        },
        writeAppliedCopy: async () => {},
        open: (options) => {
          const handle = openSettings<typeof core.settingsDefinition.settings>(
            core.settingsDefinition,
            options,
          )
          const get: typeof handle.get = (name, context) => {
            settingsIO++
            return handle.get(name, context)
          }
          return {
            ...handle,
            get,
            watch: (callback) => {
              watch = callback
              return () => {
                watchCloses++
                watch = undefined
              }
            },
          }
        },
      },
    })
    if (service) opened.push(service)
    return service
  }
  const serviceSpy = spyOn(core, 'openSettingsService').mockImplementation(
    openService,
  )
  const starts: core.StartedSettings[] = []
  const startSettings = core.startSettings
  const startupSpy = spyOn(core, 'startSettings').mockImplementation(
    async (options) => {
      const started = await startSettings({
        ...options,
        start: {
          move: (input) => core.runSettingsMoveAtStartup(input),
          open: (input) => core.openSettingsService(input),
        },
      })
      starts.push(started)
      return started
    },
  )
  const sources: sourceFactory.NativeSource[] = []
  const runtimes: core.NativeAccountRuntime[] = []
  const create = sourceFactory.createNativeAnthropicSource
  const sourceSpy = spyOn(
    sourceFactory,
    'createNativeAnthropicSource',
  ).mockImplementation((options) => {
    runtimes.push(options.runtime)
    const source = create(options)
    sources.push(source)
    return source
  })
  cleanups.push(() => {
    serviceSpy.mockRestore()
    startupSpy.mockRestore()
    sourceSpy.mockRestore()
  })
  const start = async (onInstall?: () => void) => {
    const hooks = new Map<string, TestHook[]>()
    const dispose = await setupAnthropicAuth(context(onInstall, hooks), {
      paths,
      vault: { env },
      local: { resolveIdentity: legacyIdentity },
      fetch: Object.assign(async () => Response.json({}), {
        preconnect: fetch.preconnect,
      }),
      cacheKeep: {
        registryDirectory: join(root, 'registry'),
        persistence: { root },
      },
    })
    cleanups.push(dispose)
    const live = async () => {
      const draft = {
        sessionID: 'settings-availability',
        agent: 'build',
        kind: 'primary',
        model: { providerID: 'anthropic', id: 'claude-sonnet-5' },
        request: new Request('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${placeholderSecret('anthropic')}`,
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 8,
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        }),
      }
      for (const hook of hooks.get('context') ?? [])
        await hook({ ...draft, messages: [] })
      const model = { ...draft, headers: {} as Record<string, string> }
      for (const hook of hooks.get('model.request') ?? []) await hook(model)
      for (const [name, value] of Object.entries(model.headers))
        draft.request.headers.set(name, value)
      for (const hook of hooks.get('http.request') ?? []) await hook(draft)
      const answered = {
        ...draft,
        response: Response.json({ usage: { output_tokens: 1 } }),
      }
      for (const hook of hooks.get('http.response') ?? []) await hook(answered)
      await answered.response.text()
      return draft.request
    }
    return { dispose, live, source: sources.at(-1)!, runtime: runtimes.at(-1)! }
  }
  return {
    root,
    env,
    paths,
    store,
    target,
    start,
    opened,
    openSettings: open,
    openService,
    starts,
    io: () => settingsIO,
    watchCloses: () => watchCloses,
    async changed() {
      if (!watch) throw new Error('Settings watch is not open')
      watch()
      await opened.at(-1)!.refresh()
    },
  }
}

const legacyIdentity = async () =>
  ({ accountUuid: '11111111-2222-4333-8444-555555555555' }) as never

async function seedLegacyRequest(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.add({
    id: 'legacy',
    identity: '11111111-2222-4333-8444-555555555555',
    credential: {
      type: 'oauth',
      access: 'sk-ant-oat01-settings-legacy',
      refresh: 'synthetic-refresh',
      expires: Date.now() + 3_600_000,
    },
  })
  await f.store.updateSettings(() => ({
    mainAccountId: 'legacy',
    quota: { enabled: false },
    claudeFast: { enabled: true },
  }))
  await put(f.target, { quota_enabled: 'on', claude_fast_enabled: false })
}

for (const stage of ['move', 'service open'] as const) {
  test(`OC2 settings ${stage} failure still installs and serves a legacy-store request`, async () => {
    const f = await fixture()
    await seedLegacyRequest(f)
    if (stage === 'move') await fs.rm(f.target)
    const records: core.LogTestRecord[] = []
    core.setLogLevel('info')
    core.__setLogTestSink((record) => records.push(record))
    const failure =
      stage === 'move'
        ? spyOn(core, 'runSettingsMoveAtStartup').mockRejectedValue(
            new Error(`private settings failure at ${f.target}`),
          )
        : spyOn(core, 'openSettingsService').mockImplementation((options) =>
            options.host === 'opencode'
              ? Promise.reject(
                  new Error(`private settings failure at ${f.target}`),
                )
              : f.openSettings(options),
          )
    cleanups.push(() => failure.mockRestore())
    let installed = false
    const instance = await f.start(() => {
      installed = true
    })
    expect(installed).toBe(true)
    expect(instance.runtime.getSettingsStatus?.()).toBeUndefined()
    expect(
      (await instance.runtime.read()).policyStorage.claudeFast?.enabled,
    ).toBe(true)
    expect((await instance.live()).headers.get('authorization')).toBe(
      'Bearer sk-ant-oat01-settings-legacy',
    )
    const warnings = records.filter((record) =>
      record.message.includes('Settings startup failed'),
    )
    expect(warnings.length).toBeLessThanOrEqual(1)
    expect(
      warnings.every(
        (record) =>
          record.level === 'warn' &&
          record.payload === undefined &&
          record.message ===
            'Settings startup failed; protection settings use their last applied values until the settings file can be opened.',
      ),
    ).toBe(true)
    expect(JSON.stringify(records)).not.toContain('private settings failure')
    expect(JSON.stringify(warnings)).not.toContain(f.target)
  })
}

test('OC2 service open failure after a move enforces the stricter applied copy until the authority timer reopens it', async () => {
  const f = await fixture()
  await seedLegacyRequest(f)
  await fs.rm(f.target)
  const legacy = core.createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    local: { resolveIdentity: legacyIdentity },
    vault: { env: f.env },
  })
  cleanups.push(() => legacy.close())
  const credential = await legacy.authorizeLocal('main')
  if (credential.status !== 'usable')
    throw new Error('Legacy credential unavailable')
  const now = Date.now()
  const window = { remainingPercent: 50, usedPercent: 50, checkedAt: now }
  await legacy.publishLocal(credential.subject, {
    quota: {
      five_hour: window,
      seven_day: window,
      accountIdentity: '11111111-2222-4333-8444-555555555555',
    },
  })
  await f.store.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: true, failClosedOnUnknownQuota: true },
    killswitch: {
      enabled: true,
      main: { five_hour: 5, seven_day: 0, scoped: 0 },
    },
  }))
  const before = await legacy.read()
  expect(
    core.quotaSnapshotPassesPolicy(
      before.accounts[0]!.quota,
      before.policyStorage,
    ),
  ).toBe(true)
  await legacy.close()
  const stricter = {
    ...core.legacySettingsProtection(before.settings, 'opencode'),
    killswitch_default_five_hour: 80,
  }
  await core.writeSettingsProtectionCopy(f.target, 'opencode', {
    readAt: now,
    values: stricter,
  })
  let unavailable = true
  let opens = 0
  const openFailure = spyOn(core, 'openSettingsService').mockImplementation(
    (options) => {
      if (options.host !== 'opencode') return f.openSettings(options)
      opens++
      if (unavailable)
        return Promise.reject(new Error('synthetic settings open failure'))
      return f.openService(options)
    },
  )
  const ticks: (() => Promise<void>)[] = []
  const acquire = core.acquireNativeAccountRuntime
  const acquisition = spyOn(
    core,
    'acquireNativeAccountRuntime',
  ).mockImplementation((options) =>
    acquire({
      ...options,
      settingsAuthority: {
        ...options.settingsAuthority,
        schedule: (callback) => {
          ticks.push(callback)
          return () => {}
        },
      },
    }),
  )
  cleanups.push(() => {
    openFailure.mockRestore()
    acquisition.mockRestore()
  })
  const instance = await f.start()
  expect(await fs.stat(`${f.target}.moved`)).toBeDefined()
  expect(f.starts[0]?.fallback?.rung).toBe(1)
  const policy = (await instance.runtime.read()).policyStorage
  expect(core.getKillswitchThresholdsForAccount(policy).five_hour).toBe(80)
  expect(policy.claudeFast?.enabled).toBe(true)
  const beforeRequest = opens
  await expect(instance.live()).rejects.toThrow()
  expect(opens).toBe(beforeRequest)
  expect(ticks).toHaveLength(1)
  unavailable = false
  await ticks[0]!()
  expect(instance.runtime.getSettingsStatus?.()).toBeDefined()
  expect(
    core.getKillswitchThresholdsForAccount(
      (await instance.runtime.read()).policyStorage,
    ).five_hour,
  ).toBe(5)
  expect((await instance.live()).headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-settings-legacy',
  )
  await instance.dispose()
  expect(f.watchCloses()).toBe(1)
})

test('OC2 failed first settings authority check does not abort requests or later menu probes', async () => {
  const f = await fixture()
  await seedLegacyRequest(f)
  const acquire = core.acquireNativeAccountRuntime
  let probes = 0
  const acquisition = spyOn(
    core,
    'acquireNativeAccountRuntime',
  ).mockImplementation((options) => {
    const runtime = acquire(options)
    return {
      ...runtime,
      prepareSettingsAction: async () => {
        if (++probes === 1)
          throw new Error(`private authority failure at ${f.target}`)
        await runtime.prepareSettingsAction?.()
      },
    }
  })
  cleanups.push(() => acquisition.mockRestore())
  const records: core.LogTestRecord[] = []
  core.setLogLevel('info')
  core.__setLogTestSink((record) => records.push(record))
  // Keep the user-file policy permissive so this test isolates startup's probe.
  await put(f.target, { quota_enabled: 'off' })
  const instance = await f.start()
  expect((await instance.live()).headers.get('authorization')).toBe(
    'Bearer sk-ant-oat01-settings-legacy',
  )
  const menu = createNativeMenuCapabilities({
    runtime: instance.runtime,
    source: instance.source,
    start: async () => {},
  })
  cleanups.push(() => menu.close())
  await menu.readStatus('dump')
  expect(probes).toBe(2)
  const warnings = records.filter(
    (record) =>
      record.message ===
      'Settings authority check failed; continuing with current settings.',
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.level).toBe('warn')
  expect(warnings[0]?.message).toBe(
    'Settings authority check failed; continuing with current settings.',
  )
  expect(warnings[0]?.payload).toBeUndefined()
  expect(JSON.stringify(records)).not.toContain('private authority failure')
})

function request(modelID = 'claude-sonnet-5') {
  return {
    attemptId: 'settings-attempt',
    sessionID: 'settings-session',
    accountId: 'api',
    route: 'oauth' as const,
    agent: 'build',
    modelID,
    transport: undefined,
    dispatch: 'direct' as const,
    providerID: 'anthropic',
    kind: 'primary' as const,
    correlation: {},
    provenance: {} as sourceFactory.NativeSourceProvenance,
  }
}

test('OC2 startup moves and resolves before installation; request settings use memory and watch changes are live', async () => {
  const f = await fixture()
  await f.store.updateSettings(() => ({
    dump: { enabled: true },
    quota: { enabled: false },
  }))
  const instance = await f.start(() => {
    expect(f.opened).toHaveLength(1)
    expect(f.opened[0]!.resolve('opencode').dump_enabled).toBe(true)
  })
  expect(await fs.stat(`${f.target}.moved`)).toBeDefined()
  expect(core.isDumpEnabled()).toBe(true)
  // Settings authority is independent of account availability.
  const before = f.io()
  await instance.source.isDumpEnabled?.()
  await instance.runtime.read('claude-sonnet-5')
  expect(f.io()).toBe(before)
  await put(f.target, { dump_enabled: false, prime_enabled: true })
  await f.changed()
  expect(await instance.source.isDumpEnabled?.()).toBe(false)
  expect(core.isDumpEnabled()).toBe(false)
  expect((await instance.runtime.read()).policyStorage.prime?.enabled).toBe(
    true,
  )
})

test('each OC2 instance holds a settings lease and reload closes the last watch', async () => {
  const f = await fixture()
  const first = await f.start()
  const second = await f.start()
  expect(f.opened).toHaveLength(2)
  await first.dispose()
  expect(f.watchCloses()).toBe(0)
  await put(f.target, { dump_enabled: true })
  await f.changed()
  expect((await second.runtime.read()).policyStorage.dump?.enabled).toBe(true)
  await second.dispose()
  expect(f.watchCloses()).toBe(1)
  const reloaded = await f.start()
  expect(await reloaded.source.isDumpEnabled?.()).toBe(true)
  await reloaded.dispose()
  expect(f.watchCloses()).toBe(2)
})

test('OC2 user-file logging changes live once, while startup preserves an environment override', async () => {
  const f = await fixture()
  await put(f.target, { log_level: 'debug' })
  process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = 'info'
  core.setLogLevel('info')
  const records: core.LogTestRecord[] = []
  core.__setLogTestSink((record) => records.push(record))
  await f.start()
  expect(core.getLogLevel()).toBe('info')
  expect(records.filter((r) => r.message === 'log level changed')).toHaveLength(
    0,
  )
  await put(f.target, { log_level: 'trace' })
  await f.changed()
  expect(core.getLogLevel()).toBe('trace')
  expect(records.filter((r) => r.message === 'log level changed')).toHaveLength(
    1,
  )
})

test('OC2 separate pool neither opens the default user file nor receives its defaults', async () => {
  const f = await fixture('local', true)
  await put(f.target, { dump_enabled: false, routing_mode: 'main-first' })
  await f.store.updateSettings(() => ({
    dump: { enabled: true },
    routing: { mode: 'fallback-first' },
  }))
  const instance = await f.start()
  expect(f.opened).toHaveLength(0)
  expect(f.io()).toBe(0)
  expect((await instance.runtime.read()).policyStorage.routing?.mode).toBe(
    'fallback-first',
  )
  expect(await instance.source.isDumpEnabled?.()).toBe(true)
})

test('OC2 source resolves all five model settings per request, including suffixed and unknown models', async () => {
  const f = await fixture()
  await put(f.target, {
    claude_cache_enabled: { default: 'off', 'claude-opus-5-5': 'on' },
    claude_cache_mode: { default: 'explicit', 'claude-opus-5-5': 'hybrid' },
    claude_fast_enabled: { default: false, 'claude-opus-5-5': true },
    cache_keep_enabled: { default: false, 'claude-opus-5-5': true },
    cache_keep_always: true,
    thinking_binding_prefix_mismatch_behavior: {
      default: 'error',
      'claude-opus-5-5': 'drop_block',
    },
  })
  const instance = await f.start()
  await instance.runtime.addApi({
    routeId: 'api',
    label: 'API',
    apiKey: 'synthetic-key',
  })
  const reads: (string | undefined)[] = []
  const read = instance.runtime.read.bind(instance.runtime)
  const readSpy = spyOn(instance.runtime, 'read').mockImplementation(
    (model) => {
      reads.push(model)
      return read(model)
    },
  )
  cleanups.push(() => readSpy.mockRestore())
  const before = f.io()
  for (const model of [
    'claude-opus-5-5',
    'claude-opus-5-5-20260101[1m]',
    'claude-sonnet-5',
    'unknown',
  ]) {
    const options = await instance.source.requestOptions!(request(model))
    const opus = model.startsWith('claude-opus-5-5')
    expect(options.cache1hEnabled).toBe(opus)
    expect(options.cache1hMode).toBe(opus ? 'hybrid' : 'explicit')
    expect(options.fastModeEnabled).toBe(opus)
    expect(options.thinkingPrefixMismatchBehavior).toBe(
      opus ? 'drop_block' : 'error',
    )
    const policy = (await instance.runtime.read(model)).policyStorage
    expect(core.isCacheKeepPersistentlyEnabled(policy)).toBe(opus)
    expect(reads).toContain(model)
  }
  expect(f.io()).toBe(before)
  await put(f.target, { claude_fast_enabled: true })
  await f.changed()
  const afterWatch = f.io()
  expect(
    (await instance.source.requestOptions!(request('unknown'))).fastModeEnabled,
  ).toBe(true)
  expect(f.io()).toBe(afterWatch)
})

test('OC2 rechecks legacy authority at instance start and on read and write menu actions', async () => {
  const f = await fixture()
  await f.store.updateSettings(() => ({ dump: { enabled: true } }))
  const run = core.runSettingsMoveAtStartup
  let publishAtInstanceStart = false
  const move = spyOn(core, 'runSettingsMoveAtStartup').mockImplementation(
    async (options) => {
      const result = await run({
        ...options,
        fence: { registration: undefined },
      })
      expect(result.mode).toBe('legacy')
      if (publishAtInstanceStart) {
        await put(f.target, { dump_enabled: false })
        await core.writeSettingsMoveMarker(f.target, { env: f.env })
      }
      return result
    },
  )
  cleanups.push(() => move.mockRestore())
  const first = await f.start()
  expect(await first.source.isDumpEnabled?.()).toBe(true)
  expect(first.runtime.getSettingsStatus?.()).toBeUndefined()
  await put(f.target, { dump_enabled: false })
  await core.writeSettingsMoveMarker(f.target, { env: f.env })
  const menu = createNativeMenuCapabilities({
    runtime: first.runtime,
    source: first.source,
    start: async () => {},
  })
  cleanups.push(() => menu.close())
  const prepare = first.runtime.prepareSettingsAction!.bind(first.runtime)
  let checks = 0
  const actions = spyOn(
    first.runtime,
    'prepareSettingsAction',
  ).mockImplementation(async () => {
    checks++
    await prepare()
  })
  cleanups.push(() => actions.mockRestore())
  await menu.readStatus('dump')
  expect(await first.source.isDumpEnabled?.()).toBe(false)
  await menu.dispatch({ action: 'dump-on', values: {} }, {})
  expect(checks).toBe(2)
  expect((await first.runtime.read()).policyStorage.dump?.enabled).toBe(true)
  const stored = await f.store.readSettings()
  if (stored.status !== 'ready') throw new Error('Legacy settings unavailable')
  expect(stored.settings.dump).toEqual({ enabled: true })
  await first.dispose()
  await fs.rm(f.target)
  await fs.rm(`${f.target}.moved`)
  publishAtInstanceStart = true
  const restarted = await f.start()
  expect(await restarted.source.isDumpEnabled?.()).toBe(false)
  expect(restarted.runtime.getSettingsStatus?.()).toBeDefined()
})

test.each(['local', 'claustrum'] as const)(
  'OC2 %s legacy writes never receive a user-file projected record',
  async (mode) => {
    const f = await fixture(mode)
    const original = {
      claudeCache: { enabled: false },
      quota: { enabled: true, failClosedOnUnknownQuota: false },
      nativeAccountOrder: ['old'],
    }
    await f.store.updateSettings(() => original)
    const instance = await f.start()
    await put(f.target, {
      claude_cache_enabled: 'on',
      quota_enabled: 'off',
      quota_fail_closed_on_unknown_quota: 'on',
    })
    await f.changed()
    expect((await instance.runtime.read()).policyStorage.quota?.enabled).toBe(
      'off',
    )
    const outcome = await instance.runtime.updateSettings((settings) => ({
      ...settings,
      nativeAccountOrder: ['new'],
    }))
    expect(outcome.outcome).toBe('saved')
    const stored = await f.store.readSettings()
    if (stored.status !== 'ready')
      throw new Error('Legacy settings unavailable')
    expect(stored.settings).toEqual({
      ...original,
      nativeAccountOrder: ['new'],
    })
    expect(
      typeof (stored.settings.claudeCache as { enabled: unknown }).enabled,
    ).toBe('boolean')
    expect(typeof (stored.settings.quota as { enabled: unknown }).enabled).toBe(
      'boolean',
    )
  },
)

for (const mode of ['local', 'claustrum'] as const) {
  for (const peer of ['absent', 'same'] as const) {
    test(`OC2 ${mode} move preserves every named reader with Pi ${peer}`, async () => {
      const f = await fixture(mode)
      const legacy = nondefaultSettings(
        mode === 'local' ? 'local-row' : 'vault:credential',
      )
      await f.store.updateSettings(() => legacy)
      if (peer === 'same') {
        const peerPaths = core.getDefaultSettingsStorePaths('pi', {
          env: f.env,
        })
        const paths = await core.resolveNativePoolPaths(
          peerPaths.account,
          peerPaths.state,
          { kind: 'legacy' },
        )
        const store = core.createNativePoolStore({
          paths: mode === 'local' ? paths : nativeVaultPaths(paths),
          quota: nativeQuotaCodec,
        })
        cleanups.push(() => store.close())
        await store.initialize()
        await store.updateSettings(() => legacy)
        if (mode === 'claustrum')
          await put(f.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE!, {
            token: '02'.repeat(32),
            token_generation: 1,
          })
      }
      const raw = core.createNativeAccountRuntime({
        paths: f.paths,
        host: 'opencode',
        vault: { env: f.env },
      })
      const before = settingsReaderOutputs((await raw.read()).policyStorage)
      await raw.close()
      const bytes = await fs.readFile(
        mode === 'local' ? f.paths.config : nativeVaultPaths(f.paths).config,
        'utf8',
      )
      const instance = await f.start()
      expect(
        settingsReaderOutputs((await instance.runtime.read()).policyStorage),
      ).toBe(before)
      expect(
        await fs.readFile(
          mode === 'local' ? f.paths.config : nativeVaultPaths(f.paths).config,
          'utf8',
        ),
      ).toBe(bytes)
      expect(f.opened[0]!.snapshot().report).toEqual([])
    })
  }
}

test.each(['local', 'claustrum'] as const)(
  'OC2 %s move preserves all readers when three-way fields were absent',
  async (mode) => {
    const f = await fixture(mode)
    const raw = core.createNativeAccountRuntime({
      paths: f.paths,
      host: 'opencode',
      vault: { env: f.env },
    })
    const before = settingsReaderOutputs((await raw.read()).policyStorage)
    await raw.close()
    const instance = await f.start()
    expect(
      settingsReaderOutputs((await instance.runtime.read()).policyStorage),
    ).toBe(before)
  },
)
