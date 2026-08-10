import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  CLAUDE_CODE_IDENTITY,
  FAST_MODE_BETA,
  OPENCODE_IDENTITY_PREFIX,
  REQUIRED_BETAS,
  selectClaudeCodeBetas,
} from '@cortexkit/anthropic-auth-core'
import dedent from 'dedent'
import {
  SERVER_FALLBACK_MARKER_TEXT,
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
  type ServerSideFallbackOutcome,
} from '../server-fallback'
import {
  addFastModeBetaHeader,
  createStrippedStream,
  extractLatestHybridMessageCacheAnchor,
  getSanitizeMemoStats,
  isInsecure,
  mergeBetaHeaders,
  mergeHeaders,
  prefixToolNames,
  prepareFableCacheWarmSource,
  prependClaudeCodeIdentity,
  rewriteRequestBody,
  rewriteUrl,
  sanitizeSystemText,
  setOAuthHeaders,
  stripToolPrefix,
} from '../transform'

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe('mergeHeaders', () => {
  test('copies headers from a Request object', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-custom': 'value' },
    })
    const headers = mergeHeaders(request)
    expect(headers.get('x-custom')).toBe('value')
  })

  test('copies headers from init Headers object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: new Headers({ 'x-init': 'from-headers' }),
    })
    expect(headers.get('x-init')).toBe('from-headers')
  })

  test('copies headers from init array', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: [['x-arr', 'from-array']],
    })
    expect(headers.get('x-arr')).toBe('from-array')
  })

  test('copies headers from init plain object', () => {
    const headers = mergeHeaders('https://example.com', {
      headers: { 'x-obj': 'from-object' },
    })
    expect(headers.get('x-obj')).toBe('from-object')
  })

  test('init headers override Request headers', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-key': 'from-request' },
    })
    const headers = mergeHeaders(request, {
      headers: { 'x-key': 'from-init' },
    })
    expect(headers.get('x-key')).toBe('from-init')
  })

  test('handles string input without init', () => {
    const headers = mergeHeaders('https://example.com')
    expect([...headers.entries()]).toHaveLength(0)
  })

  test('handles URL input', () => {
    const headers = mergeHeaders(new URL('https://example.com'))
    expect([...headers.entries()]).toHaveLength(0)
  })
})

describe('mergeBetaHeaders', () => {
  test('includes required betas when no incoming betas', () => {
    const headers = new Headers()
    const result = mergeBetaHeaders(headers)
    expect(result).toBe(REQUIRED_BETAS.join(','))
  })

  test('merges incoming betas with required betas', () => {
    const headers = new Headers({ 'anthropic-beta': 'custom-beta-1' })
    const result = mergeBetaHeaders(headers)

    for (const beta of REQUIRED_BETAS) {
      expect(result).toContain(beta)
    }
    expect(result).toContain('custom-beta-1')
  })

  test('deduplicates betas', () => {
    const beta = REQUIRED_BETAS[0] ?? ''
    const headers = new Headers({
      'anthropic-beta': beta,
    })
    const result = mergeBetaHeaders(headers)
    const parts = result.split(',')
    const occurrences = parts.filter((p) => p === REQUIRED_BETAS[0])
    expect(occurrences).toHaveLength(1)
  })

  test('handles comma-separated incoming betas', () => {
    const headers = new Headers({
      'anthropic-beta': 'beta-a, beta-b',
    })
    const result = mergeBetaHeaders(headers)
    expect(result).toContain('beta-a')
    expect(result).toContain('beta-b')
  })

  test('adds fast mode beta without duplicating existing betas', () => {
    const headers = new Headers({
      'anthropic-beta': `beta-a, ${FAST_MODE_BETA}`,
    })

    addFastModeBetaHeader(headers)

    const parts = headers.get('anthropic-beta')?.split(',') ?? []
    expect(parts).toContain('beta-a')
    expect(parts.filter((part) => part === FAST_MODE_BETA)).toHaveLength(1)
  })
})

describe('setOAuthHeaders', () => {
  test('sets authorization bearer token', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'my-token')
    expect(headers.get('authorization')).toBe('Bearer my-token')
  })

  test('sets user-agent', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('user-agent')).toContain('claude-cli')
  })

  test('removes x-api-key', () => {
    const headers = new Headers({ 'x-api-key': 'dummy-api-key' })
    setOAuthHeaders(headers, 'token')
    expect(headers.get('x-api-key')).toBeNull()
  })

  test('sets anthropic-beta header', () => {
    const headers = new Headers()
    setOAuthHeaders(headers, 'token')
    expect(headers.get('anthropic-beta')).toBeString()
    for (const beta of REQUIRED_BETAS) {
      expect(headers.get('anthropic-beta')).toContain(beta)
    }
  })

  test('adds the server-side fallback beta only for opted-in bodies', () => {
    const enabled = new Headers()
    setOAuthHeaders(enabled, 'token', {
      body: { model: 'claude-fable-5', fallbacks: 'default' },
    })
    expect(enabled.get('anthropic-beta')?.split(',')).toContain(
      SERVER_SIDE_FALLBACK_BETA,
    )

    const disabled = new Headers()
    setOAuthHeaders(disabled, 'token', {
      body: { model: 'claude-fable-5' },
    })
    expect(disabled.get('anthropic-beta')?.split(',')).not.toContain(
      SERVER_SIDE_FALLBACK_BETA,
    )
  })
})

describe('prefixToolNames', () => {
  test('prefixes tool definition names', () => {
    const body = {
      tools: [
        { name: 'read_file', type: 'function' },
        { name: 'write_file', type: 'function' },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBe('mcp_Read_file')
    expect(result.tools[1].name).toBe('mcp_Write_file')
  })

  test('prefixes tool_use block names in messages', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: '1' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0].name).toBe('mcp_Bash')
    expect(result.messages[0].content[1].type).toBe('text')
  })

  test('does not prefix non-tool_use blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'hello',
    })
  })

  test('handles missing tools and messages gracefully', () => {
    const body = { model: 'claude-3' }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.model).toBe('claude-3')
  })

  test('handles tools without names', () => {
    const body = {
      tools: [{ type: 'function' }],
    }
    const result = JSON.parse(prefixToolNames(body))
    expect(result.tools[0].name).toBeUndefined()
  })
})

describe('stripToolPrefix', () => {
  test('strips mcp_ prefix from tool names', () => {
    const text = '{"name": "mcp_read_file"}'
    expect(stripToolPrefix(text)).toBe('{"name": "read_file"}')
  })

  test('strips multiple prefixed names', () => {
    const text = '{"name": "mcp_tool_a"} and {"name": "mcp_tool_b"}'
    const result = stripToolPrefix(text)
    expect(result).toContain('"name": "tool_a"')
    expect(result).toContain('"name": "tool_b"')
  })

  test('does not strip names without mcp_ prefix', () => {
    const text = '{"name": "regular_tool"}'
    expect(stripToolPrefix(text)).toBe(text)
  })

  test('canonicalizes Claude-dropped AFT namespace for prefixed tool names', () => {
    expect(stripToolPrefix('{"name": "mcp_Safety"}')).toBe(
      '{"name": "aft_safety"}',
    )
    expect(stripToolPrefix('{"name": "mcp_Outline"}')).toBe(
      '{"name": "aft_outline"}',
    )
  })

  test('canonicalizes raw AFT suffix tool names', () => {
    expect(stripToolPrefix('{"name": "safety"}')).toBe('{"name": "aft_safety"}')
    expect(stripToolPrefix('{"name": "outline"}')).toBe(
      '{"name": "aft_outline"}',
    )
  })

  test('preserves existing AFT names after stripping mcp prefix', () => {
    expect(stripToolPrefix('{"name": "mcp_Aft_safety"}')).toBe(
      '{"name": "aft_safety"}',
    )
  })

  test('handles whitespace variations in JSON', () => {
    const text = '{"name"  :  "mcp_tool"}'
    expect(stripToolPrefix(text)).toBe('{"name": "tool"}')
  })
})

describe('rewriteUrl', () => {
  const originalEnv = process.env.ANTHROPIC_BASE_URL

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_BASE_URL
    } else {
      process.env.ANTHROPIC_BASE_URL = originalEnv
    }
  })

  test('adds beta=true to /v1/messages URL string', () => {
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('adds beta=true to /v1/messages URL object', () => {
    const { input } = rewriteUrl(
      new URL('https://api.anthropic.com/v1/messages'),
    )
    const url = input instanceof URL ? input : new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('adds beta=true to /v1/messages Request', () => {
    const request = new Request('https://api.anthropic.com/v1/messages')
    const { input } = rewriteUrl(request)
    const url = new URL((input as Request).url)
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('does not modify URL if beta param already exists', () => {
    const original = 'https://api.anthropic.com/v1/messages?beta=false'
    const { input } = rewriteUrl(original)
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('false')
  })

  test('does not modify non-/v1/messages URLs', () => {
    const original = 'https://api.anthropic.com/v1/complete'
    const { input } = rewriteUrl(original)
    const url = new URL(input.toString())
    expect(url.searchParams.has('beta')).toBe(false)
  })

  test('overrides origin when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
  })

  test('applies explicit fallback base URL path before /v1/messages', () => {
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages', {
      baseURL: 'https://api.kie.ai/claude',
    })
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.kie.ai')
    expect(url.pathname).toBe('/claude/v1/messages')
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('preserves beta=true when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.searchParams.get('beta')).toBe('true')
  })

  test('preserves existing query params when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const { input } = rewriteUrl(
      'https://api.anthropic.com/v1/messages?foo=bar',
    )
    const url = new URL(input.toString())
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.searchParams.get('foo')).toBe('bar')
  })

  test('handles ANTHROPIC_BASE_URL with trailing slash', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080/'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.pathname).toBe('/v1/messages')
    expect(url.origin).toBe('http://localhost:8080')
  })

  test('ignores invalid ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'not-a-url'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('ignores empty ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = ''
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('rejects file: scheme in ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'file:///etc/passwd'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('rejects ANTHROPIC_BASE_URL with embedded credentials', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://user:pass@localhost:8080'
    const { input } = rewriteUrl('https://api.anthropic.com/v1/messages')
    const url = new URL(input.toString())
    expect(url.origin).toBe('https://api.anthropic.com')
  })

  test('returns original input when no URL changes are needed', () => {
    const original = 'https://api.anthropic.com/v1/complete'
    const { input } = rewriteUrl(original)
    expect(input).toBe(original)
  })

  test('returns original Request when no URL changes are needed', () => {
    const request = new Request('https://api.anthropic.com/v1/complete')
    const { input } = rewriteUrl(request)
    expect(input).toBe(request)
  })

  test('overrides origin for Request input when ANTHROPIC_BASE_URL is set', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080'
    const request = new Request('https://api.anthropic.com/v1/messages')
    const { input } = rewriteUrl(request)
    const url = new URL((input as Request).url)
    expect(url.origin).toBe('http://localhost:8080')
    expect(url.pathname).toBe('/v1/messages')
  })
})

describe('isInsecure', () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
  const originalInsecure = process.env.ANTHROPIC_INSECURE

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL
    } else {
      process.env.ANTHROPIC_BASE_URL = originalBaseUrl
    }
    if (originalInsecure === undefined) {
      delete process.env.ANTHROPIC_INSECURE
    } else {
      process.env.ANTHROPIC_INSECURE = originalInsecure
    }
  })

  test('returns false when neither env var is set', () => {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_INSECURE
    expect(isInsecure()).toBe(false)
  })

  test('returns false when only ANTHROPIC_INSECURE is set (no base URL)', () => {
    delete process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_INSECURE = '1'
    expect(isInsecure()).toBe(false)
  })

  test('returns false when ANTHROPIC_BASE_URL is set but ANTHROPIC_INSECURE is not', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    delete process.env.ANTHROPIC_INSECURE
    expect(isInsecure()).toBe(false)
  })

  test('returns true when both are set and ANTHROPIC_INSECURE is "1"', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = '1'
    expect(isInsecure()).toBe(true)
  })

  test('returns true when ANTHROPIC_INSECURE is "true"', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = 'true'
    expect(isInsecure()).toBe(true)
  })

  test('returns false for other ANTHROPIC_INSECURE values', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.local'
    process.env.ANTHROPIC_INSECURE = 'yes'
    expect(isInsecure()).toBe(false)
  })
})

describe('createStrippedStream', () => {
  test('strips tool prefixes from streamed response body', async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_bash"}}\n\n',
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read"}}\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })

    const original = new Response(stream, { status: 200 })
    const stripped = createStrippedStream(original)

    const text = await stripped.text()
    expect(text).toContain('"name": "bash"')
    expect(text).toContain('"name": "read"')
    expect(text).not.toContain('mcp_bash')
    expect(text).not.toContain('mcp_read')
  })

  test('strips tool prefixes when name JSON is split across chunks', async () => {
    const chunks = [
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","na',
      'me":"mcp_Read","id":"toolu_1"}}\n\n',
    ]

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })

    const stripped = createStrippedStream(new Response(stream, { status: 200 }))

    const text = await stripped.text()
    expect(text).toContain('"name": "read"')
    expect(text).not.toContain('mcp_Read')
  })

  test('logs structural SSE diagnostics without response text', async () => {
    const sse = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const payload = [
      sse('message_start', {
        type: 'message_start',
        message: { usage: { input_tokens: 10, output_tokens: 0 } },
      }),
      sse('ping', { type: 'ping' }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'secret-thought' },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'secret-output' },
      }),
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"query":"secret-tool-input"}',
        },
      }),
    ].join('')
    const chunks = [
      payload.slice(0, 41),
      payload.slice(41, 143),
      payload.slice(143),
    ]
    const perf: Array<{ stage: string; data: Record<string, unknown> }> = []

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })

    const stripped = createStrippedStream(
      new Response(stream, { status: 200 }),
      {
        perf: (stage, data) => perf.push({ stage, data: data ?? {} }),
      },
    )

    await stripped.text()
    const final = perf.find(
      (entry) => entry.stage === 'stream_tool_prefix_rewrite',
    )?.data
    expect(final).toBeDefined()
    expect(final?.sseEventCounts).toEqual({
      message_start: 1,
      ping: 1,
      content_block_start: 1,
      content_block_delta: 3,
    })
    expect(final?.sseTypeCounts).toEqual({
      message_start: 1,
      ping: 1,
      content_block_start: 1,
      content_block_delta: 3,
    })
    expect(final?.sseDeltaTypeCounts).toEqual({
      thinking_delta: 1,
      text_delta: 1,
      input_json_delta: 1,
    })
    expect(final?.sseContentBlockTypeCounts).toEqual({ thinking: 1 })
    expect(final?.sseThinkingDeltaBytes).toBeGreaterThan(0)
    expect(final?.sseTextDeltaBytes).toBeGreaterThan(0)
    expect(final?.sseInputJsonDeltaBytes).toBeGreaterThan(0)
    expect(JSON.stringify(perf)).not.toContain('secret')
  })

  test('marks Anthropic internal stream errors as retryable connection resets', async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    const perf: Array<{ stage: string; data: Record<string, unknown> }> = []
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Internal server error"}}\n\n',
    ]
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    const stripped = createStrippedStream(
      new Response(stream, { status: 200 }),
      {
        perf: (stage, data) => perf.push({ stage, data: data ?? {} }),
      },
    )
    const reader = stripped.body?.getReader()
    expect(reader).toBeDefined()

    const first = await reader!.read()
    expect(decoder.decode(first.value)).toContain('message_start')

    let caught: unknown
    try {
      await reader!.read()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('ECONNRESET')
    expect((caught as { syscall?: string }).syscall).toBe('anthropic-sse')
    expect((caught as { providerErrorType?: string }).providerErrorType).toBe(
      'api_error',
    )
    expect((caught as Error).message).toContain('Internal server error')
    expect(
      perf.some(
        (entry) => entry.stage === 'stream_tool_prefix_retryable_error',
      ),
    ).toBe(true)
  })

  test('reports server-side fallback outcomes without turning them into retryable errors', async () => {
    const encoder = new TextEncoder()
    const outcomes: ServerSideFallbackOutcome[] = []
    const payload = [
      sse('message_start', {
        type: 'message_start',
        message: { id: 'msg_1', model: 'claude-opus-5' },
      }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-5' },
        },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          output_tokens: 1,
          iterations: [
            { type: 'message', model: 'claude-fable-5' },
            { type: 'fallback_message', model: 'claude-opus-5' },
          ],
        },
      }),
    ].join('')
    const response = createStrippedStream(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(payload.slice(0, 77)))
            controller.enqueue(encoder.encode(payload.slice(77)))
            controller.close()
          },
        }),
      ),
      {
        serverSideFallbackModel: 'claude-fable-5',
        onServerSideFallbackOutcome: (outcome) => outcomes.push(outcome),
      },
    )

    const text = await response.text()
    expect(text).toContain(
      `"signature":"${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-fable-5|claude-opus-5"`,
    )
    expect(text).not.toContain('"content_block":{"type":"fallback"')
    expect(outcomes).toEqual([
      expect.objectContaining({
        requestedModel: 'claude-fable-5',
        servedModel: 'claude-opus-5',
        targetModel: 'claude-opus-5',
        fallback: true,
        handoff: true,
      }),
    ])
  })

  test('preserves a mid-output fallback boundary as a replayable hidden marker', async () => {
    const payload = [
      sse('message_start', {
        type: 'message_start',
        message: { id: 'msg_1', model: 'claude-opus-5' },
      }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-fable-5' },
          to: { model: 'claude-opus-5' },
        },
      }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      }),
    ].join('')
    const response = createStrippedStream(new Response(payload), {
      serverSideFallbackModel: 'claude-fable-5',
    })

    const text = await response.text()
    expect(text).not.toContain('"type":"fallback","from"')
    expect(text).toContain(JSON.stringify(SERVER_FALLBACK_MARKER_TEXT))
    expect(text).toContain(SERVER_FALLBACK_SIGNATURE_PREFIX)
  })

  test('turns Fable refusal finishes into retryable errors and signals once', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_',
      'reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
    ]
    let filtered = 0
    let completed = 0
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const response = createStrippedStream(new Response(stream), {
      onContentFilter: () => {
        filtered++
      },
      onComplete: () => {
        completed++
      },
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)

    let caught: unknown
    try {
      while (!(await reader.read()).done) {}
    } catch (error) {
      caught = error
    }

    expect((caught as { code?: string }).code).toBe('ECONNRESET')
    expect((caught as { providerErrorType?: string }).providerErrorType).toBe(
      'refusal',
    )
    expect(filtered).toBe(1)
    expect(completed).toBe(0)
  })

  test('refusal error message names Opus 5 when contentFilterModel is set', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_',
      'reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
    ]
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const response = createStrippedStream(new Response(stream), {
      onContentFilter: () => true,
      contentFilterModel: 'claude-opus-5',
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)

    let caught: unknown
    try {
      while (!(await reader.read()).done) {}
    } catch (error) {
      caught = error
    }

    expect((caught as { code?: string }).code).toBe('ECONNRESET')
    expect((caught as { providerErrorType?: string }).providerErrorType).toBe(
      'refusal',
    )
    expect((caught as Error).message).toContain('Opus 5')
    expect((caught as Error).message).not.toContain('Fable')
  })

  test('refusal error message uses Fable when contentFilterModel not set', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_',
      'reason":"refusal"},"usage":{"output_tokens":0}}\n\n',
    ]
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    const response = createStrippedStream(new Response(stream), {
      onContentFilter: () => true,
    })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)

    let caught: unknown
    try {
      while (!(await reader.read()).done) {}
    } catch (error) {
      caught = error
    }

    expect((caught as Error).message).toContain('Fable')
  })

  test('signals successful Anthropic finishes exactly once', async () => {
    const finishes: string[] = []
    const response = createStrippedStream(
      new Response(
        [
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join(''),
      ),
      { onComplete: (reason) => finishes.push(reason) },
    )

    await response.text()
    expect(finishes).toEqual(['tool_use'])
  })

  test('does not intercept refusals when no Fable callback is installed', async () => {
    const payload =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'
    const response = createStrippedStream(new Response(payload))
    await expect(response.text()).resolves.toContain('refusal')
  })

  test('preserves a refusal when Fable recovery declines a non-OAuth route', async () => {
    const payload =
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n'
    const response = createStrippedStream(new Response(payload), {
      onContentFilter: () => false,
    })
    await expect(response.text()).resolves.toContain('refusal')
  })

  test('does not mark non-transient Anthropic stream errors retryable', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"Bad request"}}\n\n',
    ]
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    const stripped = createStrippedStream(new Response(stream, { status: 200 }))
    await expect(stripped.text()).resolves.toContain('Bad request')
  })

  test('preserves response status and headers', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })

    const original = new Response(stream, {
      status: 201,
      statusText: 'Created',
      headers: { 'x-custom': 'value' },
    })

    const stripped = createStrippedStream(original)
    expect(stripped.status).toBe(201)
    expect(stripped.headers.get('x-custom')).toBe('value')
  })

  test('returns original response if no body', () => {
    const original = new Response(null, { status: 204 })
    const result = createStrippedStream(original)
    expect(result).toBe(original)
  })
})

describe('prepareFableCacheWarmSource', () => {
  test('restores the Fable model shape from an Opus request without changing its input', () => {
    const source = prepareFableCacheWarmSource(
      JSON.stringify({
        model: 'claude-opus-4-8',
        speed: 'fast',
        thinking: { type: 'enabled', budget_tokens: 4096 },
        output_config: { effort: 'xhigh' },
        system: [
          {
            type: 'text',
            text: 'stable',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [{ role: 'user', content: 'same input' }],
      }),
    )

    expect(source.ok).toBe(true)
    if (!source.ok) throw new Error(source.reason)
    const body = JSON.parse(source.bodyText)
    expect(body.model).toBe('claude-fable-5')
    expect(body.speed).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'xhigh' })
    expect(body.messages).toEqual([{ role: 'user', content: 'same input' }])
  })

  test('restores an Opus 5 request to claude-opus-5 when explicitly requested', () => {
    const source = prepareFableCacheWarmSource(
      JSON.stringify({
        model: 'claude-opus-4-8',
        speed: 'fast',
        thinking: { type: 'enabled', budget_tokens: 4096 },
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'same input' }],
      }),
      'claude-opus-5',
    )

    expect(source.ok).toBe(true)
    if (!source.ok) throw new Error(source.reason)
    const body = JSON.parse(source.bodyText)
    expect(body.model).toBe('claude-opus-5')
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  test('strips the server-side fallback opt-in so the source-model prewarm never triggers Anthropic fallback routing', () => {
    const source = prepareFableCacheWarmSource(
      JSON.stringify({
        model: 'claude-opus-4-8',
        fallbacks: 'default',
        speed: 'fast',
        messages: [{ role: 'user', content: 'same input' }],
      }),
    )

    expect(source.ok).toBe(true)
    if (!source.ok) throw new Error(source.reason)
    const body = JSON.parse(source.bodyText)
    expect(body.fallbacks).toBeUndefined()
    expect(body.speed).toBeUndefined()
    expect(selectClaudeCodeBetas(body).split(',')).not.toContain(
      'server-side-fallback-2026-07-01',
    )
  })
})

describe('sanitizeSystemText', () => {
  // Anchor-based sanitization. Three mechanisms:
  //
  //   1. The OPENCODE_IDENTITY line is always removed.
  //   2. Any paragraph containing a PARAGRAPH_REMOVAL_ANCHORS entry
  //      (e.g. "github.com/anomalyco/opencode", "opencode.ai/docs")
  //      is removed entirely.
  //   3. TEXT_REPLACEMENTS are applied inline for short branded strings
  //      inside paragraphs we want to keep (e.g. "if OpenCode honestly"
  //      → "if the assistant honestly").
  //
  // Everything else — generic instructions, tone/style, task management,
  // tool policy, environment info, skills, user instructions, file paths
  // containing "opencode", etc. — is preserved.

  test('returns text unchanged when OpenCode identity not present', () => {
    const text = 'Just a normal system prompt'
    expect(sanitizeSystemText(text)).toBe(text)
  })

  test('removes identity, keeps generic content', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      You have access to tools for reading files.

      Instructions from: ~/.config/opencode/preamble.md
      Be concise. Prefer TypeScript.

      # Code References
      src/index.ts (1-50)
    `)
    expect(result).toMatchInlineSnapshot(`
      "You have access to tools for reading files.

      Instructions from: ~/.config/opencode/preamble.md
      Be concise. Prefer TypeScript.

      # Code References
      src/index.ts (1-50)"
    `)
  })

  test('removes paragraph containing feedback URL anchor', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Report issues at https://github.com/anomalyco/opencode please.

      Generic instructions that stay.
    `)
    expect(result).toMatchInlineSnapshot(`"Generic instructions that stay."`)
  })

  test('removes paragraph containing docs URL anchor', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Check out the docs at https://opencode.ai/docs for more info.

      Other content preserved.
    `)
    expect(result).toMatchInlineSnapshot(`"Other content preserved."`)
  })

  test('applies inline text replacement', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      It is best if OpenCode honestly applies rigorous standards.
    `)
    expect(result).toMatchInlineSnapshot(
      `"It is best if the assistant honestly applies rigorous standards."`,
    )
  })

  test('preserves "opencode" in file paths and unrelated content', () => {
    const result = sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Instructions from: /Users/user/project/.opencode/AGENTS.md
      Run opencode to start the CLI.
    `)
    expect(result).toMatchInlineSnapshot(`
      "Instructions from: /Users/user/project/.opencode/AGENTS.md
      Run opencode to start the CLI."
    `)
  })

  test('preserves content before and after identity', () => {
    const result = sanitizeSystemText(dedent`
      Some prefix content

      You are OpenCode, the best coding agent on the planet.

      # Code References
      file contents
    `)
    expect(result).toMatchInlineSnapshot(`
      "Some prefix content

      # Code References
      file contents"
    `)
  })

  test('does not call onError when identity is present and removed', () => {
    const onError = mock(() => {})
    sanitizeSystemText(dedent`
      You are OpenCode, the best coding agent on the planet.

      Normal content.
    `)
    expect(onError).not.toHaveBeenCalled()
  })

  test('memoised output equals a fresh sanitation and is stable on repeat', () => {
    const text = dedent`
      You are OpenCode, an AI assistant.

      Keep this paragraph intact.
    `
    const first = sanitizeSystemText(text)
    const second = sanitizeSystemText(text)
    expect(second).toBe(first)
    // identity-bearing paragraph is still stripped (behaviour unchanged)
    expect(first).not.toContain(OPENCODE_IDENTITY_PREFIX)
  })

  test('getSanitizeMemoStats records a hit on identical repeat input', () => {
    // Force the memo on regardless of the ambient OPENCODE_ANTHROPIC_AUTH_MEMO
    // env (baseline test runs may export =0, which would disable caching).
    const prev = process.env.OPENCODE_ANTHROPIC_AUTH_MEMO
    process.env.OPENCODE_ANTHROPIC_AUTH_MEMO = '1'
    try {
      const before = getSanitizeMemoStats()
      const text = `unique-memo-probe-${Date.now()}`
      sanitizeSystemText(text)
      sanitizeSystemText(text)
      const after = getSanitizeMemoStats()
      expect(after.hits - before.hits).toBeGreaterThanOrEqual(1)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_ANTHROPIC_AUTH_MEMO
      else process.env.OPENCODE_ANTHROPIC_AUTH_MEMO = prev
    }
  })
})

describe('prependClaudeCodeIdentity', () => {
  test('returns identity block for undefined system', () => {
    const result = prependClaudeCodeIdentity(undefined)
    expect(result).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('sanitizes and prepends for string system', () => {
    const result = prependClaudeCodeIdentity('Some assistant prompt')
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).toBe('Some assistant prompt')
  })

  test('sanitizes array of text blocks', () => {
    const system = [
      {
        type: 'text',
        text: `${OPENCODE_IDENTITY_PREFIX}\nstuff\n\n# Code References\nrest`,
      },
      { type: 'text', text: 'other block' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]?.text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result[1]?.text).toContain('# Code References')
  })

  test('does not double-prepend if identity already present', () => {
    const system = [
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'other' },
    ]
    const result = prependClaudeCodeIdentity(system)
    expect(result).toHaveLength(2)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('handles string elements in array', () => {
    const system = ['some text', 'more text']
    const result = prependClaudeCodeIdentity(system)
    expect(result[0]?.text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result[1]).toEqual({ type: 'text', text: 'some text' })
  })
})

describe('rewriteRequestBody', () => {
  test('prefixes tool names and rewrites system prompt', async () => {
    const body = JSON.stringify({
      tools: [{ name: 'bash', type: 'function' }],
      messages: [{ role: 'user', content: 'hello world test message' }],
      system: 'You are a helpful assistant.',
    })
    const result = JSON.parse(await rewriteRequestBody(body))
    expect(result.tools[0].name).toBe('mcp_Bash')
    // system[0] = billing header, system[1] = identity, system[2] = rest
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('You are a helpful assistant.')
  })

  test('handles missing system field', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(await rewriteRequestBody(body))
    // system[0] = billing header, system[1] = identity (no rest block)
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('sets fast speed for supported Opus models when fast mode is enabled', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, { fastModeEnabled: true }),
    )

    expect(result.speed).toBe('fast')
  })

  test('sets fast speed for Opus 5 when fast mode is enabled', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, { fastModeEnabled: true }),
    )

    expect(result.speed).toBe('fast')
  })

  test('does not set fast speed for unsupported models', async () => {
    for (const model of ['claude-sonnet-4-5', 'claude-fable-5']) {
      const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
      })

      const result = JSON.parse(
        await rewriteRequestBody(body, { fastModeEnabled: true }),
      )

      expect(result.speed).toBeUndefined()
    }
  })

  test('requests summarized adaptive thinking for Fable requests', async () => {
    const body = JSON.stringify({
      model: 'claude-fable-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'xhigh' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(result.output_config).toEqual({ effort: 'xhigh' })
  })

  test('requests summarized adaptive thinking for Sonnet 5 without thinking', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  test('replaces manual enabled thinking with adaptive summarized for Sonnet 5', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-5-20260630',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 10_000 },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(result.thinking.budget_tokens).toBeUndefined()
  })

  test('preserves explicitly disabled thinking for Sonnet 5', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
  })

  test('strips display from disabled thinking for Sonnet 5', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled', display: 'summarized' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
  })

  test('does not touch thinking for non-Sonnet5 models', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 5_000 },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 5_000 })
  })

  test('opts recoverable OAuth models into Anthropic server-side fallback', async () => {
    for (const model of ['claude-fable-5', 'claude-opus-5']) {
      const result = JSON.parse(
        await rewriteRequestBody(
          JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          { serverSideFallbackEnabled: true },
        ),
      )
      expect(result.fallbacks).toBe('default')
    }
  })

  test('restores hidden fallback boundaries before signing replay requests', async () => {
    const result = JSON.parse(
      await rewriteRequestBody(
        JSON.stringify({
          model: 'claude-fable-5',
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'partial' },
                {
                  type: 'thinking',
                  thinking: SERVER_FALLBACK_MARKER_TEXT,
                  signature: `${SERVER_FALLBACK_SIGNATURE_PREFIX}claude-fable-5|claude-opus-5`,
                },
                { type: 'text', text: 'continued' },
              ],
            },
            { role: 'user', content: 'continue' },
          ],
        }),
        { serverSideFallbackEnabled: true },
      ),
    )

    expect(result.messages[0].content[1]).toEqual({
      type: 'fallback',
      from: { model: 'claude-fable-5' },
      to: { model: 'claude-opus-5' },
    })
  })

  test('requests summarized adaptive thinking for Opus 5 without thinking', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  test('replaces manual enabled thinking with adaptive summarized for Opus 5', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5-20260701',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 10_000 },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(result.thinking.budget_tokens).toBeUndefined()
  })

  test('preserves explicitly disabled thinking for Opus 5', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
  })

  test('strips display from disabled thinking for Opus 5', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled', display: 'summarized' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
  })

  test('lowers Opus 5 disabled thinking + effort xhigh to effort high', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'xhigh' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
    expect(result.output_config).toEqual({ effort: 'high' })
  })

  test('lowers Opus 5 disabled thinking + effort max to effort high', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'max' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
    expect(result.output_config).toEqual({ effort: 'high' })
  })

  test('leaves Opus 5 disabled thinking effort untouched at high or below', async () => {
    for (const effort of ['high', 'medium', 'low']) {
      const body = JSON.stringify({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'disabled' },
        output_config: { effort },
      })

      const result = JSON.parse(await rewriteRequestBody(body))

      expect(result.thinking).toEqual({ type: 'disabled' })
      expect(result.output_config).toEqual({ effort })
    }
  })

  test('preserves Opus 5 adaptive thinking effort at xhigh (no lower applied)', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'xhigh' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(result.output_config).toEqual({ effort: 'xhigh' })
  })

  test('does not touch thinking for non-Opus5 models', async () => {
    const body = JSON.stringify({
      model: 'claude-fable-5',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 5_000 },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  test('downgraded Opus 5 recovery body keeps Opus 4.8 thinking semantics (no Opus 5 injection)', async () => {
    // After fable-fallback rewrites the body to claude-opus-4-8, the Opus 5
    // normalizer must NOT fire — the predicted 4.8 body should preserve the
    // user's manual thinking settings (they would have been valid for 4.8
    // before the recovery started; only the model id changed).
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 8_000 },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'enabled', budget_tokens: 8_000 })
  })

  test('downgraded Opus 5 recovery with disabled+xhigh preserves thinking and effort (normalizer bypass)', async () => {
    // After recovery rewrites model→claude-opus-4-8, the Opus 5 normalizer
    // must NOT fire. A disabled+xhigh pair is invalid for Opus 5 (400) but
    // perfectly valid for 4.8 (where thinking is not adaptive-by-default
    // and no effort constraint exists). The normalizer must only match
    // actual Opus 5 bodies — not recovered 4.8 bodies that carry the
    // user's original settings.
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'xhigh' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
    expect(result.output_config).toEqual({ effort: 'xhigh' })
  })

  test('downgraded Opus 5 recovery with disabled+max preserves thinking and effort (normalizer bypass)', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'disabled' },
      output_config: { effort: 'max' },
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.thinking).toEqual({ type: 'disabled' })
    expect(result.output_config).toEqual({ effort: 'max' })
  })

  test('strips OpenAI encrypted reasoning blocks before sending to Anthropic', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'gpt reasoning summary',
              signature: JSON.stringify({
                id: 'rs_0020061038ec397b016a2aa86b9e9881968a52480521e392de',
                type: 'reasoning',
                content: [],
                encrypted_content: 'gAAAAABqKqhtOpenAIEncryptedReasoningState',
                summary: [
                  { type: 'summary_text', text: 'gpt reasoning summary' },
                ],
              }),
            },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(
      result.messages.map((message: { role: string }) => message.role),
    ).toEqual(['user', 'user'])
    expect(JSON.stringify(result.messages)).not.toContain('gAAAAABqKqht')
    expect(JSON.stringify(result.messages)).not.toContain(
      'gpt reasoning summary',
    )
  })

  test('preserves Claude signed thinking blocks', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'claude thinking',
              signature: 'CAIS5AMKvalid',
            },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.messages[1].content[0]).toEqual({
      type: 'thinking',
      thinking: 'claude thinking',
      signature: 'CAIS5AMKvalid',
    })
    expect(result.messages[1].content[1]).toEqual({
      type: 'text',
      text: 'answer',
    })
  })

  test('removes only OpenAI encrypted thinking from mixed assistant content', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'first' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'gpt reasoning summary',
              signature: JSON.stringify({
                id: 'rs_0020061038ec397b016a2aa86b9e9881968a52480521e392de',
                type: 'reasoning',
                content: [],
                encrypted_content: 'gAAAAABqKqhtOpenAIEncryptedReasoningState',
                summary: [
                  { type: 'summary_text', text: 'gpt reasoning summary' },
                ],
              }),
            },
            { type: 'text', text: 'visible answer' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.messages[1].content).toEqual([
      { type: 'text', text: 'visible answer' },
    ])
  })

  test('removes existing fast speed when fast mode is disabled', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-7',
      speed: 'fast',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.speed).toBeUndefined()
  })

  test('returns original string on invalid JSON', async () => {
    const body = 'not valid json'
    expect(await rewriteRequestBody(body)).toBe(body)
  })

  test('does not call onError when identity is present (rules always match)', async () => {
    const onError = mock(() => {})
    const body = JSON.stringify({
      messages: [],
      system: `${OPENCODE_IDENTITY_PREFIX}\nsome other content`,
    })
    await rewriteRequestBody(body)
    expect(onError).not.toHaveBeenCalled()
  })

  test('rewrites realistic OpenCode request end-to-end', async () => {
    //  Input system prompt (array of blocks):
    //    [0] "You are OpenCode..." + generic content + "# Code References\n..."
    //    [1] "Additional context block"
    //
    //  Expected output (three-block layout):
    //    system[0] = billing header
    //    system[1] = identity
    //    system[2..n] = sanitized system blocks
    //    User messages are untouched.

    const systemPrompt = [
      'You are OpenCode, the best coding agent on the planet.',
      '',
      'You have access to tools.',
      '',
      '# Code References',
      '',
      'Here are some files.',
    ].join('\n')

    const body = JSON.stringify({
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read_file', type: 'function' },
      ],
      messages: [
        { role: 'user', content: 'Help me fix this bug' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'bash', id: 'tool_1' },
            { type: 'text', text: 'Let me check' },
          ],
        },
        { role: 'user', content: 'Thanks' },
      ],
      system: [
        { type: 'text', text: systemPrompt },
        { type: 'text', text: 'Additional context block' },
      ],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    // Three-block layout: billing header, identity, sanitized blocks
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toContain('You have access to tools.')
    expect(result.system[2].text).toContain('# Code References')
    expect(result.system[2].text).not.toContain(OPENCODE_IDENTITY_PREFIX)
    expect(result.system[3].text).toBe('Additional context block')

    // User messages are untouched
    expect(result.messages[0].content).toBe('Help me fix this bug')
    expect(result.messages[1].content[0].name).toBe('mcp_Bash')
    expect(result.messages[2].content).toBe('Thanks')
  })

  test('handles body with no messages array', async () => {
    const body = JSON.stringify({ model: 'claude-3' })
    const result = JSON.parse(await rewriteRequestBody(body))
    // No messages → no billing header; system[0] = identity only
    expect(result.system).toHaveLength(1)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
  })

  test('keeps system blocks in system[] (string content)', async () => {
    const body = JSON.stringify({
      system: 'Custom instructions for the assistant.',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const result = JSON.parse(await rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2] = rest
    expect(result.system).toHaveLength(3)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('Custom instructions for the assistant.')

    // User message is untouched
    expect(result.messages[0].content).toBe('hello')
  })

  test('keeps system blocks in system[] (array content)', async () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'Block A instructions' },
        { type: 'text', text: 'Block B instructions' },
      ],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2..3] = rest
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('Block A instructions')
    expect(result.system[3].text).toBe('Block B instructions')

    // User message is untouched
    expect(result.messages[0].content).toHaveLength(1)
    expect(result.messages[0].content[0].text).toBe('hello')
  })

  test('keeps system intact when no user messages exist', async () => {
    const body = JSON.stringify({
      system: 'Some instructions',
      messages: [],
    })
    const result = JSON.parse(await rewriteRequestBody(body))

    // No user messages → no billing header; system[0] = identity, system[1] = rest
    expect(result.system).toHaveLength(2)
    expect(result.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[1].text).toBe('Some instructions')
  })

  test('keeps multiple system blocks as separate entries', async () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'First block' },
        { type: 'text', text: 'Second block' },
        { type: 'text', text: 'Third block' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const result = JSON.parse(await rewriteRequestBody(body))

    // system[0] = billing, system[1] = identity, system[2..4] = original blocks
    expect(result.system).toHaveLength(5)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('First block')
    expect(result.system[3].text).toBe('Second block')
    expect(result.system[4].text).toBe('Third block')

    // User message is untouched
    expect(result.messages[0].content).toBe('hi')
  })

  test('explicit mode adds 1h ttl to existing ephemeral cache controls when enabled', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'Cached system block',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, { cache1hEnabled: true }),
    )

    expect(result.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('removes 1h ttl from existing ephemeral cache controls when disabled', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'Cached system block',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'hello',
              cacheControl: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
      ],
    })

    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.system[2].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.messages[0].content[0].cacheControl).toEqual({
      type: 'ephemeral',
    })
  })

  test('does not invent cache controls when OpenCode did not create them', async () => {
    const body = JSON.stringify({
      system: 'Custom instructions',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, { cache1hEnabled: true }),
    )

    expect(result.system[0].cache_control).toBeUndefined()
    expect(result.system[1].cache_control).toBeUndefined()
    expect(result.system[2].cache_control).toBeUndefined()
    expect(result.messages[0].cache_control).toBeUndefined()
  })

  test('automatic mode strips block cache controls and adds top-level 1h cache control', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'Cached system block',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Magic Context history',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Recent assistant response',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'follow up' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'automatic',
      }),
    )

    expect(result.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(result.system[2].cache_control).toBeUndefined()
    expect(result.messages[0].content[0].cache_control).toBeUndefined()
    expect(result.messages[1].content[0].cache_control).toBeUndefined()
  })

  test('hybrid mode coalesces split plugin system tail before anchoring system cache', async () => {
    const body = JSON.stringify({
      system: [
        { type: 'text', text: 'Primary system prompt' },
        {
          type: 'text',
          text: '<use_parallel_tool_calls>parallel</use_parallel_tool_calls>',
        },
        { type: 'text', text: '## Magic Context\nmagic' },
        { type: 'text', text: '## IMPORTANT NOTICE about your tools\ntools' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toContain('x-anthropic-billing-header')
    expect(result.system[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(result.system[2].text).toBe('Primary system prompt')
    expect(result.system[2].cache_control).toBeUndefined()
    expect(result.system[3].text).toBe(
      '<use_parallel_tool_calls>parallel</use_parallel_tool_calls>\n## Magic Context\nmagic\n## IMPORTANT NOTICE about your tools\ntools',
    )
    expect(result.system[3].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('hybrid mode keeps system, messages[0], and messages[1] explicit breakpoints', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'Original system block',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: 'Permanent Magic Context history',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Volatile Magic Context history',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.cache_control).toBeUndefined()
    expect(result.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content).toEqual([
      {
        type: 'text',
        text: 'Permanent Magic Context history',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ])
    expect(result.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('hybrid mode splits first-message cache anchors when Magic Context m0 and m1 merge into content blocks', async () => {
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'large stable m0 history' },
            { type: 'text', text: 'volatile m1 history' },
          ],
        },
        { role: 'assistant', content: 'first real assistant turn' },
        { role: 'user', content: 'latest user boundary' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content[1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[1].content[0].cache_control).toBeUndefined()
    expect(result.messages[2].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('hybrid mode anchors the second merged Magic Context prefix block, not the live tail', async () => {
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<project-docs>stable project docs</project-docs>',
            },
            {
              type: 'text',
              text: '<session-history-since>recent session history</session-history-since>',
            },
            { type: 'text', text: 'current user turn' },
            {
              type: 'text',
              text: '[truncated tool output]',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'assistant', content: 'assistant response' },
        { role: 'user', content: 'latest user boundary' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content[1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content[2].cache_control).toBeUndefined()
    expect(result.messages[0].content[3].cache_control).toBeUndefined()
    expect(result.messages[2].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('hybrid mode does not duplicate the moving marker when the latest user boundary is messages[1]', async () => {
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        { role: 'user', content: 'message 0' },
        { role: 'user', content: 'message 1' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('hybrid mode adds a moving marker at the latest user boundary', async () => {
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        { role: 'user', content: 'message 0' },
        { role: 'assistant', content: 'message 1' },
        { role: 'user', content: 'message 2' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[2].content).toEqual([
      {
        type: 'text',
        text: 'message 2',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ])
  })

  test('hybrid mode keeps the system anchor when the latest user boundary is within lookback', async () => {
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        { role: 'user', content: 'message 0' },
        { role: 'user', content: 'message 1' },
        { role: 'user', content: 'previous user boundary' },
        {
          role: 'assistant',
          content: Array.from({ length: 17 }, (_, index) => ({
            type: 'text',
            text: `assistant block ${index}`,
          })),
        },
        { role: 'user', content: 'latest user boundary' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[2].content).toBe('previous user boundary')
    expect(result.messages[4].content).toEqual([
      {
        type: 'text',
        text: 'latest user boundary',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ])
  })

  test('hybrid mode bridges tool-heavy steps that exceed Anthropic lookback', async () => {
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        { role: 'user', content: 'message 0' },
        { role: 'user', content: 'message 1' },
        { role: 'user', content: 'previous user boundary' },
        {
          role: 'assistant',
          content: Array.from({ length: 19 }, (_, index) => ({
            type: 'tool_use',
            id: `tool_${index}`,
            name: 'Read',
            input: { filePath: `file-${index}.ts` },
          })),
        },
        { role: 'user', content: 'latest user boundary' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.system[2].cache_control).toBeUndefined()
    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[2].content).toEqual([
      {
        type: 'text',
        text: 'previous user boundary',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ])
    expect(
      result.messages[3].content.some(
        (block: { cache_control?: unknown }) => block.cache_control,
      ),
    ).toBe(false)
    expect(result.messages[4].content).toEqual([
      {
        type: 'text',
        text: 'latest user boundary',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ])
  })

  test('hybrid mode restores a model-specific standby anchor beyond lookback', async () => {
    const baseMessages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'permanent Magic Context history' },
          { type: 'text', text: 'volatile Magic Context history' },
        ],
      },
      { role: 'assistant', content: 'first assistant turn' },
      { role: 'user', content: 'last Opus user boundary' },
    ]
    const cachedOpusBody = await rewriteRequestBody(
      JSON.stringify({
        model: 'claude-opus-4-8',
        system: 'Stable system block',
        messages: baseMessages,
      }),
      { cache1hEnabled: true, cache1hMode: 'hybrid' },
    )
    const standbyAnchor = extractLatestHybridMessageCacheAnchor(cachedOpusBody)
    expect(standbyAnchor).toMatchObject({ messageIndex: 2, messageCount: 3 })

    const messages = [...baseMessages]
    for (let index = 0; index < 11; index++) {
      messages.push(
        { role: 'assistant', content: `Fable response ${index}` },
        { role: 'user', content: `Fable follow-up ${index}` },
      )
    }
    const cacheEvents: Array<Record<string, unknown> | undefined> = []
    const result = JSON.parse(
      await rewriteRequestBody(
        JSON.stringify({
          model: 'claude-opus-4-8',
          system: 'Stable system block',
          messages,
        }),
        {
          cache1hEnabled: true,
          cache1hMode: 'hybrid',
          hybridStandbyAnchor: standbyAnchor,
          perf: (stage, data) => {
            if (stage === 'cache_strategy') cacheEvents.push(data)
          },
        },
      ),
    )

    expect(cacheEvents).toEqual([
      expect.objectContaining({
        standbyAnchorMatched: true,
        standbyBridgeApplied: true,
        standbyBridgeMessageIndex: 2,
        standbyDistanceBlocks: 23,
      }),
    ])
    expect(result.system[2].cache_control).toBeUndefined()
    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content[1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[2].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages.at(-3).content[0].cache_control).toBeUndefined()
    expect(result.messages.at(-1).content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('hybrid standby anchors rely on normal lookback while still nearby', async () => {
    const messages = [
      { role: 'user', content: 'message 0' },
      { role: 'user', content: 'message 1' },
      { role: 'user', content: 'last Opus user boundary' },
    ]
    const cachedOpusBody = await rewriteRequestBody(
      JSON.stringify({
        model: 'claude-opus-4-8',
        system: 'Stable system block',
        messages,
      }),
      { cache1hEnabled: true, cache1hMode: 'hybrid' },
    )
    const standbyAnchor = extractLatestHybridMessageCacheAnchor(cachedOpusBody)
    messages.push(
      { role: 'assistant', content: 'one Fable response' },
      { role: 'user', content: 'one Fable follow-up' },
    )

    const result = JSON.parse(
      await rewriteRequestBody(
        JSON.stringify({
          model: 'claude-opus-4-8',
          system: 'Stable system block',
          messages,
        }),
        {
          cache1hEnabled: true,
          cache1hMode: 'hybrid',
          hybridStandbyAnchor: standbyAnchor,
        },
      ),
    )

    expect(result.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[2].content).toBe('last Opus user boundary')
    expect(result.messages[4].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('hybrid mode preserves only the last original system cache anchor after billing and identity blocks', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'Original system block',
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: 'Magic Context instructions',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: 'Magic Context history carrier' },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Recent assistant response',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'follow up' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    expect(result.system[0].cache_control).toBeUndefined()
    expect(result.system[1].cache_control).toBeUndefined()
    expect(result.system[2].cache_control).toBeUndefined()
    expect(result.system[3].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[0].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(result.messages[1].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  // -----------------------------------------------------------------------
  // Prefill stripping — trailing assistant messages
  // -----------------------------------------------------------------------

  test('strips single trailing assistant message', async () => {
    const body = JSON.stringify({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'I will help' }] },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))
    expect(result.messages.length).toBe(1)
    expect(result.messages[0].role).toBe('user')
  })

  test('strips multiple trailing assistant messages', async () => {
    const body = JSON.stringify({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))
    expect(result.messages.length).toBe(1)
    expect(result.messages[0].role).toBe('user')
  })

  test('preserves assistant message followed by user message', async () => {
    const body = JSON.stringify({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
        { role: 'user', content: 'follow up' },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))
    expect(result.messages.length).toBe(3)
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[1].role).toBe('assistant')
    expect(result.messages[2].role).toBe('user')
  })

  test('preserves assistant tool_use followed by user tool_result', async () => {
    const body = JSON.stringify({
      system: 'sys',
      messages: [
        { role: 'user', content: 'do something' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'output' },
          ],
        },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))
    expect(result.messages.length).toBe(3)
    expect(result.messages[1].role).toBe('assistant')
    expect(result.messages[2].role).toBe('user')
  })

  test('strips trailing whitespace after the latest assistant tool_use turn', async () => {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      system: 'sys',
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} },
            { type: 'text', text: ' ' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'one' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_2', name: 'Bash', input: {} },
            { type: 'text', text: 'Checking another result.' },
            { type: 'tool_use', id: 'tool_3', name: 'Bash', input: {} },
            { type: 'text', text: ' \n' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_2', content: 'two' },
            { type: 'tool_result', tool_use_id: 'tool_3', content: 'three' },
          ],
        },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.messages[1].content.at(-1)).toEqual({
      type: 'text',
      text: ' ',
    })
    expect(result.messages[3].content).toEqual([
      { type: 'tool_use', id: 'tool_2', name: 'mcp_Bash', input: {} },
      { type: 'text', text: 'Checking another result.' },
      { type: 'tool_use', id: 'tool_3', name: 'mcp_Bash', input: {} },
    ])
  })

  test('preserves meaningful text after the latest assistant tool_use turn', async () => {
    const body = JSON.stringify({
      system: 'sys',
      messages: [
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} },
            { type: 'text', text: 'Waiting for this result.' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'done' },
          ],
        },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))

    expect(result.messages[1].content.at(-1)).toEqual({
      type: 'text',
      text: 'Waiting for this result.',
    })
  })

  test('strips trailing assistant after tool_result + assistant', async () => {
    const body = JSON.stringify({
      system: 'sys',
      messages: [
        { role: 'user', content: 'do something' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'output' },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'based on that output...' }],
        },
      ],
    })
    const result = JSON.parse(await rewriteRequestBody(body))
    expect(result.messages.length).toBe(3)
    expect(result.messages[2].role).toBe('user')
  })

  test('hybrid mode never sets cache_control on the message object when the n-2 anchor has no cacheable block', async () => {
    // Reproduces "messages.N.cache_control: Extra inputs are not permitted".
    // The moving anchor (messages[n-2]) lands on a message whose content has no
    // cacheable block (empty content array). cache_control must NOT be attached
    // to the message object itself — Anthropic only allows it on content blocks.
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: [] },
        { role: 'assistant', content: 'last' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    // The empty n-2 message must remain free of a message-level cache_control.
    expect(result.messages[2].cache_control).toBeUndefined()
    expect(result.messages[2].cacheControl).toBeUndefined()

    // No message in the request may carry a message-level cache_control.
    for (const message of result.messages) {
      expect(message.cache_control).toBeUndefined()
      expect(message.cacheControl).toBeUndefined()
    }
  })

  test('hybrid mode anchors on the last non-thinking block, never the message object', async () => {
    // messages[1] is always an anchor slot in hybrid mode. Give it mixed
    // content ending in a thinking block: the anchor must land on the text
    // block, never the trailing thinking block and never the message object.
    const body = JSON.stringify({
      system: 'Stable system block',
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reasoning preface' },
            { type: 'thinking', thinking: 'internal', signature: 'sig' },
          ],
        },
        { role: 'user', content: 'last' },
      ],
    })

    const result = JSON.parse(
      await rewriteRequestBody(body, {
        cache1hEnabled: true,
        cache1hMode: 'hybrid',
      }),
    )

    // Anchor goes on the text block, not the message and not the thinking block.
    expect(result.messages[1].cache_control).toBeUndefined()
    const blocks = result.messages[1].content
    const cachedBlocks = blocks.filter(
      (block: { cache_control?: unknown }) => block.cache_control != null,
    )
    expect(cachedBlocks).toHaveLength(1)
    expect(cachedBlocks[0].type).toBe('text')
  })
})

// ---------------------------------------------------------------------------
// Realistic prompt – snapshot tests
// ---------------------------------------------------------------------------

import { REALISTIC_SYSTEM_PROMPT } from './fixtures/realistic-system-prompt'

describe('sanitizeSystemText – realistic prompt', () => {
  test('sanitizeSystemText output snapshot', () => {
    const result = sanitizeSystemText(REALISTIC_SYSTEM_PROMPT)
    expect(result).toMatchSnapshot()
  })

  test('rewriteRequestBody output snapshot', async () => {
    const body = JSON.stringify({
      system: REALISTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        { name: 'bash', type: 'function' },
        { name: 'read', type: 'function' },
        { name: 'edit', type: 'function' },
      ],
    })
    const result = await rewriteRequestBody(body)
    const parsed = JSON.parse(result)
    parsed.system[0].text = parsed.system[0].text.replace(
      /cc_version=[^;]+; cc_entrypoint=cli; cch=[0-9a-f]{5};/,
      'cc_version=<daily>; cc_entrypoint=cli; cch=<signed>;',
    )
    expect(parsed).toMatchSnapshot()
  })
})
