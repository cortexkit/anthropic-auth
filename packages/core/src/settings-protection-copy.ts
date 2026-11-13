import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { withLock } from '@cortexkit/common-auth/fs'
import {
  capturePublicationOptions,
  type PublicationOptions,
  renameWithWindowsSharingRetry,
} from './publication-rename.ts'
import type { SettingsHost } from './settings-paths.ts'
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

// This is the persisted-copy format, not user-file resolution: every field is
// required and overrides, inferred fields and partial recovery are not allowed.
function validEntry(value: unknown): value is SettingsProtectionCopyEntry {
  if (
    !record(value) ||
    typeof value.readAt !== 'number' ||
    !Number.isFinite(value.readAt) ||
    value.readAt <= 0 ||
    !record(value.values)
  )
    return false
  const values = value.values
  if (
    Object.keys(values).length !== SETTINGS_PROTECTION_KEYS.length ||
    !SETTINGS_PROTECTION_KEYS.every((key) => Object.hasOwn(values, key)) ||
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

async function readCopy(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(`${file}.applied.json`, 'utf8')
  let copy: unknown
  try {
    copy = JSON.parse(text)
  } catch {
    // Malformed JSON cannot preserve either host's saved values, so let the
    // writer recreate the copy. Filesystem read errors still propagate.
    return {}
  }
  return record(copy) ? copy : {}
}

/**
 * This host's complete set from the applied copy. A copy file that doesn't
 * exist, or one without an entry for this host, returns undefined: there is
 * no saved set. A copy that exists but can't be read, isn't valid JSON, or
 * holds an invalid entry for this host throws instead, so callers can tell an
 * unknown set from an absent one. Never returns a partial protection set.
 */
export async function readSettingsProtectionCopy(
  file: string,
  host: SettingsHost,
): Promise<SettingsProtectionValues | undefined> {
  let text: string
  try {
    text = await readFile(`${file}.applied.json`, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const copy: unknown = JSON.parse(text)
  if (!record(copy))
    throw new Error('The applied protection copy is not a host map')
  if (!Object.hasOwn(copy, host)) return undefined
  const entry = copy[host]
  if (!validEntry(entry))
    throw new Error('The applied protection copy entry is invalid')
  return entry.values
}

/** Merge only the writer's host while holding the copy's cross-process lock. */
export async function writeSettingsProtectionCopy(
  file: string,
  host: SettingsHost,
  entry: SettingsProtectionCopyEntry,
  lockTimeoutMs = 5_000,
  publicationOptions: PublicationOptions = {},
): Promise<void> {
  if (!validEntry(entry)) throw new Error('Invalid protection copy entry')
  const publication = capturePublicationOptions(publicationOptions)
  const path = `${file}.applied.json`
  await withLock(
    path,
    {
      name: 'protection',
      timeoutMs: lockTimeoutMs,
      ttlMs: 10_000,
      renew: true,
    },
    async (lease) => {
      let copy: Record<string, unknown>
      try {
        copy = await readCopy(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        copy = {}
      }
      const previous = copy[host]
      // A newer reader may have committed while this detached task was delayed,
      // even when the two readers belong to different processes of the same host.
      if (validEntry(previous) && previous.readAt >= entry.readAt) return
      const other = host === 'opencode' ? 'pi' : 'opencode'
      const merged = {
        ...(Object.hasOwn(copy, other) ? { [other]: copy[other] } : {}),
        [host]: entry,
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
