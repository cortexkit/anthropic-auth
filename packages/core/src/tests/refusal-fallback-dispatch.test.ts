import { expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import {
  extractBillingHeaderCCH,
  hasValidRequestBodySignature,
  signRequestBody,
} from '../cch.ts'
import { FALLBACK_CREDIT_PLACEHOLDER } from '../fallback-credit.ts'
import {
  dispatchRefusalFallback,
  type RefusalFallbackDispatchOptions,
} from '../refusal-fallback-dispatch.ts'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback-usage.ts'

const fable = 'claude-fable-5-2'
const opus5 = 'claude-opus-5'
const opus48 = 'claude-opus-4-8'
const credit = 'private_credit_sentinel_731'
const binding = {
  accountId: 'account',
  credentialId: 'binding-1',
  url: 'https://gateway.example/v1/messages',
}
const billingText =
  'x-anthropic-billing-header: cc_version=test; cc_entrypoint=test; cch=00000;'
const input = {
  model: fable,
  system: [
    {
      type: 'text',
      text: billingText,
    },
  ],
  messages: [{ role: 'user', content: '☃' }],
  max_tokens: 200_000,
  stream: true,
  metadata: { user_id: 'source-shaped' },
  thinking: { type: 'adaptive' },
}
const start = (
  model: string,
  usage: Record<string, unknown> = { input_tokens: 12 },
) => ({
  type: 'message_start',
  message: { model, usage },
})
const stop = { type: 'message_stop' }
const end = (output = 7) => ({
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: output },
})
const refuse = (token: string | null = credit, claim = true) => ({
  type: 'message_delta',
  delta: {
    stop_reason: 'refusal',
    stop_details: {
      type: 'refusal',
      category: 'cyber',
      fallback_credit_token: token,
      fallback_has_prefill_claim: claim,
    },
  },
  usage: { output_tokens: 4 },
})
const block = (index: number, content_block: Record<string, unknown>) => ({
  type: 'content_block_start',
  index,
  content_block,
})
const delta = (index: number, delta: Record<string, unknown>) => ({
  type: 'content_block_delta',
  index,
  delta,
})
const close = (index: number) => ({ type: 'content_block_stop', index })
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
const headers = { 'content-type': 'text/event-stream' }
const stream = (...events: unknown[]) =>
  new Response(events.map(sse).join(''), { headers })
const origin = (...content: unknown[]) =>
  stream(start(fable), ...content, refuse(), stop)
const accepted = () =>
  stream(
    start(opus48, { input_tokens: 21, cache_read_input_tokens: 7 }),
    block(0, { type: 'text', text: 'answer' }),
    close(0),
    end(),
    stop,
  )
const rejected = (message: string, status = 400) =>
  Response.json(
    { type: 'error', error: { type: 'invalid_request_error', message } },
    { status },
  )
const wrongModel = 'fallback_credit_token: is not valid for model'

async function setup(
  overrides: Partial<RefusalFallbackDispatchOptions['origin']> = {},
) {
  const sends: Parameters<RefusalFallbackDispatchOptions['send']>[0][] = []
  const admissions: string[] = []
  const replies: (() => Response | Promise<Response>)[] = []
  const reports: Parameters<
    NonNullable<RefusalFallbackDispatchOptions['onBillingReport']>
  >[] = []
  const options: RefusalFallbackDispatchOptions = {
    sourceModel: fable,
    origin: {
      ...binding,
      bodyText: await signRequestBody(JSON.stringify(input)),
      headers: new Headers({
        authorization: 'Bearer source-bearer',
        'content-type': 'application/json',
        'anthropic-beta': `${SERVER_SIDE_FALLBACK_BETA},per-turn-control-test`,
        'x-client-request-id': 'request-id',
      }),
      ...overrides,
    },
    isFresh: () => true,
    authorize: ({ model, wait, origin }) => {
      admissions.push(model)
      expect(wait).toBe(false)
      expect(origin).toEqual(binding)
      return { kind: 'authorized', ...binding, accessToken: 'fresh-bearer' }
    },
    async send(send) {
      sends.push(send)
      return await (replies.shift()?.() ?? accepted())
    },
    billing: {
      sessionId: 'session',
      requestKind: 'primary',
    },
    onBillingReport: (...report) => reports.push(report),
  }
  return { options, sends, replies, admissions, reports }
}

function at<T>(list: T[], index = 0): T {
  const value = list[index]
  if (value === undefined) throw new Error(`No test result at index ${index}`)
  return value
}

function assertStandingRefusal(text: string) {
  expect(text.match(/"stop_reason":"refusal"/g)).toHaveLength(1)
  expect(text.match(/"type":"message_stop"/g)).toHaveLength(1)
  expect(text).not.toContain(credit)
  expect(text).not.toContain('retry-only')
  expect(text).toContain(FALLBACK_CREDIT_PLACEHOLDER)
}

test('credited retry changes only the permitted wire fields and bills both physical models', async () => {
  const raw = JSON.stringify({ ...input, fallbacks: 'default' }).replace(
    '"content":"☃"',
    '"content": "\\u2603"',
  )
  const bodyText = await signRequestBody(raw)
  const { options, sends, reports } = await setup({ bodyText })
  let reusable = ''
  let observedRetry: unknown
  const committed: unknown[] = []
  options.observePhysicalResponse = (response, attempt, body) => {
    if (attempt.refusalRetry) {
      reusable = body ?? ''
      observedRetry = attempt
    }
    return response
  }
  options.onRetryCommitted = ({ model, attempt }) => {
    committed.push({ model, attempt })
    throw new Error('Observer failures cannot break the answer')
  }
  const output = await dispatchRefusalFallback(origin(), options).text()
  expect(output).toContain('answer')
  expect(output).not.toContain('refusal')
  expect(committed).toEqual([{ model: opus48, attempt: observedRetry }])
  expect((committed[0] as { attempt: unknown }).attempt).toBe(observedRetry)
  expect(sends).toHaveLength(1)
  const send = at(sends)
  expect(send.url).toBe(binding.url)
  const expectedHeaders = new Headers(options.origin.headers)
  expectedHeaders.set('authorization', 'Bearer fresh-bearer')
  expect([...send.headers]).toEqual([...expectedHeaders])
  const expected = {
    ...input,
    model: opus48,
    max_tokens: 128_000,
    fallback_credit_token: credit,
  }
  const final = JSON.parse(send.bodyText)
  expect(final).toEqual({ ...expected, system: final.system })
  expect(final.system[0].text).toBe(
    billingText.replace('00000', extractBillingHeaderCCH(send.bodyText) ?? ''),
  )
  expect(send.bodyText).toContain('"content": "\\u2603"')
  expect(await hasValidRequestBodySignature(bodyText)).toBe(true)
  expect(await hasValidRequestBodySignature(send.bodyText)).toBe(true)
  expect(await hasValidRequestBodySignature(reusable)).toBe(true)
  expect(JSON.parse(reusable)).not.toHaveProperty('fallback_credit_token')
  await Bun.sleep(10)
  expect(reports).toHaveLength(2)
  expect(reports[0]).toMatchObject([
    {
      model: fable,
      attempt: 1,
      usage: { input: 12, output: 4 },
      outcome: 'completed',
    },
    { refusalRetry: false },
  ])
  expect(reports[1]).toMatchObject([
    {
      model: opus48,
      attempt: 2,
      usage: { input: 21, output: 7, cacheRead: 7 },
    },
    { refusalRetry: true, paysCacheWrite: false },
  ])
  expect(at(reports)[0].attemptId).not.toBe(at(reports, 1)[0].attemptId)
  expect(JSON.stringify(reports)).not.toContain(credit)
})

test('a retry that refuses before content does not announce a serving model', async () => {
  const { options, replies, sends } = await setup()
  const committed: unknown[] = []
  options.onRetryCommitted = (info) => committed.push(info)
  replies.push(() => stream(start(opus48), refuse(null, false), stop))
  assertStandingRefusal(await dispatchRefusalFallback(origin(), options).text())
  expect(sends).toHaveLength(1)
  expect(committed).toEqual([])
})

test('claimed prefill copies closed signed blocks and synthetically closed text', async () => {
  const { options, sends } = await setup()
  const response = origin(
    block(0, { type: 'thinking', thinking: '' }),
    delta(0, { type: 'thinking_delta', thinking: 'signed thought' }),
    delta(0, { type: 'signature_delta', signature: 'signed' }),
    close(0),
    block(2, { type: 'redacted_thinking', data: 'opaque-signed-data' }),
    close(2),
    block(3, { type: 'text', text: 'closed' }),
    close(3),
    block(5, { type: 'text', text: 'part' }),
    delta(5, { type: 'text_delta', text: 'ial' }),
  )
  expect(await dispatchRefusalFallback(response, options).text()).not.toContain(
    'refusal',
  )
  expect(sends).toHaveLength(1)
  expect(JSON.parse(at(sends).bodyText).messages).toEqual([
    ...input.messages,
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'signed thought', signature: 'signed' },
        { type: 'redacted_thinking', data: 'opaque-signed-data' },
        { type: 'text', text: 'closed' },
        { type: 'text', text: 'partial' },
      ],
    },
  ])
  expect(await hasValidRequestBodySignature(at(sends).bodyText)).toBe(true)
})

const signedThought = { type: 'thinking', thinking: 'first', signature: 'sig' }
const inlineText = { type: 'text', text: 'inline answer prefix' }

test.each([
  [
    'unsigned thinking after signed thinking',
    start(fable),
    [block(1, { type: 'thinking', thinking: 'unsigned' }), close(1)],
    'unsigned',
  ],
  [
    'unclosed thinking after signed thinking',
    start(fable),
    [block(1, { type: 'thinking', thinking: 'unclosed', signature: 'sig' })],
    'unclosed',
  ],
  [
    'inline message-start content before signed thinking',
    {
      ...start(fable),
      message: { ...start(fable).message, content: [inlineText] },
    },
    [],
    inlineText.text,
  ],
] as const)(
  'defers a credited refusal with %s',
  async (_label, message, tail, visible) => {
    const { options, sends } = await setup()
    const deferred: string[] = []
    options.lifecycle = {
      onDeferredRefusal: ({ category }) => deferred.push(category ?? ''),
    }
    const output = await dispatchRefusalFallback(
      stream(
        message,
        block(0, signedThought),
        close(0),
        ...tail,
        refuse(),
        stop,
      ),
      options,
    ).text()
    expect(output).toContain(visible)
    assertStandingRefusal(output)
    expect(sends).toHaveLength(0)
    expect(deferred).toEqual(['cyber'])
  },
)

test('defers a credited refusal with only inline message-start content', async () => {
  const { options, sends } = await setup()
  const deferred: string[] = []
  options.lifecycle = {
    onDeferredRefusal: ({ category }) => deferred.push(category ?? ''),
  }
  const message = { ...start(fable).message, content: [inlineText] }
  const output = await dispatchRefusalFallback(
    stream({ type: 'message_start', message }, refuse(), stop),
    options,
  ).text()
  expect(output).toContain(JSON.stringify(message))
  assertStandingRefusal(output)
  expect(sends).toHaveLength(0)
  expect(deferred).toEqual(['cyber'])
})

test.each([
  ['no claim', credit, false, { type: 'text', text: 'The result is ' }],
  ['cold refusal', null, true, { type: 'text', text: 'The result is ' }],
  [
    'no eligible block',
    credit,
    true,
    { type: 'thinking', thinking: 'unsigned' },
  ],
] as const)(
  '%s leaves the refusal standing after visible content without a continuation',
  async (_label, token, claim, content) => {
    const { options, sends } = await setup()
    const response = stream(
      start(fable),
      block(0, content),
      close(0),
      refuse(token, claim),
      stop,
    )
    const output = await dispatchRefusalFallback(response, options).text()
    expect(output).toContain(JSON.stringify(content))
    expect(output).toContain('"stop_reason":"refusal"')
    expect(output).not.toContain('answer')
    expect(sends).toHaveLength(0)
  },
)

test('refused continuation sends full source shape as a target create', async () => {
  const short = {
    ...input,
    messages: [{ role: 'user', content: 'tail' }],
    thread: { type: 'continue', previous_message_id: 'source-thread' },
  }
  const full = {
    ...input,
    messages: [
      ...input.messages,
      { role: 'assistant', content: 'prior reply' },
      ...short.messages,
    ],
  }
  const { options, sends } = await setup({
    bodyText: await signRequestBody(JSON.stringify(short)),
    fullBodyText: JSON.stringify(full),
  })
  await dispatchRefusalFallback(origin(), options).text()
  expect(sends).toHaveLength(1)
  const { system, ...rest } = JSON.parse(at(sends).bodyText)
  const { system: _fullSystem, ...expected } = full
  expect(rest).toEqual({
    ...expected,
    model: opus48,
    max_tokens: 128_000,
    fallback_credit_token: credit,
    thread: { type: 'create' },
  })
  expect(system[0].text).toStartWith('x-anthropic-billing-header:')
  expect(await hasValidRequestBodySignature(at(sends).bodyText)).toBe(true)
})

test('wrong-model credit error moves to the next target under fresh authority', async () => {
  const { options, sends, admissions, replies, reports } = await setup()
  replies.push(
    () =>
      Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `${wrongModel} ${opus48}`,
            details: { message: `Rejected credential: ${credit}` },
          },
        },
        { status: 400 },
      ),
    accepted,
  )
  let errorBody = ''
  options.observePhysicalResponse = (response) => {
    if (response.status !== 400 || !response.body) return response
    const observed = response.body.pipeThrough(
      new TransformStream({
        transform(value, controller) {
          errorBody += new TextDecoder().decode(value)
          controller.enqueue(value)
        },
      }),
    )
    return new Response(observed, response)
  }
  expect(await dispatchRefusalFallback(origin(), options).text()).toContain(
    'answer',
  )
  expect(admissions).toEqual([opus48, opus5])
  expect(sends.map(({ bodyText }) => JSON.parse(bodyText).model)).toEqual([
    opus48,
    opus5,
  ])
  expect(
    sends.map(({ bodyText }) => JSON.parse(bodyText).fallback_credit_token),
  ).toEqual([credit, credit])
  expect(errorBody).toContain(FALLBACK_CREDIT_PLACEHOLDER)
  expect(errorBody).not.toContain(credit)
  await Bun.sleep(10)
  expect(reports.map(([report]) => [report.model, report.outcome])).toEqual([
    [fable, 'completed'],
    [opus48, 'failed'],
    [opus5, 'completed'],
  ])
})

test('exhausted unchanged targets get one folded retry on the first unused model', async () => {
  const marker = {
    role: 'system',
    content: [],
    output_config: { effort: 'low' },
  }
  const bodyText = await signRequestBody(
    JSON.stringify({ ...input, messages: [marker, ...input.messages] }),
  )
  const { options, sends, admissions, replies, reports } = await setup({
    bodyText,
  })
  replies.push(
    () => rejected(wrongModel),
    () =>
      stream(
        start(opus48, {
          input_tokens: 12,
          cache_creation: { ephemeral_1h_input_tokens: 3 },
        }),
        {
          ...end(),
          usage: {
            output_tokens: 7,
            cache_creation: { ephemeral_5m_input_tokens: 2 },
          },
        },
        stop,
      ),
  )
  const output = await dispatchRefusalFallback(origin(), options).text()
  expect(output).not.toContain('refusal')
  expect(admissions).toEqual([opus5, opus48])
  expect(sends).toHaveLength(2)
  expect(JSON.parse(at(sends).bodyText)).toMatchObject({
    model: opus5,
    fallback_credit_token: credit,
  })
  const folded = JSON.parse(at(sends, 1).bodyText)
  expect(folded).toMatchObject({
    model: opus48,
    output_config: { effort: 'low' },
  })
  expect(folded.messages).toEqual(input.messages)
  expect(folded).not.toHaveProperty('fallback_credit_token')
  expect(await hasValidRequestBodySignature(at(sends, 1).bodyText)).toBe(true)
  await Bun.sleep(10)
  expect(reports[2]).toMatchObject([
    {
      model: opus48,
      attempt: 3,
      usage: { cacheWrite: 5, cacheWrite5m: 2, cacheWrite1h: 3 },
    },
    { refusalRetry: true, paysCacheWrite: true, folded: true },
  ])
})

test('a folded target cannot restart an already visible answer', async () => {
  const marker = {
    role: 'system',
    content: [],
    output_config: { effort: 'low' },
  }
  const { options, sends, replies } = await setup({
    bodyText: JSON.stringify({
      ...input,
      messages: [marker, ...input.messages],
    }),
  })
  replies.push(() => rejected(wrongModel))
  const output = await dispatchRefusalFallback(
    origin(block(0, { type: 'text', text: 'source text' }), close(0)),
    options,
  ).text()
  assertStandingRefusal(output)
  expect(output).toContain('source text')
  expect(output).not.toContain('answer')
  expect(sends.map(({ bodyText }) => JSON.parse(bodyText).model)).toEqual([
    opus5,
  ])
  expect(JSON.parse(at(sends).bodyText).messages.at(-1)).toEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'source text' }],
  })
})

test('only the serving row waits for the retry CacheKeep template', async () => {
  const { options, reports } = await setup()
  const publication = Promise.withResolvers<void>()
  const sourceReported = Promise.withResolvers<void>()
  const warming = { on: true as const }
  let warmed = false
  let completed = false
  options.billing.cacheWarming = () => (warmed ? warming : undefined)
  options.billing.cacheWarmingAfter = () => publication.promise
  options.lifecycle = {
    cacheKeepTemplateSettled: publication.promise,
    onRetryCompleted() {
      completed = true
    },
  }
  const report = options.onBillingReport
  options.onBillingReport = (...args) => {
    report?.(...args)
    if (!args[1].refusalRetry) sourceReported.resolve()
  }
  expect(await dispatchRefusalFallback(origin(), options).text()).toContain(
    'answer',
  )
  expect(completed).toBe(true)
  await sourceReported.promise
  warmed = true
  publication.resolve()
  await Bun.sleep(10)
  expect(reports.map(([row]) => [row.model, row.cache?.warming])).toEqual([
    [fable, undefined],
    [opus48, warming],
  ])
})

test('the billing row for a bodyless credited 204 never sees the sent credit', async () => {
  const { options, reports, replies, sends } = await setup()
  replies.push(
    () =>
      new Response(null, {
        status: 204,
        headers: { 'request-id': `gateway-echo-${credit}` },
      }),
  )
  assertStandingRefusal(await dispatchRefusalFallback(origin(), options).text())
  expect(JSON.parse(at(sends).bodyText).fallback_credit_token).toBe(credit)
  await Bun.sleep(10)
  expect(reports).toHaveLength(2)
  expect(at(reports, 1)[0]).toMatchObject({
    model: opus48,
    status: 204,
    providerRequestId: `gateway-echo-${FALLBACK_CREDIT_PLACEHOLDER}`,
  })
  expect(JSON.stringify(reports)).not.toContain(credit)
})

test.each([
  ['admission denial', { kind: 'denied' }],
  ['wait decision', { kind: 'wait' }],
  [
    'same-account credential replacement',
    {
      kind: 'authorized',
      ...binding,
      credentialId: 'binding-2',
      accessToken: 'fresh',
    },
  ],
  [
    'account change',
    {
      kind: 'authorized',
      ...binding,
      accountId: 'other-account',
      accessToken: 'fresh',
    },
  ],
  [
    'gateway change',
    {
      kind: 'authorized',
      ...binding,
      url: 'https://other.example/v1/messages',
      accessToken: 'fresh',
    },
  ],
] as const)(
  '%s prevents even the first extra send',
  async (_label, decision) => {
    const { options, sends } = await setup()
    options.authorize = () => decision
    assertStandingRefusal(
      await dispatchRefusalFallback(origin(), options).text(),
    )
    expect(sends).toHaveLength(0)
  },
)

test('an admission denial on the next target never falls through to a folded or third send', async () => {
  const { options, sends, admissions, replies } = await setup()
  replies.push(() => rejected(wrongModel))
  const authorize = options.authorize
  options.authorize = (request) => {
    const approved = authorize(request)
    return request.model === opus5 ? { kind: 'denied' } : approved
  }
  assertStandingRefusal(await dispatchRefusalFallback(origin(), options).text())
  expect(admissions).toEqual([opus48, opus5])
  expect(sends).toHaveLength(1)
})

test.each([
  ['400 rejected prefill', () => rejected('prefill not accepted')],
  ['400 rejected token', () => rejected('fallback_credit_token: expired')],
  ['403', () => rejected('forbidden', 403)],
  ['413', () => rejected('too large', 413)],
  ['429', () => rejected('too many requests', 429)],
  [
    'SSE error',
    () =>
      stream(start(opus48), {
        type: 'error',
        error: { message: `retry-only ${credit}` },
      }),
  ],
  ['cut stream', () => stream(start(opus48))],
  [
    'retry refusal',
    () =>
      stream(
        start(opus48),
        block(0, { type: 'refusal', text: 'retry-only' }),
        close(0),
        refuse(),
        stop,
      ),
  ],
  [
    'frame overflow',
    () =>
      stream(start(opus48), block(0, { type: 'text', text: 'x'.repeat(800) })),
  ],
  [
    'hold overflow',
    () =>
      stream(
        start(opus48),
        block(0, { type: 'tool_use' }),
        ...Array.from({ length: 12 }, () =>
          delta(0, { type: 'input_json_delta', partial_json: '{' }),
        ),
      ),
  ],
] as const)(
  '%s returns exactly the original refusal without another target',
  async (_label, reply) => {
    const { options, sends, replies } = await setup()
    options.maxPendingBytes = 512
    replies.push(reply)
    assertStandingRefusal(
      await dispatchRefusalFallback(origin(), options).text(),
    )
    expect(sends).toHaveLength(1)
  },
)

test('a gzipped retry carries its final signature and is never replayed uncompressed', async () => {
  const { options, sends, replies } = await setup()
  options.origin.headers.set('content-encoding', 'gzip')
  replies.push(() => rejected('unsupported content encoding', 415))
  assertStandingRefusal(await dispatchRefusalFallback(origin(), options).text())
  expect(sends).toHaveLength(1)
  const { body, bodyText, headers } = at(sends)
  expect(headers.get('content-encoding')).toBe('gzip')
  expect(body).toBeInstanceOf(Uint8Array)
  expect(gunzipSync(body as Uint8Array).toString()).toBe(bodyText)
  expect(await hasValidRequestBodySignature(bodyText)).toBe(true)
})

test('freshness is checked at parse, after authority, after a wrong-model error, and before retry content', async () => {
  for (const when of [
    'parse',
    'authority',
    'wrong-model',
    'content',
  ] as const) {
    const { options, sends, admissions, replies } = await setup()
    let fresh = when !== 'parse'
    let canceled = false
    options.isFresh = () => fresh
    const authorize = options.authorize
    options.authorize = async (request) => {
      const decision = await authorize(request)
      if (when === 'authority') fresh = false
      return decision
    }
    if (when === 'wrong-model')
      replies.push(() => {
        fresh = false
        return rejected(wrongModel)
      })
    if (when === 'content') {
      const frames = [
        start(opus48),
        block(0, { type: 'text', text: 'retry-only' }),
      ]
      replies.push(
        () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  const frame = frames.shift()
                  if (!frame) return
                  if (frame.type === 'content_block_start') fresh = false
                  controller.enqueue(new TextEncoder().encode(sse(frame)))
                },
                cancel() {
                  canceled = true
                },
              },
              { highWaterMark: 0 },
            ),
            { headers },
          ),
      )
    }
    assertStandingRefusal(
      await dispatchRefusalFallback(origin(), options).text(),
    )
    expect(admissions).toEqual(when === 'parse' ? [] : [opus48])
    expect(sends).toHaveLength(when === 'parse' || when === 'authority' ? 0 : 1)
    if (when === 'content') {
      expect(canceled).toBe(true)
      expect(at(sends).signal.aborted).toBe(true)
    }
  }
})

test('signature invariant checks each final body rather than the original template', async () => {
  const signed = await signRequestBody(JSON.stringify(input))
  expect(await hasValidRequestBodySignature(signed)).toBe(true)
  expect(
    await hasValidRequestBodySignature(
      signed.replace('source-shaped', 'tampered'),
    ),
  ).toBe(false)
  expect(await hasValidRequestBodySignature('{}')).toBe(false)
})
