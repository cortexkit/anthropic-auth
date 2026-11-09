import { chmod, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  buildFlags,
  buildFrame,
  computeProof,
  decodeHeader,
  encodeFrame,
  FrameType,
  HEADER_LEN,
  PROTOCOL_VERSION,
  Priority,
  SERVER_PROOF_DOMAIN,
} from '@cortexkit/subc-client'

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)

export type FakeClaustrumCredential = {
  payload: string | Uint8Array | number[]
  account_id: string
  credential_id?: string
  record_version: number
  expires_at_ms: number
  cold?: boolean
  state?: string
}

export type FakeClaustrumEnrollmentProposal = {
  proposed_name?: string
  display_name?: string
  request_secret_hash?: string
}

export type FakeClaustrumAuthFailure = {
  credential_id?: string
  provider_status?: number
  record_version?: number
  reporter_source?: string
}

export type FakeClaustrumDaemon = {
  connectionFile: string
  credentialGets: string[]
  scopedLists: number
  reportAuthFailures: FakeClaustrumAuthFailure[]
  enrollmentProposals: FakeClaustrumEnrollmentProposal[]
  revokeScoped: (credentialId: string) => void
  waitForCredentialGet: (credentialId: string) => Promise<void>
  waitForEnrollmentProposal: () => Promise<void>
  stop: () => Promise<void>
}

export async function startFakeClaustrumDaemon(input: {
  directory: string
  /** Only explicitly listed native Anthropic OAuth IDs are visible to enrolled clients. */
  scopedCredentials?: Record<string, FakeClaustrumCredential>
  connectionFile?: string
}): Promise<FakeClaustrumDaemon> {
  const sockets = new Set<Socket>()
  const credentialGets: string[] = []
  let scopedLists = 0
  const revokedScoped = new Set<string>()
  const credentialGetWaiters = new Map<string, Set<() => void>>()
  const reportAuthFailures: FakeClaustrumAuthFailure[] = []
  const enrollmentProposals: FakeClaustrumEnrollmentProposal[] = []
  const enrollmentProposalWaiters = new Set<() => void>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    // Every route.open gets its own channel, as a real daemon assigns them, so
    // a second route (claustrum-client opens one per vault watch) never
    // shares a channel with the route that serves credential calls.
    const routeChannels = new Set<number>()
    let nextRouteChannel = 7

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([
        buffer,
        typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      ])
      for (;;) {
        if (phase !== 'frames') {
          if (buffer.length < 4) return
          const length = buffer.readUInt32LE(0)
          if (buffer.length < 4 + length) return
          const body = JSON.parse(
            buffer.subarray(4, 4 + length).toString('utf8'),
          ) as Record<string, unknown>
          buffer = buffer.subarray(4 + length)
          if (phase === 'hello') {
            const clientNonce = Uint8Array.from(body.client_nonce as number[])
            const serverNonce = Uint8Array.from(
              { length: 32 },
              (_, index) => 100 + index,
            )
            writeHandshakeMessage(socket, {
              daemon_id: Array.from(daemonId),
              server_nonce: Array.from(serverNonce),
              daemon_ver: 'fake-daemon',
              server_proof: Array.from(
                computeProof(
                  key,
                  SERVER_PROOF_DOMAIN,
                  clientNonce,
                  serverNonce,
                  daemonId,
                ),
              ),
            })
            phase = 'auth'
          } else {
            phase = 'frames'
          }
          continue
        }

        if (buffer.length < HEADER_LEN) return
        const header = decodeHeader(buffer.subarray(0, HEADER_LEN))
        if (buffer.length < HEADER_LEN + header.len) return
        const body = buffer.subarray(HEADER_LEN, HEADER_LEN + header.len)
        buffer = buffer.subarray(HEADER_LEN + header.len)
        if (header.ty !== FrameType.Request) continue
        const request = JSON.parse(body.toString('utf8')) as {
          method?: string
          op?: string
          params?: Record<string, unknown>
        }
        if (header.channel === 0) {
          if (request.op === 'route.open') {
            const channel = nextRouteChannel++
            routeChannels.add(channel)
            writeResponse(socket, header, {
              route_channel: channel,
              route_epoch: 1,
            })
          } else
            writeResponse(socket, header, { route_channel: 7, route_epoch: 1 })
          continue
        }
        if (!routeChannels.has(header.channel)) {
          writeResponse(
            socket,
            header,
            { code: 'unknown_channel' },
            FrameType.Error,
          )
          continue
        }
        if (request.method === 'auth.watch_scoped') {
          // Answer as a vault that predates the account watch, so hosts keep
          // listing on their own timer exactly as they did before it.
          writeResponse(
            socket,
            header,
            { code: 'unknown_method' },
            FrameType.Error,
          )
          continue
        }
        if (request.method === 'auth.enroll_propose') {
          enrollmentProposals.push({
            proposed_name:
              typeof request.params?.proposed_name === 'string'
                ? request.params.proposed_name
                : undefined,
            display_name:
              typeof request.params?.display_name === 'string'
                ? request.params.display_name
                : undefined,
            request_secret_hash:
              typeof request.params?.request_secret_hash === 'string'
                ? request.params.request_secret_hash
                : undefined,
          })
          writeResponse(socket, header, {
            result: { request_id: 'fake-enrollment-request' },
          })
          for (const resolve of enrollmentProposalWaiters) resolve()
          enrollmentProposalWaiters.clear()
          continue
        }
        if (request.method === 'auth.enroll_poll') {
          writeResponse(socket, header, { result: { status: 'pending' } })
          continue
        }
        if (request.method === 'credential.list_scoped') {
          scopedLists++
          const rows = Object.entries(input.scopedCredentials ?? {})
            .filter(([id]) => !revokedScoped.has(id))
            .map(([id, credential]) => ({
              id,
              account_id: credential.account_id,
              type: 'oauth',
              state: credential.state ?? 'active',
              record_version: credential.record_version,
              categories: ['anthropic-native'],
              serves: ['anthropic'],
              refresh_adapter: 'anthropic',
              operations: ['read'],
            }))
          writeResponse(socket, header, {
            result: {
              credentials: rows,
              view: JSON.stringify(
                rows.map(({ id, account_id, state }) => [
                  id,
                  account_id,
                  state,
                ]),
              ),
            },
          })
          continue
        }
        if (request.method === 'credential.get_scoped') {
          const id = request.params?.credential_id
          const credential =
            typeof id === 'string' && !revokedScoped.has(id)
              ? input.scopedCredentials?.[id]
              : undefined
          if (typeof id === 'string') credentialGets.push(id)
          writeResponse(socket, header, {
            result:
              credential && !credential.cold
                ? {
                    payload: payloadBytes(credential.payload),
                    credential_id: id,
                    account_id: credential.account_id,
                    record_version: credential.record_version,
                    expires_at_ms: credential.expires_at_ms,
                  }
                : { error: { code: 'not_found', class: 'permanent' } },
          })
          if (typeof id === 'string') {
            for (const resolve of credentialGetWaiters.get(id) ?? []) resolve()
            credentialGetWaiters.delete(id)
          }
          continue
        }
        if (request.method === 'credential.report_auth_failure') {
          reportAuthFailures.push({
            credential_id:
              typeof request.params?.credential_id === 'string'
                ? request.params.credential_id
                : undefined,
            provider_status:
              typeof request.params?.provider_status === 'number'
                ? request.params.provider_status
                : undefined,
            record_version:
              typeof request.params?.record_version === 'number'
                ? request.params.record_version
                : undefined,
            reporter_source:
              typeof request.params?.reporter_source === 'string'
                ? request.params.reporter_source
                : undefined,
          })
        }
        writeResponse(socket, header, {
          result:
            request.method === 'credential.report_auth_failure'
              ? { accepted: true }
              : {},
        })
      }
    })
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('fake Claustrum daemon has no TCP address')
  const connectionFile =
    input.connectionFile ?? join(input.directory, 'claustrum-connection.json')
  await writeConnectionFile(connectionFile, address.port)

  return {
    connectionFile,
    credentialGets,
    get scopedLists() {
      return scopedLists
    },
    revokeScoped: (credentialId) => revokedScoped.add(credentialId),
    reportAuthFailures,
    enrollmentProposals,
    async waitForCredentialGet(credentialId: string) {
      if (credentialGets.includes(credentialId)) return
      await new Promise<void>((resolve) => {
        const waiters = credentialGetWaiters.get(credentialId) ?? new Set()
        waiters.add(resolve)
        credentialGetWaiters.set(credentialId, waiters)
      })
    },
    async waitForEnrollmentProposal() {
      if (enrollmentProposals.length > 0) return
      await new Promise<void>((resolve) => {
        enrollmentProposalWaiters.add(resolve)
      })
    },
    async stop() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function payloadBytes(payload: FakeClaustrumCredential['payload']): number[] {
  if (typeof payload === 'string')
    return Array.from(new TextEncoder().encode(payload))
  return Array.from(payload)
}

function writeHandshakeMessage(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  socket.write(Buffer.concat([prefix, body]))
}

function writeResponse(
  socket: Socket,
  header: ReturnType<typeof decodeHeader>,
  value: unknown,
  type: FrameType = FrameType.Response,
): void {
  const frame = buildFrame(
    type,
    buildFlags(false, Priority.Interactive, false),
    header.channel,
    header.epoch,
    header.corr,
    new TextEncoder().encode(JSON.stringify(value)),
  )
  socket.write(Buffer.from(encodeFrame(frame)))
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
}

async function writeConnectionFile(path: string, port: number): Promise<void> {
  // Mirrors the production-test wire fixture because test files are not package APIs.
  await writeFile(
    path,
    JSON.stringify({
      schema: 1,
      wire_version: PROTOCOL_VERSION,
      endpoints: [{ host: '127.0.0.1', port }],
      key: Array.from(key),
      daemon_id: Array.from(daemonId),
      pid: process.pid,
      daemon_ver: 'fake-daemon',
    }),
    { mode: 0o600 },
  )
  await chmod(path, 0o600)
}
