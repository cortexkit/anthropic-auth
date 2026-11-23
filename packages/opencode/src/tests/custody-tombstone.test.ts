import { describe, expect, mock } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertNotCustodyTombstone,
  CustodyTombstoneRefreshError,
  createNativeAccountRuntime,
  custodyTombstoneKey,
  custodyTombstoneOAuth,
  fetchOAuthAccountProfile,
  fetchOAuthQuotaSnapshot,
  isCustodyTombstoneOAuth,
  type NativeCustodyClient,
  refreshClaudeOAuthToken,
  resetClaudeCodeIdentityCachesForTest,
} from '@cortexkit/anthropic-auth-core'
import {
  type Auth,
  createOpencodeClient,
  type Provider,
} from '@opencode-ai/sdk'
import { $ } from 'bun'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index'
import { drainSidebarWrites } from '../sidebar-state'
import { setOAuthHeaders } from '../transform'
import { migrateNativeOpencodeFixture } from './native-fixture'
import { getPluginTestHandles } from './plugin-test-handles'
import { extractUrl, TOKEN_URL } from './test-fetch'

const fixtureDir = join(import.meta.dir, 'fixtures', 'claustrum-golden')
const tombstoneFixture = JSON.parse(
  readFileSync(join(fixtureDir, 'tombstone.json'), 'utf8'),
) as {
  fixtures: {
    api: { provider: string; entry: Record<string, unknown> }
    oauth: { provider: string; entry: Record<string, unknown> }
  }
}

const oauthFixture = tombstoneFixture.fixtures.oauth
const apiFixture = tombstoneFixture.fixtures.api
const originalFetch = globalThis.fetch

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
type PluginOptions = Parameters<typeof AnthropicAuthPlugin>[1]
type NativeFixture = Awaited<ReturnType<typeof migrateNativeOpencodeFixture>>
type OutboundRecord = { url: string; authorization: string }

const HOUR_MS = 60 * 60_000
const MAIN_IDENTITY = '11111111-1111-4111-8111-111111111111'
const REPLACEMENT_IDENTITY = '33333333-3333-4333-8333-333333333333'
const VAULT_MAIN_CREDENTIAL = 'oauth:anthropic'
const anthropicProvider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}

// Every environment variable a native test body or the migration fixture may
// set. Each body saves and restores all of them, so no path leaks into the
// next test.
const nativeEnvKeys = [
  'OPENCODE_ANTHROPIC_AUTH_FILE',
  'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
  'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE',
  'OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR',
  'OPENCODE_ANTHROPIC_AUTH_RPC_DIR',
  'OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION',
  'OPENCODE_AUTH_CONTENT',
  'CLAUDE_CONFIG_DIR',
  'XDG_DATA_HOME',
] as const

/**
 * Everything one tombstone body replaces or starts: the process-global fetch,
 * clock and fixture environment, and the plugins it creates.
 *
 * Bun does not cancel a body that outlives its timeout, and once one
 * afterEach hook times out it skips every later afterEach hook for that test,
 * including the lifetime hook and setup.ts's leak check. A hook therefore
 * cannot be the only thing that puts these globals back. The body closes its
 * own scope before it returns, and teardown's cancellation gate closes it the
 * moment teardown starts, before teardown waits for a body that is still
 * running. Closing restores the globals synchronously, before any await, and
 * only then disposes the plugins, so a slow or stuck disposal can fail only
 * its own test. Once closed, a body that is still running cannot install
 * globals or keep a new plugin alive.
 */
class CustodyScope {
  private readonly plugins = new Set<PluginHooks>()
  private readonly savedFetch = globalThis.fetch
  private readonly savedNow = Date.now
  private readonly savedEnv = new Map(
    nativeEnvKeys.map((key) => [key, process.env[key]]),
  )
  private closing: Promise<void> | undefined
  /** Set when the body starts waiting for close, so teardown need not report a close failure the body already reports. */
  joinedByBody = false

  /** Call before replacing fetch, Date.now or a fixture env key. */
  assertOpen(): void {
    if (this.closing)
      throw new Error(
        'Custody body was cancelled by teardown and may not continue',
      )
  }

  /** Track a plugin for disposal; a plugin created after cancellation is disposed at once. */
  own(plugin: PluginHooks): void {
    if (this.closing) {
      lifetimes.trackDetached(
        disposeAll([plugin], 'Late custody tombstone plugin cleanup failed'),
      )
      this.assertOpen()
    }
    this.plugins.add(plugin)
  }

  /** Forget a plugin the body disposes itself mid-test, so close does not dispose it again. */
  unown(plugin: PluginHooks): void {
    this.plugins.delete(plugin)
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.restoreGlobals()
      this.closing = this.disposeOwned()
    }
    return this.closing
  }

  private restoreGlobals(): void {
    globalThis.fetch = this.savedFetch
    Date.now = this.savedNow
    for (const key of nativeEnvKeys) {
      const value = this.savedEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  private async disposeOwned(): Promise<void> {
    const plugins = [...this.plugins]
    this.plugins.clear()
    try {
      await disposeAll(plugins, 'Custody tombstone plugin cleanup failed')
    } finally {
      await drainSidebarWrites()
      resetClaudeCodeIdentityCachesForTest()
    }
  }
}

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

/** Claim a fresh owner-only directory for this body, removed after its plugins are disposed. */
async function startNativeBody() {
  const scope = currentScope()
  scope.assertOpen()
  delete process.env.OPENCODE_AUTH_CONTENT
  resetClaudeCodeIdentityCachesForTest()
  const root = await mkdtemp(join(tmpdir(), 'anthropic-custody-native-'))
  // migrateNativeOpencodeFixture also removes the root once it accepts it;
  // this covers a body that fails before handing the root to it.
  lifetimes.deferCleanup(() => rm(root, { recursive: true, force: true }))
  return { root, scope }
}

/**
 * Replace fetch with a synthetic provider that records every outbound request.
 * The token endpoint answers with the caller's rotation, bootstrap names the
 * main account, and any other unexpected path fails the request.
 */
function recordNetwork(
  options: { token?: () => Record<string, unknown> } = {},
): OutboundRecord[] {
  currentScope().assertOpen()
  const records: OutboundRecord[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url = extractUrl(input)
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      records.push({ url, authorization: headers.get('authorization') ?? '' })
      if (url === TOKEN_URL && options.token)
        return Response.json(options.token())
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({ oauth_account: { account_uuid: MAIN_IDENTITY } })
      if (url.includes('/v1/messages'))
        return Response.json({
          id: 'synthetic-message',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      throw new Error(`Unexpected synthetic provider path: ${url}`)
    },
    { preconnect: originalFetch.preconnect },
  )
  return records
}

function applyFixtureEnv(fixture: NativeFixture) {
  currentScope().assertOpen()
  for (const [key, value] of Object.entries(fixture.env))
    process.env[key] = value
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  // OpenCode's own login store for this body, never the user's.
  process.env.XDG_DATA_HOME = join(fixture.root, 'opencode-data')
}

/** Commit a local native pool through the real offline migration. */
async function migrateLocalPool(
  root: string,
  hostAuth: Record<string, unknown>,
): Promise<NativeFixture> {
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      refresh: { enabled: false },
      quota: { enabled: false },
      routing: { mode: 'main-first' },
      accounts: [],
    },
    hostAuth,
  })
  applyFixtureEnv(fixture)
  expect((await readNativeAccounts(fixture)).mode).toBe('local')
  return fixture
}

function vaultMainRow(accountId: string) {
  return {
    id: VAULT_MAIN_CREDENTIAL,
    accountId,
    credentialType: 'oauth',
    state: 'active' as const,
    categories: ['anthropic-native'],
    serves: ['anthropic'],
    providerIds: [],
    refreshAdapter: 'anthropic',
    recordVersion: 1,
    operations: ['read'],
    createdAtMs: null,
  }
}

/**
 * Write this host's enrollment token and discover its vault accounts without
 * migrating local credentials. Preparation refuses credential reads, so every
 * credential read observed by a test comes from the plugin's serving path.
 */
async function prepareVaultPool(
  root: string,
  rows: ReturnType<typeof vaultMainRow>[],
): Promise<NativeFixture> {
  const fixture = await migrateNativeOpencodeFixture({
    root,
    lifetime: lifetimes,
    legacyConfig: {
      version: 1,
      refresh: { enabled: false },
      quota: { enabled: false },
      accounts: [],
      claustrum: {
        mode: 'claustrum',
        scopedRoster: true,
        primaryAccount: {
          credentialId: VAULT_MAIN_CREDENTIAL,
          accountId: MAIN_IDENTITY,
          state: 'active',
        },
      },
    },
    hostAuth: { anthropic: custodyTombstoneOAuth(oauthFixture.provider) },
    custody: {
      connect: async () => ({
        async listScoped() {
          return {
            view: 'custody-tombstone-migration',
            rows,
            grants: undefined,
            grantTuples: undefined,
          }
        },
        async getScoped() {
          throw new Error('Migration discovery must not read credentials')
        },
        async reportAuthFailureScoped() {
          throw new Error('Migration discovery must not report credentials')
        },
        close() {},
      }),
      enrollment: { token: 'ab'.repeat(32), token_generation: 1 },
    },
  })
  applyFixtureEnv(fixture)
  expect((await readNativeAccounts(fixture)).mode).toBe('claustrum')
  return fixture
}

async function readNativeAccounts(fixture: NativeFixture) {
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

async function createNativePlugin(
  scope: CustodyScope,
  root: string,
  options: PluginOptions = {},
) {
  scope.assertOpen()
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: globalThis.fetch,
      }),
      project: {
        id: 'custody-tombstone-fixture',
        worktree: root,
        time: { created: Date.now() },
      },
      directory: root,
      worktree: root,
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
  scope.own(plugin)
  return plugin
}

async function disposePlugin(scope: CustodyScope, plugin: PluginHooks) {
  scope.unown(plugin)
  await plugin.dispose?.()
}

/** Load the plugin with OpenCode's current Anthropic slot and send one model request. */
async function sendMessage(
  plugin: PluginHooks,
  activation: Auth = custodyTombstoneOAuth(oauthFixture.provider),
): Promise<Response> {
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('Plugin did not install its auth loader')
  const options: Record<string, unknown> = await loader(
    async () => structuredClone(activation),
    anthropicProvider,
  )
  const handler = options.fetch
  if (typeof handler !== 'function')
    throw new Error('Plugin did not install its request handler')
  const response: unknown = await handler(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    },
  )
  if (!(response instanceof Response))
    throw new Error('Plugin request handler did not return a Response')
  return response
}

function proMaxMethod(plugin: PluginHooks) {
  const method = plugin.auth?.methods.find(
    (candidate) => candidate.label === 'Claude Pro/Max',
  )
  if (method?.type !== 'oauth')
    throw new Error('Plugin offers no Claude Pro/Max sign-in')
  return method
}

const lifetimes = createTestLifetimeSuite()
const custodyScope = new AsyncLocalStorage<CustodyScope>()

function currentScope(): CustodyScope {
  const scope = custodyScope.getStore()
  if (!scope)
    throw new Error('Custody fixture used outside a custody test body')
  return scope
}

// The lifetime suite registers ordinary Bun tests, which run one at a time
// within this file unless Bun is started with --concurrent. Each body runs in
// its own custody scope: the body closes its scope before it returns, and
// teardown's cancellation gate closes it the moment teardown starts, before
// teardown waits for a still-running body.
function custodyTest(name: string, body: () => unknown): void {
  lifetimes.test(name, async () => {
    const scope = new CustodyScope()
    // Teardown opens every gate as soon as its hook starts, before it waits
    // for this body; closing then restores the globals even if the body is
    // still running past its timeout. A disposal failure is reported by the
    // body or by the cleanup below, not here.
    void lifetimes.gate().wait.then(() => scope.close().catch(() => {}))
    // Teardown joins a disposal the body did not wait for before it removes
    // the body's files.
    lifetimes.deferCleanup(() =>
      scope.joinedByBody ? undefined : scope.close(),
    )
    try {
      return await custodyScope.run(scope, body)
    } finally {
      scope.joinedByBody = true
      await scope.close()
    }
  })
}

describe('Claustrum custody tombstones', () => {
  custodyTest('recognizes only provider-bound OAuth tombstones', () => {
    const provider = oauthFixture.provider
    const key = custodyTombstoneKey(provider)
    const productionTombstone = custodyTombstoneOAuth(provider)
    expect(oauthFixture.entry).toEqual(productionTombstone)
    const cases: Array<{ name: string; auth: unknown; recognized: boolean }> = [
      {
        name: 'production empty-access tombstone',
        auth: productionTombstone,
        recognized: true,
      },
      {
        name: 'vendored canonical empty-access tombstone',
        auth: oauthFixture.entry,
        recognized: true,
      },
      {
        name: 'noncanonical sentinel-access value is still refused at bearer boundaries',
        auth: { ...productionTombstone, access: key },
        recognized: true,
      },
      { name: 'API entry', auth: apiFixture.entry, recognized: false },
      {
        name: 'wrong-provider sentinel',
        auth: {
          ...productionTombstone,
          refresh: custodyTombstoneKey('openai'),
        },
        recognized: false,
      },
      {
        name: 'sentinel with prefix added',
        auth: { ...productionTombstone, refresh: `x${key}` },
        recognized: false,
      },
      {
        name: 'sentinel with suffix added',
        auth: { ...productionTombstone, refresh: `${key}x` },
        recognized: false,
      },
      {
        name: 'ordinary refresh token',
        auth: { ...productionTombstone, refresh: 'ordinary-refresh-token' },
        recognized: false,
      },
      {
        name: 'missing OAuth type',
        auth: { access: '', refresh: key, expires: 0 },
        recognized: false,
      },
    ]

    for (const entry of cases) {
      expect(isCustodyTombstoneOAuth(entry.auth, provider), entry.name).toBe(
        entry.recognized,
      )
    }
  })

  custodyTest(
    'throws a non-provider-refresh error before the token endpoint',
    () => {
      let thrown: unknown
      try {
        assertNotCustodyTombstone(
          oauthFixture.entry.refresh,
          oauthFixture.provider,
        )
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(CustodyTombstoneRefreshError)
      expect(thrown).toMatchObject({
        code: 'custody_tombstone_refresh',
        provider: oauthFixture.provider,
      })
      expect(thrown).not.toHaveProperty('isRefreshError')
      expect(thrown).not.toHaveProperty('permanent')
      expect(thrown).not.toHaveProperty('status')
      expect(String(thrown)).toContain('local token refresh is forbidden')
    },
  )

  custodyTest(
    'keeps loader recognition contained by both irreversible boundaries',
    async () => {
      const provider = oauthFixture.provider
      const recognized = [custodyTombstoneOAuth(provider), oauthFixture.entry]
      const foreign = custodyTombstoneKey('openai')
      const values = [
        ...recognized.map((auth) => ({
          auth,
          value: String((auth as Record<string, unknown>).refresh),
          recognized: true,
        })),
        {
          auth: { type: 'oauth', access: '', refresh: foreign, expires: 0 },
          value: foreign,
          recognized: false,
        },
      ]
      const tokenEndpointCalls: string[] = []
      const fetchImpl = mock((input: unknown) => {
        tokenEndpointCalls.push(extractUrl(input as string | URL | Request))
        return Promise.resolve(new Response('{}', { status: 200 }))
      }) as unknown as typeof fetch

      // Keep shallow and nested invalid-input cases together so their assertions stay consistent.
      await expect(
        Promise.all(
          values.map(
            async ({ auth, value, recognized: expectedRecognition }) => {
              expect(isCustodyTombstoneOAuth(auth, provider)).toBe(
                expectedRecognition,
              )
              expect(() => assertNotCustodyTombstone(value, provider)).toThrow(
                CustodyTombstoneRefreshError,
              )
              await expect(
                refreshClaudeOAuthToken({ refreshToken: value, fetchImpl }),
              ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
              expect(() => setOAuthHeaders(new Headers(), value)).toThrow(
                CustodyTombstoneRefreshError,
              )
            },
          ),
        ),
      ).resolves.toBeArray()
      expect(tokenEndpointCalls).toEqual([])
    },
  )

  custodyTest('refuses sentinel access during direct requests', async () => {
    const { root, scope } = await startNativeBody()
    const outbound = recordNetwork()
    const fixture = await prepareVaultPool(root, [vaultMainRow(MAIN_IDENTITY)])
    expect(
      (await readNativeAccounts(fixture)).accounts.find(
        (account) => account.id === 'main',
      )?.credentialId,
    ).toBe(VAULT_MAIN_CREDENTIAL)
    // Each direct request reads its credential from the vault, and this read
    // answers with a tombstone instead of an access token.
    const vaultReads: string[] = []
    const sentinelVault: NativeCustodyClient = {
      async listScoped() {
        return {
          view: 'custody-tombstone',
          rows: [vaultMainRow(MAIN_IDENTITY)],
          grants: undefined,
          grantTuples: undefined,
        }
      },
      async getScoped({ credentialId }) {
        vaultReads.push(credentialId)
        return {
          credentialId,
          material: custodyTombstoneKey(oauthFixture.provider),
          accountId: MAIN_IDENTITY,
          recordVersion: 1,
          expiresAtMs: Date.now() + 8 * HOUR_MS,
        }
      },
      async reportAuthFailureScoped() {},
      close() {},
    }
    const plugin = await createNativePlugin(scope, root, {
      claustrumScopedConnect: async () => sentinelVault,
    })

    await expect(sendMessage(plugin)).rejects.toMatchObject({
      code: 'invalid-material',
    })
    expect(vaultReads).toContain(VAULT_MAIN_CREDENTIAL)
    expect(outbound).toEqual([])
  })

  custodyTest('refuses a tombstone before the quota poll fetch', async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch

    await expect(
      fetchOAuthQuotaSnapshot({
        accessToken: custodyTombstoneKey('openai'),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  custodyTest('refuses a tombstone before the profile fetch', async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    ) as unknown as typeof fetch

    await expect(
      fetchOAuthAccountProfile({
        accessToken: custodyTombstoneKey('openai'),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CustodyTombstoneRefreshError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  custodyTest('refuses a tombstone before CacheKeep prewarm headers', () => {
    expect(() =>
      setOAuthHeaders(new Headers(), custodyTombstoneKey('openai'), {
        body: { model: 'claude-sonnet-4-5' },
      }),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  custodyTest('refuses a tombstone before Prime fire headers', () => {
    expect(() =>
      setOAuthHeaders(new Headers(), custodyTombstoneKey('openai'), {
        body: { model: 'claude-haiku-4-5' },
      }),
    ).toThrow(CustodyTombstoneRefreshError)
  })

  custodyTest(
    'holds a local main tombstone dark without network or refresh state',
    async () => {
      const { root, scope } = await startNativeBody()
      const outbound = recordNetwork()
      // Host auth.json contains only the inert Anthropic activation marker.
      // Migration must leave the local pool empty instead of importing it.
      const fixture = await migrateLocalPool(root, {
        anthropic: custodyTombstoneOAuth(oauthFixture.provider),
      })
      const plugin = await createNativePlugin(scope, root)

      // The marker enables plugin request handling, not bearer authorization.
      // With no local account, the request must fail without network traffic.
      await expect(sendMessage(plugin)).rejects.toThrow(
        'Native OAuth account is unavailable',
      )
      expect(outbound).toEqual([])

      const snapshot = await readNativeAccounts(fixture)
      expect(snapshot.mode).toBe('local')
      expect(snapshot.accounts).toEqual([])
      expect(
        JSON.parse(await readFile(fixture.hostAuthPath, 'utf8')).anthropic,
      ).toEqual(custodyTombstoneOAuth(oauthFixture.provider))
    },
  )

  custodyTest(
    'never sends a foreign-provider main tombstone to the token endpoint after expiry',
    async () => {
      const { root, scope } = await startNativeBody()
      const outbound = recordNetwork({
        // The rotation hands back another provider's tombstone as the refresh
        // token successor, so the pool now stores it for the main account.
        token: () => ({
          access_token: 'sk-ant-oat01-live-main-rotated',
          refresh_token: custodyTombstoneKey('openai'),
          expires_in: 8 * 60 * 60,
        }),
      })
      const fixture = await migrateLocalPool(root, {
        anthropic: {
          type: 'oauth',
          access: 'sk-ant-oat01-live-main',
          refresh: 'live-main-refresh',
          expires: Date.now() + 8 * HOUR_MS,
        },
      })
      const plugin = await createNativePlugin(scope, root)

      // The first send validates the migrated credential through one real
      // rotation and serves with its successor.
      expect((await sendMessage(plugin)).status).toBe(200)
      expect(outbound.map((record) => record.url)).toEqual([
        TOKEN_URL,
        expect.stringContaining('/api/claude_cli/bootstrap'),
        expect.stringContaining('/v1/messages'),
      ])
      expect(outbound[2]?.authorization).toBe(
        'Bearer sk-ant-oat01-live-main-rotated',
      )
      outbound.length = 0

      // Expire the credential returned by the first token exchange. The next
      // request would need to refresh with its stored foreign-provider marker.
      currentScope().assertOpen()
      const realNow = Date.now
      Date.now = () => realNow() + 9 * HOUR_MS
      const refused = await sendMessage(plugin).catch((error: unknown) => error)
      // The stored tombstone is refused locally as the refresh begins: the
      // request fails as a local authorization refusal, not as a failed
      // token refresh, and nothing reaches the token endpoint.
      expect(refused).toBeInstanceOf(Error)
      expect(String(refused)).toContain(
        'Native OAuth authorization refused: refused',
      )
      expect(refused).toMatchObject({
        tokenRefreshFailed: false,
        failure: undefined,
      })
      expect(outbound).toEqual([])

      // Refusing a tombstone locally is not a provider refresh failure, so it
      // must leave no refresh error or backoff on the main account.
      const main = (await readNativeAccounts(fixture)).accounts.find(
        (account) => account.id === 'main',
      )
      expect(main?.accountIdentity).toBe(MAIN_IDENTITY)
      expect(main?.lastRefreshError).toBeUndefined()
    },
  )

  custodyTest(
    'reconciles a real main without a resolved binding before serving OAuth',
    async () => {
      const { root, scope } = await startNativeBody()
      const outbound = recordNetwork()
      let vaultIdentity = MAIN_IDENTITY
      const vaultReads: string[] = []
      const listingGate = lifetimes.gate()
      const vaultClient = (
        listing: 'answers' | 'waits',
      ): NativeCustodyClient => ({
        async listScoped() {
          if (listing === 'waits') await listingGate.wait
          return {
            view: 'custody-tombstone',
            rows: [vaultMainRow(vaultIdentity)],
            grants: undefined,
            grantTuples: undefined,
          }
        },
        async getScoped({ credentialId }) {
          vaultReads.push(credentialId)
          return {
            credentialId,
            material: `sk-ant-oat01-vault-${vaultIdentity}`,
            accountId: vaultIdentity,
            recordVersion: 1,
            expiresAtMs: Date.now() + 8 * HOUR_MS,
          }
        },
        async reportAuthFailureScoped() {},
        close() {},
      })
      const fixture = await prepareVaultPool(root, [
        vaultMainRow(MAIN_IDENTITY),
      ])
      expect(
        (await readNativeAccounts(fixture)).accounts.find(
          (account) => account.id === 'main',
        )?.accountIdentity,
      ).toBe(MAIN_IDENTITY)

      // The vault now holds a different account behind the default credential,
      // so the migrated main binding no longer resolves to the account served.
      vaultIdentity = REPLACEMENT_IDENTITY
      // Startup discovery would replace the saved account UUID. Hold it so the
      // request compares the old UUID against the vault's replacement account.
      const stale = await createNativePlugin(scope, root, {
        claustrumScopedConnect: async () => vaultClient('waits'),
      })
      await expect(sendMessage(stale)).rejects.toMatchObject({
        code: 'identity-changed',
      })
      expect(vaultReads).toContain(VAULT_MAIN_CREDENTIAL)
      expect(outbound).toEqual([])
      listingGate.open()
      // Let startup discovery commit and release its cross-runtime lease before
      // disposal aborts its wait. A peer refresh may otherwise serve the old
      // committed roster while that cancelled discovery still holds the lease.
      const startup = getPluginTestHandles(stale).fallbackRefreshReady
      if (!(startup instanceof Promise))
        throw new Error('Plugin did not expose its startup fallback refresh')
      await startup
      await disposePlugin(scope, stale)

      // The vault inventory refresh rebinds main to the account the vault serves.
      const discovery = createNativeAccountRuntime({
        paths: fixture.paths,
        host: 'opencode',
        vault: { connect: async () => vaultClient('answers') },
      })
      try {
        await discovery.vault.refresh()
        expect(
          (await discovery.read()).accounts.find(
            (account) => account.id === 'main',
          )?.accountIdentity,
        ).toBe(REPLACEMENT_IDENTITY)
      } finally {
        discovery.close()
      }

      const reconciled = await createNativePlugin(scope, root, {
        claustrumScopedConnect: async () => vaultClient('answers'),
      })
      expect((await sendMessage(reconciled)).status).toBe(200)
      expect(outbound).toEqual([
        {
          url: expect.stringContaining('/v1/messages'),
          authorization: `Bearer sk-ant-oat01-vault-${REPLACEMENT_IDENTITY}`,
        },
      ])
    },
  )

  custodyTest(
    'refuses Claude Pro/Max login before authorization while claustrum is committed',
    async () => {
      const { root, scope } = await startNativeBody()
      const outbound = recordNetwork()
      const authorizeImpl = mock(async () => ({
        url: 'https://example.test/authorize',
        redirectUri: 'http://localhost/callback',
        state: 'state',
        verifier: 'verifier',
      }))
      const fixture = await migrateLocalPool(root, {
        anthropic: custodyTombstoneOAuth(oauthFixture.provider),
      })

      // Without vault enrollment, Claude Pro/Max starts the local OAuth flow.
      const local = await createNativePlugin(scope, root, {
        authorize: authorizeImpl,
      })
      await expect(proMaxMethod(local).authorize()).resolves.toMatchObject({
        url: 'https://example.test/authorize',
      })
      expect(authorizeImpl).toHaveBeenCalledTimes(1)
      await disposePlugin(scope, local)

      // Adding this host's enrollment token must block local OAuth sign-in.
      // The local pool and its settings remain unchanged.
      await writeFile(
        fixture.enrollmentPath,
        JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
        { mode: 0o600, flag: 'wx' },
      )
      const enrolled = await createNativePlugin(scope, root, {
        authorize: authorizeImpl,
      })
      await expect(proMaxMethod(enrolled).authorize()).rejects.toThrow(
        'Disconnect from the vault first.',
      )
      expect(authorizeImpl).toHaveBeenCalledTimes(1)
      expect(outbound).toEqual([])
    },
  )
})
