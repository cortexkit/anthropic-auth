import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { logger } from './logger.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import type { RelocationGuard } from './relocation-guard.ts'
import {
  StateLayoutRefusalError,
  stateLayoutConflict,
  stateLayoutIoFailure,
} from './state-layout-errors.ts'
import { fileSha256 } from './state-layout-io.ts'
import { STATE_HOME_FILE_NAMES } from './state-layout-paths.ts'
import {
  movingJournalPath,
  readStateLayoutRecord,
  type StateLayoutRecord,
} from './state-layout-record.ts'
import { windowsLongPath } from './windows-long-path.ts'

/** The files a state-home process watches for a conflict with its own copies. */
export interface StateHomeServingFiles {
  /** The state-home folder, holding `layout.json`. */
  readonly sub: string
  readonly oldPoolState: string
  readonly newPoolState: string
  readonly oldJournal: string
  readonly newJournal: string
  /**
   * The old custody roster and vault store state, roster and routing files.
   * They hold no credential, so one back in the old folder is only warned
   * about.
   */
  readonly oldMetadata: readonly string[]
}

/**
 * The serving files of a state-home dataset. Only OpenCode's default dataset
 * can be in the state-home layout, so the old copies have the default names
 * beside the account state file.
 */
export function stateHomeServingFiles(
  paths: Pick<NativePoolPaths, 'legacyState' | 'state' | 'journal' | 'runtime'>,
): StateHomeServingFiles {
  const oldDir = dirname(paths.legacyState)
  return {
    sub: dirname(paths.runtime),
    oldPoolState: join(oldDir, STATE_HOME_FILE_NAMES.localPoolState),
    newPoolState: paths.state,
    oldJournal: join(oldDir, STATE_HOME_FILE_NAMES.journal),
    newJournal: paths.journal,
    oldMetadata: METADATA_ROLES.map((role) =>
      join(oldDir, STATE_HOME_FILE_NAMES[role]),
    ),
  }
}

const METADATA_ROLES = [
  'localRoster',
  'vaultStoreState',
  'vaultRoster',
  'vaultRouting',
] as const

async function exists(path: string): Promise<boolean> {
  return (await identityOf(path)) !== 'absent'
}

/** Old files that hold no credential and are back in the old folder after a move. */
export async function reappearedMetadataFiles(
  record: StateLayoutRecord,
): Promise<string[]> {
  const found: string[] = []
  for (const file of record.files) {
    if (!(METADATA_ROLES as readonly string[]).includes(file.role)) continue
    // Until cleanup is done the verified old copy may still be there.
    if (record.cleanup === 'pending' && file.sha256 !== null) continue
    if (record.kept?.includes(file.from)) continue
    if (await exists(file.from)) found.push(file.from)
  }
  return found
}

/** Old metadata files already warned about, so each is warned about once. */
const warnedReappeared = new Set<string>()

/**
 * Warn, once per file and process, about old metadata files back in the old
 * folder. Serving goes on: they hold no credential and nothing reads them.
 */
export async function warnReappearedMetadata(
  record: StateLayoutRecord,
): Promise<void> {
  let found: string[]
  try {
    found = await reappearedMetadataFiles(record)
  } catch (error) {
    throw guardIoFailure(record.sub, error)
  }
  for (const path of found) {
    if (warnedReappeared.has(path)) continue
    warnedReappeared.add(path)
    logger.warn(
      'state-layout',
      `anthropic-auth found ${path} in the config folder after moving its state to ${record.sub}. It holds no credentials and is not used; delete it when convenient.`,
      { path },
    )
  }
}

type Identity = string | 'absent'

async function identityOf(path: string): Promise<Identity> {
  try {
    const info = await lstat(windowsLongPath(path), { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent'
    throw error
  }
}

/**
 * What an old file holds: absent, the hash of a regular file, or `other` for
 * anything that isn't a plain file (a symlink, a folder), which can never be
 * proven to be the verified copy.
 */
type Observed = string | 'absent' | 'other'

async function observe(path: string): Promise<Observed> {
  try {
    return (await fileSha256(path)) ?? 'absent'
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === undefined
    )
      return 'other'
    throw error
  }
}

/** What the serving check saw of the old files. */
export interface StateHomeObservation {
  readonly oldJournal: boolean
  readonly oldPoolState: Observed
  /**
   * The journal under the name the move set it aside as
   * (`<journal>.moving-<attempt>`). Cleanup removes it; until then it must
   * still hold the verified bytes.
   */
  readonly movingJournal: Observed
}

/**
 * Why a state-home dataset must not be served now, or undefined when it may.
 * An old pool state or journal back at the legacy path after the move, or an
 * old pool state or set-aside journal whose bytes differ from the verified
 * copy while cleanup is still pending, is a fatal conflict: two
 * usable-looking copies of a single-use refresh token.
 */
export function stateHomeConflictFrom(
  record: StateLayoutRecord,
  files: StateHomeServingFiles,
  observed: StateHomeObservation,
): StateLayoutRefusalError | undefined {
  if (record.phase !== 'committed')
    return new StateLayoutRefusalError(
      'restore-unfinished',
      `anthropic-auth state for ${record.oldDir} is being restored to the old folder, so this process stopped using ${files.sub}. Restart OpenCode once the restore has finished.`,
      [files.sub],
    )
  if (record.cleanup === 'conflict') {
    const first = record.conflict?.[0]
    return stateLayoutConflict(
      first?.old ?? files.oldPoolState,
      first?.new ?? files.newPoolState,
    )
  }
  if (observed.oldJournal)
    return stateLayoutConflict(files.oldJournal, files.newJournal)
  const recorded = (role: 'localPoolState' | 'journal') =>
    record.files.find((file) => file.role === role)?.sha256 ?? null
  // While cleanup is pending the verified old copy may still be there; it
  // is behind the barriers. Any other bytes, or any old copy once cleanup
  // removed it, is a second copy.
  const second = (seen: Observed, sha256: string | null) =>
    seen !== 'absent' &&
    (record.cleanup !== 'pending' || sha256 === null || seen !== sha256)
  if (second(observed.oldPoolState, recorded('localPoolState')))
    return stateLayoutConflict(files.oldPoolState, files.newPoolState)
  // The set-aside journal is never served, so only a changed one while
  // cleanup is pending matters: cleanup would find it and stop every process.
  if (
    record.cleanup === 'pending' &&
    second(observed.movingJournal, recorded('journal'))
  )
    return stateLayoutConflict(
      movingJournalPath(files.oldJournal, record.attempt),
      files.newJournal,
    )
  return undefined
}

interface Evaluation {
  readonly refusal: StateLayoutRefusalError | undefined
  readonly record: StateLayoutRecord | undefined
  /** The set-aside journal of the record's attempt, when there is a record. */
  readonly moving: string | undefined
  /** Its `lstat` identity, taken before it was hashed. */
  readonly movingIdentity: Identity | undefined
}

async function evaluate(files: StateHomeServingFiles): Promise<Evaluation> {
  let record: StateLayoutRecord | undefined
  try {
    record = await readStateLayoutRecord(files.sub)
  } catch (error) {
    return {
      refusal: markerRefusal(files.sub, error),
      record: undefined,
      moving: undefined,
      movingIdentity: undefined,
    }
  }
  if (!record)
    return {
      refusal: markerRefusal(files.sub),
      record,
      moving: undefined,
      movingIdentity: undefined,
    }
  const moving = movingJournalPath(files.oldJournal, record.attempt)
  const movingIdentity = await identityOf(moving)
  const oldJournal = (await identityOf(files.oldJournal)) !== 'absent'
  const [oldPoolState, movingJournal] = await Promise.all([
    observe(files.oldPoolState),
    observe(moving),
  ])
  return {
    refusal: stateHomeConflictFrom(record, files, {
      oldJournal,
      oldPoolState,
      movingJournal,
    }),
    record,
    moving,
    movingIdentity,
  }
}

/** Read the marker and old files and report a conflict, without caching. */
export async function checkStateHomeServing(
  files: StateHomeServingFiles,
): Promise<StateLayoutRefusalError | undefined> {
  try {
    return (await evaluate(files)).refusal
  } catch (error) {
    return guardIoFailure(files.sub, error)
  }
}

/**
 * The refusal for a failure to look at a state-home dataset's files (an
 * `lstat` or read that fails with EACCES, EIO and the like): the fixed text
 * of `io-failed`, never the raw error with its path.
 */
function guardIoFailure(sub: string, error: unknown): StateLayoutRefusalError {
  return error instanceof StateLayoutRefusalError
    ? error
    : stateLayoutIoFailure(`check the state of ${sub}`, [sub], error)
}

function markerRefusal(sub: string, cause?: unknown) {
  const path = join(sub, STATE_HOME_FILE_NAMES.layoutMarker)
  return new StateLayoutRefusalError(
    'marker-unreadable',
    `anthropic-auth can't read ${path}, which records where its state is, so it stopped using that state. Restore the file from a backup or ask for help; do not delete the state folder.`,
    [path],
    cause,
  )
}

/** Conflicts already logged by this process, so each is logged once. */
const reported = new Set<string>()

interface ServingObservation {
  /** The `lstat` identities the result was computed from. */
  readonly key: string
  /** The set-aside journal of the record's attempt. */
  readonly moving: string | undefined
  readonly refusal: StateLayoutRefusalError | undefined
}

/**
 * The last full check of each dataset, by its serving files, shared by every
 * guard over that dataset in this process. A guard made for one request (a
 * local authorization builds fresh runtime readers each time) therefore
 * starts from what earlier guards read, and a healthy check costs only
 * `lstat`s.
 */
const observations = new Map<string, ServingObservation>()

/** What a test observes of the guard's file access. */
export type StateHomeServingProbe = (
  event: { type: 'lstat'; paths: number } | { type: 'read' },
) => void
let probe: StateHomeServingProbe | undefined

/** Observe the guard's `lstat` calls and its full reads; tests only. */
export function probeStateHomeServingForTests(
  next: StateHomeServingProbe | undefined,
): void {
  probe = next
}

/**
 * A guard that stops an already serving state-home process once its dataset
 * is in conflict. It has the relocation guard's shape so every locked write
 * callback that checks for a move (vault store, roster, routing, authorize)
 * checks for a conflict instead. It also warns once about an old metadata
 * file back in the old folder. It takes no lock, and reads files again only
 * when the `lstat` identity of the marker, an old file or the set-aside
 * journal changed, so a check costs a few parallel `lstat`s while nothing
 * changes.
 */
export function createStateHomeServingGuard(
  files: StateHomeServingFiles,
): RelocationGuard & { check(): Promise<StateLayoutRefusalError | undefined> } {
  const marker = join(files.sub, STATE_HOME_FILE_NAMES.layoutMarker)
  const dataset = JSON.stringify(files)
  function report(refusal: StateLayoutRefusalError | undefined) {
    if (refusal && !reported.has(refusal.message)) {
      reported.add(refusal.message)
      logger.error('state-layout', refusal.message, {
        code: refusal.code,
        paths: refusal.paths,
      })
    }
    return refusal
  }
  async function check() {
    try {
      return report(await observeDataset())
    } catch (error) {
      // Not remembered: once the files can be looked at again, the next
      // check reads them afresh.
      return report(guardIoFailure(files.sub, error))
    }
  }
  async function observeDataset() {
    const last = observations.get(dataset)
    // Every identity is taken before the file it describes is read, so a
    // change after this point always shows up as a new key next time.
    const watched = [
      marker,
      files.oldJournal,
      files.oldPoolState,
      ...files.oldMetadata,
    ]
    const moving = last?.moving
    const paths = moving ? [...watched, moving] : watched
    probe?.({ type: 'lstat', paths: paths.length })
    const identities = await Promise.all(paths.map(identityOf))
    const before = identities.slice(0, watched.length)
    if (
      last &&
      last.key ===
        JSON.stringify([before, moving ?? null, identities[watched.length]])
    )
      return last.refusal
    probe?.({ type: 'read' })
    const result = await evaluate(files)
    observations.set(dataset, {
      key: JSON.stringify([
        before,
        result.moving ?? null,
        result.movingIdentity,
      ]),
      moving: result.moving,
      refusal: result.refusal,
    })
    if (result.record) await warnReappearedMetadata(result.record)
    return result.refusal
  }
  return {
    check,
    async assertNotRelocated() {
      const refusal = await check()
      if (refusal) throw refusal
    },
    async isRelocated() {
      return (await check()) !== undefined
    },
  }
}

/** Forget logged conflicts and shared observations; tests only. */
export function resetStateHomeServingGuardForTests() {
  reported.clear()
  observations.clear()
  warnedReappeared.clear()
}
