import { createHash } from 'node:crypto'
import type { MidConversationEffortTransition } from '@cortexkit/anthropic-auth-core'
import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai'

/** Unknown Pi options survive provider dispatch; only a distinct, named fork opts in. */
export function piForkHeadSession(
  options?: SimpleStreamOptions,
): string | undefined {
  const fork = (options as { cortexkitFork?: unknown } | undefined)
    ?.cortexkitFork
  if (!options?.sessionId || !fork || typeof fork !== 'object') return undefined
  const head = (fork as { headSessionId?: unknown }).headSessionId
  return typeof head === 'string' &&
    head.trim().length > 0 &&
    head !== options.sessionId
    ? head
    : undefined
}

export class PiForkRefusal extends Error {
  constructor(kind: 'routing' | 'account' | 'limit' | 'failed' | 'base') {
    super(
      {
        routing: 'Shared routing has no admission for this fork request.',
        account: 'The admitted account cannot serve this fork request.',
        limit: 'The admitted account declined this fork request.',
        // Upstream errors and transport failures are not account problems.
        failed: 'The fork request failed before an answer arrived.',
        base: 'The retained head request is unavailable for this fork (fork_base_unavailable).',
      }[kind],
    )
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

function messageDigests(context: Context): string[] {
  return context.messages.map((message) =>
    createHash('sha256')
      .update(JSON.stringify(canonical(message)))
      .digest('hex'),
  )
}

type EffortSnapshot = {
  digests: string[]
  transitions: MidConversationEffortTransition[]
}

/** Retain provenance, not prompts: a later head turn must not reshape an older fork base. */
export class PiForkEffortSnapshots {
  private readonly sessions = new Map<string, EffortSnapshot[]>()

  record(
    sessionId: string,
    context: Context,
    transitions: readonly MidConversationEffortTransition[] = [],
  ) {
    const snapshots = this.sessions.get(sessionId) ?? []
    snapshots.push({
      digests: messageDigests(context),
      transitions: transitions.map((item) => ({ ...item })),
    })
    this.sessions.delete(sessionId)
    this.sessions.set(sessionId, snapshots.slice(-8))
    const oldest = this.sessions.keys().next().value
    if (this.sessions.size > 128 && oldest !== undefined)
      this.sessions.delete(oldest)
  }

  match(
    headSessionId: string,
    context: Context,
  ): {
    messageCount: number
    transitions: readonly MidConversationEffortTransition[]
  } {
    const digests = messageDigests(context)
    let snapshot: EffortSnapshot | undefined
    for (const candidate of this.sessions.get(headSessionId) ?? []) {
      if (
        (!snapshot || candidate.digests.length >= snapshot.digests.length) &&
        candidate.digests.length <= digests.length &&
        candidate.digests.every((digest, index) => digest === digests[index])
      )
        snapshot = candidate
    }
    if (!snapshot) throw new PiForkRefusal('base')
    return {
      messageCount: snapshot.digests.length,
      transitions: snapshot.transitions,
    }
  }

  forget(sessionId: string) {
    this.sessions.delete(sessionId)
  }
}

export const piForkEffortSnapshots = new PiForkEffortSnapshots()
