import { gunzipSync } from 'node:zlib'
import {
  __setLogTestSink,
  CLAUDE_SONNET_5_5_MODEL_ID,
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
__setLogTestSink((record) => {
  if (JSON.stringify(record).includes('cachekeep'))
    console.error(JSON.stringify(record))
})
const storagePath = process.env.PI_ANTHROPIC_AUTH_FILE
if (!storagePath) throw new Error('Missing isolated Pi storage path')
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
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes('/api/claude_cli/bootstrap'))
      return Response.json({
        oauth_account: { account_uuid: fixtureAccountIdentity('main') },
      })
    if (!url.includes('/v1/messages'))
      throw new Error(`Unexpected fixture request: ${new URL(url).pathname}`)
    const body = JSON.parse(
      init?.body instanceof Uint8Array
        ? gunzipSync(init.body).toString()
        : String(init?.body),
    )
    messages.push(body)
    if (body.max_tokens === 0)
      return Response.json({ usage: { cache_read_input_tokens: 100 } })
    return new Response(
      [
        {
          type: 'message_start',
          message: {
            id: 'msg_restart',
            model: CLAUDE_SONNET_5_5_MODEL_ID,
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
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
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
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

if (phase === 'seed') {
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
    cacheKeep: { enabled: true, always: true },
  }))
} else {
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
  .find((row) => row.id === CLAUDE_SONNET_5_5_MODEL_ID)
if (!provider || !model)
  throw new Error('Pi did not register the Anthropic model')
const ctx = {
  hasUI: false,
  model,
  thinkingLevel: 'high',
  sessionManager: {
    getSessionId: () => 'pi-restart-session-S',
    getBranch: () => [],
  },
}
await events.get('session_start')?.(
  { type: 'session_start', reason: 'startup' },
  ctx,
)
if (phase === 'seed') {
  await events.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx)
  const stream = provider?.streamSimple?.(
    model,
    {
      systemPrompt: 'Keep the same prompt prefix across the Pi restart.',
      messages: [{ role: 'user', content: 'hello', timestamp: now }],
    },
    { sessionId: 'pi-restart-session-S' },
  )
  if (!stream) throw new Error('Pi did not register its stream')
  const result = await stream.result()
  if (result.stopReason === 'error') throw new Error(result.errorMessage)
  await events.get('agent_settled')?.({ type: 'agent_settled' }, ctx)
} else {
  now += 60_000
  for (const callback of [...intervals.values()]) await callback()
}
await events.get('session_shutdown')?.(
  { type: 'session_shutdown', reason: 'quit' },
  ctx,
)
console.log(
  `PI_RESTART_RESULT ${JSON.stringify({ live: messages.filter((body) => body.max_tokens !== 0).length, warm: messages.filter((body) => body.max_tokens === 0).length })}`,
)
