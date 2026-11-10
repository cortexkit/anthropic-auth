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
  formatQuota,
  quotaDisplayProjection,
} from '@cortexkit/anthropic-auth-core'
import {
  __acquireSidebarStateLockForTest,
  __setSidebarStateWriteTestHooks,
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  drainSidebarWrites,
  FIVE_HOUR_MS,
  fitPaceLine,
  fitQuotaRow,
  formatFallbackModelLabel,
  formatPrimeAccountValue,
  formatPrimeCost,
  formatPrimeTime,
  formatQuotaRowLabel,
  getCollapsedAccounts,
  getCollapsedQuotaSummary,
  getFableRecoverySummary,
  getSidebarState,
  normalizeSidebarState,
  quotaLabelColumnWidth,
  resolveActiveAccount,
  SEVEN_DAY_MS,
  type SidebarState,
  scopedQuotaShortNames,
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
    const skipped = normalizeSidebarState({
      prime: {
        enabled: true,
        accounts: [
          { id: 'cold-vault', label: 'cold-vault', lastResult: 'skipped' },
        ],
      },
    }).prime?.accounts[0]
    expect(skipped).toBeDefined()
    expect(formatPrimeAccountValue(skipped!)).toEqual({
      text: 'skip',
      hasError: false,
    })
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
  test('formats Mythos 5.2 with its own sidebar label', () => {
    for (const id of ['claude-mythos-5-2', 'claude-mythos-5-2-20261109[1m]']) {
      expect(formatFallbackModelLabel(id)).toBe('Mythos 5.2')
    }
  })
  test('formats Fable 5.2 ahead of the generic Fable 5 prefix', () => {
    expect(formatFallbackModelLabel('claude-fable-5-2')).toBe('Fable 5.2')
    expect(formatFallbackModelLabel('claude-fable-5-2-20261109')).toBe(
      'Fable 5.2',
    )
  })
  test('formats Fable 5 ids', () => {
    expect(formatFallbackModelLabel('claude-fable-5')).toBe('Fable 5')
    expect(formatFallbackModelLabel('claude-fable-5-20260608')).toBe('Fable 5')
    expect(formatFallbackModelLabel('claude-fable-5-1')).toBe('Fable 5.1')
    expect(formatFallbackModelLabel('claude-fable-5-1-20260701')).toBe(
      'Fable 5.1',
    )
    expect(formatFallbackModelLabel('claude-mythos-5-1')).toBe('Mythos 5.1')
    expect(formatFallbackModelLabel('claude-mythos-5-1-20260701')).toBe(
      'Mythos 5.1',
    )
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

describe('formatQuotaRowLabel', () => {
  test('keeps full shared names and pads short window names to the same column', () => {
    expect(formatQuotaRowLabel('Fable only')).toBe('Fable only')
    expect(formatQuotaRowLabel('5h')).toBe('5h        ')
    expect(formatQuotaRowLabel('7d')).toBe('7d        ')
  })

  test('cuts long names with a trailing ellipsis instead of an abbreviation', () => {
    expect(formatQuotaRowLabel('Fable weekly only')).toBe('Fable wee…')
    expect(formatQuotaRowLabel('Fable only', 7)).toBe('Fable …')
  })

  test('measures terminal cells rather than splitting wide model names', () => {
    const label = formatQuotaRowLabel('模型模型模型 only')
    expect(label).toBe('模型模型… ')
    expect(Bun.stringWidth(label)).toBe(10)
  })
})

describe('scopedQuotaShortNames', () => {
  const scopedWindow = (id: string, modelName: string, modelId?: string) => ({
    id,
    title: `${modelName} only`,
    modelName,
    ...(modelId ? { modelId } : {}),
    usedPercent: 10,
    remainingPercent: 90,
  })

  test('names a scoped window as the collapsed narrow line does', () => {
    const quota = { scoped: [scopedWindow('fable', 'Fable')] }
    expect(scopedQuotaShortNames(quota)).toEqual(['Fa'])
    expect(
      formatQuota(quotaDisplayProjection(quota, Date.now()), {
        now: Date.now(),
        form: 'narrow',
      }),
    ).toBe('Fa 90% left')
    expect(quotaLabelColumnWidth([quota, null])).toBe(2)
  })

  test('extends colliding names exactly as the narrow line does', () => {
    const quota = {
      scoped: [
        scopedWindow('a', 'Fable'),
        scopedWindow('b', 'Fabric'),
        scopedWindow('c', 'Opus'),
      ],
    }
    expect(scopedQuotaShortNames(quota)).toEqual(['Fabl', 'Fabr', 'Op'])
    expect(quotaLabelColumnWidth([quota])).toBe(4)
  })

  test('follows the narrow line in naming a window by its model id', () => {
    expect(
      scopedQuotaShortNames({
        scoped: [scopedWindow('f', 'Other', 'model:fable')],
      }),
    ).toEqual(['Fa'])
  })
})

describe('fitQuotaRow', () => {
  const row = { labelWidth: 2, barWidth: 10, figure: '100% left \u2022' }
  // label 2 + space + bar 10 + space + figure 11 = 25 cells before the reset.
  test('keeps the whole row when it fits, with a gap before the reset', () => {
    expect(fitQuotaRow({ ...row, width: 31, reset: '6d23h' })).toEqual({
      barCells: 10,
      reset: '6d23h',
    })
  })

  test('drops the reset before the bar shrinks, and keeps a minimum bar', () => {
    const fit = (width: number) =>
      fitQuotaRow({ ...row, width, reset: '6d23h' })
    expect(fit(30)).toEqual({ barCells: 10 })
    expect(fit(25)).toEqual({ barCells: 10 })
    expect(fit(24)).toEqual({ barCells: 9 })
    expect(fit(18)).toEqual({ barCells: 3 })
    // Too narrow even then: the minimum bar stays and the row is cut.
    expect(fit(17)).toEqual({ barCells: 3 })
    expect(fit(5)).toEqual({ barCells: 3 })
  })

  test('keeps the full row before the first layout', () => {
    expect(fitQuotaRow({ ...row, width: undefined, reset: '6d23h' })).toEqual({
      barCells: 10,
      reset: '6d23h',
    })
  })
})

describe('fitPaceLine', () => {
  const deficit = {
    pacePercent: 40,
    deltaPercent: 12,
    state: 'deficit' as const,
    runsOutAt: 'x',
  }
  const reserve = {
    pacePercent: 29,
    deltaPercent: -4.2,
    state: 'reserve' as const,
    runsOutAt: null,
  }
  test('cuts a subline that does not fit with an ellipsis', () => {
    expect(fitPaceLine(deficit, 30, '1d23h')).toBe(
      'deficit 12% \u00b7 out in 1d23h',
    )
    expect(fitPaceLine(deficit, 25, '1d23h')).toBe(
      'deficit 12% \u00b7 out in 1d2\u2026',
    )
    expect(Bun.stringWidth(fitPaceLine(deficit, 25, '1d23h') ?? '')).toBe(25)
  })

  test('a window that lasts says to what', () => {
    expect(fitPaceLine(reserve, 30, undefined)).toBe(
      'reserve 4% \u00b7 lasts to reset',
    )
    expect(fitPaceLine(reserve, 26, undefined)).toBe(
      'reserve 4% \u00b7 lasts to res\u2026',
    )
    expect(fitPaceLine({ ...reserve, state: 'on-pace' }, 30, undefined)).toBe(
      null,
    )
  })

  test('an exhausted window says it is used up until its reset', () => {
    expect(fitPaceLine(deficit, 30, 'now', '2h10m', 0)).toBe(
      'used up \u00b7 resets in 2h10m',
    )
    expect(fitPaceLine(deficit, 30, '2h10m', '2h10m', 0)).toBe(
      'used up \u00b7 resets in 2h10m',
    )
    expect(fitPaceLine(deficit, 30, 'now', '2h10m', 0)).not.toContain('out in')
    expect(fitPaceLine(deficit, 30, 'now', '2h10m', 0)).not.toContain('43%')
    expect(
      Bun.stringWidth(fitPaceLine(deficit, 30, 'now', '2h10m', 0) ?? ''),
    ).toBe(Bun.stringWidth('used up \u00b7 resets in 2h10m'))
  })

  test('a runout under a minute away reads out in <1m, never out in now', () => {
    expect(fitPaceLine(deficit, 30, 'now')).toBe(
      'deficit 12% \u00b7 out in <1m',
    )
    expect(fitPaceLine(deficit, 30, '0m')).toBe('deficit 12% \u00b7 out in <1m')
    expect(fitPaceLine(deficit, 30, '<1m')).toBe(
      'deficit 12% \u00b7 out in <1m',
    )
  })
})

describe('getCollapsedQuotaSummary', () => {
  test('collapsed quota summary shares credit wording but omits binding marker and fallback advice', () => {
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
    ).toBe('5h 22% · 7d 60% · cr 0% left')
  })

  test('formats both active-account quota windows', () => {
    expect(getCollapsedQuotaSummary(quota(13)).text).toBe(
      '5h 87% · 7d 87% left',
    )
  })

  test('formats different 5h and 7d percentages', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 13.4, remainingPercent: 86.6 },
        seven_day: { usedPercent: 7.2, remainingPercent: 92.8 },
      }).text,
    ).toBe('5h 87% · 7d 93% left')
  })

  test('leaves out an account-wide window that has no reading', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 13, remainingPercent: 87 },
      }).text,
    ).toBe('5h 87% left')
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
    ).toBe('5h 87% · 7d 93% · Fa 58% left')
  })

  test('returns no collapsed quota text when no windows are available', () => {
    expect(getCollapsedQuotaSummary(null).text).toBeNull()
    expect(getCollapsedQuotaSummary({}).text).toBeNull()
  })

  test('shows only the scoped reading when no account-wide window has one', () => {
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
    expect(summary.text).toBe('Fa 0% left')
  })

  test('leaves out an unreported account-wide window beside a scoped reading', () => {
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
    expect(summary.text).toBe('5h 77% · Fa 58% left')
  })

  test('keeps reading times through normalization and flags staleness without age text', () => {
    const now = Date.parse('2026-04-28T12:00:00Z')
    const checkedAt = now - 2 * 86400000
    const normalized = normalizeSidebarState({
      main: {
        quota: {
          checkedAt,
          five_hour: { usedPercent: 60, remainingPercent: 40, checkedAt },
          scoped: [],
        },
      },
    })
    expect(normalized.main.quota?.checkedAt).toBe(checkedAt)
    expect(normalized.main.quota?.five_hour?.checkedAt).toBe(checkedAt)
    expect(normalized.main.quota?.scoped).toEqual([])
    expect(getCollapsedQuotaSummary(normalized.main.quota, now).text).toBe(
      '5h 40% left',
    )
    expect(getCollapsedQuotaSummary(normalized.main.quota, now).stale).toBe(
      true,
    )
  })

  test('shows only the tightest of two model windows after both account-wide windows', () => {
    const scoped = (modelName: string, remainingPercent: number) => ({
      id: modelName,
      title: `${modelName} only`,
      modelName,
      usedPercent: 100 - remainingPercent,
      remainingPercent,
    })
    expect(
      getCollapsedQuotaSummary({
        ...quota(10),
        scoped: [scoped('Fable', 98), scoped('Opus', 12)],
      }).text,
    ).toBe('5h 90% · 7d 90% · Op 12% left')
    expect(
      getCollapsedQuotaSummary({
        ...quota(10),
        scoped: [scoped('Fable', 12), scoped('Opus', 12)],
      }).text,
    ).toBe('5h 90% · 7d 90% · Fa 12% left')
  })

  test('extends colliding model names letter by letter even if only the tightest is shown', () => {
    const scoped = (modelName: string, remainingPercent: number) => ({
      id: modelName,
      title: `${modelName} only`,
      modelName,
      usedPercent: 100 - remainingPercent,
      remainingPercent,
    })
    expect(
      getCollapsedQuotaSummary({
        ...quota(10),
        scoped: [scoped('Fable', 12), scoped('Fabric', 80)],
      }).text,
    ).toBe('5h 90% · 7d 90% · Fabl 12% left')
    expect(
      getCollapsedQuotaSummary({
        ...quota(10),
        scoped: [scoped('Fable', 80), scoped('Fabric', 12)],
      }).text,
    ).toBe('5h 90% · 7d 90% · Fabr 12% left')
  })

  test.each([
    ['credit tighter than Fable', 9000, 'cr 10%'],
    ['Fable tighter than credit', 2500, 'Fa 22%'],
    ['equal credit and Fable', 7800, 'Fa 22%'],
  ] as const)('shows one extra item when %s', (_name, usedMinor, expected) => {
    const summary = getCollapsedQuotaSummary({
      five_hour: { usedPercent: 62, remainingPercent: 38 },
      seven_day: { usedPercent: 41, remainingPercent: 59 },
      scoped: [
        {
          id: 'fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 78,
          remainingPercent: 22,
        },
      ],
      extraUsage: {
        used: { amountMinor: usedMinor, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        exhausted: false,
      },
    })
    expect(summary.text).toBe(`5h 38% · 7d 59% · ${expected} left`)
    expect(summary.text?.split(' · ')).toHaveLength(3)
  })

  test('an exhausted credit budget loses a tie to the first exhausted scoped window', () => {
    const summary = getCollapsedQuotaSummary({
      ...quota(10),
      scoped: [
        {
          id: 'fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100,
          remainingPercent: 0,
        },
        {
          id: 'opus',
          title: 'Opus only',
          modelName: 'Opus',
          usedPercent: 100,
          remainingPercent: 0,
        },
      ],
      extraUsage: {
        used: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        limit: { amountMinor: 10000, currency: 'USD', exponent: 2 },
        exhausted: true,
      },
    })
    expect(summary.text).toBe('5h 90% · 7d 90% · Fa 0% left')
  })

  test('marks only stale readings and omits reset and age wording from narrow text', () => {
    const now = 10 * 86400000
    const fresh = getCollapsedQuotaSummary(
      { five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: now } },
      now,
    )
    expect(fresh.stale).toBe(false)
    const stale = getCollapsedQuotaSummary(
      {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          checkedAt: now - 30 * 3600000,
        },
      },
      now,
    )
    expect(stale.stale).toBe(true)
    expect(stale.text).toBe('5h 100% left')
  })
})

describe('getCollapsedAccounts', () => {
  test('marks unavailable credentials as blocked without confusing idle or stale accounts with blocked ones', () => {
    const fallback = (id: string, overrides = {}) => ({
      id,
      enabled: true,
      needsReauth: false,
      quota: quota(20),
      ...overrides,
    })
    const state = make({
      main: { quota: quota(10), stateLine: 'refresh paused' },
      fallbacks: [
        fallback('idle'),
        fallback('dated', { quotaDated: true }),
        fallback('reauth', { needsReauth: true }),
        fallback('vault-reauth', { vaultReauth: true }),
        fallback('state-line', { stateLine: 'credential unavailable' }),
        fallback('vault-disabled', { enabled: false, custodyState: 'on-cold' }),
        fallback('vault-cold', { custodyState: 'on-cold' }),
        fallback('vault-served', { custodyState: 'on-vault-served' }),
        fallback('vault-off', { custodyState: 'off' }),
      ],
    })
    expect(
      getCollapsedAccounts(state).map(({ id, blocked }) => ({ id, blocked })),
    ).toEqual([
      { id: 'main', blocked: true },
      { id: 'idle', blocked: false },
      { id: 'dated', blocked: false },
      { id: 'reauth', blocked: true },
      { id: 'vault-reauth', blocked: true },
      { id: 'state-line', blocked: true },
      { id: 'vault-disabled', blocked: true },
      { id: 'vault-cold', blocked: true },
      { id: 'vault-served', blocked: false },
      { id: 'vault-off', blocked: false },
    ])
    expect(
      getCollapsedAccounts(make({ main: { quota: null, enabled: false } }))[0]
        ?.blocked,
    ).toBe(true)
  })

  test('keeps placement order rather than moving the active fallback first', () => {
    const state = make({
      main: { quota: quota(10) },
      activeId: 'second',
      fallbacks: [
        {
          id: 'first',
          label: 'first',
          enabled: true,
          quota: quota(20),
          needsReauth: false,
        },
        {
          id: 'second',
          label: 'second',
          enabled: true,
          quota: quota(30),
          needsReauth: false,
        },
        {
          id: 'disabled',
          label: 'disabled',
          enabled: false,
          quota: quota(40),
          needsReauth: false,
        },
      ],
    })
    expect(
      getCollapsedAccounts(state).map(({ id, active }) => ({ id, active })),
    ).toEqual([
      { id: 'main', active: false },
      { id: 'first', active: false },
      { id: 'second', active: true },
    ])
    expect(getCollapsedAccounts(state, false).map(({ id }) => id)).toEqual([
      'main',
    ])
  })

  test('marks no row active before any account has served', () => {
    const state = make({ activeId: undefined, main: { quota: quota(10) } })
    expect(getCollapsedAccounts(state).map(({ active }) => active)).toEqual([
      false,
    ])
  })

  test('uses the custody-selected inventory and keeps visible disabled vault accounts', () => {
    const state = make({
      main: { quota: quota(10) },
      activeId: 'main',
      fallbacks: [
        {
          id: 'vault-on',
          label: 'vault-on',
          enabled: true,
          quota: quota(20),
          needsReauth: false,
          custodyState: 'on-vault-served',
        },
        {
          id: 'vault-off',
          label: 'vault-off',
          enabled: false,
          quota: quota(30),
          needsReauth: false,
          custodyState: 'on-cold',
        },
      ],
    })
    expect(getCollapsedAccounts(state).map(({ id }) => id)).toEqual([
      'main',
      'vault-on',
      'vault-off',
    ])
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
    __setSidebarStateWriteTestHooks(
      {
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
      },
      stateFile,
    )

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
      __setSidebarStateWriteTestHooks(null, stateFile)
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
      __setSidebarStateWriteTestHooks(
        {
          afterRename: async () => {
            if (paused) return
            paused = true
            const stale = new Date(Date.now() - 3_000)
            await utimes(lockDir, stale, stale)
            const moduleUrl = new URL('../sidebar-state.ts', import.meta.url)
              .href
            child = Bun.spawn([
              process.execPath,
              '--eval',
              `import { setSidebarState } from ${JSON.stringify(moduleUrl)}; await setSidebarState(${JSON.stringify(successor)}, ${JSON.stringify(stateFile)})`,
            ])
            expect(await child.exited).toBe(0)
          },
        },
        stateFile,
      )

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
        __setSidebarStateWriteTestHooks(null, stateFile)
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
      __setSidebarStateWriteTestHooks(
        {
          lockBudgetMs: 20,
          lockRetryMinMs: 1,
          lockRetryMaxMs: 1,
        },
        stateFile,
      )

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
        __setSidebarStateWriteTestHooks(null, stateFile)
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
    __setSidebarStateWriteTestHooks(
      {
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
      },
      stateFile,
    )

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
      __setSidebarStateWriteTestHooks(null, stateFile)
      child?.kill()
      await rm(stateDir, { recursive: true, force: true })
    }
  })

  test('scopes write hooks to their state file', async () => {
    const firstStateFile = sidebarTestPath('hook-scope-first')
    const secondStateFile = sidebarTestPath('hook-scope-second')
    await mkdir(join(firstStateFile, '..'), { recursive: true })
    await mkdir(join(secondStateFile, '..'), { recursive: true })
    let firstAcquisitions = 0
    let secondAcquisitions = 0
    __setSidebarStateWriteTestHooks(
      {
        onLockAcquired: () => {
          firstAcquisitions++
        },
      },
      firstStateFile,
    )
    __setSidebarStateWriteTestHooks(
      {
        onLockAcquired: () => {
          secondAcquisitions++
        },
      },
      secondStateFile,
    )

    let release: (() => Promise<void>) | null = null
    try {
      release = await __acquireSidebarStateLockForTest(firstStateFile)
      expect(release).toBeFunction()
      expect(firstAcquisitions).toBe(1)
      expect(secondAcquisitions).toBe(0)
    } finally {
      await release?.()
      __setSidebarStateWriteTestHooks(null, firstStateFile)
      __setSidebarStateWriteTestHooks(null, secondStateFile)
      await rm(join(firstStateFile, '..'), { recursive: true, force: true })
      await rm(join(secondStateFile, '..'), { recursive: true, force: true })
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
    __setSidebarStateWriteTestHooks(hooks, stateFile)

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
      __setSidebarStateWriteTestHooks(null, stateFile)
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
    __setSidebarStateWriteTestHooks(hooks, stateFile)

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

      __setSidebarStateWriteTestHooks(
        {
          lockBudgetMs: 20,
          lockRetryMinMs: 5,
          lockRetryMaxMs: 5,
        },
        stateFile,
      )
      thirdRelease = await __acquireSidebarStateLockForTest(stateFile)
      expect(thirdRelease).toBeNull()
      expect(await pathExists(lockDir)).toBe(true)
    } finally {
      resumeRelease()
      await thirdRelease?.()
      await secondRelease?.()
      __setSidebarStateWriteTestHooks(null, stateFile)
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
    __setSidebarStateWriteTestHooks(
      {
        beforeRename: async () => {
          enteredRename()
          await renameReleased
        },
      },
      stateFile,
    )

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
      __setSidebarStateWriteTestHooks(null, stateFile)
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
    __setSidebarStateWriteTestHooks(
      {
        beforeRename: async () => {
          const stale = new Date(Date.now() - 3_000)
          await utimes(lockDir, stale, stale)
          replacementLock.release =
            await __acquireSidebarStateLockForTest(stateFile)
          expect(replacementLock.release).toBeFunction()
          await writeFile(stateFile, JSON.stringify(replacement))
        },
      },
      stateFile,
    )

    try {
      await setSidebarState(staleWriter, stateFile)
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(replacement)
    } finally {
      __setSidebarStateWriteTestHooks(null, stateFile)
      await replacementLock.release?.()
      await rm(stateDir, { recursive: true, force: true })
    }
  })
})

test('vault account state lines and dated quota survive sidebar normalization', () => {
  const state = normalizeSidebarState({
    main: { quota: null, stateLine: 'turned off', quotaDated: true },
    fallbacks: [
      {
        id: 'vault-sign-in',
        enabled: true,
        custodyState: 'on-vault-reauth',
        stateLine: 'needs sign-in in the vault',
        quotaDated: true,
        quota: { five_hour: { usedPercent: 10, remainingPercent: 90 } },
      },
    ],
  })
  expect(state.main).toMatchObject({
    stateLine: 'turned off',
    quotaDated: true,
  })
  expect(
    resolveActiveAccount({ ...state, activeId: 'vault-sign-in' }),
  ).toMatchObject({
    id: 'vault-sign-in',
    stateLine: 'needs sign-in in the vault',
    quotaDated: true,
  })
  expect(state.fallbacks[0]).toMatchObject({
    enabled: true,
    custodyState: 'on-vault-reauth',
    stateLine: 'needs sign-in in the vault',
    quotaDated: true,
    quota: { five_hour: { remainingPercent: 90 } },
  })
})
