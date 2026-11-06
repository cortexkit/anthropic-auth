import { afterEach, describe, expect, test } from 'bun:test'
import { selectClaudeCodeBetas } from '../claude-code.ts'
import {
  applyRunnerTurnNotes,
  applyTurnEndNotes,
  TURN_END_NOTE_CONTENT,
} from '../turn-end-note.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const original = globals[key]
afterEach(() => {
  if (original === undefined) delete globals[key]
  else globals[key] = original
})
let session = 0
const options = () => ({
  sessionId: `runner-notes-${++session}`,
  isOAuth: true,
})
const runnerNote = (text: string) => ({
  role: 'system',
  clear_at: 'next_user_message',
  content: text,
})
const pair = (id: string) => [
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'A'.repeat(350) },
      { type: 'tool_use', id, name: 'board', input: {} },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'Done' }],
  },
]
const request = (messages: unknown[] = pair('a')) => ({
  model: 'claude-opus-5-5',
  messages,
})
function install(notes: unknown) {
  const reports: unknown[] = []
  globals[key] = (sessionId: string) => {
    expect(sessionId).toStartWith('runner-notes-')
    return {
      turn_notes: (...args: unknown[]) => {
        expect(args).toHaveLength(0)
        return notes
      },
      report: (input: unknown) => reports.push(input),
    }
  }
  return reports
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('runner turn notes', () => {
  test('inserts in landing order after results and before our own note', () => {
    install([
      { after_tool_use_id: 'a', text: 'First reminder' },
      { after_tool_use_id: 'a', text: 'Second reminder' },
    ])
    const body = request()
    applyTurnEndNotes(body)
    expect(applyRunnerTurnNotes(body, options())).toBe(2)
    expect(body.messages).toEqual([
      ...pair('a'),
      runnerNote('First reminder'),
      runnerNote('Second reminder'),
      runnerNote(TURN_END_NOTE_CONTENT),
    ])
  })

  test('runner-only notes select the clear-at beta even with housekeeping disabled', () => {
    install([{ after_tool_use_id: 'a', text: 'Reminder' }])
    const body = request()
    applyTurnEndNotes(body, { tools: [] })
    applyRunnerTurnNotes(body, options())
    expect(body.messages.at(-1)).toEqual(runnerNote('Reminder'))
    expect(selectClaudeCodeBetas(body).split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
    expect(selectClaudeCodeBetas(body, [], 'auxiliary').split(',')).toContain(
      'mid-conversation-system-clear-at-2026-08-21',
    )
  })

  test('growing history replays earlier notes byte-identically', () => {
    const notes = [
      { after_tool_use_id: 'a', text: 'Earlier reminder\n  exact bytes' },
    ]
    install(notes)
    const opts = options()
    const first = request()
    applyRunnerTurnNotes(first, opts)
    notes.push({ after_tool_use_id: 'b', text: 'Later reminder' })
    const second = request([
      ...pair('a'),
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'Next' },
      ...pair('b'),
    ])
    applyRunnerTurnNotes(second, opts)
    expect(
      JSON.stringify(second.messages.slice(0, first.messages.length)),
    ).toBe(JSON.stringify(first.messages))
    expect(second.messages.at(-1)).toEqual(runnerNote('Later reminder'))
  })

  test.each([
    ['anchor_missing', 'missing', 'claude-opus-5-5', true, false],
    ['before_user_message', 'a', 'claude-opus-5-5', true, true],
    ['unsupported_model', 'a', 'claude-sonnet-4-5', true, false],
    ['not_oauth', 'a', 'claude-opus-5-5', false, false],
  ] as const)(
    'skips %s without changing body bytes',
    async (reason, anchor, model, isOAuth, nextUser) => {
      const reports = install([
        { after_tool_use_id: anchor, text: 'Private reminder' },
      ])
      const opts = { ...options(), isOAuth }
      const body = { ...request(), model }
      if (nextUser) body.messages.push({ role: 'user', content: 'Next' })
      const before = JSON.stringify(body)
      expect(applyRunnerTurnNotes(body, opts)).toBe(0)
      expect(JSON.stringify(body)).toBe(before)
      await flush()
      expect(reports).toContainEqual({
        kind: 'turn_note_skipped',
        after_tool_use_id: anchor,
        reason,
      })
      expect(JSON.stringify(reports)).not.toContain('Private reminder')
    },
  )

  test('missing, throwing and malformed accessors leave existing output unchanged', () => {
    const bad = [
      undefined,
      {},
      {
        turn_notes: () => {
          throw new Error('private')
        },
      },
      {
        get turn_notes() {
          throw new Error('private')
        },
      },
      ...[
        null,
        {},
        Promise.resolve([]),
        Promise.reject(new Error('private')),
        [null],
        [{ after_tool_use_id: 1, text: 'x' }],
        [{ after_tool_use_id: 'a', text: 1 }],
        [{ after_tool_use_id: 'a', text: '' }],
        [{ after_tool_use_id: 'a', text: ' '.repeat(3) }],
        [{ after_tool_use_id: 'a', text: 'x'.repeat(16_385) }],
        [{ after_tool_use_id: 'a', text: '😀'.repeat(4097) }],
        [
          {
            after_tool_use_id: 'a',
            get text() {
              throw new Error('private')
            },
          },
        ],
        [{ after_tool_use_id: 'a', text: 'Valid' }, { text: 'Invalid' }],
      ].map((answer) => ({ turn_notes: () => answer })),
    ]
    for (const accessor of bad) {
      globals[key] = () => accessor
      const body = request()
      applyTurnEndNotes(body)
      const before = JSON.stringify(body)
      expect(applyRunnerTurnNotes(body, options())).toBe(0)
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  test('absent or broken globals and a non-function member leave body bytes unchanged', () => {
    for (const accessor of [
      undefined,
      {},
      () => {
        throw new Error('private')
      },
      () => ({ turn_notes: [] }),
    ]) {
      globals[key] = accessor
      const body = request()
      const before = JSON.stringify(body)
      expect(applyRunnerTurnNotes(body, options())).toBe(0)
      expect(JSON.stringify(body)).toBe(before)
    }
  })

  test('legacy routing handles without the note member receive no new reports', async () => {
    const reports: unknown[] = []
    globals[key] = () => ({
      report: (payload: unknown) => reports.push(payload),
    })
    const body = request()
    applyTurnEndNotes(body)
    const before = JSON.stringify(body)
    expect(applyRunnerTurnNotes(body, options())).toBe(0)
    expect(JSON.stringify(body)).toBe(before)
    await flush()
    expect(reports).toEqual([])
  })

  test('the per-session skipped-anchor set evicts its oldest entry at the bound', async () => {
    const notes = Array.from({ length: 513 }, (_, i) => ({
      after_tool_use_id: `missing-${i}`,
      text: 'Reminder',
    }))
    const reports = install(notes)
    const opts = options()
    applyRunnerTurnNotes(request(), opts)
    notes.splice(0, notes.length, {
      after_tool_use_id: 'missing-512',
      text: 'Reminder',
    })
    applyRunnerTurnNotes(request(), opts)
    notes[0] = { after_tool_use_id: 'missing-0', text: 'Reminder' }
    applyRunnerTurnNotes(request(), opts)
    await flush()
    expect(
      reports.filter((r: any) => r.kind === 'turn_note_skipped'),
    ).toHaveLength(514)
  })

  test('reports support per session/model only on changes and skips once per anchor', async () => {
    const reports = install([
      { after_tool_use_id: 'missing', text: 'Reminder' },
    ])
    const opts = options()
    applyRunnerTurnNotes(request(), opts)
    applyRunnerTurnNotes(request(), opts)
    applyRunnerTurnNotes(request(), { ...opts, isOAuth: false })
    applyRunnerTurnNotes(request(), { ...opts, isOAuth: false })
    applyRunnerTurnNotes(request(), opts)
    applyRunnerTurnNotes({ ...request(), model: 'claude-sonnet-4-5' }, opts)
    applyRunnerTurnNotes(request(), options())
    await flush()
    const supported = reports.filter(
      (r: any) => r.kind === 'turn_notes_supported',
    )
    expect(supported).toEqual([
      {
        kind: 'turn_notes_supported',
        model: 'claude-opus-5-5',
        supported: true,
      },
      {
        kind: 'turn_notes_supported',
        model: 'claude-opus-5-5',
        supported: false,
      },
      {
        kind: 'turn_notes_supported',
        model: 'claude-opus-5-5',
        supported: true,
      },
      {
        kind: 'turn_notes_supported',
        model: 'claude-sonnet-4-5',
        supported: false,
      },
      {
        kind: 'turn_notes_supported',
        model: 'claude-opus-5-5',
        supported: true,
      },
    ])
    expect(
      reports.filter((r: any) => r.kind === 'turn_note_skipped'),
    ).toHaveLength(2)
  })

  test('a report that never settles cannot delay rendering; throws and rejections are ignored', async () => {
    for (const report of [
      () => new Promise(() => {}),
      () => {
        throw new Error('unavailable')
      },
      () => Promise.reject(new Error('unavailable')),
    ]) {
      globals[key] = () => ({
        turn_notes: () => [{ after_tool_use_id: 'a', text: 'Reminder' }],
        report,
      })
      const body = request()
      expect(applyRunnerTurnNotes(body, options())).toBe(1)
      expect(body.messages.at(-1)).toEqual(runnerNote('Reminder'))
      await flush()
    }
  })
})
