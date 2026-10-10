import { afterEach, expect, test } from 'bun:test'
import {
  buildPiOAuthMessagesUrl,
  fetchPiOAuth,
  requirePiOAuthOrigin,
} from '../transport.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test.each([
  'https://unapproved.invalid',
  'http://api.anthropic.com',
  'https://api.anthropic.com:8443',
  'https://user:secret@api.anthropic.com',
  'blob:https://api.anthropic.com/opaque',
  'not a URL',
])('native OAuth URL parser refuses recipient %s', (url) => {
  expect(() => requirePiOAuthOrigin(url)).toThrow(
    'official Anthropic HTTPS origin',
  )
})

test('official versioned and default-port OAuth URLs keep the fixed Messages path', () => {
  expect(buildPiOAuthMessagesUrl('https://api.anthropic.com/v1').href).toBe(
    'https://api.anthropic.com/v1/messages?beta=true',
  )
  expect(buildPiOAuthMessagesUrl('HTTPS://API.ANTHROPIC.COM:443').href).toBe(
    'https://api.anthropic.com/v1/messages?beta=true',
  )
})

test('guarded OAuth fetch overrides caller redirect-follow and refuses foreign recipients without dispatch', async () => {
  const sent: Array<{ url: string; redirect: RequestInit['redirect'] }> = []
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      sent.push({ url: String(input), redirect: init?.redirect })
      return new Response('{}')
    },
    { preconnect: originalFetch.preconnect },
  )
  await fetchPiOAuth('https://api.anthropic.com/api/oauth/profile', {
    redirect: 'follow',
  })
  await expect(
    fetchPiOAuth('https://unapproved.invalid/profile'),
  ).rejects.toThrow('official Anthropic HTTPS origin')
  expect(sent).toEqual([
    { url: 'https://api.anthropic.com/api/oauth/profile', redirect: 'error' },
  ])
})
