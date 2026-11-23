import { afterEach, describe, expect, test } from 'bun:test'
import {
  type ClaudeCodeIdentity,
  type ProviderAccountUuid,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'
import { buildAnthropicRequest } from '../convert'

const routingKey = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const originalRouting = globals[routingKey]
afterEach(() => {
  if (originalRouting === undefined) delete globals[routingKey]
  else globals[routingKey] = originalRouting
})

const identity: ClaudeCodeIdentity = {
  deviceId: 'd'.repeat(64),
  accountUuid: '00000000-0000-4000-8000-000000000001' as ProviderAccountUuid,
  sessionId: '11111111-2222-4333-8444-555555555555',
}
const headSessionId = 'pi-output-cap-head'

function build(
  options: SimpleStreamOptions & {
    cortexkitFork?: { headSessionId: string }
  } = { sessionId: headSessionId },
  controls: NonNullable<Parameters<typeof buildAnthropicRequest>[6]> = {},
  model = 'claude-sonnet-4-6',
) {
  return buildAnthropicRequest(
    model,
    { messages: [{ role: 'user', content: 'Question', timestamp: 0 }] },
    options,
    { enabled: false, mode: 'automatic' },
    false,
    controls.apiKey ? undefined : identity,
    controls,
  )
}

function setCap(cap: number) {
  globals[routingKey] = () => ({ max_output_tokens: () => cap })
}

describe('Pi run output cap', () => {
  test('lowers the default max_tokens in the signed body', async () => {
    setCap(3_000)
    const { bodyText } = await build()
    expect(JSON.parse(bodyText).max_tokens).toBe(3_000)
    expect(await signRequestBody(bodyText)).toBe(bodyText)
  })

  test('keeps the body byte-identical when the cap does not bind', async () => {
    delete globals[routingKey]
    const options = { sessionId: headSessionId, reasoning: 'high' } as const
    const baseline = await build(options)
    expect(baseline.body.max_tokens).toBe(16_384)
    setCap(20_000)
    expect((await build(options)).bodyText).toBe(baseline.bodyText)
  })

  test.each<[string, () => unknown]>([
    ['missing handle', () => undefined],
    ['missing method', () => ({})],
    ['null', () => ({ max_output_tokens: () => null })],
    [
      'throw',
      () => ({
        max_output_tokens() {
          throw new Error('not attached')
        },
      }),
    ],
    [
      'pending promise',
      () => ({ max_output_tokens: () => new Promise(() => {}) }),
    ],
    [
      'rejected promise',
      () => ({ max_output_tokens: () => Promise.reject(new Error('async')) }),
    ],
    ['zero', () => ({ max_output_tokens: () => 0 })],
    ['negative', () => ({ max_output_tokens: () => -2 })],
    ['fraction', () => ({ max_output_tokens: () => 0.5 })],
    ['string', () => ({ max_output_tokens: () => '3000' })],
    [
      'unsafe integer',
      () => ({ max_output_tokens: () => Number.MAX_SAFE_INTEGER + 1 }),
    ],
  ])('keeps the signed body byte-identical for %s', async (_, routing) => {
    delete globals[routingKey]
    const options = { sessionId: headSessionId, reasoning: 'high' } as const
    const baseline = await build(options)
    globals[routingKey] = routing
    expect((await build(options)).bodyText).toBe(baseline.bodyText)
  })

  test('caps the payload hook’s replacement', async () => {
    setCap(3_000)
    const { bodyText } = await build(undefined, {
      onPayload: (body) => ({ ...body, max_tokens: 5_000 }),
    })
    expect(JSON.parse(bodyText).max_tokens).toBe(3_000)
  })

  test('keeps a lane start at one token under a larger cap', async () => {
    setCap(3_000)
    const { bodyText } = await build(undefined, { laneStart: true })
    expect(JSON.parse(bodyText).max_tokens).toBe(1)
  })

  test('clamps manual thinking to leave room for the answer', async () => {
    setCap(3_000)
    const { bodyText } = await build({
      sessionId: headSessionId,
      reasoning: 'low',
    })
    expect(JSON.parse(bodyText).thinking).toEqual({
      type: 'enabled',
      budget_tokens: 1_976,
    })
  })

  test('omits manual thinking when the remaining budget is below 1,024', async () => {
    setCap(2_047)
    const { bodyText } = await build({
      sessionId: headSessionId,
      reasoning: 'low',
    })
    expect(JSON.parse(bodyText).thinking).toBeUndefined()
  })

  test('leaves adaptive thinking unchanged', async () => {
    setCap(512)
    const { bodyText } = await build(undefined, {}, 'claude-opus-5-5')
    expect(JSON.parse(bodyText)).toMatchObject({
      max_tokens: 512,
      thinking: { type: 'adaptive', display: 'summarized' },
    })
  })

  test('reads the fork’s handle without applying the head’s cap', async () => {
    const forkSessionId = 'pi-output-cap-fork'
    const reads: string[] = []
    globals[routingKey] = (sessionId: string) => ({
      max_output_tokens() {
        reads.push(sessionId)
        return sessionId === headSessionId ? 3_000 : null
      },
    })
    await build()
    const { bodyText } = await build({
      sessionId: forkSessionId,
      cortexkitFork: { headSessionId },
      maxTokens: 7_000,
    })
    expect(reads).toEqual([headSessionId, forkSessionId])
    expect(JSON.parse(bodyText).max_tokens).toBe(7_000)
  })

  test('caps paid API-key requests too', async () => {
    setCap(3_000)
    const { bodyText } = await build(undefined, { apiKey: true })
    expect(JSON.parse(bodyText).max_tokens).toBe(3_000)
  })
})
