import {
  type ReportRoutingInput,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'
import {
  getScopedQuotaWindowForModel,
  type OAuthQuotaSnapshot,
} from './accounts.ts'
import { quotaExhaustionFromHeaders } from './quota-headers.ts'

export type RoutingReportSubject = {
  accountIdentity?: string
  credentialId?: string
}

// Shared routing's pool-name alphabet; it drops a report whose pool falls outside it.
const ROUTING_POOL_NAME = /^[a-z0-9._-]{1,64}$/

/** Report only the serving response's raw headers, without delaying or failing a send. */
export function reportRoutingResponse(
  sessionId: string,
  subject: RoutingReportSubject,
  headers: Headers,
  status: number,
  modelId?: string,
  served = status < 400,
  quotaFor?: () => Promise<OAuthQuotaSnapshot | undefined>,
): void {
  // Header parsing, storage reads and bridge calls all stay off the send's error path.
  void Promise.resolve()
    .then(async () => {
      if (
        !subject.accountIdentity ||
        typeof Reflect.get(globalThis, Symbol.for('cortexkit.routing')) !==
          'function'
      )
        return
      const identity = {
        sessionId,
        accountId: subject.accountIdentity,
        ...(subject.credentialId ? { credentialId: subject.credentialId } : {}),
      }
      const reports: ReportRoutingInput[] = []
      if (served && status < 400) {
        const rateHeaders: Record<string, string> = {}
        headers.forEach((value, name) => {
          if (name.toLowerCase().startsWith('anthropic-ratelimit-'))
            rateHeaders[name.toLowerCase()] = value
        })
        reports.push({ ...identity, outcome: 'served', headers: rateHeaders })
      }
      const quota =
        status === 429
          ? quotaExhaustionFromHeaders(headers, modelId)
          : undefined
      if (quota) {
        // Display percentages round near-full windows to 100. Only the refused
        // response's raw headers can confirm exhaustion, never saved quota.
        for (const [window, reading] of [
          ['5h', quota.five_hour],
          ['7d', quota.seven_day],
        ] as const) {
          if (reading)
            reports.push({
              ...identity,
              outcome: 'exhausted',
              window,
              ...(reading.resetsAt
                ? { resetsAt: Date.parse(reading.resetsAt) }
                : {}),
            })
        }
      }
      for (const report of reports) reportRouting(report)
      if (quota?.scoped?.length) {
        const stored = await quotaFor?.()
        // Only stored usage-poll rows carry a pool identity. Header-only rows
        // cannot name a pool, and omitting it would block the whole account.
        const scoped = getScopedQuotaWindowForModel(
          {
            scoped: stored?.scoped?.filter((row) =>
              row.id.startsWith('claude-weekly-scoped-'),
            ),
          },
          modelId,
        )
        const pool = (scoped?.modelId ?? scoped?.modelName)
          ?.trim()
          .toLowerCase()
        if (!pool || !ROUTING_POOL_NAME.test(pool)) return
        for (const reading of quota.scoped)
          reportRouting({
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
    .catch(() => {})
}
