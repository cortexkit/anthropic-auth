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
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAdapterDeps,
  type NativeAnthropicAttemptData,
} from './adapter'
import { isTerminalPoolHold } from './source'

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
  deps: NativeAnthropicAdapterDeps<Q, P> & {
    onSessionDeleted?: (sessionID: string) => void
  },
  ownership: NonNullable<InstallOpenCode2AuthOptions['gateOnPlaceholder']>,
): Promise<NativeAnthropicInstallation<Q, P>> {
  const native = createNativeAnthropicAdapter(deps)
  const endings = new Set<Promise<void>>()
  const requestFinisher = new AsyncLocalStorage<{
    finish: () => void
    hostAttempt: number
    discardQuotaStop?: () => void
    preserveCache?: () => boolean
    route?: string
    attemptId?: string
  }>()
  const retryWait = new AsyncLocalStorage<{ terminalDelay?: number }>()
  const retryScopeKey = (input: {
    sessionID: string
    agent: string
    model: { providerID: string; id: string }
  }) =>
    JSON.stringify([
      input.sessionID,
      input.agent,
      input.model.providerID,
      input.model.id,
    ])
  const nextHostAttempts = new Map<
    string,
    { sessionID: string; attempt: number }
  >()
  const forgetHostAttempts = (sessionID: string) => {
    for (const [key, next] of nextHostAttempts)
      if (next.sessionID === sessionID) nextHostAttempts.delete(key)
  }
  const attemptFinishers = new Map<string, () => void>()
  const responseCleanups = new WeakMap<Request, () => void>()
  const adapter: typeof native.adapter = {
    ...native.adapter,
    async chooseAccount(input) {
      const choice = await native.adapter.chooseAccount(input)
      const retry = retryWait.getStore()
      if (retry && isTerminalPoolHold(choice))
        retry.terminalDelay = choice.hold.delayMs
      return choice
    },
    rewriteRequest(input) {
      const request = requestFinisher.getStore()
      if (request) {
        native.bindHostAttempt(input.attempt, request.hostAttempt)
        const data = input.attempt.data
        if (data) {
          request.discardQuotaStop = () => native.discardQuotaStopMessage(data)
          request.preserveCache = () => native.preservesCacheTemplate(data)
        }
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
  const requestTurns = new WeakMap<Request, () => void>()
  const hook: Plugin.Context['session']['hook'] = (name, callback, options) => {
    return ctx.session.hook(
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
                responseCleanups.get(draft.request)?.()
                responseCleanups.delete(draft.request)
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
          const previous = 'decision' in draft ? draft.decision : undefined
          const wait: { terminalDelay?: number } = {}
          const result = await retryWait.run(wait, () => callback(draft))
          if ('decision' in draft) {
            const key = retryScopeKey(draft)
            nextHostAttempts.delete(key)
            if (draft.decision.retry) {
              // The installer must have accepted the locally marked pool hold.
              if (
                draft.decision === previous ||
                draft.decision.delay !== wait.terminalDelay
              )
                draft.decision.delay = clampHostRetryMs(draft.decision.delay)
              nextHostAttempts.set(key, {
                sessionID: draft.sessionID,
                attempt: draft.attempt,
              })
              while (nextHostAttempts.size > 512) {
                const first = nextHostAttempts.keys().next().value
                if (first !== undefined) nextHostAttempts.delete(first)
              }
            }
          }
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
          hostAttempt: number
          discardQuotaStop?: () => void
          preserveCache?: () => boolean
          route?: string
          attemptId?: string
        }
        const finish = () => {
          try {
            if (completion?.preserveCache?.()) turn?.pause()
            else turn?.finish()
          } catch {}
          signal?.removeEventListener('abort', finish)
          if (completion?.attemptId)
            attemptFinishers.delete(completion.attemptId)
          if (finalRequest) requestTurns.delete(finalRequest)
        }
        // Retry hooks expose the host count; response hooks do not. Consume
        // it once for the next send, including retries unrelated to quota.
        const key = retryScopeKey(input)
        const hostAttempt = nextHostAttempts.get(key)?.attempt ?? 1
        nextHostAttempts.delete(key)
        completion = { finish, hostAttempt }
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
          if (completion.discardQuotaStop)
            responseCleanups.set(input.request, completion.discardQuotaStop)
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
    // The shared installer rolls back its hooks; the adapter owns its callbacks.
    native.dispose()
    throw error
  }

  const forgetSession = (sessionID: string) => {
    forgetHostAttempts(sessionID)
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
            types: ['session.deleted', 'session.idle', 'session.status'],
          })) {
            if (event.type === 'session.deleted') {
              forgetSession(event.data.sessionID)
              deps.onSessionDeleted?.(event.data.sessionID)
            }
            if (
              event.type === 'session.idle' ||
              (event.type === 'session.status' &&
                event.data.status.type === 'idle')
            ) {
              forgetHostAttempts(event.data.sessionID)
              deps.source.forgetTurn?.(event.data.sessionID)
            }
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
      nextHostAttempts.clear()
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
