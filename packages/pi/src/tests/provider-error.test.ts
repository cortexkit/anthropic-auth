import { expect, test as registerTest, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import * as filesystem from 'node:fs/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  AccountStorage,
  NativeCustodyClient,
} from '@cortexkit/anthropic-auth-core'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  resolveNativePoolPaths,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
import type { ScopedInventoryRow } from '@cortexkit/claustrum-client'
import { mutateVaultRoster } from '@cortexkit/common-auth/claustrum'
import { acquireRefreshFileLock } from '@cortexkit/common-auth/fs'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import type { TestGate } from '../../../core/src/tests/test-lifetime.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import { closePiNativeRuntime, getPiNativeRuntime } from '../native.ts'
import {
  __setPiQuotaCallPauseForTest,
  streamCortexKitAnthropic,
} from '../stream.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

// Provider errors can repeat the credential a send used. These tests drive the
// real Pi stream with synthetic accounts and check that the error Pi reports
// has that send's own credential removed, while successful content and
// routing decisions stay unchanged.

const lifetimes = createTestLifetimeSuite()
const { deferCleanup, gate } = lifetimes
const test = (name: string, body: () => unknown, timeout?: number) =>
  registerTest(
    name,
    lifetimes.wrapBody(() =>
      trackPiTestBody(Promise.resolve().then(() => body())),
    ),
    timeout,
  )

const originalFetch = globalThis.fetch
const model: Model<Api> = {
  id: 'claude-sonnet-4-6',
  name: 'Sonnet',
  provider: 'anthropic',
  api: 'cortexkit-anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  contextWindow: 200_000,
  maxTokens: 64_000,
}
const context: Context = {
  messages: [
    { role: 'user', content: 'Synthetic provider error probe', timestamp: 0 },
  ],
  tools: [],
}

const RELAY_URL = 'https://synthetic-relay.invalid'
// Credentials without a recognizable token prefix: only exact, per-send
// redaction can remove them.
const vaultAccess = (version: number) =>
  `synthetic-vault-access-v${version}-6d0a`
const RELAY_TOKEN = 'synthetic-private-relay-token-41c7'
const MAIN_ACCESS = 'sk-ant-oat01-synthetic-pi-provider-error-main'
const PAID_KEY = 'synthetic-pi-paid-api-key-2e93'
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
const healthy = (text: string) =>
  sse({
    type: 'message_start',
    message: { usage: { input_tokens: 1, output_tokens: 0 } },
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

/** A body that reaches Pi one UTF-8 byte per read. */
function byteStream(text: string) {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(offset, ++offset))
    },
  })
}
const eventStream = (text: string) =>
  new Response(byteStream(text), {
    headers: {
      'content-type': 'text/event-stream',
      'request-id': 'req_synthetic_pi',
    },
  })
const jsonError = (status: number, type: string, secret: string) =>
  Response.json(errorEnvelope(type, secret), {
    status,
    headers: { 'request-id': 'req_synthetic_pi' },
  })

type FetchArgs = Parameters<typeof fetch>
type Provider = (url: string, init: FetchArgs[1]) => Promise<Response>

function useFetch(provider: Provider) {
  globalThis.fetch = Object.assign(
    async (input: FetchArgs[0], init?: FetchArgs[1]) =>
      provider(input instanceof Request ? input.url : String(input), init),
    { preconnect: originalFetch.preconnect },
  )
}

const authorizationOf = (init: FetchArgs[1]) =>
  new Headers(init?.headers).get('authorization') ?? ''

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

/** Close this fixture's Pi native runtime before restoring fetch and environment. */
async function ownDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  const storagePath = join(directory, 'accounts.json')
  const envKeys = [
    'PI_CODING_AGENT_DIR',
    'PI_AGENT_DIR',
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
    'PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE',
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
    await rm(directory, { recursive: true, force: true })
  })
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_AGENT_DIR = directory
  process.env.PI_ANTHROPIC_AUTH_FILE = storagePath
  process.env.PI_ANTHROPIC_AUTH_ROUTING_STATE_FILE = join(
    directory,
    'routing.json',
  )
  return { directory, storagePath }
}

const row = (id: string, accountId: string): ScopedInventoryRow => ({
  id,
  accountId,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  providerIds: [],
  refreshAdapter: 'anthropic',
  operations: ['read', 'invalidate'],
  state: 'active',
  recordVersion: 1,
  createdAtMs: null,
})

/** Create a vault primary-account fixture with a changeable credential version. */
async function vaultFixture(relay?: { fallbackToDirect: boolean } | undefined) {
  const { directory, storagePath } = await ownDirectory('pi-provider-error-')
  const tokenPath = join(directory, 'pi-enrollment.json')
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [],
      quota: { enabled: false },
      refresh: { enabled: false },
      routing: { mode: 'main-first' },
    },
    storagePath,
    { primary: false },
  )
  await writeFile(
    tokenPath,
    JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
    { mode: 0o600 },
  )
  const rows = [row('oauth:anthropic', fixtureAccountIdentity('main'))]
  const state = {
    version: 1,
    reports: [] as { recordVersion: number; providerStatus: number }[],
  }
  const client: NativeCustodyClient = {
    listScoped: async () => ({
      rows,
      view: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async (input) => ({
      credentialId: input.credentialId,
      accountId: fixtureAccountIdentity('main'),
      material: vaultAccess(state.version),
      recordVersion: state.version,
      expiresAtMs: Date.now() + 600_000,
    }),
    reportAuthFailureScoped: async (input) => {
      state.reports.push({
        recordVersion: input.recordVersion,
        providerStatus: input.providerStatus,
      })
    },
    close: () => {},
  }
  const native = getPiNativeRuntime(storagePath, {
    connect: async () => client,
  })
  const service = await native.service()
  await service.vault.refresh()
  if (relay)
    await service.updateRelay({
      enabled: true,
      url: RELAY_URL,
      token: RELAY_TOKEN,
      transport: 'http',
      fallbackToDirect: relay.fallbackToDirect,
    })
  return { state, tokenPath, native, service, storagePath, client }
}

async function run(sessionId: string) {
  const stream = streamCortexKitAnthropic(model, context, { sessionId })
  const deltas: string[] = []
  const errors: string[] = []
  for await (const event of stream) {
    if (event.type === 'text_delta') deltas.push(event.delta)
    if (event.type === 'error') errors.push(event.error.errorMessage ?? '')
  }
  const result = await stream.result()
  return { result, deltas, errors }
}

async function expectError(
  sessionId: string,
  secrets: readonly string[],
  keeps: readonly string[],
) {
  const { result, errors } = await run(sessionId)
  expect(result.stopReason).toBe('error')
  const message = result.errorMessage ?? ''
  expectScrubbed(message, secrets)
  for (const kept of keeps) expect(message).toContain(kept)
  for (const error of errors) expectScrubbed(error, secrets)
  return message
}

test('Pi direct HTTP error omits the vault credential and keeps status and type', async () => {
  await vaultFixture()
  useFetch(async () => jsonError(400, 'invalid_request_error', vaultAccess(1)))
  await expectError(
    'pi-http-error',
    [vaultAccess(1)],
    ['HTTP 400', 'invalid_request_error'],
  )
})

test('Pi streamed retryable error omits the vault credential', async () => {
  await vaultFixture()
  useFetch(async () =>
    eventStream(sse(errorEnvelope('overloaded_error', vaultAccess(1)))),
  )
  await expectError('pi-sse-error', [vaultAccess(1)], ['overloaded_error'])
})

for (const ending of ['LF', 'CRLF'] as const) {
  test(`Pi joins a multiline ${ending} error frame and scrubs it`, async () => {
    await vaultFixture()
    const frame = `event: error\ndata: {"type":"error",\ndata: "error":{"type":"overloaded_error",\ndata: "message":${JSON.stringify(echoOf(vaultAccess(1)))}}}\n\n`
    useFetch(async () =>
      eventStream(ending === 'CRLF' ? frame.replaceAll('\n', '\r\n') : frame),
    )
    await expectError(
      `pi-multiline-${ending}`,
      [vaultAccess(1)],
      ['overloaded_error'],
    )
  })
}

test('Pi treats an escaped-key error envelope as an error and scrubs it', async () => {
  await vaultFixture()
  const frame = `data: {"\\u0074ype":"\\u0065rror","\\u0065rror":{"\\u0074ype":"overloaded_\\u0065rror","\\u006dessage":${JSON.stringify(echoOf(vaultAccess(1)))}}}\n\n`
  expect(frame.includes('error')).toBe(false)
  useFetch(async () => eventStream(frame))
  await expectError('pi-escaped-error', [vaultAccess(1)], ['overloaded_error'])
})

for (const ending of ['LF', 'CRLF'] as const) {
  test(`Pi keeps successful ${ending} text that quotes a credential, split inside UTF-8`, async () => {
    await vaultFixture()
    const text = `début 🧪 漢字 error handling ${echoOf(vaultAccess(1))} fin`
    const body = healthy(text)
    useFetch(async () =>
      eventStream(ending === 'CRLF' ? body.replaceAll('\n', '\r\n') : body),
    )
    const { result, deltas } = await run(`pi-success-${ending}`)
    expect(result.stopReason).toBe('stop')
    expect(result.errorMessage).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text }])
    expect(deltas.join('')).toBe(text)
  })
}

test('Pi thrown transport error omits the credential it was sent with', async () => {
  await vaultFixture()
  useFetch(async (_url, init) => {
    throw new Error(
      `synthetic socket failure for ${authorizationOf(init)} ${echoOf(vaultAccess(1))}`,
    )
  })
  await expectError(
    'pi-transport-error',
    [vaultAccess(1)],
    ['synthetic socket failure'],
  )
})

test('Pi scrubs the final rotated vault credential after a 401 retry', async () => {
  const { state } = await vaultFixture()
  const sent: string[] = []
  useFetch(async (_url, init) => {
    const authorization = authorizationOf(init)
    sent.push(authorization)
    if (authorization === `Bearer ${vaultAccess(1)}`) {
      state.version = 2
      return jsonError(401, 'authentication_error', vaultAccess(1))
    }
    return jsonError(400, 'invalid_request_error', vaultAccess(2))
  })
  await expectError(
    'pi-rotation',
    [vaultAccess(1), vaultAccess(2)],
    ['HTTP 400', 'invalid_request_error'],
  )
  expect(sent).toEqual([`Bearer ${vaultAccess(1)}`, `Bearer ${vaultAccess(2)}`])
})

test('Pi HTTP relay error omits the upstream credential and the private relay token', async () => {
  await vaultFixture({ fallbackToDirect: false })
  const relayed: string[] = []
  useFetch(async (url, init) => {
    if (!url.startsWith(RELAY_URL)) throw new Error(`unexpected ${url}`)
    relayed.push(relayAuthorization(init))
    return Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `${echoOf(vaultAccess(1))}; relay=${new Headers(init?.headers).get('x-relay-token')}`,
        },
      },
      { status: 400, headers: { 'request-id': 'req_synthetic_relay' } },
    )
  })
  await expectError(
    'pi-relay-error',
    [vaultAccess(1), RELAY_TOKEN],
    ['HTTP 400', 'invalid_request_error'],
  )
  expect(relayed).toEqual([`Bearer ${vaultAccess(1)}`])
})

test('Pi relay failure rescued by direct dispatch scrubs the direct credential', async () => {
  const { state } = await vaultFixture({ fallbackToDirect: true })
  const sent: string[] = []
  useFetch(async (url, init) => {
    if (url.startsWith(RELAY_URL)) {
      sent.push(`relay:${relayAuthorization(init)}`)
      state.version = 2
      return new Response('relay unavailable', { status: 503 })
    }
    sent.push(`direct:${authorizationOf(init)}`)
    return jsonError(400, 'invalid_request_error', vaultAccess(2))
  })
  await expectError(
    'pi-relay-rescue',
    [vaultAccess(1), vaultAccess(2), RELAY_TOKEN],
    ['HTTP 400', 'invalid_request_error'],
  )
  expect(sent).toEqual([
    `relay:Bearer ${vaultAccess(1)}`,
    `direct:Bearer ${vaultAccess(2)}`,
  ])
})

test('Pi thrown relay error omits the private relay token and the credential', async () => {
  await vaultFixture({ fallbackToDirect: false })
  useFetch(async (url, init) => {
    if (!url.startsWith(RELAY_URL)) throw new Error(`unexpected ${url}`)
    throw new Error(
      `synthetic relay socket failure token=${new Headers(init?.headers).get('x-relay-token')} upstream=${relayAuthorization(init)}`,
    )
  })
  await expectError(
    'pi-relay-throw',
    [vaultAccess(1), RELAY_TOKEN],
    ['synthetic relay socket failure'],
  )
})

/**
 * Stands in for Pi's wait between quota usage polls in this test. A route that
 * hits a rate limit polls usage again soon after the first poll, and Pi spaces
 * those polls one second apart. This records each requested wait and returns
 * at once, so the test spends no real time on that spacing. Set it before the
 * first request: Pi reads it when it creates the storage's quota manager.
 */
function recordQuotaPauses() {
  const requested: number[] = []
  __setPiQuotaCallPauseForTest(async (ms) => {
    requested.push(ms)
  })
  deferCleanup(() => __setPiQuotaCallPauseForTest(undefined))
  return requested
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

/** Create a local OAuth account with a paid API fallback for general quota exhaustion. */
async function paidFixture(apiKey = PAID_KEY) {
  const quotaPauses = recordQuotaPauses()
  const { directory, storagePath } = await ownDirectory(
    'pi-provider-error-paid-',
  )
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          type: 'api',
          id: 'paid',
          apiKey,
          baseURL: 'https://paid.invalid',
        },
      ],
    },
    storagePath,
    { mainAccess: MAIN_ACCESS },
  )
  return { directory, quotaPauses }
}

test('Pi usage-limit echo still reaches the paid route, whose error omits the paid key', async () => {
  const { quotaPauses } = await paidFixture()
  const modelRequests: string[] = []
  useFetch(async (url, init) => {
    if (url.includes('/api/oauth/usage'))
      return Response.json({
        five_hour: { utilization: 100 },
        seven_day: { utilization: 100 },
      })
    if (!url.includes('/v1/messages'))
      return new Response('{}', { status: 503 })
    modelRequests.push(authorizationOf(init))
    return url.startsWith('https://paid.invalid')
      ? jsonError(400, 'invalid_request_error', PAID_KEY)
      : jsonError(429, 'rate_limit_error', MAIN_ACCESS)
  })
  await expectError(
    'pi-paid-error',
    [PAID_KEY, MAIN_ACCESS],
    ['HTTP 400', 'invalid_request_error'],
  )
  expect(modelRequests).toEqual([`Bearer ${MAIN_ACCESS}`, `Bearer ${PAID_KEY}`])
  expectQuotaPollGaps(quotaPauses)
})

test('Pi usage-limit echo without exhaustion keeps the primary 429 and scrubs it', async () => {
  const { quotaPauses } = await paidFixture()
  const modelRequests: string[] = []
  useFetch(async (url, init) => {
    if (url.includes('/api/oauth/usage'))
      return Response.json({
        five_hour: { utilization: 10 },
        seven_day: { utilization: 10 },
      })
    if (!url.includes('/v1/messages'))
      return new Response('{}', { status: 503 })
    modelRequests.push(authorizationOf(init))
    return jsonError(429, 'rate_limit_error', MAIN_ACCESS)
  })
  await expectError(
    'pi-primary-limit',
    [MAIN_ACCESS],
    ['HTTP 429', 'rate_limit_error'],
  )
  expect(modelRequests).toEqual([`Bearer ${MAIN_ACCESS}`])
  expectQuotaPollGaps(quotaPauses)
})

// A streamed rate limit arrives as an `error` event whose `error.type` is
// `rate_limit_error`. It must route like an HTTP 429: refresh the primary's
// quota, move to another OAuth account when one is eligible, and use a paid
// API route only after the primary is confirmed generally exhausted. Text in
// an ordinary reply that mentions rate limits must do neither.

const BACKUP_ACCESS = 'sk-ant-oat01-synthetic-pi-backup-access'
const FABLE = 'claude-fable-5-1'

async function routingFixture(backup: boolean) {
  const quotaPauses = recordQuotaPauses()
  const { storagePath } = await ownDirectory('pi-streamed-limit-')
  const paid: AccountStorage['accounts'][number] = {
    type: 'api',
    id: 'paid',
    apiKey: PAID_KEY,
    baseURL: 'https://paid.invalid',
  }
  const backupAccount: AccountStorage['accounts'][number] = {
    type: 'oauth',
    id: 'backup',
    access: BACKUP_ACCESS,
    refresh: 'synthetic-pi-backup-refresh',
  }
  await saveNativePiFixture(
    { version: 1, accounts: backup ? [backupAccount, paid] : [paid] },
    storagePath,
    { mainAccess: MAIN_ACCESS },
  )
  return { quotaPauses }
}

const usageReading = (general: number, fable: number) =>
  Response.json({
    five_hour: { utilization: general },
    seven_day: { utilization: general },
    limits: [
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: fable,
        scope: { model: { display_name: 'Fable' } },
      },
    ],
  })

/**
 * Serves the primary's model response and its quota reading; every other
 * account has spare quota and answers model requests successfully.
 */
function routingFetch(primary: () => Response, usage: () => Response) {
  const record = { models: [] as string[], usagePolls: 0 }
  useFetch(async (url, init) => {
    if (url.includes('/api/oauth/usage')) {
      record.usagePolls++
      return authorizationOf(init) === `Bearer ${MAIN_ACCESS}`
        ? usage()
        : usageReading(10, 10)
    }
    if (!url.includes('/v1/messages'))
      return new Response('{}', { status: 503 })
    const authorization = authorizationOf(init)
    record.models.push(authorization)
    return authorization === `Bearer ${MAIN_ACCESS}`
      ? primary()
      : eventStream(healthy('another route answered'))
  })
  return record
}

async function runModel(id: string, sessionId: string) {
  const stream = streamCortexKitAnthropic({ ...model, id }, context, {
    sessionId,
  })
  for await (const _event of stream) {
    // Drain the provider stream.
  }
  return stream.result()
}

test('Pi streamed rate_limit_error with the primary generally exhausted reaches the paid route', async () => {
  const { quotaPauses } = await routingFixture(false)
  const record = routingFetch(
    () => eventStream(sse(errorEnvelope('rate_limit_error', MAIN_ACCESS))),
    () => usageReading(100, 100),
  )
  const result = await runModel(model.id, 'pi-streamed-general')
  expect(record.models).toEqual([`Bearer ${MAIN_ACCESS}`, `Bearer ${PAID_KEY}`])
  expect(record.usagePolls).toBeGreaterThan(0)
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([
    { type: 'text', text: 'another route answered' },
  ])
  expectQuotaPollGaps(quotaPauses)
})

test('Pi streamed rate_limit_error with only a model-scoped limit moves to OAuth, never the paid route', async () => {
  const { quotaPauses } = await routingFixture(true)
  const record = routingFetch(
    () => eventStream(sse(errorEnvelope('rate_limit_error', MAIN_ACCESS))),
    () => usageReading(10, 100),
  )
  const result = await runModel(FABLE, 'pi-streamed-scoped')
  expect(record.models).toEqual([
    `Bearer ${MAIN_ACCESS}`,
    `Bearer ${BACKUP_ACCESS}`,
  ])
  expect(record.models).not.toContain(`Bearer ${PAID_KEY}`)
  expect(record.usagePolls).toBeGreaterThan(0)
  expect(result.stopReason).toBe('stop')
  expectQuotaPollGaps(quotaPauses)
})

test('Pi reply text that mentions rate limits neither refreshes quota nor reroutes', async () => {
  const { quotaPauses } = await routingFixture(true)
  const text =
    "Notes: a rate_limit_error means you exceed your account's rate limit."
  const record = routingFetch(
    () => eventStream(healthy(text)),
    () => usageReading(100, 100),
  )
  const result = await runModel(model.id, 'pi-streamed-mention')
  expect(record.models).toEqual([`Bearer ${MAIN_ACCESS}`])
  expect(record.usagePolls).toBe(0)
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([{ type: 'text', text }])
  expectQuotaPollGaps(quotaPauses)
})

for (const contentType of ['text/plain', undefined] as const) {
  const name = contentType ?? 'no content type'
  const untyped = (text: string) =>
    new Response(byteStream(text), {
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        'request-id': 'req_synthetic_pi',
      },
    })

  test(`Pi streamed error served as ${name} is scrubbed because the request streamed`, async () => {
    await vaultFixture()
    useFetch(async () =>
      untyped(sse(errorEnvelope('overloaded_error', vaultAccess(1)))),
    )
    await expectError(
      `pi-untyped-${name}`,
      [vaultAccess(1)],
      ['overloaded_error'],
    )
  })

  test(`Pi successful stream served as ${name} keeps its content`, async () => {
    await vaultFixture()
    const text = `début 🧪 error notes ${echoOf(vaultAccess(1))}`
    useFetch(async () => untyped(healthy(text)))
    const { result, deltas } = await run(`pi-untyped-ok-${name}`)
    expect(result.stopReason).toBe('stop')
    expect(result.content).toEqual([{ type: 'text', text }])
    expect(deltas.join('')).toBe(text)
  })
}

// The tests below send each request through Bun's own fetch to a real
// 127.0.0.1 server. The server therefore sees the header values Pi actually
// put on the wire, echoes that credential back, and its kept-open streams
// learn when the client really cancels them.

const encoder = new TextEncoder()
/** How long a test waits for the provider to see a cancellation. */
const CANCEL_WAIT_MS = 2_000

type Wire = { host: string; path: string; bearer: string; apiKey: string }

/** Route every fetch to a loopback server; the original host leads the path. */
function loopbackProvider(serve: (wire: Wire) => Response | Promise<Response>) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // A kept-open stream must stay open until the client cancels it.
    idleTimeout: 0,
    fetch(request) {
      const [, host = '', ...rest] = new URL(request.url).pathname.split('/')
      const authorization = request.headers.get('authorization') ?? ''
      return serve({
        host,
        path: `/${rest.join('/')}`,
        bearer: authorization.replace(/^Bearer /, ''),
        apiKey: request.headers.get('x-api-key') ?? '',
      })
    },
  })
  deferCleanup(() => server.stop(true))
  useFetch(async (url, init) => {
    const target = new URL(url)
    return observeCancel(
      await originalFetch(
        `http://127.0.0.1:${server.port}/${target.host}${target.pathname}${target.search}`,
        init,
      ),
    )
  })
}

// The cancellation gate of each kept-open response, by the id its response
// header carries.
const keptOpenGates = new Map<string, TestGate>()
const KEPT_OPEN_HEADER = 'x-loopback-kept-open'

/**
 * Hand Pi the real fetch body behind a pass-through whose cancel opens the
 * stream's gate before forwarding. Bun 1.3 does not tell the server when a
 * client cancels a fetch body, so the cancellation is observed here, on the
 * client side of the physical body.
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
  void gate().wait.then(() => reader.cancel().catch(() => {}))
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
 * `cancelled` opens when the client cancels the physical body (see
 * `observeCancel`).
 */
function keptOpen(
  text: string,
  cancelled: TestGate,
  { status = 200, close = false } = {},
) {
  const id = crypto.randomUUID()
  keptOpenGates.set(id, cancelled)
  deferCleanup(() => {
    keptOpenGates.delete(id)
  })
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        if (close) controller.close()
        // Teardown ends a still-open response before it waits for the body.
        else
          void gate().wait.then(() => {
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
        'content-type':
          status === 200 ? 'text/event-stream' : 'application/json',
        'request-id': 'req_synthetic_pi',
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

/** Serve quota readings, the paid route and a backup OAuth route; the primary's model reply comes from `primary`. */
function loopbackRouting(
  primary: (wire: Wire) => Response,
  backup: (wire: Wire) => Response = () =>
    eventStream(healthy('another route answered')),
) {
  const started = performance.now()
  // Every provider request in arrival order, with milliseconds since the
  // routing began, so a failing routing test can show where it diverged.
  const trace: string[] = []
  const record = { models: [] as string[], usagePolls: 0, trace, started }
  const who = (wire: Wire) =>
    wire.bearer === MAIN_ACCESS
      ? 'main'
      : wire.bearer === BACKUP_ACCESS
        ? 'backup'
        : wire.bearer === PAID_KEY
          ? 'paid'
          : 'other'
  loopbackProvider((wire) => {
    trace.push(
      `${Math.round(performance.now() - started)}ms ${who(wire)} ${wire.host}${wire.path}`,
    )
    if (wire.path.startsWith('/api/oauth/usage')) {
      record.usagePolls++
      return wire.bearer === MAIN_ACCESS
        ? usageReading(100, 100)
        : usageReading(10, 10)
    }
    if (!wire.path.startsWith('/v1/messages'))
      return new Response('{}', { status: 503 })
    record.models.push(wire.bearer)
    if (wire.bearer === MAIN_ACCESS) return primary(wire)
    if (wire.bearer === BACKUP_ACCESS) return backup(wire)
    return eventStream(healthy('another route answered'))
  })
  return record
}

const rateLimitFrame = (wire: Wire) =>
  sse(errorEnvelope('rate_limit_error', wire.bearer))
/**
 * Comment frames totalling about 80 KiB: more than Pi reads (64 KiB) while
 * looking for a stream's first event.
 */
const manyComments = `: ${'k'.repeat(1_020)}\n\n`.repeat(80)

test('Pi streamed rate limit on a kept-open primary cancels its provider body before the paid route answers', async () => {
  const { quotaPauses } = await routingFixture(false)
  const cancelled = gate()
  const record = loopbackRouting((wire) =>
    keptOpen(`: keepalive\n\n${rateLimitFrame(wire)}`, cancelled),
  )
  const result = await runModel(model.id, 'pi-kept-open-primary')
  expect(record.models).toEqual([MAIN_ACCESS, PAID_KEY])
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([
    { type: 'text', text: 'another route answered' },
  ])
  expect(await within(cancelled.wait)).toBe(true)
  expectQuotaPollGaps(quotaPauses)
})

test('Pi streamed rate limit on a kept-open fallback route is cancelled and the next route answers', async () => {
  const { quotaPauses } = await routingFixture(true)
  const cancelled = gate()
  const record = loopbackRouting(
    (wire) => jsonError(429, 'rate_limit_error', wire.bearer),
    (wire) => keptOpen(rateLimitFrame(wire), cancelled),
  )
  const mark = (phase: string) =>
    record.trace.push(
      `${Math.round(performance.now() - record.started)}ms ${phase}`,
    )
  void cancelled.wait.then(() => mark('backup body cancelled'))
  mark('run started')
  const running = runModel(model.id, 'pi-kept-open-fallback')
  // The run is bounded here, not by the test deadline: a cancellation of
  // the inspected route that never settles would otherwise hang it.
  const finished = await within(running, 10_000)
  mark(finished ? 'run finished' : 'run still running at 10 s')
  if (!finished) void running.catch(() => {})
  // Each assertion names its phase and carries the whole request trace.
  const trace = () => record.trace.join('\n')
  expect(finished, `phase: run bounded\n${trace()}`).toBe(true)
  const result = await running
  expect(record.models, `phase: routes tried\n${trace()}`).toEqual([
    MAIN_ACCESS,
    BACKUP_ACCESS,
    PAID_KEY,
  ])
  expect(
    result.stopReason,
    `phase: result ${result.errorMessage ?? ''}\n${trace()}`,
  ).toBe('stop')
  expect(result.content, `phase: content\n${trace()}`).toEqual([
    { type: 'text', text: 'another route answered' },
  ])
  expect(
    await within(cancelled.wait),
    `phase: backup cancellation\n${trace()}`,
  ).toBe(true)
  expectQuotaPollGaps(quotaPauses)
})

test('Pi passes a stream through unclassified once comments exhaust the first-event budget', async () => {
  const { quotaPauses } = await routingFixture(false)
  const record = loopbackRouting(
    (wire) =>
      new Response(manyComments + rateLimitFrame(wire), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  )
  const stream = streamCortexKitAnthropic(model, context, {
    sessionId: 'pi-comment-budget',
  })
  for await (const _event of stream) {
    // Drain the provider stream.
  }
  const result = await stream.result()
  // The late error is the primary's reply, not a first-event rate limit, so
  // neither the quota is polled nor the paid route tried.
  expect(record.models).toEqual([MAIN_ACCESS])
  expect(record.usagePolls).toBe(0)
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('rate_limit_error')
  expectScrubbed(result.errorMessage ?? '', [MAIN_ACCESS])
  expectQuotaPollGaps(quotaPauses)
})

test('Pi keeps a successful reply that follows comments past the first-event budget byte for byte', async () => {
  const { quotaPauses } = await routingFixture(false)
  const text = `début 🧪 ${echoOf(MAIN_ACCESS)}`
  const record = loopbackRouting(
    () =>
      new Response(manyComments + healthy(text), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  )
  const result = await runModel(model.id, 'pi-comment-budget-ok')
  expect(record.models).toEqual([MAIN_ACCESS])
  expect(record.usagePolls).toBe(0)
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([{ type: 'text', text }])
  expectQuotaPollGaps(quotaPauses)
})

function captureUsageLogs() {
  const records: LogTestRecord[] = []
  const previous = getLogLevel()
  setLogLevel('debug')
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => {
    __setLogTestSink(null)
    setLogLevel(previous)
  })
  return records
}

test('Pi lastUsed custody refusal keeps the reply and logs ERROR; the next authorization refuses', async () => {
  const { tokenPath, native, service } = await vaultFixture()
  const logs = captureUsageLogs()
  const cancelled = gate()
  const sent: string[] = []
  loopbackProvider(async (wire) => {
    sent.push(wire.bearer)
    // The vault enrollment disappears while the model reply is in flight,
    // so the lastUsed publication that follows the reply meets a custody
    // guard instead of a stale or superseded receipt.
    await rm(tokenPath, { force: true })
    return keptOpen(healthy(echoOf(wire.bearer)), cancelled, { close: true })
  })
  const { result } = await run('pi-lastused-guard')
  expect(sent).toEqual([vaultAccess(1)])
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([
    { type: 'text', text: echoOf(vaultAccess(1)) },
  ])
  await native.usagePublications.drain()
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
  await expect(service.vault.authorize('main')).rejects.toThrow()
})

/**
 * Run `act` when the next native runtime write opens its staging file, which
 * is after the lastUsed change is staged and before the writer's final
 * guards and rename. Other files open normally.
 */
function onNextRuntimeStage(act: () => Promise<void>) {
  const original = filesystem.open
  let fired = false
  const spy = spyOn(filesystem, 'open').mockImplementation(
    async (path, flags, mode) => {
      if (
        !fired &&
        typeof path === 'string' &&
        basename(path).includes('.native-runtime.') &&
        path.endsWith('.partial')
      ) {
        fired = true
        await act()
      }
      return original(path, flags, mode)
    },
  )
  deferCleanup(() => spy.mockRestore())
  return { fired: () => fired }
}

test('Pi staged lastUsed custody refusal keeps the reply and logs ERROR; the next authorization refuses', async () => {
  const { tokenPath, native, service } = await vaultFixture()
  const logs = captureUsageLogs()
  const cancelled = gate()
  // The staged write's final guard finds the enrollment gone and refuses.
  const staged = onNextRuntimeStage(() => rm(tokenPath, { force: true }))
  loopbackProvider((wire) =>
    keptOpen(healthy(echoOf(wire.bearer)), cancelled, { close: true }),
  )
  const { result } = await run('pi-lastused-staged-guard')
  await native.usagePublications.drain()
  expect(staged.fired()).toBe(true)
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([
    { type: 'text', text: echoOf(vaultAccess(1)) },
  ])
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
  expect(await within(cancelled.wait, 100)).toBe(false)
  await expect(service.vault.authorize('main')).rejects.toThrow()
})

test('Pi lastUsed write that fails on ordinary storage I/O still returns the successful reply', async () => {
  const { native } = await vaultFixture()
  const cancelled = gate()
  const staged = onNextRuntimeStage(async () => {
    throw Object.assign(new Error('synthetic staging write failure'), {
      code: 'EIO',
    })
  })
  const text = `début 🧪 ${echoOf(vaultAccess(1))}`
  loopbackProvider(() => keptOpen(healthy(text), cancelled, { close: true }))
  const { result, deltas } = await run('pi-lastused-io')
  await native.close()
  expect(staged.fired()).toBe(true)
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([{ type: 'text', text }])
  expect(deltas.join('')).toBe(text)
  expect(await within(cancelled.wait, 100)).toBe(false)
})

test('Pi serves first delta and full reply while the roster lock is held, then drains lastUsed before close', async () => {
  const { native, storagePath, client } = await vaultFixture()
  const paths = nativeVaultPaths(await resolveNativePoolPaths(storagePath))
  const locked = gate()
  const release = gate()
  let released = false
  let holder: Promise<unknown> | undefined
  const text = 'début 🧪 served under contention'
  useFetch(async () => {
    holder = mutateVaultRoster(paths.roster, async () => {
      locked.open()
      await release.wait
      released = true
      return { result: undefined }
    })
    lifetimes.trackDetached(holder)
    await locked.wait
    return eventStream(healthy(text))
  })
  const stream = streamCortexKitAnthropic(model, context, {
    sessionId: 'pi-lastused-held-lock',
  })
  let first = false
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      first = true
      expect(released).toBe(false)
    }
  }
  expect(first).toBe(true)
  const result = await stream.result()
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([{ type: 'text', text }])
  expect(released).toBe(false)
  let closed = false
  client.close = () => {
    closed = true
  }
  let disposed = false
  const disposing = Promise.resolve(closePiNativeRuntime(storagePath)).then(
    () => {
      disposed = true
    },
  )
  lifetimes.trackDetached(disposing)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(disposed).toBe(false)
  expect(closed).toBe(false)
  await expect(native.service()).rejects.toThrow('closed')
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
  test(`Pi advisory shutdown ${contended ? 'drops contended bookkeeping without disturbing its holder' : 'persists uncontended lastUsed'}`, async () => {
    const { storagePath } = await vaultFixture()
    const paths = nativeVaultPaths(await resolveNativePoolPaths(storagePath))
    const logs = captureUsageLogs()
    const disk = () =>
      readFile(paths.runtime, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
    const before = await disk()
    const started = Date.now()
    let holder: Awaited<ReturnType<typeof acquireRefreshFileLock>>
    useFetch(async () => {
      if (contended) {
        holder = await acquireRefreshFileLock({
          path: paths.runtime,
          name: 'native-runtime',
          ttlMs: 10_000,
        })
        expect(holder).not.toBeNull()
        deferCleanup(async () => {
          await holder?.release()
        })
      }
      return eventStream(healthy('served before bookkeeping'))
    })
    expect((await run('pi-shutdown-grace')).result.stopReason).toBe('stop')
    const closingAt = performance.now()
    await closePiNativeRuntime(storagePath)
    expect(performance.now() - closingAt).toBeLessThan(1_750)
    const drops = logs.filter(
      (record) =>
        record.message === 'Account usage publications dropped at shutdown',
    )
    if (contended) {
      await holder!.assertOwned()
      expect(await disk()).toBe(before)
      expect(drops).toMatchObject([{ level: 'debug', payload: { count: 1 } }])
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

test('Pi API lastUsed storage failure is detached, drained and warns without changing reply content', async () => {
  const { quotaPauses } = await routingFixture(false)
  const native = getPiNativeRuntime()
  const service = await native.service()
  const logs = captureUsageLogs()
  const entered = gate()
  const release = gate()
  const publication = spyOn(service, 'publishApi').mockImplementation(
    async () => {
      entered.open()
      await release.wait
      throw Object.assign(new Error(`/private/roster/${PAID_KEY}`), {
        name: 'NativeRuntimeError',
        code: 'runtime-io',
      })
    },
  )
  deferCleanup(() => publication.mockRestore())
  const record = routingFetch(
    () => jsonError(429, 'rate_limit_error', MAIN_ACCESS),
    () => usageReading(100, 100),
  )
  const result = await runModel(model.id, 'pi-api-lastused-io')
  expect(record.models).toEqual([`Bearer ${MAIN_ACCESS}`, `Bearer ${PAID_KEY}`])
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([
    { type: 'text', text: 'another route answered' },
  ])
  await entered.wait
  let disposed = false
  const disposing = native.close().then(() => {
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
  expectQuotaPollGaps(quotaPauses)
})

test('Pi runtime eviction drains the evicted instance before closing its native service', async () => {
  const { native, storagePath, service } = await vaultFixture()
  const entered = gate()
  const release = gate()
  let recorded = false
  let closedAfterRecord = false
  const originalClose = service.close.bind(service)
  const closing = spyOn(service, 'close').mockImplementation(() => {
    closedAfterRecord = recorded
    originalClose()
  })
  deferCleanup(() => closing.mockRestore())
  native.usagePublications.publish(async () => {
    entered.open()
    await release.wait
    recorded = true
  })
  await entered.wait
  for (let index = 0; index < 16; index++) {
    const otherPath = `${storagePath}.eviction-${index}`
    getPiNativeRuntime(otherPath)
    deferCleanup(() => closePiNativeRuntime(otherPath))
  }
  expect(closing).not.toHaveBeenCalled()
  release.open()
  await native.close()
  expect(closing).toHaveBeenCalledTimes(1)
  expect(closedAfterRecord).toBe(true)
})

const jsonText = (status: number, type: string, secret: string) =>
  JSON.stringify({
    ...errorEnvelope(type, secret),
    status,
  })

test('Pi retries a real first 401 with the advanced vault receipt after cancelling the rejected body', async () => {
  const { state } = await vaultFixture()
  const cancelled = gate()
  const sent: string[] = []
  loopbackProvider((wire) => {
    sent.push(wire.bearer)
    if (wire.bearer === vaultAccess(1)) {
      state.version = 2
      return keptOpen(
        jsonText(401, 'authentication_error', wire.bearer),
        cancelled,
        { status: 401 },
      )
    }
    return jsonError(400, 'invalid_request_error', wire.bearer)
  })
  await expectError(
    'pi-real-401',
    [vaultAccess(1), vaultAccess(2)],
    ['HTTP 400', 'invalid_request_error'],
  )
  expect(sent).toEqual([vaultAccess(1), vaultAccess(2)])
  expect(state.reports).toEqual([{ recordVersion: 1, providerStatus: 401 }])
  expect(await within(cancelled.wait)).toBe(true)
})

test('Pi reports a final rejected 401 against the retried receipt and keeps its scrubbed error', async () => {
  const { state } = await vaultFixture()
  const sent: string[] = []
  loopbackProvider((wire) => {
    sent.push(wire.bearer)
    if (wire.bearer === vaultAccess(1)) state.version = 2
    return jsonError(401, 'authentication_error', wire.bearer)
  })
  await expectError(
    'pi-real-final-401',
    [vaultAccess(1), vaultAccess(2)],
    ['HTTP 401', 'authentication_error'],
  )
  expect(sent).toEqual([vaultAccess(1), vaultAccess(2)])
  expect(state.reports).toEqual([
    { recordVersion: 1, providerStatus: 401 },
    { recordVersion: 2, providerStatus: 401 },
  ])
})

test('Pi successful reply after a real 401 retry keeps its bytes', async () => {
  const { state } = await vaultFixture()
  const text = `début 🧪 漢字 ${echoOf(vaultAccess(2))}`
  loopbackProvider((wire) => {
    if (wire.bearer === vaultAccess(1)) {
      state.version = 2
      return jsonError(401, 'authentication_error', wire.bearer)
    }
    return eventStream(healthy(text))
  })
  const { result, deltas } = await run('pi-real-401-success')
  expect(result.stopReason).toBe('stop')
  expect(result.content).toEqual([{ type: 'text', text }])
  expect(deltas.join('')).toBe(text)
})

// Headers trim surrounding whitespace, so an echo of a trimmed API key would
// not match its configured spelling. The store refuses such keys; a hand-edited
// padded key fails validation and is never sent. Verify this on the real wire.
const PADDED_KEY = ' opaque-secret-7c32 '

/**
 * Pad the paid key in every stored file. The store refuses to add a padded
 * key, so only a hand-edited file can carry one.
 */
async function padStoredKey(directory: string) {
  const entries = await filesystem.readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })
  let padded = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const text = await filesystem.readFile(path, 'utf8')
    if (!text.includes(PAID_KEY)) continue
    await writeFile(path, text.replaceAll(PAID_KEY, PADDED_KEY))
    padded++
  }
  return padded
}

test('Pi refuses to store a paid key with surrounding whitespace', async () => {
  await expect(paidFixture(PADDED_KEY)).rejects.toThrow(
    'api key must not carry surrounding whitespace',
  )
})

test('Pi never sends a hand-padded stored paid key', async () => {
  const { directory, quotaPauses } = await paidFixture()
  expect(await padStoredKey(directory)).toBeGreaterThan(0)
  const paidRequests: string[] = []
  const models: string[] = []
  loopbackProvider((wire) => {
    if (wire.path.startsWith('/api/oauth/usage'))
      return Response.json({
        five_hour: { utilization: 100 },
        seven_day: { utilization: 100 },
      })
    if (!wire.path.startsWith('/v1/messages'))
      return new Response('{}', { status: 503 })
    models.push(wire.host)
    if (wire.host !== 'paid.invalid')
      return jsonError(429, 'rate_limit_error', wire.bearer)
    paidRequests.push(wire.apiKey || wire.bearer)
    return jsonError(400, 'invalid_request_error', wire.apiKey || wire.bearer)
  })
  // The paid row no longer validates, so the primary's scrubbed 429 stands.
  await expectError(
    'pi-paid-padded',
    [MAIN_ACCESS],
    ['HTTP 429', 'rate_limit_error'],
  )
  expect(models).toEqual(['api.anthropic.com'])
  expect(paidRequests).toEqual([])
  expectQuotaPollGaps(quotaPauses)
})
