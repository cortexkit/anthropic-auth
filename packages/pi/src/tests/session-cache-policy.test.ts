import { afterEach, expect, test } from 'bun:test'
import {
  getClaudeCodeIdentityForVerifiedAccount,
  type ProviderAccountUuid,
} from '@cortexkit/anthropic-auth-core'
import type { Context, Message } from '@earendil-works/pi-ai'
import { buildAnthropicRequest, piThreadCacheSlot } from '../convert.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const previous = globals[key]
afterEach(() => {
  if (previous === undefined) delete globals[key]
  else globals[key] = previous
})
const context: Context = {
  systemPrompt: 'Stable context',
  tools: [],
  messages: [{ role: 'user', content: 'Hello', timestamp: 0 }],
}
const identity = getClaudeCodeIdentityForVerifiedAccount(
  'cache-policy',
  '12345678-1234-1234-1234-123456789abc' as ProviderAccountUuid,
)

for (const mode of ['explicit', 'automatic', 'hybrid'] as const) {
  for (const ttl of ['none', 'short', 'long'] as const) {
    test(`${mode} applies OAuth ${ttl} after the host payload hook`, async () => {
      globals[key] = () => ({ cache: () => ({ ttl, keep_warm: 'off' }) })
      const sent = await buildAnthropicRequest(
        'claude-sonnet-5',
        structuredClone(context),
        { sessionId: 'ses_pi_policy', cacheRetention: 'long' },
        { enabled: ttl !== 'long', mode },
        false,
        identity,
        {
          deferSigning: true,
          onPayload: (body) => {
            body.cache_control = { type: 'ephemeral', ttl: '1h' }
            return body
          },
        },
      )
      const markers: unknown[] = []
      JSON.parse(sent.bodyText, (key, value: unknown) => {
        if (key === 'cache_control' || key === 'cacheControl')
          markers.push(value)
        return value
      })
      if (ttl === 'none') expect(markers).toEqual([])
      else {
        expect(markers.length).toBeGreaterThan(0)
        for (const marker of markers)
          expect(marker).toEqual(
            ttl === 'long'
              ? { type: 'ephemeral', ttl: '1h' }
              : { type: 'ephemeral' },
          )
      }
      expect(sent.cacheTtlMs).toBe(
        ttl === 'none' ? 0 : ttl === 'short' ? 300_000 : 3_600_000,
      )
    })
  }
}

test('identity-free conversion does not consult policy and keeps local long caching', async () => {
  globals[key] = () => {
    throw new Error('Requests without OAuth identity must not read routing')
  }
  const sent = await buildAnthropicRequest(
    'claude-sonnet-5',
    structuredClone(context),
    { sessionId: 'ses_pi_api' },
    { enabled: true, mode: 'automatic' },
  )
  expect(JSON.parse(sent.bodyText).cache_control).toEqual({
    type: 'ephemeral',
    ttl: '1h',
  })
  expect(sent.cacheTtlMs).toBe(3_600_000)
})

test('paid requests do not inherit session cache policy', async () => {
  let policyReads = 0
  globals[key] = () => ({
    cache: () => {
      policyReads++
      return { ttl: 'none' }
    },
  })
  const sent = await buildAnthropicRequest(
    'claude-sonnet-5',
    structuredClone(context),
    { sessionId: 'ses_pi_api', cacheRetention: 'short' },
    { enabled: true, mode: 'automatic' },
    false,
    undefined,
    { apiKey: true },
  )
  expect(policyReads).toBe(0)
  expect(sent.cacheTtlMs).toBe(300_000)
})

const hybridHistory: Context = {
  ...context,
  messages: [
    ...context.messages,
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
    } as Message,
    { role: 'user', content: 'Earlier boundary', timestamp: 1 },
    {
      role: 'assistant',
      content: Array.from({ length: 19 }, (_, index) => ({
        type: 'text',
        text: `Reply block ${index}`,
      })),
    } as Message,
    { role: 'user', content: 'Latest boundary', timestamp: 2 },
  ],
}

function buildHybridHistory(ttl?: 'short' | 'none') {
  globals[key] = () => ({ cache: () => (ttl ? { ttl } : null) })
  return buildAnthropicRequest(
    'claude-sonnet-5',
    hybridHistory,
    { sessionId: 'ses_pi_hybrid_layout' },
    { enabled: false, mode: 'hybrid' },
    false,
    identity,
    { deferSigning: true },
  )
}

test('five-minute hybrid sessions keep the bridge with or without a policy override', async () => {
  const { body, cacheTtlMs } = await buildHybridHistory()
  expect(piThreadCacheSlot(body)).toEqual({
    type: 'text',
    text: 'Earlier boundary',
    cache_control: { type: 'ephemeral' },
  })
  expect(cacheTtlMs).toBe(300_000)
  expect((await buildHybridHistory('short')).body).toEqual(body)
})

test('OAuth hybrid policy none leaves the earlier user message scalar', async () => {
  const { body, bodyText, cacheTtlMs } = await buildHybridHistory('none')
  expect(body.messages[2]).toEqual({
    role: 'user',
    content: 'Earlier boundary',
  })
  expect(bodyText).not.toContain('cache_control')
  expect(cacheTtlMs).toBe(0)
})
