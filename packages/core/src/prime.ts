import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type AccountQuotaWindow,
  type AccountStorage,
  type FallbackAccount,
  isOAuthAccount,
  isPermanentRefreshError,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
  type PrimeUsageCounters,
} from './accounts.ts'
import { logger } from './logger.ts'
import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_HAIKU_4_5_PRICING,
} from './models.ts'

// Re-export pricing for downstream packages that import it through core's
// public surface (the test suite verifies exact per-million-token values).
export { CLAUDE_HAIKU_4_5_PRICING }

/**
 * `/claude-prime` — opt-in 5h quota window priming. Default OFF.
 *
 * Every OAuth account (main + enabled fallbacks) gets one minimal request
 * fired ~60s after its `five_hour.resetsAt`, exactly once across concurrent
 * OpenCode processes. Catch-up on boot; redundancy guard via fresh quota
 * check; cross-process atomic marker claim via `writeFile(..., flag: 'wx')`.
 */

export const CLAUDE_PRIME_COMMAND_NAME = 'claude-prime'

export const PRIME_TICK_MS = 60_000
export const PRIME_DUE_OFFSET_MS = 60_000
export const PRIME_MARKER_MAX_AGE_MS = 6 * 60 * 60_000
export const PRIME_POST_FIRE_REFRESH_MS = 90_000
/** Minimum interval between forced quota checks for an unchanged reset epoch. */
export const PRIME_CHECK_THROTTLE_MS = 5 * 60_000

export type PrimeCommandAction =
  | { type: 'status' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'usage' }

export type PrimeAccountStatus = {
  id: string
  label: string
  nextDueAt?: number
  lastPrimedAt?: number | null
  lastResult?: 'ok' | 'error'
  usage?: import('./accounts.ts').PrimeUsageCounters
  estimatedCostUsd?: number
}

export type PrimeSendResult =
  | {
      ok: true
      status: number
      ms: number
      usage?: { inputTokens?: number; outputTokens?: number }
    }
  | {
      ok: false
      status?: number
      ms?: number
      error: string
      // Discriminates the failure kind so the manager can emit the
      // spec Logging table's two distinct warn events: `prime token
      // refresh failed` (warn · prime · { account, error }) for
      // token-refresh failures, `prime fire failed` (warn · prime ·
      // { account, status?, error }) for HTTP / fetch / identity
      // failures during the request itself.
      reason?: 'token-refresh' | 'send'
    }

/**
 * Pure command parser — accepts `''` / `on` / `off` and treats anything else
 * as a usage error. Mirrors `parseFastModeCommandAction` shape so all
 * `claude-*` commands stay uniform.
 */
export function parsePrimeCommandAction(input: string): PrimeCommandAction {
  const normalized = input.trim().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'status' }
  if (normalized.length === 1 && normalized[0] === 'on')
    return { type: 'enable' }
  if (normalized.length === 1 && normalized[0] === 'off')
    return { type: 'disable' }
  return { type: 'usage' }
}

/**
 * Per-million-token USD cost projection. Locale-independent math; the display
 * layer is responsible for formatting. Returns 0 for absent counters so
 * pre-fire accounts still get a clean number in the sidebar/dialog.
 */
export function estimatePrimeCostUsd(
  usage?: import('./accounts.ts').PrimeUsageCounters,
): number {
  if (!usage) return 0
  return (
    (usage.inputTokens * CLAUDE_HAIKU_4_5_PRICING.input +
      usage.outputTokens * CLAUDE_HAIKU_4_5_PRICING.output) /
    1_000_000
  )
}

function accountLabel(
  id: string,
  storage: AccountStorage | null,
  fallbackAccount?: { label?: string },
): string {
  if (fallbackAccount?.label?.trim()) return fallbackAccount.label
  if (id === 'main') return 'main'
  // Stale-storage fallback: the caller passed a non-empty storage so prefer
  // the first matching account label.
  const found = storage?.accounts?.find((a) => a.id === id)
  if (found?.label?.trim()) return found.label
  return id
}

/**
 * Project per-account prime status. Enumerates a synthetic `main` plus each
 * enabled OAuth fallback. `nextDueAt` is the stored five-hour reset plus
 * `PRIME_DUE_OFFSET_MS`; null when no reset is known. Manager-transient
 * `lastPrimedAt`/`lastResult` overlay the persisted counters so the dialog and
 * sidebar can show "just attempted" without waiting for the next save.
 */
export function buildPrimeAccountStatuses(
  storage: AccountStorage | null,
  options?: {
    now?: number
    transient?: ReadonlyMap<
      string,
      { lastPrimedAt?: number; lastResult?: 'ok' | 'error' }
    >
  },
): PrimeAccountStatus[] {
  const transient = options?.transient
  const mainStoredQuota = storage?.quota?.mainQuota
  const mainUsage = storage?.prime?.main
  const mainStatus: PrimeAccountStatus = {
    id: 'main',
    label: 'main',
    nextDueAt: primeNextDueAt(mainStoredQuota?.five_hour),
    lastPrimedAt: transient?.get('main')?.lastPrimedAt ?? null,
    lastResult: transient?.get('main')?.lastResult,
    usage: mainUsage,
    estimatedCostUsd: estimatePrimeCostUsd(mainUsage),
  }

  const fallbacks: PrimeAccountStatus[] = (storage?.accounts ?? [])
    .filter(isOAuthAccount)
    .filter((account) => account.id !== 'main')
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      id: account.id,
      label: accountLabel(account.id, storage, account),
      nextDueAt: primeNextDueAt(account.quota?.five_hour),
      lastPrimedAt: transient?.get(account.id)?.lastPrimedAt ?? null,
      lastResult: transient?.get(account.id)?.lastResult,
      usage: account.prime,
      estimatedCostUsd: estimatePrimeCostUsd(account.prime),
    }))

  return [mainStatus, ...fallbacks]
}

function primeNextDueAt(window?: AccountQuotaWindow): number | undefined {
  if (!window?.resetsAt) return undefined
  const ms = Date.parse(window.resetsAt)
  if (!Number.isFinite(ms)) return undefined
  return ms + PRIME_DUE_OFFSET_MS
}

/**
 * Pure multi-line status summary shared by the OpenCode dialog, the sidebar
 * expanded row, and the Pi display. Title is stable text the dialog uses to
 * anchor and the orchestrator uses to assert RED.
 */
export function buildPrimeStatusSummary(input: {
  enabled: boolean
  accounts: PrimeAccountStatus[]
}): string {
  const header = input.enabled
    ? '## Claude Prime Status'
    : '## Claude Prime Disabled'
  const lines: string[] = [header, '']
  lines.push(`Status: ${input.enabled ? 'enabled' : 'disabled'}`)
  lines.push('')
  lines.push('Accounts:')
  for (const account of input.accounts) {
    const usage = account.usage
    const count = usage?.count ?? 0
    const due = formatDue(account.nextDueAt)
    const primed = formatPrimed(account.lastPrimedAt, account.lastResult)
    const segments: string[] = [`${account.label}`]
    if (due) segments.push(`next prime ${due}`)
    if (primed) segments.push(primed)
    if (count > 0) {
      segments.push(
        `${count} ${count === 1 ? 'prime' : 'primes'} \u2248 $${formatUsd(
          account.estimatedCostUsd ?? 0,
        )}`,
      )
    }
    lines.push(`- ${segments.join(' · ')}`)
  }
  lines.push('')
  lines.push('Usage: `/claude-prime on`, `/claude-prime off`, or status.')
  return lines.join('\n')
}

function formatDue(nextDueAt: number | null | undefined): string {
  if (typeof nextDueAt !== 'number') return ''
  return new Date(nextDueAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatPrimed(
  lastPrimedAt: number | null | undefined,
  lastResult: 'ok' | 'error' | undefined,
): string {
  if (typeof lastPrimedAt !== 'number') return ''
  const time = new Date(lastPrimedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (lastResult === 'error') return `primed ${time} err`
  return `primed ${time} \u2713`
}

function formatUsd(value: number): string {
  if (value === 0) return '0'
  if (value < 0.0001) return value.toExponential(2)
  return value.toFixed(Math.min(6, Math.max(0, 4)))
}

/**
 * Pure executor — returns markdown text and an optional `updated` envelope.
 * Effects (persistent toggle, manager start/stop) are the caller's job; Pi
 * uses this same function in display-only mode.
 */
export function executePrimeCommand(input: {
  argumentsText: string
  enabled: boolean
  accounts: PrimeAccountStatus[]
}): { text: string; updated?: { enabled: boolean } } {
  const action = parsePrimeCommandAction(input.argumentsText)

  if (action.type === 'status') {
    return {
      text: buildPrimeStatusSummary({
        enabled: input.enabled,
        accounts: input.accounts,
      }),
    }
  }

  if (action.type === 'enable') {
    return {
      text: buildPrimeStatusSummary({
        enabled: true,
        accounts: input.accounts,
      }),
      updated: { enabled: true },
    }
  }

  if (action.type === 'disable') {
    return {
      text: buildPrimeStatusSummary({
        enabled: false,
        accounts: input.accounts,
      }),
      updated: { enabled: false },
    }
  }

  return {
    text: [
      '## Claude Prime Usage',
      '',
      'Usage: `/claude-prime`, `/claude-prime on`, or `/claude-prime off`.',
      '',
      buildPrimeStatusSummary({
        enabled: input.enabled,
        accounts: input.accounts,
      }),
    ].join('\n'),
  }
}

/**
 * Which gate of the eligibility check failed. The manager logs the human
 * reason string on every ineligible account (including API-key and
 * disabled), per the spec's Logging table.
 */
export type PrimeEligibilityReason =
  | 'not-oauth'
  | 'disabled'
  | 'needs-reauth'
  | 'killswitch'

export type PrimeEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: PrimeEligibilityReason }

const ELIGIBILITY_REASON_LABEL: Record<PrimeEligibilityReason, string> = {
  'not-oauth': 'API-key account',
  disabled: 'disabled',
  'needs-reauth': 'needs re-login',
  killswitch: 'killswitch',
}

/**
 * Eligibility check shared by the manager tick and the dialog preview.
 * Returns a discriminated result so the manager can log a specific reason
 * per the spec's Logging table. Quota policy is evaluated authoritatively on
 * the fresh snapshot immediately before claim.
 */
export function primeIsEligible(input: {
  storage: AccountStorage | null
  accountId: 'main' | string
  isOAuth: boolean
  isEnabled: boolean
  hasPermanentRefreshError: boolean
  quota?: OAuthQuotaSnapshot
}): PrimeEligibilityResult {
  if (!input.isOAuth) return { eligible: false, reason: 'not-oauth' }
  if (!input.isEnabled) return { eligible: false, reason: 'disabled' }
  if (input.hasPermanentRefreshError)
    return { eligible: false, reason: 'needs-reauth' }
  return { eligible: true }
}

export function primeEligibilityReasonLabel(
  reason: PrimeEligibilityReason,
): string {
  return ELIGIBILITY_REASON_LABEL[reason]
}

export const PRIME_REQUEST_BODY = {
  model: CLAUDE_HAIKU_4_5_MODEL_ID,
  max_tokens: 1,
  system: 'Reply with 1 when you receive 0.',
  messages: [{ role: 'user', content: '0' }],
} as const

export function buildPrimeRequestBody(): {
  model: string
  max_tokens: number
  system: string
  messages: Array<{ role: 'user'; content: string }>
} {
  // Copy to keep callers from accidentally mutating the canonical frozen body.
  return JSON.parse(JSON.stringify(PRIME_REQUEST_BODY))
}

// -- PrimeManager -----------------------------------------------------------

/**
 * Refresh result from a fresh-check. `fresh=false` means the adapter
 * returned a cached snapshot (e.g. quota API in 429-backoff, or another
 * process holds the quota file lock). PrimeManager treats a stale
 * result as "do not claim, retry next tick" so a cached past
 * `resetsAt` can never cause a duplicate prime against an
 * already-started window.
 */
export type PrimeRefreshResult = {
  quota: OAuthQuotaSnapshot
  fresh: boolean
}

type AccountEvaluation = {
  id: 'main' | string
  label: string
  isOAuth: boolean
  isEnabled: boolean
  hasPermanentRefreshError: boolean
  storedQuota?: OAuthQuotaSnapshot
  storedFiveHour?: AccountQuotaWindow
}

function defaultMarkerDir(): string {
  return join(tmpdir(), 'opencode-anthropic-auth', 'prime')
}

export function primeStorageFingerprint(storagePath: string): string {
  const absolutePath = resolve(storagePath)
  let canonicalPath: string
  try {
    canonicalPath = realpathSync(absolutePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    canonicalPath = absolutePath
  }
  return createHash('sha256').update(canonicalPath).digest('hex').slice(0, 12)
}

export function primeMarkerNamespaceDir(
  markerDir: string,
  storagePath: string,
): string {
  // Legacy root markers are intentionally not migrated: an upgrade may send
  // one extra Haiku request per account, whose usage is measured from response
  // accounting, then the namespaced claim self-heals.
  return join(markerDir, primeStorageFingerprint(storagePath))
}

export function primeAccountMarkerDir(
  markerDir: string,
  storagePath: string,
  accountFingerprint: string,
): string {
  if (!/^[a-f0-9]{12,}$/i.test(accountFingerprint)) {
    throw new Error('Prime account fingerprint must be a hexadecimal digest')
  }
  return join(
    primeMarkerNamespaceDir(markerDir, storagePath),
    accountFingerprint.toLowerCase().slice(0, 12),
  )
}

export function primeMarkerPath(
  markerDir: string,
  accountId: 'main' | string,
  resetsAtEpochMs: number,
): string {
  return join(markerDir, `${encodeURIComponent(accountId)}-${resetsAtEpochMs}`)
}

function primeBootstrapMarkerPath(
  markerDir: string,
  accountId: 'main' | string,
): string {
  return join(markerDir, `${encodeURIComponent(accountId)}-bootstrap`)
}

function primeAccountLabel(
  id: 'main' | string,
  fallback?: FallbackAccount,
): string {
  if (id === 'main') return 'main'
  if (fallback && 'label' in fallback && fallback.label?.trim()) {
    return fallback.label
  }
  return id
}

/**
 * Build the list of accounts the manager should evaluate EVERY tick.
 * Includes disabled and API-key accounts so the eligibility log fires
 * for them too (the spec Logging table mandates the debug log for
 * every non-eligible case so operators can troubleshoot). Filter for
 * the actual fire decision happens via `primeIsEligible`.
 */
function evaluateAccounts(storage: AccountStorage): AccountEvaluation[] {
  const evaluations: AccountEvaluation[] = []
  const mainRefreshError = storage.refresh?.mainLastRefreshError
  evaluations.push({
    id: 'main',
    label: 'main',
    isOAuth: true,
    isEnabled: true,
    hasPermanentRefreshError: isPermanentRefreshError(mainRefreshError),
    storedQuota: storage.quota?.mainQuota,
    storedFiveHour: storage.quota?.mainQuota?.five_hour,
  })
  for (const account of storage.accounts ?? []) {
    if (account.id === 'main') {
      logger.debug('prime', 'ineligible', {
        account: primeAccountLabel(account.id, account),
        reason: 'reserved-id',
      })
      continue
    }
    if (!isOAuthAccount(account)) {
      // API-key accounts are surfaced here so the eligibility-skip debug
      // log fires once per tick and an operator can confirm the
      // account won't prime. The check itself is in `primeIsEligible`.
      evaluations.push({
        id: account.id,
        label: primeAccountLabel(account.id, account),
        isOAuth: false,
        isEnabled: account.enabled !== false,
        hasPermanentRefreshError: false,
      })
      continue
    }
    evaluations.push({
      id: account.id,
      label: primeAccountLabel(account.id, account),
      isOAuth: true,
      isEnabled: account.enabled !== false,
      hasPermanentRefreshError: isPermanentRefreshError(
        account.lastRefreshError,
      ),
      storedQuota: account.quota,
      storedFiveHour: account.quota?.five_hour,
    })
  }
  return evaluations
}

function storedResetMs(window?: AccountQuotaWindow): number | undefined {
  if (!window?.resetsAt) return undefined
  const ms = Date.parse(window.resetsAt)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Scheduler for `/claude-prime`. Mirrors `CacheKeepManager` lifecycle (unref'd
 * 60s interval, idempotent start/stop, swallowed tick errors) but adds the
 * cross-process atomic marker claim before firing — exactly one OpenCode
 * process fires per reset epoch even with N concurrent instances.
 *
 * Dependencies are injected so the manager can be exercised deterministically
 * without filesystem, network, or live OAuth state.
 */
export type PrimeManagerOptions = {
  loadStorage: () => Promise<AccountStorage | null>
  /** Returns a non-secret digest, or undefined when identity is unavailable. */
  getAccountFingerprint: (
    accountId: 'main' | string,
  ) => Promise<string | undefined>
  refreshQuota: (accountId: 'main' | string) => Promise<PrimeRefreshResult>
  sendPrime: (accountId: 'main' | string) => Promise<PrimeSendResult>
  recordSuccess: (
    accountId: 'main' | string,
    usage: { inputTokens?: number; outputTokens?: number },
  ) => Promise<PrimeUsageCounters>
  now?: () => number
  markerDir?: string
  storagePath: string
}

export class PrimeManager {
  private timer: ReturnType<typeof setInterval> | null = null
  private postFireRefreshTimers = new Set<ReturnType<typeof setTimeout>>()
  private lastForcedCheck = new Map<
    string,
    { at: number; resetEpoch: number | undefined }
  >()
  // Set true by `stop()` so a tick already in flight can short-circuit
  // before claim/send, preventing a stale in-flight cycle from firing
  // after `/claude-prime off` or after a newer plugin invocation has
  // replaced this instance (M3b).
  private stopped = false
  // The registry replaces this dependency bundle on plugin reload so the
  // singleton manager cannot retain closures from an obsolete plugin context.
  public options: PrimeManagerOptions
  // Per-account transient state from the last ATTEMPT — overlays persisted
  // counters in `stats()` so the sidebar/dialog can show "just attempted"
  // without waiting for the next save. NOT persisted.
  //
  // Crucially, fresh-check skips do NOT touch this map. Only an actual
  // claim+fire attempt mutates it. See `runForAccount` for the invariant
  // (M4): skip is not the same as a successful prime.
  private transient = new Map<
    string,
    { lastPrimedAt: number; lastResult: 'ok' | 'error' }
  >()
  // Latest cumulative counters returned by recordSuccess. Overlays the
  // persisted counters in stats() before the next load persists them.
  private counters = new Map<'main' | string, PrimeUsageCounters>()
  // Per-account "window active" observation from the most recent fresh
  // check (M4). Surfaced in the status as the rendered "— window active"
  // text; independent of lastPrimedAt/lastResult.
  private windowActive = new Map<'main' | string, number>()

  constructor(options: PrimeManagerOptions) {
    this.options = options
  }

  updateOptions(options: PrimeManagerOptions): void {
    this.options = options
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    logger.trace('prime', 'manager started')
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        logger.warn('prime', 'tick failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, PRIME_TICK_MS)
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  stop(): void {
    const hadTimer = this.timer !== null
    const hadPostFireRefresh = this.postFireRefreshTimers.size > 0
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const timer of this.postFireRefreshTimers) clearTimeout(timer)
    this.postFireRefreshTimers.clear()
    this.lastForcedCheck.clear()
    if (!hadTimer && !hadPostFireRefresh) return
    logger.trace('prime', 'manager stopped')
  }

  isStopped(): boolean {
    return this.stopped
  }

  async tick(): Promise<void> {
    const now = this.options.now?.() ?? Date.now()
    logger.trace('prime', 'tick start', { now })
    await this.sweepMarkers(now)
    if (this.stopped) {
      logger.trace('prime', 'tick: stopped, aborting')
      return
    }
    // Re-load persisted state at the start of every tick. The previous
    // read may pre-date an `/claude-prime off` from another process or
    // a settings edit (M3b).
    const storage = await this.options.loadStorage()
    if (!storage) {
      logger.trace('prime', 'tick: no storage, skipping')
      return
    }
    if (storage.prime?.enabled !== true) {
      logger.trace('prime', 'tick: feature disabled, skipping')
      return
    }
    const evaluations = evaluateAccounts(storage)
    await Promise.all(
      evaluations.map((evaluation) =>
        this.runForAccount(evaluation, storage, now),
      ),
    )
    logger.trace('prime', 'tick end')
  }

  /**
   * Project cumulative per-account status for the sidebar and dialog. Machine
   * values only — formatting belongs in the TUI/sidebar/Pi layer.
   */
  stats(
    storage?: AccountStorage | null,
    nowArg?: number,
  ): PrimeAccountStatus[] {
    const baseStatuses = buildPrimeAccountStatuses(storage ?? null, {
      now: nowArg,
      transient: this.transient,
    })
    if (this.counters.size === 0) return baseStatuses
    return baseStatuses.map((status) => {
      const overlay = this.counters.get(status.id)
      if (!overlay) return status
      return {
        ...status,
        usage: overlay,
        estimatedCostUsd: estimatePrimeCostUsd(overlay),
      }
    })
  }

  /** True if the most recent fresh-check observed the window as already running. */
  isWindowActive(accountId: 'main' | string): boolean {
    return this.windowActive.has(accountId)
  }

  private async runForAccount(
    evaluation: AccountEvaluation,
    storage: AccountStorage,
    now: number,
  ): Promise<void> {
    try {
      if (this.stopped) return

      const eligibility = primeIsEligible({
        storage,
        accountId: evaluation.id,
        isOAuth: evaluation.isOAuth,
        isEnabled: evaluation.isEnabled,
        hasPermanentRefreshError: evaluation.hasPermanentRefreshError,
        quota: evaluation.storedQuota,
      })
      if (!eligibility.eligible) {
        // Per spec Logging table: every stored-state ineligible case (disabled /
        // needs-reauth / API-key) emits a debug log carrying
        // the account's display label and the specific reason. `trace`
        // would hide this from operators troubleshooting "why isn't prime
        // firing for my X account".
        logger.debug('prime', 'ineligible', {
          account: evaluation.label,
          reason: primeEligibilityReasonLabel(eligibility.reason),
        })
        return
      }

      const storedResetEpoch = storedResetMs(evaluation.storedFiveHour)
      if (
        storedResetEpoch !== undefined &&
        now < storedResetEpoch + PRIME_DUE_OFFSET_MS
      ) {
        // "Not due" is a routine tick outcome, not an operator-visible
        // diagnostic. Per the spec's `trace` row for tick evaluation.
        logger.trace('prime', 'not due', { account: evaluation.label })
        return
      }

      const accountFingerprint = await this.options.getAccountFingerprint(
        evaluation.id,
      )
      if (!accountFingerprint) {
        logger.debug('prime', 'credential identity unavailable', {
          account: evaluation.label,
        })
        return
      }
      const claimIdentity = `${evaluation.id}:${accountFingerprint
        .toLowerCase()
        .slice(0, 12)}`
      const markerDir = this.markerDir(accountFingerprint)
      const bootstrapMarkerPath = primeBootstrapMarkerPath(
        markerDir,
        evaluation.id,
      )

      const expectedMarkerPath =
        storedResetEpoch === undefined
          ? bootstrapMarkerPath
          : primeMarkerPath(markerDir, evaluation.id, storedResetEpoch)
      try {
        await stat(expectedMarkerPath)
        // A completed claim makes another forced poll redundant; the normal
        // background refresh will persist the reset when the usage API catches up.
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (
        storedResetEpoch === undefined &&
        (await this.hasAnyClaimMarker(evaluation.id, accountFingerprint))
      ) {
        // The bootstrap sentinel is replaced only after an epoch claim exists.
        // A stale process must observe one side of that transition.
        return
      }
      if (this.stopped) return

      // Binding the throttle to the observed epoch preserves the immediate
      // check when a newly passed reset replaces the previous window.
      const lastForcedCheck = this.lastForcedCheck.get(claimIdentity)
      if (
        lastForcedCheck !== undefined &&
        lastForcedCheck.resetEpoch === storedResetEpoch &&
        now < lastForcedCheck.at + PRIME_CHECK_THROTTLE_MS
      ) {
        return
      }
      this.lastForcedCheck.set(claimIdentity, {
        at: now,
        resetEpoch: storedResetEpoch,
      })

      let refreshed: PrimeRefreshResult
      try {
        refreshed = await this.options.refreshQuota(evaluation.id)
      } catch (error) {
        // Quota fresh-check failure: skip this tick without consuming a claim.
        logger.warn('prime', 'refresh failed', {
          account: evaluation.label,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      // Re-check stop + persist opt-in after every await boundary so
      // an `/claude-prime off` (or a newer plugin instance's stop())
      // aborts the cycle BEFORE claim or send (M3b).
      if (this.stopped) return
      const reloaded = await this.options.loadStorage()
      if (reloaded?.prime?.enabled !== true) return

      const fresh = refreshed.quota
      // Stale fresh-check: the adapter returned a cached snapshot (quota
      // API 429-backoff, another process owns the file lock, or the
      // account was just refreshed by someone else). Skip without
      // claiming — a cached past `resetsAt` would otherwise let us
      // prime against an already-started window. Retry next tick.
      if (!refreshed.fresh) {
        logger.debug('prime', 'stale fresh-check', {
          account: evaluation.label,
        })
        return
      }

      if (
        !killswitchPassesPolicy(
          fresh,
          reloaded,
          evaluation.id,
          CLAUDE_HAIKU_4_5_MODEL_ID,
        )
      ) {
        logger.debug('prime', 'ineligible', {
          account: evaluation.label,
          reason: primeEligibilityReasonLabel('killswitch'),
        })
        return
      }

      const freshResetEpoch = storedResetMs(fresh?.five_hour)
      if (freshResetEpoch !== undefined && freshResetEpoch > now) {
        // Window already started by a real request. Track the active-
        // window observation separately (M4) so the status renderer can
        // show "— window active" without conflating it with a successful
        // prime. Do NOT touch lastPrimedAt / lastResult.
        logger.debug('prime', 'window active', {
          account: evaluation.label,
          resetsAt: fresh.five_hour?.resetsAt,
        })
        this.windowActive.set(evaluation.id, now)
        return
      }
      this.windowActive.delete(evaluation.id)

      const markerEpoch = freshResetEpoch ?? storedResetEpoch
      const markerPath =
        markerEpoch === undefined
          ? await this.tryClaimBootstrap(evaluation.id, accountFingerprint)
          : await this.tryClaim(evaluation.id, accountFingerprint, markerEpoch)
      if (!markerPath) {
        logger.debug('prime', 'claim lost', {
          account: evaluation.label,
          marker: `${evaluation.id}-${markerEpoch ?? 'bootstrap'}`,
        })
        return
      }

      const postClaimStorage = await this.options.loadStorage()
      if (this.stopped || postClaimStorage?.prime?.enabled !== true) {
        await rm(markerPath, { force: true })
        return
      }

      if (markerEpoch !== undefined) {
        // Create the epoch claim before releasing the bootstrap sentinel so
        // concurrent processes never observe an unclaimed transition gap.
        await rm(bootstrapMarkerPath, { force: true })
        if (this.stopped) {
          await rm(markerPath, { force: true })
          return
        }
      }

      await this.fire(evaluation, now, postClaimStorage)
    } catch (error) {
      logger.warn('prime', 'account evaluation failed', {
        account: evaluation.label,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async tryClaim(
    accountId: 'main' | string,
    accountFingerprint: string,
    resetsAtEpochMs: number,
  ): Promise<string | null> {
    const dir = this.markerDir(accountFingerprint)
    const markerPath = primeMarkerPath(dir, accountId, resetsAtEpochMs)
    return this.tryClaimPath(dir, markerPath)
  }

  private async tryClaimBootstrap(
    accountId: 'main' | string,
    accountFingerprint: string,
  ): Promise<string | null> {
    const dir = this.markerDir(accountFingerprint)
    const markerPath = primeBootstrapMarkerPath(dir, accountId)
    return this.tryClaimPath(dir, markerPath)
  }

  private async tryClaimPath(
    dir: string,
    markerPath: string,
  ): Promise<string | null> {
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      // Directory-create failures are propagated by the writeFile attempt below.
    }
    try {
      await writeFile(markerPath, '', { encoding: 'utf8', flag: 'wx' })
      return markerPath
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return null
      throw error
    }
  }

  private async hasAnyClaimMarker(
    accountId: 'main' | string,
    accountFingerprint: string,
  ): Promise<boolean> {
    const dir = this.markerDir(accountFingerprint)
    const prefix = `${encodeURIComponent(accountId)}-`
    try {
      return (await readdir(dir)).some((entry) => entry.startsWith(prefix))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async fire(
    evaluation: AccountEvaluation,
    now: number,
    _storage: AccountStorage,
  ): Promise<void> {
    let result: PrimeSendResult
    try {
      result = await this.options.sendPrime(evaluation.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('prime', 'prime fire threw', {
        account: evaluation.label,
        error: message,
      })
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'error',
      })
      return
    }
    if (this.stopped) return

    if (!result.ok) {
      // Spec Logging table: two distinct warn events.
      // - `prime token refresh failed` — token-refresh failure
      //   before the request fires (reason: 'token-refresh').
      // - `prime fire failed` — HTTP error / fetch throw /
      //   identity failure during the request (reason: 'send').
      if (result.reason === 'token-refresh') {
        logger.warn('prime', 'prime token refresh failed', {
          account: evaluation.label,
          error: result.error,
        })
      } else {
        logger.warn('prime', 'prime fire failed', {
          account: evaluation.label,
          status: result.status,
          error: result.error,
        })
      }
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'error',
      })
      return
    }

    const usage = {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    }
    try {
      const counters = await this.options.recordSuccess(evaluation.id, usage)
      if (this.stopped) {
        // If stopped mid-fire, roll back the transient so a later
        // `stats()` does not report a phantom success.
        this.transient.delete(evaluation.id)
        this.counters.delete(evaluation.id)
        return
      }
      this.counters.set(evaluation.id, counters)
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'ok',
      })
      logger.info('prime', 'prime fired', {
        account: evaluation.label,
        status: result.status,
        ms: result.ms,
        usage: {
          inputTokens: counters.inputTokens,
          outputTokens: counters.outputTokens,
        },
      })
      this.schedulePostFireRefresh(evaluation)
    } catch (error) {
      // Persisting counters failed; surface the error but keep the marker so
      // the cycle counts as attempted. Operator can retry next reset epoch.
      logger.warn('prime', 'recordSuccess failed', {
        account: evaluation.label,
        error: error instanceof Error ? error.message : String(error),
      })
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'error',
      })
    }
  }

  private schedulePostFireRefresh(evaluation: AccountEvaluation): void {
    // Unified fire-response headers can arm the window instantly on newer
    // trees. This branch predates header harvesting, so a delayed poll captures
    // the reset after the usage API's observed propagation lag.
    const timer = setTimeout(() => {
      this.postFireRefreshTimers.delete(timer)
      if (this.stopped) return
      void (async () => {
        const storage = await this.options.loadStorage()
        if (this.stopped || storage?.prime?.enabled !== true) return
        await this.options.refreshQuota(evaluation.id)
      })().catch((error) => {
        logger.debug('prime', 'post-fire refresh failed', {
          account: evaluation.label,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, PRIME_POST_FIRE_REFRESH_MS)
    this.postFireRefreshTimers.add(timer)
    if (typeof timer === 'object' && 'unref' in timer) {
      ;(timer as { unref?: () => void }).unref?.()
    }
  }

  private async sweepMarkers(now: number): Promise<void> {
    const dir = this.storageMarkerDir()
    const swept = await this.sweepMarkerDirectory(dir, now)
    if (swept > 0) {
      logger.trace('prime', 'swept stale markers', { swept })
    }
  }

  private async sweepMarkerDirectory(
    dir: string,
    now: number,
  ): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return 0
    }
    let swept = 0
    for (const entry of entries) {
      try {
        const path = join(dir, entry)
        const s = await stat(path)
        if (s.isDirectory()) {
          swept += await this.sweepMarkerDirectory(path, now)
          continue
        }
        if (now - s.mtimeMs > PRIME_MARKER_MAX_AGE_MS) {
          await rm(path, { force: true })
          swept += 1
        }
      } catch {
        // Markers can vanish between readdir and stat; skip silently.
      }
    }
    return swept
  }

  private storageMarkerDir(): string {
    return primeMarkerNamespaceDir(
      this.options.markerDir ?? defaultMarkerDir(),
      this.options.storagePath,
    )
  }

  private markerDir(accountFingerprint: string): string {
    return primeAccountMarkerDir(
      this.options.markerDir ?? defaultMarkerDir(),
      this.options.storagePath,
      accountFingerprint,
    )
  }
}
