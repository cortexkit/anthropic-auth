/**
 * `restore-legacy`: put a moved dataset back in OpenCode's config folder.
 *
 * It runs in its own process with every host stopped (setup's process fence),
 * opens no pool store and registers nothing. It holds the layout lock, both
 * holder locks and the old files' data locks (see `stateLayoutDataLockOrder`)
 * from its first check to its end, so no process can be admitted to either
 * layout while it runs.
 *
 * The restore is forward-only past one durable boundary:
 *
 * - R1 `restoring`: the record lists every state-folder data file (the
 *   restore set) with its hash and its staging name in the config folder.
 * - R2: each file is copied to its staging name, flushed and checked; then
 *   the config folder is flushed. Nothing at a legacy name is touched.
 * - Boundary `restore-staged`: from here the staging files are the only
 *   source; no state-folder copy is ever read again.
 * - R3: staging files are renamed to their legacy names (data first, then a
 *   flush), then the barriers go: the journal comes back, each runtime
 *   tombstone is replaced by its staged copy or removed, then a flush.
 * - R4 `restored` (cleanup pending): the legacy layout is authoritative.
 * - R5: each state-folder copy still holding the staged bytes is removed;
 *   then `restored` with cleanup done, which every start reads as "no move".
 *
 * Crash points. The marker phase is the discriminator: it says which side
 * of the boundary the crash was on.
 *
 * | Crash during or after            | Marker           | Old folder                                   | Recovery                                                                                |
 * |----------------------------------|------------------|----------------------------------------------|-----------------------------------------------------------------------------------------|
 * | before R1 is durable             | `committed`      | unchanged                                    | none needed; state-home serves; a rerun starts again                                    |
 * | R1, R2, boundary not yet visible | `restoring`      | at most some staging files                   | discard: unlink this attempt's staging names, republish `committed`; state-home serves |
 * | boundary written; R3 data part   | `restore-staged` | some data at legacy names, barriers in place | rerun only (starts refuse): finish R3 by the slot table below                           |
 * | R3 barrier part                  | `restore-staged` | journal and runtimes partly back             | rerun only: finish the remaining slots; done slots are left alone                       |
 * | R3 done, before R4               | `restore-staged` | legacy layout complete                       | rerun: every slot is "nothing", then R4 and R5                                          |
 * | R4 done, R5 partial              | `restored`       | legacy layout complete                       | rerun, or the next start without overrides: finish R5                                   |
 *
 * After the boundary each slot is classified afresh from its staging name
 * and its legacy path, never from the state-folder copy, and a slot that is
 * already done is never written again, so a legacy process that served
 * after a barrier was removed keeps what it wrote:
 *
 * | Slot                  | Staging | Legacy path                     | Action                                                                  |
 * |-----------------------|---------|---------------------------------|-------------------------------------------------------------------------|
 * | data file             | present | absent                          | rename staging to the legacy name                                       |
 * |                       | absent  | present                         | nothing: already in place                                               |
 * |                       | present | present                         | rename staging over it: reappeared while every barrier was still up     |
 * |                       | absent  | absent                          | refuse: deleted by hand                                                 |
 * | journal               | present | absent                          | rename staging to the journal                                           |
 * |                       | absent  | present                         | nothing: already back                                                   |
 * |                       | present | present                         | refuse: no supported writer creates a journal behind the barriers       |
 * |                       | absent  | absent                          | refuse: deleted by hand                                                 |
 * | runtime, `copy`       | present | this move's tombstone           | rename staging over the tombstone                                       |
 * |                       | absent  | a file that isn't a tombstone   | nothing: already back                                                   |
 * |                       | absent  | this move's tombstone or absent | refuse: the staging was lost, or the runtime was deleted by hand        |
 * |                       | present | not this move's tombstone       | refuse: no supported writer replaces a tombstone                        |
 * | runtime, `unlink`     | —       | this move's tombstone           | unlink it                                                               |
 * |                       | —       | absent, or a runtime file       | nothing: already removed (a legacy process may have created a runtime) |
 * |                       | —       | another move's tombstone        | refuse                                                                  |
 *
 * Renaming a staging file over a data file that is back ("present, present")
 * is only safe while no barrier has been removed, because only then can no
 * version have served from the old folder. R3 removes barriers only after
 * every data rename is flushed, so a surviving data staging file proves it;
 * the classification also checks that every barrier is still up before it
 * overwrites anything, and refuses otherwise.
 *
 * Why there is no drain of the state folder's row and provider locks: every
 * process that uses a state-folder file has a live entry in that folder's
 * holder file (registration there is mandatory), restore refuses while any
 * entry is live, and it holds the holder lock so none can register. A dead
 * process can't commit a late write either, because every lease is asserted
 * before each rename.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LockContentionError } from '@cortexkit/common-auth/fs'
import { getOpenCodeConfigDir } from './accounts.ts'
import {
  anthropicAuthRelease,
  HOLDER_FILE_NAME,
  type HolderLiveness,
  HolderRegistrationError,
  holderEntryIsLive,
  holderEntryLiveness,
  readHolderFile,
} from './holder-registry.ts'
import {
  defaultPreNArtifactLocations,
  describeFenceBlocker,
  type PreNArtifactLocations,
  preNArtifactBlockers,
  statePathOverrides,
} from './layout-fence.ts'
import { logger } from './logger.ts'
import type { NativeLockEvent } from './native-lock-observer.ts'
import { canonicalPath } from './pool-paths.ts'
import { forgetRelocationObservations } from './relocation-guard.ts'
import {
  RESTORE_LEGACY_COMMAND,
  StateLayoutRefusalError,
  stateLayoutIoFailure,
} from './state-layout-errors.ts'
import {
  createOwnerOnlyFile,
  defaultStateLayoutFs,
  digestFile,
  type StateLayoutFs,
  StateLayoutLockStack,
  sha256Hex,
} from './state-layout-io.ts'
import {
  acquireDataLocks,
  acquireHolderLocks,
  exists,
  expectAbsent,
  expectDigest,
  expectTombstone,
  LAYOUT_LOCK_NAME,
  LAYOUT_LOCK_TIMEOUT_MS,
  owned,
  type RelocationDataset,
  recordFilesProblem,
  resolveRelocationDataset,
  StateLayoutCrash,
  type StateLayoutStep,
  type StateLayoutTransitionContext,
  stateLayoutStep,
  syncLayoutRecord,
  tombstoneAttempt,
} from './state-layout-move.ts'
import {
  readConfigDirMarker,
  resolveStateHomeTarget,
  StateLayoutFileError,
} from './state-layout-paths.ts'
import {
  layoutRecordPath,
  movingJournalPath,
  publishStateLayoutRecord,
  type RelocationRole,
  type RestoreFileRecord,
  readStateLayoutRecord,
  restoreStagingPath,
  type StateLayoutRecord,
} from './state-layout-record.ts'

/** Old files a move removed and restore renames back before any barrier. */
const DATA_ROLES: readonly RelocationRole[] = [
  'localPoolState',
  'localRoster',
  'vaultStoreState',
  'vaultRoster',
  'vaultRouting',
]

const RUNTIME_ROLES = ['localRuntime', 'vaultRuntime'] as const

export interface RestoreLegacyOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  /** Filesystem seam; `node:fs` for this platform otherwise. */
  fs?: StateLayoutFs
  liveness?: HolderLiveness
  /** Where pid artifacts of older versions are looked for. */
  artifacts?: PreNArtifactLocations
  onLockEvent?: (event: NativeLockEvent) => void
  /** Runs at each named step; tests inject faults here. */
  onStep?: (step: StateLayoutStep) => void | Promise<void>
  now?: () => number
  /** Tests shorten the waits; production uses the defaults. */
  timeouts?: { layoutMs?: number; holderMs?: number; dataMs?: number }
}

/** How a restore ended. */
export type RestoreLegacyOutcome =
  | {
      readonly status: 'restored'
      /** The config folder that holds the dataset again. */
      readonly oldDir: string
      /** The state folder it came from. */
      readonly sub: string
      /** State-folder copies that changed after staging and were left in place. */
      readonly kept: readonly string[]
    }
  | {
      /** The dataset is already in the legacy layout; nothing was written. */
      readonly status: 'not-moved'
      readonly reason: string
    }

function refused(
  message: string,
  paths: readonly string[] = [],
  cause?: unknown,
): StateLayoutRefusalError {
  logger.error('state-layout', message, { code: 'restore-refused', paths })
  return new StateLayoutRefusalError('restore-refused', message, paths, cause)
}

/** The restore detail of a record in a restore phase, or a refusal. */
function requireRestoreDetail(record: StateLayoutRecord) {
  const restore = record.restore
  if (!restore?.attempt || !restore.files || !restore.runtimes)
    throw refused(
      `${layoutRecordPath(record.sub)} records an unfinished restore without the files it moved, so anthropic-auth can't finish it.`,
      [layoutRecordPath(record.sub)],
    )
  return {
    ...restore,
    attempt: restore.attempt,
    files: restore.files,
    runtimes: restore.runtimes,
  }
}

/** Expect the record to be in `phase` for this restore attempt. */
function expectRestorePhase(
  sub: string,
  phase: StateLayoutRecord['phase'],
  restoreAttempt: string,
  cleanup?: 'pending',
) {
  return async (): Promise<string | undefined> => {
    let current: StateLayoutRecord | undefined
    try {
      current = await readStateLayoutRecord(sub)
    } catch {
      return 'layout.json is unreadable'
    }
    if (
      current?.phase === phase &&
      current.restore?.attempt === restoreAttempt &&
      (cleanup === undefined || current.restore.cleanup === cleanup)
    )
      return undefined
    return `layout.json is ${current?.phase ?? 'absent'}`
  }
}

/** Both checks must pass; the first mismatch is reported. */
function both(
  first: () => Promise<string | undefined>,
  second: () => Promise<string | undefined>,
) {
  return async () => (await first()) ?? (await second())
}

function expectPresent(path: string) {
  return async (): Promise<string | undefined> =>
    (await exists(path)) ? undefined : 'it is missing'
}

/**
 * Live processes listed in a holder file, described for a message. An
 * entry this version can't read counts as live. With `required`, a missing
 * file is a problem too: every committed move created one in the state
 * folder, so its absence means someone deleted it, and with it the only
 * record of who uses the state folder.
 */
async function holderProblems(
  holderFile: string,
  liveness: HolderLiveness | undefined,
  required: boolean,
): Promise<string[]> {
  let contents: Awaited<ReturnType<typeof readHolderFile>>
  try {
    contents = await readHolderFile(holderFile)
  } catch {
    return [`${holderFile} can't be read`]
  }
  if (!contents)
    return required
      ? [
          `${holderFile} is missing, so anthropic-auth can't tell which processes use that folder`,
        ]
      : []
  const problems: string[] = []
  for (const value of contents.entries) {
    const life = holderEntryLiveness(value)
    const role = (value as { role?: unknown })?.role
    if (!life) {
      problems.push(`${holderFile} lists a process this version can't read`)
      continue
    }
    if (await holderEntryIsLive(life, liveness))
      problems.push(
        `pid ${life.pid}${typeof role === 'string' ? ` (${role})` : ''} is still using the files listed in ${holderFile}`,
      )
  }
  return problems
}

/**
 * Make the record this run found durable, under the locks, before acting on
 * it. The run that published it may have died after renaming it into place
 * but before flushing `<sub>`: R3 or R5 acting on a record that power loss
 * can still revert would leave legacy names or state-folder copies changed
 * under an older phase, whose recovery goes the other way.
 */
export async function syncObservedRestoreRecord(
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<void> {
  try {
    await syncLayoutRecord(dataset, ctx)
  } catch (error) {
    if (error instanceof StateLayoutCrash) throw error
    const path = layoutRecordPath(dataset.sub)
    throw new StateLayoutRefusalError(
      'unsafe',
      `anthropic-auth could not make ${path} durable, so it won't finish restoring its state; run ${RESTORE_LEGACY_COMMAND} again.`,
      [path],
      error,
    )
  }
}

/**
 * R5, under the restore's locks (or a start's layout and holder locks): remove
 * each state-folder copy that still holds the bytes that were staged, then
 * record the cleanup as done. A copy that changed, can't be read, or can't be
 * removed is kept and listed: no process was admitted to the state folder
 * since R1, so only a person can have changed it, and the legacy copy is
 * already durable. Only the record write itself can fail this step.
 */
export async function finishRestoreRetirement(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<StateLayoutRecord> {
  const restore = requireRestoreDetail(record)
  const kept: string[] = [...(record.restore?.kept ?? [])]
  for (const file of restore.files) {
    try {
      const digest = await digestFile(file.to)
      if (digest.status === 'file') {
        if (digest.sha256 === file.sha256)
          await owned(
            ctx,
            { kind: 'unlink', path: file.to },
            expectDigest(file.to, file.sha256),
          )
        else throw new Error('its bytes changed after they were restored')
      }
    } catch (error) {
      if (error instanceof StateLayoutCrash) throw error
      if (!kept.includes(file.to)) kept.push(file.to)
      logger.error(
        'state-layout',
        'anthropic-auth restored its state to the config folder but kept a state-folder copy it could not prove unchanged; delete it once you have checked it',
        {
          path: file.to,
          reason: error instanceof Error ? error.message : String(error),
        },
      )
    }
    await stateLayoutStep(ctx, `restore:retired:${file.role}`)
  }
  await ctx.fs.syncDirectory(dataset.sub)
  await stateLayoutStep(ctx, 'restore:sub-flushed')
  const done: StateLayoutRecord = {
    ...record,
    restore: { ...restore, cleanup: 'done', ...(kept.length ? { kept } : {}) },
  }
  await publishStateLayoutRecord(
    done,
    {
      assertLeases: () => ctx.stack.assertAll(),
      expect: expectRestorePhase(
        dataset.sub,
        'restored',
        restore.attempt,
        'pending',
      ),
    },
    ctx.fs,
  )
  await stateLayoutStep(ctx, 'restore:done')
  forgetRelocationObservations()
  return done
}

/**
 * Undo a restore that stopped before its boundary (phase `restoring`), under
 * the layout lock and both holder locks: unlink this attempt's staging files,
 * flush the config folder, then publish the move's record again as
 * `committed`, as it was before the restore began. Nothing at a legacy name
 * was touched before the boundary and the barriers stayed up, so no version
 * served from the config folder, and the state-folder files were only read.
 */
export async function discardAbandonedRestore(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<StateLayoutRecord> {
  const restore = requireRestoreDetail(record)
  for (const file of restore.files)
    if (await exists(file.staging))
      await owned(
        ctx,
        { kind: 'unlink', path: file.staging },
        expectPresent(file.staging),
      )
  await ctx.fs.syncDirectory(dataset.oldDir)
  const { restore: _abandoned, ...move } = record
  const committed: StateLayoutRecord = { ...move, phase: 'committed' }
  await publishStateLayoutRecord(
    committed,
    {
      assertLeases: () => ctx.stack.assertAll(),
      expect: expectRestorePhase(dataset.sub, 'restoring', restore.attempt),
    },
    ctx.fs,
  )
  await stateLayoutStep(ctx, 'restore:discarded')
  forgetRelocationObservations()
  return committed
}

/** What one slot of R3 does, decided before anything is written. */
type SlotAction =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'rename'
      readonly file: RestoreFileRecord
      /** Whether the legacy name is occupied (the reappeared-file row). */
      readonly over: 'absent' | 'present' | 'tombstone'
    }
  | { readonly kind: 'unlink-tombstone'; readonly path: string }

/**
 * Classify every slot of a staged restore by its staging name and its legacy
 * path (the slot table in this module's comment). Returns the actions in the
 * order R3 takes them, or the problems that make it refuse.
 */
async function classifyStagedRestore(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
): Promise<{
  data: { role: RelocationRole; action: SlotAction }[]
  barriers: { role: RelocationRole; action: SlotAction }[]
  problems: string[]
}> {
  const restore = requireRestoreDetail(record)
  const problems: string[] = []
  const listed = (role: RelocationRole) =>
    restore.files.find((file) => file.role === role)
  // A staging file is put in place only if it still holds the bytes R2
  // staged and verified; anything else was changed by hand.
  const isStaged = async (file: RestoreFileRecord) => {
    if (!(await exists(file.staging))) return false
    const changed = await expectDigest(file.staging, file.sha256)().catch(
      () => 'it is not a regular file',
    )
    if (changed)
      problems.push(`${file.staging} changed after it was staged (${changed})`)
    return true
  }
  const data: { role: RelocationRole; action: SlotAction }[] = []
  for (const role of DATA_ROLES) {
    const file = listed(role)
    if (!file) continue
    const staged = await isStaged(file)
    const there = await exists(file.from)
    if (staged)
      data.push({
        role,
        action: { kind: 'rename', file, over: there ? 'present' : 'absent' },
      })
    else if (there) data.push({ role, action: { kind: 'none' } })
    else problems.push(`${file.from} is missing: it was restored, then deleted`)
  }
  const barriers: { role: RelocationRole; action: SlotAction }[] = []
  // Whether every barrier is still up: only then may a data file that came
  // back while the restore was stopped be replaced by the staged copy.
  let barriersUp = true
  const journal = listed('journal')
  if (journal) {
    const staged = await isStaged(journal)
    const there = await exists(journal.from)
    if (staged && !there)
      barriers.push({
        role: 'journal',
        action: { kind: 'rename', file: journal, over: 'absent' },
      })
    else if (!staged && there) {
      barriersUp = false
      barriers.push({ role: 'journal', action: { kind: 'none' } })
    } else if (staged && there)
      problems.push(
        `both ${journal.from} and ${journal.staging} exist; keep the one you trust and delete the other`,
      )
    else
      problems.push(`${journal.from} is missing: it was restored, then deleted`)
  }
  for (const role of RUNTIME_ROLES) {
    const slot = dataset.slots.find((candidate) => candidate.role === role)
    if (!slot) continue
    const legacy = slot.from
    const tombstone = await tombstoneAttempt(legacy)
    const there = await exists(legacy)
    const mode =
      role === 'localRuntime' ? restore.runtimes.local : restore.runtimes.vault
    if (mode === 'copy') {
      const file = listed(role)
      if (!file) continue
      const staged = await isStaged(file)
      if (staged && tombstone === record.attempt)
        barriers.push({
          role,
          action: { kind: 'rename', file, over: 'tombstone' },
        })
      else if (!staged && there && tombstone === undefined) {
        barriersUp = false
        barriers.push({ role, action: { kind: 'none' } })
      } else if (!staged)
        problems.push(
          `${file.staging} is missing, so ${legacy} can't be restored`,
        )
      else
        problems.push(
          `${legacy} is no longer this move's tombstone while ${file.staging} still waits to replace it`,
        )
    } else if (tombstone === record.attempt)
      barriers.push({
        role,
        action: { kind: 'unlink-tombstone', path: legacy },
      })
    else if (tombstone !== undefined)
      problems.push(`${legacy} holds another move's tombstone`)
    else {
      barriersUp = false
      barriers.push({ role, action: { kind: 'none' } })
    }
  }
  if (!barriersUp)
    for (const { action } of data)
      if (action.kind === 'rename' && action.over === 'present')
        problems.push(
          `${action.file.from} came back while the restore was stopped, after the old folder was already in use again; keep the copy you trust (${action.file.from} or ${action.file.staging}) and delete the other`,
        )
  return { data, barriers, problems }
}

/** Carry out one R3 action. */
async function act(
  action: SlotAction,
  record: StateLayoutRecord,
  ctx: StateLayoutTransitionContext,
): Promise<void> {
  if (action.kind === 'none') return
  if (action.kind === 'unlink-tombstone') {
    await owned(
      ctx,
      { kind: 'unlink', path: action.path },
      expectTombstone(action.path, record.attempt),
    )
    return
  }
  const { file, over } = action
  const target =
    over === 'absent'
      ? expectAbsent(file.from)
      : over === 'present'
        ? expectPresent(file.from)
        : expectTombstone(file.from, record.attempt)
  await owned(
    ctx,
    { kind: 'rename', from: file.staging, to: file.from },
    both(expectDigest(file.staging, file.sha256), target),
  )
}

/**
 * R3 to R5 of a restore whose staging is durable (phase `restore-staged`):
 * classify every slot afresh, refuse before writing anything if one is in a
 * state no supported writer produces, then put the data files in place, flush,
 * remove the barriers, flush, publish `restored` and retire the state-folder
 * copies. Running it again after a crash at any point converges.
 */
export async function finishStagedRestore(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<StateLayoutRecord> {
  const restore = requireRestoreDetail(record)
  const plan = await classifyStagedRestore(record, dataset)
  if (plan.problems.length)
    throw refused(
      `anthropic-auth can't finish restoring its state to ${dataset.oldDir}: ${plan.problems.join('; ')}. Then run ${RESTORE_LEGACY_COMMAND} again.`,
      [dataset.oldDir],
    )
  for (const { role, action } of plan.data) {
    await act(action, record, ctx)
    await stateLayoutStep(ctx, `restore:placed:${role}`)
  }
  // Every data file is durable at its legacy name before any barrier goes,
  // so after any crash a barrier is down only once all data is in place.
  await ctx.fs.syncDirectory(dataset.oldDir)
  await stateLayoutStep(ctx, 'restore:data-flushed')
  for (const { role, action } of plan.barriers) {
    await act(action, record, ctx)
    await stateLayoutStep(ctx, `restore:placed:${role}`)
  }
  await ctx.fs.syncDirectory(dataset.oldDir)
  await stateLayoutStep(ctx, 'restore:barriers-flushed')
  const restored: StateLayoutRecord = {
    ...record,
    phase: 'restored',
    restore: { ...restore, cleanup: 'pending' },
  }
  await publishStateLayoutRecord(
    restored,
    {
      assertLeases: () => ctx.stack.assertAll(),
      expect: expectRestorePhase(
        dataset.sub,
        'restore-staged',
        restore.attempt,
      ),
    },
    ctx.fs,
  )
  await stateLayoutStep(ctx, 'restore:restored-written')
  forgetRelocationObservations()
  return finishRestoreRetirement(restored, dataset, ctx)
}

/**
 * R0 for a restore of a `committed` move: everything that must hold before
 * anything is written. Returns the problems, each naming what to fix.
 */
async function newRestoreProblems(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
  options: RestoreLegacyOptions,
): Promise<string[]> {
  const problems: string[] = []
  if (record.cleanup === 'pending')
    problems.push(
      'the move has not finished removing the old copies; start OpenCode with anthropic-auth once and close it again',
    )
  if (record.cleanup === 'conflict')
    for (const pair of record.conflict ?? [])
      problems.push(
        `two copies of the account state exist (${pair.old} and ${pair.new}); keep the one you trust and move the other out of both folders`,
      )
  if (record.cleanup === 'kept')
    for (const path of record.kept ?? [])
      if (await exists(path))
        problems.push(
          `${path} changed after the move and was kept; move it aside or delete it`,
        )
  problems.push(
    ...(await holderProblems(
      join(dataset.sub, HOLDER_FILE_NAME),
      options.liveness,
      true,
    )),
    ...(await holderProblems(
      join(dataset.oldDir, HOLDER_FILE_NAME),
      options.liveness,
      false,
    )),
  )
  const artifacts =
    options.artifacts ??
    defaultPreNArtifactLocations(
      options.env ?? process.env,
      options.home ?? homedir(),
    )
  for (const blocker of await preNArtifactBlockers(
    artifacts,
    options.liveness?.pidAlive,
    options.liveness,
  ))
    problems.push(`${describeFenceBlocker(blocker)} is still running`)
  for (const slot of dataset.slots) {
    if (slot.role === 'localRuntime' || slot.role === 'vaultRuntime') {
      if ((await tombstoneAttempt(slot.from)) !== record.attempt)
        problems.push(
          `${slot.from} is no longer the marker the move left there; move it aside`,
        )
      continue
    }
    if (await exists(slot.from))
      problems.push(
        `${slot.from} came back after the move; move it aside or delete it`,
      )
  }
  const moving = movingJournalPath(dataset.oldPaths.journal, record.attempt)
  if (await exists(moving))
    problems.push(`${moving} is still there; move it aside or delete it`)
  return problems
}

/** R0 to R5 of a new restore, from a `committed` record. */
async function startRestore(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
  options: RestoreLegacyOptions,
): Promise<StateLayoutRecord> {
  const problems = await newRestoreProblems(record, dataset, options)
  if (problems.length)
    throw refused(
      `anthropic-auth can't restore its state to ${dataset.oldDir} yet: ${problems.join('; ')}. Then run ${RESTORE_LEGACY_COMMAND} again.`,
      [dataset.oldDir, dataset.sub],
    )
  // R1: the restore set, durable before any staging file exists.
  const attempt = randomUUID()
  const files: RestoreFileRecord[] = []
  for (const slot of dataset.slots) {
    let digest: Awaited<ReturnType<typeof digestFile>>
    try {
      digest = await digestFile(slot.to)
    } catch (error) {
      throw refused(
        `${slot.to} is not a regular file, so anthropic-auth won't restore it; move it aside, then run ${RESTORE_LEGACY_COMMAND} again.`,
        [slot.to],
        error,
      )
    }
    if (digest.status !== 'file') continue
    files.push({
      role: slot.role,
      from: slot.from,
      to: slot.to,
      sha256: digest.sha256,
      staging: restoreStagingPath(slot.from, attempt),
    })
  }
  const listed = (role: RelocationRole) =>
    files.some((file) => file.role === role)
  const restoring: StateLayoutRecord = {
    ...record,
    phase: 'restoring',
    restore: {
      attempt,
      startedAt: ctx.now(),
      files,
      runtimes: {
        local: listed('localRuntime') ? 'copy' : 'unlink',
        vault: listed('vaultRuntime') ? 'copy' : 'unlink',
      },
    },
  }
  await publishStateLayoutRecord(
    restoring,
    {
      assertLeases: () => ctx.stack.assertAll(),
      expect: async () => {
        const current = await readStateLayoutRecord(dataset.sub).catch(
          () => undefined,
        )
        return current?.phase === 'committed' &&
          current.attempt === record.attempt
          ? undefined
          : 'layout.json is no longer the committed move'
      },
    },
    ctx.fs,
  )
  await stateLayoutStep(ctx, 'restore:restoring-written')
  // R2: stage every file under a name only this attempt uses.
  for (const file of files) {
    const bytes = await readFile(file.to)
    if (sha256Hex(bytes) !== file.sha256)
      throw refused(
        `${file.to} changed while it was being restored; run ${RESTORE_LEGACY_COMMAND} again.`,
        [file.to],
      )
    await ctx.stack.assertAll()
    await createOwnerOnlyFile(ctx.fs, file.staging, bytes)
    const back = await readFile(file.staging)
    if (!back.equals(bytes))
      throw refused(
        `the restored copy of ${file.to} reads back differently; run ${RESTORE_LEGACY_COMMAND} again.`,
        [file.staging],
      )
    await stateLayoutStep(ctx, `restore:staged:${file.role}`)
  }
  await ctx.fs.syncDirectory(dataset.oldDir)
  await stateLayoutStep(ctx, 'restore:staging-flushed')
  // The boundary: from here recovery only goes forward.
  const staged: StateLayoutRecord = { ...restoring, phase: 'restore-staged' }
  await publishStateLayoutRecord(
    staged,
    {
      assertLeases: () => ctx.stack.assertAll(),
      expect: expectRestorePhase(dataset.sub, 'restoring', attempt),
    },
    ctx.fs,
  )
  await stateLayoutStep(ctx, 'restore:staged-written')
  return finishStagedRestore(staged, dataset, ctx)
}

/** Refuse a record written for another folder or one listing other files. */
function requireRecordMatches(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
): void {
  const path = layoutRecordPath(dataset.sub)
  if (
    record.identity !== dataset.identity ||
    record.oldDir !== dataset.oldDir ||
    record.sub !== dataset.sub ||
    record.storageIds.local !== dataset.storageIds.local ||
    record.storageIds.vault !== dataset.storageIds.vault
  )
    throw new StateLayoutRefusalError(
      'other-dataset',
      `${path} belongs to another config folder (${record.oldDir}), not ${dataset.oldDir}. Check OPENCODE_CONFIG_DIR and any symlink to the config folder.`,
      [path, record.oldDir, dataset.oldDir],
    )
  const problem = recordFilesProblem(record, dataset)
  if (problem)
    throw new StateLayoutRefusalError(
      'marker-unreadable',
      `anthropic-auth can't use ${path}: ${problem}.`,
      [path],
    )
}

async function readRecord(sub: string): Promise<StateLayoutRecord | undefined> {
  try {
    return await readStateLayoutRecord(sub)
  } catch (error) {
    const path = layoutRecordPath(sub)
    throw new StateLayoutRefusalError(
      'marker-unreadable',
      `anthropic-auth can't read ${path}, which records where its state is, so it won't restore anything. Restore the file from a backup or ask for help; do not delete the state folder.`,
      [path],
      error,
    )
  }
}

function finished(record: StateLayoutRecord | undefined): string | undefined {
  if (record === undefined)
    return 'anthropic-auth has not moved this state out of the config folder'
  if (record.phase === 'rolled-back')
    return 'the move of this state was undone before it finished'
  if (record.phase === 'restored' && record.restore?.cleanup === 'done')
    return 'this state was already restored to the config folder'
  return undefined
}

/**
 * Restore OpenCode's dataset from the state folder to the legacy layout in
 * its config folder, or finish a restore that stopped. Run it only with every
 * host stopped, behind setup's process fence; it also refuses while any
 * process is registered beside either copy. Refuses with
 * `StateLayoutRefusalError` (code `restore-refused` with a message naming
 * what to fix, or a marker problem); resolves `not-moved` when there is
 * nothing to restore.
 */
export async function restoreLegacyLayout(
  options: RestoreLegacyOptions = {},
): Promise<RestoreLegacyOutcome> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const overrides = statePathOverrides(env)
  if (overrides.length)
    throw refused(
      `${RESTORE_LEGACY_COMMAND} works only on OpenCode's own config folder. Unset ${overrides.join(', ')} and run it again.`,
    )
  const target = resolveStateHomeTarget({ env, home })
  if (!target)
    return { status: 'not-moved', reason: 'the config folder does not exist' }
  const sub = await canonicalPath(target.dir)
  let marker: Awaited<ReturnType<typeof readConfigDirMarker>>
  try {
    marker = await readConfigDirMarker(sub)
  } catch (error) {
    if (!(error instanceof StateLayoutFileError)) throw error
    throw new StateLayoutRefusalError(
      'marker-unreadable',
      `anthropic-auth can't read ${error.path}, which names the config folder ${sub} belongs to.`,
      [error.path],
      error,
    )
  }
  if (marker && marker.identity !== target.identity)
    throw new StateLayoutRefusalError(
      'other-dataset',
      `${sub} holds anthropic-auth state for ${marker.identity}, not for ${target.identity}. Check OPENCODE_CONFIG_DIR and any symlink to the config folder.`,
      [sub, marker.identity, target.identity],
    )
  const unlocked = finished(await readRecord(sub))
  if (unlocked) return { status: 'not-moved', reason: unlocked }
  const dataset = await resolveRelocationDataset({
    configDir: getOpenCodeConfigDir(env, home),
    identity: target.identity,
    stateRoot: target.stateRoot,
    sub,
  })
  const ctx: StateLayoutTransitionContext = {
    fs: options.fs ?? defaultStateLayoutFs(),
    stack: new StateLayoutLockStack(options.onLockEvent),
    release: anthropicAuthRelease(),
    now: options.now ?? Date.now,
    onStep: options.onStep,
    dataLockTimeoutMs: options.timeouts?.dataMs,
    holderLockTimeoutMs: options.timeouts?.holderMs,
  }
  try {
    try {
      await ctx.stack.acquire({
        name: LAYOUT_LOCK_NAME,
        path: layoutRecordPath(sub),
        timeoutMs: options.timeouts?.layoutMs ?? LAYOUT_LOCK_TIMEOUT_MS,
      })
      await acquireHolderLocks(dataset, ctx)
      await acquireDataLocks(dataset, ctx, { drainRefreshes: false })
    } catch (error) {
      if (error instanceof LockContentionError)
        throw new StateLayoutRefusalError(
          'busy',
          `Another anthropic-auth process is using the state of ${dataset.oldDir}; close every OpenCode and Pi, then run ${RESTORE_LEGACY_COMMAND} again.`,
          [dataset.oldDir],
          error,
        )
      if (
        error instanceof StateLayoutCrash ||
        error instanceof StateLayoutRefusalError ||
        error instanceof HolderRegistrationError
      )
        throw error
      // Any other failure to take a lock (a lock file that can't be
      // created) is reported with fixed public text, not its raw path.
      const failure = stateLayoutIoFailure(
        `take the locks of ${dataset.oldDir} and ${sub}`,
        [dataset.oldDir, sub],
        error,
      )
      logger.error('state-layout', failure.message, {
        code: failure.code,
        paths: failure.paths,
      })
      throw failure
    }
    await stateLayoutStep(ctx, 'restore:locks-held')
    for (let round = 0; round < 3; round++) {
      const record = await readRecord(sub)
      const done = finished(record)
      if (done || !record) return { status: 'not-moved', reason: done ?? '' }
      requireRecordMatches(record, dataset)
      let result: StateLayoutRecord
      switch (record.phase) {
        case 'preparing':
          throw refused(
            `A move of anthropic-auth's state for ${dataset.oldDir} did not finish. Start OpenCode with anthropic-auth once to undo it; there is then nothing to restore.`,
            [layoutRecordPath(sub)],
          )
        case 'restoring':
          await discardAbandonedRestore(record, dataset, ctx)
          continue
        case 'committed':
          result = await startRestore(record, dataset, ctx, options)
          break
        case 'restore-staged': {
          // R3 renames legacy names only once the boundary is durable.
          await syncObservedRestoreRecord(dataset, ctx)
          const problems = await holderProblems(
            join(dataset.sub, HOLDER_FILE_NAME),
            options.liveness,
            true,
          )
          if (problems.length)
            throw refused(
              `anthropic-auth can't finish restoring its state to ${dataset.oldDir}: ${problems.join('; ')}. Close them, then run ${RESTORE_LEGACY_COMMAND} again.`,
              [dataset.sub],
            )
          result = await finishStagedRestore(record, dataset, ctx)
          break
        }
        default:
          // R5 retires state-folder copies only once `restored` is durable.
          await syncObservedRestoreRecord(dataset, ctx)
          result = await finishRestoreRetirement(record, dataset, ctx)
      }
      return {
        status: 'restored',
        oldDir: dataset.oldDir,
        sub: dataset.sub,
        kept: result.restore?.kept ?? [],
      }
    }
    throw new StateLayoutRefusalError(
      'busy',
      `The record of where anthropic-auth's state is keeps changing; close every OpenCode and Pi, then run ${RESTORE_LEGACY_COMMAND} again.`,
      [layoutRecordPath(sub)],
    )
  } finally {
    await ctx.stack.releaseAll().catch(() => {})
  }
}
