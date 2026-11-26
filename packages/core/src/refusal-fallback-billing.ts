import { reportRouting } from '@cortexkit/common-auth/routing-accessor'
import type { AnthropicBillingReport } from './billing.ts'

type Fallback = NonNullable<AnthropicBillingReport['fallback']>
type ReportContext = { hostRequestId: string; requestedModel: string }

export function createRefusalBillingFacts(
  refusalOnly = false,
  routedAnswer?: () => Fallback | undefined,
) {
  const { promise, resolve } = Promise.withResolvers<Fallback | undefined>()
  return { promise, refusalOnly, resolve, routedAnswer }
}

export function reportClientFallbackAttempt(
  sessionId: string,
  requestId: string,
  cause: 'refused_here' | 'round',
) {
  reportRouting({
    sessionId,
    kind: 'fallback_attempt',
    requestId,
    by: 'client',
    cause,
  })
}

export function clientRefusalBilling(
  context: ReportContext,
  category: string | undefined,
): Fallback {
  return {
    ...context,
    role: 'refused',
    by: 'client',
    ...(category && { category }),
  }
}

export function clientRetryBilling(
  context: ReportContext,
  category: string | undefined,
  credited: boolean,
): Fallback {
  return {
    ...context,
    role: 'answer',
    by: 'client',
    ...(category && { category }),
    cause: 'refused_here',
    credited,
  }
}
