import { win32 } from 'node:path'

/**
 * Windows extended-length form for a long absolute path.
 *
 * Node's own `fs` already handles many long absolute paths, but a plain
 * `open`/`readFile` on a state-home path still reaches Windows as `EINVAL`
 * for `open` once the path passes 260 characters on some hosts. The native
 * file helper already uses extended-length paths for the paths it owns.
 * This helper gives the same form to the plain Node `fs`
 * calls in the relocation code, so they keep working regardless of the
 * machine's `LongPathsEnabled` setting.
 *
 * POSIX is unchanged. Short Windows paths, relative paths and paths that
 * already carry an extended-length, UNC or device prefix are returned as-is.
 * Only a long absolute Windows path is resolved (which normalises `.`/`..`
 * and forward slashes, both invalid after the prefix) and given the
 * `\\?\` prefix (`\\?\UNC\` for UNC).
 */
export function windowsLongPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return path
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('\\\\??\\')
  )
    return path
  if (!win32.isAbsolute(path)) return path
  if (path.length < 260) return path
  const resolved = win32.resolve(path)
  if (resolved.startsWith('\\\\?\\')) return resolved
  if (resolved.startsWith('\\\\')) return `\\\\?\\UNC\\${resolved.slice(2)}`
  return `\\\\?\\${resolved}`
}
