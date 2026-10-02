import { expect, test } from 'bun:test'
import {
  stripEmptyTrailingAssistantMessages,
  TRAILING_ASSISTANT_HISTORY_MESSAGE,
  TrailingAssistantHistoryError,
} from '../request-history.ts'

test('removes only empty assistant trailers from the owned array', () => {
  const user = { role: 'user', content: 'new question' }
  const messages = [
    user,
    { role: 'assistant', content: '' },
    { role: 'assistant', content: ' \n\t' },
    { role: 'assistant', content: [] },
    { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
  ]
  expect(stripEmptyTrailingAssistantMessages(messages)).toBe(4)
  expect(messages).toEqual([user])
  expect(messages[0]).toBe(user)
})

test.each(
  [
    'completed answer',
    undefined,
    null,
    {},
    [''],
    [{ type: 'text' }],
    [{ type: 'text', text: 1 }],
    [{ type: 'text', text: '', signature: 'opaque' }],
    [{ type: 'text', text: '', citations: [] }],
    [{ type: 'thinking', thinking: '', signature: 'opaque' }],
    [{ type: 'redacted_thinking', data: 'opaque' }],
    [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }],
    [{ type: 'unknown', text: '' }],
  ].map((content) => ({ content })),
)(
  'refuses unknown or meaningful content %# without mutating history',
  ({ content }) => {
    const messages = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content },
      { role: 'assistant', content: '' },
    ]
    const before = JSON.stringify(messages)
    expect(() => stripEmptyTrailingAssistantMessages(messages)).toThrow(
      TrailingAssistantHistoryError,
    )
    expect(JSON.stringify(messages)).toBe(before)
  },
)

test('does not inspect earlier assistant content on a normal user-ended request', () => {
  const assistant = {
    role: 'assistant',
    get content() {
      throw new Error('Historical content was accessed')
    },
  }
  const user = {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }],
  }
  const messages = [assistant, user]
  expect(stripEmptyTrailingAssistantMessages(messages)).toBe(0)
  expect(messages).toHaveLength(2)
  expect(messages[1]).toBe(user)
})

test('refusal diagnostics contain only allowlisted block names and shape', () => {
  const messages = [
    { role: 'user', content: 'private question' },
    {
      role: 'assistant',
      content: [{ type: 'private-type', text: 'private answer' }],
    },
  ]
  let caught: unknown
  try {
    stripEmptyTrailingAssistantMessages(messages)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(TrailingAssistantHistoryError)
  if (!(caught instanceof TrailingAssistantHistoryError))
    throw new Error('Expected history refusal')
  expect(caught.message).toBe(TRAILING_ASSISTANT_HISTORY_MESSAGE)
  expect(caught.details).toEqual({
    messageCount: 2,
    trailingMessageIndex: 1,
    emptyMessagesAfter: 0,
    contentShape: 'array',
    contentBlockCount: 1,
    contentBlockTypes: ['other'],
  })
  expect(JSON.stringify(caught)).not.toContain('private')
})
