import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getHostDataHome } from './host-paths.ts'
import {
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  isOwnerOnly,
  readWindowsOwnerOnly,
} from './owner-only.ts'
import { renameWithWindowsSharingRetry } from './publication-rename.ts'

const FILE = /^[a-f0-9]{64}\.json$/
const TEMP = /^[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/
const HASH = /^[a-f0-9]{64}$/
const MAX_RECORD_BYTES = 4096
const MAX_SESSIONS = 1024
const READ_TIMEOUT_MS = 50
const SWEEP_INTERVAL_MS = 60_000
const LONG_LIFETIME_MS = 3_600_000

export type MessageThreadTailHost = 'opencode2' | 'pi'

export interface FullCacheTail {
  identity: string
  messageIndex: number
  blockPath: number[]
  prefix: string
  control: { type: 'ephemeral'; ttl?: '1h' | '5m' }
  acceptedAt: number
}

interface Entry {
  continued: boolean
  tail: FullCacheTail
}

export function fullCacheTailExpired(
  tail: FullCacheTail,
  now: number,
): boolean {
  return (
    now < tail.acceptedAt ||
    now >=
      tail.acceptedAt + (tail.control.ttl === '1h' ? LONG_LIFETIME_MS : 300_000)
  )
}

function entryFromBytes(bytes: Buffer): Entry | undefined {
  if (bytes.length > MAX_RECORD_BYTES) return undefined
  const value = JSON.parse(bytes.toString('utf8')) as Partial<Entry> & {
    v?: number
  }
  const tail = value?.tail
  if (
    value?.v !== 1 ||
    typeof value.continued !== 'boolean' ||
    !tail ||
    typeof tail.identity !== 'string' ||
    !HASH.test(tail.identity) ||
    typeof tail.prefix !== 'string' ||
    !HASH.test(tail.prefix) ||
    !Number.isSafeInteger(tail.messageIndex) ||
    tail.messageIndex < 0 ||
    !Array.isArray(tail.blockPath) ||
    !tail.blockPath.length ||
    !tail.blockPath.every(
      (index) => Number.isSafeInteger(index) && index >= 0,
    ) ||
    tail.control?.type !== 'ephemeral' ||
    (tail.control.ttl !== undefined &&
      tail.control.ttl !== '1h' &&
      tail.control.ttl !== '5m') ||
    !Number.isSafeInteger(tail.acceptedAt) ||
    tail.acceptedAt < 0
  )
    return undefined
  return {
    continued: value.continued,
    tail: {
      identity: tail.identity,
      messageIndex: tail.messageIndex,
      blockPath: tail.blockPath,
      prefix: tail.prefix,
      control: {
        type: 'ephemeral',
        ...(tail.control.ttl && { ttl: tail.control.ttl }),
      },
      acceptedAt: tail.acceptedAt,
    },
  }
}

/** Saves where each accepted full request marked its prefix, without saving the request. */
export class MessageThreadTailStore {
  readonly directory: string
  private writes: Promise<void> = Promise.resolve()
  private nextSweep = 0

  constructor(
    host: MessageThreadTailHost,
    root = getHostDataHome(),
    private readonly now = Date.now,
  ) {
    this.directory = join(
      root,
      'cortexkit',
      'anthropic-auth',
      'thread-tails',
      host,
    )
  }

  private pathFor(session: string): string {
    const key = createHash('sha256').update(session).digest('hex')
    return join(this.directory, `${key}.json`)
  }

  private async directoryReady(create: boolean): Promise<boolean> {
    if (create && !(await ensureWindowsOwnerOnlyDirectory(this.directory)))
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.directory)
    return (
      stat.isDirectory() &&
      (await isOwnerOnly(
        this.directory,
        () => stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
      ))
    )
  }

  private async read(path: string, stat: Stats): Promise<Entry | undefined> {
    if (
      !stat.isFile() ||
      stat.size > MAX_RECORD_BYTES ||
      !(await isOwnerOnly(
        path,
        () => stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600,
      ))
    )
      return undefined
    try {
      const windows = await readWindowsOwnerOnly(path)
      if (windows) return entryFromBytes(windows)
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const actual = await file.stat()
        if (
          !actual.isFile() ||
          actual.uid !== process.getuid?.() ||
          (actual.mode & 0o777) !== 0o600 ||
          actual.size > MAX_RECORD_BYTES
        )
          return undefined
        const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1)
        const { bytesRead } = await file.read(bytes)
        return entryFromBytes(bytes.subarray(0, bytesRead))
      } finally {
        await file.close()
      }
    } catch {
      return undefined
    }
  }

  async load(session: string): Promise<Entry | undefined> {
    const path = this.pathFor(session)
    const read = async () => {
      if (!(await this.directoryReady(false))) return undefined
      const stat = await lstat(path)
      const entry = await this.read(path, stat)
      // Return expired records so request preparation still logs `expired`.
      if (entry && fullCacheTailExpired(entry.tail, this.now()))
        this.enqueue(() => this.removeUnchanged(path, stat))
      return entry
    }
    let cancelTimeout: (() => void) | undefined
    try {
      return await Promise.race([
        read().catch(() => undefined),
        new Promise<undefined>((resolve) => {
          const timeout = setTimeout(resolve, READ_TIMEOUT_MS)
          timeout.unref()
          cancelTimeout = () => clearTimeout(timeout)
        }),
      ])
    } finally {
      cancelTimeout?.()
    }
  }

  private enqueue(action: () => Promise<void>): void {
    this.writes = this.writes.then(action).catch(() => {})
  }

  changed(
    session: string,
    tail: FullCacheTail | undefined,
    continued: boolean,
  ) {
    const path = this.pathFor(session)
    this.enqueue(async () => {
      if (!(await this.directoryReady(Boolean(tail)))) return
      const now = this.now()
      if (tail && !fullCacheTailExpired(tail, now)) {
        const data = JSON.stringify({ v: 1, continued, tail })
        if (Buffer.byteLength(data) <= MAX_RECORD_BYTES)
          await this.publish(path, data)
        else await rm(path, { force: true })
      } else await rm(path, { force: true })
      await this.prune(now)
    })
  }

  private async publish(path: string, data: string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      if (!(await createWindowsOwnerOnly(temp, data)))
        await writeFile(temp, data, { flag: 'wx', mode: 0o600 })
      await renameWithWindowsSharingRetry(temp, path)
    } finally {
      await rm(temp, { force: true })
    }
  }

  private async removeUnchanged(path: string, stat: Stats): Promise<void> {
    const current = await lstat(path).catch(() => undefined)
    // Another host process may have published a newer file since the scan.
    if (
      current?.dev === stat.dev &&
      current.ino === stat.ino &&
      current.ctimeMs === stat.ctimeMs
    )
      await rm(path, { force: true })
  }

  private async prune(now: number): Promise<void> {
    const names = await readdir(this.directory)
    const files = names.filter((name) => FILE.test(name))
    const sweep = now >= this.nextSweep
    if (!sweep && files.length <= MAX_SESSIONS) return
    if (sweep) this.nextSweep = now + SWEEP_INTERVAL_MS
    const candidates = sweep
      ? [...files, ...names.filter((name) => TEMP.test(name))]
      : files
    const live: { path: string; stat: Stats }[] = []
    for (let i = 0; i < candidates.length; i += 32) {
      await Promise.all(
        candidates.slice(i, i + 32).map(async (name) => {
          const path = join(this.directory, name)
          const stat = await lstat(path).catch(() => undefined)
          if (!stat?.isFile()) return
          if (TEMP.test(name)) {
            if (stat.mtimeMs <= Date.now() - LONG_LIFETIME_MS)
              await this.removeUnchanged(path, stat)
            return
          }
          if (sweep) {
            const entry = await this.read(path, stat)
            if (!entry || fullCacheTailExpired(entry.tail, now)) {
              await this.removeUnchanged(path, stat)
              return
            }
          }
          live.push({ path, stat })
        }),
      )
    }
    live.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    for (const { path, stat } of live.slice(MAX_SESSIONS))
      await this.removeUnchanged(path, stat)
  }

  async drain(): Promise<void> {
    await this.writes
  }
}
