import {
  type NativeAccountSnapshot,
  readThreeWayBoolean,
  remapModelId,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import {
  BILLING_LINEAGE_REQUEST_HEADER,
  type BillingLineageContext,
  BillingLineageTracker,
} from '../billing-lineage'
import { LANE_START_REQUEST_HEADER, LANE_START_TEXT } from '../lane-start'
import { resolveContentFilterFallbackMode } from '../server-fallback'
import type {
  NativeAnthropicRequestContext,
  NativeAnthropicResponseContext,
} from './adapter'
import type { NativeSourceProvenance } from './source'

/**
 * Claude Code's billing header names the user prompt a request belongs to and
 * the provider request-id of the previous request for that prompt. Track that
 * chain per user turn with OpenCode's message IDs: one session spans many
 * turns, so a session ID alone cannot tell which turn a request serves.
 */
export function createNativeWirePolicy() {
  const billing = new BillingLineageTracker()
  const latest = new Map<string, string>()
  const contexts = new Map<string, BillingLineageContext>()
  const messageIDs = new Map<string, string>()
  const laneStarts = new Set<string>()
  const laneAttempts = new Set<string>()
  const attemptSessions = new Map<string, string>()
  const bound = <K, V>(map: Map<K, V>) => {
    while (map.size > 512) {
      const first = map.keys().next()
      if (!first.done) map.delete(first.value)
    }
  }

  return {
    async install(ctx: Pick<Plugin.Context, 'session'>): Promise<Registration> {
      const registrations: Registration[] = []
      try {
        registrations.push(
          await ctx.session.hook(
            'context',
            (draft) => {
              const messages = draft.messages.map((message) => {
                return {
                  info: {
                    id: message.id,
                    sessionID: draft.sessionID,
                    role: message.role,
                    agent: draft.agent,
                    model: {
                      providerID: draft.model.providerID,
                      modelID: draft.model.id,
                    },
                  },
                  parts: message.content.map((part) => ({
                    type: part.type,
                    ...(part.type === 'text' ? { text: part.text } : {}),
                  })),
                }
              })
              billing.observeMessages(messages)
              const user = draft.messages.findLast(
                (message) => message.role === 'user' && message.id,
              )
              if (user?.id) latest.set(draft.sessionID, user.id)
              if (
                user?.content.some(
                  (part) =>
                    part.type === 'text' && part.text === LANE_START_TEXT,
                )
              )
                laneStarts.add(draft.sessionID)
              else laneStarts.delete(draft.sessionID)
              bound(latest)
            },
            { providerID: 'anthropic' },
          ),
        )
        registrations.push(
          await ctx.session.hook(
            'model.request',
            (draft) => {
              if (draft.kind !== 'primary') return
              const messageId = latest.get(draft.sessionID)
              if (!messageId) return
              billing.markHeaders({
                sessionId: draft.sessionID,
                messageId,
                agent: draft.agent,
                headers: draft.headers,
              })
              if (laneStarts.has(draft.sessionID))
                draft.headers[LANE_START_REQUEST_HEADER] = '1'
            },
            { providerID: 'anthropic' },
          ),
        )
      } catch (error) {
        await Promise.allSettled(
          registrations.map((registration) => registration.dispose()),
        )
        throw error
      }
      return {
        dispose: async () => {
          await Promise.all(
            registrations.map((registration) => registration.dispose()),
          )
        },
      }
    },
    requestOptions(
      input: NativeAnthropicRequestContext<NativeSourceProvenance>,
      snapshot: NativeAccountSnapshot,
    ) {
      const lineage = billing.resolveHeader(
        input.correlation[BILLING_LINEAGE_REQUEST_HEADER],
      )
      if (lineage) {
        contexts.set(input.attemptId, lineage)
        bound(contexts)
      }
      attemptSessions.set(input.attemptId, input.sessionID)
      bound(attemptSessions)
      const laneStart = input.correlation[LANE_START_REQUEST_HEADER] === '1'
      if (laneStart) laneAttempts.add(input.attemptId)
      return {
        cache1hEnabled:
          input.agent !== 'compaction' &&
          input.agent !== 'title' &&
          readThreeWayBoolean(
            snapshot.policyStorage.claudeCache?.enabled,
            true,
          ),
        cache1hMode: snapshot.policyStorage.claudeCache?.mode ?? 'explicit',
        fastModeEnabled: snapshot.policyStorage.claudeFast?.enabled === true,
        thinkingPrefixMismatchBehavior:
          snapshot.policyStorage.thinkingBinding?.prefixMismatchBehavior,
        // When reasoning effort changes mid-conversation, OpenCode 1 needs this
        // plugin to insert effort markers into history, which the transform
        // turns into Anthropic effort system messages. OpenCode 2 already sends
        // those system messages itself (with output_config). Adding markers too
        // would insert each change twice and alter earlier history, so the
        // cached prompt prefix would stop matching.
        midConversationEffortEnabled: false,
        turnEndNoteEnabled: true,
        turnEndNote: snapshot.policyStorage.turnEndNote,
        serverSideFallbackEnabled:
          resolveContentFilterFallbackMode(
            process.env.OPENCODE_ANTHROPIC_AUTH_CONTENT_FILTER_FALLBACK,
          ) === 'server',
        laneStart,
        billingLineage: lineage
          ? {
              promptId: lineage.promptId,
              previousRequestId: lineage.previousRequestId,
            }
          : undefined,
        cacheDiagnosticsPreviousMessageId: messageIDs.get(input.sessionID),
      }
    },
    responseOptions(
      input: NativeAnthropicResponseContext<NativeSourceProvenance>,
    ) {
      return {
        serverSideFallbackModel: remapModelId(input.modelID),
        laneStart: laneAttempts.has(input.attemptId),
        onMessageStart(message: Record<string, unknown>) {
          if (input.kind === 'primary' && typeof message.id === 'string') {
            messageIDs.set(input.sessionID, message.id)
            bound(messageIDs)
          }
        },
        onStreamEnd() {
          contexts.delete(input.attemptId)
          laneAttempts.delete(input.attemptId)
          attemptSessions.delete(input.attemptId)
        },
      }
    },
    onRequestId(
      input: NativeAnthropicResponseContext<NativeSourceProvenance>,
      requestId: string,
    ) {
      billing.commit(contexts.get(input.attemptId), requestId)
    },
    forgetSession(sessionID: string) {
      billing.clearSession(sessionID)
      latest.delete(sessionID)
      messageIDs.delete(sessionID)
      laneStarts.delete(sessionID)
      for (const [attempt, session] of attemptSessions)
        if (session === sessionID) {
          contexts.delete(attempt)
          laneAttempts.delete(attempt)
          attemptSessions.delete(attempt)
        }
    },
  }
}
