import type { LegacySource, MapResult } from '@cortexkit/common-auth/settings'
import {
  KILLSWITCH_FLOOR_KEYS,
  settingsProtectionStricter,
} from './settings-host-import.ts'
import { legacySettingsProtection } from './settings-protection-legacy.ts'
import {
  SETTINGS_PROTECTION_KEYS,
  type SettingsValues,
} from './settings-service.ts'

type AccountFloor = SettingsValues['killswitch_account_floors'][number]

/**
 * Map validated readSettingsMoveSource results, with at most one source per host.
 * OpenCode must precede Pi: common-auth uses the first source's value as default.
 * Ordinary settings stay whole so common-auth can preserve each host's value.
 */
export function mapSettingsMoveSources(sources: LegacySource[]): MapResult {
  const seen = new Set<string>()
  for (const source of sources) {
    if (source.host !== 'opencode' && source.host !== 'pi')
      throw new TypeError(`Unknown settings move host: ${source.host}`)
    if (seen.has(source.host))
      throw new TypeError(`Duplicate settings move host: ${source.host}`)
    if (source.host === 'opencode' && seen.has('pi'))
      throw new TypeError('Settings move sources must put OpenCode before Pi')
    seen.add(source.host)
  }

  const entries: MapResult['entries'] = []
  const floors: Record<'opencode' | 'pi', AccountFloor[]> = {
    opencode: [],
    pi: [],
  }
  let accountSource: number | undefined
  // Floors protect only while the killswitch is on. A host whose killswitch
  // was off stored floors that held no account back; once another source's
  // killswitch is on they would become live protection (this host inherits
  // that `on`, and a first source's floors become the default the other host
  // inherits), so they are not carried. When every source is off they stay
  // as stored, protecting no one.
  const live = sources.some(killswitchOn)
  for (const [source, legacy] of sources.entries()) {
    if (!legacy.present) continue
    const dropFloors = live && !killswitchOn(legacy)
    const values = legacy.value as Partial<SettingsValues>
    for (const [setting, value] of Object.entries(values)) {
      if (
        dropFloors &&
        (KILLSWITCH_FLOOR_KEYS.has(setting) ||
          setting === 'killswitch_account_floors')
      )
        continue
      if (setting === 'killswitch_account_floors') {
        accountSource ??= source
        floors[legacy.host as 'opencode' | 'pi'] =
          values.killswitch_account_floors ?? []
      } else entries.push({ source, setting, value })
    }
  }
  entries.push(...keepImplicitProtection(sources, entries))

  if (accountSource !== undefined) {
    const pi = new Map(floors.pi.map((entry) => [entry.account, entry]))
    const accounts: AccountFloor[] = floors.opencode.map((entry) => {
      const peer = pi.get(entry.account)
      // Local row ids belong to their host, even when both stores use the same id.
      if (
        entry.account.startsWith('vault:') &&
        peer &&
        entry.five_hour === peer.five_hour &&
        entry.seven_day === peer.seven_day &&
        entry.scoped === peer.scoped
      ) {
        pi.delete(entry.account)
        return { ...entry, host: 'both' }
      }
      return { ...entry, host: 'opencode' }
    })
    accounts.push(
      ...[...pi.values()].map((entry) => ({ ...entry, host: 'pi' as const })),
    )
    // Account floors allow no host override; giving common-auth two lists would discard one host's entries.
    entries.push({
      source: accountSource,
      setting: 'killswitch_account_floors',
      value: accounts,
    })
  }
  return { entries, unmapped: [] }
}

/** A source's effective legacy killswitch: its stored value, or its reader's default. */
function killswitchOn(legacy: LegacySource): boolean {
  if (!legacy.present) return false
  return (
    ((legacy.value as Partial<SettingsValues>).killswitch_enabled ??
      legacySettingsProtection({}, legacy.host as 'opencode' | 'pi')
        .killswitch_enabled) === true
  )
}

/**
 * common-auth publishes a value only one source stores as the top-level value
 * both hosts inherit. A host that stores no value for a protection key still
 * had one: the implicit default its legacy reader applied (killswitch floors
 * 5/10/0, fail-closed on unknown quota, a 15-minute same-account wait). When
 * that default protects more than the value the host would inherit, carry it
 * as this host's own value, so common-auth keeps it at the host's level (or
 * as the default, with the other host's value at its level) and no host
 * leaves the move weaker than its legacy store left it. A source with no
 * store has no legacy settings and inherits as before. Killswitch floors
 * are carried only from a source whose killswitch was on.
 */
function keepImplicitProtection(
  sources: LegacySource[],
  entries: MapResult['entries'],
): MapResult['entries'] {
  const added: MapResult['entries'] = []
  for (const setting of SETTINGS_PROTECTION_KEYS) {
    if (setting === 'killswitch_account_floors') continue
    // common-auth makes the lowest-numbered source's value the default.
    const inherited = entries
      .filter((entry) => entry.setting === setting)
      .sort((a, b) => a.source - b.source)[0]
    if (!inherited) continue
    for (const [source, legacy] of sources.entries()) {
      if (!legacy.present) continue
      if (
        entries.some(
          (entry) => entry.source === source && entry.setting === setting,
        )
      )
        continue
      const implicit = legacySettingsProtection(
        {},
        legacy.host as 'opencode' | 'pi',
      )[setting]
      // Killswitch floors protect only while the killswitch is on: a host
      // whose killswitch was off held no account back, so its default
      // floors are no protection to carry.
      if (KILLSWITCH_FLOOR_KEYS.has(setting) && !killswitchOn(legacy)) continue
      if (settingsProtectionStricter(setting, implicit, inherited.value))
        added.push({ source, setting, value: implicit })
    }
  }
  return added
}
