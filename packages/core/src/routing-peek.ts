import { quotaSnapshotHasStandardWindows } from './accounts.ts'
import { nativeAccountPolicy } from './native-account-runtime.ts'
import {
  type NativeAccountSnapshot,
  nativeAccountCanServe,
} from './native-account-view.ts'
import { getRoutingMode } from './routing.ts'
import type { StickySessionRouter } from './sticky-routing.ts'

/**
 * Inspect local routing from already-published memory only. Unknown inventory,
 * quota or affinity is not evidence that a session has moved. In particular,
 * this must never resolve a pin, spend a retry, or ask another service to choose
 * an account.
 */
export function peekRoutingAccount(input: {
  snapshot: NativeAccountSnapshot | undefined
  router?: StickySessionRouter
  sessionId: string
  modelId?: string
  affinityModelId?: string
}): string | undefined {
  const { snapshot } = input
  if (!snapshot?.accounts.length) return undefined
  const mode = getRoutingMode(snapshot.policyStorage)
  if (mode === 'sticky-balanced') {
    const pin = input.router?.peekAssignment(
      input.sessionId,
      input.affinityModelId,
    )
    if (!pin) return undefined
    const account = snapshot.accounts.find((row) => row.id === pin.accountId)
    if (
      account?.type !== 'oauth' ||
      !nativeAccountCanServe(account) ||
      (pin.accountIdentity !== undefined &&
        pin.accountIdentity !== account.accountIdentity)
    )
      return undefined
    // A retained pin, not a new weighted choice, decides an idle session's route.
    return account.id
  }
  const main = snapshot.accounts.filter((row) => row.id === 'main')
  const fallbacks = snapshot.accounts.filter((row) => row.id !== 'main')
  const ordered =
    mode === 'fallback-first'
      ? [...fallbacks, ...main]
      : [...main, ...fallbacks]
  for (const account of ordered) {
    if (account.type !== 'oauth' || !nativeAccountCanServe(account)) continue
    // A request can refresh a missing reading. Do not skip such an account and
    // mistake a lower-priority account for a definite routing decision.
    if (!quotaSnapshotHasStandardWindows(account.quota)) return undefined
    if (
      nativeAccountPolicy(account, snapshot, input.modelId).status === 'allowed'
    )
      return account.id
  }
  return undefined
}
