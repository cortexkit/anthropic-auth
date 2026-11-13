import { resolve } from 'node:path'
import {
  boolean,
  defineSettings,
  integer,
  list,
  number,
  object,
  oneOf,
  type SettingsRefusalCode,
  string,
} from '@cortexkit/common-auth/settings'
import { CACHE_1H_MODES } from './constants.ts'

const user = { hosts: 'both', project: 'user-only' } as const
const host = { ...user, overrides: { host: true } } as const
const model = { ...user, overrides: { host: true, model: true } } as const
const floor = number({ min: 0, max: 100 })
const nonnegative = number({ min: 0 })

/** Scalar ranges follow validateNativeMigrationSettings; list entries replace whole values. */
export const settingsDefinition = defineSettings({
  plugin: 'anthropic-auth',
  settings: {
    routing_mode: {
      ...host,
      value: oneOf(['main-first', 'fallback-first', 'sticky-balanced']),
      default: 'main-first',
    },
    max_same_account_wait: {
      ...host,
      value: oneOf(['off', '15m', 'cache']),
      default: '15m',
    },
    fallback_on: { ...host, value: list(integer()), default: [401, 403, 429] },
    refresh_enabled: { ...host, value: boolean(), default: true },
    refresh_interval_minutes: { ...host, value: nonnegative, default: 10 },
    refresh_refresh_before_expiry_minutes: {
      ...host,
      value: nonnegative,
      default: 240,
    },
    quota_enabled: {
      ...host,
      value: oneOf(['default', 'on', 'off']),
      default: 'default',
    },
    quota_check_interval_minutes: { ...host, value: nonnegative, default: 5 },
    quota_refresh_every_n_requests: { ...host, value: nonnegative, default: 0 },
    quota_minimum_remaining_five_hour: { ...host, value: floor, default: 0 },
    quota_minimum_remaining_seven_day: { ...host, value: floor, default: 0 },
    quota_minimum_remaining_scoped: { ...host, value: floor, default: 0 },
    quota_fail_closed_on_unknown_quota: {
      ...host,
      value: oneOf(['default', 'on', 'off']),
      default: 'default',
    },
    quota_show_toasts: { ...host, value: boolean(), default: false },
    quota_header_feed_enabled: { ...host, value: boolean(), default: false },
    killswitch_enabled: { ...host, value: boolean(), default: false },
    killswitch_default_five_hour: { ...host, value: floor, default: 5 },
    killswitch_default_seven_day: { ...host, value: floor, default: 10 },
    killswitch_default_scoped: { ...host, value: floor, default: 0 },
    killswitch_account_floors: {
      ...user,
      value: list(
        object({
          account: string(),
          host: oneOf(['opencode', 'pi', 'both']),
          five_hour: floor,
          seven_day: floor,
          scoped: floor,
        }),
      ),
      default: [],
    },
    claude_cache_enabled: {
      ...model,
      value: oneOf(['default', 'on', 'off']),
      default: 'default',
    },
    claude_cache_mode: {
      ...model,
      value: oneOf(CACHE_1H_MODES),
      default: 'explicit',
    },
    cache_keep_enabled: { ...model, value: boolean(), default: false },
    cache_keep_always: { ...host, value: boolean(), default: false },
    cache_keep_window: {
      ...host,
      value: list(object({ start_hour: nonnegative, end_hour: nonnegative })),
      default: [],
    },
    cache_keep_subagents: { ...host, value: boolean(), default: false },
    dump_enabled: { ...host, value: boolean(), default: false },
    prime_enabled: { ...host, value: boolean(), default: false },
    claude_fast_enabled: { ...model, value: boolean(), default: false },
    cost_zeroing_enabled: { ...host, value: boolean(), default: true },
    log_level: {
      ...host,
      value: oneOf(['default', 'debug', 'info', 'warn', 'error', 'trace']),
      default: 'default',
    },
    thinking_binding_prefix_mismatch_behavior: {
      ...model,
      value: oneOf(['account-default', 'error', 'drop_block']),
      default: 'account-default',
    },
    turn_end_note_tools: {
      ...host,
      value: list(string()),
      default: ['board', 'ctx_reduce'],
    },
  },
})

export type SettingsKey = keyof typeof settingsDefinition.settings

/** Empty: no Pi-specific default is needed beyond per-reader default/on/off handling. */
export const SETTINGS_PI_DIFFERING_FIELDS =
  [] as const satisfies readonly SettingsKey[]

/** Names the current readers whose absence behavior determines each schema default. */
export const SETTINGS_DEFAULT_READERS = {
  routing_mode: 'packages/core/src/routing.ts:getRoutingMode',
  max_same_account_wait: 'packages/core/src/routing.ts:getMaxSameAccountWait',
  fallback_on: 'packages/core/src/accounts.ts:shouldFallbackStatus',
  refresh_enabled: 'packages/opencode/src/index.ts:mainRefreshEnabled',
  refresh_interval_minutes:
    'packages/core/src/accounts.ts:getRefreshIntervalMs',
  refresh_refresh_before_expiry_minutes:
    'packages/core/src/accounts.ts:getRefreshBeforeExpiryMs',
  quota_enabled: 'packages/core/src/accounts.ts:quotaEnabled',
  quota_check_interval_minutes:
    'packages/core/src/accounts.ts:getQuotaCheckIntervalMs',
  quota_refresh_every_n_requests:
    'packages/core/src/accounts.ts:getQuotaRefreshEveryNRequests',
  quota_minimum_remaining_five_hour:
    'packages/core/src/accounts.ts:getQuotaMinimumRemainingThresholds',
  quota_minimum_remaining_seven_day:
    'packages/core/src/accounts.ts:getQuotaMinimumRemainingThresholds',
  // No quota policy reads scoped. The shared floor normalizer supplies its zero.
  quota_minimum_remaining_scoped:
    'packages/core/src/accounts.ts:normalizeKillswitchThresholds',
  quota_fail_closed_on_unknown_quota:
    'packages/core/src/accounts.ts:failClosedOnUnknownQuota',
  quota_show_toasts: 'packages/opencode/src/index.ts:showQuotaToastFromCache',
  quota_header_feed_enabled:
    'packages/opencode/src/index.ts:AnthropicAuthPlugin quotaHeaderFeedRegistry',
  killswitch_enabled: 'packages/core/src/accounts.ts:isKillswitchEnabled',
  killswitch_default_five_hour:
    'packages/core/src/accounts.ts:getKillswitchThresholdsForAccount',
  killswitch_default_seven_day:
    'packages/core/src/accounts.ts:getKillswitchThresholdsForAccount',
  killswitch_default_scoped:
    'packages/core/src/accounts.ts:getKillswitchThresholdsForAccount',
  killswitch_account_floors:
    'packages/core/src/accounts.ts:getKillswitchConfig',
  claude_cache_enabled:
    'packages/core/src/accounts.ts:isCache1hPersistentlyEnabled',
  claude_cache_mode: 'packages/core/src/accounts.ts:getCache1hPersistentMode',
  cache_keep_enabled:
    'packages/core/src/cachekeep.ts:isCacheKeepPersistentlyEnabled',
  cache_keep_always: 'packages/core/src/cachekeep.ts:isCacheKeepAlways',
  cache_keep_window: 'packages/core/src/cachekeep.ts:getCacheKeepWindow',
  cache_keep_subagents:
    'packages/core/src/accounts.ts:isCacheKeepSubagentsEnabled',
  dump_enabled: 'packages/core/src/accounts.ts:isDumpPersistentlyEnabled',
  prime_enabled: 'packages/core/src/accounts.ts:isPrimePersistentlyEnabled',
  claude_fast_enabled:
    'packages/core/src/accounts.ts:isFastModePersistentlyEnabled',
  cost_zeroing_enabled: 'packages/core/src/accounts.ts:isCostZeroingEnabled',
  log_level: 'packages/core/src/accounts.ts:getPersistedLogLevel',
  thinking_binding_prefix_mismatch_behavior:
    'packages/core/src/thinking-binding.ts:getThinkingPrefixMismatchBehavior',
  turn_end_note_tools: 'packages/core/src/turn-end-note.ts:applyTurnEndNotes',
} as const satisfies Record<SettingsKey, string>

/** These enum members defer to the existing environment/account inference. */
export const SETTINGS_INFERRED_FIELDS = [
  'log_level',
  'thinking_binding_prefix_mismatch_behavior',
] as const satisfies readonly SettingsKey[]

export const SETTINGS_INFER_MEMBERS = {
  log_level: 'default',
  thinking_binding_prefix_mismatch_behavior: 'account-default',
} as const satisfies Record<(typeof SETTINGS_INFERRED_FIELDS)[number], string>

/** Direct reads and host entry points that delegate to the shared readers. */
export const SETTINGS_THREE_WAY_READERS = {
  claude_cache_enabled: [
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'isCache1hPersistentlyEnabled',
      absent: false,
    },
    {
      path: 'packages/core/src/cachekeep.ts',
      reader: 'isCacheKeepHybridActive',
      absent: false,
    },
    {
      path: 'packages/opencode/src/index.ts',
      reader:
        'AnthropicAuthPlugin (persistent cache latch via isCache1hPersistentlyEnabled)',
      absent: false,
    },
    {
      path: 'packages/opencode/src/v2/wire.ts',
      reader: 'createNativeWirePolicy transformOptions',
      absent: true,
    },
    {
      path: 'packages/pi/src/stream.ts',
      reader: 'sendAnthropicRequest (via isCache1hPersistentlyEnabled)',
      absent: false,
    },
    {
      path: 'packages/pi/src/native-commands.ts',
      reader:
        'createPiNativeCommands status cache (via isCache1hPersistentlyEnabled)',
      absent: false,
    },
  ],
  quota_enabled: [
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'quotaEnabled',
      absent: true,
    },
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'quotaSnapshotPassesPolicy (via quotaEnabled)',
      absent: true,
    },
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'quotaRefusalTiming (via quotaEnabled)',
      absent: true,
    },
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'getQuotaNextRefreshAt (via quotaEnabled)',
      absent: true,
    },
    {
      path: 'packages/opencode/src/index.ts',
      reader: 'mainProviderQuotaRestriction',
      absent: true,
    },
    {
      path: 'packages/opencode/src/index.ts',
      reader: 'pollFallbackQuotas',
      absent: true,
    },
    {
      path: 'packages/opencode/src/index.ts',
      reader: 'scheduleSidebarMainQuotaRefresh',
      absent: false,
    },
    {
      path: 'packages/opencode/src/index.ts',
      reader: 'mainQuotaRoutingEnabled',
      absent: false,
    },
    {
      path: 'packages/opencode/src/v2/source.ts',
      reader: 'createNativeAnthropicSource chooseAccount',
      absent: true,
    },
    {
      path: 'packages/opencode/src/v2/lifecycle.ts',
      reader: 'startNativeAnthropicLifecycle run',
      absent: true,
    },
    {
      path: 'packages/pi/src/native.ts',
      reader: 'requestPolicy (via quotaSnapshotPassesPolicy)',
      absent: true,
    },
    {
      path: 'packages/pi/src/stream.ts',
      reader:
        'getPiRoutingServices getUsableFallbackAccounts (via quotaSnapshotPassesPolicy)',
      absent: true,
    },
  ],
  quota_fail_closed_on_unknown_quota: [
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'failClosedOnUnknownQuota',
      absent: true,
    },
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'quotaSnapshotPassesPolicy (via failClosedOnUnknownQuota)',
      absent: true,
    },
    {
      path: 'packages/core/src/accounts.ts',
      reader: 'killswitchPassesPolicy (via failClosedOnUnknownQuota)',
      absent: true,
    },
    {
      path: 'packages/opencode/src/index.ts',
      reader: 'getRoutableFallbackAccounts',
      absent: false,
    },
    {
      path: 'packages/opencode/src/index.ts',
      reader:
        'AnthropicAuthPlugin authTransport.fetch main quota backoff check',
      absent: false,
    },
  ],
} as const

export function malformedSettingsText(file: string): string {
  return `Cannot write settings to "${resolve(file)}": the settings file is malformed or contains duplicate keys. Edit the file to fix it before trying again.`
}

export function refusedSettingsWriteText(
  key: SettingsKey,
  file: string,
): string {
  return `Cannot remove setting "${key}" from "${resolve(file)}": a lower level would still supply a value. Edit the settings file to set the value you want.`
}

export function refusedSettingsRecreationText(file: string): string {
  return `Cannot recreate settings file "${resolve(file)}": protection settings are unknown. Edit the settings file to set them before trying again.`
}

/** Only fixed, local text is shown; dependency errors can contain file contents. */
export const SETTINGS_WRITE_FAILURES = {
  'settings-unparseable': {
    outcome: 'refused',
    text: malformedSettingsText,
  },
  'settings-newer-version': {
    outcome: 'refused',
    text: (file: string) =>
      `Cannot write settings to "${resolve(file)}": the file uses a newer settings version. Update the plugin or edit the settings file before trying again.`,
  },
  'settings-invalid-value': {
    outcome: 'refused',
    text: (file: string) =>
      `Cannot write settings to "${resolve(file)}": the requested setting value is invalid. Edit the settings file to set a valid value.`,
  },
  'settings-busy': {
    outcome: 'failed',
    text: (file: string) =>
      `Could not write settings to "${resolve(file)}": the settings file is busy. Try again after the other settings write finishes.`,
  },
  'settings-unavailable': {
    outcome: 'failed',
    text: (file: string) =>
      `Could not write settings to "${resolve(file)}": the settings file is unavailable. Check its folder and permissions before trying again.`,
  },
} as const satisfies Record<
  SettingsRefusalCode,
  { outcome: 'refused' | 'failed'; text: (file: string) => string }
>
