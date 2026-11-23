import type * as core from '@cortexkit/anthropic-auth-core'
import releaseSnapshots from './fixtures/settings-2.11.2.json'
import { nondefaultSettings } from './opencode2-settings-readers'

export const snapshotTime = 1_900_000_000_000
export const snapshotModel = 'claude-opus-5-5'

export function expectedReleaseSnapshot(
  host: 1 | 2,
  sample: 'explicit' | 'absent',
) {
  const released = releaseSnapshots[`oc${host}-${sample}`]
  // The feed setting is gone. The wire reader in both snapshots is OpenCode 2's.
  const { quota_header_feed_enabled: _removed, ...outputs } =
    released.readers.outputs
  // The frozen OpenCode 1 sample already has the five-minute request bytes and
  // CacheKeep body sizes that OpenCode 2 should now produce with no override.
  const short = releaseSnapshots['oc1-absent']
  return {
    ...released,
    readers: {
      outputs,
      wire: { ...released.readers.wire, cache1hEnabled: sample === 'explicit' },
    },
    ...(host === 2 &&
      sample === 'absent' && {
        request: { ...released.request, body: short.request.body },
        logs: short.logs,
      }),
  }
}

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
