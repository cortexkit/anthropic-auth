// OpenCode sends the requests; this adapter supplies account credentials,
// Claude Code request transforms and response classification to common-auth's
// transport hooks. The injected source uses Core's account and policy services.
// Each response keeps the credential version and account of its own request,
// including HTTP relay responses. This adapter never sends a retry itself.

import { createHash } from 'node:crypto'
import {
  AnthropicOAuthOriginError,
  applyCustomHeaders,
  assertNotCustodyTombstone,
  type ClaudeCodeIdentity,
  classifyGzipRejection,
  createProviderErrorRedactor,
  createProviderErrorResponseScope,
  type DumpHandle,
  type DumpTag,
  decideRequestGzip,
  dumpDirectRequest,
  dumpRelayRequest,
  dumpResponseArtifact,
  encodeGzipRequestBody,
  getAccountStoragePath,
  getRequestGzipLatch,
  getRequestGzipLatchPath,
  isDumpEnabled as isDumpEnabledCore,
  mergeAnthropicBetas,
  type ProviderErrorRedactor,
  type ProviderErrorResponseScope,
  type ProviderResponseMode,
  type RequestGzipLatch,
  remapModelId,
  remapRequestBodyModel,
  requestSignal,
  setDumpEnabled as setDumpEnabledCore,
  stateRefusalCause,
  stateRefusalPublicMessage,
  stripEmptyTrailingAssistantMessages,
  TrailingAssistantHistoryError,
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
import { BILLING_LINEAGE_REQUEST_HEADER } from '../billing-lineage'
import {
  EFFORT_PLAN_REQUEST_HEADER,
  EffortMarkerCorrelationError,
} from '../effort-history'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
import { requireOAuthDestination } from '../oauth-destination'
import { isAuxiliaryAgent } from '../request-class'
import {
  applyServerSideFallbackToBody,
  SERVER_SIDE_FALLBACK_BETA,
} from '../server-fallback'
import {
  createStrippedStream,
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
      /** The Claude Code identity of the account, when the source knows it. */
      readonly identity?: ClaudeCodeIdentity
      /** Additional OAuth request headers; authorization and x-api-key edits are ignored so they cannot replace the authorized bearer. */
      readonly headers?: HeaderEdits
      readonly provenance: P
      readonly dispatch?: NativeAnthropicDispatch
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
export interface NativeAnthropicAttemptContext<P> extends AccountRequest {
  readonly attemptId: string
  readonly transport: Transport | undefined
  readonly route: NativeAnthropicRoute
  readonly provenance: P
  readonly dispatch: 'direct' | 'http-relay'
}

/** Non-nullable options accepted by rewriteRequestBody. */
type RewriteBodyOptions = NonNullable<Parameters<typeof rewriteRequestBody>[1]>

/**
 * The body rewrite options a source supplies for an OAuth send: billing
 * lineage, effort plan, cache, fast mode, safety and diagnostics inputs. Two
 * options are left out because the adapter sets them: the Claude Code
 * identity, which the source returns with the credential, and the session id,
 * which is the host's own session id for the request. The tool-name callback
 * is private to the adapter so response names stay bound to that send.
 */
export type NativeAnthropicBodyOptions = Omit<
  RewriteBodyOptions,
  'identity' | 'sessionId' | 'onToolNameMap'
>

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
    scope: RequestScope,
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
  /** Observe the admitted OAuth wire body before any relay envelope is added. */
  readonly onRequestPrepared?: (
    input: NativeAnthropicAttemptContext<P> & {
      readonly url: string
      readonly bodyText: string
    },
  ) => Promise<void> | void
  /** Response observers for an OAuth response. */
  readonly responseOptions?: (
    input: NativeAnthropicResponseContext<P>,
  ) => NativeAnthropicResponseOptions | undefined
  /** Quota carried by the upstream response headers, read once per response. */
  readonly quotaFromHeaders?: (
    headers: Headers,
    input: NativeAnthropicResponseContext<P>,
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
}

export interface NativeAnthropicAdapterLogger {
  warn(message: string, data?: Record<string, unknown>): void
}

export interface NativeAnthropicAdapterDeps<Q, P> {
  readonly source: NativeAnthropicSource<Q, P>
  readonly log?: NativeAnthropicAdapterLogger
  /** Maximum number of authorized sends waiting for their request rewrite. */
  readonly maxPendingSends?: number
  /**
   * How long `onAttemptEnd` waits for the source to record how a send
   * ended; the source's work is not cancelled.
   */
  readonly attemptEndTimeoutMs?: number
  /**
   * Remembers a rejected gzipped body. Defaults to the latch next to the
   * OpenCode account storage file.
   */
  readonly requestGzipLatch?: RequestGzipLatch
}

export interface NativeAnthropicAdapter<Q, P> {
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
    readonly identity?: ClaudeCodeIdentity
  }
  readonly baseURL?: string
  readonly dispatch?: NativeAnthropicDispatch
  readonly apiHeaders?: HeaderEdits
  readonly oauthHeaders?: HeaderEdits
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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

/**
 * Betas that this plugin itself adds to its OAuth sends: the OAuth beta, the
 * Claude Code persona beta, and the server-side fallback opt-in that goes
 * with the `fallbacks` body field the API route also removes. They are
 * stripped from API-key sends so the plugin's OAuth persona and fallback
 * handoff never reach an API key or proxy route. Every other beta value the
 * host requested is passed on unchanged.
 */
const OAUTH_ONLY_BETAS = new Set([
  'oauth-2025-04-20',
  'claude-code-20250219',
  SERVER_SIDE_FALLBACK_BETA,
])

/** Remove plugin-added OAuth authentication, Claude Code compatibility and server
 * safety-fallback betas from paid API/proxy sends; preserve unrelated host betas. */
function apiBetas(value: string) {
  const kept = value
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta && !OAUTH_ONLY_BETAS.has(beta))
  return mergeAnthropicBetas(null, kept)
}

/**
 * Validate history, remove OAuth-only fallback fields and internal boundary
 * markers, and apply the configured model alias for paid API/proxy requests.
 * No Claude Code identity, tool-name prefix or body signature is added.
 * Preserve the original text when no field changes or the body is not an object.
 */
function rewriteApiBody(body: string) {
  const parsed = parseJson(body)
  if (!isRecord(parsed)) return body
  const removed = stripEmptyTrailingAssistantMessages(parsed.messages)
  const hadFallbacks = Object.hasOwn(parsed, 'fallbacks')
  const { droppedMarkers } = applyServerSideFallbackToBody(parsed, false)
  const fallbacksRemoved = hadFallbacks && !Object.hasOwn(parsed, 'fallbacks')
  const remapped = remapRequestBodyModel(parsed)
  return removed > 0 || droppedMarkers > 0 || fallbacksRemoved || remapped
    ? JSON.stringify(parsed)
    : body
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
  const requestGzipLatch =
    deps.requestGzipLatch ??
    getRequestGzipLatch(getRequestGzipLatchPath(getAccountStoragePath()))
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
  ) => {
    const secrets = sendSecrets(send, physical)
    const scope = createProviderErrorResponseScope(secrets, mode)
    modes.set(data, mode)
    owned.set(data, {
      sessionID: send.sessionID,
      redactor: createProviderErrorRedactor(secrets),
      scope,
    })
    void scope.settled.then(() => release(data))
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
  const rewrittenFailure = (data: Data | undefined, response: Response) => {
    if (data && !response.ok) rewrittenFailures.set(response.headers, data)
    return response
  }

  const fromUpstream = (headers: Headers, data: Data) => {
    if (data.dispatch !== 'http-relay') return true
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
    provenance: data.provenance,
    dispatch: data.dispatch,
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
    if (auth.dispatch?.kind === 'websocket-relay')
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
          ...(auth.identity ? { identity: auth.identity } : {}),
        },
        dispatch: auth.dispatch,
        oauthHeaders: auth.headers,
      })
      const extra = lowerCaseEdits(auth.headers)
      for (const name of CREDENTIAL_HEADERS) delete extra[name]
      // rewriteRequest finalizes betas for the outgoing body. Omit that header
      // here so the installer's later generic edits cannot overwrite it.
      delete extra['anthropic-beta']
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

    const headers = new Headers(request.headers)
    applyCustomHeaders(headers)
    const correlation = takeInternalHeaders(headers)
    let body = request.body === null ? undefined : await request.text()
    // A session forgotten while the body was read never reaches the source's
    // options or the body rewrite.
    ensureLive()
    const messages = body !== undefined && isMessagesUrl(request.url)
    const url =
      rewriteUrl(
        request.url,
        send.baseURL !== undefined ? { baseURL: send.baseURL } : {},
      ).url?.toString() ?? request.url

    try {
      if (data.route === 'oauth' && send.oauth) {
        // The request URL comes from provider configuration, which a project
        // file in an opened repository can set. An OAuth token goes only to
        // Anthropic: refuse anything else before the request is built.
        requireOAuthDestination(url)
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
          const options = (await source.requestOptions?.(context)) ?? {}
          // Recheck session revocation after awaiting policy options. A
          // cleared session must not enter body rewriting or signing.
          ensureLive()
          // A CacheKeep prewarm carries the body this session already sent,
          // re-signed for the prewarm. Rewriting it again would prefix the
          // tool names twice and add the system blocks again, so the prewarm
          // would miss the session's cache instead of reading it.
          if (attempt.agent !== 'cachekeep')
            body = await rewriteRequestBody(body, {
              ...options,
              ...(identity ? { identity } : {}),
              sessionId: input.sessionID,
              onToolNameMap: (map) => responseToolNameMaps.set(data, map),
            })
          const parsed = parseJson(body)
          finalBody = isRecord(parsed) ? parsed : null
        }
        setOAuthHeaders(headers, accessToken, {
          body: finalBody,
          ...(identity ? { identity } : {}),
          requestClass: isAuxiliaryAgent(attempt.agent) ? 'auxiliary' : 'main',
        })
      } else {
        if (body !== undefined && messages) body = rewriteApiBody(body)
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
          const kept = apiBetas(betas)
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
    holdRedactor(
      data,
      send,
      isRecord(finalPayload) && finalPayload.stream === true
        ? 'event-stream'
        : 'http',
      headers,
    )
    if (data.route === 'oauth' && messages && body !== undefined) {
      await source.onRequestPrepared?.({
        ...contextOf(attempt, data),
        url,
        bodyText: body,
      })
      ensureLive()
    }
    if (send.dispatch?.kind === 'http-relay') {
      // Each HTTP relay attempt sends the complete upstream body, not a patch.
      // A host retry authorizes credentials again and builds a new envelope;
      // it must not reuse this attempt's authorization.
      const upstreamBody = body ?? ''
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
          relayUrl: send.dispatch.url,
          envelope: envelope as Record<string, unknown>,
          relayBytes: envelopeText.length,
          ...(tag ? { tag } : {}),
        })
      } else {
        dropDumpContext(data)
      }
      return new Request(send.dispatch.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-relay-token': send.dispatch.token,
        },
        redirect: 'error',
        signal: request.signal,
        body: JSON.stringify(envelope),
      })
    }
    let wireBody: string | Uint8Array | undefined = body
    if (data.route === 'oauth' && messages && body !== undefined) {
      const decision = await decideRequestGzip({
        url,
        body,
        latch: requestGzipLatch,
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
    return new Request(url, {
      method: request.method,
      headers,
      // An OAuth bearer must not follow a redirect to another host.
      redirect: data.route === 'oauth' ? 'error' : request.redirect,
      signal: request.signal,
      ...(wireBody !== undefined ? { body: wireBody } : {}),
    })
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
      if (data && !fromUpstream(response.headers, data)) {
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
        return scrubResponse(data, response)
      }
      if (data && gzippedSends.has(data)) {
        gzippedSends.delete(data)
        // Classify before the body is scrubbed or read; a clone is read.
        void classifyGzipRejection(response).then(
          (kind) => {
            if (!kind) return
            requestGzipLatch.latchProcess()
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
                status: response.status,
                bodyText: pendingDump.bodyText,
                payload: pendingDump.envelope ?? {},
                relayBytes: pendingDump.relayBytes ?? 0,
                ...(pendingDump.tag ? { tag: pendingDump.tag } : {}),
              })
            } else {
              dumpHandle = await dumpDirectRequest({
                affinity: pendingDump.affinity,
                route: pendingDump.route,
                status: response.status,
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
      // Remove this send's secrets from provider errors before any other
      // reader; successful bytes pass through unchanged.
      const safe = scrubResponse(data, response)
      // Only the OAuth route prefixes tool names, so only its responses are
      // mapped back. An API response reaches the host byte for byte.
      if (data?.route !== 'oauth' || !safe.body) {
        return rewrittenFailure(data, safe)
      }
      const context = { ...contextOf(attempt, data), status: response.status }
      const options = source.responseOptions?.(context) ?? {}
      const json = (response.headers.get('content-type') ?? '').includes(
        'application/json',
      )
      const baseStreamOptions = {
        ...options,
        toolNameMap: data ? responseToolNameMaps.get(data) : undefined,
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
      if (!source.limitFromResponse) return undefined
      // A failed response this adapter rewrote is read through its own
      // response scope, which scrubbed it while the credentials were live.
      // Once that read reaches the end the credentials are gone, so its text
      // is passed on as it is. Anything else is scrubbed here.
      const rewritten = rewrittenFailures.get(headers) === data
      const scrubber = scrubberFor(data)
      return source.limitFromResponse({
        ...contextOf(attempt, data),
        status,
        headers,
        body: async () =>
          rewritten ? await body() : scrubber.redactText(await body()),
      })
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
      if (data.dispatch === 'http-relay' && relayUpstream.get(data) === false)
        return undefined
      return source.limitFromHostError?.(safe, contextOf(attempt, data))
    },
    async onAttemptEnd(attempt, outcome) {
      const data = attempt.data
      if (!data) return
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
        (data.dispatch !== 'http-relay' || relayUpstream.get(data) === true)
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
    adapter,
    dispose() {
      disposed = true
      for (const [sessionID, operations] of inProgress) {
        for (const operation of operations) operation.revoked = true
        source.forgetSession?.(sessionID)
      }
      inProgress.clear()
      pending.clear()
      retryAttempts.clear()
      dumpContexts.clear()
      for (const data of [...owned.keys()]) release(data)
    },
    forgetSession(sessionID) {
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
        if (entry.sessionID === sessionID) release(data)
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
