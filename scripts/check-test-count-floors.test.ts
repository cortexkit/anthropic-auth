import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, 'check-test-count-floors.ts')
const workspaces: string[] = []

type Floors = Record<'core' | 'opencode' | 'pi', number>

type LoweringMarker = {
  reason: string
  lowering: Partial<
    Record<'core' | 'opencode' | 'pi', { from: number; to: number }>
  >
}

function runGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Runner',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Runner',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr))
  }
  return new TextDecoder().decode(result.stdout).trim()
}

async function writeFloors(
  cwd: string,
  floors: Floors,
  measurement: { head: string; dirtyPaths: number },
) {
  await mkdir(join(cwd, '.ci'), { recursive: true })
  await writeFile(
    join(cwd, '.ci', 'test-count-floors.json'),
    `${JSON.stringify({ floors, measurement }, null, 2)}\n`,
  )
}

async function makeStaleBranch(
  baseFloors: Floors,
  staleFloors: Floors,
  marker?: LoweringMarker,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'test-count-floor-'))
  workspaces.push(cwd)

  runGit(cwd, ['init', '--initial-branch=main'])
  runGit(cwd, ['commit', '--allow-empty', '-m', 'seed measurement subject'])
  const staleMeasurementHead = runGit(cwd, ['rev-parse', 'HEAD'])
  await writeFloors(cwd, staleFloors, {
    head: staleMeasurementHead,
    dirtyPaths: 0,
  })
  runGit(cwd, ['add', '.ci/test-count-floors.json'])
  runGit(cwd, ['commit', '-m', 'record stale floors'])
  runGit(cwd, ['branch', 'stale'])

  if (JSON.stringify(baseFloors) !== JSON.stringify(staleFloors)) {
    await writeFloors(cwd, baseFloors, {
      head: runGit(cwd, ['rev-parse', 'HEAD']),
      dirtyPaths: 0,
    })
    runGit(cwd, ['add', '.ci/test-count-floors.json'])
    runGit(cwd, ['commit', '-m', 'raise main floor'])
  }
  runGit(cwd, ['checkout', 'stale'])

  if (marker) {
    await writeFile(
      join(cwd, '.ci', 'allow-test-count-floor-lowering.json'),
      `${JSON.stringify(marker, null, 2)}\n`,
    )
    runGit(cwd, ['add', '.ci/allow-test-count-floor-lowering.json'])
    runGit(cwd, ['commit', '-m', 'authorize floor lowering'])
  }

  return cwd
}

function runGate(cwd: string, counts: Floors, baseRef = 'main') {
  const result = Bun.spawnSync(
    [
      'bun',
      script,
      '--floor-file',
      '.ci/test-count-floors.json',
      '--base-ref',
      baseRef,
      '--counts',
      JSON.stringify(counts),
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  }
}

function runGateWithCounts(cwd: string, counts: string, baseRef = 'main') {
  const result = Bun.spawnSync(
    [
      'bun',
      script,
      '--floor-file',
      '.ci/test-count-floors.json',
      '--base-ref',
      baseRef,
      '--counts',
      counts,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  return {
    exitCode: result.exitCode,
    output: `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`,
  }
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true })),
  )
})

test('passes when counts equal the branch floors', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, floors)

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain(
    'VERDICT: PASS packages=core,opencode,pi (test counts and floor ratchet satisfied)',
  )
})

test('passes when counts exceed the branch floors', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, { core: 11, opencode: 21, pi: 31 })

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('VERDICT: PASS')
})

test('fails when a measured count falls below its branch floor', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, { core: 9, opencode: 20, pi: 30 })

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('core measured 9 < branch floor 10')
  expect(result.output).toContain('VERDICT: FAIL packages=core,opencode,pi')
})

test('fails when the branch floor is lower than the merge target floor', async () => {
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    { core: 10, opencode: 20, pi: 30 },
  )
  const result = runGate(cwd, { core: 10, opencode: 20, pi: 30 })

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain(
    'core branch floor 10 < merge target floor 11',
  )
})

test('passes an explicit lowering marker that names the target floor', async () => {
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    { core: 10, opencode: 20, pi: 30 },
    {
      reason: 'The core suite intentionally removed obsolete coverage.',
      lowering: { core: { from: 11, to: 10 } },
    },
  )
  const result = runGate(cwd, { core: 10, opencode: 20, pi: 30 })

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('deliberate lowering authorized')
})

test('reports an unchecked non-zero verdict when the merge target is unavailable', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, floors, 'missing-target')

  expect(result.exitCode).toBe(2)
  expect(result.output).toContain(
    'VERDICT: UNCHECKED packages=core,opencode,pi',
  )
})

test('reports an unchecked verdict when CI supplies an empty merge target', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGate(cwd, floors, '')

  expect(result.exitCode).toBe(2)
  expect(result.output).toContain(
    'VERDICT: UNCHECKED packages=core,opencode,pi',
  )
})

test('reports an unchecked verdict for a floor stamped by an unrelated commit', async () => {
  const staleFloors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    staleFloors,
  )
  await writeFloors(cwd, staleFloors, {
    head: runGit(cwd, ['rev-parse', 'main']),
    dirtyPaths: 0,
  })
  const result = runGate(cwd, staleFloors)

  expect(result.exitCode).toBe(2)
  expect(result.output).toContain('VERDICT: UNCHECKED')
  expect(result.output).toContain('not an ancestor')
})

test('allows the gate to run from a dirty working tree', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  await writeFile(join(cwd, 'uncommitted-note'), 'local work is allowed\n')
  const result = runGate(cwd, floors)

  expect(result.exitCode).toBe(0)
  expect(result.output).toContain('VERDICT: PASS')
})

test('fails as a noncompliant source when the branch floor file is absent', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  await rm(join(cwd, '.ci', 'test-count-floors.json'))
  const result = runGate(cwd, floors)

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain(
    'VERDICT: FAIL packages=none (NONCOMPLIANT SOURCE',
  )
})

test('does not pass when no packages are evaluated', async () => {
  const floors = { core: 10, opencode: 20, pi: 30 }
  const cwd = await makeStaleBranch(floors, floors)
  const result = runGateWithCounts(cwd, '{}')

  expect(result.exitCode).toBe(1)
  expect(result.output).toContain('VERDICT: FAIL packages=none')
  expect(result.output).not.toContain('VERDICT: PASS')
})

test('replays a stale branch after main raises the floor and rejects the replay', async () => {
  const cwd = await makeStaleBranch(
    { core: 11, opencode: 20, pi: 30 },
    { core: 10, opencode: 20, pi: 30 },
  )
  const branch = Bun.spawnSync(['git', 'branch', '--show-current'], {
    cwd,
    stdout: 'pipe',
  })
  const result = runGate(cwd, { core: 10, opencode: 20, pi: 30 })

  expect(new TextDecoder().decode(branch.stdout).trim()).toBe('stale')
  expect(result.exitCode).toBe(1)
  expect(result.output).toContain(
    'core branch floor 10 < merge target floor 11',
  )
})
