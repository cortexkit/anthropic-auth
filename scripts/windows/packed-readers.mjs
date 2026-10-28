import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertFreshOpenCode1Journal, sha256, snapshot } from './harness.mjs'

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

/** Strict relocation move proof: the real state-layout move must reach state-home. */
export async function verifyRelocationMoveStrict({
  core,
  env,
  root,
  result,
  label,
  stateBaseParts,
  expectLong,
}) {
  const configDir = join(root, `${label}-config`)
  const stateBase = join(root, `${label}-state-base`, ...stateBaseParts)
  await mkdir(configDir, { recursive: true })
  await mkdir(stateBase, { recursive: true })
  await writeFile(join(configDir, 'opencode.json'), '{}\n')
  const fixtureEnv = {
    ...env,
    OPENCODE_CONFIG_DIR: configDir,
    XDG_STATE_HOME: stateBase,
  }
  let lastStep
  const decision = await core.decideOpenCodeStateLayout({
    role: 'opencode1',
    env: fixtureEnv,
    home: fixtureEnv.HOME,
    moveEnabled: true,
    onStep: (step) => {
      lastStep = step
    },
  })
  try {
    assert.equal(
      decision.kind,
      'state-home',
      `Expected state-home for ${label} at step ${lastStep}, got ${decision.kind}: ${(decision.reasons ?? []).join('; ')}`,
    )
    const runtimePath = decision.dataset.newPaths.runtime
    const subDir = decision.layout.dir
    if (expectLong) {
      assert(
        runtimePath.length > 260,
        `Long ${label} runtime is only ${runtimePath.length} characters`,
      )
      assert(
        subDir.length > 260,
        `Long ${label} state-home is only ${subDir.length} characters`,
      )
    } else {
      assert(
        runtimePath.length < 260,
        `Ordinary ${label} runtime should stay under 260 characters, got ${runtimePath.length}`,
      )
      assert(
        runtimePath.length > 100,
        `Ordinary ${label} runtime should still be a realistic path, got ${runtimePath.length}`,
      )
    }
    return {
      label,
      lastStep,
      kind: decision.kind,
      runtimePathLength: runtimePath.length,
      stateHomeLength: subDir.length,
    }
  } finally {
    await decision.registration?.close()
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
  const decision = await core.decideOpenCodeStateLayout({
    role: 'opencode1',
    env: fixtureEnv,
    home: fixtureEnv.HOME,
    // Force the state-home layout for this fixture even while moving is opt-in.
    moveEnabled: true,
  })
  assert.equal(decision.kind, 'state-home')
  const paths = await core.resolveNativePoolPaths(
    decision.dataset.newPaths.legacyConfig,
    decision.dataset.newPaths.legacyState,
    decision.layout,
  )
  assert.equal(paths.runtime, decision.dataset.newPaths.runtime)
  assert(paths.runtime.startsWith(`${decision.layout.dir}${sep}`))
  assert(
    paths.runtime.length > 260,
    `Runtime path is only ${paths.runtime.length} characters`,
  )
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
