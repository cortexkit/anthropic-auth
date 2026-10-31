import {
  type AccountStorage,
  askRouting,
  getScopedQuotaWindowForModel,
  logger,
  type OAuthQuotaSnapshot,
  quotaExhaustionFromHeaders,
  type ReportRoutingInput,
  reportRouting,
  type StickyRouteCandidate,
  stickyRouteFamilyForModel,
  stickyRouteKnownFableExhausted,
} from '@cortexkit/anthropic-auth-core'

export const ROUTING_HOLD_LIMIT_MS = 15 * 60_000 + 20_000
export type RoutingChoice = {
  account_id: string
  credential_id: string
  hold?: { retry_after_ms: number }
}
type RoutingSubject = { accountIdentity?: string; credentialId?: string }

export function routingChoiceMatches(
  choice: RoutingChoice,
  account: RoutingSubject,
) {
  return (
    account.accountIdentity === choice.account_id &&
    (!account.credentialId || account.credentialId === choice.credential_id)
  )
}

/** Opus model requests spend accounts with exhausted Fable quota first, preserving the others for Fable requests. */
export function routingReserveAllows(
  accountId: string,
  candidates: readonly StickyRouteCandidate[],
  storage: AccountStorage | null,
  modelId: string,
) {
  if (stickyRouteFamilyForModel(modelId) !== 'opus') return true
  const depleted = candidates.filter((candidate) =>
    stickyRouteKnownFableExhausted(candidate, storage),
  )
  return !depleted.length || depleted.some((row) => row.accountId === accountId)
}

// Shared routing's pool-name alphabet; it drops a report whose pool falls outside it.
const ROUTING_POOL_NAME = /^[a-z0-9._-]{1,64}$/

export function createRoutingRelay(
  quotaFor?: (
    subject: RoutingSubject,
  ) => Promise<OAuthQuotaSnapshot | undefined>,
) {
  const overridden = new Set<string>()
  const override = (sessionId: string, reason: string) => {
    if (overridden.has(sessionId)) return
    if (overridden.size >= 512) {
      const first = overridden.values().next()
      if (!first.done) overridden.delete(first.value)
    }
    overridden.add(sessionId)
    logger.debug('routing-relay', 'Using local account choice', {
      sessionId,
      reason,
    })
  }
  return {
    override,
    async accountFor(
      sessionId: string,
      modelId: string,
      candidates: readonly RoutingSubject[],
    ): Promise<RoutingChoice | null> {
      const result = await askRouting({
        sessionId,
        provider: 'anthropic',
        modelId,
        deadlineMs: 2000,
        candidates: candidates.flatMap((row) =>
          row.accountIdentity
            ? [
                {
                  accountId: row.accountIdentity,
                  credentialId: row.credentialId ?? 'local',
                },
              ]
            : [],
        ),
      })
      if (!result) {
        override(sessionId, 'no valid answer within routing deadline')
        return null
      }
      return {
        account_id: result.candidate.accountId,
        credential_id: result.candidate.credentialId,
        ...(result.hold && result.hold.retry_after_ms > 0
          ? {
              hold: {
                retry_after_ms: Math.min(
                  result.hold.retry_after_ms,
                  ROUTING_HOLD_LIMIT_MS,
                ),
              },
            }
          : {}),
      }
    },
    report(
      sessionId: string,
      subject: RoutingSubject,
      headers: Headers,
      status: number,
      modelId?: string,
      served = status < 400,
    ) {
      if (!subject.accountIdentity) return
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
        if (!reports.length && !quota.scoped?.length)
          reports.push({ ...identity, outcome: 'exhausted', window: '7d' })
      }
      // Neither synchronous bridge errors nor rejected report promises can fail a send.
      void Promise.resolve()
        .then(async () => {
          for (const report of reports) reportRouting(report)
          if (quota?.scoped?.length) {
            const stored = await quotaFor?.(subject)
            // Stored usage-poll rows use this id prefix and keep the provider's
            // model identity; header-only rows cannot name a pool. Routing names
            // the pool by that identity in lowercase and ignores any other
            // spelling, so a name outside its alphabet sends no report: a report
            // without a valid pool would block the whole account for the week.
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
            for (const reading of quota.scoped) {
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
          }
        })
        .catch(() => {})
    },
  }
}
