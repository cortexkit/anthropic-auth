import { describe, expect, test } from 'bun:test'
import type { Message } from '@earendil-works/pi-ai'
import {
  collectPiEffortHistory,
  collectPiRequestEffortHistory,
  deriveContextEntries,
} from '../effort-history.ts'

const entry = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({ id, type, ...extra })

describe('Pi Fable 5.1 effort history', () => {
  test('maps thinking-level changes to assistant boundaries', () => {
    const branch = [
      entry('t0', 'thinking_level_change', { thinkingLevel: 'minimal' }),
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'high' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('tool', 'message', { message: { role: 'toolResult' } }),
    ]
    expect(collectPiEffortHistory(branch, branch)).toEqual([
      { afterAssistantMessages: 0, effort: 'low' },
      { afterAssistantMessages: 1, effort: 'high' },
      { afterAssistantMessages: 2, effort: 'xhigh' },
    ])
  })

  test('folds pre-compaction effort into the new prefix and tracks later changes', () => {
    const fullBranch = [
      entry('t0', 'thinking_level_change', { thinkingLevel: 'low' }),
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'high' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
      entry('compact', 'compaction', { firstKeptEntryId: 't1' }),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('u3', 'message', { message: { role: 'user' } }),
    ]
    const contextEntries = [
      fullBranch[6]!,
      fullBranch[3]!,
      fullBranch[4]!,
      fullBranch[5]!,
      fullBranch[7]!,
      fullBranch[8]!,
    ]
    expect(deriveContextEntries(fullBranch)).toEqual(contextEntries)
    expect(collectPiEffortHistory(contextEntries, fullBranch)).toEqual([
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'xhigh' },
    ])
  })

  test('uses the request model default for turns without an adaptive level', () => {
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'low' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'off' }),
      entry('u3', 'message', { message: { role: 'user' } }),
    ]
    expect(collectPiEffortHistory(branch, branch, 'medium')).toEqual([
      { afterAssistantMessages: 0, effort: 'medium' },
      { afterAssistantMessages: 1, effort: 'low' },
      { afterAssistantMessages: 2, effort: 'medium' },
    ])
    expect(collectPiEffortHistory(branch, branch)[0]).toEqual({
      afterAssistantMessages: 0,
      effort: 'high',
    })
  })

  test('leaves an in-flight reply at its starting effort even if Pi persists it after the change', () => {
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('t1', 'thinking_level_change', {
        thinkingLevel: 'xhigh',
        timestamp: new Date(20).toISOString(),
      }),
      entry('a1', 'message', { message: { role: 'assistant', timestamp: 10 } }),
      entry('u2', 'message', { message: { role: 'toolResult' } }),
    ]
    expect(collectPiEffortHistory(branch, branch)).toEqual([
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'xhigh' },
    ])
  })

  test('does not treat an ambiguous timestamp as a retained branch assistant', () => {
    const first = { role: 'assistant', timestamp: 10 } as Message
    const second = { role: 'assistant', timestamp: 10 } as Message
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: first }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: second }),
      entry('u3', 'message', { message: { role: 'user' } }),
    ]
    expect(
      collectPiRequestEffortHistory(branch, [{ ...first }], 'high'),
    ).toEqual([
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'xhigh', beforeNewestUser: true },
    ])
    expect(
      collectPiRequestEffortHistory(branch, [first, second], 'high'),
    ).toEqual([
      { afterAssistantMessages: 0, effort: 'high' },
      { afterAssistantMessages: 1, effort: 'xhigh' },
    ])
  })

  test('uses the effort of the oldest verified retained reply when alignment fails later', () => {
    const retained = { role: 'assistant', timestamp: 20 } as Message
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant', timestamp: 10 } }),
      entry('t1', 'thinking_level_change', { thinkingLevel: 'medium' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('a2', 'message', { message: retained }),
      entry('t2', 'thinking_level_change', { thinkingLevel: 'xhigh' }),
      entry('u3', 'message', { message: { role: 'user' } }),
    ]
    const unknown = { ...retained, timestamp: 30 }
    expect(
      collectPiRequestEffortHistory(branch, [retained, unknown], 'high'),
    ).toEqual([
      { afterAssistantMessages: 0, effort: 'medium' },
      { afterAssistantMessages: 2, effort: 'xhigh', beforeNewestUser: true },
    ])
  })
})

// The host accessor these entries came from — buildContextEntries() — exists on
// Pi but not on Oh My Pi 18.x, so the compaction trim is derived here from the
// branch path both hosts expose (issue #200).
describe('Pi context entries', () => {
  test('carries an uncompacted branch through unchanged', () => {
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
    ]
    const derived = deriveContextEntries(branch)
    expect(derived).toEqual(branch)
    expect(derived).not.toBe(branch)
  })

  test('drops entries older than the compaction it retains from', () => {
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('a1', 'message', { message: { role: 'assistant' } }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('compact', 'compaction', { firstKeptEntryId: 'u2' }),
      entry('a2', 'message', { message: { role: 'assistant' } }),
    ]
    expect(deriveContextEntries(branch).map((item) => item.id)).toEqual([
      'compact',
      'u2',
      'a2',
    ])
  })

  test('retains nothing before a compaction with an unreachable first kept id', () => {
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('compact', 'compaction', { firstKeptEntryId: 'pruned' }),
      entry('u2', 'message', { message: { role: 'user' } }),
    ]
    expect(deriveContextEntries(branch).map((item) => item.id)).toEqual([
      'compact',
      'u2',
    ])
  })

  test('anchors on the last compaction when a branch has several', () => {
    const branch = [
      entry('u1', 'message', { message: { role: 'user' } }),
      entry('c1', 'compaction', { firstKeptEntryId: 'u1' }),
      entry('u2', 'message', { message: { role: 'user' } }),
      entry('c2', 'compaction', { firstKeptEntryId: 'u2' }),
      entry('u3', 'message', { message: { role: 'user' } }),
    ]
    expect(deriveContextEntries(branch).map((item) => item.id)).toEqual([
      'c2',
      'u2',
      'u3',
    ])
  })
})
