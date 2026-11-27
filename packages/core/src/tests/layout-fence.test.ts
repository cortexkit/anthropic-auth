import { test as bunTest, expect, spyOn } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { HOLDER_FILE_NAME, type HolderLiveness } from '../holder-registry.ts'
import {
  defaultPreNArtifactLocations,
  holderFenceBlockers,
  type PreNArtifactLocations,
  preNArtifactBlockers,
} from '../layout-fence.ts'
import { checkSettingsMoveFence } from '../settings-move-fence.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, wrapBody, deferCleanup } = createTestLifetimeSuite()
const NOW = Date.UTC(2026, 0, 2, 12)
const BOOT = Date.UTC(2026, 0, 2, 11)
const clock = {
  now: () => NOW,
  uptime: () => 3_600,
  processStartedAtMs: async () => null,
}
const liveness: HolderLiveness = {
  ...clock,
  pidAlive: (pid) => {
    process.kill(pid, 0)
    return true
  },
  incarnation: async () => null,
}

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'layout-fence-'))
  deferCleanup(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function artifact(
  kind: 'CacheKeep record' | 'RPC port file',
  fields: Record<string, unknown> = {},
  mtime = BOOT - 5 * 60_000 - 1,
) {
  const dir = await folder()
  const path = join(
    dir,
    kind === 'CacheKeep record'
      ? `${process.pid}-old.json`
      : `port-${process.pid}.json`,
  )
  await writeFile(
    path,
    JSON.stringify({ pid: process.pid, version: 1, sessions: [], ...fields }),
  )
  await utimes(path, new Date(mtime), new Date(mtime))
  const locations: PreNArtifactLocations = {
    rpcRoots: [],
    rpcDirs: kind === 'RPC port file' ? [dir] : [],
    cacheKeepDirs: kind === 'CacheKeep record' ? [dir] : [],
  }
  return { path, locations }
}

for (const kind of ['CacheKeep record', 'RPC port file'] as const) {
  // The CacheKeep record here is named `<pid>-old.json`, not the production
  // `<pid>-<uuid>.json`, so its filename does not prove its writer and its
  // malformed bytes keep blocking. A production-named RPC port file whose
  // filename pid is dead clears even when malformed.
  test(`a dead older writer's valid ${kind} clears; malformed bytes clear only under a production filename`, async () => {
    const { path, locations } = await artifact(kind, {}, NOW)
    const check = () =>
      checkSettingsMoveFence({
        home: dirname(path),
        env: {},
        stores: [],
        registration: { status: 'registered' },
        readHolders: async () => undefined,
        artifacts: locations,
        liveness: { ...liveness, pidAlive: () => false },
      })
    expect(await check()).toEqual({ open: true, blockers: [] })
    await writeFile(path, '{invalid-old-record')
    await utimes(path, new Date(BOOT - 600_000), new Date(BOOT - 600_000))
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await check()).toEqual(
        kind === 'RPC port file'
          ? { open: true, blockers: [] }
          : {
              open: false,
              blockers: [{ kind: 'artifact-scan', path, reason: 'invalid' }],
            },
      )
    }
    await rm(path)
    expect(await check()).toEqual({ open: true, blockers: [] })
  })

  test(`a live older writer's ${kind} blocks until a proven reboot or exit`, async () => {
    const { path, locations } = await artifact(
      kind,
      { startedAt: NOW, writer: { protocol: 1, release: '2.11.2' } },
      NOW,
    )
    const scan = (alive: boolean) =>
      preNArtifactBlockers(
        locations,
        () => alive,
        clock,
        (release) => release === '2.12.0',
      )
    expect(await scan(true)).toEqual([
      { kind: 'pre-n-artifact', artifact: path, pid: process.pid },
    ])
    expect(await scan(false)).toEqual([])
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, startedAt: BOOT - 600_000 }),
    )
    expect(await scan(true)).toEqual([])
  })

  test(`a ${kind} predating boot does not block when its pid has been reused`, async () => {
    const { locations } = await artifact(kind)
    // The test process is alive, but it did not write the pre-boot record.
    expect(await preNArtifactBlockers(locations, undefined, clock)).toEqual([])
  })

  test(`a ${kind} keeps blocking within the boot margin or without a trustworthy start time`, async () => {
    const cases = [
      { fields: {}, mtime: BOOT - 5 * 60_000 },
      { fields: {}, mtime: BOOT - 5 * 60_000 + 1 },
      { fields: {}, mtime: BOOT + 1 },
      { fields: {}, mtime: NOW + 1 },
      { fields: { startedAt: null } },
      { fields: { startedAt: NOW + 1 } },
      { fields: { registeredAt: NOW + 1 } },
      { fields: { startedAt: BOOT + 1 } },
    ]
    for (const { fields, mtime } of cases) {
      const { path, locations } = await artifact(kind, fields, mtime)
      expect(await preNArtifactBlockers(locations, undefined, clock)).toEqual([
        { kind: 'pre-n-artifact', artifact: path, pid: process.pid },
      ])
    }
  })

  test(`a ${kind} uses its recorded start before its mtime`, async () => {
    for (const field of ['startedAt', 'registeredAt']) {
      const { locations } = await artifact(
        kind,
        { [field]: BOOT - 5 * 60_000 - 1 },
        NOW,
      )
      expect(await preNArtifactBlockers(locations, undefined, clock)).toEqual(
        [],
      )
    }
  })
}

bunTest.skipIf(process.platform === 'win32')(
  'the legacy temp registry blocks for a live same-user writer but not another user',
  wrapBody(async () => {
    const root = await folder()
    const oldTmp = process.env.TMPDIR
    process.env.TMPDIR = root
    try {
      const dir = join(
        root,
        'opencode-anthropic-auth',
        'cachekeep-sessions',
        'pi',
      )
      const path = join(
        dir,
        `${process.pid}-5f24847c-d2f1-4d4b-875a-e354cbbe2b50.json`,
      )
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(
        path,
        JSON.stringify({ version: 1, updatedAt: NOW, sessions: [] }),
      )
      await utimes(path, new Date(NOW), new Date(NOW))
      const locations = defaultPreNArtifactLocations({ HOME: root }, root)
      expect(locations.cacheKeepDirs).toContain(dir)
      const scan = () =>
        preNArtifactBlockers(locations, liveness.pidAlive, clock)
      expect(await scan()).toEqual([
        { kind: 'pre-n-artifact', artifact: path, pid: process.pid },
      ])

      if (!process.getuid) throw new Error('Expected a POSIX UID')
      const uid = process.getuid()
      const getuid = spyOn(process, 'getuid').mockReturnValue(uid + 1)
      try {
        expect(await scan()).toEqual([])
      } finally {
        getuid.mockRestore()
      }
    } finally {
      if (oldTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = oldTmp
    }
  }),
)

test('an invalid RPC record from a live filename pid and a non-directory RPC root keep blocking', async () => {
  const { path, locations } = await artifact('RPC port file', {}, NOW)
  await writeFile(path, '{}')
  expect(await preNArtifactBlockers(locations, () => true, clock)).toEqual([
    { kind: 'artifact-scan', path, reason: 'invalid' },
  ])
  const blockers = await preNArtifactBlockers(
    { rpcRoots: [path], rpcDirs: [], cacheKeepDirs: [] },
    () => false,
    clock,
  )
  expect(blockers).toHaveLength(1)
  expect(blockers[0]).toMatchObject({ kind: 'artifact-scan', path })
})

test('the fence treats oversized publisher records as malformed but still clears stale files', async () => {
  const { path, locations } = await artifact('RPC port file', {}, NOW)
  const bytes = Buffer.from(
    JSON.stringify({ pid: process.pid, writer: { protocol: 1 } }),
  )
  await writeFile(path, Buffer.concat([bytes, Buffer.alloc(64 * 1024, 32)]))
  await utimes(path, new Date(NOW), new Date(NOW))
  expect(await preNArtifactBlockers(locations, () => true, clock)).toEqual([
    { kind: 'artifact-scan', path, reason: 'invalid' },
  ])
  expect(await preNArtifactBlockers(locations, () => false, clock)).toEqual([])
})

test('malformed holder entries and registries keep the settings fence closed without any live pid', async () => {
  const home = await folder()
  const file = join(home, '.config', 'opencode', HOLDER_FILE_NAME)
  await mkdir(dirname(file), { recursive: true })
  const check = () =>
    checkSettingsMoveFence({
      home,
      env: {},
      stores: [],
      registration: { status: 'registered' },
      artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
      liveness: { ...liveness, pidAlive: () => false },
    })
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        {
          pid: process.pid,
          incarnation: null,
          release: '2.11.2',
          registeredAt: NOW,
        },
      ],
    }),
  )
  expect(await check()).toEqual({ open: true, blockers: [] })
  await writeFile(file, JSON.stringify({ version: 1, entries: [{}] }))
  expect((await check()).blockers).toEqual([
    {
      kind: 'settings-holder',
      holderFile: file,
      pid: null,
      release: null,
      reason: 'unreadable',
    },
  ])
  await writeFile(file, '{broken')
  expect((await check()).blockers).toMatchObject([
    { kind: 'holder-file', holderFile: file },
  ])
  await rm(file)
  expect(await check()).toEqual({ open: true, blockers: [] })
})

test('a holder with no incarnation predating boot does not block', async () => {
  const dir = await folder()
  const file = join(dir, 'state.json')
  await writeFile(
    join(dir, HOLDER_FILE_NAME),
    JSON.stringify({
      version: 1,
      entries: [
        {
          pid: process.pid,
          incarnation: null,
          files: [file],
          registeredAt: BOOT - 5 * 60_000 - 1,
        },
      ],
    }),
  )
  expect(
    await holderFenceBlockers({ directories: [dir], files: [file], liveness }),
  ).toEqual([])
})

test('a holder keeps blocking within the boot margin or without a trustworthy registration time', async () => {
  const dir = await folder()
  const file = join(dir, 'state.json')
  for (const registeredAt of [
    BOOT - 5 * 60_000,
    BOOT - 5 * 60_000 + 1,
    BOOT + 1,
    undefined,
    null,
    'invalid',
    NOW + 1,
  ]) {
    await writeFile(
      join(dir, HOLDER_FILE_NAME),
      JSON.stringify({
        version: 1,
        entries: [
          { pid: process.pid, incarnation: null, files: [file], registeredAt },
        ],
      }),
    )
    expect(
      await holderFenceBlockers({
        directories: [dir],
        files: [file],
        liveness,
      }),
    ).toHaveLength(1)
  }
})
