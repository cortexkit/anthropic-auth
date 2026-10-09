import { afterEach, describe, expect } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  type NativeCustodyClient,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainSidebarWrites, getSidebarStateFile } from '../sidebar-state.ts'
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
  'OPENCODE_ANTHROPIC_AUTH_DUMP_DIR',
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
  await disposeAll(plugins, 'Scoped custody plugin cancellation failed')
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
      await disposeAll(remaining, 'Scoped custody plugin cleanup failed')
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

/**
 * Import a legacy scoped-custody seat through the real offline migration. The
 * discovery client lists the same synthetic vault rows the test later serves
 * from, and refuses any credential read, so every receipt a test observes was
 * issued while serving. The returned env is applied for the plugin.
 */
async function migrateScopedSeat(
  root: string,
  options: {
    rows: () => ScopedInventoryRow[]
    legacyConfig: Record<string, unknown>
    token: string
    expectedCredentials: string[]
  },
) {
  let listed = 0
  const discovery: NativeCustodyClient = {
    async listScoped() {
      listed++
      return { view: 'migration-discovery', rows: options.rows() }
    },
    async getScoped() {
      throw new Error('Migration discovery must not read credential material')
    },
    async reportAuthFailureScoped() {
      throw new Error('Migration discovery must not report credentials')
    },
    close() {},
  }
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: options.legacyConfig,
    hostAuth: { anthropic: custodyTombstoneOAuth('anthropic') },
    custody: {
      connect: async () => discovery,
      enrollment: { token: options.token, token_generation: 1 },
    },
  })
  expect(listed).toBeGreaterThan(0)
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  // The migrated pool really serves the expected vault rows; a test cannot
  // pass against an empty roster.
  const snapshot = await readNativeAccounts(fixture)
  expect(snapshot.mode).toBe('claustrum')
  expect(
    snapshot.accounts
      .filter((account) => account.source === 'vault')
      .map((account) => account.credentialId)
      .sort(),
  ).toEqual([...options.expectedCredentials].sort())
  return fixture
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

/** The OpenCode auth entry exactly as the migration left it in host auth. */
function migratedActivation(fixture: NativeOpencodeFixture) {
  return async () =>
    JSON.parse(await readFile(fixture.hostAuthPath, 'utf8')).anthropic
}

async function createPlugin(
  plugins: Set<PluginHooks>,
  fixture: { root: string },
  runtime: Record<string, unknown>,
) {
  const creation = AnthropicAuthPlugin(
    { directory: fixture.root } as never,
    runtime as never,
  )
  lifetimes.trackDetached(creation)
  const plugin = await creation
  plugins.add(plugin)
  return plugin
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const EMPTY_POST = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hello' }],
  }),
}

const mainRow: ScopedInventoryRow = {
  id: 'oauth:anthropic',
  accountId: 'provider-main-uuid',
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

const workRow: ScopedInventoryRow = {
  id: 'oauth:anthropic:work',
  accountId: 'provider-work-uuid',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  providerIds: [],
  credentialType: 'oauth',
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 5,
  createdAtMs: null,
}

/**
 * Legacy scoped-custody config for the vault inventory above, with mainRow as
 * the designated primary account, plus any extra legacy fields.
 */
function scopedLegacyConfig(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    accounts: [],
    quota: { enabled: false },
    claustrum: {
      mode: 'claustrum',
      scopedRoster: true,
      primaryAccount: {
        credentialId: mainRow.id,
        accountId: mainRow.accountId,
        state: 'active',
      },
    },
    ...extra,
  }
}

describe('OpenCode scoped custody serving', () => {
  test('serves requests using scoped receipts and dynamically adopts newly logged-in accounts without restart', async () => {
    const { root, plugins } = await startBody('opencode-scoped-serving-')
    const rows = [mainRow, workRow]
    const fixture = await migrateScopedSeat(root, {
      rows: () => [...rows],
      token: 'aa'.repeat(32),
      expectedCredentials: [mainRow.id, workRow.id],
      legacyConfig: {
        version: 1,
        claustrum: {
          mode: 'claustrum',
          scopedRoster: true,
          primaryAccount: {
            credentialId: mainRow.id,
            accountId: mainRow.accountId,
            state: 'active',
          },
        },
        dump: { enabled: true },
        accounts: [
          {
            id: 'work',
            label: 'work',
            type: 'oauth',
            enabled: true,
            refresh: '',
            claustrumScopedCredentialId: workRow.id,
            anthropicAccountUuid: workRow.accountId,
            claustrumScopedState: 'active',
          },
        ],
      },
    })
    const dumpDir = join(fixture.root, 'dumps')
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    const gets: Array<{ credentialId: string }> = []
    const reports: Array<{
      credentialId: string
      recordVersion: number
      providerStatus: number
    }> = []

    const scopedClient: NativeCustodyClient = {
      listScoped: async () => ({
        view: `view-${rows.length}`,
        rows: [...rows],
      }),
      getScoped: async (input) => {
        gets.push(input)
        const row = rows.find((r) => r.id === input.credentialId)
        return {
          credentialId: input.credentialId,
          accountId: row?.accountId ?? 'unknown',
          material: `scoped-access-${input.credentialId}`,
          recordVersion: row?.recordVersion ?? 1,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      reportAuthFailureScoped: async (input) => {
        reports.push(input)
      },
      close: () => {},
    }

    const authorizations: string[] = []
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 10 },
        })
      }
      if (url.includes('/v1/messages')) {
        authorizations.push(
          new Headers(init?.headers).get('authorization') ?? '',
        )
        return new Response(
          '{"id":"msg_1","type":"message","content":[{"type":"text","text":"hello"}]}',
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const plugin = await createPlugin(plugins, fixture, {
      claustrumScopedConnect: async () => scopedClient,
    })

    const result = await (plugin as any).auth.loader(
      migratedActivation(fixture),
      { models: {} } as any,
    )

    // 1. Initial request dispatches with main scoped credential
    const firstResponse = await result.fetch(MESSAGES_URL, EMPTY_POST)
    expect(firstResponse.status).toBe(200)
    expect(authorizations).toHaveLength(1)
    expect(authorizations[0]).toBe('Bearer scoped-access-oauth:anthropic')
    expect(gets.some((g) => g.credentialId === 'oauth:anthropic')).toBe(true)
    await firstResponse.text()
    await drainSidebarWrites()
    // Neither the served access token nor the enrollment token may reach any
    // file the plugin or the migration wrote: pool config, state, runtime,
    // roster, journal, host auth, sidebar or request dumps. Only the
    // enrollment file itself holds the enrollment token.
    const dumps = await readdir(dumpDir)
    expect(dumps.length).toBeGreaterThan(0)
    const written = (await filesUnder(fixture.root)).filter(
      (path) => path !== fixture.enrollmentPath,
    )
    for (const path of [
      fixture.paths.config,
      fixture.paths.runtime,
      fixture.paths.roster,
      fixture.paths.journal,
      fixture.hostAuthPath,
      getSidebarStateFile(),
      ...dumps.map((name) => join(dumpDir, name)),
    ])
      expect(written).toContain(path)
    const serialized = (
      await Promise.all(written.map((path) => readFile(path, 'utf8')))
    ).join('\n')
    expect(serialized).not.toContain('scoped-access-oauth:anthropic')
    expect(serialized).not.toContain('aa'.repeat(32))

    // 2. Simulate user adding a 3rd account via `ck auth login`
    const personalRow: ScopedInventoryRow = {
      id: 'oauth:anthropic:personal',
      accountId: 'provider-personal-uuid',
      categories: ['anthropic-native'],
      serves: ['anthropic'],
      providerIds: [],
      credentialType: 'oauth',
      refreshAdapter: 'anthropic',
      operations: ['read'],
      state: 'active',
      recordVersion: 1,
      createdAtMs: null,
    }
    // The startup discovery must be finished, or the refresh below would
    // join it and miss the new row.
    await (plugin as any).__fallbackRefreshReady
    rows.push(personalRow)

    // Trigger discovery refresh (simulating background poll)
    const runtime = (plugin as any).__scopedRuntime
    expect(runtime).toBeDefined()
    await runtime.refresh()

    // 3. The native account view now serves the new vault account.
    const updated = await readNativeAccounts(fixture)
    const personalAccount = updated.accounts.find(
      (account) => account.accountIdentity === 'provider-personal-uuid',
    )
    expect(personalAccount).toBeDefined()
    expect(personalAccount?.source).toBe('vault')
    expect(personalAccount?.credentialId).toBe('oauth:anthropic:personal')
    expect(personalAccount?.state).toBe('active')
    expect(reports).toEqual([])
  })

  test('reports upstream 401 auth failure to Claustrum with exact served record version', async () => {
    const { root, plugins } = await startBody('opencode-scoped-401-')
    const fixture = await migrateScopedSeat(root, {
      rows: () => [mainRow],
      token: 'bb'.repeat(32),
      expectedCredentials: [mainRow.id],
      legacyConfig: {
        version: 1,
        claustrum: {
          mode: 'claustrum',
          scopedRoster: true,
          primaryAccount: {
            credentialId: mainRow.id,
            accountId: mainRow.accountId,
            state: 'active',
          },
        },
        accounts: [],
      },
    })

    const reports: Array<{
      credentialId: string
      recordVersion: number
      providerStatus: number
    }> = []
    const scopedClient: NativeCustodyClient = {
      listScoped: async () => ({ view: 'v1', rows: [mainRow] }),
      getScoped: async (input) => ({
        credentialId: input.credentialId,
        accountId: mainRow.accountId,
        material: 'revoked-token',
        recordVersion: 10,
        expiresAtMs: Date.now() + 3_600_000,
      }),
      reportAuthFailureScoped: async (input) => {
        reports.push(input)
      },
      close: () => {},
    }

    let modelSends = 0
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 10 },
        })
      }
      modelSends++
      return new Response(
        '{"type":"error","error":{"type":"authentication_error"}}',
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch

    const plugin = await createPlugin(plugins, fixture, {
      claustrumScopedConnect: async () => scopedClient,
    })

    const result = await (plugin as any).auth.loader(
      migratedActivation(fixture),
      { models: {} } as any,
    )

    await result.fetch(MESSAGES_URL, EMPTY_POST).catch(() => {})

    expect(modelSends).toBe(1)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      credentialId: 'oauth:anthropic',
      recordVersion: 10,
      providerStatus: 401,
    })
  })
})

test('Claustrum mode without a scoped roster refuses to serve even with legacy local fallback material', async () => {
  // Deliberately not migrated: legacy handle bindings have no native
  // authority, so serving must refuse before any upstream request and must
  // leave the legacy material untouched.
  const { root, plugins } = await startBody('opencode-legacy-refusal-')
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  const storagePath = join(root, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = storagePath
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    root,
    'anthropic-auth-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    root,
    'enrollment.json',
  )
  const legacyBytes = JSON.stringify({
    version: 1,
    claustrum: { mode: 'claustrum' },
    accounts: [
      {
        id: 'old',
        label: 'old',
        type: 'oauth',
        enabled: true,
        access: 'stale-local-access',
        refresh: 'stale-local-refresh',
        expires: Date.now() + 3600000,
      },
    ],
  })
  await writeFile(storagePath, legacyBytes, { mode: 0o600 })
  let sends = 0
  globalThis.fetch = (async () => {
    sends++
    throw new Error('request must not reach upstream')
  }) as unknown as typeof fetch
  const plugin = await createPlugin(
    plugins,
    { root },
    {
      scopedRosterPollIntervalMs: 0,
    },
  )
  const loader = await (plugin as any).auth.loader(
    async () => custodyTombstoneOAuth('anthropic'),
    { models: {} },
  )
  // Legacy storage used to answer this with a 503 asking for scoped-custody
  // setup. Natively, a pool without a migration journal has no authority to
  // serve at all, so the request is refused before any upstream call.
  await expect(loader.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
    'Anthropic account migration is required',
  )
  expect(sends).toBe(0)
  expect(await readFile(storagePath, 'utf8')).toBe(legacyBytes)
})

test('loader and model request remain usable when a peer holds the scoped roster lease', async () => {
  const { root, plugins } = await startBody('opencode-scoped-lease-')
  const fixture = await migrateScopedSeat(root, {
    rows: () => [mainRow],
    token: 'cc'.repeat(32),
    expectedCredentials: [mainRow.id],
    legacyConfig: scopedLegacyConfig(),
  })
  // A peer process holds the vault roster's discovery lease, the lease every
  // native roster refresh must take before listing the vault.
  const lease = await acquireRefreshFileLock({
    name: 'claustrum-roster',
    path: fixture.paths.roster,
    ttlMs: 30_000,
    renew: true,
  })
  if (!lease) throw new Error('test could not acquire roster lease')
  try {
    await serveWhileLeaseHeld(fixture, plugins)
  } finally {
    await lease.release()
  }
})

async function serveWhileLeaseHeld(
  fixture: NativeOpencodeFixture,
  plugins: Set<PluginHooks>,
) {
  let lists = 0,
    gets = 0,
    sends = 0
  const scopedClient: NativeCustodyClient = {
    listScoped: async () => {
      lists++
      throw new Error('peer owns discovery')
    },
    getScoped: async ({ credentialId }) => {
      gets++
      return {
        credentialId,
        accountId: mainRow.accountId,
        material: 'lease-scoped-access',
        recordVersion: 42,
        expiresAtMs: Date.now() + 3_600_000,
      }
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes('/v1/messages'))
      throw new Error('unexpected upstream call')
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer lease-scoped-access',
    )
    sends++
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const plugin = await createPlugin(plugins, fixture, {
    claustrumScopedConnect: async () => scopedClient,
    scopedRosterPollIntervalMs: 0,
  })
  // OpenCode initializes plugins for all providers. A contested roster
  // must not make an unrelated model's provider initialization fail.
  const loader = await (plugin as any).auth.loader(
    migratedActivation(fixture),
    { models: {} },
  )
  // The startup discovery found the lease held and kept the committed roster.
  await (plugin as any).__fallbackRefreshReady
  expect(lists).toBe(0)
  expect(gets).toBe(0)
  expect((await loader.fetch(MESSAGES_URL, EMPTY_POST)).status).toBe(200)
  expect(gets).toBeGreaterThan(0)
  expect(sends).toBe(1)
  expect(lists).toBe(0)
}

test('provider initialization does not wait for a stalled scoped discovery connection', async () => {
  const { root, plugins } = await startBody('opencode-scoped-loader-')
  const fixture = await migrateScopedSeat(root, {
    rows: () => [mainRow],
    token: 'dd'.repeat(32),
    expectedCredentials: [mainRow.id],
    legacyConfig: scopedLegacyConfig(),
  })
  let connectStarted!: () => void
  let releaseConnect!: (value: NativeCustodyClient) => void
  const entered = new Promise<void>((resolve) => {
    connectStarted = resolve
  })
  const blocked = new Promise<NativeCustodyClient>((resolve) => {
    releaseConnect = resolve
  })
  const client: NativeCustodyClient = {
    listScoped: async () => ({ rows: [mainRow], view: 'v' }),
    getScoped: async () => {
      throw new Error('no dispatch expected')
    },
    reportAuthFailureScoped: async () => {},
    close: () => {},
  }
  const plugin = await createPlugin(plugins, fixture, {
    claustrumScopedConnect: () => {
      connectStarted()
      return blocked
    },
    scopedRosterPollIntervalMs: 0,
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await entered
    const loader = await Promise.race([
      (plugin as any).auth.loader(migratedActivation(fixture), {
        models: {},
      }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error('provider initialization waited for scoped discovery'),
            ),
          1000,
        )
        deadline.unref?.()
      }),
    ])
    expect(loader.fetch).toBeFunction()
  } finally {
    if (deadline) clearTimeout(deadline)
    releaseConnect(client)
  }
})

for (const { outcome, finalStatus } of [
  { outcome: '200', finalStatus: 200 },
  { outcome: '401', finalStatus: 401 },
  { outcome: 'network-error', finalStatus: 'network-error' },
] as const) {
  test(`a scoped main rotated during HTTP dispatch retries once, final outcome ${outcome}`, async () => {
    const { root, plugins } = await startBody('opencode-scoped-rotation-')
    const fixture = await migrateScopedSeat(root, {
      rows: () => [mainRow],
      token: 'ab'.repeat(32),
      expectedCredentials: [mainRow.id],
      legacyConfig: scopedLegacyConfig(),
    })
    let version = 1
    const reports: number[] = []
    const wireTokens: string[] = []
    const scopedClient: NativeCustodyClient = {
      listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
      getScoped: async ({ credentialId }) => ({
        credentialId,
        accountId: mainRow.accountId,
        material: `scoped-version-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 3_600_000,
      }),
      reportAuthFailureScoped: async ({ recordVersion }) => {
        reports.push(recordVersion)
      },
      close: () => {},
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!String(input).includes('/v1/messages'))
        throw new Error('unexpected upstream call')
      const token = new Headers(init?.headers).get('authorization') ?? ''
      wireTokens.push(token)
      if (token === 'Bearer scoped-version-1') {
        version = 2 // The vault rotates after getScoped, before Anthropic responds.
        return new Response('old token rejected', { status: 401 })
      }
      if (finalStatus === 'network-error')
        throw new Error('new record transport failed')
      return new Response('rotated token response', { status: finalStatus })
    }) as typeof fetch
    const plugin = await createPlugin(plugins, fixture, {
      claustrumScopedConnect: async () => scopedClient,
      scopedRosterPollIntervalMs: 0,
    })
    const loader = await (plugin as any).auth.loader(
      migratedActivation(fixture),
      { models: {} },
    )
    if (finalStatus === 'network-error') {
      await expect(loader.fetch(MESSAGES_URL, EMPTY_POST)).rejects.toThrow(
        'new record transport failed',
      )
    } else {
      const response = await loader.fetch(MESSAGES_URL, EMPTY_POST)
      expect(response.status).toBe(finalStatus)
      expect(await response.text()).toBe('rotated token response')
    }
    expect(wireTokens).toEqual([
      'Bearer scoped-version-1',
      'Bearer scoped-version-2',
    ])
    expect(reports).toEqual(finalStatus === 401 ? [2] : [])
  })
}

/** Legacy HTTP relay settings; the migration moves the token into private runtime state. */
const legacyHttpRelay = {
  enabled: true,
  transport: 'http',
  url: 'https://relay.example.test/forward',
  token: 'relay-test',
  fallbackToDirect: true,
}

for (const mode of ['transport-error', 'relay-auth-401'] as const) {
  test(`relay-to-direct after ${mode} reauthorizes and reports only the direct credential`, async () => {
    const { root, plugins } = await startBody('opencode-scoped-relay-direct-')
    const fixture = await migrateScopedSeat(root, {
      rows: () => [mainRow],
      token: 'ab'.repeat(32),
      expectedCredentials: [mainRow.id],
      legacyConfig: scopedLegacyConfig({ relay: legacyHttpRelay }),
    })
    let version = 1
    // Vault reads and wire sends in the order they happen, so each receipt
    // can be matched to the send (if any) that used it.
    const events: string[] = []
    const reports: number[] = [],
      direct: string[] = []
    const scopedClient: NativeCustodyClient = {
      listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
      getScoped: async ({ credentialId }) => {
        events.push(`vault read v${version}`)
        return {
          credentialId,
          accountId: mainRow.accountId,
          material: `scoped-version-${version}`,
          recordVersion: version,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      reportAuthFailureScoped: async ({ recordVersion }) => {
        reports.push(recordVersion)
      },
      close: () => {},
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('relay.example.test')) {
        const payload = JSON.parse(String(init?.body)) as {
          upstream: { headers: Record<string, string> }
        }
        events.push(`relay send ${payload.upstream.headers.authorization}`)
        version = 2
        if (mode === 'relay-auth-401')
          return new Response('relay secret rejected', { status: 401 })
        throw new Error('relay transport unavailable before Anthropic response')
      }
      if (!String(input).includes('/v1/messages'))
        throw new Error('unexpected upstream call')
      direct.push(new Headers(init?.headers).get('authorization') ?? '')
      events.push(`direct send ${direct.at(-1)}`)
      return new Response('rejected latest record', { status: 401 })
    }) as typeof fetch
    const plugin = await createPlugin(plugins, fixture, {
      claustrumScopedConnect: async () => scopedClient,
      scopedRosterPollIntervalMs: 0,
    })
    const loader = await (plugin as any).auth.loader(
      migratedActivation(fixture),
      { models: {} },
    )
    const response = await loader.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      headers: { 'x-session-affinity': 'relay-direct-rotation' },
    })
    expect(response.status).toBe(401)
    expect(direct).toEqual(['Bearer scoped-version-2'])
    // Every vault credential read, in order and by purpose, interleaved with
    // the physical sends. A read is not a send: only the relay and direct
    // sends carry a credential, and each uses the read just before it.
    expect(events).toEqual([
      // Routing picks main and checks its model policy for this request.
      'vault read v1',
      // After routing, the selected route is authorized again to verify it
      // (enabled state, source, identity, binding, model policy) and to supply
      // the request-signing identity. Its access token is not dispatched: the
      // next transport attempt authorizes again.
      'vault read v1',
      // Fresh access token and record version for the relay attempt.
      'vault read v1',
      'relay send Bearer scoped-version-1',
      // Fresh access token and record version for the direct fallback,
      // issued after the vault rotated.
      'vault read v2',
      'direct send Bearer scoped-version-2',
      // After the direct 401 the vault is asked for a newer record; v2 is
      // still current, so there is no retry, and reportAuthFailure records
      // exactly version 2 as the final rejected record.
      'vault read v2',
    ])
    expect(reports).toEqual([2])
  })
}

for (const finalStatus of [200, 401]) {
  test(`HTTP relay retries once after scoped rotation; final upstream status ${finalStatus}`, async () => {
    const { root, plugins } = await startBody('opencode-scoped-relay-rotation-')
    const fixture = await migrateScopedSeat(root, {
      rows: () => [mainRow],
      token: 'ab'.repeat(32),
      expectedCredentials: [mainRow.id],
      legacyConfig: scopedLegacyConfig({ relay: legacyHttpRelay }),
    })
    let version = 1
    const reports: number[] = [],
      relayTokens: string[] = []
    const scopedClient: NativeCustodyClient = {
      listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
      getScoped: async ({ credentialId }) => ({
        credentialId,
        accountId: mainRow.accountId,
        material: `scoped-version-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 3_600_000,
      }),
      reportAuthFailureScoped: async ({ recordVersion }) => {
        reports.push(recordVersion)
      },
      close: () => {},
    }
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!String(input).includes('relay.example.test'))
        throw new Error('unexpected direct fetch')
      const payload = JSON.parse(String(init?.body)) as {
        upstream: { headers: Record<string, string> }
      }
      const token = payload.upstream.headers.authorization
      if (!token) throw new Error('relay omitted upstream bearer')
      relayTokens.push(token)
      if (token === 'Bearer scoped-version-1') {
        version = 2
        return new Response('old relay token rejected', {
          status: 401,
          headers: { 'request-id': 'req_upstream_rotated' },
        })
      }
      return new Response('new relay token response', {
        status: finalStatus,
        headers: { 'request-id': 'req_upstream_success' },
      })
    }) as typeof fetch
    const plugin = await createPlugin(plugins, fixture, {
      claustrumScopedConnect: async () => scopedClient,
      scopedRosterPollIntervalMs: 0,
    })
    const loader = await (plugin as any).auth.loader(
      migratedActivation(fixture),
      { models: {} },
    )
    const response = await loader.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      headers: { 'x-session-affinity': 'relay-rotation' },
    })
    expect(response.status).toBe(finalStatus)
    expect(await response.text()).toBe('new relay token response')
    expect(relayTokens).toEqual([
      'Bearer scoped-version-1',
      'Bearer scoped-version-2',
    ])
    expect(reports).toEqual(finalStatus === 401 ? [2] : [])
  })
}

test('optimistic WebSocket reports only the scoped version used by its real upstream 401', async () => {
  const { root, plugins } = await startBody('opencode-scoped-ws-401-')
  const relayTokens: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request)
        ? undefined
        : new Response('unexpected HTTP relay', { status: 500 }),
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ protocol: 2, type: 'ready', state: null }))
      },
      message: (socket, data) => {
        const payload = JSON.parse(String(data)) as {
          id: string
          next_hash: string
          revision: number
          upstream: { headers: Record<string, string> }
        }
        relayTokens.push(payload.upstream.headers.authorization ?? '')
        socket.send(
          JSON.stringify({
            protocol: 2,
            type: 'accepted',
            id: payload.id,
            hash: payload.next_hash,
            revision: payload.revision,
          }),
        )
        socket.send(
          JSON.stringify({
            protocol: 2,
            type: 'response_start',
            id: payload.id,
            status: 401,
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
        socket.send(
          JSON.stringify({ protocol: 2, type: 'done', id: payload.id }),
        )
      },
    },
  })
  try {
    const fixture = await migrateScopedSeat(root, {
      rows: () => [mainRow],
      token: 'ab'.repeat(32),
      expectedCredentials: [mainRow.id],
      legacyConfig: scopedLegacyConfig({
        relay: {
          enabled: true,
          transport: 'websocket',
          url: server.url.href,
          token: 'relay-test',
          fallbackToDirect: false,
        },
      }),
    })
    let gets = 0
    const reports: number[] = []
    const reported = lifetimes.gate()
    const scopedClient: NativeCustodyClient = {
      listScoped: async () => ({ view: 'main-only', rows: [mainRow] }),
      getScoped: async ({ credentialId }) => {
        const version = Math.min(++gets, 2)
        return {
          credentialId,
          accountId: mainRow.accountId,
          material: `scoped-version-${version}`,
          recordVersion: version,
          expiresAtMs: Date.now() + 3_600_000,
        }
      },
      reportAuthFailureScoped: async ({ recordVersion }) => {
        reports.push(recordVersion)
        reported.open()
      },
      close: () => {},
    }
    globalThis.fetch = (async () => {
      throw new Error('unexpected direct send')
    }) as unknown as typeof fetch
    const plugin = await createPlugin(plugins, fixture, {
      claustrumScopedConnect: async () => scopedClient,
      scopedRosterPollIntervalMs: 0,
    })
    const loader = await (plugin as any).auth.loader(
      migratedActivation(fixture),
      { models: {} },
    )
    const response = await loader.fetch(MESSAGES_URL, {
      ...EMPTY_POST,
      headers: { 'x-session-affinity': `ws-scoped-401-${root}` },
    })
    expect(response.status).toBe(200) // local optimistic status, not Anthropic's 401
    await response.text().catch(() => {})
    // Anthropic's late 401 is reported asynchronously, after the optimistic
    // response. Wait for that report; if it never arrives, teardown resolves
    // this wait so the test fails instead of hanging.
    await reported.wait
    expect(relayTokens).toEqual(['Bearer scoped-version-2'])
    expect(reports).toEqual([2])
  } finally {
    await disposeAll([...plugins], 'Scoped custody plugin cleanup failed')
    plugins.clear()
    await server.stop(true)
  }
})
