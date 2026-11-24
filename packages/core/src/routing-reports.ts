import {
  type ReportRoutingInput,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'
import {
  getScopedQuotaWindowForModel,
  type OAuthQuotaSnapshot,
  quotaFieldSource,
} from './accounts.ts'
import { logger } from './logger.ts'
import {
  hasScopedQuotaExhaustionHeaders,
  quotaExhaustionFromHeaders,
} from './quota-headers.ts'

export type RoutingReportSubject = {
  accountIdentity?: string
  credentialId?: string
}

// Shared routing's pool-name alphabet; it drops a report whose pool falls outside it.
const ROUTING_POOL_NAME = /^[a-z0-9._-]{1,64}$/
const QUOTA_STATUS = new Set([
  'accepted',
  'allowed',
  'allowed_warning',
  'rejected',
])
const QUOTA_NUMBER = /^[+-]?\d{1,24}(?:\.\d{1,16})?(?:e[+-]?\d{1,3})?$/i
const QUOTA_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function safeRateLimitHeaders(headers: Headers) {
  const safe: Record<string, string | null> = {}
  for (const [name, value] of headers) {
    if (!/^anthropic-ratelimit-[a-z0-9_-]{1,96}$/.test(name)) continue
    safe[name] =
      QUOTA_NUMBER.test(value) ||
      QUOTA_TIMESTAMP.test(value) ||
      (name.endsWith('-status') && QUOTA_STATUS.has(value))
        ? value
        : null
  }
  return safe
}

/** Pass serving or exhaustion evidence to routing without delaying or failing a send. */
export function reportRoutingResponse(
  sessionId: string,
  subject: RoutingReportSubject,
  headers: Headers,
  status: number,
  modelId?: string,
  served = status < 400,
  quotaFor?: () => Promise<OAuthQuotaSnapshot | undefined>,
  upstreamHttp429 = true,
): void {
  const handedOff: Array<{ window: '5h' | '7d'; pool?: string }> = []
  let noReportReason = 'no_confirmed_window'
  const send = (
    report: Extract<ReportRoutingInput, { outcome: 'served' | 'exhausted' }>,
  ) => {
    reportRouting(report)
    if (report.outcome === 'exhausted')
      handedOff.push({
        window: report.window,
        ...(report.pool && { pool: report.pool }),
      })
  }
  void Promise.resolve()
    .then(async () => {
      if (!subject.accountIdentity) {
        noReportReason = 'missing_account_identity'
        return
      }
      if (
        typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) !==
        'function'
      ) {
        noReportReason = 'no_routing_accessor'
        return
      }
      const identity = {
        sessionId,
        accountId: subject.accountIdentity,
        ...(subject.credentialId ? { credentialId: subject.credentialId } : {}),
      }
      if (served && status < 400) {
        const rateHeaders: Record<string, string> = {}
        headers.forEach((value, name) => {
          if (name.toLowerCase().startsWith('anthropic-ratelimit-'))
            rateHeaders[name.toLowerCase()] = value
        })
        send({ ...identity, outcome: 'served', headers: rateHeaders })
      }
      if (status !== 429) return
      const quota = quotaExhaustionFromHeaders(headers, modelId)
      for (const [window, reading] of [
        ['5h', quota.five_hour],
        ['7d', quota.seven_day],
      ] as const) {
        if (reading)
          send({
            ...identity,
            outcome: 'exhausted',
            window,
            ...(reading.resetsAt
              ? { resetsAt: Date.parse(reading.resetsAt) }
              : {}),
          })
      }
      const scopedHeaders = quota.scoped ?? []
      if (!scopedHeaders.length) {
        if (quota.five_hour || quota.seven_day || !upstreamHttp429 || !modelId)
          return
        if (hasScopedQuotaExhaustionHeaders(headers)) {
          noReportReason = 'different_confirmed_scope'
          return
        }
      }
      let stored: OAuthQuotaSnapshot | undefined
      try {
        stored = await quotaFor?.()
      } catch {
        noReportReason = 'quota_read_failed'
      }
      const scoped = getScopedQuotaWindowForModel(
        {
          scoped: stored?.scoped?.filter((row) =>
            row.id.startsWith('claude-weekly-scoped-'),
          ),
        },
        modelId,
      )
      const name = (scoped?.modelId ?? scoped?.modelName)?.trim().toLowerCase()
      const storedPool = name && ROUTING_POOL_NAME.test(name) ? name : undefined
      if (!scopedHeaders.length) {
        // A refusal plus a stored full usage reading is evidence of a blocked
        // pool; neither an unclassified 429 nor a stored reading alone is enough.
        if (!scoped || quotaFieldSource(stored, 'scoped') !== 'poll') {
          if (noReportReason !== 'quota_read_failed')
            noReportReason = 'no_stored_scoped_usage'
          return
        }
        const resetsAt = scoped.resetsAt ? Date.parse(scoped.resetsAt) : NaN
        if (scoped.remainingPercent !== 0 || !(resetsAt > Date.now())) {
          noReportReason = 'stored_scoped_usage_not_full_with_future_reset'
          return
        }
        if (!storedPool) {
          noReportReason = 'unknown_scoped_pool'
          return
        }
        send({
          ...identity,
          outcome: 'exhausted',
          window: '7d',
          pool: storedPool,
          resetsAt,
        })
        return
      }
      for (const reading of scopedHeaders) {
        // Claude names the Fable pool explicitly in this weekly header.
        // Never use an unknown suffix or omit the pool for a scoped limit.
        const pool =
          storedPool ??
          (reading.id === '7d_fable' || reading.id === '7d-fable'
            ? 'fable'
            : undefined)
        if (!pool) {
          noReportReason = 'unknown_scoped_pool'
          continue
        }
        send({
          ...identity,
          outcome: 'exhausted',
          window: '7d',
          pool,
          ...(reading.resetsAt
            ? { resetsAt: Date.parse(reading.resetsAt) }
            : {}),
        })
      }
    })
    .catch(() => {
      noReportReason = 'report_preparation_failed'
    })
    .finally(() => {
      if (status !== 429 || !upstreamHttp429) return
      const id = headers.get('request-id')
      logger.debug('routing-relay', 'Anthropic HTTP 429 routing report', {
        ...(/^req_[a-zA-Z0-9_-]{1,128}$/.test(id ?? '') && { requestId: id }),
        rateLimitHeaders: safeRateLimitHeaders(headers),
        exhaustedReports: handedOff,
        ...(!handedOff.length && { noReportReason }),
      })
    })
    .catch(() => {})
}
