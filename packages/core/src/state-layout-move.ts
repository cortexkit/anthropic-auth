import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { drainVaultQuota } from '@cortexkit/common-auth/claustrum'
import { LockContentionError, writeJsonAtomic } from '@cortexkit/common-auth/fs'
import { openPoolStore } from '@cortexkit/common-auth/store'

import {
  HOLDER_FILE_NAME,
  HOLDER_LOCK_NAME,
  HOLDER_LOCK_TIMEOUT_MS,
  HolderRegistrationError,
} from './holder-registry.ts'
import { logger } from './logger.ts'
import { nativeQuotaCodec } from './native-quota-codec.ts'
import { nativeAccountProviderLock } from './native-refresh-coordinator.ts'
import {
  type NativeVaultPaths,
  nativeVaultPaths,
} from './native-vault-paths.ts'
import {
  nativeMigrationAuthorityPhase,
  readNativeMigrationJournal,
} from './pool-authority.ts'
import {
  canonicalPath,
  type NativePoolPaths,
  resolveNativePoolPaths,
} from './pool-paths.ts'
import { drainNativePoolStores } from './pool-store.ts'
import { forgetRelocationObservations } from './relocation-guard.ts'
import {
  StateLayoutRefusalError,
  stateLayoutConflict,
} from './state-layout-errors.ts'
import {
  createOwnerOnlyFile,
  digestFile,
  type FileDigest,
  fileSha256,
  publishOwned,
  type StateLayoutFs,
  type StateLayoutLockSpec,
  type StateLayoutLockStack,
  sha256Hex,
  syncFile,
} from './state-layout-io.ts'
import {
  readRelocationPointer,
  STATE_HOME_FILE_NAMES,
} from './state-layout-paths.ts'
import {
  CREDENTIAL_AUTHORITY_ROLES,
  isLayoutRecordStage,
  layoutRecordPath,
  movingJournalPath,
  publishStateLayoutRecord,
  RELOCATION_ROLES,
  type RelocationFileRecord,
  type RelocationRole,
  readStateLayoutRecord,
  type StateLayoutRecord,
} from './state-layout-record.ts'
import { windowsLongPath } from './windows-long-path.ts'

const ACCOUNT_FILE = 'anthropic-auth.json'
const ACCOUNT_STATE_FILE = 'anthropic-auth-state.json'

export { movingJournalPath } from './state-layout-record.ts'

/** Lock name of the layout lock on `<sub>/layout.json`. */
export const LAYOUT_LOCK_NAME = 'runtime-layout'
/** How long a process waits for the layout lock: a whole move at 15 s per contended lock. */
export const LAYOUT_LOCK_TIMEOUT_MS = 120_000

/** One file slot of a dataset in both layouts. */
export interface RelocationSlot {
  readonly role: RelocationRole
  /** The canonical legacy-layout path, in the config folder. */
  readonly from: string
  /**
   * The legacy-layout path as configured: the config folder as given joined
   * with the role's fixed file name. `from` follows a symlink at the leaf, so
   * only this path shows whether the configured file is a link.
   */
  readonly configured: string
  /** The state-home path, in `<sub>`. */
  readonly to: string
}

/**
 * OpenCode's default dataset of one config folder, resolved in both layouts.
 * Only that dataset ever moves.
 */
export interface RelocationDataset {
  /** The config folder as configured (not canonicalized). */
  readonly configDir: string
  readonly identity: string
  readonly stateRoot: string
  /** The canonical state-home folder. */
  readonly sub: string
  /** The canonical config folder holding the legacy files. */
  readonly oldDir: string
  readonly oldPaths: NativePoolPaths
  readonly oldVault: NativeVaultPaths
  readonly newPaths: NativePoolPaths
  readonly newVault: NativeVaultPaths
  readonly slots: readonly RelocationSlot[]
  readonly storageIds: { readonly local: string; readonly vault: string }
}

/** The legacy-layout files of OpenCode's default dataset of one config folder. */
export interface LegacyDatasetFiles {
  /** The canonical config folder holding the legacy files. */
  readonly oldDir: string
  readonly oldPaths: NativePoolPaths
  readonly oldVault: NativeVaultPaths
}

/**
 * Resolve only the config folder's side of the dataset. Nothing under the
 * state folder is resolved or read, so a start that stays legacy does not
 * depend on the state folder being readable.
 */
export async function resolveLegacyDatasetFiles(
  configDir: string,
): Promise<LegacyDatasetFiles> {
  const oldPaths = await resolveNativePoolPaths(
    join(configDir, ACCOUNT_FILE),
    join(configDir, ACCOUNT_STATE_FILE),
    { kind: 'legacy' },
  )
  return {
    // The folder itself, not the folder of a resolved file: a file that is a
    // link elsewhere must not move the folder the move works in.
    oldDir: await canonicalPath(configDir),
    oldPaths,
    oldVault: nativeVaultPaths(oldPaths, { kind: 'legacy' }),
  }
}

export async function resolveRelocationDataset(input: {
  configDir: string
  identity: string
  stateRoot: string
  /** The canonical state-home folder. */
  sub: string
}): Promise<RelocationDataset> {
  const legacyConfig = join(input.configDir, ACCOUNT_FILE)
  const legacyState = join(input.configDir, ACCOUNT_STATE_FILE)
  const { oldDir, oldPaths, oldVault } = await resolveLegacyDatasetFiles(
    input.configDir,
  )
  const stateHome = { kind: 'state-home', dir: input.sub } as const
  const newPaths = await resolveNativePoolPaths(
    legacyConfig,
    legacyState,
    stateHome,
  )
  const newVault = nativeVaultPaths(newPaths, stateHome)
  const pairs: Record<RelocationRole, [string, string]> = {
    localPoolState: [oldPaths.state, newPaths.state],
    journal: [oldPaths.journal, newPaths.journal],
    localRoster: [oldPaths.roster, newPaths.roster],
    vaultStoreState: [oldVault.state, newVault.state],
    vaultRoster: [oldVault.roster, newVault.roster],
    vaultRouting: [oldVault.routing, newVault.routing],
    localRuntime: [oldPaths.runtime, newPaths.runtime],
    vaultRuntime: [oldVault.runtime, newVault.runtime],
  }
  return {
    configDir: input.configDir,
    identity: input.identity,
    stateRoot: input.stateRoot,
    sub: input.sub,
    oldDir,
    oldPaths,
    oldVault,
    newPaths,
    newVault,
    slots: RELOCATION_ROLES.map((role) => ({
      role,
      from: pairs[role][0],
      to: pairs[role][1],
      configured: join(input.configDir, STATE_HOME_FILE_NAMES[role]),
    })),
    storageIds: { local: oldPaths.storageId, vault: oldVault.storageId },
  }
}

/** The named points of a transition; the step hook runs at each. */
export type StateLayoutStep =
  | 'old-holders-locking'
  | 'locks-held'
  | 'fence-checked'
  | 'config-dir-written'
  | 'preparing-written'
  | `copied:${RelocationRole}`
  | 'copies-flushed'
  | 'artifacts-checked'
  | 'journal-set-aside'
  | 'local-runtime-tombstoned'
  | 'vault-runtime-tombstoned'
  | 'old-dir-flushed'
  | 'verified'
  | 'committed'
  | `cleanup:${RelocationRole}`
  | 'cleanup-recorded'
  | 'rollback:journal'
  | 'rollback:localRuntime'
  | 'rollback:vaultRuntime'
  | 'rollback:old-dir-flushed'
  | 'rollback:destination-removed'
  | 'rollback:sub-flushed'
  | 'rolled-back'
  | 'restore:locks-held'
  | 'restore:discarded'
  | 'restore:restoring-written'
  | `restore:staged:${RelocationRole}`
  | 'restore:staging-flushed'
  | 'restore:staged-written'
  | `restore:placed:${RelocationRole}`
  | 'restore:data-flushed'
  | 'restore:barriers-flushed'
  | 'restore:restored-written'
  | `restore:retired:${RelocationRole}`
  | 'restore:sub-flushed'
  | 'restore:done'

/**
 * Thrown by a step hook to stop a transition exactly there, with no rollback
 * and nothing else written, as a crash of the process would. Tests use it to
 * leave every intermediate state on disk; the transition releases its locks
 * so the next start needn't wait for their leases to expire.
 */
export class StateLayoutCrash extends Error {
  constructor(readonly step: StateLayoutStep) {
    super(`state layout transition stopped at ${step}`)
    this.name = 'StateLayoutCrash'
  }
}

/** Everything a transition needs besides the dataset. */
export interface StateLayoutTransitionContext {
  readonly fs: StateLayoutFs
  readonly stack: StateLayoutLockStack
  readonly release: string
  readonly now: () => number
  readonly onStep?: (step: StateLayoutStep) => void | Promise<void>
  /** The longest wait for one data lock; the pool store's default otherwise. */
  readonly dataLockTimeoutMs?: number
  /** The longest wait for a holder lock. */
  readonly holderLockTimeoutMs?: number
}

export async function stateLayoutStep(
  ctx: StateLayoutTransitionContext,
  step: StateLayoutStep,
): Promise<void> {
  await ctx.onStep?.(step)
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** The two holder files a transition locks, in the order it locks them. */
export function transitionHolderFiles(dataset: RelocationDataset): string[] {
  return [
    join(dataset.oldDir, HOLDER_FILE_NAME),
    join(dataset.sub, HOLDER_FILE_NAME),
  ].sort()
}

/**
 * Take the `holders` lock on `holderFile`. Waiting too long throws
 * `LockContentionError`, which callers report as busy. Any other failure to
 * take it (the lock file can't be created: EACCES, EROFS, ENOSPC) throws
 * `HolderRegistrationError('unavailable')`, whose fixed message names no
 * file, so a host never shows the lock file's path. `timeoutMs` undefined
 * waits the lock stack's default.
 */
export async function acquireHolderLock(
  ctx: Pick<StateLayoutTransitionContext, 'stack'>,
  holderFile: string,
  timeoutMs: number | undefined,
): Promise<void> {
  try {
    await ctx.stack.acquire({
      name: HOLDER_LOCK_NAME,
      path: holderFile,
      timeoutMs,
    })
  } catch (error) {
    if (error instanceof LockContentionError) throw error
    throw new HolderRegistrationError('unavailable', dirname(holderFile), error)
  }
}

/** Take the `holders` lock on both holder files, in sorted path order. */
export async function acquireHolderLocks(
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<void> {
  const oldHolders = join(dataset.oldDir, HOLDER_FILE_NAME)
  for (const file of transitionHolderFiles(dataset)) {
    if (file === oldHolders) await stateLayoutStep(ctx, 'old-holders-locking')
    await acquireHolderLock(
      ctx,
      file,
      ctx.holderLockTimeoutMs ?? HOLDER_LOCK_TIMEOUT_MS,
    )
  }
}

/** A pool's rows changed between the unlocked snapshot and its locks. */
export class PoolSnapshotChanged extends Error {
  constructor(readonly statePath: string) {
    super(`the pool at ${statePath} changed while its locks were taken`)
    this.name = 'PoolSnapshotChanged'
  }
}

/** A pool can't be read, so its row locks can't be named. */
export class PoolUnreadable extends Error {
  constructor(
    readonly statePath: string,
    readonly reason: string,
  ) {
    super(`the pool at ${statePath} can't be read (${reason})`)
    this.name = 'PoolUnreadable'
  }
}

interface PoolFiles {
  readonly config: string
  readonly state: string
  readonly storageId: string
}

async function poolRows(
  pool: PoolFiles,
): Promise<{ id: string; identity?: string }[]> {
  // A read-only handle: `read()` fires nothing and takes no lock.
  const store = openPoolStore({
    provider: 'anthropic',
    configPath: pool.config,
    statePath: pool.state,
    quota: nativeQuotaCodec,
    requireCredentialStamps: true,
  })
  const read = await store.read()
  if (read.status === 'pending-migration') return []
  if (read.status === 'error') throw new PoolUnreadable(pool.state, read.reason)
  return read.rows.map((row) => ({
    id: row.id,
    ...(row.identity ? { identity: row.identity } : {}),
  }))
}

function rowLockName(key: string) {
  return `row-${encodeURIComponent(key)}`
}

/**
 * The refresh locks of one pool: every row lock (by id and by identity, since
 * a refresh that started before the row learned its identity holds the id
 * lock) and every per-identity provider lock, each list in the order it is
 * taken. With the default provider lock between them, these are the locks
 * common-auth's refresh holds from before the token exchange until the
 * successor is written, so once they are held no refresh of this pool is
 * between its exchange and its write.
 */
export interface PoolRefreshLocks {
  readonly rows: readonly string[]
  readonly providers: readonly string[]
  readonly identities: readonly string[]
}

function poolRefreshLocks(
  pool: PoolFiles,
  snapshot: readonly { id: string; identity?: string }[],
): PoolRefreshLocks {
  // Sorted by the raw key, then encoded, exactly as common-auth's roster
  // publication orders the row locks it takes: encoding can reorder legal
  // ids (`a-b` sorts before `a:b`, but `a%3Ab` before `a-b`).
  const rowKeys = [
    ...new Set(
      snapshot.flatMap((row) =>
        row.identity ? [row.id, row.identity] : [row.id],
      ),
    ),
  ].sort()
  const identities = [
    ...new Set(snapshot.flatMap((row) => (row.identity ? [row.identity] : []))),
  ].sort()
  const providers = identities
    .map(
      (identity) =>
        nativeAccountProviderLock(
          { state: pool.state, storageId: pool.storageId } as NativePoolPaths,
          identity,
        ).name,
    )
    .sort()
  return { rows: rowKeys.map(rowLockName), providers, identities }
}

function poolLockOrder(
  pool: PoolFiles,
  refresh: PoolRefreshLocks | undefined,
  timeoutMs: number | undefined,
): StateLayoutLockSpec[] {
  const specs: StateLayoutLockSpec[] = []
  if (refresh) {
    for (const name of refresh.rows)
      specs.push({ name, path: pool.state, timeoutMs })
    specs.push({ name: 'provider-anthropic', path: pool.state, timeoutMs })
    for (const name of refresh.providers)
      specs.push({ name, path: pool.state, timeoutMs })
  }
  specs.push({ name: 'pool-config', path: pool.config, timeoutMs })
  specs.push({ name: 'pool-state', path: pool.state, timeoutMs })
  return specs
}

function localPool(dataset: RelocationDataset): PoolFiles {
  return {
    config: dataset.oldPaths.config,
    state: dataset.oldPaths.state,
    storageId: dataset.oldPaths.storageId,
  }
}

function vaultPool(dataset: RelocationDataset): PoolFiles {
  return {
    config: dataset.oldVault.config,
    state: dataset.oldVault.state,
    storageId: dataset.oldVault.storageId,
  }
}

/**
 * The one order in which every layout transition takes the data locks of a
 * dataset's old files, each lock once: `native-migration`, the local pool's
 * locks, the custody roster and local runtime, the vault pool's locks, the
 * vault roster, the vault runtime and the vault routing file.
 *
 * A move passes `refresh`, which adds each pool's row and provider locks
 * before its store locks, so that no refresh is in flight while it copies.
 * A restore passes none: the old pool states are absent after a move's
 * cleanup and the old-layout barriers stop every refresh before its provider
 * call, while no process may use the moved copy without a live registration,
 * which restore refuses. The restore order is therefore a subsequence of the
 * move order, and the two can't wait on each other in opposite orders.
 */
export function stateLayoutDataLockOrder(
  dataset: RelocationDataset,
  options: {
    timeoutMs?: number
    refresh?: {
      readonly local: PoolRefreshLocks
      readonly vault: PoolRefreshLocks
    }
  } = {},
): StateLayoutLockSpec[] {
  const { timeoutMs, refresh } = options
  const order: StateLayoutLockSpec[] = [
    {
      name: 'native-migration',
      path: dataset.oldPaths.journal,
      ttlMs: 30_000,
      timeoutMs,
    },
    ...poolLockOrder(localPool(dataset), refresh?.local, timeoutMs),
    {
      name: 'claustrum-roster-write',
      path: dataset.oldPaths.roster,
      timeoutMs,
    },
    { name: 'native-runtime', path: dataset.oldPaths.runtime, timeoutMs },
    ...poolLockOrder(vaultPool(dataset), refresh?.vault, timeoutMs),
    {
      name: 'claustrum-roster',
      path: dataset.oldVault.roster,
      ttlMs: 30_000,
      timeoutMs,
    },
    {
      name: 'claustrum-roster-write',
      path: dataset.oldVault.roster,
      timeoutMs,
    },
    { name: 'native-runtime', path: dataset.oldVault.runtime, timeoutMs },
    {
      name: 'write',
      path: dataset.oldVault.routing,
      ttlMs: 30_000,
      timeoutMs,
    },
  ]
  const seen = new Set<string>()
  return order.filter((spec) => {
    const key = `${spec.name}\0${spec.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Throw `PoolSnapshotChanged` when a row's locks were not all taken. */
async function requireRowsLocked(
  pool: PoolFiles,
  locks: PoolRefreshLocks,
): Promise<void> {
  const locked = new Set(locks.rows)
  const lockedIdentities = new Set(locks.identities)
  for (const row of await poolRows(pool)) {
    if (
      !locked.has(rowLockName(row.id)) ||
      (row.identity !== undefined &&
        (!locked.has(rowLockName(row.identity)) ||
          !lockedIdentities.has(row.identity)))
    )
      throw new PoolSnapshotChanged(pool.state)
  }
}

/**
 * Take every data lock of the dataset's old files in
 * `stateLayoutDataLockOrder`. A move (`drainRefreshes`, the default) first
 * reads each pool's rows without a lock to name their row and provider locks,
 * then reads them again under the store locks: if a row changed while the
 * locks were taken, everything is released and taken once more, and a second
 * change throws `PoolSnapshotChanged`. A restore takes no row or provider
 * lock.
 */
export async function acquireDataLocks(
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
  options: { drainRefreshes?: boolean } = {},
): Promise<void> {
  const mark = ctx.stack.size
  const timeoutMs = ctx.dataLockTimeoutMs
  const drain = options.drainRefreshes ?? true
  for (let attempt = 0; ; attempt++) {
    try {
      const refresh = drain
        ? {
            local: poolRefreshLocks(
              localPool(dataset),
              await poolRows(localPool(dataset)),
            ),
            vault: poolRefreshLocks(
              vaultPool(dataset),
              await poolRows(vaultPool(dataset)),
            ),
          }
        : undefined
      for (const spec of stateLayoutDataLockOrder(dataset, {
        timeoutMs,
        refresh,
      }))
        await ctx.stack.acquire(spec)
      if (refresh) {
        await requireRowsLocked(localPool(dataset), refresh.local)
        await requireRowsLocked(vaultPool(dataset), refresh.vault)
      }
      return
    } catch (error) {
      await ctx.stack.releaseTo(mark)
      if (error instanceof PoolSnapshotChanged && attempt === 0) continue
      throw error
    }
  }
}

/**
 * Commit the coalesced writes this process has queued for the dataset before
 * any lock is taken: close every pool store open on the old pool states (a
 * bounded drain of their quota readings) and drain the vault roster's quota
 * writer. Both commit under locks the mover is about to hold, so they must
 * finish first. Afterwards forget every cached file observation, so nothing
 * this process cached about the old files answers for them after the move.
 */
export async function drainCoalescedWrites(
  dataset: RelocationDataset,
): Promise<void> {
  await drainNativePoolStores([dataset.oldPaths.state, dataset.oldVault.state])
  await drainVaultQuota(dataset.oldVault.roster)
  forgetRelocationObservations()
}

/** A relocation tombstone as written over an old runtime file. */
export function relocationTombstone(
  record: Pick<
    StateLayoutRecord,
    'sub' | 'stateRoot' | 'identity' | 'attempt' | 'by'
  >,
): string {
  return `${JSON.stringify({
    version: 0,
    relocatedTo: record.sub,
    stateRoot: record.stateRoot,
    identity: record.identity,
    attempt: record.attempt,
    by: record.by,
  })}\n`
}

export async function tombstoneAttempt(
  path: string,
): Promise<string | undefined> {
  try {
    return (await readRelocationPointer(path))?.attempt
  } catch {
    return undefined
  }
}

function relocatingPath(path: string, attempt: string): string {
  return `${path}.relocating-${attempt}`
}

function restoringPath(path: string, attempt: string): string {
  return `${path}.restoring-${attempt}`
}

export async function exists(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    await lstat(windowsLongPath(path, platform))
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

export async function removeOwnStaging(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    const info = await lstat(windowsLongPath(path, platform))
    if (info.isFile()) await unlink(windowsLongPath(path, platform))
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

/**
 * Why `record` doesn't list exactly the files of `dataset`, each role with the
 * paths this start resolved, or undefined when it does. Recovery deletes and
 * renames only files a record names, so a record naming any other file is
 * never acted on.
 */
export function recordFilesProblem(
  record: Pick<StateLayoutRecord, 'files' | 'restore'>,
  dataset: Pick<RelocationDataset, 'slots'>,
): string | undefined {
  if (record.files.length !== dataset.slots.length)
    return `it lists ${record.files.length} files, not ${dataset.slots.length}`
  for (const slot of dataset.slots) {
    const file = record.files.find((candidate) => candidate.role === slot.role)
    if (!file) return `it has no ${slot.role} entry`
    if (file.from !== slot.from || file.to !== slot.to)
      return `its ${slot.role} entry names ${file.from} and ${file.to}, not ${slot.from} and ${slot.to}`
  }
  // A restore's recovery renames and deletes the files it lists, so they
  // must be this dataset's files too (their staging names follow from them).
  for (const file of record.restore?.files ?? []) {
    const slot = dataset.slots.find((candidate) => candidate.role === file.role)
    if (!slot || file.from !== slot.from || file.to !== slot.to)
      return `its restore lists ${file.from} and ${file.to} for ${file.role}`
  }
  return undefined
}

/** Why a move may not start, or undefined when it may. */
export async function movePreconditionFailure(
  dataset: RelocationDataset,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  // Same directory, or one inside the other: copying would overwrite sources.
  const oldInfo = await stat(windowsLongPath(dataset.oldDir, platform))
  let subInfo: Awaited<ReturnType<typeof stat>> | undefined
  try {
    subInfo = await stat(windowsLongPath(dataset.sub, platform))
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  if (subInfo && subInfo.dev === oldInfo.dev && subInfo.ino === oldInfo.ino)
    return `${dataset.sub} is the config folder itself`
  if (
    dataset.sub.startsWith(dataset.oldDir + sep) ||
    dataset.oldDir.startsWith(dataset.sub + sep)
  )
    return `${dataset.sub} and ${dataset.oldDir} contain one another`
  let anyOld = false
  for (const slot of dataset.slots) {
    // The configured path is checked as given: the canonical path follows a
    // leaf symlink, and a moved symlink would move someone else's file. Its
    // name is the role's own, never the name of whatever a link points at.
    for (const path of new Set([slot.configured, slot.from])) {
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(windowsLongPath(path, platform))
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        throw error
      }
      if (!info.isFile()) return `${path} is not a regular file`
      if (
        platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        info.uid !== process.getuid()
      )
        return `${path} belongs to another user`
    }
    if (
      dirname(slot.from) !== dataset.oldDir ||
      basename(slot.from) !== basename(slot.configured)
    )
      return `${slot.configured} resolves to ${slot.from}, not to a file of its own in the config folder`
    const fromExists = await exists(slot.from, platform)
    anyOld ||= fromExists
    if (await exists(slot.to, platform)) {
      if (fromExists) {
        const [a, b] = await Promise.all([
          lstat(windowsLongPath(slot.from, platform)),
          lstat(windowsLongPath(slot.to, platform)),
        ])
        if (a.dev === b.dev && a.ino === b.ino)
          return `${slot.from} and ${slot.to} are the same file`
      }
      return `unexpected anthropic-auth data in ${dataset.sub}: ${slot.to}`
    }
  }
  for (const role of ['localRuntime', 'vaultRuntime'] as const) {
    const slot = dataset.slots.find((candidate) => candidate.role === role)
    if (slot && (await tombstoneAttempt(slot.from)) !== undefined)
      return `${slot.from} is already a relocation tombstone`
  }
  if (await exists(dataset.oldPaths.journal, platform)) {
    let phase: string | undefined
    try {
      phase = nativeMigrationAuthorityPhase(
        await readNativeMigrationJournal(dataset.oldPaths),
      )
    } catch {
      return `${dataset.oldPaths.journal} can't be read`
    }
    if (!phase)
      return `the migration recorded in ${dataset.oldPaths.journal} is unfinished; run setup first`
  }
  // A dataset is consistent when nothing exists (a fresh install, which still
  // gets its barriers) or when something authorizes its files: a runtime or
  // a journal. Pool settings with neither mean state was deleted by hand.
  const authorized =
    (await exists(dataset.oldPaths.runtime, platform)) ||
    (await exists(dataset.oldVault.runtime, platform)) ||
    (await exists(dataset.oldPaths.journal, platform))
  if (
    !authorized &&
    (anyOld || (await exists(dataset.oldPaths.config, platform)))
  )
    return `${dataset.oldPaths.config} exists with no runtime and no journal`
  return undefined
}

/** A rollback met a state no supported writer produces; it changed nothing more. */
export class StateLayoutRollbackRefused extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`anthropic-auth can't undo the unfinished move at ${path}: ${detail}`)
    this.name = 'StateLayoutRollbackRefused'
  }
}

/** Expect the layout record to be in `phase` for `attempt` (or absent for `undefined`). */
function expectRecord(
  sub: string,
  want:
    | { phase: StateLayoutRecord['phase']; attempt: string }
    | 'absent-or-final',
) {
  return async (): Promise<string | undefined> => {
    let current: StateLayoutRecord | undefined
    try {
      current = await readStateLayoutRecord(sub)
    } catch {
      return 'layout.json is unreadable'
    }
    if (want === 'absent-or-final') {
      if (
        current === undefined ||
        current.phase === 'rolled-back' ||
        (current.phase === 'restored' && current.restore?.cleanup === 'done')
      )
        return undefined
      return `layout.json is ${current.phase}`
    }
    if (current?.phase === want.phase && current.attempt === want.attempt)
      return undefined
    return `layout.json is ${current?.phase ?? 'absent'}`
  }
}

/** Expect `path` to hold bytes hashing to `sha256`, or to be absent for null. */
export function expectDigest(path: string, sha256: string | null) {
  return async (): Promise<string | undefined> => {
    const digest = await digestFile(path)
    if (sha256 === null)
      return digest.status === 'absent' ? undefined : 'it exists'
    if (digest.status === 'file' && digest.sha256 === sha256) return undefined
    return digest.status === 'absent' ? 'it is missing' : 'its bytes changed'
  }
}

export function expectTombstone(path: string, attempt: string) {
  return async (): Promise<string | undefined> =>
    (await tombstoneAttempt(path)) === attempt
      ? undefined
      : 'it is no longer this move’s tombstone'
}

export function expectAbsent(path: string) {
  return async (): Promise<string | undefined> =>
    (await exists(path)) ? 'it exists' : undefined
}

/**
 * Rename `from` to `to` (or unlink `from` when `to` is undefined) through
 * `publishOwned`, treating a skipped retry as a failure.
 */
export async function owned(
  ctx: StateLayoutTransitionContext,
  step: Parameters<typeof publishOwned>[0],
  expect: () => Promise<string | undefined>,
): Promise<void> {
  const outcome = await publishOwned(
    step,
    { assertLeases: () => ctx.stack.assertAll(), expect },
    ctx.fs,
  )
  if (outcome === 'skipped')
    throw new Error(
      `anthropic-auth stopped: ${step.kind === 'rename' ? step.to : step.path} changed while it was being replaced`,
    )
}

/**
 * Undo a `preparing` record, under the mover's full lock set. Only this
 * attempt's own artifacts are undone; any other state is left alone because
 * the old layout is still authoritative. Every step is a no-op once done, so
 * recovery may run again from any point. Throws `StateLayoutRollbackRefused`
 * when a slot is in a state no supported writer produces.
 */
export async function rollbackPreparing(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<StateLayoutRecord> {
  const { attempt } = record
  const slot = (role: RelocationRole) => {
    const found = record.files.find((file) => file.role === role)
    if (!found)
      throw new StateLayoutRollbackRefused(dataset.sub, `no ${role} entry`)
    return found
  }
  // 1. The journal.
  if (record.barriers.journal === 'present') {
    const journal = slot('journal')
    const moving = movingJournalPath(journal.from, attempt)
    const movingThere = await exists(moving)
    const journalThere = await exists(journal.from)
    if (movingThere && journalThere)
      throw new StateLayoutRollbackRefused(
        journal.from,
        `both ${journal.from} and ${moving} exist`,
      )
    if (!movingThere && !journalThere)
      throw new StateLayoutRollbackRefused(
        journal.from,
        'the journal is missing',
      )
    if (movingThere)
      await owned(
        ctx,
        { kind: 'rename', from: moving, to: journal.from },
        expectAbsent(journal.from),
      )
  }
  await stateLayoutStep(ctx, 'rollback:journal')
  // 2. Both runtimes.
  for (const role of ['localRuntime', 'vaultRuntime'] as const) {
    const file = slot(role)
    const original = record.barriers[role].original
    await removeOwnStaging(relocatingPath(file.from, attempt))
    const found = await tombstoneAttempt(file.from)
    if (found !== undefined && found !== attempt)
      throw new StateLayoutRollbackRefused(
        file.from,
        'it holds another move’s tombstone',
      )
    if (found === attempt) {
      if (original === null) {
        await owned(
          ctx,
          { kind: 'unlink', path: file.from },
          expectTombstone(file.from, attempt),
        )
      } else {
        let copy: Buffer
        try {
          copy = await readFile(windowsLongPath(file.to, ctx.fs.platform))
        } catch {
          throw new StateLayoutRollbackRefused(
            file.to,
            `its copy, needed to undo the tombstone over ${file.from}, is missing`,
          )
        }
        if (sha256Hex(copy) !== original)
          throw new StateLayoutRollbackRefused(
            file.to,
            `its copy changed, so the tombstone over ${file.from} can't be undone`,
          )
        const stage = restoringPath(file.from, attempt)
        await removeOwnStaging(stage)
        await createOwnerOnlyFile(ctx.fs, stage, copy)
        if ((await fileSha256(stage, ctx.fs.platform)) !== original)
          throw new StateLayoutRollbackRefused(
            stage,
            'the restored bytes differ',
          )
        await owned(
          ctx,
          { kind: 'rename', from: stage, to: file.from },
          expectTombstone(file.from, attempt),
        )
      }
    }
    await stateLayoutStep(ctx, `rollback:${role}`)
  }
  // 3. The old side is final before any copy is removed.
  await ctx.fs.syncDirectory(dataset.oldDir)
  await stateLayoutStep(ctx, 'rollback:old-dir-flushed')
  // 4. Destination cleanup over a closed allowlist.
  for (const file of record.files) {
    await removeOwnStaging(relocatingPath(file.to, attempt), ctx.fs.platform)
    if (file.sha256 === null) continue
    const digest = await digestFile(file.to, ctx.fs.platform)
    if (digest.status !== 'file' || digest.sha256 !== file.sha256) continue
    // A copy whose source is gone may be the only copy left: keep it.
    if (!(await exists(file.from))) continue
    await owned(
      ctx,
      { kind: 'unlink', path: file.to },
      expectDigest(file.to, file.sha256),
    )
  }
  for (const name of await readdir(
    windowsLongPath(dataset.sub, ctx.fs.platform),
  ))
    if (isLayoutRecordStage(name, attempt))
      await removeOwnStaging(join(dataset.sub, name), ctx.fs.platform)
  await stateLayoutStep(ctx, 'rollback:destination-removed')
  await ctx.fs.syncDirectory(dataset.sub)
  await stateLayoutStep(ctx, 'rollback:sub-flushed')
  const rolledBack: StateLayoutRecord = {
    ...record,
    phase: 'rolled-back',
    rolledBackAt: ctx.now(),
  }
  await publishStateLayoutRecord(
    rolledBack,
    {
      assertLeases: () => ctx.stack.assertAll(),
      expect: expectRecord(dataset.sub, { phase: 'preparing', attempt }),
    },
    ctx.fs,
  )
  await stateLayoutStep(ctx, 'rolled-back')
  forgetRelocationObservations()
  return rolledBack
}

/**
 * Remove the verified old copies, local pool state first, while
 * every data lock is still held. A file is unlinked only if it still hashes
 * to the recorded value. A changed or reappeared old pool state or journal is
 * a conflict: both copies are kept and the record says `conflict`, which
 * stops every state-home process. Any other changed file is kept and listed.
 * Running it again after a conflict was resolved by hand finishes the
 * cleanup.
 *
 * Once a credential conflict is found it outlives any later failure: if a
 * later step or the final record write fails, the conflict is still recorded
 * when possible, and the call throws a `conflict` refusal rather than the
 * failure, so no caller can mistake it for an ordinary pending cleanup.
 */
export async function cleanupOldCopies(
  record: StateLayoutRecord,
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<StateLayoutRecord> {
  const kept: string[] = []
  const conflict: { old: string; new: string }[] = []
  const publish = (next: StateLayoutRecord) =>
    publishStateLayoutRecord(
      next,
      {
        assertLeases: () => ctx.stack.assertAll(),
        expect: expectRecord(dataset.sub, {
          phase: 'committed',
          attempt: record.attempt,
        }),
      },
      ctx.fs,
    )
  const outcome = (): StateLayoutRecord => {
    const next: StateLayoutRecord = {
      ...record,
      cleanup: conflict.length ? 'conflict' : kept.length ? 'kept' : 'done',
      ...(kept.length ? { kept: [...kept] } : {}),
      ...(conflict.length ? { conflict: [...conflict] } : {}),
    }
    if (!conflict.length) delete (next as { conflict?: unknown }).conflict
    if (!kept.length) delete (next as { kept?: unknown }).kept
    return next
  }
  const refusal = (cause: unknown) => {
    const [first] = conflict
    return stateLayoutConflict(
      first?.old ?? dataset.oldPaths.state,
      first?.new ?? dataset.newPaths.state,
      cause,
    )
  }
  try {
    // A journal at its legacy name after the commit is back from somewhere:
    // the move set it aside before the commit.
    const journalSlot = record.files.find((file) => file.role === 'journal')
    if (journalSlot && (await exists(journalSlot.from)))
      conflict.push({ old: journalSlot.from, new: journalSlot.to })
    for (const role of RELOCATION_ROLES) {
      if (role === 'localRuntime' || role === 'vaultRuntime') continue
      const file = record.files.find((candidate) => candidate.role === role)
      if (!file) continue
      const path =
        role === 'journal'
          ? movingJournalPath(file.from, record.attempt)
          : file.from
      await ctx.stack.assertAll()
      const credential = CREDENTIAL_AUTHORITY_ROLES.includes(role)
      let digest: FileDigest | undefined
      try {
        digest = await digestFile(path, ctx.fs.platform)
      } catch (error) {
        // A credential file that is no longer a plain file can't be proven
        // to be the verified copy, so it is a second copy.
        if (!credential) throw error
      }
      if (digest?.status === 'absent') {
        // Already removed.
      } else if (
        digest !== undefined &&
        file.sha256 !== null &&
        digest.sha256 === file.sha256
      ) {
        await owned(
          ctx,
          { kind: 'unlink', path },
          expectDigest(path, file.sha256),
        )
      } else if (credential) {
        conflict.push({ old: path, new: file.to })
        logger.error(
          'state-layout',
          'an old copy of anthropic-auth credentials changed after the move; both copies were kept and anthropic-auth stopped using them',
          { old: path, new: file.to },
        )
      } else if (file.sha256 !== null) {
        kept.push(path)
        logger.error(
          'state-layout',
          'an old anthropic-auth file changed after the move and was kept',
          { path },
        )
      }
      await stateLayoutStep(ctx, `cleanup:${role}`)
    }
    await ctx.fs.syncDirectory(dataset.oldDir)
  } catch (error) {
    if (error instanceof StateLayoutCrash || !conflict.length) throw error
    // Record what was found before the failure; if even that fails, the
    // refusal below still stops this start, and the next start finds the
    // same conflict again.
    await publish(outcome()).catch(() => {})
    throw refusal(error)
  }
  const next = outcome()
  try {
    await publish(next)
  } catch (error) {
    if (error instanceof StateLayoutCrash || !conflict.length) throw error
    throw refusal(error)
  }
  await stateLayoutStep(ctx, 'cleanup-recorded')
  return next
}

/** How a move ended. */
export type StateLayoutMoveOutcome =
  | { readonly status: 'committed'; readonly record: StateLayoutRecord }
  | {
      readonly status: 'rolled-back'
      readonly reason: string
      readonly record?: StateLayoutRecord
    }

/** The move was stopped before its commit by a check, not by an error. */
class MoveRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'MoveRefused'
  }
}

/**
 * The move itself, under the layout lock, both holder locks and every data
 * lock, all held by `ctx.stack`. `checkArtifacts` repeats the fence's check
 * for pid artifacts of older versions and returns a blocker description or
 * undefined.
 *
 * Before the commit any failure rolls back and resolves `rolled-back`; a
 * rollback that refuses throws `StateLayoutRollbackRefused`. A failure of the
 * commit write itself is resolved from the record on disk. After the commit
 * nothing goes back to legacy: a cleanup failure leaves cleanup `pending` and
 * still resolves `committed`.
 */
export async function moveDataset(
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
  checkArtifacts: () => Promise<string | undefined>,
): Promise<StateLayoutMoveOutcome> {
  const attempt = randomUUID()
  // Step 1: snapshot every old file of the closed list.
  const files: RelocationFileRecord[] = []
  for (const slot of dataset.slots)
    files.push({
      role: slot.role,
      from: slot.from,
      to: slot.to,
      sha256: await fileSha256(slot.from, ctx.fs.platform),
    })
  const sha = (role: RelocationRole) =>
    files.find((file) => file.role === role)?.sha256 ?? null
  await ctx.stack.assertAll()
  // Step 2: the subfolder's identity and holder files.
  const configDirPath = join(dataset.sub, STATE_HOME_FILE_NAMES.configDirMarker)
  if (!(await exists(configDirPath, ctx.fs.platform))) {
    const stage = `${configDirPath}.${attempt}.tmp`
    await createOwnerOnlyFile(
      ctx.fs,
      stage,
      Buffer.from(
        `${JSON.stringify({ version: 1, identity: dataset.identity })}\n`,
      ),
    )
    try {
      await owned(
        ctx,
        { kind: 'rename', from: stage, to: configDirPath },
        expectAbsent(configDirPath),
      )
    } finally {
      await removeOwnStaging(stage, ctx.fs.platform)
    }
  }
  const holderFile = join(dataset.sub, HOLDER_FILE_NAME)
  if (!(await exists(holderFile, ctx.fs.platform)))
    await writeJsonAtomic(
      holderFile,
      { version: 1, entries: [] },
      {
        beforeRename: () => ctx.stack.assertAll(),
        durable: ctx.fs.platform !== 'win32',
      },
    )
  await ctx.fs.syncDirectory(dataset.sub)
  await stateLayoutStep(ctx, 'config-dir-written')
  // Step 3: the durable preparing record.
  const preparing: StateLayoutRecord = {
    version: 1,
    phase: 'preparing',
    attempt,
    identity: dataset.identity,
    stateRoot: dataset.stateRoot,
    sub: dataset.sub,
    oldDir: dataset.oldDir,
    storageIds: dataset.storageIds,
    by: ctx.release,
    startedAt: ctx.now(),
    files,
    barriers: {
      journal: sha('journal') === null ? 'absent' : 'present',
      localRuntime: { original: sha('localRuntime') },
      vaultRuntime: { original: sha('vaultRuntime') },
    },
  }
  await publishStateLayoutRecord(
    preparing,
    {
      assertLeases: () => ctx.stack.assertAll(),
      expect: expectRecord(dataset.sub, 'absent-or-final'),
    },
    ctx.fs,
  )
  await stateLayoutStep(ctx, 'preparing-written')
  try {
    // Step 4: copy and verify each present file.
    for (const file of files) {
      if (file.sha256 === null) continue
      const bytes = await readFile(windowsLongPath(file.from, ctx.fs.platform))
      if (sha256Hex(bytes) !== file.sha256)
        throw new MoveRefused(`${file.from} changed while it was copied`)
      const stage = relocatingPath(file.to, attempt)
      await createOwnerOnlyFile(ctx.fs, stage, bytes)
      const back = await readFile(windowsLongPath(stage, ctx.fs.platform))
      if (!back.equals(bytes))
        throw new MoveRefused(`the copy of ${file.from} reads back differently`)
      await owned(
        ctx,
        { kind: 'rename', from: stage, to: file.to },
        expectAbsent(file.to),
      )
      await stateLayoutStep(ctx, `copied:${file.role}`)
    }
    await ctx.fs.syncDirectory(dataset.sub)
    await stateLayoutStep(ctx, 'copies-flushed')
    // Step 5: older versions take no lock we share, so look for them again.
    const blocker = await checkArtifacts()
    if (blocker) throw new MoveRefused(blocker)
    await stateLayoutStep(ctx, 'artifacts-checked')
    // Step 6: the old-layout barriers, durable before the commit.
    const journal = files.find((file) => file.role === 'journal')
    if (journal && journal.sha256 !== null) {
      const moving = movingJournalPath(journal.from, attempt)
      await owned(
        ctx,
        { kind: 'rename', from: journal.from, to: moving },
        async () =>
          (await expectDigest(journal.from, journal.sha256)()) ??
          (await expectAbsent(moving)()),
      )
    }
    await stateLayoutStep(ctx, 'journal-set-aside')
    for (const role of ['localRuntime', 'vaultRuntime'] as const) {
      const file = files.find((candidate) => candidate.role === role)
      if (!file) continue
      const stage = relocatingPath(file.from, attempt)
      await createOwnerOnlyFile(
        ctx.fs,
        stage,
        Buffer.from(relocationTombstone(preparing)),
      )
      await owned(
        ctx,
        { kind: 'rename', from: stage, to: file.from },
        expectDigest(file.from, file.sha256),
      )
      await stateLayoutStep(
        ctx,
        role === 'localRuntime'
          ? 'local-runtime-tombstoned'
          : 'vault-runtime-tombstoned',
      )
    }
    await ctx.fs.syncDirectory(dataset.oldDir)
    await stateLayoutStep(ctx, 'old-dir-flushed')
    // Step 7: compare everything again behind the barriers.
    await ctx.stack.assertAll()
    for (const file of files) {
      if (file.role === 'localRuntime' || file.role === 'vaultRuntime') continue
      const path =
        file.role === 'journal' && file.sha256 !== null
          ? movingJournalPath(file.from, attempt)
          : file.from
      const mismatch = await expectDigest(path, file.sha256)()
      if (mismatch)
        throw new MoveRefused(`${path} changed during the move: ${mismatch}`)
    }
    for (const file of files) {
      const mismatch = await expectDigest(file.to, file.sha256)()
      if (mismatch)
        throw new MoveRefused(`${file.to} changed during the move: ${mismatch}`)
    }
    await stateLayoutStep(ctx, 'verified')
  } catch (error) {
    if (error instanceof StateLayoutCrash) throw error
    const reason = error instanceof Error ? error.message : String(error)
    logger.error(
      'state-layout',
      'anthropic-auth could not move its state; keeping the old folder',
      {
        reason,
      },
    )
    const record = await rollbackAfterFailure(preparing, dataset, ctx)
    return { status: 'rolled-back', reason, record }
  }
  // Step 8: the commit.
  const committed: StateLayoutRecord = {
    ...preparing,
    phase: 'committed',
    committedAt: ctx.now(),
    cleanup: 'pending',
  }
  try {
    await publishStateLayoutRecord(
      committed,
      {
        assertLeases: () => ctx.stack.assertAll(),
        expect: expectRecord(dataset.sub, { phase: 'preparing', attempt }),
      },
      ctx.fs,
    )
  } catch (error) {
    if (error instanceof StateLayoutCrash) throw error
    // Did the rename land before the failure? The record on disk decides.
    const onDisk = await readStateLayoutRecord(dataset.sub)
    if (onDisk?.phase === 'committed' && onDisk.attempt === attempt) {
      await syncCommitted(dataset, ctx)
    } else if (onDisk?.phase === 'preparing' && onDisk.attempt === attempt) {
      const reason = error instanceof Error ? error.message : String(error)
      const record = await rollbackAfterFailure(preparing, dataset, ctx)
      return { status: 'rolled-back', reason, record }
    } else throw error
  }
  await stateLayoutStep(ctx, 'committed')
  forgetRelocationObservations()
  // Step 9: cleanup, still under every data lock.
  try {
    return {
      status: 'committed',
      record: await cleanupOldCopies(committed, dataset, ctx),
    }
  } catch (error) {
    if (error instanceof StateLayoutCrash) throw error
    // A conflict found by the cleanup stops this process like any other
    // start; only an ordinary cleanup failure leaves cleanup pending.
    if (error instanceof StateLayoutRefusalError) throw error
    logger.warn(
      'state-layout',
      'anthropic-auth moved its state but could not remove every old copy yet; it retries at the next start',
      { reason: error instanceof Error ? error.message : String(error) },
    )
    return { status: 'committed', record: committed }
  }
}

/**
 * Flush `<sub>/layout.json` and `<sub>`. A process that died after renaming
 * a new record into place but before flushing `<sub>` leaves a record that
 * power loss can still revert, so a process that acts on a record it found
 * makes it durable first.
 */
export async function syncLayoutRecord(
  dataset: Pick<RelocationDataset, 'sub'>,
  ctx: Pick<StateLayoutTransitionContext, 'fs'>,
): Promise<void> {
  await (
    ctx.fs.syncFile ?? ((path: string) => syncFile(path, ctx.fs.platform))
  )(layoutRecordPath(dataset.sub))
  await ctx.fs.syncDirectory(dataset.sub)
}

/** Flush a committed record and `<sub>`. */
export async function syncCommitted(
  dataset: RelocationDataset,
  ctx: Pick<StateLayoutTransitionContext, 'fs'>,
): Promise<void> {
  await syncLayoutRecord(dataset, ctx)
}

/**
 * Roll back after a failure before the commit. When a lease was lost the
 * locks are no longer proof of exclusion, so the rollback is left to the next
 * start, which takes a fresh lock set; the record stays `preparing`.
 */
async function rollbackAfterFailure(
  preparing: StateLayoutRecord,
  dataset: RelocationDataset,
  ctx: StateLayoutTransitionContext,
): Promise<StateLayoutRecord | undefined> {
  try {
    await ctx.stack.assertAll()
  } catch {
    return undefined
  }
  return rollbackPreparing(preparing, dataset, ctx)
}
