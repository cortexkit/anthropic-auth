import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { type WriterStamp, writerStamp } from '@cortexkit/anthropic-auth-core'

export interface PortFileEntry {
  port: number
  token: string
  pid: number
  startedAt: number
  /**
   * Present in files written by 2.3.0 and later, so a later version can tell
   * them from files of older versions. Older readers ignore it.
   */
  writer?: WriterStamp
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Filesystem operations and retry delay; tests supply controlled races. */
export interface PortFileWriterIo {
  mkdir(dir: string): Promise<void>
  write(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  sleep(ms: number): Promise<void>
}

const writerIo: PortFileWriterIo = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  write: (path, text) =>
    writeFile(path, text, { encoding: 'utf8', mode: 0o600 }),
  rename,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export async function writePortFile(
  dir: string,
  entry: { port: number; token: string; pid: number },
  overrides: Partial<PortFileWriterIo> = {},
): Promise<string> {
  const io = { ...writerIo, ...overrides }
  const full: PortFileEntry = {
    ...entry,
    startedAt: Date.now(),
    writer: writerStamp(),
  }
  const target = join(dir, `port-${entry.pid}.json`)
  const tmp = `${target}.${process.pid}.tmp`
  for (let attempt = 1; ; attempt++) {
    await io.mkdir(dir)
    try {
      await io.write(tmp, JSON.stringify(full))
      await io.rename(tmp, target)
      return target
    } catch (error) {
      // A concurrent sweep or older process may remove an empty project folder.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 5)
        throw error
      await io.sleep(25)
    }
  }
}

export async function discoverPortFile(
  dir: string,
  expectedPid?: number,
): Promise<PortFileEntry | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const live: PortFileEntry[] = []
  for (const name of names) {
    if (!name.startsWith('port-') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(
        await readFile(join(dir, name), 'utf8'),
      ) as PortFileEntry
      if (Number.isFinite(parsed.port)) {
        if (pidAlive(parsed.pid)) live.push(parsed)
        else unlink(join(dir, name)).catch(() => {})
      }
    } catch {}
  }
  if (live.length === 0) return null
  const candidates =
    expectedPid && expectedPid >= 1
      ? live.filter((entry) => entry.pid === expectedPid)
      : []
  const entries = candidates.length > 0 ? candidates : live
  return entries.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}
