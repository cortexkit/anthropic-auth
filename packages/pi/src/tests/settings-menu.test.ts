import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  createNativePoolStore,
  getHostClaustrumEnrollmentPaths,
  getLogLevel,
  getNativeMenuModel,
  malformedSettingsText,
  type NativeAccountRuntimeOptions,
  type NativeMenuDispatchRequest,
  type NativeMenuRequest,
  openSettingsService,
  refusedSettingsRecreationText,
  refusedSettingsWriteText,
  resolveNativePoolPaths,
  SETTINGS_WRITE_FAILURES,
  setLogLevel,
  settingsDefinition,
} from '@cortexkit/anthropic-auth-core'
import {
  openSettings,
  type SettingsRefusal,
  type SettingsRefusalCode,
} from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import { nativeAccountSettings } from '../../../core/src/native-account-view.ts'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { writeSettingsProtectionCopy } from '../../../core/src/settings-protection-copy.ts'
import { legacySettingsProtection } from '../../../core/src/settings-protection-legacy.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import { createPiNativeCommands } from '../native-commands.ts'
import { saveNativePiFixture } from './native-fixture.ts'

let home: string
let storagePath: string
let file: string
let original: NodeJS.ProcessEnv
const level = getLogLevel()

beforeEach(async () => {
  original = { ...process.env }
  home = await fs.mkdtemp(join(tmpdir(), 'pi-settings-menu-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.XDG_STATE_HOME = join(home, 'state')
  for (const key of [
    'PI_AGENT_DIR',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_ANTHROPIC_AUTH_FILE',
    'OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL',
    'ANTHROPIC_AUTH_SETTINGS_FILE',
  ])
    delete process.env[key]
  storagePath = join(home, '.pi', 'agent', 'anthropic-auth.json')
  file = join(home, '.config', 'cortexkit', 'anthropic-auth.jsonc')
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  process.env.PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(home, 'cachekeep')
  process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(home, 'routing.json')
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      prime: { enabled: false },
      claudeCache: { enabled: false },
      quota: { enabled: false, failClosedOnUnknownQuota: false },
    },
    storagePath,
  )
})

afterEach(async () => {
  await closePiNativeRuntime(storagePath)
  setLogLevel(level)
  for (const key of Object.keys(process.env))
    if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
  await fs.rm(home, { recursive: true, force: true })
})

async function writeFile(values: Record<string, unknown> = {}) {
  await fs.mkdir(join(home, '.config', 'cortexkit'), { recursive: true })
  await fs.writeFile(
    file,
    `{
  // Keep the user's explanation.
  "unknown_setting": { "keep": "verbatim" },
  ${Object.entries({ schema_version: 1, prime_enabled: false, ...values })
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join('\n  ')}
}\n`,
  )
}

async function handleRefusal(code: SettingsRefusalCode) {
  const probe = join(home, 'refusal-probe.jsonc')
  await fs.writeFile(probe, '{}')
  // The probe writes as a host that uses the file.
  const service = await openSettingsService({
    file: probe,
    host: 'pi',
    adopted: () => true,
  })
  if (!service) throw new Error('Probe settings service unavailable')
  try {
    await service.update([{ setting: 'log_level', value: 'invalid' }], 'pi')
    throw new Error('Invalid level was accepted')
  } catch (error) {
    // Core bundles its settings dependency, so use the production handle's error class.
    if (!(error instanceof Error) || !('code' in error)) throw error
    const Refusal = error.constructor as typeof SettingsRefusal
    return new Refusal(code, 'private dependency details')
  } finally {
    await service.dispose()
  }
}

async function controller(
  refusal?: SettingsRefusalCode | 'error',
  legacy = false,
  local?: NativeAccountRuntimeOptions['local'],
) {
  const failure =
    refusal && refusal !== 'error' ? await handleRefusal(refusal) : undefined
  const scheduled: { callback: () => void; delayMs: number }[] = []
  const native = getPiNativeRuntime(storagePath, {
    local,
    settings: {
      home,
      startup: legacy ? { fence: { registration: undefined } } : undefined,
      service: {
        dependencies: {
          writeAppliedCopy: async () => {},
          schedule: (callback, delayMs) => {
            scheduled.push({ callback, delayMs })
            return () => {}
          },
          open: (options) => {
            const handle = openSettings<typeof settingsDefinition.settings>(
              settingsDefinition,
              options,
            )
            return {
              ...handle,
              watch: () => () => {},
              update: async (edits, context) => {
                if (refusal === 'error')
                  throw new Error('private dependency details')
                if (failure) throw failure
                return handle.update(edits, context)
              },
            }
          },
        },
      },
    },
    vaultPoll: { intervalMs: 0 },
  })
  const runtime = await native.service()
  const backend = createPiNativeCommands(storagePath)
  return {
    runtime,
    backend,
    confirmMissing: async () => {
      await runtime.updateSettings((settings) => settings)
      const grace = scheduled.find(({ delayMs }) => delayMs === 2000)
      expect(grace).toBeDefined()
      grace?.callback()
      await runtime.updateSettings((settings) => settings)
    },
    execute: (request: NativeMenuRequest) =>
      backend.dispatch(
        {
          ...request,
          values: request.values ?? {},
        } as NativeMenuDispatchRequest,
        { signal: new AbortController().signal },
      ),
  }
}

type SettingCase = {
  request: NativeMenuRequest
  initial: Record<string, unknown>
  expected: Record<string, unknown>
  legacy: Record<string, unknown>
}

const actions: SettingCase[] = [
  {
    request: { action: 'routing-mode', values: { mode: 'sticky-balanced' } },
    initial: {},
    expected: { routing_mode: 'sticky-balanced' },
    legacy: { routing: { mode: 'sticky-balanced' } },
  },
  ...(
    [
      ['0', 'off'],
      ['15', '15m'],
      ['max', 'cache'],
    ] as const
  ).map(([maxSameAccountWait, value]) => ({
    request: {
      action: 'routing-max-same-account-wait',
      values: { maxSameAccountWait },
    } as NativeMenuRequest,
    initial: { max_same_account_wait: value === '15m' ? 'off' : '15m' },
    expected: { max_same_account_wait: value },
    legacy: { routing: { maxSameAccountWait } },
  })),
  {
    request: { action: 'killswitch-on' },
    initial: {},
    expected: { killswitch_enabled: true },
    legacy: { killswitch: { enabled: true } },
  },
  {
    request: { action: 'killswitch-off' },
    initial: { killswitch_enabled: true },
    expected: { killswitch_enabled: false },
    legacy: { killswitch: { enabled: false } },
  },
  {
    request: {
      action: 'killswitch-set',
      values: { entries: [{ account: 'main', fh: 3, sd: 4 }] },
    },
    initial: {},
    expected: {
      killswitch_enabled: true,
      killswitch_default_five_hour: 3,
      killswitch_default_seven_day: 4,
    },
    legacy: {
      killswitch: {
        enabled: true,
        main: { five_hour: 3, seven_day: 4, scoped: 0 },
      },
    },
  },
  ...([true, false] as const).map((enabled) => ({
    request: {
      action: enabled ? 'cache-on' : 'cache-off',
    } as NativeMenuRequest,
    initial: { claude_cache_enabled: enabled ? 'off' : 'on' },
    expected: { claude_cache_enabled: enabled ? 'on' : 'off' },
    legacy: { claudeCache: { enabled } },
  })),
  {
    request: { action: 'cache-mode', values: { mode: 'automatic' } },
    initial: {},
    expected: { claude_cache_mode: 'automatic' },
    legacy: { claudeCache: { mode: 'automatic' } },
  },
  {
    request: { action: 'cachekeep-always' },
    initial: { cache_keep_window: [{ start_hour: 9, end_hour: 17 }] },
    expected: { cache_keep_enabled: true, cache_keep_always: true },
    legacy: { cacheKeep: { enabled: true, always: true } },
  },
  {
    request: { action: 'cachekeep-off' },
    initial: { cache_keep_enabled: true },
    expected: { cache_keep_enabled: false },
    legacy: { cacheKeep: { enabled: false } },
  },
  {
    request: {
      action: 'cachekeep-window',
      values: { startHour: 8, endHour: 18 },
    },
    initial: {},
    expected: {
      cache_keep_enabled: true,
      cache_keep_window: [{ start_hour: 8, end_hour: 18 }],
    },
    legacy: {
      cacheKeep: { enabled: true, always: false, startHour: 8, endHour: 18 },
    },
  },
  {
    request: { action: 'cachekeep-subagents', values: { enabled: 'on' } },
    initial: {},
    expected: { cache_keep_subagents: true },
    legacy: { cacheKeep: { subagents: true } },
  },
  ...(['dump', 'fast', 'prime'] as const).flatMap((key) =>
    [true, false].map((enabled) => ({
      request: {
        action: `${key}-${enabled ? 'on' : 'off'}`,
      } as NativeMenuRequest,
      initial: {
        [`${key === 'fast' ? 'claude_fast' : key}_enabled`]: !enabled,
      },
      expected: {
        [`${key === 'fast' ? 'claude_fast' : key}_enabled`]: enabled,
      },
      legacy: { [key === 'fast' ? 'claudeFast' : key]: { enabled } },
    })),
  ),
  {
    request: { action: 'logging-level', values: { level: 'debug' } },
    initial: {},
    expected: { log_level: 'debug' },
    legacy: { logging: { level: 'debug' } },
  },
]

test('Pi labels the same-account wait by its full meaning', () => {
  expect(
    getNativeMenuModel('pi', 'local')
      .groups.flatMap(({ actions }) => actions)
      .find(({ id }) => id === 'routing-max-same-account-wait')?.label,
  ).toBe('Longest wait on the same account')
})

for (const mode of ['user-file', 'legacy', 'separate'] as const)
  for (const [index, setting] of actions.entries())
    test(`${mode}: ${setting.request.action} (${index}) writes the selected settings target`, async () => {
      if (mode !== 'legacy') await writeFile(setting.initial)
      if (mode === 'separate') {
        storagePath = join(home, 'separate', 'anthropic-auth.json')
        process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
      }
      const paths = await resolveNativePoolPaths(storagePath)
      if (mode === 'separate')
        await saveNativePiFixture(
          { version: 1, accounts: [], prime: { enabled: false } },
          storagePath,
        )
      const before = await fs.readFile(paths.config, 'utf8')
      const userBefore =
        mode === 'separate' ? await fs.readFile(file, 'utf8') : undefined
      const f = await controller(undefined, mode === 'legacy')
      expect(await f.runtime.getSettingsPath()).toBe(
        mode === 'user-file' ? file : paths.config,
      )
      expect((await f.execute(setting.request)).ok).toBe(true)
      if (mode === 'user-file') {
        const text = await fs.readFile(file, 'utf8')
        expect(text).toContain("// Keep the user's explanation.")
        expect(parse(text)).toMatchObject({
          unknown_setting: { keep: 'verbatim' },
          ...setting.expected,
        })
        expect(await fs.readFile(paths.config, 'utf8')).toBe(before)
        if (setting.request.action === 'cachekeep-always')
          expect(parse(text)).not.toHaveProperty('cache_keep_window')
        if (setting.request.action === 'cachekeep-subagents')
          expect(
            Object.keys(parse(text)).filter((key) =>
              key.startsWith('cache_keep_'),
            ),
          ).toEqual(['cache_keep_subagents'])
      } else {
        expect(parse(await fs.readFile(paths.config, 'utf8'))).toMatchObject(
          setting.legacy,
        )
        if (userBefore) expect(await fs.readFile(file, 'utf8')).toBe(userBefore)
        else expect(await fs.exists(file)).toBe(false)
      }
    })

for (const setting of actions)
  test(`malformed file refuses ${setting.request.action} without success text`, async () => {
    await writeFile(setting.initial)
    const f = await controller()
    await fs.writeFile(file, '{ // broken JSONC\n "schema_version": 1,')
    const before = await fs.readFile(file, 'utf8')
    expect(await f.execute(setting.request)).toEqual({
      ok: false,
      text: malformedSettingsText(file),
    })
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

for (const code of [...Object.keys(SETTINGS_WRITE_FAILURES), 'error'] as (
  | SettingsRefusalCode
  | 'error'
)[])
  test(`handle.update ${code} shows only its fixed reason and keeps the live logging level`, async () => {
    await writeFile()
    const f = await controller(code)
    setLogLevel('info')
    const before = await fs.readFile(file, 'utf8')
    const failure =
      SETTINGS_WRITE_FAILURES[code === 'error' ? 'settings-unavailable' : code]
    expect(
      await f.execute({ action: 'logging-level', values: { level: 'trace' } }),
    ).toEqual({ ok: false, text: failure.text(file) })
    expect(getLogLevel()).toBe('info')
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

test('a removed deciding leaf refuses the whole menu write with the fixed reason', async () => {
  await writeFile({
    cache_keep_window: {
      default: [{ start_hour: 8, end_hour: 16 }],
      pi: [{ start_hour: 9, end_hour: 17 }],
    },
  })
  const f = await controller()
  const before = await fs.readFile(file, 'utf8')
  expect(await f.execute({ action: 'cachekeep-always' })).toEqual({
    ok: false,
    text: refusedSettingsWriteText('cache_keep_window', file),
  })
  expect(await fs.readFile(file, 'utf8')).toBe(before)
})

test('rung 3 refuses a recreating menu write with its fixed reason and no success text', async () => {
  await writeFile()
  await fs.writeFile(
    `${file}.moved`,
    JSON.stringify({ version: 1, target: file, at: 1 }),
  )
  await fs.unlink(file)
  const f = await controller()
  const paths = await resolveNativePoolPaths(storagePath)
  const before = await fs.readFile(paths.config, 'utf8')
  const service = await openSettingsService({
    file,
    host: 'pi',
    protection: { readLegacyProtection: async () => undefined },
  })
  if (!service) throw new Error('Settings service unavailable')
  const unavailable = createNativeAccountRuntime({
    paths,
    host: 'pi',
    settingsService: service,
    settingsMode: () => 'user-file',
  })
  const update = spyOn(f.runtime, 'updateSettings').mockImplementation(
    (mutator) => unavailable.updateSettings(mutator),
  )
  try {
    expect(service.snapshot().protection.pi.rung).toBe(3)
    expect(await f.execute({ action: 'dump-on' })).toEqual({
      ok: false,
      text: refusedSettingsRecreationText(file),
    })
    expect(await fs.exists(file)).toBe(false)
    expect(await fs.readFile(paths.config, 'utf8')).toBe(before)
  } finally {
    update.mockRestore()
    await unavailable.close()
    await service.dispose()
  }
})

for (const floor of [3, 8])
  test(`killswitch main ${floor} without scoped writes zero at Pi's deciding location`, async () => {
    await writeFile({
      killswitch_default_five_hour: 8,
      killswitch_default_seven_day: 8,
      killswitch_default_scoped: { default: 4, pi: 8 },
    })
    const f = await controller()
    expect(
      (
        await f.execute({
          action: 'killswitch-set',
          values: { entries: [{ account: 'main', fh: floor, sd: floor }] },
        })
      ).ok,
    ).toBe(true)
    expect(
      parse(await fs.readFile(file, 'utf8')).killswitch_default_scoped,
    ).toEqual({ default: 4, pi: 0 })
  })

test('settings status shows no-model values, row-id overrides and all diagnostics', async () => {
  await writeFile({
    claude_cache_enabled: {
      default: 'off',
      'claude-opus-5-5': 'on',
      unknown_model: 'on',
    },
    claude_fast_enabled: { default: false, 'claude-haiku-5-5': true },
    cache_keep_window: [
      { start_hour: 8, end_hour: 12 },
      { start_hour: 13, end_hour: 17 },
    ],
    refresh_interval_minutes: -1,
  })
  const text = await fs.readFile(file, 'utf8')
  await fs.writeFile(
    file,
    text.replace(
      '"schema_version": 1,',
      '"schema_version": 1,\n  "dump_enabled": true,\n  "dump_enabled": false,',
    ),
  )
  const f = await controller()
  for (const command of [
    'routing',
    'killswitch',
    'cache',
    'cachekeep',
    'dump',
    'logging',
    'fast',
    'prime',
  ] as const) {
    const status = await f.backend.readStatus(command, {})
    expect(status).toContain(`Settings file: ${file}`)
    expect(status).toContain('Settings (no model):')
    expect(status).toContain('claude_cache_enabled: "off"')
    expect(status).toContain('claude_cache_enabled [claude-opus-5-5]: "on"')
    expect(status).toContain('claude_fast_enabled [claude-haiku-5-5]: true')
    expect(status).toContain('Invalid setting: cache_keep_window')
    expect(status).toContain('Invalid setting: refresh_interval_minutes')
    expect(status).toContain(
      'Ignored model key: claude_cache_enabled.unknown_model',
    )
    expect(status).toContain('Duplicate setting: dump_enabled')
    const values = f.runtime.getSettingsStatus?.()?.values
    expect(values).toBeDefined()
    for (const [key, value] of Object.entries(values ?? {}))
      expect(status).toContain(`  ${key}: ${JSON.stringify(value)}`)
  }
})

test('settings status names a missing file and its later recreation', async () => {
  await writeFile()
  // OpenCode's applied copy is the record of the set it uses, which a
  // recreation by Pi carries for it.
  await writeSettingsProtectionCopy(file, 'opencode', {
    readAt: 1,
    values: legacySettingsProtection({}, 'opencode'),
  })
  const f = await controller()
  await fs.unlink(file)
  await f.confirmMissing()
  expect(await f.backend.readStatus('cache', {})).toContain(
    'Settings file is missing; a menu write will recreate it.',
  )
  expect((await f.execute({ action: 'dump-on' })).ok).toBe(true)
  expect(await f.backend.readStatus('cache', {})).toContain(
    'Settings file was recreated by a menu write.',
  )
})

// The file only says what it held, not whether OpenCode adopted it, so a set
// read from it is never OpenCode's protection. With no applied copy, and an
// OpenCode store this environment can't read (a non-default state folder),
// OpenCode's set is unknown and the recreation is refused.
test("a recreation is refused when OpenCode's set is known only from the deleted file", async () => {
  await writeFile()
  const f = await controller()
  await fs.unlink(file)
  await f.confirmMissing()
  expect(await f.execute({ action: 'dump-on' })).toEqual({
    ok: false,
    text: refusedSettingsRecreationText(file),
  })
  expect(await fs.exists(file)).toBe(false)
})

for (const custody of ['local', 'claustrum'] as const)
  test(`menu settings projections never enter a ${custody} legacy store commit`, async () => {
    const paths = await resolveNativePoolPaths(storagePath)
    const selected = custody === 'claustrum' ? nativeVaultPaths(paths) : paths
    if (custody === 'claustrum') {
      process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
        home,
        'enrollment.json',
      )
      const enrollment = getHostClaustrumEnrollmentPaths('pi')
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
      const store = createNativePoolStore({
        paths: selected,
        quota: nativeQuotaCodec,
      })
      try {
        await store.initialize()
        await store.updateSettings(() =>
          nativeAccountSettings({
            version: 1,
            accounts: [],
            prime: { enabled: false },
            claudeCache: { enabled: false },
            quota: { enabled: false, failClosedOnUnknownQuota: false },
          }),
        )
      } finally {
        await store.close()
      }
    }
    const before = JSON.parse(await fs.readFile(selected.config, 'utf8'))
    await writeFile({
      claude_cache_enabled: 'on',
      quota_enabled: 'off',
      quota_fail_closed_on_unknown_quota: 'on',
    })
    const commits: Record<string, unknown>[] = []
    const f = await controller(undefined, false, {
      onLockEvent: (event) => {
        if (
          event.type === 'released' &&
          event.name === 'pool-config' &&
          event.path === selected.config
        )
          commits.push(JSON.parse(readFileSync(event.path, 'utf8')))
      },
    })
    expect(await f.backend.readStatus('cache', {})).toContain(
      `Settings file: ${file}`,
    )
    expect((await f.execute({ action: 'cache-off' })).ok).toBe(true)
    expect((await f.execute({ action: 'dump-on' })).ok).toBe(true)
    expect(
      (
        await f.runtime.updateSettings((settings) => ({
          ...settings,
          nativeAccountOrder: ['main'],
        }))
      ).outcome,
    ).toBe('saved')
    expect(commits.length).toBeGreaterThan(0)
    expect(
      JSON.parse(await fs.readFile(selected.config, 'utf8')).nativeAccountOrder,
    ).toEqual(['main'])
    for (const stored of [
      ...commits,
      JSON.parse(await fs.readFile(selected.config, 'utf8')),
    ]) {
      expect(stored.claudeCache).toEqual(before.claudeCache)
      expect(stored.quota).toEqual(before.quota)
      expect(JSON.stringify([stored.claudeCache, stored.quota])).not.toMatch(
        /"(?:default|on|off)"/,
      )
    }
  })
