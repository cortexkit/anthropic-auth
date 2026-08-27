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
  lstat,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const PLUGIN_ENTRY = join(REPO_ROOT, 'packages/opencode/src/index.ts')
const E2E_TEMP_PREFIX = 'anthropic-auth-e2e-'
const DEFAULT_STALE_AGE_MS = 24 * 60 * 60 * 1000
const RUN_PID_FILE = 'run.pid'
const activeRunDirs = new Set<string>()

export type IsolatedEnv = {
  tempDir: string
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

export type SpawnedOpencode = {
  url: string
  port: number
  env: IsolatedEnv
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
  beforeSpawn?: (env: IsolatedEnv) => void
  childTmpDir?: string
  quotaFeed?: boolean
}

async function pickFreePort() {
  const server = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = server.port ?? 0
  server.stop(true)
  if (!port) throw new Error('could not allocate free port')
  return port
}

export function createIsolatedEnv(root = tmpdir()): IsolatedEnv {
  const base = join(
    root,
    `${E2E_TEMP_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const env = {
    tempDir: base,
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
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  let readySince = 0

  while (Date.now() < deadline) {
    const logs = getLogs()
    const combinedLogs = `${logs.stdout}\n${logs.stderr}`
    const migrationStarted = combinedLogs.includes('database migration')
    const migrationDone =
      combinedLogs.includes('Database migration complete') ||
      combinedLogs.includes('sqlite-migration:done')

    try {
      const response = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(2_000),
      })
      const serverAcceptsRequests = response.ok || response.status === 401
      if (serverAcceptsRequests && (!migrationStarted || migrationDone)) {
        readySince ||= Date.now()
        if (Date.now() - readySince >= 1_000) return
      } else {
        readySince = 0
      }
    } catch (error) {
      readySince = 0
      lastError = error
    }
    await Bun.sleep(200)
  }
  throw new Error(`opencode serve did not become ready: ${String(lastError)}`)
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
    options.beforeSpawn?.(env)
    const port = options.port ?? (await pickFreePort())
    writeConfigs(env, options)

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
    childEnv.ANTHROPIC_BASE_URL = options.anthropicBaseURL
    childEnv.ANTHROPIC_API_KEY = 'test-key-not-real'

    child = spawn(
      'opencode',
      ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
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

    const url = `http://127.0.0.1:${port}`
    await Promise.race([
      waitForReady(url, () => ({ stdout, stderr })),
      spawnFailure,
    ])
    return {
      url,
      port,
      env,
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
      `opencode serve failed to start\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n${String(error)}`,
    )
  }
}
