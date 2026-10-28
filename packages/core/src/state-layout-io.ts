import { createHash } from 'node:crypto'
import {
  lstat,
  open,
  readFile,
  rename as renameFile,
  unlink as unlinkFile,
} from 'node:fs/promises'
import {
  acquireRefreshFileLock,
  LockContentionError,
  type RefreshFileLock,
} from '@cortexkit/common-auth/fs'
import { POOL_LOCK_DEFAULTS } from '@cortexkit/common-auth/store'

import {
  type NativeLockEvent,
  nativeLockObserver,
} from './native-lock-observer.ts'
import { createWindowsOwnerOnly, type OwnerOnlyOptions } from './owner-only.ts'
import { renameWithWindowsSharingRetry } from './publication-rename.ts'

/**
 * The filesystem calls a layout transition makes, so tests can fail one, drop
 * one, or record their order. Production uses `node:fs`.
 */
export interface StateLayoutFs {
  readonly platform: NodeJS.Platform
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  /**
   * Make a directory's entries durable. On Windows Node can't flush a
   * directory, so this does nothing there: renames rely on NTFS applying
   * metadata changes in the order they were made.
   */
  syncDirectory(dir: string): Promise<void>
  /** Flush a file's bytes to disk. Defaults to `syncFile`. */
  syncFile?: (path: string) => Promise<void>
  /**
   * Create a file owner-only and exclusively with `bytes`, flushed. Defaults
   * to `writeOwnerOnlyExclusive` for `platform`.
   */
  createOwnerOnly?: (path: string, bytes: Uint8Array) => Promise<void>
  /** Retry pacing for Windows sharing violations. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Create a file owner-only through `fs`. */
export function createOwnerOnlyFile(
  fs: StateLayoutFs,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  return fs.createOwnerOnly
    ? fs.createOwnerOnly(path, bytes)
    : writeOwnerOnlyExclusive(path, bytes, fs.platform)
}

/** Flush a file's bytes to disk. */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectoryPosix(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function defaultStateLayoutFs(
  platform: NodeJS.Platform = process.platform,
): StateLayoutFs {
  return {
    platform,
    rename: renameFile,
    unlink: unlinkFile,
    syncDirectory: (dir) =>
      platform === 'win32' ? Promise.resolve() : syncDirectoryPosix(dir),
    syncFile,
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** What a path holds, by content hash. */
export type FileDigest =
  | { readonly status: 'absent' }
  | { readonly status: 'file'; readonly sha256: string }

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Hash a regular file without following a symlink at the path. Anything other
 * than an absent path or a regular file is refused: the mover only ever
 * handles files it can prove are plain data files.
 */
export async function digestFile(path: string): Promise<FileDigest> {
  try {
    const info = await lstat(path)
    if (!info.isFile())
      throw new Error(`anthropic-auth state file ${path} is not a regular file`)
    return { status: 'file', sha256: sha256Hex(await readFile(path)) }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { status: 'absent' }
    throw error
  }
}

/** The sha256 of a regular file, or null when the path is absent. */
export async function fileSha256(path: string): Promise<string | null> {
  const digest = await digestFile(path)
  return digest.status === 'file' ? digest.sha256 : null
}

/**
 * Create `path` owner-only and exclusively, write `bytes`, and flush them.
 * On POSIX the file is created `0600`; on Windows the native helper sets a
 * protected owner-only DACL before any byte is written. The file never exists
 * with wider permissions, so no later `chmod` is needed.
 */
export async function writeOwnerOnlyExclusive(
  path: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform,
  options: { ownership?: OwnerOnlyOptions; open?: typeof open } = {},
): Promise<void> {
  if (platform === 'win32') {
    // Native creation verifies, writes and flushes the same owner-only handle.
    // Reopening that file to truncate it is unnecessary and can fail with EINVAL.
    await createWindowsOwnerOnly(path, bytes, {
      ...options.ownership,
      platform,
    })
    return
  }
  const handle = await (options.open ?? open)(path, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** A target changed between the check before a destructive step and the step. */
export class StateLayoutOwnershipError extends Error {
  readonly path: string
  constructor(path: string, detail: string) {
    super(`anthropic-auth state file ${path} changed: ${detail}`)
    this.name = 'StateLayoutOwnershipError'
    this.path = path
  }
}

/**
 * One destructive step of a layout transition: a rename onto a final name or
 * an unlink. Before the first attempt every lease is asserted and `expect`
 * checks that the slot still holds what the phase recorded; a mismatch throws
 * `StateLayoutOwnershipError` and nothing is changed. On Windows a sharing
 * violation is retried for up to 500 ms, and each retry asserts the leases and
 * repeats `expect` first; a mismatch there returns `skipped` without retrying.
 */
export async function publishOwned(
  step:
    | { readonly kind: 'rename'; readonly from: string; readonly to: string }
    | { readonly kind: 'unlink'; readonly path: string },
  guard: {
    assertLeases(): Promise<void>
    /** Resolves to a reason when the slot no longer holds what is expected. */
    expect(): Promise<string | undefined>
  },
  fs: StateLayoutFs,
): Promise<'published' | 'skipped'> {
  const target = step.kind === 'rename' ? step.to : step.path
  await guard.assertLeases()
  const mismatch = await guard.expect()
  if (mismatch !== undefined)
    throw new StateLayoutOwnershipError(target, mismatch)
  const run =
    step.kind === 'rename'
      ? () => fs.rename(step.from, step.to)
      : () => fs.unlink(step.path)
  return renameWithWindowsSharingRetry(
    target,
    target,
    {
      platform: fs.platform,
      rename: run,
      ...(fs.now ? { now: fs.now } : {}),
      ...(fs.sleep ? { sleep: fs.sleep } : {}),
    },
    async () => {
      await guard.assertLeases()
      return (await guard.expect()) === undefined ? 'publish' : 'skip'
    },
  ).then((outcome) => (outcome === 'skipped' ? 'skipped' : 'published'))
}

/** A lock a layout transition takes: `<path>.<name>.lock`. */
export interface StateLayoutLockSpec {
  readonly name: string
  readonly path: string
  readonly ttlMs?: number
  readonly timeoutMs?: number
}

interface HeldLayoutLock {
  readonly spec: StateLayoutLockSpec
  readonly lock: RefreshFileLock
}

/**
 * Locks taken in a fixed order and released in reverse. Each lock is a
 * renewed common-auth file lease, the same kind every pool, runtime, roster
 * and routing writer takes, so holding one excludes those writers in every
 * process. Every acquisition re-asserts the leases already held, because a
 * long wait is exactly when an earlier lease can be lost.
 */
export class StateLayoutLockStack {
  private readonly held: HeldLayoutLock[] = []
  private readonly observe: ((event: NativeLockEvent) => void) | undefined

  constructor(onLockEvent?: (event: NativeLockEvent) => void) {
    this.observe = nativeLockObserver(onLockEvent)
  }

  get size(): number {
    return this.held.length
  }

  /** The names of the held locks, oldest first; for tests and logs. */
  heldLocks(): readonly { name: string; path: string }[] {
    return this.held.map(({ spec }) => ({ name: spec.name, path: spec.path }))
  }

  async acquire(spec: StateLayoutLockSpec): Promise<void> {
    const ttlMs = spec.ttlMs ?? POOL_LOCK_DEFAULTS.ttlMs
    const timeoutMs = spec.timeoutMs ?? POOL_LOCK_DEFAULTS.timeoutMs
    const event = { name: spec.name, path: spec.path }
    this.observe?.({ ...event, type: 'acquiring' })
    const started = performance.now()
    let contended = false
    for (;;) {
      const lock = await acquireRefreshFileLock({
        name: spec.name,
        path: spec.path,
        ttlMs,
        renew: true,
      })
      if (lock) {
        this.held.push({ spec, lock })
        this.observe?.({ ...event, type: 'acquired' })
        await this.assertAll()
        return
      }
      if (!contended) {
        contended = true
        this.observe?.({ ...event, type: 'contended' })
      }
      const remaining = timeoutMs - (performance.now() - started)
      if (remaining <= 0)
        throw new LockContentionError({
          target: spec.path,
          name: spec.name,
          timeoutMs,
        })
      await new Promise<void>((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            remaining,
            POOL_LOCK_DEFAULTS.retryMs + Math.floor(Math.random() * 25),
          ),
        ),
      )
    }
  }

  async assertAll(): Promise<void> {
    for (const { lock } of this.held) await lock.assertOwned()
  }

  /** Release every lock taken after `mark` (an earlier `size`), newest first. */
  async releaseTo(mark: number): Promise<void> {
    let failure: unknown
    while (this.held.length > mark) {
      const entry = this.held.pop()
      if (!entry) break
      try {
        await entry.lock.release()
      } catch (error) {
        failure ??= error
      }
      this.observe?.({
        type: 'released',
        name: entry.spec.name,
        path: entry.spec.path,
      })
    }
    if (failure !== undefined) throw failure
  }

  async releaseAll(): Promise<void> {
    await this.releaseTo(0)
  }
}
