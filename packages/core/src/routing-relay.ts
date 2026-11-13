import {
  askRouting,
  type RoutingRefusal,
} from '@cortexkit/common-auth/routing-accessor'
import type { OAuthQuotaSnapshot } from './accounts.ts'
import { clampHostRetryMs, MAX_HOST_RETRY_MS } from './host-retry.ts'
import { logger } from './logger.ts'
import {
  type NativeAccountSnapshot,
  nativeAccountPolicy,
} from './native-account-runtime.ts'
import {
  type NativeAccountView,
  nativeAccountCanServe,
} from './native-account-view.ts'
import { reportRoutingResponse } from './routing-reports.ts'

export const ROUTING_HOLD_LIMIT_MS = MAX_HOST_RETRY_MS
export type RoutingChoice = {
  account_id: string
  credential_id: string
  hold?: { retry_after_ms: number }
}
type RoutingSubject = { accountIdentity?: string; credentialId?: string }

/** Routing owns quota reserves, including unknown readings and the minimum remaining quota set by the killswitch. Offer only subscription credentials the host may use. */
export function routingCandidates(accounts: readonly NativeAccountView[]) {
  return accounts.filter(
    (account) => account.type === 'oauth' && nativeAccountCanServe(account),
  )
}

/** Hint only the still-servable vault credential behind the session's own pin. */
export function routingWarmCredential(
  accounts: readonly NativeAccountView[],
  assignment: { accountId: string; accountIdentity?: string } | undefined,
): string | undefined {
  if (!assignment) return undefined
  return routingCandidates(accounts).find(
    (account) =>
      account.id === assignment.accountId &&
      account.source === 'vault' &&
      (!assignment.accountIdentity ||
        account.accountIdentity === assignment.accountIdentity),
  )?.credentialId
}

export function routingChoiceMatches(
  choice: RoutingChoice,
  account: RoutingSubject,
) {
  return (
    account.accountIdentity === choice.account_id &&
    (account.credentialId ?? 'local') === choice.credential_id
  )
}

/** Fixed text avoids exposing router internals and is not a host auto-retry signal. */
export class RoutingRefusalError extends Error {
  readonly code: RoutingRefusal['refused']['code']
  readonly retryAfterSecs?: number
  readonly status: number

  constructor(refusal: RoutingRefusal['refused'], now = Date.now()) {
    super(
      refusal.code === 'account_selection_final'
        ? 'Shared routing refused an account for this request.'
        : 'Shared routing has no account for this request right now.',
    )
    this.name = 'RoutingRefusalError'
    this.code = refusal.code
    this.status = refusal.code === 'account_selection_final' ? 403 : 429
    this.retryAfterSecs =
      this.status === 429
        ? (refusal.retryAfterSecs ??
          (refusal.resetsAtMs === undefined
            ? undefined
            : Math.max(0, Math.ceil((refusal.resetsAtMs - now) / 1000))))
        : undefined
    if (this.retryAfterSecs !== undefined)
      this.retryAfterSecs = clampHostRetryMs(this.retryAfterSecs * 1000) / 1000
  }

  response() {
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: this.status === 429 ? 'rate_limit_error' : 'permission_error',
          code: this.code,
          message: this.message,
        },
      }),
      {
        status: this.status,
        headers: {
          'content-type': 'application/json',
          ...(this.retryAfterSecs === undefined
            ? {}
            : { 'retry-after': String(this.retryAfterSecs) }),
        },
      },
    )
  }
}

export function createRoutingRelay(
  quotaFor?: (
    subject: RoutingSubject,
  ) => Promise<OAuthQuotaSnapshot | undefined>,
) {
  const overridden = new Set<string>()
  // Two choices in one session can replace each other's admission. An earlier
  // pick then faces the local quota floor again; no different account gains an exemption.
  const admissions = new Map<string, RoutingChoice>()
  const silenced = new Set<string>()
  const override = (sessionId: string, reason: string) => {
    if (admissions.delete(sessionId)) {
      if (silenced.size >= 512) {
        const first = silenced.values().next()
        if (!first.done) silenced.delete(first.value)
      }
      silenced.add(sessionId)
    }
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
    shouldReport(sessionId: string) {
      return !silenced.has(sessionId)
    },
    admitted(sessionId: string, subject: RoutingSubject) {
      const choice = admissions.get(sessionId)
      return !!choice && routingChoiceMatches(choice, subject)
    },
    policy(
      sessionId: string,
      account: NativeAccountView,
      snapshot: NativeAccountSnapshot,
      modelId?: string,
    ) {
      const choice = admissions.get(sessionId)
      return choice &&
        routingChoiceMatches(choice, account) &&
        nativeAccountCanServe(account)
        ? { status: 'allowed' as const }
        : nativeAccountPolicy(account, snapshot, modelId)
    },
    async accountFor(
      sessionId: string,
      modelId: string,
      candidates: readonly RoutingSubject[],
      warmCredentialId?: string,
    ): Promise<RoutingChoice | null> {
      admissions.delete(sessionId)
      silenced.delete(sessionId)
      const result = await askRouting({
        sessionId,
        provider: 'anthropic',
        modelId,
        deadlineMs: 2000,
        refusals: true,
        ...(warmCredentialId ? { warmCredentialId } : {}),
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
      if ('refused' in result) throw new RoutingRefusalError(result.refused)
      const choice = {
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
      if (admissions.size >= 512) {
        const first = admissions.keys().next()
        if (!first.done) admissions.delete(first.value)
      }
      admissions.set(sessionId, choice)
      return choice
    },
    report(
      sessionId: string,
      subject: RoutingSubject,
      headers: Headers,
      status: number,
      modelId?: string,
      served = status < 400,
    ) {
      if (silenced.has(sessionId)) return
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
