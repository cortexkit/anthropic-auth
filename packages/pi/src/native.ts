import {
  connectClaustrumScopedClient,
  createNativeAccountRuntime,
  isKillswitchEnabled,
  killswitchPassesPolicy,
  logger,
  type NativeAccountRuntime,
  type NativeAccountSnapshot,
  type NativeCustodyClient,
  type NativeCustodyReceipt,
  type NativeCustodyReporterSource,
  type NativeLocalExternalPolicy,
  type NativePoolPaths,
  type NativeRefreshResult,
  quotaSnapshotHasStandardWindows,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  readNativeMigrationJournal,
  resolveNativePoolPaths,
} from '@cortexkit/anthropic-auth-core'
import { requirePiEnrollment } from './custody.ts'
import {
  getPiAccountStoragePath,
  getPiClaustrumConnectionOptions,
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
    if (!account.enabled)
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

const runtimes = new Map<string, PiNativeRuntime>()
const RUNTIME_LIMIT = 16

/** Checks Pi host authentication and enrollment before delegating credential authorization and metadata writes to the shared account runtime. */
export class PiNativeRuntime {
  private readonly paths: Promise<NativePoolPaths>
  private readonly initialization: Promise<NativeAccountRuntime>
  private closed = false

  constructor(
    storagePath: string,
    options: { connect?: () => Promise<NativeCustodyClient> } = {},
  ) {
    this.paths = resolveNativePoolPaths(storagePath)
    this.initialization = this.paths.then((paths) => {
      const runtime = createNativeAccountRuntime({
        paths,
        host: 'pi',
        vault: {
          connect: async () => {
            await requirePiEnrollment()
            return options.connect
              ? options.connect()
              : connectClaustrumScopedClient(
                  getPiClaustrumConnectionOptions(storagePath),
                )
          },
        },
      })
      if (this.closed) runtime.close()
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
    // Read the recorded destination of the session-to-account routing file.
    // A guessed path would lose the account assignments preserved by migration.
    await this.service()
    const journal = await readNativeMigrationJournal(await this.paths)
    if (
      !journal ||
      (journal.phase !== 'committed' && journal.phase !== 'retired') ||
      !journal.routingPaths.destination
    )
      throw new Error('Pi native routing requires committed offline migration')
    return journal.routingPaths.destination
  }

  async view(): Promise<NativeAccountSnapshot> {
    const runtime = await this.service()
    // Refresh before reading routes so an uninitialized vault list is not
    // mistaken for a complete empty pool.
    await runtime.vault.refresh()
    return runtime.read()
  }

  async authorize(
    routeId: string,
    signal?: AbortSignal,
    modelId?: string,
  ): Promise<PiNativeAttempt> {
    const runtime = await this.service()
    const snapshot = await runtime.read()
    const account = snapshot.accounts.find(
      (candidate) => candidate.id === routeId,
    )
    if (!account?.enabled || account.type !== 'oauth')
      throw new Error('Pi native OAuth route is unavailable')
    const policy = requestPolicy(routeId, modelId)
    if (policy(account, snapshot).status === 'blocked')
      throw new Error('Pi native quota policy refused the OAuth route')
    if (snapshot.mode === 'claustrum') {
      const receipt = await runtime.authorizeVault(routeId, signal)
      if (!receipt.assertedAccountIdentity)
        throw new Error('Pi native OAuth identity is unasserted')
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
        throw new Error('Pi native quota policy refused the OAuth route')
      return {
        source: 'vault',
        accountIdentity: receipt.assertedAccountIdentity,
        receipt,
      }
    }
    const admission = await runtime.authorizeLocal(routeId, { signal, policy })
    if (admission.status !== 'usable' || !admission.binding.identity)
      throw new Error('Pi native OAuth admission refused')
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
    if (served.source === 'vault' && status === 401)
      await (await this.service()).vault.reportFailure(
        served.receipt,
        status,
        source,
      )
  }

  async markUsed(served: PiNativeAttempt): Promise<void> {
    const runtime = await this.service()
    const patch = { lastUsed: Date.now() }
    if (served.source === 'vault')
      await runtime.vault.publish(served.receipt, patch)
    else await runtime.publishLocal(served.admission.subject, patch)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    void this.initialization.then(
      (runtime) => runtime.close(),
      () => {},
    )
  }
}

export function getPiNativeRuntime(
  storagePath = getPiAccountStoragePath(),
  options: { connect?: () => Promise<NativeCustodyClient> } = {},
): PiNativeRuntime {
  const existing = runtimes.get(storagePath)
  if (existing) return existing
  const runtime = new PiNativeRuntime(storagePath, options)
  while (runtimes.size >= RUNTIME_LIMIT) {
    const oldest = runtimes.keys().next().value
    if (oldest === undefined) break
    runtimes.get(oldest)?.close()
    runtimes.delete(oldest)
  }
  runtimes.set(storagePath, runtime)
  return runtime
}

export function closePiNativeRuntime(
  storagePath = getPiAccountStoragePath(),
): void {
  runtimes.get(storagePath)?.close()
  runtimes.delete(storagePath)
}
