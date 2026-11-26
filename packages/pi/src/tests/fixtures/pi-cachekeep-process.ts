import { deepStrictEqual } from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  CacheKeepManager,
  CLAUDE_SONNET_5_5_MODEL_ID,
  cacheKeepStoreDirectory,
  ensureHolderDirectory,
  hasValidRequestBodySignature,
  LEGACY_STATE_LAYOUT,
  PER_TURN_CONTROL_BETA,
  resolveNativePoolPaths,
  withNativeLock,
} from '@cortexkit/anthropic-auth-core'
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getPiNativeRuntime } from '../../native.ts'
import {
  fixtureAccountIdentity,
  saveNativePiFixture,
} from '../native-fixture.ts'

// Each invocation is a real process boundary: no module manager, timer or
// credential runtime can be inherited from the preceding Pi instance.
const phase = process.argv[2]
const roundSource = 'claude-fable-5-2'
const roundTarget = 'claude-opus-4-8'
const roundIdle = phase === 'round-idle'
const roundAccount = phase === 'round-account'
const roundConcurrent = phase === 'round-concurrent'
const roundSeed =
  phase === 'round-seed' || roundIdle || roundAccount || roundConcurrent
const roundFixture = roundSeed || phase === 'round-resume'
const thinkingSeed = phase === 'thinking-seed'
const thinkingFixture = thinkingSeed || phase === 'thinking-resume'
const shouldSend =
  roundSeed || ['seed', 'locked', 'takeover'].includes(phase ?? '')
const sessionId = 'pi-restart-session-S'
const requestedTemplateReady = Promise.withResolvers<void>()
const warmStarted = Promise.withResolvers<AbortSignal | undefined>()
const warmRelease = Promise.withResolvers<void>()
let roundManager: CacheKeepManager | undefined
if (roundSeed) {
  const track = CacheKeepManager.prototype.track
  CacheKeepManager.prototype.track = function (input) {
    const result = track.call(this, input)
    if (
      result.tracked &&
      input.sessionId === sessionId &&
      JSON.parse(input.bodyText).model === roundSource
    ) {
      roundManager = this
      requestedTemplateReady.resolve()
    }
    return result
  }
}
__setLogTestSink((record) => {
  if (JSON.stringify(record).includes('cachekeep'))
    console.error(JSON.stringify(record))
})
const storagePath = process.env.PI_ANTHROPIC_AUTH_FILE
if (!storagePath) throw new Error('Missing isolated Pi storage path')
const transcript = join(dirname(storagePath), 'thinking-transcript.json')
async function roundRestartRecord(storage: string) {
  const paths = await resolveNativePoolPaths(
    storage,
    undefined,
    LEGACY_STATE_LAYOUT,
  )
  const directory = cacheKeepStoreDirectory(paths.storageId, undefined, 'pi')
  const name = `${createHash('sha256').update(sessionId).digest('hex')}.json.gz`
  return JSON.parse(
    gunzipSync(await readFile(join(directory, name))).toString(),
  )
}
let now = Number(process.env.PI_RESTART_CLOCK)
Date.now = () => now
const intervals = new Map<ReturnType<typeof setInterval>, () => unknown>()
const schedule = globalThis.setInterval
const cancel = globalThis.clearInterval
globalThis.setInterval = ((callback: () => unknown, ms?: number) => {
  const timer = schedule(callback, ms)
  if (ms === 60_000) intervals.set(timer, callback)
  return timer
}) as typeof setInterval
globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
  intervals.delete(timer)
  cancel(timer)
}) as typeof clearInterval

const messages: Array<Record<string, unknown>> = []
function partialReply(lane: 'source' | 'target') {
  return [
    {
      type: 'thinking',
      thinking: `${lane} thinking`,
      signature: `${lane}-signature`,
    },
    { type: 'text', text: `${lane} text` },
  ] as const
}

function partialReplyFrames(lane: 'source' | 'target') {
  const [thinking, text] = partialReply(lane)
  return [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: thinking.thinking },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: thinking.signature },
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
      delta: { type: 'text_delta', text: text.text },
    },
    { type: 'content_block_stop', index: 1 },
  ]
}

let refuseRoundSource = false
let lastRound: Context | undefined
const probeFailures: string[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/api/claude_cli/bootstrap'))
      return Response.json({
        oauth_account: {
          account_uuid: fixtureAccountIdentity(
            new Headers(init?.headers).get('authorization') ===
              'Bearer sk-ant-oat01-replacement-access'
              ? 'replacement'
              : 'main',
          ),
        },
      })
    if (!url.includes('/v1/messages'))
      throw new Error(`Unexpected fixture request: ${new URL(url).pathname}`)
    const text =
      init?.body instanceof Uint8Array
        ? gunzipSync(init.body).toString()
        : String(init?.body)
    const body = JSON.parse(text)
    messages.push(body)
    if (roundFixture && !(await hasValidRequestBodySignature(text)))
      probeFailures.push(`Pi sent unsigned ${body.model} shape`)
    if (body.max_tokens === 0) {
      if (roundFixture) {
        const beta = new Headers(init?.headers)
          .get('anthropic-beta')
          ?.split(',')
        if (!beta?.includes(PER_TURN_CONTROL_BETA))
          probeFailures.push(
            `Warm ${body.model} lost Fable source feature headers: ${beta}`,
          )
        if (body.thread || body.fallback_credit_token || body.fallbacks)
          probeFailures.push(
            'Round warm replayed a thread or credit-bearing body',
          )
        if (body.model === roundSource && text.includes('blocked next prompt'))
          probeFailures.push('Source warm replayed the refused prefix')
        if (!roundSeed && body.model !== roundSource)
          probeFailures.push(
            `Restored Pi round warm used ${body.model}, not ${roundSource}`,
          )
        if (roundSeed && body.model === roundSource) {
          const saved = await roundRestartRecord(storagePath).catch(
            () => undefined,
          )
          if (saved?.policyState.warmsSinceLastRealRequest !== 1)
            probeFailures.push(
              'Pi dispatched the requested-model warm before saving its reservation',
            )
        }
      }
      if (roundConcurrent) {
        warmStarted.resolve(init?.signal ?? undefined)
        await warmRelease.promise
      }
      return Response.json({ usage: { cache_read_input_tokens: 100 } })
    }
    const refused = refuseRoundSource && body.model === roundSource
    return new Response(
      [
        {
          type: 'message_start',
          message: {
            id: `msg_restart_${messages.length}`,
            model: body.model,
            content: [],
            usage: {
              input_tokens: 17,
              output_tokens: 0,
              cache_read_input_tokens: 100,
            },
          },
        },
        ...(thinkingSeed
          ? partialReplyFrames(body.model === roundSource ? 'source' : 'target')
          : !refused
            ? [
                {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '' },
                },
                {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'answer' },
                },
                { type: 'content_block_stop', index: 0 },
              ]
            : []),
        {
          type: 'message_delta',
          delta:
            refused || thinkingSeed
              ? {
                  stop_reason: 'refusal',
                  stop_details: {
                    type: 'refusal',
                    category: 'cyber',
                    ...((!thinkingSeed || body.model === roundSource) && {
                      fallback_credit_token: 'pi-restart-round-probe',
                      ...(thinkingSeed && { fallback_has_prefill_claim: true }),
                    }),
                  },
                }
              : { stop_reason: 'end_turn' },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
  { preconnect: originalFetch.preconnect },
) as typeof fetch

if (roundSeed || thinkingSeed || phase === 'seed' || phase === 'locked') {
  await saveNativePiFixture({ version: 1, accounts: [] }, storagePath)
  const runtime = await getPiNativeRuntime(storagePath).service()
  // The synthetic login outlives the clock advance; this test is about cache
  // restoration, not the unrelated proactive OAuth refresh interval.
  await runtime.loginOAuth({
    routeId: 'main',
    accountIdentity: fixtureAccountIdentity('main'),
    replace: true,
    credential: {
      access: 'sk-ant-oat01-restart-access',
      refresh: 'synthetic-restart-refresh',
      expires: now + 86_400_000,
    },
  })
  await runtime.updateSettings((settings) => ({
    ...settings,
    quota: { enabled: false },
    claudeCache: { enabled: true, mode: 'hybrid' },
    cacheKeep: { enabled: !thinkingSeed, always: !thinkingSeed },
  }))
} else if (phase === 'round-resume') {
  const saved = await roundRestartRecord(storagePath)
  deepStrictEqual(JSON.parse(saved.bodyText).model, roundSource)
  deepStrictEqual(saved.refusalSourceModel, undefined)
  deepStrictEqual(saved.policyState.warmsSinceLastRealRequest, 1)
  now = saved.nextPrewarmAt
} else if (phase === 'resume') {
  now += 55 * 60_000
}

type RegisteredProvider = {
  id: string
  getModels(): Model<Api>[]
  streamSimple(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
  ): { result(): Promise<AssistantMessage> }
}
const events = new Map<string, (event: unknown, context: unknown) => unknown>()
const providers = new Map<string, RegisteredProvider>()
const pi = {
  registerCommand() {},
  on: (name: string, handler: (event: unknown, context: unknown) => unknown) =>
    events.set(name, handler),
  registerProvider: (provider: RegisteredProvider) =>
    providers.set(provider.id, provider),
} as unknown as ExtensionAPI
// Import after installing the clock and scheduler: the extension constructs its
// process-level manager at module load, just as a fresh Pi runtime does.
const { default: cortexKitPiAnthropicAuth } = await import('../../index.ts')
await cortexKitPiAnthropicAuth(pi)
const provider = providers.get('anthropic')
const model = provider
  ?.getModels()
  .find(
    (row) =>
      row.id ===
      (roundFixture || thinkingFixture
        ? roundSource
        : CLAUDE_SONNET_5_5_MODEL_ID),
  )
if (!provider || !model)
  throw new Error('Pi did not register the Anthropic model')
const ctx = {
  hasUI: false,
  model,
  thinkingLevel: 'high',
  sessionManager: {
    getSessionId: () => sessionId,
    getBranch: () => [],
  },
}
let releaseLock = () => {}
let holding: Promise<void> | undefined
if (phase === 'locked') {
  const paths = await resolveNativePoolPaths(
    storagePath,
    undefined,
    LEGACY_STATE_LAYOUT,
  )
  const directory = cacheKeepStoreDirectory(paths.storageId)
  const piDirectory = cacheKeepStoreDirectory(paths.storageId, undefined, 'pi')
  if (directory === piDirectory)
    throw new Error('Pi must have its own namespace')
  await ensureHolderDirectory(piDirectory)
  const path = join(
    piDirectory,
    `${createHash('sha256').update(sessionId).digest('hex')}.claim.json`,
  )
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  let ready = () => {}
  const acquired = new Promise<void>((resolve) => {
    ready = resolve
  })
  holding = withNativeLock(
    path,
    { name: 'cachekeep-session', ttlMs: 10_000, timeoutMs: 2000, renew: true },
    async () => {
      ready()
      await released
    },
  )
  await acquired
}

async function emit(name: string, event: unknown) {
  const result = Promise.resolve(events.get(name)?.(event, ctx))
  if (phase === 'locked') {
    let completed = false
    void result.then(() => {
      completed = true
    })
    // No wall-clock race: a detached lifecycle handler settles in microtasks
    // even while the real native lock is held by the fixture.
    await Promise.resolve()
    await Promise.resolve()
    if (!completed) throw new Error(`${name} waited on keep-warm bookkeeping`)
  }
  await result
}

async function replayThinking() {
  if (!provider || !model) throw new Error('Pi did not register its stream')
  const history: Context['messages'] = [
    { role: 'user', content: 'hello', timestamp: now },
  ]
  if (!thinkingSeed) {
    history.push(JSON.parse(await readFile(transcript, 'utf8')), {
      role: 'user',
      content: 'continue after restart',
      timestamp: now + 1,
    })
  }
  await emit('turn_start', { type: 'turn_start', turnIndex: 0 })
  const result = await provider
    .streamSimple(model, { messages: history }, { sessionId })
    .result()
  if (thinkingSeed) {
    deepStrictEqual(
      messages.map((body) => body.model),
      [roundSource, roundTarget],
    )
    deepStrictEqual(result.stopReason, 'error')
    deepStrictEqual(result.model, roundSource)
    deepStrictEqual(
      result.content,
      [...partialReply('source'), ...partialReply('target')].map((block) =>
        block.type === 'thinking'
          ? {
              type: 'thinking',
              thinking: block.thinking,
              thinkingSignature: block.signature,
            }
          : block,
      ),
    )
    await writeFile(transcript, JSON.stringify(result))
  } else {
    deepStrictEqual(result.stopReason, 'stop')
    const request = messages.at(-1)
    deepStrictEqual(request?.model, roundSource)
    if (!Array.isArray(request?.messages))
      throw new Error('Pi did not send a replay')
    deepStrictEqual(
      request.messages.find((message) => message.role === 'assistant'),
      {
        role: 'assistant',
        content: [...partialReply('source'), partialReply('target')[1]],
      },
    )
  }
  await emit('agent_settled', { type: 'agent_settled' })
}

try {
  await emit('session_start', { type: 'session_start', reason: 'startup' })
  if (thinkingFixture) await replayThinking()
  if (shouldSend) {
    await emit('turn_start', { type: 'turn_start', turnIndex: 0 })
    const context: Context = {
      systemPrompt: 'Keep the same prompt prefix across the Pi restart.',
      messages: [
        {
          role: 'user',
          content: phase === 'takeover' ? 'real turn elsewhere' : 'hello',
          timestamp: now,
        },
      ],
    }
    const stream = provider?.streamSimple?.(model, context, { sessionId })
    if (!stream) throw new Error('Pi did not register its stream')
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await (phase === 'locked'
      ? Promise.race([
          stream.result(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    'accepted response waited on keep-warm bookkeeping',
                  ),
                ),
              1000,
            )
          }),
        ]).finally(() => clearTimeout(timeout))
      : stream.result())
    if (result.stopReason === 'error') throw new Error(result.errorMessage)
    if (roundSeed) {
      await requestedTemplateReady.promise
      refuseRoundSource = true
      context.messages.push(result, {
        role: 'user',
        content: 'blocked next prompt',
        timestamp: now + 1,
      })
      const retry = await provider
        .streamSimple(model, context, { sessionId })
        .result()
      if (retry.stopReason !== 'stop') throw new Error(retry.errorMessage)
      refuseRoundSource = false
      context.messages.push(retry, {
        role: 'user',
        content: 'later round step',
        timestamp: now + 2,
      })
      const round = await provider
        .streamSimple(model, context, { sessionId })
        .result()
      if (round.stopReason !== 'stop' || messages.at(-1)?.model !== roundTarget)
        throw new Error('Pi did not serve the round step on the target')
      lastRound = context
      lastRound.messages.push(round)
    }
    await events.get('agent_settled')?.({ type: 'agent_settled' }, ctx)
  }
  if (roundSeed && roundManager) {
    const record = roundManager
      .trackedSessions()
      .find((row) => row.id === sessionId)
    if (!record)
      throw new Error('Pi lost the requested-model warm during the round')
    now = record.nextPrewarmAt + 1000
    const manager = roundManager
    const nextStep = async (prompt: string) => {
      if (!lastRound || !provider || !model)
        throw new Error('Missing Pi round history')
      await emit('turn_start', {
        type: 'turn_start',
        turnIndex: lastRound.messages.length,
      })
      lastRound.messages.push({ role: 'user', content: prompt, timestamp: now })
      const result = await provider
        .streamSimple(model, lastRound, { sessionId })
        .result()
      if (result.stopReason === 'error') throw new Error(result.errorMessage)
      lastRound.messages.push(result)
      await emit('agent_settled', { type: 'agent_settled' })
    }
    const warming = manager.tick()
    if (roundConcurrent) {
      try {
        const signal = await Promise.race([
          warmStarted.promise,
          warming.then(() => undefined),
        ])
        if (!signal)
          throw new Error('Pi did not start the requested-model warm')
        await nextStep('round while warming')
        deepStrictEqual(messages.at(-1)?.model, roundTarget)
        deepStrictEqual(
          signal.aborted,
          false,
          'Pi aborted the requested-model warm',
        )
      } finally {
        warmRelease.resolve()
        await warming
      }
    } else await warming
    if (roundIdle) {
      const before = manager.trackedRequest(sessionId)
      const state = manager.trackedPolicyState(sessionId)
      deepStrictEqual(state?.warmsSinceLastRealRequest, 1)
      now += 60_000
      await nextStep('shorter than the round step lifetime')
      deepStrictEqual(messages.at(-1)?.model, roundTarget)
      deepStrictEqual(manager.trackedRequest(sessionId), before)
      const renewed = manager.trackedPolicyState(sessionId)
      deepStrictEqual(renewed?.warmsSinceLastRealRequest, 0)
      deepStrictEqual(renewed?.warmCostSoFar, 0)
      deepStrictEqual(renewed?.lastRealRequestAt, state?.lastRealRequestAt)
      now += 54 * 60_000
      await manager.tick()
      now += 6 * 60_000 + 1
      await nextStep('longer than the round step lifetime')
      deepStrictEqual(messages.at(-1)?.model, roundSource)
      const returned = messages.at(-1)?.messages as
        | { content: { text?: string; cache_control?: unknown }[] }[]
        | undefined
      deepStrictEqual(
        returned?.[0]?.content.find((block) => block.text === 'hello')
          ?.cache_control,
        { type: 'ephemeral', ttl: '1h' },
      )
      refuseRoundSource = true
      await nextStep('refuse again after an idle end')
      const { piRefusalRoundStatus } = await import('../../stream.ts')
      if (!piRefusalRoundStatus(sessionId)?.includes('(cyber; 19 steps left)'))
        throw new Error('Pi did not start a longer round after an idle end')
    } else if (roundAccount) {
      const runtime = await getPiNativeRuntime(storagePath).service()
      await runtime.loginOAuth({
        routeId: 'main',
        replace: true,
        accountIdentity: fixtureAccountIdentity('replacement'),
        credential: {
          access: 'sk-ant-oat01-replacement-access',
          refresh: 'synthetic-replacement-refresh',
          expires: now + 86_400_000,
        },
      })
      now += 55 * 60_000
      await manager.tick()
      deepStrictEqual(manager.trackedRequest(sessionId), undefined)
    }
  }
  if ((!shouldSend && !thinkingFixture) || phase === 'takeover') {
    // Observe the public registry, not a private restore API. Production starts
    // restoration detached. An implementation without restart restoration
    // still reaches the warm-count assertion instead of hanging at startup.
    const { getPiTrackedCacheKeepSessions } = await import('../../stream.ts')
    let tracked = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (
        (await getPiTrackedCacheKeepSessions()).some(
          (row) => row.id === sessionId,
        )
      ) {
        tracked = true
        break
      }
      await Bun.sleep(10)
    }
    if (phase === 'idle-owner') {
      process.send?.({ tracked })
      await Bun.stdin.text()
    }
    if (phase !== 'resume' && phase !== 'round-resume') now += 55 * 60_000
    now += 60_000
    for (const callback of [...intervals.values()]) await callback()
  }
} finally {
  releaseLock()
  await holding
}
await events.get('session_shutdown')?.(
  { type: 'session_shutdown', reason: 'quit' },
  ctx,
)
if (roundSeed) {
  const paths = await resolveNativePoolPaths(
    storagePath,
    undefined,
    LEGACY_STATE_LAYOUT,
  )
  const files = await readdir(
    cacheKeepStoreDirectory(paths.storageId, undefined, 'pi'),
  )
  const expected = `${createHash('sha256').update(sessionId).digest('hex')}.json.gz`
  const saved = files.filter((file) => file.endsWith('.json.gz'))
  if (
    !roundIdle &&
    !roundAccount &&
    JSON.stringify(saved) !== JSON.stringify([expected])
  )
    throw new Error(
      `Pi did not save a single ordinary session record: ${saved}`,
    )
  deepStrictEqual(
    messages.filter((body) => body.max_tokens === 0).map((body) => body.model),
    roundIdle ? [roundSource, roundSource] : [roundSource],
    'Pi must warm only the requested model during the round',
  )
}
if (probeFailures.length) throw new Error(probeFailures.join('\n'))
console.log(
  `PI_RESTART_RESULT ${JSON.stringify({ live: messages.filter((body) => body.max_tokens !== 0).length, warm: messages.filter((body) => body.max_tokens === 0).length })}`,
)
