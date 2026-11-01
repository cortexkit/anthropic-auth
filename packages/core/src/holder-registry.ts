import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { uptime } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { LockContentionError, writeJsonAtomic } from '@cortexkit/common-auth/fs'

import { parseJsonRedacted } from './json.ts'
import { logger } from './logger.ts'
import {
  type NativeLockEvent,
  withDetachedNativeLocks,
  withNativeLock,
} from './native-lock-observer.ts'
import { nativeVaultPaths } from './native-vault-paths.ts'
import {
  ensureWindowsOwnerOnlyDirectory,
  type OwnerOnlyOptions,
} from './owner-only.ts'
import { type NativePoolPaths, stateLayoutOfPaths } from './pool-paths.ts'
import {
  findRelocationTombstone,
  nativeRelocationRuntimePaths,
  RelocatedError,
} from './relocation-guard.ts'
import {
  StateLayoutRefusalError,
  stateLayoutRefusalPublicMessage,
} from './state-layout-errors.ts'
import {
  configFolderIdentity,
  STATE_HOME_FILE_NAMES,
} from './state-layout-paths.ts'

/** The file, beside a dataset's files, that lists the processes using them. */
export const HOLDER_FILE_NAME = 'anthropic-auth-holders.json'
/** Lock name on the holder file: lock file `<holder file>.holders.lock`. */
export const HOLDER_LOCK_NAME = 'holders'
/**
 * How long a registrant waits for the holder lock. A process moving or
 * restoring state holds it for the whole transition; an ordinary registrant
 * holds it for one small read and write.
 */
export const HOLDER_LOCK_TIMEOUT_MS = 120_000
/** At most one retry a minute after a failed ordinary registration. */
export const HOLDER_RETRY_INTERVAL_MS = 60_000
const HOLDER_LOCK_TTL_MS = 10_000
const HOLDER_FILE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Where a registered process keeps the dataset: `legacy` beside OpenCode's
 * account files; `explicit` beside files named by a path override; `pi`
 * beside Pi's files. `state-home` is written by later releases only, which
 * keep moved state under the CortexKit state folder.
 */
export type HolderKind = 'legacy' | 'explicit' | 'pi' | 'state-home'
/** Which kind of process registered. */
export type HolderRole = 'opencode1' | 'opencode2' | 'cli' | 'setup' | 'pi'

/** One process's use of one dataset, as recorded in a holder file. */
export interface HolderEntry {
  readonly pid: number
  /**
   * A value the OS fixes for the life of the process (Linux boot id and start
   * ticks; macOS start time), or null where none is read (Windows). It tells a
   * reused pid from the process that registered.
   */
  readonly incarnation: string | null
  /** Distinguishes copies of this code loaded into the same process. */
  readonly instance: string
  readonly role: HolderRole
  readonly release: string
  readonly kind: HolderKind
  /** The config folder's identity for `legacy`, otherwise null. */
  readonly identity: string | null
  /** Canonical paths of every dataset file the process uses. */
  readonly files: readonly string[]
  readonly registeredAt: number
}

/** Added to pid artifacts written by this version and later, so a newer version can tell them from those of older versions. */
export interface WriterStamp {
  readonly protocol: 1
  readonly release: string
}

const RELEASE_PACKAGES = new Set([
  '@cortexkit/anthropic-auth-core',
  '@cortexkit/opencode-anthropic-auth',
  '@cortexkit/pi-anthropic-auth',
])
let release: string | undefined

/**
 * This code's release, read once from the package.json one folder above the
 * running module (the same in a source checkout and in each published
 * package, whose versions are kept equal). `unknown` when it can't be read.
 */
export function anthropicAuthRelease(): string {
  if (release !== undefined) return release
  release = 'unknown'
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name?: unknown; version?: unknown }
    if (
      typeof manifest.name === 'string' &&
      RELEASE_PACKAGES.has(manifest.name) &&
      typeof manifest.version === 'string' &&
      manifest.version.trim()
    )
      release = manifest.version.trim()
  } catch {
    // Keep `unknown`; the stamp's protocol is what readers check.
  }
  return release
}

/**
 * The `writer` field this version adds to RPC port files and CacheKeep records.
 * Older readers copy only the fields they know, so they ignore it.
 */
export function writerStamp(): WriterStamp {
  return { protocol: 1, release: anthropicAuthRelease() }
}

/**
 * Every file of a dataset that a later release may move: local pool state,
 * local runtime, journal, local custody roster, vault store state, vault
 * runtime, vault roster and vault routing, sorted.
 */
export function nativeHolderDatasetFiles(paths: NativePoolPaths): string[] {
  const vault = nativeVaultPaths(paths, stateLayoutOfPaths(paths))
  return [
    ...new Set([
      paths.state,
      paths.runtime,
      paths.journal,
      paths.roster,
      vault.state,
      vault.runtime,
      vault.roster,
      vault.routing,
    ]),
  ].sort()
}

/**
 * A directory a later release may move state into: its path ends in
 * `cortexkit/anthropic-auth/opencode` or `cortexkit/anthropic-auth/opencode-`
 * followed by 16 hex digits, under any state root.
 */
export function isDestinationShapedDirectory(dir: string): boolean {
  const name = basename(dir)
  const parent = dirname(dir)
  return (
    (name === 'opencode' || /^opencode-[0-9a-f]{16}$/.test(name)) &&
    basename(parent) === 'anthropic-auth' &&
    basename(dirname(parent)) === 'cortexkit'
  )
}

/** OpenCode's dataset is `explicit` when a path override names its files. */
export function openCodeHolderKind(
  env: NodeJS.ProcessEnv = process.env,
): 'legacy' | 'explicit' {
  return env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim() ||
    env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE?.trim()
    ? 'explicit'
    : 'legacy'
}

export type HolderRegistrationErrorCode =
  | 'lock-timeout'
  | 'managed-folder'
  | 'malformed'
  | 'unavailable'

const HOLDER_REGISTRATION_MESSAGES: Record<
  HolderRegistrationErrorCode,
  string
> = {
  'lock-timeout':
    'Another anthropic-auth process is moving or restoring state for this folder; start again in a minute.',
  'managed-folder':
    "An anthropic-auth path override points into anthropic-auth's managed state folder. Remove the override.",
  malformed:
    'anthropic-auth could not record its use of its state folder: the holder file there is invalid.',
  unavailable:
    'anthropic-auth could not record its use of its state folder, so it refuses to use that folder.',
}

/**
 * A registration that must succeed did not, or a path override points into
 * a folder anthropic-auth manages. The message is fixed; `directory` and the
 * cause carry the details for logs and diagnostics.
 */
export class HolderRegistrationError extends Error {
  readonly code: HolderRegistrationErrorCode
  readonly directory: string

  constructor(
    code: HolderRegistrationErrorCode,
    directory: string,
    cause?: unknown,
  ) {
    super(
      HOLDER_REGISTRATION_MESSAGES[code],
      cause === undefined ? undefined : { cause },
    )
    this.name = 'HolderRegistrationError'
    this.code = code
    this.directory = directory
  }
}

/** Every fixed message `HolderRegistrationError` can carry. */
export const HOLDER_REGISTRATION_ERROR_MESSAGES: readonly string[] =
  Object.values(HOLDER_REGISTRATION_MESSAGES)

/**
 * The relocation or registration refusal behind `error`, if any. Pool and
 * roster operations wrap what their hooks throw in their own error, which
 * keeps the original as its `cause`, so the chain is followed a few levels.
 */
export function stateRefusalCause(
  error: unknown,
):
  | RelocatedError
  | HolderRegistrationError
  | StateLayoutRefusalError
  | undefined {
  let current = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (
      current instanceof RelocatedError ||
      current instanceof HolderRegistrationError ||
      current instanceof StateLayoutRefusalError
    )
      return current
    current = current.cause
  }
  return undefined
}

/**
 * The fixed message, naming no file or folder, to show for the relocation,
 * registration or layout refusal behind `error`, or undefined when there is
 * none. Hosts show it where their output may be shared; the refusal's own
 * message and the log name the files.
 */
export function stateRefusalPublicMessage(error: unknown): string | undefined {
  const cause = stateRefusalCause(error)
  if (!cause) return undefined
  return cause instanceof StateLayoutRefusalError
    ? stateLayoutRefusalPublicMessage(cause.code)
    : cause.message
}

/** How liveness is read; tests replace it. */
export interface HolderLiveness {
  pidAlive(pid: number): boolean
  /** Undefined or null when it can't be read. */
  incarnation(pid: number): Promise<string | null>
  /** Wall clock and OS uptime; tests replace both. */
  now?(): number
  uptime?(): number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

let bootId: Promise<string | null> | undefined

async function linuxIncarnation(pid: number): Promise<string | null> {
  bootId ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(
    (text) => text.trim() || null,
    () => null,
  )
  const boot = await bootId
  if (!boot) return null
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    // The command name (field 2) is in parentheses and may hold spaces, so
    // count fields from the last ')'. Field 22 is the start time in ticks.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const start = fields[19]
    return start && /^\d+$/.test(start) ? `${boot}:${start}` : null
  } catch {
    return null
  }
}

function macosIncarnation(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      // UTC0 renders the kernel's fixed start time the same way every time,
      // whatever the time zone.
      { env: { ...process.env, TZ: 'UTC0' }, timeout: 5_000 },
      (error, stdout) => {
        const text = String(stdout ?? '').trim()
        resolve(error || !text ? null : text)
      },
    )
  })
}

/** The OS's fixed per-process value for `pid`, or null when none is read. */
export function processIncarnation(pid: number): Promise<string | null> {
  if (process.platform === 'linux') return linuxIncarnation(pid)
  if (process.platform === 'darwin') return macosIncarnation(pid)
  return Promise.resolve(null)
}

const defaultLiveness: HolderLiveness = {
  pidAlive,
  incarnation: processIncarnation,
}

/**
 * A process recorded before this boot cannot still be running, even if its
 * pid is alive again. Keep a five-minute margin for clock imprecision, and
 * keep blocking when the timestamp is missing, invalid or in the future.
 */
export function recordPredatesBoot(
  startedAt: unknown,
  clock: Pick<HolderLiveness, 'now' | 'uptime'> = {},
): boolean {
  if (
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    startedAt < 0
  )
    return false
  const now = (clock.now ?? Date.now)()
  const uptimeSeconds = (clock.uptime ?? uptime)()
  return (
    Number.isFinite(now) &&
    Number.isFinite(uptimeSeconds) &&
    uptimeSeconds >= 0 &&
    startedAt <= now &&
    startedAt < now - uptimeSeconds * 1000 - 5 * 60_000
  )
}

/**
 * Whether an entry's process may still be running. An entry from before
 * this boot or a dead pid is stale. Otherwise an unreadable incarnation
 * counts as alive; only a different incarnation clears a live pid.
 */
export async function holderEntryIsLive(
  entry: Pick<HolderEntry, 'pid' | 'incarnation'> & { registeredAt?: unknown },
  liveness: HolderLiveness = defaultLiveness,
): Promise<boolean> {
  if (recordPredatesBoot(entry.registeredAt, liveness)) return false
  if (!liveness.pidAlive(entry.pid)) return false
  if (entry.incarnation === null) return true
  let current: string | null
  try {
    current = await liveness.incarnation(entry.pid)
  } catch {
    current = null
  }
  return current === null || current === entry.incarnation
}

export interface HolderFileContents {
  /** Entries as found, including any this version doesn't understand. */
  entries: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An entry's liveness fields when its pid and incarnation have a usable shape. */
export function holderEntryLiveness(
  value: unknown,
):
  | (Pick<HolderEntry, 'pid' | 'incarnation'> & { registeredAt?: unknown })
  | undefined {
  if (!isRecord(value)) return undefined
  const { pid, incarnation } = value
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
    return undefined
  if (incarnation !== null && typeof incarnation !== 'string') return undefined
  return { pid, incarnation, registeredAt: value.registeredAt }
}

function sameRegistration(value: unknown, entry: HolderEntry): boolean {
  if (!isRecord(value)) return false
  const files = value.files
  return (
    value.pid === entry.pid &&
    value.incarnation === entry.incarnation &&
    value.role === entry.role &&
    value.kind === entry.kind &&
    Array.isArray(files) &&
    files.length === entry.files.length &&
    files.every((file, index) => file === entry.files[index])
  )
}

/**
 * Read a holder file. Undefined when it is absent. A file that exists but
 * doesn't parse throws: rewriting it would erase other processes' entries.
 */
export async function readHolderFile(
  path: string,
): Promise<HolderFileContents | undefined> {
  let text: string
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > HOLDER_FILE_MAX_BYTES)
      throw new HolderRegistrationError('malformed', dirname(path))
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: unknown
  try {
    value = parseJsonRedacted(text)
  } catch (cause) {
    throw new HolderRegistrationError('malformed', dirname(path), cause)
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries))
    throw new HolderRegistrationError('malformed', dirname(path))
  return { entries: value.entries }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function anyExists(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (await exists(path)) return true
  return false
}

/** A directory holding `config-dir.json` or `layout.json` belongs to a moved dataset. */
async function isManagedDirectory(dir: string): Promise<boolean> {
  return (
    (await exists(join(dir, STATE_HOME_FILE_NAMES.configDirMarker))) ||
    (await exists(join(dir, STATE_HOME_FILE_NAMES.layoutMarker)))
  )
}

/**
 * Refuse dataset paths a caller chose itself, rather than the layout
 * decision, when they reach into the state folder: paths resolved in the
 * state-home layout, or with any dataset file in a folder anthropic-auth
 * manages (holding `config-dir.json` or `layout.json`) or in a
 * destination-shaped folder. Serving such files needs the decision's
 * admission under the holder lock, which checks the move record; registering
 * them as an ordinary `legacy` dataset would skip it. Throws
 * `HolderRegistrationError('managed-folder')`, whose message is fixed.
 */
export async function assertUnmanagedInjectedPaths(
  paths: NativePoolPaths,
): Promise<void> {
  if (stateLayoutOfPaths(paths).kind === 'state-home')
    throw new HolderRegistrationError('managed-folder', dirname(paths.runtime))
  const dirs = [
    ...new Set(nativeHolderDatasetFiles(paths).map((file) => dirname(file))),
  ].sort()
  for (const dir of dirs)
    if (isDestinationShapedDirectory(dir) || (await isManagedDirectory(dir)))
      throw new HolderRegistrationError('managed-folder', dir)
}

const instance = randomUUID()
let ownIncarnation: Promise<string | null> | undefined
/**
 * Registrations this copy of the code has published, by holder file, kind,
 * role and files. A later registration of the same dataset in this process
 * takes no lock and writes nothing: a live entry is never removed by another
 * process, and while it is live no mover can change the dataset.
 */
const published = new Set<string>()
/** Directories whose failed registration has already been logged. */
const warned = new Set<string>()

export interface RegisterNativePoolHolderOptions {
  paths: NativePoolPaths
  role: HolderRole
  /** `legacy` or `explicit` for OpenCode (see `openCodeHolderKind`); `pi` for Pi. */
  kind: Exclude<HolderKind, 'state-home'>
  /** Observes the holder locks, as other native lock observers do. */
  onLockEvent?: (event: NativeLockEvent) => void
  /** Tests shorten these; production uses the defaults. */
  lockTimeoutMs?: number
  retryIntervalMs?: number
  liveness?: HolderLiveness
  now?: () => number
  /** How a missing folder is made owner-only; tests simulate Windows here. */
  ownerOnly?: OwnerOnlyOptions
  /**
   * `mandatory`: the entry is published in every holder file before the
   * process serves, even before any dataset file exists there, and any
   * failure to publish refuses with `HolderRegistrationError`. The layout
   * decision passes it once moving is enabled (`unmovedRegistrationPolicy`).
   * Without it, a failed write refuses only for an `explicit` or `pi`
   * dataset with a file in a destination-shaped folder; every other failure
   * is retried in the background.
   */
  policy?: 'mandatory'
}

/** The outcome of a registration that did not refuse. */
export interface NativeHolderRegistration {
  /**
   * `registered` once every holder file lists this process. `pending` while
   * an ordinary registration keeps failing; it is retried in the background
   * at most once a minute until it succeeds or `close()` is called.
   */
  readonly status: 'registered' | 'pending'
  /** Resolves once a pending registration has been retried successfully. */
  readonly settled: Promise<void>
  /** Stop retrying. Published entries stay; later writers prune them once the pid is dead. */
  close(): void
}

function registrationKey(
  holderFile: string,
  entry: Pick<HolderEntry, 'kind' | 'role' | 'files'>,
) {
  return JSON.stringify([holderFile, entry.kind, entry.role, entry.files])
}

/** Refuse when either legacy runtime file is a relocation tombstone. */
async function assertNoTombstone(paths: NativePoolPaths) {
  const found = await findRelocationTombstone(
    nativeRelocationRuntimePaths(paths),
  )
  if (found) {
    logger.error(
      'state-layout',
      'anthropic-auth state was moved by a newer version; this process refuses to use the old files',
      {
        runtimePath: found.path,
        relocatedTo: found.pointer.relocatedTo,
        by: found.pointer.by,
      },
    )
    throw new RelocatedError(found.path, found.pointer)
  }
}

/**
 * Create `dir` for a holder file when it is missing, readable by its owner
 * only: `0700` on POSIX, and on Windows a protected owner-only DACL set by
 * the native helper as the folder is created, along with any missing parent.
 * An existing folder is left exactly as it is: it may be the user's own
 * config folder, shared on purpose. On Windows a folder that another process
 * created first is adopted only if it is owner-only; otherwise this throws.
 */
export async function ensureHolderDirectory(
  dir: string,
  ownerOnly: OwnerOnlyOptions = {},
): Promise<void> {
  if ((ownerOnly.platform ?? process.platform) !== 'win32') {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return
  }
  try {
    await lstat(dir)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
  }
  await ensureWindowsOwnerOnlyDirectory(dir, ownerOnly)
}

async function publishEntry(
  holderFile: string,
  entry: HolderEntry,
  options: RegisterNativePoolHolderOptions,
  mandatory: boolean,
) {
  const dir = dirname(holderFile)
  if (mandatory) await ensureHolderDirectory(dir, options.ownerOnly)
  await withNativeLock(
    holderFile,
    {
      name: HOLDER_LOCK_NAME,
      ttlMs: HOLDER_LOCK_TTL_MS,
      timeoutMs: options.lockTimeoutMs ?? HOLDER_LOCK_TIMEOUT_MS,
      renew: true,
      onLockEvent: options.onLockEvent,
    },
    async (lease) => {
      // A mover installs its tombstones and markers while holding this lock,
      // so what was read before waiting for it may have changed.
      await assertNoTombstone(options.paths)
      if (entry.kind !== 'legacy' && (await isManagedDirectory(dir)))
        throw new HolderRegistrationError('managed-folder', dir)
      await publishHolderEntryLocked(holderFile, entry, {
        liveness: options.liveness,
        assertOwned: () => lease.assertOwned(),
      })
    },
  )
  published.add(registrationKey(holderFile, entry))
}

/**
 * Add `entry` to `holderFile`, pruning stale entries, while the caller holds
 * that file's `holders` lock. Writes nothing when nothing was pruned and a
 * live entry for this process, kind and files is already there. A holder
 * file that doesn't parse throws and is never overwritten.
 */
export async function publishHolderEntryLocked(
  holderFile: string,
  entry: HolderEntry,
  options: { liveness?: HolderLiveness; assertOwned(): Promise<void> },
): Promise<void> {
  const current = await readHolderFile(holderFile)
  const liveness = options.liveness ?? defaultLiveness
  const kept: unknown[] = []
  for (const value of current?.entries ?? []) {
    const life = holderEntryLiveness(value)
    // An entry this version can't read is kept: it may be a live process.
    if (!life || (await holderEntryIsLive(life, liveness))) kept.push(value)
  }
  let changed = kept.length !== (current?.entries.length ?? 0)
  if (!kept.some((value) => sameRegistration(value, entry))) {
    kept.push(entry)
    changed = true
  }
  if (changed) {
    await writeJsonAtomic(
      holderFile,
      { version: 1, entries: kept },
      { beforeRename: () => options.assertOwned() },
    )
  }
  published.add(registrationKey(holderFile, entry))
}

/** A holder entry for this process. */
export async function buildHolderEntry(input: {
  role: HolderRole
  kind: HolderKind
  identity: string | null
  files: readonly string[]
  liveness?: HolderLiveness
  now?: () => number
}): Promise<HolderEntry> {
  ownIncarnation ??= (input.liveness ?? defaultLiveness)
    .incarnation(process.pid)
    .catch(() => null)
  return Object.freeze({
    pid: process.pid,
    incarnation: await ownIncarnation,
    instance,
    role: input.role,
    release: anthropicAuthRelease(),
    kind: input.kind,
    identity: input.identity,
    files: Object.freeze([...input.files].sort()),
    registeredAt: (input.now ?? Date.now)(),
  })
}

async function buildEntry(
  options: RegisterNativePoolHolderOptions,
): Promise<HolderEntry> {
  ownIncarnation ??= (options.liveness ?? defaultLiveness)
    .incarnation(process.pid)
    .catch(() => null)
  let identity: string | null = null
  if (options.kind === 'legacy') {
    try {
      identity =
        configFolderIdentity(dirname(options.paths.legacyConfig)) ?? null
    } catch {
      identity = null
    }
  }
  return Object.freeze({
    pid: process.pid,
    incarnation: await ownIncarnation,
    instance,
    role: options.role,
    release: anthropicAuthRelease(),
    kind: options.kind,
    identity,
    files: Object.freeze(nativeHolderDatasetFiles(options.paths)),
    registeredAt: (options.now ?? Date.now)(),
  })
}

/**
 * Record, beside a dataset's files, that this process uses them, before the
 * process's first pool I/O for that dataset. A later release reads these
 * records and never moves a dataset that a live process still uses.
 *
 * Refuses, whatever the outcome of the write, when either legacy runtime file
 * is a relocation tombstone (`RelocatedError`), or when an `explicit` or `pi`
 * dataset lies in a folder anthropic-auth manages (`HolderRegistrationError`
 * with `managed-folder`).
 *
 * A failed write is handled by `options.policy`. With `mandatory` the call
 * throws `HolderRegistrationError` and the process must not serve. Without
 * it, by kind:
 * - An `explicit` or `pi` dataset with a file in a destination-shaped folder
 *   (see `isDestinationShapedDirectory`) must be registered there, so the
 *   call throws `HolderRegistrationError` and the process must not serve it.
 * - Every other dataset is served as before: the failure is logged once at
 *   WARN and retried in the background at most once a minute. Such a
 *   process also records itself in a folder only once one of its dataset
 *   files exists there; until then the same retry checks again.
 *
 * Call it holding no data lock: a mover holds the holder lock while it waits
 * for data locks.
 */
export async function registerNativePoolHolder(
  options: RegisterNativePoolHolderOptions,
): Promise<NativeHolderRegistration> {
  const entry = await buildEntry(options)
  const dirs = [...new Set(entry.files.map((file) => dirname(file)))].sort()
  const holderFiles = dirs.map((dir) => join(dir, HOLDER_FILE_NAME))
  const done: NativeHolderRegistration = {
    status: 'registered',
    settled: Promise.resolve(),
    close() {},
  }
  if (holderFiles.every((file) => published.has(registrationKey(file, entry))))
    return done
  await assertNoTombstone(options.paths)
  if (entry.kind !== 'legacy')
    for (const dir of dirs)
      if (await isManagedDirectory(dir))
        throw new HolderRegistrationError('managed-folder', dir)
  const mandatory =
    options.policy === 'mandatory' ||
    (entry.kind !== 'legacy' && dirs.some(isDestinationShapedDirectory))
  const attempt = registrationAttempt(options, entry, mandatory)
  if (await attempt()) return done
  return retryInBackground(attempt, options)
}

/**
 * Hand a registration that already failed once to the ordinary policy's
 * background retry, for a caller that tried to publish `options`'s entry
 * itself and may serve without it: log the failure at WARN (once per folder
 * and process) and retry at most once a minute until it succeeds or `close()`
 * is called. A retry that finds a relocation tombstone or a managed folder
 * stops retrying; the relocation guards then refuse every later write.
 */
export function deferNativePoolHolderRegistration(
  options: RegisterNativePoolHolderOptions,
  failure: { readonly directory: string; readonly error: unknown },
): NativeHolderRegistration {
  warnRegistrationFailure(failure.directory, failure.error)
  let attempt: (() => Promise<boolean>) | undefined
  return retryInBackground(async () => {
    attempt ??= registrationAttempt(options, await buildEntry(options), false)
    return attempt()
  }, options)
}

function warnRegistrationFailure(dir: string, error: unknown): void {
  if (warned.has(dir)) return
  warned.add(dir)
  logger.warn(
    'state-layout',
    `anthropic-auth could not record that it is using ${dir}; if a newer version moves these files while this process runs, this process will stop and ask for a restart`,
    {
      code:
        error instanceof HolderRegistrationError
          ? error.code
          : error instanceof LockContentionError
            ? 'lock-timeout'
            : ((error as NodeJS.ErrnoException)?.code ?? 'unknown'),
    },
  )
}

/**
 * One attempt to publish `entry` in every holder file of its dataset not yet
 * published; resolves true when all are. Without `mandatory`, a failure is
 * logged once and leaves the attempt incomplete; with it, the failure throws
 * `HolderRegistrationError`. A relocation tombstone or a managed folder
 * always throws.
 */
function registrationAttempt(
  options: RegisterNativePoolHolderOptions,
  entry: HolderEntry,
  mandatory: boolean,
): () => Promise<boolean> {
  const dirs = [...new Set(entry.files.map((file) => dirname(file)))].sort()
  const holderFiles = dirs.map((dir) => join(dir, HOLDER_FILE_NAME))
  return async (): Promise<boolean> => {
    let complete = true
    for (const holderFile of holderFiles) {
      if (published.has(registrationKey(holderFile, entry))) continue
      const dir = dirname(holderFile)
      try {
        // An ordinary registrant records itself in a folder only once one of
        // its dataset files is there. Until then nothing in that folder can
        // be moved from under it, and a refused command or an unmigrated
        // install leaves the folder exactly as it was. The retry records the
        // process once a file appears.
        if (
          !mandatory &&
          !(await anyExists(
            entry.files.filter((file) => dirname(file) === dir),
          ))
        ) {
          complete = false
          continue
        }
        await publishEntry(holderFile, entry, options, mandatory)
      } catch (error) {
        if (
          error instanceof RelocatedError ||
          (error instanceof HolderRegistrationError &&
            error.code === 'managed-folder')
        )
          throw error
        if (mandatory)
          throw error instanceof HolderRegistrationError
            ? error
            : new HolderRegistrationError(
                error instanceof LockContentionError
                  ? 'lock-timeout'
                  : 'unavailable',
                dir,
                error,
              )
        complete = false
        warnRegistrationFailure(dir, error)
      }
    }
    return complete
  }
}

/** Retry `attempt` in the background at most once a minute until it completes or is closed. */
function retryInBackground(
  attempt: () => Promise<boolean>,
  options: Pick<RegisterNativePoolHolderOptions, 'retryIntervalMs'>,
): NativeHolderRegistration {
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let settle: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const schedule = () => {
    if (closed) return
    timer = setTimeout(() => {
      timer = undefined
      // A retry is background work; it must never count as a lock taken for
      // a request.
      void withDetachedNativeLocks(attempt).then(
        (complete) => {
          if (complete) settle()
          else schedule()
        },
        () => {
          // A relocation or managed-folder refusal found on retry: the
          // relocation guards refuse every later write, so stop retrying.
        },
      )
    }, options.retryIntervalMs ?? HOLDER_RETRY_INTERVAL_MS)
    // A retry must not keep the process alive.
    ;(timer as { unref?: () => void }).unref?.()
  }
  schedule()
  return {
    status: 'pending',
    settled,
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** Forget what this process has published; tests only. */
export function resetNativeHolderRegistryForTests() {
  published.clear()
  warned.clear()
  ownIncarnation = undefined
}
