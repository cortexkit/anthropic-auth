import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * End a caller's wait without cancelling shared work such as a token refresh.
 * The operation still owns its cleanup and any late rejection is observed.
 */
export function raceWithSignal<T>(
  signal: AbortSignal | null | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!signal) return operation()
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    const finish = () => signal.removeEventListener('abort', aborted)
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return operation()
      })
      .then(
        (value) => {
          finish()
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        },
        (error) => {
          finish()
          reject(signal.aborted ? signal.reason : error)
        },
      )
  })
}

export function abortableFetch(
  send: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) {
  return (input: string | URL | Request, init?: RequestInit) => {
    const signal =
      init?.signal !== undefined
        ? init.signal
        : input instanceof Request
          ? input.signal
          : undefined
    return runWithRequestSignal(signal, () => send(input, init))
  }
}

export function withAbortableFetch<
  T extends { fetch: Parameters<typeof abortableFetch>[0] },
>(options: T): T {
  return { ...options, fetch: abortableFetch(options.fetch) }
}

export const AUXILIARY_REQUEST_TIMEOUT_MS = 30_000

/** Account checks must finish even when no host request is waiting on them. */
export function auxiliaryRequestSignal(signal?: AbortSignal | null) {
  const deadline = AbortSignal.timeout(AUXILIARY_REQUEST_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

const requests = new AsyncLocalStorage<{
  signal: AbortSignal | null | undefined
  commits: Array<() => void>
}>()

export function requestSignal() {
  return requests.getStore()?.signal
}

/** Publish request-owned routing changes only after preparation succeeds. */
export function commitRequestChange(commit: () => void) {
  const request = requests.getStore()
  request?.signal?.throwIfAborted()
  if (request) request.commits.push(commit)
  else commit()
}

export function runWithRequestSignal<T>(
  signal: AbortSignal | null | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const request = { signal, commits: [] as Array<() => void> }
  return raceWithSignal(signal, () =>
    requests.run(request, async () => {
      try {
        const result = await operation()
        signal?.throwIfAborted()
        for (const commit of request.commits) commit()
        return result
      } finally {
        request.commits.length = 0
      }
    }),
  )
}
