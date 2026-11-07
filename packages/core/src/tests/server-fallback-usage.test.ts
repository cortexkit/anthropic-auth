import { expect, test } from 'bun:test'
import { buildCacheKeepPrewarmBody } from '../cachekeep.ts'
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
  for (const stripServerFallback of [true, false]) {
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
        stripServerFallback,
      })
      const actual = await buildCacheKeepPrewarmBody(JSON.stringify(marked), {
        stripServerFallback,
      })
      expect(expected.ok).toBe(true)
      expect(actual).toEqual(expected)
    }
  }
})
