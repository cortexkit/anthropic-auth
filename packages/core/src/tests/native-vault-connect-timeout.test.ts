import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BindIdentity,
  buildFrame,
  computeProof,
  decodeHeader,
  encodeFrame,
  FrameType,
  HEADER_LEN,
  SERVER_PROOF_DOMAIN,
  SubcClient,
} from '@cortexkit/subc-client'

import { createNativeCustody, NativeCustodyError } from '../native-custody.ts'
import { connectNativeVaultScopedClient } from '../native-vault-runtime.ts'
import { vaultOutageClock } from './vault-outage-clock.ts'

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const daemonId = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
const serverNonce = Uint8Array.from({ length: 32 }, (_, index) => 255 - index)

type RetryableDaemon = {
  connectionFile: string
  routeOpenAttempts: () => number
  close: () => Promise<void>
}

async function startRetryableDaemon(root: string): Promise<RetryableDaemon> {
  let routeOpenAttempts = 0
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let phase: 'hello' | 'auth' | 'frames' = 'hello'
    let buffer = Buffer.alloc(0)

    const sendAuth = (message: unknown) => {
      const body = Buffer.from(JSON.stringify(message))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32LE(body.length)
      socket.write(Buffer.concat([prefix, body]))
    }

    const handleFrames = () => {
      while (buffer.length >= HEADER_LEN) {
        const header = decodeHeader(buffer.subarray(0, HEADER_LEN))
        const frameLength = HEADER_LEN + header.len
        if (buffer.length < frameLength) return
        const body = buffer.subarray(HEADER_LEN, frameLength)
        buffer = buffer.subarray(frameLength)
        if (header.ty !== FrameType.Request || header.channel !== 0) continue
        const request = JSON.parse(body.toString('utf8')) as { op?: string }
        if (request.op !== 'route.open') continue
        routeOpenAttempts++
        const refusal = buildFrame(
          FrameType.Error,
          0,
          header.channel,
          header.epoch,
          header.corr,
          Buffer.from(
            JSON.stringify({
              code: 'module_warming',
              message: 'The synthetic vault route is still starting.',
            }),
          ),
        )
        socket.write(Buffer.from(encodeFrame(refusal)))
      }
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk)])
      while (phase !== 'frames' && buffer.length >= 4) {
        const length = buffer.readUInt32LE(0)
        if (buffer.length < 4 + length) return
        const message = JSON.parse(
          buffer.subarray(4, 4 + length).toString('utf8'),
        ) as { client_nonce?: number[] }
        buffer = buffer.subarray(4 + length)
        if (phase === 'hello') {
          const clientNonce = Uint8Array.from(message.client_nonce ?? [])
          const serverProof = computeProof(
            key,
            SERVER_PROOF_DOMAIN,
            clientNonce,
            serverNonce,
            daemonId,
          )
          sendAuth({
            daemon_id: Array.from(daemonId),
            server_nonce: Array.from(serverNonce),
            daemon_ver: 'synthetic',
            server_proof: Array.from(serverProof),
          })
          phase = 'auth'
        } else {
          phase = 'frames'
        }
      }
      if (phase === 'frames') handleFrames()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Synthetic vault daemon did not bind a TCP port')
  const connectionFile = join(root, 'connection.json')
  await writeFile(
    connectionFile,
    JSON.stringify({
      schema: 1,
      endpoints: [{ host: '127.0.0.1', port: address.port }],
      key: Array.from(key),
      daemon_id: Array.from(daemonId),
      pid: process.pid,
      daemon_ver: 'synthetic',
    }),
    { mode: 0o600 },
  )

  return {
    connectionFile,
    routeOpenAttempts: () => routeOpenAttempts,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}

test('each vault connect and route-open attempt keeps its two-second bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-vault-connect-timeout-'))
  let daemon: RetryableDaemon | undefined
  const clock = vaultOutageClock(0)
  const connect = SubcClient.connect.bind(SubcClient)
  const connector = spyOn(SubcClient, 'connect').mockImplementation(
    (options) => {
      expect(options.handshakeTimeoutMs).toBe(2_000)
      expect(options.routeOpenRetryDeadlineMs).toBe(2_000)
      return connect({
        ...options,
        now: clock.now,
        sleep: async (ms) => {
          clock.set(clock.now() + ms)
        },
        random: () => 0,
      })
    },
  )
  try {
    daemon = await startRetryableDaemon(root)
    const identity: BindIdentity = {
      project_root: root,
      harness: 'opencode',
      session: 'native-vault-timeout-test',
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await connectNativeVaultScopedClient(
        daemon.connectionFile,
        identity,
      )
      try {
        const started = clock.now()
        await expect(
          client.getScoped({ credentialId: 'credential-test' }),
        ).rejects.toThrow()
        expect(clock.now() - started).toBe(2_000)
      } finally {
        client.close()
      }
    }
    expect(daemon.routeOpenAttempts()).toBeGreaterThan(1)
  } finally {
    connector.mockRestore()
    await daemon?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 8_000)

test('cold authorization exhausts the ten-second young-outage wait with the unavailable error', async () => {
  const clock = vaultOutageClock(0)
  const durations: number[] = []
  const custody = createNativeCustody({
    host: 'opencode',
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    readToken: async () => ({ token: '01'.repeat(32), token_generation: 1 }),
    connect: async () => {
      const started = clock.now()
      await new Promise<void>((_resolve, reject) => {
        clock.setTimeout(() => {
          durations.push(clock.now() - started)
          reject(
            Object.assign(new Error('Synthetic vault unreachable'), {
              code: 'ECONNREFUSED',
            }),
          )
        }, 2_000)
      })
      throw new Error('Unreachable connection unexpectedly succeeded')
    },
  })
  try {
    const error = await clock
      .finish(
        custody.authorize({
          credentialId: 'credential-test',
          accountIdentity: 'account-test',
        }),
      )
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(NativeCustodyError)
    expect(error).toMatchObject({ code: 'unavailable' })
    expect(clock.now()).toBe(10_000)
    expect(durations.length).toBeGreaterThan(1)
    expect(durations.every((ms) => ms === 2_000)).toBe(true)
  } finally {
    custody.close()
  }
})
