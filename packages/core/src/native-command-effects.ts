import { logger, parseLogLevel, setLogLevel } from './logger.ts'

/**
 * In-process effects of a committed native account or settings change.
 *
 * NativeAccountRuntime calls these after its write has been committed, and
 * only when that write changed what was stored. Every host's /claude actions
 * therefore emit the same INFO records and apply the same live logger level,
 * while a refused, failed or no-op change has no effect at all. Payloads carry
 * route ids, labels and setting values only, never credential material.
 */

type Settings = Record<string, unknown>

function section(settings: Settings, key: string): Record<string, unknown> {
  const value = settings[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The setting values whose changes have effects, read before a settings mutator can edit its copy. */
export interface NativeSettingsEffectFields {
  killswitchEnabled: boolean
  killswitchMain: string | undefined
  killswitchAccounts: string | undefined
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
    killswitchMain: JSON.stringify(killswitch.main),
    killswitchAccounts: JSON.stringify(killswitch.accounts),
    logLevel: typeof level === 'string' ? level : undefined,
  }
}

/**
 * Log the killswitch and logging-level changes between the settings before a
 * committed write and the settings that write left on disk, then apply a
 * changed logging level to this process's logger.
 */
export function applyCommittedNativeSettingsEffects(
  before: NativeSettingsEffectFields,
  committed: Settings,
): void {
  const after = captureNativeSettingsEffectFields(committed)
  const killswitch = section(committed, 'killswitch')
  if (after.killswitchEnabled !== before.killswitchEnabled)
    logger.info('commands', 'killswitch changed', {
      enabled: after.killswitchEnabled,
    })
  if (
    after.killswitchMain !== before.killswitchMain ||
    after.killswitchAccounts !== before.killswitchAccounts
  )
    logger.info('commands', 'killswitch thresholds changed', {
      thresholds: killswitch.main ?? killswitch.accounts,
    })
  const level = parseLogLevel(after.logLevel)
  if (level && level !== parseLogLevel(before.logLevel)) {
    // Recorded at the previous level, so lowering verbosity (for example to
    // warn) still leaves a record of the change in the log.
    logger.info('commands', 'log level changed', { level })
    setLogLevel(level)
  }
}

export type NativeAccountChange =
  | 'account enabled'
  | 'account disabled'
  | 'account removed'
  | 'account reordered'

/**
 * Log one committed change to an account row, identified by route id and
 * label. A reorder whose caller did not name the moved account has no id.
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
 * Log an account row a committed add created. The payload names the route,
 * its label and the credential kind ('apikey' or 'oauth'), never the
 * credential, its endpoint or its headers.
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
