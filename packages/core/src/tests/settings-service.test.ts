import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'

import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { CLAUDE_MODEL_CAPABILITIES } from '../model-capabilities.ts'
import { acquireNativeAccountRuntime } from '../native-account-runtime.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { settingsDefinition } from '../settings-definition.ts'
import {
  readSettingsProtectionCopy,
  writeSettingsProtectionCopy,
} from '../settings-protection-copy.ts'
import {
  openSettingsService,
  SETTINGS_PROTECTION_KEYS,
  type SettingsGeneration,
  type SettingsProtectionValues,
  type SettingsServiceOptions,
} from '../settings-service.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  __setLogTestSink(null)
  for (const close of cleanup.splice(0).reverse()) await close()
})

function gate() {
  let open = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, promise }
}

async function fixture(source = '{}', realWatch = false) {
  const root = await mkdtemp(join(tmpdir(), 'settings-service-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'settings.jsonc')
  await writeFile(file, source)
  const counts = {
    opens: 0,
    reads: 0,
    gets: 0,
    watches: 0,
    stops: 0,
    active: 0,
    maxActive: 0,
  }
  let trigger = () => {}
  let onGet: ((key: string, count: number) => Promise<void>) | undefined
  const options: SettingsServiceOptions = {
    file,
    dependencies: {
      readFile: async (path) => {
        counts.reads++
        return readFile(path)
      },
      open: (options) => {
        counts.opens++
        expect(options.file).toBe(file)
        expect(options.separateInstall).toBe(false)
        expect(options.log.warn('dependency output')).toBeUndefined()
        expect(options.log.info('dependency output')).toBeUndefined()
        const handle = openSettings(settingsDefinition, options)
        return {
          ...handle,
          async get(key, context) {
            expect(context.project).toBeUndefined()
            counts.gets++
            counts.active++
            counts.maxActive = Math.max(counts.maxActive, counts.active)
            try {
              const value = await handle.get(key, context)
              await onGet?.(key, counts.gets)
              return value
            } finally {
              counts.active--
            }
          },
          watch(change) {
            counts.watches++
            trigger = change
            const stop = realWatch ? handle.watch(change) : () => {}
            return () => {
              counts.stops++
              stop()
            }
          },
        }
      },
    },
  }
  async function open(overrides: Partial<SettingsServiceOptions> = {}) {
    const service = await openSettingsService({ ...options, ...overrides })
    if (!service) throw new Error('Expected a user-file settings service')
    cleanup.push(() => service.dispose())
    return service
  }
  return {
    file,
    root,
    options,
    counts,
    open,
    trigger: () => trigger(),
    onGet: (hook: typeof onGet) => {
      onGet = hook
    },
  }
}

test('one path owns one handle and watch until its last plugin lease is disposed', async () => {
  const f = await fixture('{"dump_enabled":true}')
  const [a, b] = await Promise.all([f.open(), f.open()])
  expect(f.counts.opens).toBe(1)
  expect(f.counts.watches).toBe(1)
  expect(a.snapshot()).toBe(b.snapshot())
  const effects: string[] = []
  a.watch(() => {
    effects.push('retired')
  })
  b.watch(() => {
    effects.push('live')
  })
  await a.dispose()
  expect(f.counts.stops).toBe(0)
  await writeFile(f.file, '{"dump_enabled":false}')
  f.trigger()
  await b.refresh()
  expect(b.resolve('opencode').dump_enabled).toBe(false)
  expect(effects).toEqual(['live'])
  await b.dispose()
  await b.dispose()
  expect(f.counts.stops).toBe(1)
  expect(() => a.resolve('pi')).toThrow('disposed')
  const c = await f.open()
  expect(f.counts.opens).toBe(2)
  expect(c.resolve('pi').dump_enabled).toBe(false)
})

test('different user files never share a handle or generation', async () => {
  const a = await fixture('{"dump_enabled":true}')
  const b = await fixture('{"dump_enabled":false}')
  const [first, second] = await Promise.all([a.open(), b.open()])
  expect(first.resolve('pi').dump_enabled).toBe(true)
  expect(second.resolve('pi').dump_enabled).toBe(false)
  expect(first.snapshot()).not.toBe(second.snapshot())
  expect(a.counts.opens).toBe(1)
  expect(b.counts.opens).toBe(1)
})

test('startup resolves both hosts and every model row; request reads do no filesystem work', async () => {
  const f = await fixture('{"dump_enabled":{"default":false,"pi":true}}')
  const service = await f.open()
  expect(f.counts.reads).toBe(4)
  expect(f.counts.gets).toBe(
    2 *
      2 *
      (CLAUDE_MODEL_CAPABILITIES.length + 1) *
      Object.keys(settingsDefinition.settings).length,
  )
  for (const host of ['opencode', 'pi'] as const) {
    expect(Object.keys(service.snapshot().contexts[host].models)).toEqual(
      CLAUDE_MODEL_CAPABILITIES.map((row) => row.id),
    )
    expect(service.resolve(host).dump_enabled).toBe(host === 'pi')
  }
  const spies = [spyOn(fs, 'readFile'), spyOn(fs, 'stat'), spyOn(fs, 'lstat')]
  const before = { ...f.counts }
  try {
    for (const row of CLAUDE_MODEL_CAPABILITIES)
      service.resolve('opencode', `${row.id}[1m]`)
    service.resolve('pi')
    service.snapshot()
    expect(f.counts).toEqual(before)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  expect(Object.isFrozen(service.resolve('pi'))).toBe(true)
  expect(Object.isFrozen(service.resolve('pi').fallback_on)).toBe(true)
})

test('request models drop the bracketed 1m qualifier before lookup', async () => {
  const f = await fixture(
    '{"claude_fast_enabled":{"default":false,"claude-opus-5-5":true}}',
  )
  const service = await f.open()
  expect(
    service.resolve('opencode', 'claude-opus-5-5[1m]').claude_fast_enabled,
  ).toBe(true)
})

test('request models select the longest matching row, including suffixes', async () => {
  const f = await fixture(
    '{"claude_fast_enabled":{"default":false,"claude-opus-5":false,"claude-opus-5-5":true}}',
  )
  const service = await f.open()
  expect(
    service.resolve('pi', 'claude-opus-5-5-20260101').claude_fast_enabled,
  ).toBe(true)
  expect(
    service.resolve('pi', 'claude-opus-5-20260101').claude_fast_enabled,
  ).toBe(false)
})

test('an unknown model uses the no-model values and unknown override keys are reported', async () => {
  const f = await fixture(
    '{"claude_fast_enabled":{"default":false,"unknown-model":true}}',
  )
  const service = await f.open()
  expect(service.resolve('opencode', 'unknown-model')).toBe(
    service.resolve('opencode'),
  )
  expect(service.snapshot().report).toContainEqual({
    file: { kind: 'user', path: f.file },
    keyPath: ['claude_fast_enabled', 'unknown-model'],
    reason: 'unknown-key',
  })
})

for (const restore of [false, true]) {
  test(`a change between two gets${restore ? ' restored with the same size and timestamps' : ''} never publishes mixed values`, async () => {
    const old =
      '{"dump_enabled":false,"prime_enabled":false,"killswitch_enabled":false,"quota_minimum_remaining_five_hour":0}'
    const newer =
      '{"dump_enabled":true ,"prime_enabled":true ,"killswitch_enabled":true ,"quota_minimum_remaining_five_hour":1}'
    expect(Buffer.byteLength(old)).toBe(Buffer.byteLength(newer))
    const f = await fixture(old)
    const copies: SettingsProtectionValues[] = []
    const service = await f.open({
      host: 'pi',
      dependencies: {
        ...f.options.dependencies,
        writeAppliedCopy: async (...args) => {
          copies.push(args[2].values)
          await writeSettingsProtectionCopy(...args)
        },
      },
    })
    const seen: SettingsGeneration[] = []
    service.watch((generation) => {
      seen.push(generation)
    })
    const stamps = await stat(f.file)
    let phase = 0
    f.onGet(async (key) => {
      if (phase === 0 && key === 'dump_enabled') {
        phase++
        await writeFile(f.file, newer)
        expect(service.resolve('opencode').dump_enabled).toBe(false)
      } else if (restore && phase === 1 && key === 'prime_enabled') {
        phase++
        await writeFile(f.file, old)
        await utimes(f.file, stamps.atime, stamps.mtime)
      }
    })
    const reads = f.counts.reads
    await service.refresh()
    expect(f.counts.reads - reads).toBeGreaterThanOrEqual(6)
    expect(phase).toBe(restore ? 2 : 1)
    for (const generation of [service.snapshot(), ...seen]) {
      for (const host of ['opencode', 'pi'] as const) {
        const { noModel, models } = generation.contexts[host]
        for (const values of [noModel, ...Object.values(models)]) {
          expect(values.dump_enabled).toBe(!restore)
          expect(values.prime_enabled).toBe(!restore)
          expect(values.killswitch_enabled).toBe(!restore)
        }
        expect(generation.protection[host].usable).toBe(true)
        expect(generation.protection[host].values.killswitch_enabled).toBe(
          !restore,
        )
      }
    }
    await service.dispose()
    for (const values of copies) {
      expect(values.quota_minimum_remaining_five_hour).toBe(
        values.killswitch_enabled ? 1 : 0,
      )
    }
    expect(
      (await readSettingsProtectionCopy(f.file, 'pi'))?.killswitch_enabled,
    ).toBe(!restore)
  })
}

test('a delayed read and repeated triggers serialize passes and publish only the newer coherent values', async () => {
  const f = await fixture(
    '{"dump_enabled":false,"prime_enabled":false,"killswitch_default_five_hour":5}',
  )
  const service = await f.open({ host: 'pi' })
  const entered = gate()
  const release = gate()
  const copied: { id: number; dump: boolean; prime: boolean }[] = []
  service.watch((generation) => {
    const values = generation.contexts.opencode.noModel
    copied.push({
      id: generation.id,
      dump: values.dump_enabled,
      prime: values.prime_enabled,
    })
  })
  let held = false
  f.onGet(async (key) => {
    if (held || key !== 'dump_enabled') return
    held = true
    entered.open()
    await release.promise
  })
  await writeFile(
    f.file,
    '{"dump_enabled":true,"prime_enabled":true,"killswitch_default_five_hour":31}',
  )
  const first = service.refresh()
  await entered.promise
  await writeFile(
    f.file,
    '{"dump_enabled":false,"prime_enabled":true,"killswitch_default_five_hour":72}',
  )
  for (let i = 0; i < 8; i++) f.trigger()
  const pending = service.refresh()
  const reads = f.counts.reads
  expect(f.counts.active).toBe(1)
  expect(service.resolve('pi').prime_enabled).toBe(false)
  release.open()
  await Promise.all([first, pending])
  expect(f.counts.maxActive).toBe(1)
  // One unstable pass, two agreeing passes, then one coalesced two-pass refresh.
  expect(f.counts.reads - reads).toBe(9)
  expect(copied).toEqual([{ id: 2, dump: false, prime: true }])
  expect(service.resolve('pi').prime_enabled).toBe(true)
  await service.dispose()
  expect(
    (await readSettingsProtectionCopy(f.file, 'pi'))
      ?.killswitch_default_five_hour,
  ).toBe(72)
})

test('change effects including a delayed copy finish before a newer generation fires effects', async () => {
  const f = await fixture('{"dump_enabled":false}')
  const service = await f.open()
  const entered = gate()
  const release = gate()
  const effects: string[] = []
  service.watch(async (generation) => {
    effects.push(`start ${generation.id}`)
    if (generation.id === 2) {
      entered.open()
      await release.promise
    }
    effects.push(
      `copy ${generation.id} ${generation.contexts.opencode.noModel.dump_enabled}`,
    )
  })
  await writeFile(f.file, '{"dump_enabled":true}')
  const first = service.refresh()
  await entered.promise
  await writeFile(f.file, '{"dump_enabled":false}')
  f.trigger()
  const next = service.refresh()
  expect(effects).toEqual(['start 2'])
  expect(service.snapshot().id).toBe(2)
  release.open()
  await Promise.all([first, next])
  expect(effects).toEqual(['start 2', 'copy 2 true', 'start 3', 'copy 3 false'])
  expect(service.snapshot().id).toBe(3)
})

test('five non-stabilizing passes mark the file unreadable without publishing partial values', async () => {
  const f = await fixture('{"dump_enabled":false}')
  const service = await f.open()
  const perPass =
    2 *
    (CLAUDE_MODEL_CAPABILITIES.length + 1) *
    Object.keys(settingsDefinition.settings).length
  const base = f.counts.gets
  let flips = 0
  f.onGet(async (_key, count) => {
    if ((count - base - 1) % perPass !== 0) return
    flips++
    await writeFile(f.file, JSON.stringify({ dump_enabled: flips % 2 === 1 }))
  })
  const reads = f.counts.reads
  await service.refresh()
  expect(flips).toBe(5)
  expect(f.counts.reads - reads).toBe(10)
  expect(service.snapshot().status).toBe('unreadable')
  expect(service.resolve('opencode').dump_enabled).toBe(false)
  expect(service.snapshot().protection.opencode.usable).toBe(false)
  expect(service.snapshot().report).toEqual([
    { file: { kind: 'user', path: f.file }, keyPath: [], reason: 'unreadable' },
  ])
})

test('failed resolve attempts still read the final bytes and stop after five passes', async () => {
  const f = await fixture('{"dump_enabled":true}')
  const open = f.options.dependencies?.open
  if (!open) throw new Error('Expected the fixture handle factory')
  const service = await f.open({
    dependencies: {
      ...f.options.dependencies,
      open: (options) => ({
        ...open(options),
        async get() {
          throw new Error('synthetic read failure')
        },
      }),
    },
  })
  expect(f.counts.reads).toBe(10)
  expect(service.snapshot().status).toBe('unreadable')
  expect(service.snapshot().protection.opencode.usable).toBe(false)
  expect(service.resolve('opencode').dump_enabled).toBe(false)
})

test('reports are logged in Core fixed text once per entry and file for the process', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => {
    if (record.channel === 'settings') records.push(record)
  })
  const f = await fixture(
    '{"dump_enabled":"synthetic-private-value","prime_enabled":7}',
  )
  const service = await f.open()
  const report = service.snapshot().report
  expect(report).toHaveLength(2)
  expect(records.map((record) => record.message)).toEqual([
    `Settings invalid-value in "${f.file}" (dump_enabled).`,
    `Settings invalid-value in "${f.file}" (prime_enabled).`,
  ])
  expect(JSON.stringify(records)).not.toContain('synthetic-private-value')
  await service.refresh()
  await service.dispose()
  await f.open()
  expect(records).toHaveLength(2)
  const other = await fixture('{"dump_enabled":7}')
  await other.open()
  expect(records).toHaveLength(3)
})

test('invalid non-protection values and malformed files retain the last published values', async () => {
  const f = await fixture(
    '{"dump_enabled":true,"killswitch_enabled":true,"cache_keep_window":[{"start_hour":1,"end_hour":2}]}',
  )
  const service = await f.open()
  await writeFile(
    f.file,
    '{"dump_enabled":7,"killswitch_enabled":false,"cache_keep_window":[{"start_hour":1,"end_hour":2},{"start_hour":3,"end_hour":4}]}',
  )
  await service.refresh()
  expect(service.resolve('pi').dump_enabled).toBe(true)
  expect(service.resolve('pi').cache_keep_window).toEqual([
    { start_hour: 1, end_hour: 2 },
  ])
  expect(service.resolve('pi').killswitch_enabled).toBe(false)
  expect(
    service.snapshot().report.map((entry) => entry.keyPath),
  ).toContainEqual(['cache_keep_window'])
  await writeFile(f.file, '{broken')
  await service.refresh()
  expect(service.snapshot().status).toBe('unparseable')
  expect(service.resolve('pi').dump_enabled).toBe(true)
  expect(service.snapshot().protection.pi.usable).toBe(false)
})

test('an oversized default window keeps its last good value without hiding a valid host update', async () => {
  const oldWindow = [{ start_hour: 1, end_hour: 2 }]
  const piWindow = [{ start_hour: 3, end_hour: 4 }]
  const f = await fixture(JSON.stringify({ cache_keep_window: oldWindow }))
  const service = await f.open()
  await writeFile(
    f.file,
    JSON.stringify({
      cache_keep_window: { default: [...oldWindow, ...piWindow], pi: piWindow },
    }),
  )
  await service.refresh()
  expect(service.resolve('opencode').cache_keep_window).toEqual(oldWindow)
  expect(service.resolve('pi').cache_keep_window).toEqual(piWindow)
  expect(service.snapshot().report).toContainEqual({
    file: { kind: 'user', path: f.file },
    keyPath: ['cache_keep_window', 'default'],
    reason: 'invalid-value',
  })
})

test('invalid non-protection levels fall through at startup and retain only their affected contexts while running', async () => {
  const f = await fixture(
    JSON.stringify({
      dump_enabled: 'invalid',
      refresh_interval_minutes: { default: 23, pi: -1 },
      claude_fast_enabled: {
        default: true,
        pi: 'invalid',
        'claude-opus-5-5': 7,
      },
    }),
  )
  const service = await f.open()
  expect(service.resolve('opencode').dump_enabled).toBe(false)
  expect(service.resolve('pi').refresh_interval_minutes).toBe(23)
  expect(service.resolve('pi').claude_fast_enabled).toBe(true)
  expect(service.resolve('pi', 'claude-opus-5-5').claude_fast_enabled).toBe(
    true,
  )
  expect(service.status().invalidKeys).toEqual([
    'dump_enabled',
    'refresh_interval_minutes.pi',
    'claude_fast_enabled.pi',
    'claude_fast_enabled.claude-opus-5-5',
  ])
  await writeFile(
    f.file,
    JSON.stringify({
      dump_enabled: true,
      refresh_interval_minutes: { default: 40, pi: -2 },
      claude_fast_enabled: {
        default: false,
        pi: 'still-invalid',
        'claude-opus-5-5': 8,
      },
    }),
  )
  await service.refresh()
  expect(service.resolve('opencode').dump_enabled).toBe(true)
  expect(service.resolve('opencode').refresh_interval_minutes).toBe(40)
  expect(service.resolve('pi').refresh_interval_minutes).toBe(23)
  expect(service.resolve('opencode').claude_fast_enabled).toBe(false)
  expect(service.resolve('pi').claude_fast_enabled).toBe(true)
  expect(
    service.resolve('opencode', 'claude-opus-5-5').claude_fast_enabled,
  ).toBe(true)
  expect(service.resolve('pi', 'claude-opus-5-5').claude_fast_enabled).toBe(
    true,
  )
})

test('oversized windows are rejected at their own level, including levels shadowed by a host', async () => {
  const window = [{ start_hour: 1, end_hour: 2 }]
  const oversized = [...window, { start_hour: 3, end_hour: 4 }]
  const root = await fixture(JSON.stringify({ cache_keep_window: oversized }))
  expect((await root.open()).resolve('pi').cache_keep_window).toEqual([])
  const f = await fixture(
    JSON.stringify({
      cache_keep_window: { default: window, pi: oversized },
    }),
  )
  const service = await f.open()
  expect(service.resolve('opencode').cache_keep_window).toEqual(window)
  expect(service.resolve('pi').cache_keep_window).toEqual(window)
  expect(service.status().invalidKeys).toEqual(['cache_keep_window.pi'])
  await writeFile(
    f.file,
    JSON.stringify({
      cache_keep_window: { default: oversized, pi: [] },
    }),
  )
  await service.refresh()
  expect(service.resolve('opencode').cache_keep_window).toEqual(window)
  expect(service.resolve('pi').cache_keep_window).toEqual([])
  expect(service.status().invalidKeys).toEqual(['cache_keep_window.default'])
  await writeFile(
    f.file,
    JSON.stringify({
      cache_keep_window: { default: [], pi: oversized },
    }),
  )
  await service.refresh()
  expect(service.resolve('pi').cache_keep_window).toEqual([])
})

test('status names ignored model keys and duplicate locations while last occurrences still apply', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => {
    if (record.channel === 'settings') records.push(record)
  })
  const f = await fixture(`{
    "dump_enabled": false,
    "dump_enabled": true,
    "claude_fast_enabled": {"default": true, "default": false, "not-a-model": 7}
  }`)
  const service = await f.open()
  expect(service.resolve('pi').dump_enabled).toBe(true)
  expect(service.resolve('pi', 'not-a-model').claude_fast_enabled).toBe(false)
  expect(service.status()).toEqual({
    file: f.file,
    state: 'ready',
    missing: false,
    recreated: false,
    invalidKeys: [],
    ignoredModelKeys: [
      { setting: 'claude_fast_enabled', model: 'not-a-model' },
    ],
    duplicateKeys: ['dump_enabled', 'claude_fast_enabled.default'],
  })
  expect(service.status()).toBe(service.snapshot().fileStatus)
  expect(Object.isFrozen(service.status().duplicateKeys)).toBe(true)
  expect(records.map((record) => record.message)).toEqual([
    `Settings duplicate-key in "${f.file}" (dump_enabled).`,
    `Settings duplicate-key in "${f.file}" (claude_fast_enabled).`,
    `Settings unknown-key in "${f.file}" (claude_fast_enabled).`,
  ])
  await service.refresh()
  expect(records).toHaveLength(3)
})

for (const failure of ['unparseable', 'unreadable'] as const) {
  test(`${failure} files use schema defaults at startup and last good values while running`, async () => {
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => {
      if (record.channel === 'settings') records.push(record)
    })
    const f = await fixture('{"dump_enabled":true,"prime_enabled":true}')
    let unreadable = failure === 'unreadable'
    if (failure === 'unparseable') await writeFile(f.file, '{broken')
    const service = await f.open({
      dependencies: {
        ...f.options.dependencies,
        readFile: (file) => {
          if (unreadable)
            throw Object.assign(new Error('private failure detail'), {
              code: 'EACCES',
            })
          return readFile(file)
        },
      },
    })
    expect(service.status().state).toBe(failure)
    expect(service.status().file).toBe(f.file)
    for (const host of ['opencode', 'pi'] as const) {
      expect(service.resolve(host).dump_enabled).toBe(false)
      expect(service.resolve(host).prime_enabled).toBe(false)
      expect(service.resolve(host).refresh_interval_minutes).toBe(10)
    }
    expect(records.map((record) => record.message)).toEqual([
      `Settings ${failure} in "${f.file}" (<root>).`,
    ])
    unreadable = false
    await writeFile(f.file, '{"dump_enabled":true,"prime_enabled":true}')
    await service.refresh()
    expect(service.status().state).toBe('ready')
    expect(service.resolve('pi').dump_enabled).toBe(true)
    if (failure === 'unparseable') await writeFile(f.file, '{broken-again')
    else unreadable = true
    await service.refresh()
    expect(service.status().state).toBe(failure)
    expect(service.resolve('pi').dump_enabled).toBe(true)
    expect(service.resolve('pi').prime_enabled).toBe(true)
    await service.refresh()
    expect(records).toHaveLength(1)
    expect(JSON.stringify(records)).not.toContain('private failure detail')
  })
}

function manualTimer() {
  let callback: (() => void) | undefined
  const delays: number[] = []
  let cancellations = 0
  return {
    delays,
    get cancellations() {
      return cancellations
    },
    schedule(next: () => void, delayMs: number) {
      expect(callback).toBeUndefined()
      delays.push(delayMs)
      callback = next
      return () => {
        callback = undefined
        cancellations++
      }
    },
    fire() {
      const next = callback
      expect(next).toBeDefined()
      callback = undefined
      next?.()
    },
  }
}

test('a file missing at startup uses schema defaults and a menu write exposes its recreation', async () => {
  const f = await fixture()
  await rm(f.file)
  const timer = manualTimer()
  const service = await f.open({
    dependencies: { ...f.options.dependencies, schedule: timer.schedule },
  })
  expect(timer.delays).toEqual([])
  expect(service.status().missing).toBe(true)
  expect(service.resolve('pi').dump_enabled).toBe(false)
  expect(service.resolve('pi').refresh_interval_minutes).toBe(10)
  await service.update([{ setting: 'dump_enabled', value: true }], 'pi')
  expect(service.resolve('pi').dump_enabled).toBe(true)
  expect(service.status().missing).toBe(false)
  expect(service.status().recreated).toBe(true)
  await service.dispose()
  expect((await f.open()).status().recreated).toBe(true)
})

test('a file recreated during the injected 2 s save window is read without publishing missing defaults', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => {
    if (record.channel === 'settings') records.push(record)
  })
  const f = await fixture('{"dump_enabled":true}')
  const timer = manualTimer()
  const service = await f.open({
    dependencies: { ...f.options.dependencies, schedule: timer.schedule },
  })
  const initial = service.snapshot()
  await rm(f.file)
  f.trigger()
  await service.refresh()
  expect(timer.delays).toEqual([2_000])
  expect(service.snapshot()).toBe(initial)
  const counts = { ...f.counts }
  expect(service.resolve('pi').dump_enabled).toBe(true)
  expect(service.status().missing).toBe(false)
  expect(f.counts).toEqual(counts)
  await writeFile(f.file, '{"dump_enabled":false,"prime_enabled":true}')
  timer.fire()
  await service.refresh()
  expect(service.resolve('pi').prime_enabled).toBe(true)
  expect(service.resolve('pi').dump_enabled).toBe(false)
  expect(service.status().state).toBe('ready')
  expect(records).toHaveLength(0)
})

test('a file still missing after 2 s publishes defaults once without waiting on request reads', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => {
    if (record.channel === 'settings') records.push(record)
  })
  const f = await fixture(
    JSON.stringify({
      ...distinctProtection,
      dump_enabled: true,
      refresh_interval_minutes: 20,
    }),
  )
  const timer = manualTimer()
  const service = await f.open({
    dependencies: { ...f.options.dependencies, schedule: timer.schedule },
  })
  await rm(f.file)
  f.trigger()
  await service.refresh()
  expect(service.resolve('pi').dump_enabled).toBe(true)
  expect(records).toHaveLength(0)
  timer.fire()
  await service.refresh()
  for (const host of ['opencode', 'pi'] as const) {
    expect(service.resolve(host).dump_enabled).toBe(false)
    expect(service.resolve(host).refresh_interval_minutes).toBe(10)
    expect(service.resolve(host).killswitch_enabled).toBe(true)
    expect(protectionOf(service.resolve(host))).toEqual(distinctProtection)
    expect(service.snapshot().protection[host].usable).toBe(false)
  }
  expect(service.status().missing).toBe(true)
  expect(service.status().recreated).toBe(false)
  expect(records.map((record) => record.message)).toEqual([
    `Settings file is missing at "${f.file}"; non-protection settings use schema defaults. A menu write will recreate it.`,
  ])
  await service.refresh()
  expect(timer.delays).toEqual([2_000])
  expect(records).toHaveLength(1)
  await writeFile(f.file, '{"dump_enabled":true}')
  f.trigger()
  await service.refresh()
  expect(service.status().missing).toBe(false)
  expect(service.status().recreated).toBe(true)
  expect(service.resolve('pi').dump_enabled).toBe(true)
})

test('a reappearance watch or the final lease disposal cancels a pending missing-file timer', async () => {
  const f = await fixture('{"dump_enabled":true}')
  const timer = manualTimer()
  const service = await f.open({
    dependencies: { ...f.options.dependencies, schedule: timer.schedule },
  })
  await rm(f.file)
  f.trigger()
  await service.refresh()
  await writeFile(f.file, '{"dump_enabled":false}')
  f.trigger()
  await service.refresh()
  expect(timer.cancellations).toBe(1)
  expect(service.resolve('pi').dump_enabled).toBe(false)
  await rm(f.file)
  f.trigger()
  await service.refresh()
  await service.dispose()
  expect(timer.cancellations).toBe(2)
})

test('an invalid protection entry or overlapping account floors invalidates the whole protection set', async () => {
  const f = await fixture(
    '{"dump_enabled":true,"killswitch_default_five_hour":101}',
  )
  const service = await f.open()
  for (const host of ['pi', 'opencode'] as const)
    expect(service.snapshot().protection[host].usable).toBe(false)
  await writeFile(
    f.file,
    JSON.stringify({
      killswitch_account_floors: [
        {
          account: 'vault:synthetic',
          host: 'both',
          five_hour: 5,
          seven_day: 10,
          scoped: 0,
        },
        {
          account: 'vault:synthetic',
          host: 'pi',
          five_hour: 5,
          seven_day: 10,
          scoped: 0,
        },
      ],
    }),
  )
  await service.refresh()
  for (const host of ['pi', 'opencode'] as const)
    expect(service.snapshot().protection[host].usable).toBe(false)
  expect(service.snapshot().report).toContainEqual({
    file: { kind: 'user', path: f.file },
    keyPath: ['killswitch_account_floors'],
    reason: 'invalid-value',
  })
})

function protectionOf(values: SettingsGeneration['contexts']['pi']['noModel']) {
  return Object.fromEntries(
    SETTINGS_PROTECTION_KEYS.map((key) => [key, values[key]]),
  ) as SettingsProtectionValues
}

const distinctProtection: SettingsProtectionValues = {
  killswitch_enabled: true,
  killswitch_default_five_hour: 31,
  killswitch_default_seven_day: 42,
  killswitch_default_scoped: 13,
  killswitch_account_floors: [
    {
      account: 'local-row',
      host: 'pi',
      five_hour: 51,
      seven_day: 62,
      scoped: 23,
    },
  ],
  quota_minimum_remaining_five_hour: 14,
  quota_minimum_remaining_seven_day: 25,
  quota_minimum_remaining_scoped: 36,
  quota_fail_closed_on_unknown_quota: 'off',
  max_same_account_wait: 'cache',
}

for (const bad of [
  { killswitch_default_five_hour: 101 },
  {
    killswitch_account_floors: [
      { account: 'bad', host: 'pi', '5h': 3, seven_day: 4, scoped: 0 },
    ],
  },
  {
    killswitch_account_floors: [
      { account: 'bad', host: 'pi', five_hour: 3, seven_day: 4 },
    ],
  },
] as const) {
  test(`one invalid protection entry retains the entire last applied set: ${JSON.stringify(bad)}`, async () => {
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => {
      if (record.channel === 'settings') records.push(record)
    })
    const f = await fixture(JSON.stringify(distinctProtection))
    const service = await f.open()
    await writeFile(
      f.file,
      JSON.stringify({ killswitch_enabled: false, dump_enabled: true, ...bad }),
    )
    await service.refresh()
    await service.refresh()
    for (const host of ['opencode', 'pi'] as const) {
      expect(protectionOf(service.resolve(host))).toEqual(distinctProtection)
      expect(protectionOf(service.resolve(host, 'claude-opus-5-5'))).toEqual(
        distinctProtection,
      )
      expect(service.snapshot().protection[host].rung).toBe(1)
      expect(service.resolve(host).dump_enabled).toBe(true)
    }
    expect(
      service
        .status()
        .invalidKeys.some((key) => key.startsWith(Object.keys(bad)[0]!)),
    ).toBe(true)
    expect(records).toHaveLength(service.snapshot().report.length)
    expect(records.length).toBeGreaterThan(0)
    await writeFile(f.file, '{broken')
    await service.refresh()
    expect(protectionOf(service.resolve('pi'))).toEqual(distinctProtection)
  })
}

for (const tags of [
  ['both', 'pi'],
  ['pi', 'both'],
  ['pi', 'pi'],
] as const) {
  test(`overlapping ${tags.join('/')} floors invalidate both hosts at start and while running`, async () => {
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => {
      if (record.channel === 'settings') records.push(record)
    })
    const floors = tags.map((host) => ({
      account: 'same',
      host,
      five_hour: 1,
      seven_day: 2,
      scoped: 3,
    }))
    const invalid = JSON.stringify({
      killswitch_account_floors: floors,
      dump_enabled: true,
    })
    const f = await fixture(invalid)
    const service = await f.open({
      protection: { readLegacyProtection: async () => distinctProtection },
    })
    for (const host of ['opencode', 'pi'] as const) {
      expect(service.snapshot().protection[host].rung).toBe(2)
      expect(protectionOf(service.resolve(host))).toEqual(distinctProtection)
    }
    await writeFile(
      f.file,
      JSON.stringify({ killswitch_default_five_hour: 77 }),
    )
    await service.refresh()
    const good = protectionOf(service.resolve('pi'))
    await writeFile(f.file, invalid)
    await service.refresh()
    for (const host of ['opencode', 'pi'] as const) {
      expect(service.snapshot().protection[host].rung).toBe(1)
      expect(protectionOf(service.resolve(host))).toEqual(good)
      expect(service.snapshot().protection[host].usable).toBe(false)
    }
    expect(service.status().invalidKeys).toEqual(['killswitch_account_floors'])
    expect(records.map((record) => record.message)).toEqual([
      `Settings invalid-value in "${f.file}" (killswitch_account_floors).`,
    ])
  })
}

test('a single scalar protection setting is usable and all other protection defaults apply on rung 0', async () => {
  const f = await fixture('{"killswitch_default_five_hour":37}')
  const service = await f.open()
  expect(service.snapshot().protection.pi.rung).toBe(0)
  expect(service.snapshot().protection.pi.usable).toBe(true)
  for (const key of SETTINGS_PROTECTION_KEYS) {
    expect<unknown>(service.resolve('pi')[key]).toEqual(
      key === 'killswitch_default_five_hour'
        ? 37
        : settingsDefinition.settings[key].default,
    )
  }
})

for (const reason of [
  'duplicate-key',
  'unknown-key',
  'override-not-allowed',
] as const) {
  test(`any protection report reason leaves rung 0, including ${reason}`, async () => {
    const f = await fixture('{"killswitch_enabled":false}')
    const open = f.options.dependencies!.open!
    const service = await f.open({
      dependencies: {
        ...f.options.dependencies,
        open: (options) => {
          const handle = open(options)
          return {
            ...handle,
            report: () => [
              {
                file: { kind: 'user', path: f.file },
                keyPath: ['killswitch_enabled', 'pi'],
                reason,
              },
            ],
          }
        },
      },
    })
    expect(service.snapshot().protection.pi.rung).toBe(3)
    expect(service.resolve('pi').killswitch_enabled).toBe(true)
    expect(service.snapshot().report[0]?.reason).toBe(reason)
  })
}

for (const missing of [false, true]) {
  for (const copy of [
    'valid',
    'missing',
    'corrupt',
    'other-host-only',
  ] as const) {
    test(`${missing ? 'missing' : 'unparseable'} startup uses the first whole recovery rung with a ${copy} copy`, async () => {
      const f = await fixture('{broken')
      if (missing) await rm(f.file)
      const legacy = {
        ...distinctProtection,
        killswitch_enabled: false,
        max_same_account_wait: 'off' as const,
      }
      const reads: string[] = []
      const service = await f.open({
        protection: {
          readAppliedCopy: async (host) => {
            reads.push(`copy:${host}`)
            if (copy === 'corrupt') throw new Error('bad copy')
            if (
              copy === 'valid' ||
              (copy === 'other-host-only' && host === 'pi')
            )
              return distinctProtection
          },
          readLegacyProtection: async (host) => {
            reads.push(`legacy:${host}`)
            return legacy
          },
        },
      })
      for (const host of ['opencode', 'pi'] as const) {
        const hasCopy =
          copy === 'valid' || (copy === 'other-host-only' && host === 'pi')
        expect(protectionOf(service.resolve(host))).toEqual(
          hasCopy ? distinctProtection : legacy,
        )
        expect(service.snapshot().protection[host].rung).toBe(hasCopy ? 1 : 2)
        expect(reads.includes(`legacy:${host}`)).toBe(!hasCopy)
        expect(service.resolve(host).dump_enabled).toBe(false)
      }
    })
  }
}

test('unavailable recovery sources use exactly the most restrictive set', async () => {
  const f = await fixture('{broken')
  const service = await f.open({
    protection: {
      readLegacyProtection: async () => {
        throw new Error('unreadable store')
      },
    },
  })
  const expected: SettingsProtectionValues = {
    killswitch_enabled: true,
    killswitch_default_five_hour: 5,
    killswitch_default_seven_day: 10,
    killswitch_default_scoped: 0,
    killswitch_account_floors: [],
    quota_minimum_remaining_five_hour: 0,
    quota_minimum_remaining_seven_day: 0,
    quota_minimum_remaining_scoped: 0,
    quota_fail_closed_on_unknown_quota: 'on',
    max_same_account_wait: 'off',
  }
  expect(protectionOf(service.resolve('pi'))).toEqual(expected)
  expect(service.snapshot().protection.pi.rung).toBe(3)
})

test("two runtime leases sharing an unusable target recover their own stores, never the first opener's", async () => {
  const f = await fixture('{broken')
  const other = {
    ...distinctProtection,
    killswitch_default_five_hour: 87,
    killswitch_account_floors: [],
  }
  const [a, b] = await Promise.all([
    f.open({
      protection: { readLegacyProtection: async () => distinctProtection },
    }),
    f.open({ protection: { readLegacyProtection: async () => other } }),
  ])
  expect(f.counts.opens).toBe(1)
  expect(protectionOf(a.resolve('pi'))).toEqual(distinctProtection)
  expect(protectionOf(b.resolve('pi'))).toEqual(other)
  await writeFile(f.file, '{still-broken')
  await b.refresh()
  expect(protectionOf(a.resolve('pi'))).toEqual(distinctProtection)
  expect(protectionOf(b.resolve('pi'))).toEqual(other)
})

test('process memory outranks an older copy, including a new lease on a shared handle', async () => {
  const f = await fixture(JSON.stringify(distinctProtection))
  let recoveryReads = 0
  const protection = {
    readAppliedCopy: async () => {
      recoveryReads++
      return { ...distinctProtection, killswitch_enabled: false }
    },
    readLegacyProtection: async () => {
      recoveryReads++
      return undefined
    },
  }
  const first = await f.open({ protection })
  expect(recoveryReads).toBe(0)
  await writeFile(f.file, '{broken')
  await first.refresh()
  const second = await f.open({ protection })
  for (const service of [first, second]) {
    expect(protectionOf(service.resolve('pi'))).toEqual(distinctProtection)
    expect(service.snapshot().protection.pi.rung).toBe(1)
  }
  expect(recoveryReads).toBe(0)
})

test('updates use the acting host without a model and resolve before returning', async () => {
  const f = await fixture(
    '// keep this comment\n{"dump_enabled":{"default":false,"pi":true}}',
  )
  const service = await f.open()
  expect(
    await service.update([{ setting: 'dump_enabled', value: false }], 'pi'),
  ).toEqual({ outcome: 'updated' })
  expect(service.resolve('pi').dump_enabled).toBe(false)
  expect(service.resolve('opencode').dump_enabled).toBe(false)
  expect(await readFile(f.file, 'utf8')).toContain('// keep this comment')
})

test('the common-auth watch alone updates the in-memory generation after a hand edit', async () => {
  const f = await fixture('{"dump_enabled":false}', true)
  const service = await f.open()
  const updated = gate()
  service.watch((generation) => {
    if (generation.contexts.opencode.noModel.dump_enabled) updated.open()
  })
  await writeFile(f.file, '{"dump_enabled":true}')
  await updated.promise
  expect(service.resolve('opencode').dump_enabled).toBe(true)
})

test('a separate install opens no handle and reads or watches no user file', async () => {
  const f = await fixture('{"dump_enabled":true}')
  expect(
    await openSettingsService({ ...f.options, separateInstall: true }),
  ).toBeUndefined()
  expect(f.counts).toEqual({
    opens: 0,
    reads: 0,
    gets: 0,
    watches: 0,
    stops: 0,
    active: 0,
    maxActive: 0,
  })
})

test('native shared runtime keys include the resolved user settings file', async () => {
  const f = await fixture()
  const paths = await resolveNativePoolPaths(
    join(f.root, 'anthropic-auth.json'),
  )
  const options = {
    paths,
    host: 'opencode' as const,
    vault: {
      env: {
        OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: join(
          f.root,
          'enrollment.json',
        ),
      },
    },
  }
  const first = acquireNativeAccountRuntime({
    ...options,
    settingsFile: f.file,
  })
  const same = acquireNativeAccountRuntime({
    ...options,
    settingsFile: join(f.root, '.', 'settings.jsonc'),
  })
  const different = acquireNativeAccountRuntime({
    ...options,
    settingsFile: join(f.root, 'other-settings.jsonc'),
  })
  cleanup.push(async () => {
    await Promise.all([first.close(), same.close(), different.close()])
  })
  expect(first.drainQuotaPublications).toBe(same.drainQuotaPublications)
  expect(first.drainQuotaPublications).not.toBe(
    different.drainQuotaPublications,
  )
})

test('only the Core settings service opens a production settings handle or selects its watch', async () => {
  const packages = new URL('../../..', import.meta.url).pathname
  const found: string[] = []
  for await (const path of new Bun.Glob('*/src/**/*.ts').scan(packages)) {
    if (path.includes('/tests/')) continue
    const source = await readFile(join(packages, path), 'utf8')
    if (/\bopenSettings\s*\(/.test(source)) found.push(path)
  }
  expect(found).toEqual(['core/src/settings-service.ts'])
  const source = await readFile(
    new URL('../settings-service.ts', import.meta.url),
    'utf8',
  )
  expect(source).not.toMatch(/from ['"]node:fs['"]|\bwatchFile\s*\(/)
})

test('retained references own their watches and keep the resolved protection lease alive until the last disposal', async () => {
  const f = await fixture('{"dump_enabled":true}')
  const original = await f.open()
  const retained = original.retain()
  cleanup.push(() => retained.dispose())
  const changes: number[] = []
  original.watch(() => {
    changes.push(1)
  })
  retained.watch(() => {
    changes.push(2)
  })
  await original.dispose()
  expect(() => original.retain()).toThrow('disposed')
  expect(f.counts.stops).toBe(0)
  expect(retained.resolve('opencode').dump_enabled).toBe(true)
  await writeFile(f.file, '{"dump_enabled":false}')
  await retained.refresh()
  expect(changes).toEqual([2])
  expect(retained.resolve('opencode').dump_enabled).toBe(false)
  await retained.dispose()
  await retained.dispose()
  expect(f.counts.stops).toBe(1)
  expect(() => retained.snapshot()).toThrow('disposed')
})
