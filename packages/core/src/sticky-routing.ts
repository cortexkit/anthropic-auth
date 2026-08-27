import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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
  quotaSnapshotPassesModelScope,
} from './accounts.ts'
import { isClaudeFableOrMythos5Model } from './models.ts'

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
  family: StickyRouteFamily
  assignedAt: number
  lastSeenAt: number
  initialInputBytes: number
  quotaCheckedAt: number
}

type StickyRouteState = {
  version: 1
  updatedAt: number
  assignments: Record<string, StickyRouteAssignment>
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
      reason: 'five-hour-short-reset'
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
  const reason =
    scopedBlocked && modelName
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
  return {
    accountId: value.accountId,
    family: value.family as StickyRouteFamily,
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
    const window = quota[key]
    if (!window || !Number.isFinite(window.remainingPercent)) return 0
    weights.push(
      sustainableWindowWeight(
        window.remainingPercent,
        remainingThreshold(storage, candidate.accountId, key),
        window.resetsAt,
        now,
      ),
    )
  }
  if (input.family === 'fable') {
    const window = getScopedQuotaWindowForModel(quota, input.modelId)
    if (window && Number.isFinite(window.remainingPercent)) {
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
  modelId?: string
  now?: number
}): StickyQuotaFailureDecision {
  const now = input.now ?? Date.now()
  const quota = knownQuota(input.quota)
  if (!quota) return { action: 'retain', reason: 'unknown' }
  const scoped = getScopedQuotaWindowForModel(quota, input.modelId)
  if (
    scoped &&
    Number.isFinite(scoped.remainingPercent) &&
    scoped.remainingPercent <= 0
  ) {
    return { action: 'migrate', reason: 'model-scoped' }
  }
  const sevenDay = quota.seven_day
  if (
    sevenDay &&
    Number.isFinite(sevenDay.remainingPercent) &&
    sevenDay.remainingPercent <= 0
  ) {
    return { action: 'migrate', reason: 'seven-day' }
  }
  const fiveHour = quota.five_hour
  if (
    fiveHour &&
    Number.isFinite(fiveHour.remainingPercent) &&
    fiveHour.remainingPercent <= 0
  ) {
    const resetAt = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : NaN
    if (
      Number.isFinite(resetAt) &&
      resetAt > now &&
      resetAt - now <= STICKY_ROUTING_SHORT_RESET_GRACE_MS
    ) {
      return {
        action: 'hold',
        reason: 'five-hour-short-reset',
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
      }
    }
    return { action: 'migrate', reason: 'five-hour' }
  }
  return { action: 'retain', reason: 'not-exhausted' }
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

export class StickySessionRouter {
  private loaded = false
  private state: StickyRouteState
  private stateMtimeNs: bigint | undefined
  private touchChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: {
      path: string
      now?: () => number
      assignmentTtlMs?: number
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
        return emptyState(this.now())
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
      this.stateMtimeNs = after
      this.loaded = true
      return
    }
    this.state = await this.readState()
    this.stateMtimeNs = await this.readStateMtimeNs()
    this.loaded = true
  }

  private async acquireLock() {
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
    const deadline = this.now() + STICKY_ROUTING_LOCK_WAIT_MS
    while (true) {
      const lock = await acquireRefreshFileLock({
        name: 'write',
        path: this.options.path,
        ttlMs: STICKY_ROUTING_LOCK_TTL_MS,
        renew: true,
      })
      if (lock) return lock
      if (this.now() >= deadline) {
        throw new Error('Timed out acquiring sticky routing state lock')
      }
      await new Promise((resolve) =>
        setTimeout(resolve, STICKY_ROUTING_LOCK_POLL_MS),
      )
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

  private async writeState(state: StickyRouteState) {
    this.prune(state)
    state.updatedAt = this.now()
    const tempPath = `${this.options.path}.${randomUUID()}.tmp`
    try {
      await writeFile(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      await rename(tempPath, this.options.path)
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
    this.state = state
    this.stateMtimeNs = await this.readStateMtimeNs()
    this.loaded = true
  }

  private scheduleTouch(key: string) {
    this.touchChain = this.touchChain
      .catch(() => {})
      .then(async () => {
        const lock = await this.acquireLock()
        try {
          const state = await this.readState()
          const assignment = state.assignments[key]
          if (!assignment) return
          assignment.lastSeenAt = this.now()
          await this.writeState(state)
        } finally {
          await lock.release()
        }
      })
      .catch(() => {})
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
        (entry) => entry.candidate.accountId === assignment.accountId,
      )?.candidate
      if (!candidate) continue
      const quota = knownQuota(candidate.quota)
      if (quota && assignment.quotaCheckedAt !== snapshotCheckedAt(quota))
        continue
      pendingBytes.set(
        assignment.accountId,
        (pendingBytes.get(assignment.accountId) ?? 0) +
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
    candidates: readonly StickyRouteCandidate[]
    retainAccountIds: ReadonlySet<string>
    storage: AccountStorage | null
    inputBytes: number
    preferredAccountId?: string
    excludeAccountIds?: ReadonlySet<string>
  }): Promise<StickyRouteResolution | null> {
    if (!input.sessionId) return null
    await this.refreshStateIfChanged()
    const key = sessionKey(input.sessionId)
    const cached = this.state.assignments[key]
    if (
      cached &&
      this.assignmentIsActive(cached) &&
      input.retainAccountIds.has(cached.accountId) &&
      !input.excludeAccountIds?.has(cached.accountId)
    ) {
      if (this.now() - cached.lastSeenAt >= STICKY_ROUTING_TOUCH_INTERVAL_MS) {
        cached.lastSeenAt = this.now()
        this.scheduleTouch(key)
      }
      return {
        accountId: cached.accountId,
        assignment: { ...cached },
        created: false,
        migrated: false,
      }
    }

    const lock = await this.acquireLock()
    try {
      const state = await this.readState()
      this.prune(state)
      const current = state.assignments[key]
      if (
        current &&
        input.retainAccountIds.has(current.accountId) &&
        !input.excludeAccountIds?.has(current.accountId)
      ) {
        current.lastSeenAt = this.now()
        await this.writeState(state)
        return {
          accountId: current.accountId,
          assignment: { ...current },
          created: false,
          migrated: false,
        }
      }
      const candidates = input.candidates.filter(
        (candidate) => !input.excludeAccountIds?.has(candidate.accountId),
      )
      const preferred = input.preferredAccountId
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
        if (current) {
          delete state.assignments[key]
          await this.writeState(state)
        }
        return null
      }
      const now = this.now()
      const selectedQuota = knownQuota(selected.quota)
      const assignment: StickyRouteAssignment = {
        accountId: selected.accountId,
        family: input.family,
        assignedAt: now,
        lastSeenAt: now,
        initialInputBytes: Math.max(1, input.inputBytes),
        quotaCheckedAt: selectedQuota ? snapshotCheckedAt(selectedQuota) : 0,
      }
      state.assignments[key] = assignment
      await this.writeState(state)
      return {
        accountId: selected.accountId,
        assignment: { ...assignment },
        created: !current,
        migrated: Boolean(current && current.accountId !== selected.accountId),
      }
    } finally {
      await lock.release()
    }
  }

  async clear(sessionId: string) {
    if (!sessionId) return
    const key = sessionKey(sessionId)
    const lock = await this.acquireLock()
    try {
      const state = await this.readState()
      if (!(key in state.assignments)) return
      delete state.assignments[key]
      await this.writeState(state)
    } finally {
      await lock.release()
    }
  }
}
