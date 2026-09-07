import { randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountQuotaWindow,
  type AccountScopedQuotaWindow,
  type AccountStorage,
  isOAuthAccount,
  type OAuthExtraUsageSnapshot,
  type OAuthQuotaSnapshot,
  QUOTA_FIELD_NAMES,
  type QuotaFieldName,
  type QuotaFieldSource,
  type QuotaFieldSources,
  type QuotaMoney,
} from './accounts.ts'

export const QUOTA_HEADER_FEED_SCHEMA_VERSION = 3
export const QUOTA_HEADER_FEED_LEASE_MS = 180_000

/**
 * Lease files are per process; each carries only the accounts whose response
 * headers THAT process harvested. Consumers MUST union entries across all files
 * inside `lease_horizon_ms`, deduplicating by account; "newest file wins" is wrong.
 * `anthropic_account_uuid` is always present: null is unresolvable, while absence
 * identifies an old producer. A fallback `account_ref` is store-local.
 */
export type QuotaHeaderFeedIdentity =
  | { identity_source: 'credential_id'; credential_id: string }
  | { identity_source: 'account_ref'; account_ref: string }
  | { identity_source: 'none' }

export type QuotaHeaderFeedProvenance = Partial<
  Record<QuotaFieldName, QuotaFieldSource>
>

type QuotaHeaderFeedQuota = Pick<
  OAuthQuotaSnapshot,
  | 'five_hour'
  | 'seven_day'
  | 'bindingWindow'
  | 'fallbackAdvised'
  | 'scoped'
  | 'extraUsage'
> & {
  provenance?: QuotaHeaderFeedProvenance
}

type QuotaHeaderFeedMetadata = {
  schema_version: typeof QUOTA_HEADER_FEED_SCHEMA_VERSION
  provider: 'anthropic'
  configured_account_count: number
  /** Header observation time; merged poll-owned fields retain their own checkedAt. */
  observed_at_ms: number
}

export type QuotaHeaderFeedEntry = QuotaHeaderFeedIdentity &
  QuotaHeaderFeedMetadata & {
    /** Always present: null means UUID resolution failed; absence denotes an old producer. */
    anthropic_account_uuid: string | null
    quota: QuotaHeaderFeedQuota
  }

export type QuotaHeaderFeedPublishEntry = QuotaHeaderFeedIdentity &
  QuotaHeaderFeedMetadata & {
    anthropic_account_uuid: string | null
    quota: Omit<QuotaHeaderFeedQuota, 'provenance'> & {
      fieldSources?: QuotaFieldSources
    }
    accountKey: string
  }

type FeedRecord = {
  version: typeof QUOTA_HEADER_FEED_SCHEMA_VERSION
  lease_horizon_ms: number
  entries: Record<string, QuotaHeaderFeedEntry>
}

export function getDefaultQuotaHeaderFeedDirectory() {
  return (
    process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR ??
    join(tmpdir(), 'opencode-anthropic-auth', 'quota-header-feed')
  )
}

export function configuredAnthropicOAuthAccountCount(input: {
  storage: AccountStorage | null
  mainOAuthConfigured: boolean
}): number {
  const fallbackCount =
    input.storage?.accounts.filter(isOAuthAccount).length ?? 0
  return fallbackCount + (input.mainOAuthConfigured ? 1 : 0)
}

function validIdentity(
  entry: Record<string, unknown>,
): entry is QuotaHeaderFeedEntry {
  if (
    entry.schema_version !== QUOTA_HEADER_FEED_SCHEMA_VERSION ||
    entry.provider !== 'anthropic'
  )
    return false
  if (
    !Number.isFinite(entry.configured_account_count) ||
    !Number.isFinite(entry.observed_at_ms)
  )
    return false
  if (!entry.quota || typeof entry.quota !== 'object') return false
  if (
    !Object.hasOwn(entry, 'anthropic_account_uuid') ||
    (entry.anthropic_account_uuid !== null &&
      typeof entry.anthropic_account_uuid !== 'string')
  )
    return false
  if (entry.identity_source === 'none') {
    return !('credential_id' in entry) && !('account_ref' in entry)
  }
  if (entry.identity_source === 'credential_id') {
    return (
      typeof entry.credential_id === 'string' &&
      entry.credential_id.length > 0 &&
      entry.credential_id !== 'main' &&
      !('account_ref' in entry)
    )
  }
  if (entry.identity_source === 'account_ref') {
    return (
      typeof entry.account_ref === 'string' &&
      entry.account_ref.length > 0 &&
      entry.account_ref !== 'main' &&
      !('credential_id' in entry)
    )
  }
  return false
}

function validatePublishEntry(entry: QuotaHeaderFeedEntry) {
  if (
    entry.schema_version !== QUOTA_HEADER_FEED_SCHEMA_VERSION ||
    entry.provider !== 'anthropic' ||
    !validIdentity(entry as unknown as Record<string, unknown>)
  ) {
    throw new Error('Invalid quota header feed entry')
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function projectQuotaWindow(value: unknown): AccountQuotaWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (
    !finiteNumber(candidate.usedPercent) ||
    !finiteNumber(candidate.remainingPercent) ||
    !finiteNumber(candidate.checkedAt)
  ) {
    return undefined
  }
  return {
    usedPercent: candidate.usedPercent,
    remainingPercent: candidate.remainingPercent,
    ...(typeof candidate.resetsAt === 'string' && {
      resetsAt: candidate.resetsAt,
    }),
    checkedAt: candidate.checkedAt,
  }
}

function projectScopedQuotaWindow(
  value: unknown,
): AccountScopedQuotaWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const window = projectQuotaWindow(candidate)
  if (
    !window ||
    typeof candidate.id !== 'string' ||
    !candidate.id.trim() ||
    typeof candidate.title !== 'string' ||
    !candidate.title.trim() ||
    typeof candidate.modelName !== 'string' ||
    !candidate.modelName.trim()
  ) {
    return undefined
  }
  return {
    ...window,
    id: candidate.id,
    title: candidate.title,
    ...(typeof candidate.modelId === 'string' &&
      candidate.modelId.trim() && {
        modelId: candidate.modelId,
      }),
    modelName: candidate.modelName,
  }
}

function projectQuotaMoney(value: unknown): QuotaMoney | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  if (
    !finiteNumber(candidate.amountMinor) ||
    typeof candidate.currency !== 'string' ||
    !candidate.currency.trim() ||
    !finiteNumber(candidate.exponent)
  ) {
    return undefined
  }
  return {
    amountMinor: candidate.amountMinor,
    currency: candidate.currency,
    exponent: candidate.exponent,
  }
}

function projectExtraUsage(
  value: unknown,
): OAuthExtraUsageSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const used = projectQuotaMoney(candidate.used)
  const limit = projectQuotaMoney(candidate.limit)
  if (!used || !limit || typeof candidate.exhausted !== 'boolean') {
    return undefined
  }
  return {
    used,
    limit,
    ...(finiteNumber(candidate.utilizationPercent) && {
      utilizationPercent: candidate.utilizationPercent,
    }),
    ...(typeof candidate.severity === 'string' && {
      severity: candidate.severity,
    }),
    exhausted: candidate.exhausted,
  }
}

function projectQuotaProvenance(
  value: unknown,
  presentFields: ReadonlySet<QuotaFieldName>,
): QuotaHeaderFeedProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const provenance: QuotaHeaderFeedProvenance = {}
  for (const field of QUOTA_FIELD_NAMES) {
    if (!presentFields.has(field)) continue
    const source = candidate[field]
    if (source === 'poll' || source === 'headers') provenance[field] = source
  }
  return Object.keys(provenance).length > 0 ? provenance : undefined
}

function projectQuota(quota: QuotaHeaderFeedPublishEntry['quota']) {
  const fiveHour = projectQuotaWindow(quota.five_hour)
  const sevenDay = projectQuotaWindow(quota.seven_day)
  const scoped = Array.isArray(quota.scoped)
    ? quota.scoped
        .map(projectScopedQuotaWindow)
        .filter((entry): entry is AccountScopedQuotaWindow => entry != null)
    : undefined
  const extraUsage = projectExtraUsage(quota.extraUsage)
  const presentFields = new Set<QuotaFieldName>()
  if (fiveHour) presentFields.add('five_hour')
  if (sevenDay) presentFields.add('seven_day')
  if (typeof quota.bindingWindow === 'string') {
    presentFields.add('bindingWindow')
  }
  if (typeof quota.fallbackAdvised === 'boolean') {
    presentFields.add('fallbackAdvised')
  }
  if (scoped) presentFields.add('scoped')
  if (extraUsage) presentFields.add('extraUsage')
  const provenance = projectQuotaProvenance(quota.fieldSources, presentFields)
  return {
    ...(fiveHour && { five_hour: fiveHour }),
    ...(sevenDay && { seven_day: sevenDay }),
    ...(typeof quota.bindingWindow === 'string' && {
      bindingWindow: quota.bindingWindow,
    }),
    ...(typeof quota.fallbackAdvised === 'boolean' && {
      fallbackAdvised: quota.fallbackAdvised,
    }),
    ...(scoped && { scoped }),
    ...(extraUsage && { extraUsage }),
    ...(provenance && { provenance }),
  }
}

export class QuotaHeaderFeedRegistry {
  private readonly filePath: string
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      directory?: string
      now?: () => number
      leaseMs?: number
      instanceId?: string
      removeFile?: (path: string) => Promise<void>
      beforeRemoveFile?: (path: string) => Promise<void>
    } = {},
  ) {
    const instanceId = options.instanceId ?? `${process.pid}-${randomUUID()}`
    this.filePath = join(
      options.directory ?? getDefaultQuotaHeaderFeedDirectory(),
      `${instanceId}.json`,
    )
  }

  publish(entry: QuotaHeaderFeedPublishEntry): Promise<void> {
    const { accountKey, quota } = entry
    try {
      validatePublishEntry(entry)
    } catch (error) {
      return Promise.reject(error)
    }
    const identity =
      entry.identity_source === 'credential_id'
        ? {
            identity_source: 'credential_id' as const,
            credential_id: entry.credential_id,
          }
        : entry.identity_source === 'account_ref'
          ? {
              identity_source: 'account_ref' as const,
              account_ref: entry.account_ref,
            }
          : { identity_source: 'none' as const }
    const cleanEntry: QuotaHeaderFeedEntry = {
      ...identity,
      schema_version: entry.schema_version,
      provider: entry.provider,
      configured_account_count: entry.configured_account_count,
      observed_at_ms: entry.observed_at_ms,
      anthropic_account_uuid: entry.anthropic_account_uuid,
      quota: projectQuota(quota),
    }
    if (!accountKey)
      return Promise.reject(new Error('Invalid quota header feed account key'))
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        const directory =
          this.options.directory ?? getDefaultQuotaHeaderFeedDirectory()
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await chmod(directory, 0o700)
        await this.reapStaleSiblingLeases(directory)
        let entries: Record<string, QuotaHeaderFeedEntry> = {}
        try {
          const record = JSON.parse(
            await readFile(this.filePath, 'utf8'),
          ) as Partial<FeedRecord>
          if (
            record.version === QUOTA_HEADER_FEED_SCHEMA_VERSION &&
            record.entries &&
            typeof record.entries === 'object'
          )
            entries = record.entries
        } catch {}
        entries[accountKey] = cleanEntry
        const tempPath = `${this.filePath}.${randomUUID()}.tmp`
        try {
          await writeFile(
            tempPath,
            `${JSON.stringify({ version: QUOTA_HEADER_FEED_SCHEMA_VERSION, lease_horizon_ms: this.options.leaseMs ?? QUOTA_HEADER_FEED_LEASE_MS, entries })}\n`,
            { mode: 0o600 },
          )
          await chmod(tempPath, 0o600)
          await rename(tempPath, this.filePath)
        } finally {
          await rm(tempPath, { force: true })
        }
      })
    return this.writeChain
  }

  private async reapStaleSiblingLeases(directory: string): Promise<void> {
    const now = this.options.now?.() ?? Date.now()
    const leaseMs = this.options.leaseMs ?? QUOTA_HEADER_FEED_LEASE_MS
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return
    }
    await Promise.all(
      names
        .filter((name) => /^\d+-[0-9a-f-]+\.json$/i.test(name))
        .map(async (name) => {
          const path = join(directory, name)
          if (path === this.filePath) return
          try {
            const file = await stat(path)
            if (file.mtimeMs > now || now - file.mtimeMs < leaseMs) return
            await this.options.beforeRemoveFile?.(path)
            const current = await lstat(path)
            if (current.ino !== file.ino || current.mtimeMs !== file.mtimeMs)
              return
            await (this.options.removeFile ?? ((target) => rm(target)))(path)
          } catch {
            // A missed cleanup must not prevent this process from refreshing its lease.
          }
        }),
    )
  }

  async list(): Promise<QuotaHeaderFeedEntry[]> {
    await this.writeChain.catch(() => {})
    const directory =
      this.options.directory ?? getDefaultQuotaHeaderFeedDirectory()
    const now = this.options.now?.() ?? Date.now()
    const leaseMs = this.options.leaseMs ?? QUOTA_HEADER_FEED_LEASE_MS
    let names: string[]
    try {
      names = (await readdir(directory)).filter((name) =>
        name.endsWith('.json'),
      )
    } catch {
      return []
    }
    const newest = new Map<string, QuotaHeaderFeedEntry>()
    await Promise.all(
      names.map(async (name) => {
        try {
          const record = JSON.parse(
            await readFile(join(directory, name), 'utf8'),
          ) as Partial<FeedRecord>
          if (
            record.version !== QUOTA_HEADER_FEED_SCHEMA_VERSION ||
            !record.entries ||
            typeof record.entries !== 'object'
          )
            return
          for (const [accountKey, candidate] of Object.entries(
            record.entries,
          )) {
            if (
              !candidate ||
              typeof candidate !== 'object' ||
              candidate.schema_version !== QUOTA_HEADER_FEED_SCHEMA_VERSION ||
              candidate.provider !== 'anthropic' ||
              !validIdentity(candidate as unknown as Record<string, unknown>)
            )
              continue
            const observed = candidate.observed_at_ms
            if (observed > now || now - observed >= leaseMs) continue
            const existing = newest.get(accountKey)
            if (!existing || observed > existing.observed_at_ms)
              newest.set(accountKey, candidate)
          }
        } catch {}
      }),
    )
    return [...newest.values()].sort(
      (a, b) => a.observed_at_ms - b.observed_at_ms,
    )
  }

  async dispose(): Promise<void> {
    await this.writeChain.catch(() => {})
    await rm(this.filePath, { force: true })
  }
}
