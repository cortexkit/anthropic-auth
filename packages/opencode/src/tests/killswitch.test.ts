import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountStorage,
  executeKillswitchCommand,
  getKillswitchConfig,
  getQuotaRefreshEveryNRequests,
  isKillswitchEnabled,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  loadAccounts,
  parseKillswitchCommandAction,
  saveAccounts,
  setKillswitchPersistent,
} from '@cortexkit/anthropic-auth-core'

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
