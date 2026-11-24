import { win32 } from 'node:path'
import { types as utilTypes } from 'node:util'

/**
 * Why a process refuses to use a dataset while deciding or serving the
 * state-home layout. Each code has a default public message.
 */
export type StateLayoutRefusalCode =
  /** An old copy of the credentials or journal is back beside a moved copy. */
  | 'conflict'
  /** The dataset was moved under another state root (`XDG_STATE_HOME`). */
  | 'moved-elsewhere'
  /**
   * A move recorded under another state root stopped part way, leaving the
   * journal set aside in the config folder.
   */
  | 'move-unfinished-elsewhere'
  /** A marker or tombstone belongs to a different config folder or dataset. */
  | 'other-dataset'
  /** `layout.json` exists but can't be read or parsed, or is missing after a move. */
  | 'marker-unreadable'
  /** A restore to the legacy layout stopped part way. */
  | 'restore-unfinished'
  /** Another process holds the layout for longer than this process waits. */
  | 'busy'
  /** The move could not be made durable or undone; serving either copy is unsafe. */
  | 'unsafe'
  /** The state folder holds data this process can't prove it wrote. */
  | 'unexpected-data'
  /** A restore to the legacy layout can't start; the message names what to fix. */
  | 'restore-refused'
  /**
   * A folder or file that decides where the state is (the config folder, the
   * state folder, or a lock beside them) could not be read or written.
   */
  | 'io-failed'

/** The command that restores the legacy layout, as users run it. */
export const RESTORE_LEGACY_COMMAND =
  'npx @cortexkit/opencode-anthropic-auth setup --restore-legacy'

const IO_FAILED_PREFIX =
  "anthropic-auth could not read or write a folder that decides where its state is, so it won't use either copy."

/**
 * Default messages name no files because hosts show them where their output
 * may be shared. Only an unsafe Windows parent needs its path and the
 * account's security identifier on screen so the user can fix its permissions.
 */
const PUBLIC_MESSAGES: Record<StateLayoutRefusalCode, string> = {
  conflict:
    'anthropic-auth found two copies of the same account state and stopped using both so a refresh token is never used twice. The log names both files: keep the copy you trust, move the other one away, then restart OpenCode.',
  'moved-elsewhere': `anthropic-auth state for this config folder was moved under another state folder (XDG_STATE_HOME). Restore XDG_STATE_HOME, or run ${RESTORE_LEGACY_COMMAND} with the old XDG_STATE_HOME first. The log names both folders.`,
  'move-unfinished-elsewhere': `An earlier move of anthropic-auth state for this config folder did not finish, and its record is in another state folder. Start again with the XDG_STATE_HOME (and HOME) that were set then, so that move finishes or rolls back; to keep the old layout afterwards, run ${RESTORE_LEGACY_COMMAND} with that same setting. The log names the journal the move set aside.`,
  'other-dataset':
    "anthropic-auth's state folder belongs to another config folder. Check OPENCODE_CONFIG_DIR and any symlink to the config folder; the log names both folders.",
  'marker-unreadable':
    "anthropic-auth can't read the record of where its state is, so it won't use either copy. The log names the file; restore it from a backup or ask for help, and do not delete the state folder.",
  'restore-unfinished': `A restore of anthropic-auth's state did not finish; run ${RESTORE_LEGACY_COMMAND} again.`,
  busy: 'Another anthropic-auth process is moving or restoring state for this folder; start again in a minute.',
  unsafe:
    "anthropic-auth could not finish or undo a change of where its state is, so it won't use either copy. The log names the files involved.",
  'unexpected-data':
    "anthropic-auth's state folder holds files it did not write, so it won't use them. The log names the files.",
  'restore-refused': `anthropic-auth can't restore the old layout yet. Run ${RESTORE_LEGACY_COMMAND} to see what to fix.`,
  'io-failed': `${IO_FAILED_PREFIX} The log names the folder and the error; check its permissions, then restart.`,
}

/** Every refusal code, for readers that check a code they were handed. */
export const STATE_LAYOUT_REFUSAL_CODES = Object.freeze(
  Object.keys(PUBLIC_MESSAGES) as StateLayoutRefusalCode[],
)

/** Whether `value` is one of `STATE_LAYOUT_REFUSAL_CODES`. */
export function isStateLayoutRefusalCode(
  value: unknown,
): value is StateLayoutRefusalCode {
  return (
    typeof value === 'string' &&
    (STATE_LAYOUT_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

/** Every fixed message `stateLayoutRefusalPublicMessage` can return. */
export const STATE_LAYOUT_REFUSAL_PUBLIC_MESSAGES: readonly string[] = [
  ...new Set(Object.values(PUBLIC_MESSAGES)),
]

/** Read the Windows permissions verdict without copying raw error text or invoking getters. */
export function stateLayoutWritableParentDetails(cause: unknown) {
  if (cause === null || typeof cause !== 'object' || utilTypes.isProxy(cause))
    return undefined
  const field = (key: string): unknown =>
    Object.getOwnPropertyDescriptor(cause, key)?.value
  if (
    field('code') !== 'ERR_PRIVATE_FILES_SECURITY' ||
    field('stage') !== 'safe-parent' ||
    field('reason') !== 'writable-by-others'
  )
    return undefined
  const level = field('level')
  const sid = field('sid')
  if (
    typeof level !== 'string' ||
    !win32.isAbsolute(level) ||
    /["\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(level) ||
    typeof sid !== 'string' ||
    !/^S-1-(?:\d+|0x[\dA-Fa-f]+)(?:-\d+)*$/.test(sid)
  )
    return undefined
  const mask = field('mask')
  return {
    level,
    sid,
    ...(typeof mask === 'number' &&
    Number.isInteger(mask) &&
    mask >= 0 &&
    mask <= 0xffffffff
      ? { mask }
      : {}),
  }
}

export function stateLayoutWritableParentAdvice(cause: unknown) {
  const details = stateLayoutWritableParentDetails(cause)
  if (details)
    return `Account ${details.sid} can change "${details.level}". Remove that account's change access from the folder, or set XDG_STATE_HOME to a folder only you can change.`
}

/** The default refusal text, with advice when Windows identifies a writable parent. */
export function stateLayoutRefusalPublicMessage(
  code: StateLayoutRefusalCode,
  refusal?: unknown,
): string {
  if (
    code === 'io-failed' &&
    refusal !== null &&
    typeof refusal === 'object' &&
    !utilTypes.isProxy(refusal)
  ) {
    const advice = stateLayoutWritableParentAdvice(
      Object.getOwnPropertyDescriptor(refusal, 'cause')?.value,
    )
    if (advice) return `${IO_FAILED_PREFIX} ${advice}`
  }
  return PUBLIC_MESSAGES[code]
}

/**
 * A refusal to serve a dataset from either layout. The process must not do
 * any pool I/O for the dataset after it.
 */
export class StateLayoutRefusalError extends Error {
  readonly code: StateLayoutRefusalCode
  /** The files the message names, for logs and diagnostics. */
  readonly paths: readonly string[]

  constructor(
    code: StateLayoutRefusalCode,
    message: string,
    paths: readonly string[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StateLayoutRefusalError'
    this.code = code
    this.paths = Object.freeze([...paths])
  }
}

/**
 * Two copies of the local credentials (or of the migration journal) exist:
 * the moved one in the state folder and an old one in the config folder that
 * changed or reappeared after the move was verified. Using either could spend
 * a single-use refresh token twice, so every process stops serving the
 * dataset until a person keeps one copy.
 */
export function stateLayoutConflict(
  oldPath: string,
  newPath: string,
  cause?: unknown,
): StateLayoutRefusalError {
  return new StateLayoutRefusalError(
    'conflict',
    `anthropic-auth found two copies of the same account state: ${oldPath} (old folder) and ${newPath} (state folder). It stopped using both so a refresh token is never used twice. Keep the copy you trust, move the other one out of both folders, then restart OpenCode.`,
    [oldPath, newPath],
    cause,
  )
}

/**
 * A file system failure while deciding or changing where the state is, such
 * as a lock file that can't be created or a folder that can't be resolved.
 * `what` says what was being done, for the log; the public text is fixed.
 */
export function stateLayoutIoFailure(
  what: string,
  paths: readonly string[],
  cause: unknown,
): StateLayoutRefusalError {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new StateLayoutRefusalError(
    'io-failed',
    `anthropic-auth could not ${what}: ${reason}`,
    paths,
    cause,
  )
}

/** The dataset was moved to a state root other than the one this process uses. */
export function stateLayoutMovedElsewhere(
  configDir: string,
  relocatedTo: string,
  stateRoot: string,
): StateLayoutRefusalError {
  return new StateLayoutRefusalError(
    'moved-elsewhere',
    `anthropic-auth state for ${configDir} was moved to ${relocatedTo}, but this process uses state root ${stateRoot}. Restore XDG_STATE_HOME, or run ${RESTORE_LEGACY_COMMAND} with the old XDG_STATE_HOME first.`,
    [configDir, relocatedTo, stateRoot],
  )
}
