import { expect } from 'bun:test'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import {
  createTestLifetimeSuite,
  type TestGate,
  TestLifetime,
} from '../../core/src/tests/test-lifetime'
import { seedOpencodeConfigDependencies } from '../../e2e-tests/src/opencode-runner'
import { checkBundleGlobals } from './check-bundle-globals'

const { test, gate, trackDetached } = createTestLifetimeSuite()

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-bundle-check-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const body = (name = '__anthropicAuthRpcServers') =>
  `export const registry = ${JSON.stringify(name)};\n/*${'padding'.repeat(200)}*/`

test('a small entry is valid when its imported chunk contains the implementation', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, 'index.js'),
      'export { registry } from "./shared.js"',
    )
    await writeFile(join(root, 'shared.js'), body())
    await expect(
      checkBundleGlobals(join(root, 'index.js')),
    ).resolves.toBeUndefined()
  })
})

interface PhaseClock {
  phases: Record<string, { at: string; elapsedMs: number }>
  mark(name: string): void
}
interface StandInRun {
  root: string
  env: Record<string, string>
  result: { stdout: string; stderr: string; exit: number }
}
interface CapturedHostHarness {
  installation: PhaseClock
  secrets: string[]
  command(
    args: string[],
    cwd: string,
    env: Record<string, string>,
    limit: number,
    cancellation: TestGate,
    timing: { clock: PhaseClock; name: string },
  ): Promise<StandInRun['result']>
  withScenario(args: string[], body: (run: StandInRun) => void): Promise<void>
  phaseClock(): PhaseClock
  stopServers(
    upstream: { stop(force: boolean): unknown },
    relay: { stop(force: boolean): unknown },
    clock: PhaseClock,
  ): Promise<void>
}

/**
 * Read the real-host E2E source and return the named top-level declarations
 * as runnable code. Evaluating current source, rather than importing the E2E
 * module, never registers its real-host installation and execution hooks.
 */
async function captureDeclarations(wanted: string[]) {
  const source = await readFile(
    resolve(import.meta.dir, '../src/tests/opencode2-e2e.test.ts'),
    'utf8',
  )
  const program = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
  }).program
  const names = new Set(wanted)
  const declarations: string[] = []
  const slice = (node: { start?: number | null; end?: number | null }) => {
    if (node.start == null || node.end == null)
      throw new Error('Missing source range')
    return source.slice(node.start, node.end)
  }
  for (const node of program.body) {
    const name =
      node.type === 'FunctionDeclaration'
        ? node.id?.name
        : node.type === 'VariableDeclaration' &&
            node.declarations[0]?.id.type === 'Identifier'
          ? node.declarations[0].id.name
          : undefined
    if (name && names.delete(name)) declarations.push(slice(node))
  }
  if (names.size)
    throw new Error(`Missing host declarations: ${[...names].join(', ')}`)
  const scenario = program.body.find(
    (node) =>
      node.type === 'FunctionDeclaration' && node.id?.name === 'scenario',
  )
  if (scenario?.type !== 'FunctionDeclaration')
    throw new Error('Missing scenario declaration')
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    declarations.join('\n'),
  )
  return { code, scenario: scenario.body.body, slice }
}

async function captureHostHarness(bindings: Record<string, unknown>) {
  const { code, scenario, slice } = await captureDeclarations([
    'TOKEN',
    'PASSWORD',
    'phaseClock',
    'installation',
    'redactFixtureSecrets',
    'hostLogDirectory',
    'hostBootstrapReport',
    'command',
    'withScenario',
  ])
  // scenario() also defers removal of its root directory, so select the
  // cleanup that stops the synthetic upstream and relay servers.
  const cleanup = scenario.find(
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'CallExpression' &&
      node.expression.callee.type === 'Identifier' &&
      node.expression.callee.name === 'deferCleanup' &&
      slice(node).includes('relay.stop'),
  )
  if (
    cleanup?.type !== 'ExpressionStatement' ||
    cleanup.expression.type !== 'CallExpression'
  )
    throw new Error('Missing server cleanup registration')
  const callback = cleanup.expression.arguments[0]
  if (callback?.type !== 'ArrowFunctionExpression')
    throw new Error('Missing server cleanup callback')

  return new Function(
    'bindings',
    `
    const { Bun, mkdir, readFile, readdir, rm, writeFile, join, children, cli, oc1,
      trackDetached, deferCleanup, scenario, console, setTimeout, clearTimeout } = bindings;
    ${code}
    return { installation, command, withScenario, phaseClock,
      secrets: [TOKEN, PASSWORD, 'synthetic-refresh', 'relay-disposable-only'],
      stopServers: (upstream, relay, clock) => (${slice(callback)})() };
  `,
  )(bindings) as CapturedHostHarness
}

function withPrivateLifetime(
  run: (
    root: string,
    lifetime: TestLifetime,
    cancellation: TestGate,
  ) => Promise<void>,
) {
  return async (root: string) => {
    const lifetime = new TestLifetime()
    const cancellation = gate()
    const completed = Promise.withResolvers<void>()
    let finished = false
    const cancelWork = Promise.race([
      cancellation.wait,
      completed.promise,
    ]).then(async () => {
      if (!finished) await lifetime.finish()
    })
    trackDetached(cancelWork)
    try {
      await run(root, lifetime, cancellation)
    } finally {
      // The owning timeout must cancel the private child before joining it;
      // fixture removal waits for the private lifetime and cancellation hook.
      try {
        await lifetime.finish()
      } finally {
        finished = true
        completed.resolve()
        await cancelWork
      }
    }
  }
}

async function standInHost(
  mode: 'healthy' | 'failed' | 'cancelled' | 'deadline',
) {
  let evidence:
    | {
        output: string[]
        events: string[]
        failed: boolean
        childrenLeft: number
        timerDelays: number[]
        secrets: string[]
      }
    | undefined
  const run = withPrivateLifetime(async (root, lifetime, cancellation) => {
    const children = new Set<Bun.Subprocess>()
    const output: string[] = []
    const events: string[] = []
    const ready = Promise.withResolvers<void>()
    const timerDelays: number[] = []
    let deadline: (() => void) | undefined
    let stdoutTail = ''
    let spawned = false
    const observingBun = {
      spawn(
        args: string[],
        options: {
          cwd: string
          env: Record<string, string>
          stdout: 'pipe'
          stderr: 'pipe'
        },
      ) {
        const child = Bun.spawn(args, options)
        spawned = true
        const observe = (stream: ReadableStream<Uint8Array>, name: string) =>
          stream.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                if (name === 'stdout') {
                  stdoutTail = (
                    stdoutTail + new TextDecoder().decode(chunk)
                  ).slice(-100)
                  if (stdoutTail.includes('READY_FOR_CANCELLATION'))
                    ready.resolve()
                }
                controller.enqueue(chunk)
              },
              flush() {
                events.push(`${name}.drained`)
              },
            }),
          )
        const stdout = observe(child.stdout, 'stdout')
        const stderr = observe(child.stderr, 'stderr')
        return new Proxy(child, {
          get(target, key) {
            if (key === 'stdout') return stdout
            if (key === 'stderr') return stderr
            const value = Reflect.get(target, key, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
      },
    }
    let harness: CapturedHostHarness
    harness = await captureHostHarness({
      Bun: observingBun,
      mkdir,
      readFile,
      readdir,
      rm,
      writeFile,
      join,
      children,
      cli: process.execPath,
      oc1: '',
      trackDetached: (work: Promise<unknown>) => lifetime.trackDetached(work),
      deferCleanup: (cleanup: () => Promise<void>) =>
        lifetime.deferCleanup(cleanup),
      console: {
        error(message: string) {
          if (children.size) throw new Error('Reported before child drainage')
          events.push('report')
          output.push(message)
        },
      },
      setTimeout:
        mode === 'deadline'
          ? (callback: () => void, delay: number) => {
              deadline = callback
              timerDelays.push(delay)
              return 1
            }
          : globalThis.setTimeout,
      clearTimeout: mode === 'deadline' ? () => {} : globalThis.clearTimeout,
      scenario: async (
        _args: string[],
        clock: PhaseClock,
      ): Promise<StandInRun> => {
        const scenarioRoot = join(root, 'scenario')
        const env = {
          TMPDIR: join(scenarioRoot, 'tmp'),
          PATH: process.env.PATH ?? '',
        }
        await mkdir(env.TMPDIR, { recursive: true })
        clock.mark('fixture.start')
        const hold = mode === 'cancelled' || mode === 'deadline'
        const script = `
          await Bun.write(Bun.stdout, ${JSON.stringify(harness.secrets.join('\n'))} + '\\n' + 'x'.repeat(65536) + '\\nSTDOUT_DRAINED\\n');
          await Bun.write(Bun.stderr, ${JSON.stringify(harness.secrets.join('\n'))} + '\\n' + 'y'.repeat(65536) + '\\nSTDERR_DRAINED\\n');
          ${hold ? "setInterval(() => {}, 1000); console.log('READY_FOR_CANCELLATION');" : `process.exit(${mode === 'failed' ? 7 : 0});`}
        `
        const result = await harness.command(
          [process.execPath, '-e', script],
          root,
          env,
          60_000,
          lifetime.gate(),
          { clock, name: 'host' },
        )
        return { root: scenarioRoot, env, result }
      },
    })
    lifetime.deferCleanup(() => {
      if (
        children.size ||
        (spawned &&
          (!events.includes('stdout.drained') ||
            !events.includes('stderr.drained')))
      )
        throw new Error(
          'Private stand-in lifetime did not drain its child and pipes',
        )
      events.push('private.drained')
    })
    harness.installation.mark('dependencies.start')
    harness.installation.mark('dependencies.ready')
    const body = lifetime
      .runBody(() =>
        harness.withScenario(['direct'], (run) => {
          if (run.result.exit !== 0) throw new Error('Stand-in child failed')
        }),
      )
      .then(
        () => false,
        () => true,
      )
    const waitForReady = () =>
      Promise.race([
        ready.promise,
        body.then(() => {
          throw new Error('Stand-in child ended before readiness')
        }),
        cancellation.wait.then(() => {
          throw new Error('Owning test cancelled before stand-in readiness')
        }),
      ])
    if (mode === 'cancelled') {
      await waitForReady()
      await lifetime.finish()
    } else if (mode === 'deadline') {
      await waitForReady()
      // Fire the callback scheduled for the unchanged 60-second deadline;
      // no earlier watchdog or host process is needed for this branch.
      if (!deadline) throw new Error('Command did not schedule its deadline')
      deadline()
    }
    const failed = await body
    await lifetime.finish()
    evidence = {
      output,
      events,
      failed,
      childrenLeft: children.size,
      timerDelays,
      secrets: harness.secrets,
    }
  })
  await fixture(run)
  if (!evidence) throw new Error('Stand-in evidence missing')
  return evidence
}

test('an unrelated chunk cannot supply the registry positive control', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), body('not-the-registry'))
    await writeFile(join(root, 'unrelated.js'), body())
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'positive-control',
    )
  })
})

test('a stale singleton in an imported chunk is refused', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./shared.js"')
    await writeFile(
      join(root, 'shared.js'),
      `${body()}\nexport const stale = "__anthropicAuthRpcServer"`,
    )
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'stale-global',
    )
  })
})

test('a missing imported chunk refuses the artifact', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./missing.js"')
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'missing',
    )
  })
})

test('a chunk cycle is checked once without hiding a stale singleton', async () => {
  await fixture(async (root) => {
    await writeFile(join(root, 'index.js'), 'import "./shared.js"')
    await writeFile(
      join(root, 'shared.js'),
      `import "./index.js";\n${body()}\nexport const stale = "__anthropicAuthRpcServer"`,
    )
    await expect(checkBundleGlobals(join(root, 'index.js'))).rejects.toThrow(
      'stale-global',
    )
  })
})

test('a fresh packed prefix resolves the RPC client alongside server and TUI', async () => {
  await fixture(async (root) => {
    const packageRoot = resolve(import.meta.dir, '..')
    await Bun.$`${process.execPath} pm pack --destination ${root}`
      .cwd(packageRoot)
      .quiet()
    const archives = (await readdir(root)).filter((name) =>
      name.endsWith('.tgz'),
    )
    expect(archives).toHaveLength(1)
    const prefix = join(root, 'prefix')
    const packed = join(
      prefix,
      'node_modules/@cortexkit/opencode-anthropic-auth',
    )
    await mkdir(packed, { recursive: true })
    await Bun.$`tar -xzf ${join(root, archives[0]!)} -C ${packed} --strip-components=1`.quiet()
    const manifest = JSON.parse(
      await readFile(join(packed, 'package.json'), 'utf8'),
    )

    // Resolve from an extracted archive outside the workspace, so a source
    // alias or workspace link cannot conceal a missing packed export.
    const probe = join(prefix, 'resolve.mjs')
    await writeFile(
      probe,
      `for (const subpath of ['rpc', 'server', 'tui']) console.log(import.meta.resolve('@cortexkit/opencode-anthropic-auth/' + subpath));`,
    )
    const result = await Bun.$`${process.execPath} ${probe}`.cwd(prefix).quiet()
    const entries = result
      .text()
      .trim()
      .split('\n')
      .map((entry) => fileURLToPath(entry))
    expect(entries).toEqual([
      join(packed, 'dist/rpc/rpc-client.js'),
      join(packed, 'dist/v2/server.js'),
      join(packed, 'src/tui/entry.mjs'),
    ])
    for (const entry of entries)
      expect((await readFile(entry, 'utf8')).length).toBeGreaterThan(0)
    expect(manifest.exports['./rpc']).toEqual({
      types: './dist/rpc/rpc-client.d.ts',
      import: './dist/rpc/rpc-client.js',
    })
    expect(manifest['oc-plugin']).toEqual(['server', 'tui'])
    expect(await readFile(entries[0]!, 'utf8')).toContain('createRpcClient')
    expect(
      await readFile(join(packed, manifest.exports['./rpc'].types), 'utf8'),
    ).toContain('createRpcClient')
  })
})

function assertFailedStandIn(
  evidence: Awaited<ReturnType<typeof standInHost>>,
) {
  expect(evidence.failed).toBe(true)
  expect(evidence.childrenLeft).toBe(0)
  const report = JSON.parse(evidence.output[0]!) as {
    phaseClocks: {
      installation: PhaseClock['phases']
      scenario: PhaseClock['phases']
    }
  }
  for (const name of ['dependencies.start', 'dependencies.ready'])
    expect(report.phaseClocks.installation[name]?.at).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    )
  for (const name of ['host.start', 'host.exit'])
    expect(report.phaseClocks.scenario[name]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(evidence.events.indexOf('stdout.drained')).toBeLessThan(
    evidence.events.indexOf('report'),
  )
  expect(evidence.events.indexOf('stderr.drained')).toBeLessThan(
    evidence.events.indexOf('report'),
  )
  expect(evidence.events).toContain('stdout.drained')
  expect(evidence.events).toContain('stderr.drained')
  const output = evidence.output.join('\n')
  expect(output).toContain('STDOUT_DRAINED')
  expect(output).toContain('STDERR_DRAINED')
  expect(output).toContain('[redacted]')
  for (const secret of evidence.secrets) expect(output).not.toContain(secret)
  return report.phaseClocks.scenario
}

test('captured host phase reporting stays quiet for a healthy real child', async () => {
  const evidence = await standInHost('healthy')
  expect(evidence.failed).toBe(false)
  expect(evidence.childrenLeft).toBe(0)
  expect(evidence.events).toContain('stdout.drained')
  expect(evidence.events).toContain('stderr.drained')
  expect(evidence.output).toEqual([])
})

test('captured host phase reporting includes failed child clocks and redacts fixture secrets', async () => {
  const phases = assertFailedStandIn(await standInHost('failed'))
  expect(phases['host.cancelled']).toBeUndefined()
  expect(phases['host.deadline']).toBeUndefined()
})

test('captured host cancellation reports only after real child pipes drain', async () => {
  const phases = assertFailedStandIn(await standInHost('cancelled'))
  expect(phases['host.cancelled']).toBeDefined()
  expect(phases['host.deadline']).toBeUndefined()
})

test('captured host scheduled deadline reports only after real child pipes drain', async () => {
  const evidence = await standInHost('deadline')
  const phases = assertFailedStandIn(evidence)
  expect(evidence.timerDelays).toEqual([60_000])
  expect(phases['host.deadline']).toBeDefined()
  expect(phases['host.cancelled']).toBeUndefined()
})

test('captured scenario cleanup drains both server stops before reporting failure', async () => {
  const harness = await captureHostHarness({})
  const relayStarted = Promise.withResolvers<void>()
  const relayStopped = Promise.withResolvers<void>()
  const events: string[] = []
  const clock = harness.phaseClock()
  const stopping = harness
    .stopServers(
      {
        stop(force) {
          expect(force).toBe(true)
          events.push('upstream.stop')
          throw new Error('private transport exception')
        },
      },
      {
        async stop(force) {
          expect(force).toBe(true)
          events.push('relay.stop')
          relayStarted.resolve()
          await relayStopped.promise
          events.push('relay.drained')
        },
      },
      clock,
    )
    .then(
      () => undefined,
      (error: unknown) => {
        events.push('failure.report')
        return error
      },
    )
  try {
    await Promise.race([relayStarted.promise, stopping.then(() => {})])
    expect(events).toEqual(['upstream.stop', 'relay.stop'])
  } finally {
    relayStopped.resolve()
    await stopping
  }
  const error = await stopping
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toContain(
    'Synthetic transport cleanup failed (details redacted)',
  )
  expect(String(error)).not.toContain('private transport exception')
  expect(events).toEqual([
    'upstream.stop',
    'relay.stop',
    'relay.drained',
    'failure.report',
  ])
  expect(clock.phases['fixture.cleanup_failure']).toBeDefined()
})

interface CapturedOc1Bootstrap {
  PACKAGE: string
  secrets: string[]
  seedOc1Bootstrap(
    root: string,
    project: string,
    env: Record<string, string>,
    plugin: string,
    dependencies: { fixture: string; version: string },
  ): Promise<string[]>
  hostBootstrapReport(env: Record<string, string>): Promise<string[]>
}

/**
 * Capture the OC1 startup seeding and failure report from the real-host E2E
 * source, with the shared config-dependency helper it calls. Refuse a
 * scenario that does not seed OC1 before it starts the host command.
 */
async function captureOc1Bootstrap() {
  const { code, scenario, slice } = await captureDeclarations([
    'PACKAGE',
    'TOKEN',
    'PASSWORD',
    'redactFixtureSecrets',
    'seedOc1Bootstrap',
    'hostBootstrapReport',
  ])
  const seedAt = scenario.findIndex(
    (node) =>
      node.type === 'IfStatement' &&
      slice(node.test) === "host === 'oc1'" &&
      slice(node.consequent).includes('seedOc1Bootstrap('),
  )
  const hostAt = scenario.findIndex(
    (node) =>
      node.type === 'VariableDeclaration' &&
      slice(node).includes("name: 'host'"),
  )
  if (seedAt < 0 || hostAt < 0 || seedAt > hostAt)
    throw new Error('The E2E scenario does not seed OC1 before starting it')
  return new Function(
    'bindings',
    `
    const { cp, readFile, readdir, join, seedOpencodeConfigDependencies } = bindings;
    ${code}
    return { PACKAGE, seedOc1Bootstrap, hostBootstrapReport,
      secrets: [TOKEN, PASSWORD, 'synthetic-refresh', 'relay-disposable-only'] };
  `,
  )({
    cp,
    readFile,
    readdir,
    join,
    seedOpencodeConfigDependencies,
  }) as CapturedOc1Bootstrap
}

/**
 * OpenCode 1.18.31 skips installing @opencode-ai/plugin into a config
 * directory only when node_modules exists and the package-lock.json root
 * names every dependency the manifest declares, plus the SDK itself
 * (Npm.install in packages/core/src/npm.ts of opencode v1.18.31). Otherwise
 * it installs from the registry, which these isolated fixtures cannot reach.
 */
async function opencode1WouldSkipInstall(dir: string) {
  const exists = await lstat(join(dir, 'node_modules')).then(
    () => true,
    () => false,
  )
  if (!exists) return false
  const json = (name: string) =>
    readFile(join(dir, name), 'utf8').then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      () => ({}) as Record<string, unknown>,
    )
  const names = (value: Record<string, unknown> | undefined) =>
    [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ].flatMap((field) =>
      Object.keys((value?.[field] as Record<string, string> | undefined) ?? {}),
    )
  const lock = (await json('package-lock.json')) as {
    packages?: Record<string, Record<string, unknown>>
  }
  const locked = new Set(names(lock.packages?.['']))
  return [...names(await json('package.json')), '@opencode-ai/plugin'].every(
    (name) => locked.has(name),
  )
}

// The genuine npm-installed OC1 1.19.5 SDK tree the process E2E suite uses.
// Its committed manifest and lockfile are always present; the runner must
// provision node_modules from that lockfile before this suite runs.
const genuineConfigDeps = resolve(
  import.meta.dir,
  '../../e2e-tests/fixtures/opencode1-config-deps',
)

/** Every symlink under `directory`, with its target exactly as written. */
async function symlinksUnder(directory: string) {
  const links: { path: string; target: string }[] = []
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  }))
    if (entry.isSymbolicLink()) {
      const path = join(entry.parentPath, entry.name)
      links.push({ path, target: await readlink(path) })
    }
  return links
}
/**
 * Seeding copies symlinks verbatim, so each must be relative and resolve
 * inside `root`. An absolute or escaping link would point the scenario at
 * files outside the directory the test body removes.
 */
function expectLinksOwnedBy(
  root: string,
  links: { path: string; target: string }[],
) {
  for (const link of links) {
    expect(isAbsolute(link.target)).toBe(false)
    const inside = relative(root, resolve(dirname(link.path), link.target))
    expect(inside.startsWith('..') || inside.startsWith(sep)).toBe(false)
  }
}

/** An OC1 scenario root with every kind of config directory OC1 reads. */
async function oc1Layout(root: string, pkg: string) {
  const env = {
    PATH: '',
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    TMPDIR: join(root, 'tmp'),
  }
  const project = join(root, 'project')
  const configDirectories = [
    join(env.XDG_CONFIG_HOME, 'opencode'),
    join(project, '.opencode'),
    join(env.HOME, '.opencode'),
  ]
  for (const directory of [
    ...configDirectories,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
    env.TMPDIR,
  ])
    await mkdir(directory, { recursive: true })
  const packed = join(project, 'node_modules', pkg)
  await mkdir(packed, { recursive: true })
  await writeFile(
    join(packed, 'package.json'),
    JSON.stringify({ name: pkg, version: '0.0.0-packed' }),
  )
  // npm links package binaries with relative .bin symlinks; give the packed
  // stand-in one so the cache copy is checked for owned links too.
  await mkdir(join(packed, 'dist'))
  await writeFile(join(packed, 'dist', 'cli.js'), '')
  await mkdir(join(project, 'node_modules', '.bin'))
  await symlink(
    join('..', pkg, 'dist', 'cli.js'),
    join(project, 'node_modules', '.bin', 'opencode-anthropic-auth'),
  )
  const cachedPlugin = join(
    env.XDG_CACHE_HOME,
    'opencode',
    'packages',
    `${pkg}@latest`,
    'node_modules',
    pkg,
    'package.json',
  )
  return { env, project, configDirectories, cachedPlugin }
}

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )

test('captured OC1 seeding gives every config directory and the plugin cache a complete installed tree', async () => {
  const installed = join(
    genuineConfigDeps,
    'node_modules',
    '.package-lock.json',
  )
  if (!(await present(installed)))
    throw new Error(
      `${installed} is missing: run npm ci in ${genuineConfigDeps} before this suite`,
    )
  const captured = await captureOc1Bootstrap()
  await fixture(async (root) => {
    const layout = await oc1Layout(root, captured.PACKAGE)
    // Missing-dependency reproduction: unseeded, OC1 would run a registry
    // install in each config directory and for the bare plugin name.
    for (const directory of layout.configDirectories)
      expect(await opencode1WouldSkipInstall(directory)).toBe(false)
    expect(await present(layout.cachedPlugin)).toBe(false)
    expect(await captured.hostBootstrapReport(layout.env)).toContain(
      'config plugin SDK: missing',
    )

    const targets = await captured.seedOc1Bootstrap(
      root,
      layout.project,
      layout.env,
      captured.PACKAGE,
      { fixture: genuineConfigDeps, version: '1.19.5' },
    )
    expect([...targets].sort()).toEqual(
      layout.configDirectories.map((directory) => resolve(directory)).sort(),
    )
    const fixtureLock = JSON.parse(
      await readFile(join(genuineConfigDeps, 'package-lock.json'), 'utf8'),
    )
    for (const directory of layout.configDirectories) {
      expect(await opencode1WouldSkipInstall(directory)).toBe(true)
      expect(
        JSON.parse(
          await readFile(join(directory, 'package-lock.json'), 'utf8'),
        ),
      ).toEqual(fixtureLock)
      const sdk = join(directory, 'node_modules', '@opencode-ai', 'plugin')
      const manifest = JSON.parse(
        await readFile(join(sdk, 'package.json'), 'utf8'),
      )
      expect(manifest.version).toBe('1.19.5')
      expect(
        (await lstat(join(sdk, manifest.exports['.'].import))).size,
      ).toBeGreaterThan(0)
      // The fixture's npm .bin links arrive verbatim and stay relative.
      const links = await symlinksUnder(join(directory, 'node_modules'))
      expect(links.length).toBeGreaterThan(0)
      expectLinksOwnedBy(directory, links)
    }
    expect(
      JSON.parse(await readFile(layout.cachedPlugin, 'utf8')).version,
    ).toBe('0.0.0-packed')
    const cache = dirname(dirname(dirname(layout.cachedPlugin)))
    const cacheLinks = await symlinksUnder(cache)
    expect(cacheLinks.length).toBeGreaterThan(0)
    expectLinksOwnedBy(cache, cacheLinks)
    expect(await captured.hostBootstrapReport(layout.env)).toContain(
      'config plugin SDK: 1.19.5',
    )
  })
})

test('captured OC1 seeding refuses an SDK tree from another OC1 version before copying', async () => {
  const captured = await captureOc1Bootstrap()
  await fixture(async (root) => {
    const layout = await oc1Layout(root, captured.PACKAGE)
    // An older host must not silently reuse the committed SDK fixture for
    // OpenCode 1.19.5. Keep a different version here to exercise that refusal.
    await expect(
      captured.seedOc1Bootstrap(
        root,
        layout.project,
        layout.env,
        captured.PACKAGE,
        { fixture: genuineConfigDeps, version: '1.18.31' },
      ),
    ).rejects.toThrow('the config dependency fixture declares 1.19.5')
    for (const directory of layout.configDirectories) {
      expect(await present(join(directory, 'node_modules'))).toBe(false)
      expect(await opencode1WouldSkipInstall(directory)).toBe(false)
    }
    expect(await present(layout.cachedPlugin)).toBe(false)
  })
})

test('captured OC1 seeding refuses a manifest and lockfile without the installed tree', async () => {
  const captured = await captureOc1Bootstrap()
  await fixture(async (root) => {
    const layout = await oc1Layout(root, captured.PACKAGE)
    const incomplete = join(root, 'incomplete-deps')
    await mkdir(join(incomplete, 'node_modules'), { recursive: true })
    for (const name of ['package.json', 'package-lock.json'])
      await cp(join(genuineConfigDeps, name), join(incomplete, name))
    await expect(
      captured.seedOc1Bootstrap(
        root,
        layout.project,
        layout.env,
        captured.PACKAGE,
        { fixture: incomplete, version: '1.19.5' },
      ),
    ).rejects.toThrow('has no npm-installed node_modules')
    for (const directory of layout.configDirectories)
      expect(await present(join(directory, 'node_modules'))).toBe(false)
    expect(await present(layout.cachedPlugin)).toBe(false)
  })
})

test('captured OC1 failure report includes the host bootstrap log with fixture secrets redacted', async () => {
  const captured = await captureOc1Bootstrap()
  await fixture(async (root) => {
    const layout = await oc1Layout(root, captured.PACKAGE)
    const logs = join(layout.env.XDG_DATA_HOME, 'opencode', 'log')
    await mkdir(logs, { recursive: true })
    await writeFile(
      join(logs, '2026-10-11T135743.log'),
      `WARN service=config background dependency install failed dir=${layout.configDirectories[0]}\n${captured.secrets.join('\n')}\n`,
    )
    const report = (await captured.hostBootstrapReport(layout.env)).join('\n')
    expect(report).toContain('config plugin SDK: missing')
    expect(report).toContain('host log 2026-10-11T135743.log:')
    expect(report).toContain('background dependency install failed')
    expect(report).toContain('[redacted]')
    for (const secret of captured.secrets) expect(report).not.toContain(secret)
  })
})
