import { isDeepStrictEqual } from 'node:util'
import type { SettingsKey } from './settings-definition.ts'
import { SETTINGS_MOVE_PATHS } from './settings-move-source.ts'
import type { SettingsHost } from './settings-paths.ts'
import type { SettingsValues } from './settings-service.ts'

/** Only explicitly stored moved fields warrant a not-imported diagnostic. */
export function holdsMovedSettings(stored: unknown): boolean {
  return Object.values(SETTINGS_MOVE_PATHS).some((path) => {
    let value = stored
    for (const key of path.slice(0, 2)) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
        return false
      value = (value as Record<string, unknown>)[key]
    }
    return true
  })
}

/** Compare account floors for this host only; list order and the peer's entries do not decide its values. */
export function differingLegacySettings(
  legacy: Partial<SettingsValues>,
  resolved: SettingsValues,
  host: SettingsHost,
): SettingsKey[] {
  const floors = (entries: SettingsValues['killswitch_account_floors']) =>
    Object.fromEntries(
      entries
        .filter((entry) => entry.host === host || entry.host === 'both')
        .map(({ account, five_hour, seven_day, scoped }) => [
          account,
          { five_hour, seven_day, scoped },
        ]),
    )
  return (Object.keys(legacy) as SettingsKey[]).filter((key) =>
    key === 'killswitch_account_floors'
      ? Object.entries(floors(legacy[key] ?? [])).some(
          ([account, value]) =>
            !isDeepStrictEqual(value, floors(resolved[key])[account]),
        )
      : !isDeepStrictEqual(legacy[key], resolved[key]),
  )
}

export function settingsNotImportedText(
  source: string,
  target: string,
  differing?: readonly SettingsKey[],
) {
  return `Legacy settings in "${source}" were not imported into "${target}"; the user settings file is authoritative.${differing?.length ? ` Differing settings: ${differing.join(', ')}.` : ''}`
}
