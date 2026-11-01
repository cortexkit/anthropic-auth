import { randomUUID } from 'node:crypto'
import type { ClaustrumClientOptions } from '@cortexkit/claustrum-client'
import {
  acceptAccount,
  acquireInsulaQuotaSource,
  ClaustrumConsumerError,
  connectClaustrumScopedClient,
  declineAccount,
  type InsulaQuotaMiss,
  type InsulaQuotaResult,
  type InsulaQuotaSource,
  mutateVaultRoster,
  readClaustrumEnrollmentToken,
  readVaultRoster,
  refreshVaultRoster,
  SAFETY_POLL_MS,
} from '@cortexkit/common-auth/claustrum'
import { SubcClient } from '@cortexkit/subc-client'
import {
  fetchOAuthQuotaSnapshot,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  type PrimeUsageDelta,
  quotaSnapshotCheckedAt,
} from './accounts.ts'
import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import {
  type InsulaClaudeQuota,
  mergeInsulaQuota,
  normalizeInsulaClaudeQuota,
} from './insula-quota.ts'
import { logger } from './logger.ts'
import {
  applyNativeMetadataPatch,
  captureNativeMetadataPatch,
  captureNativePlainData,
  NATIVE_PRIMARY_CREDENTIAL_ID,
  type NativeAccountMetadataPatch,
  nativeAccountCanServe,
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
  type NativeRosterWatch,
} from './native-custody.ts'
import { readNativeEnrollmentMode } from './native-enrollment-authority.ts'
import {
  type NativeLockEvent,
  nativeLockObserver,
  withDetachedNativeLocks,
} from './native-lock-observer.ts'
import { fromNativeQuotaMap, nativeQuotaCodec } from './native-quota-codec.ts'
import {
  NativeQuotaObservations,
  nativePollQuotaGenerallyExhausted,
} from './native-quota-observations.ts'
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
  updateNativeRuntimeOptional,
} from './native-runtime.ts'
import {
  NativeRuntimeRegistry,
  nativeRuntimeConnectionFile,
  nativeRuntimeOptionIdentity,
  nativeRuntimeStorageKey,
} from './native-runtime-registry.ts'
import {
  retainNativeVaultRoster,
  watchNativeVaultAuthority,
} from './native-vault-invalidation.ts'
import type { NativeVaultPaths } from './native-vault-paths.ts'
import { nativeVaultPaths } from './native-vault-paths.ts'
import { nativeVaultFileAbsent } from './native-vault-seed.ts'
import { fetchOAuthAccountProfile } from './oauth-profile.ts'
import { NativeAuthorityError } from './pool-authority.ts'
import type { NativePoolPaths } from './pool-paths.ts'
import { createNativePoolStore } from './pool-store.ts'
import {
  type QuotaReadingPurpose,
  QuotaRefreshDeferred,
  type QuotaRequestDispatch,
} from './quota-manager.ts'
import { nativeRelocationGuard } from './relocation-guard.ts'

export interface NativeVaultRuntimeOptions {
  paths: NativePoolPaths
  host: 'opencode' | 'pi'
  identity?: ClaustrumClientOptions['identity']
  connect?: () => Promise<NativeCustodyClient>
  /** Reuse the inventory verifier supplied by offline setup without changing per-send scoped authorization. */
  discover?: () => Promise<NativeCustodyInventory>
  readToken?: () => Promise<{ token: string; token_generation: number }>
  env?: NodeJS.ProcessEnv
  now?: () => number
  onLockEvent?: (event: NativeLockEvent) => void
  /**
   * Timer functions for the vault custody's outage probe and roster watch
   * retries. Defaults to the global ones; tests pass their own.
   */
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
  /**
   * Called each time the runtime has finished handling a vault notice that
   * asked it to rediscover the roster, after the discovery that notice ran.
   * Common-auth asks when the notice's view differs from the roster held,
   * after a gap in the notices, and on a re-subscribed watch's first notice.
   * Tests use it to wait for that handling instead of for the clock.
   */
  onRosterNoticeHandled?: () => void
}

/**
 * Why a vault quota reading is wanted, which decides whether insula's
 * background quota cache may answer instead of Anthropic's usage endpoint.
 * - 'background': a periodic sweep. Refresh insula's cache (at most once a
 *   minute per daemon and enrollment), look the route's account up in it,
 *   and skip the usage GET for a current reading, a cold cache or an upstream
 *   failure. Skipped misses leave the account due for the next sweep.
 * - 'admission': a request needs a reading. Look the served credential's
 *   account up in insula's cache only, never refreshing it, then poll on a
 *   miss except an upstream failure, which uses a dated reading if attached
 *   and otherwise leaves quota unknown.
 * Omitted: poll Anthropic directly (explicit user refreshes and other
 *   callers that must see the provider's own reading).
 */
export type NativeVaultQuotaPurpose = QuotaReadingPurpose

export interface NativeVaultWatchOptions {
  intervalMs: number
  onRefresh?: () => void | Promise<void>
  shouldRefresh?: () => boolean | Promise<boolean>
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}
export interface NativeVaultWatch {
  readonly ready: Promise<void>
  close(): void
}

/** Send classes that may replay once after a vault credential's 401, named in diagnostics. */
export type NativeScoped401Site =
  | 'model'
  | 'model-relay'
  | 'cachekeep'
  | 'prime'
  | 'quota-profile'

export type NativeProfilePersistence = 'saved' | 'refused' | 'failed'

/** The profile fields a display may receive; never the legacy token fingerprint. */
export type NativeDisplayProfileMetadata = Pick<
  OAuthAccountProfile,
  'tier' | 'orgType' | 'checkedAt' | 'accountIdentity' | 'providerAccountUuid'
>

/**
 * A fetched account tier for immediate display. `profile` contains metadata
 * only, never tokens or authorization receipts. `persisted` reports whether
 * the write succeeded, was refused because credentials or lock ownership
 * changed, or failed because storage was unavailable. It never rejects.
 * Call isCurrent before displaying the tier, including after a storage failure.
 */
export interface NativeDisplayProfile {
  profile: NativeDisplayProfileMetadata
  persisted: Promise<NativeProfilePersistence>
  /** Check the same account and token or vault record version, without fetching credentials. */
  isCurrent(): Promise<boolean>
}

/** Build a NativeDisplayProfile from a validated profile and its publication. */
export function nativeDisplayProfile(
  profile: OAuthAccountProfile,
  publish: () => Promise<boolean>,
  isCurrent: () => Promise<boolean>,
): NativeDisplayProfile {
  return {
    // Copy named fields rather than spreading, so legacy token fingerprints
    // and any future credential fields never reach the display metadata.
    profile: {
      tier: profile.tier,
      orgType: profile.orgType,
      checkedAt: profile.checkedAt,
      ...(profile.accountIdentity !== undefined && {
        accountIdentity: profile.accountIdentity,
      }),
      ...(profile.providerAccountUuid !== undefined && {
        providerAccountUuid: profile.providerAccountUuid,
      }),
    },
    // Changed credentials or lost write-lock ownership invalidate the tier.
    // A storage error alone does not, but display still checks the credentials.
    persisted: Promise.resolve()
      .then(publish)
      .then(
        (saved): NativeProfilePersistence => (saved ? 'saved' : 'refused'),
        (error: unknown): NativeProfilePersistence =>
          error instanceof NativeCustodyError ||
          error instanceof NativeAuthorityError ||
          (error instanceof NativeRuntimeError && error.code !== 'runtime-io')
            ? 'refused'
            : 'failed',
      ),
    isCurrent: () =>
      Promise.resolve()
        .then(isCurrent)
        .then(
          (current) => current,
          () => false,
        ),
  }
}

export interface NativeVaultRuntime {
  readonly quotaObservations: NativeQuotaObservations
  drainQuotaPublications(): Promise<void>
  quotaLineage(
    routeId: string,
    credentialId: string | undefined,
    accountIdentity: string | undefined,
  ): string | undefined
  /** Subscribe to one discovery loop; notifications contain no credential material. */
  watch(options: NativeVaultWatchOptions): NativeVaultWatch
  initializeSettings(): Promise<void>
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
  /**
   * After a 401, acquire a fresh receipt for the same credential and account.
   * Permit one replay only if its recordVersion exceeds the rejected receipt's
   * version. The optional site is a diagnostic call-site label: model requests,
   * quota, profile or cache warming. Logs contain versions, never credentials.
   * The caller reports only the receipt rejected by its final HTTP attempt.
   */
  prepareRetry(
    receipt: NativeCustodyReceipt,
    signal?: AbortSignal,
    site?: NativeScoped401Site,
  ): Promise<NativeCustodyRetry>
  publish(
    receipt: NativeCustodyReceipt,
    patch: NativeAccountMetadataPatch,
  ): Promise<boolean>
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
  /** Return the fetched account profile without waiting for its metadata write. NativeDisplayProfile.persisted reports whether that asynchronous write succeeded, failed or was refused. */
  fetchProfileForDisplay(
    routeId: string,
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
  ): Promise<NativeDisplayProfile>
  /**
   * Accept or decline a vault route for the user. Resolves to whether the
   * route's enabled flag changed, judged on the roster under its write lock.
   */
  setEnabled(routeId: string, enabled: boolean): Promise<boolean>
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
  close(): void | Promise<void>
}

/** Publish the initial roster from validated account inventory. A caller importing captured state must fence that state through assertOwned, which runs again at the roster's actual publication. */
export async function publishNativeVaultRosterSeed(
  paths: Pick<NativeVaultPaths, 'roster'>,
  input: NativeRosterSeedInput,
  options: { assertOwned?: () => Promise<void> } = {},
): Promise<NativeVaultRosterSeed> {
  const seed = buildNativeVaultRosterSeed(input)
  const published = await mutateVaultRoster(
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
  retainNativeVaultRoster(paths.roster, await readVaultRoster(paths.roster))
  return published
}

/** Match imported custody metadata to the current roster without blocking roster writers. The optional assertOwned callback separately rechecks the caller's captured input before rename. */
export async function publishNativeVaultRuntimeSeed(
  paths: Pick<NativeVaultPaths, 'roster' | 'runtime' | 'storageId'>,
  state: NativeRuntimeState,
  options: { assertOwned?: () => Promise<void> } = {},
): Promise<void> {
  const imported = decodeNativeRuntime(
    captureNativePlainData(state),
    paths.storageId,
  )
  const assertPinned = async () => {
    const roster = await readVaultRoster(paths.roster)
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
  }
  await assertPinned()
  await updateNativeRuntime(paths.runtime, paths.storageId, () => imported, {
    beforeRename: async () => {
      await options.assertOwned?.()
      await assertPinned()
    },
  })
}

const NATIVE_VAULT_CONNECT_TIMEOUT_MS = 2_000

/**
 * The vault list timer's period. Without an open vault watch it is the
 * host's own interval. While a watch is open, notices announce changes and
 * the timer is only a safety net for a lost notice or a silently dead watch,
 * so it runs every five minutes (never faster than the host asked for).
 */
function nativeVaultListIntervalMs(
  hostIntervalMs: number,
  watching: boolean,
): number {
  return watching ? Math.max(hostIntervalMs, SAFETY_POLL_MS) : hostIntervalMs
}

/** Connect through the same short deadline used when requests wait for a vault roster. */
export function connectNativeVaultScopedClient(
  connectionFile: string,
  identity?: ClaustrumClientOptions['identity'],
) {
  return connectClaustrumScopedClient({
    connectionFile,
    identity,
    handshakeTimeoutMs: NATIVE_VAULT_CONNECT_TIMEOUT_MS,
    connector: ({ connectionFile: file, handshakeTimeoutMs }) =>
      SubcClient.connect({
        connectionFile: file,
        handshakeTimeoutMs,
        routeOpenRetryDeadlineMs: NATIVE_VAULT_CONNECT_TIMEOUT_MS,
      }),
  })
}

/** List accounts readable by this host's enrollment for offline setup. An inventory grants no bearer authority; every outbound request still needs a fresh scoped receipt. */
export async function discoverNativeVaultInventory(
  options: NativeVaultRuntimeOptions,
  signal?: AbortSignal,
): Promise<NativeCustodyInventory> {
  const env = { ...(options.env ?? process.env) }
  const connectionFile = nativeRuntimeConnectionFile(options.host, env)
  const custody = createNativeCustody({
    host: options.host,
    readToken: options.readToken,
    now: options.now,
    env,
    connect:
      options.connect ??
      (() => connectNativeVaultScopedClient(connectionFile, options.identity)),
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
  const paths = Object.freeze(nativeVaultPaths(options.paths))
  const env = { ...(options.env ?? process.env) }
  const connectionFile = nativeRuntimeConnectionFile(options.host, env)
  const identity = options.identity ? { ...options.identity } : undefined
  const shutdown = new AbortController()
  const store = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    onLockEvent: options.onLockEvent,
  })
  const observeLock = nativeLockObserver(options.onLockEvent)
  // Refuses once a newer version has moved this dataset. Each use below runs
  // where a mover can't install its tombstones in between: under the lock
  // that guards the file written, or just before a receipt is returned.
  const relocation = nativeRelocationGuard(options.paths)
  // The vault watch for the current custody, opened while a host watches the
  // roster. While it reports `watching`, the list timer below runs only as a
  // slow safety net; in any other mode it keeps the host's own pace.
  let rosterWatch: { watch: NativeRosterWatch; live: boolean } | undefined
  let rosterWatching = false
  // The view of the roster this runtime last committed or adopted, so a
  // notice that carries it runs no discovery. Tracked here rather than left
  // to custody, because a refresh can adopt a roster a peer process listed.
  let rosterView: string | undefined
  const newCustody = () =>
    createNativeCustody({
      host: options.host,
      readToken: options.readToken,
      now: options.now,
      connect:
        options.connect ??
        // The scoped client carries insula's transport over the same connection.
        (() => connectNativeVaultScopedClient(connectionFile, identity)),
      env,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
    })
  let custody = newCustody()
  let custodyClosed = false
  function closeCustody() {
    // Closing the custody also stops its roster watch.
    closeRosterWatch()
    custody.close()
    custodyClosed = true
    insula?.release()
    insula = undefined
  }
  function retainRoster(roster: NativeVaultRosterDocument | undefined) {
    rosterView = roster?.view
    custody.retain(
      (roster?.rows ?? []).map((row) => ({
        credentialId: row.credentialId,
        accountIdentity: row.accountIdentity ?? '',
        enabled: row.enabled,
        state:
          row.credentialType === 'oauth' && nativeAccountCanServe(row)
            ? 'active'
            : 'not-active',
      })),
    )
  }
  // Insula's background quota cache, shared by common-auth across runtimes
  // with the same resolved connection file and enrollment token path (one
  // fetch a minute between them). Acquired on the first background tick that
  // finds vault custody, released when this runtime closes.
  const tokenPath = getHostClaustrumEnrollmentPaths(options.host, env).tokenPath
  const clock = options.now ?? Date.now
  let insula: { source: InsulaQuotaSource; release(): void } | undefined
  const unwatchAuthority = watchNativeVaultAuthority({
    roster: paths.roster,
    tokenPath,
    retain: retainRoster,
    close: closeCustody,
  })
  /**
   * Refresh insula's cache for one background tick. Enrollment is read fresh
   * each time: outside vault custody, or with a missing or unreadable token,
   * insula is not used at all. An optional source never fails the tick.
   */
  async function refreshInsula(): Promise<void> {
    try {
      if (!(await active())) return
      await readClaustrumEnrollmentToken(tokenPath)
      if (!insula) {
        const transport = await custody.insulaTransport()
        check()
        if (!transport) return
        insula ??= acquireInsulaQuotaSource(transport, tokenPath)
      }
      await insula.source.refresh(clock())
    } catch {
      // Insula is optional: without it every account keeps its own poll.
    }
  }
  /**
   * Cache-only lookup by the vault's account id for this account (the
   * list_scoped or get_scoped account_id), never an email or label.
   * Preserve insula's miss reason, even when the lookup also contains a dated reading.
   */
  function insulaLookup(
    accountId: string | undefined,
  ): InsulaQuotaResult<InsulaClaudeQuota> {
    if (!insula || !accountId || shutdown.signal.aborted)
      return { miss: 'unreachable' }
    const result = insula.source.lookup('claude', accountId, clock())
    const reading =
      result.reading &&
      normalizeInsulaClaudeQuota(result.reading.entry, result.reading.context)
    if (result.miss) return { miss: result.miss, ...(reading && { reading }) }
    return reading ? { reading } : { miss: 'unreachable' }
  }
  // The last source each route's guided quota reading came from, so a change
  // is logged once rather than on every sweep.
  const quotaSources = new Map<string, string>()
  function noteQuotaSource(
    routeId: string,
    source: 'insula' | 'fallback' | 'skipped',
    reason: 'insula-reading' | 'account-changed' | InsulaQuotaMiss,
  ) {
    const transition = `${source}:${reason}`
    if (quotaSources.get(routeId) === transition) return
    quotaSources.set(routeId, transition)
    if (quotaSources.size > 1000) {
      const oldest = quotaSources.keys().next().value
      if (oldest !== undefined) quotaSources.delete(oldest)
    }
    // Fixed codes only: no route, credential or account identity.
    logger.info('quota', 'vault quota source changed', { source, reason })
  }
  const issued = new WeakMap<
    NativeCustodyReceipt,
    { routeId: string; logicalId: string }
  >()
  const retryUsed = new WeakSet<NativeCustodyReceipt>()
  const versions = new Map<string, number>()
  const reservedRouteIds = new Set<string>(['main'])
  let refreshing: Promise<NativeVaultRosterDocument | undefined> | undefined
  const watchers = new Set<NativeVaultWatchOptions>()
  let pollReady: Promise<void> | undefined
  let polling: Promise<void> | undefined
  let pollTimer:
    | {
        handle: ReturnType<typeof setInterval>
        clear: typeof clearInterval
        ms: number
      }
    | undefined

  function schedulePoll() {
    const owner = [...watchers]
      .filter((watch) => watch.intervalMs > 0)
      .sort((a, b) => a.intervalMs - b.intervalMs)[0]
    const ms =
      owner && nativeVaultListIntervalMs(owner.intervalMs, rosterWatching)
    if (pollTimer?.ms === ms) return
    if (pollTimer) pollTimer.clear(pollTimer.handle)
    pollTimer = undefined
    if (!owner || ms === undefined) return
    const handle = (owner.setInterval ?? setInterval)(() => {
      void poll().catch(() => {})
    }, ms)
    handle.unref?.()
    pollTimer = {
      handle,
      clear: owner.clearInterval ?? clearInterval,
      ms,
    }
  }
  /**
   * Open the roster watch once a host watches the roster and vault custody is
   * active. One watch per runtime: the runtime is already shared per process.
   */
  function openRosterWatch() {
    if (rosterWatch || custodyClosed || shutdown.signal.aborted) return
    if (!watchers.size) return
    const held = {
      live: true,
      watch: undefined as unknown as NativeRosterWatch,
    }
    rosterWatch = held
    try {
      held.watch = custody.watchRoster({
        view: () => rosterView,
        // Our existing discovery and roster publication, with the hosts'
        // refresh callbacks. A poll already running may have listed before the
        // change was announced, so wait for it and run one of our own.
        onView: async () => {
          try {
            while (polling) await polling.catch(() => {})
            if (held.live) await poll()
          } finally {
            options.onRosterNoticeHandled?.()
          }
        },
        onMode: (mode) => {
          if (!held.live) return
          rosterWatching = mode === 'watching'
          schedulePoll()
        },
        // The vault refused the watch and the account listing that confirmed
        // it. Custody has already dropped every kept receipt (the same thing it
        // does when discovery's own listing is refused) and, for a revoked
        // enrollment, closed itself. The watch is now in fallback, so the list
        // timer is back at the host's pace and the next discovery reports the
        // refusal through the usual refresh path.
        onRefused: () => {
          logger.warn('claustrum', 'vault refused the account watch')
        },
        onError: () => {
          logger.debug('claustrum', 'vault account watch failed')
        },
      })
    } catch {
      // A custody closed under us opens nothing; the next poll tries again.
      held.live = false
      if (rosterWatch === held) rosterWatch = undefined
    }
  }
  function closeRosterWatch() {
    const held = rosterWatch
    rosterWatch = undefined
    if (held) {
      held.live = false
      held.watch?.close()
    }
    if (!rosterWatching) return
    rosterWatching = false
    schedulePoll()
  }
  function poll(): Promise<void> {
    if (polling) return polling
    polling = withDetachedNativeLocks(async () => {
      const allowed = await Promise.all(
        [...watchers].map(
          async (watch) =>
            !watch.shouldRefresh || (await watch.shouldRefresh()),
        ),
      )
      if (shutdown.signal.aborted || !allowed.some(Boolean)) return
      const roster = await runtime.refresh(shutdown.signal)
      if (shutdown.signal.aborted) return store.close()
      // Watch while vault custody is active; a refresh outside it (the host
      // left the vault) returns no roster, and the watch is closed.
      if (roster) openRosterWatch()
      else closeRosterWatch()
      // Keep insula's cache warm for admission lookups, which only read it.
      // It refreshes at most once a minute and never throws.
      await refreshInsula()
      if (shutdown.signal.aborted) return
      // Notifications belong to their observers. A slow or disposing host must
      // not hold discovery for the other leases; hosts drain their own writes.
      for (const watch of watchers) {
        void Promise.resolve()
          .then(() => {
            if (watchers.has(watch)) return watch.onRefresh?.()
          })
          .catch(() => {})
      }
    }).finally(() => {
      polling = undefined
    })
    return polling
  }

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
    const mode = await readNativeEnrollmentMode(options.host, env)
    check()
    if (mode === 'claustrum' && custodyClosed) {
      custody = newCustody()
      custodyClosed = false
    }
    return mode === 'claustrum'
  }
  async function requireActive(signal?: AbortSignal) {
    check(signal)
    if (!(await active())) throw new NativeCustodyError('route-unavailable')
    check(signal)
  }
  async function publishPrimaryPin(signal?: AbortSignal, absentOnly = false) {
    await requireActive(signal)
    // Existing settings need no initialization. Avoid the shared roster write
    // lock so concurrent plugin starts cannot delay reads of that complete file.
    if (absentOnly && !(await nativeVaultFileAbsent(paths.config))) return
    const roster = await readVaultRoster(paths.roster)
    if (absentOnly && !(await nativeVaultFileAbsent(paths.config))) return
    // A default whose sign-in lapsed (needs_reauth, expired, revoked) stays
    // pinned as main so it is shown once, as main, with its state. Serving
    // is still refused separately for any vault row that is not active.
    const primaryFor = (roster: NativeVaultRosterDocument | undefined) =>
      roster?.rows.find(
        (row) =>
          (row.credentialId === NATIVE_PRIMARY_CREDENTIAL_ID ||
            row.aliases?.includes(NATIVE_PRIMARY_CREDENTIAL_ID)) &&
          row.credentialType === 'oauth' &&
          !row.stale &&
          !row.unclaimed &&
          typeof row.accountIdentity === 'string' &&
          row.accountIdentity.length > 0,
      )
    const primary = primaryFor(roster)
    const read = await store.readSettings()
    if (read.status !== 'ready') throw new NativeCustodyError('invalid-state')
    const previous = nativeVaultPrimaryPin(read.settings)
    if (
      !absentOnly &&
      ((!primary && !previous) ||
        (primary &&
          previous?.routeId === primary.routeId &&
          previous.credentialId === NATIVE_PRIMARY_CREDENTIAL_ID &&
          previous.accountIdentity === primary.accountIdentity))
    )
      return
    const assertPrimary = async () => {
      await requireActive(signal)
      const pinned = primaryFor(await readVaultRoster(paths.roster))
      if (
        pinned?.routeId !== primary?.routeId ||
        pinned?.accountIdentity !== primary?.accountIdentity
      )
        throw new NativeRuntimeError('publication-refused')
    }
    const writer = createNativePoolStore({
      paths,
      quota: nativeQuotaCodec,
      onLockEvent: options.onLockEvent,
      onStep: async (point) => {
        if (point === 'before-config-write' || point === 'before-state-write') {
          await relocation.assertNotRelocated()
          await assertPrimary()
        }
      },
    })
    await writer.updateSettings(async (settings) => {
      // Another writer may have created settings before this writer acquired
      // the settings-file lock. Initialization must leave that file untouched.
      if (absentOnly && !(await nativeVaultFileAbsent(paths.config)))
        return settings
      if (primary) {
        settings.mainAccountId = primary.routeId
        settings.claustrum = {
          primaryAccount: {
            credentialId: NATIVE_PRIMARY_CREDENTIAL_ID,
            accountId: primary.accountIdentity,
          },
        }
      } else {
        delete settings.mainAccountId
        delete settings.claustrum
      }
      return settings
    })
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
  const quotaObservations = new NativeQuotaObservations()
  const runtime: NativeVaultRuntime = {
    quotaObservations,
    drainQuotaPublications: () => quotaObservations.drain(),
    quotaLineage(routeId, credentialId, accountIdentity) {
      if (!credentialId || !accountIdentity) return undefined
      const key = JSON.stringify([routeId, credentialId, accountIdentity])
      let version = versions.get(key)
      if (version === undefined && routeId === 'main') {
        for (const [key, candidate] of versions) {
          const [, id, identity] = JSON.parse(key)
          if (id === credentialId && identity === accountIdentity)
            version = Math.max(version ?? 0, candidate)
        }
      }
      return version === undefined
        ? undefined
        : JSON.stringify([credentialId, accountIdentity, version])
    },
    watch(options) {
      check()
      if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0)
        throw new RangeError('Invalid native vault poll interval')
      const watch = { ...options }
      watchers.add(watch)
      schedulePoll()
      pollReady ??= poll()
      let closed = false
      return {
        ready: pollReady,
        close() {
          if (closed) return
          closed = true
          watchers.delete(watch)
          schedulePoll()
          if (!watchers.size) {
            pollReady = undefined
            // Nothing listens for roster changes any more.
            closeRosterWatch()
          }
        },
      }
    },
    initializeSettings: () => publishPrimaryPin(undefined, true),
    async read() {
      await requireActive()
      const roster = await readVaultRoster(paths.roster)
      retainRoster(roster)
      check()
      return roster
    },
    async refresh(signal) {
      check(signal)
      if (!(await active())) return undefined
      check(signal)
      // Abort this caller's wait, not the discovery operation: another caller
      // may still need the result of that shared operation.
      if (!refreshing)
        observeLock?.({
          type: 'acquiring',
          name: 'claustrum-roster',
          path: paths.roster,
        })
      refreshing ??= refreshVaultRoster({
        path: paths.roster,
        custody: options.discover ? { discover: options.discover } : custody,
        signal: shutdown.signal,
        // Common-auth asks again under the roster write lock before it stages
        // a new roster; false there publishes nothing.
        isActive: async () =>
          (await active()) && !(await relocation.isRelocated()),
        projection: () => ({ reservedRouteIds }),
      })
        .then(async (roster) => {
          retainNativeVaultRoster(paths.roster, roster)
          // Publish the primary account pin once for the shared discovery refresh,
          // rather than once for each caller waiting for that refresh.
          await publishPrimaryPin(shutdown.signal)
          return roster
        })
        .finally(() => {
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
      retainRoster(roster)
      const row = await rowFor(roster, logicalId)
      if (row?.credentialType !== 'oauth' || !row.accountIdentity)
        throw new NativeCustodyError('route-unavailable')
      if (!row.enabled) throw new NativeCustodyError('route-declined')
      if (!nativeAccountCanServe(row))
        throw new NativeCustodyError('not-active')
      const receipt = await custody.authorize(
        {
          credentialId: row.credentialId,
          accountIdentity: row.accountIdentity,
        },
        combined,
      )
      await requireActive(combined)
      const currentRoster = await readVaultRoster(paths.roster)
      retainRoster(currentRoster)
      const current = await rowFor(currentRoster, logicalId)
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
      if (!nativeAccountCanServe(current))
        throw new NativeCustodyError('not-active')
      // No receipt leaves once the dataset has moved. A credential issued
      // just before the move is harmless: the vault keeps the token and
      // reissues it per send, and nothing is written here.
      await relocation.assertNotRelocated()
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
    async prepareRetry(served, signal, site) {
      const route = requireIssued(served)
      if (served.fromKeptReceipt) {
        custody.forget(served.credentialId)
        return { retry: false, reason: 'reauthorize-failed' }
      }
      // Return the retry decision with any fresh receipt, including a refused
      // one, so diagnostics can record the newly observed recordVersion.
      const decide = async (): Promise<
        [NativeCustodyRetry, NativeCustodyReceipt | undefined]
      > => {
        if (retryUsed.has(served))
          return [{ retry: false, reason: 'version-not-newer' }, undefined]
        retryUsed.add(served)
        let next: NativeCustodyReceipt
        try {
          next = await runtime.authorize(route.logicalId, signal)
        } catch (error) {
          check(signal)
          const code =
            error instanceof NativeCustodyError ? error.code : 'unavailable'
          return [
            { retry: false, reason: 'reauthorize-failed', code },
            undefined,
          ]
        }
        if (next.credentialId !== served.credentialId)
          return [{ retry: false, reason: 'credential-changed' }, next]
        if (next.assertedAccountIdentity !== served.assertedAccountIdentity)
          return [{ retry: false, reason: 'account-changed' }, next]
        if (
          next.fromKeptReceipt ||
          !(next.recordVersion > served.recordVersion)
        )
          return [{ retry: false, reason: 'version-not-newer' }, next]
        // Mark the retry-issued receipt too, so handing it back cannot restart
        // the request's one permitted strict-newer-version 401 retry.
        retryUsed.add(next)
        return [{ retry: true, receipt: next }, next]
      }
      const [result, current] = await decide()
      // Record each retry decision so a 401 reported against an old version
      // can be matched with the vault refresh that replaced it. The credential
      // id and versions identify the record; no token or raw error is logged.
      if (site)
        logger.debug('claustrum', 'scoped 401 re-authorized', {
          site,
          credentialId: served.credentialId,
          servedVersion: served.recordVersion,
          currentVersion: current?.recordVersion ?? null,
          retry: result.retry,
          reason: result.retry ? 'rotated' : result.reason,
        })
      return result
    },
    publish(receipt, rawPatch) {
      const patch = captureNativeMetadataPatch(rawPatch)
      return mutateReceipt(
        receipt,
        (old) => {
          if (
            patch.quota &&
            patch.quota.source !== 'headers' &&
            old.quota &&
            quotaSnapshotCheckedAt(fromNativeQuotaMap(old.quota)) >
              quotaSnapshotCheckedAt(patch.quota)
          )
            throw new NativeRuntimeError('runtime-conflict')
          return applyNativeMetadataPatch(old, patch)
        },
        recencyOnly(patch) ? 'skip' : 'refuse',
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
    async fetchQuota(routeId, fetchImpl = fetch, signal, dispatch, purpose) {
      const row = await rowFor(await runtime.read(), routeId)
      // A background sweep asks insula about the roster row's account (its
      // list_scoped account_id) before any credential is fetched.
      let swept: InsulaQuotaResult<InsulaClaudeQuota> | undefined
      if (purpose === 'background' && row) {
        await refreshInsula()
        check(signal)
        swept = insulaLookup(row.accountIdentity)
        if (swept.miss === 'cold' || swept.miss === 'upstream-failed') {
          noteQuotaSource(row.routeId, 'skipped', swept.miss)
          throw new QuotaRefreshDeferred()
        }
      }
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
        async (receipt, transport) => {
          // A served receipt is still needed with an insula reading: the
          // reading is published bound to this credential version.
          let reading: InsulaClaudeQuota | undefined
          let lookup: InsulaQuotaResult<InsulaClaudeQuota> = {
            miss: 'unreachable',
          }
          let accountChanged = false
          if (purpose === 'background') {
            // The sweep joined the roster row's account; publish it only for
            // a credential served for that same account.
            if (
              swept &&
              row?.accountIdentity &&
              receipt.assertedAccountIdentity === row.accountIdentity
            )
              lookup = swept
            else if (swept) accountChanged = true
          } else if (purpose === 'admission') {
            // Only the account id the vault asserted for this credential.
            lookup = insulaLookup(receipt.assertedAccountIdentity)
          }
          // Admission polls on every miss except an upstream failure. A dated
          // reading attached to that failure avoids another GET to a refusing account.
          reading =
            !lookup.miss ||
            (purpose === 'admission' && lookup.miss === 'upstream-failed')
              ? lookup.reading
              : undefined
          if (purpose)
            noteQuotaSource(
              row?.routeId ?? routeId,
              reading
                ? 'insula'
                : lookup.miss === 'upstream-failed'
                  ? 'skipped'
                  : 'fallback',
              accountChanged
                ? 'account-changed'
                : (lookup.miss ?? 'insula-reading'),
            )
          if (reading) {
            const stored = matchingBefore(receipt)?.quota
            return mergeInsulaQuota(
              reading,
              stored ? fromNativeQuotaMap(stored) : undefined,
            )
          }
          if (purpose === 'admission' && lookup.miss === 'upstream-failed')
            return undefined
          return fetchOAuthQuotaSnapshot({
            accessToken: receipt.accessToken,
            fetchImpl: transport,
            now: options.now,
          })
        },
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
        dispatch,
      )
      if (!result.value) throw new QuotaRefreshDeferred()
      const quota = {
        ...result.value,
        accountIdentity: result.receipt.assertedAccountIdentity,
      }
      const accountUuid = result.receipt.assertedAccountIdentity
      if (!accountUuid) throw new NativeCustodyError('identity-unasserted')
      const matched = matchingBefore(result.receipt)
      const checkedAt = quota.checkedAt ?? options.now?.() ?? Date.now()
      const quotaErrorClearedAt = Math.max(
        checkedAt,
        matched?.quotaErrorClearedAt ?? 0,
        matched?.lastQuotaRefreshError?.checkedAt ?? 0,
      )
      void quotaObservations.publish(
        routeId,
        {
          lineage: JSON.stringify([
            result.receipt.credentialId,
            result.receipt.accountIdentity,
            result.receipt.recordVersion,
          ]),
          accountUuid,
          entry: { quota, checkedAt, refreshAfter: checkedAt },
          generalExhausted: nativePollQuotaGenerallyExhausted(quota),
          quotaErrorClearedAt,
        },
        () => runtime.publish(result.receipt, { quota, quotaErrorClearedAt }),
      )
      return quota
    },
    async fetchProfile(routeId, fetchImpl = fetch, signal) {
      const result = await readProfile(routeId, fetchImpl, signal)
      await runtime.publish(result.receipt, { profile: result.value })
      return result.value
    },
    async fetchProfileForDisplay(routeId, fetchImpl = fetch, signal) {
      const result = await readProfile(routeId, fetchImpl, signal)
      return nativeDisplayProfile(
        result.value,
        () => runtime.publish(result.receipt, { profile: result.value }),
        currentDisplaySubject(result.receipt),
      )
    },
    async setEnabled(routeId, enabled) {
      await requireActive()
      const roster = await readVaultRoster(paths.roster)
      const row = await rowFor(roster, routeId)
      if (!row) throw new NativeCustodyError('route-unavailable')
      // Update acceptance and the enabled flag together under the roster write
      // lock. Compare that held flag before changing it so repeated enable or
      // disable calls report no change. Enabling removes this credential/account
      // pair from declined entries; disabling adds it so discovery cannot enable
      // it again.
      const changed = await mutateVaultRoster(paths.roster, async (current) => {
        // Runs under the roster write lock, which a mover holds while it
        // replaces the runtime files with tombstones.
        await relocation.assertNotRelocated()
        const held = current?.rows.find(
          (entry) => entry.routeId === row.routeId,
        )
        if (!current || !held)
          throw new ClaustrumConsumerError(
            'route-unavailable',
            'Claustrum route is not in the roster',
          )
        if (!enabled) custody.forget(held.credentialId)
        return {
          next: {
            ...current,
            declined: enabled
              ? acceptAccount(
                  current.declined,
                  [held.credentialId, ...(held.aliases ?? [])],
                  held.accountIdentity,
                )
              : declineAccount(
                  current.declined,
                  held.credentialId,
                  held.accountIdentity,
                ),
            rows: current.rows.map((entry) =>
              entry === held ? { ...entry, enabled } : entry,
            ),
          },
          result: held.enabled !== enabled,
        }
      })
      retainNativeVaultRoster(paths.roster, await readVaultRoster(paths.roster))
      return changed
    },
    close() {
      watchers.clear()
      closeRosterWatch()
      schedulePoll()
      if (shutdown.signal.aborted) return
      shutdown.abort(new NativeCustodyError('closed'))
      unwatchAuthority()
      closeCustody()
      return store.close()
    },
  }
  function currentDisplaySubject(receipt: NativeCustodyReceipt) {
    const { routeId, logicalId } = requireIssued(receipt)
    // Keep only route, account ID, credential ID and version for later checks.
    // Checking a display must not acquire or retain an access token.
    const subject = {
      routeId,
      logicalId,
      credentialId: receipt.credentialId,
      accountIdentity: receipt.assertedAccountIdentity,
      recordVersion: receipt.recordVersion,
    }
    const key = JSON.stringify([
      routeId,
      subject.credentialId,
      subject.accountIdentity,
    ])
    return async () => {
      await requireActive()
      const row = await rowFor(
        await readVaultRoster(paths.roster),
        subject.logicalId,
      )
      if (
        !row ||
        !nativeAccountCanServe(row) ||
        row.routeId !== subject.routeId ||
        row.accountIdentity !== subject.accountIdentity ||
        (row.credentialId !== subject.credentialId &&
          !row.aliases?.includes(subject.credentialId)) ||
        (versions.get(key) ?? 0) > subject.recordVersion
      )
        return false
      const read = await readNativeRuntime(paths.runtime, paths.storageId)
      if (read.status === 'missing') return true
      if (read.status !== 'ready') return false
      const binding = read.state.accounts[subject.routeId]?.binding
      return (
        !binding ||
        (binding.kind === 'custody' &&
          binding.accountIdentity === subject.accountIdentity &&
          binding.credentialId === subject.credentialId &&
          binding.recordVersion <= subject.recordVersion)
      )
    }
  }

  /**
   * `onSuperseded` chooses what happens when this process issues a newer
   * version of the receipt's credential while the write is staged: 'refuse'
   * fails the write, 'skip' resolves false without writing. Account, custody
   * and lease checks refuse the write in both cases.
   */
  async function mutateReceipt(
    receipt: NativeCustodyReceipt,
    change: (old: NativeRuntimeEntry) => NativeRuntimeEntry,
    onSuperseded: 'refuse' | 'skip' = 'refuse',
  ): Promise<boolean> {
    const route = requireIssued(receipt)
    await requireActive()
    const key = JSON.stringify([
      route.routeId,
      receipt.credentialId,
      receipt.assertedAccountIdentity,
    ])
    if ((versions.get(key) ?? 0) > receipt.recordVersion) return false
    const row = await rowFor(
      await readVaultRoster(paths.roster),
      route.logicalId,
    )
    if (
      !row?.accountIdentity ||
      row.routeId !== route.routeId ||
      row.accountIdentity !== receipt.assertedAccountIdentity ||
      (row.credentialId !== receipt.credentialId &&
        !row.aliases?.includes(receipt.credentialId))
    )
      return false
    const accountIdentity = row.accountIdentity
    let kept = false
    try {
      const outcome = await updateNativeRuntimeOptional(
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
            binding.accountIdentity === receipt.assertedAccountIdentity &&
            (binding.credentialId === row.credentialId ||
              row.aliases?.includes(binding.credentialId))
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
          onLockEvent: options.onLockEvent,
          beforeRename: async () => {
            await requireActive()
            const pinned = await rowFor(
              await readVaultRoster(paths.roster),
              route.logicalId,
            )
            if (
              !pinned ||
              pinned.routeId !== route.routeId ||
              pinned.accountIdentity !== receipt.assertedAccountIdentity ||
              (pinned.credentialId !== receipt.credentialId &&
                !pinned.aliases?.includes(receipt.credentialId))
            )
              throw new NativeRuntimeError('publication-refused')
            const superseded = (versions.get(key) ?? 0) > receipt.recordVersion
            if (superseded && onSuperseded === 'refuse')
              throw new NativeRuntimeError('runtime-conflict')
            return superseded ? 'skip' : 'publish'
          },
        },
      )
      if (outcome.status === 'skipped') return false
    } catch (error) {
      if (
        error instanceof NativeRuntimeError &&
        error.code === 'runtime-conflict'
      )
        return false
      throw error
    }
    return kept
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
    dispatch?: QuotaRequestDispatch,
  ) {
    const combined = signalFor(signal)
    let served = await runtime.authorize(routeId, combined)
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
        await requireActive(combined)
        const route = requireIssued(served)
        const current = await rowFor(
          await readVaultRoster(paths.roster),
          route.logicalId,
        )
        const key = JSON.stringify([
          route.routeId,
          served.credentialId,
          served.assertedAccountIdentity,
        ])
        if (
          !current ||
          !nativeAccountCanServe(current) ||
          current.routeId !== route.routeId ||
          current.accountIdentity !== served.assertedAccountIdentity ||
          (current.credentialId !== served.credentialId &&
            !current.aliases?.includes(served.credentialId)) ||
          (versions.get(key) ?? served.recordVersion) > served.recordVersion
        )
          throw new NativeCustodyError('identity-changed')
        await requireActive(combined)
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
          // Body cleanup can await. Complete it before final retry admission
          // so a decline or revocation during it wins.
          await response.body?.cancel().catch(() => {})
          const report = (receipt: NativeCustodyReceipt) =>
            runtime.reportFailure(receipt, 401, 'direct').catch(() => {
              check(combined)
            })
          // Ask for a strictly newer version before reporting anything. When
          // one exists the served version is already obsolete, so only the
          // receipt whose response is final may be reported as rejected.
          const rejected = served
          let retry: NativeCustodyRetry
          try {
            retry = await runtime.prepareRetry(
              rejected,
              combined,
              'quota-profile',
            )
          } catch (error) {
            await report(rejected)
            throw error
          }
          if (!retry.retry) {
            await report(rejected)
            return response
          }
          served = retry.receipt
          const headers = new Headers(init?.headers)
          headers.set('authorization', `Bearer ${served.accessToken}`)
          responseStatus = undefined
          // A transport failure here propagates unreported: it is not evidence
          // that the newer version was rejected.
          response = await send(input, { ...init, headers })
          responseStatus = response.status
          if (response.status === 401) await report(served)
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
  function readProfile(
    routeId: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal | undefined,
  ) {
    return fetchReading(routeId, fetchImpl, signal, (receipt, transport) =>
      fetchOAuthAccountProfile({
        accessToken: receipt.accessToken,
        accountIdentity: receipt.assertedAccountIdentity,
        fetchImpl: transport,
        now: options.now,
        signal,
      }),
    )
  }
  return runtime
}

/**
 * True when a metadata patch records only when the account was last used.
 * That time is advisory: if a newer credential version is issued while the
 * write is staged, dropping the write loses nothing a later write needs, so
 * such a write is skipped rather than failed. Any other field keeps the strict
 * behaviour, even when combined with lastUsed.
 */
function recencyOnly(patch: NativeAccountMetadataPatch): boolean {
  const keys = Object.keys(patch)
  return (
    keys.length === 1 &&
    keys[0] === 'lastUsed' &&
    typeof patch.lastUsed === 'number'
  )
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

const shared = new NativeRuntimeRegistry<NativeVaultRuntime>()

export function nativeVaultRuntimeKey(
  options: NativeVaultRuntimeOptions,
): string {
  return JSON.stringify([
    nativeRuntimeStorageKey(options),
    options.identity
      ? Object.entries(options.identity).sort(([a], [b]) => a.localeCompare(b))
      : undefined,
    ...[
      options.connect,
      options.discover,
      options.readToken,
      options.now,
      options.onLockEvent,
      options.setTimeout,
      options.clearTimeout,
      options.onRosterNoticeHandled,
    ].map(nativeRuntimeOptionIdentity),
  ])
}

/** Each handle owns one reference; disposing it cannot close another host session. */
export function acquireNativeVaultRuntime(
  options: NativeVaultRuntimeOptions,
): NativeVaultRuntime {
  const { use, close } = shared.acquire(nativeVaultRuntimeKey(options), () =>
    createNativeVaultRuntime(options),
  )
  return leaseNativeVaultRuntime(use, close)
}

/** Each account lease wraps the shared vault runtime and tracks its own subscriptions, so releasing the lease removes those subscriptions. */
export function leaseNativeVaultRuntime(
  use: () => NativeVaultRuntime,
  close: () => void | Promise<void>,
): NativeVaultRuntime {
  const watches = new Set<NativeVaultWatch>()
  const quotaObservations = use().quotaObservations
  return {
    quotaObservations,
    drainQuotaPublications: () => quotaObservations.drain(),
    quotaLineage: (routeId, credentialId, accountIdentity) =>
      use().quotaLineage(routeId, credentialId, accountIdentity),
    watch: (options) => {
      const watch = use().watch(options)
      watches.add(watch)
      return {
        ready: watch.ready,
        close() {
          watches.delete(watch)
          watch.close()
        },
      }
    },
    initializeSettings: () => use().initializeSettings(),
    read: () => use().read(),
    refresh: (signal) => use().refresh(signal),
    authorize: (id, signal) => use().authorize(id, signal),
    reportFailure: (receipt, status, source) =>
      use().reportFailure(receipt, status, source),
    prepareRetry: (receipt, signal, site) =>
      use().prepareRetry(receipt, signal, site),
    publish: (receipt, patch) => use().publish(receipt, patch),
    fetchQuota: (id, transport, signal, dispatch, purpose) =>
      use().fetchQuota(id, transport, signal, dispatch, purpose),
    fetchProfile: (id, transport, signal) =>
      use().fetchProfile(id, transport, signal),
    fetchProfileForDisplay: (id, transport, signal) =>
      use().fetchProfileForDisplay(id, transport, signal),
    setEnabled: (id, enabled) => use().setEnabled(id, enabled),
    resetBackoff: (receipt, kind) => use().resetBackoff(receipt, kind),
    getOrCreateAuthLineage: (receipt) => use().getOrCreateAuthLineage(receipt),
    incrementPrimeUsage: (receipt, delta) =>
      use().incrementPrimeUsage(receipt, delta),
    close() {
      for (const watch of watches) watch.close()
      watches.clear()
      return close()
    },
  }
}
