import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheKeepManager } from '../cachekeep.ts'
import { hasValidRequestBodySignature, signRequestBody } from '../cch.ts'
import { dispatchRefusalFallback } from '../refusal-fallback-dispatch.ts'
import {
  estimateRefusalFallbackInput,
  refusalFallbackEstimateBase,
} from '../refusal-fallback-prefix.ts'
import {
  RefusalFallbackRoundEngine,
  type RefusalFallbackRoundEvent,
  type RefusalFallbackRoundInput,
  type RefusalFallbackRoundPlan,
} from '../refusal-fallback-round.ts'
import { joinRefusalFallbackStream } from '../refusal-fallback-stream.ts'
import {
  RecoveryThinkingStore,
  recoveryThinkingDigest,
} from '../refusal-fallback-thinking.ts'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback-usage.ts'
import { TURN_END_NOTE_CONTENT } from '../turn-end-note.ts'

const fable = 'claude-fable-5-2'
const opus = 'claude-opus-4-8'
const binding = {
  accountId: 'A',
  credentialId: 'key-A',
  url: 'https://gateway.example/v1/messages',
}
const allowed = (): boolean => true
const oauth = { accountId: binding.accountId, targetAllowed: allowed }
const prompt = { role: 'user', content: 'Hello' }
const marker = {
  role: 'system',
  content: [],
  output_config: { effort: 'high' },
}
const body = {
  model: fable,
  stream: true,
  max_tokens: 200_000,
  messages: [prompt],
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=test; cc_entrypoint=test; cch=00000;',
    },
  ],
}
const usage = { input_tokens: 20, cache_read_input_tokens: 200 }
const completion = { stopReason: 'end_turn', usage } as const
const refusal = { category: 'cyber', releasedTool: false, usage }

function fixture(
  options?: ConstructorParameters<typeof RefusalFallbackRoundEngine>[1],
) {
  const events: RefusalFallbackRoundEvent[] = []
  const engine = new RefusalFallbackRoundEngine(
    (event) => events.push(event),
    options,
  )
  const input: RefusalFallbackRoundInput = {
    sessionId: 's',
    requestedModel: fable,
    kind: 'primary',
    mode: 'client',
    oauth,
    bodyText: JSON.stringify(body),
  }
  const plan = (overrides?: Partial<RefusalFallbackRoundInput>) =>
    engine.plan({ ...input, ...overrides })
  const send = (
    plan: RefusalFallbackRoundPlan,
    overrides?: Partial<Parameters<typeof engine.lifecycle>[1]>,
  ) => {
    const handle = plan.request
    if (!handle || !engine.markSent(handle))
      throw new Error('Expected a sendable request')
    const lifecycle = engine.lifecycle(handle, {
      isFresh: allowed,
      targetAllowed: allowed,
      ...overrides,
    })
    return { handle, lifecycle }
  }
  const begin = (
    kind: 'retry' | 'tool' | 'no-retry' = 'retry',
    start = plan(),
  ) => {
    expect(start.kind).toBe('source')
    const { lifecycle } = send(start)
    lifecycle?.onRefusal?.({ ...refusal, releasedTool: kind === 'tool' })
    if (kind === 'retry')
      lifecycle?.onRetryCompleted?.(completion, { model: opus, folded: false })
  }
  return { events, engine, input, plan, send, begin }
}

test('an idle round ends only past the last accepted primary step lifetime and advances backoff', () => {
  const ttl = 5 * 60_000
  let now = 0
  const { begin, engine, events, input, plan, send } = fixture({
    now: () => now,
  })
  begin()
  now = ttl
  const atBoundary = plan()
  expect(atBoundary.kind).toBe('round')
  send(atBoundary).lifecycle?.onCompleted?.(completion)
  now += ttl
  const title = engine.planRouted({ ...input, kind: 'title' })
  expect(title.kind).toBe('routed')
  expect(engine.markSent(title.request!)).toBe(true)
  now += 1
  const afterIdle = plan()
  expect(afterIdle.kind).toBe('source')
  expect(events.at(-1)).toMatchObject({ kind: 'round_ended', reason: 'idle' })
  begin('retry', afterIdle)
  expect(events.at(-1)).toMatchObject({ kind: 'step_served', stepsLeft: 19 })
})

test.each([
  'count',
  'idle',
  'off',
  'restart',
  'restart in off mode',
  'restart with fallback-only thinking',
  'restart after a deferred round step',
] as const)(
  'the %s return restores the ordinary kept prefix marker without replacing the tail marker',
  async (end) => {
    let now = 1
    const cache = { ...binding, accountIdentity: 'original' }
    const route = { ...oauth, cache }
    const storage = {
      version: 1 as const,
      accounts: [],
      claudeCache: { enabled: true, mode: 'hybrid' as const },
      cacheKeep: { enabled: true, always: true },
    }
    const cacheKeep = new CacheKeepManager({
      loadStorage: async () => storage,
      now: () => now,
    })
    const directory = await mkdtemp(join(tmpdir(), 'refusal-return-'))
    const thinkingStore = new RecoveryThinkingStore({ directory })
    const options = { now: () => now, cacheKeep, thinkingStore }
    const { begin, plan, send, events } = fixture(options)
    const control = { type: 'ephemeral' }
    const first = {
      role: 'user',
      content: [{ type: 'text', text: 'Hello', cache_control: control }],
    }
    const tail = {
      role: 'user',
      content: [{ type: 'text', text: 'more', cache_control: control }],
    }
    try {
      expect(
        cacheKeep.track({
          sessionId: 's',
          ...cache,
          storage,
          oauthAccountId: cache.accountId,
          oauthAccountIdentity: cache.accountIdentity,
          cacheMode: 'hybrid',
          headers: new Headers(),
          bodyText: JSON.stringify({ ...body, messages: [first] }),
        }).tracked,
      ).toBe(true)
      const extended = {
        oauth: route,
        bodyText: JSON.stringify({ ...body, messages: [prompt, tail] }),
      }
      let returned: RefusalFallbackRoundPlan
      let expectedMessages: unknown[] = [first, tail]
      if (end.startsWith('restart')) {
        const initial = plan(extended)
        const { lifecycle } = send(initial)
        lifecycle?.onRefusal?.(refusal)
        const digest = recoveryThinkingDigest(
          'thinking',
          targetThought.signature,
        )
        if (end === 'restart after a deferred round step') {
          lifecycle?.onDeferredRefusal?.(refusal)
          const step = plan(extended)
          expect(step.kind).toBe('round')
          const stepLifecycle = send(step).lifecycle
          stepLifecycle?.onThinkingDigest?.(digest)
          stepLifecycle?.onCompleted?.(completion)
        } else {
          lifecycle?.onRetryThinkingDigest?.(digest)
          lifecycle?.onRetryCompleted?.(completion, {
            model: opus,
            folded: false,
          })
          lifecycle?.onRetryFinished?.()
        }
        await thinkingStore.flush()
        const restarted = fixture({
          ...options,
          thinkingStore: new RecoveryThinkingStore({ directory }),
        })
        await restarted.engine.loadThinking('s')
        const mixed = end === 'restart' || end === 'restart in off mode'
        const afterRestart = {
          oauth: route,
          mode: end === 'restart in off mode' ? 'off' : 'client',
          bodyText: replay(
            prompt,
            mixed
              ? assistant(sourceThought, targetThought)
              : assistant(targetThought),
            tail,
          ),
        } as const
        returned = restarted.plan(afterRestart)
        expectedMessages = [
          first,
          assistant(mixed ? sourceThought : targetThought),
          tail,
        ]
        if (end === 'restart in off mode')
          expect(restarted.plan(afterRestart)).not.toHaveProperty(
            'sourceCacheMarkerRestored',
          )
        expect(restarted.events).toEqual([])
      } else {
        begin('retry', plan(extended))
        if (end === 'count') {
          for (let step = 0; step < 9; step++)
            send(plan(extended)).lifecycle?.onCompleted?.(completion)
        } else if (end === 'idle') now += 300_001
        returned = plan({ ...extended, mode: end === 'off' ? 'off' : 'client' })
        expect(events.at(-1)).toMatchObject({
          kind: 'round_ended',
          reason: end === 'off' ? 'mode' : end,
        })
        if (end === 'off')
          expect(plan({ ...extended, mode: 'off' })).not.toHaveProperty(
            'sourceCacheMarkerRestored',
          )
      }
      expect(returned).toMatchObject({
        kind: 'source',
        sourceCacheMarkerRestored: true,
      })
      expect(JSON.parse(returned.bodyText).messages).toEqual(expectedMessages)
    } finally {
      cacheKeep.stop()
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test.each(['deferred', 'released tool'] as const)(
  'a %s refusal retires the previous model target when it installs the round',
  (kind) => {
    const storage = {
      version: 1 as const,
      accounts: [],
      claudeCache: { enabled: true, mode: 'hybrid' as const },
      cacheKeep: { enabled: true, always: true },
    }
    const cacheKeep = new CacheKeepManager({ loadStorage: async () => storage })
    try {
      const { begin, plan, send, engine } = fixture({ cacheKeep })
      const previousModel = 'claude-fable-5-1'
      const previousEnginePlan = plan({ requestedModel: previousModel })
      expect(previousEnginePlan.kind).toBe('source')
      expect(
        cacheKeep.track({
          sessionId: 's',
          url: binding.url,
          storage,
          cacheMode: 'hybrid',
          headers: new Headers(),
          bodyText: JSON.stringify({
            model: previousModel,
            system: [
              {
                type: 'text',
                text: 'Stable',
                cache_control: { type: 'ephemeral' },
              },
            ],
          }),
        }).tracked,
      ).toBe(true)
      const next = plan()
      expect(cacheKeep.trackedRequest('s')).toBeDefined()
      if (kind === 'released tool') begin('tool', next)
      else {
        const { lifecycle } = send(next)
        lifecycle?.onRefusal?.(refusal)
        expect(cacheKeep.trackedRequest('s')).toBeDefined()
        lifecycle?.onDeferredRefusal?.(refusal)
      }
      expect(engine.hasRound('s')).toBe(true)
      expect(cacheKeep.trackedRequest('s')).toBeUndefined()
    } finally {
      cacheKeep.stop()
    }
  },
)

test.each([
  ['1h', 3_600_000],
  ['5m', 300_000],
] as const)(
  'round activity reads %s from the physical body after thread recovery',
  (ttl, ms) => {
    let now = 0
    const { begin, plan, send } = fixture({ now: () => now })
    begin()
    const step = plan()
    const wire = JSON.stringify({
      ...body,
      system: [
        {
          type: 'text',
          text: 'actual',
          cache_control: { type: 'ephemeral', ttl },
        },
      ],
    })
    send(step, { sentBodyText: () => wire }).lifecycle?.onCompleted?.(
      completion,
    )
    now = ms
    expect(plan().kind).toBe('round')
    now += 1
    expect(plan().kind).toBe('source')
  },
)

test('a deferred round expires by the refused request lifetime before any fallback step', () => {
  let now = 0
  const { begin, plan, events } = fixture({ now: () => now })
  begin('tool')
  now = 299_999
  expect(plan().kind).toBe('round')
  now += 2
  expect(plan().kind).toBe('source')
  expect(events.at(-1)).toMatchObject({
    kind: 'round_ended',
    reason: 'idle',
    stepsLeft: 10,
  })
})

test('a delayed defer starts the idle clock at the refusal, not after authorization', () => {
  let now = 0
  const { plan, send, events } = fixture({ now: () => now })
  const { lifecycle } = send(plan())
  lifecycle?.onRefusal?.(refusal)
  now = 20_000
  lifecycle?.onDeferredRefusal?.(refusal)
  now = 300_000
  expect(plan().kind).toBe('round')
  now++
  expect(plan().kind).toBe('source')
  expect(events.at(-1)).toMatchObject({ kind: 'round_ended', reason: 'idle' })
})

test.each([
  ['first refusal after 3 clean responses', false, 3, 0, 'retry', 10],
  ['10 clean then retry', true, 10, 0, 'retry', 10],
  ['9 clean then retry', true, 9, 0, 'retry', 20],
  ['10 clean then released tool', true, 10, 0, 'tool', 10],
  ['7 clean, unretried refusal, then 5 clean', true, 7, 5, 'retry', 20],
] as const)(
  'backoff: %s',
  (_name, hadRound, firstClean, moreClean, start, length) => {
    const { begin, plan, send, events } = fixture()
    if (hadRound) {
      begin()
      // Compaction ends the round without clearing the recent-round flag.
      expect(plan({ compacted: true }).kind).toBe('source')
    }
    for (let i = 0; i < firstClean; i++)
      send(plan()).lifecycle?.onCompleted?.(completion)
    if (moreClean) begin('no-retry')
    for (let i = 0; i < moreClean; i++)
      send(plan()).lifecycle?.onCompleted?.(completion)
    begin(start)
    expect(
      events.filter((event) => event.kind === 'round_started').at(-1)
        ?.stepsLeft,
    ).toBe(length - (start === 'retry' ? 1 : 0))
  },
)

test('backoff saturates at 40 and resets on a requested model change even within the session', () => {
  const { begin, plan, events } = fixture()
  for (let i = 0; i < 4; i++) {
    begin('tool')
    if (i < 3) plan({ compacted: true })
  }
  expect(
    events
      .filter((event) => event.kind === 'round_started')
      .map((e) => e.stepsLeft),
  ).toEqual([10, 20, 40, 40])
  expect(plan({ requestedModel: 'claude-haiku-5-5' }).kind).toBe('source')
  expect(events.at(-1)).toMatchObject({
    kind: 'round_ended',
    reason: 'model',
    stepsLeft: 40,
  })
  begin('tool')
  expect(events.at(-1)).toMatchObject({ kind: 'round_started', stepsLeft: 10 })
})

test('events identify the round, decrement once per current primary, and reach zero at count end', () => {
  const { plan, send, begin, events } = fixture()
  begin()
  const stale = send(plan())
  const fresh = send(plan())
  stale.lifecycle?.onCompleted?.(completion)
  fresh.lifecycle?.onCompleted?.(completion)
  fresh.lifecycle?.onCompleted?.(completion)
  for (let i = 0; i < 8; i++) send(plan()).lifecycle?.onCompleted?.(completion)
  expect(plan().kind).toBe('source')
  expect(events.map(({ kind, stepsLeft }) => [kind, stepsLeft])).toEqual([
    ['round_started', 9],
    ...Array.from({ length: 10 }, (_, i) => ['step_served' as const, 9 - i]),
    ['round_ended', 0],
  ])
  for (const event of events) {
    const { kind: _kind, stepsLeft: _left, ...info } = event
    expect(info).toEqual({
      sessionId: 's',
      requestedModel: fable,
      servingModel: opus,
      category: 'cyber',
      ...(event.kind === 'round_ended' && { reason: 'count' }),
    })
  }
})

test.each([
  ['compaction', { compacted: true }],
  ['account', { oauth: { ...oauth, accountId: 'B' } }],
  ['route', { oauth: undefined }],
  ['quota', { oauth: { ...oauth, targetAllowed: (): boolean => false } }],
  ['mode', { mode: 'off' }],
  [
    'budget',
    {
      bodyText: JSON.stringify({
        ...body,
        thinking: { type: 'enabled', budget_tokens: 128_000 },
      }),
    },
  ],
  [
    'window',
    {
      bodyText: JSON.stringify({
        ...body,
        messages: [
          ...body.messages,
          { role: 'user', content: 'x'.repeat(4_000_000) },
        ],
      }),
    },
  ],
] as const)(
  '%s ends the round and selects the source before thread preparation',
  (reason, overrides) => {
    const { begin, plan, events } = fixture()
    begin('tool')
    const result = plan(overrides)
    expect(result.kind).toBe('source')
    expect(result.bodyText).toBe(
      'bodyText' in overrides ? overrides.bodyText : JSON.stringify(body),
    )
    expect(events.at(-1)).toMatchObject({
      kind: 'round_ended',
      reason,
      stepsLeft: 10,
    })
  },
)

test.each([
  'title',
  'summary',
  'compaction',
  'keep-warm',
  'prime',
  'fork',
  'lane-start',
  'auxiliary',
])(
  'ordinary %s is source byte-for-byte and cannot change round state',
  (kind) => {
    const { begin, input, plan, events } = fixture()
    begin()
    expect(
      plan({
        kind,
        requestedModel: 'other-model',
        mode: 'server',
        oauth: undefined,
      }),
    ).toEqual({
      kind: 'source',
      bodyText: input.bodyText,
    })
    expect(plan().kind).toBe('round')
    expect(events.map((event) => event.kind)).toEqual([
      'round_started',
      'step_served',
    ])
  },
)

test.each(['server', 'off'] as const)(
  '%s primary remains untouched',
  (mode) => {
    const { input, plan, events } = fixture()
    expect(plan({ mode })).toEqual({ kind: 'source', bodyText: input.bodyText })
    expect(events).toEqual([])
  },
)

test('the model swap comes after source shaping and headers but before thread and signing', async () => {
  const { begin, plan, send } = fixture()
  begin()
  const stages: string[] = []
  const route = () => {
    stages.push('source route')
    return oauth
  }
  const source = () => {
    stages.push('source transform')
    return JSON.stringify({ ...body, messages: [marker, prompt] })
  }
  const headers = () => {
    stages.push('source headers')
    return new Headers({
      'anthropic-beta': `${SERVER_SIDE_FALLBACK_BETA},per-turn-control-test`,
    })
  }
  const finalRoute = route()
  const sourceBodyText = source()
  const sourceHeaders = headers()
  const originalHeaders = [...sourceHeaders]
  const target = plan({
    oauth: finalRoute,
    bodyText: sourceBodyText,
    filterBody(text, path) {
      if (path.kind === 'target') {
        expect(stages).toEqual([
          'source route',
          'source transform',
          'source headers',
        ])
        expect(JSON.parse(text).model).toBe(fable)
      }
      return text
    },
  })
  expect(target).toMatchObject({
    kind: 'round',
    folded: true,
    servingModel: opus,
  })
  const preThread = JSON.parse(target.bodyText)
  expect(preThread).toMatchObject({
    model: opus,
    max_tokens: 128_000,
    messages: [prompt],
    output_config: { effort: 'high' },
  })
  expect(preThread.thread).toBeUndefined()
  const signed = await signRequestBody(
    JSON.stringify({ ...preThread, thread: { type: 'create' } }),
  )
  expect(await hasValidRequestBodySignature(signed)).toBe(true)
  expect([...sourceHeaders]).toEqual(originalHeaders)
  send(target)
  expect(plan()).toMatchObject({ kind: 'round', folded: true })
})

const start = (model: string, tokens = 20) => ({
  type: 'message_start',
  message: { model, usage: { input_tokens: tokens } },
})
const end = {
  type: 'message_delta',
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 5 },
}
const stop = { type: 'message_stop' }
const refused = {
  type: 'message_delta',
  delta: {
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber' },
  },
}
const block = (content_block: Record<string, unknown>) => ({
  type: 'content_block_start',
  index: 0,
  content_block,
})
const close = { type: 'content_block_stop', index: 0 }
const encode = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
const sse = (...events: unknown[]) =>
  new Response(encode(...events), {
    headers: { 'content-type': 'text/event-stream' },
  })
const bad = () =>
  Response.json({ error: { message: 'wrong request' } }, { status: 400 })

const sourceThought = {
  type: 'thinking',
  thinking: 'source private thought',
  signature: 'source signature',
}
const targetThought = {
  type: 'thinking',
  thinking: 'target private thought',
  signature: 'target signature',
}
const redacted = { type: 'redacted_thinking', data: 'target redacted data' }
const textBlock = (text: string) => ({ type: 'text', text })
const assistant = (...content: unknown[]) => ({ role: 'assistant', content })
const user = (content: string) => ({ role: 'user', content })
const replay = (...messages: unknown[]) => JSON.stringify({ ...body, messages })

function retryWithThinking(
  input: RefusalFallbackRoundPlan,
  lifecycle: NonNullable<ReturnType<RefusalFallbackRoundEngine['lifecycle']>>,
  events: unknown[],
  options?: {
    credited?: boolean
    onCommit?: () => void
    signal?: AbortSignal
    capture?: (bodyText: string) => void
  },
) {
  const { options: dispatch } = resendOptions()
  const refusalFrame = options?.credited
    ? {
        ...refused,
        delta: {
          ...refused.delta,
          stop_details: {
            ...refused.delta.stop_details,
            fallback_credit_token: 'one-use-credit',
            fallback_has_prefill_claim: true,
          },
        },
      }
    : refused
  return dispatchRefusalFallback(
    sse(start(fable), block(sourceThought), close, refusalFrame, stop),
    {
      ...dispatch,
      origin: { ...dispatch.origin, bodyText: input.bodyText },
      isFresh: allowed,
      signal: options?.signal,
      onRetryCommitted: options?.onCommit,
      billing: { sessionId: 's', requestKind: 'primary' },
      lifecycle,
      async send({ bodyText }) {
        options?.capture?.(bodyText)
        return sse(start(opus), ...events)
      },
    },
  )
}
const sendHeaders = new Headers({
  authorization: 'Bearer initial',
  'anthropic-beta': `${SERVER_SIDE_FALLBACK_BETA},per-turn-control-test`,
  'x-source-header': 'preserved',
})

function resendOptions() {
  const auth: string[] = []
  const sends: string[] = []
  const options = {
    sourceModel: fable,
    isCurrentPrimary: allowed,
    origin: { ...binding, headers: sendHeaders },
    authorize: (request: {
      model: string
      origin: typeof binding
      wait: false
    }) => {
      expect(request).toMatchObject({ origin: binding, wait: false })
      auth.push(request.model)
      return { kind: 'authorized' as const, ...binding, accessToken: 'fresh' }
    },
    send: async ({
      headers,
      bodyText,
    }: {
      headers: Headers
      bodyText: string
    }) => {
      expect(headers.get('authorization')).toBe('Bearer fresh')
      expect(headers.get('anthropic-beta')).toBe(
        sendHeaders.get('anthropic-beta'),
      )
      expect(headers.get('x-source-header')).toBe('preserved')
      sends.push(bodyText)
      return sse(start(fable), refused, stop)
    },
  }
  return { options, auth, sends }
}

test('a fresh round target 400 resends one signed, unfolded and stateless source request, which is terminal', async () => {
  const { begin, plan, send, engine, events } = fixture()
  const { options, auth, sends } = resendOptions()
  begin()
  const original = {
    ...body,
    messages: [marker, prompt],
    thread: { type: 'continue' },
  }
  const round = plan({
    bodyText: JSON.stringify(original),
    filterBody(text, route) {
      return route.kind === 'source'
        ? JSON.stringify({ ...JSON.parse(text), sourceBound: true })
        : text
    },
  })
  expect(round).toMatchObject({ kind: 'round', folded: true })
  const { handle } = send(round)
  const response = await engine.handleTarget400(handle, bad(), options)
  expect(await response.text()).toBe(encode(start(fable), refused, stop))
  expect(auth).toEqual([fable])
  expect(sends).toHaveLength(1)
  const resent = sends[0] ?? ''
  expect(await hasValidRequestBodySignature(resent)).toBe(true)
  const { thread: _thread, system: _system, ...initial } = original
  const { system: _signed, ...wire } = JSON.parse(resent)
  expect(wire).toEqual({ ...initial, sourceBound: true })
  expect(events.at(-1)).toMatchObject({
    kind: 'round_ended',
    stepsLeft: 9,
    reason: 'target-400',
  })
  expect(plan().kind).toBe('source')
  const duplicate = bad()
  expect(await engine.handleTarget400(handle, duplicate, options)).toBe(
    duplicate,
  )
  expect(sends).toHaveLength(1)
})

test('a stale round 400 does not resend or retire the live round', async () => {
  const { begin, plan, send, engine, events } = fixture()
  const { options, auth, sends } = resendOptions()
  begin()
  const stale = send(plan())
  send(plan())
  const response = bad()
  expect(await engine.handleTarget400(stale.handle, response, options)).toBe(
    response,
  )
  expect(auth).toEqual([])
  expect(sends).toEqual([])
  expect(events.at(-1)).toMatchObject({ kind: 'step_served', stepsLeft: 9 })
})

test('a 400 delayed during admission cannot change a replacement round', async () => {
  const { begin, plan, send, engine, events } = fixture()
  const { options, sends } = resendOptions()
  begin()
  const { handle } = send(plan())
  const pending = Promise.withResolvers<ReturnType<typeof options.authorize>>()
  const entered = Promise.withResolvers<void>()
  const original = bad()
  const response = engine.handleTarget400(handle, original, {
    ...options,
    authorize() {
      entered.resolve()
      return pending.promise
    },
  })
  await entered.promise
  begin('tool', plan({ compacted: true }))
  pending.resolve({ kind: 'authorized', ...binding, accessToken: 'fresh' })
  expect(await response).toBe(original)
  expect(sends).toEqual([])
  expect(plan().kind).toBe('round')
  expect(events.at(-1)).toMatchObject({ kind: 'round_started', stepsLeft: 20 })
})

test('fresh 400 with a changed credential ends the round but sends nothing', async () => {
  const { begin, plan, send, engine, events } = fixture()
  const { options, sends } = resendOptions()
  begin()
  const { handle } = send(plan())
  const error = bad()
  expect(
    await engine.handleTarget400(handle, error, {
      ...options,
      authorize: () => ({
        kind: 'authorized',
        ...binding,
        credentialId: 'replaced',
        accessToken: 'new',
      }),
    }),
  ).toBe(error)
  expect(sends).toEqual([])
  expect(events.at(-1)).toMatchObject({
    kind: 'round_ended',
    reason: 'target-400',
  })
})

test('explicitly routed title fits only on a valid live target and its 400 ignores primary freshness', async () => {
  const { begin, input, plan, send, engine, events } = fixture()
  const { options, sends } = resendOptions()
  const title = {
    ...input,
    kind: 'title',
    bodyText: JSON.stringify({
      ...body,
      messages: [{ role: 'user', content: 'Title?' }],
    }),
  }
  expect(engine.planRouted(title).kind).toBe('source')
  begin()
  expect(engine.planRouted({ ...title, mode: 'off' }).kind).toBe('source')
  expect(
    engine.planRouted({ ...title, oauth: { ...oauth, accountId: 'B' } }).kind,
  ).toBe('source')
  expect(engine.planRouted({ ...title, kind: 'prime' }).kind).toBe('source')
  expect(engine.planRouted({ ...title, kind: 'keep-warm' }).kind).toBe('source')
  expect(
    engine.planRouted({
      ...title,
      bodyText: JSON.stringify({ ...body, messages: [marker, prompt] }),
    }).kind,
  ).toBe('source')
  expect(
    engine.planRouted({
      ...title,
      bodyText: JSON.stringify({
        ...body,
        thinking: { budget_tokens: 128_000 },
      }),
    }).kind,
  ).toBe('source')
  expect(
    engine.planRouted({
      ...title,
      bodyText: JSON.stringify({
        ...body,
        messages: [{ ...prompt, content: 'x'.repeat(4_000_000) }],
      }),
    }).kind,
  ).toBe('source')
  const routed = engine.planRouted(title)
  expect(routed).toMatchObject({ kind: 'routed', servingModel: opus })
  const { handle, lifecycle } = send(routed)
  expect(lifecycle).toBeUndefined()
  send(plan())
  expect(
    (
      await engine.handleTarget400(handle, bad(), {
        ...options,
        isCurrentPrimary: () => false,
      })
    ).ok,
  ).toBe(true)
  expect(JSON.parse(sends[0] ?? '').messages).toEqual([
    { role: 'user', content: 'Title?' },
  ])
  expect(sends).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ kind: 'step_served', stepsLeft: 9 })
  expect(plan().kind).toBe('round')
})

test('folded routed request has its effort folded before validity is checked', () => {
  const { begin, input, plan, send, engine, events } = fixture()
  begin()
  const bodyText = JSON.stringify({ ...body, messages: [marker, prompt] })
  send(plan({ bodyText }))
  const routed = engine.planRouted({ ...input, kind: 'title', bodyText })
  expect(routed).toMatchObject({ kind: 'routed', folded: true })
  expect(JSON.parse(routed.bodyText).messages).toEqual([prompt])
  expect(events.at(-1)).toMatchObject({ kind: 'step_served', stepsLeft: 9 })
})

test.each([[true], [false]])(
  'completed retry seeds the estimate from its own full-prefix usage (credited: %s)',
  async (credited) => {
    const { input, plan, send, engine, events } = fixture()
    const initial = plan()
    const { lifecycle } = send(initial)
    const { options } = resendOptions()
    const sent: string[] = []
    const payload = credited
      ? {
          ...refused,
          delta: {
            ...refused.delta,
            stop_details: {
              ...refused.delta.stop_details,
              fallback_credit_token: 'secret-sentinel',
              fallback_has_prefill_claim: true,
            },
          },
        }
      : refused
    const reply = dispatchRefusalFallback(
      sse(
        start(fable),
        ...(credited ? [block({ type: 'text', text: 'prefix' }), close] : []),
        payload,
        stop,
      ),
      {
        ...options,
        origin: {
          ...options.origin,
          bodyText: JSON.stringify({
            ...body,
            thread: { type: 'continue' },
            messages: [],
          }),
          fullBodyText: initial.bodyText,
        },
        billing: { sessionId: 's', requestKind: 'primary' },
        isFresh: allowed,
        lifecycle,
        async send({ bodyText }) {
          sent.push(bodyText)
          return sse(
            start(opus, 872_000),
            block({ type: 'text', text: 'answer' }),
            close,
            end,
            stop,
          )
        },
      },
    )
    expect(await reply.text()).not.toContain('secret-sentinel')
    const wire = JSON.parse(sent[0] ?? '')
    expect(wire.thread).toEqual({ type: 'create' })
    expect(wire.messages).toHaveLength(credited ? 2 : 1)
    expect(events.map(({ kind, stepsLeft }) => [kind, stepsLeft])).toEqual([
      ['round_started', 9],
      ['step_served', 9],
    ])
    // A title's small standalone body fits by byte estimate and cannot overwrite the base.
    const title = engine.planRouted({
      ...input,
      kind: 'title',
      bodyText: JSON.stringify({
        ...body,
        messages: [{ ...prompt, content: 'Title?' }],
      }),
    })
    expect(title.kind).toBe('routed')
    await joinRefusalFallbackStream(sse(start(opus), end, stop), {
      isFresh: allowed,
      sourceModel: fable,
      lifecycle: send(title).lifecycle,
    }).text()
    const messages = [
      prompt,
      { role: 'assistant', content: credited ? 'prefixanswer' : 'answer' },
      { role: 'user', content: 'Follow up?' },
    ]
    expect(plan({ bodyText: JSON.stringify({ ...body, messages }) }).kind).toBe(
      'source',
    )
    expect(events.at(-1)).toMatchObject({
      kind: 'round_ended',
      reason: 'window',
      stepsLeft: 9,
    })
  },
)

test('prefix estimate adds only normalized appended message bytes and compares content', () => {
  const original = { ...body, messages: [marker, prompt] }
  const prefix = refusalFallbackEstimateBase(original, 91)
  const tail = [{ content: [{ text: 'a☃b', type: 'text' }], role: 'assistant' }]
  const expected = 91 + Buffer.byteLength(JSON.stringify(tail)) / 4
  const extended = {
    ...original,
    messages: [
      prompt,
      {
        role: 'system',
        content: TURN_END_NOTE_CONTENT,
        clear_at: 'next_user_message',
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a☃', cache_control: { type: 'ephemeral' } },
          { type: 'thinking', thinking: 'unsigned' },
          { type: 'text', text: '' },
          { type: 'text', text: 'b' },
        ],
      },
    ],
  }
  expect(
    estimateRefusalFallbackInput(extended, JSON.stringify(extended), prefix),
  ).toBe(expected)
  const changed = {
    ...extended,
    messages: [
      { ...prompt, content: 'Changed' },
      ...extended.messages.slice(1),
    ],
  }
  const text = JSON.stringify(changed)
  expect(estimateRefusalFallbackInput(changed, text, prefix)).toBe(
    Buffer.byteLength(text) / 4,
  )
  expect(
    estimateRefusalFallbackInput(extended, JSON.stringify(extended), undefined),
  ).toBe(Buffer.byteLength(JSON.stringify(extended)) / 4)
})

test('join counts only complete fresh target responses without a refusal block', async () => {
  const { begin, plan, send, events } = fixture()
  begin('tool')
  const attempt = (response: Response, isFresh = allowed) => {
    const { lifecycle } = send(plan())
    return joinRefusalFallbackStream(response, {
      sourceModel: fable,
      isFresh,
      lifecycle,
    }).text()
  }
  await attempt(sse(start(opus), end))
  await attempt(sse(start(opus), end, { type: 'error' }, stop))
  await attempt(sse(start(opus), block({ type: 'refusal' }), close, end, stop))
  await attempt(sse(start(opus), refused, stop))
  await attempt(sse(start(opus), end, stop), () => false)
  expect(events).toHaveLength(1)
  expect(await attempt(sse(start(opus), end, stop))).toBe(
    encode(start(fable), end, stop),
  )
  expect(events.at(-1)).toMatchObject({ kind: 'step_served', stepsLeft: 9 })
})

test('dispatch forwards a released tool and starts a folded round without an extra physical send', async () => {
  const { plan, send, events } = fixture()
  const initial = plan({
    bodyText: JSON.stringify({
      ...body,
      model: 'claude-opus-5',
      messages: [marker, prompt],
    }),
    requestedModel: 'claude-opus-5',
  })
  const { lifecycle } = send(initial)
  const { options, sends } = resendOptions()
  const tool = block({
    type: 'tool_use',
    id: 'toolu_1',
    name: 'lookup',
    input: {},
  })
  const delta = {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"query":"kept","limit":5}',
    },
  }
  const source = 'claude-opus-5'
  const reply = dispatchRefusalFallback(
    sse(start(source), tool, delta, close, refused, stop),
    {
      ...options,
      sourceModel: source,
      origin: { ...options.origin, bodyText: initial.bodyText },
      isFresh: allowed,
      billing: { sessionId: 's', requestKind: 'primary' },
      lifecycle,
    },
  )
  const result = await reply.text()
  expect(result).toContain('"stop_reason":"tool_use"')
  expect(result).not.toContain('stop_details')
  expect(sends).toEqual([])
  expect(events).toEqual([
    {
      kind: 'round_started',
      sessionId: 's',
      requestedModel: source,
      servingModel: opus,
      category: 'cyber',
      stepsLeft: 10,
    },
  ])
  expect(
    plan({
      requestedModel: source,
      bodyText: JSON.stringify({
        ...JSON.parse(initial.bodyText),
        messages: [
          marker,
          prompt,
          {
            role: 'assistant',
            content: [
              { ...tool.content_block, input: { limit: 5, query: 'kept' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' },
            ],
          },
        ],
      }),
    }),
  ).toMatchObject({ kind: 'round', folded: true })
})

test('dispatch with no round lifecycle preserves the joined wire bytes and physical retry', async () => {
  const { options } = resendOptions()
  const sent: string[] = []
  const scope = {
    ...options,
    isFresh: allowed,
    billing: { sessionId: 's', requestKind: 'primary' as const },
    origin: { ...options.origin, bodyText: JSON.stringify(body) },
    send: async ({ bodyText }: { bodyText: string }) => {
      sent.push(bodyText)
      return sse(
        start(opus),
        block({ type: 'text', text: 'answer' }),
        close,
        end,
        stop,
      )
    },
  }
  const source = () => sse(start(fable), refused, stop)
  const result = await dispatchRefusalFallback(source(), scope).text()
  const withObservers = await dispatchRefusalFallback(source(), {
    ...scope,
    lifecycle: { onRefusal() {}, onRetryCompleted() {} },
  }).text()
  expect(withObservers).toBe(result)
  expect(result).toBe(
    encode(
      start(fable),
      block({ type: 'text', text: 'answer' }),
      close,
      {
        ...end,
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
      stop,
    ),
  )
  expect(sent).toHaveLength(2)
  expect(sent[0]).toBe(sent[1])
})

test('two rounds do not publish a warm template and a second refusal does not restore stripped thinking', async () => {
  const thinkingStore = new RecoveryThinkingStore({ persist: false })
  const { plan, send, events } = fixture({ thinkingStore })
  const templates: Array<string | null> = []
  const track = (template: { bodyText: string } | null) => {
    templates.push(template?.bodyText ?? null)
  }
  const sends: string[] = []
  const initial = plan()
  const first = send(initial, { onCacheKeepTemplate: track }).lifecycle!
  await retryWithThinking(
    initial,
    first,
    [
      block(targetThought),
      close,
      block(redacted),
      close,
      block(textBlock('first answer')),
      close,
      end,
      stop,
    ],
    {
      credited: true,
      capture: (text) => sends.push(text),
    },
  ).text()
  expect(await hasValidRequestBodySignature(sends[0]!)).toBe(true)
  expect(JSON.parse(sends[0]!).messages).toEqual([
    prompt,
    assistant(sourceThought),
  ])
  for (let i = 0; i < 129; i++)
    thinkingStore.record(
      `other-${i}`,
      'fable-5-2',
      recoveryThinkingDigest('thinking', 'another session'),
    )
  expect(thinkingStore.peek('s', 'fable-5-2')?.size).toBe(2)

  const mixed = assistant(
    sourceThought,
    targetThought,
    redacted,
    textBlock('first answer'),
  )
  const next = user('next question')
  const liveText = replay(prompt, mixed, next)
  const live = plan({ bodyText: liveText })
  expect(live.kind).toBe('round')
  expect(JSON.parse(live.bodyText).messages[1]).toEqual(mixed)
  for (let i = 0; i < 9; i++)
    send(plan({ bodyText: liveText })).lifecycle?.onCompleted?.(completion)
  expect(events.at(-1)).toMatchObject({ kind: 'round_ended', reason: 'count' })

  const source = plan({ bodyText: liveText })
  const stripped = assistant(sourceThought, textBlock('first answer'))
  expect(JSON.parse(source.bodyText).messages).toEqual([prompt, stripped, next])
  const second = send(source, { onCacheKeepTemplate: track }).lifecycle!
  const secondTarget = { ...targetThought, signature: 'round two signature' }
  await retryWithThinking(
    source,
    second,
    [
      block(secondTarget),
      close,
      block(textBlock('second answer')),
      close,
      end,
      stop,
    ],
    {
      credited: true,
      capture: (text) => sends.push(text),
    },
  ).text()
  const secondRetry = JSON.parse(sends[1]!)
  expect(secondRetry.messages).toEqual([
    prompt,
    stripped,
    next,
    assistant(sourceThought),
  ])
  const nextRound = plan({
    bodyText: replay(
      prompt,
      mixed,
      next,
      assistant(sourceThought, secondTarget, textBlock('second answer')),
      user('third question'),
    ),
  })
  expect(nextRound.kind).toBe('round')
  const routed = JSON.parse(nextRound.bodyText).messages
  expect(JSON.stringify(routed.slice(0, 3))).toBe(
    JSON.stringify(secondRetry.messages.slice(0, 3)),
  )
  expect(nextRound.bodyText).not.toContain('target signature')
  expect(nextRound.bodyText).not.toContain('target redacted data')
  expect(nextRound.bodyText).toContain('round two signature')
  expect(templates).toBeEmpty()
  expect(
    events.some(
      (event) => event.kind === 'round_ended' && event.reason === 'compaction',
    ),
  ).toBe(false)
})

test.each(['refused', 'stale', 'broken', 'aborted'] as const)(
  'thinking from a %s retry is persisted as ended provenance and removed after restart',
  async (outcome) => {
    const directory = await mkdtemp(join(tmpdir(), 'refusal-thinking-'))
    try {
      const thinkingStore = new RecoveryThinkingStore({ directory })
      const { engine, plan, send, events } = fixture({ thinkingStore })
      await engine.loadThinking('s')
      const initial = plan()
      const templates: unknown[] = []
      const lifecycle = send(initial, {
        onCacheKeepTemplate: (value) => {
          templates.push(value)
        },
      }).lifecycle!
      const abort = new AbortController()
      const response = retryWithThinking(
        initial,
        lifecycle,
        [
          block(targetThought),
          close,
          block(redacted),
          close,
          ...(outcome === 'refused'
            ? [refused, stop]
            : outcome === 'broken'
              ? []
              : [end, stop]),
        ],
        {
          credited: true,
          signal: abort.signal,
          onCommit:
            outcome === 'stale'
              ? () => {
                  send(plan())
                }
              : undefined,
        },
      )
      if (outcome === 'aborted') {
        const reader = response.body!.getReader()
        let stops = 0
        while (stops < 3) {
          const next = await reader.read()
          if (next.done) throw new Error('stream ended before thinking arrived')
          if (
            new TextDecoder().decode(next.value).includes('content_block_stop')
          )
            stops++
        }
        abort.abort()
        await expect(reader.read()).rejects.toThrow()
      } else expect(await response.text()).toContain('target signature')
      expect(events).toEqual([])
      expect(templates).toEqual([])

      const hostReplay = replay(
        prompt,
        assistant(
          sourceThought,
          targetThought,
          redacted,
          textBlock('older turn'),
        ),
        user('next'),
        assistant(sourceThought, targetThought, textBlock('later turn')),
        user('ask'),
      )
      const expected = [
        prompt,
        assistant(sourceThought, textBlock('older turn')),
        user('next'),
        assistant(sourceThought, textBlock('later turn')),
        user('ask'),
      ]
      expect(
        JSON.parse(plan({ bodyText: hostReplay }).bodyText).messages,
      ).toEqual(expected)
      await thinkingStore.flush()
      const [file] = await readdir(directory)
      const disk = await readFile(join(directory, file!), 'utf8')
      expect(JSON.parse(disk)).toEqual({
        version: 1,
        families: {
          'fable-5-2': [
            expect.stringMatching(/^[\w-]{43}$/),
            expect.stringMatching(/^[\w-]{43}$/),
          ],
        },
      })
      expect(disk).not.toContain('private thought')
      expect(disk).not.toContain('signature')
      expect(disk).not.toContain('redacted data')
      const restart = fixture({
        thinkingStore: new RecoveryThinkingStore({ directory }),
      })
      await restart.engine.loadThinking('s')
      const restored = restart.plan({ bodyText: hostReplay })
      expect(restored.kind).toBe('source')
      expect(JSON.parse(restored.bodyText).messages).toEqual(expected)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test.each([
  'older reply',
  'latest reply',
  'system message',
  'system',
  'tools',
] as const)(
  'an edit to the %s ends the round even when block types are unchanged',
  async (edit) => {
    const { plan, send, events } = fixture()
    const system = {
      role: 'system',
      content: 'host-provided note',
      clear_at: 'next_user_message',
    }
    const earlier = assistant(textBlock('earlier answer'))
    const ask = user('question')
    const tools = [{ name: 'lookup', description: 'lookup text' }]
    const original = {
      ...body,
      tools,
      messages: [prompt, earlier, system, ask],
    }
    const request = plan({ bodyText: JSON.stringify(original) })
    await retryWithThinking(
      request,
      send(request).lifecycle!,
      [block(textBlock('latest answer')), close, end, stop],
      { credited: true },
    ).text()
    const latest = assistant(sourceThought, textBlock('latest answer'))
    const next = {
      ...original,
      messages: [...original.messages, latest, user('followup')],
    }
    expect(plan({ bodyText: JSON.stringify(next) }).kind).toBe('round')
    if (edit === 'older reply')
      next.messages[1] = assistant(textBlock('earlier edit'))
    if (edit === 'latest reply')
      next.messages[4] = assistant(sourceThought, textBlock('latest edit'))
    if (edit === 'system message')
      next.messages[2] = { ...system, content: 'a changed host note' }
    if (edit === 'system')
      next.system = [...original.system, textBlock('changed instructions')]
    if (edit === 'tools')
      next.tools = [{ ...tools[0]!, description: 'changed lookup' }]
    expect(plan({ bodyText: JSON.stringify(next) }).kind).toBe('source')
    expect(events.at(-1)).toMatchObject({
      kind: 'round_ended',
      reason: 'compaction',
    })
  },
)

test.each(['append', 'edit'] as const)(
  'deferred refusal checks the leading blocks of a merged user turn: %s',
  async (change) => {
    const { plan, send, events } = fixture()
    const earlier = [prompt, assistant(textBlock('earlier answer'))]
    const leading = [textBlock('the refused request'), textBlock('keep this')]
    const initial = plan({
      bodyText: replay(...earlier, { role: 'user', content: leading }),
    })
    const { options, sends } = resendOptions()
    const refusal = dispatchRefusalFallback(
      sse(
        start(fable),
        block(textBlock('The result is ')),
        close,
        refused,
        stop,
      ),
      {
        ...options,
        origin: { ...options.origin, bodyText: initial.bodyText },
        billing: { sessionId: 's', requestKind: 'primary' },
        isFresh: allowed,
        lifecycle: send(initial).lifecycle,
      },
    )
    expect(await refusal.text()).toContain('"stop_reason":"refusal"')
    expect(sends).toEqual([])
    expect(events).toEqual([
      expect.objectContaining({ kind: 'round_started', stepsLeft: 10 }),
    ])
    const next = plan({
      bodyText: replay(...earlier, {
        role: 'user',
        content: [
          leading[0],
          change === 'append' ? leading[1] : textBlock('edited'),
          textBlock('next request'),
        ],
      }),
    })
    expect(next.kind).toBe(change === 'append' ? 'round' : 'source')
    if (change === 'edit')
      expect(events.at(-1)).toMatchObject({
        kind: 'round_ended',
        reason: 'compaction',
      })
  },
)

test.each([false, true])(
  '10 append-only responses extend the projected reply checkpoint (folded: %s)',
  async (folded) => {
    const { plan, send, events } = fixture()
    const servingModel = folded ? opus : 'claude-opus-5'
    const built = { ...body, thinking: { type: 'adaptive' } }
    const messages: unknown[] = [prompt]
    const current = () =>
      plan({ bodyText: JSON.stringify({ ...built, messages }) })
    const before = send(current()).lifecycle!
    const tool = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'mcp_lookup',
      input: { query: 'example' },
    }
    if (folded) {
      before.onRefusal?.({ ...refusal, releasedTool: true, reply: [tool] })
    } else {
      before.onRefusal?.(refusal)
      before.onRetryCompleted?.(
        { ...completion, reply: [tool] },
        { model: servingModel, folded },
      )
    }
    messages.push(assistant(tool), {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' },
      ],
    })
    const note = {
      role: 'system',
      clear_at: 'next_user_message',
      content: TURN_END_NOTE_CONTENT,
    }
    messages.push(marker, note)
    for (let i = 0; i < (folded ? 10 : 9); i++) {
      const primary = current()
      expect(primary).toMatchObject({ kind: 'round', folded })
      const replyBlocks = [
        block(textBlock(`part ${i}`)),
        close,
        block({ type: 'thinking', thinking: 'unsigned' }),
        close,
        block(textBlock(' answer')),
        close,
      ]
      await joinRefusalFallbackStream(
        sse(start(servingModel), ...replyBlocks, end, stop),
        {
          sourceModel: fable,
          isFresh: allowed,
          lifecycle: send(primary).lifecycle,
        },
      ).text()
      messages.push(
        { role: 'assistant', content: `part ${i} answer` },
        user(`turn ${i}`),
      )
    }
    expect(events.at(-1)).toMatchObject({
      kind: 'round_ended',
      reason: 'count',
      stepsLeft: 0,
    })
  },
)
