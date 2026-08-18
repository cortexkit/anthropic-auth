import type { AccountStorage } from './accounts.ts'
import type { CacheKeepTrackedSession } from './cachekeep-registry.ts'
import { signRequestBody } from './cch.ts'
import { orderClaudeCodeBody } from './claude-code.ts'
import { logger } from './logger.ts'

export const CLAUDE_CACHE_KEEP_COMMAND_NAME = 'claude-cachekeep'
export const CACHE_KEEP_TTL_MS = 60 * 60_000
export const CACHE_KEEP_PREWARM_LEAD_MS = 5 * 60_000
export const CACHE_KEEP_TICK_MS = 60_000
export const CACHE_KEEP_EXTENDED_TTL_BETA = 'extended-cache-ttl-2025-04-11'
export const CACHE_KEEP_MAX_TARGETS = 32
export const CACHE_KEEP_MAX_BODY_BYTES = 16 * 1024 * 1024
export const CACHE_KEEP_STALE_TARGET_MS = 2 * CACHE_KEEP_TTL_MS
export const CACHE_KEEP_PREWARM_TIMEOUT_MS = 30_000

const STATUS_TITLE = '## Claude Cache Keep Status'
const ENABLED_TITLE = '## Claude Cache Keep Enabled'
const DISABLED_TITLE = '## Claude Cache Keep Disabled'
const USAGE_TITLE = '## Claude Cache Keep Usage'
const USAGE =
  'Usage: `/claude-cachekeep`, `/claude-cachekeep always`, `/claude-cachekeep off`, or `/claude-cachekeep HH-HH`.'

export type CacheKeepWindow = {
  startHour: number
  endHour: number
}

export type CacheKeepCommandAction =
  | { type: 'status' }
  | { type: 'disable' }
  | { type: 'always' }
  | { type: 'window'; startHour: number; endHour: number }
  | { type: 'usage' }
  | { type: 'subagents'; enabled: boolean }

export type CacheKeepStatus = {
  enabled: boolean
  always?: boolean
  window?: CacheKeepWindow
  trackedSessions?: number
  trackedSessionDetails?: CacheKeepTrackedSession[]
  nextPrewarmAt?: number
  hybridActive?: boolean
}

function padHour(hour: number) {
  return String(hour).padStart(2, '0')
}

export function parseCacheKeepCommandAction(
  input: string,
): CacheKeepCommandAction {
  const trimmed = input.trim()
  if (!trimmed) return { type: 'status' }
  if (trimmed === 'off') return { type: 'disable' }
  if (trimmed === 'always') return { type: 'always' }
  if (trimmed === 'subagents on') return { type: 'subagents', enabled: true }
  if (trimmed === 'subagents off') return { type: 'subagents', enabled: false }

  const match = /^(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  if (!match) return { type: 'usage' }
  const startHour = Number(match[1])
  const endHour = Number(match[2])
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return { type: 'usage' }
  }

  return { type: 'window', startHour, endHour }
}

export function getCacheKeepWindow(
  storage: AccountStorage | null,
): CacheKeepWindow | undefined {
  const startHour = Number(storage?.cacheKeep?.startHour)
  const endHour = Number(storage?.cacheKeep?.endHour)
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return undefined
  }
  return { startHour, endHour }
}

export function isCacheKeepAlways(storage: AccountStorage | null) {
  return (
    storage?.cacheKeep?.enabled === true && storage.cacheKeep.always === true
  )
}

export function isCacheKeepPersistentlyEnabled(storage: AccountStorage | null) {
  return (
    storage?.cacheKeep?.enabled === true &&
    (isCacheKeepAlways(storage) || !!getCacheKeepWindow(storage))
  )
}

export function isCacheKeepHybridActive(storage: AccountStorage | null) {
  return (
    isCacheKeepPersistentlyEnabled(storage) &&
    storage?.claudeCache?.enabled === true &&
    storage.claudeCache.mode === 'hybrid'
  )
}

export function isWithinCacheKeepWindow(
  window: CacheKeepWindow | undefined,
  now = new Date(),
) {
  if (!window) return false
  const hour = now.getHours()
  if (window.startHour < window.endHour) {
    return hour >= window.startHour && hour < window.endHour
  }
  return hour >= window.startHour || hour < window.endHour
}

export function isCacheKeepActiveNow(
  storage: AccountStorage | null,
  now = new Date(),
) {
  if (storage?.cacheKeep?.enabled !== true) return false
  return (
    isCacheKeepAlways(storage) ||
    isWithinCacheKeepWindow(getCacheKeepWindow(storage), now)
  )
}

export function localDayKey(now = new Date()) {
  return `${now.getFullYear()}-${padHour(now.getMonth() + 1)}-${padHour(now.getDate())}`
}

function localWindowKey(window: CacheKeepWindow | undefined, now = new Date()) {
  if (
    window &&
    window.startHour > window.endHour &&
    now.getHours() < window.endHour
  ) {
    const previous = new Date(now)
    previous.setDate(previous.getDate() - 1)
    return localDayKey(previous)
  }
  return localDayKey(now)
}

function cacheKeepPeriodKey(
  storage: AccountStorage | null,
  window: CacheKeepWindow | undefined,
  now = new Date(),
) {
  return isCacheKeepAlways(storage) ? 'always' : localWindowKey(window, now)
}

export function buildCacheKeepStatusSummary(status: CacheKeepStatus) {
  const schedule = status.always
    ? 'always (while this process is running)'
    : status.window
      ? `${padHour(status.window.startHour)}-${padHour(status.window.endHour)}`
      : 'not configured'
  const lines = [
    `Cache keep: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Schedule: ${schedule}`,
    'Mode requirement: `/claude-cache mode hybrid` must be active.',
  ]
  if (typeof status.hybridActive === 'boolean') {
    lines.push(`Hybrid active: ${status.hybridActive ? 'yes' : 'no'}`)
  }
  if (typeof status.trackedSessions === 'number') {
    lines.push(`Tracked sessions: ${status.trackedSessions}`)
  }
  if (status.trackedSessionDetails?.length) {
    lines.push('Sessions:')
    for (const session of status.trackedSessionDetails) {
      lines.push(`- ${session.id}`)
    }
  }
  if (status.nextPrewarmAt) {
    lines.push(
      `Next prewarm: ${new Date(status.nextPrewarmAt).toLocaleString()}`,
    )
  }
  return lines.join('\n')
}

export function executeCacheKeepCommand(input: {
  argumentsText: string
  enabled?: boolean
  always?: boolean
  window?: CacheKeepWindow
  trackedSessions?: number
  trackedSessionDetails?: CacheKeepTrackedSession[]
  nextPrewarmAt?: number
  hybridActive?: boolean
}) {
  const action = parseCacheKeepCommandAction(input.argumentsText)
  const status = {
    enabled: input.enabled ?? false,
    always: input.always,
    window: input.window,
    trackedSessions: input.trackedSessions,
    trackedSessionDetails: input.trackedSessionDetails,
    nextPrewarmAt: input.nextPrewarmAt,
    hybridActive: input.hybridActive,
  }

  if (action.type === 'status') {
    return [STATUS_TITLE, '', buildCacheKeepStatusSummary(status)].join('\n')
  }

  if (action.type === 'disable') {
    return [
      DISABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({ ...status, enabled: false }),
    ].join('\n')
  }

  if (action.type === 'always') {
    return [
      ENABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({
        ...status,
        enabled: true,
        always: true,
        window: undefined,
      }),
    ].join('\n')
  }

  if (action.type === 'window') {
    return [
      ENABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({
        ...status,
        enabled: true,
        always: false,
        window: { startHour: action.startHour, endHour: action.endHour },
      }),
    ].join('\n')
  }

  if (action.type === 'subagents') {
    return [
      STATUS_TITLE,
      '',
      buildCacheKeepStatusSummary(status),
      '',
      `Subagent tracking: ${action.enabled ? 'enabled' : 'disabled'}`,
    ].join('\n')
  }

  return [USAGE_TITLE, '', USAGE, '', buildCacheKeepStatusSummary(status)].join(
    '\n',
  )
}

function hasExplicitCacheControl(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(hasExplicitCacheControl)
  const record = value as Record<string, unknown>
  const cacheControl = record.cache_control
  if (
    cacheControl &&
    typeof cacheControl === 'object' &&
    (cacheControl as Record<string, unknown>).type === 'ephemeral'
  ) {
    return true
  }
  return Object.values(record).some(hasExplicitCacheControl)
}

export async function buildCacheKeepPrewarmBody(
  bodyText: string,
): Promise<{ ok: true; bodyText: string } | { ok: false; reason: string }> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'body is not valid JSON' }
  }

  if (!hasExplicitCacheControl(body)) {
    return { ok: false, reason: 'body has no explicit cache breakpoints' }
  }

  const warm = structuredClone(body) as Record<string, unknown>
  warm.max_tokens = 0
  delete warm.stream

  const thinking = warm.thinking as Record<string, unknown> | undefined
  if (thinking?.type === 'enabled') delete warm.thinking

  const outputConfig = warm.output_config as Record<string, unknown> | undefined
  if (outputConfig?.format) delete warm.output_config

  const toolChoice = warm.tool_choice as Record<string, unknown> | undefined
  if (toolChoice?.type === 'tool' || toolChoice?.type === 'any') {
    delete warm.tool_choice
  }

  const signedBodyText = await signRequestBody(
    JSON.stringify(orderClaudeCodeBody(warm)),
  )
  return { ok: true, bodyText: signedBodyText }
}

export type CacheKeepTarget = {
  id: string
  url: string
  headers: Record<string, string>
  bodyText: string
  cacheExpiresAt: number
  dayKey: string
  oauthAccountId?: string
}

export type CacheKeepPrewarmResult =
  | {
      ok: true
      usage?: {
        input_tokens?: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    }
  | { ok: false; reason: string; status?: number; transient?: true }

export class CacheKeepManager {
  private readonly targets = new Map<string, CacheKeepTarget>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly options: {
      loadStorage: () => Promise<AccountStorage | null>
      fetchImpl?: typeof fetch
      now?: () => number
      prewarmTimeoutMs?: number
      setIntervalImpl?: typeof globalThis.setInterval
      clearIntervalImpl?: typeof globalThis.clearInterval
      prepareHeaders?: (
        headers: Headers,
        target: CacheKeepTarget,
      ) => Promise<Headers> | Headers
      onTrackedSessionsChanged?: (
        sessions: readonly CacheKeepTrackedSession[],
      ) => Promise<void> | void
    },
  ) {}

  start() {
    if (this.timer) return
    logger.debug('cachekeep', 'started')
    this.timer = (this.options.setIntervalImpl ?? globalThis.setInterval)(
      () => {
        void this.tick().catch((error) => {
          logger.warn('cachekeep', 'tick failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
      },
      CACHE_KEEP_TICK_MS,
    )
    if ('unref' in this.timer) this.timer.unref()
  }

  stop() {
    if (!this.timer) return
    logger.debug('cachekeep', 'stopped')
    const clearIntervalImpl =
      this.options.clearIntervalImpl ?? globalThis.clearInterval
    clearIntervalImpl(this.timer)
    this.timer = null
  }

  stats(
    window?: CacheKeepWindow,
    now = this.options.now?.() ?? Date.now(),
    always = false,
  ) {
    const today = always ? 'always' : localWindowKey(window, new Date(now))
    const targets = [...this.targets.values()].filter(
      (target) => target.dayKey === today,
    )
    const nextPrewarmAt = targets.length
      ? Math.min(
          ...targets.map(
            (target) => target.cacheExpiresAt - CACHE_KEEP_PREWARM_LEAD_MS,
          ),
        )
      : undefined
    return { trackedSessions: targets.length, nextPrewarmAt }
  }

  trackedSessions(): CacheKeepTrackedSession[] {
    return [...this.targets.values()]
      .map((target) => ({
        id: target.id,
        cacheExpiresAt: target.cacheExpiresAt,
        nextPrewarmAt: target.cacheExpiresAt - CACHE_KEEP_PREWARM_LEAD_MS,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  trackedOAuthRoute(
    sessionId: string,
  ): { oauthAccountId?: string } | undefined {
    const target = this.targets.get(sessionId)
    return target ? { oauthAccountId: target.oauthAccountId } : undefined
  }

  trackedCount(): number {
    return this.targets.size
  }

  private publishTrackedSessions() {
    const callback = this.options.onTrackedSessionsChanged
    if (!callback) return
    try {
      void Promise.resolve(callback(this.trackedSessions())).catch((error) => {
        logger.warn('cachekeep', 'failed to publish tracked sessions', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    } catch (error) {
      logger.warn('cachekeep', 'failed to publish tracked sessions', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private totalBodyBytes() {
    return [...this.targets.values()].reduce(
      (sum, target) => sum + target.bodyText.length,
      0,
    )
  }

  private evictOldestTarget() {
    const oldest = this.targets.keys().next().value
    if (oldest !== undefined) this.targets.delete(oldest)
  }

  private pruneTargets(now: number, today?: string) {
    for (const [id, target] of this.targets) {
      if (today && target.dayKey !== today) {
        this.targets.delete(id)
        continue
      }
      if (now - target.cacheExpiresAt > CACHE_KEEP_STALE_TARGET_MS) {
        this.targets.delete(id)
      }
    }
    while (this.targets.size > CACHE_KEEP_MAX_TARGETS) this.evictOldestTarget()
    while (this.totalBodyBytes() > CACHE_KEEP_MAX_BODY_BYTES) {
      const before = this.targets.size
      this.evictOldestTarget()
      if (this.targets.size === before) break
    }
  }

  track(input: {
    sessionId?: string | null
    url: string
    headers: Headers
    bodyText: string
    storage: AccountStorage | null
    cacheMode: string
    oauthAccountId?: string
  }) {
    if (!input.sessionId)
      return { tracked: false, reason: 'missing session id' }
    if (!isCacheKeepPersistentlyEnabled(input.storage)) {
      return { tracked: false, reason: 'cachekeep disabled' }
    }
    if (input.cacheMode !== 'hybrid') {
      return { tracked: false, reason: 'cache mode is not hybrid' }
    }
    if (input.bodyText.length > CACHE_KEEP_MAX_BODY_BYTES) {
      return { tracked: false, reason: 'body exceeds cachekeep memory budget' }
    }
    const now = this.options.now?.() ?? Date.now()
    const window = getCacheKeepWindow(input.storage)
    if (!isCacheKeepActiveNow(input.storage, new Date(now))) {
      return { tracked: false, reason: 'outside configured schedule' }
    }

    const today = cacheKeepPeriodKey(input.storage, window, new Date(now))
    this.pruneTargets(now, today)
    if (this.targets.has(input.sessionId)) this.targets.delete(input.sessionId)

    const headers: Record<string, string> = {}
    input.headers.forEach((value, key) => {
      headers[key] = value
    })

    this.targets.set(input.sessionId, {
      id: input.sessionId,
      url: input.url,
      headers,
      bodyText: input.bodyText,
      cacheExpiresAt: now + CACHE_KEEP_TTL_MS,
      dayKey: today,
      oauthAccountId: input.oauthAccountId,
    })
    this.pruneTargets(now, today)
    this.publishTrackedSessions()
    this.start()
    return { tracked: true }
  }

  async prewarmNow(input: {
    sessionId: string
    url: string
    headers: Headers
    bodyText: string
    oauthAccountId?: string
  }): Promise<CacheKeepPrewarmResult> {
    const headers: Record<string, string> = {}
    input.headers.forEach((value, key) => {
      headers[key] = value
    })
    const target: CacheKeepTarget = {
      id: input.sessionId,
      url: input.url,
      headers,
      bodyText: input.bodyText,
      cacheExpiresAt: this.options.now?.() ?? Date.now(),
      dayKey: '',
      oauthAccountId: input.oauthAccountId,
    }
    return this.sendPrewarm(target)
  }

  async tick() {
    const storage = await this.options.loadStorage()
    const window = getCacheKeepWindow(storage)
    const now = this.options.now?.() ?? Date.now()
    const today = cacheKeepPeriodKey(storage, window, new Date(now))
    if (isCacheKeepAlways(storage)) {
      for (const target of this.targets.values()) target.dayKey = 'always'
    }

    this.pruneTargets(now, today)
    if (!this.targets.size) {
      this.publishTrackedSessions()
      this.stop()
      return
    }

    if (!isCacheKeepHybridActive(storage)) {
      this.publishTrackedSessions()
      return
    }
    if (!isCacheKeepActiveNow(storage, new Date(now))) {
      this.publishTrackedSessions()
      return
    }

    logger.debug('cachekeep', 'fired', { targets: this.targets.size })
    const dueAt = now + CACHE_KEEP_PREWARM_LEAD_MS
    for (const target of this.targets.values()) {
      if (target.cacheExpiresAt > dueAt) continue
      try {
        await this.prewarm(target, now)
      } catch (error) {
        logger.warn('cachekeep', 'prewarm failed', {
          session: target.id,
          reason: error instanceof Error ? error.message : String(error),
        })
        target.cacheExpiresAt = now + CACHE_KEEP_PREWARM_LEAD_MS + 5 * 60_000
      }
    }
    this.publishTrackedSessions()
  }

  private async sendPrewarm(
    target: CacheKeepTarget,
  ): Promise<CacheKeepPrewarmResult> {
    const prewarm = await buildCacheKeepPrewarmBody(target.bodyText)
    if (!prewarm.ok) return prewarm

    const fetchImpl = this.options.fetchImpl ?? fetch
    const prewarmTarget = { ...target, bodyText: prewarm.bodyText }
    const headers = this.options.prepareHeaders
      ? await this.options.prepareHeaders(
          new Headers(target.headers),
          prewarmTarget,
        )
      : new Headers(target.headers)
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    let response: Response
    try {
      response = await fetchImpl(target.url, {
        method: 'POST',
        headers,
        body: prewarm.bodyText,
        signal: AbortSignal.timeout(
          this.options.prewarmTimeoutMs ?? CACHE_KEEP_PREWARM_TIMEOUT_MS,
        ),
      })
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        transient: true,
      }
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: await response
          .text()
          .catch(() => '')
          .then((body) => body || `HTTP ${response.status}`),
        status: response.status,
      }
    }
    const data = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    const usage = data?.usage as
      | {
          input_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
      | undefined
    return { ok: true, ...(usage && { usage }) }
  }

  private async prewarm(target: CacheKeepTarget, now: number) {
    const result = await this.sendPrewarm(target)
    if (!result.ok) {
      if (result.status == null && !result.transient) {
        logger.debug('cachekeep', 'prewarm skipped', {
          session: target.id,
          reason: result.reason,
        })
        this.targets.delete(target.id)
      } else {
        logger.warn('cachekeep', 'prewarm failed', {
          session: target.id,
          status: result.status,
          reason: result.reason,
        })
        target.cacheExpiresAt = now + CACHE_KEEP_PREWARM_LEAD_MS + 5 * 60_000
      }
      return
    }

    target.cacheExpiresAt = now + CACHE_KEEP_TTL_MS
    logger.debug('cachekeep', 'prewarm succeeded', {
      session: target.id,
      ...(result.usage && { usage: result.usage }),
    })
  }
}
