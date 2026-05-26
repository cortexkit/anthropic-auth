import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  closeRelaySessions,
  hashBody,
  sendViaRelay,
  WORKER_SCRIPT,
} from '@marcusrbrown/anthropic-auth-core'
import { Miniflare, NoOpLog } from 'miniflare'

const RELAY_TOKEN = 'relay-token'

type ControlMessage = {
  type: string
  id?: string
  status?: number
  message?: string
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

function startUpstream() {
  const bodies: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bodies.push(await request.text())
      return new Response('upstream-ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    },
  })
  return { server, bodies, url: `http://127.0.0.1:${server.port}/messages` }
}

async function startWorker() {
  const mf = new Miniflare({
    script: WORKER_SCRIPT,
    modules: true,
    compatibilityDate: '2026-04-28',
    kvNamespaces: ['RELAY_STATE'],
    bindings: { RELAY_TOKEN },
    port: 0,
    log: new NoOpLog(),
  })
  await mf.ready
  return mf
}

async function connectWorkerSocket(
  mf: Miniflare,
  affinity: string,
): Promise<WorkerSocket> {
  const url = new URL(await mf.ready)
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

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1_000)
    socket.addEventListener(
      'close',
      () => {
        clearTimeout(timeout)
        resolve()
      },
      { once: true },
    )

    if (socket.readyState === WebSocket.CLOSING) return
    socket.close()
  })
}

describe('relay Worker under Miniflare', () => {
  let mf: Miniflare

  beforeAll(async () => {
    mf = await startWorker()
  })

  afterAll(async () => {
    await closeRelaySessions()
    await mf.dispose()
  })

  test('client websocket transport reaches Miniflare Worker with byte-exact patch reconstruction', async () => {
    const upstream = startUpstream()
    const affinity = 'miniflare-client-session'

    try {
      const firstBody = `client prefix cch=aaaaa; ${'x'.repeat(2048)} tail`
      const secondBody = `client prefix cch=bbbbb; ${'x'.repeat(2048)} tail!`
      const relayUrl = (await mf.ready).toString()
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

      const second = await sendViaRelay({
        config: relayConfig,
        input: `${upstream.url}?beta=true`,
        init: { method: 'POST' },
        headers: requestHeaders(),
        body: secondBody,
        fallback: async () => new Response('direct'),
      })
      expect(await second.text()).toBe('upstream-ok')
      expect(upstream.bodies).toEqual([firstBody, secondBody])
    } finally {
      await closeRelaySessions()
      upstream.server.stop(true)
    }
  }, 30_000)

  test('websocket full_sync and patch reconstruct byte-exact upstream bodies', async () => {
    const upstream = startUpstream()
    const workerSocket = await connectWorkerSocket(
      mf,
      'miniflare-byte-exact-session',
    )

    try {
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

      expect(upstream.bodies).toEqual([firstBody, secondBody])
    } finally {
      await closeSocket(workerSocket.socket)
      upstream.server.stop(true)
    }
  }, 30_000)

  test('websocket hash mismatch returns 409 before upstream fetch', async () => {
    const upstream = startUpstream()
    const workerSocket = await connectWorkerSocket(
      mf,
      'miniflare-hash-mismatch-session',
    )

    try {
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
      expect(upstream.bodies).toEqual([firstBody])
    } finally {
      await closeSocket(workerSocket.socket)
      upstream.server.stop(true)
    }
  }, 30_000)
})
