import { afterEach, expect, test } from 'bun:test'
import type {
  ClaudeCodeIdentity,
  ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'
import type { Message } from '@earendil-works/pi-ai'
import { buildAnthropicRequest } from '../convert.ts'
import planNotes from './fixtures/plan-notes.json'

const reportsFixture = await Bun.file(
  new URL('./fixtures/reports.jsonl', import.meta.url),
).text()
const reports = reportsFixture
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const [supported, unsupported, unanchored] = reports
const { after_user_timestamp: anchor, texts } = planNotes[0]!
const wireNotes = texts.map((content) => ({ role: 'system', content }))
const identity: ClaudeCodeIdentity = {
  deviceId: 'd'.repeat(64),
  accountUuid: '00000000-0000-4000-8000-000000000001' as ProviderAccountUuid,
  sessionId: '11111111-2222-4333-8444-555555555555',
}
const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const original = globals[key]
const sessionId = 'pi-plan-notes'

afterEach(() => {
  if (original === undefined) delete globals[key]
  else globals[key] = original
})

function routing(accessor?: () => unknown) {
  const seen: unknown[] = []
  globals[key] = () => ({
    ...(accessor ? { plan_notes: accessor } : {}),
    report: (payload: unknown) => seen.push(payload),
  })
  return seen
}

const user = (content: string, timestamp: number): Message => ({
  role: 'user',
  content,
  timestamp,
})
const answer = (text: string): Message =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: 1,
  }) as Message

function request(messages: Message[], model = 'claude-opus-5-5', oauth = true) {
  return buildAnthropicRequest(
    model,
    { messages, systemPrompt: 'Pi documentation' },
    { sessionId },
    { enabled: true, mode: 'automatic' },
    false,
    oauth ? identity : undefined,
    { apiKey: !oauth },
  )
}

test('Pi plan notes follow the converted user and keep identical bytes on the next request', async () => {
  const seen = routing(() => structuredClone(planNotes))
  const history = [user('  ', anchor - 1), user('Start', anchor)]
  const first = await request(history)
  expect(first.body.messages[0]?.content).toEqual([
    expect.objectContaining({ text: 'Pi documentation' }),
    { type: 'text', text: 'Start' },
  ])
  expect(first.body.messages.slice(1)).toEqual(wireNotes)
  const second = await request([
    ...history,
    answer('Answer'),
    user('Next', anchor + 1),
  ])
  const firstWire = JSON.parse(first.bodyText)
  const secondWire = JSON.parse(second.bodyText)
  expect(JSON.stringify(secondWire.messages.slice(1, 3))).toBe(
    JSON.stringify(firstWire.messages.slice(1)),
  )
  expect(
    firstWire.system.some((block: { text: string }) =>
      texts.includes(block.text),
    ),
  ).toBe(false)
  expect(first.bodyText).not.toContain('timestamp')
  expect(seen).toContainEqual(supported)
})

test.each([
  ['absent', [user('  ', anchor), user('Different user', anchor + 1)]],
  [
    'ambiguous',
    [user('First', anchor), answer('Answer'), user('Second', anchor)],
  ],
] as const)(
  'Pi plan notes report a %s anchor and leave wire bytes alone',
  async (_name, messages) => {
    const baseline = await request([...messages])
    const seen = routing(() => planNotes)
    const noted = await request([...messages])
    expect(noted.bodyText).toBe(baseline.bodyText)
    expect(seen).toContainEqual(unanchored)
  },
)

test('Pi plan notes report an unsupported model and leave wire bytes alone', async () => {
  const messages = [user('Start', anchor)]
  const baseline = await request(messages, unsupported.model)
  const seen = routing(() => planNotes)
  const noted = await request(messages, unsupported.model)
  expect(noted.bodyText).toBe(baseline.bodyText)
  expect(seen).toEqual([unsupported])
})

test('Pi plan notes do not change API-key request bytes', async () => {
  const messages = [user('Start', anchor)]
  const baseline = await request(messages, undefined, false)
  routing(() => planNotes)
  expect((await request(messages, undefined, false)).bodyText).toBe(
    baseline.bodyText,
  )
})

test.each([
  ['missing', undefined],
  [
    'throwing',
    () => {
      throw new Error('unavailable')
    },
  ],
  ['promise', () => Promise.resolve(planNotes)],
  [
    'junk',
    () => [...planNotes, { after_user_timestamp: anchor, texts: 'junk' }],
  ],
  ['empty', () => []],
] as const)(
  'Pi plan notes leave request bytes alone when the accessor is %s',
  async (_name, accessor) => {
    const messages = [user('Start', anchor)]
    const baseline = await request(messages)
    routing(accessor)
    expect((await request(messages)).bodyText).toBe(baseline.bodyText)
  },
)

test('Pi plan notes never wait for a routing report', async () => {
  const seen: unknown[] = []
  globals[key] = () => ({
    plan_notes: () => planNotes,
    report: (report: unknown) => {
      seen.push(report)
      return new Promise(() => {})
    },
  })
  const result = await request([user('Start', anchor)])
  expect(result.body.messages.slice(1)).toEqual(wireNotes)
  expect(seen).toContainEqual(supported)
})
