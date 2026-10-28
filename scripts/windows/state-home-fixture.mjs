import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256 } from './harness.mjs'

/** Install an empty committed dataset for publisher tests without running move admission. */
export async function installEmptyStateHomeFixture({
  core,
  api,
  target,
  layout,
  paths,
}) {
  if (process.platform === 'win32') {
    await core.ensureWindowsOwnerOnlyDirectory(layout.dir)
  } else {
    await mkdir(layout.dir, { recursive: true, mode: 0o700 })
  }
  const old = await core.resolveNativePoolPaths(
    paths.legacyConfig,
    paths.legacyState,
    { kind: 'legacy' },
  )
  const oldDir = dirname(old.legacyConfig)
  const from = core.stateHomeFilePaths(oldDir)
  const to = core.stateHomeFilePaths(layout.dir)
  const sources = {
    localPoolState: old.state,
    journal: old.journal,
    localRoster: old.roster,
    vaultStoreState: from.vaultStoreState,
    vaultRoster: from.vaultRoster,
    vaultRouting: from.vaultRouting,
    localRuntime: old.runtime,
    vaultRuntime: from.vaultRuntime,
  }
  const attempt = '00000000-0000-4000-8000-000000000001'
  const record = {
    version: 1,
    phase: 'committed',
    attempt,
    identity: target.identity,
    stateRoot: target.stateRoot,
    sub: layout.dir,
    oldDir,
    storageIds: {
      local: paths.storageId,
      vault: sha256(
        JSON.stringify([
          'anthropic-vault',
          join(oldDir, 'anthropic-auth-vault-settings.json'),
          from.vaultStoreState,
        ]),
      ),
    },
    by: 'long-path-publication-fixture',
    startedAt: 1_700_000_000_000,
    files: Object.entries(sources).map(([role, path]) => ({
      role,
      from: path,
      to: to[role],
      sha256: null,
    })),
    barriers: {
      journal: 'absent',
      localRuntime: { original: null },
      vaultRuntime: { original: null },
    },
    committedAt: 1_700_000_000_000,
    cleanup: 'done',
  }
  // The full record writer is private to Core, so use the installed private-file
  // writer. Core's runtime guard parses the record before writing account state.
  const write = (path, value) =>
    api.createPrivateFile(path, `${JSON.stringify(value)}\n`)
  await write(to.configDirMarker, { version: 1, identity: target.identity })
  await write(to.layoutMarker, record)
  const pointer = {
    version: 0,
    relocatedTo: layout.dir,
    stateRoot: target.stateRoot,
    identity: target.identity,
    attempt,
    by: record.by,
  }
  for (const path of [old.runtime, from.vaultRuntime]) {
    await write(path, pointer)
    assert.equal(
      (await core.readRelocationPointer(path))?.relocatedTo,
      layout.dir,
    )
  }
  core.recordProcessStateLayout(paths.legacyConfig, layout)
}
