import { describe, expect, test } from 'bun:test'
import type { PrimeAccountStatus } from '@cortexkit/anthropic-auth-core'
import {
  buildAccountDialogOption,
  buildKillswitchThresholdSeed,
  buildPrimeStatusRows,
  handlePrimeStatusOption,
  PRIME_DIALOG_OPTIONS,
} from '../tui/command-dialogs'

describe('buildKillswitchThresholdSeed', () => {
  test('preserves scoped killswitch thresholds in the TUI edit seed', () => {
    expect(
      buildKillswitchThresholdSeed(
        {
          main: { five_hour: 5, seven_day: 10, scoped: 20 },
          accounts: {
            umut: { five_hour: 3, seven_day: 8, scoped: 0 },
          },
        },
        ['umut'],
      ),
    ).toBe('main:5,10,20 umut:3,8,0')
  })

  test('falls back to main thresholds and scoped default for accounts without overrides', () => {
    expect(
      buildKillswitchThresholdSeed({ main: { five_hour: 5, seven_day: 10 } }, [
        'umut',
      ]),
    ).toBe('main:5,10,0 umut:5,10,0')
  })
})

describe('buildAccountDialogOption', () => {
  test('threads the tier label into the account row detail', () => {
    expect(
      buildAccountDialogOption({
        id: 'work',
        label: 'Work',
        role: 'fallback',
        enabled: true,
        quotaPercent: 22,
        tierLabel: 'Team · Max 5x',
      }),
    ).toEqual({
      title: 'Work [fallback] 22%',
      value: 'work',
      description: 'Team · Max 5x',
    })
  })
})

describe('buildPrimeStatusRows', () => {
  const base = {
    id: 'main',
    label: 'main',
    nextDueAt: undefined,
  } as PrimeAccountStatus

  test('renders future-due, successful prime, and active-window rows', () => {
    const futureDue = Date.now() + 60 * 60_000
    const past = Date.now() - 60_000
    const rows = buildPrimeStatusRows([
      { ...base, id: 'main', nextDueAt: futureDue },
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: undefined,
        lastPrimedAt: past,
        lastResult: 'ok',
        usage: { count: 12, inputTokens: 240, outputTokens: 12, since: 1 },
        estimatedCostUsd: 0.00132,
      },
      {
        id: 'expired',
        label: 'expired',
        // active window: a past nextDueAt means the reset has happened but
        // the window already started; no row says "primed" and no future
        // prime is due.
        nextDueAt: past,
      },
    ])
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows[0]).toContain('main · next prime')
    expect(rows.find((r) => r.includes('work-alt · primed'))).toBeDefined()
    expect(rows.find((r) => r.includes('12 primes'))).toBeDefined()
    expect(rows.find((r) => r.includes('— window active'))).toBeDefined()
  })

  test('error row uses "primed HH:MM err" notation', () => {
    const rows = buildPrimeStatusRows([
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: undefined,
        lastPrimedAt: Date.now() - 60_000,
        lastResult: 'error',
      },
    ])
    expect(rows[0]).toContain('primed')
    expect(rows[0]).toContain('err')
  })
})

describe('openCommandDialog — claude-prime modal interaction (M6)', () => {
  test('main view exposes 4 options in spec order: Enable / Disable / Status / Back', () => {
    expect(PRIME_DIALOG_OPTIONS).toEqual([
      { title: 'Enable', value: 'on' },
      { title: 'Disable', value: 'off' },
      { title: 'Status', value: 'status' },
      { title: 'Back', value: 'back' },
    ])
  })

  test('Status view has a working Back action that returns to the main view', () => {
    let returned = false
    handlePrimeStatusOption({ value: 'back' }, () => {
      returned = true
    })
    expect(returned).toBe(true)
  })
})
