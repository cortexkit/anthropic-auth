import { expect, test } from 'bun:test'
import { extractBillingHeaderCCH, signRequestBody } from '../cch.ts'
import {
  createFallbackResponseHold,
  FALLBACK_CREDIT_PLACEHOLDER,
  FallbackCreditResponseTooLargeError,
  protectFallbackCreditResponse,
  withoutFallbackCredit,
} from '../fallback-credit.ts'
import { sendViaRelay } from '../relay.ts'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback-usage.ts'
import { DEFAULT_SSE_MAX_FRAME_BYTES } from '../sse.ts'

const credit = 'sentinel_one_use_credit_4cf162b9'
const content = 'sentinel_private_reply_f532100c'
const headers = new Headers({
  'anthropic-beta': `some-other-beta, ${SERVER_SIDE_FALLBACK_BETA}`,
})
const encoder = new TextEncoder()
const frame = (value: Record<string, unknown>) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`

function stream(...chunks: Array<string | Uint8Array>) {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk === undefined) controller.close()
        else
          controller.enqueue(
            typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
          )
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

test('a split refusal frame gives a credit only to the splice, not to host bytes', async () => {
  const captured: string[] = []
  const regular = frame({
    type: 'content_block_delta',
    delta: { text: content },
  }).replaceAll('\n', '\r\n')
  const other = frame({
    type: 'ping',
    nested: { fallback_credit_token: 'not-a-refusal' },
  })
  const refusal = frame({
    type: 'message_delta',
    delta: {
      stop_reason: 'refusal',
      stop_details: { fallback_credit_token: credit },
    },
    echo: `the credit was ${credit}`,
  })
  const error = frame({
    type: 'error',
    error: { message: `rejected ${credit}` },
  })
  const split = refusal.indexOf(credit) + 4
  const response = protectFallbackCreditResponse(
    stream(
      regular + other + refusal.slice(0, split),
      refusal.slice(split),
      error,
    ),
    {
      requestHeaders: headers,
      onRefusalCredit: (value) => captured.push(value),
    },
  )
  const host = await response.text()
  expect(host.startsWith(regular)).toBe(true)
  expect(host).toContain(
    `"fallback_credit_token":"${FALLBACK_CREDIT_PLACEHOLDER}"`,
  )
  expect(host).toContain(`rejected ${FALLBACK_CREDIT_PLACEHOLDER}`)
  expect(host).not.toContain(credit)
  expect(host).not.toContain('not-a-refusal')
  expect(captured).toEqual([credit])
  expect(JSON.stringify(captured)).not.toContain(content)
})

test.each([200, 400])(
  'JSON status %i redacts an escaped nested property and echoes',
  async (status) => {
    const escapedCredit = credit.replace('s', '\\u0073')
    const raw = `{"error":{"message":"rejected ${escapedCredit}"},"items":[{"\\u0066allback_credit_token":"${credit}"}],"fallback_credit_token":null}`
    const response = protectFallbackCreditResponse(
      new Response(raw, {
        status,
        headers: { 'content-type': 'application/json' },
      }),
      { requestHeaders: headers, framing: 'event-stream' },
    )
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({
      error: { message: `rejected ${FALLBACK_CREDIT_PLACEHOLDER}` },
      items: [{ fallback_credit_token: FALLBACK_CREDIT_PLACEHOLDER }],
      fallback_credit_token: FALLBACK_CREDIT_PLACEHOLDER,
    })
  },
)

test('a token-bearing request scrubs a target error echo even without the beta', async () => {
  const response = protectFallbackCreditResponse(
    Response.json(
      {
        type: 'error',
        error: {
          message: `fallback_credit_token: is not valid for model (${credit})`,
        },
      },
      { status: 400 },
    ),
    {
      requestHeaders: new Headers(),
      requestBodyText: JSON.stringify({ fallback_credit_token: credit }),
    },
  )
  expect(await response.json()).toEqual({
    type: 'error',
    error: {
      message: `fallback_credit_token: is not valid for model (${FALLBACK_CREDIT_PLACEHOLDER})`,
    },
  })
})

test('an 8 MiB token-bearing frame errors without passing any of its bytes', async () => {
  const prefix = frame({ type: 'message_start' })
  const huge = encoder.encode(
    `data: {"fallback_credit_token":"${credit}","padding":"${'x'.repeat(DEFAULT_SSE_MAX_FRAME_BYTES)}"}\n\n`,
  )
  const response = protectFallbackCreditResponse(stream(prefix, huge), {
    requestHeaders: headers,
  })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('missing response stream')
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(prefix)
  const error = await reader.read().catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(FallbackCreditResponseTooLargeError)
  expect(error).toMatchObject({
    bound: 'frame',
    maxBytes: DEFAULT_SSE_MAX_FRAME_BYTES,
  })
  expect(String(error)).not.toContain(credit)
})

test('EOF drops a truncated credit frame, not a complete frame with bare CR endings', async () => {
  const ping = frame({ type: 'ping' }).replaceAll('\n', '\r')
  const truncated = frame({
    type: 'message_delta',
    fallback_credit_token: credit,
  }).slice(0, -1)
  expect(
    await protectFallbackCreditResponse(stream(ping), {
      requestHeaders: headers,
    }).text(),
  ).toBe(ping)
  expect(
    await protectFallbackCreditResponse(stream(ping, truncated), {
      requestHeaders: headers,
    }).text(),
  ).toBe(ping)
})

test('the per-response hold counts many small tool frames and drops all held groups on overflow', () => {
  const start = frame({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use' },
  })
  const delta = frame({
    type: 'content_block_delta',
    index: 1,
    delta: { partial_json: content },
  })
  const refusal = frame({
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'refusal' },
  })
  const count = 16
  const limit = encoder.encode(start + delta.repeat(count) + refusal).length
  const hold = createFallbackResponseHold<string>(limit)
  hold.hold('complete', start, encoder.encode(start).length)
  expect(hold.release('complete')).toEqual([start])
  expect(hold.bytes).toBe(0)
  hold.hold('tool:1', start, encoder.encode(start).length)
  for (let index = 0; index < count; index++)
    hold.hold('tool:1', delta, encoder.encode(delta).length)
  hold.hold('refusal:2', refusal, encoder.encode(refusal).length)
  expect(hold.bytes).toBe(limit)
  expect(() =>
    hold.hold('tool:1', delta, encoder.encode(delta).length),
  ).toThrow(FallbackCreditResponseTooLargeError)
  expect(hold.release('tool:1')).toEqual([])
  expect(hold.release('refusal:2')).toEqual([])
  expect(hold.bytes).toBe(0)
})

test('the outbound observer view deletes the credential and re-signs the body', async () => {
  const system = [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=cli; cch=00000;',
    },
  ]
  const payload = {
    model: 'claude-opus-5',
    system,
    messages: [{ role: 'user', content }],
  }
  const signed = await signRequestBody(
    JSON.stringify({ ...payload, fallback_credit_token: credit }),
  )
  const view = await withoutFallbackCredit(signed)
  expect(view).toBe(await signRequestBody(JSON.stringify(payload)))
  expect(extractBillingHeaderCCH(view)).not.toBe(
    extractBillingHeaderCCH(signed),
  )
  expect(view).not.toContain(credit)
  expect(view).toContain(content)
})

test.each([
  ['http', false],
  ['http', true],
  ['websocket', false],
  ['websocket', true],
] as const)(
  'credited requests never enter %s relay authorization (direct allowed: %s)',
  async (transport, fallbackToDirect) => {
    let direct = 0
    let relayed = 0
    const send = sendViaRelay({
      config: {
        enabled: true,
        url: 'https://relay.example.invalid',
        token: 'relay-test',
        transport,
        fallbackToDirect,
      },
      input: 'https://api.anthropic.com/v1/messages',
      init: { method: 'POST' },
      headers,
      body: JSON.stringify({ fallback_credit_token: credit }),
      affinity: 'credit-once',
      authorizeAttempt: () => {
        relayed++
        throw new Error('relay authorization must not run')
      },
      fallback: async () => {
        direct++
        return Response.json({ route: 'direct' })
      },
    })
    if (fallbackToDirect)
      expect(await (await send).json()).toEqual({ route: 'direct' })
    else
      await expect(send).rejects.toThrow(
        'Fallback credit cannot be sent through the relay',
      )
    expect(relayed).toBe(0)
    expect(direct).toBe(Number(fallbackToDirect))
  },
)
