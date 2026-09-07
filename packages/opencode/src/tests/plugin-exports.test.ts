import { describe, expect, test } from 'bun:test'

describe('plugin module exports', () => {
  test('exports only the plugin factory as a function', async () => {
    const pluginModule = await import('../index')
    const functionExports = Object.entries(pluginModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort()

    expect(functionExports).toEqual(['AnthropicAuthPlugin'])
  })

  test('does not expose a state-mutating test hook to the OpenCode loader', async () => {
    const pluginModule = await import('../index')

    expect('__setBootProfileHydrationForTest' in pluginModule).toBe(false)
  })

  test('does not expose a credential-cache construction hook', async () => {
    const { AnthropicAuthPlugin } = await import('../index')
    const plugin = await (
      AnthropicAuthPlugin as unknown as (
        ctx: unknown,
      ) => Promise<Record<string, unknown>>
    )({ client: { auth: { set: async () => {} } } })

    expect('__ensureClaustrumCredentialCacheForTest' in plugin).toBe(false)
    await (plugin.dispose as (() => Promise<void>) | undefined)?.()
  })
})
