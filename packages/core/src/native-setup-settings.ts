import { isDeepStrictEqual } from 'node:util'
import {
  type SettingsEdit,
  SettingsRefusal,
} from '@cortexkit/common-auth/settings'
import { parse } from 'jsonc-parser'
import { logger } from './logger.ts'
import {
  splitNativeMigrationSettings,
  validateNativeMigrationSettings,
} from './native-migration-source.ts'
import {
  invalidSettingsWriteText,
  malformedSettingsText,
  SETTINGS_WRITE_FAILURES,
  type SettingsKey,
} from './settings-definition.ts'
import {
  resolveSettingsMode,
  type SettingsModeOptions,
  writeSettingsMoveMarker,
} from './settings-mode.ts'
import { readSettingsMoveSource } from './settings-move-source.ts'
import {
  resolveSettingsPaths,
  type SettingsHost,
  type SettingsPathOptions,
  type SettingsPaths,
} from './settings-paths.ts'
import {
  openSettingsService,
  SETTINGS_PROTECTION_KEYS,
  type SettingsProtectionRecovery,
  SettingsRecreationRefusal,
  type SettingsValues,
} from './settings-service.ts'

export interface NativeSetupSettingsDifference {
  key: SettingsKey
  account?: string
  legacy: unknown
  file: unknown
  note?: string
}

export interface NativeSetupSettingsResult {
  target: 'legacy-store' | 'user-file'
  outcome: 'saved' | 'refused' | 'failed'
  reason?: string
  skipped: SettingsKey[]
  differing: NativeSetupSettingsDifference[]
}

export interface NativeSetupSettingsOptions extends SettingsPathOptions {
  host: SettingsHost
  /** Raw legacy fields captured before retirement, never a resolved settings record. */
  settings: Record<string, unknown>
  source: string
  paths?: SettingsPaths
  authority?: SettingsModeOptions
  /** Use the acting host's selected local or vault store and its normal writer lock. */
  writeLegacySettings: (settings: Record<string, unknown>) => Promise<void>
  /** Startup recovery; readLegacyProtection reads this host's active local or vault settings store. */
  protection?: SettingsProtectionRecovery
  log?: { warn(message: string): void }
}

type AccountFloor = SettingsValues['killswitch_account_floors'][number]
const thresholds = ({ five_hour, seven_day, scoped }: AccountFloor) => ({
  five_hour,
  seven_day,
  scoped,
})

/**
 * Called only after credential commit, while hosts are stopped. Decide authority
 * once per attempt (including resume), never run startup's one-time settings
 * migration, and fill only missing user-file values. Legacy writes receive raw legacy fields, not a projection.
 */
export async function writeNativeSetupSettings(
  options: NativeSetupSettingsOptions,
): Promise<NativeSetupSettingsResult> {
  const paths =
    options.paths ?? (await resolveSettingsPaths(options.host, options))
  const mode = await resolveSettingsMode(paths, options.authority)
  const result: NativeSetupSettingsResult = {
    target: mode === 'user-file' ? 'user-file' : 'legacy-store',
    outcome: 'saved',
    skipped: [],
    differing: [],
  }
  const warn = (message: string) => {
    if (options.log) options.log.warn(message)
    else logger.warn('settings', message)
  }
  let service: Awaited<ReturnType<typeof openSettingsService>>
  try {
    // Reject the resolved record's "default"/"on"/"off" values even on the
    // legacy branch: released versions understand only booleans in their stores.
    validateNativeMigrationSettings(options.settings)
    const { moved } = splitNativeMigrationSettings(options.settings)
    if (mode !== 'user-file') {
      if (Object.keys(moved).length) await options.writeLegacySettings(moved)
      return result
    }
    service = await openSettingsService({
      file: paths.target,
      host: options.host,
      protection: options.protection,
    })
    if (!service) throw new Error('Settings service did not open')
    const generation = service.snapshot()
    if (
      generation.status === 'unparseable' ||
      generation.fileStatus.duplicateKeys.length
    ) {
      return {
        ...result,
        outcome: 'refused',
        reason: malformedSettingsText(paths.target),
      }
    }
    if (generation.status === 'unreadable')
      return {
        ...result,
        outcome: 'failed',
        reason: SETTINGS_WRITE_FAILURES['settings-unavailable'].text(
          paths.target,
        ),
      }
    const missing = generation.status === 'missing'
    if (!missing) await writeSettingsMoveMarker(paths.target, options.authority)
    const values = readSettingsMoveSource(JSON.stringify(moved), {
      host: options.host,
      path: options.source,
      log: { warn },
    })
    const raw: Record<string, unknown> = generation.source
      ? (parse(generation.source.replace(/^\uFEFF/, ''), [], {
          allowTrailingComma: true,
        }) ?? {})
      : {}
    const edits: SettingsEdit[] = []
    let importFloors: AccountFloor[] | undefined
    const skip = (
      key: SettingsKey,
      legacy: unknown,
      held: unknown,
      account?: string,
    ) => {
      if (!result.skipped.includes(key)) {
        result.skipped.push(key)
        warn(
          `Setup skipped setting "${key}" in "${paths.target}": ${missing ? 'the carried protection set' : 'the user settings file'} already supplies it for ${options.host}.`,
        )
      }
      if (!isDeepStrictEqual(legacy, held))
        result.differing.push({
          key,
          ...(account === undefined ? {} : { account }),
          legacy,
          file: held,
        })
    }
    for (const key of Object.keys(values) as SettingsKey[]) {
      const value = values[key]
      if (
        missing &&
        (SETTINGS_PROTECTION_KEYS as readonly string[]).includes(key)
      ) {
        if (key === 'killswitch_account_floors') {
          const floors = generation.protection[options.host].values[key]
          if (!values[key]?.length) skip(key, [], [])
          for (const entry of values[key] ?? []) {
            const held = floors.find(
              (existing) =>
                existing.account === entry.account &&
                (existing.host === options.host || existing.host === 'both'),
            )
            skip(
              key,
              thresholds(entry),
              held && thresholds(held),
              entry.account,
            )
          }
          continue
        }
        skip(
          key,
          value,
          generation.protection[options.host].values[
            key as (typeof SETTINGS_PROTECTION_KEYS)[number]
          ],
        )
        continue
      }
      if (key === 'killswitch_account_floors') {
        if (generation.report.some((entry) => entry.keyPath[0] === key))
          return {
            ...result,
            outcome: 'refused',
            reason: invalidSettingsWriteText(key, paths.target),
          }
        importFloors = values[key] ?? []
        continue
      }
      const levels = generation.fileLevels[key] ?? []
      if (levels.includes('default') || levels.includes(options.host)) {
        const held = raw[key]
        skip(
          key,
          value,
          held && typeof held === 'object' && !Array.isArray(held)
            ? (held as Record<string, unknown>)[
                levels.includes(options.host) ? options.host : 'default'
              ]
            : held,
        )
      } else {
        edits.push({
          setting: key,
          value,
          ...(options.host === 'pi' ? { level: 'pi' as const } : {}),
        })
      }
    }
    // The service carries the whole applied protection set in this same edit.
    // Imported protection was omitted above so a stale source cannot replace it.
    if (
      edits.length ||
      importFloors?.length ||
      (missing && Object.keys(values).length)
    )
      await service.update(
        (current, carry) => {
          if (!importFloors?.length) return edits
          const key = 'killswitch_account_floors'
          const floors =
            current.status === 'ready'
              ? ((current.document as Record<string, unknown>)[key] ?? [])
              : (carry?.find((edit) => edit.setting === key)?.value ?? [])
          if (!Array.isArray(floors))
            throw new SettingsRefusal(
              'settings-invalid-value',
              'Account floors are not a list',
            )
          const appended: AccountFloor[] = []
          for (const entry of importFloors) {
            const held = (floors as AccountFloor[]).find(
              (existing) =>
                existing.account === entry.account &&
                (existing.host === options.host || existing.host === 'both'),
            )
            if (held)
              skip(key, thresholds(entry), thresholds(held), entry.account)
            else appended.push({ ...entry, host: options.host })
          }
          return appended.length
            ? [...edits, { setting: key, value: [...floors, ...appended] }]
            : edits
        },
        options.host,
        { createMissing: missing, hostsStopped: true },
      )
    return result
  } catch (error) {
    if (error instanceof SettingsRecreationRefusal)
      return { ...result, outcome: 'refused', reason: error.message }
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : ''
    const failure =
      SETTINGS_WRITE_FAILURES[code as keyof typeof SETTINGS_WRITE_FAILURES] ??
      SETTINGS_WRITE_FAILURES['settings-unavailable']
    return {
      ...result,
      outcome: failure.outcome,
      reason: failure.text(paths.target),
    }
  } finally {
    await service?.dispose()
  }
}
