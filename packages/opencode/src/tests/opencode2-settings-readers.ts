import { expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import * as core from '@cortexkit/anthropic-auth-core'
import { createNativeWirePolicy } from '../v2/wire'

const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')

// These OpenCode 1 predicates are private. Execute their source as the schema
// default tests do, rather than comparing two copies of a settings converter.
export function predicate(pattern: RegExp, storage: core.AccountStorage) {
  const expression = source.match(pattern)?.[1]
  expect(expression).toBeDefined()
  return new Function(
    'storage',
    'readThreeWayBoolean',
    `return (${expression?.replaceAll('initialStorage', 'storage').replaceAll('snapshot.policyStorage', 'storage')})`,
  )(storage, core.readThreeWayBoolean)
}

export function settingsReaderOutputs(
  s: core.AccountStorage,
  inventory = true,
) {
  const tools: string[] = []
  core.applyTurnEndNotes(
    { model: 'claude-opus-5-5', messages: [] },
    {
      tools: s.turnEndNote?.tools,
      mapToolName: (name) => {
        tools.push(name)
        return name
      },
    },
  )
  const outputs = {
    routing_mode: core.getRoutingMode(s),
    max_same_account_wait: core.getMaxSameAccountWait(s),
    fallback_on: Array.from({ length: 500 }, (_, i) => i + 100).filter(
      (status) => core.shouldFallbackStatus(status, s),
    ),
    refresh_enabled: predicate(
      /function mainRefreshEnabled\([\s\S]*?return ([^\n]+)/,
      s,
    ),
    refresh_interval_minutes: core.getRefreshIntervalMs(s),
    refresh_refresh_before_expiry_minutes: core.getRefreshBeforeExpiryMs(s),
    quota_enabled: core.quotaSnapshotPassesPolicy(undefined, {
      ...s,
      quota: { ...s.quota, failClosedOnUnknownQuota: true },
      killswitch: { enabled: false },
    }),
    quota_check_interval_minutes: core.getQuotaCheckIntervalMs(s),
    quota_refresh_every_n_requests: core.getQuotaRefreshEveryNRequests(s),
    quota_minimum_remaining_five_hour:
      core.getQuotaMinimumRemainingThresholds(s).five_hour,
    quota_minimum_remaining_seven_day:
      core.getQuotaMinimumRemainingThresholds(s).seven_day,
    quota_minimum_remaining_scoped: core.normalizeKillswitchThresholds(
      s.quota?.minimumRemaining,
    ).scoped,
    quota_fail_closed_on_unknown_quota: core.quotaSnapshotPassesPolicy(
      undefined,
      {
        ...s,
        quota: { ...s.quota, enabled: true },
        killswitch: { enabled: false },
      },
    ),
    quota_show_toasts: !predicate(
      /function showQuotaToastFromCache\(\) \{\s*if \(([^\n]+)\) return/,
      s,
    ),
    quota_header_feed_enabled: predicate(
      /const quotaHeaderFeedRegistry =\s*(initialStorage[\s\S]*?)\s*\? new QuotaHeaderFeedRegistry/,
      s,
    ),
    killswitch_enabled: core.isKillswitchEnabled(s),
    killswitch_default_five_hour:
      core.getKillswitchThresholdsForAccount(s).five_hour,
    killswitch_default_seven_day:
      core.getKillswitchThresholdsForAccount(s).seven_day,
    killswitch_default_scoped: core.getKillswitchThresholdsForAccount(s).scoped,
    killswitch_account_floors: Object.entries(
      core.getKillswitchConfig(s).accounts ?? {},
    ),
    claude_cache_enabled: core.isCache1hPersistentlyEnabled(s),
    claude_cache_mode: core.getCache1hPersistentMode(s),
    cache_keep_enabled: core.isCacheKeepPersistentlyEnabled(s),
    cache_keep_always: core.isCacheKeepAlways(s),
    cache_keep_window: core.getCacheKeepWindow(s),
    cache_keep_subagents: core.isCacheKeepSubagentsEnabled(s),
    dump_enabled: core.isDumpPersistentlyEnabled(s),
    prime_enabled: core.isPrimePersistentlyEnabled(s),
    claude_fast_enabled: core.isFastModePersistentlyEnabled(s),
    cost_zeroing_enabled: core.isCostZeroingEnabled(s),
    log_level: core.getPersistedLogLevel(s),
    thinking_binding_prefix_mismatch_behavior:
      core.getThinkingPrefixMismatchBehavior(s),
    turn_end_note_tools: tools,
  } satisfies Record<core.SettingsKey, unknown>
  if (inventory)
    expect(Object.keys(outputs).sort()).toEqual(
      Object.keys(core.SETTINGS_DEFAULT_READERS).sort(),
    )
  const wire = createNativeWirePolicy().requestOptions(
    {
      attemptId: 'parity',
      sessionID: 'parity',
      agent: 'build',
      correlation: {},
    } as Parameters<
      ReturnType<typeof createNativeWirePolicy>['requestOptions']
    >[0],
    {
      policyStorage: s,
    } as core.NativeAccountSnapshot,
  )
  // turnEndNote is a settings record passed through to the transformer. Its
  // effective tool list is compared above, not its optional record shape.
  const { turnEndNote: _turnEndNote, ...wireValues } = wire
  return JSON.stringify({ outputs, wire: wireValues })
}

export function nondefaultSettings(account: string) {
  return {
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
      accounts: { [account]: { five_hour: 31, seven_day: 32, scoped: 33 } },
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
  } satisfies Partial<core.AccountStorage>
}
