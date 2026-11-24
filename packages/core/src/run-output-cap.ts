const routingKey = Symbol.for('cortexkit.routing')

/** Read the runner's session cap without waiting on the routing bridge. */
export function readRunOutputCap(
  sessionId: string | null | undefined,
): number | null {
  if (!sessionId) return null
  try {
    const routing: unknown = Reflect.get(globalThis, routingKey)
    if (typeof routing !== 'function') return null
    const handle: unknown = routing(sessionId)
    if (typeof handle !== 'object' || handle === null) return null
    const read: unknown = Reflect.get(handle, 'max_output_tokens')
    if (typeof read !== 'function') return null
    const cap: unknown = Reflect.apply(read, handle, [])
    if (typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0)
      return cap
    // An async result cannot set the cap, but it must not reject unhandled.
    if (cap !== null && (typeof cap === 'object' || typeof cap === 'function'))
      void Promise.resolve(cap).catch(() => {})
  } catch {
    // A broken routing bridge must not prevent a request from being sent.
  }
  return null
}
