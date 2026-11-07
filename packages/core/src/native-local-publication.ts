import type { NativeAccountMetadataPatch } from './native-account-view.ts'

const publishers = new Map<
  string,
  { writer: ReturnType<typeof createPublisher>; leases: number }
>()

/** Share one replaceable bookkeeping mailbox per destination in this process, never for credential writes. */
export function acquireNativeLocalPublisher(key: string) {
  let owned = publishers.get(key)
  if (!owned) {
    owned = { writer: createPublisher(), leases: 0 }
    publishers.set(key, owned)
  }
  owned.leases++
  let released = false
  return {
    ...owned.writer,
    release() {
      if (released) return
      released = true
      if (--owned.leases === 0) publishers.delete(key)
    },
  }
}

function createPublisher() {
  let tail: Promise<unknown> = Promise.resolve()
  const pending = new Map<
    string,
    {
      patch: NativeAccountMetadataPatch
      result: Promise<boolean>
    }
  >()
  const run = <T>(write: () => Promise<T>): Promise<T> => {
    const result = tail.then(write)
    tail = result.catch(() => {})
    return result
  }
  return {
    run,
    enqueue(
      key: string,
      patch: NativeAccountMetadataPatch,
      write: (patch: NativeAccountMetadataPatch) => Promise<boolean>,
      signal?: AbortSignal,
    ): Promise<boolean> {
      if (signal?.aborted) return Promise.reject(signal.reason)
      const queued = pending.get(key)
      if (queued) {
        const previous = queued.patch
        queued.patch = { ...previous, ...patch }
        if (previous.lastUsed !== undefined || patch.lastUsed !== undefined)
          queued.patch.lastUsed = Math.max(
            previous.lastUsed ?? 0,
            patch.lastUsed ?? 0,
          )
        for (const field of [
          'quotaErrorClearedAt',
          'quotaErrorGeneration',
        ] as const)
          if (previous[field] !== undefined || patch[field] !== undefined)
            queued.patch[field] = Math.max(
              previous[field] ?? 0,
              patch[field] ?? 0,
            )
        if (
          previous.lastQuotaRefreshError &&
          patch.lastQuotaRefreshError &&
          previous.lastQuotaRefreshError.checkedAt >
            patch.lastQuotaRefreshError.checkedAt
        )
          queued.patch.lastQuotaRefreshError = previous.lastQuotaRefreshError
        return queued.result
      }
      const batch = { patch, result: Promise.resolve(false) }
      pending.set(key, batch)
      let stopWaiting = () => {}
      const result = run(async () => {
        // Wait one event-loop turn so runtime metadata updates for the same
        // account can join the pending write.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        stopWaiting()
        signal?.throwIfAborted()
        pending.delete(key)
        return write(batch.patch)
      })
      // A queued write may sit behind another live runtime's lock wait. Cancel
      // its wait independently, but never detach a writer that already started.
      batch.result = signal
        ? new Promise<boolean>((resolve, reject) => {
            const abort = () => {
              if (pending.get(key) === batch) pending.delete(key)
              reject(signal.reason)
            }
            stopWaiting = () => signal.removeEventListener('abort', abort)
            signal.addEventListener('abort', abort, { once: true })
            void result.then(resolve, reject).finally(stopWaiting)
            if (signal.aborted) abort()
          })
        : result
      return batch.result
    },
    async drain(): Promise<void> {
      let observed: Promise<unknown>
      do {
        observed = tail
        await observed
      } while (observed !== tail)
    },
  }
}
