import { describe, expect, mock } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import type { AccountStorage } from '@cortexkit/anthropic-auth-core'
import { FABLE_FALLBACK_TURNS } from '../fable-fallback'
import { installLoaderSetup } from './support/opencode1-loader-setup.ts'
import {
  createFallbackStorage,
  getPlugin as getPluginWithCtx,
  syntheticMainHostAuth,
  useTempAccountFile as useTempAccountFileWithCtx,
  withNativeAdmission as withNativeAdmissionWithCtx,
} from './support/opencode1-pool-fixture.ts'
import {
  createOpencode1Test,
  createOpencode1TestContext,
  installOpencode1TestHooks,
} from './support/opencode1-test-context.ts'
import { extractUrl, MESSAGES_URL } from './test-fetch'

const testContext = createOpencode1TestContext()
installOpencode1TestHooks(testContext)
const test = createOpencode1Test(testContext)

function useTempAccountFile(storage: AccountStorage) {
  return useTempAccountFileWithCtx(
    testContext,
    storage,
    syntheticMainHostAuth(),
  )
}
function withNativeAdmission<Input, Init>(
  handler: (input: Input, init: Init) => unknown,
) {
  return withNativeAdmissionWithCtx(testContext, handler)
}

const SOURCE = 'claude-fable-5-2'
const FALLBACK = 'claude-opus-4-8'
const SESSION = 'ses_recovery_thinking'

type Block = Record<string, unknown>
type Message = { role: 'user' | 'assistant'; content: string | Block[] }

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/** A streamed response: one signed thinking block, then a tool call or text. */
function responseSse(options: {
  model: string
  signature: string
  stopReason: 'refusal' | 'tool_use' | 'end_turn'
  toolUseId?: string
}) {
  const frames = [
    frame('message_start', {
      type: 'message_start',
      message: { id: `msg_${options.signature}`, model: options.model },
    }),
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'synthetic reasoning' },
    }),
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: options.signature },
    }),
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ]
  if (options.stopReason === 'tool_use') {
    frames.push(
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: options.toolUseId,
          name: 'mcp_Read',
          input: {},
        },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    )
  } else if (options.stopReason === 'end_turn') {
    frames.push(
      frame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }),
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'done' },
      }),
      frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
    )
  }
  frames.push(
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: options.stopReason },
      usage: { output_tokens: 1 },
    }),
    frame('message_stop', { type: 'message_stop' }),
  )
  return frames.join('')
}

const thinking = (signature: string): Block => ({
  type: 'thinking',
  thinking: 'synthetic reasoning',
  signature,
})
const toolUse = (id: string): Block => ({
  type: 'tool_use',
  id,
  name: 'read',
  input: {},
})
const toolResult = (id: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
})

function thinkingSignatures(message: { content?: unknown }) {
  return Array.isArray(message.content)
    ? message.content
        .filter((block: Block) => block.type === 'thinking')
        .map((block: Block) => block.signature)
    : []
}

describe('refusal recovery round thinking', () => {
  installLoaderSetup(testContext)

  test('a return to the source model after a mid-turn refusal leaves the fallback round thinking out of that turn', async () => {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_FALLBACK_MODE
    await useTempAccountFile(
      createFallbackStorage({
        accounts: [],
        claudeCache: { enabled: false },
        cacheKeep: { enabled: false },
      }),
    )

    // Opus writes one thinking block per response in the round. The last one
    // ends the turn; the earlier ones each call a tool.
    const fallbackResponses = Array.from(
      { length: FABLE_FALLBACK_TURNS },
      (_, index) => ({
        signature: `fallback-sig-${index}`,
        toolUseId: `toolu_fallback_${index}`,
        last: index === FABLE_FALLBACK_TURNS - 1,
      }),
    )
    const sent: Array<{ model: string; messages: Message[] }> = []
    let fallbackIndex = 0
    globalThis.fetch = mock(
      withNativeAdmission((input: any, init: any) => {
        const url = extractUrl(input)
        if (url.includes('/api/oauth/usage')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 0 },
              }),
              { status: 200 },
            ),
          )
        }
        if (!url.includes('/v1/messages')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        // Large OAuth bodies go out gzipped.
        const raw = init?.body as string | Uint8Array
        const text =
          typeof raw === 'string'
            ? raw
            : new TextDecoder().decode(gunzipSync(raw)).trimEnd()
        const body = JSON.parse(text) as {
          model: string
          max_tokens?: number
          messages: Message[]
        }
        if (body.max_tokens === 0) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        sent.push({ model: body.model, messages: body.messages })
        if (body.model === SOURCE && sent.length === 1) {
          return Promise.resolve(
            new Response(
              responseSse({
                model: SOURCE,
                signature: 'source-sig-refused',
                stopReason: 'refusal',
              }),
              { status: 200 },
            ),
          )
        }
        if (body.model === FALLBACK) {
          const next = fallbackResponses[fallbackIndex++]!
          return Promise.resolve(
            new Response(
              responseSse({
                model: FALLBACK,
                signature: next.signature,
                stopReason: next.last ? 'end_turn' : 'tool_use',
                toolUseId: next.toolUseId,
              }),
              { status: 200 },
            ),
          )
        }
        return Promise.resolve(
          new Response(
            responseSse({
              model: SOURCE,
              signature: 'source-sig-after-return',
              stopReason: 'end_turn',
            }),
            { status: 200 },
          ),
        )
      }),
    ) as unknown as typeof fetch

    const plugin = await getPluginWithCtx(testContext)
    const result = await plugin.auth.loader(
      () =>
        Promise.resolve({
          type: 'oauth',
          access: 'sk-ant-oat01-main-access',
          refresh: 'main-refresh',
          expires: Date.now() + 100000,
        }),
      { models: {} },
    )
    const send = (messages: Message[]) =>
      result.fetch(MESSAGES_URL, {
        method: 'POST',
        headers: { 'x-session-affinity': SESSION },
        body: JSON.stringify({
          model: SOURCE,
          max_tokens: 128_000,
          stream: true,
          thinking: { type: 'adaptive' },
          system: [{ type: 'text', text: 'stable system' }],
          messages,
        }),
      })

    // The source model already thought twice in this turn before refusing.
    const history: Message[] = [
      { role: 'user', content: 'start the task' },
      {
        role: 'assistant',
        content: [thinking('source-sig-1'), toolUse('toolu_source_1')],
      },
      toolResult('toolu_source_1'),
      {
        role: 'assistant',
        content: [thinking('source-sig-2'), toolUse('toolu_source_2')],
      },
      toolResult('toolu_source_2'),
    ]
    const refused = await send(history)
    await expect(refused.text()).rejects.toThrow()

    // OpenCode retries the same history on Opus. It keeps the refused
    // response's thinking and appends the retry to that assistant message.
    for (const [index, response] of fallbackResponses.entries()) {
      const reply = await send(history)
      await reply.text()
      history.push({
        role: 'assistant',
        content: [
          ...(index === 0 ? [thinking('source-sig-refused')] : []),
          thinking(response.signature),
          response.last
            ? { type: 'text', text: 'done' }
            : toolUse(response.toolUseId),
        ],
      })
      history.push(
        response.last
          ? { role: 'user', content: 'next question' }
          : toolResult(response.toolUseId),
      )
    }
    expect(sent.map((request) => request.model)).toEqual([
      SOURCE,
      ...Array.from({ length: FABLE_FALLBACK_TURNS }, () => FALLBACK),
    ])
    // The Opus requests during the round still see every block.
    expect(sent.at(-1)!.messages.flatMap(thinkingSignatures)).toEqual([
      'source-sig-1',
      'source-sig-2',
      'source-sig-refused',
      ...fallbackResponses.slice(0, -1).map((response) => response.signature),
    ])

    // The round is over: the next request goes back to the source model.
    const returned = await send(history)
    await returned.text()
    const returnRequest = sent.at(-1)!
    expect(returnRequest.model).toBe(SOURCE)
    // The source model's own thinking stays, the refused block included; the
    // thinking Opus wrote after it in the same turn is left out.
    expect(returnRequest.messages.flatMap(thinkingSignatures)).toEqual([
      'source-sig-1',
      'source-sig-2',
      'source-sig-refused',
    ])
    // Everything else the fallback model wrote stays.
    expect(
      returnRequest.messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content
              .filter((block) => block.type === 'tool_use')
              .map((block) => block.id)
          : [],
      ),
    ).toEqual([
      'toolu_source_1',
      'toolu_source_2',
      ...fallbackResponses.slice(0, -1).map((response) => response.toolUseId),
    ])
    expect(JSON.stringify(returnRequest.messages)).toContain('"text":"done"')
  })
})
