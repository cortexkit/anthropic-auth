import {
  hostRetryHeaders,
  stickyRetainRetryHeaders,
  stickyRetryAfterWithJitter,
} from '@cortexkit/anthropic-auth-core'

export {
  applyCacheDiagnosticsOptIn,
  buildCacheDiagnosticsRecord,
  CACHE_DIAGNOSTICS_BETA,
  CACHE_DIAGNOSTICS_BETAS_LIMIT,
  CACHE_DIAGNOSTICS_LOG_PREFIX,
  CACHE_DIAGNOSTICS_SESSION_LIMIT,
  CACHE_DIAGNOSTICS_SHORT_GAP_MS,
  CACHE_DIAGNOSTICS_SOURCE_SYNTHETIC,
  CacheDiagnosticsBetaTracker,
  type CacheDiagnosticsRecord,
  type CacheDiagnosticsRequestContext,
  type CacheDiagnosticsSource,
  type CacheDiagnosticsState,
  CacheDiagnosticsTracker,
  formatCacheDiagnosticsLogLine,
  summarizeCacheTtl,
} from '@cortexkit/anthropic-auth-core'

export function copyCacheDiagnosticsContext<T>(
  contexts: WeakMap<Response, T>,
  source: Response,
  destination: Response,
): void {
  const context = contexts.get(source)
  if (context) contexts.set(destination, context)
}

export async function withStickyRetryAfter(
  response: Response,
  sessionId: string,
  retryAfterSeconds: number,
  streamingRateLimit: boolean,
  contexts: WeakMap<Response, unknown>,
  retain = false,
) {
  const headers = retain
    ? stickyRetainRetryHeaders(response.headers)
    : new Headers(response.headers)
  if (!retain)
    headers.set(
      'retry-after',
      String(stickyRetryAfterWithJitter(sessionId, retryAfterSeconds)),
    )
  const boundedHeaders = hostRetryHeaders(headers)
  if (streamingRateLimit) {
    await response.body?.cancel().catch(() => {})
    boundedHeaders.set('content-type', 'application/json')
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: retain
            ? 'Sticky OAuth account quota is unconfirmed; retrying shortly while retaining session affinity.'
            : 'Sticky OAuth account quota resets shortly; retaining session affinity.',
        },
      }),
      { status: 429, headers: boundedHeaders },
    )
  }
  const retriedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: boundedHeaders,
  })
  copyCacheDiagnosticsContext(contexts, response, retriedResponse)
  return retriedResponse
}
