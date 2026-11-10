import { afterEach, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  HOLDER_FILE_NAME,
  LEGACY_STATE_LAYOUT,
  nativeHolderDatasetFiles,
  resetNativeHolderRegistryForTests,
  resetProcessStateLayoutsForTests,
  resetStateLayoutDecisionsForTests,
  resolveNativePoolPaths,
  setRelocationMoveEnabledForTests,
} from '@cortexkit/anthropic-auth-core'
import { PiNativeRuntime } from '../native.ts'
import { initializeNativePiFixture } from './native-fixture.ts'

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setRelocationMoveEnabledForTests(undefined)
  resetStateLayoutDecisionsForTests()
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
})

for (const moveEnabled of [false, true]) {
  test(`Pi keeps its files in place and records itself beside them with moving ${moveEnabled ? 'on' : 'off'}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-layout-')))
    const savedState = process.env.XDG_STATE_HOME
    cleanups.push(async () => {
      if (savedState === undefined) delete process.env.XDG_STATE_HOME
      else process.env.XDG_STATE_HOME = savedState
      await rm(root, { recursive: true, force: true })
    })
    process.env.XDG_STATE_HOME = join(root, 'state')
    resetNativeHolderRegistryForTests()
    setRelocationMoveEnabledForTests(moveEnabled)
    const agent = join(root, 'agent')
    // Pi's own files, wherever its environment puts them.
    const paths = await resolveNativePoolPaths(
      join(agent, 'anthropic-auth.json'),
      undefined,
      LEGACY_STATE_LAYOUT,
    )
    // One of Pi's dataset files already exists: with moving off,
    // registration is best-effort as in 2.4.x, which records a process only
    // in a folder that holds one of its files. The vault routing file is one
    // that Pi's local mode never reads.
    const routing = nativeHolderDatasetFiles(paths).find((file) =>
      file.includes('vault-routing'),
    )
    if (!routing) throw new Error('Pi has no vault routing file')
    await mkdir(dirname(routing), { recursive: true })
    await writeFile(routing, '{}\n', { flag: 'wx' })
    cleanups.push(() => rm(routing, { force: true }))
    // The runtime registers only after a completed migration admits pool I/O.
    // Keep this a serving case rather than an unmigrated refusal.
    await initializeNativePiFixture(paths)
    const runtime = new PiNativeRuntime(join(agent, 'anthropic-auth.json'), {
      vaultPoll: { intervalMs: 0 },
    })
    // Closing waits for initialization, which registers first.
    await runtime.close()
    const holders = JSON.parse(
      await readFile(join(dirname(paths.runtime), HOLDER_FILE_NAME), 'utf8'),
    ) as { entries: Array<Record<string, unknown>> }
    expect(holders.entries).toContainEqual(
      expect.objectContaining({ pid: process.pid, role: 'pi', kind: 'pi' }),
    )
    // Pi never moves: nothing appears in the state folder.
    expect(
      await readdir(join(root, 'state', 'cortexkit', 'anthropic-auth')).catch(
        () => [],
      ),
    ).toEqual([])
  })
}
