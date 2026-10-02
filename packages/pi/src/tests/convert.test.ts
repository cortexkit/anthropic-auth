import { describe, expect, test } from 'bun:test'
import {
  CLAUDE_CODE_VERSION,
  computeCcVersionSuffix,
  type ProviderAccountUuid,
  TrailingAssistantHistoryError,
} from '@cortexkit/anthropic-auth-core'
import { type Context, type Message, Type } from '@earendil-works/pi-ai'
import { buildAnthropicRequest } from '../convert'
import { normalizeContext } from '../transcript.ts'

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

function toolCallMsg(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: args }],
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

describe('fast mode model eligibility', () => {
  test.each([
    ['claude-opus-4-6', false],
    ['claude-opus-4-7', false],
    ['claude-opus-4-8', true],
    ['claude-opus-5', true],
    ['claude-opus-5-5', true],
  ])('Pi sends speed only for eligible %s', async (model, enabled) => {
    const { body } = await buildAnthropicRequest(
      model,
      { messages: [userMsg('hello')], tools: [] } as Context,
      undefined,
      defaultCache,
      true,
    )
    expect(body.speed).toBe(enabled ? 'fast' : undefined)
  })
})

describe('buildAnthropicRequest — trailing assistant boundary', () => {
  test('refuses a meaningful trailing assistant message', async () => {
    await expect(
      buildMessages([userMsg('hello'), assistantMsg('I will help')]),
    ).rejects.toBeInstanceOf(TrailingAssistantHistoryError)
  })

  test('refuses multiple meaningful trailing assistant messages', async () => {
    await expect(
      buildMessages([
        userMsg('hello'),
        assistantMsg('first'),
        assistantMsg('second'),
      ]),
    ).rejects.toBeInstanceOf(TrailingAssistantHistoryError)
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

  test('refuses a meaningful trailing assistant after tool_result', async () => {
    await expect(
      buildMessages([
        userMsg('do something'),
        toolCallMsg('tool_1', 'Bash'),
        toolResultMsg('tool_1', 'output'),
        assistantMsg('based on that output...'),
      ]),
    ).rejects.toBeInstanceOf(TrailingAssistantHistoryError)
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

  test('refuses an all-assistant conversation with content', async () => {
    await expect(
      buildMessages([assistantMsg('first'), assistantMsg('second')]),
    ).rejects.toBeInstanceOf(TrailingAssistantHistoryError)
  })

  test('refuses opaque foreign thinking before lowering can erase the tail', async () => {
    const context: Context = {
      tools: [],
      messages: [
        userMsg('original question'),
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '',
              thinkingSignature: 'opaque-foreign-signature',
            },
          ],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-opus-4-8',
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
      ],
    }
    const before = JSON.stringify(context)
    await expect(
      buildAnthropicRequest(
        'claude-opus-5-5',
        context,
        undefined,
        defaultCache,
      ),
    ).rejects.toBeInstanceOf(TrailingAssistantHistoryError)
    expect(JSON.stringify(context)).toBe(before)
  })

  test('removes a provably empty assistant trailer', async () => {
    const messages = await buildMessages([
      userMsg('hello'),
      assistantMsg(' \n\t'),
    ])
    expect(messages).toEqual([{ role: 'user', content: 'hello' }])
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
    await expect(
      buildBody([assistantMsg('only assistant')], PI_PROMPT),
    ).rejects.toBeInstanceOf(TrailingAssistantHistoryError)
    // No user exists to carry the documentation block in an empty history.
    // The instruction paragraphs still remain in system[].
    const body = await buildBody([], PI_PROMPT)
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

  test('pins the Claude Code suffix by Pi session across compacted history', async () => {
    const buildForSession = async (text: string, sessionId: string) =>
      (
        await buildAnthropicRequest(
          TEST_MODEL_ID,
          { messages: [userMsg(text)], systemPrompt: '', tools: [] } as any,
          { sessionId } as any,
          defaultCache,
        )
      ).body

    const first = await buildForSession('messCage', 'pi-suffix-session')
    const compacted = await buildForSession(
      'replacement compaction summary',
      'pi-suffix-session',
    )
    const other = await buildForSession(
      'replacement compaction summary',
      'pi-suffix-other-session',
    )

    const firstHeader = String(first.system?.[0]?.text)
    expect(String(compacted.system?.[0]?.text)).toContain(
      `cc_version=${CLAUDE_CODE_VERSION}.${computeCcVersionSuffix('messCage', CLAUDE_CODE_VERSION)};`,
    )
    expect(String(compacted.system?.[0]?.text)).toBe(firstHeader)
    expect(String(other.system?.[0]?.text)).not.toBe(firstHeader)
  })

  test('recomputes the Claude Code suffix from changing first-user text without a session id', async () => {
    const first = await buildBody([userMsg('messCage')])
    const changed = await buildBody([userMsg('messDage')])
    const firstHeader = String(first.system?.[0]?.text)
    const changedHeader = String(changed.system?.[0]?.text)

    expect(firstHeader).toContain(
      `cc_version=${CLAUDE_CODE_VERSION}.${computeCcVersionSuffix('messCage', CLAUDE_CODE_VERSION)};`,
    )
    expect(changedHeader).toContain(
      `cc_version=${CLAUDE_CODE_VERSION}.${computeCcVersionSuffix('messDage', CLAUDE_CODE_VERSION)};`,
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

  test('adds Fable 5.1 binding controls when compacted history replays signed thinking', async () => {
    const identity = {
      deviceId: 'd'.repeat(64),
      accountIdentity: 'main',
      accountUuid: 'account-uuid' as ProviderAccountUuid,
      sessionId: 'identity-session',
    }
    const { body } = await buildAnthropicRequest(
      'claude-fable-5-1',
      {
        messages: [
          userMsg('compaction summary'),
          thinkingToolMsg('reason', 'signature', 'tool_1', {
            model: 'claude-fable-5-1',
          }),
          toolResultMsg('tool_1', 'result'),
          userMsg('continue'),
        ],
        systemPrompt: 'test',
        tools: [],
      } as any,
      { sessionId: 'pi-fable-5-1-binding' } as any,
      defaultCache,
      false,
      identity,
      { thinkingPrefixMismatchBehavior: 'drop_block' },
    )

    expect(body.thinking as Record<string, unknown>).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
  })

  test('injects Pi effort changes before their user turns', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-fable-5-1',
      {
        messages: [
          userMsg('first'),
          assistantMsg('first answer'),
          userMsg('second'),
        ],
        systemPrompt: 'test',
        tools: [],
      } as any,
      { sessionId: 'pi-fable-5-1-effort', reasoning: 'high' } as any,
      defaultCache,
      false,
      undefined,
      {
        effortTransitions: [
          { afterAssistantMessages: 0, effort: 'low' },
          { afterAssistantMessages: 1, effort: 'high' },
        ],
      },
    )

    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.messages[2]).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
  })

  test('does not add Fable 5.1 binding controls to an API-key request', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-fable-5-1',
      {
        messages: [
          userMsg('compaction summary'),
          thinkingToolMsg('reason', 'signature', 'tool_1', {
            model: 'claude-fable-5-1',
          }),
          toolResultMsg('tool_1', 'result'),
          userMsg('continue'),
        ],
        systemPrompt: 'test',
        tools: [],
      } as any,
      { sessionId: 'pi-fable-5-1-api-route' } as any,
      defaultCache,
    )

    expect(
      (body.thinking as Record<string, unknown>).block_binding,
    ).toBeUndefined()
  })

  test('does not add Fable 5.1 binding controls on a first turn', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-fable-5-1',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      { sessionId: 'pi-fable-5-1-first-turn' } as any,
      defaultCache,
      false,
      {
        deviceId: 'd'.repeat(64),
        accountIdentity: 'main',
        accountUuid: 'account-uuid' as ProviderAccountUuid,
        sessionId: 'identity-session',
      },
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
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

describe('buildAnthropicRequest — Sonnet 5.5 thinking', () => {
  test('sends adaptive summaries and native effort for Sonnet 5.5', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-sonnet-5-5',
      { messages: [userMsg('hello')], tools: [] } as Context,
      { reasoning: 'high' },
      defaultCache,
    )
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.speed).toBeUndefined()
  })

  test('refuses unsupported minimal effort rather than sending an invalid Sonnet 5.5 request', async () => {
    await expect(
      buildAnthropicRequest(
        'claude-sonnet-5-5',
        { messages: [userMsg('hello')], tools: [] } as Context,
        { reasoning: 'minimal' },
        defaultCache,
      ),
    ).rejects.toThrow('Claude Sonnet 5.5 does not support minimal effort')
  })

  test('honors explicit prefix-mismatch behavior on a signed Sonnet 5.5 continuation', async () => {
    const identity = {
      deviceId: 'd'.repeat(64),
      accountIdentity: 'main',
      accountUuid: 'account-uuid' as ProviderAccountUuid,
      sessionId: 'sonnet-5-5-binding',
    }
    const context = {
      messages: [
        userMsg('original'),
        thinkingToolMsg('reason', 'signature', 'tool_1', {
          model: 'claude-sonnet-5-5',
        }),
        toolResultMsg('tool_1', 'result'),
        userMsg('continue'),
      ],
      tools: [],
    } as Context
    const { body, bodyText } = await buildAnthropicRequest(
      'claude-sonnet-5-5',
      context,
      { sessionId: 'sonnet-5-5-binding' },
      defaultCache,
      false,
      identity,
      { thinkingPrefixMismatchBehavior: 'drop_block' },
    )
    expect(body.thinking).toMatchObject({
      type: 'adaptive',
      display: 'summarized',
    })
    expect(bodyText).toContain(
      '"block_binding":{"prefix_mismatch_behavior":"drop_block"}',
    )
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

describe('buildAnthropicRequest — host system prompt shapes', () => {
  // Oh My Pi types Context.systemPrompt as ordered prompt blocks and hands the
  // array straight to the provider, where `.trim()` threw and no request was
  // ever built (issue #201). Blocks must classify exactly like the joined text.
  // The cast is the point of these cases: the host contradicts the `string`
  // declaration in Pi's Context type at runtime.
  async function buildBody(systemPrompt: unknown) {
    const { body } = await buildAnthropicRequest(
      TEST_MODEL_ID,
      {
        messages: [userMsg('hello')],
        systemPrompt,
        tools: [],
      } as unknown as Context,
      undefined,
      defaultCache,
    )
    return body
  }

  test('splits an ordered block array exactly like the joined prompt', async () => {
    const blocks = PI_PROMPT.split('\n\n')
    expect(blocks).toHaveLength(3)

    const fromBlocks = await buildBody(blocks)
    const fromString = await buildBody(PI_PROMPT)

    expect(fromBlocks.system).toEqual(fromString.system)
    expect(fromBlocks.messages).toEqual(fromString.messages)
    expect(String(fromBlocks.system?.[2]?.text)).toContain('KEEP TWO')
    const content = fromBlocks.messages[0]?.content as Array<
      Record<string, unknown>
    >
    expect(String(content[0]?.text)).toContain('MOVE THIS')
  })

  test('reads structured text blocks for their text', async () => {
    const body = await buildBody(
      PI_PROMPT.split('\n\n').map((text) => ({ type: 'text', text })),
    )
    expect(String(body.system?.[2]?.text)).toContain('KEEP ONE')
    const content = body.messages[0]?.content as Array<Record<string, unknown>>
    expect(String(content[0]?.text)).toContain('MOVE THIS')
  })

  test('drops non-text blocks instead of flattening their metadata', async () => {
    const paragraphs = PI_PROMPT.split('\n\n')
    const body = await buildBody([
      { type: 'text', text: paragraphs[0] },
      { type: 'image', text: 'IMAGE METADATA' },
      { type: 'tool_use', name: 'read', text: 'TOOL METADATA' },
      paragraphs[1],
      { type: 'text', text: paragraphs[2] },
    ])

    const sent = JSON.stringify(body)
    expect(sent).toContain('KEEP ONE')
    expect(sent).toContain('KEEP TWO')
    expect(sent).toContain('MOVE THIS')
    expect(sent).not.toContain('IMAGE METADATA')
    expect(sent).not.toContain('TOOL METADATA')
  })

  test('treats an empty block list as no prompt', async () => {
    const body = await buildBody([])
    expect(body.system).toHaveLength(2)
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' })
  })
})

describe('buildAnthropicRequest — cache breakpoint budget', () => {
  // Anthropic accepts at most four cache breakpoints per request, and this
  // converter places four itself: the last tool, the last system block, the
  // cached prompt block on the first user message, and the last user block.
  // Adding the top-level control on top of them made five and Anthropic
  // rejected the request before it reached the model (issue #201).
  async function buildBody(cache: {
    enabled: boolean
    mode: 'explicit' | 'automatic' | 'hybrid'
  }) {
    const { body } = await buildAnthropicRequest(
      TEST_MODEL_ID,
      {
        messages: [userMsg('hello')],
        systemPrompt: PI_PROMPT,
        tools: [
          {
            name: 'read',
            description: 'read a file',
            parameters: { properties: {}, required: [] },
          },
        ],
      } satisfies Context,
      undefined,
      cache,
    )
    return body
  }

  const countBreakpoints = (body: unknown) =>
    JSON.stringify(body).split('"cache_control"').length - 1

  test('places four breakpoints and no top-level control by default', async () => {
    const body = await buildBody({ enabled: false, mode: 'hybrid' })
    expect(countBreakpoints(body)).toBe(4)
    expect(body.cache_control).toBeUndefined()
  })

  test('keeps hybrid within the budget by extending those four to 1h', async () => {
    const body = await buildBody({ enabled: true, mode: 'hybrid' })
    expect(countBreakpoints(body)).toBe(4)
    expect(body.cache_control).toBeUndefined()
    expect(body.system?.at(-1)?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(body.tools?.at(-1)?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('spends the whole budget on the top-level control in automatic', async () => {
    const body = await buildBody({ enabled: true, mode: 'automatic' })
    expect(countBreakpoints(body)).toBe(1)
    expect(body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(body.system?.at(-1)?.cache_control).toBeUndefined()
    expect(body.tools?.at(-1)?.cache_control).toBeUndefined()
  })

  // A tool parameter or tool argument that happens to be named cache_control is
  // caller data, not a breakpoint. A deep walk would delete it in automatic and
  // write ttl into it in hybrid/explicit, silently corrupting the tool contract.
  test.each(['explicit', 'automatic', 'hybrid'] as const)(
    'leaves a tool parameter named cache_control untouched in %s',
    async (mode) => {
      const { body } = await buildAnthropicRequest(
        TEST_MODEL_ID,
        {
          messages: [
            userMsg('hello'),
            toolCallMsg('tool_1', 'store', {
              cache_control: { type: 'ephemeral' },
            }),
            toolResultMsg('tool_1', 'stored'),
          ],
          systemPrompt: PI_PROMPT,
          tools: [
            {
              name: 'store',
              description: 'store a value',
              parameters: {
                properties: {
                  cache_control: { type: 'string', description: 'a header' },
                },
                required: [],
              },
            },
          ],
        } satisfies Context,
        undefined,
        { enabled: true, mode },
      )

      const schema = body.tools?.[0]?.input_schema as {
        properties: Record<string, unknown>
      }
      expect(schema.properties.cache_control).toEqual({
        type: 'string',
        description: 'a header',
      })

      const assistant = body.messages[1] as {
        content: Array<Record<string, unknown>>
      }
      expect(assistant.content[0]?.input).toEqual({
        cache_control: { type: 'ephemeral' },
      })
    },
  )
})

describe('Pi normalized transcripts', () => {
  test('preserves the same prompt, tools and cache boundaries as raw host context', async () => {
    const raw: Context = {
      systemPrompt: 'PRESERVE_SYSTEM_INSTRUCTION_8642',
      tools: [
        {
          name: 'preserve_tool',
          description: 'Keep this tool',
          parameters: Type.Object({}),
        },
      ],
      messages: [userMsg('Hello')],
    }
    const cache = { enabled: false, mode: 'explicit' as const }
    const direct = await buildAnthropicRequest(
      'claude-fable-5-1',
      raw,
      undefined,
      cache,
    )
    const normalized = await buildAnthropicRequest(
      'claude-fable-5-1',
      normalizeContext(raw),
      undefined,
      cache,
    )
    expect(normalized.bodyText).toContain('PRESERVE_SYSTEM_INSTRUCTION_8642')
    expect(normalized.body.tools?.map((tool) => tool.name)).toEqual([
      'preserve_tool',
    ])
    expect(normalized.body.messages).toEqual(direct.body.messages)
    expect(normalized.body.tools).toEqual(direct.body.tools)
    expect(normalized.body.system).toEqual(direct.body.system)
  })

  test('replays named prompt replacements and tool additions/removals without losing instructions', async () => {
    const transcript = normalizeContext({
      messages: [
        {
          role: 'system',
          content: 'BASE_INSTRUCTION',
          sections: { rules: 'RETIRED_SECTION_8642', stable: 'STABLE_SECTION' },
          toolsAdded: [
            {
              name: 'old_tool',
              description: 'Old',
              parameters: Type.Object({}),
            },
          ],
          timestamp: 0,
        },
        userMsg('Hello'),
        {
          role: 'system',
          content: 'LATER_INSTRUCTION',
          sections: { rules: 'REPLACED_SECTION_8642' },
          toolsRemoved: [{ name: 'old_tool' }],
          toolsAdded: [
            {
              name: 'new_tool',
              description: 'New',
              parameters: Type.Object({}),
            },
          ],
          timestamp: 1,
        },
      ],
    })
    const result = await buildAnthropicRequest(
      'claude-fable-5-1',
      transcript,
      undefined,
      { enabled: false, mode: 'explicit' },
    )
    for (const instruction of [
      'BASE_INSTRUCTION',
      'STABLE_SECTION',
      'LATER_INSTRUCTION',
      'REPLACED_SECTION_8642',
    ])
      expect(result.bodyText).toContain(instruction)
    expect(result.bodyText).not.toContain('RETIRED_SECTION_8642')
    expect(result.body.tools?.map((tool) => tool.name)).toEqual(['new_tool'])
    expect(
      result.body.messages.every((message) => message.role !== 'system'),
    ).toBe(true)
  })
})

describe('buildAnthropicRequest — Opus 5.5 thinking', () => {
  test('requests summarized adaptive thinking for Opus 5.5 without reasoning', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-opus-5-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      {} as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toBeUndefined()
  })

  test('maps reasoning to output_config effort for Opus 5.5', async () => {
    const { body } = await buildAnthropicRequest(
      'claude-opus-5-5',
      { messages: [userMsg('hello')], systemPrompt: 'test', tools: [] } as any,
      { reasoning: 'medium' } as any,
      defaultCache,
    )

    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'medium' })
  })
})
