import { describe, expect, test } from 'bun:test'
import { computeCcVersionSuffix } from '@cortexkit/anthropic-auth-core'
import type { Message } from '@earendil-works/pi-ai'
import { buildAnthropicRequest } from '../convert'

function userMsg(text: string): Message {
  return { role: 'user', content: text, timestamp: 0 }
}

function assistantMsg(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as Message
}

function toolCallMsg(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    timestamp: 0,
  } as Message
}

function toolResultMsg(toolCallId: string, text: string): Message {
  return {
    role: 'toolResult',
    toolCallId,
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as Message
}

const defaultCache = { enabled: false, mode: 'hybrid' as const }
const TEST_MODEL_ID = 'claude-sonnet-4-20250514'

// Mirrors the shape of Pi's real prompt: instruction paragraphs followed by the
// documentation paragraph, which is the only part Anthropic rejects in system[].
const PI_PROMPT = [
  'KEEP ONE: you are an assistant.',
  'KEEP TWO: available tools.',
  'Pi documentation (read only when the user asks about pi itself):\n- MOVE THIS',
].join('\n\n')

// systemPrompt is opt-in. buildAnthropicRequest splits a non-empty prompt between
// system[] and the first user message, so tests that assert raw conversion output
// pass no prompt and observe messages unchanged. The split itself is covered by
// the "Claude Code system[] shape" block below.
async function buildMessages(
  messages: Message[],
  systemPrompt?: string,
  modelId = TEST_MODEL_ID,
) {
  const context = {
    messages,
    systemPrompt,
    tools: [],
  }
  const { body } = await buildAnthropicRequest(
    modelId,
    context as any,
    undefined,
    defaultCache,
  )
  return body.messages
}

describe('buildAnthropicRequest — prefill stripping', () => {
  test('strips single trailing assistant message', async () => {
    const messages = await buildMessages([
      userMsg('hello'),
      assistantMsg('I will help'),
    ])
    expect(messages.length).toBe(1)
    expect(messages[0]?.role).toBe('user')
  })

  test('strips multiple trailing assistant messages', async () => {
    const messages = await buildMessages([
      userMsg('hello'),
      assistantMsg('first'),
      assistantMsg('second'),
    ])
    expect(messages.length).toBe(1)
    expect(messages[0]?.role).toBe('user')
  })

  test('preserves assistant message followed by user message', async () => {
    const messages = await buildMessages([
      userMsg('hello'),
      assistantMsg('response'),
      userMsg('follow up'),
    ])
    expect(messages.length).toBe(3)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[2]?.role).toBe('user')
  })

  test('preserves assistant with tool_use followed by tool_result', async () => {
    const messages = await buildMessages([
      userMsg('do something'),
      toolCallMsg('tool_1', 'Bash'),
      toolResultMsg('tool_1', 'output'),
    ])
    expect(messages.length).toBe(3)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[2]?.role).toBe('user') // tool_result maps to user role
  })

  test('strips trailing assistant after tool_result + assistant', async () => {
    const messages = await buildMessages([
      userMsg('do something'),
      toolCallMsg('tool_1', 'Bash'),
      toolResultMsg('tool_1', 'output'),
      assistantMsg('based on that output...'),
    ])
    expect(messages.length).toBe(3)
    expect(messages[2]?.role).toBe('user')
  })

  test('handles user-only conversation', async () => {
    const messages = await buildMessages([userMsg('hello')])
    expect(messages.length).toBe(1)
    expect(messages[0]?.role).toBe('user')
  })

  test('handles empty messages array', async () => {
    const messages = await buildMessages([])
    expect(messages.length).toBe(0)
  })

  test('strips all-assistant conversation to empty', async () => {
    const messages = await buildMessages([
      assistantMsg('first'),
      assistantMsg('second'),
    ])
    expect(messages.length).toBe(0)
  })
})

describe('convertMessages — basic transforms', () => {
  test('converts user text message', async () => {
    const messages = await buildMessages([userMsg('hello world')])
    expect(messages.length).toBe(1)
    expect(messages[0]).toEqual({ role: 'user', content: 'hello world' })
  })

  test('skips empty user messages', async () => {
    const messages = await buildMessages([userMsg(''), userMsg('real message')])
    expect(messages.length).toBe(1)
    expect(messages[0]).toEqual({ role: 'user', content: 'real message' })
  })

  test('converts assistant text blocks', async () => {
    const messages = await buildMessages([
      userMsg('hi'),
      assistantMsg('hello back'),
      userMsg('thanks'),
    ])
    expect(messages[1]?.role).toBe('assistant')
    const content = messages[1]?.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'text', text: 'hello back' })
  })

  test('converts tool_use and tool_result round-trip', async () => {
    const messages = await buildMessages([
      userMsg('run ls'),
      toolCallMsg('call_1', 'Bash'),
      toolResultMsg('call_1', 'file1.txt'),
      userMsg('thanks'),
    ])
    expect(messages.length).toBe(4)

    // assistant with tool_use
    const assistantContent = messages[1]?.content as Array<
      Record<string, unknown>
    >
    expect(assistantContent[0]?.type).toBe('tool_use')
    expect(assistantContent[0]?.name).toBe('Bash')

    // tool_result mapped to user role
    const toolContent = messages[2]?.content as Array<Record<string, unknown>>
    expect(toolContent[0]?.type).toBe('tool_result')
    expect(toolContent[0]?.tool_use_id).toBe('call_1')
  })

  test('drops interrupted assistant tool_use without an immediate tool_result', async () => {
    const messages = await buildMessages([
      userMsg('run ls'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will run a command.' },
          {
            type: 'toolCall',
            id: 'toolu_aborted',
            name: 'Bash',
            arguments: {},
          },
        ],
        stopReason: 'aborted',
        timestamp: 0,
      } as unknown as Message,
      userMsg('continue'),
    ])

    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.role)).toEqual(['user', 'user'])
    expect(JSON.stringify(messages)).not.toContain('tool_use')
    expect(JSON.stringify(messages)).not.toContain('toolu_aborted')
  })

  test('drops incomplete multi-tool assistant turns and their orphan result', async () => {
    const messages = await buildMessages([
      userMsg('run tools'),
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tool_a', name: 'Bash', arguments: {} },
          { type: 'toolCall', id: 'tool_b', name: 'Bash', arguments: {} },
        ],
        timestamp: 0,
      } as unknown as Message,
      toolResultMsg('tool_a', 'partial output'),
      userMsg('continue'),
    ])

    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.role)).toEqual(['user', 'user'])
    expect(JSON.stringify(messages)).not.toContain('tool_use')
    expect(JSON.stringify(messages)).not.toContain('tool_result')
  })

  test('drops orphan tool_result messages', async () => {
    const messages = await buildMessages([
      userMsg('hello'),
      toolResultMsg('tool_without_call', 'orphan output'),
      userMsg('continue'),
    ])

    expect(messages).toHaveLength(2)
    expect(messages.map((message) => message.role)).toEqual(['user', 'user'])
    expect(JSON.stringify(messages)).not.toContain('tool_result')
  })

  test('sanitizes surrogate pairs in text', async () => {
    const messages = await buildMessages([userMsg('hello \uD800 world')])
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'hello \uFFFD world',
    })
  })

  test('preserves valid surrogate pairs (astral characters) in text', async () => {
    // The /gu sanitize regex must only replace LONE surrogates — a valid
    // surrogate pair (😀 = \uD83D\uDE00) is a single astral code point and
    // must survive unmangled.
    const messages = await buildMessages([userMsg('hi \uD83D\uDE00 there')])
    expect(messages[0]).toEqual({
      role: 'user',
      content: 'hi \uD83D\uDE00 there',
    })
  })

  test('sanitizes tool IDs with invalid characters', async () => {
    const messages = await buildMessages([
      userMsg('run it'),
      toolCallMsg('call_xxx|fc_yyy', 'Bash'),
      toolResultMsg('call_xxx|fc_yyy', 'output'),
      userMsg('done'),
    ])
    const assistantContent = messages[1]?.content as Array<
      Record<string, unknown>
    >
    expect(assistantContent[0]?.id).toBe('call_xxx_fc_yyy')
    const toolContent = messages[2]?.content as Array<Record<string, unknown>>
    expect(toolContent[0]?.tool_use_id).toBe('call_xxx_fc_yyy')
  })
})

describe('convertMessages — empty base64 image guard', () => {
  test('filters out image with empty data from user message', async () => {
    const messages = await buildMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see image' },
          { type: 'image', mimeType: 'image/png', data: '' },
        ],
        timestamp: 0,
      } as Message,
    ])
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content.length).toBe(1)
    expect(content[0]?.type).toBe('text')
  })

  test('filters out image with null/undefined data', async () => {
    const messages = await buildMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', mimeType: 'image/png', data: null },
        ],
        timestamp: 0,
      } as Message,
    ])
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content.length).toBe(1)
    expect(content[0]?.type).toBe('text')
  })

  test('adds placeholder text when all images filtered and no text remains', async () => {
    const messages = await buildMessages([
      {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/png', data: '' }],
        timestamp: 0,
      } as Message,
    ])
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('(see attached image)')
  })

  test('keeps valid image with actual data', async () => {
    const messages = await buildMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
        timestamp: 0,
      } as Message,
    ])
    const content = messages[0]?.content as Array<Record<string, unknown>>
    expect(content.length).toBe(2)
    expect(content[1]?.type).toBe('image')
  })
})

describe('buildAnthropicRequest — Claude Code system[] shape', () => {
  // Anthropic rejects Pi's documentation paragraph inside the top-level
  // system[] array — see the note in convert.ts. These cases pin the resulting
  // shape: the remaining paragraphs stay in system[], and the documentation
  // paragraph is carried as its own marked content block ahead of the user's
  // text inside the first user message.
  async function buildBody(messages: Message[], systemPrompt?: string) {
    const { body } = await buildAnthropicRequest(
      'claude-sonnet-4-20250514',
      { messages, systemPrompt, tools: [] } as any,
      undefined,
      defaultCache,
    )
    return body
  }

  test('keeps the non-documentation paragraphs in system[]', async () => {
    const body = await buildBody([userMsg('hello')], PI_PROMPT)
    expect(body.system).toHaveLength(3)
    const text = String(body.system?.[2]?.text)
    expect(text).toContain('KEEP ONE')
    expect(text).toContain('KEEP TWO')
    expect(text).not.toContain('MOVE THIS')
  })

  test('carries the documentation paragraph as its own block ahead of the user text', async () => {
    const body = await buildBody([userMsg('hello')], PI_PROMPT)
    const content = body.messages[0]?.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(2)
    expect(String(content[0]?.text)).toContain('MOVE THIS')
    expect(content[1]).toMatchObject({ type: 'text', text: 'hello' })
  })

  test('marks the documentation block so the cached prefix ends before the user text', async () => {
    // Without this marker the prefix would extend into the user's own words,
    // and a new conversation with a different first message would have to
    // re-cache the paragraph.
    const body = await buildBody([userMsg('hello')], PI_PROMPT)
    const content = body.messages[0]?.content as Array<Record<string, unknown>>
    expect(content[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('unshifts the documentation block onto a structured first user message', async () => {
    const body = await buildBody(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see image' },
            { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
          ],
          timestamp: 0,
        } as Message,
      ],
      PI_PROMPT,
    )
    const content = body.messages[0]?.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(3)
    expect(String(content[0]?.text)).toContain('MOVE THIS')
    expect(content[1]).toMatchObject({ type: 'text', text: 'see image' })
  })

  test('drops the documentation paragraph when there is no user message to carry it', async () => {
    // convertMessages emits only user/assistant and trailing assistants are
    // stripped, so a conversation with no user message converts to empty. The
    // remaining paragraphs still go to system[], which is a shape Anthropic
    // accepts; only the documentation paragraph is dropped.
    const body = await buildBody([assistantMsg('only assistant')], PI_PROMPT)
    expect(body.messages).toHaveLength(0)
    expect(body.system).toHaveLength(3)
    expect(JSON.stringify(body.system)).not.toContain('MOVE THIS')
  })

  test('moves the complete prompt ahead of user text when the documentation heading is unknown', async () => {
    const renamedPrompt = [
      'KEEP ONE: you are an assistant.',
      'Reference material for Pi (read only when asked):\n- MOVE THIS',
    ].join('\n\n')
    const body = await buildBody([userMsg('hello')], renamedPrompt)

    expect(body.system).toHaveLength(2)
    expect(JSON.stringify(body.system)).not.toContain('KEEP ONE')
    expect(JSON.stringify(body.system)).not.toContain('MOVE THIS')
    const content = body.messages[0]?.content as Array<Record<string, unknown>>
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({
      type: 'text',
      text: renamedPrompt,
      cache_control: { type: 'ephemeral' },
    })
    expect(content[1]).toMatchObject({ type: 'text', text: 'hello' })
  })

  test('leaves system[] and messages untouched when no prompt is set', async () => {
    const body = await buildBody([userMsg('hello')])
    expect(body.system).toHaveLength(2)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' })
  })

  test('recomputes the Claude Code suffix from changing first-user text', async () => {
    const first = await buildBody([userMsg('messCage')])
    const changed = await buildBody([userMsg('messDage')])
    const firstHeader = String(first.system?.[0]?.text)
    const changedHeader = String(changed.system?.[0]?.text)

    expect(firstHeader).toContain(
      `cc_version=2.1.257.${computeCcVersionSuffix('messCage', '2.1.257')};`,
    )
    expect(changedHeader).toContain(
      `cc_version=2.1.257.${computeCcVersionSuffix('messDage', '2.1.257')};`,
    )
    expect(changedHeader).not.toBe(firstHeader)
  })
})

describe('buildAnthropicRequest — Fable/Mythos thinking', () => {
  test('maps Pi reasoning to output_config effort for Claude Fable 5', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-fable-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      { reasoning: 'high' } as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  test('requests summarized adaptive thinking for Claude Fable 5 without explicit reasoning', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-fable-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      {} as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toBeUndefined()
  })

  test('keeps manual thinking budgets for non-Fable models', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-opus-4-8',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      { reasoning: 'high' } as any,
      defaultCache,
    )

    expect(body.output_config).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 20_480 })
  })
})

describe('buildAnthropicRequest — Sonnet 5 thinking', () => {
  test('requests summarized adaptive thinking for Sonnet 5 without reasoning', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-sonnet-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      {} as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  test('replaces manual reasoning budget with adaptive summarized for Sonnet 5', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-sonnet-5-20260630',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      { reasoning: 'high' } as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  test('sets display summarized (not omitted) so Sonnet 5 thinking is visible', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-sonnet-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      {} as any,
      defaultCache,
    )

    expect((body.thinking as { display?: string }).display).toBe('summarized')
  })
})

describe('buildAnthropicRequest — Opus 5 thinking', () => {
  test('requests summarized adaptive thinking for Opus 5 without reasoning', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-opus-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      {} as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toBeUndefined()
  })

  test('maps reasoning to output_config effort for Opus 5', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-opus-5-20260701',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      { reasoning: 'high' } as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  test('sets display summarized (not omitted) so Opus 5 thinking is visible', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-opus-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      {} as any,
      defaultCache,
    )

    expect((body.thinking as { display?: string }).display).toBe('summarized')
  })

  test('keeps manual thinking budgets for non-Opus5 models', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-opus-4-8',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      { reasoning: 'high' } as any,
      defaultCache,
    )

    expect(body.output_config).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 20_480 })
  })
})

describe('convertMessages — empty error tool_result guard', () => {
  test('injects Error placeholder when is_error=true and content is empty', async () => {
    const messages = await buildMessages([
      userMsg('run it'),
      toolCallMsg('tool_1', 'Bash'),
      {
        role: 'toolResult',
        toolCallId: 'tool_1',
        content: [],
        isError: true,
        timestamp: 0,
      } as unknown as Message,
      userMsg('ok'),
    ])
    const toolContent = messages[2]?.content as Array<Record<string, unknown>>
    expect(toolContent[0]?.is_error).toBe(true)
    const innerContent = toolContent[0]?.content as Array<
      Record<string, unknown>
    >
    expect(innerContent).toEqual([{ type: 'text', text: 'Error' }])
  })

  test('keeps content when is_error=true but content is non-empty', async () => {
    const messages = await buildMessages([
      userMsg('run it'),
      toolCallMsg('tool_1', 'Bash'),
      {
        role: 'toolResult',
        toolCallId: 'tool_1',
        content: [{ type: 'text', text: 'command failed: exit 1' }],
        isError: true,
        timestamp: 0,
      } as unknown as Message,
      userMsg('ok'),
    ])
    const toolContent = messages[2]?.content as Array<Record<string, unknown>>
    // Non-empty content should be preserved even with is_error=true
    expect(toolContent[0]?.is_error).toBe(true)
    expect(toolContent[0]?.content).toBe('command failed: exit 1')
  })

  test('injects Error placeholder for consecutive error tool_results', async () => {
    const messages = await buildMessages([
      userMsg('run both'),
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tool_1', name: 'Bash', arguments: {} },
          { type: 'toolCall', id: 'tool_2', name: 'Bash', arguments: {} },
        ],
        timestamp: 0,
      } as Message,
      {
        role: 'toolResult',
        toolCallId: 'tool_1',
        content: [],
        isError: true,
        timestamp: 0,
      } as unknown as Message,
      {
        role: 'toolResult',
        toolCallId: 'tool_2',
        content: [],
        isError: true,
        timestamp: 0,
      } as unknown as Message,
      userMsg('ok'),
    ])
    // Both tool_results should be in same user message (batched)
    const toolContent = messages[2]?.content as Array<Record<string, unknown>>
    expect(toolContent.length).toBe(2)
    for (const tr of toolContent) {
      expect(tr.is_error).toBe(true)
      expect(tr.content).toEqual([{ type: 'text', text: 'Error' }])
    }
  })
})

function thinkingToolMsg(
  thinking: string,
  signature: string,
  toolId: string,
  options: {
    provider?: string
    api?: string
    model?: string
    redacted?: boolean
  } = {},
): Message {
  return {
    role: 'assistant',
    provider: options.provider ?? 'anthropic',
    api: options.api ?? 'cortexkit-anthropic-messages',
    model: options.model ?? TEST_MODEL_ID,
    content: [
      {
        type: 'thinking',
        thinking,
        thinkingSignature: signature,
        redacted: options.redacted,
      },
      { type: 'toolCall', id: toolId, name: 'Bash', arguments: {} },
    ],
    timestamp: 0,
  } as Message
}

describe('convertMessages — signed thinking blocks', () => {
  test('preserves signed thinking with signature in the last assistant turn', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('reason A', 'sig-A', 'tool_1'),
      toolResultMsg('tool_1', 'out1'),
      thinkingToolMsg('reason B', 'sig-B', 'tool_2'),
      toolResultMsg('tool_2', 'out2'),
    ])

    // Last assistant turn (index 3): thinking preserved verbatim with signature.
    const current = messages[3]?.content as Array<Record<string, unknown>>
    expect(current[0]).toEqual({
      type: 'thinking',
      thinking: 'reason B',
      signature: 'sig-B',
    })
    expect(current[1]?.type).toBe('tool_use')
  })

  test('drops OpenAI encrypted reasoning before sending to Anthropic', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg(
        'gpt reasoning summary',
        JSON.stringify({
          id: 'rs_0020061038ec397b016a2aa86b9e9881968a52480521e392de',
          type: 'reasoning',
          content: [],
          encrypted_content: 'gAAAAABqKqhtOpenAIEncryptedReasoningState',
          summary: [{ type: 'summary_text', text: 'gpt reasoning summary' }],
        }),
        'tool_1',
        { provider: 'openai-codex', model: 'gpt-5.6-sol' },
      ),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block[0]).toEqual({
      type: 'tool_use',
      id: 'tool_1',
      name: 'Bash',
      input: {},
    })
    expect(JSON.stringify(messages)).not.toContain('gAAAAABqKqht')
    expect(JSON.stringify(messages)).not.toContain('gpt reasoning summary')
  })

  test('drops another provider signature but preserves its visible reasoning as text', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('deepseek reasoning', 'reasoning_content', 'tool_1', {
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
      }),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block).toEqual([
      { type: 'text', text: 'deepseek reasoning' },
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Bash',
        input: {},
      },
    ])
  })

  test('drops a different Anthropic model signature but preserves visible reasoning', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('old model reasoning', 'sig-old', 'tool_1', {
        model: 'claude-opus-4-8',
      }),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block).toEqual([
      { type: 'text', text: 'old model reasoning' },
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Bash',
        input: {},
      },
    ])
  })

  test('drops a different API signature even when provider and model match', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('Bedrock reasoning', 'sig-bedrock', 'tool_1', {
        api: 'bedrock-converse-stream',
      }),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block[0]).toEqual({ type: 'text', text: 'Bedrock reasoning' })
    expect(block[1]?.type).toBe('tool_use')
  })

  test('accepts same-model signatures from Pi native Anthropic history', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('native reasoning', 'sig-native', 'tool_1', {
        api: 'anthropic-messages',
      }),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block[0]).toEqual({
      type: 'thinking',
      thinking: 'native reasoning',
      signature: 'sig-native',
    })
  })

  test('drops foreign redacted thinking because its payload is opaque', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg(
        '[Reasoning redacted]',
        'foreign-redacted-data',
        'tool_1',
        { model: 'claude-opus-4-8', redacted: true },
      ),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block).toEqual([
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Bash',
        input: {},
      },
    ])
  })

  test('round-trips same-model redacted thinking as an opaque redacted block', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg(
        '[Reasoning redacted]',
        'encrypted-redacted-data',
        'tool_1',
        { redacted: true },
      ),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block[0]).toEqual({
      type: 'redacted_thinking',
      data: 'encrypted-redacted-data',
    })
  })

  test('preserves same-model omitted thinking when only its signature is visible', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('', 'sig-omitted', 'tool_1'),
      toolResultMsg('tool_1', 'out1'),
    ])

    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block[0]).toEqual({
      type: 'thinking',
      thinking: '',
      signature: 'sig-omitted',
    })
  })

  test('downgrades a signed thinking block with a lone surrogate to sanitized text', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('bad\uD800text', 'sig-A', 'tool_1'),
      toolResultMsg('tool_1', 'out1'),
      thinkingToolMsg('reason B', 'sig-B', 'tool_2'),
      toolResultMsg('tool_2', 'out2'),
    ])

    // A signed block with a lone surrogate can't keep its signature: sanitizing
    // would break it and sending the raw surrogate is an invalid-UTF8 400. Drop
    // the signature and downgrade to sanitized text during conversion.
    const block = messages[1]?.content as Array<Record<string, unknown>>
    expect(block[0]).toEqual({ type: 'text', text: 'bad\uFFFDtext' })
  })

  test('downgrades signed last-turn thinking to sanitized text if it has a lone surrogate', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('safe reason', 'sig-A', 'tool_1'),
      toolResultMsg('tool_1', 'out1'),
      thinkingToolMsg('bad\uD800reason', 'sig-B', 'tool_2'),
      toolResultMsg('tool_2', 'out2'),
    ])

    // Last assistant turn, but signed thinking contains a lone surrogate: the
    // signature cannot survive sanitization, so drop it and emit text.
    const current = messages[3]?.content as Array<Record<string, unknown>>
    expect(current[0]).toEqual({ type: 'text', text: 'bad\uFFFDreason' })
    expect(current[1]?.type).toBe('tool_use')
  })

  test('preserves clean signed last-turn thinking verbatim (no surrogate)', async () => {
    const messages = await buildMessages([
      userMsg('q1'),
      thinkingToolMsg('clean reason', 'sig-B', 'tool_2'),
      toolResultMsg('tool_2', 'out2'),
    ])
    const current = messages[1]?.content as Array<Record<string, unknown>>
    expect(current[0]).toEqual({
      type: 'thinking',
      thinking: 'clean reason',
      signature: 'sig-B',
    })
  })
})
