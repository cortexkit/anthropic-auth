export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
}

export interface ScopedQuotaWindow extends QuotaWindow {
  id: string
  title: string
  modelId?: string
  modelName: string
}

export interface AccountQuota {
  five_hour?: QuotaWindow
  seven_day?: QuotaWindow
  scoped?: ScopedQuotaWindow[]
  extraUsage?: {
    used: { amountMinor: number; currency: string; exponent: number }
    limit: { amountMinor: number; currency: string; exponent: number }
    utilizationPercent?: number
    severity?: string
    exhausted: boolean
  }
  bindingWindow?: string
  fallbackAdvised?: boolean
}

export interface SidebarAccountState {
  id: string
  label: string | undefined
  quota: AccountQuota | null
  enabled: boolean
  // True when the account's refresh token is permanently dead (400
  // invalid_grant) and it needs a re-login — distinct from a transient backoff.
  needsReauth: boolean
  tierLabel?: string
}

export interface FableRecoverySidebarState {
  sessionId: string
  mode: 'opus' | 'fable'
  remaining: number
  changedAt: number
  /**
   * The model id the user originally requested (e.g. 'claude-fable-5' or
   * 'claude-opus-5'). Optional for backward compatibility with pre-Opus-5
   * state files; older recoveries default to Fable 5 in the summary.
   */
  requestedModelId?: string
}

export interface SidebarState {
  main: {
    quota: AccountQuota | null
    tierLabel?: string
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
  fableRecoveries?: FableRecoverySidebarState[]
  lastUpdated: number
}

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { logger } from '@cortexkit/anthropic-auth-core'

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

function normalizeQuotaWindow(value: unknown): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined
  const usedPercent = Number(value.usedPercent)
  const remainingPercent = Number(value.remainingPercent)
  if (!Number.isFinite(usedPercent) || !Number.isFinite(remainingPercent)) {
    return undefined
  }
  return {
    usedPercent,
    remainingPercent,
    resetsAt: typeof value.resetsAt === 'string' ? value.resetsAt : undefined,
  }
}

function normalizeAccountQuota(value: unknown): AccountQuota | null {
  if (!isRecord(value)) return null
  const quota: AccountQuota = {}
  const fiveHour = normalizeQuotaWindow(value.five_hour)
  const sevenDay = normalizeQuotaWindow(value.seven_day)
  if (fiveHour) quota.five_hour = fiveHour
  if (sevenDay) quota.seven_day = sevenDay

  if (Array.isArray(value.scoped)) {
    const scoped = value.scoped
      .map((entry): ScopedQuotaWindow | undefined => {
        if (!isRecord(entry)) return undefined
        const window = normalizeQuotaWindow(entry)
        if (!window) return undefined
        if (typeof entry.id !== 'string' || !entry.id.trim()) return undefined
        if (typeof entry.title !== 'string' || !entry.title.trim()) {
          return undefined
        }
        if (typeof entry.modelName !== 'string' || !entry.modelName.trim()) {
          return undefined
        }
        const modelId =
          typeof entry.modelId === 'string' && entry.modelId.trim()
            ? entry.modelId.trim()
            : undefined
        return {
          ...window,
          id: entry.id.trim(),
          title: entry.title.trim(),
          ...(modelId && { modelId }),
          modelName: entry.modelName.trim(),
        }
      })
      .filter((entry): entry is ScopedQuotaWindow => entry != null)
    // Preserve empty `[]` so a sidebar reader can distinguish "scoped owned
    // by anthropic-auth, none visible" from "no quota data at all". The OUTER
    // Array.isArray guard means pre-feature inputs without a `scoped` key are
    // not affected — only inputs that already carried an array reach this line.
    quota.scoped = scoped
  }

  if (isRecord(value.extraUsage)) {
    const used = normalizeQuotaMoney(value.extraUsage.used)
    const limit = normalizeQuotaMoney(value.extraUsage.limit)
    if (used && limit && typeof value.extraUsage.exhausted === 'boolean') {
      quota.extraUsage = {
        used,
        limit,
        ...(typeof value.extraUsage.utilizationPercent === 'number' &&
          Number.isFinite(value.extraUsage.utilizationPercent) && {
            utilizationPercent: value.extraUsage.utilizationPercent,
          }),
        ...(typeof value.extraUsage.severity === 'string' && {
          severity: value.extraUsage.severity,
        }),
        exhausted: value.extraUsage.exhausted,
      }
    }
  }
  if (typeof value.bindingWindow === 'string' && value.bindingWindow.trim()) {
    quota.bindingWindow = value.bindingWindow.trim()
  }
  if (typeof value.fallbackAdvised === 'boolean') {
    quota.fallbackAdvised = value.fallbackAdvised
  }

  return Object.keys(quota).length ? quota : null
}

function normalizeQuotaMoney(value: unknown) {
  if (!isRecord(value)) return undefined
  if (
    !Number.isInteger(value.amountMinor) ||
    typeof value.currency !== 'string' ||
    !/^[A-Za-z]{3}$/.test(value.currency.trim()) ||
    !Number.isInteger(value.exponent) ||
    (value.exponent as number) < 0 ||
    (value.exponent as number) > 20
  ) {
    return undefined
  }
  return {
    amountMinor: value.amountMinor as number,
    currency: value.currency.trim(),
    exponent: value.exponent as number,
  }
}

export function normalizeSidebarState(raw: unknown): SidebarState {
  if (!isRecord(raw)) return { ...DEFAULT_SIDEBAR_STATE }

  const main: SidebarState['main'] = { quota: null }
  if (isRecord(raw.main)) {
    const m = raw.main
    main.quota = normalizeAccountQuota(m.quota)
    if (typeof m.tierLabel === 'string' && m.tierLabel.trim()) {
      main.tierLabel = m.tierLabel.trim()
    }
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
          quota: normalizeAccountQuota(entry.quota),
          enabled: typeof entry.enabled === 'boolean' ? entry.enabled : false,
          needsReauth:
            typeof entry.needsReauth === 'boolean' ? entry.needsReauth : false,
          tierLabel:
            typeof entry.tierLabel === 'string' && entry.tierLabel.trim()
              ? entry.tierLabel.trim()
              : undefined,
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

  const fableRecoveries: FableRecoverySidebarState[] = Array.isArray(
    raw.fableRecoveries,
  )
    ? raw.fableRecoveries
        .filter(isRecord)
        .flatMap((recovery): FableRecoverySidebarState[] => {
          if (
            typeof recovery.sessionId !== 'string' ||
            (recovery.mode !== 'opus' && recovery.mode !== 'fable') ||
            typeof recovery.remaining !== 'number' ||
            !Number.isFinite(recovery.remaining) ||
            typeof recovery.changedAt !== 'number' ||
            !Number.isFinite(recovery.changedAt)
          )
            return []
          return [
            {
              sessionId: recovery.sessionId,
              mode: recovery.mode,
              remaining: Math.max(0, Math.floor(recovery.remaining)),
              changedAt: recovery.changedAt,
              requestedModelId:
                typeof recovery.requestedModelId === 'string'
                  ? recovery.requestedModelId
                  : undefined,
            },
          ]
        })
    : []

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
    fableRecoveries: fableRecoveries.length > 0 ? fableRecoveries : undefined,
    lastUpdated: typeof raw.lastUpdated === 'number' ? raw.lastUpdated : 0,
  }
}

let writeChain: Promise<void> = Promise.resolve()

// Wait through ordinary contention while staying below the 2s stale-eviction window.
const SIDEBAR_LOCK_BUDGET_MS = 1_000
const SIDEBAR_LOCK_STALE_MS = 2_000
const SIDEBAR_LOCK_RETRY_MIN_MS = 5
const SIDEBAR_LOCK_RETRY_MAX_MS = 15

interface SidebarStateWriteTestHooks {
  afterMergeRead?: (stateFile: string) => void | Promise<void>
  beforeRename?: (stateFile: string, tempFile: string) => void | Promise<void>
  afterRename?: (stateFile: string) => void | Promise<void>
  afterStaleLockStat?: (lockDir: string) => void | Promise<void>
  onStaleLockClaimed?: (lockDir: string) => void | Promise<void>
  onLockAcquired?: (lockDir: string) => void | Promise<void>
  beforeReleaseDirectoryRemoval?: (lockDir: string) => void | Promise<void>
  lockBudgetMs?: number
  lockRetryMinMs?: number
  lockRetryMaxMs?: number
}

let sidebarStateWriteTestHooks: SidebarStateWriteTestHooks | null = null

export function __setSidebarStateWriteTestHooks(
  hooks: SidebarStateWriteTestHooks | null,
): void {
  sidebarStateWriteTestHooks = hooks
}

// Boot-routing test hooks live here rather than in index.ts: the plugin entry
// module must export nothing beyond the plugin factory — opencode's plugin
// loader treats extra entry-point exports as plugin candidates and fails to
// load the plugin (same incident class as the removed
// __setBootProfileHydrationForTest export).
export interface InitialSidebarRoutingTestHooks {
  beforeSidebarRead?: () => void | Promise<void>
  beforeStorageLoad?: () => void | Promise<void>
  afterStorageLoad?: () => void | Promise<void>
}

let initialSidebarRoutingTestHooks: InitialSidebarRoutingTestHooks | null = null

export function __setInitialSidebarRoutingTestHooks(
  hooks: InitialSidebarRoutingTestHooks | null,
): void {
  initialSidebarRoutingTestHooks = hooks
}

export function getInitialSidebarRoutingTestHooks(): InitialSidebarRoutingTestHooks | null {
  return initialSidebarRoutingTestHooks
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireSidebarStateLock(stateFile: string): Promise<{
  release: () => Promise<void>
  ownsLock: () => Promise<boolean>
} | null> {
  const lockDir = `${stateFile}.lock`
  const budgetMs =
    sidebarStateWriteTestHooks?.lockBudgetMs ?? SIDEBAR_LOCK_BUDGET_MS
  const retryMinMs =
    sidebarStateWriteTestHooks?.lockRetryMinMs ?? SIDEBAR_LOCK_RETRY_MIN_MS
  const retryMaxMs =
    sidebarStateWriteTestHooks?.lockRetryMaxMs ?? SIDEBAR_LOCK_RETRY_MAX_MS
  const deadline = Date.now() + budgetMs

  while (true) {
    try {
      await mkdir(lockDir)
      const ownerId = randomUUID()
      const ownerFile = join(lockDir, ownerId)
      await writeFile(ownerFile, '', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await sidebarStateWriteTestHooks?.onLockAcquired?.(lockDir)
      return {
        ownsLock: async () => {
          try {
            await stat(ownerFile)
            return true
          } catch {
            return false
          }
        },
        release: async () => {
          // Unlinking this acquisition's unique file makes the filesystem reject
          // a stale release after eviction handed the path to a successor.
          try {
            await unlink(ownerFile)
          } catch {
            return
          }
          await sidebarStateWriteTestHooks?.beforeReleaseDirectoryRemoval?.(
            lockDir,
          )
          await rmdir(lockDir).catch(() => {})
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        logger.trace('sidebar', 'state lock unavailable; write skipped', {
          stateFile,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    }

    try {
      const lockStat = await stat(lockDir)
      if (Date.now() - lockStat.mtimeMs > SIDEBAR_LOCK_STALE_MS) {
        await sidebarStateWriteTestHooks?.afterStaleLockStat?.(lockDir)
        const evictedLockDir = `${lockDir}.evict-${process.pid}-${randomUUID()}`
        try {
          await rename(lockDir, evictedLockDir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        await sidebarStateWriteTestHooks?.onStaleLockClaimed?.(lockDir)
        await rm(evictedLockDir, { recursive: true, force: true }).catch(
          () => {},
        )
        continue
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      logger.trace('sidebar', 'state lock inspection failed; write skipped', {
        stateFile,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      logger.warn('sidebar', 'lock budget exhausted, write skipped', {
        stateFile,
        budgetMs,
      })
      return null
    }
    const jitterMs =
      retryMinMs + Math.floor(Math.random() * (retryMaxMs - retryMinMs + 1))
    await sleep(Math.min(jitterMs, remainingMs))
  }
}

export async function __acquireSidebarStateLockForTest(
  stateFile: string,
): Promise<(() => Promise<void>) | null> {
  return (await acquireSidebarStateLock(stateFile))?.release ?? null
}

async function writeSidebarStateAtomic(
  stateFile: string,
  state: SidebarState,
  ownsLock: () => Promise<boolean>,
): Promise<'written' | 'lock-lost-before-rename' | 'lock-lost-after-rename'> {
  const tempFile = `${stateFile}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tempFile, JSON.stringify(state), {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    if (!(await ownsLock())) {
      logger.trace('sidebar', 'state lock lost before rename; write aborted', {
        stateFile,
      })
      await rm(tempFile, { force: true }).catch(() => {})
      return 'lock-lost-before-rename'
    }
    await sidebarStateWriteTestHooks?.beforeRename?.(stateFile, tempFile)
    // No production await separates this ownership fence from rename. A process
    // freeze between the adjacent syscalls remains possible, so rename is also
    // fenced from the other side below.
    if (!(await ownsLock())) {
      logger.trace('sidebar', 'state lock lost before rename; write aborted', {
        stateFile,
      })
      await rm(tempFile, { force: true }).catch(() => {})
      return 'lock-lost-before-rename'
    }
    await rename(tempFile, stateFile)
    await sidebarStateWriteTestHooks?.afterRename?.(stateFile)
    if (!(await ownsLock())) return 'lock-lost-after-rename'
    return 'written'
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {})
    throw error
  }
}

export async function getSidebarState(
  stateFile = getSidebarStateFile(),
): Promise<SidebarState> {
  try {
    const raw = await readFile(stateFile, 'utf8')
    return normalizeSidebarState(JSON.parse(raw))
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

export interface SidebarStateWriteOptions {
  routingAuthoritative?: boolean
  resolvePreservedRouting?: (current: SidebarState) =>
    | (Pick<SidebarState, 'activeId' | 'route'> & {
        state?: SidebarState
      })
    | undefined
    | Promise<
        | (Pick<SidebarState, 'activeId' | 'route'> & {
            state?: SidebarState
          })
        | undefined
      >
  onRoutingResolved?: (
    routing: Pick<SidebarState, 'activeId' | 'route'>,
  ) => void
}

export async function setSidebarState(
  state: SidebarState,
  stateFile = getSidebarStateFile(),
  options: SidebarStateWriteOptions = {},
): Promise<void> {
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(stateFile), { recursive: true })
      for (let attempt = 0; attempt < 2; attempt++) {
        const repairingPostRenameLoss = attempt === 1
        const lock = await acquireSidebarStateLock(stateFile)
        // Sidebar frames are display-only and refresh within seconds; dropping one
        // is safer than clobbering routing state that may stay authoritative until
        // another process handles its next request.
        if (!lock) {
          if (repairingPostRenameLoss) {
            logger.warn(
              'sidebar',
              'post-rename repair lock unavailable; write skipped',
              { stateFile },
            )
          }
          return
        }

        let stateToWrite = state
        let result:
          | 'written'
          | 'lock-lost-before-rename'
          | 'lock-lost-after-rename'
        try {
          if (options.routingAuthoritative === false) {
            const current = await getSidebarState(stateFile)
            const preservedRouting =
              await options.resolvePreservedRouting?.(current)
            if (preservedRouting) {
              const preservedState = preservedRouting.state ?? state
              stateToWrite = {
                ...preservedState,
                activeId: preservedRouting.activeId,
                route: preservedRouting.route,
                lastUpdated: Math.max(
                  preservedState.lastUpdated,
                  current.lastUpdated,
                ),
              }
            }
            await sidebarStateWriteTestHooks?.afterMergeRead?.(stateFile)
          } else if (repairingPostRenameLoss) {
            const current = await getSidebarState(stateFile)
            // A successor owns its fresh account/quota and recovery snapshots;
            // this routing frame may only republish its decision and shared UI state.
            stateToWrite = {
              ...current,
              activeId: state.activeId,
              route: state.route,
              relay: state.relay,
              fastMode: state.fastMode,
              cacheKeep: state.cacheKeep,
              lastUpdated: Math.max(current.lastUpdated, state.lastUpdated),
            }
          }
          result = await writeSidebarStateAtomic(
            stateFile,
            stateToWrite,
            lock.ownsLock,
          )
        } finally {
          await lock.release()
        }

        if (result === 'lock-lost-after-rename') {
          if (repairingPostRenameLoss) {
            logger.warn(
              'sidebar',
              'post-rename repair lost lock; write skipped',
              { stateFile },
            )
            return
          }
          logger.warn(
            'sidebar',
            'state lock lost after rename; repairing write',
            {
              stateFile,
            },
          )
          continue
        }
        if (result === 'lock-lost-before-rename') return
        options.onRoutingResolved?.({
          activeId: stateToWrite.activeId,
          route: stateToWrite.route,
        })
        return
      }
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

export function formatScopedQuotaLabel(title: string) {
  const label = title.replace(/\s+only$/i, '').trim()
  return /^fable$/i.test(label) ? 'Fa' : label
}

/**
 * Pretty label for a recoverable-refusal source model (Fable 5 or Opus 5).
 * Falls back to the raw id for unrecognized ids so the sidebar never goes
 * blank on a future model that has not yet been cataloged here.
 */
export function formatFallbackModelLabel(modelId: string | undefined): string {
  if (modelId === 'claude-fable-5' || modelId?.startsWith('claude-fable-5-'))
    return 'Fable 5'
  if (modelId === 'claude-opus-5' || modelId?.startsWith('claude-opus-5-'))
    return 'Opus 5'
  return modelId ?? 'Fable 5'
}

export function getFableRecoverySummary(
  state: SidebarState,
  sessionId: string,
): string | undefined {
  const recovery = state.fableRecoveries?.find(
    (candidate) => candidate.sessionId === sessionId,
  )
  if (!recovery) return undefined
  if (recovery.mode === 'fable') {
    return `${formatFallbackModelLabel(recovery.requestedModelId)} · restored`
  }
  return `Opus 4.8 · ${recovery.remaining} left`
}

export function getCollapsedQuotaSummary(quota: AccountQuota | null): {
  fiveHourUsedPercent: number | null
  sevenDayUsedPercent: number | null
  scopedUsedPercents: number[]
  text: string | null
} {
  const fiveHourUsedPercent = quota?.five_hour?.usedPercent ?? null
  const sevenDayUsedPercent = quota?.seven_day?.usedPercent ?? null
  const scoped = quota?.scoped ?? []
  const scopedUsedPercents = scoped.map((window) => window.usedPercent)
  if (
    fiveHourUsedPercent == null &&
    sevenDayUsedPercent == null &&
    scoped.length === 0
  ) {
    return {
      fiveHourUsedPercent,
      sevenDayUsedPercent,
      scopedUsedPercents,
      text: null,
    }
  }

  const scopedSegments = scoped.map(
    (window) =>
      `${formatScopedQuotaLabel(window.title)}: ${Math.round(window.usedPercent)}%`,
  )
  const primarySegments =
    fiveHourUsedPercent == null && sevenDayUsedPercent == null
      ? []
      : [
          `5h: ${fiveHourUsedPercent == null ? '—' : `${Math.round(fiveHourUsedPercent)}%`}`,
          `7d: ${sevenDayUsedPercent == null ? '—' : `${Math.round(sevenDayUsedPercent)}%`}`,
        ]

  return {
    fiveHourUsedPercent,
    sevenDayUsedPercent,
    scopedUsedPercents,
    text: [...primarySegments, ...scopedSegments].join(' '),
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
