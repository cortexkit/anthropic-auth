import { afterEach, describe, expect, test } from 'bun:test'
import { signRequestBody } from '@cortexkit/anthropic-auth-core'
import { rewriteRequestBody, setOAuthHeaders } from '../transform'

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

function reply(id: string, names = ['board'], text = 'A'.repeat(350)) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...names.map((name, i) => ({
          type: 'tool_use',
          id: `${id}_${i}`,
          name,
          input: {},
        })),
      ],
    },
    {
      role: 'user',
      content: names.map((_, i) => ({
        type: 'tool_result',
        tool_use_id: `${id}_${i}`,
        content: 'Done.',
      })),
    },
  ]
}

async function build(
  messages: unknown[],
  options: NonNullable<Parameters<typeof rewriteRequestBody>[1]> = {},
  model = 'claude-opus-5-5',
  tools = ['board', 'ctx_reduce'],
) {
  const text = await rewriteRequestBody(
    JSON.stringify({
      model,
      max_tokens: 16000,
      stream: true,
      messages,
      tools: tools.map((name) => ({ name, input_schema: { type: 'object' } })),
    }),
    { turnEndNoteEnabled: true, ...options },
  )
  expect(await signRequestBody(text)).toBe(text)
  return JSON.parse(text)
}

describe('OpenCode turn-end notes', () => {
  test('OC1 reads runner notes with the host session even when our own note is disabled', async () => {
    const reports: unknown[] = []
    globals[routingKey] = (sessionId: string) => {
      expect(sessionId).toBe('ses_runner_notes_oc1')
      return {
        turn_notes: () => [
          { after_tool_use_id: 'a_0', text: 'Runner reminder' },
        ],
        report: (payload: unknown) => reports.push(payload),
      }
    }
    const body = await build(reply('a'), {
      sessionId: 'ses_runner_notes_oc1',
      modelId: 'claude-opus-5-5',
      isOAuth: true,
      turnEndNote: { tools: [] },
    })
    expect(body.messages.at(-1)).toEqual({
      role: 'system',
      clear_at: 'next_user_message',
      content: 'Runner reminder',
    })
    const headers = new Headers()
    setOAuthHeaders(headers, 'sk-ant-oat01-synthetic', { body })
    expect(headers.get('anthropic-beta')?.split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
    const apiBody = await build(reply('a'), {
      sessionId: 'ses_runner_notes_oc1',
      modelId: 'claude-opus-5-5',
      turnEndNote: { tools: [] },
    })
    expect(apiBody.messages.some((m: any) => m.clear_at)).toBe(false)
    await Promise.resolve()
    expect(reports).toContainEqual({
      kind: 'turn_note_skipped',
      after_tool_use_id: 'a_0',
      reason: 'not_oauth',
    })
  })

  test('inserts the exact note after results, before signing, with its beta', async () => {
    const body = await build([
      { role: 'user', content: 'Question' },
      ...reply('a'),
    ])
    expect(body.messages.at(-1)).toEqual(note)
    expect(body.messages[1].content[1].name).toBe('mcp_Board')
    const headers = new Headers()
    setOAuthHeaders(headers, 'sk-ant-oat01-synthetic', { body })
    expect(headers.get('anthropic-beta')?.split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
  })

  test('N N+1 N+2 retain the serialized history prefix through all earlier notes', async () => {
    const history = [{ role: 'user', content: 'Question' }, ...reply('a')]
    const first = await build(history)
    expect(first.messages.at(-1)).toEqual(note)
    history.push(
      { role: 'assistant', content: [{ type: 'text', text: 'No new work.' }] },
      { role: 'user', content: 'Next question' },
      ...reply('b', ['ctx_reduce']),
    )
    const second = await build(history, {}, undefined, ['unrelated'])
    history.push(
      { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }] },
      { role: 'user', content: 'Third question' },
      ...reply('c'),
    )
    const third = await build(history, {}, undefined, [])
    for (const later of [second, third]) {
      expect(
        JSON.stringify(later.messages.slice(0, first.messages.length)),
      ).toBe(JSON.stringify(first.messages))
      const { messages: _m, system: _s, tools: _t, ...fields } = later
      const { messages: _fm, system: _fs, tools: _ft, ...initialFields } = first
      expect(fields).toEqual(initialFields)
      expect(later.system.slice(1)).toEqual(first.system.slice(1))
      expect(later.system[0].text.replace(/cch=[0-9a-f]{5}/, 'cch=00000')).toBe(
        first.system[0].text.replace(/cch=[0-9a-f]{5}/, 'cch=00000'),
      )
    }
    expect(
      JSON.stringify(third.messages.slice(0, second.messages.length)),
    ).toBe(JSON.stringify(second.messages))
    expect(
      third.messages.filter((m: { clear_at?: string }) => m.clear_at),
    ).toHaveLength(3)
  })

  test.each(['', ' \n\t'])(
    'no visible text means no note (%j), including on older turns',
    async (text) => {
      const round = reply('a', ['board'], text)
      ;(round[0] as any).content.push({ type: 'text', text: ' \n\t' })
      const history = [{ role: 'user', content: 'Question' }, ...round]
      const first = await build(history)
      history.push(
        { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
        { role: 'user', content: 'Next' },
      )
      const second = await build(history)
      for (const body of [first, second])
        expect(body.messages).not.toContainEqual(note)
    },
  )

  test.each([349, 350])(
    'visible reply boundary: %i characters',
    async (length) => {
      const body = await build([
        { role: 'user', content: 'Question' },
        ...reply('a', ['board'], 'a'.repeat(length)),
      ])
      expect(body.messages.some((m: { clear_at?: string }) => m.clear_at)).toBe(
        length === 350,
      )
    },
  )

  test('mixed housekeeping and working tools never qualify', async () => {
    const body = await build([
      { role: 'user', content: 'Question' },
      ...reply('a', ['board', 'bash']),
    ])
    expect(body.messages).not.toContainEqual(note)
  })

  test('disabled, API-key and unsupported requests have no note; custom host names work', async () => {
    const history = [{ role: 'user', content: 'Question' }, ...reply('a')]
    for (const options of [
      { turnEndNote: { tools: [] } },
      { turnEndNoteEnabled: false },
    ]) {
      expect((await build(history, options)).messages).not.toContainEqual(note)
    }
    expect(
      (await build(history, {}, 'claude-sonnet-4-5')).messages,
    ).not.toContainEqual(note)
    const custom = [
      { role: 'user', content: 'Question' },
      ...reply('a', ['my_cleanup']),
    ]
    expect(
      (
        await build(custom, { turnEndNote: { tools: ['my_cleanup'] } })
      ).messages.at(-1),
    ).toEqual(note)
    expect(
      (await build(history, { turnEndNote: { tools: ['mcp_Board'] } }))
        .messages,
    ).not.toContainEqual(note)
  })

  test('a directly following user suppresses only that note, not later notes', async () => {
    const history = [{ role: 'user', content: 'Question' }, ...reply('a')]
    const first = await build(history)
    const later = await build([
      ...history,
      { role: 'user', content: 'Next' },
      ...reply('b'),
    ])
    expect(later.messages.slice(0, first.messages.length - 1)).toEqual(
      first.messages.slice(0, -1),
    )
    expect(later.messages[3]).toEqual({ role: 'user', content: 'Next' })
    expect(later.messages.at(-1)).toEqual(note)
    expect(
      later.messages.filter((m: { clear_at?: string }) => m.clear_at),
    ).toHaveLength(1)
  })

  test.each(['explicit', 'hybrid', 'automatic'] as const)(
    'cache mode %s never anchors a note',
    async (mode) => {
      const body = await build(
        [{ role: 'user', content: 'Question' }, ...reply('a')],
        { cache1hEnabled: true, cache1hMode: mode },
      )
      expect(body.messages.at(-1)).toEqual(note)
    },
  )

  test('hybrid lookback counts the note but never anchors it', async () => {
    const history = [
      { role: 'user', content: 'Question' },
      ...reply('a'),
      {
        role: 'assistant',
        content: Array.from({ length: 18 }, () => ({
          type: 'text',
          text: 'continued',
        })),
      },
      { role: 'user', content: 'Next' },
    ]
    const body = await build(history, {
      cache1hEnabled: true,
      cache1hMode: 'hybrid',
    })
    expect(body.messages[3]).toEqual(note)
    expect(body.messages[2].content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(body.messages.at(-1).content[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
  })

  test('native effort controls between calls and results compose with notes', async () => {
    const [assistant, results] = reply('a')
    const effort = {
      role: 'system',
      content: [],
      output_config: { effort: 'low' },
    }
    const body = await build([
      { role: 'user', content: 'Question' },
      assistant,
      effort,
      results,
    ])
    expect(body.messages[2]).toEqual(effort)
    expect(body.messages.at(-1)).toEqual(note)
  })
})
