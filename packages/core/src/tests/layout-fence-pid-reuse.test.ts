import { expect } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type PreNArtifactLocations,
  preNArtifactBlockers,
} from '../layout-fence.ts'
import { checkSettingsMoveFence } from '../settings-move-fence.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const NOW = Date.UTC(2026, 10, 17, 12)
const WRITTEN = NOW - 60_000
const PID = 1234
const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

async function fixture(
  kind: 'rpc' | 'cachekeep',
  bytes: string,
  mtime = WRITTEN,
) {
  const root = await mkdtemp(join(tmpdir(), 'fence-pid-reuse-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'records')
  await mkdir(dir)
  const path = join(
    dir,
    kind === 'rpc' ? `port-${PID}.json` : `${PID}-${UUID}.json`,
  )
  await writeFile(path, bytes)
  await utimes(path, new Date(mtime), new Date(mtime))
  const locations: PreNArtifactLocations = {
    rpcRoots: [],
    rpcDirs: kind === 'rpc' ? [dir] : [],
    cacheKeepDirs: kind === 'cachekeep' ? [dir] : [],
  }
  return { root, path, locations }
}

for (const kind of ['rpc', 'cachekeep'] as const) {
  for (const [name, bytes] of [
    ['startedAt', JSON.stringify({ pid: PID, startedAt: WRITTEN })],
    ['registeredAt', JSON.stringify({ pid: PID, registeredAt: WRITTEN })],
    ['mtime', JSON.stringify({ pid: PID })],
    ['malformed bytes', '{bad-json'],
    ['malformed record', JSON.stringify({ pid: 'invalid' })],
  ]) {
    test(`${kind} ${name}: a live but reused pid no longer blocks the settings move`, async () => {
      const { root, locations } = await fixture(kind, bytes!)
      const result = await checkSettingsMoveFence({
        home: root,
        env: {},
        stores: [],
        registration: { status: 'registered' },
        readHolders: async () => undefined,
        self: { pid: 1, incarnation: null },
        artifacts: locations,
        liveness: {
          pidAlive: () => true,
          incarnation: async () => null,
          now: () => NOW,
          uptime: () => 12 * 24 * 3_600,
          processStartedAtMs: async (pid) => {
            expect(pid).toBe(PID)
            return WRITTEN + 2_001
          },
        },
      })
      expect(result).toEqual({ open: true, blockers: [] })
    })
  }

  for (const start of [
    WRITTEN - 1_000,
    WRITTEN + 1_000,
    WRITTEN + 2_000,
    null,
  ]) {
    test(`${kind}: process start ${start} keeps the artifact blocking`, async () => {
      const { locations } = await fixture(
        kind,
        JSON.stringify({ pid: PID, startedAt: WRITTEN }),
      )
      const blockers = await preNArtifactBlockers(locations, () => true, {
        now: () => NOW,
        uptime: () => 3_600,
        processStartedAtMs: async () => start,
      })
      expect(blockers).toHaveLength(1)
      expect(blockers[0]?.kind).toBe('pre-n-artifact')
    })
  }

  test(`${kind}: explicit invalid or future write times do not use an older mtime`, async () => {
    for (const startedAt of ['invalid', -1, NOW + 1]) {
      const { locations } = await fixture(
        kind,
        JSON.stringify({ pid: PID, startedAt }),
      )
      expect(
        await preNArtifactBlockers(locations, () => true, {
          now: () => NOW,
          uptime: () => 3_600,
          processStartedAtMs: async () => WRITTEN + 10_000,
        }),
      ).toHaveLength(1)
    }
  })

  test(`${kind}: unknown or throwing process-start lookup keeps malformed bytes blocking`, async () => {
    const { locations } = await fixture(kind, '{bad-json')
    for (const lookup of [
      async () => null,
      async () => {
        throw new Error('unreadable')
      },
    ]) {
      const blockers = await preNArtifactBlockers(locations, () => true, {
        now: () => NOW,
        uptime: () => 3_600,
        processStartedAtMs: lookup,
      })
      expect(blockers).toHaveLength(1)
      expect(blockers[0]?.kind).toBe('artifact-scan')
    }
  })
}
