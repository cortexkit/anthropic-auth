import { describe, expect, test } from 'bun:test'
import {
  applyServerSideFallbackToBody,
  createServerSideFallbackStreamRewriter,
  resolveContentFilterFallbackMode,
  SERVER_FALLBACK_MARKER_TEXT,
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
  type ServerSideFallbackOutcome,
} from '../server-fallback'

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function fallbackStream(options?: {
  requestedModel?: string
  servedModel?: string
  fromModel?: string
  toModel?: string
  fallbackIndex?: number
  includeHandoff?: boolean
  fallbackIteration?: boolean
  stopReason?: string
}) {
  const requestedModel = options?.requestedModel ?? 'claude-fable-5'
  const servedModel = options?.servedModel ?? 'claude-opus-5'
  const fromModel = options?.fromModel ?? requestedModel
  const toModel = options?.toModel ?? servedModel
  const fallbackIndex = options?.fallbackIndex ?? 0
  const frames = [
    sse('message_start', {
      type: 'message_start',
      message: { model: servedModel, usage: { input_tokens: 1 } },
    }),
  ]
  if (fallbackIndex > 0) {
    frames.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial source output' },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    )
  }
  if (options?.includeHandoff !== false) {
    frames.push(
      sse('content_block_start', {
        type: 'content_block_start',
        index: fallbackIndex,
        content_block: {
          type: 'fallback',
          from: { model: fromModel },
          to: { model: toModel },
        },
      }),
      sse('content_block_stop', {
        type: 'content_block_stop',
        index: fallbackIndex,
      }),
    )
  }
  frames.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: options?.stopReason ?? 'end_turn' },
      usage: {
        output_tokens: 1,
        iterations:
          options?.fallbackIteration === false
            ? [{ type: 'message', model: requestedModel }]
            : [
                { type: 'message', model: requestedModel },
                { type: 'fallback_message', model: servedModel },
              ],
      },
    }),
    sse('message_stop', { type: 'message_stop' }),
  )
  return frames.join('')
}

describe('resolveContentFilterFallbackMode', () => {
  test('defaults to Anthropic server-side fallback', () => {
    expect(resolveContentFilterFallbackMode(undefined)).toBe('server')
    expect(resolveContentFilterFallbackMode('')).toBe('server')
    expect(resolveContentFilterFallbackMode('invalid')).toBe('server')
  })

  test('retains the ten-response recovery behind the legacy value', () => {
    expect(resolveContentFilterFallbackMode('legacy')).toBe('legacy')
    expect(resolveContentFilterFallbackMode(' LEGACY ')).toBe('legacy')
    expect(resolveContentFilterFallbackMode('server')).toBe('server')
  })
})

describe('applyServerSideFallbackToBody', () => {
  test('opts Fable 5 and Opus 5 requests into the default server policy', () => {
    for (const model of ['claude-fable-5', 'claude-opus-5-20260701']) {
      const body = { model, messages: [{ role: 'user', content: 'hello' }] }
      expect(applyServerSideFallbackToBody(body, true)).toEqual({
        enabled: true,
        restoredMarkers: 0,
        droppedMarkers: 0,
      })
      expect((body as { fallbacks?: unknown }).fallbacks).toBe('default')
    }
    expect(SERVER_SIDE_FALLBACK_BETA).toBe('server-side-fallback-2026-07-01')
  })

  test('does not opt unrelated models into server-side fallback', () => {
    const body = {
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hello' }],
    }
    expect(applyServerSideFallbackToBody(body, true).enabled).toBe(false)
    expect(body).not.toHaveProperty('fallbacks')
  })

  test('restores a durable mid-output marker to the exact fallback block', () => {
    const body = {
      model: 'claude-fable-5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'partial source output' },
            {
              type: 'thinking',
              thinking: SERVER_FALLBACK_MARKER_TEXT,
              signature: `${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-fable-5|claude-opus-5`,
            },
            { type: 'text', text: 'continued fallback output' },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    }

    expect(applyServerSideFallbackToBody(body, true)).toEqual({
      enabled: true,
      restoredMarkers: 1,
      droppedMarkers: 0,
    })
    expect(body.messages[0]?.content[1] as unknown).toEqual({
      type: 'fallback',
      from: { model: 'claude-fable-5' },
      to: { model: 'claude-opus-5' },
    })
  })

  test('restores markers after OpenCode normalizes their invisible text to empty', () => {
    const body = {
      model: 'claude-fable-5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'partial source output' },
            {
              type: 'thinking',
              thinking: '',
              signature: `${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-fable-5|claude-opus-5`,
            },
            { type: 'text', text: 'continued fallback output' },
          ],
        },
      ],
    }

    expect(applyServerSideFallbackToBody(body, true).restoredMarkers).toBe(1)
    expect(body.messages[0]?.content[1] as unknown).toEqual({
      type: 'fallback',
      from: { model: 'claude-fable-5' },
      to: { model: 'claude-opus-5' },
    })
  })

  test('preserves ordinary thinking, restores chained fallbacks, and drops malformed internal markers', () => {
    const body = {
      model: 'claude-fable-5',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'real reasoning',
              signature: 'anthropic-provider-signature',
            },
            {
              type: 'thinking',
              thinking: '',
              signature: `${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-opus-5|claude-opus-4-8`,
            },
            {
              type: 'thinking',
              thinking: '',
              signature: `${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-fable-5|../invalid`,
            },
          ] as Array<Record<string, unknown>>,
        },
      ],
    }

    expect(applyServerSideFallbackToBody(body, true)).toEqual({
      enabled: true,
      restoredMarkers: 1,
      droppedMarkers: 1,
    })
    expect(body.messages[0]?.content).toEqual([
      {
        type: 'thinking',
        thinking: 'real reasoning',
        signature: 'anthropic-provider-signature',
      },
      {
        type: 'fallback',
        from: { model: 'claude-opus-5' },
        to: { model: 'claude-opus-4-8' },
      },
    ])
  })

  test('drops historical internal markers when legacy mode is selected', () => {
    const body = {
      model: 'claude-fable-5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'partial source output' },
            {
              type: 'thinking',
              thinking: SERVER_FALLBACK_MARKER_TEXT,
              signature: `${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-fable-5|claude-opus-5`,
            },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    }

    expect(applyServerSideFallbackToBody(body, false)).toEqual({
      enabled: false,
      restoredMarkers: 0,
      droppedMarkers: 1,
    })
    expect(body).not.toHaveProperty('fallbacks')
    expect(body.messages[0]?.content).toEqual([
      { type: 'text', text: 'partial source output' },
    ])
  })
})

describe('createServerSideFallbackStreamRewriter', () => {
  test('turns a pre-output handoff into a durable hidden reasoning marker', () => {
    const outcomes: ServerSideFallbackOutcome[] = []
    const stream = fallbackStream()
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: 'claude-fable-5',
      onOutcome: (outcome) => outcomes.push(outcome),
    })

    const output =
      rewriter.push(stream.slice(0, 71)) +
      rewriter.push(stream.slice(71, 193)) +
      rewriter.push(stream.slice(193)) +
      rewriter.flush()

    expect(output).not.toContain('"type":"fallback","from"')
    expect(output).toContain(JSON.stringify(SERVER_FALLBACK_MARKER_TEXT))
    expect(output).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
    expect(outcomes).toEqual([
      {
        requestedModel: 'claude-fable-5',
        servedModel: 'claude-opus-5',
        targetModel: 'claude-opus-5',
        fallback: true,
        handoff: true,
        stopReason: 'end_turn',
      },
    ])
  })

  test('recognizes a sticky fallback turn from message model and iterations', () => {
    const outcomes: ServerSideFallbackOutcome[] = []
    const stream = fallbackStream({
      includeHandoff: false,
      servedModel: 'claude-opus-5',
    })
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: 'claude-fable-5',
      onOutcome: (outcome) => outcomes.push(outcome),
    })

    expect(rewriter.push(stream) + rewriter.flush()).toBe(stream)
    expect(outcomes).toEqual([
      expect.objectContaining({
        fallback: true,
        handoff: false,
        servedModel: 'claude-opus-5',
        targetModel: 'claude-opus-5',
      }),
    ])
  })

  test('reports restoration when the requested model serves successfully', () => {
    const outcomes: ServerSideFallbackOutcome[] = []
    const stream = fallbackStream({
      includeHandoff: false,
      servedModel: 'claude-fable-5',
      fallbackIteration: false,
    })
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: 'claude-fable-5',
      onOutcome: (outcome) => outcomes.push(outcome),
    })

    rewriter.push(stream)
    rewriter.flush()
    expect(outcomes).toEqual([
      expect.objectContaining({
        fallback: false,
        handoff: false,
        servedModel: 'claude-fable-5',
        targetModel: undefined,
      }),
    ])
  })

  test('turns a mid-output handoff into a durable hidden reasoning marker', () => {
    const stream = fallbackStream({ fallbackIndex: 1 })
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: 'claude-fable-5',
    })
    const output = rewriter.push(stream) + rewriter.flush()

    expect(output).not.toContain('"type":"fallback","from"')
    expect(output).toContain(JSON.stringify(SERVER_FALLBACK_MARKER_TEXT))
    expect(output).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
    expect(output).toContain('partial source output')
  })

  test('does not absorb a refusal while a tool call is incomplete', () => {
    let handled = 0
    const stream = [
      sse('message_start', {
        type: 'message_start',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } },
      }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_incomplete',
          name: 'mcp_Bash',
          input: {},
        },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":' },
      }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'refusal' },
        usage: {
          output_tokens: 1,
          iterations: [{ type: 'fallback_message', model: 'claude-opus-4-8' }],
        },
      }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: 'claude-fable-5',
      onRefusalAfterToolUse: () => {
        handled++
        return true
      },
    })

    const output = rewriter.push(stream) + rewriter.flush()

    expect(handled).toBe(0)
    expect(output).toContain('"stop_reason":"refusal"')
    expect(output).not.toContain('"stop_reason":"tool_use"')
  })

  test('preserves a completed tool call when its fallback turn later refuses', () => {
    let handled = 0
    const outcomes: ServerSideFallbackOutcome[] = []
    const stream = [
      sse('message_start', {
        type: 'message_start',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1 } },
      }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'mcp_Peer_inbox',
          input: {},
        },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"action":"list"}' },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'refusal' },
        usage: {
          output_tokens: 1,
          iterations: [{ type: 'fallback_message', model: 'claude-opus-4-8' }],
        },
      }),
      sse('message_stop', { type: 'message_stop' }),
    ].join('')
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: 'claude-fable-5',
      onOutcome: (outcome) => outcomes.push(outcome),
      onRefusalAfterToolUse: () => {
        handled++
        return true
      },
    })

    const output = rewriter.push(stream) + rewriter.flush()

    expect(handled).toBe(1)
    expect(output).toContain('"stop_reason":"tool_use"')
    expect(output).not.toContain('"stop_reason":"refusal"')
    expect(outcomes).toEqual([
      expect.objectContaining({
        fallback: true,
        targetModel: 'claude-opus-4-8',
        stopReason: 'refusal',
      }),
    ])
  })

  test.each([
    ['LF', '\n\n', 1],
    ['CRLF', '\r\n\r\n', 2],
  ])('resyncs after an oversized frame ending in a split %s boundary', (_name, delimiter, splitAt) => {
    let handled = 0
    const skipped = `data: ${'x'.repeat(256)}`
    const later = [
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_after_overflow',
          name: 'mcp_Bash',
          input: {},
        },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-4-8' },
        },
      }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'refusal' },
      }),
    ].join('')
    const rewriter = createServerSideFallbackStreamRewriter({
      requestedModel: 'claude-fable-5',
      maxPendingBytes: 64,
      onRefusalAfterToolUse: () => {
        handled++
        return true
      },
    })

    const output =
      rewriter.push(`${skipped}${delimiter.slice(0, splitAt)}`) +
      rewriter.push(`${delimiter.slice(splitAt)}${later}`) +
      rewriter.flush()

    expect(output.slice(0, skipped.length + delimiter.length)).toBe(
      `${skipped}${delimiter}`,
    )
    expect(output).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
    expect(output).toContain('"stop_reason":"tool_use"')
    expect(output).not.toContain('"stop_reason":"refusal"')
    expect(handled).toBe(1)
  })
})
