import { afterEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  ClaustrumCredentialCache,
  ClaustrumCredentialError,
  connectClaustrumClient,
  connectClaustrumCredentialCache,
  getDefaultClaustrumConnectionPath,
  type LogTestRecord,
} from '@cortexkit/anthropic-auth-core'
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
  SubcCallError,
  SubcClient,
} from '@cortexkit/subc-client'

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const daemonId = Uint8Array.from({ length: 16 }, (_, index) => 200 + index)
const moduleId = 'aft'
const launchNonce = 'inherited-live-nonce'

type FakeDaemon = {
  port: number
  connections: number
  routeOpenBodies: Record<string, unknown>[]
  requestBodies: Record<string, unknown>[]
  responseBodies: unknown[]
  waitForRequests: (count: number) => Promise<void>
  waitForResponses: (count: number) => Promise<void>
  releaseResponses: () => void
  goodbyes: number
  waitForGoodbye: () => Promise<boolean>
  stop: () => Promise<void>
}

const tempDirs: string[] = []
const clients: Array<{ close: () => void }> = []
const daemons: FakeDaemon[] = []
const originalModuleId = process.env.SUBC_MODULE_ID
const originalLaunchNonce = process.env.SUBC_LAUNCH_NONCE

function frameBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function guardedConnector(expectedPath: string) {
  return async (options: {
    connectionFile: string
    handshakeTimeoutMs?: number
  }) => {
    expect(options.connectionFile).toBe(expectedPath)
    return SubcClient.connect(options)
  }
}

function writeHandshakeMessage(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  socket.write(Buffer.concat([prefix, body]))
}

async function startFakeDaemon(
  options: { holdResponses?: boolean } = {},
): Promise<FakeDaemon> {
  const routeOpenBodies: Record<string, unknown>[] = []
  const requestBodies: Record<string, unknown>[] = []
  const responseBodies: unknown[] = []
  const requestWaiters: Array<{
    count: number
    resolve: () => void
  }> = []
  let responseCount = 0
  const responseWaiters: Array<{
    count: number
    resolve: () => void
  }> = []
  let releaseResponses: (() => void) | null = null
  const responsesReleased = options.holdResponses
    ? new Promise<void>((resolve) => {
        releaseResponses = resolve
      })
    : Promise.resolve()
  let connections = 0
  let goodbyes = 0
  let resolveGoodbye: (() => void) | null = null
  const goodbyeSeen = new Promise<void>((resolve) => {
    resolveGoodbye = resolve
  })
  const server = createServer((socket) => {
    connections += 1
    let buffer = Buffer.alloc(0)
    let phase: 'hello' | 'auth' | 'frames' = 'hello'

    socket.on('error', () => {})
    socket.on('data', async (chunk) => {
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
        if (header.ty === FrameType.Goodbye) {
          goodbyes += 1
          resolveGoodbye?.()
          resolveGoodbye = null
          continue
        }
        if (header.ty !== FrameType.Request) continue
        const request = JSON.parse(body.toString('utf8')) as Record<
          string,
          unknown
        >
        if (header.channel === 0 && request.op === 'route.open') {
          routeOpenBodies.push(request)
        } else if (header.channel !== 7) {
          continue
        } else {
          requestBodies.push(request)
          for (const waiter of requestWaiters.splice(0)) {
            if (requestBodies.length >= waiter.count) waiter.resolve()
            else requestWaiters.push(waiter)
          }
        }
        if (header.channel !== 0) await responsesReleased
        const response = buildFrame(
          FrameType.Response,
          buildFlags(false, Priority.Interactive, false),
          header.channel,
          header.epoch,
          header.corr,
          frameBody(
            header.channel === 0
              ? { route_channel: 7, route_epoch: 1 }
              : (responseBodies.shift() ?? { result: 'ok' }),
          ),
        )
        socket.write(Buffer.from(encodeFrame(response)))
        if (header.channel !== 0) {
          responseCount += 1
          for (const waiter of responseWaiters.splice(0)) {
            if (responseCount >= waiter.count) waiter.resolve()
            else responseWaiters.push(waiter)
          }
        }
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('fake daemon has no TCP address')

  const daemon: FakeDaemon = {
    port: address.port,
    get connections() {
      return connections
    },
    routeOpenBodies,
    requestBodies,
    responseBodies,
    waitForRequests(count) {
      if (requestBodies.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => {
        requestWaiters.push({ count, resolve })
      })
    },
    waitForResponses(count) {
      if (responseCount >= count) return Promise.resolve()
      return new Promise<void>((resolve) => {
        responseWaiters.push({ count, resolve })
      })
    },
    releaseResponses() {
      releaseResponses?.()
      releaseResponses = null
    },
    get goodbyes() {
      return goodbyes
    },
    async waitForGoodbye() {
      return Promise.race([
        goodbyeSeen.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 2_000),
        ),
      ])
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  daemons.push(daemon)
  return daemon
}

async function writeConnectionFile(path: string, port: number): Promise<void> {
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

async function makeConnectionFile(
  port: number,
  name = 'connection.json',
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'claustrum-client-test-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  await writeConnectionFile(path, port)
  return path
}

afterEach(async () => {
  __setLogTestSink(null)
  if (originalModuleId === undefined) delete process.env.SUBC_MODULE_ID
  else process.env.SUBC_MODULE_ID = originalModuleId
  if (originalLaunchNonce === undefined) delete process.env.SUBC_LAUNCH_NONCE
  else process.env.SUBC_LAUNCH_NONCE = originalLaunchNonce
  for (const client of clients.splice(0)) client.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('ClaustrumClient', () => {
  test('sends route.open without inherited consumer identity', async () => {
    process.env.SUBC_MODULE_ID = moduleId
    process.env.SUBC_LAUNCH_NONCE = launchNonce
    const daemon = await startFakeDaemon()
    const connectionFile = await makeConnectionFile(daemon.port)

    const unsafe = await SubcClient.connect({ connectionFile })
    clients.push(unsafe)
    const unsafeRoute = await unsafe.routeOpen(
      { kind: 'management_surface', module_id: 'claustrum-vault' },
      { project_root: '/tmp/project', harness: 'test', session: 'unsafe' },
    )
    expect(unsafeRoute.channel).toBe(7)

    const safe = await connectClaustrumClient({
      connectionFile,
      connector: guardedConnector(connectionFile),
    })
    clients.push(safe)
    const safeRoute = await safe.routeOpen(
      { kind: 'management_surface', module_id: 'claustrum-vault' },
      { project_root: '/tmp/project', harness: 'test', session: 'safe' },
    )
    expect(safeRoute.channel).toBe(7)
    await expect(
      safe.call(
        'claustrum-vault',
        'test.method',
        { value: 'not-a-vault-call' },
        {
          identity: {
            project_root: '/tmp/project',
            harness: 'test',
            session: 'managed',
          },
        },
      ),
    ).resolves.toEqual({ result: 'ok' })
    await safe.closeManagedRoute(
      { kind: 'management_surface', module_id: 'claustrum-vault' },
      { project_root: '/tmp/project', harness: 'test', session: 'managed' },
    )
    expect(await daemon.waitForGoodbye()).toBe(true)
    expect(daemon.goodbyes).toBeGreaterThan(0)

    expect(daemon.routeOpenBodies).toHaveLength(3)
    expect(daemon.routeOpenBodies[0]).toMatchObject({
      consumer_identity: { module_id: moduleId, launch_nonce: launchNonce },
    })
    expect(daemon.routeOpenBodies[1]).toMatchObject({
      op: 'route.open',
      target: { kind: 'management_surface', module_id: 'claustrum-vault' },
      identity: {
        project_root: '/tmp/project',
        harness: 'test',
        session: 'safe',
      },
    })
    expect('consumer_identity' in daemon.routeOpenBodies[1]!).toBe(false)
    expect('consumer_identity' in daemon.routeOpenBodies[2]!).toBe(false)
  })

  test('threads a configured connection path into the real transport', async () => {
    const daemon = await startFakeDaemon()
    const configuredPath = await makeConnectionFile(
      daemon.port,
      'configured.json',
    )
    const defaultPath = getDefaultClaustrumConnectionPath()
    expect(configuredPath).not.toBe(defaultPath)

    const client = await connectClaustrumClient({
      connectionFile: configuredPath,
      connector: guardedConnector(configuredPath),
    })
    clients.push(client)

    expect(daemon.connections).toBe(1)
  })

  test('reconnects a resident client after a terminal route failure', async () => {
    let connections = 0
    const first = {
      call: async () => {
        throw new SubcCallError(
          'terminal',
          'resident route wedged',
          'route_wedged',
        )
      },
      close: () => {},
    }
    const second = {
      call: async () => ({ result: { ok: true } }),
      close: () => {},
    }
    const client = await connectClaustrumClient({
      connectionFile: '/tmp/unused-claustrum-connection.json',
      connector: async () => {
        connections += 1
        return (connections === 1 ? first : second) as never
      },
    })
    clients.push(client)

    await expect(
      client.call('claustrum', 'credential.get', { handle: 'h' }),
    ).resolves.toEqual({ result: { ok: true } })
    await expect(
      client.call('claustrum', 'credential.get', { handle: 'h' }),
    ).resolves.toEqual({ result: { ok: true } })
    expect(connections).toBe(2)
  })

  test('shares an in-flight reconnect between concurrent terminal failures', async () => {
    let connections = 0
    const first = {
      call: async () => {
        throw new SubcCallError(
          'terminal',
          'resident route wedged',
          'route_wedged',
        )
      },
      close: () => {},
    }
    const second = {
      call: async () => ({ result: { ok: true } }),
      close: () => {},
    }
    const reconnect = Promise.withResolvers<void>()
    const client = await connectClaustrumClient({
      connectionFile: '/tmp/unused-claustrum-connection.json',
      connector: async () => {
        connections += 1
        if (connections === 1) return first as never
        await reconnect.promise
        return second as never
      },
    })
    clients.push(client)

    const firstCall = client.call('claustrum', 'credential.get', {
      handle: 'h',
    })
    const secondCall = client.call('claustrum', 'credential.get', {
      handle: 'h',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(connections).toBe(2)
    reconnect.resolve()
    await expect(Promise.all([firstCall, secondCall])).resolves.toEqual([
      { result: { ok: true } },
      { result: { ok: true } },
    ])
  })

  test('closes a replacement client when close wins an in-flight reconnect', async () => {
    let connections = 0
    let replacementCloses = 0
    const reconnectStarted = Promise.withResolvers<void>()
    const releaseReconnect = Promise.withResolvers<void>()
    const first = {
      call: async () => {
        throw new SubcCallError(
          'terminal',
          'resident route wedged',
          'route_wedged',
        )
      },
      close: () => {},
    }
    const replacement = {
      call: async () => ({ result: { ok: true } }),
      close: () => {
        replacementCloses += 1
      },
    }
    const client = await connectClaustrumClient({
      connectionFile: '/tmp/unused-claustrum-connection.json',
      connector: async () => {
        connections += 1
        if (connections === 1) return first as never
        reconnectStarted.resolve()
        await releaseReconnect.promise
        return replacement as never
      },
    })
    clients.push(client)

    const call = client.call('claustrum', 'credential.get', { handle: 'h' })
    await reconnectStarted.promise
    client.close()
    releaseReconnect.resolve()

    await expect(call).rejects.toThrow('Claustrum client is closed')
    expect(replacementCloses).toBe(1)
  })

  test('keeps the connection-file key behind owner-only permissions', async () => {
    const daemon = await startFakeDaemon()
    const connectionFile = await makeConnectionFile(daemon.port)

    expect((await stat(connectionFile)).mode & 0o777).toBe(0o600)
    await chmod(connectionFile, 0o644)

    await expect(
      connectClaustrumClient({
        connectionFile,
        connector: guardedConnector(connectionFile),
      }),
    ).rejects.toThrow('insecure permissions')
    expect(daemon.connections).toBe(0)
  })

  test('normal core boot inspection remains inert', async () => {
    const daemon = await startFakeDaemon()
    const absentPath = join(
      tmpdir(),
      `claustrum-never-connects-${randomUUID()}.json`,
    )
    const before = daemon.connections
    const detection = await import('@cortexkit/anthropic-auth-core').then(
      ({ detectClaustrumConnection }) => detectClaustrumConnection(absentPath),
    )

    expect(detection).toEqual({ status: 'absent', path: absentPath })
    expect(daemon.connections).toBe(before)
  })
})

describe('ClaustrumCredentialCache', () => {
  const handle = 'ckh_credential-test'

  async function makeCredentialCache(
    daemon: FakeDaemon,
    now: () => number = () => 500,
  ): Promise<ClaustrumCredentialCache> {
    const connectionFile = await makeConnectionFile(daemon.port)
    const client = await connectClaustrumClient({
      connectionFile,
      connector: guardedConnector(connectionFile),
    })
    clients.push(client)
    return new ClaustrumCredentialCache(client, {
      identity: {
        project_root: '/tmp/project',
        harness: 'test',
        session: 'credential-cache',
      },
      now,
    })
  }

  test('decodes a Vec<u8> JSON number array and caches through expiry', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push({
      result: {
        payload: Array.from(
          new TextEncoder().encode('{"access_token":"served"}'),
        ),
        expires_at_ms: 1_500,
        record_version: 63,
        project_id: 'project-7',
        account_id: 'account-7',
      },
    })
    let now = 500
    const cache = await makeCredentialCache(daemon, () => now)

    const first = await cache.get(handle)
    const second = await cache.get(handle)

    expect(first).toEqual({
      payload: '{"access_token":"served"}',
      expiresAtMs: 1_500,
      recordVersion: 63,
      projectId: 'project-7',
      accountId: 'account-7',
    })
    expect(second).toEqual(first)
    expect(daemon.requestBodies).toHaveLength(1)
    expect(daemon.requestBodies[0]).toEqual({
      method: 'credential.get',
      params: {
        handle,
        force_refresh: false,
        min_ttl_ms: 120_000,
      },
    })
    expect(daemon.routeOpenBodies.at(-1)).toMatchObject({
      target: { kind: 'management_surface', module_id: 'claustrum' },
    })

    now = 1_500
    daemon.responseBodies.push({
      result: {
        payload: Array.from(new TextEncoder().encode('refreshed')),
        expires_at_ms: 2_500,
        record_version: 64,
      },
    })
    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'refreshed',
      recordVersion: 64,
    })
    expect(daemon.requestBodies).toHaveLength(2)
  })

  test('bypasses a resident credential without discarding it when the fresh get fails', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push({
      result: {
        payload: Array.from(new TextEncoder().encode('served')),
        expires_at_ms: 1_500,
        record_version: 63,
      },
    })
    const cache = await makeCredentialCache(daemon)
    await cache.get(handle)
    daemon.responseBodies.push({
      result: { error: { code: 'refresh_failed', class: 'transient' } },
    })

    await expect(
      cache.get(handle, 0, { bypassCache: true }),
    ).rejects.toMatchObject({
      action: 'retry',
    })

    expect(cache.peek(handle)).toMatchObject({ recordVersion: 63 })
    expect(daemon.requestBodies).toHaveLength(2)
  })

  test('uses the requested minimum TTL to refresh near expiry without refreshing above it', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push({
      result: {
        payload: Array.from(new TextEncoder().encode('served')),
        expires_at_ms: 2_000,
        record_version: 1,
      },
    })
    let now = 500
    const cache = await makeCredentialCache(daemon, () => now)

    await cache.get(handle, 1_000)
    now = 800
    await cache.get(handle, 1_000)
    expect(daemon.requestBodies).toHaveLength(1)

    daemon.responseBodies.push({
      result: {
        payload: Array.from(new TextEncoder().encode('refreshed')),
        expires_at_ms: 3_000,
        record_version: 2,
      },
    })
    now = 1_100
    await cache.get(handle, 1_000)
    await daemon.waitForRequests(2)
    expect(daemon.requestBodies.at(-1)).toEqual({
      method: 'credential.get',
      params: {
        handle,
        force_refresh: false,
        min_ttl_ms: 1_000,
      },
    })
  })

  test('handles the nested error arm and pins the top-level anti-pattern', async () => {
    const daemon = await startFakeDaemon()
    const nestedResponse = {
      result: { error: { code: 'future_code', class: 'permanent' } },
    }
    daemon.responseBodies.push(nestedResponse)
    const cache = await makeCredentialCache(daemon)

    const topLevelErrorCheck = (response: typeof nestedResponse) =>
      'error' in response ? response.error : undefined
    expect(topLevelErrorCheck(nestedResponse)).toBeUndefined()
    expect(nestedResponse.result.error).toEqual({
      code: 'future_code',
      class: 'permanent',
    })
    try {
      await cache.get(handle)
      throw new Error('expected credential error')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'future_code',
        errorClass: 'permanent',
        action: 'gone',
      })
      expect(
        error != null &&
          typeof error === 'object' &&
          Object.hasOwn(error, 'class'),
      ).toBe(false)
      expect(error).toBeInstanceOf(ClaustrumCredentialError)
    }
  })

  test('rejects a result that has metadata but no non-empty payload', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push({
      result: {
        payload: [],
        expires_at_ms: 1_500,
        record_version: 63,
      },
    })
    const cache = await makeCredentialCache(daemon)

    await expect(cache.get(handle)).rejects.toMatchObject({
      code: 'invalid_response',
      errorClass: 'transient',
      action: 'retry',
    })
  })

  test('maps every wire error class without branching on producer codes', async () => {
    const daemon = await startFakeDaemon()
    const cache = await makeCredentialCache(daemon)
    const cases = [
      ['not_found', 'permanent', 'gone'],
      ['needs_reauth', 'auth_required', 'reauth'],
      ['refresh_failed', 'transient', 'retry'],
      ['ttl_unsatisfiable', 'context_overflow', 'reduce_and_retry'],
    ] as const

    for (const [code, errorClass, action] of cases) {
      daemon.responseBodies.push({
        result: { error: { code, class: errorClass } },
      })
      await expect(cache.get(`${handle}-${code}`)).rejects.toMatchObject({
        code,
        errorClass,
        action,
      })
    }
  })

  test('classifies a connection failure as transient with retry backoff', async () => {
    const client = {
      call: async () => {
        throw new Error('connection reset by peer')
      },
      close: () => {},
    }
    const cache = new ClaustrumCredentialCache(client as never)

    await expect(cache.get(handle)).rejects.toMatchObject({
      code: 'transport_error',
      errorClass: 'transient',
      action: 'retry',
    })
  })

  test('warns and bounds an unknown wire error class as transient', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push({
      result: { error: { code: 'future_code', class: 'future_class' } },
    })
    const cache = await makeCredentialCache(daemon)
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))

    await expect(cache.get(`${handle}-future`)).rejects.toMatchObject({
      code: 'future_code',
      errorClass: 'transient',
      action: 'retry',
    })

    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        channel: 'claustrum',
        payload: expect.objectContaining({ errorClass: 'future_class' }),
      }),
    )

    daemon.responseBodies.push({
      result: { error: { code: 'missing_class' } },
    })
    await expect(cache.get(`${handle}-missing-class`)).rejects.toMatchObject({
      code: 'missing_class',
      errorClass: 'transient',
      action: 'retry',
    })
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        channel: 'claustrum',
        payload: expect.objectContaining({ errorClass: null }),
      }),
    )
  })

  test('single-flights concurrent misses for one handle', async () => {
    const daemon = await startFakeDaemon({ holdResponses: true })
    daemon.responseBodies.push({
      result: {
        payload: Array.from(new TextEncoder().encode('shared')),
        expires_at_ms: 1_500,
        record_version: 63,
      },
    })
    const cache = await makeCredentialCache(daemon)

    const pending = Promise.all([cache.get(handle), cache.get(handle)])
    await daemon.waitForRequests(1)
    expect(daemon.requestBodies).toHaveLength(1)
    daemon.releaseResponses()

    const [first, second] = await pending
    expect(first).toBe(second)
  })

  test('refreshes inside the minimum-TTL window while serving the cached credential', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push(
      {
        result: {
          payload: Array.from(new TextEncoder().encode('credential-v1')),
          expires_at_ms: 121_000,
          record_version: 1,
        },
      },
      {
        result: {
          payload: Array.from(new TextEncoder().encode('credential-v2')),
          expires_at_ms: 121_000,
          record_version: 2,
        },
      },
    )
    let now = 0
    const cache = await makeCredentialCache(daemon, () => now)

    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'credential-v1',
      recordVersion: 1,
    })
    now = 2_000
    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'credential-v1',
      recordVersion: 1,
    })
    await daemon.waitForRequests(2)
    await daemon.waitForResponses(2)
    expect(daemon.requestBodies).toHaveLength(2)

    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'credential-v1',
      recordVersion: 1,
    })
    expect(daemon.requestBodies).toHaveLength(2)
  })

  test('logs a latched background refresh failure once until a successful refresh re-arms it', async () => {
    let now = 0
    const responses = [
      { result: { error: { code: 'not_found', class: 'permanent' } } },
      { result: { error: { code: 'not_found', class: 'permanent' } } },
      {
        result: {
          payload: Array.from(new TextEncoder().encode('credential-v2')),
          expires_at_ms: 500_000,
          record_version: 74,
        },
      },
      { result: { error: { code: 'not_found', class: 'permanent' } } },
    ]
    const cache = new ClaustrumCredentialCache(
      {
        call: mock(async () => responses.shift()),
        close: () => {},
      } as never,
      { now: () => now },
    )
    cache.seedForTest(handle, {
      payload: 'credential-v1',
      expiresAtMs: 300_000,
      recordVersion: 73,
    })
    const logs: LogTestRecord[] = []
    __setLogTestSink((record) => logs.push(record))
    const flushBackgroundRefresh = async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    now = 181_000
    await cache.get(handle)
    await flushBackgroundRefresh()
    now = 242_000
    await cache.get(handle)
    await flushBackgroundRefresh()
    expect(
      logs.filter(
        (record) => record.message === 'credential background refresh latched',
      ),
    ).toHaveLength(1)

    now = 303_000
    await cache.get(handle)
    await flushBackgroundRefresh()
    now = 381_000
    await cache.get(handle)
    await flushBackgroundRefresh()
    const latched = logs.filter(
      (record) => record.message === 'credential background refresh latched',
    )
    expect(latched).toHaveLength(2)
    expect(latched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'claustrum',
          payload: expect.objectContaining({ recordVersion: 73 }),
        }),
      ]),
    )
  })

  test('does not retain a credential whose expiry is absent', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push(
      {
        result: {
          payload: Array.from(new TextEncoder().encode('unbounded-1')),
          expires_at_ms: null,
          record_version: 63,
        },
      },
      {
        result: {
          payload: Array.from(new TextEncoder().encode('unbounded-2')),
          expires_at_ms: 1_500,
          record_version: 64,
        },
      },
    )
    const cache = await makeCredentialCache(daemon)

    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'unbounded-1',
    })
    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'unbounded-2',
      recordVersion: 64,
    })
    expect(daemon.requestBodies).toHaveLength(2)
  })

  test('reports the served record version and invalidates only that cache entry', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push(
      {
        result: {
          payload: Array.from(new TextEncoder().encode('served-v63')),
          expires_at_ms: 1_000,
          record_version: 63,
        },
      },
      { result: { ok: true } },
      {
        result: {
          payload: Array.from(new TextEncoder().encode('served-v64')),
          expires_at_ms: 2_000,
          record_version: 64,
        },
      },
    )
    const cache = await makeCredentialCache(daemon)
    const served = await cache.get(handle)

    await cache.reportAuthFailure(handle, 401, served, 'direct')

    const report = daemon.requestBodies[1]
    expect(report).toBeDefined()
    if (!report) throw new Error('report request was not captured')
    expect(report).toMatchObject({
      method: 'credential.report_auth_failure',
      params: {
        handle,
        provider_status: 401,
        record_version: 63,
        reporter_source: 'direct',
      },
    })
    expect(
      Object.hasOwn(
        (report.params ?? {}) as Record<string, unknown>,
        'record_version',
      ),
    ).toBe(true)
    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'served-v64',
      recordVersion: 64,
    })
    expect(daemon.requestBodies).toHaveLength(3)
  })

  test('keeps a newer local version after reporting a stale served version', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push(
      {
        result: {
          payload: Array.from(new TextEncoder().encode('served-v63')),
          expires_at_ms: 1_000,
          record_version: 63,
        },
      },
      {
        result: {
          payload: Array.from(new TextEncoder().encode('served-v64')),
          expires_at_ms: 2_000,
          record_version: 64,
        },
      },
      { result: { ok: true } },
    )
    let now = 500
    const cache = await makeCredentialCache(daemon, () => now)
    const staleServed = await cache.get(handle)
    now = 1_000
    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'served-v64',
      recordVersion: 64,
    })

    await cache.reportAuthFailure(handle, 401, staleServed)

    expect(daemon.requestBodies[2]).toMatchObject({
      method: 'credential.report_auth_failure',
      params: { record_version: 63 },
    })
    now = 1_500
    await expect(cache.get(handle)).resolves.toMatchObject({
      payload: 'served-v64',
      recordVersion: 64,
    })
    expect(daemon.requestBodies).toHaveLength(3)
  })

  test('omits reporter source when the caller has no source', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push(
      {
        result: {
          payload: Array.from(new TextEncoder().encode('served-v63')),
          expires_at_ms: 1_000,
          record_version: 63,
        },
      },
      { result: { ok: true } },
    )
    const cache = await makeCredentialCache(daemon)
    const served = await cache.get(handle)

    await cache.reportAuthFailure(handle, 401, served)

    const params = daemon.requestBodies[1]?.params
    expect(params).toBeDefined()
    expect(Object.hasOwn(params ?? {}, 'reporter_source')).toBe(false)
  })

  test('requires served provenance instead of reporting the current cache entry', async () => {
    const daemon = await startFakeDaemon()
    daemon.responseBodies.push({
      result: {
        payload: Array.from(new TextEncoder().encode('current-cache-value')),
        expires_at_ms: 2_000,
        record_version: 64,
      },
    })
    const cache = await makeCredentialCache(daemon)
    await cache.get(handle)

    // @ts-expect-error served provenance is required by the public overload
    await expect(cache.reportAuthFailure(handle, 401)).rejects.toThrow(
      'record_version is required from the credential served to the provider',
    )
    expect(daemon.requestBodies).toHaveLength(1)
    expect(cache.peek(handle)?.recordVersion).toBe(64)
  })

  test('does not connect or get when the runtime gate is disabled', async () => {
    let connectorCalls = 0
    const cache = await connectClaustrumCredentialCache({
      enabled: false,
      connectionFile: '/tmp/claustrum-disabled-test.json',
      connector: async () => {
        connectorCalls += 1
        throw new Error('disabled path connected')
      },
    })

    expect(cache).toBeNull()
    expect(connectorCalls).toBe(0)
  })
})
