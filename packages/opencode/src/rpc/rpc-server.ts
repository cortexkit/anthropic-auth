import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { join } from 'node:path'
import {
  type CommandApplyRequest,
  type CommandApplyResult,
  parseApplyRequest,
} from '@cortexkit/anthropic-auth-core'
import type { drainNotifications } from './notifications'
import { writePortFile } from './port-file'
import type { ApplyRequest, ApplyResult } from './protocol'

export interface RpcServerHandle {
  port: number
  token: string
  stop: () => Promise<void>
}

export interface RpcServerOptions {
  dir: string
  drain: typeof drainNotifications
  /** Structured-menu hosts need no text parser; internal text consumers may still supply one. */
  apply?: (request: ApplyRequest) => Promise<ApplyResult>
  /** Run menu actions through the host's credential service, not legacy account-file writes. */
  applyMenu?: (request: CommandApplyRequest) => Promise<CommandApplyResult>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

export async function startRpcServer(
  options: RpcServerOptions,
): Promise<RpcServerHandle> {
  const token = randomBytes(32).toString('hex')
  const server = createServer((req, res) => {
    void dispatch(req, res)
  })

  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    try {
      const url = req.url ?? ''
      if (req.method === 'GET' && url === '/health')
        return json(200, { ok: true })
      if (req.method !== 'POST' || !url.startsWith('/rpc/'))
        return json(404, { error: 'not found' })
      if (!tokenOk(req.headers.authorization, token))
        return json(401, { error: 'unauthorized' })
      const method = url.slice('/rpc/'.length)
      const params = JSON.parse((await readBody(req)) || '{}') as Record<
        string,
        unknown
      >
      if (method === 'pending-notifications') {
        if (
          typeof params.sessionId !== 'string' ||
          params.sessionId.length === 0
        ) {
          return json(400, { error: 'sessionId is required' })
        }
        const messages = options.drain(
          Number(params.lastReceivedId ?? 0),
          params.sessionId,
        )
        return json(200, { messages })
      }
      if (method === 'apply') {
        if (!options.apply)
          return json(501, { error: 'text apply unavailable' })
        const result = await options.apply(params as unknown as ApplyRequest)
        return json(200, result)
      }
      if (method === 'apply-menu') {
        const request = parseApplyRequest(params)
        if (request?.command !== 'claude' || !request.sessionId?.trim())
          return json(400, { error: 'invalid menu request' })
        if (!options.applyMenu) return json(501, { error: 'menu unavailable' })
        return json(200, await options.applyMenu(request))
      }
      return json(404, { error: 'unknown method' })
    } catch {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        json(500, {
          error: 'RPC request failed',
        })
      }
    }
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('no port'))
    })
  })
  server.unref()
  try {
    await writePortFile(options.dir, { port, token, pid: process.pid })
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }

  return {
    port,
    token,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        const portFile = join(options.dir, `port-${process.pid}.json`)
        const current = JSON.parse(await readFile(portFile, 'utf8')) as {
          port?: unknown
          pid?: unknown
        }
        if (current.port === port && current.pid === process.pid) {
          await unlink(portFile)
        }
      } catch {}
    },
  }
}
