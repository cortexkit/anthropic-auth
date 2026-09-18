import { describe, expect, test } from 'bun:test'
import {
  applyOpenCodeEffortMarkers,
  EFFORT_ANCHOR_PREFIX,
  EFFORT_MARKER_PREFIX,
  encodeOpenCodeEffortPlan,
  markOpenCodeEffortTransitions,
  OpenCodeEffortPlanTracker,
} from '../effort-history.ts'

const user = (
  id: string,
  sessionID: string,
  modelID: string,
  variant?: string,
  providerID = 'anthropic',
) => ({
  info: {
    id,
    role: 'user',
    sessionID,
    model: { providerID, modelID, variant },
  },
  parts: [{ type: 'text', text: id }],
})

const assistant = (id: string, sessionID: string) => ({
  info: { id, role: 'assistant', sessionID },
  parts: [] as Array<Record<string, unknown>>,
})

function markerTexts(messages: Array<{ parts?: Array<{ text?: unknown }> }>) {
  return messages.flatMap((message) =>
    (message.parts ?? []).flatMap((part) =>
      typeof part.text === 'string' &&
      part.text.startsWith(EFFORT_MARKER_PREFIX)
        ? [part.text]
        : [],
    ),
  )
}

describe('OpenCode Fable 5.1 effort markers', () => {
  test('marks user boundaries independently of OpenCode assistant record counts', () => {
    const messages = [
      user('msg_low', 'ses_effort', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_effort'),
      assistant('msg_step_2', 'ses_effort'),
      user('msg_high', 'ses_effort', 'claude-fable-5-1', 'high'),
      assistant('msg_step_3', 'ses_effort'),
      user('msg_max', 'ses_effort', 'claude-fable-5-1', 'max'),
    ]

    const marked = markOpenCodeEffortTransitions(messages)

    expect(marked).toMatchObject({
      baseline: 'low',
      markerCount: 2,
      sessionId: 'ses_effort',
      messageId: 'msg_max',
    })
    const markers = markerTexts(messages)
    expect(markers).toHaveLength(2)
    expect(markers[0]).toContain('effort="h"')
    expect(markers[1]).toContain('effort="z"')
    expect(
      markers.every((marker) => / check="[0-9a-f]{32}"\/>$/.test(marker)),
    ).toBe(true)
  })

  test('replaces its own markers when the host invokes the transform twice', () => {
    const messages = [
      user('msg_low', 'ses_repeat', 'claude-fable-5-1', 'low'),
      assistant('msg_step', 'ses_repeat'),
      user('msg_high', 'ses_repeat', 'claude-fable-5-1', 'high'),
    ]

    const first = markOpenCodeEffortTransitions(messages)
    const firstMarkers = messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        typeof part.text === 'string' &&
        part.text.includes('cortexkit-internal-effort')
          ? [part.text]
          : [],
      ),
    )
    const second = markOpenCodeEffortTransitions(messages)
    expect(second).toEqual(first)
    expect(
      messages.flatMap((message) =>
        message.parts.flatMap((part) =>
          typeof part.text === 'string' &&
          part.text.includes('cortexkit-internal-effort')
            ? [part.text]
            : [],
        ),
      ),
    ).toEqual(firstMarkers)
    expect(markerTexts(messages)).toHaveLength(1)
  })

  test('removes correlated markers tagged by a later message transform before replanning', () => {
    const firstPass = [
      user('msg_first_low', 'ses_tagged', 'claude-fable-5-1', 'low'),
      user('msg_first_high', 'ses_tagged', 'claude-fable-5-1', 'high'),
    ]
    markOpenCodeEffortTransitions(firstPass)
    const priorTransition = markerTexts(firstPass)[0]
    expect(priorTransition).toBeDefined()

    const retainedLow = user(
      'msg_retained_low',
      'ses_tagged',
      'claude-fable-5-1',
      'low',
    )
    retainedLow.parts.push({
      type: 'text',
      text: `§901§ ${priorTransition}`,
    })
    const messages = [
      retainedLow,
      user('msg_retained_high', 'ses_tagged', 'claude-fable-5-1', 'high'),
      user('msg_current_high', 'ses_tagged', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()

    const body: {
      model: string
      output_config: { effort: string }
      messages: unknown[]
    } = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: messages.map((message) => ({
        role: 'user',
        content: message.parts.map((part) => ({
          type: 'text',
          text: part.text,
        })),
      })),
    }
    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
      ),
    ).not.toThrow()
    expect(body.messages).toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    })
    expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
    expect(JSON.stringify(body)).not.toContain('§901§')
  })

  test('survives downstream tag persistence across later turns', () => {
    const messages = [
      user('msg_low', 'ses_persisted', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_persisted', 'claude-fable-5-1', 'high'),
    ]
    const persistedSources = new Map<string, string>()
    const runDownstreamTagger = () => {
      let tag = 1
      for (const message of messages) {
        message.parts.forEach((part, partIndex) => {
          if (typeof part.text !== 'string') return
          const key = `${message.info.id}:p${partIndex}`
          const source = persistedSources.get(key) ?? part.text
          persistedSources.set(key, source)
          part.text = `§${tag++}§ ${source}`
        })
      }
    }
    const lowerAndApply = (
      plan: NonNullable<ReturnType<typeof markOpenCodeEffortTransitions>>,
    ) => {
      const body: {
        model: string
        output_config: { effort: string }
        messages: unknown[]
      } = {
        model: 'claude-fable-5-1',
        output_config: { effort: 'high' },
        messages: messages.map((message) => ({
          role: 'user',
          content: message.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        })),
      }
      expect(() =>
        applyOpenCodeEffortMarkers(body, true, encodeOpenCodeEffortPlan(plan)),
      ).not.toThrow()
      expect(JSON.stringify(body)).not.toContain('cortexkit-internal-effort')
    }

    const firstPlan = markOpenCodeEffortTransitions(messages)
    expect(firstPlan).not.toBeNull()
    runDownstreamTagger()
    lowerAndApply(firstPlan as NonNullable<typeof firstPlan>)

    messages.push(
      user('msg_medium', 'ses_persisted', 'claude-fable-5-1', 'medium'),
    )
    const secondPlan = markOpenCodeEffortTransitions(messages)
    expect(secondPlan).not.toBeNull()
    runDownstreamTagger()
    lowerAndApply(secondPlan as NonNullable<typeof secondPlan>)
    expect(secondPlan?.markerCount).toBe(2)
  })

  test('folds a downstream-trimmed transition prefix into the retained baseline', () => {
    const messages = [
      user('msg_low', 'ses_prefix_trim', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_prefix_trim', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_prefix_trim', 'claude-fable-5-1', 'high'),
      user('msg_current', 'ses_prefix_trim', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    expect(plan?.markerCount).toBe(2)

    const retained = messages.slice(2)
    const body: {
      model: string
      output_config: { effort: string }
      messages: unknown[]
    } = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: retained.map((message) => ({
        role: 'user',
        content: message.parts.map((part) => ({
          type: 'text',
          text: part.text,
        })),
      })),
    }

    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 1, inserted: 1 })
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body.messages).toEqual([
      {
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      },
      { role: 'user', content: [{ type: 'text', text: 'msg_high' }] },
      { role: 'user', content: [{ type: 'text', text: 'msg_current' }] },
    ])
  })

  test('folds all downstream-trimmed transitions into the current baseline', () => {
    const messages = [
      user('msg_low', 'ses_full_trim', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_full_trim', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_full_trim', 'claude-fable-5-1', 'high'),
      user('msg_current', 'ses_full_trim', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()

    const missingAnchorBody = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'msg_current' }],
        },
      ],
    }
    expect(
      applyOpenCodeEffortMarkers(
        missingAnchorBody,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 0, inserted: 0 })
    expect(missingAnchorBody.output_config).toEqual({ effort: 'high' })

    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        {
          role: 'user',
          content: messages[3]?.parts.map((part) => ({
            type: 'text',
            text: part.text.includes(EFFORT_ANCHOR_PREFIX)
              ? `§991§ ${part.text}`
              : part.text,
          })),
        },
      ],
    }
    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 0, inserted: 0 })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'msg_current' }],
      },
    ])
  })

  test('folds a full trim into the last consumed transition effort when the plan resolves', () => {
    const messages = [
      user('msg_low', 'ses_full_trim_fold', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_full_trim_fold', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_full_trim_fold', 'claude-fable-5-1', 'high'),
      user('msg_current', 'ses_full_trim_fold', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    expect(plan?.markerCount).toBe(2)
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'low' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'msg_current' }] },
      ],
    }

    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toEqual({ found: 0, inserted: 0 })
    // The folded baseline is the last consumed transition's effort ('high'),
    // not the plan's original baseline ('low').
    expect(body.output_config).toEqual({ effort: 'high' })
  })

  test('rejects a full trim without a resolvable plan', () => {
    const messages = [
      user('msg_low', 'ses_full_trim_untrusted', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_full_trim_untrusted', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'msg_high' }] },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
      ),
    ).toThrow('Fable 5.1 effort marker correlation failed: expected 1, found 0')
  })

  test('resolves a plan header after the same message is re-recorded with a trimmed timeline', () => {
    const full = [
      user('msg_low', 'ses_overwrite', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_overwrite', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_overwrite', 'claude-fable-5-1', 'high'),
      user('msg_current', 'ses_overwrite', 'claude-fable-5-1', 'high'),
    ]
    const fullPlan = markOpenCodeEffortTransitions(full)
    expect(fullPlan?.markerCount).toBe(2)
    const tracker = new OpenCodeEffortPlanTracker()
    tracker.record(fullPlan as NonNullable<typeof fullPlan>)
    const header = encodeOpenCodeEffortPlan(
      fullPlan as NonNullable<typeof fullPlan>,
    )

    // The host trims the history prefix between provider calls; the same current
    // message is re-marked with a shorter timeline and overwrites the slot.
    const trimmedPlan = markOpenCodeEffortTransitions(full.slice(2))
    expect(trimmedPlan?.messageId).toBe('msg_current')
    expect(trimmedPlan?.markerCount).toBe(0)
    tracker.record(trimmedPlan as NonNullable<typeof trimmedPlan>)

    // The header generated from the full plan must still resolve.
    expect(tracker.resolveHeader(header)).toEqual(
      fullPlan as NonNullable<typeof fullPlan>,
    )
  })

  test('rejects non-prefix transition loss even with the resolved plan', () => {
    const messages = [
      user('msg_low', 'ses_non_prefix', 'claude-fable-5-1', 'low'),
      user('msg_medium', 'ses_non_prefix', 'claude-fable-5-1', 'medium'),
      user('msg_high', 'ses_non_prefix', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: [
        {
          role: 'user',
          content: messages[1]?.parts.map((part) => ({
            type: 'text',
            text: part.text,
          })),
        },
        {
          role: 'user',
          content: messages[2]?.parts
            .filter(
              (part) =>
                typeof part.text === 'string' &&
                part.text.includes('cortexkit-internal-effort-anchor'),
            )
            .map((part) => ({ type: 'text', text: part.text })),
        },
      ],
    }

    expect(() =>
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
        plan as NonNullable<typeof plan>,
      ),
    ).toThrow('Fable 5.1 effort marker non-prefix loss')
  })

  test('rejects a lowered marker sequence that differs from the post-transform request plan', () => {
    const messages = [
      user('msg_low', 'ses_digest', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_digest', 'claude-fable-5-1', 'high'),
    ]
    const plan = markOpenCodeEffortTransitions(messages)
    expect(plan).not.toBeNull()
    const mismatchedHeader = encodeOpenCodeEffortPlan({
      ...(plan as NonNullable<typeof plan>),
      digest: '0'.repeat(64),
    })
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'high' },
      messages: messages.map((message) => ({
        role: 'user',
        content: message.parts.map((part) => ({
          type: 'text',
          text: part.text,
        })),
      })),
    }

    expect(() =>
      applyOpenCodeEffortMarkers(body, true, mismatchedHeader),
    ).toThrow('Fable 5.1 effort marker request plan mismatch')
  })

  test('defers a change past user records that OpenCode will not lower', () => {
    const dropped = user(
      'msg_dropped_high',
      'ses_deferred',
      'claude-fable-5-1',
      'high',
    )
    dropped.parts = []
    const current = user(
      'msg_current_high',
      'ses_deferred',
      'claude-fable-5-1',
      'high',
    )
    const messages = [
      user('msg_low', 'ses_deferred', 'claude-fable-5-1', 'low'),
      assistant('msg_step_1', 'ses_deferred'),
      dropped,
      assistant('msg_step_2', 'ses_deferred'),
      current,
    ]

    expect(markOpenCodeEffortTransitions(messages)).toMatchObject({
      baseline: 'low',
      markerCount: 1,
    })
    expect(dropped.parts).toEqual([])
    expect(markerTexts([current])).toHaveLength(1)

    const droppedBaseline = user(
      'msg_dropped_low',
      'ses_dropped_baseline',
      'claude-fable-5-1',
      'low',
    )
    droppedBaseline.parts = []
    const firstLowered = user(
      'msg_first_lowered',
      'ses_dropped_baseline',
      'claude-fable-5-1',
      'high',
    )
    expect(
      markOpenCodeEffortTransitions([droppedBaseline, firstLowered]),
    ).toMatchObject({ baseline: 'high', markerCount: 0 })
    expect(markerTexts([firstLowered])).toHaveLength(0)
  })

  test('folds the compaction effort and ignores reordered retained variants', () => {
    const compaction = user(
      'msg_300',
      'ses_compact',
      'claude-fable-5-1',
      'high',
    )
    compaction.parts.unshift({ type: 'compaction', text: '' })
    const retained = user('msg_100', 'ses_compact', 'claude-fable-5-1', 'low')
    const current = user('msg_400', 'ses_compact', 'claude-fable-5-1', 'xhigh')
    const messages = [
      compaction,
      assistant('msg_301', 'ses_compact'),
      retained,
      assistant('msg_101', 'ses_compact'),
      current,
    ]

    expect(markOpenCodeEffortTransitions(messages)).toMatchObject({
      baseline: 'high',
      markerCount: 1,
    })
    expect(markerTexts([retained])).toEqual([])
    expect(markerTexts([current])).toHaveLength(1)
    expect(markerTexts([current])[0]).toContain('effort="x"')
  })

  test('reuses a transform plan for retries of the matching chat request', () => {
    const plan = markOpenCodeEffortTransitions([
      user('msg_low', 'ses_headers', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_headers', 'claude-fable-5-1', 'high'),
    ])
    expect(plan).not.toBeNull()
    const tracker = new OpenCodeEffortPlanTracker()
    tracker.record(plan as NonNullable<typeof plan>)
    const wrongHeaders: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_other',
        headers: wrongHeaders,
      }),
    ).toBe(false)
    expect(wrongHeaders).toEqual({})

    const headers: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_high',
        headers,
      }),
    ).toBe(true)
    expect(headers['x-cortexkit-effort-plan']).toBe(
      encodeOpenCodeEffortPlan(plan as NonNullable<typeof plan>),
    )
    const retryHeaders: Record<string, string> = {}
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_high',
        headers: retryHeaders,
      }),
    ).toBe(true)
    expect(retryHeaders['x-cortexkit-effort-plan']).toBe(
      headers['x-cortexkit-effort-plan'],
    )
    expect(
      tracker.resolveHeader(retryHeaders['x-cortexkit-effort-plan']),
    ).toEqual(plan as NonNullable<typeof plan>)

    tracker.clear('ses_headers', 'msg_high')
    expect(
      tracker.markHeaders({
        sessionId: 'ses_headers',
        messageId: 'msg_high',
        headers: {},
      }),
    ).toBe(false)
  })

  test('distinguishes concurrent current messages with the same transition timeline', () => {
    const first = markOpenCodeEffortTransitions([
      user('msg_low', 'ses_concurrent', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_concurrent', 'claude-fable-5-1', 'high'),
      user('msg_current_a', 'ses_concurrent', 'claude-fable-5-1', 'high'),
    ])
    const second = markOpenCodeEffortTransitions([
      user('msg_low', 'ses_concurrent', 'claude-fable-5-1', 'low'),
      user('msg_high', 'ses_concurrent', 'claude-fable-5-1', 'high'),
      user('msg_current_b', 'ses_concurrent', 'claude-fable-5-1', 'high'),
    ])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    const tracker = new OpenCodeEffortPlanTracker()
    tracker.record(first as NonNullable<typeof first>)
    tracker.record(second as NonNullable<typeof second>)
    const firstHeader = encodeOpenCodeEffortPlan(
      first as NonNullable<typeof first>,
    )
    const secondHeader = encodeOpenCodeEffortPlan(
      second as NonNullable<typeof second>,
    )

    expect(firstHeader).not.toBe(secondHeader)
    expect(tracker.resolveHeader(firstHeader)?.messageId).toBe('msg_current_a')
    expect(tracker.resolveHeader(secondHeader)?.messageId).toBe('msg_current_b')
  })

  test('defaults absent variants to high and does not mark non-Fable requests', () => {
    const defaulted = [user('msg_default', 'ses_default', 'claude-fable-5-1')]
    const defaultPlan = markOpenCodeEffortTransitions(defaulted)
    expect(defaultPlan).toMatchObject({ baseline: 'high', markerCount: 0 })
    expect(markerTexts(defaulted)).toEqual([])
    expect(defaulted[0]?.parts).toHaveLength(1)
    const body = {
      model: 'claude-fable-5-1',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'hello' }],
    }
    expect(
      applyOpenCodeEffortMarkers(
        body,
        true,
        encodeOpenCodeEffortPlan(
          defaultPlan as NonNullable<typeof defaultPlan>,
        ),
      ),
    ).toEqual({ found: 0, inserted: 0 })
    expect(body.output_config).toEqual({ effort: 'high' })

    const otherModel = [
      user('msg_other', 'ses_other', 'claude-mythos-5-1', 'max'),
    ]
    expect(markOpenCodeEffortTransitions(otherModel)).toBeNull()
    expect(markerTexts(otherModel)).toEqual([])
  })
})
