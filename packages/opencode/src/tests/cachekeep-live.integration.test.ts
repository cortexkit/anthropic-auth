import { describe, expect, mock } from 'bun:test'
import {
  CACHE_KEEP_EXTENDED_TTL_BETA,
  SERVER_SIDE_FALLBACK_BETA,
} from '@cortexkit/anthropic-auth-core'
import { getPluginTestHandles } from './plugin-test-handles'
import { installLoaderSetup } from './support/opencode1-loader-setup'
import {
  createFallbackStorage,
  getPlugin,
  syntheticMainHostAuth,
  useTempAccountFile,
  withNativeAdmission,
} from './support/opencode1-pool-fixture'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const ctx = createOpencode1TestContext()
installOpencode1TestHooks(ctx)
const test = createOpencode1Test(ctx)
const model = 'claude-opus-5-5'

async function fixture(cacheKeepEnabled = true) {
  let now = Date.now()
  const auth = { ...syntheticMainHostAuth(), expires: now + 8 * 60 * 60_000 }
  await useTempAccountFile(
    ctx,
    createFallbackStorage({
      accounts: [],
      quota: { enabled: false },
      claudeCache: { enabled: true, mode: 'hybrid' },
      cacheKeep: { enabled: cacheKeepEnabled, always: true },
    }),
    auth,
  )
  type Sent = { body: Record<string, unknown>; headers: Headers }
  const live: Sent[] = []
  const warms: Sent[] = []
  const message = {
    id: 'msg_ok',
    content: [{ type: 'text', text: 'Answer' }],
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 0,
    },
  }
  globalThis.fetch = mock(
    withNativeAdmission(
      ctx,
      (input: string | URL | Request, init?: RequestInit) => {
        if (!extractUrl(input).includes('/v1/messages'))
          return Response.json({})
        const body = JSON.parse(String(init?.body)) as Sent['body']
        const sent = { body, headers: new Headers(init?.headers) }
        if (body.max_tokens === 0) {
          warms.push(sent)
          return Response.json({})
        }
        live.push(sent)
        return new Response(
          `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\n` +
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    ),
  ) as unknown as typeof fetch

  const plugin = await getPlugin(ctx, undefined, undefined, { now: () => now })
  const loader = await plugin.auth.loader(
    async () => ({ type: 'oauth', ...auth }),
    { models: {} },
  )
  const manager = getPluginTestHandles(plugin).cacheKeepManager
  return {
    live,
    warms,
    async send(
      sessionId: string,
      messages: { role: string; content: string }[],
    ) {
      const response = await loader.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': sessionId },
        body: JSON.stringify({
          model,
          max_tokens: 128_000,
          stream: true,
          system: [{ type: 'text', text: 'stable system' }],
          messages,
        }),
      })
      expect(response.status).toBe(200)
      await response.text()
    },
    async tickAfter(minutes: number) {
      now += minutes * 60_000
      await manager.tick()
    },
  }
}

describe('OpenCode 1 live CacheKeep', () => {
  installLoaderSetup(ctx)

  test('continues a live message thread with only the new user message', async () => {
    const { live, send } = await fixture()
    const messages = [{ role: 'user', content: 'first threaded question' }]
    await send('ses_thread_live', messages)
    messages.push(
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'accepted continued question' },
    )
    await send('ses_thread_live', messages)
    expect(live).toHaveLength(2)
    expect(live[1]!.body.thread).toEqual({
      type: 'continue',
      previous_message_id: 'msg_ok',
    })
    expect(live[1]!.body.messages).toHaveLength(1)
  })

  test('warms the live model and exact prefix on the same account near expiry', async () => {
    const { live, warms, send, tickAfter } = await fixture()
    await send('ses_live_warm', [
      { role: 'user', content: 'same session input' },
    ])
    expect(live).toHaveLength(1)
    await tickAfter(30)
    expect(warms).toHaveLength(0)
    await tickAfter(26)
    expect(warms).toHaveLength(1)
    const warm = warms[0]!
    expect(warm.body.model).toBe(model)
    expect(warm.body.max_tokens).toBe(0)
    expect(warm.body.messages).toEqual(live[0]!.body.messages)
    const auth = live[0]!.headers.get('authorization')
    expect(auth).toStartWith('Bearer ')
    expect(warm.headers.get('authorization')).toBe(auth)
    expect(warm.body).not.toHaveProperty('fallbacks')
    const betas = warm.headers.get('anthropic-beta')?.split(',')
    expect(betas).toContain(SERVER_SIDE_FALLBACK_BETA)
    expect(betas).toContain(CACHE_KEEP_EXTENDED_TTL_BETA)
    await tickAfter(0)
    expect(warms).toHaveLength(1)
  })

  test('does not warm a live session when CacheKeep is disabled', async () => {
    const { live, warms, send, tickAfter } = await fixture(false)
    await send('ses_live_warm_disabled', [{ role: 'user', content: 'hello' }])
    expect(live).toHaveLength(1)
    await tickAfter(56)
    expect(warms).toHaveLength(0)
  })
})
