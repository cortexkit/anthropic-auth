import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
import { LockOwnershipError } from '@cortexkit/common-auth/fs'
import {
  CACHE_KEEP_MAX_BODY_BYTES,
  type CacheKeepTarget,
  type CacheKeepWarmReservation,
} from './cachekeep.ts'
import {
  hasFallbackCreditInRequest,
  withoutFallbackCredit,
} from './fallback-credit.ts'
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
const TOMBSTONE = /^[a-f0-9]{64}\.deleted$/
const TOMBSTONE_MS = 24 * 60 * 60 * 1000
const TEMP_STALE_MS = 60 * 60 * 1000
const RECORD_CLOCK_SKEW_MS = 1000
// Allow a clock rollback of one hour, the longest cache lifetime, plus margin.
const RECORD_MAX_FUTURE_MS = 2 * 60 * 60 * 1000
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
> & {
  v: typeof RECORD_FORMAT_VERSION
  pluginVersion: string
  /** Legacy round record: the saved body contains only the serving prefix. */
  refusalSourceModel?: string
}

type DropReason =
  | 'format'
  | 'expired'
  | 'foreign-identity'
  | 'account-gone'
  | 'unsafe-file'
  | 'unreadable'
  | 'unfinished-write'
  | 'deleted'
  | 'invalid'

type Acceptance =
  | boolean
  | 'expired'
  | 'foreign-identity'
  | 'account-gone'
  | 'invalid'
  | undefined

export type CacheKeepStoreRelease = (() => Promise<void>) & {
  /** Ownership check for scans that cannot run the unlink under the lock. */
  canRemove?: () => boolean | Promise<boolean>
  withCurrent?: (action: () => Promise<void>) => Promise<boolean>
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
  private readonly recordPath: string
  private readonly tombstonePath: string
  private held = false
  private deleted = false

  constructor(
    private readonly directory: string,
    sessionId: string,
    private readonly options: {
      ownerOnly?: OwnerOnlyOptions
      liveness?: HolderLiveness
      sessionHash?: boolean
      purpose?: 'session' | 'sweep'
      recordDirectory?: string
      now?: () => number
    } = {},
  ) {
    const key = options.sessionHash ? sessionId : hash(sessionId)
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid session hash')
    this.path = join(directory, `${key}.claim.json`)
    this.recordPath = join(
      options.recordDirectory ?? directory,
      `${key}.json.gz`,
    )
    this.tombstonePath = join(
      options.recordDirectory ?? directory,
      `${key}.deleted`,
    )
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

  async acquire(restoreOnly = false, acceptedAt?: number) {
    this.deleted = false
    await ensureHolderDirectory(this.directory, this.options.ownerOnly)
    const deadline = performance.now() + CLAIM_LOCK.timeoutMs
    let retriedOwnershipLoss = false
    for (;;) {
      try {
        const result = await this.tryAcquire(restoreOnly, acceptedAt)
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
      if (performance.now() >= deadline) return false
      await delay(25)
    }
  }

  private async live(value: Record<string, unknown> | undefined) {
    const life = holderEntryLiveness(value)
    // A wall-clock correction does not invalidate the claim of a live PID.
    return (
      !!life &&
      holderEntryIsLive(
        { pid: life.pid, incarnation: life.incarnation },
        this.options.liveness,
      )
    )
  }

  private async publish(
    value: Record<string, unknown>,
    assertOwned: () => Promise<void>,
    path = this.path,
  ) {
    const temp = `${path}.${this.token}.tmp`
    try {
      const bytes = JSON.stringify(value)
      if (!(await createWindowsOwnerOnly(temp, bytes, this.options.ownerOnly)))
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await assertOwned()
      await renameWithWindowsSharingRetry(temp, path, {
        platform: this.options.ownerOnly?.platform,
      })
    } finally {
      await rm(temp, { force: true })
    }
  }

  private async tombstoneTime() {
    const stat = await lstat(this.tombstonePath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    if (!stat) return
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      !(await isOwnerOnly(
        this.tombstonePath,
        () => stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600,
        this.options.ownerOnly,
      ))
    )
      throw new Error('Unsafe CacheKeep deletion tombstone')
    let bytes = await readWindowsOwnerOnly(
      this.tombstonePath,
      this.options.ownerOnly,
    )
    if (!bytes) {
      const file = await open(
        this.tombstonePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        bytes = await file.readFile()
      } finally {
        await file.close()
      }
    }
    const value: unknown = JSON.parse(bytes.toString())
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid CacheKeep deletion tombstone')
    // Older writers recorded the deletion only in the file metadata.
    if (!('deletedAt' in value)) return stat.mtimeMs
    if (
      typeof value.deletedAt !== 'number' ||
      !Number.isFinite(value.deletedAt)
    )
      throw new Error('Invalid CacheKeep deletion time')
    return value.deletedAt
  }

  async deletedAfter(acceptedAt: number) {
    const deletedAt = await this.tombstoneTime()
    return (
      deletedAt !== undefined &&
      deletedAt > (this.options.now?.() ?? Date.now()) - TOMBSTONE_MS &&
      deletedAt >= acceptedAt
    )
  }

  async sweepTombstone() {
    const expired = async () =>
      ((await this.tombstoneTime()) ?? Infinity) <=
      (this.options.now?.() ?? Date.now()) - TOMBSTONE_MS
    if (!(await expired())) return
    await ensureHolderDirectory(this.directory, this.options.ownerOnly)
    await withNativeLock(this.path, CLAIM_LOCK, async (lease) => {
      if (!(await expired())) return
      await lease.assertOwned()
      await rm(this.tombstonePath, { force: true })
    })
  }

  private tryAcquire(restoreOnly: boolean, acceptedAt?: number) {
    return withNativeLock(this.path, CLAIM_LOCK, async (lease) => {
      const existing = await this.read()
      const owned = this.held && existing?.token === this.token
      const live = owned || (await this.live(existing))
      const assertOwned = () => lease.assertOwned()
      if (existing?.deleted === true) {
        this.deleted = true
        if (owned || !live) await this.unlink(assertOwned)
        if (owned) this.held = false
        return false
      }
      if (acceptedAt !== undefined && (await this.deletedAfter(acceptedAt))) {
        this.deleted = true
        return false
      }
      if (owned) {
        if (!restoreOnly && existing?.restoreOnly === true)
          await this.publish({ ...existing, restoreOnly: false }, assertOwned)
        return true
      }
      this.held = false
      if (live) {
        if (this.purpose === 'sweep') return false
        if (existing?.purpose === 'sweep') return 'sweep' as const
        if (restoreOnly || existing?.restoreOnly !== true) return false
      }
      await this.publish(
        {
          pid: process.pid,
          incarnation: await (
            this.options.liveness?.incarnation ?? processIncarnation
          )(process.pid),
          registeredAt: Date.now(),
          token: this.token,
          purpose: this.purpose,
          // Pi 2.16.6 checks the original fields and ignores restoreOnly.
          ...(restoreOnly && { restoreOnly: true }),
        },
        assertOwned,
      )
      this.held = true
      return true
    })
  }

  get wasDeleted() {
    return this.deleted
  }

  promote(acceptedAt?: number) {
    return this.withCurrent(async (assertOwned, current) => {
      if (current.restoreOnly === true)
        await this.publish({ ...current, restoreOnly: false }, assertOwned)
    }, acceptedAt)
  }

  async withCurrent(
    action: (
      assertOwned: () => Promise<void>,
      current: Record<string, unknown>,
    ) => Promise<void>,
    acceptedAt?: number,
  ) {
    if (!this.held) return false
    return withNativeLock(this.path, CLAIM_LOCK, async (lease) => {
      const current = await this.read()
      if (current?.token !== this.token) {
        this.held = false
        return false
      }
      const assertOwned = () => lease.assertOwned()
      if (current.deleted === true) {
        this.deleted = true
        await this.unlink(assertOwned)
        this.held = false
        return false
      }
      if (acceptedAt !== undefined && (await this.deletedAfter(acceptedAt))) {
        this.deleted = true
        return false
      }
      await action(assertOwned, current)
      return true
    })
  }

  async isCurrent() {
    if (!this.held) return false
    try {
      return await this.withCurrent(async () => {})
    } catch {
      return false
    }
  }

  private async unlink(assertOwned: () => Promise<void>) {
    await assertOwned()
    await rm(this.recordPath, { force: true })
    await assertOwned()
    await rm(this.path, { force: true })
  }

  async requestDeletion(markLive: boolean, mayDelete?: () => Promise<boolean>) {
    await ensureHolderDirectory(this.directory, this.options.ownerOnly)
    await withNativeLock(this.path, CLAIM_LOCK, async (lease) => {
      const current = await this.read()
      const assertOwned = () => lease.assertOwned()
      // The claim can disappear on release, and the filesystem clock can differ
      // from the clock that timestamps accepted bodies.
      if (markLive)
        await this.publish(
          { deletedAt: this.options.now?.() ?? Date.now() },
          assertOwned,
          this.tombstonePath,
        )
      if (
        current &&
        current.token !== this.token &&
        (await this.live(current))
      ) {
        if (markLive && current.deleted !== true)
          await this.publish({ ...current, deleted: true }, assertOwned)
      } else if (!mayDelete || (await mayDelete())) {
        await this.unlink(assertOwned)
        this.held = false
      }
    })
  }

  async release() {
    if (!this.held) return
    await withNativeLock(this.path, CLAIM_LOCK, async (lease) => {
      const current = await this.read()
      if (current?.token === this.token) {
        if (current.deleted === true)
          await this.unlink(() => lease.assertOwned())
        else {
          await lease.assertOwned()
          await rm(this.path, { force: true })
        }
      }
      this.held = false
    })
  }

  async releaseEventually() {
    try {
      await this.release()
    } catch {
      // The process can outlive the host instance that owned this claim.
      setTimeout(() => void this.releaseEventually(), 1000).unref?.()
    }
  }
}

/** The source slot and the ordinary target share one durable session record. */
export function cacheKeepRestartTarget(
  target: Readonly<CacheKeepTarget>,
): Readonly<CacheKeepTarget> | undefined {
  if (typeof target.hostMetadata?.refusalSourceModel === 'string')
    return undefined
  if (!target.sourceWarm) return target
  const id = target.policyState?.ownerSessionId
  const oauthAccountIdentity = target.sourceWarmRestartIdentity
  return id && oauthAccountIdentity
    ? { ...target, id, oauthAccountIdentity }
    : undefined
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

function acceptedAt(
  entry: SavedCacheKeepTarget | undefined,
  fallback = -Infinity,
) {
  // A warm extends the expiry but does not accept a new request body.
  return entry?.policyState?.lastRealRequestAt ?? entry?.lastTouchAt ?? fallback
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

function recordStatus(
  value: SavedCacheKeepTarget,
  name: string,
  now: number,
): 'format' | 'invalid' | 'future' | undefined {
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
      (state.lastWarmAt !== undefined && !Number.isFinite(state.lastWarmAt)) ||
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
  if (state) {
    const ahead =
      Math.max(state.lastRealRequestAt, state.lastWarmAt ?? -Infinity) - now
    if (ahead > RECORD_MAX_FUTURE_MS) return 'invalid'
    if (ahead > RECORD_CLOCK_SKEW_MS) return 'future'
  }
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
  /** Pi claims only sessions opened by its host, in its existing directory. */
  externalClaim?: (id: string) => CacheKeepClaim | undefined
  onClaimLost?: (id: string) => void
  /** Prefer the saved sessions with the most remaining cache lifetime. */
  restoreNewestFirst?: boolean
}

type UnverifiedClaim = 'ownership-unverified'

type StoreClaim = {
  claim: CacheKeepClaim
  acquired: Promise<boolean | UnverifiedClaim>
  retained: boolean
  restoreOnly: boolean
  adopted?: { entry: SavedCacheKeepTarget; acceptedAt: number }
  retiring?: boolean
  closing?: Promise<void>
  releaseRetry?: ReturnType<typeof setTimeout>
}

function claimCoversEntry(
  item: StoreClaim | undefined,
  entry: SavedCacheKeepTarget | undefined,
) {
  if (!item?.restoreOnly) return true
  // Without a fresh real claim, only the adopted acceptance may be changed.
  const adopted = item.adopted
  return (
    !!adopted &&
    !!entry &&
    acceptedAt(entry) === adopted.acceptedAt &&
    entry.bodyText === adopted.entry.bodyText &&
    entry.url === adopted.entry.url &&
    entry.oauthAccountIdentity === adopted.entry.oauthAccountIdentity
  )
}

type RealClaimIntent = { item?: StoreClaim }

type WriteAuthority = {
  item?: StoreClaim
  intent?: RealClaimIntent
  external?: CacheKeepClaim
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
  private readonly latest: Map<string, SavedCacheKeepTarget>
  private readonly committed: Map<string, SavedCacheKeepTarget>
  private readonly pendingRealClaims: Map<string, RealClaimIntent>
  private switchingWriter: boolean
  private claimReleases = 0

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
    this.latest = previous?.latest ?? new Map()
    this.committed = previous?.committed ?? new Map()
    this.pendingRealClaims = previous?.pendingRealClaims ?? new Map()
    // Capture pending writes before the shared entry switches writers. New
    // writes and loads wait for them, so an old write cannot land last.
    const drainingPrevious = previous?.drain()
    this.switchingWriter = !!drainingPrevious
    this.chain = drainingPrevious
      ? drainingPrevious.finally(() => {
          this.switchingWriter = false
        })
      : Promise.resolve()
  }

  get isMemoryOnly() {
    return this.memoryOnly
  }

  private newClaim(key: string, purpose: 'session' | 'sweep') {
    // Keep claims outside the record directory, including during migration
    // from the legacy temp directory. Old readers still see the same files.
    return new CacheKeepClaim(`${this.directory}.claims`, key, {
      sessionHash: true,
      purpose,
      ownerOnly: this.options.ownerOnly,
      recordDirectory: this.directory,
      now: this.options.now,
    })
  }

  private openClaim(
    key: string,
    purpose: 'session' | 'sweep',
    restoreOnly = false,
    acceptedAt?: number,
  ) {
    if (!this.claims || this.claims.has(key)) return
    const claim = this.newClaim(key, purpose)
    const item: StoreClaim = {
      claim,
      retained: false,
      restoreOnly,
      acquired: claim.acquire(restoreOnly, acceptedAt).catch(() => {
        this.writeFailed()
        return 'ownership-unverified' as const
      }),
    }
    if (purpose === 'session') this.claims.set(key, item)
    return item
  }

  private closeClaim(key: string, item: StoreClaim, newerRecord = false) {
    const retrying = item.releaseRetry !== undefined
    if (retrying) clearTimeout(item.releaseRetry)
    item.releaseRetry = undefined
    item.retained = false
    item.closing ??= (async () => {
      if ((await item.acquired) === true) await item.claim.release()
      if (this.claims?.get(key) === item) this.claims.delete(key)
      // A keeper may have skipped this record because another keeper held
      // its claim or because it still tracked an older request for the session.
      // A scan's own releases must not trigger scans.
      if (retrying || newerRecord) process.emit(this.claimAvailableEvent())
    })().catch((error) => {
      item.closing = undefined
      // A failed unlink leaves a live PID in the file. Keep retrying even if
      // the host that released the claim has no more sessions in this store.
      if (!this.claims?.has(key)) this.claims?.set(key, item)
      item.releaseRetry = setTimeout(() => {
        void this.closeClaim(key, item).catch(() => this.writeFailed())
      }, 1000)
      item.releaseRetry.unref?.()
      throw error
    })
    return item.closing
  }

  private retainedClaim(key: string) {
    const item = this.claims?.get(key)
    return item?.retained && !item.retiring ? item : undefined
  }

  private claimAvailableEvent() {
    return `cortexkit.cachekeep.claim-release-retried:${this.directory}`
  }

  onClaimAvailable(listener: () => void) {
    const event = this.claimAvailableEvent()
    process.on(event, listener)
    return () => {
      process.off(event, listener)
    }
  }

  private async scanClaim(key: string, purpose: 'session' | 'sweep') {
    const item = this.openClaim(key, purpose, purpose === 'session')
    if (!item) return undefined
    if ((await item.acquired) !== true) {
      await this.closeClaim(key, item)
      return undefined
    }
    return Object.assign(
      () =>
        item.retained
          ? Promise.resolve()
          : this.closeClaim(key, item).catch(() => this.writeFailed()),
      {
        item,
        canRemove: async () => (await item.claim.isCurrent()) && !item.retained,
        withCurrent: (action: () => Promise<void>) =>
          item.claim.withCurrent(async () => {
            if (!item.retained) await action()
          }),
      },
    )
  }

  private async takeRealClaim(
    id: string,
    intent: RealClaimIntent,
    captured: StoreClaim | undefined,
  ) {
    const isPending = () => this.pendingRealClaims.get(id) === intent
    if (!isPending()) return
    const entry = this.latest.get(id)
    const when = acceptedAt(entry)
    const dropStale = () => {
      if (this.latest.get(id) === entry && isPending()) this.loseClaim(id)
    }
    const acquired = async (owned: StoreClaim) => {
      try {
        // A peer may have saved a more recent real turn before releasing. The
        // claim now excludes peer writes, but doesn't make this body newer.
        if (entry && (await this.hasNewerRecord(id, when))) {
          dropStale()
          await this.closeClaim(key, owned, true)
          return
        }
      } catch (error) {
        await this.closeClaim(key, owned)
        throw error
      }
      // A removal and a new accepted body can queue while this lock is held.
      // Completing the older acquisition must not consume the new one. If a
      // non-covered removal canceled this acquisition, release the claim and
      // leave the saved body for a later scan rather than deleting or writing it.
      if (!isPending() || owned.retiring || this.claims?.get(key) !== owned) {
        if (!owned.retiring) await this.closeClaim(key, owned)
        return
      }
      owned.retained = true
      owned.restoreOnly = false
      owned.adopted = undefined
      intent.item = owned
      this.pendingRealClaims.delete(id)
      return owned
    }
    const key = hash(id)
    if (captured && this.claims?.get(key) === captured) {
      if (captured.retained && !captured.retiring) {
        if (await captured.claim.promote(when)) return acquired(captured)
        if (captured.claim.wasDeleted) {
          dropStale()
          await this.closeClaim(key, captured)
          return
        }
      }
      if (!captured.retiring) await this.closeClaim(key, captured)
    }
    // If the captured claim yielded, acquire our own token. Never promote a
    // scan's token just because it appeared while this real turn was queued.
    if (!isPending()) return
    const item = this.openClaim(key, 'session', false, when)
    if (!item) return 'ownership-unverified' as const
    const result = await item.acquired
    if (result === true) return acquired(item)
    if (item.claim.wasDeleted) dropStale()
    await this.closeClaim(key, item)
    if (result === 'ownership-unverified') return result
  }

  realTurn(id: string, acquire = true) {
    if (!this.claims || this.disabled) return
    const key = hash(id)
    const item = this.retainedClaim(key)
    if (!item?.retained && !acquire) return
    // The old writer or an overlapping last-lease release can still drop this
    // token. Queue a fresh acquisition behind that release before persisting.
    if (
      !this.switchingWriter &&
      this.claimReleases === 0 &&
      item?.retained &&
      !item.restoreOnly &&
      this.latest.has(id)
    )
      return
    const intent: RealClaimIntent = {}
    this.pendingRealClaims.set(id, intent)
    this.enqueue(async () => {
      await this.takeRealClaim(id, intent, item)
    })
  }

  isCommitted(id: string) {
    const entry = this.latest.get(id)
    return !!entry && this.committed.get(id) === entry
  }

  async releaseClaims(shouldRelease: (hash: string) => boolean) {
    const claims = new Map(this.claims)
    this.claimReleases++
    this.chain = this.chain
      .then(async () => {
        for (const [key, item] of claims) {
          if (this.claims?.get(key) !== item || !shouldRelease(key)) continue
          await this.closeClaim(key, item).catch(() => this.writeFailed())
        }
      })
      .finally(() => {
        this.claimReleases--
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
      // The startup fallback has no disk claim, so two copies can both warm.
      if (!this.persistenceEnabled) this.refuse(true)
      else this.writeFailed()
      return false
    }
  }

  private enqueue(action: () => Promise<void>, cleanup?: () => Promise<void>) {
    this.chain = this.chain
      .then(async () => {
        try {
          if (await this.directoryReady()) await action()
        } finally {
          await cleanup?.()
        }
      })
      .catch(() => this.writeFailed())
  }

  // An undefined acceptance leaves the record untouched without counting a
  // restore, for example when its session is already tracked in this process.
  async load(
    now: number,
    accept: (entry: SavedCacheKeepTarget, acceptedAt: number) => Acceptance,
    claim?: (sessionHash: string) => Promise<CacheKeepStoreRelease | undefined>,
    guard?: (sessionHash: string) => boolean | Promise<boolean>,
    mode: 'restore' | 'sweep' = 'restore',
  ) {
    const clock = this.options.now ?? Date.now
    await this.chain
    if (!(await this.directoryReady())) return
    let directory = this.directory
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      // A failed listing says nothing about claims already held by this store.
      this.writeFailed()
      return
    }
    // OpenCode 2 can recover old temp records once per writer, if the current
    // directory has nothing but deletion markers. Other hosts never used it.
    const firstLoad = !this.legacyLoadAttempted
    this.legacyLoadAttempted = true
    let restored = 0
    let dropped = 0
    try {
      if (this.claims)
        for (const name of names) {
          if (TOMBSTONE.test(name))
            await this.newClaim(name.slice(0, 64), 'sweep')
              .sweepTombstone()
              .catch(() => this.writeFailed())
        }
      if (
        !this.options.host &&
        firstLoad &&
        names.every((name) => TOMBSTONE.test(name))
      ) {
        const legacy = legacyCacheKeepStoreDirectory(
          this.options.storageId,
          this.options.legacyRoot ?? this.options.root,
        )
        try {
          await lstat(legacy)
          if (!(await this.directoryReady(legacy))) return
          names = await readdir(legacy)
          directory = legacy
        } catch {
          return
        }
      }
      const candidates: Array<[name: string, expiresAt: number]> = []
      let collecting = mode === 'restore' && this.options.restoreNewestFirst
      function* orderedNames() {
        yield* names.sort()
        collecting = false
        candidates.sort((a, b) => b[1] - a[1])
        for (const [name] of candidates) yield name
      }
      for (const name of orderedNames()) {
        const temp = TEMP.test(name)
        if (!FILE.test(name) && !temp) continue
        const key = name.slice(0, 64)
        const path = join(directory, name)
        if (temp && !(await this.staleTemp(path))) continue
        if (guard && !(await guard(key))) continue
        // Multi-process hosts must hold the session claim while reading or
        // deleting, including expiry cleanup and abandoned temporary writes.
        const ownRelease = !claim
          ? await this.scanClaim(
              key,
              temp || mode === 'sweep' ? 'sweep' : 'session',
            )
          : undefined
        const release = claim ? await claim(key) : ownRelease
        if ((claim || this.claims) && !release) continue
        let reason: DropReason | undefined
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
          const bytes = await this.readRecordBytes(path)
          if (bytes === 'unsafe-file') {
            reason = 'unsafe-file'
            throw new Error('Unsafe restart file')
          }
          reason = 'unreadable'
          const raw = await this.inflateRecord(bytes)
          reason = 'invalid'
          entry = JSON.parse(raw) as SavedCacheKeepTarget
          const status = recordStatus(entry, name, clock())
          if (status === 'future') {
            // After a clock rollback, leave the record unclaimed for the next
            // scan (on a new lease or claim release) or for expiry.
            continue
          }
          if (status) {
            reason = status
            throw new Error('Invalid restart file')
          }
          const expired = entry.cacheExpiresAt <= now
          reason = undefined
          if (!(await permitted())) continue
          let deleted = false
          try {
            if (this.claims)
              deleted = await this.newClaim(key, 'sweep').deletedAfter(
                acceptedAt(entry),
              )
          } catch {
            // An unreadable deletion marker is not proof the record is stale.
            this.writeFailed()
            continue
          }
          if (deleted) {
            reason = 'deleted'
            throw new Error('Deleted restart record')
          }
          if (collecting && !expired) {
            // Keep only the sort keys. The second pass rechecks both the
            // claim and the record before accepting it, without buffering all
            // saved bodies or holding their claims between passes.
            candidates.push([name, entry.cacheExpiresAt])
            continue
          }
          const removedCredit = hasFallbackCreditInRequest(entry.bodyText)
          if (removedCredit) {
            entry = {
              ...entry,
              bodyText: await withoutFallbackCredit(entry.bodyText),
            }
            if (!(await permitted())) continue
          }
          const owned = mode === 'restore' ? ownRelease?.item : undefined
          if (owned && (this.claims?.get(key) !== owned || owned.closing))
            continue
          // Old records have no acceptance time. Give tracking and the claim
          // the same fallback without changing the saved record or its age.
          const restoredAcceptedAt = acceptedAt(entry, clock())
          const acceptance = accept(entry, restoredAcceptedAt)
          if (acceptance === undefined) continue
          const accepted = expired ? 'expired' : acceptance
          if (accepted !== true && accepted !== undefined) {
            reason = accepted || 'invalid'
            throw new Error('Stale restart file')
          }
          if (accepted === true) {
            if (owned) {
              owned.retained = true
              owned.adopted = { entry, acceptedAt: restoredAcceptedAt }
            }
            // Replace a credited file with its signed, replayable body. Retire
            // legacy paths only after the private copy is durable.
            if (removedCredit || directory !== this.directory) {
              try {
                const adopted = entry
                const migrate = async (assertOwned?: () => Promise<void>) => {
                  await this.writeEntry(adopted, assertOwned)
                  // The durable copy is authoritative; the old source must
                  // not resurrect a session once that copy is forgotten.
                  await assertOwned?.()
                  if (directory !== this.directory)
                    await rm(path, { force: true })
                }
                if (owned) {
                  if (!(await owned.claim.withCurrent(migrate))) continue
                } else if (release?.withCurrent) {
                  if (!(await release.withCurrent(() => migrate()))) continue
                } else await migrate()
              } catch {
                this.refuse()
                return
              }
            }
            restored++
          }
        } catch {
          // A failed open, read or close doesn't prove the record is invalid.
          if (!reason) {
            this.writeFailed()
            continue
          }
          const drop = async () => {
            if (temp && !(await this.staleTemp(path))) return
            if (guard && !(await guard(key))) return
            if (release?.withCurrent) {
              if (!(await release.withCurrent(() => rm(path, { force: true }))))
                return
            } else {
              if (release?.canRemove && !(await release.canRemove())) return
              await rm(path, { force: true })
            }
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

  private async readRecordBytes(path: string) {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES)
      return 'unsafe-file' as const
    const bytes = await readWindowsOwnerOnly(
      path,
      this.options.ownerOnly,
      'unsafe-file',
    )
    if (bytes) return bytes
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
      return 'unsafe-file' as const
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      return await file.readFile()
    } finally {
      await file.close()
    }
  }

  private async inflateRecord(bytes: Buffer) {
    const raw = await decompress(bytes, { maxOutputLength: MAX_RECORD_BYTES })
    return raw.toString('utf8')
  }

  private async hasNewerRecord(id: string, when: number) {
    const name = `${hash(id)}.json.gz`
    const bytes = await this.readRecordBytes(join(this.directory, name)).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      },
    )
    if (!bytes || bytes === 'unsafe-file') return false
    try {
      const saved = JSON.parse(
        await this.inflateRecord(bytes),
      ) as SavedCacheKeepTarget
      const status = recordStatus(
        saved,
        name,
        this.options.now?.() ?? Date.now(),
      )
      // Not ready for replay does not make a newer accepted body expendable.
      return (!status || status === 'future') && acceptedAt(saved) > when
    } catch {
      return false
    }
  }

  private async staleTemp(path: string) {
    // Older writers used anonymous temporary names. Allow a full long-cache
    // lifetime for publication before treating any of these files as abandoned.
    const stat = await lstat(path).catch(() => undefined)
    return !!stat && stat.mtimeMs <= Date.now() - TEMP_STALE_MS
  }

  changed(target: Readonly<CacheKeepTarget>, realTurn = true) {
    if (this.disabled) return
    if (hasFallbackCreditInRequest(target.bodyText)) return
    const entry = record(target, this.options.pluginVersion)
    if (realTurn) this.realTurn(entry.id)
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
    const authority = this.writeAuthority(id)
    this.enqueue(async () => {
      await this.persist(entry, authority)
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
  async reserveWarm(
    target: Readonly<CacheKeepTarget>,
  ): Promise<CacheKeepWarmReservation> {
    if (hasFallbackCreditInRequest(target.bodyText))
      return 'ownership-unverified'
    if (this.disabled) return this.memoryOnly || 'ownership-unverified'
    const entry = record(target, this.options.pluginVersion)
    const timer = this.timers.get(entry.id)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(entry.id)
    this.pending.delete(entry.id)
    this.latest.set(entry.id, entry)
    this.lastWrite.set(entry.id, this.options.now?.() ?? Date.now())
    const authority = this.writeAuthority(entry.id)
    let result: CacheKeepWarmReservation = 'ownership-unverified'
    this.chain = this.chain
      .then(async () => {
        if (!(await this.directoryReady())) return
        result = await this.persist(entry, authority, true)
      })
      .catch(() => this.writeFailed())
    await this.chain
    return this.memoryOnly || result
  }

  private writeAuthority(id: string): WriteAuthority {
    return {
      item: this.retainedClaim(hash(id)),
      intent: this.pendingRealClaims.get(id),
      external: this.options.externalClaim?.(id),
    }
  }

  private async persist(
    entry: SavedCacheKeepTarget,
    authority: WriteAuthority,
    reopen = false,
  ): Promise<CacheKeepWarmReservation> {
    const { id } = entry
    const { intent, external } = authority
    const externalStillCurrent = () =>
      external === this.options.externalClaim?.(id)
    // A host may replace its claim while this write waits in the queue. The
    // old write can neither use the replacement nor report its loss.
    const canPublish = () =>
      this.latest.get(id) === entry && externalStillCurrent()
    if (!canPublish()) return 'ownership-unverified'
    const key = hash(id)
    // A write may follow the acquisition it was queued behind, but may not
    // use a token from an unrelated acquisition that happened in the meantime.
    let item = intent?.item ?? authority.item
    if (item !== this.retainedClaim(key)) item = undefined
    if (
      intent &&
      this.pendingRealClaims.get(id) === intent &&
      (item?.restoreOnly || (reopen && !item))
    ) {
      const reopened = await this.takeRealClaim(id, intent, item)
      if (reopened === 'ownership-unverified') return reopened
      item = reopened
    }
    if (!claimCoversEntry(item, entry)) return 'ownership-unverified'
    const claim = item?.claim ?? external
    if ((this.claims || this.options.externalClaim) && !claim) {
      if (reopen && this.claims && canPublish()) this.loseClaim(id)
      return 'not-owner'
    }
    const write = async (assertOwned?: () => Promise<void>) => {
      if (!(await this.writeEntry(entry, assertOwned, canPublish))) return false
      this.committed.set(id, entry)
      return true
    }
    if (!claim) {
      return (await write()) || 'ownership-unverified'
    }
    let result: CacheKeepWarmReservation = 'ownership-unverified'
    if (
      await claim.withCurrent(async (assertOwned) => {
        try {
          if (await write(assertOwned)) result = true
        } catch (error) {
          if (!reopen) throw error
          // In the local "hours" keep-warm schedule (no runner policy) a warm may
          // go out without its count saved to disk, but never without owning the
          // session. Check that the write failed without losing the lock.
          await assertOwned()
          this.writeFailed()
          result = false
        }
      }, acceptedAt(entry))
    )
      return externalStillCurrent() ? result : 'ownership-unverified'
    if (item) await this.closeClaim(key, item)
    if (!externalStillCurrent()) return 'ownership-unverified'
    if (this.latest.get(id) === entry) this.loseClaim(id)
    return 'not-owner'
  }

  private async writeEntry(
    entry: SavedCacheKeepTarget,
    assertOwned?: () => Promise<void>,
    stillLatest?: () => boolean,
  ) {
    const path = join(this.directory, `${hash(entry.id)}.json.gz`)
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const safe = {
        ...entry,
        bodyText: sanitizedBody(await withoutFallbackCredit(entry.bodyText)),
      }
      const bytes = await compress(JSON.stringify(safe))
      if (!(await createWindowsOwnerOnly(temp, bytes, this.options.ownerOnly)))
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await assertOwned?.()
      // A refund or new acceptance can supersede the snapshot during staging.
      if (stillLatest && !stillLatest()) return false
      const publication = await renameWithWindowsSharingRetry(
        temp,
        path,
        { platform: this.options.ownerOnly?.platform },
        async () => {
          await assertOwned?.()
          return stillLatest && !stillLatest() ? 'skip' : 'publish'
        },
      )
      return publication === 'published'
    } finally {
      await rm(temp, { force: true })
    }
  }

  private forgetEntry(id: string) {
    const timer = this.timers.get(id)
    if (timer) (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.delete(id)
    this.pending.delete(id)
    this.latest.delete(id)
    this.committed.delete(id)
    this.pendingRealClaims.delete(id)
    this.lastWrite.delete(id)
  }

  private loseClaim(id: string) {
    this.forgetEntry(id)
    this.options.onClaimLost?.(id)
  }

  private async requestDeletion(claim: CacheKeepClaim) {
    try {
      await claim.requestDeletion(true)
    } catch {
      this.writeFailed()
      // A busy lock must not discard a host deletion. Retry without holding up
      // unrelated records or keeping the process alive just for bookkeeping.
      setTimeout(() => void this.requestDeletion(claim), 1000).unref?.()
    }
  }

  removed(
    ...[target, removeUnowned, requestAcceptedAt]:
      | [target: Readonly<CacheKeepTarget>]
      | [id: string, removeUnowned: true, requestAcceptedAt?: number]
      | [id: string, removeUnowned: 'deleted']
  ) {
    const id = typeof target === 'string' ? target : target.id
    const key = hash(id)
    const item = this.retainedClaim(key)
    const external = this.options.externalClaim?.(id)
    // Pruning can evict a replacement before it is reported to the store.
    // Only the acceptance being retired can justify unlinking its record.
    const canRemove =
      removeUnowned === 'deleted' ||
      claimCoversEntry(
        item,
        typeof target === 'string'
          ? undefined
          : record(target, this.options.pluginVersion),
      )
    this.forgetEntry(id)
    if (item) item.retiring = true
    if (
      !removeUnowned &&
      (this.claims || this.options.externalClaim) &&
      !item &&
      !external
    )
      return
    this.enqueue(
      async () => {
        if (!canRemove) return
        const owned = item && this.claims?.get(key) === item ? item : undefined
        const claim = owned?.claim ?? external
        const path = join(this.directory, `${key}.json.gz`)
        // A failed track can retire a claim without covering its saved body.
        // Check freshness under the deletion lock so a newer body survives.
        const mayDelete =
          requestAcceptedAt === undefined
            ? undefined
            : async () => !(await this.hasNewerRecord(id, requestAcceptedAt))
        if (this.claims && removeUnowned === 'deleted')
          await this.requestDeletion(claim ?? this.newClaim(key, 'sweep'))
        else if (this.claims && removeUnowned && !item && !claim)
          await this.newClaim(key, 'sweep').requestDeletion(false, mayDelete)
        else if (claim)
          await claim.withCurrent(async (assertOwned) => {
            if (mayDelete && !(await mayDelete())) return
            await assertOwned()
            await rm(path, { force: true })
          })
        else if (
          !this.claims &&
          !this.options.externalClaim &&
          (!mayDelete || (await mayDelete()))
        )
          await rm(path, { force: true })
      },
      async () => {
        // Release even if the directory is unusable. An uncovered record stays
        // on disk, so wake keepers that may now be able to adopt it.
        if (item && this.claims?.get(key) === item)
          await this.closeClaim(key, item, !canRemove)
      },
    )
  }

  clear() {
    const claims = new Map(this.claims)
    for (const timer of this.timers.values())
      (this.options.clearTimeoutImpl ?? clearTimeout)(timer)
    this.timers.clear()
    this.pending.clear()
    this.latest.clear()
    this.committed.clear()
    this.pendingRealClaims.clear()
    this.lastWrite.clear()
    this.enqueue(async () => {
      for (const name of await readdir(this.directory)) {
        const path = join(this.directory, name)
        const temp = TEMP.test(name)
        if (!FILE.test(name) && !temp) continue
        if (temp && !(await this.staleTemp(path))) continue
        const key = name.slice(0, 64)
        const own = claims.get(key)
        if (own) {
          if ((await own.acquired) === true && this.claims?.get(key) === own)
            await own.claim.withCurrent(async (assertOwned) => {
              if (temp && !(await this.staleTemp(path))) return
              await assertOwned()
              await rm(path, { force: true })
            })
          continue
        }
        const release = await this.scanClaim(key, 'sweep')
        if (this.claims && !release) continue
        try {
          if (release?.canRemove && !(await release.canRemove())) continue
          if (temp && !(await this.staleTemp(path))) continue
          await rm(path, { force: true })
        } finally {
          await release?.()
        }
      }
      for (const [key, item] of claims)
        if (this.claims?.get(key) === item)
          await this.closeClaim(key, item).catch(() => this.writeFailed())
    })
  }

  async drain() {
    for (const id of this.pending.keys()) this.flush(id)
    await this.chain
  }
}
