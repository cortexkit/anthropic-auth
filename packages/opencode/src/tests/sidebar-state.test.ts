import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  FIVE_HOUR_MS,
  getCollapsedQuotaSummary,
  getSidebarState,
  normalizeSidebarState,
  resolveActiveAccount,
  SEVEN_DAY_MS,
  type SidebarState,
} from '../sidebar-state'

const quota = (used: number): AccountQuota => ({
  five_hour: { usedPercent: used, remainingPercent: 100 - used },
  seven_day: { usedPercent: used, remainingPercent: 100 - used },
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

describe('getCollapsedQuotaSummary', () => {
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

  test('returns no collapsed quota text when no windows are available', () => {
    expect(getCollapsedQuotaSummary(null).text).toBeNull()
    expect(getCollapsedQuotaSummary({}).text).toBeNull()
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
})
