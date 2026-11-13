import { expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  HOLDER_FILE_NAME,
  type HolderEntry,
  type HolderLiveness,
} from '../holder-registry.ts'
import {
  checkSettingsMoveFence,
  SETTINGS_MOVE_FIRST_RELEASE,
  type SettingsMoveFenceOptions,
  settingsMoveHolderFiles,
} from '../settings-move-fence.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const FLOOR = '2.12.0'
const NOW = Date.UTC(2026, 0, 2, 12)
const self = { pid: 100, incarnation: 'self-start' }
const liveness: HolderLiveness = {
  pidAlive: (pid) => pid !== 999,
  incarnation: async (pid) =>
    pid === self.pid ? self.incarnation : 'peer-start',
  now: () => NOW,
  uptime: () => 3_600,
}

function holder(overrides: Partial<HolderEntry> = {}): HolderEntry {
  return {
    pid: 200,
    incarnation: 'peer-start',
    instance: 'peer-copy',
    role: 'opencode1',
    release: FLOOR,
    kind: 'legacy',
    identity: null,
    files: ['/unrelated/store.json'],
    registeredAt: NOW,
    ...overrides,
  }
}

async function fixture(): Promise<SettingsMoveFenceOptions & { home: string }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'settings-fence-')))
  deferCleanup(() => rm(home, { recursive: true, force: true }))
  return {
    home,
    env: {},
    stores: [],
    registration: { status: 'registered' },
    floor: FLOOR,
    self,
    liveness,
    artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
  }
}

test('the settings move first ships in 2.12.0', () => {
  expect(SETTINGS_MOVE_FIRST_RELEASE).toBe('2.12.0')
})

for (const role of ['opencode1', 'opencode2', 'pi'] as const) {
  test(`a live ${role} release is compared by SemVer precedence, not store overlap`, async () => {
    const options = await fixture()
    const releases = [
      ['2.11.2', false],
      ['2.12.0-rc.1', false],
      ['2.12.0-rc.999+build', false],
      ['2.12.0', true],
      ['2.12.0+build', true],
      ['2.12.1-alpha', true],
      ['2.100.0', true],
      ['10.0.0', true],
      ['unknown', false],
      ['not-a-release', false],
      ['2.12', false],
      ['2.012.0', false],
      ['2.12.0-01', false],
      ['2.12.0\n', false],
    ] as const
    for (const [release, open] of releases) {
      const result = await checkSettingsMoveFence({
        ...options,
        readHolders: async () => ({ entries: [holder({ role, release })] }),
      })
      expect(result.open, `${role} ${release}`).toBe(open)
      expect(
        result.blockers.every((blocker) => blocker.kind === 'settings-holder'),
      ).toBe(true)
    }
  })
}

test('an injected prerelease floor compares numeric and lexical prerelease identifiers', async () => {
  const options = await fixture()
  for (const [release, open] of [
    ['3.0.0-beta.2', false],
    ['3.0.0-beta.10', true],
    ['3.0.0-beta.10.a', true],
    ['3.0.0-beta', false],
    ['3.0.0-1', false],
    ['3.0.0-rc', true],
    ['3.0.0', true],
  ] as const) {
    expect(
      (
        await checkSettingsMoveFence({
          ...options,
          floor: '3.0.0-beta.10',
          readHolders: async () => ({ entries: [holder({ release })] }),
        })
      ).open,
      release,
    ).toBe(open)
  }
})

test('only this code copy is excluded; another copy in the same process is judged by its release', async () => {
  const options = await fixture()
  for (const [release, open] of [
    ['2.11.2', false],
    ['unknown', false],
    [FLOOR, true],
  ] as const) {
    expect(
      (
        await checkSettingsMoveFence({
          ...options,
          readHolders: async () => ({
            entries: [holder({ ...self, release, instance: 'other-copy' })],
          }),
        })
      ).open,
      release,
    ).toBe(open)
  }
  // This copy's own entry never closes the fence, whatever it records.
  expect(
    (
      await checkSettingsMoveFence({
        ...options,
        self: { ...self, instance: 'own-copy' },
        readHolders: async () => ({
          entries: [
            holder({ ...self, release: 'unknown', instance: 'own-copy' }),
          ],
        }),
      })
    ).open,
  ).toBe(true)
  const result = await checkSettingsMoveFence({
    ...options,
    // The peer has the same recorded start but another pid; it is not self.
    liveness: { ...liveness, incarnation: async () => self.incarnation },
    readHolders: async () => ({
      entries: [holder({ incarnation: self.incarnation, release: '2.11.2' })],
    }),
  })
  expect(result.open).toBe(false)
  expect(
    (
      await checkSettingsMoveFence({
        ...options,
        liveness: { ...liveness, incarnation: async () => null },
        readHolders: async () => ({
          entries: [
            holder({
              pid: self.pid,
              incarnation: 'other-start',
              release: '2.11.2',
            }),
          ],
        }),
      })
    ).open,
  ).toBe(false)
})

test('dead, reused and pre-boot peers do not close the fence', async () => {
  const options = await fixture()
  expect(
    (
      await checkSettingsMoveFence({
        ...options,
        readHolders: async () => ({
          entries: [
            holder({ pid: 999, release: 'unknown' }),
            holder({ incarnation: 'previous-start', release: '2.11.2' }),
            holder({
              incarnation: null,
              registeredAt: NOW - 7_200_000,
              release: '2.11.2',
            }),
            holder({
              pid: self.pid,
              incarnation: 'previous-self-start',
              release: '2.11.2',
            }),
          ],
        }),
      })
    ).open,
  ).toBe(true)
})

test('unreadable holder entries and holder files close the fence', async () => {
  const options = await fixture()
  for (const entry of [null, {}, { pid: 200 }]) {
    const result = await checkSettingsMoveFence({
      ...options,
      readHolders: async () => ({ entries: [entry] }),
    })
    expect(result.open).toBe(false)
    expect(result.blockers[0]).toMatchObject({
      kind: 'settings-holder',
      reason: 'unreadable',
    })
  }
  const files = await settingsMoveHolderFiles(options)
  const file = files[0]!
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '{broken json')
  expect((await checkSettingsMoveFence(options)).blockers).toEqual([
    expect.objectContaining({ kind: 'holder-file', holderFile: files[0] }),
  ])
  const unreadable = await checkSettingsMoveFence({
    ...options,
    readHolders: async () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    },
  })
  expect(unreadable.open).toBe(false)
  expect(unreadable.blockers[0]).toMatchObject({
    kind: 'holder-file',
    reason: 'EACCES',
  })
})

test('a dead entry missing role does not close the fence', async () => {
  const options = await fixture()
  const entry: Record<string, unknown> = { ...holder({ pid: 999 }) }
  delete entry.role
  expect(
    (
      await checkSettingsMoveFence({
        ...options,
        readHolders: async () => ({ entries: [entry] }),
      })
    ).open,
  ).toBe(true)
})

test('a live entry with an unknown role at the floor does not close the fence', async () => {
  const options = await fixture()
  expect(
    (
      await checkSettingsMoveFence({
        ...options,
        readHolders: async () => ({
          entries: [
            { ...holder(), role: 'future-host', kind: 'future-layout' },
          ],
        }),
      })
    ).open,
  ).toBe(true)
})

test('a live entry with no release closes the fence for its release', async () => {
  const options = await fixture()
  for (const release of [undefined, null, 123]) {
    const entry: Record<string, unknown> = { ...holder(), release }
    if (release === undefined) delete entry.release
    const result = await checkSettingsMoveFence({
      ...options,
      readHolders: async () => ({ entries: [entry] }),
    })
    expect(result.open).toBe(false)
    expect(result.blockers[0]).toMatchObject({
      kind: 'settings-holder',
      reason: 'release',
      release: null,
    })
  }
})

test('all standard registries and every source store sibling are checked', async () => {
  const options = await fixture()
  const files = await settingsMoveHolderFiles({
    ...options,
    stores: [
      join(options.home, 'overridden', 'store.json'),
      join(options.home, 'elsewhere', 'vault.json'),
    ],
  })
  expect(files).toEqual(
    [
      join(options.home, '.config', 'opencode', HOLDER_FILE_NAME),
      join(
        options.home,
        '.local',
        'state',
        'cortexkit',
        'anthropic-auth',
        'opencode',
        HOLDER_FILE_NAME,
      ),
      join(options.home, '.pi', 'agent', HOLDER_FILE_NAME),
      join(options.home, 'elsewhere', HOLDER_FILE_NAME),
      join(options.home, 'overridden', HOLDER_FILE_NAME),
    ].sort(),
  )
  for (const file of files) {
    const seen: string[] = []
    const result = await checkSettingsMoveFence({
      ...options,
      stores: [
        join(options.home, 'overridden', 'store.json'),
        join(options.home, 'elsewhere', 'vault.json'),
      ],
      readHolders: async (path) => {
        seen.push(path)
        return path === file
          ? { entries: [holder({ release: '2.11.2', role: 'pi' })] }
          : undefined
      },
    })
    expect(result.open, file).toBe(false)
    expect(seen).toEqual(files)
  }
})

for (const target of ['named', 'private-xdg'] as const) {
  for (const host of ['opencode', 'pi'] as const) {
    test(`${host} on a ${target} target is blocked by the other host or an overridden store's holder`, async () => {
      const options = await fixture()
      const configDir = join(options.home, 'config', 'opencode')
      const piDir = join(options.home, 'pi-agent')
      const source = join(options.home, 'custom-store', 'settings.json')
      const env = {
        XDG_CONFIG_HOME: dirname(configDir),
        XDG_STATE_HOME: join(options.home, 'state'),
        PI_AGENT_DIR: piDir,
        ...(target === 'named'
          ? { ANTHROPIC_AUTH_SETTINGS_FILE: join(options.home, 'named.jsonc') }
          : {}),
      }
      const stateName = `opencode-${createHash('sha256').update(configDir).digest('hex').slice(0, 16)}`
      const expected = [
        join(configDir, HOLDER_FILE_NAME),
        join(
          options.home,
          'state',
          'cortexkit',
          'anthropic-auth',
          stateName,
          HOLDER_FILE_NAME,
        ),
        join(piDir, HOLDER_FILE_NAME),
        join(dirname(source), HOLDER_FILE_NAME),
      ].sort()
      expect(
        await settingsMoveHolderFiles({ ...options, env, stores: [source] }),
      ).toEqual(expected)
      for (const file of [
        join(host === 'opencode' ? piDir : configDir, HOLDER_FILE_NAME),
        join(dirname(source), HOLDER_FILE_NAME),
      ]) {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(
          file,
          JSON.stringify({
            version: 1,
            entries: [
              holder({
                role: host === 'opencode' ? 'pi' : 'opencode2',
                release: '2.11.2',
              }),
            ],
          }),
        )
        const result = await checkSettingsMoveFence({
          ...options,
          env,
          stores: [source],
        })
        expect(result.open).toBe(false)
        expect(result.blockers).toEqual([
          expect.objectContaining({
            kind: 'settings-holder',
            holderFile: file,
          }),
        ])
        await rm(file)
      }
    })
  }
}

test('config and Pi folder overrides and configured HOME determine registry locations', async () => {
  const options = await fixture()
  const env = {
    HOME: join(options.home, 'process-home'),
    OPENCODE_CONFIG_DIR: join(options.home, 'opencode-custom'),
    PI_CODING_AGENT_DIR: join(options.home, 'pi-custom'),
    PI_AGENT_DIR: join(options.home, 'ignored-pi'),
    XDG_STATE_HOME: 'relative-is-ignored',
  }
  const seen = await settingsMoveHolderFiles({ ...options, env })
  expect(seen).toContain(join(env.OPENCODE_CONFIG_DIR, HOLDER_FILE_NAME))
  expect(seen).toContain(join(env.PI_CODING_AGENT_DIR, HOLDER_FILE_NAME))
  expect(
    seen.some((file) => file.startsWith(join(env.HOME, '.local', 'state'))),
  ).toBe(true)
  expect(
    seen.some(
      (file) =>
        file.includes('ignored-pi') || file.includes('relative-is-ignored'),
    ),
  ).toBe(false)
})

test('default-target path and holder reads stay inside the injected home', async () => {
  const options = await fixture()
  const reads: string[] = []
  expect(
    (
      await checkSettingsMoveFence({
        ...options,
        realpath: async (path) => {
          expect(path.startsWith(options.home)).toBe(true)
          return realpath(path)
        },
        readHolders: async (path) => {
          expect(path.startsWith(options.home)).toBe(true)
          reads.push(path)
          return undefined
        },
      })
    ).open,
  ).toBe(true)
  expect(reads).toHaveLength(3)
})

test('failed or pending registration closes only the move without refusing startup', async () => {
  const options = await fixture()
  for (const registration of [undefined, { status: 'pending' as const }]) {
    let reads = 0
    const result = await checkSettingsMoveFence({
      ...options,
      registration,
      readHolders: async () => {
        reads++
        throw new Error('must not be reached')
      },
    })
    expect(result).toEqual({
      open: false,
      blockers: [
        { kind: 'registration', reason: 'holder registration is unavailable' },
      ],
    })
    expect(reads).toBe(0)
  }
})

for (const host of ['opencode', 'pi'] as const) {
  test(`unstamped ${host} RPC and CacheKeep artifacts, and those stamped below the floor, close the settings fence`, async () => {
    const options = await fixture()
    const rpcRoot = join(options.home, 'rpc')
    const rpcDir = join(rpcRoot, host)
    const cacheDir = join(options.home, host, 'cachekeep')
    await mkdir(rpcDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    for (const kind of ['rpc', 'cachekeep'] as const) {
      const file =
        kind === 'rpc'
          ? join(rpcDir, 'port-200.json')
          : join(cacheDir, '200-record.json')
      // A stamped writer may still be waiting to register as a holder, so
      // its own release decides: only one at or above the floor passes.
      for (const [writer, open] of [
        [undefined, false],
        [{ protocol: 1 }, false],
        [{ protocol: 1, release: '2.11.2' }, false],
        [{ protocol: 1, release: 'unknown' }, false],
        [{ protocol: 1, release: FLOOR }, true],
      ] as const) {
        await writeFile(
          file,
          JSON.stringify({
            pid: 200,
            startedAt: NOW,
            ...(writer ? { writer } : {}),
          }),
        )
        const result = await checkSettingsMoveFence({
          ...options,
          readHolders: async () => undefined,
          artifacts: {
            rpcRoots: [rpcRoot],
            rpcDirs: [],
            cacheKeepDirs: [cacheDir],
          },
        })
        expect(result.open, JSON.stringify(writer)).toBe(open)
        expect(result.blockers).toEqual(
          open ? [] : [{ kind: 'pre-n-artifact', artifact: file, pid: 200 }],
        )
      }
      await rm(file)
    }
  })
}

test('unknown process starts remain live, and an invalid injected floor closes the fence', async () => {
  const options = await fixture()
  expect(
    (
      await checkSettingsMoveFence({
        ...options,
        liveness: { ...liveness, incarnation: async () => null },
        readHolders: async () => ({ entries: [holder({ release: '2.11.2' })] }),
      })
    ).open,
  ).toBe(false)
  expect(
    await checkSettingsMoveFence({ ...options, floor: 'unknown' }),
  ).toEqual({
    open: false,
    blockers: [{ kind: 'floor', release: 'unknown' }],
  })
})
