import { afterEach, expect, test } from 'bun:test'
import { SessionCacheActivity } from '../session-cache-activity.ts'
import {
  applySessionCacheTtl,
  readSessionCachePolicy,
  requestCacheLifetimeMs,
} from '../session-cache-policy.ts'

const key = Symbol.for('cortexkit.routing')
const globals = globalThis as Record<symbol, unknown>
const previous = globals[key]
afterEach(() => {
  if (previous === undefined) delete globals[key]
  else globals[key] = previous
})

test('policy is synchronous, fresh, session-local and OAuth-only', () => {
  let ttl = 'short'
  const reads: string[] = []
  globals[key] = (id: string) => ({
    cache: () => {
      reads.push(id)
      return { ttl: id === 'a' ? ttl : 'none', keep_warm: 'off' }
    },
  })
  expect(readSessionCachePolicy('a', true)).toEqual({
    ttl: 'short',
    keep_warm: 'off',
  })
  ttl = 'long'
  expect(readSessionCachePolicy('a', true)).toEqual({
    ttl: 'long',
    keep_warm: 'off',
  })
  expect(readSessionCachePolicy('b', true)).toEqual({
    ttl: 'none',
    keep_warm: 'off',
  })
  expect(readSessionCachePolicy('a', false)).toBeNull()
  expect(readSessionCachePolicy(undefined, true)).toBeNull()
  expect(reads).toEqual(['a', 'a', 'b'])
})

test('missing and broken bridges preserve local selection instead of inventing auto', () => {
  for (const bridge of [
    undefined,
    {},
    () => ({}),
    () => ({ cache: () => null }),
    () => {
      throw new Error('broken bridge')
    },
    () => ({ cache: () => ({ ttl: 'invalid' }) }),
  ]) {
    globals[key] = bridge
    expect(readSessionCachePolicy('a', true)).toBeNull()
  }
  globals[key] = () => ({ cache: () => ({ keep_warm: 'off' }) })
  expect(readSessionCachePolicy('a', true)).toEqual({ keep_warm: 'off' })
})

test('none removes both marker spellings only at protocol sites', () => {
  const body: Record<string, unknown> = {
    cache_control: { type: 'ephemeral' },
    tools: [
      {
        cacheControl: { type: 'ephemeral' },
        input_schema: {
          properties: { cache_control: { type: 'string' } },
        },
      },
    ],
    system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      {
        cacheControl: { type: 'ephemeral' },
        content: [
          {
            type: 'tool_use',
            input: { cache_control: 'argument' },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  }
  applySessionCacheTtl(body, 'none')
  expect(body).toEqual({
    tools: [
      { input_schema: { properties: { cache_control: { type: 'string' } } } },
    ],
    system: [{}],
    messages: [
      { content: [{ type: 'tool_use', input: { cache_control: 'argument' } }] },
    ],
  })
  expect(requestCacheLifetimeMs(body)).toBe(0)
})

test('explicit lifetimes normalize markers and omitted lifetime preserves a mix', () => {
  const body = {
    system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
    tools: [{ cacheControl: { type: 'ephemeral' } }],
  }
  const original = structuredClone(body)
  applySessionCacheTtl(body, undefined)
  expect(body).toEqual(original)
  expect(requestCacheLifetimeMs(body)).toBe(3_600_000)
  applySessionCacheTtl(body, 'short')
  expect(body.system[0]?.cache_control).not.toHaveProperty('ttl')
  expect(requestCacheLifetimeMs(body)).toBe(300_000)
  applySessionCacheTtl(body, 'long')
  expect(body.system[0]?.cache_control).toEqual({
    type: 'ephemeral',
    ttl: '1h',
  })
  expect(requestCacheLifetimeMs(JSON.stringify(body))).toBe(3_600_000)
  expect(requestCacheLifetimeMs({})).toBe(0)
  expect(requestCacheLifetimeMs('invalid JSON')).toBe(0)
})

test('no-cache acceptance clears holds and short warms retain their actual lifetime', () => {
  const activity = new SessionCacheActivity()
  activity.record('s', 'a', 3_600_000, 100)
  activity.record('s', 'a', 0, 200)
  expect(activity.holdUntil('s', 'a', 200, 'max')).toBeUndefined()
  activity.recordPrewarm('s', 'a', 300, 300_000)
  expect(activity.holdUntil('s', 'a', 300, 'max')).toBe(300_300)
  activity.record('s', 'b', 300_000, 400)
  activity.recordPrewarm('s', 'a', 500, 3_600_000)
  expect(activity.holdUntil('s', 'b', 500, 'max')).toBe(300_400)
})
