export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
}

export interface AccountQuota {
  five_hour?: QuotaWindow
  seven_day?: QuotaWindow
}

export interface SidebarAccountState {
  id: string
  label: string | undefined
  quota: AccountQuota | null
  enabled: boolean
  // True when the account's refresh token is permanently dead (400
  // invalid_grant) and it needs a re-login — distinct from a transient backoff.
  needsReauth: boolean
}

export interface SidebarState {
  main: {
    quota: AccountQuota | null
    quotaBackedOff?: boolean
    quotaBackoffUntil?: number
    refreshBackedOff?: boolean
    refreshBackoffUntil?: number
  }
  fallbacks: SidebarAccountState[]
  activeId: string | undefined
  route: string
  relay: { enabled: boolean; transport: string } | null
  fastMode: boolean
  cacheKeep?: {
    enabled: boolean
    window?: string
    trackedSessions?: number
  }
  lastUpdated: number
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_FILE_ENV = 'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE'
const DEFAULT_STATE_DIR = join(tmpdir(), 'opencode-anthropic-auth')
const DEFAULT_STATE_FILE = join(DEFAULT_STATE_DIR, 'sidebar-state.json')

export function getSidebarStateFile(): string {
  return process.env[STATE_FILE_ENV] || DEFAULT_STATE_FILE
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  main: { quota: null },
  fallbacks: [],
  activeId: undefined,
  route: 'main',
  relay: null,
  fastMode: false,
  lastUpdated: 0,
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function normalizeSidebarState(raw: unknown): SidebarState {
  if (!isRecord(raw)) return { ...DEFAULT_SIDEBAR_STATE }

  const main: SidebarState['main'] = { quota: null }
  if (isRecord(raw.main)) {
    const m = raw.main
    main.quota = isRecord(m.quota) ? (m.quota as AccountQuota) : null
    if (typeof m.quotaBackedOff === 'boolean')
      main.quotaBackedOff = m.quotaBackedOff
    if (typeof m.quotaBackoffUntil === 'number')
      main.quotaBackoffUntil = m.quotaBackoffUntil
    if (typeof m.refreshBackedOff === 'boolean')
      main.refreshBackedOff = m.refreshBackedOff
    if (typeof m.refreshBackoffUntil === 'number')
      main.refreshBackoffUntil = m.refreshBackoffUntil
  }

  const fallbacks: SidebarAccountState[] = Array.isArray(raw.fallbacks)
    ? raw.fallbacks
        .filter(isRecord)
        .filter((entry) => typeof entry.id === 'string')
        .map((entry) => ({
          id: entry.id as string,
          label: typeof entry.label === 'string' ? entry.label : undefined,
          quota: isRecord(entry.quota) ? (entry.quota as AccountQuota) : null,
          enabled: typeof entry.enabled === 'boolean' ? entry.enabled : false,
          needsReauth:
            typeof entry.needsReauth === 'boolean' ? entry.needsReauth : false,
        }))
    : []

  let relay: SidebarState['relay'] = null
  if (isRecord(raw.relay)) {
    const r = raw.relay
    if (typeof r.enabled === 'boolean' && typeof r.transport === 'string') {
      relay = { enabled: r.enabled, transport: r.transport }
    }
  }

  let cacheKeep: SidebarState['cacheKeep']
  if (isRecord(raw.cacheKeep)) {
    const ck = raw.cacheKeep
    if (typeof ck.enabled === 'boolean') {
      cacheKeep = {
        enabled: ck.enabled,
        window: typeof ck.window === 'string' ? ck.window : undefined,
        trackedSessions:
          typeof ck.trackedSessions === 'number'
            ? ck.trackedSessions
            : undefined,
      }
    }
  }

  return {
    main,
    fallbacks,
    activeId: typeof raw.activeId === 'string' ? raw.activeId : undefined,
    route:
      typeof raw.route === 'string' ? raw.route : DEFAULT_SIDEBAR_STATE.route,
    relay,
    fastMode:
      typeof raw.fastMode === 'boolean'
        ? raw.fastMode
        : DEFAULT_SIDEBAR_STATE.fastMode,
    cacheKeep,
    lastUpdated: typeof raw.lastUpdated === 'number' ? raw.lastUpdated : 0,
  }
}

let writeChain: Promise<void> = Promise.resolve()

export async function getSidebarState(): Promise<SidebarState> {
  try {
    const raw = await readFile(getSidebarStateFile(), 'utf8')
    return normalizeSidebarState(JSON.parse(raw))
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

export async function setSidebarState(
  state: SidebarState,
  stateFile = getSidebarStateFile(),
): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(stateFile, JSON.stringify(state), 'utf8')
    })
    .catch(() => {
      // Best-effort — sidebar is non-critical
    })

  return writeChain
}

export async function drainSidebarWrites(): Promise<void> {
  return writeChain
}

// Resolve the currently-active account from activeId for the collapsed sidebar
// view. activeId === 'main' (or undefined/unmatched/disabled) → the main
// account; otherwise the enabled fallback whose id matches.
export function resolveActiveAccount(state: SidebarState): {
  id: string
  name: string
  quota: AccountQuota | null
} {
  const activeId = state.activeId
  if (activeId && activeId !== 'main') {
    // `account.enabled` is defensive: writeSidebarState already filters disabled
    // accounts out of state.fallbacks, so in normal operation every entry is
    // enabled. Kept so this pure helper stays correct for any caller and is
    // exercised directly by the unit tests.
    const fallback = state.fallbacks?.find(
      (account) => account.enabled && account.id === activeId,
    )
    if (fallback) {
      return {
        id: fallback.id,
        name: fallback.label ?? fallback.id,
        quota: fallback.quota,
      }
    }
  }
  return { id: 'main', name: 'main', quota: state.main?.quota ?? null }
}

export function getCollapsedQuotaSummary(quota: AccountQuota | null): {
  fiveHourUsedPercent: number | null
  sevenDayUsedPercent: number | null
  text: string | null
} {
  const fiveHourUsedPercent = quota?.five_hour?.usedPercent ?? null
  const sevenDayUsedPercent = quota?.seven_day?.usedPercent ?? null
  if (fiveHourUsedPercent == null && sevenDayUsedPercent == null) {
    return { fiveHourUsedPercent, sevenDayUsedPercent, text: null }
  }

  return {
    fiveHourUsedPercent,
    sevenDayUsedPercent,
    text: `5h: ${fiveHourUsedPercent == null ? '—' : `${Math.round(fiveHourUsedPercent)}%`} 7d: ${sevenDayUsedPercent == null ? '—' : `${Math.round(sevenDayUsedPercent)}%`}`,
  }
}

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

const PACING_MIN_ELAPSED_MS = 5 * 60 * 1000
const PACING_MIN_ELAPSED_FRACTION = 0.01
const ON_PACE_DELTA = 1

export interface QuotaPacing {
  pacePercent: number
  deltaPercent: number
  state: 'deficit' | 'reserve' | 'on-pace'
  runsOutAt: string | null
}

// Even-burn pacing for a quota window. The window start is inferred from the
// reset timestamp minus the window length. Two metrics: deltaPercent compares
// usage against a uniform burn-down (positive = deficit), and runsOutAt
// projects the current average burn rate forward — null means the window
// lasts until reset at that rate. Returns null when there is no reset
// timestamp or the elapsed time is too small to give a meaningful rate.
export function computeQuotaPacing(
  window: QuotaWindow,
  windowMs: number,
  now: number,
): QuotaPacing | null {
  if (!window.resetsAt) return null
  const resetsAt = new Date(window.resetsAt).getTime()
  if (!Number.isFinite(resetsAt)) return null
  const start = resetsAt - windowMs
  const elapsed = now - start
  if (elapsed < PACING_MIN_ELAPSED_MS) return null
  if (elapsed < windowMs * PACING_MIN_ELAPSED_FRACTION) return null
  if (elapsed >= windowMs) return null

  const used = window.usedPercent
  const pacePercent = Math.min(Math.max((elapsed / windowMs) * 100, 0), 100)
  const deltaPercent = used - pacePercent
  const state =
    Math.abs(deltaPercent) < ON_PACE_DELTA
      ? 'on-pace'
      : deltaPercent > 0
        ? 'deficit'
        : 'reserve'

  let runsOutAt: string | null = null
  if (used > 0) {
    const msToFull = (elapsed * 100) / used
    const runOut = start + msToFull
    if (runOut < resetsAt) runsOutAt = new Date(runOut).toISOString()
  }

  return { pacePercent, deltaPercent, state, runsOutAt }
}
