import {
  type AccountStorage,
  getKillswitchThresholdsForAccount,
  getQuotaMinimumRemainingThresholds,
  isKillswitchEnabled,
  normalizeKillswitchThresholds,
} from './accounts.ts'
import { nativeAccountSettings } from './native-account-view.ts'
import { readNativeEnrollmentMode } from './native-enrollment-authority.ts'
import type { createNativePoolStore } from './pool-store.ts'
import { getMaxSameAccountWait } from './routing.ts'
import type { SettingsHost } from './settings-paths.ts'
import type { SettingsProtectionValues } from './settings-service.ts'
import { toThreeWay } from './settings-three-way.ts'

type EnrollmentMode = 'local' | 'claustrum'
type SettingsStore = Pick<
  ReturnType<typeof createNativePoolStore>,
  'readSettings'
>

export interface LegacySettingsProtectionOptions {
  host: SettingsHost
  env?: NodeJS.ProcessEnv
  localStore: SettingsStore
  vaultStore: SettingsStore
  /** Use the runtime's own vault initialization, including its one-time legacy seeding. */
  initializeVaultSettings: () => Promise<void>
  readMode?: (
    host: SettingsHost,
    env: NodeJS.ProcessEnv,
  ) => Promise<EnrollmentMode>
}

/** Preserve legacy reader behavior rather than validating an old store as a new settings file. */
export function legacySettingsProtection(
  settings: Record<string, unknown>,
  host: SettingsHost,
  mode: EnrollmentMode = 'local',
): SettingsProtectionValues {
  const storage = {
    version: 1,
    accounts: [],
    ...nativeAccountSettings(settings),
  } as AccountStorage
  const main = getKillswitchThresholdsForAccount(storage)
  const minimum = getQuotaMinimumRemainingThresholds(storage)
  return {
    killswitch_enabled: isKillswitchEnabled(storage),
    killswitch_default_five_hour: main.five_hour,
    killswitch_default_seven_day: main.seven_day,
    killswitch_default_scoped: main.scoped,
    killswitch_account_floors: Object.keys(
      storage.killswitch?.accounts ?? {},
    ).map((account) => ({
      account,
      host: mode === 'claustrum' ? 'both' : host,
      ...getKillswitchThresholdsForAccount(storage, account),
    })),
    quota_minimum_remaining_five_hour: minimum.five_hour,
    quota_minimum_remaining_seven_day: minimum.seven_day,
    quota_minimum_remaining_scoped: normalizeKillswitchThresholds(
      storage.quota?.minimumRemaining,
    ).scoped,
    // Core's policy defaults to fail-closed; OpenCode 1's direct checks do not.
    // Keep absence as "default" so both retain those readings.
    quota_fail_closed_on_unknown_quota: toThreeWay(
      storage.quota?.failClosedOnUnknownQuota,
    ),
    max_same_account_wait: {
      '0': 'off',
      '15': '15m',
      max: 'cache',
    }[
      getMaxSameAccountWait(storage)
    ] as SettingsProtectionValues['max_same_account_wait'],
  }
}

/**
 * Read the store selected by this runtime's enrollment mode. An unreadable mode,
 * failed vault initialization or unsuccessful store read returns no recovery values.
 */
export async function readLegacySettingsProtection(
  options: LegacySettingsProtectionOptions,
): Promise<SettingsProtectionValues | undefined> {
  try {
    const mode = await (options.readMode ?? readNativeEnrollmentMode)(
      options.host,
      options.env ?? process.env,
    )
    if (mode === 'claustrum') await options.initializeVaultSettings()
    const store = mode === 'claustrum' ? options.vaultStore : options.localStore
    const read = await store.readSettings()
    if (read.status !== 'ready') return undefined
    return legacySettingsProtection(read.settings, options.host, mode)
  } catch {
    return undefined
  }
}
