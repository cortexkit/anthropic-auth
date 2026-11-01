import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import {
  CACHE_KEEP_MAX_BODY_BYTES,
  type CacheKeepTarget,
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  isOwnerOnly,
  logger,
  type OwnerOnlyOptions,
  readWindowsOwnerOnly,
  renameWithWindowsSharingRetry,
} from '@cortexkit/anthropic-auth-core'
import { version as pluginVersion } from '../../package.json'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const FILE = /^[a-f0-9]{64}\.json\.gz$/
const TEMP = /^[a-f0-9]{64}\.json\.gz\.[a-f0-9-]+\.tmp$/
const MAX_RECORD_BYTES = 2 * CACHE_KEEP_MAX_BODY_BYTES + 64 * 1024
// Replay compatibility depends only on the record format, not the plugin
// version. Bump this for format changes; the loader must accept or migrate the
// previous format so updates do not discard still-live caches.
const RECORD_FORMAT_VERSION = 1

export function cacheKeepStoreDirectory(storageId: string, root = tmpdir()) {
  return join(
    root,
    `cortexkit-anthropic-auth-cachekeep-${hash(storageId).slice(0, 16)}`,
  )
}

export type SavedCacheKeepTarget = Pick<
  CacheKeepTarget,
  | 'id'
  | 'bodyText'
  | 'url'
  | 'cacheExpiresAt'
  | 'nextPrewarmAt'
  | 'oauthAccountIdentity'
  | 'isSubagent'
> & { v: typeof RECORD_FORMAT_VERSION; pluginVersion: string }

type DropReason =
  | 'format'
  | 'expired'
  | 'foreign-identity'
  | 'account-gone'
  | 'unsafe-file'
  | 'unreadable'
  | 'unfinished-write'
  | 'invalid'

type Acceptance =
  | boolean
  | 'foreign-identity'
  | 'account-gone'
  | 'invalid'
  | undefined

function record(target: Readonly<CacheKeepTarget>): SavedCacheKeepTarget {
  // Deliberately whitelist fields: transport headers and account credentials
  // must never become part of the restart record, even if tracking gains them.
  return {
    v: RECORD_FORMAT_VERSION,
    pluginVersion,
    id: target.id,
    bodyText: target.bodyText,
    url: target.url,
    cacheExpiresAt: target.cacheExpiresAt,
    nextPrewarmAt: target.nextPrewarmAt,
    oauthAccountIdentity: target.oauthAccountIdentity,
    isSubagent: target.isSubagent,
  }
}

function sanitizedBody(text: string): string {
  const body = JSON.parse(text) as Record<string, unknown>
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Invalid restart body')
  let stripped = false
  // Only transport-like fields at the request root are credentials. A tool's
  // JSON schema or conversation content can legitimately name these fields;
  // changing those would change the cached prefix.
  for (const key of Object.keys(body)) {
    if (
      /^(authorization|x-api-key|cookie|set-cookie|headers|credentials|token|access[_-]?token|refresh[_-]?token)$/i.test(
        key,
      )
    ) {
      delete body[key]
      stripped = true
    }
  }
  return stripped ? JSON.stringify(body) : text
}

function invalidReason(
  value: SavedCacheKeepTarget,
  name: string,
  now: number,
): DropReason | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'invalid'
  if (value.v !== RECORD_FORMAT_VERSION) return 'format'
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    `${hash(value.id)}.json.gz` !== name ||
    typeof value.bodyText !== 'string' ||
    Buffer.byteLength(value.bodyText) > CACHE_KEEP_MAX_BODY_BYTES ||
    typeof value.url !== 'string' ||
    typeof value.oauthAccountIdentity !== 'string' ||
    !value.oauthAccountIdentity ||
    typeof value.isSubagent !== 'boolean' ||
    !Number.isFinite(value.cacheExpiresAt) ||
    !Number.isFinite(value.nextPrewarmAt)
  )
    return 'invalid'
  if (value.cacheExpiresAt <= now) return 'expired'
  // Malformed bodies and credential-bearing records are not replayable.
  if (sanitizedBody(value.bodyText) !== value.bodyText) return 'invalid'
}

export interface CacheKeepStoreOptions {
  storageId: string
  /** Test seam; production always uses os.tmpdir(), never OpenCode's config. */
  root?: string
  ownerOnly?: OwnerOnlyOptions
  now?: () => number
  setTimeoutImpl?: typeof globalThis.setTimeout
  clearTimeoutImpl?: typeof globalThis.clearTimeout
}

/** Best-effort restart storage. No caller of changed() waits for disk or zlib. */
export class CacheKeepStore {
  readonly directory: string
  private disabled = false
  private chain: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, SavedCacheKeepTarget>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastWrite = new Map<string, number>()
  private readonly latest = new Map<string, SavedCacheKeepTarget>()

  constructor(
    private readonly options: CacheKeepStoreOptions,
    previous?: CacheKeepStore,
  ) {
    this.directory = cacheKeepStoreDirectory(options.storageId, options.root)
    // Capture pending writes before the shared entry switches writers. New
    // writes and loads wait for them, so an old write cannot land last.
    this.chain = previous?.drain() ?? Promise.resolve()
  }

  private refuse() {
    if (this.disabled) return
    this.disabled = true
    for (const timer of this.timers.values())
      (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.clear()
    this.pending.clear()
    this.latest.clear()
    this.lastWrite.clear()
    logger.warn(
      'cachekeep',
      'restart storage unavailable; retaining sessions in memory only',
    )
  }

  private async directoryReady() {
    if (this.disabled) return false
    try {
      if (
        !(await ensureWindowsOwnerOnlyDirectory(
          this.directory,
          this.options.ownerOnly,
        ))
      ) {
        try {
          await mkdir(this.directory, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const stat = await lstat(this.directory)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !(await isOwnerOnly(
          this.directory,
          () =>
            stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
          this.options.ownerOnly,
        ))
      )
        throw new Error('Unsafe restart directory')
      return true
    } catch {
      this.refuse()
      return false
    }
  }

  private enqueue(action: () => Promise<void>) {
    this.chain = this.chain
      .then(async () => {
        if (await this.directoryReady()) await action()
      })
      .catch(() => this.refuse())
  }

  // An undefined acceptance leaves the record untouched without counting a
  // restore, for example when its session is already tracked in this process.
  async load(now: number, accept: (entry: SavedCacheKeepTarget) => Acceptance) {
    await this.chain
    if (!(await this.directoryReady())) return
    let restored = 0
    let dropped = 0
    try {
      for (const name of (await readdir(this.directory)).sort()) {
        if (!FILE.test(name) && !TEMP.test(name)) continue
        const path = join(this.directory, name)
        let reason: DropReason = 'unreadable'
        try {
          if (TEMP.test(name)) {
            reason = 'unfinished-write'
            throw new Error('Unfinished write')
          }
          const stat = await lstat(path)
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size > MAX_RECORD_BYTES ||
            !(await isOwnerOnly(
              path,
              () =>
                stat.uid === process.getuid?.() &&
                (stat.mode & 0o777) === 0o600,
              this.options.ownerOnly,
            ))
          ) {
            reason = 'unsafe-file'
            throw new Error('Unsafe restart file')
          }
          let bytes = await readWindowsOwnerOnly(path, this.options.ownerOnly)
          if (!bytes) {
            const file = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            )
            try {
              bytes = await file.readFile()
            } finally {
              await file.close()
            }
          }
          const raw = await decompress(bytes, {
            maxOutputLength: MAX_RECORD_BYTES,
          })
          reason = 'invalid'
          const entry = JSON.parse(raw.toString('utf8')) as SavedCacheKeepTarget
          const invalid = invalidReason(entry, name, now)
          const accepted = invalid ?? accept(entry)
          if (accepted !== true && accepted !== undefined) {
            reason = accepted || 'invalid'
            throw new Error('Stale restart file')
          }
          if (accepted === true) restored++
        } catch {
          logger.debug('cachekeep', 'restart record dropped', {
            file: name,
            reason,
          })
          dropped++
          await rm(path, { force: true })
        }
      }
    } catch {
      this.refuse()
    } finally {
      if (restored || dropped)
        logger.info('cachekeep', 'restart records loaded', {
          restored,
          dropped,
        })
    }
  }

  changed(target: Readonly<CacheKeepTarget>) {
    if (this.disabled) return
    const entry = record(target)
    const previous = this.latest.get(entry.id)
    if (
      previous &&
      previous.bodyText === entry.bodyText &&
      previous.url === entry.url &&
      previous.oauthAccountIdentity === entry.oauthAccountIdentity &&
      previous.cacheExpiresAt === entry.cacheExpiresAt &&
      previous.nextPrewarmAt === entry.nextPrewarmAt &&
      previous.isSubagent === entry.isSubagent
    )
      return
    this.latest.set(entry.id, entry)
    this.pending.set(entry.id, entry)
    if (this.timers.has(entry.id)) return
    // Coalesce nearby preparations into the latest body, including tool steps
    // in a long user turn. Each session is capped at one write per five seconds;
    // disposal drains the latest pending body without waiting for that window.
    const delay = Math.max(
      250,
      (this.lastWrite.get(entry.id) ?? 0) +
        5000 -
        (this.options.now?.() ?? Date.now()),
    )
    const timer = (this.options.setTimeoutImpl ?? setTimeout)(
      () => this.flush(entry.id),
      delay,
    )
    timer.unref?.()
    this.timers.set(entry.id, timer)
  }

  private flush(id: string) {
    const timer = this.timers.get(id)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(id)
    const entry = this.pending.get(id)
    this.pending.delete(id)
    if (!entry) return this.chain
    this.lastWrite.set(id, this.options.now?.() ?? Date.now())
    this.enqueue(async () => {
      const path = join(this.directory, `${hash(id)}.json.gz`)
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        const safe = { ...entry, bodyText: sanitizedBody(entry.bodyText) }
        const bytes = await compress(JSON.stringify(safe))
        if (
          !(await createWindowsOwnerOnly(temp, bytes, this.options.ownerOnly))
        )
          await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
        await renameWithWindowsSharingRetry(temp, path, {
          platform: this.options.ownerOnly?.platform,
        })
      } finally {
        await rm(temp, { force: true })
      }
    })
    return this.chain
  }

  removed(id: string) {
    const timer = this.timers.get(id)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(id)
    this.pending.delete(id)
    this.latest.delete(id)
    this.lastWrite.delete(id)
    this.enqueue(() =>
      rm(join(this.directory, `${hash(id)}.json.gz`), { force: true }),
    )
  }

  clear() {
    for (const timer of this.timers.values())
      (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.clear()
    this.pending.clear()
    this.latest.clear()
    this.lastWrite.clear()
    this.enqueue(async () => {
      for (const name of await readdir(this.directory))
        if (FILE.test(name) || TEMP.test(name))
          await rm(join(this.directory, name), { force: true })
    })
  }

  async drain() {
    for (const id of this.pending.keys()) this.flush(id)
    await this.chain
  }
}
