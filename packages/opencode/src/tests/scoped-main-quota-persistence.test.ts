import { afterEach, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  type NativeCustodyClient,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { createRpcClient } from '../rpc/rpc-client.ts'
import { getRpcDir } from '../rpc/rpc-dir.ts'
import { drainSidebarWrites } from '../sidebar-state.ts'
import {
  migrateNativeOpencodeFixture,
  type NativeOpencodeFixture,
} from './native-fixture.ts'

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>

// Every environment variable a test body or the migration fixture may set.
// Each body saves and restores all of them, so no path leaks into the next
// test.
const bodyEnvKeys = [
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

const livePlugins = new Set<Set<PluginHooks>>()
// Registered before the lifetime suite's own afterEach: dispose every plugin
// (its timers, vault client and RPC server) before that hook waits for a
// possibly still-running body and removes the body's files.
afterEach(async () => {
  const plugins = [...livePlugins].flatMap((owned) => {
    const current = [...owned]
    owned.clear()
    return current
  })
  await disposeAll(plugins, 'Scoped quota plugin cancellation failed')
})
const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

async function disposeAll(plugins: PluginHooks[], message: string) {
  const results = await Promise.allSettled(
    plugins.map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
  )
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      message,
    )
}

/**
 * Claim a fresh owner-only directory for this body. Teardown first disposes
 * the body's plugins and waits for sidebar writes, then restores fetch and
 * the environment, and only then removes the directory.
 */
async function startBody(prefix: string) {
  const savedFetch = globalThis.fetch
  const savedEnv = new Map(bodyEnvKeys.map((key) => [key, process.env[key]]))
  const plugins = new Set<PluginHooks>()
  livePlugins.add(plugins)
  lifetimes.deferCleanup(async () => {
    const remaining = [...plugins]
    plugins.clear()
    livePlugins.delete(plugins)
    try {
      await disposeAll(remaining, 'Scoped quota plugin cleanup failed')
    } finally {
      await drainSidebarWrites()
      globalThis.fetch = savedFetch
      for (const key of bodyEnvKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  delete process.env.OPENCODE_AUTH_CONTENT
  const root = await mkdtemp(join(tmpdir(), prefix))
  // migrateNativeOpencodeFixture also removes the root once it accepts it;
  // this covers a body that fails before handing the root to it.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  return { root, plugins }
}

const PRIMARY_ACCOUNT_ID = 'e84ca8b4-bd13-41e9-98e4-13f7b6690b7e'
const SLOT_ID = '874a76c0-309a-4ccb-9199-9106db83f521'

const mainRow: ScopedInventoryRow = {
  id: 'oauth:anthropic',
  accountId: PRIMARY_ACCOUNT_ID,
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  providerIds: [],
  credentialType: 'oauth',
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 10,
  createdAtMs: null,
}

/** Main quota as the native account view exposes it; never a legacy state file. */
async function readMainQuota(fixture: NativeOpencodeFixture) {
  const snapshot = await readNativeAccounts(fixture)
  return snapshot.accounts.find((account) => account.id === 'main')?.quota as
    | {
        accountIdentity?: string
        scoped?: Array<{ id?: string }>
      }
    | undefined
}

async function readNativeAccounts(fixture: NativeOpencodeFixture) {
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    return await runtime.read()
  } finally {
    runtime.close()
  }
}

/**
 * Import a scoped-custody seat through the real offline migration. The
 * migration keeps the host's stable slot id (SLOT_ID) as mainAccountId, while
 * main quota and runtime state bind to the Anthropic account UUID
 * (PRIMARY_ACCOUNT_ID). Discovery here reads only roster rows; it refuses any
 * credential read, so every receipt a test observes was issued while serving.
 */
async function setupScopedSeat(root: string, rows: () => ScopedInventoryRow[]) {
  const discovery: NativeCustodyClient = {
    listScoped: async () => ({ view: 'migration-discovery', rows: rows() }),
    getScoped: async () => {
      throw new Error('Migration discovery must not read credential material')
    },
    reportAuthFailureScoped: async () => {
      throw new Error('Migration discovery must not report credentials')
    },
    close: () => {},
  }
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      mainAccountId: SLOT_ID,
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: mainRow.id,
          accountId: PRIMARY_ACCOUNT_ID,
          state: 'active',
        },
      },
      accounts: [],
    },
    hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
    custody: {
      connect: async () => discovery,
      enrollment: { token: 'aa'.repeat(32), token_generation: 1 },
    },
  })
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  // The migrated main really is the vault primary, and has no quota yet.
  const main = (await readNativeAccounts(fixture)).accounts.find(
    (account) => account.id === 'main',
  )
  expect(main).toMatchObject({
    source: 'vault',
    credentialId: mainRow.id,
    accountIdentity: PRIMARY_ACCOUNT_ID,
  })
  expect(main?.quota).toBeUndefined()
  return fixture
}

/** The OpenCode auth entry exactly as the migration left it in host auth. */
function migratedActivation(fixture: NativeOpencodeFixture) {
  return async () =>
    JSON.parse(await readFile(fixture.hostAuthPath, 'utf8')).anthropic
}

async function createPlugin(
  plugins: Set<PluginHooks>,
  context: Record<string, unknown>,
  runtime: Record<string, unknown>,
) {
  const creation = AnthropicAuthPlugin(context as never, runtime as never)
  lifetimes.trackDetached(creation)
  const plugin = await creation
  plugins.add(plugin)
  return plugin
}

function mainClient(): NativeCustodyClient {
  return {
    listScoped: async () => ({ view: 'view-1', rows: [mainRow] }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: PRIMARY_ACCOUNT_ID,
      material: 'scoped-access-main',
      recordVersion: 10,
      expiresAtMs: Date.now() + 3_600_000,
    }),
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
}

test('/claude-quota polls main through scoped custody and persists its scoped windows', async () => {
  const { root, plugins } = await startBody('opencode-scoped-quota-cmd-')
  const fixture = await setupScopedSeat(root, () => [mainRow])
  const loopbackFetch = globalThis.fetch
  const usageAuthorizations: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    // The menu request below travels over the plugin's own loopback RPC server.
    if (url.startsWith('http://127.0.0.1:'))
      return loopbackFetch(input as Parameters<typeof fetch>[0], init)
    if (url.includes('/api/oauth/usage')) {
      usageAuthorizations.push(
        new Headers(init?.headers).get('authorization') ?? '',
      )
      return Response.json({
        five_hour: { utilization: 40, resets_at: null },
        seven_day: { utilization: 13, resets_at: null },
        limits: [
          {
            kind: 'weekly_scoped',
            group: 'weekly',
            percent: 22,
            scope: {
              model: { id: 'claude-fable-5-1', display_name: 'Fable' },
            },
          },
        ],
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const plugin = await createPlugin(
    plugins,
    { directory: fixture.root, client: { session: {} } },
    { claustrumScopedConnect: async () => mainClient() },
  )
  await (plugin as any).auth.loader(migratedActivation(fixture), {
    models: {},
  } as any)
  // The retired /claude-quota alias is now the unified /claude menu's
  // "Refresh quota" action, applied the way the TUI applies it: through the
  // plugin's RPC server. It returns only after the poll was persisted.
  const result = await createRpcClient(
    getRpcDir(fixture.root),
    process.pid,
  ).applyMenu({
    command: 'claude',
    sectionId: 'Quota',
    actionId: 'quota-refresh',
    sessionId: 'session-1',
  })
  expect(result.ok).toBe(true)
  await drainSidebarWrites()
  expect(usageAuthorizations).toContain('Bearer scoped-access-main')
  const quota = await readMainQuota(fixture)
  expect(quota?.accountIdentity).toBe(PRIMARY_ACCOUNT_ID)
  expect(quota?.scoped?.map((window) => window.id)).toEqual([
    'claude-weekly-scoped-claude-fable-5-1',
  ])
})

test('scoped custody persists main quota under the roster primary account id', async () => {
  const { root, plugins } = await startBody('opencode-scoped-main-quota-')
  const fixture = await setupScopedSeat(root, () => [mainRow])

  const resetSeconds = Math.floor(Date.now() / 1000) + 3_600
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (url.includes('/api/oauth/usage')) {
      return Response.json({
        five_hour: { utilization: 40 },
        seven_day: { utilization: 13 },
      })
    }
    if (url.includes('/v1/messages')) {
      return new Response(
        '{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}',
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-5h-utilization': '0.4',
            'anthropic-ratelimit-unified-5h-reset': String(resetSeconds),
            'anthropic-ratelimit-unified-7d-utilization': '0.13',
            'anthropic-ratelimit-unified-7d-reset': String(
              resetSeconds + 86_400,
            ),
          },
        },
      )
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const plugin = await createPlugin(
    plugins,
    { directory: fixture.root },
    { claustrumScopedConnect: async () => mainClient() },
  )
  const result = await (plugin as any).auth.loader(
    migratedActivation(fixture),
    { models: {} } as any,
  )
  const response = await result.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  expect(response.status).toBe(200)
  await response.text()

  // Header quota is persisted in the background after the response returns.
  let quota = await readMainQuota(fixture)
  for (let i = 0; i < 60 && !quota; i++) {
    await Bun.sleep(50)
    quota = await readMainQuota(fixture)
  }
  await drainSidebarWrites()
  expect(quota).toBeDefined()
  expect(quota?.accountIdentity).toBe(PRIMARY_ACCOUNT_ID)
})

test('a scoped main receipt never binds its quota to a roster primary that changed mid-request', async () => {
  const { root, plugins } = await startBody('opencode-scoped-primary-race-')
  const NEW_PRIMARY = '11111111-2222-4333-8444-555555555555'
  const rows = [mainRow]
  const fixture = await setupScopedSeat(root, () => [...rows])

  let getScopedCalls = 0
  const racingClient: NativeCustodyClient = {
    listScoped: async () => ({
      view: `view-${getScopedCalls}`,
      rows: [...rows],
    }),
    getScoped: async (input) => {
      getScopedCalls += 1
      // The vault's primary record moves to account B after the plugin
      // selected main but before the receipt for A is used. Offline setup
      // alone may repoint the pinned primary, so the change arrives the way a
      // running host sees it: a roster refresh observing the new account.
      if (getScopedCalls === 1) {
        rows[0] = { ...mainRow, accountId: NEW_PRIMARY, recordVersion: 11 }
        const peer = createNativeAccountRuntime({
          paths: fixture.paths,
          host: 'opencode',
          vault: { connect: async () => racingClient },
        })
        try {
          await peer.vault.refresh()
        } finally {
          peer.close()
        }
      }
      return {
        credentialId: input.credentialId,
        accountId: PRIMARY_ACCOUNT_ID,
        material: 'scoped-access-main',
        recordVersion: 10,
        expiresAtMs: Date.now() + 3_600_000,
      }
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }

  const resetSeconds = Math.floor(Date.now() / 1000) + 3_600
  const messageAuthorizations: string[] = []
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/v1/messages')) {
      messageAuthorizations.push(
        new Headers(init?.headers).get('authorization') ?? '',
      )
      return new Response(
        '{"id":"msg_1","type":"message","content":[{"type":"text","text":"ok"}]}',
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-unified-5h-utilization': '0.4',
            'anthropic-ratelimit-unified-5h-reset': String(resetSeconds),
            'anthropic-ratelimit-unified-7d-utilization': '0.13',
            'anthropic-ratelimit-unified-7d-reset': String(
              resetSeconds + 86_400,
            ),
          },
        },
      )
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const plugin = await createPlugin(
    plugins,
    { directory: fixture.root },
    {
      claustrumScopedConnect: async () => racingClient,
      scopedRosterPollIntervalMs: 0,
    },
  )
  // Let the startup roster discovery finish so it cannot hold the roster
  // lease when the mid-request refresh above runs.
  await (plugin as any).__fallbackRefreshReady
  const result = await (plugin as any).auth.loader(
    migratedActivation(fixture),
    {
      models: {},
    } as any,
  )
  let requestError: unknown
  const response = await result
    .fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    .catch((error: unknown) => {
      requestError = error
      return undefined
    })
  await response?.text().catch(() => {})
  await drainSidebarWrites()

  // The race really happened: A's receipt was served and the vault roster
  // now binds the primary record to B.
  expect(getScopedCalls).toBeGreaterThan(0)
  const snapshot = await readNativeAccounts(fixture)
  const accountB = snapshot.accounts.find(
    (account) => account.accountIdentity === NEW_PRIMARY,
  )
  expect(accountB?.credentialId).toBe(mainRow.id)
  // The request failed closed on the identity fence before sending A's
  // bearer, instead of failing for an unrelated reason.
  expect(String(requestError)).toContain('identity-changed')
  expect(messageAuthorizations).toEqual([])
  // And A's quota was never bound to B, nor to any account.
  expect(accountB?.quota).toBeUndefined()
  for (const account of snapshot.accounts)
    expect(account.quota?.accountIdentity).not.toBe(NEW_PRIMARY)
})
