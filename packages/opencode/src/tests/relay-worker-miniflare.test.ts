import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  hashBody,
  sendViaRelay,
  WORKER_SCRIPT,
} from '@cortexkit/anthropic-auth-core'
import { Miniflare, NoOpLog } from 'miniflare'

const RELAY_TOKEN = 'relay-token'
const WORKER_STARTUP_TIMEOUT_MS = 90_000
const WORKER_STARTUP_TIMEOUT_MESSAGE =
  'Miniflare worker startup timed out under load (issue #176) — not a websocket-logic failure'

type ControlMessage = {
  type: string
  id?: string
  status?: number
  message?: string
  headers?: Record<string, string>
  state?: { hash: string; revision: number } | null
  hash?: string
  revision?: number
}

type WorkerSocket = {
  socket: WebSocket
  controls: ControlMessage[]
  binaryChunks: Uint8Array[]
  waitForControl: (
    predicate: (message: ControlMessage) => boolean,
  ) => Promise<ControlMessage>
}

function createUpstream() {
  const bodies: string[] = []
  const fetch = async (request: Request) => {
    bodies.push(await request.text())
    return new Response('upstream-ok', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'anthropic-ratelimit-unified-5h-utilization': '0.78',
        'anthropic-ratelimit-unified-5h-reset': '1784246400',
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
        'anthropic-ratelimit-unified-7d-reset': '1784628000',
        'anthropic-ratelimit-unified-fallback': 'available',
      },
    })
  }
  return { bodies, fetch, url: 'https://upstream.test/messages' }
}

async function waitForWorkerReady(
  mf: Pick<Miniflare, 'ready'>,
  timeoutMs = WORKER_STARTUP_TIMEOUT_MS,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(WORKER_STARTUP_TIMEOUT_MESSAGE)),
      timeoutMs,
    )
  })

  try {
    return await Promise.race([mf.ready, timeoutPromise])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function startWorker(upstream: ReturnType<typeof createUpstream>) {
  const mf = new Miniflare({
    script: WORKER_SCRIPT,
    modules: true,
    compatibilityDate: '2026-04-28',
    kvNamespaces: ['RELAY_STATE'],
    bindings: { RELAY_TOKEN },
    outboundService: upstream.fetch,
    port: 0,
    log: new NoOpLog(),
  })
  try {
    await waitForWorkerReady(mf)
  } catch (error) {
    try {
      await mf.dispose()
    } catch {
      // Preserve the named startup failure when cleanup also fails.
    }
    throw error
  }
  return mf
}

async function connectWorkerSocket(
  mf: Miniflare,
  affinity: string,
): Promise<WorkerSocket> {
  const url = new URL(await waitForWorkerReady(mf))
  url.protocol = 'ws:'
  url.pathname = '/ws'
  url.searchParams.set('token', RELAY_TOKEN)
  url.searchParams.set('affinity', affinity)

  const controls: ControlMessage[] = []
  const binaryChunks: Uint8Array[] = []
  const waiters = new Set<{
    predicate: (message: ControlMessage) => boolean
    resolve: (message: ControlMessage) => void
    reject: (error: unknown) => void
    timeout: ReturnType<typeof setTimeout>
  }>()

  const socket = new WebSocket(url.toString())
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data) as ControlMessage
      controls.push(message)
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue
        clearTimeout(waiter.timeout)
        waiters.delete(waiter)
        waiter.resolve(message)
      }
      return
    }

    if (event.data instanceof ArrayBuffer) {
      binaryChunks.push(new Uint8Array(event.data))
      return
    }
    if (ArrayBuffer.isView(event.data)) {
      binaryChunks.push(
        new Uint8Array(
          event.data.buffer,
          event.data.byteOffset,
          event.data.byteLength,
        ),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Miniflare websocket open timed out')),
      5_000,
    )
    socket.addEventListener('open', () => {
      clearTimeout(timeout)
      resolve()
    })
    socket.addEventListener('error', reject)
  })

  const waitForControl = (predicate: (message: ControlMessage) => boolean) => {
    const existing = controls.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<ControlMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error('Miniflare websocket control message timed out'))
        }, 5_000),
      }
      waiters.add(waiter)
    })
  }

  await waitForControl((message) => message.type === 'ready')
  return { socket, controls, binaryChunks, waitForControl }
}

function sendPayload(socket: WebSocket, payload: Record<string, unknown>) {
  socket.send(JSON.stringify(payload))
}

describe('relay Worker under Miniflare', () => {
  let upstream: ReturnType<typeof createUpstream>
  let mf: Miniflare

  beforeAll(
    async () => {
      upstream = createUpstream()
      mf = await startWorker(upstream)
    },
    { timeout: WORKER_STARTUP_TIMEOUT_MS + 10_000 },
  )

  afterAll(async () => {
    // A startup timeout leaves mf unassigned; disposing undefined would bury
    // the named startup error under a TypeError.
    await mf?.dispose()
  })

  test('names a worker startup timeout', async () => {
    const neverReady = { ready: new Promise<URL>(() => {}) } as Miniflare

    await expect(waitForWorkerReady(neverReady, 1)).rejects.toThrow(
      'Miniflare worker startup timed out under load (issue #176) — not a websocket-logic failure',
    )
  })

  test('HTTP relay forwards upstream unified quota headers', async () => {
    const startLen = upstream.bodies.length
    const response = await sendViaRelay({
      config: {
        enabled: true,
        url: (await waitForWorkerReady(mf)).toString(),
        token: RELAY_TOKEN,
        fallbackToDirect: false,
        transport: 'http',
      },
      input: upstream.url,
      init: { method: 'POST' },
      headers: new Headers({
        authorization: 'Bearer test-token',
        'x-session-affinity': 'miniflare-http-session',
      }),
      body: '{}',
      fallback: async () => new Response('direct'),
    })

    expect(
      response.headers.get('anthropic-ratelimit-unified-5h-utilization'),
    ).toBe('0.78')
    expect(response.headers.get('anthropic-ratelimit-unified-fallback')).toBe(
      'available',
    )
    expect(await response.text()).toBe('upstream-ok')
    expect(upstream.bodies.slice(startLen)).toEqual(['{}'])
  }, 30_000)

  test('client websocket transport reaches Miniflare Worker with byte-exact patch reconstruction', async () => {
    const startLen = upstream.bodies.length
    const affinity = 'miniflare-client-session'

    const firstBody = `client prefix cch=aaaaa; ${'x'.repeat(2048)} tail`
    const secondBody = `client prefix cch=bbbbb; ${'x'.repeat(2048)} tail!`
    const relayUrl = (await waitForWorkerReady(mf)).toString()
    const relayConfig = {
      enabled: true,
      url: relayUrl,
      token: RELAY_TOKEN,
      fallbackToDirect: false,
      transport: 'websocket' as const,
    }
    const requestHeaders = () =>
      new Headers({
        'x-session-affinity': affinity,
        authorization: 'Bearer test-token',
      })

    const first = await sendViaRelay({
      config: relayConfig,
      input: `${upstream.url}?beta=true`,
      init: { method: 'POST' },
      headers: requestHeaders(),
      body: firstBody,
      fallback: async () => new Response('direct'),
    })
    expect(await first.text()).toBe('upstream-ok')
    expect(
      first.headers.get('anthropic-ratelimit-unified-5h-utilization'),
    ).toBe('0.78')
    expect(first.headers.get('anthropic-ratelimit-unified-fallback')).toBe(
      'available',
    )

    const second = await sendViaRelay({
      config: relayConfig,
      input: `${upstream.url}?beta=true`,
      init: { method: 'POST' },
      headers: requestHeaders(),
      body: secondBody,
      fallback: async () => new Response('direct'),
    })
    expect(await second.text()).toBe('upstream-ok')
    expect(upstream.bodies.slice(startLen)).toEqual([firstBody, secondBody])
  }, 30_000)

  test('websocket full_sync and patch reconstruct byte-exact upstream bodies', async () => {
    const startLen = upstream.bodies.length
    const workerSocket = await connectWorkerSocket(
      mf,
      'miniflare-byte-exact-session',
    )

    const firstBody = `prefix cch=aaaaa; ${'x'.repeat(1024)} tail`
    const secondBody = `prefix cch=bbbbb; ${'x'.repeat(1024)} tail!`
    const cchStart = firstBody.indexOf('aaaaa')

    sendPayload(workerSocket.socket, {
      protocol: 2,
      type: 'request',
      id: 'req_full_sync',
      affinity: 'ignored-client-affinity',
      upstream: { url: upstream.url, method: 'POST', headers: {} },
      next_hash: hashBody(firstBody),
      mode: 'full_sync',
      revision: 1,
      body: firstBody,
    })
    const responseStart = await workerSocket.waitForControl(
      (message) =>
        message.type === 'response_start' && message.id === 'req_full_sync',
    )
    expect(
      responseStart.headers?.['anthropic-ratelimit-unified-5h-utilization'],
    ).toBe('0.78')
    expect(
      responseStart.headers?.['anthropic-ratelimit-unified-fallback'],
    ).toBe('available')
    await workerSocket.waitForControl(
      (message) => message.type === 'done' && message.id === 'req_full_sync',
    )

    sendPayload(workerSocket.socket, {
      protocol: 2,
      type: 'request',
      id: 'req_patch',
      affinity: 'ignored-client-affinity',
      upstream: { url: upstream.url, method: 'POST', headers: {} },
      base_hash: hashBody(firstBody),
      next_hash: hashBody(secondBody),
      mode: 'patch',
      revision: 2,
      patch: [
        { start: cchStart, deleteCount: 5, insert: 'bbbbb' },
        { start: firstBody.length, deleteCount: 0, insert: '!' },
      ],
    })
    await workerSocket.waitForControl(
      (message) => message.type === 'done' && message.id === 'req_patch',
    )

    expect(upstream.bodies.slice(startLen)).toEqual([firstBody, secondBody])
    workerSocket.socket.close()
  }, 30_000)

  test('websocket hash mismatch returns 409 before upstream fetch', async () => {
    const startLen = upstream.bodies.length
    const workerSocket = await connectWorkerSocket(
      mf,
      'miniflare-hash-mismatch-session',
    )

    const firstBody = 'stable-prefix stale-tail'
    const expectedBody = 'stable-prefix expected-tail'

    sendPayload(workerSocket.socket, {
      protocol: 2,
      type: 'request',
      id: 'req_seed_state',
      affinity: 'ignored-client-affinity',
      upstream: { url: upstream.url, method: 'POST', headers: {} },
      next_hash: hashBody(firstBody),
      mode: 'full_sync',
      revision: 1,
      body: firstBody,
    })
    await workerSocket.waitForControl(
      (message) => message.type === 'done' && message.id === 'req_seed_state',
    )

    sendPayload(workerSocket.socket, {
      protocol: 2,
      type: 'request',
      id: 'req_bad_patch',
      affinity: 'ignored-client-affinity',
      upstream: { url: upstream.url, method: 'POST', headers: {} },
      base_hash: hashBody(firstBody),
      next_hash: hashBody(expectedBody),
      mode: 'patch',
      revision: 2,
      patch: {
        start: 'stable-prefix '.length,
        deleteCount: 'stale-tail'.length,
        insert: 'wrong-tail',
      },
    })

    const error = await workerSocket.waitForControl(
      (message) => message.type === 'error' && message.id === 'req_bad_patch',
    )
    expect(error).toMatchObject({ status: 409, message: 'hash mismatch' })
    expect(upstream.bodies.slice(startLen)).toEqual([firstBody])
    workerSocket.socket.close()
  }, 30_000)
})
