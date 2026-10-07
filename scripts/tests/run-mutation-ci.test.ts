import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTestLifetimeSuite } from '../../packages/core/src/tests/test-lifetime.ts'
import {
  MUTATION_RUNNER_REVISION,
  MUTATION_RUNNER_VERSION,
  mutationSelection,
  verifyMutationReport,
} from '../run-mutation-ci.ts'

const base = 'a'.repeat(40)
const ids = ['history', 'fast', 'binding']
const caught = (id: string, broad = false) => ({
  id,
  outcome: 'CAUGHT',
  breadth_observed: broad,
})

test('PR target edits use the official committed diff selector', () => {
  expect(
    mutationSelection('pull_request', base, [
      'packages/core/src/request-history.ts',
    ]),
  ).toEqual(['--diff', base])
  expect(mutationSelection('pull_request', base, ['mutations.toml'])).toEqual([
    '--diff',
    base,
  ])
  expect(mutationSelection('pull_request', base, ['README.md'])).toEqual([
    '--diff',
    base,
  ])
})

test('wrapper and shared configuration changes force every row', () => {
  for (const path of [
    'scripts/run-mutation-bun.ts',
    'scripts/tests/run-mutation-bun.test.ts',
    'scripts/run-mutation-ci.ts',
    'scripts/tests/run-mutation-ci.test.ts',
    '.github/workflows/mutations.yml',
    'package.json',
    'bun.lock',
    'mise.toml',
    'packages/core/src/tests/setup.ts',
    'packages/core/src/tests/test-lifetime.ts',
    'bunfig.toml',
    'packages/pi/src/tests/setup.ts',
  ])
    expect(mutationSelection('pull_request', base, [path])).toEqual(['--all'])
})

test('main runs all named checks and scheduled or manual runs require breadth', () => {
  expect(mutationSelection('push', undefined, [])).toEqual(['--all'])
  expect(mutationSelection('schedule', undefined, [])).toEqual([
    '--all',
    '--broad',
  ])
  expect(mutationSelection('workflow_dispatch', undefined, [])).toEqual([
    '--all',
    '--broad',
  ])
})

test('unknown events and missing or injectable PR bases refuse', () => {
  expect(() => mutationSelection('pull_request_target', base, [])).toThrow()
  for (const invalid of [
    undefined,
    '',
    'main',
    '-HEAD',
    base + '; echo unsafe',
    'A'.repeat(40),
  ])
    expect(() =>
      mutationSelection('pull_request', invalid, [
        'scripts/run-mutation-bun.ts',
      ]),
    ).toThrow()
})

test('empty diff selections succeed, but full replays cannot omit rows', () => {
  expect(verifyMutationReport([], ['--diff', base], ids)).toBe(0)
  expect(verifyMutationReport([caught('fast')], ['--diff', base], ids)).toBe(1)
  expect(() => verifyMutationReport([], ['--all'], ids)).toThrow()
  expect(() => verifyMutationReport([caught('fast')], ['--all'], ids)).toThrow()
  expect(
    verifyMutationReport(
      ids.map((id) => caught(id)),
      ['--all'],
      ids,
    ),
  ).toBe(3)
})

test('missing reports, unknown IDs, duplicates and non-catches refuse', () => {
  for (const value of [
    null,
    {},
    [caught('other')],
    [caught('fast'), caught('fast')],
    [{ id: 'fast', outcome: 'SURVIVED', breadth_observed: false }],
    [{ id: 'fast', outcome: 'SKIPPED_PLATFORM', breadth_observed: false }],
    [{ id: 'fast', outcome: 'EQUIVALENT', breadth_observed: false }],
    [{ id: 'fast', outcome: 'ERROR', breadth_observed: false }],
    [{ id: 'fast', outcome: 'CAUGHT' }],
  ])
    expect(() => verifyMutationReport(value, ['--diff', base], ids)).toThrow()
  expect(() =>
    verifyMutationReport([], ['--diff', base], ['fast', 'fast']),
  ).toThrow()
})

test('nightly breadth is required on every reported row, not just one', () => {
  expect(() =>
    verifyMutationReport(
      [caught('history', true), caught('fast'), caught('binding', true)],
      ['--all', '--broad'],
      ids,
    ),
  ).toThrow()
  expect(
    verifyMutationReport(
      ids.map((id) => caught(id, true)),
      ['--all', '--broad'],
      ids,
    ),
  ).toBe(3)
  expect(() =>
    verifyMutationReport(
      [{ id: 'fast', outcome: 'CAUGHT_BROADLY', breadth_observed: false }],
      ['--diff', base],
      ids,
    ),
  ).toThrow()
})

test('workflow installs the public pinned runner without write permissions or secrets', () => {
  const text = readFileSync(
    new URL('../../.github/workflows/mutations.yml', import.meta.url),
    'utf8',
  )
  expect(text).toContain('contents: read')
  expect(text).toContain('persist-credentials: false')
  expect(text).toContain(`--rev ${MUTATION_RUNNER_REVISION}`)
  expect(text).toContain(MUTATION_RUNNER_VERSION.replace(' ', '-'))
  expect(text).toContain('bun install --frozen-lockfile')
  expect(text).toContain('if: always()')
  expect(text).not.toContain('pull_request_target')
  expect(text).not.toContain('secrets.')
})

const lifetimes = createTestLifetimeSuite()

async function ciFixture() {
  await mkdir(resolve(import.meta.dir, '../../tmp'), { recursive: true })
  const root = await mkdtemp(
    resolve(import.meta.dir, '../../tmp/mutation-ci-fixture-'),
  )
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  await mkdir(resolve(root, 'scripts'), { recursive: true })
  await mkdir(resolve(root, 'bin'), { recursive: true })
  await writeFile(
    resolve(root, 'scripts/run-mutation-ci.ts'),
    await readFile(new URL('../run-mutation-ci.ts', import.meta.url)),
  )
  await writeFile(
    resolve(root, 'mutations.toml'),
    ids.map((id) => `[[control]]\nid = "${id}"\n`).join('\n'),
  )
  await writeFile(resolve(root, 'README.md'), 'baseline\n')
  const binary = resolve(root, 'bin/ckdev-mutate')
  await writeFile(
    binary,
    `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
if(process.argv[2] === '--version') { console.log(process.env.FAKE_VERSION ?? 'ckdev-mutate 0.9.0'); process.exit(0) }
writeFileSync('runner-argv.json', JSON.stringify(process.argv.slice(2)))
const report = process.argv[process.argv.indexOf('--report') + 1]
const rows = process.env.FAKE_EMPTY === '1' ? [] : ['history','fast','binding'].map(id => ({ id, outcome:'CAUGHT', breadth_observed:process.argv.includes('--broad') }))
writeFileSync(report, process.env.FAKE_BAD_JSON === '1' ? 'invalid' : JSON.stringify(rows))
process.exit(process.env.FAKE_FAILURE === '1' ? 1 : 0)
`,
  )
  await chmod(binary, 0o700)
  const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined }
  for (const argv of [
    ['init', '-q'],
    ['add', '.'],
    [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'synthetic CI baseline',
    ],
  ]) {
    const child = Bun.spawnSync(['git', ...argv], {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode).toBe(0)
  }
  const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: root,
    env,
    stdout: 'pipe',
  })
    .stdout.toString()
    .trim()
  return { root, base, env }
}

function invokeCI(
  fixture: Awaited<ReturnType<typeof ciFixture>>,
  event: string,
  extra: Record<string, string | undefined> = {},
) {
  return Bun.spawnSync([process.execPath, 'scripts/run-mutation-ci.ts'], {
    cwd: fixture.root,
    env: {
      ...fixture.env,
      PATH: `${fixture.root}/bin:${process.env.PATH}`,
      GITHUB_ACTIONS: 'true',
      MUTATION_EVENT: event,
      MUTATION_BASE: fixture.base,
      ...extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

lifetimes.test(
  'real CLI driver preserves official diff argv in a clean synthetic repository',
  async () => {
    const fixture = await ciFixture()
    const result = invokeCI(fixture, 'pull_request')
    expect(result.exitCode).toBe(0)
    const argv = JSON.parse(
      await readFile(resolve(fixture.root, 'runner-argv.json'), 'utf8'),
    )
    expect(argv.slice(0, 3)).toEqual(['run', '--diff', fixture.base])
    expect(result.stdout.toString()).toContain(
      '3 selected rows; breadth not requested',
    )
  },
)

lifetimes.test(
  'real CLI driver records empty diff selection without claiming a catch',
  async () => {
    const fixture = await ciFixture()
    const result = invokeCI(fixture, 'pull_request', { FAKE_EMPTY: '1' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('0 selected rows')
  },
)

lifetimes.test(
  'real CLI driver rejects empty full replay, invalid report and runner failure',
  async () => {
    const fixture = await ciFixture()
    for (const extra of [
      { FAKE_EMPTY: '1' },
      { FAKE_BAD_JSON: '1' },
      { FAKE_FAILURE: '1' },
    ]) {
      const result = invokeCI(fixture, 'push', extra)
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).not.toContain('Mutation CI passed')
    }
  },
)

lifetimes.test(
  'real CLI driver validates broad mode and rejects dirty input or wrong binary',
  async () => {
    const fixture = await ciFixture()
    expect(invokeCI(fixture, 'schedule').exitCode).toBe(0)
    const argv = JSON.parse(
      await readFile(resolve(fixture.root, 'runner-argv.json'), 'utf8'),
    )
    expect(argv.slice(0, 3)).toEqual(['run', '--all', '--broad'])
    expect(
      invokeCI(fixture, 'push', { FAKE_VERSION: 'ckdev-mutate 0.8.0' })
        .exitCode,
    ).toBe(1)
    await writeFile(resolve(fixture.root, 'README.md'), 'uncommitted change\n')
    expect(invokeCI(fixture, 'push').exitCode).toBe(1)
  },
)

test('parsed workflow has isolated read-only PR/main/nightly jobs and retained artifacts', () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL('../../.github/workflows/mutations.yml', import.meta.url),
      'utf8',
    ),
  )
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  if (
    !record(workflow) ||
    !record(workflow.on) ||
    !record(workflow.permissions) ||
    !record(workflow.jobs)
  )
    throw new Error('Invalid mutation workflow')
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(Object.keys(workflow.on).sort()).toEqual([
    'pull_request',
    'push',
    'schedule',
    'workflow_dispatch',
  ])
  if (!record(workflow.on.push)) throw new Error('Missing main trigger')
  expect(workflow.on.push.branches).toEqual(['main'])
  expect(Array.isArray(workflow.on.schedule)).toBe(true)
  const job = workflow.jobs.guards
  if (!record(job) || !Array.isArray(job.steps) || !record(job.env))
    throw new Error('Invalid mutation job')
  expect(job.env.MUTATION_EVENT).toBe('${{ github.event_name }}')
  expect(job.env.MUTATION_BASE).toBe(
    '${{ github.event.pull_request.base.sha }}',
  )
  const steps: unknown[] = job.steps
  const checkout = steps.find(
    (step) =>
      record(step) &&
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/checkout@'),
  )
  if (!record(checkout) || !record(checkout.with))
    throw new Error('Missing isolated checkout')
  expect(checkout.with['fetch-depth']).toBe(0)
  expect(checkout.with['persist-credentials']).toBe(false)
  const upload = steps.find(
    (step) =>
      record(step) &&
      typeof step.uses === 'string' &&
      step.uses.startsWith('actions/upload-artifact@'),
  )
  if (!record(upload) || !record(upload.with))
    throw new Error('Missing artifact retention')
  expect(upload.if).toBe('always()')
  expect(upload.with.path).toBe('tmp/mutations/')
})
