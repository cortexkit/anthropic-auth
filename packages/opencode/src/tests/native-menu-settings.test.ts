import { expect } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  createNativeAccountRuntime,
  type LogTestRecord,
  type NativePoolPaths,
  type ProviderAccountUuid,
  resetClaudeCodeIdentityCachesForTest,
} from '@cortexkit/anthropic-auth-core'
import type { CommandApplyResult } from '@cortexkit/common-auth/commands'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { createRpcClient } from '../rpc/rpc-client.ts'
import { getRpcDir } from '../rpc/rpc-dir.ts'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'

// The unified /claude menu's cache actions must store the same settings the
// standalone cache commands did, not just report the same effect: turning the
// cache on records its strategy, and an always-on keep-warm schedule has no
// hour window. These tests apply menu actions to the real plugin over its
// menu IPC and read the pool config file the settings are stored in.

const { test, deferCleanup, trackDetached } = createTestLifetimeSuite()

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
const mainIdentity = '11111111-1111-4111-8111-111111111111'
const sessionId = 'synthetic-session'
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
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'CLAUDE_CONFIG_DIR',
] as const

const nativeLocal = {
  resolveIdentity: async () => ({
    deviceId: 'synthetic-device',
    sessionId: 'synthetic-session',
    accountUuid: mainIdentity as ProviderAccountUuid,
  }),
  refreshToken: async () => {
    throw new Error('Menu settings tests never refresh a credential')
  },
}

/**
 * Migrate a local native pool, store `settings` in it, then start the plugin.
 * Cleanups run in registration order, so the plugin is disposed and process
 * state restored before the fixture removes its root.
 */
async function start(settings: Record<string, unknown>) {
  const savedFetch = globalThis.fetch
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const logs: LogTestRecord[] = []
  const plugins: PluginHooks[] = []
  deferCleanup(async () => {
    try {
      for (const plugin of plugins.splice(0)) await plugin.dispose?.()
    } finally {
      __setLogTestSink(null)
      globalThis.fetch = savedFetch
      for (const key of envKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  const root = await mkdtemp(join(tmpdir(), 'oc-menu-settings-'))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: { deferCleanup, trackDetached },
    legacyConfig: { version: 1, accounts: [] },
    hostAuth: {
      anthropic: {
        type: 'oauth',
        access: 'synthetic-main-access',
        refresh: 'synthetic-main-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
    },
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  // These tests are about settings; the menu's profile display is covered
  // separately and would otherwise need a profile endpoint.
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  delete process.env.OPENCODE_AUTH_CONTENT
  resetClaudeCodeIdentityCachesForTest()
  const seeding = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
    local: nativeLocal,
  })
  try {
    await seeding.updateSettings((current) => ({ ...current, ...settings }))
  } finally {
    seeding.close()
  }
  const unexpected: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      // The menu IPC client talks to the plugin over loopback.
      if (url.hostname === '127.0.0.1') return savedFetch(input, init)
      unexpected.push(url.href)
      return new Response('not found', { status: 404 })
    },
    { preconnect: savedFetch.preconnect },
  )
  __setLogTestSink((record) => {
    logs.push(record)
  })
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: async () => new Response(null, { status: 204 }),
      }),
      project: {
        id: 'native-menu-settings',
        worktree: fixture.root,
        time: { created: Date.now() },
      },
      directory: fixture.root,
      worktree: fixture.root,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    {
      scopedRosterPollIntervalMs: 0,
      cacheKeepAggregateRefreshIntervalMs: 0,
      nativeLocal,
    },
  )
  trackDetached(creation)
  plugins.push(await creation)
  const client = createRpcClient(getRpcDir(fixture.root), process.pid)
  return {
    paths: fixture.paths,
    logs,
    unexpected,
    apply(actionId: string): Promise<CommandApplyResult> {
      return client.applyMenu({
        command: 'claude',
        sectionId: 'Cache',
        actionId,
        sessionId,
      })
    },
  }
}

/** The settings stored in the pool config file. */
async function storedSettings(paths: NativePoolPaths) {
  const config: unknown = JSON.parse(await readFile(paths.config, 'utf8'))
  if (!config || typeof config !== 'object')
    throw new Error('Pool config is not an object')
  return config as Record<string, unknown>
}

function commandLogs(logs: LogTestRecord[]) {
  return logs
    .filter((record) => record.channel === 'commands')
    .map(({ level, message, payload }) => ({ level, message, payload }))
}

const unrelated = {
  dump: { enabled: true },
  claudeFast: { enabled: true },
  routing: { mode: 'round-robin' },
  logging: { level: 'info' },
}

test('cache-on stores the explicit strategy when none was stored', async () => {
  const s = await start({ ...unrelated, claudeCache: { enabled: false } })
  const result = await s.apply('cache-on')
  expect(result.ok).toBe(true)
  const stored = await storedSettings(s.paths)
  expect(stored.claudeCache).toEqual({ enabled: true, mode: 'explicit' })
  expect(stored).toMatchObject(unrelated)
  expect(commandLogs(s.logs)).toEqual([
    {
      level: 'info',
      message: 'cache enabled changed',
      payload: { enabled: true },
    },
  ])
  expect(s.unexpected).toEqual([])
})

test('cache-on and cache-off keep a strategy that was already stored', async () => {
  const s = await start({
    ...unrelated,
    claudeCache: { enabled: false, mode: 'hybrid' },
  })
  expect((await s.apply('cache-on')).ok).toBe(true)
  expect((await storedSettings(s.paths)).claudeCache).toEqual({
    enabled: true,
    mode: 'hybrid',
  })
  expect((await s.apply('cache-off')).ok).toBe(true)
  const stored = await storedSettings(s.paths)
  expect(stored.claudeCache).toEqual({ enabled: false, mode: 'hybrid' })
  expect(stored).toMatchObject(unrelated)
})

test('cachekeep-always removes the stored hour window and keeps other keep-warm settings', async () => {
  const s = await start({
    ...unrelated,
    cacheKeep: {
      enabled: false,
      always: false,
      startHour: 9,
      endHour: 17,
      subagents: true,
    },
  })
  const result = await s.apply('cachekeep-always')
  expect(result.ok).toBe(true)
  const stored = await storedSettings(s.paths)
  expect(stored.cacheKeep).toEqual({
    enabled: true,
    always: true,
    subagents: true,
  })
  expect(stored).toMatchObject(unrelated)
  expect(commandLogs(s.logs)).toEqual([
    {
      level: 'info',
      message: 'cachekeep schedule changed',
      payload: { schedule: 'always' },
    },
  ])
  expect(s.unexpected).toEqual([])
})
