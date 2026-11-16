import { expect, test } from 'bun:test'
import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { PiForkEffortSnapshots, piForkHeadSession } from '../forks.ts'

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
