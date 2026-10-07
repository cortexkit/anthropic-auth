import { createHash } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

import { parseJsonRedacted } from './json.ts'

export type NativeMigrationSourceRole =
  | 'config'
  | 'state'
  | 'hostAuth'
  | 'routing'

export interface NativeMigrationSourceSnapshot {
  readonly role: NativeMigrationSourceRole
  readonly path: string
  readonly digest: string | null
  readonly data: Readonly<Record<string, unknown>> | undefined
  readonly metadata:
    | {
        readonly uid: number
        readonly mode: number
        readonly device: string
        readonly inode: string
        readonly modified: string
        readonly changed: string
      }
    | undefined
}

export class NativeMigrationSourceError extends Error {
  constructor(
    public readonly role: NativeMigrationSourceRole,
    public readonly code:
      | 'source-io'
      | 'unsafe-source'
      | 'source-changed'
      | 'invalid-source'
      | 'source-too-large',
  ) {
    super(`Anthropic migration ${role} input: ${code}`)
    this.name = 'NativeMigrationSourceError'
  }
}

const MAX_SOURCE_BYTES = 4 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freezeJson(
  root: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const pending: object[] = [root]
  while (pending.length) {
    const item = pending.pop()
    if (!item) continue
    for (const value of Object.values(item)) {
      if (value !== null && typeof value === 'object') pending.push(value)
    }
    Object.freeze(item)
  }
  return root
}

function sourceSnapshot(
  value: NativeMigrationSourceSnapshot,
): NativeMigrationSourceSnapshot {
  // Credential-bearing import data must not enter routine snapshot logging.
  Object.defineProperty(value, 'data', { enumerable: false })
  return Object.freeze(value)
}

interface SourceReadHooks {
  onOpened?: () => Promise<void>
}

/**
 * Capture exact import bytes without the legacy loader's missing-entry recovery.
 * Ownership and legacy schema decisions still belong to the offline importer.
 * Pass the configured path, not a canonicalized leaf: lstat must see any leaf
 * symlink, and the snapshot retains that path for the same guard during recheck.
 */
export async function readNativeMigrationSource(
  role: NativeMigrationSourceRole,
  path: string,
  hooks: SourceReadHooks = {},
): Promise<NativeMigrationSourceSnapshot> {
  const missing = sourceSnapshot({
    role,
    path,
    digest: null,
    data: undefined,
    metadata: undefined,
  })
  let initial: BigIntStats
  try {
    initial = await lstat(path, { bigint: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return missing
    throw new NativeMigrationSourceError(role, 'source-io')
  }
  if (!initial.isFile() || initial.isSymbolicLink())
    throw new NativeMigrationSourceError(role, 'unsafe-source')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    )
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.dev !== initial.dev ||
      before.ino !== initial.ino
    ) {
      throw new NativeMigrationSourceError(role, 'source-changed')
    }
    if (before.size > MAX_SOURCE_BYTES)
      throw new NativeMigrationSourceError(role, 'source-too-large')
    await hooks.onOpened?.()
    const chunks: Buffer[] = []
    let bytes = 0
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024)
      const read = await handle.read(chunk)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > MAX_SOURCE_BYTES)
        throw new NativeMigrationSourceError(role, 'source-too-large')
      chunks.push(chunk.subarray(0, read.bytesRead))
    }
    const after = await handle.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.mode !== after.mode ||
      current.uid !== before.uid ||
      current.gid !== before.gid ||
      current.mode !== before.mode ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.size !== after.size ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.isSymbolicLink() ||
      current.mtimeNs !== before.mtimeNs ||
      current.ctimeNs !== before.ctimeNs ||
      current.size !== before.size ||
      BigInt(bytes) !== before.size
    ) {
      throw new NativeMigrationSourceError(role, 'source-changed')
    }
    const content = Buffer.concat(chunks, bytes)
    let data: unknown
    try {
      data = parseJsonRedacted(
        new TextDecoder('utf-8', { fatal: true }).decode(content),
      )
    } catch {
      throw new NativeMigrationSourceError(role, 'invalid-source')
    }
    if (!isRecord(data))
      throw new NativeMigrationSourceError(role, 'invalid-source')
    return sourceSnapshot({
      role,
      path,
      digest: createHash('sha256').update(content).digest('hex'),
      data: freezeJson(data),
      metadata: Object.freeze({
        uid: Number(before.uid),
        mode: Number(before.mode),
        device: before.dev.toString(),
        inode: before.ino.toString(),
        modified: before.mtimeNs.toString(),
        changed: before.ctimeNs.toString(),
      }),
    })
  } catch (error) {
    if (error instanceof NativeMigrationSourceError) throw error
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ENOENT')
        throw new NativeMigrationSourceError(role, 'source-changed')
      if (error.code === 'ELOOP')
        throw new NativeMigrationSourceError(role, 'unsafe-source')
    }
    if (error instanceof SyntaxError)
      throw new NativeMigrationSourceError(role, 'invalid-source')
    throw new NativeMigrationSourceError(role, 'source-io')
  } finally {
    await handle?.close()
  }
}

/** Rewrites, replacements and permission changes require a new import decision. */
export async function requireUnchangedNativeMigrationSource(
  snapshot: NativeMigrationSourceSnapshot,
): Promise<void> {
  const current = await readNativeMigrationSource(snapshot.role, snapshot.path)
  if (
    current.digest !== snapshot.digest ||
    JSON.stringify(current.metadata) !== JSON.stringify(snapshot.metadata)
  ) {
    throw new NativeMigrationSourceError(snapshot.role, 'source-changed')
  }
}
