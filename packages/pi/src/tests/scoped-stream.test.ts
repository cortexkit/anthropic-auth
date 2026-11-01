import { expect, test as registerTest, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setLogTestSink,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  type NativeCustodyClient as ClaustrumScopedClient,
  getLogLevel,
  type LogTestRecord,
  NativeCustodyError,
  PER_TURN_CONTROL_BETA,
  resolveNativePoolPaths,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import {
  ClaustrumCredentialError,
  type ScopedInventoryRow,
} from '@cortexkit/claustrum-client'
import type {
  Api,
  Context,
  Credential,
  CredentialStore,
  Model,
  Provider,
} from '@earendil-works/pi-ai'
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  ModelRuntime,
  type ProviderConfig,
} from '@earendil-works/pi-coding-agent'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import {
  recordedTimers,
  watchableVaultClient,
} from '../../../core/src/tests/vault-watch-fixture.ts'
import cortexKitPiAnthropicAuth from '../index.ts'
import {
  closePiNativeRuntime,
  getPiNativeRuntime,
  PI_VAULT_POLL_INTERVAL_MS,
  PiNativeRuntime,
} from '../native.ts'
import {
  __prewarmPiCacheKeepForTest,
  streamCortexKitAnthropic,
} from '../stream.ts'
import {
  fixtureAccountIdentity,
  readNativePiFixture,
  saveNativePiFixture,
} from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

const originalFetch = globalThis.fetch
const lifetimes = createTestLifetimeSuite()
const { deferCleanup } = lifetimes
const wrapBody = <Args extends unknown[]>(body: (...args: Args) => unknown) =>
  lifetimes.wrapBody((...args: Args) =>
    trackPiTestBody(Promise.resolve().then(() => body(...args))),
  )
const test = (name: string, body: () => unknown, timeout?: number) =>
  registerTest(name, wrapBody(body), timeout)
let dir: string | undefined
let path: string | undefined
const model: Model<Api> = {
  id: 'claude-fable-5-1',
  name: 'Fable',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const context: Context = {
  systemPrompt: 'Test',
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
  tools: [],
}
const success = () =>
  new Response(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  )
const row = (id: string, accountId: string): ScopedInventoryRow => ({
  id,
  accountId,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  providerIds: [],
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 1,
  createdAtMs: null,
})
async function fixture(
  mode: 'main-first' | 'fallback-first' | 'sticky-balanced' = 'main-first',
  relay = false,
) {
  dir = await mkdtemp(join(tmpdir(), 'pi-scoped-stream-'))
  path = join(dir, 'accounts.json')
  const root = dir
  const storagePath = path
  const envKeys = [
    'PI_CODING_AGENT_DIR',
    'PI_AGENT_DIR',
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
    'PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  ]
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  deferCleanup(async () => {
    await closePiNativeRuntime(storagePath)
    globalThis.fetch = originalFetch
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (path === storagePath) {
      path = undefined
      dir = undefined
    }
  })
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const tokenPath = join(dir, 'pi-token.json')
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_AGENT_DIR = dir
  process.env.PI_ANTHROPIC_AUTH_FILE = path
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          id: 'paid',
          type: 'api',
          apiKey: 'paid-test-key',
          baseURL: 'https://paid.invalid',
        },
      ],
      routing: { mode },
      ...(relay
        ? {
            relay: {
              enabled: true,
              url: 'https://relay.invalid',
              token: 'relay-test-secret',
              transport: 'http',
              fallbackToDirect: true,
            },
          }
        : {}),
    },
    path,
    { primary: false },
  )
  const localPaths = await resolveNativePoolPaths(
    storagePath,
    join(root, 'anthropic-auth-state.json'),
  )
  const localFiles = [
    localPaths.config,
    localPaths.state,
    localPaths.runtime,
    localPaths.journal,
  ]
  const beforeLocal = await Promise.all(
    localFiles.map((file) => readFile(file)),
  )
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const rows = [row('oauth:anthropic', fixtureAccountIdentity('main'))]
  const gets: Array<Parameters<ClaustrumScopedClient['getScoped']>[0]> = []
  const reports: Array<
    Parameters<ClaustrumScopedClient['reportAuthFailureScoped']>[0]
  > = []
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({
      rows,
      view: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async (input) => {
      gets.push(input)
      return {
        credentialId: input.credentialId,
        accountId: rows.find((entry) => entry.id === input.credentialId)
          ?.accountId,
        material: `vault-test-access-${gets.length}`,
        recordVersion: gets.length,
        expiresAtMs: Date.now() + 600_000,
      }
    },
    reportAuthFailureScoped: async (input) => {
      reports.push(input)
    },
    close: () => {},
  }
  const connect = async () => client
  // Tests publish roster changes explicitly; a background poll would make
  // discovery timing nondeterministic. One test below enables it on purpose.
  const native = getPiNativeRuntime(path, {
    connect,
    vaultPoll: { intervalMs: 0 },
  })
  const service = await native.service()
  const roster = await service.vault.refresh()
  await service.updateSettings((settings) => ({
    ...settings,
    routing: { mode },
  }))
  if (relay)
    await service.updateRelay({
      enabled: true,
      url: 'https://relay.invalid',
      token: 'relay-test-secret',
      transport: 'http',
      fallbackToDirect: true,
    })
  const primary = roster?.rows.find(
    (account) => account.credentialId === 'oauth:anthropic',
  )
  if (!primary?.accountIdentity)
    throw new Error('Fixture vault primary identity is missing')
  return {
    rows,
    gets,
    reports,
    client,
    connect,
    path,
    localFiles,
    beforeLocal,
    native,
  }
}

test('Pi background vault poll adopts a main re-login while a fallback serves, with no request-time discovery', async () => {
  const f = await fixture('main-first')
  f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  const service = await f.native.service()
  await service.vault.refresh()
  // Two Pi runtimes for the same storage share one vault connection. The
  // fixture's runtime was created with polling off; this second one turns the
  // shared background poll on at a short interval for this test.
  const polled = new PiNativeRuntime(f.path, {
    connect: f.connect,
    vaultPoll: { intervalMs: 20 },
  })
  deferCleanup(() => polled.close())
  const requestRefresh = spyOn(service.vault, 'refresh')
  deferCleanup(() => requestRefresh.mockRestore())
  const mainState = async () =>
    (await polled.requestView()).accounts.find(
      (account) => account.credentialId === 'oauth:anthropic',
    )?.state
  // The 'work' account is active, so a request can be served without asking
  // the vault for changes. The main account stays needs_reauth here until the
  // background poll notices the re-login below.
  expect(await mainState()).toBe('needs_reauth')
  f.rows[0] = { ...f.rows[0]!, state: 'active' }
  let state = await mainState()
  while (state !== 'active') {
    await new Promise((resolve) => setTimeout(resolve, 10))
    state = await mainState()
  }
  expect(state).toBe('active')
  expect(requestRefresh).toHaveBeenCalledTimes(0)
})

for (const outcome of ['watching', 'fallback'] as const)
  test(`Pi lists the vault every five minutes only while a vault watch is open (${outcome})`, async () => {
    const f = await fixture('main-first')
    const vault = watchableVaultClient(f.client, lifetimes.gate)
    const timers = recordedTimers(deferCleanup)
    // The fixture's runtime does not poll; this one shares its vault runtime
    // and turns the background poll on at Pi's default pace.
    const polled = new PiNativeRuntime(f.path, {
      connect: f.connect,
      vaultPoll: {
        intervalMs: PI_VAULT_POLL_INTERVAL_MS,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
      },
    })
    deferCleanup(() => polled.close())
    await polled.service()
    const watch = await vault.nth(0)
    const poll = timers.created.find((timer) => timer.ms === 2_000)
    expect(poll && timers.live(poll.handle)).toBe(true)
    const before = timers.created.length
    if (outcome === 'watching') watch.notify('pi-watch')
    else watch.finish({ kind: 'unsupported' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const added = timers.created.slice(before).map((timer) => timer.ms)
    if (outcome === 'watching') {
      expect(added).toEqual([5 * 60_000])
      expect(poll && timers.live(poll.handle)).toBe(false)
    } else {
      expect(added).toEqual([])
      expect(poll && timers.live(poll.handle)).toBe(true)
    }
  })

test('Pi same-key replacement drains its predecessor without closing the shared consumer', async () => {
  const f = await fixture()
  const closes = spyOn(f.client, 'close')
  deferCleanup(() => closes.mockRestore())
  const get = f.client.getScoped.bind(f.client)
  const stableVersion = spyOn(f.client, 'getScoped').mockImplementation(
    async (input) => ({
      ...(await get(input)),
      recordVersion: 1,
    }),
  )
  deferCleanup(() => stableVersion.mockRestore())
  const runtime = await f.native.service()
  const first = await f.native.authorize('main')
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  let wrote = false
  f.native.usagePublications.publish(async () => {
    entered.open()
    await release.wait
    if (first.source !== 'vault') throw new Error('Expected a vault receipt')
    wrote = await runtime.vault.publish(first.receipt, { lastUsed: Date.now() })
  })
  await entered.wait
  let disposed = false
  const disposing = closePiNativeRuntime(f.path).then(() => {
    disposed = true
  })
  lifetimes.trackDetached(disposing)
  const successor = new PiNativeRuntime(f.path, { connect: f.connect })
  deferCleanup(() => successor.close())
  expect(disposed).toBe(false)
  const second = await successor.authorize('main')
  expect(second.source).toBe('vault')
  if (first.source !== 'vault' || second.source !== 'vault')
    throw new Error('Expected vault attempts')
  expect(second.receipt).not.toBe(first.receipt)
  expect(second.receipt.accessToken).not.toBe(first.receipt.accessToken)
  release.open()
  await disposing
  expect(wrote).toBe(true)
  expect(closes).toHaveBeenCalledTimes(0)
  await successor.authorize('main')
  await successor.close()
  expect(closes).toHaveBeenCalledTimes(1)
})

test('Pi runtime cache isolates connection and enrollment paths for the same storage file', async () => {
  const f = await fixture()
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
    dirname(f.path),
    'connection-a.json',
  )
  const a = getPiNativeRuntime(f.path, { connect: f.connect })
  expect(getPiNativeRuntime(f.path)).toBe(a)
  const differentConnector = getPiNativeRuntime(f.path, {
    connect: async () => f.client,
  })
  expect(differentConnector).not.toBe(a)
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
    dirname(f.path),
    'connection-b.json',
  )
  const b = getPiNativeRuntime(f.path, { connect: f.connect })
  expect(b).not.toBe(a)
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    dirname(f.path),
    'other-enrollment.json',
  )
  const c = getPiNativeRuntime(f.path, { connect: f.connect })
  expect(c).not.toBe(b)
})

test('Pi sends using scoped credentials without host auth, and never bootstraps with a cached token', async () => {
  const f = await fixture()
  const sent: Array<{
    url: string
    authorization: string | null
    body: string
  }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sent.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: String(init?.body),
      })
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const first = await streamCortexKitAnthropic(model, context, {
    sessionId: 'scoped-first',
  }).result()
  expect(first.errorMessage).toBeUndefined()
  expect(first.stopReason).toBe('stop')
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: 'scoped-second',
        apiKey: 'must-ignore-local-key',
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(sent.map((request) => request.authorization)).toEqual([
    'Bearer vault-test-access-1',
    'Bearer vault-test-access-2',
  ])
  expect(
    sent.every((request) => request.url.endsWith('/v1/messages?beta=true')),
  ).toBe(true)
  expect(sent[0]?.body).toContain(fixtureAccountIdentity('main'))
  expect(f.gets).toHaveLength(2)
  expect(JSON.stringify(await readNativePiFixture(f.path))).not.toContain(
    'vault-test-access',
  )
})

test('a revoked scoped credential never falls back to local auth or a paid API route', async () => {
  const f = await fixture()
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  f.client.getScoped = async () => {
    throw new ClaustrumCredentialError(
      'enrollment_revoked',
      'auth_required',
      'reauth',
    )
  }
  const result = await streamCortexKitAnthropic(model, context, {
    apiKey: 'must-not-use-local-key',
  }).result()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('Native custody refused: unavailable')
  expect(sends).toBe(1)
})

test('Pi fallback routing never selects an enabled vault account needing sign-in', async () => {
  const f = await fixture('fallback-first')
  f.rows.push({
    ...row(
      'oauth:anthropic:needs-sign-in',
      fixtureAccountIdentity('needs-sign-in'),
    ),
    state: 'needs_reauth',
  })
  await (await f.native.service()).vault.refresh()
  const unavailable = (await f.native.view()).accounts.find(
    (account) => account.credentialId === 'oauth:anthropic:needs-sign-in',
  )
  expect(unavailable).toMatchObject({ enabled: true, state: 'needs_reauth' })
  globalThis.fetch = Object.assign(async () => success(), {
    preconnect: originalFetch.preconnect,
  })
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  expect(f.gets.map((get) => get.credentialId)).toEqual(['oauth:anthropic'])
})

test('fallback-first adopts a newly published account on the next turn and honors a live disable', async () => {
  const f = await fixture('fallback-first')
  globalThis.fetch = Object.assign(async () => success(), {
    preconnect: originalFetch.preconnect,
  })
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  f.rows.push(row('oauth:anthropic:new', fixtureAccountIdentity('new')))
  await (await f.native.service()).vault.refresh()
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  const native = getPiNativeRuntime(f.path)
  const added = (await native.view()).accounts.find(
    (account) => account.credentialId === 'oauth:anthropic:new',
  )
  if (!added) throw new Error('new account was not persisted')
  await (await native.service()).setEnabled(added.id, false)
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  expect(f.gets.map((get) => get.credentialId)).toEqual([
    'oauth:anthropic',
    'oauth:anthropic:new',
    'oauth:anthropic',
  ])
  await expect(readFile(f.path, 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

for (const mode of [
  'main-first',
  'fallback-first',
  'sticky-balanced',
] as const) {
  test(`Pi vault reauth recovers on the next request in ${mode}`, async () => {
    const f = await fixture(mode)
    f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
    f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
    await (await f.native.service()).vault.refresh()
    await (await f.native.service()).updateSettings((settings) => ({
      ...settings,
      quota: { enabled: false },
    }))
    const served: string[] = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).includes('/api/oauth/usage'))
          return Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 0 },
          })
        const index =
          Number(
            /vault-test-access-(\d+)$/.exec(
              new Headers(init?.headers).get('authorization') ?? '',
            )?.[1],
          ) - 1
        served.push(f.gets[index]?.credentialId ?? 'missing receipt')
        return success()
      },
      { preconnect: originalFetch.preconnect },
    )
    const options = { sessionId: `reauth-${mode}` }
    expect(
      (await streamCortexKitAnthropic(model, context, options).result())
        .stopReason,
    ).toBe('stop')
    expect(served).toEqual(['oauth:anthropic:work'])
    f.rows[0] = { ...f.rows[0]!, state: 'active' }
    f.rows[1] = { ...f.rows[1]!, state: 'needs_reauth' }
    await (await f.native.service()).vault.refresh()
    expect(
      (await streamCortexKitAnthropic(model, context, options).result())
        .stopReason,
    ).toBe('stop')
    expect(served.at(-1)).toBe('oauth:anthropic')
    f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
    await (await f.native.service()).vault.refresh()
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await streamCortexKitAnthropic(
        model,
        context,
        options,
      ).result()
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toBe(
        'No vault account can serve this request. Open /claude to see which account needs signing in again.',
      )
    }
    expect(served).toHaveLength(2)
    f.rows[0] = { ...f.rows[0]!, state: 'active' }
    expect(
      (await streamCortexKitAnthropic(model, context, options).result())
        .stopReason,
    ).toBe('stop')
    expect(served.at(-1)).toBe('oauth:anthropic')
  })
}

/**
 * A sticky-balanced Pi session over two vault accounts whose model endpoint is
 * an owned loopback server. The first model send of the test is rejected with
 * 401; every later send succeeds. `served` lists the vault credential each
 * model send used, in order. `afterSend` sees each model response before Pi
 * does.
 */
async function stickyRejectedFirstSend(
  afterSend?: (response: Response) => void,
) {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  const service = await f.native.service()
  await service.vault.refresh()
  await service.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
  }))
  const served: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      // Sticky routing needs current quota for both accounts before it sends.
      if (new URL(request.url).pathname === '/api/oauth/usage')
        return Response.json({
          five_hour: { utilization: 0 },
          seven_day: { utilization: 0 },
        })
      const index =
        Number(
          /vault-test-access-(\d+)$/.exec(
            request.headers.get('authorization') ?? '',
          )?.[1],
        ) - 1
      served.push(f.gets[index]?.credentialId ?? 'missing receipt')
      if (served.length === 1)
        return Response.json(
          {
            type: 'error',
            error: { type: 'authentication_error', message: 'Synthetic 401' },
          },
          { status: 401 },
        )
      return success()
    },
  })
  deferCleanup(() => server.stop(true))
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input))
      if (
        !url.pathname.startsWith('/v1/messages') &&
        url.pathname !== '/api/oauth/usage'
      )
        throw new Error(`Unexpected outbound request: ${url.pathname}`)
      const response = await originalFetch(
        `http://127.0.0.1:${server.port}${url.pathname}${url.search}`,
        init,
      )
      if (url.pathname.startsWith('/v1/messages')) afterSend?.(response)
      return response
    },
    { preconnect: originalFetch.preconnect },
  )
  return { f, served }
}

for (const limit of ['quota floor', 'killswitch'] as const) {
  test(`Pi vault quota policy identifies ${limit} without sending a request`, async () => {
    const f = await fixture('sticky-balanced')
    const service = await f.native.service()
    await service.updateSettings((settings) => ({
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
    }))
    const receipt = await service.authorizeVault('main')
    const checkedAt = Date.now()
    expect(
      await service.vault.publish(receipt, {
        quota: {
          accountIdentity: fixtureAccountIdentity('main'),
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
    let networkCalls = 0
    globalThis.fetch = Object.assign(
      async () => {
        networkCalls++
        throw new Error('NETWORK FORBIDDEN')
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(model, context, {
      sessionId: 'pi-vault-quota-policy',
    }).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('429')
    expect(result.errorMessage).toContain(limit)
    expect(result.errorMessage).toContain('Retry in ')
    expect(result.errorMessage).toContain('/claude → Killswitch / Quota')
    expect(result.errorMessage).not.toContain('signing in')
    expect(networkCalls).toBe(0)
  })
}

test('Pi cancel during vault re-authorization after a 401 ends aborted and keeps the sticky account', async () => {
  const { f, served } = await stickyRejectedFirstSend()
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  const get = f.client.getScoped.bind(f.client)
  let held = false
  f.client.getScoped = async (input) => {
    // The first read of the rejected credential after its 401 is the
    // re-authorization. Hold it until the request is cancelled.
    if (!held && served.length === 1 && input.credentialId === served[0]) {
      held = true
      entered.open()
      await release.wait
    }
    return get(input)
  }
  const options = { sessionId: 'pi-cancel-during-reauth' }
  const controller = new AbortController()
  const pending = streamCortexKitAnthropic(model, context, {
    ...options,
    signal: controller.signal,
  }).result()
  await entered.wait
  controller.abort()
  const cancelled = await pending
  release.open()
  await f.native.drainDispatchWork()
  expect(cancelled.stopReason).toBe('aborted')
  expect(cancelled.errorMessage).not.toContain('401')
  const assigned = served[0]
  if (!assigned) throw new Error('No model send reached the provider')
  expect(served).toEqual([assigned])
  // The 401 arrived before the cancel; it is reported once, before
  // re-authorization starts.
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[assigned, 401]])
  const next = await streamCortexKitAnthropic(model, context, options).result()
  expect(next.stopReason).toBe('stop')
  expect(served).toEqual([assigned, assigned])
  expect(f.reports).toHaveLength(1)
})

test('Pi cancel after a 401 arrives and before re-authorization ends aborted and keeps the sticky account', async () => {
  const controller = new AbortController()
  let readsAtRejection: number | undefined
  const { f, served } = await stickyRejectedFirstSend((response) => {
    // Cancel once the rejection has arrived, before Pi acts on it.
    if (response.status !== 401) return
    readsAtRejection = f.gets.length
    controller.abort()
  })
  const options = { sessionId: 'pi-cancel-after-401' }
  const cancelled = await streamCortexKitAnthropic(model, context, {
    ...options,
    signal: controller.signal,
  }).result()
  expect(cancelled.stopReason).toBe('aborted')
  await f.native.drainDispatchWork()
  const assigned = served[0]
  if (!assigned) throw new Error('No model send reached the provider')
  expect(served).toEqual([assigned])
  // Nothing was read from the vault after the cancel: no re-authorization
  // and no authorization of another account.
  expect(f.gets).toHaveLength(readsAtRejection ?? -1)
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[assigned, 401]])
  const next = await streamCortexKitAnthropic(model, context, options).result()
  expect(next.stopReason).toBe('stop')
  expect(served).toEqual([assigned, assigned])
  expect(f.reports).toHaveLength(1)
})

test('Pi shutdown after caller abort drains a pending 401 report', async () => {
  const controller = new AbortController()
  const { f, served } = await stickyRejectedFirstSend((response) => {
    if (response.status === 401) controller.abort()
  })
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  const report = f.client.reportAuthFailureScoped.bind(f.client)
  f.client.reportAuthFailureScoped = async (input) => {
    entered.open()
    await release.wait
    return report(input)
  }
  const cancelled = await streamCortexKitAnthropic(model, context, {
    sessionId: 'pi-shutdown-after-401',
    signal: controller.signal,
  }).result()
  expect(cancelled.stopReason).toBe('aborted')
  let closed = false
  const closing = closePiNativeRuntime(path).then(() => {
    closed = true
  })
  lifetimes.trackDetached(closing)
  try {
    await entered.wait
    expect(closed).toBe(false)
    expect(f.reports).toEqual([])
  } finally {
    release.open()
    await closing
  }
  const assigned = served[0]
  if (!assigned) throw new Error('No model send reached the provider')
  expect(served).toEqual([assigned])
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[assigned, 401]])
  expect(f.reports).toHaveLength(1)
})

test('Pi failed vault re-authorization after a 401 still reports and moves the sticky account', async () => {
  const { f, served } = await stickyRejectedFirstSend()
  const get = f.client.getScoped.bind(f.client)
  let refused = false
  f.client.getScoped = async (input) => {
    if (!refused && served.length === 1 && input.credentialId === served[0]) {
      refused = true
      throw new Error('synthetic vault unavailable')
    }
    return get(input)
  }
  const options = { sessionId: 'pi-failed-reauth' }
  const first = await streamCortexKitAnthropic(model, context, options).result()
  expect(first.stopReason).toBe('stop')
  const [rejected, migrated] = served
  if (!rejected || !migrated)
    throw new Error('The rejected send was not rerouted')
  expect(served).toHaveLength(2)
  expect(migrated).not.toBe(rejected)
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[rejected, 401]])
  expect(
    (await streamCortexKitAnthropic(model, context, options).result())
      .stopReason,
  ).toBe('stop')
  expect(served).toEqual([rejected, migrated, migrated])
})

registerTest.each([500, 401])(
  'relay status %i falls back direct with a fresh version-fenced credential',
  wrapBody(async (relayStatus) => {
    const f = await fixture('main-first', true)
    // Relay and direct use different records; no rotation occurs after the
    // direct send, so a genuine 401 must report its exact served version.
    f.client.getScoped = async (input) => {
      f.gets.push(input)
      const version = Math.min(f.gets.length, 2)
      return {
        credentialId: input.credentialId,
        accountId: fixtureAccountIdentity('main'),
        material: `vault-test-access-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 600_000,
      }
    }
    const credentials: string[] = []
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (String(input).startsWith('https://relay.invalid')) {
          const payload = JSON.parse(String(init?.body))
          credentials.push(payload.upstream.headers.authorization)
          return new Response('relay unavailable', { status: relayStatus })
        }
        if (!String(input).startsWith('https://api.anthropic.com/v1/messages'))
          throw new Error('Unexpected outbound request')
        credentials.push(new Headers(init?.headers).get('authorization') ?? '')
        return new Response('unauthorized', { status: 401 })
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(model, context, {
      sessionId: 'relay-fallback',
    }).result()
    expect(result.stopReason).toBe('error')
    expect(credentials).toEqual([
      'Bearer vault-test-access-1',
      'Bearer vault-test-access-2',
    ])
    expect(f.gets).toHaveLength(3) // the 401 checks again but never resends unchanged v2
    expect(f.reports).toEqual([
      {
        credentialId: 'oauth:anthropic',
        enrollmentToken: '01'.repeat(32),
        providerStatus: 401,
        recordVersion: 2,
        reporterSource: 'direct',
      },
    ])
  }),
)

test('scoped model switches reuse the existing sticky allocator and its Opus reserve preference', async () => {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  await (await f.native.service()).vault.refresh()
  const served: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      const index =
        Number(/vault-test-access-(\d+)$/.exec(authorization)?.[1]) - 1
      const credentialId = f.gets[index]?.credentialId
      if (!credentialId) throw new Error('Request did not use a scoped receipt')
      if (String(input).includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: {
            utilization: 20,
            resets_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          seven_day: {
            utilization: 20,
            resets_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: credentialId === 'oauth:anthropic' ? 100 : 0,
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        })
      }
      if (!String(input).includes('/v1/messages'))
        throw new Error('Unexpected outbound request')
      served.push(credentialId)
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const options = { sessionId: 'scoped-model-switch' }
  expect(
    (await streamCortexKitAnthropic(model, context, options).result())
      .stopReason,
  ).toBe('stop')
  expect(
    (
      await streamCortexKitAnthropic(
        { ...model, id: 'claude-opus-5' },
        context,
        options,
      ).result()
    ).stopReason,
  ).toBe('stop')
  expect(served).toEqual(['oauth:anthropic:work', 'oauth:anthropic'])
})

test('an incomplete scoped quota pool cannot spend a paid fallback or issue a model request', async () => {
  const f = await fixture('sticky-balanced')
  const urls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input))
      return new Response('usage endpoint unavailable', { status: 503 })
    },
    { preconnect: originalFetch.preconnect },
  )
  const result = await streamCortexKitAnthropic(model, context, {
    sessionId: 'scoped-quota-incomplete',
  }).result()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain(
    'waiting for current OAuth quota snapshots',
  )
  expect(urls).toEqual(['https://api.anthropic.com/api/oauth/usage'])
  expect(f.gets).toHaveLength(1)
})

const hostCredentials: Array<{
  name: string
  credential?: Credential
  initiallyInactive?: boolean
}> = [
  { name: 'empty credential store' },
  { name: 'inactive vault at provider registration', initiallyInactive: true },
  {
    name: 'stored local API key',
    credential: { type: 'api_key', key: 'must-not-use-local-api-key' },
  },
  {
    name: 'stored expired OAuth',
    credential: {
      type: 'oauth',
      access: 'must-not-use-local-access',
      refresh: 'must-not-refresh-local-token',
      expires: 0,
    },
  },
]

registerTest.each(hostCredentials)(
  'real Pi model runtime honors custody with $name',
  wrapBody(async ({ credential, initiallyInactive }) => {
    const f = await fixture()
    if (initiallyInactive) {
      f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
      await (await f.native.service()).vault.refresh()
    }
    let writes = 0,
      sends = 0
    const credentials: CredentialStore = {
      read: async (providerId) =>
        providerId === 'anthropic' ? credential : undefined,
      list: async () =>
        credential ? [{ providerId: 'anthropic', type: credential.type }] : [],
      modify: async () => {
        writes++
        throw new Error('Local credentials must not be modified')
      },
      delete: async () => {
        writes++
        throw new Error('Runtime must not delete user credentials')
      },
    }
    const host = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStorePath: join(dirname(f.path), 'model-store'),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    const events = new Map<string, (...args: unknown[]) => unknown>()
    let provider: Provider | undefined
    const commands = new Map<
      string,
      Parameters<ExtensionAPI['registerCommand']>[1]
    >()
    const pi = {
      registerCommand: (
        name: string,
        definition: Parameters<ExtensionAPI['registerCommand']>[1],
      ) => {
        commands.set(name, definition)
      },
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        events.set(name, handler)
      },
      registerProvider: (
        value: Provider | string,
        configuration?: ProviderConfig,
      ) => {
        if (typeof value === 'string') {
          if (!configuration)
            throw new Error('Missing local provider configuration')
          host.registerProvider(value, configuration)
          provider = host.getProvider(value)
        } else {
          provider = value
          host.registerNativeProvider(value)
        }
      },
    } as unknown as ExtensionAPI
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).includes('/v1/messages'))
          throw new Error('Unexpected outbound request')
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer vault-test-access-${f.gets.length}`,
        )
        sends++
        return success()
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      await cortexKitPiAnthropicAuth(pi, {
        connectScoped: async () => ({ ...f.client }),
      })
      await getPiNativeRuntime(f.path).view()
      expect(provider?.auth.oauth).toBeUndefined()
      if (credential?.type === 'oauth') {
        expect(await host.getAuth('anthropic')).toBeUndefined()
        expect(sends).toBe(0)
        expect(f.gets).toHaveLength(0)
      } else {
        expect(await host.getAuth('anthropic')).toEqual({
          auth: {},
          source: 'CortexKit Native',
        })
        const registered = host.getModel('anthropic', model.id)
        if (!registered)
          throw new Error('Native Anthropic model was not registered')
        if (initiallyInactive) {
          const refused = await host.completeSimple(registered, context)
          expect(refused.stopReason).toBe('error')
          expect(refused.errorMessage).toBe(
            'No vault account can serve this request. Open /claude to see which account needs signing in again.',
          )
          expect(sends).toBe(0)
          f.rows[0] = { ...f.rows[0]!, state: 'active' }
        }
        expect(
          (await host.completeSimple(registered, context)).stopReason,
        ).toBe('stop')
        expect(sends).toBe(1)
        const accountCommand = commands.get('claude')
        if (!accountCommand)
          throw new Error('Claude menu command was not registered')
        const ctx = {
          ui: { notify: () => {} },
        } as unknown as ExtensionCommandContext
        await accountCommand.handler('local', ctx)
        expect(host.getProvider('anthropic')?.auth.oauth).toBeUndefined()
        await accountCommand.handler('claustrum', ctx)
        await getPiNativeRuntime(f.path).view()
        expect(host.getProvider('anthropic')?.auth.oauth).toBeUndefined()
        expect(
          (await host.completeSimple(registered, context)).stopReason,
        ).toBe('stop')
        expect(sends).toBe(2)
      }
      expect(writes).toBe(0)
    } finally {
      await events.get('session_shutdown')?.(
        {},
        { sessionManager: { getSessionId: () => undefined } },
      )
    }
  }),
)

registerTest(
  'Pi CacheKeep returns a terminal killswitch refusal without authorizing or sending',
  wrapBody(async () => {
    const f = await fixture()
    const runtime = await getPiNativeRuntime(f.path).service()
    await runtime.updateSettings((settings) => ({
      ...settings,
      killswitch: { enabled: true, main: { five_hour: 5, seven_day: 0 } },
    }))
    let gets = 0
    f.client.getScoped = async () => {
      gets++
      throw new NativeCustodyError('unavailable')
    }
    let sends = 0
    globalThis.fetch = Object.assign(
      async () => {
        sends++
        return Response.json({})
      },
      { preconnect: originalFetch.preconnect },
    )
    expect(
      await __prewarmPiCacheKeepForTest({
        sessionId: 'pi-cachekeep-policy',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText: JSON.stringify({
          model: model.id,
          system: [
            {
              type: 'text',
              text: 'stable',
              cache_control: { type: 'ephemeral' },
            },
          ],
        }),
        oauthAccountId: 'main',
        oauthAccountIdentity: fixtureAccountIdentity('main'),
        accountStoragePath: f.path,
      }),
    ).toEqual({
      ok: false,
      reason: 'account-policy',
      refusal: 'account-policy',
    })
    expect(gets).toBe(0)
    expect(sends).toBe(0)
  }),
)

registerTest.each([200, 401])(
  'Pi retries in-flight scoped 401 once and fences final status %i',
  wrapBody(async (finalStatus) => {
    const f = await fixture()
    let version = 1
    const gets: number[] = []
    f.client.getScoped = async ({ credentialId }) => {
      gets.push(version)
      return {
        credentialId,
        accountId: fixtureAccountIdentity('main'),
        material: `rotated-pi-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 600_000,
      }
    }
    const sent: string[] = []
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).includes('/v1/messages'))
          throw new Error('unexpected upstream request')
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        sent.push(authorization)
        if (authorization === 'Bearer rotated-pi-1') {
          version = 2
          return new Response('rotated credential rejected', { status: 401 })
        }
        return finalStatus === 401
          ? new Response('current credential rejected', { status: 401 })
          : success()
      },
      { preconnect: originalFetch.preconnect },
    )
    const records: LogTestRecord[] = []
    const previousLevel = getLogLevel()
    setLogLevel('debug')
    __setLogTestSink((record) => records.push(record))
    let result: Awaited<
      ReturnType<ReturnType<typeof streamCortexKitAnthropic>['result']>
    >
    try {
      result = await streamCortexKitAnthropic(model, context, {
        sessionId: 'pi-rotation',
      }).result()
    } finally {
      __setLogTestSink(null)
      setLogLevel(previousLevel)
    }
    expect(result.stopReason).toBe(finalStatus === 401 ? 'error' : 'stop')
    expect(sent).toEqual(['Bearer rotated-pi-1', 'Bearer rotated-pi-2'])
    expect(gets).toEqual([1, 2])
    expect(f.reports.map((report) => report.recordVersion)).toEqual(
      finalStatus === 401 ? [1, 2] : [1],
    )
    // Retry diagnostics must not include access or refresh tokens, or the
    // provider's raw error text.
    expect(
      records
        .filter((record) => record.message === 'Pi 401 retry decision')
        .map((record) => record.payload),
    ).toContainEqual(
      expect.objectContaining({
        source: 'vault',
        servedVersion: 1,
        currentVersion: 2,
        retry: true,
        reason: 'rotated',
      }),
    )
  }),
)

registerTest.each([200, 401])(
  'Pi HTTP relay retries rotated scoped credential once; final status %i',
  wrapBody(async (finalStatus) => {
    const f = await fixture('main-first', true)
    let version = 1
    const reports: number[] = [],
      relayTokens: string[] = []
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: fixtureAccountIdentity('main'),
      material: `relay-pi-${version}`,
      recordVersion: version,
      expiresAtMs: Date.now() + 600_000,
    })
    f.client.reportAuthFailureScoped = async ({ recordVersion }) => {
      reports.push(recordVersion)
    }
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).startsWith('https://relay.invalid'))
          throw new Error('unexpected direct request')
        const payload = JSON.parse(String(init?.body)) as {
          upstream: { headers: Record<string, string> }
        }
        const authorization = payload.upstream.headers.authorization
        if (!authorization) throw new Error('relay omitted scoped bearer')
        relayTokens.push(authorization)
        if (authorization === 'Bearer relay-pi-1') {
          version = 2
          return new Response('old record rejected', {
            status: 401,
            headers: { 'request-id': 'req_pi_old' },
          })
        }
        return new Response(
          finalStatus === 200 ? await success().text() : 'new record rejected',
          {
            status: finalStatus,
            headers: { 'request-id': 'req_pi_new' },
          },
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(model, context, {
      sessionId: 'pi-relay-rotation',
    }).result()
    expect(result.stopReason).toBe(finalStatus === 401 ? 'error' : 'stop')
    expect(relayTokens).toEqual(['Bearer relay-pi-1', 'Bearer relay-pi-2'])
    expect(reports).toEqual(finalStatus === 401 ? [1, 2] : [1])
  }),
)

registerTest.each([200, 401])(
  'Pi CacheKeep retries a rotated scoped receipt once, final status %i',
  wrapBody(async (finalStatus) => {
    const f = await fixture()
    let version = 1
    const sent: string[] = []
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: fixtureAccountIdentity('main'),
      material: `pi-cachekeep-v${version}`,
      recordVersion: version,
      expiresAtMs: Date.now() + 600_000,
    })
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).includes('/v1/messages'))
          throw new Error('unexpected Pi prewarm destination')
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        sent.push(authorization)
        if (authorization === 'Bearer pi-cachekeep-v1') {
          version = 2
          return new Response('old token', { status: 401 })
        }
        return new Response(
          finalStatus === 401
            ? 'new token rejected'
            : JSON.stringify({ usage: { input_tokens: 1 } }),
          {
            status: finalStatus,
          },
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await __prewarmPiCacheKeepForTest({
      sessionId: `pi-cachekeep-${finalStatus}`,
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText: JSON.stringify({
        model: model.id,
        max_tokens: 128,
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'warm' }],
      }),
      oauthAccountId: 'main',
      oauthAccountIdentity: fixtureAccountIdentity('main'),
      accountStoragePath: f.path,
    })
    expect(result.ok).toBe(finalStatus === 200)
    expect(sent).toEqual(['Bearer pi-cachekeep-v1', 'Bearer pi-cachekeep-v2'])
    expect(f.reports.map((report) => report.recordVersion)).toEqual(
      finalStatus === 401 ? [1, 2] : [1],
    )
  }),
)

// Sends one model request through Pi's real stream path, then replays its
// captured URL, headers and body through Pi's CacheKeep prewarm, recording
// both outbound requests. CacheKeep rebuilds the prewarm headers itself, so a
// beta the model request needed but the prewarm forgot shows up as a
// difference between the two captures.
async function sendAndPrewarm(
  f: Awaited<ReturnType<typeof fixture>>,
  modelId: string,
  effortTransitions?: Array<{
    afterAssistantMessages: number
    effort: 'low' | 'high'
  }>,
) {
  const sent: Array<{ url: string; headers: Headers; body: string }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (!String(input).includes('/v1/messages'))
        throw new Error('unexpected Pi request destination')
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      })
      return sent.length === 1
        ? success()
        : new Response(JSON.stringify({ usage: { input_tokens: 1 } }))
    },
    { preconnect: originalFetch.preconnect },
  )
  const conversation: Context = {
    systemPrompt: 'Test',
    tools: [],
    messages: [
      { role: 'user', content: 'first', timestamp: 0 },
      {
        role: 'assistant',
        provider: 'anthropic',
        api: 'anthropic-messages',
        model: modelId,
        content: [{ type: 'text', text: 'first answer' }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 0,
      },
      { role: 'user', content: 'second', timestamp: 0 },
    ],
  }
  const result = await streamCortexKitAnthropic(
    { ...model, id: modelId },
    conversation,
    { sessionId: `pi-prewarm-betas-${modelId}`, reasoning: 'high' },
    effortTransitions,
  ).result()
  expect(result.stopReason).toBe('stop')
  const [main] = sent
  if (!main) throw new Error('Pi sent no model request')
  const prewarm = await __prewarmPiCacheKeepForTest({
    sessionId: `pi-prewarm-betas-${modelId}`,
    url: main.url,
    headers: main.headers,
    bodyText: main.body,
    oauthAccountId: 'main',
    oauthAccountIdentity: fixtureAccountIdentity('main'),
    accountStoragePath: f.path,
  })
  expect(prewarm.ok).toBe(true)
  expect(sent).toHaveLength(2)
  const warm = sent[1]!
  const betas = (headers: Headers) =>
    (headers.get('anthropic-beta') ?? '').split(',')
  return {
    main: { ...main, betas: betas(main.headers), json: JSON.parse(main.body) },
    warm: { ...warm, betas: betas(warm.headers), json: JSON.parse(warm.body) },
  }
}

const hasEffortMarker = (body: { messages: Array<{ role?: string }> }) =>
  body.messages.some((message) => message.role === 'system')

// The prewarm adds the extended cache TTL beta to what the model request
// sent. These bodies have the full agent shape, whose Claude Code beta list
// already includes that beta, so the prewarm must send the model request's
// beta header byte for byte, and the same value for every other header.
// Authorization and the per-request id are minted for each send and are
// excluded.
function expectPrewarmHeadersMatchModelRequest(
  main: { headers: Headers; betas: string[] },
  warm: { headers: Headers; betas: string[] },
) {
  expect(main.betas).toContain(CACHE_KEEP_EXTENDED_TTL_BETA)
  expect(warm.betas).toEqual(main.betas)
  const others = (headers: Headers) =>
    [...headers.entries()].filter(
      ([name]) =>
        name !== 'anthropic-beta' &&
        name !== 'authorization' &&
        name !== 'x-client-request-id',
    )
  expect(others(warm.headers)).toEqual(others(main.headers))
}

test('Pi CacheKeep prewarm of a Fable 5.1 body with effort markers sends the per-turn control beta', async () => {
  const f = await fixture()
  const { main, warm } = await sendAndPrewarm(f, 'claude-fable-5-1', [
    { afterAssistantMessages: 0, effort: 'low' },
    { afterAssistantMessages: 1, effort: 'high' },
  ])
  expect(hasEffortMarker(main.json)).toBe(true)
  expect(hasEffortMarker(warm.json)).toBe(true)
  expect(main.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(warm.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(main.betas).not.toContain('mid-conversation-output-config-2026-07-01')
  expect(warm.betas).not.toContain('mid-conversation-output-config-2026-07-01')
  expect(warm.betas).not.toContain('mid-conversation-system-2026-04-07')
  expectPrewarmHeadersMatchModelRequest(main, warm)
})

test('Pi CacheKeep prewarm of a Fable 5.1 body without effort markers sends the model request betas', async () => {
  const f = await fixture()
  const { main, warm } = await sendAndPrewarm(f, 'claude-fable-5-1')
  expect(hasEffortMarker(main.json)).toBe(false)
  expect(hasEffortMarker(warm.json)).toBe(false)
  // Every OAuth Fable 5.1 model request carries this beta, markers or not.
  expect(main.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(warm.betas).toContain(PER_TURN_CONTROL_BETA)
  expectPrewarmHeadersMatchModelRequest(main, warm)
})

test('Pi CacheKeep prewarm of an Opus 5.5 body with effort markers keeps the per-turn control beta', async () => {
  const f = await fixture()
  const { main, warm } = await sendAndPrewarm(f, 'claude-opus-5-5', [
    { afterAssistantMessages: 0, effort: 'low' },
    { afterAssistantMessages: 1, effort: 'high' },
  ])
  expect(hasEffortMarker(main.json)).toBe(true)
  expect(hasEffortMarker(warm.json)).toBe(true)
  expect(warm.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(warm.betas).not.toContain('mid-conversation-output-config-2026-07-01')
  expectPrewarmHeadersMatchModelRequest(main, warm)
})

registerTest.each([200, 401])(
  'Pi WebSocket relay retries a strict-newer native receipt once and reports every rejected version; final status %i',
  wrapBody(async (finalStatus) =>
    trackPiTestBody(
      (async () => {
        const f = await fixture()
        let version = 1
        const sent: string[] = []
        f.client.getScoped = async ({ credentialId }) => ({
          credentialId,
          accountId: fixtureAccountIdentity('main'),
          material: `pi-ws-v${version}`,
          recordVersion: version,
          expiresAtMs: Date.now() + 600_000,
        })
        const sse = await success().text()
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: (request, server) =>
            server.upgrade(request)
              ? undefined
              : new Response('unexpected HTTP', { status: 500 }),
          websocket: {
            open: (socket) => {
              socket.send(
                JSON.stringify({ type: 'ready', protocol: 2, state: null }),
              )
            },
            message: (socket, data) => {
              const payload = JSON.parse(String(data)) as {
                id: string
                upstream: { headers: Record<string, string> }
              }
              const token = payload.upstream.headers.authorization ?? ''
              sent.push(token)
              const status = token === 'Bearer pi-ws-v1' ? 401 : finalStatus
              version = 2
              socket.send(
                JSON.stringify({
                  type: 'response_start',
                  id: payload.id,
                  status,
                  headers: { 'content-type': 'text/event-stream' },
                }),
              )
              if (status === 200)
                socket.send(
                  JSON.stringify({
                    type: 'chunk',
                    id: payload.id,
                    base64: Buffer.from(sse).toString('base64'),
                  }),
                )
              socket.send(JSON.stringify({ type: 'done', id: payload.id }))
            },
          },
        })
        const abort = new AbortController()
        const deadline = setTimeout(() => abort.abort(), 4_000)
        try {
          await (await getPiNativeRuntime(f.path).service()).updateRelay({
            enabled: true,
            url: server.url.href,
            token: 'synthetic-ws-relay-secret',
            transport: 'websocket',
            fallbackToDirect: false,
          })
          const result = await streamCortexKitAnthropic(model, context, {
            sessionId: `pi-ws-${finalStatus}`,
            signal: abort.signal,
          }).result()
          expect(result.stopReason).toBe(finalStatus === 200 ? 'stop' : 'error')
          expect(sent).toEqual(['Bearer pi-ws-v1', 'Bearer pi-ws-v2'])
          expect(
            f.reports.map((report) => [
              report.recordVersion,
              report.reporterSource,
            ]),
          ).toEqual(
            finalStatus === 200
              ? [[1, 'relay_status_field']]
              : [
                  [1, 'relay_status_field'],
                  [2, 'relay_status_field'],
                ],
          )
        } finally {
          clearTimeout(deadline)
          abort.abort()
          server.stop(true)
        }
      })(),
    ),
  ),
)

test('Pi WebSocket reconnect authorizes the replacement physical attempt without reporting a transport failure', () =>
  trackPiTestBody(
    (async () => {
      const f = await fixture()
      const sent: string[] = []
      const sse = await success().text()
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request, server) =>
          server.upgrade(request)
            ? undefined
            : new Response('unexpected HTTP', { status: 500 }),
        websocket: {
          open: (socket) => {
            socket.send(
              JSON.stringify({ type: 'ready', protocol: 2, state: null }),
            )
          },
          message: (socket, data) => {
            const payload = JSON.parse(String(data)) as {
              id: string
              upstream: { headers: Record<string, string> }
            }
            sent.push(payload.upstream.headers.authorization ?? '')
            if (sent.length === 1) {
              socket.close(1011, 'interrupted before upstream')
              return
            }
            socket.send(
              JSON.stringify({
                type: 'response_start',
                id: payload.id,
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              }),
            )
            socket.send(
              JSON.stringify({
                type: 'chunk',
                id: payload.id,
                base64: Buffer.from(sse).toString('base64'),
              }),
            )
            socket.send(JSON.stringify({ type: 'done', id: payload.id }))
          },
        },
      })
      const abort = new AbortController()
      const deadline = setTimeout(() => abort.abort(), 4_000)
      try {
        await (await getPiNativeRuntime(f.path).service()).updateRelay({
          enabled: true,
          url: server.url.href,
          token: 'synthetic-ws-reconnect-secret',
          transport: 'websocket',
          fallbackToDirect: false,
        })
        expect(
          (
            await streamCortexKitAnthropic(model, context, {
              sessionId: 'pi-ws-reconnect',
              signal: abort.signal,
            }).result()
          ).stopReason,
        ).toBe('stop')
        expect(sent).toEqual([
          'Bearer vault-test-access-1',
          'Bearer vault-test-access-2',
        ])
        expect(f.gets).toHaveLength(2)
        expect(f.reports).toEqual([])
      } finally {
        clearTimeout(deadline)
        abort.abort()
        server.stop(true)
      }
    })(),
  ))

test('Pi refuses an unchanged native vault version after 401 without local or paid API rescue', async () => {
  const f = await fixture()
  f.client.getScoped = async ({ credentialId }) => ({
    credentialId,
    accountId: fixtureAccountIdentity('main'),
    material: 'synthetic-unchanged-vault-access',
    recordVersion: 1,
    expiresAtMs: Date.now() + 600_000,
  })
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return new Response('same version rejected', { status: 401 })
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        apiKey: 'synthetic-host-rescue',
      }).result()
    ).stopReason,
  ).toBe('error')
  expect(sends).toBe(1)
  expect(f.reports.map((report) => report.recordVersion)).toEqual([1])
})

registerTest.each([
  'https://unapproved.invalid/v1',
  'http://api.anthropic.com',
  'https://user:password@api.anthropic.com/v1',
  'https://api.anthropic.com:8443/v1',
  'blob:https://api.anthropic.com/opaque',
  'not a URL',
])(
  'Pi rejects native OAuth recipient %s before authorization or dispatch',
  wrapBody(async (baseUrl) => {
    const f = await fixture()
    let sends = 0
    globalThis.fetch = Object.assign(
      async () => {
        sends++
        return success()
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(
      { ...model, baseUrl },
      context,
    ).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('official Anthropic HTTPS origin')
    expect(f.gets).toEqual([])
    expect(sends).toBe(0)
  }),
)

test('Pi accepts the official versioned OAuth endpoint with redirects disabled', async () => {
  const f = await fixture()
  const requests: Array<{
    url: string
    redirect: RequestInit['redirect']
  }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requests.push({ url: String(input), redirect: init?.redirect })
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (
      await streamCortexKitAnthropic(
        { ...model, baseUrl: 'https://api.anthropic.com/v1' },
        context,
      ).result()
    ).stopReason,
  ).toBe('stop')
  expect(requests).toEqual([
    {
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      redirect: 'error',
    },
  ])
  expect(f.gets).toHaveLength(1)
})

test('Pi refuses a foreign CacheKeep target before authorizing a native receipt', async () => {
  const f = await fixture()
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const result = await __prewarmPiCacheKeepForTest({
    sessionId: 'pi-foreign-prewarm',
    url: 'https://unapproved.invalid/v1/messages',
    headers: new Headers(),
    bodyText: JSON.stringify({ model: model.id, max_tokens: 0, messages: [] }),
    oauthAccountId: 'main',
    oauthAccountIdentity: fixtureAccountIdentity('main'),
    accountStoragePath: f.path,
  })
  expect(result.ok).toBe(false)
  expect(f.gets).toEqual([])
  expect(sends).toBe(0)
})

registerTest.each([
  { name: 'Fable', id: 'claude-fable-5-1', allowed: false },
  { name: 'Sonnet', id: 'claude-sonnet-5-5', allowed: true },
])(
  'Pi final native vault admission rechecks the pending request model: $name',
  wrapBody((requested) =>
    trackPiTestBody(
      (async () => {
        const f = await fixture()
        const runtime = await getPiNativeRuntime(f.path).service()
        const receipt = await runtime.authorizeVault('main')
        const checkedAt = Date.now()
        const quota = (remaining: number, at: number) => ({
          accountIdentity: fixtureAccountIdentity('main'),
          checkedAt: at,
          source: 'poll' as const,
          five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: at },
          seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: at },
          scoped: [
            {
              id: 'fable-weekly',
              title: 'Fable weekly',
              modelName: 'Fable',
              usedPercent: 100 - remaining,
              remainingPercent: remaining,
              checkedAt: at,
            },
          ],
        })
        expect(
          await runtime.vault.publish(receipt, {
            quota: quota(100, checkedAt),
          }),
        ).toBe(true)
        await runtime.updateSettings((settings) => ({
          ...settings,
          killswitch: {
            enabled: true,
            main: { five_hour: 5, seven_day: 10, scoped: 0 },
          },
        }))
        let entered: () => void = () => {}
        let release: () => void = () => {}
        const pending = new Promise<void>((resolve) => {
          entered = resolve
        })
        const resume = new Promise<void>((resolve) => {
          release = resolve
        })
        const get = f.client.getScoped
        f.client.getScoped = async (input) => {
          entered()
          await resume
          return get(input)
        }
        const sent: string[] = []
        globalThis.fetch = Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            sent.push(String(input))
            if (!String(input).includes('/v1/messages'))
              throw new Error(
                'Unexpected quota dispatch in final admission control',
              )
            return success()
          },
          { preconnect: originalFetch.preconnect },
        )
        const response = streamCortexKitAnthropic(
          { ...model, id: requested.id, name: requested.name },
          context,
        ).result()
        try {
          await pending
          expect(
            await runtime.vault.publish(receipt, {
              quota: quota(0, checkedAt + 1),
            }),
          ).toBe(true)
        } finally {
          release()
        }
        const result = await response
        expect(result.stopReason).toBe(requested.allowed ? 'stop' : 'error')
        expect(sent).toEqual(
          requested.allowed
            ? ['https://api.anthropic.com/v1/messages?beta=true']
            : [],
        )
        expect(f.reports).toEqual([])
      })(),
    ),
  ),
)

test('Pi vault default UUID replacement re-places the old session without inheriting quota or changing an unrelated fallback pin', async () => {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  await (await f.native.service()).vault.refresh()
  const served: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      const index =
        Number(/vault-test-access-(\d+)$/.exec(authorization)?.[1]) - 1
      const credentialId = f.gets[index]?.credentialId
      if (!credentialId) throw new Error('Request did not use a scoped receipt')
      if (String(input).includes('/api/oauth/usage'))
        return Response.json({
          five_hour: {
            utilization: 20,
            resets_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          seven_day: {
            utilization: 20,
            resets_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: credentialId === 'oauth:anthropic' ? 100 : 0,
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        })
      if (!String(input).includes('/v1/messages'))
        throw new Error('Unexpected outbound request')
      served.push(credentialId)
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const mainSession = 'vault-default-session'
  const fallbackSession = 'vault-fallback-session'
  const opus = { ...model, id: 'claude-opus-5' }
  expect(
    (
      await streamCortexKitAnthropic(opus, context, {
        sessionId: mainSession,
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: fallbackSession,
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(served).toEqual(['oauth:anthropic', 'oauth:anthropic:work'])
  const routingPath = await f.native.routingPath()
  const fallbackKey = createHash('sha256').update(fallbackSession).digest('hex')
  const mainKey = createHash('sha256').update(mainSession).digest('hex')
  // A request chooses its session pin without waiting for that pin's write to
  // the routing file: the sticky router queues the write and finishes it
  // later under the routing lock. Wait for those queued writes before reading
  // the file.
  await f.native.drainRoutingPublications()
  const beforeText = await readFile(routingPath, 'utf8')
  const fallbackPinBytes = (text: string) => {
    const match = text.match(new RegExp(`"${fallbackKey}":\\s*(\\{[^}]*\\})`))
    if (!match?.[1]) throw new Error('Expected fallback pin is missing')
    return match[1]
  }
  const beforePin = fallbackPinBytes(beforeText)
  expect(JSON.parse(beforeText).assignments[mainKey].accountIdentity).toBe(
    fixtureAccountIdentity('main'),
  )
  const nextUuid = fixtureAccountIdentity('replacement-main')
  f.rows[0] = row('oauth:anthropic', nextUuid)
  await (await f.native.service()).vault.refresh()
  const replacement = (await f.native.view()).accounts.find(
    (account) => account.id === 'main',
  )
  expect(replacement?.accountIdentity).toBe(nextUuid)
  expect(replacement?.quota).toBeUndefined()
  expect(
    (
      await streamCortexKitAnthropic(opus, context, {
        sessionId: mainSession,
      }).result()
    ).stopReason,
  ).toBe('stop')
  await f.native.drainRoutingPublications()
  const afterText = await readFile(routingPath, 'utf8')
  expect(JSON.parse(afterText).assignments[mainKey].accountIdentity).toBe(
    nextUuid,
  )
  expect(fallbackPinBytes(afterText)).toBe(beforePin)
  expect(await Promise.all(f.localFiles.map((file) => readFile(file)))).toEqual(
    f.beforeLocal,
  )
})

test('first Pi request after a 1.x vault upgrade uses legacy fallback-first before any main send', async () => {
  const f = await fixture()
  const workUuid = fixtureAccountIdentity('work')
  f.rows.push(row('oauth:work', workUuid))
  await (await f.native.service()).vault.refresh()
  const paths = await resolveNativePoolPaths(
    f.path,
    join(dirname(f.path), 'anthropic-auth-state.json'),
  )
  const vault = nativeVaultPaths(paths)
  const legacy = JSON.stringify({
    version: 1,
    mainAccountId: fixtureAccountIdentity('main'),
    claustrum: {
      mode: 'claustrum',
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: fixtureAccountIdentity('main'),
        state: 'active',
      },
    },
    routing: { mode: 'fallback-first' },
    quota: { enabled: false },
    prime: { enabled: false },
    cacheKeep: { enabled: false },
    accounts: [
      {
        id: 'old-work',
        label: 'Work',
        type: 'oauth',
        enabled: true,
        addedAt: Date.now(),
        claustrumScopedCredentialId: 'oauth:work',
        anthropicAccountUuid: workUuid,
      },
    ],
  })
  await writeFile(f.path, legacy, { mode: 0o600 })
  closePiNativeRuntime(f.path)
  await rm(vault.config, { force: true })
  await rm(vault.routing, { force: true })
  getPiNativeRuntime(f.path, { connect: async () => f.client })
  expect(f.gets).toHaveLength(0)
  const sent: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(input).includes('/v1/messages'))
        sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const first = await streamCortexKitAnthropic(model, context, {
    sessionId: 'legacy-vault-first-request',
  }).result()
  expect(first.errorMessage).toBeUndefined()
  expect(first.stopReason).toBe('stop')
  expect(sent).toEqual(['Bearer vault-test-access-1'])
  expect(f.gets.map((get) => get.credentialId)).toEqual(['oauth:work'])
  expect(JSON.parse(await readFile(vault.config, 'utf8')).routing).toEqual({
    mode: 'fallback-first',
  })
  expect(await readFile(f.path, 'utf8')).toBe(legacy)
})

test('Pi serves through a vault outage without local token rescue', async () => {
  const f = await fixture()
  const sent: string[] = []
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: 'outage',
      }).result()
    ).stopReason,
  ).toBe('stop')
  f.client.getScoped = async () => {
    throw Object.assign(new Error('outage'), { code: 'ECONNREFUSED' })
  }
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: 'outage',
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(sent).toEqual([
    'Bearer vault-test-access-1',
    'Bearer vault-test-access-1',
  ])
  expect(f.reports).toHaveLength(0)
  expect(await Promise.all(f.localFiles.map((file) => readFile(file)))).toEqual(
    f.beforeLocal,
  )
})
