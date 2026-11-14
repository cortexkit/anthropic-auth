// Relay sends that must not happen: a plain-text relay send that a proxy
// setting would carry, a `ws:` relay reached over TLS, and a WebSocket
// session that keeps using the relay URL or token it was created with.
import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  RELAY_PROXY_REFUSAL,
  type RelayConfig,
  relayProxyApplies,
  sendViaRelay,
} from '../relay.ts'

const PROXY_KEYS = ['HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const
const savedProxy = PROXY_KEYS.map((key) => [key, process.env[key]] as const)
afterEach(() => {
  for (const [key, value] of savedProxy)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
})
function clearProxy() {
  for (const key of PROXY_KEYS) delete process.env[key]
}

const body = JSON.stringify({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
})

function config(url: string, options: Partial<RelayConfig> = {}): RelayConfig {
  return {
    enabled: true,
    url,
    token: 'test-relay-secret',
    transport: 'http',
    fallbackToDirect: true,
    ...options,
  }
}

/**
 * A loopback relay that refuses WebSocket upgrades and answers HTTP relay
 * posts; it records each request as `<method> <path>`, marking upgrades.
 */
function relayServer() {
  const seen: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        seen.push(`upgrade ${path}`)
        return new Response('no websocket here', { status: 503 })
      }
      seen.push(`${request.method} ${path}`)
      return new Response('relayed', {
        headers: { 'request-id': 'req_relay_test' },
      })
    },
  })
  return { server, seen, http: server.url.href.replace(/\/$/, '') }
}

async function send(
  relay: RelayConfig,
  affinity = randomUUID(),
  authorize: () => void = () => {},
) {
  const direct: string[] = []
  const response = await sendViaRelay({
    config: relay,
    input: 'https://api.anthropic.com/v1/messages',
    init: { method: 'POST' },
    headers: new Headers(),
    body,
    affinity,
    fallback: async () => {
      direct.push('direct')
      return new Response('direct')
    },
    authorizeAttempt: async () => {
      authorize()
      return { headers: new Headers({ authorization: 'Bearer test-access' }) }
    },
  })
  return { text: await response.text(), direct }
}

/** Sets a proxy that would carry plain-http relay sends. */
function startProxy() {
  // An address nothing listens on: the proxy must never be reached.
  process.env.HTTP_PROXY = 'http://127.0.0.1:9'
}

test('a plain relay URL counts as proxied exactly when a proxy setting would carry it', () => {
  const env = { HTTP_PROXY: 'http://proxy.example.test:8080' }
  expect(relayProxyApplies('http://relay.example.test/', env)).toBe(true)
  expect(relayProxyApplies('ws://relay.example.test/', env)).toBe(true)
  expect(
    relayProxyApplies('http://relay.example.test/', { http_proxy: 'x' }),
  ).toBe(true)
  expect(relayProxyApplies('https://relay.example.test/', env)).toBe(false)
  expect(relayProxyApplies('wss://relay.example.test/', env)).toBe(false)
  expect(relayProxyApplies('http://relay.example.test/', {})).toBe(false)
  expect(
    relayProxyApplies('http://relay.example.test/', {
      ...env,
      NO_PROXY: 'relay.example.test',
    }),
  ).toBe(false)
  expect(relayProxyApplies('not a url', env)).toBe(true)
})

test('a plain-http relay send that a proxy would carry is refused: direct with fallbackToDirect, an error without', async () => {
  const relay = relayServer()
  try {
    clearProxy()
    // An address nothing listens on: the proxy must never be reached.
    process.env.HTTP_PROXY = 'http://127.0.0.1:9'
    expect(await send(config(`${relay.http}/relay`))).toEqual({
      text: 'direct',
      direct: ['direct'],
    })
    await expect(
      send(config(`${relay.http}/relay`, { fallbackToDirect: false })),
    ).rejects.toThrow(RELAY_PROXY_REFUSAL)
    // A WebSocket relay on a plain URL is refused the same way, before any
    // socket or HTTP rescue.
    expect(
      await send(config(`${relay.http}/relay`, { transport: 'websocket' })),
    ).toEqual({ text: 'direct', direct: ['direct'] })
    expect(relay.seen).toEqual([])
    // NO_PROXY exempting the relay host lets the relay be used.
    process.env.NO_PROXY = '127.0.0.1'
    expect(await send(config(`${relay.http}/relay`))).toEqual({
      text: 'relayed',
      direct: [],
    })
    expect(relay.seen).toEqual(['POST /relay'])
  } finally {
    relay.server.stop(true)
  }
})

test('a ws: relay stays plain: its socket uses ws: and its HTTP rescue uses http:', async () => {
  clearProxy()
  const relay = relayServer()
  try {
    const wsUrl = relay.http.replace(/^http:/, 'ws:')
    expect(await send(config(`${wsUrl}/`, { transport: 'websocket' }))).toEqual(
      { text: 'relayed', direct: [] },
    )
    expect(relay.seen).toEqual(['upgrade /ws', 'POST /'])
  } finally {
    relay.server.stop(true)
  }
})

test('a WebSocket session is not reused for another relay URL or token', async () => {
  clearProxy()
  const first = relayServer()
  const second = relayServer()
  try {
    const affinity = randomUUID()
    const websocket = { transport: 'websocket' as const }
    await send(config(first.http, websocket), affinity)
    expect(first.seen).toEqual(['upgrade /ws', 'POST /'])
    // The same conversation after the relay changed: the old relay gets
    // nothing more.
    await send(config(second.http, websocket), affinity)
    expect(first.seen).toEqual(['upgrade /ws', 'POST /'])
    expect(second.seen).toEqual(['upgrade /ws', 'POST /'])
    // A new token for the same relay gets a new socket with that token.
    const tokens: string[] = []
    const third = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket')
          tokens.push(url.searchParams.get('token') ?? '<none>')
        return new Response('no websocket here', { status: 503 })
      },
    })
    try {
      const url = third.url.href
      await send(config(url, { ...websocket, token: 'token-one' }), affinity)
      await send(config(url, { ...websocket, token: 'token-two' }), affinity)
      expect(tokens).toEqual(['token-one', 'token-two'])
    } finally {
      third.stop(true)
    }
  } finally {
    first.server.stop(true)
    second.server.stop(true)
  }
})

test('a proxy set while an HTTP relay attempt is authorized stops that post: direct with fallbackToDirect, an error without', async () => {
  clearProxy()
  const relay = relayServer()
  try {
    expect(
      await send(config(`${relay.http}/relay`), randomUUID(), startProxy),
    ).toEqual({ text: 'direct', direct: ['direct'] })
    clearProxy()
    await expect(
      send(
        config(`${relay.http}/relay`, { fallbackToDirect: false }),
        randomUUID(),
        startProxy,
      ),
    ).rejects.toThrow(RELAY_PROXY_REFUSAL)
    expect(relay.seen).toEqual([])
  } finally {
    relay.server.stop(true)
  }
})

test("a proxy set during a WebSocket relay's HTTP rescue stops the rescue post", async () => {
  clearProxy()
  const relay = relayServer()
  try {
    // The upgrade is refused before any attempt is authorized, so the only
    // authorization is the rescue's, and the proxy appears during it.
    expect(
      await send(
        config(relay.http, { transport: 'websocket' }),
        randomUUID(),
        startProxy,
      ),
    ).toEqual({ text: 'direct', direct: ['direct'] })
    expect(relay.seen).toEqual(['upgrade /ws'])
  } finally {
    relay.server.stop(true)
  }
})

test('a proxy set while the 409 full-sync retry is authorized stops the retry post', async () => {
  clearProxy()
  const seen: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { mode } = (await request.json()) as { mode: string }
      seen.push(mode)
      // The relay lost this conversation's state, so a patch needs a full copy.
      if (mode === 'patch') return new Response('stale', { status: 409 })
      return new Response('relayed', {
        headers: { 'request-id': 'req_relay_test' },
      })
    },
  })
  try {
    const relay = config(server.url.href)
    const affinity = randomUUID()
    expect(await send(relay, affinity)).toEqual({
      text: 'relayed',
      direct: [],
    })
    // The second request is sent as a patch; its 409 retry is the second
    // authorization, and the proxy appears there.
    let authorizations = 0
    expect(
      await send(relay, affinity, () => {
        authorizations += 1
        if (authorizations === 2) startProxy()
      }),
    ).toEqual({ text: 'direct', direct: ['direct'] })
    expect(authorizations).toBe(2)
    expect(seen).toEqual(['full_sync', 'patch'])
  } finally {
    server.stop(true)
  }
})
