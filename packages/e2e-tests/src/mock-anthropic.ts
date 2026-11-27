import { gunzipSync } from 'node:zlib'

export type MockUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type MockResponse =
  | {
      type: 'text'
      text: string
      delayMs?: number
      usage?: MockUsage
      headers?: Record<string, string>
    }
  | {
      type: 'tool_use'
      id?: string
      name: string
      input: Record<string, unknown>
      splitToolNameChunk?: boolean
      usage?: MockUsage
      headers?: Record<string, string>
    }
  | {
      type: 'refusal'
      usage?: MockUsage
      headers?: Record<string, string>
    }
  | {
      type: 'server_fallback'
      fromModel: string
      toModel: string
      text: string
      partialText?: string
      thinkingText?: string
      handoff?: boolean
      usage?: MockUsage
      headers?: Record<string, string>
    }
  | {
      type: 'server_fallback_tool_refusal'
      fromModel: string
      toModel: string
      name: string
      input: Record<string, unknown>
      refusalDelayMs?: number
      usage?: MockUsage
      headers?: Record<string, string>
    }
  | {
      type: 'error'
      status: number
      errorType: string
      message: string
      headers?: Record<string, string>
      /** Test-only synchronization point after request capture, before refusal. */
      beforeRespond?: () => void
    }

export type CapturedAnthropicRequest = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const DEFAULT_USAGE: MockUsage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

export class MockAnthropicServer {
  private server: ReturnType<typeof Bun.serve> | null = null
  private queue: MockResponse[] = []
  private captured: CapturedAnthropicRequest[] = []
  private tokenRequestCount = 0

  constructor(
    private readonly refusal?: {
      respond(
        body: CapturedAnthropicRequest['body'],
        request: CapturedAnthropicRequest,
      ): Response | undefined | Promise<Response | undefined>
    },
  ) {}

  async start() {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // Longer than the host-side idle timeout in the refusal fixtures.
      idleTimeout: this.refusal ? 60 : undefined,
      fetch: (request) => this.handle(request),
    })
    const port = this.server.port
    if (!port) throw new Error('mock Anthropic server failed to bind')
    return { port, baseURL: `http://127.0.0.1:${port}` }
  }

  async stop() {
    this.server?.stop(true)
    this.server = null
  }

  script(responses: MockResponse[]) {
    this.queue = [...responses]
  }

  requests() {
    return [...this.captured]
  }

  tokenRequests() {
    return this.tokenRequestCount
  }

  private async handle(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === '/oauth/token') {
      this.tokenRequestCount += 1
      return new Response(
        JSON.stringify({ error: 'unexpected_token_refresh' }),
        {
          status: 500,
          headers: { 'content-type': 'application/json' },
        },
      )
    }
    if (
      request.method !== 'POST' ||
      (url.pathname !== '/v1/messages' && url.pathname !== '/messages')
    ) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const body = (await (async () => {
      if (request.headers.get('content-encoding') === 'gzip')
        return JSON.parse(
          gunzipSync(new Uint8Array(await request.arrayBuffer())).toString(),
        )
      return request.json()
    })().catch(() => ({}))) as Record<string, unknown>
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
    const captured = { url: request.url, headers, body }
    this.captured.push(captured)

    if (
      JSON.stringify(body).includes('Generate a title for this conversation')
    ) {
      return new Response(
        createSseStream({ type: 'text', text: 'test title' }, body),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        },
      )
    }

    // CacheKeep and Fable recovery prewarms must not consume the scripted
    // generation sequence. They are zero-output maintenance requests that run
    // asynchronously between normal model turns.
    if (body.max_tokens === 0) {
      return new Response(
        createSseStream(
          {
            type: 'text',
            text: '',
            usage: { ...DEFAULT_USAGE, output_tokens: 0 },
          },
          body,
        ),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        },
      )
    }

    const refusal = await this.refusal?.respond(body, captured)
    if (refusal) return refusal

    const response = this.queue.shift() ?? {
      type: 'text' as const,
      text: 'ok',
    }
    if (response.type === 'error') {
      response.beforeRespond?.()
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: response.errorType, message: response.message },
        }),
        {
          status: response.status,
          headers: {
            'content-type': 'application/json',
            ...response.headers,
          },
        },
      )
    }

    return new Response(createSseStream(response, body), {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...response.headers,
      },
    })
  }
}

function createSseStream(
  response: Exclude<MockResponse, { type: 'error' }>,
  requestBody: Record<string, unknown>,
) {
  const encoder = new TextEncoder()
  const usage = response.usage ?? DEFAULT_USAGE
  const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
  const requestedModel =
    typeof requestBody.model === 'string' ? requestBody.model : 'mock-model'
  const model =
    response.type === 'server_fallback' ||
    response.type === 'server_fallback_tool_refusal'
      ? response.toModel
      : requestedModel

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if ('delayMs' in response && response.delayMs) {
        await Bun.sleep(response.delayMs)
      }
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }
      const sendRaw = (text: string) => controller.enqueue(encoder.encode(text))

      send('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          },
        },
      })

      if (response.type === 'refusal') {
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'refusal', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        })
      } else if (response.type === 'server_fallback_tool_refusal') {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_fallback_refusal',
            name: response.name,
            input: {},
          },
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(response.input),
          },
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        if (response.refusalDelayMs) await Bun.sleep(response.refusalDelayMs)
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'refusal', stop_sequence: null },
          usage: {
            output_tokens: usage.output_tokens,
            iterations: [
              {
                type: 'fallback_message',
                model: response.toModel,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
              },
            ],
          },
        })
      } else if (response.type === 'server_fallback') {
        let blockIndex = 0
        if (response.partialText) {
          send('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          })
          send('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: response.partialText },
          })
          send('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex,
          })
          blockIndex++
        }
        if (response.handoff !== false) {
          send('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'fallback',
              from: { model: response.fromModel },
              to: { model: response.toModel },
            },
          })
          send('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex,
          })
          blockIndex++
        }
        if (response.thinkingText != null) {
          send('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          })
          send('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'thinking_delta',
              thinking: response.thinkingText,
            },
          })
          send('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'signature_delta',
              signature: 'mock-target-thinking-signature',
            },
          })
          send('content_block_stop', {
            type: 'content_block_stop',
            index: blockIndex,
          })
          blockIndex++
        }
        send('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' },
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: response.text },
        })
        send('content_block_stop', {
          type: 'content_block_stop',
          index: blockIndex,
        })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: {
            output_tokens: usage.output_tokens,
            iterations: [
              ...(response.handoff === false
                ? []
                : [
                    {
                      type: 'message',
                      model: response.fromModel,
                      input_tokens: usage.input_tokens,
                      output_tokens: 0,
                    },
                  ]),
              {
                type: 'fallback_message',
                model: response.toModel,
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
              },
            ],
          },
        })
      } else if (response.type === 'tool_use') {
        const startFrame = `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: response.id ?? 'toolu_read_1',
            name: response.name,
            input: {},
          },
        })}\n\n`
        if (response.splitToolNameChunk) {
          const splitAt = startFrame.indexOf('"name":"') + '"na'.length
          sendRaw(startFrame.slice(0, splitAt))
          sendRaw(startFrame.slice(splitAt))
        } else {
          sendRaw(startFrame)
        }
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(response.input),
          },
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        })
      } else {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: response.text },
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        })
      }

      send('message_stop', { type: 'message_stop' })
      controller.close()
    },
  })
}
