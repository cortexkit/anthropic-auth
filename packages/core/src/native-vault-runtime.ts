import { randomUUID } from 'node:crypto'
import { ClaustrumClient } from '@cortexkit/claustrum-client'
import {
  acceptVaultRoute,
  declineVaultRoute,
  mutateVaultRoster,
  readVaultRoster,
  refreshVaultRoster,
} from '@cortexkit/common-auth/claustrum'

import {
  fetchOAuthQuotaSnapshot,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  type PrimeUsageDelta,
} from './accounts.ts'
import { resolveClaustrumConnectionPath } from './claustrum.ts'
import {
  applyNativeMetadataPatch,
  captureNativeMetadataPatch,
  captureNativePlainData,
  type NativeAccountMetadataPatch,
  nativeAccountReadError,
  nativeQuotaFailure,
  nativeVaultPrimaryPin,
  nativeVaultPrimaryRow,
} from './native-account-view.ts'
import {
  createNativeCustody,
  type NativeCustodyClient,
  NativeCustodyError,
  type NativeCustodyInventory,
  type NativeCustodyReceipt,
  type NativeCustodyReporterSource,
  type NativeCustodyRetry,
} from './native-custody.ts'
import { nativeQuotaCodec } from './native-quota-codec.ts'
import {
  buildNativeVaultRosterSeed,
  type NativeRosterSeedInput,
  type NativeVaultRosterDocument,
  type NativeVaultRosterSeed,
  validateNativeVaultRosterSeed,
} from './native-roster-seed.ts'
import {
  decodeNativeRuntime,
  type NativeRuntimeEntry,
  NativeRuntimeError,
  type NativeRuntimeState,
  readNativeRuntime,
  updateNativeRuntime,
} from './native-runtime.ts'
import { fetchOAuthAccountProfile } from './oauth-profile.ts'
import { requireNativePoolAuthority } from './pool-authority.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import { createNativePoolStore } from './pool-store.ts'

export interface NativeVaultRuntimeOptions {
  paths: NativePoolPaths
  host: 'opencode' | 'pi'
  connect?: () => Promise<NativeCustodyClient>
  readToken?: () => Promise<{ token: string; token_generation: number }>
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export interface NativeVaultRuntime {
  read(): Promise<NativeVaultRosterDocument | undefined>
  refresh(signal?: AbortSignal): Promise<NativeVaultRosterDocument | undefined>
  authorize(
    routeId: string,
    signal?: AbortSignal,
  ): Promise<NativeCustodyReceipt>
  reportFailure(
    receipt: NativeCustodyReceipt,
    status: number,
    source: NativeCustodyReporterSource,
  ): Promise<void>
  prepareRetry(
    receipt: NativeCustodyReceipt,
    signal?: AbortSignal,
  ): Promise<NativeCustodyRetry>
  publish(
    receipt: NativeCustodyReceipt,
    patch: NativeAccountMetadataPatch,
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
  setEnabled(routeId: string, enabled: boolean): Promise<void>
  resetBackoff(
    receipt: NativeCustodyReceipt,
    kind?: 'refresh' | 'quota' | 'all',
  ): Promise<boolean>
  getOrCreateAuthLineage(
    receipt: NativeCustodyReceipt,
  ): Promise<string | undefined>
  incrementPrimeUsage(
    receipt: NativeCustodyReceipt,
    delta?: PrimeUsageDelta,
  ): Promise<boolean>
  close(): void
}

/** Publish initial account metadata only while the migration controller holds its journal lock and verifies that the host is stopped. */
export async function publishNativeVaultRosterSeed(
  paths: NativePoolPaths,
  input: NativeRosterSeedInput,
  options: { assertOwned?: () => Promise<void> } = {},
): Promise<NativeVaultRosterSeed> {
  const seed = buildNativeVaultRosterSeed(input)
  return mutateVaultRoster(
    paths.roster,
    async (current, lease) => {
      if (current) {
        validateNativeVaultRosterSeed(current, input)
        await options.assertOwned?.()
        return { result: seed }
      }
      await options.assertOwned?.()
      await lease.assertOwned()
      return { next: seed, result: seed }
    },
    { beforePublish: options.assertOwned },
  )
}

/** Bind imported metadata to the vault account list. The migration controller supplies journal-lock and stopped-host checks; this writer owns neither. */
export async function publishNativeVaultRuntimeSeed(
  paths: NativePoolPaths,
  state: NativeRuntimeState,
  options: { assertOwned?: () => Promise<void> } = {},
): Promise<void> {
  const imported = decodeNativeRuntime(
    captureNativePlainData(state),
    paths.storageId,
  )
  await mutateVaultRoster(paths.roster, async (roster, lease) => {
    for (const [id, entry] of Object.entries(imported.accounts)) {
      if (entry.binding.kind !== 'custody') continue
      const binding = entry.binding
      const row = roster?.rows.find((row) => row.routeId === id)
      if (
        !row?.accountIdentity ||
        row.accountIdentity !== binding.accountIdentity ||
        (row.credentialId !== binding.credentialId &&
          !row.aliases?.includes(binding.credentialId))
      )
        throw new NativeRuntimeError('publication-refused')
    }
    await updateNativeRuntime(paths.runtime, paths.storageId, () => imported, {
      beforeRename: async () => {
        await options.assertOwned?.()
        await lease.assertOwned()
      },
    })
    return { result: undefined }
  })
}

/** Read inventory for offline setup; a list neither authorizes serving nor proves completeness without the controller's checks. */
export async function discoverNativeVaultInventory(
  options: NativeVaultRuntimeOptions,
  signal?: AbortSignal,
): Promise<NativeCustodyInventory> {
  const env = { ...(options.env ?? process.env) }
  const custody = createNativeCustody({
    host: options.host,
    readToken: options.readToken,
    now: options.now,
    env,
    connect:
      options.connect ??
      (() =>
        ClaustrumClient.connect({
          connectionFile: resolveClaustrumConnectionPath(undefined, env),
        })),
  })
  try {
    return await custody.discover(signal)
  } finally {
    custody.close()
  }
}

/** Retain the vault client's original per-attempt receipts and version provenance; access tokens never persist in roster or runtime metadata. */
export function createNativeVaultRuntime(
  options: NativeVaultRuntimeOptions,
): NativeVaultRuntime {
  const paths = Object.freeze({ ...options.paths })
  const env = { ...(options.env ?? process.env) }
  const shutdown = new AbortController()
  const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
  const custody = createNativeCustody({
    host: options.host,
    readToken: options.readToken,
    now: options.now,
    connect:
      options.connect ??
      (() =>
        ClaustrumClient.connect({
          connectionFile: resolveClaustrumConnectionPath(undefined, env),
        })),
    env,
  })
  const issued = new WeakMap<
    NativeCustodyReceipt,
    { routeId: string; logicalId: string }
  >()
  const retryUsed = new WeakSet<NativeCustodyReceipt>()
  const versions = new Map<string, number>()
  let reservedRouteIds = new Set<string>(['main'])
  let refreshing: Promise<NativeVaultRosterDocument | undefined> | undefined

  function check(signal?: AbortSignal) {
    if (shutdown.signal.aborted) throw new NativeCustodyError('closed')
    signal?.throwIfAborted()
  }
  function signalFor(signal?: AbortSignal) {
    check(signal)
    return AbortSignal.any([shutdown.signal, ...(signal ? [signal] : [])])
  }
  async function active() {
    check()
    await requireNativePoolAuthority(paths)
    const read = await store.readSettings()
    if (read.status !== 'ready') throw new NativeCustodyError('invalid-state')
    const rows = await store.read()
    if (rows.status !== 'ready') throw new NativeCustodyError('invalid-state')
    reservedRouteIds = new Set(['main', ...rows.rows.map((row) => row.id)])
    return (
      (read.settings.claustrum as { mode?: unknown } | undefined)?.mode ===
      'claustrum'
    )
  }
  async function requireActive(signal?: AbortSignal) {
    check(signal)
    if (!(await active())) throw new NativeCustodyError('route-unavailable')
    check(signal)
  }
  async function rowFor(
    roster: NativeVaultRosterDocument | undefined,
    routeId: string,
  ) {
    const settings = await store.readSettings()
    if (settings.status !== 'ready')
      throw new NativeCustodyError('invalid-state')
    const pin = nativeVaultPrimaryPin(settings.settings)
    return routeId === 'main' || routeId === pin?.routeId
      ? nativeVaultPrimaryRow(roster, pin)
      : roster?.rows.find((row) => row.routeId === routeId)
  }
  function requireIssued(receipt: NativeCustodyReceipt) {
    check()
    const route = issued.get(receipt)
    if (!route) throw new NativeCustodyError('no-receipt')
    return route
  }
  const runtime: NativeVaultRuntime = {
    async read() {
      await requireActive()
      const roster = await readVaultRoster(paths.roster)
      check()
      return roster
    },
    refresh(signal) {
      check(signal)
      // Cancellation belongs to this waiter, not to a peer using shared discovery.
      refreshing ??= refreshVaultRoster({
        path: paths.roster,
        custody,
        signal: shutdown.signal,
        isActive: active,
        projection: () => ({ reservedRouteIds }),
      }).finally(() => {
        refreshing = undefined
      })
      return waitFor(refreshing, signalFor(signal))
    },
    async authorize(logicalId, signal) {
      const combined = signalFor(signal)
      await requireActive(combined)
      const roster =
        (await readVaultRoster(paths.roster)) ??
        (await runtime.refresh(combined))
      const row = await rowFor(roster, logicalId)
      if (row?.credentialType !== 'oauth' || !row.accountIdentity)
        throw new NativeCustodyError('route-unavailable')
      if (!row.enabled) throw new NativeCustodyError('route-declined')
      if (row.state !== 'active') throw new NativeCustodyError('not-active')
      const receipt = await custody.authorize(
        {
          credentialId: row.credentialId,
          accountIdentity: row.accountIdentity,
        },
        combined,
      )
      await requireActive(combined)
      const current = await rowFor(
        await readVaultRoster(paths.roster),
        logicalId,
      )
      if (
        !current?.enabled ||
        current.routeId !== row.routeId ||
        current.accountIdentity !== row.accountIdentity ||
        (current.credentialId !== receipt.credentialId &&
          !current.aliases?.includes(receipt.credentialId))
      )
        throw new NativeCustodyError('identity-changed')
      // A fresh GET does not override a roster revocation observed while it was
      // pending. The selected row must still be active before its receipt exits.
      if (current.state !== 'active') throw new NativeCustodyError('not-active')
      check(combined)
      issued.set(receipt, { routeId: row.routeId, logicalId })
      const key = JSON.stringify([
        row.routeId,
        receipt.credentialId,
        receipt.assertedAccountIdentity,
      ])
      versions.set(key, Math.max(versions.get(key) ?? 0, receipt.recordVersion))
      return receipt
    },
    async reportFailure(receipt, status, source) {
      requireIssued(receipt)
      await custody.reportFailure(receipt, status, source)
    },
    async prepareRetry(served, signal) {
      const route = requireIssued(served)
      if (retryUsed.has(served))
        return { retry: false, reason: 'version-not-newer' }
      retryUsed.add(served)
      let next: NativeCustodyReceipt
      try {
        next = await runtime.authorize(route.logicalId, signal)
      } catch (error) {
        check(signal)
        return {
          retry: false,
          reason: 'reauthorize-failed',
          code:
            error instanceof NativeCustodyError ? error.code : 'unavailable',
        }
      }
      if (next.credentialId !== served.credentialId)
        return { retry: false, reason: 'credential-changed' }
      if (next.assertedAccountIdentity !== served.assertedAccountIdentity)
        return { retry: false, reason: 'account-changed' }
      if (!(next.recordVersion > served.recordVersion))
        return { retry: false, reason: 'version-not-newer' }
      // Mark the retry-issued receipt too, so handing it back cannot restart the
      // request's one permitted strict-newer-version 401 retry.
      retryUsed.add(next)
      return { retry: true, receipt: next }
    },
    publish(receipt, rawPatch) {
      const patch = captureNativeMetadataPatch(rawPatch)
      return mutateReceipt(receipt, (old) =>
        applyNativeMetadataPatch(old, patch),
      )
    },
    resetBackoff(receipt, kind = 'all') {
      return mutateReceipt(receipt, (old) => {
        const clear = Math.max(
          options.now?.() ?? Date.now(),
          old.refreshErrorClearedAt ?? 0,
          old.quotaErrorClearedAt ?? 0,
          old.lastRefreshError?.checkedAt ?? 0,
          old.lastQuotaRefreshError?.checkedAt ?? 0,
        )
        const next = { ...old }
        if (kind !== 'quota') {
          delete next.lastRefreshError
          next.refreshErrorClearedAt = clear
        }
        if (kind !== 'refresh') {
          delete next.lastQuotaRefreshError
          next.quotaErrorClearedAt = clear
          next.quotaErrorGeneration = (old.quotaErrorGeneration ?? 0) + 1
        }
        return next
      })
    },
    async getOrCreateAuthLineage(receipt) {
      let lineage: string | undefined
      const kept = await mutateReceipt(receipt, (old) => {
        lineage = old.authLineageId ?? randomUUID()
        return { ...old, authLineageId: lineage }
      })
      return kept ? lineage : undefined
    },
    incrementPrimeUsage(receipt, delta = {}) {
      const inputTokens = delta.inputTokens ?? 0
      const outputTokens = delta.outputTokens ?? 0
      if (
        ![inputTokens, outputTokens].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        throw new NativeRuntimeError('publication-refused')
      return mutateReceipt(receipt, (old) => ({
        ...old,
        prime: {
          count: (old.prime?.count ?? 0) + 1,
          inputTokens: (old.prime?.inputTokens ?? 0) + inputTokens,
          outputTokens: (old.prime?.outputTokens ?? 0) + outputTokens,
          since: old.prime?.since ?? options.now?.() ?? Date.now(),
        },
      }))
    },
    async fetchQuota(routeId, fetchImpl = fetch, signal) {
      const row = await rowFor(await runtime.read(), routeId)
      const state = await readNativeRuntime(paths.runtime, paths.storageId)
      const before =
        state.status === 'ready'
          ? state.state.accounts[row?.routeId ?? '']
          : undefined
      const matchingBefore = (receipt: NativeCustodyReceipt) => {
        const route = issued.get(receipt)
        const binding = before?.binding
        return route &&
          binding?.kind === 'custody' &&
          binding.storageId === paths.storageId &&
          binding.routeId === route.routeId &&
          binding.credentialId === receipt.credentialId &&
          binding.accountIdentity === receipt.assertedAccountIdentity &&
          binding.recordVersion <= receipt.recordVersion
          ? before
          : undefined
      }
      const result = await fetchReading(
        routeId,
        fetchImpl,
        signal,
        (receipt, transport) =>
          fetchOAuthQuotaSnapshot({
            accessToken: receipt.accessToken,
            fetchImpl: transport,
            now: options.now,
          }),
        async (error, receipt) => {
          const matched = matchingBefore(receipt)
          const failure = nativeQuotaFailure(
            error,
            receipt.assertedAccountIdentity,
            Math.max(
              options.now?.() ?? Date.now(),
              (matched?.quotaErrorClearedAt ?? -1) + 1,
            ),
            matched?.lastQuotaRefreshError,
          )
          if (failure)
            await runtime.publish(receipt, { lastQuotaRefreshError: failure })
        },
      )
      const quota = {
        ...result.value,
        accountIdentity: result.receipt.assertedAccountIdentity,
      }
      const matched = matchingBefore(result.receipt)
      await runtime.publish(result.receipt, {
        quota,
        quotaErrorClearedAt: Math.max(
          quota.checkedAt ?? options.now?.() ?? Date.now(),
          matched?.quotaErrorClearedAt ?? 0,
          matched?.lastQuotaRefreshError?.checkedAt ?? 0,
        ),
      })
      return quota
    },
    async fetchProfile(routeId, fetchImpl = fetch, signal) {
      const result = await fetchReading(
        routeId,
        fetchImpl,
        signal,
        (receipt, transport) =>
          fetchOAuthAccountProfile({
            accessToken: receipt.accessToken,
            accountIdentity: receipt.assertedAccountIdentity,
            fetchImpl: transport,
            now: options.now,
            signal,
          }),
      )
      await runtime.publish(result.receipt, { profile: result.value })
      return result.value
    },
    async setEnabled(routeId, enabled) {
      await requireActive()
      const roster = await readVaultRoster(paths.roster)
      const row = await rowFor(roster, routeId)
      if (!row) throw new NativeCustodyError('route-unavailable')
      await (enabled ? acceptVaultRoute : declineVaultRoute)(
        paths.roster,
        row.routeId,
      )
    },
    close() {
      if (shutdown.signal.aborted) return
      shutdown.abort(new NativeCustodyError('closed'))
      custody.close()
    },
  }
  async function mutateReceipt(
    receipt: NativeCustodyReceipt,
    change: (old: NativeRuntimeEntry) => NativeRuntimeEntry,
  ): Promise<boolean> {
    const route = requireIssued(receipt)
    await requireActive()
    const key = JSON.stringify([
      route.routeId,
      receipt.credentialId,
      receipt.assertedAccountIdentity,
    ])
    if ((versions.get(key) ?? 0) > receipt.recordVersion) return false
    return mutateVaultRoster(paths.roster, async (roster, lease) => {
      const row = await rowFor(roster, route.logicalId)
      if (
        !row?.accountIdentity ||
        row.routeId !== route.routeId ||
        row.accountIdentity !== receipt.assertedAccountIdentity ||
        (row.credentialId !== receipt.credentialId &&
          !row.aliases?.includes(receipt.credentialId))
      )
        return { result: false }
      const accountIdentity = row.accountIdentity
      let kept = false
      try {
        await updateNativeRuntime(
          paths.runtime,
          paths.storageId,
          (current) => {
            const old = current.accounts[route.routeId]
            const binding = old?.binding
            if (
              binding?.kind === 'custody' &&
              binding.credentialId === receipt.credentialId &&
              binding.accountIdentity === receipt.assertedAccountIdentity &&
              binding.recordVersion > receipt.recordVersion
            )
              throw new NativeRuntimeError('runtime-conflict')
            const same =
              binding?.kind === 'custody' &&
              binding.accountIdentity === receipt.assertedAccountIdentity
            current.accounts[route.routeId] = change({
              ...(same ? old : {}),
              binding: {
                kind: 'custody',
                storageId: paths.storageId,
                routeId: route.routeId,
                credentialId: receipt.credentialId,
                accountIdentity,
                recordVersion: receipt.recordVersion,
              },
            })
            kept = true
            return current
          },
          {
            beforeRename: async () => {
              await requireActive()
              const pinned = await rowFor(roster, route.logicalId)
              if (
                !pinned ||
                pinned.routeId !== route.routeId ||
                pinned.accountIdentity !== receipt.assertedAccountIdentity
              )
                throw new NativeRuntimeError('publication-refused')
              if ((versions.get(key) ?? 0) > receipt.recordVersion)
                throw new NativeRuntimeError('runtime-conflict')
              // The roster lease is held across the runtime write. Check it after
              // all other work, immediately before the writer's final rename.
              await lease.assertOwned()
            },
          },
        )
      } catch (error) {
        if (
          error instanceof NativeRuntimeError &&
          error.code === 'runtime-conflict'
        )
          return { result: false }
        throw error
      }
      return { result: kept }
    })
  }
  async function fetchReading<T>(
    routeId: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
    read: (
      receipt: NativeCustodyReceipt,
      transport: typeof fetch,
    ) => Promise<T>,
    onFailure?: (
      error: unknown,
      receipt: NativeCustodyReceipt,
    ) => Promise<void>,
  ) {
    const combined = signalFor(signal)
    let served = await runtime.authorize(routeId, combined)
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
          // Cleanup and best-effort telemetry can await. Complete them before
          // final retry admission so a decline/revocation during either wins.
          await response.body?.cancel().catch(() => {})
          await runtime.reportFailure(served, 401, 'direct').catch(() => {
            check(combined)
          })
          check(combined)
          const retry = await runtime.prepareRetry(served, combined)
          if (retry.retry) {
            served = retry.receipt
            const headers = new Headers(init?.headers)
            headers.set('authorization', `Bearer ${served.accessToken}`)
            responseStatus = undefined
            response = await fetchImpl(input, {
              ...init,
              headers,
              signal: combined,
            })
            responseStatus = response.status
            if (response.status === 401)
              await runtime.reportFailure(served, 401, 'direct').catch(() => {
                check(combined)
              })
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
    return { value, receipt: served }
  }
  return runtime
}

function waitFor<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(
      (value) => {
        cleanup()
        signal.aborted ? reject(signal.reason) : resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}

const shared = new Map<string, { runtime: NativeVaultRuntime; users: number }>()

/** Each handle owns one reference; disposing it cannot close another host session. */
export function acquireNativeVaultRuntime(
  options: NativeVaultRuntimeOptions,
): NativeVaultRuntime {
  const key = JSON.stringify([options.paths.storageId, options.host])
  let entry = shared.get(key)
  if (!entry) {
    entry = { runtime: createNativeVaultRuntime(options), users: 0 }
    shared.set(key, entry)
  }
  entry.users++
  const owned = entry
  let closed = false
  function use(): NativeVaultRuntime {
    if (closed) throw new NativeCustodyError('closed')
    return owned.runtime
  }
  return {
    read: () => use().read(),
    refresh: (signal) => use().refresh(signal),
    authorize: (id, signal) => use().authorize(id, signal),
    reportFailure: (receipt, status, source) =>
      use().reportFailure(receipt, status, source),
    prepareRetry: (receipt, signal) => use().prepareRetry(receipt, signal),
    publish: (receipt, patch) => use().publish(receipt, patch),
    fetchQuota: (id, transport, signal) =>
      use().fetchQuota(id, transport, signal),
    fetchProfile: (id, transport, signal) =>
      use().fetchProfile(id, transport, signal),
    setEnabled: (id, enabled) => use().setEnabled(id, enabled),
    resetBackoff: (receipt, kind) => use().resetBackoff(receipt, kind),
    getOrCreateAuthLineage: (receipt) => use().getOrCreateAuthLineage(receipt),
    incrementPrimeUsage: (receipt, delta) =>
      use().incrementPrimeUsage(receipt, delta),
    close() {
      if (closed) return
      closed = true
      if (--owned.users === 0) {
        if (shared.get(key) === owned) shared.delete(key)
        owned.runtime.close()
      }
    },
  }
}
