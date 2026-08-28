import type {
  AccountQuotaWindow,
  OAuthQuotaSnapshot,
  QuotaFieldSources,
  QuotaWindowName,
} from './accounts.ts'
import { QUOTA_FIELD_NAMES, quotaFieldSource } from './accounts.ts'

const PREFIX = 'anthropic-ratelimit-unified-'
const WINDOW_KEYS: Record<string, QuotaWindowName> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
}

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
  const resetSeconds = finiteHeaderNumber(headers, `${PREFIX}${suffix}-reset`)
  const resetDate =
    resetSeconds == null ? undefined : new Date(resetSeconds * 1000)
  const resetsAt =
    resetDate && Number.isFinite(resetDate.getTime())
      ? resetDate.toISOString()
      : undefined
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...(resetsAt && { resetsAt }),
    checkedAt,
  }
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
    // Top-level source remains headers for compatibility; fieldSources records ownership after partial harvests.
    source: 'headers',
  }
}
