import type { InsulaUsageTransport } from '@cortexkit/common-auth/claustrum'

/** A held-open Insula stream and virtual timeout queue; no wall clock runs. */
export function insulaBackground(refused = false) {
  type Timer = {
    run(): unknown
    ms: number
    unrefed: boolean
    unref(): void
  }
  const timers = new Set<Timer>()
  let onNotice: ((body: Uint8Array) => void) | undefined
  let end: () => void = () => {}
  let seq = 0
  const counts = { opens: 0, stops: 0 }
  const watchUsage: NonNullable<InsulaUsageTransport['watchUsage']> = (
    notice,
  ) => {
    counts.opens++
    if (refused) {
      return {
        stop() {
          counts.stops++
        },
        closed: Promise.reject(
          Object.assign(new Error('old daemon'), { code: 'unknown_method' }),
        ),
      }
    }
    onNotice = notice
    const closed = new Promise<void>((resolve) => {
      end = resolve
    })
    return {
      closed,
      stop() {
        counts.stops++
        end()
      },
    }
  }
  return {
    counts,
    timers,
    watchUsage,
    setTimeout: ((run: () => unknown, ms: number) => {
      const timer: Timer = {
        run,
        ms,
        unrefed: false,
        unref() {
          this.unrefed = true
        },
      }
      timers.add(timer)
      return timer
    }) as unknown as typeof setTimeout,
    clearTimeout: ((timer: Timer) => {
      timers.delete(timer)
    }) as unknown as typeof clearTimeout,
    async tick() {
      const timer = [...timers].find((timer) => timer.ms === 60_000)
      if (!timer) return
      timers.delete(timer)
      await timer.run()
    },
    notice() {
      onNotice?.(
        new TextEncoder().encode(
          JSON.stringify({
            kind: 'usage.changed',
            epoch: 'insula-test',
            seq: ++seq,
            provider: 'claude',
          }),
        ),
      )
    },
    end: () => end(),
  }
}
