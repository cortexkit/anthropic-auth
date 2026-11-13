import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  type CommandApplyRequest,
  type CommandApplyResult,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  type NativeCustodyClient,
} from '@cortexkit/anthropic-auth-core'
import type { Hooks, PluginInput } from '@opencode-ai/plugin'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { drainNotifications } from '../rpc/notifications'
import { createRpcClient } from '../rpc/rpc-client'
import { drainSidebarWrites } from '../sidebar-state'
import { migrateNativeOpencodeFixture } from './native-fixture.ts'
import { DEFAULT_FETCH_MOCK } from './test-fetch'
import {
  createTimerTracking,
  type PluginTimerOverrides,
} from './timer-tracking'

const originalFetch = globalThis.fetch
const timerTracking = createTimerTracking()
const {
  activeIntervals,
  disabledPluginTimerOverrides,
  trackedClearInterval,
  trackedSetInterval,
} = timerTracking
// Plugin tests run in a per-test lifetime: fixture roots outlive the test body
// and any work it registered, and are removed only after plugins are disposed.
const lifetimes = createTestLifetimeSuite()
// Environment variables a test sets to point the plugin at its migrated
// account pool; the test's cleanup puts back their previous values.
const nativeEnvKeys = [
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
  'OPENCODE_AUTH_CONTENT',
] as const
let envSavedForTest = false
const mainIdentity = '11111111-1111-4111-8111-111111111111'

/** The account store every add-account test starts from: a main login and no fallbacks. */
function emptyStorage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [],
  }
}

// Synthetic OpenCode auth.json: the main OAuth login that the migration moves
// into the native account pool, beside an unrelated provider it must keep.
function localHostAuth() {
  return {
    anthropic: {
      type: 'oauth',
      access: 'synthetic-main-access',
      refresh: 'synthetic-main-refresh',
      expires: Date.now() + 8 * 60 * 60_000,
    },
    other: { type: 'api', key: 'synthetic-unrelated-provider' },
  }
}

/** List the main account but refuse background quota authorization without
 * simulating an unreachable vault or handing out credential material. */
function mainOnlyVault(): NativeCustodyClient {
  return {
    async listScoped() {
      return {
        view: 'synthetic-native-view',
        rows: [
          {
            id: 'oauth:anthropic',
            accountId: mainIdentity,
            credentialType: 'oauth',
            state: 'active',
            categories: ['anthropic-native'],
            serves: ['anthropic'],
            providerIds: [],
            refreshAdapter: 'anthropic',
            recordVersion: 1,
            operations: ['read', 'invalidate'],
            createdAtMs: 1,
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped() {
      throw Object.assign(
        new Error('Synthetic vault refuses credential reads'),
        {
          code: 'grant_denied',
        },
      )
    },
    async reportAuthFailureScoped() {
      throw new Error('Add-account tests must not report vault failures')
    },
    close() {},
  }
}

/**
 * The context OpenCode passes a server plugin, with a real SDK client whose
 * HTTP transport is answered in this process: message history is empty and
 * prompts are accepted, so nothing leaves the test.
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
      id: 'add-account-flows-fixture',
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

type Migrated = Awaited<ReturnType<typeof migrateNativeOpencodeFixture>> & {
  getPlugin: (
    timerOverrides?: PluginTimerOverrides & Record<string, unknown>,
  ) => Promise<Hooks>
}

/**
 * Import the account store through the real offline migration, point this
 * process at the migrated pool, and return a plugin factory for that pool.
 * Plugins are constructed only after the migration committed, as OpenCode
 * would start them after offline setup.
 */
async function migrate(
  storage: AccountStorage = emptyStorage(),
  mode: 'local' | 'claustrum' = 'local',
): Promise<Migrated> {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-add-acct-native-'))
  const plugins: Hooks[] = []
  // A test may migrate two pools. Cleanups run in registration order, so only
  // the first migration of a test saves the environment, and its cleanup puts
  // back the values from before the test.
  const savedEnv = envSavedForTest
    ? undefined
    : new Map(nativeEnvKeys.map((key) => [key, process.env[key]] as const))
  if (savedEnv) envSavedForTest = true
  // Registered before the migration fixture takes ownership of its directory
  // (and registers that directory's removal), so this cleanup runs first:
  // plugins stop (closing their RPC servers) and pending sidebar writes land
  // before any fixture file is removed. The environment is restored even when
  // a dispose fails.
  lifetimes.deferCleanup(async () => {
    const results = await Promise.allSettled(
      plugins
        .splice(0)
        .map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
    )
    try {
      await drainSidebarWrites()
    } finally {
      if (savedEnv) {
        for (const [key, value] of savedEnv) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        envSavedForTest = false
      }
    }
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Plugin disposal failed',
      )
  })
  // A fixture that refuses the directory never registers its removal, so
  // remove it here as well.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig:
      mode === 'claustrum'
        ? {
            ...storage,
            mainAccountId: 'primary-route',
            claustrum: {
              mode: 'claustrum',
              scopedRoster: true,
              primaryAccount: {
                credentialId: 'oauth:anthropic',
                accountId: mainIdentity,
                state: 'active',
              },
            },
          }
        : { ...storage },
    hostAuth:
      mode === 'claustrum'
        ? {
            anthropic: custodyTombstoneOAuth('anthropic'),
            other: { type: 'api', key: 'synthetic-unrelated-provider' },
          }
        : localHostAuth(),
    ...(mode === 'claustrum' && {
      custody: {
        connect: async () => mainOnlyVault(),
        enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
      },
    }),
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  delete process.env.OPENCODE_AUTH_CONTENT
  return {
    ...fixture,
    async getPlugin(timerOverrides) {
      // A project directory starts the plugin's menu RPC server in the
      // fixture's RPC directory.
      const creation = AnthropicAuthPlugin(hostContext(fixture.root), {
        ...disabledPluginTimerOverrides(),
        ...timerOverrides,
      })
      lifetimes.trackDetached(creation)
      const plugin = await creation
      plugins.push(plugin)
      return plugin
    },
  }
}

/**
 * Open /claude for a TUI-connected session, then submit one Claude menu action
 * through the plugin's RPC server, the way the TUI renderer does after the
 * user picks it.
 */
async function applyMenuAction(
  fixture: Migrated,
  plugin: Hooks,
  request: Omit<CommandApplyRequest, 'command' | 'sessionId' | 'sectionId'>,
  sessionId = 'ses_test',
): Promise<CommandApplyResult> {
  // The plugin counts a session's TUI as connected only while that session
  // has recently drained its RPC notification queue, which the TUI polls as a
  // heartbeat. Draining here makes /claude queue its menu as a notification
  // for the TUI instead of replying in the chat with text.
  drainNotifications(0, sessionId)
  const execute = plugin['command.execute.before']
  if (!execute) throw new Error('Plugin did not install its command hook')
  await expect(
    execute(
      { command: 'claude', arguments: '', sessionID: sessionId },
      { parts: [] },
    ),
  ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
  const notice = drainNotifications(0, sessionId).at(-1)
  if (notice?.type !== 'open-menu')
    throw new Error('Expected the /claude menu notification')
  drainNotifications(notice.id, sessionId)
  // globalThis.fetch is currently a mock for provider (Anthropic) requests
  // that refuses loopback URLs. Send only the call to the plugin's local RPC
  // server (127.0.0.1) through the fetch captured when this file loaded,
  // which the test preload limits to loopback hosts.
  const providerFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new URL(input instanceof Request ? input.url : String(input)).hostname ===
      '127.0.0.1'
        ? originalFetch(input, init)
        : providerFetch(input, init),
    { preconnect: providerFetch.preconnect },
  )
  try {
    return await createRpcClient(
      fixture.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR,
      process.pid,
    ).applyMenu({
      command: 'claude',
      sectionId: 'Accounts',
      sessionId,
      ...request,
    })
  } finally {
    globalThis.fetch = providerFetch
  }
}

/** Return fallback accounts available when the primary account cannot serve a request. Read them from the native pool. */
async function readFallbacks(fixture: Migrated) {
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    return (await runtime.read()).accounts.filter(
      (account) => account.id !== 'main',
    )
  } finally {
    runtime.close()
  }
}

/** Return the stored API key, destination URL and auth header for the account identified by routeId. */
async function readApiCredential(fixture: Migrated, routeId: string) {
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    return await runtime.authorizeApi(routeId)
  } finally {
    runtime.close()
  }
}

/** A plugin test whose body receives a pool migrated from `emptyStorage()`. */
function pluginTest(name: string, body: (fixture: Migrated) => unknown) {
  lifetimes.test(name, async () => body(await migrate()))
}

function findCommandsLog(
  records: Array<{
    level: string
    channel: string
    message: string
    payload?: Record<string, unknown>
  }>,
  message: string,
) {
  return records.find(
    (r) =>
      r.level === 'info' && r.channel === 'commands' && r.message === message,
  )
}

function scanLogsForSecrets(
  records: Array<{
    level: string
    channel: string
    message: string
    payload?: Record<string, unknown>
  }>,
): string[] {
  const hits: string[] = []
  const patterns = [/sk-ant-/i, /Bearer\s+/i, /eyJ/, /verifier/i]
  for (const rec of records) {
    const payloadStr = JSON.stringify(rec.payload ?? {})
    for (const pat of patterns) {
      if (pat.test(payloadStr)) {
        hits.push(`record '${rec.message}' contained match for ${pat.source}`)
      }
    }
  }
  return hits
}

let capturedRecords: Array<{
  level: string
  channel: string
  message: string
  payload?: Record<string, unknown>
}> = []

beforeEach(async () => {
  timerTracking.reset()
  const { installDefaultFetchMock } = await import('./test-fetch')
  installDefaultFetchMock()
  capturedRecords = []
  const { __setLogTestSink } = await import('@cortexkit/anthropic-auth-core')
  __setLogTestSink((record) => {
    capturedRecords.push(record)
  })
})

afterEach(async () => {
  try {
    // Restore only the fixture's tagged mock; an untagged custom mock left
    // installed must reach the preload's leak detector, not be masked here.
    const currentFetch = globalThis.fetch as
      | (typeof fetch & { [DEFAULT_FETCH_MOCK]?: true })
      | undefined
    if (currentFetch?.[DEFAULT_FETCH_MOCK]) {
      globalThis.fetch = originalFetch
    }
    const { __setLogTestSink } = await import('@cortexkit/anthropic-auth-core')
    __setLogTestSink(null)
    mock.restore()
  } finally {
    // Assert last so a detected leak cannot abort the cleanup above.
    expect(activeIntervals.size).toBe(0)
  }
})

pluginTest(
  'does not retain a background interval unless the helper opts in',
  async (fixture) => {
    await fixture.getPlugin()
    expect(timerTracking.disabledIntervalCalls).toBe(1)
    expect(activeIntervals.size).toBe(0)

    let thrown: unknown
    try {
      await timerTracking.withTrackedInterval(async () => {
        await fixture.getPlugin({
          setInterval: trackedSetInterval,
          clearInterval: trackedClearInterval,
        })
        expect(activeIntervals.size).toBe(1)
        throw new Error('forced timer assertion failure')
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).toMatchObject({ message: 'forced timer assertion failure' })
    expect(activeIntervals.size).toBe(0)
  },
)

pluginTest(
  'partial timer overrides retain disabled interval defaults',
  async (fixture) => {
    await fixture.getPlugin({ clearInterval: trackedClearInterval })
    expect(timerTracking.disabledIntervalCalls).toBe(1)
    expect(activeIntervals.size).toBe(0)
  },
)

// ---------------------------------------------------------------------------
// parseAccountCommandAction — add actions (core)
// ---------------------------------------------------------------------------
describe('parseAccountCommandAction — add actions', () => {
  test('add-apikey with key only', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-apikey sk-ant-test123')).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-test123',
    })
  })

  test('add-apikey with key and label', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction('add-apikey sk-ant-test123 My Label'),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-test123',
      label: 'My Label',
    })
  })

  test('add-apikey without key falls to usage', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-apikey')).toEqual({ type: 'usage' })
  })

  test('add-oauth-start', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-oauth-start')).toEqual({
      type: 'add-oauth-start',
    })
  })

  test('add-oauth-finish with code', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction('add-oauth-finish some-auth-code'),
    ).toEqual({
      type: 'add-oauth-finish',
      code: 'some-auth-code',
    })
  })

  test('add-oauth-finish without code falls to usage', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-oauth-finish')).toEqual({
      type: 'usage',
    })
  })

  test('add-apikey with --base-url flag', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction(
        'add-apikey sk-ant-key --base-url https://api.example.com/v1',
      ),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-key',
      baseURL: 'https://api.example.com/v1',
    })
  })

  test('add-apikey with --auth-header x-api-key', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction(
        'add-apikey sk-ant-key --auth-header x-api-key',
      ),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-key',
      authHeader: 'x-api-key',
    })
  })

  test('add-apikey with all flags', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction(
        'add-apikey sk-ant-key --base-url https://api.example.com --auth-header x-api-key --label MyKey',
      ),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-key',
      baseURL: 'https://api.example.com',
      authHeader: 'x-api-key',
      label: 'MyKey',
    })
  })
})

// ---------------------------------------------------------------------------
// add-apikey — persistence + security, through the /claude menu
// ---------------------------------------------------------------------------
describe('add-apikey flow', () => {
  pluginTest('persists an API key account to the store', async (fixture) => {
    const plugin = await fixture.getPlugin()
    await applyMenuAction(fixture, plugin, {
      actionId: 'add-apikey',
      values: { apiKey: 'sk-ant-test123' },
    })

    const fallbacks = await readFallbacks(fixture)
    expect(fallbacks).toHaveLength(1)
    const account = fallbacks[0]!
    expect(account.type).toBe('api')
    const credential = await readApiCredential(fixture, account.id)
    expect(credential.apiKey).toBe('sk-ant-test123')
    expect(credential.baseURL).toBe('https://api.kie.ai/claude')
    expect(credential.authHeader).toBe('authorization-bearer')
    expect(account.enabled).toBe(true)
  })

  pluginTest('persists with a label', async (fixture) => {
    const plugin = await fixture.getPlugin()
    await applyMenuAction(fixture, plugin, {
      actionId: 'add-apikey',
      values: { apiKey: 'sk-ant-test456', label: 'Work API' },
    })

    const fallbacks = await readFallbacks(fixture)
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]!.label).toBe('Work API')
    expect(fallbacks[0]!.id).toBe('Work API')
  })

  pluginTest(
    'emits INFO log with id/label/type but NO apiKey',
    async (fixture) => {
      const plugin = await fixture.getPlugin()
      await applyMenuAction(fixture, plugin, {
        actionId: 'add-apikey',
        values: { apiKey: 'sk-ant-secret123' },
      })

      const rec = findCommandsLog(capturedRecords, 'account added')
      expect(rec).toBeDefined()
      const payload = rec!.payload!
      expect(payload.id).toBeDefined()
      expect(payload.type).toBe('apikey')

      const payloadStr = JSON.stringify(payload)
      expect(payloadStr).not.toContain('sk-ant-secret123')
      expect(payloadStr).not.toContain('apiKey')
      expect(payloadStr).not.toContain('sk-ant')
      expect(payloadStr).not.toContain('secret')
    },
  )

  pluginTest(
    'account list after add shows the new account',
    async (fixture) => {
      const plugin = await fixture.getPlugin()
      await applyMenuAction(fixture, plugin, {
        actionId: 'add-apikey',
        values: { apiKey: 'sk-ant-list', label: 'TestList' },
      })

      const { buildAccountList } = await import(
        '@cortexkit/anthropic-auth-core'
      )
      const runtime = createNativeAccountRuntime({
        paths: fixture.paths,
        host: 'opencode',
      })
      let storage: AccountStorage
      try {
        // The runtime's account-store projection, which feeds the account list.
        storage = (await runtime.read()).policyStorage
      } finally {
        runtime.close()
      }
      const list = buildAccountList(storage)
      expect(list).toHaveLength(2) // main + fallback
      const fallback = list.find((a: { role: string }) => a.role === 'fallback')
      expect(fallback).toBeDefined()
      expect(fallback!.label).toBe('TestList')
    },
  )

  pluginTest(
    'persists with custom baseURL and x-api-key authHeader',
    async (fixture) => {
      const plugin = await fixture.getPlugin()
      await applyMenuAction(fixture, plugin, {
        actionId: 'add-apikey',
        values: {
          apiKey: 'sk-ant-custom',
          baseURL: 'https://api.example.com/v1',
          authHeader: 'x-api-key',
          label: 'CustomAPI',
        },
      })

      const fallbacks = await readFallbacks(fixture)
      expect(fallbacks).toHaveLength(1)
      const account = fallbacks[0]!
      expect(account.type).toBe('api')
      const credential = await readApiCredential(fixture, account.id)
      expect(credential.apiKey).toBe('sk-ant-custom')
      expect(credential.baseURL).toBe('https://api.example.com/v1')
      expect(credential.authHeader).toBe('x-api-key')
      expect(account.label).toBe('CustomAPI')
    },
  )

  pluginTest(
    'rejects invalid baseURL with embedded credentials',
    async (fixture) => {
      const plugin = await fixture.getPlugin()
      await applyMenuAction(fixture, plugin, {
        actionId: 'add-apikey',
        values: { apiKey: 'sk-ant-bad', baseURL: 'https://user:pass@evil.com' },
      })

      expect(await readFallbacks(fixture)).toHaveLength(0)
    },
  )

  pluginTest('rejects non-http baseURL', async (fixture) => {
    const plugin = await fixture.getPlugin()
    await applyMenuAction(fixture, plugin, {
      actionId: 'add-apikey',
      values: { apiKey: 'sk-ant-bad2', baseURL: 'file:///etc/passwd' },
    })

    expect(await readFallbacks(fixture)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// add-oauth — error paths
// ---------------------------------------------------------------------------
describe('add-oauth error paths', () => {
  pluginTest(
    'add-oauth-finish with no pending state gives graceful error',
    async (fixture) => {
      const plugin = await fixture.getPlugin()
      capturedRecords = []

      await applyMenuAction(
        fixture,
        plugin,
        { actionId: 'add-oauth-finish', values: { code: 'somecode' } },
        'ses_no_pending',
      )

      expect(await readFallbacks(fixture)).toHaveLength(0)
    },
  )

  test('add-oauth-start stores pending and returns url', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const parsed = parseAccountCommandAction('add-oauth-start')
    expect(parsed.type).toBe('add-oauth-start')
  })

  lifetimes.test(
    'add-oauth-start refuses Claustrum mode before authorization',
    async () => {
      const authorize = mock(() =>
        Promise.resolve({
          url: 'https://example.test/authorize',
          redirectUri: 'http://localhost/callback',
          state: 'state',
          verifier: 'verifier',
        }),
      )
      // A pool's custody mode (Claustrum vault or local) is fixed by the setup
      // migration, so a vault-migrated pool is the Claustrum case and a
      // locally migrated pool is the local case.
      const vault = await migrate(emptyStorage(), 'claustrum')
      const vaultPlugin = await vault.getPlugin({
        authorize,
        claustrumScopedConnect: async () => mainOnlyVault(),
      })
      const refused = await applyMenuAction(
        vault,
        vaultPlugin,
        { actionId: 'add-oauth-start' },
        'ses_claustrum_add',
      )
      expect(refused.ok).toBe(false)
      expect(authorize).not.toHaveBeenCalled()

      const local = await migrate()
      const localPlugin = await local.getPlugin({ authorize })
      const started = await applyMenuAction(
        local,
        localPlugin,
        { actionId: 'add-oauth-start' },
        'ses_local_add',
      )
      expect(started.ok).toBe(true)
      expect(authorize).toHaveBeenCalledTimes(1)
    },
  )

  pluginTest(
    'pending entry is always cleared after finish (even on failure)',
    async (fixture) => {
      // add-oauth-start stores a pending entry for the session; a finish with a
      // code the exchange rejects must still consume it, so a second finish for
      // the same session reports an expired sign-in.
      const plugin = await fixture.getPlugin()

      await applyMenuAction(
        fixture,
        plugin,
        { actionId: 'add-oauth-start' },
        'ses_cleanup_test',
      )

      // Finish with garbage code — exchange will fail, but pending MUST be cleared
      await applyMenuAction(
        fixture,
        plugin,
        { actionId: 'add-oauth-finish', values: { code: 'garbage-code' } },
        'ses_cleanup_test',
      )

      // Second finish with same session — must get 'expired' (pending cleared)
      capturedRecords = []
      const second = await applyMenuAction(
        fixture,
        plugin,
        { actionId: 'add-oauth-finish', values: { code: 'another-code' } },
        'ses_cleanup_test',
      )
      expect(second.text).toContain('expired')

      // No accounts should have been added
      expect(await readFallbacks(fixture)).toHaveLength(0)
    },
  )
})

// ---------------------------------------------------------------------------
// add-oauth — label threading (the fix: prompt for a label, default UUID name)
// ---------------------------------------------------------------------------
describe('add-oauth label threading', () => {
  let oauthLogins = 0

  /**
   * A synthetic Anthropic OAuth server for one sign-in: its token endpoint
   * issues tokens unique to that sign-in, and its bootstrap endpoint names a
   * distinct account for them, so two sign-ins never share a credential.
   * Access tokens carry the `sk-ant-oat` prefix because the runtime looks up
   * the owning account only for tokens of that shape.
   */
  function syntheticOAuthServer() {
    const login = ++oauthLogins
    const identity = `00000000-0000-4000-8000-${String(login).padStart(12, '0')}`
    const respond = async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('oauth/token') || url.includes('/token')) {
        return new Response(
          JSON.stringify({
            access_token: `sk-ant-oat01-oauth-access-${login}`,
            refresh_token: `oauth-refresh-${login}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.includes('/claude_cli/bootstrap'))
        return Response.json({ oauth_account: { account_uuid: identity } })
      return new Response(null, { status: 200 })
    }
    return Object.assign(respond, { preconnect: originalFetch.preconnect })
  }

  async function withProvider<T>(
    provider: typeof fetch,
    body: () => Promise<T>,
  ): Promise<T> {
    const previous = globalThis.fetch
    globalThis.fetch = provider
    try {
      return await body()
    } finally {
      globalThis.fetch = previous
    }
  }

  async function runOAuthAddWithLabel(
    fixture: Migrated,
    labelArg: string | null,
    provider = syntheticOAuthServer(),
  ) {
    const plugin = await fixture.getPlugin()
    const sessionId = 'ses_oauth_label'
    const before = new Set((await readFallbacks(fixture)).map((a) => a.id))

    // Real add-oauth-start: builds a URL with a real state, stores pending,
    // and returns the URL in the menu result for the TUI to show.
    const started = await applyMenuAction(
      fixture,
      plugin,
      { actionId: 'add-oauth-start' },
      sessionId,
    )
    const match = started.text.match(/state=([^\s&]+)/)
    if (!match?.[1]) throw new Error('no OAuth URL with state in menu result')
    const state = decodeURIComponent(match[1])

    // The token exchange answers with tokens unique to this sign-in, so
    // add-oauth-finish can save the account.
    await withProvider(provider, () =>
      applyMenuAction(
        fixture,
        plugin,
        {
          actionId: 'add-oauth-finish',
          values: {
            code: `dummy-code#${state}`,
            ...(labelArg == null ? {} : { label: labelArg }),
          },
        },
        sessionId,
      ),
    )

    return (await readFallbacks(fixture)).filter(
      (account) => !before.has(account.id),
    )
  }

  /**
   * The route's auth lineage: a random ID the runtime keeps for each stored
   * OAuth credential and renews when the credential is replaced. The runtime
   * returns it only for a credential it has validated, so the route is first
   * authorized locally against `provider`.
   */
  async function readLineage(
    fixture: Migrated,
    routeId: string,
    provider: typeof fetch,
  ) {
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    try {
      return await withProvider(provider, async () => {
        const admitted = await runtime.authorizeLocal(routeId)
        if (admitted.status !== 'usable')
          throw new Error(
            `Route ${routeId} was not admitted: ${admitted.status}`,
          )
        return runtime.getOrCreateAuthLineage(routeId, admitted.subject)
      })
    } finally {
      runtime.close()
    }
  }

  pluginTest(
    'add-oauth-finish --label sets the account label',
    async (fixture) => {
      const added = await runOAuthAddWithLabel(fixture, 'work')
      expect(added).toHaveLength(1)
      const account = added[0]!
      expect(account.type).toBe('oauth')
      expect(account.label).toBe('work')
    },
  )

  pluginTest(
    'add-oauth-finish without --label leaves label undefined (UUID-name fallback)',
    async (fixture) => {
      const added = await runOAuthAddWithLabel(fixture, null)
      expect(added).toHaveLength(1)
      const account = added[0]!
      expect(account.label).toBeUndefined()
      // OAuth sign-in supplies no account name, so the route ID is a random UUID
      expect(account.id).toMatch(/^[0-9a-f-]{36}$/)
    },
  )

  pluginTest(
    'a fresh login at the same label gets a new auth lineage',
    async (fixture) => {
      const firstProvider = syntheticOAuthServer()
      const [firstAccount] = await runOAuthAddWithLabel(
        fixture,
        'work',
        firstProvider,
      )
      expect(firstAccount?.type).toBe('oauth')
      if (firstAccount?.type !== 'oauth')
        throw new Error('expected OAuth account')
      const firstLineage = await readLineage(
        fixture,
        firstAccount.id,
        firstProvider,
      )

      const secondProvider = syntheticOAuthServer()
      const [secondAccount] = await runOAuthAddWithLabel(
        fixture,
        'work',
        secondProvider,
      )
      expect(secondAccount?.type).toBe('oauth')
      if (secondAccount?.type !== 'oauth')
        throw new Error('expected OAuth account')
      const secondLineage = await readLineage(
        fixture,
        secondAccount.id,
        secondProvider,
      )
      expect(firstLineage).toBeString()
      expect(secondLineage).toBeString()
      expect(secondLineage).not.toBe(firstLineage)
      const { tokenFingerprint } = await import(
        '@cortexkit/anthropic-auth-core'
      )
      expect(tokenFingerprint(secondLineage!)).not.toBe(
        tokenFingerprint(firstLineage!),
      )
    },
  )
})

// ---------------------------------------------------------------------------
// security — no secrets in logs
// ---------------------------------------------------------------------------
describe('security — no secrets in logs', () => {
  pluginTest('API key is never in any log record', async (fixture) => {
    const plugin = await fixture.getPlugin()
    await applyMenuAction(fixture, plugin, {
      actionId: 'add-apikey',
      values: { apiKey: 'sk-ant-super-secret-key-abc123', label: 'MyLabel' },
    })

    const hits = scanLogsForSecrets(capturedRecords)
    expect(hits).toEqual([])
  })

  pluginTest(
    'apply path does not log raw API key arguments',
    async (fixture) => {
      const plugin = await fixture.getPlugin()
      await applyMenuAction(fixture, plugin, {
        actionId: 'add-apikey',
        values: { apiKey: 'sk-ant-rpc-key123' },
      })

      for (const rec of capturedRecords) {
        const payloadStr = JSON.stringify(rec.payload ?? {})
        expect(payloadStr).not.toContain('sk-ant-rpc-key123')
        expect(payloadStr).not.toContain('add-apikey sk-ant')
      }
    },
  )

  pluginTest('add-oauth-finish code is not logged', async (fixture) => {
    const plugin = await fixture.getPlugin()

    // The code travels in the menu request values, but must never appear in
    // a log payload.
    await applyMenuAction(
      fixture,
      plugin,
      {
        actionId: 'add-oauth-finish',
        values: { code: 'sk-ant-secret-auth-code' },
      },
      'ses_sec_code',
    )

    for (const rec of capturedRecords) {
      const payloadStr = JSON.stringify(rec.payload ?? {})
      expect(payloadStr).not.toContain('sk-ant-secret-auth-code')
    }
  })
})
