import {
  buildCacheDiagnosticsRecord,
  CacheDiagnosticsBetaTracker,
  CacheDiagnosticsTracker,
  cacheDiagnosticsMessageId,
  DEFAULT_REFUSAL_FALLBACK_MODE,
  formatCacheDiagnosticsLogLine,
  logger,
  logServedServerFallback,
  type NativeAccountSnapshot,
  type RefusalFallbackMode,
  readThreeWayBoolean,
  type ServerSideFallbackOutcome,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import {
  BILLING_LINEAGE_REQUEST_HEADER,
  type BillingLineageContext,
  BillingLineageTracker,
} from '../billing-lineage'
import { LANE_START_REQUEST_HEADER, LANE_START_TEXT } from '../lane-start'
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
export function createNativeWirePolicy(
  options: { isSubagent?: (sessionID: string) => boolean | undefined } = {},
) {
  const billing = new BillingLineageTracker()
  const latest = new Map<string, string>()
  const contexts = new Map<string, BillingLineageContext>()
  const cacheDiagnostics = new CacheDiagnosticsTracker()
  const cacheDiagnosticBetas = new CacheDiagnosticsBetaTracker()
  const laneStarts = new Set<string>()
  const laneAttempts = new Set<string>()
  const attempts = new Map<
    string,
    { sessionID: string; refusalFallbackMode: RefusalFallbackMode }
  >()
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
      input: Pick<
        NativeAnthropicRequestContext<NativeSourceProvenance>,
        'agent' | 'attemptId' | 'correlation' | 'sessionID'
      >,
      snapshot: NativeAccountSnapshot,
    ) {
      const lineage = billing.resolveHeader(
        input.correlation[BILLING_LINEAGE_REQUEST_HEADER],
      )
      if (lineage) {
        contexts.set(input.attemptId, lineage)
        bound(contexts)
      }
      const refusalFallbackMode =
        snapshot.refusalFallbackMode ?? DEFAULT_REFUSAL_FALLBACK_MODE
      attempts.set(input.attemptId, {
        sessionID: input.sessionID,
        refusalFallbackMode,
      })
      bound(attempts)
      const laneStart = input.correlation[LANE_START_REQUEST_HEADER] === '1'
      if (laneStart) laneAttempts.add(input.attemptId)
      const previous = cacheDiagnostics.previousFor(input.sessionID)
      return {
        cache1hEnabled:
          input.agent !== 'compaction' &&
          input.agent !== 'title' &&
          readThreeWayBoolean(
            snapshot.policyStorage.claudeCache?.enabled,
            false,
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
        serverSideFallbackEnabled: refusalFallbackMode === 'server',
        laneStart,
        billingLineage: lineage
          ? {
              promptId: lineage.promptId,
              previousRequestId: lineage.previousRequestId,
            }
          : undefined,
        cacheDiagnosticsPreviousMessageId: previous?.messageId ?? null,
        cacheDiagnosticsPreviousMessageReceivedAt: previous?.receivedAt,
      }
    },
    responseOptions(
      input: Pick<
        NativeAnthropicResponseContext<NativeSourceProvenance>,
        | 'accountId'
        | 'attemptId'
        | 'cacheDiagnostics'
        | 'kind'
        | 'serverSideFallbackModel'
        | 'sessionID'
        | 'status'
      >,
    ) {
      const fallbackModel =
        attempts.get(input.attemptId)?.refusalFallbackMode === 'server'
          ? input.serverSideFallbackModel
          : undefined
      const laneStart = laneAttempts.has(input.attemptId)
      const sent = input.cacheDiagnostics
      const observe = (message: Record<string, unknown>) => {
        if (
          !sent ||
          attempts.get(input.attemptId)?.sessionID !== input.sessionID
        )
          return
        const receivedAt = Date.now()
        const messageId = cacheDiagnosticsMessageId(message)
        // The next request needs the ID even when the reply has no detailed usage.
        if (
          messageId &&
          input.kind === 'primary' &&
          input.status >= 200 &&
          input.status < 300
        ) {
          cacheDiagnostics.capture(input.sessionID, messageId, receivedAt)
        }
        const request = {
          previousMessageId: sent.previousMessageId,
          previousMessageReceivedAt: sent.previousMessageReceivedAt,
          ttlSent: sent.ttlSent,
          sessionId: input.sessionID,
          isSubagent: options.isSubagent?.(input.sessionID) ?? false,
        }
        // Only the optional log needs the hash; the host can consume the reply now.
        void sent.betaInfo
          .then((betaInfo) => {
            if (!betaInfo) return
            const { record, canary } = buildCacheDiagnosticsRecord({
              request,
              source: laneStart ? 'start' : 'turn',
              accountId: input.accountId,
              synthetic: laneStart,
              betasHash: betaInfo.betasHash,
              requestedModel: sent.requestedModel,
              message,
              receivedAt,
            })
            if (!record) {
              logger.debug(
                'cache-diagnostics',
                'skipped invalid response envelope',
                {
                  status: input.status,
                },
              )
              return
            }
            logger.debug(
              'cache-diagnostics',
              formatCacheDiagnosticsLogLine(record),
            )
            const betaLine = cacheDiagnosticBetas.capture(
              betaInfo.betasHash,
              betaInfo.betas,
            )
            if (betaLine) logger.debug('cache-diagnostics', betaLine)
            if (canary)
              logger.warn(
                'cache-diagnostics',
                'short-gap previous_message_not_found',
                {
                  message_id: canary.messageId,
                  previous_message_id: canary.previousMessageId,
                },
              )
          })
          .catch(() => {})
      }
      return {
        serverSideFallbackModel: fallbackModel,
        serverSideFallbackSent: fallbackModel !== undefined,
        onServerSideFallbackOutcome(outcome: ServerSideFallbackOutcome) {
          if (fallbackModel) logServedServerFallback(input.sessionID, outcome)
        },
        laneStart,
        onMessageStart: observe,
        onMessageResponse: observe,
        onStreamEnd() {
          contexts.delete(input.attemptId)
          laneAttempts.delete(input.attemptId)
          attempts.delete(input.attemptId)
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
      cacheDiagnostics.forgetSession(sessionID)
      laneStarts.delete(sessionID)
      for (const [attempt, request] of attempts)
        if (request.sessionID === sessionID) {
          contexts.delete(attempt)
          laneAttempts.delete(attempt)
          attempts.delete(attempt)
        }
    },
  }
}
