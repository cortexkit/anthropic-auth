import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { LockOwnershipError } from '@cortexkit/common-auth/fs'
import { CACHE_KEEP_MAX_BODY_BYTES, type CacheKeepTarget } from './cachekeep.ts'
import {
  ensureHolderDirectory,
  type HolderLiveness,
  holderEntryIsLive,
  holderEntryLiveness,
  processIncarnation,
} from './holder-registry.ts'
import { getHostDataHome } from './host-paths.ts'
import { logger } from './logger.ts'
import { withNativeLock } from './native-lock-observer.ts'
import {
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  isOwnerOnly,
  type OwnerOnlyOptions,
  readWindowsOwnerOnly,
} from './owner-only.ts'
import { renameWithWindowsSharingRetry } from './publication-rename.ts'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const FILE = /^[a-f0-9]{64}\.json\.gz$/
const TEMP = /^[a-f0-9]{64}\.json\.gz\.[a-f0-9-]+\.tmp$/
const TEMP_STALE_MS = 60 * 60 * 1000
const MAX_RECORD_BYTES = 2 * CACHE_KEEP_MAX_BODY_BYTES + 64 * 1024
// Replay compatibility depends only on the record format, not the plugin
// version. Bump this for format changes; the loader must accept or migrate the
// previous format so updates do not discard still-live caches.
const RECORD_FORMAT_VERSION = 1

type CacheKeepStoreHost = 'opencode1' | 'pi'

export function cacheKeepStoreDirectory(
  storageId: string,
  root = getHostDataHome(),
  host?: CacheKeepStoreHost,
) {
  return join(
    root,
    'cortexkit',
    'anthropic-auth',
    'cachekeep-restore',
    ...(host ? [host] : []),
    hash(storageId).slice(0, 16),
  )
}

export function legacyCacheKeepStoreDirectory(
  storageId: string,
  root = tmpdir(),
) {
  // Compatibility for records predating 2.5.4's data-folder migration.
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
  | 'ttlMs'
  | 'lastTouchAt'
  | 'lastTouchKind'
  | 'policyState'
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
  | 'expired'
  | 'foreign-identity'
  | 'account-gone'
  | 'invalid'
  | undefined

export type CacheKeepStoreRelease = (() => Promise<void>) & {
  /** Pure ownership check, repeated immediately before unlinking. */
  canRemove?: () => boolean | Promise<boolean>
}

const CLAIM_LOCK = {
  name: 'cachekeep-session',
  ttlMs: 10_000,
  timeoutMs: 2000,
  renew: true,
}

/** A process-lifetime claim, not a timer lease that can expire during a pause. */
export class CacheKeepClaim {
  private readonly token = randomUUID()
  private readonly path: string
  private readonly purpose: 'session' | 'sweep'
  private held = false

  constructor(
    private readonly directory: string,
    sessionId: string,
    private readonly options: {
      ownerOnly?: OwnerOnlyOptions
      liveness?: HolderLiveness
      sessionHash?: boolean
      purpose?: 'session' | 'sweep'
    } = {},
  ) {
    const key = options.sessionHash ? sessionId : hash(sessionId)
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid session hash')
    this.path = join(directory, `${key}.claim.json`)
    this.purpose =
      options.purpose ?? (options.sessionHash ? 'sweep' : 'session')
  }

  private async read(): Promise<Record<string, unknown> | undefined> {
    try {
      const stat = await lstat(this.path)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        !(await isOwnerOnly(
          this.path,
          () =>
            stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600,
          this.options.ownerOnly,
        ))
      )
        throw new Error('Unsafe CacheKeep claim')
      let bytes = await readWindowsOwnerOnly(this.path, this.options.ownerOnly)
      if (!bytes) {
        const file = await open(
          this.path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        try {
          bytes = await file.readFile()
        } finally {
          await file.close()
        }
      }
      const value = JSON.parse(bytes.toString())
      if (!holderEntryLiveness(value) || typeof value.token !== 'string')
        throw new Error('Invalid CacheKeep claim')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async acquire() {
    if (this.held) return true
    await ensureHolderDirectory(this.directory, this.options.ownerOnly)
    let retriedOwnershipLoss = false
    for (;;) {
      try {
        const result = await this.tryAcquire()
        if (result !== 'sweep') return result
      } catch (error) {
        if (retriedOwnershipLoss || !(error instanceof LockOwnershipError))
          throw error
        // A wall-clock step or a suspend can expire the publication lock.
        // Reacquire once and recheck whether another process claimed the session.
        retriedOwnershipLoss = true
        continue
      }
      // A sweep only borrows ownership to inspect one record. A resuming
      // session waits in the background rather than abandoning its claim.
      await delay(25)
    }
  }

  private tryAcquire() {
    return withNativeLock(this.path, CLAIM_LOCK, async (lease) => {
      const existing = await this.read()
      const life = holderEntryLiveness(existing)
      // Without an incarnation, a live PID still blocks takeover. A wall-clock
      // correction is not evidence that its registration predates this boot.
      if (
        life &&
        (await holderEntryIsLive(
          { pid: life.pid, incarnation: life.incarnation },
          this.options.liveness,
        ))
      )
        return this.purpose === 'session' && existing?.purpose === 'sweep'
          ? ('sweep' as const)
          : false
      const bytes = JSON.stringify({
        pid: process.pid,
        incarnation: await (
          this.options.liveness?.incarnation ?? processIncarnation
        )(process.pid),
        registeredAt: Date.now(),
        token: this.token,
        purpose: this.purpose,
      })
      const temp = `${this.path}.${this.token}.tmp`
      try {
        if (
          !(await createWindowsOwnerOnly(temp, bytes, this.options.ownerOnly))
        )
          await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
        await lease.assertOwned()
        await renameWithWindowsSharingRetry(temp, this.path, {
          platform: this.options.ownerOnly?.platform,
        })
        this.held = true
        return true
      } finally {
        await rm(temp, { force: true })
      }
    })
  }

  async isCurrent() {
    if (!this.held) return false
    try {
      return (await this.read())?.token === this.token
    } catch {
      return false
    }
  }

  async release() {
    if (!this.held) return
    await withNativeLock(this.path, CLAIM_LOCK, async (lease) => {
      if ((await this.read())?.token === this.token) {
        await lease.assertOwned()
        await rm(this.path, { force: true })
      }
      this.held = false
    })
  }
}

function record(
  target: Readonly<CacheKeepTarget>,
  pluginVersion: string,
): SavedCacheKeepTarget {
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
    ttlMs: target.ttlMs,
    lastTouchAt: target.lastTouchAt,
    lastTouchKind: target.lastTouchKind,
    ...(target.policyState && {
      policyState: {
        ownerSessionId: target.policyState.ownerSessionId,
        planned: target.policyState.planned,
        policy: target.policyState.policy,
        lastRealRequestAt: target.policyState.lastRealRequestAt,
        lastWarmAt: target.policyState.lastWarmAt,
        warmsSinceLastRealRequest: target.policyState.warmsSinceLastRealRequest,
        warmCostSoFar: target.policyState.warmCostSoFar,
        pendingWarmCost: target.policyState.pendingWarmCost,
        prefixTokens: target.policyState.prefixTokens,
        inputTokens: target.policyState.inputTokens,
        hasWarmed: target.policyState.hasWarmed,
        needsRealRequest: target.policyState.needsRealRequest,
      },
    }),
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
  const state = value.policyState
  if (
    state !== undefined &&
    (!state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      typeof state.ownerSessionId !== 'string' ||
      !state.ownerSessionId ||
      typeof state.planned !== 'boolean' ||
      typeof state.hasWarmed !== 'boolean' ||
      (state.needsRealRequest !== undefined &&
        typeof state.needsRealRequest !== 'boolean') ||
      !Number.isFinite(state.lastRealRequestAt) ||
      state.lastRealRequestAt > now ||
      (state.lastWarmAt !== undefined &&
        (!Number.isFinite(state.lastWarmAt) || state.lastWarmAt > now)) ||
      !Number.isSafeInteger(state.warmsSinceLastRealRequest) ||
      state.warmsSinceLastRealRequest < 0 ||
      !Number.isFinite(state.warmCostSoFar) ||
      state.warmCostSoFar < 0 ||
      (state.pendingWarmCost !== undefined &&
        (!Number.isFinite(state.pendingWarmCost) ||
          state.pendingWarmCost < 0)) ||
      [state.prefixTokens, state.inputTokens].some(
        (tokens) =>
          tokens !== undefined && (!Number.isFinite(tokens) || tokens < 0),
      ))
  )
    return 'invalid'
  if (state?.policy !== undefined && !validSavedPolicy(state.policy))
    return 'invalid'
  // Malformed bodies and credential-bearing records are not replayable.
  if (sanitizedBody(value.bodyText) !== value.bodyText) return 'invalid'
  if (value.cacheExpiresAt <= now) return 'expired'
}

function validSavedPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const policy = value as Record<string, unknown>
  if (
    policy.ttl !== undefined &&
    !['none', 'short', 'long'].includes(String(policy.ttl))
  )
    return false
  if (
    policy.keep_warm !== undefined &&
    !['off', 'auto', 'always', 'hours'].includes(String(policy.keep_warm))
  )
    return false
  if (policy.keep_warm !== 'hours') return policy.hours === undefined
  const hours = policy.hours as Record<string, unknown> | undefined
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) return false
  if (
    ![hours.from, hours.to].every(
      (time) =>
        typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time),
    )
  )
    return false
  if (typeof hours.tz !== 'string' || !hours.tz) return false
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: hours.tz })
    return true
  } catch {
    return false
  }
}

export interface CacheKeepStoreOptions {
  storageId: string
  pluginVersion: string
  /** OpenCode 2 retains its original namespace; other hosts do not read it. */
  host?: CacheKeepStoreHost
  /** Test seam for the data home; never the host's config. */
  root?: string
  /** Test seam for the pre-2.5.4 temp-root migration. */
  legacyRoot?: string
  ownerOnly?: OwnerOnlyOptions
  now?: () => number
  setTimeoutImpl?: typeof globalThis.setTimeout
  clearTimeoutImpl?: typeof globalThis.clearTimeout
  /** Hold a process claim from adoption or a live write through the last warm. */
  sessionClaims?: boolean
}

type StoreClaim = {
  claim: CacheKeepClaim
  acquired: Promise<boolean>
  retained: boolean
  closing?: Promise<void>
}

/** Best-effort restart storage. No caller of changed() waits for disk or zlib. */
export class CacheKeepStore {
  readonly directory: string
  private readonly claims?: Map<string, StoreClaim>
  private disabled = false
  private memoryOnly = false
  private persistenceEnabled = false
  private writeWarning = false
  private legacyLoadAttempted = false
  private chain: Promise<void> = Promise.resolve()
  private readonly pending = new Map<string, SavedCacheKeepTarget>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastWrite = new Map<string, number>()
  private readonly latest = new Map<string, SavedCacheKeepTarget>()

  constructor(
    private readonly options: CacheKeepStoreOptions,
    previous?: CacheKeepStore,
  ) {
    this.directory = cacheKeepStoreDirectory(
      options.storageId,
      options.root,
      options.host,
    )
    if (options.sessionClaims) this.claims = previous?.claims ?? new Map()
    // Capture pending writes before the shared entry switches writers. New
    // writes and loads wait for them, so an old write cannot land last.
    this.chain = previous?.drain() ?? Promise.resolve()
  }

  get isMemoryOnly() {
    return this.memoryOnly
  }

  private openClaim(key: string, purpose: 'session' | 'sweep') {
    if (!this.claims || this.claims.has(key)) return
    // Keep claims outside the record directory, including during migration
    // from the legacy temp directory. Old readers still see the same files.
    const claim = new CacheKeepClaim(`${this.directory}.claims`, key, {
      sessionHash: true,
      purpose,
      ownerOnly: this.options.ownerOnly,
    })
    const item: StoreClaim = {
      claim,
      retained: false,
      acquired: claim.acquire().catch(() => {
        this.writeFailed()
        return false
      }),
    }
    if (purpose === 'session') this.claims.set(key, item)
    return item
  }

  private closeClaim(key: string, item: StoreClaim) {
    item.closing ??= (async () => {
      if (await item.acquired) await item.claim.release()
    })().finally(() => {
      if (this.claims?.get(key) === item) this.claims.delete(key)
    })
    return item.closing
  }

  private async scanClaim(key: string, purpose: 'session' | 'sweep') {
    const item = this.openClaim(key, purpose)
    if (!item) return undefined
    if (!(await item.acquired)) {
      await this.closeClaim(key, item)
      return undefined
    }
    return Object.assign(
      () => (item.retained ? Promise.resolve() : this.closeClaim(key, item)),
      {
        canRemove: async () => (await item.claim.isCurrent()) && !item.retained,
      },
    )
  }

  async releaseClaims(shouldRelease: (hash: string) => boolean) {
    this.chain = this.chain.then(async () => {
      for (const [key, item] of this.claims ?? []) {
        if (!shouldRelease(key)) continue
        await this.closeClaim(key, item).catch(() => this.writeFailed())
      }
    })
    await this.chain
  }

  private refuse(memoryOnly = false) {
    if (this.disabled) return
    this.disabled = true
    this.memoryOnly = memoryOnly
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

  private writeFailed() {
    if (this.writeWarning) return
    this.writeWarning = true
    logger.warn(
      'cachekeep',
      'restart write failed; persistent warm awaits a durable reservation',
    )
  }

  private async directoryReady(directory = this.directory) {
    if (this.disabled) return false
    try {
      if (
        !(await ensureWindowsOwnerOnlyDirectory(
          directory,
          this.options.ownerOnly,
        ))
      ) {
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const stat = await lstat(directory)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !(await isOwnerOnly(
          directory,
          () =>
            stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
          this.options.ownerOnly,
        ))
      )
        throw new Error('Unsafe restart directory')
      this.persistenceEnabled = true
      return true
    } catch {
      if (!this.persistenceEnabled) this.refuse(true)
      else this.writeFailed()
      return false
    }
  }

  private enqueue(action: () => Promise<void>) {
    this.chain = this.chain
      .then(async () => {
        if (await this.directoryReady()) await action()
      })
      .catch(() => this.writeFailed())
  }

  // An undefined acceptance leaves the record untouched without counting a
  // restore, for example when its session is already tracked in this process.
  async load(
    now: number,
    accept: (entry: SavedCacheKeepTarget) => Acceptance,
    claim?: (sessionHash: string) => Promise<CacheKeepStoreRelease | undefined>,
    guard?: (sessionHash: string) => boolean | Promise<boolean>,
    mode: 'restore' | 'sweep' = 'restore',
  ) {
    await this.chain
    if (!(await this.directoryReady())) return
    let directory = this.directory
    // Only an empty OpenCode 2 store may recover the old temp files, once per
    // writer. The other hosts have never used this location.
    const firstLoad = !this.legacyLoadAttempted
    this.legacyLoadAttempted = true
    if (
      !this.options.host &&
      firstLoad &&
      (await readdir(directory)).length === 0
    ) {
      const legacy = legacyCacheKeepStoreDirectory(
        this.options.storageId,
        this.options.legacyRoot ?? this.options.root,
      )
      try {
        await lstat(legacy)
        if (!(await this.directoryReady(legacy))) return
        directory = legacy
      } catch {
        return
      }
    }
    let restored = 0
    let dropped = 0
    try {
      for (const name of (await readdir(directory)).sort()) {
        const temp = TEMP.test(name)
        if (!FILE.test(name) && !temp) continue
        const key = name.slice(0, 64)
        const path = join(directory, name)
        if (temp && !(await this.staleTemp(path))) continue
        if (guard && !(await guard(key))) continue
        // Multi-process hosts must hold the session claim while reading or
        // deleting, including expiry cleanup and abandoned temporary writes.
        const release = claim
          ? await claim(key)
          : await this.scanClaim(
              key,
              temp || mode === 'sweep' ? 'sweep' : 'session',
            )
        if ((claim || this.claims) && !release) continue
        let reason: DropReason = 'unreadable'
        let entry: SavedCacheKeepTarget | undefined
        const permitted = async () => {
          try {
            return (
              (!release?.canRemove || (await release.canRemove())) &&
              (!guard || (await guard(key)))
            )
          } catch {
            return false
          }
        }
        try {
          if (!(await permitted())) continue
          if (temp) {
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
          entry = JSON.parse(raw.toString('utf8')) as SavedCacheKeepTarget
          const invalid = invalidReason(entry, name, now)
          if (invalid && invalid !== 'expired') {
            reason = invalid
            throw new Error('Invalid restart file')
          }
          const acceptance = accept(entry)
          if (acceptance === undefined) continue
          const accepted = invalid ?? acceptance
          if (accepted !== true && accepted !== undefined) {
            reason = accepted || 'invalid'
            throw new Error('Stale restart file')
          }
          if (accepted === true) {
            const owned = this.claims?.get(key)
            if (owned && !claim && mode === 'restore') owned.retained = true
            // Retire pre-2.5.4 files only after the accepted record is durable
            // in the private data store.
            if (directory !== this.directory) {
              try {
                const adopted = entry
                const migrating = this.chain.then(() =>
                  this.writeEntry(adopted),
                )
                this.chain = migrating.catch(() => this.writeFailed())
                await migrating
              } catch {
                this.refuse()
                return
              }
              // The durable migrated copy is authoritative. Keeping this old
              // source could resurrect a session after it is later forgotten.
              await rm(path, { force: true })
            }
            restored++
          }
        } catch {
          const drop = async () => {
            if (temp && !(await this.staleTemp(path))) return
            if (!(await permitted())) return
            await rm(path, { force: true })
            logger.debug('cachekeep', 'restart record dropped', {
              file: name,
              reason,
            })
            dropped++
          }
          // A live writer may already be queued behind the sweep's claim.
          // Delete under that claim rather than waiting for the writer.
          if (this.claims && !claim)
            await drop().catch(() => this.writeFailed())
          else {
            this.chain = this.chain.then(drop).catch(() => this.writeFailed())
            await this.chain
          }
        } finally {
          await release?.()
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

  private async staleTemp(path: string) {
    // Older writers used anonymous temporary names. Allow a full long-cache
    // lifetime for publication before treating any of these files as abandoned.
    const stat = await lstat(path).catch(() => undefined)
    return !!stat && stat.mtimeMs <= Date.now() - TEMP_STALE_MS
  }

  changed(target: Readonly<CacheKeepTarget>) {
    if (this.disabled) return
    const entry = record(target, this.options.pluginVersion)
    const previous = this.latest.get(entry.id)
    if (
      previous &&
      previous.bodyText === entry.bodyText &&
      previous.url === entry.url &&
      previous.oauthAccountIdentity === entry.oauthAccountIdentity &&
      previous.cacheExpiresAt === entry.cacheExpiresAt &&
      previous.nextPrewarmAt === entry.nextPrewarmAt &&
      previous.ttlMs === entry.ttlMs &&
      previous.lastTouchAt === entry.lastTouchAt &&
      previous.lastTouchKind === entry.lastTouchKind &&
      JSON.stringify(previous.policyState) ===
        JSON.stringify(entry.policyState) &&
      previous.isSubagent === entry.isSubagent
    )
      return
    this.latest.set(entry.id, entry)
    this.pending.set(entry.id, entry)
    if (this.claims) {
      const key = hash(entry.id)
      this.enqueue(async () => {
        await this.claims?.get(key)?.closing
        const item = this.claims?.get(key) ?? this.openClaim(key, 'session')
        if (!item) return
        item.retained = true
        if (!(await item.acquired)) await this.closeClaim(key, item)
      })
    }
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
      if (await this.canWrite(id)) await this.writeEntry(entry)
    })
    return this.chain
  }

  /**
   * Bypass coalescing before a persisted replay can dispatch. An initially
   * unsafe folder (a symlink, foreign owner, or non-private permissions; see
   * directoryReady) disables both writes and restores for this process, so its
   * targets use memory-only bounds. A write failure in an enabled store must
   * pause that warm and retry: an older low-count record could still resume.
   */
  async reserveWarm(target: Readonly<CacheKeepTarget>): Promise<boolean> {
    if (this.disabled) return this.memoryOnly
    const entry = record(target, this.options.pluginVersion)
    const timer = this.timers.get(entry.id)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(entry.id)
    this.pending.delete(entry.id)
    this.latest.set(entry.id, entry)
    this.lastWrite.set(entry.id, this.options.now?.() ?? Date.now())
    let committed = false
    this.chain = this.chain
      .then(async () => {
        if (!(await this.directoryReady())) return
        if (!(await this.canWrite(entry.id))) return
        await this.writeEntry(entry)
        committed = true
      })
      .catch(() => this.writeFailed())
    await this.chain
    return committed || this.memoryOnly
  }

  private async canWrite(id: string) {
    if (!this.claims) return true
    const item = this.claims.get(hash(id))
    return !!item?.retained && (await item.claim.isCurrent())
  }

  private async writeEntry(entry: SavedCacheKeepTarget) {
    const path = join(this.directory, `${hash(entry.id)}.json.gz`)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const safe = { ...entry, bodyText: sanitizedBody(entry.bodyText) }
      const bytes = await compress(JSON.stringify(safe))
      if (!(await createWindowsOwnerOnly(temp, bytes, this.options.ownerOnly)))
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await renameWithWindowsSharingRetry(temp, path, {
        platform: this.options.ownerOnly?.platform,
      })
    } finally {
      await rm(temp, { force: true })
    }
  }

  removed(id: string, removeUnowned = false) {
    const timer = this.timers.get(id)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(id)
    this.pending.delete(id)
    this.latest.delete(id)
    this.lastWrite.delete(id)
    this.enqueue(async () => {
      const key = hash(id)
      const item =
        this.claims?.get(key) ??
        (removeUnowned ? this.openClaim(key, 'sweep') : undefined)
      try {
        if (
          !this.claims ||
          (item && (await item.acquired) && (await item.claim.isCurrent()))
        )
          await rm(join(this.directory, `${key}.json.gz`), { force: true })
      } finally {
        if (item) await this.closeClaim(key, item)
      }
    })
  }

  clear() {
    for (const timer of this.timers.values())
      (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.clear()
    this.pending.clear()
    this.latest.clear()
    this.lastWrite.clear()
    this.enqueue(async () => {
      for (const name of await readdir(this.directory)) {
        const path = join(this.directory, name)
        const temp = TEMP.test(name)
        if (!FILE.test(name) && !temp) continue
        if (temp && !(await this.staleTemp(path))) continue
        const release = await this.scanClaim(name.slice(0, 64), 'sweep')
        if (this.claims && !release) continue
        try {
          if (release?.canRemove && !(await release.canRemove())) continue
          if (temp && !(await this.staleTemp(path))) continue
          await rm(path, { force: true })
        } finally {
          await release?.()
        }
      }
    })
  }

  async drain() {
    for (const id of this.pending.keys()) this.flush(id)
    await this.chain
  }
}
