import {
  type NativeAccountPolicy,
  type NativeQuotaPolicyLimit,
  nativeAccountPolicy,
} from './native-account-runtime.ts'
import {
  type NativeAccountSnapshot,
  nativeAccountCanServe,
} from './native-account-view.ts'
import { NativeVaultNoAccountError } from './native-vault-admission.ts'
import {
  createExhaustedNoRouteResponse,
  createStickyNoRouteResponse,
  type StickyQuotaBlocker,
  stickyRouteCandidateWeight,
  stickyRouteFamilyForModel,
} from './sticky-routing.ts'

/** Preserve authentication precedence, then explain the shared policy's exclusions. */
export function createNativeVaultNoRouteResponse(input: {
  snapshot: NativeAccountSnapshot
  modelId?: string
  policies?: ReadonlyMap<string, NativeAccountPolicy>
  providerBlockers?: readonly StickyQuotaBlocker[]
  /** Use the provider-exhaustion response when the caller has ruled out every route. */
  fallbackToProviderExhaustion?: boolean
  sticky?: boolean
  sessionId?: string | null
  waitForReset?: boolean
}): Response {
  const { snapshot, modelId } = input
  const accounts = snapshot.accounts.filter(
    (account) => account.type === 'oauth',
  )
  // As in local sticky routing, a sign-in failure takes precedence over quota.
  if (
    accounts.some(
      (account) => account.enabled && account.state === 'needs_reauth',
    )
  )
    throw new NativeVaultNoAccountError()
  const active = accounts.filter(nativeAccountCanServe)
  const limits = new Set<NativeQuotaPolicyLimit>()
  for (const account of active) {
    const policy =
      input.policies?.get(account.id) ??
      nativeAccountPolicy(account, snapshot, modelId)
    for (const limit of policy.quotaPolicyLimits ?? []) limits.add(limit)
    if (input.sticky) {
      // New sticky placements need quota above the floor; a retained pin may
      // still serve at equality. Ask the router's weighting policy, not a copy.
      stickyRouteCandidateWeight({
        candidate: {
          accountId: account.id,
          order: 0,
          quota: account.quota ?? { kind: 'unknown' },
        },
        family: stickyRouteFamilyForModel(modelId),
        modelId,
        storage: snapshot.policyStorage,
        onPolicyBlock: (limit) => limits.add(limit),
      })
    }
  }
  const providerLimitNames = input.providerBlockers?.map(
    (blocker) => blocker.limitName,
  )
  if (!limits.size) {
    if (input.fallbackToProviderExhaustion && input.providerBlockers?.length)
      return createExhaustedNoRouteResponse({
        exhausted: input.providerBlockers,
        providerLimitNames,
        storage: snapshot.policyStorage,
        sessionId: input.sessionId,
      })
    throw new NativeVaultNoAccountError()
  }
  return createStickyNoRouteResponse({
    routeQuotas: active.flatMap((account) =>
      account.quota ? [account.quota] : [],
    ),
    modelId,
    routeIdentities: active
      .filter((account) => account.quota)
      .map((account) => account.accountIdentity),
    routeAccountIds: active
      .filter((account) => account.quota)
      .map((account) => account.id),
    storage: snapshot.policyStorage,
    sessionId: input.sessionId,
    vaultPolicyLimits: [...limits],
    providerLimitNames,
    waitForReset:
      input.waitForReset && active.every((account) => account.quota),
  })
}

type QuotaPolicyBody = {
  type: 'error'
  error: { type: 'rate_limit_error' | 'FAILED_PRECONDITION'; message: string }
}

/** OpenCode 2 selection refuses before sending; its chooser cannot return a Response. */
export class NativeVaultQuotaPolicyError extends Error {
  readonly kind = 'quota-policy'
  readonly status: number
  readonly headers: Headers
  readonly retryAfter: number

  private constructor(
    readonly response: Response,
    readonly body: QuotaPolicyBody,
  ) {
    super(body.error.message)
    this.name = 'NativeVaultQuotaPolicyError'
    this.status = response.status
    this.headers = new Headers(response.headers)
    this.retryAfter = Number(this.headers.get('retry-after'))
  }

  static async fromResponse(
    response: Response,
  ): Promise<NativeVaultQuotaPolicyError> {
    return new NativeVaultQuotaPolicyError(
      response,
      (await response.clone().json()) as QuotaPolicyBody,
    )
  }
}
