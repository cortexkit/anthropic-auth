import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSettings } from '@cortexkit/common-auth/settings'

import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { settingsDefinition } from '../settings-definition.ts'
import type { SettingsHost } from '../settings-paths.ts'
import {
  readSettingsProtectionCopy,
  writeSettingsProtectionCopy,
} from '../settings-protection-copy.ts'
import { readLegacySettingsProtection } from '../settings-protection-legacy.ts'
import {
  openSettingsService,
  SETTINGS_PROTECTION_KEYS,
  type SettingsProtectionValues,
  type SettingsServiceOptions,
} from '../settings-service.ts'

const cleanup: (() => undefined | Promise<unknown>)[] = []
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

const complete: SettingsProtectionValues = {
  killswitch_enabled: true,
  killswitch_default_five_hour: 21,
  killswitch_default_seven_day: 32,
  killswitch_default_scoped: 43,
  killswitch_account_floors: [
    {
      account: 'local-id',
      host: 'pi',
      five_hour: 54,
      seven_day: 65,
      scoped: 76,
    },
  ],
  quota_minimum_remaining_five_hour: 17,
  quota_minimum_remaining_seven_day: 28,
  quota_minimum_remaining_scoped: 39,
  quota_fail_closed_on_unknown_quota: 'off',
  max_same_account_wait: 'cache',
}

async function fixture(source: unknown = complete, name = 'settings.jsonc') {
  const root = await mkdtemp(join(tmpdir(), 'protection-copy-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const file = join(root, name)
  await writeFile(
    file,
    typeof source === 'string' ? source : JSON.stringify(source),
  )
  const dependencies: SettingsServiceOptions['dependencies'] = {
    open: (options) => ({
      ...openSettings(settingsDefinition, options),
      watch: () => () => {},
    }),
  }
  const open = async (
    host: SettingsHost = 'pi',
    options: Partial<SettingsServiceOptions> = {},
  ) => {
    const service = await openSettingsService({
      file,
      host,
      ...options,
      dependencies: { ...dependencies, ...options.dependencies },
    })
    if (!service) throw new Error('Expected service')
    cleanup.push(() => service.dispose())
    return service
  }
  return { file, root, open }
}

for (const name of ['settings.jsonc', 'custom-target.jsonc']) {
  test(`published rung 0 writes only the acting host beside ${name}, owner-only and without credentials`, async () => {
    const f = await fixture(
      { ...complete, unknownCredential: 'must-not-copy' },
      name,
    )
    const entered = gate()
    const release = gate()
    const service = await f.open('pi', {
      dependencies: {
        writeAppliedCopy: async (...args) => {
          entered.open()
          await release.promise
          await writeSettingsProtectionCopy(...args)
        },
      },
    })
    await entered.promise
    // Startup and publication complete while persistence is still detached.
    expect(service.snapshot().protection.pi.rung).toBe(0)
    expect(await Bun.file(`${f.file}.applied.json`).exists()).toBe(false)
    const spies = [spyOn(fs, 'readFile'), spyOn(fs, 'stat'), spyOn(fs, 'lstat')]
    try {
      expect(service.resolve('pi').killswitch_default_five_hour).toBe(21)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    release.open()
    const readAt = service.snapshot().readAt
    await service.dispose()
    const raw = await readFile(`${f.file}.applied.json`, 'utf8')
    const copy = JSON.parse(raw)
    expect(Object.keys(copy)).toEqual(['pi'])
    expect(copy.pi.values).toEqual(complete)
    expect(copy.pi.readAt).toBe(readAt)
    expect(copy.pi.readAt).toBeGreaterThan(0)
    expect(Object.keys(copy.pi.values).sort()).toEqual(
      [...SETTINGS_PROTECTION_KEYS].sort(),
    )
    expect(raw).not.toContain('must-not-copy')
    expect((await stat(`${f.file}.applied.json`)).mode & 0o777).toBe(0o600)
  })
}

test('every newer rung-0 reading schedules a copy, including unchanged protection values', async () => {
  const f = await fixture()
  const entries: number[] = []
  const service = await f.open('pi', {
    dependencies: {
      writeAppliedCopy: async (...args) => {
        entries.push(args[2].readAt)
        await writeSettingsProtectionCopy(...args)
      },
    },
  })
  await writeFile(f.file, JSON.stringify({ ...complete, dump_enabled: true }))
  await service.refresh()
  await writeFile(
    f.file,
    JSON.stringify({ ...complete, killswitch_default_five_hour: 61 }),
  )
  await service.refresh()
  await writeFile(f.file, '{broken')
  await service.refresh()
  await service.dispose()
  // The unrelated dump change is a newer reading of the same protection; it
  // is submitted so a late, older reading from another process can't win.
  expect(entries).toHaveLength(3)
  expect(entries[1]!).toBeGreaterThan(entries[0]!)
  expect(entries[2]!).toBeGreaterThan(entries[1]!)
  expect(
    (await readSettingsProtectionCopy(f.file, 'pi'))
      ?.killswitch_default_five_hour,
  ).toBe(61)
})

test('two detached writes delayed out of order in one process keep the later read after restart', async () => {
  const f = await fixture()
  const entered = gate(),
    release = gate(),
    newerWritten = gate()
  let writes = 0
  const service = await f.open('pi', {
    dependencies: {
      writeAppliedCopy: async (...args) => {
        if (++writes === 1) {
          entered.open()
          await release.promise
        }
        await writeSettingsProtectionCopy(...args)
        if (writes === 2) newerWritten.open()
      },
    },
  })
  await entered.promise
  await writeFile(
    f.file,
    JSON.stringify({ ...complete, killswitch_default_five_hour: 73 }),
  )
  await service.refresh()
  await newerWritten.promise
  expect(service.resolve('pi').killswitch_default_five_hour).toBe(73)
  release.open()
  await service.dispose()
  await writeFile(f.file, '{broken')
  const restart = await f.open()
  expect(restart.snapshot().protection.pi.rung).toBe(1)
  expect(restart.resolve('pi').killswitch_default_five_hour).toBe(73)
})

function child(file: string, host: SettingsHost, delay = false) {
  const serviceModule = new URL('../settings-service.ts', import.meta.url).href
  const copyModule = new URL('../settings-protection-copy.ts', import.meta.url)
    .href
  const definitionModule = new URL('../settings-definition.ts', import.meta.url)
    .href
  const code = `
    import { openSettingsService } from ${JSON.stringify(serviceModule)};
    import { writeSettingsProtectionCopy } from ${JSON.stringify(copyModule)};
    import { settingsDefinition } from ${JSON.stringify(definitionModule)};
    import { openSettings } from '@cortexkit/common-auth/settings';
    const service = await openSettingsService({file:${JSON.stringify(file)},host:${JSON.stringify(host)},dependencies:{
      open: options => ({...openSettings(settingsDefinition, options),watch:()=>()=>{}}),
      writeAppliedCopy: async (...args) => {
        ${delay ? "console.log('read'); await new Promise(resolve => process.stdin.once('data',resolve)); process.stdin.pause();" : ''}
        await writeSettingsProtectionCopy(...args);
      }
    }});
    await service.dispose();
  `
  const process = Bun.spawn([globalThis.process.execPath, '--eval', code], {
    cwd: import.meta.dir,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  cleanup.push(async () => {
    if (process.exitCode === null) process.kill()
    await process.exited
  })
  return process
}

async function finished(process: ReturnType<typeof child>) {
  const error = await new Response(process.stderr).text()
  expect(await process.exited, error).toBe(0)
}

test('two same-host processes committing delayed writes out of read order keep the newer values after restart', async () => {
  const f = await fixture()
  const older = child(f.file, 'pi', true)
  const reader = older.stdout.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    'read',
  )
  reader.releaseLock()
  await writeFile(
    f.file,
    JSON.stringify({ ...complete, killswitch_default_five_hour: 84 }),
  )
  const newer = child(f.file, 'pi')
  await finished(newer)
  older.stdin.write('continue\n')
  older.stdin.end()
  await finished(older)
  await writeFile(f.file, '{broken')
  const restart = await f.open()
  expect(restart.resolve('pi').killswitch_default_five_hour).toBe(84)
  expect(restart.snapshot().protection.pi.rung).toBe(1)
})

for (const reread of ['unrelated-change', 'same-bytes'] as const) {
  test(`a delayed weaker copy from another process loses to a newer reading of stricter values: ${reread}`, async () => {
    const weaker = {
      ...complete,
      killswitch_enabled: false,
      killswitch_default_five_hour: 2,
    }
    const f = await fixture()
    let written = gate()
    const a = await f.open('pi', {
      dependencies: {
        writeAppliedCopy: async (...args) => {
          await writeSettingsProtectionCopy(...args)
          written.open()
        },
      },
    })
    await written.promise
    // Process B reads the weaker file and stalls before saving its copy.
    await writeFile(f.file, JSON.stringify(weaker))
    const b = child(f.file, 'pi', true)
    const reader = b.stdout.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'read',
    )
    reader.releaseLock()
    // A never sees the weaker version; it reads the stricter values again.
    written = gate()
    await writeFile(
      f.file,
      JSON.stringify(
        reread === 'unrelated-change'
          ? { ...complete, dump_enabled: true }
          : complete,
      ),
    )
    await a.refresh()
    // A submits the newer reading; give it a bounded wait so a missing write
    // fails on the recovered values below rather than on a timeout.
    await Promise.race([
      written.promise,
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ])
    b.stdin.write('continue\n')
    b.stdin.end()
    await finished(b)
    await a.dispose()
    await writeFile(f.file, '{broken')
    const restart = await f.open()
    expect(restart.snapshot().protection.pi.rung).toBe(1)
    expect(restart.resolve('pi')).toMatchObject({
      killswitch_enabled: true,
      killswitch_default_five_hour: 21,
    })
  })
}

test('a failed copy write is retried off the request path and logged once', async () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => {
    if (record.channel === 'settings') records.push(record)
  })
  const f = await fixture()
  const retries: {
    callback: () => void
    delayMs: number
    cancelled: boolean
  }[] = []
  const pending = () => retries.filter((retry) => !retry.cancelled)
  let failing = true
  let attempts = 0
  const service = await f.open('pi', {
    dependencies: {
      schedule: (callback, delayMs) => {
        const retry = { callback, delayMs, cancelled: false }
        retries.push(retry)
        return () => {
          retry.cancelled = true
        }
      },
      writeAppliedCopy: async (...args) => {
        attempts++
        if (failing) throw new Error('transient copy failure')
        await writeSettingsProtectionCopy(...args)
      },
    },
  })
  const settle = async (count: number) => {
    for (let i = 0; i < 100 && attempts < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const retry = async () => {
    const [next, ...rest] = pending()
    expect(rest).toEqual([])
    expect(next?.delayMs).toBe(60_000)
    next!.cancelled = true
    const before = attempts
    next!.callback()
    await settle(before + 1)
  }
  await settle(1)
  await retry()
  expect(await Bun.file(`${f.file}.applied.json`).exists()).toBe(false)
  failing = false
  await retry()
  expect(pending()).toEqual([])
  await service.dispose()
  expect(await readSettingsProtectionCopy(f.file, 'pi')).toEqual(complete)
  expect(
    records.filter((record) =>
      record.message.includes('Could not save applied protection'),
    ),
  ).toHaveLength(1)
})

test('a failed copy of a stricter reading is retried after the file turns corrupt, and a restart recovers it', async () => {
  const f = await fixture()
  const retries: (() => void)[] = []
  let failing = false
  let attempts = 0
  let settled = 0
  const service = await f.open('pi', {
    dependencies: {
      schedule: (callback, delayMs) => {
        if (delayMs === 60_000) retries.push(callback)
        return () => {}
      },
      writeAppliedCopy: async (...args) => {
        attempts++
        try {
          if (failing) throw new Error('transient copy failure')
          await writeSettingsProtectionCopy(...args)
        } finally {
          settled++
        }
      },
    },
  })
  // Wait until the given number of copy writes have finished, then let the
  // failure handler run.
  const settle = async (count: number) => {
    for (let i = 0; i < 400 && settled < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await settle(1)
  expect(
    (await readSettingsProtectionCopy(f.file, 'pi'))
      ?.killswitch_default_five_hour,
  ).toBe(21)
  // The stricter reading's copy write fails.
  failing = true
  await writeFile(
    f.file,
    JSON.stringify({ ...complete, killswitch_default_five_hour: 61 }),
  )
  await service.refresh()
  await settle(2)
  expect(retries).toHaveLength(1)
  // The file then turns corrupt before the retry runs.
  await writeFile(f.file, '{broken')
  await service.refresh()
  expect(service.snapshot().protection.pi.rung).toBe(1)
  expect(service.resolve('pi').killswitch_default_five_hour).toBe(61)
  failing = false
  retries[0]!()
  await settle(3)
  expect(attempts).toBe(3)
  await service.dispose()
  const restart = await f.open()
  expect(restart.snapshot().protection.pi.rung).toBe(1)
  expect(restart.resolve('pi').killswitch_default_five_hour).toBe(61)
})

for (const order of ['opencode-first', 'pi-first', 'concurrent'] as const) {
  test(`both hosts preserve distinct whole sets across processes: ${order}`, async () => {
    const f = await fixture({
      killswitch_enabled: { opencode: true, pi: false },
      killswitch_default_five_hour: { opencode: 23, pi: 67 },
      quota_minimum_remaining_seven_day: { opencode: 34, pi: 78 },
      max_same_account_wait: { opencode: 'off', pi: 'cache' },
    })
    if (order === 'concurrent')
      await Promise.all([
        finished(child(f.file, 'opencode')),
        finished(child(f.file, 'pi')),
      ])
    else
      for (const host of order === 'opencode-first'
        ? (['opencode', 'pi'] as const)
        : (['pi', 'opencode'] as const))
        await finished(child(f.file, host))
    await writeFile(f.file, '{broken')
    const [oc, pi] = await Promise.all([f.open('opencode'), f.open('pi')])
    expect(oc.snapshot().protection.opencode.rung).toBe(1)
    expect(pi.snapshot().protection.pi.rung).toBe(1)
    expect(oc.resolve('opencode').killswitch_enabled).toBe(true)
    expect(pi.resolve('pi').killswitch_enabled).toBe(false)
    expect(oc.resolve('opencode').killswitch_default_five_hour).toBe(23)
    expect(pi.resolve('pi').killswitch_default_five_hour).toBe(67)
    expect(oc.resolve('opencode').quota_minimum_remaining_seven_day).toBe(34)
    expect(pi.resolve('pi').quota_minimum_remaining_seven_day).toBe(78)
    expect(oc.resolve('opencode').max_same_account_wait).toBe('off')
    expect(pi.resolve('pi').max_same_account_wait).toBe('cache')
  })
}

for (const missing of [false, true]) {
  for (const copy of [
    'valid',
    'missing',
    'corrupt',
    'other-host-only',
  ] as const) {
    for (const storeState of [
      'full',
      'empty',
      'missing',
      'unparseable',
    ] as const) {
      test(`${missing ? 'missing-after-move' : 'unusable'} file, ${copy} copy, ${storeState} store uses one complete rung`, async () => {
        const f = await fixture('{broken')
        if (missing) {
          await rm(f.file)
          await writeFile(`${f.file}.moved`, '{}')
        }
        const path = `${f.file}.applied.json`
        if (copy === 'valid')
          await writeSettingsProtectionCopy(f.file, 'pi', {
            readAt: 1,
            values: complete,
          })
        if (copy === 'other-host-only')
          await writeSettingsProtectionCopy(f.file, 'opencode', {
            readAt: 1,
            values: complete,
          })
        if (copy === 'corrupt') await writeFile(path, '{bad-copy')
        const before = await readFile(path, 'utf8').catch(() => undefined)
        const paths = {
          config: join(f.root, 'legacy.json'),
          state: join(f.root, 'legacy-state.json'),
        }
        const store = createNativePoolStore({
          paths,
          quota: { validate: () => true, merge: (_, value) => value },
        })
        if (storeState === 'full')
          await store.updateSettings(() => ({
            killswitch: {
              enabled: true,
              main: { five_hour: 81, seven_day: 82, scoped: 83 },
              accounts: {
                legacy: { five_hour: 84, seven_day: 85, scoped: 86 },
              },
            },
            quota: {
              minimumRemaining: { five_hour: 87, seven_day: 88, scoped: 89 },
              failClosedOnUnknownQuota: true,
            },
            routing: { maxSameAccountWait: '0' },
          }))
        if (storeState === 'empty')
          await store.updateSettings(() => ({ dump: { enabled: true } }))
        if (storeState === 'unparseable')
          await writeFile(paths.config, '{bad-store')
        let legacyReads = 0
        const service = await f.open('pi', {
          protection: {
            readLegacyProtection: async (host) => {
              legacyReads++
              return readLegacySettingsProtection({
                host,
                localStore: store,
                vaultStore: store,
                readMode: async () => 'local',
                initializeVaultSettings: async () => {},
              })
            },
          },
        })
        const actual = service.snapshot().protection.pi
        if (copy === 'valid') {
          expect(actual.rung).toBe(1)
          expect(actual.values).toEqual(complete)
        } else if (storeState === 'unparseable') {
          expect(actual.rung).toBe(3)
          expect(actual.values).toEqual({
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
          })
        } else {
          expect(actual.rung).toBe(2)
          expect(actual.values).toEqual(
            storeState === 'full'
              ? {
                  killswitch_enabled: true,
                  killswitch_default_five_hour: 81,
                  killswitch_default_seven_day: 82,
                  killswitch_default_scoped: 83,
                  killswitch_account_floors: [
                    {
                      account: 'legacy',
                      host: 'pi',
                      five_hour: 84,
                      seven_day: 85,
                      scoped: 86,
                    },
                  ],
                  quota_minimum_remaining_five_hour: 87,
                  quota_minimum_remaining_seven_day: 88,
                  quota_minimum_remaining_scoped: 89,
                  quota_fail_closed_on_unknown_quota: 'on',
                  max_same_account_wait: 'off',
                }
              : {
                  killswitch_enabled: false,
                  killswitch_default_five_hour: 5,
                  killswitch_default_seven_day: 10,
                  killswitch_default_scoped: 0,
                  killswitch_account_floors: [],
                  quota_minimum_remaining_five_hour: 0,
                  quota_minimum_remaining_seven_day: 0,
                  quota_minimum_remaining_scoped: 0,
                  quota_fail_closed_on_unknown_quota: 'default',
                  max_same_account_wait: '15m',
                },
          )
        }
        // The other host may recover its own store, but only Pi reads Pi's copy.
        expect(legacyReads).toBe(copy === 'valid' ? 1 : 2)
        await service.dispose()
        expect(await readFile(path, 'utf8').catch(() => undefined)).toBe(before)
      })
    }
  }
}

for (const contents of ['{bad-copy', 'null', '[]', '"invalid"', '17']) {
  for (const host of ['opencode', 'pi'] as const) {
    test(`${host} repairs a corrupt copy ${contents} without inventing the other host's set`, async () => {
      const f = await fixture()
      await writeFile(`${f.file}.applied.json`, contents)
      expect(await readSettingsProtectionCopy(f.file, host)).toBeUndefined()
      await writeSettingsProtectionCopy(f.file, host, {
        readAt: 1,
        values: complete,
      })
      expect(await readSettingsProtectionCopy(f.file, host)).toEqual(complete)
      const other = host === 'pi' ? 'opencode' : 'pi'
      expect(await readSettingsProtectionCopy(f.file, other)).toBeUndefined()
      expect(
        Object.keys(
          JSON.parse(await readFile(`${f.file}.applied.json`, 'utf8')),
        ),
      ).toEqual([host])
    })
  }
}

test('copy publication retries a transient Windows sharing violation before replacing the old set', async () => {
  const f = await fixture()
  await writeSettingsProtectionCopy(f.file, 'pi', {
    readAt: 1,
    values: complete,
  })
  const before = await readFile(`${f.file}.applied.json`, 'utf8')
  const next = { ...complete, killswitch_default_five_hour: 91 }
  let attempts = 0
  let now = 0
  const sleeps: number[] = []
  await writeSettingsProtectionCopy(
    f.file,
    'pi',
    { readAt: 2, values: next },
    undefined,
    {
      platform: 'win32',
      now: () => now,
      sleep: async (ms) => {
        expect(await readFile(`${f.file}.applied.json`, 'utf8')).toBe(before)
        sleeps.push(ms)
        now += ms
      },
      rename: async (from, to) => {
        if (++attempts === 1)
          throw Object.assign(new Error('file is open'), { code: 'EPERM' })
        await fs.rename(from, to)
      },
    },
  )
  expect(attempts).toBe(2)
  expect(sleeps).toEqual([10])
  expect(await readSettingsProtectionCopy(f.file, 'pi')).toEqual(next)
})

test('copy publication keeps the old set when Windows sharing violations exhaust retries', async () => {
  const f = await fixture()
  await writeSettingsProtectionCopy(f.file, 'pi', {
    readAt: 1,
    values: complete,
  })
  const before = await readFile(`${f.file}.applied.json`, 'utf8')
  const failure = Object.assign(new Error('file remains open'), {
    code: 'EPERM',
  })
  let attempts = 0
  let now = 0
  await expect(
    writeSettingsProtectionCopy(
      f.file,
      'pi',
      { readAt: 2, values: complete },
      undefined,
      {
        platform: 'win32',
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
        rename: async () => {
          attempts++
          throw failure
        },
      },
    ),
  ).rejects.toBe(failure)
  expect(attempts).toBe(6)
  expect(await readFile(`${f.file}.applied.json`, 'utf8')).toBe(before)
})

test('a Windows retry rechecks copy lock ownership before attempting replacement again', async () => {
  const f = await fixture()
  await writeSettingsProtectionCopy(f.file, 'pi', {
    readAt: 1,
    values: complete,
  })
  const before = await readFile(`${f.file}.applied.json`, 'utf8')
  const failure = Object.assign(new Error('file is open'), { code: 'EPERM' })
  let attempts = 0
  let now = 0
  const result = await writeSettingsProtectionCopy(
    f.file,
    'pi',
    { readAt: 2, values: complete },
    undefined,
    {
      platform: 'win32',
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
      rename: async () => {
        attempts++
        const path = `${f.file}.applied.json.protection.lock`
        const lock = JSON.parse(await readFile(path, 'utf8'))
        await writeFile(
          path,
          JSON.stringify({ ...lock, ownerId: 'successor-owner' }),
        )
        throw failure
      },
    },
  ).then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  )
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).not.toBe(failure)
  expect(attempts).toBe(1)
  expect(now).toBe(10)
  expect(await readFile(`${f.file}.applied.json`, 'utf8')).toBe(before)
})

test('whole-set copy validation rejects missing fields, bad scalars, bad entries and overlaps', async () => {
  const f = await fixture('{broken')
  const incomplete = { ...complete } as Partial<SettingsProtectionValues>
  delete incomplete.max_same_account_wait
  for (const values of [
    incomplete,
    { ...complete, killswitch_enabled: 'true' },
    { ...complete, quota_minimum_remaining_five_hour: 101 },
    { ...complete, max_same_account_wait: 'max' },
    { ...complete, quota_fail_closed_on_unknown_quota: true },
    { ...complete, credentials: 'not-settings' },
    {
      ...complete,
      killswitch_account_floors: [
        { account: 'a', host: 'pi', '5h': 5, seven_day: 10, scoped: 0 },
      ],
    },
    {
      ...complete,
      killswitch_account_floors: [
        { account: 'a', host: 'pi', five_hour: 5, seven_day: 10 },
      ],
    },
    {
      ...complete,
      killswitch_account_floors: [
        { account: 'a', host: 'other', five_hour: 5, seven_day: 10, scoped: 0 },
      ],
    },
    {
      ...complete,
      killswitch_account_floors: [
        { account: 'a', host: 'both', five_hour: 5, seven_day: 10, scoped: 0 },
        { account: 'a', host: 'pi', five_hour: 5, seven_day: 10, scoped: 0 },
      ],
    },
  ]) {
    await writeFile(
      `${f.file}.applied.json`,
      JSON.stringify({ pi: { readAt: 1, values } }),
    )
    expect(await readSettingsProtectionCopy(f.file, 'pi')).toBeUndefined()
  }
  for (const readAt of [undefined, 'yesterday', -1]) {
    await writeFile(
      `${f.file}.applied.json`,
      JSON.stringify({ pi: { readAt, values: complete } }),
    )
    expect(await readSettingsProtectionCopy(f.file, 'pi')).toBeUndefined()
  }
  await rm(`${f.file}.applied.json`)
  await mkdir(`${f.file}.applied.json`)
  expect(await readSettingsProtectionCopy(f.file, 'pi')).toBeUndefined()
  await expect(
    writeSettingsProtectionCopy(f.file, 'pi', { readAt: 1, values: complete }),
  ).rejects.toBeInstanceOf(Error)
  expect((await stat(`${f.file}.applied.json`)).isDirectory()).toBe(true)
})

test('a writer preserves even an invalid other-host entry without reading it as its own', async () => {
  const f = await fixture('{broken')
  const other = { readAt: 123, values: { unknown: 'keep-this' } }
  await writeFile(`${f.file}.applied.json`, JSON.stringify({ opencode: other }))
  await writeSettingsProtectionCopy(f.file, 'pi', {
    readAt: 2,
    values: complete,
  })
  expect(
    JSON.parse(await readFile(`${f.file}.applied.json`, 'utf8')).opencode,
  ).toEqual(other)
  expect(await readSettingsProtectionCopy(f.file, 'opencode')).toBeUndefined()
  expect(await readSettingsProtectionCopy(f.file, 'pi')).toEqual(complete)
})

test('an atomic copy write failure logs once and keeps the previous copy byte-identical', async () => {
  const f = await fixture()
  const service = await f.open()
  await service.dispose()
  const before = await readFile(`${f.file}.applied.json`, 'utf8')
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => {
    if (record.channel === 'settings') records.push(record)
  })
  const original = fs.rename
  const rename = spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === `${f.file}.applied.json`)
      throw new Error('injected commit failure')
    return original(from, to)
  })
  try {
    const running = await f.open()
    await writeFile(
      f.file,
      JSON.stringify({ ...complete, killswitch_default_five_hour: 93 }),
    )
    await running.refresh()
    await running.dispose()
    expect(await readFile(`${f.file}.applied.json`, 'utf8')).toBe(before)
    expect(records.map((record) => record.message)).toEqual([
      `Could not save applied protection settings for pi at "${f.file}.applied.json"; the previous copy is unchanged until a retry succeeds.`,
    ])
  } finally {
    rename.mockRestore()
  }
})

for (const bad of [
  { killswitch_default_five_hour: 101 },
  {
    killswitch_account_floors: [
      { account: 'a', host: 'both', five_hour: 1, seven_day: 2, scoped: 3 },
      { account: 'a', host: 'pi', five_hour: 1, seven_day: 2, scoped: 3 },
    ],
  },
]) {
  test(`an unusable protection set writes no disk copy: ${JSON.stringify(bad)}`, async () => {
    const f = await fixture(bad)
    const service = await f.open()
    expect(service.snapshot().protection.pi.rung).toBe(3)
    await service.dispose()
    expect(await Bun.file(`${f.file}.applied.json`).exists()).toBe(false)
  })
}
