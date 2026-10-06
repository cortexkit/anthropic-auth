import { afterEach, test as registerTest } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface TestGate {
  wait: Promise<void>
  open(): void
}

/**
 * Bun may start teardown without cancelling a timed-out body. Keep its fixtures
 * alive through the entire body and explicitly registered detached work.
 */
export class TestLifetime {
  private bodySettled: Promise<void> | undefined
  private readonly detached = new Set<Promise<void>>()
  private readonly gates = new Set<() => void>()
  private readonly cleanups: Array<() => void | Promise<void>> = []
  private readonly errors: unknown[] = []
  private closing = false
  private finished = false
  private finishing: Promise<void> | undefined

  runBody<T>(body: () => T | Promise<T>): Promise<T> {
    if (this.bodySettled || this.closing)
      throw new Error('Test body lifetime already started or closed')
    const running = Promise.resolve().then(body)
    // Return the body promise to Bun so it reports failed assertions. Teardown
    // waits for settlement without reporting the same body failure again.
    this.bodySettled = running.then(
      () => {},
      () => {},
    )
    return running
  }

  /** Register detached work before the body ends; failures surface after draining. */
  trackDetached(work: Promise<unknown>): void {
    if (this.finished) throw new Error('Test fixture lifetime is closed')
    const settled = work.then(
      () => {},
      (error) => {
        this.errors.push(error)
      },
    )
    this.detached.add(settled)
    void settled.then(() => {
      this.detached.delete(settled)
    })
  }

  gate(): TestGate {
    let resolve!: () => void
    const wait = new Promise<void>((done) => {
      resolve = done
    })
    const open = () => {
      this.gates.delete(open)
      resolve()
    }
    // A still-running body can create a gate after teardown has already begun.
    if (this.closing) open()
    else this.gates.add(open)
    return { wait, open }
  }

  deferCleanup(cleanup: () => void | Promise<void>): void {
    if (this.finished) throw new Error('Test fixture lifetime is closed')
    this.cleanups.push(cleanup)
  }

  finish(): Promise<void> {
    this.finishing ??= this.drainAndClean()
    return this.finishing
  }

  private async drainDetached(): Promise<void> {
    while (this.detached.size) await Promise.all([...this.detached])
  }

  private async drainAndClean(): Promise<void> {
    this.closing = true
    for (const open of [...this.gates]) open()
    await this.bodySettled
    await this.drainDetached()
    for (
      let cleanup = this.cleanups.shift();
      cleanup;
      cleanup = this.cleanups.shift()
    ) {
      try {
        await cleanup()
      } catch (error) {
        this.errors.push(error)
      }
      await this.drainDetached()
    }
    this.finished = true
    if (this.errors.length)
      throw new AggregateError(this.errors, 'Test fixture lifetime failed')
  }
}

/** Associate each test's fixtures with its async body so a late cleanup cannot remove another test's files. */
export function createTestLifetimeSuite() {
  const context = new AsyncLocalStorage<TestLifetime>()
  const lifetimes = new Set<TestLifetime>()
  const current = () => {
    const lifetime = context.getStore()
    if (!lifetime) throw new Error('Test fixture has no body lifetime')
    return lifetime
  }
  afterEach(async () => {
    const results = await Promise.allSettled(
      [...lifetimes].map(async (lifetime) => {
        try {
          await lifetime.finish()
        } finally {
          lifetimes.delete(lifetime)
        }
      }),
    )
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Test fixture teardown failed',
      )
  })
  return {
    test(name: string, body: () => unknown, timeout?: number): void {
      registerTest(
        name,
        () => {
          const lifetime = new TestLifetime()
          lifetimes.add(lifetime)
          return context.run(lifetime, () => lifetime.runBody(body))
        },
        timeout,
      )
    },
    deferCleanup: (cleanup: () => void | Promise<void>) =>
      current().deferCleanup(cleanup),
    gate: () => current().gate(),
    trackDetached: (work: Promise<unknown>) => current().trackDetached(work),
  }
}
