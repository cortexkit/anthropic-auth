import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { applyEdits, modify } from 'jsonc-parser'
import {
  type AnthropicBillingReport,
  type AnthropicBillingRequest,
  observeAnthropicBillingResponse,
  reportAnthropicBillingFailure,
} from './billing.ts'
import { signRequestBody } from './cch.ts'
import { protectFallbackCreditResponse } from './fallback-credit.ts'
import {
  joinRefusalFallbackStream,
  type RefusalFallbackStreamRefusal,
  type RefusalFallbackStreamRetry,
} from './refusal-fallback-stream.ts'
import {
  foldRefusalFallbackEffort,
  selectRefusalFallbackTarget,
} from './refusal-fallback-targets.ts'
import { classifyGzipRejection } from './request-gzip.ts'

export type RefusalFallbackBinding = Readonly<{
  accountId: string
  /** Stable across OAuth refresh, but changes on credential replacement. */
  credentialId: string
  /** Resolved endpoint, including a configured gateway and path. */
  url: string
}>

export type RefusalFallbackExtraSendAuthority = (request: {
  model: string
  origin: RefusalFallbackBinding
  wait: false
  signal: AbortSignal
}) =>
  | RefusalFallbackExtraSendDecision
  | Promise<RefusalFallbackExtraSendDecision>

export type RefusalFallbackExtraSendDecision =
  | { kind: 'denied' | 'wait' }
  | ({ kind: 'authorized'; accessToken: string } & RefusalFallbackBinding)

export type RefusalFallbackPhysicalAttempt = Readonly<{
  model: string
  ordinal: number
  refusalRetry: boolean
  paysCacheWrite: boolean
  folded: boolean
}>

export type RefusalFallbackDispatchOptions = {
  /** The host-requested model, even if its wire spelling differs. */
  sourceModel: string
  origin: RefusalFallbackBinding & {
    /** Headers sent upstream, excluding runtime-generated framing like Content-Length. */
    headers: Headers
    bodyText: string
    /**
     * The source model's full request body as built before message-thread
     * handling (all messages, not a thread continuation). A refused continue
     * can't be retried from its own body, so it needs this one.
     */
    fullBodyText?: string
  }
  /** True only if no newer primary was sent and the mode, model and binding still match. */
  isFresh: () => boolean
  /**
   * Get a fresh OAuth token for the target model and apply the user's quota
   * protections (minimum remaining quota per account and per model), without
   * waiting for a reset.
   */
  authorize: RefusalFallbackExtraSendAuthority
  /** Start one direct or gateway send immediately. No redirect, replay or recovery. */
  send: (request: {
    url: string
    headers: Headers
    /** Compressed bytes or uncompressed request text. Pass this to the transport untouched. */
    body: Uint8Array | string
    /** Final signed JSON. For the request dump sink, not reusable state. */
    bodyText: string
    signal: AbortSignal
  }) => Promise<Response>
  /** Report context of the original request. Core sets the sent model and identity. */
  billing: Omit<
    AnthropicBillingRequest,
    'model' | 'onReport' | 'credentialId' | 'accountId'
  >
  onBillingReport?: (
    report: AnthropicBillingReport,
    attempt: RefusalFallbackPhysicalAttempt,
  ) => void
  /** Called once when the retry supplies its first host-visible content. */
  onRetryCommitted?: (info: {
    model: string
    attempt: RefusalFallbackPhysicalAttempt
  }) => void
  /** The relay already guarded and billed the origin; this takes the token that credits the retry for the refused work. */
  protectedOrigin?: { takeRefusalCredit: () => string | undefined }
  /** Observe guarded bytes without reading ahead, before billing the response. A relay has already billed its protected origin. */
  observePhysicalResponse?: (
    response: Response,
    attempt: RefusalFallbackPhysicalAttempt,
    /** For retries only: signed, full, pre-thread, with no credit or prefill. */
    reusableBodyText?: string,
  ) => Response
  signal?: AbortSignal
  maxPendingBytes?: number
}

type Body = Record<string, unknown>
const gzipAsync = promisify(gzip)

function record(value: unknown): Body | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Body)
    : undefined
}

function parseBody(text: string) {
  try {
    return record(JSON.parse(text))
  } catch {
    return undefined
  }
}

function replace(text: string, path: (string | number)[], value: unknown) {
  return applyEdits(text, modify(text, path, value, {}))
}

function eventStream(response: Response) {
  const contentType = response.headers.get('content-type') ?? ''
  // The Messages request asks for SSE, but an HTTP error generally has JSON.
  return (
    /text\/event-stream/i.test(contentType) ||
    (response.ok && !/\bjson\b/i.test(contentType))
  )
}

async function wrongModel(response: Response, requestHeaders: Headers) {
  if (response.status !== 400) return false
  if (
    requestHeaders.get('content-encoding')?.toLowerCase() === 'gzip' &&
    (await classifyGzipRejection(response))
  )
    return false
  const payload = record(await response.json())
  const message = record(payload?.error)?.message
  return (
    typeof message === 'string' &&
    /^fallback_credit_token: is not valid for model(?: claude-[\w.-]+)?\.?$/.test(
      message,
    )
  )
}

/**
 * Wrap the first physical response of an eligible client-mode primary. Call
 * before reading or observing its body. The supplied sender also returns a raw
 * response so that billing, observers and the join only see guarded bytes.
 * Round and routed responses don't call this wrapper: they join without retry.
 * `onRetryCommitted` identifies the serving attempt, not just a successful
 * HTTP response: stale retries and failures before content never notify it.
 */
export function dispatchRefusalFallback(
  response: Response,
  options: RefusalFallbackDispatchOptions,
): Response {
  const { bodyText, fullBodyText, headers } = options.origin
  const originHeaders = new Headers(headers)
  const origin: RefusalFallbackBinding = Object.freeze({
    url: options.origin.url,
    accountId: options.origin.accountId,
    credentialId: options.origin.credentialId,
  })
  const sourceBody = parseBody(bodyText)
  const sentModel =
    typeof sourceBody?.model === 'string'
      ? sourceBody.model
      : options.sourceModel
  const billingInput = (
    attempt: RefusalFallbackPhysicalAttempt,
  ): AnthropicBillingRequest => ({
    ...options.billing,
    ...(attempt.refusalRetry && {
      attemptId: undefined,
      cacheWarming: undefined,
      ...(options.billing.cache && {
        cache: { ...options.billing.cache, warming: undefined },
      }),
    }),
    accountId: origin.accountId,
    credentialId: origin.credentialId,
    model: attempt.model,
    attempt: attempt.ordinal,
    ...(options.onBillingReport && {
      onReport: (report) => options.onBillingReport?.(report, attempt),
    }),
  })

  let credit: string | undefined
  const protect = (
    raw: Response,
    requestHeaders: Headers,
    requestBodyText: string,
    onRefusalCredit?: (credit: string) => void,
  ) =>
    protectFallbackCreditResponse(raw, {
      requestHeaders,
      requestBodyText,
      framing: 'event-stream',
      maxPendingBytes: options.maxPendingBytes,
      onRefusalCredit,
    })
  const guardedSource = options.protectedOrigin
    ? response
    : protect(response, originHeaders, bodyText, (value) => {
        credit = value
      })
  const sourceAttempt: RefusalFallbackPhysicalAttempt = Object.freeze({
    model: sentModel,
    ordinal: options.billing.attempt ?? 1,
    refusalRetry: false,
    paysCacheWrite: false,
    folded: false,
  })
  const observedSource =
    options.observePhysicalResponse?.(guardedSource, sourceAttempt) ??
    guardedSource
  const source = options.protectedOrigin
    ? observedSource
    : observeAnthropicBillingResponse(
        billingInput(sourceAttempt),
        observedSource,
        eventStream(guardedSource),
      )
  if (!eventStream(guardedSource)) return source

  async function retry(
    refusal: RefusalFallbackStreamRefusal,
    signal: AbortSignal,
  ): Promise<RefusalFallbackStreamRetry> {
    const thread = record(sourceBody?.thread)?.type
    const baseText = thread === 'continue' ? fullBodyText : bodyText
    const baseBody =
      thread === 'continue' ? baseText && parseBody(baseText) : sourceBody
    if (!baseBody || !baseText || !Array.isArray(baseBody.messages))
      return { kind: 'none', reason: 'missing-full-body' }

    const triedTargets = new Set<string>()
    let phase: 'unchanged' | 'folded' = 'unchanged'
    const isFresh = () => !signal.aborted && options.isFresh()
    while (isFresh()) {
      const choice = selectRefusalFallbackTarget({
        sourceModel: sentModel,
        category: refusal.category,
        body: baseBody,
        refusedUsage: refusal.usage,
        triedTargets,
        phase,
      })
      if (choice.kind === 'none') {
        if (phase === 'unchanged' && choice.reason === 'no-fitting-target') {
          phase = 'folded'
          continue
        }
        return choice
      }

      const folded = phase === 'folded'
      const token = folded ? undefined : refusal.creditToken
      if (token && refusal.hasPrefillClaim && refusal.prefillBlocks === null)
        return { kind: 'none', reason: 'prefill-too-large' }
      let retryBody = folded
        ? JSON.stringify(foldRefusalFallbackEffort(sentModel, baseBody))
        : baseText
      retryBody = replace(retryBody, ['model'], choice.model)
      retryBody = replace(retryBody, ['max_tokens'], choice.maxTokens)
      retryBody = replace(retryBody, ['fallbacks'], undefined)
      retryBody = replace(retryBody, ['fallback_credit_token'], undefined)
      const reusableBodyText = options.observePhysicalResponse
        ? await signRequestBody(replace(retryBody, ['thread'], undefined))
        : undefined
      if (thread === 'continue')
        retryBody = replace(retryBody, ['thread'], { type: 'create' })
      if (token) {
        retryBody = replace(retryBody, ['fallback_credit_token'], token)
        if (refusal.hasPrefillClaim && refusal.prefillBlocks?.length) {
          retryBody = replace(retryBody, ['messages', -1], {
            role: 'assistant',
            content: refusal.prefillBlocks,
          })
        }
      }
      retryBody = await signRequestBody(retryBody)
      // The origin's encoding is retained, but gzip must not reset the final
      // signature or trigger the ordinary transport's uncompressed replay.
      const body =
        originHeaders.get('content-encoding')?.toLowerCase() === 'gzip'
          ? await gzipAsync(retryBody)
          : retryBody

      if (!isFresh()) break
      const decision = await options.authorize({
        model: choice.model,
        origin,
        wait: false,
        signal,
      })
      if (
        decision.kind !== 'authorized' ||
        !decision.accessToken ||
        decision.accountId !== origin.accountId ||
        decision.credentialId !== origin.credentialId ||
        decision.url !== origin.url
      )
        return { kind: 'none', reason: 'not-authorized' }
      const headers = new Headers(originHeaders)
      headers.set('authorization', `Bearer ${decision.accessToken}`)
      const attempt: RefusalFallbackPhysicalAttempt = Object.freeze({
        model: choice.model,
        ordinal: sourceAttempt.ordinal + triedTargets.size + 1,
        refusalRetry: true,
        paysCacheWrite: !token,
        folded,
      })
      const billing = billingInput(attempt)
      if (!isFresh()) break
      triedTargets.add(choice.model)
      let raw: Response
      try {
        raw = await options.send({
          url: origin.url,
          headers,
          body,
          bodyText: retryBody,
          signal,
        })
      } catch {
        reportAnthropicBillingFailure(billing)
        return { kind: 'none', reason: 'send-failed' }
      }
      let guarded: Response
      try {
        guarded = protect(raw, headers, retryBody)
      } catch {
        reportAnthropicBillingFailure(billing)
        void raw.body?.cancel().catch(() => {})
        return { kind: 'none', reason: 'protection-failed' }
      }
      const sse = eventStream(guarded)
      const observed =
        options.observePhysicalResponse?.(guarded, attempt, reusableBodyText) ??
        guarded
      const billed = observeAnthropicBillingResponse(billing, observed, sse)
      if (billed.ok && sse && billed.body)
        return {
          kind: 'retry',
          response: billed,
          onCommitted: () =>
            options.onRetryCommitted?.({ model: attempt.model, attempt }),
        }
      try {
        if (!folded && (await wrongModel(billed, headers))) continue
        return { kind: 'none', reason: 'retry-rejected' }
      } finally {
        void billed.body?.cancel().catch(() => {})
      }
    }
    return { kind: 'none', reason: 'stale' }
  }

  return joinRefusalFallbackStream(source, {
    sourceModel: options.sourceModel,
    isFresh: options.isFresh,
    takeSourceRefusalCredit() {
      if (options.protectedOrigin)
        return options.protectedOrigin.takeRefusalCredit()
      const token = credit
      credit = undefined
      return token
    },
    retry,
    signal: options.signal,
    maxPendingBytes: options.maxPendingBytes,
  })
}
