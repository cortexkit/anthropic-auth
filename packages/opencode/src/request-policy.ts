import {
  type AccountStorage,
  getKillswitchThresholdsForAccount,
  getScopedQuotaWindowForModel,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
} from '@cortexkit/anthropic-auth-core'

/**
 * Format the user-facing 429 message for a killswitch block. When the block
 * is scoped-driven, name the model so the operator can distinguish a
 * per-model weekly block from a whole-account kill.
 */
export function formatKillswitchBlockMessage(input: {
  retryAfterSeconds?: number
  modelName?: string
}): string {
  const seconds = input.retryAfterSeconds
  const retryHint =
    seconds === undefined
      ? ''
      : ` Retry in ${Math.floor(seconds / 60)}m ${seconds % 60}s.`
  return input.modelName
    ? `${input.modelName} weekly limit reached, no routable accounts.${retryHint}`
    : `Killswitch: no routable accounts.${retryHint}`
}

/**
 * Decide whether a killswitch block is scoped-driven versus a whole-account
 * 5h/7d block. Account-level limits take precedence over scoped limits.
 */
export function resolveScopedDrivenBlock(input: {
  mainQuota: OAuthQuotaSnapshot | undefined
  requestModelId: string | undefined
  storage: AccountStorage | null
}):
  | { isScopedDriven: true; modelName: string; modelId: string }
  | { isScopedDriven: false } {
  if (!input.requestModelId) return { isScopedDriven: false }
  if (!killswitchPassesPolicy(input.mainQuota, input.storage)) {
    return { isScopedDriven: false }
  }
  const matchedWindow = getScopedQuotaWindowForModel(
    input.mainQuota,
    input.requestModelId,
  )
  if (!matchedWindow) return { isScopedDriven: false }
  if (!Number.isFinite(matchedWindow.remainingPercent)) {
    return { isScopedDriven: false }
  }
  const thresholds = getKillswitchThresholdsForAccount(input.storage)
  if (matchedWindow.remainingPercent <= thresholds.scoped) {
    return {
      isScopedDriven: true,
      modelName: matchedWindow.modelName,
      modelId: input.requestModelId,
    }
  }
  return { isScopedDriven: false }
}
