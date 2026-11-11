import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRecoveryThinkingObserver,
  RecoveryThinkingStore,
  recoveryThinkingDigest,
  stripRecoveryRoundThinking,
} from '../recovery-thinking'

type Block = Record<string, unknown>
type Message = { role: string; content: string | Block[] }

const thinking = (signature: string): Block => ({
  type: 'thinking',
  thinking: 'synthetic reasoning',
  signature,
})
const redacted = (data: string): Block => ({ type: 'redacted_thinking', data })
const toolUse = (id: string): Block => ({
  type: 'tool_use',
  id,
  name: 'read',
  input: {},
})
const toolResult = (id: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
})
const digest = (signature: string) =>
  recoveryThinkingDigest('thinking', signature)

function signatures(body: { messages: Message[] }) {
  return body.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content
          .filter((block) => block.type === 'thinking')
          .map((block) => block.signature)
      : [],
  )
}

/**
 * The shape of the refused request: one Anthropic turn in which the source
 * model thought several times, refused after one more thinking block, and the
 * fallback model then continued the same turn with its own thinking.
 */
function midTurnRecoveryBody() {
  return {
    model: 'claude-fable-5-2',
    messages: [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: [thinking('src-1'), toolUse('t1')] },
      toolResult('t1'),
      { role: 'assistant', content: [toolUse('t2')] },
      toolResult('t2'),
      { role: 'assistant', content: [thinking('src-2'), toolUse('t3')] },
      toolResult('t3'),
      {
        role: 'assistant',
        content: [thinking('src-refused'), thinking('fb-1'), toolUse('t4')],
      },
      toolResult('t4'),
      { role: 'assistant', content: [thinking('fb-2'), toolUse('t5')] },
      toolResult('t5'),
      { role: 'assistant', content: [toolUse('t6')] },
      toolResult('t6'),
      {
        role: 'assistant',
        content: [redacted('fb-redacted'), thinking('fb-3'), toolUse('t7')],
      },
      toolResult('t7'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      { role: 'user', content: 'next' },
    ] as Message[],
  }
}

const roundRecord = new Set([
  digest('fb-1'),
  digest('fb-2'),
  digest('fb-3'),
  recoveryThinkingDigest('redacted_thinking', 'fb-redacted'),
])

describe('stripRecoveryRoundThinking', () => {
  test('drops the fallback round thinking that follows source thinking in the same turn', () => {
    const body = midTurnRecoveryBody()
    const expected = midTurnRecoveryBody()
    expected.messages[7]!.content = [thinking('src-refused'), toolUse('t4')]
    expected.messages[9]!.content = [toolUse('t5')]
    expected.messages[13]!.content = [toolUse('t7')]

    expect(stripRecoveryRoundThinking(body, roundRecord)).toBe(4)
    expect(body).toEqual(expected)
    expect(signatures(body)).toEqual(['src-1', 'src-2', 'src-refused'])
  })

  test('keeps applying after a new user turn so the trimmed prefix stays stable', () => {
    const body = midTurnRecoveryBody()
    body.messages.push(
      { role: 'assistant', content: [thinking('src-later'), toolUse('t8')] },
      toolResult('t8'),
    )
    expect(stripRecoveryRoundThinking(body, roundRecord)).toBe(4)
    expect(signatures(body)).toEqual([
      'src-1',
      'src-2',
      'src-refused',
      'src-later',
    ])
  })

  test('leaves a turn that holds only fallback thinking unchanged', () => {
    const body = {
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: [thinking('fb-1'), toolUse('t1')] },
        toolResult('t1'),
        { role: 'assistant', content: [thinking('fb-2'), toolUse('t2')] },
        toolResult('t2'),
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        { role: 'user', content: 'next' },
      ] as Message[],
    }
    const before = JSON.stringify(body)
    expect(stripRecoveryRoundThinking(body, roundRecord)).toBe(0)
    expect(JSON.stringify(body)).toBe(before)
  })

  test('keeps fallback thinking that comes before any source thinking in its turn', () => {
    const body = {
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: [thinking('fb-1'), toolUse('t1')] },
        toolResult('t1'),
        { role: 'assistant', content: [thinking('src-1'), toolUse('t2')] },
        toolResult('t2'),
        { role: 'assistant', content: [thinking('fb-2'), toolUse('t3')] },
      ] as Message[],
    }
    expect(stripRecoveryRoundThinking(body, roundRecord)).toBe(1)
    expect(signatures(body)).toEqual(['fb-1', 'src-1'])
  })

  test('a user message with text, even beside tool results, starts a new turn', () => {
    for (const boundary of [
      { role: 'user', content: 'plain text' },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'text', text: 'reminder' },
        ],
      },
    ] as Message[]) {
      const body = {
        messages: [
          { role: 'user', content: 'start' },
          { role: 'assistant', content: [thinking('src-1'), toolUse('t1')] },
          boundary,
          { role: 'assistant', content: [thinking('fb-1'), toolUse('t2')] },
        ] as Message[],
      }
      const before = JSON.stringify(body)
      expect(stripRecoveryRoundThinking(body, roundRecord)).toBe(0)
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  test('a mid-conversation system message does not end a turn', () => {
    const body = {
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: [thinking('src-1'), toolUse('t1')] },
        toolResult('t1'),
        { role: 'system', content: '' },
        { role: 'assistant', content: [thinking('fb-1'), toolUse('t2')] },
      ] as Message[],
    }
    expect(stripRecoveryRoundThinking(body, roundRecord)).toBe(1)
    expect(signatures(body)).toEqual(['src-1'])
  })

  test('changes nothing without a record or without recorded blocks', () => {
    for (const record of [new Set<string>(), new Set([digest('other')])]) {
      const body = midTurnRecoveryBody()
      const before = JSON.stringify(body)
      expect(stripRecoveryRoundThinking(body, record)).toBe(0)
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  test('never leaves an assistant message empty', () => {
    const body = {
      messages: [
        { role: 'user', content: 'start' },
        { role: 'assistant', content: [thinking('src-1'), toolUse('t1')] },
        toolResult('t1'),
        { role: 'assistant', content: [thinking('fb-1')] },
      ] as Message[],
    }
    const before = JSON.stringify(body)
    expect(stripRecoveryRoundThinking(body, roundRecord)).toBe(0)
    expect(JSON.stringify(body)).toBe(before)
  })
})

describe('createRecoveryThinkingObserver', () => {
  test('reports a digest for each completed thinking or redacted block', () => {
    const seen: string[] = []
    const observe = createRecoveryThinkingObserver((value) => seen.push(value))
    const events: Record<string, unknown>[] = [
      { type: 'message_start', message: { id: 'msg_1' } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'synthetic' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'fb-' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: '1' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'fb-redacted' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      },
      { type: 'content_block_stop', index: 2 },
      // Cut off before its stop event: never reported.
      {
        type: 'content_block_start',
        index: 3,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'signature_delta', signature: 'fb-cut' },
      },
    ]
    for (const event of events) observe(event)
    expect(seen).toEqual([
      digest('fb-1'),
      recoveryThinkingDigest('redacted_thinking', 'fb-redacted'),
    ])
  })
})

describe('RecoveryThinkingStore', () => {
  async function directory() {
    return join(
      await mkdtemp(join(tmpdir(), 'recovery-thinking-test-')),
      'store',
    )
  }

  test('keeps a session record across restarts, owner-only and without raw signatures', async () => {
    const dir = await directory()
    const first = new RecoveryThinkingStore({ directory: dir })
    first.record('ses_a', 'fable-5-2', digest('fb-1'))
    first.record('ses_a', 'fable-5-2', digest('fb-2'))
    first.record('ses_a', 'opus-5', digest('fb-3'))
    expect(await first.digests('ses_a', 'fable-5-2')).toEqual(
      new Set([digest('fb-1'), digest('fb-2')]),
    )
    await first.flush()

    const files = await readdir(dir)
    expect(files).toHaveLength(1)
    const text = await readFile(join(dir, files[0]!), 'utf8')
    expect(text).not.toContain('fb-1')
    expect(text).not.toContain('ses_a')
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(dir, files[0]!))).mode & 0o777).toBe(0o600)
    }

    const restarted = new RecoveryThinkingStore({ directory: dir })
    expect(await restarted.digests('ses_a', 'fable-5-2')).toEqual(
      new Set([digest('fb-1'), digest('fb-2')]),
    )
    expect(await restarted.digests('ses_a', 'opus-5')).toEqual(
      new Set([digest('fb-3')]),
    )
    expect((await restarted.digests('ses_b', 'fable-5-2')).size).toBe(0)
  })

  test('forgets a deleted session on disk too', async () => {
    const dir = await directory()
    const store = new RecoveryThinkingStore({ directory: dir })
    store.record('ses_a', 'fable-5-2', digest('fb-1'))
    await store.flush()
    store.forgetSession('ses_a')
    await store.flush()
    expect(await readdir(dir)).toEqual([])
    const restarted = new RecoveryThinkingStore({ directory: dir })
    expect((await restarted.digests('ses_a', 'fable-5-2')).size).toBe(0)
  })

  test('drops records left idle past their lifetime on first load', async () => {
    const dir = await directory()
    const store = new RecoveryThinkingStore({ directory: dir })
    store.record('ses_old', 'fable-5-2', digest('fb-1'))
    await store.flush()
    const [file] = await readdir(dir)
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000)
    await utimes(join(dir, file!), old, old)

    const restarted = new RecoveryThinkingStore({ directory: dir })
    expect((await restarted.digests('ses_old', 'fable-5-2')).size).toBe(0)
    expect(await readdir(dir)).toEqual([])
  })
})
