import { randomUUID } from 'node:crypto'
import { lstat, readFile, rm } from 'node:fs/promises'
import { withLock } from '@cortexkit/common-auth/fs'
import {
  capturePublicationOptions,
  type PublicationOptions,
  renameWithWindowsSharingRetry,
} from './publication-rename.ts'
import {
  DEFAULT_REFUSAL_FALLBACK_MODE,
  isRefusalFallbackMode,
  type RefusalFallbackMode,
} from './settings-definition.ts'
import {
  mirrorSettingsRecord,
  type SettingsHost,
  type SettingsRecordPaths,
} from './settings-paths.ts'
import {
  SETTINGS_PROTECTION_KEYS,
  type SettingsProtectionValues,
} from './settings-service.ts'
import { writeOwnerOnlyExclusive } from './state-layout-io.ts'

export interface SettingsProtectionCopyEntry {
  /** Time the published generation was read, not when its detached write ran. */
  readAt: number
  values: SettingsProtectionValues
}

type StoredProtectionCopyEntry = {
  readAt: number
  values: Omit<SettingsProtectionValues, 'refusal_fallback'>
  refusal_fallback?: RefusalFallbackMode
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function floor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  )
}

// Keep the original values shape so older releases accept the same copy.
// A missing sibling means the mode was unset before this setting existed.
function validEntry(value: unknown): value is StoredProtectionCopyEntry {
  if (
    !record(value) ||
    typeof value.readAt !== 'number' ||
    !Number.isFinite(value.readAt) ||
    value.readAt <= 0 ||
    !record(value.values) ||
    (Object.hasOwn(value, 'refusal_fallback') &&
      !isRefusalFallbackMode(value.refusal_fallback))
  )
    return false
  const values = value.values
  if (
    Object.keys(values).length !== SETTINGS_PROTECTION_KEYS.length - 1 ||
    !SETTINGS_PROTECTION_KEYS.every(
      (key) => key === 'refusal_fallback' || Object.hasOwn(values, key),
    ) ||
    typeof values.killswitch_enabled !== 'boolean' ||
    !['off', '15m', 'cache'].includes(values.max_same_account_wait as string) ||
    !['default', 'on', 'off'].includes(
      values.quota_fail_closed_on_unknown_quota as string,
    ) ||
    ![
      values.killswitch_default_five_hour,
      values.killswitch_default_seven_day,
      values.killswitch_default_scoped,
      values.quota_minimum_remaining_five_hour,
      values.quota_minimum_remaining_seven_day,
      values.quota_minimum_remaining_scoped,
    ].every(floor) ||
    !Array.isArray(values.killswitch_account_floors)
  )
    return false
  const seen = new Set<string>()
  for (const entry of values.killswitch_account_floors) {
    if (
      !record(entry) ||
      Object.keys(entry).length !== 5 ||
      typeof entry.account !== 'string' ||
      !['opencode', 'pi', 'both'].includes(entry.host as string) ||
      ![entry.five_hour, entry.seven_day, entry.scoped].every(floor)
    )
      return false
    for (const host of entry.host === 'both'
      ? ['opencode', 'pi']
      : [entry.host]) {
      const key = JSON.stringify([entry.account, host])
      if (seen.has(key)) return false
      seen.add(key)
    }
  }
  return true
}

const missingCopy = Symbol('missing protection copy')

async function readCopy(
  path: string,
  repairMalformed = false,
): Promise<Record<string, unknown> | typeof missingCopy> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling symlink still occupies the name and is not an absent copy.
      try {
        await lstat(path)
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT')
          return missingCopy
        throw statError
      }
      if (repairMalformed) return {}
    }
    throw error
  }
  try {
    const copy: unknown = JSON.parse(text)
    if (!record(copy))
      throw new Error('The applied protection copy is not a host map')
    return copy
  } catch (error) {
    // Malformed JSON cannot preserve either host's saved values, so let the
    // writer repair its own file, but don't use it as a seed for another copy.
    if (repairMalformed) return {}
    throw error
  }
}

export class UnknownSettingsStateCopyError extends Error {
  constructor(cause: unknown) {
    super('Could not read the state protection copy', { cause })
  }
}

async function readStateCopy<T>(
  records: SettingsRecordPaths,
  read: (path: string) => Promise<T>,
): Promise<T | typeof missingCopy> {
  try {
    if (records.stateUnavailable) throw records.stateUnavailable
    return records.state ? await read(records.state.applied) : missingCopy
  } catch (cause) {
    throw new UnknownSettingsStateCopyError(cause)
  }
}

/**
 * This host's complete set from the applied copy. A copy file that doesn't
 * exist, or one without an entry for this host, returns undefined: there is
 * no saved set. A copy that exists but can't be read, isn't valid JSON, or
 * holds an invalid entry for this host throws instead, so callers can tell an
 * unknown set from an absent one. Never returns a partial protection set.
 */
export async function readSettingsProtectionCopy(
  records: SettingsRecordPaths,
  host: SettingsHost,
): Promise<SettingsProtectionValues | undefined> {
  let entry = await readProtectionEntry(records.beside.applied, host)
  // A beside file with no entry for this host still outranks the mirror.
  if (entry === missingCopy)
    entry = await readStateCopy(records, (path) =>
      readProtectionEntry(path, host),
    )
  return entry !== missingCopy && entry
    ? {
        ...entry.values,
        refusal_fallback:
          entry.refusal_fallback ?? DEFAULT_REFUSAL_FALLBACK_MODE,
      }
    : undefined
}

async function readProtectionEntry(
  path: string,
  host: SettingsHost,
): Promise<StoredProtectionCopyEntry | typeof missingCopy | undefined> {
  const copy = await readCopy(path)
  return copy === missingCopy ? missingCopy : protectionEntry(copy, host)
}

function protectionEntry(copy: Record<string, unknown>, host: SettingsHost) {
  if (!Object.hasOwn(copy, host)) return undefined
  const entry = copy[host]
  if (!validEntry(entry))
    throw new Error('The applied protection copy entry is invalid')
  return entry
}

function readStateSeed(records: SettingsRecordPaths) {
  return readStateCopy(records, async (path) => {
    const copy = await readCopy(path)
    if (copy !== missingCopy) {
      protectionEntry(copy, 'opencode')
      protectionEntry(copy, 'pi')
    }
    return copy
  })
}

/** Merge only the writer's host while holding the copy's cross-process lock. */
export async function writeSettingsProtectionCopy(
  records: SettingsRecordPaths,
  host: SettingsHost,
  entry: SettingsProtectionCopyEntry,
  lockTimeoutMs = 5_000,
  publicationOptions: PublicationOptions = {},
): Promise<void> {
  const { refusal_fallback, ...values } = entry.values
  const stored = { readAt: entry.readAt, values, refusal_fallback }
  if (!validEntry(stored)) throw new Error('Invalid protection copy entry')
  const publication = capturePublicationOptions(publicationOptions)
  // Keep the old copy current first. Its lock serializes writes with 2.17.x plugins.
  await writeProtectionEntry(
    records.beside.applied,
    host,
    stored,
    lockTimeoutMs,
    publication,
    records,
  )
  const state = records.state?.applied
  if (state)
    mirrorSettingsRecord(records, state, () =>
      writeProtectionEntry(state, host, stored, lockTimeoutMs, publication),
    )
}

async function writeProtectionEntry(
  path: string,
  host: SettingsHost,
  entry: StoredProtectionCopyEntry,
  lockTimeoutMs: number,
  publication: ReturnType<typeof capturePublicationOptions>,
  seedFromState?: SettingsRecordPaths,
): Promise<void> {
  await withLock(
    path,
    {
      name: 'protection',
      timeoutMs: lockTimeoutMs,
      ttlMs: 10_000,
      renew: true,
    },
    async (lease) => {
      const current = await readCopy(path, true)
      const missing = current === missingCopy
      // Once a copy exists beside the settings file, both hosts stop reading
      // the state-folder copy. Carry its entries over, or leave the beside
      // copy absent if the state-folder copy can't be read.
      const seed =
        missing && seedFromState ? await readStateSeed(seedFromState) : current
      const copy = seed === missingCopy ? {} : seed
      const previous = copy[host]
      // A newer reader may have committed while this detached task was delayed,
      // even when the two readers belong to different processes of the same host.
      const superseded = validEntry(previous) && previous.readAt >= entry.readAt
      if (!missing && superseded) return
      const other = host === 'opencode' ? 'pi' : 'opencode'
      const merged = {
        ...(Object.hasOwn(copy, other) ? { [other]: copy[other] } : {}),
        [host]: superseded ? previous : entry,
      }
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeOwnerOnlyExclusive(
          temp,
          Buffer.from(`${JSON.stringify(merged, null, 2)}\n`),
          process.platform,
        )
        await lease.assertOwned()
        await renameWithWindowsSharingRetry(
          temp,
          path,
          publication,
          async () => {
            await lease.assertOwned()
            return 'publish'
          },
        )
      } finally {
        await rm(temp, { force: true })
      }
    },
  )
}
