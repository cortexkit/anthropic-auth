/** Diagnostic evidence, not an ownership assertion or a control hook. */
export type NativeLockEvent = {
  type: 'acquired' | 'released' | 'contended'
  name: string
  path: string
}

/**
 * Diagnostics cannot decide whether a lock owner refreshes or saves a token.
 * Consume returned rejections without awaiting: an observer may never settle.
 * With no observer, leave the producer callback absent and allocate no wrapper.
 */
export function nativeLockObserver(
  observer: ((event: NativeLockEvent) => void) | undefined,
): ((event: NativeLockEvent) => void) | undefined {
  if (!observer) return undefined
  return (event) => {
    try {
      const result: unknown = observer(event)
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        void Promise.resolve(result).catch(() => {})
      }
    } catch {
      // Includes callback throws and throwing thenable accessors. Ownership and
      // awaited lock-step errors still propagate through their separate paths.
    }
  }
}
