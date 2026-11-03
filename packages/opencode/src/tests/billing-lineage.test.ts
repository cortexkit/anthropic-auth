import { describe, expect, test } from 'bun:test'
import {
  BILLING_LINEAGE_REQUEST_HEADER,
  BillingLineageTracker,
  extractAnthropicRequestId,
} from '../billing-lineage'

function user(id: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    info: { id, sessionID: 'ses_test', role: 'user', ...extra },
    parts: [{ type: 'text', text }],
  }
}

function assistant(id: string) {
  return {
    info: { id, sessionID: 'ses_test', role: 'assistant' },
    parts: [{ type: 'text', text: 'answer' }],
  }
}

describe('BillingLineageTracker', () => {
  test('keeps one prompt id across tool-loop requests and advances previous request id after success', () => {
    let nextPrompt = 0
    let nextToken = 0
    const tracker = new BillingLineageTracker({
      createPromptId: () =>
        `00000000-0000-4000-8000-${String(++nextPrompt).padStart(12, '0')}`,
      createRequestToken: () => `token-${++nextToken}`,
    })

    tracker.observeMessages([user('msg_user_1', 'hello')])

    const firstHeaders: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'ses_test',
        messageId: 'msg_user_1',
        agent: 'build',
        headers: firstHeaders,
      }),
    ).toBe(true)
    for (let lookup = 0; lookup < 2; lookup++)
      expect(
        tracker.promptIdForHeader(firstHeaders[BILLING_LINEAGE_REQUEST_HEADER]),
      ).toBe('00000000-0000-4000-8000-000000000001')
    expect(tracker.promptIdForHeader('missing')).toBeUndefined()
    const first = tracker.resolveHeader(
      firstHeaders[BILLING_LINEAGE_REQUEST_HEADER],
    )
    expect(first).toEqual({
      sessionId: 'ses_test',
      messageId: 'msg_user_1',
      promptId: '00000000-0000-4000-8000-000000000001',
      requestToken: 'token-1',
      generation: 0,
      sequence: 1,
    })

    // Provider retries run chat.headers again without rerunning the message transform.
    const retryHeaders: Record<string, string> = {}
    tracker.markHeaders({
      sessionId: 'ses_test',
      messageId: 'msg_user_1',
      agent: 'build',
      headers: retryHeaders,
    })
    const retry = tracker.resolveHeader(
      retryHeaders[BILLING_LINEAGE_REQUEST_HEADER],
    )
    expect(retry?.promptId).toBe(first?.promptId)
    expect(retry?.previousRequestId).toBeUndefined()

    expect(tracker.commit(first, 'req_011111111111111111111111')).toBe(true)
    expect(
      tracker.resolveHeader(firstHeaders[BILLING_LINEAGE_REQUEST_HEADER]),
    ).toMatchObject({
      promptId: first?.promptId,
      previousRequestId: 'req_011111111111111111111111',
    })

    tracker.observeMessages([
      user('msg_user_1', 'hello'),
      assistant('msg_assistant_1'),
    ])
    const toolLoopHeaders: Record<string, string> = {}
    tracker.markHeaders({
      sessionId: 'ses_test',
      messageId: 'msg_user_1',
      agent: 'build',
      headers: toolLoopHeaders,
    })
    const toolLoop = tracker.resolveHeader(
      toolLoopHeaders[BILLING_LINEAGE_REQUEST_HEADER],
    )
    expect(toolLoop).toMatchObject({
      promptId: first?.promptId,
      previousRequestId: 'req_011111111111111111111111',
    })
    expect(tracker.commit(toolLoop, 'req_022222222222222222222222')).toBe(true)

    tracker.observeMessages([
      user('msg_user_1', 'hello'),
      assistant('msg_assistant_1'),
      user('msg_user_2', 'continue'),
    ])
    const nextTurnHeaders: Record<string, string> = {}
    tracker.markHeaders({
      sessionId: 'ses_test',
      messageId: 'msg_user_2',
      agent: 'build',
      headers: nextTurnHeaders,
    })
    expect(
      tracker.resolveHeader(nextTurnHeaders[BILLING_LINEAGE_REQUEST_HEADER]),
    ).toMatchObject({
      promptId: '00000000-0000-4000-8000-000000000002',
      previousRequestId: 'req_022222222222222222222222',
    })
  })

  test('does not let an older concurrent response rewind the request chain', () => {
    let nextToken = 0
    const tracker = new BillingLineageTracker({
      createPromptId: () => '00000000-0000-4000-8000-000000000001',
      createRequestToken: () => `token-${++nextToken}`,
    })
    tracker.observeMessages([user('msg_user_1', 'hello')])

    const firstHeaders: Record<string, string> = {}
    const secondHeaders: Record<string, string> = {}
    tracker.markHeaders({
      sessionId: 'ses_test',
      messageId: 'msg_user_1',
      headers: firstHeaders,
    })
    tracker.markHeaders({
      sessionId: 'ses_test',
      messageId: 'msg_user_1',
      headers: secondHeaders,
    })
    const first = tracker.resolveHeader(
      firstHeaders[BILLING_LINEAGE_REQUEST_HEADER],
    )
    const second = tracker.resolveHeader(
      secondHeaders[BILLING_LINEAGE_REQUEST_HEADER],
    )

    expect(tracker.commit(second, 'req_022222222222222222222222')).toBe(true)
    expect(tracker.commit(first, 'req_011111111111111111111111')).toBe(false)
    expect(
      tracker.resolveHeader(secondHeaders[BILLING_LINEAGE_REQUEST_HEADER])
        ?.previousRequestId,
    ).toBe('req_022222222222222222222222')
  })

  test('omits lineage for synthetic, compaction, and background-agent turns', () => {
    const tracker = new BillingLineageTracker()
    const cases = [
      {
        message: user('msg_synthetic', '[lane start]', { synthetic: true }),
        agent: 'build',
      },
      {
        message: {
          info: { id: 'msg_compaction', sessionID: 'ses_test', role: 'user' },
          parts: [{ type: 'compaction', auto: true }],
        },
        agent: 'build',
      },
      {
        message: user('msg_info_title', 'title this', { agent: 'title' }),
        agent: 'build',
      },
      { message: user('msg_title', 'title this'), agent: 'title' },
      { message: user('msg_summary', 'summarize'), agent: 'summary' },
      { message: user('msg_compact_agent', 'compact'), agent: 'compaction' },
    ]

    for (const entry of cases) {
      tracker.observeMessages([entry.message])
      const headers: Record<string, string> = {}
      expect(
        tracker.markHeaders({
          sessionId: 'ses_test',
          messageId: entry.message.info.id,
          agent: entry.agent,
          headers,
        }),
      ).toBe(false)
      expect(headers[BILLING_LINEAGE_REQUEST_HEADER]).toBeUndefined()
    }
  })

  test('clearing a session invalidates in-flight commits and resets the chain', () => {
    let nextToken = 0
    const tracker = new BillingLineageTracker({
      createPromptId: () => '00000000-0000-4000-8000-000000000001',
      createRequestToken: () => `token-${++nextToken}`,
    })
    tracker.observeMessages([user('msg_user_1', 'hello')])
    const headers: Record<string, string> = {}
    tracker.markHeaders({
      sessionId: 'ses_test',
      messageId: 'msg_user_1',
      agent: 'build',
      headers,
    })
    const stale = tracker.resolveHeader(headers[BILLING_LINEAGE_REQUEST_HEADER])

    tracker.clearSession('ses_test')
    expect(tracker.commit(stale, 'req_011111111111111111111111')).toBe(false)

    tracker.observeMessages([user('msg_user_1', 'hello')])
    const resetHeaders: Record<string, string> = {}
    tracker.markHeaders({
      sessionId: 'ses_test',
      messageId: 'msg_user_1',
      agent: 'build',
      headers: resetHeaders,
    })
    expect(
      tracker.resolveHeader(resetHeaders[BILLING_LINEAGE_REQUEST_HEADER])
        ?.previousRequestId,
    ).toBeUndefined()
  })
})

describe('extractAnthropicRequestId', () => {
  test('accepts Anthropic request ids and rejects malformed or non-Anthropic ids', () => {
    expect(
      extractAnthropicRequestId(
        new Headers({ 'request-id': 'req_011111111111111111111111' }),
      ),
    ).toBe('req_011111111111111111111111')
    expect(
      extractAnthropicRequestId(new Headers({ 'request-id': 'other_123' })),
    ).toBeUndefined()
    expect(
      extractAnthropicRequestId(
        new Headers({ 'request-id': 'req_bad; cc_prompt_id=inject' }),
      ),
    ).toBeUndefined()
  })
})
