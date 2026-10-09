import { randomUUID } from 'node:crypto'
import { mutateVaultRoster } from '@cortexkit/common-auth/claustrum'
import { withLock } from '@cortexkit/common-auth/fs'
import {
  fingerprintOf,
  POOL_LOCK_DEFAULTS,
  type PoolCredential,
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
import type { LogLevel } from './logger.ts'
import {
  applyNativeMetadataPatch,
  captureNativeMetadataPatch,
  captureNativePlainData,
  type NativeAccountMetadataPatch,
  type NativeAccountSnapshot,
  type NativeAccountView,
  nativeAccountReadError,
  nativeQuotaFailure,
  nativeVaultPrimaryPin,
  nativeVaultPrimaryRow,
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
import {
  createNativeLocalCredentialService,
  type NativeLocalCredentialServiceOptions,
} from './native-local-credential-service.ts'
import type { NativeLocalExternalPolicy } from './native-local-runtime-readers.ts'
import { nativeQuotaCodec, toNativeQuotaMap } from './native-quota-codec.ts'
import type {
  NativeKnownCredentialSubject,
  NativeRefreshResult,
  NativeRefreshSubject,
} from './native-refresh-coordinator.ts'
import {
  type NativeRuntimeEntry,
  NativeRuntimeError,
  readNativeRuntime,
  updateNativeRuntime,
} from './native-runtime.ts'
import {
  acquireNativeVaultRuntime,
  type NativeDisplayProfile,
  type NativeVaultRuntime,
  type NativeVaultRuntimeOptions,
  nativeDisplayProfile,
} from './native-vault-runtime.ts'
import { fetchOAuthAccountProfile } from './oauth-profile.ts'
import { requireNativePoolAuthority } from './pool-authority.ts'
import {
  captureNativeLocalPoolBinding,
  type NativeLocalPoolBinding,
  nativeLocalPoolBindingMatches,
} from './pool-binding.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import { createNativePoolStore, nativePoolStoreLocks } from './pool-store.ts'
import type { RelayConfig } from './relay.ts'
import { tokenFingerprint } from './token-fingerprint.ts'

export type {
  NativeAccountMetadataPatch,
  NativeAccountSnapshot,
  NativeAccountView,
} from './native-account-view.ts'

export interface NativeAccountRuntimeOptions {
  paths: NativePoolPaths
  host: 'opencode' | 'pi'
  /** The setup CLI checks that OpenCode and Pi are still stopped before locked credential-file writes. */
  beforePoolWrite?: () => Promise<void>
  local?: Partial<
    Pick<
      NativeLocalCredentialServiceOptions,
      'refreshToken' | 'resolveIdentity' | 'failurePolicy' | 'now'
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
  readonly vault: NativeVaultRuntime
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
  fetchQuota(
    routeId: string,
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
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
  close(): void
}

/** Evaluate quota and killswitch policy for this caller's model, outside shared credential refresh work. */
export function nativeAccountPolicy(
  account: NativeAccountView,
  snapshot: NativeAccountSnapshot,
  modelId?: string,
): NativeLocalExternalPolicy {
  if (!account.enabled) return { status: 'blocked', reason: 'account-disabled' }
  if (
    !quotaSnapshotPassesPolicy(account.quota, snapshot.policyStorage) ||
    !quotaSnapshotPassesModelScope(account.quota, modelId) ||
    !killswitchPassesPolicy(
      account.quota,
      snapshot.policyStorage,
      account.id === 'main' ? undefined : account.id,
      modelId,
    )
  )
    return { status: 'blocked', reason: 'quota-ineligible' }
  return { status: 'allowed' }
}

/** The migration journal records the offline move from host auth and sidecars to the credential pool. Only its committed state permits this service to use the pool and separate runtime metadata. */
export function createNativeAccountRuntime(
  options: NativeAccountRuntimeOptions,
): NativeAccountRuntime {
  const paths = Object.freeze({ ...options.paths })
  const now = options.local?.now ?? options.vault?.now ?? Date.now
  const shutdown = new AbortController()
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    now,
    onStep: options.beforePoolWrite
      ? async (point) => {
          if (point === 'before-config-write' || point === 'before-state-write')
            await options.beforePoolWrite?.()
        }
      : undefined,
  })
  const vault = acquireNativeVaultRuntime({
    ...options.vault,
    paths,
    host: options.host,
  })
  function check(signal?: AbortSignal) {
    if (shutdown.signal.aborted) throw new NativeCustodyError('closed')
    signal?.throwIfAborted()
  }
  async function authority(signal?: AbortSignal) {
    check(signal)
    await requireNativePoolAuthority(paths)
    check(signal)
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
    await authority()
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
        { ...POOL_LOCK_DEFAULTS, name: config.name },
        async (configLease) =>
          withLock(
            state.path,
            { ...POOL_LOCK_DEFAULTS, name: state.name },
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
                  beforeRename: async () => {
                    await authority()
                    if (!(await matches()))
                      throw new NativeRuntimeError('publication-refused')
                    await configLease.assertOwned()
                    await stateLease.assertOwned()
                  },
                },
              )
              return true
            },
          ),
      )
    } catch (error) {
      if (
        error instanceof NativeRuntimeError &&
        error.code === 'runtime-conflict'
      )
        return false
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
        // token refresh. Drop old validation, token backoff and the key that deduplicates
        // Prime requests, so replacement credentials cannot inherit old permission
        // or claims. Retain counters and profile only for the same account UUID.
        const sameAccount =
          old?.kind === 'local' &&
          old.rowId === binding.rowId &&
          binding.identity !== undefined &&
          old.identity === binding.identity
        const next: NativeRuntimeEntry = { binding }
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
  const runtime: NativeAccountRuntime = {
    vault,
    async getRelayConfig() {
      await authority()
      return withLock(
        paths.config,
        { ...POOL_LOCK_DEFAULTS, name: 'native-relay' },
        async (lease) => {
          const settings = await store.readSettings()
          if (settings.status !== 'ready')
            throw new NativeRuntimeError('publication-refused')
          const flags = relayFlags(settings.settings.relay)
          const read = await readNativeRuntime(paths.runtime, paths.storageId)
          const token =
            read.status === 'ready' ? read.state.relay?.token : undefined
          await authority()
          await lease.assertOwned()
          if (!flags.enabled || !flags.url || !token) return null
          return { ...flags, token }
        },
      )
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
      await authority()
      await withLock(
        paths.config,
        { ...POOL_LOCK_DEFAULTS, name: 'native-relay' },
        async (lease) => {
          const read = await store.readSettings()
          if (read.status !== 'ready')
            throw new NativeRuntimeError('publication-refused')
          const previous = relayFlags(read.settings.relay)
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
          async function writeFlags(flags: Omit<RelayConfig, 'token'>) {
            await store.updateSettings(async (settings) => {
              await authority()
              await lease.assertOwned()
              settings.relay = flags
            })
          }
          // Relay flags and its token live in separate files. Disable first so a crash
          // cannot send the new token to the old endpoint. PoolStore checks its
          // config/state locks; immediately before replacing the token file,
          // also verify the lock that serializes relay readers and writers, and that
          // the journal still authorizes using the pool instead of host credentials.
          await writeFlags({ ...previous, enabled: false })
          if (patch.token !== undefined)
            await updateNativeRuntime(
              paths.runtime,
              paths.storageId,
              (current) => {
                if (token) current.relay = { token }
                else delete current.relay
                return current
              },
              {
                beforeRename: async () => {
                  await authority()
                  await lease.assertOwned()
                },
              },
            )
          await writeFlags(next)
        },
      )
    },
    async read() {
      await authority()
      const [read, settings, metadata] = await Promise.all([
        store.read(),
        store.readSettings(),
        readNativeRuntime(paths.runtime, paths.storageId),
      ])
      if (read.status !== 'ready' || settings.status !== 'ready')
        throw new NativeRuntimeError('publication-refused')
      const mode = (
        settings.settings.claustrum as { mode?: unknown } | undefined
      )?.mode
      // Status reads use stored account metadata without fetching tokens or
      // requesting vault access. Refresh, or first authorization with no stored
      // account list, discovers authorized vault accounts. Only offline setup
      // may enroll the host and request its grant.
      const roster = mode === 'claustrum' ? await vault.read() : undefined
      check()
      return projectNativeAccountViews({
        paths,
        rows: read.rows,
        settings: settings.settings,
        runtime: metadata.status === 'ready' ? metadata.state : undefined,
        roster,
      })
    },
    async authorizeLocal(routeId, request = {}) {
      await authority(request.signal)
      let snapshot = await runtime.read()
      let account = snapshot.accounts.find((row) => row.id === routeId)
      if (snapshot.mode !== 'local')
        return { status: 'refused', reason: 'custody-mode', persisted: false }
      if (
        !account?.binding ||
        account.source !== 'local' ||
        account.type !== 'oauth'
      )
        return { status: 'refused', reason: 'row-ineligible', persisted: false }
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
        if (!row?.enabled)
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
            return {
              checkedAt: policy.checkedAt,
              nextRetryAt: policy.nextRetryAt,
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
      await authority(signal)
      const row = await poolRow(await physicalId(routeId))
      check(signal)
      if (
        !row?.enabled ||
        !row.candidate ||
        row.stamp !== 'bound' ||
        row.credential?.type !== 'api'
      )
        throw new NativeCustodyError('route-unavailable')
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
    loginOAuth: (input) =>
      runtime.putAccount({
        ...input,
        replace: input.replace ?? true,
        credential: { type: 'oauth', ...input.credential },
      }),
    async putAccount(input) {
      await authority()
      const snapshot = await runtime.read()
      if (input.credential.type === 'oauth' && snapshot.mode !== 'local')
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
      await authority()
      // Filled from the copy the committed attempt started from; effects run
      // only after the write has been committed and changed the settings.
      const captured: { before?: NativeSettingsEffectFields } = {}
      const result = await store.updateSettings(async (settings) => {
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
      if (row?.source === 'vault') {
        if (await vault.setEnabled(routeId, enabled))
          logCommittedNativeAccountChange(change, account)
        return
      }
      const id = await physicalId(routeId)
      const operation = enabled ? 'enable' : 'disable'
      // common-auth does not report whether enable or disable changed the
      // account's enabled flag. Capture that flag immediately before each
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
        },
      })
      if (enabled) await transition.enable(id)
      else await transition.disable(id, 'user-disabled')
      if (captured.before !== undefined && captured.before !== enabled)
        logCommittedNativeAccountChange(change, account)
    },
    async remove(routeId) {
      const current = await runtime.read()
      const row = current.accounts.find((row) => row.id === routeId)
      const account = { id: routeId, label: row?.label }
      if (row?.source === 'vault') {
        // This call cannot remove an account from the vault. Disable its use
        // by this plugin instead, and log only that committed change.
        if (await vault.setEnabled(routeId, false))
          logCommittedNativeAccountChange('account disabled', account)
        return
      }
      // 'removed' means this call dropped the account's roster row.
      const removed = await store.remove(await physicalId(routeId))
      if (removed.outcome === 'removed')
        logCommittedNativeAccountChange('account removed', account)
    },
    async reorder(routeIds, movedRouteId) {
      await authority()
      const snapshot = await runtime.read()
      const read = await store.read()
      if (read.status !== 'ready')
        throw new NativeRuntimeError('publication-refused')
      const logReordered = () =>
        logCommittedNativeAccountChange(
          'account reordered',
          snapshot.accounts.find((row) => row.id === movedRouteId) ?? {
            id: movedRouteId,
          },
        )
      if (snapshot.mode === 'claustrum') {
        const order = [...routeIds]
        if (
          snapshot.accounts.some((row) => row.id === 'main') &&
          !order.includes('main')
        )
          order.unshift('main')
        if (
          new Set(order).size !== order.length ||
          order.length !== snapshot.accounts.length ||
          order.some((id) => !snapshot.accounts.some((row) => row.id === id))
        )
          throw new NativeCustodyError('invalid-state')
        const rosterReordered = await mutateVaultRoster(
          paths.roster,
          (roster) => {
            if (!roster) throw new NativeCustodyError('route-unavailable')
            const primary = nativeVaultPrimaryRow(
              roster,
              nativeVaultPrimaryPin(snapshot.settings),
            )
            const ids = order
              .filter(
                (id) =>
                  snapshot.accounts.find((row) => row.id === id)?.source ===
                  'vault',
              )
              .map((id) => (id === 'main' ? primary?.routeId : id))
            if (
              ids.length !== roster.rows.length ||
              ids.some((id) => !roster.rows.some((row) => row.routeId === id))
            )
              throw new NativeCustodyError('identity-changed')
            return {
              next: {
                ...roster,
                rows: ids.map((id) => {
                  const row = roster.rows.find((row) => row.routeId === id)
                  if (!row) throw new NativeCustodyError('identity-changed')
                  return row
                }),
              },
              // Compare the requested order with the account rows read under
              // the roster lock, so an unchanged order produces no change log.
              result: ids.some(
                (id, index) => roster.rows[index]?.routeId !== id,
              ),
            }
          },
        )
        // Ordering spans the pool account config and the native vault roster.
        // Their writes are not a two-file atomic transaction: an interruption
        // can leave mixed presentation order, but neither roster loses a member.
        const settingsWrite = await store.updateSettings((settings) => {
          settings.nativeAccountOrder = order
        })
        if (rosterReordered || settingsWrite.outcome === 'updated')
          logReordered()
        return
      }
      const ids = await Promise.all(routeIds.map(physicalId))
      const main = read.rows.find(
        (row) => row.id === snapshot.settings.mainAccountId,
      )
      if (main && !ids.includes(main.id)) ids.unshift(main.id)
      if ((await store.reorder(ids)).outcome === 'reordered') logReordered()
    },
    async captureLocalSubject(routeId) {
      await authority()
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
      const patch = captureNativeMetadataPatch(rawPatch)
      await authority()
      const row = await poolRow(subject.binding.rowId)
      if (
        !row ||
        !nativeLocalCredentialValidationMatches(
          subject,
          subject.binding,
          row.credential,
        )
      )
        return false
      const { quota, ...metadata } = patch
      if (quota) {
        if (quota.accountIdentity !== subject.binding.identity)
          throw new NativeRuntimeError('publication-refused')
        // Pool quota belongs to the account/epoch, not a rotating access token.
        // The public store fences epoch and UUID and merges observation freshness.
        await store.recordQuota(
          subject.binding.rowId,
          {
            credentialEpoch: subject.binding.credentialEpoch,
            identity: subject.binding.identity,
          },
          toNativeQuotaMap(quota),
        )
      }
      return localWrite(subject, (old) =>
        applyNativeMetadataPatch(old, metadata),
      )
    },
    publishApi: (subject, patch) =>
      localWrite(subject, (old) => ({
        ...old,
        lastUsed: Math.max(old.lastUsed ?? 0, patch.lastUsed),
      })),
    async resetBackoff(routeId, fence, kind = 'all') {
      if ('accessToken' in fence) return vault.resetBackoff(fence, kind)
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
      if ((await physicalId(routeId)) !== fence.binding.rowId) return undefined
      let lineage: string | undefined
      const kept = await localWrite(fence, (old) => {
        // The entry's epoch/UUID fence changes on replacement, not ordinary token
        // rotation. Keep the account's lineage and counters through refresh.
        lineage = old.authLineageId ?? randomUUID()
        return {
          ...old,
          authLineageId: lineage,
        }
      })
      return kept ? lineage : undefined
    },
    async incrementPrimeUsage(routeId, fence, delta = {}) {
      if ('accessToken' in fence) return vault.incrementPrimeUsage(fence, delta)
      if ((await physicalId(routeId)) !== fence.binding.rowId) return false
      const captured = primeDelta(delta)
      return localWrite(fence, (old) => ({
        ...old,
        prime: {
          count: (old.prime?.count ?? 0) + 1,
          inputTokens: (old.prime?.inputTokens ?? 0) + captured.inputTokens,
          outputTokens: (old.prime?.outputTokens ?? 0) + captured.outputTokens,
          since: old.prime?.since ?? now(),
        },
      }))
    },
    async fetchQuota(routeId, fetchImpl = fetch, signal) {
      const snapshot = await runtime.read()
      if (snapshot.mode === 'claustrum')
        return vault.fetchQuota(routeId, fetchImpl, signal)
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
      await runtime.publishLocal(result.attempt.subject, {
        quota,
        quotaErrorClearedAt: Math.max(
          quota.checkedAt ?? now(),
          matched?.quotaErrorClearedAt ?? 0,
          matched?.lastQuotaRefreshError?.checkedAt ?? 0,
        ),
      })
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
      return nativeDisplayProfile(result.value, () =>
        runtime.publishLocal(result.attempt.subject, {
          profile: result.value,
        }),
      )
    },
    close() {
      if (!shutdown.signal.aborted) {
        shutdown.abort(new NativeCustodyError('closed'))
        vault.close()
      }
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
  ) {
    const combined = AbortSignal.any([
      shutdown.signal,
      ...(signal ? [signal] : []),
    ])
    const first = await runtime.authorizeLocal(id, { signal: combined })
    if (first.status !== 'usable')
      throw new NativeCustodyError('route-unavailable')
    let served = first
    let responseStatus: number | undefined
    const transport: typeof fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        responseStatus = undefined
        let response = await fetchImpl(input, { ...init, signal: combined })
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
            response = await fetchImpl(input, {
              ...init,
              headers,
              signal: combined,
            })
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
  const transport = value.transport === 'http' ? 'http' : 'websocket'
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
