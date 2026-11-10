import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CacheKeepManager,
  RequestGzipLatch,
  resetDumpState,
  setDumpEnabled,
} from '@cortexkit/anthropic-auth-core'
import type { Attempt, RequestScope } from '@cortexkit/common-auth/opencode2'
import { LANE_START_REQUEST_HEADER } from '../lane-start'
import type { NativeAnthropicAttemptData } from '../v2/adapter'
import {
  createNativeAnthropicAdapter,
  type NativeAnthropicSource,
} from '../v2/adapter'
import { createNativeAnthropicSource } from '../v2/source'

type Provenance = { readonly custody: 'local'; readonly receipt: string }
type Data = NativeAnthropicAttemptData<Provenance>
type Quota = { readonly unified: string | null }

const UPSTREAM = 'https://api.anthropic.com/v1/messages'
const IDENTITY = {
  deviceId: 'd'.repeat(64),
  accountUuid: '6f1d1c2e-0000-4000-8000-00000000a11c' as never,
  sessionId: '11111111-2222-4333-8444-555555555555' as never,
}
const TOKEN = 'sk-ant-oat01-test-token-do-not-log'

const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
const dumpDirs: string[] = []
let dumpDir = ''

async function freshDumpDir() {
  dumpDir = await mkdtemp(join(tmpdir(), 'oc2-dump-test-'))
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  return dumpDir
}

beforeEach(async () => {
  await freshDumpDir()
})

afterEach(async () => {
  resetDumpState()
  if (originalDumpDir === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
  await Promise.all(
    dumpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

function scopeOf(over: Partial<RequestScope> = {}): RequestScope {
  return {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-5',
    sessionID: 'ses_dump_01',
    agent: 'build',
    kind: 'primary',
    ...over,
  } as RequestScope
}

function makeSource(
  over: {
    enabled?: boolean
    dispatch?: { kind: 'http-relay'; url: string; token: string } | undefined
  } = {},
) {
  const enabled = over.enabled ?? true
  const source: NativeAnthropicSource<Quota, Provenance> = {
    chooseAccount: () => 'main',
    authorizeAccount: () => ({
      route: 'oauth' as const,
      accessToken: TOKEN,
      credentialId: 'synthetic-credential-row',
      identity: IDENTITY as never,
      provenance: { custody: 'local', receipt: 'local:main' },
      ...(over.dispatch ? { dispatch: over.dispatch } : {}),
    }),
    requestOptions: () => ({}),
    isDumpEnabled: () => enabled,
  }
  return source
}

async function driveDirect(options: {
  enabled?: boolean
  laneStart?: boolean
  upstreamStatus?: number
  upstreamBody?: unknown
  upstreamSse?: string
  payload?: unknown
}) {
  const source = makeSource({ enabled: options.enabled })
  const native = createNativeAnthropicAdapter({ source })
  try {
    const scope = scopeOf()
    const accountId = (await native.adapter.chooseAccount({
      ...scope,
      phase: 'request',
    } as never)) as string
    const headersResult = (await native.adapter.accountHeaders({
      ...scope,
      accountId,
    })) as { headers: Record<string, string | null>; attempt: unknown }
    const attempt: Attempt<Data> = {
      ...scope,
      accountId,
      attemptId: 'attempt-1',
      transport: 'http',
      data: headersResult.attempt as Data,
    }
    const payload = options.payload ?? {
      model: 'claude-sonnet-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello dump' }],
    }
    const request = new Request(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.laneStart ? { [LANE_START_REQUEST_HEADER]: '1' } : {}),
      },
      body: JSON.stringify(payload),
    })
    const rewritten =
      (await native.adapter.rewriteRequest?.({
        ...attempt,
        request,
        attempt,
      })) ?? request
    // The installer applies account header edits after the rewrite; the bearer
    // below is what the wire carries and what the dump must redact.
    const wire = new Request(rewritten, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const upstreamBody = options.upstreamBody ?? {
      id: 'msg_dump_01',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 3, output_tokens: 1 },
    }
    const physical = new Response(
      options.upstreamSse ?? JSON.stringify(upstreamBody),
      {
        status: options.upstreamStatus ?? 200,
        headers: {
          'content-type': options.upstreamSse
            ? 'text/event-stream'
            : 'application/json',
        },
      },
    )
    const rewrittenResponse = (await native.adapter.rewriteResponse?.({
      ...attempt,
      request: wire,
      response: physical,
      attempt,
    } as never)) as Response
    // Read the (possibly stripped) body to let dump observation finish, as the
    // host does. Non-streaming JSON responses resolve in one read.
    await rewrittenResponse.text().catch(() => '')
    await native.adapter.onAttemptEnd?.(
      attempt as never,
      {
        status: options.upstreamStatus ?? 200,
        outputStarted: false,
      } as never,
    )
    return { wire, rewrittenResponse }
  } finally {
    native.dispose()
  }
}

async function driveRelay(
  options: { enabled?: boolean; laneStart?: boolean } = {},
) {
  const source = makeSource({
    enabled: options.enabled,
    dispatch: {
      kind: 'http-relay',
      url: 'https://relay.example.test/v1/relay',
      token: 'relay-token-do-not-log',
    },
  })
  const native = createNativeAnthropicAdapter({ source })
  try {
    const scope = scopeOf()
    const accountId = (await native.adapter.chooseAccount({
      ...scope,
      phase: 'request',
    } as never)) as string
    const headersResult = (await native.adapter.accountHeaders({
      ...scope,
      accountId,
    })) as { headers: Record<string, string | null>; attempt: unknown }
    const attempt: Attempt<Data> = {
      ...scope,
      accountId,
      attemptId: 'attempt-relay-1',
      transport: 'http',
      data: headersResult.attempt as Data,
    }
    const request = new Request(UPSTREAM, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.laneStart ? { [LANE_START_REQUEST_HEADER]: '1' } : {}),
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hello relay dump' }],
      }),
    })
    const rewritten =
      (await native.adapter.rewriteRequest?.({
        ...attempt,
        request,
        attempt,
      })) ?? request
    const envelope = (await rewritten.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    const physical = new Response(
      JSON.stringify({
        id: 'msg_relay_01',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'request-id': 'req_relayUpstream01',
        },
      },
    )
    const rewrittenResponse = (await native.adapter.rewriteResponse?.({
      ...attempt,
      request: rewritten,
      response: physical,
      attempt,
    } as never)) as Response
    await rewrittenResponse.text().catch(() => '')
    await native.adapter.onAttemptEnd?.(
      attempt as never,
      {
        status: 200,
        outputStarted: false,
      } as never,
    )
    return { envelope, rewritten, rewrittenResponse }
  } finally {
    native.dispose()
  }
}

async function allDumpText() {
  const files = await readdir(dumpDir)
  const texts: string[] = []
  for (const file of files) {
    texts.push(await readFile(join(dumpDir, file), 'utf8'))
  }
  return { files, texts }
}

describe('opencode2 request dumps', () => {
  test('incomplete 200 diagnostics preserve partial message identity and usage', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'msg_incomplete',
          content: [],
          usage: { input_tokens: 3 },
        },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      },
    ]
    await driveDirect({
      enabled: true,
      payload: { model: 'claude-sonnet-5', stream: true, messages: [] },
      upstreamSse: events
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
    })
    const { files } = await allDumpText()
    const responsePath = files.find((name) => name.endsWith('.response.json'))!
    const summary = JSON.parse(
      await readFile(join(dumpDir, responsePath), 'utf8'),
    )
    expect(summary).toMatchObject({
      stream_complete: false,
      message_id: 'msg_incomplete',
      usage: { input_tokens: 3, output_tokens: 2 },
      incomplete_stream: { sse_events: 2, timing_source: 'credential_scope' },
    })
    expect(summary).not.toHaveProperty('reply_text_edges')
  })

  test('malformed stream after message_delta preserves an incomplete summary', async () => {
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg_malformed_edges', content: [] },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '\nHello ' },
      },
      { type: 'message_delta', delta: {} },
    ]
    await driveDirect({
      enabled: true,
      payload: { model: 'claude-sonnet-5', stream: true, messages: [] },
      upstreamSse:
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
        'data: malformed\n\n',
    })
    const { files } = await allDumpText()
    const responsePath = files.find((name) => name.endsWith('.response.json'))!
    const summary = JSON.parse(
      await readFile(join(dumpDir, responsePath), 'utf8'),
    )
    expect(summary.stream_complete).toBe(false)
    expect(summary).not.toHaveProperty('reply_text_edges')
  })

  test('streamed response dumps record reply text edges without text', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_edges', content: [] } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '\n' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '\nHello ' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'tool_edges',
          name: 'Read',
          input: {},
        },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: 'World\n' },
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]
    await driveDirect({
      enabled: true,
      payload: { model: 'claude-sonnet-5', stream: true, messages: [] },
      upstreamSse: events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
    })
    const { files } = await allDumpText()
    const text = await readFile(
      join(dumpDir, files.find((name) => name.endsWith('.response.json'))!),
      'utf8',
    )
    expect(JSON.parse(text).reply_text_edges).toEqual([
      { index: 0, leading: 2, trailing: 1, chars: 8 },
      { index: 2, leading: 0, trailing: 1, chars: 6 },
    ])
    expect(text).not.toContain('Hello')
    expect(text).not.toContain('World')
  })

  test('direct send writes OpenCode 1-shaped dumps without tokens', async () => {
    await driveDirect({ enabled: true })
    const { files, texts } = await allDumpText()
    expect(files.some((name) => name.endsWith('.body.json'))).toBe(true)
    expect(files.some((name) => name.endsWith('.meta.json'))).toBe(true)
    expect(files.some((name) => name.endsWith('.request.json'))).toBe(true)
    expect(files.some((name) => name.endsWith('.response.json'))).toBe(true)
    const bodyPath = files.find((name) => name.endsWith('.body.json'))!
    const metaPath = files.find((name) => name.endsWith('.meta.json'))!
    const requestPath = files.find((name) => name.endsWith('.request.json'))!
    const responsePath = files.find((name) => name.endsWith('.response.json'))!
    expect(bodyPath).toContain('ses_dump_01-direct-main')
    const bodyText = await readFile(join(dumpDir, bodyPath), 'utf8')
    expect(bodyText).toContain('hello dump')
    const meta = JSON.parse(await readFile(join(dumpDir, metaPath), 'utf8'))
    expect(meta.transport).toBe('direct')
    expect(meta.session).toBe('ses_dump_01')
    expect(meta.status).toBe(200)
    expect(meta.files.body).toEndWith('.body.json')
    expect(meta.files.response).toEndWith('.response.json')
    const requestRecord = JSON.parse(
      await readFile(join(dumpDir, requestPath), 'utf8'),
    )
    expect(JSON.stringify(requestRecord)).not.toContain(TOKEN)
    expect(requestRecord.headers.authorization).toBe('[redacted]')
    const responseRecord = JSON.parse(
      await readFile(join(dumpDir, responsePath), 'utf8'),
    )
    expect(responseRecord.status).toBe(200)
    expect(responseRecord.message_id).toBe('msg_dump_01')
    expect(responseRecord.usage).toEqual({ input_tokens: 3, output_tokens: 1 })
    expect(responseRecord).not.toHaveProperty('reply_text_edges')
    for (const text of texts) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('relay-token-do-not-log')
    }
  })

  test('dumps off writes nothing', async () => {
    await driveDirect({ enabled: false })
    expect(await readdir(dumpDir)).toEqual([])
  })

  test('a dump write failure still serves the request', async () => {
    // Point the dump directory at a regular file so every dump write fails,
    // as an unwritable directory would. The request itself must still succeed.
    const blocker = join(dumpDir, 'blocker')
    await writeFile(blocker, 'not a directory')
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = join(blocker, 'child')
    const { rewrittenResponse } = await driveDirect({ enabled: true })
    expect(rewrittenResponse.status).toBe(200)
  })

  test('401 responses still write a dump', async () => {
    await driveDirect({
      enabled: true,
      upstreamStatus: 401,
      upstreamBody: {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid token' },
      },
    })
    const { files } = await allDumpText()
    expect(files.some((name) => name.endsWith('.body.json'))).toBe(true)
    const metaPath = files.find((name) => name.endsWith('.meta.json'))!
    const meta = JSON.parse(await readFile(join(dumpDir, metaPath), 'utf8'))
    expect(meta.status).toBe(401)
    const responsePath = files.find((name) => name.endsWith('.response.json'))!
    expect(
      JSON.parse(await readFile(join(dumpDir, responsePath), 'utf8')),
    ).not.toHaveProperty('reply_text_edges')
  })

  test('relay send writes a relay dump with the start tag', async () => {
    const { envelope } = await driveRelay({ enabled: true, laneStart: true })
    expect(envelope).not.toBeNull()
    const { files, texts } = await allDumpText()
    const relayPath = files.find((name) => name.endsWith('.relay.json'))
    expect(relayPath).toBeDefined()
    expect(relayPath).toContain('-start-http-p1-full_sync')
    const metaPath = files.find((name) => name.endsWith('.meta.json'))!
    expect(metaPath).toContain('-start-http-p1-full_sync')
    const meta = JSON.parse(await readFile(join(dumpDir, metaPath), 'utf8'))
    expect(meta.transport).toBe('http')
    expect(meta.tag).toBe('start')
    const relay = JSON.parse(await readFile(join(dumpDir, relayPath!), 'utf8'))
    expect(JSON.stringify(relay)).not.toContain(TOKEN)
    expect(relay.upstream.headers.authorization).toBe('[redacted]')
    for (const text of texts) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('relay-token-do-not-log')
    }
  })

  test('large gzipped sends dump the signed uncompressed body', async () => {
    const bigText = `payload-${'x'.repeat(5000)}`
    const source = makeSource({ enabled: true })
    const native = createNativeAnthropicAdapter({
      source,
      // Rejection fixtures in other suites may have latched the shared default off.
      requestGzipLatch: new RequestGzipLatch(),
    })
    try {
      const scope = scopeOf()
      const accountId = (await native.adapter.chooseAccount({
        ...scope,
        phase: 'request',
      } as never)) as string
      const headersResult = (await native.adapter.accountHeaders({
        ...scope,
        accountId,
      })) as { headers: Record<string, string | null>; attempt: unknown }
      const attempt: Attempt<Data> = {
        ...scope,
        accountId,
        attemptId: 'attempt-gzip-1',
        transport: 'http',
        data: headersResult.attempt as Data,
      }
      const request = new Request(UPSTREAM, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 32,
          messages: [{ role: 'user', content: bigText }],
        }),
      })
      const rewritten =
        (await native.adapter.rewriteRequest?.({
          ...attempt,
          request,
          attempt,
        })) ?? request
      // The wire carries gzipped bytes when Claude Code would gzip the body.
      expect(rewritten.headers.get('content-encoding')).toBe('gzip')
      const physical = new Response(
        JSON.stringify({
          id: 'msg_gzip_01',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
      const wire = new Request(rewritten, {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const rewrittenResponse = (await native.adapter.rewriteResponse?.({
        ...attempt,
        request: wire,
        response: physical,
        attempt,
      } as never)) as Response
      await rewrittenResponse.text().catch(() => '')
      await native.adapter.onAttemptEnd?.(
        attempt as never,
        {
          status: 200,
          outputStarted: false,
        } as never,
      )
      const { files } = await allDumpText()
      const bodyPath = files.find((name) => name.endsWith('.body.json'))!
      const bodyText = await readFile(join(dumpDir, bodyPath), 'utf8')
      expect(bodyText).toContain(bigText.slice(0, 64))
      expect(() => JSON.parse(bodyText)).not.toThrow()
    } finally {
      native.dispose()
    }
  })

  test('v2 source reads the dump switch from persisted settings', async () => {
    const runtime = {
      read: async () => ({
        mode: 'local',
        settings: { dump: { enabled: true } },
        accounts: [],
        policyStorage: { dump: { enabled: true } },
      }),
    } as unknown as Parameters<typeof createNativeAnthropicSource>[0]['runtime']
    const source = createNativeAnthropicSource({
      runtime,
      paths: {} as never,
      requestOptions: () => ({}),
    })
    await expect(source.isDumpEnabled?.()).resolves.toBe(true)
  })

  test('cachekeep prewarm writes a cachekeep-tagged dump', async () => {
    setDumpEnabled(true)
    try {
      const manager = new CacheKeepManager({
        loadStorage: () =>
          Promise.resolve({
            cacheKeep: { enabled: true, always: true },
            claudeCache: { enabled: true, mode: 'hybrid' },
          } as never),
        fetchImpl: (async () =>
          new Response('malformed', {
            status: 429,
          })) as unknown as typeof fetch,
      })
      await manager.prewarmNow({
        sessionId: 'ses_dump',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText: JSON.stringify({
          system: [
            {
              type: 'text',
              text: 'stable',
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      const files = await readdir(dumpDir)
      expect(files.some((file) => file.includes('-prewarm-cachekeep-'))).toBe(
        true,
      )
      const metadataPath = files.find((file) => file.endsWith('.meta.json'))!
      const metadata = JSON.parse(
        await readFile(join(dumpDir, metadataPath), 'utf8'),
      )
      expect(metadata.tag).toBe('cachekeep')
    } finally {
      resetDumpState()
    }
  })
})
