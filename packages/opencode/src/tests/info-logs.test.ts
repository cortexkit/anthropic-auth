import { describe, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  createNativeAccountRuntime,
  type LogTestRecord,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { discoverPortFile } from '../rpc/port-file'
import { getRpcDir } from '../rpc/rpc-dir'
import { drainSidebarWrites } from '../sidebar-state.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'
import { installDefaultFetchMock } from './test-fetch'
import {
  createTimerTracking,
  type PluginTimerOverrides,
} from './timer-tracking'

function createFallbackStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: [401, 403, 429],
    refresh: {
      enabled: true,
      intervalMinutes: 10,
      refreshBeforeExpiryMinutes: 30,
    },
    quota: {
      enabled: true,
      checkIntervalMinutes: 5,
      minimumRemaining: { five_hour: 10, seven_day: 20 },
      failClosedOnUnknownQuota: true,
    },
    accounts: [],
  }
}

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test
// Captured before any test replaces fetch. The test preload still refuses
// non-loopback hosts; this is used only to call the plugin's local RPC server.
const loopbackFetch = globalThis.fetch
const timerTracking = createTimerTracking()
const {
  activeIntervals,
  disabledPluginTimerOverrides,
  trackedClearInterval,
  trackedSetInterval,
} = timerTracking
const sessionId = 'ses_test'

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
      id: 'info-logs-fixture',
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

let capturedRecords: LogTestRecord[] = []

/**
 * Migrate the synthetic legacy settings into a fresh native pool through the
 * real offline migration, point this process at it, and start one plugin for
 * a project directory. Settings change only through the single /claude menu,
 * whose actions OpenCode's TUI sends to the plugin's local RPC server; this
 * harness sends the same requests.
 *
 * Lifetime cleanups run in registration order, and the fixture registers the
 * removal of its root when it is called. Registering the teardown below first
 * means every plugin and its RPC server are stopped, interval handles are
 * checked, and queued sidebar writes have finished before any fixture file
 * is deleted.
 */
async function migratedClaude() {
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
      __setLogTestSink(null)
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
  const root = await mkdtemp(join(tmpdir(), 'anthropic-info-logs-test-'))
  // migrateNativeOpencodeFixture schedules removal of the directory only after
  // it accepts it. Remove it here too, so a directory it refused is not left
  // behind in the temp folder.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: { ...createFallbackStorage() },
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  // Startup otherwise fetches each OAuth account's profile in the background
  // without awaiting it. That request is unrelated to these tests and could
  // still be running when the temporary files are removed.
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  delete process.env.OPENCODE_AUTH_CONTENT
  // The legacy config the migration retired must never become a settings
  // destination again; each change is read back through the native runtime.
  const readLegacyConfig = () =>
    readFile(fixture.paths.legacyConfig, 'utf8').catch(() => undefined)
  const legacyConfig = await readLegacyConfig()
  const directory = fixture.root

  async function getPlugin(timerOverrides?: PluginTimerOverrides) {
    const creation = AnthropicAuthPlugin(hostContext(directory), {
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

  // Construct before installing the sink so only command logs are captured.
  const plugin = await getPlugin()
  capturedRecords = []
  __setLogTestSink((record) => {
    capturedRecords.push(record)
  })

  return {
    plugin,
    getPlugin,
    /** Open /claude the way OpenCode runs the slash command; it renders every section's status. */
    async open(): Promise<void> {
      const execute = plugin['command.execute.before']
      if (!execute) throw new Error('Plugin did not install its command hook')
      await expect(
        execute(
          { command: 'claude', arguments: '', sessionID: sessionId },
          { parts: [] },
        ),
      ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    },
    /** Run one /claude menu action through the plugin's RPC server, as the TUI does. */
    async apply(
      sectionId: string,
      actionId: string,
      values?: Record<string, string | number>,
    ): Promise<void> {
      const entry = await discoverPortFile(getRpcDir(directory))
      if (!entry) throw new Error('Plugin RPC server is not running')
      const response = await loopbackFetch(
        `http://127.0.0.1:${entry.port}/rpc/apply-menu`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${entry.token}`,
          },
          body: JSON.stringify({
            command: 'claude',
            sectionId,
            actionId,
            ...(values && { values }),
            sessionId,
          }),
        },
      )
      expect(response.status).toBe(200)
      const result: unknown = await response.json()
      expect(result).toMatchObject({ command: 'claude', ok: true })
    },
    /** Persisted settings, read back through the public native runtime. */
    async settings(): Promise<AccountStorage> {
      expect(await readLegacyConfig()).toBe(legacyConfig)
      const runtime = createNativeAccountRuntime({
        paths: fixture.paths,
        host: 'opencode',
      })
      try {
        return (await runtime.read()).policyStorage
      } finally {
        runtime.close()
      }
    },
  }
}

test('does not retain a background interval unless the helper opts in', async () => {
  const claude = await migratedClaude()
  // The helper supplies an interval mock that starts no timer. Construction
  // schedules only the fallback-account refresh, so the mock is called once
  // while the tracked set of active intervals remains empty.
  expect(timerTracking.disabledIntervalCalls).toBe(1)
  expect(activeIntervals.size).toBe(0)

  await timerTracking.withTrackedInterval(async () => {
    await claude.getPlugin({
      setInterval: trackedSetInterval,
      clearInterval: trackedClearInterval,
    })
    expect(activeIntervals.size).toBe(1)
  })
  expect(activeIntervals.size).toBe(0)
})

function findCommandsLog(message: string): LogTestRecord | undefined {
  return capturedRecords.find(
    (r) =>
      r.level === 'info' && r.channel === 'commands' && r.message === message,
  )
}

describe('setting-change INFO logs', () => {
  // -- dump ----------------------------------------------------------------

  test('dump on emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Diagnostics', 'dump-on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('dump changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await claude.settings()
    expect(raw.dump?.enabled).toBe(true)
  })

  test('dump off emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Diagnostics', 'dump-off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('dump changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
    const raw = await claude.settings()
    expect(raw.dump?.enabled).toBe(false)
  })

  test('dump status emits no setting-change info log', async () => {
    const claude = await migratedClaude()
    await claude.open()
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  // -- fast mode -----------------------------------------------------------

  test('fast on emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Extras', 'fast-on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('fast mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await claude.settings()
    expect(raw.claudeFast?.enabled).toBe(true)
  })

  test('fast off emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Extras', 'fast-off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('fast mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  // -- routing -------------------------------------------------------------

  test('routing mode change emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Routing', 'routing-mode', { mode: 'fallback-first' })
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('routing mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ mode: 'fallback-first' })
    const raw = await claude.settings()
    expect(raw.routing?.mode).toBe('fallback-first')
  })

  test('routing status emits no setting-change info log', async () => {
    const claude = await migratedClaude()
    await claude.open()
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  // -- cache 1h ------------------------------------------------------------

  test('cache on emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Cache', 'cache-on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cache enabled changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await claude.settings()
    expect(raw.claudeCache?.enabled).toBe(true)
  })

  test('cache mode change emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Cache', 'cache-mode', { mode: 'hybrid' })
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cache mode changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ mode: 'hybrid' })
    const raw = await claude.settings()
    expect(raw.claudeCache?.mode).toBe('hybrid')
  })

  // -- killswitch ----------------------------------------------------------

  test('killswitch on emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Limits', 'killswitch-on')
    const rec = findCommandsLog('killswitch changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await claude.settings()
    expect(raw.killswitch?.enabled).toBe(true)
  })

  test('killswitch off emits info log after on', async () => {
    const claude = await migratedClaude()
    // Turn on first so off is a genuine change
    await claude.apply('Limits', 'killswitch-on')
    capturedRecords = []
    await claude.apply('Limits', 'killswitch-off')
    const rec = findCommandsLog('killswitch changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  test('killswitch set emits thresholds info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Limits', 'killswitch-set', {
      entries: JSON.stringify([{ account: 'main', fh: 3, sd: 8 }]),
    })
    const rec = findCommandsLog('killswitch thresholds changed')
    expect(rec).toBeDefined()
    expect(rec!.payload?.thresholds).toEqual({ five_hour: 3, seven_day: 8 })
    const raw = await claude.settings()
    expect(raw.killswitch?.enabled).toBe(true)
    expect(raw.killswitch?.main?.five_hour).toBe(3)
    expect(raw.killswitch?.main?.seven_day).toBe(8)
  })

  test('killswitch status emits no setting-change info log', async () => {
    const claude = await migratedClaude()
    await claude.open()
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  // -- cachekeep -----------------------------------------------------------

  test('cachekeep window emits info log', async () => {
    const claude = await migratedClaude()
    await claude.apply('Cache', 'cachekeep-window', {
      startHour: 9,
      endHour: 17,
    })
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cachekeep schedule changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ schedule: '9-17' })
  })

  test('cachekeep always emits info log', async () => {
    const claude = await migratedClaude()
    await claude.apply('Cache', 'cachekeep-always')
    const rec = findCommandsLog('cachekeep schedule changed')
    expect(rec?.payload).toEqual({ schedule: 'always' })
  })

  test('cachekeep off emits info log', async () => {
    const claude = await migratedClaude()
    await claude.apply('Cache', 'cachekeep-off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cachekeep enabled changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  test('cachekeep subagents emits info log', async () => {
    const claude = await migratedClaude()
    await claude.apply('Cache', 'cachekeep-subagents', { enabled: 'on' })
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('cachekeep subagents changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ subagents: true })
  })

  // -- logging --------------------------------------------------------------

  test('logging level change emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Diagnostics', 'logging-level', { level: 'debug' })
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('log level changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ level: 'debug' })
    const raw = await claude.settings()
    expect(raw.logging?.level).toBe('debug')
  })

  test('logging status emits no setting-change info log', async () => {
    const claude = await migratedClaude()
    await claude.open()
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  test('logging trace level persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Diagnostics', 'logging-level', { level: 'trace' })
    const raw = await claude.settings()
    expect(raw.logging?.level).toBe('trace')
  })

  test('logging getLogLevel reflects persisted level after command', async () => {
    const claude = await migratedClaude()
    await claude.apply('Diagnostics', 'logging-level', { level: 'warn' })
    const { getLogLevel: _getLogLevel } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(_getLogLevel()).toBe('warn')
  })

  // -- payload hygiene -----------------------------------------------------

  test('INFO log payload does not contain tokens or bearer strings', async () => {
    const claude = await migratedClaude()
    capturedRecords = []
    await claude.apply('Diagnostics', 'dump-on')
    const recs = capturedRecords.filter(
      (r) => r.level === 'info' && r.channel === 'commands',
    )
    for (const rec of recs) {
      const payload = rec.payload ?? {}
      for (const val of Object.values(payload)) {
        if (typeof val === 'string') {
          expect(val).not.toMatch(/^(Bearer |sk-|eyJ)/)
        }
      }
    }
  })

  // -- quota priming settings ----------------------------------------------

  test('prime on emits info log and persists', async () => {
    const claude = await migratedClaude()
    await claude.apply('Extras', 'prime-on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('prime changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: true })
    const raw = await claude.settings()
    expect(raw.prime?.enabled).toBe(true)
  })

  test('prime off after on emits info log', async () => {
    const claude = await migratedClaude()
    // Turn on first so off is a genuine change
    await claude.apply('Extras', 'prime-on')
    capturedRecords = []
    await claude.apply('Extras', 'prime-off')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(1)
    const rec = findCommandsLog('prime changed')
    expect(rec).toBeDefined()
    expect(rec!.payload).toEqual({ enabled: false })
  })

  test('prime status emits no setting-change info log', async () => {
    const claude = await migratedClaude()
    await claude.open()
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })

  test('repeated prime on emits only one setting-change log', async () => {
    const claude = await migratedClaude()
    await claude.apply('Extras', 'prime-on')
    capturedRecords = []
    await claude.apply('Extras', 'prime-on')
    expect(
      capturedRecords.filter((r) => r.channel === 'commands'),
    ).toHaveLength(0)
  })
})
