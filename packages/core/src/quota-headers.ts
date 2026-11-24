import type {
  AccountQuotaWindow,
  OAuthQuotaSnapshot,
  QuotaFieldSources,
  QuotaWindowName,
} from './accounts.ts'
import {
  QUOTA_FIELD_NAMES,
  quotaFieldSource,
  quotaSnapshotOmitsFiveHour,
} from './accounts.ts'

const PREFIX = 'anthropic-ratelimit-unified-'
const WINDOW_KEYS: Record<string, QuotaWindowName> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
}
const SCOPED_WINDOW_HEADER =
  /^anthropic-ratelimit-unified-(7d[_-]([a-z0-9]+))-(?:status|utilization)$/

export function isQuotaBearingHeaderFrame(headers: Headers): boolean {
  return Object.keys(WINDOW_KEYS).some((suffix) =>
    Number.isFinite(
      finiteHeaderNumber(headers, `${PREFIX}${suffix}-utilization`),
    ),
  )
}

function finiteHeaderNumber(headers: Headers, name: string) {
  const value = headers.get(name)
  if (value == null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function headerResetAt(headers: Headers, suffix: string) {
  const seconds = finiteHeaderNumber(headers, `${PREFIX}${suffix}-reset`)
  if (seconds == null) return undefined
  const reset = new Date(seconds * 1000)
  return Number.isFinite(reset.getTime()) ? reset.toISOString() : undefined
}

function normalizeWindow(
  headers: Headers,
  suffix: string,
  checkedAt: number,
): AccountQuotaWindow | undefined {
  const utilization = finiteHeaderNumber(
    headers,
    `${PREFIX}${suffix}-utilization`,
  )
  if (utilization == null) return undefined
  const usedPercent = Math.min(100, Math.max(0, Math.round(utilization * 100)))
  const resetsAt = headerResetAt(headers, suffix)
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(resetsAt && { resetsAt }),
    checkedAt,
  }
}

function windowConfirmedExhausted(headers: Headers, suffix: string) {
  const utilization = finiteHeaderNumber(
    headers,
    `${PREFIX}${suffix}-utilization`,
  )
  return (
    headers.get(`${PREFIX}${suffix}-status`) === 'rejected' ||
    (utilization !== undefined && utilization >= 1)
  )
}

/** Even an unrelated scoped window rules out inferring a limit from stored quota. */
export function hasScopedQuotaExhaustionHeaders(headers: Headers) {
  for (const name of headers.keys()) {
    const suffix = SCOPED_WINDOW_HEADER.exec(name)?.[1]
    if (suffix && windowConfirmedExhausted(headers, suffix)) return true
  }
  return false
}

/** Only a rejected status or raw utilization at least one confirms a 429's limit. */
export function quotaExhaustionFromHeaders(
  headers: Headers,
  modelId?: string,
  now = Date.now(),
): OAuthQuotaSnapshot {
  const snapshot: OAuthQuotaSnapshot = {}
  const exhausted = (suffix: string): AccountQuotaWindow | undefined => {
    if (!windowConfirmedExhausted(headers, suffix)) return undefined
    return {
      usedPercent: 100,
      remainingPercent: 0,
      checkedAt: now,
      resetsAt: headerResetAt(headers, suffix),
    }
  }
  for (const [suffix, key] of Object.entries(WINDOW_KEYS)) {
    const window = exhausted(suffix)
    if (window) snapshot[key] = window
  }
  const modelTokens = modelId?.toLowerCase().split(/[-_.]/)
  for (const name of headers.keys()) {
    const [, id, scope] = SCOPED_WINDOW_HEADER.exec(name) ?? []
    if (!id || !scope || !modelTokens?.includes(scope)) continue
    const window = exhausted(id)
    if (window)
      snapshot.scoped = [
        {
          ...window,
          id,
          title: scope,
          modelName: scope,
          modelId,
        },
      ]
  }
  return snapshot
}

export function normalizeQuotaHeaders(
  headers: Headers,
  now = Date.now(),
): OAuthQuotaSnapshot {
  const fieldSources: QuotaFieldSources = {}
  const fallbackHeader = headers.get(`${PREFIX}fallback`)
  const snapshot: OAuthQuotaSnapshot = {
    fallbackAdvised: fallbackHeader === 'available',
    source: 'headers',
    checkedAt: now,
  }
  for (const [suffix, key] of Object.entries(WINDOW_KEYS)) {
    const window = normalizeWindow(headers, suffix, now)
    if (window) {
      snapshot[key] = window
      fieldSources[key] = 'headers'
    }
  }
  const representativeClaim = headers.get(`${PREFIX}representative-claim`)
  if (representativeClaim) {
    snapshot.bindingWindow = representativeClaim
    snapshot.bindingWindowSource = 'headers'
    fieldSources.bindingWindow = 'headers'
  }
  if (fallbackHeader !== null) fieldSources.fallbackAdvised = 'headers'
  return {
    ...snapshot,
    fieldSources,
  }
}

export function mergeHeaderQuotaSnapshot(
  existing: OAuthQuotaSnapshot | undefined,
  incoming: OAuthQuotaSnapshot,
): OAuthQuotaSnapshot {
  if (
    quotaSnapshotOmitsFiveHour(existing) &&
    incoming.five_hour &&
    incoming.five_hour.checkedAt <= existing.checkedAt
  ) {
    // A late header frame cannot restore a session limit removed by a poll.
    return mergeHeaderQuotaSnapshot(existing, {
      ...incoming,
      five_hour: undefined,
    })
  }
  const {
    scoped: existingScoped,
    extraUsage: existingExtraUsage,
    fieldSources: existingFieldSources,
    ...existingWithoutPollOwnedFields
  } = existing ?? {}
  const {
    scoped: _incomingScoped,
    extraUsage: _incomingExtraUsage,
    fieldSources: incomingFieldSources,
    ...incomingWithoutPollOwnedFields
  } = incoming

  const fieldSources: QuotaFieldSources = {}
  for (const field of QUOTA_FIELD_NAMES) {
    const value =
      field === 'scoped'
        ? existingScoped
        : field === 'extraUsage'
          ? existingExtraUsage
          : field === 'fallbackAdvised'
            ? incomingFieldSources?.fallbackAdvised !== undefined
              ? incoming.fallbackAdvised
              : (existing?.fallbackAdvised ?? incoming.fallbackAdvised)
            : field === 'bindingWindow'
              ? existing?.bindingWindowSource === 'poll'
                ? existing?.bindingWindow
                : (incoming.bindingWindow ?? existing?.bindingWindow)
              : (incoming[field] ?? existing?.[field])
    if (value === undefined) continue
    const source =
      field === 'fallbackAdvised'
        ? (incomingFieldSources?.fallbackAdvised ??
          (existing?.fallbackAdvised !== undefined
            ? existingFieldSources
              ? existingFieldSources.fallbackAdvised
              : quotaFieldSource(existing, field)
            : undefined))
        : (field === 'scoped' || field === 'extraUsage') && value !== undefined
          ? 'poll'
          : field === 'bindingWindow' &&
              existing?.bindingWindowSource === 'poll' &&
              existing.bindingWindow !== undefined
            ? 'poll'
            : incoming[field] !== undefined
              ? (incomingFieldSources?.[field] ??
                quotaFieldSource(incoming, field))
              : (existingFieldSources?.[field] ??
                quotaFieldSource(existing, field))
    if (source) fieldSources[field] = source
  }
  if (quotaSnapshotOmitsFiveHour(existing) && !incoming.five_hour)
    fieldSources.five_hour = 'poll'

  return {
    ...existingWithoutPollOwnedFields,
    ...incomingWithoutPollOwnedFields,
    ...(Array.isArray(existingScoped) && { scoped: existingScoped }),
    ...(existingExtraUsage != null && { extraUsage: existingExtraUsage }),
    fallbackAdvised:
      incomingFieldSources?.fallbackAdvised !== undefined
        ? incoming.fallbackAdvised
        : (existing?.fallbackAdvised ?? incoming.fallbackAdvised),
    bindingWindow:
      existing?.bindingWindowSource === 'poll'
        ? existing.bindingWindow
        : (incoming.bindingWindow ?? existing?.bindingWindow),
    bindingWindowSource:
      existing?.bindingWindowSource === 'poll'
        ? 'poll'
        : (incoming.bindingWindowSource ?? existing?.bindingWindowSource),
    ...(Object.keys(fieldSources).length > 0 && { fieldSources }),
    // Keep the poll's absence evidence on its original clock so late header
    // or poll readings cannot resurrect the removed session limit.
    source: 'headers',
    ...(quotaSnapshotOmitsFiveHour(existing) && {
      checkedAt: existing.checkedAt,
    }),
  }
}
