import type { AccountStorage } from './accounts.ts'
import { resolveClaudeModelCapabilities } from './model-capabilities.ts'
import type { SettingsKey } from './settings-definition.ts'
import type { SettingsHost } from './settings-paths.ts'
import type { SettingsGeneration } from './settings-service.ts'

/** Presence is captured with the resolved generation, never by reading the file on a request. */
export function settingsFileSets(
  generation: SettingsGeneration,
  key: SettingsKey,
  host: SettingsHost,
  model?: string,
): boolean {
  const levels = generation.fileLevels[key]
  const row = resolveClaudeModelCapabilities(model)
  return Boolean(
    levels?.some(
      (level) => level === 'default' || level === host || level === row?.id,
    ),
  )
}

function section(stored: Record<string, unknown>, key: string) {
  const value = stored[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function resolveSettingsRecord(
  stored: AccountStorage,
  generation: SettingsGeneration | undefined,
  host: SettingsHost,
  model?: string,
): AccountStorage
export function resolveSettingsRecord(
  stored: Record<string, unknown>,
  generation: SettingsGeneration | undefined,
  host: SettingsHost,
  model?: string,
): Record<string, unknown>
/**
 * Overlay only moved settings onto today's record. An absent generation means
 * legacy mode (including a separate install), which must not acquire defaults.
 * Callers retain responsibility for omitting credentials from public snapshots.
 */
export function resolveSettingsRecord(
  stored: Record<string, unknown>,
  generation: SettingsGeneration | undefined,
  host: SettingsHost,
  model?: string,
): Record<string, unknown> {
  if (!generation) return structuredClone(stored)
  const context = generation.contexts[host]
  const row = resolveClaudeModelCapabilities(model)
  const values = {
    ...((row ? context.models[row.id] : undefined) ?? context.noModel),
    ...generation.protection[host].values,
  }
  const window = values.cache_keep_window[0]
  const cacheKeep: NonNullable<AccountStorage['cacheKeep']> = {
    ...section(stored, 'cacheKeep'),
    enabled: values.cache_keep_enabled,
    always: values.cache_keep_always,
    subagents: values.cache_keep_subagents,
  }
  // An empty window clears the legacy hours instead of restoring stale store values.
  delete cacheKeep.startHour
  delete cacheKeep.endHour
  if (window) {
    cacheKeep.startHour = window.start_hour
    cacheKeep.endHour = window.end_hour
  }
  const logging = { ...section(stored, 'logging') }
  // Default logging and account-default thinking leave the existing inference in charge.
  delete logging.level
  if (values.log_level !== 'default') logging.level = values.log_level
  const thinkingBinding = { ...section(stored, 'thinkingBinding') }
  delete thinkingBinding.prefixMismatchBehavior
  if (values.thinking_binding_prefix_mismatch_behavior !== 'account-default')
    thinkingBinding.prefixMismatchBehavior =
      values.thinking_binding_prefix_mismatch_behavior

  const moved = {
    routing: {
      ...section(stored, 'routing'),
      mode: values.routing_mode,
      maxSameAccountWait:
        values.max_same_account_wait === 'off'
          ? '0'
          : values.max_same_account_wait === '15m'
            ? '15'
            : 'max',
    },
    fallbackOn: values.fallback_on,
    refresh: {
      ...section(stored, 'refresh'),
      enabled: values.refresh_enabled,
      intervalMinutes: values.refresh_interval_minutes,
      refreshBeforeExpiryMinutes: values.refresh_refresh_before_expiry_minutes,
    },
    quota: {
      ...section(stored, 'quota'),
      enabled: values.quota_enabled,
      checkIntervalMinutes: values.quota_check_interval_minutes,
      refreshEveryNRequests: values.quota_refresh_every_n_requests,
      minimumRemaining: {
        five_hour: values.quota_minimum_remaining_five_hour,
        seven_day: values.quota_minimum_remaining_seven_day,
        scoped: values.quota_minimum_remaining_scoped,
      },
      failClosedOnUnknownQuota: values.quota_fail_closed_on_unknown_quota,
      showToasts: values.quota_show_toasts,
    },
    quotaHeaderFeed: {
      ...section(stored, 'quotaHeaderFeed'),
      enabled: values.quota_header_feed_enabled,
    },
    killswitch: {
      ...section(stored, 'killswitch'),
      enabled: values.killswitch_enabled,
      main: {
        five_hour: values.killswitch_default_five_hour,
        seven_day: values.killswitch_default_seven_day,
        scoped: values.killswitch_default_scoped,
      },
      accounts: Object.fromEntries(
        values.killswitch_account_floors
          .filter((entry) => entry.host === host || entry.host === 'both')
          .map(({ account, five_hour, seven_day, scoped }) => [
            account,
            { five_hour, seven_day, scoped },
          ]),
      ),
    },
    claudeCache: {
      ...section(stored, 'claudeCache'),
      enabled: values.claude_cache_enabled,
      mode: values.claude_cache_mode,
    },
    cacheKeep,
    dump: { ...section(stored, 'dump'), enabled: values.dump_enabled },
    prime: { ...section(stored, 'prime'), enabled: values.prime_enabled },
    claudeFast: {
      ...section(stored, 'claudeFast'),
      enabled: values.claude_fast_enabled,
    },
    costZeroing: {
      ...section(stored, 'costZeroing'),
      enabled: values.cost_zeroing_enabled,
    },
    logging,
    thinkingBinding,
    turnEndNote: {
      ...section(stored, 'turnEndNote'),
      tools: values.turn_end_note_tools,
    },
  } satisfies Partial<AccountStorage>
  return structuredClone({ ...stored, ...moved })
}
