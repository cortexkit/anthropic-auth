import { describe, expect, spyOn, test } from 'bun:test'
import { buildCacheKeepPrewarmBody, CacheKeepManager } from '../cachekeep.ts'
import { signRequestBody } from '../cch.ts'
import {
  __setLogTestSink,
  getLogLevel,
  type LogTestRecord,
  logger,
  setLogLevel,
} from '../logger.ts'
import {
  localMessageThreadCredential,
  MESSAGE_THREADS_BETA,
  type MessageThreadCreateReason,
  type MessageThreadDisposition,
  type MessageThreadInput,
  MessageThreadTracker,
  observeMessageThreadResponse,
  prepareMessageThreadRequest,
} from '../message-threads.ts'
import {
  SERVER_FALLBACK_USAGE_MARKER_TEXT,
  SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX,
} from '../server-fallback-usage.ts'

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
    reply: assistant,
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

function tailMarkerInput(): MessageThreadInput {
  const cc = { type: 'ephemeral', ttl: '1h' }
  return {
    ...input(),
    cacheSlot: (body) => (body.system as Record<string, unknown>[])[0],
    body: {
      ...input().body,
      system: [{ type: 'text', text: 'instructions', cache_control: cc }],
      messages: Array.from({ length: 351 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: Array.from(
          { length: index === 0 ? 3 : index % 2 && index < 171 ? 2 : 1 },
          (_, block) => ({
            type: 'text',
            text: `message ${index}${block ? `/${block}` : ''}`,
            ...((index === 0 && block > 0) || index === 350
              ? { cache_control: cc }
              : {}),
          }),
        ),
      })),
    },
  }
}

describe('full request tail marker', () => {
  function anchorWithContinuation(
    tracker: MessageThreadTracker,
    request: MessageThreadInput,
  ) {
    anchor(tracker, request)
    const continued = tracker.prepare(advance(request))
    expect(continued.decision.type).toBe('continue')
    continued.complete({
      messageId: 'msg_continue',
      stopped: true,
      stopReason: 'end_turn',
      reply: assistant,
    })
    return request
  }
  function replay(first: MessageThreadInput): MessageThreadInput {
    const request = advance(first)
    request.body = structuredClone(request.body)
    const messages = request.body.messages as { content: unknown }[]
    delete (
      (messages[350]!.content as Record<string, unknown>[])[0] as Record<
        string,
        unknown
      >
    ).cache_control
    messages[352] = {
      ...next,
      content: [
        {
          type: 'text',
          text: 'two',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    }
    return request
  }

  test('restores the accepted full tail beyond lookback after a thread', () => {
    let now = 0
    const tracker = new MessageThreadTracker(10, () => now)
    const first = anchor(tracker, tailMarkerInput())
    const blocks = (body: Record<string, unknown>) =>
      (body.messages as { content: unknown[] }[]).reduce(
        (sum, message) => sum + message.content.length,
        0,
      )
    expect(blocks(first.body)).toBe(438)
    const continued = advance(first)
    const continuation = tracker.prepare(continued)
    expect(continuation.decision.type).toBe('continue')
    continuation.complete({
      messageId: 'msg_continue',
      stopped: true,
      stopReason: 'end_turn',
      reply: assistant,
    })
    // A long replay needs its old full tail even when it is beyond Anthropic's
    // 20-block lookback. These tails are 284 content blocks apart, at messages
    // 350 and 528, with 438 and 722 blocks in the respective full requests.
    const replay = advance(first)
    replay.body.messages = [
      ...structuredClone(
        first.body.messages as { content: Record<string, unknown>[] }[],
      ).map((message, index) => {
        if (index === 350) delete message.content[0]?.cache_control
        return message
      }),
      ...Array.from({ length: 178 }, (_, index) => ({
        role: index % 2 ? 'user' : 'assistant',
        content: Array.from({ length: index < 106 ? 2 : 1 }, (_, block) => ({
          type: 'text',
          text: `new ${index}/${block}`,
          ...(index === 177
            ? { cache_control: { type: 'ephemeral', ttl: '1h' } }
            : {}),
        })),
      })),
    ]
    now = 301_000
    expect(blocks(replay.body)).toBe(722)
    const prepared = tracker.prepare(replay)
    expect(prepared.decision.type).toBe('create')
    const body = prepared.body as typeof first.body & {
      messages: { content: Record<string, unknown>[] }[]
    }
    expect(body.messages[350]?.content[0]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(body.messages[528]?.content[0]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(
      (body.system as Record<string, unknown>[])[0]?.cache_control,
    ).toBeUndefined()
    expect(
      JSON.stringify(body).match(/"cache_control"/g)?.length,
    ).toBeLessThanOrEqual(4)
    prepared.complete({
      messageId: 'msg_replay',
      stopped: true,
      stopReason: 'end_turn',
      reply: assistant,
    })
    const nextThread = tracker.prepare(advance(replay))
    expect(nextThread.decision.type).toBe('continue')
    expect(JSON.stringify(nextThread.body.system)).toBe(
      JSON.stringify(prepared.body.system),
    )
    expect(JSON.stringify(nextThread.body.tools)).toBe(
      JSON.stringify(prepared.body.tools),
    )
  })

  test.each([
    'no_prior_thread',
    'prefix_changed',
    'expired',
    'account_changed',
    'credential_changed',
    'slot_taken',
    'ttl_order',
    'later_ttl_order',
    'clock_rollback',
  ])('%s leaves the full request byte-identical', (reason) => {
    let now = 0
    const tracker = new MessageThreadTracker(10, () => now)
    const first = tailMarkerInput()
    if (reason !== 'no_prior_thread') anchorWithContinuation(tracker, first)
    const request = replay(first)
    request.stateless = true
    now = 301_000
    if (reason === 'prefix_changed')
      (request.body.messages as { content: unknown }[])[20]!.content =
        'edited earlier message'
    if (reason === 'expired') now = 3_600_000
    if (reason === 'account_changed') request.account = 'other account'
    if (reason === 'credential_changed')
      request.credential = 'replacement login'
    if (reason === 'slot_taken') request.cacheSlot = () => undefined
    if (reason === 'clock_rollback') now = -1
    if (reason === 'ttl_order')
      (request.body.messages as { content: Record<string, unknown>[] }[])[0]!
        .content[1]!.cache_control = { type: 'ephemeral' }
    if (reason === 'later_ttl_order') {
      now = 0
      const short = tailMarkerInput()
      const messages = short.body.messages as {
        content: Record<string, unknown>[]
      }[]
      messages[350]!.content[0]!.cache_control = { type: 'ephemeral' }
      anchorWithContinuation(tracker, short)
      now = 1
    }
    const before = JSON.stringify(request.body)
    const log = spyOn(logger, 'debug')
    try {
      expect(JSON.stringify(tracker.prepare(request).body)).toBe(before)
      const tailLogs = log.mock.calls.filter(
        (call) => call[1] === 'message_thread_tail_marker',
      )
      if (reason === 'no_prior_thread') expect(tailLogs).toHaveLength(0)
      else {
        expect(tailLogs).toHaveLength(1)
        expect(tailLogs[0]?.[2]).toMatchObject({
          reason:
            reason === 'credential_changed'
              ? 'account_changed'
              : reason === 'later_ttl_order'
                ? 'ttl_order'
                : reason === 'clock_rollback'
                  ? 'expired'
                  : reason,
        })
      }
    } finally {
      log.mockRestore()
    }
    expect(JSON.stringify(request.body)).toBe(before)
  })

  test('preserves the accepted marker default 5-minute lifetime and expires at its boundary', () => {
    let now = 0
    for (const age of [299_999, 300_000]) {
      now = 0
      const tracker = new MessageThreadTracker(10, () => now)
      const first = tailMarkerInput()
      const messages = first.body.messages as {
        content: Record<string, unknown>[]
      }[]
      messages[350]!.content[0]!.cache_control = { type: 'ephemeral' }
      anchorWithContinuation(tracker, first)
      const request = replay(first)
      request.stateless = true
      ;(request.body.messages as { content: Record<string, unknown>[] }[])[352]!
        .content[0]!.cache_control = { type: 'ephemeral' }
      now = age
      const prepared = tracker.prepare(request)
      expect(prepared.tailMarkerAdded).toBe(age < 300_000)
      expect(
        (
          prepared.body.messages as { content: Record<string, unknown>[] }[]
        )[350]!.content[0]!.cache_control,
      ).toEqual(age < 300_000 ? { type: 'ephemeral' } : undefined)
    }
  })

  test('materializes a historical user string only when its canonical full tail matches', () => {
    const tracker = new MessageThreadTracker(10, () => 0)
    const first = anchorWithContinuation(tracker, tailMarkerInput())
    const request = replay(first)
    const messages = request.body.messages as { content: unknown }[]
    messages[350]!.content = 'message 350'
    request.stateless = true
    const prepared = tracker.prepare(request)
    expect(prepared.tailMarkerAdded).toBe(true)
    expect(
      (prepared.body.messages as { content: unknown }[])[350]!.content,
    ).toEqual([
      {
        type: 'text',
        text: 'message 350',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ])
    expect(messages[350]!.content).toBe('message 350')
  })

  test('a changed continuation prefix beyond the old full tail still anchors the actual new create', () => {
    const tracker = new MessageThreadTracker(10, () => 0)
    const first = anchor(tracker, tailMarkerInput())
    const second = replay(first)
    const continued = tracker.prepare(second)
    expect(continued.decision.type).toBe('continue')
    continued.complete({
      messageId: 'msg_second',
      stopped: true,
      stopReason: 'end_turn',
      reply: assistant,
    })
    const third = advance(second)
    third.body = structuredClone(third.body)
    const messages = third.body.messages as { content: unknown }[]
    messages[352]!.content = 'edited after the old full tail'
    messages[354]!.content = [
      {
        type: 'text',
        text: 'newest',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]
    const full = tracker.prepare(third)
    expect(full.decision.type).toBe('create')
    expect(full.tailMarkerAdded).toBe(true)
    full.complete({
      messageId: 'msg_third',
      stopped: true,
      stopReason: 'end_turn',
      reply: assistant,
    })
    const next = tracker.prepare(advance(third))
    expect(next.decision.type).toBe('continue')
    expect(JSON.stringify(next.body.system)).toBe(
      JSON.stringify(full.body.system),
    )
  })

  test('a nested 5-minute marker precedes its enclosing full-tail boundary', () => {
    const tracker = new MessageThreadTracker(10, () => 0)
    const first = tailMarkerInput()
    ;(first.body.messages as { content: unknown }[])[350]!.content = [
      {
        type: 'tool_result',
        tool_use_id: 'tool',
        content: [{ type: 'text', text: 'result' }],
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]
    anchorWithContinuation(tracker, first)
    const request = replay(first)
    request.stateless = true
    const result = (
      (request.body.messages as { content: Record<string, unknown>[] }[])[350]!
        .content[0]!.content as Record<string, unknown>[]
    )[0]!
    result.cache_control = { type: 'ephemeral' }
    ;(request.body.messages as { content: Record<string, unknown>[] }[])[352]!
      .content[0]!.cache_control = { type: 'ephemeral' }
    delete (
      request.body.messages as { content: Record<string, unknown>[] }[]
    )[0]!.content[1]!.cache_control
    const before = JSON.stringify(request.body)
    const prepared = tracker.prepare(request)
    expect(prepared.tailMarkerAdded).toBe(false)
    expect(JSON.stringify(prepared.body)).toBe(before)
    expect(JSON.stringify(request.body)).toBe(before)
  })

  test.each(['system', 'tools', 'ttl'] as const)(
    'fixed layout reuse does not hide a %s change',
    (change) => {
      const tracker = new MessageThreadTracker(10, () => 0)
      const first = anchor(tracker, tailMarkerInput())
      const request = replay(first)
      if (change === 'system')
        (request.body.system as Record<string, unknown>[])[0]!.text =
          'changed instructions'
      if (change === 'tools') request.body.tools = [{ name: 'different' }]
      if (change === 'ttl') {
        ;(
          (request.body.system as Record<string, unknown>[])[0]!
            .cache_control as Record<string, unknown>
        ).ttl = '5m'
        for (const block of (
          request.body.messages as { content: Record<string, unknown>[] }[]
        )[0]!.content) {
          if (block.cache_control)
            (block.cache_control as Record<string, unknown>).ttl = '5m'
        }
        ;(
          (
            request.body.messages as { content: Record<string, unknown>[] }[]
          )[352]!.content[0]!.cache_control as Record<string, unknown>
        ).ttl = '5m'
      }
      expect(tracker.prepare(request).decision.type).toBe('create')
    },
  )

  test('recovery create adds the tail before signing and beta-changed stateless fallback stays byte-identical', async () => {
    const tracker = new MessageThreadTracker(10, () => 0)
    const first = anchorWithContinuation(tracker, {
      ...tailMarkerInput(),
      account: 'tail-recovery-account',
      betas: [MESSAGE_THREADS_BETA],
    })
    const request = advance(replay(first))
    delete (
      request.body.messages as { content: Record<string, unknown>[] }[]
    )[352]!.content[0]!.cache_control
    ;(request.body.messages as { content: unknown }[])[354]!.content = [
      {
        type: 'text',
        text: 'two',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]
    const mismatchTracker = new MessageThreadTracker(10, () => 0)
    anchorWithContinuation(mismatchTracker, first)
    const prepared = await prepareMessageThreadRequest(mismatchTracker, {
      ...request,
      account: 'other-tail-recovery-account',
      headers: new Headers(),
      bodyText: JSON.stringify(request.body),
    })
    // A distinct account cannot reuse another account's full-render cache entry.
    expect(
      JSON.parse(prepared.bodyText).messages[350].content[0].cache_control,
    ).toBeUndefined()
    const headers = new Headers()
    const sameAccount = await prepareMessageThreadRequest(tracker, {
      ...request,
      headers,
      bodyText: JSON.stringify(request.body),
    })
    expect(JSON.parse(sameAccount.bodyText).thread.type).toBe('continue')
    let sends = 0
    const log = spyOn(logger, 'debug')
    try {
      await sameAccount.recover(
        new Response(
          JSON.stringify({
            error: {
              type: 'not_found_error',
              details: { error_code: 'thread_not_found' },
            },
          }),
          { status: 404 },
        ),
        async (body) => {
          sends++
          expect(body).toBe(await signRequestBody(body))
          if (sends === 1) {
            expect(JSON.parse(body).thread.type).toBe('create')
            expect(
              JSON.parse(body).messages[350].content[0].cache_control,
            ).toEqual({ type: 'ephemeral', ttl: '1h' })
            return new Response(
              JSON.stringify({
                error: {
                  type: 'invalid_request_error',
                  message: 'thread is not supported',
                },
              }),
              { status: 400 },
            )
          }
          expect(
            JSON.parse(body).messages[350].content[0].cache_control,
          ).toBeUndefined()
          expect(body).toBe(JSON.stringify(request.body))
          expect(JSON.parse(body).thread).toBeUndefined()
          return new Response('ok')
        },
      )
      expect(
        log.mock.calls
          .filter((call) => call[1] === 'message_thread_tail_marker')
          .map((call) => (call[2] as { reason: string }).reason),
      ).toEqual(['tail_marker_added', 'prefix_changed'])
    } finally {
      log.mockRestore()
    }
    expect(sends).toBe(2)
    expect(headers.get('anthropic-beta')).toBeNull()
  })
})

describe('message threads', () => {
  test('local row identity survives refresh but separates replacement logins and stores', () => {
    const binding = {
      kind: 'local' as const,
      storageId: 'store-a',
      rowId: 'main',
      credentialEpoch: 1,
    }
    const key = localMessageThreadCredential(binding)
    expect(localMessageThreadCredential({ ...binding })).toBe(key)
    for (const replacement of [
      { ...binding, credentialEpoch: 2 },
      { ...binding, rowId: 'other' },
      { ...binding, storageId: 'store-b' },
    ])
      expect(localMessageThreadCredential(replacement)).not.toBe(key)
  })
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
  test('removing a system breakpoint changes identity', () => {
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
    expect(tracker.prepare(continued).decision.type).toBe('create')
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
      {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          content: [{ type: 'text', text: 'answer' }],
        },
      },
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
] as const)('HTTP %s %s has bounded thread recovery', async (status, code) => {
  const tracker = new MessageThreadTracker()
  const headers = new Headers({
    'anthropic-beta': 'base',
    'x-client-request-id': 'same-request',
  })
  const original = { ...input(), account: `bounded-recovery-${status}-${code}` }
  const first = await prepareMessageThreadRequest(tracker, {
    ...original,
    bodyText: JSON.stringify(original.body),
    headers,
  })
  await first
    .observe(
      sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'answer' }],
          },
        },
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
    expect(JSON.parse(body).thread).toEqual(
      sends === 1 ? { type: 'create' } : undefined,
    )
    expect(JSON.parse(body).messages).toEqual(full.body.messages)
    expect(headers.get('x-client-request-id')).toBe('same-request')
    return rejection()
  }
  const response = await request.recover(rejection(), send)
  await request.recover(response, send)
  expect(sends).toBe(recovered ? (status === 400 ? 2 : 1) : 0)
  await request.observe(response).text()
  expect(tracker.prepare(full).decision.type).toBe('create')
})

test('continue preserves fixed fields and the top-level automatic control', () => {
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
  expect(continued.cache_control).toEqual(cc)
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
    if (fixedCount < 4) request.body.cache_control = cc
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
    expect(continued.cache_control).toEqual(fixedCount < 4 ? cc : undefined)
    const count = (value: unknown) =>
      (JSON.stringify(value).match(/"cache_control"/g) ?? []).length
    expect(count(continued)).toBeLessThanOrEqual(4)
    expect(count({ tools: continued.tools, system: continued.system })).toBe(
      fixedCount,
    )
    expect(count(continued.messages)).toBeLessThanOrEqual(
      4 - fixedCount - (fixedCount < 4 ? 1 : 0),
    )
    const messages = continued.messages as typeof delta
    expect(messages.at(-1)?.content.at(-1)?.cache_control).toEqual(
      fixedCount >= 3 ? undefined : cc,
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

test.each([
  'system removal',
  'system ttl',
  'system order',
  'tools removal',
  'tools ttl',
  'tools order',
])('audit fixed wire: %s requires create', (change) => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const cc = { type: 'ephemeral', ttl: '1h' }
  request.body.system = [
    { type: 'text', text: 'instructions', cache_control: cc },
  ]
  request.body.tools = [
    {
      name: 'read',
      input_schema: { type: 'object', properties: {} },
      cache_control: cc,
    },
  ]
  anchor(tracker, request)
  const continued = advance(request)
  const system = structuredClone(request.body.system) as Array<
    Record<string, unknown>
  >
  const tools = structuredClone(request.body.tools) as Array<
    Record<string, unknown>
  >
  const block = system[0]
  const tool = tools[0]
  if (!block || !tool) throw new Error('Missing fixed-field fixture')
  if (change === 'system removal') delete block.cache_control
  if (change === 'system ttl')
    block.cache_control = { type: 'ephemeral', ttl: '5m' }
  if (change === 'system order')
    system[0] = {
      cache_control: block.cache_control,
      text: block.text,
      type: block.type,
    }
  if (change === 'tools removal') delete tool.cache_control
  if (change === 'tools ttl')
    tool.cache_control = { type: 'ephemeral', ttl: '5m' }
  if (change === 'tools order')
    tools[0] = {
      cache_control: tool.cache_control,
      input_schema: tool.input_schema,
      name: tool.name,
    }
  continued.body.system = system
  continued.body.tools = tools
  expect(tracker.prepare(continued).decision.type).toBe('create')
})

test('audit fixed wire: billing lineage alone remains reusable', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  request.body.system = [
    { type: 'text', text: 'x-anthropic-billing-header: old' },
    {
      type: 'text',
      text: 'instructions',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
  anchor(tracker, request)
  const continued = advance(request)
  continued.body.system = [
    { type: 'text', text: 'x-anthropic-billing-header: new' },
    {
      type: 'text',
      text: 'instructions',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ]
  expect(tracker.prepare(continued).decision.type).toBe('continue')
})

test('audit delta cache: automatic control stays top-level and creates no delta marker', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const cc = { type: 'ephemeral', ttl: '1h' }
  request.body.cache_control = cc
  anchor(tracker, request)
  const body = tracker.prepare(advance(request)).body
  expect(body.thread).toMatchObject({ type: 'continue' })
  expect(body.cache_control).toEqual(cc)
  expect(body.messages).toEqual([next])
})

test.each(['note', 'effort'])(
  'audit delta cache: trailing system %s remains byte-stable',
  (kind) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    const cc = { type: 'ephemeral', ttl: '1h' }
    request.body.messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'one', cache_control: cc }],
      },
    ]
    request.body.system = [
      { type: 'text', text: 'instructions', cache_control: cc },
    ]
    request.body.tools = [{ name: 'read', cache_control: cc }]
    anchor(tracker, request)
    const result = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call',
          content: 'result',
          cache_control: cc,
        },
      ],
    }
    const control =
      kind === 'note'
        ? {
            role: 'system',
            clear_at: 'next_user_message',
            content: 'turn-end note',
          }
        : { role: 'system', content: '', output_config: { effort: 'high' } }
    const body = tracker.prepare({
      ...request,
      body: {
        ...request.body,
        messages: [
          ...(request.body.messages as unknown[]),
          assistant,
          result,
          control,
        ],
      },
    }).body
    expect(body.thread).toMatchObject({ type: 'continue' })
    expect(body.messages).toEqual([result, control])
    expect(JSON.stringify(body.messages)).toContain(JSON.stringify(control))
    expect(
      (JSON.stringify(body).match(/"cache_control"/g) ?? []).length,
    ).toBeLessThanOrEqual(4)
  },
)

test.each(['removed', 'ttl'])(
  'audit delta cache: changed top-level control %s creates',
  (change) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    request.body.cache_control = { type: 'ephemeral', ttl: '1h' }
    anchor(tracker, request)
    const continued = advance(request)
    if (change === 'removed') delete continued.body.cache_control
    else continued.body.cache_control = { type: 'ephemeral', ttl: '5m' }
    expect(tracker.prepare(continued).decision.type).toBe('create')
  },
)

test('audit delta cache: only the last non-system message carries delta breakpoints', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const cc = { type: 'ephemeral', ttl: '1h' }
  request.body.system = [
    { type: 'text', text: 'instructions', cache_control: cc },
  ]
  anchor(tracker, request)
  const early = {
    role: 'user',
    content: [{ type: 'text', text: 'early', cache_control: cc }],
  }
  const latest = {
    role: 'user',
    content: [{ type: 'text', text: 'latest', cache_control: cc }],
  }
  const note = { role: 'system', content: 'turn-end note' }
  const body = tracker.prepare({
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        assistant,
        early,
        latest,
        note,
      ],
    },
  }).body
  expect(body.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: 'early' }] },
    latest,
    note,
  ])
})

async function observeAuditReply(
  prepared: ReturnType<MessageThreadTracker['prepare']>,
  id: string,
  content: unknown[],
) {
  const events: unknown[] = [
    { type: 'message_start', message: { id, content: [] } },
  ]
  for (const [index, block] of content.entries()) {
    events.push(
      { type: 'content_block_start', index, content_block: block },
      { type: 'content_block_stop', index },
    )
  }
  events.push(
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  )
  await observeMessageThreadResponse(sse(events), prepared).text()
}

test('usage-only fallback markers do not change reply fingerprints', async () => {
  const marker = {
    type: 'thinking',
    thinking: SERVER_FALLBACK_USAGE_MARKER_TEXT,
    signature: `${SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX}{"iterations":[]}`,
  }
  for (const observedMarker of [true, false]) {
    for (const storedMarker of [true, false]) {
      const tracker = new MessageThreadTracker()
      const request = input()
      const content = [{ type: 'text', text: 'answer' }]
      await observeAuditReply(tracker.prepare(request), 'msg_usage', [
        ...content,
        ...(observedMarker ? [marker] : []),
      ])
      expect(
        tracker.prepare({
          ...request,
          body: {
            ...request.body,
            messages: [
              ...(request.body.messages as unknown[]),
              {
                role: 'assistant',
                content: [
                  ...content,
                  ...(storedMarker ? [{ ...marker, thinking: '' }] : []),
                ],
              },
              next,
            ],
          },
        }).decision.type,
      ).toBe('continue')
    }
  }
})

test.each([
  'retry keeps A',
  'parallel keeps A',
  'another process keeps A',
  'kept B',
])('audit ancestry: %s', async (scenario) => {
  const tracker = new MessageThreadTracker()
  const request = input()
  if (scenario === 'retry keeps A')
    await observeAuditReply(tracker.prepare(request), 'msg_A', [
      { type: 'text', text: 'response A' },
    ])
  const pendingA =
    scenario === 'parallel keeps A' ? tracker.prepare(request) : undefined
  await observeAuditReply(tracker.prepare(request), 'msg_B', [
    { type: 'text', text: 'response B' },
  ])
  if (pendingA)
    await observeAuditReply(pendingA, 'msg_A', [
      { type: 'text', text: 'response A' },
    ])
  const kept = {
    role: 'assistant',
    content: scenario === 'kept B' ? 'response B' : 'response A',
  }
  const body = tracker.prepare({
    ...request,
    body: {
      ...request.body,
      messages: [...(request.body.messages as unknown[]), kept, next],
    },
  }).body
  expect(body.thread).toMatchObject({
    type: scenario === 'kept B' ? 'continue' : 'create',
  })
})

test.each([
  'lowered reply',
  'tool id',
  'tool order',
  'thinking signature',
  'redacted signature',
])(
  'audit ancestry: fingerprint survives lowering but rejects changed %s',
  async (change) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    await observeAuditReply(tracker.prepare(request), 'msg_reply', [
      {
        type: 'thinking',
        thinking: 'private reasoning',
        signature: 'signed-thinking',
      },
      { type: 'text', text: '  an' },
      { type: 'tool_use', id: 'call_1', name: 'mcp_Read', input: {} },
      { type: 'redacted_thinking', data: 'redacted-signature' },
      { type: 'tool_use', id: 'call_2', name: 'mcp_Read', input: {} },
      { type: 'text', text: 'swer  \n' },
    ])
    const lowered: Array<Record<string, unknown>> = [
      {
        type: 'thinking',
        thinking: 'lowered display',
        signature: 'signed-thinking',
      },
      { type: 'text', text: 'an' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: {} },
      { type: 'redacted_thinking', data: 'redacted-signature' },
      { type: 'tool_use', id: 'call_2', name: 'Read', input: {} },
      { type: 'text', text: 'swer' },
    ]
    if (change === 'tool id' && lowered[2]) lowered[2].id = 'different-call'
    if (change === 'tool order')
      [lowered[2], lowered[4]] = [
        lowered[4] as Record<string, unknown>,
        lowered[2] as Record<string, unknown>,
      ]
    if (change === 'thinking signature' && lowered[0])
      lowered[0].signature = 'different-thinking'
    if (change === 'redacted signature' && lowered[3])
      lowered[3].data = 'different-redacted'
    const body = tracker.prepare({
      ...request,
      body: {
        ...request.body,
        messages: [
          ...(request.body.messages as unknown[]),
          { role: 'assistant', content: lowered },
          next,
        ],
      },
    }).body
    expect(body.thread).toMatchObject({
      type: change === 'lowered reply' ? 'continue' : 'create',
    })
  },
)

test('audit ancestry: fragmented signatures and trimmed text match the kept reply', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const events = [
    { type: 'message_start', message: { id: 'msg_fragments', content: [] } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signed-' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'thinking' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: '  an' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'swer' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: ' \n' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'redacted_thinking', data: 'opaque' },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: {
        type: 'tool_use',
        id: 'call',
        name: 'mcp_Read',
        input: {},
      },
    },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]
  await observeMessageThreadResponse(
    sse(events),
    tracker.prepare(request),
  ).text()
  const kept = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'display', signature: 'signed-thinking' },
      { type: 'text', text: 'answer' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'tool_use', id: 'call', name: 'Read', input: {} },
    ],
  }
  expect(
    tracker.prepare({
      ...request,
      body: {
        ...request.body,
        messages: [...(request.body.messages as unknown[]), kept, next],
      },
    }).decision.type,
  ).toBe('continue')
})

test.each([
  {
    name: 'thread code',
    code: 'thread_unsupported_request',
    message: 'unsupported request',
    rejected: true,
  },
  {
    name: 'future thread code',
    code: 'thread_future_rejection',
    message: 'unsupported request',
    rejected: true,
  },
  {
    name: 'thread field',
    message: 'thread: unsupported request',
    rejected: true,
  },
  {
    name: 'quoted thread field',
    message: 'Unknown field: `thread`',
    rejected: true,
  },
  {
    name: 'thread beta',
    message: 'Unsupported beta message-threads-2026-08-12',
    rejected: true,
  },
  { name: 'unrelated field', message: 'model: not found', rejected: false },
  {
    name: 'unrelated thread word',
    message: 'worker thread pool is exhausted',
    rejected: false,
  },
])('audit create fallback: %j', async (fault) => {
  const warn = spyOn(logger, 'warn').mockImplementation(() => {})
  try {
    const original = input()
    original.body.system = [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.302.abc; cc_entrypoint=cli; cch=00000;',
      },
    ]
    const account = `audit-create-${fault.name}`
    const make = async (tracker: MessageThreadTracker, target = account) => {
      const laterHeaders = new Headers({
        'anthropic-beta': `base,${MESSAGE_THREADS_BETA}`,
        'x-client-request-id': 'create-fallback-id',
      })
      const later = await prepareMessageThreadRequest(tracker, {
        ...original,
        account: target,
        credential: 'rotated-credential',
        bodyText: JSON.stringify(original.body),
        headers: laterHeaders,
      })
      return { request: later, headers: laterHeaders }
    }
    const headers = new Headers({
      'anthropic-beta': 'base',
      'x-client-request-id': 'create-fallback-id',
    })
    const request = await prepareMessageThreadRequest(
      new MessageThreadTracker(),
      {
        ...original,
        account,
        bodyText: JSON.stringify(original.body),
        headers,
      },
    )
    const rejected = () =>
      Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: fault.message,
            details: { error_code: fault.code },
          },
        },
        { status: 400 },
      )
    let resends = 0
    const resend = async (text: string) => {
      resends++
      expect(JSON.parse(text).thread).toBeUndefined()
      expect(JSON.parse(text).messages).toEqual(original.body.messages)
      expect(headers.get('anthropic-beta')).toBe('base')
      expect(headers.get('x-client-request-id')).toBe('create-fallback-id')
      expect(await signRequestBody(text)).toBe(text)
      expect(JSON.parse(text).system[0].text).not.toContain('cch=00000')
      return new Response('stateless accepted')
    }
    const response = await request.recover(rejected(), resend)
    await request.recover(rejected(), resend)
    expect(resends).toBe(fault.rejected ? 1 : 0)
    expect(response.status).toBe(fault.rejected ? 200 : 400)
    const subsequent = await make(new MessageThreadTracker())
    expect(JSON.parse(subsequent.request.bodyText).thread).toEqual(
      fault.rejected ? undefined : { type: 'create' },
    )
    expect(subsequent.headers.get('anthropic-beta')).toBe(
      fault.rejected ? 'base' : `base,${MESSAGE_THREADS_BETA}`,
    )
    const otherAccount = await make(
      new MessageThreadTracker(),
      `${account}-other`,
    )
    expect(JSON.parse(otherAccount.request.bodyText).thread).toEqual({
      type: 'create',
    })
    expect(
      warn.mock.calls.filter((call) => call[0] === 'message-threads'),
    ).toHaveLength(fault.rejected ? 1 : 0)
  } finally {
    warn.mockRestore()
  }
})

test.each(['accepted', 'downstream rejected'])(
  'audit recovered create: %s resend has a fresh lifecycle',
  async (outcome) => {
    const tracker = new MessageThreadTracker()
    const original = anchor(tracker, {
      ...input(),
      account: `audit-reanchor-${outcome}`,
      betas: ['base', MESSAGE_THREADS_BETA],
    })
    const full = advance(original)
    const headers = new Headers({
      'anthropic-beta': 'base',
      'x-client-request-id': 'reanchor-id',
    })
    const request = await prepareMessageThreadRequest(tracker, {
      ...full,
      bodyText: JSON.stringify(full.body),
      headers,
    })
    expect(JSON.parse(request.bodyText).thread.type).toBe('continue')
    const rejection = Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          details: { error_code: 'thread_fingerprint_mismatch' },
        },
      },
      { status: 400 },
    )
    let sends = 0
    const response = await request.recover(rejection, async (body) => {
      sends++
      expect(JSON.parse(body).thread).toEqual({ type: 'create' })
      expect(JSON.parse(body).messages).toEqual(full.body.messages)
      expect(headers.get('x-client-request-id')).toBe('reanchor-id')
      return sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_recovered',
            content: [{ type: 'text', text: 'Recovered answer' }],
          },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ])
    })
    await request.observe(response).text()
    if (outcome === 'downstream rejected') request.fail()
    expect(sends).toBe(1)
    const nextRequest = await prepareMessageThreadRequest(tracker, {
      ...full,
      bodyText: JSON.stringify({
        ...full.body,
        messages: [
          ...(full.body.messages as unknown[]),
          { role: 'assistant', content: 'Recovered answer' },
          { role: 'user', content: 'Third prompt' },
        ],
      }),
      headers,
    })
    expect(JSON.parse(nextRequest.bodyText).thread).toEqual(
      outcome === 'accepted'
        ? { type: 'continue', previous_message_id: 'msg_recovered' }
        : { type: 'create' },
    )
  },
)

test.each([200, 400])(
  'audit recovered create: continue-to-create-to-stateless ends at %s without a fourth send',
  async (finalStatus) => {
    const tracker = new MessageThreadTracker()
    const original = anchor(tracker, {
      ...input(),
      account: `audit-three-sends-${finalStatus}`,
      betas: ['base', MESSAGE_THREADS_BETA],
    })
    const full = advance(original)
    const headers = new Headers({
      'anthropic-beta': 'base',
      'x-client-request-id': 'three-send-id',
    })
    const request = await prepareMessageThreadRequest(tracker, {
      ...full,
      bodyText: JSON.stringify(full.body),
      headers,
    })
    const modes = [JSON.parse(request.bodyText).thread?.type]
    const rejection = (status: number, code: string) =>
      Response.json(
        {
          type: 'error',
          error: {
            type: status === 404 ? 'not_found_error' : 'invalid_request_error',
            details: { error_code: code },
          },
        },
        { status },
      )
    const send = async (text: string) => {
      const mode = JSON.parse(text).thread?.type
      modes.push(mode)
      expect(headers.get('x-client-request-id')).toBe('three-send-id')
      if (mode === 'create') return rejection(400, 'thread_unsupported_request')
      expect(mode).toBeUndefined()
      expect(headers.get('anthropic-beta')).toBe('base')
      return finalStatus === 200
        ? new Response('stateless works')
        : rejection(400, 'thread_unsupported_request')
    }
    const response = await request.recover(
      rejection(404, 'thread_not_found'),
      send,
    )
    expect(response.status).toBe(finalStatus)
    expect(modes).toEqual(['continue', 'create', undefined])
    await request.recover(rejection(400, 'thread_unsupported_request'), send)
    expect(modes).toHaveLength(3)
    const later = await prepareMessageThreadRequest(
      new MessageThreadTracker(),
      { ...full, bodyText: JSON.stringify(full.body), headers },
    )
    expect(JSON.parse(later.bodyText).thread).toBeUndefined()
  },
)

test('audit resend authorization: refreshed credentials label the recovered anchor', async () => {
  const tracker = new MessageThreadTracker()
  const original = anchor(tracker, {
    ...input(),
    account: 'audit-credential-refresh',
    credential: 'old-credential',
    betas: ['base', MESSAGE_THREADS_BETA],
  })
  const full = advance(original)
  const headers = new Headers({ 'anthropic-beta': 'base' })
  const request = await prepareMessageThreadRequest(tracker, {
    ...full,
    bodyText: JSON.stringify(full.body),
    headers,
  })
  const response = await request.recover(
    Response.json(
      {
        error: {
          type: 'not_found_error',
          details: { error_code: 'thread_not_found' },
        },
      },
      { status: 404 },
    ),
    async () =>
      sse([
        {
          type: 'message_start',
          message: {
            id: 'msg_new_credential',
            content: [{ type: 'text', text: 'new reply' }],
          },
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ]),
    () => ({ credential: 'new-credential' }),
  )
  await request.observe(response).text()
  const nextRequest = await prepareMessageThreadRequest(tracker, {
    ...full,
    credential: 'new-credential',
    bodyText: JSON.stringify({
      ...full.body,
      messages: [
        ...(full.body.messages as unknown[]),
        { role: 'assistant', content: 'new reply' },
        next,
      ],
    }),
    headers,
  })
  expect(JSON.parse(nextRequest.bodyText).thread).toEqual({
    type: 'continue',
    previous_message_id: 'msg_new_credential',
  })
})

test('audit resend authorization: a declined create retry preserves the original response body', async () => {
  const headers = new Headers({ 'anthropic-beta': 'base' })
  const original = { ...input(), account: 'audit-declined-create' }
  const request = await prepareMessageThreadRequest(
    new MessageThreadTracker(),
    { ...original, bodyText: JSON.stringify(original.body), headers },
  )
  const rejected = Response.json(
    {
      error: {
        type: 'invalid_request_error',
        message: 'thread: unsupported request',
        details: { error_code: 'thread_unsupported_request' },
      },
    },
    { status: 400 },
  )
  const expected = await rejected.clone().text()
  let sent = false
  const response = await request.recover(
    rejected,
    async () => {
      sent = true
      return new Response('unexpected')
    },
    () => false,
  )
  expect(sent).toBe(false)
  expect(response).toBe(rejected)
  expect(await response.text()).toBe(expected)
  const later = await prepareMessageThreadRequest(new MessageThreadTracker(), {
    ...original,
    bodyText: JSON.stringify(original.body),
    headers,
  })
  expect(JSON.parse(later.bodyText).thread).toBeUndefined()
})

test.each([
  'no anchor',
  'wrong account',
  'expired',
  'short history',
  'changed model',
])('audit hot path: %s creates before reading message content', (gate) => {
  let now = 0
  const tracker = new MessageThreadTracker(8, () => now)
  const original = input()
  if (gate !== 'no anchor') anchor(tracker, original)
  if (gate === 'expired') now = 300_000
  const candidate = gate === 'short history' ? original : advance(original)
  if (gate === 'wrong account') candidate.account = 'different-account'
  if (gate === 'changed model') candidate.body.model = 'different-model'
  let reads = 0
  candidate.body.messages = [
    {
      role: 'user',
      get content() {
        reads++
        throw new Error('message content read before create gate')
      },
    },
    ...(candidate.body.messages as unknown[]).slice(1),
  ]
  expect(tracker.prepare(candidate).decision.type).toBe('create')
  expect(reads).toBe(0)
})

test('audit hot path: create hashes its snapshot only after accepted completion', () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  let reads = 0
  request.body.messages = [
    {
      role: 'user',
      get content() {
        reads++
        return 'one'
      },
    },
  ]
  const prepared = tracker.prepare(request)
  expect(prepared.decision.type).toBe('create')
  expect(reads).toBe(0)
  prepared.complete({
    messageId: 'msg_deferred',
    stopped: true,
    stopReason: 'end_turn',
    reply: assistant,
  })
  expect(reads).toBeGreaterThan(0)
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [{ role: 'user', content: 'one' }, assistant, next],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('continue')
})

test('audit hot path: serialized create preserves ordinary thread-named data and replaces only a root thread', async () => {
  for (const rootThread of [
    undefined,
    { type: 'continue', previous_message_id: 'caller-value' },
  ]) {
    const original = input()
    original.body.tools = [
      {
        name: 'read',
        input_schema: {
          type: 'object',
          properties: { thread: { type: 'string' } },
        },
      },
    ]
    original.body.messages = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'id',
            content: '{"thread":"ordinary text"}',
          },
        ],
      },
    ]
    if (rootThread) original.body.thread = rootThread
    const request = await prepareMessageThreadRequest(
      new MessageThreadTracker(),
      {
        ...original,
        bodyText: ` \n${JSON.stringify(original.body)}\n`,
        headers: new Headers(),
      },
    )
    const sent = JSON.parse(request.bodyText)
    expect(sent.thread).toEqual({ type: 'create' })
    expect(sent.tools).toEqual(original.body.tools)
    expect(sent.messages).toEqual(original.body.messages)
  }
})

test.each(['default', 'different-policy', null])(
  'recheck fallbacks: value %j participates in the fixed fingerprint',
  (value) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    request.body.fallbacks = 'default'
    anchor(tracker, request)
    const candidate = advance(request)
    candidate.body.fallbacks = value
    expect(tracker.prepare(candidate).decision.type).toBe(
      value === 'default' ? 'continue' : 'create',
    )
  },
)

test.each([
  'adjacent assistant',
  'later assistant',
  'assistant after controls',
  'user-only delta',
])('recheck rule four: %s', (kind) => {
  const tracker = new MessageThreadTracker()
  const request = anchor(tracker)
  const other = { role: 'assistant', content: 'intervening reply' }
  const delta =
    kind === 'adjacent assistant'
      ? [other, next]
      : kind === 'later assistant'
        ? [next, other, { role: 'user', content: 'third' }]
        : kind === 'assistant after controls'
          ? [
              {
                role: 'system',
                content: [],
                output_config: { effort: 'high' },
              },
              next,
              other,
              { role: 'user', content: 'third' },
            ]
          : [next]
  const prepared = tracker.prepare({
    ...request,
    body: {
      ...request.body,
      messages: [...(request.body.messages as unknown[]), assistant, ...delta],
    },
  })
  expect(prepared.decision.type).toBe(
    kind === 'user-only delta' ? 'continue' : 'create',
  )
})

test.each([
  'string to block',
  'block to string',
  'changed text',
  'extra metadata',
])('recheck user text: %s', (kind) => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const originalContent =
    kind === 'block to string'
      ? [{ type: 'text', text: 'one', cache_control: { type: 'ephemeral' } }]
      : 'one'
  request.body.messages = [{ role: 'user', content: originalContent }]
  anchor(tracker, request)
  const content =
    kind === 'block to string'
      ? 'one'
      : kind === 'changed text'
        ? 'different'
        : kind === 'extra metadata'
          ? [
              {
                type: 'text',
                text: 'one',
                citations: [{ source: 'retained metadata' }],
              },
            ]
          : [
              {
                type: 'text',
                text: 'one',
                cache_control: { type: 'ephemeral' },
              },
            ]
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [{ role: 'user', content }, assistant, next],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe(
    kind === 'changed text' || kind === 'extra metadata'
      ? 'create'
      : 'continue',
  )
  expect(
    (request.body.messages as Array<{ content: unknown }>)[0]?.content,
  ).toEqual(originalContent)
})

test.each([
  'whitespace reappears',
  'whitespace removed',
  'meaningful suffix',
  'tool input edit',
])('recheck assistant whitespace: %s', (kind) => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const first = (request.body.messages as unknown[])[0]
  const call = {
    type: 'tool_use',
    id: 'historic_call',
    name: 'read',
    input: { path: 'original' },
  }
  const whitespace = [
    { type: 'text', text: ' \n' },
    { type: 'text', text: '\t' },
  ]
  const result = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'historic_call', content: 'result' },
    ],
  }
  const before = {
    role: 'assistant',
    content: kind === 'whitespace removed' ? [call, ...whitespace] : [call],
  }
  request.body.messages = [first, before, result]
  anchor(tracker, request)
  const after = {
    role: 'assistant',
    content:
      kind === 'whitespace removed'
        ? [call]
        : kind === 'meaningful suffix'
          ? [call, { type: 'text', text: 'meaningful text' }]
          : kind === 'tool input edit'
            ? [{ ...call, input: { path: 'edited' } }, ...whitespace]
            : [call, ...whitespace],
  }
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [first, after, result, assistant, next],
    },
  }
  const wireBefore = JSON.stringify(candidate.body.messages)
  expect(tracker.prepare(candidate).decision.type).toBe(
    kind === 'meaningful suffix' || kind === 'tool input edit'
      ? 'create'
      : 'continue',
  )
  expect(JSON.stringify(candidate.body.messages)).toBe(wireBefore)
})

test.each([
  'lowered name',
  'sorted input',
  'edited input',
  'edited data key',
  'edited name',
  'block layout',
])('recheck reply semantics: %s', async (change) => {
  const tracker = new MessageThreadTracker()
  const request = input()
  request.body.tools = [{ name: 'read' }, { name: 'write' }]
  const events = [
    { type: 'message_start', message: { id: 'msg_semantic', content: [] } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'thinking',
        thinking: 'private',
        signature: 'sig',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'same_id',
        name: 'mcp_Read',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"path":"ori' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json:
          'ginal","cache_control":"literal","nested":{"b":2,"a":1}}',
      },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '  answer \n' },
    },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]
  await observeMessageThreadResponse(
    sse(events),
    tracker.prepare(request),
  ).text()
  const args =
    change === 'sorted input'
      ? { nested: { a: 1, b: 2 }, cache_control: 'literal', path: 'original' }
      : {
          path: change === 'edited input' ? 'edited' : 'original',
          cache_control: change === 'edited data key' ? 'edited' : 'literal',
          nested: { b: 2, a: 1 },
        }
  const content: Array<Record<string, unknown>> = [
    { type: 'thinking', thinking: 'display', signature: 'sig' },
    {
      type: 'tool_use',
      id: 'same_id',
      name: change === 'edited name' ? 'write' : 'read',
      input: args,
    },
    { type: 'text', text: 'answer' },
  ]
  if (change === 'block layout')
    [content[1], content[2]] = [
      content[2] as Record<string, unknown>,
      content[1] as Record<string, unknown>,
    ]
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        { role: 'assistant', content },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe(
    change === 'lowered name' || change === 'sorted input'
      ? 'continue'
      : 'create',
  )
})

test('recheck reply semantics: text cannot move across an unchanged tool call', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  await observeAuditReply(tracker.prepare(request), 'msg_text_boundary', [
    { type: 'text', text: 'ab' },
    { type: 'tool_use', id: 'same_id', name: 'mcp_Read', input: {} },
    { type: 'text', text: 'cd' },
  ])
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'tool_use', id: 'same_id', name: 'read', input: {} },
            { type: 'text', text: 'bcd' },
          ],
        },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('create')
})

test('recheck reply semantics: request-bound custom case targets remain distinct', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  request.body.tools = [{ name: 'CaseTool' }, { name: 'caseTool' }]
  request.replyToolNames = new Map([
    ['CaseTool', 'CaseTool'],
    ['caseTool', 'caseTool'],
  ])
  await observeAuditReply(tracker.prepare(request), 'msg_case', [
    { type: 'tool_use', id: 'same_id', name: 'CaseTool', input: {} },
  ])
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'same_id', name: 'caseTool', input: {} },
          ],
        },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('create')
})

test('recheck reply semantics: malformed streamed arguments never establish an anchor', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  await observeMessageThreadResponse(
    sse([
      { type: 'message_start', message: { id: 'msg_invalid', content: [] } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'same_id',
          name: 'mcp_Read',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]),
    tracker.prepare(request),
  ).text()
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'same_id', name: 'read', input: {} },
          ],
        },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('create')
})

test('recheck reply semantics: our trailing tool-whitespace removal preserves the reply', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  await observeAuditReply(tracker.prepare(request), 'msg_space', [
    { type: 'tool_use', id: 'same_id', name: 'mcp_Read', input: {} },
    { type: 'text', text: ' \n' },
  ])
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'same_id', name: 'read', input: {} },
          ],
        },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('continue')
})

test.each(['citations', 'future_text_metadata'])(
  'final review annotations: response text with %s cannot anchor',
  async (field) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    await observeAuditReply(tracker.prepare(request), 'msg_annotated', [
      { type: 'text', text: 'answer', [field]: [{ source: 'original' }] },
    ])
    const candidate = {
      ...request,
      body: {
        ...request.body,
        messages: [
          ...(request.body.messages as unknown[]),
          { role: 'assistant', content: 'answer' },
          next,
        ],
      },
    }
    expect(tracker.prepare(candidate).decision.type).toBe('create')
  },
)

test('final review annotations: same text with different citations creates', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  await observeAuditReply(tracker.prepare(request), 'msg_citations', [
    { type: 'text', text: 'answer', citations: [{ source: 'original' }] },
  ])
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'answer',
              citations: [{ source: 'changed' }],
            },
          ],
        },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('create')
})

test('final review annotations: adding metadata to a plain retained reply creates', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  anchor(tracker, request)
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer', citations: [] }],
        },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('create')
})

test('final review annotations: protocol cache metadata still permits continuation', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  await observeAuditReply(tracker.prepare(request), 'msg_text_cache', [
    { type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } },
  ])
  expect(tracker.prepare(advance(request)).decision.type).toBe('continue')
})

test('final review annotations: citations_delta cannot anchor plain retained text', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  await observeMessageThreadResponse(
    sse([
      {
        type: 'message_start',
        message: { id: 'msg_citation_delta', content: [] },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'answer' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: { source: 'original' } },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]),
    tracker.prepare(request),
  ).text()
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        { role: 'assistant', content: 'answer' },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('create')
})

test.each(['', ' \n'])(
  'final review no arguments: partial_json %j still anchors the start input',
  async (partial) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    await observeMessageThreadResponse(
      sse([
        { type: 'message_start', message: { id: 'msg_no_args', content: [] } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'empty_call',
            name: 'mcp_Read',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: partial },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]),
      tracker.prepare(request),
    ).text()
    const candidate = {
      ...request,
      body: {
        ...request.body,
        messages: [
          ...(request.body.messages as unknown[]),
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'empty_call', name: 'read', input: {} },
            ],
          },
          next,
        ],
      },
    }
    expect(tracker.prepare(candidate).decision).toEqual({
      type: 'continue',
      previousMessageId: 'msg_no_args',
      deltaMessages: [next],
    })
  },
)

test('final review budget: oversized open tool JSON skips stop parsing and cannot anchor', async () => {
  const tracker = new MessageThreadTracker()
  const request = input()
  const parse = JSON.parse
  let argumentParses = 0
  JSON.parse = (text, reviver) => {
    if (text === '' || text.startsWith('{"oversized":')) argumentParses++
    return parse(text, reviver)
  }
  try {
    await observeMessageThreadResponse(
      sse([
        {
          type: 'message_start',
          message: { id: 'msg_over_budget', content: [] },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'large_call',
            name: 'mcp_Read',
            input: {},
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: `{"oversized":"${'x'.repeat(1_048_576)}"}`,
          },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]),
      tracker.prepare(request),
    ).text()
  } finally {
    JSON.parse = parse
  }
  const candidate = {
    ...request,
    body: {
      ...request.body,
      messages: [
        ...(request.body.messages as unknown[]),
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'large_call', name: 'read', input: {} },
          ],
        },
        next,
      ],
    },
  }
  expect(tracker.prepare(candidate).decision.type).toBe('create')
  expect(argumentParses).toBe(0)
})

test.each(['citations', 'future_text_metadata'])(
  'final review whitespace: history retains whitespace text carrying %s',
  async (field) => {
    const tracker = new MessageThreadTracker()
    const request = input()
    const tool = {
      type: 'tool_use',
      id: 'history_call',
      name: 'read',
      input: {},
    }
    const prefix = [
      ...(request.body.messages as unknown[]),
      {
        role: 'assistant',
        content: [
          tool,
          {
            type: 'text',
            text: ' \n',
            [field]: [{ source: 'original' }],
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'history_call',
            content: 'result',
          },
        ],
      },
    ]
    request.body.messages = prefix
    await observeAuditReply(tracker.prepare(request), 'msg_history_metadata', [
      { type: 'text', text: 'answer' },
    ])
    const rewritten = prefix.map((message) => {
      const record = message as Record<string, unknown>
      return record.role === 'assistant'
        ? { ...record, content: [tool] }
        : message
    })
    const candidate = {
      ...request,
      body: {
        ...request.body,
        messages: [
          ...rewritten,
          { role: 'assistant', content: 'answer' },
          next,
        ],
      },
    }
    expect(tracker.prepare(candidate).decision.type).toBe('create')
  },
)

describe('message thread create diagnostics', () => {
  function capture(run: (records: LogTestRecord[]) => void) {
    const level = getLogLevel()
    const records: LogTestRecord[] = []
    setLogLevel('debug')
    __setLogTestSink((record) => {
      if (record.message === 'message_thread_create') records.push(record)
    })
    try {
      run(records)
    } finally {
      __setLogTestSink(null)
      setLogLevel(level)
    }
  }

  test.each<MessageThreadCreateReason>([
    'no_anchor',
    'clock_rollback',
    'expired',
    'identity_changed',
    'too_few_messages',
    'assistant_missing',
    'extra_assistant',
    'reply_invalid',
    'reply_changed',
    'fixed_changed',
    'prefix_changed',
  ])('explains %s with one debug line', (reason) => {
    capture((records) => {
      let now = 1_000
      const tracker = new MessageThreadTracker(10, () => now)
      const original = reason === 'no_anchor' ? input() : anchor(tracker)
      const request = advance(original)
      const messages = request.body.messages as unknown[]
      records.length = 0
      if (reason === 'clock_rollback') now = 999
      if (reason === 'expired') now += 300_000
      if (reason === 'identity_changed') request.credential = 'replacement-row'
      if (reason === 'too_few_messages') messages.pop()
      if (reason === 'assistant_missing') messages[1] = next
      if (reason === 'extra_assistant') messages.push(assistant)
      if (reason === 'reply_invalid')
        messages[1] = { role: 'assistant', content: [{ type: 'unknown' }] }
      if (reason === 'reply_changed')
        messages[1] = { role: 'assistant', content: 'edited reply' }
      if (reason === 'fixed_changed') request.body.model = 'another-model'
      if (reason === 'prefix_changed') messages[0] = next
      expect(tracker.prepare(request).decision.type).toBe('create')
      expect(records).toHaveLength(1)
      expect(records[0]?.level).toBe('debug')
      expect(records[0]?.payload?.reason).toBe(reason)
      expect(records[0]?.payload?.anchor_present).toBe(reason !== 'no_anchor')
      expect(records[0]?.payload?.account_equal).toBe(reason !== 'no_anchor')
      expect(records[0]?.payload?.credential_equal).toBe(
        reason !== 'no_anchor' && reason !== 'identity_changed',
      )
    })
  })

  test('earlier checks take precedence over later mismatches', () => {
    capture((records) => {
      let now = 1_000
      const tracker = new MessageThreadTracker(10, () => now)
      const request = advance(anchor(tracker))
      request.account = 'different-account'
      request.body.messages = []
      now = 999
      tracker.prepare(request)
      expect(records.at(-1)?.payload?.reason).toBe('clock_rollback')
      anchor(tracker)
      now += 300_000
      tracker.prepare(request)
      expect(records.at(-1)?.payload?.reason).toBe('expired')
      anchor(tracker)
      tracker.prepare(request)
      expect(records.at(-1)?.payload?.reason).toBe('identity_changed')
      expect(records.at(-1)?.payload?.account_equal).toBe(false)
    })
  })

  test('continues are silent, creates are debug-only and metadata cannot leak request contents', () => {
    capture((records) => {
      const tracker = new MessageThreadTracker()
      const original = input()
      original.account = 'private-account-uuid'
      original.credential = 'private-credential-row'
      original.body.system = 'private-system'
      original.body.tools = [
        {
          name: 'private-tool',
          input_schema: { description: 'private-schema' },
        },
      ]
      original.body.messages = [{ role: 'user', content: 'private-prompt' }]
      original.body.access_token = 'sk-ant-oat01-private-access-token'
      const privateReply = {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'private-thinking',
            signature: 'private-signature',
          },
          {
            type: 'tool_use',
            id: 'call_safe',
            name: 'private-tool',
            input: { argument: 'private-tool-input' },
          },
        ],
      }
      const first = tracker.prepare(original)
      first.complete({
        messageId: 'msg_safe',
        stopped: true,
        stopReason: 'end_turn',
        reply: privateReply,
      })
      const following = advance(original)
      ;(following.body.messages as unknown[])[1] = privateReply
      const continued = tracker.prepare(following)
      expect(continued.decision.type).toBe('continue')
      expect(records).toHaveLength(1)
      continued.fail('stream_cancelled')
      tracker.prepare(original)
      expect(records).toHaveLength(2)
      expect(records[1]?.payload?.instance).toBe(records[0]?.payload?.instance)
      new MessageThreadTracker().prepare(original)
      expect(records[2]?.payload?.instance).not.toBe(
        records[0]?.payload?.instance,
      )
      const payload = records[0]?.payload
      expect(Object.keys(payload ?? {}).sort()).toEqual(
        [
          'account_equal',
          'anchor_age_ms',
          'anchor_present',
          'credential_equal',
          'event',
          'instance',
          'last_anchor_disposition',
          'previous_message_id',
          'reason',
          'request',
          'session',
        ].sort(),
      )
      expect(JSON.stringify(records)).not.toContain('private-')
      expect(JSON.stringify(records)).not.toMatch(/[a-f0-9]{64}/)
      setLogLevel('info')
      tracker.prepare(original)
      expect(records).toHaveLength(3)
    })
  })

  test.each<MessageThreadDisposition>([
    'stream_cancelled',
    'stream_error',
    'signal_aborted',
    'invalid_completion',
    'invalid_reply',
    'response_refusal',
    'response_fallback',
    'response_rewritten',
    'thread_rejected',
    'account_disabled',
    'session_deleted',
  ])('no_anchor retains %s without an extra event', (disposition) => {
    capture((records) => {
      const tracker = new MessageThreadTracker()
      const prepared = tracker.prepare(input())
      prepared.fail(disposition)
      expect(records).toHaveLength(1)
      tracker.prepare(input())
      expect(records.at(-1)?.payload?.last_anchor_disposition).toBe(disposition)
    })
  })

  test('tracks never seen, superseded and evicted sessions within the session bound', () => {
    capture((records) => {
      const tracker = new MessageThreadTracker(2)
      const first = tracker.prepare(input())
      expect(records.at(-1)?.payload?.last_anchor_disposition).toBe(
        'never_seen',
      )
      tracker.prepare(input())
      first.fail('stream_cancelled')
      expect(records.at(-1)?.payload?.last_anchor_disposition).toBe(
        'superseded',
      )
      tracker.prepare({ ...input(), session: 'second' })
      tracker.prepare({ ...input(), session: 'third' })
      tracker.prepare(input())
      expect(records.at(-1)?.payload?.last_anchor_disposition).toBe('evicted')
      for (let i = 0; i < 20; i++) tracker.forget(`deleted-${i}`)
      expect(
        (tracker as unknown as { dispositions: Map<string, unknown> })
          .dispositions.size,
      ).toBe(2)
    })
  })
})

test.each(['SSE error', 'aborted stream error'] as const)(
  'create diagnostics distinguish %s after response observation',
  async (kind) => {
    const debug = spyOn(logger, 'debug').mockImplementation(() => {})
    try {
      const tracker = new MessageThreadTracker()
      const abort = new AbortController()
      const request = input()
      request.account = `diagnostic-${kind}`
      const prepared = await prepareMessageThreadRequest(tracker, {
        ...request,
        bodyText: JSON.stringify(request.body),
        headers: new Headers(),
        signal: abort.signal,
      })
      const response =
        kind === 'SSE error'
          ? sse([{ type: 'error' }])
          : new Response(
              new ReadableStream({
                pull() {
                  abort.abort()
                  throw new Error('transport ended')
                },
              }),
            )
      await prepared
        .observe(response)
        .text()
        .catch(() => {})
      tracker.prepare(request)
      expect(debug.mock.calls.at(-1)?.[2]?.last_anchor_disposition).toBe(
        kind === 'SSE error' ? 'stream_error' : 'signal_aborted',
      )
    } finally {
      debug.mockRestore()
    }
  },
)
