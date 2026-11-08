// @ts-nocheck -- Frozen published JavaScript; keep reader behavior independent of current TypeScript.
// Extracted from @cortexkit/anthropic-auth-core@2.6.0 dist/index.js lines 24557-24838.
// npm archive SHA-1: 06f05310ce9fd9c5212d4f94231923ceb0f0a79f.
// Only externalized bundled helpers, exports and repository formatting differ.

// src/cachekeep-store.ts
import {
  createHash as createHash20,
  randomUUID as randomUUID16,
} from 'node:crypto'
import { constants as constants3 } from 'node:fs'
import {
  lstat as lstat14,
  mkdir as mkdir12,
  open as open10,
  readdir as readdir4,
  rm as rm8,
  writeFile as writeFile5,
} from 'node:fs/promises'
import { tmpdir as tmpdir7 } from 'node:os'
import { join as join22 } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import {
  CACHE_KEEP_MAX_BODY_BYTES,
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  getHostDataHome,
  isOwnerOnly,
  logger as logger2,
  readWindowsOwnerOnly,
  renameWithWindowsSharingRetry,
} from '@cortexkit/anthropic-auth-core'

var compress = promisify(gzip)
var decompress = promisify(gunzip)
var hash3 = (value) => createHash20('sha256').update(value).digest('hex')
var FILE = /^[a-f0-9]{64}\.json\.gz$/
var TEMP = /^[a-f0-9]{64}\.json\.gz\.[a-f0-9-]+\.tmp$/
var MAX_RECORD_BYTES = 2 * CACHE_KEEP_MAX_BODY_BYTES + 64 * 1024
var RECORD_FORMAT_VERSION = 1
function cacheKeepStoreDirectory(storageId, root = getHostDataHome(), host) {
  return join22(
    root,
    'cortexkit',
    'anthropic-auth',
    'cachekeep-restore',
    ...(host ? [host] : []),
    hash3(storageId).slice(0, 16),
  )
}
function legacyCacheKeepStoreDirectory(storageId, root = tmpdir7()) {
  return join22(
    root,
    `cortexkit-anthropic-auth-cachekeep-${hash3(storageId).slice(0, 16)}`,
  )
}
function record8(target, pluginVersion) {
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
    ttlMs: target.ttlMs,
    lastTouchAt: target.lastTouchAt,
    lastTouchKind: target.lastTouchKind,
  }
}
function sanitizedBody(text5) {
  const body = JSON.parse(text5)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new Error('Invalid restart body')
  let stripped = false
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
  return stripped ? JSON.stringify(body) : text5
}
function invalidReason(value, name, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'invalid'
  if (value.v !== RECORD_FORMAT_VERSION) return 'format'
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    `${hash3(value.id)}.json.gz` !== name ||
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
  if (sanitizedBody(value.bodyText) !== value.bodyText) return 'invalid'
}

class CacheKeepStore {
  options
  directory
  disabled = false
  legacyLoadAttempted = false
  chain = Promise.resolve()
  pending = new Map()
  timers = new Map()
  lastWrite = new Map()
  latest = new Map()
  constructor(options, previous) {
    this.options = options
    this.directory = cacheKeepStoreDirectory(
      options.storageId,
      options.root,
      options.host,
    )
    this.chain = previous?.drain() ?? Promise.resolve()
  }
  refuse() {
    if (this.disabled) return
    this.disabled = true
    for (const timer of this.timers.values())
      (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.clear()
    this.pending.clear()
    this.latest.clear()
    this.lastWrite.clear()
    logger2.warn(
      'cachekeep',
      'restart storage unavailable; retaining sessions in memory only',
    )
  }
  async directoryReady(directory = this.directory) {
    if (this.disabled) return false
    try {
      if (
        !(await ensureWindowsOwnerOnlyDirectory(
          directory,
          this.options.ownerOnly,
        ))
      ) {
        try {
          await mkdir12(directory, { recursive: true, mode: 448 })
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
      const stat11 = await lstat14(directory)
      if (
        !stat11.isDirectory() ||
        stat11.isSymbolicLink() ||
        !(await isOwnerOnly(
          directory,
          () =>
            stat11.uid === process.getuid?.() && (stat11.mode & 511) === 448,
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
  enqueue(action) {
    this.chain = this.chain
      .then(async () => {
        if (await this.directoryReady()) await action()
      })
      .catch(() => this.refuse())
  }
  async load(now, accept, claim) {
    await this.chain
    if (!(await this.directoryReady())) return
    let directory = this.directory
    const firstLoad = !this.legacyLoadAttempted
    this.legacyLoadAttempted = true
    if (
      !this.options.host &&
      firstLoad &&
      (await readdir4(directory)).length === 0
    ) {
      const legacy = legacyCacheKeepStoreDirectory(
        this.options.storageId,
        this.options.legacyRoot ?? this.options.root,
      )
      try {
        await lstat14(legacy)
        if (!(await this.directoryReady(legacy))) return
        directory = legacy
      } catch {
        return
      }
    }
    let restored = 0
    let dropped = 0
    try {
      for (const name of (await readdir4(directory)).sort()) {
        if (!FILE.test(name) && !TEMP.test(name)) continue
        const release2 = claim ? await claim(name.slice(0, 64)) : undefined
        if (claim && !release2) continue
        const path2 = join22(directory, name)
        let reason = 'unreadable'
        try {
          if (TEMP.test(name)) {
            reason = 'unfinished-write'
            throw new Error('Unfinished write')
          }
          const stat11 = await lstat14(path2)
          if (
            !stat11.isFile() ||
            stat11.isSymbolicLink() ||
            stat11.size > MAX_RECORD_BYTES ||
            !(await isOwnerOnly(
              path2,
              () =>
                stat11.uid === process.getuid?.() &&
                (stat11.mode & 511) === 384,
              this.options.ownerOnly,
            ))
          ) {
            reason = 'unsafe-file'
            throw new Error('Unsafe restart file')
          }
          let bytes = await readWindowsOwnerOnly(path2, this.options.ownerOnly)
          if (!bytes) {
            const file = await open10(
              path2,
              constants3.O_RDONLY | constants3.O_NOFOLLOW,
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
          const entry2 = JSON.parse(raw.toString('utf8'))
          const invalid = invalidReason(entry2, name, now)
          const accepted = invalid ?? accept(entry2)
          if (accepted !== true && accepted !== undefined) {
            reason = accepted || 'invalid'
            throw new Error('Stale restart file')
          }
          if (accepted === true) {
            if (directory !== this.directory) {
              try {
                await this.writeEntry(entry2)
              } catch {
                this.refuse()
                return
              }
              await rm8(path2, { force: true })
            }
            restored++
          }
        } catch {
          logger2.debug('cachekeep', 'restart record dropped', {
            file: name,
            reason,
          })
          dropped++
          await rm8(path2, { force: true })
        } finally {
          await release2?.()
        }
      }
    } catch {
      this.refuse()
    } finally {
      if (restored || dropped)
        logger2.info('cachekeep', 'restart records loaded', {
          restored,
          dropped,
        })
    }
  }
  changed(target) {
    if (this.disabled) return
    const entry2 = record8(target, this.options.pluginVersion)
    const previous = this.latest.get(entry2.id)
    if (
      previous &&
      previous.bodyText === entry2.bodyText &&
      previous.url === entry2.url &&
      previous.oauthAccountIdentity === entry2.oauthAccountIdentity &&
      previous.cacheExpiresAt === entry2.cacheExpiresAt &&
      previous.nextPrewarmAt === entry2.nextPrewarmAt &&
      previous.ttlMs === entry2.ttlMs &&
      previous.lastTouchAt === entry2.lastTouchAt &&
      previous.lastTouchKind === entry2.lastTouchKind &&
      previous.isSubagent === entry2.isSubagent
    )
      return
    this.latest.set(entry2.id, entry2)
    this.pending.set(entry2.id, entry2)
    if (this.timers.has(entry2.id)) return
    const delay3 = Math.max(
      250,
      (this.lastWrite.get(entry2.id) ?? 0) +
        5000 -
        (this.options.now?.() ?? Date.now()),
    )
    const timer = (this.options.setTimeoutImpl ?? setTimeout)(
      () => this.flush(entry2.id),
      delay3,
    )
    timer.unref?.()
    this.timers.set(entry2.id, timer)
  }
  flush(id2) {
    const timer = this.timers.get(id2)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(id2)
    const entry2 = this.pending.get(id2)
    this.pending.delete(id2)
    if (!entry2) return this.chain
    this.lastWrite.set(id2, this.options.now?.() ?? Date.now())
    this.enqueue(() => this.writeEntry(entry2))
    return this.chain
  }
  async writeEntry(entry2) {
    const path2 = join22(this.directory, `${hash3(entry2.id)}.json.gz`)
    const temp = `${path2}.${randomUUID16()}.tmp`
    try {
      const safe = { ...entry2, bodyText: sanitizedBody(entry2.bodyText) }
      const bytes = await compress(JSON.stringify(safe))
      if (!(await createWindowsOwnerOnly(temp, bytes, this.options.ownerOnly)))
        await writeFile5(temp, bytes, { flag: 'wx', mode: 384 })
      await renameWithWindowsSharingRetry(temp, path2, {
        platform: this.options.ownerOnly?.platform,
      })
    } finally {
      await rm8(temp, { force: true })
    }
  }
  removed(id2) {
    const timer = this.timers.get(id2)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(id2)
    this.pending.delete(id2)
    this.latest.delete(id2)
    this.lastWrite.delete(id2)
    this.enqueue(() =>
      rm8(join22(this.directory, `${hash3(id2)}.json.gz`), { force: true }),
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
      for (const name of await readdir4(this.directory))
        if (FILE.test(name) || TEMP.test(name))
          await rm8(join22(this.directory, name), { force: true })
    })
  }
  async drain() {
    for (const id2 of this.pending.keys()) this.flush(id2)
    await this.chain
  }
}

export { CacheKeepStore, cacheKeepStoreDirectory }
