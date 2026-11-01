import { resolve } from 'node:path'
import {
  acquireNativeAccountRuntime,
  createNativeUsagePublisher,
  decidePiStateLayout,
  getAccountStatePath,
  getHostClaustrumEnrollmentPaths,
  getPersistedLogLevel,
  isKillswitchEnabled,
  killswitchPassesPolicy,
  LEGACY_STATE_LAYOUT,
  logger,
  NativeAccountRefusal,
  type NativeAccountRuntime,
  type NativeAccountRuntimeOptions,
  type NativeAccountSnapshot,
  type NativeCustodyClient,
  type NativeCustodyReceipt,
  type NativeCustodyReporterSource,
  type NativeHolderRegistration,
  type NativeLocalExternalPolicy,
  type NativePoolPaths,
  type NativeRefreshResult,
  type NativeVaultWatch,
  nativeAccountCanServe,
  nativeAccountRefusal,
  nativeLocalAccountRefusal,
  nativeMigrationAuthorityPhase,
  nativeRuntimeOptionIdentity,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  readNativeAccountsForRequest,
  readNativeMigrationJournal,
  resolveClaustrumConnectionPath,
  resolveLocalRoutingDestination,
  resolveNativePoolPaths,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import {
  getPiAccountStoragePath,
  getPiClaustrumConnectionOptions,
  getPiConfigDir,
  requirePiNativeHostAuth,
} from './paths.ts'

export type PiNativeAttempt =
  | {
      source: 'local'
      accountIdentity: string
      admission: Extract<NativeRefreshResult, { status: 'usable' }>
    }
  | {
      source: 'vault'
      accountIdentity: string
      receipt: NativeCustodyReceipt
    }

export function piAttemptAccessToken(attempt: PiNativeAttempt): string {
  return attempt.source === 'vault'
    ? attempt.receipt.accessToken
    : attempt.admission.access
}

function requestPolicy(routeId: string, modelId?: string) {
  return (
    account: NativeAccountSnapshot['accounts'][number],
    current: NativeAccountSnapshot,
  ): NativeLocalExternalPolicy => {
    if (!nativeAccountCanServe(account))
      return { status: 'blocked', reason: 'account-disabled' }
    if (account.source === 'local' && current.mode !== 'local')
      return { status: 'blocked', reason: 'local-mode-unavailable' }
    const storage = current.policyStorage
    const needsQuotaPolicy =
      quotaSnapshotHasStandardWindows(account.quota) &&
      (account.source !== 'vault' ||
        Boolean(storage.quota?.minimumRemaining) ||
        isKillswitchEnabled(storage))
    const blocked =
      (isKillswitchEnabled(storage) &&
        !killswitchPassesPolicy(
          account.quota,
          storage,
          routeId === 'main' ? undefined : routeId,
          modelId,
        )) ||
      (routeId !== 'main' &&
        ((needsQuotaPolicy &&
          !quotaSnapshotPassesPolicy(account.quota, storage)) ||
          !quotaSnapshotPassesModelScope(account.quota, modelId)))
    return blocked
      ? { status: 'blocked', reason: 'quota-ineligible' }
      : { status: 'allowed' }
  }
}

const runtimes = new Map<
  string,
  { contextKey: string; storagePath: string; runtime: PiNativeRuntime }
>()
const RUNTIME_LIMIT = 16
const closingRuntimes = new Map<string, Set<Promise<void>>>()

function closeRuntime(entry: {
  storagePath: string
  runtime: PiNativeRuntime
}) {
  const closing = entry.runtime.close()
  const pending =
    closingRuntimes.get(entry.storagePath) ?? new Set<Promise<void>>()
  closingRuntimes.set(entry.storagePath, pending)
  pending.add(closing)
  void closing.then(
    () => {
      pending.delete(closing)
      if (!pending.size) closingRuntimes.delete(entry.storagePath)
    },
    () => {},
  )
}

function runtimeCacheKey(storagePath: string) {
  const enrollment = getHostClaustrumEnrollmentPaths('pi')
  return JSON.stringify([
    resolve(storagePath),
    resolve(getAccountStatePath(storagePath)),
    resolve(getPiConfigDir()),
    enrollment.tokenPath,
    enrollment.statePath,
    getPiClaustrumConnectionOptions(storagePath).identity,
    resolve(
      resolveClaustrumConnectionPath(
        process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE,
        {
          ...process.env,
          OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE: undefined,
        },
      ),
    ),
  ])
}

/**
 * Core's refusal for an install that offline setup has never migrated, such
 * as a 1.x install upgraded in place. Core does not export the error class,
 * so it is matched by name and code; no other error matches.
 */
export function isNativeMigrationRequired(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === 'NativeAuthorityError' &&
    Reflect.get(error, 'code') === 'migration-required'
  )
}

/** Checks Pi host authentication and enrollment before delegating credential authorization and metadata writes to the shared account runtime. */
/** How often Pi asks the vault for account changes, matching OpenCode's default. Model requests no longer rediscover a healthy roster, so this poll is how Pi notices a re-login or a newly added account. */
export const PI_VAULT_POLL_INTERVAL_MS = 2000

export interface PiVaultPollOptions {
  /** 0 disables the poll. */
  intervalMs: number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

export class PiNativeRuntime {
  private readonly pendingReports = new Set<Promise<void>>()

  /** Join started failure reports, never model sends waiting for headers. */
  async drainReports(): Promise<void> {
    while (this.pendingReports.size)
      await Promise.allSettled([...this.pendingReports])
  }

  private readonly paths: Promise<NativePoolPaths>
  private readonly holderRegistration: Promise<NativeHolderRegistration>
  private readonly initialization: Promise<NativeAccountRuntime>
  private readonly env: NodeJS.ProcessEnv
  private vaultWatch: NativeVaultWatch | undefined
  private closed = false
  private closing: Promise<void> | undefined
  readonly usagePublications = createNativeUsagePublisher('native-auth')
  private readonly routingPublications = new Set<{ drain(): Promise<void> }>()

  ownRoutingPublications(router: { drain(): Promise<void> }) {
    this.routingPublications.add(router)
  }

  async drainRoutingPublications() {
    await Promise.all([
      ...[...this.routingPublications].map((router) => router.drain()),
      this.initialization.then(
        (runtime) => runtime.drainRoutingPublications(),
        () => {},
      ),
    ])
  }

  constructor(
    storagePath: string,
    options: {
      connect?: () => Promise<NativeCustodyClient>
      local?: NativeAccountRuntimeOptions['local']
      vaultPoll?: PiVaultPollOptions
    } = {},
  ) {
    const env = { ...process.env }
    this.env = env
    const poll = options.vaultPoll ?? { intervalMs: PI_VAULT_POLL_INTERVAL_MS }
    const identity = getPiClaustrumConnectionOptions(storagePath).identity
    // Pi's files never move, so they are always resolved in the legacy
    // layout, whatever an OpenCode start in this process decided.
    this.paths = resolveNativePoolPaths(
      storagePath,
      undefined,
      LEGACY_STATE_LAYOUT,
    )
    // Pi's part of the layout decision records that this process uses these
    // files before any pool I/O, so a later version never moves them while
    // it runs. A refusal (the files were moved, an override points into a
    // managed folder, or the record could not be written) fails
    // initialization, which every request then reports.
    this.holderRegistration = this.paths.then(async (paths) => {
      const decision = await decidePiStateLayout({
        paths,
        role: 'pi',
        onLockEvent: options.local?.onLockEvent,
      })
      return decision.registration
    })
    void this.holderRegistration.catch(() => {})
    this.initialization = this.holderRegistration.then(async () => {
      const paths = await this.paths
      const runtime = acquireNativeAccountRuntime({
        paths,
        host: 'pi',
        local: options.local,
        vault: {
          // Core checks Pi enrollment and reads a fresh scoped receipt on every send.
          // Keep the injected connector's identity rather than wrapping it per instance.
          connect: options.connect,
          env,
          identity,
        },
      })
      // Apply local or vault preferences before the watcher can log. Match
      // OpenCode's startup precedence without blocking migration refusals.
      try {
        const initial = await runtime.read()
        if (!env.OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL)
          setLogLevel(getPersistedLogLevel(initial.policyStorage) ?? 'info')
      } catch {}
      if (this.closed) runtime.close()
      // Refresh returns at once while this host uses local accounts, so the
      // poll costs one enrollment read per tick outside vault custody.
      else if (poll.intervalMs > 0) {
        this.vaultWatch = runtime.vault.watch({
          intervalMs: poll.intervalMs,
          setInterval: poll.setInterval,
          clearInterval: poll.clearInterval,
        })
        // A failed first discovery must not surface as an unhandled rejection;
        // the next poll or a request's bounded refresh retries it.
        void this.vaultWatch.ready.catch(() => {})
      }
      return runtime
    })
    // Initialization is lazy from the host's perspective; a path failure is
    // surfaced by service(), not as an unhandled background rejection.
    void this.initialization.catch(() => {})
  }

  async service(): Promise<NativeAccountRuntime> {
    if (this.closed) throw new Error('Pi native authentication is closed')
    await requirePiNativeHostAuth()
    const runtime = await this.initialization
    if (this.closed) throw new Error('Pi native authentication is closed')
    return runtime
  }

  async routingPath(): Promise<string> {
    return (await this.routingStorage()).path
  }

  async routingStorage(): Promise<{
    path: string
    vaultSeed?: NativeAccountSnapshot['routingSeed']
  }> {
    const runtime = await this.service()
    const snapshot = await runtime.read()
    if (snapshot.mode === 'claustrum') {
      if (!snapshot.routingPath)
        throw new Error('Vault routing storage is unavailable')
      return { path: snapshot.routingPath, vaultSeed: snapshot.routingSeed }
    }
    // Keep local session-to-account assignments at the exact file destination
    // recorded by migration; guessing a new path would lose those assignments.
    const paths = await this.paths
    const journal = await readNativeMigrationJournal(paths)
    if (!journal || !nativeMigrationAuthorityPhase(journal))
      throw new Error('Pi native routing requires committed offline migration')
    if (journal.kind === 'empty-init')
      return { path: resolveLocalRoutingDestination('pi', paths, this.env) }
    if (!journal.routingPaths.destination)
      throw new Error('Pi native routing requires committed offline migration')
    return { path: journal.routingPaths.destination }
  }

  /**
   * Return the account runtime's migration-refusal error when local credentials
   * have not been migrated by offline setup, or undefined when no such refusal
   * occurs. Bypass the Pi login check in service() so older installations with
   * a stored Pi login are recognized too. An enrolled vault may initialize its
   * public settings on this read; local storage is never changed.
   */
  async migrationRefusal(): Promise<Error | undefined> {
    if (this.closed) return undefined
    try {
      await (await this.initialization).read()
      return undefined
    } catch (error) {
      return isNativeMigrationRequired(error) ? error : undefined
    }
  }

  /** Read the published inventory even when no account can serve, so /claude can show its sign-in remedy. */
  async view(signal?: AbortSignal): Promise<NativeAccountSnapshot> {
    const runtime = await this.service()
    signal?.throwIfAborted()
    return runtime.read()
  }

  /** Admit a model request without rediscovering a healthy roster. */
  async requestView(signal?: AbortSignal): Promise<NativeAccountSnapshot> {
    const runtime = await this.service()
    return readNativeAccountsForRequest(runtime, signal)
  }

  async authorize(
    routeId: string,
    signal?: AbortSignal,
    modelId?: string,
    intent: 'serve' | 'cachekeep' = 'serve',
  ): Promise<PiNativeAttempt> {
    const background = intent === 'cachekeep'
    const runtime = await this.service()
    const snapshot = await runtime.read()
    const account = snapshot.accounts.find(
      (candidate) => candidate.id === routeId,
    )
    if (!nativeAccountCanServe(account) || account?.type !== 'oauth')
      throw background
        ? new NativeAccountRefusal('account-unavailable')
        : new Error('Pi native OAuth route is unavailable')
    const policy = requestPolicy(routeId, modelId)
    if (policy(account, snapshot).status === 'blocked')
      throw background
        ? new NativeAccountRefusal('account-policy')
        : new Error('Pi native quota policy refused the OAuth route')
    if (snapshot.mode === 'claustrum') {
      const receipt = await runtime
        .authorizeVault(routeId, signal)
        .catch((error) => {
          const refusal = background && nativeAccountRefusal(error)
          throw refusal || error
        })
      if (!receipt.assertedAccountIdentity)
        throw background
          ? new NativeAccountRefusal('account-unavailable')
          : new Error('Pi native OAuth identity is unasserted')
      const current = await runtime.read()
      const admitted = current.accounts.find(
        (candidate) => candidate.id === routeId,
      )
      // After the vault lookup, recheck quota limits for this request’s model.
      // A policy refusal must not report the OAuth token as invalid.
      if (
        !admitted ||
        current.mode !== 'claustrum' ||
        admitted.accountIdentity !== receipt.assertedAccountIdentity ||
        requestPolicy(routeId, modelId)(admitted, current).status === 'blocked'
      )
        throw background
          ? new NativeAccountRefusal(
              !admitted || current.mode !== 'claustrum'
                ? 'account-unavailable'
                : admitted.accountIdentity !== receipt.assertedAccountIdentity
                  ? 'credential-changed'
                  : 'account-policy',
            )
          : new Error('Pi native quota policy refused the OAuth route')
      return {
        source: 'vault',
        accountIdentity: receipt.assertedAccountIdentity,
        receipt,
      }
    }
    const admission = await runtime.authorizeLocal(routeId, { signal, policy })
    if (admission.status !== 'usable') {
      const refusal = background && nativeLocalAccountRefusal(admission)
      if (refusal) throw refusal
      throw new Error('Pi native OAuth admission refused')
    }
    if (!admission.binding.identity)
      throw background
        ? new NativeAccountRefusal('account-unavailable')
        : new Error('Pi native OAuth admission refused')
    return {
      source: 'local',
      accountIdentity: admission.binding.identity,
      admission,
    }
  }

  async retry(
    routeId: string,
    served: PiNativeAttempt,
    signal?: AbortSignal,
    modelId?: string,
  ): Promise<PiNativeAttempt | undefined> {
    const runtime = await this.service()
    if (served.source === 'vault') {
      const current = await runtime.read()
      const account = current.accounts.find(
        (candidate) => candidate.id === routeId,
      )
      if (
        !account ||
        current.mode !== 'claustrum' ||
        requestPolicy(routeId, modelId)(account, current).status === 'blocked'
      )
        return undefined
      const decision = await runtime.vault.prepareRetry(served.receipt, signal)
      logger.debug('native-auth', 'Pi 401 retry decision', {
        source: 'vault',
        servedVersion: served.receipt.recordVersion,
        currentVersion: decision.retry
          ? decision.receipt.recordVersion
          : undefined,
        retry: decision.retry,
        reason: decision.retry ? 'rotated' : decision.reason,
      })
      if (!decision.retry || !decision.receipt.assertedAccountIdentity)
        return undefined
      const after = await runtime.read()
      const admitted = after.accounts.find(
        (candidate) => candidate.id === routeId,
      )
      if (
        !admitted ||
        after.mode !== 'claustrum' ||
        admitted.accountIdentity !== decision.receipt.assertedAccountIdentity ||
        requestPolicy(routeId, modelId)(admitted, after).status === 'blocked'
      )
        return undefined
      return {
        source: 'vault',
        accountIdentity: decision.receipt.assertedAccountIdentity,
        receipt: decision.receipt,
      }
    }
    const admission = await runtime.authorizeLocal(routeId, {
      intent: 'refresh',
      rejectedAccessToken: served.admission.access,
      signal,
      policy: requestPolicy(routeId, modelId),
    })
    if (
      admission.status !== 'usable' ||
      admission.binding.identity !== served.accountIdentity ||
      admission.access === served.admission.access
    )
      return undefined
    return {
      source: 'local',
      accountIdentity: served.accountIdentity,
      admission,
    }
  }

  async report(
    served: PiNativeAttempt,
    status: number,
    source: NativeCustodyReporterSource,
  ): Promise<void> {
    if (served.source === 'vault' && status === 401) {
      // An already-served receipt can be reported while shutdown drains it.
      // Do not re-enter service admission after close has blocked new sends.
      const pending = this.initialization.then((runtime) =>
        runtime.vault.reportFailure(served.receipt, status, source),
      )
      this.pendingReports.add(pending)
      try {
        await pending
      } finally {
        this.pendingReports.delete(pending)
      }
    }
  }

  async markUsed(
    served: PiNativeAttempt,
    servingRuntime?: NativeAccountRuntime,
  ): Promise<void> {
    const runtime = servingRuntime ?? (await this.service())
    const patch = { lastUsed: Date.now() }
    if (served.source === 'vault')
      await runtime.vault.publish(served.receipt, patch)
    else await runtime.publishLocal(served.admission.subject, patch)
  }

  close(): Promise<void> {
    this.closed = true
    this.vaultWatch?.close()
    void this.holderRegistration.then(
      (registration) => registration.close(),
      () => {},
    )
    this.closing ??= (async () => {
      await this.usagePublications.drain()
      await this.drainRoutingPublications()
      this.routingPublications.clear()
      await this.initialization.then(
        async (runtime) => {
          await runtime.drainQuotaPublications()
          await runtime.drainRoutingPublications()
          await this.drainReports()
          await runtime.close()
        },
        () => {},
      )
    })()
    return this.closing
  }
}

export function getPiNativeRuntime(
  storagePath = getPiAccountStoragePath(),
  options: {
    connect?: () => Promise<NativeCustodyClient>
    local?: NativeAccountRuntimeOptions['local']
    vaultPoll?: PiVaultPollOptions
  } = {},
): PiNativeRuntime {
  const contextKey = runtimeCacheKey(storagePath)
  const key = JSON.stringify([
    contextKey,
    nativeRuntimeOptionIdentity(options.connect),
    nativeRuntimeOptionIdentity(options.local?.onLockEvent),
    nativeRuntimeOptionIdentity(options.local?.refreshToken),
    nativeRuntimeOptionIdentity(options.local?.resolveIdentity),
    nativeRuntimeOptionIdentity(options.local?.now),
  ])
  const existing = runtimes.get(key)
  if (existing) return existing.runtime
  if (!options.connect && !options.local) {
    // A supplied connector installs the context's test transport. Ordinary host
    // lookups reuse it, but an explicitly different connector owns another key.
    const configured = [...runtimes.values()].find(
      (entry) => entry.contextKey === contextKey,
    )
    if (configured) return configured.runtime
  }
  const runtime = new PiNativeRuntime(storagePath, options)
  while (runtimes.size >= RUNTIME_LIMIT) {
    const oldest = runtimes.keys().next().value
    if (oldest === undefined) break
    const evicted = runtimes.get(oldest)
    if (evicted) closeRuntime(evicted)
    runtimes.delete(oldest)
  }
  runtimes.set(key, { contextKey, storagePath: resolve(storagePath), runtime })
  return runtime
}

export function closePiNativeRuntime(
  storagePath = getPiAccountStoragePath(),
): Promise<void> {
  for (const [key, entry] of runtimes) {
    if (entry.storagePath !== resolve(storagePath)) continue
    runtimes.delete(key)
    closeRuntime(entry)
  }
  // Eviction removes cache entries before their quota drain finishes. Shutdown
  // must also join those closes, not only the runtimes still in the cache.
  return Promise.all(closingRuntimes.get(resolve(storagePath)) ?? []).then(
    () => {},
  )
}
