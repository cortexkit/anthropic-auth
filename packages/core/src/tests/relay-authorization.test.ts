import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { type RelayConfig, sendViaRelay } from '../relay.ts'

const routingKey = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const previousRouting = globals[routingKey]
afterEach(() => {
  if (previousRouting === undefined) delete globals[routingKey]
  else globals[routingKey] = previousRouting
})
function captureBilling() {
  const reports: Record<string, unknown>[] = []
  globals[routingKey] = () => ({
    report: (payload: Record<string, unknown>) => reports.push(payload),
  })
  return reports
}
const billing = (attempt: number) => ({
  sessionId: 'session',
  credentialId: `credential-${attempt}`,
  model: 'test-model',
  requestKind: 'primary' as const,
})

const body = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: 'x'.repeat(8000) + suffix }],
  })
/** A model request asking for a streamed response, needed for an optimistic relay response. */
const streamingBody = (suffix: string) =>
  JSON.stringify({
    model: 'test-model',
    stream: true,
    messages: [{ role: 'user', content: 'x'.repeat(8000) + suffix }],
  })
const config = (
  url: string,
  transport: 'http' | 'websocket' = 'http',
): RelayConfig => ({
  enabled: true,
  url,
  transport,
  token: 'test-relay-secret',
  fallbackToDirect: true,
})

test('HTTP patch recovery reauthorizes and binds status to the final upstream attempt', async () => {
  const billingReports = captureBilling()
  const sent: Array<{
    mode: string
    upstream: { headers: Record<string, string> }
  }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const payload = (await request.json()) as {
        mode: string
        upstream: { headers: Record<string, string> }
      }
      sent.push(payload)
      if (sent.length === 2) return new Response('', { status: 409 })
      return new Response('response', {
        status: sent.length === 1 ? 200 : 401,
        headers: { 'request-id': 'req_test' },
      })
    },
  })
  let authorizations = 0,
    fallbacks = 0
  const observed: number[][] = []
  const affinity = randomUUID()
  const send = (text: string) =>
    sendViaRelay({
      config: config(server.url.href),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body(text),
      affinity,
      fallback: async () => {
        fallbacks++
        return new Response('unexpected direct')
      },
      authorizeAttempt: async () => {
        const attempt = ++authorizations
        return {
          headers: new Headers({ authorization: `Bearer test-${attempt}` }),
          billing: billing(attempt),
          onUpstreamStatus: (status) => {
            observed.push([attempt, status])
          },
        }
      },
    })
  try {
    await (await send('first')).text()
    const response = await send('second')
    expect(response.status).toBe(401)
    await response.text()
    expect(sent.map((entry) => entry.mode)).toEqual([
      'full_sync',
      'patch',
      'full_sync',
    ])
    expect(sent.map((entry) => entry.upstream.headers.authorization)).toEqual([
      'Bearer test-1',
      'Bearer test-2',
      'Bearer test-3',
    ])
    expect(observed).toEqual([
      [1, 200],
      [3, 401],
    ])
    expect(fallbacks).toBe(0)
    await Bun.sleep(10)
    expect(billingReports).toHaveLength(2)
    expect(billingReports[0]).toMatchObject({
      credential_id: 'credential-1',
      status: 200,
    })
    expect(billingReports[1]).toMatchObject({
      credential_id: 'credential-3',
      status: 401,
      outcome: 'failed',
    })
  } finally {
    await server.stop(true)
  }
})

test('revocation before a retry cannot fall through to HTTP or direct dispatch', async () => {
  let posts = 0,
    gets = 0,
    fallbacks = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('', { status: ++posts === 1 ? 200 : 409 }),
  })
  const affinity = randomUUID()
  const send = (text: string) =>
    sendViaRelay({
      config: config(server.url.href),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body(text),
      affinity,
      fallback: async () => {
        fallbacks++
        return new Response('unauthorized fallback')
      },
      authorizeAttempt: async () => {
        if (++gets === 3) throw new Error('enrollment revoked')
        return {
          headers: new Headers({ authorization: `Bearer test-${gets}` }),
        }
      },
    })
  try {
    await (await send('first')).text()
    await expect(send('second')).rejects.toThrow('enrollment revoked')
    expect(posts).toBe(2)
    expect(gets).toBe(3)
    expect(fallbacks).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test('a relay transport 401 without upstream provenance falls back direct without blaming OAuth', async () => {
  const billingReports = captureBilling()
  let observed = 0
  let direct = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('wrong relay secret', { status: 401 }),
  })
  try {
    const response = await sendViaRelay({
      config: config(server.url.href),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body('first'),
      affinity: randomUUID(),
      fallback: async () => {
        direct++
        return new Response('direct-ok', { status: 200 })
      },
      authorizeAttempt: async () => ({
        headers: new Headers({ authorization: 'Bearer test-access' }),
        billing: billing(1),
        onUpstreamStatus: () => {
          observed++
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('direct-ok')
    expect(direct).toBe(1)
    expect(observed).toBe(0)
    await Bun.sleep(10)
    expect(billingReports).toEqual([])
  } finally {
    await server.stop(true)
  }
})

// A direct fallback can fail after its request already reached Anthropic,
// for example when the connection resets after the body was sent. Sending it
// again would bill the same request twice, so its error goes to the caller.
for (const [label, status] of [
  ['a relay 5xx', 503],
  ['a relay-only 401', 401],
] as const) {
  test(`a direct fallback after ${label} that fails is not sent again`, async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('relay unavailable', { status }),
    })
    let direct = 0
    try {
      await expect(
        sendViaRelay({
          config: config(server.url.href),
          input: 'https://api.anthropic.com/v1/messages',
          init: { method: 'POST' },
          headers: new Headers(),
          body: body(`failed-fallback-${status}`),
          affinity: randomUUID(),
          fallback: async () => {
            direct++
            throw new Error('connection reset after the request was sent')
          },
          authorizeAttempt: async () => ({
            headers: new Headers({ authorization: 'Bearer test-access' }),
          }),
        }),
      ).rejects.toThrow('connection reset after the request was sent')
      expect(direct).toBe(1)
    } finally {
      await server.stop(true)
    }
  })
}

test('a failed WebSocket relay whose HTTP relay fallback falls back direct and fails is not sent again', async () => {
  // Refusing the upgrade fails the WebSocket; the HTTP relay then answers 503.
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('relay unavailable', { status: 503 }),
  })
  let direct = 0
  try {
    await expect(
      sendViaRelay({
        config: config(server.url.href, 'websocket'),
        input: 'https://api.anthropic.com/v1/messages',
        init: { method: 'POST' },
        headers: new Headers(),
        body: body('failed-websocket-fallback'),
        affinity: randomUUID(),
        fallback: async () => {
          direct++
          throw new Error('connection reset after the request was sent')
        },
        authorizeAttempt: async () => ({
          headers: new Headers({ authorization: 'Bearer test-access' }),
        }),
      }),
    ).rejects.toThrow('connection reset after the request was sent')
    expect(direct).toBe(1)
  } finally {
    server.stop(true)
  }
})

test('a relay that fails before any direct fallback still falls back direct once', async () => {
  // A stopped server leaves a port that refuses connections, so the relay
  // POST itself rejects before the relay could forward anything.
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('unused'),
  })
  const url = server.url.href
  await server.stop(true)
  let direct = 0
  const response = await sendViaRelay({
    config: config(url),
    input: 'https://api.anthropic.com/v1/messages',
    init: { method: 'POST' },
    headers: new Headers(),
    body: body('relay-unreachable'),
    affinity: randomUUID(),
    fallback: async () => {
      direct++
      return new Response('direct-ok', { status: 200 })
    },
    authorizeAttempt: async () => ({
      headers: new Headers({ authorization: 'Bearer test-access' }),
    }),
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('direct-ok')
  expect(direct).toBe(1)
})

test('optimistic WebSocket reconnect uses a fresh receipt without reporting its synthetic 200', async () => {
  const billingReports = captureBilling()
  const sent: Array<{
    id: string
    upstream: { headers: Record<string, string> }
  }> = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request)
        ? undefined
        : new Response('unexpected HTTP', { status: 500 }),
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null }))
      },
      message: (socket, data) => {
        const payload = JSON.parse(String(data)) as {
          id: string
          upstream: { headers: Record<string, string> }
        }
        sent.push(payload)
        if (sent.length === 1) {
          socket.close(1011, 'interrupted before upstream')
          return
        }
        socket.send(
          JSON.stringify({
            type: 'response_start',
            id: payload.id,
            status: 401,
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    },
  })
  let gets = 0,
    fallbacks = 0
  const observed: number[][] = []
  try {
    const response = await sendViaRelay({
      config: config(server.url.href, 'websocket'),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: streamingBody('first'),
      affinity: randomUUID(),
      optimisticResponse: true,
      fallback: async () => {
        fallbacks++
        throw new Error('unexpected direct fallback')
      },
      authorizeAttempt: async () => {
        const attempt = ++gets
        return {
          headers: new Headers({ authorization: `Bearer test-${attempt}` }),
          billing: billing(attempt),
          onUpstreamStatus: (status) => {
            observed.push([attempt, status])
          },
        }
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
    expect(await response.text()).toContain('Relay upstream returned HTTP 401')
    expect(sent.map((entry) => entry.upstream.headers.authorization)).toEqual([
      'Bearer test-1',
      'Bearer test-2',
    ])
    expect(observed).toEqual([[2, 401]])
    expect(fallbacks).toBe(0)
    await Bun.sleep(10)
    expect(billingReports).toHaveLength(1)
    expect(billingReports[0]).toMatchObject({
      credential_id: 'credential-2',
      outcome: 'failed',
      status: 401,
    })
  } finally {
    // Bun closes the upgraded socket but its stop() promise remains pending
    // for an idle persistent relay session; don't hold the test on that waiter.
    server.stop(true)
  }
})

test('WebSocket billing observes real upstream usage and response identity', async () => {
  const reports = captureBilling()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request) ? undefined : new Response('', { status: 500 }),
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null }))
      },
      message: (socket, data) => {
        const payload = JSON.parse(String(data)) as { id: string }
        socket.send(
          JSON.stringify({
            type: 'response_start',
            id: payload.id,
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'request-id': 'req_ws',
            },
          }),
        )
        const text = [
          {
            type: 'message_start',
            message: {
              id: 'msg_ws',
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          },
          {
            type: 'message_delta',
            usage: {
              output_tokens: 7,
              output_tokens_details: { thinking_tokens: 2 },
            },
          },
          { type: 'message_stop' },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join('')
        socket.send(
          JSON.stringify({
            type: 'chunk',
            id: payload.id,
            base64: Buffer.from(text).toString('base64'),
          }),
        )
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    },
  })
  try {
    const response = await sendViaRelay({
      config: config(server.url.href, 'websocket'),
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: streamingBody('usage'),
      affinity: randomUUID(),
      optimisticResponse: true,
      fallback: async () => {
        throw new Error('Unexpected direct fallback')
      },
      authorizeAttempt: async () => ({
        headers: new Headers(),
        billing: billing(1),
      }),
    })
    await response.text()
    await Bun.sleep(10)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      credential_id: 'credential-1',
      outcome: 'completed',
      status: 200,
      provider_request_id: 'req_ws',
      provider_response_id: 'msg_ws',
      usage: {
        input: 3,
        output: 7,
        reasoning: 2,
        reasoning_included_in_output: true,
      },
    })
  } finally {
    server.stop(true)
  }
})

test('a relay-only transport 401 without upstream provenance is not surfaced as an account 401', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('wrong relay secret', { status: 401 }),
  })
  let direct = 0,
    observed = 0
  try {
    const response = await sendViaRelay({
      config: { ...config(server.url.href), fallbackToDirect: false },
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers: new Headers(),
      body: body('relay-only'),
      affinity: randomUUID(),
      fallback: async () => {
        direct++
        return new Response('unexpected')
      },
      authorizeAttempt: async () => ({
        headers: new Headers({ authorization: 'Bearer valid-account' }),
        onUpstreamStatus: () => {
          observed++
        },
      }),
    })
    expect(response.status).toBe(502)
    expect((await response.text()).toLowerCase()).toContain('relay')
    expect(direct).toBe(0)
    expect(observed).toBe(0)
  } finally {
    await server.stop(true)
  }
})
