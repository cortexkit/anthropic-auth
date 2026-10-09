import {
  getLogLevel,
  type LogLevel,
  logger,
  parseLogLevel,
  setLogLevel,
} from './logger.ts'

/**
 * In-process effects of a committed native account or settings change.
 *
 * NativeAccountRuntime calls these logging and live-level helpers after its
 * write has been committed. Account
 * and settings effects follow only from what that write changed, so every
 * host's /claude actions emit the same INFO records, and a refused or failed
 * write has no effect. The one exception to "unchanged means no effect" is the
 * explicit logging-level command (NativeAccountRuntime.setLoggingLevel): when
 * its stored level is already the requested one, it still sets this process's
 * live logger level if that differs. Payloads carry account ids, labels and
 * setting values only, never credential material.
 */

type Settings = Record<string, unknown>

function section(settings: Settings, key: string): Record<string, unknown> {
  const value = settings[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The threshold fields a killswitch entry may hold (see KillswitchThresholds). */
const THRESHOLD_FIELDS = ['five_hour', 'seven_day', '5h', '1w', 'scoped']

/**
 * Copy only the finite numeric threshold fields of one killswitch entry.
 * Settings are user-editable JSON, so anything else stored beside the
 * thresholds never reaches a log record.
 */
function projectThresholds(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const entry = value as Record<string, unknown>
  const projected: Record<string, number> = {}
  for (const field of THRESHOLD_FIELDS) {
    const number = entry[field]
    if (typeof number === 'number' && Number.isFinite(number))
      projected[field] = number
  }
  return projected
}

/** Per-account threshold entries keyed by account id, each projected as above. */
function projectAccountThresholds(
  value: unknown,
): Record<string, Record<string, number>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const projected: Record<string, Record<string, number>> = {}
  for (const [id, entry] of Object.entries(value)) {
    const thresholds = projectThresholds(entry)
    if (thresholds) projected[id] = thresholds
  }
  return projected
}

/** The setting values whose changes have effects, read before a settings mutator can edit its copy. */
export interface NativeSettingsEffectFields {
  killswitchEnabled: boolean
  killswitchMain: Record<string, number> | undefined
  killswitchAccounts: Record<string, Record<string, number>> | undefined
  logLevel: string | undefined
}

export function captureNativeSettingsEffectFields(
  settings: Settings,
): NativeSettingsEffectFields {
  const killswitch = section(settings, 'killswitch')
  const level = section(settings, 'logging').level
  return {
    // A missing flag reads as disabled, so writing an explicit `false` over
    // it is not reported as a change.
    killswitchEnabled: killswitch.enabled === true,
    killswitchMain: projectThresholds(killswitch.main),
    killswitchAccounts: projectAccountThresholds(killswitch.accounts),
    logLevel: typeof level === 'string' ? level : undefined,
  }
}

/**
 * Log the killswitch and logging-level changes between the settings before a
 * committed write and the settings that write left on disk, then apply a
 * changed stored logging level to this process's logger. Threshold changes
 * are compared and logged through the numeric projection only.
 */
export function applyCommittedNativeSettingsEffects(
  before: NativeSettingsEffectFields,
  committed: Settings,
): void {
  const after = captureNativeSettingsEffectFields(committed)
  if (after.killswitchEnabled !== before.killswitchEnabled)
    logger.info('commands', 'killswitch changed', {
      enabled: after.killswitchEnabled,
    })
  if (
    JSON.stringify(after.killswitchMain) !==
      JSON.stringify(before.killswitchMain) ||
    JSON.stringify(after.killswitchAccounts) !==
      JSON.stringify(before.killswitchAccounts)
  )
    logger.info('commands', 'killswitch thresholds changed', {
      thresholds: after.killswitchMain ?? after.killswitchAccounts,
    })
  const level = parseLogLevel(after.logLevel)
  if (level && level !== parseLogLevel(before.logLevel))
    applyNativeLogLevel(level)
}

/**
 * Make `level` this process's live logger level when it is not already, and
 * record the change. The INFO record is emitted before the new level is
 * applied, so it is filtered by the level in force until then: changing from
 * info to warn leaves the record in the log, while changing from warn or error
 * to info emits none. Returns whether the live level changed.
 */
export function applyNativeLogLevel(level: LogLevel): boolean {
  if (getLogLevel() === level) return false
  logger.info('commands', 'log level changed', { level })
  setLogLevel(level)
  return true
}

export type NativeAccountChange =
  | 'account enabled'
  | 'account disabled'
  | 'account removed'
  | 'account reordered'

/**
 * Log one committed change to an account, identified by its account id and
 * label. A reorder whose caller did not say which account it moved is logged
 * without an id.
 */
export function logCommittedNativeAccountChange(
  change: NativeAccountChange,
  account: { id?: string; label?: string },
): void {
  logger.info('commands', change, {
    id: account.id,
    label: account.label,
    ...(change === 'account enabled' || change === 'account disabled'
      ? { enabled: change === 'account enabled' }
      : {}),
  })
}

/**
 * Log an account that a committed add created. The payload holds the account
 * id, its label and the credential kind ('apikey' or 'oauth'); it never holds
 * the credential, its base URL or its auth header.
 */
export function logCommittedNativeAccountAdded(account: {
  id: string
  label?: string
  type: 'oauth' | 'api'
}): void {
  logger.info('commands', 'account added', {
    id: account.id,
    label: account.label,
    type: account.type === 'api' ? 'apikey' : 'oauth',
  })
}
