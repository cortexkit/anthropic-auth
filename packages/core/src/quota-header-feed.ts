import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
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
  type QuotaMoney,
} from './accounts.ts'

export const QUOTA_HEADER_FEED_SCHEMA_VERSION = 2
export const QUOTA_HEADER_FEED_LEASE_MS = 180_000

export type QuotaHeaderFeedIdentity =
  | { identity_source: 'credential_id'; credential_id: string }
  | { identity_source: 'account_ref'; account_ref: string }
  | { identity_source: 'none' }

export type QuotaHeaderFeedEntry = QuotaHeaderFeedIdentity & {
  schema_version: typeof QUOTA_HEADER_FEED_SCHEMA_VERSION
  provider: 'anthropic'
  configured_account_count: number
  observed_at_ms: number
  quota: Pick<
    OAuthQuotaSnapshot,
    | 'five_hour'
    | 'seven_day'
    | 'bindingWindow'
    | 'fallbackAdvised'
    | 'scoped'
    | 'extraUsage'
  >
}

type FeedRecord = {
  version: typeof QUOTA_HEADER_FEED_SCHEMA_VERSION
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

function projectQuota(quota: QuotaHeaderFeedEntry['quota']) {
  const fiveHour = projectQuotaWindow(quota.five_hour)
  const sevenDay = projectQuotaWindow(quota.seven_day)
  const scoped = Array.isArray(quota.scoped)
    ? quota.scoped
        .map(projectScopedQuotaWindow)
        .filter((entry): entry is AccountScopedQuotaWindow => entry != null)
    : undefined
  const extraUsage = projectExtraUsage(quota.extraUsage)
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
    } = {},
  ) {
    const instanceId = options.instanceId ?? `${process.pid}-${randomUUID()}`
    this.filePath = join(
      options.directory ?? getDefaultQuotaHeaderFeedDirectory(),
      `${instanceId}.json`,
    )
  }

  publish(entry: QuotaHeaderFeedEntry & { accountKey: string }): Promise<void> {
    const { accountKey, quota, ...entryWithoutQuota } = entry
    const cleanEntry = {
      ...entryWithoutQuota,
      quota: projectQuota(quota),
    }
    try {
      validatePublishEntry(cleanEntry)
    } catch (error) {
      return Promise.reject(error)
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
            `${JSON.stringify({ version: QUOTA_HEADER_FEED_SCHEMA_VERSION, entries })}\n`,
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
