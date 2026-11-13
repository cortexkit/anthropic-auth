import * as core from '@cortexkit/anthropic-auth-core'

export const snapshotTime = 1_900_000_000_000
export const snapshotModel = {
  id: 'claude-opus-5-5',
  name: 'Claude Opus',
  api: 'anthropic-messages' as const,
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text' as const],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 200_000,
  maxTokens: 128_000,
}

export function snapshotSettings(absent: boolean): core.AccountStorage {
  return {
    version: 1,
    accounts: [],
    routing: { mode: 'fallback-first', maxSameAccountWait: 'max' },
    fallbackOn: [418, 503],
    refresh: {
      enabled: false,
      intervalMinutes: 3,
      refreshBeforeExpiryMinutes: 99,
    },
    quota: {
      ...(!absent && { enabled: false }),
      checkIntervalMinutes: 7,
      refreshEveryNRequests: 8,
      minimumRemaining: { five_hour: 17, seven_day: 19, scoped: 4 },
      failClosedOnUnknownQuota: false,
      showToasts: true,
    },
    quotaHeaderFeed: { enabled: true },
    killswitch: {
      enabled: true,
      main: { five_hour: 9, seven_day: 11, scoped: 3 },
      accounts: { 'vault:sample': { five_hour: 7, seven_day: 18, scoped: 2 } },
    },
    claudeCache: { ...(!absent && { enabled: true }), mode: 'hybrid' },
    cacheKeep: {
      enabled: true,
      always: true,
      startHour: 5,
      endHour: 9,
      subagents: true,
    },
    dump: { enabled: false },
    prime: { enabled: false },
    claudeFast: { enabled: true },
    costZeroing: { enabled: false },
    logging: { level: 'debug' },
    thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
    turnEndNote: { tools: ['custom'] },
  }
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

export function snapshotReaderOutputs(storage: core.AccountStorage) {
  const main = core.getKillswitchThresholdsForAccount(storage)
  const minimum = core.getQuotaMinimumRemainingThresholds(storage)
  const noteBody = {
    model: snapshotModel.id,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a'.repeat(20000) },
          { type: 'tool_use', id: 'one', name: 'custom', input: {} },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'one', content: 'ok' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  }
  core.applyTurnEndNotes(noteBody, storage.turnEndNote)
  return {
    routing_mode: core.getRoutingMode(storage),
    max_same_account_wait: core.getMaxSameAccountWait(storage),
    fallback_on: [401, 403, 418, 429, 503].map((status) =>
      core.shouldFallbackStatus(status, storage),
    ),
    refresh_enabled: storage.refresh?.enabled !== false,
    refresh_interval_minutes: core.getRefreshIntervalMs(storage),
    refresh_refresh_before_expiry_minutes:
      core.getRefreshBeforeExpiryMs(storage),
    quota_enabled: core.quotaEnabled(storage),
    quota_check_interval_minutes: core.getQuotaCheckIntervalMs(storage),
    quota_refresh_every_n_requests: core.getQuotaRefreshEveryNRequests(storage),
    quota_minimum_remaining_five_hour: minimum.five_hour,
    quota_minimum_remaining_seven_day: minimum.seven_day,
    quota_minimum_remaining_scoped: core.normalizeKillswitchThresholds(
      storage.quota?.minimumRemaining,
    ).scoped,
    quota_fail_closed_on_unknown_quota: core.failClosedOnUnknownQuota(storage),
    quota_show_toasts: storage.quota?.showToasts === true,
    quota_header_feed_enabled: storage.quotaHeaderFeed?.enabled === true,
    killswitch_enabled: core.isKillswitchEnabled(storage),
    killswitch_default_five_hour: main.five_hour,
    killswitch_default_seven_day: main.seven_day,
    killswitch_default_scoped: main.scoped,
    killswitch_account_floors: core.getKillswitchConfig(storage).accounts,
    claude_cache_enabled: core.isCache1hPersistentlyEnabled(storage),
    claude_cache_mode: core.getCache1hPersistentMode(storage),
    cache_keep_enabled: core.isCacheKeepPersistentlyEnabled(storage),
    cache_keep_always: core.isCacheKeepAlways(storage),
    cache_keep_window: core.getCacheKeepWindow(storage),
    cache_keep_subagents: core.isCacheKeepSubagentsEnabled(storage),
    dump_enabled: core.isDumpPersistentlyEnabled(storage),
    prime_enabled: core.isPrimePersistentlyEnabled(storage),
    claude_fast_enabled: core.isFastModePersistentlyEnabled(storage),
    cost_zeroing_enabled: core.isCostZeroingEnabled(storage),
    log_level: core.getPersistedLogLevel(storage),
    thinking_binding_prefix_mismatch_behavior:
      core.getThinkingPrefixMismatchBehavior(storage),
    turn_end_note_tools: noteBody,
  }
}

export function snapshotSharedThreeWayReaders(storage: core.AccountStorage) {
  const quota = { ...snapshotQuota(15), accountIdentity: 'snapshot-account' }
  return {
    isCache1hPersistentlyEnabled: core.isCache1hPersistentlyEnabled(storage),
    isCacheKeepHybridActive: core.isCacheKeepHybridActive(storage),
    quotaEnabled: core.quotaEnabled(storage),
    quotaSnapshotPassesPolicy: core.quotaSnapshotPassesPolicy(quota, storage),
    quotaRefusalTiming: core.quotaRefusalTiming({
      readings: [{ quota, accountIdentity: quota.accountIdentity }],
      storage,
      now: snapshotTime,
    }),
    getQuotaNextRefreshAt: core.getQuotaNextRefreshAt(
      quota,
      storage,
      snapshotTime,
    ),
  }
}
