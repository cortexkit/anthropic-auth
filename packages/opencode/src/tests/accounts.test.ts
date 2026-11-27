import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
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
  type AccountStorage,
  acquireRefreshFileLock,
  buildQuotaOperationError,
  buildRefreshOperationError,
  ClaudeOAuthRefreshError,
  fallbackAccountUuidForLineage,
  fetchOAuthAccountProfile,
  fetchOAuthQuotaSnapshot,
  formatOAuthAccountTier,
  getClaustrumMode,
  getFallbackReauthLabels,
  getScopedQuotaWindowForModel,
  isCostZeroingEnabled,
  isPermanentRefreshError,
  isPrimePersistentlyEnabled,
  type KillswitchThresholds,
  killswitchPassesPolicy,
  mergeMainQuotaErrorClearedAt,
  type OAuthAccount,
  type OAuthAccountProfile,
  type OAuthQuotaSnapshot,
  oauthProfileIsFresh,
  PROFILE_TTL_MS,
  type ProviderAccountUuid,
  quotaSnapshotModelScopeIsExhausted,
  quotaSnapshotPassesModelScope,
  quotaSnapshotPassesPolicy,
  shouldFallbackStatus,
} from '@cortexkit/anthropic-auth-core'
import { readLegacyJson } from '../../../core/src/tests/legacy-account-fixture.ts'

const providerUuid = (value: string) => value as ProviderAccountUuid

let tempDir: string
let accountPath: string
let previousStateFile: string | undefined

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function seedStaleRefreshLock(name: string, now: number, ttlMs: number) {
  const lockPath = `${accountPath}.${name}.lock`
  const evictPath = `${lockPath}.evicting`
  await rm(lockPath, { recursive: true, force: true })
  await rm(evictPath, { recursive: true, force: true })
  await writeFile(
    lockPath,
    `${JSON.stringify({ ownerId: 'stale-owner', expiresAt: now - ttlMs })}\n`,
    'utf8',
  )
  await mkdir(evictPath)
  const staleTime = new Date(now - 10_000)
  await utimes(evictPath, staleTime, staleTime)
  return { lockPath, evictPath }
}

async function countRefreshLockLeaks(name: string) {
  const entries = await readdir(tempDir)
  return entries.filter(
    (entry) =>
      entry.startsWith(`anthropic-auth.json.${name}.lock.evicting`) ||
      entry.startsWith(`anthropic-auth.json.${name}.lock.evicting.`),
  ).length
}

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  fallbackOn: [401, 403, 429],
  refresh: {
    enabled: true,
    intervalMinutes: 10,
    refreshBeforeExpiryMinutes: 30,
  },
  quota: {
    enabled: true,
    checkIntervalMinutes: 5,
    minimumRemaining: { five_hour: 10, seven_day: 20 },
    failClosedOnUnknownQuota: true,
  },
  accounts: [],
})

describe('main quota clear marker', () => {
  test('keeps the newer marker when an older marker arrives', () => {
    expect(mergeMainQuotaErrorClearedAt(2_000, 1_000)).toBe(2_000)
  })

  test('keeps a defined marker when undefined arrives', () => {
    expect(mergeMainQuotaErrorClearedAt(2_000, undefined)).toBe(2_000)
  })
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  previousStateFile = process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  // The fixture owns both files, even if another suite left a state-path override.
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = join(
    tempDir,
    'anthropic-auth-state.json',
  )
})

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  if (previousStateFile === undefined)
    delete process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE
  else process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = previousStateFile
  await rm(tempDir, { recursive: true, force: true })
  mock.restore()
})

describe('OAuth account profiles', () => {
  const mainCapture = {
    account: { has_claude_max: true },
    organization: {
      organization_type: 'claude_max',
      rate_limit_tier: 'default_claude_max_20x',
    },
  }
  const teamCapture = {
    account: { has_claude_max: false },
    organization: {
      organization_type: 'claude_team',
      rate_limit_tier: 'default_claude_max_5x',
      seat_tier: 'team_tier_1',
    },
  }

  async function fetchProfile(capture: unknown) {
    return fetchOAuthAccountProfile({
      accessToken: 'token',
      now: () => 1234,
      fetchImpl: (async () =>
        Response.json(capture)) as unknown as typeof fetch,
    })
  }

  test('fetchOAuthAccountProfile normalizes the personal Max 20x capture', async () => {
    const profile = await fetchProfile(mainCapture)

    expect(profile).toEqual({
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 1234,
    })
    expect(formatOAuthAccountTier(profile)).toBe('Max 20x')
  })

  test('fetchOAuthAccountProfile normalizes the Team Max-5x capture', async () => {
    const profile = await fetchProfile(teamCapture)

    expect(profile).toEqual({
      tier: 'default_claude_max_5x',
      orgType: 'claude_team',
      checkedAt: 1234,
    })
    expect(formatOAuthAccountTier(profile)).toBe('Team · Max 5x')
  })

  test('fetchOAuthAccountProfile rejects blank account metadata', async () => {
    await expect(
      fetchProfile({
        organization: {
          organization_type: '   ',
          rate_limit_tier: '',
        },
      }),
    ).rejects.toThrow('missing account metadata')
  })

  test('profile freshness expires at seven days', () => {
    const profile: OAuthAccountProfile = {
      tier: 'default_claude_max_20x',
      orgType: 'claude_max',
      checkedAt: 100,
    }

    expect(
      oauthProfileIsFresh(profile, profile.checkedAt + PROFILE_TTL_MS - 1),
    ).toBe(true)
    expect(
      oauthProfileIsFresh(profile, profile.checkedAt + PROFILE_TTL_MS),
    ).toBe(false)
  })
})

describe('isCostZeroingEnabled', () => {
  test('defaults to enabled when costZeroing is absent', () => {
    expect(isCostZeroingEnabled(baseStorage())).toBe(true)
  })

  test('stays enabled when explicitly enabled', () => {
    expect(isCostZeroingEnabled({ costZeroing: { enabled: true } })).toBe(true)
  })

  test('is disabled only when explicitly set to false', () => {
    expect(isCostZeroingEnabled({ costZeroing: { enabled: false } })).toBe(
      false,
    )
  })
})

describe('account storage', () => {
  test('refresh file lock allows only one holder', async () => {
    const first = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
    })
    expect(first).not.toBeNull()

    await expect(
      acquireRefreshFileLock({
        name: 'test-refresh',
        ttlMs: 60_000,
        path: accountPath,
      }),
    ).resolves.toBeNull()

    await first?.release()
    const second = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
    })
    expect(second).not.toBeNull()
    await second?.release()

    const stale = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
    })
    expect(stale).not.toBeNull()
    const lockPath = `${accountPath}.test-refresh.lock`
    const owner = JSON.parse(await readFile(lockPath, 'utf8'))
    await writeFile(
      lockPath,
      `${JSON.stringify({ ...owner, expiresAt: Date.now() - 1 })}\n`,
      'utf8',
    )
    const afterStale = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
    })
    expect(afterStale).not.toBeNull()
    await afterStale?.release()
  })

  test('refresh file lock stale-marker steal has a single winner under forced recreate race', async () => {
    const name = 'test-refresh-forced-stale-steal'
    const now = Date.now()
    const ttlMs = 1_000
    await seedStaleRefreshLock(name, now, ttlMs)

    const cSawStaleMarker = deferred()
    const releaseCFromStaleMarker = deferred()
    const cClaimedMarker = deferred()
    const releaseCFromClaim = deferred()
    const cConfirmedStaleLock = deferred()
    const releaseCFromStaleLock = deferred()
    const aAcquiredMarker = deferred()
    const releaseAFromMarker = deferred()

    const contenderC = acquireRefreshFileLock({
      name,
      ttlMs,
      path: accountPath,
      onStep: async (step) => {
        if (step === 'stale-marker-stat') {
          cSawStaleMarker.resolve()
          await releaseCFromStaleMarker.promise
        }
        if (step === 'stale-marker-claimed') {
          cClaimedMarker.resolve()
          await releaseCFromClaim.promise
        }
        if (step === 'stale-lock-confirmed') {
          cConfirmedStaleLock.resolve()
          await releaseCFromStaleLock.promise
        }
      },
    })

    await withTimeout(cSawStaleMarker.promise, 1_000)

    const contenderA = acquireRefreshFileLock({
      name,
      ttlMs,
      path: accountPath,
      onStep: (step) => {
        if (step === 'eviction-marker-acquired') {
          aAcquiredMarker.resolve()
          return releaseAFromMarker.promise
        }
      },
    })

    await withTimeout(aAcquiredMarker.promise, 1_000)
    releaseCFromStaleMarker.resolve()
    await withTimeout(cClaimedMarker.promise, 1_000)
    releaseCFromClaim.resolve()
    await withTimeout(cConfirmedStaleLock.promise, 1_000)

    releaseAFromMarker.resolve()
    const aLock = await withTimeout(contenderA, 1_000)
    releaseCFromStaleLock.resolve()
    const cLock = await withTimeout(contenderC, 1_000)
    const winners = [aLock, cLock].filter(Boolean)

    await Promise.all(winners.map((lock) => lock?.release()))

    expect(winners).toHaveLength(1)
    expect(await countRefreshLockLeaks(name)).toBe(0)
  })

  test('refresh file lock stale-marker steal has a single winner across high-volume contention', async () => {
    const name = 'test-refresh-high-volume-stale-steal'
    const ttlMs = 1_000
    const contenders = 16
    const rounds = 1_000

    for (let round = 0; round < rounds; round++) {
      const now = Date.now()
      await seedStaleRefreshLock(name, now, ttlMs)

      const locks = await Promise.all(
        Array.from({ length: contenders }, () =>
          acquireRefreshFileLock({
            name,
            ttlMs,
            path: accountPath,
          }),
        ),
      )
      const winners = locks.filter(Boolean)

      await Promise.all(winners.map((lock) => lock?.release()))

      expect(winners, `round ${round}`).toHaveLength(1)
      expect(await countRefreshLockLeaks(name), `round ${round}`).toBe(0)
    }
  }, 30_000)

  test('refresh file lock renews while the holder is alive', async () => {
    const first = await acquireRefreshFileLock({
      name: 'test-refresh-renew',
      ttlMs: 500,
      path: accountPath,
      renew: true,
      renewIntervalMs: 100,
    })
    expect(first).not.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 700))
    await expect(
      acquireRefreshFileLock({
        name: 'test-refresh-renew',
        ttlMs: 500,
        path: accountPath,
      }),
    ).resolves.toBeNull()

    await first?.release()
    const second = await acquireRefreshFileLock({
      name: 'test-refresh-renew',
      ttlMs: 500,
      path: accountPath,
    })
    expect(second).not.toBeNull()
    await second?.release()
  })

  test('refresh file lock does not steal an initializing lock', async () => {
    const lockDir = `${accountPath}.test-refresh.lock`
    await mkdir(lockDir, { recursive: true })

    const contender = await acquireRefreshFileLock({
      name: 'test-refresh',
      ttlMs: 60_000,
      path: accountPath,
    })

    expect(contender).toBeNull()
    await expect(
      readFile(join(lockDir, 'owner.json'), 'utf8'),
    ).rejects.toThrow()
  })

  describe('stale-lock eviction race', () => {
    const N = 16
    const ROUNDS = 50

    test('concurrent stale-evictPath crash-recovery yields exactly one winner', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const lockPath = `${accountPath}.stale-crash.lock`
        const evictPath = `${lockPath}.evicting`

        // Seed a STALE evictPath (simulating crashed evictor)
        await mkdir(evictPath, { recursive: true })
        const staleDate = new Date(Date.now() - 60_000)
        await utimes(evictPath, staleDate, staleDate)

        // Seed a stale lock
        await writeFile(
          lockPath,
          `${JSON.stringify({ ownerId: 'dead-owner', expiresAt: Date.now() - 60_000 })}\n`,
          { encoding: 'utf8', mode: 0o600 },
        )

        const results = await Promise.all(
          Array.from({ length: N }, () =>
            acquireRefreshFileLock({
              name: 'stale-crash',
              ttlMs: 60_000,
              path: accountPath,
            }),
          ),
        )

        const winners = results.filter((r) => r !== null)
        expect(
          winners.length,
          `Round ${round}: expected 1 winner, got ${winners.length}`,
        ).toBe(1)

        // .evicting marker must be cleaned up
        await expect(stat(evictPath)).rejects.toThrow()

        await winners[0]!.release()
      }
    })

    test('fresh lock is never stolen by contenders', async () => {
      const now = Date.now()
      const lockPath = `${accountPath}.fresh-lock.lock`

      await writeFile(
        lockPath,
        `${JSON.stringify({ ownerId: 'alive-owner', expiresAt: now + 120_000 })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          acquireRefreshFileLock({
            name: 'fresh-lock',
            ttlMs: 60_000,
            path: accountPath,
          }),
        ),
      )

      expect(results.every((r) => r === null)).toBe(true)

      await expect(stat(`${lockPath}.evicting`)).rejects.toThrow()
    })
  })

  test('uses default fallback statuses when not configured', () => {
    expect(shouldFallbackStatus(429, null)).toBe(true)
    expect(shouldFallbackStatus(500, null)).toBe(false)
  })
})

describe('buildRefreshOperationError', () => {
  test('uses Retry-After when available on 429', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited', '120')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(1000000 + 120_000)
  })

  test('falls back to exponential backoff when no Retry-After', () => {
    const error = new ClaudeOAuthRefreshError(429, 'rate limited')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(1000000 + 5 * 60_000)
  })

  test('captures the error status on the operation error', () => {
    const error = new ClaudeOAuthRefreshError(400, 'invalid_grant')
    const result = buildRefreshOperationError({
      error,
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.status).toBe(400)
  })

  test('captures duck-typed status when no ClaudeOAuthRefreshError', () => {
    const result = buildRefreshOperationError({
      error: { status: 429 },
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(result.status).toBe(429)
  })

  test('sets permanent true only for 400 invalid_grant', () => {
    const dead = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, 'invalid_grant'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(dead.permanent).toBe(true)
  })

  test('sets permanent false for retry-exhausted transient (no status)', () => {
    const exhausted = buildRefreshOperationError({
      error: new Error('Token refresh exhausted all retries'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(exhausted.permanent).toBe(false)
  })

  test('sets permanent false for a 429', () => {
    const rateLimited = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(rateLimited.permanent).toBe(false)
  })

  test('sets permanent false for a 400 that is NOT invalid_grant', () => {
    // The OAuth spec allows 400 invalid_client / invalid_request /
    // unsupported_grant_type — none of which re-login fixes. Only invalid_grant
    // means the refresh token itself is dead.
    const invalidClient = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, '{"error":"invalid_client"}'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(invalidClient.status).toBe(400)
    expect(invalidClient.permanent).toBe(false)
    // Explicit false must short-circuit isPermanentRefreshError before the
    // legacy status===400 fallback can wrongly flag it.
    expect(isPermanentRefreshError(invalidClient)).toBe(false)
  })

  test('sets permanent true for a 400 invalid_grant from the body JSON', () => {
    const dead = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(
        400,
        '{"error":"invalid_grant","error_description":"Refresh token expired"}',
      ),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(dead.permanent).toBe(true)
    expect(isPermanentRefreshError(dead)).toBe(true)
  })

  test.each([
    ['API envelope', '{"error":{"type":"invalid_grant"}}', true],
    [
      'OAuth description',
      '{"error":"invalid_request","error_description":"not invalid_grant"}',
      false,
    ],
    [
      'API message',
      '{"error":{"type":"invalid_request_error","message":"not invalid_grant"}}',
      false,
    ],
    ['JSON string', '"invalid_grant"', false],
  ] as const)(
    'classifies a 400 invalid_grant by the error field, not the %s',
    (_format, body, permanent) => {
      const result = buildRefreshOperationError({
        error: new ClaudeOAuthRefreshError(400, body),
        now: 1000000,
        accountIdentity: 'test-account',
      })
      expect(result.permanent).toBe(permanent)
    },
  )
})

describe('getFallbackReauthLabels', () => {
  test('reports enabled OAuth fallbacks with permanent refresh failures only', () => {
    const storage = baseStorage()
    storage.accounts.push(
      {
        id: 'expired',
        type: 'oauth',
        label: 'ufuk2',
        enabled: true,
        access: 'expired-access',
        refresh: 'expired-refresh',
        expires: 1,
        lastRefreshError: {
          message: 'invalid_grant: Refresh token expired',
          checkedAt: 1,
          nextRetryAt: 86_400_001,
          status: 400,
          permanent: true,
        },
      },
      {
        id: 'transient',
        type: 'oauth',
        label: 'temporary',
        enabled: true,
        access: 'transient-access',
        refresh: 'transient-refresh',
        expires: 1,
        lastRefreshError: {
          message: 'service unavailable',
          checkedAt: 1,
          nextRetryAt: 60_001,
          status: 503,
          permanent: false,
        },
      },
    )

    expect(getFallbackReauthLabels(storage)).toEqual(['ufuk2'])
  })
})

describe('isPermanentRefreshError', () => {
  test('400 (invalid_grant) → permanent (dead token, needs re-login)', () => {
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(400, 'invalid_grant'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(isPermanentRefreshError(error)).toBe(true)
  })

  test('429 (rate limited) → NOT permanent (transient, recovers)', () => {
    const error = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(isPermanentRefreshError(error)).toBe(false)
  })

  test('500 (server error) → NOT permanent (transient)', () => {
    const error = buildRefreshOperationError({
      error: { status: 500 },
      now: 1000000,
      accountIdentity: 'test-account',
    })
    expect(isPermanentRefreshError(error)).toBe(false)
  })

  test('legacy error without status but 24h delay → permanent (heuristic)', () => {
    // Mirrors a dead token persisted before the status field existed: a
    // non-transient error gets NON_TRANSIENT_REFRESH_RETRY_DELAY_MS (24h).
    const checkedAt = 1000000
    const error = {
      message: 'invalid_grant',
      checkedAt,
      nextRetryAt: checkedAt + 24 * 60 * 60_000,
    }
    expect(isPermanentRefreshError(error)).toBe(true)
  })

  test('legacy error without status, short delay → NOT permanent', () => {
    const checkedAt = 1000000
    const error = {
      message: 'rate limited',
      checkedAt,
      nextRetryAt: checkedAt + 5 * 60_000,
    }
    expect(isPermanentRefreshError(error)).toBe(false)
  })

  test('retry-exhausted transient error → NOT permanent (no false re-login nag)', () => {
    // A network glitch that exhausts all retries throws a plain Error with NO
    // status. isTransientRefreshError classifies it non-transient (no status,
    // message is not "fetch failed"), so it gets the 24h backoff delay — but it
    // is NOT a dead token. Built through buildRefreshOperationError, the explicit
    // `permanent` flag must be false so it is not nagged for re-login.
    const error = buildRefreshOperationError({
      error: new Error('Token refresh exhausted all retries'),
      now: 1000000,
      accountIdentity: 'test-account',
    })
    // Sanity: it really did get the 24h non-transient delay (so the legacy
    // heuristic alone would have wrongly flagged it permanent).
    expect(error.nextRetryAt).toBe(1000000 + 24 * 60 * 60_000)
    expect(isPermanentRefreshError(error)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Duck-typed retryAfter propagation in buildRefreshOperationError
// ---------------------------------------------------------------------------
describe('buildRefreshOperationError retryAfter duck-typed propagation', () => {
  const now = 1_000_000

  test('reads .retryAfter from duck-typed error (no instanceof)', () => {
    const error: Error & { retryAfter?: number } = Object.assign(
      new Error('fail'),
      { retryAfter: 60 },
    )
    const result = buildRefreshOperationError({
      error,
      now,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(now + 60_000)
  })

  test('ClaudeOAuthRefreshError retryAfter still works (regression)', () => {
    const result = buildRefreshOperationError({
      error: new ClaudeOAuthRefreshError(429, 'rate limited', '120'),
      now,
      accountIdentity: 'test-account',
    })
    expect(result.nextRetryAt).toBe(now + 120_000)
  })
})

// ---------------------------------------------------------------------------
// fetchOAuthQuotaSnapshot attaches .status + .retryAfter (producer)
// ---------------------------------------------------------------------------
describe('fetchOAuthQuotaSnapshot duck-typed error producer', () => {
  test('parses weekly scoped model quota limits from OAuth usage payload', async () => {
    const fetchImpl = (async () => {
      return new Response(
        JSON.stringify({
          five_hour: {
            utilization: 12,
            resets_at: '2026-07-04T12:00:00Z',
          },
          seven_day: {
            utilization: 34,
            resets_at: '2026-07-08T09:00:00Z',
          },
          limits: [
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 5,
              resets_at: '2026-07-08T09:00:00Z',
              scope: {
                model: { id: null, display_name: 'Fable' },
                surface: null,
              },
              is_active: false,
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 7,
              resets_at: '2026-07-08T09:00:00Z',
              scope: {
                model: { id: 'claude/fable.5:promo', display_name: 'Fable' },
              },
            },
            { kind: 'daily', group: 'daily', percent: 10 },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const quota = await fetchOAuthQuotaSnapshot({
      accessToken: 't',
      fetchImpl,
      now: () => 1_000_000,
    })

    expect(quota.five_hour?.usedPercent).toBe(12)
    expect(quota.seven_day?.remainingPercent).toBe(66)
    expect(quota.scoped).toEqual([
      {
        id: 'claude-weekly-scoped-fable',
        title: 'Fable only',
        modelName: 'Fable',
        usedPercent: 5,
        remainingPercent: 95,
        resetsAt: '2026-07-08T09:00:00Z',
        checkedAt: 1_000_000,
      },
      {
        id: 'claude-weekly-scoped-claude-fable-5-promo',
        title: 'Fable only',
        modelId: 'claude/fable.5:promo',
        modelName: 'Fable',
        usedPercent: 7,
        remainingPercent: 93,
        resetsAt: '2026-07-08T09:00:00Z',
        checkedAt: 1_000_000,
      },
    ])
  })

  test('matches scoped model quota only for the matching model family', () => {
    const quota: OAuthQuotaSnapshot = {
      five_hour: { usedPercent: 0, remainingPercent: 100, checkedAt: 1 },
      seven_day: { usedPercent: 0, remainingPercent: 100, checkedAt: 1 },
      scoped: [
        {
          id: 'claude-weekly-scoped-fable',
          title: 'Fable only',
          modelName: 'Fable',
          usedPercent: 100,
          remainingPercent: 0,
          checkedAt: 1,
        },
      ],
    }

    expect(getScopedQuotaWindowForModel(quota, 'claude-fable-5')?.title).toBe(
      'Fable only',
    )
    expect(getScopedQuotaWindowForModel(quota, 'claude-fable-5-1')?.title).toBe(
      'Fable only',
    )
    expect(quotaSnapshotModelScopeIsExhausted(quota, 'claude-fable-5')).toBe(
      true,
    )
    expect(quotaSnapshotModelScopeIsExhausted(quota, 'claude-fable-5-1')).toBe(
      true,
    )
    expect(quotaSnapshotPassesModelScope(quota, 'claude-opus-4-8')).toBe(true)
  })

  test('429 response → thrown error carries .status=429 + .retryAfter', async () => {
    let thrown: unknown = null
    const fetchImpl = (async () => {
      return new Response('rate limited', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })
    }) as unknown as typeof fetch
    try {
      await fetchOAuthQuotaSnapshot({
        accessToken: 't',
        fetchImpl,
        now: () => 1_000_000,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { status?: number }).status).toBe(429)
    expect((thrown as { retryAfter?: number }).retryAfter).toBe(60)
    // Verify isTransientQuotaError classifies it as transient
    const result = buildQuotaOperationError({ error: thrown, now: 1_000_000 })
    expect(result.nextRetryAt!).toBeLessThan(1_000_000 + 5 * 60_000)
  })

  test('500 response → thrown error carries .status=500', async () => {
    let thrown: unknown = null
    const fetchImpl = (async () => {
      return new Response('server error', { status: 500 })
    }) as unknown as typeof fetch
    try {
      await fetchOAuthQuotaSnapshot({
        accessToken: 't',
        fetchImpl,
        now: () => 1_000_000,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { status?: number }).status).toBe(500)
    // Verify isTransientQuotaError classifies it as transient
    const result = buildQuotaOperationError({ error: thrown, now: 1_000_000 })
    expect(result.nextRetryAt!).toBeLessThan(1_000_000 + 5 * 60_000)
  })

  test('401 response → thrown error carries .status=401 (NOT transient for quota)', async () => {
    let thrown: unknown = null
    const fetchImpl = (async () => {
      return new Response('unauthorized', { status: 401 })
    }) as unknown as typeof fetch
    try {
      await fetchOAuthQuotaSnapshot({
        accessToken: 't',
        fetchImpl,
        now: () => 1_000_000,
      })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { status?: number }).status).toBe(401)
    const result = buildQuotaOperationError({ error: thrown, now: 1_000_000 })
    expect(result.nextRetryAt).toBe(1_000_000 + 5 * 60_000)
  })
})

// Non-finite utilization must fail closed rather than bypass quota policy.
describe('NaN quota utilization guards', () => {
  test('NaN remainingPercent blocks killswitch (fail-closed)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: Number.NaN,
        remainingPercent: Number.NaN,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: Date.now(),
      },
    }
    // A non-finite remaining quota is unknown evidence, not proof that the
    // account meets an enabled user floor.
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
  })

  test('NaN remainingPercent blocks quota policy (fail-closed)', () => {
    const storage = baseStorage()
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: Number.NaN,
        remainingPercent: Number.NaN,
        checkedAt: Date.now(),
      },
    }
    expect(quotaSnapshotPassesPolicy(quota, storage)).toBe(false)
  })

  test('NaN threshold falls back to default', async () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: Number.NaN } as unknown as KillswitchThresholds,
    }
    // Exercise the live threshold policy directly, without a legacy loader.
    const loaded = storage
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
    }
    // remainingPercent 4 < DEFAULT_KILLSWITCH_THRESHOLDS.five_hour (5) → blocked
    expect(killswitchPassesPolicy(quota, loaded)).toBe(false)
  })

  test('finite threshold is respected', async () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 3, seven_day: 5 },
    }
    const loaded = storage
    const quotaBoth: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 96,
        remainingPercent: 4,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 80,
        remainingPercent: 20,
        checkedAt: Date.now(),
      },
    }
    // remainingPercent 4 >= threshold 3 (pass), remainingPercent 20 >= 5 (pass)
    expect(killswitchPassesPolicy(quotaBoth, loaded)).toBe(true)
  })

  test('missing decoded windows cannot satisfy enabled account floors', () => {
    // Invalid usage data can leave both decoded windows absent. This checks
    // admission of that missing reading, not the wire decoder itself.
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    // Neither standard window provides evidence for its configured floor.
    const quota: OAuthQuotaSnapshot = {
      five_hour: undefined,
      seven_day: undefined,
    }
    // Enabled floors require readings even when soft quota policy fails open.
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)

    storage.quota = { ...storage.quota, failClosedOnUnknownQuota: false }
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
    storage.killswitch.main = { five_hour: 0, seven_day: 0 }
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
  })
})

// Provider UUIDs must not cross credential replacements.

describe('fallback UUID lineage fences', () => {
  test('does not use a persisted UUID from a replaced credential lineage', () => {
    const account: OAuthAccount = {
      id: 'fallback-1',
      type: 'oauth',
      refresh: 'refresh-a',
      authLineageId: 'lineage-a',
      anthropicAccountUuid: providerUuid('uuid-from-lineage-a'),
    }

    expect(fallbackAccountUuidForLineage(account, 'lineage-b')).toBeNull()
    expect(fallbackAccountUuidForLineage(account, 'lineage-a')).toBe(
      'uuid-from-lineage-a',
    )
  })
})

// -- Persistent round-trip tests -----------------------------------------------

describe('global Claustrum mode', () => {
  test('defaults to local without config and does not infer custody from a tombstone', async () => {
    expect(await readLegacyJson<AccountStorage>(accountPath)).toBeNull()
    expect(
      getClaustrumMode(await readLegacyJson<AccountStorage>(accountPath)),
    ).toBe('local')
    expect(
      getClaustrumMode({
        ...baseStorage(),
        accounts: [
          {
            id: 'anthropic',
            type: 'oauth',
            access: '',
            refresh: 'claustrum-tombstone:v1:anthropic',
            expires: 0,
          },
        ],
      }),
    ).toBe('local')
  })
})

// -- setLogLevelPersistent -----------------------------------------------------

// -- prime opt-in flag + scoped counters ------------------------------------

describe('isPrimePersistentlyEnabled', () => {
  test('defaults to false when prime is absent', () => {
    expect(isPrimePersistentlyEnabled(baseStorage())).toBe(false)
  })

  test('returns false when prime.enabled is not true', () => {
    expect(
      isPrimePersistentlyEnabled({
        ...baseStorage(),
        prime: { enabled: false },
      }),
    ).toBe(false)
  })

  test('returns true when prime.enabled is true', () => {
    expect(
      isPrimePersistentlyEnabled({
        ...baseStorage(),
        prime: { enabled: true },
      }),
    ).toBe(true)
  })
})
