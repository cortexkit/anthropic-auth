import { expect, test } from 'bun:test'
import {
  clampHostRetryMs,
  hostRetryHeaders,
  hostRetryResponse,
} from '../host-retry.ts'

const now = Date.parse('2026-11-12T08:08:52Z')

test('host retry cap covers seconds, milliseconds and HTTP dates without changing quota evidence', async () => {
  for (const after of ['93151', new Date(now + 93_151_000).toUTCString()]) {
    const headers = hostRetryHeaders(
      new Headers({
        'retry-after': after,
        'retry-after-ms': '93151000',
        'anthropic-ratelimit-unified-7d-reset': '1890000000',
      }),
      now,
    )
    expect(headers.get('retry-after')).toBe('900')
    expect(headers.get('retry-after-ms')).toBe('900000')
    expect(headers.get('anthropic-ratelimit-unified-7d-reset')).toBe(
      '1890000000',
    )
  }
  const upstream = new Response('limited', {
    status: 429,
    headers: { 'retry-after': '93151' },
  })
  const response = hostRetryResponse(upstream, now)
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('900')
  expect(await response.text()).toBe('limited')
})

test('host retry cap preserves shorter waits, handles invalid hints and bounds every delay', () => {
  const shorter = new Response(null, {
    status: 429,
    headers: { 'retry-after': '1.5', 'retry-after-ms': '1500' },
  })
  expect(hostRetryResponse(shorter, now)).toBe(shorter)
  expect(
    hostRetryHeaders(
      new Headers({ 'retry-after': 'invalid', 'retry-after-ms': '-1' }),
      now,
    ).get('retry-after'),
  ).toBeNull()
  for (const [value, expected] of [
    [93_151_000, 900_000],
    [900_000, 900_000],
    [1500, 1500],
    [-1, 0],
    [Infinity, 900_000],
    [NaN, 0],
  ])
    expect(clampHostRetryMs(value!)).toBe(expected!)
})
