import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  CacheKeepManager,
  custodyTombstoneOAuth,
  PrimeManager,
  type PrimeManagerOptions,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import {
  createOpencodeClient,
  type OAuth,
  type Provider,
} from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { adoptPrimeManager } from '../prime-manager-registry.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'
import { installDefaultFetchMock } from './test-fetch'
import {
  createTimerTracking,
  type PluginTimerOverrides,
} from './timer-tracking'

const lifetimes = createTestLifetimeSuite()

const timerTracking = createTimerTracking()
const { activeIntervals, disabledPluginTimerOverrides } = timerTracking

// Saved before each test and restored after it: every path variable that
// migrateNativeOpencodeFixture returns in its env, plus the profile-hydration
// switch and OPENCODE_AUTH_CONTENT, which this file sets or clears.
const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'CLAUDE_CONFIG_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
] as const

const provider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}

function baseStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    accounts: [],
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: { five_hour: 10, seven_day: 20 },
      failClosedOnUnknownQuota: true,
    },
  }
}

// The OpenCode OAuth entry the offline migration moves into the native pool.
// Its expiry is far away, so nothing in these tests needs to refresh it.
function syntheticHostAuth() {
  return {
    anthropic: {
      type: 'oauth',
      access: 'synthetic-dispose-main-access',
      refresh: 'synthetic-dispose-main-refresh',
      expires: Date.now() + 8 * 60 * 60_000,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The anthropic OAuth entry stored in OpenCode's auth file, checked field by field. */
function storedAnthropicOAuth(text: string): OAuth {
  const stored: unknown = JSON.parse(text)
  const entry = isRecord(stored) ? stored.anthropic : undefined
  if (
    !isRecord(entry) ||
    entry.type !== 'oauth' ||
    typeof entry.access !== 'string' ||
    typeof entry.refresh !== 'string' ||
    typeof entry.expires !== 'number'
  )
    throw new Error('OpenCode auth file has no anthropic OAuth entry')
  return {
    type: 'oauth',
    access: entry.access,
    refresh: entry.refresh,
    expires: entry.expires,
  }
}

/**
 * The context OpenCode passes a server plugin, with a real SDK client. The
 * client's HTTP transport is answered in this process: message history is
 * empty and prompts are accepted, so nothing leaves the test.
 */
function hostContext(directory: string): PluginInput {
  const client = createOpencodeClient({
    baseUrl: 'http://opencode.invalid',
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      if (request.method === 'GET' && /^\/session\/[^/]+\/message$/.test(path))
        return Response.json([])
      if (
        request.method === 'POST' &&
        /^\/session\/[^/]+\/prompt_async$/.test(path)
      )
        return new Response(null, { status: 204 })
      return Response.json({ name: 'NotFound' }, { status: 404 })
    },
  })
  return {
    client,
    project: {
      id: 'dispose-cleanup-fixture',
      worktree: directory,
      time: { created: Date.now() },
    },
    directory,
    worktree: directory,
    serverUrl: new URL('http://opencode.invalid'),
    experimental_workspace: { register() {} },
    $,
  }
}

/** Plugin construction starts a fallback-account refresh and exposes its promise for tests. */
function fallbackRefreshReady(hooks: Hooks): Promise<unknown> {
  const ready =
    '__fallbackRefreshReady' in hooks ? hooks.__fallbackRefreshReady : undefined
  if (!(ready instanceof Promise))
    throw new Error('Plugin did not expose its startup fallback refresh')
  return ready
}

/**
 * Migrate synthetic legacy accounts into a fresh native pool through the real
 * offline migration and point this process at it, so the plugin starts with
 * native services the way a migrated installation does.
 *
 * Lifetime cleanups run in registration order, and the fixture registers the
 * removal of its root when it is called. Registering the teardown below first
 * means every plugin is disposed, its interval handles are checked, and every
 * queued sidebar write has finished before any fixture file is deleted.
 */
async function migratedPool(options: { hostAuth?: Record<string, unknown> }) {
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const savedFetch = globalThis.fetch
  const plugins = new Set<Hooks>()
  lifetimes.deferCleanup(async () => {
    const results = await Promise.allSettled(
      [...plugins]
        .reverse()
        .map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
    )
    plugins.clear()
    try {
      await drainSidebarWrites()
      // Background intervals must not outlive the test-scoped fetch mock
      // they captured.
      expect(activeIntervals.size).toBe(0)
    } finally {
      timerTracking.reset()
      globalThis.fetch = savedFetch
      for (const key of envKeys) {
        const value = savedEnv.get(key)
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
  timerTracking.reset()
  installDefaultFetchMock()
  const root = await mkdtemp(join(tmpdir(), 'anthropic-dispose-test-'))
  // migrateNativeOpencodeFixture schedules removal of the directory only after
  // it accepts it. Remove it here too, so a directory it refused is not left
  // behind in the temp folder.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: { ...baseStorage() },
    ...(options.hostAuth && { hostAuth: options.hostAuth }),
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  // Startup otherwise fetches each OAuth account's profile in the background
  // without awaiting it. That request is unrelated to these tests and could
  // still be running when the temporary files are removed.
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  delete process.env.OPENCODE_AUTH_CONTENT

  async function getPlugin(timerOverrides?: PluginTimerOverrides) {
    const creation = AnthropicAuthPlugin(hostContext(fixture.root), {
      ...disabledPluginTimerOverrides(),
      ...timerOverrides,
    })
    lifetimes.trackDetached(creation)
    const plugin = await creation
    plugins.add(plugin)
    // Plugin construction starts a background refresh of fallback accounts
    // without awaiting it. Track that promise so teardown waits for it before
    // deleting the files.
    lifetimes.trackDetached(fallbackRefreshReady(plugin))
    return plugin
  }

  async function dispose(plugin: Hooks) {
    plugins.delete(plugin)
    await plugin.dispose?.()
  }

  return { fixture, getPlugin, dispose }
}

describe('dispose stops per-instance background services', () => {
  // The plugin starts the fallback-account refresh interval after loading the
  // shared native account pool. Injected timer functions let this test verify
  // that dispose clears the same interval handle.
  lifetimes.test(
    'dispose clears the native fallback refresh interval it started',
    async () => {
      const pool = await migratedPool({})

      // With the disabled interval mock, count the intervals this instance
      // schedules. The default overrides from timer-tracking disable
      // CacheKeep's aggregate refresh, so the fallback-account refresh is the
      // only interval started here.
      const counted = await pool.getPlugin()
      expect(timerTracking.disabledIntervalCalls).toBe(1)
      await pool.dispose(counted)
      // Disposing must not schedule any additional intervals for this instance.
      expect(timerTracking.disabledIntervalCalls).toBe(1)

      // With real tracked intervals, the handle construction created is the
      // one dispose clears. The tracked clear removes only handles passed to it.
      const tracked = await pool.getPlugin({
        setInterval: timerTracking.trackedSetInterval,
        clearInterval: timerTracking.trackedClearInterval,
      })
      expect(activeIntervals.size).toBe(1)
      const [fallbackRefresh] = activeIntervals
      if (fallbackRefresh === undefined)
        throw new Error('Plugin started no tracked interval')
      // Nothing has cleared the construction interval before dispose.
      expect(activeIntervals.has(fallbackRefresh)).toBe(true)

      await pool.dispose(tracked)

      expect(activeIntervals.has(fallbackRefresh)).toBe(false)
      expect(activeIntervals.size).toBe(0)
    },
  )

  lifetimes.test('dispose calls cacheKeepManager.stop', async () => {
    const pool = await migratedPool({})
    // Spy on the shared prototype for this body only. It calls through, so
    // dispose still runs the real CacheKeep teardown.
    const originalCacheKeepStop = CacheKeepManager.prototype.stop
    const stopped: CacheKeepManager[] = []
    let stopCalls = 0
    CacheKeepManager.prototype.stop = function (this: CacheKeepManager) {
      stopCalls++
      stopped.push(this)
      return originalCacheKeepStop.call(this)
    }
    try {
      const plugin = await pool.getPlugin()
      const own =
        '__cacheKeepManager' in plugin ? plugin.__cacheKeepManager : undefined
      if (!(own instanceof CacheKeepManager))
        throw new Error('Plugin did not expose its CacheKeep manager')
      stopCalls = 0
      stopped.length = 0

      await pool.dispose(plugin)

      expect(stopCalls).toBe(1)
      // The CacheKeep manager stopped is the one attached to this plugin, not
      // a manager belonging to another plugin instance.
      expect(stopped).toHaveLength(1)
      expect(stopped[0]).toBe(own)
    } finally {
      CacheKeepManager.prototype.stop = originalCacheKeepStop
    }
  })

  lifetimes.test(
    'dispose clears tracked fallback and main refresh intervals',
    async () => {
      const pool = await migratedPool({ hostAuth: syntheticHostAuth() })
      const plugin = await pool.getPlugin({
        setInterval: timerTracking.trackedSetInterval,
        clearInterval: timerTracking.trackedClearInterval,
      })
      expect(activeIntervals.size).toBe(1)

      // Offline migration replaces OpenCode's OAuth credentials with a
      // non-secret activation marker. Pass that stored marker to the loader,
      // not the retired tokens.
      const activation = storedAnthropicOAuth(
        await readFile(pool.fixture.hostAuthPath, 'utf8'),
      )
      expect(activation).toEqual(custodyTombstoneOAuth('anthropic'))
      const loader = plugin.auth?.loader
      if (!loader) throw new Error('Plugin did not install its auth loader')
      const options = await loader(() => Promise.resolve(activation), provider)
      expect(options.fetch).toBeFunction()

      // The loader adds a second interval, the main account's OAuth refresh,
      // beside the fallback-account refresh started during construction.
      expect(activeIntervals.size).toBe(2)

      await pool.dispose(plugin)

      expect(activeIntervals.size).toBe(0)
    },
  )
})

describe('prime manager adoption leases', () => {
  const storageOptions = (path: string): PrimeManagerOptions => ({
    storagePath: path,
    getAccountFingerprint: async () => '0123456789abcdef',
    loadStorage: async () => null,
    refreshQuota: async () => ({
      quota: {
        usedPercent: 0,
        remainingPercent: 100,
        checkedAt: Date.now(),
      },
      fresh: true,
    }),
    sendPrime: async () => ({ ok: true, status: 200, ms: 1 }),
    recordSuccess: async () => ({
      count: 1,
      inputTokens: 0,
      outputTokens: 0,
      since: Date.now(),
    }),
  })

  test('releasing one of two slots keeps the shared manager alive for the sibling', () => {
    const path = join(
      tmpdir(),
      `prime-shared-${Date.now()}-${Math.random()}.json`,
    )
    const first = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-a', rebind: () => {} },
    )
    const second = adoptPrimeManager(
      path,
      () => {
        throw new Error('same-path adoption should not construct a duplicate')
      },
      { slot: 'slot-b', rebind: () => {} },
    )
    expect(second.manager).toBe(first.manager)
    first.manager.start()

    first.release()

    expect(first.manager.isStopped()).toBe(false)
    second.release()
    expect(first.manager.isStopped()).toBe(true)
  })

  test('releasing the last slot evicts and stops the manager', () => {
    const path = join(
      tmpdir(),
      `prime-last-slot-${Date.now()}-${Math.random()}.json`,
    )
    const adoption = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-solo', rebind: () => {} },
    )
    adoption.manager.start()

    adoption.release()

    expect(adoption.manager.isStopped()).toBe(true)
    let constructed = 0
    const replacement = adoptPrimeManager(
      path,
      () => {
        constructed += 1
        return new PrimeManager(storageOptions(path))
      },
      { slot: 'slot-solo', rebind: () => {} },
    )
    expect(constructed).toBe(1)
    replacement.release()
  })

  test('releasing a lease twice is a no-op', () => {
    const path = join(
      tmpdir(),
      `prime-idempotent-${Date.now()}-${Math.random()}.json`,
    )
    const adoption = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'slot-known', rebind: () => {} },
    )
    adoption.manager.start()

    adoption.release()
    expect(() => adoption.release()).not.toThrow()
    expect(adoption.manager.isStopped()).toBe(true)
  })

  test('a late release cannot clobber a same-path successor lease', () => {
    const path = join(
      tmpdir(),
      `prime-same-path-${Date.now()}-${Math.random()}.json`,
    )
    const predecessor = adoptPrimeManager(
      path,
      () => new PrimeManager(storageOptions(path)),
      { slot: 'D', rebind: () => {} },
    )
    predecessor.manager.start()
    const successor = adoptPrimeManager(
      path,
      () => {
        throw new Error('same-path adoption should not construct a duplicate')
      },
      { slot: 'D', rebind: () => {} },
    )

    predecessor.release()

    expect(successor.manager.isStopped()).toBe(false)
    successor.release()
    expect(successor.manager.isStopped()).toBe(true)
  })

  test('a late release cannot clobber a different-path successor lease', () => {
    const pathX = join(
      tmpdir(),
      `prime-late-x-${Date.now()}-${Math.random()}.json`,
    )
    const pathY = join(
      tmpdir(),
      `prime-late-y-${Date.now()}-${Math.random()}.json`,
    )
    const pathZ = join(
      tmpdir(),
      `prime-late-z-${Date.now()}-${Math.random()}.json`,
    )

    const initialX = adoptPrimeManager(
      pathX,
      () => new PrimeManager(storageOptions(pathX)),
      { slot: 'D', rebind: () => {} },
    )
    initialX.manager.start()
    const managerY = adoptPrimeManager(
      pathY,
      () => new PrimeManager(storageOptions(pathY)),
      { slot: 'D', rebind: () => {} },
    )
    managerY.manager.start()
    expect(initialX.manager.isStopped()).toBe(true)

    initialX.release()

    const managerZ = adoptPrimeManager(
      pathZ,
      () => new PrimeManager(storageOptions(pathZ)),
      { slot: 'D', rebind: () => {} },
    )
    managerZ.manager.start()
    expect(managerY.manager.isStopped()).toBe(true)

    let constructedUnderY = 0
    const reentryY = adoptPrimeManager(
      pathY,
      () => {
        constructedUnderY += 1
        return new PrimeManager(storageOptions(pathY))
      },
      { slot: 're-entry', rebind: () => {} },
    )
    expect(constructedUnderY).toBe(1)

    managerZ.release()
    reentryY.release()
  })
})
