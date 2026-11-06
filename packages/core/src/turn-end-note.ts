import {
  resolveClaudeModelCapabilities,
  TURN_END_NOTE_BETA,
} from './model-capabilities.ts'

export { TURN_END_NOTE_BETA }
export const TURN_END_NOTE_MIN_VISIBLE_CHARACTERS = 350
export const TURN_END_NOTE_CONTENT =
  'Your reply above has already reached the user. The tool call after it was housekeeping and changed nothing they need to know. Do not repeat, summarize or rewrite that reply. If no new work remains, end the turn without restating anything.'

const DEFAULT_TOOLS = ['board', 'ctx_reduce'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Models that get turn-end notes (capability `turnEndNote`). The note is a
 * turn-scoped system message (`clear_at: "next_user_message"`), which needs the
 * mid-conversation-system-clear-at beta that Claude Code sends for these models.
 */
export function supportsTurnEndNote(model: unknown): boolean {
  return resolveClaudeModelCapabilities(model)?.turnEndNote === true
}

type RunnerTurnNote = { after_tool_use_id: string; text: string }
type SkipReason =
  | 'anchor_missing'
  | 'before_user_message'
  | 'unsupported_model'
  | 'not_oauth'
type TurnNoteReport =
  | { kind: 'turn_notes_supported'; model: string; supported: boolean }
  | {
      kind: 'turn_note_skipped'
      after_tool_use_id: string
      reason: SkipReason
    }
const runnerReports = new Map<
  string,
  { models: Map<string, boolean>; skipped: Set<string> }
>()
const SKIP_REPORT_LIMIT = 512

function readRunnerNotes(handle: Record<string, unknown>): RunnerTurnNote[] {
  try {
    const read = handle.turn_notes
    if (typeof read !== 'function') return []
    const answer: unknown = read.call(handle)
    if (!Array.isArray(answer)) {
      if (isRecord(answer) && typeof answer.then === 'function')
        void Promise.resolve(answer).catch(() => {})
      return []
    }
    const notes: RunnerTurnNote[] = []
    for (const entry of answer) {
      if (!isRecord(entry)) return []
      const { after_tool_use_id, text } = entry
      if (
        typeof after_tool_use_id !== 'string' ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 16_384 ||
        new TextEncoder().encode(text).byteLength > 16_384
      )
        return []
      notes.push({ after_tool_use_id, text })
    }
    return notes
  } catch {
    // Runner input is optional and untrusted; never expose reminder text in logs.
    return []
  }
}

function runnerNotes(
  sessionId: string,
): { handle: Record<string, unknown>; notes: RunnerTurnNote[] } | undefined {
  try {
    // common-auth's routing helper does not yet expose notes or their reports.
    // Resolve the session handle afresh: the runner can attach after plugin load.
    const routing = Reflect.get(globalThis, Symbol.for('cortexkit.routing'))
    if (typeof routing !== 'function') return
    const handle: unknown = routing(sessionId)
    if (isRecord(handle) && typeof handle.turn_notes === 'function')
      return { handle, notes: readRunnerNotes(handle) }
  } catch {
    // A broken routing bridge must not change an authentication request.
    return
  }
}

function reportRunnerNote(
  handle: Record<string, unknown>,
  payload: TurnNoteReport,
) {
  // Keep synchronous bridge work off the request path as well as rejected promises.
  void Promise.resolve()
    .then(() => {
      const report = handle.report
      if (typeof report === 'function') return report.call(handle, payload)
    })
    .catch(() => {})
}

/** Apply after our own turn-end notes, so runner notes land before them. */
export function applyRunnerTurnNotes(
  body: Record<string, unknown>,
  options: { sessionId?: string; isOAuth: boolean },
): number {
  if (!options.sessionId) return 0
  const runner = runnerNotes(options.sessionId)
  if (!runner) return 0
  let reported = runnerReports.get(options.sessionId)
  if (!reported) {
    reported = { models: new Map(), skipped: new Set() }
    runnerReports.set(options.sessionId, reported)
  }
  const supported = options.isOAuth && supportsTurnEndNote(body.model)
  const model = typeof body.model === 'string' ? body.model : ''
  if (reported.models.get(model) !== supported) {
    reported.models.set(model, supported)
    reportRunnerNote(runner.handle, {
      kind: 'turn_notes_supported',
      model,
      supported,
    })
  }
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : []
  const anchors = new Map<string, number>()
  for (const [index, message] of messages.entries()) {
    if (
      !isRecord(message) ||
      message.role !== 'user' ||
      !Array.isArray(message.content)
    )
      continue
    for (const block of message.content) {
      if (
        isRecord(block) &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        !anchors.has(block.tool_use_id)
      )
        anchors.set(block.tool_use_id, index)
    }
  }
  const insertions = new Map<number, RunnerTurnNote[]>()
  let inserted = 0
  for (const note of runner.notes) {
    const index = anchors.get(note.after_tool_use_id)
    const next = index === undefined ? undefined : messages[index + 1]
    const reason: SkipReason | undefined = !options.isOAuth
      ? 'not_oauth'
      : !supported
        ? 'unsupported_model'
        : index === undefined
          ? 'anchor_missing'
          : isRecord(next) && next.role === 'user'
            ? 'before_user_message'
            : undefined
    if (reason) {
      if (!reported.skipped.has(note.after_tool_use_id)) {
        if (reported.skipped.size >= SKIP_REPORT_LIMIT) {
          const oldest = reported.skipped.values().next()
          if (!oldest.done) reported.skipped.delete(oldest.value)
        }
        reported.skipped.add(note.after_tool_use_id)
        reportRunnerNote(runner.handle, {
          kind: 'turn_note_skipped',
          after_tool_use_id: note.after_tool_use_id,
          reason,
        })
      }
      continue
    }
    if (index === undefined) continue
    const bucket = insertions.get(index) ?? []
    bucket.push(note)
    insertions.set(index, bucket)
    inserted++
  }
  if (inserted) {
    body.messages = messages.flatMap((message, index) => [
      message,
      ...(insertions.get(index) ?? []).map((note) => ({
        role: 'system',
        clear_at: 'next_user_message',
        content: note.text,
      })),
    ])
  }
  return inserted
}

/**
 * Call only on OAuth histories, after effort-marker validation and stripping.
 * Map configured host names with the same stateless mapping used for history,
 * never with the currently declared tool set: declarations can change later.
 */
export function applyTurnEndNotes(
  body: Record<string, unknown>,
  options: {
    tools?: readonly string[]
    mapToolName?: (name: string) => string
    visibleText?: (message: Record<string, unknown>) => string
  } = {},
): number {
  if (!supportsTurnEndNote(body.model) || !Array.isArray(body.messages))
    return 0
  const allowed = new Set(
    (options.tools ?? DEFAULT_TOOLS).map(
      (name) => options.mapToolName?.(name) ?? name,
    ),
  )
  if (!allowed.size) return 0

  const messages: unknown[] = body.messages
  const rewritten: unknown[] = []
  let inserted = 0
  for (let index = 0; index < messages.length; index++) {
    const results = messages[index]
    rewritten.push(results)
    let preceding = index - 1
    // Effort controls may sit between a tool call and its results. They have no
    // visible content and must not hide the assistant/result pair.
    while (preceding >= 0) {
      const control = messages[preceding]
      if (
        !isRecord(control) ||
        control.role !== 'system' ||
        !Array.isArray(control.content) ||
        control.content.length !== 0 ||
        !isRecord(control.output_config)
      )
        break
      preceding--
    }
    const assistant = messages[preceding]
    if (
      !isRecord(assistant) ||
      assistant.role !== 'assistant' ||
      !Array.isArray(assistant.content) ||
      !isRecord(results) ||
      results.role !== 'user' ||
      !Array.isArray(results.content)
    )
      continue

    const visible = options.visibleText
      ? options.visibleText(assistant)
      : assistant.content
          .filter(
            (block: unknown) =>
              isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string' &&
              block.text.trim().length > 0,
          )
          .map((block) => block.text)
          .join('')
    if (visible.length < TURN_END_NOTE_MIN_VISIBLE_CHARACTERS) continue
    const calls = assistant.content.filter(
      (block: unknown) => isRecord(block) && block.type === 'tool_use',
    )
    if (!calls.length || !calls.every((call) => allowed.has(call.name)))
      continue
    const resultIds = new Set(
      results.content
        .filter(
          (block: unknown) => isRecord(block) && block.type === 'tool_result',
        )
        .map((block) => block.tool_use_id),
    )
    if (
      !calls.every(
        (call) => typeof call.id === 'string' && resultIds.has(call.id),
      )
    )
      continue

    // Anthropic rejects a turn-scoped note directly before a user message. This
    // is the only suffix-dependent exception: omit just this note, leaving every
    // other history position unchanged. Never move or rewrite an earlier note.
    const next = messages[index + 1]
    if (isRecord(next) && next.role === 'user') continue
    rewritten.push({
      role: 'system',
      clear_at: 'next_user_message',
      content: TURN_END_NOTE_CONTENT,
    })
    inserted++
  }
  if (inserted) body.messages = rewritten
  return inserted
}
