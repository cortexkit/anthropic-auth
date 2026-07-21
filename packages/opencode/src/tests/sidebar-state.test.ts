import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __acquireSidebarStateLockForTest,
  __setSidebarStateWriteTestHooks,
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  FIVE_HOUR_MS,
  formatFallbackModelLabel,
  formatPrimeAccountValue,
  formatPrimeCost,
  formatPrimeTime,
  getCollapsedQuotaSummary,
  getFableRecoverySummary,
  getSidebarState,
  normalizeSidebarState,
  resolveActiveAccount,
  SEVEN_DAY_MS,
  type SidebarState,
  setSidebarState,
} from '../sidebar-state'

function sidebarTestPath(name: string): string {
  return join(
    tmpdir(),
    `opencode-auth-sidebar-${name}-${process.pid}-${randomUUID()}`,
    'sidebar-state.json',
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const quota = (used: number): AccountQuota => ({
  five_hour: { usedPercent: used, remainingPercent: 100 - used },
  seven_day: { usedPercent: used, remainingPercent: 100 - used },
})

describe('prime display formatters', () => {
  test('formats time and cost consistently for sidebar and dialog consumers', () => {
    expect(formatPrimeTime(0)).toBe(
      new Date(0).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    )
    expect(formatPrimeCost(0)).toBe('0')
    expect(formatPrimeCost(0.000025)).toBe('2.50e-5')
    expect(formatPrimeCost(0.125)).toBe('0.1250')
  })

  test('formats one sidebar value per prime account', () => {
    const nextDueAt = Date.now() + 60 * 60_000
    const lastPrimedAt = Date.now() - 60_000

    expect(
      formatPrimeAccountValue({
        id: 'main',
        label: 'main',
        nextDueAt,
      }),
    ).toEqual({ text: formatPrimeTime(nextDueAt), hasError: false })
    expect(
      formatPrimeAccountValue({
        id: 'work-alt',
        label: 'work-alt',
        lastPrimedAt,
        lastResult: 'ok',
        usage: { count: 3, inputTokens: 60, outputTokens: 3, since: 1 },
        estimatedCostUsd: 0.000075,
      }),
    ).toEqual({
      text: `primed ${formatPrimeTime(lastPrimedAt)} \u2713`,
      hasError: false,
    })
    expect(
      formatPrimeAccountValue({
        id: 'work-alt',
        label: 'work-alt',
        usage: { count: 3, inputTokens: 60, outputTokens: 3, since: 1 },
        estimatedCostUsd: 0.000075,
      }),
    ).toEqual({ text: '\u2713 3 \u2248 $7.50e-5', hasError: false })
    expect(
      formatPrimeAccountValue({
        id: 'broken',
        label: 'broken',
        lastResult: 'error',
      }),
    ).toEqual({ text: 'err', hasError: true })
    expect(formatPrimeAccountValue({ id: 'idle', label: 'idle' })).toEqual({
      text: '\u2014',
      hasError: false,
    })
  })
})

function make(overrides: Partial<SidebarState>): SidebarState {
  return { ...DEFAULT_SIDEBAR_STATE, ...overrides }
}

describe('resolveActiveAccount', () => {
  test('activeId "main" resolves to the main account', () => {
    const state = make({ activeId: 'main', main: { quota: quota(20) } })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.name).toBe('main')
    expect(active.quota?.five_hour?.usedPercent).toBe(20)
  })

  test('activeId matching an enabled fallback resolves to that fallback (label name)', () => {
    const state = make({
      activeId: 'fb1',
      fallbacks: [
        {
          id: 'fb1',
          label: 'work',
          quota: quota(40),
          enabled: true,
          needsReauth: false,
        },
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('fb1')
    expect(active.name).toBe('work')
    expect(active.quota?.five_hour?.usedPercent).toBe(40)
  })

  test('fallback without a label uses its id as the name', () => {
    const state = make({
      activeId: 'fb1',
      fallbacks: [
        {
          id: 'fb1',
          label: undefined,
          quota: quota(5),
          enabled: true,
          needsReauth: false,
        },
      ],
    })
    expect(resolveActiveAccount(state).name).toBe('fb1')
  })

  test('activeId matching a DISABLED fallback falls back to main', () => {
    const state = make({
      activeId: 'fb1',
      main: { quota: quota(12) },
      fallbacks: [
        {
          id: 'fb1',
          label: 'work',
          quota: quota(40),
          enabled: false,
          needsReauth: false,
        },
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota?.five_hour?.usedPercent).toBe(12)
  })

  test('undefined activeId resolves to main', () => {
    const state = make({ activeId: undefined, main: { quota: quota(7) } })
    expect(resolveActiveAccount(state).id).toBe('main')
  })

  test('unmatched activeId resolves to main', () => {
    const state = make({
      activeId: 'ghost',
      main: { quota: null },
      fallbacks: [
        {
          id: 'fb1',
          label: 'work',
          quota: quota(40),
          enabled: true,
          needsReauth: false,
        },
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota).toBeNull()
  })

  test('does not throw on partial main with undefined quota', () => {
    const state = { main: {} } as unknown as SidebarState
    expect(() => resolveActiveAccount(state)).not.toThrow()
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota).toBeNull()
  })

  test('does not throw when fallbacks is undefined', () => {
    const state = {
      main: { quota: null },
      fallbacks: undefined,
    } as unknown as SidebarState
    expect(() => resolveActiveAccount(state)).not.toThrow()
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
  })

  test('does not throw on empty object', () => {
    const state = {} as unknown as SidebarState
    expect(() => resolveActiveAccount(state)).not.toThrow()
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.name).toBe('main')
    expect(active.quota).toBeNull()
  })

  test('does not throw when main is null', () => {
    const state = { main: null, fallbacks: [] } as unknown as SidebarState
    expect(() => resolveActiveAccount(state)).not.toThrow()
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota).toBeNull()
  })
})

describe('getFableRecoverySummary', () => {
  test('shows the Opus recovery countdown only for the matching session', () => {
    const state = make({
      fableRecoveries: [
        {
          sessionId: 'ses_fable',
          mode: 'opus',
          remaining: 7,
          changedAt: 123,
          requestedModelId: 'claude-fable-5',
        },
        {
          sessionId: 'ses_other',
          mode: 'fable',
          remaining: 0,
          changedAt: 124,
          requestedModelId: 'claude-fable-5',
        },
      ],
    })

    expect(getFableRecoverySummary(state, 'ses_fable')).toBe(
      'Opus 4.8 · 7 left',
    )
    expect(getFableRecoverySummary(state, 'ses_other')).toBe(
      'Fable 5 · restored',
    )
    expect(getFableRecoverySummary(state, 'ses_unknown')).toBeUndefined()
  })

  test('shows Anthropic server-side fallback without a turn countdown', () => {
    const state = make({
      fableRecoveries: [
        {
          sessionId: 'ses_fable',
          mode: 'server',
          remaining: 0,
          changedAt: 321,
          requestedModelId: 'claude-fable-5',
          targetModelId: 'claude-opus-5',
        },
        {
          sessionId: 'ses_opus',
          mode: 'server',
          remaining: 0,
          changedAt: 322,
          requestedModelId: 'claude-opus-5',
          targetModelId: 'claude-opus-4-8',
        },
      ],
    })

    expect(getFableRecoverySummary(state, 'ses_fable')).toBe(
      'Fable 5→Opus 5 · safety',
    )
    expect(getFableRecoverySummary(state, 'ses_opus')).toBe(
      'Opus 5→Opus 4.8 · safety',
    )
  })

  test('shows the transition back to Fable', () => {
    const state = make({
      fableRecoveries: [
        {
          sessionId: 'ses_fable',
          mode: 'fable',
          remaining: 0,
          changedAt: 456,
          requestedModelId: 'claude-fable-5',
        },
      ],
    })

    expect(getFableRecoverySummary(state, 'ses_fable')).toBe(
      'Fable 5 · restored',
    )
  })

  test('names the originally-requested model when an Opus 5 session is restored', () => {
    const state = make({
      fableRecoveries: [
        {
          sessionId: 'ses_opus5',
          mode: 'opus',
          remaining: 4,
          changedAt: 100,
          requestedModelId: 'claude-opus-5',
        },
        {
          sessionId: 'ses_opus5_fast',
          mode: 'fable',
          remaining: 0,
          changedAt: 200,
          requestedModelId: 'claude-opus-5-fast',
        },
      ],
    })

    expect(getFableRecoverySummary(state, 'ses_opus5')).toBe(
      'Opus 4.8 · 4 left',
    )
    expect(getFableRecoverySummary(state, 'ses_opus5_fast')).toBe(
      'Opus 5 · restored',
    )
  })

  test('defaults to Fable 5 when an older recovery has no requestedModelId', () => {
    const state = make({
      fableRecoveries: [
        {
          sessionId: 'ses_legacy',
          mode: 'fable',
          remaining: 0,
          changedAt: 1,
        },
      ],
    })

    expect(getFableRecoverySummary(state, 'ses_legacy')).toBe(
      'Fable 5 · restored',
    )
  })
})

describe('formatFallbackModelLabel', () => {
  test('formats Fable 5 ids', () => {
    expect(formatFallbackModelLabel('claude-fable-5')).toBe('Fable 5')
    expect(formatFallbackModelLabel('claude-fable-5-20260608')).toBe('Fable 5')
  })

  test('formats Opus 5 ids', () => {
    expect(formatFallbackModelLabel('claude-opus-5')).toBe('Opus 5')
    expect(formatFallbackModelLabel('claude-opus-5-fast')).toBe('Opus 5')
    expect(formatFallbackModelLabel('claude-opus-5-20260701')).toBe('Opus 5')
  })

  test('formats Opus 4.8 and falls back to raw unknown ids', () => {
    expect(formatFallbackModelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(formatFallbackModelLabel('claude-fable-99')).toBe('claude-fable-99')
  })

  test('defaults to Fable 5 when the id is missing', () => {
    expect(formatFallbackModelLabel(undefined)).toBe('Fable 5')
  })
})

describe('getCollapsedQuotaSummary', () => {
  test('collapsed quota summary ignores credits binding marker and fallback advice', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 78, remainingPercent: 22 },
        seven_day: { usedPercent: 40, remainingPercent: 60 },
        extraUsage: {
          used: { amountMinor: 10035, currency: 'USD', exponent: 2 },
          limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
          exhausted: true,
        },
        bindingWindow: 'five_hour',
        fallbackAdvised: true,
      }).text,
    ).toBe('5h: 78% 7d: 40%')
  })

  test('formats both active-account quota windows', () => {
    expect(getCollapsedQuotaSummary(quota(13)).text).toBe('5h: 13% 7d: 13%')
  })

  test('formats different 5h and 7d percentages', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 13.4, remainingPercent: 86.6 },
        seven_day: { usedPercent: 7.2, remainingPercent: 92.8 },
      }).text,
    ).toBe('5h: 13% 7d: 7%')
  })

  test('uses a dash for a missing collapsed quota window', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 13, remainingPercent: 87 },
      }).text,
    ).toBe('5h: 13% 7d: —')
  })

  test('formats scoped model quota windows in collapsed quota text', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 13, remainingPercent: 87 },
        seven_day: { usedPercent: 7, remainingPercent: 93 },
        scoped: [
          {
            id: 'claude-weekly-scoped-fable',
            title: 'Fable only',
            modelName: 'Fable',
            usedPercent: 42,
            remainingPercent: 58,
          },
        ],
      }).text,
    ).toBe('5h: 13% 7d: 7% Fa: 42%')
  })

  test('returns no collapsed quota text when no windows are available', () => {
    expect(getCollapsedQuotaSummary(null).text).toBeNull()
    expect(getCollapsedQuotaSummary({}).text).toBeNull()
  })

  test('omits 5h/7d placeholders when only scoped windows are visible', () => {
    const summary = getCollapsedQuotaSummary({
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100,
          remainingPercent: 0,
        },
      ],
    })
    expect(summary.text).toBe('Fa: 100%')
    expect(summary.text).not.toContain('5h:')
    expect(summary.text).not.toContain('7d:')
    expect(summary.text).not.toContain('—')
  })

  test('preserves partial-dash primary segment alongside scoped windows', () => {
    const summary = getCollapsedQuotaSummary({
      five_hour: { usedPercent: 23, remainingPercent: 77 },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 42,
          remainingPercent: 58,
        },
      ],
    })
    expect(summary.text).toBe('5h: 23% 7d: — Fa: 42%')
  })
})

describe('normalizeSidebarState', () => {
  test('normalizes valid optional quota metadata and tier labels', () => {
    const normalized = normalizeSidebarState({
      main: {
        tierLabel: 'Max 20x',
        quota: {
          extraUsage: {
            used: { amountMinor: 10035, currency: 'USD', exponent: 2 },
            limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
            severity: 'critical',
            exhausted: true,
          },
          bindingWindow: 'five_hour',
          fallbackAdvised: true,
        },
      },
      fallbacks: [
        {
          id: 'work',
          tierLabel: 'Team · Max 5x',
          quota: null,
          enabled: true,
          needsReauth: false,
        },
      ],
    })

    expect(normalized.main.tierLabel).toBe('Max 20x')
    expect(normalized.main.quota?.extraUsage?.used.amountMinor).toBe(10035)
    expect(normalized.main.quota?.bindingWindow).toBe('five_hour')
    expect(normalized.main.quota?.fallbackAdvised).toBe(true)
    expect(normalized.fallbacks[0]?.tierLabel).toBe('Team · Max 5x')
  })

  test('drops malformed extraUsage bindingWindow fallbackAdvised and tierLabel independently', () => {
    const normalized = normalizeSidebarState({
      main: {
        tierLabel: 42,
        quota: {
          five_hour: { usedPercent: 78, remainingPercent: 22 },
          extraUsage: {
            used: { amountMinor: 1.5, currency: '', exponent: 2 },
            limit: { amountMinor: 100, currency: 'USD', exponent: 2 },
            exhausted: 'yes',
          },
          bindingWindow: 42,
          fallbackAdvised: 'yes',
        },
      },
      fallbacks: [],
    })

    expect(normalized.main.quota?.five_hour?.usedPercent).toBe(78)
    expect(normalized.main.quota?.extraUsage).toBeUndefined()
    expect(normalized.main.quota?.bindingWindow).toBeUndefined()
    expect(normalized.main.quota?.fallbackAdvised).toBeUndefined()
    expect(normalized.main.tierLabel).toBeUndefined()
  })

  test('drops invalid money metadata while preserving valid quota windows', () => {
    const normalized = normalizeSidebarState({
      main: {
        quota: {
          five_hour: { usedPercent: 78, remainingPercent: 22 },
          seven_day: { usedPercent: 40, remainingPercent: 60 },
          extraUsage: {
            used: { amountMinor: 10035, currency: 'ZZZZ', exponent: 50 },
            limit: { amountMinor: 10000, currency: 'ZZZZ', exponent: 50 },
            exhausted: false,
          },
        },
      },
      fallbacks: [],
    })

    expect(normalized.main.quota?.five_hour?.usedPercent).toBe(78)
    expect(normalized.main.quota?.seven_day?.usedPercent).toBe(40)
    expect(normalized.main.quota?.extraUsage).toBeUndefined()
  })

  test('preserves empty scoped array with optional metadata present', () => {
    const normalized = normalizeSidebarState({
      main: {
        quota: {
          scoped: [],
          bindingWindow: 'five_hour',
          fallbackAdvised: false,
        },
      },
      fallbacks: [],
    })

    expect(normalized.main.quota?.scoped).toEqual([])
    expect(normalized.main.quota?.bindingWindow).toBe('five_hour')
    expect(normalized.main.quota?.fallbackAdvised).toBe(false)
  })

  test('preserves valid scoped quota windows and drops malformed ones', () => {
    const normalized = normalizeSidebarState({
      main: {
        quota: {
          scoped: [
            {
              id: 'claude-weekly-scoped-fable',
              title: 'Fable only',
              modelId: 'claude-fable-5',
              modelName: 'Fable',
              usedPercent: 5,
              remainingPercent: 95,
              resetsAt: '2026-07-08T09:00:00Z',
            },
            { id: 'broken', title: 'Broken only', usedPercent: Number.NaN },
          ],
        },
      },
      fallbacks: [],
      route: 'main',
      lastUpdated: 0,
    })

    expect(normalized.main.quota?.scoped).toEqual([
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelId: 'claude-fable-5',
        modelName: 'Fable',
        usedPercent: 5,
        remainingPercent: 95,
        resetsAt: '2026-07-08T09:00:00Z',
      },
    ])
  })

  test('normalizes valid Fable recovery state and rejects malformed state', () => {
    const valid = normalizeSidebarState({
      fableRecoveries: [
        {
          sessionId: 'ses_fable',
          mode: 'opus',
          remaining: 7.8,
          changedAt: 123,
        },
      ],
    })
    expect(valid.fableRecoveries).toEqual([
      {
        sessionId: 'ses_fable',
        mode: 'opus',
        remaining: 7,
        changedAt: 123,
      },
    ])

    const invalid = normalizeSidebarState({
      fableRecoveries: [
        {
          sessionId: 'ses_fable',
          mode: 'other',
          remaining: 7,
          changedAt: 123,
        },
      ],
    })
    expect(invalid.fableRecoveries).toBeUndefined()
  })

  test('preserves empty scoped quota array when scoped is the only quota key', () => {
    const normalized = normalizeSidebarState({
      main: { quota: { scoped: [] } },
      fallbacks: [],
      route: 'main',
      lastUpdated: 0,
    })

    expect(normalized.main.quota).not.toBeNull()
    expect(normalized.main.quota?.scoped).toEqual([])
  })
})

describe('computeQuotaPacing', () => {
  const now = Date.UTC(2026, 5, 12, 12, 0, 0)

  function fiveHourWindow(elapsedMs: number, usedPercent: number) {
    return {
      window: {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: new Date(now + FIVE_HOUR_MS - elapsedMs).toISOString(),
      },
      elapsedMs,
    }
  }

  test('reserve: under even-burn pace, lasts until reset', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 4, 5)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing).not.toBeNull()
    expect(pacing?.pacePercent).toBeCloseTo(25, 5)
    expect(pacing?.deltaPercent).toBeCloseTo(-20, 5)
    expect(pacing?.state).toBe('reserve')
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('deficit: over pace, projects runout before reset', () => {
    const elapsed = FIVE_HOUR_MS / 4
    const { window } = fiveHourWindow(elapsed, 50)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.pacePercent).toBeCloseTo(25, 5)
    expect(pacing?.deltaPercent).toBeCloseTo(25, 5)
    expect(pacing?.state).toBe('deficit')
    const start = now - elapsed
    expect(pacing?.runsOutAt).toBe(new Date(start + elapsed * 2).toISOString())
  })

  test('screenshot case: 7d window, 12h elapsed, 17% used', () => {
    const elapsed = 12 * 60 * 60 * 1000
    const window = {
      usedPercent: 17,
      remainingPercent: 83,
      resetsAt: new Date(now + SEVEN_DAY_MS - elapsed).toISOString(),
    }
    const pacing = computeQuotaPacing(window, SEVEN_DAY_MS, now)
    expect(pacing?.deltaPercent).toBeCloseTo(17 - (12 / 168) * 100, 5)
    expect(pacing?.state).toBe('deficit')
    expect(pacing?.runsOutAt).not.toBeNull()
    const runsOutMs = new Date(pacing?.runsOutAt as string).getTime() - now
    const expectedMs = (elapsed * 100) / 17 - elapsed
    expect(runsOutMs).toBeCloseTo(expectedMs, -4)
  })

  test('on-pace when |delta| < 1', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 4, 25.5)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('on-pace')
  })

  test('zero usage is reserve and lasts', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 2, 0)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('reserve')
    expect(pacing?.deltaPercent).toBeCloseTo(-50, 5)
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('projection landing exactly at reset means lasts', () => {
    const elapsed = FIVE_HOUR_MS / 2
    const { window } = fiveHourWindow(elapsed, 50)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('on-pace')
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('null when resetsAt missing or invalid', () => {
    expect(
      computeQuotaPacing(
        { usedPercent: 10, remainingPercent: 90 },
        FIVE_HOUR_MS,
        now,
      ),
    ).toBeNull()
    expect(
      computeQuotaPacing(
        { usedPercent: 10, remainingPercent: 90, resetsAt: 'garbage' },
        FIVE_HOUR_MS,
        now,
      ),
    ).toBeNull()
  })

  test('null in the early-window noise guard', () => {
    const fourMinutes = 4 * 60 * 1000
    const { window } = fiveHourWindow(fourMinutes, 3)
    expect(computeQuotaPacing(window, FIVE_HOUR_MS, now)).toBeNull()
    const oneHour = 60 * 60 * 1000
    const sevenDay = {
      usedPercent: 3,
      remainingPercent: 97,
      resetsAt: new Date(now + SEVEN_DAY_MS - oneHour).toISOString(),
    }
    expect(computeQuotaPacing(sevenDay, SEVEN_DAY_MS, now)).toBeNull()
  })

  test('null when elapsed reaches or exceeds the window', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS, 80)
    expect(computeQuotaPacing(window, FIVE_HOUR_MS, now)).toBeNull()
    const past = {
      usedPercent: 80,
      remainingPercent: 20,
      resetsAt: new Date(now - 1000).toISOString(),
    }
    expect(computeQuotaPacing(past, FIVE_HOUR_MS, now)).toBeNull()
  })
})

function isValidSidebarState(s: unknown): s is SidebarState {
  if (!s || typeof s !== 'object') return false
  const st = s as Record<string, unknown>
  return (
    typeof st.route === 'string' &&
    st.main !== null &&
    typeof st.main === 'object' &&
    'quota' in (st.main as Record<string, unknown>) &&
    Array.isArray(st.fallbacks) &&
    typeof st.lastUpdated === 'number' &&
    typeof st.fastMode === 'boolean'
  )
}

describe('normalizeSidebarState', () => {
  test('returns DEFAULT for null', () => {
    const out = normalizeSidebarState(null)
    expect(out).toEqual(DEFAULT_SIDEBAR_STATE)
    expect(out.main.quota).toBeNull()
    expect(out.fallbacks).toEqual([])
  })

  test('returns DEFAULT for a non-object (number)', () => {
    const out = normalizeSidebarState(42)
    expect(out).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  test('returns DEFAULT for an array', () => {
    const out = normalizeSidebarState([])
    expect(out).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  test('returns DEFAULT for undefined', () => {
    const out = normalizeSidebarState(undefined)
    expect(out).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  test('fills defaults for an empty object', () => {
    const out = normalizeSidebarState({})
    expect(isValidSidebarState(out)).toBe(true)
    expect(out.main).toEqual({ quota: null })
    expect(out.fallbacks).toEqual([])
    expect(out.route).toBe(DEFAULT_SIDEBAR_STATE.route)
    expect(out.lastUpdated).toBe(0)
    expect(out.fastMode).toBe(false)
    expect(out.relay).toBeNull()
    expect(out.cacheKeep).toBeUndefined()
  })

  test('fills defaults for a sentinel-only object', () => {
    const out = normalizeSidebarState({ SENTINEL: true })
    expect(isValidSidebarState(out)).toBe(true)
    expect(out.main).toEqual({ quota: null })
    expect(out.fallbacks).toEqual([])
  })

  test('empty main object gets quota:null', () => {
    const out = normalizeSidebarState({ main: {} })
    expect(out.main).toEqual({ quota: null })
  })

  test('main: null is replaced with {quota:null}', () => {
    const out = normalizeSidebarState({ main: null })
    expect(out.main).toEqual({ quota: null })
  })

  test('main: non-object is replaced with {quota:null}', () => {
    const out = normalizeSidebarState({ main: 42 })
    expect(out.main).toEqual({ quota: null })
  })

  test('fallbacks: string is replaced with []', () => {
    const out = normalizeSidebarState({ fallbacks: 'x' })
    expect(out.fallbacks).toEqual([])
  })

  test('fallbacks: null is replaced with []', () => {
    const out = normalizeSidebarState({ main: null, fallbacks: null })
    expect(out.fallbacks).toEqual([])
  })

  test('fallbacks: filters out entries missing id', () => {
    const out = normalizeSidebarState({
      fallbacks: [
        { label: 'no-id', quota: null, enabled: true },
        { id: 'ok', label: 'ok', quota: null, enabled: true },
        null,
        'string',
        42,
      ],
    })
    expect(out.fallbacks).toHaveLength(1)
    expect(out.fallbacks[0]!.id).toBe('ok')
  })

  test('fallbacks: quota defaults to null when missing', () => {
    const out = normalizeSidebarState({
      fallbacks: [{ id: 'a', label: 'a', enabled: true }],
    })
    expect(out.fallbacks[0]!.quota).toBeNull()
  })

  test('fallbacks: quota defaults to null when non-object', () => {
    const out = normalizeSidebarState({
      fallbacks: [{ id: 'a', label: 'a', quota: 'bad', enabled: true }],
    })
    expect(out.fallbacks[0]!.quota).toBeNull()
  })

  test('fallbacks: enabled defaults to false when non-boolean', () => {
    const out = normalizeSidebarState({
      fallbacks: [{ id: 'a', label: 'a', enabled: 'yes' }],
    })
    expect(out.fallbacks[0]!.enabled).toBe(false)
  })

  test('fallbacks: needsReauth defaults to false when missing', () => {
    const out = normalizeSidebarState({
      fallbacks: [{ id: 'a', label: 'a', enabled: true }],
    })
    expect(out.fallbacks[0]!.needsReauth).toBe(false)
  })

  test('fallbacks: needsReauth is parsed when present', () => {
    const out = normalizeSidebarState({
      fallbacks: [{ id: 'a', label: 'a', enabled: true, needsReauth: true }],
    })
    expect(out.fallbacks[0]!.needsReauth).toBe(true)
  })

  test('fallbacks: needsReauth defaults to false when non-boolean', () => {
    const out = normalizeSidebarState({
      fallbacks: [{ id: 'a', label: 'a', enabled: true, needsReauth: 'yes' }],
    })
    expect(out.fallbacks[0]!.needsReauth).toBe(false)
  })

  test('relay defaults to null when missing transport', () => {
    const out = normalizeSidebarState({ relay: { enabled: true } })
    expect(out.relay).toBeNull()
  })

  test('relay defaults to null when non-object', () => {
    const out = normalizeSidebarState({ relay: 'bad' })
    expect(out.relay).toBeNull()
  })

  test('cacheKeep defaults to undefined when missing enabled', () => {
    const out = normalizeSidebarState({ cacheKeep: { window: '1h' } })
    expect(out.cacheKeep).toBeUndefined()
  })

  test('cacheKeep defaults to undefined when non-object', () => {
    const out = normalizeSidebarState({ cacheKeep: 'bad' })
    expect(out.cacheKeep).toBeUndefined()
  })

  test('prime defaults to undefined when non-object', () => {
    const out = normalizeSidebarState({ prime: 'bad' })
    expect(out.prime).toBeUndefined()
  })

  test('prime defaults to undefined when enabled is non-boolean', () => {
    const out = normalizeSidebarState({ prime: { enabled: 'yes' } })
    expect(out.prime).toBeUndefined()
  })

  test('prime drops accounts with non-string id', () => {
    const out = normalizeSidebarState({
      prime: {
        enabled: true,
        accounts: [
          { id: 'main' }, // no label → dropped
          { id: 123, label: 'numeric' },
          { id: 'work', label: 'work' },
        ],
      },
    })
    expect(out.prime?.accounts).toEqual([{ id: 'work', label: 'work' }])
  })

  test('prime drops account with non-finite nextDueAt and preserves null', () => {
    const out = normalizeSidebarState({
      prime: {
        enabled: true,
        accounts: [
          { id: 'main', label: 'main', nextDueAt: 'soon' },
          { id: 'work', label: 'work', nextDueAt: null },
        ],
      },
    })
    expect(out.prime?.accounts?.[0]?.nextDueAt).toBeUndefined()
    expect(out.prime?.accounts?.[1]?.nextDueAt).toBeNull()
  })

  test('prime drops invalid lastPrimedAt / lastResult / usage / cost', () => {
    const out = normalizeSidebarState({
      prime: {
        enabled: true,
        accounts: [
          {
            id: 'main',
            label: 'main',
            lastPrimedAt: 'never',
            lastResult: 'unknown',
            usage: { count: -1, inputTokens: 0, outputTokens: 0, since: -5 },
            estimatedCostUsd: 'cheap',
          },
        ],
      },
    })
    const acct = out.prime?.accounts?.[0]
    expect(acct?.lastPrimedAt).toBeUndefined()
    expect(acct?.lastResult).toBeUndefined()
    expect(acct?.usage).toBeUndefined()
    expect(acct?.estimatedCostUsd).toBeUndefined()
  })

  test('route defaults when non-string', () => {
    const out = normalizeSidebarState({ route: 42 })
    expect(out.route).toBe(DEFAULT_SIDEBAR_STATE.route)
  })

  test('fastMode defaults when non-boolean', () => {
    const out = normalizeSidebarState({ fastMode: 'yes' })
    expect(out.fastMode).toBe(false)
  })

  test('lastUpdated defaults when non-number', () => {
    const out = normalizeSidebarState({ lastUpdated: 'now' })
    expect(out.lastUpdated).toBe(0)
  })

  test('never throws for any malformed input', () => {
    const malformed = [
      null,
      undefined,
      42,
      [],
      {},
      { SENTINEL: true },
      { main: {} },
      { main: null, fallbacks: null },
      { fallbacks: 'x' },
      { main: { quota: 'bad' }, fallbacks: [{}], relay: {} },
    ]
    for (const input of malformed) {
      expect(() => normalizeSidebarState(input)).not.toThrow()
      const out = normalizeSidebarState(input)
      expect(isValidSidebarState(out)).toBe(true)
    }
  })

  test('valid state round-trips unchanged (idempotent)', () => {
    const valid: SidebarState = {
      main: {
        quota: {
          five_hour: {
            usedPercent: 13,
            remainingPercent: 87,
            resetsAt: '2026-01-01T00:00:00Z',
          },
          seven_day: { usedPercent: 7, remainingPercent: 93 },
        },
        quotaBackedOff: false,
        quotaBackoffUntil: 1719000000000,
        refreshBackedOff: true,
        refreshBackoffUntil: 1719100000000,
      },
      fallbacks: [
        {
          id: 'fb1',
          label: 'work',
          quota: {
            five_hour: { usedPercent: 40, remainingPercent: 60 },
          },
          enabled: true,
          needsReauth: false,
        },
      ],
      activeId: 'fb1',
      route: 'fallback',
      relay: { enabled: true, transport: 'stdio' },
      fastMode: true,
      cacheKeep: {
        enabled: true,
        window: '1h',
        trackedSessions: 5,
      },
      lastUpdated: 1719000000000,
    }
    const out = normalizeSidebarState(valid)
    expect(out).toEqual(valid)
    // Idempotent: normalizing again yields the same result
    expect(normalizeSidebarState(out)).toEqual(out)
  })
})

describe('getSidebarState malformed file round-trip', () => {
  const testDir = join(tmpdir(), 'opencode-auth-sidebar-test')
  const testFile = join(testDir, 'sidebar-state.json')
  const prevEnv = process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE

  afterAll(async () => {
    if (prevEnv) {
      process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = prevEnv
    } else {
      delete process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE
    }
    await rm(testDir, { recursive: true, force: true })
  })

  test('reads malformed JSON file without throwing', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = testFile
    await mkdir(testDir, { recursive: true })

    // Write a malformed shape to disk — valid JSON, wrong shape
    await writeFile(
      testFile,
      JSON.stringify({ main: null, fallbacks: 'bad', lastUpdated: 'nope' }),
    )
    const state = await getSidebarState()
    expect(state.main).toEqual({ quota: null })
    expect(state.fallbacks).toEqual([])
    expect(state.lastUpdated).toBe(0)
  })

  test('reads unparseable file without throwing', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = testFile
    await mkdir(testDir, { recursive: true })
    await writeFile(testFile, 'not json at all {{{')
    const state = await getSidebarState()
    expect(state).toEqual(DEFAULT_SIDEBAR_STATE)
  })

  test('valid state round-trips through file', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = testFile
    await mkdir(testDir, { recursive: true })
    const valid: SidebarState = {
      main: {
        quota: {
          five_hour: { usedPercent: 13, remainingPercent: 87 },
          seven_day: { usedPercent: 7, remainingPercent: 93 },
        },
        quotaBackedOff: false,
        refreshBackedOff: true,
      },
      fallbacks: [
        {
          id: 'fb1',
          label: 'work',
          quota: null,
          enabled: true,
          needsReauth: false,
        },
      ],
      activeId: 'fb1',
      route: 'fallback',
      relay: { enabled: false, transport: 'sse' },
      fastMode: true,
      lastUpdated: 1719000000000,
    }
    await writeFile(testFile, JSON.stringify(valid))
    const state = await getSidebarState()
    expect(state).toEqual(valid)
  })

  test('non-authoritative writes preserve the latest routing decision', async () => {
    process.env.OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE = testFile
    await mkdir(testDir, { recursive: true })
    const fallback = make({ activeId: 'fallback-1', route: 'fallback' })
    const delayedHydration = make({
      activeId: 'main',
      route: 'main',
      main: { quota: null, tierLabel: 'Max 20x' },
    })

    const routingWrite = setSidebarState(fallback, testFile)
    const hydrationWrite = setSidebarState(delayedHydration, testFile, {
      routingAuthoritative: false,
      resolvePreservedRouting: (current) => ({
        activeId: current.activeId,
        route: current.route,
      }),
    })
    await Promise.all([routingWrite, hydrationWrite])

    expect(await getSidebarState(testFile)).toMatchObject({
      activeId: 'fallback-1',
      route: 'fallback',
      main: { tierLabel: 'Max 20x' },
    })
  })
})

describe('setSidebarState cross-process writes', () => {
  test('does not clobber a successor after losing the lock before rename', async () => {
    const stateFile = sidebarTestPath('lost-before-rename')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    const initial = make({
      activeId: 'initial-routing',
      route: 'initial-route',
      lastUpdated: 100,
    })
    const successor = make({
      activeId: 'successor-routing',
      route: 'successor-route',
      lastUpdated: 300,
    })
    const staleWriter = make({ fastMode: true, lastUpdated: 200 })
    await mkdir(stateDir, { recursive: true })
    await writeFile(stateFile, JSON.stringify(initial))

    let child: ReturnType<typeof Bun.spawn> | undefined
    let paused = false
    __setSidebarStateWriteTestHooks({
      beforeRename: async () => {
        if (paused) return
        paused = true
        const stale = new Date(Date.now() - 3_000)
        await utimes(lockDir, stale, stale)
        const moduleUrl = new URL('../sidebar-state.ts', import.meta.url).href
        child = Bun.spawn([
          process.execPath,
          '--eval',
          `import { setSidebarState } from ${JSON.stringify(moduleUrl)}; await setSidebarState(${JSON.stringify(successor)}, ${JSON.stringify(stateFile)})`,
        ])
        expect(await child.exited).toBe(0)
      },
    })

    try {
      await setSidebarState(staleWriter, stateFile, {
        routingAuthoritative: false,
        resolvePreservedRouting: (current) => ({
          activeId: current.activeId,
          route: current.route,
        }),
      })
      const written = JSON.parse(await readFile(stateFile, 'utf8'))
      expect(written.activeId).toBe('successor-routing')
      expect(written.route).toBe('successor-route')
    } finally {
      __setSidebarStateWriteTestHooks(null)
      child?.kill()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  for (const routingAuthoritative of [true, false]) {
    test(`repairs an ${routingAuthoritative ? 'authoritative' : 'non-authoritative'} write after losing ownership post-rename`, async () => {
      const stateFile = sidebarTestPath(
        `lost-after-rename-${routingAuthoritative ? 'authoritative' : 'merge'}`,
      )
      const stateDir = join(stateFile, '..')
      const lockDir = `${stateFile}.lock`
      const initial = make({
        activeId: 'initial-routing',
        route: 'initial-route',
        main: { quota: quota(20) },
        fastMode: false,
        lastUpdated: 100,
      })
      const successor = make({
        activeId: 'successor-routing',
        route: 'successor-route',
        main: { quota: quota(80) },
        fastMode: false,
        lastUpdated: 300,
      })
      const staleWriter = make({
        activeId: 'writer-routing',
        route: 'writer-route',
        main: { quota: quota(10) },
        fastMode: true,
        lastUpdated: 200,
      })
      await mkdir(stateDir, { recursive: true })
      await writeFile(stateFile, JSON.stringify(initial))

      let child: ReturnType<typeof Bun.spawn> | undefined
      let paused = false
      __setSidebarStateWriteTestHooks({
        afterRename: async () => {
          if (paused) return
          paused = true
          const stale = new Date(Date.now() - 3_000)
          await utimes(lockDir, stale, stale)
          const moduleUrl = new URL('../sidebar-state.ts', import.meta.url).href
          child = Bun.spawn([
            process.execPath,
            '--eval',
            `import { setSidebarState } from ${JSON.stringify(moduleUrl)}; await setSidebarState(${JSON.stringify(successor)}, ${JSON.stringify(stateFile)})`,
          ])
          expect(await child.exited).toBe(0)
        },
      })

      try {
        await setSidebarState(staleWriter, stateFile, {
          routingAuthoritative,
          resolvePreservedRouting: routingAuthoritative
            ? undefined
            : (current) => ({
                activeId: current.activeId,
                route: current.route,
                state: {
                  ...staleWriter,
                  main: current.main,
                  fallbacks: current.fallbacks,
                },
              }),
        })
        const settled = await Promise.race([
          drainSidebarWrites().then(() => true),
          Bun.sleep(100).then(() => false),
        ])
        expect(settled).toBe(true)
        const written = JSON.parse(await readFile(stateFile, 'utf8'))
        expect(written.activeId).toBe(
          routingAuthoritative ? 'writer-routing' : 'successor-routing',
        )
        expect(written.route).toBe(
          routingAuthoritative ? 'writer-route' : 'successor-route',
        )
        expect(written.main.quota.five_hour.usedPercent).toBe(80)
        expect(written.fastMode).toBe(true)
      } finally {
        __setSidebarStateWriteTestHooks(null)
        child?.kill()
        await rm(stateDir, { recursive: true, force: true })
      }
    })
  }

  for (const routingAuthoritative of [true, false]) {
    test(`skips ${routingAuthoritative ? 'authoritative' : 'non-authoritative'} writes when the lock budget is exhausted`, async () => {
      const stateFile = sidebarTestPath(
        routingAuthoritative
          ? 'lock-budget-authoritative'
          : 'lock-budget-merge',
      )
      const stateDir = join(stateFile, '..')
      const lockDir = `${stateFile}.lock`
      const initial = make({
        activeId: 'foreign-routing',
        route: 'foreign-route',
        fastMode: false,
        lastUpdated: 300,
      })
      const staleWriter = make({
        activeId: 'stale-routing',
        route: 'stale-route',
        fastMode: true,
        lastUpdated: 200,
      })
      const originalContents = JSON.stringify(initial)
      await mkdir(stateDir, { recursive: true })
      await writeFile(stateFile, originalContents)
      await mkdir(lockDir)
      __setSidebarStateWriteTestHooks({
        lockBudgetMs: 20,
        lockRetryMinMs: 1,
        lockRetryMaxMs: 1,
      })

      try {
        await setSidebarState(staleWriter, stateFile, {
          routingAuthoritative,
          resolvePreservedRouting: (current) => ({
            activeId: current.activeId,
            route: current.route,
          }),
        })
        const drained = await Promise.race([
          drainSidebarWrites().then(() => true),
          Bun.sleep(100).then(() => false),
        ])
        expect(drained).toBe(true)
        expect(await readFile(stateFile, 'utf8')).toBe(originalContents)
      } finally {
        __setSidebarStateWriteTestHooks(null)
        await rm(stateDir, { recursive: true, force: true })
      }
    })
  }

  test('preserves an authoritative write from another process during a non-authoritative merge', async () => {
    const stateFile = sidebarTestPath('race')
    const stateDir = join(stateFile, '..')
    const initial = make({
      activeId: 'old-routing',
      route: 'old-route',
      lastUpdated: 100,
    })
    const foreign = make({
      activeId: 'foreign-routing',
      route: 'foreign-route',
      lastUpdated: 300,
    })
    const nonAuthoritative = make({
      activeId: 'stale-routing',
      route: 'stale-route',
      lastUpdated: 200,
    })
    await mkdir(stateDir, { recursive: true })
    await writeFile(stateFile, JSON.stringify(initial))

    let child: ReturnType<typeof Bun.spawn> | undefined
    __setSidebarStateWriteTestHooks({
      afterMergeRead: async () => {
        const moduleUrl = new URL('../sidebar-state.ts', import.meta.url).href
        const script = `
          import { setSidebarState } from ${JSON.stringify(moduleUrl)}
          await setSidebarState(${JSON.stringify(foreign)}, ${JSON.stringify(stateFile)})
        `
        child = Bun.spawn([process.execPath, '--eval', script], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await Promise.race([
          child.exited,
          new Promise((resolve) => setTimeout(resolve, 50)),
        ])
      },
    })

    try {
      await setSidebarState(nonAuthoritative, stateFile, {
        routingAuthoritative: false,
        resolvePreservedRouting: (current) => ({
          activeId: current.activeId,
          route: current.route,
        }),
      })
      expect(child).toBeDefined()
      expect(await child!.exited).toBe(0)
      const written = JSON.parse(await readFile(stateFile, 'utf8'))
      expect(written.activeId).toBe('foreign-routing')
      expect(written.route).toBe('foreign-route')
    } finally {
      __setSidebarStateWriteTestHooks(null)
      child?.kill()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('allows only one waiter to evict and replace a stale lock', async () => {
    type RaceHooks = Parameters<typeof __setSidebarStateWriteTestHooks>[0] & {
      afterStaleLockStat?: () => void | Promise<void>
      onStaleLockClaimed?: () => void | Promise<void>
      onLockAcquired?: () => void | Promise<void>
    }
    const stateFile = sidebarTestPath('stale-lock-race')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    await mkdir(lockDir, { recursive: true })
    const stale = new Date(Date.now() - 3_000)
    await utimes(lockDir, stale, stale)

    let staleStats = 0
    let releaseStaleStats!: () => void
    const bothSawStale = new Promise<void>((resolve) => {
      releaseStaleStats = resolve
    })
    let staleClaims = 0
    let acquisitions = 0
    const hooks: RaceHooks = {
      lockBudgetMs: 30,
      lockRetryMinMs: 1,
      lockRetryMaxMs: 1,
      afterStaleLockStat: async () => {
        staleStats++
        if (staleStats === 2) releaseStaleStats()
        await bothSawStale
      },
      onStaleLockClaimed: () => {
        staleClaims++
      },
      onLockAcquired: () => {
        acquisitions++
      },
    }
    ;(__setSidebarStateWriteTestHooks as (hooks: RaceHooks | null) => void)(
      hooks,
    )

    let firstRelease: (() => Promise<void>) | null = null
    let secondRelease: (() => Promise<void>) | null = null
    try {
      ;[firstRelease, secondRelease] = await Promise.all([
        __acquireSidebarStateLockForTest(stateFile),
        __acquireSidebarStateLockForTest(stateFile),
      ])
      expect(staleClaims).toBe(1)
      expect(acquisitions).toBe(1)
      expect([firstRelease, secondRelease].filter(Boolean)).toHaveLength(1)
    } finally {
      await firstRelease?.()
      await secondRelease?.()
      __setSidebarStateWriteTestHooks(null)
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('an evicted owner cannot release its replacement lock', async () => {
    const stateFile = sidebarTestPath('release-handoff')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    await mkdir(stateDir, { recursive: true })

    const firstRelease = await __acquireSidebarStateLockForTest(stateFile)
    expect(firstRelease).toBeFunction()
    const stale = new Date(Date.now() - 3_000)
    await utimes(lockDir, stale, stale)
    const secondRelease = await __acquireSidebarStateLockForTest(stateFile)
    expect(secondRelease).toBeFunction()

    try {
      await firstRelease?.()
      expect(await pathExists(lockDir)).toBe(true)
      await secondRelease?.()
      expect(await pathExists(lockDir)).toBe(false)
    } finally {
      await secondRelease?.()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('a suspended release cannot remove a replacement lock', async () => {
    type ReleaseHooks = Parameters<
      typeof __setSidebarStateWriteTestHooks
    >[0] & {
      beforeReleaseDirectoryRemoval?: () => void | Promise<void>
    }
    const stateFile = sidebarTestPath('release-three-writer-handoff')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    await mkdir(stateDir, { recursive: true })

    let releasePaused!: () => void
    const paused = new Promise<void>((resolve) => {
      releasePaused = resolve
    })
    let resumeRelease!: () => void
    const resumed = new Promise<void>((resolve) => {
      resumeRelease = resolve
    })
    const hooks: ReleaseHooks = {
      beforeReleaseDirectoryRemoval: async () => {
        releasePaused()
        await resumed
      },
    }
    ;(__setSidebarStateWriteTestHooks as (hooks: ReleaseHooks | null) => void)(
      hooks,
    )

    let firstRelease: (() => Promise<void>) | null = null
    let secondRelease: (() => Promise<void>) | null = null
    let thirdRelease: (() => Promise<void>) | null = null
    try {
      firstRelease = await __acquireSidebarStateLockForTest(stateFile)
      expect(firstRelease).toBeFunction()
      const firstReleaseResult = firstRelease!()
      const didPause = await Promise.race([
        paused.then(() => true),
        Bun.sleep(20).then(() => false),
      ])
      expect(didPause).toBe(true)
      if (!didPause) {
        resumeRelease()
        await firstReleaseResult
        return
      }

      const stale = new Date(Date.now() - 3_000)
      await utimes(lockDir, stale, stale)
      secondRelease = await __acquireSidebarStateLockForTest(stateFile)
      expect(secondRelease).toBeFunction()
      resumeRelease()
      await firstReleaseResult

      ;(
        __setSidebarStateWriteTestHooks as (hooks: ReleaseHooks | null) => void
      )({
        lockBudgetMs: 20,
        lockRetryMinMs: 5,
        lockRetryMaxMs: 5,
      })
      thirdRelease = await __acquireSidebarStateLockForTest(stateFile)
      expect(thirdRelease).toBeNull()
      expect(await pathExists(lockDir)).toBe(true)
    } finally {
      resumeRelease()
      await thirdRelease?.()
      await secondRelease?.()
      __setSidebarStateWriteTestHooks(null)
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('release removes the lock owned by its acquisition token', async () => {
    const stateFile = sidebarTestPath('release-owned')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    await mkdir(stateDir, { recursive: true })
    const release = await __acquireSidebarStateLockForTest(stateFile)

    try {
      expect(release).toBeFunction()
      const ownerFiles = await readdir(lockDir)
      expect(ownerFiles).toHaveLength(1)
      expect(ownerFiles[0]).not.toBe('owner')
      await release?.()
      expect(await pathExists(lockDir)).toBe(false)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('release leaves the lock untouched when its owner file is missing', async () => {
    const stateFile = sidebarTestPath('release-missing-owner')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    await mkdir(stateDir, { recursive: true })
    const release = await __acquireSidebarStateLockForTest(stateFile)
    expect(release).toBeFunction()
    const [ownerFile] = await readdir(lockDir)
    expect(ownerFile).toBeDefined()
    await rm(join(lockDir, ownerFile!), { force: true })

    try {
      await release?.()
      expect(await pathExists(lockDir)).toBe(true)
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('evicts a stale lock and writes the state', async () => {
    const stateFile = sidebarTestPath('stale-lock')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    await mkdir(lockDir, { recursive: true })
    const stale = new Date(Date.now() - 3_000)
    await utimes(lockDir, stale, stale)

    try {
      await setSidebarState(
        make({ activeId: 'fresh', route: 'fresh' }),
        stateFile,
      )
      const written = JSON.parse(await readFile(stateFile, 'utf8'))
      expect(written.activeId).toBe('fresh')
      expect(await readdir(stateDir)).not.toContain('sidebar-state.json.lock')
    } finally {
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('keeps the visible file complete until an atomic rename publishes the new state', async () => {
    const stateFile = sidebarTestPath('atomic')
    const stateDir = join(stateFile, '..')
    const initial = make({ activeId: 'initial', route: 'initial' })
    const next = make({ activeId: 'next', route: 'next' })
    await mkdir(stateDir, { recursive: true })
    await writeFile(stateFile, JSON.stringify(initial))

    let enteredRename!: () => void
    const renameReady = new Promise<void>((resolve) => {
      enteredRename = resolve
    })
    let releaseRename!: () => void
    const renameReleased = new Promise<void>((resolve) => {
      releaseRename = resolve
    })
    __setSidebarStateWriteTestHooks({
      beforeRename: async () => {
        enteredRename()
        await renameReleased
      },
    })

    try {
      const write = setSidebarState(next, stateFile)
      await renameReady
      for (let attempt = 0; attempt < 10; attempt++) {
        const visible = JSON.parse(await readFile(stateFile, 'utf8'))
        expect(visible.activeId).toBe('initial')
      }
      const tempName = (await readdir(stateDir)).find((name) =>
        name.endsWith('.tmp'),
      )
      expect(tempName).toBeDefined()
      const tempContents = await readFile(join(stateDir, tempName!), 'utf8')
      expect(() => JSON.parse(tempContents)).not.toThrow()
      releaseRename()
      await write
      const visible = JSON.parse(await readFile(stateFile, 'utf8'))
      expect(visible.activeId).toBe('next')
    } finally {
      releaseRename()
      __setSidebarStateWriteTestHooks(null)
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('aborts a write after its lock is evicted before rename', async () => {
    const stateFile = sidebarTestPath('lost-before-rename')
    const stateDir = join(stateFile, '..')
    const lockDir = `${stateFile}.lock`
    const initial = make({ activeId: 'initial', route: 'initial' })
    const staleWriter = make({ activeId: 'stale-writer', route: 'stale' })
    const replacement = make({ activeId: 'replacement', route: 'replacement' })
    await mkdir(stateDir, { recursive: true })
    await writeFile(stateFile, JSON.stringify(initial))

    const replacementLock: {
      release: (() => Promise<void>) | null
    } = { release: null }
    __setSidebarStateWriteTestHooks({
      beforeRename: async () => {
        const stale = new Date(Date.now() - 3_000)
        await utimes(lockDir, stale, stale)
        replacementLock.release =
          await __acquireSidebarStateLockForTest(stateFile)
        expect(replacementLock.release).toBeFunction()
        await writeFile(stateFile, JSON.stringify(replacement))
      },
    })

    try {
      await setSidebarState(staleWriter, stateFile)
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(replacement)
    } finally {
      __setSidebarStateWriteTestHooks(null)
      await replacementLock.release?.()
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})
