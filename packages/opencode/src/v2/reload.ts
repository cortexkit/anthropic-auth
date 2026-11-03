import { logger, NativeCustodyError } from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { version as pluginVersion } from '../../package.json'

type Hook = keyof SessionHooks
type Callback = (draft: SessionHooks[Hook]) => unknown

interface Owner {
  readonly hooks: Map<Hook, Callback[]>
  readonly version: string
  readonly registrations: Array<readonly [Hook, number]>
}

interface ReloadableRequestHooks {
  readonly context: Plugin.Context
  activate(): void
  retire(): void
}

// Keep live setups out of the registry used by older plugin code that does
// not check the plugin version and hook registration shape before forwarding.
const SHARED = Symbol.for('cortexkit.anthropic-auth.opencode2.requests.v2')

function shared() {
  const scope = globalThis as typeof globalThis & {
    [SHARED]?: {
      live: Map<string, Set<Owner>>
      requests: WeakMap<Request, Owner>
    }
  }
  scope[SHARED] ??= {
    live: new Map(),
    requests: new WeakMap(),
  }
  return scope[SHARED]
}

/**
 * The host can retain a retired plugin's hooks for an entire turn. Delegate at
 * the installer boundary, not at individual source callbacks: account choice,
 * authorization, rewrites, quota, retry state and redactors must all belong to
 * the same installer. Response streams already close over that installer's
 * adapter, so they never consult the registry again.
 */
export function createReloadableRequestHooks(
  ctx: Plugin.Context,
  key: string,
  version = pluginVersion,
): ReloadableRequestHooks {
  const registry = shared()
  const owner: Owner = { hooks: new Map(), version, registrations: [] }
  const transports = new Map<string, Owner | undefined>()
  let retired = false
  let mismatchLogged = false

  const newest = () => {
    if (!retired) return owner
    const live = registry.live.get(key)
    const next = live && [...live].at(-1)
    if (!next) throw new NativeCustodyError('closed')
    // Callback positions are interchangeable only within the same plugin
    // version and the same ordered registration shape. An update may change
    // either, even when the callback at a particular index still exists.
    if (
      next.version !== owner.version ||
      JSON.stringify(next.registrations) !== JSON.stringify(owner.registrations)
    ) {
      if (!mismatchLogged) {
        mismatchLogged = true
        logger.debug(
          'opencode2',
          'reload handoff refused: different plugin version or hook registration shape',
          { version: owner.version, successorVersion: next.version },
        )
      }
      throw new NativeCustodyError('closed')
    }
    return next
  }

  const hook: Plugin.Context['session']['hook'] = async (
    name,
    callback,
    options,
  ) => {
    const callbacks = owner.hooks.get(name) ?? []
    const index = callbacks.length
    callbacks.push(callback as Callback)
    owner.hooks.set(name, callbacks)
    owner.registrations.push([name, index])
    return ctx.session.hook(
      name,
      async (draft) => {
        let target: Owner
        if (name === 'http.response') {
          // Like common-auth, attribute a response only by the exact Request
          // the transport hook produced. A retired owner's responses stay with
          // that owner; unknown requests are never handed to a successor.
          target =
            registry.requests.get(
              (draft as SessionHooks['http.response']).request,
            ) ?? owner
        } else if (
          name === 'retry' ||
          name === 'experimental.ws.receive' ||
          name === 'experimental.ws.send'
        ) {
          if (transports.has(draft.sessionID)) {
            const transport = transports.get(draft.sessionID)
            // Retry has no request identity. If this retained hook has served
            // more than one installation in a session, leave retry to the host
            // rather than judge an old attempt using a successor's state.
            if (!transport) return
            target = transport
          } else target = owner
        } else {
          target = newest()
        }
        if (name === 'http.request' || name === 'experimental.ws.handshake') {
          const previous = transports.get(draft.sessionID)
          transports.set(
            draft.sessionID,
            transports.has(draft.sessionID) && previous !== target
              ? undefined
              : target,
          )
          while (transports.size > 512) {
            const first = transports.keys().next()
            if (!first.done) transports.delete(first.value)
          }
        }
        const run = target.hooks.get(name)?.[index]
        if (!run) throw new NativeCustodyError('closed')
        try {
          await run(draft)
        } finally {
          if (name === 'http.request')
            registry.requests.set(
              (draft as SessionHooks['http.request']).request,
              target,
            )
        }
      },
      options,
    )
  }

  return {
    context: { ...ctx, session: { ...ctx.session, hook } },
    activate() {
      const live = registry.live.get(key) ?? new Set()
      live.add(owner)
      registry.live.set(key, live)
    },
    retire() {
      retired = true
      const live = registry.live.get(key)
      live?.delete(owner)
      if (live?.size === 0) registry.live.delete(key)
    },
  }
}
