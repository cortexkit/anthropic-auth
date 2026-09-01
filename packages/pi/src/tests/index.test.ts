import { describe, expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import cortexKitPiAnthropicAuth from '../index'

function mockPi() {
  const providers = new Map<
    string,
    { models?: Array<Record<string, unknown>> }
  >()

  const pi = {
    registerCommand: () => {},
    registerProvider: (
      name: string,
      config: { models?: Array<Record<string, unknown>> },
    ) => {
      providers.set(name, config)
    },
  } as unknown as ExtensionAPI

  return { pi, providers }
}

describe('cortexKitPiAnthropicAuth provider registration', () => {
  test('exposes Claude Sonnet 5 in the Pi Anthropic catalog', () => {
    const { pi, providers } = mockPi()

    cortexKitPiAnthropicAuth(pi)

    const anthropic = providers.get('anthropic')
    expect(anthropic).toBeDefined()

    const sonnet5 = anthropic?.models?.find(
      (model) => model.id === 'claude-sonnet-5',
    )
    expect(sonnet5).toMatchObject({
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
  })

  test('exposes Claude Fable and Mythos 5.1 in the Pi Anthropic catalog', () => {
    const { pi, providers } = mockPi()

    cortexKitPiAnthropicAuth(pi)

    const models = providers.get('anthropic')?.models ?? []
    expect(models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-fable-5-1',
          name: 'Claude Fable 5.1',
          reasoning: true,
          cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }),
        expect.objectContaining({
          id: 'claude-mythos-5-1',
          name: 'Claude Mythos 5.1',
          reasoning: true,
          cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        }),
      ]),
    )
  })

  test('exposes Claude Opus 5 in the Pi Anthropic catalog', () => {
    const { pi, providers } = mockPi()

    cortexKitPiAnthropicAuth(pi)

    const opus5 = providers
      .get('anthropic')
      ?.models?.find((model) => model.id === 'claude-opus-5')
    expect(opus5).toMatchObject({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
  })
})
