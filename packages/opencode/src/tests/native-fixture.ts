import { lstat, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  createNativePoolStore,
  discoverNativeVaultInventory,
  getStickyRoutingStatePath,
  type NativeCustodyClient,
  type NativeLegacyMigrationJournal,
  type NativePoolPaths,
  publishNativeVaultRosterSeed,
  publishNativeVaultRuntimeSeed,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'

/**
 * deferCleanup registers fixture removal; trackDetached registers work that
 * may outlive the test callback. TestLifetime waits for the callback and all
 * registered work before cleanup, then reports any registered rejection.
 */
export interface NativeOpencodeFixtureLifetime {
  deferCleanup(cleanup: () => void | Promise<void>): void
  trackDetached(work: Promise<unknown>): void
}

/** File content: a string is written byte-for-byte (for malformed input); anything else is JSON-encoded. */
export type NativeOpencodeFixtureSource = string | Record<string, unknown>

/** Synthetic vault discovery. The fixture never opens a daemon connection file. */
export interface NativeOpencodeFixtureCustody {
  connect: () => Promise<NativeCustodyClient>
  /** Written owner-only to this fixture's enrollment path for the real token reader. */
  enrollment: { token: string; token_generation: number }
}

export interface NativeOpencodeFixtureInput {
  /**
   * An existing, empty, owner-only directory created by the caller, such as a
   * fresh mkdtemp result. The fixture removes it through lifetime.deferCleanup
   * only after accepting it; a refused directory is left untouched.
   */
  root: string
  lifetime: NativeOpencodeFixtureLifetime
  /** Legacy OpenCode account config (anthropic-auth.json). */
  legacyConfig: NativeOpencodeFixtureSource
  /** Legacy account state; omitted means no state file exists. */
  legacyState?: NativeOpencodeFixtureSource
  /** Legacy sticky-routing state; omitted means no routing file exists. */
  legacyRouting?: NativeOpencodeFixtureSource
  /** OpenCode auth.json contents, including unrelated providers; omitted means no file. */
  hostAuth?: NativeOpencodeFixtureSource
  /** Required only when legacyConfig selects vault custody; the migration refuses otherwise. */
  custody?: NativeOpencodeFixtureCustody
}

/** Path variables a test may apply to process.env itself, with its own save and restore, before loading the plugin. */
export type NativeOpencodeFixtureEnv = Readonly<{
  OPENCODE_ANTHROPIC_AUTH_FILE: string
  OPENCODE_ANTHROPIC_AUTH_STATE_FILE: string
  OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: string
  OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: string
  OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: string
  OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: string
  OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: string
  OPENCODE_ANTHROPIC_AUTH_RPC_DIR: string
  CLAUDE_CONFIG_DIR: string
}>

export interface NativeOpencodeFixture {
  /** Canonical (realpath) form of the caller's root. */
  root: string
  /** Canonical pool paths, as resolveNativePoolPaths returns them. */
  paths: NativePoolPaths
  /** Journal returned by runNativeMigration; always phase 'retired'. */
  journal: NativeLegacyMigrationJournal
  hostAuthPath: string
  routingSourcePath: string
  routingDestinationPath: string
  enrollmentPath: string
  env: NativeOpencodeFixtureEnv
}

class NativeOpencodeFixtureRefusal extends Error {
  constructor(reason: string) {
    super(`Native OpenCode fixture refused root: ${reason}`)
    this.name = 'NativeOpencodeFixtureRefusal'
  }
}

async function claimRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || !isAbsolute(root) || /\p{Cc}/u.test(root))
    throw new NativeOpencodeFixtureRefusal('not an absolute path')
  const info = await lstat(root).catch(() => undefined)
  if (!info) throw new NativeOpencodeFixtureRefusal('does not exist')
  if (info.isSymbolicLink())
    throw new NativeOpencodeFixtureRefusal('is a symbolic link')
  if (!info.isDirectory())
    throw new NativeOpencodeFixtureRefusal('not a directory')
  if (process.getuid && info.uid !== process.getuid())
    throw new NativeOpencodeFixtureRefusal('owned by another user')
  if ((info.mode & 0o077) !== 0)
    throw new NativeOpencodeFixtureRefusal('not owner-only')
  if ((await readdir(root)).length !== 0)
    throw new NativeOpencodeFixtureRefusal('not empty')
  // The root itself is not a link, so realpath only resolves parent aliases
  // such as macOS /var -> /private/var; the pool resolver canonicalizes the same way.
  return realpath(root)
}

async function writeSource(
  path: string,
  source: NativeOpencodeFixtureSource,
): Promise<void> {
  // Exclusive create: never replace a file that appeared after the empty check.
  await writeFile(
    path,
    typeof source === 'string' ? source : JSON.stringify(source),
    { mode: 0o600, flag: 'wx' },
  )
}

/** Native account metadata in the shape the vault runtime seed publisher accepts. */
type NativeRuntimeState = Parameters<typeof publishNativeVaultRuntimeSeed>[1]

/** The migrated vault account metadata, rebound to the vault namespace's storage. */
function vaultRuntimeSeed(
  state: NativeRuntimeState,
  storageId: string,
): NativeRuntimeState {
  const accounts: NativeRuntimeState['accounts'] = {}
  for (const [id, entry] of Object.entries(state.accounts))
    if (entry.binding.kind === 'custody')
      accounts[id] = { ...entry, binding: { ...entry.binding, storageId } }
  return { ...state, storageId, accounts }
}

/**
 * Give the vault namespace the migrated settings. The default vault account
 * stays pinned by its credential and account UUID; enrollment, not a mode
 * flag, selects vault custody, so the flag is not carried over.
 */
async function seedVaultSettings(paths: NativePoolPaths) {
  const local = await createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
  }).readSettings()
  if (local.status !== 'ready')
    throw new Error('Fixture migration left no readable settings')
  const vault = createNativePoolStore({
    paths: nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  })
  await vault.initialize()
  await vault.updateSettings(() => {
    const settings = structuredClone(local.settings)
    const claustrum = settings.claustrum
    if (
      claustrum &&
      typeof claustrum === 'object' &&
      !Array.isArray(claustrum)
    ) {
      const {
        mode: _mode,
        scopedRoster: _scopedRoster,
        ...rest
      } = claustrum as Record<string, unknown>
      settings.claustrum = rest
    }
    return settings
  })
}

async function migrate(
  input: NativeOpencodeFixtureInput,
): Promise<NativeOpencodeFixture> {
  const root = await claimRoot(input.root)
  input.lifetime.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const legacyConfigPath = join(root, 'anthropic-auth.json')
  const legacyStatePath = join(root, 'anthropic-auth-state.json')
  const paths = await resolveNativePoolPaths(legacyConfigPath, legacyStatePath)
  for (const path of [
    paths.legacyConfig,
    paths.legacyState,
    paths.config,
    paths.state,
    paths.runtime,
    paths.journal,
    paths.roster,
  ])
    if (dirname(path) !== root)
      throw new Error('Native OpenCode fixture path escaped its root')
  const hostAuthPath = join(root, 'host-auth.json')
  // The legacy plugin keeps routing beside its account config; the migrated
  // routing goes beside the pool config, and env points the plugin there.
  const routingSourcePath = getStickyRoutingStatePath(paths.legacyConfig)
  const routingDestinationPath = getStickyRoutingStatePath(paths.config)
  const enrollmentPath = join(root, 'opencode-enrollment.json')
  const env: NativeOpencodeFixtureEnv = Object.freeze({
    OPENCODE_ANTHROPIC_AUTH_FILE: paths.legacyConfig,
    OPENCODE_ANTHROPIC_AUTH_STATE_FILE: paths.legacyState,
    OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE: routingDestinationPath,
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE: enrollmentPath,
    // Points at a file the fixture never creates, so a plugin that applies
    // this env finds no Claustrum daemon connection details.
    OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: join(
      root,
      'claustrum-connection.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE: join(
      root,
      'sidebar-state.json',
    ),
    OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR: join(
      root,
      'cachekeep-registry',
    ),
    OPENCODE_ANTHROPIC_AUTH_RPC_DIR: join(root, 'rpc'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
  })

  await writeSource(paths.legacyConfig, input.legacyConfig)
  if (input.legacyState !== undefined)
    await writeSource(paths.legacyState, input.legacyState)
  if (input.legacyRouting !== undefined)
    await writeSource(routingSourcePath, input.legacyRouting)
  if (input.hostAuth !== undefined)
    await writeSource(hostAuthPath, input.hostAuth)
  const custody = input.custody
  const vaultPaths = nativeVaultPaths(paths)
  // The owner-only enrollment token is what selects vault custody.
  if (custody) await writeSource(enrollmentPath, custody.enrollment)

  // This fixture does not start or inspect host processes. Its processFence
  // callback counts the migration's requests to check that hosts are stopped;
  // zero calls fails the fixture instead of bypassing the check silently.
  let processFenceChecks = 0
  const journal = await runNativeMigration({
    paths,
    legacyConfigPath: paths.legacyConfig,
    legacyStatePath: paths.legacyState,
    host: 'opencode',
    hostAuthPath,
    routingSourcePath,
    routingDestinationPath,
    // Pass the fixture env, not process.env, so an inherited
    // OPENCODE_AUTH_CONTENT or another test's path variables cannot reach the
    // migration.
    env: { ...env },
    removePiAnthropicAuth: false,
    processFence: async () => {
      processFenceChecks++
    },
    ...(custody && {
      custody: {
        discover: () =>
          discoverNativeVaultInventory({
            paths,
            host: 'opencode',
            connect: custody.connect,
            env: { ...env },
          }),
        // Vault accounts are served from the vault namespace, which the
        // enrollment selects; the copies the migration keeps beside the local
        // pool remain only as its own bookkeeping. Publish each seed to both.
        publishSeed: async (localPaths, seedInput, options) => {
          await publishNativeVaultRosterSeed(
            { roster: vaultPaths.roster },
            seedInput,
            options,
          )
          return publishNativeVaultRosterSeed(localPaths, seedInput, options)
        },
        publishRuntimeSeed: async (localPaths, state, options) => {
          await publishNativeVaultRuntimeSeed(localPaths, state, options)
          await publishNativeVaultRuntimeSeed(
            vaultPaths,
            vaultRuntimeSeed(state, vaultPaths.storageId),
            options,
          )
        },
      },
    }),
  })
  if (processFenceChecks === 0)
    throw new Error('Fixture migration did not check its process fence')
  if (journal.phase !== 'retired')
    throw new Error(`Fixture migration ended in phase ${journal.phase}`)
  if (custody) await seedVaultSettings(paths)
  return {
    root,
    paths,
    journal,
    hostAuthPath,
    routingSourcePath,
    routingDestinationPath,
    enrollmentPath,
    env,
  }
}

/**
 * Import caller-supplied synthetic legacy OpenCode files into a native pool
 * through the real offline migration controller, and return its retired journal.
 *
 * It does not modify process.env, start a host, or validate credentials. Vault
 * discovery runs only through the caller's custody.connect callback; the
 * fixture never falls back to the default Claustrum connector. A test that
 * needs a served credential must still admit it through the public runtime.
 * The returned promise is also registered with lifetime.trackDetached, so
 * teardown waits for it even if the caller never awaits it, and any rejection,
 * including a refused root or a migration refusal, fails teardown after the
 * deferred cleanups have run. A test that expects a refusal should pass its
 * own TestLifetime and assert that its finish() rejects.
 */
export function migrateNativeOpencodeFixture(
  input: NativeOpencodeFixtureInput,
): Promise<NativeOpencodeFixture> {
  let start!: () => void
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  const work = started.then(() => migrate(input))
  // Register before migrate() runs. On a closed lifetime trackDetached throws
  // here, start() is never called, and no file is read or written.
  input.lifetime.trackDetached(work)
  start()
  return work
}
