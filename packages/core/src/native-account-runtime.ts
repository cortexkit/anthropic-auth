import { randomUUID } from 'node:crypto'
import { withLock as acquireLock } from '@cortexkit/common-auth/fs'
import {
  fingerprintOf,
  POOL_LOCK_DEFAULTS,
  type PoolCredential,
  type PoolRow,
} from '@cortexkit/common-auth/store'
import {
  buildRefreshOperationError,
  fetchOAuthQuotaSnapshot,
  killswitchPassesPolicy,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  type PrimeUsageDelta,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
} from './accounts.ts'
import { resolveClaudeCodeIdentity } from './claude-code.ts'
import { type LogLevel, logger } from './logger.ts'
import {
  applyNativeMetadataPatch,
  captureNativeMetadataPatch,
  captureNativePlainData,
  type NativeAccountMetadataPatch,
  type NativeAccountSnapshot,
  type NativeAccountView,
  nativeAccountCanServe,
  nativeAccountReadError,
  nativeLocalRouteAwaitsTornWrite,
  nativeQuotaFailure,
  projectNativeAccountViews,
} from './native-account-view.ts'
import {
  applyCommittedNativeSettingsEffects,
  applyNativeLogLevel,
  captureNativeSettingsEffectFields,
  logCommittedNativeAccountAdded,
  logCommittedNativeAccountChange,
  type NativeSettingsEffectFields,
} from './native-command-effects.ts'
import { nativeLocalCredentialValidationMatches } from './native-credential-validation.ts'
import {
  NativeCustodyError,
  type NativeCustodyReceipt,
} from './native-custody.ts'
import { readNativeEnrollmentMode } from './native-enrollment-authority.ts'
import {
  createNativeLocalCredentialService,
  type NativeLocalCredentialServiceOptions,
} from './native-local-credential-service.ts'
import { acquireNativeLocalPublisher } from './native-local-publication.ts'
import type { NativeLocalExternalPolicy } from './native-local-runtime-readers.ts'
import {
  type NativeLockEvent,
  nativeLockObserver,
  observeNativeLocks,
} from './native-lock-observer.ts'
import { nativeQuotaCodec, toNativeQuotaMap } from './native-quota-codec.ts'
import {
  type NativeQuotaObservations,
  nativeLocalQuotaLineage,
  nativePollQuotaGenerallyExhausted,
} from './native-quota-observations.ts'
import type {
  NativeKnownCredentialSubject,
  NativeRefreshResult,
  NativeRefreshSubject,
} from './native-refresh-coordinator.ts'
import { NATIVE_REFRESH_MAX_ATTEMPTS } from './native-refresh-coordinator.ts'
import {
  type NativeRuntimeEntry,
  NativeRuntimeError,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
} from './native-runtime.ts'
import {
  NativeRuntimeRegistry,
  nativeRuntimeOptionIdentity,
} from './native-runtime-registry.ts'
import {
  joinNativePoolWrite,
  NativeTransientAccountError,
} from './native-transient-account.ts'
import { createNativeUsagePublisher } from './native-usage-publication.ts'
import { nativeVaultPaths } from './native-vault-paths.ts'
import {
  acquireNativeVaultRuntime,
  leaseNativeVaultRuntime,
  type NativeDisplayProfile,
  type NativeVaultQuotaPurpose,
  type NativeVaultRuntime,
  type NativeVaultRuntimeOptions,
  nativeDisplayProfile,
  nativeVaultRuntimeKey,
} from './native-vault-runtime.ts'
import type { NativeVaultRoutingSeed } from './native-vault-seed.ts'
import { fetchOAuthAccountProfile } from './oauth-profile.ts'
import { requireNativePoolAuthority } from './pool-authority.ts'
import {
  captureNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
  nativeLocalPoolBindingMatches,
} from './pool-binding.ts'
import {
  type NativePoolPaths,
  resolveLocalRoutingDestination,
  stateLayoutOfPaths,
} from './pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from './pool-store.ts'
import type { QuotaRequestDispatch } from './quota-manager.ts'
import { effectiveRelayTransport, type RelayConfig } from './relay.ts'
import {
  nativeRelocationGuard,
  type RelocationGuard,
} from './relocation-guard.ts'
import { StickySessionRouter } from './sticky-routing.ts'
import { tokenFingerprint } from './token-fingerprint.ts'

export type {
  NativeAccountMetadataPatch,
  NativeAccountSnapshot,
  NativeAccountView,
} from './native-account-view.ts'

export interface NativeAccountRuntimeOptions {
  paths: NativePoolPaths
  host: 'opencode' | 'pi'
  /** The opencode-anthropic-auth setup command rechecks that hosts are stopped before credential-file writes, so migration cannot change credentials used by a running host. */
  beforePoolWrite?: () => Promise<void>
  local?: Partial<
    Pick<
      NativeLocalCredentialServiceOptions,
      | 'refreshToken'
      | 'resolveIdentity'
      | 'failurePolicy'
      | 'now'
      | 'onLockEvent'
    >
  >
  vault?: Omit<NativeVaultRuntimeOptions, 'paths' | 'host'>
}
export interface NativeLocalAuthorizeOptions {
  intent?: 'serve' | 'refresh'
  rejectedAccessToken?: string
  signal?: AbortSignal
  policy?: (
    account: NativeAccountView,
    snapshot: NativeAccountSnapshot,
  ) => NativeLocalExternalPolicy
}
export interface NativeAccountWriteInput {
  routeId: string
  credential: PoolCredential
  accountIdentity?: string
  label?: string
  replace?: boolean
}
export interface NativeApiSubject {
  kind: 'api'
  binding: NativeLocalPoolBinding
  credentialFingerprint: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type NativeRelayUpdate = Partial<Omit<RelayConfig, 'token'>> & {
  token?: string | null
}

export interface NativeAccountRuntime {
  readonly onLockEvent?: (event: NativeLockEvent) => void
  /**
   * Refuses once a newer version has moved this runtime's files. Hosts pass
   * it to the routing stores they create, so their writes check it under
   * the routing file's lock.
   */
  readonly relocationGuard?: RelocationGuard
  readonly vault: NativeVaultRuntime
  readonly quotaObservations: NativeQuotaObservations
  /** Waits for pending quota observations, quota submissions, and runtime metadata writes. An accepted pool quota update may not yet be on disk; close() drains the pool's pending quota writes. */
  drainQuotaPublications(): Promise<void>
  drainRoutingPublications(): Promise<void>
  /** Fresh private relay authorization for transport only; never include it in a status snapshot. */
  getRelayConfig(): Promise<RelayConfig | null>
  updateRelay(patch: NativeRelayUpdate): Promise<void>
  read(): Promise<NativeAccountSnapshot>
  authorizeLocal(
    routeId: string,
    options?: NativeLocalAuthorizeOptions,
  ): Promise<NativeRefreshResult>
  authorizeApi(
    routeId: string,
    signal?: AbortSignal,
  ): Promise<{
    type: 'api'
    apiKey: string
    baseURL: string
    authHeader?: 'authorization-bearer' | 'x-api-key'
    subject: NativeApiSubject
  }>
  authorizeVault(
    routeId: string,
    signal?: AbortSignal,
  ): Promise<NativeCustodyReceipt>
  loginOAuth(input: {
    routeId: string
    credential: { access: string; refresh: string; expires: number }
    accountIdentity?: string
    label?: string
    replace?: boolean
  }): Promise<NativeAccountView>
  putAccount(input: NativeAccountWriteInput): Promise<NativeAccountView>
  addApi(input: {
    routeId?: string
    apiKey: string
    baseURL?: string
    authHeader?: 'authorization-bearer' | 'x-api-key'
    label?: string
    replace?: boolean
  }): Promise<NativeAccountView>
  updateSettings(
    mutator: (
      settings: Record<string, unknown>,
    ) =>
      | Record<string, unknown>
      | undefined
      | Promise<Record<string, unknown> | undefined>,
  ): Promise<{
    settings: Record<string, unknown>
    outcome: 'updated' | 'unchanged'
  }>
  /**
   * Store `level` as the logging level, then make it this process's live
   * logger level if it is not already, even when the stored value was
   * unchanged. Nothing is applied when the write fails.
   */
  setLoggingLevel(level: LogLevel): Promise<void>
  setEnabled(routeId: string, enabled: boolean): Promise<void>
  remove(routeId: string): Promise<void>
  /**
   * `movedRouteId` names the account the caller moved; it identifies the
   * account in the change's INFO log and does not affect the order written.
   */
  reorder(routeIds: readonly string[], movedRouteId?: string): Promise<void>
  captureLocalSubject(routeId: string): Promise<NativeRefreshSubject>
  publishLocal(
    subject: NativeKnownCredentialSubject,
    patch: NativeAccountMetadataPatch,
  ): Promise<boolean>
  publishApi(
    subject: NativeApiSubject,
    patch: { lastUsed: number },
  ): Promise<boolean>
  resetBackoff(
    routeId: string,
    fence: NativeRefreshSubject | NativeCustodyReceipt,
    kind?: 'refresh' | 'quota' | 'all',
  ): Promise<boolean>
  getOrCreateAuthLineage(
    routeId: string,
    fence: NativeKnownCredentialSubject | NativeCustodyReceipt,
  ): Promise<string | undefined>
  incrementPrimeUsage(
    routeId: string,
    fence: NativeKnownCredentialSubject | NativeCustodyReceipt,
    delta?: PrimeUsageDelta,
  ): Promise<boolean>
  /** `purpose` applies to vault accounts only; local accounts always poll. */
  fetchQuota(
    routeId: string,
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
    dispatch?: QuotaRequestDispatch,
    purpose?: NativeVaultQuotaPurpose,
  ): Promise<OAuthQuotaSnapshot>
  fetchProfile(
    routeId: string,
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
  ): Promise<OAuthAccountProfile>
  /** Like fetchProfile, but returns before the profile is saved; see NativeDisplayProfile. */
  fetchProfileForDisplay(
    routeId: string,
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
  ): Promise<NativeDisplayProfile>
  close(): void | Promise<void>
  getSettingsPath(): Promise<string>
}

const sharedAccounts = new NativeRuntimeRegistry<NativeAccountRuntime>()

/** Host instances own leases, while stores and the vault connection live until the last release. */
export function acquireNativeAccountRuntime(
  options: NativeAccountRuntimeOptions,
): NativeAccountRuntime {
  const key = JSON.stringify([
    nativeVaultRuntimeKey({
      ...options.vault,
      paths: options.paths,
      host: options.host,
    }),
    ...[
      options.beforePoolWrite,
      options.local?.refreshToken,
      options.local?.resolveIdentity,
      options.local?.failurePolicy,
      options.local?.now,
      options.local?.onLockEvent,
    ].map(nativeRuntimeOptionIdentity),
  ])
  const { use, close } = sharedAccounts.acquire(key, () =>
    createNativeAccountRuntime(options),
  )
  const vault = leaseNativeVaultRuntime(() => use().vault, close)
  const quotaObservations = use().quotaObservations
  const onLockEvent = use().onLockEvent
  const relocationGuard = use().relocationGuard
  const drainRoutingPublications = use().drainRoutingPublications
  const drainQuotaPublications = use().drainQuotaPublications
  return {
    onLockEvent,
    relocationGuard,
    vault,
    quotaObservations,
    drainQuotaPublications,
    drainRoutingPublications,
    getRelayConfig: () => use().getRelayConfig(),
    getSettingsPath: () => use().getSettingsPath(),
    updateRelay: (patch) => use().updateRelay(patch),
    read: () => use().read(),
    authorizeLocal: (id, request) => use().authorizeLocal(id, request),
    authorizeApi: (id, signal) => use().authorizeApi(id, signal),
    authorizeVault: (id, signal) => use().authorizeVault(id, signal),
    loginOAuth: (input) => use().loginOAuth(input),
    putAccount: (input) => use().putAccount(input),
    addApi: (input) => use().addApi(input),
    updateSettings: (mutator) => use().updateSettings(mutator),
    setLoggingLevel: (level) => use().setLoggingLevel(level),
    setEnabled: (id, enabled) => use().setEnabled(id, enabled),
    remove: (id) => use().remove(id),
    reorder: (ids, moved) => use().reorder(ids, moved),
    captureLocalSubject: (id) => use().captureLocalSubject(id),
    publishLocal: (subject, patch) => use().publishLocal(subject, patch),
    publishApi: (subject, patch) => use().publishApi(subject, patch),
    resetBackoff: (id, fence, kind) => use().resetBackoff(id, fence, kind),
    getOrCreateAuthLineage: (id, fence) =>
      use().getOrCreateAuthLineage(id, fence),
    incrementPrimeUsage: (id, fence, delta) =>
      use().incrementPrimeUsage(id, fence, delta),
    fetchQuota: (id, transport, signal, dispatch, purpose) =>
      use().fetchQuota(id, transport, signal, dispatch, purpose),
    fetchProfile: (id, transport, signal) =>
      use().fetchProfile(id, transport, signal),
    fetchProfileForDisplay: (id, transport, signal) =>
      use().fetchProfileForDisplay(id, transport, signal),
    close: () => {
      const closing = vault.close()
      return Promise.all([
        closing,
        drainQuotaPublications(),
        drainRoutingPublications(),
      ]).then(() => {})
    },
  }
}

export type NativeQuotaPolicyLimit =
  | 'quota-floor'
  | 'killswitch'
  | 'model-scoped'

export type NativeAccountPolicy = NativeLocalExternalPolicy & {
  quotaPolicyLimits?: readonly NativeQuotaPolicyLimit[]
}

/** Evaluate quota and killswitch policy for this caller's model, outside shared credential refresh work. */
export function nativeAccountPolicy(
  account: NativeAccountView,
  snapshot: NativeAccountSnapshot,
  modelId?: string,
): NativeAccountPolicy {
  if (!nativeAccountCanServe(account))
    return { status: 'blocked', reason: 'account-disabled' }
  const quotaPolicyLimits: NativeQuotaPolicyLimit[] = []
  if (!quotaSnapshotPassesPolicy(account.quota, snapshot.policyStorage))
    quotaPolicyLimits.push('quota-floor')
  if (!quotaSnapshotPassesModelScope(account.quota, modelId))
    quotaPolicyLimits.push('model-scoped')
  if (
    !killswitchPassesPolicy(
      account.quota,
      snapshot.policyStorage,
      account.id === 'main' ? undefined : account.id,
      modelId,
    )
  )
    quotaPolicyLimits.push('killswitch')
  if (quotaPolicyLimits.length)
    return { status: 'blocked', reason: 'quota-ineligible', quotaPolicyLimits }
  return { status: 'allowed' }
}

/** The local migration journal records completed transfer from host credentials and sidecars to the credential pool. Local use refuses without that record. Host vault enrollment instead selects independent settings and metadata, leaving local credentials, journal and metadata untouched. */
export function createNativeAccountRuntime(
  options: NativeAccountRuntimeOptions,
): NativeAccountRuntime {
  const paths = Object.freeze({ ...options.paths })
  const onLockEvent = nativeLockObserver(
    options.local?.onLockEvent ?? options.vault?.onLockEvent,
  )
  const withLock = observeNativeLocks(() => acquireLock, onLockEvent)
  const now = options.local?.now ?? options.vault?.now ?? Date.now
  const env = { ...(options.vault?.env ?? process.env) }
  const vaultPaths = nativeVaultPaths(paths)
  const relocation = nativeRelocationGuard(paths)
  // A state-home process stops serving once its dataset is in conflict; a
  // legacy process keeps exactly the checks it had before.
  const servesStateHome = stateLayoutOfPaths(paths).kind === 'state-home'
  const routingSeed: NativeVaultRoutingSeed = {
    legacyConfig: paths.legacyConfig,
    roster: vaultPaths.roster,
  }
  const vaultRouter = new StickySessionRouter({
    path: vaultPaths.routing,
    vaultSeed: routingSeed,
    onLockEvent,
    now,
    relocationGuard: relocation,
  })
  let settingsBootstrap: Promise<unknown> | undefined
  const vaultStore = createNativePoolStore({
    paths: vaultPaths,
    quota: nativeQuotaCodec,
    now,
    onLockEvent: options.local?.onLockEvent,
    onStep: async (point) => {
      if (point === 'before-config-write' || point === 'before-state-write') {
        // Common-auth calls this under the store locks, which a mover holds
        // while it replaces the runtime files with tombstones.
        await relocation.assertNotRelocated()
        await requireMode('claustrum')
      }
    },
  })
  const shutdown = new AbortController()
  let closing: Promise<void> | undefined
  const quotaPublications = createNativeUsagePublisher('quota')
  const metadataPublications = acquireNativeLocalPublisher(paths.runtime)
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    now,
    onLockEvent: options.local?.onLockEvent,
    onStep: async (point) => {
      if (point === 'before-config-write' || point === 'before-state-write') {
        if (servesStateHome) await relocation.assertNotRelocated()
        if (options.beforePoolWrite) {
          await localAuthority()
          await options.beforePoolWrite()
        }
        await localAuthority()
      }
    },
  })
  const vault = acquireNativeVaultRuntime({
    ...options.vault,
    paths,
    host: options.host,
    onLockEvent,
  })
  function check(signal?: AbortSignal) {
    if (shutdown.signal.aborted) throw new NativeCustodyError('closed')
    signal?.throwIfAborted()
  }
  let localRouting: { destination: string; source: string } | undefined
  async function authority(signal?: AbortSignal) {
    check(signal)
    if (servesStateHome) await relocation.assertNotRelocated()
    let mode = await readNativeEnrollmentMode(options.host, env)
    if (mode === 'local') {
      // Reuse the authority read rather than opening the journal again for routing.
      const journal = await requireNativePoolAuthority(paths)
      const destination = resolveLocalRoutingDestination(
        options.host,
        paths,
        env,
      )
      localRouting =
        journal.kind === 'empty-init'
          ? { source: destination, destination }
          : journal.routingPaths
      // Enrollment can land while the local journal is being read.
      mode = await readNativeEnrollmentMode(options.host, env)
    }
    check(signal)
    return mode
  }
  async function requireMode(
    mode: 'local' | 'claustrum',
    signal?: AbortSignal,
  ) {
    if ((await authority(signal)) !== mode)
      throw new NativeCustodyError('route-unavailable')
  }
  async function localAuthority(signal?: AbortSignal) {
    await requireMode('local', signal)
  }
  async function selectedStorage() {
    const mode = await authority()
    return {
      mode,
      paths: mode === 'claustrum' ? vaultPaths : paths,
      store: mode === 'claustrum' ? vaultStore : store,
    }
  }
  async function poolRow(id: string) {
    const read = await store.read()
    if (read.status !== 'ready')
      throw new NativeRuntimeError('publication-refused')
    return read.rows.find((row) => row.id === id)
  }
  async function physicalId(id: string): Promise<string> {
    if (id !== 'main') return id
    const settings = await store.readSettings()
    if (
      settings.status !== 'ready' ||
      typeof settings.settings.mainAccountId !== 'string'
    )
      throw new NativeCustodyError('route-unavailable')
    return settings.settings.mainAccountId
  }
  async function localWrite(
    subject: NativeRefreshSubject | NativeApiSubject,
    change: (
      entry: NativeRuntimeEntry,
      previous?: NativeRuntimeEntry,
    ) => NativeRuntimeEntry,
    exactAccess: boolean | 'binding' = true,
  ): Promise<boolean> {
    if ((await authority()) !== 'local') return false
    const binding = subject.binding
    const matches = async () => {
      const row = await poolRow(binding.rowId)
      if (
        !row ||
        !nativeLocalPoolBindingMatches(binding, paths, row) ||
        row.stamp !== 'bound' ||
        !row.credential
      )
        return false
      if (exactAccess === 'binding')
        return row.credential.type === ('kind' in subject ? 'api' : 'oauth')
      if ('kind' in subject)
        return (
          row.credential.type === 'api' &&
          fingerprintOf(row.credential) === subject.credentialFingerprint &&
          row.credential.baseURL === subject.baseURL &&
          row.credential.authHeader === subject.authHeader
        )
      if (
        row.credential.type !== 'oauth' ||
        fingerprintOf(row.credential) !== subject.credentialFingerprint
      )
        return false
      return (
        !exactAccess ||
        nativeLocalCredentialValidationMatches(subject, binding, row.credential)
      )
    }
    const [config, state] = nativePoolStoreLocks(paths)
    try {
      return await withLock(
        config.path,
        {
          ...POOL_LOCK_DEFAULTS,
          name: config.name,
          onLockEvent: options.local?.onLockEvent,
        },
        async (configLease) =>
          withLock(
            state.path,
            {
              ...POOL_LOCK_DEFAULTS,
              name: state.name,
              onLockEvent: options.local?.onLockEvent,
            },
            async (stateLease) => {
              if (!(await matches())) return false
              await updateNativeRuntime(
                paths.runtime,
                paths.storageId,
                (current) => {
                  const old = current.accounts[binding.rowId]
                  const previous = old?.binding
                  const same =
                    previous?.kind === 'local' &&
                    previous.rowId === binding.rowId &&
                    previous.identity === binding.identity &&
                    previous.credentialEpoch === binding.credentialEpoch
                  current.accounts[binding.rowId] = change(
                    same && old ? old : { binding },
                    old,
                  )
                  return current
                },
                {
                  onLockEvent: options.local?.onLockEvent,
                  beforeRename: async () => {
                    if (!(await matches()))
                      throw new NativeRuntimeError('publication-refused')
                    await configLease.assertOwned()
                    await stateLease.assertOwned()
                    // Binding and lease checks yield; custody must be checked last.
                    await localAuthority()
                  },
                  beforePublish: () => localAuthority(),
                },
              )
              return true
            },
          ),
      )
    } catch (error) {
      if (
        (error instanceof NativeRuntimeError &&
          error.code === 'runtime-conflict') ||
        (error instanceof NativeCustodyError &&
          error.code === 'route-unavailable')
      )
        return false
      throw error
    }
  }
  // Advisory metadata owns only the runtime lock. The credential initialization
  // and refresh paths retain their existing pool/custody leases.
  async function localMetadataMatches(
    subject: NativeRefreshSubject | NativeApiSubject,
  ): Promise<boolean> {
    const binding = subject.binding
    const row = await poolRow(binding.rowId)
    if (
      row?.stamp !== 'bound' ||
      !row.credential ||
      !nativeLocalPoolBindingMatches(binding, paths, row)
    )
      return false
    if ('kind' in subject)
      return (
        row.credential.type === 'api' &&
        fingerprintOf(row.credential) === subject.credentialFingerprint &&
        row.credential.baseURL === subject.baseURL &&
        row.credential.authHeader === subject.authHeader
      )
    return (
      row.credential.type === 'oauth' &&
      fingerprintOf(row.credential) === subject.credentialFingerprint &&
      nativeLocalCredentialValidationMatches(subject, binding, row.credential)
    )
  }
  async function localMetadataWrite(
    subject: NativeRefreshSubject | NativeApiSubject,
    change: (entry: NativeRuntimeEntry) => NativeRuntimeEntry,
  ): Promise<boolean> {
    const binding = subject.binding
    if ((await authority()) !== 'local') return false
    const matches = await localMetadataMatches(subject)
    await localAuthority()
    if (!matches) return false
    try {
      await updateNativeRuntime(
        paths.runtime,
        paths.storageId,
        (current) => {
          const old = current.accounts[binding.rowId]
          const previous = old?.binding
          const same =
            previous?.kind === 'local' &&
            previous.rowId === binding.rowId &&
            previous.identity === binding.identity &&
            previous.credentialEpoch === binding.credentialEpoch
          current.accounts[binding.rowId] = change(
            same && old ? old : { binding },
          )
          return current
        },
        {
          onLockEvent: options.local?.onLockEvent,
          beforeRename: async () => {
            if (!(await localMetadataMatches(subject)))
              throw new NativeRuntimeError('publication-refused')
            await localAuthority()
          },
          beforePublish: () => localAuthority(),
        },
      )
      if ((await authority()) !== 'local')
        throw new NativeRuntimeError('publication-refused')
      return true
    } catch (error) {
      if (
        error instanceof NativeRuntimeError &&
        (error.code === 'runtime-conflict' ||
          error.code === 'publication-refused')
      ) {
        // The runtime writer wraps hook failures; custody must be checked again
        // after that await before an advisory refusal can resolve normally.
        if ((await authority()) !== 'local') throw error
        return false
      }
      throw error
    }
  }
  async function initializeCredentialEpoch(id: string) {
    const row = await poolRow(id)
    if (!row?.credential || row.credentialEpoch === undefined)
      throw new NativeRuntimeError('publication-refused')
    const binding: NativeLocalPoolBinding = {
      kind: 'local',
      storageId: paths.storageId,
      rowId: row.id,
      credentialEpoch: row.credentialEpoch,
      ...(row.identity !== undefined ? { identity: row.identity } : {}),
    }
    const subject: NativeRefreshSubject | NativeApiSubject =
      row.credential.type === 'api'
        ? {
            kind: 'api',
            binding,
            credentialFingerprint: fingerprintOf(row.credential),
            baseURL: row.credential.baseURL,
            authHeader: row.credential.authHeader,
          }
        : {
            binding,
            credentialFingerprint: fingerprintOf(row.credential),
            version: {},
          }
    const kept = await localWrite(
      subject,
      (entry, previous) => {
        const old = previous?.binding
        if (
          old?.kind === 'local' &&
          old.credentialEpoch === binding.credentialEpoch &&
          old.identity === binding.identity
        )
          return entry
        // A new credentialEpoch identifies replacement credentials, not an ordinary
        // token refresh. Discard old identity validation and token backoff. Give OAuth
        // a new Prime deduplication key so a previous credential's quota-start claim
        // cannot suppress the replacement's request. Retain counters and profile
        // only for the same account UUID.
        const sameAccount =
          old?.kind === 'local' &&
          old.rowId === binding.rowId &&
          binding.identity !== undefined &&
          old.identity === binding.identity
        const next: NativeRuntimeEntry = {
          binding,
          ...(row.credential?.type === 'oauth'
            ? { authLineageId: randomUUID() }
            : {}),
        }
        if (sameAccount && previous) {
          for (const key of [
            'prime',
            'profile',
            'lastUsed',
            'lastQuotaRefreshError',
            'quotaErrorClearedAt',
            'quotaErrorGeneration',
          ] as const) {
            if (previous[key] !== undefined)
              Object.assign(next, { [key]: previous[key] })
          }
        }
        return next
      },
      'binding',
    )
    if (!kept) throw new NativeRuntimeError('publication-refused')
  }
  /**
   * One read of the selected pool: the account projection, plus the rows and
   * settings it was projected from.
   */
  async function readView() {
    const mode = await authority()
    if (mode === 'claustrum') {
      // Load legacy routing preferences before deciding which account receives
      // the first request. A status read may create vault settings; it never
      // fetches credentials.
      settingsBootstrap ??= vault.initializeSettings().catch((error) => {
        settingsBootstrap = undefined
        throw error
      })
      await settingsBootstrap
    }
    const selectedPaths = mode === 'claustrum' ? vaultPaths : paths
    const selectedStore = mode === 'claustrum' ? vaultStore : store
    const [read, settings, metadata] = await Promise.all([
      selectedStore.read(),
      selectedStore.readSettings(),
      readNativeRuntime(selectedPaths.runtime, selectedPaths.storageId),
    ])
    if (read.status !== 'ready' || settings.status !== 'ready')
      throw new NativeRuntimeError('publication-refused')
    // Status reads use stored account metadata without fetching tokens or
    // requesting vault access. Refresh, or first authorization with no stored
    // account list, discovers authorized vault accounts. Only offline setup
    // may enroll the host and request its grant.
    const roster = mode === 'claustrum' ? await vault.read() : undefined
    check()
    const snapshot = projectNativeAccountViews({
      paths: { ...paths, ...selectedPaths },
      rows: read.rows,
      settings: {
        ...settings.settings,
        claustrum: {
          ...(settings.settings.claustrum as
            | Record<string, unknown>
            | undefined),
          mode,
        },
      },
      runtime: metadata.status === 'ready' ? metadata.state : undefined,
      roster,
    })
    for (const account of snapshot.accounts) {
      const lineage =
        mode === 'local'
          ? nativeLocalQuotaLineage(account.binding)
          : vault.quotaLineage(
              account.id,
              account.credentialId,
              account.accountIdentity,
            )
      const pending = vault.quotaObservations.quota(
        lineage,
        account.accountIdentity,
        account.quota,
        snapshot.policyStorage,
        now(),
      )
      if (!pending) continue
      account.quota = pending.quota
      if (pending.clearAt) {
        account.quotaErrorClearedAt = Math.max(
          account.quotaErrorClearedAt ?? 0,
          pending.clearAt,
        )
        if (
          (account.lastQuotaRefreshError?.checkedAt ?? Infinity) <=
          account.quotaErrorClearedAt
        )
          delete account.lastQuotaRefreshError
      }
      if (account.id === 'main')
        snapshot.policyStorage.quota = {
          ...snapshot.policyStorage.quota,
          mainQuota: account.quota,
          mainQuotaCheckedAt: account.quota.checkedAt,
          mainQuotaErrorClearedAt: account.quotaErrorClearedAt,
          mainLastQuotaApiError: account.lastQuotaRefreshError,
        }
      else {
        const projected = snapshot.policyStorage.accounts.find(
          (row) => row.id === account.id,
        )
        if (projected?.type === 'oauth') {
          projected.quota = account.quota
          projected.lastQuotaRefreshError = account.lastQuotaRefreshError
        }
      }
    }
    if (mode === 'claustrum') {
      routingSeed.mainRouteId =
        typeof settings.settings.mainAccountId === 'string'
          ? settings.settings.mainAccountId
          : undefined
      await vaultRouter.prepareLegacySeed(roster ?? null)
      snapshot.routingPath = vaultPaths.routing
      snapshot.routingSeed = { ...routingSeed }
    } else if (localRouting) {
      snapshot.routingPath = localRouting.destination
      if (localRouting.source !== localRouting.destination)
        snapshot.routingRecoveryPath = localRouting.source
    }
    return {
      snapshot,
      rows: read.rows,
      settings: settings.settings,
      runtime: metadata.status === 'ready' ? metadata.state : undefined,
    }
  }
  // The rows, settings and runtime metadata each snapshot returned by read()
  // was projected from, so authorization can inspect a row exactly as that
  // read saw it without reading the pool files again.
  const projectedFrom = new WeakMap<
    NativeAccountSnapshot,
    {
      rows: readonly PoolRow[]
      settings: Record<string, unknown>
      runtime: NativeRuntimeState | undefined
    }
  >()
  function awaitsTornWrite(snapshot: NativeAccountSnapshot, routeId: string) {
    const source = projectedFrom.get(snapshot)
    return (
      source !== undefined &&
      nativeLocalRouteAwaitsTornWrite(
        paths,
        source.rows,
        source.settings,
        routeId,
        source.runtime,
      )
    )
  }
  const runtime: NativeAccountRuntime = {
    onLockEvent,
    relocationGuard: relocation,
    vault,
    quotaObservations: vault.quotaObservations,
    drainQuotaPublications: async () => {
      await vault.quotaObservations.drain()
      await Promise.all([
        quotaPublications.drain(),
        metadataPublications.drain(),
      ])
    },
    drainRoutingPublications: () => vaultRouter.drain(),
    async getRelayConfig() {
      const { mode, paths, store } = await selectedStorage()
      // Both files are atomically published, but a reader can cross a relay
      // change between reading its URL and private token. Never send that torn
      // pair: all hosts retry a mismatched generation briefly, then refuse
      // locally without dispatch or direct fallback. Two unstamped files are
      // legacy data; a mixed stamped/unstamped pair must also wait for agreement.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 10))
        const settings = await store.readSettings()
        if (settings.status !== 'ready')
          throw new NativeRuntimeError('publication-refused')
        const flags = relayFlags(settings.settings.relay)
        const generation = relayGeneration(settings.settings.relay)
        const read = await readNativeRuntime(paths.runtime, paths.storageId)
        await requireMode(mode)
        const state = read.status === 'ready' ? read.state : undefined
        if (generation !== state?.relayGeneration) continue
        const token = state?.relay?.token
        if (!flags.enabled || !flags.url || !token) return null
        return { ...flags, token }
      }
      throw new NativeRuntimeError('relay-inconsistent')
    },
    async updateRelay(input) {
      const patch = captureNativePlainData(input) as NativeRelayUpdate
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.keys(patch).some(
          (key) =>
            ![
              'enabled',
              'url',
              'token',
              'fallbackToDirect',
              'transport',
            ].includes(key),
        )
      )
        throw new NativeRuntimeError('publication-refused')
      for (const key of ['enabled', 'fallbackToDirect'] as const)
        if (patch[key] !== undefined && typeof patch[key] !== 'boolean')
          throw new NativeRuntimeError('publication-refused')
      if (patch.url !== undefined && typeof patch.url !== 'string')
        throw new NativeRuntimeError('publication-refused')
      if (
        patch.transport !== undefined &&
        !['http', 'websocket'].includes(patch.transport)
      )
        throw new NativeRuntimeError('publication-refused')
      if (
        patch.token !== undefined &&
        patch.token !== null &&
        (typeof patch.token !== 'string' ||
          !patch.token.trim() ||
          /\p{Cc}/u.test(patch.token))
      )
        throw new NativeRuntimeError('publication-refused')
      const { mode, paths, store } = await selectedStorage()
      await withLock(
        paths.config,
        { ...POOL_LOCK_DEFAULTS, name: 'native-relay' },
        async (lease) => {
          const read = await store.readSettings()
          if (read.status !== 'ready')
            throw new NativeRuntimeError('publication-refused')
          const previous = relayFlags(read.settings.relay)
          const previousGeneration = relayGeneration(read.settings.relay)
          const generation = randomUUID()
          const metadata = await readNativeRuntime(
            paths.runtime,
            paths.storageId,
          )
          const token =
            patch.token === undefined
              ? metadata.status === 'ready'
                ? metadata.state.relay?.token
                : undefined
              : patch.token?.trim()
          const next = relayFlags({
            ...previous,
            ...patch,
            enabled:
              patch.token === null
                ? false
                : (patch.enabled ?? previous.enabled),
          })
          if (next.enabled && (!next.url || !token))
            throw new NativeRuntimeError('publication-refused')
          async function writeFlags(
            flags: Omit<RelayConfig, 'token'>,
            stamp: string | undefined,
          ) {
            await store.updateSettings(async (settings) => {
              await requireMode(mode)
              await lease.assertOwned()
              settings.relay = {
                ...flags,
                ...(stamp === undefined ? {} : { generation: stamp }),
              }
            })
          }
          // Disable with the old stamp first. If publication stops before the
          // runtime stamp changes, readers can still go direct; after it changes,
          // a missing final settings write makes readers refuse locally instead.
          // Writers stay serialized, including when a token is kept or removed.
          // Recheck custody and lease ownership before each save.
          await writeFlags({ ...previous, enabled: false }, previousGeneration)
          await updateNativeRuntime(
            paths.runtime,
            paths.storageId,
            (current) => {
              if (token) current.relay = { token }
              else delete current.relay
              current.relayGeneration = generation
              return current
            },
            {
              beforeRename: async () => {
                await requireMode(mode)
                await lease.assertOwned()
              },
            },
          )
          await writeFlags(next, generation)
        },
      )
    },
    async getSettingsPath() {
      return (await selectedStorage()).paths.config
    },
    async read() {
      const view = await readView()
      projectedFrom.set(view.snapshot, view)
      return view.snapshot
    },
    async authorizeLocal(routeId, request = {}) {
      await authority(request.signal)
      let snapshot = await runtime.read()
      let account = snapshot.accounts.find((row) => row.id === routeId)
      if (snapshot.mode !== 'local')
        return { status: 'refused', reason: 'custody-mode', persisted: false }
      if (!account?.binding && awaitsTornWrite(snapshot, routeId)) {
        // The row is unavailable only because another writer is between its
        // state-file and config-file writes. Wait for that write once, then
        // read again. Refusing instead would let the host send the request
        // through a different account than the one it chose.
        logger.debug('native-auth', 'waiting for an account write to finish', {
          phase: 'waiting',
        })
        const joined = await joinNativePoolWrite(
          paths,
          request.signal
            ? [shutdown.signal, request.signal]
            : [shutdown.signal],
          () => check(request.signal),
          onLockEvent,
        )
        if (joined === 'deadline') {
          logger.warn('native-auth', 'account write did not finish in time', {
            outcome: 'deadline',
          })
          throw new NativeTransientAccountError()
        }
        snapshot = await runtime.read()
        account = snapshot.accounts.find((row) => row.id === routeId)
        if (snapshot.mode !== 'local')
          return { status: 'refused', reason: 'custody-mode', persisted: false }
        if (!account?.binding && awaitsTornWrite(snapshot, routeId)) {
          logger.warn('native-auth', 'account write is still unfinished', {
            outcome: 'still-torn',
          })
          throw new NativeTransientAccountError()
        }
        logger.debug('native-auth', 'account write finished', {
          outcome: 'joined',
        })
      }
      if (
        !account?.binding ||
        account.source !== 'local' ||
        account.type !== 'oauth'
      )
        return { status: 'refused', reason: 'row-ineligible', persisted: false }
      if (account.state === 'unsupported-access')
        return {
          status: 'refused',
          reason: 'unsupported-access',
          persisted: false,
        }
      const metadata = await readNativeRuntime(paths.runtime, paths.storageId)
      const previous =
        metadata.status === 'ready'
          ? metadata.state.accounts[account.binding.rowId]?.binding
          : undefined
      if (
        previous?.kind === 'local' &&
        previous.credentialEpoch < account.binding.credentialEpoch
      ) {
        // If runtime metadata has an older credentialEpoch, login stopped after
        // storing the new pool credentials. Record their runtime binding
        // without treating replacement credentials as already validated.
        await initializeCredentialEpoch(account.binding.rowId)
        snapshot = await runtime.read()
        account = snapshot.accounts.find((row) => row.id === routeId)
        if (!account?.binding)
          return {
            status: 'refused',
            reason: 'row-ineligible',
            persisted: false,
          }
      }
      const baseGate = (
        row: NativeAccountView | undefined,
        current: NativeAccountSnapshot,
      ): NativeLocalExternalPolicy => {
        if (current.mode !== 'local')
          return { status: 'blocked', reason: 'local-mode-unavailable' }
        if (!row || !nativeAccountCanServe(row))
          return { status: 'blocked', reason: 'account-disabled' }
        return { status: 'allowed' }
      }
      const requestGate = (
        row: NativeAccountView | undefined,
        current: NativeAccountSnapshot,
      ): NativeLocalExternalPolicy => {
        const base = baseGate(row, current)
        return base.status === 'allowed' && row
          ? (request.policy?.(row, current) ?? base)
          : base
      }
      if (requestGate(account, snapshot).status === 'blocked')
        return {
          status: 'refused',
          reason: 'quota-ineligible',
          persisted: false,
        }
      // Each caller evaluates its own model's quota/killswitch gate before and
      // after recovery. A joining caller must not inherit another caller's model
      // refusal, so only mode/account gates enter the shared refresh job.
      const service = createNativeLocalCredentialService({
        paths,
        ...options.local,
        now,
        publicationGuard: async (event) => {
          // An exchange has already consumed the predecessor. Keep its committed
          // successor recoverable even if host enrollment lands before completion.
          if (
            event.status === 'persisted' ||
            (event.status === 'failed' &&
              event.persisted &&
              event.committed !== undefined)
          )
            return true
          try {
            return (
              (await readNativeEnrollmentMode(options.host, env)) === 'local'
            )
          } catch {
            // Unknown custody cannot authorize a local metadata write.
            return false
          }
        },
        externalPolicy: () => baseGate(account, snapshot),
        failurePolicy:
          options.local?.failurePolicy ??
          ((input) => {
            const failure =
              input.observation.status === 'failed'
                ? input.observation.failure
                : undefined
            const error = Object.assign(
              new Error(
                failure?.classification === 'invalid-grant'
                  ? 'invalid_grant'
                  : 'Local refresh failed',
              ),
              {
                status: failure?.status,
                retryAfter: failure?.retryAfter,
                ...(failure?.classification === 'transient' &&
                failure.status === undefined
                  ? { code: 'ECONNRESET' }
                  : {}),
              },
            )
            const policy = buildRefreshOperationError({
              error,
              now: now(),
              accountIdentity: input.attribution.subject.binding.identity,
              previous: {
                message: 'Local refresh failed',
                checkedAt: now(),
                accountIdentity: input.attribution.subject.binding.identity,
                retryCount: Math.max(0, input.observation.attempt - 1),
              },
            })
            // The coordinator owns up to three physical attempts. Recording
            // a deadline after its first transient failure would block its own
            // next attempt. A 429 or permanent error starts backoff immediately.
            const retrying =
              input.observation.status === 'failed' &&
              failure?.kind === 'provider' &&
              failure.classification === 'transient' &&
              failure.status !== 429 &&
              !input.observation.persisted &&
              !input.observation.committed &&
              input.observation.attempt < NATIVE_REFRESH_MAX_ATTEMPTS
            return {
              checkedAt: policy.checkedAt,
              nextRetryAt: retrying ? policy.checkedAt : policy.nextRetryAt,
              retryCount: policy.retryCount,
            }
          }),
      })
      const result = await service.authorize({
        intent: request.intent ?? 'serve',
        mode: 'local',
        binding: account.binding,
        rejectedAccessToken: request.rejectedAccessToken,
        signal: AbortSignal.any([
          shutdown.signal,
          ...(request.signal ? [request.signal] : []),
        ]),
      })
      check(request.signal)
      if (result.status === 'usable') {
        const current = await runtime.read()
        const row = current.accounts.find((row) => row.id === routeId)
        if (
          requestGate(row, current).status === 'blocked' ||
          !row?.binding ||
          row.binding.rowId !== result.binding.rowId ||
          row.binding.credentialEpoch !== result.binding.credentialEpoch ||
          row.binding.identity !== result.binding.identity
        )
          return {
            status: 'refused',
            reason: 'row-ineligible',
            persisted: false,
          }
      }
      return result
    },
    async authorizeApi(routeId, signal) {
      await localAuthority(signal)
      const row = await poolRow(await physicalId(routeId))
      check(signal)
      if (
        !row ||
        !nativeAccountCanServe(row) ||
        !row.candidate ||
        row.stamp !== 'bound' ||
        row.credential?.type !== 'api'
      )
        throw new NativeCustodyError('route-unavailable')
      // Reading the credential yields to other processes. Recheck custody
      // before returning a local key that vault mode would exclude.
      await localAuthority(signal)
      return {
        ...row.credential,
        subject: {
          kind: 'api',
          binding: captureNativeLocalPoolBinding(paths, row),
          credentialFingerprint: fingerprintOf(row.credential),
          baseURL: row.credential.baseURL,
          authHeader: row.credential.authHeader,
        },
      }
    },
    authorizeVault: (id, signal) => {
      check(signal)
      return vault.authorize(id, signal)
    },
    async loginOAuth(input) {
      const snapshot = await runtime.read()
      if (snapshot.mode !== 'local')
        throw new NativeCustodyError('route-unavailable')
      let accountIdentity: string | undefined
      try {
        if (!input.credential.access.startsWith('sk-ant-oat'))
          throw new Error('Unsupported OAuth credential')
        accountIdentity = (
          await (options.local?.resolveIdentity ?? resolveClaudeCodeIdentity)(
            input.credential.access,
            undefined,
            undefined,
          )
        ).accountUuid
        if (!accountIdentity?.trim())
          throw new Error('Missing account identity')
      } catch {
        throw new Error(
          'Claude account identity could not be verified; retry sign-in. No account changes were saved.',
        )
      }
      // Verify the exchanged token before replacing any stored credential.
      // putAccount checks authority and custody again after the lookup awaits.
      // Copy only the three token fields: callers often hold a token-exchange
      // result that carries its own `type` (such as 'success') or other
      // fields, and spreading it would override the 'oauth' type or store
      // fields the pool does not define.
      const { access, refresh, expires } = input.credential
      return runtime.putAccount({
        ...input,
        accountIdentity,
        replace: input.replace ?? true,
        credential: { type: 'oauth', access, refresh, expires },
      })
    },
    async putAccount(input) {
      await localAuthority()
      const snapshot = await runtime.read()
      if (snapshot.mode !== 'local')
        throw new NativeCustodyError('route-unavailable')
      const id =
        input.routeId === 'main'
          ? await physicalId('main').catch(() => randomUUID())
          : input.routeId
      if (
        input.credential.type === 'api' &&
        (input.routeId === 'main' || id === snapshot.settings.mainAccountId)
      )
        throw new NativeCustodyError('route-unavailable')
      const old = await poolRow(id)
      let resultId = id
      // Only an add that wrote a new roster row reports an added account: a
      // replacement, a re-add of a stored secret ('rotated') or the completion
      // of an existing credential-less row ('completed') does not.
      let created = false
      if (input.replace && old) {
        if (!old.credentialEpoch)
          throw new NativeRuntimeError('publication-refused')
        await store.replace(
          id,
          input.credential,
          { identity: input.accountIdentity },
          {
            attribution: {
              credentialEpoch: old.credentialEpoch,
              identity: old.identity,
            },
          },
        )
      } else {
        const added = await store.add({
          id,
          credential: input.credential,
          identity: input.accountIdentity,
          label: input.label,
        })
        resultId = added.id
        created =
          added.outcome === 'added' || added.outcome === 'added-disabled'
      }
      if (input.routeId === 'main')
        await store.updateSettings((settings) => {
          settings.mainAccountId = resultId
        })
      await initializeCredentialEpoch(resultId)
      const next = await runtime.read()
      const row = next.accounts.find((row) => row.binding?.rowId === resultId)
      if (!row) throw new NativeCustodyError('route-unavailable')
      if (created) logCommittedNativeAccountAdded(row)
      return row
    },
    addApi: (input) =>
      runtime.putAccount({
        routeId: input.routeId ?? randomUUID(),
        label: input.label,
        replace: input.replace,
        credential: {
          type: 'api',
          apiKey: input.apiKey,
          baseURL: input.baseURL ?? 'https://api.anthropic.com',
          authHeader: input.authHeader,
        },
      }),
    async updateSettings(mutator) {
      const selected = await selectedStorage()
      // Filled from the copy the committed attempt started from; effects run
      // only after the write has been committed and changed the settings.
      const captured: { before?: NativeSettingsEffectFields } = {}
      const result = await selected.store.updateSettings(async (settings) => {
        function activation(value: Record<string, unknown>) {
          const custody = value.claustrum as Record<string, unknown> | undefined
          return [
            value.mainAccountId,
            custody?.mode,
            custody?.primaryAccount,
            custody?.scopedRoster,
            custody?.rosterView,
            value.relay,
          ]
        }
        const before = JSON.stringify(activation(settings))
        captured.before = captureNativeSettingsEffectFields(settings)
        const result = await mutator(settings)
        const next = captureNativePlainData(result ?? settings) as Record<
          string,
          unknown
        >
        if (JSON.stringify(activation(next)) !== before)
          throw new NativeCustodyError('route-unavailable')
        return next
      })
      if (result.outcome === 'updated' && captured.before)
        applyCommittedNativeSettingsEffects(captured.before, result.settings)
      return result
    },
    async setLoggingLevel(level) {
      // A changed stored level is applied and logged by updateSettings; an
      // unchanged one still brings a different live level in line with it.
      await runtime.updateSettings((settings) => ({
        ...settings,
        logging: {
          ...(settings.logging &&
          typeof settings.logging === 'object' &&
          !Array.isArray(settings.logging)
            ? settings.logging
            : {}),
          level,
        },
      }))
      applyNativeLogLevel(level)
    },
    async setEnabled(routeId, enabled) {
      // The earlier read only chooses the vault or the pool and supplies the
      // label; whether the flag changed is judged under the write's locks.
      const current = await runtime.read()
      const row = current.accounts.find((row) => row.id === routeId)
      const account = { id: routeId, label: row?.label }
      const change = enabled ? 'account enabled' : 'account disabled'
      if (current.mode === 'claustrum') {
        if (row?.source !== 'vault')
          throw new NativeCustodyError('route-unavailable')
        if (await vault.setEnabled(routeId, enabled))
          logCommittedNativeAccountChange(change, account)
        return
      }
      await localAuthority()
      const id = await physicalId(routeId)
      const operation = enabled ? 'enable' : 'disable'
      // Credential-pool enable/disable results identify the account but omit whether
      // its enabled flag changed. Capture that flag immediately before each
      // credential-pool configuration write, while its locks are held.
      // An interrupted credential replacement may need repair before the
      // requested toggle. Use the last captured flag, which the pure reader
      // obtains from the repaired account record, so repair alone is not logged
      // as a toggle. An already-enabled account needs no write or change log.
      const captured: { before?: boolean } = {}
      const transition = createNativePoolStore({
        paths,
        quota: nativeQuotaCodec,
        now,
        onStep: async (step, info) => {
          if (step === 'before-config-write' || step === 'before-state-write')
            await localAuthority()
          if (
            step !== 'before-config-write' ||
            info.operation !== operation ||
            info.rowId !== id
          )
            return
          captured.before = undefined
          try {
            const read = await store.read()
            if (read.status === 'ready')
              captured.before = read.rows.find((row) => row.id === id)?.enabled
          } catch {
            // An unreadable pool leaves the change unknown, so nothing is logged.
          }
          await localAuthority()
        },
      })
      if (enabled) await transition.enable(id)
      else await transition.disable(id, 'user-disabled')
      if (captured.before !== undefined && captured.before !== enabled)
        logCommittedNativeAccountChange(change, account)
    },
    async remove(routeId) {
      await localAuthority()
      const current = await runtime.read()
      if (current.mode !== 'local')
        throw new NativeCustodyError('route-unavailable')
      const row = current.accounts.find((row) => row.id === routeId)
      const removed = await store.remove(await physicalId(routeId))
      if (removed.outcome === 'removed')
        logCommittedNativeAccountChange('account removed', {
          id: routeId,
          label: row?.label,
        })
    },
    async reorder(routeIds, movedRouteId) {
      await localAuthority()
      const snapshot = await runtime.read()
      if (snapshot.mode !== 'local')
        throw new NativeCustodyError('route-unavailable')
      const read = await store.read()
      if (read.status !== 'ready')
        throw new NativeRuntimeError('publication-refused')
      const ids = await Promise.all(routeIds.map(physicalId))
      const main = read.rows.find(
        (row) => row.id === snapshot.settings.mainAccountId,
      )
      if (main && !ids.includes(main.id)) ids.unshift(main.id)
      if ((await store.reorder(ids)).outcome === 'reordered')
        logCommittedNativeAccountChange(
          'account reordered',
          snapshot.accounts.find((row) => row.id === movedRouteId) ?? {
            id: movedRouteId,
          },
        )
    },
    async captureLocalSubject(routeId) {
      await localAuthority()
      const row = await poolRow(await physicalId(routeId))
      if (row?.credential?.type !== 'oauth' || row.stamp !== 'bound')
        throw new NativeCustodyError('route-unavailable')
      const credential = row.credential
      const binding: NativeLocalPoolBinding = {
        kind: 'local',
        storageId: paths.storageId,
        rowId: row.id,
        credentialEpoch: row.credentialEpoch ?? 0,
        ...(row.identity !== undefined ? { identity: row.identity } : {}),
      }
      if (!nativeLocalPoolBindingMatches(binding, paths, row))
        throw new NativeCustodyError('route-unavailable')
      return {
        binding,
        credentialFingerprint: fingerprintOf(credential),
        version: {
          ...(credential.access
            ? { accessFingerprint: tokenFingerprint(credential.access) }
            : {}),
          ...(credential.expires !== undefined
            ? { expires: credential.expires }
            : {}),
          ...(Object.hasOwn(credential, 'lastRefreshedAt')
            ? { lastRefreshedAt: credential.lastRefreshedAt }
            : {}),
        },
      }
    },
    async publishLocal(subject, rawPatch) {
      const captured = captureNativeMetadataPatch(rawPatch)
      const { quota: _quota, ...metadata } = captured
      // Track writes before awaiting admission so close cannot miss an accepted write.
      // Mixed patches share one exact-credential check for both destinations.
      const mixed =
        captured.quota !== undefined && Object.keys(metadata).length > 0
      let admission: Promise<boolean> | undefined
      const admitted = () =>
        (admission ??= (async () => {
          if ((await authority()) !== 'local') return false
          const matches = await localMetadataMatches(subject)
          await localAuthority()
          return matches
        })())
      const key = JSON.stringify(subject)
      const writes: Promise<boolean>[] = []
      if (captured.quota) {
        const quota = captured.quota
        const write = (async () => {
          if (mixed && !(await admitted())) return false
          if ((await authority()) !== 'local') return false
          const row = await poolRow(subject.binding.rowId)
          if (
            row?.stamp !== 'bound' ||
            row.credential?.type !== 'oauth' ||
            !nativeLocalPoolBindingMatches(subject.binding, paths, row) ||
            quota.accountIdentity !== subject.binding.identity
          )
            return false
          await store.recordQuota(
            subject.binding.rowId,
            {
              credentialEpoch: subject.binding.credentialEpoch,
              identity: subject.binding.identity,
            },
            toNativeQuotaMap(quota),
          )
          return true
        })()
        void quotaPublications.observe(write)
        writes.push(write)
      }
      if (Object.keys(metadata).length)
        writes.push(
          metadataPublications.enqueue(
            mixed ? `${key}:mixed` : key,
            metadata,
            async (patch) => {
              if (mixed && !(await admitted())) return false
              return localMetadataWrite(subject, (old) =>
                applyNativeMetadataPatch(old, patch),
              )
            },
          ),
        )
      return (await Promise.all(writes)).every(Boolean)
    },
    publishApi: (subject, patch) =>
      metadataPublications.enqueue(JSON.stringify(subject), patch, (merged) =>
        localMetadataWrite(subject, (old) =>
          applyNativeMetadataPatch(old, merged),
        ),
      ),
    async resetBackoff(routeId, fence, kind = 'all') {
      if ('accessToken' in fence) return vault.resetBackoff(fence, kind)
      if ((await authority()) !== 'local') return false
      if ((await physicalId(routeId)) !== fence.binding.rowId) return false
      return localWrite(
        fence,
        (old) => {
          const clear = Math.max(
            now(),
            old.refreshErrorClearedAt ?? 0,
            old.quotaErrorClearedAt ?? 0,
            old.lastRefreshError?.checkedAt ?? 0,
            old.lastQuotaRefreshError?.checkedAt ?? 0,
          )
          const next = { ...old }
          if (kind !== 'quota') {
            delete next.lastRefreshError
            delete next.validationRetry
            next.refreshErrorClearedAt = clear
          }
          if (kind !== 'refresh') {
            delete next.lastQuotaRefreshError
            next.quotaErrorClearedAt = clear
            next.quotaErrorGeneration = (old.quotaErrorGeneration ?? 0) + 1
          }
          return next
        },
        false,
      )
    },
    async getOrCreateAuthLineage(routeId, fence) {
      if ('accessToken' in fence) return vault.getOrCreateAuthLineage(fence)
      if ((await authority()) !== 'local') return undefined
      if ((await physicalId(routeId)) !== fence.binding.rowId) return undefined
      let lineage: string | undefined
      const kept = await metadataPublications.run(() =>
        localMetadataWrite(fence, (old) => {
          // The entry's epoch/UUID fence changes on replacement, not ordinary token
          // rotation. Keep the account's lineage and counters through refresh.
          lineage = old.authLineageId ?? randomUUID()
          return {
            ...old,
            authLineageId: lineage,
          }
        }),
      )
      return kept ? lineage : undefined
    },
    async incrementPrimeUsage(routeId, fence, delta = {}) {
      if ('accessToken' in fence) return vault.incrementPrimeUsage(fence, delta)
      if ((await authority()) !== 'local') return false
      if ((await physicalId(routeId)) !== fence.binding.rowId) return false
      const captured = primeDelta(delta)
      return metadataPublications.run(() =>
        localMetadataWrite(fence, (old) => ({
          ...old,
          prime: {
            count: (old.prime?.count ?? 0) + 1,
            inputTokens: (old.prime?.inputTokens ?? 0) + captured.inputTokens,
            outputTokens:
              (old.prime?.outputTokens ?? 0) + captured.outputTokens,
            since: old.prime?.since ?? now(),
          },
        })),
      )
    },
    async fetchQuota(routeId, fetchImpl = fetch, signal, dispatch, purpose) {
      const snapshot = await runtime.read()
      if (snapshot.mode === 'claustrum')
        return vault.fetchQuota(routeId, fetchImpl, signal, dispatch, purpose)
      const before = snapshot.accounts.find((row) => row.id === routeId)
      const result = await fetchReading(
        routeId,
        fetchImpl,
        signal,
        (attempt, transport) =>
          fetchOAuthQuotaSnapshot({
            accessToken: attempt.access,
            fetchImpl: transport,
            now,
          }),
        async (error, attempt) => {
          const matched =
            before?.binding &&
            before.binding.rowId === attempt.binding.rowId &&
            before.binding.credentialEpoch ===
              attempt.binding.credentialEpoch &&
            before.binding.identity === attempt.binding.identity
              ? before
              : undefined
          const failure = nativeQuotaFailure(
            error,
            attempt.binding.identity,
            Math.max(now(), (matched?.quotaErrorClearedAt ?? -1) + 1),
            matched?.lastQuotaRefreshError,
          )
          if (failure)
            await runtime.publishLocal(attempt.subject, {
              lastQuotaRefreshError: failure,
            })
        },
        dispatch,
      )
      const quota = {
        ...result.value,
        accountIdentity: result.attempt.binding.identity,
      }
      const matched =
        before?.binding &&
        before.binding.rowId === result.attempt.binding.rowId &&
        before.binding.credentialEpoch ===
          result.attempt.binding.credentialEpoch &&
        before.binding.identity === result.attempt.binding.identity
          ? before
          : undefined
      const quotaErrorClearedAt = Math.max(
        quota.checkedAt ?? now(),
        matched?.quotaErrorClearedAt ?? 0,
        matched?.lastQuotaRefreshError?.checkedAt ?? 0,
      )
      void runtime.quotaObservations.publish(
        routeId,
        {
          lineage: nativeLocalQuotaLineage(result.attempt.subject.binding),
          accountUuid: result.attempt.subject.binding.identity,
          entry: {
            quota,
            checkedAt: quota.checkedAt ?? now(),
            refreshAfter: quota.checkedAt ?? now(),
          },
          generalExhausted: nativePollQuotaGenerallyExhausted(quota),
          quotaErrorClearedAt,
        },
        () =>
          runtime.publishLocal(result.attempt.subject, {
            quota,
            quotaErrorClearedAt,
          }),
      )
      return quota
    },
    async fetchProfile(routeId, fetchImpl = fetch, signal) {
      if ((await runtime.read()).mode === 'claustrum')
        return vault.fetchProfile(routeId, fetchImpl, signal)
      const result = await readLocalProfile(routeId, fetchImpl, signal)
      await runtime.publishLocal(result.attempt.subject, {
        profile: result.value,
      })
      return result.value
    },
    async fetchProfileForDisplay(routeId, fetchImpl = fetch, signal) {
      if ((await runtime.read()).mode === 'claustrum')
        return vault.fetchProfileForDisplay(routeId, fetchImpl, signal)
      const result = await readLocalProfile(routeId, fetchImpl, signal)
      const subject = structuredClone(result.attempt.subject)
      const profile = result.value
      return nativeDisplayProfile(
        profile,
        () => runtime.publishLocal(subject, { profile }),
        async () => {
          if (
            (await runtime.read()).mode !== 'local' ||
            (await physicalId(routeId)) !== subject.binding.rowId
          )
            return false
          const row = await poolRow(subject.binding.rowId)
          return (
            row?.stamp === 'bound' &&
            nativeAccountCanServe(row) &&
            row.credential?.type === 'oauth' &&
            nativeLocalPoolBindingMatches(subject.binding, paths, row) &&
            nativeLocalCredentialValidationMatches(
              subject,
              subject.binding,
              row.credential,
            )
          )
        },
      )
    },
    close() {
      if (closing) return closing
      const draining = runtime.drainQuotaPublications()
      // Release this vault lease synchronously, as callers of the shared
      // registry rely on the last close releasing its consumer immediately.
      const vaultClosing = vault.close()
      closing = Promise.all([draining, vaultRouter.drain(), vaultClosing])
        .finally(() => Promise.all([store.close(), vaultStore.close()]))
        .then(() => {})
        .finally(() => {
          shutdown.abort(new NativeCustodyError('closed'))
          metadataPublications.release()
        })
      return closing
    },
  }
  function readLocalProfile(
    id: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
  ) {
    return fetchReading(id, fetchImpl, signal, (attempt, transport) =>
      fetchOAuthAccountProfile({
        accessToken: attempt.access,
        accountIdentity: attempt.binding.identity,
        fetchImpl: transport,
        now,
        signal,
      }),
    )
  }
  async function fetchReading<T>(
    id: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
    read: (
      attempt: Extract<NativeRefreshResult, { status: 'usable' }>,
      transport: typeof fetch,
    ) => Promise<T>,
    onFailure?: (
      error: unknown,
      attempt: Extract<NativeRefreshResult, { status: 'usable' }>,
    ) => Promise<void>,
    dispatch?: QuotaRequestDispatch,
  ) {
    const combined = AbortSignal.any([
      shutdown.signal,
      ...(signal ? [signal] : []),
    ])
    const first = await runtime.authorizeLocal(id, { signal: combined })
    if (first.status !== 'usable')
      throw new NativeCustodyError('route-unavailable')
    let served = first
    const send = (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const physical = () =>
        fetchImpl(input, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([combined, init.signal])
            : combined,
        })
      if (!dispatch) return physical()
      return dispatch(physical, async () => {
        await localAuthority(combined)
        const row = await poolRow(served.binding.rowId)
        if (
          !row ||
          !nativeAccountCanServe(row) ||
          row.stamp !== 'bound' ||
          row.credential?.type !== 'oauth' ||
          !nativeLocalPoolBindingMatches(served.binding, paths, row) ||
          !nativeLocalCredentialValidationMatches(
            served.subject,
            served.binding,
            row.credential,
          ) ||
          (await physicalId(id)) !== served.binding.rowId
        )
          throw new NativeCustodyError('identity-changed')
        await localAuthority(combined)
      })
    }
    let responseStatus: number | undefined
    const transport: typeof fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        responseStatus = undefined
        let response = await send(input, init)
        responseStatus = response.status
        if (response.status === 401 && !combined.aborted) {
          await response.body?.cancel().catch(() => {})
          check(combined)
          const next = await runtime.authorizeLocal(id, {
            rejectedAccessToken: served.access,
            signal: combined,
          })
          if (
            next.status === 'usable' &&
            next.binding.rowId === served.binding.rowId &&
            next.binding.credentialEpoch === served.binding.credentialEpoch &&
            next.binding.identity === served.binding.identity &&
            next.access !== served.access &&
            next.subject.version.lastRefreshedAt !== undefined &&
            (served.subject.version.lastRefreshedAt === undefined ||
              next.subject.version.lastRefreshedAt >
                served.subject.version.lastRefreshedAt)
          ) {
            served = next
            const headers = new Headers(init?.headers)
            headers.set('authorization', `Bearer ${served.access}`)
            responseStatus = undefined
            response = await send(input, { ...init, headers })
            responseStatus = response.status
          }
        }
        return response
      },
      { preconnect: fetchImpl.preconnect },
    )
    let value: T
    try {
      value = await read(served, transport)
    } catch (error) {
      check(combined)
      const safe =
        error instanceof NativeCustodyError ||
        error instanceof NativeRuntimeError
          ? error
          : nativeAccountReadError(error, responseStatus)
      await onFailure?.(safe, served)
      throw safe
    }
    check(combined)
    return { value, attempt: served }
  }
  return runtime
}

export function primeDelta(delta: PrimeUsageDelta) {
  const inputTokens = delta.inputTokens ?? 0
  const outputTokens = delta.outputTokens ?? 0
  if (
    ![inputTokens, outputTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new NativeRuntimeError('publication-refused')
  return { inputTokens, outputTokens }
}

function relayFlags(input: unknown): Omit<RelayConfig, 'token'> {
  const value =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  const transport = effectiveRelayTransport(value.transport, url)
  if (url) {
    try {
      const parsed = new URL(url)
      if (
        !['https:', 'http:', 'wss:', 'ws:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        (transport === 'http' && !['https:', 'http:'].includes(parsed.protocol))
      )
        throw new Error('invalid endpoint')
    } catch {
      throw new NativeRuntimeError('publication-refused')
    }
  }
  return {
    enabled: value.enabled === true,
    url,
    transport,
    fallbackToDirect: value.fallbackToDirect !== false,
  }
}

function relayGeneration(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return undefined
  const generation = (input as Record<string, unknown>).generation
  if (generation === undefined) return undefined
  if (typeof generation !== 'string' || !generation.trim())
    throw new NativeRuntimeError('relay-inconsistent')
  return generation
}
