import { runWithRequestSignal } from '@cortexkit/anthropic-auth-core'
import {
  type InstallOpenCode2AuthOptions,
  installOpenCode2Auth,
  type OpenCode2AuthInstallation,
  type OpenCode2HookContext,
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
  const registrations: Registration[] = []
  const hook: Plugin.Context['session']['hook'] = async (
    name,
    callback,
    options,
  ) => {
    const registration = await ctx.session.hook(
      name,
      async (draft) => {
        if (name !== 'http.request') return callback(draft)
        // Account choice runs inside http.request, before the host can send it.
        // Keep the signal request-local even when a session has concurrent turns.
        const signal =
          'request' in draft && draft.request instanceof Request
            ? draft.request.signal
            : undefined
        return runWithRequestSignal(signal, async () => callback(draft))
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
      native.adapter,
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
    dispose() {
      if (cleanup) return cleanup
      // Cancel credential callbacks before awaiting hook removal, so a
      // callback that finishes during cleanup cannot return a usable token.
      native.dispose()
      abort.abort()
      cleanup = (async () => {
        await installation.dispose()
        await listener
      })()
      return cleanup
    },
  }
}
