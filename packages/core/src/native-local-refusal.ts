import { getScopedQuotaWindowForModel } from './accounts.ts'
import {
  type NativeAccountPolicy,
  type NativeQuotaPolicyLimit,
  nativeAccountPolicy,
} from './native-account-runtime.ts'
import {
  type NativeAccountSnapshot,
  nativeAccountCanServe,
} from './native-account-view.ts'
import {
  createOAuthReauthError,
  stickyRouteCandidateWeight,
  stickyRouteFamilyForModel,
} from './sticky-routing.ts'

/** Explain a terminal local refusal without attempting to authorize any excluded route. */
export function createNativeLocalNoRouteError(input: {
  snapshot: NativeAccountSnapshot
  modelId?: string
  sticky?: boolean
  policies?: ReadonlyMap<string, NativeAccountPolicy>
  declinedIds?: readonly string[]
  otherReasons?: readonly string[]
}) {
  const { snapshot, modelId } = input
  if (snapshot.mode !== 'local') return undefined
  const accounts = snapshot.accounts.filter(
    (account) =>
      account.type === 'oauth' &&
      account.source === 'local' &&
      account.state !== 'unsupported-access' &&
      nativeAccountCanServe(account),
  )
  const confirmed = accounts.filter((account) =>
    input.declinedIds
      ? input.declinedIds.includes(account.id)
      : account.localAuthDecline === 'invalid-grant',
  )
  if (!confirmed.length) return undefined

  const alternatives = accounts.filter(
    (account) => !confirmed.includes(account),
  )
  const modelName = modelId
    ? alternatives
        .map((account) => getScopedQuotaWindowForModel(account.quota, modelId))
        .find(Boolean)?.modelName
    : undefined
  const limits = new Set<NativeQuotaPolicyLimit>()
  for (const [order, account] of alternatives.entries()) {
    const policy =
      input.policies?.get(account.id) ??
      nativeAccountPolicy(account, snapshot, modelId)
    for (const limit of policy.quotaPolicyLimits ?? []) limits.add(limit)
    if (input.sticky)
      stickyRouteCandidateWeight({
        candidate: {
          accountId: account.id,
          order,
          quota: account.quota ?? { kind: 'unknown' },
        },
        family: stickyRouteFamilyForModel(modelId),
        modelId,
        storage: snapshot.policyStorage,
        onPolicyBlock: (limit) => limits.add(limit),
      })
  }
  const limitNames = [...limits].map((limit) =>
    limit === 'model-scoped'
      ? `${modelName ?? 'Model'} scoped limit`
      : limit === 'killswitch'
        ? 'killswitch limit'
        : 'quota floor',
  )
  return createOAuthReauthError({
    mainRequiresReauth: confirmed.some((account) => account.id === 'main'),
    fallbackReauthLabels: confirmed
      .filter((account) => account.id !== 'main')
      .map((account) => account.label || account.id),
    modelName,
    quotaReason: [
      ...(limitNames.length
        ? [
            `Other OAuth routes are blocked by quota policy: ${limitNames.join(', ')}.`,
          ]
        : []),
      ...(input.otherReasons ?? []),
    ].join(' '),
  })
}
