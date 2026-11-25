import { expect, test } from 'bun:test'
import {
  fixturePoint,
  matchesRefusalCredit,
  RefusalMock,
} from '../src/mock-refusal'
import { MockAnthropicServer } from '../src/mock-anthropic'

const original = {
  model: 'claude-opus-5-5',
  max_tokens: 32,
  stream: true,
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2; cch=12345;',
    },
  ],
  thinking: { type: 'adaptive' },
  tool_choice: { type: 'auto' },
  messages: [
    { role: 'user', content: [{ type: 'text', text: '[refusal-fixture:2]' }] },
  ],
}
const emitted = [
  {
    type: 'thinking',
    thinking: 'thought from claude-opus-5-5',
    signature: 'signature:claude-opus-5-5',
  },
]
const retry = {
  ...original,
  model: 'claude-opus-4-8',
  max_tokens: 64,
  fallback_credit_token: 'fixture-token',
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2; cch=abcde;',
    },
  ],
}

test('credit accepts only permitted field changes and the exact optional assistant prefill', () => {
  expect(matchesRefusalCredit(original, retry, emitted)).toBe(true)
  expect(
    matchesRefusalCredit(
      original,
      {
        ...retry,
        messages: [...retry.messages, { role: 'assistant', content: emitted }],
      },
      emitted,
    ),
  ).toBe(true)
  for (const change of [
    { thinking: { type: 'disabled' } },
    { tool_choice: { type: 'any' } },
    {
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=3; cch=abcde;',
        },
      ],
    },
    {
      messages: [
        ...retry.messages,
        { role: 'assistant', content: [{ ...emitted[0], signature: 'wrong' }] },
      ],
    },
    {
      messages: [
        ...retry.messages,
        { role: 'assistant', content: emitted },
        { role: 'assistant', content: emitted },
      ],
    },
  ])
    expect(
      matchesRefusalCredit(original, { ...retry, ...change }, emitted),
    ).toBe(false)
})

test('tool-only continuation retains the fixture, but a mixed tool result and new prompt does not', () => {
  const result = {
    type: 'tool_result',
    tool_use_id: 'fixture',
    content: 'done',
  }
  expect(
    fixturePoint({
      ...original,
      messages: [...original.messages, { role: 'user', content: [result] }],
    }),
  ).toBe(2)
  expect(
    fixturePoint({
      ...original,
      messages: [
        ...original.messages,
        {
          role: 'user',
          content: [result, { type: 'text', text: 'New prompt' }],
        },
      ],
    }),
  ).toBeUndefined()
  expect(
    fixturePoint({
      messages: [
        { role: 'user', content: 'Title this prompt:\n[refusal-fixture:2]' },
      ],
    }),
  ).toBeUndefined()
})

test('mock streams a signed refusal and validates real credited requests', async () => {
  const fixture = new RefusalMock(() => ({}))
  const server = new MockAnthropicServer(fixture)
  const { baseURL } = await server.start()
  try {
    const send = (body: Record<string, unknown>) =>
      fetch(`${baseURL}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    const refused = await (await send(original)).text()
    const delta = refused
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)))
      .find((event) => event.type === 'message_delta').delta
    expect(refused).toContain('signature:claude-opus-5-5')
    expect(delta).toMatchObject({
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'cyber',
        fallback_has_prefill_claim: true,
      },
    })
    const credited = {
      ...retry,
      fallback_credit_token: delta.stop_details.fallback_credit_token,
    }
    const invalid = await send({ ...credited, thinking: { type: 'disabled' } })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain(
      'does not match the original refused request',
    )
    const valid = await send(credited)
    expect(valid.status).toBe(200)
    expect(await valid.text()).toContain('signature:claude-opus-4-8')
    expect(fixture.events.map(({ kind }) => kind)).toEqual([
      'refusal',
      'credit-rejected',
      'credited',
    ])
    expect(server.requests()).toHaveLength(3)
  } finally {
    await server.stop()
  }
})
