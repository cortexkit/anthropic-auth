import { expect, test } from 'bun:test'
import { buildCacheKeepPrewarmBody } from '../cachekeep.ts'
import { extractBillingHeaderCCH, signRequestBody } from '../cch.ts'
import { sanitizeClaudeCodeRequestBody } from '../server-fallback.ts'
import {
  SERVER_FALLBACK_USAGE_MARKER_TEXT,
  SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX,
  stripServerFallbackUsageMarkers,
} from '../server-fallback-usage.ts'

test('usage markers are stripped from every message role, including normalized text and forged signatures', () => {
  for (const role of ['assistant', 'user']) {
    for (const [thinking, signature] of [
      [SERVER_FALLBACK_USAGE_MARKER_TEXT, 'forged'],
      ['', `${SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX}{"iterations":[]}`],
    ]) {
      const text = { type: 'text', text: 'answer' }
      const body = {
        messages: [
          { role, content: [text, { type: 'thinking', thinking, signature }] },
        ],
      }
      expect(stripServerFallbackUsageMarkers(body)).toBe(1)
      expect(body).toEqual({ messages: [{ role, content: [text] }] })
    }
  }
})

test('ordinary and source prewarms strip usage markers without changing outgoing bytes', async () => {
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 100,
    stream: true,
    fallbacks: 'default',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ],
  }
  for (const refusalFallbackMode of ['client', 'off', 'server'] as const) {
    for (const signature of [
      `${SERVER_FALLBACK_USAGE_SIGNATURE_PREFIX}{"iterations":[]}`,
      'forged-provider-signature',
    ]) {
      const marked = structuredClone(body)
      const content: unknown[] = marked.messages[1]!.content
      content.push({
        type: 'thinking',
        thinking: SERVER_FALLBACK_USAGE_MARKER_TEXT,
        signature,
      })
      const expected = await buildCacheKeepPrewarmBody(JSON.stringify(body), {
        refusalFallbackMode,
      })
      const actual = await buildCacheKeepPrewarmBody(JSON.stringify(marked), {
        refusalFallbackMode,
      })
      expect(expected.ok).toBe(true)
      expect(actual).toEqual(expected)
    }
  }
})

test.each(['client', 'off', 'server'] as const)(
  '%s post-hook preparation drops unsigned thinking before signing',
  async (mode) => {
    const signedThinking = {
      type: 'thinking',
      thinking: 'kept',
      signature: 'signed',
    }
    const redactedThinking = { type: 'redacted_thinking', data: 'opaque' }
    const text = { type: 'text', text: 'answer' }
    const user = { role: 'user', content: 'continue' }
    const ordinary = {
      model: 'claude-fable-5',
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.302; cc_entrypoint=cli; cch=00000;',
        },
      ],
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: [signedThinking, redactedThinking, text],
        },
        user,
      ],
      ...(mode === 'server' ? { fallbacks: 'default' } : {}),
    }
    const unsignedOrdinary = JSON.stringify(ordinary)
    const expected = await signRequestBody(unsignedOrdinary)
    expect(extractBillingHeaderCCH(expected)).not.toBe('00000')
    expect(sanitizeClaudeCodeRequestBody(ordinary, mode)).toBe(false)
    expect(JSON.stringify(ordinary)).toBe(unsignedOrdinary)
    for (const value of ['default', false, null, { caller: 'custom' }, []]) {
      const callerReplacement = {
        ...ordinary,
        fallbacks: mode === 'server' ? 'default' : value,
        messages: [
          ordinary.messages[0]!,
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'no signature' },
              signedThinking,
              { type: 'thinking', thinking: 'empty signature', signature: '' },
              redactedThinking,
              text,
            ],
          },
          user,
        ],
      }
      expect(sanitizeClaudeCodeRequestBody(callerReplacement, mode)).toBe(true)
      expect(await signRequestBody(JSON.stringify(callerReplacement))).toBe(
        expected,
      )
    }
  },
)
