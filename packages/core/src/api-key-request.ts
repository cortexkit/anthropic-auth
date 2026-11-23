import { mergeAnthropicBetas } from './constants.ts'
import { remapRequestBodyModel } from './model-remap.ts'
import { stripEmptyTrailingAssistantMessages } from './request-history.ts'
import {
  SERVER_FALLBACK_SIGNATURE_PREFIX,
  SERVER_SIDE_FALLBACK_BETA,
  stripServerFallbackUsageMarkers,
} from './server-fallback-usage.ts'
import { applyRunnerTurnNotes } from './turn-end-note.ts'

const OAUTH_ONLY_BETAS = new Set([
  'oauth-2025-04-20',
  'claude-code-20250219',
  SERVER_SIDE_FALLBACK_BETA,
])

/** Preserve the host's betas except those used by the plugin's OAuth route. */
export function apiKeyRequestBetas(value: string): string {
  const kept = value
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta && !OAUTH_ONLY_BETAS.has(beta))
  return mergeAnthropicBetas(null, kept)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate the transcript, scrub plugin-only fallback state and apply proxy aliases. */
export function prepareApiKeyRequestBody(
  body: Record<string, unknown>,
  scrubHostMarkers?: (body: Record<string, unknown>) => boolean,
): boolean {
  let changed = stripEmptyTrailingAssistantMessages(body.messages) > 0
  if (body.fallbacks === 'default') {
    delete body.fallbacks
    changed = true
  }
  if (stripServerFallbackUsageMarkers(body) > 0) changed = true
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (message?.role !== 'assistant' || !Array.isArray(message.content))
        continue
      const content = message.content.filter(
        (block: unknown) =>
          !(
            isRecord(block) &&
            block.type === 'thinking' &&
            typeof block.signature === 'string' &&
            block.signature.startsWith(SERVER_FALLBACK_SIGNATURE_PREFIX)
          ),
      )
      if (content.length !== message.content.length) {
        message.content = content
        changed = true
      }
    }
  }
  if (scrubHostMarkers?.(body)) changed = true
  return remapRequestBodyModel(body) || changed
}

/** Leave the host's original bytes intact when the API route need not edit them. */
export function rewriteApiKeyRequestBody(
  text: string,
  options: {
    sessionId?: string
    modelId: string
    scrubHostMarkers?: (body: Record<string, unknown>) => boolean
  },
): string {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (!isRecord(body)) return text
  const changed = prepareApiKeyRequestBody(body, options.scrubHostMarkers)
  applyRunnerTurnNotes(body, {
    sessionId: options.sessionId,
    modelId: options.modelId,
    isOAuth: false,
  })
  return changed ? JSON.stringify(body) : text
}
