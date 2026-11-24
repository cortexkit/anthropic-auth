import { CCH_PATTERN, stripBillingLineageFields } from '../cch.ts'

export function promptCacheSnapshot(body: Record<string, unknown>): string {
  // Compare fixed prefix bytes without the per-send signature or lineage.
  // Callers that compare different diagnostic contexts assert those separately.
  const { diagnostics: _diagnostics, ...prefix } = body
  if (Array.isArray(prefix.system)) {
    prefix.system = prefix.system.map((block) =>
      block?.type === 'text' &&
      typeof block?.text === 'string' &&
      block.text.startsWith('x-anthropic-billing-header:')
        ? {
            ...block,
            text: stripBillingLineageFields(
              block.text.replace(CCH_PATTERN, 'cch=00000;'),
            ),
          }
        : block,
    )
  }
  return JSON.stringify(prefix)
}
