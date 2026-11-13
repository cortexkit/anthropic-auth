import type { MoveSource } from '@cortexkit/common-auth/settings'
import { logger } from './logger.ts'
import { validateNativeMigrationSettings } from './native-migration-source.ts'
import { type SettingsKey, settingsDefinition } from './settings-definition.ts'
import type { SettingsHost } from './settings-paths.ts'
import {
  mostRestrictiveSettingsProtection,
  type SettingsValues,
} from './settings-service.ts'

/** Legacy paths by schema key; cache_keep_window combines the two named sibling hours. */
export const SETTINGS_MOVE_PATHS = {
  routing_mode: ['routing', 'mode'],
  max_same_account_wait: ['routing', 'maxSameAccountWait'],
  fallback_on: ['fallbackOn'],
  refresh_enabled: ['refresh', 'enabled'],
  refresh_interval_minutes: ['refresh', 'intervalMinutes'],
  refresh_refresh_before_expiry_minutes: [
    'refresh',
    'refreshBeforeExpiryMinutes',
  ],
  quota_enabled: ['quota', 'enabled'],
  quota_check_interval_minutes: ['quota', 'checkIntervalMinutes'],
  quota_refresh_every_n_requests: ['quota', 'refreshEveryNRequests'],
  quota_minimum_remaining_five_hour: ['quota', 'minimumRemaining', 'five_hour'],
  quota_minimum_remaining_seven_day: ['quota', 'minimumRemaining', 'seven_day'],
  quota_minimum_remaining_scoped: ['quota', 'minimumRemaining', 'scoped'],
  quota_fail_closed_on_unknown_quota: ['quota', 'failClosedOnUnknownQuota'],
  quota_show_toasts: ['quota', 'showToasts'],
  quota_header_feed_enabled: ['quotaHeaderFeed', 'enabled'],
  killswitch_enabled: ['killswitch', 'enabled'],
  killswitch_default_five_hour: ['killswitch', 'main', 'five_hour'],
  killswitch_default_seven_day: ['killswitch', 'main', 'seven_day'],
  killswitch_default_scoped: ['killswitch', 'main', 'scoped'],
  killswitch_account_floors: ['killswitch', 'accounts'],
  claude_cache_enabled: ['claudeCache', 'enabled'],
  claude_cache_mode: ['claudeCache', 'mode'],
  cache_keep_enabled: ['cacheKeep', 'enabled'],
  cache_keep_always: ['cacheKeep', 'always'],
  cache_keep_window: ['cacheKeep', 'startHour', 'endHour'],
  cache_keep_subagents: ['cacheKeep', 'subagents'],
  dump_enabled: ['dump', 'enabled'],
  prime_enabled: ['prime', 'enabled'],
  claude_fast_enabled: ['claudeFast', 'enabled'],
  cost_zeroing_enabled: ['costZeroing', 'enabled'],
  log_level: ['logging', 'level'],
  thinking_binding_prefix_mismatch_behavior: [
    'thinkingBinding',
    'prefixMismatchBehavior',
  ],
  turn_end_note_tools: ['turnEndNote', 'tools'],
} as const satisfies Record<SettingsKey, readonly string[]>

export interface SettingsMoveSourceOptions {
  host: SettingsHost
  path: string
  log?: { warn: (message: string) => void }
  /** Read-only authority comparisons must not consume the move's diagnostics. */
  quiet?: boolean
}

const logged = new Set<string>()
const fields = ['five_hour', 'seven_day', 'scoped'] as const
const aliases = { five_hour: '5h', seven_day: '1w', scoped: 'scoped' } as const
type Floors = Record<(typeof fields)[number], number>
const invalidSection = Symbol('invalid legacy section')

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function floor(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  )
}

// A malformed section explicitly holds an invalid value, rather than making its
// protection leaves look absent and silently giving them ordinary defaults.
function held(
  root: unknown,
  path: readonly string[],
): { value: unknown } | undefined {
  let value = root
  for (const key of path) {
    if (!record(value)) return { value: invalidSection }
    if (!Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return { value }
}

/** Parse legacy JSON, validating each moved field independently under the mover's locks. */
export function readSettingsMoveSource(
  text: string,
  options: SettingsMoveSourceOptions,
): Partial<SettingsValues> {
  // Syntax errors make the source unreadable and must abort the whole move.
  const stored: unknown = JSON.parse(text)
  const values: Partial<Record<SettingsKey, unknown>> = {}
  const restrictive = mostRestrictiveSettingsProtection()
  function report(path: string, reason: string) {
    if (options.quiet) return
    const message = `Settings move from ${options.path}: ${path} ${reason}.`
    if (logged.has(message)) return
    logged.add(message)
    if (options.log) options.log.warn(message)
    else logger.warn('settings', message)
  }
  if (!record(stored)) {
    report('<root>', 'is not a settings map; omitted')
    return {}
  }
  function invalid(key: SettingsKey, path: string) {
    if (Object.hasOwn(restrictive, key)) {
      const replacement = restrictive[key as keyof typeof restrictive]
      values[key] = replacement
      report(
        path,
        `is invalid; replaced with protection value ${JSON.stringify(replacement)}`,
      )
    } else report(path, 'is invalid; omitted')
  }
  for (const [key, path] of Object.entries(SETTINGS_MOVE_PATHS) as [
    SettingsKey,
    readonly string[],
  ][]) {
    if (
      key.startsWith('killswitch_default_') ||
      key.startsWith('quota_minimum_remaining_') ||
      key === 'killswitch_account_floors' ||
      key === 'cache_keep_window'
    )
      continue
    const entry = held(stored, path)
    if (!entry) continue
    const value = entry.value
    let valid = true
    try {
      if (key === 'fallback_on') {
        valid =
          Array.isArray(value) &&
          value.every((status) => Number.isInteger(status))
      } else if (
        key === 'max_same_account_wait' &&
        (value === 0 || value === 15)
      ) {
        // Accept the numeric spellings as well as the legacy string enum.
      } else if (key === 'log_level' && value === 'default') {
        // The settings file has an explicit spelling for legacy level inference.
      } else {
        validateNativeMigrationSettings({
          [path[0] as string]: { [path[1] as string]: value },
        })
      }
    } catch {
      valid = false
    }
    if (!valid) {
      invalid(key, path.join('.'))
      continue
    }
    values[key] =
      key === 'max_same_account_wait'
        ? value === '0' || value === 0
          ? 'off'
          : value === '15' || value === 15
            ? '15m'
            : 'cache'
        : [
              'claude_cache_enabled',
              'quota_enabled',
              'quota_fail_closed_on_unknown_quota',
            ].includes(key)
          ? value
            ? 'on'
            : 'off'
          : value
  }

  function thresholds(
    value: unknown,
    path: string,
    defaults: Floors,
    account = false,
  ): Floors | undefined {
    if (!record(value)) {
      if (account) return undefined
      report(path, 'is invalid; replaced with declared protection floors')
      return { ...defaults }
    }
    if (
      fields.some(
        (key) =>
          key !== aliases[key] &&
          Object.hasOwn(value, key) &&
          Object.hasOwn(value, aliases[key]),
      )
    )
      report(
        path,
        'holds threshold aliases beside canonical keys; canonical keys win',
      )
    const result = { ...defaults }
    let bad = false
    for (const key of Object.keys(value)) {
      if (!['five_hour', 'seven_day', 'scoped', '5h', '1w'].includes(key)) {
        if (!account) report(`${path}.${key}`, 'is unknown; omitted')
        bad = true
      }
    }
    for (const key of fields) {
      const source = Object.hasOwn(value, key) ? key : aliases[key]
      if (!Object.hasOwn(value, source)) continue
      const amount = value[source]
      if (floor(amount)) result[key] = amount
      else {
        bad = true
        if (!account)
          report(
            `${path}.${source}`,
            `is invalid; replaced with protection value ${defaults[key]}`,
          )
      }
    }
    return account && bad ? undefined : result
  }
  for (const [path, prefix] of [
    [['killswitch', 'main'], 'killswitch_default'],
    [['quota', 'minimumRemaining'], 'quota_minimum_remaining'],
  ] as const) {
    const entry = held(stored, path)
    if (!entry) continue
    const defaults = Object.fromEntries(
      fields.map((key) => [
        key,
        settingsDefinition.settings[`${prefix}_${key}`].default,
      ]),
    ) as Floors
    const result = thresholds(entry.value, path.join('.'), defaults) as Floors
    for (const key of fields) values[`${prefix}_${key}`] = result[key]
  }

  const accounts = held(stored, ['killswitch', 'accounts'])
  if (accounts) {
    const defaults: Floors = {
      five_hour:
        settingsDefinition.settings.killswitch_default_five_hour.default,
      seven_day:
        settingsDefinition.settings.killswitch_default_seven_day.default,
      scoped: settingsDefinition.settings.killswitch_default_scoped.default,
    }
    values.killswitch_account_floors = []
    if (!record(accounts.value))
      invalid('killswitch_account_floors', 'killswitch.accounts')
    else {
      const replacement = Object.fromEntries(
        fields.map((key) => [
          key,
          Math.max(
            defaults[key],
            (values[`killswitch_default_${key}`] as number | undefined) ??
              defaults[key],
          ),
        ]),
      ) as Floors
      values.killswitch_account_floors = Object.entries(accounts.value).map(
        ([account, value]) => {
          const path = `killswitch.accounts.${account}`
          const result = thresholds(value, path, defaults, true)
          if (!result)
            report(
              path,
              `is invalid; replaced with protection floors ${JSON.stringify(replacement)}`,
            )
          return { account, host: options.host, ...(result ?? replacement) }
        },
      )
    }
  }

  const start = held(stored, ['cacheKeep', 'startHour'])
  const end = held(stored, ['cacheKeep', 'endHour'])
  if (start || end) {
    const validHour = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
    if (validHour(start?.value) && validHour(end?.value))
      values.cache_keep_window = [
        { start_hour: start.value, end_hour: end.value },
      ]
    else invalid('cache_keep_window', 'cacheKeep.startHour/endHour')
  }
  return values as Partial<SettingsValues>
}

/** The common-auth mover supplies the bytes and keeps the source locks held. */
export function createSettingsMoveSource(
  options: SettingsMoveSourceOptions & Pick<MoveSource, 'locks'>,
): MoveSource {
  return {
    host: options.host,
    path: options.path,
    locks: options.locks,
    read: (text) => readSettingsMoveSource(text, options),
  }
}
