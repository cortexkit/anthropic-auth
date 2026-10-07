// The Anthropic half of the OpenCode 2 hooks recipe: what
// `@cortexkit/common-auth/opencode2` leaves to its caller, for requests the
// host sends itself through its own Anthropic HTTP driver.
//
// The installer in common-auth edits those requests at fixed points and asks
// this adapter, in order, for one physical send (an "attempt"):
//
// - `chooseAccount`: which account the request goes to;
// - `accountHeaders`: that account's credential headers, plus the attempt's
//   `data`, which the installer hands back on every later call for the same
//   send;
// - `rewriteRequest`: the Claude Code wire shape for an OAuth send (URL,
//   persona headers, body rewrite and signature), or the plain API shape for
//   an API-key send;
// - `quotaFromHeaders`, `limitFromResponse`, `inspectEvent`, `limitFromError`:
//   what the response says about the account;
// - `rewriteResponse`: undoing the OAuth tool-name prefix in the response;
// - `onAttemptEnd`: how the send ended.
//
// Everything about accounts and policy belongs to an injected source owned
// by Core (`NativeAnthropicSource`): which account to use, the credential it
// authorizes for one send, the body rewrite options (billing, effort, cache,
// safety, diagnostics), and how a response or error is classified. The
// adapter never reads an account pool, never falls back to the host's own
// credential, and never guesses an account or a plan from the wire. What the
// source says about one send (its route and its opaque provenance, such as a
// vault receipt) stays attached to that send and is handed back unchanged.
//
// The adapter never sends anything itself: no retry, no second send from the
// response side, no relay. Retrying on another account is the installer's
// retry hook, which acts only on the limit signals the source returns here.

import {
  applyCustomHeaders,
  assertNotCustodyTombstone,
  type ClaudeCodeIdentity,
  mergeAnthropicBetas,
  remapRequestBodyModel,
  stripEmptyTrailingAssistantMessages,
  TrailingAssistantHistoryError,
} from '@cortexkit/anthropic-auth-core'
import type {
  AccountHeadersResult,
  AccountRequest,
  Attempt,
  AttemptOutcome,
  ChooseAccountInput,
  EventVerdict,
  HeaderEdits,
  HostError,
  LimitSignal,
  OpenCode2AuthAdapter,
  RequestScope,
  Transport,
} from '@cortexkit/common-auth/opencode2'
import { BILLING_LINEAGE_REQUEST_HEADER } from '../billing-lineage'
import {
  EFFORT_PLAN_REQUEST_HEADER,
  EffortMarkerCorrelationError,
} from '../effort-history'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
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

/**
 * Fixed text of the refusal raised when the source has no credential for a
 * send. It names no account, route or vault, because the host shows and logs
 * it.
 */
export const NO_ACCOUNT_REFUSAL =
  'request refused: no account with a usable credential'

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

/** Which kind of credential one send goes out with. */
export type NativeAnthropicRoute = 'oauth' | 'api'

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
    }

/**
 * The per-send value the installer carries as `Attempt.data`. It holds no
 * credential and no request body.
 */
export interface NativeAnthropicAttemptData<P> {
  readonly route: NativeAnthropicRoute
  readonly provenance: P
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
}

/** Non-nullable options accepted by rewriteRequestBody. */
type RewriteBodyOptions = NonNullable<Parameters<typeof rewriteRequestBody>[1]>

/**
 * The body rewrite options a source supplies for an OAuth send: billing
 * lineage, effort plan, cache, fast mode, safety and diagnostics inputs. Two
 * options are left out because the adapter sets them: the Claude Code
 * identity, which the source returns with the credential, and the session id,
 * which is the host's own session id for the request.
 */
export type NativeAnthropicBodyOptions = Omit<
  RewriteBodyOptions,
  'identity' | 'sessionId'
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
  /** Picks the account for one request; `undefined` refuses it. */
  readonly chooseAccount: (
    input: ChooseAccountInput,
  ) => Promise<string | undefined> | string | undefined
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
}

export interface NativeAnthropicAdapter<Q, P> {
  readonly adapter: OpenCode2AuthAdapter<Q, NativeAnthropicAttemptData<P>>
  /**
   * Drops the session's authorized sends that have not been rewritten yet,
   * revokes its choices, authorizations and rewrites still in progress so
   * none of them can return, and calls the source's `forgetSession`.
   */
  forgetSession(sessionID: string): void
  /** Number of sends authorized and not yet rewritten or ended. */
  readonly pendingSendCount: number
  /** Number of OAuth access tokens held for sends not yet rewritten. */
  readonly heldCredentialCount: number
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

/**
 * The request was refused with a local 400 because it can never succeed as
 * written: its history ends on a meaningful assistant turn, or an effort
 * marker in it cannot be matched to the session's effort plan. Nothing was
 * sent, and another account cannot help, so the adapter never reports it as
 * an account limit. The message and `check` describe only the shape of the
 * problem, never conversation content.
 */
export class NativeAnthropicLocalRefusal extends Error {
  readonly kind = 'local-invalid-request'
  readonly status = 400
  readonly check: string

  constructor(
    cause: TrailingAssistantHistoryError | EffortMarkerCorrelationError,
  ) {
    super(cause.message, { cause })
    this.name = 'NativeAnthropicLocalRefusal'
    this.check = cause.check
  }
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
    error instanceof EffortMarkerCorrelationError
    ? new NativeAnthropicLocalRefusal(error)
    : undefined
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

/** The host's betas for an API send, without the OAuth-only ones. */
function apiBetas(value: string) {
  const kept = value
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta && !OAUTH_ONLY_BETAS.has(beta))
  return mergeAnthropicBetas(null, kept)
}

/**
 * Applies the API route's body rules. There is no Claude Code persona, tool
 * prefix or signature; only the local history check, the plugin's
 * server-side fallback opt-in and stored fallback markers removed (the same
 * rule the OAuth rewrite applies when fallback is off), and the configured
 * model remap. Returns the body text unchanged when nothing changed or it is
 * not a JSON object.
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
    const operation = { revoked: false }
    let operations = inProgress.get(scope.sessionID)
    if (!operations) {
      operations = new Set()
      inProgress.set(scope.sessionID, operations)
    }
    operations.add(operation)
    const ensureLive = () => {
      if (operation.revoked) {
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
  })

  const accountHeaders = (
    request: AccountRequest,
  ): Promise<AccountHeadersResult<Data>> =>
    tracked(request, async (ensureLive) => {
      const { accountId, ...scope } = request
      const auth = await source.authorizeAccount(scope, accountId)
      ensureLive()
      return headersFor(scope, auth)
    })

  const headersFor = (
    scope: RequestScope,
    auth: NativeAnthropicAuthorization<P> | undefined,
  ): AccountHeadersResult<Data> => {
    if (!auth) throw refuse(scope)
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
      })
      remember(data, {
        sessionID: scope.sessionID,
        oauth: {
          accessToken: auth.accessToken,
          ...(auth.identity ? { identity: auth.identity } : {}),
        },
      })
      const extra = lowerCaseEdits(auth.headers)
      for (const name of CREDENTIAL_HEADERS) delete extra[name]
      return {
        headers: {
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
    })
    remember(data, {
      sessionID: scope.sessionID,
      ...(auth.baseURL ? { baseURL: auth.baseURL } : {}),
    })
    return { headers, attempt: data }
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
    const send = data ? pending.get(data) : undefined
    // One authorization serves one send: the entry is gone after this call,
    // so a credential never outlives the request it was issued for.
    if (data) pending.delete(data)
    if (!data || !send || (data.route === 'oauth' && !send.oauth)) {
      throw refuse(input)
    }

    const headers = new Headers(request.headers)
    const correlation = takeInternalHeaders(headers)
    let body = request.body === null ? undefined : await request.text()
    // A session forgotten while the body was read never reaches the source's
    // options or the body rewrite.
    ensureLive()
    const messages = body !== undefined && isMessagesUrl(request.url)

    try {
      if (data.route === 'oauth' && send.oauth) {
        const { accessToken, identity } = send.oauth
        let finalBody: Record<string, unknown> | null = null
        if (body !== undefined && messages) {
          const context: NativeAnthropicRequestContext<P> = {
            ...contextOf(attempt, data),
            route: 'oauth',
            correlation,
          }
          const options = (await source.requestOptions?.(context)) ?? {}
          // Recheck session revocation after awaiting policy options. A
          // cleared session must not enter body rewriting or signing.
          ensureLive()
          body = await rewriteRequestBody(body, {
            ...options,
            ...(identity ? { identity } : {}),
            sessionId: input.sessionID,
          })
          const parsed = parseJson(body)
          finalBody = isRecord(parsed) ? parsed : null
        }
        setOAuthHeaders(headers, accessToken, {
          body: finalBody,
          ...(identity ? { identity } : {}),
        })
      } else {
        if (body !== undefined && messages) body = rewriteApiBody(body)
        headers.delete('authorization')
        headers.delete('x-api-key')
        if (body !== undefined && messages && !headers.has('content-type')) {
          headers.set('content-type', 'application/json')
        }
        const betas = headers.get('anthropic-beta')
        if (betas !== null) {
          const kept = apiBetas(betas)
          if (kept) headers.set('anthropic-beta', kept)
          else headers.delete('anthropic-beta')
        }
        applyCustomHeaders(headers)
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
    if (body !== undefined) headers.delete('content-length')
    // Recheck session revocation after rewriting and signing before the
    // authenticated request can be returned to the caller.
    ensureLive()
    const url =
      rewriteUrl(
        request.url,
        send.baseURL !== undefined ? { baseURL: send.baseURL } : {},
      ).url?.toString() ?? request.url
    return new Request(url, {
      method: request.method,
      headers,
      redirect: request.redirect,
      signal: request.signal,
      ...(body !== undefined ? { body } : {}),
    })
  }

  const adapter: OpenCode2AuthAdapter<Q, Data> = {
    providerID: ANTHROPIC_PROVIDER_ID,
    chooseAccount: (input) =>
      tracked(input, async () => source.chooseAccount(input)),
    accountHeaders,
    rewriteRequest,
    rewriteResponse({ response, attempt }) {
      const data = attempt.data
      // Only the OAuth route prefixes tool names, so only its responses are
      // mapped back. An API response reaches the host byte for byte.
      if (data?.route !== 'oauth' || !response.body) return undefined
      const context = { ...contextOf(attempt, data), status: response.status }
      const options = source.responseOptions?.(context) ?? {}
      const json = (response.headers.get('content-type') ?? '').includes(
        'application/json',
      )
      return createStrippedStream(response, {
        ...options,
        laneStartOAuthServed: true,
        ...(json ? { responseMode: 'json' as const } : {}),
      })
    },
    quotaFromHeaders(headers, status, attempt) {
      const data = attempt.data
      if (!data) return undefined
      return source.quotaFromHeaders?.(headers, {
        ...contextOf(attempt, data),
        status,
      })
    },
    async limitFromResponse({ status, headers, body, attempt }) {
      const data = attempt.data
      if (!data || !source.limitFromResponse) return undefined
      return source.limitFromResponse({
        ...contextOf(attempt, data),
        status,
        headers,
        body,
      })
    },
    inspectEvent({ data: payload, event, attempt }) {
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
      const error = isRecord(parsed.error) ? parsed.error : {}
      const errorType = typeof error.type === 'string' ? error.type : undefined
      const message =
        typeof error.message === 'string' ? error.message : undefined
      const data = attempt.data
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
      return verdict
    },
    limitFromError(error, attempt) {
      const data = attempt.data
      // A local refusal is about the request, not the account: answering it
      // with a limit would move the same broken request to another account.
      if (!data || localRefusals.has(data)) return undefined
      return source.limitFromHostError?.(error, contextOf(attempt, data))
    },
    async onAttemptEnd(attempt, outcome) {
      const data = attempt.data
      if (!data) return
      pending.delete(data)
      const check = localRefusals.get(data)
      const ended = source.onAttemptEnd?.(contextOf(attempt, data), {
        ...outcome,
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
    forgetSession(sessionID) {
      for (const operation of inProgress.get(sessionID) ?? []) {
        operation.revoked = true
      }
      inProgress.delete(sessionID)
      for (const [data, send] of pending) {
        if (send.sessionID === sessionID) pending.delete(data)
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
    get operationsInProgress() {
      let count = 0
      for (const operations of inProgress.values()) count += operations.size
      return count
    },
  }
}
