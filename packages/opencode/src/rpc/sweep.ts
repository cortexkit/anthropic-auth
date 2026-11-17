import { lstat, readdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { logger, processStartedAtMs } from '@cortexkit/anthropic-auth-core'
import { getRpcRoot } from './rpc-dir'

const SWEEP_STATE = Symbol.for('cortexkit.anthropic-auth.rpc-sweep')
const INTERVAL_MS = 60_000
const MANAGED_DIR = /^[0-9a-f]{16}$/

export interface RpcSweepState {
  lastFull?: number
}

export interface RpcSweepOptions {
  root?: string
  now?: () => number
  /** Signal-zero probe: only the OS "no such process" error proves a process dead. */
  probe?: (pid: number) => void
  processStartedAtMs?: (pid: number) => Promise<number | null>
  state?: RpcSweepState
  log?: (name: string) => void
}

function globalState(): RpcSweepState {
  const shared = globalThis as typeof globalThis & {
    [SWEEP_STATE]?: RpcSweepState
  }
  shared[SWEEP_STATE] ??= {}
  return shared[SWEEP_STATE]
}

function code(error: unknown): unknown {
  return (error as NodeJS.ErrnoException | null)?.code
}

function pidNumber(text: string): number | undefined {
  const pid = Number(text)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/** Best-effort cleanup; callers may detach it without an unhandled rejection. */
export async function sweepRpcState(
  activeDir: string,
  options: RpcSweepOptions = {},
): Promise<void> {
  let failure: string | undefined
  const failed = (name: string, error: unknown) => {
    if (code(error) !== 'ENOENT') failure ??= name
  }
  try {
    const root = resolve(options.root ?? getRpcRoot())
    const active = resolve(activeDir)
    // An override outside the managed root must not turn its parent into a sweep root.
    if (dirname(active) !== root || !MANAGED_DIR.test(basename(active))) return
    const now = (options.now ?? Date.now)()
    const state = options.state ?? globalState()
    const full =
      state.lastFull === undefined || now - state.lastFull >= INTERVAL_MS
    // Reserve before any await so simultaneous project starts share one sweep.
    if (full) state.lastFull = now
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return
    const probe = options.probe ?? ((pid: number) => process.kill(pid, 0))
    const startTime = options.processStartedAtMs ?? processStartedAtMs
    const dead = async (pid: number, written?: unknown): Promise<boolean> => {
      try {
        probe(pid)
      } catch (error) {
        // Permission failures and unknown errors are not proof of death.
        return code(error) === 'ESRCH'
      }
      if (
        typeof written !== 'number' ||
        !Number.isFinite(written) ||
        written < 0 ||
        written > now
      )
        return false
      try {
        const start = await startTime(pid)
        return (
          start !== null && Number.isFinite(start) && start > written + 2_000
        )
      } catch {
        return false
      }
    }
    const names = full
      ? await readdir(root)
      : dirname(active) === root
        ? [basename(active)]
        : []
    for (const dirName of names) {
      if (!MANAGED_DIR.test(dirName)) continue
      const dir = join(root, dirName)
      try {
        const stat = await lstat(dir)
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue
        for (const name of await readdir(dir)) {
          const record = /^port-(\d+)\.json$/.exec(name)
          const temp = /^port-(\d+)\.json\.(\d+)\.tmp$/.exec(name)
          const pid = pidNumber(temp?.[2] ?? record?.[1] ?? '')
          if (pid === undefined || (!record && !temp)) continue
          const path = join(dir, name)
          try {
            const file = await lstat(path)
            if (!file.isFile() || file.isSymbolicLink()) continue
            let written: unknown
            let text: string | undefined
            if (record) {
              text = await readFile(path, 'utf8')
              let value: unknown
              let parsed = false
              try {
                value = JSON.parse(text)
                parsed = true
              } catch {}
              if (parsed) {
                if (
                  typeof value !== 'object' ||
                  value === null ||
                  !('pid' in value) ||
                  value.pid !== pid
                )
                  continue
                // An explicitly invalid time is not replaced by an older mtime.
                written =
                  'startedAt' in value
                    ? value.startedAt
                    : 'registeredAt' in value
                      ? value.registeredAt
                      : file.mtimeMs
              } else written = file.mtimeMs
            }
            // Temporary files have no trustworthy record; only a dead writer clears them.
            if (await dead(pid, written)) {
              // A new writer may have replaced a stale record during the OS lookup.
              if (record && (await readFile(path, 'utf8')) !== text) continue
              const current = await lstat(path)
              if (
                current.isFile() &&
                current.dev === file.dev &&
                current.ino === file.ino &&
                current.size === file.size &&
                current.mtimeMs === file.mtimeMs &&
                current.ctimeMs === file.ctimeMs
              )
                await unlink(path)
            }
          } catch (error) {
            failed(`${dirName}/${name}`, error)
          }
        }
        try {
          await rmdir(dir)
        } catch (error) {
          if (code(error) !== 'ENOTEMPTY' && code(error) !== 'EEXIST')
            failed(dirName, error)
        }
      } catch (error) {
        failed(dirName, error)
      }
    }
  } catch (error) {
    failed('.', error)
  }
  if (failure !== undefined) {
    try {
      const log =
        options.log ??
        ((name: string) =>
          logger.debug('rpc', 'RPC state cleanup failed', { name }))
      log(failure)
    } catch {}
  }
}
