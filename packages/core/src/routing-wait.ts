import { randomUUID } from 'node:crypto'
import {
  type PluginWaitReason,
  reportRouting,
} from '@cortexkit/common-auth/routing-accessor'

type WaitReason = Extract<
  PluginWaitReason,
  'account_limit' | 'account_free' | 'rate_limited' | 'routing_hold'
>
type WaitOutcome = 'resumed' | 'cancelled' | 'abandoned'

const messages: Record<WaitReason, string> = {
  account_limit: 'Waiting for the current account limit to reset.',
  account_free: 'Waiting for an account to become available.',
  rate_limited: 'Waiting before retrying the current account.',
  routing_hold: 'Waiting for shared routing to release the request.',
}

/** Report a real delay without calling reportRouting on the request path.
 * Call the returned callback when the wait ends. When the app owns the delay,
 * the plugin cannot observe completion and reports only its start. */
export function startRoutingWait(input: {
  sessionId?: string
  reason: WaitReason
  delayMs: number
  nextMs?: number
  attempt?: number
}): ((outcome: WaitOutcome) => void) | undefined {
  if (
    !input.sessionId ||
    !Number.isFinite(input.delayMs) ||
    input.delayMs < 2_000
  )
    return
  const report = {
    sessionId: input.sessionId,
    kind: 'wait' as const,
    waitId: randomUUID(),
    reason: input.reason,
    message: messages[input.reason],
    ...(input.nextMs !== undefined ? { nextMs: Math.round(input.nextMs) } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  }
  const send = (phase: 'start' | 'end', outcome?: WaitOutcome) => {
    void Promise.resolve()
      .then(() =>
        reportRouting({ ...report, phase, ...(outcome ? { outcome } : {}) }),
      )
      .catch(() => {})
  }
  send('start')
  let ended = false
  return (outcome) => {
    if (ended) return
    ended = true
    send('end', outcome)
  }
}
