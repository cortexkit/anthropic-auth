import { types } from 'node:util'
import { fingerprintOf, type PoolRow } from '@cortexkit/common-auth/store'

import {
  type AccountOperationError,
  type AccountStorage,
  buildQuotaOperationError,
  type FallbackAccount,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  type PrimeUsageCounters,
  type ProviderAccountUuid,
} from './accounts.ts'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from './native-quota-codec.ts'
import type { NativeVaultRosterDocument } from './native-roster-seed.ts'
import type {
  NativeRuntimeEntry,
  NativeRuntimeState,
} from './native-runtime.ts'
import { NativeRuntimeError } from './native-runtime.ts'
import { isTransientNetworkError } from './network-errors.ts'
import {
  type NativeLocalPoolBinding,
  nativeLocalPoolBindingMatches,
} from './pool-binding.ts'
import type { NativePoolPaths } from './pool-paths.ts'

/** Display and policy metadata, not evidence that a presented token was accepted for this account. */
export interface NativeAccountView {
  id: string
  type: 'oauth' | 'api'
  source: 'local' | 'vault'
  enabled: boolean
  label?: string
  addedAt?: number
  accountIdentity?: string
  binding?: NativeLocalPoolBinding
  credentialId?: string
  state?: string
  quota?: OAuthQuotaSnapshot
  profile?: OAuthAccountProfile
  prime?: PrimeUsageCounters
  lastUsed?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quotaErrorClearedAt?: number
  quotaErrorGeneration?: number
  refreshErrorClearedAt?: number
  baseURL?: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export interface NativeAccountSnapshot {
  mode: 'local' | 'claustrum'
  settings: Record<string, unknown>
  accounts: NativeAccountView[]
  /** AccountStorage-shaped input for pure policy predicates, never a credential or persistence authority. */
  policyStorage: AccountStorage
}

export interface NativeAccountMetadataPatch {
  quota?: OAuthQuotaSnapshot
  profile?: OAuthAccountProfile
  lastUsed?: number
  lastQuotaRefreshError?: AccountOperationError
  quotaErrorClearedAt?: number
  quotaErrorGeneration?: number
  prime?: PrimeUsageCounters
  authLineageId?: string
}

/** Copy data without invoking caller getters, proxies, serializers or callbacks. */
export function captureNativePlainData(input: unknown): unknown {
  const ancestors = new Set<object>()
  function copy(value: unknown): unknown {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      value === undefined
    )
      return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (
      !value ||
      typeof value !== 'object' ||
      types.isProxy(value) ||
      ancestors.has(value)
    )
      throw new NativeRuntimeError('publication-refused')
    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        if (
          Reflect.ownKeys(value).some(
            (key) =>
              typeof key !== 'string' ||
              (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)),
          )
        )
          throw new NativeRuntimeError('publication-refused')
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          )
          if (!descriptor || !('value' in descriptor))
            throw new NativeRuntimeError('publication-refused')
          return copy(descriptor.value)
        })
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw new NativeRuntimeError('publication-refused')
      const result: Record<string, unknown> = {}
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (
          typeof key !== 'string' ||
          !descriptor ||
          !('value' in descriptor) ||
          key === '__proto__'
        )
          throw new NativeRuntimeError('publication-refused')
        result[key] = copy(descriptor.value)
      }
      return result
    } finally {
      ancestors.delete(value)
    }
  }
  return copy(input)
}

export function captureNativeMetadataPatch(
  patch: NativeAccountMetadataPatch,
): NativeAccountMetadataPatch {
  const result = captureNativePlainData(patch) as NativeAccountMetadataPatch
  if (
    !result ||
    Object.keys(result).some(
      (key) =>
        ![
          'quota',
          'profile',
          'lastUsed',
          'lastQuotaRefreshError',
          'quotaErrorClearedAt',
          'quotaErrorGeneration',
          'prime',
          'authLineageId',
        ].includes(key),
    )
  )
    throw new NativeRuntimeError('publication-refused')
  return result
}

export function applyNativeMetadataPatch(
  entry: NativeRuntimeEntry,
  patch: NativeAccountMetadataPatch,
): NativeRuntimeEntry {
  const { quota, ...metadata } = patch
  const next = { ...entry, ...metadata }
  if (patch.lastUsed !== undefined) {
    if (!Number.isFinite(patch.lastUsed) || patch.lastUsed < 0)
      throw new NativeRuntimeError('publication-refused')
    next.lastUsed = Math.max(entry.lastUsed ?? 0, patch.lastUsed)
  }
  if (quota) {
    const observation = toNativeQuotaMap(quota)
    next.quota = nativeQuotaCodec.merge(
      entry.quota,
      observation,
    ) as NativeRuntimeEntry['quota']
    next.quotaCheckedAt = quota.checkedAt
  }
  if (patch.quotaErrorClearedAt !== undefined) delete next.lastQuotaRefreshError
  return next
}

/** Keep established retry policy without persisting provider bodies or arbitrary exception text. */
export function nativeQuotaFailure(
  error: unknown,
  accountIdentity: string | undefined,
  checkedAt: number,
  previous?: AccountOperationError,
): AccountOperationError | undefined {
  const safe = new Error('OAuth quota check failed')
  if (error && typeof error === 'object' && !types.isProxy(error)) {
    for (const key of ['status', 'retryAfter']) {
      const value = Object.getOwnPropertyDescriptor(error, key)?.value
      if (typeof value === 'number' && Number.isFinite(value))
        Object.assign(safe, { [key]: value })
    }
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    const message = Object.getOwnPropertyDescriptor(error, 'message')?.value
    if (
      isTransientNetworkError({
        code: typeof code === 'string' ? code : '',
        message: typeof message === 'string' ? message : '',
      })
    )
      Object.assign(safe, { code: 'ECONNRESET' })
  }
  const status = Object.getOwnPropertyDescriptor(safe, 'status')?.value
  // Token rejection and account/org policy failures need reauthorization or a
  // different account, not a quota-saturation delay.
  if (status === 401 || status === 403) return undefined
  const policy = buildQuotaOperationError({
    error: safe,
    accountIdentity,
    now: checkedAt,
    previous,
  })
  return {
    ...policy,
    ...(typeof status === 'number' && Number.isFinite(status)
      ? { status }
      : {}),
  }
}

export class NativeAccountReadError extends Error {
  constructor(
    public readonly status?: number,
    public readonly retryAfter?: number,
    public readonly code?: 'ECONNRESET',
  ) {
    super(
      `OAuth metadata read failed${status !== undefined ? `: ${status}` : ''}`,
    )
    this.name = 'NativeAccountReadError'
  }
}

/** Keep the HTTP status and retry classification. Omit provider error text and nested causes because they can contain credentials. */
export function nativeAccountReadError(
  error: unknown,
  responseStatus?: number,
): NativeAccountReadError {
  const fields: Record<string, unknown> = {}
  if (error && typeof error === 'object' && !types.isProxy(error)) {
    for (const key of ['status', 'retryAfter', 'code', 'message'])
      fields[key] = Object.getOwnPropertyDescriptor(error, key)?.value
  }
  const status =
    typeof fields.status === 'number' && Number.isFinite(fields.status)
      ? fields.status
      : undefined
  const retryAfter = fields.retryAfter
  const code =
    status === undefined &&
    isTransientNetworkError({
      code: typeof fields.code === 'string' ? fields.code : '',
      message: typeof fields.message === 'string' ? fields.message : '',
    })
      ? 'ECONNRESET'
      : undefined
  return new NativeAccountReadError(
    responseStatus ?? status,
    typeof retryAfter === 'number' && Number.isFinite(retryAfter)
      ? retryAfter
      : undefined,
    code,
  )
}

export const NATIVE_PRIMARY_CREDENTIAL_ID = 'oauth:anthropic'

export interface NativeVaultPrimaryPin {
  routeId: string
  credentialId: string
  accountIdentity: string
}

/** Offline setup records the primary account UUID and credential ID. Later vault discovery must not replace that selection. */
export function nativeVaultPrimaryPin(
  settings: Record<string, unknown>,
): NativeVaultPrimaryPin | undefined {
  const custody = settings.claustrum as
    | { primaryAccount?: { credentialId?: unknown; accountId?: unknown } }
    | undefined
  const primary = custody?.primaryAccount
  if (
    typeof settings.mainAccountId !== 'string' ||
    !settings.mainAccountId ||
    typeof primary?.credentialId !== 'string' ||
    !primary.credentialId ||
    typeof primary.accountId !== 'string' ||
    !primary.accountId
  )
    return undefined
  return {
    routeId: settings.mainAccountId,
    credentialId: primary.credentialId,
    accountIdentity: primary.accountId,
  }
}

export function nativeVaultPrimaryRow(
  roster: NativeVaultRosterDocument | undefined,
  pin: NativeVaultPrimaryPin | undefined,
) {
  if (!pin) return undefined
  return roster?.rows.find(
    (row) =>
      row.routeId === pin.routeId &&
      row.accountIdentity === pin.accountIdentity &&
      (row.credentialId === pin.credentialId ||
        row.aliases?.includes(pin.credentialId)),
  )
}

// Select public settings explicitly. Exclude stored tokens, relay authorization
// and arbitrary extra fields so UI and routing snapshots cannot retain credentials.
const settingFields: Readonly<Record<string, readonly string[]>> = {
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
  claustrum: ['mode', 'disabledAccountIdentities'],
  killswitch: ['enabled', 'main', 'accounts'],
}

export function nativeAccountSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (typeof settings.mainAccountId === 'string')
    result.mainAccountId = settings.mainAccountId
  if (Array.isArray(settings.nativeAccountOrder))
    result.nativeAccountOrder = settings.nativeAccountOrder.filter(
      (value) => typeof value === 'string',
    )
  if (Array.isArray(settings.fallbackOn))
    result.fallbackOn = settings.fallbackOn.filter((value) =>
      Number.isInteger(value),
    )
  for (const [key, fields] of Object.entries(settingFields)) {
    const value = settings[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const selected: Record<string, unknown> = {}
    for (const field of fields) {
      const item = Object.getOwnPropertyDescriptor(value, field)?.value
      if (item !== undefined) selected[field] = structuredClone(item)
    }
    result[key] = selected
  }
  const custody = settings.claustrum as
    | {
        primaryAccount?: {
          credentialId?: unknown
          accountId?: unknown
          state?: unknown
        }
      }
    | undefined
  if (custody?.primaryAccount) {
    const selected = result.claustrum as Record<string, unknown>
    selected.primaryAccount = {
      credentialId: custody.primaryAccount.credentialId,
      accountId: custody.primaryAccount.accountId,
      state: custody.primaryAccount.state,
    }
  }
  return result
}

function sameLocal(
  entry: NativeRuntimeEntry | undefined,
  binding: NativeLocalPoolBinding,
) {
  const old = entry?.binding
  return (
    old?.kind === 'local' &&
    old.storageId === binding.storageId &&
    old.rowId === binding.rowId &&
    old.identity === binding.identity &&
    old.credentialEpoch === binding.credentialEpoch
  )
}

function vaultEntry(
  input: { paths: NativePoolPaths; runtime?: NativeRuntimeState },
  row: NonNullable<NativeVaultRosterDocument>['rows'][number],
) {
  const stored = input.runtime?.accounts[row.routeId]
  const binding = stored?.binding
  return binding?.kind === 'custody' &&
    binding.storageId === input.paths.storageId &&
    binding.routeId === row.routeId &&
    binding.accountIdentity === row.accountIdentity &&
    (binding.credentialId === row.credentialId ||
      row.aliases?.includes(binding.credentialId))
    ? stored
    : undefined
}

function safeError(
  error: AccountOperationError | undefined,
): AccountOperationError | undefined {
  if (!error) return undefined
  return {
    message: 'OAuth operation failed',
    checkedAt: error.checkedAt,
    nextRetryAt: error.nextRetryAt,
    retryCount: error.retryCount,
    accountIdentity: error.accountIdentity,
    status: error.status,
    permanent: error.permanent,
  }
}

function metadata(
  entry: NativeRuntimeEntry | undefined,
): Partial<NativeAccountView> {
  return {
    lastUsed: entry?.lastUsed,
    lastRefreshedAt: entry?.lastRefreshedAt,
    lastRefreshError: safeError(entry?.lastRefreshError),
    lastQuotaRefreshError: safeError(entry?.lastQuotaRefreshError),
    quotaErrorClearedAt: entry?.quotaErrorClearedAt,
    quotaErrorGeneration: entry?.quotaErrorGeneration,
    refreshErrorClearedAt: entry?.refreshErrorClearedAt,
    profile: entry?.profile && {
      tier: entry.profile.tier,
      orgType: entry.profile.orgType,
      checkedAt: entry.profile.checkedAt,
      accountIdentity: entry.profile.accountIdentity,
      providerAccountUuid: entry.profile.providerAccountUuid,
    },
    prime: entry?.prime && { ...entry.prime },
  }
}

/** Join quota, profile and errors only for matching storage, account and credential generation; a reused route must not expose its previous account. */
export function projectNativeAccountViews(input: {
  paths: NativePoolPaths
  rows: readonly PoolRow[]
  settings: Record<string, unknown>
  runtime?: NativeRuntimeState
  roster?: NativeVaultRosterDocument
}): NativeAccountSnapshot {
  const settings = nativeAccountSettings(input.settings)
  const mode =
    (settings.claustrum as { mode?: unknown } | undefined)?.mode === 'claustrum'
      ? 'claustrum'
      : 'local'
  const accounts: NativeAccountView[] = []
  for (const row of input.rows) {
    if (mode === 'claustrum' && row.type === 'oauth') continue
    const proposed: NativeLocalPoolBinding | undefined =
      row.credentialEpoch !== undefined
        ? {
            kind: 'local',
            storageId: input.paths.storageId,
            rowId: row.id,
            credentialEpoch: row.credentialEpoch,
            ...(row.identity !== undefined ? { identity: row.identity } : {}),
          }
        : undefined
    // Disabled rows still have identity/metadata, but are never dispatch candidates.
    const binding =
      proposed && nativeLocalPoolBindingMatches(proposed, input.paths, row)
        ? proposed
        : undefined
    const stored = input.runtime?.accounts[row.id]
    const entry = binding && sameLocal(stored, binding) ? stored : undefined
    const id = row.id === settings.mainAccountId ? 'main' : row.id
    const observedQuota =
      row.type === 'oauth' && row.quota !== undefined
        ? fromNativeQuotaMap(row.quota)
        : undefined
    // Learning an account identity does not retag older quota observations.
    // Only a reading explicitly owned by the current account can guide routing.
    const quota =
      row.identity !== undefined &&
      observedQuota?.accountIdentity === row.identity
        ? observedQuota
        : undefined
    const localMetadata = metadata(entry)
    // A refresh-token rotation can keep the account and epoch unchanged.
    // An error from the previous token must not exclude the new credential.
    if (
      entry?.lastRefreshError?.credentialFingerprint &&
      (!row.credential ||
        entry.lastRefreshError.credentialFingerprint !==
          fingerprintOf(row.credential))
    )
      delete localMetadata.lastRefreshError
    accounts.push({
      id,
      type: row.type,
      source: 'local',
      ...(row.credential?.type === 'oauth' &&
      row.credential.access &&
      !row.credential.access.startsWith('sk-ant-oat')
        ? { state: 'unsupported-access' }
        : {}),
      enabled: row.enabled && row.candidate,
      label: row.label,
      addedAt: row.addedAt,
      accountIdentity: row.identity,
      binding,
      ...localMetadata,
      ...(quota ? { quota } : {}),
      ...(row.credential?.type === 'api'
        ? {
            baseURL: row.credential.baseURL,
            authHeader: row.credential.authHeader,
          }
        : {}),
    })
  }
  if (mode === 'claustrum') {
    const primary = nativeVaultPrimaryRow(
      input.roster,
      nativeVaultPrimaryPin(settings),
    )
    for (const row of input.roster?.rows ?? []) {
      if (row.credentialType !== 'oauth') continue
      const entry = vaultEntry(input, row)
      accounts.push({
        id: row === primary ? 'main' : row.routeId,
        type: 'oauth',
        source: 'vault',
        enabled: row.enabled && row.state === 'active',
        label: row.label,
        addedAt: row.addedAt,
        accountIdentity: row.accountIdentity,
        credentialId: row.credentialId,
        state: row.state,
        ...metadata(entry),
        ...(entry?.quota ? { quota: fromNativeQuotaMap(entry.quota) } : {}),
      })
    }
  }
  if (Array.isArray(settings.nativeAccountOrder)) {
    const order = settings.nativeAccountOrder
    accounts.sort((a, b) => {
      const left = order.indexOf(a.id),
        right = order.indexOf(b.id)
      return (
        (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
      )
    })
  }
  // The empty refresh field lets existing routing and quota checks recognize
  // an OAuth account without exposing its token. These display rows cannot
  // authorize requests or write credentials; they carry no verified serving token.
  const fallbacks: FallbackAccount[] = accounts
    .filter((row) => row.id !== 'main')
    .map((row) =>
      row.type === 'oauth'
        ? {
            id: row.id,
            type: 'oauth',
            refresh: '',
            label: row.label,
            enabled: row.enabled,
            addedAt: row.addedAt,
            anthropicAccountUuid: row.accountIdentity as
              | ProviderAccountUuid
              | undefined,
            claustrumScopedCredentialId: row.credentialId,
            claustrumScopedState: row.state,
            quota: row.quota,
            profile: row.profile,
            prime: row.prime,
            lastUsed: row.lastUsed,
            lastRefreshedAt: row.lastRefreshedAt,
            lastRefreshError: row.lastRefreshError,
            lastQuotaRefreshError: row.lastQuotaRefreshError,
          }
        : {
            id: row.id,
            type: 'api',
            label: row.label,
            enabled: row.enabled,
            addedAt: row.addedAt,
            baseURL: row.baseURL ?? '',
            authHeader: row.authHeader,
            lastUsed: row.lastUsed,
          },
    )
  const policyStorage: AccountStorage = {
    version: 1,
    ...settings,
    accounts: fallbacks,
  }
  const main = accounts.find((row) => row.id === 'main')
  const primary = nativeVaultPrimaryRow(
    input.roster,
    nativeVaultPrimaryPin(settings),
  )
  const candidateMainEntry =
    main?.source === 'local' && main.binding
      ? input.runtime?.accounts[main.binding.rowId]
      : primary
        ? vaultEntry(input, primary)
        : undefined
  const mainEntry =
    main?.source === 'local' &&
    main.binding &&
    !sameLocal(candidateMainEntry, main.binding)
      ? undefined
      : candidateMainEntry
  if (main) {
    policyStorage.mainAccountId = main.accountIdentity ?? main.binding?.rowId
    policyStorage.main = {
      type: 'opencode',
      provider: 'anthropic',
      profile: main.profile,
    }
    policyStorage.quota = {
      ...policyStorage.quota,
      mainQuota: main.quota,
      mainQuotaCheckedAt: mainEntry?.quotaCheckedAt ?? main.quota?.checkedAt,
      mainQuotaToken: main.accountIdentity,
      mainLastQuotaApiError: main.lastQuotaRefreshError,
      mainQuotaErrorClearedAt: mainEntry?.quotaErrorClearedAt,
      mainQuotaErrorGeneration: mainEntry?.quotaErrorGeneration,
    }
    policyStorage.refresh = {
      ...policyStorage.refresh,
      mainLastRefreshError: main.lastRefreshError,
      mainRefreshErrorClearedAt: mainEntry?.refreshErrorClearedAt,
    }
    policyStorage.prime = {
      ...policyStorage.prime,
      main: main.prime,
      mainAuthLineageId: mainEntry?.authLineageId,
    }
  }
  return structuredClone({ mode, settings, accounts, policyStorage })
}
