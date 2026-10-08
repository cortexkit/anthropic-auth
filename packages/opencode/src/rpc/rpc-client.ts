import type {
  CommandApplyRequest,
  CommandApplyResult,
} from '@cortexkit/anthropic-auth-core'
import { discoverPortFile } from './port-file'
import type { ApplyRequest, ApplyResult, RpcNotification } from './protocol'

export interface RpcClient {
  pending: (
    lastReceivedId: number,
    sessionId: string,
  ) => Promise<RpcNotification[]>
  apply: (request: ApplyRequest) => Promise<ApplyResult>
  applyMenu: (request: CommandApplyRequest) => Promise<CommandApplyResult>
}

async function call<T>(
  dir: string,
  method: string,
  params: Record<string, unknown>,
  expectedPid?: number,
): Promise<T | null> {
  const entry = await discoverPortFile(dir, expectedPid)
  if (!entry) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/rpc/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${entry.token}`,
      },
      body: JSON.stringify(params),
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function createRpcClient(dir: string, expectedPid?: number): RpcClient {
  return {
    async pending(lastReceivedId, sessionId) {
      const out = await call<{ messages: RpcNotification[] }>(
        dir,
        'pending-notifications',
        { lastReceivedId, sessionId },
        expectedPid,
      )
      return out?.messages ?? []
    },
    async apply(request) {
      const out = await call<ApplyResult>(
        dir,
        'apply',
        { ...request },
        expectedPid,
      )
      return out ?? { text: 'apply failed', knobs: {} }
    },
    async applyMenu(request) {
      if (request.command !== 'claude' || !request.sessionId?.trim())
        throw new TypeError('A claude menu sessionId is required')
      const out = await call<CommandApplyResult>(
        dir,
        'apply-menu',
        { ...request },
        expectedPid,
      )
      if (!out) throw new Error('Menu apply unavailable; outcome unknown')
      return out
    },
  }
}
