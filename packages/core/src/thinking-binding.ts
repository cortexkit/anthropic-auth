import type { AccountStorage } from './accounts.ts'
import {
  isClaudeFable51Model,
  isClaudeHaiku55Model,
  isClaudeOpus55Model,
  isClaudeSonnet55Model,
} from './models.ts'

export const THINKING_BINDING_CONTROLS_BETA =
  'thinking-binding-controls-2026-08-01'

export type ThinkingPrefixMismatchBehavior =
  | 'account-default'
  | 'error'
  | 'drop_block'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isReplayableThinkingBlock(block: unknown) {
  if (!isRecord(block)) return false
  if (block.type === 'thinking') {
    return typeof block.signature === 'string' && block.signature.length > 0
  }
  if (block.type === 'redacted_thinking') {
    return typeof block.data === 'string' && block.data.length > 0
  }
  return false
}

export function getThinkingPrefixMismatchBehavior(
  storage: Pick<AccountStorage, 'thinkingBinding'> | null | undefined,
): ThinkingPrefixMismatchBehavior {
  const behavior = storage?.thinkingBinding?.prefixMismatchBehavior
  return behavior === 'error' || behavior === 'drop_block'
    ? behavior
    : 'account-default'
}

export function hasReplayableThinkingBlocks(body: Record<string, unknown>) {
  if (!Array.isArray(body.messages)) return false
  return body.messages.some((message) => {
    if (!isRecord(message) || message.role !== 'assistant') return false
    return (
      Array.isArray(message.content) &&
      message.content.some(isReplayableThinkingBlock)
    )
  })
}

export function applyThinkingBindingControls(
  body: Record<string, unknown>,
  behavior: ThinkingPrefixMismatchBehavior = 'account-default',
) {
  if (behavior === 'account-default') return false
  if (
    !isClaudeFable51Model(body.model) &&
    !isClaudeOpus55Model(body.model) &&
    !isClaudeSonnet55Model(body.model) &&
    !isClaudeHaiku55Model(body.model)
  )
    return false
  if (!hasReplayableThinkingBlocks(body)) return false
  // block_binding is only defined for adaptive thinking. In particular,
  // Sonnet 5.5's between_tools mode rejects this field with HTTP 400.
  if (!isRecord(body.thinking) || body.thinking.type !== 'adaptive')
    return false

  body.thinking.block_binding = {
    prefix_mismatch_behavior: behavior,
  }
  return true
}

export function hasThinkingBindingControls(body: Record<string, unknown>) {
  if (!isRecord(body.thinking)) return false
  if (!isRecord(body.thinking.block_binding)) return false
  const behavior = body.thinking.block_binding.prefix_mismatch_behavior
  return behavior === 'error' || behavior === 'drop_block'
}
