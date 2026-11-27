import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { types as utilTypes } from 'node:util'
import type * as PrivateFiles from '@cortexkit/private-files'
import { logger } from './logger.ts'

/** Per-operation injection keeps simulated Windows policy out of process globals. */
export interface OwnerOnlyOptions {
  platform?: NodeJS.Platform
  privateFiles?: Pick<
    typeof PrivateFiles,
    'verifyOwnerOnly' | 'readPrivateFile'
  > &
    Partial<
      Pick<
        typeof PrivateFiles,
        'verifySafeParent' | 'createPrivateFile' | 'createPrivateDirectory'
      >
    >
}

async function windowsBackend(options: OwnerOnlyOptions) {
  if ((options.platform ?? process.platform) !== 'win32') return undefined
  return options.privateFiles ?? import('@cortexkit/private-files')
}

/** POSIX callers retain their exact mode/uid policy; Windows must prove its DACL. */
export async function isOwnerOnly(
  path: string,
  posix: () => boolean,
  options: OwnerOnlyOptions = {},
): Promise<boolean> {
  const api = await windowsBackend(options)
  return api ? (await api.verifyOwnerOnly(path)).ok : posix()
}

/** Windows reads through the ACL-verified native handle, not a pathname reopen. */
export async function readWindowsOwnerOnly(
  path: string,
  options?: OwnerOnlyOptions,
): Promise<Buffer | undefined>
export async function readWindowsOwnerOnly(
  path: string,
  options: OwnerOnlyOptions | undefined,
  unsafeVerdict: 'unsafe-file',
): Promise<Buffer | undefined | 'unsafe-file'>
export async function readWindowsOwnerOnly(
  path: string,
  options: OwnerOnlyOptions = {},
  unsafeVerdict?: 'unsafe-file',
): Promise<Buffer | undefined | 'unsafe-file'> {
  const api = await windowsBackend(options)
  if (!api) return undefined
  const verdict = await api.verifyOwnerOnly(path)
  if (!verdict.ok) {
    // Callers that may discard unsafe files must distinguish a failed check
    // from a check that proved the file unsafe.
    if (verdict.refusal.reason !== 'io-error') {
      if (unsafeVerdict) return unsafeVerdict
      throw new Error('Owner-only storage refused')
    }
    if (unsafeVerdict) throw new Error('Owner-only verification failed')
  }
  try {
    return await api.readPrivateFile(path)
  } catch (error) {
    // Only native file/path-not-found codes prove absence, not a refused ACL.
    const detail = error as { reason?: string; win32Code?: number }
    if (detail.reason === 'io-error' && [2, 3].includes(detail.win32Code ?? 0))
      throw Object.assign(new Error('Private file absent'), { code: 'ENOENT' })
    throw error
  }
}

/** Ancestors protect directory entries; they need not themselves be private. */
export async function isSafeWindowsParent(
  path: string,
  options: OwnerOnlyOptions = {},
): Promise<boolean | undefined> {
  const api = await windowsBackend(options)
  if (!api) return undefined
  if (!api.verifySafeParent) throw new Error('Safe-parent verifier unavailable')
  return (await api.verifySafeParent(path)).ok
}

/** Native creation establishes a protected DACL before any bytes are written. */
export async function createWindowsOwnerOnly(
  path: string,
  bytes: string | Uint8Array,
  options: OwnerOnlyOptions = {},
): Promise<boolean> {
  const api = await windowsBackend(options)
  if (!api) return false
  if (!api.createPrivateFile)
    throw new Error('Private-file creation unavailable')
  await api.createPrivateFile(path, bytes)
  return true
}

/**
 * Create only missing Windows directories; never tighten an existing shared directory.
 * With createMissing disabled, only verify a directory that already exists.
 * Returns false off Windows so callers retain their POSIX directory policy.
 */
export async function ensureWindowsOwnerOnlyDirectory(
  path: string,
  options: OwnerOnlyOptions = {},
  createMissing = true,
): Promise<boolean> {
  const backend = await windowsBackend(options)
  if (!backend) return false
  const api = backend
  const verify = api.verifySafeParent
  if (!verify) throw new Error('Safe-parent verifier unavailable')
  const verifySafeParent = verify
  const refused = (stage: string, reason: string) =>
    Object.assign(new Error('Private directory refused'), {
      code: 'ERR_PRIVATE_FILES_SECURITY',
      stage,
      reason,
    })
  const field = (error: unknown, key: string): unknown => {
    if (error === null || typeof error !== 'object' || utilTypes.isProxy(error))
      return undefined
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  }
  async function exists(directory: string) {
    try {
      const metadata = await lstat(directory)
      if (metadata.isSymbolicLink()) throw refused('verify', 'reparse-point')
      if (!metadata.isDirectory()) throw refused('verify', 'wrong-kind')
      return true
    } catch (error) {
      if (field(error, 'code') === 'ENOENT') return false
      throw error
    }
  }
  async function safe(directory: string) {
    const verdict = await verifySafeParent(directory)
    if (!verdict.ok) {
      const { level, sid, mask } = verdict
      throw Object.assign(refused('safe-parent', verdict.reason), {
        level,
        sid,
        mask,
      })
    }
  }
  async function privateDirectory(directory: string) {
    const verdict = await api.verifyOwnerOnly(directory)
    if (!verdict.ok) throw refused('verify', verdict.refusal.reason)
    await safe(directory)
  }
  async function create(directory: string) {
    const createPrivateDirectory = api.createPrivateDirectory
    if (!createPrivateDirectory)
      throw new Error('Private-directory creation unavailable')
    try {
      await createPrivateDirectory(directory)
    } catch (error) {
      const win32Code = field(error, 'win32Code')
      // Only demonstrated exclusive-create collisions allow adopting a raced directory.
      if (
        field(error, 'code') !== 'EEXIST' &&
        !(
          field(error, 'reason') === 'io-error' &&
          typeof win32Code === 'number' &&
          [80, 183].includes(win32Code)
        )
      )
        throw error
    }
    if (!(await exists(directory))) throw refused('verify', 'io-error')
    await privateDirectory(directory)
  }
  async function ancestors(directory: string): Promise<void> {
    if (await exists(directory)) return safe(directory)
    if (!createMissing) throw refused('safe-parent', 'io-error')
    const parent = dirname(directory)
    if (parent === directory) throw refused('safe-parent', 'io-error')
    await ancestors(parent)
    await create(directory)
  }
  // Existing ancestors need entry integrity; the requested leaf needs confidentiality.
  if (!createMissing) {
    if (await exists(path)) {
      await ancestors(dirname(path))
      await privateDirectory(path)
    }
    return true
  }
  await ancestors(dirname(path))
  if (await exists(path)) await privateDirectory(path)
  else await create(path)
  return true
}

const warnedPrivateDirectories = new Set<string>()

/** Check each plugin-owned component below a trusted base before using its children. */
export async function ensurePrivateDirectory(
  path: string,
  options: {
    base?: string
    createBase?: boolean
    create?: boolean
    area: string
  },
): Promise<boolean> {
  const absolute = resolve(path)
  const base = resolve(options.base ?? dirname(absolute))
  const parts = relative(base, absolute).split(sep)
  const create = options.create !== false
  let directory = base
  try {
    if (!parts[0] || parts[0] === '..' || isAbsolute(parts.join(sep)))
      throw new Error('Private folder is outside its base')
    // The configured data home can be absent on a fresh install. Windows
    // creates missing ancestors through the native ACL backend below.
    if (create && options.createBase && process.platform !== 'win32')
      await mkdir(base, { recursive: true, mode: 0o700 })
    for (const part of parts) {
      directory = join(directory, part)
      let metadata = await lstat(directory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return undefined
      })
      if (!metadata && !create) return false
      if (metadata && !metadata.isDirectory())
        throw new Error('Not a directory')
      if (await ensureWindowsOwnerOnlyDirectory(directory, undefined, create))
        continue
      if (!metadata) {
        try {
          await mkdir(directory, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        metadata = await lstat(directory)
      }
      if (
        !metadata.isDirectory() ||
        metadata.uid !== process.getuid?.() ||
        (metadata.mode & 0o022) !== 0
      )
        throw new Error('Unsafe directory')
      if ((metadata.mode & 0o7777) !== 0o700) await chmod(directory, 0o700)
    }
    return true
  } catch {
    if (!warnedPrivateDirectories.has(directory)) {
      warnedPrivateDirectories.add(directory)
      logger.warn(options.area, 'private directory refused', { directory })
    }
    return false
  }
}
