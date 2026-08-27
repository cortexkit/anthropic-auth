import type {
  AccountQuotaWindow,
  OAuthQuotaSnapshot,
  QuotaWindowName,
} from './accounts.ts'

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
  const snapshot: OAuthQuotaSnapshot = {
    fallbackAdvised: headers.get(`${PREFIX}fallback`) === 'available',
    source: 'headers',
    checkedAt: now,
  }
  for (const [suffix, key] of Object.entries(WINDOW_KEYS)) {
    const window = normalizeWindow(headers, suffix, now)
    if (window) snapshot[key] = window
  }
  const representativeClaim = headers.get(`${PREFIX}representative-claim`)
  if (representativeClaim) {
    snapshot.bindingWindow = representativeClaim
    snapshot.bindingWindowSource = 'headers'
  }
  return snapshot
}

export function mergeHeaderQuotaSnapshot(
  existing: OAuthQuotaSnapshot | undefined,
  incoming: OAuthQuotaSnapshot,
): OAuthQuotaSnapshot {
  const {
    scoped: existingScoped,
    extraUsage: existingExtraUsage,
    ...existingWithoutPollOwnedFields
  } = existing ?? {}
  const {
    scoped: _incomingScoped,
    extraUsage: _incomingExtraUsage,
    ...incomingWithoutPollOwnedFields
  } = incoming

  return {
    ...existingWithoutPollOwnedFields,
    ...incomingWithoutPollOwnedFields,
    ...(Array.isArray(existingScoped) && { scoped: existingScoped }),
    ...(existingExtraUsage != null && { extraUsage: existingExtraUsage }),
    bindingWindow:
      existing?.bindingWindowSource === 'poll'
        ? existing.bindingWindow
        : (incoming.bindingWindow ?? existing?.bindingWindow),
    bindingWindowSource:
      existing?.bindingWindowSource === 'poll'
        ? 'poll'
        : (incoming.bindingWindowSource ?? existing?.bindingWindowSource),
    // Source tracks 5h/7d freshness; preserved scoped and credit fields remain poll-owned.
    source: 'headers',
  }
}
