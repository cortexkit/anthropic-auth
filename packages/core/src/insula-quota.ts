import type {
  InsulaQuotaContext,
  InsulaUsageEntry,
  InsulaUsageWindow,
} from '@cortexkit/common-auth/claustrum'
import {
  type AccountQuotaWindow,
  type AccountScopedQuotaWindow,
  type OAuthExtraUsageSnapshot,
  type OAuthQuotaSnapshot,
  type QuotaFieldSources,
  quotaFieldSource,
  quotaPollCheckedAt,
  quotaSnapshotCheckedAt,
} from './accounts.ts'

/** An insula reading in the shape our usage poll produces, before the account identity is attached. */
export type InsulaClaudeQuota = OAuthQuotaSnapshot & {
  seven_day: AccountQuotaWindow
  scoped: AccountScopedQuotaWindow[]
  checkedAt: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

// Keep percentages within 0-100, as the usage poll's mapping in accounts.ts does.
function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value))
}

/**
 * Insula's usedPercent is Anthropic's whole-number utilization, so it is used
 * unchanged. When insula names a window's kind or length it must match the
 * slot we read it from; anything else is not a window we know how to use.
 */
function windowReading(
  window: InsulaUsageWindow | undefined,
  checkedAt: number,
  expected?: { kind: string; minutes: number },
): AccountQuotaWindow | undefined {
  if (!record(window)) return undefined
  const usedPercent = window.usedPercent
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent))
    return undefined
  if (
    expected &&
    ((window.windowKind !== undefined && window.windowKind !== expected.kind) ||
      (window.windowMinutes !== undefined &&
        window.windowMinutes !== expected.minutes))
  )
    return undefined
  const used = clampPercent(usedPercent)
  return {
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    ...(typeof window.resetsAt === 'string' && { resetsAt: window.resetsAt }),
    checkedAt,
  }
}

// Same slug as the usage poll, so an insula reading and a poll reading of
// one model-scoped limit share a window id and replace each other.
function slugForQuotaIdentity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Model-scoped weekly limits. Insula's `id` is Anthropic's model id, or the
 * model's display name when Anthropic sends no id (the live value is
 * `Fable`). The poll keys the window on the same value, so routing and the
 * scoped killswitch floor find it the same way. `title` is display text and
 * never identifies a window.
 */
function scopedReadings(
  windows: unknown,
  checkedAt: number,
): AccountScopedQuotaWindow[] {
  if (!Array.isArray(windows)) return []
  const seen = new Set<string>()
  const scoped: AccountScopedQuotaWindow[] = []
  for (const candidate of windows) {
    if (!record(candidate)) continue
    const identity = text(candidate.id)
    if (!identity) continue
    const slug = slugForQuotaIdentity(identity)
    if (!slug) continue
    const id = `claude-weekly-scoped-${slug}`
    if (seen.has(id)) continue
    const reading = windowReading(
      candidate.window as InsulaUsageWindow | undefined,
      checkedAt,
    )
    if (!reading) continue
    seen.add(id)
    scoped.push({
      ...reading,
      id,
      title: `${identity} only`,
      // A display-name fallback is not a model id; only Anthropic's own ids
      // (claude-...) are recorded as one.
      ...(identity.startsWith('claude-') && { modelId: identity }),
      modelName: identity,
    })
  }
  return scoped
}

function money(value: unknown): { minor: number; exponent: number } | null {
  if (
    !record(value) ||
    typeof value.minor !== 'number' ||
    !Number.isSafeInteger(value.minor) ||
    value.minor < 0
  )
    return null
  const exponent = value.exponent ?? 2
  if (
    typeof exponent !== 'number' ||
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 20
  )
    return null
  return { minor: value.minor, exponent }
}

/**
 * Insula reports extra usage as a pool titled `Extra usage`, present only
 * while overage is enabled, with amounts in cents. A pool whose amounts
 * cannot be read is left out, exactly as the poll leaves out an unreadable
 * extra_usage block.
 */
function extraUsageReading(
  pools: unknown,
): OAuthExtraUsageSnapshot | undefined {
  if (!Array.isArray(pools)) return undefined
  const pool = pools.find(
    (candidate) => record(candidate) && candidate.title === 'Extra usage',
  )
  if (!record(pool)) return undefined
  const limit = money(pool.total ?? pool.limit)
  const remaining = money(pool.remaining)
  const usedAmount = money(pool.used)
  if (!limit) return undefined
  const exponent = limit.exponent
  let used: number | undefined
  if (usedAmount && usedAmount.exponent === exponent) used = usedAmount.minor
  else if (remaining && remaining.exponent === exponent)
    used = Math.max(0, limit.minor - remaining.minor)
  if (used === undefined) return undefined
  const unit = text(pool.unit) ?? text(record(pool.total) && pool.total.unit)
  const currency = unit && /^[A-Za-z]{3}$/.test(unit) ? unit : 'USD'
  return {
    used: { amountMinor: used, currency, exponent },
    limit: { amountMinor: limit.minor, currency, exponent },
    ...(limit.minor > 0 && {
      utilizationPercent: (used / limit.minor) * 100,
    }),
    exhausted: pool.spendable === false || used >= limit.minor,
  }
}

/**
 * Convert insula's Claude entry into our usage-poll snapshot. Every window's
 * checkedAt is when insula fetched the reading, never when we read its cache,
 * so a newer header or poll reading still wins. The weekly window is required;
 * an absent primary slot means the five-hour limit does not apply.
 * The tertiary slot (legacy seven_day_opus/sonnet) is not a window we model.
 */
export function normalizeInsulaClaudeQuota(
  entry: InsulaUsageEntry,
  context: InsulaQuotaContext,
): InsulaClaudeQuota | undefined {
  // common-auth's InsulaQuotaSource.current only returns an entry with usage,
  // no stale or errorClass field, and a fetchedAt under four minutes old.
  const checkedAt = context.fetchedAt
  const usage = entry.usage
  const five_hour = windowReading(usage?.primary, checkedAt, {
    kind: 'five_hour',
    minutes: 300,
  })
  const seven_day = windowReading(usage?.secondary, checkedAt, {
    kind: 'weekly',
    minutes: 10_080,
  })
  if (!seven_day || (usage?.primary != null && !five_hour)) return undefined
  const scoped = scopedReadings(usage?.extraRateWindows, checkedAt)
  const extraUsage = extraUsageReading(entry.pools ?? usage?.pools)
  return {
    ...(five_hour && { five_hour }),
    seven_day,
    scoped,
    ...(extraUsage && { extraUsage }),
    source: 'poll',
    checkedAt,
    fieldSources: {
      ...(five_hour && { five_hour: 'poll' as const }),
      seven_day: 'poll',
      scoped: 'poll',
      ...(extraUsage && { extraUsage: 'poll' as const }),
    },
  }
}

function newer<T extends { checkedAt: number }>(
  reading: T | undefined,
  stored: T | undefined,
): T | undefined {
  if (!stored) return reading
  if (!reading) return stored
  return stored.checkedAt > reading.checkedAt ? stored : reading
}

/**
 * Insula fetches on its own schedule, so the account's stored quota can hold
 * a window read after insula's fetch (a response header, or our own poll).
 * Stored quota is replaced as one snapshot, newest wins, so publishing the
 * older insula reading as is would be refused and lose its other windows.
 * Keep newer standard windows, but take scoped limits and credits together
 * from the newest poll, including fields it no longer reports.
 */
export function mergeInsulaQuota(
  reading: InsulaClaudeQuota,
  stored: OAuthQuotaSnapshot | undefined,
): OAuthQuotaSnapshot {
  if (!stored) return reading
  if (quotaPollCheckedAt(stored) > reading.checkedAt) return stored
  if (quotaSnapshotCheckedAt(stored) <= reading.checkedAt) return reading
  const five_hour =
    !reading.five_hour &&
    (stored.five_hour?.checkedAt ?? 0) <= reading.checkedAt
      ? undefined
      : newer(reading.five_hour, stored.five_hour)
  const seven_day = newer(reading.seven_day, stored.seven_day)
  const fieldSources: QuotaFieldSources = { ...reading.fieldSources }
  if (five_hour && five_hour !== reading.five_hour)
    fieldSources.five_hour = quotaFieldSource(stored, 'five_hour')
  if (seven_day !== reading.seven_day)
    fieldSources.seven_day = quotaFieldSource(stored, 'seven_day')
  return {
    ...reading,
    five_hour,
    ...(seven_day && { seven_day }),
    fieldSources,
  }
}
