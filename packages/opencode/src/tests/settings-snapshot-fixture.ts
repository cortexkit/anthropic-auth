import type * as core from '@cortexkit/anthropic-auth-core'
import { nondefaultSettings } from './opencode2-settings-readers'

export const snapshotTime = 1_900_000_000_000
export const snapshotModel = 'claude-opus-5-5'

export function snapshotSettings(absent: boolean): core.AccountStorage {
  const settings: core.AccountStorage = {
    version: 1,
    accounts: [],
    ...nondefaultSettings('vault:credential'),
  }
  if (absent) {
    if (settings.claudeCache) delete settings.claudeCache.enabled
    if (settings.quota) delete settings.quota.enabled
  }
  return settings
}

export function snapshotQuota(remaining: number): core.OAuthQuotaSnapshot {
  return {
    checkedAt: snapshotTime,
    scoped: [],
    five_hour: {
      remainingPercent: remaining,
      usedPercent: 100 - remaining,
      checkedAt: snapshotTime,
      resetsAt: new Date(snapshotTime + 600_000).toISOString(),
    },
    seven_day: {
      remainingPercent: remaining,
      usedPercent: 100 - remaining,
      checkedAt: snapshotTime,
      resetsAt: new Date(snapshotTime + 900_000).toISOString(),
    },
  }
}
