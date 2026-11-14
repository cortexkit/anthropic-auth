import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as core from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  getLogLevel,
  getSettingsFilePath,
  type LogTestRecord,
  nativePoolStoreLocks,
  prepareSettingsMoveSources,
  resolveNativePoolPaths,
  setLogLevel,
  settingsDefinition,
} from '@cortexkit/anthropic-auth-core'
import { withLock } from '@cortexkit/common-auth/fs'
import { openSettings } from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import { nativeAccountSettings } from '../../../core/src/native-account-view.ts'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { buildAnthropicRequest } from '../convert.ts'
import {
  closePiNativeRuntime,
  getPiNativeRuntime,
  PiNativeRuntime,
  resolvePiSettingsFromMemory,
} from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import { getPiConfigDir } from '../paths.ts'
import type { PiSettingsOptions } from '../settings.ts'
import { __sendPiAnthropicRequestForTest } from '../stream.ts'
import releaseSnapshots from './fixtures/settings-2.11.2.json'
import { saveNativePiFixture } from './native-fixture.ts'
import {
  snapshotReaderOutputs,
  snapshotSettings,
} from './settings-snapshot-fixture.ts'
import { observeSettings } from './settings-snapshot-observe.ts'

let home: string
let storagePath: string
let file: string
let original: NodeJS.ProcessEnv
const runtimes: PiNativeRuntime[] = []
let callbacks: (() => void)[]
let watches: number
let stops: number
let settingsReads: number
let records: LogTestRecord[]
const level = getLogLevel()

beforeEach(async () => {
  original = { ...process.env }
  home = await fs.mkdtemp(join(tmpdir(), 'pi-settings-read-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.XDG_STATE_HOME = join(home, 'state')
  delete process.env.OPENCODE_CONFIG_DIR
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  storagePath = join(home, '.pi', 'agent', 'anthropic-auth.json')
  file = join(home, 'settings.jsonc')
  process.env.PI_CODING_AGENT_DIR = getPiConfigDir({}, home)
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  process.env.ANTHROPIC_AUTH_SETTINGS_FILE = file
  delete process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL
  callbacks = []
  watches = 0
  stops = 0
  settingsReads = 0
  records = []
  __setLogTestSink((record) => records.push(record))
  await saveNativePiFixture(
    { version: 1, accounts: [], prime: { enabled: false } },
    storagePath,
  )
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
  await closePiNativeRuntime(storagePath)
  __setLogTestSink(null)
  setLogLevel(level)
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await fs.rm(home, { recursive: true, force: true })
})

function settingsOptions(): PiSettingsOptions {
  return {
    home,
    service: {
      dependencies: {
        writeAppliedCopy: async () => {},
        readFile: async (path) => {
          settingsReads++
          return fs.readFile(path)
        },
        open: (options) => {
          const handle = openSettings<typeof settingsDefinition.settings>(
            settingsDefinition,
            options,
          )
          const get: typeof handle.get = (name, context) => {
            settingsReads++
            return handle.get(name, context)
          }
          return {
            ...handle,
            get,
            watch: (callback) => {
              callbacks.push(callback)
              watches++
              return () => {
                stops++
              }
            },
          }
        },
      },
    },
  }
}
function runtime(settings = settingsOptions()) {
  const native = new PiNativeRuntime(storagePath, {
    settings,
    vaultPoll: { intervalMs: 0 },
  })
  runtimes.push(native)
  return native
}
async function write(value: Record<string, unknown>) {
  await fs.writeFile(
    file,
    JSON.stringify({ schema_version: 1, prime_enabled: false, ...value }),
  )
}
async function changed(native: PiNativeRuntime, predicate: () => boolean) {
  for (const callback of callbacks) callback()
  const deadline = Date.now() + 2000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5)
  expect(predicate()).toBe(true)
  return native.requestView()
}

test('Pi config resolution accepts a sandbox env and home without process globals', () => {
  expect(getPiConfigDir({}, home)).toBe(join(home, '.pi', 'agent'))
  expect(getPiConfigDir({ PI_AGENT_DIR: ' agent ' }, home)).toBe('agent')
  expect(
    getPiConfigDir(
      { PI_CODING_AGENT_DIR: ' coding ', PI_AGENT_DIR: 'agent' },
      home,
    ),
  ).toBe('coding')
})

test('keep-warm settings resolution never starts I/O for a missing runtime', () => {
  const stored: core.AccountStorage = {
    version: 1,
    accounts: [],
    dump: { enabled: true },
  }
  const path = join(home, 'not-migrated', 'anthropic-auth.json')
  const realpath = spyOn(fs, 'realpath')
  const readFile = spyOn(fs, 'readFile')
  const stat = spyOn(fs, 'stat')
  try {
    expect(resolvePiSettingsFromMemory(stored, 'claude-opus-5-5', path)).toBe(
      stored,
    )
    expect(realpath).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  } finally {
    realpath.mockRestore()
    readFile.mockRestore()
    stat.mockRestore()
  }
})

test('keep-warm settings resolution uses model values from the live cached runtime without I/O', async () => {
  await write({
    claude_fast_enabled: { default: false, 'claude-opus-5-5': true },
  })
  const native = getPiNativeRuntime(storagePath, {
    settings: settingsOptions(),
    vaultPoll: { intervalMs: 0 },
  })
  await native.service()
  const stored: core.AccountStorage = { version: 1, accounts: [] }
  const realpath = spyOn(fs, 'realpath')
  const readFile = spyOn(fs, 'readFile')
  const stat = spyOn(fs, 'stat')
  try {
    expect(
      core.isFastModePersistentlyEnabled(
        resolvePiSettingsFromMemory(stored, 'claude-opus-5-5', storagePath),
      ),
    ).toBe(true)
    expect(
      core.isFastModePersistentlyEnabled(
        resolvePiSettingsFromMemory(stored, 'claude-haiku-4-5', storagePath),
      ),
    ).toBe(false)
    expect(realpath).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  } finally {
    realpath.mockRestore()
    readFile.mockRestore()
    stat.mockRestore()
  }
  await native.close()
  expect(
    resolvePiSettingsFromMemory(stored, 'claude-opus-5-5', storagePath),
  ).toBe(stored)
})

test('service awaits the move and first resolve; requests make no settings filesystem calls', async () => {
  const native = runtime()
  const service = await native.service()
  expect(await service.getSettingsPath()).toBe(file)
  expect(JSON.parse(await fs.readFile(`${file}.moved`, 'utf8')).target).toBe(
    file,
  )
  expect((await native.requestView()).policyStorage.quota?.enabled).toBe(
    'default',
  )
  expect(watches).toBe(1)
  const before = settingsReads
  const readFile = spyOn(fs, 'readFile')
  try {
    await native.requestView(undefined, 'claude-opus-5-5[1m]')
    expect(settingsReads).toBe(before)
    expect(
      readFile.mock.calls.filter(([path]) => String(path).startsWith(file)),
    ).toEqual([])
  } finally {
    readFile.mockRestore()
  }
})

for (const failure of ['move', 'service open'] as const) {
  test(`Pi keeps serving legacy settings when the settings ${failure} throws`, async () => {
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        prime: { enabled: false },
        routing: { mode: 'fallback-first' },
        claudeCache: { enabled: false },
        quota: { enabled: false },
      },
      storagePath,
    )
    const options = settingsOptions()
    const fail = () => {
      throw new Error(`private settings failure at ${file}`)
    }
    if (failure === 'move') options.startup = { dependencies: { move: fail } }
    else options.service = { dependencies: { open: fail } }
    const native = runtime(options)
    const service = await native.service()
    const first = await native.requestView()
    const second = await native.requestView()
    expect(first.policyStorage.routing?.mode).toBe('fallback-first')
    expect(first.policyStorage.claudeCache?.enabled).toBe(false)
    expect(second.policyStorage.quota?.enabled).toBe(false)
    expect(await service.getSettingsPath()).not.toBe(file)
    const warnings = records.filter(
      (record) =>
        record.message ===
        'Settings startup failed; protection settings use their last applied values until the settings file can be opened.',
    )
    expect(warnings.length).toBeLessThanOrEqual(1)
    for (const warning of warnings) {
      expect(warning).toMatchObject({ level: 'warn', channel: 'settings' })
      expect(warning.payload).toBeUndefined()
      expect(warning.message).not.toContain(file)
      expect(warning.message).not.toContain('private settings failure')
    }
  })
}

test('Pi reopens a failed legacy settings service on the authority timer without retrying the move', async () => {
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled: false },
      dump: { enabled: true },
    },
    storagePath,
  )
  const options = settingsOptions()
  let moves = 0
  options.startup = {
    dependencies: {
      move: () => {
        moves++
        throw new Error('private move failure')
      },
    },
  }
  const open = options.service?.dependencies?.open
  if (!open) throw new Error('Expected the settings open test dependency')
  let unavailable = true
  let opens = 0
  options.service = {
    ...options.service,
    dependencies: {
      ...options.service?.dependencies,
      open: (settings) => {
        opens++
        if (unavailable) throw new Error('private service failure')
        return open(settings)
      },
    },
  }
  const ticks: (() => Promise<void>)[] = []
  options.authority = {
    schedule: (callback) => {
      ticks.push(callback)
      return () => {}
    },
  }
  const native = runtime(options)
  await native.service()
  expect(
    core.isDumpPersistentlyEnabled((await native.requestView()).policyStorage),
  ).toBe(true)
  expect(moves).toBe(1)
  expect(opens).toBe(1)
  expect(ticks).toHaveLength(1)
  await write({ dump_enabled: false })
  await core.writeSettingsMoveMarker(file, { env: process.env, home })
  await core.writeSettingsImportRecord(file, 'pi', { env: process.env, home })
  unavailable = false
  await ticks[0]?.()
  expect(
    core.isDumpPersistentlyEnabled((await native.requestView()).policyStorage),
  ).toBe(false)
  expect(moves).toBe(1)
  expect(opens).toBe(2)
  expect(ticks).toHaveLength(1)
  await native.close()
  expect(stops).toBe(1)
})

test('Pi serves legacy settings after a failed import write without retrying until restart', async () => {
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled: false },
      killswitch: { enabled: true, main: { five_hour: 53 } },
      routing: { mode: 'fallback-first' },
    },
    storagePath,
  )
  await write({ killswitch_enabled: false, routing_mode: 'main-first' })
  await core.writeSettingsMoveMarker(file, { env: process.env, home })
  await core.writeSettingsImportRecord(file, 'opencode', {
    env: process.env,
    home,
  })
  let attempts = 0
  const failing = await core.openSettingsService({
    file,
    dependencies: {
      writeAppliedCopy: async () => {},
      open: (options) => {
        const handle = openSettings<typeof settingsDefinition.settings>(
          settingsDefinition,
          options,
        )
        return {
          ...handle,
          update: async () => {
            attempts++
            throw new Error('synthetic settings write failure')
          },
        }
      },
    },
  })
  if (!failing) throw new Error('Expected the failing settings service')
  const outcomes: string[] = []
  const begin = core.startSettings
  const start = spyOn(core, 'startSettings').mockImplementation((options) =>
    begin({
      ...options,
      start: {
        ...options.start,
        move: async (moveOptions) => {
          const result = await core.runSettingsMoveAtStartup(moveOptions)
          outcomes.push(result.outcome)
          return result
        },
      },
    }),
  )
  const options = settingsOptions()
  const ticks: (() => Promise<void>)[] = []
  options.authority = {
    schedule: (callback) => {
      ticks.push(callback)
      return () => {}
    },
  }
  try {
    const native = getPiNativeRuntime(storagePath, {
      settings: options,
      vaultPoll: { intervalMs: 0 },
    })
    const service = await native.service()
    expect(outcomes).toEqual(['import-refused'])
    expect(attempts).toBe(1)
    await failing.dispose()
    expect(await service.getSettingsPath()).not.toBe(file)
    expect(ticks).toHaveLength(0)
    expect(watches).toBe(0)
    await expect(fs.stat(`${file}.moved.pi`)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const commands = createPiNativeCommands(storagePath)
    const before = await fs.readFile(file, 'utf8')
    if (!commands.readAccounts)
      throw new Error('Expected the Pi account reader')
    await commands.readAccounts()
    await commands.readStatus('routing', {})
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    await write({
      killswitch_enabled: { default: false, pi: true },
      killswitch_default_five_hour: 53,
      routing_mode: 'main-first',
    })
    await commands.readStatus('routing', {})
    for (let request = 0; request < 2; request++) {
      const stored = (await native.requestView()).policyStorage
      expect(core.isKillswitchEnabled(stored)).toBe(true)
      expect(core.getKillswitchThresholdsForAccount(stored).five_hour).toBe(53)
      expect(core.getRoutingMode(stored)).toBe('fallback-first')
    }
    expect(outcomes).toEqual(['import-refused'])
    expect(attempts).toBe(1)
    expect(ticks).toHaveLength(0)
    expect(records.filter((record) => record.level === 'error')).toHaveLength(0)
    await closePiNativeRuntime(storagePath)
    const restarted = getPiNativeRuntime(storagePath, {
      settings: options,
      vaultPoll: { intervalMs: 0 },
    })
    expect(
      core.getRoutingMode((await restarted.requestView()).policyStorage),
    ).toBe('main-first')
    expect(outcomes).toEqual(['import-refused', 'marker-present'])
    expect(
      JSON.parse(await fs.readFile(`${file}.moved.pi`, 'utf8')),
    ).toMatchObject({ version: 1, host: 'pi' })
  } finally {
    start.mockRestore()
    await failing.dispose()
  }
})

test('Pi imports stricter legacy protection at its own level and adopts the file in the same start', async () => {
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled: false },
      killswitch: { enabled: true, main: { five_hour: 53 } },
      routing: { mode: 'fallback-first' },
    },
    storagePath,
  )
  await write({
    killswitch_enabled: false,
    killswitch_default_five_hour: 7,
    routing_mode: 'main-first',
  })
  await core.writeSettingsMoveMarker(file, { env: process.env, home })
  await core.writeSettingsImportRecord(file, 'opencode', {
    env: process.env,
    home,
  })
  const paths = await resolveNativePoolPaths(storagePath)
  const legacy = await fs.readFile(paths.config, 'utf8')
  const native = runtime()
  const service = await native.service()
  const snapshot = (await native.requestView()).policyStorage
  expect(await service.getSettingsPath()).toBe(file)
  expect(core.isKillswitchEnabled(snapshot)).toBe(true)
  expect(core.getKillswitchThresholdsForAccount(snapshot).five_hour).toBe(53)
  expect(core.getRoutingMode(snapshot)).toBe('main-first')
  expect(
    JSON.parse(await fs.readFile(`${file}.moved.pi`, 'utf8')),
  ).toMatchObject({ version: 1, host: 'pi' })
  expect(await fs.readFile(paths.config, 'utf8')).toBe(legacy)
  const settings = await core.openSettingsService({ file })
  if (!settings) throw new Error('Expected the shared settings service')
  try {
    expect(settings.resolve('pi').killswitch_enabled).toBe(true)
    expect(settings.resolve('pi').killswitch_default_five_hour).toBe(53)
    expect(settings.resolve('opencode').killswitch_enabled).toBe(false)
    expect(settings.resolve('opencode').killswitch_default_five_hour).toBe(7)
  } finally {
    await settings.dispose()
  }
})

test('Pi keeps the stricter applied-copy floor after a moved file cannot open and recovers on the authority timer', async () => {
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled: false },
      killswitch: {
        enabled: false,
        main: { five_hour: 7, seven_day: 13, scoped: 2 },
      },
      routing: { mode: 'fallback-first' },
      dump: { enabled: true },
    },
    storagePath,
  )
  await core.writeSettingsProtectionCopy(file, 'pi', {
    readAt: Date.now(),
    values: {
      ...core.legacySettingsProtection({}, 'pi'),
      killswitch_enabled: true,
      killswitch_default_five_hour: 61,
    },
  })
  const options = settingsOptions()
  const open = options.service?.dependencies?.open
  if (!open) throw new Error('Expected the settings open test dependency')
  let unavailable = true
  let opens = 0
  options.service = {
    ...options.service,
    dependencies: {
      ...options.service?.dependencies,
      open: (settings) => {
        opens++
        if (unavailable) throw new Error('private service open failure')
        return open(settings)
      },
    },
  }
  const ticks: (() => Promise<void>)[] = []
  options.authority = {
    schedule: (callback, delayMs) => {
      expect(delayMs).toBe(60_000)
      ticks.push(callback)
      return () => {}
    },
  }
  const native = runtime(options)
  await native.service()
  expect(await fs.stat(`${file}.moved`)).toBeDefined()
  const reads = spyOn(fs, 'readFile')
  try {
    const snapshot = (await native.requestView()).policyStorage
    expect(core.getKillswitchThresholdsForAccount(snapshot).five_hour).toBe(61)
    expect(core.isKillswitchEnabled(snapshot)).toBe(true)
    expect(core.getRoutingMode(snapshot)).toBe('fallback-first')
    expect(core.isDumpPersistentlyEnabled(snapshot)).toBe(true)
    expect(
      reads.mock.calls.filter(([path]) => String(path).startsWith(file)),
    ).toEqual([])
    expect(opens).toBe(2)
  } finally {
    reads.mockRestore()
  }
  expect(ticks).toHaveLength(1)
  await write({
    killswitch_enabled: true,
    killswitch_default_five_hour: 82,
    routing_mode: 'main-first',
    dump_enabled: false,
  })
  unavailable = false
  await ticks[0]?.()
  const recovered = (await native.requestView()).policyStorage
  expect(core.getKillswitchThresholdsForAccount(recovered).five_hour).toBe(82)
  expect(core.getRoutingMode(recovered)).toBe('main-first')
  expect(core.isDumpPersistentlyEnabled(recovered)).toBe(false)
  expect(opens).toBe(3)
  expect(ticks).toHaveLength(1)
  expect(watches).toBe(1)
  await native.close()
  expect(stops).toBe(1)
})

test('Pi keeps serving when the first settings action preparation throws', async () => {
  await write({ routing_mode: 'fallback-first' })
  const acquire = core.acquireNativeAccountRuntime
  let closes = 0
  const spy = spyOn(core, 'acquireNativeAccountRuntime').mockImplementation(
    (options) => {
      const service = acquire(options)
      return {
        ...service,
        prepareSettingsAction: async () => {
          throw new Error('private authority failure')
        },
        close: () => {
          closes++
          return service.close()
        },
      }
    },
  )
  try {
    const native = runtime()
    await native.service()
    expect((await native.requestView()).policyStorage.routing?.mode).toBe(
      'fallback-first',
    )
    expect(closes).toBe(0)
    const warnings = records.filter(
      (record) =>
        record.message ===
        'Pi settings initialization failed; continuing with available settings.',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.level).toBe('warn')
  } finally {
    spy.mockRestore()
  }
})

test('five model settings resolve per request row, while unknown models use no-model values', async () => {
  await write({
    claude_cache_enabled: {
      default: 'off',
      'claude-opus-5': 'on',
      'claude-opus-5-5': 'off',
    },
    claude_cache_mode: {
      default: 'explicit',
      'claude-opus-5': 'automatic',
      'claude-opus-5-5': 'hybrid',
    },
    claude_fast_enabled: { default: false, 'claude-opus-5': true },
    cache_keep_enabled: { default: false, 'claude-opus-5': true },
    thinking_binding_prefix_mismatch_behavior: {
      default: 'account-default',
      'claude-opus-5': 'drop_block',
    },
    routing_mode: { default: 'main-first', pi: 'sticky-balanced' },
  })
  const native = runtime()
  const broad = (
    await native.requestView(undefined, 'claude-opus-5-preview[1m]')
  ).policyStorage
  expect(broad.claudeCache).toMatchObject({ enabled: 'on', mode: 'automatic' })
  expect(broad.claudeFast?.enabled).toBe(true)
  expect(broad.cacheKeep?.enabled).toBe(true)
  expect(broad.thinkingBinding?.prefixMismatchBehavior).toBe('drop_block')
  expect(broad.routing?.mode).toBe('sticky-balanced')
  const longest = (
    await native.requestView(undefined, 'claude-opus-5-5-preview[1m]')
  ).policyStorage
  expect(longest.claudeCache).toMatchObject({ enabled: 'off', mode: 'hybrid' })
  const unknown = (await native.requestView(undefined, 'unknown-model'))
    .policyStorage
  expect(unknown.claudeCache).toMatchObject({
    enabled: 'off',
    mode: 'explicit',
  })
  expect(unknown.claudeFast?.enabled).toBe(false)
  expect(unknown.cacheKeep?.enabled).toBe(false)
  expect(unknown.thinkingBinding?.prefixMismatchBehavior).toBeUndefined()
})

test('a watch edit updates the next snapshot and changes the live log level once', async () => {
  await write({ dump_enabled: false, log_level: 'info' })
  const native = runtime()
  const service = await native.service()
  expect(getLogLevel()).toBe('info')
  records.length = 0
  await write({
    dump_enabled: true,
    log_level: 'debug',
    claude_fast_enabled: true,
  })
  const snapshot = await changed(
    native,
    () => service.getSettingsStatus?.()?.values.dump_enabled === true,
  )
  expect(snapshot.policyStorage.dump?.enabled).toBe(true)
  expect(snapshot.policyStorage.claudeFast?.enabled).toBe(true)
  expect(getLogLevel()).toBe('debug')
  expect(
    records.filter((record) => record.message === 'log level changed'),
  ).toHaveLength(1)
})

test('startup leaves the live log level alone when the environment selects it', async () => {
  process.env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL = 'error'
  setLogLevel('error')
  await write({ log_level: 'debug' })
  await runtime().service()
  expect(getLogLevel()).toBe('error')
  expect(
    records.filter((record) => record.message === 'log level changed'),
  ).toHaveLength(0)
})

test('each runtime owns a lease; the shared user-file watch stops only after the last closes', async () => {
  await write({})
  const first = runtime()
  await first.service()
  const second = runtime()
  await second.service()
  expect(watches).toBe(1)
  await first.close()
  expect(stops).toBe(0)
  await second.close()
  expect(stops).toBe(1)
})

test('different settings targets never reuse a Pi runtime or service', async () => {
  await write({ claude_fast_enabled: true })
  const first = getPiNativeRuntime(storagePath, {
    settings: settingsOptions(),
    vaultPoll: { intervalMs: 0 },
  })
  await first.service()
  process.env.ANTHROPIC_AUTH_SETTINGS_FILE = join(home, 'other.jsonc')
  await fs.writeFile(
    process.env.ANTHROPIC_AUTH_SETTINGS_FILE,
    '{"schema_version":1,"prime_enabled":false,"claude_fast_enabled":false}',
  )
  const second = getPiNativeRuntime(storagePath, {
    settings: settingsOptions(),
    vaultPoll: { intervalMs: 0 },
  })
  expect(second).not.toBe(first)
  expect((await first.requestView()).policyStorage.claudeFast?.enabled).toBe(
    true,
  )
  expect((await second.requestView()).policyStorage.claudeFast?.enabled).toBe(
    false,
  )
})

test('a source-lock timeout bounds startup and preserves legacy mode', async () => {
  const paths = await resolveNativePoolPaths(storagePath)
  const lock = nativePoolStoreLocks(paths)[0]
  const options = settingsOptions()
  options.startup = {
    dependencies: {
      prepareSources: async (input) => {
        const prepared = await prepareSettingsMoveSources(input)
        if (prepared.status === 'ready')
          for (const source of prepared.sources)
            source.locks = source.locks.map((spec) => ({
              ...spec,
              timeoutMs: 30,
            }))
        return prepared
      },
    },
  }
  await withLock(
    lock.path,
    { name: lock.name, ttlMs: 10000, timeoutMs: 100 },
    async () => {
      const started = Date.now()
      const native = runtime(options)
      await native.service()
      expect(Date.now() - started).toBeLessThan(2000)
      expect(
        (await native.requestView()).policyStorage.quota?.enabled,
      ).toBeUndefined()
      expect(
        await fs.stat(`${file}.moved`).catch(() => undefined),
      ).toBeUndefined()
      expect(await fs.stat(file).catch(() => undefined)).toBeUndefined()
    },
  )
})

for (const variable of [
  'PI_ANTHROPIC_AUTH_FILE',
  'PI_CODING_AGENT_DIR',
  'PI_AGENT_DIR',
] as const) {
  test(`separate ${variable} install neither reads nor watches the default user file nor gets schema defaults`, async () => {
    delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
    delete process.env.PI_CODING_AGENT_DIR
    delete process.env.PI_AGENT_DIR
    delete process.env.PI_ANTHROPIC_AUTH_FILE
    if (variable === 'PI_ANTHROPIC_AUTH_FILE')
      process.env[variable] = storagePath = join(
        home,
        'private',
        'anthropic-auth.json',
      )
    else {
      process.env[variable] = join(home, 'private-agent')
      storagePath = join(process.env[variable], 'anthropic-auth.json')
    }
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        prime: { enabled: false },
        routing: { mode: 'sticky-balanced' },
      },
      storagePath,
    )
    if (variable !== 'PI_CODING_AGENT_DIR')
      delete process.env.PI_CODING_AGENT_DIR
    const target = getSettingsFilePath({ env: process.env, home })
    await fs.mkdir(join(target, '..'), { recursive: true })
    await fs.writeFile(
      target,
      '{"schema_version":1,"routing_mode":"main-first"}',
    )
    const userBefore = await fs.readFile(target, 'utf8')
    const readFile = spyOn(fs, 'readFile')
    try {
      const native = runtime()
      const service = await native.service()
      const paths = await resolveNativePoolPaths(storagePath)
      expect(await service.getSettingsPath()).toBe(paths.config)
      const storage = (await native.requestView()).policyStorage
      expect(storage.routing?.mode).toBe('sticky-balanced')
      expect(storage.quota?.enabled).toBeUndefined()
      await service.updateSettings((stored) => ({
        ...stored,
        dump: { enabled: true },
      }))
      expect((await native.requestView()).policyStorage.dump?.enabled).toBe(
        true,
      )
      expect(
        readFile.mock.calls.filter(([path]) => String(path).startsWith(target)),
      ).toEqual([])
      expect(watches).toBe(0)
      expect(settingsReads).toBe(0)
      expect(await fs.exists(`${target}.moved`)).toBe(false)
    } finally {
      readFile.mockRestore()
    }
    expect(await fs.readFile(target, 'utf8')).toBe(userBefore)
    const paths = await resolveNativePoolPaths(storagePath)
    expect(JSON.parse(await fs.readFile(paths.config, 'utf8')).dump).toEqual({
      enabled: true,
    })
  })
}

test('an OpenCode store override does not make Pi separate', async () => {
  delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    home,
    'other-install',
    'anthropic-auth.json',
  )
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled: false },
      routing: { mode: 'fallback-first' },
    },
    storagePath,
  )
  file = getSettingsFilePath({ env: process.env, home })
  const native = runtime()
  const service = await native.service()
  expect(await service.getSettingsPath()).toBe(file)
  expect(await fs.exists(`${file}.moved`)).toBe(true)
  expect(core.getRoutingMode((await native.requestView()).policyStorage)).toBe(
    'fallback-first',
  )
})

for (const overridden of [false, true])
  test(`absolute shared target moves Pi's resolved stores with Pi override ${overridden}`, async () => {
    const defaultPaths = await resolveNativePoolPaths(storagePath)
    const defaults = core.createNativePoolStore({
      paths: defaultPaths,
      quota: nativeQuotaCodec,
    })
    await defaults.updateSettings((stored) => ({
      ...stored,
      routing: { mode: 'main-first' },
    }))
    await defaults.close()
    if (overridden)
      storagePath = join(home, 'private-agent', 'anthropic-auth.json')
    process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
    await saveNativePiFixture(
      {
        version: 1,
        accounts: [],
        prime: { enabled: false },
        routing: { mode: 'fallback-first' },
      },
      storagePath,
    )
    const own = await resolveNativePoolPaths(storagePath)
    const sourceBytes = await fs.readFile(own.config, 'utf8')
    const peerAccount = join(home, '.config', 'opencode', 'anthropic-auth.json')
    const peerPaths = await resolveNativePoolPaths(
      peerAccount,
      join(home, '.config', 'opencode', 'anthropic-auth-state.json'),
    )
    const peer = core.createNativePoolStore({
      paths: peerPaths,
      quota: nativeQuotaCodec,
    })
    await peer.initialize()
    await peer.updateSettings(() => ({ routing: { mode: 'sticky-balanced' } }))
    await peer.close()
    const readFile = spyOn(fs, 'readFile')
    try {
      const native = runtime()
      const service = await native.service()
      expect(await service.getSettingsPath()).toBe(file)
      expect(
        core.getRoutingMode((await native.requestView()).policyStorage),
      ).toBe('fallback-first')
      expect(await fs.exists(`${file}.moved`)).toBe(true)
      const reads = readFile.mock.calls.map(([path]) => String(path))
      expect(reads).not.toContain(peerAccount)
      expect(reads).not.toContain(peerPaths.config)
      expect(reads).not.toContain(nativeVaultPaths(peerPaths).config)
      if (overridden) expect(reads).not.toContain(defaultPaths.config)
    } finally {
      readFile.mockRestore()
    }
    expect(await fs.readFile(own.config, 'utf8')).toBe(sourceBytes)
    expect(await fs.exists(`${own.config}.MOVED_READPLEASE`)).toBe(true)
    expect(await fs.exists(`${peerPaths.config}.MOVED_READPLEASE`)).toBe(false)
  })

test('every claude action rechecks a peer marker without a request-path authority read', async () => {
  const options = settingsOptions()
  options.startup = { fence: { registration: undefined } }
  // An unregistered start cannot move, but it must retain the service's watch.
  const native = getPiNativeRuntime(storagePath, {
    settings: options,
    vaultPoll: { intervalMs: 0 },
  })
  await native.service()
  expect((await native.requestView()).policyStorage.dump).toBeUndefined()
  await write({ dump_enabled: true })
  await fs.writeFile(
    `${file}.moved`,
    JSON.stringify({ version: 1, target: file, at: Date.now() }),
  )
  const commands = createPiNativeCommands(storagePath)
  expect(await commands.readStatus('dump', {})).toContain('enabled')
  expect((await native.requestView()).policyStorage.dump?.enabled).toBe(true)
})

for (const mode of ['local', 'claustrum'] as const)
  test(`projected three-way strings never reach a ${mode} legacy store write after moving`, async () => {
    const stored: core.AccountStorage = {
      version: 1,
      accounts: [],
      prime: { enabled: false },
      claudeCache: { enabled: false },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
    }
    await saveNativePiFixture(stored, storagePath)
    const paths = await resolveNativePoolPaths(storagePath)
    if (mode === 'claustrum') await seedVaultSettings(paths, stored)
    const selected = mode === 'claustrum' ? nativeVaultPaths(paths) : paths
    const before = await fs.readFile(selected.config, 'utf8')
    const commits: Record<string, unknown>[] = []
    const native = new PiNativeRuntime(storagePath, {
      settings: settingsOptions(),
      vaultPoll: { intervalMs: 0 },
      local: {
        onLockEvent: (event) => {
          if (
            event.type === 'released' &&
            event.name === 'pool-config' &&
            event.path === selected.config
          )
            commits.push(JSON.parse(readFileSync(event.path, 'utf8')))
        },
      },
    })
    runtimes.push(native)
    const service = await native.service()
    expect((await native.view()).policyStorage.quota?.enabled).toBe('off')
    expect(
      (
        await service.updateSettings((stored) => ({
          ...stored,
          nativeAccountOrder: ['main'],
        }))
      ).outcome,
    ).toBe('saved')
    if (mode === 'local') await service.setEnabled('main', false)
    const after = await fs.readFile(selected.config, 'utf8')
    const oldSettings = JSON.parse(before)
    const settings = JSON.parse(after)
    expect(oldSettings.claudeCache).toEqual({ enabled: false })
    expect(oldSettings.quota).toMatchObject({
      enabled: false,
      failClosedOnUnknownQuota: false,
    })
    expect(settings.claudeCache).toEqual(oldSettings.claudeCache)
    expect(settings.quota).toEqual(oldSettings.quota)
    expect(JSON.stringify([settings.claudeCache, settings.quota])).not.toMatch(
      /"(?:default|on|off)"/,
    )
    expect(commits.length).toBeGreaterThan(0)
    for (const committed of commits) {
      expect(committed.claudeCache).toEqual(oldSettings.claudeCache)
      expect(committed.quota).toEqual(oldSettings.quota)
    }
  })

async function seedVaultSettings(
  paths: core.NativePoolPaths,
  stored: core.AccountStorage,
) {
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    home,
    'enrollment.json',
  )
  const enrollment = core.getHostClaustrumEnrollmentPaths('pi')
  await fs.writeFile(
    enrollment.tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await fs.writeFile(
    enrollment.statePath,
    JSON.stringify({
      version: 1,
      phase: 'approved',
      proposedName: 'anthropic-auth-pi',
      tokenGeneration: 1,
      updatedAt: 1,
    }),
    { mode: 0o600 },
  )
  const store = core.createNativePoolStore({
    paths: nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  })
  await store.initialize()
  await store.updateSettings(() => nativeAccountSettings(stored))
  await store.close()
}

for (const mode of ['local', 'claustrum'] as const)
  for (const peer of ['absent', 'same'] as const)
    for (const fixture of ['explicit', 'absent'] as const)
      test(`2.11.2 byte snapshots: ${mode}, OpenCode ${peer}, three-way ${fixture}`, async () => {
        delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
        file = getSettingsFilePath({ env: process.env, home })
        const stored = snapshotSettings(fixture === 'absent')
        await saveNativePiFixture(stored, storagePath)
        const paths = await resolveNativePoolPaths(storagePath)
        const store = core.createNativePoolStore({
          paths,
          quota: nativeQuotaCodec,
        })
        await store.updateSettings(() => nativeAccountSettings(stored))
        await store.close()
        if (mode === 'claustrum') await seedVaultSettings(paths, stored)
        if (peer === 'same') {
          const peerPaths = await resolveNativePoolPaths(
            join(home, '.config', 'opencode', 'anthropic-auth.json'),
            join(home, '.config', 'opencode', 'anthropic-auth-state.json'),
          )
          const other = core.createNativePoolStore({
            paths: peerPaths,
            quota: nativeQuotaCodec,
          })
          await other.initialize()
          await other.updateSettings(() => nativeAccountSettings(stored))
          await other.close()
        }
        const selected = mode === 'claustrum' ? nativeVaultPaths(paths) : paths
        const sourceBytes = await fs.readFile(selected.config, 'utf8')
        const legacy = core.createNativeAccountRuntime({ paths, host: 'pi' })
        const before = (await legacy.read()).policyStorage
        await legacy.close()
        expect(Object.keys(snapshotReaderOutputs(before)).sort()).toEqual(
          Object.keys(core.SETTINGS_DEFAULT_READERS).sort(),
        )
        expect(
          [
            ...core.SETTINGS_THREE_WAY_READERS.claude_cache_enabled,
            ...core.SETTINGS_THREE_WAY_READERS.quota_enabled,
          ]
            .filter(({ path }) => path.startsWith('packages/pi/'))
            .map(({ reader }) => String(reader))
            .sort(),
        ).toEqual(
          [
            'sendAnthropicRequest (via isCache1hPersistentlyEnabled)',
            'createPiNativeCommands status cache (via isCache1hPersistentlyEnabled)',
            'requestPolicy (via quotaSnapshotPassesPolicy)',
            'getPiRoutingServices getUsableFallbackAccounts (via quotaSnapshotPassesPolicy)',
          ].sort(),
        )
        const settings = settingsOptions()
        settings.startup = {
          readMode: async (host) => (host === 'pi' ? mode : 'local'),
        }
        const native = runtime(settings)
        const after = (await native.view()).policyStorage
        expect(await (await native.service()).getSettingsPath()).toBe(file)
        expect(await fs.exists(`${file}.moved`)).toBe(true)
        expect(await fs.readFile(selected.config, 'utf8')).toBe(sourceBytes)
        const expected = JSON.stringify(releaseSnapshots[fixture])
        for (const [phase, storage] of [
          ['before', before],
          ['after', after],
        ] as const) {
          const observed = await observeSettings(
            storage,
            join(home, `observe-${phase}`, 'anthropic-auth.json'),
          )
          expect(JSON.stringify(observed), phase).toBe(expected)
          expect(observed.sends).toHaveLength(1)
          expect(observed.logs.length).toBeGreaterThan(0)
          expect(observed.tracks).toHaveLength(1)
        }
      })

function readerOutputs(storage: core.AccountStorage) {
  const main = core.getKillswitchThresholdsForAccount(storage)
  const minimum = core.getQuotaMinimumRemainingThresholds(storage)
  const noteBody = {
    model: 'claude-opus-5-5',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'x'.repeat(20000) },
          { type: 'tool_use', id: 'one', name: 'custom', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'one', content: 'ok' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  }
  core.applyTurnEndNotes(noteBody, storage.turnEndNote)
  const outputs = {
    routing_mode: core.getRoutingMode(storage),
    max_same_account_wait: core.getMaxSameAccountWait(storage),
    fallback_on: [401, 403, 418, 429, 503].map((status) =>
      core.shouldFallbackStatus(status, storage),
    ),
    refresh_enabled: storage.refresh?.enabled !== false,
    refresh_interval_minutes: core.getRefreshIntervalMs(storage),
    refresh_refresh_before_expiry_minutes:
      core.getRefreshBeforeExpiryMs(storage),
    quota_enabled: core.quotaEnabled(storage),
    quota_check_interval_minutes: core.getQuotaCheckIntervalMs(storage),
    quota_refresh_every_n_requests: core.getQuotaRefreshEveryNRequests(storage),
    quota_minimum_remaining_five_hour: minimum.five_hour,
    quota_minimum_remaining_seven_day: minimum.seven_day,
    quota_minimum_remaining_scoped: core.normalizeKillswitchThresholds(
      storage.quota?.minimumRemaining,
    ).scoped,
    quota_fail_closed_on_unknown_quota: core.failClosedOnUnknownQuota(storage),
    quota_show_toasts: storage.quota?.showToasts === true,
    quota_header_feed_enabled: storage.quotaHeaderFeed?.enabled === true,
    killswitch_enabled: core.isKillswitchEnabled(storage),
    killswitch_default_five_hour: main.five_hour,
    killswitch_default_seven_day: main.seven_day,
    killswitch_default_scoped: main.scoped,
    killswitch_account_floors: core.getKillswitchConfig(storage).accounts,
    claude_cache_enabled: core.isCache1hPersistentlyEnabled(storage),
    claude_cache_mode: core.getCache1hPersistentMode(storage),
    cache_keep_enabled: core.isCacheKeepPersistentlyEnabled(storage),
    cache_keep_always: core.isCacheKeepAlways(storage),
    cache_keep_window: core.getCacheKeepWindow(storage),
    cache_keep_subagents: core.isCacheKeepSubagentsEnabled(storage),
    dump_enabled: core.isDumpPersistentlyEnabled(storage),
    prime_enabled: core.isPrimePersistentlyEnabled(storage),
    claude_fast_enabled: core.isFastModePersistentlyEnabled(storage),
    cost_zeroing_enabled: core.isCostZeroingEnabled(storage),
    log_level: core.getPersistedLogLevel(storage),
    thinking_binding_prefix_mismatch_behavior:
      core.getThinkingPrefixMismatchBehavior(storage),
    turn_end_note_tools: noteBody,
  }
  expect(Object.keys(outputs).sort()).toEqual(
    Object.keys(core.SETTINGS_DEFAULT_READERS).sort(),
  )
  return JSON.stringify(outputs)
}

for (const mode of ['local', 'claustrum'] as const)
  for (const peer of ['absent', 'same'] as const) {
    test(`every moved setting preserves reader and wire outputs in ${mode} custody with OpenCode ${peer}`, async () => {
      delete process.env.ANTHROPIC_AUTH_SETTINGS_FILE
      file = join(home, '.config', 'cortexkit', 'anthropic-auth.jsonc')
      const stored: core.AccountStorage = {
        version: 1,
        accounts: [],
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
          minimumRemaining: { five_hour: 17, seven_day: 19, scoped: 4 },
          failClosedOnUnknownQuota: false,
          showToasts: true,
        },
        quotaHeaderFeed: { enabled: true },
        killswitch: {
          enabled: true,
          main: { five_hour: 9, seven_day: 21, scoped: 3 },
          accounts: {
            'vault:sample': { five_hour: 7, seven_day: 18, scoped: 2 },
          },
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
      await saveNativePiFixture(stored, storagePath)
      const paths = await resolveNativePoolPaths(storagePath)
      const localStore = core.createNativePoolStore({
        paths,
        quota: nativeQuotaCodec,
      })
      await localStore.updateSettings((current) => ({
        ...current,
        ...nativeAccountSettings(stored),
      }))
      await localStore.close()
      if (mode === 'claustrum') await seedVaultSettings(paths, stored)
      if (peer === 'same') {
        const peerPaths = await resolveNativePoolPaths(
          join(home, '.config', 'opencode', 'anthropic-auth.json'),
          join(home, '.config', 'opencode', 'anthropic-auth-state.json'),
        )
        const store = core.createNativePoolStore({
          paths: peerPaths,
          quota: nativeQuotaCodec,
        })
        await store.initialize()
        await store.updateSettings(() => nativeAccountSettings(stored))
        await store.close()
      }
      const legacy = core.createNativeAccountRuntime({ paths, host: 'pi' })
      const before = (await legacy.read()).policyStorage
      await legacy.close()
      const settings = settingsOptions()
      settings.startup = {
        readMode: async (host) => (host === 'pi' ? mode : 'local'),
      }
      const readFile = spyOn(fs, 'readFile')
      let after: core.AccountStorage
      try {
        const native = runtime(settings)
        after = (await native.view()).policyStorage
        expect(await (await native.service()).getSettingsPath()).toBe(file)
        expect(await fs.stat(`${file}.moved`)).toBeDefined()
        // Holder and lock code reads these kernel files to identify processes;
        // they contain no user data. Every user-data read stays in the sandbox.
        const kernelIdentity =
          /^\/proc\/(?:sys\/kernel\/random\/boot_id|\d+\/stat)$/
        expect(
          readFile.mock.calls
            .map(([path]) => String(path))
            .filter(
              (path) =>
                !path.startsWith(`${home}/`) && !kernelIdentity.test(path),
            ),
        ).toEqual([])
      } finally {
        readFile.mockRestore()
      }
      expect(readerOutputs(after)).toBe(readerOutputs(before))
      const wire = (storage: core.AccountStorage) =>
        buildAnthropicRequest(
          'claude-opus-5-5',
          { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] },
          undefined,
          {
            enabled: core.isCache1hPersistentlyEnabled(storage),
            mode: core.getCache1hPersistentMode(storage),
          },
          core.isFastModePersistentlyEnabled(storage),
          undefined,
          {
            turnEndNote: storage.turnEndNote,
            thinkingPrefixMismatchBehavior:
              core.getThinkingPrefixMismatchBehavior(storage),
          },
        )
      expect((await wire(after)).bodyText).toBe((await wire(before)).bodyText)
    })
  }

test('runtime eviction releases its settings lease and closes the last user-file watch', async () => {
  const entries: PiNativeRuntime[] = []
  const add = async (index: number) => {
    process.env.ANTHROPIC_AUTH_SETTINGS_FILE = join(
      home,
      `eviction-${index}.jsonc`,
    )
    await fs.writeFile(
      process.env.ANTHROPIC_AUTH_SETTINGS_FILE,
      '{"schema_version":1,"prime_enabled":false}',
    )
    const native = getPiNativeRuntime(storagePath, {
      settings: settingsOptions(),
      vaultPoll: { intervalMs: 0 },
    })
    entries.push(native)
    return native
  }
  for (let index = 0; index < 16; index++) await add(index)
  await Promise.all(entries.map((native) => native.service()))
  await (await add(16)).service()
  await entries[0]?.close()
  expect(watches).toBe(17)
  expect(stops).toBe(1)
  await expect(entries[0]?.service()).rejects.toThrow('closed')
})

test('the stream applies model settings and mirrors dump_enabled from every snapshot', async () => {
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = join(home, 'dumps')
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          id: 'paid',
          type: 'api',
          apiKey: 'synthetic-settings-key',
          baseURL: 'https://api.anthropic.com',
        },
      ],
      prime: { enabled: false },
    },
    storagePath,
  )
  await write({
    dump_enabled: true,
    claude_fast_enabled: { default: false, 'claude-opus-5-5': true },
  })
  const native = runtime()
  const service = await native.service()
  const apiAccount = (await native.view()).accounts.find(
    (account) => account.type === 'api',
  )
  const bodies: Record<string, unknown>[] = []
  const send = () =>
    __sendPiAnthropicRequestForTest(
      {
        storagePath,
        apiAccount,
        model: {
          id: 'claude-opus-5-5',
          name: 'Opus',
          provider: 'anthropic',
          api: 'cortexkit-anthropic-messages',
          baseUrl: 'https://api.anthropic.com',
          reasoning: true,
          input: ['text'],
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          contextWindow: 1000000,
          maxTokens: 128000,
        },
        context: {
          messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
        },
      },
      {
        native,
        fetch: Object.assign(
          async (
            _input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) => {
            bodies.push(JSON.parse(String(init?.body)))
            return new Response('{}')
          },
          { preconnect: fetch.preconnect },
        ),
      },
    )
  core.setDumpEnabled(false)
  await send()
  expect(core.isDumpEnabled()).toBe(true)
  expect(bodies[0]?.speed).toBe('fast')
  await write({ dump_enabled: false, claude_fast_enabled: false })
  await changed(
    native,
    () => service.getSettingsStatus?.()?.values.dump_enabled === false,
  )
  core.setDumpEnabled(true)
  await send()
  expect(core.isDumpEnabled()).toBe(false)
  expect(bodies[1]?.speed).toBeUndefined()
})

for (const peer of ['never ran', 'stricter'] as const) {
  test(`Pi ${peer === 'never ran' ? 'refuses to recreate a missing explicit-target settings file when no OpenCode store is found' : "recreates a missing settings file when OpenCode's store is stricter"}`, async () => {
    await core.writeSettingsMoveMarker(file)
    // The test preload points OpenCode's state file elsewhere; an OpenCode
    // path override set here would leave OpenCode's store unknown.
    delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
    if (peer === 'stricter') {
      // OpenCode's own settings store (its account pool) under the same home.
      const store = join(
        dirname(core.getDefaultSettingsStorePaths('opencode').account),
        'anthropic-auth-pool.json',
      )
      await fs.mkdir(dirname(store), { recursive: true })
      await fs.writeFile(
        store,
        JSON.stringify({
          version: 1,
          accounts: [],
          killswitch: { enabled: true, main: { five_hour: 55 } },
        }),
      )
    }
    const native = runtime()
    const service = await native.service()
    const result = await service.updateSettings((stored) => ({
      ...stored,
      dump: { enabled: true },
    }))
    if (peer === 'never ran') {
      // Under an explicit target an OpenCode with a private store could share
      // the file, so a missing default store leaves its protection unknown.
      expect(result.outcome).toBe('refused')
      await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    expect(result.outcome).toBe('saved')
    const written = parse(await fs.readFile(file, 'utf8'))
    expect(written).toHaveProperty('dump_enabled')
    if (peer === 'stricter')
      expect(written.killswitch_default_five_hour).toMatchObject({
        opencode: 55,
      })
  })
}
