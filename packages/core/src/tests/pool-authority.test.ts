import { expect } from 'bun:test'
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspectNativeHostAuthEntry } from '../native-host-auth.ts'
import {
  advanceNativeCustodyActivation,
  advanceNativeMigration,
  beginNativeMigration,
  type NativeCustodyActivationPlan,
  type NativeMigrationInput,
  type NativeMigrationPhase,
  nativeMigrationAuthorityPhase,
  readNativeMigrationJournal,
  recordNativeCustodyActivation,
  recordNativeMigrationExpectations,
  requireNativePoolAuthority,
} from '../pool-authority.ts'
import { type NativePoolPaths, resolveNativePoolPaths } from '../pool-paths.ts'
import { createNativePoolStore } from '../pool-store.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

const { test, deferCleanup } = createTestLifetimeSuite()
const preparedProof = {
  version: 1 as const,
  rows: [],
  runtimeDigest: 'f'.repeat(64),
}
const expectations = {
  expectedHostAuth: 'd'.repeat(64),
  expectedRouting: 'e'.repeat(64),
  preparedProof,
}

function captureInput(paths: NativePoolPaths): NativeMigrationInput {
  const root = dirname(paths.config)
  return {
    host: 'opencode',
    sources: {
      config: 'a'.repeat(64),
      state: 'b'.repeat(64),
      hostAuth: 'absent',
      routing: 'c'.repeat(64),
    },
    routingPaths: {
      source: join(root, 'legacy-routing.json'),
      destination: join(root, 'native-routing.json'),
    },
    hostAuthPath: join(root, 'host-auth.json'),
  }
}

async function fixture() {
  const created = await mkdtemp(join(tmpdir(), 'anthropic-pool-authority-'))
  deferCleanup(() => rm(created, { recursive: true, force: true }))
  const root = await realpath(created)
  return resolveNativePoolPaths(
    join(root, 'anthropic-auth.json'),
    join(root, 'anthropic-auth-state.json'),
  )
}

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
  const input = captureInput(paths)
  await beginNativeMigration(paths, input)
  expect((await stat(paths.journal)).mode & 0o777).toBe(0o600)
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  await advanceNativeMigration(paths, 'building', 'verified')
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  await recordNativeMigrationExpectations(paths, expectations)
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
  const input = captureInput(paths)
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
  const input = captureInput(paths)
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
  const input = captureInput(paths)
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
  const input = captureInput(paths)
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
  await recordNativeMigrationExpectations(paths, expectations)
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
  const input = captureInput(paths)
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

test('v4 persists eleven fields including an initially absent prepared proof and activation', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  const journal = await beginNativeMigration(paths, input)
  const text = await readFile(paths.journal, 'utf8')
  expect(JSON.parse(text)).toEqual({
    version: 4,
    storageId: paths.storageId,
    host: 'opencode',
    phase: 'building',
    sources: {
      config: 'a'.repeat(64),
      state: 'b'.repeat(64),
      hostAuth: 'absent',
      routing: 'c'.repeat(64),
    },
    routingPaths: input.routingPaths,
    hostAuthPath: input.hostAuthPath,
    expectedHostAuth: 'unprepared',
    expectedRouting: 'unprepared',
    preparedProof: null,
    activation: null,
  })
  expect(Object.keys(journal)).toHaveLength(11)
  expect(Object.keys(journal.sources).sort()).toEqual([
    'config',
    'hostAuth',
    'routing',
    'state',
  ])
  expect(Object.keys(journal.routingPaths).sort()).toEqual([
    'destination',
    'source',
  ])
  // The host-auth and routing files do not exist. Creating the journal must use
  // the supplied entry and file digests without reading those paths.
  for (const path of [
    input.hostAuthPath,
    input.routingPaths.source,
    input.routingPaths.destination,
  ]) {
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

test('canonical Anthropic entry digests persist without any credential strings', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  const access = 'synthetic-access-secret'
  const refresh = 'synthetic-refresh-secret'
  const key = 'synthetic-api-secret'
  input.sources.hostAuth = inspectNativeHostAuthEntry('opencode', {
    anthropic: { type: 'oauth', access, refresh, expires: 123 },
    other: { key },
  }).digest
  const expectedHostAuth = inspectNativeHostAuthEntry('opencode', {
    anthropic: { type: 'api', key },
  }).digest
  await beginNativeMigration(paths, input)
  await advanceNativeMigration(paths, 'building', 'verified')
  await recordNativeMigrationExpectations(paths, {
    ...expectations,
    expectedHostAuth,
  })
  const text = await readFile(paths.journal, 'utf8')
  expect(JSON.parse(text).sources.hostAuth).toBe(input.sources.hostAuth)
  expect(JSON.parse(text).expectedHostAuth).toBe(expectedHostAuth)
  for (const secret of [access, refresh, key])
    expect(text).not.toContain(secret)
})

test('v1 journals refuse unchanged rather than supplying v4 defaults', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  const text = JSON.stringify({
    version: 1,
    storageId: paths.storageId,
    host: input.host,
    phase: 'verified',
    sources: {
      config: input.sources.config,
      state: input.sources.state,
      hostAuth: null,
    },
  })
  await writeFile(paths.journal, text)
  await expect(readNativeMigrationJournal(paths)).rejects.toMatchObject({
    code: 'invalid-journal',
  })
  await expect(beginNativeMigration(paths, input)).rejects.toMatchObject({
    code: 'invalid-journal',
  })
  expect(await readFile(paths.journal, 'utf8')).toBe(text)
})

test('closed v2 decoder rejects missing, extra and credential-bearing keys in every map', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  const journal = await beginNativeMigration(paths, input)
  const secret = 'synthetic-access-secret'
  const invalid: unknown[] = []
  for (const key of Object.keys(journal)) {
    const missing = { ...journal } as Record<string, unknown>
    delete missing[key]
    invalid.push(missing)
  }
  for (const key of Object.keys(journal.sources)) {
    const missing = { ...journal.sources } as Record<string, unknown>
    delete missing[key]
    invalid.push({ ...journal, sources: missing })
  }
  for (const key of Object.keys(journal.routingPaths)) {
    const missing = { ...journal.routingPaths } as Record<string, unknown>
    delete missing[key]
    invalid.push({ ...journal, routingPaths: missing })
  }
  for (const key of [
    'credential',
    'access',
    'refresh',
    'token',
    'key',
    'extra',
  ]) {
    invalid.push(
      { ...journal, [key]: secret },
      { ...journal, sources: { ...journal.sources, [key]: secret } },
      { ...journal, routingPaths: { ...journal.routingPaths, [key]: secret } },
    )
  }
  invalid.push(
    { ...journal, sources: [] },
    { ...journal, routingPaths: [] },
    {
      ...journal,
      sources: { ...journal.sources, config: undefined, token: secret },
    },
    {
      ...journal,
      routingPaths: {
        destination: input.routingPaths.destination,
        token: secret,
      },
    },
  )
  for (const value of invalid) {
    const text = JSON.stringify(value)
    await writeFile(paths.journal, text)
    let caught: unknown
    try {
      await beginNativeMigration(paths, input)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'invalid-journal' })
    expect((caught as Error).message).toBe(
      'Anthropic account migration journal is invalid',
    )
    expect((caught as Error).message).not.toContain(secret)
    expect(await readFile(paths.journal, 'utf8')).toBe(text)
  }
})

test('sources distinguish Anthropic entry absence from nullable file digests', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  const journal = await beginNativeMigration(paths, input)
  for (const key of ['config', 'state', 'hostAuth', 'routing'] as const) {
    for (const value of [
      null,
      'absent',
      'unprepared',
      'A'.repeat(64),
      'a'.repeat(63),
      `${'a'.repeat(64)}\n`,
      0,
      {},
      [],
    ]) {
      if (value === null && key !== 'hostAuth') continue
      if (value === 'absent' && key === 'hostAuth') continue
      const text = JSON.stringify({
        ...journal,
        sources: { ...journal.sources, [key]: value },
      })
      await writeFile(paths.journal, text)
      await expect(readNativeMigrationJournal(paths)).rejects.toMatchObject({
        code: 'invalid-journal',
      })
      expect(await readFile(paths.journal, 'utf8')).toBe(text)
    }
  }
  for (const hostAuth of ['absent', 'f'.repeat(64)]) {
    const absentFiles = {
      ...journal,
      sources: { config: null, state: null, hostAuth, routing: null },
    }
    await writeFile(paths.journal, JSON.stringify(absentFiles))
    expect(await readNativeMigrationJournal(paths)).toEqual(absentFiles)
  }
})

test('begin requires every capture field instead of guessing paths or routing absence', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  const invalid: unknown[] = []
  for (const key of ['host', 'sources', 'routingPaths', 'hostAuthPath']) {
    const missing = { ...input } as Record<string, unknown>
    delete missing[key]
    invalid.push(missing)
  }
  for (const key of Object.keys(input.sources)) {
    const sources = { ...input.sources } as Record<string, unknown>
    delete sources[key]
    invalid.push({ ...input, sources })
  }
  for (const value of invalid) {
    await expect(
      beginNativeMigration(paths, value as NativeMigrationInput),
    ).rejects.toMatchObject({ code: 'invalid-journal' })
    expect(await readNativeMigrationJournal(paths)).toBeUndefined()
  }
})

test('path shapes refuse without normalizing or accessing physical leaves', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  const journal = await beginNativeMigration(paths, input)
  for (const path of [
    '',
    'relative/auth.json',
    '/',
    '/tmp/auth/',
    '/tmp//auth.json',
    '/tmp/./auth.json',
    '/tmp/../auth.json',
    '/tmp/auth\u0000.json',
    '/tmp/auth\n.json',
    null,
    1,
  ]) {
    for (const invalid of [
      { ...journal, hostAuthPath: path },
      { ...journal, routingPaths: { ...journal.routingPaths, source: path } },
      {
        ...journal,
        routingPaths: { ...journal.routingPaths, destination: path },
      },
    ]) {
      const text = JSON.stringify(invalid)
      await writeFile(paths.journal, text)
      await expect(readNativeMigrationJournal(paths)).rejects.toMatchObject({
        code: 'invalid-journal',
      })
      expect(await readFile(paths.journal, 'utf8')).toBe(text)
    }
  }
})

test('native canonical leaf spellings retain their exact path bytes', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  // Backslash is a separator on Windows and a literal filename byte on POSIX.
  input.hostAuthPath = join(dirname(paths.config), 'host\\auth.json')
  const journal = await beginNativeMigration(paths, input)
  expect(journal.hostAuthPath).toBe(input.hostAuthPath)
  expect((await readNativeMigrationJournal(paths))?.hostAuthPath).toBe(
    input.hostAuthPath,
  )
})

test('isolated Windows semantics accept canonical drive and UNC captures without source I/O', async () => {
  const paths = await fixture()
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL('./pool-authority-crash-child.ts', import.meta.url),
      ),
      dirname(paths.config),
      'windows-paths',
      'before-write',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toEqual({
    canonicalWindowsPaths: true,
    acceptedCaptures: 2,
    rejectedCaptures: 33,
    lockCalls: 2,
    filesystemCalls: 0,
    writes: 0,
  })
  // The child mocks Node's Windows path operations; the parent must still use
  // its own operating system's path operations after the child exits.
  expect((await beginNativeMigration(paths, captureInput(paths))).phase).toBe(
    'building',
  )
})

for (const field of ['config', 'state', 'hostAuth', 'routing'] as const) {
  test(`${field} source drift refuses without changing journal bytes`, async () => {
    const paths = await fixture()
    const input = captureInput(paths)
    await beginNativeMigration(paths, input)
    await advanceNativeMigration(paths, 'building', 'verified')
    await recordNativeMigrationExpectations(paths, expectations)
    const before = await readFile(paths.journal, 'utf8')
    await expect(
      beginNativeMigration(paths, {
        ...input,
        sources: { ...input.sources, [field]: 'f'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'journal-conflict' })
    expect(await readFile(paths.journal, 'utf8')).toBe(before)
  })
}

test('host-auth path drift refuses without changing journal bytes', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  await beginNativeMigration(paths, input)
  const before = await readFile(paths.journal, 'utf8')
  await expect(
    beginNativeMigration(paths, {
      ...input,
      hostAuthPath: join(dirname(paths.config), 'other-host-auth.json'),
    }),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
})

for (const field of ['source', 'destination'] as const) {
  test(`routing ${field} path drift refuses without changing journal bytes`, async () => {
    const paths = await fixture()
    const input = captureInput(paths)
    await beginNativeMigration(paths, input)
    const before = await readFile(paths.journal, 'utf8')
    await expect(
      beginNativeMigration(paths, {
        ...input,
        routingPaths: {
          ...input.routingPaths,
          [field]: join(dirname(paths.config), 'other-routing.json'),
        },
      }),
    ).rejects.toMatchObject({ code: 'journal-conflict' })
    expect(await readFile(paths.journal, 'utf8')).toBe(before)
  })
}

test('begin retry ignores map insertion order and never resets prepared expectations', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  // Set routing source and destination to the same path explicitly; neither
  // field gets its value from an implicit destination default.
  input.routingPaths.destination = input.routingPaths.source
  await beginNativeMigration(paths, input)
  await advanceNativeMigration(paths, 'building', 'verified')
  const prepared = await recordNativeMigrationExpectations(paths, expectations)
  const before = await readFile(paths.journal, 'utf8')
  const retry = {
    ...input,
    sources: {
      routing: input.sources.routing,
      hostAuth: input.sources.hostAuth,
      state: input.sources.state,
      config: input.sources.config,
    },
    routingPaths: {
      destination: input.routingPaths.destination,
      source: input.routingPaths.source,
    },
  }
  expect(
    await beginNativeMigration(paths, retry, {
      onWriteStep: async () => {
        throw new Error('Unexpected retry write')
      },
    }),
  ).toEqual(prepared)
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
  await advanceNativeMigration(paths, 'verified', 'activation-installed')
  expect(await beginNativeMigration(paths, retry)).toEqual({
    ...prepared,
    phase: 'activation-installed',
  })
})

test('expectation recording publishes one complete pair at verified with no-write retries and conflicts', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, captureInput(paths))
  const verified = await advanceNativeMigration(paths, 'building', 'verified')
  let writes = 0
  const recorded = await recordNativeMigrationExpectations(
    paths,
    expectations,
    {
      onWriteStep: async (step) => {
        if (step === 'after-write') writes++
      },
    },
  )
  expect(recorded).toEqual({
    ...verified,
    expectedHostAuth: 'd'.repeat(64),
    expectedRouting: 'e'.repeat(64),
    preparedProof,
  })
  expect(await readNativeMigrationJournal(paths)).toEqual(recorded)
  expect(writes).toBe(1)
  const before = await readFile(paths.journal, 'utf8')
  const inode = (await stat(paths.journal)).ino
  expect(
    await recordNativeMigrationExpectations(paths, expectations, {
      onWriteStep: async () => {
        throw new Error('Unexpected retry write')
      },
    }),
  ).toEqual(recorded)
  expect((await stat(paths.journal)).ino).toBe(inode)
  for (const changed of [
    { ...expectations, expectedHostAuth: 'absent' },
    { ...expectations, expectedRouting: 'f'.repeat(64) },
  ]) {
    await expect(
      recordNativeMigrationExpectations(paths, changed),
    ).rejects.toMatchObject({ code: 'journal-conflict' })
    expect(await readFile(paths.journal, 'utf8')).toBe(before)
  }
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
})

test('expectations can be recorded only at verified and activation requires preparation', async () => {
  const paths = await fixture()
  await expect(
    recordNativeMigrationExpectations(paths, expectations),
  ).rejects.toMatchObject({ code: 'migration-required' })
  await beginNativeMigration(paths, captureInput(paths))
  const building = await readFile(paths.journal, 'utf8')
  await expect(
    recordNativeMigrationExpectations(paths, expectations),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(building)
  await advanceNativeMigration(paths, 'building', 'verified')
  const verified = await readFile(paths.journal, 'utf8')
  await expect(
    advanceNativeMigration(paths, 'verified', 'activation-installed'),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(verified)
  await recordNativeMigrationExpectations(paths, expectations)
  for (const [previous, next] of [
    ['verified', 'activation-installed'],
    ['activation-installed', 'committed'],
    ['committed', 'retired'],
  ] as const) {
    const journal = await advanceNativeMigration(paths, previous, next)
    expect(journal).toMatchObject(expectations)
    const before = await readFile(paths.journal, 'utf8')
    await expect(
      recordNativeMigrationExpectations(paths, expectations),
    ).rejects.toMatchObject({ code: 'journal-conflict' })
    expect(await readFile(paths.journal, 'utf8')).toBe(before)
  }
})

test('expectation input refuses unprepared, malformed and credential-bearing values', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, captureInput(paths))
  await advanceNativeMigration(paths, 'building', 'verified')
  const before = await readFile(paths.journal, 'utf8')
  for (const invalid of [
    { expectedHostAuth: 'unprepared', expectedRouting: 'unprepared' },
    { ...expectations, expectedHostAuth: 'unprepared' },
    { ...expectations, expectedRouting: 'unprepared' },
    { ...expectations, expectedHostAuth: null },
    { ...expectations, expectedRouting: 'absent' },
    { ...expectations, expectedHostAuth: 'D'.repeat(64) },
    { ...expectations, expectedHostAuth: `${'d'.repeat(64)}\n` },
    { ...expectations, expectedRouting: 0 },
    { expectedHostAuth: 'absent' },
    { expectedRouting: null },
    { ...expectations, credential: 'synthetic-api-secret' },
  ]) {
    await expect(
      recordNativeMigrationExpectations(paths, invalid as typeof expectations),
    ).rejects.toMatchObject({ code: 'invalid-journal' })
    expect(await readFile(paths.journal, 'utf8')).toBe(before)
  }
})

test('absent routing and absent entry remain distinct from unprepared expectations', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  input.sources.routing = null
  const journal = await beginNativeMigration(paths, input)
  expect(journal.sources.hostAuth).toBe('absent')
  expect(journal.sources.routing).toBeNull()
  expect(journal.expectedHostAuth).toBe('unprepared')
  expect(journal.expectedRouting).toBe('unprepared')
  await advanceNativeMigration(paths, 'building', 'verified')
  const before = await readFile(paths.journal, 'utf8')
  await expect(
    recordNativeMigrationExpectations(paths, expectations),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
  const absent = {
    expectedHostAuth: 'absent',
    expectedRouting: null,
    preparedProof,
  }
  const prepared = await recordNativeMigrationExpectations(paths, absent)
  expect(prepared).toMatchObject(absent)
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  expect(await recordNativeMigrationExpectations(paths, absent)).toEqual(
    prepared,
  )
  const other = await fixture()
  await beginNativeMigration(other, captureInput(other))
  await advanceNativeMigration(other, 'building', 'verified')
  const present = await readFile(other.journal, 'utf8')
  await expect(
    recordNativeMigrationExpectations(other, absent),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(other.journal, 'utf8')).toBe(present)
})

test('decoder rejects mixed, phase-incoherent and routing-inconsistent expectations unchanged', async () => {
  const paths = await fixture()
  const journal = await beginNativeMigration(paths, captureInput(paths))
  const invalid: unknown[] = [
    { ...journal, expectedHostAuth: 'absent' },
    { ...journal, expectedRouting: null },
    { ...journal, ...expectations },
    { ...journal, phase: 'verified', expectedHostAuth: 'absent' },
    { ...journal, phase: 'verified', expectedRouting: 'e'.repeat(64) },
    { ...journal, phase: 'verified', expectedHostAuth: null },
    { ...journal, phase: 'verified', expectedRouting: 'absent' },
    { ...journal, phase: 'verified', expectedHostAuth: 'x'.repeat(64) },
    { ...journal, phase: 'verified', ...expectations, expectedRouting: null },
    {
      ...journal,
      phase: 'verified',
      ...expectations,
      sources: { ...journal.sources, routing: null },
    },
  ]
  for (const phase of ['activation-installed', 'committed', 'retired'])
    invalid.push({ ...journal, phase })
  for (const value of invalid) {
    const text = JSON.stringify(value)
    await writeFile(paths.journal, text)
    await expect(readNativeMigrationJournal(paths)).rejects.toMatchObject({
      code: 'invalid-journal',
    })
    await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
      code: 'invalid-journal',
    })
    expect(await readFile(paths.journal, 'utf8')).toBe(text)
  }
})

test('concurrent expectation recorders publish only one immutable pair', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, captureInput(paths))
  await advanceNativeMigration(paths, 'building', 'verified')
  let writes = 0
  const hooks = {
    onWriteStep: async (step: string) => {
      if (step === 'after-write') writes++
    },
  }
  const journals = await Promise.all(
    Array.from({ length: 4 }, () =>
      recordNativeMigrationExpectations(paths, expectations, hooks),
    ),
  )
  expect(writes).toBe(1)
  expect(
    journals.every(
      (journal) =>
        journal.expectedHostAuth === expectations.expectedHostAuth &&
        journal.expectedRouting === expectations.expectedRouting,
    ),
  ).toBe(true)
  const before = await readFile(paths.journal, 'utf8')
  await expect(
    recordNativeMigrationExpectations(
      paths,
      {
        expectedHostAuth: 'absent',
        expectedRouting: 'f'.repeat(64),
        preparedProof,
      },
      hooks,
    ),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(writes).toBe(1)
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
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
      const input = captureInput(paths)
      const previous = phases[index - 1]
      if (previous) {
        await beginNativeMigration(paths, input)
        for (let phase = 1; phase < index; phase++) {
          const before = phases[phase - 1]
          const after = phases[phase]
          if (!before || !after) throw new Error('Invalid fixture stage')
          if (before === 'verified')
            await recordNativeMigrationExpectations(paths, expectations)
          await advanceNativeMigration(paths, before, after)
        }
        if (previous === 'verified')
          await recordNativeMigrationExpectations(paths, expectations)
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
      const lockPath = `${paths.journal}.migration-journal.lock`
      const abandoned = JSON.parse(await readFile(lockPath, 'utf8'))
      expect(abandoned.ownerId).toEqual(expect.any(String))
      expect(abandoned.expiresAt).toEqual(expect.any(Number))
      const inode = (await stat(lockPath)).ino
      // The process is dead. Expire only its fixture marker so reclamation
      // does not depend on elapsed wall time or shorten any live lease.
      await writeFile(lockPath, JSON.stringify({ ...abandoned, expiresAt: 0 }))
      expect((await stat(lockPath)).ino).toBe(inode)
      expect(JSON.parse(await readFile(lockPath, 'utf8')).ownerId).toBe(
        abandoned.ownerId,
      )
      const expected = point === 'after-write' ? target : previous
      expect((await readNativeMigrationJournal(paths))?.phase).toBe(expected)
      if (expected === 'committed' || expected === 'retired') {
        await requireNativePoolAuthority(paths)
      } else {
        await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
          code: expected ? 'migration-incomplete' : 'migration-required',
        })
      }
      // The successor reclaims the dead marker under normal lease settings.
      if (!previous) await beginNativeMigration(paths, input)
      else await advanceNativeMigration(paths, previous, target)
      for (let phase = index + 1; phase < phases.length; phase++) {
        const before = phases[phase - 1]
        const after = phases[phase]
        if (!before || !after) throw new Error('Invalid fixture stage')
        if (before === 'verified')
          await recordNativeMigrationExpectations(paths, expectations)
        await advanceNativeMigration(paths, before, after)
      }
      await requireNativePoolAuthority(paths)
      expect((await readNativeMigrationJournal(paths))?.phase).toBe('retired')
    })
  }
}

for (const point of ['before-write', 'after-write'] as const) {
  test(`real process exit ${point} at expectation rename preserves a complete pair and verified recovery`, async () => {
    const paths = await fixture()
    const input = captureInput(paths)
    await beginNativeMigration(paths, input)
    const verified = await advanceNativeMigration(paths, 'building', 'verified')
    const before = await readFile(paths.journal, 'utf8')
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL('./pool-authority-crash-child.ts', import.meta.url),
        ),
        dirname(paths.config),
        'expectations',
        point,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(19)
    const lockPath = `${paths.journal}.migration-journal.lock`
    const abandoned = JSON.parse(await readFile(lockPath, 'utf8'))
    expect(abandoned.ownerId).toEqual(expect.any(String))
    expect(abandoned.expiresAt).toEqual(expect.any(Number))
    const inode = (await stat(lockPath)).ino
    // The child has exited before we expire its migration-journal lock marker.
    // Change only expiry, preserving the owner identifier and inode, to test
    // abandoned-lock recovery without changing production renewal or leases.
    await writeFile(lockPath, JSON.stringify({ ...abandoned, expiresAt: 0 }))
    expect((await stat(lockPath)).ino).toBe(inode)
    expect(JSON.parse(await readFile(lockPath, 'utf8')).ownerId).toBe(
      abandoned.ownerId,
    )

    const text = await readFile(paths.journal, 'utf8')
    const raw = JSON.parse(text)
    expect(Object.keys(raw)).toHaveLength(11)
    expect(raw.phase).toBe('verified')
    expect([raw.expectedHostAuth, raw.expectedRouting]).toEqual(
      point === 'before-write'
        ? ['unprepared', 'unprepared']
        : ['d'.repeat(64), 'e'.repeat(64)],
    )
    if (point === 'before-write') expect(text).toBe(before)
    expect(await readNativeMigrationJournal(paths)).toEqual(
      point === 'before-write' ? verified : { ...verified, ...expectations },
    )
    await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
      code: 'migration-incomplete',
    })
    const stages = (await readdir(dirname(paths.journal))).filter(
      (name) =>
        name.startsWith(`${basename(paths.journal)}.`) && name.endsWith('.tmp'),
    )
    expect(stages).toHaveLength(point === 'before-write' ? 1 : 0)

    let writes = 0
    const recovered = await recordNativeMigrationExpectations(
      paths,
      expectations,
      {
        onWriteStep: async (step) => {
          if (step === 'after-write') writes++
        },
      },
    )
    expect(writes).toBe(point === 'before-write' ? 1 : 0)
    expect(recovered).toEqual({ ...verified, ...expectations })
    const recoveredBytes = await readFile(paths.journal, 'utf8')
    expect(
      await recordNativeMigrationExpectations(paths, expectations, {
        onWriteStep: async () => {
          throw new Error('Unexpected recovery retry write')
        },
      }),
    ).toEqual(recovered)
    expect(await beginNativeMigration(paths, input)).toEqual(recovered)
    expect(await readFile(paths.journal, 'utf8')).toBe(recoveredBytes)
    await advanceNativeMigration(paths, 'verified', 'activation-installed')
    await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
      code: 'migration-incomplete',
    })
    await advanceNativeMigration(paths, 'activation-installed', 'committed')
    await advanceNativeMigration(paths, 'committed', 'retired')
    await requireNativePoolAuthority(paths)
    expect(await readNativeMigrationJournal(paths)).toEqual({
      ...recovered,
      phase: 'retired',
    })
    // Abandoned temporary migration files remain in the directory; recovery
    // must use only the committed journal, not those files' contents.
    expect(
      (await readdir(dirname(paths.journal))).filter((name) =>
        stages.includes(name),
      ),
    ).toEqual(stages)
  })
}

test('expired successor lease refuses before publishing even while its owner bytes remain', async () => {
  const paths = await fixture()
  const input = captureInput(paths)
  let matchedOwnerAfterExpiry = false
  await expect(
    beginNativeMigration(paths, input, {
      lockOptions: { ttlMs: 100, timeoutMs: 3_000 },
      onWriteStep: async (step) => {
        if (step !== 'before-write') return
        const lockPath = `${paths.journal}.migration-journal.lock`
        const before = JSON.parse(await readFile(lockPath, 'utf8'))
        await Bun.sleep(Math.max(0, before.expiresAt - Date.now() + 1))
        const after = JSON.parse(await readFile(lockPath, 'utf8'))
        matchedOwnerAfterExpiry =
          before.ownerId === after.ownerId && after.expiresAt <= Date.now()
      },
    }),
  ).rejects.toMatchObject({ name: 'LockOwnershipError' })
  expect(matchedOwnerAfterExpiry).toBe(true)
  expect(await readNativeMigrationJournal(paths)).toBeUndefined()
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-required',
  })
  await beginNativeMigration(paths, input)
  expect((await readNativeMigrationJournal(paths))?.phase).toBe('building')
})

test('expired expectation publisher refuses without changing either verified expectation', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, captureInput(paths))
  await advanceNativeMigration(paths, 'building', 'verified')
  const before = await readFile(paths.journal, 'utf8')
  let matchedOwnerAfterExpiry = false
  await expect(
    recordNativeMigrationExpectations(paths, expectations, {
      lockOptions: { ttlMs: 100, timeoutMs: 3_000 },
      onWriteStep: async (step) => {
        if (step !== 'before-write') return
        const lockPath = `${paths.journal}.migration-journal.lock`
        const owner = JSON.parse(await readFile(lockPath, 'utf8'))
        await Bun.sleep(Math.max(0, owner.expiresAt - Date.now() + 1))
        const after = JSON.parse(await readFile(lockPath, 'utf8'))
        matchedOwnerAfterExpiry =
          owner.ownerId === after.ownerId && after.expiresAt <= Date.now()
      },
    }),
  ).rejects.toMatchObject({ name: 'LockOwnershipError' })
  expect(matchedOwnerAfterExpiry).toBe(true)
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
  expect(
    await recordNativeMigrationExpectations(paths, expectations),
  ).toMatchObject({ phase: 'verified', ...expectations })
})

async function retiredJournal(
  paths: NativePoolPaths,
  activation?: 'requested',
): Promise<void> {
  await beginNativeMigration(paths, {
    ...captureInput(paths),
    ...(activation ? { activation } : {}),
  })
  await advanceNativeMigration(paths, 'building', 'verified')
  await recordNativeMigrationExpectations(paths, expectations)
  await advanceNativeMigration(paths, 'verified', 'activation-installed')
  await advanceNativeMigration(paths, 'activation-installed', 'committed')
  await advanceNativeMigration(paths, 'committed', 'retired')
}

function activationPlan(): NativeCustodyActivationPlan {
  return {
    kind: 'activation',
    phase: 'prepared',
    primary: {
      routeId: 'main-route',
      credentialId: 'oauth:anthropic',
      accountIdentity: 'account-main',
    },
    roster: {
      version: 1,
      view: 'view-1',
      complete: true,
      rows: [
        {
          routeId: 'main-route',
          credentialId: 'oauth:anthropic',
          credentialType: 'oauth',
          accountIdentity: 'account-main',
          state: 'active',
          label: 'main-route',
          enabled: true,
          addedAt: 0,
        },
      ],
      declined: [],
    },
    localProof: {
      version: 1,
      rows: [
        {
          id: 'main-route',
          credentialEpoch: 1,
          identity: 'account-main',
          stamp: 'bound',
          credentialDigest: '1'.repeat(64),
        },
      ],
      runtimeDigest: '2'.repeat(64),
    },
    removeIds: ['main-route'],
    settings: { source: '3'.repeat(64), target: '4'.repeat(64) },
    runtime: { source: '5'.repeat(64), target: '6'.repeat(64) },
    hostAuth: { source: 'absent', expected: '7'.repeat(64) },
  }
}

test('older v3 native journals fail closed unchanged', async () => {
  const paths = await fixture()
  await retiredJournal(paths)
  const current = JSON.parse(await readFile(paths.journal, 'utf8'))
  const { activation: _activation, ...v3 } = { ...current, version: 3 }
  const text = JSON.stringify(v3)
  await writeFile(paths.journal, text, { mode: 0o600 })
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'invalid-journal',
  })
  for (const value of [
    { ...current, version: 3 },
    { ...v3, version: 4 },
  ]) {
    await writeFile(paths.journal, JSON.stringify(value), { mode: 0o600 })
    await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
      code: 'invalid-journal',
    })
  }
})

test('a requested vault activation keeps a retired migration unauthorized', async () => {
  const paths = await fixture()
  await retiredJournal(paths, 'requested')
  const journal = await readNativeMigrationJournal(paths)
  expect(journal?.phase).toBe('retired')
  expect(journal?.activation).toEqual({ kind: 'requested' })
  expect(nativeMigrationAuthorityPhase(journal)).toBeUndefined()
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  // Resuming a begin with a different activation request is a conflict.
  await expect(
    beginNativeMigration(paths, captureInput(paths)),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
})

test('activation phases block authority until committed and only move forward', async () => {
  const paths = await fixture()
  await retiredJournal(paths)
  await requireNativePoolAuthority(paths)
  const plan = activationPlan()
  await recordNativeCustodyActivation(paths, plan)
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  const prepared = await readFile(paths.journal, 'utf8')
  // An identical retry writes nothing; any other plan conflicts unchanged.
  await recordNativeCustodyActivation(paths, plan)
  expect(await readFile(paths.journal, 'utf8')).toBe(prepared)
  await expect(
    recordNativeCustodyActivation(paths, {
      ...plan,
      removeIds: [],
    }),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  await expect(
    advanceNativeCustodyActivation(paths, 'prepared', 'committed'),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(prepared)
  await advanceNativeCustodyActivation(paths, 'prepared', 'published')
  await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
    code: 'migration-incomplete',
  })
  await expect(
    advanceNativeCustodyActivation(paths, 'published', 'prepared'),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  await advanceNativeCustodyActivation(paths, 'published', 'committed')
  await requireNativePoolAuthority(paths)
  const committed = await readNativeMigrationJournal(paths)
  expect(nativeMigrationAuthorityPhase(committed)).toBe('retired')
  expect(committed?.activation).toMatchObject({ phase: 'committed' })
  // The completed migration history is kept, never reset.
  expect(committed?.preparedProof).toEqual(preparedProof)
  expect(committed?.expectedHostAuth).toBe(expectations.expectedHostAuth)
})

test('activation is recorded only on a retired migration', async () => {
  const paths = await fixture()
  await beginNativeMigration(paths, captureInput(paths))
  const before = await readFile(paths.journal, 'utf8')
  await expect(
    recordNativeCustodyActivation(paths, activationPlan()),
  ).rejects.toMatchObject({ code: 'journal-conflict' })
  expect(await readFile(paths.journal, 'utf8')).toBe(before)
})

test('closed activation decoder rejects incoherent or extra fields unchanged', async () => {
  const paths = await fixture()
  await retiredJournal(paths)
  await recordNativeCustodyActivation(paths, activationPlan())
  const journal = JSON.parse(await readFile(paths.journal, 'utf8'))
  const plan = journal.activation
  const invalid = [
    { ...journal, phase: 'committed' },
    { ...journal, activation: { ...plan, token: 'x' } },
    { ...journal, activation: { ...plan, phase: 'requested' } },
    { ...journal, activation: { ...plan, removeIds: ['unknown-row'] } },
    { ...journal, activation: { kind: 'requested', extra: true } },
    {
      ...journal,
      activation: {
        ...plan,
        primary: { ...plan.primary, credentialId: 'oauth:anthropic:other' },
      },
    },
    {
      ...journal,
      activation: {
        ...plan,
        roster: {
          ...plan.roster,
          rows: [{ ...plan.roster.rows[0], access: 'synthetic-access' }],
        },
      },
    },
    {
      ...journal,
      activation: { ...plan, hostAuth: { ...plan.hostAuth, expected: 'x' } },
    },
  ]
  for (const value of invalid) {
    const text = JSON.stringify(value)
    await writeFile(paths.journal, text, { mode: 0o600 })
    await expect(requireNativePoolAuthority(paths)).rejects.toMatchObject({
      code: 'invalid-journal',
    })
    expect(await readFile(paths.journal, 'utf8')).toBe(text)
  }
})
