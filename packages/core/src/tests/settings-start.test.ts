import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { createNativeRuntimeSettings } from '../native-runtime-settings.ts'
import type { SettingsPaths } from '../settings-paths.ts'
import { writeSettingsProtectionCopy } from '../settings-protection-copy.ts'
import { legacySettingsProtection } from '../settings-protection-legacy.ts'
import {
  mostRestrictiveSettingsProtection,
  openSettingsService,
  type SettingsProtectionValues,
} from '../settings-service.ts'
import { type StartSettingsOptions, startSettings } from '../settings-start.ts'

const cleanup: (() => unknown)[] = []
afterEach(async () => {
  __setLogTestSink(null)
  for (const close of cleanup.splice(0).reverse()) await close()
})

const stricter: SettingsProtectionValues = {
  ...legacySettingsProtection({}, 'opencode'),
  killswitch_enabled: true,
  killswitch_default_five_hour: 61,
}

async function fixture(file: 'present' | 'absent' = 'present') {
  const root = await mkdtemp(join(tmpdir(), 'settings-start-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const target = join(root, 'settings.jsonc')
  if (file === 'present')
    await writeFile(target, '{"killswitch_enabled":false}')
  const paths = {
    target,
    marker: `${target}.moved`,
    separate: false,
    sourceRule: 'own',
  } as SettingsPaths
  let opens = 0
  let failOpens = 1
  const options: StartSettingsOptions = {
    host: 'opencode',
    home: root,
    env: {},
    paths,
    initializeVaultSettings: async () => {},
    fence: { registration: undefined },
    protection: {
      // The legacy store is looser than the applied copy.
      readLegacyProtection: async (host) => legacySettingsProtection({}, host),
    },
    start: {
      move: async () => ({
        paths,
        mode: 'user-file',
        mayOpenService: true,
        outcome: 'moved',
      }),
      open: async (serviceOptions) => {
        opens++
        if (failOpens-- > 0) throw new Error('synthetic open failure')
        return openSettingsService(serviceOptions)
      },
    },
  }
  return { root, target, paths, options, opens: () => opens }
}

test('a service open that throws after a move applies the stricter applied copy, never the legacy store', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  const f = await fixture()
  await writeSettingsProtectionCopy(f.target, 'opencode', {
    readAt: Date.now(),
    values: stricter,
  })
  const started = await startSettings(f.options)
  expect(started).toMatchObject({ mode: 'user-file', file: f.target })
  expect(started.service).toBeUndefined()
  expect(started.fallback).toMatchObject({ rung: 1, values: stricter })
  const warnings = records.filter((record) =>
    record.message.includes('Settings startup failed'),
  )
  expect(warnings.length).toBeLessThanOrEqual(1)
  expect(warnings.every((record) => !record.message.includes(f.root))).toBe(
    true,
  )

  const ticks: (() => Promise<void>)[] = []
  const reader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsMode: () => started.mode,
    settingsFallback: started.fallback,
    settingsAuthority: {
      schedule: (callback) => {
        ticks.push(callback)
        return () => {}
      },
    },
    env: {},
  })
  cleanup.push(reader.close)
  const stored = {
    killswitch: { enabled: false, main: { five_hour: 5 } },
    dump: { enabled: true },
  }
  const resolved = reader.resolve(stored) as {
    killswitch: { enabled: boolean; main: { five_hour: number } }
    dump: { enabled: boolean }
  }
  expect(resolved.killswitch.enabled).toBe(true)
  expect(resolved.killswitch.main.five_hour).toBe(61)
  // Everything else still comes from the legacy store.
  expect(resolved.dump.enabled).toBe(true)
  expect(reader.fallbackFile()).toBe(f.target)

  // The 60 s timer opens the service off the request path and replaces the fallback.
  expect(ticks).toHaveLength(1)
  await ticks[0]!()
  expect(reader.fallbackFile()).toBeUndefined()
  expect(
    (reader.resolve(stored) as { killswitch: { enabled: boolean } }).killswitch
      .enabled,
  ).toBe(false)
})

test('without an applied copy the fallback uses the legacy store, then the strictest set', async () => {
  const f = await fixture()
  const legacy = await startSettings(f.options)
  expect(legacy.fallback).toMatchObject({
    rung: 2,
    values: legacySettingsProtection({}, 'opencode'),
  })
  const strict = await startSettings({
    ...f.options,
    start: {
      ...f.options.start,
      open: async () => {
        throw new Error('synthetic open failure')
      },
    },
    protection: { readLegacyProtection: async () => undefined },
  })
  expect(strict.fallback).toMatchObject({
    rung: 3,
    values: mostRestrictiveSettingsProtection(),
  })
})

test('a failed start with no file and no marker stays in plain legacy mode', async () => {
  const f = await fixture('absent')
  for (const failure of ['move', 'open'] as const) {
    const started = await startSettings({
      ...f.options,
      start: {
        move:
          failure === 'move'
            ? async () => {
                throw new Error('synthetic move failure')
              }
            : async () => ({
                paths: f.paths,
                mode: 'legacy',
                mayOpenService: true,
                outcome: 'fence-closed',
              }),
        open: async () => {
          throw new Error('synthetic open failure')
        },
      },
    })
    expect(started).toEqual({ mode: 'legacy', file: f.target })
  }
})

test('a marker, or an authority check that fails, keeps the file in charge', async () => {
  const f = await fixture('absent')
  const failing = {
    ...f.options,
    start: {
      move: async () => {
        throw new Error('synthetic move failure')
      },
    },
  }
  await writeFile(f.paths.marker, '{}')
  expect((await startSettings(failing)).fallback?.rung).toBe(2)
  await rm(f.paths.marker)
  const unknown = await startSettings({
    ...failing,
    authority: {
      fs: {
        exists: async () => {
          throw Object.assign(new Error('probe failed'), { code: 'EACCES' })
        },
      },
    },
  })
  expect(unknown.mode).toBe('user-file')
  expect(unknown.fallback?.rung).toBe(2)
})

test('the normal path returns the opened service', async () => {
  const f = await fixture()
  const started = await startSettings({
    ...f.options,
    start: { ...f.options.start, open: openSettingsService },
  })
  cleanup.push(() => started.service?.dispose())
  expect(started.mode).toBe('user-file')
  expect(started.fallback).toBeUndefined()
  expect(started.service?.resolve('opencode').killswitch_enabled).toBe(false)
})
