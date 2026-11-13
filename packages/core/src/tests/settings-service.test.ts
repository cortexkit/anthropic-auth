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
  openSettingsService,
  type SettingsGeneration,
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
      '{"dump_enabled":false,"prime_enabled":false,"killswitch_enabled":false}'
    const newer =
      '{"dump_enabled":true ,"prime_enabled":true ,"killswitch_enabled":true }'
    expect(Buffer.byteLength(old)).toBe(Buffer.byteLength(newer))
    const f = await fixture(old)
    const service = await f.open()
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
  })
}

test('a delayed read and repeated triggers serialize passes and publish only the newer coherent values', async () => {
  const f = await fixture('{"dump_enabled":false,"prime_enabled":false}')
  const service = await f.open()
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
  await writeFile(f.file, '{"dump_enabled":true,"prime_enabled":true}')
  const first = service.refresh()
  await entered.promise
  await writeFile(f.file, '{"dump_enabled":false,"prime_enabled":true}')
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
