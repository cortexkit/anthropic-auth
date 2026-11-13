import type { LegacySource, MapResult } from '@cortexkit/common-auth/settings'
import type { SettingsValues } from './settings-service.ts'

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
  for (const [source, legacy] of sources.entries()) {
    if (!legacy.present) continue
    const values = legacy.value as Partial<SettingsValues>
    for (const [setting, value] of Object.entries(values)) {
      if (setting === 'killswitch_account_floors') {
        accountSource ??= source
        floors[legacy.host as 'opencode' | 'pi'] =
          values.killswitch_account_floors ?? []
      } else entries.push({ source, setting, value })
    }
  }

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
