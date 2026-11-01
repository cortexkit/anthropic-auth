import { describe, expect, test } from 'bun:test'
import {
  custodyTombstoneOAuth,
  fetchOAuthQuotaSnapshot,
  THINKING_BINDING_CONTROLS_BETA,
} from '@cortexkit/anthropic-auth-core'
import type { OpenCode2HookContext } from '@cortexkit/common-auth/opencode2'
import {
  isPlaceholderCredential,
  placeholderSecret,
  registerOpenCode2AuthMethods,
} from '@cortexkit/common-auth/opencode2'
import type { IntegrationOAuthMethodRegistration } from '@opencode/plugin/promise/integration'
import type { Registration } from '@opencode/plugin/promise/registration'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback'
import {
  CLAUDE_POOL_LOGIN_METHOD_ID,
  CLAUDE_VAULT_ACTIVATION_METHOD_ID,
} from '../v2/activation'
import {
  NativeAnthropicRevokedError,
  type NativeAnthropicSource,
  NativeAnthropicTransportRefusal,
} from '../v2/adapter'
import { installNativeAnthropic } from '../v2/install'
import { preparedAnthropicCredential } from '../v2/ownership'
import {
  type ClaudeLoginMethodsInput,
  claudeLoginMethods,
  ENROLLMENT_UNREADABLE,
  LOCAL_LOGIN_REFUSED_IN_VAULT,
  VAULT_ACTIVATION_REFUSED_LOCALLY,
} from '../v2/setup'

type Source = NativeAnthropicSource<never, { readonly version: number }>
interface RelayEnvelope {
  protocol: number
  mode: string
  affinity: string
  upstream: { url: string; method: string; headers: Record<string, string> }
  body: string
  next_hash: string
}
const sessionID =
  'ses_oc2_contract' as SessionHooks['model.request']['sessionID']
const scope = {
  sessionID,
  agent: 'build' as SessionHooks['model.request']['agent'],
  model: {
    providerID:
      'anthropic' as SessionHooks['model.request']['model']['providerID'],
    id: 'claude-sonnet-5' as SessionHooks['model.request']['model']['id'],
  },
  kind: 'primary' as const,
}

/** Register and execute common-auth's public hooks; assert disposal removes them and pending credential callbacks cannot settle into headers. */
class Hooks {
  private readonly callbacks = new Map<
    keyof SessionHooks,
    (input: unknown) => Promise<void> | void
  >()
  readonly disposed: string[] = []
  failAt?: keyof SessionHooks
  readonly hook: OpenCode2HookContext['session']['hook'] = async (
    name,
    callback,
  ): Promise<Registration> => {
    if (name === this.failAt) throw new Error('synthetic registration failure')
    this.callbacks.set(name, (input) =>
      callback(input as SessionHooks[typeof name]),
    )
    return {
      dispose: async () => {
        this.disposed.push(name)
        this.callbacks.delete(name)
      },
    }
  }
  async run<Name extends keyof SessionHooks>(
    name: Name,
    input: SessionHooks[Name],
  ) {
    const callback = this.callbacks.get(name)
    if (!callback) throw new Error(`hook ${name} is not installed`)
    await callback(input)
  }
  get size() {
    return this.callbacks.size
  }
}

function source(overrides: Partial<Source> = {}): Source {
  return {
    chooseAccount: () => 'main',
    authorizeAccount: () => ({
      route: 'oauth',
      accessToken: 'sk-ant-oat01-synthetic',
      provenance: { version: 7 },
    }),
    ...overrides,
  }
}

function request() {
  return new Request('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${placeholderSecret('anthropic')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  })
}

describe('OpenCode 2 published installation contract', () => {
  test('OC2 abort ends a stalled quota preflight without sending a model request', async () => {
    const hooks = new Hooks()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: (response: Response) => void
    const quota = new Promise<Response>((resolve) => {
      release = resolve
    })
    let authorized = 0
    let sends = 0
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          chooseAccount: async () => {
            await fetchOAuthQuotaSnapshot({
              accessToken: 'sk-ant-oat01-synthetic',
              fetchImpl: Object.assign(
                async () => {
                  entered()
                  return quota
                },
                { preconnect: fetch.preconnect },
              ),
            })
            return 'main'
          },
          authorizeAccount: () => {
            authorized++
            return undefined
          },
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    const controller = new AbortController()
    const reason = new Error('synthetic header timeout')
    const draft = {
      ...scope,
      request: new Request(request(), { signal: controller.signal }),
    }
    const pending = hooks
      .run('http.request', draft)
      .then(() => {
        sends++
      })
      .catch((error: unknown) => error)
    try {
      await started
      controller.abort(reason)
      expect(
        await Promise.race([
          pending,
          Bun.sleep(500).then(() => 'still waiting'),
        ]),
      ).toBe(reason)
    } finally {
      release(Response.json({ five_hour: { utilization: 0 } }))
      await pending
      await native.dispose()
    }
    expect(authorized).toBe(0)
    expect(sends).toBe(0)
    expect(draft.request.headers.get('authorization')).toBe(
      `Bearer ${placeholderSecret('anthropic')}`,
    )
  })

  test('generic WebSocket transport leaves stock untouched but refuses an exact pool placeholder before dispatch', async () => {
    const hooks = new Hooks()
    const native = await installNativeAnthropic(
      { session: hooks },
      { source: source() },
      { credential: preparedAnthropicCredential },
    )
    try {
      const stock = {
        ...scope,
        url: 'wss://stock.invalid/model',
        headers: {
          authorization: 'Bearer stock-ws-key',
          'x-stock-field': 'unchanged',
        },
      }
      await hooks.run('experimental.ws.handshake', stock)
      expect(stock.url).toBe('wss://stock.invalid/model')
      expect(stock.headers).toEqual({
        authorization: 'Bearer stock-ws-key',
        'x-stock-field': 'unchanged',
      })
      await expect(
        hooks.run('experimental.ws.handshake', {
          ...scope,
          url: 'wss://stock.invalid/model',
          headers: {
            authorization: `Bearer ${placeholderSecret('anthropic')}`,
          },
        }),
      ).rejects.toBeInstanceOf(NativeAnthropicTransportRefusal)
    } finally {
      await native.dispose()
    }
  })
  test('owned Fable and Haiku body-dependent betas survive generic account header reapplication', async () => {
    const hooks = new Hooks()
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          authorizeAccount: () => ({
            route: 'oauth',
            accessToken: 'sk-ant-oat01-synthetic',
            provenance: { version: 7 },
            headers: { 'anthropic-beta': 'user-extra-beta' },
          }),
          requestOptions: () => ({ serverSideFallbackEnabled: true }),
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      for (const model of ['claude-fable-5-1', 'claude-haiku-5-5']) {
        const draft = {
          ...scope,
          request: new Request('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': placeholderSecret('anthropic'),
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 128,
              messages: [{ role: 'user', content: 'owned wire' }],
            }),
          }),
        }
        await hooks.run('http.request', draft)
        const body = JSON.parse(await draft.request.clone().text())
        expect(body.thinking.type).toBe('adaptive')
        const betas = draft.request.headers.get('anthropic-beta') ?? ''
        expect(betas).toContain('user-extra-beta')
        expect(betas).toContain('oauth-2025-04-20')
        if (body.fallbacks === 'default')
          expect(betas).toContain(SERVER_SIDE_FALLBACK_BETA)
        if (body.thinking.block_binding)
          expect(betas).toContain(THINKING_BINDING_CONTROLS_BETA)
        expect(draft.request.headers.get('x-api-key')).toBeNull()
      }
    } finally {
      await native.dispose()
    }
  })
  test('exact stock credentials keep their wire key, headers, URL, body and feedback untouched', async () => {
    const hooks = new Hooks()
    let selections = 0
    let publications = 0
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          chooseAccount: () => {
            selections++
            return 'main'
          },
          quotaFromHeaders: () => {
            publications++
            return undefined
          },
          onAttemptEnd: () => {
            publications++
          },
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      const stockCredentials: Record<string, string>[] = [
        { 'x-api-key': 'stock-api-key-exact' },
        { 'x-api-key': 'stock-env-key-exact' },
        { authorization: 'Bearer stock-opencode-oauth-exact' },
        { authorization: `Bearer ${placeholderSecret('anthropic')}-suffix` },
        {},
      ]
      for (const credential of stockCredentials) {
        const body = JSON.stringify({
          model: 'claude-sonnet-5',
          messages: [{ role: 'user', content: 'stock body' }],
          fallbacks: 'keep-stock-field',
        })
        const headers = new Headers({
          ...credential,
          'content-type': 'application/json',
          'anthropic-beta': 'stock-beta',
          'x-stock-field': 'unchanged',
        })
        const draft = {
          ...scope,
          request: new Request(
            'https://stock-gateway.invalid/v1/messages?stock=1',
            { method: 'POST', headers, body },
          ),
        }
        const before = draft.request
        const model = { ...scope, headers: { 'x-stock-model': 'unchanged' } }
        await hooks.run('model.request', model)
        expect(model.headers).toEqual({ 'x-stock-model': 'unchanged' })
        await hooks.run('http.request', draft)
        expect(draft.request).toBe(before)
        expect(draft.request.url).toBe(
          'https://stock-gateway.invalid/v1/messages?stock=1',
        )
        expect(Object.fromEntries(draft.request.headers)).toEqual(
          Object.fromEntries(headers),
        )
        expect(await draft.request.clone().text()).toBe(body)
        const response = {
          ...scope,
          request: draft.request,
          response: Response.json(
            { content: [{ type: 'tool_use', name: 'mcp_stock' }] },
            {
              headers: {
                'request-id': 'req_stock',
                'anthropic-ratelimit-unified-5h-utilization': '0.42',
              },
            },
          ),
        }
        const original = response.response
        await hooks.run('http.response', response)
        expect(response.response).toBe(original)
      }
      expect(selections).toBe(0)
      expect(publications).toBe(0)
    } finally {
      await native.dispose()
    }
  })
  test('only the exact explicit pool placeholder selects a pool bearer and never forwards marker headers', async () => {
    const hooks = new Hooks()
    let selections = 0
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          chooseAccount: () => {
            selections++
            return 'main'
          },
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      for (const header of ['authorization', 'x-api-key']) {
        const draft = { ...scope, request: request() }
        draft.request.headers.delete('authorization')
        draft.request.headers.set(
          header,
          header === 'authorization'
            ? `Bearer ${placeholderSecret('anthropic')}`
            : placeholderSecret('anthropic'),
        )
        await hooks.run('http.request', draft)
        expect(draft.request.headers.get('authorization')).toBe(
          'Bearer sk-ant-oat01-synthetic',
        )
        expect(draft.request.headers.get('x-api-key')).toBeNull()
        expect(
          [...draft.request.headers.values()].some((value) =>
            value.includes(placeholderSecret('anthropic')),
          ),
        ).toBe(false)
      }
      expect(selections).toBe(2)
    } finally {
      await native.dispose()
    }
  })
  test('prepared credential switches in both directions take effect on the next request in one session', async () => {
    const hooks = new Hooks()
    let selections = 0
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          chooseAccount: () => {
            selections++
            return 'main'
          },
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      for (const [index, token] of [
        'stock-one',
        placeholderSecret('anthropic'),
        'stock-two',
        placeholderSecret('anthropic'),
      ].entries()) {
        const draft = { ...scope, request: request() }
        draft.request.headers.set('authorization', `Bearer ${token}`)
        await hooks.run('http.request', draft)
        expect(draft.request.headers.get('authorization')).toBe(
          index % 2 ? 'Bearer sk-ant-oat01-synthetic' : `Bearer ${token}`,
        )
      }
      expect(selections).toBe(2)
    } finally {
      await native.dispose()
    }
  })
  test('explicit placeholder with an empty pool refuses with repair guidance before any HTTP dispatch', async () => {
    const hooks = new Hooks()
    let sends = 0
    const native = await installNativeAnthropic(
      { session: hooks },
      { source: source({ chooseAccount: () => undefined }) },
      { credential: preparedAnthropicCredential },
    )
    try {
      const dispatch = async () => {
        const draft = { ...scope, request: request() }
        draft.request.headers.set(
          'authorization',
          `Bearer ${placeholderSecret('anthropic')}`,
        )
        await hooks.run('http.request', draft)
        sends++
      }
      await expect(dispatch()).rejects.toThrow(
        'Complete offline migration or repair',
      )
      expect(sends).toBe(0)
    } finally {
      await native.dispose()
    }
  })
  test('only an explicit Claude pool login stores the provider-tagged inert OAuth placeholder', async () => {
    let registration: IntegrationOAuthMethodRegistration | undefined
    let logins = 0
    await registerOpenCode2AuthMethods(
      {
        integration: {
          transform: async (callback) => {
            callback({
              list: () => [],
              get: () => undefined,
              update: () => {},
              remove: () => {},
              method: {
                list: () => [],
                remove: () => {},
                update: (input) => {
                  if ('authorize' in input) registration = input
                },
              },
            })
            return { dispose: async () => {} }
          },
        },
      },
      {
        integrationID: 'anthropic',
        methods: [
          {
            method: {
              id: CLAUDE_POOL_LOGIN_METHOD_ID,
              type: 'oauth',
              label: 'Claude pool',
            },
            authorize: async () => ({
              mode: 'code',
              url: 'https://fixture.invalid/authorize',
              instructions: 'Synthetic explicit login',
              callback: async () => ({ done: true }),
            }),
          },
        ],
        onLogin: async () => {
          logins++
        },
      },
    )
    expect(logins).toBe(0)
    if (!registration) throw new Error('Explicit pool login was not registered')
    const pending = await registration.authorize({})
    if (pending.mode !== 'code')
      throw new Error('An explicit user code is required')
    const marker = await pending.callback('synthetic-code')
    expect(logins).toBe(1)
    expect(String(marker.methodID)).toBe(CLAUDE_POOL_LOGIN_METHOD_ID)
    expect(isPlaceholderCredential(marker, 'anthropic')).toBe(true)
    expect(marker.access).toBe(placeholderSecret('anthropic'))
  })
  test('real recipe overrides host credentials and removes its attempt header on physical HTTP request', async () => {
    const hooks = new Hooks()
    const native = await installNativeAnthropic(
      { session: hooks },
      { source: source() },
      { credential: preparedAnthropicCredential },
    )
    try {
      const modelRequest = { ...scope, headers: {} as Record<string, string> }
      await hooks.run('model.request', modelRequest)
      const draft = { ...scope, request: request() }
      for (const [name, value] of Object.entries(modelRequest.headers))
        draft.request.headers.set(name, value)
      await hooks.run('http.request', draft)
      expect(draft.request.headers.get('authorization')).toBe(
        'Bearer sk-ant-oat01-synthetic',
      )
      expect(draft.request.headers.get('x-common-auth-attempt')).toBeNull()
      expect(draft.request.headers.get('x-api-key')).toBeNull()
      expect(await draft.request.text()).toContain('x-anthropic-billing-header')
    } finally {
      await native.dispose()
    }
    expect(hooks.size).toBe(0)
  })

  test('selected WebSocket relay refuses before any physical HTTP send or handshake', async () => {
    const hooks = new Hooks()
    let sends = 0
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          authorizeAccount: () => ({
            route: 'oauth',
            accessToken: 'synthetic',
            provenance: { version: 7 },
            dispatch: { kind: 'websocket-relay' },
          }),
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      const dispatch = async () => {
        await hooks.run('model.request', { ...scope, headers: {} })
        await hooks.run('http.request', { ...scope, request: request() })
        sends++
      }
      await expect(dispatch()).rejects.toBeInstanceOf(
        NativeAnthropicTransportRefusal,
      )
      await expect(
        hooks.run('experimental.ws.handshake', {
          ...scope,
          url: 'wss://relay.invalid',
          headers: {
            authorization: `Bearer ${placeholderSecret('anthropic')}`,
          },
        }),
      ).rejects.toBeInstanceOf(NativeAnthropicTransportRefusal)
      expect(sends).toBe(0)
    } finally {
      await native.dispose()
    }
  })

  test('disposal revokes pending credential callbacks before they can settle into host headers', async () => {
    const hooks = new Hooks()
    const completion =
      Promise.withResolvers<Awaited<ReturnType<Source['authorizeAccount']>>>()
    const entered = Promise.withResolvers<void>()
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          authorizeAccount: () => {
            entered.resolve()
            return completion.promise
          },
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    const draft = { ...scope, request: request() }
    const result = hooks
      .run('http.request', draft)
      .catch((error: unknown) => error)
    await entered.promise
    const cleanup = native.dispose()
    completion.resolve({
      route: 'oauth',
      accessToken: 'revoked-synthetic',
      provenance: { version: 7 },
    })
    expect(await result).toBeInstanceOf(NativeAnthropicRevokedError)
    await cleanup
    expect(draft.request.headers.get('authorization')).toBe(
      `Bearer ${placeholderSecret('anthropic')}`,
    )
    expect(draft.request.headers.get('authorization')).not.toContain(
      'revoked-synthetic',
    )
    expect(hooks.size).toBe(0)
    await native.dispose()
    expect(new Set(hooks.disposed).size).toBe(hooks.disposed.length)
  })

  test('partial installation failure disposes every already-registered hook', async () => {
    const hooks = new Hooks()
    hooks.failAt = 'http.response'
    await expect(
      installNativeAnthropic(
        { session: hooks },
        { source: source() },
        { credential: preparedAnthropicCredential },
      ),
    ).rejects.toThrow('synthetic registration failure')
    expect(hooks.size).toBe(0)
    expect(hooks.disposed).toEqual(['model.request', 'http.request'])
  })

  test('HTTP relay carries the signed full wire request with only relay auth on the outer request', async () => {
    const hooks = new Hooks()
    let version = 7
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          authorizeAccount: () => ({
            route: 'oauth',
            accessToken: `sk-ant-oat01-synthetic-${version++}`,
            headers: { 'x-native-account-header': 'preserved' },
            provenance: { version },
            dispatch: {
              kind: 'http-relay',
              url: 'https://relay.invalid/send',
              token: 'relay-secret',
            },
          }),
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      for (const tokenVersion of [7, 8]) {
        const modelRequest = { ...scope, headers: {} as Record<string, string> }
        await hooks.run('model.request', modelRequest)
        const draft = { ...scope, request: request() }
        for (const [name, value] of Object.entries(modelRequest.headers))
          draft.request.headers.set(name, value)
        await hooks.run('http.request', draft)
        expect(draft.request.url).toBe('https://relay.invalid/send')
        expect(draft.request.headers.get('authorization')).toBeNull()
        expect(draft.request.headers.get('x-api-key')).toBeNull()
        expect(draft.request.headers.get('x-relay-token')).toBe('relay-secret')
        const envelope = (await draft.request.json()) as RelayEnvelope
        expect(envelope.protocol).toBe(1)
        expect(envelope.mode).toBe('full_sync')
        expect(envelope.affinity).toBe(sessionID)
        expect(envelope.upstream.url).toBe(
          'https://api.anthropic.com/v1/messages?beta=true',
        )
        expect(envelope.upstream.headers.authorization).toBe(
          `Bearer sk-ant-oat01-synthetic-${tokenVersion}`,
        )
        expect(envelope.upstream.headers['x-native-account-header']).toBe(
          'preserved',
        )
        expect(envelope.upstream.headers['x-relay-token']).toBeUndefined()
        expect(
          envelope.upstream.headers['x-common-auth-attempt'],
        ).toBeUndefined()
        expect(envelope.upstream.headers['x-api-key']).toBeUndefined()
        expect(envelope.body).toContain('x-anthropic-billing-header')
        expect(envelope.next_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
      }
    } finally {
      await native.dispose()
    }
  })

  test('relay-local 401 has no credential/quota attribution, but genuine upstream 401 keeps its receipt', async () => {
    const hooks = new Hooks()
    const quotaVersions: number[] = []
    const statuses: Array<{ version: number; status?: number }> = []
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          authorizeAccount: () => ({
            route: 'oauth',
            accessToken: 'synthetic',
            provenance: { version: 7 },
            dispatch: {
              kind: 'http-relay',
              url: 'https://relay.invalid/send',
              token: 'relay-secret',
            },
          }),
          quotaFromHeaders: (_headers, context) => {
            quotaVersions.push(context.provenance.version)
            return undefined
          },
          onAttemptEnd: (context, outcome) => {
            statuses.push({
              version: context.provenance.version,
              status: outcome.status,
            })
          },
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      for (const upstream of [false, true]) {
        const modelRequest = { ...scope, headers: {} as Record<string, string> }
        await hooks.run('model.request', modelRequest)
        const draft = { ...scope, request: request() }
        for (const [name, value] of Object.entries(modelRequest.headers))
          draft.request.headers.set(name, value)
        await hooks.run('http.request', draft)
        const response = {
          ...scope,
          request: draft.request,
          response: Response.json(
            {
              type: 'error',
              error: { type: 'authentication_error', message: 'rejected' },
            },
            {
              status: 401,
              headers: upstream ? { 'request-id': 'req_upstream7' } : {},
            },
          ),
        }
        await hooks.run('http.response', response)
        expect(response.response.status).toBe(upstream ? 401 : 502)
        await response.response.text()
      }
      expect(quotaVersions).toEqual([7])
      expect(statuses).toEqual([
        { version: 7, status: undefined },
        { version: 7, status: 401 },
      ])
    } finally {
      await native.dispose()
    }
  })
})

/** Registers the setup's login methods through common-auth, recording what the host would store and every local pool write. */
async function enrollmentLogin(readMode: ClaudeLoginMethodsInput['readMode']) {
  const registrations = new Map<string, IntegrationOAuthMethodRegistration>()
  const writes: unknown[] = []
  let browserStarts = 0
  // Writes to OpenCode's existing connections, as opposed to the credential
  // a completed login method hands back for OpenCode to store.
  let connectionWrites = 0
  await registerOpenCode2AuthMethods(
    {
      integration: {
        transform: async (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            update: () => {
              connectionWrites++
            },
            remove: () => {
              connectionWrites++
            },
            method: {
              list: () => [],
              remove: () => {},
              update: (input) => {
                if ('authorize' in input)
                  registrations.set(String(input.method.id), input)
              },
            },
          })
          return { dispose: async () => {} }
        },
      },
    },
    claudeLoginMethods({
      isActive: () => true,
      readMode,
      runtime: {
        loginOAuth: async (input) => {
          writes.push(input)
          return undefined as never
        },
      },
      authorize: async () => {
        browserStarts++
        return {
          url: 'https://claude.invalid/authorize',
          redirectUri: 'https://claude.invalid/callback',
          state: 'synthetic-state',
          verifier: 'synthetic-verifier',
        }
      },
      exchange: async () => ({
        type: 'success',
        access: 'sk-ant-oat01-synthetic-login',
        refresh: 'synthetic-login-refresh',
        expires: 4_102_444_800_000,
      }),
    }),
  )
  const method = (id: string) => {
    const registration = registrations.get(id)
    if (!registration) throw new Error(`login method ${id} is not registered`)
    return registration
  }
  /** Starts vault activation as OpenCode would and returns its callback, which resolves to the credential OpenCode stores. */
  const activateVault = async () => {
    const pending = await method(CLAUDE_VAULT_ACTIVATION_METHOD_ID).authorize(
      {},
    )
    if (pending.mode !== 'auto')
      throw new Error('Vault activation must need no user step')
    return pending.callback
  }
  return {
    method,
    activateVault,
    writes,
    browserStarts: () => browserStarts,
    connectionWrites: () => connectionWrites,
  }
}

describe('Claude login methods follow vault enrollment', () => {
  test('an enrolled host refuses local sign-in before the browser opens and activates vault accounts without local writes', async () => {
    const login = await enrollmentLogin(async () => 'claustrum')
    await expect(
      login.method(CLAUDE_POOL_LOGIN_METHOD_ID).authorize({}),
    ).rejects.toThrow(LOCAL_LOGIN_REFUSED_IN_VAULT)
    expect(login.browserStarts()).toBe(0)
    const marker = await login.activateVault()
    expect(String(marker.methodID)).toBe(CLAUDE_VAULT_ACTIVATION_METHOD_ID)
    expect(isPlaceholderCredential(marker, 'anthropic')).toBe(true)
    expect(marker.access).toBe(placeholderSecret('anthropic'))
    expect(login.writes).toHaveLength(0)
  })
  test('a host without vault enrollment refuses vault activation and keeps local sign-in', async () => {
    const login = await enrollmentLogin(async () => 'local')
    await expect(login.activateVault()).rejects.toThrow(
      VAULT_ACTIVATION_REFUSED_LOCALLY,
    )
    const pending = await login
      .method(CLAUDE_POOL_LOGIN_METHOD_ID)
      .authorize({})
    if (pending.mode !== 'code')
      throw new Error('An explicit user code is required')
    const marker = await pending.callback('synthetic-code')
    expect(String(marker.methodID)).toBe(CLAUDE_POOL_LOGIN_METHOD_ID)
    expect(login.writes).toEqual([
      {
        routeId: 'main',
        credential: {
          access: 'sk-ant-oat01-synthetic-login',
          refresh: 'synthetic-login-refresh',
          expires: 4_102_444_800_000,
        },
        replace: true,
      },
    ])
  })
  test('enrollment that starts while the user is in the browser stops the local write', async () => {
    let mode: 'local' | 'claustrum' = 'local'
    const login = await enrollmentLogin(async () => mode)
    const pending = await login
      .method(CLAUDE_POOL_LOGIN_METHOD_ID)
      .authorize({})
    if (pending.mode !== 'code')
      throw new Error('An explicit user code is required')
    mode = 'claustrum'
    await expect(pending.callback('synthetic-code')).rejects.toThrow(
      LOCAL_LOGIN_REFUSED_IN_VAULT,
    )
    expect(login.writes).toHaveLength(0)
  })
  test('unreadable enrollment refuses both methods with fixed text and writes nothing', async () => {
    const login = await enrollmentLogin(async () => {
      throw new Error('token sk-ant-oat01-must-not-surface')
    })
    await expect(
      login.method(CLAUDE_POOL_LOGIN_METHOD_ID).authorize({}),
    ).rejects.toThrow(ENROLLMENT_UNREADABLE)
    const refusal = await login.activateVault().catch((error: Error) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toBe(ENROLLMENT_UNREADABLE)
    expect(login.browserStarts()).toBe(0)
    expect(login.writes).toHaveLength(0)
  })
  test('vault activation hands OpenCode the exact request-owning placeholder, never a custody tombstone, and leaves existing connections alone', async () => {
    const login = await enrollmentLogin(async () => 'claustrum')
    const marker = await login.activateVault()
    expect(login.connectionWrites()).toBe(0)
    const tombstone = custodyTombstoneOAuth('anthropic')
    expect(marker.access).not.toBe(tombstone.access)
    expect(marker.refresh).not.toBe(tombstone.refresh)
    // The stored marker's secret is what OpenCode later sends; only that
    // exact value may select the native account pool.
    const hooks = new Hooks()
    let selections = 0
    const native = await installNativeAnthropic(
      { session: hooks },
      {
        source: source({
          chooseAccount: () => {
            selections++
            return 'main'
          },
        }),
      },
      { credential: preparedAnthropicCredential },
    )
    try {
      const owned = { ...scope, request: request() }
      owned.request.headers.set('authorization', `Bearer ${marker.access}`)
      await hooks.run('http.request', owned)
      expect(owned.request.headers.get('authorization')).toBe(
        'Bearer sk-ant-oat01-synthetic',
      )
      for (const value of [tombstone.access, tombstone.refresh]) {
        const stock = { ...scope, request: request() }
        stock.request.headers.set('authorization', `Bearer ${value}`)
        const before = stock.request
        await hooks.run('http.request', stock)
        expect(stock.request).toBe(before)
      }
      expect(selections).toBe(1)
    } finally {
      await native.dispose()
    }
  })
})
