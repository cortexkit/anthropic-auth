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
  KILLSWITCH_FLOOR_KEYS,
  planSettingsHostImport,
} from './settings-host-import.ts'
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
import { legacySettingsProtection } from './settings-protection-legacy.ts'
import {
  openSettingsService,
  SETTINGS_PROTECTION_KEYS,
  type SettingsGeneration,
  type SettingsProtectionRecovery,
  type SettingsProtectionValues,
  SettingsRecreationRefusal,
  type SettingsValues,
  type SettingsWriteState,
  settingsFileLevels,
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

type ProtectionKey = (typeof SETTINGS_PROTECTION_KEYS)[number]
const protectionKeys = new Set<string>(SETTINGS_PROTECTION_KEYS)

/** How many times setup re-plans after protection changes under it. */
const SETUP_WRITE_ATTEMPTS = 3

/**
 * Thrown from the locked writer plan when the file's protection fields no
 * longer match the generation the plan compared against; setup refreshes and
 * plans again.
 */
class SetupProtectionChanged extends Error {}

/** A legacy value setup did not write, kept for the report after the write. */
interface SetupSkip {
  key: SettingsKey
  legacy: unknown
  held: unknown
  account?: string
  /** The value came from the protection set carried into a missing file. */
  carried: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The parsed document a generation was resolved from. */
function documentOf(generation: SettingsGeneration): Record<string, unknown> {
  const raw = generation.source
    ? parse(generation.source.replace(/^\uFEFF/, ''), [], {
        allowTrailingComma: true,
      })
    : {}
  return record(raw) ? raw : {}
}

/**
 * What one host resolves from the protection edits a recreation carries:
 * the plain or default-level values, with that host's own level on top.
 */
function carriedProtection(
  carry: readonly SettingsEdit[],
  host: SettingsHost,
): SettingsProtectionValues {
  const values: Record<string, unknown> = {}
  for (const edit of carry)
    if (!edit.level || edit.level === 'default')
      values[edit.setting] = edit.value
  for (const edit of carry)
    if (edit.level === host) values[edit.setting] = edit.value
  return values as SettingsProtectionValues
}

/**
 * Setup's edits for one state of the user file, as a pure function of it.
 * An ordinary setting is filled only where the file sets no value at the
 * default or this host's level. A protection setting the file doesn't
 * mention at all is filled the same way. Otherwise, as at a later host's
 * first start, the legacy value is written at this host's level only where
 * it protects more than what the host resolves from the file (or from the
 * carried set, for a missing file) and the file holds no value of the
 * host's own. A missing account floor is appended to an existing file; into
 * a missing file only where it is above the carried default thresholds.
 *
 * For an existing file the comparison uses `snapshot`'s resolution, so the
 * plan throws `SetupProtectionChanged` when the file's protection fields
 * no longer match it.
 */
function planSetupEdits(input: {
  host: SettingsHost
  values: Partial<SettingsValues>
  legacy: SettingsProtectionValues
  current: SettingsWriteState
  carry?: readonly SettingsEdit[]
  snapshot: SettingsGeneration
}): { edits: SettingsEdit[]; skips: SetupSkip[] } {
  const { host, values, legacy, current, snapshot } = input
  const missing = current.status === 'missing'
  const document =
    current.status === 'ready' && record(current.document)
      ? current.document
      : {}
  let resolved: SettingsProtectionValues
  if (missing)
    // Before the lock there is no carry yet; the writer's applied set is
    // what it will carry for this host.
    resolved = input.carry
      ? carriedProtection(input.carry, host)
      : snapshot.protection[host].values
  else {
    const expected = snapshot.status === 'ready' ? documentOf(snapshot) : {}
    if (
      snapshot.status !== 'ready' ||
      SETTINGS_PROTECTION_KEYS.some(
        (key) => !isDeepStrictEqual(document[key], expected[key]),
      )
    )
      throw new SetupProtectionChanged()
    resolved = snapshot.protection[host].values
  }
  const levels = missing ? {} : settingsFileLevels(document)
  const held = (key: SettingsKey) => {
    const value = document[key]
    if (!record(value)) return value
    return value[levels[key]?.includes(host) ? host : 'default']
  }
  const fill = (key: SettingsKey, value: unknown): SettingsEdit => ({
    setting: key,
    value,
    ...(host === 'pi' ? { level: 'pi' as const } : {}),
  })
  const edits: SettingsEdit[] = []
  const skips: SetupSkip[] = []
  const skip = (
    key: SettingsKey,
    legacyValue: unknown,
    heldValue: unknown,
    account?: string,
  ) =>
    skips.push({
      key,
      legacy: legacyValue,
      held: heldValue,
      ...(account === undefined ? {} : { account }),
      carried: missing,
    })
  const imported = planSettingsHostImport({
    host,
    legacy,
    resolved,
    fileLevels: levels,
  })
  // Floors protect only while the killswitch is on. This host's stored floors
  // held no account back if its legacy killswitch was off; when the file has
  // the killswitch on for any host they would become live protection (this
  // host's, or the other host's through the default level), so they are
  // reported as not written instead of filled.
  const dropFloors =
    !legacy.killswitch_enabled &&
    (resolved.killswitch_enabled ||
      (['opencode', 'pi'] as const).some(
        (each) => snapshot.protection[each].values.killswitch_enabled,
      ))
  const filled = new Set<SettingsKey>()
  for (const key of Object.keys(values) as SettingsKey[]) {
    if (key === 'killswitch_account_floors') continue
    const value = values[key]
    const keyLevels = levels[key] ?? []
    if (dropFloors && KILLSWITCH_FLOOR_KEYS.has(key))
      skip(key, value, resolved[key as ProtectionKey])
    else if (!keyLevels.length && !(missing && protectionKeys.has(key))) {
      filled.add(key)
      edits.push(fill(key, value))
    } else if (protectionKeys.has(key)) {
      // A stricter value is imported below; a weaker one yields to the file.
      if (!imported.keys.includes(key as ProtectionKey))
        skip(key, value, missing ? resolved[key as ProtectionKey] : held(key))
    } else if (keyLevels.includes('default') || keyLevels.includes(host))
      skip(key, value, held(key))
    else {
      filled.add(key)
      edits.push(fill(key, value))
    }
  }
  for (const edit of imported.edits)
    if (
      edit.setting !== 'killswitch_account_floors' &&
      !filled.has(edit.setting as SettingsKey)
    )
      edits.push(edit)
  const floorsKey = 'killswitch_account_floors'
  const legacyFloors = values[floorsKey]
  if (legacyFloors === undefined) return { edits, skips }
  const own = (entry: AccountFloor) =>
    entry.host === host || entry.host === 'both'
  if (missing) {
    const carriedFloors = resolved.killswitch_account_floors
    const importedFloors = imported.edits.find(
      (edit) => edit.setting === floorsKey,
    )?.value as AccountFloor[] | undefined
    const appended = new Set(
      (importedFloors ?? [])
        .slice(carriedFloors.length)
        .map((entry) => entry.account),
    )
    if (importedFloors)
      edits.push({ setting: floorsKey, value: importedFloors })
    if (!legacyFloors.length) skip(floorsKey, [], [])
    for (const entry of legacyFloors) {
      if (appended.has(entry.account)) continue
      const kept = carriedFloors.find(
        (existing) => existing.account === entry.account && own(existing),
      )
      skip(
        floorsKey,
        thresholds(entry),
        kept && thresholds(kept),
        entry.account,
      )
    }
    return { edits, skips }
  }
  const floors = document[floorsKey] ?? []
  if (!Array.isArray(floors))
    throw new SettingsRefusal(
      'settings-invalid-value',
      'Account floors are not a list',
    )
  const appended: AccountFloor[] = []
  for (const entry of legacyFloors) {
    const kept = (floors as AccountFloor[]).find(
      (existing) => existing.account === entry.account && own(existing),
    )
    if (kept || dropFloors)
      skip(
        floorsKey,
        thresholds(entry),
        kept && thresholds(kept),
        entry.account,
      )
    else appended.push({ ...entry, host })
  }
  if (appended.length)
    edits.push({ setting: floorsKey, value: [...floors, ...appended] })
  return { edits, skips }
}

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
    const skip = ({ key, legacy, held, account, carried }: SetupSkip) => {
      if (!result.skipped.includes(key)) {
        result.skipped.push(key)
        warn(
          `Setup skipped setting "${key}" in "${paths.target}": ${carried ? 'the carried protection set' : 'the user settings file'} already supplies it for ${options.host}.`,
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
    // Protection is compared by effective value, including implicit defaults
    // the legacy store never wrote, such as an enabled killswitch's floors.
    const legacy = legacySettingsProtection(moved, options.host)
    if (
      !missing &&
      values.killswitch_account_floors !== undefined &&
      generation.report.some(
        (entry) => entry.keyPath[0] === 'killswitch_account_floors',
      )
    )
      return {
        ...result,
        outcome: 'refused',
        reason: invalidSettingsWriteText(
          'killswitch_account_floors',
          paths.target,
        ),
      }
    let skips: SetupSkip[] = []
    try {
      const initial = planSetupEdits({
        host: options.host,
        values,
        legacy,
        current: missing
          ? { status: 'missing' }
          : { status: 'ready', document: documentOf(generation) },
        snapshot: generation,
      })
      skips = initial.skips
      // The service carries the whole applied protection set into a missing
      // file in this same edit.
      if (initial.edits.length || (missing && Object.keys(values).length)) {
        for (let attempt = 1; ; attempt++) {
          const snapshot = service.snapshot()
          try {
            await service.update(
              (current, carry) => {
                // Decide again from the file as it is under the writer lock,
                // so a value written since the snapshot is never overwritten.
                const plan = planSetupEdits({
                  host: options.host,
                  values,
                  legacy,
                  current,
                  carry,
                  snapshot,
                })
                skips = plan.skips
                return plan.edits
              },
              options.host,
              { createMissing: missing },
            )
            break
          } catch (error) {
            if (!(error instanceof SetupProtectionChanged)) throw error
            if (attempt >= SETUP_WRITE_ATTEMPTS)
              throw new SettingsRefusal(
                'settings-busy',
                'Protection settings kept changing during setup',
              )
            // Resolve the changed file before comparing protection again.
            await service.refresh()
          }
        }
      }
    } finally {
      for (const entry of skips) skip(entry)
    }
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
