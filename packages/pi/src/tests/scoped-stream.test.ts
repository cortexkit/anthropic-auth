import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __setLogTestSink,
  type ClaustrumScopedClient,
  getLogLevel,
  type LogTestRecord,
  loadAccounts,
  saveAccounts,
  setAccountEnabledPersistent,
  setClaustrumModePersistent,
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
import cortexKitPiAnthropicAuth from '../index.ts'
import {
  __prewarmPiCacheKeepForTest,
  closePiScopedRuntime,
  getPiScopedRuntime,
  streamCortexKitAnthropic,
} from '../stream.ts'

const originalFetch = globalThis.fetch
let dir: string | undefined
let path: string | undefined
afterEach(async () => {
  if (path) closePiScopedRuntime(path)
  globalThis.fetch = originalFetch
  delete process.env.PI_ANTHROPIC_AUTH_FILE
  delete process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE
  delete process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_AGENT_DIR
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
  path = undefined
})
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
  const tokenPath = join(dir, 'pi-token.json')
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_AGENT_DIR = dir
  process.env.PI_ANTHROPIC_AUTH_FILE = path
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  await saveAccounts(
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
  )
  await setClaustrumModePersistent('claustrum', path)
  const rows = [row('oauth:anthropic', 'main-provider')]
  const gets: Array<Parameters<ClaustrumScopedClient['getScoped']>[0]> = []
  const reports: Array<
    Parameters<ClaustrumScopedClient['reportAuthFailureScoped']>[0]
  > = []
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({ rows, view: `view-${rows.length}` }),
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
  getPiScopedRuntime(path, { connect: async () => client, pollIntervalMs: 0 })
  return { rows, gets, reports, client, path }
}

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
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: 'scoped-first',
      }).result()
    ).stopReason,
  ).toBe('stop')
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
  expect(sent[0]?.body).toContain('main-provider')
  expect(f.gets).toHaveLength(2)
  expect(JSON.stringify(await loadAccounts(f.path))).not.toContain(
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
  expect(result.errorMessage).toContain('enrollment_revoked')
  expect(sends).toBe(1)
})

test('fallback-first discovers a new account on the next turn and honors a live disable', async () => {
  const f = await fixture('fallback-first')
  globalThis.fetch = Object.assign(async () => success(), {
    preconnect: originalFetch.preconnect,
  })
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  f.rows.push(row('oauth:anthropic:new', 'new-provider'))
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  const added = (await loadAccounts(f.path))?.accounts.find(
    (account) => account.type === 'oauth',
  )
  if (!added) throw new Error('new account was not persisted')
  await setAccountEnabledPersistent(added.id, false, f.path)
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  expect(f.gets.map((get) => get.credentialId)).toEqual([
    'oauth:anthropic',
    'oauth:anthropic:new',
    'oauth:anthropic',
  ])
  expect(await readFile(f.path, 'utf8')).not.toContain('vault-test-access')
})

test.each([500, 401])(
  'relay status %i falls back direct with a fresh version-fenced credential',
  async (relayStatus) => {
    const f = await fixture('main-first', true)
    // Relay and direct use different records; no rotation occurs after the
    // direct send, so a genuine 401 must report its exact served version.
    f.client.getScoped = async (input) => {
      f.gets.push(input)
      const version = Math.min(f.gets.length, 2)
      return {
        credentialId: input.credentialId,
        accountId: 'main-provider',
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
  },
)

test('scoped model switches reuse the existing sticky allocator and its Opus reserve preference', async () => {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', 'work-provider'))
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

const hostCredentials: Array<{ name: string; credential?: Credential }> = [
  { name: 'empty credential store' },
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

test.each(hostCredentials)(
  'real Pi model runtime honors custody with $name',
  async ({ credential }) => {
    const f = await fixture()
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
        pollIntervalMs: 0,
      })
      await getPiScopedRuntime(f.path).refresh()
      expect(provider?.auth.oauth).toBeUndefined()
      if (credential?.type === 'oauth') {
        expect(await host.getAuth('anthropic')).toBeUndefined()
        expect(sends).toBe(0)
        expect(f.gets).toHaveLength(0)
      } else {
        expect(await host.getAuth('anthropic')).toEqual({
          auth: {},
          source: 'Claustrum',
        })
        const registered = host.getModel('anthropic', model.id)
        if (!registered)
          throw new Error('Native Anthropic model was not registered')
        expect(
          (await host.completeSimple(registered, context)).stopReason,
        ).toBe('stop')
        expect(sends).toBe(1)
        const accountCommand = commands.get('claude-account')
        if (!accountCommand)
          throw new Error('Account command was not registered')
        const ctx = {
          ui: { notify: () => {} },
        } as unknown as ExtensionCommandContext
        await accountCommand.handler('local', ctx)
        expect(host.getProvider('anthropic')?.auth.oauth).toBeDefined()
        await accountCommand.handler('claustrum', ctx)
        await getPiScopedRuntime(f.path).refresh()
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
  },
)

test.each([200, 401])(
  'Pi retries in-flight scoped 401 once and fences final status %i',
  async (finalStatus) => {
    const f = await fixture()
    let version = 1
    const gets: number[] = []
    f.client.getScoped = async ({ credentialId }) => {
      gets.push(version)
      return {
        credentialId,
        accountId: 'main-provider',
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
      finalStatus === 401 ? [2] : [],
    )
    // Pi's direct-model retry decision reaches the shared diagnostics line.
    expect(
      records
        .filter((record) => record.message === 'scoped 401 re-authorized')
        .map((record) => record.payload),
    ).toContainEqual(
      expect.objectContaining({
        site: 'pi-model',
        servedVersion: 1,
        currentVersion: 2,
        retry: true,
        reason: 'rotated',
      }),
    )
  },
)

test.each([200, 401])(
  'Pi HTTP relay retries rotated scoped credential once; final status %i',
  async (finalStatus) => {
    const f = await fixture('main-first', true)
    let version = 1
    const reports: number[] = [],
      relayTokens: string[] = []
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: 'main-provider',
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
    expect(reports).toEqual(finalStatus === 401 ? [2] : [])
  },
)

test.each([200, 401])(
  'Pi CacheKeep retries a rotated scoped receipt once, final status %i',
  async (finalStatus) => {
    const f = await fixture()
    let version = 1
    const sent: string[] = []
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: 'main-provider',
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
      oauthAccountIdentity: 'main-provider',
      accountStoragePath: f.path,
    })
    expect(result.ok).toBe(finalStatus === 200)
    expect(sent).toEqual(['Bearer pi-cachekeep-v1', 'Bearer pi-cachekeep-v2'])
    expect(f.reports.map((report) => report.recordVersion)).toEqual(
      finalStatus === 401 ? [2] : [],
    )
  },
)
