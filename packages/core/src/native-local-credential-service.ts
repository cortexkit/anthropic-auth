import { types as utilTypes } from 'node:util'

import {
  createNativeLocalRuntimeReaders,
  type NativeLocalExternalPolicy,
} from './native-local-runtime-readers.ts'
import { nativeQuotaCodec } from './native-quota-codec.ts'
import {
  createNativeRefreshCoordinator,
  type NativeRefreshCoordinatorOptions,
  type NativeRefreshObservation,
  type NativeRefreshRequest,
  type NativeRefreshResult,
  type NativeRefreshSubject,
} from './native-refresh-coordinator.ts'
import {
  classifyNativeLocalFailure,
  type NativeLocalFailureAttribution,
  type NativeLocalFailurePolicy,
  publishNativeLocalCredentialValidation,
  publishNativeLocalFirstIdentity,
  publishNativeLocalRefreshFailure,
} from './native-runtime.ts'
import {
  NativeAuthorityError,
  requireNativePoolAuthority,
} from './pool-authority.ts'
import type { NativePoolPaths } from './pool-paths.ts'

/** A failure that the runtime failure publisher can record for one credential. */
export type NativeLocalAttributedFailure = Exclude<
  NativeLocalFailureAttribution,
  { kind: 'none' }
>

/**
 * Everything the failure policy may use. Both values are frozen copies taken
 * from the coordinator's report before any lock wait. They describe the
 * credential version the failed operation used, not the pool row or runtime
 * entry as they are now.
 */
export interface NativeLocalFailurePolicyInput {
  readonly observation: NativeRefreshObservation
  readonly attribution: NativeLocalAttributedFailure
}

export interface NativeLocalCredentialServiceOptions {
  /** Storage resolved by resolveNativePoolPaths. The service keeps its own copy. */
  readonly paths: NativePoolPaths
  /**
   * Decide without I/O whether local OAuth mode, the account and its quota
   * allow the operation. Credential-validation evidence is checked separately.
   */
  readonly externalPolicy: (
    subject: NativeRefreshSubject,
  ) => NativeLocalExternalPolicy
  /**
   * Choose when a recorded failure was observed and when its credential may
   * be retried. The service calls this once per attributable failure report,
   * including each failed attempt of the coordinator's bounded retry loop.
   *
   * The coordinator reads the stored retry deadline again before each further
   * attempt. A nextRetryAt later than the current clock therefore stops that
   * loop: the next attempt is refused as 'refresh-backoff' and the result no
   * longer carries the provider failure. Return nextRetryAt equal to checkedAt
   * to record the failure without delaying the coordinator's own retries.
   * The service never adds retries or a retry schedule of its own, and it does
   * not treat an attempt number as proof that the failure is final.
   */
  readonly failurePolicy: (
    input: NativeLocalFailurePolicyInput,
  ) => NativeLocalFailurePolicy
  /** Clock for expiry, stored retry deadlines and pool writes; defaults to Date.now. */
  readonly now?: () => number
  /** Token-exchange function; defaults to the Claude OAuth refresh endpoint. */
  readonly refreshToken?: NativeRefreshCoordinatorOptions['refreshToken']
  /** Account lookup for new access; defaults to the Claude Code identity lookup. */
  readonly resolveIdentity?: NativeRefreshCoordinatorOptions['resolveIdentity']
}

/**
 * Hosts receive an access token only after its Claude account has been checked.
 * That check can be reused while the refresh token, access token, expiry and
 * stored refresh timestamp have not changed.
 */
export interface NativeLocalCredentialService {
  authorize(request: NativeRefreshRequest): Promise<NativeRefreshResult>
}

const optionKeys = [
  'paths',
  'externalPolicy',
  'failurePolicy',
  'now',
  'refreshToken',
  'resolveIdentity',
] as const
const pathKeys = [
  'legacyConfig',
  'legacyState',
  'config',
  'state',
  'runtime',
  'journal',
  'roster',
  'storageId',
] as const
const policyKeys = ['checkedAt', 'nextRetryAt', 'retryCount'] as const

function invalidOption(key: string): TypeError {
  return new TypeError(
    `Native local credential service option ${key} is invalid`,
  )
}

function plainDescriptors(
  value: unknown,
  allowed: readonly string[],
): Record<string, PropertyDescriptor> | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as string]
    // Getters would run caller code each time the value is read, so a later
    // read could return a different callback or path than the one checked.
    if (
      typeof key !== 'string' ||
      !allowed.includes(key) ||
      !descriptor ||
      !Object.hasOwn(descriptor, 'value')
    )
      return undefined
  }
  return descriptors
}

function requiredFunction<T>(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): T {
  const value = descriptors[key]?.value
  if (typeof value !== 'function') throw invalidOption(key)
  return value as T
}

function optionalFunction<T>(
  descriptors: Record<string, PropertyDescriptor>,
  key: string,
): T | undefined {
  const value = descriptors[key]?.value
  if (value === undefined) return undefined
  if (typeof value !== 'function') throw invalidOption(key)
  return value as T
}

function capturePaths(value: unknown): NativePoolPaths {
  const descriptors = plainDescriptors(value, pathKeys)
  if (!descriptors) throw invalidOption('paths')
  const copy: Record<string, string> = {}
  for (const key of pathKeys) {
    const item = descriptors[key]?.value
    if (typeof item !== 'string' || item.length === 0)
      throw invalidOption('paths')
    copy[key] = item
  }
  return Object.freeze(copy as unknown as NativePoolPaths)
}

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value)
  const freeze = (item: unknown) => {
    if (item === null || typeof item !== 'object') return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(copy)
  return copy
}

// The publisher checks the numeric values. This copy only makes sure that the
// values it checks are the values it writes, without getters or extra fields.
function capturePolicy(value: unknown): NativeLocalFailurePolicy {
  const descriptors = plainDescriptors(value, policyKeys)
  if (!descriptors || !Object.hasOwn(descriptors, 'checkedAt'))
    throw new TypeError('Native local failure policy result is invalid')
  const field = (key: (typeof policyKeys)[number]) =>
    descriptors[key]?.value as number | undefined
  const nextRetryAt = field('nextRetryAt')
  const retryCount = field('retryCount')
  return Object.freeze({
    checkedAt: field('checkedAt') as number,
    ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    ...(retryCount !== undefined ? { retryCount } : {}),
  })
}

/**
 * Authorize local OAuth only after offline migration commits the pool as the
 * credential authority. Creating this service neither imports credentials nor
 * completes migration. The coordinator owns exchange, account lookup, bounded
 * retries and the final validation check; it refuses API-key rows.
 *
 * Successful account checks record validation for the exact credential version.
 * An existing runtime entry with no account UUID loses its unproven metadata,
 * but keeps the clear timestamps that prevent older errors from returning.
 * Known-account entries keep their metadata; a missing entry can be created
 * only when the observation captured that absence before the provider call.
 * Attributed failures record their credential version and caller retry policy.
 * Writers recheck credential versions, bindings and clear timestamps under
 * pool/runtime locks. A write fault prevents credentials from being returned,
 * but cannot undo a token exchange or file replacement already committed.
 */
export function createNativeLocalCredentialService(
  options: NativeLocalCredentialServiceOptions,
): NativeLocalCredentialService {
  const descriptors = plainDescriptors(options, optionKeys)
  if (!descriptors)
    throw new TypeError('Native local credential service options are invalid')
  const paths = capturePaths(descriptors.paths?.value)
  const externalPolicy = requiredFunction<
    NativeLocalCredentialServiceOptions['externalPolicy']
  >(descriptors, 'externalPolicy')
  const failurePolicy = requiredFunction<
    NativeLocalCredentialServiceOptions['failurePolicy']
  >(descriptors, 'failurePolicy')
  const now = optionalFunction<() => number>(descriptors, 'now')
  const refreshToken = optionalFunction<
    NativeLocalCredentialServiceOptions['refreshToken']
  >(descriptors, 'refreshToken')
  const resolveIdentity = optionalFunction<
    NativeLocalCredentialServiceOptions['resolveIdentity']
  >(descriptors, 'resolveIdentity')

  async function reconcile(observation: NativeRefreshObservation) {
    // Select from the captured provider observation, never a later runtime read.
    // Writers recheck its credential version, binding and error-clear timestamps
    // under locks; changing the subject would misattribute the provider result.
    const event = frozenCopy(observation)
    if (
      (event.status === 'persisted' ||
        event.status === 'validation-observed') &&
      event.bootstrap === 'resolved'
    ) {
      const predecessor = event.context?.runtimeBinding
      if (predecessor && predecessor.identity === undefined)
        await publishNativeLocalFirstIdentity(paths, event)
      else await publishNativeLocalCredentialValidation(paths, event)
      return
    }
    if (event.status !== 'failed' && event.status !== 'persisted') return
    const attribution = classifyNativeLocalFailure(event)
    if (attribution.kind === 'none') return
    const policy = capturePolicy(
      failurePolicy(
        Object.freeze({
          observation: event,
          attribution: frozenCopy(attribution),
        }),
      ),
    )
    // Recording a failure, skipping an inapplicable update or rejecting a stale
    // update cannot validate credentials. Leave the authorization result to the
    // coordinator's separate admission check.
    await publishNativeLocalRefreshFailure(paths, event, policy)
  }

  const coordinator = createNativeRefreshCoordinator({
    paths,
    quota: nativeQuotaCodec,
    ...(now ? { now } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(resolveIdentity ? { resolveIdentity } : {}),
    ...createNativeLocalRuntimeReaders({
      paths,
      externalPolicy,
      ...(now ? { now } : {}),
    }),
    reconcile,
  })

  async function authorize(
    request: NativeRefreshRequest,
  ): Promise<NativeRefreshResult> {
    try {
      await requireNativePoolAuthority(paths)
    } catch (error) {
      return {
        status: 'refused',
        reason:
          error instanceof NativeAuthorityError
            ? error.code
            : 'authority-unavailable',
        persisted: false,
      }
    }
    return coordinator.authorize(request)
  }

  return Object.freeze({ authorize })
}
