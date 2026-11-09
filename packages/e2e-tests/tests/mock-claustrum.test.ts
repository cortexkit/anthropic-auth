/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFlags,
  buildFrame,
  decodeHeader,
  encodeFrame,
  FrameType,
  HEADER_LEN,
  Priority,
  SubcClient,
} from '@cortexkit/subc-client'
import { startFakeClaustrumDaemon } from '../src/mock-claustrum.ts'

const roots: string[] = []
const daemons: Array<{ stop: () => Promise<void> }> = []
const clients: Array<{ close: () => void }> = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fake Claustrum daemon', () => {
  it('accepts a person-facing display_name on an enrollment proposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-claustrum-'))
    roots.push(root)
    const daemon = await startFakeClaustrumDaemon({ directory: root, scopedCredentials: {} })
    daemons.push(daemon)
    const client = await SubcClient.connect({
      connectionFile: daemon.connectionFile,
      identity: { project_root: root, harness: 'e2e', session: 'fixture-enrollment' },
    })
    clients.push(client)
    const response = await client.call('claustrum', 'auth.enroll_propose', {
      proposed_name: 'anthropic-auth-opencode',
      display_name: 'Claude sign-in for OpenCode',
      request_secret_hash: 'ab'.repeat(32),
    })
    expect(response).toEqual({ result: { request_id: 'fake-enrollment-request' } })
    expect(daemon.enrollmentProposals).toEqual([{
      proposed_name: 'anthropic-auth-opencode',
      display_name: 'Claude sign-in for OpenCode',
      request_secret_hash: 'ab'.repeat(32),
    }])
  })

  it('serves a credential payload through the Subc wire protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-claustrum-'))
    roots.push(root)
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      scopedCredentials: {
        'oauth:anthropic': {
          payload: JSON.stringify({ access_token: 'vault-main' }),
          account_id: 'account-main',
          record_version: 7,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    const client = await SubcClient.connect({
      connectionFile: daemon.connectionFile,
      identity: { project_root: root, harness: 'e2e', session: 'fixture-smoke' },
    })
    clients.push(client)

    const response = await client.call('claustrum', 'credential.get_scoped', {
      credential_id: 'oauth:anthropic',
      enrollment_token: 'aa'.repeat(32),
      min_ttl_ms: 0,
    })

    expect(response).toEqual({
      result: {
        payload: Array.from(new TextEncoder().encode('{"access_token":"vault-main"}')),
        credential_id: 'oauth:anthropic',
        account_id: 'account-main',
        record_version: 7,
        expires_at_ms: expect.any(Number),
      },
    })
  })

  it('rejects credential requests on an unassigned route channel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-claustrum-'))
    roots.push(root)
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      scopedCredentials: {
        'oauth:anthropic': {
          payload: JSON.stringify({ access_token: 'vault-main' }),
          account_id: 'account-main',
          record_version: 7,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    const socket = await connectRawDaemon(daemon.connectionFile)
    try {
      const response = nextSocketData(socket)
      const request = buildFrame(
        FrameType.Request,
        buildFlags(false, Priority.Interactive, false),
        8,
        1,
        1n,
        Buffer.from(
          JSON.stringify({
            method: 'credential.get_scoped',
            params: { credential_id: 'oauth:anthropic', enrollment_token: 'aa'.repeat(32) },
          }),
        ),
      )
      socket.write(Buffer.from(encodeFrame(request)))

      const frame = await response
      const header = decodeHeader(frame)
      expect(header.ty).toBe(FrameType.Error)
      expect(
        JSON.parse(
          frame
            .subarray(HEADER_LEN, HEADER_LEN + header.len)
            .toString('utf8'),
        ),
      ).toEqual({ code: 'unknown_channel' })
    } finally {
      socket.destroy()
    }
  })

  it('answers a vault watch as a vault without the method, on its own route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-claustrum-'))
    roots.push(root)
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      scopedCredentials: {
        'oauth:anthropic': {
          payload: JSON.stringify({ access_token: 'vault-main' }),
          account_id: 'account-main',
          record_version: 7,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    const identity = { project_root: root, harness: 'e2e', session: 'fixture-watch' }
    const client = await SubcClient.connect({ connectionFile: daemon.connectionFile, identity })
    clients.push(client)
    const credential = () =>
      client.call('claustrum', 'credential.get_scoped', {
        credential_id: 'oauth:anthropic',
        enrollment_token: 'aa'.repeat(32),
        min_ttl_ms: 0,
      })
    await credential()

    // Opened the way claustrum-client 0.12.0 opens its watch.
    const route = await client.routeOpen(
      { kind: 'management_surface', module_id: 'claustrum' },
      identity,
      { consumerIdentity: null },
    )
    const watch = client.subscribe(
      route,
      { method: 'auth.watch_scoped', params: { enrollment_token: 'aa'.repeat(32) } },
      () => {},
    )
    await expect(watch.closed).rejects.toMatchObject({ code: 'unknown_method' })
    await client.closeRoute(route)

    // The credential route still answers after the watch route closed.
    expect(await credential()).toMatchObject({ result: { credential_id: 'oauth:anthropic' } })
  })
})

async function connectRawDaemon(connectionFile: string): Promise<Socket> {
  const connection = (await Bun.file(connectionFile).json()) as {
    endpoints: Array<{ host: string; port: number }>
  }
  const endpoint = connection.endpoints[0]!
  const socket = createConnection(endpoint.port, endpoint.host)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const hello = nextSocketData(socket)
  writeHandshakeMessage(socket, {
    client_nonce: Array.from({ length: 32 }, (_, index) => index),
  })
  await hello
  writeHandshakeMessage(socket, { client_auth: [] })
  return socket
}

function nextSocketData(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.once('data', (chunk) => resolve(Buffer.from(chunk)))
    socket.once('error', reject)
  })
}

function writeHandshakeMessage(socket: Socket, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32LE(body.length)
  socket.write(Buffer.concat([prefix, body]))
}
