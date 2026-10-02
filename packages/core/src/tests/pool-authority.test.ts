import { afterEach, expect, test } from 'bun:test'
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  advanceNativeMigration,
  beginNativeMigration,
  type NativeMigrationPhase,
  readNativeMigrationJournal,
  requireNativePoolAuthority,
} from '../pool-authority.ts'
import { resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'

const roots: string[] = []
const input = {
  host: 'opencode' as const,
  sources: { config: 'a'.repeat(64), state: 'b'.repeat(64), hostAuth: null },
}

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'anthropic-pool-authority-')),
  )
  roots.push(root)
  return resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
}

afterEach(async () => {
  const owned = roots.splice(0)
  await Promise.all(
    owned.map((root) => rm(root, { recursive: true, force: true })),
  )
})

test('a readable empty pool without a committed journal cannot authorize dispatch', async () => {
  const paths = await fixture()
  const store = createNativePoolStore({
    paths,
    quota: { validate: () => true, merge: (_, value) => value },
  })
  expect(await store.read()).toMatchObject({ status: 'ready', rows: [] })
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-required',
  })
  await expect(stat(paths.journal)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('authority is unavailable until the forward-only commit, and survives cleanup', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, input)
  expect((await stat(paths.journal)).mode & 0o777).toBe(0o600)
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  await advanceNativeMigration(paths, 'building', 'verified')
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  await advanceNativeMigration(paths, 'verified', 'activation-installed')
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  await advanceNativeMigration(paths, 'activation-installed', 'committed')
  await requireNativePoolAuthority(paths)
  await advanceNativeMigration(paths, 'committed', 'retired')
  await requireNativePoolAuthority(paths)
})

test('exact replay is idempotent, while changed sources and host ownership refuse', async () => {
  const paths = await fixture()
  const first = await beginNativeMigration(paths, input)
  const before = await readFile(paths.journal, 'utf8')
  expect(await beginNativeMigration(paths, input)).toEqual(first)
  await expect(
    beginNativeMigration(paths, {
      ...input,
      sources: { ...input.sources, state: 'c'.repeat(64) },
    }),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  await expect(
    beginNativeMigration(paths, { ...input, host: 'pi' }),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
  await advanceNativeMigration(paths, 'building', 'verified')
  const verified = await readFile(paths.journal, 'utf8')
  await advanceNativeMigration(paths, 'building', 'verified')
  expect(await readFile(paths.journal, 'utf8')).toBe(verified)
  expect((await beginNativeMigration(paths, input)).phase).toBe('verified')
})

test('skipped or backward phases never change the journal', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, input)
  const before = await readFile(paths.journal, 'utf8')
  await expect(
    advanceNativeMigration(paths, 'building', 'committed'),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  await expect(
    advanceNativeMigration(paths, 'verified', 'activation-installed'),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
  await advanceNativeMigration(paths, 'building', 'verified')
  const verified = await readFile(paths.journal, 'utf8')
  await expect(
    advanceNativeMigration(paths, 'verified', 'building'),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(verified)
})

test('a copied, malformed or credential-bearing journal refuses without overwriting its bytes', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, input)
  const journal = await readFile(paths.journal, 'utf8')
  const other = await fixture()
  await writeFile(other.journal, journal)
  await expect(requireNativePoolAuthority(other)).rejects.toMatchObject({
    code: 'invalid-journal',
  })
  expect(await readFile(other.journal, 'utf8')).toBe(journal)
  const secret = 'synthetic-secret-never-in-error'
  for (const text of [
    `{"token":"Bearer ${secret}`,
    JSON.stringify({ ...JSON.parse(journal), credential: secret }),
  ]) {
    await writeFile(paths.journal, text)
    let caught: unknown
    try {
      await beginNativeMigration(paths, input)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'invalid-journal' })
    expect(
      caught instanceof Error ? caught.message : String(caught),
    ).not.toContain(secret)
    expect(await readFile(paths.journal, 'utf8')).toBe(text)
  }
})

test('interruption before rename leaves no authority, while interruption after rename resumes forward', async () => {
  const paths = await fixture()
  const crash = async () => {
    throw new Error('simulated interruption')
  }
  await expect(
    beginNativeMigration(paths, input, {
      onWriteStep: async (step) => {
        if (step === 'before-write') await crash()
      },
    }),
  ).rejects.toThrow('simulated interruption')
  expect(await readNativeMigrationJournal(paths)).toBeUndefined()
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-required',
  })
  await expect(
    beginNativeMigration(paths, input, {
      onWriteStep: async (step) => {
        if (step === 'after-write') await crash()
      },
    }),
  ).rejects.toThrow('simulated interruption')
  expect((await beginNativeMigration(paths, input)).phase).toBe('building')
  await advanceNativeMigration(paths, 'building', 'verified')
  await advanceNativeMigration(paths, 'verified', 'activation-installed')
  await expect(
    advanceNativeMigration(paths, 'activation-installed', 'committed', {
      onWriteStep: async (step) => {
        if (step === 'after-write') await crash()
      },
    }),
  ).rejects.toThrow('simulated interruption')
  await requireNativePoolAuthority(paths)
  await advanceNativeMigration(paths, 'activation-installed', 'committed')
  await advanceNativeMigration(paths, 'committed', 'retired')
  await requireNativePoolAuthority(paths)
})

test('concurrent starts publish one journal without rewriting its baselines', async () => {
  const paths = await fixture()
  let writes = 0
  const hooks = {
    onWriteStep: async (step: string) => {
      if (step === 'after-write') writes++
    },
  }
  const journals = await Promise.all(
    Array.from({ length: 4 }, () => beginNativeMigration(paths, input, hooks)),
  )
  expect(writes).toBe(1)
  expect(journals.every((journal) => journal.phase === 'building')).toBe(true)
  expect((await readNativeMigrationJournal(paths))?.sources).toEqual(
    input.sources,
  )
})

const phases: NativeMigrationPhase[] = [
  'building',
  'verified',
  'activation-installed',
  'committed',
  'retired',
]

for (const point of ['before-write', 'after-write'] as const) {
  for (const [index, target] of phases.entries()) {
    test(`real process exit ${point} at ${target} preserves the authority boundary and resumes forward`, async () => {
      const paths = await fixture()
      const previous = phases[index - 1]
      if (previous) {
        await beginNativeMigration(paths, input)
        for (let phase = 1; phase < index; phase++) {
          const before = phases[phase - 1]
          const after = phases[phase]
          if (!before || !after) throw new Error('Invalid fixture stage')
          await advanceNativeMigration(paths, before, after)
        }
      }
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(
            new URL('./pool-authority-crash-child.ts', import.meta.url),
          ),
          dirname(paths.config),
          target,
          point,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const stderr = await new Response(child.stderr).text()
      expect(await child.exited, stderr).toBe(19)
      const expected = point === 'after-write' ? target : previous
      expect((await readNativeMigrationJournal(paths))?.phase).toBe(expected)
      if (expected === 'committed' || expected === 'retired') {
        await requireNativePoolAuthority(paths)
      } else {
        await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
          code: expected ? 'migration-incomplete' : 'migration-required',
        })
      }
      const hooks = { lockOptions: { ttlMs: 100, timeoutMs: 3_000 } }
      if (!previous) await beginNativeMigration(paths, input, hooks)
      else await advanceNativeMigration(paths, previous, target, hooks)
      for (let phase = index + 1; phase < phases.length; phase++) {
        const before = phases[phase - 1]
        const after = phases[phase]
        if (!before || !after) throw new Error('Invalid fixture stage')
        await advanceNativeMigration(paths, before, after, hooks)
      }
      await requireNativePoolAuthority(paths)
      expect((await readNativeMigrationJournal(paths))?.phase).toBe('retired')
    })
  }
}
