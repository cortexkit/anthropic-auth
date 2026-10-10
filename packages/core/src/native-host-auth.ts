import { createHash } from 'node:crypto'

import { custodyTombstoneOAuth } from './claustrum.ts'

export class NativeHostAuthError extends Error {
  readonly code: 'invalid-source' | 'supervised-auth-snapshot'

  constructor(code: 'invalid-source' | 'supervised-auth-snapshot') {
    super(
      code === 'supervised-auth-snapshot'
        ? 'Local login cannot be verified while OPENCODE_AUTH_CONTENT is set. Run setup without OPENCODE_AUTH_CONTENT in the environment.'
        : 'Invalid native host auth source.',
    )
    this.name = 'NativeHostAuthError'
    this.code = code === 'supervised-auth-snapshot' ? code : 'invalid-source'
  }
}

export function hasSupervisedAuthContentSnapshot(
  env: NodeJS.ProcessEnv,
): boolean {
  return env.OPENCODE_AUTH_CONTENT !== undefined
}

export function requireNoSupervisedAuthContentSnapshot(
  env: NodeJS.ProcessEnv,
): void {
  if (hasSupervisedAuthContentSnapshot(env))
    throw new NativeHostAuthError('supervised-auth-snapshot')
}

export interface NativeHostAuthEntryInspection {
  readonly kind: 'absent' | 'oauth' | 'api' | 'api_key' | 'activation'
  readonly digest: string
}

function invalidSource(): never {
  throw new NativeHostAuthError('invalid-source')
}

function isDictionary(value: unknown): value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Descriptors avoid getters; a Map also keeps __proto__ and constructor as data.
function ownDataProperties(value: object): Map<string, unknown> {
  const properties = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalidSource()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalidSource()
    properties.set(key, descriptor.value)
  }
  return properties
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidSource()
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') invalidSource()
  if (ancestors.has(value)) invalidSource()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalidSource()
      const properties = ownDataProperties(value)
      const length = properties.get('length') as number
      // Holes and additional array properties cannot be represented by JSON arrays.
      if (properties.size !== length + 1) invalidSource()
      const items: string[] = []
      for (let index = 0; index < length; index++) {
        const key = String(index)
        if (!properties.has(key)) invalidSource()
        items.push(canonicalJson(properties.get(key), ancestors))
      }
      return `[${items.join(',')}]`
    }
    if (!isDictionary(value)) invalidSource()
    const properties = ownDataProperties(value)
    // Emit keys directly: rebuilding an object would reorder integer-like keys.
    return `{${[...properties.keys()]
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(properties.get(key), ancestors)}`,
      )
      .join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

/** Inspect parsed host auth only; path safety, consent and writes belong to callers. */
export function inspectNativeHostAuthEntry(
  host: 'opencode' | 'pi',
  hostAuth: unknown,
): Readonly<NativeHostAuthEntryInspection> {
  try {
    if (host !== 'opencode' && host !== 'pi') invalidSource()
    if (hostAuth === undefined)
      return Object.freeze({ kind: 'absent', digest: 'absent' })
    if (!isDictionary(hostAuth)) invalidSource()
    const root = ownDataProperties(hostAuth)
    if (!root.has('anthropic'))
      return Object.freeze({ kind: 'absent', digest: 'absent' })
    const entry = root.get('anthropic')
    if (!isDictionary(entry)) invalidSource()
    const properties = ownDataProperties(entry)
    const canonical = canonicalJson(entry)
    let kind: NativeHostAuthEntryInspection['kind']
    const type = properties.get('type')
    if (type === 'oauth') {
      if (
        typeof properties.get('access') !== 'string' ||
        typeof properties.get('refresh') !== 'string' ||
        typeof properties.get('expires') !== 'number' ||
        !Number.isFinite(properties.get('expires'))
      )
        invalidSource()
      const tombstone = custodyTombstoneOAuth('anthropic')
      kind =
        properties.size === 4 &&
        Object.entries(tombstone).every(
          ([key, value]) => properties.get(key) === value,
        )
          ? 'activation'
          : 'oauth'
    } else if (host === 'opencode' && type === 'api') {
      if (typeof properties.get('key') !== 'string') invalidSource()
      kind = 'api'
    } else if (host === 'pi' && type === 'api_key') {
      if (properties.has('key') && typeof properties.get('key') !== 'string')
        invalidSource()
      if (properties.has('env')) {
        const env = properties.get('env')
        if (!isDictionary(env)) invalidSource()
        for (const value of ownDataProperties(env).values())
          if (typeof value !== 'string') invalidSource()
      }
      kind = 'api_key'
    } else {
      invalidSource()
    }
    // Recognition is exact, but every authentication-bearing placeholder refuses.
    if (kind !== 'activation') {
      for (const field of ['access', 'refresh', 'key']) {
        const value = properties.get(field)
        if (
          typeof value === 'string' &&
          value.startsWith('claustrum-tombstone:')
        )
          invalidSource()
      }
    }
    return Object.freeze({
      kind,
      digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    })
  } catch {
    // Unsupported values (including reflective failures) never leak input or causes.
    throw new NativeHostAuthError('invalid-source')
  }
}
