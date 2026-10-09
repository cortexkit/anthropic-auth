/// <reference types="bun-types" />

import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  type Dirent,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  discoverNativeVaultInventory,
  getStickyRoutingStatePath,
  type NativeMigrationJournal,
  type NativePoolPaths,
  type NativeRefreshResult,
  type ProviderAccountUuid,
  publishNativeVaultRosterSeed,
  publishNativeVaultRuntimeSeed,
  resolveNativePoolPaths,
  runNativeMigration,
} from '@cortexkit/anthropic-auth-core'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const PLUGIN_ENTRY = join(REPO_ROOT, 'packages/opencode/src/index.ts')
const E2E_TEMP_PREFIX = 'anthropic-auth-e2e-'
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000
const RUN_PID_FILE = 'run.pid'
const activeRunDirs = new Set<string>()

export type IsolatedEnv = {
  tempDir: string
  homeDir: string
  configDir: string
  dataDir: string
  cacheDir: string
  workdir: string
  quotaFeedDir: string
}

function isExpectedE2ETempDir(path: string, root: string) {
  const resolvedPath = resolve(path)
  const resolvedRoot = resolve(root)
  return (
    dirname(resolvedPath) === resolvedRoot &&
    basename(resolvedPath).startsWith(E2E_TEMP_PREFIX)
  )
}

async function isSafeE2ETempDir(path: string, root: string) {
  if (!isExpectedE2ETempDir(path, root)) return false
  try {
    const stats = await lstat(path)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

export async function removeE2ETempDir(
  path: string,
  options: { root?: string; keep?: boolean } = {},
) {
  if (options.keep) return false
  const root = options.root ?? tmpdir()
  if (!(await isSafeE2ETempDir(path, root))) return false
  activeRunDirs.delete(resolve(path))

  try {
    await rm(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export async function sweepStaleE2ETempDirs(
  options: { root?: string; now?: number; maxAgeMs?: number } = {},
) {
  const root = options.root ?? tmpdir()
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_AGE_MS

  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.name.startsWith(E2E_TEMP_PREFIX) || !entry.isDirectory())
        return
      const path = join(root, entry.name)
      try {
        const stats = await lstat(path)
        if (stats.isSymbolicLink() || now - stats.mtimeMs <= maxAgeMs) return
        if (await hasLiveRunOwner(path)) return
        await removeE2ETempDir(path, { root })
      } catch {
        // A crashed-run sweep must not prevent a new harness from starting.
      }
    }),
  )
}

async function hasLiveRunOwner(path: string) {
  if (activeRunDirs.has(resolve(path))) return true
  try {
    const value = await readFile(join(path, RUN_PID_FILE), 'utf8')
    const pid = Number(value.trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    if (pid === process.pid) return activeRunDirs.has(resolve(path))
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  } catch {
    return false
  }
}

async function handoffRunPid(tempDir: string, root: string, childPid: number) {
  const runPidPath = join(tempDir, RUN_PID_FILE)
  if (
    resolve(dirname(runPidPath)) !== resolve(tempDir) ||
    !(await isSafeE2ETempDir(tempDir, root))
  ) {
    return false
  }

  try {
    const stats = await lstat(runPidPath)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
  } catch {
    return false
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporaryPath = join(
      tempDir,
      `.${RUN_PID_FILE}.${randomBytes(12).toString('hex')}.tmp`,
    )
    let created = false
    try {
      await writeFile(temporaryPath, String(childPid), {
        encoding: 'utf8',
        flag: 'wx',
      })
      created = true
      await rename(temporaryPath, runPidPath)
      return true
    } catch (error) {
      if (created) await unlink(temporaryPath).catch(() => {})
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      return false
    }
  }
  return false
}

/**
 * How the child's Anthropic accounts are prepared before `opencode serve`
 * starts. The plugin serves only from a native pool that offline migration
 * created; it refuses unmigrated legacy files and OPENCODE_AUTH_CONTENT.
 *
 * - `local` (the default): OpenCode's own auth.json holds `hostAuth`, by
 *   default a synthetic Anthropic OAuth login. Migration moves that login
 *   into the pool. When the pool then has a local main OAuth account, it is
 *   validated once through the public account runtime, so the host can
 *   serve it without contacting the real token or account endpoints.
 * - `vault`: auth.json holds the inert custody marker, and migration
 *   discovers the vault accounts through the Claustrum connection and
 *   enrollment files named in the child environment. The test must write a
 *   custody legacy config and enrollment file in `beforeSpawn`.
 * - `unmigrated`: no migration runs. Without `hostAuth`, the child receives
 *   the synthetic OAuth login through OPENCODE_AUTH_CONTENT unless
 *   `childEnv` replaces it. With `hostAuth`, the harness writes it to
 *   OpenCode's own auth.json and removes OPENCODE_AUTH_CONTENT, so the
 *   plugin's missing-migration refusal is reached instead of its refusal of
 *   that variable. Use this only for a test that expects the plugin to refuse.
 */
export type NativeAccountFixture =
  | { kind: 'local'; hostAuth?: Record<string, unknown> }
  | { kind: 'vault' }
  | { kind: 'unmigrated'; hostAuth?: Record<string, unknown> }

/** Pool paths and retired journal of a migrated fixture. */
export type MigratedNativeAccounts = {
  paths: NativePoolPaths
  journal: NativeMigrationJournal
  hostAuthPath: string
  routingDestinationPath: string
  /** Result of validating the local main OAuth account; absent when the pool has none. */
  mainAdmission?: NativeRefreshResult
}

/** Synthetic account UUID that the fixture's account lookup reports for the main login. */
export const FIXTURE_MAIN_ACCOUNT_UUID = '11111111-1111-4111-8111-111111111111'
/** Access token the fixture's token exchange issues; the child serves with this token. */
export const FIXTURE_ADMITTED_ACCESS_TOKEN = 'test-access-token-admitted'

export type SpawnedOpencode = {
  url: string
  port: number
  env: IsolatedEnv
  /** Undefined for an `unmigrated` fixture. */
  native?: MigratedNativeAccounts
  kill: () => Promise<void>
  stdout: () => string
  stderr: () => string
}

export type SpawnOptions = {
  anthropicBaseURL: string
  hybridCache?: boolean
  fallbackMode?: 'server' | 'legacy'
  relay?: {
    url: string
    token: string
    transport: 'websocket' | 'http'
  }
  port?: number
  beforeSpawn?: (env: IsolatedEnv) => void | Promise<void>
  childEnv?: Record<string, string | undefined>
  childTmpDir?: string
  quotaFeed?: boolean
  /** Defaults to `{ kind: 'local' }`. */
  nativeAccounts?: NativeAccountFixture
}

export function waitForOpencodeListening(
  child: ChildProcess,
  getStdout: () => string,
  timeoutMs = 60_000,
): Promise<{ url: string; port: number }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout?.off('data', check)
      child.off('exit', exited)
      child.off('error', failed)
    }
    const failed = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      failed(
        new Error(
          `opencode exited before announcing its listener (code=${code}, signal=${signal})`,
        ),
      )
    }
    const check = () => {
      if (settled) return
      const match =
        /^opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))\r?\n/m.exec(
          getStdout(),
        )
      if (!match?.[1]) return
      const port = Number(match[2])
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        failed(new Error('opencode announced an invalid listener port'))
        return
      }
      settled = true
      cleanup()
      resolve({ url: match[1], port })
    }
    const timer = setTimeout(
      () =>
        failed(
          new Error(
            'opencode did not announce a listener before its startup deadline',
          ),
        ),
      Math.max(1, timeoutMs),
    )
    child.stdout?.on('data', check)
    child.once('exit', exited)
    child.once('error', failed)
    if (child.exitCode !== null || child.signalCode !== null)
      exited(child.exitCode, child.signalCode)
    else check()
  })
}

export function createIsolatedEnv(root = tmpdir()): IsolatedEnv {
  const base = join(
    root,
    `${E2E_TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const env = {
    tempDir: base,
    homeDir: join(base, 'home'),
    configDir: join(base, 'config'),
    dataDir: join(base, 'data'),
    cacheDir: join(base, 'cache'),
    workdir: join(base, 'work'),
    quotaFeedDir: join(base, 'quota-header-feed'),
  }
  try {
    for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(base, RUN_PID_FILE), String(process.pid))
    env.workdir = realpathSync(env.workdir)
    writeFileSync(join(env.workdir, 'sample.txt'), 'hello from sample file\n')
    activeRunDirs.add(resolve(base))
    return env
  } catch (error) {
    if (isExpectedE2ETempDir(base, root)) {
      rmSync(base, { recursive: true, force: true })
    }
    throw error
  }
}

function writeConfigs(env: IsolatedEnv, options: SpawnOptions) {
  writeFileSync(
    join(env.configDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugin: [`file://${PLUGIN_ENTRY}`],
        autoupdate: false,
        compaction: { auto: false, prune: false },
        permission: { read: 'allow', bash: 'allow', edit: 'allow' },
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(env.configDir, 'anthropic-auth.json'),
    JSON.stringify(
      {
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [],
        quota: { enabled: false },
        refresh: { enabled: false },
        ...(options.quotaFeed ? { quotaHeaderFeed: { enabled: true } } : {}),
        ...(options.hybridCache
          ? { claudeCache: { enabled: true, mode: 'hybrid' } }
          : {}),
        ...(options.relay
          ? {
              relay: {
                enabled: true,
                url: options.relay.url,
                token: options.relay.token,
                transport: options.relay.transport,
                fallbackToDirect: false,
              },
            }
          : {}),
      },
      null,
      2,
    ),
  )
}

async function waitForReady(
  url: string,
  getLogs: () => { stdout: string; stderr: string },
  signal: AbortSignal,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  let readySince = 0

  while (Date.now() < deadline) {
    signal.throwIfAborted()
    const logs = getLogs()
    const combinedLogs = `${logs.stdout}\n${logs.stderr}`
    const migrationStarted = combinedLogs.includes('database migration')
    const migrationDone =
      combinedLogs.includes('Database migration complete') ||
      combinedLogs.includes('sqlite-migration:done')

    try {
      const response = await fetch(`${url}/global/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      })
      const serverAcceptsRequests = response.ok || response.status === 401
      if (serverAcceptsRequests && (!migrationStarted || migrationDone)) {
        readySince ||= Date.now()
        if (Date.now() - readySince >= 1_000) return
      } else {
        readySince = 0
      }
    } catch (error) {
      signal.throwIfAborted()
      readySince = 0
      lastError = error
    }
    await delay(200, undefined, { signal })
  }
  throw new Error(`opencode serve did not become ready: ${String(lastError)}`)
}

export async function waitForOpencodeReady(
  child: ChildProcess,
  url: string,
  getLogs: () => { stdout: string; stderr: string },
  timeoutMs = 60_000,
): Promise<void> {
  const controller = new AbortController()
  const exited = (code: number | null, signal: NodeJS.Signals | null) => {
    controller.abort(
      new Error(
        `opencode exited before readiness at ${url} (code=${code}, signal=${signal})`,
      ),
    )
  }
  const failed = (error: Error) => controller.abort(error)
  child.once('exit', exited)
  child.once('error', failed)
  if (child.exitCode !== null || child.signalCode !== null) {
    exited(child.exitCode, child.signalCode)
  }
  try {
    await waitForReady(url, getLogs, controller.signal, timeoutMs)
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    child.off('exit', exited)
    child.off('error', failed)
  }
}

export async function waitForOpencodeProjectReady(
  child: ChildProcess,
  url: string,
  directory: string,
  timeoutMs = 60_000,
): Promise<void> {
  const controller = new AbortController()
  const exited = (code: number | null, signal: NodeJS.Signals | null) => {
    controller.abort(
      new Error(
        `opencode exited during project bootstrap (code=${code}, signal=${signal})`,
      ),
    )
  }
  const failed = (error: Error) => controller.abort(error)
  child.once('exit', exited)
  child.once('error', failed)
  if (child.exitCode !== null || child.signalCode !== null)
    exited(child.exitCode, child.signalCode)
  try {
    controller.signal.throwIfAborted()
    // /global/health confirms only that the listener is up. OpenCode creates
    // the project and loads its plugins lazily; exercise that real boundary
    // before a test starts timing session.create or Anthropic dispatch.
    const response = await fetch(
      `${url}/config?directory=${encodeURIComponent(directory)}`,
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(Math.max(1, timeoutMs)),
        ]),
      },
    )
    if (!response.ok)
      throw new Error(
        `opencode project bootstrap returned HTTP ${response.status}`,
      )
    await response.body?.cancel()
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    child.off('exit', exited)
    child.off('error', failed)
  }
}

export async function terminateChildProcess(
  child: ChildProcess,
  options: { termTimeoutMs?: number; killExitTimeoutMs?: number } = {},
) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolve) => {
    let termTimer: ReturnType<typeof setTimeout> | undefined
    let killExitTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (exitConfirmed: boolean) => {
      if (settled) return
      settled = true
      if (termTimer) clearTimeout(termTimer)
      if (killExitTimer) clearTimeout(killExitTimer)
      child.off('exit', onExit)
      resolve(exitConfirmed)
    }
    const onExit = () => finish(true)
    child.once('exit', onExit)
    termTimer = setTimeout(() => {
      killExitTimer = setTimeout(() => {
        console.warn(
          'opencode child did not exit after SIGKILL; leaving temp dir for stale cleanup',
        )
        finish(false)
      }, options.killExitTimeoutMs ?? 2000)
      child.kill('SIGKILL')
    }, options.termTimeoutMs ?? 3000)
    child.kill('SIGTERM')
  })
}

export async function cleanupE2ERun(options: {
  child?: ChildProcess
  tempDir: string
  root?: string
  keep?: boolean
  terminationOptions?: { termTimeoutMs?: number; killExitTimeoutMs?: number }
}) {
  const exitConfirmed = options.child
    ? await terminateChildProcess(options.child, options.terminationOptions)
    : true
  if (!exitConfirmed) {
    const childPid = options.child?.pid
    if (
      typeof childPid === 'number' &&
      Number.isInteger(childPid) &&
      childPid > 0
    ) {
      const root = options.root ?? tmpdir()
      if (await handoffRunPid(options.tempDir, root, childPid)) {
        activeRunDirs.delete(resolve(options.tempDir))
      }
    }
    return false
  }
  activeRunDirs.delete(resolve(options.tempDir))
  return removeE2ETempDir(options.tempDir, {
    root: options.root,
    keep: options.keep,
  })
}

type NativeSetupLayout = {
  paths: NativePoolPaths
  hostAuthPath: string
  routingSourcePath: string
  routingDestinationPath: string
}

/**
 * The files offline setup would use for this child: the legacy files the
 * harness gives the plugin through OPENCODE_ANTHROPIC_AUTH_FILE and
 * OPENCODE_ANTHROPIC_AUTH_STATE_FILE, the pool beside them, and OpenCode's
 * auth.json under the child's XDG_DATA_HOME.
 */
async function nativeSetupLayout(env: IsolatedEnv): Promise<NativeSetupLayout> {
  const paths = await resolveNativePoolPaths(
    join(env.configDir, 'anthropic-auth.json'),
    join(env.configDir, 'anthropic-auth-state.json'),
  )
  return {
    paths,
    hostAuthPath: join(env.dataDir, 'opencode', 'auth.json'),
    routingSourcePath: getStickyRoutingStatePath(paths.legacyConfig),
    routingDestinationPath: getStickyRoutingStatePath(paths.config),
  }
}

async function migrateNativeAccounts(input: {
  layout: NativeSetupLayout
  childEnv: Record<string, string>
  fixture: Exclude<NativeAccountFixture, { kind: 'unmigrated' }>
  options: SpawnOptions
  hostStarted: () => boolean
}): Promise<MigratedNativeAccounts> {
  const { layout, fixture } = input
  const { paths } = layout
  if (
    fixture.kind === 'vault' &&
    !input.options.childEnv?.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE
  )
    // Without an explicit connection file, discovery would follow an
    // inherited variable or the default path to a real vault daemon.
    throw new Error(
      'A vault fixture needs OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE in childEnv',
    )
  const hostAuth =
    fixture.kind === 'vault'
      ? { anthropic: custodyTombstoneOAuth('anthropic') }
      : (fixture.hostAuth ?? {
          anthropic: {
            type: 'oauth',
            access: 'test-access-token',
            refresh: 'test-refresh-token',
            expires: Date.now() + 60 * 60 * 1000,
          },
        })
  mkdirSync(dirname(layout.hostAuthPath), { recursive: true })
  writeFileSync(layout.hostAuthPath, JSON.stringify(hostAuth), {
    mode: 0o600,
    flag: 'wx',
  })

  // runNativeMigration calls processFence to confirm no host is running
  // before it reads the legacy files and again before it commits. The child
  // is spawned only after migration returns, so a started host here means
  // the harness order is wrong.
  let fenceChecks = 0
  const processFence = async () => {
    fenceChecks++
    if (input.hostStarted())
      throw new Error('opencode started before its offline migration finished')
  }
  const migrationEnv = { ...input.childEnv }
  const journal = await runNativeMigration({
    paths,
    legacyConfigPath: paths.legacyConfig,
    legacyStatePath: paths.legacyState,
    host: 'opencode',
    hostAuthPath: layout.hostAuthPath,
    routingSourcePath: layout.routingSourcePath,
    routingDestinationPath: layout.routingDestinationPath,
    env: migrationEnv,
    removePiAnthropicAuth: false,
    processFence,
    ...(fixture.kind === 'vault' && {
      custody: {
        discover: () =>
          discoverNativeVaultInventory({
            paths,
            host: 'opencode',
            env: migrationEnv,
          }),
        publishSeed: publishNativeVaultRosterSeed,
        publishRuntimeSeed: publishNativeVaultRuntimeSeed,
      },
    }),
  })
  if (fenceChecks === 0)
    throw new Error('Fixture migration did not check its process fence')
  if (journal.phase !== 'retired')
    throw new Error(`Fixture migration ended in phase ${journal.phase}`)

  const mainAdmission =
    fixture.kind === 'local' ? await admitLocalMain(paths) : undefined
  return {
    paths,
    journal,
    hostAuthPath: layout.hostAuthPath,
    routingDestinationPath: layout.routingDestinationPath,
    ...(mainAdmission && { mainAdmission }),
  }
}

/**
 * The anthropic-auth plugin serves a local OAuth account only when it holds
 * validation evidence for that exact credential version. Its built-in token
 * refresh and account lookup call fixed Anthropic URLs that
 * ANTHROPIC_BASE_URL does not redirect, so the host cannot produce that
 * evidence offline. Before OpenCode is spawned, this function runs the
 * public account runtime with a synthetic refresh and account lookup. They
 * verify the local OAuth account and store validation for the exact
 * credential version they produce. The host then adopts that stored proof
 * and serves the credential without contacting the provider. Account
 * metadata alone does not count as validation.
 */
async function admitLocalMain(
  paths: NativePoolPaths,
): Promise<NativeRefreshResult | undefined> {
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    local: {
      refreshToken: async (request) => {
        if (request.refreshToken !== 'test-refresh-token')
          throw new Error('Fixture token exchange received an unknown login')
        const expiresIn = 8 * 60 * 60
        return {
          access: FIXTURE_ADMITTED_ACCESS_TOKEN,
          refresh: 'test-refresh-token-admitted',
          expires: Date.now() + expiresIn * 1000,
          expiresIn,
        }
      },
      resolveIdentity: async (accessToken) => {
        if (accessToken !== FIXTURE_ADMITTED_ACCESS_TOKEN)
          throw new Error('Fixture account lookup received an unknown token')
        return {
          deviceId: 'e2e-fixture-device',
          sessionId: 'e2e-fixture-session',
          accountUuid: FIXTURE_MAIN_ACCOUNT_UUID as ProviderAccountUuid,
        }
      },
    },
  })
  try {
    const snapshot = await runtime.read()
    const main = snapshot.accounts.find((account) => account.id === 'main')
    // An API-key activation stays under OpenCode's control and creates no
    // pool main account; there is nothing to validate.
    if (main?.source !== 'local' || main.type !== 'oauth') return undefined
    const result = await runtime.authorizeLocal('main', { intent: 'serve' })
    if (result.status !== 'usable')
      throw new Error(
        `Fixture main account was not admitted: ${JSON.stringify(result)}`,
      )
    return result
  } finally {
    runtime.close()
  }
}

/**
 * Environment variable naming an installed copy of
 * fixtures/opencode1-config-deps. OpenCode tries to install its plugin SDK,
 * @opencode-ai/plugin, in each of its config directories before it loads
 * plugins, which needs registry access. When this variable is set, the
 * harness instead fills those isolated directories with the genuine pinned
 * packages from that fixture. When it is unset, OpenCode installs the SDK
 * itself.
 */
export const OPENCODE_CONFIG_DEPS_ENV =
  'ANTHROPIC_AUTH_E2E_OPENCODE_CONFIG_DEPS'

type LockEntry = { version?: string; integrity?: string; optional?: boolean }
type LockFile = {
  packages?: Record<
    string,
    LockEntry & { dependencies?: Record<string, string> }
  >
}

function readJsonFile<T>(path: string): Promise<T> {
  return readFile(path, 'utf8').then((text) => JSON.parse(text) as T)
}

function rootDependencyNames(manifest: Record<string, unknown> | undefined) {
  const names = new Set<string>()
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const value = manifest?.[field]
    if (value && typeof value === 'object')
      for (const name of Object.keys(value)) names.add(name)
  }
  return names
}

/**
 * Check that `fixture` holds a complete install of its own lockfile before
 * anything is copied. A missing or partial tree must fail here: OpenCode
 * skips its own install whenever node_modules exists and the lockfile root
 * names every declared dependency, so a broken copy would otherwise surface
 * only as a plugin load failure inside the host.
 */
export async function verifyOpencodeConfigDependencies(fixture: string) {
  const manifest = await readJsonFile<Record<string, unknown>>(
    join(fixture, 'package.json'),
  )
  const lock = await readJsonFile<LockFile>(join(fixture, 'package-lock.json'))
  const installed = await readJsonFile<LockFile>(
    join(fixture, 'node_modules', '.package-lock.json'),
  ).catch(() => {
    throw new Error(`${fixture} has no npm-installed node_modules`)
  })
  const declared = rootDependencyNames(manifest)
  const locked = rootDependencyNames(lock.packages?.[''])
  if (!declared.has('@opencode-ai/plugin'))
    throw new Error(
      `${fixture}/package.json does not declare @opencode-ai/plugin`,
    )
  for (const name of declared)
    if (!locked.has(name))
      throw new Error(`${fixture}/package-lock.json root does not lock ${name}`)
  const verified: string[] = []
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key) continue
    const present = installed.packages?.[key]
    // npm installs only the optional platform packages that match this
    // machine; an absent optional package is expected, a different one is not.
    if (!present && entry.optional) continue
    if (
      !present ||
      present.version !== entry.version ||
      present.integrity !== entry.integrity
    )
      throw new Error(
        `${fixture}: installed ${key} does not match the committed lockfile`,
      )
    const files = await readJsonFile<{ version?: string }>(
      join(fixture, key, 'package.json'),
    ).catch(() => undefined)
    if (files?.version !== entry.version)
      throw new Error(`${fixture}: ${key} is not on disk at ${entry.version}`)
    verified.push(`${key}@${entry.version}`)
  }
  const plugin = await readJsonFile<{
    version?: string
    exports?: Record<string, unknown>
  }>(join(fixture, 'node_modules', '@opencode-ai', 'plugin', 'package.json'))
  const declaredPlugin = (
    manifest.dependencies as Record<string, string> | undefined
  )?.['@opencode-ai/plugin']
  if (plugin.version !== declaredPlugin)
    throw new Error(
      `${fixture}: @opencode-ai/plugin ${plugin.version} is installed, ${declaredPlugin} is declared`,
    )
  const entry = (plugin.exports?.['.'] as { import?: unknown } | undefined)
    ?.import
  if (
    typeof entry !== 'string' ||
    !(await lstat(
      join(fixture, 'node_modules', '@opencode-ai', 'plugin', entry),
    ).then(
      (info) => info.isFile() && info.size > 0,
      () => false,
    ))
  )
    throw new Error(`${fixture}: @opencode-ai/plugin has no entry file`)
  return { declared: [...declared], verified }
}

async function isDirectory(path: string) {
  return lstat(path).then(
    (info) => info.isDirectory() && !info.isSymbolicLink(),
    () => false,
  )
}

/**
 * OpenCode 1.18.18 installs its plugin SDK in each config directory it finds.
 * Include the XDG and explicit config directories, HOME/.opencode if it exists,
 * and every existing .opencode directory from the project up to the fixture's
 * temporary root. Reject paths outside that root before copying dependencies
 * so this setup cannot write into the developer's own configuration.
 */
export async function opencodeConfigDependencyTargets(
  env: IsolatedEnv,
  childEnv: Record<string, string>,
) {
  const candidates = [
    join(childEnv.XDG_CONFIG_HOME ?? '', 'opencode'),
    childEnv.OPENCODE_CONFIG_DIR ?? '',
  ]
  for (let dir = env.workdir; ; dir = dirname(dir)) {
    if (await isDirectory(join(dir, '.opencode')))
      candidates.push(join(dir, '.opencode'))
    if (resolve(dir) === resolve(env.tempDir) || dirname(dir) === dir) break
  }
  if (await isDirectory(join(childEnv.HOME ?? '', '.opencode')))
    candidates.push(join(childEnv.HOME ?? '', '.opencode'))
  const targets = [...new Set(candidates.map((dir) => resolve(dir)))]
  for (const target of targets) {
    const inside = relative(resolve(env.tempDir), target)
    if (!inside || inside.startsWith('..') || inside.startsWith(sep))
      throw new Error(
        `OpenCode config directory ${target} is outside the run's temp root`,
      )
  }
  return targets
}

/** Copy the verified dependency fixture into each OpenCode config directory. */
export async function seedOpencodeConfigDependencies(
  env: IsolatedEnv,
  childEnv: Record<string, string>,
  fixture: string,
) {
  const verified = await verifyOpencodeConfigDependencies(fixture)
  const targets = await opencodeConfigDependencyTargets(env, childEnv)
  for (const target of targets) {
    await mkdir(target, { recursive: true })
    for (const name of ['package.json', 'package-lock.json', 'node_modules'])
      await cp(join(fixture, name), join(target, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      })
  }
  return { ...verified, targets }
}

export async function spawnOpencode(
  options: SpawnOptions,
): Promise<SpawnedOpencode> {
  await sweepStaleE2ETempDirs()
  const env = createIsolatedEnv()
  let child: ChildProcess | undefined
  let spawnError: Error | undefined
  let stdout = ''
  let stderr = ''
  try {
    // The child owns allocation. Never reserve/release a port in the parent
    // or probe an address before this child has announced its bound listener.
    const requestedPort = options.port ?? 0
    writeConfigs(env, options)
    await options.beforeSpawn?.(env)

    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value == null) continue
      if (key === 'OPENCODE_SERVER_PASSWORD') continue
      if (key === 'OPENCODE_SERVER_USERNAME') continue
      if (key === 'NODE_ENV') continue
      childEnv[key] = value
    }
    childEnv.OPENCODE_CONFIG_DIR = env.configDir
    childEnv.OPENCODE_ANTHROPIC_AUTH_FILE = join(
      env.configDir,
      'anthropic-auth.json',
    )
    childEnv.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
      env.configDir,
      'anthropic-auth-state.json',
    )
    childEnv.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
      env.configDir,
      'sidebar-state.json',
    )
    childEnv.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(env.tempDir, 'rpc')
    childEnv.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
      env.configDir,
      'claustrum-enrollment.json',
    )
    childEnv.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = join(env.tempDir, 'dumps')
    childEnv.OPENCODE_ANTHROPIC_AUTH_LOG_FILE = join(
      env.tempDir,
      'opencode-anthropic-auth.log',
    )
    if (options.quotaFeed) {
      childEnv.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = env.quotaFeedDir
    } else {
      delete childEnv.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR
    }
    childEnv.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
    if (options.fallbackMode) {
      childEnv.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE = options.fallbackMode
    } else {
      delete childEnv.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    }
    // XDG isolation alone is insufficient: OpenCode also reads ~/.opencode
    // and ~/.claude/skills during lazy project bootstrap. Keep those reads
    // inside the test run, away from the operator's live configuration.
    childEnv.HOME = env.homeDir
    childEnv.USERPROFILE = env.homeDir
    childEnv.XDG_CONFIG_HOME = env.configDir
    childEnv.XDG_DATA_HOME = env.dataDir
    childEnv.XDG_CACHE_HOME = env.cacheDir
    if (options.childTmpDir) {
      // Cover all platform temp-dir aliases: POSIX reads TMPDIR; Windows
      // resolves TEMP/TMP first, so leaving them inherited would let the
      // child escape the fake temp root there.
      childEnv.TMPDIR = options.childTmpDir
      childEnv.TEMP = options.childTmpDir
      childEnv.TMP = options.childTmpDir
    }
    childEnv.OPENCODE_AUTH_CONTENT = JSON.stringify({
      anthropic: {
        type: 'oauth',
        access: 'test-access-token',
        refresh: 'test-refresh-token',
        expires: Date.now() + 60 * 60 * 1000,
      },
    })
    const nativeAccounts = options.nativeAccounts ?? { kind: 'local' }
    const nativeLayout =
      nativeAccounts.kind === 'unmigrated'
        ? undefined
        : await nativeSetupLayout(env)
    if (nativeLayout) {
      // Offline setup moves the synthetic OAuth credentials into this test's
      // common-auth account pool. OpenCode's auth.json retains only a non-secret
      // OAuth activation value, which the host must read from disk. Remove the
      // inherited OPENCODE_AUTH_CONTENT override: it supplies an auth snapshot
      // instead, and the plugin refuses that credential source. A deliberate
      // test override applied below still reaches migration's refusal check.
      delete childEnv.OPENCODE_AUTH_CONTENT
      // Session-to-account assignments move from the old sidecar directory
      // to nativeLayout.routingDestinationPath during migration. Give the
      // child that exact destination so it does not reopen the retired file.
      childEnv.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE =
        nativeLayout.routingDestinationPath
    }
    if (nativeAccounts.kind === 'unmigrated' && nativeAccounts.hostAuth)
      // This fixture must refuse because offline credential migration has not
      // run. Read the synthetic auth.json from disk; an environment snapshot
      // would trigger a different credential-source refusal first.
      delete childEnv.OPENCODE_AUTH_CONTENT
    childEnv.ANTHROPIC_BASE_URL = options.anthropicBaseURL
    childEnv.ANTHROPIC_API_KEY = 'test-key-not-real'
    for (const [key, value] of Object.entries(options.childEnv ?? {})) {
      if (value === undefined) delete childEnv[key]
      else childEnv[key] = value
    }
    // Import the synthetic OAuth credentials into the test-only common-auth
    // pool before starting OpenCode. Use the final child environment, after
    // test overrides, so setup and serving resolve the same account paths
    // and forbidden auth snapshots cannot bypass the migration guard.
    const native =
      nativeLayout && nativeAccounts.kind !== 'unmigrated'
        ? await migrateNativeAccounts({
            layout: nativeLayout,
            childEnv,
            fixture: nativeAccounts,
            options,
            hostStarted: () => child !== undefined,
          })
        : undefined
    if (nativeAccounts.kind === 'unmigrated' && nativeAccounts.hostAuth) {
      if (childEnv.OPENCODE_AUTH_CONTENT !== undefined)
        throw new Error(
          'An unmigrated fixture with hostAuth must not set OPENCODE_AUTH_CONTENT',
        )
      const hostAuthPath = join(env.dataDir, 'opencode', 'auth.json')
      mkdirSync(dirname(hostAuthPath), { recursive: true })
      writeFileSync(hostAuthPath, JSON.stringify(nativeAccounts.hostAuth), {
        mode: 0o600,
        flag: 'wx',
      })
    }

    const configDependencies = process.env[OPENCODE_CONFIG_DEPS_ENV]
    if (configDependencies)
      await seedOpencodeConfigDependencies(env, childEnv, configDependencies)

    child = spawn(
      'opencode',
      ['serve', '--port', String(requestedPort), '--hostname', '127.0.0.1'],
      { cwd: env.workdir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const spawnFailure = new Promise<never>((_, reject) => {
      child?.once('error', (error) => {
        spawnError = error
        reject(error)
      })
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const deadline = Date.now() + 60_000
    const { url, port } = await Promise.race([
      waitForOpencodeListening(child, () => stdout, deadline - Date.now()),
      spawnFailure,
    ])
    if (requestedPort !== 0 && requestedPort !== port)
      throw new Error('opencode announced a different port than requested')
    await Promise.race([
      waitForOpencodeReady(
        child,
        url,
        () => ({ stdout, stderr }),
        deadline - Date.now(),
      ),
      spawnFailure,
    ])
    await waitForOpencodeProjectReady(
      child,
      url,
      env.workdir,
      deadline - Date.now(),
    )
    return {
      url,
      port,
      env,
      native,
      stdout: () => stdout,
      stderr: () => stderr,
      kill: async () => {
        await cleanupE2ERun({
          child,
          tempDir: env.tempDir,
          keep: process.env.ANTHROPIC_AUTH_E2E_KEEP_TMP === '1',
        })
      },
    }
  } catch (error) {
    await cleanupE2ERun({
      child: spawnError ? undefined : child,
      tempDir: env.tempDir,
      keep: process.env.ANTHROPIC_AUTH_E2E_KEEP_TMP === '1',
    })
    if (!child) throw error
    throw new Error(
      `opencode serve failed to start (${env.tempDir})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n${String(error)}`,
    )
  }
}
