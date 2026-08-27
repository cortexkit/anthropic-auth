import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStringPatch,
  getDumpDirectory,
  hashBody,
  isQuotaBearingHeaderFrame,
  resetDumpState,
  sendViaRelay,
  setDumpEnabled,
  WORKER_SCRIPT,
} from '@cortexkit/anthropic-auth-core'

const config = {
  enabled: true,
  url: 'https://relay.example.test',
  token: 'relay-token',
  fallbackToDirect: true,
  transport: 'http' as const,
}

const websocketConfig = { ...config, transport: 'websocket' as const }

function headers(affinity: string) {
  return new Headers({
    'x-session-affinity': affinity,
    authorization: 'Bearer access-token',
  })
}

function workerInternals() {
  const source = WORKER_SCRIPT.replace(
    /export default[\s\S]*$/,
    'return { hashBody, applyPatchSet, prepareWebSocketUpstream, createWebSocketStreamCoalescer }',
  )
  return new Function(source)() as {
    hashBody: (body: string) => Promise<string>
    applyPatchSet: (
      base: string,
      patch:
        | { start: number; deleteCount: number; insert: string }
        | Array<{ start: number; deleteCount: number; insert: string }>,
    ) => string | { error: string; status: number }
    prepareWebSocketUpstream: (
      env: unknown,
      state: { body: string; hash: string; revision: number } | null,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
    createWebSocketStreamCoalescer: (
      socket: { send: (frame: Uint8Array) => void },
      options?: { flushBytes?: number; flushMs?: number },
    ) => {
      push: (chunk: Uint8Array) => void
      flush: () => void
      stats: () => {
        upstreamChunks: number
        upstreamBytes: number
        frames: number
        frameBytes: number
        pendingBytes: number
      }
    }
  }
}

describe('relay client', () => {
  test('creates compact string patches', () => {
    const patch = createStringPatch(
      'hello expensive world',
      'hello cheap world',
    )
    expect(patch).toEqual({ start: 6, deleteCount: 9, insert: 'cheap' })
  })

  test('coalesces tiny Worker websocket stream chunks byte-exactly', () => {
    const { createWebSocketStreamCoalescer } = workerInternals()
    const frames: Uint8Array[] = []
    const coalescer = createWebSocketStreamCoalescer(
      { send: (frame) => frames.push(frame) },
      { flushBytes: 10, flushMs: 10_000 },
    )

    coalescer.push(new Uint8Array([1, 2, 3]))
    coalescer.push(new Uint8Array([4, 5]))
    coalescer.push(new Uint8Array([6, 7, 8, 9, 10]))
    coalescer.push(new Uint8Array([11, 12]))
    coalescer.flush()

    expect(frames).toHaveLength(2)
    expect([...(frames[0] ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect([...(frames[1] ?? [])]).toEqual([11, 12])
    expect(coalescer.stats()).toEqual({
      upstreamChunks: 4,
      upstreamBytes: 12,
      frames: 2,
      frameBytes: 12,
      pendingBytes: 0,
    })
  })

  test('sends full sync first and patch on next request', async () => {
    const calls: unknown[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    try {
      await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-a'),
        body: JSON.stringify({ messages: ['one'] }),
        fallback: async () => new Response('direct'),
      })
      await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-a'),
        body: JSON.stringify({ messages: ['one', 'two'] }),
        fallback: async () => new Response('direct'),
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ mode: 'full_sync', revision: 1 })
    expect(
      (calls[0] as { upstream: { headers: Record<string, string> } }).upstream
        .headers['x-session-affinity'],
    ).toBeUndefined()
    expect(calls[1]).toMatchObject({ mode: 'patch', revision: 2 })
    expect((calls[1] as { base_hash: string }).base_hash).toBe(
      hashBody(JSON.stringify({ messages: ['one'] })),
    )
  })

  test('delivers genuine HTTP relay response headers to the caller', async () => {
    const originalFetch = globalThis.fetch
    const receivedHeaders: Headers[] = []
    globalThis.fetch = mock(
      async () =>
        new Response('relay', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.78',
          },
        }),
    ) as unknown as typeof fetch
    try {
      const response = await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-http-headers'),
        body: 'body',
        fallback: async () => new Response('direct'),
        onResponseHeaders: (value) => {
          receivedHeaders.push(value)
          throw new Error('observer failure')
        },
      })

      expect(await response.text()).toBe('relay')
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(receivedHeaders).toHaveLength(1)
    expect(
      receivedHeaders[0]?.get('anthropic-ratelimit-unified-5h-utilization'),
    ).toBe('0.78')
  })

  test('does not deliver headers when HTTP relay falls back to direct', async () => {
    const originalFetch = globalThis.fetch
    const receivedHeaders: Headers[] = []
    globalThis.fetch = mock(
      async () => new Response('relay unavailable', { status: 503 }),
    ) as unknown as typeof fetch
    try {
      const response = await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-http-direct-fallback'),
        body: 'body',
        fallback: async () =>
          new Response('direct', {
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.42',
            },
          }),
        onResponseHeaders: (value) => receivedHeaders.push(value),
      })

      expect(await response.text()).toBe('direct')
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(receivedHeaders).toHaveLength(0)
  })

  test('dumps final body and redacted relay payload when enabled', async () => {
    const originalFetch = globalThis.fetch
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = await mkdtemp(
      join(tmpdir(), 'anthropic-auth-dump-test-'),
    )
    setDumpEnabled(true)
    globalThis.fetch = mock(
      async () => new Response('ok', { status: 200 }),
    ) as unknown as typeof fetch

    try {
      await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session relay/dump:alpha'),
        dumpTag: 'start',
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          stream: true,
          system: [
            {
              type: 'text',
              text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=abcde;',
            },
            { type: 'text', text: 'system cch=fffff;' },
          ],
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'first' }] },
            { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
          ],
        }),
        fallback: async () => new Response('direct'),
      })

      const files = await readdir(getDumpDirectory())
      const metaPath = files.find((file) => file.endsWith('.meta.json'))
      const bodyPath = files.find((file) => file.endsWith('.body.json'))
      const relayPath = files.find((file) => file.endsWith('.relay.json'))

      expect(metaPath).toBeString()
      expect(bodyPath).toBeString()
      expect(relayPath).toBeString()
      expect(metaPath).toInclude('session-relay-dump-alpha-start-http-p1-')
      expect(bodyPath).toInclude('session-relay-dump-alpha-start-http-p1-')
      expect(relayPath).toInclude('session-relay-dump-alpha-start-http-p1-')

      const meta = JSON.parse(
        await readFile(`${getDumpDirectory()}/${metaPath}`, 'utf8'),
      )
      expect(meta.body).toMatchObject({
        parseable: true,
        messagesCount: 2,
        systemCount: 2,
        cch: 'abcde',
      })
      expect(meta.tag).toBe('start')
      expect(
        await readFile(`${getDumpDirectory()}/${bodyPath}`, 'utf8'),
      ).toContain('first')

      const relay = JSON.parse(
        await readFile(`${getDumpDirectory()}/${relayPath}`, 'utf8'),
      )
      expect(relay.upstream.headers.authorization).toBe('[redacted]')
    } finally {
      const dumpDir = getDumpDirectory()
      resetDumpState()
      globalThis.fetch = originalFetch
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('reports the created HTTP relay dump handle without replacing the response', async () => {
    const originalFetch = globalThis.fetch
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = await mkdtemp(
      join(tmpdir(), 'anthropic-auth-relay-handle-'),
    )
    setDumpEnabled(true)
    globalThis.fetch = mock(
      async () => new Response('relay', { status: 201 }),
    ) as unknown as typeof fetch
    const handles: unknown[] = []
    try {
      const response = await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-handle'),
        body: '{}',
        fallback: async () => new Response('direct'),
        onDumpCreated: (handle) => {
          handles.push(handle)
          throw new Error('observer failure')
        },
      })
      expect(response.status).toBe(201)
      expect(handles).toHaveLength(1)
      expect((handles[0] as { responsePath: string }).responsePath).toEndWith(
        '.response.json',
      )
    } finally {
      const dumpDir = getDumpDirectory()
      resetDumpState()
      globalThis.fetch = originalFetch
      if (originalDumpDir === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      await rm(dumpDir, { recursive: true, force: true })
    }
  })

  test('retries with full sync when relay reports state mismatch', async () => {
    const calls: unknown[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async (_input, init) => {
      const payload = JSON.parse(String(init?.body))
      calls.push(payload)
      if (payload.mode === 'patch')
        return new Response('mismatch', { status: 409 })
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    try {
      await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-b'),
        body: 'first',
        fallback: async () => new Response('direct'),
      })
      await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-b'),
        body: 'second',
        fallback: async () => new Response('direct'),
      })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(calls.map((call) => (call as { mode: string }).mode)).toEqual([
      'full_sync',
      'patch',
      'full_sync',
    ])
  })

  test('falls back to direct fetch on relay transport failure', async () => {
    const originalFetch = globalThis.fetch
    const receivedHeaders: Headers[] = []
    globalThis.fetch = mock(async () => {
      throw new Error('relay offline')
    }) as unknown as typeof fetch
    try {
      const response = await sendViaRelay({
        config,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-c'),
        body: 'body',
        fallback: async () => new Response('direct'),
        onResponseHeaders: (value) => receivedHeaders.push(value),
      })
      expect(await response.text()).toBe('direct')
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(receivedHeaders).toHaveLength(0)
  })

  test('can stream a response over websocket transport', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentPayloads: unknown[] = []

    class FakeWebSocket extends EventTarget {
      binaryType = 'arraybuffer'
      url: string

      constructor(url: string) {
        super()
        this.url = url
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'chunk',
                id: payload.id,
                base64: Buffer.from('event: message_stop\n\n').toString(
                  'base64',
                ),
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws'),
        body: 'body',
        fallback: async () => new Response('direct'),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('event: message_stop\n\n')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(sentPayloads).toHaveLength(1)
    expect(sentPayloads[0]).toMatchObject({ mode: 'full_sync' })
  })

  test('websocket optimistic response resolves immediately and delivers headers once for duplicate response_start', async () => {
    const originalWebSocket = globalThis.WebSocket
    const receivedHeaders: Headers[] = []
    let socket: OptimisticWebSocket | undefined
    let payloadId = ''
    let acceptedSent = false

    class OptimisticWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        socket = this
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        payloadId = payload.id
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket = OptimisticWebSocket as unknown as typeof WebSocket
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-optimistic'),
        body: 'body',
        fallback: async () => new Response('direct'),
        optimisticResponse: true,
        onResponseHeaders: (value) => receivedHeaders.push(value),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
      // The optimistic envelope intentionally has no quota-bearing headers.
      // Genuine response_start remains the only path that can stage headers for delivery.
      expect(isQuotaBearingHeaderFrame(response.headers)).toBe(false)
      expect(acceptedSent).toBe(false)

      const textPromise = response.text()
      acceptedSent = true
      socket?.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            protocol: 2,
            type: 'accepted',
            id: payloadId,
            hash: hashBody('body'),
            revision: 1,
          }),
        }),
      )
      socket?.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            protocol: 2,
            type: 'response_start',
            id: payloadId,
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.78',
            },
          }),
        }),
      )
      socket?.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            protocol: 2,
            type: 'response_start',
            id: payloadId,
            status: 200,
            headers: {
              'anthropic-ratelimit-unified-5h-utilization': '0.78',
            },
          }),
        }),
      )
      socket?.dispatchEvent(
        new MessageEvent('message', {
          data: Buffer.from('event: message_stop\n\n'),
        }),
      )
      socket?.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ protocol: 2, type: 'done', id: payloadId }),
        }),
      )
      expect(await textPromise).toBe('event: message_stop\n\n')
      expect(receivedHeaders).toHaveLength(1)
      expect(
        receivedHeaders[0]?.get('anthropic-ratelimit-unified-5h-utilization'),
      ).toBe('0.78')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('does not deliver headers for websocket errors before response_start', async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalFetch = globalThis.fetch
    const receivedHeaders: Headers[] = []

    class ErrorWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'error',
                id: payload.id,
                status: 502,
                message: 'upstream failed',
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket = ErrorWebSocket as unknown as typeof WebSocket
    globalThis.fetch = mock(async () => {
      throw new Error('http relay unavailable')
    }) as unknown as typeof fetch
    try {
      await expect(
        sendViaRelay({
          config: { ...websocketConfig, fallbackToDirect: false },
          input: 'https://api.anthropic.com/v1/messages?beta=true',
          init: { method: 'POST' },
          headers: headers('session-relay-ws-error'),
          body: 'body',
          fallback: async () => new Response('direct'),
          optimisticResponse: false,
          onResponseHeaders: (value) => receivedHeaders.push(value),
        }),
      ).rejects.toThrow('http relay unavailable')
    } finally {
      globalThis.WebSocket = originalWebSocket
      globalThis.fetch = originalFetch
    }

    expect(receivedHeaders).toHaveLength(0)
  })

  test('websocket optimistic response reconnects and retries when socket closes before upstream response', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentPayloads: Array<{ id: string; mode: string }> = []
    const receivedHeaders: Headers[] = []
    let socketCount = 0

    class ClosingBeforeResponseWebSocket extends EventTarget {
      binaryType = 'arraybuffer'
      private readonly socketNumber: number

      constructor() {
        super()
        socketCount += 1
        this.socketNumber = socketCount
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          if (this.socketNumber === 1) {
            this.dispatchEvent(new Event('close'))
            return
          }
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
                headers: {
                  'anthropic-ratelimit-unified-5h-utilization': '0.64',
                },
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: Buffer.from('event: message_stop\n\n'),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket =
      ClosingBeforeResponseWebSocket as unknown as typeof WebSocket
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-reconnect-before-response'),
        body: 'body',
        fallback: async () => new Response('direct'),
        optimisticResponse: true,
        onResponseHeaders: (value) => receivedHeaders.push(value),
      })
      expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
      expect(await response.text()).toBe('event: message_stop\n\n')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(socketCount).toBe(2)
    expect(sentPayloads.map((payload) => payload.mode)).toEqual([
      'full_sync',
      'full_sync',
    ])
    expect(sentPayloads[1]?.id).not.toBe(sentPayloads[0]?.id)
    expect(receivedHeaders).toHaveLength(1)
    expect(
      receivedHeaders[0]?.get('anthropic-ratelimit-unified-5h-utilization'),
    ).toBe('0.64')
  })

  test('websocket optimistic response retries when socket closes after response_start before stream bytes', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentPayloads: Array<{ id: string; mode: string }> = []
    const receivedHeaders: Headers[] = []
    let socketCount = 0

    class ClosingBeforeStreamBytesWebSocket extends EventTarget {
      binaryType = 'arraybuffer'
      private readonly socketNumber: number

      constructor() {
        super()
        socketCount += 1
        this.socketNumber = socketCount
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
                headers: {
                  'anthropic-ratelimit-unified-5h-utilization':
                    this.socketNumber === 1 ? '0.91' : '0.42',
                },
              }),
            }),
          )
          if (this.socketNumber === 1) {
            this.dispatchEvent(
              new CloseEvent('close', { code: 1011, reason: 'test close' }),
            )
            return
          }
          this.dispatchEvent(
            new MessageEvent('message', {
              data: Buffer.from('event: message_stop\n\n'),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket =
      ClosingBeforeStreamBytesWebSocket as unknown as typeof WebSocket
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-close-before-stream-bytes'),
        body: 'body',
        fallback: async () => new Response('direct'),
        optimisticResponse: true,
        onResponseHeaders: (value) => receivedHeaders.push(value),
      })
      expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
      expect(await response.text()).toBe('event: message_stop\n\n')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(socketCount).toBe(2)
    expect(sentPayloads.map((payload) => payload.mode)).toEqual([
      'full_sync',
      'full_sync',
    ])
    expect(sentPayloads[1]?.id).not.toBe(sentPayloads[0]?.id)
    expect(
      receivedHeaders.map((value) =>
        value.get('anthropic-ratelimit-unified-5h-utilization'),
      ),
    ).toEqual(['0.42'])
  })

  test('websocket optimistic response reports stream close after bytes without retry', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentPayloads: Array<{ id: string; mode: string }> = []
    let socketCount = 0

    class ClosingAfterBytesWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        socketCount += 1
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: Buffer.from('event: content_block_start\n\n'),
            }),
          )
          setTimeout(() => {
            this.dispatchEvent(new CloseEvent('close', { code: 1006 }))
          }, 0)
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket =
      ClosingAfterBytesWebSocket as unknown as typeof WebSocket
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-close-after-bytes'),
        body: 'body',
        fallback: async () => new Response('direct'),
        optimisticResponse: true,
      })
      expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      const firstRead = await reader!.read()
      expect(Buffer.from(firstRead.value ?? new Uint8Array()).toString()).toBe(
        'event: content_block_start\n\n',
      )

      let streamError: unknown
      try {
        await reader!.read()
      } catch (error) {
        streamError = error
      }
      expect(streamError).toBeInstanceOf(Error)
      expect((streamError as Error).message).toBe(
        'relay websocket closed during response stream',
      )
      expect(streamError).toMatchObject({
        code: 'ECONNRESET',
        syscall: 'websocket',
        closeCode: 1006,
      })
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(socketCount).toBe(1)
    expect(sentPayloads.map((payload) => payload.mode)).toEqual(['full_sync'])
  })

  test('websocket reconnect retry works against a real local server', async () => {
    const sentPayloads: Array<{ id: string; mode: string }> = []
    let socketsOpened = 0
    let directFallbackUsed = false

    const server = Bun.serve<{ socketNumber: number }>({
      port: 0,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname === '/ws') {
          socketsOpened += 1
          const upgraded = server.upgrade(request, {
            data: { socketNumber: socketsOpened },
          })
          if (upgraded) return undefined
          return new Response('upgrade failed', { status: 500 })
        }
        return new Response('unexpected request', { status: 404 })
      },
      websocket: {
        open(socket) {
          socket.send(
            JSON.stringify({ protocol: 2, type: 'ready', state: null }),
          )
        },
        message(socket, data) {
          const payload = JSON.parse(String(data))
          sentPayloads.push(payload)
          socket.send(
            JSON.stringify({
              protocol: 2,
              type: 'accepted',
              id: payload.id,
              hash: payload.next_hash,
              revision: payload.revision,
            }),
          )
          if (socket.data.socketNumber === 1) {
            socket.close(1011, 'test close before response')
            return
          }
          socket.send(
            JSON.stringify({
              protocol: 2,
              type: 'response_start',
              id: payload.id,
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
            }),
          )
          socket.send(new TextEncoder().encode('event: message_stop\n\n'))
          socket.send(
            JSON.stringify({ protocol: 2, type: 'done', id: payload.id }),
          )
        },
      },
    })

    try {
      const response = await sendViaRelay({
        config: {
          ...websocketConfig,
          url: `http://127.0.0.1:${server.port}`,
        },
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-local-e2e'),
        body: JSON.stringify({ messages: ['hello'] }),
        fallback: async () => {
          directFallbackUsed = true
          return new Response('direct')
        },
        optimisticResponse: true,
      })

      expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
      expect(await response.text()).toBe('event: message_stop\n\n')
    } finally {
      server.stop(true)
    }

    expect(directFallbackUsed).toBe(false)
    expect(socketsOpened).toBe(2)
    expect(sentPayloads.map((payload) => payload.mode)).toEqual([
      'full_sync',
      'full_sync',
    ])
    expect(sentPayloads[1]?.id).not.toBe(sentPayloads[0]?.id)
  })

  test('websocket accepts binary chunk frames', async () => {
    const originalWebSocket = globalThis.WebSocket

    class BinaryChunkWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: Buffer.from('event: message_stop\n\n'),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket = BinaryChunkWebSocket as unknown as typeof WebSocket
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-binary'),
        body: 'body',
        fallback: async () => new Response('direct'),
      })
      expect(await response.text()).toBe('event: message_stop\n\n')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }
  })

  test('websocket patch stays compact when cch and tail both change', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentPayloads: unknown[] = []
    let socketsOpened = 0

    class FakeWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        socketsOpened += 1
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    const stableTail = 'x'.repeat(200_000)
    const bodyWithCch = (cch: string, suffix: string) =>
      JSON.stringify({
        system: [
          {
            type: 'text',
            text: `x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=${cch};`,
          },
          { type: 'text', text: 'stable system block' },
        ],
        messages: [{ role: 'user', content: stableTail + suffix }],
      })

    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    try {
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-cch'),
        body: bodyWithCch('aaaaa', ''),
        fallback: async () => new Response('direct'),
      })
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-cch'),
        body: bodyWithCch('bbbbb', '!'),
        fallback: async () => new Response('direct'),
      })
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(sentPayloads).toHaveLength(2)
    expect(socketsOpened).toBe(1)
    expect(sentPayloads[0]).toMatchObject({ mode: 'full_sync' })

    const patchPayload = sentPayloads[1] as {
      mode: string
      patch: Array<{ insert: string }>
    }
    expect(patchPayload.mode).toBe('patch')
    expect(Array.isArray(patchPayload.patch)).toBe(true)
    expect(patchPayload.patch).toHaveLength(2)
    expect(patchPayload.patch.map((patch) => patch.insert)).toEqual([
      'bbbbb',
      '!',
    ])
    expect(JSON.stringify(patchPayload).length).toBeLessThan(2_000)
  })

  test('worker websocket reconstruction rejects hash mismatch before upstream fetch', async () => {
    const { hashBody, prepareWebSocketUpstream } = workerInternals()
    const state = {
      body: 'stable-prefix stale-tail',
      hash: await hashBody('stable-prefix stale-tail'),
      revision: 1,
    }
    const payload = {
      protocol: 2,
      type: 'request',
      id: 'req_hash_mismatch',
      affinity: 'session-worker-hash-mismatch',
      upstream: {
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
      },
      mode: 'patch',
      base_hash: state.hash,
      revision: 2,
      next_hash: await hashBody('stable-prefix expected-tail'),
      patch: {
        start: 'stable-prefix '.length,
        deleteCount: 'stale-tail'.length,
        insert: 'wrong-tail',
      },
    }

    const result = await prepareWebSocketUpstream({}, state, payload)

    expect(result).toEqual({ error: 'hash mismatch', status: 409 })
  })

  test('websocket retries state mismatch with full sync', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentPayloads: Array<{
      id: string
      mode: string
      next_hash: string
      revision: number
    }> = []
    let rejectedPatch = false

    class MismatchWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          if (payload.mode === 'patch' && !rejectedPatch) {
            rejectedPatch = true
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'error',
                  id: payload.id,
                  status: 409,
                  message: 'state mismatch',
                }),
              }),
            )
            return
          }
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket = MismatchWebSocket as unknown as typeof WebSocket
    try {
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-mismatch'),
        body: 'first',
        fallback: async () => new Response('direct'),
      })
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-mismatch'),
        body: 'second',
        fallback: async () => new Response('direct'),
      })
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(sentPayloads.map((payload) => payload.mode)).toEqual([
      'full_sync',
      'patch',
      'full_sync',
    ])
  })

  test('websocket optimistic response retries hash mismatch before upstream response', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sentPayloads: Array<{ id: string; mode: string }> = []
    let rejectedPatch = false

    class OptimisticMismatchWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          if (payload.mode === 'patch' && !rejectedPatch) {
            rejectedPatch = true
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  protocol: 2,
                  type: 'error',
                  id: payload.id,
                  status: 409,
                  message: 'hash mismatch',
                }),
              }),
            )
            return
          }
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: Buffer.from('event: message_stop\n\n'),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket =
      OptimisticMismatchWebSocket as unknown as typeof WebSocket
    try {
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-optimistic-mismatch'),
        body: 'first',
        fallback: async () => new Response('direct'),
        optimisticResponse: true,
      })
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-optimistic-mismatch'),
        body: 'second',
        fallback: async () => new Response('direct'),
        optimisticResponse: true,
      })

      expect(response.headers.get('x-cortexkit-relay-optimistic')).toBe('true')
      expect(await response.text()).toBe('event: message_stop\n\n')
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(sentPayloads.map((payload) => payload.mode)).toEqual([
      'full_sync',
      'patch',
      'full_sync',
    ])
  })

  test('websocket keepalive resets pre-response timeout', async () => {
    const originalWebSocket = globalThis.WebSocket
    const timeouts: Array<{ id: number; ms?: number }> = []
    const cleared: number[] = []
    let nextTimerId = 1

    const setTimeoutMock = ((
      _: Parameters<typeof setTimeout>[0],
      ms?: number,
    ) => {
      const id = nextTimerId++
      timeouts.push({ id, ms })
      return id
    }) as unknown as typeof setTimeout
    const clearTimeoutMock = ((id?: number) => {
      if (typeof id === 'number') cleared.push(id)
    }) as unknown as typeof clearTimeout

    class SlowStartingWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'keepalive' }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket = SlowStartingWebSocket as unknown as typeof WebSocket
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-keepalive'),
        body: 'body',
        fallback: async () => new Response('direct'),
        setTimeoutImpl: setTimeoutMock,
        clearTimeoutImpl: clearTimeoutMock,
      })
      expect(response.status).toBe(200)
    } finally {
      globalThis.WebSocket = originalWebSocket
    }

    expect(timeouts.map((timeout) => timeout.ms)).toEqual([
      15_000, 45_000, 45_000, 45_000,
    ])
    expect(cleared).toEqual(expect.arrayContaining([1, 2, 3, 4]))
  })

  test('falls back to HTTP relay when websocket connection fails', async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalFetch = globalThis.fetch
    const httpPayloads: unknown[] = []

    class FailingWebSocket extends EventTarget {
      binaryType = 'arraybuffer'
      constructor() {
        super()
        queueMicrotask(() => this.dispatchEvent(new Event('error')))
      }
      send() {}
      close() {}
    }

    globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket
    globalThis.fetch = mock(async (_input, init) => {
      httpPayloads.push(JSON.parse(String(init?.body)))
      return new Response('http-relay', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const response = await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-fallback'),
        body: 'body',
        fallback: async () => new Response('direct'),
      })
      expect(await response.text()).toBe('http-relay')
    } finally {
      globalThis.WebSocket = originalWebSocket
      globalThis.fetch = originalFetch
    }

    expect(httpPayloads).toHaveLength(1)
    expect(httpPayloads[0]).toMatchObject({ mode: 'full_sync' })
  })

  test('websocket to HTTP fallback updates local relay state', async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalFetch = globalThis.fetch
    const httpPayloads: Array<{ mode: string; base_hash?: string }> = []

    class FailingWebSocket extends EventTarget {
      binaryType = 'arraybuffer'
      constructor() {
        super()
        queueMicrotask(() => this.dispatchEvent(new Event('error')))
      }
      send() {}
      close() {}
    }

    globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket
    globalThis.fetch = mock(async (_input, init) => {
      httpPayloads.push(JSON.parse(String(init?.body)))
      return new Response('http-relay', { status: 200 })
    }) as unknown as typeof fetch
    try {
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-http-state'),
        body: 'first',
        fallback: async () => new Response('direct'),
      })
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-http-state'),
        body: 'second',
        fallback: async () => new Response('direct'),
      })
    } finally {
      globalThis.WebSocket = originalWebSocket
      globalThis.fetch = originalFetch
    }

    expect(httpPayloads).toHaveLength(2)
    expect(httpPayloads.map((payload) => payload.mode)).toEqual([
      'full_sync',
      'patch',
    ])
    expect(httpPayloads[1]?.base_hash).toBe(hashBody('first'))
  })

  test('dumps the exact websocket protocol 2 frame payload', async () => {
    const originalWebSocket = globalThis.WebSocket
    const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    const dumpDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-dump-test-'))
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
    const sentPayloads: unknown[] = []
    const handles: unknown[] = []
    setDumpEnabled(true)

    class DumpingWebSocket extends EventTarget {
      binaryType = 'arraybuffer'

      constructor() {
        super()
        queueMicrotask(() => {
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({ protocol: 2, type: 'ready', state: null }),
            }),
          )
        })
      }

      send(data: string) {
        const payload = JSON.parse(data)
        sentPayloads.push(payload)
        queueMicrotask(() => {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'accepted',
                id: payload.id,
                hash: payload.next_hash,
                revision: payload.revision,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'response_start',
                id: payload.id,
                status: 200,
              }),
            }),
          )
          this.dispatchEvent(
            new MessageEvent('message', {
              data: JSON.stringify({
                protocol: 2,
                type: 'done',
                id: payload.id,
              }),
            }),
          )
        })
      }

      close() {
        this.dispatchEvent(new Event('close'))
      }
    }

    globalThis.WebSocket = DumpingWebSocket as unknown as typeof WebSocket
    try {
      await sendViaRelay({
        config: websocketConfig,
        input: 'https://api.anthropic.com/v1/messages?beta=true',
        init: { method: 'POST' },
        headers: headers('session-relay-ws-dump-exact'),
        body: JSON.stringify({ messages: ['one'] }),
        fallback: async () => new Response('direct'),
        onDumpCreated: (handle) => handles.push(handle),
      })

      const files = await readdir(getDumpDirectory())
      const relayPath = files.find((file) => file.endsWith('.relay.json'))
      const metaPath = files.find((file) => file.endsWith('.meta.json'))
      expect(relayPath).toBeString()
      expect(metaPath).toBeString()

      const relay = JSON.parse(
        await readFile(`${getDumpDirectory()}/${relayPath}`, 'utf8'),
      )
      const meta = JSON.parse(
        await readFile(`${getDumpDirectory()}/${metaPath}`, 'utf8'),
      )
      const expectedRelay = JSON.parse(JSON.stringify(sentPayloads[0]))
      expectedRelay.upstream.headers.authorization = '[redacted]'
      expect(relay).toEqual(expectedRelay)
      expect(relay).toMatchObject({ protocol: 2, mode: 'full_sync' })
      expect(relay.id).toBeString()
      expect(meta.relayBytes).toBe(JSON.stringify(sentPayloads[0]).length)
      expect(handles).toHaveLength(1)
      expect((handles[0] as { responsePath: string }).responsePath).toEndWith(
        '.response.json',
      )
    } finally {
      resetDumpState()
      globalThis.WebSocket = originalWebSocket
      if (originalDumpDir === undefined) {
        delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
      } else {
        process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
      }
      await rm(dumpDir, { recursive: true, force: true })
    }
  })
})
