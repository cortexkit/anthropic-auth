export const SERVER_FALLBACK_USAGE_MARKER_TEXT = '\u2060\u2060'
export const SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX =
  'cortexkit-server-fallback-usage-v1:'

/** Usage-only thinking parts are local metadata, not provider conversation state. */
export function isServerFallbackUsageMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const block = value as Record<string, unknown>
  return (
    block.type === 'thinking' &&
    (block.thinking === SERVER_FALLBACK_USAGE_MARKER_TEXT ||
      (typeof block.signature === 'string' &&
        block.signature.startsWith(SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX)))
  )
}

/** Strip by text or signature prefix, including markers with corrupted signatures. */
export function stripServerFallbackUsageMarkers(body: Record<string, unknown>) {
  let removed = 0
  if (!Array.isArray(body.messages)) return removed
  for (const message of body.messages) {
    if (!message || !Array.isArray(message.content)) continue
    message.content = message.content.filter((block: unknown) => {
      if (!isServerFallbackUsageMarker(block)) return true
      removed++
      return false
    })
  }
  return removed
}
