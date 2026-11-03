import type { ClaudeCodeRequestClass } from '@cortexkit/anthropic-auth-core'

/**
 * Plugin-internal header that carries a request's Claude Code request class
 * from the host's per-message hook to the fetch wrapper. It is removed before
 * the request leaves.
 */
export const REQUEST_CLASS_REQUEST_HEADER = 'x-cortexkit-request-class'

/**
 * Agents whose requests Claude Code would mark `auxiliary`: they run beside a
 * conversation rather than answering a prompt. `title`, `summary` and
 * `compaction` are OpenCode's background agents; `prime` is this plugin's tiny request that
 * starts an account's five-hour quota window, like Claude Code's own
 * auxiliary quota check. Every other request is `main`.
 */
const AUXILIARY_AGENTS = new Set(['title', 'summary', 'compaction', 'prime'])

export function isAuxiliaryAgent(agent: unknown): boolean {
  return typeof agent === 'string' && AUXILIARY_AGENTS.has(agent)
}

/** Read and remove the internal request-class header. */
export function takeRequestClassHeader(
  headers: Headers,
): ClaudeCodeRequestClass {
  const value = headers.get(REQUEST_CLASS_REQUEST_HEADER)
  headers.delete(REQUEST_CLASS_REQUEST_HEADER)
  return value === 'auxiliary' ? 'auxiliary' : 'main'
}
