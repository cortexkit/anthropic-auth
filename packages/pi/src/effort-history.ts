import {
  type AdaptiveEffort,
  type MidConversationEffortTransition,
  normalizeAdaptiveEffort,
} from '@cortexkit/anthropic-auth-core'
import type { Message } from '@earendil-works/pi-ai'

export type PiEffortTransition = MidConversationEffortTransition & {
  /** Mark the newest user message when the original assistant position cannot be matched. */
  beforeNewestUser?: true
}

type SessionEntryLike = {
  id?: unknown
  type?: unknown
  timestamp?: unknown
  thinkingLevel?: unknown
  firstKeptEntryId?: unknown
  message?: { role?: unknown; timestamp?: unknown }
}

/**
 * Reproduce the host's context-entry view — the entries the next request will
 * actually carry — from the branch path, ordered root to leaf.
 *
 * `SessionManager.buildContextEntries()` computes this on Pi hosts but does not
 * exist on Oh My Pi 18.x, where calling it threw on every turn (issue #200).
 * `getBranch()` is present on both hosts and is the same path that method walks,
 * so the compaction trim is applied here instead of asking the host for it.
 *
 * A branch without compaction is already the context. After a compaction the
 * context is the compaction entry, then the tail retained from
 * `firstKeptEntryId`, then everything appended after the compaction.
 */
export function deriveContextEntries<Entry extends SessionEntryLike>(
  branch: readonly Entry[],
): Entry[] {
  let compactionIndex = -1
  for (let index = 0; index < branch.length; index++) {
    if (branch[index]?.type === 'compaction') compactionIndex = index
  }

  const compaction = branch[compactionIndex]
  if (!compaction) return branch.slice()

  const contextEntries: Entry[] = [compaction]
  let retaining = false
  for (let index = 0; index < compactionIndex; index++) {
    const entry = branch[index]
    if (!entry) continue
    if (entry.id === compaction.firstKeptEntryId) retaining = true
    if (retaining) contextEntries.push(entry)
  }
  for (let index = compactionIndex + 1; index < branch.length; index++) {
    const entry = branch[index]
    if (entry) contextEntries.push(entry)
  }
  return contextEntries
}

function entryRole(entry: SessionEntryLike): unknown {
  if (entry.type === 'compaction' || entry.type === 'branch_summary') {
    return 'user'
  }
  if (entry.type === 'custom_message') return 'user'
  return entry.type === 'message' ? entry.message?.role : undefined
}

function appendTransition(
  transitions: MidConversationEffortTransition[],
  afterAssistantMessages: number,
  effort: AdaptiveEffort,
) {
  const previous = transitions.at(-1)
  if (previous?.effort === effort) return
  if (previous?.afterAssistantMessages === afterAssistantMessages) {
    previous.effort = effort
    return
  }
  transitions.push({ afterAssistantMessages, effort })
}

/**
 * Build Pi's active, compaction-aware effort timeline for per-message effort.
 * A thinking level without an adaptive effort (such as `off`) and a branch
 * without any level change both count as `defaultEffort`, the effort the
 * request model applies when no top-level effort is sent.
 */
export function collectPiEffortHistory(
  contextEntries: readonly SessionEntryLike[],
  fullBranch: readonly SessionEntryLike[],
  defaultEffort: AdaptiveEffort = 'high',
): MidConversationEffortTransition[] {
  let activeEffort: AdaptiveEffort = defaultEffort
  let assistantMessages = 0
  let userBoundary = false
  let changes: { effort: AdaptiveEffort; timestamp: number }[] = []
  const transitions: MidConversationEffortTransition[] = []
  const first = contextEntries[0]
  const compactionIndex =
    first?.type === 'compaction'
      ? fullBranch.findIndex((entry) => entry.id === first.id)
      : -1

  if (compactionIndex >= 0) {
    for (let index = 0; index <= compactionIndex; index++) {
      const entry = fullBranch[index]
      if (entry?.type !== 'thinking_level_change') continue
      activeEffort =
        normalizeAdaptiveEffort(entry.thinkingLevel) ?? defaultEffort
    }
    appendTransition(transitions, 0, activeEffort)
  }

  const branchIndexById = new Map(
    fullBranch.map((entry, index) => [entry.id, index]),
  )
  for (const entry of contextEntries) {
    if (entry === first && entry.type === 'compaction') continue
    const branchIndex = branchIndexById.get(entry.id)
    const retainedBeforeCompaction =
      compactionIndex >= 0 &&
      typeof branchIndex === 'number' &&
      branchIndex < compactionIndex

    if (entry.type === 'thinking_level_change') {
      if (!retainedBeforeCompaction) {
        changes.push({
          effort: normalizeAdaptiveEffort(entry.thinkingLevel) ?? defaultEffort,
          timestamp:
            typeof entry.timestamp === 'string'
              ? Date.parse(entry.timestamp)
              : Number.NaN,
        })
      }
      continue
    }

    const role = entryRole(entry)
    if (role === 'assistant') {
      // Pi can persist a level change during a reply, before persisting that
      // reply. Its message timestamp is when the reply started, not when it
      // was written to the branch.
      const timestamp = entry.message?.timestamp
      const applied = changes.findLastIndex(
        (change) =>
          typeof timestamp !== 'number' ||
          !Number.isFinite(change.timestamp) ||
          change.timestamp <= timestamp,
      )
      const change = changes[applied]
      if (change) {
        activeEffort = change.effort
        changes = changes.slice(applied + 1)
      }
      if (userBoundary)
        appendTransition(transitions, assistantMessages, activeEffort)
      assistantMessages++
      userBoundary = false
    } else if (
      role === 'user' ||
      role === 'toolResult' ||
      role === 'tool_result'
    ) {
      userBoundary = true
    }
  }

  // A level can change after Pi records the tool result but before it sends
  // the continuation. That tool result is still the request's user boundary.
  if (userBoundary)
    appendTransition(
      transitions,
      assistantMessages,
      changes.at(-1)?.effort ?? activeEffort,
    )
  return transitions
}

/** Map branch assistant boundaries to the transcript after Pi's context hooks. */
export function collectPiRequestEffortHistory(
  branch: readonly SessionEntryLike[],
  messages: readonly Message[],
  defaultEffort: AdaptiveEffort,
): PiEffortTransition[] {
  const entries = deriveContextEntries(branch)
  const transitions = collectPiEffortHistory(entries, branch, defaultEffort)
  if (transitions.length < 2) return transitions

  const byIdentity = new Map<SessionEntryLike['message'], number>()
  const byTimestamp = new Map<number, number | undefined>()
  let assistantCount = 0
  for (const entry of entries) {
    if (entryRole(entry) !== 'assistant' || !entry.message) continue
    assistantCount++
    byIdentity.set(entry.message, assistantCount)
    const timestamp = entry.message.timestamp
    if (typeof timestamp === 'number' && Number.isFinite(timestamp))
      byTimestamp.set(
        timestamp,
        byTimestamp.has(timestamp) ? undefined : assistantCount,
      )
  }

  const retained: number[] = []
  let canAlign = true
  let firstAssistantUnknown = false
  let requestAssistantCount = 0
  let oldestRetained = Infinity
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const boundary =
      byIdentity.get(message) ?? byTimestamp.get(message.timestamp)
    if (requestAssistantCount++ === 0)
      firstAssistantUnknown = boundary === undefined
    // An unknown or reordered assistant breaks the correspondence. Passing
    // the branch's counts through would move markers to unrelated turns.
    if (boundary === undefined) {
      canAlign = false
      continue
    }
    if (boundary <= (retained.at(-1) ?? 0)) canAlign = false
    oldestRetained = Math.min(oldestRetained, boundary)
    retained.push(boundary)
  }

  function newestUserFallback(): PiEffortTransition[] {
    // Only fold away earlier changes if the oldest retained reply is known.
    // Otherwise the branch's baseline is safer than the live reasoning level.
    const retainedEffort = firstAssistantUnknown
      ? undefined
      : transitions.findLast(
          (item) => item.afterAssistantMessages < oldestRetained,
        )?.effort
    return [
      {
        afterAssistantMessages: 0,
        effort: retainedEffort ?? transitions[0]?.effort ?? defaultEffort,
      },
      {
        afterAssistantMessages: requestAssistantCount,
        effort: transitions.at(-1)?.effort ?? defaultEffort,
        beforeNewestUser: true,
      },
    ]
  }

  if (!canAlign) return newestUserFallback()
  const rebased: MidConversationEffortTransition[] = []
  let count = 0
  for (const { afterAssistantMessages, effort } of transitions) {
    while ((retained[count] ?? Infinity) <= afterAssistantMessages) count++
    // Changes in a summarized prefix can become the new baseline. Elsewhere,
    // only an assistant still in the request can anchor a marker.
    if (count > 0 && retained[count - 1] !== afterAssistantMessages)
      return newestUserFallback()
    appendTransition(rebased, count, effort)
  }
  return rebased
}
