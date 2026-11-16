import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type CacheKeepRealTurn,
  clampHostRetryMs,
  hostRetryResponse,
  runWithRequestSignal,
  withCacheKeepRealTurn,
  withSessionCacheReportHandoff,
} from '@cortexkit/anthropic-auth-core'
import {
  type InstallOpenCode2AuthOptions,
  installOpenCode2Auth,
  type OpenCode2AuthInstallation,
  type OpenCode2HookContext,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAdapterDeps,
  type NativeAnthropicAttemptData,
} from './adapter'

export interface NativeAnthropicInstallation<Q, P> {
  readonly installation: OpenCode2AuthInstallation<
    Q,
    NativeAnthropicAttemptData<P>
  >
  readonly forgetSession: (sessionID: string) => void
  readonly drain: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/**
 * The shared installer removes request records on session deletion. Also cancel
 * the adapter's pending credential lookup and body preparation: removing a
 * record alone cannot stop an asynchronous callback from returning a token.
 */
export async function installNativeAnthropic<Q, P>(
  ctx: OpenCode2HookContext,
  deps: NativeAnthropicAdapterDeps<Q, P>,
  ownership: NonNullable<InstallOpenCode2AuthOptions['gateOnPlaceholder']>,
): Promise<NativeAnthropicInstallation<Q, P>> {
  const native = createNativeAnthropicAdapter(deps)
  const endings = new Set<Promise<void>>()
  const requestFinisher = new AsyncLocalStorage<{
    finish: () => void
    route?: string
    attemptId?: string
  }>()
  const attemptFinishers = new Map<string, () => void>()
  const adapter: typeof native.adapter = {
    ...native.adapter,
    rewriteRequest(input) {
      const request = requestFinisher.getStore()
      if (request) {
        request.route = input.attempt.data?.route
        request.attemptId = input.attempt.attemptId
        attemptFinishers.set(input.attempt.attemptId, request.finish)
      }
      return native.adapter.rewriteRequest?.(input)
    },
    onAttemptEnd(attempt, outcome) {
      const pending = (async () => {
        try {
          await native.adapter.onAttemptEnd?.(attempt, outcome)
        } finally {
          const finish = attemptFinishers.get(attempt.attemptId)
          attemptFinishers.delete(attempt.attemptId)
          // A body-less OAuth response can end before http.response decides
          // whether to track its cache prefix. That hook's finally closes the
          // real-turn lease after the tracking decision.
          if (
            attempt.data?.route !== 'oauth' ||
            outcome.status === undefined ||
            outcome.status >= 400 ||
            outcome.error
          ) {
            try {
              finish?.()
            } catch {}
          }
        }
      })()
      endings.add(pending)
      void pending.finally(() => endings.delete(pending)).catch(() => {})
      return pending
    },
  }
  // common-auth starts abandonment callbacks during dispose without awaiting
  // them. Keep the runtime lease until those callbacks finish recording usage
  // and credential failures.
  const drain = async () => {
    await Promise.allSettled([...endings])
  }
  const registrations: Registration[] = []
  const requestTurns = new WeakMap<Request, () => void>()
  const hook: Plugin.Context['session']['hook'] = async (
    name,
    callback,
    options,
  ) => {
    const registration = await ctx.session.hook(
      name,
      async (draft) => {
        if (name === 'http.response') {
          return withSessionCacheReportHandoff(async () => {
            let accepted = false
            try {
              const result = await callback(draft)
              accepted = true
              return result
            } finally {
              if ('request' in draft && draft.request instanceof Request) {
                try {
                  const response =
                    'response' in draft && draft.response instanceof Response
                      ? draft.response
                      : undefined
                  deps.source.onResponseHandedToHost?.(
                    draft.request,
                    accepted && response
                      ? native.acceptedResponse(response)
                      : undefined,
                  )
                } catch {
                  /* Reporting never changes the host response. */
                }
              }
              if ('response' in draft && draft.response instanceof Response)
                draft.response = hostRetryResponse(draft.response)
              if ('request' in draft && draft.request instanceof Request) {
                try {
                  requestTurns.get(draft.request)?.()
                } catch {}
              }
            }
          })()
        }
        if (name === 'retry') {
          const result = await callback(draft)
          if ('decision' in draft && draft.decision.retry)
            draft.decision.delay = clampHostRetryMs(draft.decision.delay)
          return result
        }
        if (name !== 'http.request') return callback(draft)
        // Account choice runs inside http.request, before the host can send it.
        // Keep the signal request-local even when a session has concurrent turns.
        const signal =
          'request' in draft && draft.request instanceof Request
            ? draft.request.signal
            : undefined
        const input = draft as {
          sessionID: string
          agent: string
          kind: 'primary'
          model: { providerID: string; id: string }
          request: Request
        }
        let turn: CacheKeepRealTurn | undefined
        let finalRequest: Request | undefined
        let completion: {
          finish: () => void
          route?: string
          attemptId?: string
        }
        const finish = () => {
          try {
            turn?.finish()
          } catch {}
          signal?.removeEventListener('abort', finish)
          if (completion?.attemptId)
            attemptFinishers.delete(completion.attemptId)
          if (finalRequest) requestTurns.delete(finalRequest)
        }
        completion = { finish }
        try {
          // common-auth scopes these hooks to Anthropic. Other providers never
          // reach this observer, so their turns cannot invalidate a warm target.
          if (input.model.providerID === 'anthropic') {
            turn = deps.source.beginRealTurn?.({
              sessionID: input.sessionID,
              providerID: input.model.providerID,
              modelID: input.model.id,
              agent: input.agent,
              kind: input.kind,
            })
            if (
              ownership.credential(input.request.headers) !==
              placeholderSecret('anthropic')
            )
              finish()
          }
        } catch {
          finish()
        }
        signal?.addEventListener('abort', finish, { once: true })
        if (signal?.aborted) finish()
        let completed = false
        try {
          const result = await runWithRequestSignal(signal, () =>
            requestFinisher.run(completion, () =>
              withCacheKeepRealTurn(turn, async () => callback(draft)),
            ),
          )
          completed = true
          if (turn) {
            finalRequest = input.request
            requestTurns.set(finalRequest, finish)
          }
          return result
        } finally {
          if (!completed || completion.route !== 'oauth') finish()
        }
      },
      options,
    )
    registrations.push(registration)
    return registration
  }
  const abort = new AbortController()
  let installation: OpenCode2AuthInstallation<Q, NativeAnthropicAttemptData<P>>
  try {
    installation = await installOpenCode2Auth(
      { session: { hook }, event: ctx.event },
      adapter,
      {
        logger: deps.log,
        gateOnPlaceholder: ownership,
      },
    )
  } catch (error) {
    native.dispose()
    await Promise.allSettled(
      registrations.map((registration) => registration.dispose()),
    )
    throw error
  }

  const forgetSession = (sessionID: string) => {
    native.forgetSession(sessionID)
    installation.forgetSession(sessionID)
  }
  // Cancel pending credential and policy callbacks as well as removing the
  // shared installer's records for this session.
  const events = ctx.event
  const listener = events
    ? (async () => {
        try {
          for await (const event of events.subscribe({
            signal: abort.signal,
          })) {
            if (event.type === 'session.deleted')
              forgetSession(event.data.sessionID)
            if (
              event.type === 'session.idle' ||
              (event.type === 'session.status' &&
                event.data.status.type === 'idle')
            )
              deps.source.forgetTurn?.(event.data.sessionID)
          }
        } catch (error) {
          if (!abort.signal.aborted)
            deps.log?.warn('stopped listening for session deletion', {
              error: error instanceof Error ? error.name : 'unknown',
            })
        }
      })()
    : Promise.resolve()

  let cleanup: Promise<void> | undefined
  return {
    installation,
    forgetSession,
    drain,
    dispose() {
      if (cleanup) return cleanup
      // Cancel credential callbacks before awaiting hook removal, so a
      // callback that finishes during cleanup cannot return a usable token.
      native.dispose()
      abort.abort()
      cleanup = (async () => {
        await installation.dispose()
        await listener
        await drain()
      })()
      return cleanup
    },
  }
}
