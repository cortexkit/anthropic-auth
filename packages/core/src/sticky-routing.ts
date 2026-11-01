import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readVaultRoster } from '@cortexkit/common-auth/claustrum'
import {
  type AccountOperationError,
  type AccountStorage,
  acquireRefreshFileLock,
  getKillswitchThresholdsForAccount,
  getQuotaCheckIntervalMs,
  getQuotaMinimumRemainingThresholds,
  getScopedQuotaWindowForModel,
  isKillswitchEnabled,
  isPermanentRefreshError,
  killswitchRetryAfterSeconds,
  type OAuthQuotaSnapshot,
  quotaFieldSource,
  quotaSnapshotOmitsFiveHour,
  quotaSnapshotPassesModelScope,
} from './accounts.ts'
import { logger } from './logger.ts'
import { isClaudeFableOrMythos5Model } from './models.ts'
import type { NativeQuotaPolicyLimit } from './native-account-runtime.ts'
import {
  type NativeLockEvent,
  nativeLockObserver,
} from './native-lock-observer.ts'
import type { NativeVaultRosterDocument } from './native-roster-seed.ts'
import {
  type NativeVaultRoutingSeed,
  nativeVaultLegacyRoutes,
  readNativeVaultLegacyJson,
} from './native-vault-seed.ts'
import { quotaExhaustionFromHeaders } from './quota-headers.ts'
import { commitRequestChange, requestSignal } from './request-abort.ts'

export const STICKY_ROUTING_MAIN_ACCOUNT_ID = 'main'
export const STICKY_ROUTING_SHORT_RESET_GRACE_MS = 15 * 60_000
export const STICKY_ROUTING_ASSIGNMENT_TTL_MS = 7 * 24 * 60 * 60_000

const STICKY_ROUTING_TOUCH_INTERVAL_MS = 60 * 60_000
const STICKY_ROUTING_LOCK_TTL_MS = 10_000
const STICKY_ROUTING_LOCK_WAIT_MS = 5_000
const STICKY_ROUTING_LOCK_POLL_MS = 10
const STICKY_ROUTING_MAX_ASSIGNMENTS = 4_096
const MIN_WEIGHT = 0.000_001

export type StickyRouteFamily = 'fable' | 'opus' | 'general'

export type IdentityState =
  | { kind: 'known'; accountId: string }
  | { kind: 'unknown' }

export type QuotaState =
  | { kind: 'known'; quota: OAuthQuotaSnapshot }
  | { kind: 'unknown' }

export type StickyRouteCandidate = {
  accountId: string
  quota: OAuthQuotaSnapshot | QuotaState
  order: number
}

export type StickyRouteAssignment = {
  accountId: string
  /** Verified account UUID for a credential held by the vault. Pins using credentials stored by this host omit the field. */
  accountIdentity?: string
  family: StickyRouteFamily
  affinityModelId?: string
  assignedAt: number
  lastSeenAt: number
  initialInputBytes: number
  quotaCheckedAt: number
}

type StickyRouteState = {
  version: 1
  updatedAt: number
  assignments: Record<string, StickyRouteAssignment>
  vaultLegacySeed?: 'pending' | 'complete'
}

export type StickyRouteResolution = {
  accountId: string
  assignment: StickyRouteAssignment
  created: boolean
  migrated: boolean
}

export type StickyQuotaFailureDecision =
  | { action: 'retain'; reason: 'not-exhausted' | 'unknown' }
  | {
      action: 'hold'
      reason:
        | 'five-hour-short-reset'
        | 'seven-day-short-reset'
        | 'model-scoped-short-reset'
      retryAfterSeconds: number
    }
  | {
      action: 'migrate'
      reason: 'five-hour' | 'seven-day' | 'model-scoped'
    }

/**
 * Build the terminal response for a complete sticky quota pool that has no
 * eligible route. This prevents callers from silently falling through to the
 * main account after the router deliberately excluded it.
 */
export function createStickyNoRouteResponse(input: {
  mainRefreshError?: AccountOperationError
  fallbackReauthLabels?: readonly string[]
  routeQuotas: readonly OAuthQuotaSnapshot[]
  vaultPolicyLimits?: readonly NativeQuotaPolicyLimit[]
  modelId?: string
  now?: number
}): Response {
  const modelId = input.modelId
  const modelName = modelId
    ? input.routeQuotas
        .map((quota) => getScopedQuotaWindowForModel(quota, modelId))
        .find(Boolean)?.modelName
    : undefined

  let authenticationMessage: string | undefined
  if (isPermanentRefreshError(input.mainRefreshError)) {
    authenticationMessage = modelName
      ? `Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable for ${modelName}.`
      : 'Main Claude OAuth account requires re-login, and no fallback OAuth account is currently routable.'
  } else if (input.fallbackReauthLabels?.length) {
    const scope = modelName ? ` for ${modelName}` : ''
    authenticationMessage = `No OAuth account is currently routable${scope}. Fallback Claude OAuth accounts require re-login: ${input.fallbackReauthLabels.join(', ')}.`
  }
  if (authenticationMessage) {
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: authenticationMessage,
        },
      }),
      {
        status: 401,
        headers: { 'content-type': 'application/json' },
      },
    )
  }

  const scopedBlocked = Boolean(
    modelId &&
      input.routeQuotas.length > 0 &&
      input.routeQuotas.every(
        (quota) => !quotaSnapshotPassesModelScope(quota, modelId),
      ),
  )
  const [firstQuota, ...remainingQuotas] = input.routeQuotas
  const retryAfter = killswitchRetryAfterSeconds(
    firstQuota,
    remainingQuotas.map((quota) => ({ quota })),
    input.now ?? Date.now(),
    scopedBlocked ? modelId : undefined,
  )
  const minutes = Math.floor(retryAfter / 60)
  const seconds = retryAfter % 60
  const limitNames = input.vaultPolicyLimits?.map((limit) =>
    limit === 'model-scoped'
      ? `${modelName ?? 'Model'} scoped limit`
      : limit === 'killswitch'
        ? 'killswitch limit'
        : 'quota floor',
  )
  const reason = limitNames
    ? `No vault account currently satisfies quota policy: ${limitNames.join(', ')}. Open /claude → Killswitch / Quota to change these limits.`
    : scopedBlocked && modelName
      ? `${modelName} weekly limit reached, no routable OAuth accounts.`
      : 'No OAuth account currently satisfies sticky-balanced quota policy.'
  const message = `${reason} Retry in ${minutes}m ${seconds}s.`
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message },
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(retryAfter),
      },
    },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeAssignment(
  value: unknown,
): StickyRouteAssignment | undefined {
  if (!isRecord(value)) return
  if (
    typeof value.accountId !== 'string' ||
    !['fable', 'opus', 'general'].includes(String(value.family))
  ) {
    return
  }
  const assignedAt = finiteNumber(value.assignedAt)
  const lastSeenAt = finiteNumber(value.lastSeenAt)
  const initialInputBytes = finiteNumber(value.initialInputBytes)
  const quotaCheckedAt = finiteNumber(value.quotaCheckedAt)
  if (
    assignedAt === undefined ||
    lastSeenAt === undefined ||
    initialInputBytes === undefined ||
    quotaCheckedAt === undefined
  ) {
    return
  }
  if (
    Object.hasOwn(value, 'affinityModelId') &&
    typeof value.affinityModelId !== 'string'
  ) {
    return
  }
  if (
    Object.hasOwn(value, 'accountIdentity') &&
    (typeof value.accountIdentity !== 'string' ||
      value.accountIdentity.length === 0 ||
      value.accountIdentity.trim() !== value.accountIdentity)
  )
    return
  return {
    accountId: value.accountId,
    ...(typeof value.accountIdentity === 'string'
      ? { accountIdentity: value.accountIdentity }
      : {}),
    family: value.family as StickyRouteFamily,
    affinityModelId:
      typeof value.affinityModelId === 'string'
        ? value.affinityModelId
        : undefined,
    assignedAt,
    lastSeenAt,
    initialInputBytes: Math.max(0, initialInputBytes),
    quotaCheckedAt,
  }
}

function normalizeState(value: unknown): StickyRouteState | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.assignments)) {
    return
  }
  const assignments: Record<string, StickyRouteAssignment> = {}
  for (const [key, assignment] of Object.entries(value.assignments)) {
    const normalized = normalizeAssignment(assignment)
    if (normalized) assignments[key] = normalized
  }
  return {
    version: 1,
    updatedAt: finiteNumber(value.updatedAt) ?? 0,
    assignments,
    ...(value.vaultLegacySeed === 'pending' ||
    value.vaultLegacySeed === 'complete'
      ? { vaultLegacySeed: value.vaultLegacySeed }
      : {}),
  }
}

/**
 * Produce deterministic journal bytes from captured, parsed legacy routing JSON.
 * The offline caller must prove each old-to-concrete row binding, including main;
 * a map entry is not credential or identity proof. Unmapped assignments and their
 * implicit prompt-byte deficits are dropped. Quota observations must separately
 * retain their proven checkedAt values for those deficits to remain attributable.
 *
 * The caller owns source/path revalidation, the digest, journal authority and the
 * locked temp-plus-rename write with an ownership check before rename. An absent
 * source is handled by the caller, not by substituting an empty state here. This
 * helper neither authorizes migration nor reads clocks, prunes or writes state.
 * Invalid source data or unusable map values throw Error('invalid-source') without
 * including any captured data. Input must be parsed JSON, not executable objects.
 */
export function migrateStickyRoutingState(
  source: unknown,
  rowIdMap: ReadonlyMap<string, string>,
): string {
  try {
    if (!isRecord(source) || !isRecord(source.assignments)) throw new Error()
    const entries = Object.entries(source.assignments)
    // The runtime normalizer writes into an ordinary dictionary. Neutral keys
    // let it validate every record without invoking the __proto__ setter; the
    // original session keys are restored only into a null-prototype dictionary.
    const state = normalizeState({
      ...source,
      assignments: Object.fromEntries(
        entries.map(([, assignment], index) => [String(index), assignment]),
      ),
    })
    if (
      !state ||
      Object.keys(source).length !== 3 ||
      !Object.hasOwn(source, 'version') ||
      !Object.hasOwn(source, 'updatedAt') ||
      !Object.hasOwn(source, 'assignments') ||
      !Object.is(source.updatedAt, state.updatedAt)
    ) {
      throw new Error()
    }

    // Validate even unused mappings. These are concrete pool row IDs, whose
    // binding contract requires nonempty strings without surrounding whitespace.
    for (const accountId of rowIdMap.values()) {
      if (
        typeof accountId !== 'string' ||
        accountId.length === 0 ||
        accountId.trim() !== accountId
      ) {
        throw new Error()
      }
    }

    const assignments: Record<string, StickyRouteAssignment> =
      Object.create(null)
    for (const [index, [key, original]] of entries.entries()) {
      const assignment = state.assignments[String(index)]
      if (!isRecord(original) || !assignment) throw new Error()
      // An absent legacy affinity is valid, but no other missing, extra or
      // changed field is safe to import. Compare fields, not JSON key order.
      const fields = Object.keys(assignment).filter(
        (field) =>
          field !== 'affinityModelId' ||
          Object.hasOwn(original, 'affinityModelId'),
      )
      if (
        Object.keys(original).length !== fields.length ||
        fields.some(
          (field) =>
            !Object.hasOwn(original, field) ||
            !Object.is(original[field], Reflect.get(assignment, field)),
        )
      ) {
        throw new Error()
      }
      const accountId = rowIdMap.get(assignment.accountId)
      if (accountId === undefined) continue
      assignments[key] = { ...assignment, accountId }
    }
    return `${JSON.stringify({ ...state, assignments }, null, 2)}\n`
  } catch {
    throw new Error('invalid-source')
  }
}

function emptyState(now: number): StickyRouteState {
  return { version: 1, updatedAt: now, assignments: {} }
}

function sessionKey(sessionId: string) {
  return createHash('sha256').update(sessionId).digest('hex')
}

export function stickyQuotaSnapshotIsFresh(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now = Date.now(),
  modelId?: string,
) {
  const maxAge = getQuotaCheckIntervalMs(storage)
  const standardFresh = (['five_hour', 'seven_day'] as const).every((key) => {
    if (key === 'five_hour' && quotaSnapshotOmitsFiveHour(quota)) return true
    const window = quota?.[key]
    return Boolean(window && now - window.checkedAt < maxAge)
  })
  if (!standardFresh) return false
  const scoped = getScopedQuotaWindowForModel(quota, modelId)
  return !scoped || now - scoped.checkedAt < maxAge
}

function snapshotCheckedAt(quota: OAuthQuotaSnapshot) {
  return Math.max(
    quota.checkedAt ?? 0,
    quota.five_hour?.checkedAt ?? 0,
    quota.seven_day?.checkedAt ?? 0,
    ...(quota.scoped ?? []).map((window) => window.checkedAt ?? 0),
  )
}

function knownQuota(
  quota: OAuthQuotaSnapshot | QuotaState | undefined,
): OAuthQuotaSnapshot | undefined {
  if (!quota) return undefined
  if ('kind' in quota) return quota.kind === 'known' ? quota.quota : undefined
  return quota
}

function remainingThreshold(
  storage: AccountStorage | null,
  accountId: string,
  key: 'five_hour' | 'seven_day' | 'scoped',
) {
  const quotaMinimum = getQuotaMinimumRemainingThresholds(storage)
  const quotaThreshold =
    key === 'five_hour'
      ? quotaMinimum.five_hour
      : key === 'seven_day'
        ? quotaMinimum.seven_day
        : 0
  if (!isKillswitchEnabled(storage)) return quotaThreshold
  const killswitch = getKillswitchThresholdsForAccount(
    storage,
    accountId === STICKY_ROUTING_MAIN_ACCOUNT_ID ? undefined : accountId,
  )
  return Math.max(quotaThreshold, killswitch[key])
}

function sustainableWindowWeight(
  remainingPercent: number,
  reservePercent: number,
  resetsAt: string | undefined,
  now: number,
) {
  const spendable = Math.max(0, remainingPercent - reservePercent)
  if (spendable <= 0) return 0
  if (!resetsAt) return spendable
  const resetAt = Date.parse(resetsAt)
  if (!Number.isFinite(resetAt) || resetAt <= now) return spendable
  const hoursUntilReset = Math.max((resetAt - now) / 3_600_000, 1 / 60)
  return spendable / hoursUntilReset
}

export function stickyRouteFamilyForModel(model: unknown): StickyRouteFamily {
  if (isClaudeFableOrMythos5Model(model)) return 'fable'
  return typeof model === 'string' && model.toLowerCase().includes('opus')
    ? 'opus'
    : 'general'
}

export function stickyRouteCandidateWeight(input: {
  candidate: StickyRouteCandidate
  family: StickyRouteFamily
  modelId?: string
  storage: AccountStorage | null
  now?: number
  onPolicyBlock?: (limit: NativeQuotaPolicyLimit) => void
}) {
  const now = input.now ?? Date.now()
  const { candidate, storage } = input
  const quota = knownQuota(candidate.quota)
  if (!quota) return 0
  if (!stickyQuotaSnapshotIsFresh(quota, storage, now, input.modelId)) {
    return 0
  }
  const weights: number[] = []
  for (const key of ['five_hour', 'seven_day'] as const) {
    if (key === 'five_hour' && quotaSnapshotOmitsFiveHour(quota)) continue
    const window = quota[key]
    if (!window || !Number.isFinite(window.remainingPercent)) return 0
    const threshold = remainingThreshold(storage, candidate.accountId, key)
    if (window.remainingPercent <= threshold) {
      const quotaThreshold = getQuotaMinimumRemainingThresholds(storage)[key]
      input.onPolicyBlock?.(
        isKillswitchEnabled(storage) && threshold > quotaThreshold
          ? 'killswitch'
          : 'quota-floor',
      )
    }
    weights.push(
      sustainableWindowWeight(
        window.remainingPercent,
        threshold,
        window.resetsAt,
        now,
      ),
    )
  }
  if (input.family === 'fable') {
    const window = getScopedQuotaWindowForModel(quota, input.modelId)
    if (window && Number.isFinite(window.remainingPercent)) {
      if (
        window.remainingPercent <=
        remainingThreshold(storage, candidate.accountId, 'scoped')
      )
        input.onPolicyBlock?.('model-scoped')
      weights.push(
        sustainableWindowWeight(
          window.remainingPercent,
          remainingThreshold(storage, candidate.accountId, 'scoped'),
          window.resetsAt,
          now,
        ),
      )
    }
  }
  return Math.min(...weights)
}

export function stickyRouteKnownFableExhausted(
  candidate: StickyRouteCandidate,
  storage: AccountStorage | null,
  now = Date.now(),
) {
  const quota = knownQuota(candidate.quota)
  const window = getScopedQuotaWindowForModel(quota, 'claude-fable-5')
  return Boolean(
    window &&
      stickyQuotaSnapshotIsFresh(quota, storage, now, 'claude-fable-5') &&
      Number.isFinite(window.remainingPercent) &&
      window.remainingPercent <= 0,
  )
}

export function decideStickyQuotaFailure(input: {
  quota: OAuthQuotaSnapshot | QuotaState | undefined
  responseHeaders?: Headers
  modelId?: string
  now?: number
}): StickyQuotaFailureDecision {
  const now = input.now ?? Date.now()
  let reading = knownQuota(input.quota)
  // The refused request can confirm exhaustion even when a quota probe fails
  // or serves an older cached reading. Never use rounded header percentages here.
  const confirmed = input.responseHeaders
    ? quotaExhaustionFromHeaders(input.responseHeaders, input.modelId, now)
    : undefined
  if (reading && input.responseHeaders) {
    reading = { ...reading }
    for (const key of ['five_hour', 'seven_day', 'scoped'] as const) {
      // Stored header readings contain display-rounded percentages, not raw evidence.
      if (quotaFieldSource(reading, key) === 'headers') delete reading[key]
    }
  }
  const quota =
    reading || (confirmed && Object.keys(confirmed).length)
      ? { ...reading, ...confirmed }
      : undefined
  if (!quota) return { action: 'retain', reason: 'unknown' }
  let blocking:
    | { resetAt: number; reason: 'five-hour' | 'seven-day' | 'model-scoped' }
    | undefined
  for (const [reason, window] of [
    ['model-scoped', getScopedQuotaWindowForModel(quota, input.modelId)],
    ['seven-day', quota.seven_day],
    ['five-hour', quota.five_hour],
  ] as const) {
    if (
      !window ||
      !Number.isFinite(window.remainingPercent) ||
      window.remainingPercent > 0
    )
      continue
    const resetAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN
    if (!Number.isFinite(resetAt) || resetAt <= now)
      return { action: 'migrate', reason }
    // A request can resume only after every exhausted window blocking its model resets.
    if (!blocking || resetAt > blocking.resetAt) blocking = { resetAt, reason }
  }
  if (!blocking) return { action: 'retain', reason: 'not-exhausted' }
  if (blocking.resetAt - now <= STICKY_ROUTING_SHORT_RESET_GRACE_MS) {
    return {
      action: 'hold',
      reason: `${blocking.reason}-short-reset`,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((blocking.resetAt - now) / 1000),
      ),
    }
  }
  return { action: 'migrate', reason: blocking.reason }
}

/** Bound an unconfirmed 429's host retry while preserving any shorter upstream wait. */
export function stickyRetainRetryHeaders(upstream: Headers, now = Date.now()) {
  const headers = new Headers(upstream)
  let seconds = 60
  const shorten = (value: number) => {
    if (Number.isFinite(value)) seconds = Math.min(seconds, Math.max(0, value))
  }
  const after = headers.get('retry-after')
  if (after?.trim()) {
    shorten(
      Number.isFinite(Number(after))
        ? Number(after)
        : (Date.parse(after) - now) / 1000,
    )
  }
  const ms = headers.get('retry-after-ms')
  if (ms?.trim()) shorten(Number(ms) / 1000)
  const resets = [...headers.keys()].filter((name) =>
    /^anthropic-ratelimit-.*-reset$/.test(name),
  )
  for (const name of resets) {
    const value = headers.get(name)!
    if (!value.trim()) continue
    shorten(
      (Number.isFinite(Number(value))
        ? Number(value) * 1000
        : Date.parse(value)) /
        1000 -
        now / 1000,
    )
  }
  headers.set('retry-after', String(seconds))
  headers.set('retry-after-ms', String(seconds * 1000))
  // Reset headers are quota evidence, not retry controls. Preserve them even
  // when the host should retry sooner than the account's next quota reset.
  return headers
}

export function getStickyRoutingStatePath(accountStoragePath: string) {
  const name = basename(accountStoragePath)
  const stem = name.endsWith('.json') ? name.slice(0, -5) : name
  return join(dirname(accountStoragePath), `${stem}-routing-state.json`)
}

export function stickyRetryAfterWithJitter(
  sessionId: string,
  retryAfterSeconds: number,
) {
  const hash = createHash('sha256').update(sessionId).digest().readUInt32BE(0)
  return Math.max(1, Math.ceil(retryAfterSeconds)) + (hash % 21)
}

// Share recovery attempts across router instances, including concurrent plugin loads.
const localRecoveries = new Map<string, Promise<void>>()

export class StickySessionRouter {
  private loaded = false
  private state: StickyRouteState
  private stateMtimeNs: bigint | undefined
  private publicationChain: Promise<void> = Promise.resolve()
  private seedPublication: Promise<void> | undefined
  private readonly changes = new Map<
    string,
    {
      assignment?: StickyRouteAssignment
      operation: 'touch' | 'assign' | 'delete'
      queued: boolean
    }
  >()
  private seedFinalized = false

  constructor(
    private readonly options: {
      path: string
      now?: () => number
      assignmentTtlMs?: number
      vaultSeed?: NativeVaultRoutingSeed
      localRecoveryPath?: string
      onLockEvent?: (event: NativeLockEvent) => void
      /**
       * Refuses once a newer version has moved the dataset this routing
       * file belongs to. Every write runs it under the routing file's lock,
       * before any temporary file is created.
       */
      relocationGuard?: { assertNotRelocated(): Promise<void> }
    },
  ) {
    this.state = emptyState(this.now())
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  private async readState() {
    try {
      const raw = await readFile(this.options.path, 'utf8')
      const normalized = normalizeState(JSON.parse(raw))
      if (!normalized) {
        throw new Error(`Invalid sticky routing state at ${this.options.path}`)
      }
      return normalized
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ...emptyState(this.now()),
          ...(this.options.vaultSeed
            ? { vaultLegacySeed: 'pending' as const }
            : {}),
        }
      }
      throw error
    }
  }

  private async readStateMtimeNs() {
    try {
      return (await stat(this.options.path, { bigint: true })).mtimeNs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0n
      throw error
    }
  }

  private async refreshStateIfChanged() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.readStateMtimeNs()
      if (this.loaded && before === this.stateMtimeNs) return
      const state = await this.readState()
      const after = await this.readStateMtimeNs()
      if (before !== after) continue
      this.state = state
      this.overlayChanges()
      this.stateMtimeNs = after
      this.loaded = true
      return
    }
    this.state = await this.readState()
    this.overlayChanges()
    this.stateMtimeNs = await this.readStateMtimeNs()
    this.loaded = true
  }

  private async acquireLock(wait = true, detached = false) {
    const observer = nativeLockObserver(this.options.onLockEvent)
    const event = { name: 'write', path: this.options.path, detached }
    observer?.({ ...event, type: 'acquiring' })
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
    const deadline = performance.now() + STICKY_ROUTING_LOCK_WAIT_MS
    while (true) {
      const lock = await acquireRefreshFileLock({
        name: 'write',
        path: this.options.path,
        ttlMs: STICKY_ROUTING_LOCK_TTL_MS,
        renew: true,
      })
      if (lock) {
        observer?.({ ...event, type: 'acquired' })
        return {
          assertOwned: () => lock.assertOwned(),
          release: async () => {
            try {
              await lock.release()
            } finally {
              observer?.({ ...event, type: 'released' })
            }
          },
        }
      }
      observer?.({ ...event, type: 'contended' })
      if (!wait || performance.now() >= deadline) {
        throw new Error('Timed out acquiring sticky routing state lock')
      }
      await new Promise((resolve) =>
        setTimeout(resolve, STICKY_ROUTING_LOCK_POLL_MS),
      )
    }
  }

  private recoverLocalPins() {
    const source = this.options.localRecoveryPath
    if (!source || source === this.options.path) return
    const key = JSON.stringify([this.options.path, source])
    let recovery = localRecoveries.get(key)
    if (!recovery) {
      recovery = this.enqueuePublication('recovery', () =>
        this.fillLocalPins(source),
      )
      localRecoveries.set(key, recovery)
    } else {
      const shared = recovery
      this.publicationChain = this.publicationChain.then(() => shared)
    }
  }

  private async fillLocalPins(source: string) {
    const lock = await this.acquireLock(true, true)
    try {
      let legacy: StickyRouteState | undefined
      try {
        legacy = normalizeState(JSON.parse(await readFile(source, 'utf8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!legacy) return
      const state = await this.readState()
      let changed = false
      for (const [key, assignment] of Object.entries(legacy.assignments)) {
        if (
          !/^[0-9a-f]{64}$/.test(key) ||
          Object.hasOwn(state.assignments, key)
        )
          continue
        state.assignments[key] = assignment
        changed = true
      }
      // Imported pins must not replace newer destination choices. Ordinary
      // routing handles expired pins and accounts that no longer exist.
      if (changed) await this.writeState(state, () => lock.assertOwned(), false)
    } finally {
      await lock.release()
    }
  }

  private assignmentIsActive(assignment: StickyRouteAssignment) {
    return (
      assignment.lastSeenAt >=
      this.now() -
        (this.options.assignmentTtlMs ?? STICKY_ROUTING_ASSIGNMENT_TTL_MS)
    )
  }

  private prune(state: StickyRouteState) {
    const cutoff =
      this.now() -
      (this.options.assignmentTtlMs ?? STICKY_ROUTING_ASSIGNMENT_TTL_MS)
    for (const [key, assignment] of Object.entries(state.assignments)) {
      if (assignment.lastSeenAt < cutoff) delete state.assignments[key]
    }
    const entries = Object.entries(state.assignments)
    if (entries.length <= STICKY_ROUTING_MAX_ASSIGNMENTS) return
    entries
      .sort((left, right) => right[1].lastSeenAt - left[1].lastSeenAt)
      .slice(STICKY_ROUTING_MAX_ASSIGNMENTS)
      .forEach(([key]) => {
        delete state.assignments[key]
      })
  }

  private async writeState(
    state: StickyRouteState,
    beforeRename: () => Promise<void>,
    prune = true,
  ) {
    await this.options.relocationGuard?.assertNotRelocated()
    if (prune) this.prune(state)
    state.updatedAt = this.now()
    const tempPath = `${this.options.path}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      await beforeRename()
      await rename(tempPath, this.options.path)
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
    // A background merge must not replace newer in-memory session changes.
    // Re-read the atomically published file before the next route decision.
    this.loaded = false
  }

  private async writeResolutionState(
    state: StickyRouteState,
    assertOwned: () => Promise<void>,
    operation: 'touch' | 'delete' | 'assign',
  ) {
    let ownershipLost = false
    try {
      await this.writeState(
        state,
        async () => {
          try {
            await assertOwned()
          } catch (error) {
            ownershipLost = true
            throw error
          }
        },
        false,
      )
      return true
    } catch {
      // A failed publication keeps its session change pending for a later retry.
      logger.warn('sticky-routing', 'assignment write refused', {
        operation,
        reason: ownershipLost ? 'ownership-lost' : 'storage-unavailable',
      })
      return false
    }
  }

  /** Queue legacy-pin import in the background; take its writer lease only after verifying a complete roster. */
  async prepareLegacySeed(knownRoster?: NativeVaultRosterDocument | null) {
    const seed = this.options.vaultSeed
    if (!seed || this.seedFinalized || this.seedPublication) return
    if (knownRoster !== undefined && !knownRoster?.complete) return
    this.seedPublication = this.enqueuePublication('seed', async () => {
      const roster =
        knownRoster === undefined
          ? await readVaultRoster(seed.roster)
          : knownRoster
      if (!roster?.complete) return
      const lock = await this.acquireLock(true, true)
      try {
        const state = await this.readState()
        if (state.vaultLegacySeed !== 'pending') {
          this.seedFinalized = true
          return
        }
        const source = await readNativeVaultLegacyJson(seed.legacyConfig)
        const routes = nativeVaultLegacyRoutes(source, roster)
        const legacy = await readNativeVaultLegacyJson(
          getStickyRoutingStatePath(seed.legacyConfig),
        )
        if (
          isRecord(legacy) &&
          legacy.version === 1 &&
          isRecord(legacy.assignments)
        ) {
          for (const [key, raw] of Object.entries(legacy.assignments)) {
            if (
              !/^[0-9a-f]{64}$/.test(key) ||
              Object.hasOwn(state.assignments, key)
            )
              continue
            const assignment = normalizeAssignment(raw)
            const target = assignment && routes.get(assignment.accountId)
            if (assignment && target)
              state.assignments[key] = {
                ...assignment,
                accountId: target.routeId,
                accountIdentity: target.accountIdentity,
              }
          }
        }
        state.vaultLegacySeed = 'complete'
        // Imported pins fill only missing assignments, leaving existing ones
        // unchanged. Publish the marker and additions in one owned rename.
        await this.writeState(state, () => lock.assertOwned(), false)
        this.seedFinalized = true
      } finally {
        await lock.release()
      }
    }).finally(() => {
      this.seedPublication = undefined
    })
  }

  private logicalAccountId(assignment: StickyRouteAssignment) {
    return assignment.accountId === this.options.vaultSeed?.mainRouteId
      ? STICKY_ROUTING_MAIN_ACCOUNT_ID
      : assignment.accountId
  }

  setVaultSeed(seed: NativeVaultRoutingSeed | undefined) {
    this.options.vaultSeed = seed
  }

  private scheduleTouch(key: string) {
    const assignment = this.state.assignments[key]
    if (assignment) this.scheduleChange(key, assignment, 'touch')
  }

  private overlayChanges() {
    for (const [key, change] of this.changes) {
      if (change.assignment)
        this.state.assignments[key] = { ...change.assignment }
      else delete this.state.assignments[key]
    }
  }

  private enqueuePublication(operation: string, work: () => Promise<void>) {
    const pending = this.publicationChain.then(work).catch(() => {
      if (operation === 'recovery') {
        logger.warn('sticky-routing', 'local pin recovery unavailable', {
          reason: 'recovery-failed',
        })
        return
      }
      logger.warn('sticky-routing', 'assignment write refused', {
        operation,
        reason: 'storage-unavailable',
      })
    })
    this.publicationChain = pending
    return pending
  }

  private scheduleChange(
    key: string,
    assignment: StickyRouteAssignment | undefined,
    operation: 'touch' | 'assign' | 'delete',
  ) {
    const change = {
      assignment: assignment ? { ...assignment } : undefined,
      operation,
      queued: false,
    }
    this.changes.set(key, change)
    this.overlayChanges()
    this.retryChange(key)
  }

  private retryChange(key: string) {
    const change = this.changes.get(key)
    if (!change || change.queued) return
    change.queued = true
    void this.enqueuePublication(change.operation, async () => {
      if (this.changes.get(key) !== change) return
      const lock = await this.acquireLock(true, true)
      try {
        const state = await this.readState()
        // A reset or reassignment may supersede a change while publication waits.
        if (this.changes.get(key) !== change) return
        // Re-read under the publication lease and merge only this session, so
        // another project's pins cannot be overwritten by a request snapshot.
        if (change.assignment) {
          if (change.operation === 'touch') {
            const current = state.assignments[key]
            if (
              current?.accountId !== change.assignment.accountId ||
              current.accountIdentity !== change.assignment.accountIdentity ||
              current.affinityModelId !== change.assignment.affinityModelId ||
              current.family !== change.assignment.family
            ) {
              if (this.changes.get(key) === change) this.changes.delete(key)
              return
            }
            current.lastSeenAt = Math.max(
              current.lastSeenAt,
              change.assignment.lastSeenAt,
            )
          } else state.assignments[key] = { ...change.assignment }
        } else delete state.assignments[key]
        const saved = await this.writeResolutionState(
          state,
          () => lock.assertOwned(),
          change.operation,
        )
        if (saved && this.changes.get(key) === change) this.changes.delete(key)
      } finally {
        await lock.release().catch(() => {})
      }
    }).finally(() => {
      change.queued = false
    })
  }

  /** Wait for owned background publications during host disposal or fixture cleanup. */
  async drain() {
    let pending: Promise<void>
    do {
      pending = this.publicationChain
      await pending
    } while (pending !== this.publicationChain)
  }

  private selectCandidate(input: {
    state: StickyRouteState
    candidates: readonly StickyRouteCandidate[]
    family: StickyRouteFamily
    modelId?: string
    storage: AccountStorage | null
    inputBytes: number
  }) {
    let candidates = [...input.candidates]
    if (input.family === 'opus') {
      const depleted = candidates.filter((candidate) =>
        stickyRouteKnownFableExhausted(candidate, input.storage, this.now()),
      )
      if (depleted.length > 0) candidates = depleted
    }
    const weighted = candidates.flatMap((candidate) => {
      const weight = stickyRouteCandidateWeight({
        candidate,
        family: input.family,
        modelId: input.modelId,
        storage: input.storage,
        now: this.now(),
      })
      return weight > 0 ? [{ candidate, weight }] : []
    })
    if (
      weighted.length === 0 &&
      candidates.every((candidate) => !knownQuota(candidate.quota))
    ) {
      return [...candidates].sort(
        (left, right) =>
          left.order - right.order ||
          left.accountId.localeCompare(right.accountId),
      )[0]
    }

    const pendingBytes = new Map<string, number>()
    for (const assignment of Object.values(input.state.assignments)) {
      const candidate = weighted.find(
        (entry) =>
          entry.candidate.accountId === this.logicalAccountId(assignment),
      )?.candidate
      if (!candidate) continue
      const quota = knownQuota(candidate.quota)
      if (quota && assignment.quotaCheckedAt !== snapshotCheckedAt(quota))
        continue
      pendingBytes.set(
        this.logicalAccountId(assignment),
        (pendingBytes.get(this.logicalAccountId(assignment)) ?? 0) +
          assignment.initialInputBytes,
      )
    }

    return weighted
      .map(({ candidate, weight }) => ({
        candidate,
        score:
          ((pendingBytes.get(candidate.accountId) ?? 0) + input.inputBytes) /
          Math.max(weight, MIN_WEIGHT),
      }))
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.candidate.order - right.candidate.order ||
          left.candidate.accountId.localeCompare(right.candidate.accountId),
      )[0]?.candidate
  }

  async resolve(input: {
    sessionId: string
    family: StickyRouteFamily
    modelId?: string
    affinityModelId?: string
    candidates: readonly StickyRouteCandidate[]
    retainAccountIds: ReadonlySet<string>
    /** Verified UUIDs for every vault account the host retains, even when quota prevents selection. Omit when credentials are stored by the host instead of the vault. */
    accountIdentities?: ReadonlyMap<string, string>
    storage: AccountStorage | null
    inputBytes: number
    preferredAccountId?: string
    excludeAccountIds?: ReadonlySet<string>
    /** Leave the current pin intact when selection cannot offer an account. */
    preserveOnNoCandidate?: boolean
  }): Promise<StickyRouteResolution | null> {
    requestSignal()?.throwIfAborted()
    if (!input.sessionId) return null
    this.recoverLocalPins()
    await this.prepareLegacySeed()
    await this.refreshStateIfChanged().catch(() => {})
    requestSignal()?.throwIfAborted()
    const key = sessionKey(input.sessionId)
    const affinityModelId = input.affinityModelId ?? input.modelId
    const matchesAffinity = (assignment: StickyRouteAssignment) =>
      affinityModelId !== undefined
        ? assignment.affinityModelId === affinityModelId
        : assignment.family === input.family
    const identityForAccount = (accountId: string) => {
      const identity = input.accountIdentities?.get(accountId)
      return typeof identity === 'string' &&
        identity.length > 0 &&
        identity.trim() === identity
        ? identity
        : undefined
    }
    const matchesAccountIdentity = (assignment: StickyRouteAssignment) => {
      if (!input.accountIdentities) return true
      const identity = identityForAccount(this.logicalAccountId(assignment))
      return identity !== undefined && assignment.accountIdentity === identity
    }
    const cached = this.state.assignments[key]
    if (
      cached &&
      this.assignmentIsActive(cached) &&
      matchesAffinity(cached) &&
      matchesAccountIdentity(cached) &&
      input.retainAccountIds.has(this.logicalAccountId(cached)) &&
      !input.excludeAccountIds?.has(this.logicalAccountId(cached))
    ) {
      if (this.now() - cached.lastSeenAt >= STICKY_ROUTING_TOUCH_INTERVAL_MS) {
        commitRequestChange(() => {
          cached.lastSeenAt = this.now()
          this.scheduleTouch(key)
        })
      }
      commitRequestChange(() => this.retryChange(key))
      return {
        accountId: this.logicalAccountId(cached),
        assignment: { ...cached },
        created: false,
        migrated: false,
      }
    }

    // Route decisions use the atomically published state, never a writer lease.
    const state = structuredClone(this.state)
    const save = (operation: 'touch' | 'delete' | 'assign') => {
      commitRequestChange(() =>
        this.scheduleChange(key, state.assignments[key], operation),
      )
    }
    this.prune(state)
    const current = state.assignments[key]
    if (
      current &&
      matchesAffinity(current) &&
      matchesAccountIdentity(current) &&
      input.retainAccountIds.has(this.logicalAccountId(current)) &&
      !input.excludeAccountIds?.has(this.logicalAccountId(current))
    ) {
      current.lastSeenAt = this.now()
      save('touch')
      return {
        accountId: this.logicalAccountId(current),
        assignment: { ...current },
        created: false,
        migrated: false,
      }
    }
    const affinityChanged = Boolean(current && !matchesAffinity(current))
    const identityChanged = Boolean(current && !matchesAccountIdentity(current))
    if (affinityChanged || identityChanged) {
      delete state.assignments[key]
    }
    const candidates = input.candidates.filter(
      (candidate) =>
        !input.excludeAccountIds?.has(candidate.accountId) &&
        (!input.accountIdentities ||
          identityForAccount(candidate.accountId) !== undefined),
    )
    const preferred =
      !affinityChanged && !identityChanged && input.preferredAccountId
        ? candidates.find(
            (candidate) =>
              candidate.accountId === input.preferredAccountId &&
              stickyRouteCandidateWeight({
                candidate,
                family: input.family,
                modelId: input.modelId,
                storage: input.storage,
                now: this.now(),
              }) > 0,
          )
        : undefined
    const selected =
      preferred ?? this.selectCandidate({ ...input, candidates, state })
    if (!selected) {
      if (current && !input.preserveOnNoCandidate) {
        delete state.assignments[key]
        save('delete')
      }
      return null
    }
    const now = this.now()
    const selectedQuota = knownQuota(selected.quota)
    const assignment: StickyRouteAssignment = {
      accountId: selected.accountId,
      ...(input.accountIdentities
        ? { accountIdentity: identityForAccount(selected.accountId) }
        : {}),
      family: input.family,
      affinityModelId,
      assignedAt: now,
      lastSeenAt: now,
      initialInputBytes: Math.max(1, input.inputBytes),
      quotaCheckedAt: selectedQuota ? snapshotCheckedAt(selectedQuota) : 0,
    }
    state.assignments[key] = assignment
    save('assign')
    return {
      accountId: selected.accountId,
      assignment: { ...assignment },
      created: !current,
      migrated: Boolean(
        current &&
          (identityChanged || current.accountId !== selected.accountId),
      ),
    }
  }

  async clear(sessionId: string) {
    if (!sessionId) return
    this.recoverLocalPins()
    this.scheduleChange(sessionKey(sessionId), undefined, 'delete')
  }
}
