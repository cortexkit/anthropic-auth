import type { SettingsHost } from './settings-paths.ts'
import {
  SETTINGS_PROTECTION_KEYS,
  type SettingsFileLevels,
  type SettingsLevelEdit,
  type SettingsProtectionValues,
} from './settings-service.ts'

type ProtectionKey = (typeof SETTINGS_PROTECTION_KEYS)[number]

/** Higher ranks protect more; values not listed rank lowest. */
const ranks: Partial<Record<ProtectionKey, Record<string, number>>> = {
  // Core treats an unset choice as fail-closed, but OpenCode 1's own checks do not.
  quota_fail_closed_on_unknown_quota: { off: 0, default: 1, on: 2 },
  max_same_account_wait: { cache: 0, '15m': 1, off: 2 },
}

/** True when `legacy` protects more than `file` for one scalar protection key. */
function stricter(key: ProtectionKey, legacy: unknown, file: unknown): boolean {
  if (typeof legacy === 'boolean') return legacy && file === false
  if (typeof legacy === 'number')
    return typeof file === 'number' && legacy > file
  const rank = ranks[key]
  if (!rank || typeof legacy !== 'string' || typeof file !== 'string')
    return false
  return (rank[legacy] ?? 0) > (rank[file] ?? 0)
}

/**
 * The import a host owes the settings file when its legacy store was never
 * imported: for each protection key the file sets for this host no value of
 * its own (fill-only), the host's legacy value where it protects more than
 * what the host now resolves from the file. A pure function of the host's
 * legacy set, its resolved set and the file's explicit levels.
 *
 * `edits` writes those values at the host's own level; account floors need
 * no level, since each list entry names its host. The caller verifies that
 * the validated protection fields still match the document under the lock
 * before returning these edits from its writer plan.
 */
export function planSettingsHostImport(input: {
  host: SettingsHost
  legacy: SettingsProtectionValues
  resolved: SettingsProtectionValues
  fileLevels: SettingsFileLevels
}): { keys: ProtectionKey[]; edits: SettingsLevelEdit[] } {
  const { host, legacy, resolved } = input
  const keys: ProtectionKey[] = []
  const edits: SettingsLevelEdit[] = []
  for (const key of SETTINGS_PROTECTION_KEYS) {
    if (key === 'killswitch_account_floors') continue
    if (input.fileLevels[key]?.includes(host)) continue
    if (!stricter(key, legacy[key], resolved[key])) continue
    keys.push(key)
    edits.push({ setting: key, level: host, value: legacy[key] })
  }
  // An account the file gives this host no floor for uses the file's
  // default thresholds; a legacy floor above them is protection to keep.
  const covered = new Set(
    resolved.killswitch_account_floors
      .filter((entry) => entry.host === host || entry.host === 'both')
      .map((entry) => entry.account),
  )
  const missing = legacy.killswitch_account_floors.filter(
    (entry) =>
      (entry.host === host || entry.host === 'both') &&
      !covered.has(entry.account) &&
      (entry.five_hour > resolved.killswitch_default_five_hour ||
        entry.seven_day > resolved.killswitch_default_seven_day ||
        entry.scoped > resolved.killswitch_default_scoped),
  )
  if (missing.length) {
    keys.push('killswitch_account_floors')
    edits.push({
      setting: 'killswitch_account_floors',
      value: [
        ...resolved.killswitch_account_floors,
        ...missing.map((entry) => ({ ...entry, host })),
      ],
    })
  }
  return { keys, edits }
}
