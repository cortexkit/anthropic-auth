import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  CacheKeepManager,
  reportSessionCacheTouch,
  requestCacheLifetimeMs,
  sessionCacheActivity,
} from '@cortexkit/anthropic-auth-core'
import {
  type OpenCode2HookContext,
  placeholderSecret,
} from '@cortexkit/common-auth/opencode2'
import type { Registration } from '@opencode/plugin/promise/registration'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import * as wireTransform from '../transform'
import type { NativeAnthropicSource } from '../v2/adapter'
import { installNativeAnthropic } from '../v2/install'
import { preparedAnthropicCredential } from '../v2/ownership'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  createFallbackStorage,
  getPlugin,
  syntheticMainHostAuth,
  useTempAccountFile,
  withNativeAdmission,
} from './support/opencode1-pool-fixture.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { MESSAGES_URL } from './test-fetch'

const routingKey = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const previousRouting = globals[routingKey]
const cleanups: Array<() => void | Promise<void>> = []
const detached = () => new Promise((resolve) => setTimeout(resolve, 0))
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await detached()
  if (previousRouting === undefined) delete globals[routingKey]
  else globals[routingKey] = previousRouting
})

class Hooks {
  private readonly callbacks = new Map<
    keyof SessionHooks,
    (input: unknown) => Promise<void> | void
  >()
  inResponseHook = false
  readonly hook: OpenCode2HookContext['session']['hook'] = async (
    name,
    callback,
  ): Promise<Registration> => {
    this.callbacks.set(name, (input) =>
      callback(input as SessionHooks[typeof name]),
    )
    return {
      dispose: async () => {
        this.callbacks.delete(name)
      },
    }
  }
  async run<Name extends keyof SessionHooks>(
    name: Name,
    input: SessionHooks[Name],
  ) {
    const callback = this.callbacks.get(name)
    if (!callback) throw new Error(`Missing ${name} hook`)
    if (name === 'http.response') this.inResponseHook = true
    try {
      await callback(input)
    } finally {
      this.inResponseHook = false
    }
  }
}

const scope = {
  sessionID: 'ses_report_hooks' as SessionHooks['model.request']['sessionID'],
  agent: 'build' as SessionHooks['model.request']['agent'],
  model: {
    providerID:
      'anthropic' as SessionHooks['model.request']['model']['providerID'],
    id: 'claude-sonnet-5' as SessionHooks['model.request']['model']['id'],
  },
  kind: 'primary' as const,
}

async function installed() {
  const hooks = new Hooks()
  const capturedTtls: number[] = []
  const finalWires: Array<{ bodyText: string; ttlMs: number }> = []
  const requests = new Map<string, { attemptId: string; ttlMs: number }>()
  const accepted = new Set<string>()
  const reports: unknown[] = []
  globals[routingKey] = () => ({
    report: (payload: unknown) => {
      expect(hooks.inResponseHook).toBe(false)
      reports.push(payload)
      return new Promise(() => {})
    },
  })
  const source: NativeAnthropicSource<never, { version: number }> = {
    chooseAccount: () => 'main',
    authorizeAccount: () => ({
      route: 'oauth',
      accessToken: 'sk-ant-oat01-synthetic',
      credentialId: 'synthetic-row',
      provenance: { version: 1 },
    }),
    requestOptions: () => ({ cache1hEnabled: false }),
    onRequestPrepared: ({ bodyText }) => {
      capturedTtls.push(requestCacheLifetimeMs(bodyText))
    },
    onFinalRequestPrepared: ({ attemptId, requestId, bodyText, ttlMs }) => {
      finalWires.push({ bodyText, ttlMs })
      if (requestId) requests.set(requestId, { attemptId, ttlMs })
    },
    quotaFromHeaders: (_headers, input) => {
      if (input.status >= 200 && input.status < 300)
        accepted.add(input.attemptId)
      return undefined
    },
    onResponseHandedToHost: (request, handedOff) => {
      const id = request.headers.get('x-client-request-id')
      const fact = id && requests.get(id)
      if (id) requests.delete(id)
      if (handedOff && fact && accepted.delete(fact.attemptId))
        reportSessionCacheTouch(scope.sessionID, {
          at: 42,
          ttlMs: fact.ttlMs,
          source: 'response',
        })
    },
  }
  const native = await installNativeAnthropic(
    { session: hooks },
    { source },
    { credential: preparedAnthropicCredential },
  )
  cleanups.push(() => native.dispose())
  const prepare = async (messages: unknown[]) => {
    const modelDraft = { ...scope, headers: {} as Record<string, string> }
    await hooks.run('model.request', modelDraft)
    const draft = {
      ...scope,
      request: new Request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          ...modelDraft.headers,
          authorization: `Bearer ${placeholderSecret('anthropic')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 128,
          messages,
        }),
      }),
    }
    await hooks.run('http.request', draft)
    return draft
  }
  const respond = async (
    draft: Awaited<ReturnType<typeof prepare>>,
    response: Response,
  ) => {
    const answered = { ...draft, response }
    await hooks.run('http.response', answered)
    await answered.response.text()
    await detached()
  }
  return { hooks, reports, prepare, respond, capturedTtls, finalWires }
}

function reply(id: string) {
  const sse = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  return new Response(
    sse('message_start', {
      type: 'message_start',
      message: { id, content: [{ type: 'text', text: 'Answer' }] },
    }) +
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
      }) +
      sse('message_stop', { type: 'message_stop' }),
    {
      headers: {
        'content-type': 'text/event-stream',
        'request-id': 'req_report_hooks',
      },
    },
  )
}

test('OC2 continuation reports its final markers and lifetime, not the full captured history', async () => {
  const f = await installed()
  const firstPrompt = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'First',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
  }
  const first = await f.prepare([firstPrompt])
  await f.respond(first, reply('msg_report_first'))
  const second = await f.prepare([
    firstPrompt,
    { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Next', cache_control: { type: 'ephemeral' } },
      ],
    },
  ])
  const sent = JSON.parse(await second.request.clone().text())
  expect(sent.thread).toEqual({
    type: 'continue',
    previous_message_id: 'msg_report_first',
  })
  expect(sent.messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Next', cache_control: { type: 'ephemeral' } },
      ],
    },
  ])
  expect(f.capturedTtls).toEqual([300_000, 300_000])
  expect(f.finalWires.map((wire) => wire.ttlMs)).toEqual([300_000, 300_000])
  expect(JSON.parse(f.finalWires[1]!.bodyText).messages).toEqual(sent.messages)
  expect(JSON.parse(f.finalWires[1]!.bodyText).thread).toEqual(sent.thread)
  await f.respond(second, reply('msg_report_second'))
  expect(f.reports).toEqual([
    { kind: 'cache_touch', at: 42, ttl_ms: 300_000, source: 'response' },
    { kind: 'cache_touch', at: 42, ttl_ms: 300_000, source: 'response' },
  ])
})

test('OC2 failed response returns without an accepted touch', async () => {
  const f = await installed()
  const draft = await f.prepare([{ role: 'user', content: 'First' }])
  await f.respond(
    draft,
    Response.json({ error: { type: 'api_error' } }, { status: 500 }),
  )
  expect(f.reports).toEqual([])
})

describe('OC1 final response cache reports', () => {
  const ctx = createOpencode1TestContext()
  installOpencode1TestHooks(ctx)
  describe('keeper-off requests', () => {
    installLoaderSetup(ctx)
    const oc1Test = createOpencode1Test(ctx)
    oc1Test.each([
      { ttl: 'none', ttlMs: 0 },
      { ttl: 'short', ttlMs: 300_000 },
      { ttl: 'long', ttlMs: 3_600_000 },
    ])(
      'accepted OAuth reports its actual TTL with the keeper off',
      async ({ ttl, ttlMs }) => {
        await useTempAccountFile(
          ctx,
          createFallbackStorage({
            accounts: [],
            quota: { enabled: false },
            refresh: { enabled: false },
            claudeCache: { enabled: true, mode: 'hybrid' },
            cacheKeep: { enabled: false },
          }),
        )
        let handedOff = false
        const reports: Record<string, unknown>[] = []
        globals[routingKey] = () => ({
          cache: () => ({ ttl, keep_warm: 'off' }),
          report: (payload: Record<string, unknown>) => {
            if (
              payload.kind !== 'cache_touch' &&
              payload.kind !== 'cache_warm_stopped'
            )
              return
            expect(handedOff).toBe(true)
            reports.push(payload)
            return new Promise(() => {})
          },
        })
        globalThis.fetch = mock(
          withNativeAdmission(ctx, async () =>
            ttl === 'short'
              ? new Response(
                  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_oc1_report","usage":{"cache_read_input_tokens":9,"cache_creation_input_tokens":5,"input_tokens":10000}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"cache_creation_input_tokens":6,"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
                  { headers: { 'content-type': 'text/event-stream' } },
                )
              : Response.json({
                  content: [],
                  usage: {
                    cache_read_input_tokens: 9,
                    cache_creation_input_tokens: 5,
                    input_tokens: 10_000,
                  },
                }),
          ),
        ) as unknown as typeof fetch
        const usage = spyOn(CacheKeepManager.prototype, 'recordAcceptedUsage')
        cleanups.push(() => usage.mockRestore())
        const plugin = await getPlugin(ctx)
        const loader = await plugin.auth.loader(
          () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
          { models: {} },
        )
        const before = Date.now()
        const response = await loader.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: { 'x-session-affinity': 'ses_oc1_reports' },
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            ...(ttl === 'short' && { stream: true }),
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        })
        handedOff = true
        await response.text()
        await detached()
        expect(reports).toEqual([
          {
            kind: 'cache_touch',
            at: expect.any(Number),
            ttl_ms: ttlMs,
            source: 'response',
          },
        ])
        expect(reports[0]!.at as number).toBeGreaterThanOrEqual(before)
        expect(reports[0]!.at as number).toBeLessThanOrEqual(Date.now())
        expect(usage).toHaveBeenCalledWith(
          'ses_oc1_reports',
          expect.any(String),
          {
            cache_read_input_tokens: 9,
            cache_creation_input_tokens: 5,
            input_tokens: 10_000,
          },
        )
        if (ttl === 'short')
          expect(usage).toHaveBeenCalledWith(
            'ses_oc1_reports',
            expect.any(String),
            {
              cache_read_input_tokens: 9,
              cache_creation_input_tokens: 6,
              input_tokens: 10_000,
              output_tokens: 1,
            },
          )
      },
    )
    oc1Test.each(['unmarked', 'ttl-child'] as const)(
      'legacy local admission for %s',
      async (scenario) => {
        await useTempAccountFile(
          ctx,
          createFallbackStorage({
            accounts: [],
            quota: { enabled: false },
            refresh: { enabled: false },
            claudeCache: { enabled: true, mode: 'hybrid' },
            cacheKeep: { enabled: true, always: true, subagents: false },
          }),
        )
        const reports: Record<string, unknown>[] = []
        globals[routingKey] = () => ({
          cache: () => (scenario === 'ttl-child' ? { ttl: 'long' } : null),
          report: (payload: Record<string, unknown>) => {
            if (payload.kind === 'cache_touch') reports.push(payload)
          },
        })
        if (scenario === 'unmarked') {
          const original = wireTransform.rewriteRequestBody
          const rewrite = spyOn(
            wireTransform,
            'rewriteRequestBody',
          ).mockImplementation(async (...args) => {
            const body = JSON.parse((await original(...args))!)
            const strip = (value: any) => {
              if (!value || typeof value !== 'object') return
              delete value.cache_control
              delete value.cacheControl
              for (const child of Object.values(value)) strip(child)
            }
            strip(body)
            return JSON.stringify(body)
          })
          cleanups.push(() => rewrite.mockRestore())
        }
        globalThis.fetch = mock(
          withNativeAdmission(ctx, async () =>
            Response.json({ content: [], usage: {} }),
          ),
        ) as unknown as typeof fetch
        const originalTrack = CacheKeepManager.prototype.track
        let kept: ReturnType<CacheKeepManager['trackedRequest']>
        let tracked = false
        const track = spyOn(
          CacheKeepManager.prototype,
          'track',
        ).mockImplementation(function (this: CacheKeepManager, input) {
          const result = originalTrack.call(this, input)
          if (input.sessionId === 'ses_oc1_legacy_review') {
            tracked = result.tracked
            kept = this.trackedRequest(input.sessionId)
          }
          return result
        })
        cleanups.push(() => track.mockRestore())
        const plugin = await getPlugin(ctx)
        const loader = await plugin.auth.loader(
          () => Promise.resolve({ type: 'oauth', ...syntheticMainHostAuth() }),
          { models: {} },
        )
        const before = Date.now()
        const response = await loader.fetch(MESSAGES_URL, {
          method: 'POST',
          headers: {
            'x-session-affinity': 'ses_oc1_legacy_review',
            ...(scenario === 'ttl-child' && {
              'x-parent-session-id': 'ses_parent',
            }),
          },
          body: JSON.stringify({
            model: 'claude-opus-4-8',
            messages: [{ role: 'user', content: 'Hello' }],
          }),
        })
        await response.text()
        await detached()
        if (scenario === 'unmarked') {
          expect(reports).toEqual([
            {
              kind: 'cache_touch',
              at: expect.any(Number),
              ttl_ms: 0,
              source: 'response',
            },
          ])
          expect(
            sessionCacheActivity.holdUntil(
              'ses_oc1_legacy_review',
              'main',
              before,
              'max',
            ),
          ).toBeGreaterThanOrEqual(before + 3_600_000)
          expect(tracked).toBe(true)
          expect(kept?.cacheExpiresAt).toBeGreaterThanOrEqual(
            before + 3_600_000,
          )
        } else expect(tracked).toBe(false)
      },
    )
  })
})
