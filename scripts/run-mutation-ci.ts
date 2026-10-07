import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const MUTATION_RUNNER_VERSION = 'ckdev-mutate 0.9.0'
export const MUTATION_RUNNER_REVISION =
  'dfdb11293eba0e5f03bd5d8e73c7c4b64dae1f73'

const forceAllPaths = new Set([
  'scripts/run-mutation-bun.ts',
  'scripts/tests/run-mutation-bun.test.ts',
  'scripts/run-mutation-ci.ts',
  'scripts/tests/run-mutation-ci.test.ts',
  '.github/workflows/mutations.yml',
  'package.json',
  'bun.lock',
  'mise.toml',
  'tsconfig.scripts.json',
  'packages/core/package.json',
  'packages/core/bunfig.toml',
  'packages/core/src/tests/setup.ts',
  'packages/core/src/tests/test-lifetime.ts',
  'bunfig.toml',
  'packages/pi/package.json',
  'packages/pi/bunfig.toml',
  'packages/pi/src/tests/setup.ts',
])

export function mutationSelection(
  event: string,
  base: string | undefined,
  changedPaths: readonly string[],
): string[] {
  switch (event) {
    case 'pull_request':
      if (!base || !/^[a-f0-9]{40}$/.test(base))
        throw new Error('Pull-request base must be a full commit SHA')
      // The runner follows row targets, not helper dependencies. Changes to
      // the wrapper, its tests or shared test configuration need all rows.
      return changedPaths.some((path) => forceAllPaths.has(path))
        ? ['--all']
        : ['--diff', base]
    case 'push':
      return ['--all']
    case 'schedule':
    case 'workflow_dispatch':
      return ['--all', '--broad']
    default:
      throw new Error('Unsupported mutation workflow event')
  }
}

export function verifyMutationReport(
  value: unknown,
  selection: readonly string[],
  expectedIds: readonly string[],
) {
  if (!Array.isArray(value)) throw new Error('Mutation report must be an array')
  if (!value.length && !selection.includes('--diff'))
    throw new Error('Full mutation replay produced no rows')
  const expected = new Set(expectedIds)
  if (!expected.size || expected.size !== expectedIds.length)
    throw new Error('Invalid catalogue row IDs')
  const ids = new Set<string>()
  for (const entry of value) {
    const row: unknown = entry
    if (
      !row ||
      typeof row !== 'object' ||
      !('id' in row) ||
      !('outcome' in row) ||
      !('breadth_observed' in row) ||
      typeof row.id !== 'string' ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.outcome !== 'string' ||
      !row.outcome ||
      typeof row.breadth_observed !== 'boolean'
    )
      throw new Error('Malformed or duplicate mutation report row')
    if (
      !expected.has(row.id) ||
      !['CAUGHT', 'CAUGHT_BROADLY', 'HUB'].includes(row.outcome)
    )
      throw new Error('Unexpected or uncaught mutation row')
    if (row.outcome === 'CAUGHT_BROADLY' && !row.breadth_observed)
      throw new Error('Broad catch is missing breadth evidence')
    if (selection.includes('--broad') && !row.breadth_observed)
      throw new Error('Requested mutation breadth was not observed')
    ids.add(row.id)
  }
  if (selection.includes('--all') && ids.size !== expected.size)
    throw new Error('Full replay omitted catalogue rows')
  return value.length
}

function git(args: string[]): string {
  const child = Bun.spawnSync(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (child.exitCode !== 0 || child.signalCode)
    throw new Error('Cannot verify committed mutation input')
  return child.stdout.toString()
}

if (import.meta.main) {
  try {
    if (Bun.version !== '1.3.14')
      throw new Error('Mutation CI requires Bun 1.3.14')
    if (process.env.GITHUB_ACTIONS !== 'true')
      throw new Error(
        'Mutation CI must run in an isolated GitHub Actions checkout',
      )
    const event = process.env.MUTATION_EVENT ?? ''
    const base = process.env.MUTATION_BASE
    git(['diff', '--exit-code', 'HEAD', '--'])
    const changed =
      event === 'pull_request'
        ? git([
            'diff',
            '--name-only',
            '-z',
            base && /^[a-f0-9]{40}$/.test(base) ? base : 'INVALID_BASE',
            'HEAD',
            '--',
          ])
            .split('\0')
            .filter(Boolean)
        : []
    const selection = mutationSelection(event, base, changed)
    const version = Bun.spawnSync(['ckdev-mutate', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (
      version.exitCode !== 0 ||
      version.signalCode ||
      version.stdout.toString().trim() !== MUTATION_RUNNER_VERSION
    )
      throw new Error(
        'Installed mutation runner does not match the pinned version',
      )
    const directory = resolve('tmp/mutations')
    await mkdir(directory, { recursive: true })
    const artifact = await mkdtemp(resolve(directory, 'ci-'))
    const report = resolve(artifact, 'rows.json')
    const argv = ['ckdev-mutate', 'run', ...selection, '--report', report]
    await writeFile(
      resolve(artifact, 'invocation.json'),
      JSON.stringify(
        {
          event,
          base,
          changed,
          argv,
          runnerRevision: MUTATION_RUNNER_REVISION,
        },
        null,
        2,
      ),
    )
    const child = Bun.spawn(argv, { stdout: 'inherit', stderr: 'inherit' })
    const status = await child.exited
    await writeFile(
      resolve(artifact, 'status.json'),
      JSON.stringify({ exitCode: status, signal: child.signalCode }),
    )
    if (status !== 0 || child.signalCode)
      throw new Error(
        'Mutation runner failed; inspect retained logs and report',
      )
    let value: unknown
    try {
      value = JSON.parse(await readFile(report, 'utf8'))
    } catch {
      throw new Error('Missing or invalid mutation JSON report')
    }
    const catalogue = Bun.TOML.parse(await readFile('mutations.toml', 'utf8'))
    if (!('control' in catalogue) || !Array.isArray(catalogue.control))
      throw new Error('Missing catalogue controls')
    const expectedIds = catalogue.control.map((entry: unknown) => {
      const control = entry
      if (
        !control ||
        typeof control !== 'object' ||
        !('id' in control) ||
        typeof control.id !== 'string'
      )
        throw new Error('Malformed catalogue control')
      return control.id
    })
    const rows = verifyMutationReport(value, selection, expectedIds)
    console.log(
      `Mutation CI passed: ${rows} selected rows; breadth ${selection.includes('--broad') ? 'observed' : 'not requested'}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mutation CI failed')
    process.exitCode = 1
  }
}
