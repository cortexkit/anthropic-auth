import assert from 'node:assert/strict'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
  // Read setup's committed layout without making a second process decide or
  // change it. Core owns both the custom-config folder naming and the marker.
  const target = core.resolveStateHomeTarget({ env, home: profile })
  assert(target, 'Setup must leave an identifiable config folder')
  const marker = await core.readStateLayoutMarker(target.dir)
  assert(marker, 'Setup must publish its state-home layout marker')
  assert.equal(marker.phase, 'committed')
  assert.equal(marker.identity, target.identity)
  assert.equal(marker.stateRoot, await realpath(target.stateRoot))
  assert.equal(marker.sub, await realpath(target.dir))
  const config = join(env.OPENCODE_CONFIG_DIR, 'anthropic-auth.json')
  const state = join(env.OPENCODE_CONFIG_DIR, 'anthropic-auth-state.json')
  const paths = await core.resolveNativePoolPaths(config, state, {
    kind: 'state-home',
    dir: marker.sub,
  })
  assert.equal(paths.storageId, marker.storageIds.local)
  const legacy = await core.resolveNativePoolPaths(config, state, {
    kind: 'legacy',
  })
  for (const key of ['journal', 'runtime']) {
    assert.equal(dirname(paths[key]), marker.sub)
  }
  await assert.rejects(
    lstat(legacy.journal),
    { code: 'ENOENT' },
    'Setup must not leave its journal in the config folder',
  )
  // Older readers must see the relocation tombstone, never a second account
  // runtime.
  const pointer = await core.readRelocationPointer(legacy.runtime)
  assert(
    pointer,
    'Only a relocation tombstone may remain at the legacy runtime',
  )
  assert.equal(pointer.relocatedTo, marker.sub)
  assert.equal(pointer.stateRoot, marker.stateRoot)
  assert.equal(pointer.identity, marker.identity)
  assert.equal(pointer.attempt, marker.attempt)
  const pointerBytes = await api.readPrivateFile(legacy.runtime)
  assert.deepEqual(JSON.parse(pointerBytes.toString('utf8')), {
    version: 0,
    ...pointer,
  })
  result.dacls['setup-runtime-pointer'] = await api.verifyOwnerOnly(
    legacy.runtime,
  )
  assert.equal(result.dacls['setup-runtime-pointer'].ok, true)
  result.files['setup-runtime-pointer'] = sha256(pointerBytes)
  result.files['setup-layout'] = sha256(
    await readFile(join(marker.sub, 'layout.json')),
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
    layout: {
      phase: marker.phase,
      location: 'state-home',
      files: [basename(paths.journal), basename(paths.runtime)],
      journalAbsentFromConfig: true,
      legacyRuntime: 'matching relocation tombstone only; no account payload',
      marker: 'layout.json',
    },
    journal: 'setup-written v4 retired migration',
    runtime: 'setup-written empty runtime; private-files verified bytes',
    hostAuth: 'synthetic absent',
    enrollment: 'synthetic token, never used for a connection',
    ownershipBackend:
      process.platform === 'win32' ? 'native-dacl' : 'posix-mode-and-owner',
  }
}
