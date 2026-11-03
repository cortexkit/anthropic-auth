import { expect } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmptyStorage } from '../accounts.ts'
import { CacheKeepManager, type CacheKeepPrewarmResult } from '../cachekeep.ts'
import { resetDumpState, setDumpEnabled } from '../dump.ts'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import {
  PROVIDER_ERROR_MAX_BODY_BYTES,
  PROVIDER_ERROR_REDACTION,
} from '../provider-error.ts'
import { createTestLifetimeSuite } from './test-lifetime.ts'

// Every send in this file goes to an injected fetch; nothing leaves the
// process. Credentials are synthetic and long enough that a leak is found
// by a plain substring search of every place a CacheKeep result can surface.
const suite = createTestLifetimeSuite()

const URL = 'https://api.anthropic.com/v1/messages'
const V1 = 'synthetic-cachekeep-scope-v1-7c41e0d2b9'
const V2 = 'synthetic-cachekeep-scope-v2-a58f3301c6'
const API_KEY = 'synthetic-cachekeep-api-key-e09b7d4413'

const bodyText = JSON.stringify({
  model: 'claude-opus-4-8',
  max_tokens: 128,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'hello',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    },
  ],
})

type Observation = { status: number; data: unknown }

type FetchCall = { authorization: string | null; apiKey: string | null }

/**
 * One isolated CacheKeep run: a private dump directory with dumps on, the
 * manager stopped and the directory removed only after the test body and
 * any detached work have settled.
 */
async function harness(input: {
  fetchImpl: (call: FetchCall, index: number) => Promise<Response>
  sentHeaders: Headers
  retryOnUnauthorized?: (headers: Headers) => Headers | undefined
  scheduled?: boolean
  credentialUnavailable?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), 'cachekeep-provider-error-'))
  const dumpDir = join(root, 'dumps')
  const previousDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  resetDumpState()
  setDumpEnabled(true)
  const calls: FetchCall[] = []
  const observations: Observation[] = []
  const retries: string[] = []
  const logs: LogTestRecord[] = []
  __setLogTestSink((record) => logs.push(record))
  let now = Date.now()
  const storage = {
    ...createEmptyStorage(),
    cacheKeep: { enabled: true, always: true },
    claudeCache: { enabled: true, mode: 'hybrid' as const },
  }
  let completions = 0
  const manager = new CacheKeepManager({
    loadStorage: async () => (input.scheduled ? storage : null),
    now: () => now,
    // The headers prepared here, not the target's stored headers, are what
    // is actually sent, so the scope must take its credentials from them.
    prepareHeaders: () =>
      input.credentialUnavailable ? undefined : new Headers(input.sentHeaders),
    ...(input.retryOnUnauthorized && {
      retryOnUnauthorized: ({ headers }) => {
        retries.push(headers.get('authorization') ?? '')
        return input.retryOnUnauthorized?.(headers)
      },
    }),
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      const call = {
        authorization: headers.get('authorization'),
        apiKey: headers.get('x-api-key'),
      }
      calls.push(call)
      return input.fetchImpl(call, calls.length - 1)
    }) as typeof fetch,
    onResponse: ({ status, data }) => {
      observations.push({ status, data })
    },
    onComplete: () => {
      completions += 1
    },
  })
  suite.deferCleanup(async () => {
    manager.stop()
    __setLogTestSink(null)
    resetDumpState()
    if (previousDumpDir === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDumpDir
    await rm(root, { recursive: true, force: true })
  })
  const run = (): Promise<CacheKeepPrewarmResult> =>
    manager.prewarmNow({
      sessionId: 'synthetic-provider-error-session',
      url: URL,
      // Stored target headers carry no credential: only prepared headers do.
      headers: new Headers({ 'anthropic-version': '2023-06-01' }),
      bodyText,
    })
  const dumpText = async () => {
    const names = await readdir(dumpDir).catch((error: unknown): string[] => {
      if (
        typeof error === 'object' &&
        error !== null &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'
      )
        return []
      throw error
    })
    const reads = await Promise.allSettled(
      names.sort().map(async (name) => {
        const text = await readFile(join(dumpDir, name), 'utf8')
        return `${name}\n${text}`
      }),
    )
    const parts: string[] = []
    const errors: unknown[] = []
    for (const result of reads) {
      if (result.status === 'fulfilled') parts.push(result.value)
      else errors.push(result.reason)
    }
    if (errors.length)
      throw new AggregateError(errors, 'Dump fixture reads failed')
    return { names, text: parts.join('\n') }
  }
  return {
    run,
    scheduledRun: async () => {
      manager.track({
        sessionId: 'synthetic-provider-error-session',
        url: URL,
        headers: new Headers(input.sentHeaders),
        bodyText,
        storage,
        cacheMode: 'hybrid',
      })
      now += 56 * 60_000
      await manager.tick()
    },
    logs,
    responseText: async () => {
      const names = await readdir(dumpDir)
      const name = names.find((entry) => entry.endsWith('.response.json'))
      if (!name) throw new Error('Missing prewarm response dump')
      return readFile(join(dumpDir, name), 'utf8')
    },
    calls,
    observations,
    retries,
    completions: () => completions,
    dumpText,
  }
}

suite.test(
  'CacheKeep 400 dump and scheduled log record only a fixed provider summary',
  async () => {
    const prompt = 'FAKE PROMPT LINE: private user instruction'
    const fixture = await harness({
      scheduled: true,
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: `${prompt} ${V1}`,
            },
          }),
          { status: 400 },
        ),
    })
    await fixture.scheduledRun()
    expect(fixture.calls).toHaveLength(1)
    const provider_error = {
      type: 'invalid_request_error',
      reason: 'http_validation',
      message: 'Provider rejected the prewarm request',
    }
    expect(JSON.parse(await fixture.responseText())).toEqual({
      status: 400,
      stream_complete: true,
      provider_error,
    })
    const log = fixture.logs.find(
      (record) => record.message === 'prewarm failed',
    )
    expect(log?.payload).toMatchObject({ status: 400, provider_error })
    const sinks = [
      JSON.stringify(fixture.logs),
      (await fixture.dumpText()).text,
    ]
    expectNoCredential(sinks, [V1, prompt])
  },
)

suite.test(
  'CacheKeep rejects unknown provider types and never returns provider text',
  async () => {
    const prompt = 'FAKE PROMPT LINE: type and message must not escape'
    const fixture = await harness({
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: prompt, message: `${prompt} ${V1}` },
          }),
          { status: 400 },
        ),
    })
    const result = failure(await fixture.run())
    expect(result).toMatchObject({
      reason: 'Provider rejected the prewarm request',
      provider_error: {
        type: 'unknown',
        reason: 'http_validation',
        message: 'Provider rejected the prewarm request',
      },
    })
    expectNoCredential(
      [JSON.stringify(result), (await fixture.dumpText()).text],
      [prompt, V1],
    )
  },
)

function expectNoCredential(texts: readonly string[], secrets: string[]) {
  for (const text of texts)
    for (const secret of secrets) expect(text).not.toContain(secret)
}

function failure(result: CacheKeepPrewarmResult) {
  if (result.ok) throw new Error('Expected a failed CacheKeep result')
  return result
}

const credentialStyles: Array<{
  name: string
  headers: () => Headers
  secrets: string[]
  echo: string
}> = [
  {
    name: 'authorization bearer',
    headers: () => new Headers({ authorization: `Bearer ${V1}` }),
    secrets: [V1],
    echo: `Bearer ${V1}`,
  },
  {
    name: 'x-api-key',
    headers: () => new Headers({ 'x-api-key': API_KEY }),
    secrets: [API_KEY],
    echo: API_KEY,
  },
]

for (const style of credentialStyles) {
  suite.test(
    `CacheKeep 500 JSON echo of the sent ${style.name} is scrubbed in result, callback and dumps`,
    async () => {
      const secret = style.secrets[0] ?? ''
      // The provider echoes the credential raw and once with its first
      // character as a JSON unicode escape, beside non-ASCII text that must
      // survive scrubbing.
      const escaped = `\\u${secret.charCodeAt(0).toString(16).padStart(4, '0')}${secret.slice(1)}`
      const raw = `{"type":"error","error":{"type":"api_error","message":"échec ✓ — ${style.echo} / ${escaped}"}}`
      const fixture = await harness({
        sentHeaders: style.headers(),
        fetchImpl: async () =>
          new Response(raw, {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
      })
      const result = failure(await fixture.run())
      const dumps = await fixture.dumpText()

      expect(fixture.calls).toHaveLength(1)
      expect(result.status).toBe(500)
      expect(result.transient).toBeUndefined()
      expect(result.reason).toBe('Provider prewarm request failed')
      expect(fixture.observations).toHaveLength(1)
      expect(fixture.observations[0]?.status).toBe(500)
      const data = fixture.observations[0]?.data as {
        error: { type: string; message: string }
      }
      expect(data.error.type).toBe('api_error')
      expect(data.error.message).toContain('échec ✓ —')
      expect(dumps.names.some((name) => name.endsWith('.response.json'))).toBe(
        true,
      )
      expect(dumps.names.some((name) => name.endsWith('.request.json'))).toBe(
        true,
      )
      expectNoCredential(
        [
          JSON.stringify(result),
          JSON.stringify(fixture.observations),
          dumps.text,
        ],
        style.secrets,
      )
      expect(fixture.completions()).toBe(1)
    },
  )
}

suite.test(
  'CacheKeep thrown native TypeError with a network cause reports a fixed transient reason',
  async () => {
    const fixture = await harness({
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      fetchImpl: async () => {
        const cause = Object.assign(
          new Error(`connect ECONNREFUSED Bearer ${V1}`),
          { code: 'ECONNREFUSED', syscall: 'connect' },
        )
        throw new TypeError(`fetch failed for ${V1}`, { cause })
      },
    })
    const result = failure(await fixture.run())
    const dumps = await fixture.dumpText()

    expect(fixture.calls).toHaveLength(1)
    expect(result).toEqual({
      ok: false,
      reason: 'Provider prewarm transport failed',
      stage: 'send',
      class: 'ECONNREFUSED',
      provider_error: {
        type: 'unknown',
        reason: 'transport',
        message: 'Provider prewarm transport failed',
      },
      transient: true,
    })
    // A transport failure has no response, so nothing is observed or dumped.
    expect(fixture.observations).toEqual([])
    expect(dumps.names).toEqual([])
    expectNoCredential([JSON.stringify(result)], [V1])
    expect(fixture.completions()).toBe(1)
  },
)

suite.test(
  'CacheKeep 401 replay scrubs the rotated V2 credential echoed by the final attempt',
  async () => {
    let firstBodyCancelled = false
    const fixture = await harness({
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      retryOnUnauthorized: (headers) => {
        const rotated = new Headers(headers)
        rotated.set('authorization', `Bearer ${V2}`)
        return rotated
      },
      fetchImpl: async (call) => {
        if (call.authorization === `Bearer ${V1}`)
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `{"type":"error","error":{"type":"authentication_error","message":"stale ${V1}"}}`,
                  ),
                )
              },
              cancel() {
                firstBodyCancelled = true
              },
            }),
            { status: 401 },
          )
        return new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: `rejected Bearer ${V2} and ${V2}`,
            },
          }),
          { status: 401 },
        )
      },
    })
    const result = failure(await fixture.run())
    const dumps = await fixture.dumpText()

    expect(fixture.calls.map((call) => call.authorization)).toEqual([
      `Bearer ${V1}`,
      `Bearer ${V2}`,
    ])
    expect(fixture.retries).toEqual([`Bearer ${V1}`])
    expect(firstBodyCancelled).toBe(true)
    expect(result.status).toBe(401)
    expect(result.reason).toBe('Provider prewarm request failed')
    // Two HTTP sends happened (the rejected V1 send and the V2 replay), but
    // onResponse is called once, for the replay whose result is reported.
    expect(fixture.observations).toHaveLength(1)
    expect(fixture.observations[0]?.status).toBe(401)
    expectNoCredential(
      [
        JSON.stringify(result),
        JSON.stringify(fixture.observations),
        dumps.text,
      ],
      [V1, V2],
    )
    expect(fixture.completions()).toBe(1)
  },
)

suite.test(
  'CacheKeep 401 with a blocked replay scrubs the first credential and makes no further send',
  async () => {
    const fixture = await harness({
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      retryOnUnauthorized: () => undefined,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: `bad ${V1}` },
          }),
          { status: 401 },
        ),
    })
    const result = failure(await fixture.run())
    const dumps = await fixture.dumpText()

    expect(fixture.calls).toHaveLength(1)
    expect(fixture.retries).toEqual([`Bearer ${V1}`])
    expect(result.status).toBe(401)
    expect(result.reason).toBe('Provider prewarm request failed')
    expect(fixture.observations).toHaveLength(1)
    expect(fixture.observations[0]?.data).toEqual({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: `bad ${PROVIDER_ERROR_REDACTION}`,
      },
    })
    expectNoCredential(
      [
        JSON.stringify(result),
        JSON.stringify(fixture.observations),
        dumps.text,
      ],
      [V1],
    )
    expect(fixture.completions()).toBe(1)
  },
)

suite.test(
  'CacheKeep success keeps its bytes, usage and status unchanged',
  async () => {
    const payload = {
      id: 'msg_synthetic',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'réchauffé ✓' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4096,
      },
    }
    const fixture = await harness({
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      fetchImpl: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    const result = await fixture.run()
    const dumps = await fixture.dumpText()

    expect(result).toEqual({ ok: true, usage: payload.usage })
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.observations).toEqual([{ status: 200, data: payload }])
    expect(dumps.text).toContain('"cache_read_input_tokens": 4096')
    expect(await fixture.responseText()).toBe(
      `${JSON.stringify(
        {
          status: 200,
          stream_complete: true,
          message_id: payload.id,
          model: payload.model,
          usage: payload.usage,
          stop_reason: payload.stop_reason,
        },
        null,
        2,
      )}\n`,
    )
    expectNoCredential([dumps.text], [V1])
    expect(fixture.completions()).toBe(1)
  },
)

suite.test(
  'CacheKeep error body over the redaction bound is withheld instead of echoed',
  async () => {
    const filler = 'x'.repeat(PROVIDER_ERROR_MAX_BODY_BYTES)
    const fixture = await harness({
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: `${filler} ${V1}` },
          }),
          { status: 500 },
        ),
    })
    const result = failure(await fixture.run())

    expect(fixture.calls).toHaveLength(1)
    expect(result.status).toBe(500)
    expect(result.reason).toBe('Provider prewarm error details were withheld')
    expect(result.provider_error?.reason).toBe('withheld')
    expect(result.reason.length).toBeLessThan(1024)
    expect(fixture.observations).toHaveLength(1)
    expectNoCredential(
      [
        JSON.stringify(result),
        JSON.stringify(fixture.observations),
        (await fixture.dumpText()).text,
      ],
      [V1],
    )
    expect(fixture.completions()).toBe(1)
  },
)

suite.test(
  'CacheKeep non-JSON rejection records a fixed parse failure',
  async () => {
    const prompt = 'FAKE PROMPT LINE: non-JSON echo'
    const fixture = await harness({
      sentHeaders: new Headers({ authorization: `Bearer ${V1}` }),
      fetchImpl: async () => new Response(`${prompt} ${V1}`, { status: 400 }),
    })
    const result = failure(await fixture.run())
    expect(result).toMatchObject({
      provider_error: {
        type: 'unknown',
        reason: 'parse_failure',
        message: 'Provider prewarm error response could not be parsed',
      },
    })
    expect(JSON.parse(await fixture.responseText())).toMatchObject({
      provider_error: result.provider_error,
    })
    expectNoCredential(
      [JSON.stringify(result), (await fixture.dumpText()).text],
      [prompt, V1],
    )
  },
)

suite.test(
  'CacheKeep missing credentials returns a fixed retryable summary without sending',
  async () => {
    const fixture = await harness({
      credentialUnavailable: true,
      sentHeaders: new Headers(),
      fetchImpl: async () => {
        throw new Error('Credential guard did not stop dispatch')
      },
    })
    expect(await fixture.run()).toEqual({
      ok: false,
      stage: 'authorization',
      class: 'unknown',
      transient: true,
      reason: 'OAuth cache prewarm credential is unavailable',
      provider_error: {
        type: 'unknown',
        reason: 'credential_unavailable',
        message: 'OAuth cache prewarm credential is unavailable',
      },
    })
    expect(fixture.calls).toEqual([])
    expect((await fixture.dumpText()).names).toEqual([])
  },
)
