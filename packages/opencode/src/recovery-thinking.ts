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
import {
  createWindowsOwnerOnly,
  ensureWindowsOwnerOnlyDirectory,
  getHostDataHome,
  isOwnerOnly,
  logger,
  type OwnerOnlyOptions,
  readWindowsOwnerOnly,
  renameWithWindowsSharingRetry,
} from '@cortexkit/anthropic-auth-core'

/**
 * Thinking blocks written by Opus 4.8 during an OpenCode refusal-recovery
 * round, and how they are kept out of the source model's view.
 *
 * When the source model (Fable 5.2, for example) refuses part-way through a
 * turn, OpenCode keeps the refused response's signed thinking and appends the
 * Opus 4.8 retry to the same assistant message. That Anthropic turn then holds
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
  recorded: ReadonlySet<string>,
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
      if (!sourceThinkingInTurn) {
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
): (event: Record<string, unknown>) => void {
  const open = new Map<
    number,
    { type: 'thinking' | 'redacted_thinking'; value: string }
  >()
  return (event) => {
    const index = event.index
    if (typeof index !== 'number') return
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
    if (event.type === 'content_block_stop') {
      const entry = open.get(index)
      open.delete(index)
      if (entry && entry.value.length > 0) {
        onDigest(recoveryThinkingDigest(entry.type, entry.value))
      }
    }
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
 * history. Records untouched this long are deleted on the first load.
 */
const IDLE_TTL_MS = 30 * 24 * 60 * 60_000
const WRITE_DELAY_MS = 1_000
const MAX_FILE_BYTES = 2 * 1024 * 1024

type SessionRecord = {
  families: Map<string, Set<string>>
  loading: Promise<void>
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
  private readonly directory: string
  private readonly now: () => number
  private readonly writeDelayMs: number
  private readonly ownerOnly: OwnerOnlyOptions | undefined
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private swept = false
  private warned = false

  constructor(
    options: {
      directory?: string
      now?: () => number
      writeDelayMs?: number
      ownerOnly?: OwnerOnlyOptions
    } = {},
  ) {
    this.directory = options.directory ?? recoveryThinkingStoreDirectory()
    this.now = options.now ?? Date.now
    this.writeDelayMs = options.writeDelayMs ?? WRITE_DELAY_MS
    this.ownerOnly = options.ownerOnly
  }

  /** The recorded digests for one session and family; loads once per session. */
  async digests(
    sessionId: string,
    family: string,
  ): Promise<ReadonlySet<string>> {
    const record = this.session(sessionId)
    await record.loading
    return record.families.get(family) ?? new Set()
  }

  /** Record one fallback-model thinking block; the write happens later. */
  record(sessionId: string, family: string, digest: string) {
    if (!FAMILY.test(family) || !DIGEST.test(digest)) return
    const record = this.session(sessionId)
    addDigest(record.families, family, digest)
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
    const path = join(this.directory, sessionFileName(sessionId))
    this.chain = this.chain
      .then(() => rm(path, { force: true }))
      .catch(() => this.warn('delete'))
  }

  /** Write every pending change now. Tests and shutdown use this. */
  async flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.enqueueWrites()
    await this.chain
  }

  private session(sessionId: string): SessionRecord {
    const existing =
      this.sessions.get(sessionId) ?? this.unwritten.get(sessionId)
    if (existing) {
      this.unwritten.delete(sessionId)
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    const record: SessionRecord = {
      families: new Map(),
      loading: Promise.resolve(),
      dirty: false,
    }
    record.loading = this.load(sessionId, record)
    this.sessions.set(sessionId, record)
    while (this.sessions.size > MAX_SESSIONS_IN_MEMORY) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      const evicted = this.sessions.get(oldest)
      this.sessions.delete(oldest)
      // Until its last change is on disk, a reload must not read the old file.
      if (evicted?.dirty) {
        this.unwritten.set(oldest, evicted)
        this.enqueueWrite(oldest, evicted)
      }
    }
    return record
  }

  private async load(sessionId: string, record: SessionRecord) {
    try {
      await this.sweep()
      const path = join(this.directory, sessionFileName(sessionId))
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
      )
        return
      const bytes =
        (await readWindowsOwnerOnly(path, this.ownerOnly)) ??
        (await readFile(path))
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown
      if (!isRecord(parsed) || parsed.version !== STORE_FORMAT_VERSION) return
      if (!isRecord(parsed.families)) return
      for (const [family, digests] of Object.entries(parsed.families)) {
        if (!FAMILY.test(family) || !Array.isArray(digests)) continue
        const loaded = digests.filter(
          (digest): digest is string =>
            typeof digest === 'string' && DIGEST.test(digest),
        )
        // Digests recorded before the load finished are newer; keep them last.
        const current = record.families.get(family)
        record.families.delete(family)
        for (const digest of loaded) addDigest(record.families, family, digest)
        for (const digest of current ?? [])
          addDigest(record.families, family, digest)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn('read')
    }
  }

  /** Delete idle records and stale temporaries, once per process. */
  private async sweep() {
    if (this.swept) return
    this.swept = true
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch {
      return
    }
    const cutoff = this.now() - IDLE_TTL_MS
    for (const name of names) {
      if (!FILE.test(name) && !TEMP.test(name)) continue
      const path = join(this.directory, name)
      try {
        const stat = await lstat(path)
        if (TEMP.test(name) || stat.mtimeMs < cutoff)
          await rm(path, { force: true })
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
    record.dirty = false
    this.chain = this.chain
      .then(async () => {
        await record.loading
        // A session deleted meanwhile must not be written back.
        if (record.deleted) return
        if (!(await this.directoryReady())) return
        await this.write(sessionId, record)
      })
      .catch(() => this.warn('write'))
      .finally(() => {
        if (this.unwritten.get(sessionId) === record && !record.dirty)
          this.unwritten.delete(sessionId)
      })
  }

  private async directoryReady() {
    if (
      !(await ensureWindowsOwnerOnlyDirectory(this.directory, this.ownerOnly))
    ) {
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const stat = await lstat(this.directory)
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await isOwnerOnly(
        this.directory,
        () => stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700,
        this.ownerOnly,
      ))
    )
  }

  private async write(sessionId: string, record: SessionRecord) {
    const path = join(this.directory, sessionFileName(sessionId))
    const temp = `${path}.${randomUUID()}.tmp`
    const families: Record<string, string[]> = {}
    for (const [family, digests] of record.families)
      families[family] = [...digests]
    const bytes = JSON.stringify({ version: STORE_FORMAT_VERSION, families })
    try {
      if (!(await createWindowsOwnerOnly(temp, bytes, this.ownerOnly)))
        await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
      await renameWithWindowsSharingRetry(temp, path, {
        platform: this.ownerOnly?.platform,
      })
    } finally {
      await rm(temp, { force: true })
    }
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
  families: Map<string, Set<string>>,
  family: string,
  digest: string,
) {
  let digests = families.get(family)
  if (!digests) {
    digests = new Set()
    families.set(family, digests)
  }
  digests.delete(digest)
  digests.add(digest)
  while (digests.size > MAX_DIGESTS_PER_FAMILY) {
    const oldest = digests.values().next().value
    if (oldest === undefined) break
    digests.delete(oldest)
  }
}
