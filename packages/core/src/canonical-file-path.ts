import type { Stats } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

interface FilePathFs {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<Stats>
  readlink(path: string): Promise<string>
}

interface FilePathFsSync {
  realpathSync(path: string): string
  lstatSync(path: string): Stats
  readlinkSync(path: string): string
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function symlinkLoop(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Too many symbolic links: ${file}`), {
    code: 'ELOOP',
    path: file,
  })
}

// Replace these local helpers with common-auth/fs's canonicalFilePath and
// canonicalFilePathSync when adopting the release that exports them.
// Resolving only the folder avoids Bun returning a deleted inode's pathname
// when another process atomically replaces a file during realpath.
export async function canonicalFilePath(
  file: string,
  fsPromises: FilePathFs,
): Promise<string> {
  let current = resolve(file)
  const seen = new Set<string>()
  for (let hops = 0; ; hops++) {
    let stat: Stats | undefined
    try {
      stat = await fsPromises.lstat(current)
    } catch (error) {
      if (hops !== 0 || !isMissing(error)) throw error
    }
    if (stat?.isDirectory()) return fsPromises.realpath(current)
    const parent = await fsPromises.realpath(dirname(current))
    current = resolve(parent, basename(current))
    if (!stat?.isSymbolicLink()) return current
    if (seen.has(current)) throw symlinkLoop(file)
    seen.add(current)
    if (hops === 40) throw symlinkLoop(file)
    current = resolve(parent, await fsPromises.readlink(current))
  }
}

export function canonicalFilePathSync(
  file: string,
  fs: FilePathFsSync,
): string {
  let current = resolve(file)
  const seen = new Set<string>()
  for (let hops = 0; ; hops++) {
    let stat: Stats | undefined
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (hops !== 0 || !isMissing(error)) throw error
    }
    if (stat?.isDirectory()) return fs.realpathSync(current)
    const parent = fs.realpathSync(dirname(current))
    current = resolve(parent, basename(current))
    if (!stat?.isSymbolicLink()) return current
    if (seen.has(current)) throw symlinkLoop(file)
    seen.add(current)
    if (hops === 40) throw symlinkLoop(file)
    current = resolve(parent, fs.readlinkSync(current))
  }
}
