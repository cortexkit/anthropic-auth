import * as a from '../accounts.ts'
import * as keep from '../cachekeep.ts'
import { getMaxSameAccountWait, getRoutingMode } from '../routing.ts'
import { legacySettingsProtection } from '../settings-protection-legacy.ts'
import { getThinkingPrefixMismatchBehavior } from '../thinking-binding.ts'
import { applyTurnEndNotes } from '../turn-end-note.ts'

export const explicitLegacySettings = {
  routing: { mode: 'fallback-first', maxSameAccountWait: 'max' },
  fallbackOn: [502],
  refresh: {
    enabled: false,
    intervalMinutes: 12,
    refreshBeforeExpiryMinutes: 60,
  },
  quota: {
    enabled: false,
    checkIntervalMinutes: 8,
    refreshEveryNRequests: 7,
    minimumRemaining: { five_hour: 11, seven_day: 12, scoped: 13 },
    failClosedOnUnknownQuota: false,
    showToasts: true,
  },
  quotaHeaderFeed: { enabled: true },
  killswitch: {
    enabled: true,
    main: { five_hour: 21, seven_day: 22, scoped: 23 },
    accounts: { local: { five_hour: 31, seven_day: 32, scoped: 33 } },
  },
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: {
    enabled: true,
    always: true,
    startHour: 8,
    endHour: 18,
    subagents: true,
  },
  dump: { enabled: true },
  prime: { enabled: true },
  claudeFast: { enabled: true },
  costZeroing: { enabled: false },
  logging: { level: 'debug' },
  thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
  turnEndNote: { tools: ['custom'] },
} satisfies Partial<a.AccountStorage>

const now = Date.parse('2026-11-02T10:00:00Z')
const quota: a.OAuthQuotaSnapshot = {
  accountIdentity: 'current',
  five_hour: {
    remainingPercent: 10,
    usedPercent: 90,
    checkedAt: now,
    resetsAt: new Date(now + 60_000).toISOString(),
  },
  seven_day: {
    remainingPercent: 90,
    usedPercent: 10,
    checkedAt: now,
    resetsAt: new Date(now + 60_000).toISOString(),
  },
}
type Reader = (s: a.AccountStorage) => unknown

// Each entry invokes the named reader, not a projection of the settings record.
export const coreDefaultReaders = {
  routing_mode: getRoutingMode,
  max_same_account_wait: getMaxSameAccountWait,
  fallback_on: (s) =>
    [401, 403, 429, 502].map((status) => a.shouldFallbackStatus(status, s)),
  refresh_interval_minutes: a.getRefreshIntervalMs,
  refresh_refresh_before_expiry_minutes: a.getRefreshBeforeExpiryMs,
  quota_enabled: a.quotaEnabled,
  quota_check_interval_minutes: a.getQuotaCheckIntervalMs,
  quota_refresh_every_n_requests: a.getQuotaRefreshEveryNRequests,
  quota_minimum_remaining_five_hour: (s) =>
    a.getQuotaMinimumRemainingThresholds(s).five_hour,
  quota_minimum_remaining_seven_day: (s) =>
    a.getQuotaMinimumRemainingThresholds(s).seven_day,
  quota_minimum_remaining_scoped: (s) =>
    a.normalizeKillswitchThresholds(s.quota?.minimumRemaining).scoped,
  quota_fail_closed_on_unknown_quota: a.failClosedOnUnknownQuota,
  killswitch_enabled: a.isKillswitchEnabled,
  killswitch_default_five_hour: (s) =>
    a.getKillswitchThresholdsForAccount(s).five_hour,
  killswitch_default_seven_day: (s) =>
    a.getKillswitchThresholdsForAccount(s).seven_day,
  killswitch_default_scoped: (s) =>
    a.getKillswitchThresholdsForAccount(s).scoped,
  // Consumers normalize missing thresholds to 5/10/0 (accounts.ts), and OpenCode 1's
  // dialog seed does the same (opencode/src/tui/command-dialogs.tsx). Menus copy main/accounts
  // without presence-based policy decisions. OpenCode 2 and Pi status intentionally show
  // the richer effective config in file mode; snapshot only this field's floors.
  killswitch_account_floors: (s) => a.getKillswitchConfig(s).accounts ?? {},
  claude_cache_enabled: a.isCache1hPersistentlyEnabled,
  claude_cache_mode: a.getCache1hPersistentMode,
  cache_keep_enabled: keep.isCacheKeepPersistentlyEnabled,
  cache_keep_always: keep.isCacheKeepAlways,
  cache_keep_window: keep.getCacheKeepWindow,
  cache_keep_subagents: a.isCacheKeepSubagentsEnabled,
  dump_enabled: a.isDumpPersistentlyEnabled,
  prime_enabled: a.isPrimePersistentlyEnabled,
  claude_fast_enabled: a.isFastModePersistentlyEnabled,
  cost_zeroing_enabled: a.isCostZeroingEnabled,
  log_level: a.getPersistedLogLevel,
  thinking_binding_prefix_mismatch_behavior: getThinkingPrefixMismatchBehavior,
  turn_end_note_tools: (s) => {
    const tools: string[] = []
    applyTurnEndNotes(
      { model: 'claude-opus-5-5', messages: [] },
      {
        tools: s.turnEndNote?.tools,
        mapToolName: (name) => {
          tools.push(name)
          return name
        },
      },
    )
    return tools
  },
} satisfies Record<string, Reader>

export const coreThreeWayReaders: Record<string, Record<string, Reader>> = {
  claude_cache_enabled: {
    isCache1hPersistentlyEnabled: a.isCache1hPersistentlyEnabled,
    isCacheKeepHybridActive: keep.isCacheKeepHybridActive,
  },
  quota_enabled: {
    quotaEnabled: a.quotaEnabled,
    'quotaSnapshotPassesPolicy (via quotaEnabled)': (s) =>
      a.quotaSnapshotPassesPolicy(quota, s),
    'quotaRefusalTiming (via quotaEnabled)': (s) =>
      a.quotaRefusalTiming({
        storage: s,
        readings: [{ quota, accountIdentity: 'current' }],
        now,
      }),
    'getQuotaNextRefreshAt (via quotaEnabled)': (s) =>
      a.getQuotaNextRefreshAt(quota, s, now),
  },
  quota_fail_closed_on_unknown_quota: {
    legacySettingsProtection: (s) =>
      legacySettingsProtection(s, 'opencode')
        .quota_fail_closed_on_unknown_quota,
    failClosedOnUnknownQuota: a.failClosedOnUnknownQuota,
    'quotaSnapshotPassesPolicy (via failClosedOnUnknownQuota)': (s) =>
      a.quotaSnapshotPassesPolicy(undefined, s),
    'killswitchPassesPolicy (via failClosedOnUnknownQuota)': (s) =>
      a.killswitchPassesPolicy(undefined, s),
  },
}

export function coreReaderBytes(s: a.AccountStorage) {
  return JSON.stringify({
    defaults: Object.entries(coreDefaultReaders).map(([key, read]) => [
      key,
      read(s),
    ]),
    threeWay: Object.entries(coreThreeWayReaders).map(([key, readers]) => [
      key,
      Object.entries(readers).map(([name, read]) => [name, read(s)]),
    ]),
  })
}
