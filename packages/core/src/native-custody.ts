import {
  ClaustrumConsumerError,
  ClaustrumScopedCustody,
} from '@cortexkit/common-auth/claustrum'
import { getHostClaustrumEnrollmentPaths } from './claustrum-enrollment.ts'

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
  host: 'opencode' | 'pi'
  connect: () => Promise<NativeCustodyClient>
  readToken?: () => Promise<{ token: string; token_generation: number }>
  env?: NodeJS.ProcessEnv
  now?: () => number
  logger?: NativeCustodyLogger
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
  close: () => void
}

/** Share a lazy Claustrum connection; each authorize call reads a fresh enrollment token and OAuth receipt. */
export function createNativeCustody(
  options: NativeCustodyOptions,
): NativeCustody {
  const env = { ...(options.env ?? process.env) }
  const connect = options.connect
  const logger = options.logger
  let closed = false
  let client: NativeCustodyClient | undefined
  let connecting: Promise<NativeCustodyClient> | undefined
  const onClose = new Set<() => void>()
  // Weak membership rejects copied or foreign receipts without retaining them.
  // Common-auth keeps the original receipt's send-time enrollment token private.
  const receipts = new WeakSet<object>()

  function check(signal?: AbortSignal): void {
    if (closed) throw new NativeCustodyError('closed')
    signal?.throwIfAborted()
  }

  function connection(): Promise<NativeCustodyClient> {
    check()
    connecting ??= Promise.resolve()
      .then(connect)
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
    const owned = await connection()
    check()
    return operation(owned)
  }

  const primitive = new ClaustrumScopedCustody({
    client: {
      listScoped: (token) => scoped((owned) => owned.listScoped(token)),
      getScoped: (input) => scoped((owned) => owned.getScoped(input)),
      reportAuthFailureScoped: (input) =>
        scoped((owned) => owned.reportAuthFailureScoped(input)),
      close: () => client?.close(),
    },
    family: {
      refreshAdapter: 'anthropic',
      category: 'anthropic-native',
      apiKeys: false,
    },
    requireAssertion: true,
    ...(options.readToken
      ? { readToken: options.readToken }
      : {
          tokenPath: getHostClaustrumEnrollmentPaths(options.host, env)
            .tokenPath,
        }),
    now: options.now,
    // Supply logger callbacks so common-auth cannot select its default logger.
    // Only the fixed messages below reach the caller; record details never do.
    logger: {
      warn: () => logger?.warn('Native custody inventory record skipped'),
      debug: () => logger?.debug('Native custody failure reported'),
    },
  })

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
    }
  }

  function requireReceipt(receipt: NativeCustodyReceipt): void {
    if (!receipts.has(receipt)) throw new NativeCustodyError('no-receipt')
  }

  const custody: NativeCustody = {
    discover: (signal) => run(() => primitive.discover(signal), signal),
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
        const receipt = await primitive.authorize(
          {
            credentialId,
            accountIdentity,
            credentialType: 'oauth',
          },
          signal,
        )
        check(signal)
        receipts.add(receipt)
        // Fixed OAuth input narrows common-auth's two-credential-type declaration.
        // Return the original object, preserving its non-enumerable accessToken.
        return receipt as NativeCustodyReceipt
      }, signal),
    reportFailure: (receipt, status, reporterSource) =>
      run(async () => {
        requireReceipt(receipt)
        await primitive.reportFailure(receipt, status, reporterSource)
      }),
    prepareRetry: async (served, signal) => {
      check(signal)
      requireReceipt(served)
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
      if (current.credentialId !== served.credentialId) {
        return { retry: false, reason: 'credential-changed' }
      }
      if (current.assertedAccountIdentity !== served.assertedAccountIdentity) {
        return { retry: false, reason: 'account-changed' }
      }
      if (!(current.recordVersion > served.recordVersion)) {
        return { retry: false, reason: 'version-not-newer' }
      }
      return { retry: true, receipt: current }
    },
    close: () => {
      if (closed) return
      closed = true
      for (const stop of onClose) stop()
      primitive.close()
    },
  }
  return custody
}
