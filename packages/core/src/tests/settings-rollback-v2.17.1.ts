// Frozen from v2.17.1 (e480d1102b7779714f939166495b2566e01ea5d2): the
// record probes in settings-mode.ts and the read/validation path in
// settings-protection-copy.ts. These paths and field names intentionally do not
// depend on the current resolver or schema.
import { lstat, readFile } from 'node:fs/promises'

type Host = 'opencode' | 'pi'
const floorKeys = [
  'killswitch_default_five_hour',
  'killswitch_default_seven_day',
  'killswitch_default_scoped',
  'quota_minimum_remaining_five_hour',
  'quota_minimum_remaining_seven_day',
  'quota_minimum_remaining_scoped',
] as const
const protectionKeys = [
  ...floorKeys,
  'killswitch_enabled',
  'killswitch_account_floors',
  'quota_fail_closed_on_unknown_quota',
  'max_same_account_wait',
] as const

type PublishedProtection = Record<(typeof floorKeys)[number], number> & {
  killswitch_enabled: boolean
  killswitch_account_floors: {
    account: string
    host: Host | 'both'
    five_hour: number
    seven_day: number
    scoped: number
  }[]
  quota_fail_closed_on_unknown_quota: 'default' | 'on' | 'off'
  max_same_account_wait: 'off' | '15m' | 'cache'
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function publishedSettingsMode(target: string) {
  if (await exists(target)) return 'user-file'
  return (await exists(`${target}.moved`)) ? 'user-file' : 'legacy'
}

export function publishedHasImportRecord(target: string, host: Host) {
  return exists(`${target}.moved.${host}`)
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

function validEntry(
  value: unknown,
): value is { readAt: number; values: PublishedProtection } {
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
    Object.keys(values).length !== protectionKeys.length ||
    !protectionKeys.every((key) => Object.hasOwn(values, key)) ||
    typeof values.killswitch_enabled !== 'boolean' ||
    !['off', '15m', 'cache'].includes(values.max_same_account_wait as string) ||
    !['default', 'on', 'off'].includes(
      values.quota_fail_closed_on_unknown_quota as string,
    ) ||
    !floorKeys.map((key) => values[key]).every(floor) ||
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

export async function publishedReadProtectionCopy(
  file: string,
  host: Host,
): Promise<PublishedProtection | undefined> {
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
