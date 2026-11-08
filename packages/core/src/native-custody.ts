import {
  ClaustrumConsumerError,
  ClaustrumCredentialError,
  ClaustrumScopedCustody,
  ClaustrumUnreachableError,
  classifyVaultFailure,
  connectVaultHost,
} from '@cortexkit/common-auth/claustrum'
import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'
import {
  assertHostAuthorityStable,
  isVaultHosted,
  onHostAuthorityChanged,
} from './native-vault-host.ts'

/**
 * Reads insula's quota cache from the vault daemon. Declared here with the
 * same shape as common-auth's InsulaUsageTransport so this module's published
 * declarations do not depend on common-auth.
 */
export interface NativeInsulaUsageTransport {
  connectionFile: string
  getUsage(): Promise<unknown>
  /** Hold usage.watch open; older/custom transports can omit push support. */
  watchUsage?(onNotice: (body: Uint8Array) => void): {
    stop(): void
    readonly closed: Promise<void>
  }
}

/** Claustrum IPC operations for listing accounts, reading tokens, reporting rejection, and closing the connection. */
export interface NativeCustodyClient {
  listScoped: (enrollmentToken?: string) => Promise<{
    readonly view: string
    readonly rows: readonly {
      readonly id: string
      readonly categories: readonly string[]
      readonly credentialType: string
      readonly serves: readonly string[]
      readonly providerIds: readonly string[]
      readonly authMethod?: 'apikey' | 'chatgpt' | 'antigravity' | 'oauth'
      readonly refreshAdapter?: string
      readonly state: string
      readonly recordVersion: number
      readonly operations: readonly string[]
      readonly createdAtMs: number | null
      readonly accountId?: string
      readonly email?: string
      readonly orgName?: string
    }[]
    /**
     * How many grants this enrollment holds, and which. Undefined when the
     * vault is too old to send them: unknown, never zero.
     */
    readonly grants: number | undefined
    readonly grantTuples:
      | readonly {
          readonly selectorKind: string
          readonly selector: string
          readonly operation: string
        }[]
      | undefined
  }>
  getScoped: (input: {
    credentialId: string
    enrollmentToken?: string
    minTtlMs?: number
  }) => Promise<{
    material: string
    recordVersion: number
    expiresAtMs: number | null
    credentialId?: string
    projectId?: string
    accountId?: string
    email?: string
    orgName?: string
  }>
  reportAuthFailureScoped: (input: {
    credentialId: string
    enrollmentToken?: string
    providerStatus: number
    recordVersion: number
    reporterSource: NativeCustodyReporterSource
  }) => Promise<void>
  close: () => void
  /**
   * Open one vault watch that announces changes to the accounts this
   * enrollment can see. Present from claustrum-client 0.12.0; without it the
   * host keeps listing on its own timer.
   */
  watchScoped?(
    onNotice: (notice: NativeScopedWatchNotice) => void,
    options?: { enrollmentToken?: string },
  ): NativeScopedWatchHandle
  /**
   * How to read insula's background quota cache on the same daemon. Present
   * when the connection was made with connectClaustrumScopedClient; reads and
   * watches use separate sockets and never use this connection.
   */
  insula?: NativeInsulaUsageTransport
}

/**
 * A vault watch notice. `view` is the same digest `listScoped` returns, so
 * only a different view means the visible accounts changed. Declared here,
 * like the rest of this client shape, so published declarations do not
 * depend on claustrum-client or common-auth.
 */
export interface NativeScopedWatchNotice {
  readonly kind: string
  readonly epoch: string
  readonly seq: number
  readonly view: string
}

/**
 * How a vault watch ended. `refused` carries the vault's refusal of the
 * confirming account listing (a revoked enrollment answers `not_found`);
 * `unsupported` means the vault does not know the watch method.
 */
export type NativeScopedWatchEnd =
  | { readonly kind: 'refused'; readonly error: unknown }
  | { readonly kind: 'transport_lost'; readonly error: unknown }
  | {
      readonly kind: 'ended' | 'not_accepting' | 'unsupported' | 'stopped'
    }

export interface NativeScopedWatchHandle {
  stop(): void
  readonly closed: Promise<NativeScopedWatchEnd>
}

/**
 * How the host currently learns about account changes. `watching`: a vault
 * watch is open, so the host's list timer only needs to run as a slow safety
 * net. `polling` and `fallback`: no watch is open, so the host lists at its
 * usual pace.
 */
export type NativeRosterWatchMode = 'watching' | 'polling' | 'fallback'

export interface NativeRosterWatchOptions {
  /**
   * Run the host's discovery and roster publication. Called when a notice
   * shows the visible accounts changed since the roster the host holds; one
   * call at a time, and notices that arrive meanwhile earn at most one more.
   */
  onView: (view: string) => unknown
  /** The view of the roster the host currently holds, if any. */
  view?: () => string | undefined
  onMode?: (mode: NativeRosterWatchMode) => void
  /**
   * The vault refused the watch and its confirming listing. Kept receipts are
   * already dropped, as a refused listing drops them.
   */
  onRefused?: (error: unknown) => void
  onError?: (error: unknown) => void
}

export interface NativeRosterWatch {
  readonly mode: NativeRosterWatchMode
  /** Stop the watch and its timers. Safe to call more than once. */
  close(): void
}

export type NativeCustodyReporterSource =
  | 'direct'
  | 'relay_status_field'
  | 'relay_message_parse'

export interface NativeCustodyLogger {
  warn: (message: string, data?: unknown) => void
  debug: (message: string, data?: unknown) => void
}

export interface NativeCustodyOptions {
  onConnectionChanged?: () => void
  host: 'opencode' | 'pi'
  connect: () => Promise<NativeCustodyClient>
  readToken?: () => Promise<{ token: string; token_generation: number }>
  env?: NodeJS.ProcessEnv
  now?: () => number
  logger?: NativeCustodyLogger
  /**
   * Timer functions for the custody's outage probe and roster watch retries.
   * Defaults to the global ones; tests pass their own.
   */
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

export interface NativeCustodyIdentity {
  readonly credentialId: string
  readonly accountIdentity: string
}

/** A common-auth receipt: retain its original object identity and non-enumerable accessToken. */
export interface NativeCustodyReceipt {
  readonly credentialId: string
  readonly credentialType: 'oauth'
  readonly accountIdentity?: string
  readonly accountIdentitySource: 'asserted' | 'parsed' | 'expected' | 'none'
  readonly expectedAccountIdentity?: string
  readonly assertedCredentialId?: string
  readonly assertedAccountIdentity?: string
  readonly recordVersion: number
  readonly expiresAtMs: number | null
  readonly accessToken: string
  readonly fromKeptReceipt?: true
}

export interface NativeCustodyInventory {
  readonly view: string
  readonly credentials: readonly {
    readonly credentialId: string
    readonly credentialType: 'oauth' | 'api_key'
    readonly accountIdentity?: string
    readonly state: string
    readonly email?: string
    readonly orgName?: string
  }[]
  readonly skipped: readonly {
    readonly credentialId?: string
    readonly reason:
      | 'empty credential id'
      | 'duplicate credential id'
      | 'blank account identity'
      | 'empty state'
  }[]
  /**
   * What this host's enrollment is granted, as the vault's list reply named
   * it. It explains an empty listing: `grants === 0` means no grant at all,
   * while `grants > 0` means a grant that reaches no credential. Undefined
   * means unknown (the vault predates these fields), never zero grants.
   */
  readonly grantReach?: {
    readonly grants: number
    readonly tuples: readonly {
      readonly selectorKind: string
      readonly selector: string
      readonly operation: string
    }[]
  }
}

export type NativeCustodyErrorCode =
  | 'closed'
  | 'not-enrolled'
  | 'invalid-token'
  | 'unavailable'
  | 'identity-changed'
  | 'identity-unasserted'
  | 'insufficient-validity'
  | 'invalid-material'
  | 'not-active'
  | 'route-unavailable'
  | 'route-declined'
  | 'no-receipt'
  | 'unsafe-file'
  | 'invalid-state'
  | 'wrong-consumer'
  | 'roster-busy'
  | 'host-slot-login'
  | 'host-slot-placeholder'
  | 'placeholder-refresh'
  | 'invalid-order'

function nativeCode(value: unknown): NativeCustodyErrorCode {
  switch (value) {
    case 'closed':
    case 'not-enrolled':
    case 'invalid-token':
    case 'unavailable':
    case 'identity-changed':
    case 'identity-unasserted':
    case 'insufficient-validity':
    case 'invalid-material':
    case 'not-active':
    case 'route-unavailable':
    case 'route-declined':
    case 'no-receipt':
    case 'unsafe-file':
    case 'invalid-state':
    case 'wrong-consumer':
    case 'roster-busy':
    case 'host-slot-login':
    case 'host-slot-placeholder':
    case 'placeholder-refresh':
    case 'invalid-order':
      return value
    default:
      return 'unavailable'
  }
}

export class NativeCustodyError extends Error {
  readonly code: NativeCustodyErrorCode

  constructor(code: NativeCustodyErrorCode) {
    const safeCode = nativeCode(code)
    super(`Native custody refused: ${safeCode}`)
    this.name = 'NativeCustodyError'
    this.code = safeCode
  }
}

export type NativeCustodyRetry =
  | { retry: true; receipt: NativeCustodyReceipt }
  | {
      retry: false
      reason:
        | 'reauthorize-failed'
        | 'credential-changed'
        | 'account-changed'
        | 'version-not-newer'
      code?: NativeCustodyErrorCode
    }

export interface NativeCustody {
  /** Whether a 401 needs fresh authorization because a previous relay issued the receipt. */
  isPreviousConnectionReceipt?: (receipt: NativeCustodyReceipt) => boolean
  /** Authority lifetime only; replacing a relay does not retire issued tokens. */
  readonly generation?: number
  discover: (signal?: AbortSignal) => Promise<NativeCustodyInventory>
  authorize: (
    identity: NativeCustodyIdentity,
    signal?: AbortSignal,
  ) => Promise<NativeCustodyReceipt>
  reportFailure: (
    receipt: NativeCustodyReceipt,
    status: number,
    reporterSource: NativeCustodyReporterSource,
  ) => Promise<void>
  prepareRetry: (
    served: NativeCustodyReceipt,
    signal?: AbortSignal,
  ) => Promise<NativeCustodyRetry>
  /** The shared connection's insula transport, connecting first if needed; undefined when the client has none. */
  insulaTransport: () => Promise<NativeInsulaUsageTransport | undefined>
  retain: (
    rows: readonly (NativeCustodyIdentity & {
      enabled: boolean
      state: string
    })[],
  ) => void
  forget: (credentialId: string) => void
  keptReceiptState: () => Readonly<{ active: boolean; since: number | null }>
  /**
   * Watch the vault for account changes over the shared connection instead
   * of relying on the host's list timer alone. A client or vault without the
   * watch reports `fallback`. Closing the custody closes every watch.
   */
  watchRoster: (options: NativeRosterWatchOptions) => NativeRosterWatch
  close: () => void
}

/** Share a lazy vault connection; each authorization obtains a fresh scoped OAuth receipt. */
export function createNativeCustody(
  options: NativeCustodyOptions,
): NativeCustody {
  const env = { ...(options.env ?? process.env) }
  const hosted = isVaultHosted()
  const connect = options.connect
  const logger = options.logger
  let closed = false
  let authorityChanged = false
  let revoked = false
  let client: NativeCustodyClient | undefined
  let connecting: Promise<NativeCustodyClient> | undefined
  const onClose = new Set<() => void>()
  // Weak membership rejects copied or foreign receipts without retaining them.
  // Common-auth keeps the original receipt's send-time enrollment token private.
  const receipts = new WeakMap<
    object,
    { generation: number; owner: ClaustrumScopedCustody }
  >()
  const retryUsed = new WeakSet<object>()
  const reconnectReports = new WeakSet<object>()
  let generation = 0

  function check(signal?: AbortSignal): void {
    if (authorityChanged) throw new NativeCustodyError('route-unavailable')
    if (closed) throw new NativeCustodyError('closed')
    if (hosted !== isVaultHosted())
      throw new NativeCustodyError('route-unavailable')
    signal?.throwIfAborted()
  }

  function connection(): Promise<NativeCustodyClient> {
    check()
    connecting ??= Promise.resolve()
      .then(() => (hosted ? connectVaultHost('anthropic-auth') : connect()))
      .then((owned) => {
        if (closed) {
          owned.close()
          throw new NativeCustodyError('closed')
        }
        client = owned
        return owned
      })
      .catch((error: unknown) => {
        // A later operation can recover from a failed connection. Do not retry
        // the failed operation, or discard a successfully connected owned client.
        connecting = undefined
        throw error
      })
    return connecting
  }

  async function scoped<T>(
    operation: (owned: NativeCustodyClient) => Promise<T>,
  ): Promise<T> {
    try {
      const owned = await connection()
      check()
      const ownerGeneration = generation
      const result = await operation(owned)
      check()
      if (generation !== ownerGeneration)
        throw new NativeCustodyError('route-unavailable')
      return result
    } catch (error) {
      check()
      if (
        error instanceof ClaustrumCredentialError &&
        error.code === 'enrollment_revoked'
      )
        revoked = true
      // Local shutdown and adapter validation are not evidence of a vault outage.
      if (error instanceof NativeCustodyError)
        throw new ClaustrumConsumerError(
          error.code,
          'Native custody operation refused',
        )
      if (classifyVaultFailure(error) === 'unreachable')
        throw new ClaustrumUnreachableError()
      throw error
    }
  }

  /**
   * Common-auth opens its roster watch synchronously, but our connection is
   * made lazily, so this handle connects first and then forwards to the
   * connected client's own watch. A client without `watchScoped` (before
   * claustrum-client 0.12.0) ends the watch as `unsupported`, which leaves the
   * host listing at its usual pace and opens nothing more.
   */
  function watchScoped(
    onNotice: (notice: NativeScopedWatchNotice) => void,
    watchOptions?: { enrollmentToken?: string },
  ): NativeScopedWatchHandle {
    let stopped = false
    let inner: NativeScopedWatchHandle | undefined
    let finish: (end: NativeScopedWatchEnd) => void = () => {}
    const ended = new Promise<NativeScopedWatchEnd>((resolve) => {
      finish = resolve
    })
    // A connection that fails because the vault is unreachable is a lost
    // transport (common-auth then starts its outage); anything else, such as
    // our own close, only ends this watch.
    const failed = (error: unknown): NativeScopedWatchEnd =>
      stopped || closed || error instanceof NativeCustodyError
        ? { kind: 'stopped' }
        : classifyVaultFailure(error) === 'unreachable'
          ? { kind: 'transport_lost', error: new ClaustrumUnreachableError() }
          : { kind: 'ended' }
    void Promise.resolve()
      .then(connection)
      .then(
        (owned) => {
          if (stopped || closed) return finish({ kind: 'stopped' })
          if (typeof owned.watchScoped !== 'function')
            return finish({ kind: 'unsupported' })
          try {
            inner = owned.watchScoped(onNotice, watchOptions)
          } catch (error) {
            return finish(failed(error))
          }
          inner.closed.then(finish, (error: unknown) =>
            finish({ kind: 'transport_lost', error }),
          )
        },
        (error: unknown) => finish(failed(error)),
      )
    return {
      stop() {
        if (stopped) return
        stopped = true
        if (inner) inner.stop()
        else finish({ kind: 'stopped' })
      },
      closed: ended,
    }
  }

  let primitive: ClaustrumScopedCustody | undefined
  let retained: Parameters<ClaustrumScopedCustody['retain']>[0] | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectFailures = 0
  type RelayProbe = {
    client?: NativeCustodyClient
    primitive?: ClaustrumScopedCustody
    abort: AbortController
    closed: boolean
    promoted: boolean
  }
  let probe: RelayProbe | undefined
  const setTimer = options.setTimeout ?? setTimeout
  const clearTimer = options.clearTimeout ?? clearTimeout
  const guardedTimer = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) =>
    setTimer(() => {
      try {
        check()
      } catch {
        return
      }
      callback(...args)
    }, delay)) as typeof setTimeout

  function closeProbe(held: RelayProbe) {
    if (held.closed || held.promoted) return
    held.closed = true
    held.abort.abort(new NativeCustodyError('closed'))
    try {
      if (held.primitive) held.primitive.close()
      else held.client?.close()
    } catch {
      // Closing an unavailable relay must not replace an admission refusal.
    }
  }

  function scheduleReconnect() {
    if (!hosted || closed || revoked || probe || reconnectTimer) return
    try {
      check()
    } catch {
      return
    }
    const delays = [0, 1_000, 2_000, 5_000, 10_000]
    reconnectTimer = setTimer(
      () => {
        reconnectTimer = undefined
        void reconnect()
      },
      delays[Math.min(reconnectFailures, delays.length - 1)],
    )
    reconnectTimer.unref?.()
  }

  async function reconnect() {
    if (closed || revoked || probe || !primitive) return
    const previous = primitive
    const held: RelayProbe = {
      abort: new AbortController(),
      closed: false,
      promoted: false,
    }
    probe = held
    let retry = false
    try {
      check()
      held.client = connectVaultHost('anthropic-auth')
      if (held.closed) {
        held.client.close()
        held.client = undefined
        return
      }
      check()
      held.primitive = makePrimitive(held.client)
      if (retained) held.primitive.retain(retained)
      // A new accessor result is not proof that the relay is back. Keep the
      // old primitive's expiry-bounded receipts until a real roster read works.
      // The 0.40.0 host client has no ready(); this read proves it can answer.
      await held.primitive.discover(held.abort.signal)
      check()
      if (held.closed || primitive !== previous) return
      if (previous instanceof HostedCustody && !previous.relayUnavailable)
        return
      if (retained) held.primitive.retain(retained)
      primitive = held.primitive
      client = held.client
      connecting = Promise.resolve(held.client)
      held.promoted = true
      reconnectFailures = 0
      try {
        previous.close()
      } finally {
        options.onConnectionChanged?.()
      }
    } catch (error) {
      if (
        error instanceof ClaustrumCredentialError &&
        error.code === 'enrollment_revoked'
      ) {
        revoked = true
        try {
          custody.close()
        } catch {
          /* A failed shutdown must not reject the background probe. */
        }
      }
      retry = classifyVaultFailure(error) === 'unreachable'
      if (retry) reconnectFailures++
    } finally {
      closeProbe(held)
      if (probe === held) probe = undefined
      if (retry && !held.promoted) scheduleReconnect()
    }
  }

  class HostedCustody extends ClaustrumScopedCustody {
    relayUnavailable = false
    override transportLost(error?: unknown) {
      this.relayUnavailable = true
      super.transportLost(error)
      if (primitive === this) scheduleReconnect()
    }
    override reachable() {
      this.relayUnavailable = false
      super.reachable()
    }
  }

  function makePrimitive(hostClient?: NativeCustodyClient) {
    const ScopedCustody = hosted ? HostedCustody : ClaustrumScopedCustody
    return new ScopedCustody({
      client: hostClient ?? {
        listScoped: (token) => scoped((owned) => owned.listScoped(token)),
        getScoped: (input) => scoped((owned) => owned.getScoped(input)),
        reportAuthFailureScoped: (input) =>
          scoped((owned) => owned.reportAuthFailureScoped(input)),
        watchScoped,
        close: () => client?.close(),
      },
      family: {
        refreshAdapter: 'anthropic',
        category: 'anthropic-native',
        apiKeys: false,
      },
      requireAssertion: true,
      ...(hosted
        ? {}
        : options.readToken
          ? { readToken: options.readToken }
          : {
              tokenPath: getHostClaustrumEnrollmentPaths(options.host, env)
                .tokenPath,
            }),
      now: options.now,
      // Common-auth also probes outages while idle. Fence those callbacks so
      // its own fresh marker read cannot bypass the process authority latch.
      setTimeoutImpl: hosted ? guardedTimer : setTimer,
      clearTimeoutImpl: clearTimer,
      // Supply logger callbacks so common-auth cannot select its default logger.
      // Only the fixed messages below reach the caller; record details never do.
      logger: {
        warn: () => logger?.warn('Native custody inventory record skipped'),
        debug: () => logger?.debug('Native custody failure reported'),
      },
    })
  }
  // Hosted clients are branded by common-auth. Construct custody only after
  // connecting, passing that exact object rather than the native lazy adapter.
  async function ready() {
    check()
    if (!primitive) {
      const owned = await connection()
      check()
      primitive ??= makePrimitive(owned)
      if (retained) primitive.retain(retained)
    }
    return primitive
  }
  if (!hosted) primitive = makePrimitive()

  async function run<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    check(signal)
    let stop: () => void = () => {}
    let abort: () => void = () => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new NativeCustodyError('closed'))
      abort = () => reject(signal?.reason)
      onClose.add(stop)
      signal?.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([operation(), interrupted])
      check(signal)
      return result
    } catch (error) {
      if (
        hosted &&
        error instanceof ClaustrumCredentialError &&
        error.code === 'enrollment_revoked'
      )
        revoked = true
      check(signal)
      // Copy no vault error details into public errors. Map only common-auth's
      // closed error kind; discard code, message, cause and data.
      throw new NativeCustodyError(
        error instanceof ClaustrumConsumerError
          ? nativeCode(error.kind)
          : error instanceof NativeCustodyError
            ? nativeCode(error.code)
            : 'unavailable',
      )
    } finally {
      onClose.delete(stop)
      signal?.removeEventListener('abort', abort)
      if (revoked) custody.close()
    }
  }

  function requireReceipt(receipt: NativeCustodyReceipt): void {
    if (!receipts.has(receipt)) throw new NativeCustodyError('no-receipt')
    if (receipts.get(receipt)?.generation !== generation)
      throw new NativeCustodyError('route-unavailable')
  }
  function currentPrimitive(): ClaustrumScopedCustody {
    if (!primitive) throw new NativeCustodyError('unavailable')
    return primitive
  }
  function previousConnectionReceipt(receipt: NativeCustodyReceipt): boolean {
    check()
    requireReceipt(receipt)
    return hosted && receipts.get(receipt)?.owner !== primitive
  }

  const custody: NativeCustody = {
    isPreviousConnectionReceipt: previousConnectionReceipt,
    get generation() {
      return generation
    },
    discover: (signal) =>
      run(async () => {
        await ready()
        check(signal)
        const owner = currentPrimitive()
        const inventory = await owner.discover(signal)
        return inventory
      }, signal),
    authorize: (identity, signal) =>
      run(async () => {
        // Capture only route fields before awaiting common-auth authorization.
        // Caller extras cannot override OAuth, and later mutation cannot move the route.
        const { credentialId, accountIdentity } = identity
        if (typeof credentialId !== 'string')
          throw new NativeCustodyError('unavailable')
        if (
          accountIdentity !== undefined &&
          typeof accountIdentity !== 'string'
        ) {
          throw new NativeCustodyError('unavailable')
        }
        if (!accountIdentity?.trim())
          throw new NativeCustodyError('identity-unasserted')
        await ready()
        check(signal)
        const owner = currentPrimitive()
        const receipt = await owner.authorize(
          {
            credentialId,
            accountIdentity,
            credentialType: 'oauth',
          },
          signal,
        )
        check(signal)
        receipts.set(receipt, { generation, owner })
        // Fixed OAuth input narrows common-auth's two-credential-type declaration.
        // Return the original object, preserving its non-enumerable accessToken.
        return receipt as NativeCustodyReceipt
      }, signal),
    reportFailure: (receipt, status, reporterSource) =>
      run(async () => {
        requireReceipt(receipt)
        await ready()
        check()
        requireReceipt(receipt)
        if (previousConnectionReceipt(receipt)) {
          if (status === 401 && !reconnectReports.has(receipt)) {
            reconnectReports.add(receipt)
            logger?.debug(
              'Native custody 401 crossed a relay replacement; fresh authorization required',
            )
          }
          return
        }
        await currentPrimitive().reportFailure(receipt, status, reporterSource)
      }),
    prepareRetry: async (served, signal) => {
      check(signal)
      requireReceipt(served)
      if (hosted) {
        if (retryUsed.has(served))
          return { retry: false, reason: 'version-not-newer' }
        retryUsed.add(served)
      }
      if (served.fromKeptReceipt) {
        primitive?.forget(served.credentialId)
        return { retry: false, reason: 'reauthorize-failed' }
      }
      if (served.assertedAccountIdentity === undefined) {
        throw new NativeCustodyError('no-receipt')
      }
      let current: NativeCustodyReceipt
      try {
        current = await custody.authorize(
          {
            credentialId: served.credentialId,
            accountIdentity: served.assertedAccountIdentity,
          },
          signal,
        )
      } catch (error) {
        check(signal)
        if (error instanceof NativeCustodyError && error.code === 'closed')
          throw error
        return {
          retry: false,
          reason: 'reauthorize-failed',
          code:
            error instanceof NativeCustodyError
              ? nativeCode(error.code)
              : 'unavailable',
        }
      }
      check(signal)
      requireReceipt(served)
      requireReceipt(current)
      if (current.credentialId !== served.credentialId) {
        return { retry: false, reason: 'credential-changed' }
      }
      if (current.assertedAccountIdentity !== served.assertedAccountIdentity) {
        return { retry: false, reason: 'account-changed' }
      }
      // Only a replacement relay's fresh authorization may reuse the version.
      const replacementReceipt =
        previousConnectionReceipt(served) && !previousConnectionReceipt(current)
      if (
        current.fromKeptReceipt ||
        (!replacementReceipt && !(current.recordVersion > served.recordVersion))
      ) {
        return { retry: false, reason: 'version-not-newer' }
      }
      if (hosted) retryUsed.add(current)
      return { retry: true, receipt: current }
    },
    insulaTransport: () => scoped(async (owned) => owned.insula),
    retain: (rows) => {
      assertHostAuthorityStable()
      retained = rows.map((row) => ({ ...row, credentialType: 'oauth' }))
      primitive?.retain(retained)
    },
    forget: (credentialId) => {
      assertHostAuthorityStable()
      primitive?.forget(credentialId)
    },
    keptReceiptState: () => {
      assertHostAuthorityStable()
      return primitive?.keptReceiptState() ?? { active: false, since: null }
    },
    watchRoster: (watchOptions) => {
      check()
      if (!primitive) throw new NativeCustodyError('unavailable')
      return primitive.watchRoster({
        onView: watchOptions.onView,
        ...(watchOptions.view && { view: watchOptions.view }),
        onMode: watchOptions.onMode,
        onRefused: (error) => {
          // Common-auth has already dropped every kept receipt. A revoked
          // enrollment then closes this custody, exactly as a revocation met
          // by any other vault call does.
          watchOptions.onRefused?.(error)
          if (
            error instanceof ClaustrumCredentialError &&
            error.code === 'enrollment_revoked'
          )
            custody.close()
        },
        onError: watchOptions.onError,
      })
    },
    close: () => {
      if (closed) return
      closed = true
      generation++
      unwatchHostAuthority()
      if (reconnectTimer) clearTimer(reconnectTimer)
      reconnectTimer = undefined
      if (probe) closeProbe(probe)
      for (const stop of onClose) stop()
      try {
        if (primitive) primitive.close()
        else client?.close()
      } catch (error) {
        if (!hosted) throw error
        // A dead relay's close must not reject a request or background probe.
      }
    },
  }
  const unwatchHostAuthority = onHostAuthorityChanged(() => {
    authorityChanged = true
    custody.close()
  })
  return custody
}
