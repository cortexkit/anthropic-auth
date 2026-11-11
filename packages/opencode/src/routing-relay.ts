import {
  type AccountStorage,
  askRouting,
  logger,
  type OAuthQuotaSnapshot,
  reportRoutingResponse,
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
      reportRoutingResponse(
        sessionId,
        subject,
        headers,
        status,
        modelId,
        served,
        quotaFor ? () => quotaFor(subject) : undefined,
      )
    },
  }
}
