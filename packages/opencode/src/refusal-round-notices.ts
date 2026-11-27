import {
  logger,
  type RefusalFallbackRoundEvent,
  resolveClaudeModelCapabilities,
} from '@cortexkit/anthropic-auth-core'
import type { FableRecoverySidebarState } from './sidebar-state'

export function createRefusalRoundNotices() {
  const active = new Map<string, FableRecoverySidebarState>()
  const ended = new Map<string, RefusalFallbackRoundEvent>()
  return {
    observe(event: RefusalFallbackRoundEvent) {
      logger.info('refusal-fallback', event.kind, event)
      const { sessionId, requestedModel, servingModel, category, stepsLeft } =
        event
      active.delete(sessionId)
      if (event.kind === 'round_ended') {
        ended.delete(sessionId)
        ended.set(sessionId, event)
        if (ended.size > 2048) {
          const oldest = ended.keys().next()
          if (!oldest.done) ended.delete(oldest.value)
        }
        return
      }
      active.set(sessionId, {
        sessionId,
        mode: 'opus',
        requestedModelId: requestedModel,
        targetModelId: servingModel,
        category,
        remaining: stepsLeft,
        changedAt: Date.now(),
      })
      if (active.size > 128) {
        const oldest = active.keys().next()
        if (!oldest.done) active.delete(oldest.value)
      }
    },
    forget(sessionId: string) {
      active.delete(sessionId)
      ended.delete(sessionId)
    },
    snapshot: () => [...active.values()],
    takeThreadReset(sessionId: string) {
      return ended.delete(sessionId)
    },
  }
}

export function refusalRoundNoticeText(event: RefusalFallbackRoundEvent) {
  const modelLabel = (model: string) =>
    resolveClaudeModelCapabilities(model)?.name ?? model
  const from = modelLabel(event.requestedModel)
  const to = modelLabel(event.servingModel)
  return event.kind === 'round_ended'
    ? `Safety fallback ended (${event.category}): returning to ${from} from ${to}; 0 steps left.`
    : `Safety fallback (${event.category}): ${to} is serving ${from}; ${event.stepsLeft} steps left.`
}
