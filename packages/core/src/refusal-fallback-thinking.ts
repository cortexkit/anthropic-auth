import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { withLock } from '@cortexkit/common-auth/fs'
import { getHostDataHome } from './host-paths.ts'
import { logger } from './logger.ts'
import {
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  isOwnerOnly,
  type OwnerOnlyOptions,
  readWindowsOwnerOnly,
} from './owner-only.ts'
import { renameWithWindowsSharingRetry } from './publication-rename.ts'
import { refusalBodyRecord as isBody } from './refusal-fallback-prefix.ts'

/**
 * Thinking blocks written by a fallback model during refusal recovery.
 *
 * When the source model (Fable 5.2, for example) refuses part-way through a
 * turn, the host keeps the refused response's signed thinking and appends the
 * retry to the same assistant message. That Anthropic turn then holds
 * source-signed thinking followed by Opus-signed thinking. While that turn is
 * the latest assistant turn, the source model rejects the request with a
 * non-retryable 400 ("thinking or redacted_thinking blocks in the latest
 * assistant message cannot be modified"). The source model accepts the same
 * turn once it is no longer the latest, and accepts a latest turn that holds
 * only Opus thinking.
 *
 * Requests back to the source model therefore drop the round's Opus thinking
 * from any turn where source thinking comes first. The drop is applied on
 * every later source request, not only while the turn is the latest, so the
 * prefix the source model saw when it wrote its later thinking, the thread
 * continuation and the prompt cache all stay the same from one request to the
 * next.
 *
 * Blocks are identified by a SHA-256 of their signature (or redacted data),
 * recorded from the round's own responses. Thinking text and raw signatures
 * are never stored.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hash of a thinking block's signature or a redacted block's data. */
export function recoveryThinkingDigest(
  type: 'thinking' | 'redacted_thinking',
  value: string,
): string {
  return createHash('sha256')
    .update(type === 'thinking' ? 'thinking\0' : 'redacted_thinking\0')
    .update(value)
    .digest('base64url')
}

function blockDigest(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined
  if (block.type === 'thinking') {
    return typeof block.signature === 'string' && block.signature.length > 0
      ? recoveryThinkingDigest('thinking', block.signature)
      : undefined
  }
  if (block.type === 'redacted_thinking') {
    return typeof block.data === 'string' && block.data.length > 0
      ? recoveryThinkingDigest('redacted_thinking', block.data)
      : undefined
  }
  return undefined
}

function isToolResultOnlyUserMessage(message: Record<string, unknown>) {
  return (
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every(
      (block) => isRecord(block) && block.type === 'tool_result',
    )
  )
}

/**
 * Drop recorded recovery-round thinking from every Anthropic turn in which
 * unrecorded (source) thinking comes before it. Anthropic counts an assistant
 * turn as its assistant messages plus the user messages that hold only tool
 * results; any other user message starts a new turn. Other roles, such as
 * mid-conversation system messages, do not end a turn. A block is kept when
 * removing it would leave its message empty. Returns the number of blocks
 * removed; the body is untouched when nothing matches.
 */
export function stripRecoveryRoundThinking(
  body: Record<string, unknown>,
  recorded: ReadonlyMap<string, symbol | undefined>,
  liveRound?: symbol,
): number {
  if (recorded.size === 0 || !Array.isArray(body.messages)) return 0
  let removed = 0
  let sourceThinkingInTurn = false
  for (const message of body.messages) {
    if (!isRecord(message)) continue
    if (message.role !== 'assistant') {
      if (message.role === 'user' && !isToolResultOnlyUserMessage(message))
        sourceThinkingInTurn = false
      continue
    }
    if (!Array.isArray(message.content)) continue
    const content = message.content
    let kept: unknown[] | undefined
    for (let index = 0; index < content.length; index++) {
      const block = content[index]
      const digest = blockDigest(block)
      if (digest === undefined) {
        kept?.push(block)
        continue
      }
      if (!recorded.has(digest)) {
        sourceThinkingInTurn = true
        kept?.push(block)
        continue
      }
      if (
        !sourceThinkingInTurn ||
        (liveRound && recorded.get(digest) === liveRound)
      ) {
        kept?.push(block)
        continue
      }
      kept ??= content.slice(0, index)
      removed++
    }
    if (!kept) continue
    if (kept.length === 0) {
      // An assistant message cannot be empty; leave this one as it was.
      removed -= content.length
      continue
    }
    message.content = kept
  }
  return removed
}

/**
 * Collect the digests of the thinking blocks in one streamed response, from
 * parsed SSE event payloads. A block is reported once its
 * `content_block_stop` arrives, so a block cut off mid-stream is never
 * reported.
 */
export function createRecoveryThinkingObserver(
  onDigest: (digest: string) => void,
) {
  const open = new Map<
    number,
    { type: 'thinking' | 'redacted_thinking'; value: string }
  >()
  function report(index: number) {
    const entry = open.get(index)
    open.delete(index)
    if (entry?.value) onDigest(recoveryThinkingDigest(entry.type, entry.value))
  }
  return {
    push(event: Record<string, unknown>, index: number) {
      if (event.type === 'content_block_start') {
        const block = isRecord(event.content_block)
          ? event.content_block
          : undefined
        if (block?.type === 'thinking') {
          open.set(index, {
            type: 'thinking',
            value: typeof block.signature === 'string' ? block.signature : '',
          })
        } else if (block?.type === 'redacted_thinking') {
          open.set(index, {
            type: 'redacted_thinking',
            value: typeof block.data === 'string' ? block.data : '',
          })
        } else {
          open.delete(index)
        }
        return
      }
      if (event.type === 'content_block_delta') {
        const entry = open.get(index)
        const delta = isRecord(event.delta) ? event.delta : undefined
        if (
          entry?.type === 'thinking' &&
          delta?.type === 'signature_delta' &&
          typeof delta.signature === 'string'
        ) {
          entry.value += delta.signature
        }
        return
      }
      if (event.type === 'content_block_stop') report(index)
    },
    close: report,
    finish() {
      for (const index of open.keys()) report(index)
    },
  }
}

const STORE_FORMAT_VERSION = 1
const DIGEST = /^[A-Za-z0-9_-]{43}$/
const FAMILY = /^[a-z0-9-]{1,64}$/
const FILE = /^[a-f0-9]{64}\.json$/
const TEMP = /^[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/
/** A 40-response round writes a few blocks per response; this bounds a session. */
const MAX_DIGESTS_PER_FAMILY = 4096
const MAX_SESSIONS_IN_MEMORY = 128
/**
 * A record outlives its round: the trimmed turn stays in the session's
 * history. Records untouched this long are deleted by a sweep that runs once
 * per process, in the background, from the store's first use.
 */
const IDLE_TTL_MS = 30 * 24 * 60 * 60_000
/**
 * A temporary file this young may belong to a write still running in another
 * OpenCode process that shares the folder, so the sweep leaves it alone.
 */
const STALE_TEMP_MS = 10 * 60_000
const WRITE_DELAY_MS = 1_000
/**
 * Shutdown waits at most this long for pending writes, then gives up. It is
 * the same one-second grace the quota and last-used saves get at shutdown.
 */
const SHUTDOWN_GRACE_MS = 1_000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const READ_GRACE_MS = 2_000
const RECORD_LOCK = {
  name: 'recovery-thinking',
  ttlMs: 10_000,
  timeoutMs: 1_000,
  renew: true,
}

type Families = Map<string, Map<string, symbol | undefined>>

type SessionRecord = {
  families: Families
  loading: Promise<void>
  ready?: boolean
  pins: number
  dirty: boolean
  deleted?: boolean
}

export function recoveryThinkingStoreDirectory(root = getHostDataHome()) {
  return join(root, 'cortexkit', 'anthropic-auth', 'recovery-thinking')
}

const sessionFileName = (sessionId: string) =>
  `${createHash('sha256').update(sessionId).digest('hex')}.json`

/**
 * Per-session digests of the thinking blocks written by the fallback model
 * during refusal-recovery rounds, keyed by the source model's recovery family
 * (the capability table's `refusalRecoveryFamily`, such as `fable-5-2`).
 * Memory is the source of truth for requests; disk keeps the record across
 * restarts. Each session's file is read once, at first use. Writes are
 * coalesced and detached, so a request never waits for one. Files are
 * owner-only and hold only digests.
 */
export class RecoveryThinkingStore {
  private readonly sessions = new Map<string, SessionRecord>()
  /** Records evicted from memory whose last change is not on disk yet. */
  private readonly unwritten = new Map<string, SessionRecord>()
  private readonly directory: string | undefined
  private readonly now: () => number
  private readonly writeDelayMs: number
  private readonly ownerOnly: OwnerOnlyOptions | undefined
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private swept = false
  private warned = false
  private warnedTimeout = false

  constructor(
    options: {
      directory?: string
      now?: () => number
      writeDelayMs?: number
      ownerOnly?: OwnerOnlyOptions
      /** Do not read or write on-disk state. */
      persist?: boolean
    } = {},
  ) {
    this.directory =
      options.persist === false
        ? undefined
        : (options.directory ?? recoveryThinkingStoreDirectory())
    this.now = options.now ?? Date.now
    this.writeDelayMs = options.writeDelayMs ?? WRITE_DELAY_MS
    this.ownerOnly = options.ownerOnly
  }

  /** Wait for the first disk record, but do not block a request indefinitely. */
  async loadSession(sessionId: string): Promise<void> {
    if (!this.directory) return
    const record = this.session(sessionId)
    if (record.ready) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        record.loading,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            record.ready = true
            if (!this.warnedTimeout) {
              this.warnedTimeout = true
              logger.warn(
                'fable-fallback',
                'recovery thinking record read timed out; sending without it',
              )
            }
            resolve()
          }, READ_GRACE_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  peek(
    sessionId: string,
    family: string,
  ): ReadonlyMap<string, symbol | undefined> | undefined {
    return (
      this.sessions.get(sessionId) ?? this.unwritten.get(sessionId)
    )?.families.get(family)
  }

  /**
   * Keep this session's in-memory round associations (which live round each
   * recorded digest belongs to) until the retry or round that holds them ends.
   */
  retainSession(sessionId: string): () => void {
    const record = this.session(sessionId)
    record.pins++
    return () => {
      record.pins--
      this.prune()
    }
  }

  /** Record one fallback-model thinking block; the write happens later. */
  record(sessionId: string, family: string, digest: string, round?: symbol) {
    if (!FAMILY.test(family) || !DIGEST.test(digest)) return
    const record = this.session(sessionId)
    // A digest already recorded keeps its first round association; a later
    // round never takes it over.
    const known = record.families.get(family)
    addDigest(
      record.families,
      family,
      digest,
      known?.has(digest) ? known.get(digest) : round,
    )
    if (!this.directory) return
    record.dirty = true
    this.schedule()
  }

  /** Forget a deleted session, in memory and on disk. */
  forgetSession(sessionId: string) {
    for (const records of [this.sessions, this.unwritten]) {
      const record = records.get(sessionId)
      if (record) record.deleted = true
      records.delete(sessionId)
    }
    if (!this.directory) return
    const path = join(this.directory, sessionFileName(sessionId))
    this.chain = this.chain
      .then(() => rm(path, { force: true }))
      .catch(() => this.warn('delete'))
  }

  /** Write every pending change now. Tests use this; shutdown uses close. */
  async flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.enqueueWrites()
    await this.chain
  }

  /**
   * Write pending changes at shutdown, waiting at most SHUTDOWN_GRACE_MS. A
   * round that ends just before a restart would otherwise lose its record.
   */
  async close() {
    let timer: ReturnType<typeof setTimeout> | undefined
    const written = await Promise.race([
      this.flush().then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    if (!written)
      logger.warn(
        'fable-fallback',
        'recovery thinking record not fully written before shutdown',
      )
  }

  private session(sessionId: string): SessionRecord {
    const existing =
      this.sessions.get(sessionId) ?? this.unwritten.get(sessionId)
    if (existing) {
      this.unwritten.delete(sessionId)
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      this.prune(existing)
      return existing
    }
    const record: SessionRecord = {
      families: new Map(),
      loading: Promise.resolve(),
      dirty: false,
      pins: 0,
    }
    if (this.directory) {
      record.loading = this.load(this.directory, sessionId, record).finally(
        () => {
          record.ready = true
        },
      )
    }
    this.sessions.set(sessionId, record)
    if (this.directory) this.startSweep(this.directory)
    this.prune(record)
    return record
  }

  private prune(exclude?: SessionRecord) {
    for (const [id, record] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS_IN_MEMORY) break
      if (record.pins || record === exclude) continue
      this.sessions.delete(id)
      // Until its last change is on disk, a reload must not read the old file.
      if (record.dirty) {
        this.unwritten.set(id, record)
        this.enqueueWrite(id, record)
      }
    }
  }

  private async load(
    directory: string,
    sessionId: string,
    record: SessionRecord,
  ) {
    const disk = await this.readRecord(
      join(directory, sessionFileName(sessionId)),
    )
    for (const [family, loaded] of disk) {
      // Digests recorded before the load finished are newer; keep them last.
      const current = record.families.get(family)
      const fromDisk = new Set(loaded.keys())
      record.families.set(family, loaded)
      for (const [digest, round] of current ?? [])
        addDigest(
          record.families,
          family,
          digest,
          fromDisk.has(digest) ? undefined : round,
        )
    }
  }

  private async readRecord(path: string): Promise<Families> {
    const families: Families = new Map()
    try {
      const stat = await lstat(path)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_FILE_BYTES ||
        !(await isOwnerOnly(
          path,
          () => stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0,
          this.ownerOnly,
        ))
      ) {
        this.warn('read')
        return families
      }
      const bytes =
        (await readWindowsOwnerOnly(path, this.ownerOnly)) ??
        (await readFile(path))
      const parsed = isBody(JSON.parse(bytes.toString('utf8')))
      if (
        parsed?.version !== STORE_FORMAT_VERSION ||
        !isRecord(parsed.families)
      ) {
        this.warn('read')
        return families
      }
      for (const [family, digests] of Object.entries(parsed.families)) {
        if (!FAMILY.test(family) || !Array.isArray(digests)) continue
        for (const digest of digests)
          if (typeof digest === 'string' && DIGEST.test(digest))
            addDigest(families, family, digest)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn('read')
    }
    return families
  }

  /**
   * Queue the sweep once per process, behind any queued write or delete, so it
   * never removes a temporary file this process is still writing. Requests
   * never wait for it.
   */
  private startSweep(directory: string) {
    if (this.swept) return
    this.swept = true
    this.chain = this.chain.then(() => this.sweep(directory)).catch(() => {})
  }

  /** Whether a record file belongs to a session this process is using. */
  private inUse(name: string) {
    for (const records of [this.sessions, this.unwritten]) {
      for (const sessionId of records.keys()) {
        if (sessionFileName(sessionId) === name) return true
      }
    }
    return false
  }

  /** Delete idle records and stale temporaries. */
  private async sweep(directory: string) {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return
    }
    const now = this.now()
    for (const name of names) {
      const temp = TEMP.test(name)
      if (!temp && !FILE.test(name)) continue
      const path = join(directory, name)
      try {
        const stat = await lstat(path)
        const expired = temp
          ? stat.mtimeMs < now - STALE_TEMP_MS
          : stat.mtimeMs < now - IDLE_TTL_MS
        // Checked right before removal: a session loaded since readdir keeps
        // its file.
        if (expired && !this.inUse(name)) await rm(path, { force: true })
      } catch {}
    }
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.enqueueWrites()
    }, this.writeDelayMs)
    this.timer.unref?.()
  }

  private enqueueWrites() {
    for (const [sessionId, record] of this.sessions) {
      if (record.dirty) this.enqueueWrite(sessionId, record)
    }
  }

  private enqueueWrite(sessionId: string, record: SessionRecord) {
    const directory = this.directory
    if (!directory) return
    record.dirty = false
    this.chain = this.chain
      .then(async () => {
        await record.loading
        // A session deleted meanwhile must not be written back.
        if (record.deleted) return
        if (!(await this.directoryReady(directory)) || record.deleted) return
        await this.write(directory, sessionId, record)
      })
      .catch(() => this.warn('write'))
      .finally(() => {
        if (this.unwritten.get(sessionId) === record && !record.dirty)
          this.unwritten.delete(sessionId)
      })
  }

  private async directoryReady(directory: string) {
    if (!(await ensureWindowsOwnerOnlyDirectory(directory, this.ownerOnly))) {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const stat = await lstat(directory)
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await isOwnerOnly(
        directory,
        () => stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
        this.ownerOnly,
      ))
    )
  }

  private async write(
    directory: string,
    sessionId: string,
    record: SessionRecord,
  ) {
    const path = join(directory, sessionFileName(sessionId))
    await withLock(path, RECORD_LOCK, async (lease) => {
      // Another host may have committed digests since we first read the file.
      const disk = await this.readRecord(path)
      if (record.deleted) return
      for (const [family, digests] of record.families) {
        const known = new Set(disk.get(family)?.keys())
        for (const digest of digests.keys())
          if (!known.has(digest)) addDigest(disk, family, digest)
      }
      const families = Object.fromEntries(
        [...disk].map(([family, digests]) => [family, [...digests.keys()]]),
      )
      const bytes = JSON.stringify({ version: STORE_FORMAT_VERSION, families })
      const temp = `${path}.${randomUUID()}.tmp`
      try {
        if (!(await createWindowsOwnerOnly(temp, bytes, this.ownerOnly)))
          await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
        await lease.assertOwned()
        if (record.deleted) return
        await renameWithWindowsSharingRetry(temp, path, {
          platform: this.ownerOnly?.platform,
        })
      } finally {
        await rm(temp, { force: true })
      }
    })
  }

  private warn(stage: string) {
    if (this.warned) return
    this.warned = true
    logger.warn(
      'fable-fallback',
      'recovery thinking record unavailable on disk; keeping it in memory',
      { stage },
    )
  }
}

function addDigest(
  families: Families,
  family: string,
  digest: string,
  round?: symbol,
) {
  let digests = families.get(family)
  if (!digests) {
    digests = new Map()
    families.set(family, digests)
  }
  digests.delete(digest)
  digests.set(digest, round)
  while (digests.size > MAX_DIGESTS_PER_FAMILY) {
    const oldest = digests.keys().next().value
    if (oldest === undefined) break
    digests.delete(oldest)
  }
}
