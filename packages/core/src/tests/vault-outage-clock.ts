/** A clock for exercising custody's bounded outage wait without wall-clock sleeps. */
export function vaultOutageClock(initial: number) {
  let now = initial
  const timers = new Map<object, { at: number; run: () => void }>()
  const setTimeout = ((run: () => void, ms = 0) => {
    const handle = { unref() {} }
    timers.set(handle, { at: now + ms, run })
    return handle
  }) as unknown as typeof globalThis.setTimeout
  const clearTimeout = ((handle: object) => {
    timers.delete(handle)
  }) as unknown as typeof globalThis.clearTimeout
  return {
    now: () => now,
    set: (value: number) => {
      now = value
    },
    setTimeout,
    clearTimeout,
    run(ms: number) {
      const next = [...timers.entries()].find(
        ([, timer]) => timer.at === now + ms,
      )
      if (!next)
        throw new Error(`No vault timer scheduled in ${ms} milliseconds`)
      timers.delete(next[0])
      now = next[1].at
      next[1].run()
    },
    async finish<T>(pending: Promise<T>): Promise<T> {
      let done = false
      // Attach rejection handling before advancing timers, including for unavailable results.
      const result = pending
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          done = true
        })
      for (let turn = 0; !done && turn < 10_000; turn++) {
        // File-backed roster checks must settle before the next virtual timer fires.
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (done) break
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) continue
        const [handle, timer] = next
        timers.delete(handle)
        now = Math.max(now, timer.at)
        timer.run()
      }
      if (!done)
        throw new Error('Vault operation did not settle with injected time')
      const settled = await result
      if (!settled.ok) throw settled.error
      return settled.value
    },
  }
}
