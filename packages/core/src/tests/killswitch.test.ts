import { describe, expect, test } from 'bun:test'

import {
  type AccountScopedQuotaWindow,
  type AccountStorage,
  DEFAULT_KILLSWITCH_THRESHOLDS,
  getKillswitchThresholdsForAccount,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  normalizeKillswitchThresholds,
  type OAuthQuotaSnapshot,
} from '../accounts.ts'
import {
  executeKillswitchCommand,
  parseKillswitchCommandAction,
} from '../killswitch.ts'

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

const scopeWindow = (
  remainingPercent: number,
  model: { name: string; id?: string },
  overrides: Partial<AccountScopedQuotaWindow> = {},
): AccountScopedQuotaWindow => ({
  usedPercent: 100 - remainingPercent,
  remainingPercent,
  checkedAt: Date.now(),
  id: 'claude-weekly-scoped-fable',
  title: `${model.name} only`,
  modelName: model.name,
  ...(model.id && { modelId: model.id }),
  ...overrides,
})

const healthy5h7d = (): Pick<
  OAuthQuotaSnapshot,
  'five_hour' | 'seven_day'
> => ({
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
})

// ---------------------------------------------------------------------------
// DEFAULT_KILLSWITCH_THRESHOLDS / normalizeKillswitchThresholds
// ---------------------------------------------------------------------------
describe('scoped killswitch — defaults + normalization', () => {
  test('DEFAULT_KILLSWITCH_THRESHOLDS.scoped is 0', () => {
    expect(DEFAULT_KILLSWITCH_THRESHOLDS.scoped).toBe(0)
  })

  test('normalizeKillswitchThresholds resolves scoped to default 0 when absent', () => {
    const t = normalizeKillswitchThresholds({ five_hour: 5, seven_day: 10 })
    expect(t.scoped).toBe(0)
  })

  test('normalizeKillswitchThresholds preserves an explicit scoped value', () => {
    const t = normalizeKillswitchThresholds({
      five_hour: 5,
      seven_day: 10,
      scoped: 20,
    })
    expect(t.scoped).toBe(20)
  })

  test('normalizeKillswitchThresholds falls back to default for non-finite scoped', () => {
    const t = normalizeKillswitchThresholds({
      five_hour: 5,
      seven_day: 10,
      scoped: Number.NaN,
    })
    expect(t.scoped).toBe(0)

    const inf = normalizeKillswitchThresholds({
      five_hour: 5,
      seven_day: 10,
      scoped: Number.POSITIVE_INFINITY,
    })
    expect(inf.scoped).toBe(0)
  })

  test('getKillswitchThresholdsForAccount carries scoped', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 20 },
    }
    expect(getKillswitchThresholdsForAccount(storage).scoped).toBe(20)
    expect(getKillswitchThresholdsForAccount(storage, 'work-alt').scoped).toBe(
      20,
    )
  })
})

// ---------------------------------------------------------------------------
// killswitchPassesPolicy — model-scoped additive behavior
// ---------------------------------------------------------------------------
describe('killswitchPassesPolicy — scoped model dimension', () => {
  test('modelId absent: byte-identical to pre-change (no scoped evaluation)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 100 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      // a fully exhausted scoped window is present, but no modelId is provided
      // → the killswitch must NOT touch it (regression lock for the additive
      //   semantics).
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
  })

  test('matching model + scoped window at/below threshold → blocks', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('NON-matching model + scoped-exhausted window → account stays live (the model-scoped proof)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    // Sonnet — not in the Fable scope — must pass even though Fable is exhausted.
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-sonnet-5'),
    ).toBe(true)
  })

  test('matching model + scoped window ABOVE threshold → passes', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(50, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  test('5h/7d below threshold blocks regardless of scoped state', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 10, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
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
      // Fable has plenty of headroom — must still block via 5h.
      scoped: [
        scopeWindow(80, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
  })

  test('default scoped 0: blocks at remainingPercent <= 0 only (inclusive)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    const remainingOne = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(1, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    // 1% remaining — above the default 0 → pass
    expect(
      killswitchPassesPolicy(
        remainingOne,
        storage,
        undefined,
        'claude-fable-5',
      ),
    ).toBe(true)

    const exactlyZero = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    // 0% remaining — must block (inclusive boundary)
    expect(
      killswitchPassesPolicy(exactlyZero, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('raised scoped threshold (20) blocks at <= 20', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 20 },
    }
    const quota21 = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(21, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota21, storage, undefined, 'claude-fable-5'),
    ).toBe(true)

    const quota20 = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(20, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota20, storage, undefined, 'claude-fable-5'),
    ).toBe(false)

    const quota5 = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(5, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota5, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('non-finite scoped remainingPercent → not blocked', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota = {
      ...healthy5h7d(),
      scoped: [
        {
          usedPercent: 0,
          remainingPercent: Number.NaN,
          checkedAt: Date.now(),
          id: 'claude-weekly-scoped-fable',
          title: 'Claude Fable 5 only',
          modelName: 'Claude Fable 5',
          modelId: 'claude-fable-5',
        },
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  test('generic: a non-Fable display_name scoped window behaves identically (no hardcoded string)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    // Pretend the future carve-out has a different display name; the keying
    // in getScopedQuotaWindowForModel is via the `fable`/`mythos` substring
    // (or future model keys), so we use a key that the matcher recognises.
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Mythos 5', id: 'claude-mythos-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-mythos-5'),
    ).toBe(false)
    // Sonnet still untouched
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-sonnet-5'),
    ).toBe(true)
  })

  test('a model with no matching scoped window is unaffected by the scoped check', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota = healthy5h7d() // no `scoped` array
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  test('matches a Haiku scoped window by display name when modelId is absent', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        {
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: Date.now(),
          id: 'claude-weekly-scoped-haiku',
          title: 'Claude Haiku 4.5',
          modelName: 'Claude Haiku 4.5',
        },
      ],
    }

    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-haiku-4-5'),
    ).toBe(false)
  })

  test('killswitch disabled → scoped check never runs', () => {
    const storage = baseStorage()
    // killswitch NOT enabled; even with a present scoped window and a model
    // that would otherwise match, the function must short-circuit to true.
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  // Regression for MUST-1: when 5h/7d is missing/non-finite AND
  // failClosedOnUnknownQuota=false, the function must STILL evaluate the
  // scoped check — an exhausted scoped window is its own block reason,
  // independent of the unknown 5h/7d fail-closed decision.
  test('scoped exhaustion blocks unknown standard quota when standard floors are disabled', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 0, seven_day: 0, scoped: 0 },
    }
    // Disabled standard floors let this assertion isolate the scoped limit.
    const quota: OAuthQuotaSnapshot = {
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('scoped exhaustion blocks non-finite standard quota when standard floors are disabled', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 0, seven_day: 0, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: Number.NaN,
        checkedAt: Date.now(),
      },
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('healthy scoped quota permits unknown standard quota only without standard floors', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 0, seven_day: 0, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      scoped: [
        scopeWindow(50, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  test('absent scoped quota permits unknown standard quota only without standard floors', () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 0, seven_day: 0, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {}
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-sonnet-5'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseKillswitchCommandAction / executeKillswitchCommand — scoped column
// ---------------------------------------------------------------------------
describe('parseKillswitchCommandAction — scoped three-number form', () => {
  test('two-number form still parses (backward compatibility)', () => {
    expect(parseKillswitchCommandAction('set main:3,8')).toEqual({
      type: 'set',
      entries: [{ account: 'main', fh: 3, sd: 8, scoped: undefined }],
    })
  })

  test('three-number form parses fh/sd/scoped', () => {
    expect(parseKillswitchCommandAction('set main:80,10,0')).toEqual({
      type: 'set',
      entries: [{ account: 'main', fh: 80, sd: 10, scoped: 0 }],
    })
  })

  test('three-number form with non-zero scoped threshold', () => {
    expect(parseKillswitchCommandAction('set all:80,10,20')).toEqual({
      type: 'set',
      entries: [{ account: 'all', fh: 80, sd: 10, scoped: 20 }],
    })
  })

  test('mixed: one entry with scoped, one without', () => {
    expect(
      parseKillswitchCommandAction('set main:80,10,0 work-alt:5,10'),
    ).toEqual({
      type: 'set',
      entries: [
        { account: 'main', fh: 80, sd: 10, scoped: 0 },
        { account: 'work-alt', fh: 5, sd: 10, scoped: undefined },
      ],
    })
  })

  test('per-account scoped threshold round-trips through the command', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set main:5,10 work-alt:80,10,15',
      config: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      accountIds: ['work-alt'],
    })
    expect(result.updatedConfig?.accounts?.['work-alt']?.scoped).toBe(15)
    // main did not specify a scoped threshold in this command, so it should
    // fall back to the default (0) on normalization, not retain an arbitrary
    // value. The command itself only writes what was parsed.
    expect(result.updatedConfig?.main?.scoped).toBeUndefined()
  })

  test('status table renders the Scoped column when enabled', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set main:5,10,20 work-alt:80,10,15',
      config: { enabled: false },
      accountIds: ['work-alt'],
    })
    expect(result.text).toContain('Scoped')
    expect(result.text).toContain('main')
    expect(result.text).toContain('work-alt')
  })
})

// ---------------------------------------------------------------------------
// killswitchRetryAfterSeconds — scoped window resetsAt
// ---------------------------------------------------------------------------
describe('killswitchRetryAfterSeconds — scoped resetsAt', () => {
  function identifiedRetry(
    main: OAuthQuotaSnapshot,
    fallbacks: { quota: OAuthQuotaSnapshot }[],
    now: number,
    modelId?: string,
  ) {
    const identify = (quota: OAuthQuotaSnapshot): OAuthQuotaSnapshot => ({
      ...quota,
      accountIdentity: 'current',
      scoped: quota.scoped?.map((window) => ({ ...window, checkedAt: now })),
      ...(modelId && {
        seven_day: quota.seven_day ?? {
          remainingPercent: 100,
          usedPercent: 0,
          checkedAt: now,
        },
      }),
    })
    return killswitchRetryAfterSeconds(
      identify(main),
      fallbacks.map(({ quota }) => ({
        quota: identify(quota),
        accountIdentity: 'current',
      })),
      now,
      modelId,
      { mainAccountIdentity: 'current' },
    )
  }
  test('considers the matched scoped window resetsAt when present', () => {
    const now = Date.now()
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: now,
      },
    }
    // A Fable window 3 minutes out — should be the earliest reset.
    const fallbacks = [
      {
        quota: {
          five_hour: {
            usedPercent: 50,
            remainingPercent: 50,
            resetsAt: new Date(now + 600_000).toISOString(), // 10 min
            checkedAt: now,
          },
          scoped: [
            scopeWindow(
              0,
              { name: 'Claude Fable 5', id: 'claude-fable-5' },
              {
                resetsAt: new Date(now + 180_000).toISOString(), // 3 min
              },
            ),
          ],
        },
      },
    ]
    const seconds = identifiedRetry(mainQuota, fallbacks, now, 'claude-fable-5')
    expect(seconds).toBe(180)
  })

  test('missing standard-window coverage uses the conservative fallback', () => {
    const now = Date.now()
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: now,
      },
    }
    const fallbacks = [
      {
        quota: {
          five_hour: {
            usedPercent: 50,
            remainingPercent: 50,
            resetsAt: new Date(now + 300_000).toISOString(),
            checkedAt: now,
          },
        },
      },
    ]
    const seconds = identifiedRetry(mainQuota, fallbacks, now)
    expect(seconds).toBe(300)
  })

  // Healthy standard windows do not shorten an exhausted model's reset.
  test('healthy standard windows do not shorten the exhausted scoped reset', () => {
    const now = Date.now()
    const twoHours = 2 * 60 * 60 * 1000
    const twoDays = 2 * 24 * 60 * 60 * 1000
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        resetsAt: new Date(now + twoHours).toISOString(),
        checkedAt: now,
      },
      seven_day: {
        usedPercent: 95,
        remainingPercent: 5,
        resetsAt: new Date(now + twoHours).toISOString(),
        checkedAt: now,
      },
      scoped: [
        scopeWindow(
          0,
          { name: 'Claude Fable 5', id: 'claude-fable-5' },
          { resetsAt: new Date(now + twoDays).toISOString() },
        ),
      ],
    }
    const seconds = identifiedRetry(mainQuota, [], now, 'claude-fable-5')
    // The reset remains model-scoped, but the default wait is capped.
    expect(seconds).toBe(900)
  })

  test('the fallback exhausted scope determines its usable time despite healthy standard windows', () => {
    const now = Date.now()
    const twoHours = 2 * 60 * 60 * 1000
    const twoDays = 2 * 24 * 60 * 60 * 1000
    // main has NO scoped window, but 5h resetsAt in 2h. A fallback carries
    // a Fable window that resets in 2 days. The 5h reset on the fallback
    // The fallback's healthy five-hour window must not shorten its exhausted model scope.
    const mainQuota: OAuthQuotaSnapshot = {}
    const fallbacks = [
      {
        quota: {
          five_hour: {
            usedPercent: 95,
            remainingPercent: 5,
            resetsAt: new Date(now + twoHours).toISOString(),
            checkedAt: now,
          },
          scoped: [
            scopeWindow(
              0,
              { name: 'Claude Fable 5', id: 'claude-fable-5' },
              { resetsAt: new Date(now + twoDays).toISOString() },
            ),
          ],
        },
      },
    ]
    const seconds = identifiedRetry(mainQuota, fallbacks, now, 'claude-fable-5')
    expect(seconds).toBe(900)
  })

  test('no matched scoped or standard blocker contributes no reset', () => {
    const now = Date.now()
    // main has a 5h reset but NO scoped window for the requested model.
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        resetsAt: new Date(now + 7_200_000).toISOString(),
        checkedAt: now,
      },
    }
    const seconds = identifiedRetry(mainQuota, [], now, 'claude-fable-5')
    expect(seconds).toBe(300)
  })
})

describe('killswitch account floors require quota evidence', () => {
  const failOpenStorage = (): AccountStorage => ({
    ...baseStorage(),
    quota: { ...baseStorage().quota, failClosedOnUnknownQuota: false },
    killswitch: { enabled: true, main: { five_hour: 50, seven_day: 10 } },
  })

  test('unknown quota cannot bypass an enabled floor through fail-open policy', () => {
    const storage = failOpenStorage()
    expect(killswitchPassesPolicy(undefined, storage, 'fallback-1')).toBe(false)
    expect(killswitchPassesPolicy({}, storage, 'fallback-1')).toBe(false)
    expect(killswitchPassesPolicy(healthy5h7d(), storage, 'fallback-1')).toBe(
      true,
    )
    expect(
      killswitchPassesPolicy(
        {
          ...healthy5h7d(),
          five_hour: {
            usedPercent: 70,
            remainingPercent: 30,
            checkedAt: Date.now(),
          },
        },
        storage,
        'fallback-1',
      ),
    ).toBe(false)
  })

  test('each enabled floor requires its own finite remaining reading', () => {
    const storage = failOpenStorage()
    expect(
      killswitchPassesPolicy({ five_hour: healthy5h7d().five_hour }, storage),
    ).toBe(false)
    expect(
      killswitchPassesPolicy({ seven_day: healthy5h7d().seven_day }, storage),
    ).toBe(false)
    expect(
      killswitchPassesPolicy(
        {
          ...healthy5h7d(),
          five_hour: {
            usedPercent: 0,
            remainingPercent: Number.NaN,
            checkedAt: Date.now(),
          },
        },
        storage,
      ),
    ).toBe(false)
  })

  test('unknown quota can fail open only when no account floor is enabled', () => {
    const storage = failOpenStorage()
    storage.killswitch = { enabled: true, main: { five_hour: 0, seven_day: 0 } }
    expect(killswitchPassesPolicy(undefined, storage)).toBe(true)
    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: true }
    expect(killswitchPassesPolicy(undefined, storage)).toBe(false)
    storage.killswitch.enabled = false
    expect(killswitchPassesPolicy(undefined, storage)).toBe(true)
  })

  test('an account override without floors does not inherit the main floor', () => {
    const storage = failOpenStorage()
    storage.killswitch = {
      ...storage.killswitch,
      enabled: true,
      accounts: { 'fallback-1': { five_hour: 0, seven_day: 0 } },
    }
    expect(killswitchPassesPolicy(undefined, storage, 'fallback-1')).toBe(true)
    expect(killswitchPassesPolicy(undefined, storage, 'fallback-2')).toBe(false)
  })
})

describe('explicit scoped floors require model quota evidence', () => {
  const scopedStorage = (): AccountStorage => ({
    ...baseStorage(),
    quota: { ...baseStorage().quota, failClosedOnUnknownQuota: false },
    killswitch: {
      enabled: true,
      main: { five_hour: 0, seven_day: 0, scoped: 20 },
    },
  })

  test('missing model metadata refuses but an explicit no-carve-out list passes', () => {
    const storage = scopedStorage()
    expect(
      killswitchPassesPolicy(
        healthy5h7d(),
        storage,
        undefined,
        'claude-fable-5',
      ),
    ).toBe(false)
    expect(
      killswitchPassesPolicy(
        { ...healthy5h7d(), scoped: [] },
        storage,
        undefined,
        'claude-fable-5',
      ),
    ).toBe(true)
    expect(
      killswitchPassesPolicy(
        {
          ...healthy5h7d(),
          scoped: [
            scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
          ],
        },
        storage,
        undefined,
        'claude-sonnet-5',
      ),
    ).toBe(true)
  })

  test('a matching scoped floor needs finite remaining quota above its inclusive boundary', () => {
    const storage = scopedStorage()
    for (const remaining of [Number.NaN, 0, 20, 21]) {
      const quota = {
        ...healthy5h7d(),
        scoped: [
          scopeWindow(remaining, {
            name: 'Claude Fable 5',
            id: 'claude-fable-5',
          }),
        ],
      }
      expect(
        killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
      ).toBe(remaining === 21)
    }
  })
})
