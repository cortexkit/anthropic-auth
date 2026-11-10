import { afterEach, expect, test } from 'bun:test'
import {
  type AnthropicBillingRequest,
  observeAnthropicBillingResponse,
  withAnthropicBilling,
} from '../billing.ts'
import { CacheKeepManager } from '../cachekeep.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const previous = globals[key]
afterEach(() => {
  if (previous === undefined) delete globals[key]
  else globals[key] = previous
})

const request: AnthropicBillingRequest = {
  sessionId: 'session',
  requestKind: 'primary',
  credentialId: 'credential',
  accountId: 'account',
  model: 'claude-opus-4-8',
}

function capture() {
  const reports: Record<string, unknown>[] = []
  globals[key] = (session: string) => ({
    report: (payload: Record<string, unknown>) => {
      expect(session).toBe('session')
      reports.push(payload)
    },
  })
  return reports
}

function frame(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`
}

function response(events: unknown[]) {
  return new Response(events.map(frame).join(''), {
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' },
  })
}

const start = {
  type: 'message_start',
  message: { id: 'msg_test', usage: { input_tokens: 12, output_tokens: 0 } },
}

test.each(['\r', '\r\n'])(
  'billing accepts SSE framing %j across byte chunks',
  async (ending) => {
    const reports = capture()
    const text = [
      start,
      { type: 'message_delta', usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]
      .map(frame)
      .join('')
      .replaceAll('\n', ending)
    const bytes = new TextEncoder().encode(text)
    let offset = 0
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) controller.close()
          else controller.enqueue(bytes.subarray(offset, ++offset))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    expect(
      await observeAnthropicBillingResponse(request, upstream).text(),
    ).toBe(text)
    await Bun.sleep(10)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({
      outcome: 'completed',
      provider_response_id: 'msg_test',
      usage: { input: 12, output: 7 },
    })
  },
)

test('billing sums iterations across fallback models, split cache writes and thinking', async () => {
  const reports = capture()
  const upstream = response([
    start,
    { type: 'content_block_delta', delta: { text: 'private answer' } },
    {
      type: 'message_delta',
      usage: {
        input_tokens: 9999,
        output_tokens: 9999,
        iterations: [
          {
            type: 'message',
            model: 'claude-opus-4-8',
            input_tokens: 10,
            output_tokens: 8,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 999,
            cache_creation: {
              ephemeral_5m_input_tokens: 3,
              ephemeral_1h_input_tokens: 4,
            },
            output_tokens_details: { thinking_tokens: 5 },
          },
          {
            type: 'fallback_message',
            model: 'claude-sonnet-4-6',
            input_tokens: 20,
            output_tokens: 7,
            cache_read_input_tokens: 6,
            cache_creation: {
              ephemeral_5m_input_tokens: 11,
              ephemeral_1h_input_tokens: 13,
            },
            output_tokens_details: { thinking_tokens: 2 },
          },
        ],
      },
    },
    { type: 'message_stop' },
  ])
  const bytes = await upstream.clone().text()
  expect(
    await (await withAnthropicBilling(request, async () => upstream)).text(),
  ).toBe(bytes)
  await Bun.sleep(10)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    kind: 'billing',
    request_kind: 'primary',
    credential_id: 'credential',
    account_id: 'account',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    outcome: 'completed',
    status: 200,
    provider_request_id: 'req_test',
    provider_response_id: 'msg_test',
    usage: {
      input: 30,
      output: 15,
      cache_read: 8,
      cache_write: 31,
      cache_write_5m: 14,
      cache_write_1h: 17,
      reasoning: 7,
      reasoning_included_in_output: true,
    },
    usage_by_model: [
      {
        model_used: 'claude-opus-4-8',
        usage: { input: 10, output: 8, cache_write: 7, reasoning: 5 },
      },
      {
        model_used: 'claude-sonnet-4-6',
        usage: { input: 20, output: 7, cache_write: 24, reasoning: 2 },
      },
    ],
  })
  expect(JSON.stringify(reports)).not.toContain('private answer')
})

test('an empty iterations list never falls back to top-level billing counts', async () => {
  const reports = capture()
  const sent = await withAnthropicBilling(request, async () =>
    Response.json({
      usage: { input_tokens: 999, output_tokens: 999, iterations: [] },
    }),
  )
  await sent.text()
  await Bun.sleep(10)
  expect(reports).toHaveLength(1)
  expect(reports[0]).not.toHaveProperty('usage')
  expect(reports[0]).not.toHaveProperty('usage_by_model')
})

test.each([undefined, 0, 4])(
  'billing includes reasoning only when Anthropic measures it: %s',
  async (thinking) => {
    const reports = capture()
    const usage = {
      input_tokens: 2,
      output_tokens: 9,
      ...(thinking !== undefined
        ? { output_tokens_details: { thinking_tokens: thinking } }
        : {}),
    }
    const sent = await withAnthropicBilling(request, async () =>
      Response.json({ id: 'msg_json', usage }),
    )
    await sent.json()
    await Bun.sleep(10)
    expect(reports).toHaveLength(1)
    if (thinking === undefined) {
      expect(reports[0]?.usage).toEqual({ input: 2, output: 9 })
    } else {
      expect(reports[0]?.usage).toEqual({
        input: 2,
        output: 9,
        reasoning: thinking,
        reasoning_included_in_output: true,
      })
    }
  },
)

test('billing marks a cut-off stream partial without pricing unread output as zero', async () => {
  const reports = capture()
  const sent = await withAnthropicBilling(request, async () =>
    response([start]),
  )
  await sent.text()
  await Bun.sleep(10)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ outcome: 'cut', usage: { input: 12 } })
  expect(reports[0]?.usage).not.toHaveProperty('output')
})

test('billing reports cancellation once and handles split UTF-8 stream frames', async () => {
  const reports = capture()
  const bytes = new TextEncoder().encode(
    frame(start) + frame({ type: 'content_block_delta', delta: { text: 'é' } }),
  )
  let index = 0
  const upstream = new Response(
    new ReadableStream({
      pull(controller) {
        if (index < bytes.length)
          controller.enqueue(bytes.slice(index, ++index))
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  const sent = await withAnthropicBilling(request, async () => upstream)
  if (!sent.body) throw new Error('Expected a streamed response')
  const reader = sent.body.getReader()
  for (let i = 0; i < bytes.length; i++) await reader.read()
  await reader.cancel()
  await Bun.sleep(10)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    outcome: 'cut',
    provider_response_id: 'msg_test',
    usage: { input: 12 },
  })
})

test('billing records each failed and retried physical attempt with a distinct id', async () => {
  const reports = capture()
  const rejected = await withAnthropicBilling(
    request,
    async () => new Response('no', { status: 401 }),
  )
  await rejected.body?.cancel()
  const accepted = await withAnthropicBilling(
    { ...request, credentialId: 'rotated' },
    async () => Response.json({ usage: { input_tokens: 3, output_tokens: 1 } }),
  )
  await accepted.text()
  await Bun.sleep(10)
  expect(reports).toHaveLength(2)
  expect(reports[0]).toMatchObject({
    outcome: 'failed',
    status: 401,
    credential_id: 'credential',
  })
  expect(reports[1]).toMatchObject({
    outcome: 'completed',
    status: 200,
    credential_id: 'rotated',
  })
  expect(reports[0]?.attempt_id).not.toBe(reports[1]?.attempt_id)
})

test('billing reports transport failures without changing the error', async () => {
  const reports = capture()
  const error = new Error('connection reset')
  await expect(
    withAnthropicBilling(request, async () => {
      throw error
    }),
  ).rejects.toBe(error)
  await Bun.sleep(10)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({ outcome: 'failed' })
  expect(reports[0]).not.toHaveProperty('status')
})

test('no accessor leaves the response untouched and sends nothing', async () => {
  delete globals[key]
  const original = Response.json({
    usage: { input_tokens: 2, output_tokens: 1 },
  })
  const observed = observeAnthropicBillingResponse(request, original)
  expect(observed).toBe(original)
  await observed.text()
  let calls = 0
  globals[key] = () => ({
    report: () => {
      calls++
    },
  })
  await Bun.sleep(10)
  expect(calls).toBe(0)
})

test.each(['throws', 'rejects', 'hangs'])(
  'a billing bridge that %s never holds the response',
  async (mode) => {
    let calls = 0
    let requestFinished = false
    globals[key] = () => ({
      report: () => {
        calls++
        expect(requestFinished).toBe(true)
        if (mode === 'throws') throw new Error('bridge failed')
        if (mode === 'rejects')
          return Promise.reject(new Error('bridge rejected'))
        return new Promise(() => {})
      },
    })
    const sent = await withAnthropicBilling(request, async () =>
      Response.json({ usage: { output_tokens: 1 } }),
    )
    expect(await sent.json()).toEqual({ usage: { output_tokens: 1 } })
    requestFinished = true
    expect(calls).toBe(0)
    await Bun.sleep(10)
    expect(calls).toBe(1)
  },
)

test('keep-warm reports both sends of a 401 replay using each actual credential', async () => {
  const reports = capture()
  let credentialId = 'warm-original'
  let sends = 0
  const manager = new CacheKeepManager({
    loadStorage: async () => null,
    billingRequest: (target) => ({
      ...request,
      credentialId,
      sessionId: target.id,
      requestKind: 'keep_warm',
      cache: { ttlMs: 3_600_000, warming: { on: true } },
    }),
    fetchImpl: (async () =>
      ++sends === 1
        ? new Response('unauthorized', { status: 401 })
        : Response.json({
            id: 'msg_warm',
            usage: {
              input_tokens: 4,
              output_tokens: 1,
              cache_read_input_tokens: 20,
            },
          })) as unknown as typeof fetch,
    retryOnUnauthorized: () => {
      credentialId = 'warm-rotated'
      return new Headers()
    },
  })
  const result = await manager.prewarmNow({
    sessionId: 'session',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    bodyText: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1,
      system: [
        {
          type: 'text',
          text: 'private prompt',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  expect(result.ok).toBe(true)
  await Bun.sleep(10)
  expect(sends).toBe(2)
  expect(reports).toHaveLength(2)
  expect(reports[0]).toMatchObject({
    request_kind: 'keep_warm',
    credential_id: 'warm-original',
    outcome: 'failed',
    status: 401,
  })
  expect(reports[1]).toMatchObject({
    request_kind: 'keep_warm',
    credential_id: 'warm-rotated',
    outcome: 'completed',
    status: 200,
    cache: { ttl_ms: 3_600_000, warming: { on: true } },
    usage: { cache_read: 20, output: 1 },
  })
  expect(JSON.stringify(reports)).not.toContain('private prompt')
})

test('a warm refused before dispatch produces no billing report', async () => {
  const reports = capture()
  let sends = 0
  const manager = new CacheKeepManager({
    loadStorage: async () => null,
    billingRequest: () => ({ ...request, requestKind: 'keep_warm' }),
    prepareHeaders: () => undefined,
    fetchImpl: (async () => {
      sends++
      return new Response()
    }) as unknown as typeof fetch,
  })
  const result = await manager.prewarmNow({
    sessionId: 'session',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    bodyText: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1,
      system: [
        { type: 'text', text: 'prefix', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  expect(result.ok).toBe(false)
  await Bun.sleep(10)
  expect(sends).toBe(0)
  expect(reports).toEqual([])
})

test('oversized non-usage stream lines cannot hide a later usage frame', async () => {
  const reports = capture()
  const sent = await withAnthropicBilling(request, async () =>
    response([
      start,
      { type: 'content_block_delta', delta: { text: 'x'.repeat(1_100_000) } },
      { type: 'message_delta', usage: { output_tokens: 8 } },
    ]),
  )
  await sent.text()
  await Bun.sleep(10)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toMatchObject({
    outcome: 'completed',
    usage: { input: 12, output: 8 },
  })
})
