import { afterAll, afterEach, beforeEach, test as bunTest } from 'bun:test'
import { rm } from 'node:fs/promises'
import type { NativeCustodyClient } from '@cortexkit/anthropic-auth-core'
import { resetClaudeCodeIdentityCachesForTest } from '@cortexkit/anthropic-auth-core'
import { TestLifetime } from '../../../../core/src/tests/test-lifetime.ts'
import {
  drainSidebarWrites,
  getSidebarStateFile,
  __setSidebarStateWriteTestHooks as installSidebarStateWriteHooks,
} from '../../sidebar-state'
import type { NativeOpencodeFixture } from '../native-fixture.ts'
import { installDefaultFetchMock } from '../test-fetch'

export type MigratedPool = NativeOpencodeFixture & {
  /** The Anthropic OAuth credential transferred from OpenCode's auth.json to the shared credential pool. */
  mainHostAuth: { access: string; refresh: string; expires: number }
}

/** Credentials and account UUIDs accepted by this test's OAuth server mocks. */
export type PoolLogin = { access: string; refresh: string; identity: string }

export type PluginRuntimeOverrides = Partial<{
  authorize: typeof import('@cortexkit/anthropic-auth-core').authorize
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  scopedRosterPollIntervalMs: number
  claustrumScopedConnect: () => Promise<NativeCustodyClient>
  cacheKeepAggregateRefreshIntervalMs: number
  tuiPickupTimeoutMs: number
  beforeSidebarAccountReload: () => void | Promise<void>
}>

// Sidebar write hooks are installed per state file and replace each other.
// Tests set their own hooks through the wrapper below, so a helper waiting for
// sidebar writes can listen on the same file without removing a test's hooks.
export type SidebarWriteHooks = NonNullable<
  Parameters<typeof installSidebarStateWriteHooks>[0]
>

// Environment variables a test sets to point the plugin at its migrated
// account pool; each test's cleanup puts back their previous values.
export const nativeEnvKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_AUTH_CONTENT',
] as const

export const EMPTY_POST = { method: 'POST', body: '{}' } as const

/**
 * Per-file test context. Each test file creates one instance and binds the
 * shared helpers to it, so no support module holds a global "current pool"
 * singleton that one file could clear under another file.
 */
export type Opencode1TestContext = {
  /** One lifetime per test, created before describe-level hooks run. */
  testLifetime: TestLifetime | undefined
  /** The pool the current test migrated most recently, if any. */
  migratedPool: MigratedPool | undefined
  livePlugins: Set<{ dispose?: () => unknown }>
  tempConfigDir: string | undefined
  tempConfigDirs: Set<string>
  allTempConfigDirs: Set<string>
  fallbackRefreshes: Set<Promise<unknown>>
  poolLogins: PoolLogin[]
  successorAccess: Map<string, string>
  pluginRuntimeOverrides: PluginRuntimeOverrides
  testSidebarWriteHooks: Map<string, SidebarWriteHooks>
  sidebarWriteListeners: Map<string, Set<() => void>>
  /** Fetch installed by the test preload, captured after preload. */
  loopbackFetch: typeof fetch
}

export function createOpencode1TestContext(): Opencode1TestContext {
  // Captured when the test file creates its context, which runs after the
  // preload sandbox and setup modules, never before them.
  const loopbackFetch = globalThis.fetch
  return {
    testLifetime: undefined,
    migratedPool: undefined,
    livePlugins: new Set(),
    tempConfigDir: undefined,
    tempConfigDirs: new Set(),
    allTempConfigDirs: new Set(),
    fallbackRefreshes: new Set(),
    poolLogins: [],
    successorAccess: new Map(),
    pluginRuntimeOverrides: {},
    testSidebarWriteHooks: new Map(),
    sidebarWriteListeners: new Map(),
    loopbackFetch,
  }
}

export function getBodyLifetime(ctx: Opencode1TestContext): TestLifetime {
  if (!ctx.testLifetime) throw new Error('Test fixture has no body lifetime')
  return ctx.testLifetime
}

export type TestBody = () => unknown

export async function drainBeforeReset(
  lifetime: TestLifetime | undefined,
  reset: () => void | Promise<void>,
) {
  // Bun can time out the test before its async body finishes. Keep its
  // transport and environment intact until that body and its work drain.
  await lifetime?.finish()
  await reset()
}

/** Bun's test, with the body run inside this test's fixture lifetime. */
export function createOpencode1Test(ctx: Opencode1TestContext) {
  function test(name: string, body: TestBody, timeout?: number) {
    bunTest(name, () => getBodyLifetime(ctx).runBody(body), timeout)
  }
  test.serial = (name: string, body: TestBody, timeout?: number) => {
    bunTest.serial(name, () => getBodyLifetime(ctx).runBody(body), timeout)
  }
  test.each =
    <T>(cases: readonly T[]) =>
    (name: string, body: (row: T) => unknown, timeout?: number) => {
      bunTest.each(cases as T[])(
        name,
        (row: T) => getBodyLifetime(ctx).runBody(() => body(row)),
        timeout,
      )
    }
  return test
}

export async function cleanupTempConfigDirs(
  ctx: Opencode1TestContext,
  drainTimeoutMs = 4_000,
) {
  const refreshesSettled = await Promise.race([
    Promise.allSettled(ctx.fallbackRefreshes).then(() => true),
    Bun.sleep(drainTimeoutMs).then(() => false),
  ])
  if (refreshesSettled) ctx.fallbackRefreshes.clear()
  await drainSidebarWrites()
  // tempConfigDir is a migrated root; the test's lifetime removes it after
  // disposing the plugins that use it.
  const directories = [...ctx.tempConfigDirs]
  ctx.tempConfigDirs.clear()
  ctx.tempConfigDir = undefined
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }).catch(() => {}),
    ),
  )
}

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

/**
 * A signal a test's mock raises when the plugin reaches a point the body
 * waits for. Teardown raises it as well, so a body still waiting for a point
 * the plugin never reached resumes and finishes (failing on its assertions)
 * instead of holding its plugin and every later test's teardown.
 */
export function lifetimeSignal(ctx: Opencode1TestContext) {
  const gate = getBodyLifetime(ctx).gate()
  return { raised: gate.wait, raise: gate.open }
}

/**
 * Waits on values a test's mocks record. A mock calls `changed()` after each
 * update, which wakes every waiter whose condition now holds; the test waits
 * for the update itself instead of sleeping a fixed time or polling a fixed
 * number of times. Teardown wakes the rest, so the caller's assertion then
 * reports what was actually recorded.
 */
export function recordedCondition(ctx: Opencode1TestContext) {
  const waiters = new Set<{ holds: () => boolean; open: () => void }>()
  return {
    changed() {
      for (const waiter of [...waiters])
        if (waiter.holds()) {
          waiters.delete(waiter)
          waiter.open()
        }
    },
    until(holds: () => boolean): Promise<void> {
      if (holds()) return Promise.resolve()
      const gate = getBodyLifetime(ctx).gate()
      waiters.add({ holds, open: gate.open })
      return gate.wait
    },
  }
}

/**
 * Paces a helper that re-reads state until it matches. `notify` wakes the
 * current wait (an event source calls it after each write that may matter).
 * Without an event source, pass `pauseMs` and each wait is that short pause.
 * There is no attempt count or deadline: the helper keeps reading until its
 * state arrives or the test ends, so the test's own timeout is the only
 * limit. Teardown ends the wait, so a test whose state never arrives fails on
 * its own mismatch error instead of hanging.
 */
export function untilStateOrTestEnd(
  ctx: Opencode1TestContext,
  pauseMs?: number,
) {
  // A body that outlived its test has no lifetime left: make one final check.
  const ended = ctx.testLifetime?.gate() ?? {
    wait: Promise.resolve(),
    open() {},
  }
  let over = false
  void ended.wait.then(() => {
    over = true
  })
  // The first wait returns at once so the caller reads the current state.
  // With an event source, a write landing between reads is never missed.
  let changed = true
  let wake: (() => void) | undefined
  return {
    /** True once the test has ended; the caller makes its final check. */
    get ended() {
      return over
    },
    notify() {
      changed = true
      wake?.()
    },
    async next(): Promise<void> {
      if (!changed && !over)
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve
          }),
          ...(pauseMs === undefined ? [] : [Bun.sleep(pauseMs)]),
          ended.wait,
        ])
      wake = undefined
      changed = false
    },
    close() {
      ended.open()
    },
  }
}

export function syncSidebarWriteHooks(
  ctx: Opencode1TestContext,
  stateFile: string,
) {
  const own = ctx.testSidebarWriteHooks.get(stateFile)
  const listeners = ctx.sidebarWriteListeners.get(stateFile)
  if (!listeners?.size) {
    installSidebarStateWriteHooks(own ?? null, stateFile)
    return
  }
  installSidebarStateWriteHooks(
    {
      ...own,
      afterRename: async (file) => {
        try {
          await own?.afterRename?.(file)
        } finally {
          for (const listener of [...listeners]) listener()
        }
      },
    },
    stateFile,
  )
}

/** Sidebar-state's test hook setter, keeping any helper's write listener. */
export function setSidebarWriteTestHooks(
  ctx: Opencode1TestContext,
  hooks: SidebarWriteHooks | null,
  stateFile = getSidebarStateFile(),
) {
  if (hooks) ctx.testSidebarWriteHooks.set(stateFile, hooks)
  else ctx.testSidebarWriteHooks.delete(stateFile)
  syncSidebarWriteHooks(ctx, stateFile)
}

/** Call `listener` after each completed write of `stateFile`; returns removal. */
export function onSidebarWrite(
  ctx: Opencode1TestContext,
  stateFile: string,
  listener: () => void,
) {
  let listeners = ctx.sidebarWriteListeners.get(stateFile)
  if (!listeners) {
    listeners = new Set()
    ctx.sidebarWriteListeners.set(stateFile, listeners)
  }
  listeners.add(listener)
  syncSidebarWriteHooks(ctx, stateFile)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) ctx.sidebarWriteListeners.delete(stateFile)
    syncSidebarWriteHooks(ctx, stateFile)
  }
}

/**
 * A provider response the test releases when it chooses. If the test ends
 * first, teardown rejects it with an AbortError, so plugin work waiting on
 * this response settles before the plugin is disposed and its files removed.
 */
export function heldResponse(ctx: Opencode1TestContext) {
  const released = getBodyLifetime(ctx).gate()
  let response: Response | undefined
  const held = released.wait.then(
    () =>
      response ??
      Promise.reject(
        new DOMException(
          'The test ended before releasing this response',
          'AbortError',
        ),
      ),
  )
  // A test that fails before its mock hands this response to the plugin
  // must not also report the teardown rejection as an unhandled error.
  held.catch(() => {})
  return {
    response: held,
    release(value: Response) {
      response = value
      released.open()
    },
  }
}

export async function withDeadlockGuard<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = timers.setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) timers.clearTimeout(timeout)
  }
}

/**
 * Common outer fixture hooks. The lifetime is created before describe-level
 * hooks run, so a pool migrated in a hook and one migrated in the body share
 * it. Teardown waits for the whole body and registered work, disposes the
 * plugins it created, then removes the directories it migrated.
 */
export function installOpencode1TestHooks(ctx: Opencode1TestContext) {
  beforeEach(() => {
    installDefaultFetchMock()
    const lifetime = new TestLifetime()
    ctx.testLifetime = lifetime
    const savedEnv = new Map(
      nativeEnvKeys.map((key) => [key, process.env[key]] as const),
    )
    // Registered first, so it runs before any migrated directory is removed:
    // plugins stop and pending sidebar writes land while their files exist.
    lifetime.deferCleanup(async () => {
      const plugins = [...ctx.livePlugins]
      ctx.livePlugins.clear()
      const results = await Promise.allSettled(
        plugins.map((plugin) =>
          Promise.resolve().then(() => plugin.dispose?.()),
        ),
      )
      try {
        await drainSidebarWrites()
      } finally {
        ctx.migratedPool = undefined
        ctx.poolLogins.length = 0
        ctx.successorAccess.clear()
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
      const failed = results.filter((result) => result.status === 'rejected')
      if (failed.length)
        throw new AggregateError(
          failed.map((result) => result.reason),
          'Plugin disposal failed',
        )
    })
  })

  afterEach(async () => {
    const lifetime = ctx.testLifetime
    ctx.testLifetime = undefined
    try {
      await lifetime?.finish()
    } finally {
      await cleanupTempConfigDirs(ctx)
    }
  })

  afterAll(async () => {
    await cleanupTempConfigDirs(ctx)
    await Bun.sleep(100)
    await cleanupTempConfigDirs(ctx)
    await Promise.all(
      [...ctx.allTempConfigDirs].map((directory) =>
        rm(directory, { recursive: true, force: true }).catch(() => {}),
      ),
    )
    ctx.allTempConfigDirs.clear()
  })

  beforeEach(() => {
    resetClaudeCodeIdentityCachesForTest()
  })
}
