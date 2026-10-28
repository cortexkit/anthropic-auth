import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertFreshOpenCode1Journal, sha256, snapshot } from './harness.mjs'
import { installEmptyStateHomeFixture } from './state-home-fixture.mjs'

/** Resolve from the installed CLI, including import-only package export maps. */
export async function loadPackedRuntime(consumer) {
  const cli = join(
    consumer,
    'node_modules',
    '@cortexkit',
    'opencode-anthropic-auth',
    'dist',
    'cli.js',
  )
  const parent = pathToFileURL(cli).href
  const privateEntry = fileURLToPath(
    import.meta.resolve('@cortexkit/private-files', parent),
  )
  const api = await import(pathToFileURL(privateEntry).href)
  const core = await import(
    import.meta.resolve('@cortexkit/anthropic-auth-core', parent)
  )
  return { cli, privateEntry, api, core }
}

/** Shared by native CI and the portable packed-consumer proof; never imports product source. */
export async function verifySetupReaders({
  core,
  api,
  env,
  profile,
  result,
  fixtureToken,
}) {
  const paths = await core.resolveNativePoolPaths(
    join(env.OPENCODE_CONFIG_DIR, 'anthropic-auth.json'),
    join(env.OPENCODE_CONFIG_DIR, 'anthropic-auth-state.json'),
  )
  const journal = await core.readNativeMigrationJournal(paths)
  assertFreshOpenCode1Journal(journal)
  result.dacls['setup-journal'] = await api.verifyOwnerOnly(paths.journal)
  assert.equal(result.dacls['setup-journal'].ok, true)
  result.files['setup-journal'] = sha256(await readFile(paths.journal))

  // The no-login setup already wrote an empty runtime. Verify its pinned private
  // bytes instead of reaching into Core's unexported runtime implementation.
  const runtimeBytes = await api.readPrivateFile(paths.runtime)
  assert.deepEqual(JSON.parse(runtimeBytes.toString('utf8')), {
    version: 1,
    storageId: paths.storageId,
    accounts: {},
  })
  result.dacls['setup-runtime'] = await api.verifyOwnerOnly(paths.runtime)
  assert.equal(result.dacls['setup-runtime'].ok, true)
  result.files['setup-runtime'] = sha256(runtimeBytes)

  const auth = join(profile, 'synthetic-host-auth.json')
  await api.createPrivateFile(auth, '{}')
  assert.equal(await core.readNativeHostAuthKind('opencode', auth), 'absent')
  const token = join(profile, 'synthetic-enrollment.json')
  await api.createPrivateFile(
    token,
    JSON.stringify({ token: fixtureToken, token_generation: 1 }),
  )
  assert.equal(
    (
      await core.readClaustrumEnrollmentStatus({
        tokenPath: token,
        statePath: join(profile, 'missing-state'),
      })
    ).state,
    'approved',
  )
  result.files.profile = await snapshot(profile)
  return {
    journal: 'setup-written v4 retired migration',
    runtime: 'setup-written empty runtime; private-files verified bytes',
    hostAuth: 'synthetic absent',
    enrollment: 'synthetic token, never used for a connection',
    ownershipBackend:
      process.platform === 'win32' ? 'native-dacl' : 'posix-mode-and-owner',
  }
}

/** Exercise long state-home publication through installed Core, including lock release and reuse. */
export async function verifyLongStateHomeRuntimePublication({
  core,
  api,
  env,
  root,
  result,
}) {
  const configDir = join(root, 'long-state-home-config')
  const stateBase = join(
    root,
    'long-state-base',
    ...Array.from({ length: 8 }, (_, i) => `segment-${i}-${'x'.repeat(28)}`),
  )
  await mkdir(configDir, { recursive: true })
  await mkdir(stateBase, { recursive: true })
  await writeFile(join(configDir, 'opencode.json'), '{}\n')
  const fixtureEnv = {
    ...env,
    OPENCODE_CONFIG_DIR: configDir,
    XDG_STATE_HOME: stateBase,
  }
  // Probe publication, not relocation: move admission can stay legacy when
  // an older-version artifact is present or a migration precondition fails.
  const target = core.resolveStateHomeTarget({
    env: fixtureEnv,
    home: fixtureEnv.HOME,
  })
  assert(target, 'The existing config folder must name a state-home target')
  const layout = { kind: 'state-home', dir: target.dir }
  const paths = await core.resolveNativePoolPaths(
    join(configDir, 'anthropic-auth.json'),
    join(configDir, 'anthropic-auth-state.json'),
    layout,
  )
  layout.dir = dirname(paths.runtime)
  assert.equal(paths.runtime, core.stateHomeFilePaths(layout.dir).localRuntime)
  assert(paths.runtime.startsWith(`${layout.dir}${sep}`))
  assert(
    paths.runtime.length > 260,
    `Runtime path is only ${paths.runtime.length} characters`,
  )
  await installEmptyStateHomeFixture({ core, api, target, layout, paths })
  await core.publishNativeEmptyInit({
    paths,
    routingDestinationPath: core.resolveLocalRoutingDestination(
      'opencode',
      paths,
      fixtureEnv,
    ),
    processFence: async () => {},
    env: fixtureEnv,
  })
  const events = []
  const runtime = core.createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: { env: fixtureEnv },
    local: { onLockEvent: (event) => events.push(event) },
  })
  try {
    const row = await runtime.addApi({
      routeId: 'long-state-home-probe',
      apiKey: 'synthetic-long-state-home-key',
      baseURL: 'https://example.test',
    })
    const authorized = await runtime.authorizeApi(row.id)
    const lockPath = `${paths.runtime}.native-runtime.lock`
    const runtimeLocks = () =>
      events.filter((event) => event.name === 'native-runtime')
    // A second publication must acquire the same lock after the first release.
    for (const lastUsed of [1_700_000_000_000, 1_700_000_000_001]) {
      await assert.rejects(lstat(lockPath), { code: 'ENOENT' })
      const before = runtimeLocks().length
      assert.equal(
        await runtime.publishApi(authorized.subject, { lastUsed }),
        true,
      )
      const cycle = runtimeLocks().slice(before)
      assert.deepEqual(
        cycle.map((event) => event.type),
        ['acquiring', 'acquired', 'released'],
      )
      assert(cycle.every((event) => event.path === paths.runtime))
      await assert.rejects(lstat(lockPath), { code: 'ENOENT' })
    }
    const bytes = await api.readPrivateFile(paths.runtime)
    const state = JSON.parse(bytes.toString('utf8'))
    assert.equal(state.storageId, paths.storageId)
    assert.equal(state.accounts[row.id].lastUsed, 1_700_000_000_001)
    const verdict = await api.verifyOwnerOnly(paths.runtime)
    assert.equal(verdict.ok, true)
    result.dacls['long-state-home-runtime'] = verdict
    result.files['long-state-home-runtime'] = sha256(bytes)
    return { runtimePathLength: paths.runtime.length, runtimeLockCycles: 2 }
  } finally {
    await runtime.close()
  }
}
