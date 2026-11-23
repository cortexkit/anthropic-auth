import { expect, test as registerTest, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  buildCacheKeepPrewarmBody,
  CACHE_KEEP_EXTENDED_TTL_BETA,
  CacheKeepManager,
  type NativeCustodyClient as ClaustrumScopedClient,
  cacheKeepStoreDirectory,
  createNativeAccountRuntime,
  getClaudeCodeIdentityForVerifiedAccount,
  getLogLevel,
  type LogTestRecord,
  MessageThreadTracker,
  NativeCustodyError,
  PER_TURN_CONTROL_BETA,
  resolveNativePoolPaths,
  sessionCacheActivity,
  setLogLevel,
  signRequestBody,
  stripBillingLineageFields,
  WORKER_SCRIPT,
} from '@cortexkit/anthropic-auth-core'
import {
  ClaustrumCredentialError,
  type ScopedInventoryRow,
} from '@cortexkit/claustrum-client'
import type {
  Api,
  AssistantMessage,
  Context,
  Credential,
  CredentialStore,
  Model,
  Provider,
} from '@earendil-works/pi-ai'
import {
  isRetryableAssistantError,
  normalizeContext,
} from '@earendil-works/pi-ai'
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  ModelRuntime,
  type ProviderConfig,
} from '@earendil-works/pi-coding-agent'
import { nativeVaultPaths } from '../../../core/src/native-vault-paths.ts'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'
import {
  recordedTimers,
  watchableVaultClient,
} from '../../../core/src/tests/vault-watch-fixture.ts'
import { PiCacheKeep } from '../cachekeep.ts'
import { piForkEffortSnapshots } from '../forks.ts'
import cortexKitPiAnthropicAuth from '../index.ts'
import {
  closePiNativeRuntime,
  getPiNativeRuntime,
  PI_VAULT_POLL_INTERVAL_MS,
  PiNativeRuntime,
} from '../native.ts'
import {
  __prewarmPiCacheKeepForTest,
  __sendPiAnthropicRequestForTest,
  beginPiPrimaryTurn,
  endPiPrimaryTurn,
  forgetPiMessageThread,
  getPiTrackedCacheKeepSessions,
  startPiCacheKeepSession,
  stopPiCacheKeep,
  streamCortexKitAnthropic,
} from '../stream.ts'
import {
  fixtureAccountIdentity,
  readNativePiFixture,
  saveNativePiFixture,
} from './native-fixture.ts'
import { trackPiTestBody } from './setup.ts'

const originalFetch = globalThis.fetch
const lifetimes = createTestLifetimeSuite()
const { deferCleanup } = lifetimes
function captureBilling() {
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const previous = globals[key]
  const reports: Record<string, unknown>[] = []
  const sessions: string[] = []
  globals[key] = (sessionId: string) => ({
    report: (payload: Record<string, unknown>) => {
      if (payload.kind !== 'billing') return
      sessions.push(sessionId)
      reports.push(payload)
    },
  })
  deferCleanup(() => {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  })
  return { reports, sessions }
}
const wrapBody = <Args extends unknown[]>(body: (...args: Args) => unknown) =>
  lifetimes.wrapBody((...args: Args) =>
    trackPiTestBody(Promise.resolve().then(() => body(...args))),
  )
const test = (name: string, body: () => unknown, timeout?: number) =>
  registerTest(name, wrapBody(body), timeout)
let dir: string | undefined
let path: string | undefined
const model: Model<Api> = {
  id: 'claude-fable-5-1',
  name: 'Fable',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
}
const context: Context = {
  systemPrompt: 'Test',
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
  tools: [],
}

const forkRoutingOriginals = new WeakMap<object, unknown>()
function forkRouting(
  accountFor?: () => Promise<unknown>,
  extras: (sessionId: string) => Record<string, unknown> = () => ({}),
) {
  const globals = globalThis as Record<symbol, unknown>
  const key = Symbol.for('cortexkit.routing')
  const previous = globals[key]
  // Fixture cleanups run FIFO. Replacing a handle twice must restore the
  // pre-test handle, not leave the first replacement in the next test.
  const original =
    typeof previous === 'function' && forkRoutingOriginals.has(previous)
      ? forkRoutingOriginals.get(previous)
      : previous
  const reports: Array<{
    sessionId: string
    payload: Record<string, unknown>
  }> = []
  const asks: string[] = []
  const accessor = (sessionId: string) => ({
    accountFor: async () => {
      asks.push(sessionId)
      return (
        accountFor?.() ?? {
          account_id: fixtureAccountIdentity('main'),
          credential_id: 'oauth:anthropic',
        }
      )
    },
    report: (payload: Record<string, unknown>) =>
      reports.push({ sessionId, payload }),
    ...extras(sessionId),
  })
  forkRoutingOriginals.set(accessor, original)
  globals[key] = accessor
  deferCleanup(() => {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  })
  return { reports, asks }
}

function forkOptions(
  headSessionId: string,
  sessionId = `${headSessionId}-fork`,
) {
  return {
    sessionId,
    cortexkitFork: { headSessionId },
    reasoning: 'high' as const,
  }
}

function forkContext(base: Context, branchLength = 0): Context {
  const answer: AssistantMessage = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'Head answer' }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: 1,
  }
  return {
    ...base,
    messages: [
      ...base.messages,
      answer,
      ...Array.from({ length: branchLength }, (_, i) => [
        {
          role: 'user' as const,
          content: `Earlier fork question ${i}`,
          timestamp: i + 2,
        },
        { ...answer, timestamp: i + 3 },
      ]).flat(),
      { role: 'user', content: 'Fork question', timestamp: 100 },
    ],
  }
}

function normalizedForkBody(text: string) {
  return JSON.parse(
    text.replace(/cch=[a-f0-9]+/g, 'cch=SIGNATURE'),
    (key, value) => (key === 'cache_control' ? undefined : value),
  )
}

function stateBytes(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    item instanceof Map || item instanceof Set ? [...item] : item,
  )
}

async function flushForkReports() {
  // Billing and cache-touch callbacks run on zero-delay timers after the reply.
  // Queue this fence after them so a missing report cannot pass merely early.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

for (const mode of [
  'plain',
  'multi-turn',
  'newer effort',
  'turn notes',
  'head TTL',
  'long branch',
] as const) {
  test(`Pi fork preserves the head cache prefix: ${mode}`, async () => {
    const f = await fixture()
    const head = `fork-prefix-${mode}-${f.path}`
    const fork = `${head}-fork`
    const note = { after_tool_use_id: 'tool-1', text: 'Runner base note' }
    const notesReads: string[] = []
    const policyReads: string[] = []
    let headAdvanced = false
    const routing = forkRouting(undefined, (sessionId) => ({
      turn_notes: () => {
        notesReads.push(sessionId)
        return mode === 'turn notes'
          ? [
              {
                ...note,
                text:
                  headAdvanced && sessionId === head
                    ? 'New head note'
                    : note.text,
              },
            ]
          : []
      },
      cache: () => {
        policyReads.push(sessionId)
        return mode === 'head TTL'
          ? {
              ttl: headAdvanced && sessionId === head ? 'short' : 'long',
              keep_warm: 'off',
            }
          : null
      },
    }))
    const base: Context =
      mode === 'multi-turn'
        ? forkContext(context)
        : mode === 'long branch'
          ? {
              ...context,
              tools: [
                {
                  name: 'read',
                  description: 'Read a file',
                  parameters: { type: 'object', properties: {} },
                },
              ],
            }
          : mode === 'turn notes'
            ? {
                ...context,
                messages: [
                  context.messages[0]!,
                  {
                    ...(forkContext(context).messages[1] as AssistantMessage),
                    content: [
                      {
                        type: 'toolCall',
                        id: 'tool-1',
                        name: 'read',
                        arguments: {},
                      },
                    ],
                  },
                  {
                    role: 'toolResult',
                    toolCallId: 'tool-1',
                    toolName: 'read',
                    content: [{ type: 'text', text: 'File read' }],
                    isError: false,
                    timestamp: 2,
                  },
                ],
              }
            : context
    const bodies: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const bytes = Buffer.from(await request.arrayBuffer())
        bodies.push(
          request.headers.get('content-encoding') === 'gzip'
            ? gunzipSync(bytes).toString()
            : bytes.toString(),
        )
        return success()
      },
    })
    deferCleanup(() => server.stop(true))
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).includes('/api/oauth/usage')) return Response.json({})
        return originalFetch(server.url, init)
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    const history = [{ afterAssistantMessages: 0, effort: 'low' as const }]
    expect(
      (
        await streamCortexKitAnthropic(
          model,
          base,
          { sessionId: head, reasoning: 'high' },
          history,
        ).result()
      ).stopReason,
    ).toBe('stop')
    headAdvanced = true
    if (mode === 'newer effort') {
      const next = forkContext(base)
      next.messages[next.messages.length - 1] = {
        role: 'user',
        content: 'New head turn',
        timestamp: 10,
      }
      expect(
        (
          await streamCortexKitAnthropic(
            model,
            next,
            { sessionId: head, reasoning: 'high' },
            [
              ...history,
              {
                afterAssistantMessages:
                  base.messages.filter((m) => m.role === 'assistant').length +
                  1,
                effort: 'high',
              },
            ],
          ).result()
        ).stopReason,
      ).toBe('stop')
    }
    const before = JSON.stringify(await getPiTrackedCacheKeepSessions())
    const result = await streamCortexKitAnthropic(
      model,
      forkContext(base, mode === 'long branch' ? 30 : 0),
      forkOptions(head),
      mode === 'plain'
        ? history
        : [...history, { afterAssistantMessages: 1, effort: 'high' }],
    ).result()
    expect(result.stopReason).toBe('stop')
    const headBody = normalizedForkBody(bodies[0]!)
    const forkBody = normalizedForkBody(bodies.at(-1)!)
    expect(
      JSON.stringify(forkBody.messages.slice(0, headBody.messages.length)),
    ).toBe(JSON.stringify(headBody.messages))
    expect(
      forkBody.messages.filter(
        (message: Record<string, unknown>) => message.output_config,
      ),
    ).toEqual([])
    const rawHead = JSON.parse(bodies[0]!)
    const rawFork = JSON.parse(bodies.at(-1)!)
    const blocks = rawFork.messages.flatMap(
      (message: { content: unknown[] }) => message.content,
    ) as Record<string, unknown>[]
    const baseBlock =
      rawFork.messages[headBody.messages.length - 1].content.at(-1)
    const basePosition = blocks.indexOf(baseBlock)
    const markerPositions = blocks.flatMap((block, index) =>
      block.cache_control ? [index] : [],
    )
    expect(
      markerPositions.some(
        (position) => position >= basePosition && position - basePosition <= 20,
      ),
    ).toBe(true)
    expect(Boolean(baseBlock.cache_control)).toBe(mode === 'long branch')
    if (mode === 'long branch')
      expect(rawFork.messages[0].content[0].cache_control).toBeUndefined()
    if (mode === 'turn notes') expect(bodies[0]).toContain(note.text)
    if (mode === 'head TTL') {
      expect(bodies[0]).toContain('"ttl":"1h"')
      expect(bodies.at(-1)).toContain('"ttl":"1h"')
    }
    const countMarkers = (body: typeof rawHead) =>
      [
        body,
        ...(body.system ?? []),
        ...(body.tools ?? []),
        ...body.messages,
        ...body.messages.flatMap(
          (message: { content: unknown[] }) => message.content,
        ),
      ].filter((holder) => holder.cache_control).length
    expect(countMarkers(rawFork)).toBeLessThanOrEqual(4)
    delete headBody.messages
    delete forkBody.messages
    expect(JSON.stringify(forkBody)).toBe(JSON.stringify(headBody))
    expect(JSON.stringify(await getPiTrackedCacheKeepSessions())).toBe(before)
    expect(sessionCacheActivity.ttlMs(head)).toBe(
      mode === 'head TTL' ? 3_600_000 : 300_000,
    )
    expect(routing.asks.at(-1)).toBe(fork)
    await flushForkReports()
    expect(
      routing.reports.some(
        (r) => r.sessionId === head && r.payload.kind === 'billing',
      ),
    ).toBe(true)
    expect(
      routing.reports.filter(
        (r) => r.sessionId === fork && r.payload.kind === 'billing',
      ),
    ).toEqual([])
    expect(
      routing.reports.some(
        (r) => r.sessionId === fork && r.payload.outcome === 'served',
      ),
    ).toBe(true)
    expect(
      routing.reports.filter(
        (r) => r.sessionId === fork && r.payload.kind === 'cache_touch',
      ),
    ).toEqual([])
    expect(notesReads).toContain(fork)
    expect(policyReads).toContain(fork)
  })
}

type ForkEffortLevel = 'low' | 'medium' | 'high'

/** Run one head turn, then the same fork once per hint (undefined: no hint). */
async function runForkEffortHints(options: {
  modelId: string
  reasoning?: ForkEffortLevel
  base?: Context
  history: Array<{ afterAssistantMessages: number; effort: ForkEffortLevel }>
  hints: unknown[]
}) {
  const f = await fixture()
  const head = `fork-effort-${options.modelId}-${f.path}`
  forkRouting()
  const bodies: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const bytes = Buffer.from(await request.arrayBuffer())
      bodies.push(
        request.headers.get('content-encoding') === 'gzip'
          ? gunzipSync(bytes).toString()
          : bytes.toString(),
      )
      return success()
    },
  })
  deferCleanup(() => server.stop(true))
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/api/oauth/usage')) return Response.json({})
      return originalFetch(server.url, init)
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  const forkModel = { ...model, id: options.modelId }
  const base = options.base ?? context
  const reasoning = options.reasoning ?? 'high'
  expect(
    (
      await streamCortexKitAnthropic(
        forkModel,
        base,
        { sessionId: head, reasoning },
        options.history,
      ).result()
    ).stopReason,
  ).toBe('stop')
  const runs: Array<{
    body: string
    reply: AssistantMessage & { cortexkitFork?: unknown }
  }> = []
  for (const effort of options.hints) {
    const forkStreamOptions = {
      sessionId: `${head}-fork`,
      reasoning,
      cortexkitFork: {
        headSessionId: head,
        ...(effort !== undefined && { effort }),
      },
    }
    const reply = await streamCortexKitAnthropic(
      forkModel,
      forkContext(base),
      forkStreamOptions,
      options.history,
    ).result()
    expect(reply.stopReason).toBe('stop')
    runs.push({ body: bodies.at(-1)!, reply })
  }
  return runs
}

const withoutSignature = (text: string) =>
  text.replace(/cch=[a-f0-9]+/g, 'cch=SIGNATURE')

function expectQuestionEffort(
  hinted: string,
  unhinted: string,
  effort: ForkEffortLevel,
  topLevel: ForkEffortLevel,
) {
  const plain = normalizedForkBody(unhinted)
  const lowered = normalizedForkBody(hinted)
  expect(lowered.messages).toHaveLength(plain.messages.length + 1)
  // Every message before the question is what the head cached.
  expect(JSON.stringify(lowered.messages.slice(0, -2))).toBe(
    JSON.stringify(plain.messages.slice(0, -1)),
  )
  expect(lowered.messages.at(-2)).toEqual({
    role: 'system',
    content: [],
    output_config: { effort },
  })
  expect(JSON.stringify(lowered.messages.at(-1))).toBe(
    JSON.stringify(plain.messages.at(-1)),
  )
  expect(lowered.output_config).toEqual({ effort: topLevel })
  delete plain.messages
  delete lowered.messages
  expect(JSON.stringify(lowered)).toBe(JSON.stringify(plain))
}

for (const modelId of [
  'claude-fable-5-1',
  'claude-fable-5-2',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-mythos-5-2',
  'claude-opus-5',
  'claude-mythos-5-1',
]) {
  test(`Pi fork answers its question at a lower effort hint: ${modelId}`, async () => {
    const [plain, lowered] = await runForkEffortHints({
      modelId,
      history: [{ afterAssistantMessages: 0, effort: 'high' }],
      hints: [undefined, 'low'],
    })
    expectQuestionEffort(lowered!.body, plain!.body, 'low', 'high')
    expect(lowered!.reply.cortexkitFork).toEqual({ effortApplied: 'low' })
    expect(plain!.reply).not.toHaveProperty('cortexkitFork')
  })
}

for (const modelId of ['claude-fable-5-1', 'claude-opus-5-5']) {
  test(`Pi fork ignores an equal, higher or invalid effort hint: ${modelId}`, async () => {
    const [plain, ...ignored] = await runForkEffortHints({
      modelId,
      reasoning: 'medium',
      history: [{ afterAssistantMessages: 0, effort: 'medium' }],
      hints: [undefined, 'medium', 'high', 'xhigh', 'minimal', 'LOW', 1, null],
    })
    for (const run of ignored) {
      expect(withoutSignature(run.body)).toBe(withoutSignature(plain!.body))
      expect(run.reply).not.toHaveProperty('cortexkitFork')
    }
  })
}

for (const modelId of ['claude-fable-5', 'claude-mythos-5']) {
  test(`Pi fork ignores the effort hint on a model without per-message effort: ${modelId}`, async () => {
    const [plain, hinted] = await runForkEffortHints({
      modelId,
      history: [{ afterAssistantMessages: 0, effort: 'high' }],
      hints: [undefined, 'low'],
    })
    expect(withoutSignature(hinted!.body)).toBe(withoutSignature(plain!.body))
    expect(hinted!.reply).not.toHaveProperty('cortexkitFork')
  })
}

test('Pi fork compares its effort hint with the effort in force at the question', async () => {
  // The head lowered effort to medium on its second turn, so medium is not a
  // change for the fork's question even though the top-level effort is high.
  const base: Context = {
    ...context,
    messages: [
      ...forkContext(context).messages.slice(0, 2),
      { role: 'user', content: 'Second head turn', timestamp: 2 },
    ],
  }
  const [plain, medium, low] = await runForkEffortHints({
    modelId: 'claude-fable-5-1',
    base,
    history: [
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'medium' },
    ],
    hints: [undefined, 'medium', 'low'],
  })
  const plainBody = normalizedForkBody(plain!.body)
  expect(plainBody.output_config).toEqual({ effort: 'high' })
  expect(
    plainBody.messages.filter(
      (message: Record<string, unknown>) => message.output_config,
    ),
  ).toEqual([
    { role: 'system', content: [], output_config: { effort: 'medium' } },
  ])
  expect(withoutSignature(medium!.body)).toBe(withoutSignature(plain!.body))
  expect(medium!.reply).not.toHaveProperty('cortexkitFork')
  expectQuestionEffort(low!.body, plain!.body, 'low', 'high')
  expect(low!.reply.cortexkitFork).toEqual({ effortApplied: 'low' })
})

test('Pi ignores an effort hint on a request that is not a valid fork', async () => {
  const f = await fixture()
  const session = `not-a-fork-${f.path}`
  forkRouting()
  const bodies: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const bytes = Buffer.from(await request.arrayBuffer())
      bodies.push(
        request.headers.get('content-encoding') === 'gzip'
          ? gunzipSync(bytes).toString()
          : bytes.toString(),
      )
      return success()
    },
  })
  deferCleanup(() => server.stop(true))
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/api/oauth/usage')) return Response.json({})
      return originalFetch(server.url, init)
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  const history = [{ afterAssistantMessages: 0, effort: 'high' as const }]
  const conversation = forkContext(context)
  const replies: Array<AssistantMessage & { cortexkitFork?: unknown }> = []
  for (const index of [0, 1, 2]) {
    const sessionId = `${session}-${index}`
    // No fork, a fork object without a head, and a fork naming itself as head.
    const cortexkitFork = [
      undefined,
      { effort: 'low' },
      { headSessionId: sessionId, effort: 'low' },
    ][index]
    const streamOptions = {
      sessionId,
      reasoning: 'high' as const,
      ...(cortexkitFork && { cortexkitFork }),
    }
    const reply = await streamCortexKitAnthropic(
      model,
      conversation,
      streamOptions,
      history,
    ).result()
    expect(reply.stopReason).toBe('stop')
    replies.push(reply)
  }
  expect(bodies).toHaveLength(3)
  const [plain, ...stray] = bodies.map((body) => normalizedForkBody(body))
  for (const [index, body] of stray.entries()) {
    expect(JSON.stringify(body.messages)).toBe(JSON.stringify(plain.messages))
    expect(body.output_config).toEqual(plain.output_config)
    expect(replies[index + 1]).not.toHaveProperty('cortexkitFork')
  }
  expect(
    plain.messages.filter(
      (message: Record<string, unknown>) => message.output_config,
    ),
  ).toEqual([])
})

for (const failure of [
  'absent',
  'null',
  'timeout',
  'error',
  'refusal',
  'unknown',
  'unavailable',
] as const) {
  test(`Pi fork refuses ${failure} routing without a model send`, async () => {
    const f = await fixture()
    const head = `fork-refusal-${failure}-${f.path}`
    const globals = globalThis as Record<symbol, unknown>
    forkRouting()
    let sends = 0
    globalThis.fetch = Object.assign(
      async () => {
        sends++
        return success()
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    expect(
      (
        await streamCortexKitAnthropic(model, context, {
          sessionId: head,
        }).result()
      ).stopReason,
    ).toBe('stop')
    sends = 0
    const timedOutAnswer = lifetimes.gate()
    forkRouting(async () => {
      if (failure === 'null') return null
      if (failure === 'timeout') {
        await timedOutAnswer.wait
        return null
      }
      if (failure === 'error') throw new Error('Prompt-bearing routing failure')
      if (failure === 'refusal')
        return { refused: { code: 'account_selection_refused' } }
      if (failure === 'unknown')
        return { account_id: 'unknown', credential_id: 'unknown' }
      return {
        account_id: fixtureAccountIdentity('main'),
        credential_id: 'oauth:anthropic',
      }
    })
    if (failure === 'absent') delete globals[Symbol.for('cortexkit.routing')]
    if (failure === 'unavailable') {
      f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
      await (await f.native.service()).vault.refresh()
    }
    const result = await streamCortexKitAnthropic(
      model,
      forkContext(context),
      forkOptions(head),
    ).result()
    timedOutAnswer.open()
    expect(result.stopReason).toBe('error')
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(result.errorMessage).not.toContain('Prompt-bearing')
    expect(sends).toBe(0)
  })
}

for (const confirmed of [true, false]) {
  test(`Pi fork ${confirmed ? 'ends on a confirmed limit' : 'retries an unconfirmed limit twice on its admitted account'}`, async () => {
    const f = await fixture()
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: fixtureAccountIdentity(
        credentialId === 'oauth:other' ? 'other' : 'main',
      ),
      material: credentialId,
      recordVersion: 1,
      expiresAtMs: Date.now() + 600_000,
    })
    f.rows.push(row('oauth:other', fixtureAccountIdentity('other')))
    await (await f.native.service()).vault.refresh()
    const head = `fork-limit-${confirmed}-${f.path}`
    const routing = forkRouting()
    const sent: string[] = []
    let limited = false
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).includes('/api/oauth/usage')) return Response.json({})
        sent.push(new Headers(init?.headers).get('authorization') ?? '')
        return limited
          ? Response.json(
              { error: { type: 'rate_limit_error' } },
              {
                status: 429,
                headers: confirmed
                  ? { 'anthropic-ratelimit-unified-5h-status': 'rejected' }
                  : {},
              },
            )
          : success()
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    expect(
      (
        await streamCortexKitAnthropic(model, context, {
          sessionId: head,
        }).result()
      ).stopReason,
    ).toBe('stop')
    limited = true
    sent.length = 0
    const send = () =>
      streamCortexKitAnthropic(
        model,
        forkContext(context),
        forkOptions(head),
      ).result()
    if (!confirmed) {
      expect(isRetryableAssistantError(await send())).toBe(true)
      expect(isRetryableAssistantError(await send())).toBe(true)
    }
    const result = await send()
    expect(result.stopReason).toBe('error')
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(sent).toHaveLength(confirmed ? 1 : 3)
    expect(new Set(sent).size).toBe(1)
    expect(
      routing.reports.filter(
        (r) =>
          r.sessionId === `${head}-fork` && r.payload.outcome === 'exhausted',
      ),
    ).toHaveLength(confirmed ? 1 : 0)
    expect(
      routing.reports.filter(
        (r) => r.sessionId === `${head}-fork` && r.payload.kind === 'billing',
      ),
    ).toEqual([])
  })
}

test('Pi fork reports an upstream error as a failed request, not an account refusal', async () => {
  const f = await fixture()
  const head = `fork-upstream-error-${f.path}`
  forkRouting()
  let failing = false
  let sends = 0
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('/api/oauth/usage')) return Response.json({})
      if (!failing) return success()
      sends += 1
      return Response.json(
        { error: { type: 'overloaded_error' } },
        { status: 529 },
      )
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: head,
      }).result()
    ).stopReason,
  ).toBe('stop')
  failing = true
  const result = await streamCortexKitAnthropic(
    model,
    forkContext(context),
    forkOptions(head),
  ).result()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('failed before an answer arrived')
  expect(result.errorMessage).not.toContain('cannot serve')
  expect(sends).toBe(1)
})

test('Pi fork trusts the named account despite unknown quota and local floors', async () => {
  const f = await fixture()
  const head = `fork-trusted-${f.path}`
  forkRouting()
  const sent: string[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/api/oauth/usage')) return Response.json({})
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return success()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: head,
      }).result()
    ).stopReason,
  ).toBe('stop')
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    quota: {
      enabled: true,
      failClosedOnUnknownQuota: true,
      minimumRemaining: { five_hour: 99, seven_day: 99 },
    },
    killswitch: { enabled: true, main: { five_hour: 99 } },
  }))
  f.rows.push(row('oauth:other', fixtureAccountIdentity('other')))
  await runtime.vault.refresh()
  f.client.getScoped = async ({ credentialId }) => ({
    credentialId,
    accountId: fixtureAccountIdentity(
      credentialId === 'oauth:other' ? 'other' : 'main',
    ),
    material: credentialId,
    recordVersion: 10,
    expiresAtMs: Date.now() + 600_000,
  })
  forkRouting(async () => ({
    account_id: fixtureAccountIdentity('other'),
    credential_id: 'oauth:other',
  }))
  const result = await streamCortexKitAnthropic(
    model,
    forkContext(context),
    forkOptions(head),
  ).result()
  expect(result.stopReason).toBe('stop')
  expect(sent.at(-1)).toBe('Bearer oauth:other')
})

test('Pi fork leaves head leases, keep-warm tracking and effort provenance untouched', async () => {
  const f = await fixture()
  const head = `fork-state-${f.path}`
  forkRouting()
  globalThis.fetch = Object.assign(async () => success(), {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch
  const history = [{ afterAssistantMessages: 0, effort: 'low' as const }]
  expect(
    (
      await streamCortexKitAnthropic(
        model,
        context,
        { sessionId: head },
        history,
      ).result()
    ).stopReason,
  ).toBe('stop')
  const effortBefore = stateBytes(piForkEffortSnapshots)
  const keepBefore = JSON.stringify(await getPiTrackedCacheKeepSessions())
  const lease = spyOn(PiCacheKeep.prototype, 'requestTurn')
  const track = spyOn(PiCacheKeep.prototype, 'trackAccepted')
  deferCleanup(() => {
    lease.mockRestore()
    track.mockRestore()
  })
  sessionCacheActivity.forget(head)
  expect(sessionCacheActivity.holdUntil(head, 'main')).toBeUndefined()
  const result = await streamCortexKitAnthropic(
    model,
    forkContext(context),
    forkOptions(head),
    [...history, { afterAssistantMessages: 1, effort: 'high' }],
  ).result()
  expect(result.stopReason).toBe('stop')
  expect(lease).not.toHaveBeenCalled()
  expect(track).not.toHaveBeenCalled()
  expect(stateBytes(piForkEffortSnapshots)).toBe(effortBefore)
  expect(JSON.stringify(await getPiTrackedCacheKeepSessions())).toBe(keepBefore)
  expect(sessionCacheActivity.holdUntil(head, 'main')).toBeGreaterThan(
    Date.now(),
  )
  expect(sessionCacheActivity.holdUntil(`${head}-fork`, 'main')).toBeUndefined()
})

test('Pi fork never reads or replaces a head thread anchor, even with primary-turn hooks', async () => {
  // Finish saving the head's keep-warm target before the fixture restores the
  // registry directory, or a late save can leave a target in the next test.
  deferCleanup(() => stopPiCacheKeep())
  const f = await fixture()
  const head = `fork-thread-${f.path}`
  const fork = `${head}-fork`
  forkRouting(undefined, () => ({
    cache: () => ({ ttl: 'long', keep_warm: 'always' }),
  }))
  await startPiCacheKeepSession(f.path, head)
  const sent: Array<Record<string, unknown>> = []
  const response = () =>
    new Response(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_head","content":[]}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Head answer"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(
        JSON.parse(
          new Headers(init?.headers).get('content-encoding') === 'gzip'
            ? gunzipSync(init?.body as Uint8Array).toString()
            : String(init?.body),
        ),
      )
      return response()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  let threadTracker: MessageThreadTracker | undefined
  let cacheKeep: PiCacheKeep | undefined
  const prepareOriginal = MessageThreadTracker.prototype.prepare
  const thread = spyOn(
    MessageThreadTracker.prototype,
    'prepare',
  ).mockImplementation(function (this: MessageThreadTracker, input) {
    threadTracker = this
    return prepareOriginal.call(this, input)
  })
  const leaseOriginal = PiCacheKeep.prototype.requestTurn
  const lease = spyOn(PiCacheKeep.prototype, 'requestTurn').mockImplementation(
    function (this: PiCacheKeep, sessionId) {
      cacheKeep = this
      return leaseOriginal.call(this, sessionId)
    },
  )
  const track = spyOn(PiCacheKeep.prototype, 'trackAccepted')
  deferCleanup(() => {
    thread.mockRestore()
    lease.mockRestore()
    track.mockRestore()
    endPiPrimaryTurn(f.path, head)
    endPiPrimaryTurn(f.path, fork)
    forgetPiMessageThread(head)
  })
  const hooks = {
    onPayload: (payload: unknown) => payload,
    onResponse: () => {},
    onProviderStreamEvent: () => {},
  }
  beginPiPrimaryTurn(f.path, head)
  const answer = await streamCortexKitAnthropic(
    model,
    context,
    { sessionId: head, ...hooks },
    undefined,
    undefined,
    'agent-loop',
  ).result()
  expect(answer.stopReason).toBe('stop')
  await Promise.all(track.mock.results.map((result) => result.value))
  expect(sent[0]?.thread).toEqual({ type: 'create' })
  expect(threadTracker).toBeDefined()
  expect(cacheKeep).toBeDefined()
  beginPiPrimaryTurn(f.path, fork)
  const targetState = () =>
    stateBytes(
      Object.getOwnPropertyDescriptor(cacheKeep!.manager, 'targets')?.value,
    )
  const leaseState = () =>
    stateBytes(
      ['realTurns', 'turnStarts', 'pendingTurns'].map(
        (key) => Object.getOwnPropertyDescriptor(cacheKeep!, key)?.value,
      ),
    )
  const beforeTarget = targetState()
  expect(JSON.parse(beforeTarget)).toHaveLength(1)
  const beforeLease = leaseState()
  const beforeThread = stateBytes(threadTracker)
  thread.mockClear()
  lease.mockClear()
  const result = await streamCortexKitAnthropic(
    model,
    forkContext(context),
    { ...forkOptions(head), ...hooks },
    undefined,
    undefined,
    'agent-loop',
  ).result()
  expect(result.stopReason).toBe('stop')
  expect(sent.at(-1)?.thread).toBeUndefined()
  expect(thread).not.toHaveBeenCalled()
  expect(lease).not.toHaveBeenCalled()
  expect(targetState()).toBe(beforeTarget)
  expect(leaseState()).toBe(beforeLease)
  expect(stateBytes(threadTracker)).toBe(beforeThread)
  const continued = {
    ...context,
    messages: [
      ...context.messages,
      answer,
      { role: 'user' as const, content: 'Next head turn', timestamp: 2 },
    ],
  }
  expect(
    (
      await streamCortexKitAnthropic(
        model,
        continued,
        { sessionId: head, ...hooks },
        undefined,
        undefined,
        'agent-loop',
      ).result()
    ).stopReason,
  ).toBe('stop')
  expect(sent.at(-1)?.thread).toEqual({
    type: 'continue',
    previous_message_id: 'msg_head',
  })
})

for (const transport of ['direct', 'relay fallback'] as const) {
  test(`Pi fork allows a vault-newer-record retry on ${transport} without changing admission`, async () => {
    const f = await fixture('main-first', transport === 'relay fallback')
    const head = `fork-401-${transport}-${f.path}`
    const routing = forkRouting()
    let version = 1
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: fixtureAccountIdentity('main'),
      material: `fork-v${version}`,
      recordVersion: version,
      expiresAtMs: Date.now() + 600_000,
    })
    let reject = false
    const sent: string[] = []
    let relayCalls = 0
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).includes('relay.invalid')) {
          relayCalls++
          throw new Error('relay unavailable')
        }
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        sent.push(authorization)
        if (reject && authorization === 'Bearer fork-v1') {
          version = 2
          return Response.json({}, { status: 401 })
        }
        return success()
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    expect(
      (
        await streamCortexKitAnthropic(model, context, {
          sessionId: head,
        }).result()
      ).stopReason,
    ).toBe('stop')
    reject = true
    sent.length = 0
    const result = await streamCortexKitAnthropic(
      model,
      forkContext(context),
      forkOptions(head),
    ).result()
    expect(result.stopReason).toBe('stop')
    expect(sent).toEqual(['Bearer fork-v1', 'Bearer fork-v2'])
    expect(routing.asks.filter((id) => id === `${head}-fork`)).toHaveLength(1)
    await flushForkReports()
    expect(
      routing.reports.filter(
        (r) => r.sessionId === `${head}-fork` && r.payload.kind === 'billing',
      ),
    ).toEqual([])
    if (transport === 'relay fallback') expect(relayCalls).toBeGreaterThan(0)
  })
}

test('Pi fork aborts while routing is unanswered without sending or billing', async () => {
  const f = await fixture()
  const head = `fork-abort-${f.path}`
  forkRouting()
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: head,
      }).result()
    ).stopReason,
  ).toBe('stop')
  sends = 0
  const controller = new AbortController()
  const routingRelease = lifetimes.gate()
  const routing = forkRouting(async () => {
    controller.abort()
    await routingRelease.wait
    return null
  })
  const result = await streamCortexKitAnthropic(model, forkContext(context), {
    ...forkOptions(head),
    signal: controller.signal,
  }).result()
  routingRelease.open()
  expect(result.stopReason).toBe('aborted')
  expect(sends).toBe(0)
  expect(
    routing.reports.filter((report) => report.sessionId === `${head}-fork`),
  ).toEqual([])
})

for (const mode of ['automatic', 'mixed lifetimes'] as const) {
  test(`Pi fork long-branch cache bridge respects ${mode}`, async () => {
    const f = await fixture()
    const head = `fork-bridge-${mode}-${f.path}`
    forkRouting()
    await (await f.native.service()).updateSettings((settings) => ({
      ...settings,
      claudeCache: {
        enabled: true,
        mode: mode === 'automatic' ? 'automatic' : 'hybrid',
      },
    }))
    const bodies: Array<{
      cache_control?: unknown
      messages: Array<{ content: Array<Record<string, unknown>> }>
      system: Array<Record<string, unknown>>
    }> = []
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        bodies.push(
          JSON.parse(
            new Headers(init?.headers).get('content-encoding') === 'gzip'
              ? gunzipSync(init?.body as Uint8Array).toString()
              : String(init?.body),
          ),
        )
        return success()
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    const onPayload = (payload: unknown) => {
      if (mode !== 'mixed lifetimes') return
      const body = payload as (typeof bodies)[number]
      body.messages.at(-1)!.content.at(-1)!.cache_control = {
        type: 'ephemeral',
      }
      if (body.messages.length > 10)
        body.messages[10]!.content =
          typeof body.messages[10]!.content === 'string'
            ? [
                {
                  type: 'text',
                  text: body.messages[10]!.content,
                  cache_control: { type: 'ephemeral', ttl: '1h' },
                },
              ]
            : body.messages[10]!.content.map((block, index, blocks) =>
                index === blocks.length - 1
                  ? {
                      ...block,
                      cache_control: { type: 'ephemeral', ttl: '1h' },
                    }
                  : block,
              )
    }
    expect(
      (
        await streamCortexKitAnthropic(model, context, {
          sessionId: head,
          onPayload,
        }).result()
      ).stopReason,
    ).toBe('stop')
    const response = await __sendPiAnthropicRequestForTest({
      model,
      context: forkContext(context, 30),
      streamOptions: { ...forkOptions(head), onPayload },
      storagePath: f.path,
      oauthAccountId: 'main',
    })
    expect(response.status).toBe(200)
    await response.text()
    const fork = bodies.at(-1)!
    const baseBlock = fork.messages[0]!.content.at(-1)!
    if (mode === 'automatic') {
      expect(fork.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
      expect(baseBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    } else {
      expect(baseBlock.cache_control).toBeUndefined()
      const markers = [
        ...fork.system,
        ...fork.messages.flatMap((message) => message.content),
      ].filter((block) => block.cache_control)
      expect(markers).toHaveLength(4)
      expect(
        markers
          .slice(0, -1)
          .every(
            (block) => (block.cache_control as { ttl?: string }).ttl === '1h',
          ),
      ).toBe(true)
      expect(markers.at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
    }
  })
}

test('Pi fork refuses an unretained base without a model send', async () => {
  await fixture()
  forkRouting()
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  const result = await streamCortexKitAnthropic(
    model,
    forkContext(context),
    forkOptions('missing-base'),
  ).result()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('fork_base_unavailable')
  expect(isRetryableAssistantError(result)).toBe(false)
  expect(sends).toBe(0)
})

test('Pi fork aborts an unanswered payload hook without sending', async () => {
  const f = await fixture()
  const head = `fork-hook-abort-${f.path}`
  forkRouting()
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: head,
      }).result()
    ).stopReason,
  ).toBe('stop')
  sends = 0
  const controller = new AbortController()
  const release = lifetimes.gate()
  const finished = lifetimes.gate()
  let hookEntered = false
  try {
    const result = await streamCortexKitAnthropic(model, forkContext(context), {
      ...forkOptions(head),
      signal: controller.signal,
      onPayload: async () => {
        hookEntered = true
        controller.abort()
        await release.wait
        finished.open()
      },
    }).result()
    expect(result.stopReason).toBe('aborted')
    expect(sends).toBe(0)
  } finally {
    release.open()
    if (hookEntered) await finished.wait
  }
})

test('Pi fork options survive real model-runtime complete dispatch and shutdown clears the retained base', async () => {
  const f = await fixture()
  const head = `fork-runtime-${f.path}`
  forkRouting()
  const host = await ModelRuntime.create({
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async () => {
        throw new Error('Unexpected local credential write')
      },
      delete: async () => {
        throw new Error('Unexpected local credential delete')
      },
    },
    modelsPath: null,
    modelsStorePath: join(dirname(f.path), 'fork-model-store'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  const events = new Map<string, (...args: unknown[]) => unknown>()
  const pi = {
    registerCommand: () => {},
    on: (name: string, handler: (...args: unknown[]) => unknown) =>
      events.set(name, handler),
    registerProvider: (provider: Provider) =>
      host.registerNativeProvider(provider),
  } as unknown as ExtensionAPI
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch
  await cortexKitPiAnthropicAuth(pi, { connectScoped: f.connect })
  try {
    const registered = host.getModel('anthropic', model.id)
    if (!registered) throw new Error('Missing registered model')
    expect(
      (await host.complete(registered, context, { sessionId: head }))
        .stopReason,
    ).toBe('stop')
    expect(stateBytes(piForkEffortSnapshots)).toContain(head)
    expect(
      (await host.complete(registered, forkContext(context), forkOptions(head)))
        .stopReason,
    ).toBe('stop')
    sends = 0
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for('cortexkit.routing')
    ]
    const result = await host.complete(
      registered,
      forkContext(context),
      forkOptions(head),
    )
    expect(result.stopReason).toBe('error')
    expect(isRetryableAssistantError(result)).toBe(false)
    expect(sends).toBe(0)
  } finally {
    await events.get('session_shutdown')?.(
      {},
      { sessionManager: { getSessionId: () => head } },
    )
  }
  expect(stateBytes(piForkEffortSnapshots)).not.toContain(head)
})

test('Pi Prime authorizes vault custody for a stateless signed physical send', async () => {
  const f = await fixture()
  const billing = captureBilling()
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    prime: { enabled: true },
  }))
  f.native.prime!.manager.options.markerDir = join(dir!, 'prime')
  const bodies: string[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init)
      expect(request.headers.get('authorization')).toMatch(
        /^Bearer vault-test-access-/,
      )
      if (request.url.includes('/api/oauth/usage'))
        return Response.json({
          five_hour: {
            utilization: 0,
            resets_at: new Date(Date.now() - 120_000).toISOString(),
          },
          seven_day: {
            utilization: 0,
            resets_at: new Date(Date.now() + 604_800_000).toISOString(),
          },
        })
      expect(request.url).toBe(
        'https://api.anthropic.com/v1/messages?beta=true',
      )
      expect(request.headers.get('x-claude-code-request-class')).toBe(
        'auxiliary',
      )
      const bytes = Buffer.from(await request.arrayBuffer())
      bodies.push(
        (request.headers.get('content-encoding') === 'gzip'
          ? gunzipSync(bytes)
          : bytes
        ).toString(),
      )
      return Response.json({ usage: { input_tokens: 11, output_tokens: 1 } })
    },
    { preconnect: originalFetch.preconnect },
  )
  await f.native.prime!.manager.tick()
  expect(bodies).toHaveLength(1)
  expect(await signRequestBody(bodies[0]!)).toBe(bodies[0]!)
  expect(JSON.parse(bodies[0]!)).toMatchObject({
    max_tokens: 1,
    messages: [{ role: 'user', content: '0' }],
  })
  expect(f.gets.length).toBeGreaterThanOrEqual(3)
  expect(
    (await runtime.read()).accounts.find((account) => account.id === 'main')
      ?.prime,
  ).toMatchObject({ count: 1, inputTokens: 11, outputTokens: 1 })
  await Bun.sleep(10)
  expect(billing.reports).toEqual([])
})
const success = () =>
  new Response(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )

test('Pi billing lineage follows the user turn across tool iterations and retries', async () => {
  const f = await fixture()
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  await cortexKitPiAnthropicAuth(
    {
      registerCommand() {},
      registerProvider() {},
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
        hooks.set(name, handler),
    } as unknown as ExtensionAPI,
    { connectScoped: f.connect },
  )
  const sessionId = `pi-lineage-${f.path}`
  const hookContext = {
    hasUI: false,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
  }
  const emit = (name: string, fields: Record<string, unknown> = {}) =>
    hooks.get(name)?.({ type: name, ...fields }, hookContext)
  deferCleanup(async () => {
    await emit('session_shutdown')
  })

  const nextContext = forkContext(context)
  const toolHistory: Context = {
    ...context,
    messages: [
      ...context.messages,
      {
        ...nextContext.messages.find(
          (message): message is AssistantMessage =>
            message.role === 'assistant',
        )!,
        content: [
          { type: 'toolCall', id: 'call_read', name: 'read', arguments: {} },
        ],
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolCallId: 'call_read',
        toolName: 'read',
        content: [{ type: 'text', text: 'read result' }],
        isError: false,
        timestamp: 2,
      },
    ],
  }
  const sent: { text: string; line: string; promptHeader: string | null }[] = []
  const send = async (
    requestContext: Context,
    responseId: string,
    {
      status = 200,
      origin = 'agent-loop' as 'agent-loop' | 'direct',
      alternateHeader = false,
    } = {},
  ) => {
    const response = await __sendPiAnthropicRequestForTest(
      {
        model,
        context: requestContext,
        storagePath: f.path,
        oauthAccountId: 'main',
        requestOrigin: origin,
        streamOptions: { sessionId },
      },
      {
        native: f.native,
        fetch: (async (_input: unknown, init?: RequestInit) => {
          const text =
            init?.body instanceof Uint8Array
              ? gunzipSync(init.body).toString()
              : String(init?.body)
          sent.push({
            text,
            line: JSON.parse(text).system[0].text,
            promptHeader: new Headers(init?.headers).get(
              'x-claude-code-prompt-id',
            ),
          })
          return new Response(status === 200 ? success().body : '{}', {
            status,
            headers: {
              'content-type':
                status === 200 ? 'text/event-stream' : 'application/json',
              [alternateHeader ? 'x-request-id' : 'request-id']: responseId,
            },
          })
        }) as typeof fetch,
      },
    )
    expect(response.status).toBe(status)
    await response.text()
  }

  await emit('turn_start', { turnIndex: 0 })
  await emit('message_start', { message: context.messages[0] })
  await send(context, 'req_pi_lineage_first')
  await emit('turn_start', { turnIndex: 1 })
  await send(toolHistory, 'req_pi_lineage_rejected', { status: 429 })
  await send(toolHistory, 'req_pi_lineage_tool', { alternateHeader: true })
  await send(context, 'req_pi_lineage_aux', { origin: 'direct' })
  await emit('turn_start', { turnIndex: 2 })
  await emit('message_start', { message: nextContext.messages.at(-1) })
  await send(nextContext, 'invalid-upstream-id')
  await emit('agent_settled')
  await emit('turn_start', { turnIndex: 0 })
  const lastContext: Context = {
    ...nextContext,
    messages: [
      ...nextContext.messages,
      { role: 'user', content: 'Third user prompt', timestamp: 101 },
    ],
  }
  await send(lastContext, 'req_pi_lineage_next')

  const [first, rejected, retried, auxiliary, queued, next] = sent
  const promptId = first?.promptHeader
  expect(promptId).toMatch(/^[a-f0-9-]{36}$/)
  for (const attempt of [first, rejected, retried]) {
    expect(attempt?.promptHeader).toBe(promptId!)
    expect(attempt?.line).toContain(
      `cc_prompt_id=${promptId}; cc_turn_origin=human; cc_prompt_index=1; cc_turn_index=1;`,
    )
  }
  expect(first?.line).not.toContain('cc_prev_req=')
  expect(rejected?.line).toContain('cc_prev_req=req_pi_lineage_first;')
  expect(retried?.line).toContain('cc_prev_req=req_pi_lineage_rejected;')
  expect(auxiliary?.promptHeader).toBeNull()
  expect(auxiliary?.line).not.toMatch(/cc_(?:prev_req|prompt_id|turn_index)=/)
  const prewarm = await buildCacheKeepPrewarmBody(retried!.text)
  expect(prewarm.ok).toBe(true)
  if (prewarm.ok)
    expect(prewarm.bodyText).not.toMatch(
      /cc_(?:prev_req|prompt_id|turn_index)=/,
    )
  expect(queued?.promptHeader).toMatch(/^[a-f0-9-]{36}$/)
  expect(queued?.promptHeader).not.toBe(promptId!)
  expect(queued?.line).toContain('cc_prev_req=req_pi_lineage_tool;')
  expect(queued?.line).toContain(
    `cc_prompt_id=${queued?.promptHeader}; cc_turn_origin=human; cc_prompt_index=2; cc_turn_index=2;`,
  )
  expect(next?.promptHeader).toMatch(/^[a-f0-9-]{36}$/)
  expect(next?.promptHeader).not.toBe(queued?.promptHeader ?? null)
  expect(next?.line).toContain('cc_prev_req=req_pi_lineage_tool;')
  expect(next?.line).toContain(
    `cc_prompt_id=${next?.promptHeader}; cc_turn_origin=human; cc_prompt_index=3; cc_turn_index=3;`,
  )
})

const row = (id: string, accountId: string): ScopedInventoryRow => ({
  id,
  accountId,
  credentialType: 'oauth',
  categories: ['anthropic-native'],
  serves: ['anthropic'],
  providerIds: [],
  refreshAdapter: 'anthropic',
  operations: ['read'],
  state: 'active',
  recordVersion: 1,
  createdAtMs: null,
})
async function fixture(
  mode: 'main-first' | 'fallback-first' | 'sticky-balanced' = 'main-first',
  relay = false,
  local = false,
  localIdentity = () => fixtureAccountIdentity('main'),
) {
  dir = await mkdtemp(join(tmpdir(), 'pi-scoped-stream-'))
  path = join(dir, 'accounts.json')
  const root = dir
  const storagePath = path
  const envKeys = [
    'PI_CODING_AGENT_DIR',
    'PI_AGENT_DIR',
    'PI_ANTHROPIC_AUTH_FILE',
    'PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE',
    'PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE',
    'OPENCODE_ANTHROPIC_AUTH_STATE_FILE',
  ]
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  deferCleanup(async () => {
    await closePiNativeRuntime(storagePath)
    globalThis.fetch = originalFetch
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (path === storagePath) {
      path = undefined
      dir = undefined
    }
  })
  deferCleanup(() => rm(root, { recursive: true, force: true }))
  const tokenPath = join(dir, 'pi-token.json')
  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_AGENT_DIR = dir
  process.env.PI_ANTHROPIC_AUTH_FILE = path
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = tokenPath
  await saveNativePiFixture(
    {
      version: 1,
      accounts: [
        {
          id: 'paid',
          type: 'api',
          apiKey: 'paid-test-key',
          baseURL: 'https://paid.invalid',
        },
      ],
      routing: { mode },
      prime: { enabled: false },
      ...(relay
        ? {
            relay: {
              enabled: true,
              url: 'https://relay.invalid',
              token: 'relay-test-secret',
              transport: 'http',
              fallbackToDirect: true,
            },
          }
        : {}),
    },
    path,
    { primary: local, mainAccess: 'sk-ant-oat01-thread-access-1' },
  )
  const localPaths = await resolveNativePoolPaths(
    storagePath,
    join(root, 'anthropic-auth-state.json'),
  )
  const localFiles = [
    localPaths.config,
    localPaths.state,
    localPaths.runtime,
    localPaths.journal,
  ]
  const beforeLocal = await Promise.all(
    localFiles.map((file) => readFile(file)),
  )
  if (!local)
    await writeFile(
      tokenPath,
      JSON.stringify({ token: '01'.repeat(32), token_generation: 1 }),
      { mode: 0o600 },
    )
  const rows = [row('oauth:anthropic', fixtureAccountIdentity('main'))]
  const gets: Array<Parameters<ClaustrumScopedClient['getScoped']>[0]> = []
  const reports: Array<
    Parameters<ClaustrumScopedClient['reportAuthFailureScoped']>[0]
  > = []
  const firstReport = lifetimes.gate()
  const client: ClaustrumScopedClient = {
    listScoped: async () => ({
      rows,
      view: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      grants: undefined,
      grantTuples: undefined,
    }),
    getScoped: async (input) => {
      gets.push(input)
      return {
        credentialId: input.credentialId,
        accountId: rows.find((entry) => entry.id === input.credentialId)
          ?.accountId,
        material: `vault-test-access-${gets.length}`,
        recordVersion: gets.length,
        expiresAtMs: Date.now() + 600_000,
      }
    },
    reportAuthFailureScoped: async (input) => {
      reports.push(input)
      firstReport.open()
    },
    close: () => {},
  }
  const connect = async () => client
  // Tests publish roster changes explicitly; a background poll would make
  // discovery timing nondeterministic. One test below enables it on purpose.
  const native = getPiNativeRuntime(path, {
    connect,
    vaultPoll: { intervalMs: 0 },
    ...(local
      ? {
          local: {
            resolveIdentity: async () =>
              getClaudeCodeIdentityForVerifiedAccount('main', localIdentity()),
          },
        }
      : {}),
  })
  const service = await native.service()
  const roster = local ? undefined : await service.vault.refresh()
  await service.updateSettings((settings) => ({
    ...settings,
    routing: { mode },
  }))
  if (relay)
    await service.updateRelay({
      enabled: true,
      url: 'https://relay.invalid',
      token: 'relay-test-secret',
      transport: 'http',
      fallbackToDirect: true,
    })
  const primary = roster?.rows.find(
    (account) => account.credentialId === 'oauth:anthropic',
  )
  if (!local && !primary?.accountIdentity)
    throw new Error('Fixture vault primary identity is missing')
  return {
    rows,
    gets,
    reports,
    firstReport: firstReport.wait,
    client,
    connect,
    path,
    localFiles,
    beforeLocal,
    native,
  }
}

for (const outcome of [
  'resume',
  'abort',
  'identity-change',
  'still-blocked',
  'pool-resume',
  'pool-abort',
] as const) {
  test(`Pi plugin wait ${outcome} rechecks admission, identity and working UI without host retry`, async () => {
    const f = await fixture('sticky-balanced')
    const runtime = await f.native.service()
    await runtime.updateSettings((settings) => ({
      ...settings,
      routing: { mode: 'sticky-balanced', maxSameAccountWait: '15' },
      quota: {
        enabled: true,
        minimumRemaining: { five_hour: 1, seven_day: 1 },
      },
      claudeCache: { enabled: true, mode: 'explicit' },
    }))
    const sessionId = `pi-wait-${outcome}`
    sessionCacheActivity.record(sessionId, 'main', 3_600_000)
    deferCleanup(() => sessionCacheActivity.forget(sessionId))
    const pool = outcome.startsWith('pool-')
    if (pool) {
      const receipt = await runtime.authorizeVault('main')
      const checkedAt = Date.now()
      await runtime.vault.publish(receipt, {
        quota: {
          accountIdentity: fixtureAccountIdentity('main'),
          checkedAt,
          five_hour: {
            remainingPercent: 0,
            usedPercent: 100,
            checkedAt,
            resetsAt: new Date(checkedAt + 120_000).toISOString(),
          },
          seven_day: {
            remainingPercent: 90,
            usedPercent: 10,
            checkedAt,
            resetsAt: new Date(checkedAt + 3_600_000).toISOString(),
          },
        },
      })
    }
    let healthy = !pool
    let sends = 0
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.includes('/api/oauth/usage'))
        return Response.json({
          five_hour: {
            utilization: healthy ? 0 : 100,
            resets_at: new Date(Date.now() + 120_000).toISOString(),
          },
          seven_day: {
            utilization: 0,
            resets_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
        })
      if (url.includes('/v1/messages')) {
        sends++
        if (sends === 1 && !pool) {
          healthy = false
          return new Response('{}', {
            status: 429,
            headers: {
              'anthropic-ratelimit-unified-5h-status': 'rejected',
              'anthropic-ratelimit-unified-5h-reset': String(
                Math.floor(Date.now() / 1000) + 120,
              ),
            },
          })
        }
        return success()
      }
      throw new Error('Unexpected network request')
    }) as typeof fetch
    const scheduled = Promise.withResolvers<void>()
    let timer: (() => void) | undefined
    const messages: (string | undefined)[] = []
    const hooks = new Map<
      string,
      (event: unknown, ctx: unknown) => Promise<void>
    >()
    let provider: Provider | undefined
    const pi = {
      registerCommand() {},
      on: (
        event: string,
        handler: (event: unknown, ctx: unknown) => Promise<void>,
      ) => hooks.set(event, handler),
      registerProvider: (value: Provider) => {
        provider = value
      },
    } as unknown as ExtensionAPI
    await cortexKitPiAnthropicAuth(pi, {
      connectScoped: f.connect,
      quotaWait: {
        setTimeout: ((callback: () => void) => {
          timer = callback
          scheduled.resolve()
          return 1
        }) as unknown as typeof setTimeout,
        clearTimeout: (() => {
          timer = undefined
        }) as unknown as typeof clearTimeout,
      },
    })
    await hooks.get('turn_start')?.(
      {},
      {
        hasUI: true,
        model,
        sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
        ui: { setWorkingMessage: (message?: string) => messages.push(message) },
      },
    )
    if (!provider?.streamSimple) throw new Error('Missing provider stream')
    const abort = new AbortController()
    const stream = provider.streamSimple(model, normalizeContext(context), {
      sessionId,
      signal: abort.signal,
    })
    const drained = (async () => {
      for await (const _event of stream) {
        /* Consume the provider stream. */
      }
    })()
    await scheduled.promise
    expect(sends).toBe(pool ? 0 : 1)
    expect(messages[0]).toMatch(
      /^Checking account availability in \d+ min \(reset at \d\d:\d\d UTC\) · Esc to cancel$/,
    )
    if (outcome.endsWith('abort')) abort.abort()
    else {
      healthy = outcome !== 'still-blocked'
      if (outcome === 'identity-change') {
        f.rows[0] = row('oauth:anthropic', 'changed-account')
        await runtime.vault.refresh()
      }
      timer?.()
    }
    await drained
    const result = await stream.result()
    expect(result.stopReason).toBe(
      outcome.endsWith('resume')
        ? 'stop'
        : outcome.endsWith('abort')
          ? 'aborted'
          : 'error',
    )
    expect(sends).toBe(
      outcome.endsWith('resume') ? (pool ? 1 : 2) : pool ? 0 : 1,
    )
    expect(messages.at(-1)).toBeUndefined()
    expect(isRetryableAssistantError(result)).toBe(false)
  })
}

test('Pi background vault poll adopts a main re-login while a fallback serves, with no request-time discovery', async () => {
  const f = await fixture('main-first')
  f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  const service = await f.native.service()
  await service.vault.refresh()
  // Two Pi runtimes for the same storage share one vault connection. The
  // fixture's runtime was created with polling off; this second one turns the
  // shared background poll on at a short interval for this test.
  const polled = new PiNativeRuntime(f.path, {
    connect: f.connect,
    vaultPoll: { intervalMs: 20 },
  })
  deferCleanup(() => polled.close())
  const requestRefresh = spyOn(service.vault, 'refresh')
  deferCleanup(() => requestRefresh.mockRestore())
  const mainState = async () =>
    (await polled.requestView()).accounts.find(
      (account) => account.credentialId === 'oauth:anthropic',
    )?.state
  // The 'work' account is active, so a request can be served without asking
  // the vault for changes. The main account stays needs_reauth here until the
  // background poll notices the re-login below.
  expect(await mainState()).toBe('needs_reauth')
  f.rows[0] = { ...f.rows[0]!, state: 'active' }
  let state = await mainState()
  while (state !== 'active') {
    await new Promise((resolve) => setTimeout(resolve, 10))
    state = await mainState()
  }
  expect(state).toBe('active')
  expect(requestRefresh).toHaveBeenCalledTimes(0)
})

for (const outcome of ['watching', 'fallback'] as const)
  test(`Pi lists the vault every five minutes only while a vault watch is open (${outcome})`, async () => {
    const f = await fixture('main-first')
    const vault = watchableVaultClient(f.client, lifetimes.gate)
    const timers = recordedTimers(deferCleanup)
    // The fixture's runtime does not poll; this one shares its vault runtime
    // and turns the background poll on at Pi's default pace.
    const polled = new PiNativeRuntime(f.path, {
      connect: f.connect,
      vaultPoll: {
        intervalMs: PI_VAULT_POLL_INTERVAL_MS,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
      },
    })
    deferCleanup(() => polled.close())
    await polled.service()
    const watch = await vault.nth(0)
    const poll = timers.created.find((timer) => timer.ms === 2_000)
    expect(poll && timers.live(poll.handle)).toBe(true)
    const before = timers.created.length
    if (outcome === 'watching') watch.notify('pi-watch')
    else watch.finish({ kind: 'unsupported' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const added = timers.created.slice(before).map((timer) => timer.ms)
    if (outcome === 'watching') {
      expect(added).toEqual([5 * 60_000])
      expect(poll && timers.live(poll.handle)).toBe(false)
    } else {
      expect(added).toEqual([])
      expect(poll && timers.live(poll.handle)).toBe(true)
    }
  })

test('Pi same-key replacement drains its predecessor without closing the shared consumer', async () => {
  const f = await fixture()
  const closes = spyOn(f.client, 'close')
  deferCleanup(() => closes.mockRestore())
  const get = f.client.getScoped.bind(f.client)
  const stableVersion = spyOn(f.client, 'getScoped').mockImplementation(
    async (input) => ({
      ...(await get(input)),
      recordVersion: 1,
    }),
  )
  deferCleanup(() => stableVersion.mockRestore())
  const runtime = await f.native.service()
  const first = await f.native.authorize('main')
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  let wrote = false
  f.native.usagePublications.publish(async () => {
    entered.open()
    await release.wait
    if (first.source !== 'vault') throw new Error('Expected a vault receipt')
    wrote = await runtime.vault.publish(first.receipt, { lastUsed: Date.now() })
  })
  await entered.wait
  let disposed = false
  const disposing = closePiNativeRuntime(f.path).then(() => {
    disposed = true
  })
  lifetimes.trackDetached(disposing)
  const successor = new PiNativeRuntime(f.path, { connect: f.connect })
  deferCleanup(() => successor.close())
  expect(disposed).toBe(false)
  const second = await successor.authorize('main')
  expect(second.source).toBe('vault')
  if (first.source !== 'vault' || second.source !== 'vault')
    throw new Error('Expected vault attempts')
  expect(second.receipt).not.toBe(first.receipt)
  expect(second.receipt.accessToken).not.toBe(first.receipt.accessToken)
  release.open()
  await disposing
  expect(wrote).toBe(true)
  expect(closes).toHaveBeenCalledTimes(0)
  await successor.authorize('main')
  await successor.close()
  expect(closes).toHaveBeenCalledTimes(1)
})

test('Pi runtime cache isolates connection and enrollment paths for the same storage file', async () => {
  const f = await fixture()
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
    dirname(f.path),
    'connection-a.json',
  )
  const a = getPiNativeRuntime(f.path, { connect: f.connect })
  expect(getPiNativeRuntime(f.path)).toBe(a)
  const differentConnector = getPiNativeRuntime(f.path, {
    connect: async () => f.client,
  })
  expect(differentConnector).not.toBe(a)
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_CONNECTION_FILE = join(
    dirname(f.path),
    'connection-b.json',
  )
  const b = getPiNativeRuntime(f.path, { connect: f.connect })
  expect(b).not.toBe(a)
  process.env.PI_ANTHROPIC_AUTH_CLAUSTRUM_ENROLLMENT_FILE = join(
    dirname(f.path),
    'other-enrollment.json',
  )
  const c = getPiNativeRuntime(f.path, { connect: f.connect })
  expect(c).not.toBe(b)
})

test('Pi sends using scoped credentials without host auth, and never bootstraps with a cached token', async () => {
  const f = await fixture()
  const sent: Array<{
    url: string
    authorization: string | null
    body: string
  }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sent.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: String(init?.body),
      })
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const first = await streamCortexKitAnthropic(model, context, {
    sessionId: 'scoped-first',
  }).result()
  expect(first.errorMessage).toBeUndefined()
  expect(first.stopReason).toBe('stop')
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: 'scoped-second',
        apiKey: 'must-ignore-local-key',
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(sent.map((request) => request.authorization)).toEqual([
    'Bearer vault-test-access-1',
    'Bearer vault-test-access-2',
  ])
  expect(
    sent.every((request) => request.url.endsWith('/v1/messages?beta=true')),
  ).toBe(true)
  expect(sent[0]?.body).toContain(fixtureAccountIdentity('main'))
  expect(f.gets).toHaveLength(2)
  expect(JSON.stringify(await readNativePiFixture(f.path))).not.toContain(
    'vault-test-access',
  )
})

test('a revoked scoped credential never falls back to local auth or a paid API route', async () => {
  const f = await fixture()
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  f.client.getScoped = async () => {
    throw new ClaustrumCredentialError(
      'enrollment_revoked',
      'auth_required',
      'reauth',
    )
  }
  const result = await streamCortexKitAnthropic(model, context, {
    apiKey: 'must-not-use-local-key',
  }).result()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('Native custody refused: unavailable')
  expect(sends).toBe(1)
})

test('Pi fallback routing never selects an enabled vault account needing sign-in', async () => {
  const f = await fixture('fallback-first')
  f.rows.push({
    ...row(
      'oauth:anthropic:needs-sign-in',
      fixtureAccountIdentity('needs-sign-in'),
    ),
    state: 'needs_reauth',
  })
  await (await f.native.service()).vault.refresh()
  const unavailable = (await f.native.view()).accounts.find(
    (account) => account.credentialId === 'oauth:anthropic:needs-sign-in',
  )
  expect(unavailable).toMatchObject({ enabled: true, state: 'needs_reauth' })
  globalThis.fetch = Object.assign(async () => success(), {
    preconnect: originalFetch.preconnect,
  })
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  expect(f.gets.map((get) => get.credentialId)).toEqual(['oauth:anthropic'])
})

test('fallback-first adopts a newly published account on the next turn and honors a live disable', async () => {
  const f = await fixture('fallback-first')
  globalThis.fetch = Object.assign(async () => success(), {
    preconnect: originalFetch.preconnect,
  })
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  f.rows.push(row('oauth:anthropic:new', fixtureAccountIdentity('new')))
  await (await f.native.service()).vault.refresh()
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  const native = getPiNativeRuntime(f.path)
  const added = (await native.view()).accounts.find(
    (account) => account.credentialId === 'oauth:anthropic:new',
  )
  if (!added) throw new Error('new account was not persisted')
  await (await native.service()).setEnabled(added.id, false)
  expect(
    (await streamCortexKitAnthropic(model, context).result()).stopReason,
  ).toBe('stop')
  expect(f.gets.map((get) => get.credentialId)).toEqual([
    'oauth:anthropic',
    'oauth:anthropic:new',
    'oauth:anthropic',
  ])
  await expect(readFile(f.path, 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

for (const mode of [
  'main-first',
  'fallback-first',
  'sticky-balanced',
] as const) {
  test(`Pi vault reauth recovers on the next request in ${mode}`, async () => {
    const f = await fixture(mode)
    f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
    f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
    await (await f.native.service()).vault.refresh()
    await (await f.native.service()).updateSettings((settings) => ({
      ...settings,
      quota: { enabled: false },
    }))
    const served: string[] = []
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).includes('/api/oauth/usage'))
          return Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 0 },
          })
        const index =
          Number(
            /vault-test-access-(\d+)$/.exec(
              new Headers(init?.headers).get('authorization') ?? '',
            )?.[1],
          ) - 1
        served.push(f.gets[index]?.credentialId ?? 'missing receipt')
        return success()
      },
      { preconnect: originalFetch.preconnect },
    )
    const options = { sessionId: `reauth-${mode}` }
    expect(
      (await streamCortexKitAnthropic(model, context, options).result())
        .stopReason,
    ).toBe('stop')
    expect(served).toEqual(['oauth:anthropic:work'])
    f.rows[0] = { ...f.rows[0]!, state: 'active' }
    f.rows[1] = { ...f.rows[1]!, state: 'needs_reauth' }
    await (await f.native.service()).vault.refresh()
    expect(
      (await streamCortexKitAnthropic(model, context, options).result())
        .stopReason,
    ).toBe('stop')
    expect(served.at(-1)).toBe('oauth:anthropic')
    f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
    await (await f.native.service()).vault.refresh()
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await streamCortexKitAnthropic(
        model,
        context,
        options,
      ).result()
      expect(result.stopReason).toBe('error')
      expect(result.errorMessage).toBe(
        'No vault account can serve this request. Open /claude to see which account needs signing in again.',
      )
    }
    expect(served).toHaveLength(2)
    f.rows[0] = { ...f.rows[0]!, state: 'active' }
    expect(
      (await streamCortexKitAnthropic(model, context, options).result())
        .stopReason,
    ).toBe('stop')
    expect(served.at(-1)).toBe('oauth:anthropic')
  })
}

/**
 * A sticky-balanced Pi session over two vault accounts whose model endpoint is
 * an owned loopback server. The first model send of the test is rejected with
 * 401; every later send succeeds. `served` lists the vault credential each
 * model send used, in order. `afterSend` sees each model response before Pi
 * does.
 */
async function stickyRejectedFirstSend(
  afterSend?: (response: Response) => void,
) {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  const service = await f.native.service()
  await service.vault.refresh()
  await service.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
  }))
  const served: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      // Sticky routing needs current quota for both accounts before it sends.
      if (new URL(request.url).pathname === '/api/oauth/usage')
        return Response.json({
          five_hour: { utilization: 0 },
          seven_day: { utilization: 0 },
        })
      const index =
        Number(
          /vault-test-access-(\d+)$/.exec(
            request.headers.get('authorization') ?? '',
          )?.[1],
        ) - 1
      served.push(f.gets[index]?.credentialId ?? 'missing receipt')
      if (served.length === 1)
        return Response.json(
          {
            type: 'error',
            error: { type: 'authentication_error', message: 'Synthetic 401' },
          },
          { status: 401 },
        )
      return success()
    },
  })
  deferCleanup(() => server.stop(true))
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input))
      if (
        !url.pathname.startsWith('/v1/messages') &&
        url.pathname !== '/api/oauth/usage'
      )
        throw new Error(`Unexpected outbound request: ${url.pathname}`)
      const response = await originalFetch(
        `http://127.0.0.1:${server.port}${url.pathname}${url.search}`,
        init,
      )
      if (url.pathname.startsWith('/v1/messages')) afterSend?.(response)
      return response
    },
    { preconnect: originalFetch.preconnect },
  )
  return { f, served }
}

for (const limit of ['quota floor', 'killswitch'] as const) {
  test(`Pi vault quota policy identifies ${limit} without sending a request when waiting is disabled`, async () => {
    const f = await fixture('sticky-balanced')
    const service = await f.native.service()
    await service.updateSettings((settings) => ({
      ...settings,
      routing: { mode: 'sticky-balanced', maxSameAccountWait: '0' },
      quota: {
        enabled: true,
        minimumRemaining: {
          five_hour: 0,
          seven_day: limit === 'quota floor' ? 20 : 0,
        },
      },
      killswitch: {
        enabled: limit === 'killswitch',
        main: { five_hour: 0, seven_day: 20 },
      },
    }))
    const receipt = await service.authorizeVault('main')
    const checkedAt = Date.now()
    expect(
      await service.vault.publish(receipt, {
        quota: {
          accountIdentity: fixtureAccountIdentity('main'),
          checkedAt,
          five_hour: { remainingPercent: 100, usedPercent: 0, checkedAt },
          seven_day: {
            remainingPercent: limit === 'quota floor' ? 20 : 19,
            usedPercent: limit === 'quota floor' ? 80 : 81,
            checkedAt,
          },
        },
      }),
    ).toBe(true)
    let networkCalls = 0
    globalThis.fetch = Object.assign(
      async () => {
        networkCalls++
        throw new Error('NETWORK FORBIDDEN')
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(model, context, {
      sessionId: 'pi-vault-quota-policy',
    }).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('412')
    expect(result.errorMessage).toContain(limit)
    expect(result.errorMessage).not.toContain('Retry in ')
    expect(result.errorMessage).toContain('/claude → Killswitch / Quota')
    expect(result.errorMessage).not.toContain('signing in')
    expect(networkCalls).toBe(0)
  })
}

test('Pi cancel during vault re-authorization after a 401 ends aborted and keeps the sticky account', async () => {
  const { f, served } = await stickyRejectedFirstSend()
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  const get = f.client.getScoped.bind(f.client)
  let held = false
  f.client.getScoped = async (input) => {
    // The first read of the rejected credential after its 401 is the
    // re-authorization. Hold it until the request is cancelled.
    if (!held && served.length === 1 && input.credentialId === served[0]) {
      held = true
      entered.open()
      await release.wait
    }
    return get(input)
  }
  const options = { sessionId: 'pi-cancel-during-reauth' }
  const controller = new AbortController()
  const pending = streamCortexKitAnthropic(model, context, {
    ...options,
    signal: controller.signal,
  }).result()
  await entered.wait
  controller.abort()
  const cancelled = await pending
  release.open()
  await f.firstReport
  await f.native.drainReports()
  expect(cancelled.stopReason).toBe('aborted')
  expect(cancelled.errorMessage).not.toContain('401')
  const assigned = served[0]
  if (!assigned) throw new Error('No model send reached the provider')
  expect(served).toEqual([assigned])
  // The 401 arrived before the cancel; it is reported once, before
  // re-authorization starts.
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[assigned, 401]])
  const next = await streamCortexKitAnthropic(model, context, options).result()
  expect(next.stopReason).toBe('stop')
  expect(served).toEqual([assigned, assigned])
  expect(f.reports).toHaveLength(1)
})

test('Pi cancel after a 401 arrives and before re-authorization ends aborted and keeps the sticky account', async () => {
  const controller = new AbortController()
  let readsAtRejection: number | undefined
  const { f, served } = await stickyRejectedFirstSend((response) => {
    // Cancel once the rejection has arrived, before Pi acts on it.
    if (response.status !== 401) return
    readsAtRejection = f.gets.length
    controller.abort()
  })
  const options = { sessionId: 'pi-cancel-after-401' }
  const cancelled = await streamCortexKitAnthropic(model, context, {
    ...options,
    signal: controller.signal,
  }).result()
  expect(cancelled.stopReason).toBe('aborted')
  await f.firstReport
  await f.native.drainReports()
  const assigned = served[0]
  if (!assigned) throw new Error('No model send reached the provider')
  expect(served).toEqual([assigned])
  // Nothing was read from the vault after the cancel: no re-authorization
  // and no authorization of another account.
  expect(f.gets).toHaveLength(readsAtRejection ?? -1)
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[assigned, 401]])
  const next = await streamCortexKitAnthropic(model, context, options).result()
  expect(next.stopReason).toBe('stop')
  expect(served).toEqual([assigned, assigned])
  expect(f.reports).toHaveLength(1)
})

test('Pi shutdown after caller abort drains a pending 401 report', async () => {
  const controller = new AbortController()
  const { f, served } = await stickyRejectedFirstSend((response) => {
    if (response.status === 401) controller.abort()
  })
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  const report = f.client.reportAuthFailureScoped.bind(f.client)
  f.client.reportAuthFailureScoped = async (input) => {
    entered.open()
    await release.wait
    return report(input)
  }
  const cancelled = await streamCortexKitAnthropic(model, context, {
    sessionId: 'pi-shutdown-after-401',
    signal: controller.signal,
  }).result()
  expect(cancelled.stopReason).toBe('aborted')
  await entered.wait
  let closed = false
  const closing = closePiNativeRuntime(path).then(() => {
    closed = true
  })
  lifetimes.trackDetached(closing)
  try {
    expect(closed).toBe(false)
    expect(f.reports).toEqual([])
  } finally {
    release.open()
    await closing
  }
  const assigned = served[0]
  if (!assigned) throw new Error('No model send reached the provider')
  expect(served).toEqual([assigned])
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[assigned, 401]])
  expect(f.reports).toHaveLength(1)
})

for (const relay of [false, true]) {
  test(`Pi ${relay ? 'HTTP relay' : 'direct'} shutdown does not wait for model response headers`, async () => {
    const f = await fixture()
    if (relay)
      await (await f.native.service()).updateRelay({
        enabled: true,
        url: 'https://relay.invalid/request',
        token: 'synthetic-held-relay-token',
        transport: 'http',
        fallbackToDirect: false,
      })
    const entered = lifetimes.gate()
    const release = lifetimes.gate()
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input)
        if (url.includes('/api/oauth/usage'))
          return Response.json({
            five_hour: { utilization: 0 },
            seven_day: { utilization: 0 },
          })
        if (
          !url.includes('/v1/messages') &&
          !url.startsWith('https://relay.invalid/')
        )
          throw new Error('Unexpected held-send fixture request')
        entered.open()
        // The transport ignores abort and never returns response headers. Only
        // fixture teardown can reject it, after the shutdown assertion below.
        await release.wait
        throw new Error('Held model transport stopped by fixture teardown')
      },
      { preconnect: originalFetch.preconnect },
    )
    const controller = new AbortController()
    const pending = streamCortexKitAnthropic(model, context, {
      sessionId: `pi-held-${relay ? 'relay' : 'direct'}`,
      signal: controller.signal,
    }).result()
    await entered.wait
    const closing = closePiNativeRuntime(f.path)
    try {
      expect(
        await Promise.race([
          closing.then(() => 'closed'),
          Bun.sleep(500).then(() => 'still waiting for headers'),
        ]),
      ).toBe('closed')
      expect(controller.signal.aborted).toBe(false)
      expect(f.reports).toEqual([])
    } finally {
      controller.abort()
      release.open()
      await pending
      await closing
    }
  })
}

test('Pi failed vault re-authorization after a 401 still reports and moves the sticky account', async () => {
  const { f, served } = await stickyRejectedFirstSend()
  const get = f.client.getScoped.bind(f.client)
  let refused = false
  f.client.getScoped = async (input) => {
    if (!refused && served.length === 1 && input.credentialId === served[0]) {
      refused = true
      throw new Error('synthetic vault unavailable')
    }
    return get(input)
  }
  const options = { sessionId: 'pi-failed-reauth' }
  const first = await streamCortexKitAnthropic(model, context, options).result()
  expect(first.stopReason).toBe('stop')
  const [rejected, migrated] = served
  if (!rejected || !migrated)
    throw new Error('The rejected send was not rerouted')
  expect(served).toHaveLength(2)
  expect(migrated).not.toBe(rejected)
  expect(
    f.reports.map((report) => [report.credentialId, report.providerStatus]),
  ).toEqual([[rejected, 401]])
  expect(
    (await streamCortexKitAnthropic(model, context, options).result())
      .stopReason,
  ).toBe('stop')
  expect(served).toEqual([rejected, migrated, migrated])
})

registerTest.each([500, 401])(
  'relay status %i falls back direct with a fresh version-fenced credential',
  wrapBody(async (relayStatus) => {
    const f = await fixture('main-first', true)
    // Relay and direct use different records; no rotation occurs after the
    // direct send, so a genuine 401 must report its exact served version.
    f.client.getScoped = async (input) => {
      f.gets.push(input)
      const version = Math.min(f.gets.length, 2)
      return {
        credentialId: input.credentialId,
        accountId: fixtureAccountIdentity('main'),
        material: `vault-test-access-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 600_000,
      }
    }
    const credentials: string[] = []
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (String(input).startsWith('https://relay.invalid')) {
          const payload = JSON.parse(String(init?.body))
          credentials.push(payload.upstream.headers.authorization)
          return new Response('relay unavailable', { status: relayStatus })
        }
        if (!String(input).startsWith('https://api.anthropic.com/v1/messages'))
          throw new Error('Unexpected outbound request')
        credentials.push(new Headers(init?.headers).get('authorization') ?? '')
        return new Response('unauthorized', { status: 401 })
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(model, context, {
      sessionId: 'relay-fallback',
    }).result()
    expect(result.stopReason).toBe('error')
    expect(credentials).toEqual([
      'Bearer vault-test-access-1',
      'Bearer vault-test-access-2',
    ])
    expect(f.gets).toHaveLength(3) // the 401 checks again but never resends unchanged v2
    expect(f.reports).toEqual([
      {
        credentialId: 'oauth:anthropic',
        enrollmentToken: '01'.repeat(32),
        providerStatus: 401,
        recordVersion: 2,
        reporterSource: 'direct',
      },
    ])
  }),
)

test('scoped model switches reuse the existing sticky allocator and its Opus reserve preference', async () => {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  await (await f.native.service()).vault.refresh()
  const served: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      const index =
        Number(/vault-test-access-(\d+)$/.exec(authorization)?.[1]) - 1
      const credentialId = f.gets[index]?.credentialId
      if (!credentialId) throw new Error('Request did not use a scoped receipt')
      if (String(input).includes('/api/oauth/usage')) {
        return Response.json({
          five_hour: {
            utilization: 20,
            resets_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          seven_day: {
            utilization: 20,
            resets_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: credentialId === 'oauth:anthropic' ? 100 : 0,
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        })
      }
      if (!String(input).includes('/v1/messages'))
        throw new Error('Unexpected outbound request')
      served.push(credentialId)
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const options = { sessionId: 'scoped-model-switch' }
  expect(
    (await streamCortexKitAnthropic(model, context, options).result())
      .stopReason,
  ).toBe('stop')
  expect(
    (
      await streamCortexKitAnthropic(
        { ...model, id: 'claude-opus-5' },
        context,
        options,
      ).result()
    ).stopReason,
  ).toBe('stop')
  expect(served).toEqual(['oauth:anthropic:work', 'oauth:anthropic'])
})

test('an incomplete scoped quota pool cannot spend a paid fallback or issue a model request', async () => {
  const f = await fixture('sticky-balanced')
  const urls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input))
      return new Response('usage endpoint unavailable', { status: 503 })
    },
    { preconnect: originalFetch.preconnect },
  )
  const result = await streamCortexKitAnthropic(model, context, {
    sessionId: 'scoped-quota-incomplete',
  }).result()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain(
    'waiting for current OAuth quota snapshots',
  )
  expect(urls).toEqual(['https://api.anthropic.com/api/oauth/usage'])
  expect(f.gets).toHaveLength(1)
})

const hostCredentials: Array<{
  name: string
  credential?: Credential
  initiallyInactive?: boolean
}> = [
  { name: 'empty credential store' },
  { name: 'inactive vault at provider registration', initiallyInactive: true },
  {
    name: 'stored local API key',
    credential: { type: 'api_key', key: 'must-not-use-local-api-key' },
  },
  {
    name: 'stored expired OAuth',
    credential: {
      type: 'oauth',
      access: 'must-not-use-local-access',
      refresh: 'must-not-refresh-local-token',
      expires: 0,
    },
  },
]

registerTest.each(hostCredentials)(
  'real Pi model runtime honors custody with $name',
  wrapBody(async ({ credential, initiallyInactive }) => {
    const f = await fixture()
    if (initiallyInactive) {
      f.rows[0] = { ...f.rows[0]!, state: 'needs_reauth' }
      await (await f.native.service()).vault.refresh()
    }
    let writes = 0,
      sends = 0
    const credentials: CredentialStore = {
      read: async (providerId) =>
        providerId === 'anthropic' ? credential : undefined,
      list: async () =>
        credential ? [{ providerId: 'anthropic', type: credential.type }] : [],
      modify: async () => {
        writes++
        throw new Error('Local credentials must not be modified')
      },
      delete: async () => {
        writes++
        throw new Error('Runtime must not delete user credentials')
      },
    }
    const host = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      modelsStorePath: join(dirname(f.path), 'model-store'),
      refreshOnCreate: false,
      allowModelNetwork: false,
    })
    const events = new Map<string, (...args: unknown[]) => unknown>()
    let provider: Provider | undefined
    const commands = new Map<
      string,
      Parameters<ExtensionAPI['registerCommand']>[1]
    >()
    const pi = {
      registerCommand: (
        name: string,
        definition: Parameters<ExtensionAPI['registerCommand']>[1],
      ) => {
        commands.set(name, definition)
      },
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        events.set(name, handler)
      },
      registerProvider: (
        value: Provider | string,
        configuration?: ProviderConfig,
      ) => {
        if (typeof value === 'string') {
          if (!configuration)
            throw new Error('Missing local provider configuration')
          host.registerProvider(value, configuration)
          provider = host.getProvider(value)
        } else {
          provider = value
          host.registerNativeProvider(value)
        }
      },
    } as unknown as ExtensionAPI
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).includes('/v1/messages'))
          throw new Error('Unexpected outbound request')
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer vault-test-access-${f.gets.length}`,
        )
        sends++
        return success()
      },
      { preconnect: originalFetch.preconnect },
    )
    try {
      await cortexKitPiAnthropicAuth(pi, {
        connectScoped: async () => ({ ...f.client }),
      })
      await getPiNativeRuntime(f.path).view()
      expect(provider?.auth.oauth).toBeUndefined()
      if (credential?.type === 'oauth') {
        expect(await host.getAuth('anthropic')).toBeUndefined()
        expect(sends).toBe(0)
        expect(f.gets).toHaveLength(0)
      } else {
        expect(await host.getAuth('anthropic')).toEqual({
          auth: {},
          source: 'CortexKit Native',
        })
        const registered = host.getModel('anthropic', model.id)
        if (!registered)
          throw new Error('Native Anthropic model was not registered')
        if (initiallyInactive) {
          const refused = await host.completeSimple(registered, context)
          expect(refused.stopReason).toBe('error')
          expect(refused.errorMessage).toBe(
            'No vault account can serve this request. Open /claude to see which account needs signing in again.',
          )
          expect(sends).toBe(0)
          f.rows[0] = { ...f.rows[0]!, state: 'active' }
        }
        expect(
          (await host.completeSimple(registered, context)).stopReason,
        ).toBe('stop')
        expect(sends).toBe(1)
        const accountCommand = commands.get('claude')
        if (!accountCommand)
          throw new Error('Claude menu command was not registered')
        const ctx = {
          ui: { notify: () => {} },
        } as unknown as ExtensionCommandContext
        await accountCommand.handler('local', ctx)
        expect(host.getProvider('anthropic')?.auth.oauth).toBeUndefined()
        await accountCommand.handler('claustrum', ctx)
        await getPiNativeRuntime(f.path).view()
        expect(host.getProvider('anthropic')?.auth.oauth).toBeUndefined()
        expect(
          (await host.completeSimple(registered, context)).stopReason,
        ).toBe('stop')
        expect(sends).toBe(2)
      }
      expect(writes).toBe(0)
    } finally {
      await events.get('session_shutdown')?.(
        {},
        { sessionManager: { getSessionId: () => undefined } },
      )
    }
  }),
)

registerTest(
  'Pi CacheKeep returns a terminal killswitch refusal without authorizing or sending',
  wrapBody(async () => {
    const f = await fixture()
    const runtime = await getPiNativeRuntime(f.path).service()
    await runtime.updateSettings((settings) => ({
      ...settings,
      killswitch: { enabled: true, main: { five_hour: 5, seven_day: 0 } },
    }))
    let gets = 0
    f.client.getScoped = async () => {
      gets++
      throw new NativeCustodyError('unavailable')
    }
    let sends = 0
    globalThis.fetch = Object.assign(
      async () => {
        sends++
        return Response.json({})
      },
      { preconnect: originalFetch.preconnect },
    )
    expect(
      await __prewarmPiCacheKeepForTest({
        sessionId: 'pi-cachekeep-policy',
        url: 'https://api.anthropic.com/v1/messages',
        headers: new Headers(),
        bodyText: JSON.stringify({
          model: model.id,
          system: [
            {
              type: 'text',
              text: 'stable',
              cache_control: { type: 'ephemeral' },
            },
          ],
        }),
        oauthAccountId: 'main',
        oauthAccountIdentity: fixtureAccountIdentity('main'),
        accountStoragePath: f.path,
      }),
    ).toEqual({
      ok: false,
      reason: 'account-policy',
      refusal: 'account-policy',
      stage: 'authorization',
      class: 'account-policy',
    })
    expect(gets).toBe(0)
    expect(sends).toBe(0)
  }),
)

test('Pi CacheKeep retains only closed authorization, send and response diagnostics', async () => {
  const f = await fixture()
  const prewarm = () =>
    __prewarmPiCacheKeepForTest({
      sessionId: 'pi-cachekeep-diagnostics',
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText: JSON.stringify({
        model: model.id,
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral' },
          },
        ],
      }),
      oauthAccountId: 'main',
      oauthAccountIdentity: fixtureAccountIdentity('main'),
      accountStoragePath: f.path,
    })
  for (const [failureClass, fail] of [
    [
      'AbortError',
      async () => {
        throw new DOMException('SECRET credential', 'AbortError')
      },
    ],
    [
      'TimeoutError',
      async () => {
        throw new DOMException('SECRET credential', 'TimeoutError')
      },
    ],
    [
      'ECONNRESET',
      async () => {
        throw Object.assign(new Error('SECRET credential'), {
          code: 'ECONNRESET',
        })
      },
    ],
    [
      500,
      async () =>
        Response.json(
          { error: { type: 'api_error', message: 'SECRET provider body' } },
          { status: 500 },
        ),
    ],
  ] as const) {
    globalThis.fetch = Object.assign(fail, {
      preconnect: originalFetch.preconnect,
    })
    const result = await prewarm()
    expect(result).toMatchObject({
      ok: false,
      stage: failureClass === 500 ? 'response' : 'send',
      class: failureClass,
    })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  }
  f.client.getScoped = async () => {
    throw new NativeCustodyError('unavailable')
  }
  expect(await prewarm()).toMatchObject({
    ok: false,
    stage: 'authorization',
    class: 'unavailable',
  })
})

registerTest.each([200, 401])(
  'Pi retries in-flight scoped 401 once and fences final status %i',
  wrapBody(async (finalStatus) => {
    const f = await fixture()
    let version = 1
    const gets: number[] = []
    f.client.getScoped = async ({ credentialId }) => {
      gets.push(version)
      return {
        credentialId,
        accountId: fixtureAccountIdentity('main'),
        material: `rotated-pi-${version}`,
        recordVersion: version,
        expiresAtMs: Date.now() + 600_000,
      }
    }
    const sent: string[] = []
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).includes('/v1/messages'))
          throw new Error('unexpected upstream request')
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        sent.push(authorization)
        if (authorization === 'Bearer rotated-pi-1') {
          version = 2
          return new Response('rotated credential rejected', { status: 401 })
        }
        return finalStatus === 401
          ? new Response('current credential rejected', { status: 401 })
          : success()
      },
      { preconnect: originalFetch.preconnect },
    )
    const records: LogTestRecord[] = []
    const previousLevel = getLogLevel()
    setLogLevel('debug')
    __setLogTestSink((record) => records.push(record))
    let result: Awaited<
      ReturnType<ReturnType<typeof streamCortexKitAnthropic>['result']>
    >
    try {
      result = await streamCortexKitAnthropic(model, context, {
        sessionId: 'pi-rotation',
      }).result()
    } finally {
      __setLogTestSink(null)
      setLogLevel(previousLevel)
    }
    expect(result.stopReason).toBe(finalStatus === 401 ? 'error' : 'stop')
    expect(sent).toEqual(['Bearer rotated-pi-1', 'Bearer rotated-pi-2'])
    expect(gets).toEqual([1, 2])
    expect(f.reports.map((report) => report.recordVersion)).toEqual(
      finalStatus === 401 ? [1, 2] : [1],
    )
    // Retry diagnostics must not include access or refresh tokens, or the
    // provider's raw error text.
    expect(
      records
        .filter((record) => record.message === 'Pi 401 retry decision')
        .map((record) => record.payload),
    ).toContainEqual(
      expect.objectContaining({
        source: 'vault',
        servedVersion: 1,
        currentVersion: 2,
        retry: true,
        reason: 'rotated',
      }),
    )
  }),
)

registerTest.each([200, 401])(
  'Pi HTTP relay retries rotated scoped credential once; final status %i',
  wrapBody(async (finalStatus) => {
    const f = await fixture('main-first', true)
    let version = 1
    const reports: number[] = [],
      relayTokens: string[] = []
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: fixtureAccountIdentity('main'),
      material: `relay-pi-${version}`,
      recordVersion: version,
      expiresAtMs: Date.now() + 600_000,
    })
    f.client.reportAuthFailureScoped = async ({ recordVersion }) => {
      reports.push(recordVersion)
    }
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).startsWith('https://relay.invalid'))
          throw new Error('unexpected direct request')
        const payload = JSON.parse(String(init?.body)) as {
          upstream: { headers: Record<string, string> }
        }
        const authorization = payload.upstream.headers.authorization
        if (!authorization) throw new Error('relay omitted scoped bearer')
        relayTokens.push(authorization)
        if (authorization === 'Bearer relay-pi-1') {
          version = 2
          return new Response('old record rejected', {
            status: 401,
            headers: { 'request-id': 'req_pi_old' },
          })
        }
        return new Response(
          finalStatus === 200 ? await success().text() : 'new record rejected',
          {
            status: finalStatus,
            headers: { 'request-id': 'req_pi_new' },
          },
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(model, context, {
      sessionId: 'pi-relay-rotation',
    }).result()
    expect(result.stopReason).toBe(finalStatus === 401 ? 'error' : 'stop')
    expect(relayTokens).toEqual(['Bearer relay-pi-1', 'Bearer relay-pi-2'])
    expect(reports).toEqual(finalStatus === 401 ? [1, 2] : [1])
  }),
)

registerTest.each([200, 401])(
  'Pi CacheKeep retries a rotated scoped receipt once, final status %i',
  wrapBody(async (finalStatus) => {
    const f = await fixture()
    let version = 1
    const sent: string[] = []
    f.client.getScoped = async ({ credentialId }) => ({
      credentialId,
      accountId: fixtureAccountIdentity('main'),
      material: `pi-cachekeep-v${version}`,
      recordVersion: version,
      expiresAtMs: Date.now() + 600_000,
    })
    globalThis.fetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        if (!String(input).includes('/v1/messages'))
          throw new Error('unexpected Pi prewarm destination')
        const authorization =
          new Headers(init?.headers).get('authorization') ?? ''
        sent.push(authorization)
        if (authorization === 'Bearer pi-cachekeep-v1') {
          version = 2
          return new Response('old token', { status: 401 })
        }
        return new Response(
          finalStatus === 401
            ? 'new token rejected'
            : JSON.stringify({ usage: { input_tokens: 1 } }),
          {
            status: finalStatus,
          },
        )
      },
      { preconnect: originalFetch.preconnect },
    )
    const sessionId = `pi-cachekeep-${finalStatus}`
    const acceptedAt = Date.now() - 70 * 60_000
    sessionCacheActivity.record(sessionId, 'main', 3_600_000, acceptedAt)
    deferCleanup(() => sessionCacheActivity.forget(sessionId))
    const result = await __prewarmPiCacheKeepForTest({
      sessionId,
      url: 'https://api.anthropic.com/v1/messages',
      headers: new Headers(),
      bodyText: JSON.stringify({
        model: model.id,
        max_tokens: 128,
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'warm' }],
      }),
      oauthAccountId: 'main',
      oauthAccountIdentity: fixtureAccountIdentity('main'),
      accountStoragePath: f.path,
    })
    expect(result.ok).toBe(finalStatus === 200)
    const expiry = sessionCacheActivity.holdUntil(
      sessionId,
      'main',
      Date.now(),
      'max',
    )
    if (finalStatus === 200) {
      expect(expiry).toBeGreaterThan(Date.now() + 4 * 60_000)
      expect(expiry).toBeLessThanOrEqual(Date.now() + 5 * 60_000)
    } else expect(expiry).toBe(acceptedAt + 3_600_000)
    expect(sent).toEqual(['Bearer pi-cachekeep-v1', 'Bearer pi-cachekeep-v2'])
    expect(f.reports.map((report) => report.recordVersion)).toEqual(
      finalStatus === 401 ? [1, 2] : [1],
    )
  }),
)

test('Pi streamed responseId matches its billing report', async () => {
  await fixture()
  const billing = captureBilling()
  globalThis.fetch = Object.assign(
    async () =>
      new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream_billing","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    { preconnect: originalFetch.preconnect },
  )
  const result = await streamCortexKitAnthropic(model, context, {
    sessionId: 'pi-stream-response-id',
  }).result()
  await Bun.sleep(10)
  expect(result.stopReason).toBe('stop')
  expect(billing.reports).toHaveLength(1)
  expect(billing.reports[0]?.provider_response_id).toBe('msg_stream_billing')
  expect(result.responseId).toBe('msg_stream_billing')
  expect(billing.reports[0]?.provider_response_id).toBe(result.responseId)
})

test('Pi retains responseId when a stream is aborted after message_start', async () => {
  await fixture()
  const controller = new AbortController()
  globalThis.fetch = Object.assign(
    async () =>
      new Response(
        new ReadableStream({
          start(body) {
            body.enqueue(
              new TextEncoder().encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_aborted"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
              ),
            )
            controller.signal.addEventListener('abort', () => body.close())
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    { preconnect: originalFetch.preconnect },
  )
  const stream = streamCortexKitAnthropic(model, context, {
    sessionId: 'pi-stream-response-id-aborted',
    signal: controller.signal,
  })
  for await (const event of stream) {
    if (event.type === 'text_start') controller.abort()
  }
  const result = await stream.result()
  expect(result.stopReason).toBe('aborted')
  expect(result.responseId).toBe('msg_aborted')
})

test('Pi bills each failed and retried physical send with its actual vault payer', async () => {
  const f = await fixture()
  const billing = captureBilling()
  let sends = 0
  const fetchImpl = Object.assign(
    async () =>
      ++sends === 1
        ? Response.json({ type: 'error' }, { status: 401 })
        : Response.json({
            id: 'msg_pi',
            usage: { input_tokens: 6, output_tokens: 4 },
          }),
    { preconnect: originalFetch.preconnect },
  )
  const response = await __sendPiAnthropicRequestForTest(
    {
      model,
      context,
      storagePath: f.path,
      streamOptions: { sessionId: 'pi-billing-retry' },
    },
    { native: f.native, fetch: fetchImpl },
  )
  await response.text()
  await Bun.sleep(10)
  expect(sends).toBe(2)
  expect(billing.sessions).toEqual(['pi-billing-retry', 'pi-billing-retry'])
  expect(billing.reports).toHaveLength(2)
  expect(billing.reports[0]).toMatchObject({
    credential_id: 'oauth:anthropic',
    account_id: fixtureAccountIdentity('main'),
    outcome: 'failed',
    status: 401,
  })
  expect(billing.reports[1]).toMatchObject({
    credential_id: 'oauth:anthropic',
    account_id: fixtureAccountIdentity('main'),
    outcome: 'completed',
    status: 200,
    provider_response_id: 'msg_pi',
    usage: { input: 6, output: 4 },
  })
  expect(billing.reports[0]?.attempt_id).not.toBe(
    billing.reports[1]?.attempt_id,
  )
})

for (const rejectGzip of [false, true]) {
  test(`Pi bills thread recovery and gzip recovery sends independently (gzip rejection: ${rejectGzip})`, async () => {
    const f = await fixture()
    const billing = captureBilling()
    const sent: Array<{ thread?: { type: string }; gzip: boolean }> = []
    const fetchImpl = Object.assign(
      async (_input: unknown, init?: RequestInit) => {
        const gzip =
          new Headers(init?.headers).get('content-encoding') === 'gzip'
        const body = JSON.parse(
          init?.body instanceof Uint8Array
            ? gunzipSync(init.body).toString()
            : String(init?.body),
        )
        sent.push({ thread: body.thread, gzip })
        if (body.thread?.type === 'continue')
          return Response.json(
            {
              type: 'error',
              error: {
                type: 'not_found_error',
                details: { error_code: 'thread_not_found' },
              },
            },
            { status: 404 },
          )
        if (sent.length > 1 && rejectGzip && gzip)
          return new Response('Unsupported content-encoding: gzip', {
            status: 415,
          })
        return new Response(
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: `msg_pi_recovery_${sent.length}`,
              content: [{ type: 'text', text: 'Answer' }],
              usage: {
                input_tokens: 2,
                output_tokens: 0,
                cache_read_input_tokens: 509281,
                cache_creation_input_tokens: 4531,
              },
            },
          })}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":391}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch
    const sessionId = `pi-billing-thread-recovery-${rejectGzip}`
    beginPiPrimaryTurn(f.path, sessionId)
    deferCleanup(() => {
      endPiPrimaryTurn(f.path, sessionId)
      forgetPiMessageThread(sessionId)
    })
    const initial: Context = {
      ...context,
      messages: [{ role: 'user', content: 'x'.repeat(9000), timestamp: 1 }],
    }
    const send = async (current: Context) => {
      const response = await __sendPiAnthropicRequestForTest(
        {
          model,
          context: current,
          storagePath: f.path,
          requestOrigin: 'agent-loop',
          streamOptions: {
            sessionId,
            onPayload: (payload) => payload,
            onResponse: () => {},
            onProviderStreamEvent: () => {},
          },
        },
        { native: f.native, fetch: fetchImpl },
      )
      await response.text()
    }
    await send(initial)
    await send({
      ...initial,
      messages: [
        ...initial.messages,
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Answer' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: 'stop',
          timestamp: 2,
        },
        { role: 'user', content: 'Next', timestamp: 3 },
      ],
    })
    await Bun.sleep(10)
    expect(sent.map((send) => send.thread?.type)).toEqual(
      rejectGzip
        ? ['create', 'continue', 'create', 'create']
        : ['create', 'continue', 'create'],
    )
    if (rejectGzip) {
      expect(sent[2]?.gzip).toBe(true)
      expect(sent[3]?.gzip).toBe(false)
    }
    expect(billing.reports).toHaveLength(sent.length)
    expect(billing.sessions).toEqual(Array(sent.length).fill(sessionId))
    expect(
      new Set(billing.reports.map((report) => report.attempt_id)).size,
    ).toBe(sent.length)
    expect(
      billing.reports.slice(1, -1).map((report) => report.outcome),
    ).toEqual(rejectGzip ? ['failed', 'failed'] : ['failed'])
    for (const report of billing.reports.slice(1, -1)) {
      expect(report).not.toHaveProperty('usage')
      expect(report).not.toHaveProperty('provider_response_id')
    }
    expect(billing.reports.at(-1)).toMatchObject({
      outcome: 'completed',
      credential_id: 'oauth:anthropic',
      provider_response_id: `msg_pi_recovery_${sent.length}`,
      usage: { input: 2, output: 391, cache_read: 509281, cache_write: 4531 },
    })
  })
}

test('Pi bills a model response and its keep-warm under the owning real session', async () => {
  const f = await fixture()
  const billing = captureBilling()
  await sendAndPrewarm(f, 'claude-fable-5-1')
  await Bun.sleep(10)
  expect(billing.sessions).toEqual([
    'pi-prewarm-betas-claude-fable-5-1',
    'pi-prewarm-betas-claude-fable-5-1',
  ])
  expect(billing.reports).toHaveLength(2)
  expect(billing.reports[0]).toMatchObject({
    credential_id: 'oauth:anthropic',
    account_id: fixtureAccountIdentity('main'),
    outcome: 'completed',
    usage: { input: 1, output: 1 },
  })
  expect(billing.reports[1]).toMatchObject({
    credential_id: 'oauth:anthropic',
    account_id: fixtureAccountIdentity('main'),
    request_kind: 'keep_warm',
    outcome: 'completed',
    usage: { input: 1 },
    cache: { ttl_ms: 300_000, warming: { on: true } },
  })
})

for (const cacheKeepEnabled of [true, false]) {
  test(`Pi keeps accepted cache activity but ends untracked real turns with CacheKeep ${cacheKeepEnabled ? 'on' : 'off'}`, async () => {
    const f = await fixture()
    const runtime = await f.native.service()
    await runtime.updateSettings((settings) => ({
      ...settings,
      quota: { enabled: false },
      claudeCache: { enabled: true, mode: 'hybrid' },
      cacheKeep: { enabled: cacheKeepEnabled, always: true },
    }))
    const acceptedAt = Date.now()
    const keep = new CacheKeepManager({
      now: () => acceptedAt,
      loadStorage: async () => (await runtime.read()).policyStorage,
      setIntervalImpl: (() => ({
        unref() {},
      })) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as typeof clearInterval,
    })
    deferCleanup(() => keep.stop())
    const sessionId = 'pi-accepted-only'
    sessionCacheActivity.forget(sessionId)
    deferCleanup(() => sessionCacheActivity.forget(sessionId))
    let status = 200
    let failure: 'throw' | 'abort' | undefined
    const abort = new AbortController()
    const fetchImpl = (async () => {
      if (failure === 'abort') abort.abort()
      if (failure) throw new TypeError('synthetic transport failure')
      return new Response('{}', { status })
    }) as unknown as typeof fetch
    const send = (systemPrompt: string) =>
      __sendPiAnthropicRequestForTest(
        {
          model,
          context: { ...context, systemPrompt },
          storagePath: f.path,
          streamOptions: { sessionId, signal: abort.signal },
        },
        { fetch: fetchImpl, cacheKeep: keep },
      )
    await (await send('accepted')).text()
    const before = keep.trackedRequest(sessionId)
    const facts = keep.registrySessions()
    if (cacheKeepEnabled)
      expect(facts).toMatchObject([
        {
          id: sessionId,
          ttlMs: 3_600_000,
          lastTouchAt: acceptedAt,
          lastTouchKind: 'response',
          cacheExpiresAt: acceptedAt + 3_600_000,
        },
      ])
    else expect(facts).toEqual([])
    if (cacheKeepEnabled) expect(before).toBeDefined()
    else expect(before).toBeUndefined()
    const cacheExpiry = sessionCacheActivity.holdUntil(
      sessionId,
      'main',
      Date.now(),
      'max',
    )
    expect(cacheExpiry).toBeGreaterThan(Date.now() + 55 * 60_000)
    for (status of [400, 413, 429, 500]) {
      await (await send('rejected')).text()
      expect(keep.trackedRequest(sessionId)).toBeUndefined()
      expect(keep.trackedCount()).toBe(0)
      expect(
        sessionCacheActivity.holdUntil(sessionId, 'main', Date.now(), 'max'),
      ).toBe(cacheExpiry)
    }
    failure = 'throw'
    await expect(send('transport error')).rejects.toThrow(
      'synthetic transport failure',
    )
    expect(keep.trackedRequest(sessionId)).toBeUndefined()
    failure = undefined
    status = 201
    await (await send('accepted next step')).text()
    if (cacheKeepEnabled)
      expect(keep.trackedRequest(sessionId)?.bodyText).toContain(
        'accepted next step',
      )
    const nextExpiry = sessionCacheActivity.holdUntil(
      sessionId,
      'main',
      Date.now(),
      'max',
    )
    failure = 'abort'
    await expect(send('aborted')).rejects.toThrow()
    expect(keep.trackedRequest(sessionId)).toBeUndefined()
    expect(
      sessionCacheActivity.holdUntil(sessionId, 'main', Date.now(), 'max'),
    ).toBe(nextExpiry)
  })
}

test('a Pi request lease skips a due warm and its aborted request finally retires the old target', async () => {
  const f = await fixture()
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }))
  let now = Date.now()
  let warms = 0
  const keep = new CacheKeepManager({
    now: () => now,
    loadStorage: async () => (await runtime.read()).policyStorage,
    fetchImpl: (async () => {
      warms++
      return Response.json({ usage: { cache_read_input_tokens: 100 } })
    }) as unknown as typeof fetch,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as typeof clearInterval,
  })
  deferCleanup(() => keep.dispose())
  const sessionId = 'pi-real-turn-busy-abort'
  deferCleanup(() => sessionCacheActivity.forget(sessionId))
  await (
    await __sendPiAnthropicRequestForTest(
      { model, context, storagePath: f.path, streamOptions: { sessionId } },
      {
        native: f.native,
        cacheKeep: keep,
        fetch: (async () => Response.json({})) as unknown as typeof fetch,
      },
    )
  ).text()
  now = keep.trackedSessions()[0]!.nextPrewarmAt
  await keep.tick()
  expect(warms).toBe(1)
  const entered = lifetimes.gate()
  const release = lifetimes.gate()
  const abort = new AbortController()
  const sending = __sendPiAnthropicRequestForTest(
    {
      model,
      context,
      storagePath: f.path,
      streamOptions: { sessionId, signal: abort.signal },
    },
    {
      native: f.native,
      cacheKeep: keep,
      fetch: (async () => {
        entered.open()
        await release.wait
        abort.signal.throwIfAborted()
        return Response.json({})
      }) as unknown as typeof fetch,
    },
  ).catch((error) => error)
  await entered.wait
  try {
    now = keep.trackedSessions()[0]!.nextPrewarmAt
    await keep.tick()
    expect(warms).toBe(1)
    abort.abort()
    release.open()
    expect(await sending).toBeInstanceOf(Error)
    expect(keep.trackedCount()).toBe(0)
    await keep.tick()
    expect(warms).toBe(1)
  } finally {
    abort.abort()
    release.open()
    await sending
  }
})

// Sends one model request through Pi's real stream path, then replays its
// captured URL, headers and body through Pi's CacheKeep prewarm, recording
// both outbound requests. CacheKeep rebuilds the prewarm headers itself, so a
// beta the model request needed but the prewarm forgot shows up as a
// difference between the two captures.
async function sendAndPrewarm(
  f: Awaited<ReturnType<typeof fixture>>,
  modelId: string,
  effortTransitions?: Array<{
    afterAssistantMessages: number
    effort: 'low' | 'high'
  }>,
  replayThinking = false,
) {
  const sent: Array<{ url: string; headers: Headers; body: string }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (!String(input).includes('/v1/messages'))
        throw new Error('unexpected Pi request destination')
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      })
      return sent.length === 1
        ? success()
        : new Response(JSON.stringify({ usage: { input_tokens: 1 } }))
    },
    { preconnect: originalFetch.preconnect },
  )
  const conversation: Context = {
    systemPrompt: 'Test',
    tools: [],
    messages: [
      { role: 'user', content: 'first', timestamp: 0 },
      {
        role: 'assistant',
        provider: 'anthropic',
        api: 'anthropic-messages',
        model: modelId,
        content: [
          ...(replayThinking
            ? [
                {
                  type: 'thinking' as const,
                  thinking: 'reasoning',
                  thinkingSignature: 'signature',
                },
              ]
            : []),
          { type: 'text', text: 'first answer' },
        ],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 0,
      },
      { role: 'user', content: 'second', timestamp: 0 },
    ],
  }
  const result = await streamCortexKitAnthropic(
    { ...model, id: modelId },
    conversation,
    { sessionId: `pi-prewarm-betas-${modelId}`, reasoning: 'high' },
    effortTransitions,
  ).result()
  expect(result.stopReason).toBe('stop')
  const [main] = sent
  if (!main) throw new Error('Pi sent no model request')
  const prewarm = await __prewarmPiCacheKeepForTest({
    sessionId: `pi-prewarm-betas-${modelId}`,
    url: main.url,
    headers: main.headers,
    bodyText: main.body,
    oauthAccountId: 'main',
    oauthAccountIdentity: fixtureAccountIdentity('main'),
    accountStoragePath: f.path,
  })
  expect(prewarm.ok).toBe(true)
  expect(sent).toHaveLength(2)
  const warm = sent[1]!
  expect(JSON.parse(warm.body).thread).toBeUndefined()
  const betas = (headers: Headers) =>
    (headers.get('anthropic-beta') ?? '').split(',')
  return {
    main: { ...main, betas: betas(main.headers), json: JSON.parse(main.body) },
    warm: { ...warm, betas: betas(warm.headers), json: JSON.parse(warm.body) },
  }
}

const hasEffortMarker = (body: { messages: Array<{ role?: string }> }) =>
  body.messages.some((message) => message.role === 'system')

// The prewarm adds the extended cache TTL beta to what the model request
// sent. These bodies have the full agent shape, whose Claude Code beta list
// already includes that beta, so the prewarm must send the model request's
// beta header byte for byte, and the same value for every other header.
// Authorization and the per-request id are minted for each send and are
// excluded.
function expectPrewarmHeadersMatchModelRequest(
  main: { headers: Headers; betas: string[] },
  warm: { headers: Headers; betas: string[] },
) {
  expect(main.betas).toContain(CACHE_KEEP_EXTENDED_TTL_BETA)
  expect(warm.betas).toEqual(
    main.betas.filter((beta) => beta !== 'message-threads-2026-08-12'),
  )
  expect(warm.betas).not.toContain('message-threads-2026-08-12')
  const others = (headers: Headers) =>
    [...headers.entries()].filter(
      ([name]) =>
        name !== 'anthropic-beta' &&
        name !== 'authorization' &&
        name !== 'x-client-request-id',
    )
  expect(others(warm.headers)).toEqual(others(main.headers))
}

test('Pi CacheKeep prewarm preserves thinking block binding and carries its beta', async () => {
  const f = await fixture()
  await (await f.native.service()).updateSettings((settings) => ({
    ...settings,
    thinkingBinding: { prefixMismatchBehavior: 'drop_block' },
  }))
  const { main, warm } = await sendAndPrewarm(
    f,
    'claude-fable-5-2',
    undefined,
    true,
  )
  expect(main.json.thinking.block_binding).toEqual({
    prefix_mismatch_behavior: 'drop_block',
  })
  expect(warm.json.max_tokens).toBe(0)
  expect(warm.json.thinking).toEqual(main.json.thinking)
  expect(warm.json.messages).toEqual(main.json.messages)
  expect(warm.betas).toContain('thinking-binding-controls-2026-08-01')
  expectPrewarmHeadersMatchModelRequest(main, warm)
})

test('Pi CacheKeep prewarm of a Fable 5.1 body with effort markers sends the per-turn control beta', async () => {
  const f = await fixture()
  const { main, warm } = await sendAndPrewarm(f, 'claude-fable-5-1', [
    { afterAssistantMessages: 0, effort: 'low' },
    { afterAssistantMessages: 1, effort: 'high' },
  ])
  expect(hasEffortMarker(main.json)).toBe(true)
  expect(hasEffortMarker(warm.json)).toBe(true)
  expect(main.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(warm.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(main.betas).not.toContain('mid-conversation-output-config-2026-07-01')
  expect(warm.betas).not.toContain('mid-conversation-output-config-2026-07-01')
  expect(warm.betas).not.toContain('mid-conversation-system-2026-04-07')
  expectPrewarmHeadersMatchModelRequest(main, warm)
})

test('Pi CacheKeep prewarm of a Fable 5.1 body without effort markers sends the model request betas', async () => {
  const f = await fixture()
  const { main, warm } = await sendAndPrewarm(f, 'claude-fable-5-1')
  expect(hasEffortMarker(main.json)).toBe(false)
  expect(hasEffortMarker(warm.json)).toBe(false)
  // Every OAuth Fable 5.1 model request carries this beta, markers or not.
  expect(main.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(warm.betas).toContain(PER_TURN_CONTROL_BETA)
  expectPrewarmHeadersMatchModelRequest(main, warm)
})

test('Pi CacheKeep prewarm of an Opus 5.5 body with effort markers keeps the per-turn control beta', async () => {
  const f = await fixture()
  const { main, warm } = await sendAndPrewarm(f, 'claude-opus-5-5', [
    { afterAssistantMessages: 0, effort: 'low' },
    { afterAssistantMessages: 1, effort: 'high' },
  ])
  expect(hasEffortMarker(main.json)).toBe(true)
  expect(hasEffortMarker(warm.json)).toBe(true)
  expect(warm.betas).toContain(PER_TURN_CONTROL_BETA)
  expect(warm.betas).not.toContain('mid-conversation-output-config-2026-07-01')
  expectPrewarmHeadersMatchModelRequest(main, warm)
})

registerTest.each([200, 401])(
  'Pi WebSocket relay retries a strict-newer native receipt once and reports every rejected version; final status %i',
  wrapBody(async (finalStatus) =>
    trackPiTestBody(
      (async () => {
        const f = await fixture()
        let version = 1
        const sent: string[] = []
        f.client.getScoped = async ({ credentialId }) => ({
          credentialId,
          accountId: fixtureAccountIdentity('main'),
          material: `pi-ws-v${version}`,
          recordVersion: version,
          expiresAtMs: Date.now() + 600_000,
        })
        const sse = await success().text()
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch: (request, server) =>
            server.upgrade(request)
              ? undefined
              : new Response('unexpected HTTP', { status: 500 }),
          websocket: {
            open: (socket) => {
              socket.send(
                JSON.stringify({ type: 'ready', protocol: 2, state: null }),
              )
            },
            message: (socket, data) => {
              const payload = JSON.parse(String(data)) as {
                id: string
                upstream: { headers: Record<string, string> }
              }
              const token = payload.upstream.headers.authorization ?? ''
              sent.push(token)
              const status = token === 'Bearer pi-ws-v1' ? 401 : finalStatus
              version = 2
              socket.send(
                JSON.stringify({
                  type: 'response_start',
                  id: payload.id,
                  status,
                  headers: { 'content-type': 'text/event-stream' },
                }),
              )
              if (status === 200)
                socket.send(
                  JSON.stringify({
                    type: 'chunk',
                    id: payload.id,
                    base64: Buffer.from(sse).toString('base64'),
                  }),
                )
              socket.send(JSON.stringify({ type: 'done', id: payload.id }))
            },
          },
        })
        const abort = new AbortController()
        const deadline = setTimeout(() => abort.abort(), 4_000)
        try {
          await (await getPiNativeRuntime(f.path).service()).updateRelay({
            enabled: true,
            url: server.url.href,
            token: 'synthetic-ws-relay-secret',
            transport: 'websocket',
            fallbackToDirect: false,
          })
          const result = await streamCortexKitAnthropic(model, context, {
            sessionId: `pi-ws-${finalStatus}`,
            signal: abort.signal,
          }).result()
          expect(result.stopReason).toBe(finalStatus === 200 ? 'stop' : 'error')
          expect(sent).toEqual(['Bearer pi-ws-v1', 'Bearer pi-ws-v2'])
          expect(
            f.reports.map((report) => [
              report.recordVersion,
              report.reporterSource,
            ]),
          ).toEqual(
            finalStatus === 200
              ? [[1, 'relay_status_field']]
              : [
                  [1, 'relay_status_field'],
                  [2, 'relay_status_field'],
                ],
          )
        } finally {
          clearTimeout(deadline)
          abort.abort()
          server.stop(true)
        }
      })(),
    ),
  ),
)

test('Pi WebSocket reconnect authorizes the replacement physical attempt without reporting a transport failure', () =>
  trackPiTestBody(
    (async () => {
      const f = await fixture()
      const sent: string[] = []
      const sse = await success().text()
      const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request, server) =>
          server.upgrade(request)
            ? undefined
            : new Response('unexpected HTTP', { status: 500 }),
        websocket: {
          open: (socket) => {
            socket.send(
              JSON.stringify({ type: 'ready', protocol: 2, state: null }),
            )
          },
          message: (socket, data) => {
            const payload = JSON.parse(String(data)) as {
              id: string
              body?: string
              upstream: { headers: Record<string, string> }
            }
            if (payload.body)
              expect(JSON.parse(payload.body).thread).toBeUndefined()
            sent.push(payload.upstream.headers.authorization ?? '')
            if (sent.length === 1) {
              socket.close(1011, 'interrupted before upstream')
              return
            }
            socket.send(
              JSON.stringify({
                type: 'response_start',
                id: payload.id,
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              }),
            )
            socket.send(
              JSON.stringify({
                type: 'chunk',
                id: payload.id,
                base64: Buffer.from(sse).toString('base64'),
              }),
            )
            socket.send(JSON.stringify({ type: 'done', id: payload.id }))
          },
        },
      })
      const abort = new AbortController()
      const deadline = setTimeout(() => abort.abort(), 4_000)
      try {
        await (await getPiNativeRuntime(f.path).service()).updateRelay({
          enabled: true,
          url: server.url.href,
          token: 'synthetic-ws-reconnect-secret',
          transport: 'websocket',
          fallbackToDirect: false,
        })
        expect(
          (
            await streamCortexKitAnthropic(model, context, {
              sessionId: 'pi-ws-reconnect',
              signal: abort.signal,
            }).result()
          ).stopReason,
        ).toBe('stop')
        expect(sent).toEqual([
          'Bearer vault-test-access-1',
          'Bearer vault-test-access-2',
        ])
        expect(f.gets).toHaveLength(2)
        expect(f.reports).toEqual([])
      } finally {
        clearTimeout(deadline)
        abort.abort()
        server.stop(true)
      }
    })(),
  ))

test('Pi refuses an unchanged native vault version after 401 without local or paid API rescue', async () => {
  const f = await fixture()
  f.client.getScoped = async ({ credentialId }) => ({
    credentialId,
    accountId: fixtureAccountIdentity('main'),
    material: 'synthetic-unchanged-vault-access',
    recordVersion: 1,
    expiresAtMs: Date.now() + 600_000,
  })
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return new Response('same version rejected', { status: 401 })
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        apiKey: 'synthetic-host-rescue',
      }).result()
    ).stopReason,
  ).toBe('error')
  expect(sends).toBe(1)
  expect(f.reports.map((report) => report.recordVersion)).toEqual([1])
})

registerTest.each([
  'https://unapproved.invalid/v1',
  'http://api.anthropic.com',
  'https://user:password@api.anthropic.com/v1',
  'https://api.anthropic.com:8443/v1',
  'blob:https://api.anthropic.com/opaque',
  'not a URL',
])(
  'Pi rejects native OAuth recipient %s before authorization or dispatch',
  wrapBody(async (baseUrl) => {
    const f = await fixture()
    let sends = 0
    globalThis.fetch = Object.assign(
      async () => {
        sends++
        return success()
      },
      { preconnect: originalFetch.preconnect },
    )
    const result = await streamCortexKitAnthropic(
      { ...model, baseUrl },
      context,
    ).result()
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toContain('official Anthropic HTTPS origin')
    expect(f.gets).toEqual([])
    expect(sends).toBe(0)
  }),
)

test('Pi accepts the official versioned OAuth endpoint with redirects disabled', async () => {
  const f = await fixture()
  const requests: Array<{
    url: string
    redirect: RequestInit['redirect']
  }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requests.push({ url: String(input), redirect: init?.redirect })
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (
      await streamCortexKitAnthropic(
        { ...model, baseUrl: 'https://api.anthropic.com/v1' },
        context,
      ).result()
    ).stopReason,
  ).toBe('stop')
  expect(requests).toEqual([
    {
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      redirect: 'error',
    },
  ])
  expect(f.gets).toHaveLength(1)
})

test('Pi refuses a foreign CacheKeep target before authorizing a native receipt', async () => {
  const f = await fixture()
  let sends = 0
  globalThis.fetch = Object.assign(
    async () => {
      sends++
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const result = await __prewarmPiCacheKeepForTest({
    sessionId: 'pi-foreign-prewarm',
    url: 'https://unapproved.invalid/v1/messages',
    headers: new Headers(),
    bodyText: JSON.stringify({ model: model.id, max_tokens: 0, messages: [] }),
    oauthAccountId: 'main',
    oauthAccountIdentity: fixtureAccountIdentity('main'),
    accountStoragePath: f.path,
  })
  expect(result.ok).toBe(false)
  expect(f.gets).toEqual([])
  expect(sends).toBe(0)
})

registerTest.each([
  { name: 'Fable', id: 'claude-fable-5-1', allowed: false },
  { name: 'Sonnet', id: 'claude-sonnet-5-5', allowed: true },
])(
  'Pi final native vault admission rechecks the pending request model: $name',
  wrapBody((requested) =>
    trackPiTestBody(
      (async () => {
        const f = await fixture()
        const runtime = await getPiNativeRuntime(f.path).service()
        const receipt = await runtime.authorizeVault('main')
        const checkedAt = Date.now()
        const quota = (remaining: number, at: number) => ({
          accountIdentity: fixtureAccountIdentity('main'),
          checkedAt: at,
          source: 'poll' as const,
          five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: at },
          seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: at },
          scoped: [
            {
              id: 'fable-weekly',
              title: 'Fable weekly',
              modelName: 'Fable',
              usedPercent: 100 - remaining,
              remainingPercent: remaining,
              checkedAt: at,
            },
          ],
        })
        expect(
          await runtime.vault.publish(receipt, {
            quota: quota(100, checkedAt),
          }),
        ).toBe(true)
        await runtime.updateSettings((settings) => ({
          ...settings,
          killswitch: {
            enabled: true,
            main: { five_hour: 5, seven_day: 10, scoped: 0 },
          },
        }))
        let entered: () => void = () => {}
        let release: () => void = () => {}
        const pending = new Promise<void>((resolve) => {
          entered = resolve
        })
        const resume = new Promise<void>((resolve) => {
          release = resolve
        })
        const get = f.client.getScoped
        f.client.getScoped = async (input) => {
          entered()
          await resume
          return get(input)
        }
        const sent: string[] = []
        globalThis.fetch = Object.assign(
          async (input: Parameters<typeof fetch>[0]) => {
            sent.push(String(input))
            if (!String(input).includes('/v1/messages'))
              throw new Error(
                'Unexpected quota dispatch in final admission control',
              )
            return success()
          },
          { preconnect: originalFetch.preconnect },
        )
        const response = streamCortexKitAnthropic(
          { ...model, id: requested.id, name: requested.name },
          context,
        ).result()
        try {
          await pending
          expect(
            await runtime.vault.publish(receipt, {
              quota: quota(0, checkedAt + 1),
            }),
          ).toBe(true)
        } finally {
          release()
        }
        const result = await response
        expect(result.stopReason).toBe(requested.allowed ? 'stop' : 'error')
        expect(sent).toEqual(
          requested.allowed
            ? ['https://api.anthropic.com/v1/messages?beta=true']
            : [],
        )
        expect(f.reports).toEqual([])
      })(),
    ),
  ),
)

async function vaultWarmHintFixture() {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  const runtime = await f.native.service()
  await runtime.vault.refresh()
  const bodies: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('/api/oauth/usage'))
        return Response.json({
          five_hour: { utilization: 20 },
          seven_day: { utilization: 20 },
        })
      if (!url.includes('/v1/messages'))
        throw new Error('Unexpected warm hint fixture request')
      const body = init?.body
      if (typeof body !== 'string' && !(body instanceof Uint8Array))
        throw new Error('Missing model request bytes')
      bodies.push(
        new Headers(init?.headers).get('content-encoding') === 'gzip'
          ? gunzipSync(body).toString()
          : typeof body === 'string'
            ? body
            : Buffer.from(body).toString(),
      )
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const previous = globals[key]
  const requests: Record<string, unknown>[] = []
  let answer: unknown = {
    account_id: fixtureAccountIdentity('main'),
    credential_id: 'oauth:anthropic',
  }
  globals[key] = () => ({
    accountFor: async (request: Record<string, unknown>) => {
      requests.push(request)
      return answer
    },
  })
  deferCleanup(() => {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  })
  const send = () =>
    streamCortexKitAnthropic(model, context, {
      sessionId: 'pi-warm-hint',
    }).result()
  return {
    ...f,
    runtime,
    bodies,
    requests,
    send,
    noAdvice: () => {
      answer = null
    },
  }
}

function expectedVaultRoutingAsk(includePrimary: boolean) {
  const primary = {
    account_id: fixtureAccountIdentity('main'),
    credential_id: 'oauth:anthropic',
  }
  const work = {
    account_id: fixtureAccountIdentity('work'),
    credential_id: 'oauth:anthropic:work',
  }
  return {
    provider: 'anthropic',
    modelId: model.id,
    request_id: expect.any(String),
    refusals: true,
    waits_for_capacity: true,
    candidates: {
      // Only the digest sorts the pairs; the wire array stays in fixture order.
      view_digest: includePrimary
        ? 'a16c4e0158d4c41bc1287f115ff4bef300c8aafe39a84b9cfb429df2633a756c'
        : 'bc478767e59d442751d6d01662ef933c889a861191cb31d2f8facfb5e89f45e4',
      accounts: includePrimary ? [primary, work] : [work],
    },
  }
}

test('Pi sends its pinned vault warm credential on every model request without changing request bytes', async () => {
  const f = await vaultWarmHintFixture()
  expect((await f.send()).stopReason).toBe('stop')
  f.noAdvice()
  expect((await f.send()).stopReason).toBe('stop')
  expect((await f.send()).stopReason).toBe('stop')
  const plain = expectedVaultRoutingAsk(true)
  expect(f.requests).toEqual([
    plain,
    { ...plain, warm_credential: 'oauth:anthropic' },
    { ...plain, warm_credential: 'oauth:anthropic' },
  ])
  expect(f.bodies).toHaveLength(3)
  expect(f.bodies[1]).toBe(f.bodies[0])
  expect(f.bodies[2]).toBe(f.bodies[0])
})

for (const condition of ['disabled', 'signed out', 'unservable']) {
  test(`Pi omits the warm hint for a pinned account that is ${condition}`, async () => {
    const f = await vaultWarmHintFixture()
    expect((await f.send()).stopReason).toBe('stop')
    f.noAdvice()
    if (condition === 'disabled')
      await f.runtime.vault.setEnabled('main', false)
    else {
      const primary = f.rows[0]
      if (!primary) throw new Error('Missing fixture primary')
      f.rows[0] = {
        ...primary,
        state: condition === 'signed out' ? 'needs_reauth' : 'expired',
      }
      await f.runtime.vault.refresh()
    }
    expect((await f.send()).stopReason).toBe('stop')
    expect(f.requests).toEqual([
      expectedVaultRoutingAsk(true),
      expectedVaultRoutingAsk(false),
    ])
  })
}

test('Pi vault default UUID replacement re-places the old session without inheriting quota or changing an unrelated fallback pin', async () => {
  const f = await fixture('sticky-balanced')
  f.rows.push(row('oauth:anthropic:work', fixtureAccountIdentity('work')))
  await (await f.native.service()).vault.refresh()
  const served: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const authorization =
        new Headers(init?.headers).get('authorization') ?? ''
      const index =
        Number(/vault-test-access-(\d+)$/.exec(authorization)?.[1]) - 1
      const credentialId = f.gets[index]?.credentialId
      if (!credentialId) throw new Error('Request did not use a scoped receipt')
      if (String(input).includes('/api/oauth/usage'))
        return Response.json({
          five_hour: {
            utilization: 20,
            resets_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          seven_day: {
            utilization: 20,
            resets_at: new Date(Date.now() + 86_400_000).toISOString(),
          },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: credentialId === 'oauth:anthropic' ? 100 : 0,
              scope: { model: { display_name: 'Fable' } },
            },
          ],
        })
      if (!String(input).includes('/v1/messages'))
        throw new Error('Unexpected outbound request')
      served.push(credentialId)
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const mainSession = 'vault-default-session'
  const fallbackSession = 'vault-fallback-session'
  const opus = { ...model, id: 'claude-opus-5' }
  expect(
    (
      await streamCortexKitAnthropic(opus, context, {
        sessionId: mainSession,
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: fallbackSession,
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(served).toEqual(['oauth:anthropic', 'oauth:anthropic:work'])
  const routingPath = await f.native.routingPath()
  const fallbackKey = createHash('sha256').update(fallbackSession).digest('hex')
  const mainKey = createHash('sha256').update(mainSession).digest('hex')
  // A request chooses its session pin without waiting for that pin's write to
  // the routing file: the sticky router queues the write and finishes it
  // later under the routing lock. Wait for those queued writes before reading
  // the file.
  await f.native.drainRoutingPublications()
  const beforeText = await readFile(routingPath, 'utf8')
  const fallbackPinBytes = (text: string) => {
    const match = text.match(new RegExp(`"${fallbackKey}":\\s*(\\{[^}]*\\})`))
    if (!match?.[1]) throw new Error('Expected fallback pin is missing')
    return match[1]
  }
  const beforePin = fallbackPinBytes(beforeText)
  expect(JSON.parse(beforeText).assignments[mainKey].accountIdentity).toBe(
    fixtureAccountIdentity('main'),
  )
  const nextUuid = fixtureAccountIdentity('replacement-main')
  f.rows[0] = row('oauth:anthropic', nextUuid)
  await (await f.native.service()).vault.refresh()
  const replacement = (await f.native.view()).accounts.find(
    (account) => account.id === 'main',
  )
  expect(replacement?.accountIdentity).toBe(nextUuid)
  expect(replacement?.quota).toBeUndefined()
  expect(
    (
      await streamCortexKitAnthropic(opus, context, {
        sessionId: mainSession,
      }).result()
    ).stopReason,
  ).toBe('stop')
  await f.native.drainRoutingPublications()
  const afterText = await readFile(routingPath, 'utf8')
  expect(JSON.parse(afterText).assignments[mainKey].accountIdentity).toBe(
    nextUuid,
  )
  expect(fallbackPinBytes(afterText)).toBe(beforePin)
  expect(await Promise.all(f.localFiles.map((file) => readFile(file)))).toEqual(
    f.beforeLocal,
  )
})

test('first Pi request after a 1.x vault upgrade uses legacy fallback-first before any main send', async () => {
  const f = await fixture()
  const workUuid = fixtureAccountIdentity('work')
  f.rows.push(row('oauth:work', workUuid))
  await (await f.native.service()).vault.refresh()
  const paths = await resolveNativePoolPaths(
    f.path,
    join(dirname(f.path), 'anthropic-auth-state.json'),
  )
  const vault = nativeVaultPaths(paths)
  const legacy = JSON.stringify({
    version: 1,
    mainAccountId: fixtureAccountIdentity('main'),
    claustrum: {
      mode: 'claustrum',
      primaryAccount: {
        credentialId: 'oauth:anthropic',
        accountId: fixtureAccountIdentity('main'),
        state: 'active',
      },
    },
    routing: { mode: 'fallback-first' },
    quota: { enabled: false },
    prime: { enabled: false },
    cacheKeep: { enabled: false },
    accounts: [
      {
        id: 'old-work',
        label: 'Work',
        type: 'oauth',
        enabled: true,
        addedAt: Date.now(),
        claustrumScopedCredentialId: 'oauth:work',
        anthropicAccountUuid: workUuid,
      },
    ],
  })
  await writeFile(f.path, legacy, { mode: 0o600 })
  closePiNativeRuntime(f.path)
  await rm(vault.config, { force: true })
  await rm(vault.routing, { force: true })
  getPiNativeRuntime(f.path, { connect: async () => f.client })
  expect(f.gets).toHaveLength(0)
  const sent: string[] = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (String(input).includes('/v1/messages'))
        sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  const first = await streamCortexKitAnthropic(model, context, {
    sessionId: 'legacy-vault-first-request',
  }).result()
  expect(first.errorMessage).toBeUndefined()
  expect(first.stopReason).toBe('stop')
  expect(sent).toEqual(['Bearer vault-test-access-1'])
  expect(f.gets.map((get) => get.credentialId)).toEqual(['oauth:work'])
  expect(JSON.parse(await readFile(vault.config, 'utf8')).routing).toEqual({
    mode: 'fallback-first',
  })
  expect(await readFile(f.path, 'utf8')).toBe(legacy)
})

test('Pi serves through a vault outage without local token rescue', async () => {
  const f = await fixture()
  const sent: string[] = []
  globalThis.fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '')
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: 'outage',
      }).result()
    ).stopReason,
  ).toBe('stop')
  f.client.getScoped = async () => {
    throw Object.assign(new Error('outage'), { code: 'ECONNREFUSED' })
  }
  expect(
    (
      await streamCortexKitAnthropic(model, context, {
        sessionId: 'outage',
      }).result()
    ).stopReason,
  ).toBe('stop')
  expect(sent).toEqual([
    'Bearer vault-test-access-1',
    'Bearer vault-test-access-1',
  ])
  expect(f.reports).toHaveLength(0)
  expect(await Promise.all(f.localFiles.map((file) => readFile(file)))).toEqual(
    f.beforeLocal,
  )
})

for (const [transport, credentialSource] of [
  ['direct', 'vault'],
  ['http', 'vault'],
  ['direct', 'local'],
  ['http', 'local'],
] as const) {
  test(`Pi create then continue survives ${credentialSource} refresh and keep-warm retains full history over ${transport}`, async () => {
    // Relay requests can contain edits to the previous request. Each fake relay
    // starts without earlier tests' request bodies, so its session must be distinct.
    const primarySession = `pi-message-thread-${credentialSource}-${transport}`
    let localAccount = fixtureAccountIdentity('main')
    const f = await fixture(
      'main-first',
      transport === 'http',
      credentialSource === 'local',
      () => localAccount,
    )
    let version = 1
    const get = f.client.getScoped.bind(f.client)
    const credentials = spyOn(f.client, 'getScoped').mockImplementation(
      async (input) => ({
        ...(await get(input)),
        material: `sk-ant-oat01-thread-access-${version}`,
        recordVersion: version,
      }),
    )
    deferCleanup(() => credentials.mockRestore())
    const runtime = await f.native.service()
    const local =
      credentialSource === 'local'
        ? createNativeAccountRuntime({
            paths: await resolveNativePoolPaths(f.path),
            host: 'pi',
            local: {
              resolveIdentity: async () =>
                getClaudeCodeIdentityForVerifiedAccount('main', localAccount),
              refreshToken: async () => ({
                access: `sk-ant-oat01-thread-access-${version}`,
                refresh: `thread-refresh-${version}`,
                expires: Date.now() + 3_600_000,
                expiresIn: 3600,
              }),
            },
          })
        : undefined
    if (local) {
      deferCleanup(() => local.close())
    }
    await runtime.updateSettings((settings) => ({
      ...settings,
      quota: { enabled: false },
      claudeCache: { enabled: true, mode: 'hybrid' },
      cacheKeep: { enabled: true, always: true },
    }))
    const keep = new CacheKeepManager({
      loadStorage: async () => (await runtime.read()).policyStorage,
      setIntervalImpl: (() => ({
        unref() {},
      })) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {}) as typeof clearInterval,
    })
    deferCleanup(() => keep.stop())
    const tracking = spyOn(keep, 'track')
    deferCleanup(() => tracking.mockRestore())
    const sent: Array<{ text: string; headers: Headers }> = []
    let rejection: string | undefined
    let relayBody = ''
    const applyPatch = new Function(
      WORKER_SCRIPT.replace(/export default[\s\S]*$/, 'return applyPatchSet'),
    )() as (base: string, patch: unknown) => string
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const url = _input instanceof Request ? _input.url : String(_input)
      if (url.includes('/api/claude_cli/bootstrap'))
        return Response.json({ oauth_account: { account_uuid: localAccount } })
      if (url.includes('/api/oauth/usage'))
        return Response.json({
          five_hour: { utilization: 0 },
          seven_day: { utilization: 0 },
        })
      const wireText =
        init?.body instanceof Uint8Array
          ? gunzipSync(init.body).toString().trim()
          : String(init?.body)
      const envelope = JSON.parse(wireText)
      const text =
        envelope.mode === 'patch'
          ? applyPatch(relayBody, envelope.patch)
          : typeof envelope.body === 'string'
            ? envelope.body
            : wireText
      if (envelope.mode) relayBody = text
      sent.push({
        text,
        headers: new Headers(envelope.upstream?.headers ?? init?.headers),
      })
      if (rejection) {
        const code = rejection
        rejection = undefined
        return Response.json(
          {
            type: 'error',
            error: {
              type:
                code === 'thread_not_found'
                  ? 'not_found_error'
                  : 'invalid_request_error',
              details: { error_code: code },
            },
          },
          {
            status: code === 'thread_not_found' ? 404 : 400,
            headers: { 'request-id': 'req_thread_error' },
          },
        )
      }
      return new Response(
        `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_pi_thread","content":[{"type":"text","text":"Answer"}]}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof fetch
    globalThis.fetch = fetchImpl
    const primaryHooks = new Map<
      string,
      (event: unknown, ctx: unknown) => unknown
    >()
    await cortexKitPiAnthropicAuth(
      {
        registerCommand() {},
        registerProvider() {},
        on: (
          event: string,
          handler: (event: unknown, ctx: unknown) => unknown,
        ) => primaryHooks.set(event, handler),
      } as unknown as ExtensionAPI,
      { connectScoped: f.connect },
    )
    let oauthAccountId = 'main'
    const send = async (
      requestContext: Context,
      sessionId = primarySession,
    ) => {
      await primaryHooks.get('turn_start')?.(
        {},
        {
          hasUI: false,
          sessionManager: {
            getSessionId: () => sessionId,
            getBranch: () => [],
            getEntries: () => [],
          },
        },
      )
      return __sendPiAnthropicRequestForTest(
        {
          model,
          context: requestContext,
          storagePath: f.path,
          oauthAccountId,
          requestOrigin: 'agent-loop',
          streamOptions: {
            sessionId,
            onPayload: (payload) => payload,
            onResponse: () => {},
            onProviderStreamEvent: () => {},
          },
        },
        { fetch: fetchImpl, cacheKeep: keep, native: f.native },
      )
    }
    const threadContext: Context = {
      ...context,
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: { properties: {}, required: [] },
        },
      ],
    }
    await (await send(threadContext)).text()
    const history: Context = {
      ...threadContext,
      messages: [
        ...threadContext.messages,
        {
          role: 'assistant',
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: model.id,
          content: [{ type: 'text', text: 'Answer' }],
          stopReason: 'stop',
          timestamp: 1,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        { role: 'user', content: 'Next prompt', timestamp: 2 },
      ],
    }
    version = 2
    if (local) {
      const before = await local.captureLocalSubject('main')
      const refreshed = await local.authorizeLocal('main', {
        intent: 'refresh',
      })
      expect(refreshed.status).toBe('usable')
      if (refreshed.status === 'usable')
        expect(refreshed.binding).toEqual(before.binding)
    }
    await (await send(history)).text()
    const first = JSON.parse(sent[0]?.text ?? '{}')
    const second = JSON.parse(sent[1]?.text ?? '{}')
    expect(second.messages).toHaveLength(1)
    expect(sent[1]?.headers.get('authorization')).not.toBe(
      sent[0]?.headers.get('authorization'),
    )
    expect(first.thread).toEqual({ type: 'create' })
    expect(second.thread).toEqual({
      type: 'continue',
      previous_message_id: 'msg_pi_thread',
    })
    expect(second.messages).toHaveLength(1)
    expect(JSON.stringify(second.messages)).toContain('Next prompt')
    expect(JSON.stringify(second.messages)).not.toContain('Hello')
    const oneHourControl = { type: 'ephemeral', ttl: '1h' }
    expect(first.tools.at(-1)?.cache_control).toEqual(oneHourControl)
    expect(first.system.at(-1)?.cache_control).toEqual(oneHourControl)
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools))
    // The signature and lineage can change between user prompts. The fixed
    // system bytes, including cache controls and the first-user version suffix, cannot.
    const systemBytes = (system: unknown) =>
      stripBillingLineageFields(
        JSON.stringify(system).replace(/cch=[a-f0-9]{5}/g, 'cch=00000'),
      )
    expect(systemBytes(second.system)).toBe(systemBytes(first.system))
    expect(second.system[0].text.match(/cc_version=[^;]+/)?.[0]).toBe(
      first.system[0].text.match(/cc_version=[^;]+/)?.[0],
    )
    expect(sent[1]?.headers.get('anthropic-beta')).toBe(
      sent[0]?.headers.get('anthropic-beta'),
    )
    expect(sent[1]?.headers.get('anthropic-beta')?.split(',').at(-1)).toBe(
      'message-threads-2026-08-12',
    )
    expect(await signRequestBody(sent[1]?.text ?? '')).toBe(sent[1]?.text ?? '')
    expect(
      (sent[1]?.text.match(/"cache_control"/g) ?? []).length,
    ).toBeLessThanOrEqual(4)
    const stored = keep.trackedRequest(primarySession)
    expect(stored).toBeDefined()
    expect(tracking).toHaveBeenCalledTimes(2)
    expect(stored?.cacheExpiresAt).toBeGreaterThan(Date.now() + 55 * 60_000)
    const warm = await buildCacheKeepPrewarmBody(stored?.bodyText ?? '{}')
    expect(warm.ok).toBe(true)
    const prewarm = JSON.parse(warm.ok ? warm.bodyText : '{}')
    expect(prewarm.thread).toBeUndefined()
    expect(prewarm.messages).toHaveLength(3)
    expect(prewarm.system?.[0]?.text).not.toContain('cc_prompt_id=')
    const replay = history.messages.find(
      (message) => message.role === 'assistant',
    )
    if (!replay) throw new Error('Missing assistant fixture')
    forgetPiMessageThread(primarySession)
    await (await send(threadContext)).text()
    const withResponseId: Context = {
      ...history,
      messages: history.messages.map((message) =>
        message.role === 'assistant'
          ? { ...message, responseId: 'msg_pi_thread' }
          : message,
      ),
    }
    await (await send(withResponseId)).text()
    expect(sent.at(-1)?.text).toBe(sent[1]?.text)
    expect(JSON.parse(sent.at(-1)?.text ?? '{}').thread.type).toBe('continue')
    const tailSession = `pi-full-tail-${credentialSource}-${transport}`
    await (await send(history, tailSession)).text()
    const longer: Context = {
      ...history,
      messages: [
        ...history.messages,
        replay,
        { role: 'user', content: 'More', timestamp: 4 },
      ],
    }
    await (await send(longer, tailSession)).text()
    expect(JSON.parse(sent.at(-1)?.text ?? '{}').thread.type).toBe('continue')
    const tailReplay: Context = {
      ...longer,
      messages: [
        ...longer.messages,
        replay,
        { role: 'user', content: 'Third', timestamp: 5 },
        replay,
        { role: 'user', content: 'Fourth', timestamp: 6 },
      ],
    }
    await (await send(tailReplay, tailSession)).text()
    const fullTailText = sent.at(-1)?.text ?? '{}'
    const fullTail = JSON.parse(fullTailText)
    expect(fullTail.thread.type).toBe('create')
    expect(fullTail.messages[2].content.at(-1).cache_control).toEqual(
      oneHourControl,
    )
    expect(fullTail.system.every((block: any) => !block.cache_control)).toBe(
      true,
    )
    expect(fullTailText.match(/"cache_control"/g)).toHaveLength(4)
    expect(fullTailText).toBe(await signRequestBody(fullTailText))
    await (
      await send(
        {
          ...tailReplay,
          messages: [
            ...tailReplay.messages,
            replay,
            { role: 'user', content: 'After full replay', timestamp: 7 },
          ],
        },
        tailSession,
      )
    ).text()
    const afterTailText = sent.at(-1)?.text ?? '{}'
    const afterTail = JSON.parse(afterTailText)
    expect(afterTail.thread.type).toBe('continue')
    expect(JSON.stringify(afterTail.system.slice(1))).toBe(
      JSON.stringify(fullTail.system.slice(1)),
    )
    expect(JSON.stringify(afterTail.tools)).toBe(JSON.stringify(fullTail.tools))
    expect(afterTailText).toBe(await signRequestBody(afterTailText))
    for (const code of [
      'thread_not_found',
      'thread_fingerprint_mismatch',
      'thread_already_continued',
      'thread_continue_in_flight',
      'thread_unsupported_request',
      'unrelated',
    ]) {
      const sessionId = `pi-thread-error-${code}-${credentialSource}-${transport}`
      await (await send(threadContext, sessionId)).text()
      const current: Context = {
        ...threadContext,
        messages: [
          ...threadContext.messages,
          replay,
          { role: 'user', content: `Following ${code}`, timestamp: 3 },
        ],
      }
      const before = sent.length
      rejection = code
      await (await send(current, sessionId)).text()
      expect(JSON.parse(sent[before]?.text ?? '{}').thread.type).toBe(
        'continue',
      )
      expect(sent.length - before).toBe(code === 'unrelated' ? 1 : 2)
      if (code !== 'unrelated') {
        const retried = JSON.parse(sent[before + 1]?.text ?? '{}')
        expect(retried.thread).toEqual({ type: 'create' })
        expect(retried.messages).toHaveLength(current.messages.length)
        expect(sent[before + 1]?.headers.get('x-client-request-id')).toBe(
          sent[before]?.headers.get('x-client-request-id'),
        )
      }
      await (await send(current, sessionId)).text()
      expect(JSON.parse(sent.at(-1)?.text ?? '{}').thread).toEqual({
        type: 'create',
      })
    }
    for (const change of ['credential', 'account'] as const) {
      const session = `pi-thread-${change}-${credentialSource}-${transport}`
      await (await send(threadContext, session)).text()
      version++
      if (local) {
        if (change === 'account')
          localAccount = fixtureAccountIdentity('replacement')
        await local.loginOAuth({
          routeId: 'main',
          replace: true,
          credential: {
            access: `sk-ant-oat01-thread-access-${version}`,
            refresh: `thread-refresh-${version}`,
            expires: Date.now() + 3_600_000,
          },
        })
      } else {
        f.rows[0] = {
          ...f.rows[0]!,
          id: 'oauth:anthropic:replacement',
          ...(change === 'account'
            ? { accountId: fixtureAccountIdentity('replacement') }
            : {}),
          recordVersion: version,
        }
        await runtime.vault.refresh()
        const account = (await runtime.read()).accounts.find(
          (account) =>
            account.source === 'vault' &&
            account.credentialId === f.rows[0]?.id,
        )
        if (!account) throw new Error('Replacement vault credential is missing')
        oauthAccountId = account.id
      }
      await (await send(history, session)).text()
      expect(JSON.parse(sent.at(-1)?.text ?? '{}').thread).toEqual({
        type: 'create',
      })
    }
  })
}

test('Pi persists an ordinary no-policy HTTP relay target without request-id provenance', async () => {
  const f = await fixture('main-first', true)
  const previousDataHome = process.env.XDG_DATA_HOME
  const dataHome = join(dirname(f.path), 'cache-data')
  process.env.XDG_DATA_HOME = dataHome
  deferCleanup(async () => {
    await stopPiCacheKeep()
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
  })
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }))
  const sessionId = 'pi-http-no-policy-persist'
  deferCleanup(() => sessionCacheActivity.forget(sessionId))
  await startPiCacheKeepSession(f.path, sessionId)
  const acceptedAt = Date.now()
  const fetchImpl = (async (input) => {
    expect(String(input)).toStartWith('https://relay.invalid')
    return success()
  }) as typeof fetch
  globalThis.fetch = fetchImpl
  const response = await __sendPiAnthropicRequestForTest(
    {
      model,
      context: { ...context, systemPrompt: 'persist accepted HTTP prefix' },
      storagePath: f.path,
      streamOptions: { sessionId },
    },
    {
      native: f.native,
      fetch: fetchImpl,
    },
  )
  expect(response.headers.get('request-id')).toBeNull()
  await response.text()
  // Shutdown joins detached admission and drains the real singleton's store.
  await stopPiCacheKeep()
  expect(await getPiTrackedCacheKeepSessions()).toEqual([])
  const { storageId } = await resolveNativePoolPaths(f.path)
  const sessionHash = createHash('sha256').update(sessionId).digest('hex')
  const saved = JSON.parse(
    gunzipSync(
      await readFile(
        join(
          cacheKeepStoreDirectory(storageId, dataHome, 'pi'),
          `${sessionHash}.json.gz`,
        ),
      ),
    ).toString(),
  )
  expect(saved.id).toBe(sessionId)
  expect(saved.bodyText).toContain('persist accepted HTTP prefix')
  expect(saved.ttlMs).toBe(3_600_000)
  expect(saved.cacheExpiresAt).toBeGreaterThanOrEqual(acceptedAt + 3_600_000)
  expect(saved.cacheExpiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
  expect(saved.policyState.planned).toBe(false)
  expect(saved.policyState.warmsSinceLastRealRequest).toBe(0)
})

test('Pi WebSocket relay tracks exactly once only after the real upstream 200', async () => {
  const f = await fixture()
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }))
  const keep = new CacheKeepManager({
    loadStorage: async () => (await runtime.read()).policyStorage,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as typeof clearInterval,
  })
  deferCleanup(() => keep.stop())
  const tracking = spyOn(keep, 'track')
  deferCleanup(() => tracking.mockRestore())
  const accepted = lifetimes.gate()
  const upstream = lifetimes.gate()
  const sse = await success().text()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request, server) =>
      server.upgrade(request)
        ? undefined
        : new Response('unexpected HTTP', { status: 500 }),
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ type: 'ready', protocol: 2, state: null }))
      },
      message: async (socket, data) => {
        const payload = JSON.parse(String(data))
        socket.send(
          JSON.stringify({
            type: 'accepted',
            protocol: 2,
            id: payload.id,
            hash: payload.next_hash,
            revision: payload.revision,
          }),
        )
        accepted.open()
        await upstream.wait
        const start = JSON.stringify({
          type: 'response_start',
          id: payload.id,
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
        socket.send(start)
        socket.send(start)
        socket.send(
          JSON.stringify({
            type: 'chunk',
            id: payload.id,
            base64: Buffer.from(sse).toString('base64'),
          }),
        )
        socket.send(JSON.stringify({ type: 'done', id: payload.id }))
      },
    },
  })
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), 4_000)
  deferCleanup(() => {
    clearTimeout(deadline)
    abort.abort()
    server.stop(true)
  })
  await runtime.updateRelay({
    enabled: true,
    url: server.url.href,
    token: 'synthetic-ws-cache-token',
    transport: 'websocket',
    fallbackToDirect: false,
  })
  const sessionId = 'pi-ws-real-acceptance'
  deferCleanup(() => sessionCacheActivity.forget(sessionId))
  let returned = false
  const sending = __sendPiAnthropicRequestForTest(
    {
      model,
      context,
      storagePath: f.path,
      streamOptions: { sessionId, signal: abort.signal },
    },
    { native: f.native, cacheKeep: keep },
  )
  const finished = sending.then(async (response) => {
    returned = true
    expect(response.headers.get('x-cortexkit-relay-optimistic')).toBeNull()
    return response.text()
  })
  lifetimes.trackDetached(finished)
  await accepted.wait
  try {
    // Relay acceptance is not upstream acceptance; Pi waits for response_start.
    expect(returned).toBe(false)
    expect(keep.trackedCount()).toBe(0)
    expect(tracking).toHaveBeenCalledTimes(0)
    upstream.open()
    expect(await finished).toContain('message_stop')
    expect(tracking).toHaveBeenCalledTimes(1)
    expect(keep.trackedCount()).toBe(1)
    expect(keep.trackedRequest(sessionId)?.bodyText).toContain('Hello')
  } finally {
    upstream.open()
    await finished
  }
})

test('Pi keep-warm billing reports the shortest lifetime in a mixed sent body', async () => {
  const f = await fixture()
  const billing = captureBilling()
  let sentBody: string | undefined
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sentBody = String(init?.body)
      return Response.json({ usage: { input_tokens: 1 } })
    },
    { preconnect: originalFetch.preconnect },
  )
  const prewarm = await __prewarmPiCacheKeepForTest({
    sessionId: 'pi-prewarm-mixed-lifetimes',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({ 'content-type': 'application/json' }),
    bodyText: JSON.stringify({
      model: 'claude-fable-5-1',
      system: [
        {
          type: 'text',
          text: 'Stable',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    }),
    oauthAccountId: 'main',
    oauthAccountIdentity: fixtureAccountIdentity('main'),
    accountStoragePath: f.path,
  })
  expect(prewarm.ok).toBe(true)
  expect(sentBody).toBeDefined()
  const sent = JSON.parse(sentBody!)
  expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  expect(sent.messages[0].content[0].cache_control).toEqual({
    type: 'ephemeral',
  })
  await Bun.sleep(10)
  expect(billing.sessions).toEqual(['pi-prewarm-mixed-lifetimes'])
  expect(billing.reports).toEqual([
    expect.objectContaining({
      request_kind: 'keep_warm',
      outcome: 'completed',
      cache: { ttl_ms: 300_000, warming: { on: true } },
    }),
  ])
})

test('Pi model-request billing carries the keep-warm state each accepted step leaves', async () => {
  const f = await fixture()
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: true, always: true },
  }))
  const keep = new CacheKeepManager({
    loadStorage: async () => (await runtime.read()).policyStorage,
    setIntervalImpl: (() => ({ unref() {} })) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {}) as typeof clearInterval,
    setTimeoutImpl: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => {}) as typeof clearTimeout,
  })
  deferCleanup(() => keep.stop())
  const key = Symbol.for('cortexkit.routing')
  const globals = globalThis as Record<symbol, unknown>
  const previous = globals[key]
  const policies = new Map<string, unknown>()
  const reports: Record<string, unknown>[] = []
  globals[key] = (sessionId: string) => ({
    cache: () => policies.get(sessionId) ?? null,
    report: (payload: Record<string, unknown>) => {
      if (payload.kind === 'billing') reports.push(payload)
    },
  })
  deferCleanup(() => {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  })
  let status = 200
  const fetchImpl = (async () =>
    status === 200
      ? Response.json({ id: 'msg_pi', usage: { input_tokens: 6 } })
      : Response.json({ type: 'error' }, { status })) as unknown as typeof fetch
  const step = async (sessionId: string) => {
    deferCleanup(() => sessionCacheActivity.forget(sessionId))
    await (
      await __sendPiAnthropicRequestForTest(
        {
          model,
          context,
          storagePath: f.path,
          streamOptions: { sessionId },
        },
        { fetch: fetchImpl, cacheKeep: keep },
      )
    ).text()
    await Bun.sleep(10)
    return reports.splice(0)
  }
  const warming = (report: Record<string, unknown> | undefined) =>
    (report?.cache as Record<string, unknown> | undefined)?.warming

  const [on] = await step('pi-warming-on')
  expect(on).toMatchObject({ outcome: 'completed' })
  expect(warming(on)).toEqual({ on: true })

  // A failed attempt still carries no cache facts, warming included.
  status = 500
  const [failed] = await step('pi-warming-on')
  status = 200
  expect(failed).toMatchObject({ outcome: 'failed', status: 500 })
  expect(failed?.cache).toBeUndefined()

  const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16)
  const away = Date.now() + 6 * 3_600_000
  policies.set('pi-warming-on', {
    keep_warm: 'hours',
    hours: { from: hhmm(away), to: hhmm(away + 10 * 60_000), tz: 'UTC' },
  })
  const [stopped] = await step('pi-warming-on')
  expect(stopped).toMatchObject({ outcome: 'completed' })
  expect(warming(stopped)).toEqual({ on: false, stop_reason: 'outside-hours' })

  policies.set('pi-warming-plan-off', { keep_warm: 'off' })
  const [planOff] = await step('pi-warming-plan-off')
  expect(planOff).toMatchObject({ outcome: 'completed' })
  expect(warming(planOff)).toEqual({ on: false })

  await runtime.updateSettings((settings) => ({
    ...settings,
    cacheKeep: { enabled: false },
  }))
  const [localOff] = await step('pi-warming-local-off')
  expect(localOff).toMatchObject({ outcome: 'completed' })
  expect(warming(localOff)).toEqual({ on: false })
})

const PI_GATEWAY_SECRET = 'pi-gateway-header-secret'
const PI_GATEWAY = 'https://gateway.example.test'
async function useGateway(
  f: Awaited<ReturnType<typeof fixture>>,
  pathPrefix: string | undefined,
) {
  const runtime = await f.native.service()
  const gateway =
    pathPrefix === undefined
      ? undefined
      : {
          origin: PI_GATEWAY,
          pathPrefix,
          headers: [['x-gateway-key', PI_GATEWAY_SECRET]] as [string, string][],
        }
  const spy = spyOn(runtime, 'getClaudeGateway').mockReturnValue(gateway)
  deferCleanup(() => spy.mockRestore())
}
function recordSends(gatewayAnswer?: () => Response) {
  const sent: Array<{
    url: string
    headers: Headers
    body: string
    gzip: boolean
  }> = []
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init)
      const gzip = request.headers.get('content-encoding') === 'gzip'
      const bytes = Buffer.from(await request.arrayBuffer())
      const body = (gzip ? gunzipSync(bytes) : bytes).toString()
      sent.push({ url: request.url, headers: request.headers, body, gzip })
      if (gatewayAnswer && request.url.startsWith(PI_GATEWAY))
        return gatewayAnswer()
      if (request.url.includes('/api/oauth/usage'))
        return Response.json({
          five_hour: {
            utilization: 0,
            resets_at: new Date(Date.now() - 120_000).toISOString(),
          },
          seven_day: {
            utilization: 0,
            resets_at: new Date(Date.now() + 604_800_000).toISOString(),
          },
        })
      // Prime asks for one token and reads a JSON answer.
      if (body && JSON.parse(body).max_tokens === 1)
        return Response.json(
          { usage: { input_tokens: 11, output_tokens: 1 } },
          { headers: { 'request-id': 'req_pi_gateway_prime' } },
        )
      return success()
    },
    { preconnect: originalFetch.preconnect },
  )
  return sent
}
async function sendPrimary(
  f: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
) {
  beginPiPrimaryTurn(f.path, sessionId)
  deferCleanup(() => {
    endPiPrimaryTurn(f.path, sessionId)
    forgetPiMessageThread(sessionId)
  })
  const response = await __sendPiAnthropicRequestForTest(
    {
      model,
      context: {
        ...context,
        messages: [{ role: 'user', content: 'x'.repeat(9000), timestamp: 1 }],
      },
      storagePath: f.path,
      requestOrigin: 'agent-loop',
      streamOptions: {
        sessionId,
        onPayload: (payload) => payload,
        onResponse: () => {},
        onProviderStreamEvent: () => {},
      },
    },
    { native: f.native, fetch: globalThis.fetch },
  )
  await response.text()
}

test('Pi sends model and keep-warm requests to the gateway as full uncompressed requests', async () => {
  const f = await fixture()
  const sent = recordSends()
  // Without a gateway the same primary request is threaded and gzipped.
  await useGateway(f, undefined)
  await sendPrimary(f, 'pi-gateway-control')
  expect(sent).toHaveLength(1)
  expect(sent[0]?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
  expect(sent[0]?.gzip).toBe(true)
  expect(JSON.parse(sent[0]!.body).thread).toEqual({ type: 'create' })

  await useGateway(f, '/claude')
  await sendPrimary(f, 'pi-gateway-primary')
  expect(sent).toHaveLength(2)
  const live = sent[1]!
  expect(live.url).toBe(`${PI_GATEWAY}/claude/v1/messages?beta=true`)
  expect(live.headers.get('x-gateway-key')).toBe(PI_GATEWAY_SECRET)
  expect(live.headers.get('authorization')).toMatch(
    /^Bearer vault-test-access-/,
  )
  expect(live.gzip).toBe(false)
  expect(JSON.parse(live.body).thread).toBeUndefined()
  expect(await signRequestBody(live.body)).toBe(live.body)

  const prewarm = await __prewarmPiCacheKeepForTest({
    sessionId: 'pi-gateway-warm',
    // CacheKeep keeps the Anthropic URL and applies the current gateway.
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    headers: new Headers(),
    bodyText: live.body,
    oauthAccountId: 'main',
    oauthAccountIdentity: fixtureAccountIdentity('main'),
    accountStoragePath: f.path,
  })
  expect(prewarm).toMatchObject({ ok: true })
  expect(sent).toHaveLength(3)
  const warm = sent[2]!
  expect(warm.url).toBe(`${PI_GATEWAY}/claude/v1/messages?beta=true`)
  expect(warm.headers.get('x-gateway-key')).toBe(PI_GATEWAY_SECRET)
  expect(warm.gzip).toBe(false)
  expect(JSON.parse(warm.body).thread).toBeUndefined()
  expect(JSON.parse(warm.body).max_tokens).toBe(0)
})

test('Pi Prime goes to the gateway; quota reads stay on Anthropic', async () => {
  const f = await fixture()
  await useGateway(f, '/claude')
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    prime: { enabled: true },
  }))
  f.native.prime!.manager.options.markerDir = join(dir!, 'prime')
  const sent = recordSends()
  await f.native.prime!.manager.tick()
  const models = sent.filter((entry) => entry.url.includes('/v1/messages'))
  expect(models.map((entry) => entry.url)).toEqual([
    `${PI_GATEWAY}/claude/v1/messages?beta=true`,
  ])
  expect(models[0]?.headers.get('x-gateway-key')).toBe(PI_GATEWAY_SECRET)
  for (const entry of sent.filter(
    (item) => !item.url.includes('/v1/messages'),
  )) {
    expect(new URL(entry.url).origin).toBe('https://api.anthropic.com')
    expect(entry.headers.has('x-gateway-key')).toBe(false)
  }
})

test('Pi sends to the gateway instead of a configured relay, with one warning', async () => {
  const f = await fixture('main-first', true)
  await useGateway(f, '/relayed')
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => __setLogTestSink(null))
  const sent = recordSends()
  await sendPrimary(f, 'pi-gateway-relay-1')
  await sendPrimary(f, 'pi-gateway-relay-2')
  expect(sent.map((entry) => entry.url)).toEqual([
    `${PI_GATEWAY}/relayed/v1/messages?beta=true`,
    `${PI_GATEWAY}/relayed/v1/messages?beta=true`,
  ])
  expect(
    records.filter(
      (record) =>
        record.level === 'warn' && record.message.includes('relay is not used'),
    ),
  ).toHaveLength(1)
})

test('Pi still refuses a foreign model baseUrl with a gateway set', async () => {
  const f = await fixture()
  await useGateway(f, '/claude')
  const sent = recordSends()
  const result = await streamCortexKitAnthropic(
    { ...model, baseUrl: `${PI_GATEWAY}/claude` },
    context,
  ).result()
  expect(result.stopReason).toBe('error')
  expect(result.errorMessage).toContain('official Anthropic HTTPS origin')
  expect(sent).toEqual([])
})

test('Pi redacts a gateway error that echoes a gateway header value, in the response, logs and dump', async () => {
  const f = await fixture()
  await useGateway(f, '/redact')
  const runtime = await f.native.service()
  await runtime.updateSettings((settings) => ({
    ...settings,
    dump: { enabled: true },
  }))
  const dumps = await mkdtemp(join(dir!, 'dumps-'))
  const previousDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumps
  deferCleanup(() => {
    if (previousDir === undefined)
      delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
    else process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = previousDir
  })
  const records: LogTestRecord[] = []
  __setLogTestSink((record) => records.push(record))
  deferCleanup(() => __setLogTestSink(null))
  const sent = recordSends(() =>
    Response.json(
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `gateway rejected key ${PI_GATEWAY_SECRET}`,
        },
      },
      { status: 400 },
    ),
  )
  const response = await __sendPiAnthropicRequestForTest(
    {
      model,
      context,
      storagePath: f.path,
      streamOptions: { sessionId: 'pi-gateway-redact' },
    },
    { native: f.native, fetch: globalThis.fetch },
  )
  const text = await response.text()
  expect(sent.some((entry) => entry.url.startsWith(PI_GATEWAY))).toBe(true)
  expect(text).not.toContain(PI_GATEWAY_SECRET)
  expect(text).toContain('[REDACTED]')
  await Bun.sleep(20)
  expect(JSON.stringify(records)).not.toContain(PI_GATEWAY_SECRET)
  const files = await readdir(dumps)
  expect(files.length).toBeGreaterThan(0)
  for (const name of files)
    expect(await readFile(join(dumps, name), 'utf8')).not.toContain(
      PI_GATEWAY_SECRET,
    )
})

test('Pi keep-warm uses the gateway of the target runtime, not the default-path runtime', async () => {
  const f = await fixture()
  await useGateway(f, '/target')
  const sent = recordSends()
  await sendPrimary(f, 'pi-gateway-target')
  const live = sent.at(-1)!
  expect(live.url).toBe(`${PI_GATEWAY}/target/v1/messages?beta=true`)
  // The default storage path now names another install with no runtime.
  process.env.PI_ANTHROPIC_AUTH_FILE = join(dir!, 'other-install.json')
  const prewarm = await __prewarmPiCacheKeepForTest({
    sessionId: 'pi-gateway-target-warm',
    url: 'https://api.anthropic.com/v1/messages?beta=true',
    headers: new Headers(),
    bodyText: live.body,
    oauthAccountId: 'main',
    oauthAccountIdentity: fixtureAccountIdentity('main'),
    accountStoragePath: f.path,
  })
  expect(prewarm).toMatchObject({ ok: true })
  expect(sent.at(-1)?.url).toBe(`${PI_GATEWAY}/target/v1/messages?beta=true`)
  expect(sent.at(-1)?.headers.get('x-gateway-key')).toBe(PI_GATEWAY_SECRET)
})
