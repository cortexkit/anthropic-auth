import {
  isQuotaMap,
  type QuotaCodec,
  type QuotaMap,
  type QuotaReadingEntry,
} from '@cortexkit/common-auth/quota'

import {
  mergeHeaderQuotaForPersistence,
  type OAuthExtraUsageSnapshot,
  type OAuthQuotaSnapshot,
  QUOTA_FIELD_NAMES,
  type QuotaFieldSources,
  type QuotaMoney,
  quotaSnapshotCheckedAt,
} from './accounts.ts'

type ScopedMetadata = {
  id: string
  title: string
  modelId?: string
  modelName: string
  remainingPercent: number
}

/** Snapshot checkedAt, remaining percentages, scoped labels/ownership, account/source provenance and monetary extra usage absent from QuotaMap. */
export type NativeQuotaMetadata = Omit<
  OAuthQuotaSnapshot,
  'five_hour' | 'seven_day' | 'scoped'
> & {
  version: 1
  remainingPercent: { five_hour?: number; seven_day?: number }
  scoped?: ScopedMetadata[]
}

export interface NativeQuotaMap extends QuotaMap {
  anthropic: NativeQuotaMetadata
}

export class NativeQuotaCodecError extends Error {
  constructor() {
    super('Anthropic quota observation is invalid')
    this.name = 'NativeQuotaCodecError'
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  )
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function time(value: unknown): value is number {
  return finite(value) && value >= 0
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function optional(
  value: Record<string, unknown>,
  key: string,
  validate: (value: unknown) => boolean,
): boolean {
  return value[key] === undefined || validate(value[key])
}

function source(value: unknown): boolean {
  return value === 'poll' || value === 'headers'
}

function money(value: unknown): value is QuotaMoney {
  return (
    record(value) &&
    keys(value, ['amountMinor', 'currency', 'exponent']) &&
    finite(value.amountMinor) &&
    text(value.currency) &&
    /^[A-Za-z]{3}$/.test(value.currency) &&
    finite(value.exponent) &&
    Number.isInteger(value.exponent) &&
    value.exponent >= 0 &&
    value.exponent <= 20
  )
}

function extraUsage(value: unknown): value is OAuthExtraUsageSnapshot {
  return (
    record(value) &&
    keys(
      value,
      ['used', 'limit', 'exhausted'],
      ['utilizationPercent', 'severity'],
    ) &&
    money(value.used) &&
    money(value.limit) &&
    typeof value.exhausted === 'boolean' &&
    optional(value, 'utilizationPercent', finite) &&
    optional(value, 'severity', (entry) => typeof entry === 'string')
  )
}

function fieldSources(value: unknown): value is QuotaFieldSources {
  return (
    record(value) &&
    keys(value, [], QUOTA_FIELD_NAMES) &&
    Object.values(value).every(source)
  )
}

const metadataKeys: readonly string[] = [
  'checkedAt',
  'accountIdentity',
  'extraUsage',
  'bindingWindow',
  'bindingWindowSource',
  'fieldSources',
  'fallbackAdvised',
  'source',
]

function metadataFields(value: Record<string, unknown>): boolean {
  return (
    optional(value, 'checkedAt', time) &&
    optional(value, 'accountIdentity', text) &&
    optional(value, 'extraUsage', extraUsage) &&
    optional(value, 'bindingWindow', text) &&
    optional(value, 'bindingWindowSource', source) &&
    optional(value, 'fieldSources', fieldSources) &&
    optional(value, 'fallbackAdvised', (entry) => typeof entry === 'boolean') &&
    optional(value, 'source', source)
  )
}

function window(value: unknown, scoped: boolean): boolean {
  if (
    !record(value) ||
    !keys(
      value,
      scoped
        ? [
            'usedPercent',
            'remainingPercent',
            'checkedAt',
            'id',
            'title',
            'modelName',
          ]
        : ['usedPercent', 'remainingPercent', 'checkedAt'],
      scoped ? ['resetsAt', 'modelId'] : ['resetsAt'],
    )
  )
    return false
  return (
    finite(value.usedPercent) &&
    finite(value.remainingPercent) &&
    time(value.checkedAt) &&
    optional(value, 'resetsAt', (entry) => typeof entry === 'string') &&
    (!scoped ||
      (text(value.id) &&
        text(value.title) &&
        text(value.modelName) &&
        optional(value, 'modelId', text)))
  )
}

export function isNativeOAuthQuotaSnapshot(
  value: unknown,
): value is OAuthQuotaSnapshot {
  return (
    record(value) &&
    keys(value, [], ['five_hour', 'seven_day', 'scoped', ...metadataKeys]) &&
    metadataFields(value) &&
    optional(value, 'five_hour', (entry) => window(entry, false)) &&
    optional(value, 'seven_day', (entry) => window(entry, false)) &&
    optional(
      value,
      'scoped',
      (entry) =>
        Array.isArray(entry) &&
        entry.every((item) => window(item, true)) &&
        new Set(entry.map((item) => item.id)).size === entry.length,
    )
  )
}

function scopedMetadata(value: unknown): value is ScopedMetadata {
  return (
    record(value) &&
    keys(
      value,
      ['id', 'title', 'modelName', 'remainingPercent'],
      ['modelId'],
    ) &&
    text(value.id) &&
    text(value.title) &&
    text(value.modelName) &&
    optional(value, 'modelId', text) &&
    finite(value.remainingPercent)
  )
}

function nativeMetadata(value: unknown): value is NativeQuotaMetadata {
  return (
    record(value) &&
    keys(value, ['version', 'remainingPercent'], ['scoped', ...metadataKeys]) &&
    value.version === 1 &&
    metadataFields(value) &&
    record(value.remainingPercent) &&
    keys(value.remainingPercent, [], ['five_hour', 'seven_day']) &&
    Object.values(value.remainingPercent).every(finite) &&
    optional(
      value,
      'scoped',
      (entry) => Array.isArray(entry) && entry.every(scopedMetadata),
    )
  )
}

export function nativeQuotaModelScope(model: string): string {
  const normalized = model.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalized.includes('fable')) return 'fable'
  if (normalized.includes('mythos')) return 'mythos'
  return `model:${normalized}`
}

function scopedPair(entry: ScopedMetadata): { scope: string; label: string } {
  const family = nativeQuotaModelScope(
    [entry.modelId, entry.modelName, entry.title].join(' '),
  )
  return {
    scope:
      family === 'fable' || family === 'mythos'
        ? family
        : nativeQuotaModelScope(entry.modelId ?? entry.modelName),
    label: `seven_day:${entry.id}`,
  }
}

/** Conversion is arithmetic-free: preserve independent clocks and raw percentages. */
export function toNativeQuotaMap(snapshot: OAuthQuotaSnapshot): NativeQuotaMap {
  if (!isNativeOAuthQuotaSnapshot(snapshot)) throw new NativeQuotaCodecError()
  const json: unknown = JSON.parse(JSON.stringify(snapshot))
  if (!isNativeOAuthQuotaSnapshot(json)) throw new NativeQuotaCodecError()
  const { five_hour, seven_day, scoped, ...metadata } = json
  const limits: QuotaReadingEntry[] = []
  const remainingPercent: NativeQuotaMetadata['remainingPercent'] = {}
  if (five_hour) {
    const { remainingPercent: remaining, ...reading } = five_hour
    remainingPercent.five_hour = remaining
    limits.push({
      scope: 'all',
      label: 'five_hour',
      kind: 'reading',
      ...reading,
    })
  }
  if (seven_day) {
    const { remainingPercent: remaining, ...reading } = seven_day
    remainingPercent.seven_day = remaining
    limits.push({
      scope: 'all',
      label: 'seven_day',
      kind: 'reading',
      ...reading,
    })
  }
  const scopedMetadataEntries = scoped?.map((entry) => {
    const { usedPercent, checkedAt, resetsAt, ...metadata } = entry
    limits.push({
      ...scopedPair(metadata),
      kind: 'reading',
      usedPercent,
      checkedAt,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    })
    return metadata
  })
  const result: NativeQuotaMap = {
    limits,
    anthropic: {
      version: 1,
      remainingPercent,
      ...metadata,
      ...(scopedMetadataEntries !== undefined
        ? { scoped: scopedMetadataEntries }
        : {}),
    },
  }
  // Extra usage has no independent clock in OAuthQuotaSnapshot. Without a
  // snapshot stamp keep it in the extension, rather than invent budget freshness.
  if (metadata.extraUsage && metadata.checkedAt !== undefined) {
    result.budget = {
      kind: 'reading',
      checkedAt: metadata.checkedAt,
      reached: metadata.extraUsage.exhausted,
      ...(metadata.extraUsage.utilizationPercent !== undefined
        ? { usedPercent: metadata.extraUsage.utilizationPercent }
        : {}),
    }
  }
  if (!isQuotaMap(result)) throw new NativeQuotaCodecError()
  return result
}

function reading(value: unknown): value is QuotaReadingEntry {
  return (
    record(value) &&
    keys(
      value,
      ['scope', 'label', 'kind', 'checkedAt', 'usedPercent'],
      ['resetsAt'],
    ) &&
    text(value.scope) &&
    text(value.label) &&
    value.kind === 'reading' &&
    time(value.checkedAt) &&
    finite(value.usedPercent) &&
    optional(value, 'resetsAt', (entry) => typeof entry === 'string')
  )
}

function equalJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length && a.every((value, i) => equalJson(value, b[i]))
    )
  if (record(a) && record(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (key) => Object.hasOwn(b, key) && equalJson(a[key], b[key]),
      )
    )
  return a === b
}

/** Reject missing Anthropic metadata, extra keys, duplicate/unowned limits, absent/retired entries and inconsistent budgets. */
export function fromNativeQuotaMap(value: unknown): OAuthQuotaSnapshot {
  if (
    !record(value) ||
    !keys(value, ['limits', 'anthropic'], ['budget']) ||
    !isQuotaMap(value) ||
    !value.limits.every(reading) ||
    !nativeMetadata(value.anthropic)
  )
    throw new NativeQuotaCodecError()
  const {
    version: _version,
    remainingPercent,
    scoped,
    ...metadata
  } = value.anthropic
  const snapshot: OAuthQuotaSnapshot = structuredClone(metadata)
  for (const label of ['five_hour', 'seven_day']) {
    const entry = value.limits.find(
      (entry) => entry.scope === 'all' && entry.label === label,
    )
    const remaining =
      label === 'five_hour'
        ? remainingPercent.five_hour
        : remainingPercent.seven_day
    if (entry?.kind !== 'reading' || remaining === undefined) continue
    const nativeWindow = {
      usedPercent: entry.usedPercent,
      remainingPercent: remaining,
      checkedAt: entry.checkedAt,
      ...(entry.resetsAt !== undefined ? { resetsAt: entry.resetsAt } : {}),
    }
    if (label === 'five_hour') snapshot.five_hour = nativeWindow
    else snapshot.seven_day = nativeWindow
  }
  if (scoped !== undefined) {
    snapshot.scoped = scoped.map((metadata) => {
      const pair = scopedPair(metadata)
      const entry = value.limits.find(
        (entry) => entry.scope === pair.scope && entry.label === pair.label,
      )
      if (entry?.kind !== 'reading') throw new NativeQuotaCodecError()
      return {
        ...structuredClone(metadata),
        usedPercent: entry.usedPercent,
        checkedAt: entry.checkedAt,
        ...(entry.resetsAt !== undefined ? { resetsAt: entry.resetsAt } : {}),
      }
    })
  }
  // This also rejects extension/map disagreement, unowned limits and budgets.
  if (!equalJson(toNativeQuotaMap(snapshot), value))
    throw new NativeQuotaCodecError()
  return snapshot
}

export const nativeQuotaCodec: QuotaCodec = {
  validate(value) {
    try {
      fromNativeQuotaMap(value)
      return true
    } catch {
      return false
    }
  },
  merge(stored, observation) {
    const incoming = fromNativeQuotaMap(observation)
    if (stored === undefined) return toNativeQuotaMap(incoming)
    const previous = fromNativeQuotaMap(stored)
    if (previous.accountIdentity !== incoming.accountIdentity)
      throw new NativeQuotaCodecError()
    if (incoming.source === 'headers')
      return toNativeQuotaMap(
        mergeHeaderQuotaForPersistence(previous, incoming),
      )
    const previousTime = quotaSnapshotCheckedAt(previous)
    const incomingTime = quotaSnapshotCheckedAt(incoming)
    return toNativeQuotaMap(
      previousTime > incomingTime ||
        (previousTime === incomingTime &&
          previous.source === 'poll' &&
          incoming.source !== 'poll')
        ? previous
        : incoming,
    )
  },
}
