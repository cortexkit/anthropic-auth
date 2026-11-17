import { expect, test } from 'bun:test'
import { applyMidConversationOutputConfig } from '@cortexkit/anthropic-auth-core'
import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai'
import {
  applyPiForkEffort,
  PiForkEffortSnapshots,
  piForkEffortHint,
  piForkHeadSession,
} from '../forks.ts'

const context: Context = {
  messages: [{ role: 'user', content: 'Base question', timestamp: 1 }],
}

test('only valid, distinct fork session options opt in', () => {
  for (const options of [
    undefined,
    {},
    { sessionId: 'fork' },
    { cortexkitFork: { headSessionId: 'head' } },
    { sessionId: 'fork', cortexkitFork: null },
    { sessionId: 'fork', cortexkitFork: { headSessionId: '' } },
    { sessionId: 'fork', cortexkitFork: { headSessionId: ' ' } },
    { sessionId: 'fork', cortexkitFork: { headSessionId: 'fork' } },
  ])
    expect(piForkHeadSession(options as SimpleStreamOptions)).toBeUndefined()
  expect(
    piForkHeadSession({
      sessionId: 'fork',
      cortexkitFork: { headSessionId: 'head' },
    } as SimpleStreamOptions),
  ).toBe('head')
})

test('fork effort snapshots keep digests only, preserve the old base and clear on shutdown', () => {
  const snapshots = new PiForkEffortSnapshots()
  const transitions = [{ afterAssistantMessages: 0, effort: 'low' as const }]
  snapshots.record('head', context, transitions)
  snapshots.record(
    'head',
    { messages: [{ role: 'user', content: 'Compacted head', timestamp: 2 }] },
    [],
  )
  transitions.length = 0
  const matched = snapshots.match('head', {
    messages: [
      ...context.messages,
      { role: 'user', content: 'Fork question', timestamp: 3 },
    ],
  })
  expect(matched).toEqual({
    messageCount: 1,
    transitions: [{ afterAssistantMessages: 0, effort: 'low' }],
  })
  const bytes = JSON.stringify(snapshots, (_key, value) =>
    value instanceof Map ? [...value] : value,
  )
  expect(bytes).not.toContain('Base question')
  expect(bytes).not.toContain('Compacted head')
  snapshots.forget('head')
  expect(() => snapshots.match('head', context)).toThrow(
    'fork_base_unavailable',
  )
})

test('fork effort provenance uses the longest prefix and retains only eight bases', () => {
  const snapshots = new PiForkEffortSnapshots()
  for (let count = 1; count <= 9; count++)
    snapshots.record(
      'head',
      {
        messages: Array.from({ length: count }, (_, i) => ({
          role: 'user',
          content: `Question ${i}`,
          timestamp: i,
        })),
      },
      [{ afterAssistantMessages: 0, effort: count === 9 ? 'high' : 'low' }],
    )
  expect(() =>
    snapshots.match('head', {
      messages: [{ role: 'user', content: 'Question 0', timestamp: 0 }],
    }),
  ).toThrow('fork_base_unavailable')
  const longest = snapshots.match('head', {
    messages: Array.from({ length: 10 }, (_, i) => ({
      role: 'user',
      content: `Question ${i}`,
      timestamp: i,
    })),
  })
  expect(longest.messageCount).toBe(9)
  expect(longest.transitions[0]?.effort).toBe('high')
})

test('the fork effort hint is read only from a valid fork', () => {
  const fork = (cortexkitFork: unknown, sessionId = 'fork') =>
    piForkEffortHint({ sessionId, cortexkitFork } as SimpleStreamOptions)
  for (const effort of ['low', 'medium', 'high'] as const)
    expect(fork({ headSessionId: 'head', effort })).toBe(effort)
  for (const effort of [undefined, 'xhigh', 'max', 'minimal', 'LOW', 1, null])
    expect(fork({ headSessionId: 'head', effort })).toBeUndefined()
  expect(fork({ effort: 'low' })).toBeUndefined()
  expect(fork({ headSessionId: 'fork', effort: 'low' })).toBeUndefined()
  expect(
    piForkEffortHint({ effort: 'low' } as unknown as SimpleStreamOptions),
  ).toBeUndefined()
})

function forkBody(model: string, thinking: Record<string, unknown>) {
  return {
    model,
    thinking,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'Base question' },
      { role: 'assistant', content: 'Head answer' },
      { role: 'user', content: 'Fork question' },
    ],
  } as Record<string, unknown>
}

test('the fork effort hint becomes one effort change at the question', () => {
  const body = forkBody('claude-sonnet-5-5', { type: 'adaptive' })
  const history = [{ afterAssistantMessages: 0, effort: 'high' as const }]
  expect(applyPiForkEffort(body, history, 'low')).toBe('low')
  expect(body.output_config).toEqual({ effort: 'high' })
  expect(body.messages).toEqual([
    { role: 'user', content: 'Base question' },
    { role: 'assistant', content: 'Head answer' },
    { role: 'system', content: [], output_config: { effort: 'low' } },
    { role: 'user', content: 'Fork question' },
  ])
})

test('the fork effort hint leaves Sonnet 5.5 between_tools requests as the base history built them', () => {
  // Anthropic rejects a differing per-message effort on between_tools.
  const history = [
    { afterAssistantMessages: 0, effort: 'high' as const },
    { afterAssistantMessages: 1, effort: 'medium' as const },
  ]
  const expected = forkBody('claude-sonnet-5-5', { type: 'between_tools' })
  applyMidConversationOutputConfig(expected, history)
  const body = forkBody('claude-sonnet-5-5', { type: 'between_tools' })
  expect(applyPiForkEffort(body, history, 'low')).toBeUndefined()
  expect(JSON.stringify(body)).toBe(JSON.stringify(expected))
})

test('the fork effort hint is dropped when the question does not follow a reply', () => {
  // The marker would land before the earlier user message, inside the
  // head's cached prefix.
  const body = forkBody('claude-fable-5-1', { type: 'adaptive' })
  ;(body.messages as unknown[]).push({ role: 'user', content: 'Follow-up' })
  const expected = structuredClone(body)
  const history = [{ afterAssistantMessages: 0, effort: 'high' as const }]
  applyMidConversationOutputConfig(expected, history)
  expect(applyPiForkEffort(body, history, 'low')).toBeUndefined()
  expect(JSON.stringify(body)).toBe(JSON.stringify(expected))
})
