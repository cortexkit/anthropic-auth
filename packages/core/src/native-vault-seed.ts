import { lstat, readFile } from 'node:fs/promises'
import { validateNativeMigrationSettings } from './native-migration-source.ts'
import type { NativeVaultRosterDocument } from './native-roster-seed.ts'

export interface NativeVaultRoutingSeed {
  legacyConfig: string
  roster: string
  mainRouteId?: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Missing or invalid legacy JSON skips the import rather than blocking vault requests. */
export async function readNativeVaultLegacyJson(
  path: string,
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

export async function nativeVaultFileAbsent(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return true
    throw error
  }
}

const preferenceFields: Record<string, readonly string[]> = {
  routing: ['mode', 'maxSameAccountWait'],
  claudeCache: ['enabled', 'mode'],
  cacheKeep: ['enabled', 'always', 'startHour', 'endHour', 'subagents'],
  quota: [
    'enabled',
    'checkIntervalMinutes',
    'minimumRemaining',
    'failClosedOnUnknownQuota',
  ],
  // Exclude per-account floors: their keys name legacy local accounts, and the
  // first settings write may not yet know which vault accounts have those UUIDs.
  killswitch: ['enabled', 'main'],
  claudeFast: ['enabled'],
  turnEndNote: ['tools'],
  prime: ['enabled'],
  logging: ['level'],
  dump: ['enabled'],
}

/** Validate only preference fields, excluding credentials, account rows and stored account observations. */
export async function readNativeVaultLegacySettings(
  path: string,
): Promise<Record<string, unknown>> {
  const source = await readNativeVaultLegacyJson(path)
  const result: Record<string, unknown> = {}
  if (!record(source) || (source.version !== undefined && source.version !== 1))
    return result
  for (const [section, fields] of Object.entries(preferenceFields)) {
    const value = source[section]
    if (!record(value)) continue
    const selected: Record<string, unknown> = {}
    for (const field of fields) {
      const item = value[field]
      if (item === undefined) continue
      if (
        (field === 'minimumRemaining' ||
          (section === 'killswitch' && field === 'main')) &&
        record(item)
      ) {
        const thresholds: Record<string, unknown> = {}
        for (const name of ['five_hour', 'seven_day', '5h', '1w', 'scoped']) {
          if (item[name] === undefined) continue
          try {
            validateNativeMigrationSettings({
              [section]: { [field]: { [name]: item[name] } },
            })
            thresholds[name] = item[name]
          } catch {
            /* Invalid legacy values are omitted individually. */
          }
        }
        if (Object.keys(thresholds).length) selected[field] = thresholds
        continue
      }
      try {
        validateNativeMigrationSettings({ [section]: { [field]: item } })
        selected[field] = item
      } catch {
        /* Invalid legacy values are omitted individually. */
      }
    }
    if (Object.keys(selected).length) result[section] = selected
  }
  if (Array.isArray(source.fallbackOn))
    result.fallbackOn = source.fallbackOn.filter(
      (value) => typeof value === 'number' && Number.isInteger(value),
    )
  return result
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
}

/** Match public legacy IDs to verified vault UUIDs, never to labels, credential handles or row order. */
export function nativeVaultLegacyRoutes(
  source: unknown,
  roster: NativeVaultRosterDocument,
) {
  const routes = new Map<string, { routeId: string; accountIdentity: string }>()
  if (!record(source) || (source.version !== undefined && source.version !== 1))
    return routes
  const verified = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const row of roster.rows) {
    if (
      row.credentialType !== 'oauth' ||
      row.state !== 'active' ||
      row.stale ||
      row.unclaimed ||
      !uuid(row.accountIdentity)
    )
      continue
    if (verified.has(row.accountIdentity)) ambiguous.add(row.accountIdentity)
    verified.set(row.accountIdentity, row.routeId)
  }
  function add(id: unknown, identity: unknown) {
    if (typeof id !== 'string' || !uuid(identity) || ambiguous.has(identity))
      return
    const routeId = verified.get(identity)
    if (routeId) routes.set(id, { routeId, accountIdentity: identity })
  }
  const custody = record(source.claustrum) ? source.claustrum : undefined
  const primary = record(custody?.primaryAccount)
    ? custody.primaryAccount
    : undefined
  const main = uuid(primary?.accountId)
    ? primary.accountId
    : source.mainAccountId
  add('main', main)
  add(source.mainAccountId, main)
  for (const row of Array.isArray(source.accounts) ? source.accounts : []) {
    if (record(row) && row.type === 'oauth')
      add(row.id, row.anthropicAccountUuid)
  }
  return routes
}
