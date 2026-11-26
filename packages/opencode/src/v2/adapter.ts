// OpenCode sends the requests; this adapter supplies account credentials,
// Claude Code request transforms and response classification to common-auth's
// transport hooks. The injected source uses Core's account and policy services.
// Each response keeps the credential version and account of its own request,
// including HTTP relay responses. Message-thread recovery and Core's client
// refusal fallback can make an extra send within the same host request.

import { createHash, randomUUID } from 'node:crypto'
import {
  type AnthropicBillingRequest,
  AnthropicOAuthOriginError,
  apiKeyRequestBetas,
  applyClaudeGatewayHeaders,
  applyCustomHeaders,
  assertHostAuthorityStable,
  assertNotCustodyTombstone,
  type CacheDiagnosticsRequestContext,
  type CacheKeepRealTurn,
  type ClaudeCodeIdentity,
  type ClaudeGateway,
  classifyGzipRejection,
  claudeGatewayHeaderValues,
  claudeGatewayModelUrl,
  copyStreamResponseTiming,
  createAnthropicBillingObserver,
  createDumpResponseObserver,
  createProviderErrorRedactor,
  createProviderErrorResponseScope,
  createSseFramer,
  currentCacheKeepRealTurn,
  DEFAULT_REFUSAL_FALLBACK_MODE,
  type DumpHandle,
  type DumpTag,
  decideRequestGzip,
  decodeSseFrame,
  dispatchRefusalFallback,
  dumpDirectRequest,
  dumpRelayRequest,
  dumpResponseArtifact,
  encodeGzipRequestBody,
  getCacheDiagnosticsBetas,
  getRequestGzipLatch,
  getRequestGzipLatchPath,
  guardAnthropicStreamResponse,
  hasCacheDiagnosticsBeta,
  hasFallbackCreditInRequest,
  type IncompleteStreamDiagnostics,
  isDumpEnabled as isDumpEnabledCore,
  isNativeTransientAccountError,
  isTerminatedSseFrame,
  joinRefusalFallbackStream,
  type MessageThreadRequest,
  MessageThreadTracker,
  observeAnthropicBillingResponse,
  type ProviderErrorRedactor,
  type ProviderErrorResponseScope,
  type ProviderResponseMode,
  parseSseFrame,
  prepareMessageThreadRequest,
  protectFallbackCreditResponse,
  RELAY_PROXY_REFUSAL,
  type RefusalFallbackCacheKeepTemplate,
  type RefusalFallbackDispatchOptions,
  type RefusalFallbackMode,
  type RefusalFallbackRoundEngine,
  type RefusalFallbackRoundInput,
  type RefusalFallbackStreamOptions,
  type RequestGzipLatch,
  relayProxyApplies,
  remapModelId,
  reportAnthropicBillingFailure,
  requestCacheLifetimeMs,
  requestShortestCacheLifetimeMs,
  requestSignal,
  resolveClaudeModelCapabilities,
  resolveNativePoolPaths,
  rewriteApiKeyRequestBody,
  runWithRequestSignal,
  SERVER_SIDE_FALLBACK_BETA,
  sanitizeClaudeCodeRequestBody,
  sendWithRequestGzip,
  setDumpEnabled as setDumpEnabledCore,
  signRequestBody,
  stateLayoutOfPaths,
  stateRefusalCause,
  stateRefusalPublicMessage,
  summarizeCacheTtl,
  TrailingAssistantHistoryError,
  withoutFallbackCredit,
} from '@cortexkit/anthropic-auth-core'
import type {
  AccountHeadersResult,
  AccountRequest,
  Attempt,
  AttemptOutcome,
  ChooseAccountInput,
  ChooseAccountResult,
  EventVerdict,
  HeaderEdits,
  HostError,
  LimitSignal,
  OpenCode2AuthAdapter,
  RequestScope,
  SameAccountRetryInput,
  SameAccountRetryResult,
  Transport,
} from '@cortexkit/common-auth/opencode2'
import { findNodeAtLocation, type ParseError, parseTree } from 'jsonc-parser'
import { BILLING_LINEAGE_REQUEST_HEADER } from '../billing-lineage'
import {
  EFFORT_PLAN_REQUEST_HEADER,
  EffortMarkerCorrelationError,
} from '../effort-history'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
import { requireOAuthDestination } from '../oauth-destination'
import { isAuxiliaryAgent } from '../request-class'
import {
  createStrippedStream,
  NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
  observeCompletedCacheReply,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from '../transform'

/** The provider OpenCode 2 serves Claude under. */
export const ANTHROPIC_PROVIDER_ID = 'anthropic'

/**
 * The request header the installer marks a send with. The installer removes
 * it itself; it is listed here so that no copy of it can ever reach the wire
 * through this adapter either. Kept as a literal because the adapter imports
 * nothing from common-auth at runtime.
 */
const INSTALLER_ATTEMPT_HEADER = 'x-common-auth-attempt'

/**
 * Plugin-internal request headers that correlate a request with this
 * plugin's own state. They are meaningful only inside the plugin and are
 * removed before the request goes upstream, on both routes.
 */
export const INTERNAL_REQUEST_HEADERS: readonly string[] = [
  'x-session-affinity',
  'x-opencode-session',
  'x-parent-session-id',
  EFFORT_PLAN_REQUEST_HEADER,
  BILLING_LINEAGE_REQUEST_HEADER,
  LANE_START_REQUEST_HEADER,
  INSTALLER_ATTEMPT_HEADER,
]

/** Headers that carry a credential; on the OAuth route only the adapter sets them. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key'])

/** Fixed error label for a dump whose send never reached Anthropic. */
const DUMP_PHYSICAL_SEND_FAILED = 'physical send before a response'

/**
 * Fixed text of the refusal raised when the source has no credential for a
 * send. It names no account, route or vault, because the host shows and logs
 * it.
 */
export const NO_ACCOUNT_REFUSAL =
  'Claude pool login is selected but no native account is usable. Complete offline migration or repair the pool and its quota policy before retrying.'

/**
 * Most sends whose credential may wait between `accountHeaders` and
 * `rewriteRequest` at once. Matches the installer's own default record bound;
 * the oldest is dropped first, and a send whose entry was dropped is refused
 * rather than sent without it.
 */
export const DEFAULT_MAX_PENDING_SENDS = 512

/**
 * How long `onAttemptEnd` waits for the source to finish recording how a send
 * ended. After that the adapter returns and logs a warning; the source's own
 * work is not cancelled.
 */
export const DEFAULT_ATTEMPT_END_TIMEOUT_MS = 5_000

/** Longest provider error text kept in an attempt's failure message. */
const MAX_STREAM_ERROR_MESSAGE = 500

/** The error `type` values Anthropic documents for its API errors. */
const ANTHROPIC_ERROR_TYPES: ReadonlySet<string> = new Set([
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'rate_limit_error',
  'timeout_error',
  'api_error',
  'overloaded_error',
])

const safeHostError = (
  error: HostError,
  message = 'provider request failed',
): HostError => ({
  type: ANTHROPIC_ERROR_TYPES.has(error.type) ? error.type : 'provider_error',
  message,
  ...(error.status !== undefined ? { status: error.status } : {}),
})

/** Which kind of credential one send goes out with. */
export type NativeAnthropicRoute = 'oauth' | 'api'

/**
 * Where one send goes: directly to Anthropic, or through the selected HTTP
 * relay. A selected WebSocket relay appears here only so the adapter can
 * refuse it before anything is sent. No local proxy transport is used.
 */
export type NativeAnthropicDispatch =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'http-relay'
      readonly url: string
      readonly token: string
    }
  | { readonly kind: 'websocket-relay' }

/**
 * What the source authorizes for one send. `provenance` is the source's own
 * record of the account and credential version that serve it (a local slot,
 * a vault receipt with its version, an API key row). The adapter hands it back
 * unchanged with every response, error and end of that send, so the source
 * can tie a 401 or a quota reading to the exact account and version served.
 */
export type NativeAnthropicAuthorization<P> =
  | {
      readonly route: 'oauth'
      readonly accessToken: string
      /** Stable credential row identity, unchanged by token refresh and changed by login replacement. */
      readonly credentialId: string
      /** The Claude Code identity of the account, when the source knows it. */
      readonly identity?: ClaudeCodeIdentity
      /** Additional OAuth request headers; authorization and x-api-key edits are ignored so they cannot replace the authorized bearer. */
      readonly headers?: HeaderEdits
      readonly provenance: P
      readonly dispatch?: NativeAnthropicDispatch
      /**
       * The user's gateway from their own settings file, read once when this
       * send was authorized. A model request goes there directly instead of
       * api.anthropic.com, whatever `dispatch` says; any other request uses
       * `dispatch`.
       */
      readonly gateway?: ClaudeGateway
    }
  | {
      readonly route: 'api'
      /**
       * API-route authentication headers must set authorization or x-api-key.
       */
      readonly headers: HeaderEdits
      /** The URL the send goes to instead of the host's, for this account. */
      readonly baseURL?: string
      readonly provenance: P
      readonly dispatch?: NativeAnthropicDispatch
    }

/**
 * Correlation metadata carried by common-auth's request hooks for one send.
 * It contains neither credentials nor request body content.
 */
export interface NativeAnthropicAttemptData<P> {
  readonly route: NativeAnthropicRoute
  readonly provenance: P
  readonly dispatch: 'direct' | 'http-relay'
}

/**
 * One send, as the source's response, error and end callbacks receive it:
 * the host's request scope, the attempt, and what the source authorized.
 */
export interface NativeAnthropicSendScope extends RequestScope {
  /** An extra send reuses the account's credential binding without waiting for quota. */
  readonly extraSend?: {
    readonly kind: 'refusal' | 'thread' | 'source-resend'
    readonly credentialId: string
  }
}

export interface NativeAnthropicAttemptContext<P>
  extends AccountRequest,
    NativeAnthropicSendScope {
  readonly attemptId: string
  readonly transport: Transport | undefined
  readonly route: NativeAnthropicRoute
  readonly provenance: P
  readonly dispatch: 'direct' | 'http-relay'
}

/** Non-nullable options accepted by rewriteRequestBody. */
type RewriteBodyOptions = NonNullable<Parameters<typeof rewriteRequestBody>[1]>

/**
 * The source supplies billing, effort, cache, fast-mode, safety and diagnostic
 * inputs. The adapter owns identity/session correlation, final signing and
 * the tool-name callback that binds response names to this send.
 */
export type NativeAnthropicBodyOptions = Omit<
  RewriteBodyOptions,
  | 'identity'
  | 'sessionId'
  | 'modelId'
  | 'isOAuth'
  | 'onToolNameMap'
  | 'deferSigning'
> & {
  readonly cacheDiagnosticsPreviousMessageReceivedAt?: number
  readonly refusalFallbackMode?: RefusalFallbackMode
}

type StrippedStreamOptions = NonNullable<
  Parameters<typeof createStrippedStream>[1]
>

/**
 * The response observers a source may attach to an OAuth response. Content
 * filter recovery and relay error hooks are left out on purpose: they exist
 * to send the request again, and this adapter never sends.
 */
export type NativeAnthropicResponseOptions = Pick<
  StrippedStreamOptions,
  | 'perf'
  | 'onComplete'
  | 'serverSideFallbackModel'
  | 'serverSideFallbackSent'
  | 'onServerSideFallbackOutcome'
  | 'onMessageStart'
  | 'onMessageDelta'
  | 'onMessageResponse'
  | 'onStreamEnd'
  | 'laneStart'
>

/** What `requestOptions` receives for an OAuth send, before its body is rewritten. */
export interface NativeAnthropicRequestContext<P>
  extends NativeAnthropicAttemptContext<P> {
  readonly route: 'oauth'
  /**
   * This plugin's own correlation headers found on the request (lower-case
   * names, such as the effort plan or billing lineage id), already removed
   * from it. The adapter does not interpret them; the source looks them up
   * in its own trackers.
   */
  readonly correlation: Readonly<Record<string, string>>
}

/**
 * What the source's response callbacks receive: the send, plus the HTTP
 * status of its response, before the body is read.
 */
export interface NativeAnthropicResponseContext<P>
  extends NativeAnthropicAttemptContext<P> {
  readonly status: number
  readonly cacheDiagnostics?: CacheDiagnosticsSend
  /** Model of the OAuth request as sent, only when its body enabled fallback. */
  readonly serverSideFallbackModel?: string
}

type CacheDiagnosticsSend = Omit<
  CacheDiagnosticsRequestContext,
  'sessionId' | 'isSubagent'
> & {
  betaInfo: Promise<
    Awaited<ReturnType<typeof getCacheDiagnosticsBetas>> | undefined
  >
  requestedModel?: string
}

/** An `error` event inside a streamed response. */
export interface NativeAnthropicStreamErrorContext<P>
  extends NativeAnthropicAttemptContext<P> {
  /** The provider's `error.type`, such as `overloaded_error`. */
  readonly errorType: string | undefined
  readonly message: string | undefined
}

/**
 * How a send ended. `localRefusal` is set when the adapter refused the
 * request itself before anything was sent (a malformed history, say); a
 * provider 400 never carries it.
 */
export interface NativeAnthropicAttemptOutcome extends AttemptOutcome {
  readonly localRefusal?: { readonly check: string }
}

/**
 * The Core-owned source of accounts and policy. Every member is a function
 * property, so under `strictFunctionTypes` a callback that accepts less than
 * the adapter passes it is rejected at compile time.
 */
export interface NativeAnthropicSource<Q, P> {
  readonly beginRealTurn?: (
    scope: RequestScope,
  ) => CacheKeepRealTurn | undefined
  readonly billingRequest?: (
    input: NativeAnthropicAttemptContext<P>,
  ) => AnthropicBillingRequest | undefined
  /**
   * Picks the account for one request; `undefined` refuses it. In phase
   * `retry` it may instead return a hold, which keeps the refused account and
   * waits the given delay before the host retries.
   */
  readonly chooseAccount: (
    input: ChooseAccountInput,
  ) => Promise<ChooseAccountResult> | ChooseAccountResult
  /** Discards one queued choice that the installer will not authorize. */
  readonly dropChoice?: (input: AccountRequest) => Promise<void> | void
  /** Retries a prepared credential or switches relay to direct on the same account. */
  readonly retrySameAccount?: (
    input: SameAccountRetryInput,
  ) =>
    | Promise<SameAccountRetryResult | undefined>
    | SameAccountRetryResult
    | undefined
  /**
   * Discards the retry `retrySameAccount` prepared (the newer credential or
   * the switch from relay to direct) when the host decides not to send it.
   */
  readonly dropSameAccountRetry?: (
    input: SameAccountRetryInput & SameAccountRetryResult,
  ) => Promise<void> | void
  /**
   * The credential for one send with the chosen account; `undefined` refuses
   * the request before anything is sent.
   */
  readonly authorizeAccount: (
    scope: NativeAnthropicSendScope,
    accountId: string,
  ) =>
    | Promise<NativeAnthropicAuthorization<P> | undefined>
    | NativeAnthropicAuthorization<P>
    | undefined
  /** Body rewrite options for an OAuth send. */
  readonly requestOptions?: (
    input: NativeAnthropicRequestContext<P>,
  ) => Promise<NativeAnthropicBodyOptions> | NativeAnthropicBodyOptions
  /** Rechecks policy after asynchronous rewriting, immediately before dispatch. */
  readonly admitRequest?: (
    input: NativeAnthropicAttemptContext<P>,
  ) => Promise<void> | void
  /** Memory-only check; dispatch still authorizes and admits against current policy. */
  readonly isRefusalFallbackCurrent?: (
    input: NativeAnthropicAttemptContext<P> & {
      readonly credentialId: string
      readonly baseUrl: string
      readonly url: string
      readonly ignoreMode?: boolean
    },
  ) => boolean
  /** A relayed origin can only spend its one-use credit on an allowed direct send. */
  readonly allowsDirectRefusalRetry?: (
    input: NativeAnthropicAttemptContext<P>,
  ) => boolean | Promise<boolean>
  readonly onCompletedFallbackRequest?: (
    input: Parameters<
      NonNullable<NativeAnthropicSource<Q, P>['onRequestPrepared']>
    >[0] & {
      readonly usage: Record<string, unknown>
      readonly acceptedAt: number
      readonly isFresh: () => boolean
    },
  ) => Promise<void> | void
  /** Observe the full stateless template; the cache warmer signs its replay. */
  readonly onRequestPrepared?: (
    input: NativeAnthropicAttemptContext<P> & {
      readonly url: string
      readonly bodyText: string
      readonly signal?: AbortSignal
    },
  ) => Promise<void> | void
  readonly onFinalRequestPrepared?: (input: {
    attemptId: string
    requestId: string | undefined
    bodyText: string
    ttlMs: number
  }) => void
  readonly onResponseHandedToHost?: (
    request: Request,
    accepted: { at: number } | undefined,
  ) => void
  /** Response observers for an OAuth response. */
  readonly responseOptions?: (
    input: NativeAnthropicResponseContext<P>,
  ) => NativeAnthropicResponseOptions | undefined
  /** Manual quota refusal only when the exhausted pool cannot hold another retry. */
  readonly quotaStopMessage?: (
    input: NativeAnthropicResponseContext<P> & { readonly hostAttempt: number },
  ) => Promise<string | undefined> | string | undefined
  /** Quota carried by the upstream response headers, read once per response. */
  readonly quotaFromHeaders?: (
    headers: Headers,
    input: NativeAnthropicResponseContext<P> & {
      /** Background cache requests harvest quota without reporting turn routing. */
      readonly reportRouting?: boolean
    },
  ) => Q | undefined
  /**
   * Classifies an error response before its body streams. `body()` reads a
   * copy, so the host still receives the body.
   */
  readonly limitFromResponse?: (
    input: NativeAnthropicResponseContext<P> & {
      readonly headers: Headers
      readonly body: () => Promise<string>
    },
  ) => Promise<LimitSignal | undefined> | LimitSignal | undefined
  /** Classifies a relay-local failure, never an Anthropic credential failure. */
  readonly limitFromRelayFailure?: (
    input: NativeAnthropicResponseContext<P>,
  ) => Promise<LimitSignal | undefined> | LimitSignal | undefined
  /** Classifies an `error` event inside a streamed response. */
  readonly limitFromStreamError?: (
    input: NativeAnthropicStreamErrorContext<P>,
  ) => LimitSignal | undefined
  /**
   * Classifies the error the host hands the retry hook. Never asked about a
   * send the adapter refused locally.
   */
  readonly limitFromHostError?: (
    error: HostError,
    input: NativeAnthropicAttemptContext<P>,
  ) => LimitSignal | undefined
  /**
   * How a send ended, with the provenance of the credential it used, so a
   * 401 can be reported against the exact vault receipt version served.
   */
  readonly onAttemptEnd?: (
    input: NativeAnthropicAttemptContext<P>,
    outcome: NativeAnthropicAttemptOutcome,
  ) => Promise<void> | void
  /**
   * Whether request dumps are enabled in the current custody mode's settings.
   * The adapter consults this before writing any dump, so a stale global flag
   * from another host mode never decides. Sources backed by the native runtime
   * read `dump.enabled` from the current snapshot; synthetic test sources may
   * omit it, in which case the adapter falls back to the Core global flag.
   */
  readonly isDumpEnabled?: () => Promise<boolean> | boolean
  /**
   * Called by the adapter's `forgetSession`; drops whatever the source keeps
   * for the session.
   */
  readonly forgetSession?: (sessionID: string) => void
  /** Drop the retry budget when the host finishes the user turn, not an HTTP attempt. */
  readonly forgetTurn?: (sessionID: string) => void
}

export interface NativeAnthropicAdapterLogger {
  warn(message: string, data?: Record<string, unknown>): void
}

export interface NativeAnthropicAdapterDeps<Q, P> {
  readonly source: NativeAnthropicSource<Q, P>
  readonly rounds?: RefusalFallbackRoundEngine
  readonly takeRoundThreadReset?: (sessionID: string) => boolean
  readonly roundPolicy?: (
    input: NativeAnthropicAttemptContext<P> & {
      baseUrl: string
    },
  ) => {
    targetAllowed: (model: string) => boolean
    cacheRoute?: NonNullable<RefusalFallbackRoundInput['oauth']>['cache']
    onRoundActivity?: () => void
  }
  readonly onRoundCacheTemplate?: (
    input: NativeAnthropicAttemptContext<P> & {
      url: string
      headers: Headers
      signal: AbortSignal
      template: RefusalFallbackCacheKeepTemplate
      isCurrent: () => boolean
    },
  ) => void | Promise<void>
  /** A warm replays the source-shaped headers that its live request used. */
  readonly cacheKeepHeaders?: Headers
  readonly log?: NativeAnthropicAdapterLogger
  /** Maximum number of authorized sends waiting for their request rewrite. */
  readonly maxPendingSends?: number
  /**
   * How long `onAttemptEnd` waits for the source to record how a send
   * ended; the source's work is not cancelled.
   */
  readonly attemptEndTimeoutMs?: number
  /**
   * Remembers a rejected gzipped body. Defaults to the latch in the state
   * layout OpenCode chose at host startup.
   */
  readonly requestGzipLatch?: RequestGzipLatch
  readonly fetch?: typeof fetch
  /** Receipt clock; production uses epoch milliseconds from Date.now. */
  readonly now?: () => number
}

export interface NativeAnthropicAdapter<Q, P> {
  preservesCacheTemplate(data: NativeAnthropicAttemptData<P>): boolean
  /** Bind the installer's host retry count to this physical send, never its session. */
  bindHostAttempt(
    attempt: Attempt<NativeAnthropicAttemptData<P>>,
    hostAttempt: number,
  ): void
  /** Drop the pending quota-stop message if the send ends before its response body is rewritten. */
  discardQuotaStopMessage(data: NativeAnthropicAttemptData<P>): void
  /** Background drivers can refuse a rewritten request before their final dispatch. */
  discardUnsentBilling(data: NativeAnthropicAttemptData<P>): void
  /** Receipt time of this adapter's final verified upstream OAuth 2xx response. */
  acceptedResponse(response: Response): { at: number } | undefined
  readonly adapter: OpenCode2AuthAdapter<
    Q,
    NativeAnthropicAttemptData<P>,
    ChooseAccountResult
  > & {
    readonly dropChoice: (input: AccountRequest) => Promise<void> | void
  }
  /**
   * Drops the session's authorized sends that have not been rewritten yet,
   * revokes its choices, authorizations and rewrites still in progress so
   * none of them can return, and calls the source's `forgetSession`.
   */
  forgetSession(sessionID: string): void
  /** Revokes all pending work. Later calls refuse without invoking the source. */
  dispose(): void
  /** Number of sends authorized and not yet rewritten or ended. */
  readonly pendingSendCount: number
  /** Number of OAuth access tokens held for sends not yet rewritten. */
  readonly heldCredentialCount: number
  /**
   * Number of sends whose credentials are still held to scrub their errors:
   * kept until the send ends cleanly, the retry hook has classified its
   * failure, its session is forgotten, or maxPendingSends evicts the oldest.
   */
  readonly heldRedactorCount: number
  /** Number of choices, authorizations and rewrites still in progress. */
  readonly operationsInProgress: number
}

/**
 * The request was refused before anything was sent because the source had
 * no credential for it. Never retried on the host's own credential.
 */
export class NativeAnthropicNoAccountError extends Error {
  readonly kind = 'no-account'
  readonly providerID = ANTHROPIC_PROVIDER_ID

  constructor(
    readonly sessionID: string,
    readonly requestKind: string,
  ) {
    super(NO_ACCOUNT_REFUSAL)
    this.name = 'NativeAnthropicNoAccountError'
  }
}

/**
 * The request was refused because its session was forgotten while the
 * account choice, authorization or request rewrite for it was still in
 * progress. Nothing from that work is returned or kept, and nothing is sent.
 */
export class NativeAnthropicRevokedError extends Error {
  readonly kind = 'session-forgotten'
  readonly providerID = ANTHROPIC_PROVIDER_ID

  constructor(
    readonly sessionID: string,
    readonly requestKind: string,
  ) {
    super('request refused: its session was closed while it was being prepared')
    this.name = 'NativeAnthropicRevokedError'
  }
}

/** OpenCode 2's HTTP model driver cannot speak the relay's binary WebSocket protocol. */
export class NativeAnthropicTransportRefusal extends Error {
  readonly kind = 'unsupported-transport'
  readonly providerID = ANTHROPIC_PROVIDER_ID

  constructor() {
    super(
      'request refused: WebSocket relay is not supported on OpenCode 2; select HTTP relay or direct transport',
    )
    this.name = 'NativeAnthropicTransportRefusal'
  }
}

/**
 * The request was refused with a local 400 because it can never succeed as
 * written: its history ends on a meaningful assistant turn, an effort marker
 * in it cannot be matched to the session's effort plan, or it is an OAuth
 * request whose URL is not Anthropic's API server. Nothing was
 * sent, and another account cannot help, so the adapter never reports it as
 * an account limit. The message and `check` describe only the shape of the
 * problem, never conversation content.
 */
export class NativeAnthropicLocalRefusal extends Error {
  readonly kind = 'local-invalid-request'
  readonly status = 400
  readonly check: string

  constructor(
    cause:
      | TrailingAssistantHistoryError
      | EffortMarkerCorrelationError
      | AnthropicOAuthOriginError,
  ) {
    super(cause.message, { cause })
    this.name = 'NativeAnthropicLocalRefusal'
    this.check = cause.check
  }
}

/**
 * The request was refused because a newer anthropic-auth version moved the
 * account state files this process uses, or because this process could not
 * record its use of a folder it may only use once recorded. Nothing was
 * sent. The message is Core's fixed text and names no path; the plugin log
 * names the folders.
 */
export class NativeAnthropicStateRefusal extends Error {
  readonly kind = 'state-relocated'
  readonly providerID = ANTHROPIC_PROVIDER_ID

  constructor(cause: NonNullable<ReturnType<typeof stateRefusalCause>>) {
    // A layout refusal's own message names files; show its fixed text.
    super(stateRefusalPublicMessage(cause) ?? cause.message, { cause })
    this.name = 'NativeAnthropicStateRefusal'
  }
}

/** The refusal behind `error` as the adapter reports it, if there is one. */
export function stateRefusalFrom(error: unknown) {
  const cause = stateRefusalCause(error)
  return cause ? new NativeAnthropicStateRefusal(cause) : undefined
}

/**
 * What the adapter keeps for one authorized send until its request is
 * rewritten: the OAuth access token and identity, or the API base URL.
 */
interface PendingSend {
  readonly sessionID: string
  readonly oauth?: {
    readonly accessToken: string
    readonly credentialId: string
    readonly identity?: ClaudeCodeIdentity
  }
  readonly baseURL?: string
  readonly dispatch?: NativeAnthropicDispatch
  readonly apiHeaders?: HeaderEdits
  readonly oauthHeaders?: HeaderEdits
  readonly gateway?: ClaudeGateway
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isRecoveryTransportFailure(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (isRecord(error) && !seen.has(error)) {
    seen.add(error)
    if (error.name === 'AbortError') return false
    if (
      (typeof error.code === 'string' &&
        /^(?:ConnectionRefused|ConnectionClosed|FailedToOpenSocket|EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(
          error.code,
        )) ||
      error.name === 'TimeoutError' ||
      (error.name === 'TypeError' &&
        typeof error.message === 'string' &&
        /fetch failed|Failed to fetch|Load failed|NetworkError|ECONNRESET|socket connection was closed unexpectedly/i.test(
          error.message,
        ))
    )
      return true
    error = error.cause
  }
  return false
}

function inspectableThreadError(response: Response): Response {
  if ((response.status !== 400 && response.status !== 404) || !response.body)
    return response
  // Bun 1.3 can drain a cached native response body when both the thread and
  // gzip inspectors clone it. Own a JavaScript stream before those reads so
  // later error redaction receives all bytes.
  return new Response(
    response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()),
    response,
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Observe a reply passed through without retrying or changing its bytes. */
function observeUnjoinedSourceReturn(
  response: Response,
  settle: (() => void) | undefined,
): Response {
  if (!settle || response.status !== 200 || !response.body) return response
  const contentType = response.headers.get('content-type') ?? ''
  const json =
    /\bjson\b/i.test(contentType) && !/text\/event-stream/i.test(contentType)
  const framer = json ? undefined : createSseFramer()
  const decoder = json ? new TextDecoder() : undefined
  let text = ''
  let bytes = 0
  let streamStart = true
  let started = false
  let observing = true
  const inspectFrame = (frame: Uint8Array) => {
    const { event, data } = parseSseFrame(
      decodeSseFrame(frame, { streamStart }),
    )
    streamStart = false
    if (event === 'error') observing = false
    if (!observing || !data || data === '[DONE]') return
    const payload = parseJson(data)
    const type = isRecord(payload) ? (payload.type ?? event) : 'error'
    if (type === 'error') observing = false
    else if (type === 'message_start') started = true
    else if (type === 'message_stop' && started) {
      observing = false
      settle()
    }
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (observing) {
          try {
            if (framer) {
              for (const frame of framer.push(chunk)) inspectFrame(frame)
            } else if (decoder) {
              bytes += chunk.byteLength
              observing = bytes <= NON_STREAMING_DIAGNOSTICS_MAX_BYTES
              text = observing
                ? text + decoder.decode(chunk, { stream: true })
                : ''
            }
          } catch {
            observing = false
          }
        }
        controller.enqueue(chunk)
      },
      flush() {
        if (!observing) return
        try {
          if (framer) {
            const tail = framer.finish()
            if (tail && isTerminatedSseFrame(tail)) inspectFrame(tail)
          } else if (decoder) {
            const message = parseJson(text + decoder.decode())
            if (
              isRecord(message) &&
              message.type === 'message' &&
              typeof message.stop_reason === 'string' &&
              message.stop_reason
            )
              settle()
          }
        } catch {
          // A failed observation must not change the reply the host receives.
        } finally {
          text = ''
        }
      },
    }),
  )
  return copyStreamResponseTiming(response, new Response(body, response))
}

/** Lower-cases every header name, keeping the last value for a name. */
function lowerCaseEdits(edits: HeaderEdits | undefined) {
  const out: Record<string, string | null> = {}
  for (const [name, value] of Object.entries(edits ?? {})) {
    out[name.toLowerCase()] = value
  }
  return out
}

/** Removes the plugin-internal headers and returns what they held. */
function takeInternalHeaders(headers: Headers) {
  const found: Record<string, string> = {}
  for (const name of INTERNAL_REQUEST_HEADERS) {
    const value = headers.get(name)
    if (value !== null && name !== INSTALLER_ATTEMPT_HEADER) found[name] = value
    headers.delete(name)
  }
  return found
}

function isMessagesUrl(url: string) {
  try {
    return new URL(url).pathname.endsWith('/messages')
  } catch {
    return false
  }
}

function localRefusalFrom(error: unknown) {
  return error instanceof TrailingAssistantHistoryError ||
    error instanceof EffortMarkerCorrelationError ||
    error instanceof AnthropicOAuthOriginError
    ? new NativeAnthropicLocalRefusal(error)
    : undefined
}

/**
 * The secrets one request is sent with: its OAuth access token or API key
 * header values, plus the HTTP relay's own token when a relay carries it.
 * A provider or relay error may repeat any of them. `physical` holds the
 * headers as they leave: setting a header drops leading and trailing
 * whitespace, so a configured value can differ from the one the provider
 * receives and echoes. Both spellings are kept.
 */
function sendSecrets(send: PendingSend, physical: Headers): string[] {
  const secrets: string[] = []
  if (send.oauth) secrets.push(send.oauth.accessToken)
  for (const [name, value] of Object.entries(send.apiHeaders ?? {})) {
    if (value === null || !CREDENTIAL_HEADERS.has(name)) continue
    secrets.push(value.replace(/^Bearer\s+/i, ''))
  }
  for (const name of CREDENTIAL_HEADERS) {
    const value = physical.get(name)
    if (value !== null) secrets.push(value.replace(/^Bearer\s+/i, ''))
  }
  if (send.dispatch?.kind === 'http-relay') secrets.push(send.dispatch.token)
  return [...new Set(secrets.filter(Boolean))]
}

/** Resolves `work` or gives up after `ms`, so a stuck callback cannot hold the host. */
async function settleWithin(
  work: Promise<void> | void,
  ms: number,
): Promise<'settled' | 'timed-out'> {
  if (!(work instanceof Promise)) return 'settled'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(() => 'settled' as const),
      new Promise<'timed-out'>((resolve) => {
        timer = setTimeout(() => resolve('timed-out'), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createNativeAnthropicAdapter<Q, P>(
  deps: NativeAnthropicAdapterDeps<Q, P>,
): NativeAnthropicAdapter<Q, P> {
  const { source, log } = deps
  const maxPending = Math.max(
    1,
    deps.maxPendingSends ?? DEFAULT_MAX_PENDING_SENDS,
  )
  const endTimeoutMs =
    deps.attemptEndTimeoutMs ?? DEFAULT_ATTEMPT_END_TIMEOUT_MS
  type Data = NativeAnthropicAttemptData<P>
  type BillingSend = { input: AnthropicBillingRequest; received: boolean }
  // Only host-owned sends belong here. Recovery fetches own their billing
  // state so ending the original host attempt cannot retire an in-flight resend.
  const billingSends = new WeakMap<Data, BillingSend>()
  const hostAttempts = new Map<Data, { sessionID: string; attempt: number }>()
  let quotaStopMessages = new WeakMap<Data, string>()
  let requestGzipLatch = deps.requestGzipLatch
  const gzipLatch = async () => {
    if (requestGzipLatch) return requestGzipLatch
    const paths = await resolveNativePoolPaths()
    requestGzipLatch ??= getRequestGzipLatch(
      getRequestGzipLatchPath(paths.legacyConfig, stateLayoutOfPaths(paths)),
    )
    return requestGzipLatch
  }
  // Direct sends whose body this adapter gzipped. The host performs the fetch
  // and its limit and output detection see the response before
  // rewriteResponse does, so a rejected gzipped body cannot be resent here
  // the way OpenCode 1 and Pi resend it. Instead a rejection turns gzip off
  // for this process and the next request goes out uncompressed.
  const gzippedSends = new WeakSet<Data>()

  // Keyed by the fresh per-send data object that `accountHeaders` returns
  // alongside the credential headers, so two sends never share an entry even
  // on the same account and session. An entry is removed when its request is
  // rewritten, when the send ends, when its session is forgotten, or when it
  // is the oldest beyond the bound.
  const pending = new Map<Data, PendingSend>()
  // Sends refused locally, by the check that refused them. Weakly held: the
  // entry lasts while that per-send data object is reachable (the installer
  // keeps it on the attempt), because the retry hook may ask about the send
  // after it has ended.
  const localRefusals = new WeakMap<Data, string>()
  // A relay's own failure is not a provider credential failure. Only a
  // provider request-id proves that its response came from Anthropic.
  const relayUpstream = new WeakMap<Data, boolean>()
  // The same-account hook has scope but no attempt handle. Retain only the
  // latest send's correlation data to classify a relay network error when no
  // response supplied a limit. Credentials remain in the per-send stores.
  const retryKey = (scope: AccountRequest) =>
    JSON.stringify([
      scope.providerID,
      scope.sessionID,
      scope.kind,
      scope.modelID,
      scope.agent,
      scope.accountId,
    ])
  const retryAttempts = new Map<string, Attempt<Data>>()
  const responseToolNameMaps = new WeakMap<
    Data,
    NonNullable<StrippedStreamOptions['toolNameMap']>
  >()
  const cacheDiagnosticsSends = new WeakMap<Data, CacheDiagnosticsSend>()
  const serverFallbackSends = new WeakMap<Data, string>()
  type PhysicalSend = {
    headers: Headers
    bodyText: string
    framing: ProviderResponseMode
    join?: RefusalFallbackStreamOptions
    fallback?: RefusalFallbackDispatchOptions
    target400?: (response: Response) => Promise<Response>
    observeCompletion?: (response: Response) => Response
    settleSourceReturn?: () => void
  }
  const physicalSends = new WeakMap<Data, PhysicalSend>()
  const roundCacheSends = new WeakSet<Data>()
  const latestPrimary = new Map<string, object>()
  const markPrimary = (sessionID: string, marker: object) => {
    latestPrimary.delete(sessionID)
    latestPrimary.set(sessionID, marker)
    if (latestPrimary.size > maxPending) {
      const oldest = latestPrimary.keys().next()
      if (!oldest.done) latestPrimary.delete(oldest.value)
    }
  }
  // Each sent request privately holds its own credentials, so errors about
  // it can be scrubbed after rewriteSend has dropped the pending credential:
  // a response scope for the one response the request gets, and a redactor
  // for the classifier inputs read while the request is live. Entries are
  // keyed by the per-send data object, so concurrent and retried sends never
  // share them, and are bounded like `pending`. Both are disposed when the
  // response scope settles (its body ended, was cancelled or failed, or a
  // success was left untouched), when the send ends cleanly, is cancelled or
  // abandoned, after the retry hook classified it, when its session is
  // forgotten, or on disposal. No credential is kept past that point.
  const owned = new Map<
    Data,
    {
      readonly sessionID: string
      readonly redactor: ProviderErrorRedactor
      readonly scope: ProviderErrorResponseScope
    }
  >()
  // What the retry hook may still read about a send after its credentials
  // were retired: the status or the already-scrubbed stream error.
  const safeSummaries = new WeakMap<Data, string>()
  // Used once a send's credentials are gone, or for a send this adapter never
  // rewrote: successful frames pass unchanged, while error text and error
  // bodies are replaced with a generic message.
  const withheld = createProviderErrorRedactor([])
  withheld.dispose()
  const scrubberFor = (data: Data | undefined) =>
    (data && owned.get(data)?.redactor) ?? withheld
  const release = (data: Data) => {
    threadRequests.get(data)?.thread.fail()
    threadRequests.delete(data)
    const entry = owned.get(data)
    if (!entry) return
    owned.delete(data)
    entry.redactor.dispose()
    entry.scope.dispose()
  }
  const holdRedactor = (
    data: Data,
    send: PendingSend,
    mode: ProviderResponseMode,
    physical: Headers,
    // Header values of the gateway this send goes to; its errors may echo them.
    gatewaySecrets: readonly string[] = [],
  ) => {
    const secrets = [
      ...new Set([...sendSecrets(send, physical), ...gatewaySecrets]),
    ]
    const scope = createProviderErrorResponseScope(secrets, mode)
    modes.set(data, mode)
    owned.set(data, {
      sessionID: send.sessionID,
      redactor: createProviderErrorRedactor(secrets),
      scope,
    })
    void scope.settled.then(() => {
      if (owned.get(data)?.scope === scope) release(data)
    })
    while (owned.size > maxPending) {
      const oldest = owned.keys().next().value
      if (oldest === undefined) break
      release(oldest)
    }
  }
  // Each sent request's response mode, which holds no secret, so a response
  // arriving after its credentials were retired is still read the way its
  // request asked for (a streamed request's error frames are withheld even
  // when the response has no event-stream content type).
  const modes = new WeakMap<Data, ProviderResponseMode>()
  /**
   * Fails closed for a response whose credentials are gone. A successful
   * response is read by a secretless scope in the request's mode, retired
   * before any byte is read: successful bytes are unchanged and error frames
   * are replaced with a generic message.
   */
  const scrubLate = (data: Data | undefined, response: Response) => {
    const mode = data ? modes.get(data) : undefined
    // A non-2xx response is an HTTP error in either mode. The disposed
    // redactor drops its status text and keeps only headers whose values it
    // can still verify (retry and rate-limit fields), so a credential in the
    // status text or a custom header never passes.
    if (!mode || !response.ok) return withheld.redactResponse(response)
    const late = createProviderErrorResponseScope([], mode)
    const safe = late.redactResponse(response)
    late.dispose()
    return safe
  }
  /** Scrubs the send's one response with its live scope, or fails closed. */
  const scrubResponse = (data: Data | undefined, response: Response) => {
    const scope = data ? owned.get(data)?.scope : undefined
    if (!scope) return scrubLate(data, response)
    try {
      return scope.redactResponse(response)
    } catch {
      return scrubLate(data, response)
    }
  }
  let disposed = false

  // Request-dump state for OpenCode 2. One entry per physical send, keyed by
  // the send's per-attempt data object. The entry holds the final signed
  // request body (never the gzipped wire bytes), the URL, method and headers
  // as sent, and for HTTP-relay sends the envelope actually posted. Entries
  // are written in `rewriteResponse` once the status is known, or in
  // `onAttemptEnd` with a fixed error label when no response arrived. They
  // hold a credential-bearing headers copy only until that dump finishes, and
  // are dropped on `forgetSession` and `dispose`. Background CacheKeep and
  // Prime sends never store an entry here: CacheKeep prewarms are dumped by
  // Core's manager with the `cachekeep` tag, and Prime has no OpenCode 1 dump.
  type DumpContext = {
    readonly affinity: string
    readonly route: string
    readonly bodyText: string
    readonly url: string
    readonly method: string
    readonly headers: Headers
    readonly dispatch: 'direct' | 'http-relay'
    readonly relayUrl?: string
    readonly envelope?: Record<string, unknown>
    readonly relayBytes?: number
    readonly tag?: DumpTag
  }
  const dumpContexts = new Map<Data, DumpContext>()
  const dumpHandles = new WeakMap<Data, DumpHandle>()
  const dumpMessageStarts = new WeakMap<Data, Record<string, unknown>>()
  const dumpWrites = new WeakMap<Data, Promise<void>>()
  const isBackgroundDumpScope = (attempt: Attempt<Data>) =>
    attempt.agent === 'cachekeep' || attempt.agent === 'prime'
  const dumpEnabledForSend = async (): Promise<boolean> => {
    try {
      if (source.isDumpEnabled) return await source.isDumpEnabled()
    } catch {
      return false
    }
    try {
      return isDumpEnabledCore()
    } catch {
      return false
    }
  }
  const dropDumpContext = (data: Data) => {
    dumpContexts.delete(data)
  }

  // The headers object of each failed response this adapter rewrote, mapped
  // to its send. Holding no secret and only weak references, it lets the
  // response classifier recognize that exact rewritten response: its body
  // went through the send's response scope, so it is already scrubbed and
  // bounded even after that scope has ended. A copy of the headers, or any
  // other response, is not recognized and is scrubbed as raw text.
  const rewrittenFailures = new WeakMap<Headers, Data>()
  const physicalAcceptances = new WeakMap<Data, { at: number }>()
  const finalAcceptances = new WeakMap<Response, { at: number }>()
  const rewrittenFailure = (data: Data | undefined, response: Response) => {
    if (data && !response.ok) rewrittenFailures.set(response.headers, data)
    const accepted =
      data?.route === 'oauth' && response.ok
        ? physicalAcceptances.get(data)
        : undefined
    if (accepted) finalAcceptances.set(response, accepted)
    return response
  }

  // Sends authorized for an HTTP relay that went straight to the user's
  // gateway instead (a gateway-routed model request). Every later step treats
  // them as direct sends.
  const sentDirect = new WeakSet<Data>()
  const dispatchOf = (data: Data): 'direct' | 'http-relay' =>
    sentDirect.has(data) ? 'direct' : data.dispatch

  const fromUpstream = (headers: Headers, data: Data) => {
    if (dispatchOf(data) !== 'http-relay') return true
    const upstream = /^req_[A-Za-z0-9_-]+$/.test(
      headers.get('request-id') ?? '',
    )
    relayUpstream.set(data, upstream)
    return upstream
  }

  const refuse = (scope: RequestScope) =>
    new NativeAnthropicNoAccountError(scope.sessionID, scope.kind)

  // Choices, authorizations and rewrites still waiting on the source or on
  // the request body, by session. `forgetSession` marks a session's entries
  // revoked; each one checks after its waits and again as it settles, so
  // work for a forgotten session can never hand back an account, a
  // credential or a request. An
  // entry is removed as soon as its work finishes, so the map only holds
  // sessions with work in progress and keeps nothing for closed sessions.
  const inProgress = new Map<string, Set<{ revoked: boolean }>>()

  const tracked = async <T>(
    scope: RequestScope,
    work: (ensureLive: () => void) => Promise<T>,
  ): Promise<T> => {
    if (disposed)
      throw new NativeAnthropicRevokedError(scope.sessionID, scope.kind)
    const operation = { revoked: false }
    let operations = inProgress.get(scope.sessionID)
    if (!operations) {
      operations = new Set()
      inProgress.set(scope.sessionID, operations)
    }
    operations.add(operation)
    const ensureLive = () => {
      requestSignal()?.throwIfAborted()
      if (disposed || operation.revoked) {
        throw new NativeAnthropicRevokedError(scope.sessionID, scope.kind)
      }
    }
    try {
      const result = await work(ensureLive)
      // Checked again once the work has settled: a session forgotten after
      // the work's last own check but before this point gets nothing back.
      ensureLive()
      return result
    } finally {
      const current = inProgress.get(scope.sessionID)
      if (current?.delete(operation) && current.size === 0) {
        inProgress.delete(scope.sessionID)
      }
    }
  }

  const remember = (data: Data, send: PendingSend) => {
    pending.set(data, send)
    while (pending.size > maxPending) {
      const oldest = pending.keys().next().value
      if (oldest === undefined) break
      pending.delete(oldest)
      log?.warn('dropped the oldest pending Anthropic send to stay bounded', {
        bound: maxPending,
      })
    }
  }

  const contextOf = (
    attempt: Attempt<Data>,
    data: Data,
  ): NativeAnthropicAttemptContext<P> => ({
    providerID: attempt.providerID,
    modelID: attempt.modelID,
    sessionID: attempt.sessionID,
    agent: attempt.agent,
    kind: attempt.kind,
    accountId: attempt.accountId,
    attemptId: attempt.attemptId,
    transport: attempt.transport,
    route: data.route,
    provenance: resendProvenance.get(data) ?? data.provenance,
    dispatch: dispatchOf(data),
  })

  const accountHeaders = (
    request: AccountRequest,
  ): Promise<AccountHeadersResult<Data>> =>
    tracked(request, async (ensureLive) => {
      const { accountId, ...scope } = request
      let auth: NativeAnthropicAuthorization<P> | undefined
      try {
        auth = await source.authorizeAccount(scope, accountId)
      } catch (error) {
        const refusal = stateRefusalFrom(error)
        if (refusal) {
          log?.warn(
            'refused an Anthropic request: its account state was moved or could not be recorded',
            { error: refusal.cause instanceof Error ? refusal.cause.name : '' },
          )
          throw refusal
        }
        throw error
      }
      ensureLive()
      return headersFor(scope, auth)
    })

  const headersFor = (
    scope: RequestScope,
    auth: NativeAnthropicAuthorization<P> | undefined,
  ): AccountHeadersResult<Data> => {
    if (!auth) throw refuse(scope)
    // With the user's gateway, a model request goes to the gateway and only
    // other requests meet the WebSocket relay's refusal, which rewriteSend
    // applies once the request URL is known.
    if (
      auth.dispatch?.kind === 'websocket-relay' &&
      !(auth.route === 'oauth' && auth.gateway)
    )
      throw new NativeAnthropicTransportRefusal()
    const dispatch =
      auth.dispatch?.kind === 'http-relay' ? 'http-relay' : 'direct'
    const relayHeaders: HeaderEdits | undefined =
      auth.dispatch?.kind === 'http-relay'
        ? {
            authorization: null,
            'x-api-key': null,
            'x-relay-token': auth.dispatch.token,
          }
        : undefined
    if (auth.route === 'oauth') {
      if (!auth.accessToken) throw refuse(scope)
      // A slot whose credential the vault owns holds a non-secret activation
      // marker (a tombstone) in place of a token. It stands for the vault's
      // ownership, not for credential content, so it is never sent as a
      // bearer token.
      assertNotCustodyTombstone(auth.accessToken, ANTHROPIC_PROVIDER_ID)
      const data: Data = Object.freeze({
        route: 'oauth',
        provenance: auth.provenance,
        dispatch,
      })
      remember(data, {
        sessionID: scope.sessionID,
        oauth: {
          accessToken: auth.accessToken,
          credentialId: auth.credentialId,
          ...(auth.identity ? { identity: auth.identity } : {}),
        },
        dispatch: auth.dispatch,
        oauthHeaders: auth.headers,
        ...(auth.gateway ? { gateway: auth.gateway } : {}),
      })
      const extra = lowerCaseEdits(auth.headers)
      for (const name of CREDENTIAL_HEADERS) delete extra[name]
      // rewriteRequest finalizes betas for the outgoing body. Omit that header
      // here so the installer's later generic edits cannot overwrite it.
      delete extra['anthropic-beta']
      // With a gateway, a send authorized for an HTTP relay may still go
      // straight to the gateway once rewriteSend sees its URL. These edits
      // win on the wire after that rewrite, so they must suit both sends:
      // they neither remove the bearer rewriteSend sets for the gateway nor
      // add the relay token, which the relay request carries itself.
      if (auth.dispatch?.kind === 'http-relay' && auth.gateway)
        return { headers: { ...extra, 'x-api-key': null }, attempt: data }
      return {
        headers: relayHeaders ?? {
          ...extra,
          'x-api-key': null,
          authorization: `Bearer ${auth.accessToken}`,
        },
        attempt: data,
      }
    }
    const headers = {
      authorization: null,
      'x-api-key': null,
      ...lowerCaseEdits(auth.headers),
    }
    if (!headers.authorization && !headers['x-api-key']) throw refuse(scope)
    const data: Data = Object.freeze({
      route: 'api',
      provenance: auth.provenance,
      dispatch,
    })
    remember(data, {
      sessionID: scope.sessionID,
      ...(auth.baseURL ? { baseURL: auth.baseURL } : {}),
      dispatch: auth.dispatch,
      apiHeaders: headers,
    })
    return { headers: relayHeaders ?? headers, attempt: data }
  }

  const messageThreads = MessageThreadTracker.withTailPersistence('opencode2')
  const threadRequests = new WeakMap<
    Data,
    {
      thread: MessageThreadRequest
      beforeResend: (
        response: Response,
      ) => Promise<false | { credential: string }>
      resend: (body: string) => Promise<Response>
    }
  >()
  const resendProvenance = new WeakMap<Data, P>()
  const recoveredSource = new WeakMap<
    Response,
    Pick<RefusalFallbackDispatchOptions, 'protectedOrigin'> & {
      headers: Headers
      bodyText: string
      billing?: AnthropicBillingRequest
    }
  >()
  const classifiedForRetry = new WeakSet<Data>()
  const rewriteRequest = (
    input: AccountRequest & {
      readonly request: Request
      readonly attempt: Attempt<Data>
    },
  ): Promise<Request> =>
    tracked(input, (ensureLive) => rewriteSend(input, ensureLive))

  const rewriteSend = async (
    input: AccountRequest & {
      readonly request: Request
      readonly attempt: Attempt<Data>
    },
    ensureLive: () => void,
  ): Promise<Request> => {
    const { request, attempt } = input
    const data = attempt.data
    retryAttempts.set(retryKey(input), attempt)
    while (retryAttempts.size > maxPending) {
      const first = retryAttempts.keys().next()
      if (!first.done) retryAttempts.delete(first.value)
    }
    const send = data ? pending.get(data) : undefined
    // One authorization serves one send: the entry is gone after this call,
    // so a credential never outlives the request it was issued for.
    if (data) pending.delete(data)
    if (!data || !send || (data.route === 'oauth' && !send.oauth)) {
      throw refuse(input)
    }

    let headers = new Headers(request.headers)
    if (data.route === 'api') applyCustomHeaders(headers)
    const correlation = takeInternalHeaders(headers)
    const primary =
      attempt.kind === 'primary' &&
      !isAuxiliaryAgent(attempt.agent) &&
      attempt.agent !== 'cachekeep' &&
      attempt.agent !== 'compaction' &&
      correlation[LANE_START_REQUEST_HEADER] !== '1'
    const primaryMarker = {}
    const originalBody =
      request.body === null ? undefined : await request.text()
    let body = originalBody
    let threadCacheSlot: Parameters<
      typeof prepareMessageThreadRequest
    >[1]['cacheSlot']
    let diagnosticsOptIn:
      | Pick<
          CacheDiagnosticsRequestContext,
          'previousMessageId' | 'previousMessageReceivedAt'
        >
      | undefined
    // A session forgotten while the body was read never reaches the source's
    // options or the body rewrite.
    ensureLive()
    const messages = body !== undefined && isMessagesUrl(request.url)
    let cacheKeepBodyChanged = false
    const url =
      rewriteUrl(
        request.url,
        send.baseURL !== undefined ? { baseURL: send.baseURL } : {},
      ).url?.toString() ?? request.url
    // The user's gateway, as read when this send was authorized, takes OAuth
    // model requests. The thread, gzip, URL and redaction choices below all
    // use this value.
    const configuredGateway =
      data.route === 'oauth' && request.method.toUpperCase() === 'POST'
        ? send.gateway
        : undefined
    const gatewayUrl = configuredGateway
      ? claudeGatewayModelUrl(url, configuredGateway)
      : undefined
    const gateway: ClaudeGateway | undefined = gatewayUrl
      ? configuredGateway
      : undefined
    // The relay choice is made per request: a gateway-routed model request
    // goes straight to the gateway, never through a relay; any other request
    // keeps the authorized dispatch, so it still uses the relay or meets the
    // WebSocket relay's refusal.
    const dispatch = gateway ? undefined : send.dispatch
    if (dispatch?.kind === 'websocket-relay')
      throw new NativeAnthropicTransportRefusal()
    if (gateway && send.dispatch?.kind === 'http-relay') sentDirect.add(data)
    // A send authorized for a relay carries the relay token header from its
    // authorization. The relay envelope sets its own, and a send routed to
    // the gateway must never carry it, so it is dropped here for every send.
    headers.delete('x-relay-token')

    let refusalFallbackMode: RefusalFallbackMode | undefined
    try {
      if (data.route === 'oauth' && send.oauth) {
        // The request URL comes from provider configuration, which a project
        // file in an opened repository can set. An OAuth token goes only to
        // Anthropic (or the user's own gateway, for a model request): refuse
        // anything else before the request is built.
        requireOAuthDestination(url, gateway)
        const { accessToken, identity } = send.oauth
        for (const [name, value] of Object.entries(
          lowerCaseEdits(send.oauthHeaders),
        )) {
          if (CREDENTIAL_HEADERS.has(name)) continue
          if (value === null) headers.delete(name)
          else headers.set(name, value)
        }
        let finalBody: Record<string, unknown> | null = null
        if (body !== undefined && messages) {
          const context: NativeAnthropicRequestContext<P> = {
            ...contextOf(attempt, data),
            modelID: (() => {
              const payload = parseJson(body)
              return remapModelId(
                isRecord(payload) && typeof payload.model === 'string'
                  ? payload.model
                  : input.modelID,
              )
            })(),
            route: 'oauth',
            correlation,
          }
          const { cacheDiagnosticsPreviousMessageReceivedAt, ...options } =
            (await source.requestOptions?.(context)) ?? {}
          refusalFallbackMode =
            options.refusalFallbackMode ??
            (options.serverSideFallbackEnabled
              ? 'server'
              : DEFAULT_REFUSAL_FALLBACK_MODE)
          // Recheck session revocation after awaiting policy options. A
          // cleared session must not enter body rewriting or signing.
          ensureLive()
          // A CacheKeep prewarm carries the body this session already sent,
          // re-signed for the prewarm. Rewriting it again would prefix the
          // tool names twice and add the system blocks again, so the prewarm
          // would miss the session's cache instead of reading it.
          if (attempt.agent !== 'cachekeep') {
            if (options.cacheDiagnosticsPreviousMessageId !== undefined) {
              diagnosticsOptIn = {
                previousMessageId: options.cacheDiagnosticsPreviousMessageId,
                previousMessageReceivedAt:
                  cacheDiagnosticsPreviousMessageReceivedAt,
              }
            }
            body = await rewriteRequestBody(body, {
              ...options,
              serverSideFallbackEnabled:
                refusalFallbackMode === 'server' &&
                options.serverSideFallbackEnabled === true,
              deferSigning: true,
              onThreadCacheSlot: (slot) => {
                threadCacheSlot = slot
              },
              ...(identity ? { identity } : {}),
              sessionId: input.sessionID,
              modelId: input.modelID,
              isOAuth: true,
              onToolNameMap: (map) => responseToolNameMaps.set(data, map),
            })
          }
          const parsed = parseJson(body)
          finalBody = isRecord(parsed) ? parsed : null
          if (
            attempt.agent === 'cachekeep' &&
            finalBody &&
            sanitizeClaudeCodeRequestBody(finalBody, refusalFallbackMode)
          ) {
            body = JSON.stringify(finalBody)
            cacheKeepBodyChanged = true
          }
        }
        if (attempt.agent === 'cachekeep' && deps.cacheKeepHeaders) {
          headers = new Headers(deps.cacheKeepHeaders)
          headers.delete('content-encoding')
          headers.set('authorization', `Bearer ${accessToken}`)
        } else {
          setOAuthHeaders(headers, accessToken, {
            body: finalBody,
            refusalFallbackMode,
            ...(identity ? { identity } : {}),
            requestClass:
              attempt.kind !== 'primary' || isAuxiliaryAgent(attempt.agent)
                ? 'auxiliary'
                : 'main',
          })
        }
      } else {
        if (body !== undefined && messages)
          body = rewriteApiKeyRequestBody(body, {
            sessionId: input.sessionID,
            modelId: input.modelID,
          })
        headers.delete('authorization')
        headers.delete('x-api-key')
        for (const [name, value] of Object.entries(send.apiHeaders ?? {})) {
          if (value === null) headers.delete(name)
          else headers.set(name, value)
        }
        if (body !== undefined && messages && !headers.has('content-type')) {
          headers.set('content-type', 'application/json')
        }
        const betas = headers.get('anthropic-beta')
        if (betas !== null) {
          const kept = apiKeyRequestBetas(betas)
          if (kept) headers.set('anthropic-beta', kept)
          else headers.delete('anthropic-beta')
        }
      }
    } catch (error) {
      const refusal = localRefusalFrom(error)
      if (!refusal) throw error
      localRefusals.set(data, refusal.check)
      log?.warn('refused an Anthropic request locally; nothing was sent', {
        check: refusal.check,
      })
      throw refusal
    }

    const sourceHeaders = new Headers(headers)
    const sourceBody = body
    const rounds = deps.rounds
    const model = sourceBody && parseJson(sourceBody)
    const requestedModel =
      isRecord(model) && typeof model.model === 'string'
        ? model.model
        : remapModelId(input.modelID)
    const mode = refusalFallbackMode ?? DEFAULT_REFUSAL_FALLBACK_MODE
    const isBackground =
      isBackgroundDumpScope(attempt) ||
      correlation[LANE_START_REQUEST_HEADER] === '1'
    const policy =
      rounds &&
      !isBackground &&
      messages &&
      deps.roundPolicy?.({
        ...contextOf(attempt, data),
        modelID: requestedModel,
        baseUrl: url,
      })
    const targetAllowed = (model: string) =>
      policy ? policy.targetAllowed(model) : true
    const roundPlan =
      rounds && messages && sourceBody !== undefined && !isBackground
        ? await (async () => {
            await rounds.loadThinking(input.sessionID)
            ensureLive()
            const plan: RefusalFallbackRoundInput = {
              sessionId: input.sessionID,
              requestedModel,
              kind: primary ? 'primary' : 'auxiliary',
              mode,
              bodyText: sourceBody,
              oauth:
                send.oauth &&
                isRecord(model) &&
                (model.stream === true || !primary)
                  ? {
                      accountId: input.accountId,
                      credentialId: send.oauth.credentialId,
                      targetAllowed,
                      cache: primary && policy ? policy.cacheRoute : undefined,
                    }
                  : undefined,
            }
            return primary ? rounds.plan(plan) : rounds.planRouted(plan)
          })()
        : undefined
    if (roundPlan) body = roundPlan.bodyText
    let recoveredRoundBody: string | undefined
    let bindRoundBilling: ((input: AnthropicBillingRequest) => void) | undefined
    if (primary && messages && deps.takeRoundThreadReset?.(input.sessionID))
      messageThreads.forget(input.sessionID, 'response_fallback')
    // The body may have changed length; let the runtime compute it.
    const finalPayload = body !== undefined ? parseJson(body) : undefined
    await source.admitRequest?.({
      ...contextOf(attempt, data),
      modelID: remapModelId(
        isRecord(finalPayload) && typeof finalPayload.model === 'string'
          ? finalPayload.model
          : input.modelID,
      ),
    })
    takeInternalHeaders(headers)
    if (body !== undefined) headers.delete('content-length')
    // Recheck session revocation after rewriting and signing before the
    // authenticated request can be returned to the caller.
    ensureLive()
    // Dispatch begins here; use this send's copied secrets to redact its errors.
    // The request's own stream flag decides how its response is read, never
    // the response's content type.
    const responseMode =
      isRecord(finalPayload) && finalPayload.stream === true
        ? 'event-stream'
        : 'http'
    const sentModel =
      isRecord(finalPayload) && typeof finalPayload.model === 'string'
        ? finalPayload.model
        : undefined
    const fullBodyText = body
    const routed =
      sentModel !== undefined && remapModelId(input.modelID) !== sentModel
    const clientStream =
      data.route === 'oauth' &&
      messages &&
      responseMode === 'event-stream' &&
      refusalFallbackMode === 'client' &&
      (headers
        .get('anthropic-beta')
        ?.split(',')
        .some((beta) => beta.trim() === SERVER_SIDE_FALLBACK_BETA) ??
        false)
    const clientSource =
      clientStream &&
      primary &&
      !routed &&
      Boolean(
        sentModel &&
          resolveClaudeModelCapabilities(sentModel)?.refusalFallbacks?.length,
      )
    const deferredCache =
      Boolean(roundPlan?.request) ||
      (clientStream && primary && (clientSource || routed))
    holdRedactor(
      data,
      send,
      responseMode,
      headers,
      claudeGatewayHeaderValues(gateway),
    )
    if (
      data.route === 'oauth' &&
      messages &&
      body !== undefined &&
      !deferredCache
    ) {
      await source.onRequestPrepared?.({
        ...contextOf(attempt, data),
        url,
        bodyText: await withoutFallbackCredit(body),
        signal: request.signal,
      })
      ensureLive()
    }
    if (
      data.route === 'oauth' &&
      send.oauth &&
      messages &&
      body !== undefined &&
      primary &&
      roundPlan?.kind !== 'routed' &&
      // Gateways may refuse the thread route: send full requests.
      !gateway
    ) {
      const expectedAccountUuid = send.oauth.identity?.accountUuid
      let resendAuthorization: NativeAnthropicAuthorization<P> | undefined
      const thread = await prepareMessageThreadRequest(messageThreads, {
        session: input.sessionID,
        account: send.oauth.identity?.accountUuid ?? input.accountId,
        credential: send.oauth.credentialId,
        bodyText: body,
        replyToolNames: responseToolNameMaps.get(data),
        cacheSlot:
          roundPlan?.kind === 'source' && roundPlan.sourceCacheMarkerRestored
            ? undefined
            : threadCacheSlot,
        headers,
        signal: request.signal,
      })
      body = thread.bodyText
      threadRequests.set(data, {
        thread,
        beforeResend: async () => {
          // common-auth's OpenCode 2 HTTP installer classifies errors before this rewrite.
          if (classifiedForRetry.has(data) || !owned.has(data)) return false
          ensureLive()
          request.signal.throwIfAborted()
          const authorized = await authorizeResend(
            sentModel ?? input.modelID,
            'thread',
            request.signal,
          )
          ensureLive()
          request.signal.throwIfAborted()
          if (
            !owned.has(data) ||
            authorized?.route !== 'oauth' ||
            !authorized.accessToken ||
            authorized.gateway ||
            !expectedAccountUuid ||
            authorized.identity?.accountUuid !== expectedAccountUuid
          )
            return false
          if (
            (authorized.dispatch?.kind ?? 'direct') !==
            (send.dispatch?.kind ?? 'direct')
          )
            return false
          ensureLive()
          if (!owned.has(data)) return false
          resendAuthorization = authorized
          return { credential: authorized.credentialId }
        },
        resend: async (createBody) => {
          ensureLive()
          request.signal.throwIfAborted()
          const authorized = resendAuthorization
          resendAuthorization = undefined
          if (!owned.has(data))
            throw new NativeAnthropicRevokedError(input.sessionID, input.kind)
          if (authorized?.route !== 'oauth' || !authorized.accessToken)
            throw refuse(input)
          resendProvenance.set(data, authorized.provenance)
          const retryHeaders = new Headers(headers)
          retryHeaders.set('authorization', `Bearer ${authorized.accessToken}`)
          release(data)
          holdRedactor(
            data,
            {
              ...send,
              oauth: {
                accessToken: authorized.accessToken,
                credentialId: authorized.credentialId,
                identity: authorized.identity,
              },
            },
            responseMode,
            retryHeaders,
          )
          const dispatch = authorized.dispatch
          const resendFetch = async (url: string, init: RequestInit) => {
            let billingSend: BillingSend | undefined
            try {
              assertHostAuthorityStable()
              const cleanBody = await withoutFallbackCredit(createBody)
              billingSend = observeFinalWire(cleanBody)
              assertHostAuthorityStable()
              notifyFinal(retryHeaders, attempt.attemptId, cleanBody)
              let received = await (deps.fetch ?? globalThis.fetch)(url, init)
              if (request.signal.aborted) {
                void received.body?.cancel().catch(() => {})
                request.signal.throwIfAborted()
              }
              let credit: string | undefined
              received = protectFallbackCreditResponse(received, {
                requestHeaders: retryHeaders,
                requestBodyText: createBody,
                framing: responseMode,
                ...(clientSource &&
                  received.ok && {
                    onRefusalCredit: (value: string) => {
                      credit = value
                    },
                  }),
              })
              if (billingSend) {
                if (roundPlan?.kind === 'round')
                  bindRoundBilling?.(billingSend.input)
                billingSend.received = true
                if (fromUpstream(received.headers, data))
                  received = observeAnthropicBillingResponse(
                    billingSend.input,
                    received,
                  )
              }
              if (received.ok && fromUpstream(received.headers, data)) {
                recoveredRoundBody = createBody
                if (clientSource) {
                  recoveredSource.set(received, {
                    headers:
                      dispatch?.kind === 'http-relay'
                        ? retryHeaders
                        : new Headers(init.headers),
                    bodyText: createBody,
                    billing: billingSend?.input,
                    protectedOrigin: {
                      takeRefusalCredit() {
                        const token = credit
                        credit = undefined
                        return token
                      },
                    },
                  })
                }
                physicalAcceptances.set(data, {
                  at: deps.now?.() ?? Date.now(),
                })
                source.quotaFromHeaders?.(received.headers, {
                  ...contextOf(attempt, data),
                  provenance: authorized.provenance,
                  status: received.status,
                })
              }
              return received
            } catch (error) {
              if (
                billingSend &&
                !billingSend.received &&
                dispatch?.kind !== 'http-relay'
              ) {
                billingSend.received = true
                reportAnthropicBillingFailure(billingSend.input)
              }
              request.signal.throwIfAborted()
              if (!isRecoveryTransportFailure(error)) throw error
              // Return an HTTP failure instead of rejecting the response hook,
              // so OpenCode can classify it and retry before any output starts.
              return Response.json(
                {
                  type: 'error',
                  error: {
                    type: 'api_error',
                    message:
                      'Connection lost while resending a rejected thread request',
                  },
                },
                { status: 502 },
              )
            }
          }
          let response: Response
          if (dispatch?.kind === 'http-relay') {
            if (hasFallbackCreditInRequest(createBody))
              throw new NativeAnthropicTransportRefusal()
            // Checked again at send time: the dispatch was chosen before a
            // proxy setting could have appeared.
            if (relayProxyApplies(dispatch.url))
              throw new Error(RELAY_PROXY_REFUSAL)
            const envelope = {
              protocol: 1,
              type: 'request',
              affinity: input.sessionID,
              upstream: {
                url,
                method: request.method,
                headers: Object.fromEntries(retryHeaders),
              },
              mode: 'full_sync',
              revision: 1,
              body: createBody,
              next_hash: `sha256:${createHash('sha256').update(createBody).digest('hex')}`,
            }
            dumpContexts.set(data, {
              affinity: input.sessionID,
              route: input.accountId,
              bodyText: createBody,
              url,
              method: request.method,
              headers: retryHeaders,
              dispatch: 'http-relay',
              relayUrl: dispatch.url,
              envelope,
              relayBytes: JSON.stringify(envelope).length,
            })
            response = await resendFetch(dispatch.url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-relay-token': dispatch.token,
              },
              body: JSON.stringify(envelope),
              signal: request.signal,
              redirect: 'error',
            })
          } else {
            if (dispatch?.kind === 'websocket-relay')
              throw new NativeAnthropicTransportRefusal()
            dumpContexts.set(data, {
              affinity: input.sessionID,
              route: input.accountId,
              bodyText: createBody,
              url,
              method: request.method,
              headers: retryHeaders,
              dispatch: 'direct',
            })
            response = await sendWithRequestGzip({
              url,
              body: createBody,
              headers: retryHeaders,
              latch: await gzipLatch(),
              send: (wireBody, wireHeaders) => {
                assertHostAuthorityStable()
                return resendFetch(url, {
                  method: request.method,
                  body: wireBody,
                  headers: wireHeaders,
                  signal: request.signal,
                  redirect: 'error',
                })
              },
            })
          }
          return inspectableThreadError(response)
        },
      })
      ensureLive()
    } else if (
      data.route === 'oauth' &&
      messages &&
      body !== undefined &&
      (attempt.agent !== 'cachekeep' || cacheKeepBodyChanged)
    ) {
      body = await signRequestBody(body)
      ensureLive()
    }
    if (dispatch?.kind === 'http-relay') {
      // Each HTTP relay attempt sends the complete upstream body, not a patch.
      // A host retry authorizes credentials again and builds a new envelope;
      // it must not reuse this attempt's authorization.
      const upstreamBody = body ?? ''
      if (hasFallbackCreditInRequest(upstreamBody))
        throw new NativeAnthropicTransportRefusal()
      headers.delete('x-relay-token')
      const envelope = {
        protocol: 1,
        type: 'request',
        affinity: input.sessionID,
        upstream: {
          url,
          method: request.method,
          headers: Object.fromEntries(headers),
        },
        mode: 'full_sync',
        revision: 1,
        body: upstreamBody,
        next_hash: `sha256:${createHash('sha256').update(upstreamBody).digest('hex')}`,
      }
      // Remember the final signed upstream body for the request dump. The
      // dump is written in `rewriteResponse` once the status is known, so a
      // 401 retry writes one dump per physical attempt. Background CacheKeep
      // and Prime sends never store an entry: the manager dumps prewarms with
      // the `cachekeep` tag and Prime has no OpenCode 1 dump.
      if (messages && body !== undefined && !isBackgroundDumpScope(attempt)) {
        const tag: DumpTag | undefined =
          correlation[LANE_START_REQUEST_HEADER] === '1' ? 'start' : undefined
        const envelopeText = JSON.stringify(envelope)
        dumpContexts.set(data, {
          affinity: input.sessionID,
          route: input.accountId,
          bodyText: upstreamBody,
          url,
          method: request.method,
          headers: new Headers(headers),
          dispatch: 'http-relay',
          relayUrl: dispatch.url,
          envelope: envelope as Record<string, unknown>,
          relayBytes: envelopeText.length,
          ...(tag ? { tag } : {}),
        })
      } else {
        dropDumpContext(data)
      }
      assertHostAuthorityStable()
      // Checked again at send time: the dispatch was chosen before a proxy
      // setting could have appeared.
      if (relayProxyApplies(dispatch.url)) throw new Error(RELAY_PROXY_REFUSAL)
      const clientRequestId = headers.get('x-client-request-id')
      const relayRequest = new Request(dispatch.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-relay-token': dispatch.token,
          ...(clientRequestId
            ? { 'x-client-request-id': clientRequestId }
            : {}),
        },
        redirect: 'error',
        signal: request.signal,
        body: JSON.stringify(envelope),
      })
      return await registerPhysical(relayRequest, headers, url)
    }
    let wireBody: string | Uint8Array | undefined = body
    // Claude Code compresses only to api.anthropic.com, so a gateway gets the
    // uncompressed body.
    if (data.route === 'oauth' && messages && body !== undefined && !gateway) {
      const decision = await decideRequestGzip({
        url,
        body,
        latch: await gzipLatch(),
      })
      ensureLive()
      if (decision.gzip) {
        // `body` stays the signed identity text; only the wire bytes change.
        wireBody = await encodeGzipRequestBody(body)
        headers.set('content-encoding', 'gzip')
        gzippedSends.add(data)
        ensureLive()
      }
    }
    // Remember the final signed body for the request dump. `body` stays the
    // signed uncompressed text even when the wire carries gzipped bytes, as
    // on OpenCode 1, so the dump always holds the identity text.
    if (messages && body !== undefined && !isBackgroundDumpScope(attempt)) {
      const tag: DumpTag | undefined =
        correlation[LANE_START_REQUEST_HEADER] === '1' ? 'start' : undefined
      dumpContexts.set(data, {
        affinity: input.sessionID,
        route: input.accountId,
        bodyText: body,
        url,
        method: request.method,
        headers: new Headers(headers),
        dispatch: 'direct',
        ...(tag ? { tag } : {}),
      })
    } else {
      dropDumpContext(data)
    }
    assertHostAuthorityStable()
    // Only the destination and the gateway's own headers change.
    if (gateway && gatewayUrl) {
      requireOAuthDestination(gatewayUrl.toString(), gateway)
      applyClaudeGatewayHeaders(headers, gateway)
    }
    const finalRequest = new Request(gatewayUrl?.toString() ?? url, {
      method: request.method,
      headers,
      // An OAuth bearer must not follow a redirect to another host.
      redirect: data.route === 'oauth' ? 'error' : request.redirect,
      signal: request.signal,
      ...(wireBody !== undefined ? { body: wireBody } : {}),
    })
    return await registerPhysical(
      finalRequest,
      finalRequest.headers,
      finalRequest.url,
    )

    function notifyFinal(
      headers: Headers,
      attemptId: string,
      cleanBody: string,
    ) {
      try {
        source.onFinalRequestPrepared?.({
          attemptId,
          requestId: headers.get('x-client-request-id') ?? undefined,
          bodyText: cleanBody,
          ttlMs: requestCacheLifetimeMs(cleanBody),
        })
      } catch {
        /* Optional cache observation cannot fail a physical send. */
      }
    }

    async function authorizeResend(
      modelID: string,
      kind: NonNullable<NativeAnthropicSendScope['extraSend']>['kind'],
      signal: AbortSignal,
    ) {
      if (!data || !send?.oauth) return undefined
      const extraSend = { kind, credentialId: send.oauth.credentialId }
      return runWithRequestSignal(signal, async () => {
        const authorized = await source.authorizeAccount(
          { ...input, modelID, extraSend },
          input.accountId,
        )
        signal.throwIfAborted()
        if (
          authorized?.route !== 'oauth' ||
          !authorized.accessToken ||
          authorized.credentialId !== extraSend.credentialId ||
          authorized.identity?.accountUuid !== send.oauth?.identity?.accountUuid
        )
          return undefined
        await source.admitRequest?.({
          ...contextOf(attempt, data),
          modelID,
          extraSend,
          provenance: authorized.provenance,
        })
        signal.throwIfAborted()
        return authorized
      })
    }

    async function registerPhysical(
      prepared: Request,
      upstreamHeaders: Headers,
      destination: string,
    ): Promise<Request> {
      if (!data || !send) return prepared
      const cleaned =
        body === undefined ? undefined : await withoutFallbackCredit(body)
      const billing = observeFinalWire(cleaned)
      ensureLive()
      request.signal.throwIfAborted()
      assertHostAuthorityStable()
      if (roundPlan?.request && !rounds?.markSent(roundPlan.request)) {
        // The plan changed during thread preparation or signing. Nothing was
        // sent; redo final preparation from the host's original request.
        threadRequests.delete(data)
        gzippedSends.delete(data)
        dropDumpContext(data)
        pending.set(data, send)
        return rewriteSend(
          { ...input, request: new Request(request, { body: originalBody }) },
          ensureLive,
        )
      }
      const realTurn = currentCacheKeepRealTurn()
      if (roundPlan?.request) roundCacheSends.add(data)
      if (billing) billingSends.set(data, billing)
      if (data.route === 'oauth' && messages && cleaned !== undefined)
        notifyFinal(prepared.headers, attempt.attemptId, cleaned)
      if (primary && messages) {
        if (roundPlan?.kind === 'round') realTurn?.allowWarms()
        else realTurn?.excludeWarms()
        markPrimary(input.sessionID, primaryMarker)
      }
      if (!send.oauth || !messages || body === undefined) return prepared

      const originHeaders = new Headers(upstreamHeaders)
      originHeaders.delete('content-length')
      const context = contextOf(attempt, data)
      const relayOrigin = dispatch?.kind === 'http-relay' ? dispatch : undefined
      const physical: PhysicalSend = {
        headers: originHeaders,
        bodyText: body,
        framing: responseMode,
      }
      physicalSends.set(data, physical)
      const credentialId = send.oauth.credentialId
      const isCurrent = (ignoreMode = false) =>
        !disposed &&
        !request.signal.aborted &&
        (!primary || latestPrimary.get(input.sessionID) === primaryMarker) &&
        (source.isRefusalFallbackCurrent?.({
          ...context,
          credentialId,
          baseUrl: url,
          url: destination,
          ignoreMode,
        }) ??
          true)
      const isFresh = () => isCurrent()
      const handle = roundPlan?.request
      if (handle)
        physical.settleSourceReturn = rounds?.sourceReturnSettlement(
          handle,
          isFresh,
        )
      const targetPlan =
        roundPlan?.kind === 'round' || roundPlan?.kind === 'routed'
      if (!targetPlan && (!clientStream || (!clientSource && !routed)))
        return prepared

      const complete = (
        response: Response,
        template: string,
        served: NativeAnthropicAttemptContext<P>,
      ) => {
        const onCompleted = source.onCompletedFallbackRequest
        if (!onCompleted) return response
        const acceptedAt = deps.now?.() ?? Date.now()
        return observeCompletedCacheReply(response, true, (usage) => {
          if (!isFresh()) return
          void Promise.resolve()
            .then(() => {
              if (!isFresh()) return
              return onCompleted({
                ...served,
                url,
                bodyText: template,
                signal: request.signal,
                usage,
                acceptedAt,
                isFresh,
              })
            })
            .catch(() => {})
        })
      }
      const signal = request.signal
      const sourceModel = input.modelID
      // Thread preparation can change the beta list. Keep it, not the
      // gateway's transport headers, which the warmer must resolve anew.
      const templateHeaders = new Headers(sourceHeaders)
      const preparedBetas = originHeaders.get('anthropic-beta')
      if (preparedBetas) templateHeaders.set('anthropic-beta', preparedBetas)
      const lifecycle =
        handle &&
        rounds?.lifecycle(handle, {
          isFresh,
          targetAllowed,
          sentBodyText: () => recoveredRoundBody ?? body,
          onRoundActivity: policy ? policy.onRoundActivity : undefined,
          onCacheKeepTemplate:
            deps.onRoundCacheTemplate &&
            ((template, isCurrent) =>
              deps.onRoundCacheTemplate?.({
                ...context,
                url,
                headers: templateHeaders,
                signal,
                template,
                isCurrent,
              })),
        })
      if (clientStream)
        physical.join = { sourceModel, isFresh, signal, lifecycle }
      if (billing && lifecycle?.cacheKeepTemplateSettled) {
        const publication = lifecycle.cacheKeepTemplateSettled
        bindRoundBilling = (input) => {
          const warming = input.cacheWarming
          input.cacheWarmingAfter = () => (isFresh() ? publication : undefined)
          input.cacheWarming = () => (isFresh() ? warming?.() : undefined)
        }
        bindRoundBilling(billing.input)
      }
      if (!handle && deferredCache && fullBodyText !== undefined)
        physical.observeCompletion = (response) =>
          complete(response, fullBodyText, {
            ...context,
            modelID: sentModel ?? input.modelID,
          })
      const accountId =
        (roundPlan?.kind === 'round' || roundPlan?.kind === 'routed'
          ? input.accountId
          : billing?.input.accountId) ??
        send.oauth.identity?.accountUuid ??
        input.accountId
      let candidate:
        | Extract<NativeAnthropicAuthorization<P>, { route: 'oauth' }>
        | undefined
      let retry:
        | {
            context: NativeAnthropicAttemptContext<P>
            scope: ProviderErrorResponseScope
            upstream: boolean
          }
        | undefined
      const fallback: RefusalFallbackDispatchOptions = {
        sourceModel,
        origin: {
          accountId,
          credentialId,
          url: destination,
          headers: originHeaders,
          bodyText: body,
          fullBodyText,
        },
        isFresh,
        lifecycle,
        signal,
        billing: billing?.input ?? {
          sessionId: context.sessionID,
          requestKind: context.kind,
          chargeBasis: 'subscription_included',
        },
        onBillingReport: billing?.input.onReport,
        authorize: async ({ model, signal }) => {
          const fresh = () =>
            isCurrent(
              roundPlan?.kind === 'round' || roundPlan?.kind === 'routed',
            )
          if (!fresh()) return { kind: 'denied' }
          candidate = await authorizeResend(
            model,
            clientSource ? 'refusal' : 'source-resend',
            signal,
          )
          if (!candidate || !fresh()) return { kind: 'denied' }
          const transportBlocked =
            clientSource &&
            relayOrigin &&
            !(await source.allowsDirectRefusalRetry?.(context))
          if (!fresh()) return { kind: 'denied' }
          const gateway = candidate.gateway
          const nextUrl = gateway && claudeGatewayModelUrl(url, gateway)
          if (
            !nextUrl &&
            candidate.dispatch &&
            candidate.dispatch.kind !== 'direct' &&
            !(
              clientSource &&
              relayOrigin &&
              candidate.dispatch.kind === 'http-relay'
            )
          )
            return { kind: 'denied' }
          const resolved = nextUrl?.toString() ?? url
          requireOAuthDestination(resolved, nextUrl ? gateway : undefined)
          const binding = {
            accountId,
            credentialId: candidate.credentialId,
            url: resolved,
          }
          if (transportBlocked) return { kind: 'defer', ...binding }
          return {
            kind: 'authorized',
            ...binding,
            accessToken: candidate.accessToken,
          }
        },
        send: async ({ url, headers, body, bodyText, signal }) => {
          let authorization = candidate
          if (
            !authorization ||
            !isCurrent(
              roundPlan?.kind === 'round' || roundPlan?.kind === 'routed',
            )
          )
            throw refuse(input)
          signal.throwIfAborted()
          assertHostAuthorityStable()
          const payload = parseJson(bodyText)
          const modelID =
            isRecord(payload) && typeof payload.model === 'string'
              ? payload.model
              : input.modelID
          const attemptId = randomUUID()
          const relay = !clientSource ? relayOrigin : undefined
          const makeScope = (auth: NonNullable<typeof authorization>) =>
            createProviderErrorResponseScope(
              [
                auth.accessToken,
                ...claudeGatewayHeaderValues(auth.gateway),
                ...(relay ? [relay.token] : []),
              ],
              'event-stream',
            )
          let scope = makeScope(authorization)
          let usedRelay = false
          let envelope: Record<string, unknown> | undefined
          let status: number | undefined
          try {
            const fetchImpl = deps.fetch ?? globalThis.fetch
            let response: Response | undefined
            let upstream = true
            if (relay) {
              const upstreamHeaders = new Headers(headers)
              upstreamHeaders.delete('content-encoding')
              upstreamHeaders.delete('x-relay-token')
              envelope = {
                protocol: 1,
                type: 'request',
                affinity: input.sessionID,
                upstream: {
                  url,
                  method: prepared.method,
                  headers: Object.fromEntries(upstreamHeaders),
                },
                mode: 'full_sync',
                revision: 1,
                body: bodyText,
                next_hash: `sha256:${createHash('sha256').update(bodyText).digest('hex')}`,
              }
              try {
                if (relayProxyApplies(relay.url))
                  throw new Error(RELAY_PROXY_REFUSAL)
                usedRelay = true
                const clientRequestId = headers.get('x-client-request-id')
                response = await fetchImpl(relay.url, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    'x-relay-token': relay.token,
                    ...(clientRequestId
                      ? { 'x-client-request-id': clientRequestId }
                      : {}),
                  },
                  body: JSON.stringify(envelope),
                  signal,
                  redirect: 'error',
                })
              } catch (error) {
                if (!(await source.allowsDirectRefusalRetry?.(context)))
                  throw error
              }
              upstream =
                !!response &&
                /^req_[A-Za-z0-9_-]+$/.test(
                  response.headers.get('request-id') ?? '',
                )
              if (
                !response ||
                (!upstream &&
                  (response.status === 401 || response.status >= 500) &&
                  (await source.allowsDirectRefusalRetry?.(context)))
              ) {
                void response?.body?.cancel().catch(() => {})
                response = undefined
                signal.throwIfAborted()
                const fresh = await authorizeResend(
                  modelID,
                  'source-resend',
                  signal,
                )
                if (
                  !fresh ||
                  !isCurrent(true) ||
                  fresh.gateway ||
                  (fresh.dispatch && fresh.dispatch.kind !== 'direct')
                )
                  throw refuse(input)
                authorization = fresh
                headers.set('authorization', `Bearer ${fresh.accessToken}`)
                scope.dispose()
                scope = makeScope(fresh)
                assertHostAuthorityStable()
              } else if (!upstream && response.status === 401) {
                void response.body?.cancel().catch(() => {})
                throw new NativeAnthropicTransportRefusal()
              }
            }
            if (!response) {
              usedRelay = false
              upstream = true
              response = await fetchImpl(url, {
                method: prepared.method,
                headers,
                body: body as RequestInit['body'],
                signal,
                redirect: 'error',
              })
            }
            retry = {
              context: {
                ...context,
                modelID,
                attemptId,
                provenance: authorization.provenance,
                dispatch: usedRelay ? 'http-relay' : 'direct',
              },
              scope,
              upstream,
            }
            status = response.status
            return response
          } catch (error) {
            scope.dispose()
            throw error
          } finally {
            // Keep the fallback credit token out of the final-wire callback.
            // Dumps get the real JSON so Core can write a token placeholder.
            try {
              notifyFinal(
                headers,
                attemptId,
                await withoutFallbackCredit(bodyText),
              )
              if (await dumpEnabledForSend()) {
                setDumpEnabledCore(true)
                if (usedRelay && envelope && status !== undefined)
                  await dumpRelayRequest({
                    affinity: input.sessionID,
                    transport: 'http',
                    protocol: 1,
                    mode: 'full_sync',
                    status,
                    bodyText,
                    payload: envelope,
                    relayBytes: JSON.stringify(envelope).length,
                  })
                else if (!usedRelay)
                  await dumpDirectRequest({
                    affinity: input.sessionID,
                    route: input.accountId,
                    status,
                    ...(status === undefined && {
                      error: DUMP_PHYSICAL_SEND_FAILED,
                    }),
                    bodyText,
                    url,
                    method: prepared.method,
                    headers,
                  })
              }
            } catch {}
          }
        },
        observePhysicalResponse(response, physicalAttempt) {
          if (!physicalAttempt.refusalRetry) return response
          if (!retry) return response
          const { scope, context, upstream } = retry
          retry = undefined
          const safe = scope.redactResponse(response)
          try {
            if (upstream)
              source.quotaFromHeaders?.(safe.headers, {
                ...context,
                status: safe.status,
                reportRouting: false,
              })
          } catch {}
          return safe
        },
      }
      if (clientSource) physical.fallback = fallback
      else if (
        handle &&
        rounds &&
        (roundPlan.kind === 'round' || roundPlan.kind === 'routed')
      ) {
        const resendBilling = (model: string) =>
          billing && {
            ...billing.input,
            attemptId: randomUUID(),
            model,
            cacheWarmingAfter: undefined,
          }
        physical.target400 = (response) =>
          rounds.handleTarget400(handle, response, {
            ...fallback,
            send(request) {
              realTurn?.excludeWarms()
              return fallback.send(request)
            },
            isCurrentPrimary: () => isCurrent(true),
            onResendFailure: (model) => {
              const input = resendBilling(model)
              if (input) reportAnthropicBillingFailure(input)
            },
            observeResendResponse: (response, model) => {
              let safe =
                fallback.observePhysicalResponse?.(response, {
                  model,
                  ordinal: 2,
                  refusalRetry: true,
                  paysCacheWrite: false,
                  folded: false,
                }) ?? response
              const input = resendBilling(model)
              if (input) safe = observeAnthropicBillingResponse(input, safe)
              return safe
            },
          })
      }
      return prepared
    }

    function observeFinalWire(bodyText: string | undefined) {
      let billingSend: BillingSend | undefined
      const payload =
        messages && bodyText !== undefined ? parseJson(bodyText) : undefined
      if (data && messages && bodyText !== undefined) {
        try {
          const metadata = source.billingRequest?.(contextOf(attempt, data))
          if (metadata) {
            const ttlMs = requestShortestCacheLifetimeMs(bodyText)
            billingSend = {
              input: {
                ...metadata,
                // The host's attempt id is a counter that restarts with each
                // plugin load, so it repeats across server restarts. A billing
                // report's id must be unique per provider attempt for good.
                attemptId: randomUUID(),
                model:
                  isRecord(payload) && typeof payload.model === 'string'
                    ? payload.model
                    : metadata.model,
                ...(ttlMs > 0 ? { cache: { ...metadata.cache, ttlMs } } : {}),
              },
              received: false,
            }
          }
        } catch {}
      }
      if (data?.route !== 'oauth' || !messages || bodyText === undefined)
        return billingSend
      serverFallbackSends.delete(data)
      if (
        isRecord(payload) &&
        payload.fallbacks === 'default' &&
        typeof payload.model === 'string'
      )
        serverFallbackSends.set(data, payload.model)
      if (diagnosticsOptIn) {
        cacheDiagnosticsSends.delete(data)
        // For a relay, these are the upstream headers inside the envelope,
        // not the headers on the outer Request to the relay itself.
        if (
          hasCacheDiagnosticsBeta(headers) &&
          isRecord(payload) &&
          isRecord(payload.diagnostics) &&
          payload.diagnostics.previous_message_id ===
            diagnosticsOptIn.previousMessageId
        ) {
          cacheDiagnosticsSends.set(data, {
            ...diagnosticsOptIn,
            requestedModel:
              typeof payload.model === 'string' ? payload.model : undefined,
            ttlSent: summarizeCacheTtl(payload),
            betaInfo: getCacheDiagnosticsBetas(headers).catch(() => undefined),
          })
        }
      }
      return billingSend
    }
  }

  const adapter: NativeAnthropicAdapter<Q, P>['adapter'] = {
    providerID: ANTHROPIC_PROVIDER_ID,
    chooseAccount: (input) =>
      tracked(input, async () => {
        const choice = await source.chooseAccount(input)
        // The installer honours a hold only while judging a retry.
        if (typeof choice === 'object' && input.phase === 'retry') return choice
        if (typeof choice !== 'string' || !choice) throw refuse(input)
        return choice
      }),
    dropChoice: (input) => source.dropChoice?.(input),
    async retrySameAccount(input) {
      if (!source.retrySameAccount) return undefined
      const key = retryKey(input)
      const attempt = retryAttempts.get(key)
      retryAttempts.delete(key)
      const limit =
        input.limit ??
        (attempt ? adapter.limitFromError?.(input.error, attempt) : undefined)
      return source.retrySameAccount({
        ...input,
        error: safeHostError(input.error),
        ...(limit ? { limit } : {}),
      })
    },
    dropSameAccountRetry: (input) =>
      source.dropSameAccountRetry?.({
        ...input,
        error: safeHostError(input.error),
      }),
    accountHeaders,
    rewriteRequest,
    rewriteHandshakeURL() {
      throw new NativeAnthropicTransportRefusal()
    },
    async rewriteResponse({ response, attempt }) {
      const data = attempt.data
      const quotaStopMessage = data ? quotaStopMessages.get(data) : undefined
      if (data) quotaStopMessages.delete(data)
      const billingSend = data ? billingSends.get(data) : undefined
      const physical = data ? physicalSends.get(data) : undefined
      if (data) physicalSends.delete(data)
      const upstream = data && fromUpstream(response.headers, data)
      const threaded = data ? threadRequests.get(data) : undefined
      const failThread = threaded?.thread.fail
      if (data) threadRequests.delete(data)
      let fallback = upstream && response.ok && physical?.fallback
      let joined = false
      let terminalResend = false
      let targetStatus: number | undefined
      // A send whose failure was already reported (the fetch threw) must not
      // be billed a second time from the response it was replaced with.
      const firstReceipt = !!billingSend && !billingSend.received
      if (billingSend) billingSend.received = true
      const dispatchFallback = (fallback: RefusalFallbackDispatchOptions) => {
        // The dispatcher leaves JSON replies unjoined even on a streaming request.
        const contentType = response.headers.get('content-type') ?? ''
        joined =
          /text\/event-stream/i.test(contentType) ||
          !/\bjson\b/i.test(contentType)
        return dispatchRefusalFallback(response, {
          ...fallback,
          observePhysicalResponse: (guarded, attempt) => {
            if (attempt.refusalRetry)
              return (
                fallback.observePhysicalResponse?.(guarded, attempt) ?? guarded
              )
            let observed = scrubResponse(data, guarded)
            if (threaded) observed = threaded.thread.observe(observed)
            return physical?.observeCompletion?.(observed) ?? observed
          },
        })
      }
      if (fallback) {
        response = dispatchFallback(fallback)
      } else {
        if (physical)
          response = protectFallbackCreditResponse(response, {
            requestHeaders: physical.headers,
            requestBodyText: physical.bodyText,
            framing: physical.framing,
          })
        if (billingSend && firstReceipt && upstream)
          response = observeAnthropicBillingResponse(
            billingSend.input,
            response,
          )
        if (threaded && upstream) {
          response = await threaded.thread.recover(
            inspectableThreadError(response),
            threaded.resend,
            threaded.beforeResend,
          )
          const recovered = recoveredSource.get(response)
          if (recovered && physical?.fallback) {
            recoveredSource.delete(response)
            const original = physical.fallback
            fallback = {
              ...original,
              origin: {
                ...original.origin,
                headers: recovered.headers,
                bodyText: recovered.bodyText,
              },
              protectedOrigin: recovered.protectedOrigin,
              billing: recovered.billing
                ? {
                    ...recovered.billing,
                    cacheWarming: original.billing.cacheWarming,
                    cacheWarmingAfter: original.billing.cacheWarmingAfter,
                  }
                : original.billing,
            }
            response = dispatchFallback(fallback)
          } else response = threaded.thread.observe(response)
        } else threaded?.thread.fail()
        if (upstream && response.status === 400 && physical?.target400) {
          targetStatus = response.status
          const resent = await physical.target400(response)
          terminalResend = resent !== response
          response = resent
        }
      }
      if (data && !terminalResend && !fromUpstream(response.headers, data)) {
        if (data) dropDumpContext(data)
        // Relay authentication errors must not appear as an OAuth 401 to the
        // host or the native credential service.
        if (response.status === 401) {
          // Replace the relay's own 401 with a fixed 502. Clear the copied
          // credentials and cancel its unread network body before returning.
          release(data)
          void response.body?.cancel().catch(() => {})
          return Response.json(
            {
              type: 'error',
              error: {
                type: 'api_error',
                message:
                  'Relay authentication failed before Anthropic received the request',
              },
            },
            { status: 502 },
          )
        }
        // The relay's own failure can repeat the relay token or the
        // credential in the envelope it was given.
        return observeUnjoinedSourceReturn(
          scrubResponse(data, response),
          physical?.settleSourceReturn,
        )
      }
      if (data && gzippedSends.has(data)) {
        gzippedSends.delete(data)
        // Classify before the body is scrubbed or read; a clone is read.
        void classifyGzipRejection(response).then(
          async (kind) => {
            if (!kind) return
            const latch = await gzipLatch()
            latch.latchProcess()
            log?.warn(
              'gzipped request body rejected; later requests go uncompressed',
              { kind, status: response.status },
            )
          },
          () => {},
        )
      }
      // Write the request dump now that the status is known, as OpenCode 1
      // does after its fetch. Dumping never blocks or fails the request: any
      // filesystem error leaves no handle and the response is still served.
      // The stored headers copy (which carries the bearer) is dropped once the
      // dump finishes, and the body dumped is always the signed uncompressed
      // text, never the gzipped wire bytes.
      let dumpHandle: DumpHandle | null = null
      const pendingDump = data ? dumpContexts.get(data) : undefined
      if (data && pendingDump) {
        let enabled = false
        try {
          enabled = await dumpEnabledForSend()
        } catch {
          enabled = false
        }
        if (!enabled) {
          dropDumpContext(data)
        } else {
          try {
            setDumpEnabledCore(true)
          } catch {}
          try {
            if (pendingDump.dispatch === 'http-relay') {
              dumpHandle = await dumpRelayRequest({
                affinity: pendingDump.affinity,
                transport: 'http',
                protocol: 1,
                mode: 'full_sync',
                status: targetStatus ?? response.status,
                bodyText: pendingDump.bodyText,
                payload: pendingDump.envelope ?? {},
                relayBytes: pendingDump.relayBytes ?? 0,
                ...(pendingDump.tag ? { tag: pendingDump.tag } : {}),
              })
            } else {
              dumpHandle = await dumpDirectRequest({
                affinity: pendingDump.affinity,
                route: pendingDump.route,
                status: targetStatus ?? response.status,
                bodyText: pendingDump.bodyText,
                url: pendingDump.url,
                method: pendingDump.method,
                headers: pendingDump.headers,
                ...(pendingDump.tag ? { tag: pendingDump.tag } : {}),
              })
            }
          } catch {
            dumpHandle = null
          }
          dropDumpContext(data)
          if (dumpHandle) {
            dumpHandles.set(data, dumpHandle)
            try {
              await dumpResponseArtifact(dumpHandle, {
                status: response.status,
                message: null,
                complete: false,
              })
            } catch {}
            dumpWrites.set(data, Promise.resolve())
          }
        }
      }
      if (
        data?.route === 'oauth' &&
        response.status === 429 &&
        quotaStopMessage !== undefined
      ) {
        const text = await response.clone().text()
        const errors: ParseError[] = []
        const tree = parseTree(text, errors, {
          disallowComments: true,
          allowTrailingComma: false,
        })
        const node =
          tree && errors.length === 0
            ? findNodeAtLocation(tree, ['error', 'message'])
            : undefined
        if (node?.type === 'string') {
          // Splice just the message token, preserving every other body byte
          // and the original quota headers the installer has harvested.
          response = new Response(
            text.slice(0, node.offset) +
              JSON.stringify(quotaStopMessage) +
              text.slice(node.offset + node.length),
            {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            },
          )
        }
      }
      // Remove this send's secrets from provider errors before any other
      // reader; successful bytes pass through unchanged.
      let safe = fallback ? response : scrubResponse(data, response)
      if (
        !fallback &&
        !terminalResend &&
        safe.ok &&
        physical?.join &&
        !/\bjson\b/i.test(safe.headers.get('content-type') ?? '')
      ) {
        safe = physical.observeCompletion?.(safe) ?? safe
        safe = joinRefusalFallbackStream(safe, physical.join)
      } else if (!joined)
        safe = observeUnjoinedSourceReturn(safe, physical?.settleSourceReturn)
      let incompleteObserver:
        | ReturnType<typeof createDumpResponseObserver>
        | undefined
      const onIncompleteStream = async (
        diagnostics: IncompleteStreamDiagnostics,
      ) => {
        if (data) await dumpWrites.get(data)
        if (incompleteObserver) {
          incompleteObserver.fail(diagnostics)
          await incompleteObserver.finish()
          return
        }
        await dumpResponseArtifact(dumpHandle ?? null, {
          status: response.status,
          message: null,
          complete: false,
          incomplete_stream: diagnostics,
        })
      }
      // Only the OAuth route prefixes tool names, so only its responses are
      // mapped back. An API response reaches the host byte for byte.
      if (data?.route !== 'oauth' || !safe.body) {
        return rewrittenFailure(
          data,
          data && modes.get(data) === 'event-stream'
            ? guardAnthropicStreamResponse(safe, onIncompleteStream)
            : safe,
        )
      }
      const diagnostics = cacheDiagnosticsSends.get(data)
      cacheDiagnosticsSends.delete(data)
      const serverSideFallbackModel = serverFallbackSends.get(data)
      serverFallbackSends.delete(data)
      const context = {
        ...contextOf(attempt, data),
        status: response.status,
        ...(diagnostics ? { cacheDiagnostics: diagnostics } : {}),
        ...(serverSideFallbackModel ? { serverSideFallbackModel } : {}),
      }
      const options = source.responseOptions?.(context) ?? {}
      const json = data
        ? modes.get(data) === 'http'
        : (response.headers.get('content-type') ?? '').includes(
            'application/json',
          )
      const baseStreamOptions = {
        ...options,
        requireMessageStop: true,
        onIncompleteStream,
        toolNameMap: data ? responseToolNameMaps.get(data) : undefined,
        onResponseFailure: failThread,
        // Unsafe response names depend on this request's tool declarations,
        // not the Anthropic account. Changing accounts must not bypass refusal.
        onToolNameRefusal: () => {
          if (!data) return
          localRefusals.set(data, 'response_tool_names')
          release(data)
        },
        laneStartOAuthServed: true,
        ...(json ? { responseMode: 'json' as const } : {}),
      }
      if (!data || !dumpHandle) {
        return rewrittenFailure(
          data,
          createStrippedStream(safe, baseStreamOptions),
        )
      }
      // Observe the stripped stream the same way OpenCode 1 does, so the
      // response artifact carries the provider message id, model, usage and
      // stop reason instead of only the status.
      const handleForStream = dumpHandle
      const statusForStream = response.status
      const dumpObserver = createDumpResponseObserver(
        handleForStream,
        statusForStream,
      )
      incompleteObserver = dumpObserver
      const appendDumpWrite = (write: () => Promise<unknown>) => {
        const previous = dumpWrites.get(data) ?? Promise.resolve()
        const next: Promise<void> = previous
          .then(() => write().then(() => undefined))
          .catch(() => undefined)
        dumpWrites.set(data, next)
      }
      const originalStart = options.onMessageStart
      const originalDelta = options.onMessageDelta as
        | ((delta: {
            usage?: Record<string, unknown>
            stopReason?: string
          }) => void)
        | undefined
      const originalResponse = (
        options as {
          onMessageResponse?: (message: Record<string, unknown>) => void
        }
      ).onMessageResponse
      const originalEnd = options.onStreamEnd
      return rewrittenFailure(
        data,
        createStrippedStream(safe, {
          ...baseStreamOptions,
          onSseEvent: dumpObserver.observe,
          onMessageStart: (message: Record<string, unknown>) => {
            try {
              originalStart?.(message)
            } catch {}
            try {
              dumpMessageStarts.set(data, { ...message })
              appendDumpWrite(() =>
                dumpResponseArtifact(handleForStream, {
                  status: statusForStream,
                  message,
                  complete: false,
                }),
              )
            } catch {}
          },
          onMessageDelta: (delta: {
            usage?: Record<string, unknown>
            stopReason?: string
          }) => {
            try {
              originalDelta?.(delta)
            } catch {}
            try {
              const start = dumpMessageStarts.get(data) ?? {}
              const startUsage =
                start.usage &&
                typeof start.usage === 'object' &&
                !Array.isArray(start.usage)
                  ? (start.usage as Record<string, unknown>)
                  : {}
              const merged = {
                ...start,
                ...(delta.usage
                  ? { usage: { ...startUsage, ...delta.usage } }
                  : {}),
                ...(delta.stopReason ? { stop_reason: delta.stopReason } : {}),
              }
              appendDumpWrite(() =>
                dumpResponseArtifact(handleForStream, {
                  status: statusForStream,
                  message: merged,
                  complete: true,
                  reply_text_edges: dumpObserver.replyTextEdges(),
                }),
              )
            } catch {}
          },
          onMessageResponse: (message: Record<string, unknown>) => {
            try {
              originalResponse?.(message)
            } catch {}
            try {
              appendDumpWrite(() =>
                dumpResponseArtifact(handleForStream, {
                  status: statusForStream,
                  message,
                  complete: true,
                }),
              )
            } catch {}
          },
          onStreamEnd: async () => {
            try {
              await originalEnd?.()
            } catch {}
            try {
              await (dumpWrites.get(data) ?? Promise.resolve())
            } catch {}
          },
        }),
      )
    },
    quotaFromHeaders(headers, status, attempt) {
      const data = attempt.data
      if (!data || !fromUpstream(headers, data)) return undefined
      const billingSend = billingSends.get(data)
      if (status >= 400 && billingSend && !billingSend.received) {
        // common-auth ends HTTP errors before rewriteResponse. Capture the
        // upstream status and request ID before attempt cleanup drops them.
        billingSend.received = true
        createAnthropicBillingObserver(
          billingSend.input,
          status,
          headers,
        ).finish()
      }
      if (data.route === 'oauth' && status >= 200 && status < 300)
        physicalAcceptances.set(data, { at: deps.now?.() ?? Date.now() })
      return source.quotaFromHeaders?.(headers, {
        ...contextOf(attempt, data),
        status,
      })
    },
    async limitFromResponse({ status, headers, body, attempt }) {
      const data = attempt.data
      if (!data || localRefusals.get(data) === 'response_tool_names')
        return undefined
      if (!fromUpstream(headers, data))
        return source.limitFromRelayFailure?.({
          ...contextOf(attempt, data),
          status,
        })
      safeSummaries.set(data, `provider responded with HTTP ${status}`)
      // A failed response this adapter rewrote is read through its own
      // response scope, which scrubbed it while the credentials were live.
      // Once that read reaches the end the credentials are gone, so its text
      // is passed on as it is. Anything else is scrubbed here.
      const rewritten = rewrittenFailures.get(headers) === data
      const scrubber = scrubberFor(data)
      let limit: LimitSignal | undefined
      try {
        limit = await source.limitFromResponse?.({
          ...contextOf(attempt, data),
          status,
          headers,
          body: async () => {
            const text = await body()
            if (rewritten) return text
            const physical = physicalSends.get(data)
            // The host can classify an HTTP error before rewriting it. Guard
            // its clone so fallback credit tokens never reach the classifier.
            const guarded = physical
              ? await protectFallbackCreditResponse(
                  new Response(text, { status, headers }),
                  {
                    requestHeaders: physical.headers,
                    requestBodyText: physical.bodyText,
                    framing: 'http',
                  },
                ).text()
              : text
            return scrubber.redactText(guarded)
          },
        })
      } catch (error) {
        if (!isNativeTransientAccountError(error) || !error.poolRead)
          throw error
        // A busy account file prevents rerouting, not delivery of the provider's
        // response. Let the host classify and retry that response normally.
        return undefined
      }
      const hostAttempt = hostAttempts.get(data)?.attempt
      if (
        status === 429 &&
        data.route === 'oauth' &&
        hostAttempt !== undefined
      ) {
        // common-auth ends HTTP errors before rewriteResponse. Decide while
        // provenance is live; retain only the final text for that body's rewrite.
        const message = await Promise.resolve()
          .then(() =>
            source.quotaStopMessage?.({
              ...contextOf(attempt, data),
              status,
              hostAttempt,
            }),
          )
          .catch(() => undefined)
        if (message !== undefined && hostAttempts.has(data))
          quotaStopMessages.set(data, message)
      }
      if (limit) classifiedForRetry.add(data)
      return limit
    },
    inspectEvent({ data: payload, event, attempt }) {
      if (
        attempt.data &&
        localRefusals.get(attempt.data) === 'response_tool_names'
      )
        return undefined
      const parsed = parseJson(payload)
      if (!isRecord(parsed)) return undefined
      const type = typeof parsed.type === 'string' ? parsed.type : event
      // Mark output at the first text, thinking or tool block so a later
      // quota error cannot trigger account migration and replay that output.
      if (type === 'content_block_start' || type === 'content_block_delta') {
        return { outputStarted: true }
      }
      if (type === 'message_stop') return { done: true }
      if (type !== 'error') return undefined
      const data = attempt.data
      // The error type and message reach both the source's classifier and
      // the host's failure record, so neither may carry this send's secrets.
      const scrubber = scrubberFor(data)
      const error = isRecord(parsed.error) ? parsed.error : {}
      // A documented Anthropic error type is kept as is, so a rate limit is
      // classified the same even after this send's redactor was disposed
      // (its send ended, its session was forgotten, or it was evicted). Any
      // other value is scrubbed like the message; once the redactor is
      // disposed it is replaced by a generic message.
      const errorType =
        typeof error.type !== 'string'
          ? undefined
          : ANTHROPIC_ERROR_TYPES.has(error.type)
            ? error.type
            : scrubber.redactText(error.type)
      const message =
        typeof error.message === 'string'
          ? scrubber.redactText(error.message)
          : undefined
      if (data?.dispatch === 'http-relay' && relayUpstream.get(data) === false)
        return undefined
      const limit = data
        ? source.limitFromStreamError?.({
            ...contextOf(attempt, data),
            errorType,
            message,
          })
        : undefined
      const verdict: EventVerdict<Q> = {
        error: [errorType ?? 'error', message]
          .filter(Boolean)
          .join(': ')
          .slice(0, MAX_STREAM_ERROR_MESSAGE),
        ...(limit ? { limit } : {}),
      }
      if (data && verdict.error) safeSummaries.set(data, verdict.error)
      return verdict
    },
    limitFromError(error, attempt) {
      const data = attempt.data
      // A local refusal is about the request, not the account: answering it
      // with a limit would move the same broken request to another account.
      if (!data || localRefusals.has(data)) return undefined
      // The host's error text is never re-scrubbed here: the send's
      // credentials may already be retired. The source gets the status, a
      // documented error type, and safe text recorded while the send was live.
      const safe = safeHostError(error, safeSummaries.get(data))
      // This hook has copied the failed send's classification into safe data.
      // It no longer needs the redactor's credentials to classify the error.
      release(data)
      if (
        dispatchOf(data) === 'http-relay' &&
        relayUpstream.get(data) === false
      )
        return undefined
      return source.limitFromHostError?.(safe, contextOf(attempt, data))
    },
    async onAttemptEnd(attempt, outcome) {
      const data = attempt.data
      if (!data) return
      hostAttempts.delete(data)
      if (outcome.error || outcome.status !== 429)
        quotaStopMessages.delete(data)
      const billingSend = billingSends.get(data)
      billingSends.delete(data)
      if (
        billingSend &&
        !billingSend.received &&
        !localRefusals.has(data) &&
        dispatchOf(data) === 'direct'
      )
        reportAnthropicBillingFailure(billingSend.input)
      pending.delete(data)
      // A send that never reached `rewriteResponse` (the host's fetch threw,
      // say) still writes its request dump with a fixed error label, as
      // OpenCode 1 does. Sends that already dumped in `rewriteResponse` have
      // no pending entry here, so each physical attempt writes at most once.
      const pendingDump = dumpContexts.get(data)
      if (pendingDump) {
        dropDumpContext(data)
        try {
          const enabled = await dumpEnabledForSend()
          if (enabled) {
            try {
              setDumpEnabledCore(true)
            } catch {}
            try {
              if (pendingDump.dispatch === 'http-relay') {
                // A relay send that never produced a response writes no relay
                // dump, as on OpenCode 1: the host retries direct, and that
                // direct attempt writes its own dump.
                if (outcome.status !== undefined) {
                  await dumpRelayRequest({
                    affinity: pendingDump.affinity,
                    transport: 'http',
                    protocol: 1,
                    mode: 'full_sync',
                    status: outcome.status,
                    bodyText: pendingDump.bodyText,
                    payload: pendingDump.envelope ?? {},
                    relayBytes: pendingDump.relayBytes ?? 0,
                    ...(pendingDump.tag ? { tag: pendingDump.tag } : {}),
                  })
                }
              } else {
                await dumpDirectRequest({
                  affinity: pendingDump.affinity,
                  route: pendingDump.route,
                  status: outcome.status,
                  error:
                    outcome.status === undefined
                      ? DUMP_PHYSICAL_SEND_FAILED
                      : undefined,
                  bodyText: pendingDump.bodyText,
                  url: pendingDump.url,
                  method: pendingDump.method,
                  headers: pendingDump.headers,
                  ...(pendingDump.tag ? { tag: pendingDump.tag } : {}),
                })
              }
            } catch {}
          }
        } catch {}
      }
      // A send that completed, was cancelled or can no longer be observed
      // has no error left to read. An error status or a failed stream keeps
      // its redactor: the host still reads that error after this call, and
      // the retry hook judges it.
      const reason = outcome.error?.reason
      if (
        reason === 'cancelled' ||
        reason === 'abandoned' ||
        (reason === undefined &&
          (outcome.status === undefined || outcome.status < 400))
      )
        release(data)
      const check = localRefusals.get(data)
      const { status, ...rest } = outcome
      const ended = source.onAttemptEnd?.(contextOf(attempt, data), {
        ...rest,
        ...(status !== undefined &&
        (dispatchOf(data) !== 'http-relay' || relayUpstream.get(data) === true)
          ? { status }
          : {}),
        ...(check !== undefined ? { localRefusal: { check } } : {}),
      })
      if ((await settleWithin(ended, endTimeoutMs)) === 'timed-out') {
        log?.warn('the account source did not finish recording a send', {
          timeoutMs: endTimeoutMs,
        })
      }
    },
  }

  return {
    preservesCacheTemplate: (data) => roundCacheSends.has(data),
    adapter,
    discardQuotaStopMessage(data) {
      quotaStopMessages.delete(data)
    },
    bindHostAttempt(attempt, hostAttempt) {
      if (
        !attempt.data ||
        disposed ||
        !Number.isInteger(hostAttempt) ||
        hostAttempt < 1
      )
        return
      hostAttempts.set(attempt.data, {
        sessionID: attempt.sessionID,
        attempt: hostAttempt,
      })
      while (hostAttempts.size > maxPending) {
        const first = hostAttempts.keys().next().value
        if (first) hostAttempts.delete(first)
      }
    },
    discardUnsentBilling: (data) => {
      billingSends.delete(data)
    },
    acceptedResponse: (response) => finalAcceptances.get(response),
    dispose() {
      disposed = true
      for (const [sessionID, operations] of inProgress) {
        for (const operation of operations) operation.revoked = true
        source.forgetSession?.(sessionID)
      }
      inProgress.clear()
      pending.clear()
      hostAttempts.clear()
      quotaStopMessages = new WeakMap()
      retryAttempts.clear()
      latestPrimary.clear()
      dumpContexts.clear()
      for (const data of [...owned.keys()]) release(data)
    },
    forgetSession(sessionID) {
      latestPrimary.delete(sessionID)
      for (const [data, send] of hostAttempts)
        if (send.sessionID === sessionID) {
          hostAttempts.delete(data)
          quotaStopMessages.delete(data)
        }
      messageThreads.forget(sessionID)
      for (const operation of inProgress.get(sessionID) ?? []) {
        operation.revoked = true
      }
      inProgress.delete(sessionID)
      for (const [key, attempt] of retryAttempts) {
        if (attempt.sessionID === sessionID) retryAttempts.delete(key)
      }
      for (const [data, send] of pending) {
        if (send.sessionID === sessionID) pending.delete(data)
      }
      for (const [data, entry] of [...owned]) {
        if (entry.sessionID === sessionID) {
          quotaStopMessages.delete(data)
          release(data)
        }
      }
      for (const [data, dump] of [...dumpContexts]) {
        if (dump.affinity === sessionID) dumpContexts.delete(data)
      }
      source.forgetSession?.(sessionID)
    },
    get pendingSendCount() {
      return pending.size
    },
    get heldCredentialCount() {
      let count = 0
      for (const send of pending.values()) if (send.oauth) count++
      return count
    },
    get heldRedactorCount() {
      return owned.size
    },
    get operationsInProgress() {
      let count = 0
      for (const operations of inProgress.values()) count += operations.size
      return count
    },
  }
}
