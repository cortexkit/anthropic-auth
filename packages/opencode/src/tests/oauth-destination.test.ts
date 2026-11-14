import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  ANTHROPIC_OAUTH_ORIGIN_REFUSAL,
  AnthropicOAuthOriginError,
} from '@cortexkit/anthropic-auth-core'
import {
  isAllowedOAuthDestination,
  requireOAuthDestination,
  TEST_OAUTH_LOOPBACK_ORIGIN_KEY,
  testOAuthLoopbackOrigin,
} from '../oauth-destination'

// The variable name the escape hatch used to read; it must stay inert.
const RETIRED_ENV = 'ANTHROPIC_AUTH_TEST_OAUTH_LOOPBACK_ORIGIN'
const KEYS = [RETIRED_ENV, 'ANTHROPIC_BASE_URL']
const saved = new Map<string, string | undefined>()
const hook = globalThis as Record<symbol, unknown>
beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  delete hook[TEST_OAUTH_LOOPBACK_ORIGIN_KEY]
})
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete hook[TEST_OAUTH_LOOPBACK_ORIGIN_KEY]
})

test.each([
  'http://127.0.0.1:43123',
  'https://127.0.0.1:43123',
  'http://localhost:43123',
  'http://[::1]:43123',
])('accepts the exact loopback origin %s', (value) => {
  hook[TEST_OAUTH_LOOPBACK_ORIGIN_KEY] = value
  expect(testOAuthLoopbackOrigin()).toBe(value)
  expect(isAllowedOAuthDestination(`${value}/v1/messages?beta=true`)).toBe(true)
})

test.each([
  ['a non-loopback host', 'https://proxy.example.test:8443'],
  ['a private network host', 'http://10.0.0.5:8080'],
  ['a loopback origin with a path', 'http://127.0.0.1:43123/v1'],
  ['a loopback origin with a trailing slash', 'http://127.0.0.1:43123/'],
  ['a loopback origin without a port', 'http://127.0.0.1'],
  ['a loopback origin with userinfo', 'http://user:pass@127.0.0.1:43123'],
  ['a loopback origin with a query', 'http://127.0.0.1:43123?x=1'],
  ['a non-HTTP scheme', 'ws://127.0.0.1:43123'],
  ['a value that is not a URL', '127.0.0.1:43123'],
])('ignores %s, leaving OAuth limited to api.anthropic.com', (_, value) => {
  hook[TEST_OAUTH_LOOPBACK_ORIGIN_KEY] = value
  expect(testOAuthLoopbackOrigin()).toBeUndefined()
  const target = value.startsWith('127.') ? `http://${value}` : value
  expect(() => requireOAuthDestination(`${target}/v1/messages`)).toThrow(
    AnthropicOAuthOriginError,
  )
  expect(
    requireOAuthDestination('https://api.anthropic.com/v1/messages').origin,
  ).toBe('https://api.anthropic.com')
})

test('ANTHROPIC_BASE_URL alone never admits an OAuth destination', () => {
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:43123'
  expect(isAllowedOAuthDestination('http://127.0.0.1:43123/v1/messages')).toBe(
    false,
  )
})

test('a URL with userinfo is refused even on the official host', () => {
  expect(() =>
    requireOAuthDestination(
      'https://user:sk-ant-oat01-userinfo@api.anthropic.com/v1/messages',
    ),
  ).toThrow(ANTHROPIC_OAUTH_ORIGIN_REFUSAL)
})

test('the environment variable alone never opens a loopback origin', () => {
  // A project's .env file can set environment variables when OpenCode runs
  // from source; only code in the process can set the test hook.
  process.env[RETIRED_ENV] = 'http://127.0.0.1:43123'
  expect(testOAuthLoopbackOrigin()).toBeUndefined()
  expect(isAllowedOAuthDestination('http://127.0.0.1:43123/v1/messages')).toBe(
    false,
  )
})
