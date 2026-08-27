/// <reference types="bun-types" />

import { createHash } from 'node:crypto'

type RelayPatch = {
  start: number
  deleteCount: number
  insert: string
}

type RelayPayload = {
  protocol?: 1 | 2
  type: 'request'
  id?: string
  affinity: string
  upstream: {
    url: string
    method: string
    headers: Record<string, string>
  }
  next_hash: string
  mode: 'full_sync' | 'patch'
  revision: number
  body?: string
  patch?: RelayPatch | RelayPatch[]
}

type SessionState = {
  body: string
  hash: string
  revision: number
}

export class MockRelayServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private state = new Map<string, SessionState>()
  private token = 'relay-token'
  private acceptedCount = 0
  private responseStartDelayMs = 0

  async start(options: { token?: string; responseStartDelayMs?: number } = {}) {
    this.token = options.token ?? this.token
    this.responseStartDelayMs = options.responseStartDelayMs ?? 0
    this.server = Bun.serve({
      port: 0,
      fetch: (request, server) => {
        const url = new URL(request.url)
        if (request.method === 'POST' && url.pathname === '/') {
          return this.handleHttp(request)
        }
        if (url.pathname === '/ws') {
          if (url.searchParams.get('token') !== this.token) {
            return new Response('unauthorized', { status: 401 })
          }
          const affinity = url.searchParams.get('affinity') ?? 'default'
          if (server.upgrade(request, { data: { affinity } })) return undefined
          return new Response('upgrade failed', { status: 400 })
        }
        return new Response('not found', { status: 404 })
      },
      websocket: {
        open: (socket) => {
          const affinity = socket.data.affinity as string
          socket.send(
            JSON.stringify({
              protocol: 2,
              type: 'ready',
              state: this.state.get(affinity) ?? null,
            }),
          )
        },
        message: async (socket, message) => {
          if (typeof message !== 'string') return
          const affinity = socket.data.affinity as string
          const payload = JSON.parse(message) as RelayPayload
          const body = this.reconstructBody(affinity, payload)
          this.state.set(affinity, {
            body,
            hash: payload.next_hash,
            revision: payload.revision,
          })
          this.acceptedCount += 1
          socket.send(
            JSON.stringify({
              protocol: 2,
              type: 'accepted',
              id: payload.id,
              hash: payload.next_hash,
              revision: payload.revision,
            }),
          )

          const upstream = await fetch(payload.upstream.url, {
            method: payload.upstream.method,
            headers: payload.upstream.headers,
            body,
          })
          if (this.responseStartDelayMs > 0)
            await Bun.sleep(this.responseStartDelayMs)
          socket.send(
            JSON.stringify({
              type: 'response_start',
              id: payload.id,
              status: upstream.status,
              statusText: upstream.statusText,
              headers: Object.fromEntries(upstream.headers.entries()),
            }),
          )

          if (upstream.body) {
            const reader = upstream.body.getReader()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              socket.send(value)
            }
          }
          socket.send(JSON.stringify({ type: 'done', id: payload.id }))
        },
      },
    })
    const port = this.server.port
    if (!port) throw new Error('mock relay server failed to bind')
    return { port, url: `http://127.0.0.1:${port}` }
  }

  async stop() {
    this.server?.stop(true)
    this.server = null
  }

  acceptedRequests() {
    return this.acceptedCount
  }

  private reconstructBody(affinity: string, payload: RelayPayload) {
    if (payload.mode === 'full_sync') return payload.body ?? ''
    const previous = this.state.get(affinity)
    if (!previous) throw new Error('missing previous relay state')
    return applyPatches(previous.body, payload.patch ?? [])
  }

  private async handleHttp(request: Request) {
    if (request.headers.get('x-relay-token') !== this.token)
      return new Response('unauthorized', { status: 401 })
    const payload = (await request.json()) as RelayPayload
    const body = this.reconstructBody(payload.affinity, payload)
    this.state.set(payload.affinity, {
      body,
      hash: payload.next_hash,
      revision: payload.revision,
    })
    this.acceptedCount += 1
    const upstream = await fetch(payload.upstream.url, {
      method: payload.upstream.method,
      headers: payload.upstream.headers,
      body,
    })
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })
  }
}

function applyPatches(previous: string, patch: RelayPatch | RelayPatch[]) {
  const patches = Array.isArray(patch) ? patch : [patch]
  let cursor = 0
  let next = ''
  for (const hunk of patches) {
    next += previous.slice(cursor, hunk.start)
    next += hunk.insert
    cursor = hunk.start + hunk.deleteCount
  }
  next += previous.slice(cursor)
  return next
}

export function hashBody(body: string) {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}
