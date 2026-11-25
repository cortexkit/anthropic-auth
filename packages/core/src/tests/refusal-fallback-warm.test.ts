import { expect, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import { CacheKeepManager } from '../cachekeep.ts'
import { hasValidRequestBodySignature } from '../cch.ts'
import {
  RefusalFallbackRoundEngine,
  type RefusalFallbackRoundInput,
} from '../refusal-fallback-round.ts'
import type { RefusalFallbackCacheRoute } from '../refusal-fallback-warm.ts'
import { SERVER_SIDE_FALLBACK_BETA } from '../server-fallback-usage.ts'

const fable = 'claude-fable-5-2'
const opus = 'claude-opus-4-8'
const warmId = (sessionId = 'session') => `source-warm:${sessionId}:fable-5-2`
const route = {
  url: 'https://example.test/v1/messages',
  accountId: 'main',
  credentialId: 'credential-A',
  requestedModel: fable,
  mode: 'client',
} as const
const headers = new Headers({
  'content-encoding': 'gzip',
  'anthropic-beta': SERVER_SIDE_FALLBACK_BETA,
})
const stored: AccountStorage = {
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  accounts: [],
  claudeCache: { enabled: true, mode: 'hybrid' },
  cacheKeep: { enabled: true, always: true },
}
const elapsed = 55 * 60_000
const allowed = () => true
const body = {
  model: fable,
  max_tokens: 200,
  stream: true,
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=test; cc_entrypoint=test; cch=00000;',
    },
  ],
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'accepted prefix',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    },
  ],
}
const refusedBody = {
  ...body,
  messages: [...body.messages, { role: 'user', content: 'refused suffix' }],
}
const usage = { input_tokens: 20, cache_read_input_tokens: 5_000 }
const completion = { stopReason: 'end_turn', usage } as const
const refusal = { category: 'cyber', releasedTool: true, usage }
const settle = () => Bun.sleep(0)

function harness(
  overrides: Partial<ConstructorParameters<typeof CacheKeepManager>[0]> = {},
) {
  let now = Date.now()
  let current: RefusalFallbackCacheRoute | undefined = route
  let storage = stored
  const sent: RequestInit[] = []
  const registered = Promise.withResolvers<void>()
  const cacheKeep = new CacheKeepManager({
    loadStorage: async () => storage,
    now: () => now,
    fetchImpl: (async (_url: string | URL | Request, request?: RequestInit) => {
      if (request) sent.push(request)
      return Response.json({ usage })
    }) as typeof fetch,
    ...overrides,
    onTargetChanged(target) {
      if (target.sourceWarm) registered.resolve()
      overrides.onTargetChanged?.(target)
    },
  })
  const engine = new RefusalFallbackRoundEngine(undefined, {
    cacheKeep,
    now: () => now,
  })
  const input = (sessionId = 'session'): RefusalFallbackRoundInput => ({
    sessionId,
    requestedModel: fable,
    kind: 'primary',
    mode: current?.mode ?? 'client',
    oauth: current
      ? {
          accountId: current.accountId,
          credentialId: current.credentialId,
          targetAllowed: allowed,
          sourceWarm: {
            headers,
            url: current.url,
            cacheMode: 'hybrid',
            loadStorage: async () => storage,
            currentRoute: () => current,
          },
        }
      : undefined,
    bodyText: JSON.stringify(body),
  })
  const send = (
    overrides?: Partial<RefusalFallbackRoundInput>,
    options?: Partial<Parameters<typeof engine.lifecycle>[1]>,
  ) => {
    const plan = engine.plan({ ...input(overrides?.sessionId), ...overrides })
    if (!plan.request || !engine.markSent(plan.request))
      throw new Error('expected sendable plan')
    return {
      plan,
      lifecycle: engine.lifecycle(plan.request, {
        isFresh: allowed,
        targetAllowed: allowed,
        ...options,
      })!,
    }
  }
  const start = (overrides: Partial<RefusalFallbackRoundInput> = {}) => {
    const { plan, lifecycle } = send({
      bodyText: JSON.stringify(refusedBody),
      ...overrides,
    })
    expect(plan.kind).toBe('source')
    lifecycle.onRefusal?.(refusal)
  }
  return {
    cacheKeep,
    engine,
    send,
    start,
    input,
    sent,
    registered: registered.promise,
    advance(ms: number) {
      now += ms
    },
    setRoute(next: typeof current) {
      current = next
    },
    setStorage(next: typeof storage) {
      storage = next
    },
  }
}

test('a refusal alone and a completion without cache use cannot seed a source warm', async () => {
  const h = harness()
  try {
    h.start({ sessionId: 'refusal-only' })
    h.send().lifecycle.onCompleted?.({
      ...completion,
      usage: { input_tokens: 50 },
    })
    h.start()
    await settle()
    expect(h.cacheKeep.trackedSessions()).toEqual([])
  } finally {
    h.cacheKeep.stop()
  }
})

test('warm uses only the last full accepted source prefix, waits until near expiry, and survives count end', async () => {
  const h = harness()
  try {
    h.send().lifecycle.onCompleted?.(completion)
    const title = h.engine.planRouted({
      ...h.input(),
      kind: 'title',
      bodyText: JSON.stringify({ ...body, messages: [] }),
    })
    expect(title.request).toBeUndefined()
    h.start()
    await h.registered
    const kept = h.cacheKeep.trackedRequest(warmId())!
    expect(JSON.parse(kept.bodyText).messages).toEqual(body.messages)
    expect(kept.oauthAccountIdentity).toBe(route.credentialId)
    expect(await hasValidRequestBodySignature(kept.bodyText)).toBe(true)
    for (let i = 0; i < 10; i++) {
      const { lifecycle, plan } = h.send({
        bodyText: JSON.stringify(refusedBody),
      })
      expect(plan.kind).toBe('round')
      lifecycle.onCompleted?.(completion)
    }
    expect(
      h.engine.plan({ ...h.input(), bodyText: JSON.stringify(refusedBody) })
        .kind,
    ).toBe('source')
    h.advance(elapsed - 1)
    await h.cacheKeep.tick()
    expect(h.sent).toHaveLength(0)
    h.advance(1)
    await h.cacheKeep.tick()
    expect(h.sent).toHaveLength(1)
    const physical = String(h.sent[0]?.body)
    expect(JSON.parse(physical)).toMatchObject({
      model: fable,
      max_tokens: 0,
      messages: body.messages,
    })
    for (const field of ['fallbacks', 'fallback_credit_token', 'thread'])
      expect(JSON.parse(physical)).not.toHaveProperty(field)
    expect(new Headers(h.sent[0]?.headers).get('content-encoding')).toBeNull()
    expect(new Headers(h.sent[0]?.headers).get('anthropic-beta')).toBe(
      SERVER_SIDE_FALLBACK_BETA,
    )
    expect(await hasValidRequestBodySignature(physical)).toBe(true)

    h.start()
    await settle()
    expect(h.cacheKeep.trackedRequest(warmId())?.bodyText).toBe(kept.bodyText)
    const returning = h.send({
      compacted: false,
      oauth: { ...h.input().oauth!, targetAllowed: () => false },
      bodyText: JSON.stringify(refusedBody),
    })
    expect(returning.plan.kind).toBe('source')
    returning.lifecycle.onCompleted?.({ stopReason: 'end_turn' })
    expect(h.cacheKeep.trackedRequest(warmId())).toBeUndefined()
  } finally {
    h.cacheKeep.stop()
  }
})

test.each(['matching prefix', 'edited prefix', 'changed lifetime'] as const)(
  'source return after more than 20 round blocks: %s',
  (scenario) => {
    const h = harness()
    const marker = { type: 'ephemeral', ttl: '1h' }
    try {
      h.send().lifecycle.onCompleted?.(completion)
      h.start()
      const messages: Array<{ role: string; content: unknown }> = [
        ...refusedBody.messages,
      ]
      for (let step = 0; step < 10; step++) {
        const reply = Array.from({ length: 3 }, (_, block) => ({
          type: 'text',
          text: `round step ${step} block ${block}`,
        }))
        const { plan, lifecycle } = h.send({
          bodyText: JSON.stringify({ ...body, messages }),
        })
        expect(plan.kind).toBe('round')
        expect(JSON.parse(plan.bodyText).messages).toEqual(messages)
        lifecycle.onCompleted?.({ ...completion, reply })
        messages.push(
          { role: 'assistant', content: reply },
          { role: 'user', content: `next ${step}` },
        )
      }
      const current = {
        ...body,
        system: [{ ...body.system[0], cache_control: marker }],
        messages: messages.map((message, index) => {
          if (index === 0)
            return {
              role: 'user',
              content:
                scenario === 'edited prefix'
                  ? 'edited prefix'
                  : 'accepted prefix',
            }
          if ([3, 9, messages.length - 1].includes(index))
            return {
              role: message.role,
              content: [
                {
                  type: 'text',
                  text: message.content,
                  cache_control:
                    scenario === 'changed lifetime'
                      ? { type: 'ephemeral' }
                      : marker,
                },
              ],
            }
          return message
        }),
      }
      const outbound = { ...h.input(), bodyText: JSON.stringify(current) }
      expect(
        h.engine.planRouted({ ...outbound, kind: 'summary' }).bodyText,
      ).toBe(outbound.bodyText)
      const { plan } = h.send(outbound)
      expect(plan.kind).toBe('source')
      if (scenario !== 'matching prefix') {
        expect(plan.bodyText).toBe(outbound.bodyText)
        return
      }
      expect(plan).toHaveProperty('sourceCacheMarkerRestored', true)
      const returned = JSON.parse(plan.bodyText)
      expect(returned.messages[0].content[0].cache_control).toEqual(marker)
      expect(returned.messages.at(-1).content[0].cache_control).toEqual(marker)
      expect(JSON.stringify(returned).match(/"cache_control":/g)).toHaveLength(
        4,
      )
      expect(h.send(outbound).plan.bodyText).toBe(outbound.bodyText)
    } finally {
      h.cacheKeep.stop()
    }
  },
)

test.each(['mode', 'credential', 'destination', 'sign-out', 'delete'] as const)(
  '%s while registration waits leaves no warm target',
  async (change) => {
    const h = harness()
    try {
      const wait = Promise.withResolvers<AccountStorage | null>()
      const started = Promise.withResolvers<void>()
      const oauth = h.input().oauth!
      h.send({
        oauth: {
          ...oauth,
          sourceWarm: {
            ...oauth.sourceWarm!,
            loadStorage() {
              started.resolve()
              return wait.promise
            },
          },
        },
      }).lifecycle.onCompleted?.(completion)
      h.start()
      await started.promise
      if (change === 'mode') h.setRoute({ ...route, mode: 'off' })
      if (change === 'credential')
        h.setRoute({ ...route, credentialId: 'replacement-same-account' })
      if (change === 'destination')
        h.setRoute({ ...route, url: 'https://other.test/v1/messages' })
      if (change === 'sign-out') h.engine.forgetAccount(route.accountId)
      if (change === 'delete') h.engine.forgetSession('session')
      wait.resolve(stored)
      await settle()
      h.advance(elapsed)
      await h.cacheKeep.tick()
      expect(h.cacheKeep.trackedSessions()).toEqual([])
      expect(h.sent).toHaveLength(0)
    } finally {
      h.cacheKeep.stop()
    }
  },
)

test('the send rechecks the route after pending warm authorization', async () => {
  const wait = Promise.withResolvers<Headers>()
  const entered = Promise.withResolvers<void>()
  const h = harness({
    prepareHeaders() {
      entered.resolve()
      return wait.promise
    },
  })
  try {
    h.send().lifecycle.onCompleted?.(completion)
    h.start()
    await settle()
    expect(h.cacheKeep.trackedRequest(warmId())).toBeDefined()
    h.advance(elapsed)
    const tick = h.cacheKeep.tick()
    await entered.promise
    h.setRoute({ ...route, credentialId: 'replacement-same-account' })
    wait.resolve(headers)
    await tick
    expect(h.sent).toHaveLength(0)
    expect(h.cacheKeep.trackedRequest(warmId())).toBeUndefined()
  } finally {
    h.cacheKeep.stop()
  }
})

test.each([
  'idle-off',
  'model',
  'history',
  'cache-mode',
  'deleted',
  'account',
  'tampered',
] as const)(
  '%s invalidates an already tracked warm before send',
  async (change) => {
    const h = harness({
      onTargetChanged(target) {
        if (change === 'tampered' && target.sourceWarm) {
          // Simulate a corrupted warm snapshot, not a host editing live history.
          Object.assign(target, {
            bodyText: target.bodyText.replace(
              'accepted prefix',
              'wrong prefix',
            ),
          })
        }
      },
    })
    try {
      h.send().lifecycle.onCompleted?.(completion)
      h.start()
      await settle()
      expect(h.cacheKeep.trackedRequest(warmId())).toBeDefined()
      if (change === 'idle-off') h.setRoute({ ...route, mode: 'off' })
      if (change === 'model')
        h.engine.plan({ ...h.input(), requestedModel: opus })
      if (change === 'history')
        h.engine.plan({
          ...h.input(),
          bodyText: JSON.stringify(refusedBody).replace(
            'refused suffix',
            'edited suffix',
          ),
        })
      if (change === 'cache-mode')
        h.setStorage({
          ...stored,
          claudeCache: { enabled: true, mode: 'explicit' },
        })
      if (change === 'deleted') h.engine.forgetSession('session')
      if (change === 'account') h.setRoute({ ...route, accountId: 'other' })
      h.advance(elapsed)
      await h.cacheKeep.tick()
      expect(h.sent).toHaveLength(0)
      expect(h.cacheKeep.trackedRequest(warmId())).toBeUndefined()
    } finally {
      h.cacheKeep.stop()
    }
  },
)

test('idle history replacement is not used by a later refusal', async () => {
  const h = harness()
  try {
    h.send().lifecycle.onCompleted?.(completion)
    h.engine.plan({
      ...h.input(),
      bodyText: JSON.stringify(body).replace('accepted prefix', 'idle rewrite'),
    })
    h.start()
    await settle()
    expect(h.cacheKeep.trackedRequest(warmId())).toBeUndefined()
  } finally {
    h.cacheKeep.stop()
  }
})

test('at most 128 kept bodies survive, and eviction drops the least recently used', async () => {
  const h = harness()
  try {
    for (let i = 0; i < 128; i++)
      h.send({ sessionId: `session-${i}` }).lifecycle.onCompleted?.(completion)
    h.start({ sessionId: 'session-0' })
    await settle()
    h.send({ sessionId: 'session-128' }).lifecycle.onCompleted?.(completion)
    h.start({ sessionId: 'session-1' })
    h.start({ sessionId: 'session-2' })
    await settle()
    expect(
      h.cacheKeep
        .trackedSessions()
        .map(({ id }) => id)
        .sort(),
    ).toEqual([warmId('session-0'), warmId('session-2')])
  } finally {
    h.cacheKeep.stop()
  }
})

test('local always keeps the same 24-warm cap across a long round and the source return', async () => {
  const h = harness()
  try {
    h.send().lifecycle.onCompleted?.(completion)
    h.start()
    await settle()
    for (let i = 1; i <= 25; i++) {
      if (i <= 10)
        h.send({
          bodyText: JSON.stringify(refusedBody),
        }).lifecycle.onCompleted?.(completion)
      if (i === 11) h.start()
      h.advance(elapsed)
      await h.cacheKeep.tick()
    }
    expect(h.sent).toHaveLength(24)
    expect(h.cacheKeep.trackedRequest(warmId())).toBeUndefined()
  } finally {
    h.cacheKeep.stop()
  }
})

test('released-tool start clears only the earlier template until the first round response completes', () => {
  const h = harness()
  try {
    const seen: Array<string | null> = []
    const onCacheKeepTemplate = (template: { bodyText: string } | null) => {
      seen.push(template?.bodyText ?? null)
    }
    h.send(undefined, { onCacheKeepTemplate }).lifecycle.onCompleted?.(
      completion,
    )
    expect(seen).toEqual([JSON.stringify(body)])
    h.send(
      { bodyText: JSON.stringify(refusedBody) },
      { onCacheKeepTemplate },
    ).lifecycle.onRefusal?.({ ...refusal, category: undefined })
    expect(seen).toEqual([JSON.stringify(body)])
    h.send(
      { bodyText: JSON.stringify(refusedBody) },
      { onCacheKeepTemplate },
    ).lifecycle.onRefusal?.(refusal)
    expect(seen).toEqual([JSON.stringify(body), null])
    const target = h.send(
      { bodyText: JSON.stringify(refusedBody) },
      { onCacheKeepTemplate },
    )
    expect(target.plan.kind).toBe('round')
    expect(seen.length).toBe(2)
    target.lifecycle.onCompleted?.(completion)
    expect(seen[2]).toBe(target.plan.bodyText)
    expect(JSON.parse(seen[2]!).model).toBe(opus)
  } finally {
    h.cacheKeep.stop()
  }
})

test('tracking the completed round template leaves the source warm registered', async () => {
  const h = harness()
  try {
    h.send().lifecycle.onCompleted?.(completion)
    h.start()
    await settle()
    expect(h.cacheKeep.trackedRequest(warmId())).toBeDefined()

    const turn = h.cacheKeep.beginRealTurn('session')
    const target = h.send(
      { bodyText: JSON.stringify(refusedBody) },
      {
        onCacheKeepTemplate: (template) => {
          if (!template) throw new Error('expected accepted target template')
          turn.track({
            url: route.url,
            headers,
            storage: stored,
            cacheMode: 'hybrid',
            bodyText: template.bodyText,
          })
        },
      },
    )
    expect(target.plan.kind).toBe('round')
    target.lifecycle.onCompleted?.(completion)
    expect(h.cacheKeep.trackedRequest('session')?.bodyText).toBe(
      target.plan.bodyText,
    )
    expect(h.cacheKeep.trackedRequest(warmId())).toBeDefined()
  } finally {
    h.cacheKeep.stop()
  }
})

test.each([
  'disabled',
  'schedule',
  'policy-refused',
  'evicted',
  'session-forgotten',
  'retries-exhausted',
  'cost-cap',
] as const)(
  'a source warm retired by %s is not resurrected by target activity or another refusal',
  async (reason) => {
    const h = harness()
    try {
      h.send().lifecycle.onCompleted?.(completion)
      h.start()
      await settle()
      expect(h.cacheKeep.untrack(warmId(), reason)).toBe(true)
      const input = { bodyText: JSON.stringify(refusedBody) }
      for (let i = 0; i < 10; i++) {
        const target = h.send(input)
        expect(target.plan.kind).toBe('round')
        target.lifecycle.onCompleted?.(completion)
      }
      h.start()
      await settle()
      expect(h.cacheKeep.trackedRequest(warmId())).toBeUndefined()

      const freshSource = h.send({
        ...input,
        oauth: { ...h.input().oauth!, targetAllowed: () => false },
      })
      expect(freshSource.plan.kind).toBe('source')
      freshSource.lifecycle.onCompleted?.(completion)
      h.start({
        bodyText: JSON.stringify({
          ...refusedBody,
          messages: [
            ...refusedBody.messages,
            { role: 'user', content: 'a new refusal' },
          ],
        }),
      })
      await settle()
      expect(
        JSON.parse(h.cacheKeep.trackedRequest(warmId())!.bodyText).messages,
      ).toEqual(refusedBody.messages)
    } finally {
      h.cacheKeep.stop()
    }
  },
)
