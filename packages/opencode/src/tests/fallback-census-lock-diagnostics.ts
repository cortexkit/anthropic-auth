import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeAccountRuntime } from '@cortexkit/anthropic-auth-core'
import { lockPathFor } from '@cortexkit/common-auth/fs'

type LockEvent = Parameters<NonNullable<NativeAccountRuntime['onLockEvent']>>[0]
type Acquisition = { fixture: string; pid: number; at: number }
type ObservedLock = {
  path: string
  name: string
  attempts: number
  acquired: number
  released: number
  lastEvent: LockEvent['type']
  events: Array<{ type: LockEvent['type']; at: number; detached: boolean }>
}

// Paths can be reused by fixtures in the same process. These are observations,
// not proof that the process still owns the lease found during a failure.
const acquisitions = new Map<string, Acquisition[]>()

function errorCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code ?? 'unknown')
}

function ownerProcess(content: string | undefined) {
  let pid: unknown
  try {
    const owner = JSON.parse(content ?? '')
    pid = owner.pid ?? owner.ownerPid
  } catch {}
  // Leases from @cortexkit/common-auth have a UUID, not a PID. Never interpret
  // a UUID or the most recent observed acquirer as the actual process owner.
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    return { ownerPid: null, ownerAlive: 'unknown: lease has no valid PID' }
  try {
    process.kill(pid, 0)
    return { ownerPid: pid, ownerAlive: 'yes' }
  } catch (error) {
    const code = errorCode(error)
    return {
      ownerPid: pid,
      ownerAlive:
        code === 'ESRCH' ? 'no' : code === 'EPERM' ? 'yes' : 'unknown',
      ownerProbeError: code,
    }
  }
}

function leaseSnapshot(path: string) {
  try {
    const stat = lstatSync(path)
    const kind = stat.isSymbolicLink()
      ? 'symlink'
      : stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'file'
          : 'other'
    let content: string | undefined
    let readError: string | undefined
    try {
      const ownerPath = kind === 'directory' ? join(path, 'owner.json') : path
      // Failure diagnostics must not follow an unexpected lease symlink.
      if (
        (kind === 'file' || kind === 'directory') &&
        lstatSync(ownerPath).isFile()
      )
        content = readFileSync(ownerPath, 'utf8').slice(0, 4096)
    } catch (error) {
      readError = errorCode(error)
    }
    return {
      path,
      kind,
      mtimeMs: stat.mtimeMs,
      content,
      readError,
      ...ownerProcess(content),
    }
  } catch (error) {
    return { path, readError: errorCode(error), ...ownerProcess(undefined) }
  }
}

/** Collect without I/O on success; read lease evidence synchronously on failure. */
export class CensusLockDiagnostics {
  private readonly locks = new Map<string, ObservedLock>()
  private readonly realNow = Date.now

  constructor(private readonly fixture: string) {}

  readonly observe = (event: LockEvent): void => {
    const key = lockPathFor(event.path, event.name)
    let lock = this.locks.get(key)
    if (!lock) {
      lock = {
        path: event.path,
        name: event.name,
        attempts: 0,
        acquired: 0,
        released: 0,
        lastEvent: event.type,
        events: [],
      }
      this.locks.set(key, lock)
    }
    const at = this.realNow()
    if (event.type === 'acquiring') lock.attempts++
    if (event.type === 'acquired') {
      lock.acquired++
      const history = acquisitions.get(key) ?? []
      history.push({ fixture: this.fixture, pid: process.pid, at })
      if (history.length > 8) history.shift()
      // Refresh insertion order so the bounded history retains recent paths.
      acquisitions.delete(key)
      acquisitions.set(key, history)
      if (acquisitions.size > 256) {
        const oldest = acquisitions.keys().next().value
        if (oldest !== undefined) acquisitions.delete(oldest)
      }
    }
    if (event.type === 'released') lock.released++
    lock.lastEvent = event.type
    lock.events.push({
      type: event.type,
      at,
      detached: event.detached === true,
    })
    if (lock.events.length > 8) lock.events.shift()
  }

  snapshot() {
    return {
      fixture: this.fixture,
      observerPid: process.pid,
      realNow: this.realNow(),
      fixtureNow: Date.now(),
      // Failed acquisition attempts have no terminal observer event. Counters
      // identify candidates, not an assertion that every unmatched wait is live.
      locks: [...this.locks].map(([path, lock]) => ({
        ...lock,
        lease: leaseSnapshot(path),
        evictionMarker: leaseSnapshot(`${path}.evicting`),
        observedAcquisitions: acquisitions.get(path) ?? [],
      })),
    }
  }
}
