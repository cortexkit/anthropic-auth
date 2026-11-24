import { supportsTurnEndNote } from './turn-end-note.ts'

type PlanNote = { after_user_timestamp: number; texts: string[] }
type PlanNoteReport =
  | { kind: 'plan_notes_supported'; model: string; supported: boolean }
  | { kind: 'plan_note_unanchored'; after_user_timestamp: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNotes(read: () => unknown): PlanNote[] {
  try {
    const value = read()
    if (value instanceof Promise) {
      // Ignore async answers, including rejections from an accidental async accessor.
      void value.catch(() => {})
      return []
    }
    if (!Array.isArray(value)) return []
    const notes: PlanNote[] = []
    for (const note of value) {
      if (!isRecord(note)) return []
      const { after_user_timestamp, texts } = note
      if (
        typeof after_user_timestamp !== 'number' ||
        !Number.isFinite(after_user_timestamp) ||
        !Array.isArray(texts)
      )
        return []
      const contents: string[] = []
      for (const text of texts) {
        if (typeof text !== 'string') return []
        contents.push(text)
      }
      notes.push({ after_user_timestamp, texts: contents })
    }
    return notes
  } catch {
    return []
  }
}

function report(
  handle: Record<string, unknown>,
  payload: PlanNoteReport,
): void {
  // Detach the report call itself as well as any promise it returns.
  void Promise.resolve()
    .then(() => {
      const send = handle.report
      if (typeof send === 'function') return send.call(handle, payload)
    })
    .catch(() => {})
}

/** Insert after conversion and turn-note placement so plan notes precede turn notes at the same anchor. */
export function applyRunnerPlanNotes(
  body: Record<string, unknown>,
  options: {
    sessionId?: string
    modelId: string
    isOAuth: boolean
    userTimestamps: WeakMap<object, number>
  },
): void {
  if (!options.sessionId || !options.isOAuth) return
  let handle: Record<string, unknown>
  let read: () => unknown
  try {
    const routing = Reflect.get(globalThis, Symbol.for('cortexkit.routing'))
    if (typeof routing !== 'function') return
    const resolved: unknown = routing(options.sessionId)
    if (!isRecord(resolved)) return
    const accessor = resolved.plan_notes
    if (typeof accessor !== 'function') return
    handle = resolved
    read = () => accessor.call(handle)
  } catch {
    return
  }

  const supported = supportsTurnEndNote(body.model)
  report(handle, {
    kind: 'plan_notes_supported',
    model: options.modelId,
    supported,
  })
  const notes = readNotes(read)
  if (!supported || !notes.length || !Array.isArray(body.messages)) return

  const messages: unknown[] = body.messages
  const anchors = new Map<number, number>()
  for (const [index, message] of messages.entries()) {
    if (!isRecord(message) || message.role !== 'user') continue
    const timestamp = options.userTimestamps.get(message)
    if (timestamp !== undefined)
      anchors.set(timestamp, anchors.has(timestamp) ? -1 : index)
  }
  const insertions = new Map<
    number,
    Array<{ role: 'system'; content: string }>
  >()
  for (const { after_user_timestamp, texts } of notes) {
    const index = anchors.get(after_user_timestamp)
    if (index === undefined || index < 0) {
      report(handle, { kind: 'plan_note_unanchored', after_user_timestamp })
      continue
    }
    if (!texts.length) continue
    const bucket = insertions.get(index) ?? []
    for (const content of texts) bucket.push({ role: 'system', content })
    insertions.set(index, bucket)
  }
  if (insertions.size)
    body.messages = messages.flatMap((message, index) => [
      message,
      ...(insertions.get(index) ?? []),
    ])
}
