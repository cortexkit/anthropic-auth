import { randomUUID } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import { withLock } from '@cortexkit/common-auth/fs'

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
  const copy: unknown = JSON.parse(
    await readFile(`${file}.applied.json`, 'utf8'),
  )
  if (!record(copy)) throw new Error('Invalid protection copy')
  return copy
}

/** Missing or invalid host entries return no values, never a partial protection set. */
export async function readSettingsProtectionCopy(
  file: string,
  host: SettingsHost,
): Promise<SettingsProtectionValues | undefined> {
  try {
    const entry = (await readCopy(file))[host]
    return validEntry(entry) ? entry.values : undefined
  } catch {
    return undefined
  }
}

/** Merge only the writer's host while holding the copy's cross-process lock. */
export async function writeSettingsProtectionCopy(
  file: string,
  host: SettingsHost,
  entry: SettingsProtectionCopyEntry,
  lockTimeoutMs = 5_000,
): Promise<void> {
  if (!validEntry(entry)) throw new Error('Invalid protection copy entry')
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
        await rename(temp, path)
      } finally {
        await rm(temp, { force: true })
      }
    },
  )
}
