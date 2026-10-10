import { createHash } from 'node:crypto'
import {
  fingerprintOf,
  type PoolCredential,
  type PoolRow,
} from '@cortexkit/common-auth/store'

import { isValidApiBaseURL } from './accounts.ts'
import { CACHE_1H_MODES } from './constants.ts'
import { inspectNativeHostAuthEntry } from './native-host-auth.ts'
import {
  captureNativeMigrationJson,
  nativeMigrationCanonicalJson,
  requireNativeMigrationDataObject,
} from './native-migration-proof.ts'
import {
  isNativeOAuthQuotaSnapshot,
  type NativeQuotaMap,
  toNativeQuotaMap,
} from './native-quota-codec.ts'
import type {
  NativeRosterSeedLegacyRow,
  NativeVaultRosterSeed,
} from './native-roster-seed.ts'
import {
  decodeNativeRuntime,
  type NativeRuntimeState,
} from './native-runtime.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import { tokenFingerprint } from './token-fingerprint.ts'

export class NativeMigrationProjectionError extends Error {
  readonly code = 'invalid-migration-source'
  constructor() {
    super('Native migration source cannot be imported safely')
    this.name = 'NativeMigrationProjectionError'
  }
}

export interface NativeMigrationAccount {
  id: string
  enabled: boolean
  identity?: string
  label?: string
  credential?: PoolCredential
  quota?: NativeQuotaMap
  runtime: Record<string, unknown>
}

export interface NativeMigrationProjection {
  accounts: NativeMigrationAccount[]
  settings: Record<string, unknown>
  mainRouteId: string
  custodyRows: NativeRosterSeedLegacyRow[]
  custodyPrimary?: { credentialId: string; accountIdentity: string }
  disabledAccountIdentities: string[]
  relay?: { token: string }
}

export interface NativeMigrationSourceInput {
  host: 'opencode' | 'pi'
  storageId: string
  configDigest: string | null
  config: unknown
  state: unknown
  hostAuth: unknown
}

function refuse(): never {
  throw new NativeMigrationProjectionError()
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return Object.create(null)
  if (!record(value)) refuse()
  return value
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}
function id(value: unknown): string {
  if (!text(value) || ['__proto__', 'constructor', 'prototype'].includes(value))
    refuse()
  return value
}
function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0
}
function identity(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!text(value)) refuse()
  return value
}
function pick(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  )
}

const settingFields: Record<string, readonly string[]> = {
  routing: ['mode'],
  refresh: ['enabled', 'intervalMinutes', 'refreshBeforeExpiryMinutes'],
  quota: [
    'enabled',
    'checkIntervalMinutes',
    'refreshEveryNRequests',
    'minimumRemaining',
    'failClosedOnUnknownQuota',
    'showToasts',
  ],
  quotaHeaderFeed: ['enabled'],
  claudeCache: ['enabled', 'mode'],
  dump: ['enabled'],
  logging: ['level'],
  claudeFast: ['enabled'],
  thinkingBinding: ['prefixMismatchBehavior'],
  costZeroing: ['enabled'],
  cacheKeep: ['enabled', 'always', 'startHour', 'endHour', 'subagents'],
  prime: ['enabled'],
  relay: ['enabled', 'url', 'fallbackToDirect', 'transport'],
  killswitch: ['enabled', 'main', 'accounts'],
}

function validateSettings(settings: Record<string, unknown>): void {
  const threshold = (value: unknown) =>
    record(value) &&
    Object.entries(value).every(
      ([key, amount]) =>
        ['five_hour', 'seven_day', '5h', '1w', 'scoped'].includes(key) &&
        typeof amount === 'number' &&
        Number.isFinite(amount) &&
        amount >= 0 &&
        amount <= 100,
    )
  const enums: Record<string, readonly string[]> = {
    'routing.mode': ['main-first', 'fallback-first', 'sticky-balanced'],
    'claudeCache.mode': CACHE_1H_MODES,
    'logging.level': ['debug', 'info', 'warn', 'error', 'trace'],
    'thinkingBinding.prefixMismatchBehavior': [
      'account-default',
      'error',
      'drop_block',
    ],
    'relay.transport': ['http', 'websocket'],
  }
  for (const [section, fields] of Object.entries(settingFields)) {
    if (settings[section] === undefined) continue
    const value = object(settings[section])
    for (const key of fields) {
      if (value[key] === undefined) continue
      const choices = enums[`${section}.${key}`]
      if (choices) {
        if (typeof value[key] !== 'string' || !choices.includes(value[key]))
          refuse()
        continue
      }
      if (
        [
          'enabled',
          'always',
          'subagents',
          'failClosedOnUnknownQuota',
          'showToasts',
          'fallbackToDirect',
        ].includes(key)
      ) {
        if (typeof value[key] !== 'boolean') refuse()
      } else if (key === 'url') {
        if (typeof value[key] !== 'string' || !isValidApiBaseURL(value[key]))
          refuse()
      } else if (key === 'minimumRemaining' || key === 'main') {
        if (!threshold(value[key])) refuse()
      } else if (key === 'accounts') {
        if (
          !record(value[key]) ||
          !Object.entries(value[key]).every(
            ([route, thresholds]) => text(route) && threshold(thresholds),
          )
        )
          refuse()
      } else if (
        typeof value[key] !== 'number' ||
        !Number.isFinite(value[key]) ||
        value[key] < 0
      )
        refuse()
    }
  }
}

function credential(source: Record<string, unknown>): PoolCredential {
  if (source.type === 'oauth' && text(source.refresh)) {
    if (
      (source.access !== undefined && typeof source.access !== 'string') ||
      (source.expires !== undefined &&
        (typeof source.expires !== 'number' ||
          !Number.isFinite(source.expires)))
    )
      refuse()
    return {
      type: 'oauth',
      refresh: source.refresh,
      ...(typeof source.access === 'string' ? { access: source.access } : {}),
      ...(typeof source.expires === 'number'
        ? { expires: source.expires }
        : {}),
    }
  }
  if (
    source.type === 'api' &&
    text(source.apiKey) &&
    typeof source.baseURL === 'string' &&
    isValidApiBaseURL(source.baseURL)
  ) {
    if (
      source.authHeader !== undefined &&
      source.authHeader !== 'authorization-bearer' &&
      source.authHeader !== 'x-api-key'
    )
      refuse()
    return {
      type: 'api',
      apiKey: source.apiKey,
      baseURL: source.baseURL,
      // The public store decodes an absent header as bearer; compare that public value.
      authHeader: source.authHeader ?? 'authorization-bearer',
    }
  }
  return refuse()
}

function runtime(
  source: Record<string, unknown>,
  accountIdentity: string | undefined,
  current: PoolCredential | undefined,
): Record<string, unknown> {
  const result = pick(source, [
    'lastUsed',
    'lastRefreshedAt',
    'refreshErrorClearedAt',
    'quotaErrorClearedAt',
    'quotaErrorGeneration',
    'prime',
    'authLineageId',
    'primeAuthLineageRefreshTokenFingerprint',
  ])
  const expectedQuotaToken =
    current?.type === 'oauth'
      ? tokenFingerprint(current.access ?? '')
      : accountIdentity
  if (
    source.quotaToken !== undefined &&
    source.quotaToken === expectedQuotaToken
  ) {
    result.quotaToken = source.quotaToken
    if (source.quotaCheckedAt !== undefined)
      result.quotaCheckedAt = source.quotaCheckedAt
  }
  // A profile is reusable only for the exact known account, and for the main
  // profile the caller additionally fences its access-token observation.
  if (
    record(source.profile) &&
    accountIdentity !== undefined &&
    (source.profile.providerAccountUuid === accountIdentity ||
      source.profile.accountIdentity === accountIdentity)
  ) {
    result.profile = pick(source.profile, [
      'tier',
      'orgType',
      'checkedAt',
      'accountIdentity',
      'providerAccountUuid',
      'tokenFingerprint',
    ])
  }
  for (const field of ['lastRefreshError', 'lastQuotaRefreshError']) {
    const error = source[field]
    const clear =
      result[
        field === 'lastRefreshError'
          ? 'refreshErrorClearedAt'
          : 'quotaErrorClearedAt'
      ]
    if (
      !record(error) ||
      (typeof clear === 'number' && time(error.checkedAt) <= clear) ||
      (error.accountIdentity !== undefined &&
        error.accountIdentity !== accountIdentity)
    )
      continue
    const safe = pick(error, [
      'checkedAt',
      'nextRetryAt',
      'retryCount',
      'accountIdentity',
      'status',
      'permanent',
    ])
    // Free-form upstream messages can contain credentials; retain retry semantics,
    // not the message or opaque legacy token identifiers.
    safe.message =
      field === 'lastRefreshError'
        ? 'Imported refresh failure'
        : 'Imported quota failure'
    if (
      field === 'lastRefreshError' &&
      current?.type === 'oauth' &&
      error.tokenHash ===
        createHash('sha256').update(current.refresh).digest('hex')
    )
      safe.credentialFingerprint = fingerprintOf(current)
    result[field] = safe
  }
  return result
}

function quota(
  source: unknown,
  accountIdentity: string | undefined,
): NativeQuotaMap | undefined {
  if (source === undefined) return undefined
  // Quota is cached usage data, not credential authority. Omit a reading the
  // native format cannot represent rather than blocking valid credentials from
  // migrating. Do not infer timestamps, usage or ownership; fresh quota polling
  // must establish any missing observation. Credential and configuration
  // validation remains unchanged.
  if (!isNativeOAuthQuotaSnapshot(source)) return undefined
  // Slot labels such as "main" are not Claude UUIDs. Importing them would make
  // the next genuine UUID observation fail the codec's ownership check.
  if (
    accountIdentity === undefined ||
    source.accountIdentity !== accountIdentity
  )
    return undefined
  return toNativeQuotaMap(source)
}

/** Deterministic projection of captured JSON, without invoking legacy loaders or callbacks. */
export function projectNativeMigrationSource(
  input: NativeMigrationSourceInput,
): NativeMigrationProjection {
  try {
    requireNativeMigrationDataObject(input)
    const config = object(
      input.config === undefined
        ? undefined
        : captureNativeMigrationJson(input.config),
    )
    const state = object(
      input.state === undefined
        ? undefined
        : captureNativeMigrationJson(input.state),
    )
    const auth = object(
      input.hostAuth === undefined
        ? undefined
        : captureNativeMigrationJson(input.hostAuth),
    )
    const hostEntry = inspectNativeHostAuthEntry(input.host, auth)
    if (
      (config.version !== undefined && config.version !== 1) ||
      (state.version !== undefined && state.version !== 1)
    )
      refuse()
    const formerMain = createHash('sha256')
      .update(
        JSON.stringify([input.storageId, input.configDigest, 'former-main']),
      )
      .digest('hex')
    const mainRouteId =
      config.mainAccountId === undefined
        ? `${formerMain.slice(0, 8)}-${formerMain.slice(8, 12)}-${formerMain.slice(12, 16)}-${formerMain.slice(16, 20)}-${formerMain.slice(20, 32)}`
        : id(config.mainAccountId)
    const settings: Record<string, unknown> = {
      mainAccountId: mainRouteId,
      formerMainRowId: mainRouteId,
    }
    for (const [key, fields] of Object.entries(settingFields)) {
      if (config[key] !== undefined)
        settings[key] = pick(object(config[key]), fields)
    }
    if (config.fallbackOn !== undefined) {
      if (
        !Array.isArray(config.fallbackOn) ||
        config.fallbackOn.some(
          (value) => typeof value !== 'number' || !Number.isInteger(value),
        )
      )
        refuse()
      settings.fallbackOn = config.fallbackOn
    }
    const claustrum = object(config.claustrum)
    const custodyPrimaryValue = claustrum.primaryAccount
    let custodyPrimary: NativeMigrationProjection['custodyPrimary']
    if (custodyPrimaryValue !== undefined) {
      const primary = object(custodyPrimaryValue)
      if (!text(primary.credentialId) || !text(primary.accountId)) refuse()
      custodyPrimary = {
        credentialId: primary.credentialId,
        accountIdentity: primary.accountId,
      }
    }
    const disabled = claustrum.disabledAccountIdentities ?? []
    if (!Array.isArray(disabled) || disabled.some((value) => !text(value)))
      refuse()
    const disabledAccountIdentities: string[] = []
    for (const value of disabled) {
      if (!text(value)) refuse()
      disabledAccountIdentities.push(value)
    }
    if (claustrum.mode === 'claustrum' && !custodyPrimary) refuse()
    settings.claustrum = {
      mode: custodyPrimary ? 'claustrum' : 'local',
      ...(custodyPrimaryValue ? { primaryAccount: custodyPrimaryValue } : {}),
      disabledAccountIdentities: disabled,
    }
    const accounts: NativeMigrationAccount[] = []
    const custodyRows: NativeRosterSeedLegacyRow[] = []
    const main = { ...object(config.main), ...object(state.main) }
    // Leave OpenCode's stored Anthropic API key under host control. Pi serves
    // OAuth accounts; remove its conflicting stored key only after the user
    // explicitly agrees to that removal during offline setup.
    if (custodyPrimary || hostEntry.kind === 'oauth') {
      let current: PoolCredential | undefined
      if (!custodyPrimary) {
        const entry = object(auth.anthropic)
        current =
          hostEntry.kind === 'oauth'
            ? credential(entry)
            : credential({
                type: 'api',
                apiKey: entry.key,
                baseURL: 'https://api.anthropic.com',
                authHeader: 'x-api-key',
              })
      }
      const mainIdentity =
        custodyPrimary?.accountIdentity ??
        (record(main.profile) &&
        current?.type === 'oauth' &&
        (main.profileToken === tokenFingerprint(current.access ?? '') ||
          main.profile.tokenFingerprint ===
            tokenFingerprint(current.access ?? ''))
          ? identity(main.profile.providerAccountUuid)
          : undefined)
      const quotaConfig = object(config.quota)
      const refreshConfig = object(config.refresh)
      const primeConfig = object(config.prime)
      const mainRuntime = { ...pick(refreshConfig, []), ...main }
      for (const [target, source] of Object.entries({
        lastRefreshError: 'mainLastRefreshError',
        refreshErrorClearedAt: 'mainRefreshErrorClearedAt',
      }))
        if (
          !Object.hasOwn(mainRuntime, target) &&
          refreshConfig[source] !== undefined
        )
          mainRuntime[target] = refreshConfig[source]
      for (const [target, source] of Object.entries({
        lastQuotaRefreshError: 'mainLastQuotaApiError',
        quotaErrorClearedAt: 'mainQuotaErrorClearedAt',
        quotaErrorGeneration: 'mainQuotaErrorGeneration',
      }))
        if (
          !Object.hasOwn(mainRuntime, target) &&
          quotaConfig[source] !== undefined
        )
          mainRuntime[target] = quotaConfig[source]
      if (main.lastQuotaApiError !== undefined)
        mainRuntime.lastQuotaRefreshError = main.lastQuotaApiError
      mainRuntime.authLineageId =
        main.primeAuthLineageId ?? primeConfig.mainAuthLineageId
      mainRuntime.primeAuthLineageRefreshTokenFingerprint =
        main.primeAuthLineageRefreshTokenFingerprint ??
        primeConfig.mainAuthLineageRefreshTokenFingerprint
      if (mainRuntime.prime === undefined && primeConfig.main !== undefined)
        mainRuntime.prime = primeConfig.main
      const account: NativeMigrationAccount = {
        id: mainRouteId,
        enabled: true,
        runtime: runtime(mainRuntime, mainIdentity, current),
        ...(mainIdentity !== undefined ? { identity: mainIdentity } : {}),
        ...(current ? { credential: current } : {}),
      }
      const mainQuota = main.quota ?? quotaConfig.mainQuota
      const observed = main.quotaToken ?? quotaConfig.mainQuotaToken
      if (
        custodyPrimary ||
        (current?.type === 'oauth' &&
          observed === tokenFingerprint(current.access ?? ''))
      )
        account.quota = quota(mainQuota, mainIdentity)
      accounts.push(account)
    }
    if (config.accounts !== undefined && !Array.isArray(config.accounts))
      refuse()
    const stateAccounts = object(state.accounts)
    for (const raw of Array.isArray(config.accounts) ? config.accounts : []) {
      const row = object(raw)
      const rowId = id(row.id)
      if (row.enabled !== undefined && typeof row.enabled !== 'boolean')
        refuse()
      const stateRow = pick(object(stateAccounts[rowId]), [
        'access',
        'refresh',
        'expires',
        'apiKey',
        'lastUsed',
        'lastRefreshedAt',
        'anthropicAccountUuid',
        'claustrumScopedCredentialId',
        'claustrumScopedState',
        'authLineageId',
        'lastRefreshError',
        'lastQuotaRefreshError',
        'quota',
        'profile',
        'prime',
        'refreshErrorClearedAt',
        'quotaErrorClearedAt',
        'quotaErrorGeneration',
      ])
      const scoped = row.claustrumScopedCredentialId !== undefined
      const sameScope =
        scoped &&
        stateRow.claustrumScopedCredentialId ===
          row.claustrumScopedCredentialId &&
        stateRow.anthropicAccountUuid === row.anthropicAccountUuid
      const configClock = Math.max(
        time(row.lastRefreshedAt),
        time(row.lastUsed),
        time(row.addedAt),
      )
      const stateClock = Math.max(
        time(stateRow.lastRefreshedAt),
        time(stateRow.lastUsed),
        time(stateRow.addedAt),
      )
      const changedSecret = ['access', 'refresh', 'apiKey'].some(
        (key) =>
          row[key] !== undefined &&
          stateRow[key] !== undefined &&
          row[key] !== stateRow[key],
      )
      const configNewer = changedSecret && configClock > stateClock
      if (changedSecret && configClock === stateClock) refuse()
      const merged = scoped
        ? { ...(sameScope ? stateRow : {}), ...row }
        : configNewer
          ? { ...stateRow, ...row }
          : { ...row, ...stateRow }
      if (configNewer) {
        delete merged.quota
        delete merged.lastRefreshError
        delete merged.lastQuotaRefreshError
      }
      const accountIdentity = identity(
        row.anthropicAccountUuid ?? merged.anthropicAccountUuid,
      )
      if (
        row.anthropicAccountUuid !== undefined &&
        stateRow.anthropicAccountUuid !== undefined &&
        row.anthropicAccountUuid !== stateRow.anthropicAccountUuid
      )
        refuse()
      if (custodyPrimary && row.type === 'oauth' && !scoped) refuse()
      const current = scoped ? undefined : credential(merged)
      if (scoped) {
        if (
          row.type !== 'oauth' ||
          !text(row.claustrumScopedCredentialId) ||
          !accountIdentity ||
          text(row.refresh) ||
          row.access !== undefined
        )
          refuse()
        custodyRows.push({
          routeId: rowId,
          scopedCredentialId: row.claustrumScopedCredentialId,
          anthropicAccountUuid: accountIdentity,
          enabled: row.enabled !== false,
          ...(text(row.label) ? { label: row.label } : {}),
          ...(typeof row.addedAt === 'number' ? { addedAt: row.addedAt } : {}),
        })
      }
      const account: NativeMigrationAccount = {
        id: rowId,
        enabled: row.enabled !== false,
        runtime: runtime(merged, accountIdentity, current),
        ...(accountIdentity !== undefined ? { identity: accountIdentity } : {}),
        ...(text(row.label) ? { label: row.label } : {}),
        ...(current ? { credential: current } : {}),
      }
      const observation = quota(merged.quota, accountIdentity)
      if (observation) account.quota = observation
      accounts.push(account)
    }
    if (new Set(accounts.map((account) => account.id)).size !== accounts.length)
      refuse()
    const enabledIdentity = new Set<string>()
    const secrets = new Set<string>()
    for (const account of accounts) {
      if (account.enabled && account.identity) {
        if (enabledIdentity.has(account.identity)) refuse()
        enabledIdentity.add(account.identity)
      }
      if (account.credential) {
        const secret = fingerprintOf(account.credential)
        if (secrets.has(secret)) refuse()
        secrets.add(secret)
        Object.defineProperty(account, 'credential', { enumerable: false })
      }
      for (const key of Object.keys(account.runtime))
        if (account.runtime[key] === undefined) delete account.runtime[key]
      if (account.quota === undefined) delete account.quota
    }
    validateSettings(settings)
    const relay = object(config.relay)
    return {
      accounts,
      settings,
      mainRouteId,
      custodyRows,
      disabledAccountIdentities,
      ...(custodyPrimary ? { custodyPrimary } : {}),
      ...(typeof relay.token === 'string'
        ? { relay: { token: relay.token } }
        : {}),
    }
  } catch {
    return refuse()
  }
}

/** Ignore lastRefreshedAt here: adding an OAuth row generates it, so it is not source data. */
export function requireNativeMigrationSourceRows(
  projection: NativeMigrationProjection,
  rows: readonly PoolRow[],
  checkQuota = true,
): void {
  const local = projection.accounts.filter(
    (account) => account.credential !== undefined,
  )
  if (rows.length !== local.length) refuse()
  for (const expected of local) {
    const actual = rows.find((row) => row.id === expected.id)
    if (
      actual?.stamp !== 'bound' ||
      actual.invalid ||
      actual.torn ||
      actual.unbound ||
      actual.identity !== expected.identity ||
      actual.enabled !== expected.enabled ||
      !actual.credential
    )
      refuse()
    let descriptor: PoolCredential
    if (actual.credential.type === 'oauth') {
      const { lastRefreshedAt: _stamp, ...value } = actual.credential
      descriptor = value
    } else descriptor = actual.credential
    if (
      nativeMigrationCanonicalJson(descriptor) !==
      nativeMigrationCanonicalJson(expected.credential)
    )
      refuse()
    if (
      checkQuota &&
      nativeMigrationCanonicalJson(actual.quota ?? null) !==
        nativeMigrationCanonicalJson(expected.quota ?? null)
    )
      refuse()
  }
}

/** Use row.credentialEpoch to associate imported quota and errors with the stored credentials. The store’s internal integrity hash is not a public account version. */
export function projectNativeMigrationRuntime(
  paths: NativePoolPaths,
  projection: NativeMigrationProjection,
  rows: readonly PoolRow[],
  seed?: NativeVaultRosterSeed,
): NativeRuntimeState {
  const accounts: Record<string, unknown> = Object.create(null)
  for (const account of projection.accounts.filter(
    (account) => account.credential,
  )) {
    const row = rows.find((row) => row.id === account.id)
    if (row?.stamp !== 'bound' || row.credentialEpoch === undefined) refuse()
    accounts[account.id] = {
      binding: {
        kind: 'local',
        storageId: paths.storageId,
        rowId: row.id,
        credentialEpoch: row.credentialEpoch,
        ...(row.identity !== undefined ? { identity: row.identity } : {}),
      },
      ...account.runtime,
    }
  }
  if (seed)
    for (const account of projection.accounts.filter(
      (account) => !account.credential,
    )) {
      const row = seed.rows.find((row) => row.routeId === account.id)
      if (!row?.accountIdentity || row.accountIdentity !== account.identity)
        refuse()
      // Old quota and profile records identify the account, but not the vault
      // token version used. Zero marks that missing version; it cannot authorize
      // a request or identify a rejected token in a vault failure report.
      accounts[account.id] = {
        binding: {
          kind: 'custody',
          storageId: paths.storageId,
          routeId: row.routeId,
          credentialId: row.credentialId,
          accountIdentity: row.accountIdentity,
          recordVersion: 0,
        },
        ...account.runtime,
        ...(account.quota ? { quota: account.quota } : {}),
      }
    }
  return decodeNativeRuntime(
    {
      version: 1,
      storageId: paths.storageId,
      accounts,
      ...(projection.relay ? { relay: projection.relay } : {}),
    },
    paths.storageId,
  )
}
