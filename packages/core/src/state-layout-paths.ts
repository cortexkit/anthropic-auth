import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import * as nodePath from 'node:path'

import { getOpenCodeConfigDir } from './accounts.ts'
import { parseJsonRedacted } from './json.ts'
import { windowsLongPath } from './windows-long-path.ts'

/**
 * Where a dataset's machine-written files live.
 *
 * - `legacy`: beside the account files in OpenCode's config folder, as in every
 *   release so far.
 * - `state-home`: in `dir`, the config folder's own subfolder of the CortexKit
 *   state root. `dir` must be absolute and canonical (no symlinked component),
 *   because vault paths are derived from it without another realpath pass.
 *
 * The layout decides only where files are. Storage ids never depend on it: they
 * are always computed from where the files would be in the legacy layout, so a
 * file copied between layouts keeps the id it was written with.
 */
export type StateLayout =
  | { readonly kind: 'legacy' }
  | { readonly kind: 'state-home'; readonly dir: string }

export const LEGACY_STATE_LAYOUT: StateLayout = Object.freeze({
  kind: 'legacy',
})

/**
 * Layouts this process has decided, by the canonical path of the dataset's
 * account file (`<config folder>/anthropic-auth.json`). Only the layout
 * decision at start adds to it, and only for OpenCode's default dataset.
 */
const decidedLayouts = new Map<string, StateLayout>()

/**
 * The layout a resolver uses when its caller passes none. A process decides it
 * once, before it resolves any pool path, and never switches: every
 * re-resolution must use the same layout as the first, or comparisons between
 * them fail. `legacyConfig` is the canonical account file the resolver works
 * from. A dataset with no recorded decision, and every call without
 * `legacyConfig`, uses the legacy layout.
 */
export function processStateLayout(legacyConfig?: string): StateLayout {
  if (legacyConfig === undefined) return LEGACY_STATE_LAYOUT
  return decidedLayouts.get(legacyConfig) ?? LEGACY_STATE_LAYOUT
}

/**
 * Record the layout decided for the dataset whose canonical account file is
 * `legacyConfig`. A decision is final for the process: recording a different
 * layout for the same dataset throws.
 */
export function recordProcessStateLayout(
  legacyConfig: string,
  layout: StateLayout,
): void {
  const current = decidedLayouts.get(legacyConfig)
  if (current !== undefined) {
    const same =
      current.kind === layout.kind &&
      (current.kind === 'legacy' ||
        (layout.kind === 'state-home' && current.dir === layout.dir))
    if (!same)
      throw new Error(
        'anthropic-auth already chose a different state layout for this folder in this process',
      )
    return
  }
  decidedLayouts.set(legacyConfig, Object.freeze({ ...layout }))
}

/** Forget every recorded layout decision; tests only. */
export function resetProcessStateLayoutsForTests(): void {
  decidedLayouts.clear()
}

/** The `node:path` functions the pure helpers use; tests pass `path.win32`. */
export type StatePathApi = Pick<typeof nodePath, 'join' | 'isAbsolute'>

export interface StateRootInputs {
  /** `XDG_STATE_HOME` exactly as read; undefined or empty means unset. */
  xdgStateHome: string | undefined
  /** Home directory used when `XDG_STATE_HOME` is unset or not usable. */
  home: string
  /**
   * Use a relative `XDG_STATE_HOME` as given. The XDG base-directory rules say
   * a relative value is invalid and must be ignored, which is the default and
   * what the CLI diagnostics folder has always done. Host enrollment files and
   * the RPC folder have always accepted a relative value, so they keep doing
   * so: changing it would hide an existing enrollment.
   */
  acceptRelative?: boolean
}

/**
 * The CortexKit state root of anthropic-auth:
 * `<XDG_STATE_HOME or ~/.local/state>/cortexkit/anthropic-auth`. Enrollment
 * files, RPC port files, CLI diagnostics and relocated pool state all live
 * under it.
 */
export function anthropicAuthStateRoot(
  inputs: StateRootInputs,
  pathApi: StatePathApi = nodePath,
): string {
  const { xdgStateHome, home, acceptRelative = false } = inputs
  const base =
    xdgStateHome && (acceptRelative || pathApi.isAbsolute(xdgStateHome))
      ? xdgStateHome
      : pathApi.join(home, '.local', 'state')
  return pathApi.join(base, 'cortexkit', 'anthropic-auth')
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/**
 * The identity of a config folder: `realpathSync.native` of it, compared and
 * hashed exactly as returned, with no case folding on any OS. A folder that
 * doesn't exist has no identity, and its dataset stays in the legacy layout.
 */
export function configFolderIdentity(
  configDir: string = getOpenCodeConfigDir(),
): string | undefined {
  try {
    return realpathSync.native(configDir)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}

/** OpenCode's config folder when nothing in the environment overrides it. */
export function homeDefaultConfigDir(
  home: string = homedir(),
  pathApi: StatePathApi = nodePath,
): string {
  return pathApi.join(home, '.config', 'opencode')
}

/**
 * The state-root subfolder of a config folder. Only the home directory's
 * default folder gets the plain `opencode` name. That folder is derived from
 * the home directory and never from `XDG_CONFIG_HOME`, so two environments
 * with different `XDG_CONFIG_HOME` values can't both claim `opencode`. Every
 * other folder gets `opencode-<first 16 hex digits of sha256(identity)>`.
 */
export function stateSubfolderName(
  identity: string,
  homeDefaultIdentity: string | undefined,
): string {
  if (identity === homeDefaultIdentity) return 'opencode'
  const hash = createHash('sha256').update(identity).digest('hex')
  return `opencode-${hash.slice(0, 16)}`
}

export interface StateHomeTarget {
  /** The config folder's identity (see `configFolderIdentity`). */
  identity: string
  /** The state root this process uses. */
  stateRoot: string
  /**
   * The config folder's subfolder of `stateRoot`. It may not exist yet, so it
   * is not canonicalized here.
   */
  dir: string
}

/**
 * Where this process would keep the state of OpenCode's config folder in the
 * state-home layout, or undefined when the config folder has no identity.
 * `XDG_STATE_HOME` must be absolute to count; a relative value is ignored.
 */
export function resolveStateHomeTarget(
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): StateHomeTarget | undefined {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const identity = configFolderIdentity(getOpenCodeConfigDir(env, home))
  if (identity === undefined) return undefined
  return stateHomeTargetFor(identity, { env, home })
}

/**
 * `resolveStateHomeTarget` for a config folder whose identity is already
 * known. Naming the subfolder resolves the home directory's default config
 * folder, which may be a different folder from the one in use, so a start
 * that never looks at the state folder never calls this.
 */
export function stateHomeTargetFor(
  identity: string,
  options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): StateHomeTarget {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const stateRoot = anthropicAuthStateRoot({
    xdgStateHome: env.XDG_STATE_HOME,
    home,
  })
  const name = stateSubfolderName(
    identity,
    configFolderIdentity(homeDefaultConfigDir(home)),
  )
  return { identity, stateRoot, dir: nodePath.join(stateRoot, name) }
}

/**
 * Names of the files kept in a state-home subfolder. Data files keep their
 * default legacy names so the folder stays readable for manual recovery.
 */
export const STATE_HOME_FILE_NAMES = Object.freeze({
  localPoolState: 'anthropic-auth-pool-state.json',
  localRuntime: 'anthropic-auth-native-state.json',
  journal: 'anthropic-auth-migration.json',
  localRoster: 'anthropic-auth-custody-roster.json',
  vaultStoreState: 'anthropic-auth-vault-store-state.json',
  vaultRuntime: 'anthropic-auth-vault-state.json',
  vaultRoster: 'anthropic-auth-vault-roster.json',
  vaultRouting: 'anthropic-auth-vault-routing-state.json',
  requestGzip: 'anthropic-auth-request-gzip.json',
  configDirMarker: 'config-dir.json',
  layoutMarker: 'layout.json',
})

export type StateHomeFilePaths = {
  readonly [K in keyof typeof STATE_HOME_FILE_NAMES]: string
}

/**
 * Every file of a state-home subfolder. The account files
 * (`anthropic-auth.json`, `anthropic-auth-state.json`), the pool settings
 * (`anthropic-auth-pool.json`), the vault settings
 * (`anthropic-auth-vault-settings.json`), the local routing file and the TUI
 * preferences stay in the config folder in both layouts and are not listed.
 */
export function stateHomeFilePaths(
  dir: string,
  pathApi: StatePathApi = nodePath,
): StateHomeFilePaths {
  const paths: Record<string, string> = {}
  for (const [role, name] of Object.entries(STATE_HOME_FILE_NAMES))
    paths[role] = pathApi.join(dir, name)
  return Object.freeze(paths as StateHomeFilePaths)
}

const DEFAULT_ACCOUNT_FILE = 'anthropic-auth.json'
const DEFAULT_ACCOUNT_STATE_FILE = 'anthropic-auth-state.json'

/**
 * Files of the state-home layout for a dataset given by its canonical legacy
 * account files. Only the default dataset of a config folder can use that
 * layout: custom file names or a state file away from the config file mean an
 * explicit override, which keeps every file beside the named files.
 */
export function stateHomeDatasetFiles(
  layout: Extract<StateLayout, { kind: 'state-home' }>,
  legacyConfig: string,
  legacyState: string,
): StateHomeFilePaths {
  if (!nodePath.isAbsolute(layout.dir))
    throw new Error('The state-home folder must be an absolute path')
  if (
    nodePath.basename(legacyConfig) !== DEFAULT_ACCOUNT_FILE ||
    nodePath.basename(legacyState) !== DEFAULT_ACCOUNT_STATE_FILE ||
    nodePath.dirname(legacyConfig) !== nodePath.dirname(legacyState)
  )
    throw new Error(
      'The state-home layout applies only to the default account files of a config folder',
    )
  return stateHomeFilePaths(layout.dir)
}

export type StateLayoutFileErrorCode = 'unreadable' | 'invalid'

/** A state-layout file exists but can't be read or doesn't parse. */
export class StateLayoutFileError extends Error {
  readonly code: StateLayoutFileErrorCode
  readonly path: string

  constructor(code: StateLayoutFileErrorCode, path: string, cause?: unknown) {
    super(
      code === 'invalid'
        ? `anthropic-auth state layout file ${path} is invalid`
        : `anthropic-auth state layout file ${path} cannot be read`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'StateLayoutFileError'
    this.code = code
    this.path = path
  }
}

const MARKER_MAX_BYTES = 1024 * 1024
const POINTER_MAX_BYTES = 64 * 1024

type SmallFile =
  | { status: 'absent' }
  | { status: 'not-small-file' }
  | { status: 'read'; text: string }

/** Read a regular file of at most `maxBytes`; anything else is reported, not read. */
async function readSmallFile(
  path: string,
  maxBytes: number,
): Promise<SmallFile> {
  // On Windows a long state-home marker needs the extended-length form or
  // the open below fails with EINVAL; POSIX is unchanged.
  const longPath = windowsLongPath(path)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(longPath, 'r')
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT') return { status: 'absent' }
    if (code === 'EISDIR') return { status: 'not-small-file' }
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > maxBytes)
      return { status: 'not-small-file' }
    const bytes = await handle.readFile()
    // The file may have grown since the size check.
    if (bytes.length > maxBytes) return { status: 'not-small-file' }
    return { status: 'read', text: bytes.toString('utf8') }
  } finally {
    await handle.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Read a marker file: undefined when absent, otherwise parsed or refused. */
async function readMarker<T>(
  path: string,
  parse: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  let file: SmallFile
  try {
    file = await readSmallFile(path, MARKER_MAX_BYTES)
  } catch (error) {
    throw new StateLayoutFileError('unreadable', path, error)
  }
  if (file.status === 'absent') return undefined
  if (file.status !== 'read') throw new StateLayoutFileError('invalid', path)
  let value: unknown
  try {
    value = parseJsonRedacted(file.text)
  } catch {
    throw new StateLayoutFileError('invalid', path)
  }
  const parsed = parse(value)
  if (parsed === undefined) throw new StateLayoutFileError('invalid', path)
  return parsed
}

/** `config-dir.json`: names the config folder a state-home subfolder belongs to. */
export interface ConfigDirMarker {
  readonly version: 1
  readonly identity: string
}

/**
 * Read `<dir>/config-dir.json`. Undefined only when the file is absent; any
 * other read error, or content that doesn't parse, throws
 * `StateLayoutFileError`.
 */
export async function readConfigDirMarker(
  dir: string,
): Promise<ConfigDirMarker | undefined> {
  return readMarker(
    nodePath.join(dir, STATE_HOME_FILE_NAMES.configDirMarker),
    (value) =>
      isRecord(value) && value.version === 1 && nonEmptyString(value.identity)
        ? Object.freeze({ version: 1, identity: value.identity })
        : undefined,
  )
}

export const STATE_LAYOUT_PHASES = [
  'preparing',
  'committed',
  'rolled-back',
  'restoring',
  'restore-staged',
  'restored',
] as const
export type StateLayoutPhase = (typeof STATE_LAYOUT_PHASES)[number]

/**
 * `conflict`: cleanup found that an old copy of the local pool state or the
 * journal changed after the move was verified, so both copies are kept and no
 * process serves the dataset until a person removes one of them.
 */
const CLEANUP_STATES = ['pending', 'done', 'kept', 'conflict'] as const
const RESTORE_CLEANUP_STATES = ['pending', 'done'] as const

/** The fields of `layout.json` that decide whether a process may use a layout. */
export interface StateLayoutMarker {
  readonly version: 1
  readonly phase: StateLayoutPhase
  readonly attempt: string
  readonly identity: string
  readonly stateRoot: string
  readonly sub: string
  readonly oldDir: string
  readonly storageIds: { readonly local: string; readonly vault: string }
  /** Present once a move has committed. */
  readonly cleanup?: (typeof CLEANUP_STATES)[number]
  /** Present while a restore to the legacy layout is under way or finished. */
  readonly restore?: {
    readonly cleanup?: (typeof RESTORE_CLEANUP_STATES)[number]
  }
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === 'string' && (values as readonly string[]).includes(value)
  )
}

function parseLayoutMarker(value: unknown): StateLayoutMarker | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const { phase, attempt, identity, stateRoot, sub, oldDir, storageIds } = value
  if (
    !oneOf(STATE_LAYOUT_PHASES, phase) ||
    !nonEmptyString(attempt) ||
    !nonEmptyString(identity) ||
    !nonEmptyString(stateRoot) ||
    !nonEmptyString(sub) ||
    !nonEmptyString(oldDir) ||
    !isRecord(storageIds) ||
    !nonEmptyString(storageIds.local) ||
    !nonEmptyString(storageIds.vault)
  )
    return undefined
  const rawCleanup = value.cleanup
  let cleanup: StateLayoutMarker['cleanup']
  if (rawCleanup === undefined) {
    if (phase === 'committed') return undefined
  } else if (oneOf(CLEANUP_STATES, rawCleanup)) cleanup = rawCleanup
  else return undefined
  let restore: StateLayoutMarker['restore']
  if (value.restore !== undefined) {
    if (!isRecord(value.restore)) return undefined
    const restoreCleanup = value.restore.cleanup
    if (
      restoreCleanup !== undefined &&
      !oneOf(RESTORE_CLEANUP_STATES, restoreCleanup)
    )
      return undefined
    restore = Object.freeze(
      restoreCleanup === undefined ? {} : { cleanup: restoreCleanup },
    )
  } else if (phase === 'restored') return undefined
  return Object.freeze({
    version: 1,
    phase,
    attempt,
    identity,
    stateRoot,
    sub,
    oldDir,
    storageIds: Object.freeze({
      local: storageIds.local,
      vault: storageIds.vault,
    }),
    ...(cleanup === undefined ? {} : { cleanup }),
    ...(restore === undefined ? {} : { restore }),
  })
}

/**
 * Read `<dir>/layout.json`. Undefined only when the file is absent. Any other
 * read error, or content that doesn't parse, throws `StateLayoutFileError`:
 * an unreadable marker must never be taken as "no move" or as a finished one.
 */
export async function readStateLayoutMarker(
  dir: string,
): Promise<StateLayoutMarker | undefined> {
  return readMarker(
    nodePath.join(dir, STATE_HOME_FILE_NAMES.layoutMarker),
    parseLayoutMarker,
  )
}

/**
 * What a relocation tombstone over an old runtime path says. A move replaces
 * each legacy runtime file with one, so older versions refuse the legacy copy
 * and newer ones can name where the state went.
 */
export interface RelocationPointer {
  readonly relocatedTo: string
  readonly stateRoot: string
  readonly identity: string
  readonly attempt: string
  readonly by: string
}

/**
 * Read a legacy runtime path as a relocation tombstone. Undefined when the
 * file is absent, isn't a small regular file, or doesn't parse as a
 * tombstone: such a file is an ordinary runtime, valid or not, and its own
 * reader decides. Read errors other than absence are thrown.
 */
export async function readRelocationPointer(
  runtimePath: string,
): Promise<RelocationPointer | undefined> {
  const file = await readSmallFile(runtimePath, POINTER_MAX_BYTES)
  if (file.status !== 'read') return undefined
  let value: unknown
  try {
    value = parseJsonRedacted(file.text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.version !== 0) return undefined
  const { relocatedTo, stateRoot, identity, attempt, by } = value
  if (
    !nonEmptyString(relocatedTo) ||
    !nonEmptyString(stateRoot) ||
    !nonEmptyString(identity) ||
    !nonEmptyString(attempt) ||
    !nonEmptyString(by)
  )
    return undefined
  return Object.freeze({ relocatedTo, stateRoot, identity, attempt, by })
}
