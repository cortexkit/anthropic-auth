import { isDeepStrictEqual } from 'node:util'
import type { SettingsEdit } from '@cortexkit/common-auth/settings'
import type { SettingsKey } from './settings-definition.ts'

type Settings = Record<string, unknown>

/** Record paths for flat settings. Killswitch thresholds per account are compared as whole entries, not scalar leaves. */
const paths = {
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
  claude_cache_enabled: ['claudeCache', 'enabled'],
  claude_cache_mode: ['claudeCache', 'mode'],
  cache_keep_enabled: ['cacheKeep', 'enabled'],
  cache_keep_always: ['cacheKeep', 'always'],
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
} as const satisfies Partial<Record<SettingsKey, readonly string[]>>

function object(value: unknown): Settings {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Settings)
    : {}
}

function at(settings: Settings, path: readonly string[]): unknown {
  let value: unknown = settings
  for (const key of path) value = object(value)[key]
  return value
}

function flat(settings: Settings): Partial<Record<SettingsKey, unknown>> {
  const values: Partial<Record<SettingsKey, unknown>> = {}
  for (const [key, path] of Object.entries(paths)) {
    values[key as SettingsKey] = at(settings, path)
  }
  for (const key of [
    'claude_cache_enabled',
    'quota_enabled',
    'quota_fail_closed_on_unknown_quota',
  ] as const) {
    if (typeof values[key] === 'boolean')
      values[key] = values[key] ? 'on' : 'off'
  }
  const wait = values.max_same_account_wait
  values.max_same_account_wait =
    wait === '0' || wait === 0
      ? 'off'
      : wait === '15' || wait === 15
        ? '15m'
        : wait === 'max'
          ? 'cache'
          : wait
  for (const [path, prefix, defaults] of [
    [['killswitch', 'main'], 'killswitch_default', [5, 10, 0]],
    [['quota', 'minimumRemaining'], 'quota_minimum_remaining', [0, 0, 0]],
  ] as const) {
    const thresholds = at(settings, path)
    if (thresholds === undefined) continue
    for (const [index, field] of [
      'five_hour',
      'seven_day',
      'scoped',
    ].entries()) {
      const alias =
        field === 'five_hour' ? '5h' : field === 'seven_day' ? '1w' : field
      values[`${prefix}_${field}` as SettingsKey] =
        object(thresholds)[field] ??
        object(thresholds)[alias] ??
        defaults[index]
    }
  }
  const start = at(settings, ['cacheKeep', 'startHour'])
  const end = at(settings, ['cacheKeep', 'endHour'])
  values.cache_keep_window =
    start === undefined && end === undefined
      ? undefined
      : [{ start_hour: start, end_hour: end }]
  return values
}

interface StoreChange {
  path: string[]
  value: unknown
}

function put(settings: Settings, path: readonly string[], value: unknown) {
  const [key, ...rest] = path
  if (key === undefined) return
  if (rest.length) {
    const child = object(settings[key])
    put(child, rest, value)
    if (Object.keys(child).length) settings[key] = child
    else delete settings[key]
  } else if (value === undefined) delete settings[key]
  else settings[key] = structuredClone(value)
}

function storeHeld(settings: Settings) {
  const held = structuredClone(settings)
  for (const path of Object.values(paths)) put(held, path, undefined)
  for (const path of [
    ['cacheKeep', 'startHour'],
    ['cacheKeep', 'endHour'],
    ['killswitch', 'accounts'],
  ])
    put(held, path, undefined)
  return held
}

function changes(
  before: Settings,
  after: Settings,
  path: string[] = [],
): StoreChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(
    (key) => {
      const left = before[key]
      const right = after[key]
      if (isDeepStrictEqual(left, right)) return []
      const child = [...path, key]
      if (
        left &&
        right &&
        typeof left === 'object' &&
        typeof right === 'object' &&
        !Array.isArray(left) &&
        !Array.isArray(right)
      )
        return changes(object(left), object(right), child)
      return [{ path: child, value: right }]
    },
  )
}

/** Plan before committing: callers can add account edits and refusal checks to the same transaction. */
export function planNativeSettingsWrite(before: Settings, after: Settings) {
  const left = flat(before)
  const right = flat(after)
  const edits: SettingsEdit[] = []
  for (const key of Object.keys(left) as SettingsKey[]) {
    if (isDeepStrictEqual(left[key], right[key])) continue
    edits.push(
      right[key] === undefined
        ? { setting: key, remove: true }
        : { setting: key, value: right[key] },
    )
  }
  return { edits, storeChanges: changes(storeHeld(before), storeHeld(after)) }
}

/** Apply only store-held deltas to a fresh legacy record, never the resolved settings projection. */
export function applyNativeStoreSettingsChanges(
  stored: Settings,
  changes: readonly StoreChange[],
) {
  const next = structuredClone(stored)
  for (const change of changes) put(next, change.path, change.value)
  return next
}

/** Old releases only understand booleans in these legacy fields. */
export function legacyNativeSettings(settings: Settings) {
  for (const path of [
    ['claudeCache', 'enabled'],
    ['quota', 'enabled'],
    ['quota', 'failClosedOnUnknownQuota'],
  ]) {
    const value = at(settings, path)
    if (value === 'on' || value === 'off' || value === 'default')
      put(settings, path, value === 'default' ? undefined : value === 'on')
  }
  return settings
}
