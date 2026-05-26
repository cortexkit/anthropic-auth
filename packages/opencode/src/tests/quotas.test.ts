import { describe, expect, test } from 'bun:test'
import type { AccountStorage } from '@marcusrbrown/anthropic-auth-core'
import {
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
} from '@marcusrbrown/anthropic-auth-core'

describe('quota summaries', () => {
  test('formats main and fallback quota windows', () => {
    const now = Date.parse('2026-04-28T12:00:00.000Z')
    const summary = buildClaudeQuotaSummary({
      now,
      refreshedAt: now,
      accounts: [
        {
          name: 'OpenCode anthropic',
          role: 'main',
          lastRefreshedAt: now - 2 * 60_000,
          quota: {
            five_hour: {
              usedPercent: 25,
              remainingPercent: 75,
              resetsAt: '2026-04-28T13:15:00.000Z',
              checkedAt: now,
            },
            seven_day: {
              usedPercent: 50,
              remainingPercent: 50,
              checkedAt: now - 60_000,
            },
          },
        },
      ],
    })

    expect(summary).toContain('## Claude Quotas')
    expect(summary).toContain('### OpenCode anthropic (main)')
    expect(summary).toContain('Last token refresh: 2m ago')
    expect(summary).toContain(
      '5h: 75% remaining (25% used, resets in 1h 15m, checked just now)',
    )
    expect(summary).toContain('1w: 50% remaining (50% used, checked 1m ago)')
  })

  test('formats reset timestamps as relative durations', () => {
    const now = Date.parse('2026-04-28T12:00:00.000Z')
    const summary = buildClaudeQuotaSummary({
      now,
      accounts: [
        {
          name: 'main',
          role: 'main',
          quota: {
            five_hour: {
              usedPercent: 0,
              remainingPercent: 100,
              resetsAt: '2026-04-28T12:09:05.000Z',
              checkedAt: now,
            },
            seven_day: {
              usedPercent: 0,
              remainingPercent: 100,
              resetsAt: 'not-a-date',
              checkedAt: now,
            },
          },
        },
      ],
    })

    expect(summary).toContain('5h: 100% remaining (0% used, resets in 10m')
    expect(summary).toContain('1w: 100% remaining (0% used, resets not-a-date')
  })

  test('builds fallback summaries from sidecar storage', () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [
        {
          id: 'fallback-1',
          label: 'personal',
          type: 'oauth',
          refresh: 'refresh',
          enabled: false,
          lastRefreshedAt: 2,
          quota: {
            five_hour: {
              usedPercent: 90,
              remainingPercent: 10,
              checkedAt: 1,
            },
          },
        },
      ],
    }

    expect(buildFallbackQuotaSummaries(storage)).toEqual([
      {
        name: 'personal',
        role: 'fallback',
        enabled: false,
        quota: storage.accounts[0]?.quota,
        lastRefreshedAt: 2,
      },
    ])
  })

  test('includes fallback quota refresh errors when available', () => {
    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [
        {
          id: 'fallback-1',
          label: 'personal',
          type: 'oauth',
          refresh: 'refresh',
        },
      ],
    }

    expect(
      buildFallbackQuotaSummaries(
        storage,
        new Map([['fallback-1', 'Fallback token refresh failed: 400']]),
      ),
    ).toEqual([
      {
        name: 'personal',
        role: 'fallback',
        enabled: true,
        quota: undefined,
        lastRefreshedAt: undefined,
        error: 'Fallback token refresh failed: 400',
      },
    ])
  })
})
