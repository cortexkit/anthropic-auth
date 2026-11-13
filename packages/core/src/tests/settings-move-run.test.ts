import { afterEach, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { withLock } from '@cortexkit/common-auth/fs'
import { parse } from 'jsonc-parser'

import { HOLDER_FILE_NAME, type HolderEntry } from '../holder-registry.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from '../pool-store.ts'
import { settingsImportRecordPath } from '../settings-mode.ts'
import { settingsMoveHolderFiles } from '../settings-move-fence.ts'
import {
  runSettingsMoveAtStartup,
  type SettingsMoveStartupOptions,
} from '../settings-move-run.ts'
import { prepareSettingsMoveSources } from '../settings-move-sources.ts'
import { resolveSettingsPaths, type SettingsHost } from '../settings-paths.ts'
import { openSettingsService } from '../settings-service.ts'
import { LEGACY_STATE_LAYOUT } from '../state-layout-paths.ts'

const { setSettingsFsForTest } = await import(
  new URL('fs.js', import.meta.resolve('@cortexkit/common-auth/settings')).href
)
const { setSettingsMoveStepHookForTest } = await import(
  new URL('move.js', import.meta.resolve('@cortexkit/common-auth/settings'))
    .href
)
const io = { ...fs }
const cleanup: (() => Promise<unknown> | undefined)[] = []
afterEach(async () => {
  setSettingsFsForTest()
  setSettingsMoveStepHookForTest()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function put(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value))
}

async function absent(path: string) {
  return io.lstat(path).then(
    () => false,
    (error) => {
      if (error.code === 'ENOENT') return true
      throw error
    },
  )
}

function holder(release: string, own = false): HolderEntry {
  return {
    pid: own ? 100 : 200,
    incarnation: own ? 'self' : 'peer',
    instance: own ? 'own-copy' : 'peer-copy',
    role: own ? 'opencode1' : 'pi',
    release,
    kind: 'legacy',
    identity: null,
    files: [],
    registeredAt: Date.now(),
  }
}

async function fixture(host: SettingsHost = 'opencode') {
  const root = await io.realpath(
    await io.mkdtemp(join(tmpdir(), 'settings-run-')),
  )
  cleanup.push(() => io.rm(root, { recursive: true, force: true }))
  const touched: string[] = []
  const reads: string[] = []
  const messages: string[] = []
  const record = (path: string) => {
    expect(path === root || path.startsWith(`${root}/`)).toBe(true)
    touched.push(path)
  }
  // Observe Core's authority/source probes as well as the public mover's reads.
  for (const name of [
    'lstat',
    'readFile',
    'readdir',
    'mkdir',
    'open',
    'unlink',
    'link',
  ] as const) {
    const original = io[name] as (...args: unknown[]) => unknown
    const spy = spyOn(fs, name).mockImplementation(((
      path: string,
      ...args: unknown[]
    ) => {
      record(path)
      if (name === 'link') record(args[0] as string)
      return original(path, ...args)
    }) as never)
    cleanup.push(() => {
      spy.mockRestore()
      return undefined
    })
  }
  setSettingsFsForTest({
    ...fs,
    async readFile(path: string, encoding: 'utf8') {
      record(path)
      reads.push(path)
      return io.readFile(path, encoding)
    },
  })
  const options: SettingsMoveStartupOptions = {
    host,
    home: root,
    platform: 'linux',
    env: { HOME: root, XDG_STATE_HOME: join(root, 'state') },
    realpath: async (path) => {
      record(path)
      return io.realpath(path)
    },
    readMode: async () => 'local',
    initializeVaultSettings: async () => {},
    log: { warn: (message) => messages.push(message) },
    fence: {
      registration: { status: 'registered' },
      floor: '2.12.0',
      self: { pid: 100, incarnation: 'self', instance: 'own-copy' },
      liveness: {
        pidAlive: () => true,
        // This process (pid 100) is its own incarnation, so its own entry is
        // live and only the self check can exclude it.
        incarnation: async (pid) => (pid === 100 ? 'self' : 'peer'),
      },
      artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
      readHolders: async () => undefined,
    },
  }
  const paths = await resolveSettingsPaths(host, options)
  const stores = {
    opencode: await resolveNativePoolPaths(
      paths.defaults.opencode.account,
      paths.defaults.opencode.state,
      LEGACY_STATE_LAYOUT,
    ),
    pi: await resolveNativePoolPaths(
      paths.defaults.pi.account,
      paths.defaults.pi.state,
      LEGACY_STATE_LAYOUT,
    ),
  }
  return {
    root,
    options,
    paths,
    stores,
    touched,
    reads,
    messages,
    start: () => runSettingsMoveAtStartup(options),
  }
}

test('startup publishes before the first resolve, preserves every source, and notes even an empty source', async () => {
  const f = await fixture()
  const original = '{"dump":{"enabled":true},"killswitch":{"enabled":false}}\n'
  await put(f.stores.opencode.config, {})
  await fs.writeFile(f.stores.opencode.config, original)
  await put(f.stores.pi.config, { unmoved: 'kept' })
  const peerBytes = await fs.readFile(f.stores.pi.config, 'utf8')
  let beforePublish = false
  setSettingsMoveStepHookForTest(async (step: string) => {
    if (step !== 'before-publish') return
    beforePublish = true
    expect(await absent(f.paths.marker)).toBe(true)
    for (const store of Object.values(f.stores))
      expect(await absent(`${store.config}.MOVED_READPLEASE`)).toBe(true)
  })
  const started = await f.start()
  expect(beforePublish).toBe(true)
  expect(started.mode).toBe('user-file')
  expect(started.mayOpenService).toBe(true)
  expect(started.outcome).toBe('moved')
  expect(f.reads).toEqual([f.stores.opencode.config, f.stores.pi.config])
  expect(await fs.readFile(f.stores.opencode.config, 'utf8')).toBe(original)
  expect(await fs.readFile(f.stores.pi.config, 'utf8')).toBe(peerBytes)
  for (const store of Object.values(f.stores)) {
    expect(
      await fs.readFile(`${store.config}.MOVED_READPLEASE`, 'utf8'),
    ).toContain(f.paths.target)
  }
  const service = await openSettingsService({ file: started.paths.target })
  cleanup.push(() => service?.dispose())
  expect(service?.resolve('opencode').dump_enabled).toBe(true)
  expect(JSON.parse(await fs.readFile(f.paths.marker, 'utf8')).target).toBe(
    await fs.realpath(f.paths.target),
  )
  expect((await fs.stat(f.paths.marker)).mode & 0o777).toBe(0o600)
  // Restart authority is the marker, not the informational notes or stale stores.
  await fs.unlink(f.paths.target)
  f.reads.length = 0
  expect((await f.start()).outcome).toBe('marker-present')
  expect(f.reads).toEqual([])
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} no-source start publishes schema only; restart and first menu write never import legacy data`, async () => {
    const f = await fixture(host)
    const started = await f.start()
    expect(started.outcome).toBe('moved')
    expect(parse(await fs.readFile(f.paths.target, 'utf8'))).toEqual({
      schema_version: 1,
    })
    expect(await absent(f.paths.marker)).toBe(false)
    for (const store of Object.values(f.stores)) {
      expect(await absent(`${store.config}.MOVED_READPLEASE`)).toBe(true)
      expect(
        f.messages.filter((message) => message.includes(store.config)),
      ).toHaveLength(1)
    }
    expect(f.reads).toEqual([f.stores.opencode.config, f.stores.pi.config])
    f.reads.length = 0
    expect((await f.start()).outcome).toBe('marker-present')
    expect(f.reads.every((path) => path === f.paths.target)).toBe(true)
    const service = await openSettingsService({ file: started.paths.target })
    cleanup.push(() => service?.dispose())
    expect(service?.resolve(host).killswitch_enabled).toBe(false)
    await service?.update(
      [{ setting: 'cache_keep_subagents', value: true }],
      host,
      { createMissing: true },
    )
    expect(parse(await fs.readFile(f.paths.target, 'utf8'))).toEqual({
      schema_version: 1,
      cache_keep_subagents: true,
    })
    for (const store of Object.values(f.stores))
      expect(await absent(store.config)).toBe(true)
  })
}

test('concurrent starts have one winner and publish one target and marker', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  const starts = await Promise.all(Array.from({ length: 4 }, () => f.start()))
  expect(starts.filter((start) => start.outcome === 'moved')).toHaveLength(1)
  expect(
    starts.every((start) =>
      ['moved', 'done-already', 'aborted-target-appeared'].includes(
        start.outcome,
      ),
    ),
  ).toBe(true)
  expect(starts.every((start) => start.mode === 'user-file')).toBe(true)
  expect(await absent(f.paths.marker)).toBe(false)
})

for (const failure of ['parse', 'read'] as const) {
  test(`${failure} failure publishes nothing, retains legacy writes and retries at next start`, async () => {
    const f = await fixture()
    await put(f.stores.opencode.config, { dump: { enabled: true } })
    if (failure === 'parse')
      await fs.writeFile(f.stores.opencode.config, '{broken')
    else
      setSettingsFsForTest({
        ...fs,
        readFile: async (path: string, encoding: 'utf8') => {
          if (path === f.stores.opencode.config)
            throw Object.assign(new Error('denied'), { code: 'EACCES' })
          return io.readFile(path, encoding)
        },
      })
    const started = await f.start()
    expect(started.mode).toBe('legacy')
    expect(started.outcome).toBe('failed')
    expect(
      f.messages.filter((message) =>
        message.startsWith('Settings move failed'),
      ),
    ).toHaveLength(1)
    expect(await absent(f.paths.target)).toBe(true)
    expect(await absent(f.paths.marker)).toBe(true)
    expect(await absent(`${f.stores.opencode.config}.MOVED_READPLEASE`)).toBe(
      true,
    )
    await put(f.stores.opencode.config, {
      dump: { enabled: false },
      prime: { enabled: true },
    })
    setSettingsFsForTest({ ...fs })
    expect((await f.start()).outcome).toBe('moved')
    expect(parse(await fs.readFile(f.paths.target, 'utf8'))).toMatchObject({
      dump_enabled: false,
      prime_enabled: true,
    })
  })
}

test('an invalid protection field moves its restrictive replacement and other valid fields', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, {
    killswitch: { enabled: 'bad' },
    dump: { enabled: true },
  })
  expect((await f.start()).outcome).toBe('moved')
  expect(parse(await fs.readFile(f.paths.target, 'utf8'))).toMatchObject({
    killswitch_enabled: true,
    dump_enabled: true,
  })
  expect(
    f.messages.filter((message) =>
      message.includes(
        'killswitch.enabled is invalid; replaced with protection value true',
      ),
    ),
  ).toHaveLength(1)
})

for (const release of [
  '2.11.2',
  '2.12.0-beta.1',
  'unknown',
  'bad',
  'unreadable',
] as const) {
  test(`${release} live peer closes startup fence without touching sources`, async () => {
    const f = await fixture()
    await put(f.stores.opencode.config, { dump: { enabled: true } })
    f.options.fence.readHolders = async () => {
      if (release === 'unreadable') throw new Error('unreadable')
      return {
        version: 1,
        entries: [holder(release)],
      }
    }
    const started = await f.start()
    expect(started.mode).toBe('legacy')
    expect(started.mayOpenService).toBe(true)
    expect(started.outcome).toBe('fence-closed')
    expect(f.reads).toEqual([])
    expect(await absent(f.paths.target)).toBe(true)
    expect(await absent(f.paths.marker)).toBe(true)
    const store = createNativePoolStore({
      paths: f.stores.opencode,
      quota: nativeQuotaCodec,
    })
    cleanup.push(() => store.close())
    const legacy = await store.readSettings()
    expect(legacy.status).toBe('ready')
    if (legacy.status === 'ready')
      expect(legacy.settings.dump).toEqual({ enabled: true })
    await store.updateSettings((settings) => ({
      ...settings,
      dump: { enabled: false },
    }))
    const updated = await store.readSettings()
    expect(updated.status).toBe('ready')
    if (updated.status === 'ready')
      expect(updated.settings.dump).toEqual({ enabled: false })
    expect(await absent(f.paths.target)).toBe(true)
  })
}

async function heldHolderLock(
  holderFile: string,
  work: () => Promise<void>,
): Promise<void> {
  await withLock(
    holderFile,
    { name: 'holders', ttlMs: 10_000, timeoutMs: 20_000, renew: true },
    work,
  )
}

/** Wait until `path` exists: the event a test waits for, not a fixed delay. */
async function waitForPath(path: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (await absent(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Two holder files the move takes `holders` locks on: both hosts' store folders. */
function twoHolderFiles(f: Awaited<ReturnType<typeof fixture>>) {
  return [
    join(dirname(f.paths.defaults.opencode.account), HOLDER_FILE_NAME),
    join(dirname(f.paths.defaults.pi.account), HOLDER_FILE_NAME),
  ] as const
}

test('an older holder registering while the move waits for its holder locks keeps the move from publishing', async () => {
  const f = await fixture()
  f.options.fence.readHolders = undefined
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  await put(f.stores.pi.config, { killswitch: { enabled: true } })
  const [first, second] = twoHolderFiles(f)
  expect(first).not.toBe(second)
  let started: ReturnType<typeof f.start> | undefined
  await heldHolderLock(first, () =>
    heldHolderLock(second, async () => {
      started = f.start()
      // The mover takes its settings-move lock only after both unlocked
      // fence checks passed; it then waits for the holder locks held here.
      await waitForPath(`${f.paths.target}.settings-move.lock`)
      await fs.writeFile(
        second,
        JSON.stringify({ version: 1, entries: [holder('2.11.2')] }),
      )
    }),
  )
  expect((await started)?.outcome).toBe('fence-closed')
  expect(await absent(f.paths.target)).toBe(true)
  expect(await absent(f.paths.marker)).toBe(true)
})

test("an older holder can't register in either holder file between the move's last fence check and publication", async () => {
  const f = await fixture()
  f.options.fence.readHolders = undefined
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  await put(f.stores.pi.config, { killswitch: { enabled: true } })
  const files = twoHolderFiles(f)
  const attempts: Awaited<ReturnType<typeof tryRegister>>[] = []
  setSettingsMoveStepHookForTest(async (step: string) => {
    // 'locked' runs right after the mover's fence check under its locks.
    if (step === 'locked')
      for (const file of files) attempts.push(await tryRegister(file))
  })
  expect((await f.start()).outcome).toBe('moved')
  expect(attempts).toEqual(['lock-held', 'lock-held'])
  // Both locks are released once the move has published.
  for (const file of files) expect(await tryRegister(file)).toBe('registered')
})

/**
 * Try to register an entry in `holderFile` the way a registrant does: create
 * its folder, then take its `holders` lock. Gives up after a short wait
 * instead of blocking, so a test can tell that the lock is held.
 */
async function tryRegister(
  holderFile: string,
  release = '2.11.2',
): Promise<'registered' | 'lock-held'> {
  await fs.mkdir(dirname(holderFile), { recursive: true, mode: 0o700 })
  try {
    await withLock(
      holderFile,
      { name: 'holders', ttlMs: 10_000, timeoutMs: 300 },
      async () => {
        await fs.writeFile(
          holderFile,
          JSON.stringify({ version: 1, entries: [holder(release)] }),
        )
      },
    )
    return 'registered'
  } catch (error) {
    if ((error as Error).name === 'LockContentionError') return 'lock-held'
    throw error
  }
}

test('a holder folder missing at the start is created first, so a registrant during publication waits for the move', async () => {
  const f = await fixture()
  f.options.fence.readHolders = undefined
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  const holderFiles = await settingsMoveHolderFiles({
    ...f.options,
    stores: [
      f.paths.own.account,
      f.paths.defaults.opencode.account,
      f.paths.defaults.pi.account,
    ],
  })
  // The state-home folder is one the fence depends on; nothing created it.
  const holderFile = holderFiles.find((file) =>
    file.startsWith(join(f.root, 'state')),
  )!
  expect(await absent(dirname(holderFile))).toBe(true)
  let attempt: Awaited<ReturnType<typeof tryRegister>> | undefined
  setSettingsMoveStepHookForTest(async (step: string) => {
    // After the mover's check for skipped lock folders, just before publication.
    if (step === 'before-publish') attempt = await tryRegister(holderFile)
  })
  expect((await f.start()).outcome).toBe('moved')
  expect(attempt).toBe('lock-held')
  expect((await fs.stat(dirname(holderFile))).mode & 0o777).toBe(0o700)
  // The lock is released once the move has published.
  expect(await tryRegister(holderFile, '2.12.0')).toBe('registered')
})

test('the own lower-release holder is excluded and a separate install never moves or opens the service', async () => {
  const f = await fixture()
  f.options.fence.readHolders = async () => ({
    version: 1,
    entries: [holder('2.11.2', true)],
  })
  expect((await f.start()).outcome).toBe('moved')
  f.options.env = {
    ...f.options.env,
    OPENCODE_ANTHROPIC_AUTH_FILE: join(f.root, 'separate', 'accounts.json'),
  }
  const started = await f.start()
  expect(started.mode).toBe('separate')
  expect(started.mayOpenService).toBe(false)
  expect(started.outcome).toBe('separate-install')
})

test('a named target does not suppress the default target move or overwrite an existing note', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  f.options.env = {
    ...f.options.env,
    ANTHROPIC_AUTH_SETTINGS_FILE: join(f.root, 'custom', 'settings.jsonc'),
  }
  const named = await f.start()
  expect(named.outcome).toBe('moved')
  const marker = await fs.readFile(named.paths.marker, 'utf8')
  const note = await fs.readFile(
    `${f.stores.opencode.config}.MOVED_READPLEASE`,
    'utf8',
  )
  f.options.env = { ...f.options.env, ANTHROPIC_AUTH_SETTINGS_FILE: undefined }
  expect((await f.start()).outcome).toBe('moved')
  expect(await fs.readFile(named.paths.marker, 'utf8')).toBe(marker)
  expect(
    await fs.readFile(`${f.stores.opencode.config}.MOVED_READPLEASE`, 'utf8'),
  ).toBe(note)
  expect(f.reads.some((path) => path.endsWith('.MOVED_READPLEASE'))).toBe(false)
})

for (const failure of ['custody', 'seeding'] as const) {
  test(`own ${failure} failure logs once without invoking the mover or writing authority`, async () => {
    const f = await fixture()
    f.options.readMode = async () => {
      if (failure === 'custody') throw new Error('unreadable custody')
      return 'claustrum'
    }
    f.options.initializeVaultSettings = async () => {
      throw new Error('seeding failed')
    }
    f.options.dependencies = {
      move: async () => {
        throw new Error('mover must not run')
      },
    }
    const started = await f.start()
    expect(started.mode).toBe('legacy')
    expect(started.outcome).toBe('source-unavailable')
    expect(f.messages).toHaveLength(1)
    expect(await absent(f.paths.target)).toBe(true)
    expect(await absent(f.paths.marker)).toBe(true)
  })
}

test('source lock timeout never marks the target and legacy reads remain available', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  await put(f.stores.pi.config, {})
  f.options.dependencies = {
    prepareSources: async (options) => {
      const prepared = await prepareSettingsMoveSources(options)
      if (prepared.status === 'ready')
        for (const source of prepared.sources)
          source.locks = source.locks.map((lock) => ({
            ...lock,
            timeoutMs: 30,
          }))
      return prepared
    },
  }
  const lock = nativePoolStoreLocks(f.stores.opencode)[1]
  await withLock(
    lock.path,
    { name: lock.name, ttlMs: 10_000, timeoutMs: 100 },
    async () => {
      const started = await f.start()
      expect(started.outcome).toBe('busy')
      expect(started.mode).toBe('legacy')
      expect(f.messages).toHaveLength(1)
      expect(await absent(f.paths.target)).toBe(true)
      expect(await absent(f.paths.marker)).toBe(true)
    },
  )
  const store = createNativePoolStore({
    paths: f.stores.opencode,
    quota: nativeQuotaCodec,
  })
  cleanup.push(() => store.close())
  const legacy = await store.readSettings()
  expect(legacy.status).toBe('ready')
  if (legacy.status === 'ready')
    expect(legacy.settings.dump).toEqual({ enabled: true })
})

test('an existing user file marks authority and reports an unimported source even with a closed fence', async () => {
  const f = await fixture()
  await put(f.paths.target, { schema_version: 1, dump_enabled: false })
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  f.options.fence.registration = undefined
  f.options.dependencies = {
    move: async () => {
      throw new Error('mover must not run')
    },
  }
  const started = await f.start()
  expect(started.mode).toBe('user-file')
  expect(started.outcome).toBe('done-already')
  expect(f.reads).toEqual([f.paths.target])
  expect(await absent(f.paths.marker)).toBe(false)
  expect(
    f.messages.filter((message) => message.includes('were not imported')),
  ).toEqual([expect.stringContaining(f.stores.opencode.config)])
})

test('simulated Windows default targets each move and publish their own marker', async () => {
  const home = 'C:\\sandbox\\settings-move'
  const files = new Map<string, string>()
  const moves: string[] = []
  const preparations: string[] = []
  const touched: string[] = []
  const record = (path: string) => {
    expect(path === home || path.startsWith(`${home}\\`)).toBe(true)
    touched.push(path)
  }
  const options: SettingsMoveStartupOptions = {
    host: 'opencode',
    home,
    platform: 'win32',
    env: { USERPROFILE: home, APPDATA: win32.join(home, 'AppData', 'Roaming') },
    realpath: async (path) => {
      record(path)
      if (path === home) return path
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    },
    initializeVaultSettings: async () => {
      throw new Error('no vault expected')
    },
    authority: {
      now: () => 123,
      fs: {
        exists: async (path) => {
          record(path)
          return files.has(path)
        },
        mkdir: async (path) => {
          record(path)
        },
        writeMarker: async (path, bytes) => {
          record(path)
          files.set(path, Buffer.from(bytes).toString())
        },
      },
    },
    fence: {
      registration: { status: 'registered' },
      self: { pid: 100, incarnation: 'self', instance: 'own-copy' },
      artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
      readHolders: async (path) => {
        record(path)
        return undefined
      },
    },
    dependencies: {
      prepareSources: async ({ paths }) => {
        expect(paths?.sourceRule).toBe('default')
        preparations.push(paths!.target)
        return { status: 'ready', sources: [] }
      },
      // Source discovery and publication are simulated; paths, authority and the fence stay real.
      move: async (move) => {
        expect(await move.fence()).toBe(true)
        expect(files.has(move.target)).toBe(false)
        record(move.target)
        moves.push(move.target)
        files.set(move.target, '{"schema_version":1}')
        return {
          outcome: 'moved',
          unmapped: [],
          differing: [],
          noteFailures: [],
          postPublishFailures: [],
        }
      },
    },
  }
  const roaming = await runSettingsMoveAtStartup(options)
  const roamingMarker = files.get(roaming.paths.marker)
  options.env = { ...options.env, XDG_CONFIG_HOME: win32.join(home, '.config') }
  const xdg = await runSettingsMoveAtStartup(options)
  expect(roaming.paths.target).toBe(
    win32.join(home, 'AppData', 'Roaming', 'cortexkit', 'anthropic-auth.jsonc'),
  )
  expect(xdg.paths.target).toBe(
    win32.join(home, '.config', 'cortexkit', 'anthropic-auth.jsonc'),
  )
  expect(moves).toEqual([roaming.paths.target, xdg.paths.target])
  expect(preparations).toEqual(moves)
  for (const started of [roaming, xdg]) {
    expect(started.mode).toBe('user-file')
    expect(JSON.parse(files.get(started.paths.marker)!)).toEqual({
      version: 1,
      target: started.paths.target,
      at: 123,
    })
  }
  expect(files.get(roaming.paths.marker)).toBe(roamingMarker)
  expect((await runSettingsMoveAtStartup(options)).outcome).toBe(
    'marker-present',
  )
  expect(moves).toHaveLength(2)
  expect(touched.length).toBeGreaterThan(0)
})

for (const invalid of [false, true]) {
  test(`hand-made authority marks a parsed file with invalid protection=${invalid} and names every held source`, async () => {
    const f = await fixture()
    await put(f.paths.target, {
      schema_version: 1,
      dump_enabled: false,
      ...(invalid ? { killswitch_default_five_hour: 101 } : {}),
    })
    await put(f.stores.opencode.config, { dump: { enabled: false } })
    await put(f.stores.pi.config, { cacheKeep: { startHour: 8, endHour: 12 } })
    const started = await f.start()
    expect(started.outcome).toBe('done-already')
    expect(await absent(f.paths.marker)).toBe(false)
    const records = f.messages.filter((message) =>
      message.includes('were not imported'),
    )
    expect(records).toHaveLength(2)
    for (const store of Object.values(f.stores))
      expect(
        records.filter((message) => message.includes(store.config)),
      ).toHaveLength(1)
    expect(await absent(`${f.stores.opencode.config}.MOVED_READPLEASE`)).toBe(
      true,
    )
    await fs.unlink(f.paths.target)
    f.options.readMode = async () => 'claustrum'
    f.options.initializeVaultSettings = async () => {
      throw new Error('must not seed')
    }
    expect((await f.start()).outcome).toBe('marker-present')
    expect(await absent(f.paths.target)).toBe(true)
  })
}

for (const closed of [false, true]) {
  test(`malformed hand-made file is authoritative with fence closed=${closed}, but never marked`, async () => {
    const f = await fixture()
    await put(f.stores.opencode.config, {
      dump: { enabled: true },
      killswitch: { enabled: true },
    })
    await fs.mkdir(dirname(f.paths.target), { recursive: true })
    await fs.writeFile(f.paths.target, '{broken')
    if (closed) f.options.fence.registration = undefined
    expect((await f.start()).outcome).toBe('done-already')
    expect(await absent(f.paths.marker)).toBe(true)
    const service = await openSettingsService({ file: f.paths.target })
    cleanup.push(() => service?.dispose())
    expect(service!.resolve('opencode').dump_enabled).toBe(false)
  })
}

test('later starts compare only their current-mode explicit values without merging, and log again after a menu change', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  await put(f.stores.pi.config, { dump: { enabled: true } })
  expect((await f.start()).outcome).toBe('moved')
  f.messages.length = 0
  expect((await f.start()).outcome).toBe('marker-present')
  expect(
    f.messages.filter((message) => message.includes('were not imported')),
  ).toHaveLength(0)
  const service = await openSettingsService({ file: f.paths.target })
  await service!.update([{ setting: 'dump_enabled', value: false }], 'opencode')
  await service!.dispose()
  for (let start = 0; start < 2; start++) {
    f.messages.length = 0
    expect((await f.start()).outcome).toBe('marker-present')
    const records = f.messages.filter((message) =>
      message.includes('were not imported'),
    )
    expect(records).toHaveLength(1)
    expect(records[0]).toContain(f.stores.opencode.config)
    expect(records[0]).toContain('dump_enabled')
    expect(records[0]).not.toContain(f.stores.pi.config)
  }
  f.options.readMode = async () => 'claustrum'
  f.options.initializeVaultSettings = async () => {
    throw new Error('must not seed during diagnostics')
  }
  f.messages.length = 0
  await f.start()
  expect(
    f.messages.filter((message) => message.includes('were not imported')),
  ).toHaveLength(0)
})

test('a later host whose store was never imported keeps its stricter protection until the file sets it for that host', async () => {
  const f = await fixture()
  f.options.env = {
    ...f.options.env,
    ANTHROPIC_AUTH_SETTINGS_FILE: join(f.root, 'shared.jsonc'),
  }
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  await put(f.stores.pi.config, { killswitch: { enabled: true } })
  const moved = await f.start()
  expect(moved.outcome).toBe('moved')
  expect(f.reads).not.toContain(f.stores.pi.config)
  const record = (host: SettingsHost) =>
    settingsImportRecordPath(moved.paths.target, host)
  // The explicit target moved only OpenCode's store.
  expect(
    Object.keys(
      JSON.parse(await fs.readFile(record('opencode'), 'utf8')),
    ).sort(),
  ).toEqual(['at', 'host', 'release', 'version'])
  expect(await absent(record('pi'))).toBe(true)
  f.options.host = 'pi'
  f.messages.length = 0
  // Pi's own store holds a stricter killswitch than Pi resolves from the
  // file, which cannot yet hold a value for Pi alone: Pi stays legacy.
  expect(await f.start()).toMatchObject({
    mode: 'legacy',
    outcome: 'import-refused',
    mayOpenService: false,
  })
  expect(f.messages).toEqual([
    `Settings file ${moved.paths.target} is not used by pi: its legacy settings protect more for killswitch_enabled. pi keeps its legacy settings; set these for pi in the settings file to start using it.`,
  ])
  expect(await absent(record('pi'))).toBe(true)
  // Once the file holds Pi's own value (here written by hand; a later
  // common-auth can write it at Pi's level), Pi adopts the file and records
  // its import.
  await fs.writeFile(
    moved.paths.target,
    JSON.stringify({
      schema_version: 1,
      dump_enabled: true,
      killswitch_enabled: { default: false, pi: true },
    }),
  )
  f.messages.length = 0
  expect(await f.start()).toMatchObject({
    mode: 'user-file',
    outcome: 'marker-present',
  })
  expect(await absent(record('pi'))).toBe(false)
  const service = await openSettingsService({ file: moved.paths.target })
  expect(service!.resolve('pi').killswitch_enabled).toBe(true)
  await service!.dispose()
  await fs.unlink(moved.paths.target)
  expect((await f.start()).outcome).toBe('marker-present')
  expect(await absent(moved.paths.target)).toBe(true)
  expect(await absent(`${f.stores.pi.config}.MOVED_READPLEASE`)).toBe(true)
})

test('a default-target move records both hosts, so a later start adopts without a check', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  await put(f.stores.pi.config, { killswitch: { enabled: true } })
  expect((await f.start()).outcome).toBe('moved')
  for (const host of ['opencode', 'pi'] as const)
    expect(await absent(settingsImportRecordPath(f.paths.target, host))).toBe(
      false,
    )
  f.options.host = 'pi'
  expect(await f.start()).toMatchObject({
    mode: 'user-file',
    outcome: 'marker-present',
  })
})

test('a hand-made file is adopted and recorded when the host store protects no more', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { killswitch: { enabled: true } })
  await put(f.paths.target, { schema_version: 1, killswitch_enabled: true })
  expect(await f.start()).toMatchObject({ mode: 'user-file' })
  expect(
    await absent(settingsImportRecordPath(f.paths.target, 'opencode')),
  ).toBe(false)
})

test('a peer store with unreadable custody keeps the start in legacy, and a later start moves its protection', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  await put(f.stores.pi.config, { killswitch: { enabled: true } })
  f.options.readMode = async (host) => {
    if (host === 'pi') throw new Error('peer custody unreadable')
    return 'local'
  }
  const first = await f.start()
  expect(first).toMatchObject({ mode: 'legacy', outcome: 'source-unavailable' })
  expect(await absent(f.paths.target)).toBe(true)
  expect(await absent(f.paths.marker)).toBe(true)
  expect(await absent(`${f.stores.opencode.config}.MOVED_READPLEASE`)).toBe(
    true,
  )
  expect(
    f.messages.filter((message) =>
      message.includes('Settings move unavailable for pi'),
    ),
  ).toHaveLength(1)
  f.options.readMode = async () => 'local'
  expect((await f.start()).outcome).toBe('moved')
  const service = await openSettingsService({ file: f.paths.target })
  cleanup.push(() => service?.dispose())
  expect(service!.resolve('pi').killswitch_enabled).toBe(true)
  expect(service!.resolve('opencode').dump_enabled).toBe(true)
})

for (const local of ['absent', 'present'] as const) {
  test(`a peer enrolled in the vault with unseeded settings and ${local === 'absent' ? 'no local store does not block the move' : 'a local store keeps the start in legacy'}`, async () => {
    const f = await fixture()
    await put(f.stores.opencode.config, { dump: { enabled: true } })
    if (local === 'present')
      await put(f.stores.pi.config, { killswitch: { enabled: true } })
    f.options.readMode = async (host) => (host === 'pi' ? 'claustrum' : 'local')
    const started = await f.start()
    if (local === 'absent') {
      expect(started).toMatchObject({ mode: 'user-file', outcome: 'moved' })
      expect(await absent(f.paths.marker)).toBe(false)
    } else {
      expect(started).toMatchObject({
        mode: 'legacy',
        outcome: 'source-unavailable',
      })
      expect(await absent(f.paths.target)).toBe(true)
    }
  })
}

test('a peer with no store is still skipped when its custody is unreadable', async () => {
  const f = await fixture()
  await put(f.stores.opencode.config, { dump: { enabled: true } })
  f.options.readMode = async (host) => {
    if (host === 'pi') throw new Error('peer custody unreadable')
    return 'local'
  }
  expect((await f.start()).outcome).toBe('moved')
  expect(await absent(f.paths.marker)).toBe(false)
})

for (const sources of ['none', 'other-target-note'] as const) {
  test(`marker prevents re-move after deletion with ${sources} and no matching source note`, async () => {
    const f = await fixture()
    const note = `${f.stores.opencode.config}.MOVED_READPLEASE`
    if (sources === 'other-target-note') {
      await put(f.stores.opencode.config, { dump: { enabled: true } })
      await fs.writeFile(
        note,
        `Already moved into ${join(f.root, 'another.jsonc')}`,
      )
    }
    expect((await f.start()).outcome).toBe('moved')
    await fs.unlink(f.paths.target)
    await put(f.stores.opencode.config, { dump: { enabled: true } })
    f.options.readMode = async () => 'local'
    f.reads.length = 0
    expect((await f.start()).outcome).toBe('marker-present')
    expect(await absent(f.paths.target)).toBe(true)
    expect(f.reads.every((path) => path === f.paths.target)).toBe(true)
    expect(
      f.touched.some(
        (path) => path.endsWith('MOVED_READPLEASE') && path !== note,
      ),
    ).toBe(false)
    if (sources === 'other-target-note')
      expect(await fs.readFile(note, 'utf8')).toBe(
        `Already moved into ${join(f.root, 'another.jsonc')}`,
      )
  })
}
