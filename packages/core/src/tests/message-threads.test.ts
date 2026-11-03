import { describe, expect, test } from 'bun:test'
import { buildCacheKeepPrewarmBody, CacheKeepManager } from '../cachekeep.ts'
import {
  MESSAGE_THREADS_BETA,
  type MessageThreadInput,
  MessageThreadTracker,
  observeMessageThreadResponse,
  prepareMessageThreadRequest,
} from '../message-threads.ts'

function input(): MessageThreadInput {
  return {
    session: 'session',
    account: 'account',
    credential: 'credential',
    betas: ['base'],
    body: {
      model: 'claude-opus-5-5',
      system: [{ type: 'text', text: 'instructions' }],
      tools: [{ name: 'read' }],
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'one' }],
    },
  }
}
const assistant = { role: 'assistant', content: 'answer' }
const next = { role: 'user', content: 'two' }
function anchor(tracker: MessageThreadTracker, request = input()) {
  const prepared = tracker.prepare(request)
  prepared.complete({
    messageId: 'msg_1',
    stopped: true,
    stopReason: 'end_turn',
  })
  return request
}
function advance(request: MessageThreadInput): MessageThreadInput {
  return {
    ...request,
    body: {
      ...request.body,
      messages: [...(request.body.messages as unknown[]), assistant, next],
    },
  }
}

describe('message threads', () => {
  test('create then continue sends only the new messages', () => {
    const tracker = new MessageThreadTracker()
    expect(
      tracker.prepare({ ...input(), session: 'other' }).body.thread,
    ).toEqual({ type: 'create' })
    const request = anchor(tracker)
    const prepared = tracker.prepare(advance(request))
    expect(prepared.body.thread).toEqual({
      type: 'continue',
      previous_message_id: 'msg_1',
    })
    expect(prepared.body.messages).toEqual([next])
    expect(prepared.body.system).toEqual(request.body.system)
    expect(prepared.body.tools).toEqual(request.body.tools)
  })
  test.each([
    'model',
    'output_config',
    'tools',
    'thinking',
    'tool_choice',
    'context_management',
    'fallbacks',
    'system',
  ])('changed %s creates', (field) => {
    const tracker = new MessageThreadTracker()
    const request = advance(anchor(tracker))
    request.body[field] = 'changed'
    expect(tracker.prepare(request).decision.type).toBe('create')
  })
  test.each(['rewrite', 'compaction', 'account', 'credential', 'betas'])(
    '%s creates',
    (change) => {
      const tracker = new MessageThreadTracker()
      const request = advance(anchor(tracker))
      if (change === 'rewrite')
        (request.body.messages as unknown[])[0] = {
          role: 'user',
          content: 'edited',
        }
      if (change === 'compaction') request.body.messages = [next]
      if (change === 'account') request.account = 'other'
      if (change === 'credential') request.credential = 'other'
      if (change === 'betas') request.betas = ['different']
      expect(tracker.prepare(request).decision.type).toBe('create')
    },
  )
  test('expires five minutes after completion', () => {
    let now = 0
    const tracker = new MessageThreadTracker(10, () => now)
    const request = anchor(tracker)
    now = 300_000
    expect(tracker.prepare(advance(request)).decision.type).toBe('create')
  })
  test.each(['refusal', 'fallback', 'rewritten', 'cut', 'missing reason'])(
    '%s cannot anchor',
    (fact) => {
      const tracker = new MessageThreadTracker()
      const request = input()
      tracker.prepare(request).complete({
        messageId: 'msg_1',
        stopped: fact !== 'cut',
        stopReason: fact === 'missing reason' ? undefined : 'end_turn',
        refusal: fact === 'refusal',
        fallback: fact === 'fallback',
        rewritten: fact === 'rewritten',
      })
      expect(tracker.prepare(advance(request)).decision.type).toBe('create')
    },
  )
  test('cache placement and billing lineage do not change identity', () => {
    const tracker = new MessageThreadTracker()
    const request = input()
    request.body.system = [
      { type: 'text', text: 'x-anthropic-billing-header: old' },
      {
        type: 'text',
        text: 'instructions',
        cache_control: { type: 'ephemeral' },
      },
    ]
    request.body.messages = [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
    ]
    anchor(tracker, request)
    const continued = advance(request)
    continued.body.system = [
      { type: 'text', text: 'x-anthropic-billing-header: new' },
      { type: 'text', text: 'instructions' },
    ]
    continued.body.messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'one', cache_control: { type: 'ephemeral' } },
        ],
      },
      assistant,
      next,
    ]
    expect(tracker.prepare(continued).decision.type).toBe('continue')
  })
  test('forget, rejection and LRU eviction prevent stale completion from restoring anchors', () => {
    const tracker = new MessageThreadTracker(1)
    const request = input()
    const pending = tracker.prepare(request)
    tracker.forget(request.session)
    pending.complete({
      messageId: 'stale',
      stopped: true,
      stopReason: 'end_turn',
    })
    expect(tracker.prepare(advance(request)).decision.type).toBe('create')
    anchor(tracker)
    tracker.prepare({ ...input(), session: 'other' })
    expect(tracker.prepare(advance(request)).decision.type).toBe('create')
    anchor(tracker)
    tracker.prepare(advance(request)).fail()
    expect(tracker.prepare(advance(request)).decision.type).toBe('create')
  })
})

function sse(events: unknown[]) {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

test.each(['complete', 'cut', 'refusal', 'fallback', 'error'])(
  'response observation: %s',
  async (kind) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    const events: unknown[] = [
      { type: 'message_start', message: { id: 'msg_stream' } },
      {
        type: 'message_delta',
        delta: { stop_reason: kind === 'refusal' ? 'refusal' : 'end_turn' },
        usage: {
          iterations: kind === 'fallback' ? [{ type: 'fallback_message' }] : [],
        },
      },
    ]
    if (kind === 'error') events.push({ type: 'error' })
    if (kind !== 'cut') events.push({ type: 'message_stop' })
    const original = sse(events)
    const expected = await original.clone().text()
    expect(
      await observeMessageThreadResponse(
        original,
        tracker.prepare(request),
      ).text(),
    ).toBe(expected)
    expect(tracker.prepare(advance(request)).decision.type).toBe(
      kind === 'complete' ? 'continue' : 'create',
    )
  },
)

test('response cancellation clears the anchor', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const response = observeMessageThreadResponse(
    sse([{ type: 'message_start', message: { id: 'msg_cancel' } }]),
    tracker.prepare(request),
  )
  await response.body?.cancel()
  expect(tracker.prepare(advance(request)).decision.type).toBe('create')
})

test.each([
  [404, 'thread_not_found'],
  [400, 'thread_fingerprint_mismatch'],
  [400, 'thread_already_continued'],
  [400, 'thread_continue_in_flight'],
  [400, 'thread_unsupported_request'],
  [400, 'unrelated'],
  [404, 'unknown_model'],
] as const)(
  'HTTP %s %s has a single bounded recovery',
  async (status, code) => {
    const tracker = new MessageThreadTracker()
    const headers = new Headers({
      'anthropic-beta': 'base',
      'x-client-request-id': 'same-request',
    })
    const original = input()
    const first = await prepareMessageThreadRequest(tracker, {
      ...original,
      bodyText: JSON.stringify(original.body),
      headers,
    })
    await first
      .observe(
        sse([
          { type: 'message_start', message: { id: 'msg_1' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          { type: 'message_stop' },
        ]),
      )
      .text()
    const full = advance(original)
    const request = await prepareMessageThreadRequest(tracker, {
      ...full,
      bodyText: JSON.stringify(full.body),
      headers,
    })
    expect(JSON.parse(request.bodyText).messages).toEqual([next])
    expect(headers.get('anthropic-beta')?.split(',').at(-1)).toBe(
      MESSAGE_THREADS_BETA,
    )
    const rejection = () =>
      Response.json(
        {
          type: 'error',
          error: {
            type: status === 404 ? 'not_found_error' : 'invalid_request_error',
            message: 'thread rejected',
            details: { error_code: code },
          },
        },
        { status },
      )
    const recovered = code.startsWith('thread_')
    let sends = 0
    const send = async (body: string) => {
      sends++
      expect(JSON.parse(body).thread).toEqual({ type: 'create' })
      expect(JSON.parse(body).messages).toEqual(full.body.messages)
      expect(headers.get('x-client-request-id')).toBe('same-request')
      return rejection()
    }
    const response = await request.recover(rejection(), send)
    await request.recover(response, send)
    expect(sends).toBe(recovered ? 1 : 0)
    await request.observe(response).text()
    expect(tracker.prepare(full).decision.type).toBe('create')
  },
)

test('continue preserves fixed tool and system bytes and maps automatic caching onto the delta', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const cc = { type: 'ephemeral', ttl: '1h' }
  request.body.cache_control = cc
  request.body.system = [
    { type: 'text', text: 'instructions', cache_control: cc },
  ]
  request.body.tools = [{ name: 'read', cache_control: cc }]
  request.body.messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: 'one', cache_control: cc }],
    },
  ]
  anchor(tracker, request)
  const continued = tracker.prepare(advance(request)).body
  expect(continued.thread).toMatchObject({ type: 'continue' })
  expect(continued.cache_control).toBeUndefined()
  expect(JSON.stringify(continued.tools)).toBe(
    JSON.stringify(request.body.tools),
  )
  expect(JSON.stringify(continued.system)).toBe(
    JSON.stringify(request.body.system),
  )
  expect(
    JSON.stringify(continued).match(/"cache_control"/g)?.length,
  ).toBeLessThanOrEqual(4)
  expect(continued.messages).toEqual([
    {
      role: 'user',
      content: [{ type: 'text', text: 'two', cache_control: cc }],
    },
  ])
  expect(request.body.messages).toEqual([
    {
      role: 'user',
      content: [{ type: 'text', text: 'one', cache_control: cc }],
    },
  ])
})

test('digest budget evicts least recently used sessions independently of the session cap', () => {
  const tracker = new MessageThreadTracker(10, Date.now, 2)
  const a = { ...input(), session: 'a' }
  anchor(tracker, a)
  anchor(tracker, { ...input(), session: 'b' })
  anchor(tracker, { ...input(), session: 'c' })
  expect(tracker.prepare(advance(a)).decision.type).toBe('create')
})

test('effort markers and turn-end notes remain byte-stable across the prefix and delta', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const prefix = [
    { role: 'user', content: 'Initial' },
    { role: 'system', content: [{ type: 'text', text: '', effort: 'high' }] },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Tool result\n<turn-end-note>Done</turn-end-note>',
        },
      ],
    },
  ]
  request.body.messages = prefix
  anchor(tracker, request)
  const delta = [
    { role: 'system', content: [{ type: 'text', text: '', effort: 'max' }] },
    { role: 'user', content: 'Next' },
  ]
  const continued = tracker.prepare({
    ...request,
    body: { ...request.body, messages: [...prefix, assistant, ...delta] },
  })
  expect(continued.decision.type).toBe('continue')
  expect(JSON.stringify(continued.body.messages)).toBe(JSON.stringify(delta))
  expect(JSON.stringify(request.body.messages)).toBe(JSON.stringify(prefix))
})

test('an aborted accepted stream cannot publish an anchor', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const abort = new AbortController()
  const prepared = await prepareMessageThreadRequest(tracker, {
    ...request,
    bodyText: JSON.stringify(request.body),
    headers: new Headers(),
    signal: abort.signal,
  })
  abort.abort()
  await prepared
    .observe(
      sse([
        { type: 'message_start', message: { id: 'msg_aborted' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    )
    .text()
  expect(tracker.prepare(advance(request)).decision.type).toBe('create')
})

test('prewarm strips create threads, refuses deltas and never replaces its full target with wire bodies', async () => {
  const body = {
    model: 'claude-sonnet-5',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Full prompt',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  }
  const created = await buildCacheKeepPrewarmBody(
    JSON.stringify({ ...body, thread: { type: 'create' } }),
  )
  expect(created.ok).toBe(true)
  if (created.ok) expect(JSON.parse(created.bodyText).thread).toBeUndefined()
  const delta = {
    ...body,
    thread: { type: 'continue', previous_message_id: 'msg_previous' },
  }
  expect((await buildCacheKeepPrewarmBody(JSON.stringify(delta))).ok).toBe(
    false,
  )
  const storage = {
    version: 1,
    accounts: [],
    cacheKeep: { enabled: true, always: true },
  } satisfies Parameters<CacheKeepManager['track']>[0]['storage']
  const keep = new CacheKeepManager({ loadStorage: async () => storage })
  const request = {
    sessionId: 'cache-thread',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers(),
    bodyText: JSON.stringify(body),
    storage,
    cacheMode: 'hybrid',
  }
  expect(keep.track(request).tracked).toBe(true)
  for (const thread of [
    { type: 'create' },
    { type: 'continue', previous_message_id: 'msg_previous' },
  ]) {
    expect(
      keep.track({ ...request, bodyText: JSON.stringify({ ...body, thread }) })
        .tracked,
    ).toBe(false)
    expect(keep.trackedRequest('cache-thread')?.bodyText).toBe(request.bodyText)
  }
})

test('uncorrelated main requests create without sharing an anchor', async () => {
  const tracker = new MessageThreadTracker()
  const headers = new Headers()
  const request = {
    account: 'account',
    credential: 'credential',
    bodyText: JSON.stringify(input().body),
    headers,
  }
  const first = await prepareMessageThreadRequest(tracker, request)
  expect(JSON.parse(first.bodyText).thread).toEqual({ type: 'create' })
  await first
    .observe(
      sse([
        { type: 'message_start', message: { id: 'msg_uncorrelated' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    )
    .text()
  const nextRequest = await prepareMessageThreadRequest(tracker, {
    ...request,
    bodyText: JSON.stringify(advance(input()).body),
  })
  expect(JSON.parse(nextRequest.bodyText).thread).toEqual({ type: 'create' })
  expect(JSON.parse(nextRequest.bodyText).messages).toHaveLength(3)
})

test.each([0, 1, 2, 3, 4])(
  'continue budgets fixed tool and system markers first (%s fixed markers)',
  (fixedCount) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    const cc = { type: 'ephemeral', ttl: '1h' }
    const systemCount = Math.min(2, fixedCount)
    request.body.system = Array.from({ length: systemCount }, (_, i) => ({
      type: 'text',
      text: `system ${i}`,
      cache_control: cc,
    }))
    request.body.tools = Array.from(
      { length: fixedCount - systemCount },
      (_, i) => ({
        name: `tool_${i}`,
        input_schema: { type: 'object' },
        cache_control: cc,
      }),
    )
    request.body.cache_control = cc
    anchor(tracker, request)
    const delta = ['early delta', 'last delta'].map((text) => ({
      role: 'user',
      content: [{ type: 'text', text, cache_control: cc }],
    }))
    const continued = tracker.prepare({
      ...request,
      body: {
        ...request.body,
        messages: [
          ...(request.body.messages as unknown[]),
          assistant,
          ...delta,
        ],
      },
    }).body
    expect(continued.thread).toMatchObject({ type: 'continue' })
    expect(JSON.stringify(continued.system)).toBe(
      JSON.stringify(request.body.system),
    )
    expect(JSON.stringify(continued.tools)).toBe(
      JSON.stringify(request.body.tools),
    )
    expect(continued.cache_control).toBeUndefined()
    const count = (value: unknown) =>
      (JSON.stringify(value).match(/"cache_control"/g) ?? []).length
    expect(count(continued)).toBeLessThanOrEqual(4)
    expect(count({ tools: continued.tools, system: continued.system })).toBe(
      fixedCount,
    )
    expect(count(continued.messages)).toBeLessThanOrEqual(4 - fixedCount)
    const messages = continued.messages as typeof delta
    expect(messages.at(-1)?.content.at(-1)?.cache_control).toEqual(
      fixedCount === 4 ? undefined : cc,
    )
    expect(
      delta.every((message) => message.content[0]?.cache_control === cc),
    ).toBe(true)
  },
)

test.each([undefined, {}, { custom: 'retained' }])(
  'audit diagnostics: continue always supplies response lineage (%j)',
  (diagnostics) => {
    const tracker = new MessageThreadTracker()
    const request = advance(anchor(tracker))
    if (diagnostics !== undefined) request.body.diagnostics = diagnostics
    const continued = tracker.prepare(request).body
    expect(continued.thread).toMatchObject({
      type: 'continue',
      previous_message_id: 'msg_1',
    })
    expect(continued.diagnostics).toEqual({
      ...(diagnostics ?? {}),
      previous_message_id: 'msg_1',
    })
  },
)

test('audit protocol cache: historical tool arguments named cache_control are semantic data', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const call = {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'old_call',
        name: 'read',
        input: { cache_control: 'original', path: 'file' },
      },
    ],
  }
  const result = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'old_call', content: 'result' },
    ],
  }
  const first = (request.body.messages as unknown[])[0]
  request.body.messages = [first, call, result]
  anchor(tracker, request)
  const edited = {
    ...call,
    content: [
      { ...call.content[0], input: { cache_control: 'edited', path: 'file' } },
    ],
  }
  expect(
    tracker.prepare({
      ...request,
      body: {
        ...request.body,
        messages: [first, edited, result, assistant, next],
      },
    }).decision.type,
  ).toBe('create')
})

test('audit protocol cache: schema properties named cache_control affect the fingerprint', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const schema = (description: string) => [
    {
      name: 'read',
      input_schema: {
        type: 'object',
        properties: { cache_control: { type: 'string', description } },
      },
    },
  ]
  request.body.tools = schema('original')
  anchor(tracker, request)
  const continued = advance(request)
  continued.body.tools = schema('edited')
  expect(tracker.prepare(continued).decision.type).toBe('create')
})

test('audit protocol cache: schema data neither consumes nor loses a breakpoint', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const cc = { type: 'ephemeral', ttl: '1h' }
  request.body.system = [0, 1].map((i) => ({
    type: 'text',
    text: `system ${i}`,
    cache_control: cc,
  }))
  request.body.tools = [
    {
      name: 'read',
      input_schema: {
        type: 'object',
        properties: { cache_control: { type: 'string' } },
      },
      cache_control: cc,
    },
  ]
  anchor(tracker, request)
  const delta = {
    role: 'user',
    content: [{ type: 'text', text: 'next', cache_control: cc }],
  }
  const body = tracker.prepare({
    ...request,
    body: {
      ...request.body,
      messages: [...(request.body.messages as unknown[]), assistant, delta],
    },
  }).body
  expect(JSON.stringify(body.tools)).toBe(JSON.stringify(request.body.tools))
  expect(body.messages).toEqual([delta])
})

test('audit protocol cache: only nested tool-result block annotations are ignored', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const message = (ttl: string) => ({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'old',
        content: [
          {
            type: 'text',
            text: '{"cache_control":"ordinary JSON text"}',
            cache_control: { type: 'ephemeral', ttl },
          },
        ],
      },
    ],
  })
  request.body.messages = [message('5m')]
  anchor(tracker, request)
  const body = tracker.prepare({
    ...request,
    body: { ...request.body, messages: [message('1h'), assistant, next] },
  }).body
  expect(body.thread).toMatchObject({ type: 'continue' })
  expect((request.body.messages as unknown[])[0]).toEqual(message('5m'))
})
