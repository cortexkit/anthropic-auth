import { afterEach, expect, test } from 'bun:test'
import type { MakeDirectoryOptions } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { lockPathFor, withLock } from '@cortexkit/common-auth/fs'
import {
  type MoveSource,
  moveSettingsOnce,
} from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'

import { readNativeEnrollmentMode } from '../native-enrollment-authority.ts'
import { nativeQuotaCodec } from '../native-quota-codec.ts'
import { nativeVaultPaths } from '../native-vault-paths.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from '../pool-store.ts'
import { settingsDefinition } from '../settings-definition.ts'
import {
  resolveSettingsMode,
  writeSettingsMoveMarker,
} from '../settings-mode.ts'
import { mapSettingsMoveSources } from '../settings-move-map.ts'
import {
  prepareSettingsMoveSources,
  readPeerLegacySettingsProtection,
  type SettingsMoveSourcesOptions,
} from '../settings-move-sources.ts'
import {
  getDefaultSettingsStorePaths,
  resolveSettingsPaths,
  type SettingsHost,
} from '../settings-paths.ts'
import {
  LEGACY_STATE_LAYOUT,
  processStateLayout,
  readStateLayoutMarker,
  resolveStateHomeTarget,
} from '../state-layout-paths.ts'

// The public mover and the test must share its filesystem object, not a copy
// of node:fs that misses reads captured when common-auth was first imported.
const { setSettingsFsForTest } = await import(
  new URL('fs.js', import.meta.resolve('@cortexkit/common-auth/settings')).href
)

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  setSettingsFsForTest()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function put(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(value))
}

async function absent(path: string) {
  return fs.lstat(path).then(
    () => false,
    (error) => {
      if (error.code === 'ENOENT') return true
      throw error
    },
  )
}

async function fixture(host: SettingsHost = 'opencode') {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'settings-sources-')),
  )
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
  const reads: string[] = []
  const touched: string[] = []
  const messages: string[] = []
  const modes: Record<SettingsHost, 'local' | 'claustrum'> = {
    opencode: 'local',
    pi: 'local',
  }
  const modeReads: SettingsHost[] = []
  let seeds = 0
  const record = (path: string) => {
    expect(path === root || path.startsWith(`${root}/`)).toBe(true)
    touched.push(path)
  }
  const options: SettingsMoveSourcesOptions = {
    host,
    home: root,
    platform: 'linux',
    env: { HOME: root, XDG_STATE_HOME: join(root, 'state') },
    realpath: async (path) => {
      record(path)
      return fs.realpath(path)
    },
    initializeVaultSettings: async () => {
      seeds++
    },
    readMode: async (acting) => {
      modeReads.push(acting)
      return modes[acting]
    },
    log: { warn: (message) => messages.push(message) },
  }
  const defaults = {
    opencode: await resolveNativePoolPaths(
      getDefaultSettingsStorePaths('opencode', options).account,
      getDefaultSettingsStorePaths('opencode', options).state,
      LEGACY_STATE_LAYOUT,
    ),
    pi: await resolveNativePoolPaths(
      getDefaultSettingsStorePaths('pi', options).account,
      getDefaultSettingsStorePaths('pi', options).state,
      LEGACY_STATE_LAYOUT,
    ),
  }
  const vaults = {
    opencode: nativeVaultPaths(defaults.opencode),
    pi: nativeVaultPaths(defaults.pi),
  }
  setSettingsFsForTest({
    async readFile(path: string, encoding: 'utf8') {
      record(path)
      reads.push(path)
      return fs.readFile(path, encoding)
    },
    async lstat(path: string) {
      record(path)
      return fs.lstat(path)
    },
    async open(path: string, ...args: [string, number?]) {
      record(path)
      return fs.open(path, ...args)
    },
    async link(from: string, to: string) {
      record(from)
      record(to)
      return fs.link(from, to)
    },
    async unlink(path: string) {
      record(path)
      return fs.unlink(path)
    },
    async mkdir(path: string, options: MakeDirectoryOptions) {
      record(path)
      return fs.mkdir(path, options)
    },
    async readdir(path: string) {
      record(path)
      return fs.readdir(path)
    },
  })
  async function move(adjust?: (sources: MoveSource[]) => void) {
    const paths = await resolveSettingsPaths(host, options)
    const prepared = await prepareSettingsMoveSources({ ...options, paths })
    if (prepared.status !== 'ready') {
      if (prepared.status === 'unavailable')
        messages.push(`Settings move unavailable: ${prepared.reason}`)
      return { paths, prepared, result: undefined, document: undefined }
    }
    adjust?.(prepared.sources)
    const result = await moveSettingsOnce({
      definition: settingsDefinition,
      target: paths.target,
      separateInstall: paths.separate,
      sources: prepared.sources,
      map: mapSettingsMoveSources,
      fence: () => true,
      log: { info: () => {}, warn: (message) => messages.push(message) },
    })
    if (result.outcome === 'moved')
      await writeSettingsMoveMarker(paths.target, options)
    else if (result.outcome === 'busy' || result.outcome === 'failed')
      messages.push(`Settings move ${result.outcome}`)
    return {
      paths,
      prepared,
      result,
      document:
        result.outcome === 'moved'
          ? parse(await fs.readFile(paths.target, 'utf8'))
          : undefined,
    }
  }
  return {
    root,
    options,
    defaults,
    vaults,
    reads,
    touched,
    messages,
    modes,
    modeReads,
    seeds: () => seeds,
    move,
  }
}

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} private XDG moves only its own resolved store`, async () => {
    const f = await fixture(host)
    f.options.env = {
      ...f.options.env,
      XDG_CONFIG_HOME: join(f.root, 'private'),
    }
    const paths = await resolveSettingsPaths(host, f.options)
    const own = await resolveNativePoolPaths(
      paths.own.account,
      paths.own.state,
      LEGACY_STATE_LAYOUT,
    )
    const peer = host === 'opencode' ? 'pi' : 'opencode'
    const peerStore = await resolveNativePoolPaths(
      paths.defaults[peer].account,
      paths.defaults[peer].state,
      LEGACY_STATE_LAYOUT,
    )
    await put(peerStore.config, { dump: { enabled: false } })
    await put(peerStore.legacyConfig, { dump: { enabled: false } })
    await put(nativeVaultPaths(peerStore).config, { dump: { enabled: false } })
    await put(own.config, { dump: { enabled: true } })
    const moved = await f.move()
    expect(moved.paths.sourceRule).toBe('own')
    expect(moved.document).toEqual({ schema_version: 1, dump_enabled: true })
    expect(f.reads).toEqual([own.config])
    expect(f.modeReads).toEqual([host])
    expect(await absent(`${peerStore.config}.MOVED_READPLEASE`)).toBe(true)
    expect(
      f.touched.some((path) => path.startsWith(dirname(peerStore.config))),
    ).toBe(false)
  })

  for (const xdg of ['relative', 'alias'] as const) {
    test(`${host} ${xdg} XDG keeps both default-location sources`, async () => {
      const f = await fixture(host)
      await fs.mkdir(join(f.root, '.config'), { recursive: true })
      if (xdg === 'alias')
        await fs.symlink(join(f.root, '.config'), join(f.root, 'alias'), 'dir')
      f.options.env = {
        ...f.options.env,
        XDG_CONFIG_HOME:
          xdg === 'relative' ? 'relative-config' : join(f.root, 'alias'),
      }
      await put(f.defaults.opencode.config, { dump: { enabled: true } })
      await put(f.defaults.pi.config, { prime: { enabled: false } })
      const moved = await f.move()
      expect(moved.paths.sourceRule).toBe('default')
      expect(moved.document).toEqual({
        schema_version: 1,
        dump_enabled: true,
        prime_enabled: false,
      })
      expect(f.reads).toEqual([
        f.defaults.opencode.config,
        f.defaults.pi.config,
      ])
    })
  }

  test(`${host} moves only each host's current custody store, not stale inactive files or local rows`, async () => {
    const f = await fixture(host)
    const peer = host === 'opencode' ? 'pi' : 'opencode'
    f.modes[peer] = 'claustrum'
    await put(f.defaults[host].config, { dump: { enabled: true } })
    await put(f.vaults[host].config, {
      dump: { enabled: false },
      prime: { enabled: true },
    })
    await put(f.vaults[peer].config, { prime: { enabled: false } })
    await put(f.defaults[peer].config, {
      dump: { enabled: false },
      prime: { enabled: true },
    })
    await put(f.defaults[peer].legacyConfig, {
      accounts: [{ id: 'must-not-read-local-row' }],
    })
    const moved = await f.move()
    expect(moved.document).toEqual({
      schema_version: 1,
      dump_enabled: true,
      prime_enabled: false,
    })
    expect(f.reads).toEqual(
      host === 'opencode'
        ? [f.defaults[host].config, f.vaults[peer].config]
        : [f.vaults[peer].config, f.defaults[host].config],
    )
    expect(f.seeds()).toBe(0)
    expect(await absent(`${f.defaults[peer].config}.MOVED_READPLEASE`)).toBe(
      true,
    )
    expect(await absent(`${f.vaults[host].config}.MOVED_READPLEASE`)).toBe(true)
  })
}

test('the own vault source is read only after active-store first-read seeding finishes', async () => {
  const f = await fixture('pi')
  f.modes.pi = 'claustrum'
  await put(f.defaults.pi.legacyConfig, {
    version: 1,
    accounts: [],
    dump: { enabled: true },
  })
  const store = createNativePoolStore({
    paths: f.vaults.pi,
    quota: nativeQuotaCodec,
  })
  cleanup.push(() => store.close())
  let seeded = false
  f.options.initializeVaultSettings = async () => {
    expect(f.reads).not.toContain(f.vaults.pi.config)
    const result = await store.updateSettings((draft) => draft)
    expect(['updated', 'unchanged']).toContain(result.outcome)
    seeded = true
  }
  const moved = await f.move()
  expect(seeded).toBe(true)
  expect(moved.document).toEqual({ schema_version: 1, dump_enabled: true })
  expect(f.reads).toContain(f.vaults.pi.config)
  expect(f.reads).not.toContain(f.defaults.pi.legacyConfig)
})

test('hosted custody is treated as vault mode by the authority reader', async () => {
  const f = await fixture('opencode')
  f.options.readMode = (host, env) =>
    readNativeEnrollmentMode(host, env, {
      enrollmentAuthority: async () => 'host',
      readClaustrumEnrollmentStatus: async () => {
        throw new Error('hosted mode must not read enrollment status')
      },
    })
  await put(f.vaults.opencode.config, { dump: { enabled: true } })
  await put(f.vaults.pi.config, { prime: { enabled: false } })
  await put(f.defaults.opencode.config, { dump: { enabled: false } })
  await put(f.defaults.pi.config, { prime: { enabled: true } })
  const moved = await f.move()
  expect(moved.document).toEqual({
    schema_version: 1,
    dump_enabled: true,
    prime_enabled: false,
  })
  expect(f.reads).toEqual([f.vaults.opencode.config, f.vaults.pi.config])
  expect(f.seeds()).toBe(1)
})

for (const failure of ['mode', 'seed'] as const) {
  test(`own ${failure} failure returns no sources, leaving the start in legacy with no marker`, async () => {
    const f = await fixture()
    await put(f.defaults.opencode.config, { dump: { enabled: true } })
    if (failure === 'mode')
      f.options.readMode = async () => {
        throw new Error('unreadable authority')
      }
    else {
      f.modes.opencode = 'claustrum'
      f.options.initializeVaultSettings = async () => {
        throw new Error('failed seed')
      }
    }
    const moved = await f.move()
    expect(moved.prepared.status).toBe('unavailable')
    expect(moved.prepared.sources).toEqual([])
    expect(moved.result).toBeUndefined()
    expect(f.reads).toEqual([])
    expect(f.messages).toHaveLength(1)
    expect(await absent(moved.paths.target)).toBe(true)
    expect(await absent(moved.paths.marker)).toBe(true)
    expect(await resolveSettingsMode(moved.paths, f.options)).toBe('legacy')
    expect(
      JSON.parse(await fs.readFile(f.defaults.opencode.config, 'utf8')).dump
        .enabled,
    ).toBe(true)
  })
}

for (const failure of ['mode', 'unseeded'] as const) {
  test(`peer ${failure} is skipped and named once without vault initialization`, async () => {
    const f = await fixture()
    await put(f.defaults.opencode.config, { dump: { enabled: true } })
    await put(f.defaults.pi.config, { dump: { enabled: false } })
    f.options.readMode = async (host) => {
      if (host === 'opencode') return 'local'
      if (failure === 'mode') throw new Error('unreadable peer authority')
      return 'claustrum'
    }
    await prepareSettingsMoveSources(f.options)
    const moved = await f.move()
    expect(moved.document).toEqual({ schema_version: 1, dump_enabled: true })
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0]).toContain('pi source')
    expect(f.reads).toEqual([f.defaults.opencode.config])
    expect(f.seeds()).toBe(0)
    expect(await absent(f.vaults.pi.config)).toBe(true)
    expect(await absent(`${f.defaults.pi.config}.MOVED_READPLEASE`)).toBe(true)
  })
}

for (const mode of ['local', 'claustrum'] as const) {
  for (const cleanupState of ['done', 'pending', 'conflict'] as const) {
    test(`Pi observes OpenCode's relocated ${mode} state lock with cleanup ${cleanupState} without deciding a layout or registering`, async () => {
      const f = await fixture('pi')
      await put(f.defaults.opencode.config, { dump: { enabled: true } })
      await put(f.vaults.opencode.config, { dump: { enabled: true } })
      await put(f.defaults.pi.config, { prime: { enabled: false } })
      f.modes.opencode = mode
      const target = resolveStateHomeTarget({
        env: f.options.env,
        home: f.root,
      })
      if (!target) throw new Error('Expected sandbox OpenCode config identity')
      const markerPath = join(target.dir, 'layout.json')
      await put(markerPath, {
        version: 1,
        phase: 'committed',
        attempt: 'move',
        identity: target.identity,
        stateRoot: target.stateRoot,
        sub: target.dir,
        oldDir: dirname(f.defaults.opencode.config),
        storageIds: {
          local: f.defaults.opencode.storageId,
          vault: f.vaults.opencode.storageId,
        },
        cleanup: cleanupState,
      })
      const before = await fs.readFile(markerPath, 'utf8')
      const pool = await resolveNativePoolPaths(
        f.defaults.opencode.legacyConfig,
        f.defaults.opencode.legacyState,
        { kind: 'state-home', dir: target.dir },
      )
      const expected = mode === 'local' ? pool : nativeVaultPaths(pool)
      const moved = await f.move()
      expect(moved.result?.outcome).toBe('moved')
      expect(moved.prepared.sources[0]?.locks).toEqual([
        ...nativePoolStoreLocks(expected),
      ])
      expect(moved.prepared.sources[0]?.path).toBe(expected.config)
      expect(processStateLayout(f.defaults.opencode.legacyConfig)).toEqual(
        LEGACY_STATE_LAYOUT,
      )
      expect(await readStateLayoutMarker(target.dir)).toMatchObject({
        phase: 'committed',
        cleanup: cleanupState,
      })
      expect(await fs.readFile(markerPath, 'utf8')).toBe(before)
      expect(
        await absent(join(target.dir, 'anthropic-auth-holders.json')),
      ).toBe(true)
      expect(
        await absent(
          join(dirname(expected.config), 'anthropic-auth-holders.json'),
        ),
      ).toBe(true)
    })
  }
}

for (const marker of ['preparing', 'unreadable'] as const) {
  test(`a peer with a ${marker} layout marker is skipped read-only and named once`, async () => {
    const f = await fixture('pi')
    await put(f.defaults.opencode.config, { dump: { enabled: true } })
    await put(f.defaults.pi.config, { prime: { enabled: false } })
    const target = resolveStateHomeTarget({ env: f.options.env, home: f.root })
    if (!target) throw new Error('Expected sandbox OpenCode config identity')
    const markerPath = join(target.dir, 'layout.json')
    await put(
      markerPath,
      marker === 'unreadable'
        ? {}
        : {
            version: 1,
            phase: 'preparing',
            attempt: 'unfinished',
            identity: target.identity,
            stateRoot: target.stateRoot,
            sub: target.dir,
            oldDir: dirname(f.defaults.opencode.config),
            storageIds: {
              local: f.defaults.opencode.storageId,
              vault: f.vaults.opencode.storageId,
            },
          },
    )
    const before = await fs.readFile(markerPath, 'utf8')
    await prepareSettingsMoveSources(f.options)
    const moved = await f.move()
    expect(moved.result?.outcome).toBe('moved')
    expect(moved.document).toEqual({ schema_version: 1, prime_enabled: false })
    expect(f.reads).toEqual([f.defaults.pi.config])
    expect(f.messages).toHaveLength(1)
    expect(f.messages[0]).toContain('opencode source')
    expect(await fs.readFile(markerPath, 'utf8')).toBe(before)
    expect(await absent(`${f.defaults.opencode.config}.MOVED_READPLEASE`)).toBe(
      true,
    )
  })
}

test('own resolved layout is retained and lock specs are exactly the writers specifications in OpenCode-first order', async () => {
  const f = await fixture('opencode')
  f.modes.opencode = 'claustrum'
  f.options.ownPoolPaths = await resolveNativePoolPaths(
    f.defaults.opencode.legacyConfig,
    f.defaults.opencode.legacyState,
    { kind: 'state-home', dir: join(f.root, 'own-state') },
  )
  const own = nativeVaultPaths(f.options.ownPoolPaths)
  await put(own.config, { dump: { enabled: true } })
  await put(f.defaults.pi.config, { prime: { enabled: false } })
  await fs.mkdir(dirname(own.state), { recursive: true })
  const prepared = await prepareSettingsMoveSources(f.options)
  expect(prepared.status).toBe('ready')
  expect(prepared.sources.map((source) => source.host)).toEqual([
    'opencode',
    'pi',
  ])
  expect(prepared.sources.map((source) => source.locks)).toEqual([
    [...nativePoolStoreLocks(own)],
    [...nativePoolStoreLocks(f.defaults.pi)],
  ])
  const specs = prepared.sources.flatMap((source) => source.locks)
  expect(specs.map((spec) => spec.name)).toEqual([
    'pool-config',
    'pool-state',
    'pool-config',
    'pool-state',
  ])
  const assertHeld = async () => {
    for (const spec of specs)
      expect(await absent(lockPathFor(spec.path, spec.name))).toBe(false)
  }
  let lockedReads = 0
  let published = false
  setSettingsFsForTest({
    async readFile(path: string, encoding: 'utf8') {
      f.reads.push(path)
      await assertHeld()
      lockedReads++
      return fs.readFile(path, encoding)
    },
    async link(from: string, to: string) {
      await assertHeld()
      expect(lockedReads).toBe(2)
      await fs.link(from, to)
      published = true
    },
  })
  const moved = await f.move()
  expect(moved.result?.outcome).toBe('moved')
  expect(published).toBe(true)
  for (const spec of specs)
    expect(await absent(lockPathFor(spec.path, spec.name))).toBe(true)
})

test('a source lock timeout publishes nothing and leaves legacy values readable', async () => {
  const f = await fixture()
  await put(f.defaults.opencode.config, { dump: { enabled: true } })
  await put(f.defaults.pi.config, {})
  const lock = nativePoolStoreLocks(f.defaults.opencode)[1]
  await withLock(
    lock.path,
    { name: lock.name, ttlMs: 10_000, timeoutMs: 100 },
    async () => {
      const moved = await f.move((sources) => {
        for (const source of sources)
          source.locks = source.locks.map((spec) => ({
            ...spec,
            timeoutMs: 30,
          }))
      })
      expect(moved.result?.outcome).toBe('busy')
      expect(f.reads).toEqual([])
      expect(f.messages).toHaveLength(1)
      expect(await absent(moved.paths.target)).toBe(true)
      expect(await absent(moved.paths.marker)).toBe(true)
      expect(await resolveSettingsMode(moved.paths, f.options)).toBe('legacy')
    },
  )
  const store = createNativePoolStore({
    paths: f.defaults.opencode,
    quota: nativeQuotaCodec,
  })
  cleanup.push(() => store.close())
  const read = await store.readSettings()
  expect(read.status).toBe('ready')
  if (read.status === 'ready')
    expect(read.settings.dump).toEqual({ enabled: true })
})

test('a default-location peer source is not treated as a separate install by its override variables', async () => {
  const f = await fixture()
  f.options.env = {
    ...f.options.env,
    PI_ANTHROPIC_AUTH_FILE: join(f.root, 'other-install', 'auth.json'),
    PI_AGENT_DIR: join(f.root, 'other-install'),
  }
  await put(f.defaults.opencode.config, { dump: { enabled: true } })
  await put(f.defaults.pi.config, { prime: { enabled: false } })
  const moved = await f.move()
  expect(moved.result?.outcome).toBe('moved')
  expect(f.reads).toEqual([f.defaults.opencode.config, f.defaults.pi.config])
  expect(moved.document).toEqual({
    schema_version: 1,
    dump_enabled: true,
    prime_enabled: false,
  })
})

test('a separate install prepares nothing and never probes custody or seeds a vault', async () => {
  const f = await fixture()
  f.options.env = {
    ...f.options.env,
    OPENCODE_CONFIG_DIR: join(f.root, 'separate'),
  }
  const moved = await f.move()
  expect(moved.prepared).toEqual({ status: 'separate', sources: [] })
  expect(f.modeReads).toEqual([])
  expect(f.reads).toEqual([])
  expect(f.seeds()).toBe(0)
  expect(await absent(moved.paths.target)).toBe(true)
  expect(await absent(moved.paths.marker)).toBe(true)
})

for (const host of ['opencode', 'pi'] as const) {
  test(`${host} default target reads both default stores through common-auth without touching account files`, async () => {
    const f = await fixture(host)
    await put(f.defaults.opencode.config, { dump: { enabled: true } })
    await put(f.defaults.pi.config, {
      dump: { enabled: false },
      prime: { enabled: false },
    })
    await put(f.defaults.opencode.legacyConfig, { dump: { enabled: false } })
    await put(f.defaults.pi.legacyConfig, { prime: { enabled: true } })
    const before = await Promise.all(
      [f.defaults.opencode.config, f.defaults.pi.config].map((path) =>
        fs.readFile(path, 'utf8'),
      ),
    )
    const moved = await f.move()
    expect(moved.result?.outcome).toBe('moved')
    expect(moved.document).toEqual({
      schema_version: 1,
      dump_enabled: { default: true, pi: false },
      prime_enabled: false,
    })
    expect(f.reads).toEqual([f.defaults.opencode.config, f.defaults.pi.config])
    expect(f.seeds()).toBe(0)
    for (const [index, path] of [
      f.defaults.opencode.config,
      f.defaults.pi.config,
    ].entries()) {
      expect(before[index]).toBe(await fs.readFile(path, 'utf8'))
      expect(await fs.readFile(`${path}.MOVED_READPLEASE`, 'utf8')).toContain(
        moved.paths.target,
      )
    }
    expect(await resolveSettingsMode(moved.paths, f.options)).toBe('user-file')
  })

  test(`${host} explicit target uses overridden own store and never reads or notes the peer`, async () => {
    const f = await fixture(host)
    const custom = join(f.root, 'custom', 'auth.json')
    f.options.env = {
      ...f.options.env,
      ANTHROPIC_AUTH_SETTINGS_FILE: join(f.root, 'settings.jsonc'),
      [host === 'opencode'
        ? 'OPENCODE_ANTHROPIC_AUTH_FILE'
        : 'PI_ANTHROPIC_AUTH_FILE']: custom,
    }
    const resolved = await resolveSettingsPaths(host, f.options)
    const own = await resolveNativePoolPaths(
      resolved.own.account,
      resolved.own.state,
      LEGACY_STATE_LAYOUT,
    )
    for (const paths of Object.values(f.defaults)) {
      await put(paths.config, { dump: { enabled: false } })
      await put(paths.legacyConfig, { dump: { enabled: false } })
      await put(nativeVaultPaths(paths).config, { dump: { enabled: false } })
    }
    await put(own.config, { dump: { enabled: true } })
    const moved = await f.move()
    expect(moved.result?.outcome).toBe('moved')
    expect(moved.document).toEqual({ schema_version: 1, dump_enabled: true })
    expect(f.reads).toEqual([own.config])
    expect(f.modeReads).toEqual([host])
    const peer = host === 'opencode' ? 'pi' : 'opencode'
    expect(await fs.readdir(dirname(f.defaults[peer].config))).not.toContain(
      'anthropic-auth-pool.json.MOVED_READPLEASE',
    )
    expect(
      f.touched.some((path) =>
        path.startsWith(dirname(f.defaults[peer].config)),
      ),
    ).toBe(false)
    expect(await absent(`${f.defaults[host].config}.MOVED_READPLEASE`)).toBe(
      true,
    )
  })
}

test('the peer legacy reader follows the peer custody and never seeds a vault', async () => {
  const f = await fixture('opencode')
  const read = () =>
    readPeerLegacySettingsProtection({
      ...f.options,
      host: 'pi',
      readMode: f.options.readMode,
    })
  // A local store that doesn't exist reads as an empty legacy store.
  expect((await read())?.killswitch_enabled).toBe(false)
  await put(f.defaults.pi.config, {
    killswitch: { enabled: true, main: { '5h': 45 } },
  })
  expect(await read()).toMatchObject({
    killswitch_enabled: true,
    killswitch_default_five_hour: 45,
  })
  // In vault custody the local store no longer counts, and unseeded vault
  // settings are unknown rather than empty.
  f.modes.pi = 'claustrum'
  expect(await read()).toBeUndefined()
  expect(f.seeds()).toBe(0)
  await put(f.vaults.pi.config, { killswitch: { enabled: true } })
  expect(await read()).toMatchObject({ killswitch_enabled: true })
})
