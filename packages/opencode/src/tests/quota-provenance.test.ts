import { describe, expect, test } from 'bun:test'
import {
  fetchOAuthQuotaSnapshot,
  mergeHeaderQuotaForPersistence,
  type OAuthQuotaSnapshot,
} from '../../../core/src/accounts.ts'
import {
  mergeHeaderQuotaSnapshot,
  normalizeQuotaHeaders,
} from '../../../core/src/quota-headers.ts'

const BOTH_WINDOW_HEADERS = new Headers({
  'anthropic-ratelimit-unified-5h-utilization': '0.03',
  'anthropic-ratelimit-unified-7d-utilization': '0.12',
})

function pollWindows() {
  return {
    five_hour: {
      usedPercent: 10,
      remainingPercent: 90,
      checkedAt: 1_699_999_000_000,
    },
    seven_day: {
      usedPercent: 20,
      remainingPercent: 80,
      checkedAt: 1_699_999_000_000,
    },
    source: 'poll',
    checkedAt: 1_699_999_000_000,
  } satisfies OAuthQuotaSnapshot
}

describe('quota field provenance', () => {
  test('keeps poll provenance for a missing five-hour header while marking seven-day as headers', () => {
    const existing = pollWindows()
    const incoming = normalizeQuotaHeaders(
      new Headers({
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
      }),
      1_700_000_000_000,
    )

    const merged = mergeHeaderQuotaSnapshot(existing, incoming)

    expect(merged).toMatchObject({
      five_hour: existing.five_hour,
      seven_day: {
        usedPercent: 40,
        checkedAt: 1_700_000_000_000,
      },
      fieldSources: {
        five_hour: 'poll',
        seven_day: 'headers',
      },
    })
  })

  test('marks both windows as header-derived when both headers are supplied', () => {
    const merged = mergeHeaderQuotaSnapshot(
      undefined,
      normalizeQuotaHeaders(BOTH_WINDOW_HEADERS, 1_700_000_000_000),
    )

    expect(merged).toMatchObject({
      fieldSources: {
        five_hour: 'headers',
        seven_day: 'headers',
      },
    })
  })

  test('retains poll provenance for windows when the header harvest supplies neither', () => {
    const existing = pollWindows()

    const merged = mergeHeaderQuotaSnapshot(
      existing,
      normalizeQuotaHeaders(new Headers(), 1_700_000_000_000),
    )

    expect(merged).toMatchObject({
      fieldSources: {
        five_hour: 'poll',
        seven_day: 'poll',
      },
    })
  })

  test('keeps scoped and extra usage poll-owned across a header harvest', () => {
    const existing = {
      scoped: [
        {
          id: 'scope-1',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 55,
          remainingPercent: 45,
          checkedAt: 1_699_999_000_000,
        },
      ],
      extraUsage: {
        used: { amountMinor: 25, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 100, currency: 'USD', exponent: 2 },
        exhausted: false,
      },
      source: 'poll',
      checkedAt: 1_699_999_000_000,
    } satisfies OAuthQuotaSnapshot

    const merged = mergeHeaderQuotaSnapshot(
      existing,
      normalizeQuotaHeaders(BOTH_WINDOW_HEADERS, 1_700_000_000_000),
    )

    expect(merged).toMatchObject({
      fieldSources: {
        scoped: 'poll',
        extraUsage: 'poll',
      },
    })
  })

  test('preserves a poll-origin binding window over an incoming header claim', () => {
    const existing = {
      bindingWindow: 'claude-weekly-scoped-fable',
      bindingWindowSource: 'poll',
      source: 'poll',
      checkedAt: 1_699_999_000_000,
    } satisfies OAuthQuotaSnapshot

    const merged = mergeHeaderQuotaSnapshot(
      existing,
      normalizeQuotaHeaders(
        new Headers({
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        }),
        1_700_000_000_000,
      ),
    )

    expect(merged).toMatchObject({
      bindingWindow: 'claude-weekly-scoped-fable',
      bindingWindowSource: 'poll',
      fieldSources: { bindingWindow: 'poll' },
    })
  })

  test('marks fallback advice as header-derived only when its header is present', () => {
    const available = normalizeQuotaHeaders(
      new Headers({
        'anthropic-ratelimit-unified-fallback': 'available',
      }),
      1_700_000_000_000,
    )
    const unavailable = normalizeQuotaHeaders(
      new Headers({
        'anthropic-ratelimit-unified-fallback': 'not-available',
      }),
      1_700_000_000_000,
    )
    const absent = normalizeQuotaHeaders(new Headers(), 1_700_000_000_000)
    const existing = {
      fallbackAdvised: true,
      fieldSources: { fallbackAdvised: 'poll' },
      source: 'poll',
      checkedAt: 1_699_999_000_000,
    } satisfies OAuthQuotaSnapshot

    expect(available).toMatchObject({
      fallbackAdvised: true,
      fieldSources: { fallbackAdvised: 'headers' },
    })
    expect(unavailable).toMatchObject({
      fallbackAdvised: false,
      fieldSources: { fallbackAdvised: 'headers' },
    })
    expect(absent.fieldSources).not.toHaveProperty('fallbackAdvised')
    expect(
      mergeHeaderQuotaSnapshot(absent, normalizeQuotaHeaders(new Headers())),
    ).not.toMatchObject({
      fieldSources: { fallbackAdvised: expect.anything() },
    })
    expect(
      mergeHeaderQuotaSnapshot(
        existing,
        normalizeQuotaHeaders(new Headers(), 1_700_000_000_000),
      ),
    ).toMatchObject({
      fallbackAdvised: true,
      fieldSources: { fallbackAdvised: 'poll' },
    })
  })

  test('keeps poll fallback advice across a partial persistence harvest', () => {
    const existing = {
      fallbackAdvised: true,
      fieldSources: { fallbackAdvised: 'poll' },
      source: 'poll',
      checkedAt: 1_699_999_000_000,
    } satisfies OAuthQuotaSnapshot
    const incoming = normalizeQuotaHeaders(
      new Headers({
        'anthropic-ratelimit-unified-7d-utilization': '0.4',
      }),
      1_700_000_000_000,
    )

    const merged = mergeHeaderQuotaForPersistence(existing, incoming)

    expect(merged).toMatchObject({
      fallbackAdvised: true,
      fieldSources: {
        fallbackAdvised: 'poll',
        seven_day: 'headers',
      },
    })

    const withoutExistingAdvice = mergeHeaderQuotaForPersistence(
      {
        seven_day: {
          usedPercent: 20,
          remainingPercent: 80,
          checkedAt: 1_699_999_000_000,
        },
        fieldSources: { seven_day: 'poll' },
        source: 'poll',
        checkedAt: 1_699_999_000_000,
      },
      incoming,
    )
    expect(withoutExistingAdvice.fallbackAdvised).toBe(false)
    expect(withoutExistingAdvice.fieldSources).not.toHaveProperty(
      'fallbackAdvised',
    )
  })

  test('preserves the quota-window complement invariant across header and poll producers', async () => {
    const percentages = Array.from({ length: 1001 }, (_, index) => index / 10)
    const boundaryPercentages = [0.5, 1.5, 2.5]
    const samples = [...percentages, ...boundaryPercentages]

    for (const usedPercent of samples) {
      const headerUtilization = usedPercent / 100
      const headers = normalizeQuotaHeaders(
        new Headers({
          'anthropic-ratelimit-unified-5h-utilization':
            String(headerUtilization),
          'anthropic-ratelimit-unified-7d-utilization':
            String(headerUtilization),
        }),
      )
      expect(
        headers.five_hour!.usedPercent + headers.five_hour!.remainingPercent,
      ).toBe(100)
      expect(
        headers.seven_day!.usedPercent + headers.seven_day!.remainingPercent,
      ).toBe(100)

      const poll = await fetchOAuthQuotaSnapshot({
        accessToken: 'test-token',
        now: () => 1_700_000_000_000,
        fetchImpl: (async () =>
          Response.json({
            five_hour: { utilization: usedPercent },
            seven_day: { utilization: usedPercent },
            limits: [
              {
                kind: 'weekly_scoped',
                group: 'weekly',
                percent: usedPercent,
                scope: { model: { id: 'fable', display_name: 'Fable' } },
              },
            ],
          })) as unknown as typeof fetch,
      })
      expect(
        poll.five_hour!.usedPercent + poll.five_hour!.remainingPercent,
      ).toBe(100)
      expect(
        poll.seven_day!.usedPercent + poll.seven_day!.remainingPercent,
      ).toBe(100)
      expect(poll.five_hour!.usedPercent).toBe(usedPercent)
      expect(poll.seven_day!.usedPercent).toBe(usedPercent)
      expect(headers.five_hour!.usedPercent).toBe(
        Math.round(headerUtilization * 100),
      )
      expect(headers.seven_day!.usedPercent).toBe(
        Math.round(headerUtilization * 100),
      )
      if (Number.isInteger(usedPercent)) {
        expect(headers.five_hour!.usedPercent).toBe(poll.five_hour!.usedPercent)
        expect(headers.seven_day!.usedPercent).toBe(poll.seven_day!.usedPercent)
      }
      expect(
        poll.scoped![0]!.usedPercent + poll.scoped![0]!.remainingPercent,
      ).toBe(100)
    }
  })
})
