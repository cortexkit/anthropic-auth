import { describe, expect, test } from 'bun:test'
import type { OAuthQuotaSnapshot } from '../../../core/src/accounts.ts'
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
})
