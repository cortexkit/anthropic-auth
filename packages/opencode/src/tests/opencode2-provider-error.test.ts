import { expect } from 'bun:test'
import type {
  Attempt,
  ChooseAccountResult,
  HostError,
  OpenCode2AuthAdapter,
  RequestScope,
  SameAccountRetryInput,
} from '@cortexkit/common-auth/opencode2'
import type { TestGate } from '../../../core/src/tests/test-lifetime.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicAdapter,
  type NativeAnthropicAttemptData,
  type NativeAnthropicAuthorization,
  type NativeAnthropicResponseContext,
  type NativeAnthropicSource,
  type NativeAnthropicStreamErrorContext,
  NativeAnthropicTransportRefusal,
} from '../v2/adapter.ts'

// Provider errors can repeat the credential that a send used. These tests drive
// the OpenCode 2 adapter with a synthetic account source and check that every
// error the host or the source classifiers see has that send's own credential
// removed, while successful responses and classification stay unchanged.

const lifetimes = createTestLifetimeSuite()
const test = lifetimes.test

type Provenance = { readonly receipt: string }
type Quota = { readonly reading: string }
type Data = NativeAnthropicAttemptData<Provenance>
type Adapter = OpenCode2AuthAdapter<Quota, Data, ChooseAccountResult>

const UPSTREAM = 'https://api.anthropic.com/v1/messages'
const RELAY = 'https://synthetic-relay.invalid/relay'
// Credentials without a recognizable token prefix: only exact, per-send
// redaction can remove them.
const ACCESS_A = 'synthetic-attempt-a-access-0c4e'
const ACCESS_B = 'synthetic-attempt-b-access-7f19'
const ROTATED = 'synthetic-rotated-access-v2-3a8d'
const API_KEY = 'synthetic-paid-api-key-55e1'
const RELAY_TOKEN = 'synthetic-private-relay-token-9b20'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGlj'
const UNRELATED_BEARER_VALUE = 'synthetic-unrelated-bearer-echo'

const echoOf = (secret: string) =>
  `exact=${secret}; jwt=${JWT}; other=Bearer ${UNRELATED_BEARER_VALUE}`

function expectScrubbed(text: string, secrets: readonly string[]) {
  for (const secret of secrets) expect(text).not.toContain(secret)
  expect(text).not.toContain(JWT)
  expect(text).not.toContain(UNRELATED_BEARER_VALUE)
}

const errorEnvelope = (type: string, secret: string) => ({
  type: 'error',
  error: { type, message: echoOf(secret) },
})

const sse = <T extends { type: string }>(value: T) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`

const successText = (secret: string) =>
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
    delta: { type: 'text_delta', text: `error handling notes: ${secret}` },
  }) +
  sse({ type: 'content_block_stop', index: 0 }) +
  sse({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 1 },
  }) +
  sse({ type: 'message_stop' })

const scopeOf = (sessionID: string) => ({
  phase: 'request' as const,
  providerID: 'anthropic',
  modelID: 'claude-sonnet-4-6',
  sessionID,
  agent: 'build',
  kind: 'primary' as const,
})

function hostRequest(stream = true) {
  return new Request(UPSTREAM, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'opencode-host-placeholder',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16,
      stream,
      messages: [{ role: 'user', content: 'Synthetic provider error probe' }],
    }),
  })
}

interface Seen {
  bodies: string[]
  streamErrors: NativeAnthropicStreamErrorContext<Provenance>[]
  hostErrors: HostError[]
}

/**
 * A synthetic account source whose classifiers read the response body text,
 * the stream error and the host error, recording each input they receive.
 */
function makeSource(
  authorize: (
    scope: RequestScope,
  ) => NativeAnthropicAuthorization<Provenance> | undefined,
) {
  const seen: Seen = { bodies: [], streamErrors: [], hostErrors: [] }
  const source: NativeAnthropicSource<Quota, Provenance> = {
    chooseAccount: () => 'acct',
    authorizeAccount: (scope) => authorize(scope),
    limitFromResponse: async (
      input: NativeAnthropicResponseContext<Provenance> & {
        readonly body: () => Promise<string>
      },
    ) => {
      const body = await input.body()
      seen.bodies.push(body)
      if (body.includes('rate_limit_error'))
        return { reason: 'provider-rate-limit', status: input.status }
      if (body.includes('prompt is too long'))
        return { reason: 'context-overflow', status: input.status }
      return undefined
    },
    limitFromStreamError: (input) => {
      seen.streamErrors.push(input)
      return input.errorType === 'rate_limit_error'
        ? { reason: 'provider-rate-limit', status: 429 }
        : undefined
    },
    limitFromHostError: (error) => {
      seen.hostErrors.push(error)
      return error.status === 429
        ? { reason: 'host-429', status: 429 }
        : undefined
    },
  }
  return { source, seen }
}

function oauthFor(token: string, receipt = token) {
  return (): NativeAnthropicAuthorization<Provenance> => ({
    route: 'oauth',
    accessToken: token,
    credentialId: 'synthetic-credential-row',
    provenance: { receipt },
  })
}

function own(native: NativeAnthropicAdapter<Quota, Provenance>) {
  lifetimes.deferCleanup(() => native.dispose())
  return native
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`)
  return value
}

function isAttemptData(value: unknown): value is Data {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Reflect.get(value, 'route') === 'oauth' ||
      Reflect.get(value, 'route') === 'api') &&
    typeof Reflect.get(value, 'dispatch') === 'string'
  )
}

let attemptSeq = 0
/**
 * Chooses, authorizes and rewrites one send in the order the common-auth
 * OpenCode 2 installer calls these adapter hooks.
 */
async function send(adapter: Adapter, sessionID: string, stream = true) {
  const scope = scopeOf(sessionID)
  const accountId = await adapter.chooseAccount(scope)
  if (typeof accountId !== 'string') throw new Error('no account')
  const result = await adapter.accountHeaders({ ...scope, accountId })
  const data = 'attempt' in result ? result.attempt : undefined
  if (!isAttemptData(data)) throw new Error('adapter returned no attempt data')
  const attempt: Attempt<Data> = {
    ...scope,
    accountId,
    attemptId: `attempt-${++attemptSeq}`,
    transport: 'http',
    data,
  }
  const request = hostRequest(stream)
  const rewritten =
    (await required(
      adapter.rewriteRequest,
      'rewriteRequest',
    )({
      ...attempt,
      request,
      attempt,
    })) ?? request
  return { attempt, data, request: rewritten }
}

async function respond(
  adapter: Adapter,
  sent: Awaited<ReturnType<typeof send>>,
  response: Response,
) {
  const rewritten =
    (await required(
      adapter.rewriteResponse,
      'rewriteResponse',
    )({
      ...sent.attempt,
      request: sent.request,
      response,
      attempt: sent.attempt,
    })) ?? response
  return rewritten
}

function inspect(
  adapter: Adapter,
  sent: Awaited<ReturnType<typeof send>>,
  data: string,
) {
  return required(
    adapter.inspectEvent,
    'inspectEvent',
  )({
    transport: 'http',
    event: 'error',
    data,
    attempt: sent.attempt,
  })
}

/** What the host sees: the body text, or the error its stream read raised. */
async function visibleText(response: Response) {
  try {
    return await response.text()
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return error.message
  }
}

const jsonError = (status: number, type: string, secret: string) =>
  Response.json(errorEnvelope(type, secret), {
    status,
    headers: { 'request-id': 'req_synthetic_oc2' },
  })

test('OC2 OAuth error response and its classifier body omit the send credential', async () => {
  const { source, seen } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-http-error')
  const limit = await required(
    native.adapter.limitFromResponse,
    'limitFromResponse',
  )({
    status: 400,
    headers: new Headers({ 'request-id': 'req_synthetic_oc2' }),
    body: async () =>
      JSON.stringify(errorEnvelope('invalid_request_error', ACCESS_A)),
    attempt: sent.attempt,
  })
  expect(limit).toBeUndefined()
  const body = required(seen.bodies[0], 'classifier body')
  expectScrubbed(body, [ACCESS_A])
  expect(body).toContain('invalid_request_error')

  const response = await respond(
    native.adapter,
    sent,
    jsonError(400, 'invalid_request_error', ACCESS_A),
  )
  expect(response.status).toBe(400)
  const visible = await visibleText(response)
  expectScrubbed(visible, [ACCESS_A])
  expect(visible).toContain('invalid_request_error')
})

test('OC2 usage-limit and overflow bodies classify the same with a credential echo', async () => {
  const { source, seen } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const limitFromResponse = required(
    native.adapter.limitFromResponse,
    'limitFromResponse',
  )
  for (const [status, type, message, expected] of [
    [
      429,
      'rate_limit_error',
      echoOf(ACCESS_A),
      { reason: 'provider-rate-limit', status: 429 },
    ],
    [
      400,
      'invalid_request_error',
      `prompt is too long: ${echoOf(ACCESS_A)}`,
      { reason: 'context-overflow', status: 400 },
    ],
  ] as const) {
    const sent = await send(native.adapter, `ses-parity-${status}`)
    const body = JSON.stringify({ type: 'error', error: { type, message } })
    expect(
      await limitFromResponse({
        status,
        headers: new Headers({ 'request-id': 'req_synthetic_oc2' }),
        body: async () => body,
        attempt: sent.attempt,
      }),
    ).toEqual(expected)
  }
  for (const body of seen.bodies) expectScrubbed(body, [ACCESS_A])
})

test('OC2 stream error verdicts and classifier inputs omit the send credential', async () => {
  const { source, seen } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-stream-error')
  const overloaded = inspect(
    native.adapter,
    sent,
    JSON.stringify(errorEnvelope('overloaded_error', ACCESS_A)),
  )
  const overloadedError = required(overloaded?.error, 'stream verdict')
  expectScrubbed(overloadedError, [ACCESS_A])
  expect(overloadedError).toContain('overloaded_error')
  expect(overloaded?.limit).toBeUndefined()

  const limited = inspect(
    native.adapter,
    sent,
    JSON.stringify(errorEnvelope('rate_limit_error', ACCESS_A)),
  )
  expect(limited?.limit).toEqual({ reason: 'provider-rate-limit', status: 429 })
  expectScrubbed(required(limited?.error, 'rate-limit verdict'), [ACCESS_A])
  for (const input of seen.streamErrors)
    expectScrubbed(input.message ?? '', [ACCESS_A])
  expect(seen.streamErrors.map((input) => input.errorType)).toEqual([
    'overloaded_error',
    'rate_limit_error',
  ])
})

test('OC2 streamed error frames reach the host scrubbed and success frames stay byte-identical', async () => {
  const { source } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const success = await send(native.adapter, 'ses-stream-success')
  const healthy = successText(ACCESS_A)
  const preserved = await respond(
    native.adapter,
    success,
    new Response(healthy, {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_synthetic_oc2',
      },
    }),
  )
  expect(new Uint8Array(await preserved.arrayBuffer())).toEqual(
    new TextEncoder().encode(healthy),
  )

  const failing = await send(native.adapter, 'ses-stream-failure')
  const response = await respond(
    native.adapter,
    failing,
    new Response(sse(errorEnvelope('overloaded_error', ACCESS_A)), {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_synthetic_oc2',
      },
    }),
  )
  const visible = await visibleText(response)
  expectScrubbed(visible, [ACCESS_A])
  expect(visible).toContain('overloaded_error')
})

test('OC2 API-key route errors omit the paid key and its success bytes pass unchanged', async () => {
  const { source } = makeSource(() => ({
    route: 'api',
    headers: { 'x-api-key': API_KEY },
    provenance: { receipt: 'api' },
  }))
  const native = own(createNativeAnthropicAdapter({ source }))
  const failing = await send(native.adapter, 'ses-api-error')
  const response = await respond(
    native.adapter,
    failing,
    jsonError(401, 'authentication_error', API_KEY),
  )
  expect(response.status).toBe(401)
  const visible = await visibleText(response)
  expectScrubbed(visible, [API_KEY])
  expect(visible).toContain('authentication_error')

  const succeeding = await send(native.adapter, 'ses-api-success')
  const healthy = successText(API_KEY)
  const preserved = await respond(
    native.adapter,
    succeeding,
    new Response(healthy, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  )
  expect(await preserved.text()).toBe(healthy)
})

test('OC2 HTTP relay errors omit the upstream credential and the private relay token', async () => {
  const { source } = makeSource(() => ({
    route: 'oauth',
    accessToken: ACCESS_A,
    credentialId: 'synthetic-credential-row',
    provenance: { receipt: 'relay' },
    dispatch: { kind: 'http-relay', url: RELAY, token: RELAY_TOKEN },
  }))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-relay')
  expect(sent.request.url).toBe(RELAY)
  const body = JSON.stringify({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `${echoOf(ACCESS_A)}; relay=${RELAY_TOKEN}`,
    },
  })
  const response = await respond(
    native.adapter,
    sent,
    new Response(body, {
      status: 400,
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_synthetic_relay',
      },
    }),
  )
  expect(response.status).toBe(400)
  const visible = await visibleText(response)
  expectScrubbed(visible, [ACCESS_A, RELAY_TOKEN])
  expect(visible).toContain('invalid_request_error')
})

test('OC2 host errors reach the source classifier without the send credential', async () => {
  const { source, seen } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-host-error')
  const limit = required(native.adapter.limitFromError, 'limitFromError')(
    { type: 'api_error', message: echoOf(ACCESS_A), status: 429 },
    sent.attempt,
  )
  expect(limit).toEqual({ reason: 'host-429', status: 429 })
  const error = required(seen.hostErrors[0], 'host error')
  expect(error.type).toBe('api_error')
  expect(error.status).toBe(429)
  expectScrubbed(error.message, [ACCESS_A])
})

test('OC2 concurrent and retried sends each scrub only with their own credential', async () => {
  const tokens = new Map([
    ['ses-a', ACCESS_A],
    ['ses-b', ACCESS_B],
    ['ses-retry', ROTATED],
  ])
  const { source } = makeSource((scope) => {
    const token = required(tokens.get(scope.sessionID), 'session token')
    return oauthFor(token)()
  })
  const native = own(createNativeAnthropicAdapter({ source }))
  // Both sends are authorized and rewritten before either response arrives,
  // so a shared or most-recent credential would scrub the wrong secret.
  const [first, second] = await Promise.all([
    send(native.adapter, 'ses-a'),
    send(native.adapter, 'ses-b'),
  ])
  const retried = await send(native.adapter, 'ses-retry')
  for (const [sent, token] of [
    [first, ACCESS_A],
    [second, ACCESS_B],
    [retried, ROTATED],
  ] as const) {
    const response = await respond(
      native.adapter,
      sent,
      jsonError(400, 'invalid_request_error', token),
    )
    expectScrubbed(await visibleText(response), [token])
    const verdict = inspect(
      native.adapter,
      sent,
      JSON.stringify(errorEnvelope('overloaded_error', token)),
    )
    expectScrubbed(required(verdict?.error, 'verdict'), [token])
  }
})

test('OC2 public attempt metadata carries no credential or redaction function', async () => {
  const { source } = makeSource(() => ({
    route: 'oauth',
    accessToken: ACCESS_A,
    credentialId: 'synthetic-credential-row',
    provenance: { receipt: 'metadata' },
    dispatch: { kind: 'http-relay', url: RELAY, token: RELAY_TOKEN },
  }))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-metadata')
  expect(Object.keys(sent.data).sort()).toEqual([
    'dispatch',
    'provenance',
    'route',
  ])
  expect(Object.isFrozen(sent.data)).toBe(true)
  const serialized = JSON.stringify(sent.attempt)
  expect(serialized).not.toContain(ACCESS_A)
  expect(serialized).not.toContain(RELAY_TOKEN)
  for (const value of Object.values(sent.data))
    expect(typeof value).not.toBe('function')
})

for (const ending of ['forgotten', 'disposed'] as const) {
  test(`OC2 an error read after its session is ${ending} never exposes the credential`, async () => {
    const { source } = makeSource(oauthFor(ACCESS_A))
    const native = own(createNativeAnthropicAdapter({ source }))
    const sent = await send(native.adapter, `ses-${ending}`)
    if (ending === 'forgotten') native.forgetSession(`ses-${ending}`)
    else native.dispose()
    const response = await respond(
      native.adapter,
      sent,
      jsonError(400, 'invalid_request_error', ACCESS_A),
    )
    expect(response.status).toBe(400)
    expectScrubbed(await visibleText(response), [ACCESS_A])
  })
}

test('OC2 still refuses a WebSocket handshake before anything is sent', async () => {
  const { source } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const scope = scopeOf('ses-websocket')
  expect(() =>
    required(
      native.adapter.rewriteHandshakeURL,
      'rewriteHandshakeURL',
    )({
      ...scope,
      accountId: 'acct',
      url: 'wss://api.anthropic.com/v1/messages',
      attempt: {
        ...scope,
        accountId: 'acct',
        attemptId: 'ws',
        transport: 'ws',
        data: undefined,
      },
    }),
  ).toThrow(NativeAnthropicTransportRefusal)
})

test('OC2 releases a send redactor when the send ends cleanly, is abandoned or is judged', async () => {
  const { source } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const onAttemptEnd = required(native.adapter.onAttemptEnd, 'onAttemptEnd')
  const completed = await send(native.adapter, 'ses-completed')
  const abandoned = await send(native.adapter, 'ses-abandoned')
  const rejected = await send(native.adapter, 'ses-rejected')
  expect(native.heldRedactorCount).toBe(3)
  await onAttemptEnd(completed.attempt, { status: 200, outputStarted: true })
  await onAttemptEnd(abandoned.attempt, {
    outputStarted: false,
    error: { reason: 'abandoned' },
  })
  expect(native.heldRedactorCount).toBe(1)
  // An error status keeps its redactor: the host reads that error after the
  // attempt ends, and the retry hook then judges it.
  await onAttemptEnd(rejected.attempt, { status: 400, outputStarted: false })
  expect(native.heldRedactorCount).toBe(1)
  const response = await respond(
    native.adapter,
    rejected,
    jsonError(400, 'invalid_request_error', ACCESS_A),
  )
  const visible = await visibleText(response)
  expectScrubbed(visible, [ACCESS_A])
  expect(visible).toContain('invalid_request_error')
  required(native.adapter.limitFromError, 'limitFromError')(
    { type: 'api_error', message: visible, status: 400 },
    rejected.attempt,
  )
  expect(native.heldRedactorCount).toBe(0)
})

test('OC2 forgetting a session releases only that session redactors', async () => {
  const tokens = new Map([
    ['ses-kept', ACCESS_A],
    ['ses-forgotten', ACCESS_B],
  ])
  const { source } = makeSource((scope) =>
    oauthFor(required(tokens.get(scope.sessionID), 'session token'))(),
  )
  const native = own(createNativeAnthropicAdapter({ source }))
  const kept = await send(native.adapter, 'ses-kept')
  await send(native.adapter, 'ses-forgotten')
  native.forgetSession('ses-forgotten')
  expect(native.heldRedactorCount).toBe(1)
  const response = await respond(
    native.adapter,
    kept,
    jsonError(400, 'invalid_request_error', ACCESS_A),
  )
  const visible = await visibleText(response)
  expectScrubbed(visible, [ACCESS_A])
  expect(visible).toContain('invalid_request_error')
  native.dispose()
  expect(native.heldRedactorCount).toBe(0)
})

test('OC2 keeps at most the pending-send bound of redactors and an evicted send still never leaks', async () => {
  const tokens = new Map([
    ['ses-oldest', ACCESS_A],
    ['ses-middle', ACCESS_B],
    ['ses-newest', ROTATED],
  ])
  const { source } = makeSource((scope) =>
    oauthFor(required(tokens.get(scope.sessionID), 'session token'))(),
  )
  const native = own(
    createNativeAnthropicAdapter({ source, maxPendingSends: 2 }),
  )
  const oldest = await send(native.adapter, 'ses-oldest')
  await send(native.adapter, 'ses-middle')
  const newest = await send(native.adapter, 'ses-newest')
  expect(native.heldRedactorCount).toBe(2)
  const evicted = await respond(
    native.adapter,
    oldest,
    jsonError(400, 'invalid_request_error', ACCESS_A),
  )
  expectScrubbed(await visibleText(evicted), [ACCESS_A])
  const live = await respond(
    native.adapter,
    newest,
    jsonError(400, 'invalid_request_error', ROTATED),
  )
  const visible = await visibleText(live)
  expectScrubbed(visible, [ROTATED])
  expect(visible).toContain('invalid_request_error')
})

test('OC2 a stream rate limit still classifies after its send redactor was released', async () => {
  const { source } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-late-limit')
  native.forgetSession('ses-late-limit')
  const verdict = inspect(
    native.adapter,
    sent,
    JSON.stringify(errorEnvelope('rate_limit_error', ACCESS_A)),
  )
  expect(verdict?.limit).toEqual({ reason: 'provider-rate-limit', status: 429 })
  expectScrubbed(required(verdict?.error, 'late verdict'), [ACCESS_A])
})

test('OC2 an unknown error type that repeats the credential is never kept verbatim', async () => {
  // This credential resembles an error type name. Syntax alone must not
  // let it bypass credential scrubbing.
  const opaque = 'synthetic_opaque_lowercase_access'
  const { source, seen } = makeSource(oauthFor(opaque))
  const native = own(createNativeAnthropicAdapter({ source }))
  const live = await send(native.adapter, 'ses-type-live')
  const released = await send(native.adapter, 'ses-type-released')
  native.forgetSession('ses-type-released')
  const frame = JSON.stringify({
    type: 'error',
    error: { type: opaque, message: 'synthetic failure' },
  })
  for (const sent of [live, released]) {
    const verdict = inspect(native.adapter, sent, frame)
    expect(required(verdict?.error, 'verdict')).not.toContain(opaque)
  }
  for (const input of seen.streamErrors)
    expect(input.errorType ?? '').not.toContain(opaque)
})

test('OC2 a send releases its credentials when its response body ends or is cancelled', async () => {
  const { source } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const failed = await send(native.adapter, 'ses-body-eof')
  const streamed = await send(native.adapter, 'ses-body-success')
  const cancelled = await send(native.adapter, 'ses-body-cancel')
  expect(native.heldRedactorCount).toBe(3)

  const rejected = await respond(
    native.adapter,
    failed,
    jsonError(400, 'invalid_request_error', ACCESS_A),
  )
  expectScrubbed(await visibleText(rejected), [ACCESS_A])
  await Bun.sleep(0)
  expect(native.heldRedactorCount).toBe(2)

  const healthy = successText(ACCESS_A)
  const preserved = await respond(
    native.adapter,
    streamed,
    new Response(healthy, {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_synthetic_oc2',
      },
    }),
  )
  expect(await preserved.text()).toBe(healthy)
  await Bun.sleep(0)
  expect(native.heldRedactorCount).toBe(1)

  const abandoned = await respond(
    native.adapter,
    cancelled,
    new Response(healthy, {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_synthetic_oc2',
      },
    }),
  )
  await abandoned.body?.cancel()
  await Bun.sleep(0)
  expect(native.heldRedactorCount).toBe(0)
})

test('OC2 the retry hook after release sees only safe metadata recorded during the send', async () => {
  const { source, seen } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-late-host-error')
  const verdict = inspect(
    native.adapter,
    sent,
    JSON.stringify(errorEnvelope('overloaded_error', ACCESS_A)),
  )
  native.forgetSession('ses-late-host-error')
  expect(native.heldRedactorCount).toBe(0)
  const limit = required(native.adapter.limitFromError, 'limitFromError')(
    {
      type: 'api_error',
      message: `host-only text ${ACCESS_A}`,
      status: 429,
    },
    sent.attempt,
  )
  expect(limit).toEqual({ reason: 'host-429', status: 429 })
  const error = required(seen.hostErrors[0], 'host error')
  expect(error.message).toBe(required(verdict?.error, 'verdict'))
  expect(error.message).not.toContain('host-only text')
  expectScrubbed(error.message, [ACCESS_A])
})

for (const contentType of ['text/plain', undefined] as const) {
  const name = contentType ?? 'no content type'
  // A stream body, so the runtime adds no content type of its own.
  const untyped = (text: string) => {
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
          'request-id': 'req_synthetic_oc2',
        },
      },
    )
  }

  test(`OC2 streamed error served as ${name} is scrubbed because the request streamed`, async () => {
    const { source } = makeSource(oauthFor(ACCESS_A))
    const native = own(createNativeAnthropicAdapter({ source }))
    const sent = await send(native.adapter, `ses-untyped-${name}`)
    const response = await respond(
      native.adapter,
      sent,
      untyped(sse(errorEnvelope('overloaded_error', ACCESS_A))),
    )
    const visible = await visibleText(response)
    expectScrubbed(visible, [ACCESS_A])
    expect(visible).toContain('overloaded_error')
  })

  test(`OC2 successful stream served as ${name} stays byte-identical`, async () => {
    const { source } = makeSource(oauthFor(ACCESS_A))
    const native = own(createNativeAnthropicAdapter({ source }))
    const sent = await send(native.adapter, `ses-untyped-ok-${name}`)
    const healthy = successText(ACCESS_A)
    const response = await respond(native.adapter, sent, untyped(healthy))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new TextEncoder().encode(healthy),
    )
  })
}

/** A body served as a stream, with a plain-text or missing content type. */
function lateBody(text: string, contentType: 'text/plain' | undefined) {
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
        'request-id': 'req_synthetic_oc2',
      },
    },
  )
}

// After session removal or maxPendingSends eviction clears the copied secrets,
// a late response still uses its request's mode. Streamed error frames stay
// hidden from the host regardless of the response's content type.
for (const contentType of ['text/plain', undefined] as const) {
  const name = contentType ?? 'no content type'
  for (const ending of ['forgotten', 'evicted'] as const) {
    test(`OC2 a late streamed error served as ${name} after the send was ${ending} never exposes the credential`, async () => {
      const { source } = makeSource(oauthFor(ACCESS_A))
      const native = own(
        createNativeAnthropicAdapter({ source, maxPendingSends: 1 }),
      )
      const sent = await send(native.adapter, `ses-late-${ending}`)
      if (ending === 'forgotten') native.forgetSession(`ses-late-${ending}`)
      else await send(native.adapter, 'ses-late-newer')
      const response = await respond(
        native.adapter,
        sent,
        lateBody(sse(errorEnvelope('overloaded_error', ACCESS_A)), contentType),
      )
      expectScrubbed(await visibleText(response), [ACCESS_A])
    })
  }
}

test('OC2 a late non-streaming success larger than one stream frame stays byte-identical', async () => {
  const { source } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-late-http', false)
  native.forgetSession('ses-late-http')
  // Larger than the 8 MiB stream frame bound, so stream framing would fail.
  const body = JSON.stringify({
    id: 'msg_synthetic',
    type: 'message',
    content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }],
  })
  const response = await respond(
    native.adapter,
    sent,
    new Response(body, {
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_synthetic_oc2',
      },
    }),
  )
  expect(await response.text()).toBe(body)
})

// Late non-2xx status text and headers can echo credentials too. Remove those
// echoes, retaining the status and retry values checkable without the secret.
for (const ending of ['forgotten', 'evicted'] as const)
  for (const stream of [true, false]) {
    test(`OC2 a late 401 for a ${stream ? 'streamed' : 'non-streaming'} request after the send was ${ending} withholds the credential from status text and headers`, async () => {
      const { source } = makeSource(oauthFor(ACCESS_A))
      const native = own(
        createNativeAnthropicAdapter({ source, maxPendingSends: 1 }),
      )
      const sent = await send(native.adapter, `ses-late-401-${ending}`, stream)
      if (ending === 'forgotten') native.forgetSession(`ses-late-401-${ending}`)
      else await send(native.adapter, 'ses-late-401-newer')
      const response = await respond(
        native.adapter,
        sent,
        Response.json(errorEnvelope('authentication_error', ACCESS_A), {
          status: 401,
          statusText: ACCESS_A,
          headers: {
            'x-opaque-error': ACCESS_A,
            'request-id': 'req_synthetic_oc2',
            'retry-after': '7',
          },
        }),
      )
      const headers = Object.fromEntries(response.headers)
      expect(response.status).toBe(401)
      expect(response.statusText).not.toContain(ACCESS_A)
      for (const value of Object.values(headers))
        expect(value).not.toContain(ACCESS_A)
      // Only header values that can be verified without the credential remain,
      // such as the retry delay.
      expect(headers['retry-after']).toBe('7')
      expect(headers['x-opaque-error']).toBeUndefined()
      expectScrubbed(await visibleText(response), [ACCESS_A])
    })
  }

// A configured key with surrounding whitespace leaves without it, because
// setting a header trims the value. The provider echoes what it received.
const PADDED_KEY = ' opaque-secret-7c32 '
const SENT_KEY = PADDED_KEY.trim()

test('OC2 API-key error and classifier body omit the key value actually sent on the wire', async () => {
  const { source, seen } = makeSource(() => ({
    route: 'api',
    headers: { 'x-api-key': PADDED_KEY },
    provenance: { receipt: 'api' },
  }))
  const native = own(createNativeAnthropicAdapter({ source }))
  const received: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const key = request.headers.get('x-api-key') ?? ''
      received.push(key)
      return jsonError(400, 'invalid_request_error', key)
    },
  })
  lifetimes.deferCleanup(() => server.stop(true))
  const sent = await send(native.adapter, 'ses-api-padded')
  const target = new URL(sent.request.url)
  const physical = await fetch(
    new Request(
      `http://127.0.0.1:${server.port}${target.pathname}${target.search}`,
      sent.request,
    ),
  )
  expect(received).toEqual([SENT_KEY])
  const echoed = await physical.clone().text()
  expect(echoed).toContain(SENT_KEY)
  expect(echoed).not.toContain(PADDED_KEY)

  await required(
    native.adapter.limitFromResponse,
    'limitFromResponse',
  )({
    status: physical.status,
    headers: physical.headers,
    body: () => physical.clone().text(),
    attempt: sent.attempt,
  })
  const body = required(seen.bodies[0], 'classifier body')
  expectScrubbed(body, [SENT_KEY])
  expect(body).toContain('invalid_request_error')

  const response = await respond(native.adapter, sent, physical)
  expect(response.status).toBe(400)
  const visible = await visibleText(response)
  expectScrubbed(visible, [SENT_KEY])
  expect(visible).toContain('invalid_request_error')
})

test('OC2 API-key success sent with a padded configured key passes byte for byte', async () => {
  const { source } = makeSource(() => ({
    route: 'api',
    headers: { 'x-api-key': PADDED_KEY },
    provenance: { receipt: 'api' },
  }))
  const native = own(createNativeAnthropicAdapter({ source }))
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return new Response(successText(request.headers.get('x-api-key') ?? ''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  lifetimes.deferCleanup(() => server.stop(true))
  const sent = await send(native.adapter, 'ses-api-padded-success')
  const target = new URL(sent.request.url)
  const physical = await fetch(
    new Request(
      `http://127.0.0.1:${server.port}${target.pathname}${target.search}`,
      sent.request,
    ),
  )
  const response = await respond(native.adapter, sent, physical)
  expect(await response.text()).toBe(successText(SENT_KEY))
})

/**
 * Send `request` to a real loopback server and return its response. When
 * `cancelled` is given, the response body is handed back behind a
 * pass-through whose cancel opens that gate, because Bun 1.3 does not tell
 * the server when a client cancels a fetch body.
 */
async function overLoopback(
  request: Request,
  serve: (request: Request) => Response | Promise<Response>,
  cancelled?: TestGate,
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // A kept-open body must stay open until the client cancels it.
    idleTimeout: 0,
    fetch: serve,
  })
  lifetimes.deferCleanup(() => server.stop(true))
  const target = new URL(request.url)
  const response = await fetch(
    new Request(
      `http://127.0.0.1:${server.port}${target.pathname}${target.search}`,
      request,
    ),
  )
  const source = response.body
  if (!cancelled || !source) return response
  const reader = source.getReader()
  // Teardown opens the lifetime gate created below before it waits for the test body, so a read
  // still waiting on the real HTTP response is released rather than joined.
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

/** True when `wait` settles within the bound, false when it does not. */
async function within(wait: Promise<unknown>, ms = 2_000) {
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

const bearerOf = (request: Request) =>
  (request.headers.get('authorization') ?? '').replace(/^Bearer /, '')

// Prime rewrites a failed response first and then lets the classifier read
// that rewritten body, whose response scope ends when the read reaches the
// end. The host installer classifies the raw body before rewriting it.
const classified = [
  [
    429,
    'rate_limit_error',
    'limit',
    { reason: 'provider-rate-limit', status: 429 },
  ],
  [
    400,
    'invalid_request_error',
    'prompt is too long: 250000 tokens',
    { reason: 'context-overflow', status: 400 },
  ],
] as const

for (const [status, type, detail, expected] of classified) {
  const failure = (request: Request) =>
    Response.json(
      {
        type: 'error',
        error: { type, message: `${detail}; ${echoOf(bearerOf(request))}` },
      },
      { status, headers: { 'request-id': 'req_synthetic_oc2' } },
    )

  test(`OC2 classifier reading the rewritten ${status} body after its scope ends keeps the scrubbed text`, async () => {
    const { source, seen } = makeSource(oauthFor(ACCESS_A))
    const native = own(createNativeAnthropicAdapter({ source }))
    const sent = await send(native.adapter, `ses-post-rewrite-${status}`)
    const physical = await overLoopback(sent.request, failure)
    const rewritten = await respond(native.adapter, sent, physical)
    const limit = await required(
      native.adapter.limitFromResponse,
      'limitFromResponse',
    )({
      status: rewritten.status,
      headers: rewritten.headers,
      body: () => rewritten.clone().text(),
      attempt: sent.attempt,
    })
    const body = required(seen.bodies[0], 'classifier body')
    expectScrubbed(body, [ACCESS_A])
    expect(body).toContain(detail)
    expect(limit).toEqual(expected)
  })

  test(`OC2 classifier reading the raw ${status} body before the rewrite scrubs it`, async () => {
    const { source, seen } = makeSource(oauthFor(ACCESS_A))
    const native = own(createNativeAnthropicAdapter({ source }))
    const sent = await send(native.adapter, `ses-pre-rewrite-${status}`)
    const physical = await overLoopback(sent.request, failure)
    const limit = await required(
      native.adapter.limitFromResponse,
      'limitFromResponse',
    )({
      status: physical.status,
      headers: physical.headers,
      body: () => physical.clone().text(),
      attempt: sent.attempt,
    })
    const body = required(seen.bodies[0], 'classifier body')
    expect(await physical.clone().text()).toContain(ACCESS_A)
    expectScrubbed(body, [ACCESS_A])
    expect(body).toContain(detail)
    expect(limit).toEqual(expected)
    const visible = await visibleText(
      await respond(native.adapter, sent, physical),
    )
    expectScrubbed(visible, [ACCESS_A])
  })
}

test('OC2 classifier gets raw text redacted when only a copy of the rewritten headers is presented', async () => {
  const { source, seen } = makeSource(oauthFor(ACCESS_A))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-copied-headers')
  const physical = await overLoopback(sent.request, (request) =>
    jsonError(400, 'invalid_request_error', bearerOf(request)),
  )
  const raw = await physical.clone().text()
  expect(raw).toContain(ACCESS_A)
  const rewritten = await respond(native.adapter, sent, physical)
  // EOF clears the copied credentials held for this send's error redaction.
  await rewritten.text()
  await required(
    native.adapter.limitFromResponse,
    'limitFromResponse',
  )({
    status: rewritten.status,
    headers: new Headers(rewritten.headers),
    body: async () => raw,
    attempt: sent.attempt,
  })
  const body = required(seen.bodies[0], 'classifier body')
  expectScrubbed(body, [ACCESS_A])
})

test('OC2 classifier reading a late failed response whose credentials were evicted sees only the withheld projection', async () => {
  const { source, seen } = makeSource(oauthFor(ACCESS_A))
  const native = own(
    createNativeAnthropicAdapter({ source, maxPendingSends: 1 }),
  )
  const evicted = await send(native.adapter, 'ses-evicted')
  // maxPendingSends is 1: the second send clears the first send's copied secrets.
  await send(native.adapter, 'ses-evicting')
  const physical = await overLoopback(evicted.request, (request) =>
    jsonError(429, 'rate_limit_error', bearerOf(request)),
  )
  const rewritten = await respond(native.adapter, evicted, physical)
  const limit = await required(
    native.adapter.limitFromResponse,
    'limitFromResponse',
  )({
    status: rewritten.status,
    headers: rewritten.headers,
    body: () => rewritten.clone().text(),
    attempt: evicted.attempt,
  })
  const body = required(seen.bodies[0], 'classifier body')
  expectScrubbed(body, [ACCESS_A])
  // Only the provider's error type survives; its message is withheld.
  expect(body).not.toContain('exact=')
  expect(body).toContain('withheld')
  expect(limit).toEqual({ reason: 'provider-rate-limit', status: 429 })
})

test('OC2 relay-local 401 cancels the physical body and retires its credentials before the fixed 502', async () => {
  const { source } = makeSource(() => ({
    route: 'oauth',
    accessToken: ACCESS_A,
    credentialId: 'synthetic-credential-row',
    provenance: { receipt: 'relay' },
    dispatch: { kind: 'http-relay', url: RELAY, token: RELAY_TOKEN },
  }))
  const native = own(createNativeAnthropicAdapter({ source }))
  const sent = await send(native.adapter, 'ses-relay-401')
  const cancelled = lifetimes.gate()
  const relayed: string[] = []
  const physical = await overLoopback(
    sent.request,
    async (request) => {
      relayed.push(String(request.headers.get('x-relay-token')))
      // No Anthropic request-id: the relay itself refused the request.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `{"error":"relay refused ${RELAY_TOKEN} ${ACCESS_A}"`,
              ),
            )
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    },
    cancelled,
  )
  expect(relayed).toEqual([RELAY_TOKEN])
  const response = await respond(native.adapter, sent, physical)
  expect(response.status).toBe(502)
  const visible = await visibleText(response)
  expect(visible).toContain('Relay authentication failed')
  expectScrubbed(visible, [ACCESS_A, RELAY_TOKEN])
  expect(await within(cancelled.wait)).toBe(true)
  // The 401 cleared this send's copied secrets. A later response cannot be
  // redacted precisely, so only a generic failure is exposed.
  const late = await respond(
    native.adapter,
    sent,
    new Response(`late ${echoOf(ACCESS_A)}`, {
      status: 400,
      headers: { 'request-id': 'req_synthetic_late' },
    }),
  )
  const lateText = await visibleText(late)
  expectScrubbed(lateText, [ACCESS_A])
  expect(lateText).not.toContain('late exact=')
})

test('OC2 same-account recovery and release keep scope and limit without forwarding raw host errors', async () => {
  const retried: SameAccountRetryInput[] = []
  const dropped: SameAccountRetryInput[] = []
  const { source } = makeSource(oauthFor(ACCESS_A))
  const native = own(
    createNativeAnthropicAdapter({
      source: {
        ...source,
        retrySameAccount(input) {
          retried.push(input)
          return { accountId: input.accountId }
        },
        dropSameAccountRetry(input) {
          dropped.push(input)
        },
      },
    }),
  )
  await send(native.adapter, 'same-account-error')
  const input: SameAccountRetryInput = {
    ...scopeOf('same-account-error'),
    accountId: 'acct',
    attempt: 1,
    error: { type: ACCESS_A, message: echoOf(ACCESS_A), status: 401 },
    limit: { reason: 'local-newer:prepared', status: 401 },
  }
  const result = required(
    await required(native.adapter.retrySameAccount, 'retrySameAccount')(input),
    'same-account recovery',
  )
  await required(
    native.adapter.dropSameAccountRetry,
    'dropSameAccountRetry',
  )({ ...input, ...result })
  expect(retried).toEqual([
    {
      ...input,
      error: {
        type: 'provider_error',
        message: 'provider request failed',
        status: 401,
      },
    },
  ])
  expect(dropped).toEqual(retried)
  expectScrubbed(JSON.stringify({ retried, dropped }), [ACCESS_A])
})
