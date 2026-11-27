import { isDeepStrictEqual } from 'node:util'

type Body = Record<string, unknown>
type Block = Record<string, unknown>
type FixtureBlock = { block: Block; open?: boolean; slow?: boolean }

export const refusalMarker = (point: number) => `[refusal-fixture:${point}]`
export const fixtureSource = 'claude-opus-5-5'
export const fixtureFallback = 'claude-opus-4-8'
export const fixtureCredit = 'mock-refusal-credit'
export const retryRefusalCredit = 'mock-target-refusal-credit'
export const openThinking = 'unsigned source thinking fixture'
export const sourceText = 'Source text before refusal.'
export const targetText = 'Target text after refusal.'
export const completedToolId = 'toolu_refusal_completed'
export const openToolId = 'toolu_refusal_open'
export const followPrompt =
  '[refusal-fixture:follow] Reply to this second prompt.'
export const recoveryText = 'Host retried after the idle timeout.'
export const slowToolMs = 42_000
export const toolChunkTimeoutMs = 36_000
const mismatch =
  'request body (including render-shaping fields such as tool_choice/thinking) does not match the original refused request'

function comparableBody(body: Body): Body {
  const copy = structuredClone(body)
  for (const key of ['model', 'max_tokens', 'fallback_credit_token'])
    delete copy[key]
  if (Array.isArray(copy.system)) {
    for (const block of copy.system) {
      if (
        block?.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.startsWith('x-anthropic-billing-header:')
      )
        block.text = block.text.replace(/\bcch=[0-9a-f]{5};/, 'cch=00000;')
    }
  }
  return copy
}

/** Allow either the original history or precisely one appended refused assistant. */
export function matchesRefusalCredit(
  refused: Body,
  retry: Body,
  emitted: Block[],
): boolean {
  if ('fallbacks' in retry) return false
  const original = comparableBody(refused)
  delete original.fallbacks
  const next = comparableBody(retry)
  if (isDeepStrictEqual(original, next)) return true
  if (!emitted.length || !Array.isArray(original.messages)) return false
  return isDeepStrictEqual(next, {
    ...original,
    messages: [...original.messages, { role: 'assistant', content: emitted }],
  })
}

export function fixturePoint(body: Body): number | undefined {
  if (!Array.isArray(body.messages)) return undefined
  const user = body.messages.findLast(
    (message) =>
      message?.role === 'user' &&
      (typeof message.content === 'string' ||
        (Array.isArray(message.content) &&
          message.content.some(
            (block: Block | null) => block?.type === 'text',
          ))),
  )
  const texts: unknown[] = Array.isArray(user?.content)
    ? user.content.flatMap((block: Block | null) =>
        block?.type === 'text' ? [block.text] : [],
      )
    : [user?.content]
  // A host can merge the new user prompt with the refused turn's user message.
  if (
    texts.some(
      (text) => typeof text === 'string' && text.startsWith(followPrompt),
    )
  )
    return undefined
  for (const text of texts) {
    const match =
      typeof text === 'string' && text.match(/^\s*\[refusal-fixture:(\d+)\]/)
    if (match) return Number(match[1])
  }
  return undefined
}

export type RefusalMockEvent = { kind: string; at: number; model: unknown }

/** The first request for each fixture point refuses; unmarked prompts use the usual mock. */
export class RefusalMock {
  readonly events: RefusalMockEvent[] = []
  private readonly originals = new Map<
    number,
    { body: Body; prefill: Block[] }
  >()

  constructor(
    private readonly toolInput: (tool: string) => Record<string, unknown>,
  ) {}

  respond(body: Body): Response | undefined {
    const point = fixturePoint(body)
    if (!point || point > 14) return undefined
    const model = String(body.model)
    const original = this.originals.get(point)
    if (body.fallback_credit_token !== undefined) {
      const accepted =
        original &&
        body.fallback_credit_token === fixtureCredit &&
        model === fixtureFallback &&
        matchesRefusalCredit(original.body, body, original.prefill)
      this.mark(accepted ? 'credited' : 'credit-rejected', body)
      if (!accepted)
        return Response.json(
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: mismatch },
          },
          { status: 400 },
        )
      if (point === 8)
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'overloaded_error',
              message: `Rejected ${fixtureCredit}`,
            },
          },
          { status: 529 },
        )
      return fixtureStream({
        model,
        content: [{ block: thinking(model) }, { block: text(targetText) }],
        stop: point === 9 ? 'refusal' : 'end_turn',
        credited: true,
        credit: retryRefusalCredit,
      })
    }
    if (original) {
      this.mark(point === 13 ? 'idle-text-retried' : 'uncredited', body)
      return fixtureStream({
        model,
        content: [
          {
            block: text(
              point === 13
                ? recoveryText
                : point === 14
                  ? targetText
                  : 'Tool continuation completed.',
            ),
          },
        ],
        stop: 'end_turn',
      })
    }
    const content: FixtureBlock[] = []
    if (point === 2 || point === 9) content.push({ block: thinking(model) })
    if ([3, 7, 8, 9, 12, 14].includes(point))
      content.push({ block: text(sourceText), open: point === 7 })
    if (point === 6)
      content.push({
        block: { type: 'thinking', thinking: openThinking },
        open: true,
      })
    if (point === 13) content.push({ block: text(sourceText), slow: true })
    if ([4, 5, 10, 11].includes(point)) {
      const name = (body.tools as { name: string }[] | undefined)?.find(
        (tool) => /^(?:mcp_)?(?:bash|shell)$/i.test(tool.name),
      )?.name
      if (!name)
        return Response.json(
          { error: 'fixture bash tool unavailable' },
          { status: 422 },
        )
      const tool = (id: string) => ({
        type: 'tool_use',
        id,
        name,
        input: this.toolInput(name),
      })
      if (point !== 5)
        content.push({ block: tool(completedToolId), slow: point === 11 })
      if (point === 5 || point === 10)
        content.push({ block: tool(openToolId), open: true })
      // The mock's first block is never released. The text that follows it
      // must become the host's first block, even though it arrives second.
      if (point === 5) content.push({ block: text(sourceText) })
    }
    const claim = point !== 12
    const prefill = claim
      ? content.flatMap(({ block, open }) =>
          block.type === 'text' || (block.type === 'thinking' && !open)
            ? [block]
            : [],
        )
      : []
    this.originals.set(point, { body, prefill })
    return fixtureStream({
      model,
      content,
      stop: point === 13 ? 'end_turn' : 'refusal',
      credit: point === 14 ? null : fixtureCredit,
      claim,
      onStop: () =>
        this.mark(point === 13 ? 'idle-text-completed' : 'refusal', body),
    })
  }

  private mark(kind: string, body: Body) {
    this.events.push({ kind, at: Date.now(), model: body.model })
  }
}

export const thinking = (model: string) => ({
  type: 'thinking',
  thinking: `thought from ${model}`,
  signature: `signature:${model}`,
})
const text = (value: string) => ({ type: 'text', text: value })

export function fixtureStream({
  model,
  content,
  stop,
  credited = false,
  credit,
  claim,
  onStop,
  beforeContent,
  beforeBlock,
  beforeStop,
  category = 'cyber',
  usage,
  headers,
}: {
  model: string
  content: FixtureBlock[]
  stop: 'refusal' | 'end_turn'
  credited?: boolean
  credit?: string | null
  claim?: boolean
  onStop?: () => void
  beforeContent?: () => Promise<void>
  beforeBlock?: (index: number) => Promise<void>
  beforeStop?: () => Promise<void>
  category?: string | null
  usage?: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  headers?: Record<string, string>
}) {
  const input =
    usage ??
    (credited
      ? {
          input_tokens: 9,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 277,
        }
      : {
          input_tokens: 11,
          cache_creation_input_tokens: 222,
          cache_read_input_tokens: 5,
        })
  const encoder = new TextEncoder()
  let cancelled = false
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (type: string, fields: Body = {}) =>
          controller.enqueue(
            encoder.encode(
              `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
            ),
          )
        send('message_start', {
          message: {
            type: 'message',
            id: `msg_${crypto.randomUUID()}`,
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { ...input, output_tokens: 0 },
          },
        })
        send('ping')
        if (beforeContent) await beforeContent()
        if (cancelled) return
        for (const [index, { block, open, slow }] of content.entries()) {
          if (beforeBlock) await beforeBlock(index)
          if (cancelled) return
          const delta = (value: Body) =>
            send('content_block_delta', { index, delta: value })
          if (block.type === 'thinking') {
            send('content_block_start', {
              index,
              content_block: { type: 'thinking', thinking: '' },
            })
            delta({ type: 'thinking_delta', thinking: block.thinking })
            if (!open)
              delta({ type: 'signature_delta', signature: block.signature })
          } else if (block.type === 'text') {
            send('content_block_start', {
              index,
              content_block: { type: 'text', text: '' },
            })
            delta({ type: 'text_delta', text: block.text })
            if (slow) await Bun.sleep(slowToolMs)
            if (cancelled) return
          } else {
            send('content_block_start', {
              index,
              content_block: { ...block, input: {} },
            })
            const json = JSON.stringify(block.input)
            const chunks = slow ? (json.match(/.{1,10}/g) ?? []) : [json]
            for (const [index, chunk] of chunks.entries()) {
              if (slow && index !== 0)
                await Bun.sleep(slowToolMs / (chunks.length - 1))
              if (cancelled) return
              delta({ type: 'input_json_delta', partial_json: chunk })
            }
          }
          if (!open) send('content_block_stop', { index })
        }
        if (beforeStop) await beforeStop()
        if (cancelled) return
        onStop?.()
        send('message_delta', {
          delta: {
            stop_reason: stop,
            stop_sequence: null,
            ...(stop === 'refusal'
              ? {
                  stop_details: {
                    type: 'refusal',
                    category: category ?? undefined,
                    fallback_credit_token: credit,
                    fallback_has_prefill_claim: claim ?? false,
                  },
                }
              : {}),
          },
          usage: { output_tokens: stop === 'refusal' && !credited ? 17 : 29 },
        })
        send('message_stop')
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        ...headers,
      },
    },
  )
}
