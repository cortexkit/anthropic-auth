export function promptCacheSnapshot(body: Record<string, unknown>): string {
  // The billing header carries a request signature and turn lineage, and the
  // top-level diagnostics ID links provider replies. Neither is part of the
  // prompt-cache prefix; forks deliberately don't join those chains.
  const { diagnostics: _diagnostics, ...prefix } = body
  if (Array.isArray(prefix.system)) {
    prefix.system = prefix.system.map((block) =>
      block?.type === 'text' &&
      typeof block?.text === 'string' &&
      block.text.startsWith('x-anthropic-billing-header:')
        ? { ...block, text: 'x-anthropic-billing-header: MASKED' }
        : block,
    )
  }
  return JSON.stringify(prefix)
}
