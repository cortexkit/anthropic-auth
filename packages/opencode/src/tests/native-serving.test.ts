import { afterEach, expect, mock, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setLogTestSink,
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  type authorize,
  CacheKeepManager,
  createNativeAccountRuntime,
  createNativePoolStore,
  custodyTombstoneOAuth,
  decideOpenCodeStateLayout,
  getClaudeCodeIdentityForVerifiedAccount,
  getLogLevel,
  HOLDER_FILE_NAME,
  type LogTestRecord,
  type NativeCustodyClient,
  type NativeLockEvent,
  PrimeManager,
  type ProviderAccountUuid,
  publishNativeEmptyInit,
  resetClaudeCodeIdentityCachesForTest,
  resetNativeHolderRegistryForTests,
  resetProcessStateLayoutsForTests,
  resetStateLayoutDecisionsForTests,
  resolveLocalRoutingDestination,
  resolveNativePoolPaths,
  runNativeMigration,
  StickySessionRouter,
  setLogLevel,
  setRelocationMoveEnabledForTests,
  stickyRouteFamilyForModel,
} from '@cortexkit/anthropic-auth-core'
import { mutateVaultRoster } from '@cortexkit/common-auth/claustrum'
import { createOpencodeClient, type Provider } from '@opencode-ai/sdk'
import { $ } from 'bun'
import {
  fromNativeQuotaMap,
  nativeQuotaCodec,
  toNativeQuotaMap,
} from '../../../core/src/native-quota-codec.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import {
  holdRefreshJoin,
  observeRefreshJoin,
  refreshedJoinAccess,
  refreshJoinMessage,
} from '../../../core/src/tests/native-refresh-join-fixture.ts'
import {
  holdQuotaPublicationForRefresh,
  quotaRefreshAccess,
} from '../../../core/src/tests/native-refresh-quota-fixture.ts'
import { holdNativeRelayLock } from '../../../core/src/tests/native-relay-lock-fixture.ts'
import { requestLockProbe } from '../../../core/src/tests/native-request-lock-fixture.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { MockRelayServer } from '../../../e2e-tests/src/mock-relay.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import { drainNotifications } from '../rpc/notifications.ts'
import { COMMAND_MODAL_NAMES } from '../rpc/protocol.ts'
import { getPluginTestHandles } from './plugin-test-handles'

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
  'XDG_DATA_HOME',
  'OPENCODE_CONFIG_DIR',
  'XDG_STATE_HOME',
  'TMPDIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN',
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
  // OpenCode's own login store for this test, never the user's.
  process.env.XDG_DATA_HOME = join(directory, 'synthetic-data')
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

const inertActivationError =
  'Native OAuth requires inert OpenCode activation; run offline setup'
const separateHostLogin = {
  type: 'oauth' as const,
  access: 'synthetic-host-access-canary',
  refresh: 'synthetic-host-refresh-canary',
  expires: 0,
}

async function emptyAdmissionPool(servable: boolean) {
  const paths = await resolveNativePoolPaths(
    configPath,
    process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
  )
  await publishNativeEmptyInit({
    paths,
    routingDestinationPath: resolveLocalRoutingDestination(
      'opencode',
      paths,
      process.env,
    ),
    env: { ...process.env },
    processFence: async () => {},
  })
  if (servable) {
    const runtime = createNativeAccountRuntime({
      paths,
      host: 'opencode',
      local: {
        resolveIdentity: async () => ({
          accountUuid:
            '11111111-1111-4111-8111-111111111111' as ProviderAccountUuid,
          deviceId: 'synthetic-device',
          sessionId: 'synthetic-session',
        }),
      },
    })
    try {
      await runtime.loginOAuth({
        routeId: 'main',
        credential: {
          access: 'sk-ant-oat01-native-only',
          refresh: 'synthetic-native-refresh',
          expires: Date.now() + 28_800_000,
        },
      })
      await runtime.updateSettings((settings) => ({
        ...settings,
        refresh: { enabled: false },
        quota: { enabled: false },
      }))
    } finally {
      runtime.close()
    }
  }
  return paths
}

async function refusedAdmission(auth = separateHostLogin) {
  const plugin = await createPlugin()
  const options = await load(plugin, async () => auth)
  return requestFetch(options)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
  })
}

test('separate OC1 login preserves migration-required without a journal', async () => {
  await expect(refusedAdmission()).rejects.toMatchObject({
    name: 'NativeAuthorityError',
    code: 'migration-required',
  })
  expect(network).not.toHaveBeenCalled()
})

test('separate OC1 login preserves migration-incomplete for a building journal', async () => {
  const f = await migrateServingFixture('local')
  const journal = JSON.parse(await readFile(f.paths.journal, 'utf8'))
  await writeFile(
    f.paths.journal,
    JSON.stringify({
      ...journal,
      phase: 'building',
      expectedHostAuth: 'unprepared',
      expectedRouting: 'unprepared',
      preparedProof: null,
    }),
    { mode: 0o600 },
  )
  await expect(refusedAdmission()).rejects.toMatchObject({
    name: 'NativeAuthorityError',
    code: 'migration-incomplete',
  })
  expect(f.records).toHaveLength(0)
})

test('separate OC1 login with committed empty pool refuses before custody', async () => {
  await emptyAdmissionPool(false)
  await expect(refusedAdmission()).rejects.toThrow(inertActivationError)
  expect(network).not.toHaveBeenCalled()
})

for (const kind of ['orphan', 'quota-only'] as const) {
  test(`separate OC1 login with ${kind} metadata refuses before custody`, async () => {
    const paths = await emptyAdmissionPool(false)
    if (kind === 'orphan') {
      await writeFile(
        paths.runtime,
        JSON.stringify({
          version: 1,
          storageId: paths.storageId,
          accounts: {
            orphan: {
              binding: {
                kind: 'local',
                storageId: paths.storageId,
                rowId: 'orphan',
                credentialEpoch: 1,
              },
              lastUsed: 1,
            },
          },
        }),
        { mode: 0o600 },
      )
    } else {
      const store = createNativePoolStore({ paths, quota: nativeQuotaCodec })
      await store.updateSettings((settings) => ({
        ...settings,
        quota: { enabled: false },
      }))
      const config = JSON.parse(await readFile(paths.config, 'utf8'))
      config.commonAuthPool = {
        schemaVersion: 1,
        rows: {
          orphan: {
            quota: toNativeQuotaMap({
              checkedAt: 1,
              five_hour: {
                usedPercent: 10,
                remainingPercent: 90,
                checkedAt: 1,
              },
            }),
          },
        },
      }
      await writeFile(paths.config, JSON.stringify(config), { mode: 0o600 })
      const read = await store.read()
      if (read.status !== 'ready')
        throw new Error('Expected readable quota-only pool')
      expect(read.rows).toEqual([])
    }
    await expect(refusedAdmission()).rejects.toThrow(inertActivationError)
    expect(network).not.toHaveBeenCalled()
  })
}

test('incomplete OC1 OAuth records refuse before custody even with servable native OAuth', async () => {
  await emptyAdmissionPool(true)
  for (const auth of [
    { ...separateHostLogin, access: '' },
    { ...separateHostLogin, refresh: '' },
  ])
    await expect(refusedAdmission(auth)).rejects.toThrow(inertActivationError)
  expect(network).not.toHaveBeenCalled()
})

test('OC1 Accounts rechecks the separate host login on every render and hides X records', async () => {
  await emptyAdmissionPool(true)
  let auth = { ...separateHostLogin }
  const plugin = await createPlugin()
  await load(plugin, async () => auth)
  const sessionID = 'separate-login-notice-session'
  async function render() {
    drainNotifications(0, sessionID)
    await expect(
      plugin['command.execute.before']!(
        { command: 'claude', arguments: '', sessionID },
        { parts: [] },
      ),
    ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
    const notification = drainNotifications(0, sessionID).at(-1)
    if (notification?.type !== 'open-menu')
      throw new Error('Expected native menu')
    return notification.payload.menu.sections
      .flatMap((section) => section.lines)
      .filter((line) => line.startsWith("OpenCode's separate Anthropic login"))
  }
  expect(await render()).toHaveLength(1)
  expect(await render()).toHaveLength(1)
  auth = custodyTombstoneOAuth('anthropic')
  expect(await render()).toHaveLength(0)
  auth = { ...separateHostLogin, access: '' }
  expect(await render()).toHaveLength(0)
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
  // The account the vault's default credential belongs to; the user can
  // replace it with a different account under the same credential ID.
  let defaultIdentity = mainIdentity
  const scopedClient: NativeCustodyClient = {
    async listScoped() {
      return {
        view: 'synthetic-native-view',
        rows: [
          {
            id: 'oauth:anthropic',
            accountId: defaultIdentity,
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
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped({ credentialId }) {
      authorizedGets.push(credentialId)
      return {
        credentialId,
        material: `sk-ant-oat01-vault-${credentialId === 'oauth:anthropic' ? 'main' : 'fallback'}-v${vaultVersion}`,
        accountId:
          credentialId === 'oauth:anthropic'
            ? defaultIdentity
            : fallbackIdentity,
        recordVersion: vaultVersion,
        expiresAtMs: Date.now() + 8 * 60 * 60_000,
      }
    },
    async reportAuthFailureScoped(report) {
      scopedReports.push(report)
    },
    close() {},
  }
  if (mode === 'claustrum') {
    // The plugin serves Claude from the credential vault when this host's
    // enrollment token file exists (readable by its owner only, mode 0600);
    // the account settings no longer decide that. Vault account settings,
    // account list and metadata are separate files beside the local ones.
    // Write the token, create empty vault settings, then ask the vault for its
    // account list once: that records the accounts and marks the default
    // account as main. Local credentials are never migrated or touched.
    await writeFile(
      process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE!,
      JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
    const vaultPaths = nativeVaultPaths(paths)
    await createNativePoolStore({
      paths: vaultPaths,
      quota: nativeQuotaCodec,
    }).initialize()
    const runtime = createNativeAccountRuntime({
      paths,
      host: 'opencode',
      vault: { connect: async () => scopedClient },
    })
    try {
      expect((await runtime.read()).mode).toBe('claustrum')
      await runtime.vault.refresh()
      await runtime.updateSettings((settings) => ({
        ...settings,
        refresh: { enabled: false },
        quota: { enabled: false },
        routing: { mode: 'main-first' },
      }))
      const snapshot = await runtime.read()
      expect(snapshot.routingPath).toBe(vaultPaths.routing)
      expect(
        snapshot.accounts.find((account) => account.id === 'main')
          ?.accountIdentity,
      ).toBe(mainIdentity)
    } finally {
      runtime.close()
    }
    // The local account files stay exactly as the user left them.
    expect(await readFile(configPath, 'utf8')).toBe(legacyBytes)
  } else {
    const config = {
      version: 1,
      mainAccountId: 'primary-route',
      refresh: { enabled: false },
      quota: { enabled: false },
      routing: { mode: 'main-first' },
      accounts: fallback
        ? [
            {
              id: 'fallback-route',
              type: 'oauth',
              enabled: true,
              access: 'sk-ant-oat01-local-fallback',
              refresh: 'synthetic-fallback-refresh',
              expires: Date.now() + 8 * 60 * 60_000,
            },
          ]
        : [],
    }
    await writeFile(paths.legacyConfig, JSON.stringify(config), {
      mode: 0o600,
    })
    await writeFile(
      hostAuthPath,
      JSON.stringify({
        anthropic: {
          type: 'oauth',
          access: 'sk-ant-oat01-local-main',
          refresh: 'synthetic-primary-refresh',
          expires: Date.now() + 8 * 60 * 60_000,
        },
        other: { type: 'api', key: 'synthetic-unrelated-provider' },
      }),
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
    })
    expect(journal.phase).toBe('retired')
    expect(journal.version).toBe(4)
    expect(JSON.parse(await readFile(hostAuthPath, 'utf8')).other).toEqual({
      type: 'api',
      key: 'synthetic-unrelated-provider',
    })
  }
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
    replaceDefaultAccount: (identity: string) => {
      defaultIdentity = identity
    },
  }
}

async function sendNative(
  plugin: PluginHooks,
  model = 'claude-sonnet-4-6',
  sessionId = `synthetic-session-${directory}`,
  stream = false,
  signal?: AbortSignal,
) {
  const options = await load(plugin, async () =>
    custodyTombstoneOAuth('anthropic'),
  )
  return requestFetch(options)('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-session-affinity': sessionId,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      ...(stream && { stream: true }),
      messages: [{ role: 'user', content: 'Synthetic native serving probe' }],
    }),
  })
}

test('OC1 abort ends a stalled quota preflight without sending a model request', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
    vault: { connect: async () => fixture.scopedClient },
  })
  await runtime.updateSettings((settings) => ({
    ...settings,
    routing: { mode: 'sticky-balanced' },
  }))
  runtime.close()
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  network.mockImplementation(async (input, init) => {
    if (String(input).includes('/api/oauth/usage')) {
      entered.open()
      await release.wait
    }
    return fixture.fetchProvider(input, init)
  })
  const controller = new AbortController()
  const reason = new Error('synthetic header timeout')
  const pending = sendNative(
    plugin,
    undefined,
    undefined,
    false,
    controller.signal,
  ).catch((error: unknown) => error)
  try {
    await entered.wait
    controller.abort(reason)
    expect(
      await Promise.race([pending, Bun.sleep(500).then(() => 'still waiting')]),
    ).toBe(reason)
  } finally {
    release.open()
  }
  await pending
  await plugin.dispose?.()
  expect(
    fixture.records.filter((record) => record.url.includes('/v1/messages')),
  ).toEqual([])
})

for (const concurrency of [4, 8]) {
  test(`OC1 concurrent local sends retain quota and lastUsed N=${concurrency}`, async () => {
    const fixture = await migrateServingFixture('local')
    const locks: string[] = []
    const plugin = await createPlugin({
      nativeLocal: {
        onLockEvent: (event: NativeLockEvent) => {
          if (event.type === 'acquired') locks.push(event.name)
        },
      },
    })
    await (await sendNative(plugin)).text()
    network.mockImplementation(async (input, init) => {
      const response = await fixture.fetchProvider(input, init)
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/v1/messages')) {
        response.headers.set(
          'anthropic-ratelimit-unified-5h-utilization',
          '0.25',
        )
        response.headers.set(
          'anthropic-ratelimit-unified-7d-utilization',
          '0.4',
        )
      }
      return response
    })
    const records: LogTestRecord[] = []
    const previous = getLogLevel()
    setLogLevel('debug')
    __setLogTestSink((record) => records.push(record))
    lifetimes.deferCleanup(() => {
      __setLogTestSink(null)
      setLogLevel(previous)
    })
    locks.length = 0
    const start = Date.now()
    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        sendNative(plugin, 'claude-sonnet-4-6', `parallel-${index}`),
      ),
    )
    await Promise.all(responses.map((response) => response.text()))
    expect(responses.every((response) => response.status === 200)).toBe(true)
    await plugin.dispose?.()
    // Read through a fresh store so an in-memory quota reading cannot mask a
    // write that has not reached disk.
    const diskStore = createNativePoolStore({
      paths: fixture.paths,
      quota: nativeQuotaCodec,
    })
    lifetimes.deferCleanup(() => diskStore.close())
    const disk = await diskStore.read()
    if (disk.status !== 'ready')
      throw new Error('Expected a ready pool after disposal')
    const diskQuota = disk.rows.find(
      (row) => row.identity === mainIdentity,
    )?.quota
    expect(fromNativeQuotaMap(diskQuota).five_hour?.remainingPercent).toBe(75)
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    lifetimes.deferCleanup(() => runtime.close())
    const account = (await runtime.read()).accounts.find(
      (account) => account.id === 'main',
    )!
    const dropped = records.filter(
      (record) =>
        record.message === 'Account usage publication unavailable' ||
        record.message === 'Quota publication discarded',
    ).length
    const contention = records.filter((record) =>
      JSON.stringify(record.payload ?? {}).includes('LockContentionError'),
    ).length
    console.log(
      `local OC1 N=${concurrency}: dropped=${dropped} LockContentionError=${contention} pool-config=${locks.filter((name) => name === 'pool-config').length} native-runtime=${locks.filter((name) => name === 'native-runtime').length}`,
    )
    expect(dropped).toBe(0)
    expect(contention).toBe(0)
    expect(account.quota?.five_hour?.remainingPercent).toBe(75)
    expect(account.lastUsed).toBeGreaterThanOrEqual(start)
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

test('separate OC1 login serves only native pool credentials and refreshes without host tokens', async () => {
  const f = await migrateServingFixture('local')
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    local: {
      resolveIdentity: async () => ({
        accountUuid: mainIdentity as ProviderAccountUuid,
        deviceId: 'synthetic-device',
        sessionId: 'synthetic-session',
      }),
    },
  })
  try {
    await runtime.loginOAuth({
      routeId: 'main',
      credential: {
        access: 'sk-ant-oat01-native-expired',
        refresh: 'synthetic-primary-refresh',
        expires: 0,
      },
    })
  } finally {
    runtime.close()
  }
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  try {
    const plugin = await createPlugin()
    const options = await load(plugin, async () => separateHostLogin)
    const response = await requestFetch(options)(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8,
          messages: [{ role: 'user', content: 'native probe' }],
        }),
      },
    )
    expect(response.status).toBe(200)
    await response.text()
    expect(
      f.records
        .filter((record) => record.url.includes('/v1/messages'))
        .map((record) => record.authorization),
    ).toEqual(['Bearer sk-ant-oat01-local-main-rotated'])
    expect(
      f.records.some(
        (record) =>
          record.url.includes('/oauth/token') &&
          record.body.includes('synthetic-primary-refresh'),
      ),
    ).toBe(true)
    const evidence = JSON.stringify({ records: f.records, logs })
    expect(evidence).not.toContain(separateHostLogin.access)
    expect(evidence).not.toContain(separateHostLogin.refresh)
  } finally {
    __setLogTestSink(null)
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

test('OC1 saved refresh serves the successor across a pending quota publication', async () => {
  const fixture = await migrateServingFixture('local')
  const warmup = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  const admitted = await warmup.authorizeLocal('main')
  await warmup.close()
  if (admitted.status !== 'usable')
    throw new Error('Missing initial authorization')
  const held = holdQuotaPublicationForRefresh(lifetimes)
  const local = {
    refreshToken: held.refreshToken,
    resolveIdentity: async () => ({
      accountUuid: mainIdentity as ProviderAccountUuid,
      deviceId: 'fixture',
      sessionId: 'fixture',
    }),
  }
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
    local,
  })
  lifetimes.deferCleanup(() => runtime.close())
  await held.poll(runtime)
  const sent: string[] = []
  network.mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('/v1/messages')) {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      if (sent.length === 1)
        return Promise.resolve(Response.json({}, { status: 401 }))
    }
    return fixture.fetchProvider(input, init)
  })
  const plugin = await createPlugin({ nativeLocal: local })
  expect((await sendNative(plugin)).status).toBe(200)
  expect(sent).toEqual([
    `Bearer ${admitted.access}`,
    `Bearer ${quotaRefreshAccess}`,
  ])
  expect(held.exchanges()).toBe(1)
  expect(await runtime.authorizeLocal('main')).toMatchObject({
    status: 'usable',
    source: 'current',
    access: quotaRefreshAccess,
  })
})

for (const scenario of ['proactive', '401', 'deadline'] as const) {
  test(`OC1 refresh join ${scenario} preserves valid-token admission`, async () => {
    const fixture = await migrateServingFixture('local')
    const warmup = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    let initialAccess: string
    try {
      const admitted = await warmup.authorizeLocal('main')
      if (admitted.status !== 'usable')
        throw new Error('Missing initial authorization')
      initialAccess = admitted.access
    } finally {
      await warmup.close()
    }
    const held = holdRefreshJoin(lifetimes)
    const probe = requestLockProbe()
    const local = {
      onLockEvent: probe.onLockEvent,
      refreshToken: held.refreshToken,
      resolveIdentity: async () =>
        getClaudeCodeIdentityForVerifiedAccount(
          'main',
          mainIdentity as ProviderAccountUuid,
        ),
    }
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
      local,
    })
    lifetimes.deferCleanup(() => runtime.close())
    const sent: string[] = []
    const completedAtDispatch: boolean[] = []
    network.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/v1/messages')) {
        const access = new Headers(init?.headers).get('authorization') ?? ''
        sent.push(access)
        completedAtDispatch.push(held.completed())
        probe.dispatch()
        if (scenario !== 'proactive' && sent.length === 1)
          return Promise.resolve(Response.json({}, { status: 401 }))
      }
      return fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({ nativeLocal: local })
    const options = await load(plugin, async () =>
      custodyTombstoneOAuth('anthropic'),
    )
    const send = () =>
      requestFetch(options)('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Refresh join probe' }],
        }),
      })
    const owner =
      scenario === 'proactive'
        ? runtime.authorizeLocal('main', { intent: 'refresh' })
        : send()
    void owner.catch(() => {})
    let waiting: Promise<Response> | undefined
    try {
      await held.entered
      probe.begin()
      waiting = send()
      if (scenario === 'proactive') {
        expect((await observeRefreshJoin(waiting)).status).toBe('fulfilled')
        expect(completedAtDispatch).toEqual([false])
        expect(sent).toEqual([`Bearer ${initialAccess}`])
        expect(probe.foreground).toEqual([])
      } else if (scenario === '401') {
        expect((await observeRefreshJoin(waiting, 100)).status).toBe('pending')
        expect(sent).toEqual([`Bearer ${initialAccess}`])
        held.release()
        expect((await waiting).status).toBe(200)
        expect(((await owner) as Response).status).toBe(200)
        expect(sent).toEqual([
          `Bearer ${initialAccess}`,
          `Bearer ${refreshedJoinAccess}`,
          `Bearer ${refreshedJoinAccess}`,
        ])
      } else {
        expect(await observeRefreshJoin(waiting, 3_500)).toMatchObject({
          status: 'rejected',
          error: { message: refreshJoinMessage, code: 'ECONNRESET' },
        })
        expect(held.completed()).toBe(false)
        expect(sent).toEqual([`Bearer ${initialAccess}`])
      }
    } finally {
      held.release()
      await Promise.allSettled([owner, ...(waiting ? [waiting] : [])])
    }
  }, 8_000)
}

for (const scenario of ['local-healthy', 'vault-healthy', 'refresh'] as const) {
  test(`OC1 ${scenario} request observes only required foreground locks`, async () => {
    const fixture = await migrateServingFixture(
      scenario === 'vault-healthy' ? 'claustrum' : 'local',
    )
    const probe = requestLockProbe()
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
      vault: { connect: async () => fixture.scopedClient },
    })
    lifetimes.deferCleanup(async () => {
      await runtime.drainRoutingPublications()
      runtime.close()
    })
    if (scenario === 'local-healthy')
      expect((await runtime.authorizeLocal('main')).status).toBe('usable')
    if (scenario !== 'refresh') {
      await runtime.fetchQuota(
        'main',
        Object.assign(fixture.fetchProvider, {
          preconnect: originalFetch.preconnect,
        }),
      )
      await runtime.drainQuotaPublications()
    }
    await runtime.updateSettings((settings) => {
      settings.routing = { mode: 'sticky-balanced' }
    })
    await runtime.read()
    await runtime.drainRoutingPublications()
    // The pool accepts quota before it reaches disk. Finish the seed runtime's
    // drain before measuring a healthy request in an independent runtime.
    await runtime.close()
    network.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/v1/messages')) probe.dispatch()
      return fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({
      nativeLocal: { onLockEvent: probe.onLockEvent },
      ...(scenario === 'vault-healthy'
        ? { claustrumScopedConnect: async () => fixture.scopedClient }
        : {}),
    })
    // Plugin start recorded this process beside the pool files; the request
    // below must still take no foreground lock for it.
    const holders = JSON.parse(
      await readFile(
        join(dirname(fixture.paths.runtime), 'anthropic-auth-holders.json'),
        'utf8',
      ),
    ) as { entries: Array<{ pid: number; role: string }> }
    expect(holders.entries).toContainEqual(
      expect.objectContaining({ pid: process.pid, role: 'opencode1' }),
    )
    probe.begin()
    const response = await sendNative(plugin)
    expect(response.status).toBe(200)
    await response.text()
    if (scenario === 'refresh')
      expect(
        probe.foreground.some(
          (event) =>
            event.name.startsWith('native-account-provider-') &&
            event.path === fixture.paths.state,
        ),
      ).toBe(true)
    else expect(probe.foreground).toEqual([])
    await plugin.dispose?.()
    expect(probe.detached.some((event) => event.name === 'write')).toBe(true)
    expect(probe.afterDispatch.length).toBeGreaterThan(0)
    expect(
      probe.afterDispatch.some((event) => event.name === 'native-runtime'),
    ).toBe(true)
    // Vault bookkeeping after the reply writes runtime state under its own
    // lock only; it must never take the shared roster lock, which other
    // processes need for quota readings and discovery.
    if (scenario === 'vault-healthy')
      expect(
        probe.afterDispatch.some(
          (event) => event.name === 'claustrum-roster-write',
        ),
      ).toBe(false)
  })
}

/** Forget every layout decision and registration this process made. */
function forgetLayoutDecisions() {
  resetStateLayoutDecisionsForTests()
  resetProcessStateLayoutsForTests()
  resetNativeHolderRegistryForTests()
}

for (const moveEnabled of [false, true]) {
  test(`OC1 decides the layout at plugin start with moving ${moveEnabled ? 'on' : 'off'}`, async () => {
    const configDir = join(directory, 'config')
    const stateRoot = join(directory, 'state')
    await mkdir(configDir)
    await mkdir(join(directory, 'tmp'))
    // OpenCode's own config folder, with no override naming its files.
    for (const key of [
      'OPENCODE_ANTHROPIC_AUTH_FILE',
      'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
      'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
      'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
    ])
      delete process.env[key]
    process.env.OPENCODE_CONFIG_DIR = configDir
    process.env.XDG_STATE_HOME = stateRoot
    // Older versions' pid artifacts are looked for under the temporary folder.
    process.env.TMPDIR = join(directory, 'tmp')
    forgetLayoutDecisions()
    setRelocationMoveEnabledForTests(moveEnabled)
    lifetimes.deferCleanup(() => {
      setRelocationMoveEnabledForTests(undefined)
      forgetLayoutDecisions()
    })
    await createPlugin()
    const parent = join(stateRoot, 'cortexkit', 'anthropic-auth')
    const subs = (await readdir(parent).catch(() => [] as string[])).filter(
      (name) => name.startsWith('opencode-'),
    )
    const entries = async (dir: string) =>
      (
        JSON.parse(await readFile(join(dir, HOLDER_FILE_NAME), 'utf8')) as {
          entries: Array<Record<string, unknown>>
        }
      ).entries
    if (!moveEnabled) {
      expect(subs).toEqual([])
      expect(await entries(configDir)).toContainEqual(
        expect.objectContaining({ role: 'opencode1', kind: 'legacy' }),
      )
      return
    }
    expect(subs).toHaveLength(1)
    const sub = join(parent, subs[0] as string)
    expect(
      JSON.parse(await readFile(join(sub, 'layout.json'), 'utf8')),
    ).toMatchObject({ phase: 'committed', cleanup: 'done' })
    expect(await entries(sub)).toContainEqual(
      expect.objectContaining({ role: 'opencode1', kind: 'state-home' }),
    )
  })
}

test('OC1 local-healthy request in the state-home layout observes no foreground lock', async () => {
  const fixture = await migrateServingFixture('local')
  // The dataset's config folder is the fixture folder; the state folder
  // must lie outside it.
  const stateRoot = `${directory}-state`
  lifetimes.deferCleanup(() => rm(stateRoot, { recursive: true, force: true }))
  forgetLayoutDecisions()
  lifetimes.deferCleanup(forgetLayoutDecisions)
  // An earlier start, with no override, moved the dataset.
  const moved = await decideOpenCodeStateLayout({
    role: 'opencode1',
    env: { OPENCODE_CONFIG_DIR: directory, XDG_STATE_HOME: stateRoot },
    moveEnabled: true,
    // That start has exited; nothing else is running.
    liveness: {
      pidAlive: (pid) => pid !== process.pid,
      incarnation: async () => null,
    },
    artifacts: { rpcRoots: [], rpcDirs: [], cacheKeepDirs: [] },
  })
  if (moved.kind !== 'state-home') throw new Error('the fixture did not move')
  const paths = moved.dataset.newPaths
  expect(paths.storageId).toBe(fixture.paths.storageId)
  forgetLayoutDecisions()
  // This start finds the dataset through OpenCode's config folder; its other
  // overrides (routing, enrollment) never move, but serve a finished move.
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  process.env.OPENCODE_CONFIG_DIR = directory
  process.env.XDG_STATE_HOME = stateRoot
  const probe = requestLockProbe()
  const runtime = createNativeAccountRuntime({ paths, host: 'opencode' })
  lifetimes.deferCleanup(async () => {
    await runtime.drainRoutingPublications()
    runtime.close()
  })
  expect((await runtime.authorizeLocal('main')).status).toBe('usable')
  await runtime.fetchQuota(
    'main',
    Object.assign(fixture.fetchProvider, {
      preconnect: originalFetch.preconnect,
    }),
  )
  await runtime.drainQuotaPublications()
  await runtime.updateSettings((settings) => {
    settings.routing = { mode: 'sticky-balanced' }
  })
  await runtime.read()
  await runtime.drainRoutingPublications()
  await runtime.close()
  network.mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (url.includes('/v1/messages')) probe.dispatch()
    return fixture.fetchProvider(input, init)
  })
  const plugin = await createPlugin({
    nativeLocal: { onLockEvent: probe.onLockEvent },
  })
  // Plugin start recorded this process in the state folder; the request
  // below must still take no foreground lock for it.
  const holders = JSON.parse(
    await readFile(join(dirname(paths.runtime), HOLDER_FILE_NAME), 'utf8'),
  ) as { entries: Array<{ pid: number; role: string; kind: string }> }
  expect(holders.entries).toContainEqual(
    expect.objectContaining({
      pid: process.pid,
      role: 'opencode1',
      kind: 'state-home',
    }),
  )
  probe.begin()
  const response = await sendNative(plugin)
  expect(response.status).toBe(200)
  await response.text()
  expect(probe.foreground).toEqual([])
  await plugin.dispose?.()
  expect(probe.afterDispatch.length).toBeGreaterThan(0)
})

test('OC1 inconsistent relay pair refuses locally without any dispatch', async () => {
  const fixture = await migrateServingFixture('local')
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  lifetimes.deferCleanup(() => runtime.close())
  await runtime.updateRelay({
    enabled: true,
    url: 'https://never-send.invalid',
    token: 'synthetic-never-send-token',
  })
  await createNativePoolStore({
    paths: fixture.paths,
    quota: nativeQuotaCodec,
  }).updateSettings((settings) => {
    ;(settings.relay as Record<string, unknown>).generation = 'mismatched'
  })
  const plugin = await createPlugin()
  const response = await sendNative(plugin)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({
    error: {
      type: 'invalid_request_error',
      message:
        'request refused: relay configuration is inconsistent; no request was sent',
    },
  })
  expect(
    fixture.records.filter((record) => record.url.includes('/v1/messages')),
  ).toHaveLength(0)
})

for (const configured of [false, true]) {
  test(`OC1 request ignores held native-relay lock (${configured ? 'relay' : 'direct'})`, async () => {
    const fixture = await migrateServingFixture('local')
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
    })
    lifetimes.deferCleanup(() => runtime.close())
    const relay = new MockRelayServer()
    relays.add(relay)
    const address = await relay.start({ token: 'synthetic-held-relay-token' })
    if (configured)
      await runtime.updateRelay({
        enabled: true,
        url: address.url,
        token: 'synthetic-held-relay-token',
        transport: 'http',
        fallbackToDirect: false,
      })
    network.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      return url.startsWith(address.url)
        ? originalFetch(input, init)
        : fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin()
    const held = await holdNativeRelayLock(fixture.paths.config, lifetimes)
    try {
      const response = await sendNative(plugin)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('native-serving-ok')
      expect(relay.acceptedRequests()).toBe(configured ? 1 : 0)
      expect(await runtime.getRelayConfig()).toEqual(
        configured
          ? {
              enabled: true,
              url: address.url,
              token: 'synthetic-held-relay-token',
              transport: 'http',
              fallbackToDirect: false,
            }
          : null,
      )
      await held.assertOwned()
    } finally {
      await held.pastTimeout
      await held.release()
    }
  }, 25_000)
}

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
  const cacheKeep: unknown = getPluginTestHandles(plugin).cacheKeepManager
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

test('native CacheKeep returns a terminal killswitch refusal without authorizing or sending', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      killswitch: { enabled: true, main: { five_hour: 5, seven_day: 0 } },
    }))
  } finally {
    runtime.close()
  }
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  await load(plugin, async () => custodyTombstoneOAuth('anthropic'))
  const cacheKeep = getPluginTestHandles(plugin).cacheKeepManager
  if (!(cacheKeep instanceof CacheKeepManager))
    throw new Error('No CacheKeep manager')
  const reads = fixture.authorizedGets.length
  expect(
    await cacheKeep.prewarmNow({
      sessionId: 'synthetic-policy-session',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText: cacheKeepPrewarmBody,
      oauthAccountId: 'main',
    }),
  ).toEqual({ ok: false, reason: 'account-policy', refusal: 'account-policy' })
  expect(fixture.authorizedGets).toHaveLength(reads)
  expect(
    fixture.records.filter((record) => record.url.includes('/v1/messages')),
  ).toEqual([])
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
  const prime: unknown = getPluginTestHandles(plugin).primeManager
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

for (const mode of ['main-first', 'fallback-first'] as const) {
  for (const [fallback, scopedAge] of [
    [false, 0],
    [true, 0],
    [false, 60 * 60_000],
    [true, 60 * 60_000],
  ] as const) {
    test(`model-scoped primary exhaustion (${scopedAge ? 'stale' : 'fresh'}, fallback=${fallback}, mode=${mode}) preserves ordered admission`, async () => {
      const fixture = await migrateServingFixture('claustrum', fallback)
      const runtime = createNativeAccountRuntime({
        paths: fixture.paths,
        host: 'opencode',
        vault: { connect: async () => fixture.scopedClient },
      })
      try {
        await runtime.updateSettings((settings) => ({
          ...settings,
          routing: { mode },
        }))
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
                  resetsAt: new Date(
                    Date.now() + 24 * 60 * 60_000,
                  ).toISOString(),
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
      const usesFallback =
        fallback && (mode === 'fallback-first' || scopedAge === 0)
      if (usesFallback)
        expect(fixture.authorizedGets).not.toContain('oauth:anthropic')
      else expect(fixture.authorizedGets).toContain('oauth:anthropic')
      const sent = fixture.records.filter((record) =>
        record.url.includes('/v1/messages'),
      )
      expect(sent).toHaveLength(1)
      expect(sent[0]?.authorization).toBe(
        usesFallback
          ? 'Bearer sk-ant-oat01-vault-fallback-v1'
          : 'Bearer sk-ant-oat01-vault-main-v1',
      )
      expect(
        fixture.records.some((record) => record.url.includes('/oauth/token')),
      ).toBe(false)
    })
  }
}

/** A session's sticky assignment in a routing file, keyed as the router keys it. */
async function stickyPin(path: string, sessionId: string) {
  const state = JSON.parse(await readFile(path, 'utf8')) as {
    assignments: Record<
      string,
      { accountId: string; accountIdentity?: string; assignedAt: number }
    >
  }
  return state.assignments[createHash('sha256').update(sessionId).digest('hex')]
}

test('a replaced default vault account loses its session pins and quota while another account keeps its pin', async () => {
  const fixture = await migrateServingFixture('claustrum', true)
  const replacementIdentity = '33333333-3333-4333-8333-333333333333'
  const model = 'claude-sonnet-4-6'
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
    vault: { connect: async () => fixture.scopedClient },
  })
  let routingPath: string | undefined
  let fallbackRoute: string | undefined
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      quota: { enabled: true },
      routing: { mode: 'sticky-balanced' },
    }))
    for (const route of (await runtime.read()).accounts) {
      const receipt = await runtime.authorizeVault(route.id)
      expect(
        await runtime.vault.publish(receipt, {
          quota: {
            accountIdentity: receipt.accountIdentity,
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
          },
        }),
      ).toBe(true)
    }
    const before = await runtime.read()
    routingPath = before.routingPath
    fallbackRoute = before.accounts.find(
      (account) => account.accountIdentity === fallbackIdentity,
    )?.id
    expect(
      before.accounts.find((account) => account.id === 'main')?.quota,
    ).toMatchObject({ accountIdentity: mainIdentity })
  } finally {
    runtime.close()
  }
  if (!routingPath || !fallbackRoute)
    throw new Error('Vault fixture has no routing file or fallback route')
  // Earlier sessions pinned through the vault routing file: one to the
  // default account, one to the other vault account.
  const earlier = new StickySessionRouter({ path: routingPath })
  lifetimes.deferCleanup(() => earlier.drain())
  const identities = new Map([
    ['main', mainIdentity],
    [fallbackRoute, fallbackIdentity],
  ])
  for (const [sessionId, accountId] of [
    ['session-on-default', 'main'],
    ['session-on-fallback', fallbackRoute],
  ] as const) {
    const pinned = await earlier.resolve({
      sessionId,
      family: stickyRouteFamilyForModel(model),
      modelId: model,
      affinityModelId: model,
      candidates: [
        {
          accountId,
          quota: {
            accountIdentity: identities.get(accountId),
            checkedAt: Date.now(),
            five_hour: {
              usedPercent: 10,
              remainingPercent: 90,
              checkedAt: Date.now(),
            },
            seven_day: {
              usedPercent: 10,
              remainingPercent: 90,
              checkedAt: Date.now(),
            },
          },
          order: 0,
        },
      ],
      retainAccountIds: new Set(identities.keys()),
      accountIdentities: identities,
      storage: null,
      inputBytes: 1,
    })
    expect(pinned?.accountId).toBe(accountId)
  }
  await earlier.drain()
  const defaultPin = await stickyPin(routingPath, 'session-on-default')
  const fallbackPin = await stickyPin(routingPath, 'session-on-fallback')
  expect(defaultPin?.accountIdentity).toBe(mainIdentity)

  // The user replaces the account behind the vault's default credential.
  fixture.replaceDefaultAccount(replacementIdentity)
  const discovery = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
    vault: { connect: async () => fixture.scopedClient },
  })
  try {
    await discovery.vault.refresh()
    const main = (await discovery.read()).accounts.find(
      (account) => account.id === 'main',
    )
    expect(main?.accountIdentity).toBe(replacementIdentity)
    // The previous account's usage reading is not carried over.
    expect(main?.quota).toBeUndefined()
  } finally {
    discovery.close()
  }

  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  expect((await sendNative(plugin, model, 'session-on-default')).status).toBe(
    200,
  )
  expect((await sendNative(plugin, model, 'session-on-fallback')).status).toBe(
    200,
  )
  await plugin.dispose?.()
  // The session pinned to the replaced account is placed again and its new
  // pin names the account that now serves it.
  const replaced = await stickyPin(routingPath, 'session-on-default')
  expect(replaced?.accountIdentity).toBeDefined()
  expect(replaced?.accountIdentity).not.toBe(mainIdentity)
  expect(replaced?.assignedAt).toBeGreaterThan(defaultPin?.assignedAt ?? 0)
  expect(replaced?.accountIdentity).toBe(
    replaced?.accountId === 'main' ? replacementIdentity : fallbackIdentity,
  )
  // The other vault account's pin is untouched.
  const kept = await stickyPin(routingPath, 'session-on-fallback')
  expect(kept).toMatchObject({
    accountId: fallbackRoute,
    accountIdentity: fallbackIdentity,
    assignedAt: fallbackPin?.assignedAt,
  })
  const sent = fixture.records
    .filter((record) => record.url.includes('/v1/messages'))
    .map((record) => record.authorization)
  expect(sent).toHaveLength(2)
  expect(sent[1]).toBe('Bearer sk-ant-oat01-vault-fallback-v1')
})

test('vault sticky routing keeps session assignments only in the vault routing file', async () => {
  const fixture = await migrateServingFixture('claustrum', true)
  // The local session-to-account assignment file. While the host uses the
  // vault, sticky routing must neither read nor rewrite it. Its content is
  // not JSON, so a request that tried to read it would fail to route.
  const localRouting = process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE!
  const localBytes = 'synthetic local routing state, not JSON'
  await writeFile(localRouting, localBytes, { mode: 0o600 })
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
    vault: { connect: async () => fixture.scopedClient },
  })
  let vaultRouting: string | undefined
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      quota: { enabled: true },
      routing: { mode: 'sticky-balanced' },
    }))
    vaultRouting = (await runtime.read()).routingPath
    const quota = () => ({
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
    })
    for (const route of (await runtime.read()).accounts) {
      const receipt = await runtime.authorizeVault(route.id)
      expect(
        await runtime.vault.publish(receipt, {
          quota: { ...quota(), accountIdentity: receipt.accountIdentity },
        }),
      ).toBe(true)
    }
  } finally {
    runtime.close()
  }
  if (!vaultRouting) throw new Error('Vault mode names no routing file')
  expect(vaultRouting).not.toBe(localRouting)
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  expect((await sendNative(plugin)).status).toBe(200)
  // Sticky session pins publish detached under the routing lock after the
  // request has been routed, so the file has no assignment until that save
  // lands. Disposal drains those pin publications before reading the file.
  await plugin.dispose?.()
  const assignments = Object.values(
    (
      JSON.parse(await readFile(vaultRouting, 'utf8')) as {
        assignments: Record<string, { accountId: string }>
      }
    ).assignments,
  )
  expect(assignments).toHaveLength(1)
  expect(await readFile(localRouting, 'utf8')).toBe(localBytes)
})

/** OpenCode's login store for this test, under the test's XDG_DATA_HOME. */
function hostLoginStore() {
  return join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
}

async function writeHostLoginStore(bytes: string) {
  await mkdir(dirname(hostLoginStore()), { recursive: true })
  await writeFile(hostLoginStore(), bytes, { mode: 0o600 })
}

function vaultLoginMethod(plugin: PluginHooks) {
  return plugin.auth?.methods.find(
    (method) => method.label === 'Claude via credential vault',
  )
}

async function startVaultLogin(plugin: PluginHooks) {
  const method = vaultLoginMethod(plugin)
  if (method?.type !== 'oauth')
    throw new Error('Plugin offers no vault login method')
  const started = await method.authorize()
  if (started.method !== 'auto')
    throw new Error('Vault login unexpectedly asks for a code')
  return started.callback()
}

const localHostOAuth = {
  type: 'oauth' as const,
  access: 'sk-ant-oat01-synthetic-host-login',
  refresh: 'synthetic-host-login-refresh',
  expires: Date.now() + 60 * 60_000,
}

test('vault login is offered only while this host holds an enrollment token', async () => {
  const plugin = await createPlugin()
  expect(vaultLoginMethod(plugin)).toBeUndefined()
  await writeFile(
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE!,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  expect(vaultLoginMethod(plugin)?.type).toBe('oauth')
  expect(network).not.toHaveBeenCalled()
})

test('enrolled vault login returns the exact placeholder for an empty slot without any network', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  network.mockClear()
  const placeholder = custodyTombstoneOAuth('anthropic')
  expect(await startVaultLogin(plugin)).toEqual({
    type: 'success',
    access: placeholder.access,
    refresh: placeholder.refresh,
    expires: placeholder.expires,
  })
  // The plugin returns the placeholder; it never writes OpenCode's store.
  await expect(readFile(hostLoginStore(), 'utf8')).rejects.toThrow()
  expect(network).not.toHaveBeenCalled()
})

for (const [state, bytes] of [
  ['a local OAuth login', JSON.stringify({ anthropic: localHostOAuth })],
  [
    'a stored API key',
    JSON.stringify({ anthropic: { type: 'api', key: 'synthetic-host-key' } }),
  ],
  [
    'the placeholder itself',
    JSON.stringify({ anthropic: custodyTombstoneOAuth('anthropic') }),
  ],
  ['unparseable logins', '{"anthropic": '],
  ['logins of the wrong shape', JSON.stringify(['anthropic'])],
  ['a null Anthropic entry', JSON.stringify({ anthropic: null })],
  [
    'an incomplete OAuth entry',
    JSON.stringify({ anthropic: { type: 'oauth' } }),
  ],
] as const) {
  test(`enrolled vault login refuses ${state} and leaves its bytes unchanged`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    await writeHostLoginStore(bytes)
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    network.mockClear()
    await expect(startVaultLogin(plugin)).rejects.toThrow()
    expect(await readFile(hostLoginStore(), 'utf8')).toBe(bytes)
    expect(network).not.toHaveBeenCalled()
  })
}

for (const unsafe of ['symlink', 'group-readable'] as const) {
  test(`vault login refuses an ${unsafe} host login store before network or any write`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    const bytes = JSON.stringify({
      other: { type: 'api', key: 'synthetic-unrelated-provider' },
    })
    await writeHostLoginStore(bytes)
    if (unsafe === 'symlink') {
      const target = join(dirname(hostLoginStore()), 'original-auth.json')
      await writeFile(target, bytes, { mode: 0o600 })
      await rm(hostLoginStore())
      await symlink(target, hostLoginStore())
    } else {
      await chmod(hostLoginStore(), 0o640)
    }
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    network.mockClear()
    await expect(startVaultLogin(plugin)).rejects.toThrow(
      'Invalid native host auth source.',
    )
    expect(await readFile(hostLoginStore(), 'utf8')).toBe(bytes)
    expect(network).not.toHaveBeenCalled()
  })
}

test('enrolled host refuses a local OAuth slot without using it and the vault login sees it as occupied', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  network.mockClear()
  const slot = structuredClone(localHostOAuth)
  const options = await load(plugin, async () => slot)
  await expect(
    requestFetch(options)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    }),
  ).rejects.toThrow('Remove it and choose the vault login, or disconnect')
  // OpenCode's Anthropic login is read through the reader OpenCode gave the
  // auth loader (it returns the local OAuth login above); no auth.json file
  // exists in this test.
  await expect(startVaultLogin(plugin)).rejects.toThrow(
    'already holds an Anthropic login',
  )
  expect(slot).toEqual(localHostOAuth)
  expect(network).not.toHaveBeenCalled()
  expect(fixture.authorizedGets).toEqual([])
})

test('enrolled host refuses a placeholder look-alike that carries an access token', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  network.mockClear()
  const options = await load(plugin, async () => ({
    ...custodyTombstoneOAuth('anthropic'),
    access: 'sk-ant-oat01-synthetic-look-alike',
  }))
  await expect(
    requestFetch(options)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    }),
  ).rejects.toThrow('Remove it and choose the vault login, or disconnect')
  expect(network).not.toHaveBeenCalled()
  expect(fixture.authorizedGets).toEqual([])
})

test('enrolled host passes a stored API key through unchanged', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  network.mockClear()
  const slot = { type: 'api' as const, key: 'synthetic-host-key' }
  expect(await load(plugin, async () => slot)).toEqual({})
  expect(slot).toEqual({ type: 'api', key: 'synthetic-host-key' })
  expect(network).not.toHaveBeenCalled()
  expect(fixture.authorizedGets).toEqual([])
})

function proMaxMethod(plugin: PluginHooks) {
  const method = plugin.auth?.methods.find(
    (candidate) => candidate.label === 'Claude Pro/Max',
  )
  if (method?.type !== 'oauth')
    throw new Error('Plugin offers no Claude Pro/Max sign-in')
  return method
}

function syntheticAuthorize(): typeof authorize {
  return mock(async () => ({
    url: 'https://example.test/oauth',
    redirectUri: 'https://example.test/callback',
    verifier: 'synthetic-verifier',
    state: 'synthetic-state',
  }))
}

test('an enrolled host with local account settings refuses Pro/Max sign-in before the browser flow starts', async () => {
  await migrateServingFixture('local')
  // The local pool and its settings stay as migrated; only the enrollment
  // token says this host now uses the vault.
  await writeFile(
    process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE!,
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const authorizeImpl = syntheticAuthorize()
  const plugin = await createPlugin({ authorize: authorizeImpl })
  network.mockClear()
  await expect(proMaxMethod(plugin).authorize()).rejects.toThrow(
    'Disconnect from the vault first.',
  )
  expect(authorizeImpl).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
})

test('an unenrolled host with a leftover vault mode setting still starts Pro/Max sign-in', async () => {
  const fixture = await migrateServingFixture('local')
  // Simulate an old custody-mode flag by writing directly to the store.
  // Runtime settings updates reject that flag; enrollment alone selects
  // the credential source.
  const store = createNativePoolStore({
    paths: fixture.paths,
    quota: nativeQuotaCodec,
  })
  await store.updateSettings((settings) => ({
    ...settings,
    claustrum: { mode: 'claustrum' },
  }))
  const stored = await store.readSettings()
  expect(stored.status === 'ready' && stored.settings.claustrum).toEqual({
    mode: 'claustrum',
  })
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
  })
  try {
    expect((await runtime.read()).mode).toBe('local')
  } finally {
    runtime.close()
  }
  const authorizeImpl = syntheticAuthorize()
  const plugin = await createPlugin({ authorize: authorizeImpl })
  network.mockClear()
  const started = await proMaxMethod(plugin).authorize()
  expect(started.url).toBe('https://example.test/oauth')
  expect(authorizeImpl).toHaveBeenCalledTimes(1)
  expect(network).not.toHaveBeenCalled()
})

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
  const response = await sendNative(
    plugin,
    'claude-sonnet-4-6',
    `synthetic-late-401-${directory}`,
    true,
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
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
  const prime: unknown = getPluginTestHandles(plugin).primeManager
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
    const cacheKeep: unknown = getPluginTestHandles(plugin).cacheKeepManager
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

/**
 * Pause a real pool-store refresh of the local fallback that offline
 * migration created without an account UUID. The refresh keeps the fallback's
 * tokens and records its first account UUID; it is paused after writing the
 * state file and before writing the config file, the half-written moment in
 * which a reader sees the fallback as torn. Returns once the write is paused.
 */
async function holdFallbackFirstIdentity(paths: {
  config: string
  state: string
}) {
  const reached = lifetimes.gate()
  const release = lifetimes.gate()
  let held = false
  const producer = createNativePoolStore({
    paths,
    quota: nativeQuotaCodec,
    onStep: async (step, info) => {
      if (
        held ||
        step !== 'after-state-write' ||
        info.operation !== 'refresh' ||
        info.rowId !== 'fallback-route'
      )
        return
      held = true
      reached.open()
      await release.wait
    },
  })
  const write = producer.refresh('fallback-route', async (credential) => {
    if (credential.access !== 'sk-ant-oat01-local-fallback')
      throw new Error('the fallback row does not hold the migrated token')
    return {
      access: credential.access,
      refresh: credential.refresh,
      expires: Date.now() + 8 * 60 * 60_000,
      identity: fallbackIdentity,
    }
  })
  lifetimes.trackDetached(write)
  await Promise.race([reached.wait, write.then(noop, noop)])
  expect(held).toBe(true)
  return { write, release: release.open }
}

function noop() {}

/** Opens a gate once Core's local authorization starts waiting on an unfinished pool write. */
function watchTornWriteJoin() {
  const waiting = lifetimes.gate()
  const outcomes: unknown[] = []
  const previousLevel = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record: LogTestRecord) => {
    if (record.channel !== 'native-auth') return
    if (record.payload?.phase === 'waiting') waiting.open()
    if (record.payload?.outcome !== undefined)
      outcomes.push(record.payload.outcome)
  })
  lifetimes.deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return { waiting: waiting.wait, outcomes }
}

async function useFallbackFirst(
  paths: Awaited<ReturnType<typeof resolveNativePoolPaths>>,
) {
  const runtime = createNativeAccountRuntime({ paths, host: 'opencode' })
  try {
    // The plugin applies the stored logging level; keep the debug record
    // that shows a request waiting on the held write.
    await runtime.updateSettings((settings) => ({
      ...settings,
      routing: { mode: 'fallback-first' },
      logging: { level: 'debug' },
    }))
  } finally {
    runtime.close()
  }
}

test('fallback-first waits for a held first-identity write and serves the migrated fallback it chose', async () => {
  const fixture = await migrateServingFixture('local', true)
  await useFallbackFirst(fixture.paths)
  const join = watchTornWriteJoin()
  const held = await holdFallbackFirstIdentity(fixture.paths)
  const plugin = await createPlugin()
  const sending = sendNative(plugin)
  lifetimes.trackDetached(sending.then(noop, noop))
  const first = await Promise.race([
    join.waiting.then(() => 'waiting' as const),
    sending.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
  ])
  expect(first).toBe('waiting')
  held.release()
  const [written] = await Promise.allSettled([held.write])
  const [sent] = await Promise.allSettled([sending])
  expect(written.status).toBe('fulfilled')
  expect(sent.status).toBe('fulfilled')
  if (sent.status === 'fulfilled') expect(sent.value.status).toBe(200)
  const messages = fixture.records.filter((record) =>
    record.url.includes('/v1/messages'),
  )
  expect(messages.map((record) => record.authorization)).toEqual([
    'Bearer sk-ant-oat01-local-fallback',
  ])
  expect(join.outcomes).toContain('joined')
})

test('fallback-first fails retryably and sends nothing when the first-identity write stays unfinished', async () => {
  const fixture = await migrateServingFixture('local', true)
  await useFallbackFirst(fixture.paths)
  const join = watchTornWriteJoin()
  const held = await holdFallbackFirstIdentity(fixture.paths)
  const plugin = await createPlugin()
  const [sent] = await Promise.allSettled([sendNative(plugin)])
  expect(sent.status).toBe('rejected')
  expect(sent.status === 'rejected' ? sent.reason : null).toMatchObject({
    name: 'NativeTransientAccountError',
    message: 'Anthropic account update in progress; retry the request',
    code: 'ECONNRESET',
  })
  expect(
    fixture.records.filter((record) => record.url.includes('/v1/messages')),
  ).toEqual([])
  expect(join.outcomes).toContain('deadline')
  held.release()
  const [written] = await Promise.allSettled([held.write])
  expect(written.status).toBe('fulfilled')
})

test('first OpenCode request after a 1.x vault upgrade uses legacy fallback-first before any main send', async () => {
  const f = await migrateServingFixture('claustrum', true)
  const vault = nativeVaultPaths(f.paths)
  const legacy = JSON.stringify({
    version: 1,
    mainAccountId: mainIdentity,
    claustrum: {
      mode: 'claustrum',
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: mainIdentity,
        state: 'active',
      },
    },
    routing: { mode: 'fallback-first' },
    quota: { enabled: false },
    prime: { enabled: false },
    cacheKeep: { enabled: false },
    accounts: [
      {
        id: 'legacy-secondary',
        label: 'Work',
        type: 'oauth',
        enabled: true,
        addedAt: Date.now(),
        claustrumScopedCredentialId: 'oauth:secondary',
        anthropicAccountUuid: fallbackIdentity,
      },
    ],
  })
  await writeFile(configPath, legacy, { mode: 0o600 })
  await rm(vault.config, { force: true })
  await rm(vault.routing, { force: true })
  expect(f.authorizedGets).toHaveLength(0)
  expect(
    f.records.filter((record) => record.url.includes('/v1/messages')),
  ).toHaveLength(0)
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => f.scopedClient,
  })
  expect((await sendNative(plugin)).status).toBe(200)
  const sent = f.records.filter((record) => record.url.includes('/v1/messages'))
  expect(sent).toHaveLength(1)
  expect(sent[0]?.authorization).toBe('Bearer sk-ant-oat01-vault-fallback-v1')
  expect(f.authorizedGets).not.toContain('oauth:anthropic')
  expect(JSON.parse(await readFile(vault.config, 'utf8')).routing).toEqual({
    mode: 'fallback-first',
  })
  expect(await readFile(configPath, 'utf8')).toBe(legacy)
})

test('OpenCode routes normally during roster deferral without publishing an empty routing file or completed marker', async () => {
  const f = await migrateServingFixture('claustrum', true)
  const vault = nativeVaultPaths(f.paths)
  await mutateVaultRoster(vault.roster, (roster) => {
    if (!roster) throw new Error('Fixture has no roster')
    return { next: { ...roster, complete: false }, result: undefined }
  })
  const list = f.scopedClient.listScoped
  f.scopedClient.listScoped = async () => {
    throw new Error('synthetic discovery unavailable')
  }
  const legacy = JSON.stringify({
    version: 1,
    mainAccountId: mainIdentity,
    claustrum: {
      mode: 'claustrum',
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: mainIdentity,
        state: 'active',
      },
    },
    routing: { mode: 'fallback-first' },
    quota: { enabled: false },
    prime: { enabled: false },
    cacheKeep: { enabled: false },
    accounts: [
      {
        id: 'legacy-secondary',
        type: 'oauth',
        enabled: true,
        anthropicAccountUuid: fallbackIdentity,
      },
    ],
  })
  await writeFile(configPath, legacy, { mode: 0o600 })
  await rm(vault.config, { force: true })
  await rm(vault.routing, { force: true })
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => f.scopedClient,
  })
  expect((await sendNative(plugin)).status).toBe(200)
  const sent = f.records.filter((record) => record.url.includes('/v1/messages'))
  expect(sent).toHaveLength(1)
  expect(sent[0]?.authorization).toBe('Bearer sk-ant-oat01-vault-fallback-v1')
  await expect(stat(vault.routing)).rejects.toMatchObject({ code: 'ENOENT' })
  f.scopedClient.listScoped = list
  const runtime = createNativeAccountRuntime({
    paths: f.paths,
    host: 'opencode',
    vault: { connect: async () => f.scopedClient },
  })
  try {
    await runtime.vault.refresh()
    await runtime.read()
    await runtime.drainRoutingPublications()
    expect(
      JSON.parse(await readFile(vault.routing, 'utf8')).vaultLegacySeed,
    ).toBe('complete')
  } finally {
    runtime.close()
  }
  expect(await readFile(configPath, 'utf8')).toBe(legacy)
})

for (const limit of ['quota floor', 'killswitch'] as const) {
  test(`OC1 vault quota policy identifies ${limit} without sending a request`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    const runtime = createNativeAccountRuntime({
      paths: fixture.paths,
      host: 'opencode',
      vault: { connect: async () => fixture.scopedClient },
    })
    try {
      await runtime.updateSettings((settings) => ({
        ...settings,
        quota: {
          enabled: true,
          minimumRemaining: {
            five_hour: 0,
            seven_day: limit === 'quota floor' ? 20 : 0,
          },
        },
        killswitch: {
          enabled: limit === 'killswitch',
          main: { five_hour: 0, seven_day: 20 },
        },
        routing: { mode: 'sticky-balanced' },
      }))
      const receipt = await runtime.authorizeVault('main')
      const checkedAt = Date.now()
      expect(
        await runtime.vault.publish(receipt, {
          quota: {
            accountIdentity: mainIdentity,
            checkedAt,
            five_hour: { remainingPercent: 100, usedPercent: 0, checkedAt },
            seven_day: {
              remainingPercent: limit === 'quota floor' ? 20 : 19,
              usedPercent: limit === 'quota floor' ? 80 : 81,
              checkedAt,
            },
          },
        }),
      ).toBe(true)
      const plugin = await createPlugin({
        claustrumScopedConnect: async () => fixture.scopedClient,
      })
      fixture.records.length = 0
      const response = await sendNative(plugin)
      expect(response.status).toBe(429)
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
      const body = (await response.json()) as {
        type: string
        error: { type: string; message: string }
      }
      expect(body.type).toBe('error')
      expect(body.error.type).toBe('rate_limit_error')
      expect(body.error.message).toContain(limit)
      expect(body.error.message).toContain('Retry in ')
      expect(body.error.message).toContain('/claude → Killswitch / Quota')
      expect(body.error.message).not.toContain('signing in')
      expect(fixture.records).toEqual([])
    } finally {
      runtime.close()
    }
  })
}

/**
 * An enrolled host serving vault accounts with sticky-balanced routing,
 * directly or through an HTTP relay. Model sends reach an owned loopback
 * server that rejects the first send (401 unless configured otherwise) and
 * accepts every later one. `served` lists the credential used by each send.
 * `afterSend` sees each model response before the plugin does.
 */
async function stickyVaultRejectedFirstSend(
  relay: boolean,
  afterSend?: (response: Response) => void,
  options: {
    firstRefusal?: (headers: Record<string, string>) => Response
    fallback?: boolean
  } = {},
) {
  const fixture = await migrateServingFixture(
    'claustrum',
    options.fallback ?? true,
  )
  const relayServer = relay ? new MockRelayServer() : undefined
  if (relayServer) relays.add(relayServer)
  const relayAddress = await relayServer?.start({
    token: 'synthetic-native-relay-token',
  })
  const runtime = createNativeAccountRuntime({
    paths: fixture.paths,
    host: 'opencode',
    vault: { connect: async () => fixture.scopedClient },
  })
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      quota: { enabled: true },
      routing: { mode: 'sticky-balanced' },
    }))
    // Sticky routing chooses only between accounts with current quota.
    const window = () => ({
      remainingPercent: 90,
      usedPercent: 10,
      checkedAt: Date.now(),
    })
    for (const route of (await runtime.read()).accounts) {
      const receipt = await runtime.authorizeVault(route.id)
      expect(
        await runtime.vault.publish(receipt, {
          quota: {
            checkedAt: Date.now(),
            five_hour: window(),
            seven_day: window(),
            accountIdentity: receipt.accountIdentity,
          },
        }),
      ).toBe(true)
    }
    if (relayAddress)
      await runtime.updateRelay({
        enabled: true,
        url: relayAddress.url,
        token: 'synthetic-native-relay-token',
        transport: 'http',
        fallbackToDirect: false,
      })
  } finally {
    runtime.close()
  }
  const served: string[] = []
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const authorization = request.headers.get('authorization') ?? ''
      served.push(
        authorization.includes('-fallback-')
          ? 'oauth:secondary'
          : 'oauth:anthropic',
      )
      // An Anthropic request id is what lets a relayed status count as upstream.
      const headers = { 'request-id': `req_synthetic_sticky_${served.length}` }
      if (served.length === 1 && options.firstRefusal)
        return options.firstRefusal(headers)
      if (served.length === 1)
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'Synthetic physical rejection',
            },
          },
          { status: 401, headers },
        )
      return Response.json(
        {
          id: 'synthetic-message',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'native-serving-ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        { headers },
      )
    },
  })
  lifetimes.deferCleanup(() => upstream.stop(true))
  network.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    if (relayAddress && url.startsWith(relayAddress.url))
      return originalFetch(input, init)
    if (url.includes('/v1/messages')) {
      const target = new URL(url)
      const response = await originalFetch(
        `http://127.0.0.1:${upstream.port}${target.pathname}${target.search}`,
        init,
      )
      afterSend?.(response)
      return response
    }
    return fixture.fetchProvider(input, init)
  })
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  return { fixture, served, plugin }
}

async function weeklyStickyRefusal(
  options: {
    resetSeconds?: number
    headers?: Record<string, string>
    fallback?: boolean
  } = {},
) {
  const resetSeconds = options.resetSeconds ?? 5 * 24 * 60 * 60
  let upstreamRateLimits: Array<[string, string]> = []
  const setup = await stickyVaultRejectedFirstSend(
    false,
    (response) => {
      upstreamRateLimits = [...response.headers].filter(([name]) =>
        name.startsWith('anthropic-ratelimit-'),
      )
    },
    {
      fallback: options.fallback,
      firstRefusal: (headers) =>
        Response.json(
          {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Synthetic weekly limit',
            },
          },
          {
            status: 429,
            headers: {
              ...headers,
              'retry-after': String(resetSeconds),
              'anthropic-ratelimit-unified-7d-utilization': '1.0',
              'anthropic-ratelimit-unified-7d-reset': String(
                Math.floor(Date.now() / 1000) + resetSeconds,
              ),
              ...options.headers,
            },
          },
        ),
    },
  )
  const runtime = createNativeAccountRuntime({
    paths: setup.fixture.paths,
    host: 'opencode',
    vault: { connect: async () => setup.fixture.scopedClient },
  })
  const snapshot = await runtime.read()
  runtime.close()
  const routingPath = snapshot.routingPath
  if (!routingPath) throw new Error('Vault fixture has no routing path')
  const main = snapshot.accounts.find((account) => account.id === 'main')!
  const router = new StickySessionRouter({ path: routingPath })
  const sessionId = 'synthetic-weekly-sticky'
  await router.resolve({
    sessionId,
    modelId: 'claude-opus-5-5',
    family: stickyRouteFamilyForModel('claude-opus-5-5'),
    candidates: [{ accountId: 'main', quota: main.quota!, order: 0 }],
    retainAccountIds: new Set(['main']),
    accountIdentities: new Map([['main', mainIdentity]]),
    storage: snapshot.policyStorage,
    inputBytes: 1,
  })
  await router.drain()
  return {
    ...setup,
    sessionId,
    routingPath,
    upstreamRateLimits: () => upstreamRateLimits,
  }
}

test('vault sticky weekly 429 headers skip the usage endpoint and migrate main in the same request', async () => {
  const { fixture, plugin, served, sessionId, routingPath } =
    await weeklyStickyRefusal()
  const response = await sendNative(plugin, 'claude-opus-5-5', sessionId)
  expect(response.status).toBe(200)
  expect(served).toEqual(['oauth:anthropic', 'oauth:secondary'])
  expect(await response.text()).toContain('native-serving-ok')
  await plugin.dispose?.()
  expect((await stickyPin(routingPath, sessionId))?.accountIdentity).toBe(
    fallbackIdentity,
  )
  expect(fixture.scopedReports).toEqual([])
  expect(
    fixture.records.filter((record) => record.url.includes('/api/oauth/usage')),
  ).toHaveLength(0)
})

test('vault sticky 429 without confirming headers re-reads the usage endpoint exactly once', async () => {
  const { fixture, plugin, served, sessionId, routingPath } =
    await weeklyStickyRefusal({
      headers: { 'anthropic-ratelimit-unified-7d-utilization': '' },
    })
  const response = await sendNative(plugin, 'claude-opus-5-5', sessionId)
  expect(response.status).toBe(429)
  expect(Number(response.headers.get('retry-after'))).toBe(60)
  expect(served).toEqual(['oauth:anthropic'])
  await plugin.dispose?.()
  expect((await stickyPin(routingPath, sessionId))?.accountId).toBe('main')
  expect(
    fixture.records.filter((record) => record.url.includes('/api/oauth/usage')),
  ).toHaveLength(1)
})

test('vault sticky weekly 429 rejected status migrates without a quota refresh', async () => {
  const { plugin, served, sessionId } = await weeklyStickyRefusal({
    headers: {
      'anthropic-ratelimit-unified-7d-utilization': '',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
    },
  })
  const probe = spyOn(
    getPluginTestHandles(plugin).quotaManager,
    'refreshMain',
  ).mockRejectedValue(new Error('Synthetic quota probe unavailable'))
  try {
    const response = await sendNative(plugin, 'claude-opus-5-5', sessionId)
    expect(response.status).toBe(200)
    expect(served).toEqual(['oauth:anthropic', 'oauth:secondary'])
    expect(probe).not.toHaveBeenCalled()
  } finally {
    probe.mockRestore()
  }
})

for (const shortWait of [false, true]) {
  test(`vault sticky weekly 429 retains on probe failure with a bounded retry (short upstream=${shortWait})`, async () => {
    const reset = Date.now() + 5 * 24 * 60 * 60_000
    const { plugin, served, sessionId, routingPath, upstreamRateLimits } =
      await weeklyStickyRefusal({
        headers: {
          'anthropic-ratelimit-unified-7d-utilization': '0.999',
          'retry-after': new Date(reset).toUTCString(),
          'retry-after-ms': shortWait ? '1500' : String(5 * 24 * 60 * 60_000),
          'anthropic-ratelimit-requests-reset': new Date(reset).toISOString(),
        },
      })
    const probe = spyOn(
      getPluginTestHandles(plugin).quotaManager,
      'refreshMain',
    ).mockRejectedValue(new Error('Synthetic quota probe unavailable'))
    try {
      const response = await sendNative(plugin, 'claude-opus-5-5', sessionId)
      expect(response.status).toBe(429)
      expect(probe).toHaveBeenCalled()
      expect(Number(response.headers.get('retry-after'))).toBe(
        shortWait ? 1.5 : 60,
      )
      expect(Number(response.headers.get('retry-after-ms'))).toBe(
        shortWait ? 1500 : 60_000,
      )
      expect(
        [...response.headers].filter(([name]) =>
          name.startsWith('anthropic-ratelimit-'),
        ),
      ).toEqual(upstreamRateLimits())
      expect(served).toEqual(['oauth:anthropic'])
      await plugin.dispose?.()
      expect((await stickyPin(routingPath, sessionId))?.accountId).toBe('main')
    } finally {
      probe.mockRestore()
    }
  })
}

test('vault sticky weekly 429 holds main for a ten minute reset', async () => {
  const { plugin, served, sessionId, routingPath } = await weeklyStickyRefusal({
    resetSeconds: 600,
  })
  const response = await sendNative(plugin, 'claude-opus-5-5', sessionId)
  expect(response.status).toBe(429)
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThanOrEqual(
    599,
  )
  expect(Number(response.headers.get('retry-after'))).toBeLessThanOrEqual(630)
  expect(served).toEqual(['oauth:anthropic'])
  await plugin.dispose?.()
  expect((await stickyPin(routingPath, sessionId))?.accountId).toBe('main')
})

test('vault sticky weekly 429 on the last eligible account still returns a quota refusal', async () => {
  const { plugin, served, sessionId } = await weeklyStickyRefusal({
    fallback: false,
  })
  const response = await sendNative(plugin, 'claude-opus-5-5', sessionId)
  expect(response.status).toBe(429)
  expect(await response.json()).toMatchObject({
    error: { type: 'rate_limit_error' },
  })
  expect(served).toEqual(['oauth:anthropic'])
})

const reportedRecords = (fixture: ServingFixture) =>
  fixture.scopedReports.map((report) => [
    report.credentialId,
    report.recordVersion,
    report.providerStatus,
  ])

for (const relay of [false, true]) {
  const transport = relay ? 'HTTP relay' : 'direct'
  test(`vault ${transport} cancel during 401 re-authorization ends aborted, reports the 401 once and keeps the sticky account`, async () => {
    const { fixture, served, plugin } =
      await stickyVaultRejectedFirstSend(relay)
    const entered = lifetimes.gate()
    const release = lifetimes.gate()
    const get = fixture.scopedClient.getScoped.bind(fixture.scopedClient)
    let held = false
    fixture.scopedClient.getScoped = async (input) => {
      // The first read of the rejected credential after its 401 is the
      // re-authorization. Hold it until the request is cancelled.
      if (!held && served.length === 1 && input.credentialId === served[0]) {
        held = true
        entered.open()
        await release.wait
      }
      return get(input)
    }
    const sessionId = `synthetic-cancel-${relay ? 'relay' : 'direct'}`
    const controller = new AbortController()
    const pending = sendNative(
      plugin,
      undefined,
      sessionId,
      false,
      controller.signal,
    ).then(
      (response) => response.status,
      (error: unknown) => error,
    )
    await entered.wait
    controller.abort()
    const outcome = await pending
    release.open()
    await getPluginTestHandles(plugin).drainDispatchWork()
    expect(outcome).toBe(controller.signal.reason)
    const assigned = served[0]
    if (!assigned) throw new Error('No model send reached the provider')
    expect(served).toEqual([assigned])
    expect(reportedRecords(fixture)).toEqual([[assigned, 1, 401]])
    expect((await sendNative(plugin, undefined, sessionId)).status).toBe(200)
    expect(served).toEqual([assigned, assigned])
    expect(fixture.scopedReports).toHaveLength(1)
  })

  test(`vault ${transport} failed 401 re-authorization still reports the 401 and moves the sticky account`, async () => {
    const { fixture, served, plugin } =
      await stickyVaultRejectedFirstSend(relay)
    const get = fixture.scopedClient.getScoped.bind(fixture.scopedClient)
    let refused = false
    fixture.scopedClient.getScoped = async (input) => {
      if (!refused && served.length === 1 && input.credentialId === served[0]) {
        refused = true
        throw new Error('synthetic vault unavailable')
      }
      return get(input)
    }
    const sessionId = `synthetic-refused-${relay ? 'relay' : 'direct'}`
    expect((await sendNative(plugin, undefined, sessionId)).status).toBe(200)
    const [rejected, migrated] = served
    if (!rejected || !migrated)
      throw new Error('The rejected send was not rerouted')
    expect(served).toHaveLength(2)
    expect(migrated).not.toBe(rejected)
    expect(reportedRecords(fixture)).toEqual([[rejected, 1, 401]])
    expect((await sendNative(plugin, undefined, sessionId)).status).toBe(200)
    expect(served).toEqual([rejected, migrated, migrated])
  })
}

test('vault direct cancel after a 401 arrives and before re-authorization ends aborted, reports the 401 once and keeps the sticky account', async () => {
  const controller = new AbortController()
  let readsAtRejection: number | undefined
  const { fixture, served, plugin } = await stickyVaultRejectedFirstSend(
    false,
    (response) => {
      // Cancel once the rejection has arrived, before the plugin acts on it.
      if (response.status !== 401) return
      readsAtRejection = fixture.authorizedGets.length
      controller.abort()
    },
  )
  const sessionId = 'synthetic-cancel-after-401'
  const outcome = await sendNative(
    plugin,
    undefined,
    sessionId,
    false,
    controller.signal,
  ).then(
    (response) => response.status,
    (error: unknown) => error,
  )
  expect(outcome).toBe(controller.signal.reason)
  const assigned = served[0]
  if (!assigned) throw new Error('No model send reached the provider')
  expect(served).toEqual([assigned])
  // Nothing was read from the vault after the cancel: no re-authorization
  // and no authorization of another account.
  expect(fixture.authorizedGets).toHaveLength(readsAtRejection ?? -1)
  await getPluginTestHandles(plugin).drainDispatchWork()
  expect(reportedRecords(fixture)).toEqual([[assigned, 1, 401]])
  expect((await sendNative(plugin, undefined, sessionId)).status).toBe(200)
  expect(served).toEqual([assigned, assigned])
  expect(fixture.scopedReports).toHaveLength(1)
})

for (const relay of [false, true]) {
  test(`vault ${relay ? 'HTTP relay' : 'direct'} dispose drains a pending 401 report after caller abort`, async () => {
    const controller = new AbortController()
    const { fixture, plugin, served } =
      await stickyVaultRejectedFirstSend(relay)
    const authorizing = lifetimes.gate()
    const releaseAuthorization = lifetimes.gate()
    const get = fixture.scopedClient.getScoped.bind(fixture.scopedClient)
    fixture.scopedClient.getScoped = async (input) => {
      if (served.length === 1) {
        authorizing.open()
        await releaseAuthorization.wait
      }
      return get(input)
    }
    const entered = lifetimes.gate()
    const release = lifetimes.gate()
    const report = fixture.scopedClient.reportAuthFailureScoped.bind(
      fixture.scopedClient,
    )
    fixture.scopedClient.reportAuthFailureScoped = async (input) => {
      entered.open()
      await release.wait
      return report(input)
    }
    const pending = sendNative(
      plugin,
      undefined,
      undefined,
      false,
      controller.signal,
    ).catch((error: unknown) => error)
    await authorizing.wait
    controller.abort(new Error('synthetic caller timeout'))
    expect(await pending).toBe(controller.signal.reason)
    let closed = false
    const closing = Promise.resolve(plugin.dispose?.()).then(() => {
      closed = true
    })
    try {
      await entered.wait
      expect(closed).toBe(false)
      expect(fixture.scopedReports).toEqual([])
    } finally {
      releaseAuthorization.open()
      release.open()
      await closing
    }
    const assigned = served[0]
    if (!assigned) throw new Error('No model send reached the provider')
    expect(served).toEqual([assigned])
    expect(reportedRecords(fixture)).toEqual([[assigned, 1, 401]])
    expect(fixture.scopedReports).toHaveLength(1)
  })
}

test('OpenCode 1 serves through a vault outage without local token rescue', async () => {
  const f = await migrateServingFixture('claustrum')
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => f.scopedClient,
  })
  expect((await sendNative(plugin)).status).toBe(200)
  f.scopedClient.getScoped = async () => {
    throw Object.assign(new Error('outage'), { code: 'ECONNREFUSED' })
  }
  expect((await sendNative(plugin)).status).toBe(200)
  const sent = f.records.filter((record) => record.url.includes('/v1/messages'))
  expect(sent.map((record) => record.authorization)).toEqual([
    'Bearer sk-ant-oat01-vault-main-v1',
    'Bearer sk-ant-oat01-vault-main-v1',
  ])
  expect(f.records.some((record) => record.url.includes('/oauth/token'))).toBe(
    false,
  )
  expect(f.scopedReports).toHaveLength(0)
})

/**
 * A server standing in for the host a repository's provider baseURL (or an
 * ANTHROPIC_BASE_URL) points at. It records every request that reaches it;
 * `onRequest` can answer one instead of the default 200.
 */
function destinationServer(
  onRequest?: (count: number) => Response | undefined,
) {
  const received: Array<{ url: string; authorization: string | null }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      received.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
      })
      return (
        onRequest?.(received.length) ??
        Response.json({
          id: 'synthetic-destination-message',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'destination-reached' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      )
    },
  })
  lifetimes.deferCleanup(() => server.stop(true))
  return { origin: server.url.origin, received }
}

/** Sends the native probe to `url` instead of the official Messages URL. */
async function sendNativeTo(plugin: PluginHooks, url: string) {
  const options = await load(plugin, async () =>
    custodyTombstoneOAuth('anthropic'),
  )
  return requestFetch(options)(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-affinity': `synthetic-destination-${directory}`,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Synthetic destination probe' }],
    }),
  })
}

/** Loopback test servers get real network; everything else is the fixture. */
function routeLoopback(fixture: ServingFixture, origins: string[]) {
  network.mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    return origins.some((origin) => url.startsWith(origin))
      ? originalFetch(input, init)
      : fixture.fetchProvider(input, init)
  })
}

async function expectDestinationRefusal(response: Response, origin: string) {
  expect(response.status).toBe(400)
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
    },
  })
  expect(text).not.toContain(new URL(origin).host)
  expect(text).not.toContain('sk-ant-oat01')
}

for (const mode of ['local', 'claustrum'] as const) {
  test(`OC1 ${mode} OAuth: a provider baseURL on a loopback server receives no direct request`, async () => {
    const fixture = await migrateServingFixture(mode)
    const upstream = destinationServer()
    routeLoopback(fixture, [upstream.origin])
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    await expectDestinationRefusal(
      await sendNativeTo(plugin, `${upstream.origin}/v1/messages`),
      upstream.origin,
    )
    expect(upstream.received).toEqual([])
    expect(
      fixture.records.filter((record) => record.url.includes('/v1/messages')),
    ).toEqual([])
    // A refused destination is a request error, not a credential failure.
    expect(fixture.scopedReports).toEqual([])
  })
}

test('OC1 vault OAuth: the official origin still serves the request', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  const response = await sendNative(plugin)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('native-serving-ok')
})

test('OC1 vault OAuth: a provider baseURL is refused before the HTTP relay envelope is sent', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const upstream = destinationServer()
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
      fallbackToDirect: true,
    })
  } finally {
    runtime.close()
  }
  routeLoopback(fixture, [upstream.origin, address.url])
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  await expectDestinationRefusal(
    await sendNativeTo(plugin, `${upstream.origin}/v1/messages`),
    upstream.origin,
  )
  expect(relay.acceptedRequests()).toBe(0)
  expect(upstream.received).toEqual([])
})

test('OC1 vault OAuth: a 401 retry to a destination that is no longer allowed is refused', async () => {
  const fixture = await migrateServingFixture('claustrum')
  // The first send is admitted by the test-only loopback origin. Its 401
  // withdraws that permission and rotates the vault record, so the retry with
  // the newer credential must be refused instead of sent.
  const upstream = destinationServer((count) => {
    if (count !== 1) return undefined
    delete process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN
    fixture.rotateVault()
    return Response.json(
      {
        type: 'error',
        error: { type: 'authentication_error', message: 'Synthetic 401' },
      },
      { status: 401 },
    )
  })
  process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = upstream.origin
  routeLoopback(fixture, [upstream.origin])
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  await expect(
    sendNativeTo(plugin, `${upstream.origin}/v1/messages`),
  ).rejects.toThrow(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
  expect(upstream.received.map((record) => record.authorization)).toEqual([
    'Bearer sk-ant-oat01-vault-main-v1',
  ])
})

for (const admitted of [false, true]) {
  test(`OC1 vault CacheKeep prewarm to a remembered loopback URL ${admitted ? 'is sent when the test origin admits it' : 'is refused without authorizing a credential'}`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    const upstream = destinationServer()
    if (admitted)
      process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = upstream.origin
    routeLoopback(fixture, [upstream.origin])
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    await load(plugin, async () => custodyTombstoneOAuth('anthropic'))
    const cacheKeep: unknown = getPluginTestHandles(plugin).cacheKeepManager
    if (!(cacheKeep instanceof CacheKeepManager))
      throw new Error('Native host CacheKeep manager is unavailable')
    const gets = fixture.authorizedGets.length
    await cacheKeep.prewarmNow({
      sessionId: 'synthetic-destination-session',
      url: `${upstream.origin}/v1/messages`,
      headers: new Headers({ 'content-type': 'application/json' }),
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
    if (admitted) {
      expect(upstream.received).toHaveLength(1)
      expect(upstream.received[0]?.authorization).toBe(
        'Bearer sk-ant-oat01-vault-main-v1',
      )
    } else {
      expect(upstream.received).toEqual([])
      expect(fixture.authorizedGets).toHaveLength(gets)
    }
  })
}

for (const admitted of [false, true]) {
  test(`OC1 vault Prime under a loopback ANTHROPIC_BASE_URL ${admitted ? 'is sent when the test origin admits it' : 'is refused'}`, async () => {
    const fixture = await migrateServingFixture('claustrum')
    await enablePrime(fixture)
    const upstream = destinationServer()
    process.env.ANTHROPIC_BASE_URL = upstream.origin
    if (admitted)
      process.env.ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN = upstream.origin
    network.mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/api/oauth/usage')) return primeWindows()
      return url.startsWith(upstream.origin)
        ? originalFetch(input, init)
        : fixture.fetchProvider(input, init)
    })
    const plugin = await createPlugin({
      claustrumScopedConnect: async () => fixture.scopedClient,
    })
    await tickPrime(plugin)
    expect(upstream.received).toHaveLength(admitted ? 1 : 0)
    expect(
      fixture.records.filter((record) => record.url.includes('/v1/messages')),
    ).toEqual([])
  })
}

test('OC1 OAuth: ANTHROPIC_BASE_URL on a foreign origin is refused', async () => {
  const fixture = await migrateServingFixture('claustrum')
  const upstream = destinationServer()
  process.env.ANTHROPIC_BASE_URL = upstream.origin
  routeLoopback(fixture, [upstream.origin])
  const plugin = await createPlugin({
    claustrumScopedConnect: async () => fixture.scopedClient,
  })
  await expectDestinationRefusal(await sendNative(plugin), upstream.origin)
  expect(upstream.received).toEqual([])
})
