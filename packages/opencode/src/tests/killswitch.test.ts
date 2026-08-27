import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountScopedQuotaWindow,
  type AccountStorage,
  executeKillswitchCommand,
  getKillswitchConfig,
  getQuotaRefreshEveryNRequests,
  isKillswitchEnabled,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  loadAccounts,
  type OAuthQuotaSnapshot,
  parseKillswitchCommandAction,
  saveAccounts,
  setKillswitchPersistent,
} from '@cortexkit/anthropic-auth-core'

import {
  formatKillswitchBlockMessage,
  resolveScopedDrivenBlock,
} from '../request-policy.ts'

let tempDir: string
let accountPath: string

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  fallbackOn: [401, 403, 429],
  quota: {
    enabled: true,
    checkIntervalMinutes: 5,
    minimumRemaining: { five_hour: 10, seven_day: 20 },
    failClosedOnUnknownQuota: true,
  },
  accounts: [],
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-ks-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
})

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  await rm(tempDir, { recursive: true, force: true })
  mock.restore()
})

// ---------------------------------------------------------------------------
// parseKillswitchCommandAction
// ---------------------------------------------------------------------------
describe('parseKillswitchCommandAction', () => {
  test('bare command returns status', () => {
    expect(parseKillswitchCommandAction('')).toEqual({ type: 'status' })
  })

  test('on/off', () => {
    expect(parseKillswitchCommandAction('on')).toEqual({ type: 'on' })
    expect(parseKillswitchCommandAction('off')).toEqual({ type: 'off' })
  })

  test('set with single account', () => {
    expect(parseKillswitchCommandAction('set main:3,8')).toEqual({
      type: 'set',
      entries: [{ account: 'main', fh: 3, sd: 8 }],
    })
  })

  test('set with multiple accounts', () => {
    expect(parseKillswitchCommandAction('set main:3,8 work-alt:5,10')).toEqual({
      type: 'set',
      entries: [
        { account: 'main', fh: 3, sd: 8 },
        { account: 'work-alt', fh: 5, sd: 10 },
      ],
    })
  })

  test('set all', () => {
    expect(parseKillswitchCommandAction('set all:5,10')).toEqual({
      type: 'set',
      entries: [{ account: 'all', fh: 5, sd: 10 }],
    })
  })

  test('set with no args returns usage', () => {
    expect(parseKillswitchCommandAction('set')).toEqual({ type: 'usage' })
  })

  test('set with bad format returns usage', () => {
    expect(parseKillswitchCommandAction('set main:abc')).toEqual({
      type: 'usage',
    })
  })

  test('unknown subcommand returns usage', () => {
    expect(parseKillswitchCommandAction('bogus')).toEqual({ type: 'usage' })
  })
})

// ---------------------------------------------------------------------------
// killswitchPassesPolicy
// ---------------------------------------------------------------------------
describe('killswitchPassesPolicy', () => {
  test('passes when killswitch is disabled', () => {
    const storage = baseStorage()
    expect(killswitchPassesPolicy(undefined, storage)).toBe(true)
  })

  test('passes when quota is above threshold', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    const quota = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 20,
        remainingPercent: 80,
        checkedAt: Date.now(),
      },
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
  })

  test('fails when five_hour remaining is below threshold', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 10, seven_day: 10 },
    }
    const quota = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 20,
        remainingPercent: 80,
        checkedAt: Date.now(),
      },
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
  })

  test('fails when seven_day remaining is below threshold', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 20 },
    }
    const quota = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 90,
        remainingPercent: 10,
        checkedAt: Date.now(),
      },
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
  })

  test('uses per-account overrides', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
      accounts: { 'work-alt': { five_hour: 20, seven_day: 30 } },
    }
    const quota = {
      five_hour: {
        usedPercent: 85,
        remainingPercent: 15,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 75,
        remainingPercent: 25,
        checkedAt: Date.now(),
      },
    }
    // main thresholds: 5h>=5, 1w>=10 → 15% and 25% pass
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
    // work-alt thresholds: 5h>=20, 1w>=30 → 15% < 20 → fails
    expect(killswitchPassesPolicy(quota, storage, 'work-alt')).toBe(false)
  })

  test('account without override falls back to main thresholds', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
      accounts: {},
    }
    const quota = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
    }
    expect(killswitchPassesPolicy(quota, storage, 'unknown-id')).toBe(true)
  })

  test('missing quota with failClosedOnUnknownQuota returns false', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    expect(killswitchPassesPolicy(undefined, storage)).toBe(false)
  })

  test('empty quota snapshot remains killswitch-unknown under fail-closed policy', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    expect(killswitchPassesPolicy({}, storage)).toBe(false)
  })

  test('missing quota without failClosedOnUnknownQuota returns true', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    expect(killswitchPassesPolicy(undefined, storage)).toBe(true)
  })

  test('blocks on a below-threshold window even when the other window is missing (failClosed=false)', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    // five_hour absent, seven_day present and below its 10% threshold: the
    // missing window must not short-circuit past the real below-threshold one.
    const quota = {
      seven_day: {
        usedPercent: 98,
        remainingPercent: 2,
        checkedAt: Date.now(),
      },
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
  })

  test('passes a present above-threshold window when the other is missing (failClosed=false)', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    const quota = {
      seven_day: {
        usedPercent: 20,
        remainingPercent: 80,
        checkedAt: Date.now(),
      },
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// killswitchRetryAfterSeconds
// ---------------------------------------------------------------------------
describe('killswitchRetryAfterSeconds', () => {
  test('returns earliest reset across all accounts', () => {
    const now = Date.now()
    const mainQuota = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        resetsAt: new Date(now + 600_000).toISOString(), // 10 min
        checkedAt: now,
      },
    }
    const fallbacks = [
      {
        quota: {
          five_hour: {
            usedPercent: 90,
            remainingPercent: 10,
            resetsAt: new Date(now + 300_000).toISOString(), // 5 min — earliest
            checkedAt: now,
          },
        },
      },
    ]
    const seconds = killswitchRetryAfterSeconds(mainQuota, fallbacks, now)
    // 300s until reset + 60s buffer
    expect(seconds).toBeGreaterThanOrEqual(359)
    expect(seconds).toBeLessThanOrEqual(361)
  })

  test('returns 300 fallback when no reset times available', () => {
    expect(killswitchRetryAfterSeconds(undefined, [], Date.now())).toBe(300)
  })

  test('ignores past reset times', () => {
    const now = Date.now()
    const mainQuota = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        resetsAt: new Date(now - 60_000).toISOString(), // in the past
        checkedAt: now,
      },
    }
    expect(killswitchRetryAfterSeconds(mainQuota, [], now)).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// isKillswitchEnabled / getKillswitchConfig
// ---------------------------------------------------------------------------
describe('killswitch config helpers', () => {
  test('isKillswitchEnabled returns false for null storage', () => {
    expect(isKillswitchEnabled(null)).toBe(false)
  })

  test('isKillswitchEnabled returns false when not configured', () => {
    expect(isKillswitchEnabled(baseStorage())).toBe(false)
  })

  test('isKillswitchEnabled returns true when enabled', () => {
    const storage = baseStorage()
    storage.killswitch = { enabled: true }
    expect(isKillswitchEnabled(storage)).toBe(true)
  })

  test('getKillswitchConfig returns defaults for null storage', () => {
    expect(getKillswitchConfig(null)).toEqual({ enabled: false })
  })
})

// ---------------------------------------------------------------------------
// setKillswitchPersistent
// ---------------------------------------------------------------------------
describe('setKillswitchPersistent', () => {
  test('persists killswitch config to disk', async () => {
    await saveAccounts(baseStorage(), accountPath)
    await setKillswitchPersistent(
      {
        enabled: true,
        main: { five_hour: 3, seven_day: 8 },
        accounts: { 'work-alt': { five_hour: 5, seven_day: 10 } },
      },
      accountPath,
    )

    const loaded = await loadAccounts(accountPath)
    expect(loaded?.killswitch?.enabled).toBe(true)
    expect(loaded?.killswitch?.main?.five_hour).toBe(3)
    expect(loaded?.killswitch?.accounts?.['work-alt']?.five_hour).toBe(5)
  })

  test('preserves existing storage fields', async () => {
    const storage = baseStorage()
    storage.claudeCache = { enabled: true, mode: 'hybrid' }
    await saveAccounts(storage, accountPath)

    await setKillswitchPersistent({ enabled: true }, accountPath)

    const loaded = await loadAccounts(accountPath)
    expect(loaded?.claudeCache?.enabled).toBe(true)
    expect(loaded?.killswitch?.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// executeKillswitchCommand
// ---------------------------------------------------------------------------
describe('executeKillswitchCommand', () => {
  const accountIds = ['work-alt']

  test('status shows table and cheatsheet when enabled', () => {
    const result = executeKillswitchCommand({
      argumentsText: '',
      config: {
        enabled: true,
        main: { five_hour: 5, seven_day: 10 },
      },
      accountIds,
    })
    expect(result.text).toContain('## Killswitch')
    expect(result.text).toContain('Status: **ON**')
    expect(result.text).toContain('main')
    expect(result.text).toContain('work-alt')
    expect(result.text).toContain('/claude-killswitch on')
    expect(result.text).toContain('/claude-killswitch set')
    expect(result.updatedConfig).toBeUndefined()
  })

  test('status shows OFF when disabled', () => {
    const result = executeKillswitchCommand({
      argumentsText: '',
      config: { enabled: false },
      accountIds,
    })
    expect(result.text).toContain('Status: **OFF**')
    expect(result.updatedConfig).toBeUndefined()
  })

  test('on enables with defaults if no thresholds set', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'on',
      config: { enabled: false },
      accountIds,
    })
    expect(result.text).toContain('Killswitch Enabled')
    expect(result.updatedConfig?.enabled).toBe(true)
    expect(result.updatedConfig?.main?.five_hour).toBe(5)
    expect(result.updatedConfig?.main?.seven_day).toBe(10)
  })

  test('on preserves existing thresholds', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'on',
      config: {
        enabled: false,
        main: { five_hour: 3, seven_day: 8 },
      },
      accountIds,
    })
    expect(result.updatedConfig?.enabled).toBe(true)
    expect(result.updatedConfig?.main?.five_hour).toBe(3)
  })

  test('off disables', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'off',
      config: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      accountIds,
    })
    expect(result.text).toContain('Killswitch Disabled')
    expect(result.updatedConfig?.enabled).toBe(false)
  })

  test('set updates main thresholds', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set main:3,8',
      config: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      accountIds,
    })
    expect(result.text).toContain('Killswitch Updated')
    expect(result.updatedConfig?.main?.five_hour).toBe(3)
    expect(result.updatedConfig?.main?.seven_day).toBe(8)
  })

  test('set updates per-account thresholds', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set work-alt:2,5',
      config: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      accountIds,
    })
    expect(result.updatedConfig?.accounts?.['work-alt']?.five_hour).toBe(2)
    expect(result.updatedConfig?.accounts?.['work-alt']?.seven_day).toBe(5)
    // main untouched
    expect(result.updatedConfig?.main?.five_hour).toBe(5)
  })

  test('set all applies to main and all accounts', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set all:7,15',
      config: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      accountIds,
    })
    expect(result.updatedConfig?.main?.five_hour).toBe(7)
    expect(result.updatedConfig?.accounts?.['work-alt']?.five_hour).toBe(7)
  })

  test('invalid set syntax returns usage', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set garbage',
      config: { enabled: true },
      accountIds,
    })
    expect(result.text).toContain('/claude-killswitch')
    expect(result.updatedConfig).toBeUndefined()
  })
})

describe('getQuotaRefreshEveryNRequests', () => {
  test('returns 0 when quota config is missing', () => {
    expect(getQuotaRefreshEveryNRequests(null)).toBe(0)
    expect(
      getQuotaRefreshEveryNRequests({ ...baseStorage(), quota: undefined }),
    ).toBe(0)
  })

  test('returns 0 when refreshEveryNRequests is not set', () => {
    const storage = baseStorage()
    expect(getQuotaRefreshEveryNRequests(storage)).toBe(0)
  })

  test('returns the configured value', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota!, refreshEveryNRequests: 3 }
    expect(getQuotaRefreshEveryNRequests(storage)).toBe(3)
  })

  test('returns 0 for zero or negative values', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota!, refreshEveryNRequests: 0 }
    expect(getQuotaRefreshEveryNRequests(storage)).toBe(0)

    storage.quota = { ...storage.quota!, refreshEveryNRequests: -1 }
    expect(getQuotaRefreshEveryNRequests(storage)).toBe(0)
  })

  test('floors fractional values', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota!, refreshEveryNRequests: 3.7 }
    expect(getQuotaRefreshEveryNRequests(storage)).toBe(3)
  })

  test('returns 0 for NaN/Infinity', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota!, refreshEveryNRequests: NaN }
    expect(getQuotaRefreshEveryNRequests(storage)).toBe(0)

    storage.quota = { ...storage.quota!, refreshEveryNRequests: Infinity }
    expect(getQuotaRefreshEveryNRequests(storage)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// formatKillswitchBlockMessage — scope-aware 429 message
// ---------------------------------------------------------------------------
describe('formatKillswitchBlockMessage', () => {
  test('scoped-driven: names the model + weekly phrasing', () => {
    const message = formatKillswitchBlockMessage({
      retryAfterSeconds: 300,
      modelName: 'Claude Fable 5',
    })
    expect(message).toContain('Claude Fable 5')
    expect(message).toContain('weekly limit reached')
    expect(message).toContain('5m 0s')
    expect(message).not.toContain('Killswitch: no routable accounts')
  })

  test('account-level: generic phrasing when no modelName', () => {
    const message = formatKillswitchBlockMessage({
      retryAfterSeconds: 300,
    })
    expect(message).toContain('Killswitch: no routable accounts')
    expect(message).toContain('5m 0s')
  })

  test('scoped: modelName is generic (e.g. Mythos), no hardcoded Fable string', () => {
    const message = formatKillswitchBlockMessage({
      retryAfterSeconds: 60,
      modelName: 'Claude Mythos 5',
    })
    expect(message).toContain('Claude Mythos 5')
    expect(message).not.toContain('Fable')
  })

  test('retry hint formatting — minutes and seconds', () => {
    const message = formatKillswitchBlockMessage({ retryAfterSeconds: 754 })
    // 754s = 12m 34s
    expect(message).toContain('12m 34s')
  })
})

// ---------------------------------------------------------------------------
// resolveScopedDrivenBlock — must-2: a healthy scoped window must NOT be
// treated as scoped-driven; the 5h/7d block must keep the generic message
// even when the request's model happens to match a scoped carve-out.
// ---------------------------------------------------------------------------
describe('resolveScopedDrivenBlock', () => {
  const fableWindow = (remaining: number): AccountScopedQuotaWindow => ({
    id: 'claude-weekly-scoped-fable',
    title: 'Claude Fable 5 only',
    modelName: 'Claude Fable 5',
    modelId: 'claude-fable-5',
    usedPercent: 100 - remaining,
    remainingPercent: remaining,
    checkedAt: Date.now(),
  })

  const killswitchStorage = (scoped: number): AccountStorage => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped },
    }
    return storage
  }

  test('5h/7d-driven block + HEALTHY Fable window → NOT scoped-driven (MUST-2)', () => {
    // Main quota is exhausted on 5h/7d (remaining below the strict-`<`
    // thresholds of 5/10, so the killswitch genuinely fires), but the Fable
    // window is at 100% remaining — well above the scoped threshold. The block
    // must be classified account-level (generic message), not scoped-driven.
    const storage = killswitchStorage(0)
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 91,
        remainingPercent: 9,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(100)], // perfectly healthy
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-fable-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(false)
  })

  test('EXHAUSTED Fable window at/below scoped threshold → IS scoped-driven (MUST-2 proof)', () => {
    const storage = killswitchStorage(0)
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 90,
        remainingPercent: 10,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(0)], // exhausted
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-fable-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(true)
    if (result.isScopedDriven) {
      expect(result.modelName).toBe('Claude Fable 5')
      expect(result.modelId).toBe('claude-fable-5')
    }
  })

  test('raised scoped threshold (20) marks a 20% Fable window as scoped-driven (MUST-2 boundary)', () => {
    const storage = killswitchStorage(20)
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(20)],
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-fable-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(true)
  })

  test('same 20% threshold + 21% remaining Fable window → NOT scoped-driven', () => {
    const storage = killswitchStorage(20)
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(21)],
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-fable-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(false)
  })

  test('Sonnet request: no matching scoped window → NOT scoped-driven', () => {
    const storage = killswitchStorage(0)
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 90,
        remainingPercent: 10,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(0)],
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-sonnet-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(false)
  })

  test('no requestModelId → NOT scoped-driven', () => {
    const storage = killswitchStorage(0)
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 90,
        remainingPercent: 10,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(0)],
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: undefined,
      storage,
    })
    expect(result.isScopedDriven).toBe(false)
  })

  test('non-finite remainingPercent on a matched window → NOT scoped-driven', () => {
    const storage = killswitchStorage(0)
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 90,
        remainingPercent: 10,
        checkedAt: Date.now(),
      },
      scoped: [
        {
          ...fableWindow(0),
          remainingPercent: Number.NaN,
        },
      ],
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-fable-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(false)
  })

  // Regression for FINDING 2: when BOTH 5h/7d AND the Fable window are
  // exhausted, the real block reason is account-level (5h/7d), yet the
  // old code only checked the scoped window and reported scoped-driven.
  // That misleads the operator (saying "Fable weekly limit" when the
  // account is dead for ALL models) and misroutes the retry-after to
  // the weekly window. Account-level 5h/7d must take priority.
  test('BOTH 5h/7d AND Fable exhausted → NOT scoped-driven (FINDING 2)', () => {
    // 5h threshold 10, 5h remaining 4 → 4 < 10, BLOCKED
    // 7d threshold 10, 7d remaining 4 → 4 < 10, BLOCKED
    // scoped threshold 0, Fable remaining 0 → 0 <= 0, BLOCKED
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 10, seven_day: 10, scoped: 0 },
    }
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(0)],
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-fable-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(false)
  })

  test('BOTH 5h/7d AND Fable exhausted — Sonnet request → NOT scoped-driven (FINDING 2 Sonnet variant)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 10, seven_day: 10, scoped: 0 },
    }
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(0)],
    }
    // Sonnet has no matching scoped window, so the 5h/7d guard short-
    // circuits. Important: result is still NOT scoped-driven.
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-sonnet-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(false)
  })

  test('HEALTHY 5h/7d + EXHAUSTED Fable → still IS scoped-driven (FINDING 2 regression lock)', () => {
    // This is the MUST-2 proof test, restated as a regression lock for
    // FINDING 2: the 5h/7d guard must not over-trigger and turn a
    // genuine scoped-driven block into account-level.
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const mainQuota: OAuthQuotaSnapshot = {
      // 5h/7d HEALTHY — they must pass the no-modelId policy check.
      five_hour: {
        usedPercent: 10,
        remainingPercent: 90,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 20,
        remainingPercent: 80,
        checkedAt: Date.now(),
      },
      scoped: [fableWindow(0)],
    }
    const result = resolveScopedDrivenBlock({
      mainQuota,
      requestModelId: 'claude-fable-5',
      storage,
    })
    expect(result.isScopedDriven).toBe(true)
    if (result.isScopedDriven) {
      expect(result.modelName).toBe('Claude Fable 5')
      expect(result.modelId).toBe('claude-fable-5')
    }
  })
})
