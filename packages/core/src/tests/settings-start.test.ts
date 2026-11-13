import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'

import { getHostClaustrumEnrollmentPaths } from '../claustrum-enrollment.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { createNativeRuntimeSettings } from '../native-runtime-settings.ts'
import { beginNativeEmptyInit } from '../pool-authority.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { settingsImportRecordPath } from '../settings-mode.ts'
import { resolveSettingsPaths, type SettingsPaths } from '../settings-paths.ts'
import {
  readSettingsProtectionCopy,
  writeSettingsProtectionCopy,
} from '../settings-protection-copy.ts'
import { legacySettingsProtection } from '../settings-protection-legacy.ts'
import {
  mostRestrictiveSettingsProtection,
  openSettingsService,
  type SettingsProtectionValues,
} from '../settings-service.ts'
import {
  __resetSettingsStartWarningForTest,
  type StartSettingsOptions,
  startSettings,
} from '../settings-start.ts'

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
  const ownPoolPaths = await resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
    { kind: 'legacy' },
  )
  await beginNativeEmptyInit(ownPoolPaths)
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
    env: {
      OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
        root,
        'oc-enrollment.json',
      ),
      PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
        root,
        'pi-enrollment.json',
      ),
    },
    paths,
    ownPoolPaths,
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

for (const host of ['opencode', 'pi'] as const) {
  for (const refusal of [
    'enrollment',
    'missing-journal',
    'corrupt-journal',
  ] as const) {
    test(`${host} settings startup with ${refusal} refusal performs only native preflight reads`, async () => {
      const f = await fixture()
      const options = { ...f.options, host }
      const enrollment = getHostClaustrumEnrollmentPaths(host, options.env)
      const journal = options.ownPoolPaths!.journal
      if (refusal === 'enrollment')
        await writeFile(enrollment.tokenPath, '{bad enrollment', {
          mode: 0o600,
        })
      else if (refusal === 'missing-journal') await rm(journal)
      else await writeFile(journal, '{bad journal', { mode: 0o600 })

      __setLogTestSink(() => {})
      const calls: { operation: string; path: string }[] = []
      const operations = [
        'access',
        'lstat',
        'open',
        'readFile',
        'realpath',
        'stat',
        'mkdir',
        'rename',
        'writeFile',
        'unlink',
        'rm',
        'chmod',
        'appendFile',
        'readdir',
      ] as const
      const spies = operations.map((operation) => {
        // biome-ignore lint/performance/noDynamicNamespaceImportAccess: Enumerating filesystem calls lets the test reject writes and non-preflight reads.
        const original = fs[operation] as (...args: any[]) => any
        return spyOn(
          fs as unknown as Record<string, (...args: any[]) => any>,
          operation,
        ).mockImplementation((...args: any[]) => {
          calls.push({ operation, path: String(args[0]) })
          return original(...args)
        })
      })
      let started: Awaited<ReturnType<typeof startSettings>>
      try {
        started = await startSettings(options)
        // No settings I/O while the preflight refuses: plain legacy values
        // (requests are refused by credential checks meanwhile) under the
        // file's real path, never an empty one.
        expect(started).toMatchObject({ mode: 'legacy', file: f.target })
        expect(started.service).toBeUndefined()
        expect(started.fallback).toBeUndefined()
        expect(started.reopen?.retryDelaysMs?.[0]).toBeLessThan(10_000)
        const schedule = spyOn(globalThis, 'setTimeout')
        try {
          const reader = createNativeRuntimeSettings({
            host,
            settingsMode: () => started.mode,
            settingsService: started.service,
            settingsFallback: started.fallback,
            settingsReopen: started.reopen,
          })
          await reader.prepareAction()
          expect(reader.file()).toBeUndefined()
          await reader.close()
          // A quick check off the request path retries the preflight.
          expect(schedule).toHaveBeenCalledWith(
            expect.any(Function),
            started.reopen!.retryDelaysMs![0],
          )
        } finally {
          schedule.mockRestore()
        }
      } finally {
        for (const spy of spies) spy.mockRestore()
      }
      expect(f.opens()).toBe(0)
      expect(calls.length).toBeGreaterThan(0)
      const allowed = new Set([...Object.values(enrollment), journal])
      const reads = new Set([
        'access',
        'lstat',
        'open',
        'readFile',
        'realpath',
        'stat',
      ])
      expect(
        calls.filter(
          ({ operation, path }) => !reads.has(operation) || !allowed.has(path),
        ),
      ).toEqual([])
    })
  }
}

test('a service open that throws after a move applies the stricter applied copy, never the legacy store', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  __resetSettingsStartWarningForTest()
  const f = await fixture()
  await writeSettingsProtectionCopy(f.target, 'opencode', {
    readAt: Date.now(),
    values: stricter,
  })
  const started = await startSettings(f.options)
  expect(started).toMatchObject({ mode: 'user-file', file: f.target })
  expect(started.service).toBeUndefined()
  expect(started.fallback).toMatchObject({ rung: 1, values: stricter })
  const warnings = () =>
    records.filter((record) =>
      record.message.includes('Settings startup failed'),
    )
  // Exactly one warning, naming no path.
  expect(warnings()).toHaveLength(1)
  expect(warnings()[0]!.message).not.toContain(f.root)
  // A second failed start in the same process does not warn again.
  await startSettings({
    ...f.options,
    start: {
      ...f.options.start,
      open: async () => {
        throw new Error('synthetic open failure')
      },
    },
  })
  expect(warnings()).toHaveLength(1)

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

test('a failed start with no file and no marker stays in legacy mode with a way to open the service later', async () => {
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
    expect(started).toMatchObject({ mode: 'legacy', file: f.target })
    expect(started.service).toBeUndefined()
    expect(started.fallback).toBeUndefined()
    expect(started.reopen).toBeDefined()
  }
})

test('a legacy runtime whose service failed to open notices a later move by another host', async () => {
  const f = await fixture('absent')
  const started = await startSettings({
    ...f.options,
    start: {
      move: async () => ({
        paths: f.paths,
        mode: 'legacy',
        mayOpenService: true,
        outcome: 'fence-closed',
      }),
      open: f.options.start!.open,
    },
  })
  expect(started).toMatchObject({ mode: 'legacy', file: f.target })
  expect(started.service).toBeUndefined()
  const ticks: (() => Promise<void>)[] = []
  const reader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsMode: () => started.mode,
    settingsReopen: started.reopen,
    settingsAuthority: {
      schedule: (callback) => {
        ticks.push(callback)
        return () => {}
      },
    },
    env: {},
  })
  cleanup.push(reader.close)
  const stored = { dump: { enabled: true } }
  const dump = () =>
    (reader.resolve(stored) as { dump: { enabled: boolean } }).dump.enabled
  expect(dump()).toBe(true)
  // The first timer tick opens the service; the file is still absent.
  expect(ticks).toHaveLength(1)
  await ticks.at(-1)!()
  expect(f.opens()).toBe(2)
  expect(dump()).toBe(true)
  expect(reader.file()).toBeUndefined()
  // Another host publishes the file; the next tick adopts it.
  await writeFile(f.target, '{"dump_enabled":false}')
  await ticks.at(-1)!()
  expect(reader.file()).toBe(f.target)
  expect(dump()).toBe(false)
})

for (const truth of ['legacy', 'user-file'] as const) {
  test(`an unknown authority at start is asked again off the request path and settles on ${truth}`, async () => {
    const f = await fixture('absent')
    let probeFails = true
    const started = await startSettings({
      ...f.options,
      start: {
        move: async () => {
          throw new Error('synthetic move failure')
        },
        open: openSettingsService,
      },
      authority: {
        fs: {
          exists: async (path) => {
            if (probeFails)
              throw Object.assign(new Error('probe failed'), {
                code: 'EACCES',
              })
            return Bun.file(path).exists()
          },
        },
      },
    })
    expect(started.mode).toBe('user-file')
    expect(started.fallback?.resolveAuthority).toBeDefined()
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
      killswitch: { enabled: true, main: { five_hour: 5 } },
      dump: { enabled: true },
    }
    const resolved = () =>
      reader.resolve(stored) as {
        killswitch: { enabled: boolean; main: { five_hour: number } }
        dump: { enabled: boolean }
      }
    // While the check fails, the fallback's protection applies.
    await ticks.at(-1)!()
    expect(reader.fallbackFile()).toBe(f.target)
    expect(resolved().killswitch.enabled).toBe(false)
    if (truth === 'user-file')
      await writeFile(
        f.target,
        '{"killswitch_enabled":true,"dump_enabled":false}',
      )
    probeFails = false
    await ticks.at(-1)!()
    expect(reader.fallbackFile()).toBeUndefined()
    if (truth === 'legacy') {
      // No move happened: the legacy store is right, not schema defaults.
      expect(resolved().killswitch).toMatchObject({
        enabled: true,
        main: { five_hour: 5 },
      })
      expect(resolved().dump.enabled).toBe(true)
      expect(reader.file()).toBeUndefined()
      // The service opened anyway, so a later move is still noticed.
      await writeFile(f.target, '{"dump_enabled":false}')
      await ticks.at(-1)!()
      expect(reader.file()).toBe(f.target)
      expect(resolved().dump.enabled).toBe(false)
    } else {
      expect(reader.file()).toBe(f.target)
      expect(resolved().killswitch.enabled).toBe(true)
      expect(resolved().dump.enabled).toBe(false)
    }
  })
}

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

test('startSettings runs the real move: the legacy store is published and the service opens on it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'settings-start-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options: StartSettingsOptions = {
    host: 'opencode',
    home: root,
    platform: 'linux',
    env: { HOME: root, XDG_STATE_HOME: join(root, 'state') },
    readMode: async () => 'local',
    initializeVaultSettings: async () => {},
    log: { warn: () => {} },
    fence: {
      registration: { status: 'registered' },
      floor: '2.12.0',
      liveness: { pidAlive: () => false, incarnation: async () => null },
      artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
      readHolders: async () => undefined,
    },
  }
  const paths = await resolveSettingsPaths('opencode', options)
  const store = await resolveNativePoolPaths(paths.own.account, paths.own.state)
  await mkdir(dirname(store.journal), { recursive: true })
  await beginNativeEmptyInit(store)
  options.ownPoolPaths = store
  await mkdir(dirname(store.config), { recursive: true })
  await writeFile(
    store.config,
    JSON.stringify({ killswitch: { enabled: true }, dump: { enabled: true } }),
  )
  const started = await startSettings(options)
  cleanup.push(() => started.service?.dispose())
  expect(started).toMatchObject({ mode: 'user-file', file: paths.target })
  expect(started.fallback).toBeUndefined()
  expect(started.service?.resolve('opencode')).toMatchObject({
    killswitch_enabled: true,
    dump_enabled: true,
  })
  await lstat(paths.marker)
  await lstat(settingsImportRecordPath(paths.target, 'opencode'))
})

function timer() {
  const ticks: (() => Promise<void>)[] = []
  const delays: number[] = []
  return {
    ticks,
    delays,
    tick: () => ticks.at(-1)!(),
    schedule: (callback: () => Promise<void>, delayMs: number) => {
      ticks.push(callback)
      delays.push(delayMs)
      return () => {}
    },
  }
}

type Resolved = {
  killswitch?: { enabled?: boolean; main?: { five_hour?: number } }
  dump?: { enabled?: boolean }
}

async function appliedCopy(file: string, ready: (values: unknown) => boolean) {
  // Copies are written in the background after a generation is applied.
  for (let attempt = 0; attempt < 100; attempt++) {
    const values = await readSettingsProtectionCopy(file, 'opencode')
    if (ready(values)) return values
    await Bun.sleep(20)
  }
  return readSettingsProtectionCopy(file, 'opencode')
}

for (const outcome of ['passes', 'still refused'] as const) {
  for (const file of ['present', 'absent'] as const) {
    test(`a refused preflight that later ${outcome} with the file ${file} ${outcome === 'passes' ? 'opens the service off the request path' : 'keeps serving legacy values'}`, async () => {
      const f = await fixture(file)
      const journal = f.options.ownPoolPaths!.journal
      await rm(journal)
      __setLogTestSink(() => {})
      const started = await startSettings({
        ...f.options,
        start: { open: openSettingsService },
      })
      expect(started).toMatchObject({ mode: 'legacy', file: f.target })
      const clock = timer()
      const reader = createNativeRuntimeSettings({
        host: 'opencode',
        settingsMode: () => started.mode,
        settingsReopen: started.reopen,
        settingsAuthority: { schedule: clock.schedule },
        env: {},
      })
      cleanup.push(reader.close)
      // Requests resolve the legacy store from memory: nothing blocks them,
      // and no protection fallback is overlaid.
      const stored = { dump: { enabled: true } }
      const served = () => reader.resolve(stored) as Resolved
      expect(served()).toEqual(stored)
      await clock.tick()
      expect(reader.file()).toBeUndefined()
      expect(served()).toEqual(stored)
      // Quick retries first, then the normal interval.
      expect(clock.delays).toEqual([2_000, 5_000])
      if (outcome === 'still refused') {
        await clock.tick()
        await clock.tick()
        expect(clock.delays).toEqual([2_000, 5_000, 15_000, 60_000])
        expect(served()).toEqual(stored)
        return
      }
      // The repaired preflight serves legacy values at once, before any check.
      await beginNativeEmptyInit(f.options.ownPoolPaths!)
      expect(served()).toEqual(stored)
      await clock.tick()
      if (file === 'present') {
        // The file is in charge and this host's (empty) store owes it nothing.
        expect(reader.file()).toBe(f.target)
        expect(served().killswitch?.enabled).toBe(false)
        await lstat(settingsImportRecordPath(f.target, 'opencode'))
      } else {
        // No move happened: legacy values apply, and a later file is noticed.
        expect(reader.file()).toBeUndefined()
        expect(served()).toEqual(stored)
        await writeFile(f.target, '{"dump_enabled":false}')
        await clock.tick()
        expect(reader.file()).toBe(f.target)
        expect(served().dump?.enabled).toBe(false)
      }
    })
  }
}

test('a running legacy host adopts a hand-made file only after importing its stricter legacy protection', async () => {
  const f = await fixture('absent')
  const stored = {
    killswitch: { enabled: true, main: { five_hour: 61 } },
    dump: { enabled: true },
  }
  await writeFile(f.options.ownPoolPaths!.config, JSON.stringify(stored))
  const started = await startSettings({
    ...f.options,
    start: {
      move: async () => ({
        paths: f.paths,
        mode: 'legacy',
        mayOpenService: true,
        outcome: 'fence-closed',
      }),
    },
  })
  cleanup.push(() => started.service?.dispose())
  expect(started).toMatchObject({ mode: 'legacy', file: f.target })
  const clock = timer()
  const reader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsMode: () => started.mode,
    settingsService: started.service,
    settingsAuthority: { schedule: clock.schedule },
    env: {},
  })
  cleanup.push(reader.close)
  // The user writes a settings file by hand while this host runs.
  await writeFile(f.target, '{"dump_enabled":false}')
  await clock.tick()
  expect(reader.file()).toBe(f.target)
  const resolved = reader.resolve(stored) as Resolved
  expect(resolved.killswitch).toMatchObject({
    enabled: true,
    main: { five_hour: 61 },
  })
  expect(resolved.dump?.enabled).toBe(false)
  const document = parse(await readFile(f.target, 'utf8'))
  expect(document.killswitch_enabled).toEqual({ opencode: true })
  expect(document.killswitch_default_five_hour).toEqual({ opencode: 61 })
  await lstat(settingsImportRecordPath(f.target, 'opencode'))
})

test("a running legacy host adopts another host's own-store-only move only after importing its own protection", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'settings-start-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const shared = join(root, 'shared.jsonc')
  const host = async (
    name: 'opencode' | 'pi',
    open: boolean,
    settings: Record<string, unknown>,
  ) => {
    const options: StartSettingsOptions = {
      host: name,
      home: root,
      platform: 'linux',
      env: {
        HOME: root,
        XDG_STATE_HOME: join(root, 'state'),
        // An explicit target moves only the mover's own store.
        ANTHROPIC_AUTH_SETTINGS_FILE: shared,
      },
      readMode: async () => 'local',
      initializeVaultSettings: async () => {},
      log: { warn: () => {} },
      fence: open
        ? {
            registration: { status: 'registered' },
            floor: '2.12.0',
            liveness: { pidAlive: () => false, incarnation: async () => null },
            artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
            readHolders: async () => undefined,
          }
        : // No holder registration keeps the move fence closed.
          { registration: undefined },
    }
    const paths = await resolveSettingsPaths(name, options)
    const store = await resolveNativePoolPaths(
      paths.own.account,
      paths.own.state,
    )
    await mkdir(dirname(store.journal), { recursive: true })
    await beginNativeEmptyInit(store)
    options.ownPoolPaths = store
    await mkdir(dirname(store.config), { recursive: true })
    await writeFile(store.config, JSON.stringify(settings))
    return options
  }
  const piStore = { killswitch: { enabled: true, main: { five_hour: 61 } } }
  // Pi starts while the move fence is closed and keeps its legacy settings.
  const pi = await startSettings(await host('pi', false, piStore))
  cleanup.push(() => pi.service?.dispose())
  expect(pi).toMatchObject({ mode: 'legacy', file: shared })
  const clock = timer()
  const reader = createNativeRuntimeSettings({
    host: 'pi',
    settingsMode: () => pi.mode,
    settingsService: pi.service,
    settingsAuthority: { schedule: clock.schedule },
    env: {},
  })
  cleanup.push(reader.close)
  // OpenCode then moves only its own, weaker store.
  const opencode = await startSettings(
    await host('opencode', true, { dump: { enabled: true } }),
  )
  cleanup.push(() => opencode.service?.dispose())
  expect(opencode).toMatchObject({ mode: 'user-file', file: shared })
  await clock.tick()
  expect(reader.file()).toBe(shared)
  expect((reader.resolve(piStore) as Resolved).killswitch).toMatchObject({
    enabled: true,
    main: { five_hour: 61 },
  })
  expect((reader.resolve(piStore) as Resolved).dump?.enabled).toBe(true)
  expect(opencode.service?.resolve('opencode').killswitch_enabled).toBe(false)
  // Pi's protection sits at its own level; OpenCode's moved values stay.
  expect(parse(await readFile(shared, 'utf8')).killswitch_enabled).toEqual({
    pi: true,
  })
})

test('an unreadable own store keeps a host legacy, writes no applied copy from the file, and retries at the next check', async () => {
  const f = await fixture()
  await writeFile(f.target, '{"dump_enabled":false}')
  const config = f.options.ownPoolPaths!.config
  await writeFile(config, '{unreadable')
  const warnings: string[] = []
  const started = await startSettings({
    ...f.options,
    log: { warn: (message) => warnings.push(message) },
    // The real move, and the default open with its applied-copy gate.
    start: {},
  })
  cleanup.push(() => started.service?.dispose())
  // The file is in charge, but this host's protection is unknown.
  expect(started).toMatchObject({ mode: 'legacy', file: f.target })
  expect(started.service).toBeDefined()
  expect(
    warnings.some((message) => message.includes('could not be read')),
  ).toBe(true)
  const clock = timer()
  const reader = createNativeRuntimeSettings({
    host: 'opencode',
    settingsMode: () => started.mode,
    settingsService: started.service,
    settingsAuthority: { schedule: clock.schedule },
    env: {},
  })
  cleanup.push(reader.close)
  const stored = {
    killswitch: { enabled: true, main: { five_hour: 61 } },
    dump: { enabled: true },
  }
  await clock.tick()
  expect(reader.file()).toBeUndefined()
  expect((reader.resolve(stored) as Resolved).dump?.enabled).toBe(true)
  // The file's looser protection never became this host's applied copy.
  await Bun.sleep(100)
  expect(await readSettingsProtectionCopy(f.target, 'opencode')).toBeUndefined()
  // The store becomes readable; the next check imports it and adopts the file.
  await writeFile(config, JSON.stringify(stored))
  await clock.tick()
  expect(reader.file()).toBe(f.target)
  expect((reader.resolve(stored) as Resolved).killswitch).toMatchObject({
    enabled: true,
    main: { five_hour: 61 },
  })
  expect((reader.resolve(stored) as Resolved).dump?.enabled).toBe(false)
  const copy = await appliedCopy(
    f.target,
    (values) =>
      (values as SettingsProtectionValues | undefined)
        ?.killswitch_default_five_hour === 61,
  )
  expect(copy).toMatchObject({
    killswitch_enabled: true,
    killswitch_default_five_hour: 61,
  })
})
