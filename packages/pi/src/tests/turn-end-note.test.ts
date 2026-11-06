import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyClaudeCodeHeaders,
  type ClaudeCodeIdentity,
  type ProviderAccountUuid,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
import { type Context, type Message, Type } from '@earendil-works/pi-ai'
import { buildAnthropicRequest } from '../convert'

const routingKey = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const originalRouting = globals[routingKey]
afterEach(() => {
  if (originalRouting === undefined) delete globals[routingKey]
  else globals[routingKey] = originalRouting
})

const note = {
  role: 'system',
  clear_at: 'next_user_message',
  content:
    'Your reply above has already reached the user. The tool call after it was housekeeping and changed nothing they need to know. Do not repeat, summarize or rewrite that reply. If no new work remains, end the turn without restating anything.',
}
const identity: ClaudeCodeIdentity = {
  deviceId: 'd'.repeat(64),
  accountUuid: '00000000-0000-4000-8000-000000000001' as ProviderAccountUuid,
  sessionId: '11111111-2222-4333-8444-555555555555',
}
const user = (content: string): Message => ({
  role: 'user',
  content,
  timestamp: 0,
})
const answer = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 0,
  }) as Message
function pair(id: string, name = 'board', text = 'A'.repeat(350)): Message[] {
  return [
    {
      ...answer(text),
      content: [
        { type: 'text', text },
        { type: 'toolCall', id, name, arguments: {} },
      ],
    } as Message,
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text: 'Done' }],
      isError: false,
      timestamp: 0,
    },
  ]
}
async function build(
  messages: Message[],
  controls: NonNullable<Parameters<typeof buildAnthropicRequest>[6]> = {},
  oauth = true,
  model = 'claude-opus-5-5',
  names = ['board', 'ctx_reduce'],
  mode: 'automatic' | 'hybrid' | 'explicit' = 'automatic',
) {
  const result = await buildAnthropicRequest(
    model,
    {
      messages,
      tools: names.map((name) => ({
        name,
        description: name,
        parameters: Type.Object({}),
      })),
    } as Context,
    undefined,
    { enabled: true, mode },
    false,
    oauth ? identity : undefined,
    controls,
  )
  expect(await signRequestBody(result.bodyText)).toBe(result.bodyText)
  return { ...result, wire: JSON.parse(result.bodyText) }
}

describe('Pi turn-end notes', () => {
  test('reads runner notes using Pi session id, independently of housekeeping settings and only on OAuth', async () => {
    const reports: unknown[] = []
    globals[routingKey] = (sessionId: string) => {
      expect(sessionId).toBe('ses_runner_notes_pi')
      return {
        turn_notes: () => [{ after_tool_use_id: 'a', text: 'Runner reminder' }],
        report: (payload: unknown) => reports.push(payload),
      }
    }
    for (const oauth of [true, false]) {
      const result = await buildAnthropicRequest(
        'claude-opus-5-5',
        { messages: [user('Question'), ...pair('a')], tools: [] },
        { sessionId: 'ses_runner_notes_pi' },
        { enabled: false, mode: 'automatic' },
        false,
        oauth ? identity : undefined,
        { turnEndNote: { tools: [] } },
      )
      expect(await signRequestBody(result.bodyText)).toBe(result.bodyText)
      const messages = JSON.parse(result.bodyText).messages
      expect(messages.filter((m: any) => m.clear_at)).toEqual(
        oauth
          ? [
              {
                role: 'system',
                clear_at: 'next_user_message',
                content: 'Runner reminder',
              },
            ]
          : [],
      )
      if (oauth) {
        const headers = new Headers()
        applyClaudeCodeHeaders(headers, '', { body: result.body, identity })
        expect(headers.get('anthropic-beta')?.split(',')).toContain(
          'mid-conversation-system-clear-at-2026-08-21',
        )
      }
    }
    await Promise.resolve()
    expect(reports).toContainEqual({
      kind: 'turn_note_skipped',
      after_tool_use_id: 'a',
      reason: 'not_oauth',
    })
  })

  test('N N+1 N+2 preserve every earlier note, including after tool declarations change', async () => {
    const history = [user('Question'), ...pair('a')]
    const first = await build(history)
    expect(first.wire.messages.at(-1)).toEqual(note)
    history.push(
      answer('No new work.'),
      user('Next'),
      ...pair('b', 'ctx_reduce'),
    )
    const second = await build(history, {}, true, undefined, ['unrelated'])
    history.push(answer('Done.'), user('Third'), ...pair('c'))
    const third = await build(history, {}, true, undefined, [])
    for (const later of [second, third]) {
      expect(
        JSON.stringify(
          later.wire.messages.slice(0, first.wire.messages.length),
        ),
      ).toBe(JSON.stringify(first.wire.messages))
      const { messages: _m, system: _s, tools: _t, ...fields } = later.wire
      const { messages: _fm, system: _fs, tools: _ft, ...initial } = first.wire
      expect(fields).toEqual(initial)
      expect(later.wire.system.slice(1)).toEqual(first.wire.system.slice(1))
      expect(
        later.wire.system[0].text.replace(/cch=[0-9a-f]{5}/, 'cch=00000'),
      ).toBe(first.wire.system[0].text.replace(/cch=[0-9a-f]{5}/, 'cch=00000'))
    }
    expect(
      JSON.stringify(third.wire.messages.slice(0, second.wire.messages.length)),
    ).toBe(JSON.stringify(second.wire.messages))
    expect(
      third.wire.messages.filter((m: { clear_at?: string }) => m.clear_at),
    ).toHaveLength(3)
    const headers = new Headers()
    applyClaudeCodeHeaders(headers, '', { body: third.body, identity })
    expect(headers.get('anthropic-beta')?.split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
  })

  test.each([349, 350])(
    'visible reply boundary: %i characters',
    async (length) => {
      const body = await build([
        user('Question'),
        ...pair('a', 'board', 'a'.repeat(length)),
      ])
      expect(
        body.wire.messages.some((m: { clear_at?: string }) => m.clear_at),
      ).toBe(length === 350)
    },
  )

  test('custom host spellings use the same stable mapping as calls', async () => {
    const result = await build([user('Question'), ...pair('a', 'bash')], {
      turnEndNote: { tools: ['bash'] },
    })
    expect(result.wire.messages[1].content[1].name).toBe('Bash')
    expect(result.wire.messages.at(-1)).toEqual(note)
  })

  test('API-key, unsupported and explicitly empty lists stay unchanged', async () => {
    const history = [user('Question'), ...pair('a')]
    for (const result of [
      await build(history, {}, false),
      await build(history, {}, true, 'claude-sonnet-4-5'),
      await build(history, { turnEndNote: { tools: [] } }),
    ]) {
      expect(result.wire.messages).not.toContainEqual(note)
    }
  })

  test('thinking downgraded to text is not a visible reply', async () => {
    const history = [user('Question'), ...pair('a')]
    const assistant = history[1] as Extract<Message, { role: 'assistant' }>
    assistant.content[0] = {
      type: 'thinking',
      thinking: 'Private reasoning'.repeat(50),
    }
    expect((await build(history)).wire.messages).not.toContainEqual(note)
  })

  test.each(['', ' \n\t'])(
    'empty or whitespace-only replies do not qualify: %j',
    async (text) => {
      expect(
        (await build([user('Question'), ...pair('a', 'board', text)])).wire
          .messages,
      ).not.toContainEqual(note)
    },
  )

  test('a following user removes only the offending note', async () => {
    const history = [user('Question'), ...pair('a')]
    const first = await build(history)
    const later = await build([...history, user('Next'), ...pair('b')])
    expect(later.wire.messages.slice(0, 3)).toEqual(
      first.wire.messages.slice(0, 3),
    )
    expect(later.wire.messages[3]).toEqual({ role: 'user', content: 'Next' })
    expect(later.wire.messages.at(-1)).toEqual(note)
    expect(
      later.wire.messages.filter((m: { clear_at?: string }) => m.clear_at),
    ).toHaveLength(1)
  })

  test.each(['automatic', 'hybrid', 'explicit'] as const)(
    'notes have no cache or effort fields in %s mode',
    async (mode) => {
      const result = await build(
        [user('Question'), ...pair('a')],
        {},
        true,
        undefined,
        undefined,
        mode,
      )
      expect(result.wire.messages.at(-1)).toEqual(note)
    },
  )
})
