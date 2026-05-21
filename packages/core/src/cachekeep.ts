import type { AccountStorage } from './accounts.ts'
import { signRequestBody } from './cch.ts'
import { orderClaudeCodeBody } from './claude-code.ts'

export const CLAUDE_CACHE_KEEP_COMMAND_NAME = 'claude-cachekeep'
export const CACHE_KEEP_TTL_MS = 60 * 60_000
export const CACHE_KEEP_PREWARM_LEAD_MS = 5 * 60_000
export const CACHE_KEEP_TICK_MS = 60_000
export const CACHE_KEEP_EXTENDED_TTL_BETA = 'extended-cache-ttl-2025-04-11'

const STATUS_TITLE = '## Claude Cache Keep Status'
const ENABLED_TITLE = '## Claude Cache Keep Enabled'
const DISABLED_TITLE = '## Claude Cache Keep Disabled'
const USAGE_TITLE = '## Claude Cache Keep Usage'
const USAGE =
  'Usage: `/claude-cachekeep`, `/claude-cachekeep off`, or `/claude-cachekeep HH-HH`.'

export type CacheKeepWindow = {
  startHour: number
  endHour: number
}

export type CacheKeepCommandAction =
  | { type: 'status' }
  | { type: 'disable' }
  | { type: 'window'; startHour: number; endHour: number }
  | { type: 'usage' }

export type CacheKeepStatus = {
  enabled: boolean
  window?: CacheKeepWindow
  trackedSessions?: number
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

export function isCacheKeepPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.cacheKeep?.enabled === true && !!getCacheKeepWindow(storage)
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

export function buildCacheKeepStatusSummary(status: CacheKeepStatus) {
  const window = status.window
    ? `${padHour(status.window.startHour)}-${padHour(status.window.endHour)}`
    : 'not configured'
  const lines = [
    `Cache keep: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Window: ${window}`,
    'Mode requirement: `/claude-cache mode hybrid` must be active.',
  ]
  if (typeof status.hybridActive === 'boolean') {
    lines.push(`Hybrid active: ${status.hybridActive ? 'yes' : 'no'}`)
  }
  if (typeof status.trackedSessions === 'number') {
    lines.push(`Tracked sessions: ${status.trackedSessions}`)
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
  window?: CacheKeepWindow
  trackedSessions?: number
  nextPrewarmAt?: number
  hybridActive?: boolean
}) {
  const action = parseCacheKeepCommandAction(input.argumentsText)
  const status = {
    enabled: input.enabled ?? false,
    window: input.window,
    trackedSessions: input.trackedSessions,
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

  if (action.type === 'window') {
    return [
      ENABLED_TITLE,
      '',
      buildCacheKeepStatusSummary({
        ...status,
        enabled: true,
        window: { startHour: action.startHour, endHour: action.endHour },
      }),
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
}

export class CacheKeepManager {
  private readonly targets = new Map<string, CacheKeepTarget>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly options: {
      loadStorage: () => Promise<AccountStorage | null>
      fetchImpl?: typeof fetch
      now?: () => number
      prepareHeaders?: (
        headers: Headers,
        target: CacheKeepTarget,
      ) => Promise<Headers> | Headers
      log?: (message: string, data?: Record<string, unknown>) => void
    },
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.options.log?.('[cachekeep] tick failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, CACHE_KEEP_TICK_MS)
    if ('unref' in this.timer) this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  stats(window?: CacheKeepWindow, now = this.options.now?.() ?? Date.now()) {
    const today = localWindowKey(window, new Date(now))
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

  trackedCount(): number {
    return this.targets.size
  }

  track(input: {
    sessionId?: string | null
    url: string
    headers: Headers
    bodyText: string
    storage: AccountStorage | null
    cacheMode: string
  }) {
    if (!input.sessionId)
      return { tracked: false, reason: 'missing session id' }
    if (!isCacheKeepPersistentlyEnabled(input.storage)) {
      return { tracked: false, reason: 'cachekeep disabled' }
    }
    if (input.cacheMode !== 'hybrid') {
      return { tracked: false, reason: 'cache mode is not hybrid' }
    }
    const now = this.options.now?.() ?? Date.now()
    const window = getCacheKeepWindow(input.storage)
    if (!isWithinCacheKeepWindow(window, new Date(now))) {
      return { tracked: false, reason: 'outside configured window' }
    }

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
      dayKey: localWindowKey(window, new Date(now)),
    })
    this.start()
    return { tracked: true }
  }

  async tick() {
    const storage = await this.options.loadStorage()
    const window = getCacheKeepWindow(storage)
    const now = this.options.now?.() ?? Date.now()
    const today = localWindowKey(window, new Date(now))

    for (const [id, target] of this.targets) {
      if (target.dayKey !== today) this.targets.delete(id)
    }
    if (!this.targets.size) {
      this.stop()
      return
    }

    if (!isCacheKeepHybridActive(storage)) return
    if (!isWithinCacheKeepWindow(window, new Date(now))) return

    const dueAt = now + CACHE_KEEP_PREWARM_LEAD_MS
    for (const target of this.targets.values()) {
      if (target.cacheExpiresAt > dueAt) continue
      await this.prewarm(target, now)
    }
  }

  private async prewarm(target: CacheKeepTarget, now: number) {
    const prewarm = await buildCacheKeepPrewarmBody(target.bodyText)
    if (!prewarm.ok) {
      this.options.log?.('[cachekeep] prewarm skipped', {
        session: target.id,
        reason: prewarm.reason,
      })
      this.targets.delete(target.id)
      return
    }

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
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers,
      body: prewarm.bodyText,
    })
    if (!response.ok) {
      this.options.log?.('[cachekeep] prewarm failed', {
        session: target.id,
        status: response.status,
        body: await response.text().catch(() => ''),
      })
      target.cacheExpiresAt = now + CACHE_KEEP_PREWARM_LEAD_MS + 5 * 60_000
      return
    }
    await response.body?.cancel().catch(() => {})
    target.cacheExpiresAt = now + CACHE_KEEP_TTL_MS
    this.options.log?.('[cachekeep] prewarm succeeded', { session: target.id })
  }
}
