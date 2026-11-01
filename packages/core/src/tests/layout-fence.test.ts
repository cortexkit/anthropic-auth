import { expect } from 'bun:test'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HOLDER_FILE_NAME, type HolderLiveness } from '../holder-registry.ts'
import {
  holderFenceBlockers,
  type PreNArtifactLocations,
  preNArtifactBlockers,
} from '../layout-fence.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const NOW = Date.UTC(2026, 0, 2, 12)
const BOOT = Date.UTC(2026, 0, 2, 11)
const clock = { now: () => NOW, uptime: () => 3_600 }
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
