import { describe, expect, test } from 'bun:test'
import type { OAuthQuotaSnapshot } from '../accounts.ts'
import { SessionCacheActivity } from '../session-cache-activity.ts'
import {
  decideStickyQuotaFailure,
  stickyRetainRetryHeaders,
  stickyRetryAfterWithJitter,
} from '../sticky-routing.ts'

const NOW = Date.parse('2026-10-24T08:00:00Z')
const MODEL = 'claude-fable-5'
const kinds = ['five-hour', 'seven-day', 'model-scoped'] as const
type Kind = (typeof kinds)[number]

function exhausted(kind: Kind, reset: string | undefined): OAuthQuotaSnapshot {
  const window = {
    usedPercent: 100,
    remainingPercent: 0,
    resetsAt: reset,
    checkedAt: NOW,
  }
  if (kind === 'five-hour') return { five_hour: window }
  if (kind === 'seven-day') return { seven_day: window }
  return {
    scoped: [
      {
        ...window,
        id: 'fable-weekly',
        title: 'Fable only',
        modelName: 'Fable',
      },
    ],
  }
}

function decide(quota: OAuthQuotaSnapshot, modelId = MODEL) {
  return decideStickyQuotaFailure({
    quota,
    modelId,
    now: NOW,
    sessionId: 'session-a',
    holdUntil: NOW + 40 * 60_000,
  })
}

const resetIn = (ms: number) => new Date(NOW + ms).toISOString()

describe('sticky quota hold', () => {
  test('429 headers confirm raw exhaustion, including rejected windows without utilization', () => {
    for (const suffix of ['5h', '7d', '7d_opus', '7d-opus']) {
      for (const evidence of [{ utilization: '1.0' }, { status: 'rejected' }]) {
        const headers = new Headers({
          [`anthropic-ratelimit-unified-${suffix}-reset`]: String(
            (NOW + 5 * 24 * 60 * 60_000) / 1000,
          ),
        })
        for (const [name, value] of Object.entries(evidence))
          headers.set(`anthropic-ratelimit-unified-${suffix}-${name}`, value)
        expect(
          decideStickyQuotaFailure({
            quota: undefined,
            responseHeaders: headers,
            modelId: 'claude-opus-5-5',
            now: NOW,
          }).action,
        ).toBe('migrate')
      }
    }
  })

  test('429 header confirmation ignores rounded near-exhaustion and other models', () => {
    for (const suffix of ['5h', '7d']) {
      const headers = new Headers({
        [`anthropic-ratelimit-unified-${suffix}-utilization`]: '0.999',
      })
      expect(
        decideStickyQuotaFailure({
          quota: {
            source: 'headers',
            ...exhausted(
              suffix === '5h' ? 'five-hour' : 'seven-day',
              undefined,
            ),
          },
          responseHeaders: headers,
          now: NOW,
        }).action,
      ).toBe('retain')
    }
    expect(
      decideStickyQuotaFailure({
        quota: undefined,
        responseHeaders: new Headers({
          'anthropic-ratelimit-unified-7d_opus-status': 'rejected',
        }),
        modelId: 'claude-sonnet-4-6',
        now: NOW,
      }).action,
    ).toBe('retain')
  })

  test('429 headers override a non-exhausted probe and preserve the latest blocking reset', () => {
    expect(
      decideStickyQuotaFailure({
        quota: exhausted('five-hour', resetIn(12 * 60_000)),
        holdUntil: NOW + 40 * 60_000,
        responseHeaders: new Headers({
          'anthropic-ratelimit-unified-7d-status': 'rejected',
          'anthropic-ratelimit-unified-7d-reset': String(
            (NOW + 10 * 60_000) / 1000,
          ),
        }),
        now: NOW,
      }),
    ).toEqual({
      action: 'hold',
      reason: 'five-hour-short-reset',
      retryAfterSeconds: 720,
    })
  })

  test('retained retry caps retry hints without changing rate-limit evidence', () => {
    for (const seconds of [2, 60, 5 * 24 * 60 * 60]) {
      const headers = stickyRetainRetryHeaders(
        new Headers({
          'retry-after': new Date(NOW + seconds * 1000).toUTCString(),
          'retry-after-ms': String(seconds * 1000),
          'anthropic-ratelimit-unified-7d-reset': String(
            (NOW + seconds * 1000) / 1000,
          ),
          'anthropic-ratelimit-tokens-reset': new Date(
            NOW + seconds * 1000,
          ).toISOString(),
        }),
        NOW,
      )
      const expected = Math.min(60, seconds)
      expect(headers.get('retry-after')).toBe(String(expected))
      expect(headers.get('retry-after-ms')).toBe(String(expected * 1000))
      expect(headers.get('anthropic-ratelimit-unified-7d-reset')).toBe(
        String(NOW / 1000 + seconds),
      )
      expect(headers.get('anthropic-ratelimit-tokens-reset')).toBe(
        new Date(NOW + seconds * 1000).toISOString(),
      )
    }
  })

  test('retained retry can shorten its wait from reset evidence without changing any rate-limit header', () => {
    const upstream = new Headers({
      'retry-after': '432000',
      'retry-after-ms': '432000000',
      'anthropic-ratelimit-unified-7d-reset': String(NOW / 1000 + 432000),
      'anthropic-ratelimit-requests-reset': new Date(NOW + 2000).toISOString(),
      'anthropic-ratelimit-tokens-reset': 'invalid-reset',
      'anthropic-ratelimit-unified-7d-utilization': '0.999',
      'anthropic-ratelimit-unified-status': 'allowed_warning',
    })
    const headers = stickyRetainRetryHeaders(upstream, NOW)
    expect(headers.get('retry-after')).toBe('2')
    expect(headers.get('retry-after-ms')).toBe('2000')
    expect(
      [...headers].filter(([name]) => name.startsWith('anthropic-ratelimit-')),
    ).toEqual(
      [...upstream].filter(([name]) => name.startsWith('anthropic-ratelimit-')),
    )
  })

  for (const kind of kinds) {
    test(`${kind} holds while the reset and jitter fit the cache lifetime`, () => {
      for (const ms of [1, 10 * 60_000, 40 * 60_000 - 16_000]) {
        expect(decide(exhausted(kind, resetIn(ms)))).toEqual({
          action: 'hold',
          reason: `${kind}-short-reset`,
          retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)),
        })
      }
    })

    test(`${kind} moves when jitter pushes past the cache lifetime`, () => {
      expect(decide(exhausted(kind, resetIn(40 * 60_000 - 15_999)))).toEqual({
        action: 'migrate',
        reason: kind,
      })
    })

    test(`${kind} moves for unknown invalid or past resets even with another short reset`, () => {
      for (const reset of [undefined, '', 'invalid', resetIn(0), resetIn(-1)]) {
        const other = kind === 'five-hour' ? 'seven-day' : 'five-hour'
        expect(
          decide({
            ...exhausted(other, resetIn(60_000)),
            ...exhausted(kind, reset),
          }),
        ).toEqual({ action: 'migrate', reason: kind })
      }
    })
  }

  test('uses the latest blocking reset for both the hold and its duration', () => {
    for (const first of kinds) {
      for (const second of kinds.filter((kind) => kind !== first)) {
        const quota = {
          ...exhausted(first, resetIn(5 * 60_000)),
          ...exhausted(second, resetIn(12 * 60_000)),
        }
        expect(decide(quota)).toEqual({
          action: 'hold',
          reason: `${second}-short-reset`,
          retryAfterSeconds: 12 * 60,
        })
        expect(
          decide({ ...quota, ...exhausted(second, resetIn(40 * 60_000)) }),
        ).toEqual({ action: 'migrate', reason: second })
      }
    }
    expect(
      decide({
        ...exhausted('five-hour', resetIn(14 * 60_000)),
        ...exhausted('seven-day', resetIn(10 * 60_000)),
        ...exhausted('model-scoped', resetIn(2 * 60_000)),
      }),
    ).toEqual({
      action: 'hold',
      reason: 'five-hour-short-reset',
      retryAfterSeconds: 14 * 60,
    })
  })

  test('ignores an exhausted scope for a different model including an unknown reset', () => {
    for (const reset of [undefined, resetIn(60 * 60_000)]) {
      const scoped = exhausted('model-scoped', reset)
      expect(decide(scoped, 'claude-opus-5')).toEqual({
        action: 'retain',
        reason: 'not-exhausted',
      })
      expect(
        decide(
          { ...scoped, ...exhausted('five-hour', resetIn(10 * 60_000)) },
          'claude-opus-5',
        ),
      ).toEqual({
        action: 'hold',
        reason: 'five-hour-short-reset',
        retryAfterSeconds: 600,
      })
    }
  })

  test('retains unknown and non-exhausted quotas unchanged', () => {
    for (const quota of [undefined, { kind: 'unknown' as const }]) {
      expect(decideStickyQuotaFailure({ quota, now: NOW })).toEqual({
        action: 'retain',
        reason: 'unknown',
      })
    }
    expect(decide({})).toEqual({ action: 'retain', reason: 'not-exhausted' })
    expect(
      decide({
        five_hour: { usedPercent: 99, remainingPercent: 1, checkedAt: NOW },
      }),
    ).toEqual({ action: 'retain', reason: 'not-exhausted' })
  })

  test('keeps the existing deterministic SHA256 session jitter', () => {
    expect(stickyRetryAfterWithJitter('session-a', 840)).toBe(856)
    expect(stickyRetryAfterWithJitter('session-a', 0)).toBe(17)
    expect(stickyRetryAfterWithJitter('session-a', 1.1)).toBe(18)
  })

  test('holds a thirty-minute reset with a warm one-hour cache only under max, not the default fifteen minutes', () => {
    const activity = new SessionCacheActivity()
    activity.record('session-a', 'account-a', 3_600_000, NOW - 5 * 60_000)
    for (const maxWait of [undefined, '15', 'max'] as const) {
      expect(
        decideStickyQuotaFailure({
          quota: exhausted('five-hour', resetIn(30 * 60_000)),
          now: NOW,
          sessionId: 'session-a',
          holdUntil: activity.holdUntil('session-a', 'account-a', NOW, maxWait),
        }).action,
      ).toBe(maxWait === 'max' ? 'hold' : 'migrate')
    }
  })

  test('zero wait migrates even with a live cache and a two-minute reset', () => {
    const activity = new SessionCacheActivity()
    activity.record('session-a', 'account-a', 3_600_000, NOW)
    expect(
      decideStickyQuotaFailure({
        quota: exhausted('five-hour', resetIn(2 * 60_000)),
        now: NOW,
        sessionId: 'session-a',
        holdUntil: activity.holdUntil('session-a', 'account-a', NOW, '0'),
      }).action,
    ).toBe('migrate')
  })

  test('migrates a ten-minute reset when the five-minute cache expires in three minutes', () => {
    const activity = new SessionCacheActivity()
    activity.record('session-a', 'account-a', 300_000, NOW - 2 * 60_000)
    expect(
      decideStickyQuotaFailure({
        quota: exhausted('five-hour', resetIn(10 * 60_000)),
        now: NOW,
        sessionId: 'session-a',
        holdUntil: activity.holdUntil('session-a', 'account-a', NOW),
      }).action,
    ).toBe('migrate')
  })

  test('migrates without activity on the same account', () => {
    const activity = new SessionCacheActivity()
    activity.record('other-session', 'account-a', 3_600_000, NOW)
    activity.record('different-account', 'account-b', 3_600_000, NOW)
    for (const sessionId of ['missing', 'different-account']) {
      expect(
        decideStickyQuotaFailure({
          quota: exhausted('five-hour', resetIn(10 * 60_000)),
          now: NOW,
          sessionId,
          holdUntil: activity.holdUntil(sessionId, 'account-a', NOW),
        }).action,
      ).toBe('migrate')
    }
  })
})
