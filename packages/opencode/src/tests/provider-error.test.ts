import { afterEach, expect, spyOn } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { APICallError } from '@ai-sdk/provider'
import {
  __setLogTestSink,
  createNativeAccountRuntime,
  createNativePoolStore,
  createProviderErrorResponseScope,
  custodyTombstoneOAuth,
  getLogLevel,
  type LogTestRecord,
  type NativeCustodyClient,
  type NativePoolPaths,
  PrimeManager,
  resetClaudeCodeIdentityCachesForTest,
  resolveNativePoolPaths,
  runNativeMigration,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import { ClaustrumCredentialError } from '@cortexkit/claustrum-client'
import { mutateVaultRoster } from '@cortexkit/common-auth/claustrum'
import { acquireRefreshFileLock, lockPathFor } from '@cortexkit/common-auth/fs'
import { createOpencodeClient, type Provider } from '@opencode-ai/sdk'
import { $, type ServerWebSocket } from 'bun'
import { nativeQuotaCodec } from '../../../core/src/native-quota-codec.ts'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import type { TestGate } from '../../../core/src/tests/test-lifetime.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { AnthropicAuthPlugin } from '../index.ts'
import {
  createStrippedStream,
  NON_STREAMING_DIAGNOSTICS_MAX_BYTES,
} from '../transform.ts'
import { getPluginTestHandles } from './plugin-test-handles'

// Provider errors can repeat the credential a send used. These tests drive the
// OpenCode 1 plugin's own request handler with synthetic accounts and check
// that every error it returns or throws has that send's credential removed,
// while successful bytes and routing decisions stay unchanged.

type PluginHooks = Awaited<ReturnType<typeof AnthropicAuthPlugin>>
type FetchArgs = Parameters<typeof fetch>
type ProviderHandler = (url: string, init: FetchArgs[1]) => Promise<Response>

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
] as const
// The values these variables had before this file's tests ran. Every body
// restores these, not values it saw when it started: a test that starts two
// bodies would otherwise have the second one save the first one's paths, and
// because cleanups run first-in-first-out, put them back after the first
// body's cleanup had restored the originals. Later test files in the same
// `bun test` process would then resolve their state paths into this file's
// deleted temporary directories.
const envAtLoad = new Map(envKeys.map((key) => [key, process.env[key]]))
const originalFetch = globalThis.fetch
const provider: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  source: 'custom',
  env: [],
  options: {},
  models: {},
}

interface BodyOwner {
  directory: string
  controller: AbortController
  plugins: PluginHooks[]
  network: { current: ProviderHandler }
}
const owners = new Set<BodyOwner>()
// Loopback relay servers owned by test bodies; closed with their plugins.
const relayServers = new Set<{ close(): Promise<void> }>()
// Rejections of relay server stops that this file does not await (see
// startReconnectingRelay); the next teardown reports them.
const lateRelayStopFailures: unknown[] = []
// Registered before the lifetime suite's own afterEach: cancel every body's
// requests and dispose its plugins before that hook waits for the body.
afterEach(async () => {
  const late = lateRelayStopFailures.splice(0)
  if (late.length)
    throw new AggregateError(late, 'A relay server stop failed after teardown')
  const closing = [...owners]
  const servers = [...relayServers]
  relayServers.clear()
  for (const owner of closing) owner.controller.abort()
  const results = await Promise.allSettled([
    ...closing.flatMap((owner) =>
      owner.plugins.map((plugin) =>
        Promise.resolve().then(() => plugin.dispose?.()),
      ),
    ),
    // Start relay shutdown beside plugin disposal, which closes the clients.
    // Await both so neither side's socket close waits on an unstarted shutdown.
    ...servers.map((server) => Promise.resolve().then(() => server.close())),
  ])
  const failed = results.filter((result) => result.status === 'rejected')
  if (failed.length)
    throw new AggregateError(
      failed.map((result) => result.reason),
      'Provider error plugin cancellation failed',
    )
})
const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

const MAIN_IDENTITY = '11111111-1111-4111-8111-111111111111'
const RELAY_URL = 'https://synthetic-oc1-relay.invalid'
// Prefix-free credentials cannot be found by pattern. Remove their echoes
// from errors by matching the exact value sent on each network attempt.
const vaultAccess = (version: number) =>
  `synthetic-oc1-vault-access-v${version}-9e2f`
const RELAY_TOKEN = 'synthetic-oc1-private-relay-token-73ad'
const PAID_KEY = 'synthetic-oc1-paid-api-key-1c58'
const LOCAL_ACCESS = 'sk-ant-oat01-synthetic-oc1-local-main'
const LOCAL_ROTATED = 'sk-ant-oat01-synthetic-oc1-local-main-rotated'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj'
const UNRELATED_BEARER_VALUE = 'synthetic-unrelated-bearer-echo'

const echoOf = (secret: string) =>
  `exact=${secret}; jwt=${JWT}; other=Bearer ${UNRELATED_BEARER_VALUE}`

function expectScrubbed(text: string, secrets: readonly string[]) {
  for (const secret of secrets) expect(text).not.toContain(secret)
  expect(text).not.toContain(JWT)
  expect(text).not.toContain(UNRELATED_BEARER_VALUE)
}

const sse = <T extends { type: string }>(value: T) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
const errorEnvelope = (type: string, secret: string) => ({
  type: 'error',
  error: { type, message: echoOf(secret) },
})
const jsonError = (status: number, type: string, secret: string) =>
  Response.json(errorEnvelope(type, secret), {
    status,
    headers: { 'request-id': 'req_synthetic_oc1' },
  })
const healthy = (text: string) =>
  sse({
    type: 'message_start',
    message: {
      id: 'msg_synthetic',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }) +
  sse({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }) +
  sse({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  }) +
  sse({ type: 'content_block_stop', index: 0 }) +
  sse({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 1 },
  }) +
  sse({ type: 'message_stop' })
const eventStream = (text: string) =>
  new Response(text, {
    headers: {
      'content-type': 'text/event-stream',
      'request-id': 'req_synthetic_oc1',
    },
  })

const authorizationOf = (init: FetchArgs[1]) =>
  new Headers(init?.headers).get('authorization') ?? ''
const bearerValue = (init: FetchArgs[1]) =>
  authorizationOf(init).replace(/^Bearer /, '')

function relayAuthorization(init: FetchArgs[1]) {
  const payload: unknown = JSON.parse(String(init?.body))
  if (typeof payload !== 'object' || payload === null)
    throw new Error('relay payload is not an object')
  const upstream: unknown = Reflect.get(payload, 'upstream')
  if (typeof upstream !== 'object' || upstream === null)
    throw new Error('relay payload has no upstream')
  const headers: unknown = Reflect.get(upstream, 'headers')
  if (typeof headers !== 'object' || headers === null)
    throw new Error('relay payload has no upstream headers')
  const authorization: unknown = Reflect.get(headers, 'authorization')
  if (typeof authorization !== 'string')
    throw new Error('relay payload omitted the bearer')
  return authorization
}

/** Return account metadata responses shared by all fixtures. */
function metadata(url: string): Response | undefined {
  if (url.includes('/oauth/token'))
    return Response.json({
      access_token: LOCAL_ROTATED,
      refresh_token: 'synthetic-oc1-primary-successor',
      expires_in: 28800,
    })
  if (url.includes('/api/claude_cli/bootstrap'))
    return Response.json({ oauth_account: { account_uuid: MAIN_IDENTITY } })
  if (url.includes('/api/oauth/profile'))
    return Response.json({
      account: { uuid: MAIN_IDENTITY },
      organization: {
        uuid: 'synthetic-org',
        billing_type: 'stripe',
        rate_limit_tier: 'default_claude_max_5x',
      },
    })
  return undefined
}

async function startBody() {
  const directory = await mkdtemp(join(tmpdir(), 'oc1-provider-error-'))
  const owner: BodyOwner = {
    directory,
    controller: new AbortController(),
    plugins: [],
    network: {
      current: async (url) => {
        throw new Error(`Unexpected synthetic request: ${url}`)
      },
    },
  }
  owners.add(owner)
  lifetimes.deferCleanup(async () => {
    owner.controller.abort()
    const results = await Promise.allSettled(
      owner.plugins
        .splice(0)
        .map((plugin) => Promise.resolve().then(() => plugin.dispose?.())),
    )
    try {
      await rm(directory, { recursive: true, force: true })
    } finally {
      globalThis.fetch = originalFetch
      for (const key of envKeys) {
        const value = envAtLoad.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      owners.delete(owner)
    }
    const failed = results.filter((result) => result.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map((result) => result.reason),
        'Provider error fixture cleanup failed',
      )
  })
  const file = (name: string) => join(directory, name)
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = file('anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = file(
    'anthropic-auth-state.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = file('sidebar.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR = file('cachekeep')
  process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FEED_DIR = file('quota-feed')
  process.env.OPENCODE_ANTHROPIC_AUTH_RPC_DIR = file('rpc')
  process.env.OPENCODE_ANTHROPIC_AUTH_ROUTING_STATE_FILE = file('routing.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE =
    file('enrollment.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = file(
    'synthetic-connection.json',
  )
  process.env.OPENCODE_ANTHROPIC_AUTH_DISABLE_PROFILE_HYDRATION = '1'
  process.env.CLAUDE_CONFIG_DIR = file('synthetic-claude')
  process.env.XDG_DATA_HOME = file('synthetic-data')
  delete process.env.OPENCODE_AUTH_CONTENT
  resetClaudeCodeIdentityCachesForTest()
  globalThis.fetch = Object.assign(
    async (input: FetchArgs[0], init?: FetchArgs[1]) => {
      const signal = AbortSignal.any([
        owner.controller.signal,
        ...(init?.signal ? [init.signal] : []),
      ])
      signal.throwIfAborted()
      const url = input instanceof Request ? input.url : String(input)
      return metadata(url) ?? owner.network.current(url, { ...init, signal })
    },
    { preconnect: originalFetch.preconnect },
  )
  return owner
}

/** Create a vault primary-account fixture with a changeable credential version. */
async function vaultFixture(
  relay?:
    | {
        fallbackToDirect: boolean
        url?: string
        transport?: 'http' | 'websocket'
      }
    | undefined,
) {
  const owner = await startBody()
  const paths = await resolveNativePoolPaths(
    join(owner.directory, 'anthropic-auth.json'),
    process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
  )
  // The vault's current record for the default credential: its version, the
  // account it belongs to, whether the vault refuses to issue it, and the
  // auth failures reported against it.
  const state: {
    version: number
    account: string
    refused: boolean
    reports: { recordVersion: number; providerStatus: number }[]
  } = {
    version: 1,
    account: MAIN_IDENTITY,
    refused: false,
    reports: [],
  }
  const client: NativeCustodyClient = {
    async listScoped() {
      return {
        view: 'synthetic-provider-error-view',
        rows: [
          {
            id: 'oauth:anthropic',
            accountId: state.account,
            credentialType: 'oauth',
            state: 'active',
            categories: ['anthropic-native'],
            serves: ['anthropic'],
            providerIds: [],
            refreshAdapter: 'anthropic',
            recordVersion: state.version,
            operations: ['read', 'invalidate'],
            createdAtMs: 1,
          },
        ],
        grants: undefined,
        grantTuples: undefined,
      }
    },
    async getScoped({ credentialId }) {
      if (state.refused)
        throw new ClaustrumCredentialError(
          'enrollment_revoked',
          'auth_required',
          'reauth',
        )
      return {
        credentialId,
        material: vaultAccess(state.version),
        accountId: state.account,
        recordVersion: state.version,
        expiresAtMs: Date.now() + 8 * 60 * 60_000,
      }
    },
    async reportAuthFailureScoped(input) {
      state.reports.push({
        recordVersion: input.recordVersion,
        providerStatus: input.providerStatus,
      })
    },
    close() {},
  }
  await writeFile(
    join(owner.directory, 'enrollment.json'),
    JSON.stringify({ token: 'ab'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await createNativePoolStore({
    paths: nativeVaultPaths(paths),
    quota: nativeQuotaCodec,
  }).initialize()
  const runtime = createNativeAccountRuntime({
    paths,
    host: 'opencode',
    vault: { connect: async () => client },
  })
  try {
    await runtime.vault.refresh()
    await runtime.updateSettings((settings) => ({
      ...settings,
      refresh: { enabled: false },
      quota: { enabled: false },
      routing: { mode: 'main-first' },
    }))
    if (relay)
      await runtime.updateRelay({
        enabled: true,
        url: relay.url ?? RELAY_URL,
        token: RELAY_TOKEN,
        transport: relay.transport ?? 'http',
        fallbackToDirect: relay.fallbackToDirect,
      })
  } finally {
    runtime.close()
  }
  return { owner, state, client }
}

/** Create a migrated local OAuth account with an optional paid quota-exhaustion fallback. */
async function localFixture(paid: boolean, paidKey = PAID_KEY) {
  const owner = await startBody()
  const paths: NativePoolPaths = await resolveNativePoolPaths(
    join(owner.directory, 'anthropic-auth.json'),
    process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
  )
  await writeFile(
    paths.legacyConfig,
    JSON.stringify({
      version: 1,
      refresh: { enabled: false },
      quota: { enabled: paid },
      routing: { mode: 'main-first' },
      accounts: paid
        ? [
            {
              id: 'paid',
              type: 'api',
              apiKey: paidKey,
              baseURL: 'https://paid.invalid',
            },
          ]
        : [],
    }),
    { mode: 0o600 },
  )
  const hostAuthPath = join(owner.directory, 'host-auth.json')
  await writeFile(
    hostAuthPath,
    JSON.stringify({
      anthropic: {
        type: 'oauth',
        access: LOCAL_ACCESS,
        refresh: 'synthetic-oc1-primary-refresh',
        expires: Date.now() + 8 * 60 * 60_000,
      },
    }),
    { mode: 0o600 },
  )
  const journal = await runNativeMigration({
    paths,
    host: 'opencode',
    hostAuthPath,
    routingSourcePath: join(owner.directory, 'legacy-routing.json'),
    routingDestinationPath: join(owner.directory, 'native-routing.json'),
    env: {},
    processFence: async () => {},
    removePiAnthropicAuth: false,
  })
  expect(journal.phase).toBe('retired')
  return { owner }
}

async function createPlugin(
  owner: BodyOwner,
  client?: NativeCustodyClient | undefined,
  quotaCallPause?: (ms: number) => Promise<void>,
) {
  const creation = AnthropicAuthPlugin(
    {
      client: createOpencodeClient({
        baseUrl: 'http://127.0.0.1:9',
        fetch: globalThis.fetch,
      }),
      project: {
        id: 'provider-error-fixture',
        worktree: owner.directory,
        time: { created: Date.now() },
      },
      directory: owner.directory,
      worktree: owner.directory,
      serverUrl: new URL('http://127.0.0.1:9'),
      experimental_workspace: { register() {} },
      $,
    },
    {
      scopedRosterPollIntervalMs: 0,
      cacheKeepAggregateRefreshIntervalMs: 0,
      ...(quotaCallPause ? { quotaCallPause } : {}),
      ...(client ? { claustrumScopedConnect: async () => client } : {}),
    },
  )
  lifetimes.trackDetached(creation)
  const plugin = await creation
  owner.plugins.push(plugin)
  if (owner.controller.signal.aborted) await plugin.dispose?.()
  return plugin
}

/**
 * Stands in for the plugin's wait between quota usage polls. A route that hits
 * a rate limit polls usage again soon after the startup poll, and the plugin
 * spaces those polls one second apart. This records each requested wait and
 * returns at once, so the test spends no real time on that spacing.
 */
function recordedQuotaPause() {
  const requested: number[] = []
  return {
    requested,
    pause: async (ms: number) => {
      requested.push(ms)
    },
  }
}

/**
 * Each requested wait is what remains of the one-second gap since the previous
 * poll, so it is positive and never longer than that gap. Whether a wait is
 * requested at all depends on how long setup took, so none may be requested.
 */
function expectQuotaPollGaps(requested: readonly number[]) {
  for (const ms of requested) {
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(1_000)
  }
}

/** Sends one model request through the plugin's own request handler. */
async function sendNative(
  owner: BodyOwner,
  plugin: PluginHooks,
  sessionId: string,
  toolNames?: string[],
  streaming = true,
) {
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('Plugin did not install its auth loader')
  const options = await loader(
    async () => custodyTombstoneOAuth('anthropic'),
    provider,
  )
  const handler: unknown = options.fetch
  if (typeof handler !== 'function')
    throw new Error('Plugin did not install its request handler')
  const response: unknown = await handler(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-affinity': sessionId,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16,
        stream: streaming,
        ...(toolNames
          ? {
              tools: toolNames.map((name) => ({
                name,
                description: `Use ${name}`,
                input_schema: { type: 'object', properties: {} },
              })),
            }
          : {}),
        messages: [{ role: 'user', content: 'Synthetic provider error probe' }],
      }),
      signal: owner.controller.signal,
    },
  )
  if (!(response instanceof Response))
    throw new Error('Plugin request handler did not return a Response')
  return response
}

/** Records every plugin log line, at debug level, until the body ends. */
function captureLogs() {
  const records: LogTestRecord[] = []
  const previousLevel = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  lifetimes.deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previousLevel)
  })
  return records
}

/** Return response text, or the error raised by the request or body read. */
async function visible(request: Promise<Response>) {
  try {
    const response = await request
    try {
      return { status: response.status, text: await response.text() }
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return { status: response.status, text: error.message }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { status: undefined, text: error.message }
  }
}

test('OC1 vault direct HTTP error omits the send credential and keeps status and type', async () => {
  const { owner, client } = await vaultFixture()
  owner.network.current = async (_url, init) =>
    jsonError(400, 'invalid_request_error', bearerValue(init))
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, 'oc1-http-error'))
  expect(seen.status, seen.text).toBe(400)
  expectScrubbed(seen.text, [vaultAccess(1)])
  expect(seen.text).toContain('invalid_request_error')
})

test('OC1 vault streamed error omits the send credential', async () => {
  const { owner, client } = await vaultFixture()
  owner.network.current = async (_url, init) =>
    eventStream(sse(errorEnvelope('overloaded_error', bearerValue(init))))
  const plugin = await createPlugin(owner, client)
  const records = captureLogs()
  const seen = await visible(sendNative(owner, plugin, 'oc1-sse-error'))
  expectScrubbed(seen.text, [vaultAccess(1)])
  expect(seen.text).toContain('overloaded_error')
  // The stream error's provider message stays out of plugin log lines.
  const logged = JSON.stringify(records)
  expectScrubbed(logged, [vaultAccess(1)])
  expect(logged).not.toContain('exact=')
})

test('OC1 incomplete 200 is a retryable connection error instead of an empty reply', async () => {
  const { owner, client } = await vaultFixture()
  owner.network.current = async () => eventStream('')
  const plugin = await createPlugin(owner, client)
  const response = await sendNative(owner, plugin, 'oc1-incomplete')
  expect(response.status).toBe(200)
  await expect(response.text()).rejects.toMatchObject({ code: 'ECONNRESET' })
})

test('OC1 preserves an explicit terminal relay error instead of replacing it with EOF failure', async () => {
  const { owner, client } = await vaultFixture()
  const body = sse({
    type: 'error',
    error: {
      type: 'relay_upstream_error',
      status: 401,
      message: 'Relay upstream returned HTTP 401',
    },
  })
  owner.network.current = async () => eventStream(body)
  const plugin = await createPlugin(owner, client)
  const response = await sendNative(owner, plugin, 'oc1-terminal-error')
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(body)
})

test('OC1 rejects an unterminated error frame as incomplete', async () => {
  const { owner, client } = await vaultFixture()
  owner.network.current = async () =>
    eventStream(
      sse({ type: 'error', error: { type: 'authentication_error' } }).slice(
        0,
        -1,
      ),
    )
  const plugin = await createPlugin(owner, client)
  const response = await sendNative(owner, plugin, 'oc1-unterminated-error')
  expect(response.status).toBe(200)
  await expect(response.text()).rejects.toMatchObject({ code: 'ECONNRESET' })
})

for (const ending of ['LF', 'CRLF'] as const) {
  test(`OC1 vault ${ending} success that quotes the credential stays byte-identical`, async () => {
    const { owner, client } = await vaultFixture()
    const lf = healthy(`début 🧪 漢字 error notes ${echoOf(vaultAccess(1))}`)
    const body = ending === 'CRLF' ? lf.replaceAll('\n', '\r\n') : lf
    owner.network.current = async () => eventStream(body)
    const plugin = await createPlugin(owner, client)
    const response = await sendNative(owner, plugin, `oc1-success-${ending}`)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new TextEncoder().encode(body),
    )
  })
}

for (const relay of [false, true]) {
  for (const streaming of [false, true]) {
    for (const kind of ['ambiguous', 'overflow', 'parse']) {
      test(`OC1 ${relay ? 'HTTP relay' : 'direct'} ${streaming ? 'SSE' : 'JSON'} ${kind} mapping refusal is terminal and never reroutes`, async () => {
        const { owner, client, state } = await vaultFixture(
          relay ? { fallbackToDirect: false } : undefined,
        )
        let sends = 0
        owner.network.current = async () => {
          sends++
          const block = {
            type: 'tool_use',
            name: 'mcp_Search',
            input: {
              text: 'private provider prose',
              ...(kind === 'overflow'
                ? { query: 'x'.repeat(NON_STREAMING_DIAGNOSTICS_MAX_BYTES) }
                : {}),
            },
          }
          const text =
            kind === 'parse'
              ? streaming
                ? 'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Search"}\n\n'
                : '{"type":"message","content":[{"type":"tool_use","name":"mcp_Search"}],'
              : streaming
                ? sse({ type: 'content_block_start', content_block: block })
                : JSON.stringify({ type: 'message', content: [block] })
          return new Response(text, {
            headers: {
              'content-type': streaming
                ? 'text/event-stream'
                : 'application/json',
              'request-id': 'req_synthetic_mapping',
            },
          })
        }
        const plugin = await createPlugin(owner, client)
        const response = await sendNative(
          owner,
          plugin,
          'oc1-terminal-mapping',
          kind === 'ambiguous'
            ? ['search', 'Search', 'mcp_Search']
            : ['search', 'mcp_Search'],
          streaming,
        )
        const failure: unknown = await response
          .text()
          .catch((error: unknown) => error)
        expect(failure).toMatchObject({
          name: 'UnsafeToolNameResponseError',
          message: 'Response tool-name mapping could not be validated safely',
        })
        expect(failure).not.toHaveProperty('code')
        expect(failure).toMatchObject({ retryable: false, isRetryable: false })
        expect(failure).not.toHaveProperty('providerErrorType')
        expect(sends).toBe(1)
        expect(state.reports).toEqual([])
      })
    }
  }

  test(`OC1 ${relay ? 'HTTP relay' : 'direct'} binds tool names to each concurrent request`, async () => {
    const { owner, client } = await vaultFixture(
      relay ? { fallbackToDirect: false } : undefined,
    )
    const sentNames: string[][] = []
    owner.network.current = async (url, init) => {
      expect(url.startsWith(RELAY_URL)).toBe(relay)
      const physical = JSON.parse(String(init?.body))
      const body = relay ? JSON.parse(physical.body) : physical
      sentNames.push(body.tools.map((tool: { name: string }) => tool.name))
      const events = ['mcp_Search', 'search', 'mcp_Bash']
        .map((name, index) =>
          sse({
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: `toolu_${index}`,
              name,
              input: {},
            },
          }),
        )
        .join('')
      const bytes = new TextEncoder().encode(
        events + sse({ type: 'message_stop' }),
      )
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.length; offset += 5) {
              controller.enqueue(bytes.slice(offset, offset + 5))
            }
            controller.close()
          },
        }),
        {
          headers: {
            'content-type': 'text/event-stream',
            'request-id': 'req_synthetic_mapping',
          },
        },
      )
    }
    const plugin = await createPlugin(owner, client)
    const names = await Promise.all(
      [
        ['search', 'aft_search', 'ctx_search', 'bash'],
        ['ctx_search', 'bash'],
      ].map(async (tools, index) => {
        const response = await sendNative(
          owner,
          plugin,
          `oc1-mapping-${index}`,
          tools,
        )
        const text = await response.text()
        return text
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)))
          .filter((event) => event.type === 'content_block_start')
          .map((event) => event.content_block.name)
      }),
    )
    expect(names).toEqual([
      ['search', 'search', 'bash'],
      ['ctx_search', 'ctx_search', 'bash'],
    ])
    expect(sentNames).toHaveLength(2)
    expect(sentNames).toContainEqual([
      'mcp_Search',
      'mcp_Aft_search',
      'mcp_Ctx_search',
      'mcp_Bash',
    ])
    expect(sentNames).toContainEqual(['mcp_Ctx_search', 'mcp_Bash'])
  })
}

test('OC1 pre-wrapper overflow inspection stays a terminal mapping refusal', async () => {
  const { owner } = await localFixture(true)
  let sends = 0
  owner.network.current = async (url) => {
    if (url.includes('/api/oauth/usage')) {
      const window = {
        utilization: 0,
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
      }
      return Response.json({ five_hour: window, seven_day: window })
    }
    sends++
    expect(url).not.toStartWith('https://paid.invalid')
    expect(url).toContain('/v1/messages')
    return eventStream(
      sse({
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          name: 'mcp_Search',
          input: { query: 'x'.repeat(NON_STREAMING_DIAGNOSTICS_MAX_BYTES) },
        },
      }),
    )
  }
  const plugin = await createPlugin(owner)
  let responseReturned = false
  const failure: unknown = await sendNative(
    owner,
    plugin,
    'oc1-pre-wrapper-refusal',
    ['search', 'mcp_Search'],
  )
    .then((response) => {
      responseReturned = true
      return response.text()
    })
    .catch((error: unknown) => error)
  expect(failure).toMatchObject({
    name: 'UnsafeToolNameResponseError',
    message: 'Response tool-name mapping could not be validated safely',
    retryable: false,
    isRetryable: false,
  })
  expect(failure).not.toHaveProperty('code')
  expect(responseReturned).toBe(false)
  expect(sends).toBe(1)
})

test('OC1 thrown transport error omits the credential it was sent with', async () => {
  const { owner, client } = await vaultFixture()
  owner.network.current = async (_url, init) => {
    throw new Error(
      `synthetic socket failure for ${authorizationOf(init)} ${echoOf(bearerValue(init))}`,
    )
  }
  const plugin = await createPlugin(owner, client)
  const records = captureLogs()
  const seen = await visible(sendNative(owner, plugin, 'oc1-transport-error'))
  expect(seen.status).toBeUndefined()
  expectScrubbed(seen.text, [vaultAccess(1)])
  expect(seen.text).toContain('synthetic socket failure')
  // Plugin log lines carry no provider or exception text at all.
  const logged = JSON.stringify(records)
  expectScrubbed(logged, [vaultAccess(1)])
  expect(logged).not.toContain('synthetic socket failure')
})

test('OC1 scrubs the final rotated vault credential after a 401 retry', async () => {
  const { owner, state, client } = await vaultFixture()
  const sent: string[] = []
  owner.network.current = async (_url, init) => {
    sent.push(authorizationOf(init))
    if (sent.length === 1) {
      state.version = 2
      return jsonError(401, 'authentication_error', bearerValue(init))
    }
    return jsonError(400, 'invalid_request_error', bearerValue(init))
  }
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, 'oc1-rotation'))
  expect(seen.status, seen.text).toBe(400)
  expectScrubbed(seen.text, [vaultAccess(1), vaultAccess(2)])
  expect(sent).toEqual([`Bearer ${vaultAccess(1)}`, `Bearer ${vaultAccess(2)}`])
})

test('OC1 HTTP relay error omits the upstream credential and the private relay token', async () => {
  const { owner, client } = await vaultFixture({ fallbackToDirect: false })
  const relayed: string[] = []
  owner.network.current = async (url, init) => {
    if (!url.startsWith(RELAY_URL)) throw new Error(`unexpected ${url}`)
    const authorization = relayAuthorization(init)
    relayed.push(authorization)
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `${echoOf(authorization.replace(/^Bearer /, ''))}; relay=${new Headers(init?.headers).get('x-relay-token')}`,
        },
      },
      { status: 400, headers: { 'request-id': 'req_synthetic_relay' } },
    )
  }
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, 'oc1-relay-error'))
  expect(seen.status, seen.text).toBe(400)
  expectScrubbed(seen.text, [vaultAccess(1), RELAY_TOKEN])
  expect(seen.text).toContain('invalid_request_error')
  expect(relayed).toEqual([`Bearer ${vaultAccess(1)}`])
})

test('OC1 thrown relay error omits the private relay token and the credential', async () => {
  const { owner, client } = await vaultFixture({ fallbackToDirect: false })
  owner.network.current = async (url, init) => {
    if (!url.startsWith(RELAY_URL)) throw new Error(`unexpected ${url}`)
    throw new Error(
      `synthetic relay socket failure token=${new Headers(init?.headers).get('x-relay-token')} upstream=${relayAuthorization(init)}`,
    )
  }
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, 'oc1-relay-throw'))
  expectScrubbed(seen.text, [vaultAccess(1), RELAY_TOKEN])
  expect(seen.text).toContain('synthetic relay socket failure')
})

test('OC1 relay failure rescued by direct dispatch scrubs the direct credential', async () => {
  const { owner, state, client } = await vaultFixture({
    fallbackToDirect: true,
  })
  const sent: string[] = []
  owner.network.current = async (url, init) => {
    if (url.startsWith(RELAY_URL)) {
      sent.push(`relay:${relayAuthorization(init)}`)
      state.version = 2
      return new Response('relay unavailable', { status: 503 })
    }
    sent.push(`direct:${authorizationOf(init)}`)
    return jsonError(400, 'invalid_request_error', bearerValue(init))
  }
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, 'oc1-relay-rescue'))
  expect(seen.status, seen.text).toBe(400)
  expectScrubbed(seen.text, [vaultAccess(1), vaultAccess(2), RELAY_TOKEN])
  expect(sent).toEqual([
    `relay:Bearer ${vaultAccess(1)}`,
    `direct:Bearer ${vaultAccess(2)}`,
  ])
})

test('OC1 local OAuth error omits the refreshed local credential', async () => {
  const { owner } = await localFixture(false)
  const sent: string[] = []
  owner.network.current = async (_url, init) => {
    sent.push(authorizationOf(init))
    return jsonError(400, 'invalid_request_error', bearerValue(init))
  }
  const plugin = await createPlugin(owner)
  const seen = await visible(sendNative(owner, plugin, 'oc1-local-error'))
  expect(seen.status, seen.text).toBe(400)
  expectScrubbed(seen.text, [LOCAL_ACCESS, LOCAL_ROTATED])
  expect(seen.text).toContain('invalid_request_error')
  expect(sent).toHaveLength(1)
})

test('OC1 usage-limit echo still reaches the paid route, whose error omits the paid key', async () => {
  const { owner } = await localFixture(true)
  const modelRequests: string[] = []
  owner.network.current = async (url, init) => {
    if (url.includes('/api/oauth/usage'))
      return Response.json({
        five_hour: {
          utilization: 100,
          resets_at: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
        },
        seven_day: {
          utilization: 100,
          resets_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        },
      })
    if (!url.includes('/v1/messages')) throw new Error(`unexpected ${url}`)
    const key = new Headers(init?.headers).get('x-api-key') ?? bearerValue(init)
    modelRequests.push(key)
    return url.startsWith('https://paid.invalid')
      ? jsonError(400, 'invalid_request_error', key)
      : jsonError(429, 'rate_limit_error', key)
  }
  const quotaPause = recordedQuotaPause()
  const plugin = await createPlugin(owner, undefined, quotaPause.pause)
  const seen = await visible(sendNative(owner, plugin, 'oc1-paid-error'))
  expect(modelRequests).toEqual([LOCAL_ROTATED, PAID_KEY])
  expectQuotaPollGaps(quotaPause.requested)
  expect(seen.status, seen.text).toBe(400)
  expectScrubbed(seen.text, [PAID_KEY, LOCAL_ROTATED])
  expect(seen.text).toContain('invalid_request_error')
})

test('OC1 stream diagnostics name the provider error type but never its message', async () => {
  const perf: Array<{ stage: string; data: Record<string, unknown> }> = []
  const stripped = createStrippedStream(
    eventStream(
      sse({ type: 'message_start', message: { id: 'msg_synthetic' } }) +
        sse(errorEnvelope('overloaded_error', vaultAccess(1))),
    ),
    { perf: (stage, data) => perf.push({ stage, data: data ?? {} }) },
  )
  const seen = await visible(Promise.resolve(stripped))
  expect(seen.text).toContain('overloaded_error')
  const failure = perf.find(
    (entry) => entry.stage === 'stream_tool_prefix_retryable_error',
  )
  expect(failure?.data.providerErrorType).toBe('overloaded_error')
  const logged = JSON.stringify(perf)
  expectScrubbed(logged, [vaultAccess(1)])
  expect(logged).not.toContain('exact=')
})

/** Spells every character of `text` as a JSON `\uXXXX` escape. */
const jsonEscaped = (text: string) =>
  [...text]
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')

/**
 * Runs one Prime send through the plugin's real Prime manager and returns the
 * result the plugin's sendPrime handed the manager. `model` answers each
 * Prime model request.
 */
async function runPrime(
  model: (
    url: string,
    init: FetchArgs[1],
    fixture: Awaited<ReturnType<typeof vaultFixture>>,
  ) => Promise<Response>,
) {
  const fixture = await vaultFixture()
  const { owner, client } = fixture
  const runtime = createNativeAccountRuntime({
    paths: await resolveNativePoolPaths(
      join(owner.directory, 'anthropic-auth.json'),
      process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
    ),
    host: 'opencode',
    vault: { connect: async () => client },
  })
  try {
    await runtime.updateSettings((settings) => ({
      ...settings,
      prime: { enabled: true },
    }))
  } finally {
    runtime.close()
  }
  const sent: string[] = []
  owner.network.current = async (url, init) => {
    if (url.includes('/api/oauth/usage'))
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
    if (!url.includes('/v1/messages')) throw new Error(`unexpected ${url}`)
    sent.push(authorizationOf(init))
    return model(url, init, fixture)
  }
  const plugin = await createPlugin(owner, client)
  const loader = plugin.auth?.loader
  if (!loader) throw new Error('Plugin did not install its auth loader')
  await loader(async () => custodyTombstoneOAuth('anthropic'), provider)
  const prime: unknown = getPluginTestHandles(plugin).primeManager
  if (!(prime instanceof PrimeManager))
    throw new Error('Native host Prime manager is unavailable')
  // Prime's failure reason never reaches a log or the UI: PrimeManager logs
  // only a fixed reason and the status. The reason is still what the plugin's
  // sendPrime hands PrimeManager, so capture that result through the
  // manager's own options without adding any API.
  const options: unknown = Reflect.get(prime, 'options')
  if (typeof options !== 'object' || options === null)
    throw new Error('Prime manager has no options')
  const realSend: unknown = Reflect.get(options, 'sendPrime')
  if (typeof realSend !== 'function')
    throw new Error('Prime manager has no sendPrime')
  const results: unknown[] = []
  Reflect.set(options, 'sendPrime', async (accountId: string) => {
    const result: unknown = await Reflect.apply(realSend, options, [accountId])
    results.push(result)
    return result
  })
  const records = captureLogs()
  try {
    await prime.tick()
  } finally {
    prime.stop()
  }
  const result = results[0]
  if (typeof result !== 'object' || result === null)
    throw new Error('Prime send returned no result')
  return { ...fixture, sent, result, records }
}

/**
 * Runs one failing Prime send, checks what it logged about the failure, and
 * returns the status and reason the plugin's sendPrime handed the manager.
 */
async function primeFailure(body: string) {
  const { sent, result, records } = await runPrime(
    async () =>
      new Response(body, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
  )
  expect(sent).toEqual([`Bearer ${vaultAccess(1)}`])
  const failure = records.find(
    (record) => record.message === 'prime fire failed',
  )
  if (!failure) throw new Error('Prime logged no failed send')
  // Prime logs carry the status and a fixed reason, never provider error text.
  expect(failure.payload).toMatchObject({ status: 400, reason: 'send' })
  const logged: unknown = failure.payload
  if (typeof logged !== 'object' || logged === null)
    throw new Error('Prime failure has no payload')
  expect(Reflect.get(logged, 'error')).toBeUndefined()
  expect(JSON.stringify(records)).not.toContain(vaultAccess(1))
  const error: unknown = Reflect.get(result, 'error')
  if (typeof error !== 'string') throw new Error('Prime result has no reason')
  expect(Reflect.get(result, 'ok')).toBe(false)
  return { status: Reflect.get(result, 'status'), error, records }
}

test('OC1 Prime failure reason scrubs JSON-escaped keys and credentials', async () => {
  const body = `{"type":"error","\\u0065rror":{"type":"invalid_request_error","\\u006dessage":"exact=${jsonEscaped(vaultAccess(1))}; jwt=${jsonEscaped(JWT)}"}}`
  expect(body).not.toContain(vaultAccess(1))
  expect(JSON.stringify(JSON.parse(body))).toContain(vaultAccess(1))
  const { status, error } = await primeFailure(body)
  expect(status).toBe(400)
  expect(error).toContain('invalid_request_error')
  // Decoding the reason must not reveal the credential either.
  const decoded = JSON.stringify(JSON.parse(error))
  expect(decoded).not.toContain(vaultAccess(1))
  expect(decoded).not.toContain(JWT)
})

test('OC1 Prime failure reason replaces an oversized error body', async () => {
  const filler = 'x'.repeat(2 * 1024 * 1024)
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `${filler} exact=${vaultAccess(1)}`,
    },
  })
  const { status, error } = await primeFailure(body)
  expect(status).toBe(400)
  expect(error).not.toContain(vaultAccess(1))
  expect(error.length).toBeLessThan(64 * 1024)
})

/**
 * An owned loopback WebSocket relay. Its first connection accepts the request
 * and then closes before any response, which makes the plugin reconnect and
 * authorize the request again. The second connection answers with a streamed
 * provider error that repeats the bearer the relay was given.
 */
function startReconnectingRelay(onFirstRequest: () => void) {
  const bearers: string[] = []
  let connections = 0
  // Open relay sockets, ended by teardown before it awaits the server stop.
  // Each open relay socket, with a promise its close handler resolves.
  const sockets = new Map<
    ServerWebSocket<{ connection: number }>,
    { closed: Promise<void>; resolve: () => void }
  >()
  const server = Bun.serve<{ connection: number }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, upgrade) {
      const url = new URL(request.url)
      if (
        url.pathname !== '/ws' ||
        url.searchParams.get('token') !== RELAY_TOKEN
      )
        return new Response('not found', { status: 404 })
      connections += 1
      return upgrade.upgrade(request, { data: { connection: connections } })
        ? undefined
        : new Response('upgrade failed', { status: 400 })
    },
    websocket: {
      open(socket) {
        let resolve = () => {}
        const closed = new Promise<void>((done) => {
          resolve = done
        })
        sockets.set(socket, { closed, resolve })
        socket.send(JSON.stringify({ protocol: 2, type: 'ready', state: null }))
      },
      close(socket) {
        sockets.get(socket)?.resolve()
        sockets.delete(socket)
      },
      message(socket, message) {
        if (typeof message !== 'string') return
        const payload: unknown = JSON.parse(message)
        if (typeof payload !== 'object' || payload === null) return
        const id: unknown = Reflect.get(payload, 'id')
        bearers.push(relayAuthorization({ body: message }))
        socket.send(
          JSON.stringify({
            protocol: 2,
            type: 'accepted',
            id,
            hash: Reflect.get(payload, 'next_hash'),
            revision: Reflect.get(payload, 'revision'),
          }),
        )
        if (socket.data.connection === 1) {
          onFirstRequest()
          socket.close()
          return
        }
        const bearer = (bearers.at(-1) ?? '').replace(/^Bearer /, '')
        socket.send(
          JSON.stringify({
            type: 'response_start',
            id,
            status: 200,
            statusText: 'OK',
            headers: {
              'content-type': 'text/event-stream',
              'request-id': 'req_synthetic_ws',
            },
          }),
        )
        socket.send(
          new TextEncoder().encode(
            sse(errorEnvelope('overloaded_error', bearer)),
          ),
        )
        socket.send(JSON.stringify({ type: 'done', id }))
      },
    },
  })
  relayServers.add({
    async close() {
      // End every relay socket and wait for each close handler to run.
      const open = [...sockets]
      for (const [socket] of open) socket.terminate()
      await Promise.all(open.map(([, entry]) => entry.closed))
      if (sockets.size !== 0 || server.pendingRequests !== 0)
        throw new Error(
          `relay server still busy: ${sockets.size} sockets, ${server.pendingRequests} requests`,
        )
      // stop(true) is called but its promise is not awaited. On Bun 1.3.14
      // this server's pendingWebSockets count stays at 2 after both sockets'
      // close handlers have run (measured in this hook: 0 tracked sockets,
      // 0 pending requests, pendingWebSockets 2 before and 1 s after the
      // call), and the promise never settles; Bun 1.4.2 settles it at once.
      // Nothing here waits for that promise, so this cleanup does not claim
      // the server stop finished. A later rejection is reported by the next
      // teardown.
      server.stop(true).catch((error: unknown) => {
        lateRelayStopFailures.push(error)
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, bearers }
}

test('OC1 optimistic WebSocket reconnect with an unchanged credential scrubs it', async () => {
  const relay = startReconnectingRelay(() => {})
  const { owner, client } = await vaultFixture({
    fallbackToDirect: false,
    url: relay.url,
    transport: 'websocket',
  })
  owner.network.current = async (url) => {
    throw new Error(`unexpected HTTP ${url}`)
  }
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, 'oc1-ws-same'))
  expect(relay.bearers).toEqual([
    `Bearer ${vaultAccess(1)}`,
    `Bearer ${vaultAccess(1)}`,
  ])
  expect(seen.text).toContain('overloaded_error')
  expectScrubbed(seen.text, [vaultAccess(1)])
}, 20_000)

/**
 * Close the first relay connection before any response. Apply the supplied
 * change to the vault record's version, account or refusal flag before reconnecting.
 */
async function reconnectAfter(
  change: (state: {
    version: number
    account: string
    refused: boolean
  }) => void,
  sessionId: string,
) {
  const holder: {
    state?: { version: number; account: string; refused: boolean }
  } = {}
  const relay = startReconnectingRelay(() => {
    if (holder.state) change(holder.state)
  })
  const { owner, state, client } = await vaultFixture({
    fallbackToDirect: false,
    url: relay.url,
    transport: 'websocket',
  })
  holder.state = state
  owner.network.current = async (url) => {
    throw new Error(`unexpected HTTP ${url}`)
  }
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, sessionId))
  return { seen, bearers: relay.bearers }
}

// The vault rotates the same account to credential version 2 before reconnect.
// The relay must scrub the response with version 2's credential. Recording the
// old credential's last-used timestamp is advisory: skip that stale update
// rather than abort the already-authorized response.
test('OC1 optimistic WebSocket reconnect onto a newer same-account vault record scrubs it', async () => {
  const { seen, bearers } = await reconnectAfter((state) => {
    state.version = 2
  }, 'oc1-ws-rotation')
  expect(bearers).toEqual([
    `Bearer ${vaultAccess(1)}`,
    `Bearer ${vaultAccess(2)}`,
  ])
  expectScrubbed(seen.text, [vaultAccess(1), vaultAccess(2)])
  expect(seen.text).toContain('overloaded_error')
}, 20_000)

test('OC1 optimistic WebSocket reconnect onto a replaced vault account is refused without a credential', async () => {
  const { seen, bearers } = await reconnectAfter((state) => {
    state.version = 2
    state.account = '44444444-4444-4444-8444-444444444444'
  }, 'oc1-ws-replaced')
  // The account UUID changes while the credential ID stays the same.
  // Refuse the reconnect before sending with that different account.
  expect(bearers).toEqual([`Bearer ${vaultAccess(1)}`])
  expect(seen.text).toContain('Native custody refused: identity-changed')
  expectScrubbed(seen.text, [vaultAccess(1), vaultAccess(2)])
}, 20_000)

test('OC1 optimistic WebSocket reconnect refused by custody exposes no credential', async () => {
  const { seen, bearers } = await reconnectAfter((state) => {
    state.refused = true
  }, 'oc1-ws-refused')
  expect(bearers).toEqual([`Bearer ${vaultAccess(1)}`])
  expect(seen.text).toContain('Native custody refused: unavailable')
  expectScrubbed(seen.text, [vaultAccess(1), vaultAccess(2)])
}, 20_000)

/** A streamed body served with a plain-text or missing content type. */
function untypedStream(text: string, contentType: 'text/plain' | undefined) {
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    {
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        'request-id': 'req_synthetic_oc1',
      },
    },
  )
}

for (const contentType of ['text/plain', undefined] as const) {
  const name = contentType ?? 'no content type'
  test(`OC1 streamed error served as ${name} is scrubbed because the request streamed`, async () => {
    const { owner, client } = await vaultFixture()
    owner.network.current = async (_url, init) =>
      untypedStream(
        sse(errorEnvelope('overloaded_error', bearerValue(init))),
        contentType,
      )
    const plugin = await createPlugin(owner, client)
    const seen = await visible(sendNative(owner, plugin, `oc1-untyped-${name}`))
    expectScrubbed(seen.text, [vaultAccess(1)])
    expect(seen.text).toContain('overloaded_error')
  })

  test(`OC1 successful stream served as ${name} stays byte-identical`, async () => {
    const { owner, client } = await vaultFixture()
    const body = healthy(`error notes ${echoOf(vaultAccess(1))}`)
    owner.network.current = async () => untypedStream(body, contentType)
    const plugin = await createPlugin(owner, client)
    const response = await sendNative(owner, plugin, `oc1-untyped-ok-${name}`)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new TextEncoder().encode(body),
    )
  })
}

// OpenCode 1 detects rate limits from the first SSE error event's type,
// not from ordinary reply text. This fixture's main OAuth account has exhausted
// its general quota, so a real rate-limit event triggers a fresh quota check
// and permits the configured paid API fallback.

/** A streamed body delivered in the given chunks. */
function chunkedStream(chunks: readonly string[]) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_synthetic_oc1',
      },
    },
  )
}

async function streamedLimitRoute(primary: (key: string) => Response) {
  const { owner } = await localFixture(true)
  const routes: string[] = []
  let usagePolls = 0
  owner.network.current = async (url, init) => {
    if (url.includes('/api/oauth/usage')) {
      usagePolls++
      return Response.json({
        five_hour: {
          utilization: 100,
          resets_at: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
        },
        seven_day: {
          utilization: 100,
          resets_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        },
      })
    }
    if (!url.includes('/v1/messages')) throw new Error(`unexpected ${url}`)
    const key = new Headers(init?.headers).get('x-api-key') ?? bearerValue(init)
    routes.push(key === PAID_KEY ? 'paid' : 'primary')
    return url.startsWith('https://paid.invalid')
      ? eventStream(healthy('paid route answered'))
      : primary(key)
  }
  const quotaPause = recordedQuotaPause()
  const plugin = await createPlugin(owner, undefined, quotaPause.pause)
  const seen = await visible(
    sendNative(owner, plugin, `oc1-limit-${Date.now()}`),
  )
  expectQuotaPollGaps(quotaPause.requested)
  return { routes, usagePolls, seen }
}

const rateLimitFrame = (key: string) =>
  sse(errorEnvelope('rate_limit_error', key))

test('OC1 a streamed rate_limit_error event refreshes quota and reroutes', async () => {
  const { routes, usagePolls, seen } = await streamedLimitRoute((key) =>
    eventStream(rateLimitFrame(key)),
  )
  expect(routes).toEqual(['primary', 'paid'])
  expect(usagePolls).toBeGreaterThan(0)
  expect(seen.text).toContain('paid route answered')
})

test('OC1 a rate_limit_error event split across reads with CRLF framing is detected', async () => {
  const { routes, seen } = await streamedLimitRoute((key) => {
    const frame = rateLimitFrame(key).replaceAll('\n', '\r\n')
    const cut = frame.indexOf('rate_limit') + 5
    return chunkedStream([frame.slice(0, cut), frame.slice(cut)])
  })
  expect(routes).toEqual(['primary', 'paid'])
  expect(seen.text).toContain('paid route answered')
})

test('OC1 a rate_limit_error event after a heartbeat comment in an earlier read is detected', async () => {
  const { routes, seen } = await streamedLimitRoute((key) =>
    chunkedStream([': keepalive\n\n', rateLimitFrame(key)]),
  )
  expect(routes).toEqual(['primary', 'paid'])
  expect(seen.text).toContain('paid route answered')
})

test('OC1 a rate_limit_error event spelled with JSON escapes is detected', async () => {
  const { routes, seen } = await streamedLimitRoute(() =>
    chunkedStream([
      'event: error\ndata: {"\\u0074ype":"\\u0065rror","\\u0065rror":{"\\u0074ype":"\\u0072ate_limit_\\u0065rror","\\u006dessage":"slow down"}}\n\n',
    ]),
  )
  expect(routes).toEqual(['primary', 'paid'])
  expect(seen.text).toContain('paid route answered')
})

test('OC1 reply text that mentions rate limits neither refreshes quota nor reroutes', async () => {
  // Compare usage-poll counts with an otherwise identical plain-text reply.
  // Background polls occur independently; the difference isolates text matching.
  const plain = await streamedLimitRoute(() =>
    eventStream(healthy('Notes: an ordinary reply.')),
  )
  const text =
    "Notes: a rate_limit_error means you exceed your account's rate limit."
  const mention = await streamedLimitRoute(() => eventStream(healthy(text)))
  expect(plain.routes).toEqual(['primary'])
  expect(mention.routes).toEqual(['primary'])
  expect(mention.usagePolls).toBe(plain.usagePolls)
  expect(mention.seen.text).toContain('rate_limit_error means you exceed')
})

test('OC1 a rate_limit_error event after a stream-start byte-order mark is detected', async () => {
  const { routes, seen } = await streamedLimitRoute((key) =>
    // The byte-order mark directly precedes the first frame's data line.
    chunkedStream([
      '\uFEFF',
      `data: ${JSON.stringify(errorEnvelope('rate_limit_error', key))}\n\n`,
    ]),
  )
  expect(routes).toEqual(['primary', 'paid'])
  expect(seen.text).toContain('paid route answered')
})

/** What retry and abort handling read from a thrown transport error. */
function decisionFields(text: string, error: unknown) {
  if (!(error instanceof Error)) return { thrown: typeof error }
  const cause: unknown = Reflect.get(error, 'cause')
  return {
    name: error.name,
    causeCode:
      typeof cause === 'object' && cause !== null
        ? Reflect.get(cause, 'code')
        : undefined,
    scrubbed: !text.includes(vaultAccess(1)),
  }
}

async function transportFailure(failure: (bearer: string) => unknown) {
  const { owner, client } = await vaultFixture()
  owner.network.current = async (_url, init) => {
    throw failure(bearerValue(init))
  }
  const plugin = await createPlugin(owner, client)
  try {
    await sendNative(owner, plugin, `oc1-transport-${Date.now()}`)
  } catch (error) {
    const text = JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      cause:
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : undefined,
    })
    return decisionFields(text, error)
  }
  throw new Error('transport failure was not thrown')
}

test('OC1 scrubbed transport errors keep the name and network code retry handling reads', async () => {
  const network = (detail: string) =>
    new TypeError(`fetch failed ${detail}`, {
      cause: Object.assign(new Error(`connect ECONNRESET ${detail}`), {
        code: 'ECONNRESET',
      }),
    })
  const plain = await transportFailure(() => network('plain'))
  const echoed = await transportFailure((bearer) => network(bearer))
  expect(plain).toEqual({
    name: 'TypeError',
    causeCode: 'ECONNRESET',
    scrubbed: true,
  })
  expect(echoed).toEqual(plain)
  const aborted = await transportFailure(
    (bearer) => new DOMException(`aborted ${bearer}`, 'AbortError'),
  )
  expect(aborted).toEqual({
    name: 'AbortError',
    causeCode: undefined,
    scrubbed: true,
  })
})

test('a scrubbed AI SDK APICallError keeps the fields its retry and rate-limit handling read', () => {
  const scope = createProviderErrorResponseScope([vaultAccess(1)], 'http')
  const original = new APICallError({
    message: `Rate limited ${vaultAccess(1)}`,
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { 'retry-after': '7' },
    responseBody: JSON.stringify(
      errorEnvelope('rate_limit_error', vaultAccess(1)),
    ),
    isRetryable: true,
  })
  const projected = scope.redactError(original)
  scope.dispose()
  expect(APICallError.isInstance(projected)).toBe(true)
  if (!APICallError.isInstance(projected))
    throw new Error('projection lost the APICallError marker')
  expect(projected.statusCode).toBe(429)
  expect(projected.isRetryable).toBe(true)
  expect(projected.responseHeaders?.['retry-after']).toBe('7')
  expect(JSON.stringify(projected)).not.toContain(vaultAccess(1))
  expect(projected.message).not.toContain(vaultAccess(1))
})

// The tests below answer model requests from a real 127.0.0.1 server: the
// request leaves through Bun's own fetch with the headers the plugin built,
// the server echoes the credential it actually received, and kept-open
// bodies show whether the plugin cancelled them.

const encoder = new TextEncoder()
/** How long a test waits for a cancellation it expects. */
const CANCEL_WAIT_MS = 2_000
// The cancellation gate of each kept-open response, by the id its response
// header carries.
const keptOpenGates = new Map<string, TestGate>()
const KEPT_OPEN_HEADER = 'x-loopback-kept-open'

/** A model handler that forwards each request to a loopback server. */
function loopbackModel(
  serve: (wire: { bearer: string; apiKey: string }) => Response,
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // A kept-open body must stay open until the client cancels it.
    idleTimeout: 0,
    fetch(request) {
      return serve({
        bearer: (request.headers.get('authorization') ?? '').replace(
          /^Bearer /,
          '',
        ),
        apiKey: request.headers.get('x-api-key') ?? '',
      })
    },
  })
  // Teardown ends kept-open responses and cancels their client reads before
  // this runs, so the stop can be awaited.
  lifetimes.deferCleanup(() => server.stop(true))
  return async (url: string, init: FetchArgs[1]) => {
    const target = new URL(url)
    return observeCancel(
      await originalFetch(
        `http://127.0.0.1:${server.port}${target.pathname}${target.search}`,
        init,
      ),
    )
  }
}

/**
 * Hand the plugin the real fetch body behind a pass-through whose cancel
 * opens the body's gate before forwarding. Bun 1.3 does not tell the server
 * when a client cancels a fetch body, so the cancellation is observed here,
 * on the client side of the physical body.
 */
function observeCancel(response: Response) {
  const cancelled = keptOpenGates.get(
    response.headers.get(KEPT_OPEN_HEADER) ?? '',
  )
  const source = response.body
  if (!cancelled || !source) return response
  const reader = source.getReader()
  // Teardown opens the lifetime gate created below before it waits for the test body, so a body
  // still reading the real HTTP response is released rather than joined.
  void lifetimes.gate().wait.then(() => reader.cancel().catch(() => {}))
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        },
        cancel(reason) {
          cancelled.open()
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
}

/**
 * A response that sends `text` and then stays open, unless `close` ends it.
 * `cancelled` opens when the client cancels the physical body.
 */
function keptOpen(
  text: string,
  cancelled: TestGate,
  { status = 200, close = false, contentType = 'application/json' } = {},
) {
  const id = crypto.randomUUID()
  keptOpenGates.set(id, cancelled)
  lifetimes.deferCleanup(() => {
    keptOpenGates.delete(id)
  })
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        if (close) controller.close()
        // Teardown ends a still-open response before it waits for the body.
        else
          void lifetimes.gate().wait.then(() => {
            try {
              controller.close()
            } catch {
              // Already cancelled by the client.
            }
          })
      },
    }),
    {
      status,
      headers: {
        'content-type': contentType,
        'request-id': 'req_synthetic_oc1',
        [KEPT_OPEN_HEADER]: id,
      },
    },
  )
}

/** True when `wait` settles within the bound, false when it does not. */
async function within(wait: Promise<unknown>, ms = CANCEL_WAIT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      wait.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const errorText = (type: string, secret: string) =>
  JSON.stringify(errorEnvelope(type, secret))

test('OC1 Prime retries a real first 401 with the advanced vault receipt after cancelling the rejected body', async () => {
  const cancelled = lifetimes.gate()
  const wire: string[] = []
  let forward: ReturnType<typeof loopbackModel> | undefined
  const { sent, result, state } = await runPrime((url, init, fixture) => {
    forward ??= loopbackModel(({ bearer }) => {
      wire.push(bearer)
      if (bearer === vaultAccess(1)) {
        fixture.state.version = 2
        return keptOpen(errorText('authentication_error', bearer), cancelled, {
          status: 401,
        })
      }
      return jsonError(400, 'invalid_request_error', bearer)
    })
    return forward(url, init)
  })
  expect(sent).toEqual([`Bearer ${vaultAccess(1)}`, `Bearer ${vaultAccess(2)}`])
  expect(wire).toEqual([vaultAccess(1), vaultAccess(2)])
  expect(Reflect.get(result, 'status')).toBe(400)
  const reason = String(Reflect.get(result, 'error'))
  expect(reason).toContain('invalid_request_error')
  expectScrubbed(reason, [vaultAccess(1), vaultAccess(2)])
  // Only the final receipt's response is reported, and it was not a 401.
  expect(state.reports).toEqual([])
  expect(await within(cancelled.wait)).toBe(true)
})

test('OC1 Prime reports a final rejected 401 against the retried receipt and scrubs its reason', async () => {
  const wire: string[] = []
  let forward: ReturnType<typeof loopbackModel> | undefined
  const { result, state } = await runPrime((url, init, fixture) => {
    forward ??= loopbackModel(({ bearer }) => {
      wire.push(bearer)
      if (bearer === vaultAccess(1)) fixture.state.version = 2
      return jsonError(401, 'authentication_error', bearer)
    })
    return forward(url, init)
  })
  expect(wire).toEqual([vaultAccess(1), vaultAccess(2)])
  expect(Reflect.get(result, 'status')).toBe(401)
  const reason = String(Reflect.get(result, 'error'))
  expect(reason).toContain('authentication_error')
  expectScrubbed(reason, [vaultAccess(1), vaultAccess(2)])
  expect(state.reports).toEqual([{ recordVersion: 2, providerStatus: 401 }])
})

test('OC1 lastUsed custody refusal keeps the reply and logs ERROR; the next authorization refuses', async () => {
  const { owner, client } = await vaultFixture()
  const logs = captureLogs()
  const cancelled = lifetimes.gate()
  const wire: string[] = []
  const forward = loopbackModel(({ bearer }) => {
    wire.push(bearer)
    return keptOpen(healthy(echoOf(bearer)), cancelled, {
      close: true,
      contentType: 'text/event-stream',
    })
  })
  owner.network.current = async (url, init) => {
    // The vault enrollment disappears while the model reply is in flight,
    // so the lastUsed publication after the reply meets a custody guard.
    await rm(join(owner.directory, 'enrollment.json'), { force: true })
    return forward(url, init)
  }
  const plugin = await createPlugin(owner, client)
  const seen = await visible(sendNative(owner, plugin, 'oc1-lastused-guard'))
  expect(wire).toEqual([vaultAccess(1)])
  expect(seen.status).toBe(200)
  expect(seen.text).toBe(healthy(echoOf(vaultAccess(1))))
  await plugin.dispose?.()
  expect(
    logs.filter(
      (record) => record.message === 'Account usage publication unavailable',
    ),
  ).toMatchObject([
    {
      level: 'error',
      payload: { name: 'NativeCustodyError', code: 'route-unavailable' },
    },
  ])
  expect(await within(cancelled.wait, 100)).toBe(false)
  const next = await createPlugin(owner, client)
  const refused = await visible(sendNative(owner, next, 'oc1-lastused-revoked'))
  expect(refused.status).toBeUndefined()
  expect(wire).toEqual([vaultAccess(1)])
})

test('OC1 serves first byte and full body while the roster lock is held, then drains lastUsed before close', async () => {
  const { owner, client } = await vaultFixture()
  const plugin = await createPlugin(owner, client)
  const paths = nativeVaultPaths(
    await resolveNativePoolPaths(
      join(owner.directory, 'anthropic-auth.json'),
      process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
    ),
  )
  const locked = lifetimes.gate()
  const release = lifetimes.gate()
  owner.controller.signal.addEventListener('abort', () => release.open(), {
    once: true,
  })
  let released = false
  let holder: Promise<unknown> | undefined
  const body = healthy('début 🧪 served under contention')
  owner.network.current = async () => {
    holder = mutateVaultRoster(paths.roster, async () => {
      locked.open()
      await release.wait
      released = true
      return { result: undefined }
    })
    lifetimes.trackDetached(holder)
    await locked.wait
    return eventStream(body)
  }
  const response = await sendNative(owner, plugin, 'oc1-lastused-held-lock')
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(first.done).toBe(false)
  expect(released).toBe(false)
  const chunks = [first.value!]
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
  }
  expect(Buffer.concat(chunks).toString()).toBe(body)
  expect(released).toBe(false)
  let closed = false
  client.close = () => {
    closed = true
  }
  let disposed = false
  const disposing = Promise.resolve(plugin.dispose?.()).then(() => {
    disposed = true
  })
  lifetimes.trackDetached(disposing)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(disposed).toBe(false)
  expect(closed).toBe(false)
  release.open()
  await holder
  await disposing
  expect(closed).toBe(true)
  const runtime = JSON.parse(await readFile(paths.runtime, 'utf8'))
  expect(
    Object.values(runtime.accounts).some(
      (entry) => Number(Reflect.get(entry as object, 'lastUsed')) > 0,
    ),
  ).toBe(true)
})

for (const contended of [false, true]) {
  test(`OC1 advisory shutdown ${contended ? 'drops contended bookkeeping without disturbing its holder' : 'persists uncontended lastUsed'}`, async () => {
    const { owner, client } = await vaultFixture()
    const plugin = await createPlugin(owner, client)
    const paths = nativeVaultPaths(
      await resolveNativePoolPaths(
        join(owner.directory, 'anthropic-auth.json'),
        process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
      ),
    )
    const logs = captureLogs()
    const disk = () =>
      readFile(paths.runtime, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    const before = await disk()
    const started = Date.now()
    let holder: Awaited<ReturnType<typeof acquireRefreshFileLock>>
    owner.network.current = async () => {
      if (contended) {
        holder = await acquireRefreshFileLock({
          path: paths.runtime,
          name: 'native-runtime',
          ttlMs: 10_000,
        })
        expect(holder).not.toBeNull()
        lifetimes.deferCleanup(async () => {
          await holder?.release()
        })
      }
      const response = eventStream(healthy('served before bookkeeping'))
      response.headers.set('anthropic-ratelimit-unified-5h-utilization', '0.25')
      return response
    }
    expect((await sendNative(owner, plugin, 'oc1-shutdown-grace')).status).toBe(
      200,
    )
    const closingAt = performance.now()
    await plugin.dispose?.()
    expect(performance.now() - closingAt).toBeLessThan(1_750)
    const drops = logs.filter(
      (record) =>
        record.message === 'Account usage publications dropped at shutdown',
    )
    if (contended) {
      await holder!.assertOwned()
      expect(await disk()).toBe(before)
      expect(drops).toMatchObject([{ level: 'debug', payload: { count: 2 } }])
      expect(Object.keys(drops[0]!.payload!)).toEqual(['count'])
    } else {
      const runtime = JSON.parse(await readFile(paths.runtime, 'utf8'))
      expect(
        Object.values(runtime.accounts).some(
          (entry) =>
            Number(Reflect.get(entry as object, 'lastUsed')) >= started,
        ),
      ).toBe(true)
      expect(drops).toEqual([])
    }
  }, 15_000)
}

test('OC1 absorbs real runtime lease loss after serving the intact reply', async () => {
  const { owner, client } = await vaultFixture()
  const plugin = await createPlugin(owner, client)
  const logs = captureLogs()
  const paths = nativeVaultPaths(
    await resolveNativePoolPaths(
      join(owner.directory, 'anthropic-auth.json'),
      process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE,
    ),
  )
  const unhandled: unknown[] = []
  const observeUnhandled = (error: unknown) => {
    unhandled.push(error)
  }
  process.on('unhandledRejection', observeUnhandled)
  lifetimes.deferCleanup(() => {
    process.off('unhandledRejection', observeUnhandled)
  })
  let armed = false
  let displaced = false
  const original = filesystem.open
  const staging = spyOn(filesystem, 'open').mockImplementation(
    async (path, flags, mode) => {
      const file = await original(path, flags, mode)
      if (
        typeof path === 'string' &&
        path.startsWith(`${paths.runtime}.native-runtime.`) &&
        path.endsWith('.partial')
      ) {
        const write = file.writeFile.bind(file)
        file.writeFile = async (data, options) => {
          const state = JSON.parse(String(data)) as {
            accounts: Record<string, { lastUsed?: number }>
          }
          // Displace the real runtime lease only for response usage, not a
          // quota update that happens to stage first after the response.
          if (
            armed &&
            !displaced &&
            Object.values(state.accounts).some((entry) => entry.lastUsed)
          ) {
            const lock = lockPathFor(paths.runtime, 'native-runtime')
            expect(JSON.parse(await readFile(lock, 'utf8'))).toMatchObject({
              ownerId: expect.any(String),
            })
            await writeFile(
              lock,
              JSON.stringify({
                ownerId: 'synthetic-other-owner',
                expiresAt: 0,
              }),
            )
            displaced = true
          }
          return write(data, options)
        }
      }
      return file
    },
  )
  lifetimes.deferCleanup(() => staging.mockRestore())
  const body = healthy('début 🧪 lease loss cannot retract these bytes')
  owner.network.current = async () => {
    armed = true
    return eventStream(body)
  }
  const response = await sendNative(owner, plugin, 'oc1-lastused-lease-refusal')
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(body)
  const draining = Promise.resolve(plugin.dispose?.())
  lifetimes.trackDetached(draining)
  await draining
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(displaced).toBe(true)
  expect(unhandled).toEqual([])
  expect(
    logs.filter(
      (record) => record.message === 'Account usage publication unavailable',
    ),
  ).toMatchObject([
    {
      level: 'error',
      payload: { name: 'NativeRuntimeError', code: 'publication-refused' },
    },
  ])
  const diagnostic = JSON.stringify(
    logs.filter(
      (record) => record.message === 'Account usage publication unavailable',
    ),
  )
  expect(diagnostic).not.toContain(owner.directory)
  expect(diagnostic).not.toContain(vaultAccess(1))
}, 15_000)

// A paid key with surrounding whitespace would leave without it, because
// setting a header trims the value, and a provider echo of the trimmed key
// would then miss the configured spelling. The account store refuses to
// add such a key, and a hand-padded stored key fails its validation, so it
// is never sent. These tests pin that down on a real wire.
const PADDED_KEY = ' opaque-secret-7c32 '

/** Serve an exhausted usage reading and a 429 from the main account. */
function exhaustedMain(url: string, init: FetchArgs[1]) {
  if (url.includes('/api/oauth/usage'))
    return Response.json({
      five_hour: {
        utilization: 100,
        resets_at: new Date(Date.now() + 5 * 60 * 60_000).toISOString(),
      },
      seven_day: {
        utilization: 100,
        resets_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      },
    })
  if (!url.includes('/v1/messages')) throw new Error(`unexpected ${url}`)
  return jsonError(429, 'rate_limit_error', bearerValue(init))
}

test('OC1 API lastUsed storage failure is detached, drained and warns without changing reply bytes', async () => {
  const { owner } = await localFixture(true)
  const logs = captureLogs()
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  owner.controller.signal.addEventListener('abort', () => release.open(), {
    once: true,
  })
  let armed = false
  let fired = false
  const original = filesystem.open
  const staging = spyOn(filesystem, 'open').mockImplementation(
    async (path, flags, mode) => {
      const file = await original(path, flags, mode)
      if (
        typeof path === 'string' &&
        basename(path).includes('.native-runtime.') &&
        path.endsWith('.partial')
      ) {
        const write = file.writeFile.bind(file)
        file.writeFile = async (data, options) => {
          // Quota publication can start after the paid reply too. Fail only
          // the API usage update, not whichever runtime write wins the race.
          if (
            armed &&
            !fired &&
            JSON.parse(String(data)).accounts.paid?.lastUsed
          ) {
            fired = true
            entered.open()
            await release.wait
            throw Object.assign(new Error(`/private/roster/${PAID_KEY}`), {
              code: 'EIO',
            })
          }
          return write(data, options)
        }
      }
      return file
    },
  )
  lifetimes.deferCleanup(() => staging.mockRestore())
  const body = healthy('début 🧪 paid reply')
  owner.network.current = async (url, init) => {
    if (!url.startsWith('https://paid.invalid')) return exhaustedMain(url, init)
    armed = true
    return eventStream(body)
  }
  const quotaPause = recordedQuotaPause()
  const plugin = await createPlugin(owner, undefined, quotaPause.pause)
  const response = await sendNative(owner, plugin, 'oc1-api-lastused-io')
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(body)
  expectQuotaPollGaps(quotaPause.requested)
  await entered.wait
  let disposed = false
  const disposing = Promise.resolve(plugin.dispose?.()).then(() => {
    disposed = true
  })
  lifetimes.trackDetached(disposing)
  await Promise.resolve()
  expect(disposed).toBe(false)
  release.open()
  await disposing
  expect(
    logs.filter(
      (record) => record.message === 'Account usage publication unavailable',
    ),
  ).toMatchObject([
    {
      level: 'warn',
      payload: { name: 'NativeRuntimeError', code: 'runtime-io' },
    },
  ])
  expect(
    JSON.stringify(
      logs.filter(
        (record) => record.message === 'Account usage publication unavailable',
      ),
    ),
  ).not.toContain(PAID_KEY)
})

/**
 * Pad the paid key in every stored file. The store refuses to import a
 * padded key, so only a hand-edited file can carry one.
 */
async function padStoredKey(directory: string) {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })
  let padded = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const text = await readFile(path, 'utf8')
    if (!text.includes(PAID_KEY)) continue
    await writeFile(path, text.replaceAll(PAID_KEY, PADDED_KEY))
    padded++
  }
  return padded
}

test('OC1 refuses to import a paid key with surrounding whitespace', async () => {
  await expect(localFixture(true, PADDED_KEY)).rejects.toThrow('invalid-source')
})

test('OC1 never sends a hand-padded stored paid key', async () => {
  const { owner } = await localFixture(true)
  expect(await padStoredKey(owner.directory)).toBeGreaterThan(0)
  const paidRequests: string[] = []
  const paid = loopbackModel(({ bearer, apiKey }) => {
    paidRequests.push(apiKey || bearer)
    return jsonError(400, 'invalid_request_error', apiKey || bearer)
  })
  owner.network.current = async (url, init) =>
    url.startsWith('https://paid.invalid')
      ? paid(url, init)
      : exhaustedMain(url, init)
  const plugin = await createPlugin(owner)
  const seen = await visible(sendNative(owner, plugin, 'oc1-paid-padded'))
  expect(paidRequests).toEqual([])
  expectScrubbed(seen.text, [LOCAL_ROTATED, PADDED_KEY.trim()])
  expect(seen.text).not.toContain('invalid_request_error')
})
