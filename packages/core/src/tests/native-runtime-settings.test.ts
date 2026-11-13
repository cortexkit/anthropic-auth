import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'
import {
  createEmptyStorage,
  getRefreshIntervalMs,
  isPrimePersistentlyEnabled,
  quotaEnabled,
} from '../accounts.ts'
import {
  buildCacheKeepStatusSummary,
  CacheKeepManager,
  getCacheKeepWindow,
  isCacheKeepAlways,
} from '../cachekeep.ts'
import { isDumpEnabled, setDumpEnabled } from '../dump.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  setLogLevel,
} from '../logger.ts'
import {
  acquireNativeAccountRuntime,
  createNativeAccountRuntime,
} from '../native-account-runtime.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { createNativeRuntimeSettings } from '../native-runtime-settings.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { settingsDefinition } from '../settings-definition.ts'
import type { SettingsMode } from '../settings-mode.ts'
import { openSettingsService } from '../settings-service.ts'
import { initializeNativeTestAuthority } from './native-authority-fixture.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  __setLogTestSink(null)
  setLogLevel('info')
  setDumpEnabled(false)
})

async function fixture(values: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-runtime-settings-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.jsonc')
  await writeFile(file, JSON.stringify(values))
  let reads = 0
  const service = await openSettingsService({
    file,
    dependencies: {
      readFile: async (path) => {
        reads++
        return readFile(path)
      },
      open: (options) => {
        const handle = openSettings(settingsDefinition, options)
        return { ...handle, watch: () => () => {} }
      },
    },
  })
  if (!service) throw new Error('Settings service did not open')
  cleanup.push(() => service.dispose())
  let mode: SettingsMode = 'user-file'
  const reader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsService: service,
    settingsMode: () => mode,
    env: {},
  })
  cleanup.push(reader.close)
  return {
    root,
    file,
    service,
    reader,
    reads: () => reads,
    mode: (next: SettingsMode) => {
      mode = next
    },
    settingsMode: () => mode,
  }
}

const overrides = {
  claude_fast_enabled: { default: false, 'claude-opus-5-5': true },
  claude_cache_enabled: { default: 'off', 'claude-opus-5-5': 'on' },
  claude_cache_mode: { default: 'explicit', 'claude-opus-5-5': 'hybrid' },
  cache_keep_enabled: { default: false, 'claude-opus-5-5': true },
  thinking_binding_prefix_mismatch_behavior: {
    default: 'error',
    'claude-opus-5-5': 'drop_block',
  },
} as const

test('request settings use their model and the next request sees a watch publication without settings I/O', async () => {
  const f = await fixture(overrides)
  const storage = createEmptyStorage()
  const before = f.reads()
  expect(
    f.reader.resolve(storage, 'claude-opus-5-5-20261102[1m]').claudeFast
      ?.enabled,
  ).toBe(true)
  expect(
    f.reader.resolve(storage, 'claude-opus-5-5-20261102[1m]').claudeCache?.mode,
  ).toBe('hybrid')
  expect(f.reader.resolve(storage, 'unknown').claudeCache?.mode).toBe(
    'explicit',
  )
  expect(f.reader.resolve(storage).claudeFast?.enabled).toBe(false)
  expect(f.reads()).toBe(before)
  await writeFile(
    f.file,
    JSON.stringify({ ...overrides, claude_fast_enabled: false }),
  )
  await f.service.refresh()
  expect(f.reader.resolve(storage, 'claude-opus-5-5').claudeFast?.enabled).toBe(
    false,
  )
})

test('legacy, separate, and absent-service readers preserve the exact legacy record without defaults', async () => {
  const f = await fixture({ routing_mode: 'sticky-balanced' })
  const storage = createEmptyStorage()
  storage.routing = { mode: 'fallback-first' }
  for (const mode of ['legacy', 'separate'] as const) {
    const reader = createNativeRuntimeSettings({
      host: 'opencode',
      settingsService: f.service,
      settingsMode: () => mode,
      settingsAuthority: { options: { fs: { exists: async () => false } } },
    })
    cleanup.push(reader.close)
    await reader.prepareAction()
    expect(reader.resolve(storage, 'claude-opus-5-5')).toEqual(storage)
    expect(reader.status()).toBeUndefined()
  }
  const legacy = createNativeRuntimeSettings({ host: 'pi' })
  expect(legacy.resolve(storage)).toEqual(storage)
})

test('a failed startup authority probe does not fail later menu actions', async () => {
  const f = await fixture({ dump_enabled: true })
  let failures = 1
  const reader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsService: f.service,
    settingsMode: () => 'legacy',
    settingsAuthority: {
      options: {
        fs: {
          exists: async () => {
            if (failures-- > 0)
              throw Object.assign(new Error('probe failed'), { code: 'EIO' })
            return true
          },
        },
      },
      schedule: () => () => {},
    },
  })
  cleanup.push(reader.close)
  // Let the startup probe fail and settle.
  await new Promise((resolve) => setTimeout(resolve, 10))
  await reader.prepareAction()
  expect(await reader.prepareWrite()).toBeDefined()
  expect(reader.status()?.values.dump_enabled).toBe(true)
})

test('/claude status has all no-model values and every explicit model row override, including equal values', async () => {
  const f = await fixture({
    ...overrides,
    claude_fast_enabled: { default: true, 'claude-opus-5-5': true },
  })
  const status = f.reader.status()!
  expect(Object.keys(status.values).sort()).toEqual(
    Object.keys(settingsDefinition.settings).sort(),
  )
  expect(status.values.claude_cache_mode).toBe('explicit')
  expect(Object.keys(status.modelOverrides).sort()).toEqual(
    Object.keys(overrides).sort(),
  )
  for (const [key, setting] of Object.entries(overrides)) {
    const value =
      key === 'claude_fast_enabled' ? true : setting['claude-opus-5-5']
    expect(status.modelOverrides[key as keyof typeof overrides]).toEqual([
      { model: 'claude-opus-5-5', value },
    ])
  }
  expect(status).not.toHaveProperty('model')
})

for (const [name, values, read, expected] of [
  ['quota poll', { quota_enabled: 'off' }, quotaEnabled, false],
  ['refresh', { refresh_interval_minutes: 3 }, getRefreshIntervalMs, 180_000],
  ['prime', { prime_enabled: true }, isPrimePersistentlyEnabled, true],
  [
    'quota header feed',
    { quota_header_feed_enabled: true },
    (storage: ReturnType<typeof createEmptyStorage>) =>
      storage.quotaHeaderFeed?.enabled,
    true,
  ],
  [
    'keep-warm schedule',
    { cache_keep_window: [{ start_hour: 2, end_hour: 7 }] },
    getCacheKeepWindow,
    { startHour: 2, endHour: 7 },
  ],
  [
    'keep-warm status',
    { cache_keep_always: true },
    (storage: ReturnType<typeof createEmptyStorage>) =>
      buildCacheKeepStatusSummary({
        enabled: storage.cacheKeep?.enabled === true,
        always: isCacheKeepAlways(storage),
      }),
    '',
  ],
] as const) {
  test(`${name} consumes the no-model context`, async () => {
    const f = await fixture({
      ...overrides,
      cache_keep_always: true,
      ...values,
    })
    const storage = f.reader.resolve(createEmptyStorage())
    if (name === 'keep-warm status') {
      expect(read(storage)).toContain('disabled')
      expect(storage.cacheKeep?.enabled).toBe(false)
    } else expect(read(storage)).toEqual(expected)
    expect(storage.claudeFast?.enabled).toBe(false)
  })
}

test('dump latch and live logging follow startup, menu publication, and hand edits once per change', async () => {
  const f = await fixture({ dump_enabled: true, log_level: 'debug' })
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  setLogLevel('info')
  f.reader.applyEffects()
  expect(isDumpEnabled()).toBe(true)
  expect(getLogLevel()).toBe('debug')
  expect(
    records.filter((record) => record.message === 'log level changed'),
  ).toHaveLength(0)
  await f.service.update(
    [
      { setting: 'dump_enabled', value: false },
      { setting: 'log_level', value: 'trace' },
      { setting: 'killswitch_enabled', value: true },
    ],
    'opencode',
  )
  f.reader.applyEffects()
  expect(isDumpEnabled()).toBe(false)
  expect(getLogLevel()).toBe('trace')
  expect(
    records.filter((record) => record.message === 'log level changed'),
  ).toHaveLength(1)
  expect(
    records.filter((record) => record.message === 'killswitch changed'),
  ).toHaveLength(1)
  await writeFile(
    f.file,
    '{"log_level":"info", "dump_enabled":true, "killswitch_enabled":true}',
  )
  await f.service.refresh()
  expect(getLogLevel()).toBe('info')
  expect(isDumpEnabled()).toBe(true)
  expect(
    records.filter((record) => record.message === 'log level changed'),
  ).toHaveLength(2)
  f.reader.applyEffects()
  expect(
    records.filter((record) => record.message === 'log level changed'),
  ).toHaveLength(2)
})

test('environment logging wins at startup and default logging restores the environment or info', async () => {
  const f = await fixture({ log_level: 'debug' })
  const envReader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsService: f.service,
    env: { OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL: 'warn' },
  })
  cleanup.push(envReader.close)
  f.reader.close()
  setLogLevel('warn')
  envReader.applyEffects()
  expect(getLogLevel()).toBe('warn')
  await writeFile(f.file, '{"log_level":"trace"}')
  await f.service.refresh()
  expect(getLogLevel()).toBe('trace')
  await writeFile(f.file, '{"log_level":"default"}')
  await f.service.refresh()
  expect(getLogLevel()).toBe('warn')
  envReader.close()
  const defaultReader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsService: f.service,
    env: {},
  })
  cleanup.push(defaultReader.close)
  defaultReader.applyEffects()
  expect(getLogLevel()).toBe('info')
})

for (const key of [
  'cache_keep_enabled',
  'claude_cache_enabled',
  'claude_cache_mode',
] as const) {
  test(`tracking resolves ${key} with the target model`, async () => {
    const f = await fixture({ ...overrides, cache_keep_always: true })
    const storage = createEmptyStorage()
    const manager = new CacheKeepManager({
      loadStorage: async () => storage,
      resolveSettings: f.reader.resolve,
      now: () => 1_000_000,
    })
    cleanup.push(() => manager.stop())
    const track = (model: string) =>
      manager.track({
        sessionId: 'session',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'warm me',
                  cache_control: { type: 'ephemeral', ttl: '1h' },
                },
              ],
            },
          ],
        }),
        storage,
        cacheMode: 'explicit',
      })
    expect(track('claude-opus-5-5')).toEqual({ tracked: true })
    const off =
      key === 'claude_cache_mode'
        ? 'explicit'
        : key === 'claude_cache_enabled'
          ? 'off'
          : false
    await writeFile(
      f.file,
      JSON.stringify({ ...overrides, cache_keep_always: true, [key]: off }),
    )
    await f.service.refresh()
    expect(track('claude-opus-5-5').tracked).toBe(false)
  })

  test(`timer re-resolves ${key} with each tracked target model`, async () => {
    const f = await fixture({ ...overrides, cache_keep_always: true })
    const storage = createEmptyStorage()
    const models: (string | undefined)[] = []
    const manager = new CacheKeepManager({
      loadStorage: async () => storage,
      resolveSettings: (stored, model) => {
        models.push(model)
        return f.reader.resolve(stored, model)
      },
      now: () => 1_000_000,
      fetchImpl: Object.assign(
        async () => {
          throw new Error('Not due yet')
        },
        { preconnect: fetch.preconnect },
      ),
    })
    cleanup.push(() => manager.stop())
    expect(
      manager.track({
        sessionId: 'session',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText: JSON.stringify({
          model: 'claude-opus-5-5',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'warm me',
                  cache_control: { type: 'ephemeral', ttl: '1h' },
                },
              ],
            },
          ],
        }),
        storage,
        cacheMode: 'explicit',
      }),
    ).toEqual({ tracked: true })
    models.length = 0
    await manager.tick()
    expect(manager.trackedCount()).toBe(1)
    expect(models).toEqual([undefined, 'claude-opus-5-5'])
    const off =
      key === 'claude_cache_mode'
        ? 'explicit'
        : key === 'claude_cache_enabled'
          ? 'off'
          : false
    await writeFile(
      f.file,
      JSON.stringify({
        ...overrides,
        cache_keep_always: true,
        [key]: {
          default:
            key === 'claude_cache_mode'
              ? 'hybrid'
              : key === 'claude_cache_enabled'
                ? 'on'
                : true,
          'claude-opus-5-5': off,
        },
      }),
    )
    await f.service.refresh()
    await manager.tick()
    expect(manager.trackedCount()).toBe(0)
  })
}

test('runtime overlays request policy only and never writes the projected enums to a legacy store', async () => {
  const f = await fixture({
    ...overrides,
    quota_enabled: 'off',
    quota_fail_closed_on_unknown_quota: 'off',
  })
  const paths = await resolveNativePoolPaths(join(f.root, 'accounts.json'))
  await initializeNativeTestAuthority(paths)
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  cleanup.push(() => store.close())
  await store.initialize()
  await store.add({
    id: 'local-main',
    credential: {
      type: 'api',
      apiKey: 'synthetic-key',
      baseURL: 'https://api.anthropic.com',
    },
  })
  await store.updateSettings((settings) => ({
    ...settings,
    mainAccountId: 'local-main',
    claudeCache: { enabled: true },
    quota: { enabled: false, failClosedOnUnknownQuota: true },
  }))
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    settingsService: f.service,
    settingsMode: () => 'user-file',
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          f.root,
          'enrollment.json',
        ),
      },
    },
  })
  cleanup.push(() => runtime.close())
  expect(
    (await runtime.read('claude-opus-5-5')).policyStorage.claudeFast?.enabled,
  ).toBe(true)
  expect((await runtime.read()).policyStorage.claudeFast?.enabled).toBe(false)
  expect((await runtime.read()).policyStorage.quota?.enabled).toBe('off')
  await runtime.updateSettings((settings) => ({
    ...settings,
    nativeAccountOrder: ['local-main'],
  }))
  await runtime.setEnabled('main', false)
  const saved = await store.readSettings()
  expect(saved.status).toBe('ready')
  if (saved.status !== 'ready') throw new Error('Store not ready')
  expect(saved.settings.quota).toEqual({
    enabled: false,
    failClosedOnUnknownQuota: true,
  })
  expect(saved.settings.claudeCache).toEqual({ enabled: true })
  expect(JSON.stringify(saved.settings)).not.toContain('"off"')
  expect(JSON.stringify(saved.settings)).not.toContain('"default"')
})

async function emptyRuntimeStore(root: string) {
  const paths = await resolveNativePoolPaths(
    join(root, 'runtime-accounts.json'),
  )
  await initializeNativeTestAuthority(paths)
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  cleanup.push(() => store.close())
  await store.initialize()
  return {
    paths,
    host: 'opencode' as const,
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          root,
          'enrollment.json',
        ),
      },
    },
  }
}

for (const firstToClose of [0, 1]) {
  test(`separate settings leases share one native runtime and survive closing acquisition ${firstToClose + 1}`, async () => {
    const f = await fixture(overrides)
    await f.reader.close()
    const peerService = await openSettingsService({ file: f.file })
    if (!peerService) throw new Error('Expected peer settings lease')
    cleanup.push(() => peerService.dispose())
    expect(peerService).not.toBe(f.service)
    const options = await emptyRuntimeStore(f.root)
    const first = acquireNativeAccountRuntime({
      ...options,
      settingsService: f.service,
      settingsMode: f.settingsMode,
    })
    const second = acquireNativeAccountRuntime({
      ...options,
      settingsService: peerService,
      settingsMode: () => 'user-file',
    })
    cleanup.push(() => first.close())
    cleanup.push(() => second.close())
    const initial = await first.read('claude-opus-5-5')
    expect(initial.policyStorage.claudeFast?.enabled).toBe(true)
    expect(second.peek?.()).toBe(initial)
    const acquisitions = [first, second]
    await acquisitions[firstToClose]!.close()
    await f.service.dispose()
    await writeFile(f.file, '{"claude_fast_enabled":false}')
    await peerService.refresh()
    await peerService.dispose()
    const remaining = acquisitions[1 - firstToClose]!
    expect(
      (await remaining.read('claude-opus-5-5')).policyStorage.claudeFast
        ?.enabled,
    ).toBe(false)
    expect(await remaining.getSettingsPath()).toBe(f.file)
    f.mode('legacy')
    // Authority cannot be revoked by a stale host mode callback after promotion.
    expect(await remaining.getSettingsPath()).toBe(f.file)
    f.mode('user-file')
    expect(await remaining.getSettingsPath()).toBe(f.file)
  })
}

for (const mode of ['user-file', 'legacy', 'separate'] as const) {
  test(`getSettingsPath returns the ${mode === 'user-file' ? 'user file' : 'legacy store'} in ${mode} mode`, async () => {
    const f = await fixture()
    f.mode(mode)
    const options = await emptyRuntimeStore(f.root)
    const runtime = createNativeAccountRuntime({
      ...options,
      settingsService: f.service,
      settingsMode: f.settingsMode,
    })
    cleanup.push(() => runtime.close())
    expect(await runtime.getSettingsPath()).toBe(
      mode === 'user-file' ? f.file : options.paths.config,
    )
  })
}
