import type { CommandDialogPayload } from '@cortexkit/anthropic-auth-core'
import type { OpenDialogPayload, RpcNotification } from './protocol'

const QUEUE_CAP = 100
const TUI_CONNECTED_WINDOW_MS = 3_000

// One queue serves every RPC server in the process, and a process can hold one
// server per project directory. Session ids are globally unique, so both
// producers and drains require one: an unscoped drain could otherwise expose
// another project's pending command dialog.
let queue: RpcNotification[] = []
let nextId = 1
const lastDrainAtBySession = new Map<string, number>()

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('sessionId is required')
  }
}

export function pushNotification(
  payload: OpenDialogPayload | CommandDialogPayload,
  sessionId: string,
): void {
  assertSessionId(sessionId)
  if ('menu' in payload) {
    if (payload.command !== 'claude' || payload.menu.command !== 'claude')
      throw new TypeError('Only the claude menu is supported')
    queue.push({ id: nextId++, type: 'open-menu', payload, sessionId })
  } else {
    queue.push({ id: nextId++, type: 'open-dialog', payload, sessionId })
  }
  if (queue.length > QUEUE_CAP) queue = queue.slice(queue.length - QUEUE_CAP)
}

export function drainNotifications(
  lastReceivedId: number,
  sessionId: string,
): RpcNotification[] {
  assertSessionId(sessionId)
  lastDrainAtBySession.set(sessionId, Date.now())
  if (lastReceivedId > 0) {
    queue = queue.filter(
      (notification) =>
        notification.id > lastReceivedId ||
        notification.sessionId !== sessionId,
    )
  }
  return queue.filter(
    (notification) =>
      notification.id > lastReceivedId && notification.sessionId === sessionId,
  )
}

export function isTuiConnected(sessionId: string): boolean {
  const now = Date.now()
  const at = lastDrainAtBySession.get(sessionId) ?? 0
  return at > 0 && now - at < TUI_CONNECTED_WINDOW_MS
}

export function resetNotificationsForTest(): void {
  queue = []
  nextId = 1
  lastDrainAtBySession.clear()
}
