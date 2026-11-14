import { heapStats } from 'bun:jsc'
import { expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import {
  createProviderErrorRedactor,
  PROVIDER_ERROR_OVERSIZED_MESSAGE,
  PROVIDER_ERROR_REDACTION,
} from '../provider-error.ts'
import {
  type RelayAttemptAuthorization,
  type RelayConfig,
  sendViaRelay,
} from '../relay.ts'
import {
  createTestLifetimeSuite,
  type TestGate,
  TestLifetime,
} from './test-lifetime.ts'

const { test, gate, trackDetached, deferCleanup } = createTestLifetimeSuite()

/**
 * Fixture teardown hooks for the running test. Teardown-order tests supply
 * their own TestLifetime so they can trigger and inspect its finish.
 */
type FixtureLifetime = {
  gate(): TestGate
  trackDetached(work: Promise<unknown>): void
}
const suiteLifetime: FixtureLifetime = { gate, trackDetached }

// Opaque credentials: none of them has a shape (Bearer prefix, sk- key, JWT)
// that the redactor's generic patterns would catch, so only exact
// per-attempt matching can remove them from echoed provider errors.
const RELAY_TOKEN = 'opaqueRelayTransportToken0123456789'
const V0 = 'opaqueAttemptCredentialV0yzabcdefghij'
const V1 = 'opaqueAttemptCredentialV1abcdefghijkl'
const V2 = 'opaqueAttemptCredentialV2mnopqrstuvwx'
const sessionOf = (token: string) => `opaqueSessionBinding${token.slice(-12)}`

const encoder = new TextEncoder()

type SentPayload = {
  id?: string
  mode: string
  body?: string
  upstream: { url?: string; method?: string; headers: Record<string, string> }
}

function readPayload(text: string): SentPayload {
  return JSON.parse(text) as SentPayload
}

function config(url: string, transport: 'http' | 'websocket'): RelayConfig {
  return {
    enabled: true,
    url,
    token: RELAY_TOKEN,
    fallbackToDirect: false,
    transport,
  }
}

const requestBody = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: `${'x'.repeat(2000)}${suffix}` }],
  })
/** A model request asking for a streamed (event-stream) response. */
const streamingBody = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    stream: true,
    messages: [{ role: 'user', content: `${'x'.repeat(2000)}${suffix}` }],
  })

type WsScript = (
  socket: ServerWebSocket<undefined>,
  payload: SentPayload,
  index: number,
) => void
type HttpScript = (
  payload: SentPayload,
  index: number,
) => Response | Promise<Response>

/**
 * Loopback relay owned by the calling test body. Its shutdown waits on a
 * gate created inside the body before the body awaits any relay I/O. Test
 * teardown opens every such gate, so if the body hangs on the relay, the
 * shutdown closes the relay's sockets and the hung read in the body settles.
 * Each socket's close callback and each HTTP handler are awaited
 * individually. `close` runs the same shutdown on demand.
 */
function startRelay(
  script: { ws?: WsScript; http?: HttpScript },
  life: FixtureLifetime = suiteLifetime,
) {
  const sent: SentPayload[] = []
  const sockets = new Map<ServerWebSocket<undefined>, Promise<void>>()
  const closers = new Map<ServerWebSocket<undefined>, () => void>()
  const handlers: Promise<unknown>[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, owner) => {
      if (request.headers.get('upgrade') === 'websocket')
        return owner.upgrade(request)
          ? undefined
          : new Response('upgrade failed', { status: 500 })
      const handled = (async () => {
        const payload = readPayload(await request.text())
        sent.push(payload)
        if (!script.http)
          return new Response('unexpected HTTP relay', { status: 500 })
        return script.http(payload, sent.length - 1)
      })()
      handlers.push(handled)
      return handled
    },
    websocket: {
      open(socket) {
        sockets.set(
          socket,
          new Promise<void>((resolve) => closers.set(socket, resolve)),
        )
        socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null }))
      },
      message(socket, data) {
        const payload = readPayload(String(data))
        sent.push(payload)
        script.ws?.(socket, payload, sent.length - 1)
      },
      close(socket) {
        closers.get(socket)?.()
      },
    },
  })
  let stopping: Promise<void> | undefined
  const stop = () => {
    stopping ??= (async () => {
      // Bun can leave stop pending after upgraded sockets close. In that case,
      // join each socket's close callback and HTTP handler instead. An HTTP-only
      // server has no such residual, so its stop promise is joined too.
      const closes = [...sockets.values()]
      const stopped = server.stop(true)
      const results = await Promise.allSettled([
        ...closes,
        ...handlers,
        ...(closes.length ? [] : [stopped]),
      ])
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length)
        throw new AggregateError(failures, 'Loopback relay shutdown failed')
    })()
    return stopping
  }
  const shutdown = life.gate()
  life.trackDetached(shutdown.wait.then(stop))
  return { url: server.url.href, sent, close: stop }
}

function sseFrame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } }
}

/** Send bytes alternately as binary frames and base64 `chunk` messages. */
function sendChunks(
  socket: ServerWebSocket<undefined>,
  id: string | undefined,
  pieces: Uint8Array[],
) {
  pieces.forEach((piece, index) => {
    if (index % 2 === 0) socket.send(piece)
    else
      socket.send(
        JSON.stringify({
          type: 'chunk',
          id,
          base64: Buffer.from(piece).toString('base64'),
        }),
      )
  })
}

function splitAt(bytes: Uint8Array, offsets: number[]) {
  const pieces: Uint8Array[] = []
  let start = 0
  for (const offset of [...offsets, bytes.byteLength]) {
    pieces.push(bytes.slice(start, offset))
    start = offset
  }
  return pieces
}

function startResponse(
  socket: ServerWebSocket<undefined>,
  id: string | undefined,
  status: number,
  headers: Record<string, string>,
) {
  socket.send(JSON.stringify({ type: 'response_start', id, status, headers }))
}

function authorizer(
  tokens: string[],
  withErrorSecrets: boolean,
  refs?: WeakRef<object>[],
) {
  const observed: Array<[number, number]> = []
  let calls = 0
  const authorize = async (): Promise<RelayAttemptAuthorization> => {
    const attempt = ++calls
    const token = tokens[attempt - 1]
    if (token === undefined) throw new Error('Unexpected relay authorization')
    const authorization: RelayAttemptAuthorization = {
      headers: new Headers({
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      }),
      ...(withErrorSecrets ? { errorSecrets: [token, sessionOf(token)] } : {}),
      onUpstreamStatus: (status) => {
        observed.push([attempt, status])
      },
    }
    refs?.push(new WeakRef(authorization))
    return authorization
  }
  return { authorize, observed, calls: () => calls }
}

async function send(options: {
  relay: { url: string }
  /** Upstream URL the relay forwards to; the Anthropic URL when omitted. */
  input?: string
  transport: 'http' | 'websocket'
  authorize: () => Promise<RelayAttemptAuthorization>
  optimistic?: boolean
  affinity?: string
  suffix?: string
  body?: string
  onResponseHeaders?: (headers: Headers) => void
}) {
  return sendViaRelay({
    config: config(options.relay.url, options.transport),
    input: options.input ?? 'https://api.anthropic.com/v1/messages',
    init: { method: 'POST' },
    headers: new Headers(),
    body: options.body ?? requestBody(options.suffix ?? 'first'),
    affinity: options.affinity ?? randomUUID(),
    optimisticResponse: options.optimistic === true,
    fallback: async () => {
      throw new Error('Unexpected direct fallback')
    },
    authorizeAttempt: options.authorize,
    onResponseHeaders: options.onResponseHeaders,
  })
}

/**
 * Precondition for optimistic tests: the relay really answered with its
 * synthetic event stream rather than waiting for the upstream response.
 */
function expectOptimistic(response: Response) {
  expect(response.status).toBe(200)
  expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
}

const REQUEST_ID_V2 = 'req_relay_reconnected'
const successPrefix = sseFrame('message_start', {
  type: 'message_start',
  message: { id: 'msg_relay', content: [] },
})
const echoFor = (token: string) =>
  anthropicError(
    'authentication_error',
    `invalid credential ${token} via relay ${RELAY_TOKEN}`,
  )
const scrubbedEcho = anthropicError(
  'authentication_error',
  `invalid credential ${PROVIDER_ERROR_REDACTION} via relay ${PROVIDER_ERROR_REDACTION}`,
)

for (const [name, tokens, withErrorSecrets] of [
  ['v1 then v2 from errorSecrets', [V1, V2], true],
  ['v1 then v1 from the protocol header', [V1, V1], false],
] as const) {
  test(`optimistic WebSocket reconnect scrubs the terminal error with the credential the retry sent (${name})`, async () => {
    const reconnected = tokens[1]
    const errorFrame = sseFrame('error', echoFor(reconnected))
    const relay = startRelay({
      ws: (socket, payload, index) => {
        // The first physical attempt dies before any upstream byte.
        if (index === 0) return socket.close(1011, 'interrupted')
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
          'request-id': REQUEST_ID_V2,
        })
        const bytes = encoder.encode(successPrefix + errorFrame)
        // Cut inside the echoed credential, once as a binary frame and once
        // as a base64 chunk, so the scope must join both chunk kinds.
        const cut = successPrefix.length + errorFrame.indexOf(reconnected) + 7
        sendChunks(socket, payload.id, splitAt(bytes, [9, cut]))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([...tokens], withErrorSecrets)
    const harvested: Array<string | null> = []
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body: streamingBody('first'),
      authorize: auth.authorize,
      onResponseHeaders: (headers) => harvested.push(headers.get('request-id')),
    })
    expectOptimistic(response)
    const text = await response.text()

    expect(text).toBe(successPrefix + sseFrame('error', scrubbedEcho))
    expect(text).not.toContain(V1)
    expect(text).not.toContain(V2)
    expect(text).not.toContain(RELAY_TOKEN)
    expect(
      relay.sent.map((payload) => payload.upstream.headers.authorization),
    ).toEqual(tokens.map((token) => `Bearer ${token}`))
    expect(auth.calls()).toBe(2)
    expect(auth.observed).toEqual([[2, 200]])
    expect(harvested).toEqual([REQUEST_ID_V2])
    // A host-side redactor snapshotted with the first credential cannot
    // recognize what the reconnect sent.
    const hostSnapshot = createProviderErrorRedactor([tokens[0], RELAY_TOKEN])
    const snapshotView = hostSnapshot.redactText(errorFrame)
    hostSnapshot.dispose()
    if (tokens[0] === tokens[1]) expect(snapshotView).not.toContain(V1)
    else expect(snapshotView).toContain(V2)
  })
}

for (const optimistic of [true, false]) {
  test(`successful WebSocket stream bytes pass through exactly (optimistic=${optimistic})`, async () => {
    const upstream = encoder.encode(
      successPrefix +
        sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: `an error about ${V1} in ünïcødé text`,
          },
        }) +
        `: heartbeat mentioning error ${V1}\r\n\r\n` +
        sseFrame('message_stop', { type: 'message_stop' }) +
        // Unterminated tail: only an end-of-stream flush delivers it.
        `event: ping\ndata: {"type":"ping"}`,
    )
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        const multibyte = Buffer.from(upstream).indexOf('ü') + 1
        sendChunks(
          socket,
          payload.id,
          splitAt(upstream, [3, 40, multibyte, multibyte + 30, multibyte + 90]),
        )
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic,
      body: streamingBody('first'),
      authorize: auth.authorize,
    })
    if (optimistic) expectOptimistic(response)
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
    expect(auth.observed).toEqual([[1, 200]])
  })
}

test('HTTP patch recovery scrubs the final response with exactly the reauthorized credential', async () => {
  const relay = startRelay({
    http: (payload, index) => {
      if (index === 0)
        return new Response('ok', {
          headers: { 'request-id': 'req_first', 'content-type': 'text/plain' },
        })
      if (index === 1)
        return new Response(`state mismatch for ${V1}`, { status: 409 })
      return Response.json(
        anthropicError(
          'authentication_error',
          `rejected ${V2} session ${sessionOf(V2)} relay ${RELAY_TOKEN} earlier ${V1}`,
        ),
        {
          status: 401,
          headers: { 'request-id': 'req_final', 'x-echo': `credential ${V2}` },
        },
      )
    },
  })
  const auth = authorizer([V0, V1, V2], true)
  const harvested: Array<string | null> = []
  const affinity = randomUUID()
  const sendHttp = (suffix: string) =>
    send({
      relay,
      transport: 'http',
      affinity,
      suffix,
      authorize: auth.authorize,
      onResponseHeaders: (headers) => harvested.push(headers.get('request-id')),
    })
  expect(await (await sendHttp('first')).text()).toBe('ok')
  const response = await sendHttp('second')
  expect(response.status).toBe(401)
  expect(response.headers.get('request-id')).toBe('req_final')
  expect(response.headers.get('x-echo')).toBe(
    `credential ${PROVIDER_ERROR_REDACTION}`,
  )
  // The final attempt sent only V2 (plus its session binding and the relay
  // token). V1 belonged to the abandoned patch attempt, so the final
  // attempt's scope does not know it: there is no cache of earlier
  // credentials, only the exact physical attempt.
  expect(await response.text()).toBe(
    JSON.stringify(
      anthropicError(
        'authentication_error',
        `rejected ${PROVIDER_ERROR_REDACTION} session ${PROVIDER_ERROR_REDACTION} relay ${PROVIDER_ERROR_REDACTION} earlier ${V1}`,
      ),
    ),
  )
  expect(relay.sent.map((payload) => payload.mode)).toEqual([
    'full_sync',
    'patch',
    'full_sync',
  ])
  expect(
    relay.sent.map((payload) => payload.upstream.headers.authorization),
  ).toEqual([`Bearer ${V0}`, `Bearer ${V1}`, `Bearer ${V2}`])
  expect(auth.observed).toEqual([
    [1, 200],
    [3, 401],
  ])
  expect(harvested).toEqual(['req_first', 'req_final'])
})

test('a successful non-stream HTTP relay body is passed through untouched', async () => {
  const body = `{"id":"msg_ok","content":[{"type":"text","text":"error ${V1}"}]}`
  const relay = startRelay({
    http: () =>
      new Response(body, {
        headers: { 'content-type': 'application/json', 'request-id': 'req_ok' },
      }),
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'http',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('request-id')).toBe('req_ok')
  expect(await response.text()).toBe(body)
})

test('non-optimistic WebSocket error responses are scrubbed with the live attempt', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 401, {
        'content-type': 'application/json',
        'request-id': 'req_ws_401',
        'x-echo': `credential ${V1}`,
      })
      const bytes = encoder.encode(JSON.stringify(echoFor(V1)))
      sendChunks(socket, payload.id, splitAt(bytes, [30]))
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(401)
  expect(response.headers.get('request-id')).toBe('req_ws_401')
  expect(response.headers.get('x-echo')).toBe(
    `credential ${PROVIDER_ERROR_REDACTION}`,
  )
  expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
  expect(auth.observed).toEqual([[1, 401]])
})

test('a relay control error before upstream bytes errors the stream with a scrubbed reason', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      socket.send(
        JSON.stringify({
          type: 'error',
          id: payload.id,
          status: 500,
          message: `upstream rejected ${V1} via ${RELAY_TOKEN}`,
        }),
      )
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  const failure = await response.text().then(
    () => new Error('Stream unexpectedly succeeded'),
    (error: unknown) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(failure instanceof Error ? failure.message : '').toBe(
    `relay websocket error 500: upstream rejected ${PROVIDER_ERROR_REDACTION} via ${PROVIDER_ERROR_REDACTION}`,
  )
})

test('a relay control error while an optimistic stream is open is delivered as a scrubbed SSE error', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      sendChunks(socket, payload.id, [encoder.encode(successPrefix)])
      socket.send(
        JSON.stringify({
          type: 'error',
          id: payload.id,
          status: 500,
          message: `stream failed for ${V1}`,
        }),
      )
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  expect(await response.text()).toBe(
    successPrefix +
      sseFrame(
        'error',
        anthropicError(
          'relay_error',
          `stream failed for ${PROVIDER_ERROR_REDACTION}`,
        ),
      ),
  )
})

const relayPath = new URL('../relay.ts', import.meta.url).href
const dumpPath = new URL('../dump.ts', import.meta.url).href

/** Run a script against the real relay logger in a child process. */
async function loggedChild(script: string) {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-relay-redaction-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const log = join(root, 'relay.log')
  const child = Bun.spawn([process.execPath, '-e', script], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TMPDIR: root,
      OPENCODE_ANTHROPIC_AUTH_LOG_FILE: log,
      OPENCODE_ANTHROPIC_AUTH_LOG_LEVEL: 'debug',
      OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: join(root, 'dumps'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let exited = false
  const cancellation = gate()
  trackDetached(
    cancellation.wait.then(() => {
      if (!exited) child.kill()
    }),
  )
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    const [exit, out, err] = await Promise.allSettled([
      child.exited,
      stdout,
      stderr,
    ])
    exited = true
    if (
      exit.status !== 'fulfilled' ||
      out.status !== 'fulfilled' ||
      err.status !== 'fulfilled'
    )
      throw new AggregateError(
        [exit, out, err].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        ),
        'Relay log fixture drainage failed',
      )
    expect(err.value).toBe('')
    expect(exit.value).toBe(0)
    return { stdout: out.value, log: await readFile(log, 'utf8') }
  } finally {
    cancellation.open()
  }
}

test('real WebSocket state-mismatch and done logs keep only fixed metadata', async () => {
  const result = await loggedChild(`
    import { sendViaRelay } from ${JSON.stringify(relayPath)}
    import { setDumpEnabled } from ${JSON.stringify(dumpPath)}
    setDumpEnabled(false)
    const token = ${JSON.stringify(V1)}, relayToken = ${JSON.stringify(RELAY_TOKEN)}
    let messages = 0
    const sockets = new Set()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, owner) => owner.upgrade(request) ? undefined : new Response('unexpected HTTP', { status: 500 }),
      websocket: {
        open(socket) { sockets.add(socket); socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null })) },
        message(socket, data) {
          const payload = JSON.parse(String(data))
          if (++messages === 1) {
            socket.send(JSON.stringify({ type: 'error', id: payload.id, status: 409, message: 'state mismatch ' + token + ' relay ' + relayToken }))
            return
          }
          socket.send(JSON.stringify({ type: 'response_start', id: payload.id, status: 200, headers: { 'content-type': 'text/event-stream' } }))
          socket.send(JSON.stringify({ type: 'done', id: payload.id, upstreamChunks: 'chunks ' + token, upstreamBytes: 0, frames: 'frames ' + relayToken, frameBytes: 0 }))
        },
        close(socket) { sockets.delete(socket) },
      },
    })
    try {
      const response = await sendViaRelay({ config: { enabled: true, url: server.url.href, token: relayToken, transport: 'websocket', fallbackToDirect: false }, input: 'https://api.anthropic.com/v1/messages', init: { method: 'POST' }, headers: new Headers({ authorization: 'Bearer ' + token }), body: JSON.stringify({ messages: [] }), affinity: 'synthetic-log-control', fallback: async () => { throw new Error('Unexpected fallback') } })
      if (messages !== 2 || response.status !== 200 || (await response.text()) !== '') throw new Error('Relay did not retry the state mismatch')
    } finally {
      for (const socket of sockets) socket.close()
      server.stop(true)
    }
    console.log('PHYSICAL_RELAY_ATTEMPTS=2; EXTERNAL_HTTP=0')
  `)
  expect(result.stdout).toContain('PHYSICAL_RELAY_ATTEMPTS=2; EXTERNAL_HTTP=0')
  expect(result.log).toContain(
    'websocket state mismatch; reconnecting and retrying full_sync session=synthetic-lo',
  )
  expect(result.log).toContain('perf websocket done session=synthetic-lo')
  expect(result.log).toContain('upstreamChunks=unknown')
  expect(result.log).not.toContain(V1)
  expect(result.log).not.toContain(RELAY_TOKEN)
})

/**
 * Collect garbage until every tracked object is gone or the rounds run out.
 * Each round yields a macrotask first, so objects kept alive for the
 * current job by `WeakRef.deref` are released before the collection. A
 * round that still finds an object alive runs the relay code again before
 * the next one (see runRelayCodeAgain).
 */
async function collected(refs: WeakRef<object>[]) {
  for (let round = 0; round < 20; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    Bun.gc(true)
    if (refs.every((ref) => ref.deref() === undefined)) return true
    await runRelayCodeAgain()
  }
  return false
}

/**
 * Sends throwaway requests through the relay's WebSocket and HTTP paths.
 *
 * JavaScriptCore compiles hot functions on a background thread. A finished
 * compile waits on the engine's JIT worklist until its function runs again,
 * and while it waits it keeps the values it captured from that function's
 * frame alive as GC roots: a heap snapshot names the root "JITWorkList".
 * When a compile of a relay function lands during a test, that test's
 * authorization can stay reachable only through such a root, although no
 * relay object holds it. This is an engine root, not a leak. Running the same
 * relay code again lets the engine install the compile and drop those roots.
 */
async function runRelayCodeAgain() {
  const relay = startRelay({
    ws: (socket, payload) => {
      const streaming = payload.body?.includes('"stream":true') === true
      startResponse(socket, payload.id, 200, {
        'content-type': streaming ? 'text/event-stream' : 'application/json',
      })
      sendChunks(socket, payload.id, [
        encoder.encode(streaming ? successPrefix : '{"id":"msg_ok"}'),
      ])
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
    http: () =>
      new Response('{"id":"msg_ok"}', {
        headers: {
          'content-type': 'application/json',
          'request-id': 'req_throwaway',
        },
      }),
  })
  try {
    for (const [transport, streaming] of [
      ['websocket', false],
      ['websocket', true],
      ['http', false],
    ] as const) {
      const response = await send({
        relay,
        transport,
        optimistic: streaming,
        body: streaming ? streamingBody('again') : requestBody('again'),
        authorize: async () => ({
          headers: new Headers({ authorization: `Bearer ${V0}` }),
        }),
      })
      await response.text()
    }
  } finally {
    await relay.close()
  }
}

for (const ending of ['done', 'cancel', 'error'] as const) {
  test(`a WebSocket attempt releases its authorization at ${ending} while the host still holds the response`, async () => {
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, [encoder.encode(successPrefix)])
        if (ending === 'done')
          socket.send(JSON.stringify({ type: 'done', id: payload.id }))
        if (ending === 'error')
          socket.send(
            JSON.stringify({
              type: 'error',
              id: payload.id,
              status: 500,
              message: `failed for ${V1}`,
            }),
          )
      },
    })
    const refs: WeakRef<object>[] = []
    const response = await send({
      relay,
      transport: 'websocket',
      authorize: async () => {
        const authorization: RelayAttemptAuthorization = {
          headers: new Headers({ authorization: `Bearer ${V1}` }),
          errorSecrets: [V1],
        }
        refs.push(new WeakRef(authorization))
        return authorization
      },
    })
    const body = response.body
    if (!body) throw new Error('Relay response has no body')
    const reader = body.getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    if (ending === 'cancel') await reader.cancel()
    else {
      const rest = await reader.read().then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      )
      if (ending === 'done') expect(rest.result?.done).toBe(true)
      else
        expect(rest.error instanceof Error ? rest.error.message : '').toBe(
          `relay websocket error 500: failed for ${PROVIDER_ERROR_REDACTION}`,
        )
    }
    expect(refs).toHaveLength(1)
    expect(await collected(refs)).toBe(true)
    // The host still holds the response and its reader here.
    expect(response.bodyUsed).toBe(true)
    reader.releaseLock()
  })
}

test('cancelling an optimistic stream before upstream bytes spends no further authorization', async () => {
  const relay = startRelay({
    ws: (socket, payload, index) => {
      // The first physical attempt is held open so the host cancels it
      // before any upstream byte; every later payload completes at once.
      if (index === 0) return
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1, V2, V0], true)
  const affinity = randomUUID()
  const cancelled = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    affinity,
    body: streamingBody('cancelled-first'),
    authorize: auth.authorize,
  })
  expectOptimistic(cancelled)
  await cancelled.body?.cancel()
  // Both requests use the same affinity, so the relay session queues this
  // one behind the cancelled request; it starts only after that one ended.
  const next = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    affinity,
    body: streamingBody('second'),
    authorize: auth.authorize,
  })
  expectOptimistic(next)
  expect(await next.text()).toBe('')
  expect(
    relay.sent.map((payload) => payload.body?.endsWith('second"}]}')),
  ).toEqual([false, true])
  expect(
    relay.sent.map((payload) => payload.upstream.headers.authorization),
  ).toEqual([`Bearer ${V1}`, `Bearer ${V2}`])
  expect(auth.calls()).toBe(2)
})

const echoedStream = (token: string) =>
  successPrefix + sseFrame('error', echoFor(token))
const scrubbedStream = successPrefix + sseFrame('error', scrubbedEcho)

/** Missing content type (bytes body) or an explicit text/plain one. */
function untypedResponse(text: string, mime: 'missing' | 'text/plain') {
  return mime === 'missing'
    ? new Response(encoder.encode(text))
    : new Response(text, { headers: { 'content-type': 'text/plain' } })
}

for (const mime of ['missing', 'text/plain'] as const) {
  test(`a streaming HTTP request is scrubbed as an event stream whatever its content type (${mime})`, async () => {
    const relay = startRelay({
      http: () => untypedResponse(echoedStream(V1), mime),
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'http',
      body: streamingBody('first'),
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(scrubbedStream)
  })

  test(`successful streaming HTTP bytes stay identical whatever the content type (${mime})`, async () => {
    const upstream =
      successPrefix +
      sseFrame('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: `an error about ${V1}` },
      }) +
      sseFrame('message_stop', { type: 'message_stop' })
    const relay = startRelay({ http: () => untypedResponse(upstream, mime) })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'http',
      body: streamingBody('first'),
      authorize: auth.authorize,
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
  })
}

for (const [name, body] of [
  ['no stream field', requestBody('first')],
  ['stream false', JSON.stringify({ stream: false, messages: [] })],
  ['stream as the string "true"', JSON.stringify({ stream: 'true' })],
  ['stream as an array', JSON.stringify({ stream: [true] })],
  ['a JSON array body', JSON.stringify([{ stream: true }])],
  ['a malformed JSON body', '{"stream":true,"messages":['],
] as const) {
  test(`a non-streaming HTTP request (${name}) keeps a successful body untouched`, async () => {
    const relay = startRelay({
      http: () => untypedResponse(echoedStream(V1), 'text/plain'),
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'http',
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(echoedStream(V1))
    expect(relay.sent).toHaveLength(1)
  })
}

test('a malformed request body is still relayed once and its error response scrubbed', async () => {
  const relay = startRelay({
    http: () =>
      Response.json(echoFor(V1), {
        status: 401,
        headers: { 'request-id': 'req_malformed' },
      }),
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'http',
    body: '{"stream":true,"messages":[',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
  expect(relay.sent).toHaveLength(1)
  expect(auth.observed).toEqual([[1, 401]])
})

test('the request protocol survives the 409 full-sync re-authorization', async () => {
  const relay = startRelay({
    http: (_payload, index) => {
      if (index === 0) return untypedResponse(successPrefix, 'missing')
      if (index === 1) return new Response('', { status: 409 })
      return untypedResponse(echoedStream(V2), 'text/plain')
    },
  })
  const auth = authorizer([V0, V1, V2], true)
  const affinity = randomUUID()
  const sendStreaming = (suffix: string) =>
    send({
      relay,
      transport: 'http',
      affinity,
      body: streamingBody(suffix),
      authorize: auth.authorize,
    })
  expect(await (await sendStreaming('first')).text()).toBe(successPrefix)
  const response = await sendStreaming('second')
  expect(await response.text()).toBe(scrubbedStream)
  expect(relay.sent.map((payload) => payload.mode)).toEqual([
    'full_sync',
    'patch',
    'full_sync',
  ])
  expect(
    relay.sent.map((payload) => payload.upstream.headers.authorization),
  ).toEqual([`Bearer ${V0}`, `Bearer ${V1}`, `Bearer ${V2}`])
})

test('a non-optimistic streaming WebSocket response is scrubbed as an event stream under text/plain', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, { 'content-type': 'text/plain' })
      const bytes = encoder.encode(echoedStream(V1))
      sendChunks(socket, payload.id, splitAt(bytes, [20]))
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(scrubbedStream)
})

for (const [extrasName, extras] of [
  ['empty', []],
  ['stale', [V1]],
] as const) {
  test(`the outgoing v2 header is scrubbed even when errorSecrets is ${extrasName} (WebSocket reconnect)`, async () => {
    const relay = startRelay({
      ws: (socket, payload, index) => {
        if (index === 0) return socket.close(1011, 'interrupted')
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, [encoder.encode(echoedStream(V2))])
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    let calls = 0
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body: streamingBody('first'),
      authorize: async () => {
        const token = ++calls === 1 ? V1 : V2
        return {
          headers: new Headers({ authorization: `Bearer ${token}` }),
          errorSecrets: token === V2 ? extras : [token],
        }
      },
    })
    expectOptimistic(response)
    expect(await response.text()).toBe(scrubbedStream)
    expect(
      relay.sent.map((payload) => payload.upstream.headers.authorization),
    ).toEqual([`Bearer ${V1}`, `Bearer ${V2}`])
  })

  test(`the outgoing v2 header is scrubbed even when errorSecrets is ${extrasName} (HTTP)`, async () => {
    const relay = startRelay({
      http: () =>
        Response.json(echoFor(V2), {
          status: 401,
          headers: { 'request-id': 'req_extras', 'x-echo': `Bearer ${V2}` },
        }),
    })
    const response = await send({
      relay,
      transport: 'http',
      authorize: async () => ({
        headers: new Headers({ authorization: `Bearer ${V2}` }),
        errorSecrets: extras,
      }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-echo')).toBe(PROVIDER_ERROR_REDACTION)
    expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
  })
}

test('each HTTP request scrubs only its own attempt credentials and extras', async () => {
  const relay = startRelay({
    http: (_payload, index) =>
      index === 0
        ? new Response('ok')
        : Response.json(
            anthropicError(
              'authentication_error',
              `now ${V2} bound ${sessionOf(V2)} before ${V1} bound ${sessionOf(V1)}`,
            ),
            { status: 401, headers: { 'request-id': 'req_isolated' } },
          ),
  })
  const auth = authorizer([V1, V2], true)
  expect(
    await (
      await send({ relay, transport: 'http', authorize: auth.authorize })
    ).text(),
  ).toBe('ok')
  const response = await send({
    relay,
    transport: 'http',
    authorize: auth.authorize,
  })
  // The second request never sent V1 or its binding, so nothing from the
  // first request's attempt is inherited.
  expect(await response.text()).toBe(
    JSON.stringify(
      anthropicError(
        'authentication_error',
        `now ${PROVIDER_ERROR_REDACTION} bound ${PROVIDER_ERROR_REDACTION} before ${V1} bound ${sessionOf(V1)}`,
      ),
    ),
  )
})

for (const [name, body] of [
  ['no stream field', requestBody('first')],
  ['stream false', JSON.stringify({ stream: false, messages: [] })],
] as const) {
  test(`a non-optimistic non-streaming WebSocket success labelled text/event-stream stays byte-identical (${name})`, async () => {
    const upstream = echoedStream(V1)
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, splitAt(encoder.encode(upstream), [25]))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
  })
}

test('a non-optimistic streaming WebSocket response without a content type is scrubbed as an event stream', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, {})
      sendChunks(
        socket,
        payload.id,
        splitAt(encoder.encode(echoedStream(V1)), [40]),
      )
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe(scrubbedStream)
})

test('a non-optimistic non-streaming WebSocket error response is still scrubbed', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 401, {
        'content-type': 'text/event-stream',
        'request-id': 'req_ws_http_401',
      })
      sendChunks(socket, payload.id, [
        encoder.encode(JSON.stringify(echoFor(V1))),
      ])
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1], true)
  const response = await send({
    relay,
    transport: 'websocket',
    authorize: auth.authorize,
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
})

/** Larger than the stream scope's 8 MiB SSE frame bound, with no blank line. */
function largeJsonBody() {
  const text = `an error about ${V1} `
  return JSON.stringify({
    id: 'msg_large',
    type: 'message',
    content: [{ type: 'text', text: text + 'a'.repeat(8.5 * 1024 * 1024) }],
  })
}

for (const [name, body] of [
  ['no stream field', requestBody('first')],
  ['stream false', JSON.stringify({ stream: false, messages: [] })],
] as const) {
  test(`an optimistic caller's non-streaming request waits for the real response (${name}): large JSON stays byte-identical`, async () => {
    const upstream = encoder.encode(largeJsonBody())
    expect(upstream.byteLength).toBeGreaterThan(8 * 1024 * 1024)
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'application/json',
          'request-id': 'req_large',
        })
        const mib = 1024 * 1024
        const offsets: number[] = []
        for (let at = mib; at < upstream.byteLength; at += mib) offsets.push(at)
        sendChunks(socket, payload.id, splitAt(upstream, offsets))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBeNull()
    expect(response.headers.get('content-type')).toBe('application/json')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect(Buffer.from(bytes).equals(Buffer.from(upstream))).toBe(true)
    expect(auth.observed).toEqual([[1, 200]])
  })

  test(`an optimistic caller's non-streaming request keeps an error-looking success untouched (${name})`, async () => {
    const upstream = echoedStream(V1)
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 200, {
          'content-type': 'text/event-stream',
        })
        sendChunks(socket, payload.id, splitAt(encoder.encode(upstream), [33]))
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body,
      authorize: auth.authorize,
    })
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBeNull()
    expect(await response.text()).toBe(upstream)
  })

  test(`an optimistic caller's non-streaming request gets the genuine upstream error status, scrubbed (${name})`, async () => {
    const relay = startRelay({
      ws: (socket, payload) => {
        startResponse(socket, payload.id, 401, {
          'content-type': 'application/json',
          'request-id': 'req_ws_optimistic_401',
          'x-echo': `credential ${V1}`,
        })
        sendChunks(socket, payload.id, [
          encoder.encode(JSON.stringify(echoFor(V1))),
        ])
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1], true)
    const response = await send({
      relay,
      transport: 'websocket',
      optimistic: true,
      body,
      authorize: auth.authorize,
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBeNull()
    expect(response.headers.get('request-id')).toBe('req_ws_optimistic_401')
    expect(response.headers.get('x-echo')).toBe(
      `credential ${PROVIDER_ERROR_REDACTION}`,
    )
    expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
    expect(auth.observed).toEqual([[1, 401]])
  })
}

test('a streaming optimistic attempt that already received a partial upstream frame is not replayed', async () => {
  const relay = startRelay({
    ws: (socket, payload) => {
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      // An unterminated frame: the scope holds it, but the bytes arrived.
      sendChunks(socket, payload.id, [
        encoder.encode(`event: content_block_delta\ndata: {"partial":"${V1}`),
      ])
      socket.close(1011, 'interrupted after bytes')
    },
  })
  const auth = authorizer([V1, V2], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  const failure = await response.text().then(
    (text) => new Error(`Stream unexpectedly succeeded: ${text.length}`),
    (error: unknown) => error,
  )
  expect(failure instanceof Error ? failure.message : '').toBe(
    'relay websocket closed during response stream',
  )
  expect(relay.sent).toHaveLength(1)
  expect(auth.calls()).toBe(1)
})

for (const [name, body] of [
  ['non-streaming', requestBody('first')],
  ['streaming', streamingBody('first')],
] as const) {
  test(`a non-optimistic ${name} response is not replayed after its real response_start`, async () => {
    const relay = startRelay({
      ws: (socket, payload, index) => {
        if (index === 0) {
          // The real status and headers reach the host, then the socket
          // dies before any body byte.
          startResponse(socket, payload.id, 401, {
            'content-type': 'application/json',
            'request-id': 'req_first_attempt',
          })
          return socket.close(1011, 'interrupted after response_start')
        }
        startResponse(socket, payload.id, 500, {
          'content-type': 'application/json',
          'request-id': 'req_second_attempt',
        })
        sendChunks(socket, payload.id, [
          encoder.encode(JSON.stringify(echoFor(V2))),
        ])
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    })
    const auth = authorizer([V1, V2], true)
    const response = await send({
      relay,
      transport: 'websocket',
      body,
      authorize: auth.authorize,
    })
    const outcome = await response.text().then(
      (text) => ({ body: text }),
      (error: unknown) => ({
        failure: error instanceof Error ? error.message : String(error),
      }),
    )
    expect({
      status: response.status,
      requestId: response.headers.get('request-id'),
      outcome,
      physicalAttempts: relay.sent.length,
      authorizations: auth.calls(),
      upstreamStatuses: auth.observed,
    }).toEqual({
      status: 401,
      requestId: 'req_first_attempt',
      outcome: { failure: 'relay websocket closed during response stream' },
      physicalAttempts: 1,
      authorizations: 1,
      upstreamStatuses: [[1, 401]],
    })
  })
}

test('an optimistic streaming attempt that closes after response_start but before bytes is still retried with the new credential', async () => {
  const relay = startRelay({
    ws: (socket, payload, index) => {
      startResponse(socket, payload.id, 200, {
        'content-type': 'text/event-stream',
      })
      if (index === 0) return socket.close(1011, 'interrupted before bytes')
      sendChunks(socket, payload.id, [encoder.encode(echoedStream(V2))])
      socket.send(JSON.stringify({ type: 'done', id: payload.id }))
    },
  })
  const auth = authorizer([V1, V2], true)
  const response = await send({
    relay,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  expect(await response.text()).toBe(scrubbedStream)
  expect(relay.sent).toHaveLength(2)
  expect(auth.observed).toEqual([
    [1, 200],
    [2, 200],
  ])
})

// Shaped like a real OAuth access token. Lowercase, so a header name that
// echoes it (HTTP lowercases header names) is still the exact credential.
const OAT_V1 = `sk-ant-oat01-${'q7lm2vb9x4'.repeat(8)}aa`
const OAT_V2 = `sk-ant-oat01-${'r8kn3wc0y5'.repeat(8)}bb`

type ProviderReply = {
  status: number
  reason: string
  headers: Record<string, string>
  body?: string
  /**
   * Send the status line, the headers (with the full content length) and
   * the first `heldAfter` body bytes, then hold the connection open.
   */
  heldAfter?: number
}

/** Hold the request open: never answer it. */
const HOLD = 'hold' as const

type ProviderSocket = {
  buffered: Buffer
  unsent?: Buffer
  /** End the connection once the unsent bytes are written. */
  endAfterWrite: boolean
}

/**
 * Loopback HTTP/1.1 provider on a raw socket, so it can echo the credential
 * it received in its status line (Bun.serve always writes the standard
 * reason phrase). Each connection carries one request and then closes,
 * unless the reply holds it open. `credentials` lists the bearer credential
 * of every request it answered; `connections` counts the TCP connections it
 * accepted and saw close. `close` stops the listener, which closes every
 * connection, and joins each connection's close callback on its own.
 */
function startProvider(
  reply: (credential: string, index: number) => ProviderReply | typeof HOLD,
  life: FixtureLifetime = suiteLifetime,
) {
  const credentials: string[] = []
  const connections = { opened: 0, closed: 0 }
  const closes: Promise<void>[] = []
  const closers = new WeakMap<object, () => void>()
  let requested!: () => void
  const firstRequest = new Promise<void>((resolve) => {
    requested = resolve
  })
  const write = (
    socket: { write(data: Buffer): number; end(): void; data: ProviderSocket },
    bytes: Buffer,
  ) => {
    const written = Math.max(0, socket.write(bytes))
    socket.data.unsent =
      written < bytes.byteLength ? bytes.subarray(written) : undefined
    if (!socket.data.unsent && socket.data.endAfterWrite) socket.end()
  }
  const listener = Bun.listen<ProviderSocket>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        connections.opened += 1
        socket.data = { buffered: Buffer.alloc(0), endAfterWrite: false }
        closes.push(
          new Promise<void>((resolve) => closers.set(socket, resolve)),
        )
      },
      close(socket) {
        connections.closed += 1
        closers.get(socket)?.()
      },
      // A large reply is written as the socket drains.
      drain(socket) {
        if (socket.data.unsent) write(socket, socket.data.unsent)
      },
      data(socket, chunk) {
        const buffered = Buffer.concat([socket.data.buffered, chunk])
        socket.data.buffered = buffered
        const headEnd = buffered.indexOf('\r\n\r\n')
        if (headEnd < 0) return
        const head = buffered.subarray(0, headEnd).toString('latin1')
        const length = Number(
          /^content-length:\s*(\d+)\s*$/im.exec(head)?.[1] ?? 0,
        )
        if (buffered.byteLength < headEnd + 4 + length) return
        socket.data.buffered = Buffer.alloc(0)
        const credential =
          /^authorization:\s*Bearer (\S+)\s*$/im.exec(head)?.[1] ?? ''
        credentials.push(credential)
        requested()
        const answer = reply(credential, credentials.length - 1)
        if (answer === HOLD) return
        const lines = [
          `HTTP/1.1 ${answer.status} ${answer.reason}`,
          ...Object.entries(answer.headers).map(
            ([name, value]) => `${name}: ${value}`,
          ),
        ]
        if (answer.body !== undefined)
          lines.push(`content-length: ${Buffer.byteLength(answer.body)}`)
        lines.push('connection: close')
        const body = Buffer.from(answer.body ?? '')
        const sent =
          answer.heldAfter === undefined
            ? body
            : body.subarray(0, answer.heldAfter)
        socket.data.endAfterWrite = answer.heldAfter === undefined
        write(
          socket,
          Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), sent]),
        )
      },
    },
  })
  let stopping: Promise<void> | undefined
  const close = () => {
    stopping ??= (async () => {
      listener.stop(true)
      const results = await Promise.allSettled(closes)
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length)
        throw new AggregateError(failures, 'Loopback provider shutdown failed')
    })()
    return stopping
  }
  const shutdown = life.gate()
  life.trackDetached(shutdown.wait.then(close))
  return {
    url: `http://127.0.0.1:${listener.port}/v1/messages`,
    credentials,
    connections,
    firstRequest,
    close,
  }
}

type ForwardedStart = {
  status: number
  statusText: string
  headers: Record<string, string>
}

/**
 * How the loopback relay answers one physical attempt after forwarding it
 * to the provider: like the bundled Worker (`response_start`, the body,
 * then `done`, the body cut into `pieceBytes` frames when given); sending
 * the body before `response_start` and then dying; or replacing the
 * forwarded `response_start` fields with ones no Response can carry, and
 * sending nothing after it.
 */
type RelayPlan =
  | { kind: 'conforming'; pieceBytes?: number }
  | { kind: 'bytes-before-start'; cut: number }
  | { kind: 'malformed'; start: (forwarded: ForwardedStart) => object }

function piecesOf(bytes: Uint8Array, pieceBytes: number | undefined) {
  if (bytes.byteLength === 0) return []
  if (!pieceBytes) return splitAt(bytes, [Math.floor(bytes.byteLength / 2)])
  const offsets: number[] = []
  for (let at = pieceBytes; at < bytes.byteLength; at += pieceBytes)
    offsets.push(at)
  return splitAt(bytes, offsets)
}

/**
 * Loopback relay (WebSocket, and HTTP when `http` is set) that really
 * forwards every payload over HTTP to the provider, each forward under one
 * AbortController. `starts` records the status line and headers the
 * provider actually sent, before any plan alters them; `delivered` records,
 * per conforming WebSocket attempt, the body frames and bytes it sent.
 *
 * `close` is the shutdown that test teardown also runs: abort every
 * forward, stop the relay and the provider, then join each forward, the
 * relay and the provider on its own. `outcomes` then says how each forward
 * ended; a forward ended by the abort is expected, any other failure is
 * reported.
 */
function startForwardingRelay(
  provider: ReturnType<typeof startProvider>,
  plan: (index: number) => RelayPlan,
  http = false,
  life: FixtureLifetime = suiteLifetime,
) {
  const starts: ForwardedStart[] = []
  const delivered: Array<{ frames: number; bytes: number }> = []
  const forwards: Promise<void>[] = []
  const outcomes: string[] = []
  const abort = new AbortController()
  const forward = async (payload: SentPayload) => {
    if (payload.upstream.url !== provider.url)
      throw new Error('Relay asked to reach a non-loopback URL')
    const upstream = await fetch(payload.upstream.url, {
      method: payload.upstream.method ?? 'POST',
      headers: payload.upstream.headers,
      body: payload.body,
      signal: abort.signal,
    })
    const forwarded: ForwardedStart = {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: Object.fromEntries(upstream.headers.entries()),
    }
    starts.push(forwarded)
    return { upstream, forwarded }
  }
  const track = (work: Promise<void>) => {
    forwards.push(
      work.then(
        () => {
          outcomes.push('completed')
        },
        (error: unknown) => {
          if (!abort.signal.aborted) throw error
          outcomes.push('aborted')
        },
      ),
    )
  }
  const relay = startRelay(
    {
      ws: (socket, payload, index) => {
        const step = plan(index)
        track(
          (async () => {
            const { upstream, forwarded } = await forward(payload)
            const bytes = new Uint8Array(await upstream.arrayBuffer())
            if (step.kind === 'bytes-before-start') {
              sendChunks(socket, payload.id, splitAt(bytes, [step.cut]))
              socket.close(1011, 'interrupted before response_start')
              return
            }
            const start = {
              type: 'response_start',
              id: payload.id,
              ...forwarded,
            }
            if (step.kind === 'malformed') {
              socket.send(
                JSON.stringify({ ...start, ...step.start(forwarded) }),
              )
              return
            }
            socket.send(JSON.stringify(start))
            const pieces = piecesOf(bytes, step.pieceBytes)
            sendChunks(socket, payload.id, pieces)
            socket.send(JSON.stringify({ type: 'done', id: payload.id }))
            delivered.push({ frames: pieces.length, bytes: bytes.byteLength })
          })(),
        )
      },
      http: http
        ? (payload) => {
            // The upstream body is piped through under the same abort, so the
            // forward ends only when its body does; that pipe is what
            // `track` joins.
            const handled = forward(payload).then(({ upstream }) => {
              const pass = new TransformStream<Uint8Array, Uint8Array>()
              const piped = upstream.body
                ? upstream.body.pipeTo(pass.writable, { signal: abort.signal })
                : pass.writable.close()
              return {
                piped,
                response: new Response(upstream.body ? pass.readable : null, {
                  status: upstream.status,
                  statusText: upstream.statusText,
                  headers: upstream.headers,
                }),
              }
            })
            track(handled.then(({ piped }) => piped))
            // An aborted forward answers the relay's caller with a plain 502;
            // the forward's own outcome is joined through `track`.
            return handled.then(
              ({ response }) => response,
              () => new Response('forward aborted', { status: 502 }),
            )
          }
        : undefined,
    },
    life,
  )
  let closing: Promise<void> | undefined
  const close = () => {
    closing ??= (async () => {
      abort.abort()
      const results = await Promise.allSettled([
        ...forwards,
        relay.close(),
        provider.close(),
      ])
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length)
        throw new AggregateError(failures, 'Loopback forwarding relay failed')
    })()
    return closing
  }
  const shutdown = life.gate()
  life.trackDetached(shutdown.wait.then(close))
  return { ...relay, starts, delivered, outcomes, close }
}

type Settled<T> =
  | { state: 'fulfilled'; value: T }
  | { state: 'rejected'; message: string }

/** `work` settled only after test teardown cancelled it through `close`. */
type CancelledThenSettled<T> = { state: 'cancelled'; after: Settled<T> }

/**
 * Wait for `work`, an owned request or body read. When test teardown opens
 * the gate first, cancel before joining: `close` shuts the owned relay and
 * provider (aborting their forwards), so `work` can only settle from what
 * really happened on the network. Then `work` itself is joined, with no
 * bound: teardown never moves on while the request is still running.
 */
async function settleOrCancel<T>(
  work: Promise<T>,
  close: () => Promise<void>,
  life: FixtureLifetime = suiteLifetime,
): Promise<Settled<T> | CancelledThenSettled<T>> {
  const cancellation = life.gate()
  const outcome: Promise<Settled<T>> = work.then(
    (value) => ({ state: 'fulfilled' as const, value }),
    (error: unknown) => ({
      state: 'rejected' as const,
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  try {
    const first = await Promise.race([
      outcome,
      cancellation.wait.then(() => undefined),
    ])
    if (first) return first
    let closeFailure: unknown
    let closeFailed = false
    try {
      await close()
    } catch (error) {
      closeFailed = true
      closeFailure = error
    }
    // The request is joined even when the shutdown itself failed.
    const after = await outcome
    if (closeFailed) throw closeFailure
    return { state: 'cancelled', after }
  } finally {
    cancellation.open()
  }
}

/**
 * Read a body to its end or failure, keeping every byte that arrived. When
 * test teardown opens the gate while a read is pending, the reader is
 * cancelled, which settles that read; the drain is then joined normally.
 */
async function drainBody(
  response: Response,
  life: FixtureLifetime = suiteLifetime,
  onChunk?: (chunk: Uint8Array) => void,
) {
  const body = response.body
  if (!body) return { text: '', failure: undefined }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let finished = false
  const cancellation = life.gate()
  const cancelled = cancellation.wait.then(() =>
    finished ? undefined : reader.cancel().catch(() => {}),
  )
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      onChunk?.(value)
    }
    return { text: Buffer.concat(chunks).toString('utf8'), failure: undefined }
  } catch (error) {
    return {
      text: Buffer.concat(chunks).toString('utf8'),
      failure: error instanceof Error ? error.message : String(error),
    }
  } finally {
    finished = true
    cancellation.open()
    await cancelled
    reader.releaseLock()
  }
}

const deltaFrame = (text: string) =>
  sseFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })

test('an optimistic attempt whose upstream bytes arrive before response_start is never replayed', async () => {
  const provider = startProvider((_credential, index) => ({
    status: 200,
    reason: 'OK',
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_bytes' },
    body: successPrefix + deltaFrame(`physical attempt ${index}`),
  }))
  // The first attempt's body arrives as one binary frame and one base64
  // chunk, both before any response_start, and then the relay dies.
  const relay = startForwardingRelay(provider, (index) =>
    index === 0
      ? { kind: 'bytes-before-start', cut: successPrefix.length }
      : { kind: 'conforming' },
  )
  const auth = authorizer([OAT_V1, OAT_V2], true)
  const response = await send({
    relay,
    input: provider.url,
    transport: 'websocket',
    optimistic: true,
    body: streamingBody('first'),
    authorize: auth.authorize,
  })
  expectOptimistic(response)
  const outcome = await settleOrCancel(drainBody(response), relay.close)
  expect({
    outcome,
    providerRequests: provider.credentials,
    physicalAttempts: relay.sent.length,
    authorizations: auth.calls(),
  }).toEqual({
    outcome: {
      state: 'fulfilled',
      value: {
        text: successPrefix + deltaFrame('physical attempt 0'),
        failure: 'relay websocket closed during response stream',
      },
    },
    providerRequests: [OAT_V1],
    physicalAttempts: 1,
    authorizations: 1,
  })
})

const QUOTA_RESET = '1767225600'

function providerErrorReply(credential: string): ProviderReply {
  return {
    status: 401,
    reason: `rejected ${credential}`,
    headers: {
      'content-type': 'application/json',
      'request-id': 'req_provider_401',
      'x-provider-detail': `rejected ${credential}`,
      [credential]: 'echoed as a header name',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': QUOTA_RESET,
    },
    body: JSON.stringify(echoFor(credential)),
  }
}

/** The headers onResponseHeaders may see of a `providerErrorReply` response. */
const safeProviderErrorHeaders = {
  'content-type': 'application/json',
  'request-id': 'req_provider_401',
  'x-provider-detail': `rejected ${PROVIDER_ERROR_REDACTION}`,
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-reset': QUOTA_RESET,
}

const websocketHeaderCases = [
  { name: 'non-optimistic non-streaming', optimistic: false, streaming: false },
  { name: 'non-optimistic streaming', optimistic: false, streaming: true },
  { name: 'optimistic streaming', optimistic: true, streaming: true },
] as const

for (const { name, optimistic, streaming } of websocketHeaderCases) {
  test(`WebSocket onResponseHeaders sees a real provider error's headers scrubbed by the attempt that sent the credential (${name})`, async () => {
    const provider = startProvider((credential) =>
      providerErrorReply(credential),
    )
    const relay = startForwardingRelay(provider, () => ({ kind: 'conforming' }))
    const auth = authorizer([OAT_V1], true)
    const harvested: Array<Record<string, string>> = []
    const response = await send({
      relay,
      input: provider.url,
      transport: 'websocket',
      optimistic,
      body: streaming ? streamingBody('first') : requestBody('first'),
      authorize: auth.authorize,
      onResponseHeaders: (headers) =>
        harvested.push(Object.fromEntries(headers.entries())),
    })
    const outcome = await settleOrCancel(drainBody(response), relay.close)
    // Precondition: the provider really echoed the credential it received in
    // a header value, a header name and the status line.
    expect(relay.starts).toHaveLength(1)
    expect(relay.starts[0]?.statusText).toBe(`rejected ${OAT_V1}`)
    expect(relay.starts[0]?.headers[OAT_V1]).toBe('echoed as a header name')
    expect(relay.starts[0]?.headers['x-provider-detail']).toBe(
      `rejected ${OAT_V1}`,
    )
    expect(outcome.state).toBe('fulfilled')
    expect(harvested).toEqual([
      { connection: 'close', ...safeProviderErrorHeaders },
    ])
    expect(JSON.stringify(harvested)).not.toContain(OAT_V1)
    expect(provider.credentials).toEqual([OAT_V1])
    expect(auth.observed).toEqual([[1, 401]])
    if (optimistic) {
      expectOptimistic(response)
      return
    }
    // The host's response carries the same scrubbed status line and headers.
    expect(response.status).toBe(401)
    expect(response.statusText).toBe(`rejected ${PROVIDER_ERROR_REDACTION}`)
    expect([Object.fromEntries(response.headers.entries())]).toEqual(harvested)
  })

  test(`WebSocket onResponseHeaders sees a real provider success's request-id and quota headers exactly (${name})`, async () => {
    const provider = startProvider(() => ({
      status: 200,
      reason: 'OK',
      headers: {
        'content-type': streaming ? 'text/event-stream' : 'application/json',
        'request-id': 'req_provider_200',
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-reset': QUOTA_RESET,
        'anthropic-ratelimit-unified-5h-utilization': '0.25',
      },
      body: streaming ? successPrefix : '{"id":"msg_ok"}',
    }))
    const relay = startForwardingRelay(provider, () => ({ kind: 'conforming' }))
    const auth = authorizer([OAT_V1], true)
    const harvested: Array<Record<string, string>> = []
    const response = await send({
      relay,
      input: provider.url,
      transport: 'websocket',
      optimistic,
      body: streaming ? streamingBody('first') : requestBody('first'),
      authorize: auth.authorize,
      onResponseHeaders: (headers) =>
        harvested.push(Object.fromEntries(headers.entries())),
    })
    const outcome = await settleOrCancel(drainBody(response), relay.close)
    expect(outcome).toEqual({
      state: 'fulfilled',
      value: {
        text: streaming ? successPrefix : '{"id":"msg_ok"}',
        failure: undefined,
      },
    })
    expect(relay.starts).toHaveLength(1)
    expect(harvested).toEqual(relay.starts.map((start) => start.headers))
    expect(harvested[0]?.['request-id']).toBe('req_provider_200')
    expect(harvested[0]?.['anthropic-ratelimit-unified-reset']).toBe(
      QUOTA_RESET,
    )
    expect(auth.observed).toEqual([[1, 200]])
  })
}

test('HTTP onResponseHeaders sees a real provider error scrubbed the same way', async () => {
  const provider = startProvider((credential) => providerErrorReply(credential))
  const relay = startForwardingRelay(
    provider,
    () => ({ kind: 'conforming' }),
    true,
  )
  const auth = authorizer([OAT_V1], true)
  const harvested: Array<Record<string, string>> = []
  const response = await send({
    relay,
    input: provider.url,
    transport: 'http',
    authorize: auth.authorize,
    onResponseHeaders: (headers) =>
      harvested.push(Object.fromEntries(headers.entries())),
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toBe(JSON.stringify(scrubbedEcho))
  expect(harvested).toHaveLength(1)
  expect(harvested[0]).toMatchObject(safeProviderErrorHeaders)
  expect(JSON.stringify(harvested)).not.toContain(OAT_V1)
  expect(provider.credentials).toEqual([OAT_V1])
})

const MALFORMED_START = 'relay websocket response_start metadata is invalid'

for (const [status, expectedText] of [
  [200, '{"id":"msg_ok"}'],
  [204, ''],
  [205, ''],
  [304, ''],
  [400, JSON.stringify(scrubbedEcho)],
] as const) {
  for (const streaming of [false, true]) {
    test(`a real provider ${status} settles the non-optimistic WebSocket response and retires its attempt (streaming=${streaming})`, async () => {
      const bodiless = status === 204 || status === 205 || status === 304
      const provider = startProvider((credential) => ({
        status,
        reason: status === 400 ? 'Bad Request' : 'Provider',
        headers: {
          'request-id': `req_provider_${status}`,
          ...(bodiless ? {} : { 'content-type': 'application/json' }),
        },
        ...(bodiless
          ? {}
          : {
              body:
                status === 400
                  ? JSON.stringify(echoFor(credential))
                  : '{"id":"msg_ok"}',
            }),
      }))
      const relay = startForwardingRelay(provider, () => ({
        kind: 'conforming',
      }))
      const refs: WeakRef<object>[] = []
      const auth = authorizer([OAT_V1], true, refs)
      const settled = await settleOrCancel(
        send({
          relay,
          input: provider.url,
          transport: 'websocket',
          body: streaming ? streamingBody('first') : requestBody('first'),
          authorize: auth.authorize,
        }),
        relay.close,
      )
      if (settled.state !== 'fulfilled')
        throw new Error(`Relay response did not settle: ${settled.state}`)
      const response = settled.value
      expect(response.status).toBe(status)
      expect(response.headers.get('request-id')).toBe(`req_provider_${status}`)
      if (bodiless) expect(response.body).toBeNull()
      expect(await settleOrCancel(drainBody(response), relay.close)).toEqual({
        state: 'fulfilled',
        value: { text: expectedText, failure: undefined },
      })
      expect(provider.credentials).toEqual([OAT_V1])
      expect(relay.sent).toHaveLength(1)
      expect(auth.observed).toEqual([[1, status]])
      expect(refs).toHaveLength(1)
      expect(await collected(refs)).toBe(true)
    })
  }
}

for (const [kind, start] of [
  ['status 600', () => ({ status: 600 })],
  ['status 99', () => ({ status: 99 })],
  [
    'a header value with a line break',
    (forwarded: ForwardedStart) => ({
      headers: {
        ...forwarded.headers,
        'x-provider-detail': `rejected\n${OAT_V1}`,
      },
    }),
  ],
] as const) {
  for (const { name, optimistic, streaming } of websocketHeaderCases) {
    test(`a response_start with ${kind} fails the WebSocket request closed without another attempt (${name})`, async () => {
      const provider = startProvider(() => ({
        status: 200,
        reason: 'OK',
        headers: {
          'content-type': 'application/json',
          'request-id': 'req_malformed',
        },
        body: '{"id":"msg_ok"}',
      }))
      const relay = startForwardingRelay(provider, () => ({
        kind: 'malformed',
        start,
      }))
      const refs: WeakRef<object>[] = []
      const auth = authorizer([OAT_V1, OAT_V2], true, refs)
      const harvested: Array<Record<string, string>> = []
      const settled = await settleOrCancel(
        send({
          relay,
          input: provider.url,
          transport: 'websocket',
          optimistic,
          body: streaming ? streamingBody('first') : requestBody('first'),
          authorize: auth.authorize,
          onResponseHeaders: (headers) =>
            harvested.push(Object.fromEntries(headers.entries())),
        }),
        relay.close,
      )
      let failure: string | undefined
      if (optimistic) {
        if (settled.state !== 'fulfilled')
          throw new Error(`Optimistic response missing: ${settled.state}`)
        expectOptimistic(settled.value)
        const drained = await settleOrCancel(
          drainBody(settled.value),
          relay.close,
        )
        if (drained.state !== 'fulfilled')
          throw new Error(`Optimistic body did not settle: ${drained.state}`)
        expect(drained.value.text).toBe('')
        failure = drained.value.failure
      } else {
        if (settled.state !== 'rejected')
          throw new Error(`Relay request did not fail: ${settled.state}`)
        failure = settled.message
      }
      expect({
        failure,
        harvested,
        providerRequests: provider.credentials,
        physicalAttempts: relay.sent.length,
        authorizations: auth.calls(),
      }).toEqual({
        failure: MALFORMED_START,
        harvested: [],
        providerRequests: [OAT_V1],
        physicalAttempts: 1,
        authorizations: 1,
      })
      expect(await collected(refs)).toBe(true)
    })
  }
}

const MIB = 1024 * 1024

/** Fixed JSON that replaces a provider error body above Core's size limit. */
const OVERSIZED_ERROR_BODY = JSON.stringify({
  type: 'error',
  error: { message: PROVIDER_ERROR_OVERSIZED_MESSAGE },
})

/** Memory held outside the JS heap (ArrayBuffers among it), after a full GC. */
function retainedExternalBytes() {
  Bun.gc(true)
  return heapStats().extraMemorySize
}

function bigErrorReply(credential: string, mib: number): ProviderReply {
  return {
    status: 401,
    reason: 'Unauthorized',
    headers: {
      'content-type': 'application/json',
      'request-id': 'req_big_401',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': QUOTA_RESET,
    },
    body: JSON.stringify(
      anthropicError(
        'authentication_error',
        `rejected ${credential} ${'e'.repeat(mib * MIB)}`,
      ),
    ),
  }
}

for (const streaming of [false, true]) {
  test(`an unread real 12 MiB WebSocket 401 holds no more than the 1 MiB bound and ends with one fixed oversized body (streaming=${streaming})`, async () => {
    const provider = startProvider((credential, index) =>
      index === 0
        ? bigErrorReply(credential, 12)
        : {
            status: 200,
            reason: 'OK',
            headers: {
              'content-type': 'application/json',
              'request-id': 'req_after_oversized',
            },
            body: '{"id":"msg_after"}',
          },
    )
    const relay = startForwardingRelay(provider, () => ({
      kind: 'conforming',
      pieceBytes: 256 * 1024,
    }))
    const affinity = randomUUID()
    const auth = authorizer([OAT_V1, OAT_V2], true)
    const harvested: Array<Record<string, string>> = []
    const request = (suffix: string) =>
      send({
        relay,
        input: provider.url,
        transport: 'websocket',
        affinity,
        body: streaming ? streamingBody(suffix) : requestBody(suffix),
        authorize: auth.authorize,
        onResponseHeaders: (headers) =>
          harvested.push(Object.fromEntries(headers.entries())),
      })
    const before = retainedExternalBytes()
    const first = await settleOrCancel(request('first'), relay.close)
    if (first.state !== 'fulfilled')
      throw new Error(`Oversized response missing: ${first.state}`)
    const response = first.value
    // The next request on the same affinity starts only once the first one
    // has ended, so its completion shows the first request stopped while its
    // body is still unread.
    const next = await settleOrCancel(request('second'), relay.close)
    if (next.state !== 'fulfilled')
      throw new Error(`Follow-up response missing: ${next.state}`)
    expect(await next.value.text()).toBe('{"id":"msg_after"}')
    // Every forward has finished and the relay and provider are shut down,
    // so their send buffers are gone; only the host's unread response can
    // still hold error bytes.
    await relay.close()
    expect(relay.outcomes).toEqual(['completed', 'completed'])
    expect(relay.delivered[0]?.bytes).toBeGreaterThan(12 * MIB)
    const held = retainedExternalBytes() - before
    expect(held).toBeLessThan(MIB + MIB / 2)
    expect(response.status).toBe(401)
    expect(response.headers.get('request-id')).toBe('req_big_401')
    expect(response.headers.get('anthropic-ratelimit-unified-reset')).toBe(
      QUOTA_RESET,
    )
    expect(await settleOrCancel(drainBody(response), relay.close)).toEqual({
      state: 'fulfilled',
      value: { text: OVERSIZED_ERROR_BODY, failure: undefined },
    })
    expect(harvested.map((headers) => headers['request-id'])).toEqual([
      'req_big_401',
      'req_after_oversized',
    ])
    expect(harvested[0]?.['anthropic-ratelimit-unified-status']).toBe(
      'rejected',
    )
    expect(provider.credentials).toEqual([OAT_V1, OAT_V2])
    expect(relay.sent).toHaveLength(2)
    expect(auth.observed).toEqual([
      [1, 401],
      [2, 200],
    ])
  })

  test(`a real 0.5 MiB WebSocket 401 under the bound is still scrubbed whole (streaming=${streaming})`, async () => {
    const provider = startProvider((credential) =>
      bigErrorReply(credential, 0.5),
    )
    const relay = startForwardingRelay(provider, () => ({
      kind: 'conforming',
      pieceBytes: 64 * 1024,
    }))
    const auth = authorizer([OAT_V1], true)
    const response = await send({
      relay,
      input: provider.url,
      transport: 'websocket',
      body: streaming ? streamingBody('first') : requestBody('first'),
      authorize: auth.authorize,
    })
    expect(response.status).toBe(401)
    expect(await settleOrCancel(drainBody(response), relay.close)).toEqual({
      state: 'fulfilled',
      value: {
        text: JSON.stringify(
          anthropicError(
            'authentication_error',
            `rejected ${PROVIDER_ERROR_REDACTION} ${'e'.repeat(MIB / 2)}`,
          ),
        ),
        failure: undefined,
      },
    })
    expect(provider.credentials).toEqual([OAT_V1])
  })

  test(`a real 3 MiB WebSocket JSON success passes through byte-identical (streaming=${streaming})`, async () => {
    const body = JSON.stringify({
      id: 'msg_large_success',
      content: [
        { type: 'text', text: `about ${OAT_V1} ${'s'.repeat(3 * MIB)}` },
      ],
    })
    const provider = startProvider(() => ({
      status: 200,
      reason: 'OK',
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_large_success',
      },
      body,
    }))
    const relay = startForwardingRelay(provider, () => ({
      kind: 'conforming',
      pieceBytes: 256 * 1024,
    }))
    const auth = authorizer([OAT_V1], true)
    const response = await send({
      relay,
      input: provider.url,
      transport: 'websocket',
      body: streaming ? streamingBody('first') : requestBody('first'),
      authorize: auth.authorize,
    })
    expect(response.status).toBe(200)
    expect(await settleOrCancel(drainBody(response), relay.close)).toEqual({
      state: 'fulfilled',
      value: { text: body, failure: undefined },
    })
    expect(auth.observed).toEqual([[1, 200]])
  })
}

/** A private TestLifetime: finish it explicitly or through outer-test cancellation. */
function privateLifetime(outer: FixtureLifetime = suiteLifetime) {
  const lifetime = new TestLifetime()
  let finishing: Promise<void> | undefined
  const finish = () => {
    finishing ??= lifetime.finish()
    return finishing
  }
  const closing = outer.gate()
  outer.trackDetached(closing.wait.then(finish))
  const life: FixtureLifetime = {
    gate: () => lifetime.gate(),
    trackDetached: (work) => lifetime.trackDetached(work),
  }
  return { lifetime, life, finish }
}

test('outer cancellation finishes a private control before its body is joined', async () => {
  const outer = new TestLifetime()
  let outerFinish: Promise<void> | undefined
  const finishOuter = () => {
    outerFinish ??= outer.finish()
    return outerFinish
  }
  let gates = 0
  let tracked = 0
  const { lifetime, life, finish } = privateLifetime({
    gate() {
      gates += 1
      return outer.gate()
    },
    trackDetached(work) {
      tracked += 1
      outer.trackDetached(work)
    },
  })
  // This gate makes enclosing-test teardown finish the private and outer
  // lifetimes, even if an assertion fails.
  const closing = gate()
  trackDetached(
    closing.wait.then(async () => {
      const results = await Promise.allSettled([finish(), finishOuter()])
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length)
        throw new AggregateError(failures, 'Control teardown failed')
    }),
  )
  let body: Promise<void> | undefined
  let parentBody: Promise<void> | undefined
  const log: string[] = []
  try {
    // Register the outer gate and detached finish before any private await,
    // so outer cancellation can release a stalled private body.
    expect(gates).toBe(1)
    expect(tracked).toBe(1)
    const held = life.gate()
    lifetime.deferCleanup(() => {
      log.push('cleanup')
    })
    body = lifetime.runBody(async () => {
      await held.wait
      log.push('body settled')
    })
    parentBody = outer.runBody(async () => {
      await body
    })
    expect(log).toEqual([])
    await finishOuter()
    expect(log).toEqual(['body settled', 'cleanup'])
  } finally {
    await Promise.allSettled([finish(), finishOuter(), body, parentBody])
  }
})

/** Return the work's final outcome, including settlement after cancellation. */
function joinedResult<T>(
  outcome: Settled<T> | CancelledThenSettled<T> | undefined,
) {
  return outcome?.state === 'cancelled' ? outcome.after : outcome
}

test('private TestLifetime.finish ends a WebSocket request whose provider never answers, and joins it', async () => {
  const { lifetime, life, finish } = privateLifetime()
  const provider = startProvider(() => HOLD, life)
  const relay = startForwardingRelay(
    provider,
    () => ({ kind: 'conforming' }),
    false,
    life,
  )
  const auth = authorizer([OAT_V1, OAT_V2], true)
  let request: Settled<Response> | CancelledThenSettled<Response> | undefined
  const body = lifetime.runBody(async () => {
    request = await settleOrCancel(
      send({
        relay,
        input: provider.url,
        transport: 'websocket',
        body: requestBody('held request'),
        authorize: auth.authorize,
      }),
      relay.close,
      life,
    )
  })
  // The provider really holds the forwarded request before teardown starts.
  await provider.firstRequest
  await finish()
  await body
  // Teardown closed the relay under the waiting request. Its WebSocket
  // retry could not reconnect, its HTTP relay fallback (the second
  // authorization) could not connect either, and only then did the request
  // itself reject; the body joined that rejection before finish returned.
  expect(request?.state).toBe('cancelled')
  const after = request?.state === 'cancelled' ? request.after : undefined
  expect(after?.state).toBe('rejected')
  expect(JSON.stringify(after)).not.toContain(OAT_V1)
  expect(JSON.stringify(after)).not.toContain(OAT_V2)
  expect({
    forwards: relay.outcomes,
    providerConnections: provider.connections,
    providerRequests: provider.credentials,
    physicalAttempts: relay.sent.length,
    authorizations: auth.calls(),
  }).toEqual({
    forwards: ['aborted'],
    providerConnections: { opened: 1, closed: 1 },
    providerRequests: [OAT_V1],
    physicalAttempts: 1,
    authorizations: 2,
  })
})

test('private TestLifetime.finish cancels an optimistic body whose provider never answers, and joins request and read', async () => {
  const { lifetime, life, finish } = privateLifetime()
  const provider = startProvider(() => HOLD, life)
  const relay = startForwardingRelay(
    provider,
    () => ({ kind: 'conforming' }),
    false,
    life,
  )
  const auth = authorizer([OAT_V1, OAT_V2], true)
  let request: Settled<Response> | CancelledThenSettled<Response> | undefined
  let drained:
    | Settled<Awaited<ReturnType<typeof drainBody>>>
    | CancelledThenSettled<Awaited<ReturnType<typeof drainBody>>>
    | undefined
  const body = lifetime.runBody(async () => {
    request = await settleOrCancel(
      send({
        relay,
        input: provider.url,
        transport: 'websocket',
        optimistic: true,
        body: streamingBody('held provider'),
        authorize: auth.authorize,
      }),
      relay.close,
      life,
    )
    if (request.state !== 'fulfilled') return
    drained = await settleOrCancel(
      drainBody(request.value, life),
      relay.close,
      life,
    )
  })
  // The provider really holds the forwarded request before teardown starts.
  await provider.firstRequest
  await finish()
  await body
  expect({
    request: request?.state,
    drained: joinedResult(drained),
    forwards: relay.outcomes,
    providerConnections: provider.connections,
    providerRequests: provider.credentials,
    physicalAttempts: relay.sent.length,
    authorizations: auth.calls(),
  }).toEqual({
    request: 'fulfilled',
    drained: { state: 'fulfilled', value: { text: '', failure: undefined } },
    forwards: ['aborted'],
    providerConnections: { opened: 1, closed: 1 },
    providerRequests: [OAT_V1],
    physicalAttempts: 1,
    authorizations: 1,
  })
})

test('private TestLifetime.finish cancels an HTTP body the provider never finishes, and joins request, read and handler', async () => {
  const { lifetime, life, finish } = privateLifetime()
  const total = 64 * 1024
  const sentBytes = 4096
  const provider = startProvider(
    () => ({
      status: 200,
      reason: 'OK',
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_held_body',
      },
      body: 'b'.repeat(total),
      heldAfter: sentBytes,
    }),
    life,
  )
  const relay = startForwardingRelay(
    provider,
    () => ({ kind: 'conforming' }),
    true,
    life,
  )
  const auth = authorizer([OAT_V1], true)
  let received = 0
  let allPartialBytes!: () => void
  const partialReceived = new Promise<void>((resolve) => {
    allPartialBytes = resolve
  })
  let request: Settled<Response> | CancelledThenSettled<Response> | undefined
  let drained:
    | Settled<Awaited<ReturnType<typeof drainBody>>>
    | CancelledThenSettled<Awaited<ReturnType<typeof drainBody>>>
    | undefined
  const body = lifetime.runBody(async () => {
    request = await settleOrCancel(
      send({
        relay,
        input: provider.url,
        transport: 'http',
        authorize: auth.authorize,
      }),
      relay.close,
      life,
    )
    if (request.state !== 'fulfilled') return
    drained = await settleOrCancel(
      drainBody(request.value, life, (chunk) => {
        received += chunk.byteLength
        if (received === sentBytes) allPartialBytes()
      }),
      relay.close,
      life,
    )
  })
  // Every byte the provider sent reached the host's reader before teardown.
  await partialReceived
  await finish()
  await body
  expect({
    request: request?.state,
    drained: joinedResult(drained),
    forwards: relay.outcomes,
    providerConnections: provider.connections,
    providerRequests: provider.credentials,
  }).toEqual({
    request: 'fulfilled',
    drained: {
      state: 'fulfilled',
      value: { text: 'b'.repeat(sentBytes), failure: undefined },
    },
    forwards: ['aborted'],
    providerConnections: { opened: 1, closed: 1 },
    providerRequests: [OAT_V1],
  })
})

/**
 * Run a real Node child against this test's Bun loopback relay and provider.
 * Register teardown's child-kill callback before awaiting the process or its
 * pipes, so a stalled child cannot prevent cancellation. Join each separately.
 */
async function nodeRelayClient(options: {
  relay: { url: string }
  provider: { url: string }
  streaming: boolean
  captureBytes?: boolean
  forceBlob?: boolean
}) {
  const node = Bun.which('node')
  if (!node) throw new Error('Node is required for the Node relay controls')
  const root = await mkdtemp(join(tmpdir(), 'anthropic-relay-node-'))
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const request = {
    relayUrl: options.relay.url,
    relayToken: RELAY_TOKEN,
    providerUrl: options.provider.url,
    token: OAT_V1,
    affinity: randomUUID(),
    body: options.streaming ? streamingBody('node') : requestBody('node'),
    captureBytes: options.captureBytes === true,
    forceBlob: options.forceBlob === true,
  }
  const script = `
    const { sendViaRelay } = await import(${JSON.stringify(relayPath)})
    const { setDumpEnabled } = await import(${JSON.stringify(dumpPath)})
    setDumpEnabled(false)
    const request = ${JSON.stringify(request)}
    if (request.forceBlob) {
      const NativeWebSocket = globalThis.WebSocket
      globalThis.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args)
          Object.defineProperty(this, 'binaryType', { get: () => 'blob', set() {} })
        }
      }
    }
    let authorizations = 0
    let result
    try {
      const response = await sendViaRelay({
        config: { enabled: true, url: request.relayUrl, token: request.relayToken, transport: 'websocket', fallbackToDirect: false },
        input: request.providerUrl,
        init: { method: 'POST' },
        headers: new Headers(),
        body: request.body,
        affinity: request.affinity,
        fallback: async () => { throw new Error('Unexpected direct fallback') },
        authorizeAttempt: async () => {
          authorizations += 1
          return { headers: new Headers({ authorization: 'Bearer ' + request.token, 'content-type': 'application/json' }), errorSecrets: [request.token] }
        },
      })
      const bytes = new Uint8Array(await response.arrayBuffer())
      result = { state: 'fulfilled', status: response.status, requestId: response.headers.get('request-id'), bodyNull: response.body === null, text: new TextDecoder().decode(bytes), ...(request.captureBytes ? { bodyBase64: Buffer.from(bytes).toString('base64') } : {}) }
    } catch (error) {
      result = { state: 'rejected', message: error instanceof Error ? error.message : String(error) }
    }
    console.log('NODE_RELAY_RESULT ' + JSON.stringify({ node: process.version, authorizations, ...result }))
    process.exit(0)
  `
  const child = Bun.spawn(
    [
      node,
      '--experimental-transform-types',
      '--no-warnings',
      '--input-type=module',
      '-e',
      script,
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        TMPDIR: root,
        OPENCODE_ANTHROPIC_AUTH_LOG_FILE: join(root, 'relay.log'),
        OPENCODE_ANTHROPIC_AUTH_DUMP_DIR: join(root, 'dumps'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  let exited = false
  const cancellation = gate()
  trackDetached(
    cancellation.wait.then(() => {
      if (!exited) child.kill()
    }),
  )
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    const [exit, out, err] = await Promise.allSettled([
      child.exited,
      stdout,
      stderr,
    ])
    exited = true
    if (
      exit.status !== 'fulfilled' ||
      out.status !== 'fulfilled' ||
      err.status !== 'fulfilled'
    )
      throw new AggregateError(
        [exit, out, err].flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        ),
        'Node relay child drainage failed',
      )
    const line = out.value
      .split('\n')
      .find((entry) => entry.startsWith('NODE_RELAY_RESULT '))
    return {
      exit: exit.value,
      stderr: err.value,
      result: line
        ? (JSON.parse(line.slice('NODE_RELAY_RESULT '.length)) as Record<
            string,
            unknown
          >)
        : undefined,
    }
  } finally {
    cancellation.open()
  }
}

/** Keep the child's actual Node major without assuming the runner's installed version. */
function majorVersionOnly(child: Awaited<ReturnType<typeof nodeRelayClient>>) {
  const node = child.result?.node
  const result: Record<string, unknown> | undefined = child.result && {
    ...child.result,
    node: typeof node === 'string' ? node.split('.')[0] : node,
  }
  return { ...child, result }
}

for (const status of [204, 205, 304] as const) {
  for (const streaming of [false, true]) {
    test(`a real Node relay client settles a real provider ${status} as an empty response (streaming=${streaming})`, async () => {
      const provider = startProvider(() => ({
        status,
        reason: 'Provider',
        headers: { 'request-id': `req_node_${status}` },
      }))
      const relay = startForwardingRelay(provider, () => ({
        kind: 'conforming',
      }))
      const child = await nodeRelayClient({ relay, provider, streaming })
      expect(majorVersionOnly(child)).toEqual({
        exit: 0,
        stderr: '',
        result: {
          node: expect.stringMatching(/^v\d+$/),
          authorizations: 1,
          state: 'fulfilled',
          status,
          requestId: `req_node_${status}`,
          bodyNull: true,
          text: '',
        },
      })
      expect(provider.credentials).toEqual([OAT_V1])
      expect(relay.sent).toHaveLength(1)
    })
  }
}

for (const [kind, start] of [
  ['status 600', () => ({ status: 600 })],
  [
    'a header value with a line break',
    (forwarded: ForwardedStart) => ({
      headers: {
        ...forwarded.headers,
        'x-provider-detail': `rejected\n${OAT_V1}`,
      },
    }),
  ],
] as const) {
  test(`a real Node relay client fails a response_start with ${kind} closed, without another attempt`, async () => {
    const provider = startProvider(() => ({
      status: 200,
      reason: 'OK',
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_node_malformed',
      },
      body: '{"id":"msg_ok"}',
    }))
    const relay = startForwardingRelay(provider, () => ({
      kind: 'malformed',
      start,
    }))
    const child = await nodeRelayClient({ relay, provider, streaming: false })
    expect(majorVersionOnly(child)).toEqual({
      exit: 0,
      stderr: '',
      result: {
        node: expect.stringMatching(/^v\d+$/),
        authorizations: 1,
        state: 'rejected',
        message: MALFORMED_START,
      },
    })
    expect(provider.credentials).toEqual([OAT_V1])
    expect(relay.sent).toHaveLength(1)
  })
}

for (const streaming of [false, true]) {
  test(`a real Node relay client preserves every successful binary response byte (streaming=${streaming})`, async () => {
    const body = streaming
      ? `: keepalive\r\n\r\n${sseFrame('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: `αβ ${OAT_V1}` } })}`
      : JSON.stringify({ text: `αβ ${OAT_V1}`, newline: '\r\n' })
    const provider = startProvider(() => ({
      status: 200,
      reason: 'OK',
      headers: {
        'content-type': streaming ? 'text/event-stream' : 'application/json',
        'request-id': 'req_node_bytes',
      },
      body,
    }))
    const relay = startForwardingRelay(provider, () => ({ kind: 'conforming' }))
    const child = await nodeRelayClient({
      relay,
      provider,
      streaming,
      captureBytes: true,
    })
    expect(child.exit).toBe(0)
    expect(child.stderr).toBe('')
    expect(child.result?.state).toBe('fulfilled')
    expect(child.result?.status).toBe(200)
    expect(child.result?.bodyBase64).toBe(Buffer.from(body).toString('base64'))
    expect(provider.credentials).toEqual([OAT_V1])
    expect(relay.sent).toHaveLength(1)
  })
}

test('a real Node relay client scrubs a binary SSE error frame', async () => {
  const body = sseFrame('error', {
    type: 'error',
    error: { type: 'api_error', message: `provider echoed ${OAT_V1}` },
  })
  const provider = startProvider(() => ({
    status: 200,
    reason: 'OK',
    headers: {
      'content-type': 'text/event-stream',
      'request-id': 'req_node_error',
    },
    body,
  }))
  const relay = startForwardingRelay(provider, () => ({ kind: 'conforming' }))
  const child = await nodeRelayClient({
    relay,
    provider,
    streaming: true,
    captureBytes: true,
  })
  expect(child.exit).toBe(0)
  expect(child.stderr).toBe('')
  expect(child.result?.state).toBe('fulfilled')
  expect(child.result?.text).toContain('api_error')
  expect(child.result?.text).toContain(PROVIDER_ERROR_REDACTION)
  expect(child.result?.text).not.toContain(OAT_V1)
  expect(provider.credentials).toEqual([OAT_V1])
  expect(relay.sent).toHaveLength(1)
})

test('a real Node relay client refuses forced Blob frames rather than stringify them', async () => {
  const provider = startProvider(() => ({
    status: 200,
    reason: 'OK',
    headers: {
      'content-type': 'application/json',
      'request-id': 'req_node_blob',
    },
    body: '{"text":"actual provider bytes"}',
  }))
  const relay = startForwardingRelay(provider, () => ({ kind: 'conforming' }))
  const child = await nodeRelayClient({
    relay,
    provider,
    streaming: false,
    forceBlob: true,
  })
  expect(child.exit).toBe(0)
  expect(child.stderr).toBe('')
  expect(child.result?.state).toBe('rejected')
  expect(child.result?.message).toBe(
    'relay websocket binary frame must be an ArrayBuffer or byte view',
  )
  expect(provider.credentials).toEqual([OAT_V1])
  expect(relay.sent).toHaveLength(1)
})
