import { afterEach, expect, test } from 'bun:test'
import { __setLogTestSink, type LogTestRecord } from '../logger.ts'
import {
  copyStreamResponseTiming,
  createAnthropicStreamCompletion,
  safeIncompleteStreamDiagnostics,
} from '../stream-completion.ts'

afterEach(() => __setLogTestSink(null))

test('physical Content-Length survives wrappers that remove the body length header', () => {
  const source = new Response('', { headers: { 'content-length': '0' } })
  copyStreamResponseTiming(source, source, performance.now())
  const wrapped = copyStreamResponseTiming(source, new Response(''))
  const error = createAnthropicStreamCompletion(wrapped).finish()
  expect(error?.diagnostics.response_headers).toEqual({
    'content-length': '0',
  })
})

test.each(['\n', '\r', '\r\n'])(
  'a complete message_stop survives byte-split %j framing',
  (ending) => {
    const completion = createAnthropicStreamCompletion(new Response(''))
    const bytes = new TextEncoder().encode(
      `data: {"type":"message_stop"}${ending}${ending}`,
    )
    for (const byte of bytes) completion.push(Uint8Array.of(byte))
    expect(completion.finish()).toBeUndefined()
  },
)

test.each(['\n', '\r', '\r\n'])(
  'a complete error is a terminal failure with byte-split %j framing',
  (ending) => {
    const completion = createAnthropicStreamCompletion(new Response(''))
    const bytes = new TextEncoder().encode(
      `event: error${ending}data: {"type":"error","error":{"type":"relay_upstream_error","status":401,"message":"Relay upstream returned HTTP 401"}}${ending}${ending}`,
    )
    for (const byte of bytes) completion.push(Uint8Array.of(byte))
    expect(completion.finish()).toBeUndefined()
  },
)

test.each([
  'event: error\ndata: {"type":"error","error":',
  'event: error\ndata: {"type":"error","error":{"type":"authentication_error"}}\n',
])('an incomplete error frame is not terminal: %j', (frame) => {
  const completion = createAnthropicStreamCompletion(new Response(''))
  completion.push(new TextEncoder().encode(frame))
  expect(completion.finish()).toMatchObject({ code: 'ECONNRESET' })
})

test('incomplete diagnostics retain only fixed headers and byte/event counts', () => {
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  const source = new Response('', {
    headers: {
      'request-id': 'private prompt',
      'cf-ray': 'private prompt',
      'content-type': 'text/event-stream; private prompt',
      'content-encoding': 'private prompt',
      'content-length': 'private prompt',
      authorization: 'private prompt',
    },
  })
  const response = copyStreamResponseTiming(
    source,
    new Response('', { headers: source.headers }),
    performance.now(),
  )
  const completion = createAnthropicStreamCompletion(response)
  const bytes = new TextEncoder().encode(
    ': heartbeat\n\ndata: {"type":"ping"}\n\ndata: {"type":"message_stop"}\n',
  )
  completion.push(bytes)
  const error = completion.finish()
  expect(error).toMatchObject({
    code: 'ECONNRESET',
    diagnostics: {
      response_headers: {},
      response_bytes: bytes.byteLength,
      sse_events: 1,
      send_to_headers_ms: expect.any(Number),
      headers_to_eof_ms: expect.any(Number),
    },
  })
  expect(records).toHaveLength(1)
  expect(JSON.stringify([error?.diagnostics, records])).not.toContain(
    'private prompt',
  )
  expect(
    safeIncompleteStreamDiagnostics({
      ...error!.diagnostics,
      response_headers: { authorization: 'private prompt' },
      response_bytes: -1,
      sse_events: Infinity,
    }),
  ).toMatchObject({ response_headers: {}, response_bytes: 0, sse_events: 0 })
})
