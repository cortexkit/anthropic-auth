import { expect, test } from 'bun:test'
import {
  FALLBACK_CREDIT_PLACEHOLDER,
  FallbackCreditResponseTooLargeError,
  protectFallbackCreditResponse,
} from '../fallback-credit.ts'
import {
  joinRefusalFallbackStream,
  type RefusalFallbackStreamRefusal,
  type RefusalFallbackStreamRetry,
} from '../refusal-fallback-stream.ts'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback-usage.ts'
import { createSseFramer, parseSseFrame } from '../sse.ts'

type Payload = { type: string; [key: string]: unknown }
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const sourceModel = 'claude-opus-5-5'
const targetModel = 'claude-opus-4-8'
const baseOptions = { sourceModel, isFresh: () => true }
const headers = { 'content-type': 'text/event-stream' }
const creditHeaders = new Headers({
  'anthropic-beta': SERVER_SIDE_FALLBACK_BETA,
})
const wire = (frame: Payload) =>
  `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`

// A source refusal can follow text, thinking, or tool parts. A retry starts
// with its own usage counters.
const start = (model: string, usage?: object): Payload => ({
  type: 'message_start',
  message: { id: `msg_${model}`, model, usage },
})
const block = (index: number, type: string, fields = {}): Payload => ({
  type: 'content_block_start',
  index,
  content_block: { type, ...fields },
})
const blockDelta = (index: number, type: string, fields: object): Payload => ({
  type: 'content_block_delta',
  index,
  delta: { type, ...fields },
})
const blockStop = (index: number): Payload => ({
  type: 'content_block_stop',
  index,
})
const stop: Payload = { type: 'message_stop' }
const refused = (fields = {}): Payload => ({
  type: 'message_delta',
  delta: {
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'unknown', ...fields },
  },
  usage: { output_tokens: 17 },
})
const endTurn: Payload = {
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 29 },
}
const ping: Payload = { type: 'ping' }
const refusalBlock = (index: number) =>
  block(index, 'refusal', { text: 'Cannot continue.' })
const text = (index: number) => block(index, 'text', { text: '' })
const thinking = (index: number) => block(index, 'thinking', { thinking: '' })
const textDelta = (index: number, value: string) =>
  blockDelta(index, 'text_delta', { text: value })
const tool = (index: number, id = 'tool_fixture') =>
  block(index, 'tool_use', { id, name: 'test', input: {} })
const toolInput = (index: number, partial = '{"ok":true}') =>
  blockDelta(index, 'input_json_delta', { partial_json: partial })
const error: Payload = {
  type: 'error',
  error: { type: 'overloaded_error', message: 'Overloaded' },
}

function response(...frames: Payload[]) {
  return new Response(frames.map(wire).join(''), { headers })
}

async function events(output: Response): Promise<Payload[]> {
  return createSseFramer()
    .push(new Uint8Array(await output.arrayBuffer()))
    .map((bytes) => JSON.parse(parseSseFrame(bytes).data ?? 'null'))
}

function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
      cancel() {
        cancelled = true
      },
    }),
    { headers },
  )
  return {
    response,
    push(...frames: Payload[]) {
      controller.enqueue(encoder.encode(frames.map(wire).join('')))
    },
    close() {
      controller.close()
    },
    get cancelled() {
      return cancelled
    },
  }
}

function manualClock() {
  let now = 0
  const timers = new Map<() => void, number>()
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number) {
      timers.set(callback, now + delayMs)
      return () => {
        timers.delete(callback)
      }
    },
    advance(ms: number) {
      now += ms
      for (const [run, at] of timers) {
        if (now < at) continue
        timers.delete(run)
        run()
      }
    },
    get scheduled() {
      return timers.size
    },
  }
}

async function readChunk(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>,
) {
  return decoder.decode((await reader.read()).value)
}

function joinedRetry(stream: Response): RefusalFallbackStreamRetry {
  return { kind: 'retry', response: stream }
}

test('forwards thinking and text as they arrive but releases a completed tool in one chunk', async () => {
  const upstream = feed()
  const reader = joinRefusalFallbackStream(
    upstream.response,
    baseOptions,
  ).body!.getReader()
  upstream.push(start(sourceModel), thinking(0))
  expect(await readChunk(reader)).toBe(wire(start(sourceModel)))
  expect(await readChunk(reader)).toBe(wire(thinking(0)))
  const thought = blockDelta(0, 'thinking_delta', { thinking: 'Thinking' })
  upstream.push(thought, blockStop(0), tool(1), toolInput(1), text(2))
  expect(await readChunk(reader)).toBe(wire(thought))
  expect(await readChunk(reader)).toBe(wire(blockStop(0)))
  expect(await readChunk(reader)).toBe(wire(text(1)))
  upstream.push(textDelta(2, 'Text'), blockStop(1))
  expect(await readChunk(reader)).toBe(wire(textDelta(1, 'Text')))
  expect(await readChunk(reader)).toBe(
    [blockStop(1), tool(2), toolInput(2), blockStop(2)].map(wire).join(''),
  )
  upstream.push(blockStop(2), endTurn, stop)
  upstream.close()
  expect(await readChunk(reader)).toBe(wire(endTurn))
  expect(await readChunk(reader)).toBe(wire(stop))
  expect((await reader.read()).done).toBe(true)
})

test('joins a retry after an unfinished tool at 0 and text at 1, using only the retry usage', async () => {
  const output = joinRefusalFallbackStream(
    response(
      start(sourceModel, { input_tokens: 111, cache_read_input_tokens: 500 }),
      tool(0),
      toolInput(0),
      text(1),
      textDelta(1, 'Source'),
      refusalBlock(2),
      blockStop(2),
      refused(),
      stop,
    ),
    {
      ...baseOptions,
      retry: () =>
        joinedRetry(
          response(
            start(targetModel, {
              input_tokens: 11,
              output_tokens: 1,
              cache_read_input_tokens: 222,
              cache_creation_input_tokens: 5,
              cache_creation: {
                ephemeral_5m_input_tokens: 2,
                ephemeral_1h_input_tokens: 3,
              },
            }),
            ping,
            text(0),
            textDelta(0, 'Target'),
            blockStop(0),
            endTurn,
            stop,
          ),
        ),
    },
  )
  expect(await events(output)).toEqual([
    start(sourceModel, { input_tokens: 111, cache_read_input_tokens: 500 }),
    text(0),
    textDelta(0, 'Source'),
    ping,
    blockStop(0),
    text(1),
    textDelta(1, 'Target'),
    blockStop(1),
    {
      ...endTurn,
      usage: {
        input_tokens: 11,
        output_tokens: 29,
        cache_read_input_tokens: 222,
        cache_creation_input_tokens: 5,
        cache_creation: {
          ephemeral_5m_input_tokens: 2,
          ephemeral_1h_input_tokens: 3,
        },
      },
    },
    stop,
  ])
})

test('provides typed refusal metadata, with credit read only through the private capture', async () => {
  const credit = 'fixture_credit_only_for_retry'
  let captured: string | undefined
  let metadata: RefusalFallbackStreamRefusal | undefined
  const source = protectFallbackCreditResponse(
    response(
      start(sourceModel, {
        input_tokens: 11,
        output_tokens: 1,
        cache_read_input_tokens: 7,
      }),
      text(0),
      blockStop(0),
      refused({
        fallback_credit_token: credit,
        fallback_has_prefill_claim: true,
      }),
      stop,
    ),
    {
      requestHeaders: creditHeaders,
      onRefusalCredit(value) {
        captured = value
      },
    },
  )
  const output = joinRefusalFallbackStream(source, {
    ...baseOptions,
    takeSourceRefusalCredit() {
      const value = captured
      captured = undefined
      return value
    },
    retry(info) {
      metadata = info
      return { kind: 'none', reason: 'test-no-target' }
    },
  })
  const result = await output.text()
  expect(metadata).toEqual({
    category: 'unknown',
    creditToken: credit,
    hasHostContent: true,
    hasPrefillClaim: true,
    usage: { input_tokens: 11, cache_read_input_tokens: 7, output_tokens: 17 },
  })
  expect(result).not.toContain(credit)
  expect(result).toEndWith(
    wire(
      refused({
        fallback_credit_token: FALLBACK_CREDIT_PLACEHOLDER,
        fallback_has_prefill_claim: true,
      }),
    ) + wire(stop),
  )
  expect(captured).toBeUndefined()
})

const refusalWithText = [
  start(sourceModel),
  refusalBlock(0),
  blockStop(0),
  text(1),
  textDelta(1, 'Source'),
  refused(),
  stop,
]
const standingWithText = [
  start(sourceModel),
  text(0),
  textDelta(0, 'Source'),
  blockStop(0),
  refusalBlock(1),
  blockStop(1),
  refused(),
  stop,
]

for (const [label, retry] of [
  ['no retry', () => ({ kind: 'none', reason: 'no-target' })],
  ['HTTP error', () => joinedRetry(new Response('error', { status: 429 }))],
  [
    'retry throws',
    () => {
      throw new Error('Attempt failed')
    },
  ],
  ['retry error event', () => joinedRetry(response(start(targetModel), error))],
  ['retry EOF', () => joinedRetry(response(start(targetModel)))],
  [
    'retry refuses behind held refusal and tool blocks',
    () =>
      joinedRetry(
        response(
          start(targetModel),
          refusalBlock(0),
          blockStop(0),
          tool(1),
          toolInput(1),
          refused(),
          stop,
        ),
      ),
  ],
] satisfies Array<[string, () => RefusalFallbackStreamRetry]>) {
  test(`${label} releases only the source refusal at the next index before its terminal frames`, async () => {
    expect(
      await events(
        joinRefusalFallbackStream(response(...refusalWithText), {
          ...baseOptions,
          retry,
        }),
      ),
    ).toEqual(standingWithText)
  })
}

test('a non-refusing end_turn releases a refusal block before its unchanged message_delta', async () => {
  const output = joinRefusalFallbackStream(
    response(
      start(targetModel),
      refusalBlock(0),
      blockStop(0),
      tool(1),
      toolInput(1),
      text(2),
      textDelta(2, 'Visible'),
      blockStop(2),
      endTurn,
      stop,
    ),
    baseOptions,
  )
  expect(await events(output)).toEqual(
    [
      start(sourceModel),
      text(0),
      textDelta(0, 'Visible'),
      blockStop(0),
      refusalBlock(1),
      blockStop(1),
      endTurn,
      stop,
    ].map((frame) =>
      frame.type === 'message_start'
        ? {
            ...frame,
            message: { id: `msg_${targetModel}`, model: sourceModel },
          }
        : frame,
    ),
  )
})

for (const fresh of [true, false]) {
  test(`${fresh ? 'non-stale' : 'stale'} refusal after a released tool`, async () => {
    let retries = 0
    const source = response(
      start(sourceModel),
      tool(0),
      toolInput(0),
      blockStop(0),
      tool(1, 'unfinished'),
      toolInput(1),
      refusalBlock(2),
      blockStop(2),
      thinking(3),
      blockDelta(3, 'thinking_delta', { thinking: 'Open' }),
      refused(),
      stop,
    )
    expect(
      await events(
        joinRefusalFallbackStream(source, {
          ...baseOptions,
          isFresh: () => fresh,
          retry: () => {
            retries++
            return { kind: 'none', reason: 'not-expected' }
          },
        }),
      ),
    ).toEqual([
      start(sourceModel),
      tool(0),
      toolInput(0),
      blockStop(0),
      thinking(1),
      blockDelta(1, 'thinking_delta', { thinking: 'Open' }),
      blockStop(1),
      ...(fresh
        ? [{ ...refused(), delta: { stop_reason: 'tool_use' } }]
        : [refusalBlock(2), blockStop(2), refused()]),
      stop,
    ])
    expect(retries).toBe(0)
  })
}

test('rechecks freshness at the first retry tool release and cancels without exposing it', async () => {
  const target = feed()
  const entered = Promise.withResolvers<AbortSignal>()
  let fresh = true
  const output = events(
    joinRefusalFallbackStream(response(...refusalWithText), {
      ...baseOptions,
      isFresh: () => fresh,
      retry(_refusal, signal) {
        entered.resolve(signal)
        return joinedRetry(target.response)
      },
    }),
  )
  const signal = await entered.promise
  target.push(start(targetModel), tool(0), toolInput(0))
  await Bun.sleep(0)
  fresh = false
  target.push(blockStop(0))
  expect(await output).toEqual(standingWithText)
  expect(signal.aborted).toBe(true)
  expect(target.cancelled).toBe(true)
})

for (const releasedTool of [true, false]) {
  test(`a retry refusal after visible ${releasedTool ? 'tool' : 'text'} never replays the source`, async () => {
    const targetBlocks = releasedTool
      ? [tool(0), toolInput(0), blockStop(0)]
      : [text(0), textDelta(0, 'Retry'), blockStop(0)]
    const targetFrames = [
      start(targetModel),
      ...targetBlocks,
      refusalBlock(1),
      blockStop(1),
      refused(),
      stop,
    ]
    const output = joinRefusalFallbackStream(
      response(start(sourceModel), refused(), stop),
      {
        ...baseOptions,
        retry: () => joinedRetry(response(...targetFrames)),
      },
    )
    expect(await events(output)).toEqual([
      start(sourceModel),
      ...targetBlocks,
      ...(releasedTool ? [] : [refusalBlock(1), blockStop(1)]),
      {
        ...refused(),
        delta: releasedTool ? { stop_reason: 'tool_use' } : refused().delta,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 17,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
      stop,
    ])
  })
}

test('upstream and 30-second synthetic pings pass inside an open text block only while a frame is held', async () => {
  const upstream = feed()
  const clock = manualClock()
  const reader = joinRefusalFallbackStream(upstream.response, {
    ...baseOptions,
    clock,
  }).body!.getReader()
  upstream.push(start(sourceModel))
  expect(await readChunk(reader)).toBe(wire(start(sourceModel)))
  const firstText = readChunk(reader)
  await Bun.sleep(0)
  expect(clock.scheduled).toBe(0)
  clock.advance(60_000)
  upstream.push(refusalBlock(0), blockStop(0), text(1))
  expect(await firstText).toBe(wire(text(0)))
  const next = readChunk(reader)
  await Bun.sleep(0)
  expect(clock.scheduled).toBe(1)
  clock.advance(20_000)
  upstream.push(ping)
  expect(await next).toBe(wire(ping))
  const heartbeat = readChunk(reader)
  await Bun.sleep(0)
  clock.advance(29_999)
  expect(clock.scheduled).toBe(1)
  clock.advance(1)
  expect(await heartbeat).toBe(wire(ping))
  upstream.push(textDelta(1, 'Still open'), blockStop(1), endTurn, stop)
  upstream.close()
  expect(await readChunk(reader)).toBe(wire(textDelta(0, 'Still open')))
  expect(await readChunk(reader)).toBe(wire(blockStop(0)))
  expect(await readChunk(reader)).toBe(
    [refusalBlock(1), blockStop(1), endTurn].map(wire).join(''),
  )
  expect(await readChunk(reader)).toBe(wire(stop))
  expect((await reader.read()).done).toBe(true)
  expect(clock.scheduled).toBe(0)
})

test('the 30-second keep-alive stays active for a held refused terminal pair until host abort', async () => {
  const clock = manualClock()
  const host = new AbortController()
  const entered = Promise.withResolvers<AbortSignal>()
  const outcome = Promise.withResolvers<RefusalFallbackStreamRetry>()
  const reader = joinRefusalFallbackStream(
    response(start(sourceModel), refused(), stop),
    {
      ...baseOptions,
      clock,
      signal: host.signal,
      retry(_refusal, signal) {
        entered.resolve(signal)
        return outcome.promise
      },
    },
  ).body!.getReader()
  expect(await readChunk(reader)).toBe(wire(start(sourceModel)))
  const next = readChunk(reader)
  const retrySignal = await entered.promise
  clock.advance(30_000)
  expect(await next).toBe(wire(ping))
  const abortedRead = reader.read()
  host.abort(new Error('Host stopped'))
  await expect(abortedRead).rejects.toThrow('Host stopped')
  expect(retrySignal.aborted).toBe(true)
  expect(clock.scheduled).toBe(0)
  const lateRetry = feed()
  outcome.resolve(joinedRetry(lateRetry.response))
  await Bun.sleep(0)
  expect(lateRetry.cancelled).toBe(true)
})

for (const committed of [false, true]) {
  test(`aggregate retry hold overflow ${committed ? 'after' : 'before'} content`, async () => {
    const target = response(
      start(targetModel),
      ...(committed ? [text(0), blockStop(0)] : []),
      tool(3),
      toolInput(3, 'x'.repeat(125)),
      refusalBlock(4),
      toolInput(3, 'y'.repeat(125)),
    )
    const output = joinRefusalFallbackStream(response(...refusalWithText), {
      ...baseOptions,
      maxPendingBytes: 512,
      retry: () => joinedRetry(target),
    })
    if (committed)
      await expect(events(output)).rejects.toBeInstanceOf(
        FallbackCreditResponseTooLargeError,
      )
    else expect(await events(output)).toEqual(standingWithText)
  })
}
