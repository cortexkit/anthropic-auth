import { afterEach, expect, mock } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type authorize,
  CacheKeepManager,
  createNativeAccountRuntime,
  custodyTombstoneOAuth,
  discoverNativeVaultInventory,
  getLogLevel,
  type LogTestRecord,
  type NativeCustodyClient,
  PrimeManager,
  publishNativeVaultRosterSeed,
  publishNativeVaultRuntimeSeed,
  resetClaudeCodeIdentityCachesForTest,
  resolveNativePoolPaths,
  runNativeMigration,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { createOpencodeClient, type Provider } from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { MockRelayServer } from '../../../e2e-tests/src/mock-relay.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { COMMAND_MODAL_NAMES } from '../rpc/protocol.ts'

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
type PluginFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

const envKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'CLAUDE_CONFIG_DIR',
] as const
const originalFetch = globalThis.fetch
const provider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}
type BodyOwner = {
  directory: string
  controller: AbortController
  plugins: PluginHooks[]
  relays: Set<MockRelayServer>
}
const owners = new Set<BodyOwner>()
let currentOwner: BodyOwner | undefined
let teardownRequested = false
// Register cancellation before createTestLifetimeSuite's afterEach hook:
// stop test I/O before that hook waits for timed-out tests to finish.
afterEach(async () => {
  teardownRequested = true
  const closing = [...owners]
  const pluginsToClose = closing.flatMap((owner) => [...owner.plugins])
  const relaysToClose = closing.flatMap((owner) => [...owner.relays])
  for (const owner of closing) owner.controller.abort()
  const siblings = [
    ...pluginsToClose.map((plugin) =>
      Promise.resolve().then(() => plugin.dispose?.()),
    ),
    ...relaysToClose.map((relay) => Promise.resolve().then(() => relay.stop())),
  ]
  const results = await Promise.allSettled(siblings)
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      'Native serving cancellation failed',
    )
})
const lifetimes = createTestLifetimeSuite()
function test(name: string, body: () => unknown, timeout?: number) {
  lifetimes.test(
    name,
    async () => {
      teardownRequested = false
      await setupBody()
      return body()
    },
    timeout,
  )
}
let relays: Set<MockRelayServer>
let directory: string
let configPath: string
let legacyBytes: string
const network = mock(
  async (
    _input: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    throw new Error(
      'Unexpected network request in native admission refusal test',
    )
  },
)

async function setupBody() {
  const savedFetch = globalThis.fetch
  const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  const ownedDirectory = await mkdtemp(join(tmpdir(), 'oc1-native-refusal-'))
  directory = ownedDirectory
  const owner: BodyOwner = {
    directory: ownedDirectory,
    controller: new AbortController(),
    plugins: [],
    relays: new Set(),
  }
  currentOwner = owner
  if (teardownRequested) owner.controller.abort()
  owners.add(owner)
  relays = owner.relays
  lifetimes.deferCleanup(async () => {
    const remainingPlugins = owner.plugins.splice(0)
    const remainingRelays = [...owner.relays]
    owner.relays.clear()
    owner.controller.abort()
    const siblings = [
      ...remainingPlugins.map((plugin) =>
        Promise.resolve().then(() => plugin.dispose?.()),
      ),
      ...remainingRelays.map((relay) =>
        Promise.resolve().then(() => relay.stop()),
      ),
    ]
    const results = await Promise.allSettled(siblings)
    try {
      await rm(ownedDirectory, { recursive: true, force: true })
    } finally {
      globalThis.fetch = savedFetch
      for (const key of envKeys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      owners.delete(owner)
      if (currentOwner === owner) currentOwner = undefined
    }
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Native serving cleanup failed',
      )
  })
  configPath = join(directory, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = configPath
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    directory,
    'anthropic-auth-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = join(
    directory,
    'sidebar.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = join(
    directory,
    'cachekeep',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = join(
    directory,
    'quota-feed',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = join(directory, 'rpc')
  process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
    directory,
    'routing.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    directory,
    'enrollment.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
    directory,
    'synthetic-connection.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  delete process.env.OPENCODE_AUTH_CONTENT
  legacyBytes = JSON.stringify({
    version: 1,
    refresh: { enabled: false },
    quota: { enabled: false },
    claudeCache: { enabled: false },
    accounts: [
      {
        id: 'legacy-route',
        type: 'oauth',
        access: 'synthetic-legacy-access-canary',
        refresh: 'synthetic-legacy-refresh-canary',
        expires: Date.now() + 60_000,
      },
    ],
  })
  await writeFile(configPath, legacyBytes, { mode: 0o600 })
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'synthetic-claude')
  resetClaudeCodeIdentityCachesForTest()
  network.mockClear()
  globalThis.fetch = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const signal = AbortSignal.any([
        owner.controller.signal,
        ...(init?.signal ? [init.signal] : []),
      ])
      signal.throwIfAborted()
      return network(input, { ...init, signal })
    },
    { preconnect: originalFetch.preconnect },
  )
}

async function createPlugin(
  options: Parameters<typeof AnthropicAuthPlugin>[1] = {},
) {
  const owner = currentOwner
  if (!owner) throw new Error('Native serving fixture has no body owner')
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: globalThis.fetch,
      }),
      project: {
        id: 'native-refusal-fixture',
        worktree: directory,
        time: { created: Date.now() },
      },
      directory,
      worktree: directory,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    {
      scopedRosterPollIntervalMs: 0,
      cacheKeepAggregateRefreshIntervalMs: 0,
      ...options,
    },
  )
  lifetimes.trackDetached(creation)
  const plugin = await creation
  owner.plugins.push(plugin)
  if (owner.controller.signal.aborted) await plugin.dispose?.()
  return plugin
}

function requestFetch(options: Record<string, unknown>): PluginFetch {
  const handler = options.fetch
  if (typeof handler !== 'function')
    throw new Error('Plugin did not install its request handler')
  return async (input, init) => {
    const owner = currentOwner
    if (!owner) throw new Error('Native request has no body owner')
    const signal = AbortSignal.any([
      owner.controller.signal,
      ...(init?.signal ? [init.signal] : []),
    ])
    const response: unknown = await handler(input, { ...init, signal })
    if (!(response instanceof Response))
      throw new Error('Plugin request handler did not return a Response')
    return response
  }
}

async function load(
  plugin: PluginHooks,
  auth: Parameters<NonNullable<NonNullable<PluginHooks['auth']>['loader']>>[0],
) {
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('Plugin did not install its auth loader')
  return loader(auth, provider)
}

test('unmigrated local OAuth refuses foreground and background network without adopting legacy secrets', async () => {
  const plugin = await createPlugin()
  const options = await load(plugin, async () => ({
    type: 'oauth',
    access: 'synthetic-host-access-canary',
    refresh: 'synthetic-host-refresh-canary',
    expires: Date.now() + 60_000,
  }))
  await expect(
    requestFetch(options)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    }),
  ).rejects.toThrow('migration')
  expect(network).not.toHaveBeenCalled()
  expect(await readFile(configPath, 'utf8')).toBe(legacyBytes)
})

test('inert activation alone cannot serve before offline migration commits', async () => {
  const plugin = await createPlugin()
  const options = await load(plugin, async () =>
    custodyTombstoneOAuth('anthropic'),
  )
  await expect(
    requestFetch(options)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    }),
  ).rejects.toThrow('migration')
  expect(network).not.toHaveBeenCalled()
  expect(await readFile(configPath, 'utf8')).toBe(legacyBytes)
})

test('supervised auth content refuses native OAuth before any provider request', async () => {
  const plugin = await createPlugin()
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: custodyTombstoneOAuth('anthropic'),
  })
  const options = await load(plugin, async () =>
    custodyTombstoneOAuth('anthropic'),
  )
  await expect(
    requestFetch(options)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    }),
  ).rejects.toThrow('OPENCODE_AUTH_CONTENT')
  expect(network).not.toHaveBeenCalled()
})

test('ordinary OpenCode API auth stays passthrough even without native migration', async () => {
  const plugin = await createPlugin()
  expect(
    await load(plugin, async () => ({
      type: 'api',
      key: 'synthetic-stock-api-key',
    })),
  ).toEqual({})
  expect(network).not.toHaveBeenCalled()
  expect(await readFile(configPath, 'utf8')).toBe(legacyBytes)
})

test('single claude registration removes owned aliases and preserves foreign commands', async () => {
  const plugin = await createPlugin()
  const config = {
    command: {
      foreign: { template: 'foreign' },
      ...Object.fromEntries(
        COMMAND_MODAL_NAMES.map((name) => [name, { template: name }]),
      ),
    },
  }
  await plugin.config?.(config)
  expect(Object.keys(config.command).sort()).toEqual(['claude', 'foreign'])
  expect(config.command.foreign).toEqual({ template: 'foreign' })
  expect(network).not.toHaveBeenCalled()
})

test('retired slash aliases cannot mutate settings or dispatch a native menu action', async () => {
  const plugin = await createPlugin()
  for (const command of COMMAND_MODAL_NAMES) {
    await plugin['command.execute.before']?.(
      { command, arguments: 'on', sessionID: 'synthetic-session' },
      { parts: [] },
    )
  }
  expect(await readFile(configPath, 'utf8')).toBe(legacyBytes)
  expect(network).not.toHaveBeenCalled()
})

test('local OAuth sign-in cannot begin before native authority migration', async () => {
  const authorizeImpl: typeof authorize = mock(async () => ({
    url: 'https://example.test/oauth',
    redirectUri: 'https://example.test/callback',
    verifier: 'synthetic-verifier',
    state: 'synthetic-state',
  }))
  const plugin = await createPlugin({ authorize: authorizeImpl })
  const method = plugin.auth?.methods[0]
  if (method?.type !== 'oauth')
    throw new Error('Plugin did not install native OAuth sign-in')
  await expect(method.authorize()).rejects.toThrow('migration')
  expect(authorizeImpl).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
})

test('entrypoint retains only the plugin factory runtime export', async () => {
  expect(Object.keys(await import('../index.ts'))).toEqual([
    'AnthropicAuthPlugin',
  ])
})

const mainIdentity = '11111111-1111-4111-8111-111111111111'
const fallbackIdentity = '22222222-2222-4222-8222-222222222222'

async function migrateServingFixture(
  mode: 'local' | 'claustrum',
  fallback = false,
) {
  const paths = await resolveNativePoolPaths(
    configPath,
    process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
  )
  const hostAuthPath = join(directory, 'host-auth.json')
  const scopedReports: Array<{
    credentialId: string
    recordVersion: number
    providerStatus: number
  }> = []
  const authorizedGets: string[] = []
  let vaultVersion = 1
  const scopedClient: NativeCustodyClient = {
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
            recordVersion: vaultVersion,
            operations: ['read', 'invalidate'],
            createdAtMs: 1,
          },
          ...(fallback
            ? [
                {
                  id: 'oauth:secondary',
                  accountId: fallbackIdentity,
                  credentialType: 'oauth',
                  state: 'active',
                  categories: ['anthropic-native'],
                  serves: ['anthropic'],
                  providerIds: [],
                  refreshAdapter: 'anthropic',
                  recordVersion: vaultVersion,
                  operations: ['read', 'invalidate'],
                  createdAtMs: 1,
                },
              ]
            : []),
        ],
      }
    },
    async getScoped({ credentialId }) {
      authorizedGets.push(credentialId)
      return {
        credentialId,
        material: `sk-ant-oat01-vault-${credentialId === 'oauth:anthropic' ? 'main' : 'fallback'}-v${vaultVersion}`,
        accountId:
          credentialId === 'oauth:anthropic' ? mainIdentity : fallbackIdentity,
        recordVersion: vaultVersion,
        expiresAtMs: Date.now() + 8 * 60 * 60_000,
      }
    },
    async reportAuthFailureScoped(report) {
      scopedReports.push(report)
    },
    close() {},
  }
  const config = {
    version: 1,
    mainAccountId: 'primary-route',
    refresh: { enabled: false },
    quota: { enabled: false },
    routing: { mode: 'main-first' },
    ...(mode === 'claustrum'
      ? {
          claustrum: {
            mode,
            scopedRoster: true,
            primaryAccount: {
              credentialId: 'oauth:anthropic',
              accountId: mainIdentity,
              state: 'active',
            },
          },
        }
      : {}),
    accounts: fallback
      ? [
          {
            id: 'fallback-route',
            type: 'oauth',
            enabled: true,
            ...(mode === 'claustrum'
              ? {
                  refresh: '',
                  claustrumScopedCredentialId: 'oauth:secondary',
                  anthropicAccountUuid: fallbackIdentity,
                }
              : {
                  access: 'sk-ant-oat01-local-fallback',
                  refresh: 'synthetic-fallback-refresh',
                  expires: Date.now() + 8 * 60 * 60_000,
                }),
          },
        ]
      : [],
  }
  await writeFile(paths.legacyConfig, JSON.stringify(config), { mode: 0o600 })
  await writeFile(
    hostAuthPath,
    JSON.stringify({
      anthropic:
        mode === 'claustrum'
          ? custodyTombstoneOAuth('anthropic')
          : {
              type: 'oauth',
              access: 'sk-ant-oat01-local-main',
              refresh: 'synthetic-primary-refresh',
              expires: Date.now() + 8 * 60 * 60_000,
            },
      other: { type: 'api', key: 'synthetic-unrelated-provider' },
    }),
    { mode: 0o600 },
  )
  await writeFile(
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE!,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const journal = await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath,
    routingSourcePath: join(directory, 'legacy-routing.json'),
    routingDestinationPath: join(directory, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
    ...(mode === 'claustrum'
      ? {
          custody: {
            discover: () =>
              discoverNativeVaultInventory({
                paths,
                host: 'opencode',
                connect: async () => scopedClient,
              }),
            publishSeed: publishNativeVaultRosterSeed,
            publishRuntimeSeed: publishNativeVaultRuntimeSeed,
          },
        }
      : {}),
  })
  expect(journal.phase).toBe('retired')
  expect(journal.version).toBe(4)
  expect(JSON.parse(await readFile(hostAuthPath, 'utf8')).other).toEqual({
    type: 'api',
    key: 'synthetic-unrelated-provider',
  })
  const records: Array<{ url: string; authorization: string; body: string }> =
    []
  const fetchProvider = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString()
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    )
    const body = typeof init?.body === 'string' ? init.body : ''
    records.push({
      url,
      authorization: headers.get('authorization') ?? '',
      body,
    })
    if (url.includes('/oauth/token')) {
      const payload = JSON.parse(body)
      const isFallback = String(payload.refresh_token).includes('fallback')
      return Response.json({
        access_token: `sk-ant-oat01-local-${isFallback ? 'fallback' : 'main'}-rotated`,
        refresh_token: `synthetic-${isFallback ? 'fallback' : 'primary'}-successor`,
        expires_in: 28800,
      })
    }
    if (url.includes('/api/claude_cli/bootstrap')) {
      const uuid = headers.get('authorization')?.includes('fallback')
        ? fallbackIdentity
        : mainIdentity
      return Response.json({ oauth_account: { account_uuid: uuid } })
    }
    if (url.includes('/api/oauth/profile')) {
      const uuid = headers.get('authorization')?.includes('fallback')
        ? fallbackIdentity
        : mainIdentity
      return Response.json({
        account: { uuid },
        organization: {
          uuid: 'synthetic-org',
          billing_type: 'stripe',
          rate_limit_tier: 'default_claude_max_5x',
        },
      })
    }
    if (url.includes('/api/oauth/usage'))
      return Response.json({
        five_hour: {
          utilization: 5,
          resets_at: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
        },
        seven_day: {
          utilization: 10,
          resets_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        },
      })
    if (url.includes('/v1/messages'))
      return Response.json({
        id: 'synthetic-message',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'native-serving-ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    throw new Error(`Unexpected synthetic provider path: ${url}`)
  }
  network.mockImplementation(fetchProvider)
  return {
    paths,
    records,
    scopedReports,
    authorizedGets,
    scopedClient,
    fetchProvider,
    rotateVault: () => {
      vaultVersion++
    },
  }
}

async function sendNative(plugin: PluginHooks, model = 'claude-sonnet-4-6') {
  const options = await load(plugin, async () =>
    custodyTombstoneOAuth('anthropic'),
  )
  return requestFetch(options)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-affinity': `synthetic-session-${directory}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Synthetic native serving probe' }],
    }),
  })
}

test('real offline local migration serves only positively admitted pool OAuth, never SDK or legacy secrets', async () => {
  const fixture = await migrateServingFixture('local')
  const plugin = await createPlugin()
  const response = await sendNative(plugin)
  expect(response.status).toBe(200)
  const sent = fixture.records.filter((record) =>
    record.url.includes('/v1/messages'),
  )
  expect(sent).toHaveLength(1)
  expect(sent[0]?.authorization).toBe('Bearer sk-ant-oat01-local-main-rotated')
  expect(sent[0]?.body).not.toContain('synthetic-primary-refresh')
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    const snapshot = await runtime.read()
    expect(
      snapshot.accounts.find((account) => account.id === 'main')
        ?.accountIdentity,
    ).toBe(mainIdentity)
    expect(JSON.stringify(snapshot.policyStorage)).not.toContain('sk-ant-oat01')
  } finally {
    runtime.close()
  }
})

test('real offline vault migration freshly authorizes direct model attempts without local token rescue', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  expect((await sendNative(plugin)).status).toBe(200)
  const sent = fixture.records.filter((record) =>
    record.url.includes('/v1/messages'),
  )
  expect(sent).toHaveLength(1)
  expect(sent[0]?.authorization).toBe('Bearer sk-ant-oat01-vault-main-v1')
  expect(
    fixture.records.some((record) => record.url.includes('/oauth/token')),
  ).toBe(false)
  expect(fixture.scopedReports).toHaveLength(0)
})

test('supervised content after real migration refuses foreground and background dispatch', async () => {
  const fixture = await migrateServingFixture('local')
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
    anthropic: custodyTombstoneOAuth('anthropic'),
  })
  const plugin = await createPlugin()
  await expect(sendNative(plugin)).rejects.toThrow('OPENCODE_AUTH_CONTENT')
  expect(fixture.records).toHaveLength(0)
})

for (const transport of ['http', 'websocket'] as const) {
  test(`migrated vault ${transport} relay uses native private relay config and fresh vault receipt`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    const relay = new MockRelayServer()
    relays.add(relay)
    const address = await relay.start({ token: 'synthetic-native-relay-token' })
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    try {
      await runtime.updateRelay({
        enabled: true,
        url: address.url,
        token: 'synthetic-native-relay-token',
        transport,
        fallbackToDirect: false,
      })
      expect(JSON.stringify(await runtime.read())).not.toContain(
        'synthetic-native-relay-token',
      )
    } finally {
      runtime.close()
    }
    network.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      return url.startsWith(address.url)
        ? originalFetch(input, init)
        : fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    const response = await sendNative(plugin)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('native-serving-ok')
    expect(relay.acceptedRequests()).toBe(1)
    const sent = fixture.records.filter((record) =>
      record.url.includes('/v1/messages'),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.authorization).toBe('Bearer sk-ant-oat01-vault-main-v1')
  })
}

test('vault direct 401 retry reports only the final rejected physical credential version', async () => {
  const fixture = await migrateServingFixture('claustrum')
  let attempts = 0
  network.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('/v1/messages')) {
      attempts++
      fixture.records.push({
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: String(init?.body ?? ''),
      })
      if (attempts === 1) fixture.rotateVault()
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Synthetic physical rejection',
          },
        },
        { status: 401 },
      )
    }
    return fixture.fetchProvider(input, init)
  })
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  expect((await sendNative(plugin)).status).toBe(401)
  expect(attempts).toBe(2)
  expect(
    fixture.scopedReports.map((report) => ({
      credentialId: report.credentialId,
      recordVersion: report.recordVersion,
    })),
  ).toEqual([{ credentialId: 'oauth:anthropic', recordVersion: 2 }])
  expect(
    fixture.records
      .filter((record) => record.url.includes('/v1/messages'))
      .map((record) => record.authorization),
  ).toEqual([
    'Bearer sk-ant-oat01-vault-main-v1',
    'Bearer sk-ant-oat01-vault-main-v2',
  ])
})

test('native CacheKeep background prewarm cannot reuse a stored legacy bearer', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  let storage: Awaited<ReturnType<typeof runtime.read>>['policyStorage']
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      claudeCache: { enabled: true, mode: 'hybrid' },
      cacheKeep: { enabled: true, always: true },
    }))
    storage = (await runtime.read()).policyStorage
  } finally {
    runtime.close()
  }
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  await load(plugin, async () => custodyTombstoneOAuth('anthropic'))
  const cacheKeep: unknown = Reflect.get(plugin, '__cacheKeepManager')
  if (!(cacheKeep instanceof CacheKeepManager))
    throw new Error('Native host CacheKeep manager is unavailable')
  cacheKeep.track({
    sessionId: 'synthetic-background-session',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({
      authorization: 'Bearer synthetic-legacy-prewarm-canary',
      'content-type': 'application/json',
    }),
    bodyText: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Synthetic warm',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    }),
    storage,
    cacheMode: 'hybrid',
    oauthAccountId: 'main',
  })
  await cacheKeep.prewarmNow({
    sessionId: 'synthetic-background-session',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({
      authorization: 'Bearer synthetic-legacy-prewarm-canary',
      'content-type': 'application/json',
    }),
    bodyText: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Synthetic warm',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    }),
    oauthAccountId: 'main',
    isSubagent: false,
  })
  const sent = fixture.records.filter((record) =>
    record.url.includes('/v1/messages'),
  )
  expect(sent).toHaveLength(1)
  expect(sent[0]?.authorization).toBe('Bearer sk-ant-oat01-vault-main-v1')
  expect(JSON.stringify(fixture.records)).not.toContain(
    'synthetic-legacy-prewarm-canary',
  )
})

test('vault relay transport failure reauthorizes direct fallback without false credential rejection', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  const relayUrl = 'https://synthetic-native-relay.invalid'
  try {
    await runtime.updateRelay({
      enabled: true,
      url: relayUrl,
      token: 'synthetic-native-relay-token',
      transport: 'http',
      fallbackToDirect: true,
    })
  } finally {
    runtime.close()
  }
  network.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.startsWith(relayUrl)) {
      fixture.rotateVault()
      throw new Error('Synthetic relay connection failure')
    }
    return fixture.fetchProvider(input, init)
  })
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  expect((await sendNative(plugin)).status).toBe(200)
  expect(
    fixture.records
      .filter((record) => record.url.includes('/v1/messages'))
      .map((record) => record.authorization),
  ).toEqual(['Bearer sk-ant-oat01-vault-main-v2'])
  expect(fixture.scopedReports).toHaveLength(0)
})

test('native Prime performs one fresh usage poll before one minimal Haiku send', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      prime: { enabled: true },
    }))
  } finally {
    runtime.close()
  }
  let usagePolls = 0
  network.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('/api/oauth/usage')) {
      usagePolls++
      fixture.records.push({
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: '',
      })
      return Response.json({
        five_hour: {
          utilization: 0,
          resets_at: new Date(Date.now() - 120_000).toISOString(),
        },
        seven_day: {
          utilization: 0,
          resets_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        },
      })
    }
    return fixture.fetchProvider(input, init)
  })
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  await load(plugin, async () => custodyTombstoneOAuth('anthropic'))
  const prime: unknown = Reflect.get(plugin, '__primeManager')
  if (!(prime instanceof PrimeManager))
    throw new Error('Native host Prime manager is unavailable')
  await prime.tick()
  const sent = fixture.records.filter((record) =>
    record.url.includes('/v1/messages'),
  )
  expect(sent).toHaveLength(1)
  expect(usagePolls).toBe(1)
  expect(sent[0]?.authorization).toBe('Bearer sk-ant-oat01-vault-main-v1')
  expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({
    max_tokens: 1,
    model: expect.stringContaining('haiku'),
  })
  prime.stop()
})

for (const [fallback, scopedAge] of [
  [false, 0],
  [true, 0],
  [false, 60 * 60_000],
  [true, 60 * 60_000],
] as const) {
  test(`model-scoped primary exhaustion (${scopedAge ? 'stale' : 'fresh'}, fallback=${fallback}) preserves ordered admission`, async () => {
    const fixture = await migrateServingFixture('claustrum', fallback)
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
      vault: { connect: async () => fixture.scopedClient },
    })
    try {
      const receipt = await runtime.authorizeVault('main')
      expect(
        await runtime.vault.publish(receipt, {
          quota: {
            accountIdentity: mainIdentity,
            checkedAt: Date.now(),
            five_hour: {
              remainingPercent: 90,
              usedPercent: 10,
              checkedAt: Date.now(),
            },
            seven_day: {
              remainingPercent: 90,
              usedPercent: 10,
              checkedAt: Date.now(),
            },
            scoped: [
              {
                id: 'claude-weekly-scoped-fable',
                title: 'Fable only',
                modelName: 'Fable',
                remainingPercent: 0,
                usedPercent: 100,
                checkedAt: Date.now() - scopedAge,
                resetsAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
              },
            ],
          },
        }),
      ).toBe(true)
    } finally {
      runtime.close()
    }
    fixture.authorizedGets.length = 0
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    const response = await sendNative(plugin, 'claude-fable-5-1')
    expect(response.status).toBe(200)
    if (fallback && scopedAge === 0)
      expect(fixture.authorizedGets).not.toContain('oauth:anthropic')
    else expect(fixture.authorizedGets).toContain('oauth:anthropic')
    const sent = fixture.records.filter((record) =>
      record.url.includes('/v1/messages'),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.authorization).toBe(
      fallback && scopedAge === 0
        ? 'Bearer sk-ant-oat01-vault-fallback-v1'
        : 'Bearer sk-ant-oat01-vault-main-v1',
    )
    expect(
      fixture.records.some((record) => record.url.includes('/oauth/token')),
    ).toBe(false)
  })
}

test('OAuth SDK callback commits native credentials and returns only inert activation', async () => {
  const fixture = await migrateServingFixture('local')
  const authorization: typeof authorize = mock(async () => ({
    url: 'https://example.test/oauth',
    verifier: 'synthetic-verifier',
    state: 'synthetic-state',
    redirectUri: 'https://example.test/callback',
  }))
  const plugin = await createPlugin({ authorize: authorization })
  const method = plugin.auth?.methods[0]
  if (method?.type !== 'oauth')
    throw new Error('Native OAuth method is unavailable')
  const flow = await method.authorize()
  if (flow.method !== 'code')
    throw new Error('Expected code-based OAuth sign-in')
  const result = await flow.callback('synthetic-code#synthetic-state')
  const activation = custodyTombstoneOAuth('anthropic')
  expect(result).toMatchObject({
    type: 'success',
    access: activation.access,
    refresh: activation.refresh,
    expires: activation.expires,
  })
  expect(JSON.stringify(result)).not.toContain(
    'sk-ant-oat01-local-main-rotated',
  )
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    expect(
      (await runtime.read()).accounts.some(
        (account) => account.id === 'main' && account.type === 'oauth',
      ),
    ).toBe(true)
  } finally {
    runtime.close()
  }
})

test('optimistic websocket late 401 reports the exact served receipt, not a newer vault credential', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const relay = new MockRelayServer()
  relays.add(relay)
  const address = await relay.start({
    token: 'synthetic-native-relay-token',
    responseStartDelayMs: 5,
  })
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateRelay({
      enabled: true,
      url: address.url,
      token: 'synthetic-native-relay-token',
      transport: 'websocket',
      fallbackToDirect: false,
    })
  } finally {
    runtime.close()
  }
  const reportGate = lifetimes.gate()
  const reported = reportGate.wait
  const reportObserved = reportGate.open
  fixture.scopedClient.reportAuthFailureScoped = async (report) => {
    fixture.scopedReports.push(report)
    reportObserved()
  }
  network.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('/v1/messages')) {
      fixture.records.push({
        url,
        authorization: new Headers(init?.headers).get('authorization') ?? '',
        body: String(init?.body ?? ''),
      })
      fixture.rotateVault()
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Synthetic late websocket rejection',
          },
        },
        { status: 401 },
      )
    }
    return fixture.fetchProvider(input, init)
  })
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  const response = await sendNative(plugin)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('Relay upstream returned HTTP 401')
  await reported
  expect(
    fixture.scopedReports.map((report) => ({
      credentialId: report.credentialId,
      recordVersion: report.recordVersion,
    })),
  ).toEqual([{ credentialId: 'oauth:anthropic', recordVersion: 1 }])
  expect(
    fixture.records
      .filter((record) => record.url.includes('/v1/messages'))
      .map((record) => record.authorization),
  ).toEqual(['Bearer sk-ant-oat01-vault-main-v1'])
})

test('native serving suite lifetime joins detached fixture reads before body-owned cleanup', async () => {
  const ownedPath = configPath
  const expectedBytes = legacyBytes
  const readGate = lifetimes.gate()
  let completed = false
  lifetimes.trackDetached(
    (async () => {
      await readGate.wait
      expect(await readFile(ownedPath, 'utf8')).toBe(expectedBytes)
      completed = true
    })(),
  )
  lifetimes.deferCleanup(() => {
    expect(completed).toBe(true)
  })
  readGate.open()
})

// Every vault send site reports a 401 only for the receipt whose response is
// final. A strictly newer replay makes the served version obsolete whatever
// the replay's outcome; without one, the served version is the final record.
const rotatedDecision = { currentVersion: 2, retry: true, reason: 'rotated' }
const final401Cases = [
  {
    outcome: 'replay succeeds',
    reports: [],
    wire: [1, 2],
    decision: rotatedDecision,
  },
  {
    outcome: 'replay is also rejected',
    reports: [2],
    wire: [1, 2],
    decision: rotatedDecision,
  },
  {
    outcome: 'replay has a network error',
    reports: [],
    wire: [1, 2],
    decision: rotatedDecision,
  },
  {
    outcome: 'vault holds the same version',
    reports: [1],
    wire: [1],
    decision: { currentVersion: 1, retry: false, reason: 'version-not-newer' },
  },
  {
    outcome: 're-authorization fails',
    reports: [1],
    wire: [1],
    decision: {
      currentVersion: null,
      retry: false,
      reason: 'reauthorize-failed',
    },
  },
] as const
type Final401Case = (typeof final401Cases)[number]
type ServingFixture = Awaited<ReturnType<typeof migrateServingFixture>>

/** A synthetic Anthropic endpoint that rejects the first send it receives. */
function final401Upstream(fixture: ServingFixture, scenario: Final401Case) {
  const wire: string[] = []
  // An Anthropic request id is what lets a relayed status count as upstream.
  const provenance = { 'request-id': 'req_synthetic_final_401' }
  const rejection = () =>
    Response.json(
      {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Synthetic physical rejection',
        },
      },
      { status: 401, headers: provenance },
    )
  const handle = async (init?: RequestInit) => {
    wire.push(new Headers(init?.headers).get('authorization') ?? '')
    if (wire.length === 1) {
      if (scenario.outcome === 're-authorization fails')
        fixture.scopedClient.getScoped = async () => {
          throw new Error('synthetic vault unavailable')
        }
      else if (scenario.outcome !== 'vault holds the same version')
        fixture.rotateVault()
      return rejection()
    }
    if (scenario.outcome === 'replay has a network error')
      throw new TypeError('synthetic replay network failure')
    if (scenario.outcome === 'replay is also rejected') return rejection()
    return Response.json(
      {
        id: 'synthetic-message',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'native-serving-ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      { headers: provenance },
    )
  }
  return { wire, handle }
}

async function scoped401Decisions(run: () => Promise<unknown>) {
  const records: LogTestRecord[] = []
  const previousLevel = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  try {
    await run()
  } finally {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  }
  return records.filter(
    (record) => record.message === 'scoped 401 re-authorized',
  )
}

function expectFinal401Record(
  fixture: ServingFixture,
  scenario: Pick<Final401Case, 'decision'> & {
    reports: readonly number[]
    wire: readonly number[]
  },
  wire: string[],
  decisions: LogTestRecord[],
  site: string,
) {
  expect(wire).toEqual(
    scenario.wire.map(
      (version) => `Bearer sk-ant-oat01-vault-main-v${version}`,
    ),
  )
  expect(
    fixture.scopedReports.map((report) => ({
      credentialId: report.credentialId,
      recordVersion: report.recordVersion,
    })),
  ).toEqual(
    scenario.reports.map((recordVersion) => ({
      credentialId: 'oauth:anthropic',
      recordVersion,
    })),
  )
  expect(decisions.map((record) => record.payload)).toEqual([
    {
      site,
      credentialId: 'oauth:anthropic',
      servedVersion: 1,
      ...scenario.decision,
    },
  ])
  expect(JSON.stringify(decisions)).not.toContain('sk-ant-oat01')
  expect(JSON.stringify(decisions)).not.toContain('synthetic vault')
}

const primeWindows = () =>
  Response.json({
    five_hour: {
      utilization: 0,
      resets_at: new Date(Date.now() - 120_000).toISOString(),
    },
    seven_day: {
      utilization: 0,
      resets_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    },
  })

const cacheKeepPrewarmBody = JSON.stringify({
  model: 'claude-sonnet-4-6',
  max_tokens: 1,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Synthetic warm',
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ],
})

async function enablePrime(fixture: ServingFixture) {
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      prime: { enabled: true },
    }))
  } finally {
    runtime.close()
  }
}

async function tickPrime(plugin: PluginHooks) {
  await load(plugin, async () => custodyTombstoneOAuth('anthropic'))
  const prime: unknown = Reflect.get(plugin, '__primeManager')
  if (!(prime instanceof PrimeManager))
    throw new Error('Native host Prime manager is unavailable')
  try {
    return await scoped401Decisions(() => prime.tick().catch(() => {}))
  } finally {
    prime.stop()
  }
}

for (const scenario of final401Cases) {
  test(`vault direct model 401 reports only the final record when the ${scenario.outcome}`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    const upstream = final401Upstream(fixture, scenario)
    network.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      return url.includes('/v1/messages')
        ? upstream.handle(init)
        : fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    let status: unknown
    const decisions = await scoped401Decisions(async () => {
      status = await sendNative(plugin).then(
        (response) => response.status,
        (error: unknown) => error,
      )
    })
    if (scenario.outcome === 'replay succeeds') expect(status).toBe(200)
    else if (scenario.outcome === 'replay has a network error')
      expect(status).not.toBe(200)
    else expect(status).toBe(401)
    expectFinal401Record(fixture, scenario, upstream.wire, decisions, 'model')
  })

  test(`vault HTTP relay 401 reports only the final record when the ${scenario.outcome}`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    const relay = new MockRelayServer()
    relays.add(relay)
    const address = await relay.start({ token: 'synthetic-native-relay-token' })
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    try {
      await runtime.updateRelay({
        enabled: true,
        url: address.url,
        token: 'synthetic-native-relay-token',
        transport: 'http',
        fallbackToDirect: false,
      })
    } finally {
      runtime.close()
    }
    const upstream = final401Upstream(fixture, scenario)
    // A replay that cannot reach the relay at all is this transport's network
    // error; the relay itself never forwards it upstream.
    const relayNetworkError = scenario.outcome === 'replay has a network error'
    let replayRefused = false
    network.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.startsWith(address.url)) {
        if (
          relayNetworkError &&
          String(init?.body).includes('sk-ant-oat01-vault-main-v2')
        ) {
          replayRefused = true
          throw new TypeError('synthetic relay network failure')
        }
        return originalFetch(input, init)
      }
      return url.includes('/v1/messages')
        ? upstream.handle(init)
        : fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    let status: unknown
    const decisions = await scoped401Decisions(async () => {
      status = await sendNative(plugin).then(
        (response) => response.status,
        (error: unknown) => error,
      )
    })
    if (scenario.outcome === 'replay succeeds') expect(status).toBe(200)
    else if (scenario.outcome === 'replay has a network error')
      expect(status).not.toBe(200)
    else expect(status).toBe(401)
    expect(replayRefused).toBe(relayNetworkError)
    const forwarded = relayNetworkError ? { ...scenario, wire: [1] } : scenario
    expect(relay.acceptedRequests()).toBe(forwarded.wire.length)
    expectFinal401Record(
      fixture,
      forwarded,
      upstream.wire,
      decisions,
      'model-relay',
    )
  })

  test(`vault CacheKeep prewarm 401 reports only the final record when the ${scenario.outcome}`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    let storage: Awaited<ReturnType<typeof runtime.read>>['policyStorage']
    try {
      await runtime.updateSettings((settings) => ({
        ...settings,
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, always: true },
      }))
      storage = (await runtime.read()).policyStorage
    } finally {
      runtime.close()
    }
    const upstream = final401Upstream(fixture, scenario)
    network.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      return url.includes('/v1/messages')
        ? upstream.handle(init)
        : fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    await load(plugin, async () => custodyTombstoneOAuth('anthropic'))
    const cacheKeep: unknown = Reflect.get(plugin, '__cacheKeepManager')
    if (!(cacheKeep instanceof CacheKeepManager))
      throw new Error('Native host CacheKeep manager is unavailable')
    const target = {
      sessionId: 'synthetic-final-401-session',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers({ 'content-type': 'application/json' }),
      bodyText: cacheKeepPrewarmBody,
      oauthAccountId: 'main',
    }
    cacheKeep.track({ ...target, storage, cacheMode: 'hybrid' })
    const decisions = await scoped401Decisions(() =>
      cacheKeep.prewarmNow({ ...target, isSubagent: false }),
    )
    expectFinal401Record(
      fixture,
      scenario,
      upstream.wire,
      decisions,
      'cachekeep',
    )
  })

  test(`vault Prime 401 reports only the final record when the ${scenario.outcome}`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    await enablePrime(fixture)
    const upstream = final401Upstream(fixture, scenario)
    network.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/api/oauth/usage')) return primeWindows()
      return url.includes('/v1/messages')
        ? upstream.handle(init)
        : fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    const decisions = await tickPrime(plugin)
    expectFinal401Record(fixture, scenario, upstream.wire, decisions, 'prime')
  })

  test(`vault Prime quota preflight 401 reports only the final record when the ${scenario.outcome}`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    await enablePrime(fixture)
    const usage = final401Upstream(fixture, scenario)
    network.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (!url.includes('/api/oauth/usage'))
        return fixture.fetchProvider(input, init)
      const response = await usage.handle(init)
      return response.ok ? primeWindows() : response
    })
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    const decisions = await tickPrime(plugin)
    expectFinal401Record(
      fixture,
      scenario,
      usage.wire,
      decisions,
      'quota-profile',
    )
  })
}
